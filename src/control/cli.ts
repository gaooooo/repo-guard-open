/**
 * v2 命令行：init（接入与告知）、status、receipt、check（合并门）。
 *
 * init 的几条规矩（DESIGN-v2 第 7 节）：
 *   · 推测值都要人确认；终端里逐项问，/repo-guard:init 由 AI 用 --plan / --apply 走同一套选项
 *   · 动工程共享文件（pre-commit / CI）一律默认不勾；CI 格式各异，只打印可复制的步骤
 *   · 已存在的 repo-guard.json 不覆盖：进入补充模式，只补缺的字段和合并门
 *   · --yes 全部用推荐值，但不碰 pre-commit / CI；要加合并门必须显式 --merge-gate
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { atlasAvailable, atlasJson, atlasRepoEntry } from '../atlas/client.js';
import { collectAtlasForInit } from '../cli/atlas.js';
import { guessPublicLayer } from '../cli/init.js';
import { RULE } from '../cli/text.js';
import { CONFIG_DIR, configPath, readJson } from '../runtime/paths.js';
import { factsFile, DEFAULT_LINE_LIMIT } from '../runtime/repo-facts.js';
import { redlinesFile } from '../runtime/redlines.js';
import { loadRedlines } from '../runtime/redlines.js';
import type { KnowledgeSnapshot } from '../engine/types.js';
import { BASELINE, contractMode, type ContentRedline, type FieldRedline, controlFile, effective, loadControl, loadGlobalControl, readProjectControl, type ControlConfig, type RedAction } from './config.js';
import { sessionReceipt, v2Active } from './hooks.js';
import { ciSnippet, detectGates, detectStack, guessVerifyCommands, installGate, suggestRedlines, type Candidate, type GateKind, type GateTarget, type RedlineSuggestion } from './project.js';
import { computeReceipt, pendingItems, renderReceipt, type FileChange } from './receipt.js';
import { pathRedlines } from './scope.js';
import { contentHits, fieldHits } from './redlines.js';

// ══════════════════ init：识别 ══════════════════

export interface InitPlan {
  repo: string;
  git: boolean;
  atlas: { available: boolean; ok: boolean; note: string };
  existing: boolean;
  legacy: { facts: boolean; redlines: boolean; guard: boolean };
  /** 从旧 redlines.json 迁移的字段 / 内容红线（示例条目、已关闭的不迁） */
  legacyFields: FieldRedline[];
  legacyContent: ContentRedline[];
  stack: string;
  verify: Candidate[];
  publicLayer: Candidate[];
  redlines: RedlineSuggestion[];
  gates: GateTarget[];
  controls: Array<{ name: string; what: string; handling: string }>;
  recommended: { mode: 'remind'; contract: 'auto' };
  ciSnippet: string;
}

export interface InitChoices {
  mode?: 'off' | 'remind' | 'enforce';
  contract?: 'off' | 'auto' | 'required';
  verify?: string[];
  publicLayer?: string[];
  redlines?: Array<{ glob: string; action: RedAction; reason: string }>;
  mergeGate?: GateKind[];
}

