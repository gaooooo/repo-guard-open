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
 *
 * ── 记到哪个仓 ──
 * 入参是会话 cwd，不是仓。多仓工作区（cwd 是放着几个仓的父目录）里，AI 查的目标可能在任一子仓：
 *   · 带了仓 id（`backend:service/x.go#F` 或 repo 参数）→ 向 atlas 要仓 id 对应的路径
 *   · 给了文件路径 → 按 cwd 解析，落在哪个仓就记哪个仓；cwd 下解析不到时，只有一个子仓有这个文件才记
 *   · 只给符号 → atlas --cache-only 解析出的每个目标各记各的仓
 * 单仓（cwd 在仓里）时与原来完全一样：不额外调 atlas list。
 */
import fs from 'node:fs';
import path from 'node:path';

import { atlasJson, atlasRepoEntry } from '../atlas/client.js';
import { childRepos, findRepoRoot, repoForPath, sessionRepos, splitFileSymbol, toRepoRelative } from '../runtime/paths.js';
import { recordHotQuery, recordQueried, recordSimilarPlan, recordSimilarSearch, type SimilarPlan } from '../runtime/session-state.js';
import { record } from '../runtime/metrics.js';

/** 钩子 post-atlas 的超时预算是 10 秒，这里给 atlas 留 7 秒 */
const LOOKUP_TIMEOUT_MS = 7000;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** 拆出 atlas 的 `仓id:` 前缀。仓 id 不含斜杠，冒号后面不是 `/`（排除 `C:/`、`file:/`） */
function splitRepoPrefix(target: string): { id?: string; rest: string } {
  const m = target.match(/^([A-Za-z0-9][\w.-]*):(?![/\\])(.+)$/);
  return m && !/^[A-Za-z]$/.test(m[1]) ? { id: m[1], rest: m[2] } : { rest: target };
}

interface AtlasRepo {
  id: string;
  path: string;
}
let reposCache: AtlasRepo[] | null = null;

/** atlas 当前工作区里的仓（id → 路径）。拿不到就是空表，调用方退回按路径解析 */
function atlasRepos(cwd: string): AtlasRepo[] {
  if (reposCache) return reposCache;
  const r = atlasJson<{ repos?: AtlasRepo[] }>(['list', '--json'], { cwd, timeoutMs: LOOKUP_TIMEOUT_MS });
  reposCache = r.ok ? (r.data.repos ?? []).filter((x) => typeof x?.id === 'string' && typeof x?.path === 'string') : [];
  return reposCache;
}

