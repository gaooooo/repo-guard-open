/**
 * 词法分析器共用工具（Go / Java 分析器的底座）。
 *
 * ── 为什么 Go 和 Java 走词法而不是像 Python 那样起子进程 ──
 * python-ast 能起子进程，前提是**目标语言的解析器是它自己的标准库**：容器里有
 * python3 就一定有 `ast`。Go 和 Java 没有这个便利：
 *   · Go 的 `go/ast` 要求装 Go 工具链，且得先把分析程序编译出来
 *   · Java 要 JDK + javaparser 之类的 jar
 * 把「能不能建图」绑死在「容器里装没装 JDK」上，失败模式会退回 ADR-051 最想消灭的
 * 那一种：环境差一点就静默拿不到图。
 *
 * 而这两门语言恰好**特别适合词法处理**：import 是显式且无歧义的声明，
 * 函数/方法/类型声明有固定前缀关键字，路由是注解或链式调用的字面量。
 * 拿不到的是类型推导（Java 的 DI 注入、Go 的接口动态派发）——
 * 那部分**如实写进 blindSpots**，而不是假装看得见。
 *
 * ── 这里为什么必须有一个正经的扫描器 ──
 * 直接对源码跑正则会在两个地方出错，而且都是静默出错：
 *   ① 注释掉的代码被当成真代码（`// r.GET("/legacy")` 会变成一条不存在的路由）
 *   ② 字符串里的 `//` 会被当成注释起点，把后面半行吃掉
 * 所以先做一遍**同时认字符串与注释**的单趟扫描，把注释与**字符串内容**都抹成空格
 *（保留长度与换行，行号列号都不偏；引号本身留着，便于定位）。
 *
 * ── 为什么字符串内容也必须抹掉 ──
 * 实测踩到：Go 反引号原始字符串里写着 `func Fake()` 作为示例文本，结果被函数声明
 * 正则当成真函数收进了图。字符串里出现关键字是很正常的事（SQL、模板、错误信息、
 * 文档示例），不抹就等于让任意文本参与结构匹配。
 * 抹掉不影响取路由路径：所有字面量都用 masked 上的下标回到**原文**里取。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 与 node-babel 保持同一套跳过目录，另加 Go/Java 生态的产物目录 */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'target', 'build', 'dist', 'out',
  'logs', 'coverage', '.idea', '__pycache__', '.next', 'files', 'public',
  '.gradle', '.mvn', 'bin', 'obj', 'testdata', '.settings',
]);

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 单仓文件上限：超过只保模块级依赖，防大仓把内存吃满 */
export const MAX_FILES = 8000;

export interface WalkOpts {
  /** 相对仓库根的前缀，如 `agent/`。只匹配该前缀，不按目录名全局跳过。 */
  extraSkipPrefixes?: string[];
  /** 相对路径的根。缺省为第一次调用的 dir */
  root?: string;
}

