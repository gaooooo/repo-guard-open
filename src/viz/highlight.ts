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
import { resolveSymbol, reuseOf, symbolImpactOf } from '../cli/render.js';

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
  /** rows = 各列按行号对齐（表格式，similar 用）；缺省 = 每列各自垂直居中（影响面用） */
  align?: 'rows';
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
      const one = (file: string, name: string) => ix.fn(file, name).slice(0, 1);
      const pos: NonNullable<Highlight['pos']> = {};
      const edges: NonNullable<Highlight['edges']> = [];
      /** 一条链画成一行：从左到右 接口层 → 逻辑层 → 存储层 */
      const row = (chain: Array<{ file: string; name: string }>, r0: number): string[] => {
        const ids = chain.flatMap((c) => one(c.file, c.name));
        ids.forEach((id, i) => {
          if (!pos[id]) pos[id] = { col: i, row: r0 };
          if (i) edges.push({ source: ids[i - 1], target: id });
        });
        return ids;
      };

      // ── 新资源：模板家族每个动作一行 ──
      if (r.template) {
        const t = r.template;
        const ids = uniq(t.chains.flatMap((c, i) => row(c.chain, i)));
        return {
          focus: ids[0] ?? null,
          groups: [
            {
              label: `模板骨架（${t.family.family}）`,
              tone: 'target',
              desc: `本仓没有 ${r.wantResource}，借四个动作齐全的 ${t.family.family} 当模板。每行一个动作：接口层 → 逻辑层 → 存储层`,
              nodes: ids,
            },
          ],
          pos,
          edges,
          align: 'rows',
          reading: '每一行是模板的一个动作（Describe / Create / Modify / Delete），从左到右是调用方向',
          notes: [
            `这些是别的资源（${t.family.family}）的方法：只抄分层写法，不抄业务逻辑。`,
            `新建 ${r.wantResource} 的方法与文件清单见下方原文「照模板新建」。`,
            ...(t.alternatives.length ? [`可换的模板：${t.alternatives.join('、')}`] : []),
          ],
        };
      }

      // ── 已有资源：第 0 行参考骨架；缺动作时第 1 行是借来的同动作骨架；其余按分层列出 ──
      const chainIds = uniq(r.families.flatMap((f) => (f.reference ? row(f.reference.chain, 0) : [])));
      const groups: HighlightGroup[] = [
        { label: '参考分层骨架', tone: 'target', desc: '同族里调用链最完整的一条：接口层 → 逻辑层 → 存储层。新写的接口照这条分层', nodes: chainIds },
      ];
      const notes = r.families.flatMap((f) => (f.missingVerbs.length ? [`家族 ${f.family} 缺 ${f.missingVerbs.join('、')}`] : []));
      if (r.verbTemplate) {
        const v = r.verbTemplate;
        const vt = uniq(row(v.chain.chain, 1));
        groups.push({ label: `${v.chain.verb} 的写法（借 ${v.family}）`, tone: 'ref', desc: `本族没有 ${v.chain.verb}，同一动作在别的家族里这么写`, nodes: vt });
        const reuse = uniq(v.chain.planned.filter((p) => p.reuse).flatMap((p) => one(p.file, p.name)));
        reuse.forEach((id) => {
          const p = v.chain.planned.find((x) => one(x.file, x.name)[0] === id)!;
          const col = v.chain.planned.indexOf(p);
          if (!pos[id]) pos[id] = { col, row: 2 };
        });
        if (reuse.length) {
          groups.push({ label: '已有，直接调用', tone: 'direct', desc: `补 ${v.chain.verb}${r.wantResource} 时这些下层方法本仓已经有了，接口层直接调，不要重写`, nodes: reuse });
        }
        const fresh = v.chain.planned.filter((p) => !p.reuse).map((p) => `${p.file}#${p.name}`);
        if (fresh.length) notes.push(`要新建的只有：${fresh.join('、')}`);
      }
      const layerById = new Map<string, Layer>();
      for (const f of r.families) for (const m of f.members) for (const id of ix.fn(m.file, m.name)) layerById.set(id, m.layer);
      const taken = new Set(Object.keys(pos));
      const rest = uniq(r.families.flatMap((f) => f.members.flatMap((m) => ix.fn(m.file, m.name)))).filter((id) => !taken.has(id));
      const rows = new Map<number, number>();
      for (const id of rest) {
        const col = LAYER_COL[layerById.get(id) ?? 'other'];
        const rr = (rows.get(col) ?? 2) + 1;
        rows.set(col, rr);
        pos[id] = { col, row: rr };
      }
      groups.push({ label: '同族其他方法', tone: 'weak', desc: '去掉动词前缀后资源名相同的方法，按分层排列。按命名归族，不是语义搜索', nodes: rest });
      return {
        focus: chainIds[0] ?? rest[0] ?? null,
        groups,
        pos,
        edges,
        align: 'rows',
        reading: r.verbTemplate
          ? '第 1 行：本族参考骨架；第 2 行：借来的同一动作骨架；第 3 行：补这个动作时已有、可直接调用的下层方法'
          : '第 1 行是参考骨架（从左到右调用）；下面按分层列出同族其他方法',
        notes,
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
      const intent = s(args.intent);
      if (intent) {
        const r = reuseOf(graph, intent, limitOf(8));
        const full = r.candidates.filter((c) => c.full);
        const part = r.candidates.filter((c) => !c.full);
        const callers = new Map<string, string>();
        const edges: NonNullable<Highlight['edges']> = [];
        // 只画可复用候选的调用方：部分命中的调用方会把图连成一张网，而它们多半不是要找的
        for (const c of full.length ? full : part.slice(0, 3)) {
          for (const f of c.callers.slice(0, 12)) {
            const id = ix.idOf(f);
            if (!callers.has(id)) callers.set(id, id);
            edges.push({ source: id, target: c.id });
          }
        }
        const p = place([
          { label: '可以直接复用', tone: 'target', col: 0, desc: '需求里的对象词都对上了。被调用越多越该复用，不要再写一个同功能的方法', nodes: full.map((c) => c.id) },
          { label: '部分命中', tone: 'weak', col: 1, desc: '只对上一部分词，多半不是要找的；看注释再决定', nodes: part.map((c) => c.id) },
          { label: '正在使用它们的方法', tone: 'direct', col: -1, desc: '已经调用这些现成方法的地方（每个候选最多列 12 个）—— 说明它们已被验证过、在用', nodes: [...callers.keys()] },
        ]);
        return {
          focus: full[0]?.id ?? part[0]?.id ?? null,
          ...p,
          edges: edges.filter((e) => p.pos[e.source] && p.pos[e.target]),
          reading: '中间一列是可复用的现成方法（按被调用次数从上到下），左边是正在用它们的方法，右边是部分命中',
          notes: r.candidates.length
            ? ['按方法名单词与方法上方注释做词法匹配，不是语义搜索。']
            : ['没有名字或注释相近的现成方法，可以新写。'],
        };
      }
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
