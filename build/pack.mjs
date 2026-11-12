#!/usr/bin/env node
/**
 * 打包 —— 把本仓打成一个可分发给其他部门的「插件模板包」。
 *
 * ── 为什么需要这一步 ──
 * 分发链是三级的：
 *
 *     本仓（插件源码）
 *         ↓  npm run pack
 *     模板包  ──分发──▶ 部门：解压，填 layers/（红线、规范、门禁）
 *                          ↓  分发
 *                      个人项目：在 <repo>/.codebuddy/ 里做个性化定制
 *
 * 部门拿到的包里**没有 src/、没有 node_modules**，`bin/repo-guard` 是 minify 过的
 * 单文件。所以一条判据贯穿整个打包清单：
 *
 *     **部门需要改的一切，必须以 JSON / MD 的形式躺在包里。**
 *
 * 写死在 TypeScript 里的东西，部门改不了 —— 除非他们装 node_modules 重新构建，
 * 而那正是这个插件「内网可用、装完即用」承诺要避免的。
 *
 * ── 为什么是白名单而不是黑名单 ──
 * 黑名单（"排除 src/ 和 build/"）在仓库长出新目录时会默默把它带进包里。
 * 这个包要发给别的部门，多带一个 `.env.local` 或一份内部文档就是事故。
 * 白名单的代价是加新组件时要记得改这里 —— 而 `assertNoStrays()` 会提醒你。
 *
 * ── 为什么包里绝不能有 package.json ──
 * 产物 `bin/repo-guard` 是**无扩展名的 CJS 文件**，Node 按最近的 package.json
 * 判定模块类型。本仓的 package.json 没有 `"type": "module"`，所以在本仓里跑是对的；
 * 但只要包里存在任何一个声明了 `"type": "module"` 的 package.json（或者将来有人
 * 手贱加上），产物第一行 `require` 就 ReferenceError，而 hook 层 fail-open 会把
 * 错误吞掉 —— 插件表面装着、实际全放行。
 * 最安全的做法是**一个 package.json 都不带**，并在打包后硬断言这一点。
 *
 * ── 为什么版本号从 plugin.json 读 ──
 * 宿主认的是 `.codebuddy-plugin/plugin.json` 的 version，package.json 不进包。
 * 两处不一致时以 plugin.json 为准，但一定要报出来 —— 版本号对不上的包发出去，
 * 部门反馈问题时我们会对着错误的源码版本查。
 *
 * 用法：
 *   node build/pack.mjs                 # 产出 dist/repo-guard-<版本>/ + .tar.gz
 *   node build/pack.mjs --no-archive    # 只产目录，便于 diff / review
 *   node build/pack.mjs --out <目录>
 *   node build/pack.mjs --skip-smoke    # 跳过冒烟（只在调试打包脚本本身时用）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);

const NO_ARCHIVE = argv.includes('--no-archive');
const SKIP_SMOKE = argv.includes('--skip-smoke');

/**
 * 进包清单。**白名单，不是黑名单。**
 *
 * `required` 的项缺失即失败 —— 缺了它们包是坏的，而坏在哪不明显：
 * 少了 layers/ 的包装上之后 `standards init` 会说"找不到规范模板"，
 * 少了 hooks/ 的包则完全不报错，只是一道门都不生效。
 */
const MANIFEST = [
  // ── 引擎与自检 ──
  { src: 'bin/repo-guard', required: true, why: '引擎本体，零依赖单文件' },
  { src: 'bin/verify-hooks.mjs', required: true, why: '钩子回归' },
  { src: 'bin/verify-atlas.mjs', required: true, why: '外部图谱接入回归' },

  // ── 宿主要读的清单与配置 ──
  { src: '.codebuddy-plugin', required: true, why: '插件清单，宿主的入口' },
  { src: 'hooks', required: true, why: '钩子挂载点' },
  { src: '.mcp.json', required: true, why: 'MCP 服务器声明' },
  { src: 'settings.json', required: true, why: '插件默认设置' },
  { src: '.lsp.json', required: false, why: 'LSP 声明（当前有意为空）' },

  // ── 能力组件 ──
  { src: 'skills', required: true, why: '技能' },
  { src: 'commands', required: true, why: '斜杠命令' },
  { src: 'agents', required: true, why: '子代理' },

  // ── 部门要填的就是这里 ──
  { src: 'config', required: true, why: 'v2 全局层配置 config/repo-guard.json（过程控制的部门默认值）' },
  { src: 'layers', required: true, why: '七层作者面 + 全局层 JSON（规范/红线/门禁模板）' },

  // ── 文档 ──
  { src: 'docs', required: true, why: '部门会拿着它做二次分发说明' },
  { src: 'README.md', required: true, why: '' },
  { src: 'CHANGELOG.md', required: false, why: '部门需要知道升级时变了什么' },
];

