/**
 * 会话状态 —— 记住"这一轮 AI 已经查过哪些文件的影响面"。
 *
 * 这是写前守卫能放行的唯一依据：`pre-write` 拦住一次之后，AI 去调了 `impact`，
 * 再回来写同一个文件就该放行。没有这份状态，守卫就是死循环。
 *
 * ── 为什么按文件记而不是按"查过没查过"记 ──
 * 查了 A 文件的影响面，不代表可以随便改 B 文件。按会话记一个布尔值，
 * AI 只要查过任意一次就能改所有公共层文件 —— 守卫等于形同虚设。
 * 这条是 verify-hooks 的 G1/G2 用例（查过 A 放行 A，但仍拦 B）。
 *
 * ── 为什么落磁盘而不是内存 ──
 * hook 和 MCP 是**两个独立进程**：MCP server 是宿主长驻拉起的，每个 hook 是
 * 一次性子进程。「AI 调了 impact」发生在 MCP 进程里，「写文件被拦」发生在 hook
 * 进程里，两者只能通过磁盘通信。
 *
 * ── 为什么放 $HOME 而不是仓库里 ──
 * 见 paths.ts 的说明。另外两个进程的 cwd 可能不同（hook 的仓库根来自 stdin 的
 * cwd 字段，MCP 的来自 process.cwd()），用 $HOME 才是两边都能算出同一个位置的锚点。
 *
 * ── 为什么"按文件记"的状态必须带仓库维度 ──
 * 状态放在仓库外面，key 又是**仓库相对路径**，那么两个仓库都有 `src/index.ts` 时
 * key 就撞了：查过 A 仓那个，写 B 仓那个就被放行。守卫方向性地从"多拦"变成"漏拦"，
 * 而这个方向的失败是不能接受的。所以凡是 key 里含路径或含"本仓知识"的状态，
 * 一律用 `repoId(repoDir):xxx` 做 key。
 *
 * ── 哪些状态**不带**仓库维度，以及为什么 ──
 * `toolCalls` / `consecutiveFail` / `repeatCount` / `evidence` / `stopNotices`
 * 回答的是"这个 agent 在这一轮里的行为"，不是"这个仓怎么了"。agent 连续失败 3 次、
 * 反复调同一个工具，是**会话级现象** —— 按仓拆开会让每个仓各自从 0 数起，
 * L3 循环门直接失效。`countSessionFiles` 同理：范围预算管的是"这次任务涉及面有多宽"，
 * 跨仓改 8 个文件仍然是 8 个文件的涉及面。
 *
 * 所以函数签名本身就是这份划分的文档：**带 repoDir 参数的是仓级状态，不带的是会话级**。
 *
 * ── 为什么用显式参数而不是进程级的"当前仓" ──
 * 用一个 ambient 全局（像下面 sessionId 的 override 那样）确实能少改十几个签名，
 * 但那等于把"一个进程只服务一个仓"钉进状态层 —— 而多仓演进的第一步恰恰是
 * 「仓由这次动的文件决定，不由 cwd 决定」（见 docs/MULTI-REPO.md）。
 * 到那时 ambient 值要在每个文件判定前重设一次，是最容易漏的那种写法。
 */
import fs from 'node:fs';
import path from 'node:path';

import { readJson, repoId, stateRoot } from './paths.js';

/** 一次 similar 查询留下的参考计划 */
export interface SimilarPlan {
  workspace?: string;
  /** repoId —— 计划只对这个仓有效 */
  repo: string;
  /** 资源的家族键（小写单数），如 asset、aimuser */
  key: string;
  /** 资源名（本仓真名），如 Asset、AIMUser */
  resource: string;
  /** 这次查询涉及的所有资源键（候选 + 真名），新建门按它判定「查过没有」 */
  keys: string[];
  /** 参考家族；资源已存在且不缺动作时为它自己 */
  template: string | null;
  /** 参考骨架的分层，如 ["service","logic","repo"] */
  skeleton: string[];
  /** 照模板推导出的方法。reuse = 本仓已有、应直接调用 */
  planned: Array<{ layer: string; file: string; name: string; reuse: boolean }>;
  /** 结论：new = 新资源照模板建；gap = 已有资源补动作；exists = 已存在 */
  kind: 'new' | 'gap' | 'exists';
  ts: number;
}

