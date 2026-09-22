/**
 * 代码图谱 —— **查图**能力（影响范围 / 热点 / 路由追踪）与对外门面。
 *
 * ── 本文件在 ADR-051 后的定位 ──
 * 建图逻辑已搬到 analyzers/ 下成为可插拔的 GraphAnalyzer，
 * 原因是它把「遍历(6 个 JS 扩展名) + Babel 解析 + koa 路由识别」焊死在一起，
 * 导致 Java/Go/Python 仓库进来得到一张**空图且不报错**。
 *
 * 留在这里的三个函数（analyzeImpact / hotSpots / traceRoute）**与语言完全无关** ——
 * 它们只依赖 CodeGraph 数据结构。这正是"新增一种语言不用改查图代码"的全部前提，
 * 所以它们不该被拆进任何分析器。
 *
 * ── 为什么保留 buildGraph 这个导出 ──
 * repo-policy-service、query-code-graph-tool 与 1259 个测试都在用它。
 * 门面转发到 node-babel 分析器，**签名与行为完全不变**（同步、同参、同返回）。
 * 需要自动选分析器时用 registry.ts 的 buildGraphAuto()。
 *
 * ── 图谱与红线的本质区别（决定了存储策略）──
 * 图谱是**代码的一个投影**，删了重跑索引结果一模一样 → 可随时丢弃、放平台缓存、不进 git。
 * 红线是**人写的意图**，代码里根本不存在（"外部仍有调用方"推不出来）→ 丢了永久损失。
 *
 * ── 图谱对红线的价值（不只是让 agent 读懂代码）──
 * 它是唯一能让红线**自我体检**的机制：
 *   ① 存活性 —— protects 的符号还在吗（不在 = 红线在守空气）
 *   ② 覆盖度 —— paths 覆盖了符号的全部出现位置吗（没覆盖 = 后门）
 *   ③ evidence 行号自动重定位
 * 没有它，红线只会单向腐烂。
 */

// 类型集中在 types.ts（跨语言中立层）。这里 re-export 是为了让
// `import { CodeGraph } from './graph-builder.js'` 这种既有写法继续可用 ——
// 8 处调用方不必因为纯重构而改 import 路径。
export type {
  ModuleNode,
  ClassNode,
  FunctionNode,
  CallEdge,
  RouteNode,
  CodeGraph,
  ApiContract,
  ApiField,
  PageFingerprint,
  PageTag,
  NavigationEdge,
  FieldNode,
  LiteralRef,
} from './types.js';
// re-export 只对外可见、不产生本地绑定 —— 本文件自己用到的类型必须单独 import
import type {
  ApiContract,
  CodeGraph,
  FieldNode,
  LiteralRef,
  NavigationEdge,
  PageFingerprint,
  PageTag,
  RouteNode,
} from './types.js';

import { buildNodeGraph } from './analyzers/node-babel.js';

/**
 * 构建代码图谱（JS/TS）。门面 —— 实现在 analyzers/node-babel.ts。
 *
 * 保持同步签名不是偷懒：Babel 解析本身是同步 CPU 操作，包成 Promise 只会让
 * 调用方误以为它是并发的。要自动选分析器（含 Python/Java）走 buildGraphAuto()。
 */
export function buildGraph(repoDir: string): CodeGraph {
  return buildNodeGraph(repoDir);
}

// ══════════ 影响范围反查 ══════════

/**
 * 边权重 —— 影响面按耦合强度加权，而不是布尔可达。
 *
 * ── 为什么需要 ──
 * 无权 BFS 下"页面直接渲染了这个组件"和"只是 import 了它导出的一个类型"
 * 完全等价，于是 impact 报出的"22 个页面"里强弱混在一起，
 * agent 拿到后不知道该重点回归哪几个 —— 数字大反而降低了可操作性。
 *
 * 数值取自"这条边意味着运行时真的会走到吗"：
 * 调用/渲染是必然（1.0），继承是结构耦合（0.9），
 * 打外部接口只说明契约相关（0.6），仅 import 未必真用（0.5）。
 */
