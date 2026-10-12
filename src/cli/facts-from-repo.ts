/**
 * 按仓库实况生成 .codebuddy/facts.json。
 *
 * 模板拷贝会把身份服务示例、不存在的 docs/*.md 写进任意仓库 ——
 * 前端仓因此出现「主体身份识别」，后端仓引用已删的 docs。
 * 本文件是 init 的唯一来源：只写本仓真实目录与真实路径。
 */
import fs from 'node:fs';
import path from 'node:path';

import { readFacts } from '../runtime/repo-facts.js';
import { detectLibrary, suggestedComponentMcp } from '../library/library-catalog.js';

function exists(repoDir: string, rel: string): boolean {
  try {
    return fs.existsSync(path.join(repoDir, rel));
  } catch {
    return false;
  }
}

function pick(repoDir: string, cands: string[]): string[] {
  return cands.filter((r) => exists(repoDir, r));
}

function listSubdirs(repoDir: string, rel: string): string[] {
  const dir = rel ? path.join(repoDir, rel) : repoDir;
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith('.') &&
          e.name !== 'node_modules' &&
          e.name !== 'dist' &&
          e.name !== 'vendor' &&
          e.name !== 'coverage',
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function readUtf8(repoDir: string, rel: string, max = 80_000): string {
  try {
    const p = path.join(repoDir, rel);
    const st = fs.statSync(p);
    if (!st.isFile()) return '';
    if (st.size > 2 * 1024 * 1024) return '';
    return fs.readFileSync(p, 'utf8').slice(0, max);
  } catch {
    return '';
  }
}

function docsIsEmpty(repoDir: string): boolean {
  const dir = path.join(repoDir, 'docs');
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return true;
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.')).length === 0;
  } catch {
    return true;
  }
}

function existingDocs(repoDir: string): string[] {
  const dir = path.join(repoDir, 'docs');
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.md') && !n.startsWith('.'))
      .sort()
      .slice(0, 8)
      .map((n) => 'docs/' + n);
  } catch {
    return [];
  }
}

function goModuleName(repoDir: string): string | null {
  const m = readUtf8(repoDir, 'go.mod', 4000).match(/^module\s+(\S+)/m);
  return m ? m[1] : null;
}

function goModText(repoDir: string): string {
  return readUtf8(repoDir, 'go.mod', 120_000);
}

function trpcServices(repoDir: string): string[] {
  const yamlRel = pick(repoDir, ['etc/trpc_go.yaml', 'trpc_go.yaml'])[0];
  if (!yamlRel) return [];
  const names = new Set<string>();
  const t = readUtf8(repoDir, yamlRel, 30_000);
  for (const m of t.matchAll(/name:\s*(trpc\.[A-Za-z0-9._-]+)/g)) {
    names.add(m[1]);
  }
  return [...names];
}

function pkgInfo(repoDir: string): { name: string; description: string; deps: string[] } | null {
  if (!exists(repoDir, 'package.json')) return null;
  try {
    const j = JSON.parse(readUtf8(repoDir, 'package.json', 200_000)) as Record<string, unknown>;
    const deps = {
      ...(typeof j.dependencies === 'object' && j.dependencies ? (j.dependencies as Record<string, unknown>) : {}),
      ...(typeof j.devDependencies === 'object' && j.devDependencies
        ? (j.devDependencies as Record<string, unknown>)
        : {}),
    };
    return {
      name: typeof j.name === 'string' ? j.name : '',
      description: typeof j.description === 'string' ? j.description.trim() : '',
      deps: Object.keys(deps),
    };
  } catch {
    return null;
  }
}

function route(match: string[], required: string[], hard: string): Record<string, unknown> {
  return { match, required, hard_gate: hard, enabled: required.length > 0 };
}

function push(arr: string[], line: string): void {
  const t = line.trim();
  if (t && !arr.includes(t)) arr.push(t);
}

