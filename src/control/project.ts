/**
 * 仓库识别：技术栈、验收命令候选、已有的 pre-commit / CI、红线建议；以及合并门的写入。
 * init 和 status 共用。只读文件，不执行仓库里的任何命令。
 */
import fs from 'node:fs';
import path from 'node:path';

import { readJson } from '../runtime/paths.js';

export interface Candidate {
  value: string;
  /** 推测依据，展示给人 */
  why: string;
  /** 默认是否勾选 */
  checked: boolean;
}

export interface RedlineSuggestion {
  glob: string;
  action: 'ask' | 'block';
  reason: string;
  checked: boolean;
}

export type GateKind = 'husky' | 'lefthook' | 'pre-commit' | 'ci' | 'local';

export interface GateTarget {
  kind: GateKind;
  /** 仓库相对路径 */
  file: string;
  /** 会进 git、影响团队 */
  shared: boolean;
  /** 这个文件里已经有 repo-guard check */
  installed: boolean;
  /** 能否自动追加（Jenkinsfile 等结构复杂的只打印片段） */
  editable: boolean;
}

function exists(repoDir: string, rel: string): boolean {
  try {
    fs.statSync(path.join(repoDir, rel));
    return true;
  } catch {
    return false;
  }
}

function read(repoDir: string, rel: string): string {
  try {
    return fs.readFileSync(path.join(repoDir, rel), 'utf-8');
  } catch {
    return '';
  }
}

