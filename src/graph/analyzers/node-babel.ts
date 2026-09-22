/**
 * node-babel 分析器 —— JS/TS 仓库建图。ADR-051 §5.3 的第一个内置分析器。
 *
 * 本文件的建图逻辑是从 graph-builder.ts:201-566 **逐行搬迁**的，行为零变化。
 * 保留原有的踩坑注释，因为那些坑与语言强绑定，换个分析器不会重现，但改这个文件的人必须知道。
 *
 * ── 为什么自研语义层，而不是"tree-sitter 全能算，别自己整理" ──
 * 三个栈的裸探测结果（实测，非推演）：
 *   JS   anxin-console-server   255 文件 · 解析零失败 · 路由→ctrl→svc 追通 98.5%
 *   Go   backend-agent-identity  63 文件 · 追通 100% · 1 处动态断点
 *   Java CIAM_Server           5320 文件 · 用 FQN 消歧后追通 100%
 * 各栈的难点是**特有的**，且三个卡点全部不在语法层：
 *   JS 卡在 `const x = {...}; module.exports = x`（第一版就栽在这，追通率报 0%）
 *   Go 卡在 `ctx.Rewrite(fmt.Sprintf("/api/%s/%s", ...))`
 *   Java 卡在 Spring 依赖注入 + 裸名 getUser 撞 17 处
 * tree-sitter 给出完全正确的 CST 也解决不了这三个 —— 它们要的是
 * "这个变量绑定到哪个对象"、"这个注解注入了哪个实现"这类**语义消歧**。
 * 结论：parser 该复用（Babel / tree-sitter 都行），**语义层必须逐栈写**。
 *
 * ── 为什么 JS 用 Babel 而不用 tree-sitter ──
 * Babel 自带 scope 分析，上面那个 JS 卡点靠它才解开；tree-sitter 只给 CST，
 * 变量绑定要自己重写一遍。用 TS 解析 JS 是语言同族优势，不是"恰好有个好库"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

import { createLogger } from '../../engine/shims/logger.js';

import type { GraphAnalyzer, DetectResult } from '../analyzer.js';
import {
  emptyGraph,
  type CodeGraph,
  type ModuleNode,
  type ClassNode,
  type FunctionNode,
  type CallEdge,
  type RouteNode,
} from '../types.js';

// @babel/traverse 的 CJS/ESM interop：default 可能嵌在 .default 里
const _t = (_traverse as unknown as { default?: unknown }).default ?? _traverse;
/** 放宽 traverse 签名：babel 8 的重载对手写 visitor 过严，见下方 AnyVisitor 注释 */
const traverse = _t as (ast: unknown, visitor: unknown) => void;

/**
 * 手写 visitor 的宽松路径类型。
 *
 * 为什么不用 `NodePath<t.CallExpression>` 这种精确类型：babel 8 的 visitor 类型
 * 要求每个 key 的签名与 AST 节点严格对应，而我们只读少量字段（name/loc/arguments）
 * 且要容忍 TS/JSX 混合语法。精确类型会让这段代码充满 as 断言，反而更难读。
 * 折中：路径用宽松类型，**在每个 visitor 内部对 node 做结构化断言**，
 * 字段缺失时静默跳过（配合外层 try/catch，单文件异常不影响整图）。
 */
type AnyPath = { node: unknown };
/** traverse 的 visitor 字典也放宽 —— 否则要为每个 key 写精确签名 */
type AnyVisitor = Record<string, unknown>;

const logger = createLogger('graph:node-babel');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'target', 'build', 'dist', 'out',
  'logs', 'coverage', '.idea', '__pycache__', '.next', 'files', 'public',
]);
const EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 文件数上限：超过就只建模块级依赖，不做函数级（防大仓炸内存） */
const FUNCTION_LEVEL_FILE_LIMIT = 3000;

