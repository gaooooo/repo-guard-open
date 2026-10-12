/**
 * stdio MCP server —— 把守卫自查能力开放给 AI：check / lib_search / audit。
 *
 * 图谱工具（impact / hot / similar / trace / contracts / scan）不在这里：由 code-atlas 的 MCP
 * 提供（插件 .mcp.json 里同时注册了 code-atlas，AI 看到的是 mcp__code-atlas__atlas_*）。
 * AI 调 atlas_impact 等之后的「查过」记录由 PostToolUse 钩子 post-atlas 写进会话状态。
 *
 * ── 工具描述是这个文件最重要的部分 ──
 * 描述不是文档，是**约束的载体**。模型看不到我们的设计意图，它只看到工具名和
 * 一句描述，然后决定调不调。所以每条描述都在回答"什么时候该调我"，
 * 而且把最容易犯的错直接写进去：
 *   · check      → "configured=false 时没命中不等于安全"
 *   · lib_search → "内部组件库不在你的训练数据里，凭 antd 经验写的 props 几乎一定是错的"
 * 这些话如果只写在 README 里，模型永远看不到。
 *
 * ── 协议实现为什么这么薄 ──
 * 只实现 initialize / tools/list / tools/call 三个方法。MCP 还有 resources、
 * prompts、sampling，但这个 server 只提供工具，声明多余的能力只会让宿主
 * 去调然后拿到错误。
 */
import { auditPolicy, formatAuditReport } from '../engine/policy-audit.js';
import { findRepoRoot } from '../runtime/paths.js';
import { readFacts, componentDocsHint } from '../runtime/repo-facts.js';
import { hasRedlines, loadRedlines } from '../runtime/redlines.js';
import { judge, missingConfig } from '../runtime/guard.js';
import { adoptSessionFor, recordLibSearch } from '../runtime/session-state.js';
import { record } from '../runtime/metrics.js';
import { loadLibrary, searchLibrary } from '../library/library-catalog.js';

const SERVER_NAME = 'repo-guard';
const PROTOCOL_VERSION = '2024-11-05';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'check',
    description:
      '改完自查：给出改动涉及的文件，返回是否碰公共层、是否命中红线。若 configured=false，说明本仓还没配规则，没命中不等于安全。碰到公共层的已有文件，改之前先用 code-atlas 的 atlas_impact 查影响面。',
    inputSchema: {
      type: 'object',
      properties: { files: { type: 'array', items: { type: 'string' } } },
      required: ['files'],
    },
  },
  {
    name: 'lib_search',
    description:
      '写新的公共组件之前问：本仓 UI 组件库里有没有现成的。内部组件库不在你的训练数据里，凭 antd / MUI 经验写的 props 几乎一定是错的。仓内已有的同类实现用 code-atlas 的 atlas_reuse 查。',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: '要什么组件，如「多选下拉」' },
        limit: { type: 'number' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'audit',
    description:
      '体检本仓红线还准不准：protects 的符号是不是已经改名或删了（规则在守空气）、paths 有没有漏掉符号实际出现的位置（有后门）、evidence 的行号还指不指得对。人写的指针必然腐烂，这是机器验完整性。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const repoDir = findRepoRoot(process.cwd());
  // 宿主不给 MCP 进程会话 id：按仓认领钩子记下的当前会话，否则查了也连不上写前守卫
  adoptSessionFor(repoDir);
  const track = (event: Parameters<typeof record>[0], extra?: Parameters<typeof record>[2]) => {
    record(event, repoDir, extra);
  };

  switch (name) {
    case 'check': {
      const files = Array.isArray(args.files)
        ? args.files.filter((x): x is string => typeof x === 'string')
        : [];
      const facts = readFacts(repoDir);
      const snapshot = loadRedlines(repoDir);
      const configured = missingConfig(facts, snapshot).length === 0;

      const verdicts = files
        .map((f) => judge(repoDir, facts, snapshot, f))
        .filter((v): v is NonNullable<typeof v> => v !== null);
      const publicHits = verdicts.filter((v) => v.publicPrefix);
      const ruleHits = verdicts.filter((v) => v.rules.length);

      // configured 标志放第一行是刻意的：模型最容易犯的错是把
      // "没命中" 读成 "安全"。先告诉它我们有没有能力判断。
      const lines = [`configured=${configured}`];
      if (publicHits.length) {
        lines.push('碰到公共层：');
        for (const v of publicHits) lines.push(`- ${v.rel}`);
      } else {
        lines.push('没有碰到公共层。');
      }
      if (ruleHits.length) {
        lines.push('命中红线：');
        for (const v of ruleHits) {
          for (const r of v.rules) {
            lines.push(`- [${r.id}] ${v.rel} —— ${r.rule}`);
            track('redline_hit', { file: v.rel, rule: r.id });
          }
        }
      }
      return lines.join('\n');
    }

    case 'lib_search': {
      const intent = str(args.intent);
      if (!intent) return '缺少 intent。';
      const facts = readFacts(repoDir);
      const info = loadLibrary(repoDir, facts?.componentLibrary ?? null);
      recordLibSearch(repoDir, intent);
      track('graph_query', { detail: 'lib_search' });
      const docs = componentDocsHint(facts);
      if (!info.pkg) {
        return '本仓没有识别到 UI 组件库。如果确实有，可以在 .codebuddy/repo-facts.json 里手动指定 componentLibrary。' + (docs ? '\n' + docs : '');
      }
      const hits = searchLibrary(info, intent, num(args.limit, 5));
      const head = `组件库 ${info.pkg} · 共 ${info.entries.length} 个导出 · 检索「${intent}」`;
      if (!hits.length) {
        return `${head}\n\n没有相近的导出 —— 可以自己写，但仍建议先看仓内高扇入热点。` + (docs ? '\n' + docs : '');
      }
      const lines = [head, ''];
      for (const h of hits) {
        lines.push(`  ${h.name}　[${h.category}]`);
        if (h.oneLiner) lines.push(`      ${h.oneLiner}`);
      }
      lines.push(
        '',
        '命中就别自己造。用之前先查它的 props —— 内部组件库不在模型训练数据里，凭经验写几乎一定错。',
      );
      if (docs) lines.push('', docs);
      return lines.join('\n');
    }

    case 'audit': {
      if (!hasRedlines(repoDir)) {
        return '本仓没有红线文件（.codebuddy/redlines.json），没有可体检的规则。';
      }
      track('graph_query', { detail: 'audit' });
      return formatAuditReport(auditPolicy(loadRedlines(repoDir), repoDir));
    }

    default:
      return `未知工具：${name}`;
  }
}

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> } & Record<string, unknown>;
}

