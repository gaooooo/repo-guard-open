/**
 * 图谱查询的 **agent 面向文本渲染** —— 平台内工具与对外 MCP 共用同一段。
 *
 * ── 为什么必须抽出来共用 ──
 * ADR-051 §6 要把图谱能力开放给外部 agent（Claude Code）。如果两侧各写一份渲染，
 * 纪律会**静默漂移**：平台内改了"强影响必须回归"的措辞，外部还是老话术；
 * 盲区清单在一边列了、另一边漏了。而这些文本本身就是约束的载体
 *（§5.8.2 的结论：图谱的价值不在数据，在于它让 agent 改变决策）——
 * 措辞不一致等于两套纪律。
 *
 * 所以这里是**唯一事实源**：内外两个入口只负责"定位到哪个仓的图"，
 * 拿到 CodeGraph 之后一律走这里。
 *
 * 三个 render 函数与 `decorate` 的分工：
 *   render*   —— 回答问题本身
 *   decorate  —— 追加与 action 无关、但漏掉就会误判的三段尾注
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  analyzeImpact,
  hotSpots,
  similarPages,
  traceRoute,
  STRONG_IMPACT_THRESHOLD,
  type ApiContract,
  type ApiField,
  type CodeGraph,
  type LiteralRef,
} from './graph-builder.js';
import { estimateTokens } from '../engine/shims/token-estimator.js';

/** 渲染所需的仓库侧信息（图之外的东西） */
export interface ReportContext {
  /** 仓库展示名 */
  repoName: string;
  /** 工作区绝对路径。为 null 时新鲜度与节省量都无法计算，静默跳过 */
  localPath: string | null;
  /** 建图时的 commit */
  commitSha: string | null;
  indexedAt: Date | null;
}

/**
 * 前端图谱的 routes 是**页面**（method 固定 'PAGE'，见 RouteNode）。
 * 沿用"对外接口"措辞会让 agent 误以为查的是后端接口，进而把结论报错给用户。
 */
function labelOf(graph: CodeGraph): { isPageGraph: boolean; entryLabel: string } {
  const isPageGraph = graph.routes.length > 0 && graph.routes.every((r) => r.method === 'PAGE');
  return { isPageGraph, entryLabel: isPageGraph ? '页面' : '对外接口' };
}

// ══════════════════ impact ══════════════════

function templateLiteralHits(graph: CodeGraph, file: string): LiteralRef[] {
  const refs = graph.literalRefs ?? [];
  const values = new Set<string>();
  for (const r of refs) {
    if (r.file === file) values.add(r.value);
  }
  for (const f of graph.fields ?? []) {
    if (f.file !== file) continue;
    for (const v of Object.values(f.tags)) values.add(v);
  }
  if (values.size === 0) return [];
  return refs.filter((r) => r.file.startsWith('template/') && values.has(r.value));
}

function formatLiteralHits(hits: LiteralRef[], title: string): string[] {
  if (!hits.length) return [];
  const uniq = new Map<string, LiteralRef>();
  for (const h of hits) {
    const k = `${h.file}:${h.line}:${h.value}`;
    if (!uniq.has(k)) uniq.set(k, h);
  }
  const list = [...uniq.values()];
  const lines = ['', `${title}（${list.length} 处，弱边 / inferred）：`];
  for (const h of list.slice(0, 20)) {
    lines.push(`- \`${h.file}:${h.line}\`  \`${h.value}\` _(via ${h.via})_`);
  }
  if (list.length > 20) lines.push(`- …另有 ${list.length - 20} 处`);
  return lines;
}

