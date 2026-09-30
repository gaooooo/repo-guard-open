/**
 * 仓库体检 —— 从现成的图谱数据算健康度与复杂度，不改分析器。
 *
 * ── 只列原始数字，不打总分 ──
 * 「健康分 78」这种合成分数看起来精确，实际上权重是拍的，而人会拿它互相比较、
 * 拿它下结论。这里每个数字都能追到图谱里的一条边或一个行号，人自己判断。
 * 唯一的分档是**可信度**：它不是在评价代码，而是在说「这张图能不能信」——
 * webapi 调用解析率 0.8% 时，它上面的影响面结论基本不可用，这件事必须比任何指标先说。
 *
 * ── 复杂度是近似 ──
 * 图谱里没有分支数，真正的圈复杂度要分析器补。这里用「体量 × 调用点」近似，
 * 页面上必须标"近似"。
 *
 * ── 纯函数 ──
 * 本目录（src/insight）只依赖 CodeGraph，零宿主依赖。行数、审计结果由调用方传入。
 */
import { hotSpots } from '../graph/graph-builder.js';
import type { CodeGraph, FunctionNode } from '../graph/types.js';

export const HEALTH_SCHEMA_VERSION = 1;

/**
 * 上帝方法判据：又大又被多处调 —— 改不动、也拆不动。
 * 阈值按四个 gateway 仓实测校准：80 行 × 扇入 5 在四仓一个都不命中（大方法通常没人复用、
 * 高扇入的通常是小工具函数），50 × 3 每仓命中 1~4 个，都是值得人看一眼的。
 */
export const GOD_MIN_LOC = 50;
export const GOD_MIN_FAN_IN = 3;

export interface FnMetric {
  id: string;
  file: string;
  name: string;
  owner: string | null;
  line: number;
  /** 行数 = endLine - line + 1 */
  loc: number;
  /** 函数体里的调用点（含标准库 / 外部 SDK） */
  callSites: number;
  /** 调到的**已解析**的不同目标数 */
  fanOut: number;
  /** 被已解析调用命中的次数 */
  fanIn: number;
  /** 近似复杂度 = loc × callSites */
  cx: number;
  god: boolean;
}

export interface FileMetric {
  file: string;
  lines: number | null;
  oversize: boolean;
  fns: number;
  imports: number;
  importedBy: number;
  inCycle: boolean;
}

export type TrustLevel = 'high' | 'medium' | 'low';

export interface HealthReport {
  schemaVersion: number;
  repo: string;
  analyzer: string | null;
  headSha: string | null;
  builtAt: number;
  generatedAt: number;
  scale: { files: number; functions: number; classes: number; calls: number; routes: number; fields: number };
  trust: {
    level: TrustLevel;
    reasons: string[];
    resolvedCalls: number;
    totalCalls: number;
    tracedRoutes: number;
    totalRoutes: number;
    parseFailed: number;
    warnings: string[];
  };
  lineLimit: number;
  godRule: { minLoc: number; minFanIn: number };
  functions: FnMetric[];
  files: FileMetric[];
  lists: {
    god: string[];
    biggest: string[];
    hottest: string[];
    complex: string[];
    oversize: Array<{ file: string; lines: number }>;
    cycles: string[][];
  };
  hotSpots: Array<{ file: string; method: string; routeCount: number }>;
  blindSpots: string[];
  publicLayer: string[];
  audit: null | {
    ruleCount: number;
    deadRules: number;
    leakyRules: number;
    staleEvidence: number;
    problems: Array<{ ruleId: string; severity: string; summary: string }>;
  };
}

export interface HealthInput {
  repo: string;
  headSha: string | null;
  lineLimit: number;
  /** 文件行数。缺省用函数最大 endLine 近似 */
  lineCount?: (file: string) => number | null;
  oversize: Array<{ file: string; lines: number }>;
  cycles: string[][];
  publicLayer?: string[];
  audit?: {
    ruleCount: number;
    rules: Array<{ ruleId: string; severity: string; summary: string }>;
    stats: { deadRules: number; leakyRules: number; staleEvidence: number };
  } | null;
}

