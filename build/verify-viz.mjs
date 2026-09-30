/**
 * 图谱体检页与沙盘的回归。守四件事：
 *
 *   ① 一致性：沙盘 /api/tool 返回的 text 与 MCP tools/call 同参数的输出**逐字相等**。
 *      这是沙盘存在的全部理由 —— 图上演示的能力必须就是 AI 拿到的能力。
 *   ② 无污染：沙盘调用前后 $HOME/.repo-guard/state 与 metrics.ndjson 字节不变。
 *      否则人在图上点一下就替 AI 把守卫放行了，埋点也会把人的点击算成 AI 的调用。
 *   ③ 安全：Host 不是 localhost → 403；白名单外工具 → 400；非 JSON POST → 415。
 *   ④ 写入模拟：拒绝文案与真实 pre-write hook 逐字一致；静态页不走 CDN。
 *
 * 用法：node build/verify-viz.mjs [--tool bin/repo-guard] [--keep]
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURES, materialize } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const TOOL = path.resolve(argv.includes('--tool') ? argv[argv.indexOf('--tool') + 1] : path.join(ROOT, 'bin', 'repo-guard'));
const KEEP = argv.includes('--keep');

const CASES = {
  web: [
    ['impact', { file: 'src/components/DataTable/index.tsx' }],
    ['impact', { file: 'src/utils/format.ts#formatDate' }],
    ['impact', { file: 'src/utils/format.ts', symbol: 'formatDate' }],
    ['similar', { intent: '带分页和搜索的列表页' }],
    ['trace', { urlPath: '/users' }],
    ['hot', {}],
    ['hot', { intent: '格式化日期' }],
    ['check', { files: ['src/components/Button/index.tsx'] }],
  ],
  go: [
    ['impact', { file: 'internal/common/util.go' }],
    ['impact', { file: 'internal/common/util.go#Paginate' }],
    ['similar', { intent: 'User' }],
    ['trace', { urlPath: '/api/users' }],
    ['hot', {}],
    ['hot', { intent: 'Paginate' }],
  ],
};

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed++;
};

function hashDir(dir) {
  const h = crypto.createHash('sha1');
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d).sort()) {
      const f = path.join(d, name);
      const st = fs.statSync(f);
      if (st.isDirectory()) walk(f);
      else h.update(name).update(fs.readFileSync(f));
    }
  };
  walk(dir);
  return h.digest('hex');
}
function pollutionKey(home) {
  const root = path.join(home, '.repo-guard');
  const m = path.join(root, 'metrics.ndjson');
  return `${hashDir(path.join(root, 'state'))}:${fs.existsSync(m) ? crypto.createHash('sha1').update(fs.readFileSync(m)).digest('hex') : '-'}`;
}

function mcpCall(cwd, env, name, args) {
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n';
  const r = spawnSync(process.execPath, [TOOL, 'mcp'], { cwd, env, input: frames, encoding: 'utf-8' });
  const line = r.stdout.split('\n').find((l) => l.includes('"id":2'));
  return JSON.parse(line).result.content[0].text;
}

function request(port, { method = 'GET', pathname = '/', body, host, type = 'application/json' }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers: { Host: host ?? `127.0.0.1:${port}`, ...(data ? { 'Content-Type': type, 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf-8') }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function startServer(cwd, env, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TOOL, 'viz', '--serve', '--port', String(port)], { cwd, env });
    let out = '';
    const t = setTimeout(() => reject(new Error(`沙盘服务没起来：${out}`)), 60_000);
    child.stdout.on('data', (c) => {
      out += c;
      const m = out.match(/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(t);
        resolve({ child, port: Number(m[1]) });
      }
    });
    child.on('exit', (code) => reject(new Error(`沙盘服务退出 ${code}：${out}`)));
  });
}

/**
 * similar 后端分支的单元用例：直接喂合成图谱给 src/insight/similar-methods.ts。
 * 端到端 fixture 里没有完整的三层 CRUD，拿不到模板兜底这条路。
 */
