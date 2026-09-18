#!/usr/bin/env node
/**
 * 打包 —— src/ 的 TypeScript 打成一个零依赖的 `bin/repo-guard`。
 *
 * ── 为什么必须是单文件 ──
 * 这个插件的卖点之一是"内网可用、不装 npm 包、不下载东西"。用户 clone 下来
 * 或从 marketplace 装完，`hooks/hooks.json` 直接 `node ${CODEBUDDY_PLUGIN_ROOT}/bin/repo-guard`，
 * 中间不能有 `npm install` 这一步 —— 插件更新会换目录，node_modules 留不住，
 * 而 hook 只有 5~15 秒预算，装依赖必然超时。
 *
 * ── 为什么是 CJS 而不是 ESM ──
 * `@babel/traverse` 是 CJS，ESM 下 default interop 会变成 `{ default: fn }`；
 * 源码里已经写了 `.default ?? _traverse` 兜底，但打成 CJS 能少一层不确定性。
 * 另外 CJS 单文件不依赖文件扩展名推断，`node bin/repo-guard`（无后缀）直接能跑。
 *
 * 用法：
 *   node build/build.mjs            # 压缩，产物写 bin/repo-guard
 *   node build/build.mjs --dev      # 不压缩 + sourcemap，排查时用
 *   node build/build.mjs --out <路径>
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);

const DEV = argv.includes('--dev');
const ENTRY = path.join(ROOT, 'src', 'cli', 'index.ts');
const OUT = path.resolve(flag('--out') ?? path.join(ROOT, 'bin', 'repo-guard'));

/**
 * py_graph.py 与 py-graph-source.ts 的内嵌字符串必须一致。
 *
 * Python 分析器走子进程：`python3 <临时文件> <repoDir>`，而临时文件的内容来自
 * 内嵌字符串（打包器不复制非 JS 资源，读文件在打包产物里必然 ENOENT —— 这条
 * 教训在 deerclaw 的 python-ast.ts 文件头写着）。两份一旦漂移，症状是
 * "Python 仓突然建不出图"，而 hook 层 fail-open 会把它吞掉，只表现为图谱变空。
 * 空图是最坏的失败模式：模型会把"没有调用者"当事实去删代码。所以这里硬失败。
 */
function assertPySourceInSync() {
  const py = path.join(ROOT, 'src', 'engine', 'graph', 'analyzers', 'py_graph.py');
  const ts = path.join(ROOT, 'src', 'engine', 'graph', 'analyzers', 'py-graph-source.ts');
  if (!fs.existsSync(py) || !fs.existsSync(ts)) {
    console.error(`[build] 缺文件，无法校验 Python 分析器一致性：\n  ${py}\n  ${ts}`);
    process.exit(1);
  }
  const want = fs.readFileSync(py, 'utf-8');
  // 内嵌形式是 `export const PY_GRAPH_SOURCE: string = "...";`，用 JSON.parse 还原
  const m = fs.readFileSync(ts, 'utf-8').match(/PY_GRAPH_SOURCE[^=]*=\s*("(?:[^"\\]|\\.)*")/s);
  if (!m) {
    console.error('[build] py-graph-source.ts 里找不到 PY_GRAPH_SOURCE 字符串字面量');
    process.exit(1);
  }
  let got;
  try {
    got = JSON.parse(m[1]);
  } catch (e) {
    console.error(`[build] PY_GRAPH_SOURCE 不是合法的 JSON 字符串字面量：${e.message}`);
    process.exit(1);
  }
  if (got !== want) {
    console.error(
      '[build] py_graph.py 与 py-graph-source.ts 的内嵌内容不一致。\n' +
        '        改了 .py 就要同步内嵌字符串（用 build/sync-py-source.mjs）。',
    );
    process.exit(1);
  }
}

function main() {
  if (!fs.existsSync(ENTRY)) {
    console.error(`[build] 找不到入口：${ENTRY}`);
    process.exit(1);
  }
  assertPySourceInSync();

  const esbuild = path.join(ROOT, 'node_modules', '.bin', 'esbuild');
  if (!fs.existsSync(esbuild)) {
    console.error('[build] 没装 esbuild。先跑 `npm install`。');
    process.exit(1);
  }

  const args = [
    ENTRY,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node18',
    `--outfile=${OUT}`,
    // 全部打进产物：一个外部依赖都不许留，否则用户机器上必然 MODULE_NOT_FOUND
    '--packages=bundle',
    '--log-level=warning',
    // banner 里的 shebang 让 `./bin/repo-guard` 也能直接执行
    '--banner:js=#!/usr/bin/env node',
  ];
  args.push(DEV ? '--sourcemap' : '--minify');

  const r = spawnSync(esbuild, args, { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) process.exit(r.status ?? 1);

  fs.chmodSync(OUT, 0o755);

  // 冒烟：产物必须能被 node 解析并响应。上一版产物就是因为文件头被塞了 6 个
  // 字节的脏数据而整体语法错误，所有 hook 静默 fail-open —— 插件表面装着、
  // 实际全放行。这种故障没有任何报错，只能靠这一步兜住。
  const smoke = spawnSync(process.execPath, [OUT], { encoding: 'utf-8', cwd: ROOT });
  if (smoke.status !== 0 || !/repo-guard/.test(smoke.stdout ?? '')) {
    console.error('[build] 冒烟失败：产物跑不起来或帮助输出不对');
    console.error(smoke.stderr || smoke.stdout);
    process.exit(1);
  }

  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`[build] ${path.relative(ROOT, OUT)}  ${kb} KB  ${DEV ? '（dev，未压缩）' : ''}`);
}

main();
