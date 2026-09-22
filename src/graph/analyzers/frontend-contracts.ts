/**
 * 前端仓的契约层提取：接口出入参（调用点反推）+ 页面结构指纹。
 *
 * 权威源是本仓库 AST，不读后端文档。解析不到就放弃，不猜动态字段。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

import type {
  ApiContract,
  ApiField,
  CallEdge,
  FunctionNode,
  PageFingerprint,
  PageTag,
  RouteNode,
} from '../types.js';

// babel 8 ESM/CJS interop（与 web-frontend.ts 同一姿势）
const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

type AnyPath = { node: unknown; parent: unknown };

const PARSE_PLUGINS: Array<string | [string, object]> = [
  'typescript',
  'jsx',
  'decorators-legacy',
  ['optionalChainingAssign', { version: '2023-07' }],
];

const NUMBER_HELPERS = new Set([
  'getOffset',
  'getLimit',
  'Number',
  'parseInt',
  'parseFloat',
  'getPageOffset',
  'getPageLimit',
]);

type Inferred = NonNullable<ApiField['inferredType']>;

interface RawProp {
  name: string;
  inferredType?: Inferred;
  expr?: string;
  spread?: boolean;
}

export function extractApiContracts(input: {
  repoDir: string;
  functions: FunctionNode[];
  calls: CallEdge[];
}): ApiContract[] {
  const { repoDir, functions, calls } = input;
  const apiEdges = calls.filter((c) => c.toObj === '@api');
  if (apiEdges.length === 0) return [];

  const byApi = new Map<string, CallEdge[]>();
  for (const e of apiEdges) {
    const list = byApi.get(e.toMethod) ?? [];
    list.push(e);
    byApi.set(e.toMethod, list);
  }

  const out: ApiContract[] = [];
  for (const [api, edges] of byApi) {
    const wrapper = pickWrapper(edges, functions);
    const callSites = wrapper
      ? calls.filter(
          (c) =>
            c.toFile === wrapper.file &&
            c.toObj !== '@api' &&
            c.toMethod !== '<jsx>' &&
            (c.toMethod === wrapper.name || c.toObj === wrapper.name),
        )
      : [];
    const parsed = parseCallSites(repoDir, wrapper, callSites);
    const request = aggregateFields(parsed.request, Math.max(callSites.length, 1));
    const response = aggregateFields(parsed.response, Math.max(callSites.length, 1));
    const requestSets = parsed.requestSets;
    const divergent =
      requestSets.length >= 2 &&
      requestSets.some((s) => {
        const a = [...s].sort().join(',');
        return requestSets.some((t) => [...t].sort().join(',') !== a);
      });
    out.push({
      api,
      service: wrapper,
      callSiteCount: callSites.length,
      request,
      response,
      ...(divergent ? { divergent: true } : {}),
    });
  }
  return out.sort((a, b) => a.api.localeCompare(b.api));
}

export function extractPageFingerprints(input: {
  routes: RouteNode[];
  fileImports: Map<string, Set<string>>;
  fileJsx: Map<string, Set<string>>;
}): PageFingerprint[] {
  const seen = new Set<string>();
  const out: PageFingerprint[] = [];
  for (const r of input.routes) {
    const file = r.handlerFile;
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const imports = [...(input.fileImports.get(file) ?? [])].sort();
    const jsx = [...(input.fileJsx.get(file) ?? [])].sort();
    out.push({
      file,
      urlPath: r.urlPath,
      imports,
      jsx,
      tags: tagPage(file, r.urlPath, imports, jsx),
    });
  }
  return out;
}

export function tagPage(file: string, urlPath: string | undefined, imports: string[], jsx: string[]): PageTag[] {
  const blob = `${file} ${urlPath ?? ''} ${imports.join(' ')} ${jsx.join(' ')}`.toLowerCase();
  const tags: PageTag[] = [];
  const has = (xs: string[]) => xs.some((x) => imports.includes(x) || jsx.includes(x));
  if (has(['Table']) || /list|manage/.test(blob)) tags.push('list');
  if (has(['usePagination', 'getOffset', 'getLimit', 'Pagination']) || /pagination/.test(blob)) {
    tags.push('pagination');
  }
  if (has(['Search']) || (has(['Input']) && has(['Table'])) || /keyword|search/.test(blob)) {
    tags.push('search');
  }
  if (has(['Table'])) tags.push('table');
  if (has(['Form'])) tags.push('form');
  if (has(['Modal', 'Drawer'])) tags.push('modal');
  if ((/detail|edit/.test(blob) && !has(['Table'])) || /\/edit\b|\/detail\b/.test(urlPath ?? '')) {
    tags.push('detail');
  }
  return [...new Set(tags)];
}

function pickWrapper(
  edges: CallEdge[],
  functions: FunctionNode[],
): { file: string; name: string; line: number } | null {
  for (const e of edges) {
    const fn = functions.find(
      (f) => f.file === e.fromFile && e.line >= f.line && e.line <= f.endLine && f.exported,
    );
    if (fn) return { file: fn.file, name: fn.name, line: fn.line };
  }
  for (const e of edges) {
    const fn = functions.find((f) => f.file === e.fromFile && e.line >= f.line && e.line <= f.endLine);
    if (fn) return { file: fn.file, name: fn.name, line: fn.line };
  }
  return { file: edges[0].fromFile, name: edges[0].fromFn, line: edges[0].line };
}

function parseCallSites(
  repoDir: string,
  wrapper: { file: string; name: string } | null,
  callSites: CallEdge[],
): {
  request: Array<RawProp & { file: string; line: number }>;
  response: Array<RawProp & { file: string; line: number }>;
  requestSets: Array<Set<string>>;
} {
  const request: Array<RawProp & { file: string; line: number }> = [];
  const response: Array<RawProp & { file: string; line: number }> = [];
  const requestSets: Array<Set<string>> = [];
  if (!wrapper || callSites.length === 0) return { request, response, requestSets };

  const byFile = new Map<string, CallEdge[]>();
  for (const c of callSites) {
    const list = byFile.get(c.fromFile) ?? [];
    list.push(c);
    byFile.set(c.fromFile, list);
  }

  for (const [rel, sites] of byFile) {
    const ast = parseFile(path.join(repoDir, rel));
    if (!ast) continue;
    const siteLines = new Set(sites.map((s) => s.line));
    const found = walkFileForContract(ast, rel, wrapper.name, siteLines);
    request.push(...found.request);
    response.push(...found.response);
    requestSets.push(...found.requestSets);
  }
  return { request, response, requestSets };
}

function parseFile(abs: string): ReturnType<typeof parse> | null {
  try {
    const code = fs.readFileSync(abs, 'utf-8');
    return parse(code, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: PARSE_PLUGINS as never,
    });
  } catch {
    return null;
  }
}

function walkFileForContract(
  ast: ReturnType<typeof parse>,
  file: string,
  serviceName: string,
  siteLines: Set<number>,
): {
  request: Array<RawProp & { file: string; line: number }>;
  response: Array<RawProp & { file: string; line: number }>;
  requestSets: Array<Set<string>>;
} {
  const request: Array<RawProp & { file: string; line: number }> = [];
  const response: Array<RawProp & { file: string; line: number }> = [];
  const requestSets: Array<Set<string>> = [];

  type ObjExpr = { type?: string; properties?: unknown[] };
  const identObjects = new Map<string, { fn: string; obj: ObjExpr }>();
  const fnOf = new Map<unknown, string>();

  traverse(ast, {
    enter(p: AnyPath) {
      const node = p.node as { type?: string; id?: { name?: string }; loc?: { start: { line: number } } };
      if (
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'ClassMethod' ||
        node.type === 'ObjectMethod'
      ) {
        const name =
          (node as { id?: { name?: string }; key?: { name?: string } }).id?.name ??
          (node as { key?: { name?: string } }).key?.name ??
          '<anon>';
        fnOf.set(p.node, name);
      }
    },
    VariableDeclarator(p: AnyPath) {
      const node = p.node as {
        id?: { type?: string; name?: string };
        init?: ObjExpr;
      };
      if (node.id?.type === 'Identifier' && node.id.name && unwrap(node.init)?.type === 'ObjectExpression') {
        identObjects.set(`${curFn(p)}::${node.id.name}`, { fn: curFn(p), obj: unwrap(node.init)! });
      }
    },
  } as never);

  const callHits: Array<{
    line: number;
    node: unknown;
    parent: unknown;
    fn: string;
  }> = [];

  traverse(ast, {
    CallExpression(p: AnyPath) {
      const node = p.node as {
        callee?: {
          type?: string;
          name?: string;
          property?: { name?: string };
        };
        loc?: { start: { line: number } };
      };
      const line = node.loc?.start.line;
      if (!line || !siteLines.has(line)) return;
      const calleeName =
        node.callee?.type === 'Identifier'
          ? node.callee.name
          : node.callee?.type === 'MemberExpression'
            ? node.callee.property?.name
            : undefined;
      if (calleeName !== serviceName) return;
      callHits.push({ line, node: p.node, parent: p.parent, fn: curFn(p) });
    },
  } as never);

  for (const hit of callHits) {
    const arg0 = (hit.node as { arguments?: unknown[] }).arguments?.[0];
    const props = resolveArgProps(arg0, hit.fn, identObjects);
    const names = new Set<string>();
    for (const prop of props.props) {
      if (prop.spread || !prop.name) continue;
      names.add(prop.name);
      request.push({ ...prop, file, line: hit.line });
    }
    requestSets.push(names);
  }

  // 响应不能靠 CallExpression 的直接 parent（常常是 AwaitExpression）。
  // 整文件扫：解构/赋值来自对该 service 的调用，再收成员链。
  if (callHits.length) {
    const members = collectMembers(ast, serviceName);
    for (const m of members) {
      response.push({ name: m.path, inferredType: m.inferredType, file, line: m.line, expr: m.path });
    }
  }

  return { request, response, requestSets };

  function curFn(p: AnyPath): string {
    let cur: AnyPath | { parent: unknown; node: unknown } | null = p;
    for (let i = 0; i < 40 && cur; i++) {
      const n = (cur as AnyPath).node;
      if (fnOf.has(n)) return fnOf.get(n)!;
      cur = (cur as { parentPath?: AnyPath }).parentPath ?? null;
    }
    return '<top>';
  }
}

function unwrap(n: unknown): { type?: string; properties?: unknown[]; expression?: unknown } | null {
  let cur = n as { type?: string; expression?: unknown } | null;
  for (let i = 0; i < 6 && cur; i++) {
    if (
      cur.type === 'TSAsExpression' ||
      cur.type === 'TSTypeAssertion' ||
      cur.type === 'ParenthesizedExpression' ||
      cur.type === 'TSSatisfiesExpression'
    ) {
      cur = (cur.expression as typeof cur) ?? null;
      continue;
    }
    break;
  }
  return cur;
}

function resolveArgProps(
  arg: unknown,
  fn: string,
  identObjects: Map<string, { fn: string; obj: { type?: string; properties?: unknown[] } }>,
): { props: RawProp[]; partial: boolean } {
  const n = unwrap(arg);
  if (!n) return { props: [], partial: true };
  if (n.type === 'ObjectExpression') return collectProps(n, fn, identObjects, 0);
  if ((n as { type?: string; name?: string }).type === 'Identifier') {
    const name = (n as { name?: string }).name;
    const hit = name ? identObjects.get(`${fn}::${name}`) : undefined;
    if (hit) return collectProps(hit.obj, fn, identObjects, 1);
    return { props: [], partial: true };
  }
  return { props: [], partial: true };
}

function collectProps(
  obj: { properties?: unknown[] },
  fn: string,
  identObjects: Map<string, { fn: string; obj: { type?: string; properties?: unknown[] } }>,
  depth: number,
): { props: RawProp[]; partial: boolean } {
  const props: RawProp[] = [];
  let partial = false;
  for (const raw of obj.properties ?? []) {
    const p = raw as {
      type?: string;
      argument?: { type?: string; name?: string };
      key?: { type?: string; name?: string; value?: string };
      value?: unknown;
      shorthand?: boolean;
    };
    if (p.type === 'SpreadElement') {
      const ident = p.argument?.type === 'Identifier' ? p.argument.name : undefined;
      const nested = ident && depth < 1 ? identObjects.get(`${fn}::${ident}`) : undefined;
      if (nested) {
        const inner = collectProps(nested.obj, fn, identObjects, depth + 1);
        props.push(...inner.props);
        partial = partial || inner.partial;
      } else {
        partial = true;
      }
      continue;
    }
    if (p.type !== 'ObjectProperty') continue;
    const name = p.key?.name ?? (typeof p.key?.value === 'string' ? p.key.value : undefined);
    if (!name) continue;
    const inferredType = inferType(p.value);
    const expr = exprOf(p.value);
    props.push({ name, inferredType, expr });
  }
  return { props, partial };
}

function inferType(node: unknown): Inferred | undefined {
  const n = unwrap(node) as {
    type?: string;
    callee?: { type?: string; name?: string; property?: { name?: string } };
    operator?: string;
    argument?: unknown;
  } | null;
  if (!n?.type) return undefined;
  if (n.type === 'NumericLiteral' || n.type === 'UnaryExpression') return 'number';
  if (n.type === 'StringLiteral') return 'string';
  if (n.type === 'TemplateLiteral') return 'string';
  if (n.type === 'BooleanLiteral') return 'boolean';
  if (n.type === 'ArrayExpression') return 'array';
  if (n.type === 'ObjectExpression') return 'object';
  if (n.type === 'CallExpression') {
    const name = n.callee?.name ?? n.callee?.property?.name;
    if (name && NUMBER_HELPERS.has(name)) return 'number';
    if (name === 'String') return 'string';
    if (name === 'Boolean') return 'boolean';
  }
  return undefined;
}

function exprOf(node: unknown): string | undefined {
  const n = unwrap(node) as {
    type?: string;
    name?: string;
    value?: string | number | boolean;
    callee?: { type?: string; name?: string; property?: { name?: string } };
  } | null;
  if (!n?.type) return undefined;
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'StringLiteral') return JSON.stringify(n.value);
  if (n.type === 'NumericLiteral') return String(n.value);
  if (n.type === 'BooleanLiteral') return String(n.value);
  if (n.type === 'CallExpression') {
    const name = n.callee?.name ?? n.callee?.property?.name;
    return name ? `${name}(...)` : undefined;
  }
  return undefined;
}

interface ResultBinding {
  /** 绑定名，如 res / data */
  name: string;
  /** 空 = 整个返回值；否则是从返回值上拆出的字段前缀，如 'data' */
  prefix: string;
}

