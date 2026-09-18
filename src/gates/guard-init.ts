/**
 * `guard init` —— 把 `templates/guard/` 铺到被守护仓库的 `.codebuddy/guard/`。
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

import { CONFIG_DIR } from '../runtime/paths.js';
import { GUARD_DIR, guardDirOf, templateDir, type GuardConfig } from './config.js';
import { RULE } from '../cli/render.js';

export interface GuardInitResult {
  text: string;
  exitCode: number;
}

/** 递归列出模板里的相对路径（只要 .json，README 不铺过去） */
function listTemplate(dir: string, base = dir, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      listTemplate(full, base, out);
      continue;
    }
    // README.md 是给开发者看的，不该出现在用户仓库里 ——
    // 用户仓库里的 .codebuddy/guard/ 应该只有配置
    if (!e.name.endsWith('.json')) continue;
    out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
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
  lines.push(`配置目录  ${CONFIG_DIR}/${GUARD_DIR}/  ${cfg.present ? '已找到' : '**不存在** → 全部走默认（全关）'}`);

  lines.push('', '总闸');
  const gateNote: Record<string, string> = {
    L0_inject: '注入面（只推不拦）',
    L1_admission: '准入门（红线硬拦 / 禁改 / 范围门 / 图谱强制）',
    L3_loop: '循环门（重复调用 / 连续失败 / 同文件写失败）',
    L4_signals: '诚实信号（纯观测）',
    L5_delivery: '交付门（工程校验 / 交付瘦身）',
    L6_governance: '治理留痕',
  };
  for (const [k, v] of Object.entries(cfg.gates)) {
    lines.push(`  ${v ? '开' : '关'}  ${k.padEnd(14)} ${gateNote[k] ?? ''}`);
  }
  lines.push('  --  L2_execution  执行门 → 交宿主的 permissions / sandbox，插件永不实现');

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
    ['新建页面→similar ', g.newPageSimilar],
    ['新建组件→hot     ', g.newComponentHot],
    ['新建组件→lib     ', g.newComponentLibSearch],
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

  lines.push('', `需求复述    ${cfg.restate.enabled ? '开' : '关'}（零阻塞，只注入提醒）`);

  // 常见的"配了没生效"都出在这几处，直接点出来比让人自己找快得多
  const hints: string[] = [];
  if (cfg.present && !cfg.gates.L1_admission) {
    hints.push('L1 总闸是关的 —— 红线硬拦 / 禁改 / 范围门 / 图谱强制**全部不生效**，哪怕它们各自的 enabled 是 true。');
  }
  if (cfg.present && !cfg.gates.L5_delivery && cfg.delivery.enabled) {
    hints.push('delivery.json 的 enabled 是 true，但 L5 总闸关着 —— 不生效。');
  }
  if (cfg.present && !cfg.gates.L3_loop && cfg.loop.enabled) {
    hints.push('loop.json 的 enabled 是 true，但 L3 总闸关着 —— 不生效。');
  }
  if (hints.length) {
    lines.push('', '⚠ 注意');
    for (const h of hints) lines.push(`  · ${h}`);
  }

  void repoDir;
  return `${lines.join('\n')}\n`;
}

export function runGuardInit(repoDir: string, write: boolean): GuardInitResult {
  const tpl = templateDir();
  const files = listTemplate(tpl);
  const target = guardDirOf(repoDir);

  if (!files.length) {
    return {
      text:
        `\n找不到配置模板：${tpl}\n` +
        '这通常意味着插件产物与 templates/ 目录被分开了 —— ' +
        '`bin/repo-guard` 与 `templates/` 必须在同一个插件目录下。\n',
      exitCode: 2,
    };
  }

  const lines = ['', 'repo-guard · 协作全景配置骨架', RULE];

  const fresh: string[] = [];
  const existing: string[] = [];
  for (const rel of files) {
    (fs.existsSync(path.join(target, rel)) ? existing : fresh).push(rel);
  }

  lines.push(`目标    ${CONFIG_DIR}/${GUARD_DIR}/`);
  lines.push(`模板    ${files.length} 个配置文件`);

  if (existing.length) {
    lines.push('', `已存在 ${existing.length} 个，**不会覆盖**：`);
    for (const rel of existing) lines.push(`    - ${rel}`);
    lines.push('    模板若有新增字段，请自己对照 templates/guard/ 补。');
  }
  if (fresh.length) {
    lines.push('', `将写入 ${fresh.length} 个：`);
    for (const rel of fresh) lines.push(`    + ${rel}`);
  }

  lines.push(
    '',
    '铺过去之后要做两件事：',
    '  1. 进 git —— 这些是团队共识，不是个人偏好',
    '  2. 逐个打开看注释。**所有门默认关**，装完不会有任何新的拦截；',
    '     想开哪道门就把对应的 enabled 改成 true',
  );

  if (!write) {
    lines.push('', '要写入请加 --write');
    return { text: `${lines.join('\n')}\n`, exitCode: 0 };
  }

  if (!fresh.length) {
    lines.push('', '没有需要写入的文件。');
    return { text: `${lines.join('\n')}\n`, exitCode: 0 };
  }

  let written = 0;
  const failed: string[] = [];
  for (const rel of fresh) {
    try {
      const dst = path.join(target, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(tpl, rel), dst);
      written++;
    } catch (e) {
      failed.push(`${rel}（${(e as Error).message}）`);
    }
  }

  lines.push('', `已写入  ${written} 个文件到 ${CONFIG_DIR}/${GUARD_DIR}/`);
  if (failed.length) {
    lines.push('', `写入失败 ${failed.length} 个：`);
    for (const f of failed) lines.push(`    ${f}`);
  }

  return { text: `${lines.join('\n')}\n`, exitCode: failed.length ? 1 : 0 };
}