/** 仓 id → 本地路径。`--repo` 也可能直接给路径（repo-guard 自己调 atlas 时就这么传） */
function repoPathOf(cwd: string, id: string | undefined): string | null {
  if (!id) return null;
  if (/[/\\]/.test(id) || id === '.') {
    const p = path.resolve(cwd, id);
    return fs.existsSync(p) ? findRepoRoot(p) : null;
  }
  return atlasRepos(cwd).find((x) => x.id === id)?.path ?? null;
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

/** 一处「查过」：哪个仓、仓内相对路径 */
interface Hit {
  repoDir: string;
  rel: string;
}

function hitOf(repoDir: string | null, file: string): Hit | null {
  if (!repoDir) return null;
  const rel = toRepoRelative(repoDir, file);
  return rel ? { repoDir, rel } : null;
}

/** 给了文件路径（不经 atlas）时，它在哪个仓 */
function fileHits(cwd: string, base: string | null, file: string): Hit[] {
  if (base) {
    const h = hitOf(base, path.isAbsolute(file) ? file : path.join(base, file));
    return h ? [h] : [];
  }
  const kids = childRepos(cwd);
  if (!kids.length) {
    // 单仓：与原来一致，相对路径按仓根解析
    const own = findRepoRoot(cwd);
    const abs = path.isAbsolute(file) ? file : path.join(own, file);
    const h = hitOf(repoForPath(cwd, abs) ?? own, abs);
    return h ? [h] : [];
  }
  // 多仓工作区：先按 cwd 解析（backend/service/x.go），解析不到再看哪个子仓有这个文件
  const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  const direct = repoForPath(cwd, abs);
  if (direct && fs.existsSync(abs)) {
    const h = hitOf(direct, abs);
    return h ? [h] : [];
  }
  const owners = kids.filter((k) => fs.existsSync(path.join(k, file)));
  // 好几个子仓都有同名文件：不知道查的是哪个，宁可不记（G3：不许跨仓互相放行）
  if (owners.length !== 1) {
    const h = direct ? hitOf(direct, abs) : null;
    return h ? [h] : [];
  }
  const h = hitOf(owners[0], path.join(owners[0], file));
  return h ? [h] : [];
}

/**
 * atlas_impact / `atlas impact <target>`：记下目标所在文件。
 * 只给了符号时，`lookup` 为 true 才向 atlas 要符号所在文件（--cache-only）。
 */
export function trackImpact(cwd: string, rawTarget: string, opts: { lookup: boolean; repo?: string }): void {
  const { id: prefixId, rest } = splitRepoPrefix(rawTarget.trim());
  const target = rest.trim();
  if (!target) return;
  const repoId = prefixId || (opts.repo ?? '').trim() || undefined;
  const multi = childRepos(cwd).length > 0;
  // 前缀不认识（G5）或拿不到 atlas 仓表时，与原来一样按 cwd 解析
  const base = repoPathOf(cwd, repoId);
  const { file, symbol } = splitFileSymbol(target);
  const own = base ?? (multi ? cwd : findRepoRoot(cwd));
  const isFile = looksLikeFile(own, file) || (multi && childRepos(cwd).some((k) => looksLikeFile(k, file)));

  let hits: Hit[] = [];
  if (symbol || isFile) {
    hits = fileHits(cwd, base, file);
  } else if (opts.lookup) {
    const args = ['impact', target, '--json', '--cache-only'];
    if (repoId && base) args.push('--repo', repoId);
    const r = atlasJson<ImpactOut>(args, { cwd, timeoutMs: LOOKUP_TIMEOUT_MS });
    if (r.ok) {
      let ts = (r.data.targets ?? []).filter((t) => typeof t.file === 'string' && t.file);
      if (!multi && !base) {
        // 单仓：多仓工作区里同名符号可能在别的仓，只认本仓的（与原来一致）
        if (new Set(ts.map((t) => t.repo)).size > 1) {
          const id = atlasRepoEntry(own, LOOKUP_TIMEOUT_MS)?.id;
          if (id) ts = ts.filter((t) => t.repo === id);
        }
        hits = ts.map((t) => hitOf(own, t.file!)).filter((x): x is Hit => !!x);
      } else {
        // 多仓：atlas 对每个目标都算了影响面，各记各的仓
        hits = ts
          .map((t) => {
            const p = repoPathOf(cwd, t.repo) ?? base;
            return p ? hitOf(p, path.join(p, t.file!)) : null;
          })
          .filter((x): x is Hit => !!x);
      }
    }
  }

  const seen = new Set<string>();
  hits = hits.filter((h) => {
    const k = `${h.repoDir}\0${h.rel}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // 记状态在埋点之前 —— 与原 MCP 一致：查了就要能放行，别让埋点失败挡住
  for (const h of hits) recordQueried(h.repoDir, h.rel);
  const detail = symbol || !isFile ? 'impact_symbol' : 'impact';
  if (hits.length) for (const h of hits) record('graph_query', h.repoDir, { file: h.rel, detail });
  else record('graph_query', base ?? findRepoRoot(cwd), { detail });
}

export interface ReuseArgs {
  kind?: string;
  /** atlas 仓 id */
  repo?: string;
  /** workspace：在整个工作区找 */
  scope?: string;
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
export function trackReuse(cwd: string, a: ReuseArgs, opts: { lookupPlan: boolean }): void {
  // 记到哪些仓：指定了仓 → 那个仓；单仓 → 本仓；多仓工作区里没指定、或 scope=workspace → 全部子仓
  const named = repoPathOf(cwd, (a.repo ?? '').trim() || undefined);
  const repos = named ? [named] : a.scope === 'workspace' || childRepos(cwd).length ? sessionRepos(cwd) : [findRepoRoot(cwd)];
  for (const repoDir of repos) trackReuseIn(repoDir, a, { lookupPlan: opts.lookupPlan && repos.length === 1, cwd });
}

function trackReuseIn(repoDir: string, a: ReuseArgs, opts: { lookupPlan: boolean; cwd: string }): void {
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
  const r = atlasJson<SimilarOut>(args, { cwd: opts.cwd, timeoutMs: LOOKUP_TIMEOUT_MS });
  const plan = r.ok ? r.data.plan : null;
  if (!plan || typeof plan.key !== 'string') return;
  // atlas 的 plan.repo 是 atlas 仓 id；会话状态按 repo-guard 自己的 repoId 记，由 recordSimilarPlan 填
  const { repo: _repo, ts: _ts, ...rest } = plan;
  recordSimilarPlan(repoDir, rest);
  // detail 串起「查的什么 → 参考了谁」：回放与效能统计按它还原 AI 的选择
  record('similar_plan', repoDir, { detail: `${plan.kind}:${plan.resource}<-${plan.template ?? ''}${template ? '(指定)' : ''}` });
}

export function trackTrace(cwd: string, repo?: string): void {
  record('graph_query', repoPathOf(cwd, repo) ?? findRepoRoot(cwd), { detail: 'trace' });
}

/** post-atlas：按 MCP 工具名分发。cwd 是会话 cwd（多仓工作区时是父目录） */
export function trackAtlasTool(cwd: string, toolName: string, input: Record<string, unknown>): void {
  reposCache = null;
  const tool = toolName.replace(/^mcp__code-atlas__/, '');
  if (tool === 'atlas_impact') {
    trackImpact(cwd, str(input.target), { lookup: true, repo: str(input.repo) });
  } else if (tool === 'atlas_reuse') {
    const verbs = Array.isArray(input.verbs)
      ? input.verbs.filter((v): v is string => typeof v === 'string')
      : str(input.verbs).split(/[,，\s]+/).filter(Boolean);
    trackReuse(
      cwd,
      {
        kind: str(input.kind),
        intent: str(input.intent),
        resource: str(input.resource),
        verbs,
        template: str(input.template),
        repo: str(input.repo),
        scope: str(input.scope),
      },
      { lookupPlan: true },
    );
  } else if (tool === 'atlas_trace') {
    trackTrace(cwd, str(input.repo));
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
export function trackAtlasBash(cwd: string, command: string): void {
  reposCache = null;
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
    const repo = flags['--repo'];
    if (m[1] === 'impact') {
      if (pos[0]) trackImpact(cwd, pos[0], { lookup: false, repo });
    } else if (m[1] === 'similar') {
      trackReuse(
        cwd,
        {
          kind: 'similar',
          repo,
          intent: pos.join(' '),
          resource: flags['--resource'],
          verbs: (flags['--verbs'] ?? '').split(/[,，\s]+/).filter(Boolean),
          template: flags['--template'],
        },
        { lookupPlan: false },
      );
    } else {
      trackReuse(cwd, { kind: 'reuse', intent: pos.join(' '), repo, scope: words.includes('--all') ? 'workspace' : undefined }, { lookupPlan: false });
    }
  }
}
