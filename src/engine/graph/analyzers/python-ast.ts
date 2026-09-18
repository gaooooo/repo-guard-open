/**
 * python-ast 分析器 —— Python 仓库建图（ADR-051 §5.4 「旁挂式多语言」的验证实现）。
 *
 * ── 为什么走子进程而不是在 TS 里解析 Python ──
 * Python 的 `ast` 是**标准库**，给出带 scope 语义的 AST（函数嵌套、装饰器、
 * 类方法归属都是结构化字段）。TS 生态里没有对等物：
 *   · tree-sitter-python 只给 CST，上面那些要自己推
 *   · filbert / 各种 py2js 转译器早已停更，跟不上 3.10+ 语法
 * 所以"用 Python 解析 Python"是语言同族优势（与 node-babel 用 Babel 解析 JS 同理），
 * 而**子进程是吃到这个优势又不迁移 8 万行 TS 主干的唯一姿势**。
 *
 * ── 为什么把脚本内容内嵌成字符串，而不是读文件 ──
 * tsup 单文件打包（`entry: ['src/index.ts']`，见 tsup.config.ts）**不复制非 JS 资源**，
 * 线上容器里 /app 只有 dist/index.js。若用 `new URL('./py_graph.py', import.meta.url)`
 * 去找，本地能跑、线上必然 ENOENT —— 那是最难查的一类故障（本地全绿、生产报错）。
 * 内嵌 + 运行时写临时文件，是唯一在"本地 tsx / 线上 bundle"两种形态下都成立的做法。
 *
 * 源码维护在同目录的 `py_graph.py`（可独立运行调试：`python3 py_graph.py <repoDir>`），
 * 本文件的 PY_SOURCE 由 `pnpm sync:pygraph` 从它同步 —— 一致性由单测守（见
 * graph-python-analyzer.test.ts 用例 1）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from '../../shims/logger.js';

import type { GraphAnalyzer, DetectResult } from '../analyzer.js';
import { emptyGraph, type CodeGraph } from '../types.js';
import { PY_GRAPH_SOURCE } from './py-graph-source.js';

const logger = createLogger('graph:python-ast');

/** 子进程超时。大仓 ast.parse 也很快，60s 足够；超时说明卡住了而非慢 */
const TIMEOUT_MS = 60_000;
/** stdout 上限：防超大仓返回巨型 JSON 打爆内存 */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

/** 依赖文件里认得出的 web 框架 → 路由可识别 */
const WEB_FRAMEWORKS = ['fastapi', 'flask', 'django', 'starlette', 'sanic', 'tornado', 'aiohttp'];

function findPythonFiles(dir: string, depth = 0, budget = { n: 0 }): boolean {
  // 探测只需回答"有没有 .py"，命中即返回 —— 不为探测走整棵树
  if (depth > 6 || budget.n > 2000) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    budget.n++;
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
    if (e.isDirectory()) {
      if (findPythonFiles(path.join(dir, e.name), depth + 1, budget)) return true;
    } else if (e.name.endsWith('.py')) {
      return true;
    }
  }
  return false;
}

/**
 * 探测 Python 仓库。
 *
 * 分层给分与 node-babel 对称：认出 web 框架 → 0.95（路由可识别）；
 * 只有依赖声明 → 0.7（可建依赖图）；只有 .py 文件 → 0.5（脚本仓）。
 */
async function detectPython(repoPath: string): Promise<DetectResult> {
  const depFiles = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'environment.yml'];
  const found: string[] = [];
  let depText = '';
  for (const f of depFiles) {
    const p = path.join(repoPath, f);
    try {
      if (fs.existsSync(p)) {
        found.push(f);
        depText += fs.readFileSync(p, 'utf-8').toLowerCase();
      }
    } catch {
      /* 单个依赖文件读失败不影响整体判断 */
    }
  }

  if (found.length) {
    const hit = WEB_FRAMEWORKS.filter((k) => depText.includes(k));
    if (hit.length) {
      return { confidence: 0.95, reason: `${found.join(' / ')} 含 ${hit.join(' / ')}，路由可识别` };
    }
    return {
      confidence: 0.7,
      reason: `发现 ${found.join(' / ')} 但未识别 web 框架，可建依赖图（路由识别不可用）`,
    };
  }

  if (findPythonFiles(repoPath)) {
    return { confidence: 0.5, reason: '无依赖声明文件，但发现 .py 源文件' };
  }
  return { confidence: 0, reason: '未发现 requirements.txt / pyproject.toml 或 .py 文件' };
}

