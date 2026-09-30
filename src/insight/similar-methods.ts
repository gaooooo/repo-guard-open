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
import { ACTIONS, ZH_WORDS } from './zh-words.js';

/** 动词前缀。顺序有意义：长的在前，避免 `Get` 抢走 `GetOrCreate` 这类 */
export const VERBS = [
  'Describe', 'Create', 'Modify', 'Delete', 'Update', 'Remove', 'Get', 'List', 'Query',
  'Enable', 'Disable', 'Bind', 'Unbind', 'Search', 'Handle', 'Check', 'Sync', 'Refresh',
  'Download', 'Upload', 'Open', 'Register', 'Validate', 'Report', 'Add', 'Set', 'Batch',
] as const;

/** 一个完整资源通常具备的动作。只在家族已有 ≥2 个动作时才报缺口，否则是噪音 */
const CRUD = ['Describe', 'Create', 'Modify', 'Delete'] as const;

export type Layer = 'router' | 'service' | 'logic' | 'repo' | 'ext' | 'sdk' | 'dto' | 'other';

/**
 * 外部服务封装目录：tencent_ciam / clients / rpc …… 这一层在调用链上与存储层同级（都是「终点」），
 * 但含义完全不同 —— 数据不在本仓。识别不出来时它落进 other，接口层 → CIAM 的骨架就画不出来，
 * 「改现有的还是另起一套」也就说不清两者差在哪。
 */
const EXT_DIR = /\/(tencent_[a-z0-9]+|clients?|third_?party|external|remote|rpc|grpc)\//;

