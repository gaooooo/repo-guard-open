/**
 * 复用检索 —— 回答「我要写 X，仓里有没有现成的」。给 hot 的 intent 分支用。
 *
 * ── 为什么不直接扩 hotSpots ──
 * hotSpots 数的是「被接口 handler 直接调用最多的方法」，固定返回全仓前 N 名：
 *   · 没有 intent：要写「格式化时间」，前 10 名可能跟它毫无关系
 *   · 只数 handler 一跳：工具函数通常被逻辑层调用，永远进不了榜
 * 所以它能回答「哪些别乱改」，回答不了「有没有现成的」。这里另起一套：
 * 先按 intent 找相关方法，再按**所有已解析调用**的扇入排序。
 *
 * ── 怎么匹配中文需求 ──
 * 需求常是中文（「查询租户配置」），方法名是英文。两条路一起走：
 *   ① 方法上方的注释：Go 仓里绝大多数方法有 `// DescribeTenantConfig 查询单个租户配置`，
 *      按中文二元组匹配（identity 实测 707 个方法里 559 个有中文注释）
 *   ② 内置的常用词表把中文词翻成英文词根，再去比方法名里的单词
 * 仍然是**词法检索**，不是语义搜索 —— 输出里必须说清楚。
 *
 * ── 纯函数 ──
 * 读源码通过 readSource 注入；不传则只按方法名匹配。
 */
import type { CodeGraph, FunctionNode } from '../graph/types.js';
import { enclosingIndex, functionIds } from './health.js';
import { analyzeSymbolImpact } from './symbol-impact.js';
import { layerOf, splitVerb, type Layer } from './similar-methods.js';

/** 中文常用词 → 英文词根。只收研发里高频、歧义小的词；宁缺毋滥 */
const ZH_WORDS: Array<[string, string[]]> = [
  ['查询', ['describe', 'get', 'query', 'find', 'list', 'search']],
  ['获取', ['get', 'describe', 'fetch', 'find']],
  ['列表', ['list', 'describe']],
  ['详情', ['describe', 'get', 'detail']],
  ['创建', ['create', 'add', 'insert', 'new']],
  ['新增', ['create', 'add', 'insert']],
  ['添加', ['add', 'create', 'insert']],
  ['修改', ['modify', 'update', 'set']],
  ['更新', ['update', 'modify', 'refresh']],
  ['删除', ['delete', 'remove']],
  ['校验', ['validate', 'check', 'verify']],
  ['验证', ['verify', 'validate', 'check']],
  ['检查', ['check', 'validate']],
  ['解析', ['parse', 'decode', 'resolve']],
  ['格式化', ['format']],
  ['转换', ['convert', 'to', 'transform']],
  ['生成', ['gen', 'generate', 'build', 'new', 'make']],
  ['加密', ['encrypt']],
  ['解密', ['decrypt']],
  ['签名', ['sign', 'signature']],
  ['分页', ['page', 'paginate', 'pagination']],
  ['排序', ['sort']],
  ['过滤', ['filter']],
  ['转义', ['escape']],
  ['正则', ['regex', 'regexp']],
  ['时间', ['time', 'date']],
  ['日期', ['date', 'time']],
  ['字符串', ['string', 'str']],
  ['配置', ['config', 'conf', 'setting']],
  ['租户', ['tenant']],
  ['用户组', ['usergroup', 'group']],
  ['用户', ['user']],
  ['令牌', ['token']],
  ['凭证', ['credential']],
  ['凭据', ['credential']],
  ['密钥', ['key', 'secret']],
  ['权限', ['permission', 'auth', 'policy']],
  ['鉴权', ['auth']],
  ['认证', ['auth', 'authenticate']],
  ['策略', ['policy']],
  ['资源', ['resource']],
  ['智能体', ['agent']],
  ['代理', ['agent', 'proxy']],
  ['会话', ['session']],
  ['缓存', ['cache']],
  ['日志', ['log']],
  ['审计', ['audit']],
  ['错误', ['error', 'err']],
  ['请求', ['request', 'req']],
  ['响应', ['response', 'resp']],
  ['发送', ['send']],
  ['上传', ['upload']],
  ['下载', ['download']],
  ['分类', ['category']],
  ['统计', ['count', 'stat', 'statistic']],
  ['数量', ['count']],
  ['计数', ['count']],
  ['用量', ['usage']],
  ['技能', ['skill']],
  ['服务', ['service']],
  ['实例', ['instance']],
  ['应用', ['app', 'application']],
  ['连接器', ['connector']],
  ['证书', ['certificate', 'cert']],
  ['数据源', ['datasource']],
  ['回调', ['callback']],
  ['通知', ['notify', 'notification']],
  ['链接', ['link', 'url']],
  ['地址', ['url', 'addr', 'address']],
];

