/**
 * 面向人的报告渲染 —— CLI 用。
 *
 * ── 为什么不直接用 graph/graph-report ──
 * 那一份是**面向 agent** 的：markdown、带纪律措辞、带尾注。它是平台内工具与
 * MCP 的唯一事实源，两边共用同一段文本是刻意的（措辞不一致等于两套纪律）。
 *
 * 但 CLI 的读者是**人**，在终端里。人要的是对齐的列、一眼看到的数字，
 * 不是 markdown 的 `- **受影响的页面：2 个**`。所以 `impact` / `hot` / `check`
 * 这三个在这里另写一份终端版；`trace` / `similar` / `contracts` 直接用引擎那份
 * —— 它们的输出本身就是给人和 AI 一起看的结构化结果，没必要分叉。
 */
import {
  analyzeImpact,
  hotSpots,
  STRONG_IMPACT_THRESHOLD,
  type CodeGraph,
} from '../graph/graph-builder.js';

/** 终端分隔线。固定 52 个字符宽 —— 与标题行的视觉重量匹配 */
export const RULE = '─'.repeat(52);

/** 盲区清单。缩进两格加中点，与上方数据块区分开 */
function blindSpotBlock(graph: CodeGraph): string[] {
  const spots = graph.blindSpots ?? [];
  if (!spots.length) return [];
  return [
    '',
    '盲区 —— 下面这些图谱看不见，影响面为 0 也不等于可以删：',
    ...spots.map((b) => `   · ${b}`),
  ];
}

/**
 * 影响面报告。
 *
 * 四个数字的顺序是**按"能改变决策"排**的：
 *   直接调用者 → 依赖模块 → 受影响入口（含强影响）
 * 最后那个才是结论，但前两个是它的依据；只给结论人不会信。
 *
 * 盲区清单永远打印，即使影响面不为 0 —— 它防的是
 * 「影响面为 0 所以可以删」这个最危险的推理。
 */
/**
 * 把模型给的符号归一成引擎认的名字。
 *
 * 真机实测：让模型查「Agent 结构体的 ID 字段」，它传的是 `symbol: "Agent.ID"` ——
 * 这是最自然的写法，但引擎按裸名匹配，于是没命中、退回整文件 93 个入口，
 * 正好是字段级 impact 要消灭的那个放大结论。所以 `Type.Member` 在这里拆开：
 * 该文件里确有这个类型的这个字段 / 方法时取成员名。
 */
export function resolveSymbol(graph: CodeGraph, file: string, symbol?: string): string | undefined {
  const s = (symbol ?? '').trim();
  if (!s) return undefined;
  const dot = s.lastIndexOf('.');
  if (dot <= 0) return s;
  const owner = s.slice(0, dot).split('.').pop()!;
  const name = s.slice(dot + 1);
  const hit =
    (graph.fields ?? []).some((f) => f.file === file && f.struct === owner && f.name === name) ||
    graph.functions.some((f) => f.file === file && f.owner === owner && f.name === name);
  return hit ? name : s;
}

/** 符号没对上时给候选，让模型下一次能传对，而不是拿整文件结论交差 */
function symbolCandidates(graph: CodeGraph, file: string, symbol: string): string[] {
  const want = symbol.toLowerCase().split('.').pop()!;
  const fields = (graph.fields ?? []).filter((f) => f.file === file).map((f) => `${f.struct}.${f.name}`);
  const fns = graph.functions.filter((f) => f.file === file).map((f) => (f.owner ? `${f.owner}.${f.name}` : f.name));
  const all = [...new Set([...fields, ...fns])];
  const close = all.filter((x) => x.toLowerCase().includes(want));
  return (close.length ? close : all).slice(0, 12);
}

export function renderImpactCli(graph: CodeGraph, file: string, rawSymbol?: string): string {
  const symbol = resolveSymbol(graph, file, rawSymbol);
  const r = analyzeImpact(graph, file, symbol);
  if (r.kind === 'field') return renderFieldImpact(graph, file, symbol!, r);
  const lines: string[] = [
    '',
    `影响面 · ${file}${symbol ? `#${symbol}` : ''}`,
    RULE,
  ];
  if (symbol && !graph.functions.some((f) => f.file === file && f.name === symbol)) {
    // 符号没对上时必须说出来：否则"直接调用者 0 处"会被读成"没人调它"
    lines.push(`注意：${file} 里没有叫 ${symbol} 的函数或字段，下面的直接调用者按名字过滤、可能为 0；依赖模块与入口仍按整个文件算，不是这个符号自己的影响面。`);
    const cands = symbolCandidates(graph, file, symbol);
    if (cands.length) lines.push(`本文件里可查的符号：${cands.join('、')}（symbol 传成员名或 类型.成员）`);
  }
  lines.push(`直接调用者   ${r.directCallers.length} 处`);

  for (const c of r.directCallers.slice(0, 20)) {
    lines.push(`   ${c.file}:${c.line}  ${c.fn}`);
  }
  if (r.directCallers.length > 20) {
    lines.push(`   …另有 ${r.directCallers.length - 20} 处`);
  }

  lines.push(`依赖模块     ${r.dependentModules.length} 个（深度 ${r.depth}）`);
  lines.push(`受影响入口   ${r.affectedRoutes.length} 个，其中强影响 ${r.strongRouteCount} 个`);

  for (const a of r.affectedRoutes.slice(0, 20)) {
    // 强影响单独标出来：「22 个页面受影响」里真正必须回归的可能只有 2 个，
    // 不分层的话人只能全看一遍，最后就是一个都不看。
    //
    // 分数去掉多余的 0（0.6 而不是 0.60）再补空格对齐 —— 两位小数看起来像
    // 精确测量，而这是个启发式打分，写 0.6 更诚实。
    const strong = a.score >= STRONG_IMPACT_THRESHOLD;
    const scoreStr = String(Math.round(a.score * 100) / 100);
    lines.push(`${strong ? '   强 ' : '      '}${scoreStr.padEnd(6)}${a.method} ${a.urlPath}`);
  }
  if (r.affectedRoutes.length > 20) {
    lines.push(`   …另有 ${r.affectedRoutes.length - 20} 个`);
  }

  lines.push(...blindSpotBlock(graph));
  return `${lines.join('\n')}\n`;
}

