/**
 * logger —— 替掉 deerclaw 的 `@deerclaw/shared` createLogger（那份是 pino）。
 *
 * ── 为什么不直接用 pino ──
 * 这里有一条硬约束：**stdout 是协议通道，不是日志通道**。
 *   · `hook <name>` 的 stdout 是给宿主解析的 JSON，多一个字节宿主就解析失败；
 *   · `mcp` 的 stdout 是 JSON-RPC 帧；
 *   · CLI 的 stdout 是给人看的报告，parity 会逐字节比对。
 * pino 默认写 stdout，装进来等于随机破坏这三条通道。所以日志一律走 stderr。
 *
 * ── 为什么默认什么都不打 ──
 * hook 的 stderr 在退出码非 0 时会被当作给 Agent 的反馈消息（stdout 为空时的
 * fallback），平时也会进宿主的 debug 日志。默认静默、由 `REPO_GUARD_DEBUG`
 * 显式打开，避免把调试噪音喂给模型。
 *
 * 保持 pino 的调用形态 `logger.warn({ ctx }, 'msg')`，这样移植过来的引擎代码
 * 一行都不用改。
 */

type Fields = Record<string, unknown>;

/** pino 的两种调用形态：`(msg)` 与 `({fields}, msg)` */
type LogFn = (a?: unknown, b?: unknown) => void;

export interface Logger {
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
}

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
type Level = (typeof LEVELS)[number];

/**
 * `REPO_GUARD_DEBUG` 的取值：
 *   未设 / 空 / '0' / 'false'  → 全静默
 *   '1' / 'true'               → debug 及以上
 *   具体级别名（如 'warn'）    → 该级别及以上
 */
function threshold(): number {
  const raw = (process.env.REPO_GUARD_DEBUG ?? '').trim().toLowerCase();
  if (!raw || raw === '0' || raw === 'false') return LEVELS.length; // 高于一切级别 = 全关
  if (raw === '1' || raw === 'true') return LEVELS.indexOf('debug');
  const i = LEVELS.indexOf(raw as Level);
  return i >= 0 ? i : LEVELS.indexOf('debug');
}

function emit(name: string, level: Level, a?: unknown, b?: unknown): void {
  if (LEVELS.indexOf(level) < threshold()) return;

  // pino 语义：第一个参数是对象时它是结构化字段，第二个才是消息
  const hasFields = a !== null && typeof a === 'object';
  const fields = hasFields ? (a as Fields) : undefined;
  const msg = hasFields ? b : a;

  let line = `[${level}] ${name}`;
  if (msg !== undefined) line += ` ${String(msg)}`;
  if (fields) {
    let json: string;
    try {
      json = JSON.stringify(fields);
    } catch {
      // 循环引用之类：日志绝不能自己抛异常，把调用方带崩
      json = '{"<unserializable>":true}';
    }
    line += ` ${json}`;
  }

  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // stderr 被关掉（宿主某些拉起方式下会）——静默吞掉，日志不是关键路径
  }
}

export function createLogger(name: string, _level?: string): Logger {
  const mk = (level: Level): LogFn => (a, b) => emit(name, level, a, b);
  return {
    trace: mk('trace'),
    debug: mk('debug'),
    info: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
    fatal: mk('fatal'),
  };
}
