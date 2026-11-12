#!/usr/bin/env node
/**
 * v2 过程控制回归：单一配置、任务契约、写时控制、改动回执、init、合并门。
 * 自建临时 git 仓库与 HOME，不碰真实仓库。atlas 用不存在的绑定隔离（图谱相关项走降级路径）。
 *
 * 用法：node bin/verify-control.mjs [--tool <引擎路径>] [--keep]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const TOOL = argv.includes('--tool') ? argv[argv.indexOf('--tool') + 1] : path.join(HERE, 'repo-guard');
const KEEP = argv.includes('--keep');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-control-'));
const HOME = path.join(ROOT, 'home');
fs.mkdirSync(HOME);
// 隔离 atlas：绑定指向不存在的文件 → 图谱不可用，验证降级路径
const ENV = { ...process.env, HOME, REPO_GUARD_ATLAS_BIN: path.join(ROOT, 'no-atlas'), ATLAS_HOME: path.join(ROOT, 'atlas') };

function mkrepo(name, files) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', '.'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir });
  for (const [rel, body] of Object.entries(files)) w(dir, rel, body);
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}
function w(dir, rel, body) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}
function cli(cwd, args, extra = {}) {
  return spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf-8', env: { ...ENV, ...extra } });
}
function hook(cwd, name, input) {
  const r = spawnSync(process.execPath, [TOOL, 'hook', name], { input: JSON.stringify({ cwd, ...input }), encoding: 'utf-8', env: ENV });
  const out = (r.stdout || '').trim();
  if (!out) return { verdict: 'allow', text: '', system: '' };
  const j = JSON.parse(out);
  const o = j.hookSpecificOutput ?? {};
  const verdict = j.continue === false ? 'continue-false' : o.permissionDecision === 'deny' ? 'deny' : o.permissionDecision === 'ask' ? 'ask' : o.additionalContext ? 'context' : j.systemMessage ? 'system' : 'allow';
  return { verdict, text: j.reason ?? o.permissionDecisionReason ?? o.additionalContext ?? '', system: j.systemMessage ?? '' };
}
function mcp(cwd, sid, name, args) {
  const r = spawnSync(process.execPath, [TOOL, 'mcp'], {
    cwd, encoding: 'utf-8', env: { ...ENV, CODEBUDDY_SESSION_ID: sid },
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
  });
  return JSON.parse(r.stdout.trim().split('\n')[0]).result.content[0].text;
}

const cases = [];
const add = (id, desc, ok, detail = '') => cases.push({ id, desc, ok: !!ok, detail });

// ───────────── 仓库 ─────────────
const GO = {
  'go.mod': 'module example.com/x\n\ngo 1.22\n',
  'Makefile': 'lint:\n\tgo vet ./...\ntest:\n\tgo test ./...\n',
  'internal/logic/agent/list.go': 'package agent\n\nfunc List(a int) int {\n\treturn a\n}\n',
  'router/agent.go': 'package router\n',
  'internal/pkg/util/fmt.go': 'package util\n\nfunc Fmt(s string) string { return s }\n',
  'api/gen/x.pb.go': 'package gen\n',
  '.husky/pre-commit': 'npx lint-staged\n',
};
const repo = mkrepo('go', GO);

// ① 未接入：零行为变化
add('N1', '未接入 v2：写第 2 个文件不要求契约', (() => {
  hook(repo, 'pre-write', { session_id: 'n', tool_name: 'Edit', tool_input: { file_path: 'router/agent.go' } });
  hook(repo, 'post-write', { session_id: 'n', tool_name: 'Edit', tool_input: { file_path: 'router/agent.go' } });
  return hook(repo, 'pre-write', { session_id: 'n', tool_name: 'Edit', tool_input: { file_path: 'internal/pkg/util/fmt.go' } }).verdict === 'allow';
})());
add('N2', '未接入 v2：Stop 不出回执', hook(repo, 'stop', { session_id: 'n' }).verdict === 'allow');

// ② init
const plan = JSON.parse(cli(repo, ['init', '--plan', '--json']).stdout);
add('I1', 'init --plan --json 识别验收命令（Makefile）', plan.verify.some((c) => c.value === 'make test'), JSON.stringify(plan.verify));
add('I2', 'init --plan 建议生成代码红线并默认勾选', plan.redlines.some((r) => r.glob === '**/*.pb.go' && r.checked));
add('I3', 'init --plan 识别已有 husky、默认不算已安装', plan.gates.some((g) => g.kind === 'husky' && !g.installed));
add('I4', 'init --plan 列出全部控制点（告知）', plan.controls.length === 8);
add('I5', 'init --plan 不写任何文件', !fs.existsSync(path.join(repo, '.codebuddy/repo-guard.json')));
const yes = cli(repo, ['init', '--yes']);
add('I6', 'init --yes 写入 .codebuddy/repo-guard.json', yes.status === 0 && fs.existsSync(path.join(repo, '.codebuddy/repo-guard.json')), yes.stderr);
add('I7', 'init --yes 不碰 husky（共享文件默认不勾）', fs.readFileSync(path.join(repo, '.husky/pre-commit'), 'utf-8') === 'npx lint-staged\n');
const cfg0 = fs.readFileSync(path.join(repo, '.codebuddy/repo-guard.json'), 'utf-8');
const full = JSON.parse(cfg0);
add('I12', '项目配置写全部可调项（预算、范围、复用、验证、默认命令红线、内置基线说明）',
  full.budget?.funcLines === 60 && full.task?.scope === 'remind' && full.reuse?.beforeNew === 'remind' && full.verify?.onStop === 'remind' &&
  full.redlines?.commands?.length === 4 && full.redlines?.content?.length === 5 && Array.isArray(full.redlines?.fields) && Array.isArray(full.baseline?._builtin), cfg0);
