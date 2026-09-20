/**
 * `doctor` —— 配置体检。给**填配置的人**用，不是给 AI 用。
 *
 * ── 为什么需要一个独立于 `standards audit` 的命令 ──
 * 分发链是三级的：插件源码 → 部门模板包 → 个人项目。部门拿到的包里没有
 * `src/`、没有 `node_modules`，他们能做的只有改 JSON。而这个工程的每一处
 * 读配置都是 **fail-safe** 的：
 *
 *   · `readJson`（`runtime/paths.ts`）吞掉一切异常，返回 null
 *   · `sanitizeItem` 逐条净化，一条坏条目只跳过它自己
 *   · `loadGuardConfig` 任何字段类型不对都退默认值
 *
 * 这套设计在运行时是对的 —— 配置语法错误不该让人的操作失败。但它的代价是
 * **改坏了没有任何反馈**：部门把一个逗号写错，症状是"这几条规范不生效"，
 * 而没有任何一行报错。`doctor` 就是把这些被吞掉的错误重新翻出来。
 *
 * ── 与 `standards audit` 的分工 ──
 * `audit` 回答「我配的规范腐烂了没」，输入是**已经加载成功**的快照，
 * 所以它天然看不见"文件坏了根本没加载进来"这一类问题。
 * `doctor` = `audit` 的全部判定（直接复用 `collectAuditFindings`，不重写）
 *          + 4 项只有在填配置时才问的检查。
 *
 * ── 退出码 ──
 * error → 1，其余 → 0。warn 不卡 —— 配额超限、缺 hint 这类是"建议看"，
 * 拿它卡住部门的发布流程，第一次就会被加 `|| true`。
 */
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_DIR } from '../runtime/paths.js';
import { RULE } from './render.js';
import {
  STANDARDS_DIR,
  standardsDirOf,
  standardsTemplateDir,
  stackSourceFiles,
  type StandardsSnapshot,
} from '../standards/loader.js';
import { injectBudgetReport } from '../standards/evaluate.js';
import {
  ALL_STACKS,
  effectiveSeverity,
  type Severity,
  type Stack,
  type StandardItem,
} from '../standards/schema.js';
import { guardDirOf, templateDir as guardTemplateDir } from '../gates/config.js';
import { collectAuditFindings, type Finding, type StandardsResult } from './standards.js';

/** id 前缀 → 它应该属于哪个端。`PRJ-` 是项目层新增条目的保留前缀，不校验 */
const PREFIX_STACK: Record<string, Stack> = {
  'L0-': 'l0-contract',
  'CM-': 'common',
  'FE-': 'frontend-web',
  'BE-': 'backend-service',
  'DB-': 'database',
  'MQ-': 'message-queue',
};

/**
 * 一个条目实际能通过哪些通道生效。**空数组 = 僵尸。**
 *
 * 这份判据是逐行读运行时代码得出的，不是照着 `Timing` 枚举写的 ——
 * 两者差得很远，而差异正是填配置的人最容易踩的坑：
 *
 * | 通道 | 谁消费 | 看 timing 吗 | 看 kind 吗 |
 * | :--- | :--- | :--- | :--- |
 * | 注入面 | `injectSegment` | `session_start` / `post_compact` | 否 |
 * | 按任务注入 | `promptSegment` | `prompt_submit` | 否 |
 * | 写后扫描 | `scanFile(…,'post_write')` | `post_write` | **只收文件级判据** |
 * | 写前硬拦 | `compileBlockRules` | **完全不看** | 只收 `protect_symbol` |
 * | 写前工具门 | `judgeRequireTool` | **完全不看** | 只收 `require_tool` |
 *
 * 两条推论，都反直觉：
 *
 * **① `pre_write` / `pre_bash` / `stop` 写了也没有任何代码读。**
 * 硬拦是由 `severity` + `check.kind` 决定的，与 timing 无关。把 `pre_write`
 * 写进 timing 不会让一条 remind 变成拦截，也不写就不会让 block 失效。
 *
 * **② `require_evidence` 当前没有任何求值器。**
 * 它只在 `standards audit` 里被检查"commands 填了没"，从不被真正判定。
 * 所以声明 `landing: ["plugin"]` 的 `require_evidence` 条目是在假装插件能管。
 */
