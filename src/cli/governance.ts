/**
 * governance —— 把埋点汇总成一张表。
 *
 * 对应 deerclaw 协作全景的 **L6 治理留痕**。那边是 `/admin/governance` 页面，
 * 聚合全团队；这边只有本机一个 ndjson，所以只回答一个问题：
 * **这些门到底在做有用功还是在骚扰人。**
 *
 * 两个关键比值：
 *   拦截后改了方案的比例 —— 低说明这道门在做无用功（AI 查完照原样改）
 *   shell 旁路次数       —— 高说明 AI 在绕开文件工具，守卫形同虚设
 *
 * 没有这两个数，门禁阈值只能靠感觉调，而靠感觉调的结果通常是越调越严，
 * 直到人把插件卸掉。
 */
import path from 'node:path';

import { readAll, type MetricRecord } from '../runtime/metrics.js';
import { RULE } from './text.js';

interface Bucket {
  deny: number;
  allowAfterQuery: number;
  shellBypass: number;
  oversize: number;
  redline: number;
  graphQuery: number;
  sessions: Set<string>;
}

function empty(): Bucket {
  return {
    deny: 0,
    allowAfterQuery: 0,
    shellBypass: 0,
    oversize: 0,
    redline: 0,
    graphQuery: 0,
    sessions: new Set(),
  };
}

function tally(bucket: Bucket, r: MetricRecord): void {
  bucket.sessions.add(r.sid);
  switch (r.event) {
    case 'guard_deny':
      bucket.deny++;
      break;
    case 'guard_allow_after_query':
      bucket.allowAfterQuery++;
      break;
    case 'shell_bypass_warn':
      bucket.shellBypass++;
      break;
    case 'oversize_warn':
      bucket.oversize++;
      break;
    case 'redline_hit':
      bucket.redline++;
      break;
    case 'graph_query':
      bucket.graphQuery++;
      break;
    default:
      break;
  }
}

export function renderGovernance(repoDir: string): string {
  const all = readAll();
  if (!all.length) {
    return (
      '\n还没有埋点数据。\n' +
      '守卫触发过之后这里会有：拦了多少次、AI 查完之后改没改方案、shell 旁路多少次。\n'
    );
  }

  const thisRepo = empty();
  const global = empty();
  for (const r of all) {
    tally(global, r);
    if (r.repo === repoDir) tally(thisRepo, r);
  }

  const since = new Date(all[0].ts).toISOString().slice(0, 10);
  const lines = ['', `repo-guard · 治理留痕（${since} 起）`, RULE];

  for (const [label, b] of [
    [`本仓 ${path.basename(repoDir)}`, thisRepo],
    ['全部仓库', global],
  ] as const) {
    lines.push(
      '',
      label,
      `  会话            ${b.sessions.size}`,
      `  写前拦截        ${b.deny}`,
      `  查完影响面放行  ${b.allowAfterQuery}`,
      `  shell 旁路提醒  ${b.shellBypass}`,
      `  超长文件提醒    ${b.oversize}`,
      `  命中红线        ${b.redline}`,
      `  图谱查询        ${b.graphQuery}`,
    );
  }

  // 解读放在最后，且只在样本够的时候给 —— 5 次拦截算出来的比例没有意义，
  // 但人会当真去调阈值
  if (thisRepo.deny >= 10) {
    const followed = thisRepo.deny ? Math.round((thisRepo.allowAfterQuery / thisRepo.deny) * 100) : 0;
    lines.push(
      '',
      `本仓拦截后有 ${followed}% 转成了"查完再改"。`,
      followed < 30
        ? '偏低 —— AI 多半在绕路（换 shell 写、或者放弃改动）。看看 shell 旁路次数。'
        : '这道门在起作用。',
    );
  }
  if (thisRepo.shellBypass >= 5 && thisRepo.shellBypass > thisRepo.deny) {
    lines.push(
      '',
      'shell 旁路次数超过了正常拦截次数 —— AI 在用 sed / 重定向绕开文件工具。',
      '这种情况下写前守卫基本失效，考虑在宿主的 permissions 里 deny 掉对公共层的 shell 写。',
    );
  }

  return `${lines.join('\n')}\n`;
}
