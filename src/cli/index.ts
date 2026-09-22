/**
 * CLI 入口 —— 也是整个产物的入口（`bin/repo-guard` 就是这个文件打出来的）。
 *
 * 注意这里**不要写 shebang**：它由 `build/build.mjs` 的 banner 统一加。
 * 两处都写会在产物里留下两行 shebang，第二行成了语法错误 —— 而这种错误
 * 在 hook 场景下是静默的（fail-open 全放行），所以构建脚本有一步冒烟专门守它。
 *
 * ── 三种调用形态共用一个二进制 ──
 *   repo-guard <命令>        人在终端里跑
 *   repo-guard mcp           宿主拉起的 stdio MCP server
 *   repo-guard hook <name>   宿主在事件点上调的钩子
 *
 * 合成一个文件是刻意的：三者共用图谱缓存、会话状态、红线加载，
 * 拆成三个二进制会让"AI 调 impact 之后 hook 放行"这条链路跨进程对齐变得脆弱。
 *
 * ── stdout 是协议通道 ──
 * `mcp` 的 stdout 是 JSON-RPC 帧，`hook` 的 stdout 是宿主要解析的 JSON。
 * 多输出一个字节，宿主就解析失败。所以：
 *   · 日志一律走 stderr（见 engine/shims/logger.ts）
 *   · 报错信息也走 stderr
 *   · 只有命令本身的结果走 stdout
 */
import path from 'node:path';

import { renderApiContractsAsTs, renderSimilar, type ReportContext } from '../graph/graph-report.js';
import { traceOrMiss } from './trace.js';
import { auditPolicy, formatAuditReport } from '../engine/policy-audit.js';
import { findRepoRoot, toRepoRelative } from '../runtime/paths.js';
import { readFacts, DEFAULT_LINE_LIMIT, componentDocsHint } from '../runtime/repo-facts.js';
import { hasRedlines, loadRedlines } from '../runtime/redlines.js';
import { getGraph, type GraphHandle } from '../runtime/graph-cache.js';
import { judge, missingConfig } from '../runtime/guard.js';
import {
  recordHotQuery,
  recordLibSearch,
  recordQueried,
  recordSimilarSearch,
} from '../runtime/session-state.js';
import { record } from '../runtime/metrics.js';
import { loadLibrary, searchLibrary } from '../library/library-catalog.js';
import { renderHotCli, renderImpactCli, RULE } from './render.js';
import { hasProblems, renderScanCli, scan } from './scan.js';
import { renderInit } from './init.js';
import { runHook } from '../hooks/index.js';
import { runMcp } from '../mcp/server.js';
import { renderGovernance } from './governance.js';
import { renderGuardShow, runGuardInit } from '../gates/guard-init.js';
import { loadGuardConfig } from '../gates/config.js';
import {
  renderStandardsAudit,
  renderStandardsCheck,
  renderStandardsList,
  runStandardsInit,
} from './standards.js';
import { runDoctor } from './doctor.js';
import { runRedlinesInit } from './redlines.js';
import { runLayersInit } from './layers-init.js';
import { runBootstrap } from './bootstrap.js';
import { loadStandards } from '../standards/loader.js';