cli(repo, ['init', '--yes']);
add('I8', '再次 init 不覆盖已有配置', fs.readFileSync(path.join(repo, '.codebuddy/repo-guard.json'), 'utf-8') === cfg0);
const mg = cli(repo, ['init', '--merge-gate', 'husky']);
const husky = fs.readFileSync(path.join(repo, '.husky/pre-commit'), 'utf-8');
add('I9', 'init --merge-gate husky 在已有 hook 后追加一行', mg.status === 0 && husky.startsWith('npx lint-staged\n') && /repo-guard check --staged/.test(husky), mg.stdout + mg.stderr);
cli(repo, ['init', '--merge-gate', 'husky']);
add('I10', '重复加合并门不加两遍', (fs.readFileSync(path.join(repo, '.husky/pre-commit'), 'utf-8').match(/repo-guard check/g) || []).length === 1);
const st = cli(repo, ['status']).stdout;
add('I11', 'status 列出档位、契约、红线、合并门', /总档位\s+remind/.test(st) && /任务契约\s+auto/.test(st) && /\.husky\/pre-commit/.test(st), st);
spawnSync('git', ['add', '-A'], { cwd: repo });
spawnSync('git', ['commit', '-qm', 'rg'], { cwd: repo });

// ③ 会话
const S = 'v2a';
const ss = hook(repo, 'session-start', { session_id: S });
add('S1', 'SessionStart 注入开发基线', /开发基线/.test(ss.text) && /guard_task/.test(ss.text), ss.text);
add('S2', 'init 后首个会话 systemMessage 告知启用了什么', /repo-guard 已启用/.test(ss.system), ss.system);
add('S3', '第二个会话不再告知', !hook(repo, 'session-start', { session_id: 'v2b' }).system);
add('S4', '没有公共层时不注入「公共层（未配置）」', !/公共层目录：（未配置）/.test(ss.text));

