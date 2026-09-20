#!/usr/bin/env node
/**
 * 钩子回归矩阵 —— 按宿主契约给钩子灌 JSON，跑完出报告。
 *
 * 证明两件事：**拦得对**，而且**不误伤**。
 * 第二件比第一件重要 —— 误伤会让人直接卸载。
 *
 * ── 三个阶段 ──
 *   A 基线（21 条）  没有 guard 配置。其中 20 条是**行为契约**，
 *                    自源码版改造前就存在，任何改动都不许动它们；
 *                    G3 是后补的多仓隔离契约（同名文件不许跨仓互相放行）
 *   B 七道门（26 条） 铺上 guard 配置并打开各道门，逐门验拦得对 + 不误伤
 *   C 回归（4 条）    删掉 guard 配置，重跑 A 的代表用例。
 *                    **这一阶段是「空配置零行为变化」的唯一证据** ——
 *                    一道门"默认关"但仍改变了输出，等于所有人被迫升级
 *
 * 用法：node verify-hooks.mjs [--tool <引擎路径>] [--keep] [--only <阶段>]
 * 自建一个临时 git 仓库当被测对象，不碰任何真实仓库。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const TOOL = flag('--tool') ?? path.join(HERE, 'repo-guard');
const KEEP = argv.includes('--keep');
const ONLY = flag('--only');

if (!fs.existsSync(TOOL)) {
  console.error(`找不到引擎：${TOOL}\n用 --tool <路径> 指定`);
  process.exit(2);
}

// ───────────── 搭一个临时仓库 ─────────────

const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-guard-verify-'));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-guard-home-'));

function w(rel, body) {
  const f = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}
function rm(rel) {
  fs.rmSync(path.join(REPO, rel), { recursive: true, force: true });
}

spawnSync('git', ['init', '-q', '.'], { cwd: REPO });
w('src/components/Existing/index.tsx', 'export const A = 1;\n');
w('src/components/Existing/big.tsx', 'x\n'.repeat(600));
w('src/components-legacy/old.tsx', 'export const B = 1;\n');
w('src/views/page/index.tsx', 'export const P = 1;\n');
w('src/utils/helper.ts', 'export const h = 1;\n');
// 给 L1 结构化删除判定用：里面有个受保护标识符，出现 2 次
w('src/utils/chain.ts', 'export const CHAIN_STATUS = 1;\nexport const useChain = () => CHAIN_STATUS;\n');
// 给 L1 禁改清单用
w('src/legacy/frozen.ts', 'export const dontTouch = 1;\n');
w('.codebuddy/repo-facts.json', JSON.stringify({
  version: 1, analyzer: 'web-frontend',
  publicLayer: ['src/components/', 'src/utils/'],
  componentLibrary: null, lineLimit: 500, generatedAt: new Date().toISOString(),
}, null, 2));
w('.codebuddy/redlines.json', JSON.stringify({
  rules: [
    { id: 'RL-001', paths: ['src/components/Existing/**'],
      rule: '这个组件有外部调用方，改名等于让对方 404', confirmed: true },
    { id: 'RL-002', paths: ['src/utils/chain.ts'], protects: ['CHAIN_STATUS'],
      rule: '上链状态常量不能删', reason: '下游对账系统按它判定', confirmed: true },
  ],
}, null, 2));

// ── 第二个仓库：只给多仓隔离用例（G3）用 ──
//
// 会话状态放在 $HOME 而不是仓库里（原因见 runtime/paths.ts），而它的 key 是
// **仓库相对路径**。两个仓库都有 `src/components/Existing/index.tsx` 时，
// key 不带仓库维度就会撞：在 A 仓查过影响面，写 B 仓那个同名文件就被放行 ——
// 守卫方向性地从"多拦"变成"漏拦"。这个方向的失败是不可接受的，所以钉一条用例。
const REPO2 = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-guard-verify2-'));
function w2(rel, body) {
  const f = path.join(REPO2, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}
spawnSync('git', ['init', '-q', '.'], { cwd: REPO2 });
w2('src/components/Existing/index.tsx', 'export const A2 = 2;\n');
w2('.codebuddy/repo-facts.json', JSON.stringify({
  version: 1, analyzer: 'web-frontend',
  publicLayer: ['src/components/', 'src/utils/'],
  componentLibrary: null, lineLimit: 500, generatedAt: new Date().toISOString(),
}, null, 2));

// ───────────── 跑钩子 ─────────────

/**
 * 判定归一成四态：
 *   deny           拦住了
 *   context        放行但注入了提醒
 *   continue-false 阻止停止、驱动继续（Stop 钩子专有）
 *   allow          什么都没输出
 */
