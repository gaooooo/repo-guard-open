/**
 * 沙盘高亮：把一次工具调用的**结构化结果**映射成图上的节点、位置和边。
 *
 * 不从文本里反解析 —— 用的是渲染文本的那同一批函数（symbolImpactOf / analyzeImpact /
 * similarMethods / traceRoute / hotSpots），所以"AI 看到的原文"和"图上亮起来的"
 * 必然来自同一次计算。
 *
 * ── 为什么位置在这里算、不交给前端 ──
 * 前端只知道分层（接口层 / 逻辑层…），不知道「谁调到了谁、隔了几层」。
 * 按分层摆，影响面会被摊成几列互不相干的点，人读不出关系。这里按**关系**摆：
 * 目标在最右，往左依次是直接调用者、间接调用者，对外入口落在它离目标的那一层。
 * 各组互斥 —— 一个节点只属于一组，计数加起来就是图上的点数。
 */
import { analyzeImpact, hotSpots, similarPages, traceRoute } from '../graph/graph-builder.js';
import type { CodeGraph, FunctionNode } from '../graph/types.js';
import { enclosingIndex, functionIds } from '../insight/health.js';
import { similarMethods, type Layer } from '../insight/similar-methods.js';
import { splitFileSymbol, toRepoRelative } from '../runtime/paths.js';
import { resolveSymbol, symbolImpactOf } from '../cli/render.js';

export type Tone = 'target' | 'entry' | 'direct' | 'indirect' | 'weak' | 'ref';

export interface HighlightGroup {
  label: string;
  tone: Tone;
  /** 一句话说清这组是什么、凭什么进来 */
  desc: string;
  nodes: string[];
}

export interface Highlight {
  focus: string | null;
  groups: HighlightGroup[];
  /** 节点位置：col 为列（左负右正），row 为列内序号 */
  pos?: Record<string, { col: number; row: number }>;
  /** 要画的边。给了就只画这些（含图谱里没有的推断边）；不给则前端画节点之间已有的边 */
  edges?: Array<{ source: string; target: string; inferred?: boolean }>;
  /** 图怎么读 */
  reading?: string;
  /** 口径提醒 */
  notes?: string[];
}

const NONE: Highlight = { focus: null, groups: [] };

type PlacedGroup = HighlightGroup & { col: number | ((id: string) => number) };

function indexer(graph: CodeGraph) {
  const ids = functionIds(graph);
  const byKey = new Map<string, string[]>();
  for (const f of graph.functions) {
    const k = `${f.file}#${f.name}`;
    byKey.set(k, [...(byKey.get(k) ?? []), ids.get(f)!]);
  }
  const enclosing = enclosingIndex(graph);
  const at = (file: string, line: number): string => {
    const f = enclosing(file, line);
    return f ? ids.get(f)! : `file:${file}`;
  };
  const fn = (file: string, name: string): string[] => byKey.get(`${file}#${name}`) ?? [];
  const idOf = (f: FunctionNode) => ids.get(f)!;
  return { at, fn, idOf };
}

const uniq = (xs: string[]) => [...new Set(xs)];

/** 按组依次落列：同一个 id 只留在第一个出现的组里，保证各组互斥 */
function place(groups: PlacedGroup[]): { groups: HighlightGroup[]; pos: NonNullable<Highlight['pos']> } {
  const pos: NonNullable<Highlight['pos']> = {};
  const rows = new Map<number, number>();
  const seen = new Set<string>();
  const out: HighlightGroup[] = [];
  for (const { col, ...g } of groups) {
    const nodes = g.nodes.filter((id) => !seen.has(id));
    for (const id of nodes) {
      seen.add(id);
      const c = typeof col === 'function' ? col(id) : col;
      const row = rows.get(c) ?? 0;
      rows.set(c, row + 1);
      pos[id] = { col: c, row };
    }
    out.push({ ...g, nodes });
  }
  return { groups: out, pos };
}

const LAYER_COL: Record<Layer, number> = { router: 0, service: 0, sdk: 0, logic: 1, repo: 2, dto: 3, other: 3 };