const HELP = `
repo-guard —— 仓库体检与影响面工具（零服务端）

  repo-guard init [--write] [--all] 体检；--write 写 repo-facts；--all 一次铺齐全部控制文件
  repo-guard scan [--json]         体量与结构体检（超长文件、循环依赖）
  repo-guard check <文件…>          改动自查：碰没碰公共层和红线，有问题非零退出
  repo-guard impact <文件>          改它会波及哪些入口
  repo-guard hot [--limit N]       高扇入热点，写新组件前看有没有现成的
  repo-guard trace <路径>          这个页面/接口打到哪里，含反推的出入参
  repo-guard similar <要做什么>     这类页面本仓已经怎么写了
  repo-guard lib search <要什么>    UI 组件库里有没有现成的
  repo-guard contracts [接口]       反推导出接口类型草稿（必须人工 review）
  repo-guard audit                 红线体检：规则守空气没、有没有后门、证据还准不准
  repo-guard redlines init [--write] 把部门红线模板铺进 .codebuddy/redlines.json
  repo-guard governance            治理留痕报表：这些门在做有用功还是在骚扰人
  repo-guard guard init [--write]  铺开协作全景七道门的配置骨架（全部默认关）
  repo-guard guard show            打印实际生效的门禁配置（排查「配了没生效」）
  repo-guard standards list        研发规范生效清单（哪些端、哪一层、实际强度）
  repo-guard standards check <文件…> 规范自查：这些文件违反了什么，人审/硬拦级非零退出
  repo-guard standards init [--write] 铺开五端研发规范模板（默认只提醒，不拦）
  repo-guard standards audit       规范体检：有没有守空气、有没有被静默降级
  repo-guard doctor                配置体检：填完配置跑它，查 JSON 坏没坏、条目会不会静默失效
  repo-guard layers [init [--write]] 七层分类；init 铺人审/合并门禁/事实片段
  repo-guard mcp                   作为 stdio MCP 给 AI 用
  repo-guard hook <name>           插件钩子（由宿主调用）
`;

function out(s: string): void {
  process.stdout.write(s);
}

/**
 * 人看的文本输出统一走这里：**结尾恰好两个换行**。
 *
 * 为什么要统一：终端里连着跑两条命令时，输出粘在一起很难读；而各处自己拼
 * `\n` 必然有的多有的少。规范化成"末尾一个空行"最省心，也让 parity
 * 不会因为某个分支少写一个换行就报差异。
 *
 * `scan --json` 与 MCP 帧不走这里 —— 那两个是给机器解析的，多一个空行是噪音。
 */
function outText(s: string): void {
  process.stdout.write(`${s.replace(/\n+$/, '')}\n\n`);
}

function err(s: string): void {
  process.stderr.write(`${s}\n`);
}

/** 渲染上下文。engine 的 render* 需要它算新鲜度与上下文节省量 */
export function reportContext(repoDir: string, handle: GraphHandle): ReportContext {
  return {
    repoName: path.basename(repoDir),
    localPath: repoDir,
    commitSha: handle.headSha,
    indexedAt: handle.builtAt,
  };
}

/** 带值的选项。解析位置参数时要把它们的值一起跳过 */
const VALUE_FLAGS = new Set(['--limit', '--min-call-sites', '--stack']);

