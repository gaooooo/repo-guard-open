/**
 * v2 过程控制的钩子逻辑。hooks/index.ts 在各事件里调这里，再把结果并进自己的输出。
 *
 * 只对接入了 v2 的仓生效（项目层 .codebuddy/repo-guard.json 存在）。写前只输出 deny / ask
 * 或什么都不输出；remind 档一律在写后用 additionalContext 提醒（PreToolUse 没有「只提醒」的输出，
 * allow 会绕过用户的权限确认）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { atlasAvailable, atlasJson, atlasRepoEntry } from '../atlas/client.js';
import { record } from '../runtime/metrics.js';
import { repoId, stateRoot } from '../runtime/paths.js';
import {
  bashRuns,
  claimStopNotice,
  consecutiveFailCount,
  fileWriteFailCount,
  getBaseline,
  getContract,
  setBaselineOnce,
  snapshotContent,
  guardNotes,
  hasHotQueried,
  hasSimilarSearched,
  lastWriteAt,
  readBefore,
  recordBashRun,
  recordWrite,
  resetAfterLoopBlock,
  scopeExpansions,
  snapshotBefore,
  writtenFiles,
  writtenKeys,
  type TaskContract,
} from '../runtime/session-state.js';
import { baselineText, contractMode, effective, loadControl, type ControlConfig, type LoadedControl } from './config.js';
import { detectGates } from './project.js';
import { complexityIssues, complexityText, computeReceipt, pendingItems, renderReceipt, type FileChange, type ReceiptExtras } from './receipt.js';
import { commandRedlines, contractLine, contractText, inScope, isAuxFile, pathRedlines } from './scope.js';
import { contentHits, fieldHits, type RedHit } from './redlines.js';
import { computeAfter, type WriteToolInput } from '../gates/admission.js';

const cache = new Map<string, LoadedControl>();

export function control(repoDir: string): LoadedControl {
  let c = cache.get(repoDir);
  if (!c) cache.set(repoDir, (c = loadControl(repoDir)));
  return c;
}

export function v2Active(repoDir: string): boolean {
  return control(repoDir).active;
}

// 插件内注册的 MCP 工具名：宿主把插件名、服务名里的连字符转成下划线
const TASK_TOOL = 'guard_task（mcp__plugin_repo_guard_repo_guard__guard_task）';
const NOTE_TOOL = 'guard_note（mcp__plugin_repo_guard_repo_guard__guard_note）';
const REUSE_TOOL = 'atlas_reuse（mcp__plugin_repo_guard_code_atlas__atlas_reuse）';

// ══════════════════ 注入 ══════════════════

function contractBlock(c: TaskContract, cfg: ControlConfig): string {
  return '当前任务契约（' + TASK_TOOL + ' 声明）：\n' + contractText(c, cfg.verify.commands);
}

/** 会话开始 / 压缩后 / 子代理启动：基线 + 契约全量 */
export function injectionFor(repoDir: string): string {
  const { cfg } = control(repoDir);
  const parts = cfg.mode === 'off' ? [] : [baselineText(cfg)];
  const mode = contractMode(cfg);
  if (mode !== 'off') {
    parts.push(
      (mode === 'required' ? '写代码前' : '要改多个文件时') +
        '先调 ' + TASK_TOOL + ' 声明任务契约（目标、不做什么、范围、验收命令）；范围外发现的问题用 ' + NOTE_TOOL + ' 记下，不要顺手改。',
    );
  }
  const fields = cfg.redlines.fields;
  if (fields.length) {
    parts.push(
      '受保护字段（不许删除或改名，改动会被拦下）：\n' +
        fields.map((f) => '- ' + f.protects.join('、') + (f.paths.length ? '（' + f.paths.join(', ') + '）' : '') + (f.reason ? '：' + f.reason : '')).join('\n'),
    );
  }
  const c = getContract();
  if (c) parts.push(contractBlock(c, cfg));
  return parts.join('\n\n');
}

