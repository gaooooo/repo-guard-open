#!/usr/bin/env node
/**
 * 产物一致性矩阵 —— 新旧两份 repo-guard 喂同样输入，逐字节比 stdout。
 *
 * 为什么需要它：`bin/repo-guard` 的 CLI / hook / MCP 适配层**没有源码**
 * （deerclaw 工作区、git 历史、两个产物 zip 里都只有压缩产物）。源码版的这一层
 * 是按 `bin/verify-hooks.mjs` 的用例契约反推重写的，而 verify-hooks 只校验
 * verdict（deny / allow / context）三态，拦对了但文案、路径归一、退出码、
 * JSON 字段漂了它一概看不见。所以再加一道逐字节比对，把旧产物当成黄金样本。
 *
 * 用法：
 *   node build/verify-parity.mjs                      # bin/repo-guard vs build/baseline/repo-guard
 *   node build/verify-parity.mjs --tool <候选产物>
 *   node build/verify-parity.mjs --keep               # 保留临时仓库便于排查
 *   node build/verify-parity.mjs --case impact        # 只跑名字含 impact 的用例
 *
 * 隔离策略：
 *   两侧各拿一份**独立的** fixture 仓库和独立的 HOME。因为 `init --write` 会
 *   改仓库、MCP 的 impact 会往 $HOME 写会话状态，共用一份就会互相污染，
 *   而且后面的用例依赖前面用例造出来的配置（顺序有意义）。
 *   两侧跑完各自的完整序列，再成对比对输出。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURES, REDLINES, materialize } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);

const CAND = path.resolve(flag('--tool') ?? path.join(ROOT, 'bin', 'repo-guard'));
const BASE = path.resolve(flag('--baseline') ?? path.join(ROOT, 'build', 'baseline', 'repo-guard'));
const KEEP = argv.includes('--keep');
const ONLY = flag('--case');
/**
 * `--dump <目录>`：只跑基线，把每个用例的输出写成文件。
 * 反推重写适配层时要逐字对着基线的文案写，靠终端滚屏读不现实。
 * 这一步只读基线、不碰候选产物。
 */
const DUMP = flag('--dump');

for (const [label, p] of [['候选', CAND], ['基线', BASE]]) {
  if (!fs.existsSync(p)) {
    console.error(`找不到${label}产物：${p}`);
    process.exit(2);
  }
}

// ───────────────────────── fixture ─────────────────────────

/**
 * 两个 fixture：前端仓走 web-frontend 分析器，Go 仓走 go-gin。
 * 一个仓不可能同时是两种技术栈——registry 按置信度挑分析器，混在一起
 * 只会让 detect 结果不稳定，那比覆盖面不足更糟。
 */
// FIXTURES / REDLINES / materialize 见 build/fixtures.mjs（verify-viz 共用）

// ───────────────────────── 用例 ─────────────────────────

/**
 * 顺序有意义：`init --write` 之前跑的命令看到的是"未配置"分支，
 * 之后跑的才走"已配置"分支。两条分支都要覆盖，所以不排序、不并发。
 *
 * kind: 'cli'  → argv 直接跑，比 stdout + exitCode
 *       'mcp'  → stdin 灌 JSON-RPC，比 stdout
 *       'hook' → stdin 灌宿主 JSON，比 stdout
 */
