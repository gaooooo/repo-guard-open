/**
 * token 估算 —— 从 deerclaw 的 `src/context/token-estimator.ts` 逐字摘出
 * `estimateTokens` 一个函数及其常量与注释。
 *
 * 只要这一个：graph-report 用它算"这次查询替 Agent 省了多少上下文"。
 * 原文件其余部分（预算分配、EWMA 自校准、ChatMessage 估算）都依赖 deerclaw 的
 * 模型注册表与 `@deerclaw/shared` 的 ChatMessage 类型，插件里没有对话循环、
 * 也拿不到服务端回传的 usage，搬过来只会是死代码。
 *
 * ⚠️ 系数不要"顺手优化"。下面的 0.6 / 0.25 是对目标模型的实测值，
 * 原文件注释里记着一次真实事故：系数从 1.5 改到 0.6 之前，长中文会话被高估
 * 约 2.6 倍，导致提前触发降级。改它要有新的实测数据。
 */

const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;

/**
 * 每个 CJK 字符的 token 数。
 *
 * 原值 1.5 是拍脑袋来的，**高估约 2.6 倍**。2026-08-14 对 MiniMax-M3 实测
 *（扣除 176 tokens 的对话模板固定开销）：
 *       460 个中文字 →     260 tokens = 0.565 tok/字
 *   1,600,000 字符   → 800,176 tokens = 0.50  tok/字
 *
 * 取 0.6，比实测略高留一点安全余量。
 */
const CJK_TOKENS_PER_CHAR = 0.6;

/**
 * 非 CJK 每字符的 token 数。英文散文实测 880 字符 → 181 tokens ≈ 0.206。
 * JSON / 代码更密一些，取 0.25（即原来的 /4）兜得住，无需改。
 */
const NON_CJK_TOKENS_PER_CHAR = 0.25;

/**
 * 估算文本的 token 数量。
 *
 * 系数来自对目标模型的实测（见上方常量注释），**不是通用值**。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkChars = text.match(CJK_REGEX);
  const cjkCount = cjkChars?.length ?? 0;
  const nonCjkLength = text.length - cjkCount;
  return Math.ceil(
    nonCjkLength * NON_CJK_TOKENS_PER_CHAR + cjkCount * CJK_TOKENS_PER_CHAR,
  );
}
