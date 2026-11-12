/**
 * 行级 diff（Myers）。只给回执用：数新增 / 删除行、切出改动片段判噪声。
 * 先去掉公共前后缀，剩下的中段编辑距离过大时整段按「替换」处理，避免大文件卡住钩子。
 */

export interface Hunk {
  /** 删除的行（before 中的内容） */
  removed: string[];
  /** 新增的行（after 中的内容） */
  added: string[];
  /** 在 after 中的起始行号（1 起） */
  afterLine: number;
}

const MAX_EDIT = 3000;

export function splitLines(s: string | null): string[] {
  if (s === null || s === '') return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function diffLines(a: string[], b: string[]): Hunk[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  if (!A.length && !B.length) return [];
  if (!A.length || !B.length) return [{ removed: A, added: B, afterLine: pre + 1 }];

  const ops = myers(A, B);
  if (!ops) return [{ removed: A, added: B, afterLine: pre + 1 }];

  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    if (op === '=') {
      if (cur) hunks.push(cur);
      cur = null;
      ai++;
      bi++;
      continue;
    }
    if (!cur) cur = { removed: [], added: [], afterLine: pre + bi + 1 };
    if (op === '-') cur.removed.push(A[ai++]);
    else cur.added.push(B[bi++]);
  }
  if (cur) hunks.push(cur);
  return hunks;
}

/** 返回编辑脚本：'=' 相同，'-' 删 a 的下一行，'+' 加 b 的下一行。编辑距离过大返回 null */
function myers(a: string[], b: string[]): Array<'=' | '-' | '+'> | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT);
  const off = max;
  let v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const nv = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) x++, y++;
      nv[off + k] = x;
      if (x >= n && y >= m) {
        trace.push(nv);
        return backtrack(trace, a.length, b.length, off, d);
      }
    }
    v = nv;
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number, off: number, dEnd: number): Array<'=' | '-' | '+'> {
  const ops: Array<'=' | '-' | '+'> = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const prevX = v[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push('='), x--, y--;
    ops.push(x === prevX ? '+' : '-');
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) ops.push('='), x--, y--;
  return ops.reverse();
}