const CASES = [
  // ── 未配置分支 ──
  { name: 'help', fixture: 'web', kind: 'cli', argv: [] },
  { name: 'init-dry', fixture: 'web', kind: 'cli', argv: ['init'] },
  { name: 'audit-unconfigured', fixture: 'web', kind: 'cli', argv: ['audit'] },
  { name: 'hook-session-start-unconfigured', fixture: 'web', kind: 'hook', hook: 'session-start', input: { session_id: 'p0' } },
  {
    name: 'hook-pre-write-unconfigured',
    fixture: 'web',
    kind: 'hook',
    hook: 'pre-write',
    input: { session_id: 'p0', tool_input: { file_path: 'src/components/Button/index.tsx' } },
  },

  // ── 生成配置 ──
  { name: 'init-write', fixture: 'web', kind: 'cli', argv: ['init', '--write'] },
  { name: 'artifact-repo-facts', fixture: 'web', kind: 'file', file: '.codebuddy/repo-facts.json' },
  { name: 'artifact-gitignore', fixture: 'web', kind: 'file', file: '.gitignore' },
  { name: 'init-write-idempotent', fixture: 'web', kind: 'cli', argv: ['init', '--write'] },

  // ── 已配置分支：体量与结构 ──
  { name: 'scan', fixture: 'web', kind: 'cli', argv: ['scan'] },
  { name: 'scan-json', fixture: 'web', kind: 'cli', argv: ['scan', '--json'] },

  // ── 图谱查询（真实建图，不是只跑 hook）──
  { name: 'impact-component', fixture: 'web', kind: 'cli', argv: ['impact', 'src/components/DataTable/index.tsx'] },
  { name: 'impact-util', fixture: 'web', kind: 'cli', argv: ['impact', 'src/utils/format.ts'] },
  // `@ABS@` 前缀会被替换成 fixture 的**真实路径**（realpath）。
  // 必须用 realpath：macOS 的 /var 是 /private/var 的符号链接，mkdtemp 给的是
  // /var/... 而 process.cwd() 返回 /private/var/...。用未解析的路径时旧产物会
  // 把仓库内的绝对路径判成"不在仓库里"（那是它的一个 bug），这条用例就退化成
  // 在比对一个错误行为。用 realpath 才是在真正校验"绝对路径能被接受"。
  { name: 'impact-abs', fixture: 'web', kind: 'cli', argv: ['impact', '@ABS@src/components/Button/index.tsx'] },
  { name: 'impact-outside', fixture: 'web', kind: 'cli', argv: ['impact', '/etc/hosts'] },
  { name: 'impact-missing', fixture: 'web', kind: 'cli', argv: ['impact', 'src/does/not/exist.ts'] },
  { name: 'hot', fixture: 'web', kind: 'cli', argv: ['hot'] },
  { name: 'hot-limit', fixture: 'web', kind: 'cli', argv: ['hot', '--limit', '3'] },
  { name: 'trace-page', fixture: 'web', kind: 'cli', argv: ['trace', '/users'] },
  { name: 'trace-detail', fixture: 'web', kind: 'cli', argv: ['trace', '/users/detail'] },
  { name: 'trace-api', fixture: 'web', kind: 'cli', argv: ['trace', '/api/users'] },
  { name: 'trace-missing', fixture: 'web', kind: 'cli', argv: ['trace', '/nope'] },
  { name: 'similar', fixture: 'web', kind: 'cli', argv: ['similar', '带分页和搜索的列表页'] },
  { name: 'lib-search', fixture: 'web', kind: 'cli', argv: ['lib', 'search', '多选下拉'] },
  { name: 'contracts', fixture: 'web', kind: 'cli', argv: ['contracts'] },
  { name: 'contracts-one', fixture: 'web', kind: 'cli', argv: ['contracts', '/api/users'] },
  // fixture 里每个接口只有 1 个调用点，默认 minCallSites=2 只会输出"没有可导出的"。
  // 把门槛降到 1 才能看到真正的类型草稿 —— 那段输出里有品牌名与免责声明，
  // 是这个命令最需要被守住的部分（人会把草稿直接当类型用）。
  { name: 'contracts-min1', fixture: 'web', kind: 'cli', argv: ['contracts', '--min-call-sites', '1'] },

  // ── check：退出码是契约的一部分 ──
  { name: 'check-public', fixture: 'web', kind: 'cli', argv: ['check', 'src/components/Button/index.tsx'] },
  { name: 'check-normal', fixture: 'web', kind: 'cli', argv: ['check', 'src/views/Detail/index.tsx'] },
  { name: 'check-many', fixture: 'web', kind: 'cli', argv: ['check', 'src/utils/format.ts', 'src/views/UserList/index.tsx'] },

  // ── 红线体检：三类腐烂 ──
  { name: 'redlines-write', fixture: 'web', kind: 'write', file: '.codebuddy/redlines.json', body: JSON.stringify(REDLINES, null, 2) },
  { name: 'audit', fixture: 'web', kind: 'cli', argv: ['audit'] },
  { name: 'check-redline-hit', fixture: 'web', kind: 'cli', argv: ['check', 'src/services/user.ts'] },

  // ── MCP ──
  { name: 'mcp-tools-list', fixture: 'web', kind: 'mcp', rpc: { method: 'tools/list', params: {} } },
  { name: 'mcp-initialize', fixture: 'web', kind: 'mcp', rpc: { method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'parity', version: '0' } } } },
  { name: 'mcp-impact', fixture: 'web', kind: 'mcp', rpc: { method: 'tools/call', params: { name: 'impact', arguments: { file: 'src/components/DataTable/index.tsx' } } } },
  { name: 'mcp-hot', fixture: 'web', kind: 'mcp', rpc: { method: 'tools/call', params: { name: 'hot', arguments: { limit: 3 } } } },
  { name: 'mcp-scan', fixture: 'web', kind: 'mcp', rpc: { method: 'tools/call', params: { name: 'scan', arguments: {} } } },
  { name: 'mcp-check', fixture: 'web', kind: 'mcp', rpc: { method: 'tools/call', params: { name: 'check', arguments: { files: ['src/services/user.ts'] } } } },
  { name: 'mcp-trace', fixture: 'web', kind: 'mcp', rpc: { method: 'tools/call', params: { name: 'trace', arguments: { urlPath: '/api/users' } } } },
  { name: 'mcp-similar', fixture: 'web', kind: 'mcp', rpc: { method: 'tools/call', params: { name: 'similar', arguments: { intent: '带分页和搜索的列表页' } } } },
  { name: 'mcp-lib-search', fixture: 'web', kind: 'mcp', rpc: { method: 'tools/call', params: { name: 'lib_search', arguments: { intent: '多选下拉' } } } },
  { name: 'mcp-audit', fixture: 'web', kind: 'mcp', rpc: { method: 'tools/call', params: { name: 'audit', arguments: {} } } },
  { name: 'mcp-contracts', fixture: 'web', kind: 'mcp', rpc: { method: 'tools/call', params: { name: 'contracts', arguments: {} } } },
  { name: 'mcp-contracts-min1', fixture: 'web', kind: 'mcp', rpc: { method: 'tools/call', params: { name: 'contracts', arguments: { minCallSites: 1 } } } },
  { name: 'mcp-unknown-tool', fixture: 'web', kind: 'mcp', rpc: { method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } } },
  { name: 'mcp-bad-args', fixture: 'web', kind: 'mcp', rpc: { method: 'tools/call', params: { name: 'impact', arguments: {} } } },

  // ── hook 文案（verify-hooks 只比三态，这里比逐字）──
  { name: 'hook-session-start', fixture: 'web', kind: 'hook', hook: 'session-start', input: { session_id: 'p1' } },
  {
    name: 'hook-pre-write-deny',
    fixture: 'web',
    kind: 'hook',
    hook: 'pre-write',
    input: { session_id: 'p1', tool_input: { file_path: 'src/components/Button/index.tsx' } },
  },
  {
    name: 'hook-pre-write-redline',
    fixture: 'web',
    kind: 'hook',
    hook: 'pre-write',
    input: { session_id: 'p1', tool_input: { file_path: 'src/services/user.ts' } },
  },
  {
    name: 'hook-pre-write-allow',
    fixture: 'web',
    kind: 'hook',
    hook: 'pre-write',
    input: { session_id: 'p1', tool_input: { file_path: 'src/views/Detail/index.tsx' } },
  },
  {
    name: 'hook-pre-write-prefix-dir',
    fixture: 'web',
    kind: 'hook',
    hook: 'pre-write',
    input: { session_id: 'p1', tool_input: { file_path: 'src/components-legacy/old.tsx' } },
  },
  {
    name: 'hook-pre-bash-write',
    fixture: 'web',
    kind: 'hook',
    hook: 'pre-bash',
    input: { session_id: 'p1', tool_input: { command: 'sed -i s/a/b/ src/utils/format.ts' } },
  },
  {
    name: 'hook-pre-bash-readonly',
    fixture: 'web',
    kind: 'hook',
    hook: 'pre-bash',
    input: { session_id: 'p1', tool_input: { command: 'grep -r foo src/utils/' } },
  },
  {
    name: 'hook-post-write-long',
    fixture: 'web',
    kind: 'hook',
    hook: 'post-write',
    input: { session_id: 'p1', tool_input: { file_path: 'src/components/Legacy/huge.tsx' } },
  },
  {
    name: 'hook-post-write-ok',
    fixture: 'web',
    kind: 'hook',
    hook: 'post-write',
    input: { session_id: 'p1', tool_input: { file_path: 'src/utils/format.ts' } },
  },
  { name: 'hook-session-end', fixture: 'web', kind: 'hook', hook: 'session-end', input: { session_id: 'p1' } },
  { name: 'hook-unknown', fixture: 'web', kind: 'hook', hook: 'no-such-hook', input: { session_id: 'p1' } },
  { name: 'hook-garbage', fixture: 'web', kind: 'hook', hook: 'pre-write', input: null, raw: 'not json at all' },

  // ── Go 仓：换一个分析器 ──
  { name: 'go-init-dry', fixture: 'go', kind: 'cli', argv: ['init'] },
  { name: 'go-init-write', fixture: 'go', kind: 'cli', argv: ['init', '--write'] },
  { name: 'go-artifact-repo-facts', fixture: 'go', kind: 'file', file: '.codebuddy/repo-facts.json' },
  { name: 'go-scan', fixture: 'go', kind: 'cli', argv: ['scan'] },
  { name: 'go-impact', fixture: 'go', kind: 'cli', argv: ['impact', 'internal/common/util.go'] },
  { name: 'go-impact-service', fixture: 'go', kind: 'cli', argv: ['impact', 'internal/service/user.go'] },
  { name: 'go-hot', fixture: 'go', kind: 'cli', argv: ['hot'] },
  { name: 'go-trace', fixture: 'go', kind: 'cli', argv: ['trace', '/api/users'] },
  { name: 'go-contracts', fixture: 'go', kind: 'cli', argv: ['contracts'] },
  {
    name: 'go-hook-pre-write',
    fixture: 'go',
    kind: 'hook',
    hook: 'pre-write',
    input: { session_id: 'g1', tool_input: { file_path: 'internal/common/util.go' } },
  },

  // ── 另外三个技术栈：只验「认得出 + 建得出图」──
  //
  // 每个仓跑 init（看识别到哪个分析器、图里有多少东西）+ init --write + impact
  //（验证真的有调用边，而不是一张空图）。
  //
  // ⚠️ python 那三条依赖机器上有 python3。没有的话分析器会明确报"暂不支持"
  //   而不是给空图 —— 那种情况这三条仍然会两侧一致地通过，只是没验到真建图。
  { name: 'java-init', fixture: 'java', kind: 'cli', argv: ['init'] },
  { name: 'java-init-write', fixture: 'java', kind: 'cli', argv: ['init', '--write'] },
  { name: 'java-artifact-facts', fixture: 'java', kind: 'file', file: '.codebuddy/repo-facts.json' },
  { name: 'java-impact', fixture: 'java', kind: 'cli', argv: ['impact', 'src/main/java/com/parity/common/Pager.java'] },
  { name: 'java-hot', fixture: 'java', kind: 'cli', argv: ['hot'] },

  { name: 'python-init', fixture: 'python', kind: 'cli', argv: ['init'] },
  { name: 'python-init-write', fixture: 'python', kind: 'cli', argv: ['init', '--write'] },
  { name: 'python-artifact-facts', fixture: 'python', kind: 'file', file: '.codebuddy/repo-facts.json' },
  { name: 'python-impact', fixture: 'python', kind: 'cli', argv: ['impact', 'app/common.py'] },
  { name: 'python-trace', fixture: 'python', kind: 'cli', argv: ['trace', '/api/users'] },

  { name: 'node-init', fixture: 'node', kind: 'cli', argv: ['init'] },
  { name: 'node-init-write', fixture: 'node', kind: 'cli', argv: ['init', '--write'] },
  { name: 'node-artifact-facts', fixture: 'node', kind: 'file', file: '.codebuddy/repo-facts.json' },
  { name: 'node-impact', fixture: 'node', kind: 'cli', argv: ['impact', 'src/common/util.js'] },
  { name: 'node-trace', fixture: 'node', kind: 'cli', argv: ['trace', '/api/users'] },
];