/** init 后第一个会话给开发者看一行「启用了什么」，之后不再显示（配置变了再显示一次） */
export function announceOnce(repoDir: string, label: string): string {
  const { cfg } = control(repoDir);
  const sig = JSON.stringify(cfg);
  let h = 0;
  for (let i = 0; i < sig.length; i++) h = (h * 31 + sig.charCodeAt(i)) | 0;
  const marker = path.join(stateRoot(), 'state', '_announced', repoId(repoDir) + '-' + (h >>> 0).toString(36));
  try {
    if (fs.existsSync(marker)) return '';
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, String(Date.now()));
  } catch {
    return '';
  }
  const gates = detectGates(repoDir).filter((g) => g.installed).map((g) => g.kind);
  return (
    'repo-guard 已启用' + (label ? '（' + label + '）' : '') + '：档位 ' + cfg.mode + '、契约 ' + contractMode(cfg) +
    '、红线 ' + (cfg.redlines.paths.length + cfg.redlines.commands.length) + ' 条、公共层 ' + cfg.publicLayer.length + ' 个、合并门 ' +
    (gates.length ? gates.join(' / ') : '未加') + '；repo-guard status 查看详情'
  );
}

export function promptLine(): string {
  const c = getContract();
  return c ? contractLine(c) : '';
}

// ══════════════════ 写前 ══════════════════

export interface Decision {
  kind: 'deny' | 'ask';
  reason: string;
}