const DATA_HOOKS = new Set(['usePagination', 'useRequest', 'useRequestAPI']);

function calleeIsService(callee: unknown, serviceName: string): boolean {
  const c = callee as { type?: string; name?: string; property?: { name?: string } };
  if (!c) return false;
  if (c.type === 'Identifier') return c.name === serviceName;
  if (c.type === 'MemberExpression') return c.property?.name === serviceName;
  return false;
}

function calleeIdent(callee: unknown): string | null {
  const c = callee as { type?: string; name?: string; property?: { name?: string } };
  if (!c) return null;
  if (c.type === 'Identifier') return c.name ?? null;
  if (c.type === 'MemberExpression') return c.property?.name ?? null;
  return null;
}

/** `data` 是 hook / 解构里的返回体，字段以返回体为根：data.items → items */
function prefixForKey(key: string): string {
  return key === 'data' ? '' : key;
}

function bindPattern(
  byName: Map<string, ResultBinding>,
  id: { type?: string; name?: string; properties?: Array<{ key?: { name?: string }; value?: { name?: string } }> } | undefined,
): void {
  if (!id) return;
  if (id.type === 'Identifier' && id.name) {
    byName.set(id.name, { name: id.name, prefix: '' });
  }
  if (id.type === 'ObjectPattern') {
    for (const prop of id.properties ?? []) {
      const key = prop.key?.name;
      const local = prop.value?.name ?? key;
      if (key && local) byName.set(local, { name: local, prefix: prefixForKey(key) });
    }
  }
}