const INJECT_TIMINGS = new Set(['session_start', 'post_compact']);
const FILE_LEVEL_KINDS = new Set(['path_only', 'protect_symbol', 'content_regex', 'require_tool']);
/** 写了也没有任何代码读取的 timing */
const INERT_TIMINGS = new Set(['pre_write', 'pre_bash', 'stop']);

function effectiveChannels(item: StandardItem, eff: Severity): string[] {
  const ch: string[] = [];
  if (item.timing.some((t) => INJECT_TIMINGS.has(t))) ch.push('注入面');
  if (item.timing.includes('prompt_submit')) ch.push('按任务注入');
  if (item.timing.includes('post_write') && FILE_LEVEL_KINDS.has(item.check.kind)) {
    ch.push('写后扫描');
  }
  if (eff === 'block' && item.check.kind === 'protect_symbol') ch.push('写前硬拦');
  if (eff === 'block' && item.check.kind === 'require_tool') ch.push('写前工具门');
  return ch;
}

// ══════════════════ ① JSON 合法性 ══════════════════

/**
 * 裸 `JSON.parse` 一遍，把被 `readJson` 吞掉的语法错误翻出来。
 *
 * **必须裸 parse，不能用 `readJson`** —— 后者对"文件不存在"和"文件坏了"
 * 返回同一个 null，而这两件事对填配置的人是完全不同的处置：
 * 前者是"还没填"，后者是"填错了，而且你以为填好了"。
 */
function checkJsonSyntax(files: string[], label: string): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(f, 'utf-8');
    } catch (e) {
      out.push({ level: 'error', id: label, message: `${f} 读不了：${(e as Error).message}` });
      continue;
    }
    try {
      const v = JSON.parse(raw) as unknown;
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        out.push({
          level: 'error',
          id: label,
          message: `${f} 的顶层不是对象 —— 会被当成"读不到"静默跳过`,
        });
      }
    } catch (e) {
      // JSON.parse 的错误信息里带位置（"at position 123"），原样透出去
      out.push({
        level: 'error',
        id: label,
        message: `${f} JSON 语法错误：${(e as Error).message}`,
      });
    }
  }
  return out;
}

/** 递归收集一个目录下的 .json（含 `_` 开头的 —— 它们不被加载，但坏了也该说一声） */
function allJsonUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// ══════════════════ ② 僵尸条目 ══════════════════

/**
 * 三类「填了但没用」，分三个级别报。
 *
 * 级别的分法很重要：**能力缺口不能报成 error**。部门看到 error 会去改自己的
 * 配置，而这几条改成什么都没用 —— 那只会让人得出"这个检查在乱报"的结论，
 * 然后关掉它。
 */