add('C1', '第 1 个文件：不要求契约', hook(repo, 'pre-write', { session_id: S, tool_name: 'Edit', tool_input: { file_path: 'internal/logic/agent/list.go' } }).verdict === 'allow');
w(repo, 'internal/logic/agent/list.go', 'package agent\n\nfunc List(a int) int {\n\treturn a + 1\n}\n');
hook(repo, 'post-write', { session_id: S, tool_name: 'Edit', tool_input: { file_path: 'internal/logic/agent/list.go' } });
add('C2', '测试文件不计入第 2 个文件', hook(repo, 'pre-write', { session_id: S, tool_name: 'Write', tool_input: { file_path: 'internal/logic/agent/list_test.go' } }).verdict === 'allow');
const c3 = hook(repo, 'pre-write', { session_id: S, tool_name: 'Edit', tool_input: { file_path: 'router/agent.go' } });
add('C3', '第 2 个文件没有契约 → 拒绝一次并指明 guard_task', c3.verdict === 'deny' && /mcp__plugin_repo_guard_repo_guard__guard_task/.test(c3.text), c3.text);
add('C4', '只拒绝一次', hook(repo, 'pre-write', { session_id: S, tool_name: 'Edit', tool_input: { file_path: 'router/agent.go' } }).verdict === 'allow');
const t1 = mcp(repo, S, 'guard_task', { goal: '列表按时间筛选', nonGoals: ['不改分页'], scope: ['internal/logic/agent/**', 'router/agent.go'], verify: ['make test'] });
add('C5', 'guard_task 回显契约', /契约已记录/.test(t1) && /internal\/logic\/agent/.test(t1), t1);
const t2 = mcp(repo, S, 'guard_task', { goal: '列表按时间筛选', scope: ['internal/logic/agent/**', 'router/agent.go', 'internal/pkg/**'] });
add('C6', '扩范围不写理由 → 拒绝', /需要在 reason 里写明理由/.test(t2), t2);
add('C7', '每轮提问注入契约摘要', /当前任务契约：列表按时间筛选/.test(hook(repo, 'user-prompt-submit', { session_id: S, prompt: '继续' }).text));

w(repo, 'router/agent.go', 'package router\n\nfunc Register(a, b, c, d, e, f int) {\n\tif a > 0 {\n\t\tfor i := 0; i < b; i++ {\n\t\t\tif i > c {\n\t\t\t\tif d > 0 {\n\t\t\t\t\tif e > 0 {\n\t\t\t\t\t\tprintln(f)\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n');
const cx = hook(repo, 'post-write', { session_id: S, tool_name: 'Edit', tool_input: { file_path: 'router/agent.go' } });
add('W1', '新函数超参数 / 嵌套阈值 → 写后提醒', cx.verdict === 'context' && /6个参数/.test(cx.text) && /5层嵌套/.test(cx.text), cx.text);
add('W2', '同一函数同一问题只提醒一次', hook(repo, 'post-write', { session_id: S, tool_name: 'Edit', tool_input: { file_path: 'router/agent.go' } }).verdict === 'allow');
add('W3', 'remind 档越界写前不拦', hook(repo, 'pre-write', { session_id: S, tool_name: 'Edit', tool_input: { file_path: 'internal/pkg/util/fmt.go' } }).verdict === 'allow');
w(repo, 'internal/pkg/util/fmt.go', 'package util\n\n// Fmt formats\nfunc Fmt(s string) string {  return s }\n');
const sc = hook(repo, 'post-write', { session_id: S, tool_name: 'Edit', tool_input: { file_path: 'internal/pkg/util/fmt.go' } });
add('W4', 'remind 档越界 → 写后提醒并要求撤回或扩范围', sc.verdict === 'context' && /不在本次任务契约范围/.test(sc.text), sc.text);
const rl = hook(repo, 'pre-write', { session_id: S, tool_name: 'Edit', tool_input: { file_path: 'api/gen/x.pb.go' } });
add('R1', '红线 block → 拒绝（不受 remind 档约束）', rl.verdict === 'deny' && /\*\*\/\*\.pb\.go/.test(rl.text));
add('R2', '默认命令红线 git push --force → 弹窗', hook(repo, 'pre-bash', { session_id: S, tool_name: 'Bash', tool_input: { command: 'git status && git push --force origin x' } }).verdict === 'ask');
{
  const f = path.join(repo, '.codebuddy/repo-guard.json');
  const keep = fs.readFileSync(f, 'utf-8');
  const j = JSON.parse(keep);
  j.redlines.commands = j.redlines.commands.filter((x) => !x.pattern.startsWith('git push --force'));
  fs.writeFileSync(f, JSON.stringify(j));
  add('R4', '项目层删掉某条默认命令红线 → 不再生效（整体覆盖全局层）', hook(repo, 'pre-bash', { session_id: S, tool_name: 'Bash', tool_input: { command: 'git push --force origin x' } }).verdict === 'allow');
  fs.writeFileSync(f, keep);
}
add('R3', '普通命令不受影响', hook(repo, 'pre-bash', { session_id: S, tool_name: 'Bash', tool_input: { command: 'git push origin x' } }).verdict === 'allow');
mcp(repo, S, 'guard_note', { note: 'List 里重复查询', file: 'internal/logic/agent/list.go:3' });

