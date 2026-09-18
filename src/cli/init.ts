/**
 * init —— 仓库体检，以及（可选）生成配置。
 *
 * ── 为什么默认一个字节都不写 ──
 * 公共层是**推测**出来的。各仓目录约定不一样，猜错要么漏拦、要么天天误伤，
 * 后者会让人直接卸载。所以推测结果必须先打在屏幕上让人过一眼，
 * `--write` 才落盘。工具擅自改人的仓库是最快失去信任的方式。
 *
 * ── 为什么报告里要排优先级 ──
 * 体检报出 8 个问题，人的第一反应是"太多了，回头再说"。所以给一条有序路径，
 * 并且**前三条全是工程侧**（lint 命令、lint 规则、流水线）—— 它们不碰 AI、
 * 收益立刻可见，而且是后面几步的地基：没有能单独执行的检查命令，
 * "提交前自动检查"和"流水线跑检查"都无从谈起。
 *
 * ── 为什么不替用户改 lint 配置 ──
 * lint 配置是团队共识的载体，动它要过 review。工具只把片段打出来让人自己贴。
 */
import fs from 'node:fs';
import path from 'node:path';

import { hotSpots } from '../engine/graph-builder.js';
import type { CodeGraph } from '../engine/graph/types.js';
import { missingPublicLayerWarning, patternsMissingFromGraph } from '../engine/public-layer-audit.js';
import { CONFIG_DIR, readJson } from '../runtime/paths.js';
import { DEFAULT_LINE_LIMIT, readFacts, writeFacts, type RepoFacts } from '../runtime/repo-facts.js';
import type { GraphHandle } from '../runtime/graph-cache.js';
import { scan, type ScanResult } from './scan.js';
import { RULE } from './render.js';

/** 一条体检发现。`action` 非空表示它在"照这个顺序做"里有对应动作 */
interface Finding {
  text: string;
}

/** 一条行动项 */
interface Action {
  title: string;
  why: string;
}

interface PkgJson {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  'lint-staged'?: unknown;
  husky?: unknown;
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 流水线配置的常见位置。命中任意一个就算"有流水线" */
const CI_FILES = [
  '.github/workflows',
  '.gitlab-ci.yml',
  '.gitlab-ci.yaml',
  'Jenkinsfile',
  '.woa-ci.yml',
  'ci.yml',
  '.ci',
  'azure-pipelines.yml',
  '.circleci/config.yml',
  'bitbucket-pipelines.yml',
];

/** lint 配置的常见位置 */
const LINT_CONFIG_FILES = [
  '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
  'biome.json', '.oxlintrc.json',
];

/** 项目上下文文件。任意一个就算有 */
const CONTEXT_FILES = ['CODEBUDDY.md', 'CLAUDE.md', `${CONFIG_DIR}/CODEBUDDY.md`];

interface Checks {
  /** 本仓是不是 JS/TS 工程。不是的话 lint 相关三项直接跳过 —— 对 Go 仓报"没有 lint 命令"是噪音 */
  isJs: boolean;
  hasLintScript: boolean;
  hasLintConfig: boolean;
  hasPreCommit: boolean;
  hasCi: boolean;
  hasRules: boolean;
  hasContextFile: boolean;
}

function runChecks(repoDir: string): Checks {
  const pkg = readJson<PkgJson>(path.join(repoDir, 'package.json'));
  const scripts = pkg?.scripts ?? {};

  // "能单独执行的检查命令"：名字里带 lint 的 script。
  // `build` 里顺带跑 eslint 不算 —— 那样检查和打包绑死，没法在提交前单独跑。
  const hasLintScript = Object.keys(scripts).some((k) => /(^|:)lint(:|$)|^lint/.test(k));

  return {
    isJs: Boolean(pkg),
    hasLintScript,
    hasLintConfig: LINT_CONFIG_FILES.some((f) => exists(path.join(repoDir, f))),
    hasPreCommit:
      exists(path.join(repoDir, '.husky')) ||
      Boolean(pkg?.['lint-staged']) ||
      Boolean(pkg?.husky) ||
      Boolean(pkg?.devDependencies?.husky) ||
      Boolean(pkg?.devDependencies?.['lint-staged']) ||
      exists(path.join(repoDir, '.pre-commit-config.yaml')),
    hasCi: CI_FILES.some((f) => exists(path.join(repoDir, f))),
    hasRules: hasNonEmptyRules(path.join(repoDir, CONFIG_DIR, 'rules')),
    hasContextFile: CONTEXT_FILES.some((f) => exists(path.join(repoDir, f))),
  };
}

/** `.codebuddy/rules/` 存在但是空的，等于没写 —— 所以要看里面有没有 .md */
function hasNonEmptyRules(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith('.md'));
  } catch {
    return false;
  }
}

