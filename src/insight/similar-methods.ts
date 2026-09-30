/**
 * 后端「同类实现」—— 按资源名把方法归成家族，回答「这类接口本仓已经怎么写了」。
 *
 * ── 为什么不复用 similarPages ──
 * similarPages 吃的是前端页面指纹（import + JSX 标签）。后端仓没有这个东西，
 * 调 similar 恒返回「本图谱没有页面指纹」—— 等于后端永远拿不到参考实现。
 *
 * 后端接口天然按「动词 + 资源」命名：DescribeAIMCredentials / CreateAIMCredential /
 * DeleteAIMCredential。去掉动词前缀就是家族键。这是**骨架检索**：只看名字和调用边，
 * 不看语义，所以输出里必须说清楚。
 *
 * ── 只依赖 CodeGraph ──
 * 本目录（src/insight）刻意写成纯函数、零宿主依赖，下期要整体搬去平台侧复用。
 */
import type { CodeGraph, FunctionNode } from '../graph/types.js';

/** 动词前缀。顺序有意义：长的在前，避免 `Get` 抢走 `GetOrCreate` 这类 */
export const VERBS = [
  'Describe', 'Create', 'Modify', 'Delete', 'Update', 'Remove', 'Get', 'List', 'Query',
  'Enable', 'Disable', 'Bind', 'Unbind', 'Search', 'Handle', 'Check', 'Sync', 'Refresh',
  'Download', 'Upload', 'Open', 'Register', 'Validate', 'Report', 'Add', 'Set', 'Batch',
] as const;

/** 一个完整资源通常具备的动作。只在家族已有 ≥2 个动作时才报缺口，否则是噪音 */
const CRUD = ['Describe', 'Create', 'Modify', 'Delete'] as const;

export type Layer = 'router' | 'service' | 'logic' | 'repo' | 'sdk' | 'dto' | 'other';