export function renderImpact(
  graph: CodeGraph,
  file: string,
  symbol: string | undefined,
  ctx: ReportContext,
): string {
  const { isPageGraph, entryLabel } = labelOf(graph);
  const r = analyzeImpact(graph, file, symbol);
  const sdkHits = r.kind === 'field' ? (r.literalHits ?? []).filter((x) => x.file.startsWith('template/')) : templateLiteralHits(graph, file);

  if (r.kind === 'field' && r.field) {
    const tags = Object.entries(r.field.tags)
      .map(([k, v]) => `${k}:"${v}"`)
      .join(' ');
    const lines = [
      `## 字段影响面：\`${file}#${symbol}\`（仓库 ${ctx.repoName}）`,
      '',
      `- struct \`${r.field.struct}\` · 定义在 \`${file}:${r.field.line}\`${tags ? ` · \`${tags}\`` : ''}`,
      `- **直接读写点：${r.directCallers.length} 处**（点号访问 \`.${symbol}\`，未按 dto 文件做模块 BFS）`,
      `- 相关文件：${r.dependentModules.length} 个`,
    ];
    if (r.directCallers.length) {
      lines.push('', '直接读写：');
      for (const c of r.directCallers.slice(0, 24)) {
        lines.push(`- \`${c.file}#${c.fn}:${c.line}\``);
      }
      if (r.directCallers.length > 24) lines.push(`- …另有 ${r.directCallers.length - 24} 处`);
    }
    lines.push(...formatLiteralHits(r.literalHits ?? [], 'tag / 字符串键引用'));
    lines.push(...formatLiteralHits(sdkHits, '已下发 SDK / template 引用'));
    for (const w of r.warnings ?? []) {
      lines.push('', `⚠️ ${w}`);
    }
    lines.push('', '没有把整个文件扩成对外接口清单。函数级 impact（如 DescribeAgent）算法未改。');
    return decorate(lines, graph, ctx, [file, ...r.dependentModules]);
  }

  // 目标不存在时要说清，否则 agent 会以为"影响为 0，可以放心改"
  if (r.directCallers.length === 0 && r.affectedRoutes.length === 0 && sdkHits.length === 0) {
    return (
      `\`${file}${symbol ? `#${symbol}` : ''}\` 在图谱里没有找到调用者。\n` +
      '两种可能：① 它确实没人调（新文件/死代码）；② 路径或函数名写错了。\n' +
      '请先确认路径拼写与大小写，不要直接当成"改它没有影响"。'
    );
  }

  const lines = [
    `## 影响范围：\`${file}${symbol ? `#${symbol}` : ''}\`（仓库 ${ctx.repoName}）`,
    '',
    // 把最能改变行为的数字放最前
    `- **受影响的${entryLabel}：${r.affectedRoutes.length} 个**` +
      (r.strongRouteCount > 0 && r.strongRouteCount < r.affectedRoutes.length
        ? `（其中强影响 ${r.strongRouteCount} 个）`
        : ''),
    `- 直接调用者：${r.directCallers.length} 处`,
    `- 传播到的模块：${r.dependentModules.length} 个（BFS 深度 ${r.depth}）`,
  ];

  if (r.affectedRoutes.length > 0) {
    // 按耦合强度分层：强影响是"直接渲染/调用了它"，必须回归；
    // 弱影响多为间接 import 波及，扫一眼即可。不分层时这两类混在一个数字里，
    // agent 拿到"22 个页面"也不知道该重点看哪几个。
    const tierOf = new Map(graph.routes.map((x) => [`${x.method} ${x.urlPath}`, x.tier]));
    const fmt = (x: { method: string; urlPath: string; score: number }) => {
      const inferred = tierOf.get(`${x.method} ${x.urlPath}`) === 'inferred' ? ' _(路由为推断)_' : '';
      return `- ${isPageGraph ? '' : `${x.method} `}${x.urlPath}${inferred}`;
    };
    const strong = r.affectedRoutes.filter((x) => x.score >= STRONG_IMPACT_THRESHOLD);
    const weak = r.affectedRoutes.filter((x) => x.score < STRONG_IMPACT_THRESHOLD);
    if (strong.length) {
      lines.push('', `**强影响**（直接调用/渲染，改动必须回归）${strong.length} 个：`);
      lines.push(...strong.slice(0, 12).map(fmt));
      if (strong.length > 12) lines.push(`- …另有 ${strong.length - 12} 个`);
    }
    if (weak.length) {
      lines.push('', `弱影响（间接依赖波及）${weak.length} 个：`);
      lines.push(...weak.slice(0, 8).map(fmt));
      if (weak.length > 8) lines.push(`- …另有 ${weak.length - 8} 个`);
    }
  }
  if (r.affectedRoutes.length >= 50) {
    lines.push('', '⚠️ 影响面很大。改动前先向上游说明这个数字并确认，不要自行决定。');
  }

  lines.push(...formatLiteralHits(sdkHits, '已下发 SDK / template 引用'));
  if (/(?:^|\/)dto\//.test(file) && (graph.fields ?? []).some((f) => f.file === file) && !symbol) {
    lines.push(
      '',
      '本文件含 struct 字段 / bson tag。改字段请带 symbol=字段名（如 Status），不要按整个 dto 文件的接口数决策。',
    );
  }

  // 不用图谱的话，agent 得把这些文件全读一遍才能得到同样的结论
  return decorate(lines, graph, ctx, [file, ...r.dependentModules]);
}

