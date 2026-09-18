/**
 * 红线体检器 —— 让红线从"人工写、会腐烂、没人知道烂了"变成"人写意图、机器验完整性"。
 *
 * ── 为什么必须有这个东西 ──
 * 手写红线有三种腐烂方式，而**人工review 一种都发现不了**：
 *   reviewer 能判断"这条红线该不该加"，但没法验证"paths 写全了没"、
 *   "evidence 的行号还准不准"、"protects 的符号是不是早就改名了"。
 *
 * 实测证据（anxin-console-server，第一版红线是我手写的）：
 *   RL-001 声明 paths: ["upgrade/*.sql", "app/service/**", "app/controller/**"]
 *   但 chain_status 实际还出现在
 *     · app/common/chain.js—— 不在声明范围，agent 在这删**不会被拦**
 *     · upgrade/v4.3.0.js     —— 后缀 .js 不是 .sql，同样漏掉
 *   我当时按"服务层/控制层/迁移"三个直觉分类写 paths，漏了 common/ 和
 *   .js 形式的迁移脚本。这就是"人写指针必然腐烂"的实例。
 *
 * ── 三项检查 ──
 *   A 存活性（liveness）    protects 的符号在代码里还存在吗？
 *                不存在 = 这条红线在守空气，该删或该改名。
 *   B 覆盖度（coverage）    声明的 paths 覆盖了符号的全部出现位置吗？
 *                          没覆盖的位置就是**后门**——最危险的一项。
 *   C 证据新鲜度（evidence） evidence 里的 file:line 还指得对吗？
 *                          行号漂移不影响判定（evidence 不参与判定），
 *                          但会让评审的人核对不到东西，进而不敢改红线。
 *
 * ── 一个刻意的设计 ──
 * 覆盖度判定复用 policy-engine 导出的 globMatch/ruleAppliesToPath，
 * **不自己写一套匹配**。否则会出现"体检说覆盖完整、运行时其实拦不住"，
 * 那比没有体检更危险 —— 它给出的是虚假的安全感。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeSnapshot, PolicyRule } from './types.js';
import { ruleAppliesToPath } from './policy-engine.js';
import { scanSql, findInSql, type SqlIndex } from './sql-scanner.js';
import { scanCode, findInCode, type CodeIndex } from './code-scanner.js';

/** 一处出现位置（合并 SQL 与源码两侧） */
export interface Occurrence {
  file: string;
  line: number;
  /** 来自哪个扫描器 */
  source: 'sql' | 'code';
  /** SQL 侧的语句类型 / 源码侧的 code|comment */
  kind: string;
  /** 是否被该规则的 paths 覆盖 */
  covered: boolean;
  text: string;
}

/** A 存活性 */
export interface LivenessFinding {
  protectedName: string;
  /**
   * 这一项是可索引的标识符吗。
   * false = 关键词型（如 `CREATE TABLE`），存活性检查对它无意义，
   * 这类规则靠 paths 生效，不该被报成"守空气"。
   */
  indexable: boolean;
  /** 在代码或 SQL 里找到了吗（indexable=false 时恒为 true，不参与判定） */
  alive: boolean;
  sqlCount: number;
  codeCount: number;
  /** 只在注释里出现 —— 高度可疑：可能已被删除，注释是遗留 */
  onlyInComments: boolean;
}

/** B 覆盖度 */
export interface CoverageFinding {
  protectedName: string;
  total: number;
  covered: number;
  /** 未被 paths 覆盖的位置 —— **这些就是后门** */
  gaps: Occurrence[];
  /** 建议补进 paths 的 glob（按目录归纳，避免一次列40 个文件） */
  suggestedPaths: string[];
}

/** C 证据新鲜度 */
export interface EvidenceFinding {
  /** evidence 原文里的一项，如 `upgrade/x.sql:1313` */
  raw: string;
  file: string;
  line: number | null;
  /** 文件还在吗 */
  fileExists: boolean;
  /** 该行确实含受保护标识符吗 */
  lineMatches: boolean;
  /** 若不匹配，同文件里最近的正确行号（供自动重定位） */
  suggestedLine: number | null;
}

