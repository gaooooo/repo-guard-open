/**
 * go-gin 分析器 —— Go 仓库建图（Gin / Echo / Chi / gorilla-mux 路由）。
 *
 * ── 为什么 Go 走词法而不是 go/ast ──
 * 见 lexical-utils.ts 头注释：`go/ast` 要求容器里装 Go 工具链并先编译出分析程序，
 * 把「能不能建图」绑死在环境上。而 Go 的语法对词法分析格外友好：
 *   · import 是显式块，别名规则简单，没有 JS 那种运行时 require
 *   · `func` / `type X struct` 是无歧义的声明前缀
 *   · **导出与否是语言层事实**（首字母大写），不像 Python 的下划线只是约定
 * 所以除了类型推导，Go 图谱的关键信息词法都能拿到。
 *
 * ── 一个刻意的取舍：包级 import 展开成文件级边 ──
 * Go 的 import 单位是**包（目录）**而非文件，而 CodeGraph.modules[].imports 是文件级。
 * 这里把 `import "mod/internal/svc"` 展开成该目录下所有 .go 文件的边。
 * 语义上是对的（你无法只 import 包里的一个文件），代价是边数会比 JS 仓多。
 */
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../../engine/shims/logger.js';

import type { AnalyzeOptions, GraphAnalyzer, DetectResult } from '../analyzer.js';
import {
  emptyGraph, type CodeGraph, type ModuleNode, type ClassNode,
  type FunctionNode, type CallEdge, type RouteNode, type FieldNode, type LiteralRef,
} from '../types.js';
import {
  walkFiles, maskComments, lineIndex, offsetToLine, firstStringArg,
  matchParen, joinPath, MAX_FILE_BYTES, splitTopLevelArgs, lastHandlerSelector,
  collectSlashStringConsts,
  SKIP_DIRS,
} from './lexical-utils.js';

const logger = createLogger('graph:go-gin');

const WEB_FRAMEWORKS = [
  'github.com/gin-gonic/gin', 'github.com/labstack/echo', 'github.com/go-chi/chi',
  'github.com/gorilla/mux', 'github.com/gofiber/fiber',
];
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'ANY'];
const MAX_WARNINGS = 30;

/** 读 go.mod 的 module 行 —— 它是判断"这条 import 是不是本仓"的唯一依据 */
function readModulePath(repoPath: string): string | null {
  try {
    const text = fs.readFileSync(path.join(repoPath, 'go.mod'), 'utf-8');
    const m = /^\s*module\s+(\S+)/m.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function detectGo(repoPath: string): Promise<DetectResult> {
  const goMod = path.join(repoPath, 'go.mod');
  let hasMod = false;
  let modText = '';
  try {
    if (fs.existsSync(goMod)) {
      hasMod = true;
      modText = fs.readFileSync(goMod, 'utf-8');
    }
  } catch {
    /* 读失败按没有处理，下面还会看 .go 文件 */
  }

  if (hasMod) {
    const hit = WEB_FRAMEWORKS.filter((k) => modText.includes(k));
    if (hit.length) {
      const names = hit.map((h) => h.split('/').pop()).join(' / ');
      return { confidence: 0.95, reason: `go.mod 依赖 ${names}，路由可识别` };
    }
    return { confidence: 0.7, reason: 'go.mod 存在但未识别 web 框架，可建依赖图（路由识别不可用）' };
  }

  const files = walkFiles(repoPath, ['.go']);
  if (files.length > 0) {
    return { confidence: 0.5, reason: `无 go.mod，但发现 ${files.length} 个 .go 文件` };
  }
  return { confidence: 0, reason: '未发现 go.mod 或 .go 文件' };
}

interface ImportInfo {
  /** 源码里用的名字（别名，或包路径最后一段） */
  alias: string;
  /** 完整 import 路径 */
  importPath: string;
}

/** 解析 import 块与单行 import。masked 上做结构匹配，原文里取路径字面量 */
function parseImports(masked: string, src: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  const push = (alias: string | undefined, p: string) => {
    if (!p) return;
    out.push({ alias: alias || p.split('/').pop() || p, importPath: p });
  };

  // import ( ... ) 块
  const blockRe = /\bimport\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(masked)) !== null) {
    const close = masked.indexOf(')', m.index);
    if (close < 0) continue;
    const body = src.slice(m.index, close);
    const lineRe = /^\s*(?:([A-Za-z_.][\w.]*)\s+)?"([^"]+)"/gm;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(body)) !== null) push(lm[1], lm[2]);
    blockRe.lastIndex = close;
  }
  // 单行 import "x" / import alias "x"
  const singleRe = /\bimport\s+(?:([A-Za-z_.][\w.]*)\s+)?"([^"]+)"/g;
  while ((m = singleRe.exec(src)) !== null) push(m[1], m[2]);
  return out;
}

