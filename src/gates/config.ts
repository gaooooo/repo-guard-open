/**
 * 七道门的配置加载 —— 协作全景在这里落成一个对象。
 *
 * ── 一条硬约束贯穿整个文件 ──
 * **配置缺失 = 所有门关闭 = 零行为变化。**
 *
 * 这不是"顺手做个容错"，而是这个插件能被接受的前提：一个装完就开始拦人的护栏，
 * 人的第一反应是卸载。所以默认值一律 `enabled: false`，只有两个例外：
 *   · L0 注入面   —— 只注入不拦，没有误伤风险
 *   · L6 治理留痕 —— 只写自己的文件（$HOME 下），不碰用户仓库
 *
 * 而且 `verify-hooks` 的 20 条用例是在**没有 guard 配置**的仓库上跑的 ——
 * 它们全绿就是"零行为变化"的证据。加任何一道门之后那 20 条必须还是全绿。
 *
 * ── 为什么忽略 `_` 开头的键 ──
 * JSON 不支持注释，而这些配置文件里的注释比配置本身长（每一项都要解释
 * 为什么默认是这个值、打开之后会拦什么）。三种方案里选了"`_` 字段"：
 *   改用 JSONC        → 生态支持不一致，`JSON.parse` 直接崩
 *   注释另写 .md      → 必然失同步，改配置的人不会同时改文档
 *   `_` 字段（选这个）→ 注释和配置同文件同位置，改不了一个忘另一个
 * 这也是 deerclaw 自己 `allowlist.json` 的风格（那边叫 `_why`）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { configPath, readJson } from '../runtime/paths.js';

/** guard 配置在被守护仓库里的位置 */
export const GUARD_DIR = 'guard';

export interface ScopeGateConfig {
  enabled: boolean;
  /** 只允许写这些路径前缀。空数组 = 不限 */
  allowlist: string[];
  /** 单会话允许改动的不同文件数上限。null = 不限 */
  maxFiles: number | null;
}

export interface LoopGuardConfig {
  enabled: boolean;
  repeatToolCallThreshold: number;
  consecutiveFailThreshold: number;
  sameFileWriteFailThreshold: number;
  maxIterations: number;
  /** 迭代预算只能近似观测（插件拿不到 iteration 序号），恒为 true */
  maxIterationsObserveOnly: boolean;
}

export interface DeliveryConfig {
  enabled: boolean;
  engineeringCheck: { enabled: boolean; mode: 'warn' | 'block' };
  deliveryBudget: { enabled: boolean; maxDeliveryFiles: number | null };
  evidencePatterns: string[];
}

export interface ReviewConfig {
  enabled: boolean;
  minRiskLevel: 'medium' | 'high';
  blockOnRequestChanges: boolean;
  agent: string;
}

export interface RestateConfig {
  enabled: boolean;
  lengthRatio: [number, number];
  skipReasons: string[];
  model: string;
}

export interface GraphEnforceConfig {
  /** 改公共层已有文件前必须查 impact。插件核心功能，不可关 */
  publicLayerImpact: boolean;
  newPageSimilar: { enabled: boolean; pathPatterns: string[] };
  newComponentHot: { enabled: boolean; pathPatterns: string[] };
  newComponentLibSearch: { enabled: boolean; pathPatterns: string[] };
}

export interface InjectConfig {
  /** L0 总闸。默认开 —— 只注入不拦 */
  enabled: boolean;
  mission: string;
  facts: string[];
  discipline: string[];
  /** 项目知识条目（已过滤 enabled=false） */
  knowledge: Array<{ id: string; topic: string; content: string }>;
  taboos: string[];
  stopConditions: string[];
  /** 任务类型 → 必读清单（已过滤 enabled=false） */
  taskRoutes: Array<{
    name: string;
    match: string[];
    required: string[];
    hardGate: string;
  }>;
}

export interface NoRefactorEntry {
  path: string;
  reason: string;
  confirmed: boolean;
}

export interface GuardConfig {
  /** 配置目录是否存在。false 时下面全是默认值（= 全关） */
  present: boolean;
  gates: {
    L0_inject: boolean;
    L1_admission: boolean;
    L3_loop: boolean;
    L4_signals: boolean;
    L5_delivery: boolean;
    L6_governance: boolean;
  };
  inject: InjectConfig;
  noRefactor: NoRefactorEntry[];
  scopeGate: ScopeGateConfig;
  graphEnforce: GraphEnforceConfig;
  loop: LoopGuardConfig;
  delivery: DeliveryConfig;
  review: ReviewConfig;
  restate: RestateConfig;
}

// ── 默认值。改这里等于改"没配置时的行为"，务必保持全关 ──