const s1 = hook(repo, 'stop', { session_id: S });
add('T1', 'Stop：有待说明项 → continue:false 续跑', s1.verdict === 'continue-false', s1.text.slice(0, 300));
add('T2', 'Stop：回执用 systemMessage 给人看', /\[repo-guard\] 改了 3 个文件/.test(s1.system), s1.system);
add('T3', '回执列出越界、复杂度、噪声、未验证、顺手发现', /越界 1 个/.test(s1.system) && /6个参数/.test(s1.system) && /噪声\s+1 处/.test(s1.system) && /未验证/.test(s1.system) && /重复查询/.test(s1.system), s1.system);
add('T4', '图谱不可用时回执注明', /图谱不可用|未登记|复用未检查/.test(s1.system));
add('T5', '没有新写入时下一次 Stop 放行（不无限续跑）', hook(repo, 'stop', { session_id: S }).verdict === 'allow');
hook(repo, 'post-bash', { session_id: S, tool_name: 'Bash', tool_input: { command: 'make test' }, tool_response: { exitCode: 0 } });
const rc = cli(repo, ['receipt'], { CODEBUDDY_SESSION_ID: S }).stdout;
add('T6', '最后一次写入后跑通验收命令 → 回执记为通过', /make test 通过/.test(rc), rc);
hook(repo, 'pre-write', { session_id: S, tool_name: 'Edit', tool_input: { file_path: 'internal/logic/agent/list.go' } });
hook(repo, 'post-write', { session_id: S, tool_name: 'Edit', tool_input: { file_path: 'internal/logic/agent/list.go' } });
add('T7', '之后又写了文件 → 验证失效', /未验证/.test(cli(repo, ['receipt'], { CODEBUDDY_SESSION_ID: S }).stdout));

// ④ 开发者原有改动不算 AI 的
const S2 = 'v2c';
w(repo, 'internal/logic/agent/list.go', 'package agent\n\nfunc List(a int) int {\n\treturn a * 2 // 用户自己改的\n}\n');
hook(repo, 'pre-write', { session_id: S2, tool_name: 'Edit', tool_input: { file_path: 'internal/logic/agent/list.go' } });
w(repo, 'internal/logic/agent/list.go', 'package agent\n\nfunc List(a int) int {\n\treturn a * 2 // 用户自己改的\n}\n\nfunc Extra() {}\n');
hook(repo, 'post-write', { session_id: S2, tool_name: 'Edit', tool_input: { file_path: 'internal/logic/agent/list.go' } });
const rc2 = cli(repo, ['receipt'], { CODEBUDDY_SESSION_ID: S2 }).stdout;
add('B1', '增量只算 AI 写入（写前快照为基线）', /新增 2 行 \/ 删除 0 行/.test(rc2), rc2);

