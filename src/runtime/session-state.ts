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
 */
import fs from 'node:fs';
import path from 'node:path';

import { readJson, stateRoot } from './paths.js';

interface SessionState {
  version: number;
  /** 查过影响面的文件（仓库相对路径）→ 查询时间戳 */
  queried: Record<string, number>;
  /** 查过组件库目录的意图关键词。给"新建组件前必须先 lib search"用 */
  libSearched: string[];
  /** 查过高扇入热点。给「新建组件前必须先 hot」用 */
  hotQueried: boolean;
  /** 查过同类页骨架。给「新建页面前必须先 similar」用 */
  similarSearched: string[];
  /** 本会话改动过的文件。给 L1 范围门的 maxFiles 预算用 */
  touchedFiles: string[];
  /**
   * L3 循环门的三个计数器。
   *
   * key 的设计决定了这三项准不准：
   *   repeat  —— `工具名|入参指纹`，指纹取路径 + 命令的前 120 字符。
   *              不含全文内容，否则改一个字就成了"新调用"，计数永远到不了阈值
   *   fail    —— 只有一个 key（'_'），记的是**连续**失败数，成功即清零
   *   fileFail—— `文件路径`，同一个文件反复写失败
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

const STATE_VERSION = 2;

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

function load(sid: string): SessionState {
  const raw = readJson<Partial<SessionState>>(stateFile(sid));
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
    queried: raw?.queried && typeof raw.queried === 'object' ? (raw.queried as Record<string, number>) : {},
    libSearched: arr(raw?.libSearched),
    similarSearched: arr(raw?.similarSearched),
    hotQueried: raw?.hotQueried === true,
    touchedFiles: arr(raw?.touchedFiles),
    repeatCount: counts(raw?.repeatCount),
    consecutiveFail: typeof raw?.consecutiveFail === 'number' ? raw.consecutiveFail : 0,
    fileWriteFail: counts(raw?.fileWriteFail),
    toolCalls: typeof raw?.toolCalls === 'number' ? raw.toolCalls : 0,
    evidence: arr(raw?.evidence),
    stopNotices: arr(raw?.stopNotices),
    updatedAt: typeof raw?.updatedAt === 'number' ? raw.updatedAt : 0,
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
export function recordQueried(rel: string): void {
  if (!rel) return;
  const sid = sessionId();
  const st = load(sid);
  st.queried[rel] = Date.now();
  save(sid, st);
}

/** 这个文件在本会话查过影响面吗 */
export function hasQueried(rel: string): boolean {
  if (!rel) return false;
  return Object.prototype.hasOwnProperty.call(load(sessionId()).queried, rel);
}

/** 记下"查过组件库目录" */
export function recordLibSearch(intent: string): void {
  const sid = sessionId();
  const st = load(sid);
  if (!st.libSearched.includes(intent)) st.libSearched.push(intent);
  save(sid, st);
}

/** 记下"查过同类页骨架" */
export function recordSimilarSearch(intent: string): void {
  const sid = sessionId();
  const st = load(sid);
  if (!st.similarSearched.includes(intent)) st.similarSearched.push(intent);
  save(sid, st);
}

export function hasLibSearched(): boolean {
  return load(sessionId()).libSearched.length > 0;
}

export function hasSimilarSearched(): boolean {
  return load(sessionId()).similarSearched.length > 0;
}

/**
 * 查过高扇入热点吗。
 *
 * 与 `hasSimilarSearched` 分开记是刻意的：hot 回答「别改我 / 别重造」，
 * similar 回答「照这个做」。拿一个冒充另一个，模型会拿着高扇入清单
 * 去当同类实现抄 —— 那是错的。
 */
export function hasHotQueried(): boolean {
  return load(sessionId()).hotQueried;
}

export function recordHotQuery(): void {
  const sid = sessionId();
  const st = load(sid);
  if (st.hotQueried) return;
  st.hotQueried = true;
  save(sid, st);
}

// ══════════════════ L1 范围门：会话内改过哪些文件 ══════════════════

export function sessionTouchedFiles(): string[] {
  return load(sessionId()).touchedFiles;
}

export function countSessionFiles(): number {
  return load(sessionId()).touchedFiles.length;
}

export function recordSessionFile(rel: string): void {
  if (!rel) return;
  const sid = sessionId();
  const st = load(sid);
  if (st.touchedFiles.includes(rel)) return;
  st.touchedFiles.push(rel);
  save(sid, st);
}

// ══════════════════ L3 循环门：三个计数器 ══════════════════

/**
 * 记一次工具调用，返回这个"调用指纹"到目前为止出现了几次。
 *
 * 指纹只取路径与命令的前 120 字符，**不含全文内容**。
 * 含全文的话，模型改一个字就成了"新调用"，重复计数永远到不了阈值 ——
 * 而"改一个字再试一次"恰恰是它卡住时最典型的行为。
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
export function bumpFileWriteFail(rel: string): number {
  const sid = sessionId();
  const st = load(sid);
  st.fileWriteFail[rel] = (st.fileWriteFail[rel] ?? 0) + 1;
  save(sid, st);
  return st.fileWriteFail[rel];
}

export function fileWriteFailCount(rel: string): number {
  return load(sessionId()).fileWriteFail[rel] ?? 0;
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