export const EDGE_WEIGHTS: Record<string, number> = {
  call: 1.0,
  jsx: 1.0,
  inherit: 0.9,
  api: 0.6,
  /** 模块 import 边（ModuleNode.imports），没有对应的 EdgeKind，单列 */
  import: 0.5,
};
/** 每跳衰减。三跳之外的弱耦合自然沉底，但**不删除**（见 analyzeImpact 的说明） */
const DEPTH_DECAY = 0.6;
/** 分数 ≥ 此值算"强影响"：直接调用/渲染（1.0×0.6=0.6）过线，两跳 import（0.15）不过 */
export const STRONG_IMPACT_THRESHOLD = 0.5;

export interface ImpactResult {
  /** 目标 */
  target: { file: string; symbol?: string };
  /** 直接调用它的位置 */
  directCallers: Array<{ file: string; fn: string; line: number }>;
  /**
   * 受影响的对外接口（影响范围的终点，最能说明后果）。
   * `score` 是耦合强度（0-1，越大越可能真受影响），已按降序排列。
   */
  affectedRoutes: Array<{ method: string; urlPath: string; score: number }>;
  /** 其中 score ≥ STRONG_IMPACT_THRESHOLD 的条数 —— 让"必须回归"与"扫一眼"分开 */
  strongRouteCount: number;
  /** 依赖该文件的模块（模块级传播） */
  dependentModules: string[];
  /** 传播层数（BFS 深度） */
  depth: number;
  /**
   * 字段级查询时为 'field'：此时 **不要** 把 affectedRoutes 当头条。
   * 缺省 / 'function' / 'file' = 沿用模块 BFS。
   */
  kind?: 'function' | 'field' | 'file';
  field?: FieldNode;
  literalHits?: LiteralRef[];
  warnings?: string[];
}

/**
 * 反向加权传播：从目标出发，沿"谁依赖我"的方向算每个文件的耦合分。
 *
 * **只加分，不裁剪** —— 刻意不设下限阈值把弱影响踢出结果集。
 * 裁剪会让 impact 漏报，而漏报正是我们一直在防的那个失败模式
 * （agent 把"没查到"当成"没影响"）。分数只用于排序与强弱标注。
 */
