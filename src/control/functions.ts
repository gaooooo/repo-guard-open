/**
 * 函数抽取（启发式，零依赖）：名字、行数、最大控制嵌套、参数个数。
 * 只为「本次新增或变长的函数是否超阈值」服务，宁可漏报不要误报：认不出的语言直接跳过。
 */

export interface FuncInfo {
  /** 名字；同名多次出现时带 #序号，用于 before / after 对齐 */
  key: string;
  name: string;
  line: number;
  lines: number;
  nesting: number;
  params: number;
}

const BRACE_EXT = /\.(go|ts|tsx|js|jsx|mjs|cjs|java|kt|kts|scala|cs|c|cc|cpp|h|hpp|rs|swift|php|dart)$/i;
const PY_EXT = /\.py$/i;

const NOT_NAMES = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'with', 'select', 'case',
  'new', 'typeof', 'await', 'sizeof', 'super', 'this', 'constructor_', 'synchronized', 'using', 'lock', 'foreach',
]);

const CONTROL = /\b(if|else|for|foreach|while|switch|select|try|catch|finally|do|case|default)\b|=>|\bfunc\s*\(|\bfunction\b/;

export function supportsFunctions(rel: string): boolean {
  return BRACE_EXT.test(rel) || PY_EXT.test(rel);
}

export function extractFunctions(rel: string, text: string | null): FuncInfo[] {
  if (!text) return [];
  const lines = text.split('\n');
  const raw = PY_EXT.test(rel) ? pyFunctions(lines) : BRACE_EXT.test(rel) ? braceFunctions(lines, /\.go$/i.test(rel)) : [];
  const seen = new Map<string, number>();
  return raw.map((f) => {
    const n = (seen.get(f.name) ?? 0) + 1;
    seen.set(f.name, n);
    return { ...f, key: n > 1 ? f.name + '#' + n : f.name };
  });
}

/** 去掉字符串与注释内容，保留长度不变以便定位（简化：单行内处理，块注释跨行跟踪） */
function sanitize(lines: string[]): string[] {
  const out: string[] = [];
  let inBlock = false;
  let inTpl = false;
  for (const line of lines) {
    let s = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      const n = line[i + 1];
      if (inBlock) {
        if (c === '*' && n === '/') (inBlock = false), (s += '  '), i++;
        else s += ' ';
        continue;
      }
      if (inTpl) {
        if (c === '\\') (s += '  '), i++;
        else if (c === '\u0060') (inTpl = false), (s += c);
        else s += ' ';
        continue;
      }
      if (c === '/' && n === '*') {
        inBlock = true;
        s += '  ';
        i++;
        continue;
      }
      if (c === '/' && n === '/') break;
      if (c === '\u0060') {
        inTpl = true;
        s += c;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== c) {
          if (line[j] === '\\') j++;
          j++;
        }
        j = Math.min(j, line.length);
        s += c + ' '.repeat(Math.max(0, j - i - 1)) + (j < line.length ? c : '');
        i = j;
        continue;
      }
      s += c;
    }
    out.push(s);
  }
  return out;
}

