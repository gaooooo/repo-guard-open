/**
 * MVP · 工程上下文治理 — 红线判定引擎（纯函数）
 *
 *回答一个问题：**这次 tool_call 违反红线了吗？**
 *
 * ── 为什么这件事不好做 ──
 * agent 的动作是 tool_call，不是"我要删字段"这种声明。所以必须从
 * `file_write(path, content)` 或 `bash(command)` 的参数里**反推意图**。
 * 三种可选路线：
 *   ① 纯 prompt 自觉      → 拦不住，也演示不了"拦截"，等于没做
 *   ② 纯 LLM 判定         → 多一次往返、不可复现、演示不稳
 *   ③ 结构化 + 正则（本方案）→ 可复现、可单测、可试跑
 *
 * ── 三层判定，从强到弱 ──
 * L1 结构化删除判定（最强，有真 diff）
 *    关键发现：`file_write` 是**全量覆盖写**（src/tools/builtin/file-tool.ts:51-74
 *    直接 fs.writeFile），且项目里**没有 file_edit 工具**。所以拦截时读一次磁盘
 *    原文当 before，与 tool_call 的 content 当 after 一比，就能拿到**真实 diff**：
 *      "before 含 chain_status，after 不含" == 真的在删这个标识符
 *    这不是关键词表演，是有证据的判定。
 *
 * L2 意图正则（bash 绕道）
 *    LLM 会用 `sed -i` / `ALTER TABLE ... DROP COLUMN` 绕过 file_write。
 *    要求「受保护标识符」+「破坏性动作」**同时**命中才算违规——
 *    双条件是压误报的关键（只提到 chain_status 不算，`grep chain_status` 必须放过）。
 *
 * L3 paths 收窄
 *    规则可声明 paths glob，只在匹配路径生效。全局降噪。
 *
 * 所有函数保持纯粹（除L1 需要读磁盘，故把 before 作为入参传入），便于单测。
 */

import path from 'node:path';
import type { KnowledgeSnapshot, PolicyRule, PolicyVerdict } from './types.js';
import { extractWriteContent, isCodeWriteTool } from './write-tool-args.js';

export interface ContentMatchHit {
  file: string;
  line?: number;
  ruleId: string;
  found: string;
  expect: string;
}

const DIFF_MAX = 100_000;

/**
 * 从 unified diff 或纯新内容里抽出新增行。
 *
 * 有 `+++` / `@@` 当 unified diff 解析；否则整段当作 `fallbackFile` 的新内容。
 */
export function addedLinesFromDiff(
  diff: string,
  fallbackFile?: string,
): Array<{ file: string; line: number; text: string }> {
  const text = diff.length > DIFF_MAX ? diff.slice(0, DIFF_MAX) : diff;
  const lines = text.split(/\r?\n/);
  const hasUnified = lines.some((l) => l.startsWith('+++ ') || l.startsWith('@@ '));
  const out: Array<{ file: string; line: number; text: string }> = [];
  if (!hasUnified) {
    const file = fallbackFile ?? '';
    lines.forEach((l, i) => {
      const body = l.startsWith('+') && !l.startsWith('+++') ? l.slice(1) : l;
      out.push({ file, line: i + 1, text: body });
    });
    return out;
  }
  let file = fallbackFile ?? '';
  let newLine = 0;
  for (const l of lines) {
    const plusFile = /^\+\+\+\s+(?:b\/)?(.*)$/.exec(l);
    if (plusFile) {
      file = plusFile[1].trim();
      continue;
    }
    const hunk = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(l);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (l.startsWith('+') && !l.startsWith('+++')) {
      out.push({ file, line: newLine, text: l.slice(1) });
      newLine++;
      continue;
    }
    if (l.startsWith('-') && !l.startsWith('---')) continue;
    if (l.startsWith('\\')) continue;
    newLine++;
  }
  return out;
}

