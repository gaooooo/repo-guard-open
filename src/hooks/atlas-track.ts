/** 只消费 Atlas 查询回执；符号解析、仓定位和参考计划由工具包提供。 */
import fs from 'node:fs';
import path from 'node:path';
import { atlasJson } from '../atlas/client.js';
import { resolveBinding } from '../atlas/binding.js';
import { toRepoRelative } from '../runtime/paths.js';
import { record } from '../runtime/metrics.js';
import { recordQueried, recordHotQuery, recordSimilarSearch, recordSimilarPlan, type SimilarPlan } from '../runtime/session-state.js';

const KINDS = new Set(['impact', 'trace', 'similar', 'hot']);

export function trackAtlasReceipt(raw: unknown, expectedKind?: string): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 1 || r.status !== 'ok' || typeof r.kind !== 'string' || !KINDS.has(r.kind) ||
      (expectedKind && r.kind !== expectedKind) || typeof r.workspace !== 'string' || !Array.isArray(r.repos)) return false;
  const repos = new Map<string, string>();
  for (const item of r.repos) {
    if (!item || typeof item.id !== 'string' || typeof item.path !== 'string' || !path.isAbsolute(item.path)) return false;
    try { if (!fs.statSync(item.path).isDirectory()) return false; repos.set(item.id, fs.realpathSync(item.path)); } catch { return false; }
  }
  if (r.kind === 'impact' || r.kind === 'trace') {
    if (!Array.isArray(r.targets) || !r.targets.length) return false;
    const hits: Array<{ repo: string; rel: string }> = [];
    for (const target of r.targets) {
      const repo = repos.get(target?.repo);
      if (!repo || typeof target.file !== 'string' || path.isAbsolute(target.file)) return false;
      const rel = toRepoRelative(repo, target.file);
      if (!rel) return false;
      hits.push({ repo, rel });
    }
    for (const { repo, rel } of hits) {
      // trace 只留痕，不冒充查过上游影响面。
      if (r.kind === 'impact') recordQueried(repo, rel);
      record('graph_query', repo, { file: rel, detail: r.kind + '@' + r.workspace });
    }
  } else {
    for (const repo of repos.values()) {
      if (r.kind === 'hot') recordHotQuery(repo);
      else recordSimilarSearch(repo, 'atlas:' + r.workspace);
      record('graph_query', repo, { detail: r.kind + '@' + r.workspace });
    }
    const p = r.plan as Partial<SimilarPlan> | undefined;
    if (r.kind === 'similar' && p && typeof p.repo === 'string' && repos.has(p.repo) && typeof p.key === 'string' &&
        typeof p.resource === 'string' && ['new', 'gap', 'exists'].includes(p.kind ?? '') &&
        Array.isArray(p.keys) && Array.isArray(p.skeleton) && Array.isArray(p.planned)) {
      recordSimilarPlan(repos.get(p.repo)!, { ...(p as SimilarPlan), workspace: r.workspace });
      record('similar_plan', repos.get(p.repo)!, { detail: p.resource + '<-' + (p.template ?? '') });
    }
  }
  return true;
}

/** code-atlas MCP 工具名前缀：插件内注册是 mcp__plugin_repo_guard_code_atlas__，单独安装是 mcp__code-atlas__ */
export const ATLAS_MCP_PREFIX = /^mcp__(?:plugin_repo_guard_code_atlas|code-atlas)__/;

export function trackAtlasTool(cwd: string, toolName: string, input: Record<string, unknown>, response?: Record<string, unknown>): void {
  if (response && (response.isError === true || response.is_error === true || response.error || response.success === false)) return;
  const tool = toolName.replace(ATLAS_MCP_PREFIX, '');
  const kind = tool === 'atlas_impact' ? 'impact' : tool === 'atlas_trace' ? 'trace' : undefined;
  if (!kind && tool !== 'atlas_reuse') return;
  const reuse = tool === 'atlas_reuse' ? (input.kind === 'similar' || input.resource || (Array.isArray(input.verbs) && input.verbs.length) ? 'similar' : 'hot') : undefined;
  const structured = response?.structuredContent as { receipt?: unknown } | undefined;
  if (structured?.receipt && trackAtlasReceipt(structured.receipt, kind ?? reuse)) return;
  // 延迟加载的 MCP 工具经 DeferExecuteTool 代理调用时，钩子拿不到 structuredContent：
  // 按同样的参数只读缓存再查一次，拿回执记账（不建图）
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const pick = [...(str(input.repo) ? ['--repo', str(input.repo)] : []), ...(str(input.workspace) ? ['--ws', str(input.workspace)] : [])];
  let args: string[] | null = null;
  if (kind && str(input.target)) args = [kind, str(input.target), ...pick];
  else if (reuse && str(input.intent)) {
    args = reuse === 'similar'
      ? ['similar', str(input.intent), ...(str(input.resource) ? ['--resource', str(input.resource)] : []), ...pick]
      : ['hot', str(input.intent), ...pick];
  }
  if (!args) return;
  const r = atlasJson<{ receipt?: unknown }>([...args, '--json', '--cache-only'], { cwd, timeoutMs: 7000 });
  if (r.ok) trackAtlasReceipt(r.data.receipt, kind ?? reuse);
}

/** 仅识别单条、无变量的成功查询；复杂 shell 不作为查询凭据。 */
export function trackAtlasBash(cwd: string, command: string): void {
  const simple = command.replace(/^\s*cd\s+(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s*&&\s*/, '');
  if (/[;&|\n$<>`]/.test(simple)) return;
  const words = [...simple.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  let index = 1;
  const binding = resolveBinding();
  if (words[0] === 'atlas') {
    const installed = (process.env.PATH ?? '').split(path.delimiter).map((dir) => path.join(dir, 'atlas')).find((file) => fs.existsSync(file));
    if (!installed || fs.realpathSync(installed) !== binding.bin) return;
  } else {
    if (words[0] !== binding.node || words[1] !== binding.bin) return;
    index = 2;
  }
  const kind = words[index];
  if (!['impact', 'similar', 'hot', 'trace'].includes(kind)) return;
  // 成功执行后只读同一工具包的缓存，绝不在 hook 中建图。
  const args = words.slice(index).filter((w) => w !== '--json' && w !== '--cache-only');
  const result = atlasJson<{ receipt?: unknown }>([...args, '--json', '--cache-only'], { cwd, timeoutMs: 7000 });
  if (result.ok) trackAtlasReceipt(result.data.receipt, kind);
}