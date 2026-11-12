/**
 * repo-guard link —— 把 repo-guard 命令放到终端可用的位置。
 *
 * 插件市场安装后，插件的 bin/ 不在 PATH 上（宿主只给 --plugin-dir 加载的插件注入 PATH），
 * 而 init、status、check 和 husky 里的合并门都要在终端里调用它。
 * 这里写一个启动器：每次运行时从宿主的已安装插件记录里找最新的 repo-guard，
 * 找不到就用 link 时的这份。插件升级后不用重新 link。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pluginPath } from '../runtime/paths.js';

function launcher(fallback: string): string {
  return [
    "#!/usr/bin/env node",
    "// repo-guard 启动器（repo-guard link 生成）：在已安装的插件与 link 时的路径中选版本最高的那份",
    "// （项目级安装只在当前目录属于该项目时才算）",
    "const fs = require('fs'), path = require('path'), os = require('os');",
    "const fallback = __FALLBACK__;",
    "const ver = (bin) => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(bin), '..', '.codebuddy-plugin', 'plugin.json'), 'utf8')).version || '0'; } catch (e) { return '0'; } };",
    "const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };",
    "const cands = fs.existsSync(fallback) ? [fallback] : [];",
    "try {",
    "  const cfg = process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy');",
    "  const j = JSON.parse(fs.readFileSync(path.join(cfg, 'plugins', 'installed_plugins.json'), 'utf8'));",
    "  const cwd = fs.realpathSync(process.cwd());",
    "  for (const [k, v] of Object.entries(j.plugins || {})) {",
    "    if (!k.startsWith('repo-guard@') || !Array.isArray(v)) continue;",
    "    for (const e of v) {",
    "      if (!e || !e.installPath) continue;",
    "      if (e.scope === 'project' && e.projectPath) { let p = e.projectPath; try { p = fs.realpathSync(p); } catch (x) {} if (cwd !== p && !cwd.startsWith(p + path.sep)) continue; }",
    "      const c = path.join(e.installPath, 'bin', 'repo-guard');",
    "      if (fs.existsSync(c)) cands.push(c);",
    "    }",
    "  }",
    "} catch (e) {}",
    "if (!cands.length) { console.error('找不到 repo-guard：插件可能已卸载。重新安装插件后运行 repo-guard link'); process.exit(2); }",
    "cands.sort((a, b) => cmp(ver(b), ver(a)));",
    "require(cands[0]);",
    "",
  ].join('\n').replace('__FALLBACK__', JSON.stringify(fallback));
}

export function runLink(argv: string[]): { text: string; code: number } {
  const i = argv.indexOf('--dir');
  const dir = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.join(os.homedir(), '.local', 'bin');
  // 真实入口取打包产物自己的位置：经启动器运行时 argv[1] 是启动器
  const self = fs.realpathSync(pluginPath('bin', 'repo-guard'));
  const target = path.join(dir, 'repo-guard');
  // 已经是启动器自己在跑：取它记的回退路径没有意义，直接用当前真实入口
  let current = '';
  try {
    current = fs.readFileSync(target, 'utf-8');
  } catch {
    /* 还没有 */
  }
  if (current && !current.includes('repo-guard 启动器')) {
    return { text: target + ' 已存在且不是 repo-guard 启动器，没有覆盖。用 --dir 指定别的目录。', code: 2 };
  }
  const fallback = self;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, launcher(fallback));
  fs.chmodSync(target, 0o755);
  const onPath = (process.env.PATH ?? '').split(path.delimiter).some((p) => path.resolve(p) === dir);
  const L = ['已写入启动器  ' + target, '              每次运行时自动使用最新安装的 repo-guard，插件升级后不用重新 link'];
  if (!onPath) {
    const rc = (process.env.SHELL ?? '').endsWith('zsh') ? '~/.zshrc' : '~/.bashrc';
    L.push('', '⚠ ' + dir + ' 不在 PATH 上。执行下面这行后重开终端：', '  echo \'export PATH="' + dir + ':$PATH"\' >> ' + rc);
  } else L.push('', '现在可以直接在终端里运行 repo-guard init / status / check。');
  return { text: L.join('\n'), code: 0 };
}