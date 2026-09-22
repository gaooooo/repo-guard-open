/**
 * 规范加载 —— 两层读盘 + 端探测 + 占位符展开。
 *
 * ── 三条纪律沿用 gates/config.ts ──
 * ① **总闸关 / 目录缺失 = 零行为变化**：返回的 `enabled: false` 快照里没有任何条目，
 *    调用方按"什么都不做"处理。
 * ② **一条坏条目只跳过它自己**：净化在 schema.ts 里逐条做，这里不抛异常。
 * ③ **不建图**：这个函数会在 hook 的关键路径上被调用（`PreToolUse` 预算 15 秒），
 *    所以端探测只做 `existsSync` 与浅层 `readdir`，绝不建图、绝不读文件内容。
 *
 * ── 为什么全局层在插件目录里而不在 $HOME ──
 * 全局层是**部门规范**，它应该跟着插件版本走：升级插件就拿到新条目。
 * 放 $HOME 会变成"每台机器一份、谁也不知道别人在跑哪一版"。
 * 代价是安装后的副本改不动（缓存路径带版本号，升级换目录）——
 * 所以要改就改插件源码仓，或者用项目层覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';

import { configPath, pluginPath, readJson } from '../runtime/paths.js';
import { normalizePrefix, type RepoFacts } from '../runtime/repo-facts.js';
import { mergeLayers, type MergeWarning } from './merge.js';
import {
  ALL_STACKS,
  PUBLIC_LAYER_TOKEN,
  STACK_FILES,
  defaultSwitchboard,
  sanitizeItem,
  type Stack,
  type StandardItem,
  type StandardsSwitchboard,
  type Severity,
} from './schema.js';

/** 规范配置在被守护仓库里的位置 */
export const STANDARDS_DIR = 'standards';

export interface StandardsSnapshot {
  /** 总闸。false 时 items 必为空 */
  enabled: boolean;
  /** 项目层目录存在吗。false = 只有全局层 */
  projectPresent: boolean;
  switchboard: StandardsSwitchboard;
  /** 实际启用的端 */
  activeStacks: Stack[];
  /** 各端为什么被启用/跳过。`standards list` 要显示 */
  stackReasons: Record<string, string>;
  /** 合并后的全部条目（含 enabled:false 的，由调用方过滤） */
  items: StandardItem[];
  /**
   * 条目 id → 来源文件绝对路径。项目层覆盖过的指向项目层。
   *
   * 分片之后一个端有多个文件，`doctor` 报「这条是僵尸条目」时必须能说出
   * 是哪个文件里的哪一条 —— 否则在几十个文件里找一个 id 比修它还费劲。
   */
  origin: Map<string, string>;
  warnings: MergeWarning[];
}

export function standardsDirOf(repoDir: string): string {
  return configPath(repoDir, STANDARDS_DIR);
}

/**
 * 插件里模板目录的绝对路径。
 *
 * 全局层在 `layers/skills/standards/`（作者面技能库下的规范目录）。
 * 产物在 `bin/` 下，往上一级即插件根。
 */
export function standardsTemplateDir(): string {
  return pluginPath('layers', 'skills', STANDARDS_DIR);
}

function emptySnapshot(reason: string): StandardsSnapshot {
  return {
    enabled: false,
    projectPresent: false,
    switchboard: { ...defaultSwitchboard(), enabled: false },
    activeStacks: [],
    stackReasons: { _: reason },
    items: [],
    origin: new Map(),
    warnings: [],
  };
}

// ── 总闸 ──

function readSwitchboard(dir: string): Partial<StandardsSwitchboard> | null {
  return readSwitchboardFile(path.join(dir, 'standards.json'));
}

function readSwitchboardFile(file: string): Partial<StandardsSwitchboard> | null {
  const raw = readJson<Record<string, unknown>>(file);
  if (!raw) return null;
  const out: Partial<StandardsSwitchboard> = {};
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (typeof raw.maxSeverity === 'string') out.maxSeverity = raw.maxSeverity as Severity;
  if (typeof raw.injectBudgetTokens === 'number' && raw.injectBudgetTokens > 0) {
    out.injectBudgetTokens = Math.floor(raw.injectBudgetTokens);
  }
  if (raw.stacks && typeof raw.stacks === 'object' && !Array.isArray(raw.stacks)) {
    const src = raw.stacks as Record<string, unknown>;
    const stacks: Partial<Record<Stack, 'auto' | 'on' | 'off'>> = {};
    for (const s of ALL_STACKS) {
      const v = src[s];
      if (v === 'auto' || v === 'on' || v === 'off') stacks[s] = v;
    }
    out.stacks = stacks as Record<Stack, 'auto' | 'on' | 'off'>;
  }
  if (raw.stackDetect && typeof raw.stackDetect === 'object' && !Array.isArray(raw.stackDetect)) {
    const src = raw.stackDetect as Record<string, unknown>;
    const detect: Partial<Record<Stack, string[]>> = {};
    for (const s of ALL_STACKS) {
      const v = src[s];
      if (Array.isArray(v)) {
        detect[s] = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
      }
    }
    out.stackDetect = detect;
  }
  return out;
}

