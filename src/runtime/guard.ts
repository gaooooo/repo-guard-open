/**
 * 守卫判定 —— 「这个文件该不该拦」的唯一事实源。
 *
 * CLI 的 `check`、MCP 的 `check`、`pre-write` 钩子三个入口共用这里。
 * 分开写必然漂：hook 拦了但 check 说没事，人就会认为 hook 有 bug。
 *
 * ── 判据 ──
 *   拦：文件在公共层 **且** 文件已存在 **且** 本会话没查过它的影响面
 *   放：其余全部
 *
 * 三个条件里最容易被忽略的是"文件已存在"。**新建公共层文件必须放行** ——
 * 新文件没有调用者，查影响面查出来也是空的，拦它纯属骚扰。
 * 这条是 verify-hooks 的 N2 用例。
 *
 * 红线是**第二信息**而不是第二道硬拦：命中红线时把规则正文一起给出去，
 * 但拦截原因仍记作"未查影响面"。理由是红线的判定维度是路径 glob，
 * 粒度比"改了什么"粗得多，拿它当硬拦会大面积误伤。
 */
import fs from 'node:fs';
import path from 'node:path';

import { ruleAppliesToPath } from '../engine/policy-engine.js';
import type { KnowledgeSnapshot, PolicyRule } from '../engine/types.js';
import { inPublicLayer, type RepoFacts } from './repo-facts.js';
import { activeRules } from './redlines.js';
import { hasQueried } from './session-state.js';
import { selfPath, toRepoRelative } from './paths.js';

export interface FileVerdict {
  /** 仓库相对路径 */
  rel: string;
  /** 命中的公共层前缀。null = 不在公共层 */
  publicPrefix: string | null;
  /** 文件此刻是否已存在。false = 新建 */
  exists: boolean;
  /** 命中的红线（按路径 glob） */
  rules: PolicyRule[];
  /** 本会话是否查过它的影响面 */
  queried: boolean;
}

/** 单个文件的判定。`raw` 可以是绝对路径或仓库相对路径 */
export function judge(
  repoDir: string,
  facts: RepoFacts | null,
  snapshot: KnowledgeSnapshot,
  raw: string,
): FileVerdict | null {
  const rel = toRepoRelative(repoDir, raw);
  if (!rel) return null; // 仓库外：不管

  let exists = false;
  try {
    exists = fs.statSync(path.join(repoDir, rel)).isFile();
  } catch {
    exists = false;
  }

  return {
    rel,
    publicPrefix: facts ? inPublicLayer(facts, rel) : null,
    exists,
    rules: activeRules(snapshot).filter((r) => ruleAppliesToPath(r, rel)),
    queried: hasQueried(repoDir, rel),
  };
}

/** 该拦吗 */
export function shouldBlock(v: FileVerdict): boolean {
  return Boolean(v.publicPrefix) && v.exists && !v.queried;
}

/**
 * 拦截文案。
 *
 * 三段固定结构，每一段都在防一种具体的误用：
 *   ① 为什么拦          —— 不说清楚，模型会当成工具故障然后重试
 *   ② 该去调什么         —— 只说"要先查影响面"模型不知道调哪个工具、传什么参数，
 *                           会去 grep 一遍然后声称查过了
 *   ③ 影响面为 0 不等于可删 —— 这是最危险的推理，必须每次都堵
 *
 * ── 第 ② 段为什么要给三种调法 ──
 * 真机实测踩过两次坑，都是同一个形态：**文案指的路走不通 → 模型判定
 * "工具不存在" → 改用 grep 凑影响面**。守卫拦住了，却把它推向了一个更差的
 * 替代方案。
 *
 *   第一次：文案只写「调用 impact 工具」。但插件的 MCP 工具在宿主里的真名是
 *          `mcp__repo-guard__impact`（带命名空间），模型按 `impact` 搜不到。
 *   第二次：补了 CLI 兜底 `repo-guard impact <file>`。但宿主只把
 *          `--plugin-dir` 加载的插件的 `bin/` 注入 PATH，市场安装的不注入
 *          —— 模型跑完拿到 `command not found`。
 *
 * 所以：MCP 全名、斜杠命令、以及**绝对路径**的 CLI，三条都给。
 * 冗余在这里是对的 —— 模型少一条路就会去发明一条。
 */
export function denyReason(v: FileVerdict): string {
  const lines = [
    `\`${v.rel}\` 在本项目的公共层里，改它之前必须先确认影响面。`,
    '按下面任一种方式查（三个是同一个能力，挑能用的那个）：',
    `  · MCP 工具：mcp__repo-guard__impact，参数 file="${v.rel}"`,
    `  · 斜杠命令：/repo-guard:impact ${v.rel}`,
    `  · 命令行：node "${selfPath()}" impact ${v.rel}`,
    '拿到受影响的入口数再决定改法 —— 被 5 个以上入口引用时只允许新增可选参数，不得改已有签名。',
    '**不要用代码搜索代替它。** grep 看不见动态引用、样式引用和跨服务调用，' +
      '拿搜索结果当影响面会得出"没人用，可以删"这种错误结论。',
  ];
  if (v.rules.length) {
    lines.push(`同时命中红线 ${v.rules.map((r) => r.id).join('、')}：`);
    for (const r of v.rules) lines.push(`  ${r.id}：${r.rule}`);
    lines.push('（拦截原因是未查影响面；红线给下一轮看，不是第二道硬拦。）');
  }
  lines.push('（影响面为 0 也不等于可以删，注意输出里的盲区清单。本约束由 repo-guard 提供。）');
  return lines.join('\n');
}

/** 哪些配置缺了。给 `check` 的"结果不完整"提示用 */
export function missingConfig(facts: RepoFacts | null, snapshot: KnowledgeSnapshot): string[] {
  const out: string[] = [];
  if (!facts) out.push('没有 .codebuddy/repo-facts.json，公共层无从判定');
  if (!snapshot.ok) out.push('没有 .codebuddy/redlines.json，红线无从判定');
  return out;
}
