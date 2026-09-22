#!/usr/bin/env node
/**
 * facts.json 生成契约：按本仓实况生成，不抄模板假路径，已存在不覆盖。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, '..', 'bin', 'repo-guard');
const NL = '\n';

function fail(msg) {
  console.error('verify-facts-init FAIL:', msg);
  process.exit(1);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}
function run(cwd, args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf-8' });
  if (r.status !== 0) fail(args.join(' ') + ' exit ' + r.status + NL + r.stdout + NL + r.stderr);
  return r.stdout;
}
function requiredOf(facts) {
  const routes = facts.taskRoutes && typeof facts.taskRoutes === 'object' ? facts.taskRoutes : {};
  const out = [];
  for (const v of Object.values(routes)) {
    if (v && Array.isArray(v.required)) out.push(...v.required);
  }
  return out;
}
function write(dir, rel, body) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body.endsWith(NL) ? body : body + NL);
}

if (!fs.existsSync(TOOL)) fail('找不到引擎 ' + TOOL);

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-facts-go-'));
const fe = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-facts-fe-'));
const guardRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-facts-guard-'));
try {
  spawnSync('git', ['init', '-q', '.'], { cwd: repo });
  write(repo, 'go.mod', ['module example.com/identity', '', 'go 1.22', '', 'require go.mongodb.org/mongo-driver v1.16.0'].join(NL));
  write(repo, 'cmd/main.go', 'package main');
  write(repo, 'router/router.go', 'package router');
  write(repo, 'internal/repo/store.go', 'package repo');
  write(repo, 'service/admin/x.go', 'package admin');
  write(repo, 'README.md', '# demo');
  write(repo, 'template/foo.md', 'not architecture');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });

  run(repo, ['layers', 'init', '--write']);
  const factsPath = path.join(repo, '.codebuddy/facts.json');
  assert(fs.existsSync(factsPath), 'layers init 未写入 facts.json');
  const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
  const blob = JSON.stringify(facts);
  assert(!blob.includes('docs/auth.md'), '不得编造 docs/auth.md');
  assert(!blob.includes('主体身份识别'), '不得拷贝身份服务示例使命');
  assert(Array.isArray(facts.facts) && facts.facts.some((s) => /cmd/.test(s) || /分层/.test(s)), 'Go 仓应写出分层');
  const req = requiredOf(facts);
  assert(!req.some((rel) => rel.startsWith('docs/') || rel.startsWith('template/')), 'required 不得指向空 docs 或模板 md');
  for (const rel of req) {
    assert(fs.existsSync(path.join(repo, rel)), 'required 不存在: ' + rel);
  }

  fs.writeFileSync(factsPath, JSON.stringify({ mission: 'KEEP' }, null, 2));
  run(repo, ['layers', 'init', '--write']);
  const kept = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
  assert(kept.mission === 'KEEP', '已存在的 facts.json 不得覆盖');
  run(repo, ['guard', 'init', '--write']);
  const goPg = JSON.parse(fs.readFileSync(path.join(repo, '.codebuddy/process-gates.json'), 'utf8'));
  assert(goPg.newPageSimilar.pathPatterns.some((x) => x.includes('router') || x.includes('service')), '后端 similar 应含 router/service');
  assert(goPg.newComponentLibSearch.pathPatterns.length === 0, '纯后端 lib_search patterns 应为空');


  spawnSync('git', ['init', '-q', '.'], { cwd: fe });
  write(
    fe,
    'package.json',
    JSON.stringify({
      name: '@acme/web',
      description: 'console app',
      dependencies: { react: '18.0.0', '@tencent/tea-component': '1.0.0' },
    }),
  );
  write(fe, 'src/views/.keep', '');
  write(fe, 'src/services/.keep', '');
  write(fe, 'src/api/.keep', '');
  write(fe, 'src/components/.keep', '');
  write(fe, 'README.md', '# web');
  run(fe, ['layers', 'init', '--write']);
  const feFacts = JSON.parse(fs.readFileSync(path.join(fe, '.codebuddy/facts.json'), 'utf8'));
  assert(!JSON.stringify(feFacts).includes('主体身份识别'), '前端仓不得写入身份服务模板使命');
  assert(
    feFacts.facts.some((s) => s.includes('src/views') || s.includes('前端') || s.includes('src/')),
    '前端仓应写出 src 结构',
  );
  write(
    fe,
    '.codebuddy/repo-facts.json',
    JSON.stringify({
      version: 1,
      analyzer: 'web-frontend',
      publicLayer: ['src/components/'],
      componentLibrary: null,
      lineLimit: 500,
    }),
  );
  run(fe, ['guard', 'init', '--write']);
  const fePg = JSON.parse(fs.readFileSync(path.join(fe, '.codebuddy/process-gates.json'), 'utf8'));
  assert(Array.isArray(fePg.newPageSimilar.pathPatterns) && fePg.newPageSimilar.pathPatterns.some((x) => x.includes('src/views')), '前端 similar 应含 src/views');
  assert(fePg.newComponentHot.pathPatterns.some((x) => x.includes('src/components')), '前端 hot 应含 src/components');
  assert(fePg.newComponentLibSearch.pathPatterns.some((x) => x.includes('src/components')), '前端 lib 应含 src/components');
  assert(fePg.newPageSimilar.enabled === false, '图谱强制默认关');
  const feRf = JSON.parse(fs.readFileSync(path.join(fe, '.codebuddy/repo-facts.json'), 'utf8'));
  assert(feRf.componentLibrary === '@tencent/tea-component', '应从 package.json 识别 tea');
  assert(feRf.componentMcp === 'garden-mcp-component', 'Tea 默认组件文档 MCP');
  const feFacts2 = JSON.parse(fs.readFileSync(path.join(fe, '.codebuddy/facts.json'), 'utf8'));
  assert(
    JSON.stringify(feFacts2).includes('garden-mcp-component') || JSON.stringify(feFacts).includes('garden-mcp-component'),
    'facts 应提到组件文档 MCP',
  );

  spawnSync('git', ['init', '-q', '.'], { cwd: guardRepo });
  write(guardRepo, 'README.md', '# x');
  write(
    guardRepo,
    '.codebuddy/process-gates.json',
    JSON.stringify({
      admission: false,
      newPageSimilar: false,
      newComponentHot: false,
      newComponentLibSearch: false,
    }),
  );
  write(guardRepo, 'src/views/.keep', '');
  write(guardRepo, 'router/router.go', 'package router');
  run(guardRepo, ['guard', 'init', '--write']);
  const gFacts = JSON.parse(fs.readFileSync(path.join(guardRepo, '.codebuddy/facts.json'), 'utf8'));
  const gPg = JSON.parse(fs.readFileSync(path.join(guardRepo, '.codebuddy/process-gates.json'), 'utf8'));
  assert(gPg.admission === false, '补全 pathPatterns 不得擅自打开 admission');
  assert(typeof gPg.newPageSimilar === 'object' && Array.isArray(gPg.newPageSimilar.pathPatterns), '布尔 false 应升级成对象');
  assert(
    gPg.newPageSimilar.pathPatterns.some((x) => x.includes('src/views')) ||
      gPg.newPageSimilar.pathPatterns.some((x) => x.includes('router')),
    '已有布尔 false 的 process-gates 应按本仓目录补 patterns',
  );
  assert(!JSON.stringify(gFacts).includes('docs/auth.md'), 'guard init 也不得编造 docs');
  assert(typeof gFacts.mission === 'string' && gFacts.mission.length > 0, 'guard init 应生成 mission');

  console.log('verify-facts-init OK');
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(fe, { recursive: true, force: true });
  fs.rmSync(guardRepo, { recursive: true, force: true });
}