// ══════════════════ trace ══════════════════

function traceNotFoundMessage(graph: CodeGraph, urlPath: string): string {
  const { isPageGraph } = labelOf(graph);
  const seg = urlPath.trim().replace(/^\/+|\/+$/g, '').split('/').pop() || '';
  const looksBackend =
    /\/api\//i.test(urlPath) ||
    /^api\//i.test(urlPath.trim().replace(/^\//, '')) ||
    /^(Describe|Create|Modify|Delete|Download|Update|Add|Remove|Get|List)[A-Z]/.test(seg);
  const base = `图谱里没有 \`${urlPath}\` 这个接口。`;
  if (isPageGraph && looksBackend) {
    return (
      base +
      '这是前端页面图谱，路由是页面路径（如 /llmsgw/mcp-list），不含后端 API 契约。' +
      `请对后端仓再调 query_code_graph(action="trace", urlPath="${seg || urlPath}", repo=<后端仓库名>)。`
    );
  }
  return base + '请确认 Action 名或路径拼写（大小写、有无前导 / 均可），或该接口不在本仓。';
}

export function renderTrace(graph: CodeGraph, urlPath: string, ctx: ReportContext): string {
  const { isPageGraph } = labelOf(graph);
  const t = traceRoute(graph, urlPath);
  if (!t.route) {
    return traceNotFoundMessage(graph, urlPath);
  }

  const lines = [
    `## 调用链：${t.route.method} ${t.route.urlPath}`,
    `- 注册处：\`${t.route.file}:${t.route.line}\``,
  ];
  if (urlPath.trim() !== t.route.urlPath) {
    lines.push(`- 查询 \`${urlPath}\` 匹配到本条`);
  }
  if (t.route.middlewares?.length) {
    lines.push(`- 中间件：${t.route.middlewares.join(' → ')}`);
  }
  if (t.controller) {
    lines.push(
      `- ${isPageGraph ? '页面组件' : 'controller'}：` +
        `\`${t.controller.file}#${t.controller.fn}:${t.controller.line}\``,
    );
  }
  if (t.services?.length) {
    lines.push('', `${isPageGraph ? '引用的组件 / service' : '调用的 service'}（${t.services.length} 处）：`);
    lines.push(...t.services.slice(0, 20).map((s) => `- \`${s.file}#${s.method}:${s.line}\``));
  }
  // 这条链最终打到的后端接口 —— 改调用参数前对齐契约用，别凭字段名猜。
  // 契约必须紧挨路径，不能藏进尾注，否则模型仍会猜字段。
  if (t.inbounds?.length) {
    lines.push('', `入口来源（${t.inbounds.length} 处字面量跳转）：`);
    for (const n of t.inbounds.slice(0, 12)) {
      lines.push(`- \`${n.fromFile}:${n.line}\``);
    }
  }
  if (t.apiCalls?.length) {
    lines.push('', `打到的后端接口（${t.apiCalls.length} 个）：`);
    const byApi = new Map((t.contracts ?? []).map((c) => [c.api, c]));
    for (const a of t.apiCalls.slice(0, 20)) {
      lines.push(`- \`${a}\``);
      const c = byApi.get(a);
      if (c) lines.push(...formatContract(c).map((x) => `  ${x}`));
    }
  }

  const baseline = [t.route.file, t.controller?.file, ...t.services.map((x) => x.file)].filter(
    (x): x is string => !!x,
  );
  return decorate(lines, graph, ctx, baseline);
}