function propagate(graph: CodeGraph, targetFile: string, maxDepth: number): Map<string, number> {
  /** 反向邻接：file → [{to: 依赖它的文件, w: 边权}] */
  const rev = new Map<string, Array<{ to: string; w: number }>>();
  const push = (from: string, to: string, w: number) => {
    const list = rev.get(from) ?? [];
    list.push({ to, w });
    rev.set(from, list);
  };
  // 全程 `?? []`：图谱是从 DB 里 `as CodeGraph` 强转出来的，历史行与残缺行都可能缺字段。
  // 既有的 analyzeImpact 一直是这个姿势（`?? []`），这里必须保持一致 ——
  // 查图代码在脏数据上抛异常会直接打断 ReAct，比给不出答案更糟。
  for (const m of graph.modules ?? []) {
    for (const dep of m.imports ?? []) push(dep, m.file, EDGE_WEIGHTS.import);
  }
  for (const c of graph.calls ?? []) {
    if (!c.toFile) continue;
    push(c.toFile, c.fromFile, EDGE_WEIGHTS[c.kind ?? 'call'] ?? EDGE_WEIGHTS.call);
  }

  const score = new Map<string, number>([[targetFile, 1]]);
  let frontier = [targetFile];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next: string[] = [];
    for (const f of frontier) {
      const base = score.get(f) ?? 0;
      for (const { to, w } of rev.get(f) ?? []) {
        const cand = base * w * DEPTH_DECAY;
        // 取各路径中的最大分：同一个文件可能既直接调用又间接 import，按最强的那条算
        if (cand > (score.get(to) ?? 0)) {
          score.set(to, cand);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  score.delete(targetFile);
  return score;
}

const FIELD_MONGO_WARNING =
  'MongoDB 字段名写在 bson tag 里。改 tag 需评估存量 `$rename`，否则已有文档会静默读空。同时核对 template/ 下已下发 SDK。当前弱边标 inferred，请再用 grep 核 filter["..."]。';

function enclosingFn(graph: CodeGraph, file: string, line: number): string {
  const hits = (graph.functions ?? []).filter(
    (f) => f.file === file && f.line <= line && line <= f.endLine,
  );
  return hits.sort((a, b) => a.line - b.line).pop()?.name ?? '<top>';
}

/** 字段级 impact：不走模块 BFS，避免 dto 文件被扩成几乎全部接口。 */
function analyzeFieldImpact(
  graph: CodeGraph,
  targetFile: string,
  symbol: string,
  fieldHits: FieldNode[],
  result: ImpactResult,
): ImpactResult {
  const field = fieldHits[0];
  const tagVals = new Set(fieldHits.flatMap((f) => Object.values(f.tags)));
  const refs = graph.literalRefs ?? [];
  const dots = refs.filter((r) => r.via === 'dot' && r.value === symbol);
  const strings = refs.filter(
    (r) => (r.via === 'string' || r.via === 'tag') && tagVals.has(r.value),
  );
  const callers = dots
    .filter((r) => !(r.file === targetFile && fieldHits.some((f) => f.line === r.line)))
    .map((r) => ({ file: r.file, fn: enclosingFn(graph, r.file, r.line), line: r.line }));
  const dep = new Set<string>();
  for (const c of callers) if (c.file !== targetFile) dep.add(c.file);
  for (const s of strings) if (s.file !== targetFile) dep.add(s.file);
  result.kind = 'field';
  result.field = field;
  result.directCallers = callers;
  result.dependentModules = [...dep].sort();
  result.depth = 0;
  result.affectedRoutes = [];
  result.strongRouteCount = 0;
  result.literalHits = strings;
  result.warnings = [FIELD_MONGO_WARNING];
  return result;
}

/**
 * 反查影响范围：改这个东西，会波及什么。
 *
 * 这是图谱**对 agent 最有用**的能力 —— 把事后拦截升级为事前预警：
 * agent 动手前就知道"你要改的这个函数影响 148 个对外接口"，
 * 于是它带着约束去设计方案，而不是撞墙后返工。
 *
 * 实测（anxin-console-server）：
 *   validate.js#check ← 155 个路由依赖，改它影响 148 个对外接口
 */
export function analyzeImpact(
  graph: CodeGraph,
  targetFile: string,
  symbol?: string,
  maxDepth = 3,
): ImpactResult {
  const result: ImpactResult = {
    target: { file: targetFile, symbol },
    directCallers: [],
    affectedRoutes: [],
    strongRouteCount: 0,
    dependentModules: [],
    depth: 0,
  };
  if (!graph.ok) return result;

  const fnHit = symbol
    ? (graph.functions ?? []).some((f) => f.file === targetFile && f.name === symbol)
    : false;
  const fieldHits = symbol
    ? (graph.fields ?? []).filter((f) => f.file === targetFile && f.name === symbol)
    : [];
  if (symbol && !fnHit && fieldHits.length) {
    return analyzeFieldImpact(graph, targetFile, symbol, fieldHits, result);
  }

  // 1. 直接调用者
  result.directCallers = graph.calls
    .filter((c) => c.toFile === targetFile && (!symbol || c.toMethod === symbol))
    .map((c) => ({ file: c.fromFile, fn: c.fromFn, line: c.line }));

  // 2. 模块级传播（BFS）——谁 import 了它，谁又 import 了那些
  const modByFile = new Map(graph.modules.map((m) => [m.file, m]));
  const seen = new Set<string>([targetFile]);
  let frontier = [targetFile];
  let depth = 0;
  while (frontier.length && depth < maxDepth) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const dep of modByFile.get(f)?.importedBy ?? []) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        next.push(dep);
      }
    }
    frontier = next;
    if (next.length) depth++;
  }
  seen.delete(targetFile);
  result.dependentModules = [...seen].sort();
  result.depth = depth;

  // 3. 受影响的对外接口：路由 handler 所在文件在传播集里，或直接调用了目标
  //    命中判据与加权前完全一致 —— 分数只用于排序与强弱标注，不改变谁进结果集
  const scores = propagate(graph, targetFile, maxDepth);
  const affected = new Map<string, number>();
  for (const r of graph.routes) {
    if (!r.handlerFile) continue;
    const hitByModule = r.handlerFile === targetFile || seen.has(r.handlerFile);
    let hitByCall = false;
    if (!hitByModule) {
      const target = graph.functions.find((f) => f.file === r.handlerFile && f.name === r.handlerFn);
      if (target) {
        hitByCall = graph.calls.some(
          (c) =>
            c.fromFile === r.handlerFile &&
            c.line >= target.line &&
            c.line <= target.endLine &&
            c.toFile === targetFile &&
            (!symbol || c.toMethod === symbol),
        );
      }
    }
    if (!hitByModule && !hitByCall) continue;
    // handler 就是目标文件本身 → 满分；否则取传播分。命中但无分（只经 hitByCall
    // 这条不在传播图上的路径）给一个刚好过强影响线的分，因为"handler 直接调了它"
    const key = `${r.method} ${r.urlPath}`;
    const s = r.handlerFile === targetFile ? 1 : (scores.get(r.handlerFile) ?? (hitByCall ? 0.6 : 0.1));
    if (s > (affected.get(key) ?? 0)) affected.set(key, s);
  }
  result.affectedRoutes = [...affected.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([s, score]) => {
      const sp = s.indexOf(' ');
      return { method: s.slice(0, sp), urlPath: s.slice(sp + 1), score: Math.round(score * 100) / 100 };
    });
  result.strongRouteCount = result.affectedRoutes.filter((r) => r.score >= STRONG_IMPACT_THRESHOLD).length;

  return result;
}