interface SessionState {
  version: number;
  /** 查过影响面的文件。key = `<repoId>:<仓库相对路径>` → 查询时间戳 */
  queried: Record<string, number>;
  /** 查过组件库目录的意图关键词。key = `<repoId>:<intent>`。给"新建组件前必须先 lib search"用 */
  libSearched: string[];
  /** 查过高扇入热点的仓（repoId 列表）。给「新建组件前必须先 hot」用 */
  hotRepos: string[];
  /** 查过同类页骨架的意图。key = `<repoId>:<intent>`。给「新建页面前必须先 similar」用 */
  similarSearched: string[];
  /**
   * similar 给出的参考计划。给两件事用：
   *   · 新建门按资源判定：写的是 Asset，本轮查的却是 User → 先去查 Asset
   *   · 写后比对：新写的 Asset 是否照参考家族的分层写
   */
  similarPlans: SimilarPlan[];
  /** 本会话改动过的文件。元素 = `<repoId>:<仓库相对路径>`。给 L1 范围门的 maxFiles 预算用 */
  touchedFiles: string[];
  /**
   * L3 循环门的三个计数器。只统计循环门管得着的两类工具：写文件与 Bash。
   *
   *   failStreak    —— 同一个调用（`工具名|入参指纹`）**连续失败**了几次。指纹取路径 + 命令的前 120 字符，
   *                    不含内容：「改一个字再试一次」仍算同一个调用。任何一次成功都清零。
   *                    之前记的是「同一路径累计调用次数」，成功的也算、从不清零 ——
   *                    同一个文件正常改到第 4 次就被拦，29 个真实会话回放里 13 个会被误拦
   *   consecutiveFail —— 连续失败数，任何一次成功都清零。之前只有写文件成功才清零，
   *                    零散的命令失败攒到 3 次就把写入全拦了，而写不进去又清不掉 —— 死锁
   *   fileWriteFail —— `<repoId>:<文件路径>` → 这个文件写失败次数，写成功一次就清零
   */
  failStreak: { key: string; n: number } | null;
  consecutiveFail: number;
  fileWriteFail: Record<string, number>;
  /** 本会话写文件与跑命令的次数（读、搜不经过插件的钩子，数不到）。L3 迭代预算只能靠它近似 */
  toolCalls: number;
  /** 本会话跑过的工程校验证据（lint / test / build 的命令片段）。L5 用 */
  evidence: string[];
  /** 已经注入过的 Stop 提醒原因。防死循环：同一 reason 每会话只注入一次 */
  stopNotices: string[];
  /** v2 任务契约（会话级）。null = 还没声明 */
  contract: TaskContract | null;
  /** 扩范围记录：新增了哪些范围、理由 */
  expansions: ScopeExpansion[];
  /** guard_note：AI 发现的范围外问题，不改，回执里列给人 */
  notes: GuardNote[];
  /** 本会话经写工具改过的文件：`<repoId>:<rel>` → 最后一次写入时间 */
  writes: Record<string, number>;
  /** 本会话跑过的命令（验证证据）。只留最近 60 条 */
  bashRuns: BashRun[];
  /** 会话开始时各仓的 git 基线（repoId → 提交 + 当时的未跟踪文件），用来发现经 shell 改动的文件 */
  baselines: Record<string, GitBaseline>;
  updatedAt: number;
}

export interface GitBaseline {
  /** git stash create 的提交（工作区干净时为 HEAD） */
  rev: string;
  untracked: string[];
}

export interface TaskContract {
  goal: string;
  nonGoals: string[];
  /** glob，相对仓库根；多仓工作区里也可写「子仓目录/路径」 */
  scope: string[];
  verify: string[];
  /** 声明契约时的会话目录，多仓工作区按它解析「子仓目录/路径」 */
  cwd: string;
  ts: number;
}

export interface ScopeExpansion {
  added: string[];
  reason: string;
  ts: number;
}

export interface GuardNote {
  text: string;
  file?: string;
  ts: number;
}

export interface BashRun {
  cmd: string;
  ok: boolean;
  ts: number;
}