// ══════════════════ hot ══════════════════

export function renderHot(graph: CodeGraph, limit: number, ctx: ReportContext): string {
  const { isPageGraph, entryLabel } = labelOf(graph);
  const spots = hotSpots(graph, limit);
  if (spots.length === 0) {
    return `图谱里没有识别到${entryLabel}与函数的关联，无法给出热点。`;
  }
  const lines = [
    `## 高扇入热点（仓库 ${ctx.repoName}）`,
    isPageGraph
      ? // 前端场景这份清单有第二个用途：**要写新组件前先看它**，
        // 仓里已有的高复用组件应当直接复用而不是另造一个。
        '被越多页面复用，改动风险越大；要新增组件前也先看这里有没有现成的：'
      : '被越多路由依赖，改动风险越大：',
    '',
    ...spots.map((x) => `- \`${x.file}#${x.method}\` ← ${x.routeCount} 个${entryLabel}`),
  ];
  return decorate(lines, graph, ctx, spots.map((x) => x.file));
}

// ══════════════════ similar ══════════════════

export function renderSimilar(
  graph: CodeGraph,
  query: { intent?: string; file?: string; limit?: number },
  ctx: ReportContext,
): string {
  const r = similarPages(graph, query);
  if (r.unmatchedReason) {
    return r.unmatchedReason + '\nhot 回答的是「别改我」；similar 回答的是「照这个做」。不要拿高扇入清单冒充同类实现。';
  }
  if (r.hits.length === 0) {
    return '没有找到结构相近的页面。';
  }
  const skelBits: string[] = [];
  if (r.skeleton.imports.length) skelBits.push(r.skeleton.imports.join(' + '));
  if (r.skeleton.jsx.length) skelBits.push(r.skeleton.jsx.map((x) => `<${x}>`).join(' + '));
  // 降级要说出来：否则模型看到自己给的 file 没出现在结果里，会以为图谱是空的
  const degraded = r.matchedBy === 'intent' && Boolean(query.file?.trim());
  const lines = [
    `## 相似实现（仓库 ${ctx.repoName}）`,
    degraded
      ? `注意：\`${query.file!.trim()}\` 不在图谱里（很可能是你正要新建的文件），已自动改按 intent 检索。` +
        '下面这些是仓内**已存在**的实现，不是空结果。'
      : '',
    r.skeleton.tags.length ? `共同标签：${r.skeleton.tags.join('、')}` : '',
    skelBits.length ? `共同骨架（${r.hits.length} 个样本的交集）：` : '',
    skelBits.length ? `  ${skelBits.join(' + ')}` : '',
    '',
    '参考（推荐）：',
    ...r.hits.filter((h) => !h.discouraged).map((h) => `- \`${h.file}\`${h.urlPath ? `  ${h.urlPath}` : ''}`),
    ...(r.hits.some((h) => h.discouraged)
      ? [
          '',
          '不建议参考（写法与主流不一致）：',
          ...r.hits.filter((h) => h.discouraged).map((h) => `- \`${h.file}\`  —— ${h.discouraged!.reason}`),
        ]
      : []),
    '',
    'hot 回答的是「别改我」；similar 回答的是「照这个做」。写新页面前用 similar，改这些参考文件前仍要 impact。',
  ].filter((x) => x !== '');
  return decorate(lines, graph, ctx, r.hits.map((h) => h.file));
}

/**
 * ahooks useRequest / usePagination 返回值上的控制器字段，不是接口 JSON。
 * 判末段：`pagination.current` → current；`pagination.total` 不在此列，仍是接口字段。
 */