/**
 * 动作词：只说明「做什么」，不说明「对什么做」。只命中动作词的方法不算候选 ——
 * 「校验 token」只命中 validate 的会是 validateInstance，跟 token 毫无关系。
 */
const ACTIONS = new Set([
  'describe', 'get', 'query', 'find', 'list', 'search', 'fetch', 'detail',
  'create', 'add', 'insert', 'new', 'modify', 'update', 'set', 'refresh', 'delete', 'remove',
  'validate', 'check', 'verify', 'parse', 'decode', 'resolve', 'format', 'convert', 'to', 'transform',
  'gen', 'generate', 'build', 'make', 'encrypt', 'decrypt', 'sign', 'send', 'upload', 'download',
  'escape', 'sort', 'filter', 'count', 'stat', 'statistic', 'notify', 'authenticate',
]);

export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.$]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/** 一个需求词及其同义英文。同一组命中一次只算一次（配置 → config / conf 不重复加分） */
interface TermGroup {
  label: string;
  kind: 'object' | 'action';
  alts: string[];
}

interface QueryTerms {
  groups: TermGroup[];
  bigrams: string[];
}

function queryTerms(intent: string): QueryTerms {
  const groups: TermGroup[] = [];
  const seen = new Set<string>();
  const push = (label: string, alts: string[]) => {
    const key = alts.join('|');
    if (seen.has(key)) return;
    seen.add(key);
    groups.push({ label, kind: alts.every((a) => ACTIONS.has(a)) ? 'action' : 'object', alts });
  };
  for (const id of intent.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? []) {
    for (const t of nameTokens(id)) if (t.length >= 2) push(t, [t]);
  }
  // 长词先匹配并从句子里挖掉，避免「用户组」同时命中「用户」
  let rest = intent;
  for (const [zh, en] of [...ZH_WORDS].sort((a, b) => b[0].length - a[0].length)) {
    if (!rest.includes(zh)) continue;
    rest = rest.split(zh).join(' ');
    push(zh, en);
  }
  const zh = (intent.match(/[\u4e00-\u9fff]+/g) ?? []).join('|');
  const bigrams: string[] = [];
  for (const seg of zh.split('|')) for (let i = 0; i + 1 < seg.length; i++) bigrams.push(seg.slice(i, i + 2));
  return { groups, bigrams: [...new Set(bigrams)] };
}

/** 单词对得上：相等、单复数，或较长的词根前缀（config ↔ configs；不让 time 吃掉 timeout） */
function tokenHit(tokens: string[], alt: string): boolean {
  return tokens.some(
    (t) => t === alt || t === `${alt}s` || alt === `${t}s` || (alt.length >= 6 && t.startsWith(alt)) || (t.length >= 6 && alt.startsWith(t)),
  );
}

