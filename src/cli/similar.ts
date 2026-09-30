/**
 * similar 的分派：有页面指纹走前端同类页，没有就走后端方法家族。
 *
 * CLI 与 MCP 共用这一处 —— 两边分叉就会出现"终端里查得到、AI 查不到"。
 */
import { decorate, renderSimilar, type ReportContext } from '../graph/graph-report.js';
import type { CodeGraph } from '../graph/types.js';
import {
  familyKey,
  renderSimilarMethods,
  similarMethods,
  type SimilarMethodsResult,
  type SimilarQuery,
  type VerbChain,
} from '../insight/similar-methods.js';
import type { SimilarPlan } from '../runtime/session-state.js';
import { sourceReader } from './render.js';

/** verbs 入参：数组或逗号分隔的字符串（模型两种都会传） */
export function verbsArg(v: unknown): string[] | undefined {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，\s]+/) : [];
  const out = arr.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return out.length ? out : undefined;
}

/** similar 的入参。intent 与 resource 至少给一个 */
export interface SimilarArgs {
  intent: string;
  resource?: string;
  verbs?: string[];
  /** 指定参考家族 */
  template?: string;
  limit: number;
}

/** 后端检索的完整查询：CLI / MCP / 沙盘高亮共用，保证三处同一次计算 */
export function similarQueryOf(graph: CodeGraph, a: SimilarArgs): SimilarQuery {
  return { intent: a.intent, resource: a.resource, verbs: a.verbs, template: a.template, limit: a.limit, readSource: sourceReader(graph) };
}

export function renderSimilarAuto(graph: CodeGraph, a: SimilarArgs, ctx: ReportContext): string {
  return runSimilar(graph, a, ctx).text;
}

type Plan = Omit<SimilarPlan, 'repo' | 'ts'>;

/** similar 的结论落成计划：记进会话，给新建门按资源判定、给写后比对当标尺 */
export function planOf(r: SimilarMethodsResult): Plan | null {
  if (r.unmatchedReason) return null;
  const keys = [...new Set([...r.resourceCandidates, r.wantResource].filter(Boolean).map((c) => familyKey(c)))];
  const layers = (chain?: Array<{ layer: string }>) => (chain ?? []).map((x) => x.layer);
  const flat = (cs: VerbChain[]) => cs.flatMap((c) => c.planned.map((p) => ({ layer: p.layer, file: p.file, name: p.name, reuse: p.reuse })));
  const deepest = (cs: VerbChain[]) => cs.map((c) => c.chain).sort((x, y) => y.length - x.length)[0];
  if (r.template) {
    const t = r.template;
    return { key: familyKey(r.wantResource), resource: r.wantResource, keys, template: t.family.family, skeleton: layers(deepest(t.chains)), planned: flat(t.chains), kind: 'new' };
  }
  const fam = r.families[0];
  if (!fam) return null;
  if (r.verbTemplates.length) {
    const cs = r.verbTemplates.map((v) => v.chain);
    return { key: fam.key, resource: r.wantResource, keys: [...new Set([...keys, fam.key])], template: r.verbTemplates[0].family, skeleton: layers(deepest(cs)), planned: flat(cs), kind: 'gap' };
  }
  return { key: fam.key, resource: r.wantResource, keys: [...new Set([...keys, fam.key])], template: fam.family, skeleton: layers(fam.reference?.chain), planned: [], kind: 'exists' };
}

/** 文本（给 AI / 人看）与计划（给守卫与写后比对）来自同一次计算 */
export function runSimilar(graph: CodeGraph, a: SimilarArgs, ctx: ReportContext): { text: string; plan: Plan | null } {
  if ((graph.pageFingerprints ?? []).length > 0) {
    return { text: renderSimilar(graph, { intent: a.intent || a.resource || '', limit: a.limit }, ctx), plan: null };
  }
  const r = similarMethods(graph, similarQueryOf(graph, a));
  const plan = planOf(r);
  const text = renderSimilarMethods(r, ctx.repoName);
  if (r.unmatchedReason) return { text, plan };
  const files = r.families.flatMap((f) => f.members.map((m) => m.file));
  return { text: decorate(text.split('\n'), graph, ctx, files), plan };
}
