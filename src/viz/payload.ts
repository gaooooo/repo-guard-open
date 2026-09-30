/**
 * 图谱 → 可视化数据。单仓投影：服务 → 文件 → 类型 → 方法，加已解析的调用边。
 *
 * ── 只画引擎认的边 ──
 * 原型脚本（build_four_graph.py）会把「同名且全仓唯一」的未解析调用也连上。
 * 这里不连：impact / trace 只认 toFile 已解析的边，图上多出来的边会让人看到
 * 一个 AI 永远拿不到的结论。图与工具输出必须同源，否则沙盘失去意义。
 */
import type { CodeGraph } from '../graph/types.js';
import { enclosingIndex, functionIds, type HealthReport } from '../insight/health.js';
import { layerOf, splitVerb, familyKey } from '../insight/similar-methods.js';

export const VIEW_SCHEMA_VERSION = 1;

export interface ViewNode {
  id: string;
  name: string;
  kind: 'svc' | 'file' | 'cls' | 'fn';
  file: string;
  line?: number;
  owner?: string;
  layer?: string;
  fam?: string;
  /** 健康指标 */
  loc?: number;
  fanIn?: number;
  fanOut?: number;
  cx?: number;
  god?: boolean;
  lines?: number | null;
  oversize?: boolean;
  inCycle?: boolean;
  fns?: number;
  publicLayer?: boolean;
}

export interface ViewLink {
  source: string;
  target: string;
  rel: 'owns' | 'call' | 'import';
}

export interface ViewRel {
  calls: string[];
  callers: string[];
  routes: string[];
  fields: string[];
}

export interface ViewPayload {
  schemaVersion: number;
  repo: string;
  analyzer: string | null;
  headSha: string | null;
  builtAt: number;
  nodes: ViewNode[];
  links: ViewLink[];
  rels: Record<string, ViewRel>;
  /** 家族键 → 方法 id（≥2 个成员才收） */
  fam: Record<string, string[]>;
  /** 字段检索用：`Struct.Field` → 所在文件 */
  fields: Array<{ key: string; file: string; line: number; struct: string; name: string; tags: Record<string, string> }>;
  routes: Array<{ method: string; urlPath: string; fn: string | null }>;
}

