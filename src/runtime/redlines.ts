/**
 * redlines —— 从 `.codebuddy/redlines.json` 读人写的红线意图。
 *
 * ── 这个文件替代了 deerclaw 的 policy-source.ts ──
 * deerclaw 那份是**平台侧数据源**：drizzle + `policy_rules` / `agent_configs` 表，
 * 按 agent 维度加载、按 `updated_at` 失效。零服务端插件里没有数据库，一行都跑不起来。
 *
 * 但它有一条必须保住的契约，原文件注释里写得很清楚：
 *   「输出与 knowledge-loader 完全一致的 KnowledgeSnapshot。因为结构不变，
 *     policy-engine / policy-audit 全链路零改动 —— 只换了『红线从哪来』，
 *     没换『红线怎么用』。」
 * 所以这里也产出同一个 `KnowledgeSnapshot`，engine 那边完全不知道数据源换了。
 *
 * ── 为什么红线必须是人写的、必须进 git ──
 * "这个接口外部仍有调用方，改名等于让对方 404" —— 这种事静态分析**永远推不出来**。
 * 它是人的知识。而既然是人写的意图，就得跟代码走同一个 PR、能 review、能回溯，
 * 所以放仓库文件而不是某个数据库。代价是改完要提交才生效，换来的是零延迟锚定。
 */
import path from 'node:path';

import { configPath, readJson } from './paths.js';
import {
  emptySnapshot,
  type KnowledgeSnapshot,
  type NoRefactorEntry,
  type PolicyRule,
} from '../engine/types.js';

/** `redlines.json` 的磁盘形状。字段全部可选 —— 残缺的手写文件也要能用 */
interface RedlinesFile {
  rules?: unknown;
  /** 禁止重构清单。AI 最爱重构"看起来脏"的历史代码，必须显式拦住 */
  no_refactor?: unknown;
  /** Agent 必须停下来问人的场景。纯文本，注入 prompt 供 LLM 自觉 */
  stop_conditions?: unknown;
}

export function redlinesFile(repoDir: string): string {
  return configPath(repoDir, 'redlines.json');
}

/**
 * 部门级红线模板在插件里的位置。
 *
 * ⚠️ **它不参与运行时加载。** `loadRedlines` 与 `hasRedlines` 只看项目层，
 * 这个函数只被 `redlines init` 用来做一次性拷贝。
 *
 * 为什么不做成两层合并（三条理由写在 templates/redlines.json 的 `_` 注释里）：
 * 简短版是 —— 全局层一旦参与，没写过红线的仓库会突然多出一段 SessionStart 注入，
 * 而 `audit` 的「未配置」退出码也会从 2 变成 0。那违反「空配置零行为变化」。
 *
 * `__dirname` 在打包后的 CJS 产物里指向 `bin/`，所以往上一级找 `templates/`，
 * 与 `standardsTemplateDir()` / `gates/config.ts` 的 `templateDir()` 同构。
 */
export function redlinesTemplateFile(): string {
  return path.resolve(__dirname, '..', 'templates', 'redlines.json');
}

export function hasRedlines(repoDir: string): boolean {
  return readJson<RedlinesFile>(redlinesFile(repoDir)) !== null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

/**
 * 逐条净化规则。
 *
 * 一条坏规则只跳过它自己，不拖死整份红线 —— 这是 deerclaw 里反复出现的姿势
 *（"非法正则的 matcher 跳过，不让一条坏规则拖死整份红线"）。
 * 红线文件是人手写的，必然会有写错的时候；因为第 3 条格式错就让前 2 条也失效，
 * 等于把人的心智负担放大到不可接受。
 */
function toRules(v: unknown): PolicyRule[] {
  if (!Array.isArray(v)) return [];
  const out: PolicyRule[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    const rule = typeof r.rule === 'string' ? r.rule.trim() : '';
    // id 与 rule 是判定与回显的最小集：没有 id 没法在中断消息里指认是哪条，
    // 没有 rule 正文给模型看了也不知道为什么被拦
    if (!id || !rule) continue;

    const item: PolicyRule = { id, rule };
    if (typeof r.reason === 'string' && r.reason.trim()) item.reason = r.reason;
    const protects = asStringArray(r.protects);
    if (protects.length) item.protects = protects;
    const paths = asStringArray(r.paths);
    if (paths.length) item.paths = paths;
    if (r.violation_action === 'warn' || r.violation_action === 'stop_and_ask') {
      item.violation_action = r.violation_action;
    }
    if (typeof r.evidence === 'string' && r.evidence.trim()) item.evidence = r.evidence;
    if (r.verify === 'auto' || r.verify === 'llm') item.verify = r.verify;
    if (typeof r.enabled === 'boolean') item.enabled = r.enabled;
    if (typeof r.confirmed === 'boolean') item.confirmed = r.confirmed;
    if (Array.isArray(r.contentMatchers)) {
      const ms = r.contentMatchers
        .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
        .filter((m) => typeof m.pattern === 'string' && typeof m.message === 'string')
        .map((m) => ({
          pattern: m.pattern as string,
          flags: typeof m.flags === 'string' ? (m.flags as string) : undefined,
          message: m.message as string,
        }));
      if (ms.length) item.contentMatchers = ms;
    }
    out.push(item);
  }
  return out;
}

function toNoRefactor(v: unknown): NoRefactorEntry[] {
  if (!Array.isArray(v)) return [];
  const out: NoRefactorEntry[] = [];
  for (const raw of v) {
    if (typeof raw === 'string' && raw.trim()) {
      out.push({ path: raw.trim() });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.path !== 'string' || !r.path.trim()) continue;
    const item: NoRefactorEntry = { path: r.path.trim() };
    if (typeof r.reason === 'string') item.reason = r.reason;
    if (typeof r.confirmed === 'boolean') item.confirmed = r.confirmed;
    out.push(item);
  }
  return out;
}

/**
 * 加载红线快照。
 *
 * 文件不存在 → `ok: false` 的空快照。全链路必须按"什么都不做"降级，
 * 绝不能因为知识层缺失阻塞 AI（照抄 deerclaw 的容错姿势）。
 */
export function loadRedlines(repoDir: string): KnowledgeSnapshot {
  const file = redlinesFile(repoDir);
  const raw = readJson<RedlinesFile>(file);
  if (!raw) return emptySnapshot(repoDir);

  const rules = toRules(raw.rules);
  const warnings: string[] = [];
  if (Array.isArray(raw.rules) && rules.length < raw.rules.length) {
    warnings.push(
      `redlines.json 里有 ${raw.rules.length - rules.length} 条规则缺 id 或 rule，已跳过。`,
    );
  }

  return {
    ok: true,
    repoDir,
    policy: {
      red_lines: rules,
      no_refactor: toNoRefactor(raw.no_refactor),
      stop_conditions: asStringArray(raw.stop_conditions),
    },
    index: { task_routes: {} },
    loadedFiles: ['.codebuddy/redlines.json'],
    warnings,
  };
}

/** 启用中的规则（`enabled: false` 是"不删规则也能关掉"的开关） */
export function activeRules(snapshot: KnowledgeSnapshot): PolicyRule[] {
  return snapshot.policy.red_lines.filter((r) => r.enabled !== false);
}
