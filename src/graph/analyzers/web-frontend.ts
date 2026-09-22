/**
 * web-frontend 分析器 —— 纯前端仓（React / Vue）建图。ADR-051 §5.3 矩阵补的那一格。
 *
 * ── 为什么不能复用 node-babel ──
 * 实测（@tencent/tea-app-ciam，267 文件 · React + dva）走 node-babel 的结果：
 *   import 边 112 / 实际 610（402 条 `@src/` 别名被当第三方丢掉，208 条相对 import
 *                              因候选后缀只有 .js/.ts 而认不出 .tsx）
 *   importedBy > 0 的模块 8 / 266   ← **反向依赖图是空的，analyzeImpact 恒为 0**
 *   调用边解析到文件 6 / 1120（0.5%）
 *   箭头形态函数 1 / 实际 242 个 `export const X = () => {}`
 *   exported 函数 1               ← 只认 CJS module.exports，这个仓 0 处
 *   routes 0                      ← 只认 router.post()
 * 而它 `ok: true`、677 节点 —— **不是空图，是稀疏到失真的图**，比空图更危险：
 * agent 会把"没有调用者"当成"可以安全删"。
 *
 * 差异不在文件读取层（那样一个 loader 就够了），而在三处语义层：
 *   ① 模块解析 —— 构建工具 alias（tsconfig paths / vite / webpack），不是 node 解析
 *   ② 符号形态 —— ESM 箭头组件、hook、JSX 引用，不是 class + CJS 导出
 *   ③ 影响面终点 —— 页面路由 + 调用的后端 API，不是 HTTP route
 *
 * ── 为什么自己写 resolver，而不用 dependency-cruiser ──
 * 调研结论是它（底层 enhanced-resolve）能正确处理 tsconfig paths / webpack alias /
 * .vue / .jsx，本该复用。但 tsup 是**单文件打包**（见 tsup.config.ts 与 python-ast.ts
 * 文件头那条教训），把一个带动态 require 的 CLI 级依赖 bundle 进 dist/index.js
 * 属于"本地全绿、线上报错"的高风险区；而我们只需要它的 resolve 那一小块（约 60 行）。
 * 取舍：**resolver 自己写但独立成段**（loadAliases + makeResolver），
 * 将来要换成 enhanced-resolve 只动这两个函数。
 *
 * ── 与 CodeGraph 契约的对齐（关键：查图代码一行不改）──
 *   routes[]        = **页面路由**，method 固定 'PAGE'，handlerFile/Fn = 页面组件
 *   calls[] toObj='@api'  = 调用的后端接口，toMethod = 'POST /console/xxx'（toFile 为 null）
 *   calls[] toMethod='<jsx>' = JSX 组件引用（前端真正的"调用边"）
 * 这样 analyzeImpact 的"受影响的对外接口"自然读作"受影响的页面"，
 * hotSpots 自然读作"被最多页面复用的组件" —— 语义对齐，无需改 graph-builder.ts。
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
  type EdgeTier,
  type NavigationEdge,
} from '../types.js';
import { extractApiContracts, extractPageFingerprints } from './frontend-contracts.js';

// 与 node-babel 同样的 CJS/ESM interop 与宽松 visitor 类型，理由见那个文件
const _t = (_traverse as unknown as { default?: unknown }).default ?? _traverse;
const traverse = _t as (ast: unknown, visitor: unknown) => void;
type AnyPath = { node: unknown };
type AnyVisitor = Record<string, unknown>;

const logger = createLogger('graph:web-frontend');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '.output', '.turbo', 'storybook-static', 'public', 'static', 'assets',
  '__pycache__', '.idea', '.vscode', 'es', 'lib',
]);
/** 参与建图的源文件 */
const CODE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'];
/**
 * import 解析时尝试的后缀，**顺序即优先级**。
 * .tsx 排最前是前端仓的事实分布（实测那个仓 183 tsx : 50 ts : 26 jsx : 3 js）——
 * node-babel 把 .js/.ts 排前且根本没有 .tsx，是它丢掉一半相对 import 的直接原因。
 */
const RESOLVE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '.vue', '.mjs', '.cjs'];
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 超过就只建模块级依赖（前端仓文件数普遍大于后端，阈值放宽到 5000） */
const FUNCTION_LEVEL_FILE_LIMIT = 5000;
const MAX_WARNINGS = 20;

/** 前端框架标志（detect 用） */
const FRONTEND_DEPS = [
  'react', 'react-dom', 'vue', 'svelte', 'solid-js', 'preact',
  'next', 'nuxt', 'umi', 'dva', '@tencent/tea-app', '@tarojs/taro',
];
/** 服务端框架标志：命中说明这不是纯前端仓，让位给 node-babel */
const SERVER_DEPS = ['koa', '@koa/router', 'koa-router', 'express', 'fastify', 'hono', '@nestjs/core'];
/** 构建工具，用于加分（有它基本可以确认是应用仓而非组件库源码） */
const BUILD_DEPS = ['vite', 'webpack', 'rspack', 'parcel', '@vitejs/plugin-react', 'umi', '@tencent/tea-app'];

/** 常见的请求方法名 —— 用于把 `xxx.fetch('/api/y')` 认成后端接口调用 */
const REQUEST_METHODS = new Set(['fetch', 'request', 'get', 'post', 'put', 'delete', 'patch', 'head']);
/** 裸函数形态的请求发起者 */
const REQUEST_FNS = new Set(['fetch', 'request', 'axios']);

// ══════════════════ ① 模块解析（alias 感知） ══════════════════

interface Alias {
  /** 'src/' 这种前缀（wildcard=true）或完整标识（wildcard=false） */
  prefix: string;
  /** 绝对路径目标（取 paths 数组第一个，多目标场景罕见且第一个即首选） */
  target: string;
  wildcard: boolean;
}

/**
 * 容忍注释与尾逗号的 JSON 解析（JSONC）。
 *
 * tsconfig.json 事实上是 JSONC —— 官方模板自己就带 `//` 注释。
 * 用严格 JSON.parse 会在**最常见的那类仓库**上直接失败并静默丢掉全部 alias，
 * 而 alias 丢了整张图就废了（实测 402/610 条 import 走 alias）。
 *
 * ── 为什么必须是字符串感知的扫描，不能用正则 ──
 * 第一版用正则剥块注释，被单测钉出来：tsconfig 的 paths 键**必然**长成 `"@src/*"`，
 * 里面那个斜杠星号会被当成块注释开头，一路吃到文件后面任意一个块注释结束符为止 ——
 * 整段 paths 就没了，而且**不报错**（剩下的仍是合法 JSON），正是最难查的那种失败。
 */
