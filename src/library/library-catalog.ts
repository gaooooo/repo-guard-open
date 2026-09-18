/**
 * 组件库目录检索 —— 回答「本仓 UI 组件库里有没有现成的」。
 *
 * ── 为什么这个查询值得单独做一个工具 ──
 * 内部组件库不在模型的训练数据里。凭 antd / MUI 经验写出来的 props
 * **几乎一定是错的**，而且错法很隐蔽：名字对、类型错，要到运行时才炸。
 * 更常见的浪费是：仓里已经有 `MultiSelect` 了，AI 又手写一个。
 *
 * ── 检索为什么用词表而不是向量 ──
 * 查询词是中文（「多选下拉」），候选是组件名 + 一句话中文描述，总量几十条。
 * 这个规模下做向量检索的收益是零，而代价是要么带模型（产物几百兆）、
 * 要么出网（这个插件的卖点就是零出网）。所以是子串 + 同义词表打分。
 */
import fs from 'node:fs';
import path from 'node:path';

import { builtinCatalog, type CatalogEntry } from './builtin-catalog.js';
import { readJson } from '../runtime/paths.js';

/** 可能是 UI 组件库的依赖名。顺序即优先级 —— 一个仓同时装了多个时取第一个命中的 */
const KNOWN_UI_PACKAGES = [
  '@tencent/tea-component',
  'antd',
  'tdesign-react',
  'tdesign-vue-next',
  '@arco-design/web-react',
  'element-plus',
  '@mui/material',
  'naive-ui',
];

/**
 * 中文查询词 → 组件名/英文关键词的同义词表。
 *
 * 只收**高频且中英差异大**的那些。表太长反而会拉低精度（一个词命中一堆组件，
 * 排序就没意义了），所以宁缺毋滥 —— 查不到比查出一堆不相关的好，
 * 后者会让模型随便挑一个用。
 */
const SYNONYMS: Record<string, string[]> = {
  下拉: ['Select', 'Dropdown', 'AutoComplete', 'TreeSelect'],
  多选: ['Select', 'Checkbox', 'Transfer', 'TreeSelect'],
  单选: ['Radio', 'Select'],
  选择: ['Select', 'Picker', 'Radio', 'Checkbox'],
  表格: ['Table', 'List'],
  列表: ['List', 'Table'],
  分页: ['Pagination'],
  表单: ['Form', 'Input'],
  输入: ['Input', 'InputNumber', 'Textarea'],
  弹窗: ['Modal', 'Drawer', 'Popconfirm'],
  抽屉: ['Drawer'],
  提示: ['Tooltip', 'Alert', 'Message', 'Notification', 'Popover'],
  气泡: ['Popover', 'Tooltip', 'Bubble'],
  日期: ['DatePicker', 'Calendar', 'TimePicker'],
  时间: ['TimePicker', 'DatePicker'],
  上传: ['Upload'],
  树: ['Tree', 'TreeSelect'],
  标签: ['Tag', 'Tabs'],
  按钮: ['Button'],
  加载: ['Spin', 'Loading', 'Skeleton'],
  步骤: ['Steps'],
  面包屑: ['Breadcrumb'],
  菜单: ['Menu', 'Dropdown'],
  头像: ['Avatar'],
  开关: ['Switch'],
  滑块: ['Slider'],
  进度: ['Progress'],
  卡片: ['Card'],
  折叠: ['Collapse'],
  穿梭: ['Transfer'],
  级联: ['Cascader'],
};

export interface LibraryInfo {
  /** 包名。null = 本仓识别不出 UI 组件库 */
  pkg: string | null;
  entries: CatalogEntry[];
  /** 目录从哪来：内置词表 / 解析 node_modules 的 d.ts */
  source: 'builtin' | 'dts' | 'none';
}

interface PkgJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** 从 package.json 认出本仓用的 UI 组件库 */
export function detectLibrary(repoDir: string, override?: string | null): string | null {
  if (override && override.trim()) return override.trim();
  const pkg = readJson<PkgJson>(path.join(repoDir, 'package.json'));
  if (!pkg) return null;
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };
  for (const name of KNOWN_UI_PACKAGES) {
    if (deps[name]) return name;
  }
  return null;
}