const CONTROLS = [
  { name: '开发基线', what: '会话开始注入 6 行最简实现约定', handling: '注入' },
  { name: '任务契约', what: '写第 2 个文件前要求声明目标 / 范围 / 验收', handling: '拦一次' },
  { name: '范围越界', what: '写到契约范围外时提醒并记进回执', handling: '提醒' },
  { name: '复用检查', what: '新建文件 / 函数前要求先查 atlas', handling: '提醒' },
  { name: '公共层影响面', what: '改公共层已有文件前必须查 atlas impact', handling: '拦截' },
  { name: '复杂度 / 体量', what: '只量本次新增的代码（函数长度、嵌套、参数、行数）', handling: '提醒' },
  { name: '红线', what: '受保护的文件、字段（不许删除或改名）、危险命令、硬编码凭据，按每条规则的动作执行', handling: '按规则（凭据默认拒绝）' },
  { name: '改动回执', what: '结束时列出改了什么、越界、复杂度、噪声、验没验证', handling: '展示' },
];

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function buildPlan(repoDir: string, opts: { workspace?: string; withRepos?: string[] } = {}): InitPlan {
  const legacyFacts = readJson<{ publicLayer?: unknown }>(factsFile(repoDir));
  const existing = readProjectControl(repoDir);
  let atlasNote = '';
  let atlasOk = false;
  let publicLayer: Candidate[] = [];
  if (!atlasAvailable()) atlasNote = '未安装 code-atlas：复用检查、公共层影响面与查重不生效（npm i -g @tencent/code-atlas 后重跑 init）';
  else {
    // 多工作区歧义等错误直接抛出：要求人用 --ws 指定，不能静默选一个
    {
      const info = collectAtlasForInit(repoDir, DEFAULT_LINE_LIMIT, { write: false, workspace: opts.workspace, withRepos: opts.withRepos });
      atlasOk = true;
      atlasNote = info.error ? '已安装 code-atlas ' + (info.version ?? '') + '；本仓尚未登记，写入时会登记到图谱（首次建索引可能要几十秒）' : '已安装 code-atlas ' + (info.version ?? '') + '，本仓已登记到图谱（工作区 ' + (info.workspace ?? '?') + '）';
      publicLayer = guessPublicLayer(info.hot ?? []).map((g) => ({ value: g.prefix, why: '依据：' + g.evidenceFile + ' 被 ' + g.routeCount + ' 个入口引用', checked: true }));
    }
  }
  if (Array.isArray(legacyFacts?.publicLayer)) {
    for (const p of legacyFacts!.publicLayer as unknown[]) {
      if (typeof p === 'string' && !publicLayer.some((c) => c.value === p)) publicLayer.unshift({ value: p, why: '来自旧配置 repo-facts.json（人确认过）', checked: true });
    }
  }
  const legacyFields: FieldRedline[] = [];
  const legacyContent: ContentRedline[] = [];
  for (const r of loadRedlines(repoDir).policy.red_lines) {
    if (r.enabled === false || /【示例】/.test(r.reason ?? '') || /【示例】/.test(r.rule)) continue;
    const reason = [r.rule, r.reason].filter(Boolean).join('：');
    if (r.protects?.length) legacyFields.push({ protects: r.protects, paths: r.paths ?? [], action: 'block', reason });
    for (const m of r.contentMatchers ?? []) legacyContent.push({ pattern: m.pattern, flags: (m.flags ?? '').replace(/[gy]/g, ''), paths: r.paths ?? [], action: 'block', reason: m.message || reason });
  }
  return {
    legacyFields,
    legacyContent,
    repo: repoDir,
    git: isDir(path.join(repoDir, '.git')),
    atlas: { available: atlasAvailable(), ok: atlasOk, note: atlasNote },
    existing: existing !== null,
    legacy: { facts: legacyFacts !== null, redlines: fs.existsSync(redlinesFile(repoDir)), guard: isDir(configPath(repoDir, 'guard')) },
    stack: detectStack(repoDir),
    verify: guessVerifyCommands(repoDir),
    publicLayer,
    redlines: suggestRedlines(repoDir),
    gates: detectGates(repoDir),
    controls: CONTROLS,
    recommended: { mode: 'remind', contract: 'auto' },
    ciSnippet: ciSnippet(),
  };
}

// ══════════════════ init：展示 ══════════════════

function box(v: boolean): string {
  return v ? '[x]' : '[ ]';
}

function gateLabel(g: GateTarget): string {
  if (g.kind === 'local') return '只装本机 git hook（' + g.file + '，不进 git，只对你自己生效）';
  if (!g.editable) return g.file + '（CI 配置格式各异，不自动改，只打印可复制的步骤）';
  return g.file + ' 追加一行（会进 git，团队所有人生效）';
}

