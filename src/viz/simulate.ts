/**
 * 沙盘 · 模拟一次写入：「如果 AI 现在改这个文件，守卫会怎么判」。
 *
 * 复用 pre-write 里真实的判定函数与拒绝文案（judge / judgeGraphEnforce /
 * judgeRequireTool / denyReason），只把「本轮查过没有」换成页面上勾选的假设。
 * 不读也不写真实会话状态 —— 人在图上点一下，不能替 AI 把守卫放行。
 *
 * ── 模拟不到的 ──
 * 循环门（依赖本会话的调用历史）、范围门（依赖本会话改过的文件数）、
 * 红线的内容级判定（protects 看的是写入后的代码，沙盘里没有写入内容）。
 * 这些在结果里显式列出，不能让人以为"沙盘放行 = 真实放行"。
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadGuardConfig } from '../gates/config.js';
import { judgeGraphEnforce } from '../gates/graph-enforce.js';
import { denyReason, shouldBlock } from '../runtime/guard.js';
import { toRepoRelative } from '../runtime/paths.js';
import { activeRules, loadRedlines } from '../runtime/redlines.js';
import { inPublicLayer, readFacts } from '../runtime/repo-facts.js';
import { ruleAppliesToPath } from '../engine/policy-engine.js';
import { loadStandards } from '../standards/loader.js';
import { judgeRequireTool } from '../standards/evaluate.js';

export interface SimulateAssume {
  queried: boolean;
  similarSearched: boolean;
  hotQueried: boolean;
  libSearched: boolean;
}

export interface SimulateStep {
  gate: string;
  verdict: 'deny' | 'pass' | 'skip';
  note: string;
}

export interface SimulateResult {
  rel: string | null;
  exists: boolean;
  publicPrefix: string | null;
  verdict: 'deny' | 'allow';
  /** 与真实 PreToolUse 拒绝时 AI 看到的文案逐字一致 */
  reason: string | null;
  steps: SimulateStep[];
  redlines: Array<{ id: string; rule: string }>;
  notSimulated: string[];
}

const NOT_SIMULATED = [
  '循环门：依赖本会话的调用与失败历史',
  '范围门：依赖本会话已改过的文件数',
  '红线内容级判定：protects 要看写入后的代码，沙盘里没有写入内容',
];

export function simulateWrite(repoDir: string, raw: string, assume: SimulateAssume): SimulateResult {
  const rel = toRepoRelative(repoDir, raw);
  const base: SimulateResult = {
    rel,
    exists: false,
    publicPrefix: null,
    verdict: 'allow',
    reason: null,
    steps: [],
    redlines: [],
    notSimulated: NOT_SIMULATED,
  };
  if (!rel) {
    return { ...base, steps: [{ gate: '仓库边界', verdict: 'skip', note: '路径不在仓库里，守卫不管' }] };
  }

  let exists = false;
  try {
    exists = fs.statSync(path.join(repoDir, rel)).isFile();
  } catch {
    exists = false;
  }
  const facts = readFacts(repoDir);
  const cfg = loadGuardConfig(repoDir);
  const snapshot = loadRedlines(repoDir);
  const rules = activeRules(snapshot).filter((r) => ruleAppliesToPath(r, rel));
  const out: SimulateResult = { ...base, exists, redlines: rules.map((r) => ({ id: r.id, rule: r.rule })) };

  // 与 pre-write 同序：图谱强制 → 公共层守卫 → 规范 require_tool
  const enforce = judgeGraphEnforce(repoDir, cfg, rel, exists, {
    similarSearched: assume.similarSearched,
    hotQueried: assume.hotQueried,
    libSearched: assume.libSearched,
  });
  if (enforce.blocked) {
    out.steps.push({ gate: '图谱强制（新建前先查）', verdict: 'deny', note: enforce.kind ?? '' });
    return { ...out, verdict: 'deny', reason: enforce.reason ?? null };
  }
  out.steps.push({
    gate: '图谱强制（新建前先查）',
    verdict: 'pass',
    note: exists ? '文件已存在，这道门只管新建' : cfg.gates.admission ? '已查过或路径不在规则里' : '准入总闸未开（process-gates admission=false）',
  });

  if (facts) {
    const publicPrefix = inPublicLayer(facts, rel);
    out.publicPrefix = publicPrefix;
    const v = { rel, publicPrefix, exists, rules, queried: assume.queried };
    if (shouldBlock(v)) {
      out.steps.push({ gate: '公共层守卫', verdict: 'deny', note: `命中公共层 ${publicPrefix}，本轮未查影响面` });
      return { ...out, verdict: 'deny', reason: denyReason(v) };
    }
    out.steps.push({
      gate: '公共层守卫',
      verdict: 'pass',
      note: !publicPrefix ? '不在公共层' : !exists ? '新建文件没有影响面可查' : '本轮已查过影响面，放行',
    });
  } else {
    out.steps.push({ gate: '公共层守卫', verdict: 'skip', note: '没有 .codebuddy/repo-facts.json，公共层无从判定' });
  }

  const rt = judgeRequireTool(loadStandards(repoDir, facts), rel, { ...assume, exists });
  if (rt.blocked) {
    out.steps.push({ gate: '研发规范 require_tool', verdict: 'deny', note: rt.itemId ?? '' });
    return { ...out, verdict: 'deny', reason: rt.reason ?? null };
  }
  out.steps.push({ gate: '研发规范 require_tool', verdict: 'pass', note: '没有 block 级的「先调工具」规范命中' });
  return out;
}
