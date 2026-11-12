/**
 * 改动回执：会话内 Stop 与合并门 check 共用的同一套计算。
 *
 * 输入是「文件改动前 / 改动后」的内容对；会话内的「改动前」来自写前快照（只算 AI 经写工具改的文件，
 * 开发者原有的改动不算进去），合并门的来自 git。
 */
import type { ControlConfig } from './config.js';
import { diffLines, splitLines, type Hunk } from './diff.js';
import { extractFunctions, supportsFunctions, type FuncInfo } from './functions.js';
import { isAuxFile } from './scope.js';

export interface FileChange {
  /** 展示用路径（多仓时带仓名） */
  label: string;
  rel: string;
  before: string | null;
  after: string | null;
  /** 没有改动前的内容（快照缺失 / 文件过大）：只列文件，不量增量 */
  noBaseline?: boolean;
  outOfScope?: boolean;
}

export interface ComplexityIssue {
  file: string;
  func: string;
  line: number;
  kind: 'lines' | 'nesting' | 'params';
  value: number;
  limit: number;
}

export interface Receipt {
  files: Array<{ label: string; added: number; deleted: number; isNew: boolean; removed: boolean; outOfScope: boolean; noBaseline: boolean }>;
  added: number;
  deleted: number;
  newFiles: number;
  newFuncs: number;
  complexity: ComplexityIssue[];
  noise: Array<{ file: string; line: number }>;
  outOfScope: string[];
  noBaseline: string[];
}

const LABEL: Record<ComplexityIssue['kind'], string> = { lines: '行', nesting: '层嵌套', params: '个参数' };

export function complexityText(i: ComplexityIssue): string {
  return i.file + '#' + i.func + ' ' + i.value + LABEL[i.kind] + '（阈值 ' + i.limit + '）';
}

/**
 * 本次新增的函数超阈值，或已有函数被这次改动推过了阈值。
 * 改动前就已超阈值的函数是历史债：这次又变长也不提醒（不催 AI 顺手拆历史代码）。
 */
export function complexityIssues(file: string, rel: string, before: string | null, after: string | null, b: ControlConfig['budget']): { issues: ComplexityIssue[]; newFuncs: FuncInfo[] } {
  if (!supportsFunctions(rel) || !after) return { issues: [], newFuncs: [] };
  const old = new Map(extractFunctions(rel, before).map((f) => [f.key, f]));
  const issues: ComplexityIssue[] = [];
  const newFuncs: FuncInfo[] = [];
  const crossed = (o: number | undefined, n: number, limit: number) => n > limit && (o === undefined || o <= limit);
  for (const f of extractFunctions(rel, after)) {
    const o = old.get(f.key);
    if (!o) newFuncs.push(f);
    if (crossed(o?.lines, f.lines, b.funcLines)) issues.push({ file, func: f.name, line: f.line, kind: 'lines', value: f.lines, limit: b.funcLines });
    if (crossed(o?.nesting, f.nesting, b.nesting)) issues.push({ file, func: f.name, line: f.line, kind: 'nesting', value: f.nesting, limit: b.nesting });
    if (crossed(o?.params, f.params, b.params)) issues.push({ file, func: f.name, line: f.line, kind: 'params', value: f.params, limit: b.params });
  }
  return { issues, newFuncs };
}

