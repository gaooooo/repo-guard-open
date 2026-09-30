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
    ['check', { files: ['src/components/Button/index.tsx'] }],
  ],
  go: [
    ['impact', { file: 'internal/common/util.go' }],
    ['impact', { file: 'internal/common/util.go#Paginate' }],
    ['similar', { intent: 'User' }],
    ['trace', { urlPath: '/api/users' }],
    ['hot', {}],
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

async function main() {
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