function impactHighlight(repoDir: string, graph: CodeGraph, args: Record<string, unknown>, s: (v: unknown) => string): Highlight {
  const ix = indexer(graph);
  const { file, symbol: raw } = splitFileSymbol(s(args.file), s(args.symbol));
  const rel = toRepoRelative(repoDir, file);
  if (!rel) return NONE;
  const symbol = resolveSymbol(graph, rel, raw);
  const r = analyzeImpact(graph, rel, symbol || undefined);

  // ── 字段级 ──
  if (symbol && r.kind === 'field' && r.field) {
    const target = `cls:${rel}#${r.field.struct}`;
    const decl = new Set((graph.fields ?? []).map((f) => `${f.file}:${f.line}`));
    const hits = (r.literalHits ?? []).filter((l) => l.via !== 'tag' && !decl.has(`${l.file}:${l.line}`));
    const p = place([
      { label: '目标字段所在类型', tone: 'target', col: 0, desc: `${r.field.struct}.${r.field.name}`, nodes: [target] },
      { label: '点访问读写', tone: 'direct', col: -1, desc: `代码里写了 x.${r.field.name} 的方法（词法命中）`, nodes: uniq(r.directCallers.map((c) => ix.at(c.file, c.line))) },
      { label: '字符串键读写', tone: 'indirect', col: -2, desc: '用 tag 值当字符串键的方法，如 filter["_id"]。词法命中，未经类型确认', nodes: uniq(hits.map((l) => ix.at(l.file, l.line))) },
    ]);
    return {
      focus: target,
      ...p,
      reading: '从右到左：字段 ← 点访问读写 ← 字符串键读写',
      notes: ['字段级不算对外入口：字段不是调用，没有可靠的调用链能落到路由上。'],
    };
  }

  // ── 方法级：沿调用链 ──
  const si = symbol ? symbolImpactOf(graph, rel, symbol) : null;
  if (si) {
    const target = ix.idOf(si.targets[0]);
    const depthOf = new Map<string, number>([[target, 0]]);
    for (const x of si.reached) depthOf.set(ix.idOf(x.fn), x.depth);
    const handlerIds = new Set(si.routes.map((x) => ix.idOf(x.handler)));
    const direct = si.reached.filter((x) => x.depth === 1);
    const directEntries = direct.filter((x) => handlerIds.has(ix.idOf(x.fn))).length;
    const p = place([
      { label: '目标', tone: 'target', col: 0, desc: `要改的方法 ${symbol}`, nodes: [target] },
      {
        label: '受影响入口（对外接口的 handler）',
        tone: 'entry',
        col: (id) => -(depthOf.get(id) ?? 1),
        desc: '调用链能到达目标的对外接口，改完必须回归的就是这些。列越靠左，离目标隔的层越多',
        nodes: si.routes.map((x) => ix.idOf(x.handler)),
      },
      {
        label: '直接调用者（非入口）',
        tone: 'direct',
        col: -1,
        desc: `直接调用了 ${symbol} 的内部方法。直接调用者共 ${direct.length} 个，其中 ${directEntries} 个本身就是入口，归在红色组`,
        nodes: direct.map((x) => ix.idOf(x.fn)),
      },
      {
        label: '间接调用者（非入口）',
        tone: 'indirect',
        col: (id) => -(depthOf.get(id) ?? 2),
        desc: '调用了「调用者」的方法，隔 2 层及以上',
        nodes: si.reached.filter((x) => x.depth > 1).map((x) => ix.idOf(x.fn)),
      },
    ]);
    const edges = si.reached
      .filter((x) => x.next)
      .map((x) => ({ source: ix.idOf(x.fn), target: ix.idOf(x.next!), inferred: x.inferred }));
    const notes = ['入口只算调用链可达的：只是 import 了同一个包、调用链到不了目标的接口，不算。'];
    const extra = r.affectedRoutes.length - si.routes.length;
    if (extra > 0) {
      notes.push(`按整个文件的 import 传播会多出 ${extra} 个入口（共 ${r.affectedRoutes.length} 个），它们只是引用了同一个包；要看那个口径，去掉 symbol 再查。`);
    }
    if (si.inferredEdges) notes.push(`虚线是同包裸调用的词法推断（${si.inferredEdges} 条）：Go 分析器不产出这类边。`);
    return { focus: target, ...p, edges, reading: '从右到左：目标 ← 直接调用者 ← 间接调用者；红色是对外入口，箭头是调用方向', notes };
  }

  // ── 文件级 ──
  const handlers = r.affectedRoutes.flatMap((a) => {
    const route = graph.routes.find((x) => x.method === a.method && x.urlPath === a.urlPath);
    return route?.handlerFile ? ix.fn(route.handlerFile, route.handlerFn).slice(0, 1) : [];
  });
  const p = place([
    { label: '目标文件', tone: 'target', col: 0, desc: rel, nodes: [`file:${rel}`] },
    { label: '直接调用者', tone: 'direct', col: -1, desc: '调用了这个文件里任一方法的方法', nodes: uniq(r.directCallers.map((c) => ix.at(c.file, c.line))) },
    { label: '受影响入口（handler）', tone: 'entry', col: -3, desc: '处理函数所在文件在依赖模块里、或直接调用了目标的对外接口。按文件算，会偏宽', nodes: uniq(handlers) },
    { label: '依赖模块（import）', tone: 'weak', col: -2, desc: '引用了这个文件（Go 是所在包）的文件，最多追 3 层。只说明"有引用"，不说明"调用了哪个方法"', nodes: r.dependentModules.map((f) => `file:${f}`) },
  ]);
  return {
    focus: `file:${rel}`,
    ...p,
    reading: '从右到左：目标文件 ← 直接调用者 ← 依赖模块 ← 受影响入口',
    notes: ['这是文件级口径：改文件里任何一处都算。只改一个方法时带上 symbol，结果会收窄到调用链。'],
  };
}