/**
 * 状态格式版本。
 *
 * 3 = key 带上了仓库维度。**版本不匹配时整份丢弃**（见 `load`）——
 * 旧格式的 key 没有仓前缀，混着读会让"查过"判定时真时假，
 * 那比丢掉状态坏得多。丢掉只是让守卫多拦一次，方向安全。
 */
const STATE_VERSION = 3;

/**
 * 仓级 key 的前缀。**写入、读取、反解都必须走它** ——
 * 前缀在多处各算一遍的话，改一处漏一处会让"查过"判定静默失配
 *（记的时候带前缀、读的时候不带 → 永远判成没查过，或者反过来永远放行）。
 * 这个失配没有任何报错，只表现为守卫时松时紧。
 */
function scopePrefix(repoDir: string): string {
  return `${repoId(repoDir)}:`;
}

/** 仓级状态的 key。repoId 里不含 `:`，所以第一个 `:` 就是分隔符 */
function scopedKey(repoDir: string, suffix: string): string {
  return `${scopePrefix(repoDir)}${suffix}`;
}

/** 从仓级 key 里取回后半段。不属于这个仓就返回 null */
function unscope(repoDir: string, key: string): string | null {
  const prefix = scopePrefix(repoDir);
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

/**
 * 显式设定的会话 id。
 *
 * ── 为什么需要这个 ──
 * 同一个会话，两个进程拿到 id 的途径**不一样**：
 *   · MCP server 是宿主长驻拉起的 → id 在环境变量 `CODEBUDDY_SESSION_ID` 里
 *   · hook 是一次性子进程        → id 在 stdin JSON 的 `session_id` 字段里
 * 而"AI 调了 impact"（MCP 进程）和"写文件被拦"（hook 进程）必须算成同一个会话，
 * 否则守卫就是死循环：拦 → AI 去查 → 回来还是被拦。
 * 所以 hook 分发时要先把 stdin 里的 id 灌进来。
 */
let override: string | null = null;

/** 由 runHook 在分发前调用，把宿主 stdin 里的 session_id 接进来 */
export function setSessionId(id: string | undefined | null): void {
  const s = (id ?? '').trim();
  override = s || null;
}

/**
 * 当前会话 id。
 *
 * 优先级：显式设定（hook stdin）> 环境变量 > `'_nosession'`。
 * 全都没有时退到 `'_nosession'` —— 那时状态在整个仓库上共享，
 * 比完全不记要好（至少 impact→write 这一对能连上）。
 *
 * 两个环境变量名都认：`CODEBUDDY_SESSION_ID` 是本宿主的，`CLAUDE_SESSION_ID`
 * 是兼容名。
 */
export function sessionId(): string {
  const raw = override || process.env.CODEBUDDY_SESSION_ID || process.env.CLAUDE_SESSION_ID || adopted || '';
  const s = raw.trim();
  if (!s) return '_nosession';
  // 文件名安全：会话 id 来自宿主，不能直接当路径用（路径穿越）
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

// ══════════════════ MCP 进程认领会话 ══════════════════
//
// 真机实测：宿主拉起 MCP server 时**不带** CODEBUDDY_SESSION_ID。于是 AI 调 impact 记在
// `_nosession`，写前钩子读的是 stdin 里的真实 id —— 查了还被拦，守卫变成死循环；
// 埋点里「AI 查了图谱」和「写入被拦 / 放行」也串不成一条链。
//
// 修法：钩子每次运行都把「这个仓当前是哪个会话」写进一个按仓分的指针文件；
// MCP 进程拿不到环境变量时，按自己服务的仓去读它。同一个仓同时开两个会话时
// 以最近活跃的为准 —— 偶尔记错会话，也比永远记不上强。

let adopted: string | null = null;

/** 指针多久算过期。超过就不认，免得昨天的会话替今天的放行 */
const POINTER_TTL_MS = 12 * 3600_000;

function pointerFile(repoDir: string): string {
  return path.join(stateRoot(), 'state', '_current', `${repoId(repoDir)}.json`);
}

/** 钩子调用：记下这个仓当前的会话。没有真实 id（stdin 里没带）就不写 */
export function bindCurrentSession(repoDir: string): void {
  if (!override) return;
  const sid = sessionId();
  try {
    const f = pointerFile(repoDir);
    const prev = readJson<{ sid?: string; ts?: number }>(f);
    // 同一会话一分钟内不重复写：钩子很频繁，没必要每次落盘
    if (prev?.sid === sid && typeof prev.ts === 'number' && Date.now() - prev.ts < 60_000) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ sid, ts: Date.now() }));
  } catch {
    /* 写不进去：MCP 退回 _nosession，行为与修之前一样 */
  }
}