/** 已下发 SDK / OAuth 契约里反复出现、即使不是 bson tag 也要建弱边的标识符 */
const CONTRACT_STRINGS = new Set(['error_description', 'ResourceID', 'AgentToken']);
const MAX_LITERAL_REFS = 8000;

function parseGoTags(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+):"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const val = m[2].split(',')[0].trim();
    if (val && val !== '-') out[m[1]] = val;
  }
  return out;
}

function ownerFromCtor(name: string): string | null {
  if (!name.startsWith('New') || name.length < 4) return null;
  return name.slice(3);
}

interface VarBind {
  dir: string;
  file?: string;
  owner?: string;
}

function parseStructFields(
  masked: string,
  src: string,
  starts: number[],
  file: string,
): FieldNode[] {
  const out: FieldNode[] = [];
  const re = /\btype\s+([A-Za-z_]\w*)\s+struct\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const brace = masked.indexOf('{', m.index);
    if (brace < 0) continue;
    let depth = 0;
    let k = brace;
    for (; k < masked.length; k++) {
      if (masked[k] === '{') depth++;
      else if (masked[k] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = src.slice(brace + 1, k);
    const fieldRe = /^[ \t]*([A-Za-z_]\w*)[ \t]+([^\n`]+?)(?:\s*`([^`]*)`)?\s*$/gm;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(body)) !== null) {
      if (/^(struct|interface|func|type)$/.test(fm[1])) continue;
      const abs = brace + 1 + fm.index;
      out.push({
        file,
        struct: m[1],
        name: fm[1],
        line: offsetToLine(starts, abs),
        tags: parseGoTags(fm[3] ?? ''),
        typeName: fm[2].trim() || undefined,
      });
    }
  }
  return out;
}

function pushLiteral(
  out: LiteralRef[],
  seen: Set<string>,
  ref: LiteralRef,
): void {
  if (out.length >= MAX_LITERAL_REFS) return;
  const k = `${ref.file}:${ref.line}:${ref.via}:${ref.value}`;
  if (seen.has(k)) return;
  seen.add(k);
  out.push(ref);
}

function scanValueHits(
  text: string,
  file: string,
  values: Set<string>,
  via: LiteralRef['via'],
  out: LiteralRef[],
  seen: Set<string>,
  maxPerValue = 40,
): void {
  if (!values.size || out.length >= MAX_LITERAL_REFS) return;
  const starts = lineIndex(text);
  for (const value of values) {
    if (value.length < 3) continue;
    const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let re: RegExp;
    try {
      re = via === 'dot' ? new RegExp(`\\.${esc}\\b`, 'g') : new RegExp(`\\b${esc}\\b`, 'g');
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(text)) !== null) {
      pushLiteral(out, seen, {
        value,
        file,
        line: offsetToLine(starts, m.index),
        via,
        tier: 'inferred',
      });
      n++;
      if (n >= maxPerValue || out.length >= MAX_LITERAL_REFS) break;
    }
    if (out.length >= MAX_LITERAL_REFS) return;
  }
}

function walkNonGo(dir: string, repoPath: string, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length >= 400) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkNonGo(p, repoPath, out, depth + 1);
    else if (/\.(js|mjs|cjs|ts|yaml|yml)$/.test(e.name)) out.push(p);
  }
  return out;
}