const HOOK_CONTROLLER_FIELDS = new Set([
  'current',
  'pageSize',
  'onChange',
  'loading',
  'run',
  'refresh',
  'runAsync',
  'refreshAsync',
  'mutate',
  'cancel',
  'error',
  'params',
  'changeCurrent',
  'changePageSize',
  'totalPage',
]);

export function isHookControllerField(name: string): boolean {
  const last = name.split('.').pop() ?? name;
  return HOOK_CONTROLLER_FIELDS.has(last);
}

function formatResponseField(f: ApiField): string {
  const typ = f.inferredType ? `  ${f.inferredType}` : '';
  const src = f.sources[0] ? `  ← ${f.sources[0].file}:${f.sources[0].line}` : '';
  return `  ${f.name}${typ}${src}`;
}

function formatContract(c: ApiContract): string[] {
  const lines: string[] = [];
  const n = c.callSiteCount;
  lines.push(`请求参数（从 ${n} 个调用点归纳${c.divergent ? '，调用点之间不完全一致' : ''}）：`);
  if (c.request.length === 0) {
    lines.push('  （调用点未展开出对象字面量，无法归纳请求字段）');
  } else {
    for (const f of c.request) {
      const typ = f.inferredType ? `  ${f.inferredType}` : '';
      const opt = f.optional ? `  ${f.seen.have}/${f.seen.total} 处传 ← 可选` : `  ${f.seen.have}/${f.seen.total} 处都传`;
      const src = f.sources[0]?.expr ? `  ← ${f.sources[0].expr}` : '';
      lines.push(`  ${f.name}${typ}${opt}${src}`);
    }
  }
  const apiFields = c.response.filter((f) => !isHookControllerField(f.name));
  const hookFields = c.response.filter((f) => isHookControllerField(f.name));
  lines.push('接口响应字段（从页面用法反推）：');
  if (apiFields.length === 0) {
    lines.push('  （未从调用点所在函数反推到接口字段）');
  } else {
    for (const f of apiFields) lines.push(formatResponseField(f));
  }
  if (hookFields.length) {
    lines.push('hook 控制器字段（usePagination / useRequest 提供，非接口返回）：');
    for (const f of hookFields) lines.push(formatResponseField(f));
  }
  return lines;
}

/**
 * 把调用点契约渲成 TS interface 草稿。非正式类型，需人 review 后落库。
 * 默认只导出调用点 ≥ 2 的接口。
 */
export function renderApiContractsAsTs(
  graph: CodeGraph,
  opts?: { minCallSites?: number; api?: string },
): string {
  const min = opts?.minCallSites ?? 2;
  const list = (graph.apiContracts ?? []).filter(
    (c) => c.callSiteCount >= min && (!opts?.api || c.api === opts.api || c.api.endsWith(opts.api!)),
  ).map((c) => ({
    ...c,
    response: c.response.filter((f) => !isHookControllerField(f.name)),
  }));
  if (list.length === 0) {
    return (
      '/** 没有调用点 ≥ ' +
      min +
      ' 的接口契约可导出。重建前端图谱后再试，或把 minCallSites 调成 1。 */\n'
    );
  }
  const chunks: string[] = [
    '/**',
    // 【移植偏差 · 仅文案】原文是"由 DeerClaw 从调用点反推"。这是个独立插件，
    // 用户机器上没有 DeerClaw，署一个他不认识的名字只会让人怀疑这段是哪来的。
    ' * 由 repo-guard 从调用点反推，非正式类型。',
    ' * 请人工核对后替换 unknown，并考虑打开 noImplicitAny。',
    ' * 草稿，需人工核对后端契约。禁止把本文件当已存在的业务类型直接引用。',
    ' */',
    '',
  ];
  for (const c of list) {
    const base = identFromApi(c.api);
    const evidence = c.request
      .flatMap((f) => f.sources)
      .concat(c.response.flatMap((f) => f.sources))
      .slice(0, 6)
      .map((s) => `${s.file}:${s.line}`);
    chunks.push(`/**`);
    chunks.push(` * ${c.api}`);
    chunks.push(` * 由 ${c.callSiteCount} 个调用点反推${c.divergent ? '（调用点字段集合不一致，未强行合并）' : ''}。`);
    if (c.service) chunks.push(` * service: ${c.service.file}#${c.service.name}`);
    if (evidence.length) chunks.push(` * 证据：${[...new Set(evidence)].join(', ')}`);
    chunks.push(` */`);
    chunks.push(`export interface I${base}Params {`);
    if (c.request.length === 0) {
      chunks.push('  // 未能从调用点展开请求对象');
    } else {
      for (const f of c.request) {
        const t = tsType(f.inferredType, false);
        const freq = f.optional
          ? `// ${f.seen.have}/${f.seen.total}`
          : `// ${f.seen.have}/${f.seen.total} 调用点必传`;
        chunks.push(`  ${ident(f.name)}${f.optional ? '?' : ''}: ${t};  ${freq}`);
      }
    }
    chunks.push(`}`);
    chunks.push('');
    if (c.response.length === 0) {
      chunks.push(`/** 响应字段尚未从页面/hook 用法反推。 */`);
    }
    chunks.push(`export interface I${base}Response {`);
    chunks.push(...renderNestedResponse(c.response));
    chunks.push(`}`);
    chunks.push('');
  }
  return chunks.join('\n');
}

