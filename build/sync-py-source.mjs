#!/usr/bin/env node
/**
 * 把 `py_graph.py` 内嵌进 `py-graph-source.ts`。
 *
 * ── 为什么要内嵌 ──
 * Python 分析器走子进程：把脚本写到临时文件，再 `python3 <临时文件> <repoDir>`。
 * 脚本内容必须来自**代码里的字符串**，因为打包器不复制非 JS 资源 ——
 * 产物里只有一个 `bin/repo-guard`，`new URL('./py_graph.py', import.meta.url)`
 * 本地能跑、装到用户机器上必然 ENOENT。这是最难查的一类故障（本地全绿、线上报错）。
 *
 * ── 为什么还留着 .py 文件 ──
 * 内嵌字符串没法读、没法 lint、没法 `python3 -m py_compile` 验语法。
 * 所以 .py 是**源**，.ts 是**生成物**，`build/build.mjs` 每次构建都校验两者一致，
 * 不一致直接失败。这个脚本是改完 .py 之后同步过去的那一步。
 *
 * 用法：node build/sync-py-source.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'src', 'engine', 'graph', 'analyzers');
const PY = path.join(DIR, 'py_graph.py');
const TS = path.join(DIR, 'py-graph-source.ts');

const body = fs.readFileSync(PY, 'utf-8');

fs.writeFileSync(
  TS,
  `/**
 * 【自动生成，请勿手改】
 *
 * 由 \`node build/sync-py-source.mjs\` 从同目录的 \`py_graph.py\` 生成。
 * 要改 Python 分析器，去改那个 .py 文件，然后重跑同步 ——
 * 一致性由 \`build/build.mjs\` 在每次构建时硬校验，不一致则构建失败。
 *
 * 为什么内嵌成字符串而不是读文件：打包器不复制非 JS 资源，
 * 产物里只有 bin/repo-guard 一个文件，读文件必然 ENOENT。
 */

/** py_graph.py 的完整内容。运行时写到临时文件后交给 python3 执行。 */
export const PY_GRAPH_SOURCE: string = ${JSON.stringify(body)};
`,
);

console.log(`[sync-py] ${path.relative(ROOT, TS)}  ${body.length} 字符`);