// ⑤ enforce 档
const cfgFile = path.join(repo, '.codebuddy/repo-guard.json');
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, mode: 'enforce', task: { contract: 'required', scope: 'enforce' } }));
const S3 = 'v2e';
add('E1', 'contract required：第一次写就要求契约', hook(repo, 'pre-write', { session_id: S3, tool_name: 'Edit', tool_input: { file_path: 'router/agent.go' } }).verdict === 'deny');
mcp(repo, S3, 'guard_task', { goal: 'x', scope: ['router/**'] });
add('E2', 'enforce：越界写前弹窗', hook(repo, 'pre-write', { session_id: S3, tool_name: 'Edit', tool_input: { file_path: 'internal/pkg/util/fmt.go' } }).verdict === 'ask');
add('E3', 'enforce：范围内放行', hook(repo, 'pre-write', { session_id: S3, tool_name: 'Edit', tool_input: { file_path: 'router/agent.go' } }).verdict === 'allow');
fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, mode: 'off' }));
add('E4', 'mode off：不要求契约、不提醒', hook(repo, 'pre-write', { session_id: 'off', tool_name: 'Edit', tool_input: { file_path: 'router/agent.go' } }).verdict === 'allow' &&
  hook(repo, 'pre-write', { session_id: 'off', tool_name: 'Edit', tool_input: { file_path: 'internal/pkg/util/fmt.go' } }).verdict === 'allow');
add('E5', 'mode off：红线仍生效', hook(repo, 'pre-write', { session_id: 'off', tool_name: 'Edit', tool_input: { file_path: 'api/gen/x.pb.go' } }).verdict === 'deny');
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

// ⑥ 合并门 check
spawnSync('git', ['checkout', '-q', '--', '.'], { cwd: repo });
w(repo, 'router/agent.go', 'package router\n\nfunc A(a, b, c, d, e, f int) {}\n');
spawnSync('git', ['add', '-A'], { cwd: repo });
const k1 = cli(repo, ['check', '--staged']);
add('K1', 'check --staged：remind 档只报告、退出 0', k1.status === 0 && /6个参数/.test(k1.stdout), k1.stdout);
w(repo, 'api/gen/x.pb.go', 'package gen\n// x\n');
spawnSync('git', ['add', '-A'], { cwd: repo });
const k2 = cli(repo, ['check', '--staged']);
add('K2', 'check --staged：改了红线 block 文件 → 退出 1', k2.status === 1 && /命中红线（block）/.test(k2.stdout), k2.stdout);
spawnSync('git', ['commit', '-qm', 'k'], { cwd: repo });
const k3 = cli(repo, ['check', '--base', 'HEAD~1']);
add('K3', 'check --base：对比分支同样判定', k3.status === 1, k3.stdout);
add('K4', 'check --base 缺值 → 用法错误', cli(repo, ['check', '--base']).status === 2);

