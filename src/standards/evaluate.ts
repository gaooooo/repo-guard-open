/**
 * 规范求值 —— 把条目按时机翻译成"注入什么 / 提醒什么 / 拦什么"。
 *
 * ── 这个文件是 CLI 与 hook 的唯一共用判定 ──
 * `standards check`（人主动跑）与 `post-write` 钩子（写完自动跑）必须用**同一份**
 * 判定逻辑。各写一套的后果是"自查说没问题、实际被提醒"或者反过来 ——
 * 那比没有自查更糟，因为它给出虚假的结论。
 * 这与 `policy-engine.ts` 导出 `globMatch` 给 `policy-audit` 复用是同一条纪律。
 *
 * ── 硬约束：项目层不存在 = 零行为变化 ──
 * 全局层（插件内 `templates/standards/`）**装上插件就存在**，所以不能拿它驱动
 * 任何注入或提醒 —— 否则所有人一升级插件就被迫接受一堆新输出。
 * 只有仓库里铺了 `.codebuddy/standards/` 才算"用户明确表达了按它办"。
 *
 * 这与 `redlines.json` 的论证一致（用户写了红线就是表达了按它办），
 * 也是 `verify-hooks` 那 59 条用例仍能全绿的原因 —— 它们的临时仓没有项目层。
 *
 * ── 为什么注入面只给 title，不给 body ──
 * 45 条规范的 body 加起来远超 1500 token 的段预算。而会话开始时模型需要的是
 * **知道有这些约束存在**，不是背下每条的完整正文。正文在两处才给：
 *   · `UserPromptSubmit` 按 tags 命中时 —— 这一句话确实相关
 *   · 被拦 / 被提醒时 —— 此刻它必须知道为什么
 */
import fs from 'node:fs';
import path from 'node:path';

import { truncateToBudget } from '../gates/inject.js';
import { estimateTokens } from '../engine/shims/token-estimator.js';
import type { PolicyRule } from '../engine/types.js';
import { ALL_STACKS, effectiveSeverity, itemAppliesToPath, type Severity, type StandardItem, type Stack, type Timing } from './schema.js';
import type { StandardsSnapshot } from './loader.js';

/** 端 → 注入时显示的名字。比文件名可读 */
const STACK_LABEL: Record<Stack, string> = {
  'l0-contract': 'L0 跨端契约（单方不得擅自修改）',
  common: '全端共用',
  'frontend-web': '前端 Web/React',
  'backend-service': '后端服务',
  database: '数据库',
  'message-queue': '消息队列',
};

/** 能按单个文件判定的判据。其余是会话级的 */
const FILE_LEVEL_KINDS = new Set(['path_only', 'protect_symbol', 'content_regex', 'require_tool']);

/** 单文件最大读取体积。超了只做路径判定 —— 扫一个 10MB 的生成文件没有意义 */
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

/** post-write 提醒的 token 预算。比注入面小 —— 它是打断性的，越短越好 */
const REMIND_BUDGET_TOKENS = 700;

/**
 * 这份快照能驱动运行时行为吗。
 *
 * 只看 `projectPresent` —— 见文件头。这个函数是"零行为变化"这条纪律的**唯一闸门**，
 * 所有 hook 侧入口都必须先过它。
 */
export function isActionable(snap: StandardsSnapshot): boolean {
  return snap.enabled && snap.projectPresent && snap.items.length > 0;
}

function enabledAt(snap: StandardsSnapshot, timing: Timing): StandardItem[] {
  return snap.items.filter((i) => i.enabled && i.timing.includes(timing));
}

function sev(snap: StandardsSnapshot, item: StandardItem): Severity {
  return effectiveSeverity(item, snap.switchboard.maxSeverity).severity;
}

// ══════════════════ 注入面 ══════════════════

/**
 * 会话开始 / 压缩后的注入段。
 *
 * 按端分组而不是按强度分组：模型接下来要改的代码属于某个端，按端组织能让它
 * 只关注相关的那几条。强度作为行内标记 —— `会拦` 的那些必须一眼能看出来。
 */
/**
 * 构造注入面的行。**不含闸门与截断** —— 那两件事由调用方决定。
 *
 * 抽出来是为了让 `doctor` 的配额预估与真正的注入走**同一套行构造**。
 * 各写一套的话，doctor 说"没超"而实际被截断，那比不检查更糟。
 */