/**
 * 已知偏差 —— 明知与旧产物不同、且**有意保留**的用例。
 *
 * 加进这里必须写清两件事：差在哪、为什么不改回去。
 * 这个清单是给"下一个人"看的：没有它，后来者看到 DIFF 只会以为是自己写坏了，
 * 然后花半天去对齐一个我们已经判定过不该对齐的行为。
 *
 * ⚠️ 这里每加一条，parity 这道闸门就弱一点。加之前先问一遍：
 * 真的是旧产物不对，还是我懒得对齐？
 */
const KNOWN_DEVIATIONS = {
  'lib-search':
    '组件库检索的排序规则无法还原。逆向了 11 个查询仍拼不出旧产物的打分函数，' +
    '而且它自身自相矛盾：单字查询「树」「选」有结果，但「框」返回空 —— ' +
    '而「输入框」「多选框」「单选框」都含「框」。这更像是旧实现的缺陷而非设计。' +
    '本版用「oneLiner/名字子串命中 + 前缀命中加权 + 同义词表」，命中集合是超集，' +
    '排序不同。不阻塞交付：这是检索排序的启发式，不是行为契约。',
  'mcp-lib-search': '同 lib-search。',
  'mcp-tools-list':
    '几处有意的差异。① impact 多了可选参数 symbol（也接受 file#symbol）：引擎的 analyzeImpact 早就支持' +
    '方法级与字段级，只是 MCP 入参没透出来，AI 改一个 dto 字段只能拿到"整个文件波及 93 个接口"的放大结论。' +
    '② similar 的描述补上后端用法：后端仓没有页面指纹，旧描述让模型以为它只管前端页面，' +
    '而后端走的是方法家族检索（src/insight/similar-methods.ts）。不带 symbol 时 impact 的输出与旧产物逐字节一致。' +
    '③ similar 新增 resource / verbs / template、intent 不再必填：整句中文需求由模型拆成资源 + 动作再查，' +
    '否则「用户管理」会漏掉本仓叫 AIMUser 的现成实现。hot 新增可选 intent（按需求找现成方法）。',
  'contracts-min1':
    '两处有意的差异。① 署名：旧产物在类型草稿头部写"由 DeerClaw 从调用点反推"，' +
    '本版改成 repo-guard —— 这是个独立插件，署一个用户机器上不存在的产品名' +
    '只会让人怀疑这段代码是哪来的。② 旧产物的 CLI 不认 `--min-call-sites`，' +
    '把它的值当成了"只导这一条接口"的名字，于是静默返回空结果；本版修了这个 bug。' +
    'MCP 侧的 `--min-call-sites` 两者一致，差的只有署名。',
  'mcp-contracts-min1': '署名：DeerClaw → repo-guard。同 contracts-min1 的第 ① 条。',
  help:
    '帮助里多了若干条旧产物没有的命令（治理留痕、七道门、研发规范、部门红线、配置体检…）。' +
    '⚠️ 这是第一处「parity 妨碍了正确改动」的例子 —— 帮助文本天然会随功能增长，' +
    '把它锁在旧产物上等于禁止加命令。所以登记偏差，而不是把命令藏起来不让人发现。' +
    '这里**有意不枚举命令名**：枚举会随每次加命令而过时，' +
    '而一条过时的偏差说明比没有说明更误导人。',
  'hook-session-start':
    'SessionStart 的注入里多了一段「仓库红线摘要」（只有 id 与一句话，正文在命中时才给）。' +
    '旧产物只注入公共层清单。为什么保留这个差异：红线是**用户已经写下的配置**' +
    '（.codebuddy/redlines.json），它本来就在被硬拦使用；把摘要提前推给模型' +
    '能让它主动避开，而不是撞上去再被拦。deerclaw 侧红线摘要一直是【推】。' +
    '⚠️ 这不违反「空配置零行为变化」—— 那条约束管的是 .codebuddy/guard/ 引入的新门；' +
    '没写 redlines.json 的仓库这一段是空的，输出与旧产物逐字节相同（见 ' +
    'hook-session-start-unconfigured 与 verify-hooks 的 S1 用例）。',
  'hook-pre-write-deny':
    '拒绝文案改了：旧产物只说「请先调用 impact 工具」，新版给出三种调法' +
    '（mcp__repo-guard__impact / 斜杠命令 / CLI），并明确禁止用代码搜索代替。' +
    '⚠️ 这是**真机实测逼出来的改动**：插件 MCP 工具在宿主里的真名带命名空间' +
    '（mcp__repo-guard__impact），模型按 `impact` 去 ToolSearch 搜不到，' +
    '于是判定"工具不存在"，改用 grep 凑了个影响面还自称"可能不完整"—— ' +
    '守卫拦住了，却把它推向了一个更差的替代方案。' +
    '文案冗余在这里是对的：模型少一条路就会去发明一条。',
  'hook-pre-write-redline': '同 hook-pre-write-deny。',
};