// ⑦ 字段红线 / 内容红线
const red = mkrepo('red', {
  'go.mod': 'module example.com/red\n\ngo 1.22\n',
  'internal/dto/err.go': 'package dto\n\ntype Err struct {\n\tErrorCode string \u0060json:"error_code"\u0060\n\tTenantID string \u0060json:"tenant_id"\u0060\n}\n',
  'internal/conf/old.go': 'package conf\n\nvar legacy = "AKIDoldoldoldoldoldoldold12"\n\nfunc A() {}\n',
  '.codebuddy/redlines.json': JSON.stringify({ rules: [
    { id: 'RL-1', rule: '错误码不许改名', reason: '已随 SDK 发布', protects: ['error_code'], paths: ['internal/**'] },
    { id: 'RL-2', rule: '示例', reason: '【示例】不迁移', protects: ['foo'] },
  ] }),
});
const rp = JSON.parse(cli(red, ['init', '--plan', '--json']).stdout);
add('F1', 'init 迁移旧 redlines.json 的字段红线（示例条目不迁）', rp.legacyFields.length === 1 && rp.legacyFields[0].protects[0] === 'error_code' && rp.legacyFields[0].action === 'block', JSON.stringify(rp.legacyFields));
cli(red, ['init', '--yes']);
const redCfgFile = path.join(red, '.codebuddy/repo-guard.json');
const redCfg = JSON.parse(fs.readFileSync(redCfgFile, 'utf-8'));
redCfg.redlines.fields.push({ protects: ['tenant_id'], paths: ['internal/dto/**'], action: 'block', reason: '租户隔离字段' });
fs.writeFileSync(redCfgFile, JSON.stringify(redCfg, null, 2));
const F = 'red1';
const fs1 = hook(red, 'session-start', { session_id: F });
add('F2', 'SessionStart 注入受保护字段清单', /受保护字段/.test(fs1.text) && /tenant_id/.test(fs1.text), fs1.text);
const f3 = hook(red, 'pre-write', { session_id: F, tool_name: 'Edit', tool_input: { file_path: 'internal/dto/err.go', old_string: 'json:"tenant_id"', new_string: 'json:"tenantId"' } });
add('F3', '改名受保护字段 → 拒绝（默认 block）', f3.verdict === 'deny' && /tenant_id/.test(f3.text), f3.text);
add('F4', '只加注释、字段次数没少 → 放行', hook(red, 'pre-write', { session_id: F, tool_name: 'Edit', tool_input: { file_path: 'internal/dto/err.go', old_string: 'type Err struct {', new_string: '// Err 错误\ntype Err struct {' } }).verdict === 'allow');
add('F5', '新增行写入腾讯云 SecretId → 拒绝', hook(red, 'pre-write', { session_id: F, tool_name: 'Write', tool_input: { file_path: 'internal/conf/new.go', content: 'package conf\n\nconst id = "AKIDabcdefghijklmnop123456"\n' } }).verdict === 'deny');
add('F6', '文件里原有的凭据不拦（只看新增行）', hook(red, 'pre-write', { session_id: F, tool_name: 'Edit', tool_input: { file_path: 'internal/conf/old.go', old_string: 'func A() {}', new_string: 'func A() { return }' } }).verdict === 'allow');
add('F7', '明显占位的 password 不拦', hook(red, 'pre-write', { session_id: F, tool_name: 'Write', tool_input: { file_path: 'internal/conf/p.go', content: 'package conf\nvar c = map[string]string{"password": "your-password-here"}\n' } }).verdict === 'allow');
add('F8', '疑似硬编码 password → 拒绝', hook(red, 'pre-write', { session_id: F, tool_name: 'Write', tool_input: { file_path: 'internal/conf/q.go', content: 'package conf\nvar c = map[string]string{"password": "Kq9vT3mZx81Lw"}\n' } }).verdict === 'deny');
{
  const off = JSON.parse(fs.readFileSync(redCfgFile, 'utf-8'));
  fs.writeFileSync(redCfgFile, JSON.stringify({ ...off, mode: 'off' }));
  add('F9', 'mode off：字段红线仍生效', hook(red, 'pre-write', { session_id: 'red-off', tool_name: 'Edit', tool_input: { file_path: 'internal/dto/err.go', old_string: 'json:"error_code"', new_string: 'json:"code"' } }).verdict === 'deny');
  fs.writeFileSync(redCfgFile, JSON.stringify(redCfg, null, 2));
}
// shell 绕过写前检查 → 写后兜底提醒
hook(red, 'pre-write', { session_id: 'red2', tool_name: 'Edit', tool_input: { file_path: 'internal/dto/err.go', old_string: 'x', new_string: 'y' } });
w(red, 'internal/dto/err.go', 'package dto\n\ntype Err struct {\n\tErrorCode string \u0060json:"error_code"\u0060\n}\n');
const f10 = hook(red, 'post-write', { session_id: 'red2', tool_name: 'Edit', tool_input: { file_path: 'internal/dto/err.go' } });
add('F10', '写前没算出改后内容时，写后兜底提醒撤回', f10.verdict === 'context' && /tenant_id/.test(f10.text), f10.text);
spawnSync('git', ['add', '-A'], { cwd: red });
const f11 = cli(red, ['check', '--staged']);
add('F11', 'check --staged：删除受保护字段 → 退出 1', f11.status === 1 && /tenant_id/.test(f11.stdout), f11.stdout);
spawnSync('git', ['checkout', '-q', 'HEAD', '--', 'internal/dto/err.go'], { cwd: red });
const au = JSON.parse(fs.readFileSync(redCfgFile, 'utf-8'));
au.redlines.fields.push({ protects: ['no_such_field_xyz'], paths: ['internal/**'] });
fs.writeFileSync(redCfgFile, JSON.stringify(au, null, 2));
const f12 = cli(red, ['audit']);
add('F12', 'audit 体检 v2 字段红线：字段已不存在 → 报出并非零退出', f12.status === 1 && /no_such_field_xyz/.test(f12.stdout), f12.stdout + f12.stderr);
const st2 = cli(red, ['status']).stdout;
add('F13', 'status 列出字段 / 内容红线', /字段 \d+ 条、内容 5 条/.test(st2) && /字段 error_code/.test(st2), st2);

