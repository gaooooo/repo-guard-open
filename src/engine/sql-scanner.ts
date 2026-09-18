/**
 * SQL 扫描器 —— 补上代码图谱的盲区。
 *
 * 为什么需要它（这是裸探测跑出来的事实，不是设计推演）：
 *   `chain_status` 在 anxin-console-server 里有 18 处 JS 引用 + **4 个 .sql 文件**的引用，
 *   而 RL-001 最核心的 evidence 就是 `upgrade/anxin-v3.2.0-all.sql:1313`。
 *   我们8 条红线里有 6 条保护的是数据库字段 —— SQL 才是主战场。
 *   JS AST 解析器（@babel/parser）对 .sql 一无所知，这个盲区不补，
 *   "图谱能自动算paths"这个前提就只成立一半，红线也就不敢离开仓库。
 *
 * 为什么不用完整 SQL parser：
 *   我们不需要理解语义、不需要执行计划，只需要三件事——
 *     ① 某个字段属于哪张表（关键：`chain_status` 同时存在于 trace_data 和
 *        track_info，注释语义还不同；只报行号会误报到别的表上）
 *     ② 该字段在哪些文件的哪些行被定义/变更
 *     ③ DDL 变更史（这个字段被 ADD / CHANGE / DROP 过几次）
 *   逐行状态机足够，且对 38 个文件 / 最大 400KB 的输入是毫秒级。
 *   引入 SQL parser 反而要处理 MySQL 方言、注释、DELIMITER 等一堆无关麻烦。
 *
 * 实测输入形态（决定了下面的正则）：
 *   CREATE TABLE `trace_data` (
 *     `chain_status` tinyint(4) NOT NULL DEFAULT '0' COMMENT '上链状态 0: 未上链...',
 *   ALTER TABLE `xxx` ADD COLUMN `yyy` varchar(64) ...
 *   ALTER TABLE `xxx` CHANGE COLUMN `old` `new` int ...
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './shims/logger.js';

const logger = createLogger('sql-scanner');

/** 一处字段出现位置 */
export interface SqlColumnHit {
  /** 相对仓库根的路径，如 `upgrade/anxin-v3.2.0-all.sql` */
  file: string;
  line: number;
  /** 所属表名（小写）。CREATE TABLE 块内或 ALTER TABLE 的目标 */
  table: string;
  /**
   * 这一行在做什么：
   *   define  —— CREATE TABLE 块内的列定义
   *   add     —— ALTER TABLE ... ADD COLUMN
   *   change  —— ALTER TABLE ... CHANGE/MODIFY COLUMN（改类型或改名）
   *   drop—— ALTER TABLE ... DROP COLUMN（**最危险，红线主要防这个**）
   *   index   —— 出现在 KEY / UNIQUE KEY 定义里
   *   ref     —— 其他引用（INSERT 列清单、WHERE 等）
   */
  kind: 'define' | 'add' | 'change' | 'drop' | 'index' | 'ref';
  /** 该行原文（截断），供体检报告展示 */
  text: string;
}

/** 一张表的结构快照 */
export interface SqlTable {
  name: string;
  /** 首次 CREATE TABLE 的位置 */
  definedAt?: { file: string; line: number };
  /** 列名集合（含后续 ALTER 加的） */
  columns: Set<string>;
  /** 被 DROP COLUMN 过的列—— 说明这个字段历史上真的被删过*/
  droppedColumns: Set<string>;
}

export interface SqlIndex {
  ok: boolean;
  /** 扫了几个文件 */
  fileCount: number;
  /** 表名 → 结构 */
  tables: Map<string, SqlTable>;
  /**
   * 字段名 → 出现位置列表。
   * **不带表限定**，因为红线的 protects 写的就是裸字段名（如 `chain_status`）；
   * 表归属放在每个 hit 的 `table` 字段里，由调用方按需筛。
   */
  columnHits: Map<string, SqlColumnHit[]>;
  /** 扫描期的告警（不阻塞，只提示） */
  warnings: string[];
  scannedAt: number;
}