function hook(name, input, env = {}) {
  const r = spawnSync(process.execPath, [TOOL, 'hook', name], {
    input: typeof input === 'string' ? input : JSON.stringify({ cwd: REPO, ...input }),
    encoding: 'utf-8',
    env: { ...process.env, HOME, ...env },
  });
  const out = (r.stdout || '').trim();
  if (!out) return { verdict: 'allow', reason: '' };
  try {
    const parsed = JSON.parse(out);
    if (parsed.continue === false) {
      return { verdict: 'continue-false', reason: parsed.reason ?? '' };
    }
    const o = parsed.hookSpecificOutput ?? {};
    return {
      verdict: o.permissionDecision === 'deny' ? 'deny'
        : o.additionalContext ? 'context' : (o.permissionDecision ?? 'allow'),
      reason: o.permissionDecisionReason ?? o.additionalContext ?? '',
    };
  } catch {
    return { verdict: 'parse-error', reason: out.slice(0, 200) };
  }
}

/** 让 MCP 记一次已查 —— 模拟 AI 真的调了某个图谱工具 */
function mcpCall(sid, name, args) {
  spawnSync(process.execPath, [TOOL, 'mcp'], {
    input: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
    }) + '\n',
    encoding: 'utf-8', cwd: REPO,
    env: { ...process.env, HOME, CODEBUDDY_SESSION_ID: sid },
  });
}
const recordImpact = (sid, file) => mcpCall(sid, 'impact', { file });

// ───────────── 用例 ─────────────

const cases = [];
let phase = 'A';
const add = (id, desc, want, got) => cases.push({ phase, id, desc, want, got });

const S = 'verify-session';

// ══════════════════ 阶段 A · 基线 21 条（无 guard 配置）══════════════════
//
// 其中 20 条是行为契约，它们从源码版改造之前就存在，任何改动都不许动。
// G3 是后补的：多仓下同名文件不许跨仓互相放行。

add('P1', '公共层已有文件，未查影响面', 'deny',
  hook('pre-write', { session_id: S, tool_input: { file_path: 'src/components/Existing/index.tsx' } }));
add('P2', '公共层另一目录（utils）同样拦', 'deny',
  hook('pre-write', { session_id: S, tool_input: { file_path: 'src/utils/helper.ts' } }));
add('A1', '绝对路径指向同一文件，仍然拦', 'deny',
  hook('pre-write', { session_id: S, tool_input: { file_path: path.join(REPO, 'src/components/Existing/index.tsx') } }));
add('K1', 'NotebookEdit 走 notebook_path', 'deny',
  hook('pre-write', { session_id: S, tool_input: { notebook_path: 'src/components/Existing/index.tsx' } }));

add('N1', '普通页面文件放行', 'allow',
  hook('pre-write', { session_id: S, tool_input: { file_path: 'src/views/page/index.tsx' } }));
add('N2', '新建公共层文件放行', 'allow',
  hook('pre-write', { session_id: S, tool_input: { file_path: 'src/components/BrandNew/index.tsx' } }));
add('T1', '不误伤同名前缀目录 components-legacy', 'allow',
  hook('pre-write', { session_id: S, tool_input: { file_path: 'src/components-legacy/old.tsx' } }));
add('T2', '仓库外路径放行', 'allow',
  hook('pre-write', { session_id: S, tool_input: { file_path: '/etc/hosts' } }));

const G = 'verify-queried';
recordImpact(G, 'src/components/Existing/index.tsx');
add('G1', '查过 impact 之后，同一文件放行', 'allow',
  hook('pre-write', { session_id: G, tool_input: { file_path: 'src/components/Existing/index.tsx' } }));
add('G2', '查过的不能放行另一个文件', 'deny',
  hook('pre-write', { session_id: G, tool_input: { file_path: 'src/components/Existing/big.tsx' } }));
add('G3', '在另一个仓查过，不放行本仓的同名文件', 'deny',
  hook('pre-write', { cwd: REPO2, session_id: G, tool_input: { file_path: 'src/components/Existing/index.tsx' } }));

