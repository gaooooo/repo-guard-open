/**
 * 钩子 —— 宿主在事件点上调这里，stdin 收 JSON、stdout 出 JSON。
 *
 * ── 四条铁律 ──
 *
 * **① `pre-write` 只允许输出 deny 或什么都不输出。**
 * 宿主把"有 additionalContext"也当成一种干预。往 `pre-write` 上挂提醒会让
 * 每一次正常写文件都产生输出，噪音淹没真正的拦截，而且 `verify-hooks` 的
 * 7 条 allow 用例会集体变红。提醒统一走 `session-start` / `post-write` / `pre-bash`。
 *
 * **② 只读图谱缓存，永不建图。**
 * 图谱由外部 code-atlas 提供，钩子只能子进程调 `atlas … --json --cache-only`。
 * `pre-write` 的超时预算只有十几秒，`pre-bash` / `post-write` 只有几秒，
 * 而万文件级仓库建图要几十秒。缓存 miss（atlas 退出码 3）就 fail-open。
 * 唯一例外是 Stop 的写后比对：允许 atlas 增量建图，限时 12 秒，失败放行。
 *
 * **③ 任何异常都必须 fail-open。**
 * hook 抛异常 / 非零退出，在 `PreToolUse` 上意味着**工具调用被阻断**。
 * 为了自己的 bug 把人的操作弄失败，比漏拦一次坏得多。所以最外层兜一个 catch，
 * 出错就当什么都没发生。
 *
 * **④ 没有 guard 配置时，`.codebuddy/guard/` 引入的那些门不得改变行为。**
 * `verify-hooks` 的 20 条用例跑在没有 guard 配置的仓库上，它们全绿就是这条的证据。
 * 每加一道门都要重新确认 —— 一道门"默认关"但仍改变了输出，等于所有人被迫升级。
 *
 * 注意这条约束的**边界**：它管的是 guard 配置驱动的新门。由既有配置
 *（`repo-facts.json` / `redlines.json`）驱动的注入不在其内 —— 用户写了红线就是
 * 明确表达了"按它办"，把摘要推给模型是那份配置本来的语义（deerclaw 侧红线
 * 摘要一直是【推】）。这一处差异已登记在 parity 的 KNOWN_DEVIATIONS 里。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findRepoRoot, repoForPath, repoId, sessionRepos, toRepoRelative } from '../runtime/paths.js';
import { countLines, readFacts, type RepoFacts } from '../runtime/repo-facts.js';
import { loadRedlines } from '../runtime/redlines.js';
import { judge, denyReason, shouldBlock } from '../runtime/guard.js';
import {
  similarPlans,
  sessionTouchedFiles,
  claimStopNotice,
  bindCurrentSession,
  hasHotQueried,
  hasLibSearched,
  hasQueried,
  hasSimilarSearched,
  setSessionId,
  sweepStaleSessions,
} from '../runtime/session-state.js';
import { record } from '../runtime/metrics.js';
import { loadGuardConfig, type GuardConfig } from '../gates/config.js';
import { buildInjection, featureHint, matchTaskRoutes } from '../gates/inject.js';
import { judgeRedline, judgeScope, noteTouched, type WriteToolInput } from '../gates/admission.js';
import { judgeGraphEnforce } from '../gates/graph-enforce.js';
import { atlasAvailable, atlasJson } from '../atlas/client.js';
import { trackAtlasBash, trackAtlasTool } from './atlas-track.js';
import { judgeLoop, iterationNote, noteToolResult } from '../gates/loop.js';
import { isDeliveryAction, judgeDelivery, noteEvidence, recordFinalSignal } from '../gates/delivery.js';
import { loadHumanReview, redlineShouldAsk } from '../layers/human-review.js';
import { loadStandards, type StandardsSnapshot } from '../standards/loader.js';
import {
  compileBlockRules,
  injectSegment,
  isActionable,
  judgeRequireTool,
  promptSegment,
  remindNote,
  scanFile,
} from '../standards/evaluate.js';

/** 宿主喂进来的事件。字段全部可选 —— 坏输入不能崩（verify-hooks 的 E1/E2） */
interface HookInput {
  cwd?: string;
  session_id?: string;
  tool_name?: string;
  /** UserPromptSubmit 的用户原话 */
  prompt?: string;
  tool_input?: WriteToolInput & { command?: string; [k: string]: unknown };
  /** PostToolUse 的工具返回。用于判定成功/失败 */
  tool_response?: { success?: boolean; error?: unknown; [k: string]: unknown };
  [k: string]: unknown;
}

