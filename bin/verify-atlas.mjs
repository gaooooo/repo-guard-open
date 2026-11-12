#!/usr/bin/env node
/** 图谱接入回归：全部使用临时 HOME、工作区和业务仓，不修改真实工程。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tool = path.join(here, 'repo-guard');
const atlas = process.env.REPO_GUARD_ATLAS_BIN || path.resolve(here, '../../code-atlas/bin/atlas');
if (!fs.existsSync(atlas)) { console.log('verify-atlas SKIP：请设置 REPO_GUARD_ATLAS_BIN 为 code-atlas/bin/atlas'); process.exit(0); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-atlas-'));
const home = path.join(root, 'home');
const frontend = path.join(root, 'frontend');
const backend = path.join(root, 'backend');
const env = { ...process.env, HOME: home, ATLAS_HOME: path.join(root, 'atlas-home'), REPO_GUARD_ATLAS_BIN: '', REPO_GUARD_ATLAS_NODE: '', ATLAS_WORKSPACE: '', CODEBUDDY_SESSION_ID: 'integration', ATLAS_NO_UPDATE_CHECK: '1' };
let checks = 0;
function ok(value, message) { assert.ok(value, message); checks++; }
function write(base, rel, body) { const file = path.join(base, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); }
function run(args, cwd = frontend, extra = {}) {
  const r = spawnSync(process.execPath, [tool, ...args], { cwd, encoding: 'utf-8', timeout: 60000, env: { ...env, ...extra } });
  assert.ifError(r.error);
  return r;
}
function success(args, cwd = frontend) { const r = run(args, cwd); assert.equal(r.status, 0, args.join(' ') + '\n' + r.stderr + r.stdout); return r; }
function mcp(name, args = {}, cwd = frontend) {
  const r = spawnSync(process.execPath, [tool, 'atlas', 'mcp'], { cwd, encoding: 'utf-8', timeout: 60000, env,
    input: JSON.stringify({ id: 1, method: name, ...(name === 'tools/call' ? { params: args } : {}) }) + '\n' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim()).result;
}
function hook(name, input, sid) {
  const r = spawnSync(process.execPath, [tool, 'hook', name], { cwd: frontend, encoding: 'utf-8', env,
    input: JSON.stringify({ cwd: frontend, session_id: sid, ...input }) });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
try {
  fs.mkdirSync(home, { recursive: true });
  for (const repo of [frontend, backend]) { fs.mkdirSync(repo, { recursive: true }); spawnSync('git', ['init', '-q'], { cwd: repo }); }
  write(frontend, 'package.json', '{"name":"web","dependencies":{"react":"18"}}');
  write(frontend, 'src/utils/format.ts', 'export function formatMoney(n: number) { return n.toFixed(2); }\n');
  write(frontend, 'src/pages/index.ts', "import { formatMoney } from '../utils/format'; export const page = () => formatMoney(1);\n");
  write(backend, 'go.mod', 'module example.com/backend\n\ngo 1.22\n');
  write(backend, 'dto/user.go', 'package dto\n\ntype User struct {\n  Name string\n  ID string\n}\n');
  write(backend, 'service/user.go', 'package service\n\nimport "example.com/backend/dto"\nfunc DescribeUser() string { u := dto.User{Name: "x"}; return u.Name }\n');
  // PATH 中存在另一版本，显式绑定后不得调用它。
  const fakeDir = path.join(root, 'old-bin');
  write(fakeDir, 'atlas', '#!/usr/bin/env node\nconsole.log(JSON.stringify({kind:"version",version:"0.0.0"}));\n');
  fs.chmodSync(path.join(fakeDir, 'atlas'), 0o755);
  env.PATH = fakeDir + path.delimiter + env.PATH;
  success(['atlas', 'bind', path.dirname(path.dirname(atlas)), '--node', process.execPath]);
  const status = JSON.parse(success(['atlas', 'status']).stdout);
  ok(status.bin === fs.realpathSync(atlas), '绑定必须指向指定工具包');
  ok(status.version !== '0.0.0', '不得调用 PATH 中旧版');
  const preview = success(['init', '--ws', 'team']);
  ok(preview.stdout.includes('写入时会登记到图谱'), '未登记时说明预览不会建图、写入时才登记');
  ok(!fs.existsSync(path.join(frontend, '.codegraph')), '预览不能建索引');
  ok(!fs.existsSync(path.join(env.ATLAS_HOME, 'workspaces/team.json')), '预览不能登记工作区');
  success(['init', '--write', '--ws', 'team', '--with', backend]);
  const list = JSON.parse(success(['atlas', 'list', '--json', '--metadata-only', '--ws', 'team']).stdout);
  ok(list.repos.length === 2, '初始化应将前后端纳入同一工作区');
  ok(fs.existsSync(path.join(frontend, '.codegraph')) && fs.existsSync(path.join(backend, '.codegraph')), '索引由 Atlas 建立');
  ok(fs.existsSync(path.join(frontend, '.codebuddy/repo-guard.json')), '接入写入 v2 单一配置 .codebuddy/repo-guard.json');
  success(['init', '--write']);
  success(['init', '--write']);
  const caches = path.join(env.ATLAS_HOME, 'cache');
  const before = fs.readdirSync(caches).map((n) => fs.readFileSync(path.join(caches, n, 'meta.json'), 'utf-8'));
  success(['init']);
  const after = fs.readdirSync(caches).map((n) => fs.readFileSync(path.join(caches, n, 'meta.json'), 'utf-8'));
  ok(JSON.stringify(before) === JSON.stringify(after), '预览必须复用缓存，不重建');
  ok(mcp('initialize').serverInfo.version === status.version, 'MCP 与 CLI 必须同版本');
  ok(mcp('tools/list').tools.some((t) => t.name === 'atlas_review'), '原生 review 工具可用');
  const result = mcp('tools/call', { name: 'atlas_impact', arguments: { target: 'src/utils/format.ts#formatMoney', workspace: 'team' } });
  ok(result.structuredContent.receipt.status === 'ok', '真实 MCP 应返回成功回执');
  // 接入 v2 后公共层以 .codebuddy/repo-guard.json 为准
  const ctlFile = path.join(frontend, '.codebuddy/repo-guard.json');
  const ctl = JSON.parse(fs.readFileSync(ctlFile, 'utf-8'));
  write(frontend, '.codebuddy/repo-guard.json', JSON.stringify({ ...ctl, publicLayer: ['src/utils/'] }));
  const input = { tool_name: 'Edit', tool_input: { file_path: 'src/utils/format.ts' } };
  ok(hook('pre-write', input, 'mcp-receipt').hookSpecificOutput.permissionDecision === 'deny', '未查询公共层仍按既有策略拦截');
  hook('post-atlas', { tool_name: 'mcp__code-atlas__atlas_impact', tool_input: { target: 'src/utils/format.ts#formatMoney' }, tool_response: result }, 'mcp-receipt');
  ok(hook('pre-write', input, 'mcp-receipt') === null, '有效回执应满足查询手续');
  hook('post-atlas', { tool_name: 'mcp__code-atlas__atlas_impact', tool_input: { target: 'src/utils/format.ts' }, tool_response: { ...result, isError: true } }, 'failed');
  ok(hook('pre-write', input, 'failed').hookSpecificOutput.permissionDecision === 'deny', '失败不能产生成功查询凭据');
  const missing = mcp('tools/call', { name: 'atlas_impact', arguments: { target: 'notARealSymbol', workspace: 'team' } });
  ok(missing.structuredContent.receipt.status === 'not_found', '未匹配目标不能伪装成成功');
  const bad = mcp('tools/call', { name: 'atlas_impact', arguments: { target: 'x', workspace: 'missing' } });
  ok(bad.isError === true && !bad.structuredContent, 'MCP 错误应显式标记');
  const field = success(['atlas', 'impact', 'dto/user.go#User.Name', '--repo', 'backend', '--ws', 'team', '--json']);
  ok(JSON.parse(field.stdout).receipt.targets.some((t) => t.file === 'dto/user.go'), '字段回执由 Atlas 解析实际目标');
  const text = success(['atlas', 'impact', 'src/utils/format.ts#formatMoney']);
  ok(text.stdout.includes('影响面') && !text.stdout.trim().startsWith('{'), '默认 CLI 保持人读报告');
  ok(hook('pre-write', input, 'integration') === null, '统一 CLI 也应记录查询凭据');
  success(['atlas', 'add', '.', '--ws', 'second']);
  fs.writeFileSync(path.join(home, '.repo-guard/atlas.json'), JSON.stringify({ ...status, workspaces: {} }));
  const ambiguous = run(['init']);
  ok(ambiguous.status !== 0 && ambiguous.stderr.includes('多个图谱工作区'), '多工作区不应静默选错');
  // 元数据查询不加载索引，即使仓尚未有缓存也可列出登记。
  write(env.ATLAS_HOME, 'workspaces/cold.json', JSON.stringify({ name: 'cold', repos: [{ id: 'cold', path: root }] }));
  const coldMetadata = JSON.parse(success(['atlas', 'list', '--ws', 'cold', '--metadata-only', '--json']).stdout);
  ok(coldMetadata.kind === 'workspace', '元数据必须走专用无索引接口');
  ok(!fs.existsSync(path.join(root, '.codegraph')), '元数据查询不能偷偷建图');
  const originalBinding = fs.readFileSync(path.join(home, '.repo-guard/atlas.json'), 'utf8');
  fs.writeFileSync(path.join(home, '.repo-guard/atlas.json'), JSON.stringify({ ...status, bin: path.join(root, 'missing-atlas') }));
  ok(run(['atlas', 'version']).status !== 0, '绑定失效必须报错，不回退 PATH');
  fs.writeFileSync(path.join(home, '.repo-guard/atlas.json'), originalBinding);
  const inherited = run(['atlas', 'unknown-command']);
  ok(inherited.status === 2, '原生命令退出码必须透传');
  console.log('verify-atlas OK · ' + checks + ' 项图谱接入断言通过');
} finally { fs.rmSync(root, { recursive: true, force: true }); }