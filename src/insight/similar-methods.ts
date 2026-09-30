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

/**
 * 家族归一键：小写 + 去复数。DescribeAIMCredentials 与 CreateAIMCredential 同族。
 * 复数只处理英文常见三种：-ies → -y（Categories）、-sses → -ss（Accesses）、-s。
 * 以 ss 结尾的单数（Access）不动 —— 否则会被砍成 acces，和 Accesses 分成两族。
 */
export function familyKey(family: string): string {
  const k = family.toLowerCase();
  if (k.length <= 3) return k;
  if (k.endsWith('ies')) return `${k.slice(0, -3)}y`;
  if (k.endsWith('sses')) return k.slice(0, -2);
  if (k.endsWith('ss')) return k;
  return k.endsWith('s') ? k.slice(0, -1) : k;
}

/** 与 familyKey 同规则，但保留大小写：AIMCategories → AIMCategory */
function singular(family: string): string {
  if (family.length <= 3) return family;
  if (/ies$/i.test(family)) return `${family.slice(0, -3)}y`;
  if (/sses$/i.test(family)) return family.slice(0, -2);
  if (/ss$/i.test(family)) return family;
  return /s$/i.test(family) ? family.slice(0, -1) : family;
}
function isPlural(family: string): boolean {
  return singular(family) !== family;
}
function plural(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}
function snake(word: string): string {
  return word.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
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

/** 照模板推导出的一个新方法 */
export interface PlannedMethod {
  layer: Layer;
  file: string;
  name: string;
  /** 模板里对应的那个方法 */
  from: ChainStep;
  /** 模板方法已经存在于本仓、不需要新建（如存储层通用的 Find / Insert） */
  reuse: boolean;
}

export interface VerbChain {
  verb: string;
  chain: ChainStep[];
  /** 把这条链的每一步换成新资源名之后 */
  planned: PlannedMethod[];
}

export interface TemplateRef {
  family: MethodFamily;
  /** 按动作分行的分层骨架（每个动作一条 接口层 → 逻辑层 → 存储层） */
  chains: VerbChain[];
  /** 其他也完整的家族，可换着当模板 */
  alternatives: string[];
}

export interface SimilarMethodsResult {
  query: string;
  /** 查询里带的动词（如 Delete），用于判断「你要写的是不是已存在」 */
  wantVerb: string;
  /** 查询里的资源名（单数），如 AIMWorkload */
  wantResource: string;
  matchedBy: 'family' | 'substring' | 'template' | null;
  families: MethodFamily[];
  /** 查询本身就是一个已存在的方法 */
  exists: FamilyMember[];
  /** 本仓没有这个资源：借最完整的 CRUD 家族当模板 */
  template?: TemplateRef;
  /** 资源存在但缺这个动作：从别的家族借同一动作的骨架 */
  verbTemplate?: { family: string; chain: VerbChain };
  unmatchedReason?: string;
}

function eligible(f: FunctionNode): boolean {
  return !f.file.endsWith('_test.go') && !isCtor(f.name) && !/(^|\/)(test|tests|__tests__)\//.test(f.file);
}

const ENTRY_LAYERS: Layer[] = ['service', 'router', 'sdk'];

/** 同一动作在下层常换个说法：Modify 接口层 → 逻辑层 ModifyX → 存储层 Update */
const VERB_SYNONYMS: Record<string, string[]> = {
  Describe: ['Describe', 'Get', 'List', 'Query', 'Find', 'Search'],
  Create: ['Create', 'Insert', 'Add', 'Save'],
  Modify: ['Modify', 'Update', 'Set', 'Save'],
  Delete: ['Delete', 'Remove'],
};

/**
 * 从一个方法出发，沿已解析调用边往下走，每层取一条进入更深分层的边。
 *
 * 优先取**同一动作**的下游：ModifyAIMAgent 函数体里先调 DescribeAgent（查存在）、再调
 * ModifyAgent。只取第一条的话，Modify / Delete 的骨架都会变成 → DescribeAgent → FindOne，
 * 抄出来就是错的。
 */
function chainFrom(graph: CodeGraph, start: FunctionNode, fnIndex: Map<string, FunctionNode[]>): ChainStep[] {
  const order: Layer[] = ['router', 'service', 'logic', 'repo'];
  const out: ChainStep[] = [{ file: start.file, name: start.name, layer: layerOf(start.file) }];
  const syn = VERB_SYNONYMS[splitVerb(start.name).verb] ?? [];
  const sameVerb = (name: string) => syn.some((v) => name.startsWith(v));
  let cur = start;
  const seen = new Set([`${start.file}#${start.name}`]);
  for (let depth = 0; depth < 3; depth++) {
    const curRank = order.indexOf(layerOf(cur.file));
    let next: FunctionNode | undefined;
    let first: FunctionNode | undefined;
    for (const c of graph.calls) {
      if (c.fromFile !== cur.file || !c.toFile || c.line < cur.line || c.line > cur.endLine) continue;
      const rank = order.indexOf(layerOf(c.toFile));
      if (rank <= curRank && curRank >= 0) continue;
      const cand = (fnIndex.get(`${c.toFile}#${c.toMethod}`) ?? [])[0];
      if (!cand || seen.has(`${cand.file}#${cand.name}`)) continue;
      first ??= cand;
      if (sameVerb(cand.name)) {
        next = cand;
        break;
      }
    }
    next ??= first;
    if (!next) break;
    seen.add(`${next.file}#${next.name}`);
    out.push({ file: next.file, name: next.name, layer: layerOf(next.file) });
    cur = next;
  }
  return out;
}

/**
 * 把模板里的一个方法名换成新资源的名字。
 *
 * 模板家族 AIMCredentials、新资源 AIMWorkload：
 *   DescribeAIMCredentials → DescribeAIMWorkloads   （家族名整段替换，保留复数）
 *   DescribeCredentials    → DescribeWorkloads      （逻辑层常去掉前缀 AIM：按后缀对齐）
 *   Find                   → null                   （没带资源名，是通用方法，照用）
 */
export function mapName(name: string, tplFamily: string, wantResource: string): string | null {
  const { verb, family } = splitVerb(name);
  if (!verb) return null;
  const tplSing = singular(tplFamily);
  const famSing = singular(family);
  let core: string | null = null;
  if (famSing.toLowerCase() === tplSing.toLowerCase()) {
    core = wantResource;
  } else if (tplSing.toLowerCase().endsWith(famSing.toLowerCase()) && famSing.length >= 3) {
    // 模板去掉的前缀（AIM），新资源若也带这个前缀就同样去掉
    const prefix = tplSing.slice(0, tplSing.length - famSing.length);
    core = prefix && wantResource.startsWith(prefix) ? wantResource.slice(prefix.length) : wantResource;
  }
  if (!core) return null;
  return verb + (isPlural(family) ? plural(core) : core);
}

/** 文件名里模板资源的 snake 形式换成新资源的：credential.go → workload.go。对不上就给出建议名 */
function mapFile(file: string, tplFamily: string, wantResource: string): string {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
  const base = file.slice(dir.length);
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : '';
  const tplCore = snake(singular(tplFamily));
  const wantCore = snake(wantResource);
  // 从长到短试：aim_credential、credential
  const parts = tplCore.split('_');
  for (let i = 0; i < parts.length; i++) {
    const t = parts.slice(i).join('_');
    if (base.includes(t)) {
      const w = wantCore.split('_');
      const drop = i > 0 && w.slice(0, i).join('_') === parts.slice(0, i).join('_') ? i : 0;
      return dir + base.replace(t, w.slice(drop).join('_'));
    }
  }
  return `${dir}${wantCore}${ext}`;
}

function planChain(chain: ChainStep[], tplFamily: string, wantResource: string, exists: (file: string, name: string) => boolean): PlannedMethod[] {
  return chain.map((step) => {
    const file = mapFile(step.file, tplFamily, wantResource);
    // 名字里不带资源名的（存储层 Find / Insert）：方法名照用，但属于新资源自己的 repo 文件；
    // 文件名对不上资源（通用工具文件）才是真的复用同一个方法
    const name = mapName(step.name, tplFamily, wantResource) ?? step.name;
    const reuse = file === step.file ? name === step.name : exists(file, name);
    return { layer: step.layer, file, name, from: step, reuse };
  });
}

function buildFamily(graph: CodeGraph, key: string, g: { family: string; fns: FunctionNode[] }, fnIndex: Map<string, FunctionNode[]>): MethodFamily {
  const members: FamilyMember[] = g.fns
    .map((f) => ({ file: f.file, name: f.name, owner: f.owner ?? null, line: f.line, layer: layerOf(f.file), verb: splitVerb(f.name).verb }))
    .sort((a, b) => a.layer.localeCompare(b.layer) || a.file.localeCompare(b.file) || a.line - b.line);
  const verbs = [...new Set(members.map((m) => m.verb).filter(Boolean))].sort();
  const crudHave = CRUD.filter((v) => verbs.includes(v));
  const missingVerbs = crudHave.length >= 2 ? CRUD.filter((v) => !verbs.includes(v)) : [];
  let reference: MethodFamily['reference'] = null;
  for (const m of members.filter((x) => ENTRY_LAYERS.includes(x.layer))) {
    const fn = (fnIndex.get(`${m.file}#${m.name}`) ?? [])[0];
    if (!fn) continue;
    const chain = chainFrom(graph, fn, fnIndex);
    if (!reference || chain.length > reference.chain.length) reference = { entry: m, chain };
  }
  return { family: g.family, key, members, verbs, missingVerbs, reference };
}

/** 每个 CRUD 动作取接口层里调用链最深的那个方法 */
function verbChains(graph: CodeGraph, fam: MethodFamily, fnIndex: Map<string, FunctionNode[]>): Array<{ verb: string; chain: ChainStep[] }> {
  const out: Array<{ verb: string; chain: ChainStep[] }> = [];
  for (const verb of CRUD) {
    let best: ChainStep[] | null = null;
    for (const m of fam.members.filter((x) => x.verb === verb && ENTRY_LAYERS.includes(x.layer))) {
      const fn = (fnIndex.get(`${m.file}#${m.name}`) ?? [])[0];
      if (!fn) continue;
      const c = chainFrom(graph, fn, fnIndex);
      // 同动作多个时（DescribeAIMCredentials 列表 / DescribeAIMCredential 详情）取链更深的，再取列表形态
      if (!best || c.length > best.length) best = c;
    }
    if (best) out.push({ verb, chain: best });
  }
  return out;
}

/**
 * 挑模板：CRUD 四个动作在接口层都有、且调用链走到存储层的动作数最多的家族。
 * 与新资源共前缀（都叫 AIM…）的优先 —— 同一块业务的写法最接近。
 */
function pickTemplates(
  graph: CodeGraph,
  groups: Map<string, { family: string; fns: FunctionNode[] }>,
  fnIndex: Map<string, FunctionNode[]>,
  wantResource: string,
  needVerb?: string,
): Array<{ fam: MethodFamily; chains: Array<{ verb: string; chain: ChainStep[] }>; score: number }> {
  const out: Array<{ fam: MethodFamily; chains: Array<{ verb: string; chain: ChainStep[] }>; score: number }> = [];
  const wantPrefix = (wantResource.match(/^[A-Z]{2,}(?=[A-Z][a-z])/) ?? [''])[0];
  for (const [key, g] of groups) {
    const entryVerbs = new Set(g.fns.filter((f) => ENTRY_LAYERS.includes(layerOf(f.file))).map((f) => splitVerb(f.name).verb));
    if (needVerb ? !entryVerbs.has(needVerb) : !CRUD.every((v) => entryVerbs.has(v))) continue;
    const fam = buildFamily(graph, key, g, fnIndex);
    const chains = verbChains(graph, fam, fnIndex).filter((c) => !needVerb || c.verb === needVerb);
    const deep = chains.filter((c) => c.chain.some((s) => s.layer === 'repo')).length;
    if (!deep) continue;
    const prefixBonus = wantPrefix && singular(g.family).startsWith(wantPrefix) ? 0.5 : 0;
    out.push({ fam, chains, score: deep + prefixBonus + Math.min(fam.members.length, 20) / 100 });
  }
  return out.sort((a, b) => b.score - a.score || a.fam.key.localeCompare(b.fam.key));
}

/** 查询像不像「要新建一个资源 / 接口」。不像（如 EscapeRegex）就不给 CRUD 模板，免得误导 */
function looksLikeResource(raw: string, wantVerb: string): boolean {
  return Boolean(wantVerb) || /crud|增删改查|接口|资源|服务|管理/i.test(raw);
}

export function similarMethods(graph: CodeGraph, query: { intent: string; limit?: number }): SimilarMethodsResult {
  const raw = (query.intent ?? '').trim();
  // 允许「新增 DeleteAIMCredential 接口」这种句子：取最长的一个标识符
  const ident = (raw.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).sort((a, b) => b.length - a.length)[0] ?? '';
  const { verb: wantVerb, family: wantFamily } = splitVerb(ident);
  const wantResource = singular(wantFamily);
  const base: SimilarMethodsResult = { query: raw, wantVerb, wantResource, matchedBy: null, families: [], exists: [] };
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
  const exists = (file: string, name: string) => fnIndex.has(`${file}#${name}`);

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

  const families = keys.map((key) => buildFamily(graph, key, groups.get(key)!, fnIndex));
  const existing = families.flatMap((f) => f.members.filter((m) => m.name === ident));

  if (families.length) {
    const out: SimilarMethodsResult = { ...base, matchedBy, families, exists: existing };
    // 资源在、但缺这个动作：同族里没有可照抄的，从别的家族借同一动作
    const fam = families[0];
    if (!existing.length && wantVerb && CRUD.includes(wantVerb as (typeof CRUD)[number]) && !fam.verbs.includes(wantVerb)) {
      const t = pickTemplates(graph, groups, fnIndex, wantResource, wantVerb).find((x) => x.fam.key !== fam.key);
      const c = t?.chains[0];
      if (t && c) {
        out.verbTemplate = { family: t.fam.family, chain: { verb: c.verb, chain: c.chain, planned: planChain(c.chain, t.fam.family, wantResource, exists) } };
      }
    }
    return out;
  }

  // 本仓没有这个资源：借最完整的 CRUD 家族当模板
  if (looksLikeResource(raw, wantVerb) && wantResource.length >= 3) {
    const ts = pickTemplates(graph, groups, fnIndex, wantResource);
    if (ts.length) {
      const t = ts[0];
      const chains = t.chains
        .filter((c) => !wantVerb || !CRUD.includes(wantVerb as (typeof CRUD)[number]) || true)
        .map((c) => ({ verb: c.verb, chain: c.chain, planned: planChain(c.chain, t.fam.family, wantResource, exists) }));
      return {
        ...base,
        matchedBy: 'template',
        families: [],
        exists: [],
        template: { family: t.fam, chains, alternatives: ts.slice(1, 6).map((x) => x.fam.family) },
      };
    }
  }

  return {
    ...base,
    unmatchedReason:
      `本仓没有「${wantFamily || ident}」这个资源的方法家族` +
      (looksLikeResource(raw, wantVerb)
        ? '，也没有四个动作齐全、能当模板的增删改查家族。'
        : '。它看起来不是「动词 + 资源」的接口命名（如工具函数），按命名归族查不到；复用现成工具函数请用 hot。') +
      '这是按命名的骨架检索，不是语义搜索。',
  };
}

const LAYER_LABEL: Record<Layer, string> = {
  router: '路由', service: '接口层', logic: '逻辑层', repo: '存储层', sdk: 'SDK', dto: 'DTO', other: '其他',
};

function chainText(chain: ChainStep[]): string {
  return chain.map((s) => `${LAYER_LABEL[s.layer]} \`${s.file}#${s.name}\``).join(' → ');
}

function planText(planned: PlannedMethod[]): string {
  return planned
    .map((p) =>
      p.reuse
        ? `${LAYER_LABEL[p.layer]} **已有** \`${p.file}#${p.name}\``
        : `${LAYER_LABEL[p.layer]} 新建 \`${p.file}#${p.name}\`（照 ${p.from.name}）`,
    )
    .join(' → ');
}

/** 按分层汇总新建清单：同一层同一文件的方法合成一行 */
function planSummary(chains: VerbChain[]): string[] {
  const byFile = new Map<string, { layer: Layer; names: string[] }>();
  const reuse = new Map<string, Set<string>>();
  for (const c of chains) {
    for (const p of c.planned) {
      if (p.reuse) {
        const s = reuse.get(p.file) ?? new Set<string>();
        s.add(p.name);
        reuse.set(p.file, s);
        continue;
      }
      const e = byFile.get(p.file) ?? { layer: p.layer, names: [] };
      if (!e.names.includes(p.name)) e.names.push(p.name);
      byFile.set(p.file, e);
    }
  }
  const order: Layer[] = ['router', 'service', 'sdk', 'logic', 'repo', 'dto', 'other'];
  const lines = [...byFile.entries()]
    .sort((a, b) => order.indexOf(a[1].layer) - order.indexOf(b[1].layer))
    .map(([file, e]) => `- ${LAYER_LABEL[e.layer]} \`${file}\`：${e.names.join('、')}`);
  for (const [file, names] of reuse) lines.push(`- **已有，直接调用** \`${file}\`：${[...names].join('、')}（不要重写）`);
  return lines;
}

/** 给 AI 与人一起看的文本。与 renderSimilar 同一种语气：先结论，再参考，最后纪律 */
export function renderSimilarMethods(r: SimilarMethodsResult, repoName: string): string {
  if (r.unmatchedReason) return r.unmatchedReason;
  const lines = [`## 同类实现 · 后端方法家族（仓库 ${repoName}）`, '检索方式：按「动词 + 资源名」命名归族的骨架检索，不是语义搜索。', ''];

  if (r.template) {
    const t = r.template;
    lines.push(
      `本仓还没有「${r.wantResource}」这个资源。下面借本仓四个动作齐全的增删改查家族 **${t.family.family}** 当模板 —— 它是**别的资源**，只抄分层写法，不抄业务逻辑。`,
      '',
      `### 模板骨架 · ${t.family.family}（每个动作一条 接口层 → 逻辑层 → 存储层）`,
      ...t.chains.map((c) => `- ${c.verb}：${chainText(c.chain)}`),
      '',
      `### 照模板新建 ${r.wantResource}（名字与文件按模板推导，仅供参考）`,
      ...planSummary(t.chains),
      '',
      '### 逐条对照',
      ...t.chains.map((c) => `- ${c.verb}：${planText(c.planned)}`),
    );
    if (t.alternatives.length) {
      lines.push('', `也可以换一个更接近的家族当模板：${t.alternatives.join('、')}（similar intent=<家族名>）。`);
    }
    lines.push('', '照模板分层写（接口层只做参数校验与转发，逻辑放逻辑层，存储层复用通用方法），不要在 handler 里直接调存储层。');
    return lines.join('\n');
  }

  const want = r.wantVerb ? `${r.wantVerb}${r.wantResource}` : r.wantResource;
  if (r.exists.length) {
    lines.push(`注意：${r.exists.map((m) => `\`${m.file}#${m.name}\``).join('、')} 已经存在 —— 先确认是改它还是真要新增。`, '');
  } else if (r.wantVerb) {
    lines.push(`本仓还没有 ${want}，按下面同族方法的分层写法补。`, '');
  }
  for (const f of r.families) {
    lines.push(`### 家族 ${f.family}（${f.members.length} 个方法，动作：${f.verbs.join(' / ') || '无动词前缀'}）`);
    const byLayer = new Map<Layer, FamilyMember[]>();
    for (const m of f.members) byLayer.set(m.layer, [...(byLayer.get(m.layer) ?? []), m]);
    for (const [layer, ms] of byLayer) {
      lines.push(`- ${LAYER_LABEL[layer]}：${ms.slice(0, 8).map((m) => `\`${m.file}#${m.name}\``).join('、')}${ms.length > 8 ? ` …另 ${ms.length - 8} 个` : ''}`);
    }
    if (f.reference && f.reference.chain.length > 1) lines.push(`- 参考分层骨架：${chainText(f.reference.chain)}`);
    if (f.missingVerbs.length) lines.push(`- 家族缺口：没有 ${f.missingVerbs.join('、')}`);
    lines.push('');
  }
  if (r.verbTemplate) {
    const v = r.verbTemplate;
    lines.push(
      `### ${v.chain.verb} 的写法借 ${v.family}（本族没有 ${v.chain.verb}，同一动作在别的家族里怎么写）`,
      `- 模板：${chainText(v.chain.chain)}`,
      `- 照写：${planText(v.chain.planned)}`,
      '',
    );
  }
  lines.push('照参考骨架分层写（接口层只做参数校验与转发，逻辑放逻辑层），不要平行再造一套。改这些参考文件前仍要 impact。');
  return lines.join('\n');
}