/**
 * 字段级影响面。不打印"受影响入口"—— 字段查询不走模块 BFS，
 * 那个数字恒为 0，印出来会被读成"改这个字段不影响任何接口"。
 */
function renderFieldImpact(
  graph: CodeGraph,
  file: string,
  symbol: string,
  r: ReturnType<typeof analyzeImpact>,
): string {
  const f = r.field!;
  const tags = Object.entries(f.tags ?? {}).map(([k, v]) => `${k}:"${v}"`).join(' ');
  const lines: string[] = [
    '',
    `影响面 · ${file}#${symbol}（字段 ${f.struct}.${f.name}${f.typeName ? ` : ${f.typeName}` : ''}${tags ? `  ${tags}` : ''}）`,
    RULE,
    `点访问读写   ${r.directCallers.length} 处`,
  ];
  for (const c of r.directCallers.slice(0, 20)) lines.push(`   ${c.file}:${c.line}  ${c.fn}`);
  if (r.directCallers.length > 20) lines.push(`   …另有 ${r.directCallers.length - 20} 处`);
  const all = (r.literalHits ?? []).filter((l) => !(l.file === file && l.line === f.line));
  // 字符串键（filter["_id"] 这类）才是真实读写点；别的结构体声明了同名 tag
  // 只说明"名字撞了"，列出来会把 ID 这种通用字段刷成上百行噪音
  const declLines = new Set((graph.fields ?? []).map((x) => `${x.file}:${x.line}`));
  const isDecl = (l: { file: string; line: number; via: string }) => l.via === 'tag' || declLines.has(`${l.file}:${l.line}`);
  const lits = all.filter((l) => !isDecl(l));
  const sameTag = all.filter(isDecl);
  lines.push(`字符串键     ${lits.length} 处（按 tag 值匹配，词法命中，未经类型确认）`);
  for (const l of lits.slice(0, 20)) lines.push(`   ${l.file}:${l.line}  "${l.value}"`);
  if (lits.length > 20) lines.push(`   …另有 ${lits.length - 20} 处`);
  if (sameTag.length) {
    const files = new Set(sameTag.map((l) => l.file));
    lines.push(`同名 tag     ${sameTag.length} 处，分布在 ${files.size} 个文件（别的结构体用了同一个 tag 值，名字相撞不等于同一字段）`);
  }
  lines.push(`涉及文件     ${r.dependentModules.length} 个`);
  for (const w of r.warnings ?? []) lines.push('', `提醒：${w}`);
  lines.push(...blindSpotBlock(graph));
  return `${lines.join('\n')}\n`;
}

/**
 * 高扇入热点（终端版）。
 *
 * 标题里直接写用途 —— 这份清单有两个完全不同的读法：
 *   「别改我」 —— 扇入高的东西改动风险大
 *   「别重造」 —— 要写新组件前先看这里有没有现成的
 * 后者是更常触发的场景，所以写进标题。
 */
export function renderHotCli(graph: CodeGraph, limit: number): string {
  const spots = hotSpots(graph, limit);
  const lines = ['', '高扇入热点 —— 写新组件前先看这里有没有现成的', ''];
  for (const s of spots) {
    lines.push(`     ${s.routeCount} 个入口  ${s.file}  ${s.method}`);
  }
  return `${lines.join('\n')}\n`;
}

/** 高扇入热点（MCP 版）。给 agent 的是紧凑列表，不做终端对齐 */
export function renderHotMcp(graph: CodeGraph, limit: number): string {
  const spots = hotSpots(graph, limit);
  if (!spots.length) return '图谱里没有识别到入口与函数的关联，无法给出热点。';
  return [
    '高扇入热点（写新组件前先看有没有现成的）：',
    ...spots.map((s) => `- ${s.file} ${s.method} —— 被 ${s.routeCount} 个入口引用`),
  ].join('\n');
}