function homonymBlindSpot(functions: FunctionNode[]): string | null {
  const groups = new Map<string, Set<string>>();
  for (const f of functions) {
    if (f.form !== 'method' || !f.owner) continue;
    const dir = f.file.includes('/') ? f.file.slice(0, f.file.lastIndexOf('/')) : '.';
    const k = `${dir}#${f.name}`;
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k)!.add(f.file);
  }
  const multi = [...groups.entries()].filter(([, files]) => files.size > 1);
  if (!multi.length) return null;
  const [key, files] = multi.sort((a, b) => b[1].size - a[1].size)[0];
  const method = key.slice(key.lastIndexOf('#') + 1);
  const dir = key.slice(0, key.lastIndexOf('#'));
  return (
    `词法拿不到类型：${dir}/ 下同名方法 ${multi.length} 组有多份实现` +
    `（${method} 有 ${files.size} 个）。未消解接收器时 impact 可能高估。` +
    `请用 grep 核接收器变量名（如 agentRepo.${method}）。`
  );
}

export function buildGoGraph(repoPath: string, opts?: AnalyzeOptions): Promise<CodeGraph> {
  return Promise.resolve(buildGoGraphSync(repoPath, opts));
}

function buildGoGraphSync(repoPath: string, opts?: AnalyzeOptions): CodeGraph {
  const t0 = Date.now();
  const fallback = (msg: string): CodeGraph => ({
    ...emptyGraph(repoPath, 'go-gin'),
    warnings: [msg],
  });

  if (!repoPath) return fallback('未提供仓库路径');
  try {
    if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
      return fallback(`${repoPath} 不是有效目录`);
    }
  } catch (err) {
    return fallback(`检查目录失败：${(err as Error).message}`);
  }

  const modulePath = readModulePath(repoPath);
  const warnings: string[] = [];
  if (!modulePath) {
    warnings.push('未找到 go.mod 的 module 行 —— 无法判断哪些 import 属于本仓，依赖边会缺失');
  }

  // _test.go 不入图：测试是调用方而非被调方，混进来会让"这个函数还有人用吗"永远为真
  const files = walkFiles(repoPath, ['.go'], 0, [], {
    extraSkipPrefixes: opts?.skipDirs,
  }).filter((f) => !f.endsWith('_test.go'));
  if (files.length === 0) return fallback('仓库内没有 .go 文件（已排除 _test.go）');

  const modules = new Map<string, ModuleNode>();
  const classes: ClassNode[] = [];
  const functions: FunctionNode[] = [];
  const calls: CallEdge[] = [];
  const routes: RouteNode[] = [];
  const fields: FieldNode[] = [];
  const literalRefs: LiteralRef[] = [];
  const literalSeen = new Set<string>();
  let parseFailed = 0;

  /** 目录（相对仓库根）→ 该目录下的 .go 文件，用于把包级 import 展开成文件级边 */
  const filesByDir = new Map<string, string[]>();
  for (const abs of files) {
    const rel = path.relative(repoPath, abs).split(path.sep).join('/');
    const dir = path.posix.dirname(rel);
    if (!filesByDir.has(dir)) filesByDir.set(dir, []);
    filesByDir.get(dir)!.push(rel);
  }

  interface Parsed { rel: string; src: string; masked: string; starts: number[]; imports: ImportInfo[] }
  const parsed: Parsed[] = [];

  for (const abs of files) {
    const rel = path.relative(repoPath, abs).split(path.sep).join('/');
    let src: string;
    try {
      if (fs.statSync(abs).size > MAX_FILE_BYTES) {
        parseFailed++;
        if (warnings.length < MAX_WARNINGS) warnings.push(`${rel} 超过 2MB，已跳过`);
        continue;
      }
      src = fs.readFileSync(abs, 'utf-8');
    } catch (err) {
      parseFailed++;
      if (warnings.length < MAX_WARNINGS) warnings.push(`${rel} 读取失败：${(err as Error).message}`);
      continue;
    }
    const masked = maskComments(src, { backtickStrings: true, charLiterals: true });
    const starts = lineIndex(src);
    const imports = parseImports(masked, src);
    parsed.push({ rel, src, masked, starts, imports });
    modules.set(rel, { file: rel, imports: [], importedBy: [], symbolCount: 0 });
  }

  // ── 依赖边：import 路径 → 本仓目录 → 该目录全部 .go 文件 ──
  for (const p of parsed) {
    const mod = modules.get(p.rel)!;
    for (const im of p.imports) {
      if (!modulePath || !im.importPath.startsWith(modulePath)) continue;
      const sub = im.importPath.slice(modulePath.length).replace(/^\//, '');
      const dir = sub || '.';
      for (const target of filesByDir.get(dir) ?? []) {
        if (target !== p.rel && !mod.imports.includes(target)) mod.imports.push(target);
      }
    }
  }

  // ── 类型（struct / interface）──
  for (const p of parsed) {
    const re = /\btype\s+([A-Z_a-z]\w*)\s+(struct|interface)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p.masked)) !== null) {
      classes.push({
        name: m[1],
        file: p.rel,
        line: offsetToLine(p.starts, m.index),
        kind: 'class',
        methods: [],
      });
    }
    fields.push(...parseStructFields(p.masked, p.src, p.starts, p.rel));
  }

  // ── 函数与方法 ──
  // func (r *Repo) Find(...)  → 方法，owner=Repo
  // func NewRepo(...)         → 顶层函数
  for (const p of parsed) {
    const re = /\bfunc\s+(?:\(\s*\w+\s+\*?([A-Za-z_]\w*)\s*\)\s*)?([A-Za-z_]\w*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p.masked)) !== null) {
      const owner = m[1] ?? null;
      const name = m[2];
      const line = offsetToLine(p.starts, m.index);
      // 函数体结束行：从签名后的 { 起做花括号配平；配不平就退回签名行
      let endLine = line;
      const brace = p.masked.indexOf('{', m.index);
      if (brace >= 0) {
        let depth = 0;
        let k = brace;
        for (; k < p.masked.length; k++) {
          if (p.masked[k] === '{') depth++;
          else if (p.masked[k] === '}') {
            depth--;
            if (depth === 0) break;
          }
        }
        endLine = offsetToLine(p.starts, Math.min(k, p.masked.length - 1));
      }
      functions.push({
        name,
        file: p.rel,
        line,
        endLine,
        // Go 的导出是语言层规则（首字母大写），不是命名约定 —— 这一条比 Python 可靠
        exported: /^[A-Z]/.test(name),
        owner,
        form: owner ? 'method' : 'function',
      });
      if (owner) {
        const cls = classes.find((c) => c.file === p.rel && c.name === owner);
        if (cls && !cls.methods.includes(name)) cls.methods.push(name);
      }
    }
  }

  /**
   * 同包的「接口变量 → 实现所在目录」。
   * `var agentLogic logic.AgentLogic` + `agentLogic = logic.NewAgentLogicImpl()`
   * 使得 `agentLogic.DescribeAgent()` 能折到 internal/logic，而不是 toFile=null。
   */
  const pkgVarDir = new Map<string, Map<string, VarBind>>();
  for (const p of parsed) {
    const pkgDir = path.posix.dirname(p.rel);
    const aliasToDir = new Map<string, string>();
    for (const im of p.imports) {
      if (!modulePath || !im.importPath.startsWith(modulePath)) continue;
      aliasToDir.set(im.alias, im.importPath.slice(modulePath.length).replace(/^\//, '') || '.');
    }
    if (!pkgVarDir.has(pkgDir)) pkgVarDir.set(pkgDir, new Map());
    const vars = pkgVarDir.get(pkgDir)!;
    const typeRe = /\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\.[A-Za-z_]\w*/g;
    let tm: RegExpExecArray | null;
    while ((tm = typeRe.exec(p.masked)) !== null) {
      const dir = aliasToDir.get(tm[2]);
      if (dir) vars.set(tm[1], { dir });
    }
    // `agentRepo = localRepo.NewAgentRepoImpl()` / `:=`：绑到构造函数所在文件，而不是整个包
    const asgRe = /\b([A-Za-z_]\w*)\s*:?=\s*([A-Za-z_]\w*)\.(New[A-Za-z_]\w*)\s*\(/g;
    while ((tm = asgRe.exec(p.masked)) !== null) {
      const dir = aliasToDir.get(tm[2]);
      if (!dir) continue;
      const ctor = tm[3];
      const owner = ownerFromCtor(ctor);
      const ctorFn = functions.find(
        (f) => f.name === ctor && (f.file === dir || f.file.startsWith(`${dir}/`)),
      );
      vars.set(tm[1], { dir, file: ctorFn?.file, owner: owner ?? undefined });
    }
  }

  const resolveToFile = (dir: string | undefined, method: string, bind?: VarBind): string | null => {
    if (!dir && !bind?.file) return null;
    if (bind?.file) {
      const same = functions.find((f) => f.file === bind.file && f.name === method);
      if (same) return same.file;
      if (bind.owner) {
        const byOwner = functions.find(
          (f) =>
            f.name === method &&
            f.owner === bind.owner &&
            (f.file === dir || (dir ? f.file.startsWith(`${dir}/`) : false)),
        );
        if (byOwner) return byOwner.file;
      }
    }
    if (!dir) return null;
    const hits = functions.filter(
      (f) => f.name === method && (f.file === dir || f.file.startsWith(`${dir}/`)),
    );
    if (hits.length === 1) return hits[0].file;
    // 多个同名实现：禁止猜成第一个。解析不到就留空。
    if (hits.length > 1) return null;
    return filesByDir.get(dir)?.length === 1 ? filesByDir.get(dir)![0] : null;
  };

  // ── 调用边：pkg.Fn(...) / recv.Method(...) ──
  for (const p of parsed) {
    const aliasToDir = new Map<string, string>();
    for (const im of p.imports) {
      if (!modulePath || !im.importPath.startsWith(modulePath)) continue;
      aliasToDir.set(im.alias, im.importPath.slice(modulePath.length).replace(/^\//, '') || '.');
    }
    const localVars = pkgVarDir.get(path.posix.dirname(p.rel));
    const fnsInFile = functions.filter((f) => f.file === p.rel).sort((a, b) => a.line - b.line);
    const re = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p.masked)) !== null) {
      const line = offsetToLine(p.starts, m.index);
      // 【移植偏差 · 仅类型层】把 m[1] / m[2] 提成局部常量。
      // 原文在下面的 .find / .filter 回调里直接用 m[x]，而 TS 在回调内会丢掉
      // while 条件对 `m` 的非空收窄（TS18047，deerclaw 里也报，属既有问题）。
      // 提取后语义完全一致 —— 回调是同步执行的，m 在这一轮内不会变。
      const obj = m[1];
      const meth = m[2];
      const enclosing = fnsInFile.filter((f) => f.line <= line && line <= f.endLine).pop();
      const bind = localVars?.get(obj);
      let dir = aliasToDir.get(obj) ?? bind?.dir;
      if (!dir && enclosing?.owner) {
        const field = fields.find((f) => f.struct === enclosing.owner && f.name === obj && f.typeName);
        const pkg = field?.typeName?.match(/\b([A-Za-z_]\w*)\.[A-Za-z_]/)?.[1];
        if (pkg) dir = aliasToDir.get(pkg);
      }
      let toFile = resolveToFile(dir, meth, bind);
      if (!toFile && enclosing?.owner && !aliasToDir.has(obj)) {
        const same = functions.filter(
          (f) => f.name === meth && f.owner === enclosing.owner && (f.file === p.rel || path.posix.dirname(f.file) === path.posix.dirname(p.rel)),
        );
        if (same.length === 1) toFile = same[0].file;
      }
      calls.push({
        fromFile: p.rel,
        fromFn: enclosing?.name ?? '<top>',
        toObj: m[1],
        toMethod: m[2],
        toFile,
        line,
        kind: 'call',
        tier: 'extracted',
      });
    }
  }

  const firstPathArg = (src: string, open: number, consts: Map<string, string>): string | null => {
    const lit = firstStringArg(src, open);
    if (lit !== null) return lit;
    let i = open + 1;
    while (i < src.length && /\s/.test(src[i])) i++;
    const id = /^([A-Za-z_]\w*)/.exec(src.slice(i));
    if (!id) return null;
    const v = consts.get(id[1]);
    return v && v.startsWith('/') ? v : null;
  };

  // ── 路由 ──
  for (const p of parsed) {
    const fileConsts = collectSlashStringConsts(p.src);
    const aliasToDir = new Map<string, string>();
    for (const im of p.imports) {
      if (!modulePath || !im.importPath.startsWith(modulePath)) continue;
      aliasToDir.set(im.alias, im.importPath.slice(modulePath.length).replace(/^\//, '') || '.');
    }

    // 先扫 Group 前缀：v1 := r.Group("/api/v1")
    const groupPrefix = new Map<string, string>();
    const gRe = /\b(\w+)\s*:?=\s*(\w+)\.Group\s*\(/g;
    let gm: RegExpExecArray | null;
    while ((gm = gRe.exec(p.masked)) !== null) {
      const open = p.masked.indexOf('(', gm.index + gm[0].length - 1);
      const lit = firstStringArg(p.src, open);
      if (lit === null) continue;
      groupPrefix.set(gm[1], joinPath(groupPrefix.get(gm[2]) ?? '', lit));
    }

    const fnsInFile = functions.filter((f) => f.file === p.rel).sort((a, b) => a.line - b.line);
    const routesFromFile: RouteNode[] = [];
    // Gin/Echo 用 .GET；Chi 用 .Get —— 两种大小写都认
    const rRe = /\b(\w+)\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|Get|Post|Put|Delete|Patch|Head|Options|HandleFunc)\s*\(/g;
    let rm: RegExpExecArray | null;
    while ((rm = rRe.exec(p.masked)) !== null) {
      const open = rm.index + rm[0].length - 1;
      const lit = firstPathArg(p.src, open, fileConsts);
      if (lit === null || !lit.startsWith('/')) continue;
      const line = offsetToLine(p.starts, rm.index);
      const close = matchParen(p.masked, open);
      const args = close > open ? splitTopLevelArgs(p.src, open, close) : [];
      const sel = lastHandlerSelector(args);
      // 匿名 func 做 Rewrite 分发的不算 handler；网关入口由后面那一趟补
      if (!sel) continue;
      const handlerFn = sel.split('.').pop() ?? '';
      const handlerPkg = sel.includes('.') ? sel.split('.')[0] : '';
      const handlerDir = handlerPkg ? aliasToDir.get(handlerPkg) : undefined;
      const target = handlerFn
        ? functions.find(
            (f) => f.name === handlerFn && (!handlerDir || f.file === handlerDir || f.file.startsWith(`${handlerDir}/`)),
          ) ?? functions.find((f) => f.name === handlerFn)
        : undefined;

      let method = rm[2].toUpperCase();
      if (method === 'HANDLEFUNC') {
        // gorilla/mux：.HandleFunc("/x", h).Methods("GET")
        const after = p.src.slice(close, close + 120);
        method = /\.Methods\s*\(\s*"([A-Z]+)"/.exec(after)?.[1] ?? 'ANY';
      }
      if (!HTTP_METHODS.includes(method)) method = 'ANY';

      routesFromFile.push({
        method,
        urlPath: joinPath(groupPrefix.get(rm[1]) ?? '', lit),
        middlewares: [],
        handlerFile: target?.file ?? null,
        handlerFn,
        file: p.rel,
        line,
        // 路由由链式调用的字面量识别，未经类型确认，与 AST 直读的符号不同级
        tier: 'inferred',
      });
    }

    // 云 API 网关：const 路径 POST + Rewrite(fmt.Sprintf("/api/%s/%s", version, action))
    // 同一函数里 Group("/api/v1") 的字面量 POST 就是真实 action。登记网关入口，
    // 并把各 action 标上 X-TC-Action，handler 仍指向具名函数（调用链另走）。
    for (const fn of fnsInFile) {
      const body = p.src.split(/\n/).slice(fn.line - 1, fn.endLine).join('\n');
      if (!/\.Rewrite\s*\(/.test(body) || !/\/api\/%s\/%s/.test(body)) continue;
      let gwPath: string | null = null;
      const postIdent = /\.POST\s*\(\s*([A-Za-z_]\w*)\s*,/.exec(body);
      if (postIdent && fileConsts.has(postIdent[1])) gwPath = fileConsts.get(postIdent[1]) ?? null;
      if (!gwPath) {
        const hit = [...fileConsts.entries()].find(([, v]) => body.includes(`"${v}"`) || body.includes(v));
        if (hit) gwPath = hit[1];
      }
      if (!gwPath) continue;

      const dispatched = routesFromFile.filter(
        (r) => r.line >= fn.line && r.line <= fn.endLine && r.urlPath.startsWith('/api/'),
      );
      for (const r of dispatched) {
        const action = r.urlPath.split('/').pop() ?? '';
        if (action && !r.middlewares.includes('X-TC-Action')) {
          r.middlewares.push(`X-TC-Action:${action}`);
          r.middlewares.push(`via ${gwPath}`);
        }
      }

      const synName = `<gateway:${gwPath}>`;
      functions.push({
        name: synName,
        file: p.rel,
        line: fn.line,
        endLine: fn.endLine,
        exported: false,
        owner: null,
        form: 'function',
      });
      for (const r of dispatched) {
        if (!r.handlerFile || !r.handlerFn) continue;
        calls.push({
          fromFile: p.rel,
          fromFn: synName,
          toObj: null,
          toMethod: r.handlerFn,
          toFile: r.handlerFile,
          line: r.line,
          kind: 'call',
          tier: 'inferred',
        });
      }
      routesFromFile.push({
        method: 'POST',
        urlPath: gwPath,
        middlewares: ['X-TC-Action → /api/v1/{action}'],
        handlerFile: p.rel,
        handlerFn: synName,
        file: p.rel,
        line: fn.line,
        tier: 'extracted',
      });
    }

    routes.push(...routesFromFile);
  }

  // ── 字段 tag / 点号访问 / 契约字符串弱边（不进 CallEdge）──
  const tagValues = new Set<string>(CONTRACT_STRINGS);
  const fieldNames = new Set<string>();
  for (const f of fields) {
    fieldNames.add(f.name);
    for (const v of Object.values(f.tags)) {
      if (v.length >= 3) tagValues.add(v);
      pushLiteral(literalRefs, literalSeen, {
        value: v,
        file: f.file,
        line: f.line,
        via: 'tag',
        tier: 'inferred',
      });
    }
  }
  // template 必须先扫：全仓 bson tag 的字符串命中很容易把 8000 上限占满，
  // 后扫会丢已下发 SDK 的弱边。
  const templateDir = path.join(repoPath, 'template');
  if (fs.existsSync(templateDir) && fs.statSync(templateDir).isDirectory()) {
    for (const abs of walkNonGo(templateDir, repoPath)) {
      let text: string;
      try {
        if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
        text = fs.readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      const rel = path.relative(repoPath, abs).split(path.sep).join('/');
      scanValueHits(text, rel, tagValues, 'string', literalRefs, literalSeen);
    }
  }
  const goStringKeys = new Set(
    [...tagValues].filter((v) => v.length >= 5 || CONTRACT_STRINGS.has(v) || v.includes('_')),
  );
  for (const p of parsed) {
    scanValueHits(p.src, p.rel, fieldNames, 'dot', literalRefs, literalSeen);
    scanValueHits(p.src, p.rel, goStringKeys, 'string', literalRefs, literalSeen);
  }

  // ── 回填反向边与 symbolCount ──
  for (const m of modules.values()) {
    for (const dep of m.imports) {
      const t = modules.get(dep);
      if (t && !t.importedBy.includes(m.file)) t.importedBy.push(m.file);
    }
  }
  for (const fn of functions) {
    const m = modules.get(fn.file);
    if (m) m.symbolCount++;
  }

  // ── 路由 → service 追通率 ──
  let traced = 0;
  for (const r of routes) {
    if (!r.handlerFile) continue;
    const target = functions.find((f) => f.file === r.handlerFile && f.name === r.handlerFn);
    if (!target) continue;
    const inner = calls.some(
      (c) => c.fromFile === r.handlerFile && c.line >= target.line && c.line <= target.endLine && c.toFile,
    );
    if (inner) traced++;
  }

  const blindSpots = [
    'import 单位是包（目录），已展开成该目录全部 .go 文件的边 —— 边比实际略宽，不代表每个文件都被用到',
    '接口的动态派发看不见：通过 interface 调用时，真正跑的实现不在图里',
    '拼接出来的路由路径（fmt.Sprintf / 变量拼接）识别不了；但「常量路径 + Rewrite 到 /api/v1/{action}」会登记网关入口（如 POST /yunApi）',
    '`_test.go` 不入图 —— "没有调用方"不代表没有测试在用',
    '词法分析拿不到类型信息：同名方法归属哪个类型靠接收器字面量判断，跨包同名可能串',
    'bson/json tag 与字符串键是弱边（inferred），改字段名请再 grep 核对 filter["..."] 与 template/ SDK',
  ];
  const homonym = homonymBlindSpot(functions);
  if (homonym) blindSpots.push(homonym);
  if (!modulePath) blindSpots.push('本仓无 go.mod module 声明，仓内依赖边整体缺失');
  if (opts?.skipDirs?.length) {
    blindSpots.push(`主图已排除 ${opts.skipDirs.join('、')}（独立交付物，不与主服务揉进同一张 impact）`);
  }

  const buildMs = Date.now() - t0;
  logger.info(
    { repoPath, files: parsed.length, functions: functions.length, routes: routes.length, ms: buildMs },
    'go graph built',
  );

  return {
    ok: true,
    repoDir: repoPath,
    modules: [...modules.values()],
    classes,
    functions,
    calls,
    routes,
    stats: {
      files: parsed.length,
      parseFailed,
      modules: modules.size,
      classes: classes.length,
      functions: functions.length,
      exportedFunctions: functions.filter((f) => f.exported).length,
      calls: calls.length,
      resolvedCalls: calls.filter((c) => c.toFile).length,
      routes: routes.length,
      routesTracedToService: traced,
      buildMs,
    },
    warnings,
    builtAt: Date.now(),
    analyzer: 'go-gin',
    blindSpots,
    fields,
    literalRefs,
  };
}

export const goGinAnalyzer: GraphAnalyzer = {
  name: 'go-gin',
  label: 'Go（Gin / Echo / Chi）',
  language: 'go',
  frameworks: ['gin', 'echo', 'chi', 'gorilla-mux'],
  extensions: ['.go'],
  detect: detectGo,
  analyze: (repoPath, opts) => buildGoGraph(repoPath, opts),
};

/**
 * tRPC-Go 仓与 Gin 仓共用同一套词法扫描（不另写解析器）。
 * 单独挂名是为了标签别把「本仓无 gin」的服务标成 go-gin，让人误判能力边界。
 * 路由识别能力与 go-gin 相同；云 API「常量路径 + Rewrite」的网关入口由同一套扫描补上。
 */
async function detectTrpcGo(repoPath: string): Promise<DetectResult> {
  const goMod = path.join(repoPath, 'go.mod');
  try {
    if (!fs.existsSync(goMod)) return { confidence: 0, reason: '无 go.mod' };
    const text = fs.readFileSync(goMod, 'utf-8');
    if (/trpc-go\/trpc-go|git\.code\.oa\.com\/trpc-go/.test(text)) {
      return {
        confidence: 0.96,
        reason: 'go.mod 依赖 tRPC-Go；建图复用 Go 词法扫描（与 go-gin 同一实现，只改标签）',
      };
    }
  } catch {
    /* 读失败当没有 */
  }
  return { confidence: 0, reason: 'go.mod 未发现 tRPC-Go' };
}

export const goTrpcAnalyzer: GraphAnalyzer = {
  name: 'go-trpc',
  label: 'Go（tRPC-Go）',
  language: 'go',
  frameworks: ['trpc-go'],
  extensions: ['.go'],
  detect: detectTrpcGo,
  analyze: async (repoPath, opts) => {
    const g = await buildGoGraph(repoPath, opts);
    return { ...g, analyzer: 'go-trpc' };
  },
};