// ───────────────────────── 跑一侧 ─────────────────────────

/**
 * 把易变量抹平。只抹"每次跑都不一样"的东西，绝不抹业务字段——
 * 抹多了会把真实漂移一起抹掉，那这道闸门就白设了。
 */
function normalize(text, { repoDir, homeDir }) {
  return (
    text
      // 绝对路径：两侧 fixture 在不同 tmpdir，必须归一
      .split(repoDir)
      .join('<REPO>')
      .split(homeDir)
      .join('<HOME>')
      .split(fs.realpathSync(os.tmpdir()))
      .join('<TMP>')
      .split(os.tmpdir())
      .join('<TMP>')
      // 耗时
      .replace(/\b\d+(\.\d+)?\s?ms\b/g, '<MS>')
      .replace(/\b\d+(\.\d+)?\s?s\b/g, '<S>')
      .replace(/\d+(\.\d+)?\s?(秒|毫秒)/g, '<DUR>')
      .replace(/"buildMs"\s*:\s*\d+/g, '"buildMs":<MS>')
      .replace(/"durationMs"\s*:\s*\d+/g, '"durationMs":<MS>')
      // 时间戳
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<TS>')
      .replace(/"(builtAt|generatedAt|at|ts)"\s*:\s*\d{10,}/g, '"$1":<TS>')
      .replace(/\b1[6-9]\d{11}\b/g, '<TS>')
      // git sha（fixture 固定了时间，理论上一致；仍归一以防 git 版本差异）
      .replace(/\b[0-9a-f]{40}\b/g, '<SHA40>')
      .replace(/\b[0-9a-f]{12}\b/g, '<SHA12>')
      .replace(/\b[0-9a-f]{7}\b/g, '<SHA7>')
      // node 版本号出现在异常栈里
      .replace(/Node\.js v[\d.]+/g, 'Node.js <VER>')
  );
}