export function layerOf(file: string): Layer {
  const f = `/${file}`;
  if (/\/(router|routes?)\//.test(f)) return 'router';
  if (/\/(service|controller|controllers|handler|handlers|api)\//.test(f)) return 'service';
  if (/\/(logic|biz|usecase|domain)\//.test(f)) return 'logic';
  if (/\/(repo|dao|store|repository|model|models)\//.test(f)) return 'repo';
  if (EXT_DIR.test(f)) return 'ext';
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

/** 一个可当参考的家族。给 AI 按语义挑：插件保证结构能照抄，像不像需求由 AI 判断 */
export interface TemplateCard {
  family: string;
  /** 业务说明：取接口层方法的中文注释，去掉方法名 */
  doc: string;
  /** 调用链终点：本仓存储层 / 外部服务 / 两者都有 */
  downstream: 'repo' | 'ext' | 'mixed';
  /** 接口层文件 */
  entryFiles: string[];
  entryCount: number;
  verbs: string[];
  /** 需求里与业务说明重合的中文词（给「为什么排前面」一个可见的依据） */
  overlap: string[];
  score: number;
}

export interface TemplateRef {
  family: MethodFamily;
  /** 按动作分行的分层骨架（每个动作一条 接口层 → 逻辑层 → 存储层） */
  chains: VerbChain[];
  /** 其他也完整的家族，可换着当模板 */
  alternatives: string[];
  /** 候选卡片，第一张就是当前展开的模板 */
  cards: TemplateCard[];
  /** 模板怎么来的：auto = 按完整度与相近度排第一；param = 调用方用 template 指定 */
  chosenBy: 'auto' | 'param';
}

export type CrudVerb = (typeof CRUD)[number];

/** 一个 CRUD 动作在本仓对应的资源里有没有 */
export interface VerbVerdict {
  verb: CrudVerb;
  /** 接口层已有的同动作方法（Describe 可能有列表与详情两个） */
  have: FamilyMember[];
}

export interface SimilarQuery {
  /** 原始需求。可以是方法名、资源名，也可以是一句中文 */
  intent?: string;
  /** 英文资源名，由调用方（AI）从需求里拆出来。可给多个候选：User、AIMUser */
  resource?: string | string[];
  /** 要做的动作：Create / Modify / Delete / Describe（Add、Update、Remove、Get… 会归一） */
  verbs?: string[];
  /** 指定参考家族（从上次返回的候选卡片里选的），如 AIMCredentials */
  template?: string;
  limit?: number;
  /** 可选：读源码。中文兜底时用接口层方法的注释做佐证 */
  readSource?: (file: string) => string | null;
}

export interface SimilarMethodsResult {
  query: string;
  /** 查询里带的动词（如 Delete），用于判断「你要写的是不是已存在」 */
  wantVerb: string;
  /** 资源名（单数）。命中已有家族后换成本仓的真名：查 User 命中 AIMUser 就是 AIMUser */
  wantResource: string;
  /** 资源名从哪来：param = 调用方给的 resource；ident = 从 intent 里的英文标识符；zh = 中文词表推断 */
  resourceSource: 'param' | 'ident' | 'zh' | null;
  /** 参与检索的资源名候选 */
  resourceCandidates: string[];
  /** 中文推断的依据，如「用户 → User」 */
  zhHint?: string;
  /** 要核对的动作（归一后） */
  wantVerbs: CrudVerb[];
  matchedBy: 'family' | 'suffix' | 'substring' | 'template' | null;
  families: MethodFamily[];
  /** 查询本身就是一个已存在的方法 */
  exists: FamilyMember[];
  /** 首个家族按动作逐项核对 */
  verdicts: VerbVerdict[];
  /** 中文兜底时的佐证：接口层方法注释里出现中文资源词的比例 */
  evidence?: { word: string; hit: number; total: number; zhDocs: number };
  /** 本仓没有这个资源：借最完整的 CRUD 家族当模板 */
  template?: TemplateRef;
  /** 资源已存在且动作齐全时，「确实要另起一套」的参考候选（不含它自己） */
  altCards?: TemplateCard[];
  /** 调用方指定的 template 没找到 */
  templateMiss?: string;
  /** 资源存在但缺动作：从别的家族借同一动作的骨架（每个缺的动作一条） */
  verbTemplates: Array<{ family: string; chain: VerbChain }>;
  /** verbTemplates[0]，兼容旧调用方 */
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
  // 外部服务与存储层同级：都是调用链的终点
  const rankOf = (l: Layer) => (l === 'ext' ? order.indexOf('repo') : order.indexOf(l));
  const out: ChainStep[] = [{ file: start.file, name: start.name, layer: layerOf(start.file) }];
  const syn = VERB_SYNONYMS[splitVerb(start.name).verb] ?? [];
  const sameVerb = (name: string) => syn.some((v) => name.startsWith(v));
  let cur = start;
  const seen = new Set([`${start.file}#${start.name}`]);
  for (let depth = 0; depth < 3; depth++) {
    const curRank = rankOf(layerOf(cur.file));
    let next: FunctionNode | undefined;
    let first: FunctionNode | undefined;
    for (const c of graph.calls) {
      if (c.fromFile !== cur.file || !c.toFile || c.line < cur.line || c.line > cur.endLine) continue;
      const rank = rankOf(layerOf(c.toFile));
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

/** 从一个已有方法出发的分层调用链。给写后比对用：新写的方法照参考骨架走了没有 */
export function chainOf(graph: CodeGraph, file: string, name: string): ChainStep[] {
  const fnIndex = new Map<string, FunctionNode[]>();
  for (const f of graph.functions) {
    const k = `${f.file}#${f.name}`;
    const list = fnIndex.get(k);
    if (list) list.push(f);
    else fnIndex.set(k, [f]);
  }
  const start = (fnIndex.get(`${file}#${name}`) ?? [])[0];
  return start ? chainFrom(graph, start, fnIndex) : [];
}

/**
 * 两个资源键算不算同一个资源：相同，或带了前缀（aimasset 与 asset）。
 * 真机实测：AI 查的是 Asset，写出来叫 CreateAIMAsset（照本仓 AIM 前缀的命名）——
 * 只认完全相同，新建门会误拦、写后比对会一个都对不上。
 */
export function sameResource(key: string, known: string[]): boolean {
  return known.some((k) => key === k || (k.length >= 3 && key.endsWith(k)) || (key.length >= 3 && k.endsWith(key)));
}

export function isEntryLayer(l: Layer): boolean {
  return ENTRY_LAYERS.includes(l);
}

/**
 * 一段 Go 源码里定义了哪些「CRUD 动词 + 资源」的方法。新建门按资源判定时用：
 * 写的是 CreateAsset，本轮 similar 查的却只有 User —— 那 Asset 的参考还没拿。
 * 只认 Go 的 func 声明；前端走页面指纹，不按资源判。
 */
export function crudFamiliesInSource(src: string): Array<{ name: string; key: string; verb: CrudVerb }> {
  const out: Array<{ name: string; key: string; verb: CrudVerb }> = [];
  const re = /^func\s+(?:\([^)]*\)\s*)?([A-Z][A-Za-z0-9_]*)\s*[[(]/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const { verb, family } = splitVerb(m[1]);
    const v = canonVerb(verb);
    if (v && family.length >= 3) out.push({ name: m[1], key: familyKey(family), verb: v });
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
    // 每条动作链的结构分：走到本仓存储层 1 分、走到外部服务 0.6 分，中间经过逻辑层再 +0.3。
    // 新资源的数据通常落在本仓，「接口层 → 逻辑层 → 存储层」才是该照抄的；
    // 直接调外部服务（接口层 → CIAM）的家族只在没有更好的时候当参考
    const chainScore = (c: { chain: ChainStep[] }) => {
      const end = c.chain.some((x) => x.layer === 'repo') ? 1 : c.chain.some((x) => x.layer === 'ext') ? 0.6 : 0;
      return end ? end + (c.chain.some((x) => x.layer === 'logic') ? 0.3 : 0) : 0;
    };
    const deep = chains.reduce((n, c) => n + chainScore(c), 0);
    if (!deep) continue;
    const prefixBonus = wantPrefix && singular(g.family).startsWith(wantPrefix) ? 0.5 : 0;
    out.push({ fam, chains, score: deep + prefixBonus + Math.min(fam.members.length, 20) / 100 });
  }
  return out.sort((a, b) => b.score - a.score || a.fam.key.localeCompare(b.fam.key));
}

/** 需求里不算业务词的中文二元组：动作、泛称、虚词 */
const GENERIC_BIGRAMS = new Set([
  '开发', '实现', '包括', '新增', '修改', '删除', '查询', '管理', '服务', '接口', '功能', '模块', '支持', '一个', '一套',
  '增删', '删改', '改查', '列表', '详情', '创建', '更新', '编辑', '添加', '需要', '提供', '相关', '能力',
]);

function bigramsOf(text: string): string[] {
  const out = new Set<string>();
  for (const seg of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 1 < seg.length; i++) {
      const b = seg.slice(i, i + 2);
      if (!GENERIC_BIGRAMS.has(b)) out.add(b);
    }
  }
  return [...out];
}

const DOC_GENERIC = /查询|获取|列表|详情|创建|新增|新建|修改|更新|编辑|删除|批量|单个|信息|接口|数据|启用|停用|禁用|同步/g;

/** 接口层方法注释的业务部分：`// CreateAIMCredential 创建凭据` → 创建凭据 */
function cardDoc(members: FamilyMember[], read?: (file: string) => string | null): string {
  if (!read) return '';
  const cache = new Map<string, string | null>();
  const docs: Array<{ d: string; describe: boolean }> = [];
  for (const m of members.filter((x) => ENTRY_LAYERS.includes(x.layer))) {
    if (!cache.has(m.file)) cache.set(m.file, read(m.file));
    const d = docAbove(cache.get(m.file) ?? null, m.line)
      .replace(/\/\/\s*/g, '')
      .replace(new RegExp(`^${m.name}\\s*`), '')
      .trim();
    // 只有动作没有对象的（「创建」「查询列表」）说明不了业务是什么：去掉动作与泛称后还得剩下东西
    const core = d.replace(DOC_GENERIC, '').replace(/[\s,，。.:：()（）]/g, '');
    if ((core.match(/[\u4e00-\u9fff]/g) ?? []).length >= 2 || /[A-Za-z]{3,}/.test(core)) {
      docs.push({ d, describe: canonVerb(m.verb) === 'Describe' });
    }
  }
  // 查询类的注释最像资源本身的叫法（「凭据列表」「查询 mcp server 详情」）；同类里取最短
  docs.sort((a, b) => Number(b.describe) - Number(a.describe) || a.d.length - b.d.length);
  return docs[0]?.d.slice(0, 40) ?? '';
}

function toCard(
  t: { fam: MethodFamily; chains: Array<{ verb: string; chain: ChainStep[] }>; score: number },
  want: string[],
  read?: (file: string) => string | null,
): TemplateCard {
  const ends = new Set(t.chains.map((c) => c.chain[c.chain.length - 1]?.layer).filter((l) => l === 'repo' || l === 'ext'));
  const entry = t.fam.members.filter((m) => ENTRY_LAYERS.includes(m.layer));
  const doc = cardDoc(t.fam.members, read);
  const overlap = want.filter((b) => doc.includes(b));
  return {
    family: t.fam.family,
    doc,
    downstream: ends.size > 1 ? 'mixed' : ends.has('ext') ? 'ext' : 'repo',
    entryFiles: [...new Set(entry.map((m) => m.file))],
    entryCount: entry.length,
    verbs: t.fam.verbs,
    overlap,
    // 结构分（完整度）打底，需求与注释的重合词加分：「资产」需求里提到「实例」时，
    // 注释写着「实例」的家族应排到前面
    score: t.score + overlap.length * 0.8,
  };
}

/** 查询像不像「要新建一个资源 / 接口」。不像（如 EscapeRegex）就不给 CRUD 模板，免得误导 */
function looksLikeResource(raw: string, wantVerb: string, verbs: CrudVerb[]): boolean {
  return Boolean(wantVerb) || verbs.length > 0 || /crud|增删改查|接口|资源|服务|管理/i.test(raw);
}

/** 各种动词写法归一到 CRUD 四个动作 */
const VERB_CANON: Record<string, CrudVerb> = {
  describe: 'Describe', get: 'Describe', list: 'Describe', query: 'Describe', search: 'Describe', find: 'Describe', detail: 'Describe',
  create: 'Create', add: 'Create', insert: 'Create', new: 'Create',
  modify: 'Modify', update: 'Modify', set: 'Modify', edit: 'Modify',
  delete: 'Delete', remove: 'Delete',
};
export function canonVerb(v: string): CrudVerb | null {
  return VERB_CANON[v.toLowerCase()] ?? null;
}

/** 中文动作词。「增删改查」这类缩写一次给多个 */
const ZH_VERBS: Array<[string, CrudVerb[]]> = [
  ['增删改查', ['Describe', 'Create', 'Modify', 'Delete']],
  ['增删改', ['Create', 'Modify', 'Delete']],
  ['新增', ['Create']], ['新建', ['Create']], ['创建', ['Create']], ['添加', ['Create']],
  ['修改', ['Modify']], ['更新', ['Modify']], ['编辑', ['Modify']],
  ['删除', ['Delete']], ['移除', ['Delete']],
  ['查询', ['Describe']], ['列表', ['Describe']], ['详情', ['Describe']], ['查看', ['Describe']],
];

/** 太泛、不能当资源名的中文词（「用户管理服务」里只有「用户」是资源） */
const ZH_GENERIC = new Set(['服务', '资源', '接口', '应用']);

const PASCAL_FIX: Record<string, string> = { usergroup: 'UserGroup', datasource: 'DataSource' };
function pascal(w: string): string {
  return PASCAL_FIX[w] ?? w.charAt(0).toUpperCase() + w.slice(1);
}

interface ZhGuess {
  names: string[];
  hint: string;
  words: string[];
}

/** 中文需求 → 资源名候选。只用对象词；多个对象词按出现顺序拼成复合名放最前（租户配置 → TenantConfig） */
function zhResources(raw: string): ZhGuess | null {
  const hits: Array<{ at: number; zh: string; en: string }> = [];
  let rest = raw;
  for (const [zh, en] of [...ZH_WORDS].sort((a, b) => b[0].length - a[0].length)) {
    if (ZH_GENERIC.has(zh) || en.every((x) => ACTIONS.has(x))) continue;
    const at = rest.indexOf(zh);
    if (at < 0) continue;
    rest = rest.split(zh).join('\u0000'.repeat(zh.length));
    hits.push({ at, zh, en: en[0] });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.at - b.at);
  const parts = hits.map((h) => pascal(h.en));
  const names = [...new Set([...(parts.length > 1 ? [parts.join('')] : []), ...parts])];
  return { names, hint: hits.map((h) => `${h.zh} → ${pascal(h.en)}`).join('，'), words: hits.map((h) => h.zh) };
}

function zhVerbs(raw: string): CrudVerb[] {
  const out = new Set<CrudVerb>();
  let rest = raw;
  for (const [zh, vs] of ZH_VERBS) {
    if (!rest.includes(zh)) continue;
    rest = rest.split(zh).join(' ');
    for (const v of vs) out.add(v);
  }
  return CRUD.filter((v) => out.has(v));
}

/** 家族名以资源名结尾且在单词边界上：AIMUser / LocalUser 算 User 的变体，Superuser 不算 */
function isSuffixVariant(family: string, want: string): boolean {
  const f = singular(family);
  if (f.length <= want.length || !f.toLowerCase().endsWith(want)) return false;
  return /[A-Z]/.test(f[f.length - want.length]);
}

/** 接口层有哪些 CRUD 动作。判断「这是不是一个完整的对外资源」 */
function entryCrud(fns: FunctionNode[]): Set<CrudVerb> {
  const out = new Set<CrudVerb>();
  for (const f of fns) {
    if (!ENTRY_LAYERS.includes(layerOf(f.file))) continue;
    const v = canonVerb(splitVerb(f.name).verb);
    if (v) out.add(v);
  }
  return out;
}

function docAbove(src: string | null, line: number): string {
  if (!src) return '';
  const ls = src.split('\n');
  const out: string[] = [];
  for (let i = line - 2; i >= 0 && i >= line - 6; i--) {
    const t = ls[i]?.trim() ?? '';
    if (!t.startsWith('//')) break;
    out.push(t);
  }
  return out.join(' ');
}

export function similarMethods(graph: CodeGraph, query: SimilarQuery): SimilarMethodsResult {
  const raw = (query.intent ?? '').trim();
  const params = (Array.isArray(query.resource) ? query.resource : [query.resource ?? ''])
    .flatMap((x) => x.split(/[\s,，、;；]+/))
    .map((x) => x.trim())
    .filter((x) => /^[A-Za-z][A-Za-z0-9_]*$/.test(x));
  // 允许「新增 DeleteAIMCredential 接口」这种句子：取最长的一个标识符
  const ident = (raw.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).sort((a, b) => b.length - a.length)[0] ?? '';

  // ── 资源名候选：调用方给的 > intent 里的英文标识符 > 中文词表 ──
  let source: SimilarMethodsResult['resourceSource'] = null;
  let candidates: string[] = [];
  let wantVerb = '';
  let zh: ZhGuess | null = null;
  if (params.length) {
    source = 'param';
    for (const p of params) {
      const sv = splitVerb(p);
      if (sv.verb && !wantVerb) wantVerb = sv.verb;
      candidates.push(singular(sv.family));
    }
  } else if (ident.length >= 3) {
    source = 'ident';
    const sv = splitVerb(ident);
    wantVerb = sv.verb;
    candidates = [singular(sv.family)];
  } else if ((zh = zhResources(raw))) {
    source = 'zh';
    candidates = zh.names;
  }
  candidates = [...new Set(candidates.filter((c) => c.length >= 2))];
  const verbsIn = [
    ...(query.verbs ?? []).map(canonVerb),
    wantVerb ? canonVerb(wantVerb) : null,
    ...zhVerbs(raw),
  ].filter((v): v is CrudVerb => Boolean(v));
  const wantVerbs = CRUD.filter((v) => verbsIn.includes(v));
  // 调用方明说的动作（verbs 参数 / 中文里的「新增、删除」）。只从方法名带出来的 Create 不算：
  // 查 CreateAIMWorkload 时新资源仍给完整的四个动作模板
  const explicitVerbs = CRUD.filter((v) => [...(query.verbs ?? []).map(canonVerb), ...zhVerbs(raw)].includes(v));

  const base: SimilarMethodsResult = {
    query: raw || params.join(','),
    wantVerb,
    wantResource: candidates[0] ?? '',
    resourceSource: source,
    resourceCandidates: candidates,
    zhHint: zh?.hint,
    wantVerbs,
    matchedBy: null,
    families: [],
    exists: [],
    verdicts: [],
    verbTemplates: [],
  };
  if (!candidates.length) {
    return {
      ...base,
      unmatchedReason:
        '后端同类检索需要一个资源名。请先把需求拆成资源和动作再调：resource 写英文资源名（按本仓命名，如 User、AIMCredential），' +
        'verbs 写 Create / Modify / Delete / Describe。也可以直接给方法名，如 DeleteAIMCredential。',
    };
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

  // ── 匹配家族：同名 + 前缀变体（User → AIMUser），按接口层 CRUD 完整度排 ──
  // 只收同名会出错：identity 里 User 家族是 CLI 的 BindUser / ListUsers，真正的用户管理叫 AIMUser
  const hit = new Map<string, 'family' | 'suffix'>();
  for (const c of candidates) {
    const want = familyKey(c);
    if (groups.has(want) && !hit.has(want)) hit.set(want, 'family');
    for (const [k, g] of groups) {
      if (!hit.has(k) && isSuffixVariant(g.family, c.toLowerCase())) hit.set(k, 'suffix');
    }
  }
  const crudOf = new Map<string, number>();
  const entryCount = (k: string) => groups.get(k)!.fns.filter((f) => ENTRY_LAYERS.includes(layerOf(f.file))).length;
  for (const k of hit.keys()) crudOf.set(k, entryCrud(groups.get(k)!.fns).size);
  let keys = [...hit.keys()].sort(
    (a, b) =>
      crudOf.get(b)! - crudOf.get(a)! ||
      Number(hit.get(a) === 'suffix') - Number(hit.get(b) === 'suffix') ||
      entryCount(b) - entryCount(a) ||
      groups.get(b)!.fns.length - groups.get(a)!.fns.length ||
      a.localeCompare(b),
  );
  let matchedBy: SimilarMethodsResult['matchedBy'] = keys.length ? (hit.get(keys[0]) ?? null) : null;
  if (!keys.length) {
    const want = familyKey(candidates[0]);
    if (want.length >= 4) {
      keys = [...groups.keys()]
        // 只认「家族名包含查询词」。反过来（查询词包含家族名）会让 AIMWorkload 命中 Load
        .filter((k) => k.includes(want))
        .sort((a, b) => (groups.get(b)!.fns.length - groups.get(a)!.fns.length) || a.localeCompare(b));
      if (keys.length) matchedBy = 'substring';
    }
  }
  const limit = Math.min(Math.max(query.limit ?? 3, 1), 5);
  keys = keys.slice(0, limit);

  const families = keys.map((key) => buildFamily(graph, key, groups.get(key)!, fnIndex));
  const existing = ident ? families.flatMap((f) => f.members.filter((m) => m.name === ident)) : [];

  if (families.length) {
    const fam = families[0];
    // 命中后资源名换成本仓真名：后面推导要新建的方法名用它（CreateAIMUser 而不是 CreateUser）
    const resource = singular(fam.family);
    const out: SimilarMethodsResult = { ...base, wantResource: resource, matchedBy, families, exists: existing };
    const entry = fam.members.filter((m) => ENTRY_LAYERS.includes(m.layer));
    out.verdicts = wantVerbs.map((verb) => ({ verb, have: entry.filter((m) => canonVerb(m.verb) === verb) }));
    // 资源在、但缺动作：同族里没有可照抄的，从别的家族借同一动作
    const missing = wantVerbs.length
      ? out.verdicts.filter((v) => !v.have.length).map((v) => v.verb)
      : !existing.length && wantVerb && canonVerb(wantVerb) && !entryCrud(groups.get(fam.key)!.fns).has(canonVerb(wantVerb)!)
        ? [canonVerb(wantVerb)!]
        : [];
    for (const verb of missing) {
      const t = pickTemplates(graph, groups, fnIndex, resource, verb).find((x) => x.fam.key !== fam.key);
      const c = t?.chains[0];
      if (t && c) {
        out.verbTemplates.push({ family: t.fam.family, chain: { verb: c.verb, chain: c.chain, planned: planChain(c.chain, t.fam.family, resource, exists) } });
      }
    }
    out.verbTemplate = out.verbTemplates[0];
    // 动作全都有 —— 最该先问「改现有的还是另起」。另起时不能让 AI 两手空空：
    // 顺带给出别的完整家族当参考（不含它自己），用户选另起后不必再查一次
    if (out.verdicts.length && !missing.length) {
      const want = bigramsOf(raw);
      out.altCards = pickTemplates(graph, groups, fnIndex, resource)
        .filter((x) => x.fam.key !== fam.key)
        .map((x) => toCard(x, want, query.readSource))
        .sort((a, b) => b.score - a.score || a.family.localeCompare(b.family))
        .slice(0, 3);
    }
    if (source === 'zh' && zh && query.readSource) {
      const word = zh.words[0];
      const docs = entry.map((m) => docAbove(query.readSource!(m.file), m.line));
      // 分母只算写了中文注释的：`// DescribeCategory ...` 这种占位注释既不能佐证也不能否定
      const zhDocs = docs.filter((d) => /[\u4e00-\u9fff]/.test(d));
      out.evidence = { word, hit: zhDocs.filter((d) => d.includes(word)).length, total: entry.length, zhDocs: zhDocs.length };
    }
    return out;
  }

  // 本仓没有这个资源：借最完整的 CRUD 家族当模板
  const wantResource = pascal(candidates[0]);
  // 调用方显式给了 resource：它已经说了这是一个资源，不再按 intent 猜
  if ((source === 'param' || looksLikeResource(raw, wantVerb, wantVerbs)) && wantResource.length >= 3) {
    const want = bigramsOf(raw);
    const ranked = pickTemplates(graph, groups, fnIndex, wantResource)
      .map((x) => ({ x, card: toCard(x, want, query.readSource) }))
      .sort((a, b) => b.card.score - a.card.score || a.x.fam.key.localeCompare(b.x.fam.key));
    let chosenBy: TemplateRef['chosenBy'] = 'auto';
    let templateMiss: string | undefined;
    if (query.template) {
      const k = familyKey(splitVerb(query.template.trim()).family);
      const i = ranked.findIndex((r) => r.x.fam.key === k);
      if (i >= 0) {
        ranked.unshift(...ranked.splice(i, 1));
        chosenBy = 'param';
      } else {
        templateMiss = query.template;
      }
    }
    const ts = ranked.map((r) => r.x);
    if (ts.length) {
      const t = ts[0];
      const chains = t.chains
        // 调用方说了只做哪几个动作就只列那几个；没说就四个都给
        .filter((c) => !explicitVerbs.length || explicitVerbs.includes(c.verb as CrudVerb))
        .map((c) => ({ verb: c.verb, chain: c.chain, planned: planChain(c.chain, t.fam.family, wantResource, exists) }));
      return {
        ...base,
        wantResource,
        matchedBy: 'template',
        template: { family: t.fam, chains, alternatives: ts.slice(1, 6).map((x) => x.fam.family), cards: ranked.slice(0, 5).map((r) => r.card), chosenBy },
        templateMiss,
      };
    }
  }

  return {
    ...base,
    unmatchedReason:
      `本仓没有「${candidates.join(' / ')}」这个资源的方法家族` +
      (looksLikeResource(raw, wantVerb, wantVerbs)
        ? '，也没有四个动作齐全、能当模板的增删改查家族。'
        : '。它看起来不是「动词 + 资源」的接口命名（如工具函数），按命名归族查不到；复用现成工具函数请用 hot。') +
      '这是按命名的骨架检索，不是语义搜索。',
  };
}

const LAYER_LABEL: Record<Layer, string> = {
  router: '路由', service: '接口层', logic: '逻辑层', repo: '存储层', ext: '外部服务', sdk: 'SDK', dto: 'DTO', other: '其他',
};

const DOWNSTREAM_LABEL: Record<TemplateCard['downstream'], string> = {
  repo: '本仓存储层', ext: '外部服务', mixed: '存储层 + 外部服务',
};

function cardLines(cards: TemplateCard[]): string[] {
  return cards.map((c, i) => {
    const bits = [
      c.doc ? `「${c.doc}」` : '（注释里没有业务说明）',
      `下游：${DOWNSTREAM_LABEL[c.downstream]}`,
      `${c.entryFiles.slice(0, 2).join('、')}`,
      `${c.entryCount} 个接口（${c.verbs.join(' / ')}）`,
    ];
    if (c.overlap.length) bits.push(`与需求重合：${c.overlap.join('、')}`);
    return `${i + 1}. **${c.family}** —— ${bits.join('｜')}`;
  });
}

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
  const lines = [`## 同类实现 · 后端方法家族（仓库 ${repoName}）`, '检索方式：按「动词 + 资源名」命名归族的骨架检索，不是语义搜索。'];
  if (r.resourceSource === 'zh') {
    lines.push(
      `资源名由中文词表推断：${r.zhHint}（准确度低）。更稳的调法：把需求拆成 resource=<英文资源名> + verbs=[Create, Modify, …] 再调。`,
    );
  } else if (r.resourceSource === 'param' && r.resourceCandidates.length > 1) {
    lines.push(`资源名候选：${r.resourceCandidates.join('、')}`);
  }
  if (r.wantVerbs.length) lines.push(`要核对的动作：${r.wantVerbs.join(' / ')}`);
  lines.push('');

  if (r.template) {
    const t = r.template;
    lines.push(`本仓还没有「${r.wantResource}」这个资源，要照一个已有资源的写法新建。`, '');
    if (r.templateMiss) lines.push(`指定的模板「${r.templateMiss}」不在候选里（它的四个动作不齐或调用链没走到存储层），下面按默认排序。`, '');
    lines.push(
      '### 参考候选（先看结构完整度，再看与需求的相近度）',
      ...cardLines(t.cards),
      '',
      t.chosenBy === 'param'
        ? `按指定展开第 1 个 **${t.family.family}**。`
        : `默认展开第 1 个 **${t.family.family}**。**先判断哪个候选的业务和「${r.query || r.wantResource}」最像**（看业务说明与下游）。` +
          `选的不是第 1 个，**必须**带上它再查一次：similar resource=${r.wantResource} template=<家族名> —— ` +
          '写后比对按你最后一次查询的参考核对，不重查就会拿第 1 个来比。',
      `定下之后在方案第一句写明「参考 <家族> 实现 ${r.wantResource}」和理由。它是**别的资源**：只抄分层写法，不抄业务逻辑。`,
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
    lines.push('', '照模板分层写（接口层只做参数校验与转发，逻辑放逻辑层，存储层复用通用方法），不要在 handler 里直接调存储层。');
    return lines.join('\n');
  }

  const want = r.wantVerb ? `${r.wantVerb}${r.wantResource}` : r.wantResource;
  const top = r.families[0];
  const asked = r.resourceCandidates[0] ?? '';
  if (top && r.matchedBy === 'suffix') {
    lines.push(`查的是「${asked}」，本仓对应的资源叫 **${singular(top.family)}**（名字带前缀）。下面的方法名都按本仓真名写。`, '');
  }
  if (top && r.verdicts.length) {
    const missing = r.verdicts.filter((v) => !v.have.length).map((v) => v.verb);
    lines.push(`### 按动作核对 · ${singular(top.family)}（接口层）`);
    for (const v of r.verdicts) {
      lines.push(v.have.length ? `- ${v.verb}：**已有** ${v.have.map((m) => `\`${m.file}#${m.name}\``).join('、')}` : `- ${v.verb}：**没有**`);
    }
    if (!missing.length) {
      lines.push(
        `结论：要求的 ${r.verdicts.length} 个动作本仓**都已存在** —— 这是已有功能。先确认是改现有实现还是另起；另起要说明为什么不能复用，不要平行再造一套。`,
      );
    } else if (missing.length === r.verdicts.length) {
      lines.push(`结论：资源 ${singular(top.family)} 已有，但要求的动作都没有。按下面「借来的写法」补，接口放进同一个文件、调用同一套逻辑层与存储层。`);
    } else {
      lines.push(`结论：只缺 ${missing.join('、')}。只补缺的，已有的直接改或复用；补的写法见下面「借来的写法」。`);
    }
    const ref = top.reference?.chain ?? [];
    const end = ref[ref.length - 1];
    if (end && (end.layer === 'ext' || end.layer === 'repo') && ref.length > 1) {
      lines.push(`现有实现：${chainText(ref)}（数据在${end.layer === 'ext' ? '外部服务' : '本仓存储层'}）。`);
    }
    if (r.evidence) {
      const e = r.evidence;
      lines.push(
        !e.zhDocs
          ? `佐证：接口层 ${e.total} 个方法都没有中文注释，无法用注释核对「${e.word}」；以方法名为准。`
          : `佐证：接口层 ${e.zhDocs} 个带中文注释的方法里 ${e.hit} 个含「${e.word}」${e.hit ? '' : ' —— 注释对不上，资源名可能推断错了，请用 resource 参数重查'}。`,
      );
    }
    lines.push('');
  }
  if (r.verdicts.length) {
    // 已按动作逐项给过结论，不再重复「还没有 CreateX」
  } else if (r.exists.length) {
    lines.push(`注意：${r.exists.map((m) => `\`${m.file}#${m.name}\``).join('、')} 已经存在 —— 先确认是改它还是真要新增。`, '');
  } else if (r.wantVerb) {
    lines.push(`本仓还没有 ${want}，按下面同族方法的分层写法补。`, '');
  }
  for (const [i, f] of r.families.entries()) {
    if (i > 0 && r.verdicts.length) {
      if (i === 1) lines.push('### 同名的其他资源（接口层增删改查更不完整，多半不是要找的）');
      lines.push(`- ${f.family}：${f.members.length} 个方法，动作 ${f.verbs.join(' / ') || '无'}，在 ${[...new Set(f.members.map((m) => m.file))].slice(0, 2).join('、')}`);
      if (i === r.families.length - 1) lines.push('');
      continue;
    }
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
  if (r.altCards?.length && top) {
    lines.push(
      `### 如果确实要另起一套（不复用 ${singular(top.family)}）`,
      '先和用户确认要另起。确认后从下面选一个当参考，新资源名不要和已有的撞名：',
      ...cardLines(r.altCards),
      `选定后：similar resource=<新资源名> template=<家族名> verbs=[…]，拿到各层要新建的方法与文件清单。`,
      '',
    );
  }
  for (const v of r.verbTemplates) {
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
