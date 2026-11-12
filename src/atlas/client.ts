/**
 * code-atlas 客户端 —— repo-guard 的全部图谱能力都来自外部 CLI `atlas`。
 *
 * repo-guard 不再自带图谱引擎：impact / hot / similar / scan / conform 都由 code-atlas 提供，
 * AI 侧走 code-atlas 的 MCP（mcp__code-atlas__atlas_*），钩子侧只能子进程调 `atlas … --json`。
 *
 * ── 定位 ──
 *   环境变量显式绑定 → 本机 atlas.json → 未绑定时发现 PATH 安装。
 *   所有调用使用同一 Node + bin/atlas 绝对路径，显式路径失效不回退。
 *
 * ── 失败语义 ──
 * 调用方几乎都在钩子里，任何失败都要 fail-open。所以这里从不抛异常，只返回三种失败：
 *   missing —— 没装 atlas（spawn ENOENT）
 *   stale   —— `--cache-only` 时缓存缺失（atlas 退出码 3，stdout `{stale:true}`）
 *   error   —— 其余（超时、非零退出、输出不是 JSON）
 */
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import { resolveBinding, selectedWorkspace } from './binding.js';

/** 钩子里的默认超时。钩子预算 5~15 秒，atlas 读缓存通常 < 1 秒 */
export const ATLAS_HOOK_TIMEOUT_MS = 8000;

export type AtlasResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'missing' | 'stale' | 'error'; message: string };

export interface AtlasRunOptions {
  cwd: string;
  timeoutMs?: number;
  /** stdout 继承到当前进程（给人看的命令透传用） */
  inherit?: boolean;
}

/** 原样调用唯一绑定的工具包；不经 shell 拼接参数。 */
export function atlasRun(args: string[], opts: AtlasRunOptions): SpawnSyncReturns<string> {
  try {
    const binding = resolveBinding();
    const workspace = selectedWorkspace(opts.cwd);
    const finalArgs = [...args];
    if (workspace && !args.some((a) => a === '--ws' || a.startsWith('--ws=')) &&
        !['version', 'ws', 'install', 'uninstall', 'mcp', 'doctor'].includes(args[0])) finalArgs.push('--ws', workspace);
    return spawnSync(binding.node, [binding.bin, ...finalArgs], {
      cwd: opts.cwd, encoding: 'utf-8', timeout: opts.timeoutMs,
      stdio: opts.inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    return { pid: 0, output: [], stdout: '', stderr: '', status: null, signal: null, error: error as Error };
  }
}

/** 仅启动原生 Atlas MCP，stdio 完全透传，不定义第二套图谱工具。 */
export function runAtlasMcp(): Promise<number> {
  const binding = resolveBinding();
  const workspace = selectedWorkspace(process.cwd());
  return new Promise((resolve) => {
    const child = spawn(binding.node, [binding.bin, 'mcp'], {
      cwd: process.cwd(), stdio: 'inherit',
      env: { ...process.env, ...(workspace ? { ATLAS_WORKSPACE: workspace } : {}) },
    });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const finish = (code: number) => {
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); resolve(code);
    };
    child.on('error', (e) => { process.stderr.write('code-atlas MCP 启动失败：' + e.message + '\n'); finish(2); });
    child.on('exit', (code, signal) => finish(code ?? (signal ? 1 : 0)));
  });
}

function isMissing(r: SpawnSyncReturns<string>): boolean {
  return (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** 跑 `atlas <args>` 并解析 JSON（调用方自己带 --json） */
export function atlasJson<T = Record<string, unknown>>(
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
): AtlasResult<T> {
  const r = atlasRun(args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? ATLAS_HOOK_TIMEOUT_MS });
  if (isMissing(r)) return { ok: false, reason: 'missing', message: '找不到 atlas（npm i -g @tencent/code-atlas）' };
  if (r.error) return { ok: false, reason: 'error', message: r.error.message };
  let data: unknown;
  try {
    data = JSON.parse(r.stdout || '');
  } catch {
    data = undefined;
  }
  const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  if (r.status === 3 || obj?.stale === true) {
    return { ok: false, reason: 'stale', message: typeof obj?.message === 'string' ? obj.message : '图谱缓存缺失' };
  }
  if (r.status !== 0 || !obj || Array.isArray(obj)) {
    return { ok: false, reason: 'error', message: (r.stderr || r.stdout || `atlas 退出码 ${r.status}`).trim().slice(0, 500) };
  }
  return { ok: true, data: obj as T };
}

let availableCache: boolean | null = null;

/** atlas 装了没有（进程内缓存） */
export function atlasAvailable(): boolean {
  if (availableCache !== null) return availableCache;
  const r = atlasRun(['version'], { cwd: process.cwd(), timeoutMs: 5000 });
  availableCache = !isMissing(r) && !r.error && r.status === 0;
  return availableCache;
}

/** atlas 版本号（拿不到为 null） */
export function atlasVersion(): string | null {
  const r = atlasRun(['version'], { cwd: process.cwd(), timeoutMs: 5000 });
  return !r.error && r.status === 0 ? r.stdout.trim() || null : null;
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

interface ListOut {
  workspace?: string;
  repos?: Array<{ id: string; path: string; role?: string; stats?: { files?: number; nodes?: number; edges?: number } }>;
}

/** 本仓在 atlas 当前工作区里的登记（不在 → null） */
export function atlasRepoEntry(
  repoDir: string,
  timeoutMs = ATLAS_HOOK_TIMEOUT_MS,
  workspace?: string,
): { workspace: string; id: string; path: string; role?: string; stats?: { files?: number; nodes?: number; edges?: number } } | null {
  const r = atlasJson<ListOut>(['list', '--json', '--metadata-only', ...(workspace ? ['--ws', workspace] : [])], { cwd: repoDir, timeoutMs });
  if (!r.ok) return null;
  const want = real(repoDir);
  const hit = (r.data.repos ?? []).find((x) => real(x.path) === want);
  return hit ? { workspace: r.data.workspace ?? 'default', ...hit } : null;
}