function exists(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function readText(abs: string): string | null {
  try {
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

function redHitText(rel: string, h: RedHit): string {
  return '`' + rel + '` ' + h.detail + (h.reason ? '。原因：' + h.reason : '') + '。';
}

export function preWrite(repoDir: string, rel: string, abs: string, input: WriteToolInput = {}): Decision | null {
  const { cfg } = control(repoDir);
  snapshotBefore(repoDir, rel, abs);

  // ⓪ 字段 / 内容红线：按这次写入算出改后内容再判。算不出（参数形状不认识）就交给写后提醒
  if (cfg.redlines.fields.length || cfg.redlines.content.length) {
    const before = readText(abs);
    const after = computeAfter(before, input);
    const hits = [...fieldHits(cfg.redlines.fields, rel, before, after), ...contentHits(cfg.redlines.content, rel, before, after)].filter((h) => h.action !== 'remind');
    const h = hits.find((x) => x.action === 'block') ?? hits[0];
    if (h) {
      record('redline_deny', repoDir, { file: rel, detail: h.kind + ':' + h.action });
      const why = redHitText(rel, h);
      return h.action === 'block'
        ? {
            kind: 'deny',
            reason:
              why +
              (h.kind === 'field'
                ? '这是开发者明确写下的受保护字段，不要删除或改名，也不要换个写法绕开（包括用 shell 写）。确实需要改，请停下来说明原因、请开发者处理。'
                : '不要把这类内容写进代码；需要时从环境变量或密钥管理服务读取。'),
          }
        : { kind: 'ask', reason: why + '需要开发者确认。' };
    }
  }

  // ① 红线：不受 mode 约束，按条目 action
  for (const r of pathRedlines(cfg.redlines.paths, rel)) {
    if (r.action === 'remind') continue;
    record('redline_deny', repoDir, { file: rel, detail: r.action + ':' + r.glob });
    const why = '\u0060' + rel + '\u0060 命中红线 ' + r.glob + (r.reason ? '：' + r.reason : '') + '。';
    return r.action === 'block'
      ? { kind: 'deny', reason: why + '这是开发者明确写下的禁改约束，不要绕开（包括用 shell 写）。确实需要改，请停下来说明原因、请开发者处理。' }
      : { kind: 'ask', reason: why + '需要开发者确认。' };
  }

  if (cfg.mode === 'off') return null;
  const contract = getContract();
  const aux = isAuxFile(rel);

  // ② 契约缺失：默认档下也拒绝一次（DESIGN-v2 3.3 的例外）
  const mode = contractMode(cfg);
  if (mode !== 'off' && !contract && !aux) {
    const me = repoId(repoDir) + ':' + rel;
    const others = writtenKeys().filter((k) => k !== me && !isAuxFile(k.slice(k.indexOf(':') + 1)));
    if ((mode === 'required' || others.length >= 1) && claimStopNotice('contract-deny')) {
      record('contract_deny', repoDir, { file: rel });
      return {
        kind: 'deny',
        reason:
          '这次任务要改多个文件，先声明任务契约再继续：调用 ' + TASK_TOOL + '，填 goal（目标）、nonGoals（不做什么）、' +
          'scope（允许改动的文件 / 目录 glob，尽量收窄）、verify（验收命令）。契约会展示给开发者；声明后重试这次写入。（本提醒每会话一次，由 repo-guard 提供）',
      };
    }
  }

  // ③ enforce 档：越界弹窗、新建前没查现成实现就拒绝
  if (contract && !aux && !inScope(contract, rel, abs) && effective(cfg, cfg.task.scope) === 'enforce') {
    record('scope_ask', repoDir, { file: rel });
    return { kind: 'ask', reason: '\u0060' + rel + '\u0060 不在本次任务契约范围（' + contract.scope.join(', ') + '）内，需要开发者确认。' };
  }
  if (
    !aux && !exists(abs) && effective(cfg, cfg.reuse.beforeNew) === 'enforce' && atlasAvailable() &&
    !hasHotQueried(repoDir) && !hasSimilarSearched(repoDir)
  ) {
    record('reuse_deny', repoDir, { file: rel });
    return {
      kind: 'deny',
      reason:
        '新建 \u0060' + rel + '\u0060 之前先查仓里有没有现成实现：调用 ' + REUSE_TOOL + '（或终端 atlas hot <要写什么> / atlas similar <要做什么>）。' +
        '有就复用，没有再新建。（由 repo-guard 提供）',
    };
  }
  return null;
}

// ══════════════════ 写后 ══════════════════

export function postWrite(repoDir: string, rel: string, abs: string, ok: boolean): string[] {
  const { cfg } = control(repoDir);
  const notes: string[] = [];
  if (!ok) return loopNotes(repoDir, rel, cfg);
  recordWrite(repoDir, rel);

  for (const r of pathRedlines(cfg.redlines.paths, rel)) {
    if (r.action !== 'remind' || !claimStopNotice('redline:' + repoId(repoDir) + ':' + rel + ':' + r.glob)) continue;
    record('redline_remind', repoDir, { file: rel, detail: r.glob });
    notes.push('\u0060' + rel + '\u0060 命中红线 ' + r.glob + (r.reason ? '：' + r.reason : '') + '。确认这次改动是任务必需的。');
  }
  {
    const snap = readBefore(repoDir, rel);
    if (snap && !snap.tooBig && (cfg.redlines.fields.length || cfg.redlines.content.length)) {
      const cur = readText(abs);
      for (const h of [...fieldHits(cfg.redlines.fields, rel, snap.content, cur), ...contentHits(cfg.redlines.content, rel, snap.content, cur)]) {
        if (!claimStopNotice('red:' + repoId(repoDir) + ':' + h.key)) continue;
        record(h.action === 'remind' ? 'redline_remind' : 'redline_deny', repoDir, { file: rel, detail: h.kind + ':after-write' });
        notes.push(redHitText(rel, h) + (h.action === 'remind' ? '确认这次改动是任务必需的。' : '这条红线要求不能这样改（可能是通过别的写法绕过了写前检查），请撤回这处改动。'));
      }
    }
  }
  if (cfg.mode === 'off') return notes;
  const aux = isAuxFile(rel);

  const contract = getContract();
  if (contract && !aux && !inScope(contract, rel, abs) && effective(cfg, cfg.task.scope) === 'remind' && claimStopNotice('scope:' + repoId(repoDir) + ':' + rel)) {
    record('scope_remind', repoDir, { file: rel });
    notes.push(
      '\u0060' + rel + '\u0060 不在本次任务契约范围（' + contract.scope.join(', ') + '）内。不是任务必需就撤回这次改动；' +
        '确实需要就调 ' + TASK_TOOL + ' 扩大范围，并在 reason 里写明理由。这次越界会列进回执。',
    );
  }

  const before = readBefore(repoDir, rel);
  let after: string | null = null;
  try {
    after = fs.readFileSync(abs, 'utf-8');
  } catch {
    after = null;
  }
  if (before && !before.tooBig && after !== null) {
    const cx = complexityIssues(rel, rel, before.content, after, cfg.budget);
    const fresh = cx.issues.filter((i) => claimStopNotice('cx:' + repoId(repoDir) + ':' + rel + ':' + i.func + ':' + i.kind));
    if (fresh.length) {
      record('complexity_remind', repoDir, { file: rel, detail: fresh.map((i) => i.func + ':' + i.kind).join(',') });
      notes.push(
        '本次新写 / 改长的函数超出阈值：' + fresh.map(complexityText).join('；') + '。' +
          '按最简实现收敛：去掉多余的防御判断和重复兜底、合并重复分支；不要为了降复杂度再新增抽象层。',
      );
    }
    const created = before.content === null;
    const effReuse = effective(cfg, cfg.reuse.beforeNew);
    if (
      !aux && (created || cx.newFuncs.length) && effReuse !== 'off' && atlasAvailable() &&
      !hasHotQueried(repoDir) && !hasSimilarSearched(repoDir) && claimStopNotice('reuse:' + repoId(repoDir)) && atlasRepoEntry(repoDir, 3000)
    ) {
      record('reuse_remind', repoDir, { file: rel });
      const what = created ? '新文件 \u0060' + rel + '\u0060' : '函数 ' + cx.newFuncs.map((f) => f.name).slice(0, 5).join('、');
      notes.push(
        '这次新增了' + what + '，本轮还没查过现成实现。调用 ' + REUSE_TOOL + '（或终端 atlas hot <要写什么>）查仓里有没有同类实现，有就改为复用，不要再写一份。',
      );
    }
  }
  notes.push(...loopNotes(repoDir, rel, cfg));
  return notes;
}

/** 连续失败：写后提醒换思路，不拦；提醒后计数清零 */
function loopNotes(repoDir: string, rel: string | null, cfg: ControlConfig): string[] {
  if (cfg.mode === 'off') return [];
  if (consecutiveFailCount() >= 3) {
    resetAfterLoopBlock('consecutive_fail', repoDir, null);
    record('loop_remind', repoDir, { detail: 'consecutive_fail' });
    return ['已经连续失败 3 次。停下来确认前提（文件内容、路径、命令是否正确），换个思路；仍然不行就把卡点告诉开发者，不要继续重试。'];
  }
  if (rel && fileWriteFailCount(repoDir, rel) >= 2) {
    resetAfterLoopBlock('file_write_fail', repoDir, rel);
    record('loop_remind', repoDir, { file: rel, detail: 'file_write_fail' });
    return ['\u0060' + rel + '\u0060 已经写失败 2 次。先重新读一遍文件当前内容再改，不要凭记忆拼 old_string。'];
  }
  return [];
}

export function postFail(repoDir: string, rel: string | null): string[] {
  if (!v2Active(repoDir)) return [];
  return loopNotes(repoDir, rel, control(repoDir).cfg);
}

// ══════════════════ 经 shell 改动的文件 ══════════════════
//
// 实测发现模型常用 `python3 - <<EOF`、sed 等命令直接改文件，完全绕开文件编辑工具，
// 写前写后钩子都看不到。兜底：会话开始记一个 git 基线，每条命令执行后和结束时对比工作区，
// 基线之后变了、又不是经编辑工具写的文件，按「经命令修改」纳入范围、复杂度、红线检查和回执。
// 写前拦截对它们做不到，所以红线命中时只能写后要求撤回。

const SHELL_SNAPSHOT_MAX = 1024 * 1024;

function git(repoDir: string, args: string[]): string | null {
  try {
    const r = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf-8', timeout: 4000, maxBuffer: 32 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

function untrackedFiles(repoDir: string): string[] {
  return (git(repoDir, ['ls-files', '--others', '--exclude-standard']) ?? '').split('\n').filter(Boolean);
}

/** 会话开始时调用：记下本会话的 git 基线（已有则不动） */
export function ensureBaseline(repoDir: string): void {
  if (!v2Active(repoDir) || getBaseline(repoDir)) return;
  const head = git(repoDir, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim();
  if (!head) return; // 不是 git 仓或还没有提交
  const stash = git(repoDir, ['stash', 'create'])?.trim();
  setBaselineOnce(repoDir, { rev: stash || head, untracked: untrackedFiles(repoDir) });
}

/** 基线之后变化、且没经过编辑工具的文件 → 补快照并跑写后检查。返回给模型的提醒 */
export function syncShellWrites(repoDir: string): string[] {
  if (!v2Active(repoDir)) return [];
  const base = getBaseline(repoDir);
  if (!base) return [];
  const changed = new Set<string>();
  for (const f of (git(repoDir, ['diff', '--name-only', base.rev]) ?? '').split('\n')) if (f) changed.add(f);
  for (const f of untrackedFiles(repoDir)) if (!base.untracked.includes(f)) changed.add(f);
  const known = new Set(writtenFiles(repoDir));
  const fresh = [...changed].filter((f) => !known.has(f) && !f.startsWith('.codebuddy/'));
  if (!fresh.length) return [];
  const notes: string[] = [];
  for (const rel of fresh) {
    const wasUntracked = base.untracked.includes(rel);
    const before = wasUntracked ? undefined : git(repoDir, ['show', base.rev + ':' + rel]);
    snapshotContent(repoDir, rel, before ?? null, wasUntracked || (before?.length ?? 0) > SHELL_SNAPSHOT_MAX);
    notes.push(...postWrite(repoDir, rel, path.join(repoDir, rel), true));
  }
  record('shell_write', repoDir, { detail: fresh.slice(0, 10).join(',') });
  const { cfg } = control(repoDir);
  const head = '检测到通过命令（而不是文件编辑工具）修改了：' + fresh.slice(0, 8).join('、') + (fresh.length > 8 ? ' 等 ' + fresh.length + ' 个文件' : '') + '。已纳入范围、复杂度、红线检查和回执；改文件请用文件编辑工具，写前检查才能生效。';
  const out = [head, ...notes];
  if (contractMode(cfg) !== 'off' && !getContract() && writtenFiles(repoDir).filter((f) => !isAuxFile(f)).length >= 2 && claimStopNotice('contract-shell')) {
    out.push('这次已经改了多个文件但还没有任务契约：调用 ' + TASK_TOOL + ' 补充声明目标、不做什么、范围和验收命令。');
  }
  return out;
}

// ══════════════════ 命令 ══════════════════

export function preBash(repos: string[], cmd: string): Decision | null {
  for (const repoDir of repos) {
    if (!v2Active(repoDir)) continue;
    for (const r of commandRedlines(control(repoDir).cfg.redlines.commands, cmd)) {
      if (r.action === 'remind') continue;
      record('redline_deny', repoDir, { detail: r.action + ':' + r.pattern });
      const why = '命令命中红线 ' + r.pattern + (r.reason ? '：' + r.reason : '') + '。';
      return r.action === 'block' ? { kind: 'deny', reason: why + '这是开发者明确禁止的操作，不要换写法绕开；确实需要请交给开发者执行。' } : { kind: 'ask', reason: why + '需要开发者确认。' };
    }
  }
  return null;
}

export function postBash(repos: string[], cmd: string, ok: boolean): string[] {
  const active = repos.filter(v2Active);
  if (!active.length) return [];
  recordBashRun(cmd, ok);
  const notes: string[] = [];
  for (const repoDir of active) notes.push(...syncShellWrites(repoDir));
  for (const repoDir of active) {
    for (const r of commandRedlines(control(repoDir).cfg.redlines.commands, cmd)) {
      if (r.action !== 'remind' || !claimStopNotice('cmd-redline:' + r.pattern)) continue;
      record('redline_remind', repoDir, { detail: r.pattern });
      notes.push('命令命中红线 ' + r.pattern + (r.reason ? '：' + r.reason : '') + '。');
    }
  }
  if (!ok) notes.push(...loopNotes(active[0], null, control(active[0]).cfg));
  return notes;
}

// ══════════════════ Stop：改动回执 ══════════════════

const CONTINUE_MAX = 3;
const REVIEW_TIMEOUT_MS = 10_000;

function verifyStatus(cmds: string[]): NonNullable<ReceiptExtras['verify']> {
  if (!cmds.length) return { status: 'unconfigured', cmds };
  const since = lastWriteAt();
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const hits = bashRuns().filter((r) => r.ts >= since && cmds.some((c) => norm(r.cmd).includes(norm(c))));
  if (!hits.length) return { status: 'none', cmds };
  return { status: hits[hits.length - 1].ok ? 'pass' : 'fail', cmds };
}

function duplicates(repoDir: string, written: string[], deadline: number): { list: string[]; note?: string } {
  if (!atlasAvailable()) return { list: [], note: '图谱不可用，复用与影响面未检查' };
  const entry = atlasRepoEntry(repoDir, Math.max(1000, Math.min(4000, deadline - Date.now())));
  if (!entry) return { list: [], note: '本仓未登记到 atlas 图谱，复用未检查' };
  const budget = deadline - Date.now();
  if (budget < 1500) return { list: [], note: 'atlas review 超时，复用未检查' };
  const r = atlasJson<{ problems?: Array<{ kind?: string; file?: string; line?: number; message?: string }> }>(
    ['review', '--json', '--repo', entry.id, '--ws', entry.workspace],
    { cwd: repoDir, timeoutMs: budget },
  );
  if (!r.ok) return { list: [], note: 'atlas review 未完成（' + r.message.slice(0, 80) + '），复用未检查' };
  const set = new Set(written);
  return {
    list: (r.data.problems ?? [])
      .filter((p) => p.kind === 'duplicate' && typeof p.file === 'string' && set.has(p.file))
      .map((p) => p.file + ':' + (p.line ?? '?') + ' ' + (p.message ?? '')),
  };
}

export interface StopResult {
  system: string[];
  cont: string[];
}

export interface SessionReceipt {
  text: string;
  pending: string[];
  verify: NonNullable<ReceiptExtras['verify']>;
  cfg: ControlConfig;
  active: string[];
}

/** 本会话的回执（Stop 与 repo-guard receipt 共用）。没有写入返回 null */
export function sessionReceipt(repos: string[], label: (r: string) => string, withAtlas = true): SessionReceipt | null {
  const active = repos.filter((r) => v2Active(r) && control(r).cfg.mode !== 'off' && writtenFiles(r).length);
  if (!active.length) return null;
  const cfg = control(active[0]).cfg;
  const contract = getContract();
  const multi = repos.length > 1;
  const changes: FileChange[] = [];
  const written: Array<{ repo: string; rels: string[] }> = [];
  for (const repoDir of active) {
    const rels = writtenFiles(repoDir);
    written.push({ repo: repoDir, rels });
    for (const rel of rels) {
      const abs = path.join(repoDir, rel);
      const before = readBefore(repoDir, rel);
      let after: string | null = null;
      try {
        after = fs.readFileSync(abs, 'utf-8');
      } catch {
        after = null;
      }
      changes.push({
        label: multi ? label(repoDir) + '/' + rel : rel,
        rel,
        before: before?.content ?? null,
        after,
        noBaseline: !before || before.tooBig,
        outOfScope: !!contract && !isAuxFile(rel) && !inScope(contract, rel, abs),
      });
    }
  }

  const deadline = Date.now() + REVIEW_TIMEOUT_MS;
  const dup = withAtlas
    ? written.map((w) => {
        try {
          return duplicates(w.repo, w.rels, deadline);
        } catch {
          return { list: [], note: '图谱调用失败，复用未检查' };
        }
      })
    : [];
  const cmds = contract?.verify.length ? contract.verify : cfg.verify.commands;
  const ex: ReceiptExtras = {
    verify: verifyStatus(cmds),
    expansions: scopeExpansions(),
    notes: guardNotes(),
    duplicates: dup.flatMap((d) => d.list),
    atlasNote: withAtlas ? dup.find((d) => d.note)?.note : '未运行 atlas review',
  };
  const rc = computeReceipt(changes, cfg.budget);
  return {
    text: renderReceipt(rc, cfg.budget, ex),
    pending: pendingItems(rc, cfg.budget, ex, cmds.length > 0),
    verify: ex.verify!,
    cfg,
    active,
  };
}

export function stop(repos: string[], label: (r: string) => string): StopResult {
  const out: StopResult = { system: [], cont: [] };
  for (const r of repos) syncShellWrites(r);
  const last = lastWriteAt();
  if (!last || !repos.some((r) => v2Active(r) && writtenFiles(r).length)) return out;
  // 只在有新写入时出回执：AI 说明完不再写，下一次 Stop 就放行
  if (!claimStopNotice('receipt:' + last)) return out;
  const rc = sessionReceipt(repos, label);
  if (!rc) return out;
  const { cfg, pending, verify, text } = rc;
  out.system.push(text);
  for (const r of rc.active) record('receipt', r, { detail: pending.length ? pending.length + ' pending' : 'clean' });

  if (effective(cfg, cfg.verify.onStop) === 'enforce' && (verify.status === 'none' || verify.status === 'fail') && claimStopNotice('verify-enforce')) {
    out.cont.push('结束前先跑验收命令：' + verify.cmds.join(' && ') + '，跑通后再结束；跑不通就如实说明失败原因。');
  }
  if (pending.length && claimContinue()) {
    out.cont.push(
      'repo-guard 改动回执里有需要说明的项。在最终回复里逐条说明：保留的给出理由，或撤回改动；不要借机做契约外的修改。\n' +
        pending.map((p) => '- ' + p).join('\n') + '\n\n' + text,
    );
  }
  return out;
}

function claimContinue(): boolean {
  for (let i = 1; i <= CONTINUE_MAX; i++) if (claimStopNotice('receipt-continue:' + i)) return true;
  return false;
}