function runSide(tool, label) {
  const repos = {};
  // 随机的是**父目录**，fixture 自己的目录名两侧必须一模一样：
  // `init` 会把仓库名（basename）打进报告，名字不同就成了假 diff。
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `rg-parity-${label}-`));
  const homeDir = path.join(sandbox, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  for (const name of Object.keys(FIXTURES)) {
    repos[name] = path.join(sandbox, name);
    fs.mkdirSync(repos[name], { recursive: true });
    materialize(repos[name], FIXTURES[name]);
  }

  const out = {};
  for (const c of CASES) {
    if (ONLY && !c.name.includes(ONLY)) continue;
    const repoDir = repos[c.fixture];
    const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, CODEBUDDY_SESSION_ID: `parity-${c.name}` };
    const ctx = { repoDir, homeDir };

    if (c.kind === 'write') {
      const f = path.join(repoDir, c.file);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, c.body);
      out[c.name] = { text: '<written>', code: 0 };
      continue;
    }

    if (c.kind === 'file') {
      const f = path.join(repoDir, c.file);
      out[c.name] = fs.existsSync(f)
        ? { text: normalize(fs.readFileSync(f, 'utf-8'), ctx), code: 0 }
        : { text: '<missing>', code: -1 };
      continue;
    }

    let args;
    let stdin = '';
    if (c.kind === 'cli') {
      args = c.argv.map((a) =>
        a.startsWith('@ABS@') ? path.join(fs.realpathSync(repoDir), a.slice(5)) : a,
      );
    } else if (c.kind === 'mcp') {
      args = ['mcp'];
      stdin = `${JSON.stringify({ jsonrpc: '2.0', id: 1, ...c.rpc })}\n`;
    } else {
      args = ['hook', c.hook];
      stdin = c.raw ?? JSON.stringify({ cwd: repoDir, ...c.input });
    }

    const r = spawnSync(process.execPath, [tool, ...args], {
      cwd: repoDir,
      input: stdin,
      encoding: 'utf-8',
      env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
    out[c.name] = {
      text: normalize((r.stdout ?? '') + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : ''), ctx),
      code: r.status,
    };
  }

  return { out, repos, homeDir, sandbox };
}

