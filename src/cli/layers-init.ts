/**
 * layers init —— 把七层里需要进项目仓的骨架铺过去。
 * 已存在不覆盖。默认不写。
 * facts.json 不拷模板：按本仓目录生成，required 只含真实路径。
 */
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_DIR } from '../runtime/paths.js';
import { RULE } from './text.js';
import { ensureFactsFromRepo, factsInitNote } from './facts-from-repo.js';

export interface LayersInitResult {
  text: string;
  exitCode: number;
}

/** 产物在 bin/ 下，layers/ 在仓库根（与 bin/ 同级） */
function layersRoot(): string {
  return path.resolve(__dirname, '..', 'layers');
}

interface CopyJob {
  fromRel: string;
  toRel: string;
  note: string;
}

const JOBS: CopyJob[] = [
  { fromRel: path.join('human-review', 'ask.json'), toRel: path.join(CONFIG_DIR, 'human-review.json'), note: '人审开关，默认关' },
  { fromRel: path.join('merge-gates', 'permissions.ask.example.json'), toRel: path.join(CONFIG_DIR, 'merge-gates.example.json'), note: '合并门禁示例' },
  { fromRel: 'project-README.md', toRel: path.join(CONFIG_DIR, 'README.md'), note: '怎么配（请先看）' },
];

export function runLayersInit(repoDir: string, write: boolean): LayersInitResult {
  const root = layersRoot();
  const lines: string[] = [];
  let skipped = 0;
  let written = 0;
  let missing = 0;
  const factsRel = path.join(CONFIG_DIR, 'facts.json');
  const factsDest = path.join(repoDir, factsRel);
  const factsExists = fs.existsSync(factsDest);

  if (!write) {
    lines.push('', '将铺这些文件（已存在的会跳过）。加 --write 才落盘。', '');
    lines.push('  ' + (factsExists ? 'skip' : 'new ') + '  ' + factsRel + '  -- ' + factsInitNote(factsExists));
    for (const j of JOBS) {
      const dest = path.join(repoDir, j.toRel);
      const exists = fs.existsSync(dest);
      lines.push('  ' + (exists ? 'skip' : 'new ') + '  ' + j.toRel + '  -- ' + j.note);
    }
    lines.push('', RULE);
    return { text: lines.join('\n') + '\n', exitCode: 0 };
  }

  const factsAct = ensureFactsFromRepo(repoDir, factsDest);
  if (factsAct === 'skip') {
    skipped += 1;
    lines.push('  skip  ' + factsRel);
  } else {
    written += 1;
    lines.push('  write ' + factsRel + '  -- ' + factsInitNote(false));
  }

  for (const j of JOBS) {
    const from = path.join(root, j.fromRel);
    const dest = path.join(repoDir, j.toRel);
    if (!fs.existsSync(from)) {
      missing += 1;
      lines.push('  miss  ' + from);
      continue;
    }
    if (fs.existsSync(dest)) {
      skipped += 1;
      lines.push('  skip  ' + j.toRel);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(from, dest);
    written += 1;
    lines.push('  write ' + j.toRel + '  -- ' + j.note);
  }
  const head = ['', '已写 ' + written + '，跳过 ' + skipped + '，缺模板 ' + missing + '。', ''];
  return { text: head.concat(lines, ['', RULE]).join('\n') + '\n', exitCode: missing ? 1 : 0 };
}
