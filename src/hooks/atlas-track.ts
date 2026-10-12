/**
 * 把 AI 对 code-atlas 的图谱查询记进会话状态 —— 写前守卫放行的依据。
 *
 * 以前图谱工具在 repo-guard 自己的 MCP 里，调用时顺手写会话状态。图谱移交 code-atlas 后，
 * repo-guard 看不到 atlas MCP 进程内部，只能在两个地方观察到「AI 查过了」：
 *   · PostToolUse 钩子 post-atlas：工具名 mcp__code-atlas__atlas_impact / atlas_reuse / atlas_trace，
 *     stdin 里有 tool_input（如 {"target":"service/validator.go#validateTenant"}）
 *   · post-bash：AI 在终端里跑了 `atlas impact …` / `atlas similar …` / `atlas hot …`
 *
 * 钩子里禁止建图：需要向 atlas 要数据时一律 `--cache-only`，失败就只记能记的部分（fail-open）。
 * 埋点事件名与 detail 沿用原 MCP 的（graph_query / similar_plan），历史数据可比。
 */
import fs from 'node:fs';
import path from 'node:path';

import { atlasJson, atlasRepoEntry } from '../atlas/client.js';
import { splitFileSymbol, toRepoRelative } from '../runtime/paths.js';
import { recordHotQuery, recordQueried, recordSimilarPlan, recordSimilarSearch, type SimilarPlan } from '../runtime/session-state.js';
import { record } from '../runtime/metrics.js';

/** 钩子 post-atlas 的超时预算是 10 秒，这里给 atlas 留 7 秒 */
const LOOKUP_TIMEOUT_MS = 7000;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** 去掉 atlas 的 `仓id:` 前缀。仓 id 不含斜杠，冒号后面不是 `/`（排除 `C:/`、`file:/`） */
function stripRepoPrefix(target: string): string {
  const m = target.match(/^([A-Za-z0-9][\w.-]*):(?![/\\])(.+)$/);
  return m && !/^[A-Za-z]$/.test(m[1]) ? m[2] : target;
}

/**
 * 看着像文件路径：带目录分隔符，或仓库根下真有这个文件（main.go）。
 * 只看扩展名不行 —— `Agent.ID` 这种「结构体.字段」的符号写法也以「.标识符」结尾。
 */
function looksLikeFile(repoDir: string, s: string): boolean {
  if (/[/\\]/.test(s)) return true;
  try {
    return fs.statSync(path.join(repoDir, s)).isFile();
  } catch {
    return false;
  }
}

interface ImpactOut {
  targets?: Array<{ repo?: string; file?: string }>;
}

/**
 * atlas_impact / `atlas impact <target>`：记下目标所在文件。
 * 只给了符号时，`lookup` 为 true 才向 atlas 要符号所在文件（--cache-only）。
 */
export function trackImpact(repoDir: string, rawTarget: string, opts: { lookup: boolean }): void {
  const target = stripRepoPrefix(rawTarget.trim());
  if (!target) return;
  const { file, symbol } = splitFileSymbol(target);
  const files: string[] = [];
  const isFile = looksLikeFile(repoDir, file);
  if (symbol || isFile) {
    files.push(file);
  } else if (opts.lookup) {
    const r = atlasJson<ImpactOut>(['impact', target, '--json', '--cache-only'], { cwd: repoDir, timeoutMs: LOOKUP_TIMEOUT_MS });
    if (r.ok) {
      let ts = (r.data.targets ?? []).filter((t) => typeof t.file === 'string' && t.file);
      // 多仓工作区里同名符号可能在别的仓：只认本仓的
      if (new Set(ts.map((t) => t.repo)).size > 1) {
        const id = atlasRepoEntry(repoDir, LOOKUP_TIMEOUT_MS)?.id;
        if (id) ts = ts.filter((t) => t.repo === id);
      }
      files.push(...ts.map((t) => t.file!));
    }
  }
  const rels = [...new Set(files.map((f) => toRepoRelative(repoDir, f)).filter((x): x is string => !!x))];
  // 记状态在埋点之前 —— 与原 MCP 一致：查了就要能放行，别让埋点失败挡住
  for (const rel of rels) recordQueried(repoDir, rel);
  const detail = symbol || !isFile ? 'impact_symbol' : 'impact';
  if (rels.length) for (const rel of rels) record('graph_query', repoDir, { file: rel, detail });
  else record('graph_query', repoDir, { detail });
}

export interface ReuseArgs {
  kind?: string;
  intent?: string;
  resource?: string;
  verbs?: string[];
  template?: string;
}

interface SimilarOut {
  plan?: (Omit<SimilarPlan, 'ts'> & { ts?: number }) | null;
}