export function buildViewPayload(graph: CodeGraph, health: HealthReport, publicLayer: string[]): ViewPayload {
  const nodes: ViewNode[] = [];
  const links: ViewLink[] = [];
  const rels: Record<string, ViewRel> = {};
  const rel = (id: string): ViewRel => (rels[id] ??= { calls: [], callers: [], routes: [], fields: [] });

  const svcId = 'svc:repo';
  nodes.push({ id: svcId, name: health.repo, kind: 'svc', file: '' });

  const isPublic = (f: string) => publicLayer.some((p) => f.startsWith(p));
  const fileMetric = new Map(health.files.map((f) => [f.file, f]));
  for (const m of graph.modules) {
    const fm = fileMetric.get(m.file);
    nodes.push({
      id: `file:${m.file}`,
      name: m.file.split('/').pop() ?? m.file,
      kind: 'file',
      file: m.file,
      layer: layerOf(m.file),
      lines: fm?.lines ?? null,
      oversize: fm?.oversize ?? false,
      inCycle: fm?.inCycle ?? false,
      fns: fm?.fns ?? 0,
      publicLayer: isPublic(m.file),
    });
    links.push({ source: svcId, target: `file:${m.file}`, rel: 'owns' });
  }
  const fileIds = new Set(graph.modules.map((m) => `file:${m.file}`));
  for (const m of graph.modules) {
    for (const dep of m.imports) {
      if (fileIds.has(`file:${dep}`)) links.push({ source: `file:${m.file}`, target: `file:${dep}`, rel: 'import' });
    }
  }

  // 类型：有方法的，或带字段的（dto 要能被字段检索命中）
  const fieldsByStruct = new Map<string, string[]>();
  for (const f of graph.fields ?? []) {
    const k = `${f.file}#${f.struct}`;
    const tag = Object.entries(f.tags ?? {}).map(([a, b]) => `${a}:"${b}"`).join(' ');
    fieldsByStruct.set(k, [...(fieldsByStruct.get(k) ?? []), `${f.struct}.${f.name}${f.typeName ? ` : ${f.typeName}` : ''}${tag ? `  ${tag}` : ''}`]);
  }
  const clsId = new Map<string, string>();
  for (const c of graph.classes) {
    const k = `${c.file}#${c.name}`;
    if (clsId.has(k)) continue;
    const fields = fieldsByStruct.get(k) ?? [];
    if (!(c.methods ?? []).length && !fields.length) continue;
    if (!fileIds.has(`file:${c.file}`)) continue;
    const id = `cls:${k}`;
    clsId.set(k, id);
    nodes.push({ id, name: c.name, kind: 'cls', file: c.file, line: c.line, layer: layerOf(c.file) });
    links.push({ source: `file:${c.file}`, target: id, rel: 'owns' });
    if (fields.length) rel(id).fields.push(...fields.slice(0, 40));
  }

  const ids = functionIds(graph);
  const metric = new Map(health.functions.map((f) => [f.id, f]));
  const fam: Record<string, string[]> = {};
  const byKey = new Map<string, string[]>();
  for (const f of graph.functions) {
    const id = ids.get(f)!;
    const m = metric.get(id);
    const key = familyKey(splitVerb(f.name).family);
    nodes.push({
      id,
      name: f.name,
      kind: 'fn',
      file: f.file,
      line: f.line,
      owner: f.owner ?? undefined,
      layer: layerOf(f.file),
      fam: key,
      loc: m?.loc,
      fanIn: m?.fanIn,
      fanOut: m?.fanOut,
      cx: m?.cx,
      god: m?.god,
      publicLayer: isPublic(f.file),
    });
    const owner = f.owner ? clsId.get(`${f.file}#${f.owner}`) : undefined;
    links.push({ source: owner ?? `file:${f.file}`, target: id, rel: 'owns' });
    (fam[key] ??= []).push(id);
    const k = `${f.file}#${f.name}`;
    byKey.set(k, [...(byKey.get(k) ?? []), id]);
  }
  for (const k of Object.keys(fam)) if (fam[k].length < 2) delete fam[k];

  const enclosing = enclosingIndex(graph);
  const seen = new Set<string>();
  for (const c of graph.calls) {
    if (!c.toFile) continue;
    const from = enclosing(c.fromFile, c.line);
    const targets = byKey.get(`${c.toFile}#${c.toMethod}`);
    if (!from || !targets) continue;
    const src = ids.get(from)!;
    for (const dst of targets) {
      if (src === dst) continue;
      const k = `${src}>${dst}`;
      if (seen.has(k)) continue;
      seen.add(k);
      links.push({ source: src, target: dst, rel: 'call' });
      rel(src).calls.push(dst);
      rel(dst).callers.push(src);
    }
  }

  const routes: ViewPayload['routes'] = [];
  for (const r of graph.routes) {
    const hit = r.handlerFile ? byKey.get(`${r.handlerFile}#${r.handlerFn}`)?.[0] ?? null : null;
    routes.push({ method: r.method, urlPath: r.urlPath, fn: hit });
    if (hit) rel(hit).routes.push(`${r.method} ${r.urlPath}`);
  }

  return {
    schemaVersion: VIEW_SCHEMA_VERSION,
    repo: health.repo,
    analyzer: graph.analyzer ?? null,
    headSha: health.headSha,
    builtAt: graph.builtAt,
    nodes,
    links,
    rels,
    fam,
    fields: (graph.fields ?? []).map((f) => ({
      key: `${f.struct}.${f.name}`,
      file: f.file,
      line: f.line,
      struct: f.struct,
      name: f.name,
      tags: f.tags ?? {},
    })),
    routes,
  };
}