function injectLines(snap: StandardsSnapshot, timing: Timing): string[] {
  const items = enabledAt(snap, timing);
  if (!items.length) return [];

  const lines: string[] = ['## 本仓研发规范（完整正文在命中时给出）'];

  for (const stack of ALL_STACKS) {
    const group = items.filter((i) => i.stack === stack);
    if (!group.length) continue;
    lines.push(`### ${STACK_LABEL[stack]}`);
    for (const item of group) {
      const s = sev(snap, item);
      // 只标"会拦"。remind / inject 不标 —— 标了等于每行都有前缀，
      // 前缀就失去了区分度
      const mark = s === 'block' ? '【会拦】' : s === 'ask' ? '【需确认】' : '';
      lines.push(`- ${mark}${item.title}`);
    }
  }
  return lines;
}

export function injectSegment(snap: StandardsSnapshot, timing: Timing = 'session_start'): string {
  if (!isActionable(snap)) return '';
  const lines = injectLines(snap, timing);
  if (!lines.length) return '';

  const { lines: kept, truncated } = truncateToBudget(lines, snap.switchboard.injectBudgetTokens);
  if (!kept.length) return '';
  if (truncated > 0) {
    kept.push(
      `（还有 ${truncated} 行超出注入预算被截断 —— 跑 \`repo-guard standards list\` 看全量，` +
        '或在 .codebuddy/standards/standards.json 里把不相关的端设成 off）',
    );
  }
  return kept.join('\n');
}

export interface BudgetReport {
  /** 注入面总行数（标题行 + 端分组行 + 每条目一行） */
  total: number;
  /** 预算内保住的行数 */
  kept: number;
  /** 被截断丢掉的行数 */
  truncated: number;
  budgetTokens: number;
  /** 保住的这些行实际吃掉多少 token。填配置的人靠它判断还能加几条 */
  usedTokens: number;
  /** 第一条被丢掉的行，让人知道从哪儿断的 */
  firstDropped?: string;
}

/**
 * 注入配额预估。给 `doctor` 用。
 *
 * ── 为什么不过 `isActionable` ──
 * 部门在填 `templates/` 时**根本没有项目层**，走闸门的话永远返回空，
 * 这个检查就废了。闸门回答的是"运行时要不要生效"，而 doctor 问的是
 * "**如果生效了**会不会被截断" —— 两个问题，同一套行构造。
 *
 * ── 为什么报行数而不是 token 总量 ──
 * `truncateToBudget` 是按行前缀截断的（`inject.ts:40-47`），累计超预算的那一行
 * 及其之后全部丢掉。说"总共 1800 token、超了 300"没法指导行动；
 * 说"第 43 行起被丢掉，共丢 12 条"才知道要删哪些。
 */
export function injectBudgetReport(
  snap: StandardsSnapshot,
  timing: Timing = 'session_start',
): BudgetReport {
  const budgetTokens = snap.switchboard.injectBudgetTokens;
  const lines = injectLines(snap, timing);
  const { lines: kept, truncated } = truncateToBudget(lines, budgetTokens);
  // 与 truncateToBudget 的计法保持一致：每行都算上换行符
  const usedTokens = kept.reduce((sum, l) => sum + estimateTokens(`${l}\n`), 0);
  return {
    total: lines.length,
    kept: kept.length,
    truncated,
    budgetTokens,
    usedTokens,
    firstDropped: truncated > 0 ? lines[kept.length] : undefined,
  };
}

/**
 * 按这一句话挑相关规范，给**完整正文**。
 *
 * 只做关键词匹配，不调模型：`UserPromptSubmit` 在关键路径上，每次提问都多一次
 * 模型调用不划算。而且关键词写错顶多漏注入，语义判定错了会**错注入** ——
 * 给改样式的任务塞一份数据库迁移规范是纯粹的伤害。
 * 这与 `matchTaskRoutes` 的姿势一致。
 */
export function promptSegment(snap: StandardsSnapshot, prompt: string): string {
  if (!isActionable(snap)) return '';
  const text = (prompt ?? '').toLowerCase();
  if (!text.trim()) return '';

  const hits = enabledAt(snap, 'prompt_submit').filter((i) =>
    i.tags?.some((t) => t.trim() && text.includes(t.trim().toLowerCase())),
  );
  if (!hits.length) return '';

  const lines: string[] = ['## 这次任务相关的规范（按你的原话匹配）'];
  for (const item of hits) {
    const s = sev(snap, item);
    lines.push(`### [${item.id}] ${item.title}${s === 'block' ? '（会硬拦）' : ''}`);
    lines.push(item.body);
    if (item.hint) lines.push(`下一步：${item.hint}`);
  }

  const { lines: kept, truncated } = truncateToBudget(lines, snap.switchboard.injectBudgetTokens);
  if (!kept.length) return '';
  if (truncated > 0) {
    kept.push(`（还有 ${truncated} 行被截断 —— 命中的规范太多，考虑收窄条目的 tags）`);
  }
  return kept.join('\n');
}

// ══════════════════ 文件级判定 ══════════════════