add('B1', 'shell 写公共层 → 提醒但不拦', 'context',
  hook('pre-bash', { session_id: S, tool_input: { command: 'sed -i s/a/b/ src/components/x.tsx' } }));
add('B2', '只读命令不提醒', 'allow',
  hook('pre-bash', { session_id: S, tool_input: { command: 'grep -r foo src/components/' } }));
add('B3', 'shell 动非公共层不提醒', 'allow',
  hook('pre-bash', { session_id: S, tool_input: { command: 'sed -i s/a/b/ src/views/page/index.tsx' } }));

add('W1', '写完超长文件 → 提醒', 'context',
  hook('post-write', { session_id: S, tool_input: { file_path: 'src/components/Existing/big.tsx' } }));
add('W2', '正常长度文件不提醒', 'allow',
  hook('post-write', { session_id: S, tool_input: { file_path: 'src/components/Existing/index.tsx' } }));

add('S1', '会话开始注入公共层清单', 'context',
  hook('session-start', { session_id: S }));

// 未配置 → 必须 fail-open
fs.renameSync(path.join(REPO, '.codebuddy/repo-facts.json'), path.join(REPO, 'facts.bak'));
add('F1', '没有配置时不拦（fail-open）', 'allow',
  hook('pre-write', { session_id: 'f', tool_input: { file_path: 'src/components/Existing/index.tsx' } }));
add('F2', '没有配置时会话开始明确提示', 'context',
  hook('session-start', { session_id: 'f' }));
fs.renameSync(path.join(REPO, 'facts.bak'), path.join(REPO, '.codebuddy/repo-facts.json'));

// 坏输入 → 绝不能崩
add('E1', '空输入不崩', 'allow', hook('pre-write', {}));
add('E2', '缺 tool_input 不崩', 'allow', hook('pre-write', { session_id: S }));

// ══════════════════ 阶段 B · 七道门 ══════════════════

phase = 'B';

/** 铺一份 guard 配置。只写要用到的那几个文件，其余走默认（关） */
function writeGuard(patch) {
  const files = {
    'guard.json': {
      version: 1,
      gates: {
        L0_inject: { enabled: true },
        L1_admission: { enabled: true },
        L3_loop: { enabled: true },
        L4_signals: { enabled: true },
        L5_delivery: { enabled: true },
        L6_governance: { enabled: true },
      },
    },
    'identity/charter.json': {
      mission: '验证用的项目',
      facts: ['这条事实应该出现在注入里'],
      discipline: ['不许谎报已测'],
    },
    'capability/project-knowledge.json': {
      items: [{ id: 'PK-1', topic: '状态机', content: '订单状态不许跳步', enabled: true }],
    },
    'capability/task-routes.json': {
      routes: {
        payment: {
          match: ['支付', '对账'],
          required: ['docs/payment.md'],
          hard_gate: '改支付前必须读完 required',
          enabled: true,
        },
      },
    },
    'constraint/taboos.json': { items: ['不要为了让测试过而改断言'] },
    'constraint/no-refactor.json': {
      entries: [{ path: 'src/legacy/**', reason: '历史 hack，没测试', confirmed: true }],
    },
    'constraint/scope-gate.json': { enabled: false, allowlist: [], maxFiles: null },
    'process/graph-enforce.json': {
      newPageSimilar: { enabled: false, pathPatterns: [] },
      newComponentHot: { enabled: false, pathPatterns: [] },
      newComponentLibSearch: { enabled: false, pathPatterns: [] },
    },
    'process/loop.json': {
      enabled: true,
      repeatToolCallThreshold: 3,
      consecutiveFailThreshold: 3,
      sameFileWriteFailThreshold: 2,
      maxIterations: 80,
    },
    'process/delivery.json': {
      enabled: true,
      engineeringCheck: { enabled: false, mode: 'warn' },
      deliveryBudget: { enabled: false, maxDeliveryFiles: null },
      evidencePatterns: [],
    },
    'process/restate.json': { enabled: false },
    ...patch,
  };
  for (const [rel, body] of Object.entries(files)) {
    w(`.codebuddy/guard/${rel}`, JSON.stringify(body, null, 2));
  }
}

writeGuard({});

