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

import { configPath, pluginPath, readJson } from '../runtime/paths.js';

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
    inject: boolean;
    admission: boolean;
    loop: boolean;
    signals: boolean;
    delivery: boolean;
    governance: boolean;
  };
  inject: InjectConfig;
  noRefactor: NoRefactorEntry[];
  scopeGate: ScopeGateConfig;
  graphEnforce: GraphEnforceConfig;
  loop: LoopGuardConfig;
  delivery: DeliveryConfig;
  review: ReviewConfig;
}

// ── 默认值。改这里等于改"没配置时的行为"，务必保持全关 ──

export function defaultConfig(): GuardConfig {
  return {
    present: false,
    gates: {
      // L0 与 L6 默认开：一个只注入、一个只写自己的文件，都没有误伤风险。
      // 其余一律关 —— 见文件头。
      inject: true,
      admission: false,
      loop: false,
      signals: false,
      delivery: false,
      governance: true,
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
export const PROCESS_GATES_FILE = 'process-gates.json';
export const FACTS_FILE = 'facts.json';

function flagEnabled(v: unknown, d: boolean): boolean {
  if (typeof v === 'boolean') return v;
  return bool(obj(v).enabled, d);
}

function asLoop(raw: unknown, d: LoopGuardConfig): LoopGuardConfig {
  const o = obj(raw);
  return {
    enabled: bool(o.enabled, d.enabled),
    repeatToolCallThreshold: posInt(o.repeatToolCallThreshold, d.repeatToolCallThreshold),
    consecutiveFailThreshold: posInt(o.consecutiveFailThreshold, d.consecutiveFailThreshold),
    sameFileWriteFailThreshold: posInt(o.sameFileWriteFailThreshold, d.sameFileWriteFailThreshold),
    maxIterations: posInt(o.maxIterations, d.maxIterations),
    maxIterationsObserveOnly: true,
  };
}

function asSub(raw: unknown): { enabled: boolean; pathPatterns: string[] } {
  if (typeof raw === 'boolean') return { enabled: raw, pathPatterns: [] };
  const o = obj(raw);
  return { enabled: bool(o.enabled, false), pathPatterns: strArr(o.pathPatterns) };
}

/**
 * 过程门禁 + 工程事实（机器侧）。
 *
 * 项目仓只读两个薄文件：
 *   .codebuddy/process-gates.json
 *   .codebuddy/facts.json
 * 都不在 = 零行为变化（公共层守卫仍由 repo-facts 驱动，不走这里）。
 */
export function loadGuardConfig(repoDir: string): GuardConfig {
  const cfg = defaultConfig();
  const pg = readJson<Record<string, unknown>>(configPath(repoDir, PROCESS_GATES_FILE));
  const facts = readJson<Record<string, unknown>>(configPath(repoDir, FACTS_FILE));
  if (!pg && !facts) return cfg;

  if (pg) {
    cfg.present = true;
    cfg.gates.inject = flagEnabled(pg.inject, cfg.gates.inject);
    cfg.gates.admission = flagEnabled(pg.admission, cfg.gates.admission);
    cfg.gates.loop = flagEnabled(obj(pg.loop).enabled ?? pg.loop, cfg.gates.loop);
    cfg.gates.signals = flagEnabled(pg.signals, cfg.gates.signals);
    cfg.gates.delivery = flagEnabled(obj(pg.delivery).enabled ?? pg.delivery, cfg.gates.delivery);
    cfg.gates.governance = flagEnabled(pg.governance, cfg.gates.governance);

    if (Array.isArray(pg.noRefactor)) {
      for (const raw of pg.noRefactor) {
        const e = obj(raw);
        const pth = str(e.path).trim();
        if (!pth) continue;
        cfg.noRefactor.push({ path: pth, reason: str(e.reason).trim(), confirmed: bool(e.confirmed, false) });
      }
    }

    const sg = obj(pg.scope);
    cfg.scopeGate = {
      enabled: bool(sg.enabled, false),
      allowlist: strArr(sg.allowlist),
      maxFiles: nullableInt(sg.maxFiles),
    };

    cfg.graphEnforce = {
      publicLayerImpact: true,
      newPageSimilar: asSub(pg.newPageSimilar),
      newComponentHot: asSub(pg.newComponentHot),
      newComponentLibSearch: asSub(pg.newComponentLibSearch),
    };

    cfg.loop = asLoop(pg.loop, cfg.loop);

    const dl = obj(pg.delivery);
    const ec = obj(dl.engineeringCheck);
    cfg.delivery = {
      enabled: bool(dl.enabled, false),
      engineeringCheck: {
        enabled: typeof dl.engineeringCheck === 'string' ? dl.engineeringCheck !== 'off' : bool(ec.enabled, false),
        mode: (typeof dl.engineeringCheck === 'string' ? dl.engineeringCheck : str(ec.mode)) === 'block' ? 'block' : 'warn',
      },
      deliveryBudget: {
        enabled: bool(obj(dl.deliveryBudget).enabled, bool(dl.maxDeliveryFiles != null && dl.maxDeliveryFiles !== undefined, false)),
        maxDeliveryFiles: nullableInt(obj(dl.deliveryBudget).maxDeliveryFiles ?? dl.maxDeliveryFiles),
      },
      evidencePatterns: strArr(dl.evidencePatterns),
    };

    const rv = obj(pg.review);
    cfg.review = {
      enabled: bool(rv.enabled, false),
      minRiskLevel: rv.minRiskLevel === 'high' ? 'high' : 'medium',
      blockOnRequestChanges: bool(rv.blockOnRequestChanges, false),
      agent: str(rv.agent).trim(),
    };
  }

  if (facts) {
    cfg.inject.mission = str(facts.mission).trim();
    cfg.inject.facts = strArr(facts.facts);
    cfg.inject.discipline = strArr(facts.discipline);
    cfg.inject.taboos = strArr(facts.taboos);
    cfg.inject.stopConditions = strArr(facts.stopConditions);
    if (Array.isArray(facts.knowledge)) {
      for (const raw of facts.knowledge) {
        const it = obj(raw);
        if (it.enabled !== true) continue;
        const content = str(it.content).trim();
        if (!content) continue;
        cfg.inject.knowledge.push({ id: str(it.id, '?'), topic: str(it.topic).trim(), content });
      }
    }
    const routes = obj(facts.taskRoutes);
    const routeList = Array.isArray(facts.taskRoutes) ? facts.taskRoutes : Object.entries(routes).map(([name, raw]) => ({ name, ...(obj(raw) as object) }));
    for (const raw of routeList as unknown[]) {
      const r = obj(raw);
      const name = str(r.name, '').trim();
      if (!name || name.startsWith('_')) continue;
      if (r.enabled !== true) continue;
      const match = strArr(r.match);
      if (!match.length) continue;
      cfg.inject.taskRoutes.push({
        name,
        match,
        required: strArr(r.required),
        hardGate: str(r.hard_gate || r.hardGate).trim(),
      });
    }
  }

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

/** 插件里模板目录的绝对路径。layers/process-gates/；章程/知识/路由在 facts/skills，init 拼进项目 guard/ */
export function templateDir(): string {
  // __dirname 在打包后的 CJS 产物里指向 bin/
  return pluginPath('layers', 'process-gates');
}
