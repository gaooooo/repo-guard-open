/**
 * L1 准入门 —— 红线硬判定、禁改清单、范围门。
 *
 * ── 这个文件的主要工作是「翻译」 ──
 * 引擎里的 `checkToolCall` 是从 deerclaw 逐字移植过来的，它认的是那边的工具名
 *（`file_write`）和参数形状（`{path, content}`）。CodeBuddy 的写工具有八个名字、
 * 三种参数形状。翻译这一层放在这里，**不去改引擎** —— 引擎里那套三层判定
 *（结构化删除 / 意图正则 / paths 收窄）的误报率是在真实仓库上调出来的，
 * 动它必然漂，而漂了之后没有报错，只表现为"有时候拦有时候不拦"。
 *
 * ── 一个顺带的收获：Edit 也能拿到真 diff ──
 * deerclaw 那边只有全量覆盖写（`file_write`），所以 L1 结构化删除判定的前提是
 * "读磁盘拿 before，参数里拿 after"。CodeBuddy 的 `Edit` 只给
 * `old_string` / `new_string`，看起来拿不到 after。
 *
 * 但其实能算：读到 before 之后**把替换应用一遍**就是精确的 after。
 * 这比 deerclaw 那边覆盖的场景更宽 —— 那边遇到增量编辑只能退到 L2 意图正则，
 * 而 L2 要求"受保护标识符 + 破坏性动作"双条件，改代码时几乎不会命中。
 * 所以这里实际上是**加强**了红线的判定能力。
 */
import fs from 'node:fs';
import path from 'node:path';

import { checkToolCall } from '../engine/policy-engine.js';
import type { KnowledgeSnapshot, PolicyRule, PolicyVerdict } from '../engine/types.js';
import { normalizePrefix } from '../runtime/repo-facts.js';
import {
  countSessionFiles,
  recordSessionFile,
  sessionTouchedFiles,
} from '../runtime/session-state.js';
import type { GuardConfig } from './config.js';

/** 宿主喂进来的写工具参数。字段名在 CLI 与 IDE 两种形态下不一样 */
export interface WriteToolInput {
  file_path?: string;
  notebook_path?: string;
  path?: string;
  target_file?: string;
  filePath?: string;
  /** Write / write_to_file：全量内容 */
  content?: string;
  /** Edit / replace_in_file：增量替换 */
  old_string?: string;
  new_string?: string;
  /** IDE 保留的原始替换参数（工具名可已归一为 Edit） */
  old_str?: string;
  new_str?: string;
  replace_all?: boolean;
  /** MultiEdit / multi_replace：一组替换 */
  edits?: unknown;
  [k: string]: unknown;
}

interface OneEdit {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

function asEdits(input: WriteToolInput): OneEdit[] {
  const out: OneEdit[] = [];
  const push = (o: unknown, n: unknown, all: unknown) => {
    if (typeof o !== 'string' || typeof n !== 'string') return;
    out.push({ oldString: o, newString: n, replaceAll: all === true });
  };
  push(input.old_string ?? input.old_str, input.new_string ?? input.new_str, input.replace_all);
  if (Array.isArray(input.edits)) {
    for (const raw of input.edits) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as Record<string, unknown>;
      push(e.old_string ?? e.old_str, e.new_string ?? e.new_str, e.replace_all);
    }
  }
  return out;
}

function replaceAllLiteral(hay: string, needle: string, repl: string): string {
  if (!needle) return hay;
  return hay.split(needle).join(repl);
}

/**
 * 算出这次写入之后文件的内容。
 *
 * 返回 null 表示算不出来 —— 此时引擎会自动退到 L2 意图正则。
 * **算不准就不要算**：一个错的 after 会让结构化删除判定给出错误结论，
 * 而那是硬拦，误伤直接挡住人干活。
 */
export function computeAfter(before: string | null, input: WriteToolInput): string | null {
  // 全量覆盖写：参数里就是 after
  if (typeof input.content === 'string') return input.content;

  const edits = asEdits(input);
  if (!edits.length || before == null) return null;

  let cur = before;
  for (const e of edits) {
    if (!e.oldString) return null; // 空 old_string 语义不明，不猜
    if (e.replaceAll) {
      cur = replaceAllLiteral(cur, e.oldString, e.newString);
      continue;
    }
    const at = cur.indexOf(e.oldString);
    // 找不到锚点说明这次编辑会失败，或者我们理解错了参数形状。
    // 两种情况都不该继续算 —— 算出来的 after 不是真的会落盘的那个。
    if (at < 0) return null;
    cur = cur.slice(0, at) + e.newString + cur.slice(at + e.oldString.length);
  }
  return cur;
}

