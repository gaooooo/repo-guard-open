/**
 * 字段红线与内容红线的判定。写前钩子、写后提醒、合并门 check 共用。
 *
 * 字段：受保护标识符按词边界计数，改动后比改动前少 = 删除或改名。
 * 内容：只对新增的行跑正则，文件里原有的内容不算（不因历史债拦人）。
 */
import type { ContentRedline, FieldRedline, RedAction } from './config.js';
import { diffLines, splitLines } from './diff.js';
import { matches } from './scope.js';

export interface RedHit {
  kind: 'field' | 'content';
  action: RedAction;
  reason: string;
  /** 给人和模型看的一句话 */
  detail: string;
  /** 去重键 */
  key: string;
}

function inPaths(paths: string[], rel: string): boolean {
  return !paths.length || paths.some((p) => matches(p, rel));
}

function count(hay: string, id: string): number {
  const esc = id.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const re = new RegExp('(^|[^A-Za-z0-9_$])' + esc + '(?=[^A-Za-z0-9_$]|$)', 'g');
  let n = 0;
  while (re.exec(hay) !== null) n++;
  return n;
}

export function fieldHits(rules: FieldRedline[], rel: string, before: string | null, after: string | null): RedHit[] {
  if (before === null || after === null) return [];
  const out: RedHit[] = [];
  for (const r of rules) {
    if (!inPaths(r.paths, rel)) continue;
    const lost: string[] = [];
    for (const id of r.protects) {
      const b = count(before, id);
      const a = count(after, id);
      if (b > 0 && a < b) lost.push('\u0060' + id + '\u0060（' + b + ' 处 → ' + a + ' 处）');
    }
    if (lost.length) {
      out.push({
        kind: 'field',
        action: r.action,
        reason: r.reason,
        detail: '受保护字段被删除或改名：' + lost.join('、'),
        key: 'field:' + rel + ':' + r.protects.join(','),
      });
    }
  }
  return out;
}

/** 只看新增行；同一条规则在一个文件里只报第一处 */
export function contentHits(rules: ContentRedline[], rel: string, before: string | null, after: string | null): RedHit[] {
  if (after === null || !rules.length) return [];
  const active = rules.filter((r) => inPaths(r.paths, rel));
  if (!active.length) return [];
  const added = diffLines(splitLines(before), splitLines(after)).flatMap((h) => h.added.map((text, i) => ({ text, line: h.afterLine + i })));
  const out: RedHit[] = [];
  for (const r of active) {
    const re = new RegExp(r.pattern, r.flags);
    const hit = added.find((l) => re.test(l.text));
    if (!hit) continue;
    out.push({
      kind: 'content',
      action: r.action,
      reason: r.reason,
      detail: '第 ' + hit.line + ' 行新增内容命中 /' + r.pattern.slice(0, 60) + (r.pattern.length > 60 ? '…' : '') + '/',
      key: 'content:' + rel + ':' + r.pattern,
    });
  }
  return out;
}
