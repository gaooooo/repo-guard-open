/**
 * 源码符号扫描器 —— 找出受保护标识符在代码里的全部出现位置。
 *
 * ── 为什么用词边界正则而不是 AST ──
 * 裸探测阶段我用 @babel/parser 追调用链，那确实需要 AST。但体检只需要回答
 * "这个标识符出现在哪些文件的哪些行"，正则就够，且有两个不可替代的好处：
 *
 *   ① **与运行时判定同源**。policy-engine 的 countOccurrences 用的就是词边界
 *      正则（`(^|[^A-Za-z0-9_])name([^A-Za-z0-9_]|$)`）。体检若用 AST，就会
 *      出现"体检说这里有引用、运行时却匹配不到"的分裂 —— 那比没有体检更糟。
 *   ② **跨语言**。同一套逻辑对 .js/.go/.java/.py 都成立。红线保护的是字段名、
 *      函数名、常量名这类**标识符**，不是语法结构。
 *
 *代价是注释里的标识符会被算进去。所以下面做了注释剥离（见 stripComments），
 * 并把注释命中单独标为 kind='comment' —— 不丢弃，因为"注释里提到某字段"
 * 有时正是它被弃用的线索，交给体检报告决定要不要计入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './shims/logger.js';

const logger = createLogger('code-scanner');

export interface CodeHit {
  /** 相对仓库根的路径 */
  file: string;
  line: number;
  /**
   * code—— 出现在有效代码里（体检以此为准）
   * comment —— 只出现在注释里（不计入覆盖度，但保留作线索）
   */
  kind: 'code' | 'comment';
  /** 该行原文（截断） */
  text: string;
}

export interface CodeIndex {
  ok: boolean;
  fileCount: number;
  /** 标识符 → 出现位置。key 保留原始大小写（代码标识符大小写敏感） */
  hits: Map<string, CodeHit[]>;
  warnings: string[];
  scannedAt: number;
}

const MAX_TEXT = 160;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 默认扫描的源码后缀。刻意不含 .sql —— 那是 sql-scanner 的活*/
const DEFAULT_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.java', '.py'];
/** 永不进入的目录。node_modules 之外还要排掉构建产物，否则会把压缩代码算进来 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'target', 'build', 'dist', 'out',
  'logs', 'coverage', '.idea', '.vscode', '__pycache__', '.next',
]);

/**
 * 把注释区间置为空格（保留行列位置，便于报告行号仍然准确）。
 *
 * 处理三种：`//` `#` 行注释、`/* *​/` 块注释。
 * 刻意**不处理字符串字面量** —— 因为数据库字段名恰恰经常出现在字符串里
 * （实测：`.where('is_delete', 0)`、SQL 拼接），把字符串剥掉会漏掉真实引用。
 */
function stripComments(src: string,ext: string): string {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  let inBlock = false;
  let inLine = false;
  // Python/Shell 用 #，其余用 //
  const hashComment = ext === '.py';

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (inBlock) {
      if (c === '*' && c2 === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        inBlock = false;
        continue;
      }
      if (c !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    if (inLine) {
      if (c === '\n') {
        inLine = false;
      } else {
        out[i] = ' ';
      }
      i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      inBlock = true;
      continue;
    }
    if (c === '/' && c2 === '/') {
      inLine = true;
      out[i] = ' ';
      i++;
      continue;
    }
    if (hashComment && c === '#') {
      inLine = true;
      out[i] = ' ';
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * 词边界匹配 —— 与 policy-engine.countOccurrences 完全一致的规则。
 * 这个一致性是刻意的：体检结论必须能预测运行时行为。
 */
function wordBoundaryRe(name: string): RegExp {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${esc}([^A-Za-z0-9_]|$)`);
}

function walk(dir: string, exts: string[], out: string[] = [], depth = 0): string[] {
  if (depth > 12) return out; // 防御异常深的目录树
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.knowledge') {
      if (SKIP_DIRS.has(e.name)) continue;
    }
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out, depth + 1);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

/**
 * 扫描仓库源码，建立指定标识符的位置索引。
 *
 * **只扫传入的 names**（而非索引全部标识符）：红线数量是个位数，
 * 受保护标识符最多几十个。全量索引 19046 个符号（实测 Java 规模）纯属浪费，
 * 而且会让内存占用不可控。
 *
 * 容错：全程不抛，最差返回 ok:false 空索引 —— 知识层故障绝不能阻塞 ReAct。
 */
export function scanCode(
  repoDir: string,
  names: string[],
  opts?: { exts?: string[] },
): CodeIndex {
  const empty: CodeIndex = {
    ok: false,
    fileCount: 0,
    hits: new Map(),
    warnings: [],
    scannedAt: Date.now(),
  };
  if (!repoDir || !names.length) return empty;

  const warnings: string[] = [];
  const exts = opts?.exts ?? DEFAULT_EXTS;
  const uniqueNames = [...new Set(names.filter((n) => n && n.length >= 2))];
  if (!uniqueNames.length) return { ...empty, ok: true };

  let files: string[];
  try {
    if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
      return { ...empty, warnings: [`${repoDir} 不是有效目录`] };
    }
    files = walk(repoDir, exts);
  } catch (err) {
    return { ...empty, warnings: [`枚举源码文件失败：${(err as Error).message}`] };
  }

  // 预编译正则，避免在文件×标识符的双层循环里重复构造
  const res = uniqueNames.map((n) => ({ name: n, re: wordBoundaryRe(n) }));
  const hits = new Map<string, CodeHit[]>();
  for (const n of uniqueNames) hits.set(n, []);

  let scanned = 0;
  for (const full of files) {
    const relPath = path.relative(repoDir, full).replace(/\\/g, '/');
    let raw: string;
    try {
      if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
      raw = fs.readFileSync(full, 'utf-8');
    } catch (err) {
      warnings.push(`${relPath} 读取失败：${(err as Error).message}`);
      continue;
    }
    scanned++;

    // 快速预筛：整份文件都不含任一标识符就跳过逐行扫描
    const candidates = res.filter((r) => raw.includes(r.name));
    if (!candidates.length) continue;

    const ext = path.extname(full);
    const stripped = stripComments(raw, ext);
    const rawLines = raw.split('\n');
    const strippedLines = stripped.split('\n');

    for (let i = 0; i < rawLines.length; i++) {
      const rawLine = rawLines[i];
      const codeLine = strippedLines[i] ?? '';
      for (const { name, re } of candidates) {
        if (!rawLine.includes(name)) continue;
        // 在剥掉注释的那份里还能匹配 → 是有效代码；否则只出现在注释里
        const inCode = re.test(codeLine);
        const inRaw = re.test(rawLine);
        if (!inRaw) continue; // 只是子串包含（如 corp_idx 含 corp_id），不算命中
        hits.get(name)!.push({
          file: relPath,
          line: i + 1,
          kind: inCode ? 'code' : 'comment',
          text: rawLine.trim().slice(0, MAX_TEXT),
        });
      }
    }
  }

  logger.info(
    { repoDir, files: scanned, names: uniqueNames.length },
    'code scan done',
  );

  return { ok: true, fileCount: scanned, hits, warnings, scannedAt: Date.now() };
}

/** 取某标识符的命中。`codeOnly=true` 时排除仅出现在注释里的 */
export function findInCode(index: CodeIndex, name: string, codeOnly = true): CodeHit[] {
  const all = index.hits.get(name) ?? [];
  return codeOnly ? all.filter((h) => h.kind === 'code') : all;
}