export function renderPlan(p: InitPlan): string {
  const L: string[] = ['', 'repo-guard · 接入', RULE, '仓库  ' + path.basename(p.repo), ''];
  L.push('① 环境检查');
  L.push('  ' + (p.git ? '✓ git 仓库' : '! 不是 git 仓库：回执照常，合并门不可用'));
  L.push('  ' + (p.atlas.ok ? '✓ ' : '! ') + p.atlas.note);
  const legacy = [p.legacy.facts ? 'repo-facts.json' : '', p.legacy.redlines ? 'redlines.json' : '', p.legacy.guard ? 'guard/' : ''].filter(Boolean);
  if (legacy.length) L.push('  ! 发现旧配置 ' + legacy.join('、') + '：公共层、字段红线（' + p.legacyFields.length + ' 条）、内容红线（' + p.legacyContent.length + ' 条）会迁移进新配置；guard/ 在接入后不再读取');
  if (p.existing) L.push('  ! 已有 .codebuddy/repo-guard.json：补充模式，只补缺的字段和合并门，不覆盖已有配置');
  L.push('', '② 识别结果（推测值，请确认）');
  L.push('  技术栈    ' + p.stack);
  L.push('  验收命令  ' + (p.verify.length ? p.verify.map((c) => c.value + '（' + c.why + '）').join('\n            ') : '未识别（可以自己填，不填回执里显示「未配置验收命令」）'));
  L.push('  公共层    ' + (p.publicLayer.length ? p.publicLayer.map((c) => c.value + '（' + c.why + '）').join('\n            ') : '未识别（不填则不做公共层影响面检查）'));
  L.push('  建议红线  ' + (p.redlines.length ? p.redlines.map((r) => r.glob + ' → ' + r.action + '（' + r.reason + '）').join('\n            ') : '无'));
  const gates = p.gates.filter((g) => g.kind !== 'local');
  L.push('  已有门禁  ' + (gates.length ? gates.map((g) => g.file + (g.installed ? '（已含 repo-guard check）' : '')).join('、') : '未检测到 pre-commit 或 CI 配置'));
  L.push('', '③ 会话中会启用的控制');
  for (const c of p.controls) L.push('  · ' + c.name + '：' + c.what + '（默认：' + c.handling + '）');
  L.push('', '④ 合并门（会修改工程文件，默认不加）');
  L.push('  repo-guard check 在提交或合并时，用和会话回执同一套规则检查本次 diff（remind 档只报告，红线 block 与 enforce 档非零退出）。');
  for (const g of p.gates) L.push('  ' + box(g.installed) + ' ' + gateLabel(g));
  if (!gates.length) L.push('  如果你们的 CI 在蓝盾等网页上配置，可以加这一步：' + ciSnippet());
  return L.join('\n');
}

// ══════════════════ init：写入 ══════════════════

export function recommendedChoices(p: InitPlan): InitChoices {
  return {
    mode: 'remind',
    contract: 'auto',
    verify: p.verify.filter((c) => c.checked).map((c) => c.value),
    publicLayer: p.publicLayer.filter((c) => c.checked).map((c) => c.value),
    redlines: p.redlines.filter((r) => r.checked).map(({ glob, action, reason }) => ({ glob, action, reason })),
    mergeGate: [],
  };
}

/** 项目层完整配置：全部可调字段 + 当前值 + 说明。内置开发基线只读，写在说明里 */
function fullConfig(g: ControlConfig, c: InitChoices, p?: InitPlan): Record<string, unknown> {
  return {
    _: 'repo-guard：AI 写代码时的过程控制。让 AI 先说清楚这次要改什么（任务契约）；改的过程中提醒越界、重复造轮子、函数写得过长过深；结束时给出改动回执（改了哪些文件、有没有越界、验没验证）；红线保护不该动的文件和危险命令。改这里的值后重开会话生效，repo-guard status 查看当前生效的控制。',
    _mode: '总档位，启发式检查（范围、复用、复杂度、体量、验证）的上限：off 不做过程控制 / remind 写后提醒、回执列出（推荐先用它收集误伤数据）/ enforce 写前拒绝或弹窗。不约束红线、契约缺失拦截、公共层影响面',
    mode: c.mode ?? g.mode,
    task: {
      _contract: '任务契约：auto 写第 2 个文件时要求先调 guard_task（拒绝一次）/ required 第一次写就要求 / off 不要。测试和文档文件不计数',
      contract: c.contract ?? g.task.contract,
      _scope: '写到契约范围外：remind 写后提醒并列进回执 / enforce 写前弹窗让人确认 / off 不管',
      scope: g.task.scope,
    },
    budget: {
      _: '只量本次新增的代码（对比 AI 第一次写这个文件之前的内容），历史代码不算。超出时写后提醒、回执列出',
      _addedLines: '本次任务净新增行数上限',
      addedLines: g.budget.addedLines,
      _newFiles: '本次新建文件数上限（抓拆得过碎），测试文件不计',
      newFiles: g.budget.newFiles,
      _funcLines: '本次新增或变长的函数行数上限',
      funcLines: g.budget.funcLines,
      _nesting: '本次新增或变深的函数最大控制嵌套层数',
      nesting: g.budget.nesting,
      _params: '本次新增函数的参数个数上限',
      params: g.budget.params,
    },
    reuse: {
      _beforeNew: '新建文件 / 新增函数时本轮没查过 atlas hot / similar：remind 写后提醒 / enforce 新建文件前拒绝 / off 不管',
      beforeNew: g.reuse.beforeNew,
    },
    _publicLayer: '公共层目录：改其中已有文件前必须先查 atlas impact，否则拒绝（不受 mode 约束）。为空则不检查',
    publicLayer: c.publicLayer ?? g.publicLayer,
    verify: {
      _commands: '验收命令：回执检查「最后一次写入之后跑过、退出码 0」。任务契约里写了验收命令时以契约为准',
      commands: c.verify ?? g.verify.commands,
      _onStop: '结束时没跑过或没跑通验收命令：remind 让 AI 在回复里如实说明 / enforce 要求先跑通再结束（每会话一次）/ off 不管',
      onStop: g.verify.onStop,
    },
    redlines: {
      _: '红线：不受 mode 约束，按每条 action 执行：remind 写后提醒 / ask 写前弹窗 / block 写前拒绝（不写 action 时为 block）。四类：paths 不许改的文件（glob，** 跨目录）；commands 不许跑的命令（* 通配，按 && ; | 拆开逐段匹配）；fields 不许删除或改名的字段；content 不许新写进代码的内容。删掉某条即不再生效',
      paths: [...g.redlines.paths, ...(c.redlines ?? []).filter((r) => !g.redlines.paths.some((x) => x.glob === r.glob))],
      commands: g.redlines.commands,
      _fields: '字段红线：protects 里的字段名 / 函数名 / 错误码，在 paths（glob，空 = 全仓）内的文件里出现次数不许变少（删除或改名）。字段名要人点名，例：{ "protects": ["error_code", "tenant_id"], "paths": ["internal/**"], "action": "block", "reason": "已随 SDK 发布" }',
      fields: [...g.redlines.fields, ...(p?.legacyFields ?? [])],
      _content: '内容红线：新增的行里不许出现匹配 pattern（JS 正则，flags 可选，如 "i"）的内容；文件里原有的不算。默认几条拦硬编码凭据，误拦可删掉对应条目',
      content: [...g.redlines.content, ...(p?.legacyContent ?? [])],
    },
    baseline: {
      _builtin: ['会话开始注入的内置开发基线（只读，改不了；本仓约定写在 extra 里）：', ...BASELINE.map((l, i) => i + 1 + '. ' + l)],
      _extra: '追加在内置基线后的本仓约定，每行一条，建议不超过 5 行',
      extra: g.baseline.extra,
    },
  };
}