/**
 * 「公共层」的层名白名单。
 *
 * ── 为什么光靠扇入不够 ──
 * 只按扇入 + 前两级目录分组，在 Java 这类深层布局上会推出 `src/main/` ——
 * 那是**整个源码树**。把整棵树标成公共层等于每次写文件都要先查影响面，
 * 也就是等于把人挡在外面。守一切等于什么都没守。
 *
 * 真正的判据是：「公共层」是一个**有名字的概念**（组件 / 工具 / 服务 / 公共），
 * 不是"凡是被引用得多的目录"。所以在扇入排序之上再要求目录名落在这个集合里。
 *
 * 宁缺毋滥：漏掉一个目录，人在 repo-facts.json 里手动加一行就好；
 * 而多推一个错的目录会天天误伤，然后插件被卸载。
 */
const LAYER_NAMES = new Set([
  // 前端
  'components', 'component', 'comps', 'widgets', 'hooks', 'hook',
  'composables', 'mixins', 'directives', 'store', 'stores', 'styles',
  // 通用分层
  'utils', 'util', 'helpers', 'helper', 'common', 'commons', 'shared', 'share',
  'core', 'lib', 'libs', 'sdk', 'constants', 'config', 'configs',
  'types', 'interfaces', 'dto', 'domain', 'entity', 'entities',
  // 服务与数据
  'services', 'service', 'api', 'apis', 'client', 'clients',
  'models', 'model', 'repository', 'repositories', 'dao', 'mapper', 'mappers',
  // 路由与中间件
  'middleware', 'middlewares', 'router', 'routers', 'routes', 'plugins',
]);

export interface PublicLayerGuess {
  prefix: string;
  /** 推测依据：哪个文件、被几个入口引用 */
  evidenceFile: string;
  routeCount: number;
}

/**
 * 从图谱推测公共层。
 *
 * 判据是**扇入 + 层名**：被入口（页面 / 路由）引用得越多越像公共层，
 * 但目录名还得真的像一个层（见 LAYER_NAMES 的说明）。
 *
 * 为什么按前两级目录分组：`src/components/DataTable/index.tsx` 的公共层单位是
 * `src/components/` 而不是 `src/components/DataTable/`——
 * 前者是人心里的"公共组件目录"，后者只是一个组件。粒度取错会让配置长到没人看。
 *
 * 为什么不含页面目录：页面是入口本身，没人引用它们，自然不会出现在 hotSpots 里。
 * 这是"用扇入而不是用目录名关键词"的附带好处 —— 不用维护 views/pages 黑名单。
 */
export function guessPublicLayer(graph: CodeGraph): PublicLayerGuess[] {
  const best = new Map<string, { file: string; count: number }>();
  for (const s of hotSpots(graph, 200)) {
    const segs = s.file.split('/');
    if (segs.length < 3) continue; // 至少 `a/b/c` 才有"前两级目录"
    if (!LAYER_NAMES.has(segs[1].toLowerCase())) continue;
    const prefix = `${segs[0]}/${segs[1]}/`;
    const cur = best.get(prefix);
    if (!cur || s.routeCount > cur.count) {
      best.set(prefix, { file: s.file, count: s.routeCount });
    }
  }
  return [...best.entries()]
    .map(([prefix, v]) => ({ prefix, evidenceFile: v.file, routeCount: v.count }))
    .sort((a, b) => b.routeCount - a.routeCount || a.prefix.localeCompare(b.prefix));
}

