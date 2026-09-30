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
 * `pre-write` 的超时预算只有十几秒，`pre-bash` / `post-write` 只有几秒，
 * 而万文件级仓库建图要几十秒。缓存 miss 就 fail-open。
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
import fs from 'node:fs';
import path from 'node:path';

import { findRepoRoot, toRepoRelative } from '../runtime/paths.js';
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
import { conform, renderConform } from '../insight/conform.js';
import { getGraph } from '../runtime/graph-cache.js';
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
  tool_input?: WriteToolInput & { command?: string };
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

function repoOf(input: HookInput): string {
  return findRepoRoot(input.cwd && input.cwd.trim() ? input.cwd : process.cwd());
}

/** 工具这次成功了吗。拿不到明确信号时按成功算（否则会把连续失败计数打飘） */
function toolSucceeded(input: HookInput): boolean {
  const r = input.tool_response;
  if (!r || typeof r !== 'object') return true;
  if (r.success === false) return false;
  if (r.error) return false;
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
  const repoDir = repoOf(input);
  const facts = readFacts(repoDir);
  record('session_start', repoDir);

  const std = injectSegment(standardsOf(repoDir, facts), 'session_start');

  if (!facts) {
    // 规范可能铺了但 repo-facts 没跑过 —— 两件事互相独立，各说各的
    const head = '本仓还没跑过 repo-guard init —— 公共层与红线都未配置，写前守卫不会生效。';
    emitContext('SessionStart', std ? `${head}\n\n${std}` : head);
    return;
  }

  // guard 配置不存在时 buildInjection 只产出公共层那一段，
  // 与接入 L0 之前的输出逐字节相同 —— 铁律 ④
  const text = buildInjection(facts, loadRedlines(repoDir), loadGuardConfig(repoDir));
  const factNote = '工程事实长文见仓库根 CODEBUDDY.md（本段只注机器摘要）。';
  const all = [text, factNote, std].filter(Boolean).join('\n\n');
  if (all) emitContext('SessionStart', all);
}

/**
 * 压缩之后：重注入 L0。
 *
 * 压缩会把 SessionStart 注入的公共层清单冲掉。不补回去的话，长会话的后半程
 * 模型就不知道哪些目录是公共层了 —— 而守卫还在拦，于是它会觉得工具行为随机。
 */
function postCompact(input: HookInput): void {
  const repoDir = repoOf(input);
  const facts = readFacts(repoDir);
  const std = injectSegment(standardsOf(repoDir, facts), 'post_compact');
  if (!facts) {
    if (std) emitContext('PostCompact', `（上下文压缩后重新注入）\n${std}`);
    return;
  }
  const text = buildInjection(facts, loadRedlines(repoDir), loadGuardConfig(repoDir));
  const all = [text, std].filter(Boolean).join('\n\n');
  if (all) emitContext('PostCompact', `（上下文压缩后重新注入）\n${all}`);
}

/**
 * 用户提交提问：按任务类型注入必读清单 + 相关规范正文。
 *
 * ⚠️ **绝不能阻塞。** `continue:false` 会把用户的提问整个吃掉，
 * 代价远大于任何收益。
 */