/** 方法上方紧挨着的注释（最多 4 行）。Go / TS / Java 的 // 与 /** *\/ 都认 */
function docOf(lines: string[] | null, fn: FunctionNode): string {
  if (!lines) return '';
  const out: string[] = [];
  for (let i = fn.line - 2; i >= 0 && out.length < 4; i--) {
    const t = lines[i].trim();
    if (/^(\/\/|\*|\/\*\*|#)/.test(t) && !/^#!/.test(t)) {
      out.unshift(t.replace(/^(\/\/+|\/\*\*|\*\/|\*|#)\s?/, '').replace(/\*\/$/, '').trim());
      continue;
    }
    if (/^@/.test(t)) continue; // Java / TS 注解
    break;
  }
  return out.filter(Boolean).join(' ');
}

export interface ReuseCandidate {
  id: string;
  fn: FunctionNode;
  layer: Layer;
  doc: string;
  score: number;
  /** 需求里的对象词全部命中（且有动作词时动作也对上）：可以直接考虑复用 */
  full: boolean;
  /** 命中了哪些词（给人看凭什么） */
  matched: string[];
  /** 被多少个不同的方法调用（所有已解析调用，不只 handler） */
  fanIn: number;
  callers: FunctionNode[];
}

export interface ReuseResult {
  intent: string;
  candidates: ReuseCandidate[];
  /** 查询里没有能用来匹配的词 */
  empty: boolean;
}

export function findReuse(
  graph: CodeGraph,
  intent: string,
  opts: { limit?: number; readSource?: (file: string) => string | null } = {},
): ReuseResult {
  const q = queryTerms(intent);
  if (!q.groups.length && !q.bigrams.length) return { intent, candidates: [], empty: true };
  const objects = q.groups.filter((g) => g.kind === 'object');
  const actions = q.groups.filter((g) => g.kind === 'action');

  const ids = functionIds(graph);
  const enclosing = enclosingIndex(graph);
  const callersOf = new Map<string, Set<FunctionNode>>();
  for (const c of graph.calls) {
    if (!c.toFile) continue;
    const from = enclosing(c.fromFile, c.line);
    if (!from) continue;
    const k = `${c.toFile}#${c.toMethod}`;
    const set = callersOf.get(k) ?? new Set<FunctionNode>();
    set.add(from);
    callersOf.set(k, set);
  }

  const src = new Map<string, string[] | null>();
  const lines = (f: string) => {
    if (!src.has(f)) {
      const s = opts.readSource?.(f) ?? null;
      src.set(f, s === null ? null : s.split('\n'));
    }
    return src.get(f)!;
  };

  const out: ReuseCandidate[] = [];
  for (const fn of graph.functions) {
    if (fn.file.endsWith('_test.go') || /(^|\/)(test|tests|__tests__)\//.test(fn.file)) continue;
    const toks = nameTokens(fn.name);
    // 对象常写在接收器或文件名上而不在方法名里：agent.go 里 AgentLogicImpl.Count 就是「统计智能体」。
    // 只在方法名里**没有任何对象词**时才借（Count / Find / Insert）：DescribeTenant 自己说了对象是租户，
    // 不能因为它住在 tenant_config.go 就被当成「查询租户配置」
    const nameHasObject = toks.some((t) => !ACTIONS.has(t) && t.length >= 3);
    const ctxToks = nameHasObject
      ? []
      : [...nameTokens(fn.owner ?? ''), ...nameTokens((fn.file.split('/').pop() ?? '').replace(/\.[^.]+$/, ''))];
    const objInName = objects.filter((g) => g.alts.some((x) => tokenHit(toks, x)));
    const objHit = objects.filter((g) => g.alts.some((x) => tokenHit(toks, x) || tokenHit(ctxToks, x)));
    const actHit = actions.filter((g) => g.alts.some((x) => tokenHit(toks, x)));
    let doc = '';
    let docHits = 0;
    if (q.bigrams.length && opts.readSource) {
      doc = docOf(lines(fn.file), fn);
      for (const b of q.bigrams) if (doc.includes(b)) docHits++;
    }
    const docRatio = q.bigrams.length ? docHits / q.bigrams.length : 0;
    // 有对象词：至少命中一个对象，或注释几乎把需求说全了；只有动作词：动作对上且注释也对上
    const relevant = objects.length
      ? objHit.length > 0 || docRatio >= 0.6
      : (actHit.length > 0 && docRatio >= 0.5) || docRatio >= 0.75;
    if (!relevant) continue;
    const score = objInName.length * 3 + (objHit.length - objInName.length) * 1.5 + actHit.length * 1.5 + docRatio * 4;
    // 动作只认方法名：注释里的「不校验签名」也含「校验」，不能凭它判定动作对上
    const docStrong = q.bigrams.length >= 3 && docRatio >= 0.8;
    const full = objects.length > 0 && objHit.length === objects.length && (!actions.length || actHit.length > 0 || docStrong);
    const matched = [
      ...objHit.map((g) => (objInName.includes(g) ? g.label : `${g.label}（所在类型/文件）`)),
      ...actHit.map((g) => `${g.label}（动作）`),
      ...(docHits ? [`注释 ${docHits}/${q.bigrams.length}`] : []),
    ];
    const callers = [...(callersOf.get(`${fn.file}#${fn.name}`) ?? [])];
    out.push({ id: ids.get(fn)!, fn, layer: layerOf(fn.file), doc: doc || (opts.readSource ? docOf(lines(fn.file), fn) : ''), score, full, matched, fanIn: callers.length, callers });
  }

  // 相关度分档后按扇入排：同样相关时，被用得越多越该复用
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20);
  const byRelevance = (a: ReuseCandidate, b: ReuseCandidate) => Number(b.full) - Number(a.full) || Math.round(b.score) - Math.round(a.score);
  out.sort((a, b) => byRelevance(a, b) || b.fanIn - a.fanIn || a.fn.file.localeCompare(b.fn.file));
  // 前几名补上同包裸调用（Go 分析器不产出这类边）：只按已解析边数，VerifyToken 这类
  // 包级函数会显示「被 0 个方法调用」，被读成没人用。与 impact 同一套补边
  const top = out.slice(0, limit * 2);
  if (opts.readSource) {
    for (const c of top) {
      const si = analyzeSymbolImpact(graph, c.fn.file, c.fn.name, opts.readSource, 1);
      const direct = (si?.reached ?? []).filter((x) => x.depth === 1).map((x) => x.fn);
      if (direct.length > c.callers.length) {
        c.callers = [...new Set([...c.callers, ...direct])];
        c.fanIn = c.callers.length;
      }
    }
    top.sort((a, b) => byRelevance(a, b) || b.fanIn - a.fanIn || a.fn.file.localeCompare(b.fn.file));
  }
  return { intent, candidates: top.slice(0, limit), empty: false };
}

const LAYER_LABEL: Record<Layer, string> = {
  router: '路由', service: '接口层', logic: '逻辑层', repo: '存储层', sdk: 'SDK', dto: 'DTO', other: '其他',
};

export function renderReuse(r: ReuseResult, fallback: string[]): string {
  if (r.empty) {
    return `「${r.intent}」里没有能用来匹配的词。写方法名里的英文单词（如 TenantConfig），或中文动作 + 对象（如「查询租户配置」）。`;
  }
  const lines = [
    `## 复用候选 · 「${r.intent}」`,
    '检索方式：方法名单词 + 方法上方注释的词法匹配，按相关度分档、同档按被调用次数排序。不是语义搜索。',
    '',
  ];
  if (!r.candidates.length) {
    lines.push('没有名字或注释相近的现成方法 —— 可以新写。写之前先确认这类东西该放哪一层（用 similar 看分层骨架）。');
    if (fallback.length) lines.push('', '全仓高扇入热点（与本需求无关，仅供参考）：', ...fallback);
    return lines.join('\n');
  }
  const item = (c: ReuseCandidate) => {
    const who = c.callers.slice(0, 3).map((x) => x.name).join('、');
    lines.push(`- \`${c.fn.file}#${c.fn.name}\`　${LAYER_LABEL[c.layer]} · 被 ${c.fanIn} 个方法调用${who ? `（${who}${c.fanIn > 3 ? ' 等' : ''}）` : ''}`);
    if (c.doc) lines.push(`    ${c.doc.slice(0, 80)}`);
    lines.push(`    命中：${c.matched.join('、')}`);
  };
  const full = r.candidates.filter((c) => c.full);
  const part = r.candidates.filter((c) => !c.full);
  if (full.length) {
    lines.push('### 可以直接考虑复用（需求里的对象词都对上了）');
    full.forEach(item);
  } else {
    lines.push('没有完全对上的现成方法。下面只是部分命中，**多半不是你要的**，逐个看注释再决定；都不合适就新写。');
  }
  if (part.length) {
    lines.push('', full.length ? '### 部分命中（仅供参考）' : '### 部分命中');
    part.forEach(item);
  }
  lines.push(
    '',
    '命中且已被多处调用的，直接复用，不要再写一个同功能的方法。签名不合适要改时先 impact；被 5 个以上方法调用的只加可选参数。',
  );
  return lines.join('\n');
}