export function matchContentRules(
  rules: PolicyRule[],
  file: string,
  added: Array<{ line: number; text: string }>,
): { hits: ContentMatchHit[]; warnings: string[] } {
  const hits: ContentMatchHit[] = [];
  const warnings: string[] = [];
  const joined = added.map((l) => l.text).join('\n');
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    if (!ruleAppliesToPath(rule, file)) continue;
    for (const m of rule.contentMatchers ?? []) {
      let re: RegExp;
      try {
        re = new RegExp(m.pattern, m.flags ?? 'm');
      } catch {
        warnings.push(`${rule.id} matcher 正则非法，已跳过：${m.pattern.slice(0, 80)}`);
        continue;
      }
      let matched = false;
      for (const line of added) {
        re.lastIndex = 0;
        const hit = re.exec(line.text);
        if (!hit) continue;
        hits.push({
          file,
          line: line.line,
          ruleId: rule.id,
          found: hit[0].slice(0, 120),
          expect: m.message,
        });
        matched = true;
        break;
      }
      if (!matched) {
        re.lastIndex = 0;
        const hit = re.exec(joined);
        if (hit) {
          const before = joined.slice(0, hit.index);
          const idx = before.split('\n').length - 1;
          const line = added[Math.max(0, Math.min(idx, added.length - 1))];
          hits.push({
            file,
            line: line?.line,
            ruleId: rule.id,
            found: hit[0].replace(/\s+/g, ' ').slice(0, 120),
            expect: m.message,
          });
        }
      }
    }
  }
  return { hits, warnings };
}

/**
 * 破坏性动作正则。命中其中之一 + 命中受保护标识符 = L2 违规。
 *
 * 刻意不含 `grep` / `cat` / `find` 这类只读动作 —— 读是永远允许的。
 */
const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bsed\b[^|]*-i/i, label: 'sed -i 原地改写' },
  { re: /\bdrop\s+column\b/i, label: 'DROP COLUMN' },
  { re: /\bdrop\s+table\b/i, label: 'DROP TABLE' },
  { re: /\balter\s+table\b[\s\S]*\bdrop\b/i, label: 'ALTER TABLE ... DROP' },
  { re: /\btruncate\b/i, label: 'TRUNCATE' },
  { re: /\brm\s+(-[rf]+\s+)?/i, label: 'rm 删除文件' },
  { re: /\bgit\s+checkout\s+--/i, label: 'git checkout -- 丢弃改动' },
  { re: /\bgit\s+reset\s+--hard\b/i, label: 'git reset --hard' },
  { re: />\s*\S+/, label: 'shell 重定向覆盖写' },
];

/**
 * 极简 glob 匹配：支持 `*`（不跨 /）与 `**`（跨 /）。
 * 不引第三方库—— MVP 只需要 `upgrade/*.sql`、`app/**​/*.js` 这种量级。
 *
 * **导出给policy-audit 复用**：体检报告判断"paths 覆盖全了没"必须用
 * 与运行时判定完全相同的匹配规则。若各写一套，会出现"体检说覆盖完整、
 * 运行时其实拦不住"——那比没有体检更危险，因为它给出虚假的安全感。
 */
export function globMatch(pattern: string, target: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/^\.\//, '');
  const p = norm(pattern);
  const t = norm(target);

  // 先把** 换成占位，避免被 * 的规则吃掉
  const escaped = p
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  try {
    return new RegExp(`^${escaped}$`).test(t) || new RegExp(`(^|/)${escaped}$`).test(t);
  } catch {
    return false;
  }
}

/**
 * Q4：工蜂写没有本 run 缓存时，是否值得补一次 get_blob 给 L1。
 * 只对「声明了 paths 且含 protects」的红线补读，避免每次写入都 roundtrip。
 * 内容正则（contentMatchers）不需要 before。
 */
