/**
 * 按仓库实况生成 / 补全 process-gates 里的图谱强制 pathPatterns。
 *
 * 模板把 newPageSimilar 等写成布尔 false，项目仓里就看不到 pathPatterns，
 * 后端仓也误以为这三件只属于前端。init 只填「目录确实存在」的 glob，
 * enabled 默认仍关（还要 admission=true 才硬拦），避免猜错路径后误伤。
 */
import fs from 'node:fs';
import path from 'node:path';

import { pluginPath, readJson, writeJson } from '../runtime/paths.js';
import { detectLibrary, suggestedComponentMcp } from '../library/library-catalog.js';
import { factsFile } from '../runtime/repo-facts.js';

const PAGE_DIRS = [
  'src/pages',
  'src/views',
  'src/routes',
  'src/page',
  'pages',
  'app',
];

const COMPONENT_DIRS = [
  'src/components',
  'src/component',
  'src/ui',
  'src/widgets',
  'components',
];

/** 后端「同类实现」：新建 handler / logic / 路由时先 similar */
const HANDLER_DIRS = [
  'internal/handler',
  'internal/logic',
  'internal/controller',
  'internal/service',
  'service',
  'router',
  'src/controller',
  'src/handlers',
  'src/api',
];

/** 后端/前端共用的高扇入目录：新建公共符号前先 hot */
const SHARED_DIRS = [
  'internal/pkg',
  'pkg',
  'internal/utils',
  'internal/dto',
  'src/utils',
  'src/hooks',
  'src/services',
  'src/lib',
];

function isDir(repoDir: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(repoDir, rel)).isDirectory();
  } catch {
    return false;
  }
}

function globsOf(repoDir: string, cands: string[]): string[] {
  const out: string[] = [];
  for (const rel of cands) {
    if (!isDir(repoDir, rel)) continue;
    const g = rel.replace(/\\/g, '/').replace(/\/+$/, '') + '/**';
    if (!out.includes(g)) out.push(g);
  }
  return out;
}

export interface GraphEnforceGuess {
  similar: string[];
  hot: string[];
  lib: string[];
}

export function guessGraphEnforce(repoDir: string): GraphEnforceGuess {
  const pages = globsOf(repoDir, PAGE_DIRS);
  const components = globsOf(repoDir, COMPONENT_DIRS);
  const handlers = globsOf(repoDir, HANDLER_DIRS);
  const shared = globsOf(repoDir, SHARED_DIRS);
  const hasUiLib = Boolean(detectLibrary(repoDir));

  return {
    similar: pages.length ? pages : handlers,
    hot: components.length ? [...components, ...shared.filter((g) => !components.includes(g))] : shared,
    lib: hasUiLib || components.length ? components : [],
  };
}

function subObject(enabled: boolean, pathPatterns: string[], note: string): Record<string, unknown> {
  return { _: note, enabled, pathPatterns };
}

function asExistingSub(raw: unknown): { enabled: boolean; pathPatterns: string[]; custom: boolean } {
  if (raw === true) return { enabled: true, pathPatterns: [], custom: false };
  if (raw === false || raw == null) return { enabled: false, pathPatterns: [], custom: false };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { enabled: false, pathPatterns: [], custom: false };
  }
  const o = raw as Record<string, unknown>;
  const patterns = Array.isArray(o.pathPatterns)
    ? o.pathPatterns.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  return {
    enabled: o.enabled === true,
    pathPatterns: patterns,
    custom: patterns.length > 0,
  };
}

const NOTES = {
  similar:
    '新建页/接口前查 similar。前端是页面骨架；后端是同类 handler/路由。enabled 默认关，硬拦还要 admission=true。',
  hot: '新建公共模块/组件前查 hot（仓内高扇入，别重造）。enabled 默认关，硬拦还要 admission=true。',
  lib: '新建 UI 组件前查 lib_search。无 UI 库时 patterns 为空。enabled 默认关，硬拦还要 admission=true。',
};

function overlayGuess(
  existing: unknown,
  guessed: string[],
  note: string,
): { value: Record<string, unknown>; changed: boolean } {
  const cur = asExistingSub(existing);
  if (cur.custom) {
    const obj =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : subObject(cur.enabled, cur.pathPatterns, note);
    if (typeof obj._ !== 'string') obj._ = note;
    return { value: obj, changed: JSON.stringify(existing) !== JSON.stringify(obj) };
  }
  return { value: subObject(cur.enabled, guessed, note), changed: true };
}

