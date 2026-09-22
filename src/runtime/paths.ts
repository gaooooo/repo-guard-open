/**
 * 路径解析 —— 所有"文件在哪"的问题都收口在这里。
 *
 * 三个独立的路径域，混用会出事：
 *   ① 被守护的仓库      cwd 或 hook 输入里的 cwd，往上找 .git / package.json
 *   ② 仓库内的配置与缓存  <repo>/.codebuddy/，配置进 git、缓存不进
 *   ③ 本机状态与埋点      $HOME/.repo-guard/，跨仓跨会话
 *
 * ── 为什么状态一定要放 $HOME 而不是仓库里 ──
 * 会话状态（"这一轮查过哪些文件"）和埋点是**跨仓、跨会话的个人数据**，
 * 写进被守护的仓库会污染 `git status`。这个插件的全部价值建立在"不干扰人"之上，
 * 让人每次 `git status` 看到一堆插件产生的脏文件，卸载只是时间问题。
 *
 * ── 为什么用 process.env.HOME 而不是 os.homedir() ──
 * `os.homedir()` 在 macOS/Linux 上读的是 passwd 数据库，**不受 HOME 环境变量影响**。
 * 而 `bin/verify-hooks.mjs` 靠覆盖 HOME 来隔离测试状态（每次跑都是干净的临时目录），
 * 用 homedir() 会让隔离失效 —— 测试会读写你真实的 ~/.repo-guard，
 * 上一次跑留下的"查过了"状态会让下一次的 deny 用例假通过。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 仓库内的配置目录名。与宿主共用 —— 用户的 rules / settings 也在这里 */
export const CONFIG_DIR = '.codebuddy';
/** 图谱缓存子目录。不进 git（`init --write` 会追加到 .gitignore） */
export const CACHE_DIR = `${CONFIG_DIR}/.cache`;

/**
 * 插件包根目录。产物打包后 `__dirname` 指向 `bin/`，所以往上一级。
 * 作者面 `layers/`、宿主发现面 `skills/` 都挂在这一层。
 */
export function pluginRoot(): string {
  return path.resolve(__dirname, '..');
}

/** 插件包内文件。例：`pluginPath('layers', 'redlines', 'redlines.json')` */
export function pluginPath(...parts: string[]): string {
  return path.join(pluginRoot(), ...parts);
}

/** 往上找仓库根的锚点。按优先级 —— .git 最可信 */
const ROOT_ANCHORS = ['.git', 'package.json', 'go.mod', 'pom.xml', 'build.gradle', 'pyproject.toml'];

/**
 * 从一个起点往上找仓库根。
 *
 * 找不到就返回起点本身，**不抛异常** —— 在临时目录、裸目录里跑也得能用，
 * 大不了图谱是空的。这个工具任何一处失败都必须退化成"什么都不做"，
 * 而不是把人挡在外面。
 */
