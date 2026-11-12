/**
 * v2 单一配置 —— 两层：插件内 config/repo-guard.json（全局）+ 仓库内 .codebuddy/repo-guard.json（项目）。
 *
 * ── 什么时候算「接入了 v2」──
 * 项目层文件存在才算。init 是告知开发者「启用了哪些控制」的环节，没跑过 init 的仓
 * 不应该突然被契约拦一次；全局层只提供项目层没写的字段的默认值。
 *
 * ── 合并规则 ──
 * 逐字段覆盖：项目层写了的字段（含数组，如 redlines.commands）整体替换全局层，没写的继承。
 * init 会把全部可调字段连同当前值写进项目层，开发者在一个文件里看全、就地改；
 * 全局层因此主要是 init 的模板和缺字段时的默认值。
 */
import { configPath, pluginPath, readJson } from '../runtime/paths.js';

export type Level = 'off' | 'remind' | 'enforce';
export type ContractMode = 'off' | 'auto' | 'required';
export type RedAction = 'remind' | 'ask' | 'block';

export interface PathRedline {
  glob: string;
  action: RedAction;
  reason: string;
}
export interface CommandRedline {
  pattern: string;
  action: RedAction;
  reason: string;
}
/** 字段红线：这些标识符在 paths 内的文件里出现次数不许变少（删除或改名） */
export interface FieldRedline {
  protects: string[];
  /** glob；空 = 全仓 */
  paths: string[];
  action: RedAction;
  reason: string;
}
/** 内容红线：新增的行里不许出现匹配 pattern 的内容（如硬编码凭据） */
export interface ContentRedline {
  pattern: string;
  flags: string;
  /** glob；空 = 全仓 */
  paths: string[];
  action: RedAction;
  reason: string;
}

export interface ControlConfig {
  mode: Level;
  task: { contract: ContractMode; scope: Level };
  budget: { addedLines: number; newFiles: number; funcLines: number; nesting: number; params: number };
  reuse: { beforeNew: Level };
  publicLayer: string[];
  verify: { commands: string[]; onStop: Level };
  redlines: { paths: PathRedline[]; commands: CommandRedline[]; fields: FieldRedline[]; content: ContentRedline[] };
  baseline: { extra: string[] };
}

export interface LoadedControl {
  /** 项目层存在 = 本仓接入了 v2 */
  active: boolean;
  cfg: ControlConfig;
  /** 字段值来自哪一层（status 用），key 形如 task.contract */
  source: Record<string, 'global' | 'project' | 'builtin'>;
  /** 取值不合法、未知字段等。doctor / status 报出来，运行时按默认值处理 */
  issues: string[];
}

export const CONTROL_FILE = 'repo-guard.json';

export function controlFile(repoDir: string): string {
  return configPath(repoDir, CONTROL_FILE);
}

export function globalControlFile(): string {
  return pluginPath('config', CONTROL_FILE);
}

const BUILTIN: ControlConfig = {
  mode: 'remind',
  task: { contract: 'auto', scope: 'remind' },
  budget: { addedLines: 300, newFiles: 5, funcLines: 60, nesting: 4, params: 5 },
  reuse: { beforeNew: 'remind' },
  publicLayer: [],
  verify: { commands: [], onStop: 'remind' },
  redlines: { paths: [], commands: [], fields: [], content: [] },
  baseline: { extra: [] },
};

const LEVELS: Level[] = ['off', 'remind', 'enforce'];
const CONTRACTS: ContractMode[] = ['off', 'auto', 'required'];
const ACTIONS: RedAction[] = ['remind', 'ask', 'block'];
const KNOWN_TOP = new Set(['mode', 'task', 'budget', 'reuse', 'publicLayer', 'verify', 'redlines', 'baseline']);

type Raw = Record<string, unknown>;

function obj(v: unknown): Raw | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null;
}

function strs(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()) : null;
}

/** 读一层。文件不存在 → null；JSON 坏了 → issues 里记一条并当空层 */
function readLayer(file: string, label: string, issues: string[]): Raw | null {
  const raw = readJson<unknown>(file);
  if (raw === null) return null;
  const o = obj(raw);
  if (!o) {
    issues.push(label + '：顶层必须是对象');
    return {};
  }
  for (const k of Object.keys(o)) if (!k.startsWith('_') && !KNOWN_TOP.has(k)) issues.push(label + '：未知字段 ' + k);
  return o;
}

