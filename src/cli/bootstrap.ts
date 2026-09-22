/**
 * init --all：一次铺齐控制文件。
 *
 * 不能并进默认的 `init --write`：那条命令的 stdout 被 parity 逐字节锁死。
 * --all 是新开关，不改变原 init --write 的输出。
 */
import fs from 'node:fs';
import path from 'node:path';

import { runGuardInit } from '../gates/guard-init.js';
import { readFacts } from '../runtime/repo-facts.js';
import { runLayersInit } from './layers-init.js';
import { runRedlinesInit } from './redlines.js';
import { runStandardsInit } from './standards.js';
import { RULE } from './render.js';
import { buildFactsFromRepo } from './facts-from-repo.js';

export interface BootstrapResult {
  text: string;
  exitCode: number;
}

function hasContextFile(repoDir: string): boolean {
  return ['CODEBUDDY.md', 'CLAUDE.md', path.join('.codebuddy', 'CODEBUDDY.md')].some((f) =>
    fs.existsSync(path.join(repoDir, f)),
  );
}

function writeCodebuddyIfMissing(repoDir: string, write: boolean): string {
  const dest = path.join(repoDir, 'CODEBUDDY.md');
  if (hasContextFile(repoDir)) {
    return write
      ? 'CODEBUDDY.md 已存在（或 CLAUDE.md / .codebuddy/CODEBUDDY.md），跳过。'
      : '将跳过 CODEBUDDY.md（已有项目上下文文件）。';
  }
  const tpl = path.resolve(__dirname, '..', 'layers', 'facts', 'CODEBUDDY.snippet.md');
  let body = '';
  try {
    body = fs.readFileSync(tpl, 'utf-8');
  } catch {
    body = '# 本仓工程事实\n\n- 公共层目录以 .codebuddy/repo-facts.json 的 publicLayer 为准。\n';
  }
  const facts = readFacts(repoDir);
  if (facts?.publicLayer.length) {
    body += '\n- 本次 init 推测/已确认的公共层：' + facts.publicLayer.join('、') + '。请人过一眼。\n';
  }
  const generated = buildFactsFromRepo(repoDir);
  const arch = Array.isArray(generated.facts) ? (generated.facts as string[]) : [];
  if (arch.length) {
    body += '\n## 本仓架构（init 按目录生成，请人改）\n\n';
    for (const line of arch) {
      body += '- ' + line + '\n';
    }
  }
  if (!write) return '将写入  CODEBUDDY.md  （工程事实短骨架 + 本仓架构，已存在则跳过）';
  fs.writeFileSync(dest, body.endsWith('\n') ? body : body + '\n');
  return '已写入  CODEBUDDY.md  （工程事实短骨架 + 本仓架构，请人过一眼）';
}

export function runBootstrap(repoDir: string, write: boolean): BootstrapResult {
  const lines = ['', 'repo-guard · 一次铺齐（--all）', RULE];
  if (!write) {
    lines.push('下面只预览。要落盘请：repo-guard init --write --all', '');
  }

  const cb = writeCodebuddyIfMissing(repoDir, write);
  lines.push(cb, '');

  const parts = [
    runRedlinesInit(repoDir, write),
    runGuardInit(repoDir, write),
    runStandardsInit(repoDir, write),
    runLayersInit(repoDir, write),
  ];
  let code = 0;
  for (const p of parts) {
    lines.push(p.text.replace(/^\n/, '').trimEnd(), '');
    if (p.exitCode > code) code = p.exitCode;
  }
  return { text: lines.join('\n') + '\n', exitCode: code };
}