/** 找出被最多路由依赖的 service 方法 —— 「碰它要格外小心」的清单 */
export function hotSpots(
  graph: CodeGraph,
  limit = 10,
): Array<{ file: string; method: string; routeCount: number }> {
  if (!graph.ok) return [];
  const counter = new Map<string, number>();
  for (const r of graph.routes) {
    if (!r.handlerFile) continue;
    const target = graph.functions.find((f) => f.file === r.handlerFile && f.name === r.handlerFn);
    if (!target) continue;
    const inner = graph.calls.filter(
      (c) => c.fromFile === r.handlerFile && c.line >= target.line && c.line <= target.endLine && c.toFile,
    );
    for (const k of new Set(inner.map((c) => `${c.toFile}#${c.toMethod}`))) {
      counter.set(k, (counter.get(k) ?? 0) + 1);
    }
  }
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, n]) => {
      const i = k.lastIndexOf('#');
      return { file: k.slice(0, i), method: k.slice(i + 1), routeCount: n };
    });
}

const SOURCE_FILE_RE = /\.(?:go|ts|tsx|js|jsx|mjs|cjs|py|java|kt|vue)$/i;
const HTTP_METHOD_PREFIX = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|PAGE)\s+/i;
const ACTION_VERB_PREFIX =
  /^(Describe|Create|Modify|Delete|Download|Update|Get|List|Add|Remove|Put|Post|Query|Search|Bind|Unbind|Enable|Disable)[A-Z]/;

/** trace 缺 urlPath 时的报错。保留「必须提供 urlPath」前缀，兼容既有断言与治理夹具。 */
export const TRACE_URLPATH_REQUIRED =
  'action=trace 时必须提供 urlPath（接口路径或 Action 名，如 /CreateAgent 或 DescribeAIMUserGroups）。把 Action 写进 symbol 也会认。';

/**
 * 从工具实参里抽出 trace 的目标路径。
 *
 * 线上 ses_665e 后端专家两次都把 Action 写进 `symbol` 而不是 `urlPath`，
 * 旧实现直接报「必须提供 urlPath」，门要的查图一步作废。ADR-053 第 5 章
 * 也记过同一形态。这里按 similar 的降级思路：认对了 ident 就查，不因字段名卡死。
 *
 * 优先级：urlPath → url_path / path → symbol（非源文件）→ file / intent（像路由/Action 才认）。
 */
export function resolveTraceUrlPath(params: Record<string, unknown>): string | undefined {
  const take = (k: string): string => {
    const v = params[k];
    return typeof v === 'string' && v.trim() ? v.trim() : '';
  };
  for (const k of ['urlPath', 'url_path', 'path'] as const) {
    const v = take(k);
    if (v) return v;
  }
  const symbol = take('symbol');
  if (symbol && !SOURCE_FILE_RE.test(symbol)) return symbol;
  for (const k of ['file', 'intent'] as const) {
    const v = take(k);
    if (v && looksLikeTraceTarget(v)) return v;
  }
  return undefined;
}

function looksLikeTraceTarget(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 300 || /\s/.test(t)) return false;
  if (SOURCE_FILE_RE.test(t)) return false;
  if (t.startsWith('/')) return true;
  if (ACTION_VERB_PREFIX.test(t)) return true;
  return /^[A-Za-z][A-Za-z0-9_-]{2,80}$/.test(t);
}