function checkDeadItems(snap: StandardsSnapshot): Finding[] {
  const out: Finding[] = [];
  for (const item of snap.items) {
    if (!item.enabled || !item.timing.length) continue; // timing 空由 audit 管
    const eff = effectiveSeverity(item, snap.switchboard.maxSeverity).severity;
    const channels = effectiveChannels(item, eff);

    if (!channels.length) {
      // ①-a 被 maxSeverity 压制导致通道消失。**不是配置写错，改 timing 也没用** ——
      //     protect_symbol / require_tool 的判定入口都要求实际强度为 block
      //     （compileBlockRules 与 judgeRequireTool 各自的 sev 检查），
      //     一旦被压到 remind，它们不是"降级成提醒"，而是整个不参与判定。
      //     而 `standards list` 仍会显示 [提醒]，看起来像在工作 —— 这才是真正要说的事。
      //     按本文件的分级原则：改不动的东西不能报 error。
      const blockOnly =
        item.severity === 'block' &&
        (item.check.kind === 'protect_symbol' || item.check.kind === 'require_tool');
      if (blockOnly && eff !== 'block') {
        out.push({
          level: 'warn',
          id: item.id,
          message:
            `声明 block + ${item.check.kind}，但被 maxSeverity=${snap.switchboard.maxSeverity} 压到 ${eff} ——` +
            `${item.check.kind} 的判定入口只在 block 级存在，所以这条**不是降级成提醒，而是完全不参与判定**。` +
            `\n      （\`standards list\` 会显示成 [提醒]，那是强度展示，不代表它在做事）` +
            `\n      来自 ${short(snap.origin.get(item.id))}` +
            '\n      要它真的生效：把 standards.json 的 maxSeverity 提到 block，并确认这条的 paths 与 confirmed',
        });
        continue;
      }

      // ①-b 判据与时机的组合本身就不通 = 真僵尸，配置能修 → error
      out.push({
        level: 'error',
        id: item.id,
        message:
          `僵尸条目：check.kind=${item.check.kind} 配 timing=[${item.timing.join(',')}]，` +
          `实际强度 ${eff} —— 一个生效通道都没有，这条规范永远不会输出。` +
          `\n      来自 ${short(snap.origin.get(item.id))}` +
          `\n      ${item.check.kind === 'none' ? '判据为 none 的条目只能靠注入生效，timing 要含 session_start / prompt_submit / post_compact' : `判据 ${item.check.kind} 要生效，timing 需含 post_write，或把 severity 提到 block`}`,
      });
      continue;
    }

    // ② timing 里混了没有挂载点的值 → info。不影响这条生效，但写的人有误解
    const inert = item.timing.filter((t) => INERT_TIMINGS.has(t));
    if (inert.length) {
      out.push({
        level: 'info',
        id: item.id,
        message:
          `timing 里的 [${inert.join(',')}] 当前没有挂载点，不会被读取（这条仍通过「${channels.join('、')}」生效）。` +
          '硬拦由 severity + check.kind 决定，与 timing 无关',
      });
    }

    // ③ post_write 配非文件级判据 → info。写的人以为"写完会提醒"，
    //    但 scanFile 的候选池只收文件级判据，这一项空转
    if (item.timing.includes('post_write') && !FILE_LEVEL_KINDS.has(item.check.kind)) {
      out.push({
        level: 'info',
        id: item.id,
        message:
          `timing 含 post_write 但 check.kind=${item.check.kind} 不是文件级判据 —— 写后扫描不会带上它` +
          `（这条仍通过「${channels.join('、')}」生效）。要真的写完提醒，得给它 content_regex 或 path_only`,
      });
    }

    // ④ require_evidence 声明插件能管，但插件侧没有求值器 → warn
    if (item.check.kind === 'require_evidence' && item.landing.includes('plugin')) {
      out.push({
        level: 'warn',
        id: item.id,
        message:
          'require_evidence 当前没有运行时求值器 —— landing 写了 plugin 等于插件在假装能管。' +
          '实际落点只有 ci，建议把 landing 里的 plugin 去掉，或接受它只是一条注入',
      });
    }
  }
  return out;
}

// ══════════════════ ③ id 前缀 vs 端 ══════════════════

/**
 * 分片之后一个端有多个文件，复制粘贴条目忘了改 id 前缀的概率大增。
 * 前缀对不上不会报错，只是这条规范被分到了另一个端的注入分组里 ——
 * 于是"前端仓关掉数据库端"之后它跟着消失，而没人知道为什么。
 */
function checkIdPrefix(snap: StandardsSnapshot): Finding[] {
  const out: Finding[] = [];
  for (const item of snap.items) {
    if (item.id.startsWith('PRJ-')) continue; // 项目层新增条目的保留前缀
    const hit = Object.entries(PREFIX_STACK).find(([p]) => item.id.startsWith(p));
    if (!hit) {
      out.push({
        level: 'warn',
        id: item.id,
        message: `id 前缀不在约定内（L0- CM- FE- BE- DB- MQ- PRJ-）—— 来自 ${short(snap.origin.get(item.id))}`,
      });
      continue;
    }
    if (hit[1] !== item.stack) {
      out.push({
        level: 'error',
        id: item.id,
        message:
          `id 前缀 ${hit[0]} 指向 ${hit[1]}，但它躺在 ${item.stack} 的文件里（${short(snap.origin.get(item.id))}）` +
          ' —— 端由文件位置决定，所以这条实际归属后者。八成是复制条目忘了改 id',
      });
    }
  }
  return out;
}

function short(abs: string | undefined): string {
  if (!abs) return '?';
  const i = abs.lastIndexOf(`/${STANDARDS_DIR}/`);
  return i >= 0 ? abs.slice(i + 1) : path.basename(abs);
}

// ══════════════════ ④ 注入配额 ══════════════════