/** 单条规则的体检结果 */
export interface RuleAudit {
  ruleId: string;
  rule: string;
  confirmed: boolean;
  enabled: boolean;
  /** 未声明 protects → 这条规则只能靠 prompt 自觉，运行时拦不住 */
  hasProtects: boolean;
  /** 未声明 paths → 全仓库生效，覆盖度检查无意义（不算缺陷） */
  pathsDeclared: boolean;
  liveness: LivenessFinding[];
  coverage: CoverageFinding[];
  evidence: EvidenceFinding[];
  /** 汇总严重度：这条规则最严重的问题 */
  severity: 'ok' | 'info' | 'warn' | 'error';
  /** 人话结论，直接可展示 */
  summary: string;
}

export interface AuditReport {
  ok: boolean;
  repoDir: string;
  ruleCount: number;
  rules: RuleAudit[];
  /** 全局统计 */
  stats: {
    /** 守空气的规则数（protects 全部找不到） */
    deadRules: number;
    /** 有覆盖缺口的规则数 */
    leakyRules: number;
    /** evidence 已失效的规则数 */
    staleEvidence: number;
    /** 未声明 protects 的规则数（拦不住，只能靠自觉） */
    unenforceable: number;
    /** 缺口位置总数 */
    totalGaps: number;
  };
  scanStats: { sqlFiles: number; codeFiles: number; ms: number };
  warnings: string[];
}

/** SQL 命中 → 统一的 Occurrence */
function fromSql(index: SqlIndex, name: string): Occurrence[] {
  return findInSql(index, name).map((h) => ({
    file: h.file,
    line: h.line,
    source: 'sql' as const,
    kind: h.kind,
    covered: false,
    text: h.text,
  }));
}

/** 源码命中 → 统一的 Occurrence（含注释命中，由调用方决定是否计入） */
function fromCode(index: CodeIndex, name: string): Occurrence[] {
  return findInCode(index, name, false).map((h) => ({
    file: h.file,
    line: h.line,
    source: 'code' as const,
    kind: h.kind,
    covered: false,
    text: h.text,
  }));
}

/**
 * 把一堆未覆盖文件归纳成少量 glob 建议。
 *
 * 为什么要归纳：实测 corp_id 有 24 个 SQL 文件命中，直接列 24 条 paths
 * 没人会接受。按目录+后缀归纳成 `upgrade/*.sql` 这种，才是能直接抄进配置的。
 */
function suggestPaths(gaps: Occurrence[]): string[] {
  const byDirExt = new Map<string, number>();
  for (const g of gaps) {
    const slash = g.file.lastIndexOf('/');
    const dir = slash > 0 ? g.file.slice(0, slash) : '';
    const dot = g.file.lastIndexOf('.');
    const ext = dot > 0 ? g.file.slice(dot) : '';
    const key = dir ? `${dir}/*${ext}` : `*${ext}`;
    byDirExt.set(key, (byDirExt.get(key) ?? 0) + 1);
  }
  // 同一目录下多个后缀较多时，退化成 dir/** 更简洁
  const dirs = new Map<string, Set<string>>();
  for (const key of byDirExt.keys()) {
    const m = key.match(/^(.*)\/\*(\.[^.]*)$/);
    if (m) {
      if (!dirs.has(m[1])) dirs.set(m[1], new Set());
      dirs.get(m[1])!.add(m[2]);
    }
  }
  const out: string[] = [];
  const consumed = new Set<string>();
  for (const [dir, exts] of dirs) {
    if (exts.size >= 3) {
      out.push(`${dir}/**`);
      for (const e of exts) consumed.add(`${dir}/*${e}`);
    }
  }
  for (const key of byDirExt.keys()) {
    if (!consumed.has(key)) out.push(key);
  }
  return [...new Set(out)].sort();
}

