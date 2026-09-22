# src/graph —— 图谱移植区

这个目录是从 deerclaw 逐字搬过来的图谱分析引擎。**不要在这里重构。**

来源：`deerclaw/src/knowledge/`（同名同层级，路径一一对应）

| 这里 | deerclaw |
|---|---|
| `{analyzer,registry,types}.ts` | `knowledge/graph/` 同名 |
| `analyzers/*.ts` + `py_graph.py` | `knowledge/graph/analyzers/` 同名 |
| `graph-builder.ts` | 建图入口 + `analyzeImpact` / `hotSpots` / `traceRoute` / `similarPages` / 边权打分 |
| `graph-report.ts` | 渲染层：`renderImpact` / `renderTrace` / `renderHot` / `renderSimilar` / `renderApiContractsAsTs` |

红线判定已留在 `src/engine/`（`policy-engine.ts` / `policy-audit.ts` / 扫描器），不在本目录。

## 为什么逐字搬而不是重写

打分权重、边类型、置信度阈值、各语言分析器的启发式规则，都是在真实仓库上调出来的。
重写一遍必然漂，而漂了之后**没有报错**——只表现为"影响面算出来不一样"。
`build/verify-parity.mjs` 就是为了守住这件事：新旧产物同输入逐字节比对。

## 允许的改动

1. **`@deerclaw/shared` 的 `createLogger`** → `src/engine/shims/logger.ts`（从本目录 import `../engine/shims/logger.js`）。
   原版是 pino，默认写 stdout。而这里 stdout 是协议通道（hook 的 JSON、MCP 的
   JSON-RPC、CLI 给人看的报告），多一个字节宿主就解析失败。shim 一律写 stderr，
   且默认静默，靠 `REPO_GUARD_DEBUG` 打开。

2. **`../context/token-estimator.js`** → `src/engine/shims/token-estimator.ts`。
   只摘 `estimateTokens` 一个函数（`graph-report` 用它算省了多少上下文）。
   原文件其余部分依赖 deerclaw 的模型注册表和服务端回传的 usage，搬过来是死代码。

3. **删掉 `policy-source.ts`**。那是红线的**平台侧数据源**：drizzle + deerclaw
   的 `policy_rules` / `agent_configs` 表，按 agent 维度加载、按 `updated_at` 失效。
   零服务端插件里没有数据库，它一行都跑不起来。等价物是 `src/runtime/redlines.ts`
   —— 从 `.codebuddy/redlines.json` 读，产出**同样形状**的 `KnowledgeSnapshot`，
   所以 `policy-engine` / `policy-audit` 全链路零改动，这正是原文件注释里
   强调的那条契约。

4. **两处纯类型层修正**，源码里用「【移植偏差 · 仅类型层】」标注：
   - `analyzers/go-gin.ts`：把 `m[1]` / `m[2]` 提成局部常量（TS 在回调内
     丢掉 `while` 条件对 `m` 的非空收窄，TS18047）。
   - `analyzers/web-frontend.ts`：`defaultObjectTable` 接成局部常量并
     `as` 回联合类型（赋值在嵌套闭包里，CFA 看不到，`if` 之后收成 `never`，TS2488）。

   这两个错误 **deerclaw 自己也报**（那边 `tsc --noEmit` 有 40 个既有错误），
   不是移植引入的。改法只动类型、不动运行时语义 —— 回调是同步执行的。

5. **删掉三个文件**（除第 3 条的 `policy-source.ts` 外，还有两个）：

   | 删掉的 | 为什么 |
   |---|---|
   | `policy-source.ts` | 红线的**平台侧数据源**：drizzle + deerclaw 的 `policy_rules` / `agent_configs` 表，按 agent 维度加载、按 `updated_at` 失效。零服务端下一行都跑不起来。等价物是 `src/runtime/redlines.ts`，产出**同样形状**的 `KnowledgeSnapshot`，所以 `policy-engine` / `policy-audit` 全链路零改动 —— 这正是原文件注释里强调的那条契约 |
   | `graph-query-payload.ts` | 纯平台产物：它的用途是写进 deerclaw 的 `trace_events.data`，文件头自己写着「放 knowledge 层，避免 admin ↔ agent 静态环」。插件里既没有 trace_events 表，也没有那个环 |
   | `graph-freshness.ts` | 它的判据是 commit sha 比对（平台侧图谱存库，靠 `updated_at` 与 sha 判失效）。`src/runtime/graph-cache.ts` 的判据是**严格超集**：sha + 源文件最大 mtime + 文件数。多出来的 mtime 那一条是关键 —— 它管的是"改了还没提交"，而平台侧场景下 agent 的改动总会提交，插件场景下人就在本地改 |

   **一条纪律**：删除只允许发生在"这个文件在插件形态下不可能工作"或
   "已有严格更强的替代"这两种情况。不许因为"现在没用到"就删 ——
   现在没用到的可能是下一道门要用的（`policy-engine` 的 `checkToolCall` 就是例子）。

6. **目录搬家**（`src/engine/graph*` -> `src/graph/`）。只改相对 import，不改打分。

## 同步回 deerclaw 时

如果 deerclaw 那边改了引擎，重新拷贝后要做的事：
1. 重新应用上面第 1、2、4 条（第 3 条是删除，不用管）。
2. `npm run typecheck`
3. `npm run build && node build/verify-parity.mjs` —— 有 diff 必须逐条判定是
   "deerclaw 有意改了行为" 还是 "移植漂了"，不能直接刷新基线。