// ⑧ 经 shell 改动的文件（绕开编辑工具）
{
  const sh = mkrepo('sh', {
    'go.mod': 'module example.com/sh\n\ngo 1.22\n',
    'internal/a/a.go': 'package a\n\nfunc A() {}\n',
    'internal/b/b.go': 'package b\n\nfunc B() {}\n',
    'internal/dto/d.go': 'package dto\n\ntype D struct {\n\tTenantID string\n}\n',
  });
  cli(sh, ['init', '--yes']);
  const f = path.join(sh, '.codebuddy/repo-guard.json');
  const c = JSON.parse(fs.readFileSync(f, 'utf-8'));
  c.redlines.fields = [{ protects: ['TenantID'], paths: ['internal/dto/**'] }];
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
  const X = 'sh1';
  hook(sh, 'session-start', { session_id: X });
  w(sh, 'internal/a/a.go', 'package a\n\nfunc A(a, b, c, d, e, f int) {}\n');
  const s1 = hook(sh, 'post-bash', { session_id: X, tool_name: 'Bash', tool_input: { command: "python3 - <<'EOF'\n...\nEOF" }, tool_response: { exitCode: 0 } });
  add('H1', '用命令改文件 → 执行后识别并做复杂度检查', s1.verdict === 'context' && /通过命令/.test(s1.text) && /6个参数/.test(s1.text), s1.text);
  w(sh, 'internal/b/b.go', 'package b\n\nfunc B() { println(1) }\n');
  const s2 = hook(sh, 'post-bash', { session_id: X, tool_name: 'Bash', tool_input: { command: 'sed -i ...' }, tool_response: { exitCode: 0 } });
  add('H2', '命令改了多个文件且没有契约 → 提醒补契约', /guard_task/.test(s2.text), s2.text);
  w(sh, 'internal/dto/d.go', 'package dto\n\ntype D struct {\n\tTenant string\n}\n');
  const s3 = hook(sh, 'post-bash', { session_id: X, tool_name: 'Bash', tool_input: { command: 'perl -pi ...' }, tool_response: { exitCode: 0 } });
  add('H3', '命令删了受保护字段 → 写后要求撤回', /TenantID/.test(s3.text) && /撤回/.test(s3.text), s3.text);
  const s4 = hook(sh, 'stop', { session_id: X });
  add('H4', '回执包含经命令改动的文件', /改了 3 个文件/.test(s4.system) && /6个参数/.test(s4.system), s4.system);
}