// ── L0 注入面 ──
const l0 = hook('session-start', { session_id: 'l0' });
add('L0-1', '会话开始注入章程/知识/禁忌', 'context', l0);
add('L0-2', '注入里含项目事实', 'yes',
  { verdict: l0.reason.includes('这条事实应该出现在注入里') ? 'yes' : 'no', reason: l0.reason });
add('L0-3', '注入里含项目知识', 'yes',
  { verdict: l0.reason.includes('订单状态不许跳步') ? 'yes' : 'no', reason: l0.reason });
add('L0-4', '注入里含禁忌', 'yes',
  { verdict: l0.reason.includes('不要为了让测试过而改断言') ? 'yes' : 'no', reason: l0.reason });
add('L0-5', '注入里含红线摘要', 'yes',
  { verdict: l0.reason.includes('RL-001') ? 'yes' : 'no', reason: l0.reason });

add('L0-6', '压缩后重注入', 'context', hook('post-compact', { session_id: 'l0' }));

const route = hook('user-prompt-submit', { session_id: 'l0', prompt: '帮我改一下支付回调的逻辑' });
add('L0-7', '任务路由命中「支付」→ 注入必读', 'context', route);
add('L0-8', '必读清单里含 required 文件', 'yes',
  { verdict: route.reason.includes('docs/payment.md') ? 'yes' : 'no', reason: route.reason });
add('L0-9', '任务路由不命中 → 不注入', 'allow',
  hook('user-prompt-submit', { session_id: 'l0', prompt: '把这个按钮改成蓝色' }));

// ── L1 红线硬拦（结构化删除）──
// Edit 删掉受保护标识符：before 有 2 处，after 只剩 1 处 → 必须拦
add('L1-1', 'Edit 删掉受保护标识符 → 拦', 'deny',
  hook('pre-write', {
    session_id: 'l1a',
    tool_input: {
      file_path: 'src/utils/chain.ts',
      old_string: 'export const CHAIN_STATUS = 1;\n',
      new_string: '',
    },
  }));
// 同一个文件、不碰受保护标识符 → 不该被红线拦（还会被公共层守卫拦，所以先查一次）
recordImpact('l1b', 'src/utils/chain.ts');
add('L1-2', 'Edit 不碰受保护标识符 → 红线不拦', 'allow',
  hook('pre-write', {
    session_id: 'l1b',
    tool_input: {
      file_path: 'src/utils/chain.ts',
      old_string: 'export const useChain = () => CHAIN_STATUS;',
      new_string: 'export const useChain = () => CHAIN_STATUS; // 注释',
    },
  }));
// Write 全量覆盖，内容里没有受保护标识符 → 拦
add('L1-3', 'Write 全量覆盖丢掉受保护标识符 → 拦', 'deny',
  hook('pre-write', {
    session_id: 'l1c',
    tool_input: { file_path: 'src/utils/chain.ts', content: 'export const other = 1;\n' },
  }));

// ── L1 禁改清单 ──
add('L1-4', '写禁改清单里的路径 → 拦', 'deny',
  hook('pre-write', { session_id: 'l1d', tool_input: { file_path: 'src/legacy/frozen.ts', content: 'x' } }));
add('L1-5', '禁改清单外的普通文件 → 放行', 'allow',
  hook('pre-write', { session_id: 'l1d', tool_input: { file_path: 'src/views/page/index.tsx', content: 'x' } }));

// ── L1 范围门 ──
writeGuard({ 'constraint/scope-gate.json': { enabled: true, allowlist: ['src/views/'], maxFiles: null } });
add('L1-6', 'allowlist 外的路径 → 拦', 'deny',
  hook('pre-write', { session_id: 'l1e', tool_input: { file_path: 'src/utils/helper.ts' } }));
add('L1-7', 'allowlist 内的路径 → 放行', 'allow',
  hook('pre-write', { session_id: 'l1e', tool_input: { file_path: 'src/views/page/index.tsx' } }));

writeGuard({ 'constraint/scope-gate.json': { enabled: true, allowlist: [], maxFiles: 2 } });
const budgetSid = 'l1f';
hook('pre-write', { session_id: budgetSid, tool_input: { file_path: 'src/views/a.tsx' } });
hook('pre-write', { session_id: budgetSid, tool_input: { file_path: 'src/views/b.tsx' } });
add('L1-8', '文件数超预算 → 拦', 'deny',
  hook('pre-write', { session_id: budgetSid, tool_input: { file_path: 'src/views/c.tsx' } }));
