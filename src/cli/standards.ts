/**
 * `standards` 命令族 —— 规范的只读视图与铺设。
 *
 * ── 四个子命令各回答一个必然会被问到的问题 ──
 *   list   「到底哪些规范在生效、来自哪一层、强度是多少」
 *   check  「我改的这几个文件违反了什么」—— 唯一能挂 CI 的一条
 *   init   「怎么把模板铺到我的仓库里」
 *   audit  「我配的规范腐烂了没」
 *
 * ── 判定逻辑全在 `standards/evaluate.ts`，这里只负责渲染 ──
 * `check` 与 `post-write` 钩子必须用同一份判定：各写一套的后果是"自查说没问题、
 * 实际被提醒"或者反过来，那比没有自查更糟，因为它给出虚假的结论。
 */
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_DIR, configPath, toRepoRelative } from '../runtime/paths.js';
import { RULE } from './text.js';
import {
  STANDARDS_DIR,
  standardsDirOf,
  standardsTemplateDir,
  stackSourceFiles,
  type StandardsSnapshot,
} from '../standards/loader.js';
import { scanFile, sessionLevelItems, type StandardHit } from '../standards/evaluate.js';
import {
  ALL_STACKS,
  effectiveSeverity,
  type Severity,
} from '../standards/schema.js';

export interface StandardsResult {
  text: string;
  exitCode: number;
}

const SEV_LABEL: Record<Severity, string> = {
  inject: '注入',
  remind: '提醒',
  ask: '人审',
  block: '硬拦',
};

function head(title: string): string[] {
  return ['', `repo-guard · ${title}`, RULE];
}

function switchboardLines(snap: StandardsSnapshot): string[] {
  const sb = snap.switchboard;
  return [
    `总闸      ${sb.enabled ? '开' : '关'}`,
    `强度上限  ${sb.maxSeverity}（${SEV_LABEL[sb.maxSeverity]}）—— 高于它的条目一律降到这一档`,
    `项目层    ${CONFIG_DIR}/${STANDARDS_DIR}/  ${snap.projectPresent ? '已找到' : '不存在 → 只有全局层生效'}`,
  ];
}

/**
 * `standards list` —— 生效清单。
 *
 * 按端分组而不是按强度分组：人来看这份输出时问的是「我这个仓在被什么约束」，
 * 而端是他心里的分类方式。强度作为每行的前缀。
 */
export function renderStandardsList(snap: StandardsSnapshot, onlyStack?: string): string {
  const lines = head('研发规范生效清单');
  lines.push(...switchboardLines(snap));

  if (!snap.enabled) {
    lines.push('', `规范未启用：${snap.stackReasons._ ?? '总闸关闭'}`);
    return `${lines.join('\n')}\n`;
  }

  lines.push('', '端');
  for (const stack of ALL_STACKS) {
    const on = snap.activeStacks.includes(stack);
    lines.push(`  ${on ? '启用' : '跳过'}  ${stack.padEnd(18)} ${snap.stackReasons[stack] ?? ''}`);
  }

  const items = snap.items.filter((i) => !onlyStack || i.stack === onlyStack);
  if (!items.length) {
    lines.push('', onlyStack ? `端 ${onlyStack} 没有条目（可能没启用）` : '没有任何条目');
    return `${lines.join('\n')}\n`;
  }

  let downgraded = 0;
  for (const stack of ALL_STACKS) {
    const group = items.filter((i) => i.stack === stack);
    if (!group.length) continue;
    lines.push('', `${stack}（${group.length} 条）`);
    for (const item of group) {
      const eff = effectiveSeverity(item, snap.switchboard.maxSeverity);
      // 已关闭的条目不显示降级行 —— 它根本不生效，"声明 block 实际 remind"
      // 这句话在这里是误导
      const showDowngrade = item.enabled && Boolean(eff.downgradedFrom);
      if (showDowngrade) downgraded++;
      const flags: string[] = [];
      if (!item.enabled) flags.push('已关闭');
      if (item.source === 'project') flags.push('项目层');
      if (!item.landing.includes('plugin')) flags.push(`落点=${item.landing.join('/')}`);
      lines.push(
        `  [${item.enabled ? SEV_LABEL[eff.severity] : '——'}] ${item.id.padEnd(14)} ${item.title}` +
          (flags.length ? `　（${flags.join('，')}）` : ''),
      );
      if (showDowngrade) {
        lines.push(`           ↳ 声明 ${eff.downgradedFrom} → 实际 ${eff.severity}：${eff.reason}`);
      }
    }
  }

  const enabled = items.filter((i) => i.enabled).length;
  lines.push(
    '',
    `共 ${items.length} 条，启用 ${enabled} 条，被降级 ${downgraded} 条。`,
    '降级不是 bug —— block 要同时满足 paths 非空、confirmed=true、判据够硬三条。',
  );

  if (snap.warnings.length) {
    lines.push('', `⚠ 合并告警 ${snap.warnings.length} 条：`);
    for (const w of snap.warnings) lines.push(`  · [${w.id}] ${w.message}`);
  }

  return `${lines.join('\n')}\n`;
}

