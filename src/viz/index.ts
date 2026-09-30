/**
 * `repo-guard viz` —— 图谱体检页与本地沙盘。
 *
 * 两种形态共用一份页面（assets/viz/）：
 *   · 静态：payload、echarts、脚本全部内联进一个 HTML，可离线发人。沙盘按钮置灰。
 *   · --serve：本地 127.0.0.1 服务，沙盘动作实时调 callTool（与 AI 走同一条代码路径）。
 *
 * 产物默认写在 `<repo>/.codebuddy/.cache/viz/`：不进 git，与图谱缓存放在一处。
 */
import fs from 'node:fs';
import path from 'node:path';

import { auditPolicy } from '../engine/policy-audit.js';
import { computeHealth, type HealthReport } from '../insight/health.js';
import { getGraph, type GraphHandle } from '../runtime/graph-cache.js';
import { cachePath, pluginPath } from '../runtime/paths.js';
import { hasRedlines, loadRedlines } from '../runtime/redlines.js';
import { countLines, DEFAULT_LINE_LIMIT, readFacts } from '../runtime/repo-facts.js';
import { scan } from '../cli/scan.js';
import { buildViewPayload, type ViewPayload } from './payload.js';

export interface VizData {
  handle: GraphHandle;
  health: HealthReport;
  view: ViewPayload;
}

export async function buildVizData(repoDir: string): Promise<VizData> {
  const handle = await getGraph(repoDir);
  const graph = handle.graph;
  const facts = readFacts(repoDir);
  const lineLimit = facts?.lineLimit ?? DEFAULT_LINE_LIMIT;
  const sr = scan(repoDir, graph, lineLimit);
  const audit = hasRedlines(repoDir) ? auditPolicy(loadRedlines(repoDir), repoDir) : null;
  const publicLayer = facts?.publicLayer ?? [];
  const health = computeHealth(graph, {
    repo: path.basename(repoDir),
    headSha: handle.headSha,
    lineLimit,
    lineCount: (f) => countLines(path.join(repoDir, f)),
    oversize: sr.oversize,
    cycles: sr.cycles,
    publicLayer,
    audit,
  });
  return { handle, health, view: buildViewPayload(graph, health, publicLayer) };
}

export function assetDir(): string {
  return pluginPath('assets', 'viz');
}

function readAsset(name: string): string {
  return fs.readFileSync(path.join(assetDir(), name), 'utf-8');
}

/** JSON 放进 <script> 里：`<` 必须转义，否则数据里的 `</script>` 会提前闭合标签 */
export function inlineJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** 把页面模板拼成最终 HTML。inline=true 时 css / echarts / app.js 全部内联 */
export function renderPage(boot: string, inline: boolean): string {
  let html = readAsset('index.html').replace('<!--RG_BOOT-->', `<script>${boot}</script>`);
  if (inline) {
    // 用函数形式替换：资源里的 `$&` `$1` 不能被当成替换模式
    html = html
      .replace('<link rel="stylesheet" href="app.css">', () => `<style>${readAsset('app.css')}</style>`)
      .replace('<script src="vendor/echarts.min.js"></script>', () => `<script>${readAsset('vendor/echarts.min.js').replace(/<\/script/gi, '<\\/script')}</script>`)
      .replace('<script src="app.js"></script>', () => `<script>${readAsset('app.js')}</script>`);
  }
  return html;
}

export async function writeStaticViz(repoDir: string, outDir?: string): Promise<{ dir: string; text: string }> {
  const data = await buildVizData(repoDir);
  const dir = path.resolve(outDir ?? cachePath(repoDir, 'viz'));
  fs.mkdirSync(dir, { recursive: true });
  const boot = `window.RG_MODE="static";window.RG_DATA=${inlineJson({ view: data.view, health: data.health })};`;
  fs.writeFileSync(path.join(dir, 'index.html'), renderPage(boot, true));
  fs.writeFileSync(path.join(dir, 'health.json'), `${JSON.stringify(data.health, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'graph-view.json'), `${JSON.stringify(data.view)}\n`);
  const h = data.health;
  const text = [
    '',
    `图谱体检页已生成：${path.join(dir, 'index.html')}`,
    `  仓库 ${h.repo} · ${h.scale.files} 文件 · ${h.scale.functions} 方法 · ${h.scale.calls} 调用 · ${h.scale.routes} 路由`,
    `  可信度 ${h.trust.level}：${h.trust.reasons.join('；')}`,
    `  上帝方法 ${h.lists.god.length} · 超长文件 ${h.lists.oversize.length} · 循环依赖 ${h.lists.cycles.length}`,
    '',
    '静态页只能看体检与图；要在图上模拟插件能力，跑 `repo-guard viz --serve`。',
  ].join('\n');
  return { dir, text };
}