/**
 * 绝不进包的东西。
 *
 * 这份清单不用于过滤（过滤靠白名单），而是用于**打包后的反向断言** ——
 * 万一某天白名单里混进了父目录，这里能兜住。
 */
const FORBIDDEN = [
  'package.json', // 见文件头
  'package-lock.json',
  'tsconfig.json',
  'node_modules',
  'src', // 源码不分发
  'build', // 含 baseline（几 MB 的黄金样本）与构建脚本
  '.git',
  '.codebuddy', // 本仓自己被 init 过的配置，带出去就是把我们的公共层清单发给别人
  'dist',
];

function die(msg) {
  console.error(`[pack] ${msg}`);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    die(`读不了 ${path.relative(ROOT, file)}：${e.message}`);
  }
}

/** 版本号：以 plugin.json 为准，与 package.json 不一致时硬失败 */
function resolveVersion() {
  const plugin = readJson(path.join(ROOT, '.codebuddy-plugin', 'plugin.json'));
  const pkg = readJson(path.join(ROOT, 'package.json'));
  if (!plugin.version) die('plugin.json 里没有 version');
  if (pkg.version && pkg.version !== plugin.version) {
    die(
      `版本号对不上：plugin.json=${plugin.version} package.json=${pkg.version}\n` +
        '        宿主认 plugin.json，但两处不一致的包发出去，排查问题时会对着错误的源码版本查。',
    );
  }
  return plugin.version;
}

function copyInto(src, dstRoot) {
  const from = path.join(ROOT, src);
  const to = path.join(dstRoot, src);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // dereference: 符号链接要展开成真文件，否则解压到别人机器上是死链
  fs.cpSync(from, to, { recursive: true, dereference: true });
}

/** 数一下目录里有多少个文件，报告里给人一个量级感 */
function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) n++;
  }
  return n;
}

/**
 * 反向断言：包里不许出现 FORBIDDEN 里的任何名字。
 *
 * 递归查而不是只查顶层 —— `layers/` 里将来完全可能被人塞一个 package.json
 * 当示例，而那一个文件就足以让整个产物按 ESM 解析。
 */
function assertNoStrays(dstRoot) {
  const bad = [];
  for (const e of fs.readdirSync(dstRoot, { withFileTypes: true, recursive: true })) {
    if (FORBIDDEN.includes(e.name)) {
      bad.push(path.relative(dstRoot, path.join(e.parentPath ?? e.path, e.name)));
    }
  }
  if (bad.length) {
    die(
      `包里出现了不该有的文件：\n${bad.map((b) => `          ${b}`).join('\n')}\n` +
        '        package.json 尤其致命：产物是无扩展名 CJS，会被按最近的 package.json 判定模块类型。',
    );
  }
}

// ───────────── 冒烟 ─────────────

/**
 * 冒烟三连。
 *
 * 为什么打包完还要跑：`build.mjs` 的冒烟证明的是"产物在本仓能跑"，
 * 而这里要证明的是"**产物在包的目录布局下**能跑"。两者不是一回事 ——
 * `standardsTemplateDir()` 用的是 `resolve(__dirname, '..', 'layers')`，
 * 它依赖 bin/ 与 layers/ 是兄弟目录。白名单里少写一行 layers，
 * 产物照样启动、帮助照样打印，只有规范会静默消失。
 */