export function findRepoRoot(start: string): string {
  let cur = path.resolve(start);
  for (let i = 0; i < 40; i++) {
    for (const anchor of ROOT_ANCHORS) {
      try {
        if (fs.existsSync(path.join(cur, anchor))) return cur;
      } catch {
        /* 权限问题：当没找到处理 */
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(start);
}

/**
 * 仓库的稳定标识。用来给**存在仓库外面**的状态加上仓库维度。
 *
 * ── 为什么需要它 ──
 * 仓库内的配置与缓存靠路径天然隔离（`<repo>/.codebuddy/`），但会话状态放在
 * `$HOME/.repo-guard/`（原因见本文件顶部），它的 key 是**仓库相对路径**。
 * 两个仓库都有 `src/index.ts` 时 key 就撞了 —— 查过 A 仓那个会让 B 仓那个直接放行，
 * 守卫方向性地从"多拦"变成"漏拦"。这是唯一一处不能靠路径隔离的状态。
 *
 * ── 为什么带上目录名而不是纯 hash ──
 * 状态文件是要给人看的（排查"为什么这个文件被拦"时会直接 cat）。
 * 纯 hash 的 key 谁都读不懂，带上目录名就能一眼认出是哪个仓。
 *
 * ── 为什么先 realpath ──
 * 同一个仓库，hook 进程与 MCP 进程算出的路径可能一个带 `/private` 一个不带
 *（macOS 的 `/var` 是符号链接）。不归一就会算出两个 id，
 * 于是「MCP 里查过」和「hook 里判定」又对不上，回到死循环。
 *
 * ── 为什么不用 node:crypto ──
 * 产物的 require 列表是被 DESIGN.md 7.1 钉住的独立性论证的一部分。
 * 这里只需要"同一路径得同一短串"，FNV-1a 足够，不值得为它扩大依赖面。
 */
export function repoId(repoDir: string): string {
  const real = realpathOrSelf(repoDir);
  // FNV-1a 32 位。`>>> 0` 保证走无符号，否则 JS 的位运算会给出负数
  let h = 0x811c9dc5;
  for (let i = 0; i < real.length; i++) {
    h = ((h ^ real.charCodeAt(i)) * 0x01000193) >>> 0;
  }
  const hash = h.toString(16).padStart(8, '0');
  const name = path.basename(real).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 24) || 'repo';
  return `${name}-${hash}`;
}

/** `<repo>/.codebuddy/<sub>` */
export function configPath(repoDir: string, ...sub: string[]): string {
  return path.join(repoDir, CONFIG_DIR, ...sub);
}

/** `<repo>/.codebuddy/.cache/<sub>` */
export function cachePath(repoDir: string, ...sub: string[]): string {
  return path.join(repoDir, CONFIG_DIR, '.cache', ...sub);
}

/**
 * 本机状态根目录。
 *
 * HOME 缺失时退到 /tmp：CI 容器、某些宿主拉起方式下 HOME 确实可能为空，
 * 那时状态是一次性的（"查过了"只在本会话内有意义），丢了不影响正确性 ——
 * 只会让守卫更严（多拦一次），这个方向的失败是安全的。
 */
export function stateRoot(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return path.join(home, '.repo-guard');
}

/** 组件库 d.ts 解析结果的本机缓存目录 */
export function libraryPackRoot(): string {
  return path.join(stateRoot(), 'library-packs');
}

/**
 * 把任意形态的路径归一成"仓库根相对、posix 分隔"。
 *
 * 返回 null 表示**不在仓库里** —— 调用方必须按"不管"处理，不能当成仓库内路径。
 * 这条是 verify-hooks 的 T2 用例（`/etc/hosts` 必须放行）：
 * 守卫越界去拦仓库外的文件，就成了"AI 什么都干不了"。
 */
export function toRepoRelative(repoDir: string, raw: string): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;

  // 先按绝对路径试。realpath 两边都做 —— macOS 的 /var 是 /private/var 的符号链接，
  // 宿主给的路径和我们解析出来的仓库根可能一个带 /private 一个不带，
  // 不归一就会把仓库内的文件判成"仓库外"，守卫直接失效。
  const abs = path.isAbsolute(s) ? s : path.resolve(repoDir, s);
  const root = realpathOrSelf(repoDir);
  const target = realpathOrSelf(abs);

  const rel = path.relative(root, target);
  // `..` 开头 = 跳出了仓库；path.isAbsolute = 完全不同的盘（Windows）
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * 解析符号链接，但**容忍路径还不存在**。
 *
 * ── 为什么必须容忍 ──
 * 写工具最常见的一种入参就是"还不存在的文件"（新建）。而 `fs.realpathSync`
 * 对不存在的路径直接抛异常。
 *
 * ── 为什么要一路往上找，而不是只退一层 ──
 * 新建文件常常连**父目录都不存在**（`src/views/new-page/index.tsx`）。
 * 只退一层的话，`new-page` 也不存在 → realpath 再次失败 → 拿到一个未解析的路径，
 * 再去和已解析的仓库根比较，就会算出 `../../..` 从而把仓库内的文件
 * **误判成仓库外**。后果是 `pre-write` 跳过全部门禁、静默放行 ——
 * 而这恰恰是新建文件类门禁（新建页面必须先查 similar）要管的场景。
 *
 * 所以：一路往上找到第一个真实存在的祖先，realpath 它，再把剩下的段拼回去。
 */
function realpathOrSelf(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;

  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break; // 到根了还不存在（不可能，但别死循环）
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return abs;
}

/**
 * 本产物自己的绝对路径。
 *
 * ── 为什么需要它 ──
 * 拒绝文案里要告诉模型"去跑 repo-guard impact xxx"。但**裸命令 `repo-guard`
 * 不一定可用**：宿主只把 `--plugin-dir` 加载的插件的 `bin/` 注入 PATH
 *（实现里读的是 `pluginDir`），市场安装的插件不注入。
 * 官方文档那句「启用插件时此目录中的文件可作为裸命令调用」只在前一种模式下成立。
 *
 * 真机实测踩过这个：文案给了 `repo-guard impact <file>`，模型跑完得到
 * `command not found`，然后得出结论"这不是命令行工具"，转而用 grep 凑影响面。
 * 又一次"守卫拦住了，却把模型推向更差的替代方案"。
 *
 * 所以给绝对路径。两种安装方式下都对。
 */
export function selfPath(): string {
  // argv[1] 是被执行的脚本路径。`node bin/repo-guard` 与 `./bin/repo-guard`
  // 两种调法下都是它
  const fromArgv = process.argv[1];
  if (fromArgv && fromArgv.trim()) {
    try {
      return fs.realpathSync(fromArgv);
    } catch {
      return path.resolve(fromArgv);
    }
  }
  // 兜底：打包成 CJS 之后 __filename 就是产物自己
  return typeof __filename === 'string' ? __filename : 'repo-guard';
}

/** 读 JSON，任何失败都返回 null。配置坏了不能让工具崩 */
export function readJson<T>(file: string): T | null {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as T) : null;
  } catch {
    return null;
  }
}

/** 写 JSON（2 空格缩进 + 尾换行），自动建父目录 */
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
