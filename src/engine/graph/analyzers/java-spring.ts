/**
 * java-spring 分析器 —— Java 仓库建图（Spring MVC / JAX-RS 路由）。
 *
 * ── 为什么 Java 走词法而不是 jdtls / javaparser ──
 * 见 lexical-utils.ts 头注释：两者都要 JDK 在场，等于把「能不能建图」绑死在环境上。
 * Java 的**声明层**对词法极友好：package/import 是完全限定名、无别名、无通配歧义
 *（`import a.b.*` 除外，已写进盲区）；类与方法声明有固定修饰符前缀；
 * Spring 路由就是类上 `@RequestMapping` + 方法上 `@GetMapping` 的字面量。
 *
 * ── 但必须说清词法拿不到什么 ──
 * Java 图谱真正的卡点从来不是语法，而是**依赖注入**：`@Autowired UserService svc`
 * 声明的是接口，运行时注入的是某个 `UserServiceImpl`。词法只能看到接口名。
 * 这里的做法是：按**声明类型**连边并如实标注，而不是猜实现类 ——
 * 猜错的边比没有边危险得多（agent 会据此断言"改这个实现不影响任何接口"）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../../shims/logger.js';

import type { GraphAnalyzer, DetectResult } from '../analyzer.js';
import {
  emptyGraph, type CodeGraph, type ModuleNode, type ClassNode,
  type FunctionNode, type CallEdge, type RouteNode,
} from '../types.js';
import {
  walkFiles, maskComments, lineIndex, offsetToLine, firstStringArg,
  joinPath, MAX_FILE_BYTES,
} from './lexical-utils.js';

const logger = createLogger('graph:java-spring');

const MAX_WARNINGS = 30;
/** Java 关键字与常见控制流：`if (` 长得和方法声明一样，必须排除 */
const NOT_METHOD_NAMES = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'synchronized',
  'try', 'do', 'else', 'throw', 'assert', 'super', 'this',
]);
/** 注解 → HTTP 方法 */
const MAPPING_ANNOTATIONS: Record<string, string> = {
  GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT',
  DeleteMapping: 'DELETE', PatchMapping: 'PATCH',
};

async function detectJava(repoPath: string): Promise<DetectResult> {
  const buildFiles = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'];
  const found: string[] = [];
  let text = '';
  for (const f of buildFiles) {
    const p = path.join(repoPath, f);
    try {
      if (fs.existsSync(p)) {
        found.push(f);
        text += fs.readFileSync(p, 'utf-8').toLowerCase();
      }
    } catch {
      /* 单个构建文件读失败不影响整体判断 */
    }
  }

  if (found.length) {
    const hits: string[] = [];
    if (text.includes('spring-boot') || text.includes('springframework')) hits.push('Spring');
    if (text.includes('quarkus')) hits.push('Quarkus');
    if (text.includes('javax.ws.rs') || text.includes('jakarta.ws.rs') || text.includes('jersey')) hits.push('JAX-RS');
    if (hits.length) {
      return { confidence: 0.95, reason: `${found.join(' / ')} 含 ${hits.join(' / ')}，路由可识别` };
    }
    return {
      confidence: 0.7,
      reason: `发现 ${found.join(' / ')} 但未识别 web 框架，可建依赖图（路由识别不可用）`,
    };
  }

  const files = walkFiles(repoPath, ['.java']);
  if (files.length > 0) {
    return { confidence: 0.5, reason: `无 pom.xml / build.gradle，但发现 ${files.length} 个 .java 文件` };
  }
  return { confidence: 0, reason: '未发现 pom.xml / build.gradle 或 .java 文件' };
}

/** 取注解的路径字面量：@GetMapping("/x") 或 @RequestMapping(value = "/x", ...) */
function annotationPath(src: string, masked: string, atIndex: number): string | null {
  const open = masked.indexOf('(', atIndex);
  if (open < 0) return null;
  // 注解与括号之间只允许空白，否则这个 ( 属于后面的方法签名而非注解
  if (/[^\s]/.test(masked.slice(atIndex, open).replace(/^@\w+/, ''))) return null;
  const direct = firstStringArg(src, open);
  if (direct !== null) return direct;
  const close = masked.indexOf(')', open);
  const body = src.slice(open, close < 0 ? open + 200 : close);
  return /(?:value|path)\s*=\s*"([^"]*)"/.exec(body)?.[1] ?? null;
}

