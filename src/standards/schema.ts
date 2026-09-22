/**
 * 研发规范条目的类型与净化 —— 五端标准模板的数据形状。
 *
 * ── 为什么规范要单独一套 schema，不复用 PolicyRule ──
 * `PolicyRule`（红线）回答的是「哪个符号不许少」，它只有一种强度：命中就拦。
 * 规范要回答的问题多一层：**这条能不能拦**。
 * 「只用本仓 token」判据是正则，正则判不出意图，拦了必然误伤；
 * 「已下发 SDK 字段一字不改」判据是符号 diff，那是硬证据，可以拦。
 * 同一份清单里两种东西混着，所以必须有 `severity` × `check.kind` 两个维度。
 *
 * 但 **block 级的判定不在这里做** —— 它编译成 `PolicyRule` 交给
 * `engine/policy-engine.ts`。那套引擎的误报率是在真实仓库上调出来的，
 * 另写一套必然漂。
 *
 * ── 逐条净化，一条坏条目只跳过它自己 ──
 * 规范文件是人手写的，必然有写错的时候。因为第 3 条格式错就让前 2 条也失效，
 * 等于把人的心智负担放大到不可接受。这是 `runtime/redlines.ts` 反复出现的姿势。
 */
import { globMatch } from '../engine/policy-engine.js';

/** 强度。只有前两级是"无误伤风险"的 */
export type Severity = 'inject' | 'remind' | 'ask' | 'block';

/**
 * 项目层能对这条做多少改动。**只有全局层写它才有意义。**
 *
 * ── 为什么需要它 ──
 * 分发链是三级的（插件源码 → 部门模板包 → 个人项目），部门下发的基线里
 * 有一部分是**合规要求**而不是建议。没有这个字段时，部门唯一能表达"这条别关"
 * 的手段是把强度提到 `block` —— 但那会连带打开硬拦，用强度表达"不许改"是错配。
 *
 * ── 三档严格度递增，`free` 就是现状 ──
 * | 值 | 项目层能做什么 |
 * | :--- | :--- |
 * | `free` | 走既有的 `isRelaxation` 规则：放宽要写 `override_reason`。**不是"完全自由"** |
 * | `reason-required` | 任何修改都要 `override_reason`，不只是放宽 |
 * | `locked` | 放宽一律拒绝（写了理由也不行）；**收紧仍然允许** |
 *
 * `free` 之所以不能定义成"完全自由"：那样它就成了绕过留痕纪律的后门 ——
 * 想偷偷放宽的人只要在全局层加一行 `"override_policy": "free"` 就行了。
 *
 * ── 为什么 locked 允许收紧 ──
 * 部门锁的意图是"不许削弱"。项目比基线更严没有任何理由拦 ——
 * 拦了只会让人把整个目录删掉。
 *
 * ── 为什么 locked 不是真的锁死 ──
 * 这是单机插件，项目层的人完全可以删掉 `.codebuddy/standards/`。
 * `locked` 能做到的是**让放宽这件事留下痕迹**（`doctor` / `audit` 报 error、
 * 退出码非零、可以挂 CI），而不是物理阻止。这与 `merge.ts` 文件头
 * "允许放宽但留痕，而不是禁止放宽"是同一条论证的延伸。
 */
export type OverridePolicy = 'free' | 'reason-required' | 'locked';

const OVERRIDE_POLICIES = new Set<OverridePolicy>(['free', 'reason-required', 'locked']);

/** 落点主体。`landing` 里没有 `plugin` 就是插件不假装能拦 */
export type Landing = 'plugin' | 'permissions' | 'ci' | 'lint' | 'human';

export type Timing =
  | 'session_start'
  | 'prompt_submit'
  | 'pre_write'
  | 'pre_bash'
  | 'post_write'
  | 'stop'
  | 'post_compact';

export type Stack =
  | 'l0-contract'
  | 'common'
  | 'frontend-web'
  | 'backend-service'
  | 'database'
  | 'message-queue';

export type CheckKind =
  | 'none'
  | 'path_only'
  | 'protect_symbol'
  | 'content_regex'
  | 'require_tool'
  | 'require_evidence';

export type RequiredTool = 'impact' | 'similar' | 'hot' | 'lib_search' | 'trace';

export interface ContentPattern {
  pattern: string;
  flags?: string;
  message: string;
}

export interface StandardCheck {
  kind: CheckKind;
  symbols?: string[];
  patterns?: ContentPattern[];
  tool?: RequiredTool;
  commands?: string[];
}

