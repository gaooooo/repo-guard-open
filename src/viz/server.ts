/**
 * `repo-guard viz --serve` —— 本地沙盘服务。
 *
 * ── 为什么只绑 127.0.0.1 还要校验 Host ──
 * 绑回环只挡住了别的机器。浏览器里任意网页仍能通过 DNS rebinding 把自己的域名
 * 解析到 127.0.0.1 再来调接口 —— 这个服务能读仓库代码结构。所以 Host 头必须是
 * localhost / 127.0.0.1，POST 还要求 application/json（跨站表单发不出这种请求，
 * fetch 发会触发预检，而我们不应答预检）。
 *
 * ── 为什么工具调用走 callTool(sideEffects:false) ──
 * 与 MCP 同一个函数，输出逐字一致；关掉副作用是为了不替 AI 把守卫放行、
 * 不污染「AI 真实调用了多少次图谱」的埋点。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { callTool, TOOLS } from '../mcp/server.js';
import { getGraph } from '../runtime/graph-cache.js';
import { highlightFor } from './highlight.js';
import { assetDir, buildVizData, renderPage, type VizData } from './index.js';
import { simulateWrite } from './simulate.js';

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
const MAX_BODY = 64 * 1024;
const STATIC: Record<string, string> = {
  '/app.js': 'application/javascript; charset=utf-8',
  '/app.css': 'text/css; charset=utf-8',
  '/vendor/echarts.min.js': 'application/javascript; charset=utf-8',
};

export function allowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function send(res: http.ServerResponse, code: number, body: string, type = 'application/json; charset=utf-8'): void {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createVizServer(repoDir: string, port: number): http.Server {
  let cached: { at: number; data: VizData } | null = null;
  const data = async (): Promise<VizData> => {
    // getGraph 自己会按 HEAD / mtime 判失效；这里只避免同一秒内重复算体检
    const handle = await getGraph(repoDir);
    if (cached && cached.at === handle.builtAt.getTime()) return cached.data;
    const d = await buildVizData(repoDir);
    cached = { at: d.handle.builtAt.getTime(), data: d };
    return d;
  };

  return http.createServer(async (req, res) => {
    try {
      if (!allowedHost(req.headers.host, port)) return send(res, 403, JSON.stringify({ error: 'Host 不被允许' }));
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, JSON.stringify({ error: 'Origin 不被允许' }));
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      if (req.method === 'GET') {
        if (url.pathname === '/' || url.pathname === '/index.html') {
          return send(res, 200, renderPage('window.RG_MODE="serve";', false), 'text/html; charset=utf-8');
        }
        const type = STATIC[url.pathname];
        if (type) return send(res, 200, fs.readFileSync(path.join(assetDir(), url.pathname.slice(1)), 'utf-8'), type);
        if (url.pathname === '/api/view') {
          const d = await data();
          return send(res, 200, JSON.stringify({ view: d.view, health: d.health }));
        }
        return send(res, 404, JSON.stringify({ error: 'not found' }));
      }

      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
          return send(res, 415, JSON.stringify({ error: '只接受 application/json' }));
        }
        const body = await readBody(req);
        if (url.pathname === '/api/tool') {
          const name = typeof body.name === 'string' ? body.name : '';
          if (!TOOL_NAMES.has(name)) return send(res, 400, JSON.stringify({ error: `不在工具白名单：${name}` }));
          const args = body.args && typeof body.args === 'object' ? (body.args as Record<string, unknown>) : {};
          const text = await callTool(name, args, { sideEffects: false, repoDir });
          const { graph } = await getGraph(repoDir);
          return send(res, 200, JSON.stringify({ text, highlight: highlightFor(repoDir, graph, name, args) }));
        }
        if (url.pathname === '/api/simulate-write') {
          const file = typeof body.file === 'string' ? body.file : '';
          const b = (k: string) => body[k] === true;
          const r = simulateWrite(repoDir, file, {
            queried: b('queried'),
            similarSearched: b('similarSearched'),
            hotQueried: b('hotQueried'),
            libSearched: b('libSearched'),
          });
          return send(res, 200, JSON.stringify(r));
        }
        return send(res, 404, JSON.stringify({ error: 'not found' }));
      }

      return send(res, 405, JSON.stringify({ error: 'method not allowed' }));
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: (e as Error).message }));
    }
  });
}

/** 起服务。端口被占就往后找，最多 10 个 */
export async function serveViz(repoDir: string, port: number, log: (s: string) => void): Promise<number> {
  for (let p = port; p < port + 10; p++) {
    const server = createVizServer(repoDir, p);
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(p, '127.0.0.1', () => resolve(true));
    });
    if (!ok) continue;
    log(`repo-guard 图谱沙盘：http://127.0.0.1:${p}/   （仓库 ${repoDir}，Ctrl+C 退出）`);
    log('沙盘里的查询不写会话状态、不记埋点 —— 不会替 AI 放行守卫。');
    return new Promise<number>((resolve) => {
      const stop = () => server.close(() => resolve(0));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  }
  log(`端口 ${port}-${port + 9} 都被占用，换一个 --port 再试。`);
  return 2;
}