export function needsExtraBlobForL1(snapshot: KnowledgeSnapshot, relPath: string | null): boolean {
  if (!snapshot.ok || !relPath) return false;
  for (const rule of snapshot.policy.red_lines) {
    if (rule.enabled === false) continue;
    if (!rule.protects?.length) continue;
    const globs = rule.paths ?? [];
    if (globs.length === 0) continue;
    if (ruleAppliesToPath(rule, relPath)) return true;
  }
  return false;
}

/** 规则是否适用于该文件路径（L3）。规则未声明 paths = 全仓库生效。导出供体检器复用 */
export function ruleAppliesToPath(rule: PolicyRule, relPath: string | null): boolean {
  const globs = rule.paths ?? [];
  if (globs.length === 0) return true;
  if (!relPath) return true; // 拿不到路径（如纯 bash）时不因路径把规则排除掉
  return globs.some((g) => globMatch(g, relPath));
}

/**
 * 判断标识符是否"出现在代码里"而非仅出现在注释/字符串里。
 * MVP 从简：只做词边界匹配。刻意不做完整词法分析 —— 收益不抵复杂度。
 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^A-Za-z0-9_])${esc}([^A-Za-z0-9_]|$)`, 'g');
  let n = 0;
  while (re.exec(haystack) !== null) n++;
  return n;
}

/** 把绝对/相对路径统一成"相对仓库根"，便于跟 paths glob 比对 */
export function toRepoRelative(repoDir: string, filePath: string): string | null {
  if (!filePath) return null;
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(repoDir || process.cwd(), filePath);
    const rel = path.relative(repoDir || process.cwd(), abs);
    // 跑到仓库外了 → 不归本仓库的红线管
    if (rel.startsWith('..')) return null;
    return rel.replace(/\\/g, '/');
  } catch {
    return null;
  }
}

export interface CheckInput {
  toolName: string;
  /** tool_call 的 arguments（已解析成对象；解析失败传） */
  args: Record<string, unknown>;
  /**
   * L1 用：目标文件在磁盘上的原文。
   * 由调用方读取（引擎保持纯函数）。读不到传 null → 自动降级为 L2。
   */
  beforeContent?: string | null;
  /** 目标文件相对仓库根的路径。用于 L3 收窄 */
  relPath?: string | null;
}

/**
 * L1 · 结构化删除判定。
 *
 * 仅适用于 file_write（全量覆盖写）。逻辑：
 *   before 里出现 N 次、after 里出现 M 次，M < N → 判定为"在删这个标识符"。
 *
 * 用"次数减少"而非"完全消失"，是因为一个字段常在建表 + 索引 + 注释里多处出现，
 * 删掉其中关键一处也应拦下。
 */
function checkStructuralDelete(rule: PolicyRule, input: CheckInput): PolicyVerdict | null {
  const protects = rule.protects ?? [];
  if (protects.length === 0) return null;
  const before = input.beforeContent;
  const after = extractWriteContent(input.args);
  if (before == null || after == null) return null;

  const matched: string[] = [];
  const details: string[] = [];
  for (const id of protects) {
    const nBefore = countOccurrences(before, id);
    const nAfter = countOccurrences(after, id);
    if (nBefore > 0 && nAfter < nBefore) {
      matched.push(id);
      details.push(`\`${id}\`(原${nBefore} 处 → 改后 ${nAfter} 处)`);
    }
  }
  if (matched.length === 0) return null;
  return {
    blocked: true,
    rule,
    matched,
    layer: 'structural_delete',
    detail: `检测到受保护标识符被删除或减少：${details.join('、')}`,
  };
}

/**
 * L2 · 意图正则。
 *
 * 要求两个条件**同时**满足：
 *   a) 命令里提到了受保护标识符
 *   b) 命令包含破坏性动作
 * 只满足 a（如 `grep chain_status`）必须放过 —— 这是压误报的核心。
 */
