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
  /** 本会话改动过的文件。元素 = `<repoId>:<仓库相对路径>`。给 L1 范围门的 maxFiles 预算用 */
  touchedFiles: string[];
  /**
   * L3 循环门的三个计数器。
   *
   * key 的设计决定了这三项准不准：
   *   repeat  —— `工具名|入参指纹`，指纹取路径 + 命令的前 120 字符。
   *              不含全文内容，否则改一个字就成了"新调用"，计数永远到不了阈值
   *   fail    —— 只有一个 key（'_'），记的是**连续**失败数，成功即清零
   *   fileFail—— `<repoId>:<文件路径>`，同一个文件反复写失败
   */
  repeatCount: Record<string, number>;
  consecutiveFail: number;
  fileWriteFail: Record<string, number>;
  /** 本会话的工具调用总数。L3 迭代预算只能靠它近似 */
  toolCalls: number;
  /** 本会话跑过的工程校验证据（lint / test / build 的命令片段）。L5 用 */
  evidence: string[];
  /** 已经注入过的 Stop 提醒原因。防死循环：同一 reason 每会话只注入一次 */
  stopNotices: string[];
  updatedAt: number;
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
  const raw = override || process.env.CODEBUDDY_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  const s = raw.trim();
  if (!s) return '_nosession';
  // 文件名安全：会话 id 来自宿主，不能直接当路径用（路径穿越）
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
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
    hotRepos: [],
    touchedFiles: [],
    repeatCount: {},
    consecutiveFail: 0,
    fileWriteFail: {},
    toolCalls: 0,
    evidence: [],
    stopNotices: [],
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
    hotRepos: arr(raw.hotRepos),
    touchedFiles: arr(raw.touchedFiles),
    repeatCount: counts(raw.repeatCount),
    consecutiveFail: typeof raw.consecutiveFail === 'number' ? raw.consecutiveFail : 0,
    fileWriteFail: counts(raw.fileWriteFail),
    toolCalls: typeof raw.toolCalls === 'number' ? raw.toolCalls : 0,
    evidence: arr(raw.evidence),
    stopNotices: arr(raw.stopNotices),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

function save(sid: string, st: SessionState): void {
  try {
    const f = stateFile(sid);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ ...st, version: STATE_VERSION, updatedAt: Date.now() }));
  } catch {
    // 写不进去就算了。后果是守卫更严（同一个文件要反复查），
    // 这个方向的失败是安全的 —— 比放行错的好。
  }
}

/** 记下"查过这个文件的影响面" */
export function recordQueried(repoDir: string, rel: string): void {
  if (!rel) return;
  const sid = sessionId();
  const st = load(sid);
  st.queried[scopedKey(repoDir, rel)] = Date.now();
  save(sid, st);
}

/** 这个文件在本会话查过影响面吗 */
export function hasQueried(repoDir: string, rel: string): boolean {
  if (!rel) return false;
  return Object.prototype.hasOwnProperty.call(load(sessionId()).queried, scopedKey(repoDir, rel));
}

/** 记下"查过组件库目录" */
export function recordLibSearch(repoDir: string, intent: string): void {
  const sid = sessionId();
  const st = load(sid);
  const key = scopedKey(repoDir, intent);
  if (!st.libSearched.includes(key)) st.libSearched.push(key);
  save(sid, st);
}

/** 记下"查过同类页骨架" */
export function recordSimilarSearch(repoDir: string, intent: string): void {
  const sid = sessionId();
  const st = load(sid);
  const key = scopedKey(repoDir, intent);
  if (!st.similarSearched.includes(key)) st.similarSearched.push(key);
  save(sid, st);
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
  const sid = sessionId();
  const st = load(sid);
  const id = repoId(repoDir);
  if (st.hotRepos.includes(id)) return;
  st.hotRepos.push(id);
  save(sid, st);
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
  const sid = sessionId();
  const st = load(sid);
  const key = scopedKey(repoDir, rel);
  if (st.touchedFiles.includes(key)) return;
  st.touchedFiles.push(key);
  save(sid, st);
}

// ══════════════════ L3 循环门：三个计数器 ══════════════════

/**
 * 记一次工具调用，返回这个"调用指纹"到目前为止出现了几次。
 *
 * 指纹只取路径与命令的前 120 字符，**不含全文内容**。
 * 含全文的话，模型改一个字就成了"新调用"，重复计数永远到不了阈值 ——
 * 而"改一个字再试一次"恰恰是它卡住时最典型的行为。
 *
 * 不带仓库维度：多仓下两个仓的同名文件会合并计数，于是循环门更早触发。
 * "反复在同一个相对路径上打转"本身就是卡住的信号，这个方向偏严，是安全的。
 */
export function bumpRepeat(toolName: string, fingerprint: string): number {
  const sid = sessionId();
  const st = load(sid);
  const key = `${toolName}|${fingerprint.slice(0, 120)}`;
  st.repeatCount[key] = (st.repeatCount[key] ?? 0) + 1;
  st.toolCalls += 1;
  save(sid, st);
  return st.repeatCount[key];
}

export function repeatCountOf(toolName: string, fingerprint: string): number {
  return load(sessionId()).repeatCount[`${toolName}|${fingerprint.slice(0, 120)}`] ?? 0;
}

/** 工具失败：连续失败数 +1，返回新值 */
export function bumpConsecutiveFail(): number {
  const sid = sessionId();
  const st = load(sid);
  st.consecutiveFail += 1;
  save(sid, st);
  return st.consecutiveFail;
}

/** 工具成功：连续失败数清零。**这一步不能漏** —— 漏了就成了"累计失败数" */
export function clearConsecutiveFail(): void {
  const sid = sessionId();
  const st = load(sid);
  if (st.consecutiveFail === 0) return;
  st.consecutiveFail = 0;
  save(sid, st);
}

export function consecutiveFailCount(): number {
  return load(sessionId()).consecutiveFail;
}

/** 同一个文件写失败：+1 并返回新值 */
export function bumpFileWriteFail(repoDir: string, rel: string): number {
  const sid = sessionId();
  const st = load(sid);
  const key = scopedKey(repoDir, rel);
  st.fileWriteFail[key] = (st.fileWriteFail[key] ?? 0) + 1;
  save(sid, st);
  return st.fileWriteFail[key];
}

export function fileWriteFailCount(repoDir: string, rel: string): number {
  return load(sessionId()).fileWriteFail[scopedKey(repoDir, rel)] ?? 0;
}

export function toolCallCount(): number {
  return load(sessionId()).toolCalls;
}

// ══════════════════ L5 交付门：工程校验证据 ══════════════════

export function recordEvidence(kind: string): void {
  const sid = sessionId();
  const st = load(sid);
  if (st.evidence.includes(kind)) return;
  st.evidence.push(kind);
  save(sid, st);
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
  const sid = sessionId();
  const st = load(sid);
  if (st.stopNotices.includes(reason)) return false;
  st.stopNotices.push(reason);
  save(sid, st);
  return true;
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
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name);
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