// ── check ──

/**
 * `standards check <文件…>` —— 改动自查。
 *
 * 退出码：命中 ask/block 级 → 1，否则 0。这是它能挂进流水线的全部接口。
 * `remind` 级不算失败 —— 那些判据是启发式的，拿它卡流水线第一次误判就会被关掉。
 *
 * ── 只判定文件级条目 ──
 * `none`（只注入）与 `require_evidence`（会话内有没有跑过校验）都不是按文件判定的。
 * 把它们也按文件报，等于每个文件后面都跟一串"不编造字段""CI 不绿不许合"——
 * 那不是自查结果，是噪音，而噪音会让人不看这份输出。
 */
export function renderStandardsCheck(
  repoDir: string,
  snap: StandardsSnapshot,
  files: string[],
): StandardsResult {
  const lines = head('规范自查');
  lines.push(...switchboardLines(snap));

  if (!snap.enabled) {
    lines.push('', `规范未启用：${snap.stackReasons._ ?? '总闸关闭'}`);
    return { text: `${lines.join('\n')}\n`, exitCode: 0 };
  }
  if (!files.length) {
    lines.push('', '用法：repo-guard standards check <文件…>');
    return { text: `${lines.join('\n')}\n`, exitCode: 2 };
  }

  const outside: string[] = [];
  const results: Array<{ rel: string; hits: StandardHit[] }> = [];

  for (const raw of files) {
    const rel = toRepoRelative(repoDir, raw);
    if (!rel) {
      outside.push(raw);
      continue;
    }
    // 不按时机过滤：人主动跑自查时想看的是"这个文件违反了什么"，
    // 而不是"写完那一刻会被提醒什么"
    results.push({ rel, hits: scanFile(snap, repoDir, rel, null) });
  }

  lines.push('', `检查 ${results.length} 个文件`);
  if (outside.length) {
    lines.push('', `${outside.length} 个路径不在仓库里，已跳过：`);
    for (const o of outside) lines.push(`  · ${o}`);
  }

  let hard = 0;
  let soft = 0;
  for (const r of results) {
    if (!r.hits.length) continue;
    lines.push('', `${r.rel}`);
    for (const h of r.hits) {
      const isHard = h.severity === 'ask' || h.severity === 'block';
      if (isHard) hard++;
      else soft++;
      lines.push(`  [${SEV_LABEL[h.severity]}] ${h.item.id}  ${h.item.title}`);
      for (const e of h.evidence.slice(0, 5)) {
        lines.push(`        ${r.rel}:${e.line}  ${e.message}`);
      }
      if (h.evidence.length > 5) {
        lines.push(`        …… 还有 ${h.evidence.length - 5} 处`);
      }
      if (h.item.check.kind === 'require_tool' && h.item.check.tool) {
        lines.push(`        改之前要先跑：repo-guard ${h.item.check.tool.replace('_', ' ')}`);
      }
      if (h.item.hint) lines.push(`        → ${h.item.hint}`);
    }
  }

  if (!hard && !soft) {
    lines.push(
      '',
      snap.projectPresent
        ? '✓ 在已启用的规范范围内没有命中'
        : '✓ 没有命中 —— 但项目层规范还没铺（跑 `repo-guard standards init --write`），这只是全局层的结论。',
    );
  } else {
    lines.push('', `命中：人审/硬拦 ${hard} 条，提醒 ${soft} 条。`);
    lines.push('提醒级不影响退出码 —— 那些判据是启发式的，拿它卡流水线会被关掉。');
  }

  const sessionLevel = sessionLevelItems(snap);
  if (sessionLevel.length) {
    lines.push(
      '',
      `另有 ${sessionLevel.length} 条会话级规范不按文件判定（只注入 / 看有没有跑过校验），跑 \`standards list\` 看全量。`,
    );
  }

  if (!snap.projectPresent) {
    lines.push(
      '',
      '⚠ 项目层未铺设，所以**运行时不会有任何注入或提醒** —— 全局层只用于 CLI 自查。',
      '  要让规范在 AI 写代码过程中生效，跑 `repo-guard standards init --write`。',
    );
  }

  return { text: `${lines.join('\n')}\n`, exitCode: hard ? 1 : 0 };
}