/** 补充模式：已有字段的值一律保留（说明文字按模板更新），只补缺的字段；顺序按模板，模板外的字段放最后 */
function fillMissing(existing: Record<string, unknown>, template: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const isObj = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  for (const [k, v] of Object.entries(template)) {
    const cur = existing[k];
    if (cur === undefined || k.startsWith('_')) out[k] = v;
    else if (isObj(cur) && isObj(v)) out[k] = fillMissing(cur as Record<string, unknown>, v as Record<string, unknown>);
    else out[k] = cur;
  }
  for (const [k, v] of Object.entries(existing)) if (!(k in out)) out[k] = v;
  return out;
}

function buildConfig(existing: Record<string, unknown> | null, c: InitChoices, p?: InitPlan): Record<string, unknown> {
  const template = fullConfig(loadGlobalControl(), c, p);
  return existing ? fillMissing(existing, template) : template;
}

function gitIgnored(repoDir: string, rel: string): boolean {
  return spawnSync('git', ['-C', repoDir, 'check-ignore', '-q', rel]).status === 0;
}

function appendGitignore(repoDir: string): boolean {
  const target = CONFIG_DIR + '/.cache/';
  if (gitIgnored(repoDir, target + 'x')) return false; // 已被忽略（如整个 .codebuddy 都在 .gitignore 里）
  const f = path.join(repoDir, '.gitignore');
  let body = '';
  try {
    body = fs.readFileSync(f, 'utf-8');
  } catch {
    /* 还没有 .gitignore */
  }
  if (body.split('\n').some((l) => l.trim() === target)) return false;
  fs.writeFileSync(f, body + (body && !body.endsWith('\n') ? '\n' : '') + target + '\n');
  return true;
}

