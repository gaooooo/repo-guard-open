/**
 * 从 tool_call 参数里抽出「写了哪个文件、写了什么」。
 * 本地 file_write 用 path/content；工蜂 MCP 用 file_path / batch replacements。
 */

const PATH_KEYS = ['path', 'file_path', 'filePath', 'path_with_namespace'] as const;
const CONTENT_KEYS = ['content', 'file_content', 'new_content', 'file_contents'] as const;

export function isCodeWriteTool(name: string): boolean {
  if (name === 'file_write') return true;
  const n = name.toLowerCase();
  if (!n.includes('gongfeng')) return false;
  return /create_or_update_file|batch_modify|update_file/.test(n);
}

export function extractWritePath(args: Record<string, unknown>): string | null {
  return extractWritePaths(args)[0] ?? null;
}

/** 收集本次写入涉及的全部路径（含 batch files/replacements 每一条）。 */
export function extractWritePaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const t = raw.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const k of PATH_KEYS) add(args[k]);
  collectPathsFromArray(args.files, add);
  collectPathsFromArray(args.replacements, add);
  return out;
}

export function extractWriteContent(args: Record<string, unknown>): string | null {
  for (const k of CONTENT_KEYS) {
    const v = args[k];
    if (typeof v === 'string') return v;
  }
  const fromFiles = concatContents(args.files);
  if (fromFiles) return fromFiles;
  return concatContents(args.replacements);
}

function collectPathsFromArray(raw: unknown, add: (v: unknown) => void): void {
  if (!Array.isArray(raw)) return;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    for (const k of PATH_KEYS) {
      if (typeof rec[k] === 'string' && rec[k].trim()) {
        add(rec[k]);
        break;
      }
    }
  }
}

function concatContents(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const parts: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    for (const k of CONTENT_KEYS) {
      if (typeof rec[k] === 'string') parts.push(rec[k] as string);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}
