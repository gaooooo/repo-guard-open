/**
 * 埋点 —— 拦了什么、放行了什么、AI 查了什么，追加写一行 JSON。
 *
 * 对应 deerclaw 协作全景里的 **L6 治理留痕**。那边落 `agent_runs` 表并聚合成
 * `/admin/governance`；这边是一个 ndjson 文件 + `repo-guard governance` 出报表。
 *
 * ── 为什么要留痕 ──
 * 门禁的阈值该设多严，只能靠数据回答。「公共层守卫拦了 40 次，其中 38 次 AI
 * 查完影响面照原样改了」说明这道门在做无用功；「拦了 3 次，2 次改了方案」说明它值。
 * 没有埋点就只能靠感觉调，而靠感觉调门禁的结果通常是越调越严，直到人卸载它。
 *
 * ── 为什么在 $HOME 而不是仓库里 ──
 * 这是跨仓、跨会话的个人数据。写进被守护的仓库会污染 `git status`。
 *
 * ── 为什么全程静默 ──
 * 埋点在 hook 的关键路径上。任何一处抛异常都会让 hook 非零退出，
 * 而 `PreToolUse` 的非零退出意味着**工具调用被阻断**。为了记日志把人的操作弄失败，
 * 是最蠢的失败方式。所以这里所有异常一律吞掉。
 */
import fs from 'node:fs';
import path from 'node:path';

import { stateRoot } from './paths.js';
import { sessionId } from './session-state.js';

export type MetricEvent =
  /** 写前守卫拦住了 */
  | 'guard_deny'
  /** 写前守卫放行（查过影响面之后） */
  | 'guard_allow_after_query'
  /** shell 旁路写公共层，提醒了 */
  | 'shell_bypass_warn'
  /** 写完超行数上限，提醒了 */
  | 'oversize_warn'
  /** AI 调了图谱查询 */
  | 'graph_query'
  /** 命中红线 */
  | 'redline_hit'
  | 'redline_ask'
  /** L1 范围门拦住了（allowlist 不命中 / 文件数超预算） */
  | 'scope_deny'
  /** L1 禁改清单拦住了 */
  | 'no_refactor_deny'
  /** L1 图谱强制拦住了（新建前必须先查 similar / hot / lib） */
  | 'graph_enforce_deny'
  /** L3 循环门拦住了（重复调用 / 连续失败 / 同文件写失败） */
  | 'loop_deny'
  /** L4 会话收尾的诚实信号（近似） */
  | 'final_signal'
  /** L5 交付门提醒或拦截 */
  | 'delivery_warn'
  /** 研发规范：remind 级命中，提醒了 */
  | 'standards_hit'
  /** 研发规范：block 级拦住了（受保护符号 / 必须先调工具） */
  | 'standards_deny'
  /** 会话开始 / 结束 */
  | 'session_start'
  | 'session_end';

export interface MetricRecord {
  ts: number;
  /** 会话 id。用于把一次会话里的事件串起来 */
  sid: string;
  event: MetricEvent;
  /** 仓库根绝对路径。session_id 在 --resume / compact 之后可能变，
   *  cwd 是二级归并键 —— 靠它还能把同一个仓库的事件聚到一起 */
  repo: string;
  /** 相关文件（仓库相对路径） */
  file?: string;
  /** 命中的红线号 */
  rule?: string;
  /** 工具名 / 查询类型等自由维度 */
  detail?: string;
}

function metricsFile(): string {
  return path.join(stateRoot(), 'metrics.ndjson');
}

/** 单文件上限 8MB，超了就轮转一次（只留一份 .1）。埋点不值得占用户更多磁盘 */
const MAX_BYTES = 8 * 1024 * 1024;

export function record(event: MetricEvent, repo: string, extra?: Partial<MetricRecord>): void {
  try {
    const f = metricsFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try {
      if (fs.statSync(f).size > MAX_BYTES) fs.renameSync(f, `${f}.1`);
    } catch {
      /* 文件还不存在 */
    }
    const rec: MetricRecord = { ts: Date.now(), sid: sessionId(), event, repo, ...extra };
    fs.appendFileSync(f, `${JSON.stringify(rec)}\n`);
  } catch {
    /* 埋点绝不能影响主流程 —— 见文件头 */
  }
}

/** 读全部埋点。给 `governance` 命令用。坏行逐行跳过 */
export function readAll(): MetricRecord[] {
  const out: MetricRecord[] = [];
  for (const f of [`${metricsFile()}.1`, metricsFile()]) {
    let raw: string;
    try {
      raw = fs.readFileSync(f, 'utf-8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line) as MetricRecord;
        if (v && typeof v.event === 'string' && typeof v.ts === 'number') out.push(v);
      } catch {
        /* 半行（写入时被打断）：跳过 */
      }
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}