/** 去掉注释与空白后的行；空串 = 纯注释 / 空行 */
function normalize(line: string): string {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/^\s*(#|\*|\/\*|\*\/).*$/, '')
    .replace(/\s+/g, '');
}

/** 只改空白、格式、注释、import 顺序的片段 */
export function isNoise(h: Hunk): boolean {
  if (!h.removed.length && !h.added.length) return false;
  const r = h.removed.map(normalize).filter(Boolean).sort();
  const a = h.added.map(normalize).filter(Boolean).sort();
  if (!r.length && !a.length) return h.removed.length > 0 || h.added.some((l) => l.trim().length > 0);
  if (!h.removed.length) return false; // 纯新增的代码不是噪声
  return r.length === a.length && r.every((x, i) => x === a[i]);
}

export function computeReceipt(changes: FileChange[], budget: ControlConfig['budget']): Receipt {
  const rc: Receipt = { files: [], added: 0, deleted: 0, newFiles: 0, newFuncs: 0, complexity: [], noise: [], outOfScope: [], noBaseline: [] };
  for (const c of changes) {
    if (c.outOfScope) rc.outOfScope.push(c.label);
    if (c.noBaseline) {
      rc.noBaseline.push(c.label);
      rc.files.push({ label: c.label, added: 0, deleted: 0, isNew: false, removed: false, outOfScope: !!c.outOfScope, noBaseline: true });
      continue;
    }
    if (c.before === c.after) continue;
    const hunks = diffLines(splitLines(c.before), splitLines(c.after));
    const added = hunks.reduce((n, h) => n + h.added.length, 0);
    const deleted = hunks.reduce((n, h) => n + h.removed.length, 0);
    const isNew = c.before === null && c.after !== null;
    rc.files.push({ label: c.label, added, deleted, isNew, removed: c.after === null, outOfScope: !!c.outOfScope, noBaseline: false });
    rc.added += added;
    rc.deleted += deleted;
    if (isNew && !isAuxFile(c.rel)) rc.newFiles++;
    if (!isNew) for (const h of hunks) if (isNoise(h)) rc.noise.push({ file: c.label, line: h.afterLine });
    const cx = complexityIssues(c.label, c.rel, c.before, c.after, budget);
    rc.complexity.push(...cx.issues);
    rc.newFuncs += cx.newFuncs.length;
  }
  return rc;
}

export interface ReceiptExtras {
  verify?: { status: 'pass' | 'fail' | 'none' | 'unconfigured'; cmds: string[] };
  expansions?: Array<{ added: string[]; reason: string }>;
  notes?: Array<{ text: string; file?: string }>;
  duplicates?: string[];
  atlasNote?: string;
}

/** 需要说明的项（会话内触发续跑一次；合并门里决定退出码） */
export function pendingItems(rc: Receipt, budget: ControlConfig['budget'], ex: ReceiptExtras, verifyCounts: boolean): string[] {
  const p: string[] = [];
  if (rc.outOfScope.length) p.push('越界文件：' + rc.outOfScope.join('、'));
  const net = rc.added - rc.deleted;
  if (net > budget.addedLines) p.push('净新增 ' + net + ' 行，超过预算 ' + budget.addedLines + ' 行');
  if (rc.newFiles > budget.newFiles) p.push('新建 ' + rc.newFiles + ' 个文件，超过预算 ' + budget.newFiles + ' 个');
  for (const c of rc.complexity) p.push('复杂度：' + complexityText(c));
  for (const d of ex.duplicates ?? []) p.push('疑似重复：' + d);
  for (const n of rc.noise) p.push('疑似顺手改格式 / 注释：' + n.file + ':' + n.line);
  if (verifyCounts && ex.verify && (ex.verify.status === 'none' || ex.verify.status === 'fail')) {
    p.push(ex.verify.status === 'fail' ? '验收命令最后一次没跑通' : '最后一次写入之后没跑验收命令');
  }
  return p;
}

export function renderReceipt(rc: Receipt, budget: ControlConfig['budget'], ex: ReceiptExtras, head = '[repo-guard]'): string {
  const touched = rc.files.length;
  const L: string[] = [];
  const scope = rc.outOfScope.length ? ' | 越界 ' + rc.outOfScope.length + ' 个（' + rc.outOfScope.join('、') + '）' : '';
  const exp = ex.expansions?.length ? ' | 扩范围 ' + ex.expansions.length + ' 次（' + ex.expansions.map((e) => e.added.join('、') + '：' + e.reason).join('；') + '）' : '';
  L.push(head + ' 改了 ' + touched + ' 个文件' + scope + exp);
  const net = rc.added - rc.deleted;
  const over = [net > budget.addedLines ? '净新增超预算 ' + budget.addedLines : '', rc.newFiles > budget.newFiles ? '新文件超预算 ' + budget.newFiles : ''].filter(Boolean);
  L.push('体量    新增 ' + rc.added + ' 行 / 删除 ' + rc.deleted + ' 行，新文件 ' + rc.newFiles + ' 个，新函数 ' + rc.newFuncs + ' 个' + (over.length ? '（' + over.join('，') + '）' : ''));
  L.push('复杂度  ' + (rc.complexity.length ? rc.complexity.map(complexityText).join('；') : '无超限'));
  L.push('复用    ' + (ex.atlasNote ? ex.atlasNote : ex.duplicates?.length ? 'atlas review 疑似重复：' + ex.duplicates.join('；') : 'atlas review：无疑似重复'));
  L.push('噪声    ' + (rc.noise.length ? rc.noise.length + ' 处只改格式 / 注释的片段：' + rc.noise.map((n) => n.file + ':' + n.line).join('、') : '0 处'));
  if (ex.verify) {
    const cmd = ex.verify.cmds.join(' && ');
    const v =
      ex.verify.status === 'unconfigured' ? '未配置验收命令'
        : ex.verify.status === 'pass' ? cmd + ' 通过（在最后一次写入之后）'
          : ex.verify.status === 'fail' ? cmd + ' 最后一次没跑通'
            : '未验证（最后一次写入之后没跑 ' + cmd + '）';
    L.push('验证    ' + v);
  }
  if (rc.noBaseline.length) L.push('无基线  ' + rc.noBaseline.join('、') + '（没有改动前的内容，未量增量）');
  if (ex.notes?.length) {
    L.push('顺手发现 ' + ex.notes.length + ' 条（未改）：');
    for (const n of ex.notes) L.push('  - ' + (n.file ? n.file + '：' : '') + n.text);
  }
  return L.join('\n');
}