/** 往 .gitignore 追加缓存目录。已经有了就不动，返回是否真的改了 */
function appendGitignore(repoDir: string): boolean {
  const target = `${CONFIG_DIR}/.cache/`;
  const f = path.join(repoDir, '.gitignore');
  let body = '';
  try {
    body = fs.readFileSync(f, 'utf-8');
  } catch {
    /* 还没有 .gitignore */
  }
  if (body.split('\n').some((l) => l.trim() === target)) return false;
  try {
    const sep = body && !body.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(f, `${body}${sep}${target}\n`);
    return true;
  } catch {
    return false;
  }
}

export interface InitOptions {
  write: boolean;
}

export function renderInit(
  repoDir: string,
  handle: GraphHandle,
  scanResult: ScanResult,
  opts: InitOptions,
): { text: string } {
  const { graph } = handle;
  const checks = runChecks(repoDir);
  const existing = readFacts(repoDir);
  const guesses = guessPublicLayer(graph);

  // ── 头部：这个仓是什么 ──
  const identify = handle.fromCache
    ? `${graph.analyzer ?? '未识别'}（缓存）`
    : `${graph.analyzer ?? '未识别'}（现建 ${(handle.buildMs / 1000).toFixed(1)} 秒）`;

  const lines: string[] = [
    '',
    'repo-guard · 仓库体检',
    RULE,
    `仓库    ${path.basename(repoDir)}`,
    `识别    ${identify}`,
    `图谱    ${graph.stats.files} 个源文件 · ${graph.stats.routes} 个入口 · ${graph.stats.functions} 个符号`,
    `盲区    ${(graph.blindSpots ?? []).length} 条（查询结果里会带出来）`,
  ];

  // ── 发现的问题 ──
  const findings: Finding[] = [];
  if (scanResult.oversize.length) {
    findings.push({
      text: `${scanResult.oversize.length} 个文件超过 ${scanResult.lineLimit} 行，最大 ${scanResult.oversize[0].lines} 行`,
    });
  }
  if (scanResult.cycles.length) {
    findings.push({ text: `${scanResult.cycles.length} 处循环依赖` });
  }
  if (checks.isJs && !checks.hasLintScript) {
    findings.push({ text: '能单独执行的检查命令：没有 lint 命令，检查只能在打包时顺带跑' });
  }
  if (checks.isJs && !checks.hasLintConfig) {
    findings.push({ text: '体量与复杂度规则：没找到检查配置' });
  }
  if (checks.isJs && !checks.hasPreCommit) {
    findings.push({ text: '提交前自动检查：没有 husky / lint-staged' });
  }
  if (!checks.hasCi) {
    findings.push({ text: '流水线跑检查：没找到流水线配置' });
  }
  if (!checks.hasRules) {
    findings.push({ text: `仓库规则：${CONFIG_DIR}/rules/ 是空的` });
  }
  if (!checks.hasContextFile) {
    findings.push({ text: '项目上下文文件：没有 CODEBUDDY.md' });
  }

  lines.push('', `发现 ${findings.length} 个问题`);
  for (const f of findings) lines.push(`  ✗ ${f.text}`);

  // ── 推测的公共层 ──
  if (guesses.length) {
    lines.push(
      '',
      existing
        ? '推测的公共层（已有配置，下面是重新推测的结果）'
        : '推测的公共层（需要你确认）',
    );
    for (const g of guesses) {
      lines.push(`    ${g.prefix.padEnd(25)}依据：${g.evidenceFile} 被 ${g.routeCount} 个入口引用`);
    }
  }

  if (existing) {
    lines.push('', `当前配置    ${existing.publicLayer.join('  ')}`);

    // 配错的公共层路径**没有任何外部表现**：守卫 fail-open，路径在仓里不存在时
    // 看起来和"本次改动不涉及公共层"一模一样。更坏的是 SessionStart 还会照着
    // 这份清单注入指令，人以为有保护、模型以为有约束，实际两头都是空的。
    // 所以必须在这里显式报出来。
    const missing = patternsMissingFromGraph(graph, existing.publicLayer);
    const warn = missingPublicLayerWarning(missing);
    if (warn) lines.push('', `⚠ ${warn}`);
  }

  // ── 照这个顺序做 ──
  // 顺序是写死的（不是按问题出现顺序），因为它表达的是**依赖关系与性价比**：
  // 没有 lint 命令，流水线和 pre-commit 都没东西可跑。
  const actions: Action[] = [];
  if (checks.isJs && !checks.hasLintScript) {
    actions.push({ title: '补一个能单独执行的检查命令', why: '后面几步都靠它，本身不拦任何东西' });
  }
  if (checks.isJs && !checks.hasLintConfig) {
    actions.push({
      title: '检查配置加体量规则（max-lines / complexity / import-no-cycle）',
      why: scanResult.oversize.length
        ? `立刻会报出 ${scanResult.oversize.length} 个存量超长文件`
        : '防止以后堆肥',
    });
  }
  if (!checks.hasCi) {
    actions.push({ title: '流水线加一步跑检查', why: '不挂流水线，前两步等于没做' });
  }
  if (!existing) {
    actions.push({ title: '跑 repo-guard init --write', why: '生成公共层配置，写前守卫才会生效' });
  }
  if (!checks.hasRules) {
    actions.push({ title: `写仓库规则（${CONFIG_DIR}/rules/）`, why: 'AI 碰到公共层时自动看到约束' });
  }
  if (!checks.hasContextFile) {
    actions.push({ title: '写常驻纪律（CODEBUDDY.md）', why: '不许谎报已测、不许编造字段，每次会话都读' });
  }
  if (checks.isJs && !checks.hasPreCommit) {
    actions.push({ title: '提交前自动检查', why: '把问题提前到提交那一刻，少一轮流水线' });
  }

  if (actions.length) {
    lines.push('', '照这个顺序做（按性价比排，前三条是工程侧，不碰 AI）');
    actions.forEach((a, i) => {
      lines.push(`  ${i + 1}. ${a.title}`);
      lines.push(`     ${a.why}`);
    });
  }

  // ── 落盘 ──
  if (!opts.write) {
    lines.push('', '要生成配置文件请加 --write');
    return { text: `${lines.join('\n')}\n` };
  }

  const facts: RepoFacts = {
    version: 1,
    analyzer: graph.analyzer ?? null,
    // 已有配置时**不覆盖人确认过的清单**。人可能删掉了误判的目录、加了推测不到的目录，
    // 重跑 init 把它冲掉是不可接受的数据丢失。
    publicLayer: existing ? existing.publicLayer : guesses.map((g) => g.prefix),
    componentLibrary: existing ? existing.componentLibrary : null,
    lineLimit: existing ? existing.lineLimit : DEFAULT_LINE_LIMIT,
    generatedAt: new Date().toISOString(),
  };
  writeFacts(repoDir, facts);
  const appended = appendGitignore(repoDir);

  lines.push('', '', `已写入  ${CONFIG_DIR}/repo-facts.json`);
  if (appended) lines.push(`已追加  .gitignore  ${CONFIG_DIR}/.cache/`);

  lines.push(
    '',
    RULE,
    '下面这段请自己贴进检查配置 —— 本工具不改你的 lint 配置：',
    '',
    `  'max-lines': ['error', ${facts.lineLimit}],`,
    "  'max-lines-per-function': ['warn', 120],",
    "  'complexity': ['warn', 15],",
    "  'import/no-cycle': 'error',",
  );

  return { text: `${lines.join('\n')}\n` };
}

export { scan };
export type { ScanResult };
