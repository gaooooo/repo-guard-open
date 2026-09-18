/**
 * 体量与结构体检 —— 超长文件、循环依赖。
 *
 * ── 为什么这两项单独成命令 ──
 * 它们是**能挂进流水线**的那部分：`repo-guard scan || exit 1`。
 * 影响面、红线这些需要人判断，没法自动卡；行数和循环依赖是纯客观事实，
 * 可以直接当准入。所以 scan 有问题时非零退出，别的命令都不。
 *
 * ── 为什么超长文件只算不拦 ──
 * 存量超长文件遍地都是。硬拦等于没法干活，而且这个工具的价值在"改动时提醒"，
 * 不在"清理历史债"。真要清就该挂流水线，让人排期。
 */
import type { CodeGraph } from '../engine/graph/types.js';
import { countLines } from '../runtime/repo-facts.js';
import path from 'node:path';

export interface Oversize {
  file: string;
  lines: number;
}

export interface ScanResult {
  totalFiles: number;
  oversize: Oversize[];
  lineLimit: number;
  /** 每个环一条，形如 `[a, b, a]`（首尾同一个文件，读起来才闭合） */
  cycles: string[][];
}

/**
 * 找模块级循环依赖。
 *
 * 用迭代 DFS 而不是递归：深依赖链上递归会爆栈，而爆栈是抛异常 ——
 * 这个工具的任何一处抛异常都会让 `scan` 整体失败，人拿不到本来能拿到的超长文件清单。
 *
 * 每个环只报一次：按环内最小文件名做规范化 key 去重，否则一个三元环会被
 * 三个起点各报一遍，人看到"3 处循环依赖"其实只有 1 处。
 */
export function findCycles(graph: CodeGraph, maxCycles = 50): string[][] {
  const adj = new Map<string, string[]>();
  for (const m of graph.modules ?? []) {
    adj.set(m.file, (m.imports ?? []).slice());
  }

  const seen = new Set<string>();
  const out: string[][] = [];

  /** 0 = 未访问，1 = 在当前栈上，2 = 已完成 */
  const color = new Map<string, number>();

  for (const start of adj.keys()) {
    if (color.get(start)) continue;

    /** 显式栈：节点 + 它还没走完的邻居下标 */
    const stack: Array<{ node: string; i: number }> = [{ node: start, i: 0 }];
    const pathStack: string[] = [start];
    color.set(start, 1);

    while (stack.length) {
      const top = stack[stack.length - 1];
      const neighbors = adj.get(top.node) ?? [];
      if (top.i >= neighbors.length) {
        color.set(top.node, 2);
        stack.pop();
        pathStack.pop();
        continue;
      }
      const next = neighbors[top.i++];
      if (!adj.has(next)) continue; // 外部依赖，不入图

      if (color.get(next) === 1) {
        // 回边 → 找到环。从 pathStack 里截出 next 到栈顶那一段
        const at = pathStack.lastIndexOf(next);
        if (at >= 0) {
          const ring = pathStack.slice(at);
          // 规范化：从字典序最小的元素起转一圈，同一个环无论从哪进来都得到同一个 key
          const min = ring.indexOf([...ring].sort()[0]);
          const key = [...ring.slice(min), ...ring.slice(0, min)].join('>');
          if (!seen.has(key)) {
            seen.add(key);
            out.push([...ring, next]);
          }
        }
        if (out.length >= maxCycles) return out;
        continue;
      }
      if (color.get(next) === 2) continue;

      color.set(next, 1);
      pathStack.push(next);
      stack.push({ node: next, i: 0 });
    }
  }
  return out;
}

export function scan(repoDir: string, graph: CodeGraph, lineLimit: number): ScanResult {
  const files = (graph.modules ?? []).map((m) => m.file);
  const oversize: Oversize[] = [];
  for (const f of files) {
    const n = countLines(path.join(repoDir, f));
    if (n > lineLimit) oversize.push({ file: f, lines: n });
  }
  // 行数降序：最该先拆的排最前
  oversize.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));

  return {
    totalFiles: files.length,
    oversize,
    lineLimit,
    cycles: findCycles(graph),
  };
}

/** 有问题吗。决定 `scan` 的退出码 —— 这是它能挂进流水线的全部接口 */
export function hasProblems(r: ScanResult): boolean {
  return r.oversize.length > 0 || r.cycles.length > 0;
}

export function renderScanCli(r: ScanResult): string {
  const lines = ['', `源文件 ${r.totalFiles} 个`, `超过 ${r.lineLimit} 行：${r.oversize.length} 个`];
  for (const o of r.oversize.slice(0, 30)) {
    lines.push(`    ${o.lines}  ${o.file}`);
  }
  if (r.oversize.length > 30) lines.push(`    …另有 ${r.oversize.length - 30} 个`);

  lines.push('', `循环依赖：${r.cycles.length} 处`);
  for (const c of r.cycles.slice(0, 20)) {
    lines.push(`  ${c.join(' → ')}`);
  }
  if (r.cycles.length > 20) lines.push(`  …另有 ${r.cycles.length - 20} 处`);

  return `${lines.join('\n')}\n`;
}

/** MCP 版：一句话。agent 不需要清单，需要的是"有没有问题、有多严重" */
export function renderScanMcp(r: ScanResult): string {
  const worst = r.oversize[0];
  const over = worst
    ? `超过 ${r.lineLimit} 行的 ${r.oversize.length} 个，最大 ${worst.lines} 行（${worst.file}）`
    : `没有超过 ${r.lineLimit} 行的文件`;
  return `源文件 ${r.totalFiles} 个；${over}；循环依赖 ${r.cycles.length} 处。`;
}