export function applyInit(repoDir: string, p: InitPlan, c: InitChoices, opts: { workspace?: string; withRepos?: string[] } = {}): string {
  const L: string[] = [];
  const existing = readProjectControl(repoDir);
  const cfg = buildConfig(existing, c, p);
  const file = controlFile(repoDir);
  const before = existing ? JSON.stringify(existing) : '';
  if (JSON.stringify(cfg) !== before) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    L.push((existing ? '已补充  ' : '已写入  ') + CONFIG_DIR + '/repo-guard.json');
  } else L.push('未改动  ' + CONFIG_DIR + '/repo-guard.json（已有配置，不覆盖）');
  if (p.git && appendGitignore(repoDir)) L.push('已追加  .gitignore  ' + CONFIG_DIR + '/.cache/');
  const ignored = p.git && gitIgnored(repoDir, CONFIG_DIR + '/repo-guard.json');
  if (ignored) {
    L.push(
      '⚠ 注意  ' + CONFIG_DIR + '/repo-guard.json 被 .gitignore 忽略，提交不进 git，团队拿不到这份配置。',
      '        需要共享时把 .gitignore 里的 ' + CONFIG_DIR + ' 改成 ' + CONFIG_DIR + '/*，再加一行 !' + CONFIG_DIR + '/repo-guard.json（本工具不替你改）',
    );
  }

  for (const kind of c.mergeGate ?? []) {
    const targets = p.gates.filter((g) => g.kind === kind);
    if (!targets.length) {
      L.push(kind === 'ci' ? '合并门  未检测到 CI 配置文件，请在流水线里加一步：' + ciSnippet() : '合并门  未检测到 ' + kind + '，跳过');
      continue;
    }
    for (const t of targets) {
      const r = installGate(repoDir, t);
      L.push('合并门  ' + r.note);
    }
  }
  if ((c.mergeGate ?? []).some((k) => k !== 'local')) L.push('        共享 hook 需要 repo-guard 在 PATH 上，没有时跳过、不挡提交');

  if (atlasAvailable()) {
    try {
      const info = collectAtlasForInit(repoDir, DEFAULT_LINE_LIMIT, { write: true, workspace: opts.workspace, withRepos: opts.withRepos });
      L.push(info.error ? '图谱    登记失败：' + info.error : '图谱    已登记到 code-atlas 工作区 ' + (info.workspace ?? '?'));
    } catch (e) {
      L.push('图谱    登记失败：' + (e as Error).message);
    }
  }
  if (p.legacy.facts) L.push('迁移    repo-facts.json 的公共层已并入新配置，确认无误后可删除旧文件');
  if (p.legacy.redlines) L.push('迁移    redlines.json 的字段红线 ' + p.legacyFields.length + ' 条、内容红线 ' + p.legacyContent.length + ' 条已并入（示例条目和已关闭的不迁），确认无误后可删除旧文件');
  if (p.legacy.guard) L.push('迁移    .codebuddy/guard/ 在接入后不再读取，可删除');
  L.push(
    '',
    '✓ 完成。下一步：',
    '  1. 重开 CodeBuddy 会话后生效',
    ignored
      ? '  2. 配置目前只在本机生效；要团队共享，先按上面的提示调整 .gitignore 再提交'
      : '  2. 把 .codebuddy/repo-guard.json' + ((c.mergeGate ?? []).some((k) => k !== 'local' && k !== 'ci') ? ' 和改动的 hook 文件' : '') + ' 提交进 git，团队共享同一份配置',
    '  3. repo-guard status 查看当前生效的控制；repo-guard governance 查看误伤数据',
  );
  return L.join('\n');
}

// ══════════════════ init：交互 ══════════════════

async function ask(rl: readline.Interface, q: string, def: string): Promise<string> {
  const a = (await rl.question('  ? ' + q + ' › ')).trim();
  return a || def;
}

/** 勾选列表：回车接受默认；输入编号（如 1,3）只保留这些；0 一个都不要；以 + 开头追加自定义 */
async function pickList<T extends { checked: boolean }>(rl: readline.Interface, title: string, items: T[], show: (t: T) => string, custom?: (s: string) => T): Promise<T[]> {
  process.stdout.write('  ? ' + title + '\n');
  items.forEach((it, i) => process.stdout.write('      ' + (i + 1) + ') ' + box(it.checked) + ' ' + show(it) + '\n'));
  const hint = '回车接受勾选 / 输入编号如 1,3 / 0 都不要' + (custom ? ' / +内容 追加自定义' : '');
  const a = (await rl.question('    ' + hint + ' › ')).trim();
  if (!a) return items.filter((i) => i.checked);
  if (a === '0') return [];
  if (custom && a.startsWith('+')) return [...items.filter((i) => i.checked), ...a.slice(1).split(/[,，]/).map((x) => x.trim()).filter(Boolean).map(custom)];
  const idx = new Set(a.split(/[,，\s]+/).map((x) => Number(x) - 1));
  return items.filter((_, i) => idx.has(i));
}

