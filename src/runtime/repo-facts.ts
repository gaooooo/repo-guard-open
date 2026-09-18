/**
 * repo-facts —— `.codebuddy/repo-facts.json` 的读写与公共层判定。
 *
 * 这份文件回答两个问题：**哪些目录是公共层**、**单文件行数上限多少**。
 * 它是整个写前守卫的开关：文件不存在 = 守卫完全不生效（fail-open）。
 *
 * ── 为什么"没有配置就不拦" ──
 * 绝不能因为工具没配好就把人挡在外面。一个刚 clone 下来、还没跑过 `init` 的仓库
 * 里，AI 必须照常能干活；守卫未生效这件事在会话开始时明说一次就够了。
 * 这条是 verify-hooks 的 F1/F2 用例。
 *
 * ── 为什么公共层是"人确认过的清单"而不是每次现猜 ──
 * `init` 能从图谱推测出公共层（被多个入口引用的目录），但各仓目录约定不一样，
 * 猜错要么漏拦、要么**天天误伤** —— 后者会让人直接卸载插件。
 * 所以推测结果必须落到文件里让人过一眼，而不是运行时悄悄生效。
 */
import fs from 'node:fs';

import { configPath, readJson, writeJson } from './paths.js';

/** 行数上限的缺省值。超过只提醒不拦 —— 存量超长文件遍地都是，硬拦等于没法干活 */
export const DEFAULT_LINE_LIMIT = 500;

export interface RepoFacts {
  version: number;
  /** 建图用的分析器名（web-frontend / go-gin / …）。null = 未识别 */
  analyzer: string | null;
  /** 公共层目录前缀，形如 `src/components/`。空数组 = 不拦任何文件 */
  publicLayer: string[];
  /** UI 组件库包名，如 `antd`。null = 本仓没有或识别不出 */
  componentLibrary: string | null;
  lineLimit: number;
  generatedAt: string;
}

export function factsFile(repoDir: string): string {
  return configPath(repoDir, 'repo-facts.json');
}

/**
 * 读配置。**任何异常都返回 null**（= 守卫不生效）。
 *
 * 字段逐个校验并给默认值：一份手写残缺的 JSON 不能让工具崩，
 * 但 `publicLayer` 不是数组时必须退成空数组而不是报错 ——
 * 拿一个坏值去做前缀匹配会产生不可预期的拦截。
 */
export function readFacts(repoDir: string): RepoFacts | null {
  const raw = readJson<Partial<RepoFacts>>(factsFile(repoDir));
  if (!raw) return null;
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    analyzer: typeof raw.analyzer === 'string' ? raw.analyzer : null,
    publicLayer: Array.isArray(raw.publicLayer)
      ? raw.publicLayer.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [],
    componentLibrary: typeof raw.componentLibrary === 'string' ? raw.componentLibrary : null,
    lineLimit:
      typeof raw.lineLimit === 'number' && raw.lineLimit > 0 ? raw.lineLimit : DEFAULT_LINE_LIMIT,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
  };
}

export function writeFacts(repoDir: string, facts: RepoFacts): void {
  writeJson(factsFile(repoDir), facts);
}

/**
 * 公共层前缀归一：统一成 `目录/` 形态。
 *
 * 末尾那个斜杠是**不误伤同名前缀目录的关键**：
 * `src/components` 会前缀匹配到 `src/components-legacy/old.tsx`，
 * `src/components/` 不会。这条是 verify-hooks 的 T1 用例。
 */
export function normalizePrefix(p: string): string {
  const s = p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!s) return '';
  // 显式写成 glob 的（`src/components/**`）先剥掉 glob 段
  const cleaned = s.replace(/\/?\*+$/, '');
  return cleaned.endsWith('/') ? cleaned : `${cleaned}/`;
}

/**
 * 这个仓库相对路径是否落在公共层里。
 *
 * @param rel 已经归一过的仓库相对路径（posix 分隔）
 */
export function inPublicLayer(facts: RepoFacts, rel: string): string | null {
  for (const raw of facts.publicLayer) {
    const prefix = normalizePrefix(raw);
    if (prefix && rel.startsWith(prefix)) return prefix;
  }
  return null;
}

/**
 * 数一个文件多少行。读不到返回 0（当作没超限）。
 *
 * 用 `split('\n').length` 而不是"减掉末尾空行"：这与 `wc -l`（数换行符个数）
 * 差一行，但与**编辑器显示的行号**一致 —— 一个 620 行代码 + 末尾换行的文件，
 * 编辑器光标能停在第 621 行。提醒里的数字要能和人打开文件看到的对上，
 * 不然人会以为工具算错了。
 */
export function countLines(abs: string): number {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return 0;
    // 超大文件不读全文：行数上限判定只需要知道"超没超"，
    // 而把一个 50MB 的文件读进内存只为数行数是不值得的
    if (st.size > 8 * 1024 * 1024) return Number.MAX_SAFE_INTEGER;
    const body = fs.readFileSync(abs, 'utf-8');
    if (!body) return 0;
    return body.split('\n').length;
  } catch {
    return 0;
  }
}