function identFromApi(api: string): string {
  const pathPart = api.replace(/^(GET|POST|PUT|PATCH|DELETE|ANY)\s+/i, '');
  const last = pathPart.split('/').filter(Boolean).pop() ?? 'Api';
  const cleaned = last.replace(/[^A-Za-z0-9]+/g, '') || 'Api';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function ident(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name);
}

function tsType(t: ApiField['inferredType'] | undefined, nested: boolean): string {
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  if (t === 'array') return nested ? 'unknown[]' : 'unknown[]';
  if (t === 'object') return 'Record<string, unknown>';
  return 'unknown';
}

function renderNestedResponse(fields: ApiContract['response']): string[] {
  if (fields.length === 0) return ['  // 未能从页面用法反推响应字段'];
  type Node = { type?: ApiField['inferredType']; optional: boolean; kids: Map<string, Node> };
  const root: Node = { optional: false, kids: new Map() };
  for (const f of fields) {
    const parts = f.name.split('.').filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      let n = cur.kids.get(parts[i]);
      if (!n) {
        n = { optional: true, kids: new Map() };
        cur.kids.set(parts[i], n);
      }
      if (last) {
        n.type = f.inferredType;
        n.optional = f.optional || n.optional;
      }
      cur = n;
    }
  }
  const lines: string[] = [];
  const walk = (node: Node, indent: string) => {
    for (const [k, kid] of node.kids) {
      const opt = kid.optional ? '?' : '';
      if (kid.kids.size) {
        lines.push(`${indent}${ident(k)}${opt}: {`);
        walk(kid, indent + '  ');
        lines.push(`${indent}};`);
      } else {
        lines.push(`${indent}${ident(k)}${opt}: ${tsType(kid.type, true)};`);
      }
    }
  };
  walk(root, '  ');
  return lines;
}

// ══════════════════ 尾注 ══════════════════

/**
 * 给每次查询的输出统一追加三段尾注。
 *
 * 抽成一处是因为这三件事**与 action 无关，且漏掉任何一条都会造成误判**：
 *   ① 盲区自述  —— 图谱看不见什么。由分析器随图产出（CodeGraph.blindSpots），
 *                  不再由门禁文案硬编码，所以新增语言时自动跟着走。
 *   ② 新鲜度    —— 图谱是建图那一刻的快照。不说清楚，agent 会把过期结论当现状。
 *                  对外部 agent 尤其要紧：开发者本地未提交的改动一定不在图里。
 *   ③ 上下文节省 —— 回答"这个工具值不值得调"。ADR-051 §5.8 曾用整节论证图谱
 *                  该不该存在；把节省量直接写在每次输出里，那个论证就不必再写。
 */
