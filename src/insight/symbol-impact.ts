/**
 * 方法级影响面 —— 沿调用链反查「谁（间接）调到了这个方法」，再落到对外入口。
 *
 * ── 为什么不直接用 analyzeImpact(graph, file, symbol) ──
 * 引擎的方法级只收窄了「直接调用者」，受影响入口仍按**整个文件**的 import 传播算。
 * Go 的 import 单位是包，于是所有引用了 internal/logic 的 handler 都被算进来：
 * 查 identity 的 DescribeAgent，文件级给 47 个入口，而真正调用链可达的是 18 个。
 *
 * ── 为什么要补「同包裸调用」 ──
 * Go 分析器不产出同包内不带包名的调用（`authAgentToken(ctx)`）的边。只走已有调用边
 * 只能到 9 个入口 —— plugin / oauth token 那一批全丢，少报是最坏的方向。
 * 这里对调用链上的**包级函数**（无接收器）在同目录源码里做词法补边，标 inferred。
 *
 * ── 纯函数 ──
 * 读源码通过 readSource 注入；不传则不补边（行为退化为只走已有调用边）。
 */
import path from 'node:path';

import type { CodeGraph, FunctionNode } from '../graph/types.js';
import { enclosingIndex } from './health.js';

export const SYMBOL_IMPACT_MAX_DEPTH = 4;

/** 深度 → 分数。第 1、2 层算强影响（≥0.5，与引擎 STRONG_IMPACT_THRESHOLD 同线） */
const DEPTH_SCORE = [1, 0.8, 0.6, 0.45, 0.35];

export interface ReachedFn {
  fn: FunctionNode;
  depth: number;
  /** 调用链上的下一跳（更靠近目标），目标自身为 null */
  next: FunctionNode | null;
  /** 调到下一跳的那一行 */
  line: number;
  /** 这一跳是否来自词法推断 */
  inferred: boolean;
}

export interface SymbolRoute {
  method: string;
  urlPath: string;
  score: number;
  depth: number;
  handler: FunctionNode;
  /** handler → … → 目标 */
  chain: FunctionNode[];
  inferred: boolean;
}

export interface SymbolImpactResult {
  targets: FunctionNode[];
  reached: ReachedFn[];
  routes: SymbolRoute[];
  strongRouteCount: number;
  inferredEdges: number;
  /** 调用链在最大深度处仍有上游，被截断 */
  truncated: boolean;
}