/** 把内嵌脚本落到临时文件。返回 {file, cleanup} */
function materializeScript(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-pygraph-'));
  const file = path.join(dir, 'py_graph.py');
  fs.writeFileSync(file, PY_GRAPH_SOURCE, 'utf-8');
  return {
    file,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 临时目录清理失败不影响结果，交给 OS */
      }
    },
  };
}

/**
 * 建图（Python）。
 *
 * 容错契约与 node-babel 一致：**绝不抛异常**。python3 不存在 / 超时 / 输出不是
 * 合法 JSON，都返回 ok:false + warnings 说明原因（知识层故障不阻塞 ReAct）。
 */
export function buildPythonGraph(repoPath: string): Promise<CodeGraph> {
  const fallback = (msg: string): CodeGraph => ({
    ...emptyGraph(repoPath, 'python-ast'),
    warnings: [msg],
  });

  if (!repoPath) return Promise.resolve(fallback('未提供仓库路径'));
  try {
    if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
      return Promise.resolve(fallback(`${repoPath} 不是有效目录`));
    }
  } catch (err) {
    return Promise.resolve(fallback(`检查目录失败：${(err as Error).message}`));
  }

  let script: { file: string; cleanup: () => void };
  try {
    script = materializeScript();
  } catch (err) {
    return Promise.resolve(fallback(`无法写出 Python 脚本：${(err as Error).message}`));
  }

  return new Promise<CodeGraph>((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (g: CodeGraph) => {
      if (done) return;
      done = true;
      script.cleanup();
      resolve(g);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('python3', [script.file, repoPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // 不继承业务环境变量：建图只需读文件，给它 env 只会扩大意外面
        env: { PATH: process.env.PATH ?? '', LC_ALL: 'C.UTF-8', PYTHONIOENCODING: 'utf-8' },
      });
    } catch (err) {
      finish(fallback(`无法启动 python3：${(err as Error).message}`));
      return;
    }

    const out: Buffer[] = [];
    let outBytes = 0;
    let errText = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(fallback(`Python 建图超时（>${TIMEOUT_MS / 1000}s），已终止`));
    }, TIMEOUT_MS);

    child.stdout?.on('data', (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > MAX_STDOUT_BYTES) {
        child.kill('SIGKILL');
        clearTimeout(timer);
        finish(fallback(`Python 输出超过 ${MAX_STDOUT_BYTES / 1024 / 1024}MB，仓库过大`));
        return;
      }
      out.push(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      // stderr 只留头部：Python traceback 可能很长，而我们只需要首因
      if (errText.length < 500) errText += d.toString('utf-8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      // ENOENT 是最常见的一种（容器没装 python3），给出可操作的提示
      const hint = (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'python3 不在 PATH 中 —— 该环境未安装 Python，无法分析 Python 仓库'
        : `python3 启动失败：${err.message}`;
      finish(fallback(hint));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (done) return;
      const text = Buffer.concat(out).toString('utf-8').trim();
      if (!text) {
        finish(fallback(`Python 建图无输出（exit=${code}）${errText ? `：${errText.slice(0, 200)}` : ''}`));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        finish(fallback(`Python 输出不是合法 JSON（exit=${code}）：${text.slice(0, 150)}`));
        return;
      }
      // shape 校验：只认必需字段齐全的结果。子进程契约必须在边界上验，
      // 否则脏数据会一路流到 analyzeImpact 里才炸，那时已无从判断来源
      const g = parsed as Partial<CodeGraph>;
      if (
        typeof g.ok !== 'boolean' ||
        !Array.isArray(g.modules) ||
        !Array.isArray(g.functions) ||
        !Array.isArray(g.calls) ||
        !Array.isArray(g.routes) ||
        !g.stats
      ) {
        finish(fallback('Python 输出缺少 CodeGraph 必需字段'));
        return;
      }
      logger.info(
        { repoPath, files: g.stats.files, functions: g.stats.functions, routes: g.stats.routes, ms: Date.now() - t0 },
        'python graph built',
      );
      finish({ ...(parsed as CodeGraph), repoDir: repoPath, analyzer: 'python-ast' });
    });
  });
}

export const pythonAstAnalyzer: GraphAnalyzer = {
  name: 'python-ast',
  label: 'Python（FastAPI / Flask）',
  language: 'python',
  frameworks: ['fastapi', 'flask'],
  extensions: ['.py'],
  detect: detectPython,
  analyze: buildPythonGraph,
};