function parseJsonc(text: string): unknown {
  /** 逐字符扫描，`inString` 内的内容一律原样透传给 emit */
  const scan = (src: string, emit: (s: string) => void, onOutside: (i: number) => number | null) => {
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '"') {
        emit(c);
        i++;
        while (i < src.length) {
          emit(src[i]);
          if (src[i] === '\\') {
            i++;
            if (i < src.length) emit(src[i]);
          } else if (src[i] === '"') {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      const skipped = onOutside(i);
      if (skipped !== null) {
        i = skipped;
        continue;
      }
      emit(c);
      i++;
    }
  };

  // 第一趟：剥注释
  let noComments = '';
  scan(text, (s) => { noComments += s; }, (i) => {
    if (text[i] === '/' && text[i + 1] === '/') {
      let j = i;
      while (j < text.length && text[j] !== '\n') j++;
      return j;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      let j = i + 2;
      while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j++;
      return j + 2;
    }
    return null;
  });

  // 第二趟：删尾逗号。**必须在剥注释之后单独跑** ——
  // 合在一起时 `["./src/*"], /* 注释 */\n}` 的向前看会被注释挡住，逗号留下来照样解析失败。
  let out = '';
  scan(noComments, (s) => { out += s; }, (i) => {
    if (noComments[i] !== ',') return null;
    let j = i + 1;
    while (j < noComments.length && /\s/.test(noComments[j])) j++;
    return noComments[j] === '}' || noComments[j] === ']' ? i + 1 : null;
  });

  return JSON.parse(out);
}

/**
 * 读取路径别名。来源两处，按可靠性排序：
 *   ① tsconfig.json / jsconfig.json 的 compilerOptions.paths（结构化，可靠）
 *   ② vite / webpack 配置里的 resolve.alias（**正则近似**，见下）
 *
 * ② 为什么敢用正则：alias 配置的实际写法收敛在
 * `'@': path.resolve(__dirname, 'src')` 这一种形态上，而真正解析 vite.config.ts
 * 需要执行它（会跑用户代码，不可接受）。取舍是"多认出一批边"vs"零风险"，
 * 且认错的后果被 `tryFile` 兜住 —— 解析不到真实文件就当第三方丢弃，不会造出假依赖。
 */
function loadAliases(
  repoDir: string,
  warnings: string[],
): { aliases: Alias[]; source: 'tsconfig' | 'buildconfig' | 'none' } {
  const out: Alias[] = [];
  let source: 'tsconfig' | 'buildconfig' | 'none' = 'none';

  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const p = path.join(repoDir, name);
    try {
      if (!fs.existsSync(p)) continue;
      const cfg = parseJsonc(fs.readFileSync(p, 'utf-8')) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const co = cfg.compilerOptions;
      if (!co?.paths) continue;
      const baseUrl = path.resolve(repoDir, co.baseUrl ?? '.');
      for (const [key, targets] of Object.entries(co.paths)) {
        const first = targets?.[0];
        if (!first) continue;
        const wildcard = key.endsWith('*');
        out.push({
          prefix: wildcard ? key.slice(0, -1) : key,
          target: path.resolve(baseUrl, wildcard ? first.replace(/\*$/, '') : first),
          wildcard,
        });
        source = 'tsconfig';
      }
    } catch (err) {
      if (warnings.length < MAX_WARNINGS) {
        warnings.push(`${name} 解析失败，别名 import 将无法解析：${(err as Error).message.slice(0, 60)}`);
      }
    }
  }

  if (!out.length) {
    // 退而求其次：从构建配置里正则捞 alias
    for (const name of ['vite.config.ts', 'vite.config.js', 'webpack.config.js', 'build/webpack.base.js']) {
      const p = path.join(repoDir, name);
      try {
        if (!fs.existsSync(p)) continue;
        const text = fs.readFileSync(p, 'utf-8');
        const re = /['"`]([@~][\w./-]*)['"`]\s*:\s*(?:path\.\w+\([^)]*['"`]([^'"`]+)['"`][^)]*\)|['"`]([^'"`]+)['"`])/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const key = m[1];
          const rawTarget = m[2] ?? m[3];
          if (!rawTarget) continue;
          out.push({
            prefix: key.endsWith('/') ? key : `${key}/`,
            target: path.resolve(repoDir, rawTarget.replace(/^\.\//, '')),
            wildcard: true,
          });
          source = 'buildconfig';
        }
      } catch {
        /* 构建配置读不到不影响主流程 */
      }
    }
  }

  // 长前缀优先：'@src/utils/' 必须先于 '@src/' 匹配，否则会解析到错误的目录
  return { aliases: out.sort((a, b) => b.prefix.length - a.prefix.length), source };
}

/** 建一个 `(fromFile, spec) => 仓库相对路径 | null` 的解析器 */
function makeResolver(repoDir: string, aliases: Alias[]) {
  const rel = (p: string) => path.relative(repoDir, p).replace(/\\/g, '/');

  /** 逐个后缀试探真实文件。**解析不到就返回 null（当第三方丢弃），绝不猜** */
  const tryFile = (base: string): string | null => {
    const cands = [base];
    for (const e of RESOLVE_EXTS) cands.push(base + e);
    for (const e of RESOLVE_EXTS) cands.push(path.join(base, `index${e}`));
    for (const c of cands) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) {
          // 解析到仓库外（如 alias 指向 node_modules）视为第三方
          const r = rel(c);
          if (r.startsWith('..') || r.includes('node_modules/')) return null;
          return r;
        }
      } catch {
        /* 单个候选 stat 失败继续试下一个 */
      }
    }
    return null;
  };

  return (fromFile: string, spec: string): string | null => {
    if (!spec) return null;
    if (spec.startsWith('.')) {
      return tryFile(path.resolve(path.dirname(fromFile), spec));
    }
    for (const a of aliases) {
      if (a.wildcard) {
        if (spec.startsWith(a.prefix)) return tryFile(path.join(a.target, spec.slice(a.prefix.length)));
      } else if (spec === a.prefix) {
        return tryFile(a.target);
      }
    }
    return null; // 第三方包不入图
  };
}

// ══════════════════ ② 源码读取（含 .vue 单文件组件） ══════════════════

interface SourceFile {
  /** 可交给 babel 的 JS/TS 代码 */
  code: string;
  /** .vue 的 <template> 原文（用于识别模板里的组件引用），非 vue 为 null */
  template: string | null;
}

/**
 * 读源文件。`.vue` 抽出 `<script>` 块。
 *
 * 为什么不用 @vue/compiler-sfc：加一个 npm 依赖只为拿 script 块的位置，
 * 而 `<script>` 的定位是正则就能可靠完成的（它必须在顶层、不能嵌套）。
 * **用换行符补齐偏移量**而不是记录 offset —— 这样 babel 报出的行号
 * 直接就是 .vue 文件里的真实行号，下游 evidence/行号重定位无需特殊处理。
 */
function readSource(full: string): SourceFile | null {
  let raw: string;
  try {
    if (fs.statSync(full).size > MAX_FILE_BYTES) return null;
    raw = fs.readFileSync(full, 'utf-8');
  } catch {
    return null;
  }
  if (!full.endsWith('.vue')) return { code: raw, template: null };

  const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(raw);
  const tmpl = /<template[^>]*>([\s\S]*)<\/template>/.exec(raw);
  if (!m) return { code: '', template: tmpl?.[1] ?? null };
  const before = raw.slice(0, m.index + m[0].indexOf(m[1]));
  const lineOffset = before.split('\n').length - 1;
  return { code: '\n'.repeat(lineOffset) + m[1], template: tmpl?.[1] ?? null };
}