export function buildProcessGatesFromRepo(repoDir: string): Record<string, unknown> {
  const tpl =
    readJson<Record<string, unknown>>(pluginPath('layers', 'process-gates', 'process-gates.json')) ?? {};
  const g = guessGraphEnforce(repoDir);
  return {
    ...tpl,
    newPageSimilar: subObject(false, g.similar, NOTES.similar),
    newComponentHot: subObject(false, g.hot, NOTES.hot),
    newComponentLibSearch: subObject(false, g.lib, NOTES.lib),
  };
}

export function mergeGraphEnforceIntoProcessGates(
  existing: Record<string, unknown>,
  repoDir: string,
): { next: Record<string, unknown>; changed: boolean } {
  const g = guessGraphEnforce(repoDir);
  const similar = overlayGuess(existing.newPageSimilar, g.similar, NOTES.similar);
  const hot = overlayGuess(existing.newComponentHot, g.hot, NOTES.hot);
  const lib = overlayGuess(existing.newComponentLibSearch, g.lib, NOTES.lib);
  const changed = similar.changed || hot.changed || lib.changed;
  if (!changed) return { next: existing, changed: false };
  return {
    next: {
      ...existing,
      newPageSimilar: similar.value,
      newComponentHot: hot.value,
      newComponentLibSearch: lib.value,
    },
    changed: true,
  };
}

/** 已存在则按本仓目录补 pathPatterns（不覆盖人填过的非空 patterns）。返回说明行。 */
export function ensureProcessGatesFromRepo(repoDir: string, dest: string): string[] {
  const notes: string[] = [];
  if (!fs.existsSync(dest)) {
    writeJson(dest, buildProcessGatesFromRepo(repoDir));
    const g = guessGraphEnforce(repoDir);
    notes.push(
      'write  .codebuddy/process-gates.json  （按本仓目录填了 similar/hot/lib 的 pathPatterns，默认关）',
    );
    if (g.similar.length) notes.push('  similar  ' + g.similar.join(' '));
    if (g.hot.length) notes.push('  hot      ' + g.hot.join(' '));
    if (g.lib.length) notes.push('  lib      ' + g.lib.join(' '));
    if (!g.similar.length && !g.hot.length && !g.lib.length) {
      notes.push('  （本仓没识别到页/组件/handler 目录，patterns 为空，可事后手填）');
    }
    return notes;
  }

  const raw = readJson<Record<string, unknown>>(dest);
  if (!raw) {
    notes.push('skip  .codebuddy/process-gates.json  （已存在但不是合法 JSON，未改）');
    return notes;
  }
  const { next, changed } = mergeGraphEnforceIntoProcessGates(raw, repoDir);
  if (!changed) {
    notes.push('skip  .codebuddy/process-gates.json  （已有非空 pathPatterns，不覆盖）');
    return notes;
  }
  writeJson(dest, next);
  notes.push(
    'update .codebuddy/process-gates.json  （补全 similar/hot/lib 的 pathPatterns，未打开 enabled）',
  );
  const g = guessGraphEnforce(repoDir);
  if (g.similar.length) notes.push('  similar  ' + g.similar.join(' '));
  if (g.hot.length) notes.push('  hot      ' + g.hot.join(' '));
  if (g.lib.length) notes.push('  lib      ' + g.lib.join(' '));
  return notes;
}

/** 项目层 repo-facts 已存在时：空的 componentLibrary / 缺的 componentMcp 按依赖补。不覆盖人写的值。 */
export function fillComponentFacts(repoDir: string): string[] {
  const notes: string[] = [];
  const file = factsFile(repoDir);
  const raw = readJson<Record<string, unknown>>(file);
  if (!raw) return notes;

  let changed = false;
  const writtenLib = typeof raw.componentLibrary === 'string' ? raw.componentLibrary.trim() : '';
  const pkg = writtenLib || detectLibrary(repoDir);
  if (!writtenLib && pkg) {
    raw.componentLibrary = pkg;
    changed = true;
    notes.push('componentLibrary=' + pkg + '（从 package.json 识别）');
  }

  const hasMcpKey = Object.prototype.hasOwnProperty.call(raw, 'componentMcp');
  const mcp = suggestedComponentMcp(pkg);
  if (!hasMcpKey && mcp) {
    raw.componentMcp = mcp;
    changed = true;
    notes.push(
      'componentMcp=' +
        mcp +
        '（按组件库默认 MCP 名；必须与宿主里实际注册名一致，不对就改这一字段）',
    );
  }

  if (changed) writeJson(file, raw);
  return notes;
}

