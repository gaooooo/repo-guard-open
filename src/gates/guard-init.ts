/**
 * `guard init` —— 把 layers/ 里过程门禁 + 事实/技能的 JSON 铺到 `.codebuddy/guard/`。
 *
 * ── 为什么默认一个字节都不写 ──
 * 和 `init` 同一条纪律：工具擅自改人的仓库是最快失去信任的方式。
 * 不带 `--write` 时只报告"会铺哪些文件、哪些已存在"。
 *
 * ── 为什么已存在的文件绝不覆盖 ──
 * 这些文件铺过去之后就是**人写的团队共识**（章程、禁忌、必读清单）。
 * 重跑一次把人写的东西冲掉，是不可接受的数据丢失。所以已存在即跳过，
 * 并在报告里标出来 —— 让人自己去比对模板有没有新增字段。
 */
import fs from 'node:fs';
import path from 'node:path';

import { configPath, pluginPath } from '../runtime/paths.js';
import { FACTS_FILE, PROCESS_GATES_FILE, type GuardConfig } from './config.js';
import { RULE } from '../cli/render.js';
import { ensureFactsFromRepo, factsInitNote } from '../cli/facts-from-repo.js';
import { ensureProcessGatesFromRepo, fillComponentFacts } from '../cli/process-gates-from-repo.js';

export interface GuardInitResult {
  text: string;
  exitCode: number;
}

/** 递归列出模板里的相对路径（只要 .json，README 不铺过去） */
interface GuardTplFile { src: string; dest: string; }

function listGuardTemplates(): GuardTplFile[] {
  const out: GuardTplFile[] = [];
  const walk = (dir: string, destPrefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, destPrefix ? destPrefix + "/" + e.name : e.name);
        continue;
      }
      if (!e.name.endsWith(".json")) continue;
      const dest = destPrefix ? destPrefix + "/" + e.name : e.name;
      out.push({ src: full, dest });
    }
  };
  walk(pluginPath("layers", "process-gates"), "");
  const extras: Array<{ parts: string[]; dest: string }> = [
    { parts: ["layers", "facts", "charter.json"], dest: "identity/charter.json" },
    { parts: ["layers", "facts", "project-knowledge.json"], dest: "capability/project-knowledge.json" },
    { parts: ["layers", "skills", "task-routes.json"], dest: "capability/task-routes.json" },
  ];
  for (const x of extras) {
    const src = pluginPath(...x.parts);
    if (fs.existsSync(src)) out.push({ src, dest: x.dest });
  }
  return out.sort((a, b) => a.dest.localeCompare(b.dest));
}

/**
 * `guard show` —— 把**实际生效**的配置打出来。
 *
 * 这个命令回答的是一个必然会被问到的问题：「我配了，为什么没生效」。
 * 原因通常是三种：配置目录位置不对、总闸没开、某一项的 enabled 忘了改。
 * 没有这个命令，人只能靠猜 —— 而门禁"看起来配了但实际没生效"是最坏的状态，
 * 比明确没配更危险（人以为有保护）。
 */