function walk(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 12) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (EXTS.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

/** 从对象表达式抽方法。**必须同时认 ObjectMethod 简写与 ObjectProperty 挂函数** */
function extractObjectMethods(
  objExpr: { properties?: unknown[] },
): Array<{ name: string; line: number; endLine: number; form: 'method' | 'arrow' }> {
  const out: Array<{ name: string; line: number; endLine: number; form: 'method' | 'arrow' }> = [];
  for (const raw of objExpr.properties ?? []) {
    const prop = raw as {
      type?: string;
      key?: { name?: string; value?: string };
      value?: { type?: string };
      loc?: { start: { line: number }; end: { line: number } };
    };
    const name = prop.key?.name ?? prop.key?.value;
    if (!name || !prop.loc) continue;
    if (prop.type === 'ObjectMethod') {
      out.push({ name, line: prop.loc.start.line, endLine: prop.loc.end.line, form: 'method' });
    } else if (
      prop.type === 'ObjectProperty' &&
      ['FunctionExpression', 'ArrowFunctionExpression'].includes(prop.value?.type ?? '')
    ) {
      out.push({ name, line: prop.loc.start.line, endLine: prop.loc.end.line, form: 'arrow' });
    }
  }
  return out;
}

/**
 * 构建代码图谱（JS/TS）。
 *
 * 容错：全程 try/catch，单文件解析失败只计数不中断；最差返回 ok:false 空图。
 * 知识层故障绝不能阻塞 ReAct。
 *
 * 保持**同步**签名：原 buildGraph 是同步的，repo-policy-service 与 1259 个测试
 * 里的调用方都依赖这一点。异步化是 analyze() 那层的事（见文件末尾的适配）。
 */
export function buildNodeGraph(repoDir: string): CodeGraph {
  const t0 = Date.now();
  const empty = emptyGraph(repoDir, 'node-babel');
  if (!repoDir) return empty;

  let files: string[];
  try {
    if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
      return { ...empty, warnings: [`${repoDir} 不是有效目录`] };
    }
    files = walk(repoDir);
  } catch (err) {
    return { ...empty, warnings: [`枚举源文件失败：${(err as Error).message}`] };
  }
  if (!files.length) {
    return { ...empty, ok: true, stats: { ...empty.stats, buildMs: Date.now() - t0 } };
  }

  const warnings: string[] = [];
  const rel = (p: string) => path.relative(repoDir, p).replace(/\\/g, '/');
  const functionLevel = files.length <= FUNCTION_LEVEL_FILE_LIMIT;
  if (!functionLevel) {
    warnings.push(
      `文件数 ${files.length} 超过 ${FUNCTION_LEVEL_FILE_LIMIT}，仅构建模块级依赖（跳过函数级与调用链）`,
    );
  }

  const modules = new Map<string, ModuleNode>();
  const classes: ClassNode[] = [];
  const functions: FunctionNode[] = [];
  const calls: CallEdge[] = [];
  const routes: RouteNode[] = [];
  /** `${file}::${varName}` → 目标文件。把 codeBatchService 这种变量名解析成真实文件 */
  const varToFile = new Map<string, string>();
  /** `${file}::${varName}` → 该变量绑定的对象方法（const x = {...} 形态） */
  const objectVars = new Map<string, Array<{ name: string; line: number; endLine: number; form: 'method' | 'arrow' }>>();
  let parseFailed = 0;

  function resolveRequire(fromFile: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null; // 第三方包不入图
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const cand of [base, base + '.js', base + '.ts', path.join(base, 'index.js'), path.join(base, 'index.ts')]) {
      try {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return rel(cand);
      } catch {
        /* 忽略单个候选路径的 stat 失败 */
      }
    }
    return null;
  }

  for (const full of files) {
    const R = rel(full);
    let code: string;
    try {
      if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
      code = fs.readFileSync(full, 'utf-8');
    } catch {
      parseFailed++;
      continue;
    }

    let ast: ReturnType<typeof parse>;
    try {
      ast = parse(code, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
        errorRecovery: true,
        // babel 8 已把 classProperties / optionalChaining / nullishCoalescing 内置为默认，
        // 显式传入会触发类型错误；只留下必须显式开启的两个。
        plugins: ['typescript', 'jsx'],
      });
    } catch (err) {
      parseFailed++;
      if (warnings.length < 20) warnings.push(`${R} 解析失败：${(err as Error).message.slice(0, 80)}`);
      continue;
    }

    modules.set(R, { file: R, imports: [], importedBy: [], symbolCount: 0 });
    const mod = modules.get(R)!;
    /** 当前函数名栈，用于给 call 边标注 from */
    const fnStack: string[] = [];
    const curFn = () => (fnStack.length ? fnStack[fnStack.length - 1] : '<top>');

    try {
      traverse(ast, ({
        // ── 模块依赖：require + ESM import ──
        VariableDeclarator(p: AnyPath) {
          const node = p.node as unknown as {
            init?: { type?: string; callee?: { name?: string }; arguments?: Array<{ type?: string; value?: string }>; properties?: unknown[] };
            id?: { type?: string; name?: string };
          };
          const init = node.init;
          const idName = node.id?.name;
          if (!init) return;

          if (
            init.type === 'CallExpression' &&
            init.callee?.name === 'require' &&
            init.arguments?.[0]?.type === 'StringLiteral'
          ) {
            const target = resolveRequire(full, init.arguments[0].value!);
            if (target) {
              if (!mod.imports.includes(target)) mod.imports.push(target);
              if (idName) varToFile.set(`${R}::${idName}`, target);
            }
            return;
          }

          // const xxxCtrl = { async Foo(){} } —— **第一版漏的就是这个，导致追通率报 0%**
          if (functionLevel && init.type === 'ObjectExpression' && idName) {
            const methods = extractObjectMethods(init);
            if (methods.length) objectVars.set(`${R}::${idName}`, methods);
          }
        },

        ImportDeclaration(p: AnyPath) {
          const node = p.node as unknown as {
            source?: { value?: string };
            specifiers?: Array<{ local?: { name?: string } }>;
          };
          const spec = node.source?.value;
          if (!spec) return;
          const target = resolveRequire(full, spec);
          if (!target) return;
          if (!mod.imports.includes(target)) mod.imports.push(target);
          for (const s of node.specifiers ?? []) {
            if (s.local?.name) varToFile.set(`${R}::${s.local.name}`, target);
          }
        },

        // ── 类 ──
        ClassDeclaration(p: AnyPath) {
          if (!functionLevel) return;
          const node = p.node as unknown as {
            id?: { name?: string };
            loc?: { start: { line: number } };
            body?: { body?: Array<{ type?: string; key?: { name?: string }; loc?: { start: { line: number }; end: { line: number } } }> };
          };
          if (!node.id?.name || !node.loc) return;
          const cname = node.id.name;
          const methods: string[] = [];
          for (const m of node.body?.body ?? []) {
            if ((m.type === 'ClassMethod' || m.type === 'ClassPrivateMethod') && m.key?.name && m.loc) {
              methods.push(m.key.name);
              functions.push({
                name: m.key.name,
                file: R,
                line: m.loc.start.line,
                endLine: m.loc.end.line,
                exported: false,
                owner: cname,
                form: 'method',
              });
            }
          }
          classes.push({ name: cname, file: R, line: node.loc.start.line, kind: 'class', methods });
        },

        // ── 顶层函数 ──
        FunctionDeclaration: {
          enter(p: AnyPath) {
            if (!functionLevel) return;
            const node = p.node as unknown as { id?: { name?: string }; loc?: { start: { line: number }; end: { line: number } } };
            if (!node.id?.name || !node.loc) return;
            functions.push({
              name: node.id.name,
              file: R,
              line: node.loc.start.line,
              endLine: node.loc.end.line,
              exported: false,
              owner: null,
              form: 'function',
            });
            fnStack.push(node.id.name);
          },
          exit() {
            fnStack.pop();
          },
        },

        // ── 导出 ──
        AssignmentExpression(p: AnyPath) {
          if (!functionLevel) return;
          const node = p.node as unknown as {
            left?: { type?: string; object?: { name?: string; type?: string; object?: { name?: string }; property?: { name?: string } }; property?: { name?: string } };
            right?: { type?: string; name?: string; properties?: unknown[] };
            loc?: { start: { line: number }; end: { line: number } };
          };
          const L = node.left;
          const Rt = node.right;
          if (!L || !Rt || !node.loc) return;

          const isModuleExports =
            L.type === 'MemberExpression' && L.object?.name === 'module' && L.property?.name === 'exports';
          const isExportsProp =
            L.type === 'MemberExpression' && L.object?.name === 'exports' && !!L.property?.name;

          // module.exports = someVar → 把该变量的方法登记为导出
          if (isModuleExports && Rt.type === 'Identifier' && Rt.name) {
            const methods = objectVars.get(`${R}::${Rt.name}`) ?? [];
            for (const m of methods) {
              functions.push({ ...m, file: R, exported: true, owner: Rt.name });
            }
            if (methods.length) {
              classes.push({
                name: Rt.name,
                file: R,
                line: node.loc.start.line,
                kind: 'object',
                methods: methods.map((m) => m.name),
              });
            }
            return;
          }
          // module.exports = { ... } 直接字面量
          if (isModuleExports && Rt.type === 'ObjectExpression') {
            for (const m of extractObjectMethods(Rt)) {
              functions.push({ ...m, file: R, exported: true, owner: null });
            }
            return;
          }
          // exports.Foo = fn
          if (isExportsProp && ['FunctionExpression', 'ArrowFunctionExpression'].includes(Rt.type ?? '')) {
            functions.push({
              name: L.property!.name!,
              file: R,
              line: node.loc.start.line,
              endLine: node.loc.end.line,
              exported: true,
              owner: null,
              form: 'exports-prop',
            });
          }
        },

        // ── 调用 & 路由 ──
        CallExpression(p: AnyPath) {
          if (!functionLevel) return;
          const node = p.node as unknown as {
            callee?: { type?: string; object?: { name?: string }; property?: { name?: string } };
            arguments?: Array<{ type?: string; value?: string; name?: string; callee?: { name?: string; property?: { name?: string } }; object?: { name?: string }; property?: { name?: string } }>;
            loc?: { start: { line: number } };
          };
          const callee = node.callee;
          if (callee?.type !== 'MemberExpression' || !node.loc) return;
          const objName = callee.object?.name;
          const method = callee.property?.name;
          if (!method) return;

          // 路由注册：router.post('/X', [mw...,] ctrl.Method)
          if (
            (objName === 'router' || objName === 'api' || objName === 'app' || objName === 'mux') &&
            ['get', 'post', 'put', 'delete', 'patch', 'all'].includes(method) &&
            node.arguments?.[0]?.type === 'StringLiteral'
          ) {
            const urlPath = node.arguments[0].value!;
            const restArgs = node.arguments.slice(1);
            const handler = restArgs[restArgs.length - 1];
            const mws = restArgs.slice(0, -1).map((a) => {
              if (a.type === 'CallExpression') return `${a.callee?.name ?? a.callee?.property?.name ?? '?'}()`;
              return a.name ?? a.property?.name ?? '<expr>';
            });
            if (handler?.object?.name && handler.property?.name) {
              routes.push({
                method: method.toUpperCase(),
                urlPath,
                middlewares: mws,
                handlerFile: varToFile.get(`${R}::${handler.object.name}`) ?? null,
                handlerFn: handler.property.name,
                file: R,
                line: node.loc.start.line,
                // 判据是"对象名叫 router/api/app/mux"，换个变量名就认不出 —— 属启发式
                tier: 'inferred',
              });
            }
            return;
          }

          if (objName) {
            calls.push({
              fromFile: R,
              fromFn: curFn(),
              toObj: objName,
              toMethod: method,
              toFile: varToFile.get(`${R}::${objName}`) ?? null,
              line: node.loc.start.line,
              kind: 'call',
              // 目标文件是靠 require/import 的**变量名**反查的，同名变量可能指向不同文件；
              // 但这是本分析器唯一的解析手段，全量标 inferred 会让分级失去区分度，
              // 故沿用 extracted，不确定性由 blindSpots 里那条统一说明
              tier: 'extracted',
            });
          }
        },
      } as AnyVisitor));
    } catch (err) {
      parseFailed++;
      if (warnings.length < 20) warnings.push(`${R} 遍历失败：${(err as Error).message.slice(0, 80)}`);
    }
  }

  // ── 回填反向依赖边 ──
  for (const m of modules.values()) {
    for (const dep of m.imports) {
      const target = modules.get(dep);
      if (target && !target.importedBy.includes(m.file)) target.importedBy.push(m.file);
    }
  }
  // 回填每个模块的符号数
  for (const f of functions) {
    const m = modules.get(f.file);
    if (m) m.symbolCount++;
  }

  // ── 路由 → service 追通率（图谱可用性的核心指标）──
  let traced = 0;
  for (const r of routes) {
    if (!r.handlerFile) continue;
    const target = functions.find((f) => f.file === r.handlerFile && f.name === r.handlerFn);
    if (!target) continue;
    const inner = calls.filter(
      (c) => c.fromFile === r.handlerFile && c.line >= target.line && c.line <= target.endLine && c.toFile,
    );
    if (inner.length) traced++;
  }

  const buildMs = Date.now() - t0;
  logger.info(
    { repoDir, files: files.length, functions: functions.length, routes: routes.length, buildMs },
    'graph built',
  );

  return {
    ok: true,
    repoDir,
    modules: [...modules.values()],
    classes,
    functions,
    calls,
    routes,
    stats: {
      files: files.length,
      parseFailed,
      modules: modules.size,
      classes: classes.length,
      functions: functions.length,
      exportedFunctions: functions.filter((f) => f.exported).length,
      calls: calls.length,
      resolvedCalls: calls.filter((c) => c.toFile).length,
      routes: routes.length,
      routesTracedToService: traced,
      buildMs,
    },
    warnings,
    builtAt: Date.now(),
    analyzer: 'node-babel',
    /**
     * 自述盲区。第二条是本分析器最该被知道的一件事：
     * 它**只认 CJS 导出**（module.exports / exports.x），没有 ESM export 的 visitor，
     * 所以在 ESM 仓里 `exported` 恒为 0 —— 这不是"没有导出"，是"看不出来"。
     * 纯前端/ESM 仓请改用 web-frontend 分析器。
     */
    blindSpots: [
      '路由识别依赖对象名为 router/api/app/mux，动态挂载（app.use(前缀, router)、循环注册）不可见',
      '只识别 CommonJS 导出（module.exports / exports.x）；ESM `export` 语法下 exported 恒为 0，不代表没有导出',
      '调用目标靠 require 变量名反查，跨文件同名变量可能解析错或解析不到',
      '第三方包内部的调用链不入图',
    ],
  };
}