function stripRouteKey(p: string): string {
  return p.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function lastSegment(p: string): string {
  const k = stripRouteKey(p);
  const i = k.lastIndexOf('/');
  return i >= 0 ? k.slice(i + 1) : k;
}

function isActionLikeSegment(s: string): boolean {
  if (s.length < 3) return false;
  if (/^v\d+$/i.test(s)) return false;
  if (/^(api|console|admin|internal)$/i.test(s)) return false;
  return /[A-Za-z]/.test(s);
}

function pickRoute(routes: RouteNode[]): RouteNode | null {
  if (routes.length === 0) return null;
  if (routes.length === 1) return routes[0]!;
  const extracted = routes.filter((r) => (r.tier ?? 'extracted') === 'extracted');
  const pool = extracted.length > 0 ? extracted : routes;
  return (
    pool
      .slice()
      .sort((a, b) => a.urlPath.length - b.urlPath.length || a.urlPath.localeCompare(b.urlPath))[0] ?? null
  );
}

/**
 * 按查询串找路由。模型经常给 Action 名（`DescribeX`）而图里是 `/DescribeX`
 * 或 `/api/v1/DescribeX` —— 精确相等会让选图命中、trace 却说没有。
 *
 * 匹配顺序：精确 → 忽略首尾 / 与大小写 → 末段（Action 名）相等。
 * 不用 includes：`DescribeAIM` 不得误中 `DescribeAIMAgent`。
 */
export function findRoute(graph: CodeGraph, urlPath: string): RouteNode | null {
  const routes = graph.routes ?? [];
  const raw = (urlPath ?? '').trim().replace(HTTP_METHOD_PREFIX, '').trim();
  if (!raw || routes.length === 0) return null;

  const exact = routes.find((r) => r.urlPath === raw);
  if (exact) return exact;

  const key = stripRouteKey(raw).toLowerCase();
  if (!key) return null;
  const ci = routes.filter((r) => stripRouteKey(r.urlPath).toLowerCase() === key);
  const hit = pickRoute(ci);
  if (hit) return hit;

  const seg = lastSegment(raw);
  if (!isActionLikeSegment(seg)) return null;
  const bySeg = routes.filter((r) => lastSegment(r.urlPath).toLowerCase() === seg.toLowerCase());
  return pickRoute(bySeg);
}

/**
 * 取一条完整调用链：路由 → 中间件 → controller → services（→ 外部接口）。
 *
 * `apiCalls` 是为前端图加的，但**保持语言中立**：它收的是 `toObj === '@api'` 的边
 * （见 CallEdge 的约定），后端图不产出这类边，返回空数组，行为不变。
 *
 * 为什么必须两跳：前端的真实结构是 `页面组件 → services/x.ts → requestV3.fetch('/y')`，
 * 接口路径落在 service 文件里而不是页面里。只收一跳的话，agent 查完 trace
 * 仍然不知道这个页面打的是哪个后端接口 —— 而"改接口时对齐契约"正是它最该拿到的信息。
 */
export function traceRoute(
  graph: CodeGraph,
  urlPath: string,
): {
  route: RouteNode | null;
  controller: { file: string; fn: string; line: number } | null;
  services: Array<{ file: string; method: string; line: number }>;
  /** 这条链最终打到的外部 HTTP 接口，如 'POST /console/admin/resources/query' */
  apiCalls: string[];
  /** 本条链打到的接口的调用点契约。后端图或未提取时为空数组。 */
  contracts: ApiContract[];
  /** 字面量跳转到本页的入口。后端图或未提取时为空数组。 */
  inbounds: NavigationEdge[];
} {
  const empty = {
    controller: null,
    services: [] as Array<{ file: string; method: string; line: number }>,
    apiCalls: [] as string[],
    contracts: [] as ApiContract[],
    inbounds: [] as NavigationEdge[],
  };
  const route = findRoute(graph, urlPath);
  if (!route?.handlerFile) return { route, ...empty };
  const target = graph.functions.find((f) => f.file === route.handlerFile && f.name === route.handlerFn);
  if (!target) return { route, ...empty };
  const services = graph.calls
    .filter(
      (c) => c.fromFile === route.handlerFile && c.line >= target.line && c.line <= target.endLine && c.toFile,
    )
    .map((c) => ({ file: c.toFile!, method: c.toMethod, line: c.line }));
  // 去重：同一个 service#method 在一个 controller 里可能被调多次
  const uniq = new Map(services.map((s) => [`${s.file}#${s.method}`, s]));

  // handler 自己 + 它调用的文件里的外部接口边
  const reach = new Set<string>([route.handlerFile, ...[...uniq.values()].map((s) => s.file)]);
  const apiCalls = [
    ...new Set(
      graph.calls.filter((c) => c.toObj === '@api' && reach.has(c.fromFile)).map((c) => c.toMethod),
    ),
  ].sort();

  const contracts = (graph.apiContracts ?? []).filter((c) => apiCalls.includes(c.api));
  const want = route.urlPath;
  const inbounds = (graph.navigations ?? []).filter((n) => n.toPath === want);

  return {
    route,
    controller: { file: route.handlerFile, fn: route.handlerFn, line: target.line },
    services: [...uniq.values()],
    apiCalls,
    contracts,
    inbounds,
  };
}

export interface SimilarPageHit {
  file: string;
  urlPath?: string;
  score: number;
  tags: PageTag[];
  /** 写法与主流不一致时给出理由与替代，不编造不存在的组件 */
  discouraged?: { reason: string; instead?: string };
}

export interface SimilarPagesResult {
  query: { intent?: string; file?: string };
  skeleton: { imports: string[]; jsx: string[]; tags: PageTag[] };
  hits: SimilarPageHit[];
  /**
   * 命中是靠 file 的结构相似还是靠 intent 的语义匹配。
   * 纯派生、不落库、不进 GraphQueryPayload —— 渲染层靠它说明「你给的 file 不在图谱，已降级」。
   */
  matchedBy?: 'file' | 'intent';
  unmatchedReason?: string;
}

const INTENT_TAG: Array<{ re: RegExp; tag: PageTag }> = [
  { re: /分页|翻页|pagination|pagesize|pageSize/i, tag: 'pagination' },
  { re: /搜索|筛选|检索|keyword|search/i, tag: 'search' },
  { re: /列表|管理页|list|manage/i, tag: 'list' },
  { re: /表格|table/i, tag: 'table' },
  { re: /表单|form/i, tag: 'form' },
  { re: /弹窗|抽屉|modal|drawer/i, tag: 'modal' },
  { re: /详情|编辑页|detail|edit/i, tag: 'detail' },
];

function tagsFromIntent(intent: string): PageTag[] {
  const tags: PageTag[] = [];
  for (const { re, tag } of INTENT_TAG) {
    if (re.test(intent)) tags.push(tag);
  }
  return [...new Set(tags)];
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function fpKeySet(fp: PageFingerprint): Set<string> {
  return new Set([...fp.imports, ...fp.jsx, ...fp.tags]);
}

/** file → 指纹的唯一匹配规则（精确优先，再退后缀）。渲染层要复用请 import，别抄一遍。 */
export function findPageFingerprint(
  fps: PageFingerprint[],
  file: string,
): PageFingerprint | undefined {
  const key = file.trim();
  if (!key) return undefined;
  return fps.find((f) => f.file === key) ?? fps.find((f) => f.file.endsWith(key));
}

type ScoredFp = Array<{ fp: PageFingerprint; score: number }>;

/** 拿一条已有指纹当模板，按 imports/jsx/tags 的 Jaccard 找结构最像的。 */
function scoreByFingerprint(fps: PageFingerprint[], target: PageFingerprint): ScoredFp {
  const tset = fpKeySet(target);
  return fps
    .filter((f) => f.file !== target.file)
    .map((fp) => ({ fp, score: jaccard(tset, fpKeySet(fp)) }))
    .filter((x) => x.score > 0);
}

/** 拿一句任务描述找同类。识别不出页面类型就返回 []，由调用方决定文案。 */
function scoreByIntent(fps: PageFingerprint[], intent: string): ScoredFp {
  const tags = tagsFromIntent(intent);
  const tokens = intent
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2);
  if (tags.length === 0 && tokens.length === 0) return [];
  return fps
    .map((fp) => {
      const tagHit = tags.filter((t) => fp.tags.includes(t)).length;
      const hay = [...fp.imports, ...fp.jsx].map((x) => x.toLowerCase());
      const tokHit = tokens.filter((t) => hay.some((h) => h.includes(t))).length;
      return { fp, score: tagHit * 2 + tokHit * 0.3 };
    })
    .filter((x) => x.score > 0);
}

/**
 * 两条路都没走通时的文案。要讲清是哪条断了，别让模型以为图谱是空的。
 */
function unmatchedSimilarReason(
  file: string | undefined,
  fileHit: boolean,
  intent: string | undefined,
): string {
  const missFile =
    file && !fileHit
      ? `图谱里没有 \`${file}\` 这条页面指纹（如果这是你正要新建的文件，属正常）。`
      : '';
  if (intent) {
    return (
      missFile +
      `按 intent「${intent}」也没找到同类页面：无法从这句话识别页面类型。` +
      '请把 intent 写具体（列表/表单/详情/弹窗 + 关键组件名），或把 file 换成一个**已存在**的同类页面。'
    );
  }
  if (missFile) return missFile + '请补 intent=<任务描述>，或把 file 换成一个已存在的同类页面。';
  return '无法从这句话识别页面类型，请改用 file=某个现有页面。';
}

/**
 * 找仓内同类页面。hot 回答「别改我」；本函数回答「照这个做」。
 *
 * file 与 intent 是**优先级**关系而非排他：file 命中就按结构相似找，
 * 未命中（复用门的场景里 file 恒是"正要新建的文件"，必然不在图谱）则降级按 intent 语义找。
 * 两条都不通才算未命中。匹配不上不退回 hot。
 */
export function similarPages(
  graph: CodeGraph,
  query: { intent?: string; file?: string; limit?: number },
): SimilarPagesResult {
  const limit = Math.min(Math.max(query.limit ?? 3, 1), 5);
  const fps = graph.pageFingerprints ?? [];
  const emptySkel = { imports: [] as string[], jsx: [] as string[], tags: [] as PageTag[] };
  if (fps.length === 0) {
    return {
      query,
      skeleton: emptySkel,
      hits: [],
      unmatchedReason: '本图谱没有页面指纹（分析器未产出），无法找相似实现。',
    };
  }

  const wantFile = query.file?.trim();
  const wantIntent = query.intent?.trim();
  if (!wantFile && !wantIntent) {
    return {
      query,
      skeleton: emptySkel,
      hits: [],
      unmatchedReason: 'action=similar 需要 intent 或 file。',
    };
  }

  const target = wantFile ? findPageFingerprint(fps, wantFile) : undefined;
  let matchedBy: 'file' | 'intent' | undefined;
  let scored: ScoredFp = [];
  if (target) {
    scored = scoreByFingerprint(fps, target);
    if (scored.length > 0) matchedBy = 'file';
  }
  // file 没给、没命中、或命中了但结构上没有一条能对上 —— 都降级按 intent 再找一轮
  if (scored.length === 0 && wantIntent) {
    scored = scoreByIntent(fps, wantIntent);
    if (scored.length > 0) matchedBy = 'intent';
  }
  if (scored.length === 0) {
    return {
      query,
      skeleton: emptySkel,
      hits: [],
      unmatchedReason: unmatchedSimilarReason(wantFile, Boolean(target), wantIntent),
    };
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const sharedA = a.fp.imports.length + a.fp.jsx.length;
    const sharedB = b.fp.imports.length + b.fp.jsx.length;
    return sharedB - sharedA;
  });
  const hits: SimilarPageHit[] = scored.slice(0, limit).map((x) => ({
    file: x.fp.file,
    urlPath: x.fp.urlPath,
    score: Math.round(x.score * 100) / 100,
    tags: x.fp.tags,
  }));
  const sample = hits.map((h) => fps.find((f) => f.file === h.file)!).filter(Boolean);
  const inter = (pick: (f: PageFingerprint) => string[]) => {
    if (sample.length === 0) return [];
    return pick(sample[0]).filter((x) => sample.every((s) => pick(s).includes(x)));
  };
  const skeleton = {
    imports: inter((f) => f.imports),
    jsx: inter((f) => f.jsx),
    tags: inter((f) => f.tags) as PageTag[],
  };
  const skelSet = new Set([...skeleton.imports, ...skeleton.jsx]);
  for (const h of hits) {
    const fp = fps.find((f) => f.file === h.file);
    if (!fp) continue;
    const extras = [...fp.imports, ...fp.jsx].filter((x) => !skelSet.has(x));
    const rare = extras
      .map((x) => ({ x, n: symbolFanIn(graph, x), file: resolveSymbolFile(graph, x) }))
      .filter((x) => x.n > 0 && x.n <= 8 && isPublicLayerFile(x.file))
      .sort((a, b) => a.n - b.n)[0];
    if (!rare) continue;
    const popular = [...new Set(sample.flatMap((s) => [...s.imports, ...s.jsx]))]
      .map((x) => ({ x, n: symbolFanIn(graph, x), file: resolveSymbolFile(graph, x) }))
      .filter(
        (p) =>
          p.x !== rare.x &&
          p.n > rare.n &&
          (p.n >= rare.n * 3 || p.n >= 10 || fps.length < 20) &&
          !isFrameworkImport(p.x) &&
          !isViewsFile(p.file),
      )
      .sort((a, b) => b.n - a.n)[0];
    if (!popular) continue;
    h.discouraged = {
      reason: `使用 ${rare.x}，仓内仅 ${rare.n} 处；主流为 ${popular.x}`,
      instead: popular.x,
    };
  }
  // 宁缺勿错：推荐组被掏空时撤回分组，不要把范例整批打成反例
  if (hits.length > 0 && hits.every((h) => h.discouraged)) {
    for (const h of hits) h.discouraged = undefined;
  }
  return { query, skeleton, hits, matchedBy };
}