// ── init ──

/**
 * 模板目录里要铺过去的全部文件，相对 `tpl` 的 posix 路径。
 *
 * 用 `stackSourceFiles` 枚举而不是拼 `STACK_FILES` —— 分片目录下的文件
 * 也要铺过去，而枚举规则（排序、跳过 `_` 前缀）必须与运行时加载**完全一致**。
 * 两边各写一套的后果是"铺过去的文件运行时不读"或者反过来。
 *
 * `_` 开头的文件有意不铺：那是给部门看的填空说明，项目层只写要覆盖的字段，
 * 不需要整份指南。README.md 同理（现有行为，保持不变）。
 */
function templateFileList(tpl: string): string[] {
  const out: string[] = [];
  if (fs.existsSync(path.join(tpl, 'standards.json'))) out.push('standards.json');
  for (const s of ALL_STACKS) {
    for (const abs of stackSourceFiles(tpl, s)) {
      out.push(path.relative(tpl, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

/**
 * `standards init [--write]` —— 把模板铺到 `<repo>/.codebuddy/standards/`。
 *
 * 与 `guard init` 同一条纪律：默认一个字节都不写；已存在的文件绝不覆盖。
 * 铺过去的是**团队共识**，重跑一次把人写的覆盖掉是不可接受的数据丢失。
 */
export function runStandardsInit(repoDir: string, write: boolean): StandardsResult {
  const src = path.join(standardsTemplateDir(), "standards.json");
  const dest = configPath(repoDir, "standards.json");
  const lines = head("研发规范总闸");
  if (!fs.existsSync(src)) {
    return { text: lines.join("\n") + "\n\n找不到规范模板\n", exitCode: 2 };
  }
  lines.push("目标    .codebuddy/standards.json  （只写总闸，条目用插件全局层）");
  if (fs.existsSync(dest)) {
    lines.push("", "已存在，不会覆盖。");
    return { text: lines.join("\n") + "\n", exitCode: 0 };
  }
  lines.push("", "将写入 1 个文件。maxSeverity 默认 remind，不硬拦。");
  lines.push("纯前端仓请把 stacks.database / message-queue 设成 off。");
  if (!write) {
    lines.push("", "要写入请加 --write");
    return { text: lines.join("\n") + "\n", exitCode: 0 };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(src, "utf-8"));
    const thin = {
      _: "规范总闸。条目在插件里；这里只改开关。要覆盖某条再建 .codebuddy/standards/ 写同 id。",
      version: raw.version ?? 1,
      enabled: raw.enabled !== false,
      maxSeverity: raw.maxSeverity ?? "remind",
      stacks: raw.stacks ?? {},
      injectBudgetTokens: raw.injectBudgetTokens ?? 1500,
      stackDetect: raw.stackDetect ?? {},
    };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(thin, null, 2) + "\n");
  } catch (e) {
    lines.push("", "写入失败");
    return { text: lines.join("\n") + "\n", exitCode: 1 };
  }
  lines.push("", "已写入  .codebuddy/standards.json");
  return { text: lines.join("\n") + "\n", exitCode: 0 };
}

// ── audit ──

export interface Finding {
  level: 'error' | 'warn' | 'info';
  id: string;
  message: string;
}

/**
 * 算出规范的全部体检发现。**渲染留在调用方**。
 *
 * 抽成纯函数是因为 `doctor` 要在这套判定之上再加几项，而不是另写一套 ——
 * 两套判定给两个答案，比没有自查更糟（同 `evaluate.ts` 文件头的论证）。
 */
export function collectAuditFindings(snap: StandardsSnapshot): Finding[] {
  const findings: Finding[] = [];

  for (const w of snap.warnings) {
    // 合并告警自带级别时听它的 —— locked 被违反是 error，要能让退出码非零
    findings.push({ level: w.level ?? 'warn', id: w.id, message: w.message });
  }

  for (const item of snap.items) {
    // 被关掉的条目也要留痕 —— 「这条规范被关了，理由是什么」恰恰是最该能被追溯的，
    // 而且它常常是项目层唯一动过的地方
    if (!item.enabled) {
      if (item.source === 'project' && item.override_reason) {
        findings.push({
          level: 'info',
          id: item.id,
          message: `项目层已关闭：${item.override_reason}`,
        });
      }
      continue;
    }

    const eff = effectiveSeverity(item, snap.switchboard.maxSeverity);

    if (item.check.kind === 'protect_symbol' && !item.check.symbols?.length) {
      findings.push({
        level: 'error',
        id: item.id,
        message: 'protect_symbol 但 symbols 是空的 —— 这条规范在守空气，填上受保护字段名或关掉它',
      });
    }
    if (item.severity === 'block' && eff.severity !== 'block') {
      findings.push({
        level: 'warn',
        id: item.id,
        message: `声明 block 但实际 ${eff.severity}：${eff.reason}`,
      });
    }
    if (item.check.kind === 'content_regex' && !item.check.patterns?.length) {
      findings.push({
        level: 'error',
        id: item.id,
        message: 'content_regex 但 patterns 是空的（或全部正则非法，已被跳过）—— 不会命中任何东西',
      });
    }
    if (item.check.kind === 'require_tool' && !item.check.tool) {
      findings.push({
        level: 'error',
        id: item.id,
        message: 'require_tool 但没写 tool —— 判定不了要先调哪个工具',
      });
    }
    if (item.check.kind === 'require_evidence' && !item.check.commands?.length) {
      findings.push({
        level: 'error',
        id: item.id,
        message: 'require_evidence 但 commands 是空的 —— 认不出任何校验命令',
      });
    }
    if (!item.timing.length) {
      findings.push({
        level: 'error',
        id: item.id,
        message: 'timing 是空的 —— 这条规范永远不会被触发',
      });
    }
    if ((eff.severity === 'ask' || eff.severity === 'block') && !item.hint) {
      findings.push({
        level: 'warn',
        id: item.id,
        message: '会拦人但没写 hint —— 被拦时模型不知道下一步该干什么，会自己去找绕路',
      });
    }
    if (item.source === 'project' && item.override_reason) {
      findings.push({
        level: 'info',
        id: item.id,
        message: `项目层覆盖：${item.override_reason}`,
      });
    }
  }

  return findings;
}

/**
 * `standards audit` —— 规范腐烂体检。
 *
 * 和红线的 `audit` 是同一件事：**人写意图，机器验完整性。**
 * reviewer 能判断「这条规范该不该加」，但验证不了「paths 写对了没」
 * 「symbols 填了没」「这条 block 其实一直在被降级」。
 *
 * 退出码用 severity 而不是"有没有 finding"：info 级（如落点不含 plugin）
 * 不是缺陷，拿它卡流水线会让人把这一步关掉。
 */
export function renderStandardsAudit(snap: StandardsSnapshot): StandardsResult {
  const lines = head('规范体检');
  lines.push(...switchboardLines(snap));

  if (!snap.enabled) {
    lines.push('', `规范未启用：${snap.stackReasons._ ?? '总闸关闭'}`);
    return { text: `${lines.join('\n')}\n`, exitCode: 0 };
  }

  const findings = collectAuditFindings(snap);

  // 「落点不含 plugin」逐条列会有十几行，而它们说的是同一件事。
  // 折叠成一行 —— 这不是缺陷，只是让人知道这些条目的判定不在插件里
  const delegated = snap.items.filter((i) => i.enabled && !i.landing.includes('plugin'));

  const bySev = (l: Finding['level']) => findings.filter((f) => f.level === l);
  const errors = bySev('error');
  const warns = bySev('warn');
  const infos = bySev('info');

  if (!findings.length) {
    lines.push('', '✓ 没有发现问题。');
    if (delegated.length) {
      lines.push('', `· ${delegated.length} 条规范的落点不含 plugin —— 插件只注入，判定在 lint / CI / permissions / 人。`);
    }
    return { text: `${lines.join('\n')}\n`, exitCode: 0 };
  }

  for (const [label, group] of [
    ['✗ 必须修', errors],
    ['⚠ 建议看', warns],
    ['· 提示', infos],
  ] as const) {
    if (!group.length) continue;
    lines.push('', `${label}（${group.length}）`);
    for (const f of group) lines.push(`  [${f.id}] ${f.message}`);
  }

  if (delegated.length) {
    lines.push(
      '',
      `· ${delegated.length} 条规范的落点不含 plugin —— 插件只注入，判定在 lint / CI / permissions / 人。`,
      `  ${delegated.map((i) => i.id).join(' ')}`,
    );
  }

  lines.push('', '人写意图，机器验完整性 —— 这份体检验的是完整性，不是「规范该不该有」。');
  return { text: `${lines.join('\n')}\n`, exitCode: errors.length || warns.length ? 1 : 0 };
}