function smoke(dstRoot) {
  const tool = path.join(dstRoot, 'bin', 'repo-guard');

  // ① 产物能跑，帮助输出对
  const help = spawnSync(process.execPath, [tool], { encoding: 'utf-8' });
  if (help.status !== 0 || !/repo-guard/.test(help.stdout ?? '')) {
    die(`冒烟①失败：产物跑不起来或帮助输出不对\n${help.stderr || help.stdout}`);
  }

  // ② layers/skills/standards 在包内的相对位置正确。
  //    在临时目录里跑（不带 --write，一个字节都不写），避免 findRepoRoot 走到本仓
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-guard-pack-'));
  try {
    const init = spawnSync(process.execPath, [tool, 'standards', 'init'], {
      encoding: 'utf-8',
      cwd: probe,
    });
    const out = `${init.stdout ?? ''}${init.stderr ?? ''}`;
    if (/找不到规范模板/.test(out)) {
      die(
        '冒烟②失败：包内找不到 layers/skills/standards/。\n' +
          '        bin/ 与 layers/ 必须是兄弟目录 —— 检查 MANIFEST 里的 layers 项。',
      );
    }
    if (init.status !== 0) die(`冒烟②失败：standards init 退出码 ${init.status}\n${out}`);
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }

  // ③ 59 条钩子回归。包内 verify-hooks.mjs 的 TOOL 默认就是同目录的 repo-guard
  const vh = spawnSync(process.execPath, [path.join(dstRoot, 'bin', 'verify-hooks.mjs')], {
    encoding: 'utf-8',
  });
  if (vh.status !== 0) {
    die(`冒烟③失败：钩子回归没过\n${(vh.stdout ?? '').split('\n').slice(-25).join('\n')}`);
  }
  const m = /(\d+)\s*\/\s*(\d+)/.exec(vh.stdout ?? '');
  return m ? `${m[1]}/${m[2]}` : '通过';
}

// ───────────── 主流程 ─────────────

function main() {
  const version = resolveVersion();
  const name = `repo-guard-${version}`;
  const outRoot = path.resolve(flag('--out') ?? path.join(ROOT, 'dist'));
  const dst = path.join(outRoot, name);

  if (!fs.existsSync(path.join(ROOT, 'bin', 'repo-guard'))) {
    die('bin/repo-guard 不存在。先跑 `npm run build`。');
  }

  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });

  const copied = [];
  const skipped = [];
  for (const item of MANIFEST) {
    if (!fs.existsSync(path.join(ROOT, item.src))) {
      if (item.required) die(`清单里的必需项不存在：${item.src}（${item.why}）`);
      skipped.push(item.src);
      continue;
    }
    copyInto(item.src, dst);
    copied.push(item.src);
  }

  assertNoStrays(dst);

  const smokeResult = SKIP_SMOKE ? '已跳过' : smoke(dst);

  // 归档。COPYFILE_DISABLE 挡掉 macOS 的 ._ AppleDouble 文件，
  // 否则 Linux 上解压会多出一堆 ._xxx，部门会以为包坏了
  let archive = null;
  if (!NO_ARCHIVE) {
    const tgz = path.join(outRoot, `${name}.tar.gz`);
    fs.rmSync(tgz, { force: true });
    const r = spawnSync('tar', ['-czf', tgz, '-C', outRoot, name], {
      stdio: 'inherit',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    if (r.status !== 0) die('tar 打包失败');
    archive = tgz;
  }

  const files = countFiles(dst);
  const kb = (
    fs.readdirSync(dst, { withFileTypes: true, recursive: true }).reduce((sum, e) => {
      if (!e.isFile()) return sum;
      return sum + fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size;
    }, 0) / 1024
  ).toFixed(0);

  console.log(`
[pack] repo-guard ${version}
       目录    ${path.relative(ROOT, dst)}/
       ${archive ? `归档    ${path.relative(ROOT, archive)}` : '归档    已跳过（--no-archive）'}
       内容    ${copied.length} 个顶层项，${files} 个文件，${kb} KB${skipped.length ? `\n       未带    ${skipped.join(' ')}（可选项，本仓没有）` : ''}
       冒烟    ${smokeResult}

       部门拿到之后：读 layers/CONFIG.md，填完跑 bin/repo-guard doctor。
`);
}

main();