/**
 * 探测这是不是 JS/TS 仓库。
 *
 * 分层给分而非一票判定：有 package.json 且依赖里认出 web 框架 → 0.95（能认路由）；
 * 只有 package.json → 0.7（能建依赖图，路由认不出）；连 package.json 都没有但有
 * .ts/.js 文件 → 0.5（脚本仓/单文件工具的合理情况）。
 */
async function detectNode(repoPath: string): Promise<DetectResult> {
  const pkgPath = path.join(repoPath, 'package.json');
  try {
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const hit = ['koa', '@koa/router', 'koa-router', 'express', 'fastify', 'hono'].filter((k) => k in deps);
      if (hit.length) {
        return { confidence: 0.95, reason: `package.json 依赖含 ${hit.join(' / ')}，路由可识别` };
      }
      return { confidence: 0.7, reason: 'package.json 存在但未识别 web 框架，可建依赖图（路由识别不可用）' };
    }
  } catch {
    /* package.json 坏了不影响后续按扩展名判断 */
  }

  // 无 package.json：看有没有 JS/TS 源文件。只探顶两层，避免为探测走整棵树
  try {
    const shallow = walk(repoPath, [], 10);
    if (shallow.length) {
      return { confidence: 0.5, reason: `无 package.json，但发现 ${shallow.length} 个 JS/TS 文件` };
    }
  } catch {
    /* 目录不可读 → 0 分 */
  }
  return { confidence: 0, reason: '未发现 package.json 或 JS/TS 源文件' };
}

export const nodeBabelAnalyzer: GraphAnalyzer = {
  name: 'node-babel',
  label: 'Node.js（Koa / Express）',
  language: 'javascript',
  frameworks: ['koa', 'express'],
  extensions: EXTS,
  detect: detectNode,
  // 建图是 CPU 密集的同步操作，包一层 Promise 满足契约即可 —— 不假装它是并发的
  analyze: (repoPath: string) => Promise.resolve(buildNodeGraph(repoPath)),
};