function nodeContainsServiceCall(node: unknown, serviceName: string, depth = 0): boolean {
  if (!node || typeof node !== 'object' || depth > 8) return false;
  const n = unwrap(node) as {
    type?: string;
    callee?: unknown;
    arguments?: unknown[];
    body?: unknown;
    argument?: unknown;
    expression?: unknown;
  } | null;
  if (!n) return false;
  if (n.type === 'CallExpression' && calleeIsService(n.callee, serviceName)) return true;
  if (n.type === 'AwaitExpression') return nodeContainsServiceCall(n.argument, serviceName, depth + 1);
  if (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression') {
    return nodeContainsServiceCall(n.body, serviceName, depth + 1);
  }
  if (n.type === 'BlockStatement') {
    const body = (node as { body?: unknown[] }).body ?? [];
    return body.some((s) => nodeContainsServiceCall(s, serviceName, depth + 1));
  }
  if (n.type === 'ReturnStatement' || n.type === 'ExpressionStatement') {
    return nodeContainsServiceCall(n.argument ?? n.expression, serviceName, depth + 1);
  }
  if (Array.isArray(n.arguments)) {
    if (n.arguments.some((a) => nodeContainsServiceCall(a, serviceName, depth + 1))) return true;
  }
  return false;
}

function initCallsService(init: unknown, serviceName: string): boolean {
  let n = unwrap(init) as { type?: string; argument?: unknown; callee?: unknown } | null;
  for (let i = 0; i < 4 && n; i++) {
    if (n.type === 'AwaitExpression') {
      n = unwrap(n.argument) as typeof n;
      continue;
    }
    if (n.type === 'CallExpression') return calleeIsService(n.callee, serviceName);
    break;
  }
  return false;
}