add('L1-9', '预算内已改过的文件 → 仍放行', 'allow',
  hook('pre-write', { session_id: budgetSid, tool_input: { file_path: 'src/views/a.tsx' } }));

// ── L1 图谱强制 ──
writeGuard({
  'constraint/scope-gate.json': { enabled: false, allowlist: [], maxFiles: null },
  'process/graph-enforce.json': {
    newPageSimilar: { enabled: true, pathPatterns: ['src/views/'] },
    newComponentHot: { enabled: false, pathPatterns: [] },
    newComponentLibSearch: { enabled: true, pathPatterns: ['src/components/'] },
  },
});
add('L1-10', '新建页面未查 similar → 拦', 'deny',
  hook('pre-write', { session_id: 'l1g', tool_input: { file_path: 'src/views/newpage/index.tsx' } }));
mcpCall('l1h', 'similar', { intent: '带分页的列表页' });
add('L1-11', '查过 similar 后新建页面 → 放行', 'allow',
  hook('pre-write', { session_id: 'l1h', tool_input: { file_path: 'src/views/newpage/index.tsx' } }));
add('L1-12', '新建组件未查组件库 → 拦', 'deny',
  hook('pre-write', { session_id: 'l1i', tool_input: { file_path: 'src/components/New/index.tsx' } }));
add('L1-13', '**已存在**的页面不受新建规则约束', 'allow',
  hook('pre-write', { session_id: 'l1j', tool_input: { file_path: 'src/views/page/index.tsx' } }));

// ── L3 循环门 ──
writeGuard({
  'process/graph-enforce.json': {
    newPageSimilar: { enabled: false, pathPatterns: [] },
    newComponentHot: { enabled: false, pathPatterns: [] },
    newComponentLibSearch: { enabled: false, pathPatterns: [] },
  },
});
const rep = 'l3a';
const repInput = { session_id: rep, tool_name: 'Write', tool_input: { file_path: 'src/views/loop.tsx', content: 'x' } };
for (let i = 0; i < 3; i++) hook('post-write', repInput);
add('L3-1', '同一调用重复 3 次 → 拦', 'deny', hook('pre-write', repInput));
add('L3-2', '换一个文件 → 不受重复计数影响', 'allow',
  hook('pre-write', { session_id: rep, tool_name: 'Write', tool_input: { file_path: 'src/views/other.tsx', content: 'x' } }));

const fail = 'l3b';
for (let i = 0; i < 3; i++) {
  hook('post-fail', { session_id: fail, tool_name: 'Bash', tool_input: { command: 'npm run nope' } });
}
add('L3-3', '连续失败 3 次 → 拦', 'deny',
  hook('pre-write', { session_id: fail, tool_input: { file_path: 'src/views/page/index.tsx' } }));
// 成功一次要清零 —— 漏了这一步"连续失败"就变成了"累计失败"
hook('post-write', { session_id: fail, tool_name: 'Write', tool_input: { file_path: 'src/views/ok.tsx' }, tool_response: { success: true } });
add('L3-4', '成功一次后连续失败计数清零 → 放行', 'allow',
  hook('pre-write', { session_id: fail, tool_input: { file_path: 'src/views/page/index.tsx' } }));

// ── L5 交付门 ──
writeGuard({
  'process/loop.json': { enabled: false, repeatToolCallThreshold: 3, consecutiveFailThreshold: 3, sameFileWriteFailThreshold: 2, maxIterations: 80 },
  'process/delivery.json': {
    enabled: true,
    engineeringCheck: { enabled: true, mode: 'warn' },
    deliveryBudget: { enabled: false, maxDeliveryFiles: null },
    evidencePatterns: [],
  },
});
const del = 'l5a';
hook('pre-write', { session_id: del, tool_input: { file_path: 'src/views/page/index.tsx' } });
add('L5-1', '改了文件但没跑校验 → Stop 提醒', 'context', hook('stop', { session_id: del }));
add('L5-2', '同一 reason 每会话只提醒一次（防死循环）', 'allow', hook('stop', { session_id: del }));

const del2 = 'l5b';
hook('pre-write', { session_id: del2, tool_input: { file_path: 'src/views/page/index.tsx' } });
hook('pre-bash', { session_id: del2, tool_input: { command: 'npm run lint' } });
add('L5-3', '跑过 lint → Stop 不提醒', 'allow', hook('stop', { session_id: del2 }));