async function similarUnit() {
  console.log('\n── similar（后端方法家族）──');
  const out = path.join(os.tmpdir(), `rg-similar-${process.pid}.mjs`);
  const esbuild = path.join(ROOT, 'node_modules', '.bin', 'esbuild');
  const b = spawnSync(esbuild, [path.join(ROOT, 'src/insight/similar-methods.ts'), '--bundle', '--format=esm', '--platform=node', `--outfile=${out}`, '--log-level=warning']);
  if (b.status !== 0) {
    ok(false, `打包 similar-methods 失败：${b.stderr}`);
    return;
  }
  const m = await import(out);
  fs.rmSync(out, { force: true });
  const fns = [];
  const calls = [];
  const fn = (file, name, line) => {
    fns.push({ file, name, line, endLine: line + 8, exported: true, owner: null });
    return { file, name, line };
  };
  const call = (from, to, dl = 2) => calls.push({ fromFile: from.file, fromFn: from.name, toFile: to.file, toMethod: to.name, line: from.line + dl, kind: 'call', tier: 'extracted' });
  // 模板家族 AIMAgents：四个动作，每个动作先查存在再做本动作（验证同动作优先）
  const repoFind = fn('internal/repo/agent.go', 'Find', 10);
  const repoOne = fn('internal/repo/agent.go', 'FindOne', 20);
  const repoIns = fn('internal/repo/agent.go', 'Insert', 30);
  const repoUpd = fn('internal/repo/agent.go', 'Update', 40);
  const repoDel = fn('internal/repo/agent.go', 'Delete', 50);
  const lDescs = fn('internal/logic/agent.go', 'DescribeAgents', 10); call(lDescs, repoFind);
  const lDesc = fn('internal/logic/agent.go', 'DescribeAgent', 20); call(lDesc, repoOne);
  const lCre = fn('internal/logic/agent.go', 'CreateAgent', 30); call(lCre, repoIns);
  const lMod = fn('internal/logic/agent.go', 'ModifyAgent', 40); call(lMod, repoUpd);
  const lDel = fn('internal/logic/agent.go', 'DeleteAgent', 50); call(lDel, repoDel);
  const sDescs = fn('service/admin/agent.go', 'DescribeAIMAgents', 10); call(sDescs, lDescs);
  const sCre = fn('service/admin/agent.go', 'CreateAIMAgent', 30); call(sCre, lCre);
  const sMod = fn('service/admin/agent.go', 'ModifyAIMAgent', 40); call(sMod, lDesc, 1); call(sMod, lMod, 3);
  const sDel = fn('service/admin/agent.go', 'DeleteAIMAgent', 50); call(sDel, lDesc, 1); call(sDel, lDel, 3);
  // 缺 Create 的家族：逻辑层已经有 CreateTokenUsage
  const tFind = fn('internal/repo/token_usage.go', 'Find', 10);
  fn('internal/repo/token_usage.go', 'Insert', 20);
  const tlDescs = fn('internal/logic/token_usage.go', 'DescribeTokenUsages', 10); call(tlDescs, tFind);
  fn('internal/logic/token_usage.go', 'CreateTokenUsage', 20);
  const tsDescs = fn('service/admin/token_usage.go', 'DescribeAIMTokenUsages', 10); call(tsDescs, tlDescs);
  fn('service/admin/token_usage.go', 'DeleteAIMTokenUsage', 20);
  fn('service/admin/token_usage.go', 'ModifyAIMTokenUsage', 30);
  // 复数：Categories 与 Category 必须同族
  fn('service/category.go', 'DescribeCategories', 10);
  fn('service/category.go', 'CreateCategory', 20);
  const modules = [...new Set(fns.map((f) => f.file))].map((file) => ({ file, imports: [], importedBy: [], symbolCount: 0 }));
  const graph = { ok: true, repoDir: '/x', modules, classes: [], functions: fns, calls, routes: [], stats: {}, warnings: [], builtAt: 0 };

  const t = m.similarMethods(graph, { intent: 'CreateAIMWorkload' });
  const txt = m.renderSimilarMethods(t, 'x');
  ok(t.matchedBy === 'template' && t.template?.family.family === 'AIMAgents', `新资源走模板兜底（${t.matchedBy} / ${t.template?.family.family}）`);
  const mod = t.template?.chains.find((c) => c.verb === 'Modify');
  ok(mod?.chain.map((c) => c.name).join('>') === 'ModifyAIMAgent>ModifyAgent>Update', `Modify 骨架取同动作下游（${mod?.chain.map((c) => c.name).join('>')}）`);
  ok(/service\/admin\/workload\.go`：DescribeAIMWorkloads、CreateAIMWorkload/.test(txt) && /internal\/repo\/workload\.go`：Find/.test(txt), '照模板推导出新资源的方法与文件');

  const g = m.similarMethods(graph, { intent: 'CreateAIMTokenUsage' });
  const planned = g.verbTemplate?.chain.planned ?? [];
  ok(g.matchedBy === 'family' && g.verbTemplate?.family === 'AIMAgents', '缺动作时从别的家族借同一动作');
  ok(planned.map((p) => `${p.name}:${p.reuse ? '有' : '新'}`).join(' ') === 'CreateAIMTokenUsage:新 CreateTokenUsage:有 Insert:有', `标出下层已有的方法（${planned.map((p) => `${p.name}:${p.reuse ? '有' : '新'}`).join(' ')}）`);

  const c = m.similarMethods(graph, { intent: 'Category' });
  ok(c.families[0]?.members.length === 2, `Categories 与 Category 同族（${c.families[0]?.members.length}）`);

  const u = m.similarMethods(graph, { intent: 'EscapeRegex' });
  ok(!u.template && /hot/.test(u.unmatchedReason ?? ''), '工具函数不给 CRUD 模板，改提示用 hot');
}