export function defaultConfig(): GuardConfig {
  return {
    present: false,
    gates: {
      // L0 与 L6 默认开：一个只注入、一个只写自己的文件，都没有误伤风险。
      // 其余一律关 —— 见文件头。
      L0_inject: true,
      L1_admission: false,
      L3_loop: false,
      L4_signals: false,
      L5_delivery: false,
      L6_governance: true,
    },
    inject: {
      enabled: true,
      mission: '',
      facts: [],
      discipline: [],
      knowledge: [],
      taboos: [],
      stopConditions: [],
      taskRoutes: [],
    },
    noRefactor: [],
    scopeGate: { enabled: false, allowlist: [], maxFiles: null },
    graphEnforce: {
      publicLayerImpact: true,
      newPageSimilar: { enabled: false, pathPatterns: [] },
      newComponentHot: { enabled: false, pathPatterns: [] },
      newComponentLibSearch: { enabled: false, pathPatterns: [] },
    },
    loop: {
      enabled: false,
      // 阈值照搬 deerclaw。3 是有道理的：第 1 次失败可能是笔误，
      // 第 2 次是没理解报错，第 3 次才是卡住了。设 2 会在正常试错中误伤。
      repeatToolCallThreshold: 3,
      consecutiveFailThreshold: 3,
      sameFileWriteFailThreshold: 2,
      maxIterations: 80,
      maxIterationsObserveOnly: true,
    },
    delivery: {
      enabled: false,
      engineeringCheck: { enabled: false, mode: 'warn' },
      deliveryBudget: { enabled: false, maxDeliveryFiles: null },
      evidencePatterns: [],
    },
    review: { enabled: false, minRiskLevel: 'medium', blockOnRequestChanges: false, agent: '' },
    restate: {
      enabled: false,
      lengthRatio: [0.7, 1.3],
      skipReasons: ['too_short', 'question_only', 'ack_followup'],
      model: '',
    },
  };
}