function mergeSwitchboard(
  base: StandardsSwitchboard,
  patch: Partial<StandardsSwitchboard> | null,
): StandardsSwitchboard {
  if (!patch) return base;
  return {
    enabled: patch.enabled ?? base.enabled,
    maxSeverity: patch.maxSeverity ?? base.maxSeverity,
    injectBudgetTokens: patch.injectBudgetTokens ?? base.injectBudgetTokens,
    stacks: { ...base.stacks, ...(patch.stacks ?? {}) },
    stackDetect: { ...base.stackDetect, ...(patch.stackDetect ?? {}) },
  };
}

// ── 条目 ──

interface LayerLoad {
  items: StandardItem[];
  raw: Map<string, Record<string, unknown>>;
  origin: Map<string, string>;
  warnings: MergeWarning[];
}

/** 这一层不存在时的空载荷 */
function emptyLayer(): LayerLoad {
  return { items: [], raw: new Map(), origin: new Map(), warnings: [] };
}

/**
 * 一个端在某一层里的全部来源文件，**按确定顺序**。
 *
 * 两种形态并存，单文件优先：
 * ```
 *   <dir>/backend-service.json      单文件（原有形态）
 *   <dir>/backend-service/*.json    分片目录
 * ```
 *
 * ── 为什么要支持分片 ──
 * 一个端的条目上到几十条之后单个 JSON 会到两千行：定位一条要靠搜索，
 * 多人同时填必然冲突。分片之后文件名可以对齐规范的来源
 *（`api-contract.json`、`resilience.json`），改哪条一眼知道去哪个文件。
 * 「文件即注入单元」那条设计不受影响 —— 注入单元始终是**端**，分片只是
 * 把同一个端的条目摊到几个文件里，`stack` 仍由这个函数的入参决定。
 *
 * ── 为什么必须 sort ──
 * `readdirSync` 的顺序在不同文件系统上不保证。同 id 重复时「保留先出现的」
 * 会因此随机翻转，症状是"有时候生效有时候不生效" —— 这类 bug 极难查。
 *
 * ── 为什么跳过 `_` 开头 ──
 * 与 `sanitizeItem` 的 id 约定、`loadGuardConfig` 的注释键约定一致。
 * 部门可以在分片目录里放 `_填空指南.json` 而不被当成条目文件。
 *
 * ── 为什么目录名从 STACK_FILES 推导而不是直接用 stack ──
 * 让「端 → 落盘名」只有一处真源。今天两者恰好同名，改了 STACK_FILES
 * 之后目录名会自动跟上，不会留下一个对不上的分片目录静默失效。
 */
export function stackSourceFiles(dir: string, stack: Stack): string[] {
  const out: string[] = [];

  const single = path.join(dir, STACK_FILES[stack]);
  try {
    if (fs.statSync(single).isFile()) out.push(single);
  } catch {
    /* 没有单文件：只用分片 */
  }

  const shardDir = path.join(dir, STACK_FILES[stack].replace(/\.json$/, ''));
  try {
    const names = fs
      .readdirSync(shardDir)
      .filter((n) => n.endsWith('.json') && !n.startsWith('_'))
      .sort();
    for (const n of names) out.push(path.join(shardDir, n));
  } catch {
    /* 没有分片目录 */
  }

  return out;
}

function readLayer(dir: string, stacks: Stack[], source: 'global' | 'project'): LayerLoad {
  const items: StandardItem[] = [];
  const raw = new Map<string, Record<string, unknown>>();
  const origin = new Map<string, string>();
  const warnings: MergeWarning[] = [];

  for (const stack of stacks) {
    for (const file of stackSourceFiles(dir, stack)) {
      const doc = readJson<Record<string, unknown>>(file);
      if (!doc || !Array.isArray(doc.items)) continue;
      for (const entry of doc.items) {
        const item = sanitizeItem(entry, stack, source);
        if (!item) continue;

        // 同层内 id 重复：保留先出现的。分片之前这几乎不可能（一个端一个文件，
        // 重复 id 一眼能看见），分片之后复制粘贴一个条目忘了改 id 就会中招。
        // 静默忽略会让人以为自己新写的那份生效了，实际生效的是另一个文件里的旧条目。
        const first = origin.get(item.id);
        if (first) {
          warnings.push({
            id: item.id,
            message:
              `在${source === 'global' ? '全局' : '项目'}层出现了两次` +
              `（${path.basename(first)} 与 ${path.basename(file)}）—— 后一条已忽略`,
          });
          continue;
        }

        items.push(item);
        origin.set(item.id, file);
        if (entry && typeof entry === 'object') {
          raw.set(item.id, entry as Record<string, unknown>);
        }
      }
    }
  }
  return { items, raw, origin, warnings };
}