export interface StandardItem {
  /** 合并 key，全局唯一。前缀即端：L0- CM- FE- BE- DB- MQ- PRJ- */
  id: string;
  title: string;
  /** 给模型看的正文。注入文案与拒绝文案共用同一份，不写两套 */
  body: string;
  why?: string;
  /** 适用路径 glob。`__PUBLIC_LAYER__` 会被展开为 repo-facts.publicLayer */
  paths?: string[];
  excludePaths?: string[];
  timing: Timing[];
  severity: Severity;
  check: StandardCheck;
  landing: Landing[];
  /** 被拦时的下一步。缺了模型会自己去找绕路 */
  hint?: string;
  /** 关键词，供 prompt_submit 按任务注入 */
  tags?: string[];
  enabled: boolean;
  /** 人确认过判据吗。false 时 block 自动降级 */
  confirmed?: boolean;
  /** 项目层放宽全局条目时必填 */
  override_reason?: string;
  /** 项目层能对这条做多少改动。缺省 `free`（= 现状）。只有全局层写它才有意义 */
  override_policy?: OverridePolicy;
  /** 归属端。由加载器按文件填，不从条目里读 */
  stack: Stack;
  /** 来自哪一层。合并时填 */
  source: 'global' | 'project';
}

export interface StandardsSwitchboard {
  enabled: boolean;
  maxSeverity: Severity;
  /** 端 → auto | on | off */
  stacks: Record<Stack, 'auto' | 'on' | 'off'>;
  injectBudgetTokens: number;
  stackDetect: Partial<Record<Stack, string[]>>;
}

export const ALL_STACKS: Stack[] = [
  'l0-contract',
  'common',
  'frontend-web',
  'backend-service',
  'database',
  'message-queue',
];

/** 端 → 文件名。文件即注入单元，所以这张表是一一对应的 */
export const STACK_FILES: Record<Stack, string> = {
  'l0-contract': 'l0-contract.json',
  common: 'common.json',
  'frontend-web': 'frontend-web.json',
  'backend-service': 'backend-service.json',
  database: 'database.json',
  'message-queue': 'message-queue.json',
};

/** 公共层占位符。写死在模板里，加载时展开为 repo-facts.publicLayer */
export const PUBLIC_LAYER_TOKEN = '__PUBLIC_LAYER__';

const SEVERITY_ORDER: Severity[] = ['inject', 'remind', 'ask', 'block'];

/** `check.kind` 里哪几种判据足够硬、允许 block */
const BLOCKABLE_KINDS = new Set<CheckKind>(['protect_symbol', 'path_only', 'require_tool']);

const TIMINGS = new Set<Timing>([
  'session_start',
  'prompt_submit',
  'pre_write',
  'pre_bash',
  'post_write',
  'stop',
  'post_compact',
]);
const LANDINGS = new Set<Landing>(['plugin', 'permissions', 'ci', 'lint', 'human']);
const CHECK_KINDS = new Set<CheckKind>([
  'none',
  'path_only',
  'protect_symbol',
  'content_regex',
  'require_tool',
  'require_evidence',
]);
const TOOLS = new Set<RequiredTool>(['impact', 'similar', 'hot', 'lib_search', 'trace']);

export function severityRank(s: Severity): number {
  const i = SEVERITY_ORDER.indexOf(s);
  return i < 0 ? 0 : i;
}

export function defaultSwitchboard(): StandardsSwitchboard {
  return {
    // 总闸默认开，但 maxSeverity 压在 remind —— 开着也拦不了任何东西。
    // 这是"装完零行为变化"与"装完就有提醒价值"之间的取舍点。
    enabled: true,
    maxSeverity: 'remind',
    stacks: {
      'l0-contract': 'on',
      common: 'on',
      'frontend-web': 'auto',
      'backend-service': 'auto',
      database: 'auto',
      'message-queue': 'auto',
    },
    injectBudgetTokens: 1500,
    stackDetect: {},
  };
}

// ── 取值助手。全部"取不到就用默认"，照搬 gates/config.ts 的姿势 ──