// ── 取值助手。全部"取不到就用默认"，一条坏配置不拖死整份 ──

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}
function bool(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d;
}
function posInt(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : d;
}
function nullableInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}
function str(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d;
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function readGuard<T>(repoDir: string, rel: string): Partial<T> {
  return readJson<Partial<T>>(configPath(repoDir, GUARD_DIR, rel)) ?? {};
}

/**
 * 加载全部 guard 配置。
 *
 * 任何一个文件缺失、坏掉、字段类型不对，都退到该项的默认值，**不抛异常**。
 * 这个函数在 hook 的关键路径上，抛异常会让工具调用被阻断 ——
 * 为了一个配置语法错误把人的操作弄失败，是最蠢的失败方式。
 */
export function loadGuardConfig(repoDir: string): GuardConfig {
  const cfg = defaultConfig();

  const dir = configPath(repoDir, GUARD_DIR);
  try {
    if (!fs.statSync(dir).isDirectory()) return cfg;
  } catch {
    return cfg; // 没铺过配置：全默认 = 全关
  }
  cfg.present = true;

  // ── 总闸 ──
  const root = readGuard<{ gates: Record<string, { enabled?: unknown }>; requirementRestate: { enabled?: unknown } }>(
    repoDir,
    'guard.json',
  );
  const gates = obj(root.gates);
  for (const key of Object.keys(cfg.gates) as Array<keyof GuardConfig['gates']>) {
    cfg.gates[key] = bool(obj(gates[key]).enabled, cfg.gates[key]);
  }
  // L2 执行门交给宿主的 permissions / sandbox，插件永不实现。
  // 它在 guard.json 里有个位置只是为了让全景七道门都能被看到。

  // ── L0 注入面 ──
  const charter = readGuard<{ mission: unknown; facts: unknown; discipline: unknown }>(
    repoDir,
    'identity/charter.json',
  );
  cfg.inject.mission = str(charter.mission).trim();
  cfg.inject.facts = strArr(charter.facts);
  cfg.inject.discipline = strArr(charter.discipline);

  const pk = readGuard<{ items: unknown }>(repoDir, 'capability/project-knowledge.json');
  if (Array.isArray(pk.items)) {
    for (const raw of pk.items) {
      const it = obj(raw);
      // enabled=false 是"先写下来但暂不生效"的开关，不是配置错误
      if (it.enabled !== true) continue;
      const content = str(it.content).trim();
      if (!content) continue;
      cfg.inject.knowledge.push({ id: str(it.id, '?'), topic: str(it.topic).trim(), content });
    }
  }

  cfg.inject.taboos = strArr(readGuard<{ items: unknown }>(repoDir, 'constraint/taboos.json').items);
  cfg.inject.stopConditions = strArr(
    readGuard<{ items: unknown }>(repoDir, 'constraint/stop-conditions.json').items,
  );

  const routes = obj(readGuard<{ routes: unknown }>(repoDir, 'capability/task-routes.json').routes);
  for (const [name, raw] of Object.entries(routes)) {
    if (name.startsWith('_')) continue; // 注释键
    const r = obj(raw);
    if (r.enabled !== true) continue;
    const match = strArr(r.match);
    if (!match.length) continue; // 没有 match 的路由永远不会命中，等于没配
    cfg.inject.taskRoutes.push({
      name,
      match,
      required: strArr(r.required),
      hardGate: str(r.hard_gate).trim(),
    });
  }

  // ── L1 准入门 ──
  const nr = readGuard<{ entries: unknown }>(repoDir, 'constraint/no-refactor.json');
  if (Array.isArray(nr.entries)) {
    for (const raw of nr.entries) {
      const e = obj(raw);
      const p = str(e.path).trim();
      if (!p) continue;
      cfg.noRefactor.push({ path: p, reason: str(e.reason).trim(), confirmed: bool(e.confirmed, false) });
    }
  }

  const sg = readGuard<ScopeGateConfig>(repoDir, 'constraint/scope-gate.json');
  cfg.scopeGate = {
    enabled: bool(sg.enabled, false),
    allowlist: strArr(sg.allowlist),
    maxFiles: nullableInt(sg.maxFiles),
  };

  const ge = readGuard<Record<string, unknown>>(repoDir, 'process/graph-enforce.json');
  const subGate = (key: string) => {
    const o = obj(ge[key]);
    return { enabled: bool(o.enabled, false), pathPatterns: strArr(o.pathPatterns) };
  };
  cfg.graphEnforce = {
    // 这一条不读配置：它是插件的核心功能，关掉等于卸载插件
    publicLayerImpact: true,
    newPageSimilar: subGate('newPageSimilar'),
    newComponentHot: subGate('newComponentHot'),
    newComponentLibSearch: subGate('newComponentLibSearch'),
  };

  // ── L3 循环门 ──
  const loop = readGuard<Record<string, unknown>>(repoDir, 'process/loop.json');
  cfg.loop = {
    enabled: bool(loop.enabled, false),
    repeatToolCallThreshold: posInt(loop.repeatToolCallThreshold, 3),
    consecutiveFailThreshold: posInt(loop.consecutiveFailThreshold, 3),
    sameFileWriteFailThreshold: posInt(loop.sameFileWriteFailThreshold, 2),
    maxIterations: posInt(loop.maxIterations, 80),
    // 恒 true：插件没有对话循环的所有权，拿不到 iteration 序号。
    // 允许配置会让人以为它能拦。
    maxIterationsObserveOnly: true,
  };

  // ── L5 交付门 ──
  const dl = readGuard<Record<string, unknown>>(repoDir, 'process/delivery.json');
  const ec = obj(dl.engineeringCheck);
  const db = obj(dl.deliveryBudget);
  cfg.delivery = {
    enabled: bool(dl.enabled, false),
    engineeringCheck: {
      enabled: bool(ec.enabled, false),
      mode: ec.mode === 'block' ? 'block' : 'warn',
    },
    deliveryBudget: {
      enabled: bool(db.enabled, false),
      maxDeliveryFiles: nullableInt(db.maxDeliveryFiles),
    },
    evidencePatterns: strArr(dl.evidencePatterns),
  };

  const rv = readGuard<Record<string, unknown>>(repoDir, 'process/review.json');
  cfg.review = {
    enabled: bool(rv.enabled, false),
    minRiskLevel: rv.minRiskLevel === 'high' ? 'high' : 'medium',
    blockOnRequestChanges: bool(rv.blockOnRequestChanges, false),
    agent: str(rv.agent).trim(),
  };

  // ── 需求复述（独立于七道门）──
  const rs = readGuard<Record<string, unknown>>(repoDir, 'process/restate.json');
  const ratio = Array.isArray(rs.lengthRatio) ? rs.lengthRatio : [];
  cfg.restate = {
    enabled: bool(rs.enabled, bool(obj(root.requirementRestate).enabled, false)),
    lengthRatio: [
      typeof ratio[0] === 'number' ? ratio[0] : 0.7,
      typeof ratio[1] === 'number' ? ratio[1] : 1.3,
    ],
    skipReasons: strArr(rs.skipReasons).length
      ? strArr(rs.skipReasons)
      : ['too_short', 'question_only', 'ack_followup'],
    model: str(rs.model).trim(),
  };

  return cfg;
}

/** L0 注入面有实际内容吗。全空时不该往上下文里塞空段落 */
export function hasInjectContent(cfg: GuardConfig): boolean {
  const i = cfg.inject;
  return Boolean(
    i.mission || i.facts.length || i.discipline.length || i.knowledge.length || i.taboos.length || i.stopConditions.length,
  );
}

/** guard 配置目录的绝对路径，给 `guard init` 用 */
export function guardDirOf(repoDir: string): string {
  return configPath(repoDir, GUARD_DIR);
}

/** 插件里模板目录的绝对路径。产物在 bin/ 下，模板在 ../templates/guard */
export function templateDir(): string {
  // __dirname 在打包后的 CJS 产物里指向 bin/
  return path.resolve(__dirname, '..', 'templates', GUARD_DIR);
}