function pick<T extends string>(v: unknown, allowed: T[], key: string, label: string, issues: string[]): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string' && (allowed as string[]).includes(v)) return v as T;
  issues.push(label + '：' + key + ' 取值 ' + JSON.stringify(v) + ' 不合法，可选 ' + allowed.join(' / '));
  return undefined;
}

function posInt(v: unknown, key: string, label: string, issues: string[]): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  issues.push(label + '：' + key + ' 必须是正整数');
  return undefined;
}

function redPaths(v: unknown, label: string, issues: string[]): PathRedline[] {
  if (!Array.isArray(v)) return [];
  const out: PathRedline[] = [];
  for (const it of v) {
    const o = obj(it);
    const glob = typeof o?.glob === 'string' ? o.glob.trim() : '';
    if (!o || !glob) {
      issues.push(label + '：redlines.paths 每条需要 glob');
      continue;
    }
    const action = pick(o.action ?? 'block', ACTIONS, 'redlines.paths[' + glob + '].action', label, issues) ?? 'block';
    out.push({ glob, action, reason: typeof o.reason === 'string' ? o.reason : '' });
  }
  return out;
}

function redCommands(v: unknown, label: string, issues: string[]): CommandRedline[] {
  if (!Array.isArray(v)) return [];
  const out: CommandRedline[] = [];
  for (const it of v) {
    const o = obj(it);
    const pattern = typeof o?.pattern === 'string' ? o.pattern.trim() : '';
    if (!o || !pattern) {
      issues.push(label + '：redlines.commands 每条需要 pattern');
      continue;
    }
    const action = pick(o.action ?? 'block', ACTIONS, 'redlines.commands[' + pattern + '].action', label, issues) ?? 'block';
    out.push({ pattern, action, reason: typeof o.reason === 'string' ? o.reason : '' });
  }
  return out;
}

function redFields(v: unknown, label: string, issues: string[]): FieldRedline[] {
  if (!Array.isArray(v)) return [];
  const out: FieldRedline[] = [];
  for (const it of v) {
    const o = obj(it);
    const protects = strs(o?.protects) ?? [];
    if (!o || !protects.length) {
      issues.push(label + '：redlines.fields 每条需要非空的 protects（字段名 / 函数名 / 错误码）');
      continue;
    }
    const action = pick(o.action ?? 'block', ACTIONS, 'redlines.fields[' + protects[0] + '].action', label, issues) ?? 'block';
    out.push({ protects, paths: strs(o.paths) ?? [], action, reason: typeof o.reason === 'string' ? o.reason : '' });
  }
  return out;
}

function redContent(v: unknown, label: string, issues: string[]): ContentRedline[] {
  if (!Array.isArray(v)) return [];
  const out: ContentRedline[] = [];
  for (const it of v) {
    const o = obj(it);
    const pattern = typeof o?.pattern === 'string' ? o.pattern : '';
    const flags = typeof o?.flags === 'string' ? o.flags.replace(/[gy]/g, '') : '';
    if (!o || !pattern) {
      issues.push(label + '：redlines.content 每条需要 pattern（正则）');
      continue;
    }
    try {
      new RegExp(pattern, flags);
    } catch {
      issues.push(label + '：redlines.content 正则不合法，已跳过：' + pattern);
      continue;
    }
    const action = pick(o.action ?? 'block', ACTIONS, 'redlines.content[' + pattern + '].action', label, issues) ?? 'block';
    out.push({ pattern, flags, paths: strs(o.paths) ?? [], action, reason: typeof o.reason === 'string' ? o.reason : '' });
  }
  return out;
}