export interface Evidence {
  line: number;
  message: string;
}

export interface StandardHit {
  item: StandardItem;
  severity: Severity;
  evidence: Evidence[];
}

function readIfSmall(abs: string): string | null {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_SCAN_BYTES) return null;
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 内容正则扫描。
 *
 * 逐行匹配且**剥掉 g/y 标志**：带 g 的正则跨次 `test()` 调用会保留 `lastIndex`，
 * 导致隔行漏报 —— 这是这类扫描器最常见的一个 bug，而它的症状是"有时候报有时候不报"。
 */
function scanRegex(body: string, item: StandardItem): Evidence[] {
  const patterns = item.check.patterns;
  if (!patterns?.length) return [];
  const out: Evidence[] = [];
  const lines = body.split('\n');
  for (const p of patterns) {
    let re: RegExp;
    try {
      re = new RegExp(p.pattern, (p.flags ?? '').replace(/[gy]/g, ''));
    } catch {
      continue; // 非法正则跳过它自己，不拖死整条规范
    }
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) out.push({ line: i + 1, message: p.message });
    }
  }
  return out;
}

/**
 * 受保护符号在这个文件里出现在哪。
 *
 * ── 为什么这里只查"出现"，不查"删除" ──
 * 完整判定要**真 diff**（before 含、after 不含 = 真的在删），那只有 `PreToolUse`
 * 拿得到，而且已经由红线引擎实现了。这个函数服务的是 `check` 与 `post-write`：
 * 前者没有 diff，后者已经写完了。
 *
 * 退化成"路径命中即报"是不行的：`paths` 通常写成整个目录，于是目录下每个文件
 * 都报"这里有受保护字段"。真机验证时这条让 `router/router.go` 也报了
 * `error_description`，而它根本没提到这个词。噪音会让人不看这份输出。
 */
function scanSymbols(body: string, item: StandardItem): Evidence[] {
  const symbols = item.check.symbols;
  if (!symbols?.length) return [];
  const out: Evidence[] = [];
  const lines = body.split('\n');
  for (const s of symbols) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(s)) {
        out.push({ line: i + 1, message: `出现受保护标识符 ${s} —— 改名 / 删除前必须确认` });
      }
    }
  }
  return out;
}

/**
 * 这个文件命中了哪些规范。
 *
 * @param timing 只判定在该时机生效的条目。传 null = 不按时机过滤（`standards check` 用）
 *
 * 内容型判据（`content_regex` / `protect_symbol`）**没有证据就不算命中**：
 * 它们的 `paths` 只是"扫描范围"，不是"违规范围"。把范围当违规会让每个 tsx 文件
 * 都命中"禁止发明色值"。
 */
export function scanFile(
  snap: StandardsSnapshot,
  repoDir: string,
  rel: string,
  timing: Timing | null = null,
): StandardHit[] {
  if (!snap.enabled) return [];
  const pool = snap.items.filter(
    (i) => i.enabled && FILE_LEVEL_KINDS.has(i.check.kind) && (!timing || i.timing.includes(timing)),
  );
  if (!pool.length) return [];

  const abs = path.join(repoDir, rel);
  let body: string | null | undefined;
  const hits: StandardHit[] = [];

  for (const item of pool) {
    if (!itemAppliesToPath(item, rel)) continue;

    let evidence: Evidence[] = [];
    if (item.check.kind === 'content_regex' || item.check.kind === 'protect_symbol') {
      // 懒读一次：一个文件可能被多条规范扫，没必要读多遍
      if (body === undefined) body = readIfSmall(abs);
      if (body === null) continue; // 读不到（太大 / 不存在）：跳过，不猜
      evidence =
        item.check.kind === 'content_regex' ? scanRegex(body, item) : scanSymbols(body, item);
      if (!evidence.length) continue;
    }

    hits.push({ item, severity: sev(snap, item), evidence });
  }
  return hits;
}

/** 会话级条目（只注入 / 看有没有跑过校验），不按文件判定 */
export function sessionLevelItems(snap: StandardsSnapshot): StandardItem[] {
  return snap.items.filter((i) => i.enabled && !FILE_LEVEL_KINDS.has(i.check.kind));
}

/**
 * 写完之后的提醒文案。
 *
 * 只处理**实际强度为 remind** 的命中：`block` / `ask` 已经在 `PreToolUse` 处理过了，
 * 在这里重复一遍是噪音；`inject` 级的条目本来就不该按文件报。
 */