add('L5-4', '什么都没改 → Stop 不提醒', 'allow', hook('stop', { session_id: 'l5c' }));

writeGuard({
  'process/delivery.json': {
    enabled: true,
    engineeringCheck: { enabled: true, mode: 'block' },
    deliveryBudget: { enabled: false, maxDeliveryFiles: null },
    evidencePatterns: [],
  },
});
const del3 = 'l5d';
hook('pre-write', { session_id: del3, tool_input: { file_path: 'src/views/page/index.tsx' } });
add('L5-5', 'mode=block 且无证据 → 阻止停止', 'continue-false', hook('stop', { session_id: del3 }));

// ── 需求复述 ──
writeGuard({ 'process/restate.json': { enabled: true } });
add('R-1', '指代不明 → 提醒', 'context',
  hook('user-prompt-submit', { session_id: 'r1', prompt: '帮我把那个组件重构一下，顺便把样式也统一起来' }));
add('R-2', '太短的提问 → 跳过', 'allow',
  hook('user-prompt-submit', { session_id: 'r1', prompt: '改个颜色' }));
add('R-3', '纯提问 → 跳过', 'allow',
  hook('user-prompt-submit', { session_id: 'r1', prompt: '为什么这个组件会重复渲染两次呢？' }));

// ══════════════════ 阶段 C · 删掉 guard 配置，验零行为变化 ══════════════════

phase = 'C';
rm('.codebuddy/guard');

add('Z1', '删掉 guard 后：公共层守卫仍拦', 'deny',
  hook('pre-write', { session_id: 'z', tool_input: { file_path: 'src/components/Existing/index.tsx' } }));
add('Z2', '删掉 guard 后：普通文件仍放行', 'allow',
  hook('pre-write', { session_id: 'z', tool_input: { file_path: 'src/views/page/index.tsx' } }));
add('Z3', '删掉 guard 后：Stop 不再有任何输出', 'allow', hook('stop', { session_id: 'z' }));
add('Z4', '删掉 guard 后：提问不再注入', 'allow',
  hook('user-prompt-submit', { session_id: 'z', prompt: '帮我改一下支付回调的逻辑，顺便把那个组件也调整下' }));

// ───────────── 报告 ─────────────

const rows = cases
  .filter((c) => !ONLY || c.phase === ONLY.toUpperCase())
  .map((c) => ({ ...c, ok: c.got.verdict === c.want }));
const pass = rows.filter((r) => r.ok).length;

const PHASE_LABEL = {
  A: '阶段 A · 基线契约（无 guard 配置）',
  B: '阶段 B · 七道门',
  C: '阶段 C · 删掉 guard，验零行为变化',
};

console.log(`\n钩子回归矩阵 · ${pass}/${rows.length} 通过\n`);
let cur = '';
for (const r of rows) {
  if (r.phase !== cur) {
    cur = r.phase;
    console.log(`\n**${PHASE_LABEL[cur]}**\n`);
    console.log('| 用例 | 场景 | 期望 | 实际 | 结果 |');
    console.log('|---|---|---|---|---|');
  }
  console.log(`| ${r.id} | ${r.desc} | ${r.want} | ${r.got.verdict} | ${r.ok ? 'PASS' : '**FAIL**'} |`);
}

const failed = rows.filter((r) => !r.ok);
if (failed.length) {
  console.log('\n失败详情：\n');
  for (const f of failed.slice(0, 6)) {
    console.log(`── ${f.id} ${f.desc}`);
    console.log(`   期望 ${f.want}，实际 ${f.got.verdict}`);
    if (f.got.reason) console.log(`   输出：${f.got.reason.slice(0, 300)}`);
    console.log('');
  }
}

const denied = rows.find((r) => r.want === 'deny' && r.ok && r.phase === 'A');
if (denied) {
  console.log(`\n拒绝文案抽样（${denied.id}）：\n`);
  console.log(denied.got.reason.split('\n').map((l) => `    ${l}`).join('\n'));
}

if (!KEEP) {
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.rmSync(REPO2, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
} else {
  console.log(`\n临时仓库保留在 ${REPO}\n第二个仓库保留在 ${REPO2}\nHOME 保留在 ${HOME}`);
}

console.log('');
process.exit(pass === rows.length ? 0 : 1);