const MAX_TEXT = 160;
/** 单文件大小上限：实测最大 400KB，留足余量同时防炸 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** 去掉反引号/引号，统一小写 —— MySQL 标识符大小写不敏感 */
function normIdent(s: string): string {
  return s.replace(/[`"'\[\]]/g, '').trim().toLowerCase();
}

/**
 * 清理索引列清单里的单个列名。
 * 实测要处理两种后缀：`\`corp_id\` ASC` 的排序方向、`\`name\`(20)` 的前缀长度。
 * 不处理会导致 15 处漏检（正则^[a-z_]\w*$ 把带空格的挡掉了）。
 */
function normIndexCol(s: string): string {
  return normIdent(s.replace(/\(\d+\)/, '').replace(/\s+(ASC|DESC)\s*$/i, ''));
}

/** 从 `CREATE TABLE IF NOT EXISTS \`x\`` / `ALTER TABLE \`db\`.\`x\`` 里取表名 */
function matchTableStmt(line: string): { table: string; alter: boolean } | null {
  // 允许 `db`.`tbl` 形式：先整段抓下来再取最后一节
  const create = line.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:[`"\w]+\.)?[`"\w]+)/i);
  if (create) return { table: normIdent(create[1].split('.').pop()!), alter: false };
  const alter = line.match(/ALTER\s+TABLE\s+((?:[`"\w]+\.)?[`"\w]+)/i);
  if (alter) return { table: normIdent(alter[1].split('.').pop()!), alter: true };
  return null;
}

/**
 * 扫一个仓库的 SQL 文件。
 *
 * 全程 try/catch 且返回 `ok:false` 而非抛错—— 照knowledge-loader 的容错姿势：
 * 知识层故障绝不能阻塞 ReAct，最差退化成"没有 SQL 索引"。
 */
export function scanSql(repoDir: string, opts?: { dirs?: string[] }): SqlIndex {
  const empty: SqlIndex = {
    ok: false,
    fileCount: 0,
    tables: new Map(),
    columnHits: new Map(),
    warnings: [],
    scannedAt: Date.now(),
  };
  if (!repoDir) return empty;

  const warnings: string[] = [];
  const files: string[] = [];

  // 默认只扫常见的迁移目录 + 根目录，避免把 node_modules 里的 .sql 也拖进来
  const roots = (opts?.dirs ?? ['upgrade', 'migrations', 'sql', 'db', '.']).map((d) =>
    path.join(repoDir, d),
  );

  try {
    for (const root of roots) {
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (!e.isFile() || !e.name.toLowerCase().endsWith('.sql')) continue;
        const full = path.join(root, e.name);
        if (files.includes(full)) continue;
        files.push(full);
      }
    }
  } catch (err) {
    warnings.push(`枚举 SQL 文件失败：${(err as Error).message}`);
    return { ...empty, warnings };
  }

  if (!files.length) return { ...empty, ok: true, warnings };

  const tables = new Map<string, SqlTable>();
  const columnHits = new Map<string, SqlColumnHit[]>();

  const addHit = (col: string, hit: SqlColumnHit) => {
    const key = col.toLowerCase();
    if (!columnHits.has(key)) columnHits.set(key, []);
    columnHits.get(key)!.push(hit);
  };
  const table = (name: string): SqlTable => {
    if (!tables.has(name)) {
      tables.set(name, { name, columns: new Set(), droppedColumns: new Set() });
    }
    return tables.get(name)!;
  };

  let scanned = 0;
  for (const full of files) {
    const relPath = path.relative(repoDir, full);
    let text: string;
    try {
      const st = fs.statSync(full);
      if (st.size > MAX_FILE_BYTES) {
        warnings.push(`${relPath} 超过 ${MAX_FILE_BYTES} 字节，已跳过`);
        continue;
      }
      text = fs.readFileSync(full, 'utf-8');
    } catch (err) {
      warnings.push(`${relPath} 读取失败：${(err as Error).message}`);
      continue;
    }
    scanned++;

    /** 当前所在的 CREATE TABLE 块（null = 不在块内） */
    let curTable: string | null = null;
    let inCreateBlock = false;

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();
      const ln = i + 1;
      if (!line || line.startsWith('--') || line.startsWith('#')) continue;

      const stmt = matchTableStmt(line);
      if (stmt) {
        curTable = stmt.table;
        inCreateBlock = !stmt.alter;
        const t = table(curTable);
        if (!stmt.alter && !t.definedAt) t.definedAt = { file: relPath, line: ln };
        // **表名本身也要索引**：红线的 protects 可能保护的就是表
        // （实测 RL-002 protects: [chain_data]，而 chain_data 既是字段名也是表名，
        //漏了表名就会漏掉 `CREATE TABLE chain_data` / `ALTER TABLE db.chain_data` 这些行）
        addHit(curTable, {
          file: relPath,
          line: ln,
          table: curTable,
          kind: stmt.alter ? 'ref' : 'define',
          text: line.slice(0, MAX_TEXT),
        });
        // ALTER 单行里可能同时含ADD/CHANGE/DROP，继续往下走不return
      }

      // CREATE TABLE 块结束：以 `)` 开头且含 ENGINE 或单独 ');'
      if (inCreateBlock && /^\)/.test(line)) {
        inCreateBlock = false;
        curTable = null;
        continue;
      }

      const t = curTable ? table(curTable) : null;
      const snip = line.slice(0, MAX_TEXT);

      // ── INSERT INTO `tbl` (`a`, `b`, ...) 的列清单 ──
      // 记为 ref：它不改结构，但**证明这些列有数据写入**，
      // 对"这个字段还在用吗"的判断有意义（实测 corp_id 有 40 处这类引用）
      const ins = line.match(/INSERT\s+(?:IGNORE\s+)?INTO\s+((?:[`"\w]+\.)?[`"\w]+)\s*\(([^)]*)\)/i);
      if (ins) {
        const insTable = normIdent(ins[1].split('.').pop()!);
        addHit(insTable, {
          file: relPath, line: ln, table: insTable, kind: 'ref', text: snip,
        });
        for (const c of ins[2].split(',')) {
          const col = normIdent(c);
          if (col && /^[a-z_]\w*$/.test(col)) {
            addHit(col, { file: relPath, line: ln, table: insTable, kind: 'ref', text: snip });
          }
        }
      }

      // ── ALTER 系列（可能与ALTER TABLE 同行，所以不else-if）──
      // DROP COLUMN `x` —— 红线主要防的就是这个
      for (const m of line.matchAll(/DROP\s+(?:COLUMN\s+)?([`"\w]+)/gi)) {
        const col = normIdent(m[1]);
        if (!col || !curTable) continue;
        // 排除 DROP TABLE / DROP INDEX / DROP KEY 的误匹配
        if (/DROP\s+(TABLE|INDEX|KEY|PRIMARY|FOREIGN|CONSTRAINT)/i.test(m[0])) continue;
        addHit(col, { file: relPath, line: ln, table: curTable, kind: 'drop', text: snip });
        t?.droppedColumns.add(col);
      }

      // ADD COLUMN `x` type
      for (const m of line.matchAll(/ADD\s+(?:COLUMN\s+)?([`"][\w]+[`"]|\b[a-z_]\w*)\s+(?![\s(]*$)/gi)) {
        if (/ADD\s+(INDEX|KEY|UNIQUE|PRIMARY|FOREIGN|CONSTRAINT)/i.test(m[0])) continue;
        const col = normIdent(m[1]);
        if (!col || !curTable) continue;
        addHit(col, { file: relPath, line: ln, table: curTable, kind: 'add', text: snip });
        t?.columns.add(col);
      }

      // CHANGE COLUMN `old` `new` / MODIFY COLUMN `x`
      const chg = line.match(/CHANGE\s+(?:COLUMN\s+)?([`"\w]+)\s+([`"\w]+)/i);
      if (chg && curTable) {
        const from = normIdent(chg[1]);
        const to = normIdent(chg[2]);
        addHit(from, { file: relPath, line: ln, table: curTable, kind: 'change', text: snip });
        if (to !== from) {
          addHit(to, { file: relPath, line: ln, table: curTable, kind: 'change', text: snip });
          t?.columns.add(to);
        }
      }
      const mod = line.match(/MODIFY\s+(?:COLUMN\s+)?([`"\w]+)/i);
      if (mod && curTable) {
        const col = normIdent(mod[1]);
        addHit(col, { file: relPath, line: ln, table: curTable, kind: 'change', text: snip });
        t?.columns.add(col);
      }

      // ── ALTER 层面的索引操作（不在 CREATE 块内，所以单独处理）──
      // 三种实测写法：
      //   ADD INDEX `corp_idx` (`corp_id`)      ← 索引名 + 列清单
      //   DROP INDEX `corp_idx`                ← 只有索引名
      //   unique statsIndex (corp_id, date)      ← 无反引号的旧式写法
      if (curTable) {
        for (const m of line.matchAll(
          /(?:ADD|DROP)\s+(?:UNIQUE\s+|PRIMARY\s+|FULLTEXT\s+)?(?:KEY|INDEX)\s*([`"\w]+)?\s*(?:\(([^)]*)\))?/gi,
        )) {
          if (m[1]) {
            addHit(normIdent(m[1]), {
              file: relPath, line: ln, table: curTable, kind: 'index', text: snip,
            });
          }
          for (const c of (m[2] ?? '').split(',')) {
            const col = normIndexCol(c);
            if (col && /^[a-z_]\w*$/.test(col)) {
              addHit(col, { file: relPath, line: ln, table: curTable, kind: 'index', text: snip });
            }
          }
        }
        // 旧式：unique statsIndex (corp_id, date) —— 无 KEY/INDEX 关键字
        const oldIdx = line.match(/^\s*unique\s+(\w+)\s*\(([^)]*)\)/i);
        if (oldIdx) {
          addHit(normIdent(oldIdx[1]), {
            file: relPath, line: ln, table: curTable, kind: 'index', text: snip,
          });
          for (const c of oldIdx[2].split(',')) {
            const col = normIndexCol(c);
            if (col && /^[a-z_]\w*$/.test(col)) {
              addHit(col, { file: relPath, line: ln, table: curTable, kind: 'index', text: snip });
            }
          }
        }
        // AFTER `col` —— 位置锚点，证明该列存在且被引用
        const after = line.match(/\bAFTER\s+([`"\w]+)/i);
        if (after) {
          addHit(normIdent(after[1]), {
            file: relPath, line: ln, table: curTable, kind: 'ref', text: snip,
          });
        }
        // CONSTRAINT name UNIQUE (cols) —— 实测 v3.0.0.sql:34 用这种写法，
        // 且约束名与列名同名（CONSTRAINT corp_id UNIQUE (corp_id)），两者都要索引
        const cons = line.match(
          /CONSTRAINT\s+([`"\w]+)\s+(?:UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY)\s*\(([^)]*)\)/i,
        );
        if (cons) {
          addHit(normIdent(cons[1]), {
            file: relPath, line: ln, table: curTable, kind: 'index', text: snip,
          });
          for (const c of cons[2].split(',')) {
            const col = normIndexCol(c);
            if (col && /^[a-z_]\w*$/.test(col)) {
              addHit(col, { file: relPath, line: ln, table: curTable, kind: 'index', text: snip });
            }
          }
        }
      }

      // ── CREATE TABLE 块内的列定义 / 索引 ──
      if (inCreateBlock && curTable) {
        // 索引行：KEY `idx` (`a`,`b`) / UNIQUE KEY / UNIQUE INDEX / PRIMARY KEY
        // 注意必须同时认KEY 和 INDEX 两种写法（实测 v0.5.1.sql 用的是 UNIQUE INDEX）
        const idxM = line.match(
          /^(?:UNIQUE\s+|PRIMARY\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+(?:([`"\w]+)\s*)?\(([^)]*)\)/i,
        );
        if (idxM) {
          // 索引名本身也可能被红线保护（如 RL-003 的 corp_uniq）
          if (idxM[1]) {
            addHit(normIdent(idxM[1]), {
              file: relPath, line: ln, table: curTable, kind: 'index', text: snip,
            });
          }
          for (const c of idxM[2].split(',')) {
            const col = normIndexCol(c);
            if (col && /^[a-z_]\w*$/.test(col)) {
              addHit(col, { file: relPath, line: ln, table: curTable, kind: 'index', text: snip });
            }
          }
          continue;
        }
        // 列定义行：`` `col` type ... `` —— 反引号包裹的开头
        const colM = line.match(/^[`"]([\w]+)[`"]\s+([a-z]+)/i);
        if (colM) {
          const col = normIdent(colM[1]);
          addHit(col, { file: relPath, line: ln, table: curTable, kind: 'define', text: snip });
          t?.columns.add(col);
          continue;
        }
        // 无反引号的列定义：`col_name varchar(64)...`
        const bare = line.match(/^([a-z_]\w*)\s+(int|bigint|tinyint|smallint|varchar|char|text|datetime|timestamp|decimal|double|float|json|blob|date|time|enum)\b/i);
        if (bare) {
          const col = normIdent(bare[1]);
          addHit(col, { file: relPath, line: ln, table: curTable, kind: 'define', text: snip });
          t?.columns.add(col);
        }
      }
    }
  }

  logger.info(
    { repoDir, files: scanned, tables: tables.size, columns: columnHits.size },
    'SQL scan done',
  );

  return {
    ok: true,
    fileCount: scanned,
    tables,
    columnHits,
    warnings,
    scannedAt: Date.now(),
  };
}

/**
 * 查一个受保护标识符在 SQL 里的全部出现位置。
 * @param qualified 形如 `trace_data.chain_status` 时按表过滤；裸名则返回全部表的命中
 */
export function findInSql(index: SqlIndex, protectedName: string): SqlColumnHit[] {
  if (!index.ok) return [];
  const dot = protectedName.indexOf('.');
  if (dot > 0) {
    const tbl = normIdent(protectedName.slice(0, dot));
    const col = normIdent(protectedName.slice(dot + 1));
    return (index.columnHits.get(col) ?? []).filter((h) => h.table === tbl);
  }
  return index.columnHits.get(normIdent(protectedName)) ?? [];
}

/** 该标识符在 SQL 里出现于哪些文件（去重，供 paths 覆盖度体检用） */
export function filesOf(hits: SqlColumnHit[]): string[] {
  return [...new Set(hits.map((h) => h.file))].sort();
}