/**
 * MCP 进程调用：环境变量里没有会话 id 时，认领这个仓当前的会话。
 * 每次工具调用前都要调 —— 长驻进程会跨会话，不能只在启动时认一次。
 */
export function adoptSessionFor(repoDir: string): void {
  adopted = null;
  if (override || process.env.CODEBUDDY_SESSION_ID || process.env.CLAUDE_SESSION_ID) return;
  const p = readJson<{ sid?: string; ts?: number }>(pointerFile(repoDir));
  if (p && typeof p.sid === 'string' && typeof p.ts === 'number' && Date.now() - p.ts < POINTER_TTL_MS) {
    adopted = p.sid;
  }
}

function stateFile(sid: string): string {
  return path.join(stateRoot(), 'state', `${sid}.json`);
}

function emptyState(): SessionState {
  return {
    version: STATE_VERSION,
    queried: {},
    libSearched: [],
    similarSearched: [],
    similarPlans: [],
    hotRepos: [],
    touchedFiles: [],
    failStreak: null,
    consecutiveFail: 0,
    fileWriteFail: {},
    toolCalls: 0,
    evidence: [],
    stopNotices: [],
    contract: null,
    expansions: [],
    notes: [],
    writes: {},
    bashRuns: [],
    baselines: {},
    updatedAt: 0,
  };
}

function load(sid: string): SessionState {
  const raw = readJson<Partial<SessionState>>(stateFile(sid));
  // 旧格式的 key 没有仓前缀，逐字段容错地读进来会让"查过"判定时真时假。
  // 整份丢弃，让守卫多拦一次 —— 这个方向的失败是安全的
  if (!raw || raw.version !== STATE_VERSION) return emptyState();

  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const counts = (v: unknown): Record<string, number> => {
    if (!v || typeof v !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
    }
    return out;
  };
  return {
    version: STATE_VERSION,
    queried: raw.queried && typeof raw.queried === 'object' ? (raw.queried as Record<string, number>) : {},
    libSearched: arr(raw.libSearched),
    similarSearched: arr(raw.similarSearched),
    similarPlans: Array.isArray(raw.similarPlans)
      ? raw.similarPlans.filter((p): p is SimilarPlan => !!p && typeof p === 'object' && typeof (p as SimilarPlan).key === 'string')
      : [],
    hotRepos: arr(raw.hotRepos),
    touchedFiles: arr(raw.touchedFiles),
    failStreak:
      raw.failStreak && typeof raw.failStreak === 'object' && typeof raw.failStreak.key === 'string' && typeof raw.failStreak.n === 'number'
        ? { key: raw.failStreak.key, n: raw.failStreak.n }
        : null,
    consecutiveFail: typeof raw.consecutiveFail === 'number' ? raw.consecutiveFail : 0,
    fileWriteFail: counts(raw.fileWriteFail),
    toolCalls: typeof raw.toolCalls === 'number' ? raw.toolCalls : 0,
    evidence: arr(raw.evidence),
    stopNotices: arr(raw.stopNotices),
    contract: raw.contract && typeof raw.contract === 'object' && Array.isArray(raw.contract.scope) ? raw.contract : null,
    expansions: Array.isArray(raw.expansions) ? raw.expansions : [],
    notes: Array.isArray(raw.notes) ? raw.notes : [],
    writes: counts(raw.writes),
    bashRuns: Array.isArray(raw.bashRuns) ? raw.bashRuns : [],
    baselines: raw.baselines && typeof raw.baselines === 'object' ? (raw.baselines as Record<string, GitBaseline>) : {},
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

/**
 * 读 → 改 → 写，整段在锁里。
 *
 * ── 为什么必须加锁 ──
 * 同一个会话的状态文件会被好几个进程同时改：MCP 进程记「查过 similar」、写前钩子记「改过这个文件」、
 * 写后钩子记循环门计数 —— 宿主是并行拉起它们的。之前各自「读整份 → 改一处 → 写整份」，
 * 后写的会把先写的整份覆盖掉。真机实测：AI 查了两次 similar（第二次带 template 定了参考），
 * 最后状态里一条都没留下，写后比对拿不到计划，新建门也把它当成没查过。
 *
 * 锁用 mkdir（原子、跨平台、不依赖三方库）。拿不到锁最多等 2 秒；锁超过 5 秒没释放按残留清掉
 *（持锁进程被杀）。实在拿不到就不加锁照做 —— 与修之前一样，不能因为锁让钩子卡死。
 */
function update<T>(fn: (st: SessionState) => T): T {
  const sid = sessionId();
  const f = stateFile(sid);
  const lock = `${f}.lock`;
  let locked = false;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        fs.mkdirSync(lock);
        locked = true;
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') break;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmdirSync(lock);
        } catch {
          /* 别的进程刚释放 */
        }
        if (Date.now() > deadline) break;
        Atomics.wait(SLEEPER, 0, 0, 5);
      }
    }
  } catch {
    /* 状态目录建不出来：下面 save 也会静默失败 */
  }
  try {
    const st = load(sid);
    const out = fn(st);
    save(sid, st);
    return out;
  } finally {
    if (locked) {
      try {
        fs.rmdirSync(lock);
      } catch {
        /* 已被当作残留清掉 */
      }
    }
  }
}