function flagNumber(argv: string[], name: string, fallback: number): number {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * 取位置参数。
 *
 * 必须跳过带值选项的值 —— 否则 `contracts --min-call-sites 1` 里的 `1`
 * 会被当成"只导这一条接口"的名字，命令静默返回空结果。
 * 这类 bug 不报错、只是结果不对，是最难被发现的一种。
 */
function positionals(argv: string[], from: number): string[] {
  const out: string[] = [];
  for (let i = from; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      i++; // 连它的值一起跳过
      continue;
    }
    if (a.startsWith('-')) continue;
    out.push(a);
  }
  return out;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  // hook 与 mcp 要先走：它们从 stdin 读、往 stdout 写协议数据，
  // 不能被下面任何一行 console 输出污染
  if (cmd === 'hook') return runHook(argv[1] ?? '');
  if (cmd === 'mcp') return runMcp();

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    outText(HELP);
    return 0;
  }

  const repoDir = findRepoRoot(process.cwd());

  switch (cmd) {
    case 'init': {
      const handle = await getGraph(repoDir);
      const facts = readFacts(repoDir);
      const sr = scan(repoDir, handle.graph, facts?.lineLimit ?? DEFAULT_LINE_LIMIT);
      const write = argv.includes('--write');
      const all = argv.includes('--all');
      const initText = renderInit(repoDir, handle, sr, { write }).text;
      if (!all) {
        outText(initText);
        return 0;
      }
      const extra = runBootstrap(repoDir, write);
      outText(initText + extra.text);
      return extra.exitCode;
    }

    case 'scan': {
      const handle = await getGraph(repoDir);
      const facts = readFacts(repoDir);
      const sr = scan(repoDir, handle.graph, facts?.lineLimit ?? DEFAULT_LINE_LIMIT);
      if (argv.includes('--json')) {
        out(`${JSON.stringify(sr, null, 2)}\n`);
        return 0;
      }
      outText(renderScanCli(sr));
      // 非零退出是它能挂进流水线的全部接口：`repo-guard scan || exit 1`
      return hasProblems(sr) ? 1 : 0;
    }

    case 'check': {
      const files = positionals(argv, 1);
      const facts = readFacts(repoDir);
      const snapshot = loadRedlines(repoDir);
      const missing = missingConfig(facts, snapshot);

      const lines: string[] = [''];
      if (missing.length) {
        lines.push('⚠ 本仓还没配规则，下面的结果不完整：');
        for (const m of missing) lines.push(`   · ${m}`);
        lines.push('   跑 `repo-guard init --write` 生成配置。');
        lines.push('');
      }

      const verdicts = files
        .map((f) => judge(repoDir, facts, snapshot, f))
        .filter((v): v is NonNullable<typeof v> => v !== null);

      lines.push(`检查 ${verdicts.length} 个文件`);

      const publicHits = verdicts.filter((v) => v.publicPrefix);
      const ruleHits = verdicts.filter((v) => v.rules.length);

      if (publicHits.length) {
        lines.push('', `碰到公共层 ${publicHits.length} 个 —— 改这些之前应确认影响面：`);
        for (const v of publicHits) lines.push(`  · ${v.rel}`);
      }
      if (ruleHits.length) {
        const total = ruleHits.reduce((n, v) => n + v.rules.length, 0);
        lines.push('', `命中红线 ${total} 条：`);
        for (const v of ruleHits) {
          for (const r of v.rules) {
            lines.push(`  · [${r.id}] ${v.rel} —— ${r.rule}`);
            record('redline_hit', repoDir, { file: v.rel, rule: r.id });
          }
        }
      }
      if (!publicHits.length && !ruleHits.length) {
        // 配置不全时不能说"没命中"就完了 —— 那会被读成"安全"，
        // 而真相是"我们没有能力判断"。这两件事差别很大。
        lines.push('', missing.length ? '在已有配置范围内没命中 —— 但配置不全，不等于安全。' : '✓ 没有命中');
      }

      outText(lines.join("\n"));
      return ruleHits.length ? 1 : 0;
    }

    case 'impact': {
      const raw = argv[1];
      if (!raw) {
        err('用法：repo-guard impact <文件>');
        return 2;
      }
      const rel = toRepoRelative(repoDir, raw);
      if (!rel) {
        err('路径不在仓库里');
        return 2;
      }
      const handle = await getGraph(repoDir);
      recordQueried(repoDir, rel);
      record('graph_query', repoDir, { file: rel, detail: 'impact' });
      outText(renderImpactCli(handle.graph, rel));
      return 0;
    }

    case 'hot': {
      const handle = await getGraph(repoDir);
      recordHotQuery(repoDir);
      record('graph_query', repoDir, { detail: 'hot' });
      outText(renderHotCli(handle.graph, flagNumber(argv, "--limit", 10)));
      return 0;
    }

    case 'trace': {
      const urlPath = argv[1];
      if (!urlPath) {
        err('用法：repo-guard trace <路径>');
        return 2;
      }
      const handle = await getGraph(repoDir);
      record('graph_query', repoDir, { detail: 'trace' });
      outText(`\n${traceOrMiss(handle.graph, urlPath, reportContext(repoDir, handle))}`);
      return 0;
    }

    case 'similar': {
      const intent = positionals(argv, 1).join(' ');
      if (!intent) {
        err('用法：repo-guard similar <要做什么>');
        return 2;
      }
      const handle = await getGraph(repoDir);
      recordSimilarSearch(repoDir, intent);
      record('graph_query', repoDir, { detail: 'similar' });
      outText(`\n${renderSimilar(handle.graph, { intent, limit: flagNumber(argv, "--limit", 3) }, reportContext(repoDir, handle))}`);
      return 0;
    }

    case 'lib': {
      if (argv[1] !== 'search') {
        err('用法：repo-guard lib search <要什么>');
        return 2;
      }
      const intent = positionals(argv, 2).join(' ');
      if (!intent) {
        err('用法：repo-guard lib search <要什么>');
        return 2;
      }
      const facts = readFacts(repoDir);
      const info = loadLibrary(repoDir, facts?.componentLibrary ?? null);
      recordLibSearch(repoDir, intent);
      record('graph_query', repoDir, { detail: 'lib_search' });
      outText(`\n${appendDocsHint(renderLibSearch(info, intent, flagNumber(argv, "--limit", 5)), facts)}`);
      return 0;
    }

    case 'contracts': {
      const api = positionals(argv, 1)[0];
      const handle = await getGraph(repoDir);
      record('graph_query', repoDir, { detail: 'contracts' });
      outText(
        renderApiContractsAsTs(handle.graph, {
          api,
          minCallSites: flagNumber(argv, '--min-call-sites', 2),
        }),
      );
      return 0;
    }

    case 'audit': {
      if (!hasRedlines(repoDir)) {
        // 这条要走 stderr + 非零：`audit` 是给人和流水线用的，
        // "没有红线可体检"不是成功
        err('本仓没有 .codebuddy/redlines.json —— 还没有红线可体检。');
        err('红线是人写的意图（"外部仍有调用方"这种事静态分析推不出来），要人先写。');
        return 2;
      }
      const snapshot = loadRedlines(repoDir);
      const report = auditPolicy(snapshot, repoDir);
      outText(`\n${formatAuditReport(report)}`);
      // 有问题非零：红线腐烂要能卡流水线，否则没人会定期跑。
      // 判据用 severity 而不是"有没有 finding" —— info 级（如未声明 paths）
      // 不是缺陷，拿它卡流水线会让人把这一步关掉。
      return report.rules.some((r) => r.severity === 'warn' || r.severity === 'error') ? 1 : 0;
    }

    case 'guard': {
      const sub = positionals(argv, 1)[0];
      if (sub === 'show') {
        // 回答「我配了为什么没生效」。三种常见原因：目录位置不对、
        // 总闸没开、某一项的 enabled 忘了改 —— 都能在这份输出里一眼看到
        outText(renderGuardShow(repoDir, loadGuardConfig(repoDir)));
        return 0;
      }
      if (sub !== 'init') {
        err('用法：repo-guard guard init [--write] | repo-guard guard show');
        return 2;
      }
      const r = runGuardInit(repoDir, argv.includes('--write'));
      outText(r.text);
      return r.exitCode;
    }

    case 'governance': {
      outText(renderGovernance(repoDir));
      return 0;
    }

    case 'standards': {
      const sub = positionals(argv, 1)[0];

      if (sub === 'init') {
        const r = runStandardsInit(repoDir, argv.includes('--write'));
        outText(r.text);
        return r.exitCode;
      }

      // 其余三个子命令都要先加载快照。facts 可能为 null（还没跑过 init）——
      // 那时端探测只能靠目录特征，__PUBLIC_LAYER__ 展开成空
      const snap = loadStandards(repoDir, readFacts(repoDir));

      if (sub === 'list') {
        const i = argv.indexOf('--stack');
        outText(renderStandardsList(snap, i >= 0 ? argv[i + 1] : undefined));
        return 0;
      }
      if (sub === 'check') {
        const r = renderStandardsCheck(repoDir, snap, positionals(argv, 2));
        outText(r.text);
        return r.exitCode;
      }
      if (sub === 'audit') {
        const r = renderStandardsAudit(snap);
        outText(r.text);
        return r.exitCode;
      }

      err('用法：repo-guard standards list [--stack <端>] | check <文件…> | init [--write] | audit');
      return 2;
    }

    case 'redlines': {
      if (positionals(argv, 1)[0] !== 'init') {
        err('用法：repo-guard redlines init [--write]');
        return 2;
      }
      const r = runRedlinesInit(repoDir, argv.includes('--write'));
      outText(r.text);
      return r.exitCode;
    }

    case 'doctor': {
      // 强制全端：填配置的人要检查自己填的全部条目，而不只是当前仓库探测到的那几端
      const snap = loadStandards(repoDir, readFacts(repoDir), { forceAllStacks: true });
      const r = runDoctor(repoDir, snap);
      outText(r.text);
      return r.exitCode;
    }

    case 'layers': {
      const sub = positionals(argv, 1)[0];
      if (sub === 'init') {
        const r = runLayersInit(repoDir, argv.includes('--write'));
        outText(r.text);
        return r.exitCode;
      }
      outText(
        '\n七层（开发者往 layers/ 加内容，详见 docs/DESIGN-SEVEN-LAYERS.md）\n\n' +
          '  1 工程事实     layers/facts/           CODEBUDDY.md + rules\n' +
          '  2 技能库       skills/                 T2 索引 / T6 正文\n' +
          '  3 红线         layers/redlines/        T7a deny 或人审 ask\n' +
          '  4 过程门禁     layers/process-gates/   ReAct 内机器关\n' +
          '  5 人审         layers/human-review/    T7b ask，默认关\n' +
          '  6 合并门禁     layers/merge-gates/     非 ReAct：CI / permissions.ask\n' +
          '  7 图谱         layers/graph/ + src/graph/  MCP + require_tool；源码在本仓\n\n' +
          '铺项目骨架：repo-guard layers init [--write]\n',
      );
      return 0;
    }

    default:
      err(`未知命令：${cmd}`);
      outText(HELP);
      return 2;
  }
}