export interface AdmissionVerdict {
  blocked: boolean;
  /** 给 Agent 看的原因。blocked 时必填 */
  reason?: string;
  /** 埋点用 */
  kind?: 'redline' | 'no_refactor' | 'scope_allowlist' | 'scope_budget';
  ruleId?: string;
}

const PASS: AdmissionVerdict = { blocked: false };

/**
 * 红线与禁改清单判定。
 *
 * guard 配置里的 `constraint/no-refactor.json` 会**并进快照**再交给引擎 ——
 * 引擎的 `checkToolCall` 已经实现了 no_refactor 的路径级硬拦，
 * 在外面另写一套等于两份判定逻辑，迟早不一致。
 *
 * ── `extraRules` 为什么能绕过 L1 总闸 ──
 * 它装的是 `.codebuddy/standards/` 编译出来的 block 级规范。那套配置有自己的
 * 总闸（`standards.json` 的 `enabled` + `maxSeverity`），把 `maxSeverity` 调到
 * `block` 已经是极其明确的表态 —— 再要求同时打开 guard 的 L1，就成了两套开关，
 * 人会困惑「我开了为什么不拦」。配置集中是这套设计的硬要求。
 *
 * 所以两类规则各自受自己的闸门控制：L1 关着时快照里的手写红线不判，
 * 但 standards 的 block 仍判。
 */
export function judgeRedline(
  repoDir: string,
  snapshot: KnowledgeSnapshot,
  cfg: GuardConfig,
  rel: string,
  toolInput: WriteToolInput,
  extraRules: PolicyRule[] = [],
): AdmissionVerdict {
  const l1 = cfg.gates.admission;
  if (!l1 && !extraRules.length) return PASS;

  let before: string | null = null;
  try {
    before = fs.readFileSync(path.join(repoDir, rel), 'utf-8');
  } catch {
    before = null; // 新建文件：没有 before，引擎会自动退到 L2
  }
  const after = computeAfter(before, toolInput);

  // 把 guard 的禁改清单并进快照。engine 只认 snapshot.policy.no_refactor
  const redLines = [...(l1 ? snapshot.policy.red_lines : []), ...extraRules];
  const noRefactor = l1
    ? [
        ...snapshot.policy.no_refactor,
        ...cfg.noRefactor.map((e) => ({ path: e.path, reason: e.reason, confirmed: e.confirmed })),
      ]
    : [];
  const merged: KnowledgeSnapshot = {
    ...snapshot,
    ok: (l1 && snapshot.ok) || redLines.length > 0 || noRefactor.length > 0,
    policy: {
      ...snapshot.policy,
      red_lines: redLines,
      no_refactor: noRefactor,
    },
  };

  const verdict: PolicyVerdict = checkToolCall(merged, {
    // 伪装成 deerclaw 的 file_write：引擎靠这个名字判断"这是不是写工具"。
    // 我们已经在钩子的 matcher 上确认过它确实是写工具了。
    toolName: 'file_write',
    args: after == null ? {} : { path: rel, content: after },
    beforeContent: before,
    relPath: rel,
  });

  if (!verdict.blocked) return PASS;

  /**
   * 有真 diff 时忽略 L2 意图正则。
   *
   * 引擎的判定链是 L1（结构化删除，看真 diff）→ 失败则退到 L2（意图正则）。
   * L2 是为 **bash 场景**设计的：拿不到 diff，只能从命令文本里找
   *「受保护标识符 + 破坏性动作」双信号。
   *
   * 但我们这里把 after 当 `content` 传了进去 —— 而 L2 会把整个 args 当命令文本扫，
   * 于是代码里一个箭头函数 `() =>` 里的 `>` 就被当成了"shell 重定向覆盖写"，
   * 再加上文件里本来就有受保护标识符，双信号凑齐 → 误拦。
   *
   * 关键点：**L1 已经给出结论了**。before 和 after 都在手上，
   * 它说"没有删除"就是没有删除。此时再让 L2 从文本里猜，猜出来的一定是噪音。
   * 所以只在 L1 不适用（算不出 after）时才承认 L2 的结论。
   */
  if (verdict.layer === 'intent_regex' && before != null && after != null) {
    return PASS;
  }

  const r = verdict.rule;
  const lines: string[] = [];
  if (verdict.layer === 'no_refactor') {
    lines.push(`\`${rel}\` 在禁止重构清单里。`);
    if (verdict.detail) lines.push(verdict.detail);
    lines.push(
      '这类代码被冻结通常是因为"它现在能跑，但谁也说不清为什么"——',
      '里面可能有没测试、没注释的历史 hack。要改必须先找人确认。',
    );
    return { blocked: true, reason: lines.join('\n'), kind: 'no_refactor' };
  }

  lines.push(`这次改动命中红线 ${r?.id ?? '?'}：${r?.rule ?? ''}`);
  if (r?.reason) lines.push(`为什么：${r.reason}`);
  if (verdict.detail) lines.push(verdict.detail);
  lines.push(
    // 判定层要说出来：人和模型都需要知道这是"有真 diff 的硬证据"
    // 还是"从命令文本猜的"，两者的可信度差很多
    verdict.layer === 'structural_delete'
      ? '（判据：对比改动前后的文件内容，受保护标识符出现次数减少了。这是硬证据。）'
      : `（判据层：${verdict.layer}）`,
    // 指路必须指对文件：`STD-` 前缀的规则是从 .codebuddy/standards/ 编译来的，
    // 让模型去改 redlines.json 会让它改错地方 —— 然后以为改了没生效
    r?.id?.startsWith('STD-')
      ? '如果确实该改，请先和维护者确认，然后更新 .codebuddy/standards/ 里对应的那条规范（去掉受保护符号或关闭该条目）—— 不要绕过它。'
      : '如果确实该改，请先和维护者确认，然后更新 .codebuddy/redlines.json 里的这条规则 —— 不要绕过它。',
  );
  return { blocked: true, reason: lines.join('\n'), kind: 'redline', ruleId: r?.id };
}