function userPromptSubmit(input: HookInput): void {
  const repoDir = repoOf(input);
  const cfg = loadGuardConfig(repoDir);
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';

  const parts: string[] = [];
  const routed = matchTaskRoutes(cfg, prompt);
  if (routed) parts.push(routed);
  const std = promptSegment(standardsOf(repoDir, readFacts(repoDir)), prompt);
  if (std) parts.push(std);
  const hint = featureHint(cfg, prompt);
  if (hint) {
    parts.push(hint);
    record('feature_hint', repoDir);
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

  const repoDir = repoOf(input);
  const facts = readFacts(repoDir);
  const cfg = loadGuardConfig(repoDir);
  const std = standardsOf(repoDir, facts);
  const stdRules = compileBlockRules(std);

  // 未配置 repo-facts 时公共层守卫不生效，但 guard / standards 的门仍可能开着。
  // 所以这里不能直接 return —— 除非三者都没配。
  if (!facts && !cfg.present && !stdRules.length) return; // F1 用例：完全未配置 → fail-open

  const rel = toRepoRelative(repoDir, raw);
  if (!rel) return; // 仓库外：不管（T2 用例）

  // ① L3 循环门
  const loop = judgeLoop(repoDir, cfg, input.tool_name ?? 'write', input.tool_input, rel);
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
    const v = judge(repoDir, facts, snapshot, raw);
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

  const repoDir = repoOf(input);
  const facts = readFacts(repoDir);
  const cfg = loadGuardConfig(repoDir);

  // 工程校验证据要在**执行之前**就记下 —— PostToolUse 拿不到命令原文
  noteEvidence(cfg, cmd);

  if (!facts) return;

  // L3 循环门也管 bash：同一条命令重复跑 3 次基本都是卡住了
  const loop = judgeLoop(repoDir, cfg, 'Bash', input.tool_input, null);
  if (loop.blocked) {
    record('loop_deny', repoDir, { detail: loop.kind });
    emitDeny('PreToolUse', loop.reason!);
    return;
  }

  if (!SHELL_WRITE_PATTERNS.some((re) => re.test(cmd))) return;

  const hits = new Set<string>();
  for (const m of cmd.matchAll(/[\w./@-]*[\w-]+\.[A-Za-z][\w]*|[\w./@-]*\/[\w.-]+/g)) {
    const rel = toRepoRelative(repoDir, m[0]);
    if (!rel) continue;
    for (const p of facts.publicLayer.map((x) => (x.endsWith('/') ? x : `${x}/`))) {
      if (rel.startsWith(p)) hits.add(p);
    }
  }
  if (!hits.size) return;

  record('shell_bypass_warn', repoDir, { detail: [...hits].join(',') });
  emitAllowWithNote(
    'PreToolUse',
    `注意：这条命令看起来会用 shell 写入公共层（${[...hits].join('、')}）。` +
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
  const repoDir = repoOf(input);
  const cfg = loadGuardConfig(repoDir);
  const raw = writeTarget(input);
  const rel = raw ? toRepoRelative(repoDir, raw) : null;

  noteToolResult(repoDir, cfg, input.tool_name ?? 'write', input.tool_input, rel, toolSucceeded(input));

  const facts = readFacts(repoDir);
  if (!rel) return;

  const notes: string[] = [];

  // ① 超行数上限。依赖 repo-facts，没配就跳过
  if (facts) {
    const n = countLines(path.join(repoDir, rel));
    if (n > facts.lineLimit) {
      record('oversize_warn', repoDir, { file: rel, detail: String(n) });
      notes.push(
        `\`${rel}\` 现在有 ${n} 行，超过本仓上限 ${facts.lineLimit} 行。` +
          '按本仓已有的拆法拆开，不要自己发明结构。',
      );
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
function postFail(input: HookInput): void {
  const repoDir = repoOf(input);
  const cfg = loadGuardConfig(repoDir);
  const raw = writeTarget(input);
  const rel = raw ? toRepoRelative(repoDir, raw) : null;
  noteToolResult(repoDir, cfg, input.tool_name ?? 'unknown', input.tool_input, rel, false);
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
 * 要重建图谱（新代码刚写进去，缓存必然过期），四个 gateway 仓实测 0.4~0.7 秒，在 Stop 的 15 秒预算内。
 * 同一份结论每会话只说一次 —— 改了代码结论变了会再说。
 */
/** 写后比对每会话最多阻止停止几次。AI 改了还偏、或者有理由不照参考写，第三次就放它走 */
const CONFORM_MAX_BLOCKS = 2;

async function conformNote(repoDir: string): Promise<{ text: string; drift: boolean }> {
  const none = { text: '', drift: false };
  const plans = similarPlans(repoDir).filter((p) => p.kind !== 'exists');
  if (!plans.length) return none;
  const touched = sessionTouchedFiles(repoDir);
  if (!touched.length) return none;
  const { graph } = await getGraph(repoDir);
  const out: string[] = [];
  let drift = false;
  for (const p of plans) {
    const r = conform(graph, p, touched);
    if (!r) continue;
    const text = renderConform(r);
    if (!claimStopNotice(`conform:${p.key}:${hashText(text)}`)) continue;
    if (r.drift) drift = true;
    const kinds = [...new Set([...r.items.map((i) => i.issue).filter(Boolean), ...(r.duplicates.length ? ['duplicate'] : [])])];
    record(r.drift ? 'conform_drift' : 'conform_ok', repoDir, {
      detail: `${p.resource}<-${p.template ?? ''}${kinds.length ? `:${kinds.join(',')}` : ''}`,
    });
    out.push(text);
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
  const repoDir = repoOf(input);
  const cfg = loadGuardConfig(repoDir);

  let conf = { text: '', drift: false };
  try {
    conf = await conformNote(repoDir);
  } catch {
    /* 比对失败不能影响收尾 */
  }

  const d = judgeDelivery(cfg, repoDir);
  // 写后比对有偏差：阻止停止，让 AI 照参考改（或说明为什么不照）。只放 additionalContext 的话，
  // 宿主在 Stop 上不会再给模型一轮，结论就只落在埋点里、代码不会变
  if (d.block || conf.drift) {
    emitContinue([d.block ? d.note : '', conf.text].filter(Boolean).join('\n\n'));
    return;
  }

  const notes = [d.note, iterationNote(cfg), conf.text].filter(Boolean);
  if (notes.length) emitContext('Stop', notes.join('\n\n'));
}

function sessionEnd(input: HookInput): void {
  const repoDir = repoOf(input);
  const cfg = loadGuardConfig(repoDir);
  recordFinalSignal(cfg, repoDir);
  record('session_end', repoDir);
  // 会话状态是一次性的，顺手清掉过期的。失败无所谓
  sweepStaleSessions();
}

// ══════════════════ 分发 ══════════════════

export async function runHook(name: string): Promise<number> {
  try {
    const input = readStdin();
    // 会话 id 只在 stdin 里 —— 必须在任何读写状态之前灌进去，
    // 否则 impact（MCP 进程，id 从环境变量来）记的状态和这里读的对不上
    setSessionId(input.session_id);
    // 让 MCP 进程（拿不到会话 id）能认领到这个会话，见 session-state 的 adoptSessionFor
    bindCurrentSession(repoOf(input));
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