function matchesSkipPrefix(rel: string, prefixes?: string[]): boolean {
  if (!prefixes?.length) return false;
  const n = rel.replace(/\\/g, '/');
  return prefixes.some((raw) => {
    const p = String(raw ?? '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/+$/, '');
    if (!p) return false;
    return n === p || n.startsWith(`${p}/`);
  });
}

export function walkFiles(
  dir: string,
  exts: string[],
  depth = 0,
  out: string[] = [],
  opts?: WalkOpts,
): string[] {
  if (depth > 12 || out.length >= MAX_FILES) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const root = opts?.root ?? dir;
  for (const e of entries) {
    if (out.length >= MAX_FILES) break;
    if (e.name.startsWith('.') && e.name !== '.') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    const rel = path.relative(root, p).split(path.sep).join('/');
    if (matchesSkipPrefix(rel, opts?.extraSkipPrefixes)) continue;
    if (e.isDirectory()) walkFiles(p, exts, depth + 1, out, { ...opts, root });
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

export interface ScanOptions {
  /** 反引号原始字符串（Go），内部不处理转义、可跨行 */
  backtickStrings?: boolean;
  /** 三引号文本块（Java 15+ text block） */
  tripleQuoteStrings?: boolean;
  /** 单引号是字符字面量（Go rune / Java char），不是字符串 */
  charLiterals?: boolean;
}

/**
 * 把注释与字符串内容抹成等长空白（引号保留）。
 *
 * 返回值与输入**等长**且换行位置不变 —— 调用方可以拿 masked 上的下标直接去
 * 原文里取字符串内容，也可以用换行数直接算行号。这是本模块所有正则匹配的前提：
 * **在 masked 上找结构，在原文里取字面量**。
 *
 * 顺带的好处：字符串里的括号也被抹掉了，`matchParen` 不会再被
 * `f("a)b")` 这种字面量里的右括号带偏。
 */
export function maskComments(src: string, opts: ScanOptions = {}): string {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    // 行注释
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    // 块注释（Java 的 /** */ 也走这里）
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, n));
      i = j + 2;
      continue;
    }
    // 三引号文本块：必须排在双引号前面，否则会被当成一个空串加一个开引号
    if (opts.tripleQuoteStrings && c === '"' && next === '"' && src[i + 2] === '"') {
      let j = i + 3;
      while (j < n && !(src[j] === '"' && src[j + 1] === '"' && src[j + 2] === '"')) {
        if (src[j] === '\\') j++;
        j++;
      }
      blank(i + 3, j);
      i = j + 3;
      continue;
    }
    // 双引号字符串：抹内容留引号
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"' && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    // Go 原始字符串：可跨行、内部无转义。blank 会保留换行，行号不偏
    if (opts.backtickStrings && c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== '`') j++;
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    // 字符字面量：'\'' 这种要按转义跳，否则会把后面整段当字符串吞掉
    if (opts.charLiterals && c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== "'" && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** 预计算每行起始下标，供 offsetToLine 做二分。O(n) 一次，之后每次 O(log n) */
export function lineIndex(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

/** 字符下标 → 1-based 行号 */
export function offsetToLine(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * 从 `(` 开始取出第一个字符串实参的内容。
 *
 * 用于 `r.GET("/api/users", h)` 与 `@GetMapping("/x")` 这类取路径。
 * 只认紧邻的字面量：拼接出来的路径（`"/api/"+ver`）返回 null —— 那是真看不见，
 * 与其猜一个半截路径进图，不如让它缺席并写进 blindSpots。
 */
export function firstStringArg(src: string, openParen: number): string | null {
  let i = openParen + 1;
  while (i < src.length && /\s/.test(src[i])) i++;
  const q = src[i];
  if (q !== '"' && q !== '`') return null;
  let j = i + 1;
  let val = '';
  while (j < src.length && src[j] !== q) {
    if (q === '"' && src[j] === '\\') {
      j++;
      val += src[j] ?? '';
    } else {
      val += src[j];
    }
    j++;
  }
  // 后面跟的必须是 , 或 ) —— 否则说明这是拼接表达式的头一截，不是完整路径
  let k = j + 1;
  while (k < src.length && /\s/.test(src[k])) k++;
  if (src[k] !== ',' && src[k] !== ')') return null;
  return val;
}

/**
 * 按顶层逗号拆实参（depth=0）。`filter.Access(a, b), handler.Foo` 不能用 split(',')。
 */
export function splitTopLevelArgs(src: string, openParen: number, closeParen: number): string[] {
  if (closeParen <= openParen) return [];
  const inner = src.slice(openParen + 1, closeParen);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = inner.slice(start).trim();
  if (last) out.push(last);
  return out;
}

/**
 * 路由的 handler：最后一个「不是调用」的选择子。
 * `mux.POST("/x", mw.Foo(), pkg.Bar)` → pkg.Bar（跳过中间件调用）。
 */
export function lastHandlerSelector(args: string[]): string | null {
  for (let i = args.length - 1; i >= 1; i--) {
    const a = args[i].trim();
    if (!a) continue;
    if (a.includes('(')) continue;
    if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(a)) return a;
  }
  return null;
}

/** 文件级 `name = "/path"` 字符串常量（云 API 入口常用 yApiPath = "/yunApi"） */
export function collectSlashStringConsts(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\b([A-Za-z_]\w*)\s*=\s*"(\/[^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.set(m[1], m[2]);
  return out;
}

/** 找到与 openParen 配对的右括号下标；不配对返回 -1 */
export function matchParen(src: string, openParen: number): number {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 把两段 URL 前缀拼起来，规避 `/api` + `/users` 变成 `/api//users` */
export function joinPath(prefix: string, sub: string): string {
  const a = (prefix || '').replace(/\/+$/, '');
  const b = (sub || '').replace(/^\/+/, '');
  if (!a && !b) return '/';
  if (!b) return a || '/';
  return `${a}/${b}`;
}
