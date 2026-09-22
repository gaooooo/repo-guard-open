/**
 * trace 的入口包装 —— 决定"这个路径算不算命中"，以及没命中时说什么。
 *
 * ── 为什么不直接调 engine 的 renderTrace ──
 * `traceRoute` 内部的匹配比 `findRoute` 宽：它还会拿末段（Action 名）去撞。
 * 那个宽松度在 deerclaw 里是对的 —— 那边 agent 拿到的是后端 Action 名
 *（`DescribeXxx`），路径前缀经常对不上。
 *
 * 但在这里是错的：前端仓查 `/api/users` 时，宽松匹配会把它撞到页面路由
 * `PAGE /users` 上，然后一本正经地输出那个页面的调用链。模型会当成
 * "这个后端接口的实现在这儿"，得出完全错误的结论。**给错答案比给不出答案坏得多。**
 *
 * 所以这里先用严格匹配把门；进不来就明确说"图谱里没有"。
 *
 * ── 为什么不用 engine 的 findRoute ──
 * 它在精确匹配失败后还会拿**末段**去撞（`/api/users` 的末段 `users`
 * 撞上页面路由 `/users`）。那一层是给后端 Action 名设计的，在前端仓里
 * 恰好制造了上面说的那种错误答案。所以只保留它的前两级：精确、
 * 以及忽略首尾斜杠与大小写。
 */
import { renderTrace, type ReportContext } from '../graph/graph-report.js';
import type { CodeGraph } from '../graph/types.js';

/** 去掉可能带的 HTTP 动词前缀（`GET /x` → `/x`） */
const METHOD_PREFIX = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|PAGE)\s+/i;

function norm(s: string): string {
  return s.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
}

/** 严格匹配：精确，或忽略首尾斜杠与大小写。**不做末段匹配。** */
function strictFind(graph: CodeGraph, urlPath: string) {
  const raw = (urlPath ?? '').trim().replace(METHOD_PREFIX, '').trim();
  if (!raw) return null;
  const routes = graph.routes ?? [];
  const exact = routes.find((r) => r.urlPath === raw);
  if (exact) return exact;
  const key = norm(raw);
  if (!key) return null;
  return routes.find((r) => norm(r.urlPath) === key) ?? null;
}

export function traceOrMiss(graph: CodeGraph, urlPath: string, ctx: ReportContext): string {
  if (!strictFind(graph, urlPath)) {
    // 提"区分大小写"是因为后端 Action 名大小写敏感，而人复制粘贴时经常丢掉大小写；
    // 提"不在本仓"是因为前后端分仓时这是最常见的原因，省掉一轮来回
    return `图谱里没有 \`${urlPath}\` 这个接口。请确认路径拼写（区分大小写），或该接口不在本仓。`;
  }
  return renderTrace(graph, urlPath, ctx);
}
