/**
 * 需求复述 —— 独立于七道门，管的是「活怎么进来」。
 *
 * 对应 deerclaw 的 `requirement-restate.ts`。
 *
 * ── 与 deerclaw 的三处不同 ──
 *
 * **① 默认关（那边默认开）。** 这是唯一一处我们比平台更保守的地方。
 * deerclaw 是异步 IM 场景，人不在屏幕前，一次误解可能跑很久才被发现，
 * 复述的收益很大。CodeBuddy 是同步场景，人就在旁边看着，误解通常几秒内
 * 就被打断了 —— 此时每次提问都先复述一遍，是纯粹的噪音。
 *
 * **② 不调模型。** deerclaw 那边用小模型做语义判定（有条件无结果 / 前后矛盾 /
 * 主次颠倒 / 指代未决）。这里只做**本地启发式**：
 *   · 长度异常
 *   · 指代未决的字面信号（"那个" "这个" 后面没有具体名字）
 *   · 多个并列诉求但没说清优先级
 * 理由：`UserPromptSubmit` 在关键路径上，每次提问多一次模型调用不划算；
 * 而且启发式判错只是多注入一句提醒，模型判错会**误导**。
 *
 * **③ 零阻塞，永远只注入。** 与那边一致 —— 复述检查本身是启发式的，
 * 拿它卡主链路，第一次误判就会让人关掉它。
 *
 * ── 核心指标是 corrected，不是"复述准不准" ──
 * deerclaw 真正看的是**用户的下一条消息是不是在纠错**。如果复述之后人马上说
 * "不是这个意思"，那这次复述就是有价值的（它提前暴露了误解）。
 * 所以这里把每次提问的特征写进埋点，由 `governance` 去跨消息关联。
 */
import { record } from '../runtime/metrics.js';
import type { GuardConfig } from './config.js';

/** 跳过复述的情形。与 deerclaw 的 skipReasons 对齐 */
export type SkipReason = 'too_short' | 'question_only' | 'ack_followup';

/**
 * 太短的提问不值得复述。
 *
 * 16 是按**中文**定的。一开始写 24，结果
 *「帮我把那个组件重构一下，顺便把样式也统一起来」（22 字）被判成"太短"跳过 ——
 * 而那是个典型的指代不明 + 多诉求，恰恰最该提醒。
 *
 * 中文的信息密度比英文高得多：24 个汉字已经能表达两三件事，
 * 而 24 个英文字符还不到半句话。照英文语感定阈值会让这道检查在中文场景下基本失效。
 *
 * 16 字以下的典型是「改个颜色」「把这个按钮改成蓝色」—— 确实没有可误解的空间。
 */
const MIN_CHARS = 16;

/** 纯提问：只想知道答案，没有要改的东西 */
const QUESTION_ONLY = /^(为什么|怎么|如何|什么是|是不是|能不能|有没有|哪里|哪个|多少)/;
const QUESTION_TAIL = /[?？]\s*$/;

/** 对上一条的确认 / 附和，不是新需求 */
const ACK = /^(好的?|行|可以|继续|嗯+|ok|okay|yes|对|没问题|辛苦了?)[\s，。!！]*$/i;

/**
 * 指代未决。
 *
 * 判据是「指示代词 + 泛称」：`那个组件` `这个方法` `上面那个文件`。
 *
 * ── 为什么不能用"后面没跟具体名字"做判据 ──
 * 第一版写的是 `/(那个|这个)(?![\u4e00-\u9fff...])/`，想表达"后面没有具体名字"。
 * 但中文里 `那个组件` 的 `组件` 本身就是汉字 —— 否定前瞻直接失效，
 * 而这恰恰是最典型的模糊表达。
 *
 * 真正的信号是**泛称**：组件 / 文件 / 方法 / 接口 / 页面 / 地方 / 东西 / 问题
 * 这些词指的是"一类东西"而不是某一个。跟了真实名字的（`那个 UserList 组件`）
 * 不该报 —— 所以要求泛称**紧邻**指示代词。
 */
const VAGUE_REF =
  /(那个|这个|上面那个?|刚才那个?|之前那个?)\s*(组件|文件|方法|函数|接口|页面|模块|地方|东西|问题|逻辑|代码|字段|配置)/;

/** 并列诉求的连接词。多个诉求但没说优先级时容易被挑一个做 */
const CONJUNCTION = /(顺便|同时|另外|还有|以及|并且|再把)/g;

export function classifySkip(prompt: string): SkipReason | null {
  const s = (prompt ?? '').trim();
  if (s.length < MIN_CHARS) return 'too_short';
  if (ACK.test(s)) return 'ack_followup';
  // 纯提问的判据要两个信号都占：只以"怎么"开头也可能是"怎么改成 X"（那是需求）
  if (QUESTION_ONLY.test(s) && QUESTION_TAIL.test(s)) return 'question_only';
  return null;
}

export interface RestateFinding {
  kind: 'vague_reference' | 'multi_demand';
  hint: string;
}

/** 本地启发式检查。查不出问题就返回空数组 —— 零阻塞、也零噪音 */
export function inspect(prompt: string): RestateFinding[] {
  const s = (prompt ?? '').trim();
  const out: RestateFinding[] = [];

  if (VAGUE_REF.test(s)) {
    out.push({
      kind: 'vague_reference',
      hint: '这句话里有指代不明（"那个组件 / 这个方法"这类泛称）。动手前先说清指的是哪个文件或哪个符号，不要自己挑一个。',
    });
  }

  const conj = s.match(CONJUNCTION);
  if (conj && conj.length >= 1) {
    // 阈值是 1 而不是 2：一个「顺便」就已经是两件事了。
    // 多诉求最常见的失败不是"做漏了第三件"，而是"只做了第一件"。
    out.push({
      kind: 'multi_demand',
      hint: `这句话里有 ${conj.length + 1} 个并列诉求（"${conj.join('"、"')}"）。先复述一遍你理解的清单并标出执行顺序，再动手。`,
    });
  }

  return out;
}

/**
 * 给 `UserPromptSubmit` 用。返回要注入的文本，空字符串表示不注入。
 *
 * 无论开关是否打开，**都写埋点** —— 关着的时候也要能回答"如果开了会触发多少次"。
 * 没有这个数据，人永远不知道该不该开。
 */
export function restateNote(cfg: GuardConfig, repoDir: string, prompt: string): string {
  const skip = classifySkip(prompt);
  const findings = skip ? [] : inspect(prompt);

  record('restate_check', repoDir, {
    detail: JSON.stringify({
      enabled: cfg.restate.enabled,
      skip,
      kinds: findings.map((f) => f.kind),
      chars: (prompt ?? '').trim().length,
    }),
  });

  if (!cfg.restate.enabled || skip || !findings.length) return '';

  return [
    '## 先复述再动手',
    ...findings.map((f) => `- ${f.hint}`),
    '（这一条不拦你，但复述错了后面全是白做。）',
  ].join('\n');
}
