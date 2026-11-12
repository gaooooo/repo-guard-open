import path from 'node:path';
import fs from 'node:fs';
import { bindAtlas, rememberWorkspace, resolveBinding, selectedWorkspace } from '../atlas/binding.js';
import { atlasAvailable, atlasJson, atlasRepoEntry, atlasRun, atlasVersion, runAtlasMcp } from '../atlas/client.js';
import type { AtlasInitInfo, HotSpot, ScanResult } from './init.js';
import { trackAtlasReceipt } from '../hooks/atlas-track.js';
import { adoptSessionFor } from '../runtime/session-state.js';
import { findRepoRoot } from '../runtime/paths.js';

interface Workspace { name: string; repos: Array<{ id: string; path: string }>; }

export function atlasWorkspaceFor(repoDir: string, explicit?: string): string {
  if (explicit) return explicit;
  const selected = selectedWorkspace(repoDir);
  if (selected) return selected;
  const list = atlasJson<{ current: string; workspaces: Workspace[] }>(['ws', 'list', '--json'], { cwd: repoDir });
  // 新机器上还没有任何工作区：atlas add 会创建 default
  if (!list.ok && /还没有工作区/.test(list.message)) return 'default';
  if (!list.ok || !Array.isArray(list.data.workspaces)) throw new Error(list.ok ? 'code-atlas 不支持工作区清单，请更新工具包' : list.message);
  const root = fs.realpathSync(repoDir);
  const hits = list.data.workspaces.filter((w) => w.repos.some((r) => r.path === root));
  if (hits.length > 1) throw new Error('本仓属于多个图谱工作区：' + hits.map((w) => w.name).join('、') + '。请用 --ws 指定一次');
  return hits[0]?.name ?? list.data.current;
}

/** --write 才准备索引；预览只消费已有缓存，绝不隐式 add/sync。 */
export function collectAtlasForInit(repoDir: string, lineLimit: number, opts: { write: boolean; workspace?: string; withRepos?: string[] }): AtlasInitInfo {
  if (!atlasAvailable()) return { available: false, hot: null, scan: null };
  const version = atlasVersion();
  const workspace = atlasWorkspaceFor(repoDir, opts.workspace);
  const repos = [repoDir, ...(opts.withRepos ?? []).map((p) => fs.realpathSync(path.resolve(repoDir, p)))];
  let entry = atlasRepoEntry(repoDir, 8000, workspace);
  let addedMs: number | undefined;
  if (opts.write) {
    bindAtlas();
    // add 是幂等的，已登记且有效的索引由 Atlas 复用，不删除缓存。
    const t0 = Date.now();
    const r = atlasRun(['add', ...repos, '--ws', workspace], { cwd: repoDir, timeoutMs: 600_000 });
    if (r.error || r.status !== 0) return { available: true, version, workspace, error: 'atlas add 失败：' + (r.error?.message || r.stderr || r.stdout).trim().slice(0, 300), hot: null, scan: null };
    if (!entry) addedMs = Date.now() - t0;
    rememberWorkspace(repos, workspace);
    entry = atlasRepoEntry(repoDir, 8000, workspace);
  }
  if (!entry) return { available: true, version, workspace, error: '本仓未准备图谱。执行 repo-guard init --write' + (opts.workspace ? ' --ws ' + workspace : '') + '；预览不会建图', hot: null, scan: null };
  const base = { available: true, version, workspace, repoId: entry.id, addedMs };
  const pick = ['--ws', workspace, '--repo', repoDir, '--json', '--cache-only'];
  const opt = { cwd: repoDir, timeoutMs: 8000 };
  const hot = atlasJson<{ hot?: HotSpot[] }>(['hot', '--limit', '200', ...pick], opt);
  if (!hot.ok) return { ...base, error: hot.message, hot: null, scan: null };
  const scan = atlasJson<ScanResult>(['scan', '--line-limit', String(lineLimit), ...pick], opt);
  const listing = atlasJson<{ repos?: Array<{ id: string; role?: string; stats?: { files?: number; nodes?: number; edges?: number } }> }>(['list', '--ws', workspace, '--json', '--cache-only'], opt);
  const meta = listing.ok ? listing.data.repos?.find((r) => r.id === entry.id) : undefined;
  return { ...base, role: meta?.role, stats: meta?.stats, hot: hot.data.hot ?? [], scan: scan.ok ? scan.data : null, error: scan.ok ? undefined : scan.message };
}

export async function runAtlasCommand(argv: string[]): Promise<number> {
  if (argv[0] === 'mcp') return runAtlasMcp();
  if (argv[0] === 'bind') {
    const i = argv.indexOf('--node');
    if (i >= 0 && !argv[i + 1]) throw new Error('--node 需要 Node 可执行文件路径');
    const binding = bindAtlas(argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined, i >= 0 ? argv[i + 1] : undefined);
    process.stdout.write('已绑定 code-atlas ' + binding.version + '\nNode：' + binding.node + '\nAtlas：' + binding.bin + '\n请重开助手会话使 MCP 使用此绑定。\n');
    return 0;
  }
  if (argv[0] === 'status') {
    const binding = resolveBinding();
    const r = atlasJson<{ version?: string; sourceCommit?: string }>(['version', '--json'], { cwd: process.cwd() });
    if (!r.ok) throw new Error(r.message);
    process.stdout.write(JSON.stringify({ ...binding, version: r.data.version, sourceCommit: r.data.sourceCommit }, null, 2) + '\n');
    return 0;
  }
  if (['impact', 'trace', 'hot', 'similar'].includes(argv[0])) {
    adoptSessionFor(findRepoRoot(process.cwd()));
    const args = argv.includes('--json') ? argv : [...argv, '--json'];
    const r = atlasRun(args, { cwd: process.cwd() });
    if (r.error) { process.stderr.write('code-atlas 调用失败：' + r.error.message + '\n'); return 2; }
    if (r.stderr) process.stderr.write(r.stderr);
    let data: { receipt?: unknown; text?: string } | undefined;
    try { data = JSON.parse(r.stdout); } catch { /* 歧义文本不作为成功查询 */ }
    if (r.status === 0 && data?.receipt) trackAtlasReceipt(data.receipt, argv[0]);
    process.stdout.write(!argv.includes('--json') && typeof data?.text === 'string' ? data.text + '\n' : r.stdout);
    return r.status ?? 2;
  }
  const r = atlasRun(argv, { cwd: process.cwd(), inherit: true });
  if (r.error) { process.stderr.write('code-atlas 调用失败：' + r.error.message + '\n'); return 2; }
  return r.status ?? 2;
}