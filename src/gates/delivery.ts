/**
 * L5 交付门 + L4 诚实信号。
 *
 * ── L5 与 deerclaw 有一处有意的分歧 ──
 * deerclaw 侧工程校验是**始终硬拦提交**的。这里默认关，开启后也只提醒。
 *
 * 那边的硬拦成立，是因为 agent 在**平台自己的 workspace / worktree** 里干活，
 *「提交」是平台的动作，拦得住也拦得对。CodeBuddy 里 agent 在**用户的工作树**上
 * 干活，`git commit` 是用户随时可能自己敲的动作。插件在 Stop 上硬拦会直接妨碍人
 * —— 而误伤率高的门会被卸载，卸载之后连提醒都没了。
 *
 * **误伤优先于治理强度。** 这是这个插件所有默认值背后的同一条判断。
 *
 * ── 真要硬拦，正确做法不在插件里 ──
 * 在宿主的 permissions 里：`"ask": ["Bash(git commit:*)", "Bash(git push:*)"]`。
 * 那是用户自己的选择，而且宿主的确认对话框比插件的 deny 体验好得多。
 *
 * ── L4 诚实信号为什么只能近似 ──
 * deerclaw 的 finalReason 有四态（success / reached_max_iterations / empty_output /
 * error）加 11 类 failureCategory，那些来自它对 ReAct 循环的所有权。
 * 插件看不到"子 agent 抛异常""thinking_exhausted"这类内部状态，
 * 能算的只有：工具调用数、失败数、有没有写操作、有没有跑过体检。
 * 所以这里明确标成 approximate，不要让读报表的人以为它等价于平台那套。
 */
import { record } from '../runtime/metrics.js';
import {
  claimStopNotice,
  consecutiveFailCount,
  countSessionFiles,
  evidenceList,
  recordEvidence,
  toolCallCount,
} from '../runtime/session-state.js';
import type { GuardConfig } from './config.js';

/**
 * 内置的工程校验证据关键词。
 *
 * 判据是"命令里出现了这些词"，而不是"命令成功了" —— 因为 hook 拿不到
 * 后续的退出码。所以这是个**弱证据**：它只能回答"跑没跑过"，
 * 不能回答"过没过"。文案里必须说清这一点，否则人会以为这道门保证了质量。
 */
const BUILTIN_EVIDENCE: Array<{ kind: string; re: RegExp }> = [
  { kind: 'lint', re: /\b(lint|eslint|oxlint|biome|golangci-lint|ruff|flake8|pylint)\b/ },
  { kind: 'test', re: /\b(test|vitest|jest|pytest|go\s+test|mvn\s+test|gradle\s+test)\b/ },
  { kind: 'build', re: /\b(build|tsc|go\s+build|mvn\s+package|gradle\s+build|cargo\s+build)\b/ },
  { kind: 'typecheck', re: /\b(typecheck|type-check|tsc\s+--noEmit|mypy)\b/ },
];

/** 交付动作：跑到这些命令说明在提交 */
const DELIVERY_ACTION = /\bgit\s+(commit|push)\b|\b(mr|pr)\s+create\b|\bgh\s+pr\s+create\b/;

/** 从一条 shell 命令里认工程校验证据，认出来就记下 */
export function noteEvidence(cfg: GuardConfig, command: string): void {
  const cmd = (command ?? '').toLowerCase();
  if (!cmd.trim()) return;
  for (const e of BUILTIN_EVIDENCE) {
    if (e.re.test(cmd)) recordEvidence(e.kind);
  }
  for (const p of cfg.delivery.evidencePatterns) {
    const s = p.trim().toLowerCase();
    if (s && cmd.includes(s)) recordEvidence(`custom:${s}`);
  }
}

/** 这条命令是在交付吗 */
export function isDeliveryAction(command: string): boolean {
  return DELIVERY_ACTION.test((command ?? '').toLowerCase());
}

export interface DeliveryVerdict {
  /** 要不要阻止停止。只有 mode=block 且证据缺失时为 true */
  block: boolean;
  /** 要给出的提醒文本。空表示没话说 */
  note: string;
}

const QUIET: DeliveryVerdict = { block: false, note: '' };

/**
 * Stop 时的交付门判定。
 *
 * 去重是**强制的**：同一个 reason 每会话最多注入一次。
 * 宿主没有实现 `loop_limit`（内部市场有插件在用，CodeBuddy 会忽略），
 * 所以不去重的话 `continue:false` 会让模型反复触发同一个校验、无限续跑。
 */
export function judgeDelivery(cfg: GuardConfig, repoDir: string): DeliveryVerdict {
  if (!cfg.gates.delivery || !cfg.delivery.enabled) return QUIET;

  // 用跨仓总数：交付瘦身管的是"这一个提交里塞了多少东西"，
  // 而一次提交可能横跨多个仓（微服务改动常常是这样）
  const touchedCount = countSessionFiles();
  if (!touchedCount) return QUIET; // 没改东西，无所谓交付

  const notes: string[] = [];
  let block = false;

  // ── 交付瘦身 ──
  const budget = cfg.delivery.deliveryBudget;
  if (budget.enabled && budget.maxDeliveryFiles && touchedCount > budget.maxDeliveryFiles) {
    if (claimStopNotice('delivery_budget')) {
      notes.push(
        `本次改动涉及 ${touchedCount} 个文件，超过交付上限 ${budget.maxDeliveryFiles}。\n` +
          '建议拆成多个提交：一次提交里混进太多无关改动，review 的人只能整体通过或整体打回。',
      );
    }
  }

  // ── 工程校验 ──
  const ec = cfg.delivery.engineeringCheck;
  if (ec.enabled) {
    const have = evidenceList();
    if (!have.length && claimStopNotice('engineering_check')) {
      notes.push(
        `改了 ${touchedCount} 个文件，但本会话没有出现过 lint / test / build 的执行记录。\n` +
          '在提交之前跑一次本仓的检查命令。\n' +
          '（判据是"命令里出现过这些词"，不是"检查通过了"—— 钩子拿不到退出码。' +
          '所以这条提醒不能替代你自己看结果。）',
      );
      block = ec.mode === 'block';
    }
  }

  if (!notes.length) return QUIET;
  record('delivery_warn', repoDir, { detail: block ? 'block' : 'warn' });
  return { block, note: notes.join('\n\n') };
}

/**
 * L4 诚实信号 —— 会话收尾时落一条近似的 finalReason。
 *
 * 纯埋点，不影响任何行为。
 */
export function recordFinalSignal(cfg: GuardConfig, repoDir: string): void {
  if (!cfg.gates.signals) return;

  const touchedCount = countSessionFiles();
  const calls = toolCallCount();
  const fails = consecutiveFailCount();
  const evidence = evidenceList();

  // 只有四种能从外部观测到的状态。**不要**硬凑成 deerclaw 的四态 ——
  // 名字一样而语义不同，比名字不一样更容易误导读报表的人
  const signal =
    calls === 0
      ? 'no_tool_use'
      : fails > 0
        ? 'ended_with_failures'
        : touchedCount === 0
          ? 'read_only'
          : evidence.length
            ? 'wrote_and_verified'
            : 'wrote_unverified';

  record('final_signal', repoDir, {
    detail: JSON.stringify({
      approximate: true,
      signal,
      toolCalls: calls,
      touchedFiles: touchedCount,
      consecutiveFailAtEnd: fails,
      evidence,
    }),
  });
}
