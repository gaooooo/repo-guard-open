/**
 * L0 注入面 —— 把约束推进上下文。
 *
 * 对应协作全景的「注入面」。deerclaw 那边是 `prompt-builder.ts` 全权组装 11 个段落；
 * 这里只能**追加** `additionalContext`，内容一定排在宿主 system prompt 之后。
 *
 * ── 为什么每段都有 token 上限 ──
 * 上限不是技术限制而是**纪律**。注入面无节制增长会挤掉真正的上下文
 *（要改的代码本身），而且长了之后模型的注意力会摊薄 —— 一份 3000 token 的
 * "重要约束"里，没有哪一条是重要的。
 *
 * 1500 是照搬 deerclaw 的每段预算。
 *
 * ── 为什么截断必须显式标注 ──
 * deerclaw 的原则是"不静默截断"。静默截断最坏：人在配置里写了 50 条禁忌，
 * 界面上看着都在，实际只注进去 20 条 —— 他会以为后 30 条在生效。
 */
import { estimateTokens } from '../engine/shims/token-estimator.js';
import { normalizePrefix, type RepoFacts } from '../runtime/repo-facts.js';
import { activeRules } from '../runtime/redlines.js';
import type { KnowledgeSnapshot } from '../engine/types.js';
import type { GuardConfig } from './config.js';

/** 每段注入的 token 上限。与 deerclaw 的 POLICY_SEGMENT_MAX_TOKENS 等一致 */
export const SEGMENT_MAX_TOKENS = 1500;

/**
 * 按行截断到 token 预算内，超了在末尾显式标注。
 *
 * 按**行**而不是按字符截：截在半行上会产生语义完全变掉的句子
 *（"不许删除 chain_status 字" —— 读起来像是允许删别的），
 * 而模型会照着那个残句办事。
 */
export function truncateToBudget(lines: string[], maxTokens = SEGMENT_MAX_TOKENS): {
  lines: string[];
  truncated: number;
} {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const cost = estimateTokens(`${lines[i]}\n`);
    if (used + cost > maxTokens) {
      return { lines: out, truncated: lines.length - i };
    }
    out.push(lines[i]);
    used += cost;
  }
  return { lines: out, truncated: 0 };
}

function segment(title: string, body: string[], maxTokens = SEGMENT_MAX_TOKENS): string[] {
  if (!body.length) return [];
  const { lines, truncated } = truncateToBudget(body, maxTokens);
  if (!lines.length) return [];
  const out = [title, ...lines];
  if (truncated > 0) {
    out.push(`（还有 ${truncated} 条超出本段 ${maxTokens} token 预算，已截断 —— 完整清单见 .codebuddy/facts.json）`);
  }
  return out;
}

/** 公共层守卫那一段。这是唯一不依赖 guard 配置的段落 —— 它是插件的核心功能 */
export function guardSegment(facts: RepoFacts): string[] {
  const layers = facts.publicLayer.map(normalizePrefix).filter(Boolean);
  const layerText = layers.length ? layers.join('、') : '（未配置）';
  const lines = [
    `本项目已接入 repo-guard。公共层目录：${layerText}。`,
    '改这些目录下**已有**的文件之前，必须先调 code-atlas 的 atlas_impact 工具（target=文件路径）确认影响面；受影响入口 ≥ 5 时只允许新增可选参数。',
    // 只约束「新写 / 本次写超」的文件。原本就超限的是历史债：只说「需要拆分」，AI 会在只要求改一个函数的任务里
    // 顺手把整个文件拆了（A/B 实测 E2：轮次翻倍、改动多出一个文件）
    `新写或这次改到超过 ${facts.lineLimit} 行的文件要拆分；原本就超限的文件不要顺手拆，除非需求就是拆分。影响面为 0 不等于可以删 —— 注意工具输出里的盲区清单。`,
  ];
  if (facts.componentLibrary) {
    lines.push(`UI 组件库锁定为 ${facts.componentLibrary}，禁止引入第二套。`);
  }
  const mcp = facts.componentMcp;
  if (mcp) {
    lines.push(
      `写或改组件前必须调用 MCP「${mcp}」查阅组件文档和 props。lib_search 只回答「库里有没有」；具体 API 以该 MCP 为准，禁止凭 antd / MUI 记忆编写。`,
    );
  }
  return lines;
}