/** 把 stdin 读完。读不到就当空对象 —— 绝不因为 stdin 异常让 hook 失败 */
function readStdin(): HookInput {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf-8');
  } catch {
    return {};
  }
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as HookInput) : {};
  } catch {
    // 非 JSON（verify-hooks 的 hook-garbage 用例）：当空输入
    return {};
  }
}

function emitDeny(event: string, reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
}

function emitAsk(event: string, reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: 'ask',
        permissionDecisionReason: reason,
      },
    }),
  );
}

function emitContext(event: string, text: string): void {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }),
  );
}

/**
 * 放行但带提醒。
 *
 * 同时给 `additionalContext`（进上下文，模型看得见）和
 * `permissionDecision: allow` + 同样的 reason（进权限层的说明）。
 * 两个都给是因为不同宿主版本读的字段不一样，而这条提醒漏掉了就等于没提醒。
 */
function emitAllowWithNote(event: string, text: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: text,
        permissionDecision: 'allow',
        permissionDecisionReason: text,
      },
    }),
  );
}

/** Stop / SubagentStop：阻止停止并让 Agent 继续 */
function emitContinue(reason: string): void {
  process.stdout.write(JSON.stringify({ continue: false, reason }));
}

/** 从 tool_input 里抠出被写的路径。不同宿主 / 不同工具字段名不一样 */
function writeTarget(input: HookInput): string | null {
  const ti = input.tool_input;
  if (!ti) return null;
  for (const key of ['file_path', 'notebook_path', 'path', 'target_file'] as const) {
    const v = ti[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function cwdOf(input: HookInput): string {
  return input.cwd && input.cwd.trim() ? input.cwd : process.cwd();
}

/** cwd 所在的仓。多仓工作区（cwd 是父目录）时就是父目录本身，只用于会话绑定与兜底 */
function repoOf(input: HookInput): string {
  return findRepoRoot(cwdOf(input));
}

/**
 * 会话涉及的仓：多仓工作区 → 全部子仓；否则 → cwd 所在仓（与原来一致）。
 * 给 SessionStart / 提问 / Stop 这些不针对具体文件的钩子用。
 */
function reposOf(input: HookInput): string[] {
  return sessionRepos(cwdOf(input));
}

/**
 * 写类钩子的目标：被改文件所在的仓 + 绝对路径。
 *
 * 必须按文件定位，不能按 cwd：多仓团队从父目录打开会话时，cwd 不是任何一个仓，
 * 按 cwd 找仓会读不到配置，守卫整个失效；改兄弟仓的文件同理。
 * 返回 null = 文件不在任何仓里（T2：仓库外路径一律放行）。
 */
function fileTarget(input: HookInput, raw: string): { repoDir: string; abs: string } | null {
  const cwd = cwdOf(input);
  const repoDir = repoForPath(cwd, raw);
  if (!repoDir) return null;
  return { repoDir, abs: path.isAbsolute(raw) ? raw : path.resolve(cwd, raw) };
}

/** 多仓工作区里给每段输出标上是哪个仓 */
function repoLabel(input: HookInput, repoDir: string): string {
  const rel = path.relative(cwdOf(input), repoDir);
  return rel && !rel.startsWith('..') ? rel : path.basename(repoDir);
}

/**
 * Bash 实际在哪个目录跑：认开头的 `cd <目录> &&` / `cd <目录>;`。
 * 多仓工作区里 AI 常写 `cd backend && go build ./...`，不认的话命令里的相对路径全按父目录解析。
 */
function bashCwd(input: HookInput, cmd: string): string {
  const cwd = cwdOf(input);
  const m = cmd.match(/^\s*cd\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(&&|;)/);
  if (!m) return cwd;
  const dir = (m[2] ?? m[3] ?? m[4] ?? '').replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
  const abs = path.resolve(cwd, dir);
  try {
    return fs.statSync(abs).isDirectory() ? abs : cwd;
  } catch {
    return cwd;
  }
}

/** 文件在 HEAD 里有几行。新文件、不是 git 仓、git 不可用 → null（按「这次写超的」处理） */
function headLines(repoDir: string, rel: string): number | null {
  try {
    const r = spawnSync('git', ['-C', repoDir, 'show', `HEAD:${rel}`], { encoding: 'utf-8', timeout: 3000, maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout ? r.stdout.split('\n').length : 0;
  } catch {
    return null;
  }
}

/** 工具这次成功了吗。拿不到明确信号时按成功算（否则会把连续失败计数打飘） */
function toolSucceeded(input: HookInput): boolean {
  const r = input.tool_response;
  if (!r || typeof r !== 'object') return true;
  if (r.success === false) return false;
  if (r.error) return false;
  if (r.is_error === true) return false;
  if (typeof r.exitCode === 'number' && r.exitCode !== 0) return false;
  return true;
}

/**
 * 加载规范快照。
 *
 * 单独抽一个函数是为了让"**项目层不存在 = 零行为变化**"这条纪律只有一个入口：
 * `evaluate.ts` 的每个导出都先过 `isActionable`，而它只认 `projectPresent`。
 * 全局层（插件自带）永远不驱动运行时行为 —— 否则升级插件就等于所有人被迫
 * 接受一堆新输出。
 */
function standardsOf(repoDir: string, facts: RepoFacts | null): StandardsSnapshot {
  return loadStandards(repoDir, facts);
}

// ══════════════════ L0 注入面 ══════════════════

/**
 * 会话开始：把公共层清单与纪律注入上下文。
 *
 * 未配置时必须**明说守卫没生效**，不能沉默 —— 沉默会让人以为装了就有保护，
 * 那比没装更危险。这条是 verify-hooks 的 F2 用例。
 */
function sessionStart(input: HookInput): void {
  // 图谱由 code-atlas 提供。没装时守卫本身照常（判据是会话状态），但 AI 查不了影响面，
  // 被拦之后无路可走 —— 必须明说，不能沉默（同 F2 的理由）。不阻塞
  const atlasNote = atlasAvailable()
    ? ''
    : '图谱相关守卫未生效：没找到 code-atlas（atlas 命令）。请安装 code-atlas（npm i -g code-atlas）后重开会话；在此之前查不了影响面 / 同类实现。';

  const repos = reposOf(input);
  if (repos.length === 1) {
    const all = [startSection(repos[0], atlasNote)].filter(Boolean).join('\n\n');
    if (all) emitContext('SessionStart', all);
    return;
  }
  // 多仓工作区：逐仓注入，atlas 提示只说一次
  const parts = [multiRepoHead(input, repos)];
  for (const r of repos) parts.push(`### ${repoLabel(input, r)}\n${startSection(r, '')}`);
  if (atlasNote) parts.push(atlasNote);
  emitContext('SessionStart', parts.join('\n\n'));
}

function multiRepoHead(input: HookInput, repos: string[]): string {
  return (
    `当前目录是多仓工作区，含 ${repos.length} 个仓：${repos.map((r) => repoLabel(input, r)).join('、')}。` +
    '下面按仓分段；改哪个仓的文件，就按哪个仓的规则判。'
  );
}

/** 单个仓的 SessionStart 段。单仓时输出与改造前逐字节相同 */
function startSection(repoDir: string, atlasNote: string): string {
  const facts = readFacts(repoDir);
  record('session_start', repoDir);
  const std = injectSegment(standardsOf(repoDir, facts), 'session_start');

  if (!facts) {
    // 规范可能铺了但 repo-facts 没跑过 —— 两件事互相独立，各说各的
    const head = '本仓还没跑过 repo-guard init —— 公共层与红线都未配置，写前守卫不会生效。';
    return [head, atlasNote, std].filter(Boolean).join('\n\n');
  }

  // guard 配置不存在时 buildInjection 只产出公共层那一段，
  // 与接入 L0 之前的输出逐字节相同 —— 铁律 ④
  const text = buildInjection(facts, loadRedlines(repoDir), loadGuardConfig(repoDir));
  const factNote = '工程事实长文见仓库根 CODEBUDDY.md（本段只注机器摘要）。';
  return [text, factNote, atlasNote, std].filter(Boolean).join('\n\n');
}

/**
 * 压缩之后：重注入 L0。
 *
 * 压缩会把 SessionStart 注入的公共层清单冲掉。不补回去的话，长会话的后半程
 * 模型就不知道哪些目录是公共层了 —— 而守卫还在拦，于是它会觉得工具行为随机。
 */
function postCompact(input: HookInput): void {
  const repos = reposOf(input);
  if (repos.length === 1) {
    const all = compactSection(repos[0]);
    if (all) emitContext('PostCompact', `（上下文压缩后重新注入）\n${all}`);
    return;
  }
  const parts = repos.map((r) => [r, compactSection(r)] as const).filter(([, t]) => t);
  if (!parts.length) return;
  emitContext(
    'PostCompact',
    `（上下文压缩后重新注入）\n${multiRepoHead(input, repos)}\n\n${parts.map(([r, t]) => `### ${repoLabel(input, r)}\n${t}`).join('\n\n')}`,
  );
}

function compactSection(repoDir: string): string {
  const facts = readFacts(repoDir);
  const std = injectSegment(standardsOf(repoDir, facts), 'post_compact');
  if (!facts) return std;
  const text = buildInjection(facts, loadRedlines(repoDir), loadGuardConfig(repoDir));
  return [text, std].filter(Boolean).join('\n\n');
}

/**
 * 用户提交提问：按任务类型注入必读清单 + 相关规范正文。
 *
 * ⚠️ **绝不能阻塞。** `continue:false` 会把用户的提问整个吃掉，
 * 代价远大于任何收益。
 */
function userPromptSubmit(input: HookInput): void {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  // 多仓工作区：各仓的路由 / 规范 / 提示合在一起，同一段只出一次（各仓常用同一套模板）
  const parts: string[] = [];
  const push = (t: string | null | undefined) => {
    if (t && !parts.includes(t)) parts.push(t);
  };
  for (const repoDir of reposOf(input)) {
    const cfg = loadGuardConfig(repoDir);
    push(matchTaskRoutes(cfg, prompt));
    push(promptSegment(standardsOf(repoDir, readFacts(repoDir)), prompt));
    const hint = featureHint(cfg, prompt);
    if (hint) {
      push(hint);
      record('feature_hint', repoDir);
    }
  }

  if (parts.length) emitContext('UserPromptSubmit', parts.join('\n\n'));
}

// ══════════════════ L1 准入门 ══════════════════

/**
 * 写之前的完整判定链。顺序是按**代价**排的：
 *   1. L3 循环门     —— 最便宜（只读计数器），而且它拦的是"别再试了"
 *   2. L1 红线 / 禁改 —— 要读文件算 diff
 *   3. L1 范围门     —— 读会话状态
 *   4. 公共层守卫    —— 插件核心功能，最后判
 *
 * 循环门放第一位是刻意的：模型已经卡住时，再告诉它"去查影响面"是没用的。
 */
function preWrite(input: HookInput): void {
  const raw = writeTarget(input);
  if (!raw) return; // 拿不到路径：不管（E2 用例）

  // 按被改文件定位仓：多仓工作区、改兄弟仓的文件都要按文件所在仓的配置判
  const target = fileTarget(input, raw);
  if (!target) return; // 不在任何仓里：不管（T2 用例）
  const { repoDir, abs } = target;
  const facts = readFacts(repoDir);
  const cfg = loadGuardConfig(repoDir);
  const std = standardsOf(repoDir, facts);
  const stdRules = compileBlockRules(std);

  // 未配置 repo-facts 时公共层守卫不生效，但 guard / standards 的门仍可能开着。
  // 所以这里不能直接 return —— 除非三者都没配。
  if (!facts && !cfg.present && !stdRules.length) return; // F1 用例：完全未配置 → fail-open

  const rel = toRepoRelative(repoDir, abs);
  if (!rel) return; // 仓库外：不管（T2 用例）

  // ① L3 循环门
  const loop = judgeLoop(repoDir, cfg, input.tool_name ?? 'Write', input.tool_input, rel);
  if (loop.blocked) {
    record('loop_deny', repoDir, { file: rel, detail: loop.kind });
    emitDeny('PreToolUse', loop.reason!);
    return;
  }

  // ② L1 红线与禁改清单（standards 的 block 级规范一起交给同一个引擎判）
  const snapshot = loadRedlines(repoDir);
  const red = judgeRedline(repoDir, snapshot, cfg, rel, input.tool_input ?? {}, stdRules);
  if (red.blocked) {
    const fromStandards = red.ruleId?.startsWith('STD-') === true;
    const human = loadHumanReview(repoDir);
    const ask = red.kind === 'redline' && redlineShouldAsk(human);
    record(fromStandards ? 'standards_deny' : red.kind === 'no_refactor' ? 'no_refactor_deny' : ask ? 'redline_ask' : 'redline_hit', repoDir, {
      file: rel,
      rule: red.ruleId,
    });
    if (ask) emitAsk('PreToolUse', red.reason!);
    else emitDeny('PreToolUse', red.reason!);
    return;
  }

  // ③ L1 范围门
  const scope = judgeScope(repoDir, cfg, rel);
  if (scope.blocked) {
    record('scope_deny', repoDir, { file: rel, detail: scope.kind });
    emitDeny('PreToolUse', scope.reason!);
    return;
  }

  // ④ L1 图谱强制（只管新建文件）
  let exists = false;
  try {
    exists = fs.statSync(path.join(repoDir, rel)).isFile();
  } catch {
    exists = false;
  }
  const content = typeof input.tool_input?.content === 'string' ? input.tool_input.content : undefined;
  const enforce = judgeGraphEnforce(repoDir, cfg, rel, exists, undefined, content);
  if (enforce.blocked) {
    record('graph_enforce_deny', repoDir, { file: rel, detail: enforce.kind });
    emitDeny('PreToolUse', enforce.reason!);
    return;
  }

  // ⑤ 公共层守卫（插件核心功能，不受 guard 开关控制）
  //
  // ⚠️ 必须排在 standards 的 require_tool **之前**。两者可能判定同一件事
  //（模板里 CM-LAYER-002 的 paths 就是公共层），而核心功能这份拒绝文案是真机
  // 调优过的：它给出三种工具调法（MCP / 斜杠命令 / CLI 绝对路径），因为模型按
  // `impact` 去搜工具名会搜不到，然后判定"工具不存在"改用 grep 凑影响面。
  // 让 standards 那份较简的文案抢在前面，等于把这个调优成果丢掉。
  if (facts) {
    const v = judge(repoDir, facts, snapshot, abs);
    if (v && shouldBlock(v)) {
      record('guard_deny', repoDir, { file: v.rel, rule: v.rules[0]?.id, detail: input.tool_name });
      emitDeny('PreToolUse', denyReason(v));
      return;
    }
    if (v?.publicPrefix && v.exists && v.queried) {
      // 查过之后放行也要留痕 —— 这是判断"这道门有没有在做有用功"的分子
      record('guard_allow_after_query', repoDir, { file: v.rel });
    }
  }

  // ⑥ 规范的 require_tool：改之前必须先调过某个图谱工具。
  // 排在核心守卫之后，所以它实际只管核心功能覆盖不到的场景：
  // 新建文件（similar / hot / lib）、以及公共层之外但也要求先查影响面的路径。
  // 会话状态在这里读、判定在 evaluate 里做 —— 判定保持纯粹便于单测。
  const rt = judgeRequireTool(std, rel, {
    queried: hasQueried(repoDir, rel),
    libSearched: hasLibSearched(repoDir),
    hotQueried: hasHotQueried(repoDir),
    similarSearched: hasSimilarSearched(repoDir),
    exists,
  });
  if (rt.blocked) {
    record('standards_deny', repoDir, { file: rel, rule: rt.itemId, detail: 'require_tool' });
    emitDeny('PreToolUse', rt.reason!);
    return;
  }

  // 放行之后才记"改过这个文件"（范围门预算的分母）
  noteTouched(repoDir, rel);
}

// ══════════════════ pre-bash ══════════════════

/** 会写文件的 shell 形态。宁可漏认，不要错认 —— 错认会对每条只读命令都提醒 */
const SHELL_WRITE_PATTERNS: RegExp[] = [
  /\bsed\s+(-[a-zA-Z]*\s+)*-i\b/, // sed -i / sed -n -i
  /\bperl\s+(-\S+\s+)*-i\b/,
  /\b(tee)\s/,
  /\b(cp|mv|install)\s/,
  /\b(truncate|dd)\s/,
  /\b(cat|echo|printf|python3?|node)\b[^|]*>\s*\S/, // 重定向覆盖写
  /\b(patch|git\s+apply)\b/,
  />>\s*\S/, // 追加写
];

/**
 * Bash 之前：看命令像不像在用 shell 写公共层；顺带收集工程校验证据。
 *
 * **只提醒，不拦。** 拦 shell 的误伤率高得不可接受 —— 一条命令里可能同时有
 * 读和写、路径可能是变量拼出来的、也可能压根不是本仓的路径。
 */
function preBash(input: HookInput): void {
  const cmd = input.tool_input?.command;
  if (typeof cmd !== 'string' || !cmd.trim()) return;

  const cwd = bashCwd(input, cmd);
  const repos = sessionRepos(cwd);

  // 工程校验证据要在**执行之前**就记下 —— PostToolUse 拿不到命令原文
  for (const repoDir of repos) noteEvidence(loadGuardConfig(repoDir), cmd);

  // L3 循环门也管 bash：同一条命令重复跑 3 次基本都是卡住了。只在配了 repo-facts 的仓上判
  for (const repoDir of repos) {
    if (!readFacts(repoDir)) continue;
    const loop = judgeLoop(repoDir, loadGuardConfig(repoDir), 'Bash', input.tool_input, null);
    if (loop.blocked) {
      record('loop_deny', repoDir, { detail: loop.kind });
      emitDeny('PreToolUse', loop.reason!);
      return;
    }
  }

  if (!SHELL_WRITE_PATTERNS.some((re) => re.test(cmd))) return;

  // 命令里的每个路径各自找所在仓、各按各的公共层判
  const hits = new Map<string, Set<string>>();
  const factsOf = new Map<string, RepoFacts | null>();
  for (const m of cmd.matchAll(/[\w./@-]*[\w-]+\.[A-Za-z][\w]*|[\w./@-]*\/[\w.-]+/g)) {
    const repoDir = repoForPath(cwd, m[0]);
    if (!repoDir) continue;
    if (!factsOf.has(repoDir)) factsOf.set(repoDir, readFacts(repoDir));
    const facts = factsOf.get(repoDir);
    if (!facts) continue;
    const rel = toRepoRelative(repoDir, path.resolve(cwd, m[0]));
    if (!rel) continue;
    for (const p of facts.publicLayer.map((x) => (x.endsWith('/') ? x : `${x}/`))) {
      if (!rel.startsWith(p)) continue;
      if (!hits.has(repoDir)) hits.set(repoDir, new Set());
      hits.get(repoDir)!.add(p);
    }
  }
  if (!hits.size) return;

  const multi = hits.size > 1 || repos.length > 1;
  const shown: string[] = [];
  for (const [repoDir, ps] of hits) {
    record('shell_bypass_warn', repoDir, { detail: [...ps].join(',') });
    for (const p of ps) shown.push(multi ? `${repoLabel(input, repoDir)}/${p}` : p);
  }
  emitAllowWithNote(
    'PreToolUse',
    `注意：这条命令看起来会用 shell 写入公共层（${shown.join('、')}）。` +
      '绕开文件工具不会触发影响面检查 —— 如果确实要改公共层文件，请先查影响面。',
  );
}

// ══════════════════ post-write / post-fail ══════════════════

/**
 * 写完之后：超行数上限就提醒，并更新 L3 计数器。
 *
 * 提醒里点明"按本仓已有的拆法拆"——不加这句，模型会自己发明一套目录结构，
 * 而仓里已经有约定了。
 */
function postWrite(input: HookInput): void {
  const raw = writeTarget(input);
  const target = raw ? fileTarget(input, raw) : null;
  const repoDir = target?.repoDir ?? repoOf(input);
  const cfg = loadGuardConfig(repoDir);
  const rel = target ? toRepoRelative(repoDir, target.abs) : null;

  noteToolResult(repoDir, cfg, input.tool_name ?? 'Write', input.tool_input, rel, toolSucceeded(input));

  const facts = readFacts(repoDir);
  if (!rel) return;

  const notes: string[] = [];

  // ① 超行数上限。依赖 repo-facts，没配就跳过
  //
  // 只在「这次把文件写超了」时提醒：文件在 HEAD 里就已经超限，说明是历史债，催拆会让 AI
  // 在一个只要求内联函数的任务里顺手大重构（A/B 实测：E2 因此多出一倍轮次）。
  // 同一文件每会话只提醒一次 —— 连续几次 Edit 每次都提醒，等于一直催。
  if (facts) {
    const n = countLines(path.join(repoDir, rel));
    if (n > facts.lineLimit) {
      const before = headLines(repoDir, rel);
      if (before !== null && before > facts.lineLimit) {
        record('oversize_preexisting', repoDir, { file: rel, detail: `${before}->${n}` });
      } else if (claimStopNotice(`oversize:${repoId(repoDir)}:${rel}`)) {
        record('oversize_warn', repoDir, { file: rel, detail: String(n) });
        notes.push(
          `\`${rel}\` 现在有 ${n} 行，超过本仓上限 ${facts.lineLimit} 行。` +
            '按本仓已有的拆法拆开，不要自己发明结构。',
        );
      }
    }
  }

  // ② 规范的 remind 级命中。**只在项目层铺过规范时才有输出**（见 evaluate.ts 文件头）
  //
  // ⚠️ `scanFile` 是 evaluate.ts 里唯一不自带 `isActionable` 闸门的导出 ——
  // 它只看 `snap.enabled`，因为 `standards check` 这个 CLI 必须能在只有全局层时
  // 给出自查结论。所以**闸门必须由调用方加**，而运行时这一侧就是这里。
  // 少了它，部门往全局层加一条 remind + post_write + content_regex 的规范，
  // 会让所有装了这个包、但没铺项目层的仓库都开始收到提醒 —— 那正是
  // 「项目层不存在 = 零行为变化」要挡住的事。
  const std = standardsOf(repoDir, facts);
  const hits = isActionable(std) ? scanFile(std, repoDir, rel, 'post_write') : [];
  const note = remindNote(hits, rel);
  if (note) {
    for (const h of hits) {
      if (h.severity !== 'remind') continue;
      record('standards_hit', repoDir, { file: rel, rule: h.item.id });
    }
    notes.push(note);
  }

  if (notes.length) emitContext('PostToolUse', notes.join('\n\n'));
}

/** 工具失败之后：只更新 L3 计数器，不输出任何东西 */
/**
 * Bash 执行之后：只更新循环门计数。非零退出宿主走的是 PostToolUse（tool_response 里
 * exitCode / error / is_error），不走 PostToolUseFailure —— 真机抓过输入确认。
 * 没有这一步，Bash 的成功就清不掉连续失败计数。
 */
function postBash(input: HookInput): void {
  const cmd = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  const cwd = bashCwd(input, cmd);
  // 循环计数是会话级的（按工具名 + 命令指纹），repoDir 只决定读哪份配置、埋点记到哪：取命令所在的第一个仓
  const repoDir = sessionRepos(cwd)[0];
  noteToolResult(repoDir, loadGuardConfig(repoDir), input.tool_name ?? 'Bash', input.tool_input, null, toolSucceeded(input));
  // AI 在终端里跑了 atlas impact / similar / hot：和调 MCP 一样算「查过」
  if (/\batlas\s+(impact|similar|hot)\b/.test(cmd)) trackAtlasBash(cwd, cmd);
}

/**
 * code-atlas 的图谱工具调用之后（PostToolUse，matcher 见 hooks.json）：记会话状态。
 * 原来由 repo-guard 自己的 MCP 在 impact / hot / similar 里记；图谱移交 code-atlas 后改在这里记。
 * 只写状态与埋点，不输出任何东西。
 */
function postAtlas(input: HookInput): void {
  const name = input.tool_name ?? '';
  if (!name.startsWith('mcp__code-atlas__')) return;
  trackAtlasTool(cwdOf(input), name, (input.tool_input ?? {}) as Record<string, unknown>);
}

function postFail(input: HookInput): void {
  const raw = writeTarget(input);
  const target = raw ? fileTarget(input, raw) : null;
  const repoDir = target?.repoDir ?? repoOf(input);
  const rel = target ? toRepoRelative(repoDir, target.abs) : null;
  noteToolResult(repoDir, loadGuardConfig(repoDir), input.tool_name ?? 'unknown', input.tool_input, rel, false);
}

// ══════════════════ L5 交付门 / L4 诚实信号 ══════════════════

/**
 * AI 响应结束时：交付门 + 迭代预算摘要。
 *
 * ⚠️ `continue:false` 只在 `engineeringCheck.mode === 'block'` 时用，
 * 而且 `claimStopNotice` 保证同一 reason 每会话只触发一次 ——
 * 宿主没有实现 `loop_limit`，不去重就会无限续跑。
 */
/**
 * 写后比对：本轮 similar 留下过参考计划、且本轮写过文件时才跑。
 * 交给 code-atlas：`atlas conform --plan <临时 json> <改动文件…> --json`。新代码刚写进去，
 * 图谱必然过期 —— 这里允许 atlas 增量建图，限时 12 秒（Stop 预算 15 秒），任何失败都放行。
 * 同一份结论每会话只说一次 —— 改了代码结论变了会再说。
 */
/** 写后比对每会话最多阻止停止几次。AI 改了还偏、或者有理由不照参考写，第三次就放它走 */
const CONFORM_MAX_BLOCKS = 2;
const CONFORM_TIMEOUT_MS = 12_000;

interface AtlasConformResult {
  resource: string;
  template: string | null;
  items?: Array<{ issue?: string | null }>;
  duplicates?: unknown[];
  drift: boolean;
  text: string;
}

async function conformNote(repoDir: string): Promise<{ text: string; drift: boolean }> {
  const none = { text: '', drift: false };
  const plans = similarPlans(repoDir).filter((p) => p.kind !== 'exists');
  if (!plans.length) return none;
  const touched = sessionTouchedFiles(repoDir);
  if (!touched.length) return none;

  const tmp = path.join(os.tmpdir(), `repo-guard-plans-${process.pid}-${Date.now()}.json`);
  let results: AtlasConformResult[] = [];
  try {
    fs.writeFileSync(tmp, JSON.stringify(plans.map(({ ts: _ts, repo: _repo, ...p }) => p)));
    const r = atlasJson<{ results?: AtlasConformResult[] }>(['conform', '--plan', tmp, ...touched, '--json', '--repo', repoDir], {
      cwd: repoDir,
      timeoutMs: CONFORM_TIMEOUT_MS,
    });
    if (!r.ok) return none;
    results = Array.isArray(r.data.results) ? r.data.results : [];
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件删不掉无所谓 */
    }
  }

  const out: string[] = [];
  let drift = false;
  for (const r of results) {
    if (!r || typeof r.text !== 'string') continue;
    const key = plans.find((p) => p.resource === r.resource)?.key ?? r.resource;
    if (!claimStopNotice(`conform:${key}:${hashText(r.text)}`)) continue;
    if (r.drift) drift = true;
    const kinds = [...new Set([...(r.items ?? []).map((i) => i.issue).filter((x): x is string => !!x), ...(r.duplicates?.length ? ['duplicate'] : [])])];
    record(r.drift ? 'conform_drift' : 'conform_ok', repoDir, {
      detail: `${r.resource}<-${r.template ?? ''}${kinds.length ? `:${kinds.join(',')}` : ''}`,
    });
    out.push(r.text);
  }
  // 拦的次数用完了就只提醒、不再阻止停止
  if (drift && !claimConformBlock()) drift = false;
  return { text: out.join('\n\n'), drift };
}

/** 占一个「阻止停止」的名额。名额 = conform-block:1..N，占满返回 false */
function claimConformBlock(): boolean {
  for (let i = 1; i <= CONFORM_MAX_BLOCKS; i++) if (claimStopNotice(`conform-block:${i}`)) return true;
  return false;
}

function hashText(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function stop(input: HookInput): Promise<void> {
  // 多仓工作区：逐仓比对、逐仓判交付门。交付门与迭代提示按会话计数、按原因去重，
  // 所以几个仓都开着同一道门也只说一次
  const confTexts: string[] = [];
  const blockNotes: string[] = [];
  const notes: string[] = [];
  let drift = false;
  const push = (arr: string[], t: string) => {
    if (t && !arr.includes(t)) arr.push(t);
  };
  for (const repoDir of reposOf(input)) {
    const cfg = loadGuardConfig(repoDir);
    let conf = { text: '', drift: false };
    try {
      conf = await conformNote(repoDir);
    } catch {
      /* 比对失败不能影响收尾 */
    }
    if (conf.drift) drift = true;
    push(confTexts, conf.text);
    const d = judgeDelivery(cfg, repoDir);
    if (d.block) push(blockNotes, d.note);
    else push(notes, d.note);
    push(notes, iterationNote(cfg));
  }

  // 写后比对有偏差：阻止停止，让 AI 照参考改（或说明为什么不照）。只放 additionalContext 的话，
  // 宿主在 Stop 上不会再给模型一轮，结论就只落在埋点里、代码不会变
  if (blockNotes.length || drift) {
    emitContinue([...blockNotes, ...confTexts].join('\n\n'));
    return;
  }

  const all = [...notes, ...confTexts];
  if (all.length) emitContext('Stop', all.join('\n\n'));
}

function sessionEnd(input: HookInput): void {
  for (const repoDir of reposOf(input)) {
    recordFinalSignal(loadGuardConfig(repoDir), repoDir);
    record('session_end', repoDir);
  }
  // 会话状态是一次性的，顺手清掉过期的。失败无所谓
  sweepStaleSessions();
}

// ══════════════════ 分发 ══════════════════

export async function runHook(name: string): Promise<number> {
  try {
    const input = readStdin();
    // 会话 id 只在 stdin 里 —— 必须在任何读写状态之前灌进去，
    // 否则各钩子（post-atlas 记、pre-write 读）的状态对不上
    setSessionId(input.session_id);
    // 让 MCP 进程（拿不到会话 id）能认领到这个会话，见 session-state 的 adoptSessionFor
    bindCurrentSession(repoOf(input));
    for (const r of reposOf(input)) if (r !== repoOf(input)) bindCurrentSession(r);
    switch (name) {
      case 'session-start':
        sessionStart(input);
        break;
      case 'user-prompt-submit':
        userPromptSubmit(input);
        break;
      case 'pre-write':
        preWrite(input);
        break;
      case 'pre-bash':
        preBash(input);
        break;
      case 'post-write':
        postWrite(input);
        break;
      case 'post-bash':
        postBash(input);
        break;
      case 'post-atlas':
        postAtlas(input);
        break;
      case 'post-fail':
        postFail(input);
        break;
      case 'post-compact':
        postCompact(input);
        break;
      case 'stop':
        await stop(input);
        break;
      case 'session-end':
        sessionEnd(input);
        break;
      default:
        // 未知钩子名：什么都不做、退出 0。
        // 宿主新增了事件而插件还没跟上时，不能因此报错刷屏。
        break;
    }
  } catch (e) {
    // 见文件头铁律 ③。诊断信息写 stderr（stdout 有输出时宿主不读 stderr，
    // 所以这里不会污染协议通道）
    process.stderr.write(`[repo-guard] hook ${name} 失败，已放行：${(e as Error).message}\n`);
  }
  return 0;
}

export type { HookInput, RepoFacts, GuardConfig };
export { isDeliveryAction };