export async function interactiveInit(repoDir: string, p: InitPlan, opts: { workspace?: string; withRepos?: string[] }): Promise<string> {
  process.stdout.write(renderPlan(p) + '\n\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const c = recommendedChoices(p);
    if (!p.existing) {
      process.stdout.write('请确认（直接回车 = 推荐值）\n');
      c.mode = (await ask(rl, '总档位 remind（推荐：先提醒、收集误伤数据）/ enforce / off', 'remind')) as InitChoices['mode'];
      c.contract = (await ask(rl, '任务契约 auto（推荐）/ required / off', 'auto')) as InitChoices['contract'];
      if (!['off', 'remind', 'enforce'].includes(c.mode!)) c.mode = 'remind';
      if (!['off', 'auto', 'required'].includes(c.contract!)) c.contract = 'auto';
      c.verify = (await pickList(rl, '验收命令', p.verify, (x) => x.value + '（' + x.why + '）', (v) => ({ value: v, why: '自己填', checked: true }))).map((x) => x.value);
      c.publicLayer = (await pickList(rl, '公共层', p.publicLayer, (x) => x.value + '（' + x.why + '）', (v) => ({ value: v.endsWith('/') ? v : v + '/', why: '自己填', checked: true }))).map((x) => x.value);
      if (p.redlines.length) c.redlines = (await pickList(rl, '红线', p.redlines, (r) => r.glob + ' → ' + r.action + '（' + r.reason + '）')).map(({ glob, action, reason }) => ({ glob, action, reason }));
    }
    const gates = p.gates.filter((g) => !g.installed);
    if (gates.length) {
      const picked = await pickList(rl, '合并门加到哪里（默认不加）', gates.map((g) => ({ ...g, checked: false })), gateLabel);
      c.mergeGate = [...new Set(picked.filter((g) => g.editable).map((g) => g.kind))];
      for (const g of picked.filter((x) => !x.editable)) process.stdout.write('    ' + g.file + ' 请手动加一步：' + ciSnippet() + '\n');
    }
    process.stdout.write('\n⑤ 即将写入\n');
    process.stdout.write('  ' + (p.existing ? '补充' : '新建') + '  .codebuddy/repo-guard.json\n');
    if (p.git) process.stdout.write('  修改  .gitignore（缓存目录，已有则不动）\n');
    for (const k of c.mergeGate ?? []) for (const g of p.gates.filter((x) => x.kind === k)) process.stdout.write('  修改  ' + g.file + '（+1 行）\n');
    for (;;) {
      const a = (await rl.question('  ? 确认写入 › Y / n / d（d 先看配置内容）')).trim().toLowerCase();
      if (a === 'n') return '已取消，没有写入任何文件。';
      if (a === 'd') {
        process.stdout.write(JSON.stringify(buildConfig(readProjectControl(repoDir), c, p), null, 2) + '\n');
        continue;
      }
      break;
    }
    return applyInit(repoDir, p, c, opts);
  } finally {
    rl.close();
  }
}

// ══════════════════ status / receipt ══════════════════