/**
 * atlas_reuse / `atlas similar` / `atlas hot`：
 *   kind=similar（或给了 resource / verbs）→ 记「查过同类实现」，`lookupPlan` 时再 --cache-only 跑一次 similar 拿参考计划
 *   否则 → 记「查过热点 / 现成方法」
 */
export function trackReuse(repoDir: string, a: ReuseArgs, opts: { lookupPlan: boolean }): void {
  const intent = (a.intent ?? '').trim();
  const resource = (a.resource ?? '').trim();
  const verbs = (a.verbs ?? []).filter(Boolean);
  const template = (a.template ?? '').trim();
  const kind = a.kind || (resource || verbs.length ? 'similar' : 'reuse');

  if (kind !== 'similar') {
    recordHotQuery(repoDir);
    record('graph_query', repoDir, { detail: intent ? 'hot_intent' : 'hot' });
    return;
  }
  if (!intent && !resource) return;
  recordSimilarSearch(repoDir, intent || resource);
  record('graph_query', repoDir, { detail: resource ? 'similar_resource' : 'similar' });
  if (!opts.lookupPlan) return;

  const args = ['similar'];
  if (intent) args.push(intent);
  if (resource) args.push('--resource', resource);
  if (verbs.length) args.push('--verbs', verbs.join(','));
  if (template) args.push('--template', template);
  args.push('--json', '--cache-only', '--repo', repoDir);
  const r = atlasJson<SimilarOut>(args, { cwd: repoDir, timeoutMs: LOOKUP_TIMEOUT_MS });
  const plan = r.ok ? r.data.plan : null;
  if (!plan || typeof plan.key !== 'string') return;
  // atlas 的 plan.repo 是 atlas 仓 id；会话状态按 repo-guard 自己的 repoId 记，由 recordSimilarPlan 填
  const { repo: _repo, ts: _ts, ...rest } = plan;
  recordSimilarPlan(repoDir, rest);
  // detail 串起「查的什么 → 参考了谁」：回放与效能统计按它还原 AI 的选择
  record('similar_plan', repoDir, { detail: `${plan.kind}:${plan.resource}<-${plan.template ?? ''}${template ? '(指定)' : ''}` });
}

export function trackTrace(repoDir: string): void {
  record('graph_query', repoDir, { detail: 'trace' });
}

/** post-atlas：按 MCP 工具名分发 */
export function trackAtlasTool(repoDir: string, toolName: string, input: Record<string, unknown>): void {
  const tool = toolName.replace(/^mcp__code-atlas__/, '');
  if (tool === 'atlas_impact') {
    trackImpact(repoDir, str(input.target), { lookup: true });
  } else if (tool === 'atlas_reuse') {
    const verbs = Array.isArray(input.verbs)
      ? input.verbs.filter((v): v is string => typeof v === 'string')
      : str(input.verbs).split(/[,，\s]+/).filter(Boolean);
    trackReuse(
      repoDir,
      { kind: str(input.kind), intent: str(input.intent), resource: str(input.resource), verbs, template: str(input.template) },
      { lookupPlan: true },
    );
  } else if (tool === 'atlas_trace') {
    trackTrace(repoDir);
  }
}

/** 粗糙的 shell 分词：认单双引号，不处理转义与变量 */
function shellWords(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const ATLAS_VALUE_FLAGS = new Set(['--resource', '--verbs', '--template', '--limit', '--repo', '--ws', '--depth', '--line-limit']);

/**
 * post-bash：识别命令里的 `atlas impact|similar|hot …`（含 `node …/bin/atlas …`），照 MCP 一样记录。
 * 不再回头向 atlas 要 plan —— post-bash 只有 5 秒，且终端里的 similar 是人看的。
 */
export function trackAtlasBash(repoDir: string, command: string): void {
  const re = /(?:^|[\s;&|(/])atlas\s+(impact|similar|hot)\b([^;&|\n]*)/g;
  for (let m = re.exec(command); m; m = re.exec(command)) {
    const words = shellWords(m[2]);
    const pos: string[] = [];
    const flags: Record<string, string> = {};
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (ATLAS_VALUE_FLAGS.has(w)) {
        flags[w] = words[i + 1] ?? '';
        i++;
      } else if (!w.startsWith('-')) {
        pos.push(w);
      }
    }
    if (m[1] === 'impact') {
      if (pos[0]) trackImpact(repoDir, pos[0], { lookup: false });
    } else if (m[1] === 'similar') {
      trackReuse(
        repoDir,
        {
          kind: 'similar',
          intent: pos.join(' '),
          resource: flags['--resource'],
          verbs: (flags['--verbs'] ?? '').split(/[,，\s]+/).filter(Boolean),
          template: flags['--template'],
        },
        { lookupPlan: false },
      );
    } else {
      trackReuse(repoDir, { kind: 'reuse', intent: pos.join(' ') }, { lookupPlan: false });
    }
  }
}
