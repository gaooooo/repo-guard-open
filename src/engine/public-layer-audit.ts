/**
 * 公共层路径存在性校验。
 *
 * 错配没有任何外部表现：守卫 fail-open，路径在仓里不存在时看起来和
 *「本次改动不涉及公共层」一模一样。必须在保存约定 / 下发 get_project_context
 * 时把「仓里一个文件都匹配不到」的路径明确标出来。
 *
 * 判据是文件系统：路径本身是文件，或目录下至少有一个文件（跳过 .git / node_modules）。
 * 以前按自带图谱的入图文件判，图谱迁到 code-atlas 后不再依赖图谱 —— 配置目录
 *（etc/*.yaml）本来就不入图，原实现也是退到「目录在工作区存在就算配上了」。
 */
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['.git', 'node_modules']);

export function normalizePublicLayerPrefix(pattern: string): string {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  return p.endsWith('/') ? p : `${p}/`;
}

/** 目录下有没有文件。广度优先，最多看 5000 个目录项，够判「空不空」 */
function hasAnyFile(dir: string): boolean {
  const queue = [dir];
  let budget = 5000;
  while (queue.length && budget > 0) {
    const cur = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (--budget <= 0) break;
      if (e.isFile()) return true;
      if (e.isDirectory() && !SKIP.has(e.name)) queue.push(path.join(cur, e.name));
    }
  }
  return false;
}

/** 该路径在仓里是否有至少 1 个文件（路径本身或目录下）。 */
export function patternHitsRepo(repoDir: string, pattern: string): boolean {
  const raw = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw) return false;
  const target = path.join(repoDir, raw.replace(/\/$/, ''));
  try {
    const st = fs.statSync(target);
    return st.isFile() || (st.isDirectory() && hasAnyFile(target));
  } catch {
    return false;
  }
}

export function patternsMissingFromRepo(repoDir: string, patterns: string[]): string[] {
  return patterns.filter((p) => p.trim() && !patternHitsRepo(repoDir, p.trim()));
}

export function missingPublicLayerWarning(missing: string[]): string | null {
  if (!missing.length) return null;
  return (
    `公共层路径在仓库里找不到任何文件（目录不存在或为空）：${missing.join('、')}。` +
    '守卫按这些路径判定，配了等于没配，而且 SessionStart 会注入误导性指令。请改成仓库里真实存在的目录。'
  );
}