/** 把一层叠到 cfg 上 */
function apply(cfg: ControlConfig, layer: Raw, tag: 'global' | 'project', label: string, source: LoadedControl['source'], issues: string[]): void {
  const set = (key: string) => {
    source[key] = tag;
  };
  const mode = pick(layer.mode, LEVELS, 'mode', label, issues);
  if (mode) (cfg.mode = mode), set('mode');

  const task = obj(layer.task);
  if (task) {
    const c = pick(task.contract, CONTRACTS, 'task.contract', label, issues);
    if (c) (cfg.task.contract = c), set('task.contract');
    const s = pick(task.scope, LEVELS, 'task.scope', label, issues);
    if (s) (cfg.task.scope = s), set('task.scope');
  }

  const budget = obj(layer.budget);
  if (budget) {
    for (const k of ['addedLines', 'newFiles', 'funcLines', 'nesting', 'params'] as const) {
      const n = posInt(budget[k], 'budget.' + k, label, issues);
      if (n !== undefined) (cfg.budget[k] = n), set('budget.' + k);
    }
  }

  const reuse = obj(layer.reuse);
  if (reuse) {
    const b = pick(reuse.beforeNew, LEVELS, 'reuse.beforeNew', label, issues);
    if (b) (cfg.reuse.beforeNew = b), set('reuse.beforeNew');
  }

  const pl = strs(layer.publicLayer);
  if (pl) (cfg.publicLayer = pl), set('publicLayer');

  const verify = obj(layer.verify);
  if (verify) {
    const cmds = strs(verify.commands);
    if (cmds) (cfg.verify.commands = cmds), set('verify.commands');
    const o = pick(verify.onStop, LEVELS, 'verify.onStop', label, issues);
    if (o) (cfg.verify.onStop = o), set('verify.onStop');
  }

  const red = obj(layer.redlines);
  if (red) {
    if (Array.isArray(red.paths)) (cfg.redlines.paths = redPaths(red.paths, label, issues)), set('redlines.paths');
    if (Array.isArray(red.commands)) (cfg.redlines.commands = redCommands(red.commands, label, issues)), set('redlines.commands');
    if (Array.isArray(red.fields)) (cfg.redlines.fields = redFields(red.fields, label, issues)), set('redlines.fields');
    if (Array.isArray(red.content)) (cfg.redlines.content = redContent(red.content, label, issues)), set('redlines.content');
  }

  const base = obj(layer.baseline);
  if (base) {
    const ex = strs(base.extra);
    if (ex) (cfg.baseline.extra = ex), set('baseline.extra');
  }
}

export function loadControl(repoDir: string): LoadedControl {
  const issues: string[] = [];
  const source: LoadedControl['source'] = {};
  const cfg: ControlConfig = JSON.parse(JSON.stringify(BUILTIN));
  const g = readLayer(globalControlFile(), '全局层 config/repo-guard.json', issues);
  if (g) apply(cfg, g, 'global', '全局层', source, issues);
  const p = readLayer(controlFile(repoDir), '项目层 .codebuddy/repo-guard.json', issues);
  if (p) apply(cfg, p, 'project', '项目层', source, issues);
  return { active: p !== null, cfg, source, issues };
}

/** 只看内置 + 全局层（init 生成项目配置的模板、status 对比「与部门默认不同」） */
export function loadGlobalControl(): ControlConfig {
  const cfg: ControlConfig = JSON.parse(JSON.stringify(BUILTIN));
  const g = readLayer(globalControlFile(), '全局层', []);
  if (g) apply(cfg, g, 'global', '全局层', {}, []);
  return cfg;
}

/** 只读项目层的原始对象（init 补充模式用） */
export function readProjectControl(repoDir: string): Raw | null {
  return obj(readJson<unknown>(controlFile(repoDir)));
}

/** 启发式检查的实际档位：mode 是上限 */
export function effective(cfg: ControlConfig, level: Level): Level {
  if (cfg.mode === 'off' || level === 'off') return 'off';
  if (cfg.mode === 'remind') return 'remind';
  return level;
}

/** 契约要求：mode off 时一并关掉；否则不受 mode 上限约束（见 DESIGN-v2 3.3） */
export function contractMode(cfg: ControlConfig): ContractMode {
  return cfg.mode === 'off' ? 'off' : cfg.task.contract;
}

/** 内置开发基线（DESIGN-v2 第 5 节）。改这里等于改所有仓的注入，慎重 */
export const BASELINE: string[] = [
  '只做任务契约里的事；发现其他问题记到 guard_note，不要改。',
  '新写函数、组件前先 atlas hot / similar，已有就复用。',
  '最简实现：不为假想需求加参数、配置、抽象层，不做不必要的拆分。',
  '校验只放在边界（用户输入、外部接口）；内部调用信任调用方，不重复判空、不叠兜底。',
  '不改无关代码的格式、命名、注释，不做顺手重构。',
  '完成前跑契约里的验收命令，如实报告结果。',
];

export function baselineText(cfg: ControlConfig): string {
  const lines = [...BASELINE, ...cfg.baseline.extra].map((l, i) => i + 1 + '. ' + l);
  return ['repo-guard 开发基线：', ...lines].join('\n');
}