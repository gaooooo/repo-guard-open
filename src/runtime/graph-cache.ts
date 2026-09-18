/**
 * 图谱缓存 —— 建一次、多次查，并在代码变了之后自动重建。
 *
 * ── 为什么缓存不进 git ──
 * 图谱是代码的**投影**：删了重跑结果一模一样。所以不进 git、不用备份。
 * 红线不一样 —— 那是人写的意图，丢了就永久损失。
 *
 * ── 失效判据为什么是两条 ──
 *   ① git HEAD 变了        —— 切分支、拉新代码
 *   ② 源文件最大 mtime 变了 —— 管的是"改了还没提交"
 *
 * 第二条很容易被漏掉，但它恰恰是最要紧的：AI 刚改完还没提交时，
 * 如果图谱不跟着更新，`impact` 查出来的是**旧答案**。而这个工具存在的全部理由
 * 就是"给出准确的影响面"，给旧答案比不给答案更坏 —— 人会信它。
 *
 * ── 为什么 hook 里绝不能建图 ──
 * `pre-write` 的超时预算只有十几秒，`pre-bash` / `post-write` 只有几秒，
 * 而 web-frontend 分析器在万文件级仓库上可能要几十秒。所以 hook 只调
 * `loadCachedGraph`（只读，miss 就 fail-open），建图只发生在 CLI 与 MCP ——
 * 那两个没有超时约束。
 */
import fs from 'node:fs';
import path from 'node:path';

import { buildGraphAuto } from '../engine/graph/registry.js';
import { emptyGraph, type CodeGraph } from '../engine/graph/types.js';
import { MAX_FILES, SKIP_DIRS } from '../engine/graph/analyzers/lexical-utils.js';
import { readHeadSha } from '../engine/graph-report.js';
import { cachePath, readJson } from './paths.js';

/** 缓存元信息：判失效用 */
interface CacheMeta {
  version: number;
  /** 建图时的 git HEAD 短 sha。null = 非 git 工作区 */
  headSha: string | null;
  /** 建图时源文件的最大 mtime（毫秒） */
  maxMtime: number;
  /** 源文件数。数量变了也得重建（新增/删除文件 mtime 可能不变） */
  fileCount: number;
  analyzer: string | null;
  builtAt: number;
}

const CACHE_VERSION = 2;

function graphFile(repoDir: string): string {
  return cachePath(repoDir, 'graph.json');
}
function metaFile(repoDir: string): string {
  return cachePath(repoDir, 'meta.json');
}

/** 参与新鲜度判定的源文件扩展名。与各分析器认的那些对齐 */
const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.go', '.java', '.kt', '.py', '.sql',
]);

/**
 * 扫源文件的最大 mtime 与数量。
 *
 * 只 stat 不读内容，所以比建图快两个数量级 —— 这是它能放在每次查询前跑的前提。
 * 复用 lexical-utils 的 SKIP_DIRS：node_modules / dist / .git 这些既不该入图、
 * 也不该参与新鲜度判定（`npm install` 一下 mtime 全变，图谱会被无意义地重建）。
 */
function scanSourceStamp(repoDir: string): { maxMtime: number; fileCount: number } {
  let maxMtime = 0;
  let fileCount = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: repoDir, depth: 0 }];

  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    if (depth > 12 || fileCount > MAX_FILES) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!SOURCE_EXT.has(path.extname(e.name))) continue;
      try {
        const st = fs.statSync(full);
        fileCount++;
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
      } catch {
        /* 文件刚被删：不影响戳 */
      }
    }
  }
  return { maxMtime: Math.floor(maxMtime), fileCount };
}

/** 缓存还新鲜吗 */
function isFresh(repoDir: string, meta: CacheMeta | null): boolean {
  if (!meta || meta.version !== CACHE_VERSION) return false;
  if (readHeadSha(repoDir) !== meta.headSha) return false;
  const stamp = scanSourceStamp(repoDir);
  return stamp.maxMtime === meta.maxMtime && stamp.fileCount === meta.fileCount;
}

/**
 * 只读缓存，**永不建图**。给 hook 用。
 *
 * 返回 null 有三种情况：没建过图、缓存过期、缓存文件坏了。
 * 三种都按同一个方式处理 —— 调用方 fail-open。宁可漏拦一次，
 * 不要因为 hook 超时把整个工具调用弄失败。
 */
export function loadCachedGraph(repoDir: string): CodeGraph | null {
  const meta = readJson<CacheMeta>(metaFile(repoDir));
  if (!isFresh(repoDir, meta)) return null;
  const graph = readJson<CodeGraph>(graphFile(repoDir));
  if (!graph || !Array.isArray(graph.modules)) return null;
  return graph;
}

export interface GraphHandle {
  graph: CodeGraph;
  /** 这次是现建的还是命中缓存。init 的报告里要区分「现建 0.3 秒」与「缓存」 */
  fromCache: boolean;
  /** 现建耗时（毫秒）。命中缓存时为 0 */
  buildMs: number;
  headSha: string | null;
  builtAt: Date;
}

/**
 * 拿图。缓存新鲜就用缓存，否则现建并落盘。给 CLI 与 MCP 用。
 *
 * @param analyzerName 指定分析器。不传则自动探测取最高置信度。
 */
export async function getGraph(repoDir: string, analyzerName?: string): Promise<GraphHandle> {
  const meta = readJson<CacheMeta>(metaFile(repoDir));
  if (isFresh(repoDir, meta) && (!analyzerName || meta!.analyzer === analyzerName)) {
    const cached = readJson<CodeGraph>(graphFile(repoDir));
    if (cached && Array.isArray(cached.modules)) {
      return {
        graph: cached,
        fromCache: true,
        buildMs: 0,
        headSha: meta!.headSha,
        builtAt: new Date(meta!.builtAt),
      };
    }
  }

  const t0 = Date.now();
  let graph: CodeGraph;
  try {
    graph = await buildGraphAuto(repoDir, analyzerName);
  } catch (err) {
    // 建图崩了要给**空图 + 明确 warning**，不能抛出去。
    // 但空图是最坏的失败模式（AI 会把"没有调用者"当事实去删代码），
    // 所以 warning 必须说清是建图失败而不是"真的没有调用者"。
    graph = {
      ...emptyGraph(repoDir),
      warnings: [`建图失败：${(err as Error).message.slice(0, 200)}。本次结果不可用于判断影响面。`],
    };
  }
  const buildMs = Date.now() - t0;

  const stamp = scanSourceStamp(repoDir);
  const headSha = readHeadSha(repoDir);
  const builtAt = new Date();

  // 落盘失败不影响本次查询 —— 只是下次还得重建
  try {
    fs.mkdirSync(cachePath(repoDir), { recursive: true });
    fs.writeFileSync(graphFile(repoDir), JSON.stringify(graph));
    fs.writeFileSync(
      metaFile(repoDir),
      JSON.stringify({
        version: CACHE_VERSION,
        headSha,
        maxMtime: stamp.maxMtime,
        fileCount: stamp.fileCount,
        analyzer: graph.analyzer ?? analyzerName ?? null,
        builtAt: builtAt.getTime(),
      } satisfies CacheMeta),
    );
  } catch {
    /* 只读文件系统 / 磁盘满：静默 */
  }

  return { graph, fromCache: false, buildMs, headSha, builtAt };
}
