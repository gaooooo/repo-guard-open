/**
 * L3 循环门 —— 捕捉失控，不是捕捉错误。
 *
 * ── 四项里只有前三项能真拦 ──
 * 重复调用 / 连续失败 / 同文件写失败：**只依赖工具调用序列**，
 * `PostToolUse` 计数 + `PreToolUse` 短路就能实现。
 *
 * 迭代预算不行。CodeBuddy 里迭代循环归宿主，插件拿不到 iteration 序号。
 * deerclaw 撞 maxIterations 时是**优雅降级**（产出已完成工作摘要 + 可续提示），
 * 插件做不到 —— 它没有对话循环的所有权。所以只能在 Stop 上给个摘要，
 * 而且不阻止停止。
 *
 * ── 为什么阈值是 3，不要往下调 ──
 * 第 1 次失败可能是笔误，第 2 次是没理解报错，第 3 次才是卡住了。
 * 设成 2 会在正常的试错中误伤。
 *
 * ── 为什么这道门值得做 ──
 * 它捕捉的是**失控**而不是错误。一个工具连着失败 3 次、或者同一个调用重复 3 次，
 * 说明模型陷在一个它自己出不来的坑里，此时继续只会烧 token。
 * 拦下来并给"换个路径"的提示，比让它转 20 圈划算。
 */
import {
  bumpConsecutiveFail,
  bumpFileWriteFail,
  bumpRepeat,
  clearConsecutiveFail,
  consecutiveFailCount,
  fileWriteFailCount,
  repeatCountOf,
  toolCallCount,
} from '../runtime/session-state.js';
import type { GuardConfig } from './config.js';

/**
 * 算调用指纹。
 *
 * 取路径与命令，**不取文件内容**：含内容的话模型改一个字就成了"新调用"，
 * 重复计数永远到不了阈值，而"改一个字再试一次"恰恰是它卡住时最典型的行为。
 */
export function fingerprint(toolInput: Record<string, unknown> | undefined): string {
  if (!toolInput) return '';
  const parts: string[] = [];
  for (const k of ['file_path', 'notebook_path', 'path', 'target_file', 'command', 'urlPath', 'file'] as const) {
    const v = toolInput[k];
    if (typeof v === 'string' && v.trim()) parts.push(`${k}=${v.trim()}`);
  }
  return parts.join('&');
}

export interface LoopVerdict {
  blocked: boolean;
  reason?: string;
  kind?: 'repeat' | 'consecutive_fail' | 'file_write_fail';
}

const PASS: LoopVerdict = { blocked: false };

/** 工具执行**之前**：看三个计数器有没有到阈值 */
export function judgeLoop(
  repoDir: string,
  cfg: GuardConfig,
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  rel: string | null,
): LoopVerdict {
  if (!cfg.gates.L3_loop || !cfg.loop.enabled) return PASS;

  const fp = fingerprint(toolInput);
  if (fp) {
    const n = repeatCountOf(toolName, fp);
    if (n >= cfg.loop.repeatToolCallThreshold) {
      return {
        blocked: true,
        kind: 'repeat',
        reason:
          `同一个调用已经重复 ${n} 次（${toolName} ${fp}）。\n` +
          '重复同一个操作说明当前路径走不通。**换个方式**：\n' +
          '  · 如果是在试错改代码，先把报错完整读一遍，别改一个字就重试\n' +
          '  · 如果是在找东西，换关键词或换工具（Grep → Glob → 图谱查询）\n' +
          '  · 如果确实卡住了，说明卡在哪，让人来看',
      };
    }
  }

  const fails = consecutiveFailCount();
  if (fails >= cfg.loop.consecutiveFailThreshold) {
    return {
      blocked: true,
      kind: 'consecutive_fail',
      reason:
        `已经连续失败 ${fails} 次。\n` +
        '连续失败通常不是这一步的问题，而是前提错了（路径不对、依赖没装、环境不对）。\n' +
        '先确认前提，或者把失败信息原样报给人 —— 不要继续试。',
    };
  }

  if (rel) {
    const fileFails = fileWriteFailCount(repoDir, rel);
    if (fileFails >= cfg.loop.sameFileWriteFailThreshold) {
      return {
        blocked: true,
        kind: 'file_write_fail',
        reason:
          `写 \`${rel}\` 已经失败 ${fileFails} 次。\n` +
          '同一个文件反复写失败，常见原因是：文件被占用、路径不存在、' +
          '或者 Edit 的 old_string 与文件实际内容不匹配（先读一遍文件再改）。',
      };
    }
  }

  return PASS;
}

/** 工具执行**之后**：更新计数器。成功与失败走不同分支 */
export function noteToolResult(
  repoDir: string,
  cfg: GuardConfig,
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  rel: string | null,
  ok: boolean,
): void {
  // 计数**不受开关控制**：关着的时候也要能回答"如果开了会拦多少次"。
  // 没有这个数据，人永远不知道该不该开。
  const fp = fingerprint(toolInput);
  if (fp) bumpRepeat(toolName, fp);

  if (ok) {
    // 这一步不能漏 —— 漏了"连续失败"就变成了"累计失败"，
    // 一次会话里零散失败 3 次就会被误拦
    clearConsecutiveFail();
    return;
  }
  bumpConsecutiveFail();
  if (rel) bumpFileWriteFail(repoDir, rel);
  void cfg;
}

/**
 * Stop 时的迭代预算摘要。**只提醒，不阻止停止。**
 *
 * 用工具调用总数近似 iteration 数。这个近似是偏高的（一轮里可能调多个工具），
 * 所以阈值取配置值的 1.5 倍，宁可不提也别乱提。
 */
export function iterationNote(cfg: GuardConfig): string {
  if (!cfg.gates.L3_loop || !cfg.loop.enabled) return '';
  const calls = toolCallCount();
  const soft = Math.floor(cfg.loop.maxIterations * 1.5);
  if (calls < soft) return '';
  return (
    `本会话已经调用了 ${calls} 次工具（参考预算 ${cfg.loop.maxIterations} 轮）。\n` +
    '如果任务还没完成，建议停下来把"已完成 / 还差什么"列清楚再继续 —— ' +
    '长会话的后半程上下文会被压缩，早期的约束可能已经不在视野里了。'
  );
}
