/**
 * 沙盘高亮：把一次工具调用的**结构化结果**映射成图上的节点 id。
 *
 * 不从文本里反解析 —— 用的是渲染文本的那同一批函数（analyzeImpact / similarPages /
 * similarMethods / traceRoute / hotSpots），所以"AI 看到的原文"和"图上亮起来的"
 * 必然来自同一次计算。
 */
import { analyzeImpact, hotSpots, similarPages, traceRoute } from '../graph/graph-builder.js';
import type { CodeGraph } from '../graph/types.js';
import { enclosingIndex, functionIds } from '../insight/health.js';
import { similarMethods } from '../insight/similar-methods.js';
import { splitFileSymbol, toRepoRelative } from '../runtime/paths.js';

export interface HighlightGroup {
  label: string;
  /** 前端配色键 */
  tone: 'target' | 'strong' | 'weak' | 'ref' | 'warn';
  nodes: string[];
}

export interface Highlight {
  focus: string | null;
  groups: HighlightGroup[];
}

const NONE: Highlight = { focus: null, groups: [] };

function indexer(graph: CodeGraph) {
  const ids = functionIds(graph);
  const byKey = new Map<string, string[]>();
  for (const f of graph.functions) {
    const k = `${f.file}#${f.name}`;
    byKey.set(k, [...(byKey.get(k) ?? []), ids.get(f)!]);
  }
  const enclosing = enclosingIndex(graph);
  const at = (file: string, line: number): string => {
    const f = enclosing(file, line);
    return f ? ids.get(f)! : `file:${file}`;
  };
  const fn = (file: string, name: string): string[] => byKey.get(`${file}#${name}`) ?? [];
  return { at, fn };
}

const uniq = (xs: string[]) => [...new Set(xs)];

export function highlightFor(repoDir: string, graph: CodeGraph, name: string, args: Record<string, unknown>): Highlight {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const ix = indexer(graph);

  switch (name) {
    case 'impact': {
      const { file, symbol } = splitFileSymbol(s(args.file), s(args.symbol));
      const rel = toRepoRelative(repoDir, file);
      if (!rel) return NONE;
      const r = analyzeImpact(graph, rel, symbol || undefined);
      let focus = `file:${rel}`;
      if (symbol && r.kind === 'field' && r.field) focus = `cls:${rel}#${r.field.struct}`;
      else if (symbol) focus = ix.fn(rel, symbol)[0] ?? focus;
      const handlers = r.affectedRoutes.flatMap((a) => {
        const route = graph.routes.find((x) => x.method === a.method && x.urlPath === a.urlPath);
        return route?.handlerFile ? ix.fn(route.handlerFile, route.handlerFn) : [];
      });
      const groups: HighlightGroup[] = [
        { label: '目标', tone: 'target', nodes: [focus] },
        { label: r.kind === 'field' ? '点访问读写' : '直接调用者', tone: 'strong', nodes: uniq(r.directCallers.map((c) => ix.at(c.file, c.line))) },
      ];
      if (r.kind === 'field') {
        const decl = new Set((graph.fields ?? []).map((f) => `${f.file}:${f.line}`));
        const hits = (r.literalHits ?? []).filter((l) => l.via !== 'tag' && !decl.has(`${l.file}:${l.line}`));
        groups.push({ label: '字符串键', tone: 'weak', nodes: uniq(hits.map((l) => ix.at(l.file, l.line))) });
      } else {
        groups.push({ label: '受影响入口的 handler', tone: 'warn', nodes: uniq(handlers) });
        groups.push({ label: '依赖模块', tone: 'weak', nodes: r.dependentModules.map((f) => `file:${f}`) });
      }
      return { focus, groups };
    }

    case 'similar': {
      const intent = s(args.intent);
      if ((graph.pageFingerprints ?? []).length) {
        const r = similarPages(graph, { intent, limit: typeof args.limit === 'number' ? args.limit : 3 });
        return {
          focus: r.hits[0] ? `file:${r.hits[0].file}` : null,
          groups: [
            { label: '参考页', tone: 'ref', nodes: r.hits.filter((h) => !h.discouraged).map((h) => `file:${h.file}`) },
            { label: '不建议参考', tone: 'warn', nodes: r.hits.filter((h) => h.discouraged).map((h) => `file:${h.file}`) },
          ],
        };
      }
      const r = similarMethods(graph, { intent, limit: typeof args.limit === 'number' ? args.limit : 3 });
      const members = r.families.flatMap((f) => f.members.flatMap((m) => ix.fn(m.file, m.name)));
      const chain = r.families.flatMap((f) => (f.reference?.chain ?? []).flatMap((c) => ix.fn(c.file, c.name)));
      return {
        focus: chain[0] ?? members[0] ?? null,
        groups: [
          { label: '参考分层骨架', tone: 'target', nodes: uniq(chain) },
          { label: '同族方法', tone: 'ref', nodes: uniq(members) },
        ],
      };
    }

    case 'trace': {
      const t = traceRoute(graph, s(args.urlPath));
      if (!t.controller) return NONE;
      const ctl = ix.fn(t.controller.file, t.controller.fn);
      return {
        focus: ctl[0] ?? `file:${t.controller.file}`,
        groups: [
          { label: 'handler', tone: 'target', nodes: ctl },
          { label: '下游', tone: 'strong', nodes: uniq(t.services.flatMap((x) => ix.fn(x.file, x.method))) },
        ],
      };
    }

    case 'hot': {
      const spots = hotSpots(graph, typeof args.limit === 'number' ? args.limit : 10);
      const nodes = uniq(spots.flatMap((x) => ix.fn(x.file, x.method)));
      return { focus: nodes[0] ?? null, groups: [{ label: '高扇入热点', tone: 'warn', nodes }] };
    }

    case 'check': {
      const files = Array.isArray(args.files) ? args.files.filter((x): x is string => typeof x === 'string') : [];
      const nodes = files.map((f) => toRepoRelative(repoDir, f)).filter((x): x is string => !!x).map((f) => `file:${f}`);
      return { focus: nodes[0] ?? null, groups: [{ label: '自查文件', tone: 'target', nodes }] };
    }

    default:
      return NONE;
  }
}