/**
 * 组件库检索的渲染。
 *
 * 尾注那句话是这个工具存在的理由：**内部组件库不在模型训练数据里**。
 * 模型会凭 antd / MUI 的经验写 props，名字对、类型错，要到运行时才炸。
 */
function appendDocsHint(body: string, facts: ReturnType<typeof readFacts>): string {
  const h = componentDocsHint(facts);
  return h ? body + '\n\n' + h : body;
}

function renderLibSearch(
  info: ReturnType<typeof loadLibrary>,
  intent: string,
  limit: number,
): string {
  if (!info.pkg) {
    return (
      '本仓没有识别到 UI 组件库。\n' +
      `如果确实有，可以在 .codebuddy/repo-facts.json 里手动指定 componentLibrary。`
    );
  }
  const hits = searchLibrary(info, intent, limit);
  const head = `组件库 ${info.pkg} · 共 ${info.entries.length} 个导出 · 检索「${intent}」`;
  if (!hits.length) {
    return `${head}\n\n没有相近的导出 —— 可以自己写，但仍建议先看仓内高扇入热点。`;
  }
  const lines = [head, ''];
  for (const h of hits) {
    lines.push(`  ${h.name}　[${h.category}]`);
    if (h.oneLiner) lines.push(`      ${h.oneLiner}`);
  }
  lines.push(
    '',
    '命中就别自己造。用之前先查它的 props —— 内部组件库不在模型训练数据里，凭经验写几乎一定错。',
  );
  return lines.join('\n');
}

export { renderLibSearch };

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // 兜底：任何未捕获异常都要写 stderr 并非零退出，绝不能静默。
    // 静默失败在 hook 场景下会表现为"守卫时灵时不灵"，是最难查的一类问题。
    err(`repo-guard 内部错误：${(e as Error).stack ?? String(e)}`);
    process.exit(3);
  });