interface Pkg {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function detectStack(repoDir: string): string {
  const parts: string[] = [];
  const pkg = readJson<Pkg>(path.join(repoDir, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const fw = deps.react ? 'React' : deps.vue ? 'Vue' : deps['@angular/core'] ? 'Angular' : deps.express || deps.koa ? 'Node 服务' : 'Node';
    parts.push(fw + (deps.typescript || exists(repoDir, 'tsconfig.json') ? ' + TS' : ''));
  }
  if (exists(repoDir, 'go.mod')) {
    const mod = read(repoDir, 'go.mod');
    const goVer = /^go\s+([\d.]+)/m.exec(mod)?.[1];
    parts.push('Go' + (goVer ? ' ' + goVer : '') + (/trpc/.test(mod) ? ' + trpc' : /gin-gonic/.test(mod) ? ' + gin' : ''));
  }
  if (exists(repoDir, 'pom.xml') || exists(repoDir, 'build.gradle')) parts.push('Java');
  if (exists(repoDir, 'pyproject.toml') || exists(repoDir, 'requirements.txt')) parts.push('Python');
  return parts.join('、') || '未识别';
}

function runner(repoDir: string): string {
  if (exists(repoDir, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(repoDir, 'yarn.lock')) return 'yarn';
  return 'npm run';
}

/** 验收命令候选。宁缺毋滥：识别不出就空着，让人自己填 */
export function guessVerifyCommands(repoDir: string): Candidate[] {
  const out: Candidate[] = [];
  const add = (value: string, why: string, checked = true) => {
    if (!out.some((c) => c.value === value)) out.push({ value, why, checked });
  };
  const pkg = readJson<Pkg>(path.join(repoDir, 'package.json'));
  const scripts = pkg?.scripts ?? {};
  const run = runner(repoDir);
  for (const name of ['lint', 'typecheck', 'type-check', 'tsc', 'test']) {
    const body = scripts[name];
    if (!body) continue;
    if (name === 'test' && /no test specified/.test(body)) continue;
    const autoFix = [scripts['pre' + name], body, scripts['post' + name]]
      .some((s) => typeof s === 'string' && /(?:^|\s)--(?:fix|write)(?=\s|=|$)/.test(s));
    add(run + ' ' + name, '来自 package.json 的 scripts.' + name + (autoFix ? '（含自动修复，会写文件；默认不选，请改用只读检查）' : ''), !autoFix);
  }
  const make = read(repoDir, 'Makefile');
  const targets = new Set([...make.matchAll(/^([A-Za-z][\w-]*)\s*:/gm)].map((m) => m[1]));
  for (const t of ['lint', 'vet', 'test']) if (targets.has(t)) add('make ' + t, '来自 Makefile 的 ' + t + ' 目标');
  if (exists(repoDir, 'go.mod')) {
    if (!targets.has('build')) add('go build ./...', '来自 go.mod（Go 工程）');
    if (!targets.has('test')) add('go test ./...', '来自 go.mod（Go 工程）');
  }
  if (exists(repoDir, 'pyproject.toml') && (exists(repoDir, 'tests') || /pytest/.test(read(repoDir, 'pyproject.toml')))) add('pytest', '来自 pyproject.toml');
  return out;
}

const CI_FILES = ['.orange-ci.yml', '.code.yml', '.coding-ci.yml', '.gitlab-ci.yml'];

/** 合并门可以挂的位置。shared=true 的会进 git */
export function detectGates(repoDir: string): GateTarget[] {
  const out: GateTarget[] = [];
  const add = (kind: GateKind, file: string, shared: boolean, editable = true) =>
    out.push({ kind, file, shared, editable, installed: /repo-guard\s+check/.test(read(repoDir, file)) });
  if (exists(repoDir, '.husky/pre-commit')) add('husky', '.husky/pre-commit', true);
  for (const f of ['lefthook.yml', '.lefthook.yml', 'lefthook.yaml']) if (exists(repoDir, f)) add('lefthook', f, true);
  if (exists(repoDir, '.pre-commit-config.yaml')) add('pre-commit', '.pre-commit-config.yaml', true);
  // CI 配置格式各异（阶段、镜像、触发条件），不自动改，只打印可复制的步骤
  for (const f of CI_FILES) if (exists(repoDir, f)) add('ci', f, true, false);
  try {
    for (const f of fs.readdirSync(path.join(repoDir, '.github', 'workflows'))) {
      if (/\.ya?ml$/.test(f)) add('ci', '.github/workflows/' + f, true, false);
    }
  } catch {
    /* 没有 GitHub Actions */
  }
  if (exists(repoDir, 'Jenkinsfile')) add('ci', 'Jenkinsfile', true, false);
  if (exists(repoDir, '.git') && fs.statSync(path.join(repoDir, '.git')).isDirectory()) add('local', '.git/hooks/pre-commit', false);
  return out;
}

function walk(repoDir: string, limit = 4000): string[] {
  const out: string[] = [];
  const stack = [''];
  while (stack.length && out.length < limit) {
    const rel = stack.pop()!;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(path.join(repoDir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) stack.push(r);
      else out.push(r);
    }
  }
  return out;
}

/** 红线建议：只给仓里确实存在的。生成物默认勾选（本来就不该手改），其余默认不勾 */
export function suggestRedlines(repoDir: string): RedlineSuggestion[] {
  const files = walk(repoDir);
  const out: RedlineSuggestion[] = [];
  const has = (re: RegExp) => files.some((f) => re.test(f));
  if (has(/\.pb\.go$/)) out.push({ glob: '**/*.pb.go', action: 'block', reason: 'protobuf 生成代码，改 .proto 后重新生成', checked: true });
  if (has(/(^|\/)(generated|__generated__)\//) || has(/\.generated\.[a-z]+$|_generated\.go$/)) {
    out.push({ glob: has(/(^|\/)generated\//) ? '**/generated/**' : '**/*.generated.*', action: 'block', reason: '生成物，不要手改', checked: true });
  }
  for (const d of ['vendor', 'third_party']) {
    if (files.some((f) => f.startsWith(d + '/'))) out.push({ glob: d + '/**', action: 'block', reason: '第三方代码，应改上游', checked: true });
  }
  const mig = files.find((f) => /(^|\/)(migrations?|migrate)\//.test(f));
  if (mig) {
    const dir = mig.slice(0, mig.search(/(migrations?|migrate)\//)) + mig.match(/(migrations?|migrate)\//)![0];
    out.push({ glob: dir + '**', action: 'ask', reason: '数据迁移，改动不可逆', checked: false });
  }
  const i18n = files.find((f) => /(^|\/)(i18n|locales?)\//.test(f));
  if (i18n) {
    const dir = i18n.slice(0, i18n.search(/(i18n|locales?)\//)) + i18n.match(/(i18n|locales?)\//)![0];
    out.push({ glob: dir + '**', action: 'ask', reason: '多语言文案通常由专人维护', checked: false });
  }
  return out.filter((s, i) => out.findIndex((x) => x.glob === s.glob) === i);
}

// ══════════════════ 合并门写入 ══════════════════

export const CHECK_STAGED = 'repo-guard check --staged';

export function ciSnippet(): string {
  return 'repo-guard check --base origin/$TARGET_BRANCH   # 目标分支变量按你们的流水线改';
}

/** 往指定位置追加合并门。返回改动说明；已存在则跳过 */
export function installGate(repoDir: string, t: GateTarget): { changed: boolean; note: string; preview: string } {
  const abs = path.join(repoDir, t.file);
  const body = read(repoDir, t.file);
  if (/repo-guard\s+check/.test(body)) return { changed: false, note: t.file + ' 里已经有 repo-guard check，跳过', preview: '' };
  if (!t.editable) return { changed: false, note: t.file + ' 结构复杂，不自动改。请手动加一步：' + ciSnippet(), preview: '' };
  // 共享 hook 进 git，不能写某个人机器上的绝对路径：PATH 上没有 repo-guard 就跳过、不挡提交。
  // 本机 hook 只对自己生效，直接写当前 CLI 的绝对路径
  const shellLine = t.shared
    ? 'if command -v repo-guard >/dev/null 2>&1; then ' + CHECK_STAGED + '; fi'
    : '"' + process.execPath + '" "' + (process.argv[1] ?? 'repo-guard') + '" check --staged';
  let next = body;
  let preview = '';
  switch (t.kind) {
    case 'husky':
    case 'local': {
      const head = body ? '' : '#!/bin/sh\n';
      preview = shellLine;
      next = (body && !body.endsWith('\n') ? body + '\n' : body) + head + shellLine + '\n';
      break;
    }
    case 'lefthook': {
      preview = '  commands:\n    repo-guard:\n      run: ' + shellLine;
      if (/^pre-commit:\s*$/m.test(body) && /^pre-commit:\s*\n(\s+)commands:\s*$/m.test(body)) {
        next = body.replace(/^(pre-commit:\s*\n\s+commands:\s*\n)/m, '$1    repo-guard:\n      run: ' + shellLine + '\n');
      } else if (!/^pre-commit:/m.test(body)) {
        next = (body && !body.endsWith('\n') ? body + '\n' : body) + 'pre-commit:\n  commands:\n    repo-guard:\n      run: ' + shellLine + '\n';
      } else {
        return { changed: false, note: t.file + ' 的 pre-commit 段结构不认识，请手动加：repo-guard: { run: ' + CHECK_STAGED + ' }', preview: '' };
      }
      break;
    }
    case 'pre-commit': {
      const block = '  - repo: local\n    hooks:\n      - id: repo-guard\n        name: repo-guard check\n        entry: ' + CHECK_STAGED + '\n        language: system\n        pass_filenames: false\n';
      preview = block;
      if (!/^repos:\s*$/m.test(body)) return { changed: false, note: t.file + ' 没有 repos: 段，请手动加 local hook：' + CHECK_STAGED, preview: '' };
      next = body.replace(/^repos:\s*\n/m, 'repos:\n' + block);
      break;
    }
    case 'ci':
      return { changed: false, note: ciSnippet(), preview: '' };
  }
  return { changed: true, note: '已在 ' + t.file + ' 追加 ' + CHECK_STAGED, preview: write(abs, next, preview) };
}

function write(abs: string, body: string, preview: string): string {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  if (abs.includes(path.join('.git', 'hooks')) || abs.includes(path.join('.husky', ''))) {
    try {
      fs.chmodSync(abs, 0o755);
    } catch {
      /* 权限改不了：git 会提示 hook 不可执行 */
    }
  }
  return preview;
}