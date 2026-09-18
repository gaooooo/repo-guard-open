/**
 * 公共层路径存在性校验。
 *
 * 错配没有任何外部表现：守卫 fail-open，路径在仓里不存在时看起来和
 *「本次改动不涉及公共层」一模一样。必须在保存约定 / 下发 get_project_context
 * 时把「图谱里一个文件都匹配不到」的路径明确标出来。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { CodeGraph } from './graph/types.js';

export function normalizePublicLayerPrefix(pattern: string): string {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  return p.endsWith('/') ? p : `${p}/`;
}

/** 该路径在图里是否有至少 1 个入图文件（目录本身或目录下）。 */
export function patternHitsGraph(graph: CodeGraph, pattern: string): boolean {
  const raw = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw) return false;
  const prefix = normalizePublicLayerPrefix(raw);
  const exact = raw.replace(/\/$/, '');
  if (
    (graph.modules ?? []).some((m) => {
      const f = m.file.replace(/\\/g, '/');
      return f === exact || f === raw || f.startsWith(prefix);
    })
  ) {
    return true;
  }
  // 配置目录（etc/*.yaml）分析器本来就不入图；目录在工作区存在就算配上了
  const root = graph.repoDir;
  if (!root) return false;
  try {
    return fs.existsSync(path.join(root, exact));
  } catch {
    return false;
  }
}

export function patternsMissingFromGraph(graph: CodeGraph, patterns: string[]): string[] {
  return patterns.filter((p) => p.trim() && !patternHitsGraph(graph, p.trim()));
}

export function missingPublicLayerWarning(missing: string[]): string | null {
  if (!missing.length) return null;
  return (
    `公共层路径在图谱里找不到任何文件（目录不存在或未入图）：${missing.join('、')}。` +
    '守卫按这些路径判定，配了等于没配，而且 SessionStart 会注入误导性指令。请改成仓库里真实存在的目录。'
  );
}