/**
 * 从 `node_modules/<pkg>` 的类型声明里抠导出名。
 *
 * 这是内置词表的退路：内部组件库不可能内置，只能现算。
 * 只抠**名字**不抠 props —— props 必须让模型去查真实定义，
 * 从 d.ts 里半解析出来的 props 会是错的，而错的 props 比没有更坏。
 */
function exportsFromDts(repoDir: string, pkg: string): CatalogEntry[] {
  const base = path.join(repoDir, 'node_modules', ...pkg.split('/'));
  const candidates = ['es/index.d.ts', 'lib/index.d.ts', 'dist/index.d.ts', 'index.d.ts', 'types/index.d.ts'];
  for (const rel of candidates) {
    const f = path.join(base, rel);
    let src: string;
    try {
      if (!fs.existsSync(f)) continue;
      src = fs.readFileSync(f, 'utf-8');
    } catch {
      continue;
    }
    const names = new Set<string>();
    // `export { A, B as C }` / `export declare const X` / `export default X`
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const seg of m[1].split(',')) {
        const nm = seg.trim().split(/\s+as\s+/).pop()?.trim();
        // 只要大驼峰 —— 组件名的约定。小写的多是工具函数与类型
        if (nm && /^[A-Z][A-Za-z0-9]*$/.test(nm)) names.add(nm);
      }
    }
    for (const m of src.matchAll(/export\s+declare\s+(?:const|class|function)\s+([A-Z][A-Za-z0-9]*)/g)) {
      names.add(m[1]);
    }
    if (names.size) {
      return [...names].sort().map((name) => ({ name, oneLiner: '', category: 'other' }));
    }
  }
  return [];
}

export function loadLibrary(repoDir: string, override?: string | null): LibraryInfo {
  const pkg = detectLibrary(repoDir, override);
  if (!pkg) return { pkg: null, entries: [], source: 'none' };

  const builtin = builtinCatalog(pkg);
  if (builtin && builtin.length) return { pkg, entries: builtin, source: 'builtin' };

  const dts = exportsFromDts(repoDir, pkg);
  if (dts.length) return { pkg, entries: dts, source: 'dts' };

  return { pkg, entries: [], source: 'none' };
}

/**
 * 给一条候选打分。命不中返回 0。
 *
 * 分层是刻意的：名字直接命中（3）> 描述命中（2）> 同义词命中（1）。
 * 不分层的话「多选下拉」会把 `Checkbox`（描述含"多选"）排到 `Select` 前面，
 * 而 `Select` 才是那个正确答案。
 */
function score(entry: CatalogEntry, query: string, tokens: string[]): number {
  const name = entry.name.toLowerCase();
  const desc = entry.oneLiner;
  let s = 0;

  const q = query.toLowerCase();
  if (q && name.includes(q)) s = Math.max(s, 3);
  if (desc && desc.includes(query)) s = Math.max(s, 2);

  for (const t of tokens) {
    if (/^[a-z]/i.test(t)) {
      if (name.includes(t.toLowerCase())) s = Math.max(s, 3);
    } else if (desc && desc.includes(t)) {
      s = Math.max(s, 2);
    }
    const syn = SYNONYMS[t];
    if (syn) {
      for (const cand of syn) {
        if (entry.name === cand) s = Math.max(s, 1);
      }
    }
  }
  return s;
}

/** 把中文查询切成"能用于匹配"的片段：2 字滑窗 + 英文单词 */
function tokenize(query: string): string[] {
  const out = new Set<string>();
  for (const m of query.matchAll(/[A-Za-z][A-Za-z0-9]*/g)) out.add(m[0]);
  const cjk = query.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length; i++) {
    if (i + 2 <= cjk.length) out.add(cjk.slice(i, i + 2));
  }
  // 单字也留：「树」「表」这种单字组件名的查询确实存在
  for (const ch of cjk) out.add(ch);
  return [...out];
}

export interface LibraryHit extends CatalogEntry {
  score: number;
}

export function searchLibrary(info: LibraryInfo, query: string, limit = 5): LibraryHit[] {
  const q = (query ?? '').trim();
  if (!q) return [];
  const tokens = tokenize(q);
  return info.entries
    .map((e) => ({ ...e, score: score(e, q, tokens) }))
    .filter((e) => e.score > 0)
    // 同分按"名字短的在前" —— `Select` 比 `TreeSelect` 更可能是想要的那个
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, limit);
}