/** 共享实现层。views / services / api 扇入低是页面边界，不是写法问题。 */
const PUBLIC_LAYER_RE = /(?:^|\/)src\/(components|hooks|utils)\//;
const VIEWS_RE = /(?:^|\/)src\/views\//;
const FRAMEWORK_IMPORTS = new Set([
  'React',
  'ReactDOM',
  'Fragment',
  'Suspense',
  'StrictMode',
  'Children',
  'useState',
  'useEffect',
  'useMemo',
  'useCallback',
  'useRef',
  'useContext',
  'useReducer',
  'useLayoutEffect',
  'history',
  'moment',
  'dayjs',
  'lodash',
  '_',
  'classnames',
  'clsx',
  'cx',
  'umi',
  'Helmet',
  'Link',
  'NavLink',
  'Redirect',
  'Route',
  'Switch',
  'Router',
]);

function isPublicLayerFile(file: string | null): boolean {
  return !!file && PUBLIC_LAYER_RE.test(file.replace(/\\/g, '/'));
}

function isViewsFile(file: string | null): boolean {
  return !!file && VIEWS_RE.test(file.replace(/\\/g, '/'));
}

function isFrameworkImport(name: string): boolean {
  return FRAMEWORK_IMPORTS.has(name);
}

function toKebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function resolveSymbolFile(graph: CodeGraph, name: string): string | null {
  const fns = (graph.functions ?? []).filter((f) => f.name === name);
  if (fns.length === 1) return fns[0].file;
  const exported = fns.filter((f) => f.exported);
  if (exported.length === 1) return exported[0].file;
  const cls = (graph.classes ?? []).find((c) => c.name === name);
  if (cls) return cls.file;
  const kebab = toKebab(name);
  const lower = name.toLowerCase();
  const hit = (graph.modules ?? []).find((m) => {
    const base = m.file.replace(/\.[^.]+$/, '').split('/').pop() ?? '';
    return base === kebab || base === lower || base === name;
  });
  return hit?.file ?? null;
}

/** 仓内引用该符号的文件数（定义文件 + importedBy + 调用点 + 页面指纹），可与 grep 文件数对照 */
function symbolFanIn(graph: CodeGraph, name: string): number {
  const files = new Set<string>();
  const def = resolveSymbolFile(graph, name);
  if (def) {
    files.add(def);
    const mod = (graph.modules ?? []).find((m) => m.file === def);
    for (const f of mod?.importedBy ?? []) files.add(f);
  }
  for (const c of graph.calls ?? []) {
    if (c.toMethod === name) files.add(c.fromFile);
  }
  for (const fp of graph.pageFingerprints ?? []) {
    if (fp.imports.includes(name) || fp.jsx.includes(name)) files.add(fp.file);
  }
  return files.size;
}
