/** 本机图谱安装信息，不进入业务仓，也不属于规则配置。 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stateRoot, readJson, writeJson } from '../runtime/paths.js';

export interface AtlasBinding {
  node: string;
  bin: string;
  version?: string;
  workspaces?: Record<string, string>;
}

export const bindingFile = () => path.join(stateRoot(), 'atlas.json');

export function resolveBinding(): AtlasBinding {
  const bin = process.env.REPO_GUARD_ATLAS_BIN?.trim();
  const node = process.env.REPO_GUARD_ATLAS_NODE?.trim() || process.execPath;
  if (bin) return validatePaths({ node, bin: path.resolve(bin) });
  if (fs.existsSync(bindingFile())) {
    const saved = readJson<AtlasBinding>(bindingFile());
    if (!saved) throw new Error('图谱绑定不是合法 JSON，请重新执行 repo-guard atlas bind <工具包目录>');
    return validatePaths(saved);
  }
  // 仅未绑定时发现 PATH 安装；显式绑定损坏不得退回另一版本。
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, process.platform === 'win32' ? 'atlas.cmd' : 'atlas');
    if (!fs.existsSync(candidate)) continue;
    if (process.platform === 'win32') {
      const npmBin = path.join(dir, 'node_modules', '@tencent', 'code-atlas', 'bin', 'atlas');
      if (fs.existsSync(npmBin)) return validatePaths({ node, bin: npmBin });
      continue;
    }
    return validatePaths({ node, bin: fs.realpathSync(candidate) });
  }
  throw new Error('未找到 code-atlas。安装工具包后执行 repo-guard atlas bind <工具包目录>');
}

function validatePaths(binding: AtlasBinding): AtlasBinding {
  for (const [label, file] of [['Node', binding.node], ['Atlas', binding.bin]]) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(label + ' 绑定路径失效：' + String(file) + '。请重新执行 repo-guard atlas bind');
    }
  }
  return binding;
}

export function bindAtlas(packagePath?: string, node = process.execPath): AtlasBinding {
  let binding: AtlasBinding;
  if (packagePath) {
    const root = path.resolve(packagePath);
    const bin = fs.statSync(root).isDirectory() ? path.join(root, 'bin', 'atlas') : root;
    binding = validatePaths({ node: path.resolve(node), bin: fs.realpathSync(bin) });
  } else binding = resolveBinding();
  const r = spawnSync(binding.node, [binding.bin, 'version', '--json'], { encoding: 'utf-8', timeout: 5000 });
  if (r.error || r.status !== 0) throw new Error(r.error?.message || r.stderr || 'code-atlas 版本检查失败');
  const version = JSON.parse(r.stdout) as { kind?: string; version?: string };
  if (version.kind !== 'version' || typeof version.version !== 'string') throw new Error('该入口不是支持 JSON 契约的 code-atlas');
  const previous = readJson<AtlasBinding>(bindingFile());
  binding = { ...binding, version: version.version, workspaces: previous?.workspaces ?? {} };
  writeJson(bindingFile(), binding);
  return binding;
}

export function selectedWorkspace(cwd: string): string | undefined {
  const selections = readJson<AtlasBinding>(bindingFile())?.workspaces ?? {};
  const abs = path.resolve(cwd);
  return Object.entries(selections)
    .filter(([root]) => abs === root || abs.startsWith(root + path.sep))
    .sort(([a], [b]) => b.length - a.length)[0]?.[1];
}

export function rememberWorkspace(repos: string[], workspace: string): void {
  const binding = readJson<AtlasBinding>(bindingFile());
  if (!binding) return;
  const workspaces = { ...binding.workspaces };
  for (const repo of repos) workspaces[fs.realpathSync(repo)] = workspace;
  writeJson(bindingFile(), { ...binding, workspaces });
}