export function decorate(
  lines: string[],
  graph: CodeGraph,
  ctx: ReportContext,
  baselineFiles: string[],
): string {
  const out = [...lines];

  if (graph.blindSpots?.length) {
    out.push('', '**本图谱看不见的东西**（下结论前必须考虑）：');
    out.push(...graph.blindSpots.map((b) => `- ${b}`));
  }

  const fresh = freshness(ctx.localPath, ctx.commitSha, ctx.indexedAt);
  if (fresh) out.push('', fresh);

  const saved = contextSavings(ctx.localPath, baselineFiles, out.join('\n'));
  if (saved) out.push('', saved);

  return out.join('\n');
}

/** 读 git HEAD 短 sha。非 git 工作区或读失败返回 null */
export function readHeadSha(localPath: string | null): string | null {
  if (!localPath) return null;
  try {
    const headFile = path.join(localPath, '.git', 'HEAD');
    if (!fs.existsSync(headFile)) return null;
    const raw = fs.readFileSync(headFile, 'utf-8').trim();
    const ref = raw.match(/^ref:\s*(.+)$/);
    if (!ref) return raw.slice(0, 8);
    const refFile = path.join(localPath, '.git', ref[1]);
    if (!fs.existsSync(refFile)) return null;
    return fs.readFileSync(refFile, 'utf-8').trim().slice(0, 8);
  } catch {
    return null;
  }
}

/**
 * 图谱新鲜度。优先比对 commit，拿不到 git 信息就退回"建于多久前"。
 *
 * 为什么退回也要说：`commitSha` 只在仓库是 git 工作区时才有值，
 * 而"这张图建于 12 天前"同样能让 agent 判断要不要信 —— 有总比没有强。
 */
export function freshness(
  localPath: string | null,
  commitSha: string | null,
  indexedAt: Date | null,
): string | null {
  const ageDays = indexedAt ? Math.floor((Date.now() - indexedAt.getTime()) / 86_400_000) : null;
  const head = readHeadSha(localPath);

  if (head && commitSha && head !== commitSha) {
    return (
      `> ⚠️ **图谱可能已过期**：建图于 commit \`${commitSha}\`，当前 HEAD 是 \`${head}\`` +
      `${ageDays !== null ? `（${ageDays} 天前建图）` : ''}。` +
      '结论可能不反映最新代码，必要时让管理员重新索引。'
    );
  }
  if (ageDays !== null && ageDays >= 7) {
    return `> 提示：本图谱建于 ${ageDays} 天前${head ? '（commit 未变）' : ''}，如期间有合入请考虑重新索引。`;
  }
  return null;
}

/**
 * 估算"不用图谱要读多少源码"，回显节省量。
 *
 * 基线取**本次结论涉及的文件**的实际字节数 —— 这是 agent 不用图谱时
 * 至少要读进上下文的量（真实情况只会更多，因为它还得试错找文件）。
 * 用 estimateTokens 而不是另写一套 chars/4，保持与上下文预算同一把尺。
 */
export function contextSavings(
  localPath: string | null,
  files: string[],
  output: string,
): string | null {
  if (!localPath || files.length === 0) return null;
  let baselineChars = 0;
  let counted = 0;
  for (const f of new Set(files)) {
    try {
      const st = fs.statSync(path.join(localPath, f));
      if (st.isFile()) {
        baselineChars += st.size;
        counted++;
      }
    } catch {
      /* 文件不在了（图谱过期）不影响估算 */
    }
  }
  if (counted === 0 || baselineChars === 0) return null;
  const baseline = estimateTokens('x'.repeat(baselineChars));
  const returned = estimateTokens(output);
  if (baseline <= returned) return null;
  const pct = Math.round(((baseline - returned) / baseline) * 100);
  return (
    `> 上下文节省：直接读这 ${counted} 个文件约需 ${baseline.toLocaleString()} token，` +
    `本次图谱查询约 ${returned.toLocaleString()} token（省约 ${pct}%，估算值）。`
  );
}