/**
 * 解析 evidence 字符串。
 *
 * 支持三种形态（都取自真实 policy.yaml）：
 *   `upgrade/x.sql:1313`                单项
 *   `app/controller/codeBatch.js:43-44` 行区间
 *   `app/controller/traceStats.js:408,426,446,465`  **同文件多行号简写**
 *   `a.js:1 · b.js:2`多文件用 · 分隔
 *
 * 第三种是踩过的坑：直接按分隔符切开后，`426` / `446` 这些后续项**丢了文件名**，
 * 体检会误报"文件不存在"。所以拆分时要记住上一项的文件名并继承。
 */
function parseEvidence(raw: string): Array<{ raw: string; file: string; line: number | null }> {
  if (!raw) return [];
  const out: Array<{ raw: string; file: string; line: number | null }> = [];
  let lastFile: string | null = null;

  for (const item of raw.split(/[·,；;]/).map((s) => s.trim()).filter(Boolean)) {
    // 纯数字（或数字区间）→ 继承上一项的文件名
    const bare = item.match(/^(\d+)(?:-\d+)?$/);
    if (bare && lastFile) {
      out.push({ raw: `${lastFile}:${item}`, file: lastFile, line: Number(bare[1]) });
      continue;
    }
    // `path:line` 或 `path:line-line`
    const m = item.match(/^(.*?):(\d+)(?:-\d+)?$/);
    if (m) {
      lastFile = m[1].trim();
      out.push({ raw: item, file: lastFile, line: Number(m[2]) });
      continue;
    }
    //纯描述文字（如"upgrade/ 目录下 48 个 migration 文件"）—— 无法校验，记为无行号
    out.push({ raw: item, file: item, line: null });
  }
  return out;
}

/**
 * protects 里的这一项是"可索引的标识符"吗。
 *
 * 实测RL-008 写的是 `protects: [CREATE TABLE, ALTER TABLE]` —— 这是**SQL 关键词**
 * 而非标识符。拿它去做存活性检查必然找不到（扫描器索引的是标识符），
 * 会误报"这条红线在守空气"。这类规则实际靠 paths 生效（禁改upgrade/ 下的文件），
 * 所以要识别出来单独说明，而不是当缺陷报。
 */