const SLEEPER = new Int32Array(new SharedArrayBuffer(4));

function save(sid: string, st: SessionState): void {
  try {
    const f = stateFile(sid);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    // 先写临时文件再改名：别的进程读到的要么是旧的整份、要么是新的整份，不会读到半截
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...st, version: STATE_VERSION, updatedAt: Date.now() }));
    fs.renameSync(tmp, f);
  } catch {
    // 写不进去就算了。后果是守卫更严（同一个文件要反复查），
    // 这个方向的失败是安全的 —— 比放行错的好。
  }
}

/** 记下"查过这个文件的影响面" */
export function recordQueried(repoDir: string, rel: string): void {
  if (!rel) return;
  update((st) => {
    st.queried[scopedKey(repoDir, rel)] = Date.now();
  });
}

/** 这个文件在本会话查过影响面吗 */
export function hasQueried(repoDir: string, rel: string): boolean {
  if (!rel) return false;
  return Object.prototype.hasOwnProperty.call(load(sessionId()).queried, scopedKey(repoDir, rel));
}

/** 记下"查过组件库目录" */
export function recordLibSearch(repoDir: string, intent: string): void {
  const key = scopedKey(repoDir, intent);
  update((st) => {
    if (!st.libSearched.includes(key)) st.libSearched.push(key);
  });
}

/** 记下"查过同类页骨架" */
export function recordSimilarSearch(repoDir: string, intent: string): void {
  const key = scopedKey(repoDir, intent);
  update((st) => {
    if (!st.similarSearched.includes(key)) st.similarSearched.push(key);
  });
}

/** 记下一次 similar 的参考计划。同一资源只留最新一份（AI 换了 template 再查，以后查的为准） */
export function recordSimilarPlan(repoDir: string, plan: Omit<SimilarPlan, 'repo' | 'ts'>): void {
  const repo = repoId(repoDir);
  update((st) => {
    st.similarPlans = st.similarPlans.filter((p) => !(p.repo === repo && p.key === plan.key));
    st.similarPlans.push({ ...plan, repo, ts: Date.now() });
    // 一个会话里几十个资源已经很离谱了，封顶防状态文件无限长
    if (st.similarPlans.length > 30) st.similarPlans = st.similarPlans.slice(-30);
  });
}

export function similarPlans(repoDir: string): SimilarPlan[] {
  const repo = repoId(repoDir);
  return load(sessionId()).similarPlans.filter((p) => p.repo === repo);
}