export function remindNote(hits: StandardHit[], rel: string): string {
  const relevant = hits.filter((h) => h.severity === 'remind');
  if (!relevant.length) return '';

  const lines: string[] = [`\`${rel}\` 命中本仓规范：`];
  for (const h of relevant) {
    lines.push(`- [${h.item.id}] ${h.item.title}`);
    // 每条最多三处证据：提醒的目的是让它知道"这里有问题"，
    // 不是给它一份完整清单 —— 完整清单跑 `repo-guard standards check` 拿
    for (const e of h.evidence.slice(0, 3)) {
      lines.push(`    ${rel}:${e.line}  ${e.message}`);
    }
    if (h.evidence.length > 3) lines.push(`    …… 还有 ${h.evidence.length - 3} 处`);
    if (h.item.hint) lines.push(`    → ${h.item.hint}`);
  }
  const { lines: kept, truncated } = truncateToBudget(lines, REMIND_BUDGET_TOKENS);
  if (truncated > 0) kept.push(`（还有 ${truncated} 行被截断，跑 \`repo-guard standards check ${rel}\` 看全量）`);
  return kept.join('\n');
}

// ══════════════════ block 级编译 ══════════════════

/**
 * 把 block 级条目编译成红线规则，交给现成的引擎判定。
 *
 * ── 为什么不自己写判定 ──
 * `engine/policy-engine.ts` 的三层判定（结构化删除 / 意图正则 / paths 收窄）
 * 误报率是在真实仓库上调出来的。另写一套必然漂，而漂了之后没有报错，
 * 只表现为"有时候拦有时候不拦"。所以这里只做**翻译**。
 *
 * ── 只编译 protect_symbol ──
 * `path_only` 的 block 语义是"这个路径不许动"，那是 `no_refactor` 的语义，
 * 由 `constraint/no-refactor.json` 与 `redlines.no_refactor` 承担，不在这里重复。
 * `require_tool` 引擎不认（它不知道"本轮查过没"），走 `requireToolGate`。
 * `content_regex` 永不 block。
 */
export function compileBlockRules(snap: StandardsSnapshot): PolicyRule[] {
  if (!isActionable(snap)) return [];
  const out: PolicyRule[] = [];
  for (const item of snap.items) {
    if (!item.enabled) continue;
    if (sev(snap, item) !== 'block') continue;
    if (item.check.kind !== 'protect_symbol') continue;
    const symbols = item.check.symbols ?? [];
    if (!symbols.length || !item.paths?.length) continue;

    out.push({
      // STD- 前缀让中断消息里能看出这条来自规范而不是手写红线，
      // 排查时知道该去改哪个文件
      id: `STD-${item.id}`,
      rule: item.body,
      reason: item.why,
      protects: symbols,
      paths: item.paths,
      violation_action: 'stop_and_ask',
      confirmed: item.confirmed === true,
    });
  }
  return out;
}

export interface RequireToolVerdict {
  blocked: boolean;
  reason?: string;
  itemId?: string;
}

/**
 * `require_tool` 判定：改这个文件之前必须先调过某个图谱工具。
 *
 * @param queried 该文件本轮查过影响面了吗（`hasQueried`）
 * @param searched 本轮做过对应的检索了吗（lib / hot / similar）
 *
 * 判定函数保持纯粹 —— 会话状态由调用方读，这样它可单测、也不会在 hook 的
 * 关键路径上重复读状态文件。
 */
export function judgeRequireTool(
  snap: StandardsSnapshot,
  rel: string,
  opts: { queried: boolean; libSearched: boolean; hotQueried: boolean; similarSearched: boolean; exists: boolean },
): RequireToolVerdict {
  if (!isActionable(snap)) return { blocked: false };

  for (const item of snap.items) {
    if (!item.enabled) continue;
    if (item.check.kind !== 'require_tool' || !item.check.tool) continue;
    if (sev(snap, item) !== 'block') continue;
    if (!itemAppliesToPath(item, rel)) continue;

    const tool = item.check.tool;
    // impact 只管**已存在**的文件：新建文件没有影响面可查，拦它纯属误伤。
    // 反过来 similar / hot / lib 只管新建 —— 改已有文件不需要"先看有没有现成的"。
    if (tool === 'impact' || tool === 'trace') {
      if (!opts.exists || opts.queried) continue;
    } else {
      if (opts.exists) continue;
      if (tool === 'lib_search' && opts.libSearched) continue;
      if (tool === 'hot' && opts.hotQueried) continue;
      if (tool === 'similar' && opts.similarSearched) continue;
    }

    const lines = [
      `这次改动命中规范 ${item.id}：${item.title}`,
      item.body,
      `按规范要求，动手之前必须先调 ${tool} 工具。`,
    ];
    if (item.hint) lines.push(item.hint);
    lines.push('（本约束来自 .codebuddy/standards/，不要绕过它 —— 确实该改就先更新那份配置。）');
    return { blocked: true, reason: lines.join('\n'), itemId: item.id };
  }
  return { blocked: false };
}
