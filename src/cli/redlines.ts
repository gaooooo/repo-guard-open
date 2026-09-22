/**
 * `redlines init [--write]` —— 把部门级红线模板铺进仓库。
 *
 * ── 为什么是独立子命令，而不是并进 `repo-guard init --write` ──
 * `init --write` 的 stdout 被 5 条 parity 用例逐字节守着（每个 fixture 一条）。
 * 在那里多打一行「已写入 redlines.json」会让它们全红，而且**无法通过对齐修复**：
 * 基线产物在 `build/baseline/` 下，它解析出的 `layers/` 路径不存在，
 * 所以基线永远看不见模板、永远不会拷贝。两侧行为必然不同。
 *
 * 把它拆成独立命令之后，`init` 的输出一个字节都没变，而这条新命令没有任何
 * parity 用例覆盖 —— 代价只有 `help` 文本多一行，而 `help` 早已登记为已知偏差。
 *
 * 顺带的好处是四个 init 终于对称了，各管一份配置：
 *   repo-guard init            → repo-facts.json  事实
 *   repo-guard redlines init   → redlines.json    红线意图
 *   repo-guard guard init      → guard/           七道门
 *   repo-guard standards init  → standards/       研发规范
 */
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_DIR } from '../runtime/paths.js';
import { redlinesFile, redlinesTemplateFile } from '../runtime/redlines.js';
import { RULE } from './render.js';
import type { StandardsResult } from './standards.js';

export function runRedlinesInit(repoDir: string, write: boolean): StandardsResult {
  const tpl = redlinesTemplateFile();
  const dst = redlinesFile(repoDir);
  const lines = ['', 'repo-guard · 部门红线模板', RULE];

  if (!fs.existsSync(tpl)) {
    return {
      text:
        `${lines.join('\n')}\n\n找不到红线模板：${tpl}\n` +
        '`bin/repo-guard` 与 layers/ 必须在同一个插件目录下。\n',
      exitCode: 2,
    };
  }

  lines.push(`模板    ${tpl}`, `目标    ${CONFIG_DIR}/redlines.json`);

  // 绝不覆盖。红线是人写的意图，重跑一次冲掉是不可接受的数据丢失 ——
  // 与 guard init / standards init 同一条纪律
  if (fs.existsSync(dst)) {
    lines.push(
      '',
      '已存在，**不会覆盖**。',
      '模板若有新增条目，对照 layers/redlines/redlines.json 自己补。',
      '',
      '改完跑 `repo-guard audit` —— 它验的是完整性：paths 写全了没、',
      'protects 的符号还在不在、evidence 的行号还准不准。',
    );
    return { text: `${lines.join('\n')}\n`, exitCode: 0 };
  }

  lines.push(
    '',
    '铺过去之后做三件事：',
    '  1. 进 git —— 红线是团队共识，要跟代码走同一个 PR',
    '  2. 把示例条目换成本仓真实的受保护字段；rules 为空不拦任何东西',
    '  3. 跑 `repo-guard audit` 验完整性，跑 `bin/verify-hooks.mjs` 确认没误伤',
  );

  if (!write) {
    lines.push('', '要写入请加 --write');
    return { text: `${lines.join('\n')}\n`, exitCode: 0 };
  }

  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(tpl, dst);
  } catch (e) {
    lines.push('', `写入失败：${(e as Error).message}`);
    return { text: `${lines.join('\n')}\n`, exitCode: 1 };
  }

  lines.push('', `已写入  ${CONFIG_DIR}/redlines.json`);
  return { text: `${lines.join('\n')}\n`, exitCode: 0 };
}