/**
 * 本仓查过组件库吗。
 *
 * 按仓记而不按会话记：lib / similar 回答的是"**本仓**的组件库里有什么"、
 * "**本仓**这类页面怎么写的"（见 graph-enforce.ts 顶部）。这本来就是仓级知识，
 * 拿 A 仓的答案去放行 B 仓的新建，等于让模型照着另一个仓的约定写。
 */
export function hasLibSearched(repoDir: string): boolean {
  const prefix = scopePrefix(repoDir);
  return load(sessionId()).libSearched.some((k) => k.startsWith(prefix));
}

export function hasSimilarSearched(repoDir: string): boolean {
  const prefix = scopePrefix(repoDir);
  return load(sessionId()).similarSearched.some((k) => k.startsWith(prefix));
}

/**
 * 本仓查过高扇入热点吗。
 *
 * 与 `hasSimilarSearched` 分开记是刻意的：hot 回答「别改我 / 别重造」，
 * similar 回答「照这个做」。拿一个冒充另一个，模型会拿着高扇入清单
 * 去当同类实现抄 —— 那是错的。
 */
export function hasHotQueried(repoDir: string): boolean {
  return load(sessionId()).hotRepos.includes(repoId(repoDir));
}

export function recordHotQuery(repoDir: string): void {
  const id = repoId(repoDir);
  update((st) => {
    if (!st.hotRepos.includes(id)) st.hotRepos.push(id);
  });
}

// ══════════════════ L1 范围门：会话内改过哪些文件 ══════════════════

/**
 * 本仓改动过的文件（仓库相对路径）。
 *
 * 只给"这个文件改过没有"的成员判定用，所以必须按仓过滤 ——
 * 预算的**总数**要的是跨仓总和，那个走 `countSessionFiles`。
 */
export function sessionTouchedFiles(repoDir: string): string[] {
  const out: string[] = [];
  for (const key of load(sessionId()).touchedFiles) {
    const rel = unscope(repoDir, key);
    if (rel) out.push(rel);
  }
  return out;
}

/**
 * 本会话改动过的文件总数（**跨仓求和**）。
 *
 * 范围预算管的是"这次任务涉及面有多宽"。跨两个仓各改 4 个文件，
 * 涉及面就是 8 个文件，按仓拆开各自从 0 数起会让预算形同虚设。
 */
export function countSessionFiles(): number {
  return load(sessionId()).touchedFiles.length;
}

export function recordSessionFile(repoDir: string, rel: string): void {
  if (!rel) return;
  const key = scopedKey(repoDir, rel);
  update((st) => {
    if (!st.touchedFiles.includes(key)) st.touchedFiles.push(key);
  });
}

// ══════════════════ L3 循环门：三个计数器 ══════════════════

function callKey(toolName: string, fingerprint: string): string {
  return `${toolName}|${fingerprint.slice(0, 120)}`;
}

/**
 * 记一次（写文件 / Bash）调用的结果，三个计数器在同一把锁里一起改。
 *
 * 分开调三个函数的话，三次加锁之间别的进程插进来，计数会互相错位。
 */
export function noteToolOutcome(o: { repoDir: string; toolName: string; fingerprint: string; rel: string | null; ok: boolean }): void {
  const key = o.fingerprint ? callKey(o.toolName, o.fingerprint) : '';
  update((st) => {
    st.toolCalls += 1;
    if (o.ok) {
      st.failStreak = null;
      st.consecutiveFail = 0;
      if (o.rel) delete st.fileWriteFail[scopedKey(o.repoDir, o.rel)];
      return;
    }
    st.consecutiveFail += 1;
    if (key) st.failStreak = st.failStreak?.key === key ? { key, n: st.failStreak.n + 1 } : { key, n: 1 };
    if (o.rel) {
      const fk = scopedKey(o.repoDir, o.rel);
      st.fileWriteFail[fk] = (st.fileWriteFail[fk] ?? 0) + 1;
    }
  });
}