// ⑨ 插件内 MCP 工具名（连字符转下划线）也要记为查询
{
  const out = spawnSync(process.execPath, [TOOL, 'hook', 'post-atlas'], { input: JSON.stringify({ cwd: repo, session_id: 'pn', tool_name: 'mcp__plugin_repo_guard_code_atlas__atlas_impact', tool_input: { target: 'x' }, tool_response: { structuredContent: { receipt: { schemaVersion: 1, kind: 'impact', status: 'ok', workspace: 'w', repos: [{ id: 'go', path: repo }], targets: [{ repo: 'go', file: 'router/agent.go' }] } } } }), encoding: 'utf-8', env: ENV });
  const st = JSON.parse(fs.readFileSync(path.join(HOME, '.repo-guard/state/pn.json'), 'utf-8'));
  add('P1', '插件内 atlas_impact（mcp__plugin_repo_guard_code_atlas__）记为查过影响面', Object.keys(st.queried).some((k) => k.endsWith(':router/agent.go')), out.stderr);
  spawnSync(process.execPath, [TOOL, 'hook', 'post-atlas'], { input: JSON.stringify({ cwd: repo, session_id: 'pd', tool_name: 'DeferExecuteTool', tool_input: { toolName: 'mcp__plugin_repo_guard_code_atlas__atlas_impact', params: { target: 'router/agent.go' } }, tool_response: { structuredContent: { receipt: { schemaVersion: 1, kind: 'impact', status: 'ok', workspace: 'w', repos: [{ id: 'go', path: repo }], targets: [{ repo: 'go', file: 'router/agent.go' }] } } } }), encoding: 'utf-8', env: ENV });
  const sd = JSON.parse(fs.readFileSync(path.join(HOME, '.repo-guard/state/pd.json'), 'utf-8'));
  add('P3', '经 DeferExecuteTool 代理调用的 atlas_impact 也记为查过', Object.keys(sd.queried).some((k) => k.endsWith(':router/agent.go')));
  const hj = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'hooks', 'hooks.json'), 'utf-8'));
  add('P2', 'hooks.json 的 post-atlas matcher 覆盖插件内工具名与 DeferExecuteTool', hj.hooks.PostToolUse.some((h) => /mcp__plugin_repo_guard_code_atlas__atlas_impact/.test(h.matcher ?? '')) && hj.hooks.PostToolUse.some((h) => h.matcher === 'DeferExecuteTool'));
}

// ⑩ repo-guard link：终端启动器
{
  const dir = path.join(ROOT, 'linkbin');
  const l1 = cli(repo, ['link', '--dir', dir]);
  const st = spawnSync(path.join(dir, 'repo-guard'), ['status'], { cwd: repo, encoding: 'utf-8', env: ENV });
  add('L1', 'link 生成的启动器可直接运行 repo-guard 命令', l1.status === 0 && /总档位/.test(st.stdout), l1.stdout + st.stderr);
  fs.writeFileSync(path.join(dir, 'other'), 'x');
  fs.writeFileSync(path.join(dir, 'repo-guard'), 'not mine');
  add('L2', '目标位置已有别的 repo-guard 时不覆盖', cli(repo, ['link', '--dir', dir]).status === 2 && fs.readFileSync(path.join(dir, 'repo-guard'), 'utf-8') === 'not mine');
}

// ⑪ 历史债：改动前就超阈值的函数再变长不提醒
{
  const hd = mkrepo('debt', { 'go.mod': 'module example.com/d\n\ngo 1.22\n', 'a.go': 'package a\n\nfunc Big() {\n' + '\tprintln(1)\n'.repeat(70) + '}\n' });
  cli(hd, ['init', '--yes']);
  hook(hd, 'pre-write', { session_id: 'debt', tool_name: 'Edit', tool_input: { file_path: 'a.go' } });
  w(hd, 'a.go', 'package a\n\nfunc Big() {\n' + '\tprintln(1)\n'.repeat(75) + '}\n');
  add('D1', '改动前已超行数阈值的函数再变长 → 不提醒（历史债）', hook(hd, 'post-write', { session_id: 'debt', tool_name: 'Edit', tool_input: { file_path: 'a.go' } }).verdict === 'allow');
}

// ───────────── 报告 ─────────────
const pass = cases.filter((c) => c.ok).length;
console.log('\nv2 过程控制回归 · ' + pass + '/' + cases.length + ' 通过\n');
console.log('| 用例 | 场景 | 结果 |');
console.log('|---|---|---|');
for (const c of cases) console.log('| ' + c.id + ' | ' + c.desc + ' | ' + (c.ok ? 'PASS' : '**FAIL**') + ' |');
for (const c of cases.filter((x) => !x.ok)) console.log('\n── ' + c.id + ' ' + c.desc + '\n' + String(c.detail).slice(0, 600));
if (!KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
else console.log('\n保留在 ' + ROOT);
process.exit(pass === cases.length ? 0 : 1);