/**
 * MCP 长连接存活检查 —— 不走 parity 比对，是个独立的硬断言。
 *
 * ── 为什么要单独做这一条 ──
 * 真机装载时踩过：MCP server 实现成"一次读完 stdin 再处理"，而 stdio MCP 的
 * 宿主写完 `initialize` 就等响应、**不关闭 stdin**。于是宿主等回复、server 等 EOF，
 * 双方僵死，界面上永远显示"服务仍在连接中"，9 个工具一个都不出现。
 *
 * 这个 bug 在 parity 里**测不出来**：`printf ... | repo-guard mcp` 的管道写完
 * 就 EOF，同步读立刻返回，所有用例照常通过。只有"写入但不关闭"才能复现。
 *
 * 所以这里显式模拟宿主：写一帧、等、再写一帧、再等，两帧都得有回复。
 */
async function checkMcpAlive(tool) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [tool, 'mcp'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    const frame = (o) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);

    frame({ id: 1, method: 'initialize', params: {} });
    setTimeout(() => {
      const first = out.includes('"id":1');
      frame({ id: 2, method: 'tools/list', params: {} });
      setTimeout(() => {
        const second = out.includes('"id":2');
        const toolCount = (out.match(/"name":"[a-z_]+"/g) ?? []).length;
        p.kill();
        resolve({
          ok: first && second && toolCount >= 9,
          detail:
            `initialize=${first ? '有回复' : '**无回复（死锁）**'}` +
            ` tools/list=${second ? '有回复' : '**无回复**'} 工具数=${toolCount}`,
        });
      }, 1200);
    }, 800);
  });
}