/**
 * 拦过一次就清零：连续失败 / 同文件写失败。
 *
 * 这两种拦截的对象是「接下来所有的写入与命令」「这个文件」——
 * 而清零又要靠写入 / 命令 / 写这个文件成功。不清零的话被拦住就永远出不来，整个会话锁死。
 * 所以它们是一次性的：拦一次、给出「先确认前提 / 先读文件」的提示，然后放行下一次尝试；
 * 再连着失败到阈值会再拦。重复失败（同一个调用）只拦那一个调用，不会锁死，不清。
 */
export function resetAfterLoopBlock(kind: 'consecutive_fail' | 'file_write_fail', repoDir: string, rel: string | null): void {
  update((st) => {
    if (kind === 'consecutive_fail') st.consecutiveFail = 0;
    else if (rel) delete st.fileWriteFail[scopedKey(repoDir, rel)];
  });
}

/** 这个调用眼下连续失败了几次（上一次成功之后） */
export function failStreakOf(toolName: string, fingerprint: string): number {
  const s = load(sessionId()).failStreak;
  return s && s.key === callKey(toolName, fingerprint) ? s.n : 0;
}

export function consecutiveFailCount(): number {
  return load(sessionId()).consecutiveFail;
}

export function fileWriteFailCount(repoDir: string, rel: string): number {
  return load(sessionId()).fileWriteFail[scopedKey(repoDir, rel)] ?? 0;
}

export function toolCallCount(): number {
  return load(sessionId()).toolCalls;
}

// ══════════════════ L5 交付门：工程校验证据 ══════════════════

export function recordEvidence(kind: string): void {
  update((st) => {
    if (!st.evidence.includes(kind)) st.evidence.push(kind);
  });
}

export function evidenceList(): string[] {
  return load(sessionId()).evidence;
}

/**
 * Stop 提醒的去重。
 *
 * 返回 true 表示"这条还没提醒过，可以提"。
 *
 * ⚠️ 这是防死循环的唯一手段：宿主**没有实现** `loop_limit` 字段
 *（内部市场有插件在 Stop 上写了它，CodeBuddy 会静默忽略）。
 * 如果 Stop 上用了 `continue:false` 而没有这一层去重，
 * 模型会反复触发同一个校验，无限续跑。
 */
export function claimStopNotice(reason: string): boolean {
  return update((st) => {
    if (st.stopNotices.includes(reason)) return false;
    st.stopNotices.push(reason);
    return true;
  });
}

// ══════════════════ v2：契约、顺手发现、写入与命令记录、写前快照 ══════════════════

export function getContract(): TaskContract | null {
  return load(sessionId()).contract;
}

/** 声明或更新契约。新增范围时必须带理由，记一条扩范围 */
export function saveContract(c: Omit<TaskContract, 'ts'>, reason: string): { ok: true; added: string[] } | { ok: false; message: string } {
  return update((st) => {
    const prev = st.contract;
    const added = prev ? c.scope.filter((x) => !prev.scope.includes(x)) : [];
    if (prev && added.length && !reason.trim()) {
      return { ok: false as const, message: '扩大范围（新增 ' + added.join('、') + '）需要在 reason 里写明理由。' };
    }
    if (added.length) st.expansions.push({ added, reason: reason.trim(), ts: Date.now() });
    st.contract = { ...c, ts: Date.now() };
    return { ok: true as const, added };
  });
}

export function scopeExpansions(): ScopeExpansion[] {
  return load(sessionId()).expansions;
}

export function addNote(text: string, file?: string): number {
  return update((st) => {
    st.notes.push({ text, ...(file ? { file } : {}), ts: Date.now() });
    if (st.notes.length > 50) st.notes = st.notes.slice(-50);
    return st.notes.length;
  });
}

export function guardNotes(): GuardNote[] {
  return load(sessionId()).notes;
}

export function recordWrite(repoDir: string, rel: string): void {
  if (!rel) return;
  update((st) => {
    st.writes[scopedKey(repoDir, rel)] = Date.now();
  });
}

/** 本仓本会话经写工具改过的文件 */
export function writtenFiles(repoDir: string): string[] {
  const out: string[] = [];
  for (const k of Object.keys(load(sessionId()).writes)) {
    const rel = unscope(repoDir, k);
    if (rel) out.push(rel);
  }
  return out;
}

/** 本会话（跨仓）写过的不同文件，含仓前缀 */
export function writtenKeys(): string[] {
  return Object.keys(load(sessionId()).writes);
}

