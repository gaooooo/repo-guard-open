/**
 * 写后比对 —— 新写的代码是不是照 similar 给的参考写的。
 *
 * similar 只能让 AI「查了」；查完照没照着写，之前没有任何环节看。
 * 这里拿本轮留下的参考计划（资源 + 参考家族 + 骨架分层 + 已有可复用的方法）
 * 去对本轮改过的文件，给出三类结论：
 *
 *   ① 分层：新接口的调用链是否与参考骨架同层走（接口层 → 逻辑层 → 存储层）。
 *      跳过逻辑层直接调存储层、或参考落在本仓存储层而它调了外部服务，都算偏差。
 *   ② 重复造：计划里标了「已有，直接调用」的方法，又在别的文件写了一个同名的。
 *   ③ 位置：新接口没写进计划里的文件（只提示，不算偏差 —— 放哪由人定）。
 *
 * 只依赖 CodeGraph，纯函数（与 src/insight 其它模块一样，下期可搬去平台）。
 */
import type { CodeGraph } from '../graph/types.js';
import { canonVerb, chainOf, familyKey, isEntryLayer, layerOf, sameResource, splitVerb, type Layer } from './similar-methods.js';

export interface ConformPlan {
  key: string;
  /** 这次查询涉及的所有资源键；新代码的资源名带不带前缀都认 */
  keys?: string[];
  resource: string;
  template: string | null;
  skeleton: string[];
  planned: Array<{ layer: string; file: string; name: string; reuse: boolean }>;
  kind: 'new' | 'gap' | 'exists';
}

export type ConformIssue = 'skip_logic' | 'downstream_mismatch' | 'no_downstream';

export interface ConformItem {
  file: string;
  name: string;
  layers: Layer[];
  chain: string[];
  issue: ConformIssue | null;
}

export interface ConformResult {
  resource: string;
  template: string | null;
  skeleton: string[];
  items: ConformItem[];
  duplicates: Array<{ name: string; file: string; shouldUse: string }>;
  misplaced: Array<{ file: string; planned: string[] }>;
  /** 有没有算作偏差的问题（位置不算） */
  drift: boolean;
}

const LAYER_LABEL: Record<string, string> = {
  router: '路由', service: '接口层', logic: '逻辑层', repo: '存储层', ext: '外部服务', sdk: 'SDK', dto: 'DTO', other: '其他',
};

/**
 * @param touched 本轮改过的文件（仓库相对路径）。只比对这些 —— 老代码不是这次写的，不该算到 AI 头上
 * @returns 本轮没写这个资源的接口时返回 null
 */
export function conform(graph: CodeGraph, plan: ConformPlan, touched: string[]): ConformResult | null {
  if (plan.kind === 'exists') return null;
  const touchedSet = new Set(touched);
  const fresh = graph.functions.filter((f) => {
    if (!touchedSet.has(f.file) || !isEntryLayer(layerOf(f.file))) return false;
    const { verb, family } = splitVerb(f.name);
    return Boolean(canonVerb(verb)) && sameResource(familyKey(family), plan.keys?.length ? plan.keys : [plan.key]);
  });
  if (!fresh.length) return null;

  const skel = plan.skeleton;
  const skelEnd = [...skel].reverse().find((l) => l === 'repo' || l === 'ext');
  const items: ConformItem[] = fresh.map((f) => {
    const chain = chainOf(graph, f.file, f.name);
    const layers = chain.map((c) => c.layer);
    const end = [...layers].reverse().find((l) => l === 'repo' || l === 'ext');
    let issue: ConformIssue | null = null;
    if (layers.length <= 1) issue = 'no_downstream';
    else if (skel.includes('logic') && !layers.includes('logic') && end) issue = 'skip_logic';
    else if (skelEnd && end && end !== skelEnd) issue = 'downstream_mismatch';
    return { file: f.file, name: f.name, layers, chain: chain.map((c) => `${c.file}#${c.name}`), issue };
  });

  // 计划说「已有，直接调用」的，在本轮改过的其它文件里又出现了同名方法 = 重复造
  const duplicates: ConformResult['duplicates'] = [];
  for (const p of plan.planned.filter((x) => x.reuse)) {
    for (const f of graph.functions) {
      if (f.name === p.name && f.file !== p.file && touchedSet.has(f.file) && layerOf(f.file) === p.layer) {
        duplicates.push({ name: f.name, file: f.file, shouldUse: `${p.file}#${p.name}` });
      }
    }
  }

  const plannedEntry = [...new Set(plan.planned.filter((p) => !p.reuse && isEntryLayer(p.layer as Layer)).map((p) => p.file))];
  const misplaced: ConformResult['misplaced'] = [];
  if (plannedEntry.length) {
    for (const file of new Set(fresh.map((f) => f.file))) {
      if (!plannedEntry.includes(file)) misplaced.push({ file, planned: plannedEntry });
    }
  }

  // 「没解析到下游」可能只是图谱没认出这条调用（接口动态派发、闭包），不单独算偏差
  const drift = items.some((i) => i.issue === 'skip_logic' || i.issue === 'downstream_mismatch') || duplicates.length > 0;
  return { resource: plan.resource, template: plan.template, skeleton: skel, items, duplicates, misplaced, drift };
}

const ISSUE_TEXT: Record<ConformIssue, string> = {
  skip_logic: '跳过了逻辑层，接口层直接调存储 / 外部服务',
  downstream_mismatch: '下游与参考不一致',
  no_downstream: '图谱没解析到它调了什么（若确实没调下层，就是把逻辑写进了接口层）',
};

export function renderConform(r: ConformResult): string {
  const skel = r.skeleton.map((l) => LAYER_LABEL[l] ?? l).join(' → ');
  const ok = r.items.filter((i) => !i.issue);
  const lines = [
    `## 写后比对 · ${r.resource}（参考 ${r.template ?? '无'}：${skel || '无骨架'}）`,
    `本轮新写的接口 ${r.items.length} 个，与参考分层一致 ${ok.length} 个。`,
  ];
  for (const i of r.items) {
    const path = i.layers.map((l) => LAYER_LABEL[l] ?? l).join(' → ');
    lines.push(`- ${i.issue ? '✗' : '✓'} \`${i.file}#${i.name}\`：${path}${i.issue ? ` —— ${ISSUE_TEXT[i.issue]}` : ''}`);
  }
  if (r.duplicates.length) {
    lines.push('重复造（参考里已有，应直接调用）：');
    for (const d of r.duplicates) lines.push(`- \`${d.file}#${d.name}\` → 应改为调用 \`${d.shouldUse}\``);
  }
  for (const m of r.misplaced) {
    lines.push(`位置提示：新接口写在 \`${m.file}\`，参考建议放 ${m.planned.map((p) => `\`${p}\``).join('、')}（放哪由人定，仅提示）。`);
  }
  lines.push(r.drift ? '有偏差：按参考骨架改完再收尾；确有理由不照参考写，要在回复里说明。' : '分层与参考一致。');
  return lines.join('\n');
}