function initIsHookToService(init: unknown, serviceName: string): boolean {
  const n = unwrap(init) as { type?: string; callee?: unknown; arguments?: unknown[] } | null;
  if (n?.type !== 'CallExpression') return false;
  const hook = calleeIdent(n.callee);
  if (!hook || !DATA_HOOKS.has(hook)) return false;
  return nodeContainsServiceCall(n.arguments?.[0], serviceName);
}

function collectMembers(
  ast: ReturnType<typeof parse>,
  serviceName: string,
): Array<{ path: string; line: number; inferredType?: Inferred }> {
  const byName = new Map<string, ResultBinding>();
  const out: Array<{ path: string; line: number; inferredType?: Inferred }> = [];
  const seen = new Set<string>();

  traverse(ast, {
    VariableDeclarator(p: AnyPath) {
      const node = p.node as {
        id?: {
          type?: string;
          name?: string;
          properties?: Array<{ key?: { name?: string }; value?: { name?: string } }>;
        };
        init?: unknown;
      };
      if (initCallsService(node.init, serviceName) || initIsHookToService(node.init, serviceName)) {
        bindPattern(byName, node.id);
      }
    },
    CallExpression(p: AnyPath) {
      const node = p.node as {
        callee?: { type?: string; property?: { name?: string }; object?: { callee?: unknown } };
        arguments?: unknown[];
      };
      if (node.callee?.type !== 'MemberExpression' || node.callee.property?.name !== 'then') return;
      const obj = node.callee.object as { type?: string; callee?: unknown; argument?: unknown };
      const inner = unwrap(obj);
      const call = inner?.type === 'AwaitExpression' ? unwrap((inner as { argument?: unknown }).argument) : inner;
      if ((call as { type?: string })?.type !== 'CallExpression') return;
      if (!calleeIsService((call as { callee?: unknown }).callee, serviceName)) return;
      const cb = node.arguments?.[0] as { params?: unknown[] } | undefined;
      bindPattern(byName, cb?.params?.[0] as { type?: string; name?: string; properties?: Array<{ key?: { name?: string }; value?: { name?: string } }> });
    },
  } as never);

  if (byName.size === 0) return out;

  traverse(ast, {
    enter(p: AnyPath) {
      const t = (p.node as { type?: string }).type;
      if (t !== 'MemberExpression' && t !== 'OptionalMemberExpression') return;
      const chain = memberChain(p.node);
      if (!chain) return;
      const bind = byName.get(chain.root);
      if (!bind) return;
      const rest = chain.parts.slice(1);
      const pathStr = bind.prefix ? [bind.prefix, ...rest].join('.') : rest.join('.');
      if (!pathStr) return;
      const line = (p.node as { loc?: { start: { line: number } } }).loc?.start.line ?? 0;
      const key = `${pathStr}@${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      const inferredType = pathStr === 'items' || pathStr.endsWith('.items') ? 'array' : undefined;
      out.push({ path: pathStr, line, inferredType });
    },
  } as never);
  return out;
}

function memberChain(node: unknown): { root: string; parts: string[] } | null {
  const parts: string[] = [];
  let cur = node as {
    type?: string;
    object?: unknown;
    property?: { type?: string; name?: string };
    computed?: boolean;
    name?: string;
  };
  for (let i = 0; i < 8 && cur; i++) {
    if (cur.type === 'Identifier' && cur.name) {
      parts.unshift(cur.name);
      return { root: parts[0], parts };
    }
    if (
      (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') &&
      !cur.computed &&
      cur.property?.name
    ) {
      parts.unshift(cur.property.name);
      cur = cur.object as typeof cur;
      continue;
    }
    break;
  }
  return null;
}

function aggregateFields(
  raw: Array<RawProp & { file: string; line: number }>,
  total: number,
): ApiField[] {
  const byName = new Map<
    string,
    { type?: Inferred; sources: ApiField['sources']; have: Set<string> }
  >();
  for (const r of raw) {
    if (!r.name) continue;
    let slot = byName.get(r.name);
    if (!slot) {
      slot = { sources: [], have: new Set() };
      byName.set(r.name, slot);
    }
    if (r.inferredType && !slot.type) slot.type = r.inferredType;
    if (slot.sources.length < 5) {
      slot.sources.push({ file: r.file, line: r.line, expr: r.expr });
    }
    slot.have.add(`${r.file}:${r.line}`);
  }
  const fields: ApiField[] = [];
  for (const [name, slot] of byName) {
    const have = Math.min(slot.have.size, total);
    fields.push({
      name,
      inferredType: slot.type,
      seen: { have, total },
      optional: have < total,
      sources: slot.sources,
    });
  }
  return fields.sort((a, b) => a.name.localeCompare(b.name));
}