function send(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function handle(req: RpcRequest): Promise<void> {
  const id = req.id ?? null;

  switch (req.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: '0.1.0' },
        },
      });
      return;

    case 'notifications/initialized':
      // 通知没有 id，不回复
      return;

    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;

    case 'tools/call': {
      const name = str(req.params?.name);
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      let text: string;
      try {
        text = await callTool(name, args);
      } catch (e) {
        // 工具内部错误要作为**正常结果**返回而不是 JSON-RPC error。
        // 返回 error 时宿主通常只显示一句"工具调用失败"，模型拿不到可行动的信息；
        // 作为文本返回它至少知道哪里不对。
        text = `repo-guard 执行失败：${(e as Error).message}`;
      }
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      return;
    }

    default:
      // 只有带 id 的请求才回错误；通知（无 id）静默忽略
      if (id !== null) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法：${req.method}` } });
      }
  }
}

/**
 * 读 stdin，按行分帧，**边读边回**。
 *
 * ── 为什么不能一次读完 ──
 * 第一版写的是 `fs.readFileSync(0, 'utf-8')` 然后逐行处理，注释里还专门
 * 为这个"同步读省掉背压和半帧问题"辩解过。那是错的，而且是**死锁**：
 *
 * stdio MCP 的宿主把 `initialize` 写进来之后就等响应，**不关闭 stdin**。
 * 而 readFileSync(0) 要等 EOF 才返回。于是宿主等我回复、我等 EOF，双方僵死，
 * 宿主界面上永远显示"服务仍在连接中"，工具一个都不出现。
 *
 * 这个 bug 在脚本测试里**测不出来**：`printf ... | repo-guard mcp` 的管道
 * 写完就 EOF，同步读立刻返回，一切正常。只有真机装一次才会暴露。
 *
 * ── 为什么按行分帧 ──
 * MCP 的 stdio 传输是一行一个 JSON-RPC 消息（不带 Content-Length 头）。
 * 所以要自己维护缓冲区，攒够一行才解析 —— 一次 data 事件可能给半行，
 * 也可能给三行半。
 */
export async function runMcp(): Promise<number> {
  return new Promise((resolve) => {
    let buf = '';
    /** 串行化处理：工具调用是 async 的，不排队的话回复顺序会乱 */
    let chain: Promise<void> = Promise.resolve();

    const feed = (line: string): void => {
      const s = line.trim();
      if (!s) return;
      let req: RpcRequest;
      try {
        req = JSON.parse(s) as RpcRequest;
      } catch {
        // 坏帧跳过。整个连接不能因为一帧坏了就断 —— 宿主不会重连
        return;
      }
      chain = chain.then(async () => {
        try {
          await handle(req);
        } catch (e) {
          if ((req.id ?? null) !== null) {
            send({
              jsonrpc: '2.0',
              id: req.id ?? null,
              error: { code: -32603, message: (e as Error).message },
            });
          }
        }
      });
    };

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        feed(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    });

    const finish = () => {
      // 收尾：最后一帧可能没有换行（管道直接关闭）
      if (buf.trim()) feed(buf);
      buf = '';
      chain.then(() => resolve(0));
    };

    process.stdin.on('end', finish);
    process.stdin.on('close', finish);
    // stdin 出错（宿主异常退出）也要干净收场，别留一个僵尸进程
    process.stdin.on('error', finish);
    process.stdin.resume();
  });
}

export { TOOLS };