// ── 端探测 ──

const ANALYZER_STACKS: Record<string, Stack[]> = {
  'web-frontend': ['frontend-web'],
  'node-babel': ['frontend-web', 'backend-service'],
  'go-gin': ['backend-service'],
  'go-trpc': ['backend-service'],
  'java-spring': ['backend-service'],
  'python-ast': ['backend-service'],
  'py-graph-source': ['backend-service'],
};

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.codebuddy',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  '.next',
  '.venv',
  '__pycache__',
]);

/**
 * 浅层找有没有匹配扩展名的文件。
 *
 * 只读目录项、不读文件内容，深度与预算都封顶 —— 它跑在 hook 的关键路径上。
 * 预算用尽就返回 false：**探不到就不启用该端**，方向是"少注入"而不是"多注入"。
 * 多注入的代价是给前端仓塞一份数据库规范，那比漏注入更糟。
 */
function hasFileWithExt(repoDir: string, exts: string[], maxDepth = 3, budget = 1500): boolean {
  if (!exts.length) return false;
  let left = budget;
  const walk = (dir: string, depth: number): boolean => {
    if (depth > maxDepth || left <= 0) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    const subdirs: string[] = [];
    for (const e of entries) {
      if (left-- <= 0) return false;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) subdirs.push(path.join(dir, e.name));
        continue;
      }
      if (exts.some((ext) => e.name.endsWith(ext))) return true;
    }
    for (const sub of subdirs) {
      if (walk(sub, depth + 1)) return true;
    }
    return false;
  };
  return walk(repoDir, 0);
}

function detectStack(repoDir: string, patterns: string[]): string | null {
  const exts: string[] = [];
  for (const p of patterns) {
    if (!p.includes('*')) {
      // 目录或具体文件：existsSync 就够，最便宜
      const abs = path.join(repoDir, p.replace(/\/+$/, ''));
      try {
        if (fs.existsSync(abs)) return `命中目录特征 ${p}`;
      } catch {
        /* 权限问题当没命中 */
      }
      continue;
    }
    const m = /\*(\.[A-Za-z0-9.]+)$/.exec(p);
    if (m) exts.push(m[1]);
  }

  if (exts.length && hasFileWithExt(repoDir, exts)) {
    return `命中文件类型 ${exts.join('/')}`;
  }
  return null;
}

function resolveStacks(
  repoDir: string,
  facts: RepoFacts | null,
  sb: StandardsSwitchboard,
): { active: Stack[]; reasons: Record<string, string> } {
  const active: Stack[] = [];
  const reasons: Record<string, string> = {};
  const analyzer = facts?.analyzer ?? null;
  const byAnalyzer = new Set<Stack>(analyzer ? (ANALYZER_STACKS[analyzer] ?? []) : []);

  for (const stack of ALL_STACKS) {
    const mode = sb.stacks[stack] ?? 'auto';
    if (mode === 'off') {
      reasons[stack] = '配置为 off';
      continue;
    }
    if (mode === 'on') {
      active.push(stack);
      reasons[stack] = '配置为 on';
      continue;
    }
    if (byAnalyzer.has(stack)) {
      active.push(stack);
      reasons[stack] = `analyzer=${analyzer}`;
      continue;
    }
    const hit = detectStack(repoDir, sb.stackDetect[stack] ?? []);
    if (hit) {
      active.push(stack);
      reasons[stack] = hit;
      continue;
    }
    reasons[stack] = analyzer ? `auto 未探测到（analyzer=${analyzer}）` : 'auto 未探测到';
  }
  return { active, reasons };
}

// ── 占位符 ──

/**
 * 展开 `__PUBLIC_LAYER__`。
 *
 * 公共层清单只有一份权威源（`repo-facts.publicLayer`），规范里不许再写一遍 ——
 * 写两遍必然对不上，然后"规范说要拦、守卫说不拦"，人会以为工具坏了。
 *
 * 展开成 `前缀**` 的 glob：`src/components/` → `src/components/**`。
 *
 * ── 公共层清单为空时必须关掉这条，不能留空 paths ──
 * `itemAppliesToPath` 把"paths 为空"解释成**全仓适用**（大多数规范是这个语义）。
 * 但对一条只想管公共层的规范，展开成空之后留空 paths 会让它突然适用于全仓 ——
 * 方向从"少管"翻成"全管"，是最坏的一种失败。所以这里直接把它关掉并留一条告警。
 */