function str(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d;
}
function strArr(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
    : [];
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function toSeverity(v: unknown, d: Severity): Severity {
  return typeof v === 'string' && (SEVERITY_ORDER as string[]).includes(v) ? (v as Severity) : d;
}

function toPatterns(v: unknown): ContentPattern[] {
  if (!Array.isArray(v)) return [];
  const out: ContentPattern[] = [];
  for (const raw of v) {
    const m = obj(raw);
    const pattern = str(m.pattern).trim();
    const message = str(m.message).trim();
    if (!pattern || !message) continue;
    const flags = str(m.flags).trim();
    // 非法正则跳过它自己，不拖死整条规范 —— 与 policy-engine 一致
    try {
      new RegExp(pattern, flags || undefined);
    } catch {
      continue;
    }
    out.push(flags ? { pattern, flags, message } : { pattern, message });
  }
  return out;
}

function toCheck(v: unknown): StandardCheck {
  const c = obj(v);
  const kind = CHECK_KINDS.has(str(c.kind) as CheckKind) ? (str(c.kind) as CheckKind) : 'none';
  const out: StandardCheck = { kind };
  const symbols = strArr(c.symbols);
  if (symbols.length) out.symbols = symbols;
  const patterns = toPatterns(c.patterns);
  if (patterns.length) out.patterns = patterns;
  const tool = str(c.tool).trim();
  if (TOOLS.has(tool as RequiredTool)) out.tool = tool as RequiredTool;
  const commands = strArr(c.commands);
  if (commands.length) out.commands = commands;
  return out;
}

/**
 * 逐条净化。`id` / `title` / `body` 是最小集：
 * 没有 id 没法合并也没法在中断消息里指认；没有 title/body，注入了模型也不知道要干什么。
 */
export function sanitizeItem(raw: unknown, stack: Stack, source: 'global' | 'project'): StandardItem | null {
  const r = obj(raw);
  const id = str(r.id).trim();
  if (!id || id.startsWith('_')) return null;

  const title = str(r.title).trim();
  const body = str(r.body).trim();
  // 项目层的覆盖片段可以只写 id + 要改的字段，所以这里允许 title/body 为空，
  // 由 merge 阶段决定"是覆盖片段还是残缺的新条目"
  const timing = Array.isArray(r.timing)
    ? strArr(r.timing).filter((t): t is Timing => TIMINGS.has(t as Timing))
    : [];
  const landing = Array.isArray(r.landing)
    ? strArr(r.landing).filter((l): l is Landing => LANDINGS.has(l as Landing))
    : [];

  const item: StandardItem = {
    id,
    title,
    body,
    timing: timing as Timing[],
    severity: toSeverity(r.severity, 'inject'),
    check: toCheck(r.check),
    landing: landing as Landing[],
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    stack,
    source,
  };

  const why = str(r.why).trim();
  if (why) item.why = why;
  const paths = strArr(r.paths);
  if (paths.length) item.paths = paths;
  const excludePaths = strArr(r.excludePaths);
  if (excludePaths.length) item.excludePaths = excludePaths;
  const hint = str(r.hint).trim();
  if (hint) item.hint = hint;
  const tags = strArr(r.tags);
  if (tags.length) item.tags = tags;
  if (typeof r.confirmed === 'boolean') item.confirmed = r.confirmed;
  const reason = str(r.override_reason).trim();
  if (reason) item.override_reason = reason;
  // 非法值退 free（= 现状）而不是退 locked：拼错一个字母就把条目锁死，
  // 那是"配置错误导致更严"，方向错了
  const policy = str(r.override_policy).trim();
  if (OVERRIDE_POLICIES.has(policy as OverridePolicy)) {
    item.override_policy = policy as OverridePolicy;
  }

  return item;
}

export interface EffectiveSeverity {
  severity: Severity;
  /** 被降级了吗，以及为什么。`standards list` 要显示它，否则人会以为配了就生效 */
  downgradedFrom?: Severity;
  reason?: string;
}

/**
 * 算实际生效强度。
 *
 * 两道闸：**block 准入三条件** 与 **全局 maxSeverity 上限**。
 *
 * 为什么要有准入三条件而不是"写了 block 就 block"：
 * 一条 `paths` 为空的 block 会拦全仓所有写操作；一条 `content_regex` 的 block
 * 会把"修正一个写错的断言"也拦下来。这两种配置错误的代价是 AI 什么都干不了，
 * 而人的反应是卸载插件 —— 所以宁可静默降级，并在 `standards list` 里显式标出来。
 */
export function effectiveSeverity(item: StandardItem, maxSeverity: Severity): EffectiveSeverity {
  let sev = item.severity;
  let reason: string | undefined;

  if (sev === 'block') {
    if (!BLOCKABLE_KINDS.has(item.check.kind)) {
      sev = 'remind';
      reason = `check.kind=${item.check.kind} 判不出意图，不允许硬拦`;
    } else if (!item.paths?.length) {
      sev = 'remind';
      reason = 'paths 为空，全仓范围的硬拦一定误伤';
    } else if (item.confirmed !== true) {
      sev = 'remind';
      reason = 'confirmed 不为 true，判据还没人确认过';
    } else if (item.check.kind === 'protect_symbol' && !item.check.symbols?.length) {
      sev = 'remind';
      reason = 'symbols 为空，这条 block 是在守空气';
    }
  }

  if (severityRank(sev) > severityRank(maxSeverity)) {
    return {
      severity: maxSeverity,
      downgradedFrom: item.severity,
      reason: reason ?? `受 standards.json 的 maxSeverity=${maxSeverity} 压制`,
    };
  }
  return reason ? { severity: sev, downgradedFrom: item.severity, reason } : { severity: sev };
}

/**
 * 这条规范适用于该文件吗。
 *
 * `paths` 为空 = 全仓适用。`excludePaths` 优先 —— 测试、mock、stories
 * 几乎每条内容型规范都要排除，让排除赢是唯一合理的顺序。
 */
export function itemAppliesToPath(item: StandardItem, rel: string): boolean {
  if (item.excludePaths?.some((g) => globMatch(g, rel))) return false;
  if (!item.paths?.length) return true;
  return item.paths.some((g) => globMatch(g, rel));
}

/** 这条规范在这个时机生效吗 */
export function itemAtTiming(item: StandardItem, timing: Timing): boolean {
  return item.timing.includes(timing);
}