function isIndexableSymbol(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * 对一个仓库的全部红线做体检。
 *
 * @param snapshot knowledge-loader 的加载结果（含 red_lines）
 * @param repoDir  仓库根目录
 */
export function auditPolicy(snapshot: KnowledgeSnapshot, repoDir: string): AuditReport {
  const t0 = Date.now();
  const base: AuditReport = {
    ok: false,
    repoDir,
    ruleCount: 0,
    rules: [],
    stats: { deadRules: 0, leakyRules: 0, staleEvidence: 0, unenforceable: 0, totalGaps: 0 },
    scanStats: { sqlFiles: 0, codeFiles: 0, ms: 0 },
    warnings: [],
  };
  if (!snapshot?.ok || !repoDir) return base;

  const rules = (snapshot.policy?.red_lines ?? []).filter((r) => r.enabled !== false);
  if (!rules.length) return { ...base, ok: true, scanStats: { ...base.scanStats, ms: Date.now() - t0 } };

  // 一次性收集全部受保护标识符 —— 只扫需要的，不做全量符号索引
  const allNames = [...new Set(rules.flatMap((r) => r.protects ?? []))];

  const sqlIdx = scanSql(repoDir);
  const codeIdx = scanCode(repoDir, allNames);
  const warnings = [...sqlIdx.warnings, ...codeIdx.warnings];

  const fsExists = (rel: string): boolean => {
    try {
      return fs.existsSync(path.join(repoDir, rel));
    } catch {
      return false;
    }
  };

  const audits: RuleAudit[] = rules.map((rule) => audit1(rule, sqlIdx, codeIdx, fsExists));

  const stats = {
    deadRules: audits.filter((a) => {
      const ind = a.liveness.filter((l) => l.indexable);
      return ind.length > 0 && ind.every((l) => !l.alive);
    }).length,
    leakyRules: audits.filter((a) => a.coverage.some((c) => c.gaps.length > 0)).length,
    staleEvidence: audits.filter((a) =>
      a.evidence.some((e) => !e.fileExists || (e.line !== null && !e.lineMatches)),
    ).length,
    unenforceable: audits.filter((a) => !a.hasProtects).length,
    totalGaps: audits.reduce((s, a) => s + a.coverage.reduce((x, c) => x + c.gaps.length, 0), 0),
  };

  return {
    ok: true,
    repoDir,
    ruleCount: rules.length,
    rules: audits,
    stats,
    scanStats: { sqlFiles: sqlIdx.fileCount, codeFiles: codeIdx.fileCount, ms: Date.now() - t0 },
    warnings,
  };
}

/** 单条规则的三项检查 */
function audit1(
  rule: PolicyRule,
  sqlIdx: SqlIndex,
  codeIdx: CodeIndex,
  fsExists: (rel: string) => boolean,
): RuleAudit {
  const protects = rule.protects ?? [];
  const pathsDeclared = (rule.paths ?? []).length > 0;

  // ── A 存活性 ──
  const liveness: LivenessFinding[] = protects.map((name) => {
    if (!isIndexableSymbol(name)) {
      // 关键词型（含空格等），扫描器索引不到，不参与存活性判定
      return { protectedName: name, indexable: false, alive: true, sqlCount: 0, codeCount: 0, onlyInComments: false };
    }
    const sqlHits = findInSql(sqlIdx, name);
    const codeAll = findInCode(codeIdx, name, false);
    const codeReal = codeAll.filter((h) => h.kind === 'code');
    return {
      protectedName: name,
      indexable: true,
      alive: sqlHits.length > 0 || codeReal.length > 0,
      sqlCount: sqlHits.length,
      codeCount: codeReal.length,
      onlyInComments: codeReal.length === 0 && codeAll.length > 0&& sqlHits.length === 0,
    };
  });

  // ── B 覆盖度 ──
  const coverage: CoverageFinding[] = protects.filter(isIndexableSymbol).map((name) => {
    const occ = [...fromSql(sqlIdx, name), ...fromCode(codeIdx, name)]
      // 注释命中不计入覆盖度：agent 删注释不构成红线违规
      .filter((o) => !(o.source === 'code' && o.kind === 'comment'));
    for (const o of occ) o.covered = ruleAppliesToPath(rule, o.file);
    const gaps = occ.filter((o) => !o.covered);
    return {
      protectedName: name,
      total: occ.length,
      covered: occ.length - gaps.length,
      gaps,
      suggestedPaths: gaps.length ? suggestPaths(gaps) : [],
    };
  });

  // ── C 证据新鲜度 ──
  const evidence: EvidenceFinding[] = parseEvidence(rule.evidence ?? '').map((e) => {
    const exists = fsExists(e.file);
    let lineMatches = false;
    let suggestedLine: number | null = null;
    if (exists && e.line !== null && protects.length) {
      // 该行是否确实含任一受保护标识符
      const all = [
        ...protects.flatMap((n) => findInSql(sqlIdx, n)).map((h) => ({ file: h.file, line: h.line })),
        ...protects.flatMap((n) => findInCode(codeIdx, n)).map((h) => ({ file: h.file, line: h.line })),
      ].filter((h) => h.file === e.file);
      lineMatches = all.some((h) => h.line === e.line);
      if (!lineMatches && all.length) {
        // 给出同文件里最接近的行号，供自动重定位
        suggestedLine = all.reduce(
          (best, h) => (Math.abs(h.line - e.line!) < Math.abs(best - e.line!) ? h.line : best),
          all[0].line,
        );
      }
    }
    return { raw: e.raw, file: e.file, line: e.line, fileExists: exists, lineMatches, suggestedLine };
  });

  // ── 汇总严重度与人话结论 ──
  // 只用可索引项判"守空气"—— 全是关键词型的规则（如 RL-008）靠 paths 生效，不算缺陷
  const indexableLive = liveness.filter((l) => l.indexable);
  const dead = indexableLive.length > 0 && indexableLive.every((l) => !l.alive);
  const keywordOnly = liveness.length > 0 && indexableLive.length === 0;
  const gapCount = coverage.reduce((s, c) => s + c.gaps.length, 0);
  const evidenceBad = evidence.filter((e) => !e.fileExists || (e.line !== null && !e.lineMatches));

  let severity: RuleAudit['severity'] = 'ok';
  const notes: string[] = [];

  if (!protects.length) {
    severity = 'warn';
    notes.push('未声明 protects —— 运行时拦不住，只能靠 prompt 自觉');
  }
  if (keywordOnly) {
    if (severity === 'ok') severity = 'info';
    notes.push(
      `protects 是关键词而非标识符（${protects.join('、')}）—— 本规则靠 paths 生效，符号存活性检查不适用`,
    );
  }
  if (dead) {
    severity = 'error';
    notes.push(
      `受保护标识符在代码与 SQL 里都找不到（${indexableLive.map((l) => l.protectedName).join('、')}）—— 这条红线在守空气，应删除或更正`,
    );
  }
  if (gapCount > 0) {
    severity = 'error';
    notes.push(
      `有 ${gapCount} 处出现位置不在声明的 paths 内—— 这些位置是后门，agent 在那里改动不会被拦`,
    );
  }
  const commentsOnly = liveness.filter((l) => l.onlyInComments);
  if (commentsOnly.length) {
    if (severity === 'ok') severity = 'warn';
    notes.push(
      `${commentsOnly.map((l) => l.protectedName).join('、')} 只出现在注释里 —— 可能已被删除，注释是遗留`,
    );
  }
  if (evidenceBad.length) {
    if (severity === 'ok') severity = 'info';
    notes.push(
      `evidence 已失效 ${evidenceBad.length} 处（${evidenceBad
        .map((e) => (e.suggestedLine ? `${e.raw} → 建议 ${e.file}:${e.suggestedLine}` : e.raw))
        .join('；')}）`,
    );
  }
  if (rule.confirmed === false) {
    if (severity === 'ok') severity = 'info';
    notes.push('confirmed=false —— agent 只能当线索，不能当强事实');
  }

  return {
    ruleId: rule.id,
    rule: rule.rule,
    confirmed: rule.confirmed !== false,
    enabled: rule.enabled !== false,
    hasProtects: protects.length > 0,
    pathsDeclared,
    liveness,
    coverage,
    evidence,
    severity,
    summary: notes.length ? notes.join('；') : '三项检查全部通过',
  };
}

/** 生成人类可读的体检报告文本（供CLI / 界面 / 汇报使用） */
export function formatAuditReport(report: AuditReport): string {
  if (!report.ok) return '体检未执行（未配置 .knowledge/ 或目录无效）';
  const L: string[] = [];
  const s = report.stats;
  L.push(`红线体检 · ${report.repoDir}`);
  L.push(
    `规则 ${report.ruleCount} 条 · 扫描 ${report.scanStats.sqlFiles}个 SQL + ${report.scanStats.codeFiles} 个源码文件 · ${report.scanStats.ms}ms`,
  );
  L.push('');
  L.push(`守空气的规则   ${s.deadRules}`);
  L.push(`有覆盖缺口     ${s.leakyRules}（共 ${s.totalGaps} 处后门）`);
  L.push(`evidence 失效  ${s.staleEvidence}`);
  L.push(`拦不住（无 protects） ${s.unenforceable}`);
  L.push('');

  const ICON: Record<RuleAudit['severity'], string> = {
    ok: '✓',
    info: 'i',
    warn: '!',
    error: '✗',
  };
  for (const a of report.rules) {
    L.push(`${ICON[a.severity]} ${a.ruleId}  ${a.rule}`);
    if (a.severity !== 'ok') L.push(`    ${a.summary}`);
    for (const c of a.coverage) {
      if (!c.gaps.length) continue;
      L.push(`    ${c.protectedName}: ${c.covered}/${c.total} 被覆盖，缺口 ${c.gaps.length} 处`);
      for (const g of c.gaps.slice(0, 5)) {
        L.push(`      ⚠ ${g.file}:${g.line} [${g.source}/${g.kind}]`);
      }
      if (c.gaps.length > 5) L.push(`      ...还有 ${c.gaps.length - 5} 处`);
      if (c.suggestedPaths.length) {
        L.push(`      建议补进 paths: ${c.suggestedPaths.join(', ')}`);
      }
    }
  }
  return L.join('\n');
}