/** hot 带 intent 的单元用例：中文需求靠注释与词表对上英文方法名，对象词缺一不算「可复用」 */
async function reuseUnit() {
  console.log('\n── hot intent（复用检索）──');
  const out = path.join(os.tmpdir(), `rg-reuse-${process.pid}.mjs`);
  const esbuild = path.join(ROOT, 'node_modules', '.bin', 'esbuild');
  const b = spawnSync(esbuild, [path.join(ROOT, 'src/insight/reuse.ts'), '--bundle', '--format=esm', '--platform=node', `--outfile=${out}`, '--log-level=warning']);
  if (b.status !== 0) {
    ok(false, `打包 reuse 失败：${b.stderr}`);
    return;
  }
  const m = await import(out);
  fs.rmSync(out, { force: true });
  const src = {
    'internal/logic/tenant_config.go': ['', '// DescribeTenantConfig 查询单个租户配置', 'func DescribeTenantConfig() {}', '', '// DescribeTenant 查询租户', 'func DescribeTenant() {}'].join('\n'),
    'internal/utils/regex.go': ['', '// EscapeRegex 字符串转译为正则格式', 'func EscapeRegex() {}'].join('\n'),
    'service/admin/resource.go': ['', '// validateInstance 校验实例ID是否真实存在', 'func validateInstance() {}'].join('\n'),
    'internal/key/key.go': ['', '// VerifyToken 验证 token', 'func VerifyToken() {}'].join('\n'),
    'service/a.go': ['', 'func A() {', '  DescribeTenantConfig()', '  EscapeRegex()', '}', 'func B() {', '  EscapeRegex()', '}'].join('\n'),
  };
  const fns = [
    { file: 'internal/logic/tenant_config.go', name: 'DescribeTenantConfig', line: 3, endLine: 3, exported: true, owner: null },
    { file: 'internal/logic/tenant_config.go', name: 'DescribeTenant', line: 6, endLine: 6, exported: true, owner: null },
    { file: 'internal/utils/regex.go', name: 'EscapeRegex', line: 3, endLine: 3, exported: true, owner: null },
    { file: 'service/admin/resource.go', name: 'validateInstance', line: 3, endLine: 3, exported: false, owner: null },
    { file: 'internal/key/key.go', name: 'VerifyToken', line: 3, endLine: 3, exported: true, owner: null },
    { file: 'service/a.go', name: 'A', line: 2, endLine: 5, exported: true, owner: null },
    { file: 'service/a.go', name: 'B', line: 6, endLine: 8, exported: true, owner: null },
  ];
  const calls = [
    { fromFile: 'service/a.go', fromFn: 'A', toFile: 'internal/logic/tenant_config.go', toMethod: 'DescribeTenantConfig', line: 3, kind: 'call', tier: 'extracted' },
    { fromFile: 'service/a.go', fromFn: 'A', toFile: 'internal/utils/regex.go', toMethod: 'EscapeRegex', line: 4, kind: 'call', tier: 'extracted' },
    { fromFile: 'service/a.go', fromFn: 'B', toFile: 'internal/utils/regex.go', toMethod: 'EscapeRegex', line: 7, kind: 'call', tier: 'extracted' },
  ];
  const modules = Object.keys(src).map((file) => ({ file, imports: [], importedBy: [], symbolCount: 0 }));
  const graph = { ok: true, repoDir: '/x', modules, classes: [], functions: fns, calls, routes: [], stats: {}, warnings: [], builtAt: 0 };
  const readSource = (f) => src[f] ?? null;

  const t = m.findReuse(graph, '查询租户配置', { readSource });
  ok(t.candidates[0]?.fn.name === 'DescribeTenantConfig' && t.candidates[0].full, `中文需求命中英文方法（${t.candidates[0]?.fn.name}）`);
  ok(!t.candidates.find((c) => c.fn.name === 'DescribeTenant')?.full, '只对上一部分对象词（租户，缺配置）不算可复用');
  const e = m.findReuse(graph, '转义正则', { readSource });
  ok(e.candidates[0]?.fn.name === 'EscapeRegex' && e.candidates[0].fanIn === 2, `工具函数按被调用次数给出（fanIn=${e.candidates[0]?.fanIn}）`);
  const v = m.findReuse(graph, '校验 token', { readSource });
  ok(v.candidates[0]?.fn.name === 'VerifyToken' && !v.candidates.find((c) => c.fn.name === 'validateInstance')?.full, '只命中动作词（validateInstance）不算可复用');
  const n = m.findReuse(graph, '格式化时间', { readSource });
  ok(!n.candidates.some((c) => c.full), '没有现成的就不硬凑「可复用」');
}