function expandPublicLayer(items: StandardItem[], facts: RepoFacts | null): MergeWarning[] {
  const layers = (facts?.publicLayer ?? [])
    .map(normalizePrefix)
    .filter(Boolean)
    .map((p) => `${p}**`);
  const warnings: MergeWarning[] = [];

  for (const item of items) {
    if (!item.paths?.some((p) => p === PUBLIC_LAYER_TOKEN)) continue;
    const rest = item.paths.filter((p) => p !== PUBLIC_LAYER_TOKEN);
    const merged = [...rest, ...layers];
    if (merged.length) {
      item.paths = merged;
      continue;
    }
    // 公共层没配（或还没跑过 init --write）：关掉，不要变成全仓生效
    if (item.enabled) {
      item.enabled = false;
      warnings.push({
        id: item.id,
        message: '依赖公共层清单，但 repo-facts.publicLayer 是空的 —— 已跳过。跑 `repo-guard init --write` 并人工确认公共层',
      });
    }
    delete item.paths;
  }
  return warnings;
}

export interface LoadOptions {
  /**
   * 忽略端探测，强制加载全部端。**只给 `doctor` 用。**
   *
   * 端探测回答的是"这个仓库属于哪几端"，而填配置的人问的是"我填的**所有**
   * 条目对不对"。部门在自己机器上跑 doctor 时，被守护的仓库可能一个端都探不到，
   * 那样检查就只覆盖了 l0/common 两端（它们默认 on），后端那几十条一条都没查。
   *
   * 绝不能用在运行时路径上 —— 那会把数据库规范注给前端仓。
   */
  forceAllStacks?: boolean;
}

/**
 * 加载规范快照。
 *
 * @param facts `repo-facts.json` 的内容。传 null 表示本仓还没跑过 init ——
 *              此时端探测只能靠目录特征，`__PUBLIC_LAYER__` 会展开成空。
 */
export function loadStandards(
  repoDir: string,
  facts: RepoFacts | null,
  opts: LoadOptions = {},
): StandardsSnapshot {
  const globalDir = standardsTemplateDir();
  const projectDir = standardsDirOf(repoDir);

  const projectFile = configPath(repoDir, 'standards.json');
  let projectDirExists = false;
  try {
    projectDirExists = fs.statSync(projectDir).isDirectory();
  } catch {
    projectDirExists = false;
  }
  const projectFileExists = fs.existsSync(projectFile);
  const projectPresent = projectDirExists || projectFileExists;

  let globalPresent = false;
  try {
    globalPresent = fs.statSync(globalDir).isDirectory();
  } catch {
    globalPresent = false;
  }
  if (!globalPresent && !projectPresent) {
    return emptySnapshot('插件模板目录与项目配置目录都不存在');
  }

  const sb = mergeSwitchboard(
    mergeSwitchboard(defaultSwitchboard(), globalPresent ? readSwitchboard(globalDir) : null),
    projectFileExists ? readSwitchboardFile(projectFile) : projectDirExists ? readSwitchboard(projectDir) : null,
  );
  if (!sb.enabled) {
    const snap = emptySnapshot('standards.json 的 enabled 为 false');
    snap.switchboard = sb;
    snap.projectPresent = projectPresent;
    return snap;
  }

  const { active, reasons } = opts.forceAllStacks
    ? {
        active: [...ALL_STACKS],
        reasons: Object.fromEntries(ALL_STACKS.map((s) => [s, '强制全端（doctor）'])) as Record<
          string,
          string
        >,
      }
    : resolveStacks(repoDir, facts, sb);
  if (!active.length) {
    return {
      enabled: true,
      projectPresent,
      switchboard: sb,
      activeStacks: [],
      stackReasons: reasons,
      items: [],
      origin: new Map(),
      warnings: [],
    };
  }

  const g = globalPresent ? readLayer(globalDir, active, 'global') : emptyLayer();
  const p = projectDirExists ? readLayer(projectDir, active, 'project') : emptyLayer();
  const merged = mergeLayers(g.items, p.items, p.raw);
  const layerWarnings = expandPublicLayer(merged.items, facts);

  return {
    enabled: true,
    projectPresent,
    switchboard: sb,
    activeStacks: active,
    stackReasons: reasons,
    items: merged.items,
    // 项目层覆盖过的条目，来源指向项目层文件 —— 人要去改的是那一份
    origin: new Map([...g.origin, ...p.origin]),
    warnings: [...g.warnings, ...p.warnings, ...merged.warnings, ...layerWarnings],
  };
}

/** 启用中的条目。`enabled: false` 是"先写下来但暂不生效"的开关 */
export function activeItems(snap: StandardsSnapshot): StandardItem[] {
  return snap.items.filter((i) => i.enabled);
}
