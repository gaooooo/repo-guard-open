/**
 * L1 图谱强制查询 —— 「新建之前先看仓里有没有」。
 *
 * 三条规则，对应协作全景里那三句：
 *   新建页面   → 先查 similar（这类页面本仓已经怎么写了）
 *   新建组件   → 先查 hot（别重复造轮子）
 *   新建组件   → 先查 lib search（组件库里有没有现成的）
 *
 * ── 为什么这三条比「改公共层前查 impact」难得多 ──
 * 改已有文件的判据是硬的：文件在公共层、文件存在、本轮没查过。三个条件都是事实。
 *
 * 新建文件的判据里有一个是**猜的**：什么算"新建页面"？靠目录约定
 *（`src/views/**`、`src/pages/**`）猜，而各仓约定不同。猜错的代价不对称：
 *   · 改已有文件被拦 → AI 去查一下就好，成本一次工具调用
 *   · 新建文件被拦   → AI 可能干脆放弃这个方案，或者换个目录绕过去
 *
 * pathPatterns 由 init 按本仓已有目录填，默认 enabled=false。
 * 硬拦仍要人打开 admission 和对应 enabled，避免猜错路径后误伤。
 *
 * ── 为什么"查过"只按会话记、不按文件记，但要按仓记 ──
 * 与 impact 不同：impact 是"查这个文件的影响面"，必须按文件记
 *（查过 A 不能放行 B）。而 similar / hot / lib 回答的是"这类东西仓里怎么写的"，
 * 一次查询的结论对整批新建文件都适用。按文件记会让 AI 为每个新文件查一遍，
 * 拿到的还是同一个答案 —— 那是纯粹的骚扰。
 *
 * 但"**仓**里怎么写的"是仓级知识：拿 A 仓的组件库答案去放行 B 仓的新建，
 * 等于让模型照着另一个仓的约定写。所以判据带 repoDir。
 */
import { hasHotQueried, hasLibSearched, hasSimilarSearched } from '../runtime/session-state.js';
import { componentDocsHint, readFacts } from '../runtime/repo-facts.js';
import type { GuardConfig } from './config.js';

/** 路径是否命中任一模式。模式支持结尾 `**`、目录前缀、精确路径 */
function matches(patterns: string[], rel: string): boolean {
  for (const raw of patterns) {
    const p = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!p) continue;
    if (p === rel) return true;
    const prefix = p.replace(/\*+$/, '');
    const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
    if (rel.startsWith(normalized)) return true;
  }
  return false;
}

export interface EnforceVerdict {
  blocked: boolean;
  reason?: string;
  kind?: 'need_similar' | 'need_hot' | 'need_lib';
}

const PASS: EnforceVerdict = { blocked: false };

/** 「本轮查过没有」。缺省读会话状态；可视化沙盘传入假设值，不读也不写真实状态 */
export interface EnforceSession {
  similarSearched: boolean;
  hotQueried: boolean;
  libSearched: boolean;
}

/**
 * 新建文件时的强制查询判定。
 *
 * @param exists 文件此刻是否已存在。**已存在就直接放行** ——
 *               这三条只管新建；改已有文件是 impact 那条的事。
 */
export function judgeGraphEnforce(
  repoDir: string,
  cfg: GuardConfig,
  rel: string,
  exists: boolean,
  session?: EnforceSession,
): EnforceVerdict {
  if (!cfg.gates.admission || exists) return PASS;
  const similarSearched = () => session?.similarSearched ?? hasSimilarSearched(repoDir);
  const hotQueried = () => session?.hotQueried ?? hasHotQueried(repoDir);
  const libSearched = () => session?.libSearched ?? hasLibSearched(repoDir);
  const g = cfg.graphEnforce;
  const docs = componentDocsHint(readFacts(repoDir));

  if (
    g.newPageSimilar.enabled &&
    matches(g.newPageSimilar.pathPatterns, rel) &&
    !similarSearched()
  ) {
    return {
      blocked: true,
      kind: 'need_similar',
      reason:
        `要新建 \`${rel}\`，但本轮还没查过仓里同类实现。\n` +
        '先调 similar 工具（intent="要做什么"：前端如「带分页和搜索的列表页」，后端写资源名或方法名，如「AIMCredential」「DeleteAIMCredential」）。\n' +
        '平行再造一套写法的代价不在这次提交 —— 在半年后没人说得清这个仓有几种同类实现。',
    };
  }

  // 注意判据是 hasHotQueried 而不是 hasSimilarSearched —— 这两个问题不一样：
  // hot 回答"别改我 / 别重造"，similar 回答"照这个做"。拿一个冒充另一个，
  // 模型会拿着高扇入清单去当同类实现抄，那是错的
  if (
    g.newComponentHot.enabled &&
    matches(g.newComponentHot.pathPatterns, rel) &&
    !hotQueried()
  ) {
    return {
      blocked: true,
      kind: 'need_hot',
      reason:
        `要新建组件 \`${rel}\`，但本轮还没查过仓里的高扇入热点。\n` +
        '先调 hot 工具看有没有现成的可以复用 —— 被多个入口引用的组件通常就是你要造的那个。',
    };
  }

  if (
    g.newComponentLibSearch.enabled &&
    matches(g.newComponentLibSearch.pathPatterns, rel) &&
    !libSearched()
  ) {
    return {
      blocked: true,
      kind: 'need_lib',
      reason:
        `要新建组件 \`${rel}\`，但本轮还没查过本仓 UI 组件库。\n` +
        '先调 lib_search 工具（intent="要什么组件"，如「多选下拉」）。\n' +
        '内部组件库不在你的训练数据里 —— 凭 antd / MUI 经验写的 props 几乎一定是错的，' +
        '而且仓里很可能已经有这个组件了。' +
        (docs ? '\n' + docs : ''),
    };
  }

  return PASS;
}