export function renderGuardShow(repoDir: string, cfg: GuardConfig): string {
  const lines = ['', 'repo-guard · 实际生效的门禁配置', RULE];
  lines.push(`配置文件  .codebuddy/process-gates.json + facts.json  ${cfg.present ? '已找到' : '**不存在** → 全部走默认（全关）'}`);

  lines.push('', '总闸');
  const gateNote: Record<string, string> = {
    inject: '注入面（只推不拦）',
    admission: '准入门（红线硬拦 / 禁改 / 范围门 / 图谱强制）',
    loop: '循环门（重复调用 / 连续失败 / 同文件写失败）',
    signals: '诚实信号（纯观测）',
    delivery: '交付门（工程校验 / 交付瘦身）',
    governance: '治理留痕',
  };
  for (const [k, v] of Object.entries(cfg.gates)) {
    lines.push(`  ${v ? '开' : '关'}  ${k.padEnd(14)} ${gateNote[k] ?? ''}`);
  }
  lines.push('  --  execution  交给宿主 permissions / sandbox，插件不实现');

  lines.push('', '注入面内容');
  lines.push(`  项目使命    ${cfg.inject.mission ? '有' : '空'}`);
  lines.push(`  项目事实    ${cfg.inject.facts.length} 条`);
  lines.push(`  常驻纪律    ${cfg.inject.discipline.length} 条`);
  lines.push(`  项目知识    ${cfg.inject.knowledge.length} 条（只算 enabled=true 的）`);
  lines.push(`  团队禁忌    ${cfg.inject.taboos.length} 条`);
  lines.push(`  停止条件    ${cfg.inject.stopConditions.length} 条`);
  lines.push(`  任务路由    ${cfg.inject.taskRoutes.length} 条（只算 enabled=true 且 match 非空的）`);

  lines.push('', '准入门');
  lines.push(`  禁改清单    ${cfg.noRefactor.length} 条`);
  lines.push(
    `  范围门      ${cfg.scopeGate.enabled ? '开' : '关'}` +
      `  allowlist=${cfg.scopeGate.allowlist.length} 条  maxFiles=${cfg.scopeGate.maxFiles ?? '不限'}`,
  );
  const g = cfg.graphEnforce;
  lines.push('  图谱强制');
  lines.push('    改公共层→impact   开（核心功能，不可关）');
  for (const [label, sub] of [
    ['新建页/接口→similar', g.newPageSimilar],
    ['新建公共符号→hot  ', g.newComponentHot],
    ['新建 UI 组件→lib ', g.newComponentLibSearch],
  ] as const) {
    lines.push(
      `    ${label} ${sub.enabled ? '开' : '关'}` +
        (sub.enabled && !sub.pathPatterns.length
          ? '  ⚠ 开了但 pathPatterns 是空的 —— 不会命中任何文件，等于没开'
          : sub.pathPatterns.length
            ? `  pathPatterns=${sub.pathPatterns.join(' ')}`
            : ''),
    );
  }

  lines.push('', '循环门');
  lines.push(
    `  ${cfg.loop.enabled ? '开' : '关'}  重复 ${cfg.loop.repeatToolCallThreshold} 次 / ` +
      `连败 ${cfg.loop.consecutiveFailThreshold} 次 / 同文件写失败 ${cfg.loop.sameFileWriteFailThreshold} 次`,
  );
  lines.push(`      迭代预算 ${cfg.loop.maxIterations}（只能近似观测，不拦）`);

  lines.push('', '交付门');
  lines.push(`  ${cfg.delivery.enabled ? '开' : '关'}`);
  lines.push(
    `      工程校验  ${cfg.delivery.engineeringCheck.enabled ? '开' : '关'}  mode=${cfg.delivery.engineeringCheck.mode}`,
  );
  lines.push(
    `      交付瘦身  ${cfg.delivery.deliveryBudget.enabled ? '开' : '关'}  ` +
      `maxDeliveryFiles=${cfg.delivery.deliveryBudget.maxDeliveryFiles ?? '不限'}`,
  );
  lines.push(`      AI 审查   ${cfg.review.enabled ? '开' : '关'}`);

  // 常见的"配了没生效"都出在这几处，直接点出来比让人自己找快得多
  const hints: string[] = [];
  if (cfg.present && !cfg.gates.admission) {
    hints.push('admission 总闸是关的 —— 红线硬拦 / 禁改 / 范围门 / 图谱强制**全部不生效**，哪怕它们各自的 enabled 是 true。');
  }
  if (cfg.present && !cfg.gates.delivery && cfg.delivery.enabled) {
    hints.push('delivery.json 的 enabled 是 true，但 gates.delivery 总闸关着 —— 不生效。');
  }
  if (cfg.present && !cfg.gates.loop && cfg.loop.enabled) {
    hints.push('loop.json 的 enabled 是 true，但 gates.loop 总闸关着 —— 不生效。');
  }
  if (hints.length) {
    lines.push('', '⚠ 注意');
    for (const h of hints) lines.push(`  · ${h}`);
  }

  void repoDir;
  return `${lines.join('\n')}\n`;
}

export function runGuardInit(repoDir: string, write: boolean): GuardInitResult {
  const pgSrc = pluginPath('layers', 'process-gates', 'process-gates.json');
  const pgDest = configPath(repoDir, PROCESS_GATES_FILE);
  const factsDest = configPath(repoDir, FACTS_FILE);
  const lines = ['', 'repo-guard · 过程门禁 + 工程事实', RULE];

  if (!fs.existsSync(pgSrc)) {
    return { text: '\n找不到过程门禁模板 layers/process-gates/process-gates.json。\n', exitCode: 2 };
  }

  const pgExists = fs.existsSync(pgDest);
  const factsExists = fs.existsSync(factsDest);
  lines.push(
    pgExists
      ? '已存在 .codebuddy/process-gates.json  —— 会按本仓目录补 similar/hot/lib 的 pathPatterns（不覆盖人填过的）'
      : '将写入 .codebuddy/process-gates.json  （按本仓目录填 pathPatterns，enabled 默认关）',
  );
  lines.push(
    factsExists
      ? '已存在 .codebuddy/facts.json  —— 不会覆盖'
      : '将写入 .codebuddy/facts.json  （' + factsInitNote(false) + '）',
  );
  lines.push('若已有 repo-facts.json：空的 componentLibrary / 缺的 componentMcp 会按 package.json 补');

  if (!write) {
    lines.push('', '要写入请加 --write');
    return { text: lines.join('\n') + '\n', exitCode: 0 };
  }

  try {
    fs.mkdirSync(path.dirname(pgDest), { recursive: true });
    for (const n of ensureProcessGatesFromRepo(repoDir, pgDest)) lines.push(n);
    const factsAct = ensureFactsFromRepo(repoDir, factsDest);
    lines.push(
      factsAct === 'skip'
        ? 'skip  .codebuddy/facts.json'
        : 'write .codebuddy/facts.json  -- ' + factsInitNote(false),
    );
    for (const n of fillComponentFacts(repoDir)) lines.push('  ' + n);
  } catch {
    lines.push('', '写入失败');
    return { text: lines.join('\n') + '\n', exitCode: 1 };
  }

  lines.push(
    '',
    'facts.json 按本仓生成；停止条件写在 stopConditions。图谱强制默认关，打开 admission 并把对应 enabled 设为 true 才硬拦。',
  );
  return { text: lines.join('\n') + '\n', exitCode: 0 };
}