export function renderStatus(repoDir: string): string {
  const { active, cfg, source, issues } = loadControl(repoDir);
  const L: string[] = ['', 'repo-guard · 生效的控制', RULE];
  if (!active) {
    L.push('本仓还没接入 v2（没有 .codebuddy/repo-guard.json）。运行 repo-guard init，或在会话里用 /repo-guard:init。');
    return L.join('\n');
  }
  const src = (k: string) => (source[k] === 'project' ? '项目层' : source[k] === 'global' ? '全局层' : '内置');
  const lv = (x: string) => effective(cfg, x as ControlConfig['mode']);
  L.push('总档位        ' + cfg.mode + '（' + src('mode') + '）');
  L.push('开发基线      注入 6 行' + (cfg.baseline.extra.length ? ' + 本仓 ' + cfg.baseline.extra.length + ' 行' : '') + (cfg.mode === 'off' ? '（mode off：不注入）' : ''));
  L.push('任务契约      ' + contractMode(cfg) + '（' + src('task.contract') + '）');
  L.push('范围越界      ' + lv(cfg.task.scope) + '（' + src('task.scope') + '）');
  L.push('复用检查      ' + lv(cfg.reuse.beforeNew) + '（' + src('reuse.beforeNew') + '）' + (atlasAvailable() ? '' : ' —— 未装 atlas，不生效'));
  L.push('公共层        ' + (cfg.publicLayer.length ? cfg.publicLayer.join('  ') + '（改已有文件前必须查 impact）' : '未配置（不检查）'));
  const b = cfg.budget;
  L.push('体量 / 复杂度 ' + (cfg.mode === 'off' ? 'off' : 'remind') + '：净新增 ' + b.addedLines + ' 行、新文件 ' + b.newFiles + ' 个、函数 ' + b.funcLines + ' 行 / 嵌套 ' + b.nesting + ' / 参数 ' + b.params);
  L.push('验收命令      ' + (cfg.verify.commands.length ? cfg.verify.commands.join(' && ') : '未配置') + '；结束时 ' + lv(cfg.verify.onStop));
  const red = cfg.redlines;
  L.push('红线          路径 ' + red.paths.length + ' 条、字段 ' + red.fields.length + ' 条、内容 ' + red.content.length + ' 条、命令 ' + red.commands.length + ' 条（不受总档位约束）');
  for (const r of red.paths) L.push('                ' + r.glob + ' → ' + r.action + (r.reason ? '（' + r.reason + '）' : ''));
  for (const r of red.fields) L.push('                字段 ' + r.protects.join('、') + (r.paths.length ? ' @ ' + r.paths.join(', ') : '') + ' → ' + r.action);
  for (const r of red.content) L.push('                内容 /' + (r.pattern.length > 40 ? r.pattern.slice(0, 40) + '…' : r.pattern) + '/ → ' + r.action);
  for (const r of red.commands) L.push('                $ ' + r.pattern + ' → ' + r.action);
  const gates = detectGates(repoDir).filter((g) => g.installed);
  L.push('合并门        ' + (gates.length ? gates.map((g) => g.file).join('、') : '未加（repo-guard init --merge-gate husky|lefthook|pre-commit|local）'));
  L.push('图谱          ' + (atlasAvailable() ? (atlasRepoEntry(repoDir, 4000) ? '已登记' : '已安装，本仓未登记（repo-guard init 会登记）') : '未安装 code-atlas'));
  if (fs.existsSync(redlinesFile(repoDir))) L.push('旧配置        redlines.json：字段红线以 repo-guard.json 的 redlines.fields 为准（init 会迁移），可删除');
  if (fs.existsSync(factsFile(repoDir))) L.push('旧配置        repo-facts.json：公共层以 repo-guard.json 为准，可删除');
  const g = loadGlobalControl();
  const flat = (o: unknown, pre = ''): Record<string, string> => {
    const out: Record<string, string> = {};
    if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) Object.assign(out, flat(v, pre ? pre + '.' + k : k));
    else out[pre] = JSON.stringify(o);
    return out;
  };
  const mine = flat(cfg);
  const dept = flat(g);
  const diff = Object.keys(mine).filter((k) => k !== 'publicLayer' && k !== 'verify.commands' && mine[k] !== dept[k]);
  if (diff.length) {
    L.push('', '与部门默认（全局层）不同的项：');
    for (const k of diff) L.push('  · ' + k + '：本仓 ' + mine[k] + '，部门默认 ' + dept[k]);
  }
  if (issues.length) {
    L.push('', '配置问题（按默认值处理）：');
    for (const i of issues) L.push('  ! ' + i);
  }
  return L.join('\n');
}

export function renderSessionReceipt(repoDir: string): string {
  if (!v2Active(repoDir)) return '本仓还没接入 v2（没有 .codebuddy/repo-guard.json）。';
  const rc = sessionReceipt([repoDir], () => '', false);
  if (!rc) return '当前会话还没有经写工具改过本仓的文件。';
  return rc.text + (rc.pending.length ? '\n\n待说明：\n' + rc.pending.map((p) => '  - ' + p).join('\n') : '');
}

// ══════════════════ audit：字段红线体检 ══════════════════

/**
 * 接入 v2 的仓：把 redlines.fields 转成审计引擎认识的快照（守空气 / paths 后门）。
 * 返回 null = 没接入 v2，走旧 redlines.json。
 */
export function fieldAuditSnapshot(repoDir: string): KnowledgeSnapshot | null {
  const { active, cfg } = loadControl(repoDir);
  if (!active) return null;
  return {
    ok: true,
    repoDir,
    policy: {
      red_lines: cfg.redlines.fields.map((f, i) => ({
        id: 'F-' + (i + 1),
        rule: f.protects.join('、') + ' 不许删除或改名',
        reason: f.reason,
        protects: f.protects,
        paths: f.paths,
      })),
      no_refactor: [],
      stop_conditions: [],
    },
    index: { task_routes: {} },
    loadedFiles: ['.codebuddy/repo-guard.json'],
    warnings: [],
  };
}

// ══════════════════ check：合并门 ══════════════════