/**
 * 范围门：allowlist + 单会话文件数预算。
 *
 * ── maxFiles 的真实作用不是省事，是失控探测 ──
 * 一次任务本该改 3 个文件，改到第 15 个还在改，说明要么任务被理解错了，
 * 要么它在到处打补丁。这时候该停下来问人，而不是让它继续。
 */
export function judgeScope(
  repoDir: string,
  cfg: GuardConfig,
  rel: string,
): AdmissionVerdict {
  if (!cfg.gates.admission || !cfg.scopeGate.enabled) return PASS;

  const allow = cfg.scopeGate.allowlist.map(normalizePrefix).filter(Boolean);
  if (allow.length) {
    // allowlist 里的条目既可能是目录前缀也可能是精确文件路径
    const ok = allow.some((p) => rel.startsWith(p)) ||
      cfg.scopeGate.allowlist.some((p) => p.trim() === rel);
    if (!ok) {
      return {
        blocked: true,
        kind: 'scope_allowlist',
        reason:
          `\`${rel}\` 不在本次任务允许改动的范围内。\n` +
          `允许的范围：${cfg.scopeGate.allowlist.join('、')}\n` +
          '范围外的改动即使是对的，review 的人也不会预期看到它。' +
          '确实需要改就先说明理由，或者让人调整 .codebuddy/guard/constraint/scope-gate.json。',
      };
    }
  }

  const budget = cfg.scopeGate.maxFiles;
  if (budget && budget > 0) {
    // 已经改过的文件不再计数 —— 预算管的是"涉及面有多宽"，不是"写了多少次"
    const already = countSessionFiles();
    const isNew = !hasTouched(repoDir, rel);
    if (isNew && already >= budget) {
      return {
        blocked: true,
        kind: 'scope_budget',
        reason:
          `本次会话已经改动了 ${already} 个文件，达到预算上限 ${budget}。\n` +
          '这个上限是个失控探测器：一次任务改到这么多文件，通常意味着任务被理解错了，' +
          '或者在到处打补丁。请先说明还要改哪些、为什么，让人确认后再继续。',
      };
    }
  }
  return PASS;
}

/** 记下这次改动涉及的文件（范围门预算用）。放行之后才记 */
export function noteTouched(repoDir: string, rel: string): void {
  recordSessionFile(repoDir, rel);
  touchedCache(repoDir).add(rel);
}

function hasTouched(repoDir: string, rel: string): boolean {
  return touchedCache(repoDir).has(rel);
}

/**
 * 本进程内缓存一次。
 *
 * 每个 hook 是一次性子进程，所以"本进程"就是"这一次判定"——
 * 缓存在这里只是避免同一次判定里反复读同一个状态文件，不存在跨调用失效问题。
 * 同理，一次判定只涉及一个仓，所以不必按 repoDir 分桶。
 */
let touched: Set<string> | null = null;
function touchedCache(repoDir: string): Set<string> {
  if (!touched) touched = new Set(sessionTouchedFiles(repoDir));
  return touched;
}