export function analyzeSymbolImpact(
  graph: CodeGraph,
  file: string,
  symbol: string,
  readSource?: (file: string) => string | null,
  maxDepth = SYMBOL_IMPACT_MAX_DEPTH,
): SymbolImpactResult | null {
  const targets = graph.functions.filter((f) => f.file === file && f.name === symbol);
  if (!targets.length) return null;

  const enclosing = enclosingIndex(graph);
  // 被调 key → 调用方（含调用行）。只认已解析的边，与引擎口径一致
  const callersOf = new Map<string, Array<{ fn: FunctionNode; line: number; inferred: boolean }>>();
  for (const c of graph.calls) {
    if (!c.toFile) continue;
    const from = enclosing(c.fromFile, c.line);
    if (!from) continue;
    const k = `${c.toFile}#${c.toMethod}`;
    const list = callersOf.get(k) ?? [];
    list.push({ fn: from, line: c.line, inferred: false });
    callersOf.set(k, list);
  }

  const filesInDir = new Map<string, string[]>();
  for (const m of graph.modules) {
    const d = path.posix.dirname(m.file);
    filesInDir.set(d, [...(filesInDir.get(d) ?? []), m.file]);
  }
  const srcCache = new Map<string, string[] | null>();
  const linesOf = (f: string) => {
    if (!srcCache.has(f)) {
      const s = readSource?.(f) ?? null;
      srcCache.set(f, s === null ? null : s.split('\n'));
    }
    return srcCache.get(f)!;
  };
  let inferredEdges = 0;

  /** 同包裸调用：只对 Go 的包级函数做，方法（有接收器）必然带 `x.` 前缀，已由分析器解析 */
  const bareCallers = (t: FunctionNode): Array<{ fn: FunctionNode; line: number; inferred: boolean }> => {
    if (!readSource || t.owner || !t.file.endsWith('.go')) return [];
    const re = new RegExp(`(^|[^.\\w])${t.name.replace(/\$/g, '\\$')}\\s*\\(`);
    const out: Array<{ fn: FunctionNode; line: number; inferred: boolean }> = [];
    for (const f of filesInDir.get(path.posix.dirname(t.file)) ?? []) {
      const lines = linesOf(f);
      if (!lines) continue;
      lines.forEach((ln, i) => {
        if (/^\s*func\s/.test(ln) || /^\s*\/\//.test(ln) || !re.test(ln)) return;
        const from = enclosing(f, i + 1);
        if (from && from !== t) out.push({ fn: from, line: i + 1, inferred: true });
      });
    }
    return out;
  };

  // 对外入口就是终点：handler 的"调用方"只是路由注册（router.go 里 r.POST(..., handler)），
  // 再往上追会把 Init → main 这条装配链当成影响面
  const handlers = new Set<FunctionNode>();
  for (const r of graph.routes) {
    if (!r.handlerFile) continue;
    for (const f of graph.functions) if (f.file === r.handlerFile && f.name === r.handlerFn) handlers.add(f);
  }

  const reached = new Map<FunctionNode, ReachedFn>();
  for (const t of targets) reached.set(t, { fn: t, depth: 0, next: null, line: t.line, inferred: false });
  let frontier = [...targets];
  let truncated = false;
  for (let d = 1; frontier.length; d++) {
    const next: FunctionNode[] = [];
    for (const t of frontier) {
      if (handlers.has(t) && reached.get(t)!.depth > 0) continue;
      const known = callersOf.get(`${t.file}#${t.name}`) ?? [];
      const seenHere = new Set(known.map((k) => k.fn));
      const extra = bareCallers(t).filter((b) => !seenHere.has(b.fn));
      for (const c of [...known, ...extra]) {
        if (reached.has(c.fn)) continue;
        if (d > maxDepth) {
          truncated = true;
          continue;
        }
        if (c.inferred) inferredEdges++;
        reached.set(c.fn, { fn: c.fn, depth: d, next: t, line: c.line, inferred: c.inferred });
        next.push(c.fn);
      }
    }
    if (d > maxDepth) break;
    frontier = next;
  }

  const chainOf = (f: FunctionNode): { chain: FunctionNode[]; inferred: boolean } => {
    const chain: FunctionNode[] = [];
    let inferred = false;
    let cur: ReachedFn | undefined = reached.get(f);
    while (cur) {
      chain.push(cur.fn);
      inferred ||= cur.inferred;
      cur = cur.next ? reached.get(cur.next) : undefined;
    }
    return { chain, inferred };
  };

  const routes: SymbolRoute[] = [];
  const seenRoute = new Set<string>();
  for (const r of graph.routes) {
    if (!r.handlerFile) continue;
    const key = `${r.method} ${r.urlPath}`;
    if (seenRoute.has(key)) continue;
    const handler = graph.functions.find((f) => f.file === r.handlerFile && f.name === r.handlerFn && reached.has(f));
    if (!handler) continue;
    seenRoute.add(key);
    const hit = reached.get(handler)!;
    const { chain, inferred } = chainOf(handler);
    routes.push({
      method: r.method,
      urlPath: r.urlPath,
      score: DEPTH_SCORE[Math.min(hit.depth, DEPTH_SCORE.length - 1)],
      depth: hit.depth,
      handler,
      chain,
      inferred,
    });
  }
  routes.sort((a, b) => a.depth - b.depth || a.urlPath.localeCompare(b.urlPath));

  return {
    targets,
    reached: [...reached.values()].filter((x) => x.depth > 0).sort((a, b) => a.depth - b.depth || a.fn.file.localeCompare(b.fn.file) || a.line - b.line),
    routes,
    strongRouteCount: routes.filter((r) => r.score >= 0.5).length,
    inferredEdges,
    truncated,
  };
}