/**
 * 方法节点 id。可视化和体检共用这一处 —— 两边 id 对不上，点清单就亮不了图。
 * 同文件同名（不同接收器）的第二个起带 `@行号`。
 */
export function functionIds(graph: CodeGraph): Map<FunctionNode, string> {
  const used = new Map<string, number>();
  const out = new Map<FunctionNode, string>();
  for (const f of graph.functions) {
    const base = `fn:${f.file}#${f.name}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    out.set(f, n === 1 ? base : `${base}@${f.line}`);
  }
  return out;
}

/** 调用点归属到**最内层**覆盖它的函数（闭包、内部函数不能把调用算给外层） */
export function enclosingIndex(graph: CodeGraph): (file: string, line: number) => FunctionNode | null {
  const byFile = new Map<string, FunctionNode[]>();
  for (const f of graph.functions) {
    const list = byFile.get(f.file);
    if (list) list.push(f);
    else byFile.set(f.file, [f]);
  }
  return (file, line) => {
    let best: FunctionNode | null = null;
    for (const f of byFile.get(file) ?? []) {
      if (line < f.line || line > f.endLine) continue;
      if (!best || f.endLine - f.line < best.endLine - best.line) best = f;
    }
    return best;
  };
}

function trustOf(graph: CodeGraph): HealthReport['trust'] {
  const s = graph.stats;
  const reasons: string[] = [];
  let level: TrustLevel = 'high';
  const down = (to: TrustLevel) => {
    if (to === 'low' || (to === 'medium' && level === 'high')) level = to;
  };
  const callRate = s.calls ? s.resolvedCalls / s.calls : 1;
  const routeRate = s.routes ? s.routesTracedToService / s.routes : 1;
  if (s.calls && callRate < 0.05) {
    down('low');
    reasons.push(`调用解析率 ${s.resolvedCalls}/${s.calls}：绝大多数调用落不到本仓函数，方法级影响面会严重少报`);
  } else if (s.calls && callRate < 0.15) {
    down('medium');
    reasons.push(`调用解析率 ${s.resolvedCalls}/${s.calls} 偏低（未解析的里包含标准库与外部 SDK，偏低不全是缺陷）`);
  }
  if (s.routes && routeRate < 0.3) {
    down('low');
    reasons.push(`路由追到服务层 ${s.routesTracedToService}/${s.routes}：trace 与入口影响面基本断链`);
  } else if (s.routes && routeRate < 0.8) {
    down('medium');
    reasons.push(`路由追到服务层 ${s.routesTracedToService}/${s.routes}，部分入口断链`);
  }
  if (s.parseFailed) {
    down('medium');
    reasons.push(`${s.parseFailed} 个文件解析失败，不在图上`);
  }
  if (!graph.ok) {
    down('low');
    reasons.push('建图失败');
  }
  if (!reasons.length) reasons.push('调用解析与路由追通率都在可用范围');
  return {
    level,
    reasons,
    resolvedCalls: s.resolvedCalls,
    totalCalls: s.calls,
    tracedRoutes: s.routesTracedToService,
    totalRoutes: s.routes,
    parseFailed: s.parseFailed,
    warnings: graph.warnings ?? [],
  };
}

export function computeHealth(graph: CodeGraph, input: HealthInput): HealthReport {
  const ids = functionIds(graph);
  const enclosing = enclosingIndex(graph);

  // 被调：按 file#name 计。同文件同名多份实现（不同接收器）时都记上 —— 宁可高估
  const fanInByKey = new Map<string, number>();
  const callSites = new Map<FunctionNode, number>();
  const targets = new Map<FunctionNode, Set<string>>();
  for (const c of graph.calls) {
    if (c.toFile) {
      const k = `${c.toFile}#${c.toMethod}`;
      fanInByKey.set(k, (fanInByKey.get(k) ?? 0) + 1);
    }
    const from = enclosing(c.fromFile, c.line);
    if (!from) continue;
    callSites.set(from, (callSites.get(from) ?? 0) + 1);
    if (c.toFile) {
      const set = targets.get(from) ?? new Set<string>();
      set.add(`${c.toFile}#${c.toMethod}`);
      targets.set(from, set);
    }
  }

  const functions: FnMetric[] = graph.functions.map((f) => {
    const loc = Math.max(1, f.endLine - f.line + 1);
    const cs = callSites.get(f) ?? 0;
    const fanIn = fanInByKey.get(`${f.file}#${f.name}`) ?? 0;
    return {
      id: ids.get(f)!,
      file: f.file,
      name: f.name,
      owner: f.owner ?? null,
      line: f.line,
      loc,
      callSites: cs,
      fanOut: targets.get(f)?.size ?? 0,
      fanIn,
      cx: loc * cs,
      god: loc >= GOD_MIN_LOC && fanIn >= GOD_MIN_FAN_IN,
    };
  });

  const inCycle = new Set(input.cycles.flat());
  const oversize = new Map(input.oversize.map((o) => [o.file, o.lines]));
  const fnCount = new Map<string, number>();
  const maxEnd = new Map<string, number>();
  for (const f of graph.functions) {
    fnCount.set(f.file, (fnCount.get(f.file) ?? 0) + 1);
    maxEnd.set(f.file, Math.max(maxEnd.get(f.file) ?? 0, f.endLine));
  }
  const files: FileMetric[] = graph.modules.map((m) => {
    const lines = oversize.get(m.file) ?? input.lineCount?.(m.file) ?? maxEnd.get(m.file) ?? null;
    return {
      file: m.file,
      lines,
      oversize: oversize.has(m.file),
      fns: fnCount.get(m.file) ?? 0,
      imports: m.imports.length,
      importedBy: m.importedBy.length,
      inCycle: inCycle.has(m.file),
    };
  });

  const top = (key: (f: FnMetric) => number, n: number, filter: (f: FnMetric) => boolean = () => true) =>
    functions
      .filter((f) => filter(f) && key(f) > 0)
      .sort((a, b) => key(b) - key(a) || a.id.localeCompare(b.id))
      .slice(0, n)
      .map((f) => f.id);

  const audit = input.audit
    ? {
        ruleCount: input.audit.ruleCount,
        deadRules: input.audit.stats.deadRules,
        leakyRules: input.audit.stats.leakyRules,
        staleEvidence: input.audit.stats.staleEvidence,
        problems: input.audit.rules
          .filter((r) => r.severity === 'warn' || r.severity === 'error')
          .map((r) => ({ ruleId: r.ruleId, severity: r.severity, summary: r.summary })),
      }
    : null;

  return {
    schemaVersion: HEALTH_SCHEMA_VERSION,
    repo: input.repo,
    analyzer: graph.analyzer ?? null,
    headSha: input.headSha,
    builtAt: graph.builtAt,
    generatedAt: Date.now(),
    scale: {
      files: graph.stats.files,
      functions: graph.functions.length,
      classes: graph.classes.length,
      calls: graph.calls.length,
      routes: graph.routes.length,
      fields: (graph.fields ?? []).length,
    },
    trust: trustOf(graph),
    lineLimit: input.lineLimit,
    godRule: { minLoc: GOD_MIN_LOC, minFanIn: GOD_MIN_FAN_IN },
    functions,
    files,
    lists: {
      god: top((f) => f.fanIn * f.loc, 30, (f) => f.god),
      biggest: top((f) => f.loc, 20),
      hottest: top((f) => f.fanIn, 20),
      complex: top((f) => f.cx, 20),
      oversize: input.oversize,
      cycles: input.cycles,
    },
    hotSpots: hotSpots(graph, 10),
    blindSpots: graph.blindSpots ?? [],
    publicLayer: input.publicLayer ?? [],
    audit,
  };
}