// ───────────────────────── 比对与报告 ─────────────────────────

console.log(`\n产物一致性矩阵`);
console.log(`  基线  ${BASE}`);
if (!DUMP) console.log(`  候选  ${CAND}`);
console.log('');

if (DUMP) {
  const dir = path.resolve(DUMP);
  fs.mkdirSync(dir, { recursive: true });
  const only = runSide(BASE, 'dump');
  for (const [name, r] of Object.entries(only.out)) {
    fs.writeFileSync(path.join(dir, `${name}.txt`), `# exit=${r.code}\n${r.text}`);
  }
  fs.rmSync(only.sandbox, { recursive: true, force: true });
  console.log(`基线输出已写入 ${dir}（${Object.keys(only.out).length} 个用例）\n`);
  process.exit(0);
}

const b = runSide(BASE, 'base');
const c = runSide(CAND, 'cand');

const names = CASES.map((x) => x.name).filter((n) => n in b.out || n in c.out);
let pass = 0;
let known = 0;
const diffs = [];

for (const n of names) {
  const B = b.out[n] ?? { text: '<absent>', code: -99 };
  const C = c.out[n] ?? { text: '<absent>', code: -99 };
  const ok = B.text === C.text && B.code === C.code;
  if (ok) pass++;
  else if (KNOWN_DEVIATIONS[n]) known++;
  else diffs.push({ n, B, C });
}