export function buildJavaGraph(repoPath: string): Promise<CodeGraph> {
  return Promise.resolve(buildJavaGraphSync(repoPath));
}

function buildJavaGraphSync(repoPath: string): CodeGraph {
  const t0 = Date.now();
  const fallback = (msg: string): CodeGraph => ({
    ...emptyGraph(repoPath, 'java-spring'),
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

  // src/test/ 不入图：理由同 Go 的 _test.go
  const files = walkFiles(repoPath, ['.java']).filter(
    (f) => !f.split(path.sep).join('/').includes('/src/test/'),
  );
  if (files.length === 0) return fallback('仓库内没有 .java 文件（已排除 src/test/）');

  const warnings: string[] = [];
  const modules = new Map<string, ModuleNode>();
  const classes: ClassNode[] = [];
  const functions: FunctionNode[] = [];
  const calls: CallEdge[] = [];
  const routes: RouteNode[] = [];
  let parseFailed = 0;
  let wildcardImports = 0;

  interface Parsed {
    rel: string; src: string; masked: string; starts: number[];
    pkg: string; imports: string[]; primaryType: string | null;
  }
  const parsed: Parsed[] = [];
  /** 完全限定名 → 文件，用于把 import 解析成本仓文件 */
  const fqnToFile = new Map<string, string>();

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
    const masked = maskComments(src, { tripleQuoteStrings: true, charLiterals: true });
    const starts = lineIndex(src);
    const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(masked)?.[1] ?? '';
    const imports: string[] = [];
    const impRe = /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;
    let im: RegExpExecArray | null;
    while ((im = impRe.exec(masked)) !== null) {
      if (im[1].endsWith('.*')) wildcardImports++;
      else imports.push(im[1]);
    }
    // 主类名按 Java 规则等于文件名（public 类必须与文件同名）
    const primaryType = path.basename(rel, '.java');
    parsed.push({ rel, src, masked, starts, pkg, imports, primaryType });
    modules.set(rel, { file: rel, imports: [], importedBy: [], symbolCount: 0 });
    if (pkg) fqnToFile.set(`${pkg}.${primaryType}`, rel);
  }

  // ── 依赖边 ──
  for (const p of parsed) {
    const mod = modules.get(p.rel)!;
    for (const fqn of p.imports) {
      const target = fqnToFile.get(fqn);
      if (target && target !== p.rel && !mod.imports.includes(target)) mod.imports.push(target);
    }
    // 同包无需 import 也能互相引用 —— 不连边会让同包依赖整体消失
    for (const q of parsed) {
      if (q === p || q.pkg !== p.pkg || !p.pkg) continue;
      if (q.primaryType && new RegExp(`\\b${q.primaryType}\\b`).test(p.masked)) {
        if (!mod.imports.includes(q.rel)) mod.imports.push(q.rel);
      }
    }
  }

  // ── 类型声明 ──
  for (const p of parsed) {
    const re = /\b(?:public|protected|private|abstract|final|static|sealed)?\s*\b(class|interface|enum|record)\s+([A-Za-z_]\w*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p.masked)) !== null) {
      classes.push({
        name: m[2],
        file: p.rel,
        line: offsetToLine(p.starts, m.index),
        kind: 'class',
        methods: [],
      });
    }
  }

  // ── 方法声明 ──
  // 形如：[注解] [修饰符] [泛型] 返回类型 方法名( ... ) [throws ...] { 或 ;
  //
  // 修饰符**必须可选**：接口方法（`String fetchAll();`）不写修饰符，隐式 public abstract。
  // 要求至少一个修饰符会让整个接口的方法集为空 —— 而接口正是 Spring 里 @Autowired
  // 声明的类型，调用边全指向它，丢了等于调用图断在最关键的一跳。
  //
  // 代价是 `return foo(` / `if (x)` 这类控制流也符合"类型 + 名字 + 括号"的形状，
  // 所以返回类型与方法名都要过关键字黑名单。
  for (const p of parsed) {
    const ifaceNames = new Set(
      [...p.masked.matchAll(/\binterface\s+([A-Za-z_]\w*)/g)].map((x) => x[1]),
    );
    const re =
      /(?:^|[;{}])\s*(?:@\w+(?:\([^)]*\))?\s*)*((?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*)(?:<[^>]+>\s*)?([\w.$]+(?:<[^>]*>)?(?:\[\])*)\s+([A-Za-z_]\w*)\s*\(/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p.masked)) !== null) {
      const name = m[3];
      const retType = m[2];
      if (NOT_METHOD_NAMES.has(name) || NOT_METHOD_NAMES.has(retType)) continue;
      // 行号取**方法名**的位置，不是 m.index —— m.index 落在前一条语句的 `;` 上，
      // 会让方法整体前移若干行，进而把路由注解匹配到上一个方法（实测就是这样错位的）
      const nameOffset = m.index + m[0].lastIndexOf(name);
      const line = offsetToLine(p.starts, nameOffset);
      const owner = classes
        .filter((c) => c.file === p.rel && c.line <= line)
        .sort((a, b) => b.line - a.line)[0]?.name ?? null;
      // 方法体结束行：从签名后第一个 { 起配平；接口/抽象方法无体，退回签名行
      let endLine = line;
      const afterSig = m.index + m[0].length;
      const semi = p.masked.indexOf(';', afterSig);
      const brace = p.masked.indexOf('{', afterSig);
      if (brace >= 0 && (semi < 0 || brace < semi)) {
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
        // 接口方法不写 public 也是 public（语言规则），按修饰符判会全判成非导出
        exported: /\bpublic\b/.test(m[1]) || (owner !== null && ifaceNames.has(owner)),
        owner,
        form: 'method',
      });
      if (owner) {
        const cls = classes.find((c) => c.file === p.rel && c.name === owner);
        if (cls && !cls.methods.includes(name)) cls.methods.push(name);
      }
    }
  }

  // ── 调用边 ──
  for (const p of parsed) {
    // 变量名 → 声明类型：`UserService userService;` / `@Autowired private UserService svc;`
    const varType = new Map<string, string>();
    const declRe = /\b([A-Z]\w*)(?:<[^>]*>)?\s+([a-z_]\w*)\s*[;=)]/g;
    let dm: RegExpExecArray | null;
    while ((dm = declRe.exec(p.masked)) !== null) varType.set(dm[2], dm[1]);

    const importedSimple = new Map<string, string>();
    for (const fqn of p.imports) {
      const f = fqnToFile.get(fqn);
      if (f) importedSimple.set(fqn.split('.').pop()!, f);
    }
    for (const q of parsed) {
      if (q.pkg === p.pkg && q.primaryType && q !== p) importedSimple.set(q.primaryType, q.rel);
    }

    const fnsInFile = functions.filter((f) => f.file === p.rel).sort((a, b) => a.line - b.line);
    const re = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p.masked)) !== null) {
      const line = offsetToLine(p.starts, m.index);
      const enclosing = fnsInFile.filter((f) => f.line <= line && line <= f.endLine).pop();
      const recv = m[1];
      // 接收者是变量就查它的声明类型；是类名（大写开头）就直接当类型
      const typeName = varType.get(recv) ?? (/^[A-Z]/.test(recv) ? recv : undefined);
      calls.push({
        fromFile: p.rel,
        fromFn: enclosing?.name ?? '<top>',
        toObj: recv,
        toMethod: m[2],
        toFile: typeName ? (importedSimple.get(typeName) ?? null) : null,
        line,
        kind: 'call',
        tier: 'extracted',
      });
    }
  }

  // ── 路由：类级 @RequestMapping 前缀 + 方法级映射注解 ──
  for (const p of parsed) {
    let classPrefix = '';
    const clsRe = /@RequestMapping\s*\(/g;
    let cm: RegExpExecArray | null;
    while ((cm = clsRe.exec(p.masked)) !== null) {
      // 类级：注解后面跟的是 class 声明而不是方法签名
      const after = p.masked.slice(cm.index, cm.index + 400);
      if (/\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public|final|abstract)?\s*class\s/.test(after)) {
        classPrefix = annotationPath(p.src, p.masked, cm.index) ?? '';
        break;
      }
    }

    const fnsInFile = functions.filter((f) => f.file === p.rel).sort((a, b) => a.line - b.line);
    const findHandler = (offset: number) => {
      const line = offsetToLine(p.starts, offset);
      return fnsInFile.find((f) => f.line >= line && f.line <= line + 12);
    };

    for (const [anno, method] of Object.entries(MAPPING_ANNOTATIONS)) {
      const re = new RegExp(`@${anno}\\s*[(\\s]`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(p.masked)) !== null) {
        const sub = annotationPath(p.src, p.masked, m.index) ?? '';
        const h = findHandler(m.index);
        routes.push({
          method,
          urlPath: joinPath(classPrefix, sub),
          middlewares: [],
          handlerFile: h ? p.rel : null,
          handlerFn: h?.name ?? '<unknown>',
          file: p.rel,
          line: offsetToLine(p.starts, m.index),
          tier: 'inferred',
        });
      }
    }

    // 方法级 @RequestMapping(method = RequestMethod.POST)
    const mrRe = /@RequestMapping\s*\(/g;
    let mm: RegExpExecArray | null;
    while ((mm = mrRe.exec(p.masked)) !== null) {
      const after = p.masked.slice(mm.index, mm.index + 400);
      if (/\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public|final|abstract)?\s*class\s/.test(after)) continue;
      const close = p.masked.indexOf(')', mm.index);
      const body = p.src.slice(mm.index, close < 0 ? mm.index + 200 : close);
      const method = /RequestMethod\.([A-Z]+)/.exec(body)?.[1] ?? 'ANY';
      const sub = annotationPath(p.src, p.masked, mm.index) ?? '';
      const h = findHandler(mm.index);
      routes.push({
        method,
        urlPath: joinPath(classPrefix, sub),
        middlewares: [],
        handlerFile: h ? p.rel : null,
        handlerFn: h?.name ?? '<unknown>',
        file: p.rel,
        line: offsetToLine(p.starts, mm.index),
        tier: 'inferred',
      });
    }
  }

  // ── 回填 ──
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

  let traced = 0;
  for (const r of routes) {
    if (!r.handlerFile) continue;
    const target = functions.find((f) => f.file === r.handlerFile && f.name === r.handlerFn);
    if (!target) continue;
    if (calls.some((c) => c.fromFile === r.handlerFile && c.line >= target.line && c.line <= target.endLine && c.toFile)) {
      traced++;
    }
  }

  const blindSpots = [
    '依赖注入看不见实现类：@Autowired 的字段按**声明类型**连边，注入的具体实现（XxxImpl）不在这条边上',
    '接口方法的实现类调用不可见 —— "这个 Impl 没有调用方"不代表它没被用到',
    '反射、SpEL、动态代理（AOP 切面）产生的调用完全不可见',
    '@RequestMapping 里用常量或变量拼的路径识别不了，这类接口不会出现在路由表',
    '构造器不入图，`new Xxx()` 也不产生调用边 —— 只按 `对象.方法()` 认调用',
    '`src/test/` 不入图 —— "没有调用方"不代表没有测试在用',
  ];
  if (wildcardImports > 0) {
    blindSpots.push(`发现 ${wildcardImports} 处通配 import（import a.b.*），这些依赖边无法解析到具体文件`);
  }

  const buildMs = Date.now() - t0;
  logger.info(
    { repoPath, files: parsed.length, classes: classes.length, routes: routes.length, ms: buildMs },
    'java graph built',
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
    analyzer: 'java-spring',
    blindSpots,
  };
}

export const javaSpringAnalyzer: GraphAnalyzer = {
  name: 'java-spring',
  label: 'Java（Spring / JAX-RS）',
  language: 'java',
  frameworks: ['spring', 'spring-boot', 'jax-rs'],
  extensions: ['.java'],
  detect: detectJava,
  analyze: buildJavaGraph,
};