export function lastWriteAt(): number {
  const w = Object.values(load(sessionId()).writes);
  return w.length ? Math.max(...w) : 0;
}

export function recordBashRun(cmd: string, ok: boolean): void {
  update((st) => {
    st.bashRuns.push({ cmd: cmd.slice(0, 400), ok, ts: Date.now() });
    if (st.bashRuns.length > 60) st.bashRuns = st.bashRuns.slice(-60);
  });
}

export function bashRuns(): BashRun[] {
  return load(sessionId()).bashRuns;
}

export function getBaseline(repoDir: string): GitBaseline | null {
  return load(sessionId()).baselines[repoId(repoDir)] ?? null;
}

/** 只在本会话第一次记；已有就不动 */
export function setBaselineOnce(repoDir: string, b: GitBaseline): void {
  update((st) => {
    const k = repoId(repoDir);
    if (!st.baselines[k]) st.baselines[k] = b;
  });
}

/** 写前快照：每个文件只在本会话第一次写之前存一份，作为「本次增量」的基线 */
function preDir(): string {
  return path.join(stateRoot(), 'state', 'pre', sessionId());
}

function preFile(repoDir: string, rel: string): string {
  const key = scopedKey(repoDir, rel);
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = ((h ^ key.charCodeAt(i)) * 0x01000193) >>> 0;
  return path.join(preDir(), h.toString(16).padStart(8, '0') + '-' + path.basename(rel).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) + '.json');
}

/** 超过 1MB 的文件不存快照（生成物、数据文件），回执里按「无基线」处理 */
const PRE_MAX_BYTES = 1024 * 1024;

export function snapshotBefore(repoDir: string, rel: string, abs: string): void {
  try {
    const f = preFile(repoDir, rel);
    if (fs.existsSync(f)) return;
    let content: string | null = null;
    let tooBig = false;
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) {
        if (st.size > PRE_MAX_BYTES) tooBig = true;
        else content = fs.readFileSync(abs, 'utf-8');
      }
    } catch {
      content = null; // 新文件
    }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ rel, content, tooBig }));
  } catch {
    /* 快照失败：回执里这个文件按无基线处理 */
  }
}

/** 直接存快照内容（经 shell 改的文件：改动前的内容来自 git 基线）。已有快照不覆盖 */
export function snapshotContent(repoDir: string, rel: string, content: string | null, tooBig = false): void {
  try {
    const f = preFile(repoDir, rel);
    if (fs.existsSync(f)) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ rel, content, tooBig }));
  } catch {
    /* 快照失败：回执里按无基线处理 */
  }
}

/** 读快照。undefined = 没有快照（不是经写工具改的，或快照失败） */
export function readBefore(repoDir: string, rel: string): { content: string | null; tooBig: boolean } | undefined {
  const raw = readJson<{ content?: unknown; tooBig?: unknown }>(preFile(repoDir, rel));
  if (!raw) return undefined;
  return { content: typeof raw.content === 'string' ? raw.content : null, tooBig: raw.tooBig === true };
}

/**
 * 清掉超过 7 天没动的会话状态。
 *
 * 由 `session-end` 顺手调用 —— 会话状态是一次性的，长期堆积只是垃圾。
 * 不做也不影响正确性，所以任何异常都静默吞掉。
 */
export function sweepStaleSessions(maxAgeMs = 7 * 86_400_000): void {
  try {
    const dir = path.join(stateRoot(), 'state');
    const now = Date.now();
    try {
      const pre = path.join(dir, 'pre');
      for (const name of fs.readdirSync(pre)) {
        const d = path.join(pre, name);
        if (now - fs.statSync(d).mtimeMs > maxAgeMs) fs.rmSync(d, { recursive: true, force: true });
      }
    } catch {
      /* 没有快照目录 */
    }
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name);
      if (name === 'pre' || name === '_current') continue;
      try {
        if (now - fs.statSync(f).mtimeMs > maxAgeMs) fs.unlinkSync(f);
      } catch {
        /* 单个文件删不掉不影响其他 */
      }
    }
  } catch {
    /* 目录不存在 */
  }
}