export function buildFactsFromRepo(repoDir: string): Record<string, unknown> {
  const rf = readFacts(repoDir);
  const dirs = listSubdirs(repoDir, '');
  const arch: string[] = [];
  const go = exists(repoDir, 'go.mod');
  const pkg = pkgInfo(repoDir);
  const srcSubs = listSubdirs(repoDir, 'src');
  const fe = Boolean(pkg) && (srcSubs.length > 0 || dirs.includes('i18n'));
  const internalSubs = listSubdirs(repoDir, 'internal');
  const serviceSubs = listSubdirs(repoDir, 'service');
  const mod = go ? goModuleName(repoDir) : null;
  const gomod = go ? goModText(repoDir) : '';

  if (go) {
    push(arch, mod ? '本仓是 Go 模块 ' + mod + '。' : '本仓是 Go 模块（go.mod）。');
  }
  if (fe) {
    push(
      arch,
      pkg?.name
        ? '本仓是前端/Node 工程 ' + pkg.name + '，业务源码主要在 src/。'
        : '本仓是前端/Node 工程，业务源码主要在 src/。',
    );
  }
  if (!go && !fe && dirs.length) {
    push(arch, '顶层目录：' + dirs.slice(0, 14).join('、') + '。');
  }

  if (go && (dirs.includes('cmd') || dirs.includes('internal'))) {
    const bits: string[] = [];
    if (dirs.includes('cmd')) bits.push('cmd（入口）');
    if (dirs.includes('router')) bits.push('router（路由）');
    if (dirs.includes('service')) {
      bits.push(serviceSubs.length ? 'service/' + serviceSubs.join('|') + '（接口）' : 'service（接口）');
    }
    if (internalSubs.includes('logic')) bits.push('internal/logic（业务）');
    if (internalSubs.includes('repo')) bits.push('internal/repo（数据）');
    if (internalSubs.includes('dto')) bits.push('internal/dto（结构体）');
    if (internalSubs.includes('config')) bits.push('internal/config（配置）');
    if (bits.length >= 2) {
      push(arch, '架构分层（按本仓目录）：' + bits.join(' → ') + '。禁止跨层直连数据层。');
    }
  }

  if (internalSubs.includes('repo')) {
    if (/mongo/i.test(gomod)) {
      push(
        arch,
        '数据访问在 internal/repo，依赖含 Mongo 驱动。若使用 bson.M 等字符串键，改字段名不会被编译器拦住，必须同时改写入与查询。',
      );
    } else {
      push(arch, '数据访问在 internal/repo。改存储字段必须同时改结构体与所有查询。');
    }
  }

  const tencent = internalSubs.filter((n) => n.startsWith('tencent_') || n.startsWith('tencent'));
  if (tencent.length) {
    push(arch, '云厂商 SDK 封装在 internal/' + tencent.join('、internal/') + '，业务 logic 不要直接调 SDK。');
  }

  if (dirs.includes('router') && exists(repoDir, 'router/router.go')) {
    const routerSrc = readUtf8(repoDir, 'router/router.go', 40_000);
    const extra = routerSrc.includes('yunApi') ? ' 含 /yunApi 等对外入口。' : '';
    push(arch, 'HTTP/tRPC 路由注册在 router/router.go，改对外 Action 先看这里。' + extra);
  }

  const services = go ? trpcServices(repoDir) : [];
  if (services.length) {
    push(arch, 'tRPC 服务（etc/trpc_go.yaml）：' + services.join('、') + '。改对外接口先确认落在哪条服务。');
  }

  if (srcSubs.length) {
    push(arch, 'src/ 下现有目录：' + srcSubs.join('、') + '。');
  }
  if (srcSubs.includes('views') && (srcSubs.includes('services') || srcSubs.includes('api'))) {
    push(arch, '页面在 src/views，请求与业务编排在 src/api、src/services。不要在页面里散落请求细节。');
  }
  if (srcSubs.includes('components')) {
    push(arch, '可复用 UI 在 src/components。写新组件前先查仓内是否已有同类。');
  }
  if (srcSubs.includes('router') || srcSubs.includes('routes')) {
    push(arch, '前端路由在 src/router（或 src/routes），改页面入口先看这里。');
  }
  const uiLib = detectLibrary(repoDir) || (pkg?.deps.includes('@tencent/tea-component') ? '@tencent/tea-component' : null);
  const uiMcp = (rf && rf.componentMcp) || suggestedComponentMcp(uiLib);
  if (uiLib) {
    push(
      arch,
      uiMcp
        ? 'UI 组件库是 ' + uiLib + '。写组件前必须查 MCP「' + uiMcp + '」的文档和 props，禁止凭 antd/MUI 记忆编写。'
        : 'UI 组件库是 ' + uiLib + '。写组件前先 lib_search，并用真实类型定义，不要凭其它库记忆写 props。',
    );
  }
  if (dirs.includes('i18n') || srcSubs.includes('i18n') || exists(repoDir, 'src/i18n.ts')) {
    push(arch, '存在 i18n 相关目录/文件，改用户可见文案先看这里。');
  }

  if (dirs.includes('template') || dirs.includes('agent')) {
    push(
      arch,
      'agent/ 与 template/ 多为客户端插件或 SDK 模板，不是服务端主链路。改主链路去 cmd、router、service、internal。',
    );
  }

  if (rf && rf.publicLayer.length) {
    push(
      arch,
      '公共层目录（init 推测，请人确认）：' + rf.publicLayer.join('、') + '。改其中已有文件前必须先查影响面（code-atlas 的 atlas_impact）。',
    );
  }

  if (docsIsEmpty(repoDir)) {
    push(arch, '仓库 docs/ 不存在或为空，禁止在配置里填写 docs 下不存在的文件。');
  } else {
    const docs = existingDocs(repoDir);
    push(
      arch,
      docs.length
        ? '文档目录 docs/ 中现存：' + docs.join('、') + '。任务必读只许指向这些真实文件。'
        : '文档目录 docs/ 存在，任务必读请指向其中真实文件。',
    );
  }

  if (exists(repoDir, 'README.md')) {
    push(arch, '仓级入口文档是 README.md。');
  }

  let mission = '请用一两句话写明本仓职责（做什么、不做什么）。';
  if (pkg?.description) {
    mission = pkg.description + '（来自 package.json description，请人确认后改成一句话使命。）';
  } else if (go && mod) {
    mission = '本仓为后端服务（Go 模块 ' + mod + '）。请把一句话使命改成真实业务（做什么、不做什么）。';
  } else if (fe) {
    mission = '本仓为前端工程。请把一句话使命改成真实产品定位。';
  } else if (go) {
    mission = '本仓为后端服务（Go）。请把一句话使命改成真实业务（做什么、不做什么）。';
  }

  const docsReq = existingDocs(repoDir);
  const authReq = pick(repoDir, [
    'README.md',
    'CODEBUDDY.md',
    'internal/config/config.go',
    'router/router.go',
    'src/services',
    'src/api',
    ...docsReq,
  ]);
  const apiReq = pick(repoDir, [
    'README.md',
    'router/router.go',
    'constants/errors.go',
    'src/api',
    'src/services',
    ...docsReq,
  ]);
  const dataReq = pick(repoDir, ['README.md', 'internal/repo', 'internal/dto', 'src/services', 'src/api']);
  const cfgReq = pick(repoDir, [
    'etc/trpc_go.yaml',
    'trpc_go.yaml',
    'internal/config/config.go',
    'tea.config.js',
    'README.md',
  ]);
  const relReq = pick(repoDir, ['README.md', 'pipeline.yaml', 'Dockerfile', 'Makefile', 'package.json']);

  const routes: Record<string, unknown> = {};
  if (authReq.length) {
    routes.auth = route(
      ['鉴权', '登录', 'token', '身份', '认证', 'JWT'],
      authReq,
      '改鉴权前先读 required 中的本仓文件，并说明落在哪一段校验。',
    );
  }
  if (apiReq.length) {
    routes.api = route(
      ['接口', 'Action', '错误码', '契约'],
      apiReq,
      '已发布接口与错误码只增不删。required 都是本仓真实路径。',
    );
  }
  if (dataReq.length) {
    routes.data = route(
      ['数据', 'Mongo', 'bson', '字段', 'schema'],
      dataReq,
      '改存储字段必须同时改结构体与查询，并考虑存量数据。',
    );
  }
  if (cfgReq.length) {
    routes.config = route(
      ['配置', '密钥', '环境', 'Rainbow'],
      cfgReq,
      '密钥只从运行时注入，禁止写入仓库。',
    );
  }
  if (relReq.length) {
    routes.release = route(['发布', '上线', '流水线'], relReq, '发布与回滚方案必须同时具备。');
  }
  if (uiLib) {
    const uiReq = pick(repoDir, ['src/components', 'package.json', 'README.md']);
    routes.ui = route(
      ['组件', 'tea', 'Tea', 'Button', 'Select', 'Table', '表单'],
      uiReq.length ? uiReq : ['README.md'],
      uiMcp
        ? '写或改组件前必须调用 MCP「' + uiMcp + '」查阅文档和 props，并先 lib_search / hot。不要凭 antd 经验编 API。'
        : '写或改组件前先 lib_search / hot，并用本仓组件库的类型定义。不要凭 antd 经验编 API。',
    );
  }

  const knowledge: Array<Record<string, unknown>> = [];
  const layer = arch.find((s) => s.includes('架构分层') || s.includes('src/ 下现有目录'));
  if (layer) {
    knowledge.push({ id: 'PK-ARCH-001', topic: '分层', content: layer, enabled: true });
  }
  const data = arch.find((s) => s.includes('数据访问') || s.includes('bson'));
  if (data) {
    knowledge.push({ id: 'PK-ARCH-002', topic: '数据层', content: data, enabled: true });
  }
  const svc = arch.find((s) => s.includes('tRPC 服务') || s.includes('路由注册'));
  if (svc) {
    knowledge.push({ id: 'PK-ARCH-003', topic: '对外入口', content: svc, enabled: true });
  }
  const ui = arch.find((s) => s.includes('页面在 src/views') || s.includes('Tea 组件') || s.includes('UI 组件库'));
  if (ui) {
    knowledge.push({ id: 'PK-ARCH-004', topic: '前端结构', content: ui, enabled: true });
  }
  if (uiMcp) {
    knowledge.push({
      id: 'PK-UI-MCP',
      topic: '组件文档 MCP',
      content:
        '组件开发必须先查宿主 MCP「' +
        uiMcp +
        '」的组件文档/API/示例。repo-guard 的 lib_search 只回答「库里有没有这个组件」，具体 props 以该 MCP 为准。',
      enabled: true,
    });
  }
  if (rf && rf.publicLayer.length) {
    knowledge.push({
      id: 'PK-ARCH-005',
      topic: '公共层',
      content: '公共层以 .codebuddy/repo-facts.json 的 publicLayer 为准。改其中已有文件前必须先查影响面（code-atlas 的 atlas_impact）。',
      enabled: true,
    });
  }
  if (!knowledge.length && arch[0]) {
    knowledge.push({ id: 'PK-ARCH-001', topic: '本仓结构', content: arch[0], enabled: true });
  }

  const taboos = [
    '不要提交密钥、token、私钥。',
    '不要预测流水线结果。',
    '不要在配置里填写仓库中不存在的文档路径。',
    '不要为让测试绿而改断言或删用例。',
  ];
  if (dirs.includes('template') || dirs.includes('agent')) {
    taboos.splice(3, 0, '不要把客户端模板目录（agent/、template/）当成服务端主链路。');
  }
  if (internalSubs.includes('repo') && /mongo/i.test(gomod)) {
    taboos.splice(1, 0, '不要只改 bson 字符串键却不改 dto / 查询 filter。');
  }

  const stopConditions = [
    '需求有多种解读时停下来问人。',
    '发现需求与实现矛盾时停下来，不要自己选一边继续做。',
    '合入主干、发布、生产写必须由人决策。',
  ];
  if (authReq.length > 1) {
    stopConditions.splice(1, 0, '改鉴权、密钥、已发布接口时停下来问人。');
  }
  if (internalSubs.includes('repo') || srcSubs.includes('api')) {
    stopConditions.splice(-1, 0, '改存储字段或存量数据形态时停下来问人。');
  }

  return {
    _: '由 init 按本仓目录生成，不是模板拷贝。required 只含真实存在的路径。请人改 mission。已存在则不会覆盖。',
    mission,
    facts: arch.slice(0, 10),
    discipline: [
      '不许声称已测试——没跑过就说没跑过。',
      '不许编造字段名，必须来自本仓类型、契约或 README。',
      '不许为了让测试通过而改断言或删用例。',
      '功能变更里禁止夹带无关重构。',
      '与本次需求无关的脏代码只记录，不在本次改。',
    ],
    knowledge,
    taboos,
    stopConditions,
    taskRoutes: routes,
  };
}

export function writeFactsFromRepo(repoDir: string, dest: string): void {
  const body = buildFactsFromRepo(repoDir);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(body, null, 2) + '\n');
}

/** 已存在不覆盖。返回 write / skip。 */
export function ensureFactsFromRepo(repoDir: string, dest: string): 'write' | 'skip' {
  if (fs.existsSync(dest)) return 'skip';
  writeFactsFromRepo(repoDir, dest);
  return 'write';
}

export function factsInitNote(already: boolean): string {
  return already
    ? '工程事实（已存在，不覆盖）'
    : '工程事实（按本仓实况生成，required 只含真实路径，不抄模板）';
}