const HEAD_GO = /^\s*func\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/;
const HEAD_FN = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const HEAD_ARROW = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)?\s*(?::\s*[^=]+)?=>\s*\{?/;
const HEAD_ARROW_OPEN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?\(\s*$/;
const HEAD_METHOD = /^\s*(?:(?:public|private|protected|internal|static|final|abstract|async|override|readonly|virtual|open|suspend|fun|def|fn|pub|export|default|inline|unsafe|const|extern|[\w<>[\],.?]+)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/;

function braceFunctions(raw: string[], isGo: boolean): Array<Omit<FuncInfo, 'key'>> {
  const lines = sanitize(raw);
  const out: Array<Omit<FuncInfo, 'key'>> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let isMethod = false;
    let m = isGo ? HEAD_GO.exec(line) : HEAD_FN.exec(line) ?? HEAD_ARROW.exec(line) ?? HEAD_ARROW_OPEN.exec(line);
    if (!m && !isGo) {
      m = HEAD_METHOD.exec(line);
      isMethod = !!m;
    }
    const name = m?.[1];
    if (!m || !name || NOT_NAMES.has(name)) {
      i++;
      continue;
    }
    // 从名字往后找签名的括号与函数体的 {，签名最多跨 15 行；先遇到 ; 或 } 说明是声明 / 调用
    let sig = '';
    let bodyLine = -1;
    let bodyCol = -1;
    let depth = 0;
    let sawParen = false;
    // 方法形态：签名的 ) 与函数体的 { 之间只允许返回类型注解。出现 . ( = ; 说明是调用，如 moment(x).format(y) {…}
    let afterClose = '';
    const start = m.index + m[0].indexOf(name) + name.length;
    for (let j = i; j < Math.min(lines.length, i + 15) && bodyLine < 0; j++) {
      const t = j === i ? lines[j].slice(start) : lines[j];
      const base = j === i ? start : 0;
      for (let k = 0; k < t.length; k++) {
        const c = t[k];
        if (c === '(') (depth++, (sawParen = true));
        else if (c === ')') depth--;
        else if (depth === 0 && sawParen && c !== '{') afterClose += c;
        if (depth === 0 && c === '{' && sawParen) {
          bodyLine = j;
          bodyCol = base + k;
          break;
        }
        if (depth === 0 && (c === ';' || c === '}')) {
          j = lines.length;
          break;
        }
        sig += c;
      }
      sig += '\n';
    }
    if (bodyLine < 0) {
      i++;
      continue;
    }
    if (isMethod && !/^\s*(:[^=;(){}.]*(\.[^=;(){}.]*)*)?\s*$/.test(afterClose.replace(/\n/g, ' '))) {
      i++;
      continue;
    }
    const end = matchBody(lines, bodyLine, bodyCol);
    if (end.line < 0) {
      i++;
      continue;
    }
    out.push({ name, line: i + 1, lines: end.line - i + 1, nesting: end.nesting, params: countParams(sig) });
    // 嵌套函数也要统计：从函数体下一行继续扫，而不是跳到函数结尾
    i = bodyLine + 1;
  }
  return out;
}

/** 从函数体的 { 开始配对，返回结束行与最大控制嵌套（函数自己的 { 不算） */
function matchBody(lines: string[], line: number, col: number): { line: number; nesting: number } {
  const stack: boolean[] = [];
  let control = 0;
  let max = 0;
  for (let j = line; j < lines.length; j++) {
    const t = lines[j];
    for (let k = j === line ? col : 0; k < t.length; k++) {
      const c = t[k];
      if (c === '{') {
        let ctx = t.slice(0, k);
        if (!ctx.trim() && j > 0) ctx = lines[j - 1];
        const seg = ctx.split(/[{}]/).pop() ?? ''; // 不按 ; 切：for 头里有分号
        const isControl = stack.length > 0 && CONTROL.test(seg + (/^\s*}\s*else/.test(t) ? ' else' : ''));
        stack.push(isControl);
        if (isControl) control++, (max = Math.max(max, control));
      } else if (c === '}') {
        const was = stack.pop();
        if (was) control--;
        if (!stack.length) return { line: j, nesting: max };
      }
    }
  }
  return { line: -1, nesting: 0 };
}

/** 签名里第一对括号内的顶层逗号数 + 1 */
function countParams(sig: string): number {
  const open = sig.indexOf('(');
  if (open < 0) return 0;
  let depth = 0;
  let cur = '';
  const parts: string[] = [];
  for (let k = open; k < sig.length; k++) {
    const c = sig[k];
    if ('([{<'.includes(c)) {
      depth++;
      if (depth === 1) continue;
    } else if (')]}>'.includes(c)) {
      depth--;
      if (depth === 0) break;
    }
    if (depth === 1 && c === ',') parts.push(cur), (cur = '');
    else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p && p !== 'self' && p !== 'cls' && !/^this\s*:/.test(p)).length;
}

function pyFunctions(lines: string[]): Array<Omit<FuncInfo, 'key'>> {
  const out: Array<Omit<FuncInfo, 'key'>> = [];
  const indentOf = (s: string) => s.length - s.trimStart().length;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(lines[i]);
    if (!m) continue;
    const ind = m[1].length;
    let sig = lines[i].slice(lines[i].indexOf('('));
    let j = i;
    while (!/\)\s*(->[^:]+)?:\s*(#.*)?$/.test(sig) && j < i + 15 && j + 1 < lines.length) sig += '\n' + lines[++j];
    let end = j;
    const ctl: number[] = [];
    let max = 0;
    for (let k = j + 1; k < lines.length; k++) {
      const t = lines[k];
      if (!t.trim() || t.trim().startsWith('#')) continue;
      const ti = indentOf(t);
      if (ti <= ind) break;
      end = k;
      while (ctl.length && ctl[ctl.length - 1] >= ti) ctl.pop();
      if (/^\s*(if|elif|else|for|while|try|except|finally|with|match|case)\b/.test(t)) {
        ctl.push(ti);
        max = Math.max(max, ctl.length);
      }
    }
    out.push({ name: m[2], line: i + 1, lines: end - i + 1, nesting: max, params: countParams(sig) });
  }
  return out;
}