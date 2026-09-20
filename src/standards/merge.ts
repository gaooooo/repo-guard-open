/**
 * 两层合并 —— 全局层（部门规范）+ 项目层（团队共识）。
 *
 * ── 为什么按 id 合并而不是按文件 ──
 * 按文件合并意味着"项目层写了 frontend-web.json 就整份替换"，于是团队要么全抄一遍
 * （下次插件升级拿不到新条目），要么不敢改。按 id 合并 + 字段级浅合并之后，
 * 项目层只需要写 `{ "id": "FE-UI-001", "severity": "inject" }` 三个字。
 *
 * 顺带的好处：项目层可以把一条条目挪到自己的文件里，只要 id 一致就还是同一条。
 *
 * ── 为什么放宽必须留痕，而不是禁止放宽 ──
 * 这是个零服务端的单机插件，没有企业策略层能兜住硬禁止。硬禁止的唯一后果是
 * 人把整个 `.codebuddy/standards/` 删掉 —— 那时连留痕都没了。
 * 所以：允许放宽，但缺 `override_reason` 的放宽**不生效**，并在 audit 里报出来。
 * 这样"想放宽"的人只需多写一行理由，而"想偷偷放宽"的人做不到。
 *
 * 收紧（remind → block）不需要理由：项目比模板更严是合理的，而且它仍要过
 * `effectiveSeverity` 的 block 准入三条件。
 */
import { severityRank, type StandardItem, type Severity } from './schema.js';

export interface MergeWarning {
  id: string;
  message: string;
  /**
   * 缺省 `warn`。
   *
   * `locked` 被违反时是 `error` —— 它要能让 `doctor` / `audit` 的退出码非零，
   * 否则部门挂在 CI 上的那一步永远是绿的，`locked` 就成了装饰。
   */
  level?: 'error' | 'warn' | 'info';
}

export interface MergeResult {
  items: StandardItem[];
  warnings: MergeWarning[];
}

/** 项目层这条是"只写了 id 和几个字段"的覆盖片段吗 */
function isOverrideFragment(item: StandardItem): boolean {
  return !item.title || !item.body;
}

/**
 * 项目层这次改动算"放宽"吗。
 *
 * 两种放宽：降低强度、关掉条目。两者都要求 `override_reason`。
 */
function isRelaxation(base: StandardItem, patch: StandardItem, patchRaw: Record<string, unknown>): string | null {
  if (Object.prototype.hasOwnProperty.call(patchRaw, 'enabled') && patch.enabled === false && base.enabled) {
    return '关闭了全局层条目';
  }
  if (
    Object.prototype.hasOwnProperty.call(patchRaw, 'severity') &&
    severityRank(patch.severity) < severityRank(base.severity)
  ) {
    return `把强度从 ${base.severity} 降到 ${patch.severity}`;
  }
  return null;
}

/**
 * 字段级浅合并。项目层只覆盖它显式写了的字段。
 *
 * 用 `patchRaw` 判断"写了没"而不是看 `patch` 的值是否为空：净化后的条目里
 * `enabled` 有默认值 true，分不出"显式写了 true"和"没写"。而这两者在
 * 放宽判定里的含义完全不同。
 */
function mergeOne(base: StandardItem, patch: StandardItem, patchRaw: Record<string, unknown>): StandardItem {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(patchRaw, k);
  return {
    ...base,
    title: patch.title || base.title,
    body: patch.body || base.body,
    why: has('why') ? patch.why : base.why,
    paths: has('paths') ? patch.paths : base.paths,
    excludePaths: has('excludePaths') ? patch.excludePaths : base.excludePaths,
    timing: has('timing') && patch.timing.length ? patch.timing : base.timing,
    severity: has('severity') ? patch.severity : base.severity,
    check: has('check') ? patch.check : base.check,
    landing: has('landing') && patch.landing.length ? patch.landing : base.landing,
    hint: has('hint') ? patch.hint : base.hint,
    tags: has('tags') ? patch.tags : base.tags,
    enabled: has('enabled') ? patch.enabled : base.enabled,
    confirmed: has('confirmed') ? patch.confirmed : base.confirmed,
    override_reason: patch.override_reason,
    // 策略跟着全局层走。项目层自己写 override_policy 是没有意义的 ——
    // 那等于"我宣布我可以改我自己"，允许它就等于给 locked 开了后门
    override_policy: base.override_policy,
    // stack 跟着全局层走：项目层把条目挪到别的文件里不改变它的端归属，
    // 否则注入分组会突然变掉
    stack: base.stack,
    source: 'project',
  };
}

/**
 * 合并两层。
 *
 * @param global 全局层条目（插件内 templates/standards/）
 * @param project 项目层条目（<repo>/.codebuddy/standards/）
 * @param projectRaw 项目层条目的原始对象，按 id 索引。用来判断"哪些字段被显式写了"
 */
export function mergeLayers(
  global: StandardItem[],
  project: StandardItem[],
  projectRaw: Map<string, Record<string, unknown>>,
): MergeResult {
  const byId = new Map<string, StandardItem>();
  const warnings: MergeWarning[] = [];

  for (const g of global) {
    if (byId.has(g.id)) {
      warnings.push({ id: g.id, message: '全局层里出现了重复 id，后一条被忽略' });
      continue;
    }
    byId.set(g.id, g);
  }

  for (const p of project) {
    const base = byId.get(p.id);
    const raw = projectRaw.get(p.id) ?? {};

    if (!base) {
      // 新增条目。只写了 id 的片段找不到基底，注入了也没内容可说
      if (isOverrideFragment(p)) {
        warnings.push({
          id: p.id,
          message: '项目层新增条目缺 title 或 body（若想覆盖全局条目，请核对 id 拼写）',
        });
        continue;
      }
      byId.set(p.id, p);
      continue;
    }

    const policy = base.override_policy ?? 'free';
    const relax = isRelaxation(base, p, raw);

    // ① locked：放宽一律拒绝，写了理由也不行。收紧照常放行 ——
    //    部门锁的意图是"不许削弱"，比基线更严没有理由拦
    if (policy === 'locked' && relax) {
      warnings.push({
        level: 'error',
        id: p.id,
        message:
          `${relax}，但这条被全局层标了 override_policy: locked —— 本次放宽已忽略，仍按全局层执行。` +
          (p.override_reason
            ? '写了 override_reason 也不行：locked 的语义就是不接受放宽。' +
              '确有必要请找这份基线的维护方改全局层，而不是在项目层绕过'
            : ''),
      });
      continue;
    }

    // ② reason-required：任何修改都要理由，不只是放宽
    if (policy === 'reason-required' && !p.override_reason) {
      warnings.push({
        id: p.id,
        message:
          '这条被全局层标了 override_policy: reason-required —— 任何覆盖都要写 override_reason。本次覆盖已忽略',
      });
      continue;
    }

    // ③ free（缺省）：既有规则，放宽要理由
    if (relax && !p.override_reason) {
      // 放宽不生效，保留全局层原样。这是唯一一处"配了但故意不生效"，
      // 所以必须有 warning —— 静默忽略会让人以为改成功了
      warnings.push({
        id: p.id,
        message: `${relax}，但缺 override_reason —— 本次放宽已忽略，仍按全局层执行`,
      });
      continue;
    }

    byId.set(p.id, mergeOne(base, p, raw));
  }

  return { items: [...byId.values()], warnings };
}