console.log('| 用例 | 结果 |');
console.log('|---|---|');
for (const n of names) {
  const bad = diffs.find((d) => d.n === n);
  const dev = !bad && b.out[n] && c.out[n] && b.out[n].text !== c.out[n].text;
  console.log(`| ${n} | ${bad ? '**DIFF**' : dev ? '已知偏差' : 'same'} |`);
}
console.log(`\n${pass}/${names.length} 逐字节一致${known ? `，${known} 个已知偏差` : ''}\n`);

if (known) {
  console.log('已知偏差（有意保留）：');
  for (const n of names) {
    if (KNOWN_DEVIATIONS[n] && b.out[n]?.text !== c.out[n]?.text) {
      console.log(`  · ${n}\n      ${KNOWN_DEVIATIONS[n]}`);
    }
  }
  console.log('');
}

/** 只打前 3 处差异的前 40 行 —— 一次性倒出 60 个 diff 没人看 */
for (const d of diffs.slice(0, 3)) {
  console.log(`── ${d.n} ──`);
  if (d.B.code !== d.C.code) console.log(`  退出码：基线 ${d.B.code} → 候选 ${d.C.code}`);
  const bl = d.B.text.split('\n');
  const cl = d.C.text.split('\n');
  let shown = 0;
  for (let i = 0; i < Math.max(bl.length, cl.length) && shown < 40; i++) {
    if (bl[i] !== cl[i]) {
      console.log(`  第 ${i + 1} 行`);
      console.log(`    基线: ${JSON.stringify(bl[i] ?? '<无>')}`);
      console.log(`    候选: ${JSON.stringify(cl[i] ?? '<无>')}`);
      shown++;
    }
  }
  console.log('');
}
if (diffs.length > 3) console.log(`（还有 ${diffs.length - 3} 处差异，用 --case <名字> 单看）\n`);

if (KEEP) {
  console.log('临时目录保留：');
  console.log(`  基线 ${b.sandbox}`);
  console.log(`  候选 ${c.sandbox}`);
} else {
  for (const v of [b.sandbox, c.sandbox]) {
    fs.rmSync(v, { recursive: true, force: true });
  }
}

// MCP 长连接存活 —— 只查候选产物（基线那份本来就是死锁的）
const alive = await checkMcpAlive(CAND);
console.log(`MCP 长连接存活：${alive.ok ? '✓' : '**✗**'}  ${alive.detail}`);
if (!alive.ok) {
  console.log(
    '  MCP server 必须边读边回、并在 stdin 不关闭时保持存活。\n' +
      '  一次读完 stdin 再处理会与宿主僵死 —— 宿主等回复、server 等 EOF。\n' +
      '  这个 bug 在管道测试里测不出来（管道写完就 EOF）。\n',
  );
}
console.log('');

process.exit(diffs.length === 0 && alive.ok ? 0 : 1);