function checkIntentRegex(rule: PolicyRule, input: CheckInput): PolicyVerdict | null {
  const protects = rule.protects ?? [];
  if (protects.length === 0) return null;

  // 把所有字符串型参数拼起来作为判定材料（bash 是 command，其他工具可能是别的键）
  const haystack = Object.values(input.args)
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
  if (!haystack) return null;

  const matched = protects.filter((id) => countOccurrences(haystack, id) > 0);
  if (matched.length === 0) return null;

  const hit = DESTRUCTIVE_PATTERNS.find((p) => p.re.test(haystack));
  if (!hit) return null; // 只是提到，没有破坏性动作 → 放过

  return {
    blocked: true,
    rule,
    matched,
    layer: 'intent_regex',
    detail: `命令中对受保护标识符 ${matched.map((m) => `\`${m}\``).join('、')} 执行了破坏性操作（${hit.label}）`,
  };
}

/**
 * no_refactor 清单判定：直接改动清单内文件即违规。
 * AI 最爱重构"看起来脏"的历史代码，这条是显式拦网。
 */
function checkNoRefactor(snapshot: KnowledgeSnapshot, input: CheckInput): PolicyVerdict | null {
  if (!input.relPath) return null;
  if (!isCodeWriteTool(input.toolName)) return null;

  for (const entry of snapshot.policy.no_refactor) {
    if (globMatch(entry.path, input.relPath)) {
      return {
        blocked: true,
        rule: {
          id: 'NO-REFACTOR',
          rule: `禁止修改 ${entry.path}`,
          reason: entry.reason,
          violation_action: 'stop_and_ask',
        },
        matched: [entry.path],
        layer: 'no_refactor',
        detail: `\`${input.relPath}\` 在 no_refactor 清单内${entry.reason ? `：${entry.reason}` : ''}`,
      };
    }
  }
  return null;
}

/**
 * 主入口：检查一次 tool_call 是否违反红线。
 *
 * @returns blocked=false 表示放行。**任何不确定的情况都放行**——
 *误拦正常开发的代价远高于漏拦一次（漏拦还有 prompt 里的红线兜底）。
 */
export function checkToolCall(snapshot: KnowledgeSnapshot, input: CheckInput): PolicyVerdict {
  const pass: PolicyVerdict = { blocked: false };
  if (!snapshot.ok) return pass;

  // no_refactor 优先：它是路径级的硬拦，不依赖 protects
  const nr = checkNoRefactor(snapshot, input);
  if (nr) return nr;

  for (const rule of snapshot.policy.red_lines) {
    if (rule.enabled === false) continue;
    if (rule.verify === 'llm') continue; // MVP 不实现 LLM 判定，跳过
    if (!ruleAppliesToPath(rule, input.relPath ?? null)) continue;

    // L1 优先（有真 diff，最可信）
    const structural = checkStructuralDelete(rule, input);
    if (structural) return structural;

    // L1 不适用（非写工具 / 读不到 before）→ 退到 L2
    const intent = checkIntentRegex(rule, input);
    if (intent) return intent;
  }

  if (isCodeWriteTool(input.toolName)) {
    const content = extractWriteContent(input.args);
    if (content && input.relPath) {
      const added = content.split(/\r?\n/).map((text, i) => ({ line: i + 1, text }));
      const { hits } = matchContentRules(snapshot.policy.red_lines, input.relPath, added);
      const hit = hits[0];
      if (hit) {
        const rule = snapshot.policy.red_lines.find((r) => r.id === hit.ruleId);
        return {
          blocked: true,
          rule: rule ?? {
            id: hit.ruleId,
            rule: hit.expect,
            violation_action: 'stop_and_ask',
          },
          matched: [hit.found],
          layer: 'content_match',
          detail: `写入内容命中红线 ${hit.ruleId}：${hit.expect}（发现 \`${hit.found}\`）`,
        };
      }
    }
  }
  return pass;
}

/** 供试跑器与界面展示：当前生效的规则数 */
export function countActiveRules(snapshot: KnowledgeSnapshot): number {
  return snapshot.policy.red_lines.filter((r) => r.enabled !== false).length;
}