/** 保序去重。facts.json 在前（新写的位置），redlines.json 在后（旧模板遗留）。 */
function uniqueKeepOrder(groups: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const raw of group) {
      const s = raw.trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * 组装完整的 L0 注入文本。
 *
 * 段落顺序是按**读者会先看到什么**排的，而不是按配置目录排：
 *   1. 公共层守卫  —— 会真拦，必须最先说清楚
 *   2. 项目使命与事实 —— 让模型知道它在改什么
 *   3. 常驻纪律
 *   4. 团队禁忌
 *   5. 停止条件
 *   6. 红线摘要   —— 只给 id 与一句话，正文在命中时才给
 *
 * 红线放最后是刻意的：它条数最多、也最容易撑爆预算，而它**已经有硬拦兜底**，
 * 注入只是让模型提前避开。前面几段没有硬拦，漏掉就真漏掉了。
 */
export function buildInjection(
  facts: RepoFacts | null,
  snapshot: KnowledgeSnapshot,
  cfg: GuardConfig,
): string {
  const blocks: string[][] = [];

  if (facts) blocks.push(guardSegment(facts));

  if (cfg.gates.inject) {
    const i = cfg.inject;

    if (i.mission || i.facts.length) {
      blocks.push(
        segment('## 这个项目', [...(i.mission ? [i.mission] : []), ...i.facts.map((f) => `- ${f}`)]),
      );
    }
    blocks.push(segment('## 常驻纪律（每次会话都读）', i.discipline.map((d) => `- ${d}`)));
    blocks.push(
      segment(
        '## 项目知识（代码里读不出来的事实）',
        i.knowledge.map((k) => (k.topic ? `- [${k.topic}] ${k.content}` : `- ${k.content}`)),
      ),
    );
    blocks.push(segment('## 禁忌（不硬拦，但别这么干）', i.taboos.map((t) => `- ${t}`)));

    // 停止条件曾写在 redlines.json（deerclaw policy.yaml 的形状），后来收到
    // facts.json。两边都读，避免旧仓写了却开场看不见 —— 那是静默丢配置。
    const stopConditions = uniqueKeepOrder([
      i.stopConditions,
      snapshot.policy.stop_conditions,
    ]);
    blocks.push(
      segment('## 必须停下来问人的情况', stopConditions.map((s) => `- ${s}`)),
    );

    const rules = activeRules(snapshot);
    if (rules.length) {
      blocks.push(
        segment('## 仓库红线摘要（命中时会硬拦并给出完整正文）', rules.map((r) => `- [${r.id}] ${r.rule}`)),
      );
    }
  }

  return blocks
    .filter((b) => b.length)
    .map((b) => b.join('\n'))
    .join('\n\n');
}

/**
 * 按任务类型挑必读清单。
 *
 * **只做关键词匹配，不调模型。** `UserPromptSubmit` 在关键路径上，
 * 每次提问都多一次模型调用不划算；而且关键词写错顶多漏注入，
 * 语义判定错了会**错注入** —— 给改样式的任务塞一份支付流程必读，是纯粹的伤害。
 */
/**
 * 像不像「要新做一块功能」。两类词同时出现才算：动作（开发 / 新增 / 实现…）+ 对象（管理 / 接口 / 功能…）。
 * 只有动作（「新增一个字段」）或只有对象（「管理页的按钮改蓝」）都不算 —— 那是改，不是新做。
 */
const FEATURE_ACT = /(开发|新增|新建|实现|做一个|做一套|加一个|加一套|增加|搭建|接入)|\b(implement|add|create|build)\b/i;
const FEATURE_OBJ = /(管理|接口|增删改查|功能|模块|服务|页面|列表页|详情页)|\b(crud|api|endpoint|service|management|page)\b/i;

export function isFeatureRequest(prompt: string): boolean {
  const t = (prompt ?? '').trim();
  return t.length > 0 && FEATURE_ACT.test(t) && FEATURE_OBJ.test(t);
}

/**
 * 新功能需求的参考提示。用户只说「开发资产管理，包括增删改查」，不用再写「参考 xx 实现」——
 * 让 AI 自己去找，并把找到的写出来给用户确认。
 *
 * 只提醒、不拦截：UserPromptSubmit 绝不能阻塞（见 hooks/index.ts）。
 * 跟着 L0 注入总闸走：inject 关了就不说。
 */
export function featureHint(cfg: GuardConfig, prompt: string): string {
  if (!cfg.gates.inject || !isFeatureRequest(prompt)) return '';
  return [
    '## 新功能需求：先找本仓的参考实现',
    '这像是要新做一块功能。动手写代码之前：',
    '1. 把需求拆成资源 + 动作，调 code-atlas 的 atlas_reuse：kind=similar，resource=<英文资源名，按本仓命名风格>，verbs=<Create / Modify / Delete / Describe 里要做的>，intent=<用户原话>。前端页面直接 intent=<要做什么页面>。',
    '2. 返回说这个资源**已存在** → 先告诉用户已有实现在哪，问是改现有的还是另起一套，不要直接平行新建。',
    '3. **不存在** → 从返回的参考候选里挑业务最像的一个（不是第 1 个就带 template=<家族名> 再查一次），' +
      '在方案第一句写明「参考 X 实现 Y」和理由，然后照它的分层写。',
    '4. 写到校验、加密、分页这类小功能时，先 atlas_reuse intent=<要写什么> 查有没有现成方法。',
  ].join('\n');
}

export function matchTaskRoutes(cfg: GuardConfig, prompt: string): string {
  if (!cfg.gates.inject || !cfg.inject.taskRoutes.length) return '';
  const text = (prompt ?? '').toLowerCase();
  if (!text.trim()) return '';

  const hits = cfg.inject.taskRoutes.filter((r) =>
    r.match.some((kw) => kw.trim() && text.includes(kw.trim().toLowerCase())),
  );
  if (!hits.length) return '';

  const lines: string[] = ['## 开发前必读（按本次任务类型匹配）'];
  for (const r of hits) {
    lines.push(`### ${r.name}`);
    if (r.required.length) {
      lines.push('先读这几个文件，读完再动手：');
      for (const f of r.required) lines.push(`- ${f}`);
    }
    if (r.hardGate) lines.push(`门禁：${r.hardGate}`);
  }
  const { lines: kept, truncated } = truncateToBudget(lines);
  if (truncated > 0) {
    kept.push(`（还有 ${truncated} 行被截断 —— 命中的任务类型太多，考虑收窄 match 关键词）`);
  }
  return kept.join('\n');
}