async function main() {
  await similarUnit();
  await reuseUnit();
  if (!fs.existsSync(TOOL)) {
    console.error(`找不到产物：${TOOL}`);
    process.exit(2);
  }
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-viz-')));
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEBUDDY_SESSION_ID: 'verify-viz' };

  let port = 17800 + Math.floor(Math.random() * 1000);
  for (const name of Object.keys(CASES)) {
    const repo = path.join(sandbox, name);
    fs.mkdirSync(repo, { recursive: true });
    materialize(repo, FIXTURES[name]);
    // 配好公共层，写入模拟才有东西可拦
    spawnSync(process.execPath, [TOOL, 'init', '--write'], { cwd: repo, env, encoding: 'utf-8' });
    // 先让 MCP 建一次图，避免沙盘第一次调用和 MCP 调用分别建图、建图时间戳不同
    mcpCall(repo, env, 'scan', {});

    const srv = await startServer(repo, env, port);
    port = srv.port + 1;
    try {
      console.log(`\n── ${name} ──`);
      const before = pollutionKey(home);
      const sandboxText = [];
      for (const [tool, args] of CASES[name]) {
        const r = await request(srv.port, { method: 'POST', pathname: '/api/tool', body: { name: tool, args } });
        const j = JSON.parse(r.text);
        sandboxText.push(j.text);
        ok(r.status === 200 && Array.isArray(j.highlight?.groups), `${tool} ${JSON.stringify(args)} 返回 text + highlight`);
      }
      const sim = JSON.parse((await request(srv.port, { method: 'POST', pathname: '/api/simulate-write', body: { file: name === 'web' ? 'src/components/Button/index.tsx' : 'internal/common/util.go' } })).text);
      ok(pollutionKey(home) === before, '沙盘调用前后会话状态与埋点字节不变');

      CASES[name].forEach(([tool, args], i) => {
        const mcp = mcpCall(repo, env, tool, args);
        ok(mcp === sandboxText[i], `${tool} ${JSON.stringify(args)} 与 MCP 输出逐字一致`);
        if (mcp !== sandboxText[i]) {
          console.log('   MCP   :', JSON.stringify(mcp.slice(0, 300)));
          console.log('   沙盘  :', JSON.stringify(sandboxText[i].slice(0, 300)));
        }
      });

      // 写入模拟 vs 真实 hook（用一个全新会话，确保"本轮没查过"）
      const hookEnv = { ...env, CODEBUDDY_SESSION_ID: `verify-viz-hook-${name}` };
      const file = name === 'web' ? 'src/components/Button/index.tsx' : 'internal/common/util.go';
      const hook = spawnSync(process.execPath, [TOOL, 'hook', 'pre-write'], {
        cwd: repo,
        env: hookEnv,
        input: JSON.stringify({ cwd: repo, session_id: `verify-viz-hook-${name}`, tool_name: 'Edit', tool_input: { file_path: file } }),
        encoding: 'utf-8',
      });
      const hookReason = hook.stdout.trim() ? JSON.parse(hook.stdout).hookSpecificOutput?.permissionDecisionReason ?? null : null;
      ok(sim.verdict === (hookReason ? 'deny' : 'allow'), `写入模拟判定与真实 pre-write 一致（${sim.verdict}）`);
      ok((sim.reason ?? null) === hookReason, '写入模拟的拒绝文案与真实 hook 逐字一致');

      // 假设开门：新文件 + 未查 similar → 拦；查过 → 放。且不写任何配置文件
      const newFile = name === 'web' ? 'src/views/NewPage/index.tsx' : 'internal/service/new_api.go';
      const cfgBefore = hashDir(path.join(repo, '.codebuddy'));
      const g1 = JSON.parse((await request(srv.port, { method: 'POST', pathname: '/api/simulate-write', body: { file: newFile, assumeGate: 'similar' } })).text);
      const g2 = JSON.parse((await request(srv.port, { method: 'POST', pathname: '/api/simulate-write', body: { file: newFile, assumeGate: 'similar', similarSearched: true } })).text);
      ok(g1.verdict === 'deny' && /similar/.test(g1.reason ?? '') && g2.verdict === 'allow', `假设开门：未查 similar 拦、查过放（${g1.verdict} → ${g2.verdict}）`);
      ok(hashDir(path.join(repo, '.codebuddy')) === cfgBefore, '假设开门不改仓库配置');

      const evil = await request(srv.port, { pathname: '/api/view', host: `evil.example:${srv.port}` });
      ok(evil.status === 403, `非 localhost Host 被拒（${evil.status}）`);
      const bad = await request(srv.port, { method: 'POST', pathname: '/api/tool', body: { name: 'exec', args: {} } });
      ok(bad.status === 400, `白名单外工具被拒（${bad.status}）`);
      const form = await request(srv.port, { method: 'POST', pathname: '/api/tool', body: 'name=impact', type: 'application/x-www-form-urlencoded' });
      ok(form.status === 415, `非 JSON POST 被拒（${form.status}）`);
      const view = await request(srv.port, { pathname: '/api/view' });
      const v = JSON.parse(view.text);
      ok(view.status === 200 && v.view.schemaVersion === 1 && v.health.schemaVersion === 1, '/api/view 返回带 schemaVersion 的 view + health');
    } finally {
      srv.child.kill('SIGTERM');
    }

    const out = path.join(sandbox, `static-${name}`);
    const r = spawnSync(process.execPath, [TOOL, 'viz', '--out', out], { cwd: repo, env, encoding: 'utf-8' });
    const html = fs.existsSync(path.join(out, 'index.html')) ? fs.readFileSync(path.join(out, 'index.html'), 'utf-8') : '';
    ok(r.status === 0 && html.includes('window.RG_DATA=') && html.includes('echarts'), '静态页内联了数据与 echarts');
    ok(!/cdn\.jsdelivr|unpkg\.com|<script src="http/.test(html), '静态页不引用外部 CDN');
    ok(JSON.parse(fs.readFileSync(path.join(out, 'health.json'), 'utf-8')).schemaVersion === 1, 'health.json 带 schemaVersion');
  }

  if (!KEEP) fs.rmSync(sandbox, { recursive: true, force: true });
  else console.log(`\n保留现场：${sandbox}`);
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