function walk(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 12) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (CODE_EXTS.some((x) => e.name.endsWith(x)) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** PascalCase = 组件；useXxx = hook。这是 React/Vue 生态的硬约定，可直接当判据 */
function symbolForm(name: string, hasJsx: boolean): FunctionNode['form'] {
  if (/^use[A-Z]/.test(name)) return 'hook';
  if (hasJsx && /^[A-Z]/.test(name)) return 'component';
  return 'arrow';
}

/** 驼峰转 kebab：Vue 模板里 `<UserPicker>` 也可能写成 `<user-picker>` */
function toKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// ══════════════════ ③ 建图 ══════════════════

export function buildFrontendGraph(repoDir: string): CodeGraph {
  const t0 = Date.now();
  const empty = emptyGraph(repoDir, 'web-frontend');
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
  const { aliases, source: aliasSource } = loadAliases(repoDir, warnings);
  const resolveSpec = makeResolver(repoDir, aliases);
  const rel = (p: string) => path.relative(repoDir, p).replace(/\\/g, '/');
  const functionLevel = files.length <= FUNCTION_LEVEL_FILE_LIMIT;
  if (!functionLevel) {
    warnings.push(
      `文件数 ${files.length} 超过 ${FUNCTION_LEVEL_FILE_LIMIT}，仅构建模块级依赖（跳过组件级与调用链）`,
    );
  }
  if (!aliases.length) {
    warnings.push('未发现路径别名配置（tsconfig paths / vite alias），若该仓使用别名 import 则依赖边会缺失');
  }

  const modules = new Map<string, ModuleNode>();
  const classes: ClassNode[] = [];
  const functions: FunctionNode[] = [];
  const calls: CallEdge[] = [];
  const routes: RouteNode[] = [];
  /** `${file}::${localName}` → 目标文件。import 与动态 import 都往这里登记 */
  const varToFile = new Map<string, string>();
  /** 每个文件 default export 的符号名 —— 路由 handler 回填要用（见文件末尾 post-pass） */
  const defaultExportName = new Map<string, string>();
  /**
   * 文件级字符串常量表：该文件**导出的**「纯字符串对象字面量」合并。
   * 用来把 `requestV3.fetch(APIS.DescribeX)` 折成真实路径（saas-web 226 个接口的写法）。
   */
  const fileConstTables = new Map<string, Map<string, string>>();
  /** `export { default } from './List'` → 本文件 default 实际在哪个文件 */
  const defaultReexport = new Map<string, string>();
  const pendingApi: Array<{
    fromFile: string;
    fromFn: string;
    line: number;
    objName: string;
    key: string;
    verb: string;
  }> = [];
  /** 文件内所有 import 本地名（含未解析到仓内的第三方），similar 指纹用 */
  const fileImportNames = new Map<string, Set<string>>();
  /** 文件内所有 PascalCase JSX 标签（含第三方组件库） */
  const fileJsxTags = new Map<string, Set<string>>();
  const navigations: NavigationEdge[] = [];
  let parseFailed = 0;

  for (const full of files) {
    const R = rel(full);
    const src = readSource(full);
    if (!src) {
      parseFailed++;
      continue;
    }

    modules.set(R, { file: R, imports: [], importedBy: [], symbolCount: 0 });
    const mod = modules.get(R)!;
    if (!src.code.trim()) continue; // .vue 只有模板没有 script：模块节点保留，符号为空

    let ast: ReturnType<typeof parse>;
    try {
      ast = parse(src.code, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
        errorRecovery: true,
        // 前端仓比后端更常用提案语法：装饰器（mobx/dva）、`a?.b = c`。
        // node-babel 缺这两个，实测已导致该仓文件解析失败。
        // optionalChainingAssign 必须带 version，漏了会让**每个文件**都解析失败
        // （babel 抛的是配置错误而非语法错误，而我们对两者一视同仁地计入 parseFailed）。
        plugins: ['typescript', 'jsx', 'decorators-legacy', ['optionalChainingAssign', { version: '2023-07' }]],
      });
    } catch (err) {
      parseFailed++;
      if (warnings.length < MAX_WARNINGS) warnings.push(`${R} 解析失败：${(err as Error).message.slice(0, 80)}`);
      continue;
    }

    const fnStack: string[] = [];
    const curFn = () => (fnStack.length ? fnStack[fnStack.length - 1] : '<top>');
    const exportedNames = new Set<string>();
    const localConstTables: Array<{ name: string; map: Map<string, string> }> = [];
    let defaultObjectTable: Map<string, string> | null = null;
    /** 本文件内 `名字 → functions[] 下标`，用于 export 回填 exported 标记 */
    const fnIndexByName = new Map<string, number[]>();

    const addImport = (spec: string, localNames: string[]) => {
      if (localNames.length) {
        let bag = fileImportNames.get(R);
        if (!bag) {
          bag = new Set();
          fileImportNames.set(R, bag);
        }
        for (const n of localNames) if (n) bag.add(n);
      }
      const target = resolveSpec(full, spec);
      if (!target) return;
      if (!mod.imports.includes(target)) mod.imports.push(target);
      for (const n of localNames) varToFile.set(`${R}::${n}`, target);
    };

    const pushFn = (f: FunctionNode) => {
      const i = functions.push(f) - 1;
      const list = fnIndexByName.get(f.name) ?? [];
      list.push(i);
      fnIndexByName.set(f.name, list);
    };

    /** 从 `component={withCheck(Foo)}` / `element={<Foo/>}` / `Foo` 里挖出组件名与 HOC 链 */
    const unwrapHandler = (
      node: unknown,
    ): { name: string | null; middlewares: string[] } => {
      const mws: string[] = [];
      let cur = node as {
        type?: string;
        name?: string;
        callee?: { name?: string; property?: { name?: string } };
        arguments?: unknown[];
        openingElement?: { name?: { name?: string } };
        expression?: unknown;
      } | undefined;
      for (let i = 0; i < 6 && cur; i++) {
        if (cur.type === 'JSXExpressionContainer') {
          cur = cur.expression as typeof cur;
          continue;
        }
        if (cur.type === 'JSXElement') return { name: cur.openingElement?.name?.name ?? null, middlewares: mws };
        if (cur.type === 'Identifier') return { name: cur.name ?? null, middlewares: mws };
        if (cur.type === 'CallExpression') {
          const hoc = cur.callee?.name ?? cur.callee?.property?.name;
          if (hoc) mws.push(`${hoc}()`);
          cur = cur.arguments?.[0] as typeof cur;
          continue;
        }
        break;
      }
      return { name: null, middlewares: mws };
    };

    /**
     * @param tier 'extracted' = `<Route path=…>` 这种明确的路由声明；
     *             'inferred'  = 靠"字符串 key 形似路径"猜出来的路由表条目（见 scanRouteObject）
     */
    const addRoute = (urlPath: string, handlerNode: unknown, line: number, tier: EdgeTier) => {
      const { name, middlewares } = unwrapHandler(handlerNode);
      if (!name) return;
      routes.push({
        method: 'PAGE',
        // 路由表里常写成 'ciam/user-management'（无前导斜杠），统一补上便于 trace 匹配
        urlPath: urlPath.startsWith('/') ? urlPath : `/${urlPath}`,
        middlewares,
        handlerFile: varToFile.get(`${R}::${name}`) ?? null,
        handlerFn: name,
        file: R,
        line,
        tier,
      });
    };

    /**
     * 认路由表对象：`{ 'ciam/user-management': LazyUserManager }`（tea-app / umi 风格）
     * 与 `{ path: '/x', component: Foo }`（react-router / vue-router 风格）。
     */
    /** 剥掉 `as IRoutes[]` / 括号，避免 typed 数组初始化被当成非 Object/Array */
    const unwrapExpr = (n: unknown): { type?: string; properties?: unknown[]; elements?: unknown[]; expression?: unknown } | null => {
      let cur = n as { type?: string; expression?: unknown } | null;
      for (let i = 0; i < 6 && cur; i++) {
        if (
          cur.type === 'TSAsExpression' ||
          cur.type === 'TSTypeAssertion' ||
          cur.type === 'TSSatisfiesExpression' ||
          cur.type === 'ParenthesizedExpression'
        ) {
          cur = (cur.expression as typeof cur) ?? null;
          continue;
        }
        break;
      }
      return cur;
    };

    const scanRouteInit = (init: unknown) => {
      const n = unwrapExpr(init);
      if (!n) return;
      if (n.type === 'ObjectExpression') scanRouteObject(n);
      else if (n.type === 'ArrayExpression') {
        for (const el of n.elements ?? []) {
          const item = unwrapExpr(el);
          if (item?.type === 'ObjectExpression') scanRouteObject(item);
        }
      }
    };

    const scanRouteObject = (objExpr: { properties?: unknown[] }) => {
      let pathVal: string | null = null;
      let compNode: unknown = null;
      let objLine = 0;
      for (const raw of objExpr.properties ?? []) {
        const prop = raw as {
          type?: string;
          key?: { name?: string; value?: string };
          value?: unknown;
          loc?: { start: { line: number } };
        };
        if (prop.type !== 'ObjectProperty' || !prop.loc) continue;
        const keyStr = prop.key?.value; // 字符串 key
        const keyName = prop.key?.name; // 标识符 key
        objLine = objLine || prop.loc.start.line;

        // 形态一：字符串 key 且像路径。
        // **判据必须含 `/`**：第一版只要求"有 / 或 -"，结果把
        // `{ '56dfc247-c7d3-...': ADD_WECHAT }` 这种 UUID → 常量的配置表全认成了路由
        // （实测多出 40 条假页面）。假路由比漏路由危险得多 ——
        // 它直接污染 analyzeImpact 那个"受影响的页面数"头条数字。
        if (typeof keyStr === 'string' && keyStr.includes('/') && !/[\s?#]/.test(keyStr)) {
          addRoute(keyStr, prop.value, prop.loc.start.line, 'inferred');
          continue;
        }
        // 形态二：{ path, component/element }
        if (keyName === 'path' && typeof (prop.value as { value?: string })?.value === 'string') {
          pathVal = (prop.value as { value: string }).value;
        } else if (keyName === 'component' || keyName === 'element') {
          compNode = prop.value;
        }
      }
      // 形态二是 AST 直取的 { path, component }，不是猜的，标 extracted。
      // inferred 只留给形态一那种「字符串 key 看起来像路径」的启发式。
      if (pathVal && compNode) addRoute(pathVal, compNode, objLine, 'extracted');
    };

    try {
      traverse(ast, ({
        // ── 模块依赖 ──
        ImportDeclaration(p: AnyPath) {
          const node = p.node as unknown as {
            source?: { value?: string };
            specifiers?: Array<{ local?: { name?: string } }>;
          };
          if (!node.source?.value) return;
          addImport(
            node.source.value,
            (node.specifiers ?? []).map((s) => s.local?.name).filter(Boolean) as string[],
          );
        },

        VariableDeclarator(p: AnyPath) {
          const node = p.node as unknown as {
            init?: {
              type?: string;
              callee?: { type?: string; name?: string; object?: { name?: string }; property?: { name?: string } };
              arguments?: Array<{ type?: string; value?: string; body?: unknown }>;
              properties?: unknown[];
            };
            id?: { type?: string; name?: string };
            loc?: { start: { line: number }; end: { line: number } };
          };
          const init = node.init;
          const idName = node.id?.name;
          if (!init || !node.loc) return;

          // CJS：前端仓的构建脚本、i18n 文件里仍有 require
          if (
            init.type === 'CallExpression' &&
            init.callee?.name === 'require' &&
            init.arguments?.[0]?.type === 'StringLiteral'
          ) {
            addImport(init.arguments[0].value!, idName ? [idName] : []);
            return;
          }

          // 动态 import：`const Page = lazy(() => import('@src/views/x'))`
          // **不认它路由就全废** —— 前端页面组件几乎都是懒加载进来的
          if (init.type === 'CallExpression' && idName) {
            const spec = findDynamicImport(init);
            if (spec) {
              addImport(spec, [idName]);
              return;
            }
          }

          if (!functionLevel) return;

          // `const Foo = () => <div/>` / `const useX = () => {...}`
          if (idName && ['ArrowFunctionExpression', 'FunctionExpression'].includes(init.type ?? '')) {
            pushFn({
              name: idName,
              file: R,
              line: node.loc.start.line,
              endLine: node.loc.end.line,
              exported: false,
              owner: null,
              form: symbolForm(idName, containsJsx(init)),
            });
            return;
          }

          // `const routes = { 'ciam/x': LazyX }`
          // 以及 saas-web 这类：`export const routes: IRoutes[] = [{ path, component }, …]`
          scanRouteInit(init);
          if (idName) {
            const obj = unwrapExpr(init);
            if (obj?.type === 'ObjectExpression') {
              const table = collectStringLiteralProps(obj);
              if (table.size) localConstTables.push({ name: idName, map: table });
            }
          }
        },

        // ── 符号 ──
        FunctionDeclaration: {
          enter(p: AnyPath) {
            if (!functionLevel) return;
            const node = p.node as unknown as {
              id?: { name?: string };
              loc?: { start: { line: number }; end: { line: number } };
            };
            if (!node.id?.name || !node.loc) return;
            pushFn({
              name: node.id.name,
              file: R,
              line: node.loc.start.line,
              endLine: node.loc.end.line,
              exported: false,
              owner: null,
              form: symbolForm(node.id.name, containsJsx(node)),
            });
            fnStack.push(node.id.name);
          },
          exit() {
            fnStack.pop();
          },
        },

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
              pushFn({
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

        // ── ESM 导出（node-babel 完全没有这两个 visitor，是它 exported 恒为 0 的原因）──
        ExportNamedDeclaration(p: AnyPath) {
          const node = p.node as unknown as {
            declaration?: { type?: string; id?: { name?: string }; declarations?: Array<{ id?: { name?: string } }> };
            specifiers?: Array<{ exported?: { name?: string }; local?: { name?: string } }>;
            source?: { value?: string };
          };
          // `export { x } from './y'` 也是一条依赖边
          if (node.source?.value) {
            addImport(
              node.source.value,
              (node.specifiers ?? []).map((s) => s.local?.name).filter(Boolean) as string[],
            );
            const target = resolveSpec(full, node.source.value);
            if (target) {
              for (const s of node.specifiers ?? []) {
                if (s.exported?.name === 'default') defaultReexport.set(R, target);
              }
            }
          }
          const d = node.declaration;
          if (d?.id?.name) exportedNames.add(d.id.name);
          for (const decl of d?.declarations ?? []) {
            if (decl.id?.name) exportedNames.add(decl.id.name);
          }
          for (const s of node.specifiers ?? []) {
            if (s.local?.name) exportedNames.add(s.local.name);
          }
        },

        ExportDefaultDeclaration(p: AnyPath) {
          const node = p.node as unknown as {
            declaration?: { type?: string; id?: { name?: string }; name?: string; properties?: unknown[] };
          };
          const d = node.declaration;
          if (!d) return;
          const name = d.id?.name ?? d.name;
          if (name) {
            exportedNames.add(name);
            defaultExportName.set(R, name);
          }
          // `export default { 'ciam/x': LazyX }` —— 路由表的最常见落点
          // 也认 `export default [{ path, component }, …]`
          scanRouteInit(d);
          const dObj = unwrapExpr(d);
          if (dObj?.type === 'ObjectExpression') {
            const table = collectStringLiteralProps(dObj);
            if (table.size) defaultObjectTable = table;
          }
        },

        // ── 调用边 ──
        CallExpression(p: AnyPath) {
          if (!functionLevel) return;
          const node = p.node as unknown as {
            callee?: { type?: string; name?: string; object?: { name?: string }; property?: { name?: string } };
            arguments?: Array<{ type?: string; value?: string; properties?: unknown[] }>;
            loc?: { start: { line: number } };
          };
          const callee = node.callee;
          if (!callee || !node.loc) return;
          const line = node.loc.start.line;

          // ① 后端接口调用 —— 前端图谱最有价值的一类边（可与后端仓 routes 对上）
          const api = extractApiCall(node);
          if (api) {
            calls.push({
              fromFile: R,
              fromFn: curFn(),
              toObj: '@api',
              toMethod: api,
              toFile: null,
              line,
              kind: 'api',
              tier: 'extracted',
            });
            return;
          }

          // `requestV3.fetch(APIS.DescribeX, { method: 'post' })` —— 等常量模块解析完再折
          const firstArg = node.arguments?.[0] as
            | {
                type?: string;
                object?: { type?: string; name?: string };
                property?: { type?: string; name?: string; computed?: boolean };
                computed?: boolean;
              }
            | undefined;
          if (
            firstArg?.type === 'MemberExpression' &&
            !firstArg.computed &&
            firstArg.object?.type === 'Identifier' &&
            firstArg.object.name &&
            firstArg.property?.type === 'Identifier' &&
            firstArg.property.name &&
            isRequestCallee(callee)
          ) {
            pendingApi.push({
              fromFile: R,
              fromFn: curFn(),
              line,
              objName: firstArg.object.name,
              key: firstArg.property.name,
              verb: extractRequestVerb(node) ?? 'ANY',
            });
            return;
          }

          // ② 成员调用 `svc.doX()`
          if (callee.type === 'MemberExpression') {
            const objName = callee.object?.name;
            const method = callee.property?.name;
            if (!objName || !method) return;
            if (method === 'push' || method === 'replace') {
              const toPath = extractNavPath(node.arguments?.[0]);
              if (toPath) {
                navigations.push({
                  fromFile: R,
                  fromFn: curFn(),
                  toPath,
                  line,
                  tier: 'extracted',
                });
              }
            }
            calls.push({
              fromFile: R,
              fromFn: curFn(),
              toObj: objName,
              toMethod: method,
              toFile: varToFile.get(`${R}::${objName}`) ?? null,
              line,
              kind: 'call',
              tier: 'extracted',
            });
            return;
          }

          // ③ 裸函数调用 `getBillingResources()` —— **只记 import 进来的**。
          // node-babel 完全不认这一类，而 ESM 前端仓的 service 调用几乎全是这个形态；
          // 限定"已解析到文件"是为了不把 useState()/map() 这类噪音灌进图里（实测能把边数压掉一个量级）。
          if (callee.type === 'Identifier' && callee.name) {
            if (callee.name === 'navigate') {
              const toPath = extractNavPath(node.arguments?.[0]);
              if (toPath) {
                navigations.push({
                  fromFile: R,
                  fromFn: curFn(),
                  toPath,
                  line,
                  tier: 'extracted',
                });
              }
            }
            const target = varToFile.get(`${R}::${callee.name}`);
            if (!target) return;
            calls.push({
              fromFile: R,
              fromFn: curFn(),
              toObj: null,
              toMethod: callee.name,
              toFile: target,
              line,
              kind: 'call',
              tier: 'extracted',
            });
          }
        },

        // ── JSX：组件引用边 + react-router 路由 ──
        JSXOpeningElement(p: AnyPath) {
          if (!functionLevel) return;
          const node = p.node as unknown as {
            name?: { type?: string; name?: string };
            attributes?: Array<{ type?: string; name?: { name?: string }; value?: unknown }>;
            loc?: { start: { line: number } };
          };
          const tag = node.name?.name;
          if (!tag || !node.loc) return;
          const line = node.loc.start.line;

          if (tag === 'Route') {
            let urlPath: string | null = null;
            let handler: unknown = null;
            for (const a of node.attributes ?? []) {
              if (a.type !== 'JSXAttribute') continue;
              const an = a.name?.name;
              if (an === 'path') {
                const v = a.value as { type?: string; value?: string; expression?: { value?: string } };
                urlPath = v?.value ?? v?.expression?.value ?? null;
              } else if (an === 'component' || an === 'element' || an === 'render') {
                handler = a.value;
              }
            }
            if (urlPath && handler) addRoute(urlPath, handler, line, 'extracted');
            return;
          }

          // 小写标签是 html 原生元素，不是组件
          if (!/^[A-Z]/.test(tag)) return;
          {
            let jsx = fileJsxTags.get(R);
            if (!jsx) {
              jsx = new Set();
              fileJsxTags.set(R, jsx);
            }
            jsx.add(tag);
          }
          const target = varToFile.get(`${R}::${tag}`);
          if (!target) return; // 第三方 UI 库组件不入图（但仍计入指纹）
          calls.push({
            fromFile: R,
            fromFn: curFn(),
            toObj: tag,
            toMethod: '<jsx>',
            toFile: target,
            line,
            kind: 'jsx',
            tier: 'extracted',
          });
        },
      } as AnyVisitor));
    } catch (err) {
      parseFailed++;
      if (warnings.length < MAX_WARNINGS) warnings.push(`${R} 遍历失败：${(err as Error).message.slice(0, 80)}`);
    }

    // 回填 exported
    for (const name of exportedNames) {
      for (const i of fnIndexByName.get(name) ?? []) functions[i].exported = true;
    }

    const fileTable = new Map<string, string>();
    // 【移植偏差 · 仅类型层】先接成局部常量并断言回原始联合类型。
    // defaultObjectTable 的赋值发生在上面的嵌套闭包里，TS 的控制流分析看不到，
    // 于是在这里把它收窄成 null，`if` 之后又变成 never，导致 TS2488
    //（deerclaw 里也报，属既有问题）。注意必须用 `as` 而不是类型标注 ——
    // 带标注的 const 仍会按初始化表达式的**收窄类型**再收一次。
    const defaultTable = defaultObjectTable as Map<string, string> | null;
    if (defaultTable) {
      for (const [k, v] of defaultTable) fileTable.set(k, v);
    }
    for (const t of localConstTables) {
      if (exportedNames.has(t.name) || defaultExportName.get(R) === t.name) {
        for (const [k, v] of t.map) fileTable.set(k, v);
      }
    }
    if (fileTable.size) fileConstTables.set(R, fileTable);

    // .vue 模板里的组件引用（`<UserPicker/>` 或 `<user-picker/>`）
    if (src.template) {
      for (const [key, target] of varToFile) {
        if (!key.startsWith(`${R}::`)) continue;
        const local = key.slice(R.length + 2);
        if (!/^[A-Z]/.test(local)) continue;
        const re = new RegExp(`<(${local}|${toKebab(local)})[\\s/>]`);
        const m = re.exec(src.template);
        if (!m) continue;
        calls.push({
          fromFile: R,
          fromFn: '<template>',
          toObj: local,
          toMethod: '<jsx>',
          toFile: target,
          line: src.template.slice(0, m.index).split('\n').length,
          kind: 'jsx',
          // 模板是正则扫的（没有走 @vue/compiler-sfc 的 AST），可能误匹配注释里的标签
          tier: 'inferred',
        });
      }
    }
  }

  // 常量折叠：`APIS.KEY` → 字面量路径。必须等全部文件的常量表建完。
  for (const p of pendingApi) {
    const mod = varToFile.get(`${p.fromFile}::${p.objName}`);
    const pathStr = (mod && fileConstTables.get(mod)?.get(p.key)) || fileConstTables.get(p.fromFile)?.get(p.key);
    if (!pathStr || !pathStr.startsWith('/')) continue;
    calls.push({
      fromFile: p.fromFile,
      fromFn: p.fromFn,
      toObj: '@api',
      toMethod: `${p.verb} ${pathStr}`,
      toFile: null,
      line: p.line,
      kind: 'api',
      tier: 'extracted',
    });
  }

  // ── 回填反向依赖边与符号数 ──
  for (const m of modules.values()) {
    for (const dep of m.imports) {
      const target = modules.get(dep);
      if (target && !target.importedBy.includes(m.file)) target.importedBy.push(m.file);
    }
  }
  for (const f of functions) {
    const m = modules.get(f.file);
    if (m) m.symbolCount++;
  }

  /**
   * 折叠路由表的中间层。
   *
   * 真实前端仓的路由是**两跳**的：
   *   `router/index.ts` 里 `'ciam/app-management': LazyApplication`
   *     → `lazy-application.jsx` 里 `<Route path="/ciam/app-management" component={真实页面}/>`
   * 两跳都会被识别成同一个 urlPath 的路由，于是：
   *   ① analyzeImpact 的"受影响的页面数"翻倍（头条数字直接失真）
   *   ② traceRoute 用 `.find()` 取到第一条 —— 恰好是那个只指向另一个路由文件的包装层，
   *      链路停在 `withCheck()` 上，看不到真实页面（实测如此）
   * 判据：同路径下若已有一条 handler 指向**非路由注册文件**的，就丢掉包装层那条。
   */
  const registrarFiles = new Set(routes.map((r) => r.file));
  const byPath = new Map<string, RouteNode[]>();
  for (const r of routes) {
    const list = byPath.get(r.urlPath) ?? [];
    list.push(r);
    byPath.set(r.urlPath, list);
  }
  const finalRoutes = routes.filter((r) => {
    const peers = byPath.get(r.urlPath)!;
    if (peers.length < 2) return true;
    const isWrapper = !!r.handlerFile && registrarFiles.has(r.handlerFile);
    return !(
      isWrapper && peers.some((p) => p !== r && p.handlerFile && !registrarFiles.has(p.handlerFile))
    );
  });

  /**
   * 路由 handler 名回填。
   *
   * `lazy(() => import('@src/views/dashboard'))` 赋给 `OverViewPage`，
   * 但目标文件里的组件很可能叫 `Dashboard` —— 那样 traceRoute 的
   * `functions.find(f.file===handlerFile && f.name===handlerFn)` 会落空，整条链断掉。
   * 用目标文件的 default export 名回填，把这条链接上。
   */
  for (const r of finalRoutes) {
    if (!r.handlerFile) continue;
    const hit = functions.some((f) => f.file === r.handlerFile && f.name === r.handlerFn);
    if (hit) continue;
    const dft = defaultExportName.get(r.handlerFile);
    if (dft) r.handlerFn = dft;
  }

  // 转发层穿透一层：`export { default } from './List'` 或 `import List; export default List`
  for (const r of finalRoutes) {
    if (!r.handlerFile) continue;
    const bounced = defaultReexport.get(r.handlerFile);
    if (bounced) {
      r.handlerFile = bounced;
      const dft = defaultExportName.get(bounced);
      if (dft) r.handlerFn = dft;
      continue;
    }
    const imported = varToFile.get(`${r.handlerFile}::${r.handlerFn}`);
    if (imported && imported !== r.handlerFile) {
      r.handlerFile = imported;
      const dft = defaultExportName.get(imported);
      if (dft) r.handlerFn = dft;
    }
  }

  /**
   * 同目录 wrapper 再跟一层。saas-web 的 `/llmsgw/mcp-list` 实际是
   * `views/MCP/List/index.tsx` 渲染 `MCPListManage`（List.tsx）和介绍页。
   * 壳上常有 hook 调用，所以不能「看见 call 边就放弃」；同目录多个 JSX 时
   * 跟到**自己打了 service/@api** 的那一个。页面自己已经调 service 则不跟。
   */
  const isServiceLike = (file: string | null | undefined) =>
    !!file && /(?:^|\/)(?:services|api|consts)\//.test(file);
  const serviceScore = (file: string) =>
    calls.filter(
      (c) =>
        c.fromFile === file &&
        (c.toObj === '@api' || c.kind === 'api' || isServiceLike(c.toFile)),
    ).length;
  for (const r of finalRoutes) {
    if (!r.handlerFile || !r.handlerFn) continue;
    const target = functions.find((f) => f.file === r.handlerFile && f.name === r.handlerFn);
    if (!target) continue;
    const inner = calls.filter(
      (c) => c.fromFile === r.handlerFile && c.line >= target.line && c.line <= target.endLine && c.toFile,
    );
    if (inner.some((c) => c.toObj === '@api' || c.kind === 'api' || isServiceLike(c.toFile))) continue;
    const handlerDir = dirnameOf(r.handlerFile);
    const localJsx = inner.filter(
      (c) => c.kind === 'jsx' && c.toFile && c.toFile !== r.handlerFile && dirnameOf(c.toFile) === handlerDir,
    );
    const uniq = [...new Set(localJsx.map((c) => c.toFile!))];
    if (uniq.length === 0) continue;
    let next: string | null = null;
    if (uniq.length === 1) next = uniq[0];
    else {
      const ranked = uniq
        .map((f) => ({ f, n: serviceScore(f) }))
        .sort((a, b) => b.n - a.n);
      if (ranked[0].n > 0 && ranked[0].n !== ranked[1]?.n) next = ranked[0].f;
    }
    if (!next) continue;
    r.handlerFile = next;
    const tag = localJsx.find((c) => c.toFile === next)?.toObj;
    if (tag && tag !== '<jsx>') r.handlerFn = tag;
    else {
      const dft = defaultExportName.get(next);
      if (dft) r.handlerFn = dft;
    }
  }

  // ── 路由 → 下游追通率 ──
  let traced = 0;
  for (const r of finalRoutes) {
    if (!r.handlerFile) continue;
    const target = functions.find((f) => f.file === r.handlerFile && f.name === r.handlerFn);
    if (!target) continue;
    const inner = calls.filter(
      (c) => c.fromFile === r.handlerFile && c.line >= target.line && c.line <= target.endLine && c.toFile,
    );
    if (inner.length) traced++;
  }

  const buildMs = Date.now() - t0;
  const apiEdges = calls.filter((c) => c.toObj === '@api').length;

  /**
   * 本分析器**自述看不见什么**（CodeGraph.blindSpots）。
   *
   * 前三条是前端静态分析的固有边界，不是实现不到位：
   * 交叉验证过 —— 另一套 Java 图谱在 Spring `dispatch` 动态路由上踩到的是同一类问题
   * （运行时多态，AST 一定看不见）。所以这些必须随每次查询一起交给 agent，
   * 而不是指望它记得。第四条按本仓实际配置动态给。
   */
  const blindSpots = [
    '样式（.less/.css）的引用关系不入图 —— 组件"没有引用者"不代表删掉不会串样式',
    '动态引用不可见：`lazy(() => import(变量))`、`React.createElement(map[type])`、变量拼接或计算出来的路由',
    'i18n key 与埋点 key 的下游使用不可见',
  ];
  if (aliasSource === 'buildconfig') {
    blindSpots.push('路径别名是从构建配置正则提取的（非 tsconfig paths），可能不完整，依赖边可能有缺失');
  } else if (aliasSource === 'none') {
    blindSpots.push('未发现任何路径别名配置 —— 若该仓使用别名 import，依赖边会大面积缺失');
  }
  if (calls.some((c) => c.tier === 'inferred') || routes.some((r) => r.tier === 'inferred')) {
    blindSpots.push('部分边/路由由启发式推断得出（输出中标记为"推断"），可靠性低于 AST 直接提取的部分');
  }
  const apiContracts = extractApiContracts({ repoDir, functions, calls });
  const pageFingerprints = extractPageFingerprints({
    routes: finalRoutes,
    fileImports: fileImportNames,
    fileJsx: fileJsxTags,
  });

  logger.info(
    {
      repoDir,
      files: files.length,
      components: functions.filter((f) => f.form === 'component').length,
      routes: finalRoutes.length,
      apiEdges,
      contracts: apiContracts.length,
      buildMs,
    },
    'frontend graph built',
  );

  return {
    ok: true,
    repoDir,
    modules: [...modules.values()],
    classes,
    functions,
    calls,
    routes: finalRoutes,
    stats: {
      files: files.length,
      parseFailed,
      modules: modules.size,
      classes: classes.length,
      functions: functions.length,
      exportedFunctions: functions.filter((f) => f.exported).length,
      calls: calls.length,
      resolvedCalls: calls.filter((c) => c.toFile).length,
      routes: finalRoutes.length,
      routesTracedToService: traced,
      buildMs,
    },
    warnings,
    builtAt: Date.now(),
    analyzer: 'web-frontend',
    blindSpots,
    apiContracts,
    pageFingerprints,
    navigations,
  };
}

/**
 * 在 CallExpression 里找 `import('x')` 的字符串参数（`lazy(() => import('x'))` 形态）。
 *
 * **两种 AST 形态都要认**：babel 7 产出 `CallExpression{callee:Import}`，
 * babel 8 默认 `createImportExpressions` 产出 ESTree 的 `ImportExpression{source}`。
 * 本仓用的是 babel 8 —— 只认前者的话，页面组件全部解析不到文件，
 * 55 条路由里有 24 条 handlerFile 为 null，traceRoute 直接断链（实测）。
 */
function findDynamicImport(node: unknown): string | null {
  let found: string | null = null;
  const seen = new Set<unknown>();
  const dig = (n: unknown, depth: number) => {
    if (found || !n || typeof n !== 'object' || depth > 8 || seen.has(n)) return;
    seen.add(n);
    const o = n as {
      type?: string;
      callee?: { type?: string };
      arguments?: unknown[];
      source?: { type?: string; value?: string };
    };
    if (o.type === 'ImportExpression' && o.source?.type === 'StringLiteral' && o.source.value) {
      found = o.source.value;
      return;
    }
    if (o.type === 'CallExpression' && o.callee?.type === 'Import') {
      const arg = o.arguments?.[0] as { type?: string; value?: string } | undefined;
      if (arg?.type === 'StringLiteral' && arg.value) {
        found = arg.value;
        return;
      }
    }
    for (const v of Object.values(n as Record<string, unknown>)) {
      if (Array.isArray(v)) v.forEach((x) => dig(x, depth + 1));
      else if (v && typeof v === 'object') dig(v, depth + 1);
    }
  };
  dig(node, 0);
  return found;
}

/** 子树里有没有 JSX —— 用来区分"组件"与"普通工具函数" */
function containsJsx(node: unknown): boolean {
  let found = false;
  const seen = new Set<unknown>();
  const dig = (n: unknown, depth: number) => {
    if (found || !n || typeof n !== 'object' || depth > 12 || seen.has(n)) return;
    seen.add(n);
    const t = (n as { type?: string }).type;
    if (t === 'JSXElement' || t === 'JSXFragment') {
      found = true;
      return;
    }
    for (const v of Object.values(n as Record<string, unknown>)) {
      if (Array.isArray(v)) v.forEach((x) => dig(x, depth + 1));
      else if (v && typeof v === 'object') dig(v, depth + 1);
    }
  };
  dig(node, 0);
  return found;
}

function dirnameOf(file: string): string {
  const i = file.lastIndexOf('/');
  return i <= 0 ? '' : file.slice(0, i);
}

/** 导出对象里值为字符串字面量的项。不追 spread、不算函数、不猜动态 key。 */
function collectStringLiteralProps(obj: { properties?: unknown[] }): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of obj.properties ?? []) {
    const prop = raw as {
      type?: string;
      key?: { name?: string; value?: string };
      value?: {
        type?: string;
        value?: string;
        expressions?: unknown[];
        quasis?: Array<{ value?: { cooked?: string; raw?: string } }>;
      };
    };
    if (prop.type !== 'ObjectProperty') continue;
    const key = prop.key?.name ?? prop.key?.value;
    if (typeof key !== 'string' || !key) continue;
    const v = prop.value;
    if (v?.type === 'StringLiteral' && v.value) {
      out.set(key, v.value);
      continue;
    }
    if (v?.type === 'TemplateLiteral' && !(v.expressions && v.expressions.length)) {
      const cooked = v.quasis?.[0]?.value?.cooked ?? v.quasis?.[0]?.value?.raw ?? '';
      if (cooked) out.set(key, cooked);
    }
  }
  return out;
}

function isRequestCallee(callee: {
  type?: string;
  name?: string;
  property?: { name?: string };
} | undefined): boolean {
  if (!callee) return false;
  if (callee.type === 'MemberExpression') {
    const m = callee.property?.name;
    return !!m && REQUEST_METHODS.has(m);
  }
  if (callee.type === 'Identifier') return !!callee.name && REQUEST_FNS.has(callee.name);
  return false;
}

function extractRequestVerb(node: {
  callee?: { type?: string; name?: string; property?: { name?: string } };
  arguments?: Array<{ type?: string; properties?: unknown[] }>;
}): string | null {
  const callee = node.callee;
  let verb: string | null = null;
  if (callee?.type === 'MemberExpression') {
    const m = callee.property?.name;
    if (m && m !== 'fetch' && m !== 'request') verb = m.toUpperCase();
  }
  const opts = node.arguments?.[1];
  if (opts?.properties) {
    for (const raw of opts.properties) {
      const prop = raw as { key?: { name?: string }; value?: { type?: string; value?: string } };
      if (prop.key?.name === 'method' && prop.value?.type === 'StringLiteral' && prop.value.value) {
        return prop.value.value.toUpperCase();
      }
    }
  }
  return verb;
}

/**
 * 把一次调用识别成"打后端接口"，返回 `'POST /console/xxx'`，认不出返回 null。
 *
 * 认三种真实写法：
 *   requestV3.fetch('/console/x', { method: 'post' })   ← 自研 wrapper（最常见）
 *   axios.get('/api/x')                                  ← 方法名即 HTTP 方法
 *   request('/api/x', { method: 'PUT' })                 ← 裸函数
 * 判据要求**第一个参数是以 / 开头的静态路径** —— 这是"接口路径"与
 * 普通方法调用之间最可靠的分界。认字符串字面量，也认无插值的模板字面量
 * （`requestV3.fetch(\`/yApi/v1/app/X\`, …)`，saas-web 的真实写法）。
 * 拼接出来的动态路径（`\`${base}/x\``、`APIS[name]`）认不出时宁可放弃（不猜）。
 * `APIS.KEY` 这种静态成员由建图后的常量折叠补上，不在这里猜。
 */
/** 只收 pathname 字面量。变量 / 模板插值一律放弃。 */
function extractNavPath(arg: unknown): string | null {
  const n = arg as {
    type?: string;
    value?: string;
    expression?: unknown;
    properties?: Array<{ type?: string; key?: { name?: string }; value?: { type?: string; value?: string } }>;
  } | null;
  if (!n) return null;
  if (n.type === 'StringLiteral' && n.value && (n.value.startsWith('/') || n.value.includes('/'))) {
    return n.value.startsWith('/') ? n.value : `/${n.value}`;
  }
  if (n.type === 'ObjectExpression') {
    for (const p of n.properties ?? []) {
      if (p.type !== 'ObjectProperty' || p.key?.name !== 'pathname') continue;
      const v = p.value;
      if (v?.type === 'StringLiteral' && v.value) {
        return v.value.startsWith('/') ? v.value : `/${v.value}`;
      }
    }
  }
  return null;
}

function extractApiCall(node: {
  callee?: { type?: string; name?: string; object?: { name?: string }; property?: { name?: string } };
  arguments?: Array<{
    type?: string;
    value?: string;
    properties?: unknown[];
    expressions?: unknown[];
    quasis?: Array<{ value?: { cooked?: string; raw?: string } }>;
  }>;
}): string | null {
  const first = node.arguments?.[0];
  let pathStr: string | null = null;
  if (first?.type === 'StringLiteral' && first.value?.startsWith('/')) {
    pathStr = first.value;
  } else if (first?.type === 'TemplateLiteral' && !(first.expressions && first.expressions.length)) {
    const cooked = first.quasis?.[0]?.value?.cooked ?? first.quasis?.[0]?.value?.raw ?? '';
    if (cooked.startsWith('/')) pathStr = cooked;
  }
  if (!pathStr) return null;

  const callee = node.callee;
  let verb: string | null = null;
  if (callee?.type === 'MemberExpression') {
    const m = callee.property?.name;
    if (!m || !REQUEST_METHODS.has(m)) return null;
    verb = m === 'fetch' || m === 'request' ? null : m.toUpperCase();
  } else if (callee?.type === 'Identifier') {
    if (!callee.name || !REQUEST_FNS.has(callee.name)) return null;
  } else {
    return null;
  }

  // options 里的 method 优先（wrapper 形态的真实动词在这里）
  const opts = node.arguments?.[1];
  if (opts?.properties) {
    for (const raw of opts.properties) {
      const prop = raw as { type?: string; key?: { name?: string }; value?: { type?: string; value?: string } };
      if (prop.key?.name === 'method' && prop.value?.type === 'StringLiteral' && prop.value.value) {
        verb = prop.value.value.toUpperCase();
        break;
      }
    }
  }
  return `${verb ?? 'ANY'} ${pathStr}`;
}

// ══════════════════ ④ 探测 ══════════════════

/**
 * 探测纯前端仓。
 *
 * 与 node-babel 的分工靠**分数**而非顺序（registry 按置信度排序择优）：
 *   纯前端仓  → 这里 0.95，node-babel 0.7   → 我们赢
 *   koa 后端  → 这里 0，   node-babel 0.95  → 它赢
 *   全栈仓    → 这里 0.5，node-babel 0.95  → 它赢，但两者都过阈值，
 *               菜单里会同时列出让人工指定（这正是 DetectResult 用置信度而非 boolean 的理由）
 */
async function detectFrontend(repoPath: string): Promise<DetectResult> {
  const pkgPath = path.join(repoPath, 'package.json');
  let deps: Record<string, string> = {};
  let hasPkg = false;
  try {
    if (fs.existsSync(pkgPath)) {
      hasPkg = true;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      deps = { ...pkg.dependencies, ...pkg.devDependencies };
    }
  } catch {
    /* package.json 坏了退回按文件后缀判断 */
  }

  if (hasPkg) {
    const fe = FRONTEND_DEPS.filter((k) => k in deps);
    const server = SERVER_DEPS.filter((k) => k in deps);
    if (fe.length && server.length) {
      return {
        confidence: 0.5,
        reason: `同时含前端(${fe.join('/')})与服务端(${server.join('/')})依赖，疑似全栈仓，建议人工指定分析器`,
      };
    }
    if (fe.length) {
      const build = BUILD_DEPS.filter((k) => k in deps);
      return build.length
        ? { confidence: 0.95, reason: `package.json 含 ${fe.join(' / ')} + 构建工具 ${build.join(' / ')}，页面路由与接口调用可识别` }
        : { confidence: 0.9, reason: `package.json 含 ${fe.join(' / ')}，可建组件依赖图` };
    }
    if (server.length) return { confidence: 0, reason: `含服务端框架 ${server.join(' / ')}，应由后端分析器处理` };
  }

  // 无 package.json 或未声明框架：看有没有 .vue/.tsx/.jsx
  try {
    const uiFiles = walk(repoPath).filter((f) => /\.(vue|tsx|jsx)$/.test(f));
    if (uiFiles.length >= 5) {
      return { confidence: 0.6, reason: `未在依赖里识别前端框架，但发现 ${uiFiles.length} 个 .vue/.tsx/.jsx 文件` };
    }
  } catch {
    /* 目录不可读 → 0 分 */
  }
  return { confidence: 0, reason: '未发现前端框架依赖或 .vue/.tsx/.jsx 文件' };
}

export const webFrontendAnalyzer: GraphAnalyzer = {
  name: 'web-frontend',
  label: '前端（React / Vue）',
  language: 'javascript',
  frameworks: ['react', 'vue', 'react-router', 'vue-router'],
  extensions: CODE_EXTS,
  detect: detectFrontend,
  // 与 node-babel 同理：Babel 解析是同步 CPU 操作，包 Promise 只为满足契约
  analyze: (repoPath: string) => Promise.resolve(buildFrontendGraph(repoPath)),
};