export function highlightFor(repoDir: string, graph: CodeGraph, name: string, args: Record<string, unknown>): Highlight {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const ix = indexer(graph);
  const limitOf = (d: number) => (typeof args.limit === 'number' ? args.limit : d);

  switch (name) {
    case 'impact':
      return impactHighlight(repoDir, graph, args, s);

    case 'similar': {
      const intent = s(args.intent);
      if ((graph.pageFingerprints ?? []).length) {
        const r = similarPages(graph, { intent, limit: limitOf(3) });
        const p = place([
          { label: '参考页', tone: 'target', col: 0, desc: '结构最像、写法与主流一致的已有页面', nodes: r.hits.filter((h) => !h.discouraged).map((h) => `file:${h.file}`) },
          { label: '不建议参考', tone: 'weak', col: 1, desc: '结构像，但用了非主流写法', nodes: r.hits.filter((h) => h.discouraged).map((h) => `file:${h.file}`) },
        ]);
        return { focus: p.groups[0].nodes[0] ?? null, ...p, reading: '左列照着写，右列别学' };
      }
      const r = similarMethods(graph, { intent, limit: limitOf(3) });
      const chainIds = uniq(r.families.flatMap((f) => (f.reference?.chain ?? []).flatMap((c) => ix.fn(c.file, c.name).slice(0, 1))));
      const layerById = new Map<string, Layer>();
      for (const f of r.families) for (const m of f.members) for (const id of ix.fn(m.file, m.name)) layerById.set(id, m.layer);
      const rest = uniq(r.families.flatMap((f) => f.members.flatMap((m) => ix.fn(m.file, m.name)))).filter((id) => !chainIds.includes(id));
      const pos: NonNullable<Highlight['pos']> = {};
      chainIds.forEach((id, i) => (pos[id] = { col: i, row: 0 }));
      const rows = new Map<number, number>();
      for (const id of rest) {
        const col = LAYER_COL[layerById.get(id) ?? 'other'];
        const row = (rows.get(col) ?? 1) + 1;
        rows.set(col, row);
        pos[id] = { col, row };
      }
      return {
        focus: chainIds[0] ?? rest[0] ?? null,
        groups: [
          { label: '参考分层骨架', tone: 'target', desc: '同族里调用链最完整的一条：接口层 → 逻辑层 → 存储层。新写的接口照这条分层', nodes: chainIds },
          { label: '同族方法', tone: 'ref', desc: '去掉动词前缀后资源名相同的方法（Describe/Create/Modify…）。按命名归族，不是语义搜索', nodes: rest },
        ],
        pos,
        edges: chainIds.slice(1).map((id, i) => ({ source: chainIds[i], target: id })),
        reading: '第一行是参考骨架（从左到右调用）；下面按分层列出同族其他方法',
        notes: r.families.flatMap((f) => (f.missingVerbs.length ? [`家族 ${f.family} 缺 ${f.missingVerbs.join('、')}`] : [])),
      };
    }

    case 'trace': {
      const t = traceRoute(graph, s(args.urlPath));
      if (!t.controller) return NONE;
      const ctl = ix.fn(t.controller.file, t.controller.fn).slice(0, 1);
      const p = place([
        { label: '接口 handler', tone: 'entry', col: 0, desc: `${t.route?.method ?? ''} ${t.route?.urlPath ?? ''} 的处理函数`, nodes: ctl },
        { label: '下游调用', tone: 'direct', col: 1, desc: 'handler 函数体里调用到的本仓方法', nodes: uniq(t.services.flatMap((x) => ix.fn(x.file, x.method).slice(0, 1))) },
      ]);
      return {
        focus: ctl[0] ?? null,
        ...p,
        edges: ctl.length ? p.groups[1].nodes.map((id) => ({ source: ctl[0], target: id })) : [],
        reading: '从左到右：接口 → 它调用的下游',
      };
    }

    case 'hot': {
      const nodes = uniq(hotSpots(graph, limitOf(10)).flatMap((x) => ix.fn(x.file, x.method).slice(0, 1)));
      const p = place([
        { label: '高扇入热点', tone: 'entry', col: 0, desc: '被最多对外接口依赖的方法，按入口数排序。写新方法前先看这里有没有现成的；改它们前先查 impact', nodes },
      ]);
      return { focus: nodes[0] ?? null, ...p, reading: '从上到下按被依赖的入口数排序' };
    }

    case 'check': {
      const files = Array.isArray(args.files) ? args.files.filter((x): x is string => typeof x === 'string') : [];
      const nodes = files.map((f) => toRepoRelative(repoDir, f)).filter((x): x is string => !!x).map((f) => `file:${f}`);
      const p = place([{ label: '自查文件', tone: 'target', col: 0, desc: '看原文里哪些碰了公共层、命中了哪条红线', nodes }]);
      return { focus: nodes[0] ?? null, ...p };
    }

    default:
      return NONE;
  }
}
