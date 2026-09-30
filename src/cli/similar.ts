/**
 * similar 的分派：有页面指纹走前端同类页，没有就走后端方法家族。
 *
 * CLI 与 MCP 共用这一处 —— 两边分叉就会出现"终端里查得到、AI 查不到"。
 */
import { decorate, renderSimilar, type ReportContext } from '../graph/graph-report.js';
import type { CodeGraph } from '../graph/types.js';
import { renderSimilarMethods, similarMethods } from '../insight/similar-methods.js';

export function renderSimilarAuto(graph: CodeGraph, intent: string, limit: number, ctx: ReportContext): string {
  if ((graph.pageFingerprints ?? []).length > 0) {
    return renderSimilar(graph, { intent, limit }, ctx);
  }
  const r = similarMethods(graph, { intent, limit });
  const text = renderSimilarMethods(r, ctx.repoName);
  if (r.unmatchedReason) return text;
  const files = r.families.flatMap((f) => f.members.map((m) => m.file));
  return decorate(text.split('\n'), graph, ctx, files);
}