function checkBudget(snap: StandardsSnapshot): Finding[] {
  const r = injectBudgetReport(snap, 'session_start');
  if (!r.truncated) return [];
  return [
    {
      level: 'warn',
      id: '注入配额',
      message:
        `session_start 注入面共 ${r.total} 行，超出 ${r.budgetTokens} token 预算 ——` +
        `第 ${r.kept + 1} 行起被丢掉，共丢 ${r.truncated} 行。` +
        `\n      第一条被丢的是：${r.firstDropped ?? '?'}` +
        '\n      注入面是按行前缀截断的，排在后面的端会整批消失。' +
        '\n      两条出路：把不相关的端设成 off，或把不必常驻的条目改成只挂 prompt_submit。',
    },
  ];
}

// ══════════════════ 渲染 ══════════════════

export function runDoctor(repoDir: string, snap: StandardsSnapshot): StandardsResult {
  const globalDir = standardsTemplateDir();
  const projectDir = standardsDirOf(repoDir);
  const projectPresent = snap.projectPresent;

  const lines = ['', 'repo-guard · 配置体检', RULE];

  // 被加载的规范文件（分片枚举与运行时完全一致）
  const loaded: string[] = [];
  for (const dir of [globalDir, projectDir]) {
    const sb = path.join(dir, 'standards.json');
    if (fs.existsSync(sb)) loaded.push(sb);
    for (const s of ALL_STACKS) loaded.push(...stackSourceFiles(dir, s));
  }

  lines.push(
    `全局层（部门）  ${fs.existsSync(globalDir) ? globalDir : '不存在'}`,
    `项目层（个人）  ${CONFIG_DIR}/${STANDARDS_DIR}/  ${projectPresent ? '已找到' : '不存在 → 运行时不生效，只能 CLI 自查'}`,
    `规范文件        ${loaded.length} 个被加载，共 ${snap.items.length} 条（全端）`,
  );

  // 配额**总是显示**，不只在超限时报。填配置的人需要知道还剩多少空间 ——
  // 等超了再说，那时已经要回头删条目了
  if (snap.enabled) {
    const b = injectBudgetReport(snap, 'session_start');
    const perLine = b.kept ? b.usedTokens / b.kept : 0;
    const room = Math.max(0, Math.floor((b.budgetTokens - b.usedTokens) / (perLine || 1)));
    lines.push(
      `注入配额        ${b.usedTokens}/${b.budgetTokens} token，${b.kept}/${b.total} 行进得去` +
        (b.truncated
          ? `　⚠ 丢 ${b.truncated} 行`
          : `　还能加约 ${room} 条（按当前均值 ${perLine.toFixed(1)} token/行）`),
    );
  }

  const findings: Finding[] = [];

  // ① JSON 合法性：规范两层 + guard 两层。凡是部门/个人能改的 JSON 都过一遍
  findings.push(...checkJsonSyntax(allJsonUnder(globalDir), 'JSON'));
  if (projectPresent) findings.push(...checkJsonSyntax(allJsonUnder(projectDir), 'JSON'));
  findings.push(...checkJsonSyntax(allJsonUnder(guardTemplateDir()), 'JSON'));
  findings.push(...checkJsonSyntax(allJsonUnder(guardDirOf(repoDir)), 'JSON'));

  if (snap.enabled) {
    findings.push(...collectAuditFindings(snap)); // audit 的全部判定，复用不重写
    findings.push(...checkDeadItems(snap));
    findings.push(...checkIdPrefix(snap));
    findings.push(...checkBudget(snap));
  } else {
    lines.push('', `规范未启用：${snap.stackReasons._ ?? '总闸关闭'}`);
  }

  const bySev = (l: Finding['level']) => findings.filter((f) => f.level === l);
  const errors = bySev('error');
  const warns = bySev('warn');
  const infos = bySev('info');

  if (!findings.length) {
    lines.push('', '✓ 没有发现问题。');
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

  lines.push(
    '',
    `共 ${errors.length} 个必须修、${warns.length} 个建议看、${infos.length} 个提示。`,
    '退出码只看「必须修」—— 建议看那些拿来卡流水线，第一次误判就会被关掉。',
  );

  return { text: `${lines.join('\n')}\n`, exitCode: errors.length ? 1 : 0 };
}