export function layerOf(file: string): Layer {
  const f = `/${file}`;
  if (/\/(router|routes?)\//.test(f)) return 'router';
  if (/\/(service|controller|controllers|handler|handlers|api)\//.test(f)) return 'service';
  if (/\/(logic|biz|usecase|domain)\//.test(f)) return 'logic';
  if (/\/(repo|dao|store|repository|model|models)\//.test(f)) return 'repo';
  if (/\/dto\//.test(f)) return 'dto';
  if (/\/pkg\//.test(f)) return 'sdk';
  return 'other';
}

function isCtor(name: string): boolean {
  return name.startsWith('New') && (name.endsWith('Request') || name.endsWith('Response'));
}

/** 拆出 {verb, family}。没有已知动词时 verb 为空、family 为原名 */
export function splitVerb(name: string): { verb: string; family: string } {
  for (const v of VERBS) {
    if (name.startsWith(v) && name.length > v.length && /[A-Z]/.test(name[v.length])) {
      return { verb: v, family: name.slice(v.length) };
    }
  }
  return { verb: '', family: name };
}

/** 家族归一键：小写 + 去复数尾 s。DescribeAIMCredentials 与 CreateAIMCredential 同族 */
export function familyKey(family: string): string {
  const k = family.toLowerCase();
  return k.length > 3 && k.endsWith('s') ? k.slice(0, -1) : k;
}

export interface FamilyMember {
  file: string;
  name: string;
  owner?: string | null;
  line: number;
  layer: Layer;
  verb: string;
}

export interface ChainStep {
  file: string;
  name: string;
  layer: Layer;
}

export interface MethodFamily {
  family: string;
  key: string;
  members: FamilyMember[];
  verbs: string[];
  /** CRUD 里缺的动作。家族动作不足 2 个时为空 */
  missingVerbs: string[];
  /** 最深的一条分层调用链（service → logic → repo），作为照抄的参考 */
  reference: { entry: FamilyMember; chain: ChainStep[] } | null;
}

export interface SimilarMethodsResult {
  query: string;
  /** 查询里带的动词（如 Delete），用于判断「你要写的是不是已存在」 */
  wantVerb: string;
  matchedBy: 'family' | 'substring' | null;
  families: MethodFamily[];
  /** 查询本身就是一个已存在的方法 */
  exists: FamilyMember[];
  unmatchedReason?: string;
}

function eligible(f: FunctionNode): boolean {
  return !f.file.endsWith('_test.go') && !isCtor(f.name) && !/(^|\/)(test|tests|__tests__)\//.test(f.file);
}

/** 从一个方法出发，沿已解析调用边往下走，每层取第一条进入更深分层的边 */
function chainFrom(graph: CodeGraph, start: FunctionNode, fnIndex: Map<string, FunctionNode[]>): ChainStep[] {
  const order: Layer[] = ['router', 'service', 'logic', 'repo'];
  const out: ChainStep[] = [{ file: start.file, name: start.name, layer: layerOf(start.file) }];
  let cur = start;
  const seen = new Set([`${start.file}#${start.name}`]);
  for (let depth = 0; depth < 3; depth++) {
    const curRank = order.indexOf(layerOf(cur.file));
    let next: FunctionNode | undefined;
    for (const c of graph.calls) {
      if (c.fromFile !== cur.file || !c.toFile || c.line < cur.line || c.line > cur.endLine) continue;
      const rank = order.indexOf(layerOf(c.toFile));
      if (rank <= curRank && curRank >= 0) continue;
      const cand = (fnIndex.get(`${c.toFile}#${c.toMethod}`) ?? [])[0];
      if (cand && !seen.has(`${cand.file}#${cand.name}`)) {
        next = cand;
        break;
      }
    }
    if (!next) break;
    seen.add(`${next.file}#${next.name}`);
    out.push({ file: next.file, name: next.name, layer: layerOf(next.file) });
    cur = next;
  }
  return out;
}

export function similarMethods(graph: CodeGraph, query: { intent: string; limit?: number }): SimilarMethodsResult {
  const raw = (query.intent ?? '').trim();
  // 允许「新增 DeleteAIMCredential 接口」这种句子：取最长的一个标识符
  const ident = (raw.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).sort((a, b) => b.length - a.length)[0] ?? '';
  const { verb: wantVerb, family: wantFamily } = splitVerb(ident);
  const base: SimilarMethodsResult = { query: raw, wantVerb, matchedBy: null, families: [], exists: [] };
  if (!ident || ident.length < 3) {
    return { ...base, unmatchedReason: '后端同类检索需要一个资源名或方法名（如 AIMCredential、DeleteAIMCredential）。' };
  }

  const fns = graph.functions.filter(eligible);
  const fnIndex = new Map<string, FunctionNode[]>();
  for (const f of fns) {
    const k = `${f.file}#${f.name}`;
    const list = fnIndex.get(k);
    if (list) list.push(f);
    else fnIndex.set(k, [f]);
  }

  const groups = new Map<string, { family: string; fns: FunctionNode[] }>();
  for (const f of fns) {
    const { family } = splitVerb(f.name);
    const key = familyKey(family);
    const g = groups.get(key);
    if (g) g.fns.push(f);
    else groups.set(key, { family, fns: [f] });
  }

  const want = familyKey(wantFamily);
  let keys: string[] = groups.has(want) ? [want] : [];
  let matchedBy: SimilarMethodsResult['matchedBy'] = keys.length ? 'family' : null;
  if (!keys.length && want.length >= 4) {
    keys = [...groups.keys()]
      // 只认「家族名包含查询词」。反过来（查询词包含家族名）会让 AIMWorkload 命中 Load
      .filter((k) => k.includes(want))
      .sort((a, b) => (groups.get(b)!.fns.length - groups.get(a)!.fns.length) || a.localeCompare(b));
    if (keys.length) matchedBy = 'substring';
  }
  const limit = Math.min(Math.max(query.limit ?? 3, 1), 5);
  keys = keys.slice(0, limit);

  const families: MethodFamily[] = keys.map((key) => {
    const g = groups.get(key)!;
    const members: FamilyMember[] = g.fns
      .map((f) => ({ file: f.file, name: f.name, owner: f.owner ?? null, line: f.line, layer: layerOf(f.file), verb: splitVerb(f.name).verb }))
      .sort((a, b) => a.layer.localeCompare(b.layer) || a.file.localeCompare(b.file) || a.line - b.line);
    const verbs = [...new Set(members.map((m) => m.verb).filter(Boolean))].sort();
    const crudHave = CRUD.filter((v) => verbs.includes(v));
    const missingVerbs = crudHave.length >= 2 ? CRUD.filter((v) => !verbs.includes(v)) : [];
    let reference: MethodFamily['reference'] = null;
    for (const m of members.filter((x) => x.layer === 'service' || x.layer === 'router' || x.layer === 'sdk')) {
      const fn = (fnIndex.get(`${m.file}#${m.name}`) ?? [])[0];
      if (!fn) continue;
      const chain = chainFrom(graph, fn, fnIndex);
      if (!reference || chain.length > reference.chain.length) reference = { entry: m, chain };
    }
    return { family: g.family, key, members, verbs, missingVerbs, reference };
  });

  const exists = families.flatMap((f) => f.members.filter((m) => m.name === ident));
  if (!families.length) {
    return {
      ...base,
      unmatchedReason: `本仓没有「${wantFamily || ident}」这个资源的方法家族。这是按命名的骨架检索，不是语义搜索 —— 换一个资源名或已有方法名再试。`,
    };
  }
  return { ...base, matchedBy, families, exists };
}

const LAYER_LABEL: Record<Layer, string> = {
  router: '路由', service: '接口层', logic: '逻辑层', repo: '存储层', sdk: 'SDK', dto: 'DTO', other: '其他',
};

/** 给 AI 与人一起看的文本。与 renderSimilar 同一种语气：先结论，再参考，最后纪律 */
export function renderSimilarMethods(r: SimilarMethodsResult, repoName: string): string {
  if (r.unmatchedReason) return r.unmatchedReason;
  const lines = [`## 同类实现 · 后端方法家族（仓库 ${repoName}）`, '检索方式：按「动词 + 资源名」命名归族的骨架检索，不是语义搜索。', ''];
  if (r.exists.length) {
    lines.push(`注意：${r.exists.map((m) => `\`${m.file}#${m.name}\``).join('、')} 已经存在 —— 先确认是改它还是真要新增。`, '');
  } else if (r.wantVerb) {
    lines.push(`本仓还没有 ${r.wantVerb}${r.families[0].family}，按下面同族方法的分层写法补。`, '');
  }
  for (const f of r.families) {
    lines.push(`### 家族 ${f.family}（${f.members.length} 个方法，动作：${f.verbs.join(' / ') || '无动词前缀'}）`);
    const byLayer = new Map<Layer, FamilyMember[]>();
    for (const m of f.members) byLayer.set(m.layer, [...(byLayer.get(m.layer) ?? []), m]);
    for (const [layer, ms] of byLayer) {
      lines.push(`- ${LAYER_LABEL[layer]}：${ms.slice(0, 8).map((m) => `\`${m.file}#${m.name}\``).join('、')}${ms.length > 8 ? ` …另 ${ms.length - 8} 个` : ''}`);
    }
    if (f.reference && f.reference.chain.length > 1) {
      lines.push(`- 参考分层骨架：${f.reference.chain.map((s) => `${LAYER_LABEL[s.layer]} \`${s.file}#${s.name}\``).join(' → ')}`);
    }
    if (f.missingVerbs.length) lines.push(`- 家族缺口：没有 ${f.missingVerbs.join('、')}`);
    lines.push('');
  }
  lines.push('照参考骨架分层写（接口层只做参数校验与转发，逻辑放逻辑层），不要平行再造一套。改这些参考文件前仍要 impact。');
  return lines.join('\n');
}