function git(repoDir: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

export function runCheck(repoDir: string, argv: string[]): { text: string; code: number } {
  const staged = argv.includes('--staged');
  const bi = argv.indexOf('--base');
  const base = bi >= 0 ? argv[bi + 1] : '';
  if (bi >= 0 && (!base || base.startsWith('--'))) return { text: '用法：repo-guard check --base <分支或提交>', code: 2 };
  if (!git(repoDir, ['rev-parse', '--git-dir']).ok) return { text: '不是 git 仓库，check 不可用。', code: 2 };
  const { cfg, active } = loadControl(repoDir);

  let names: string[];
  let beforeRev = 'HEAD';
  if (staged) {
    names = git(repoDir, ['diff', '--cached', '--name-only', '--diff-filter=ACMRD']).out.split('\n').filter(Boolean);
  } else {
    const mb = git(repoDir, ['merge-base', base, 'HEAD']);
    if (!mb.ok) return { text: '找不到 ' + base + ' 与 HEAD 的共同祖先（CI 里可能需要先 git fetch 目标分支）。', code: 2 };
    beforeRev = mb.out.trim();
    names = git(repoDir, ['diff', '--name-only', beforeRev]).out.split('\n').filter(Boolean);
  }
  const show = (spec: string): string | null => {
    const r = git(repoDir, ['show', spec]);
    return r.ok ? r.out : null;
  };
  const changes: FileChange[] = names.map((rel) => {
    const before = show(beforeRev + ':' + rel);
    let after: string | null;
    if (staged) after = show(':' + rel);
    else {
      try {
        after = fs.readFileSync(path.join(repoDir, rel), 'utf-8');
      } catch {
        after = null;
      }
    }
    return { label: rel, rel, before, after };
  });

  const L: string[] = [];
  const blocked: string[] = [];
  for (const rel of names) {
    for (const r of pathRedlines(cfg.redlines.paths, rel)) {
      L.push('红线    ' + rel + ' 命中 ' + r.glob + ' → ' + r.action + (r.reason ? '（' + r.reason + '）' : ''));
      if (r.action === 'block') blocked.push(rel);
    }
  }
  for (const ch of changes) {
    for (const h of [...fieldHits(cfg.redlines.fields, ch.rel, ch.before, ch.after), ...contentHits(cfg.redlines.content, ch.rel, ch.before, ch.after)]) {
      L.push('红线    ' + ch.rel + ' ' + h.detail + ' → ' + h.action + (h.reason ? '（' + h.reason + '）' : ''));
      if (h.action === 'block' && !blocked.includes(ch.rel)) blocked.push(ch.rel);
    }
  }

  let duplicates: string[] = [];
  let atlasNote: string | undefined;
  if (atlasAvailable() && names.length) {
    const entry = atlasRepoEntry(repoDir, 8000);
    if (entry) {
      const r = atlasJson<{ problems?: Array<{ kind?: string; file?: string; line?: number; message?: string }> }>(
        ['review', '--json', '--repo', entry.id, '--ws', entry.workspace, '--base', staged ? 'HEAD' : beforeRev],
        { cwd: repoDir, timeoutMs: 120_000 },
      );
      if (r.ok) duplicates = (r.data.problems ?? []).filter((x) => x.kind === 'duplicate' && names.includes(x.file ?? '')).map((x) => x.file + ':' + (x.line ?? '?') + ' ' + (x.message ?? ''));
      else atlasNote = 'atlas review 未完成：' + r.message.slice(0, 120);
    } else atlasNote = '本仓未登记到 atlas 图谱，复用未检查';
  } else if (!atlasAvailable()) atlasNote = '图谱不可用，复用未检查';

  const rc = computeReceipt(changes, cfg.budget);
  const ex = { duplicates, atlasNote };
  const pending = pendingItems(rc, cfg.budget, ex, false);
  const head = '[repo-guard check] ' + (staged ? '暂存区' : '相对 ' + base) + ' ·';
  const text = [renderReceipt(rc, cfg.budget, ex, head), ...L].join('\n');
  const enforce = active && cfg.mode === 'enforce';
  const fail = blocked.length > 0 || (enforce && pending.length > 0);
  const tail = blocked.length
    ? '✗ 命中红线（block）：' + blocked.join('、')
    : pending.length
      ? (enforce ? '✗ 有 ' + pending.length + ' 项问题（mode enforce）' : '! 有 ' + pending.length + ' 项需要关注（mode ' + cfg.mode + '，只报告不拦）')
      : '✓ 没有问题';
  return { text: text + '\n\n' + tail + (pending.length ? '\n' + pending.map((p) => '  - ' + p).join('\n') : ''), code: fail ? 1 : 0 };
}