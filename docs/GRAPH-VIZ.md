# 图谱可视化能力设计

> 状态：**设计稿 v3**。不改打分、不改建图、不在 hook 里渲染。
> 数据源：`<repo>/.codebuddy/.cache/{graph.json,meta.json}`。
> 样例仓：`backend-agent-identity`（`go-trpc`）。

可视化要画的是**有向关系图**（graph drawing），不是文件卡片看板。节点默认是**方法**；类型图、模块图是可切换的粒度。

---

## 1. 缓存落点

只读 `<repo>/.codebuddy/.cache/{graph.json,meta.json}`，不在视图里建图。不是仓库根 `.cache/`。

---

## 2. 粒度：方法、类型、模块各管一档问题

同类产品（IntelliJ Diagram、NDepend、Understand、Sourcegraph、madge）都用图绘制，但**节点粒度不同**：

| 粒度 | 节点 | 边 | 何时默认 | 本样例仓的事实 |
|---|---|---|---|---|
| **方法** | `DescribeAgent`、`FindOne`、`OAuth2Authorize` | `CallEdge` | **本仓默认。** impact / trace / hot 都问符号 | 707 函数；真实主干是 handler → `DescribeAgent` → `FindOne` |
| **类型** | `AgentLogicImpl`、`AgentRepoImpl`、`Agent` | 实现 / 拥有 / 使用 | Java Spring Bean、改结构体、问「谁用了这个类型」 | 361 个 class 里 234 个是无方法 dto。类型图在这里是数据模型，不是行为图 |
| **模块** | `logic/agent.go` | import | 鸟瞰分层、找 publicLayer | dto 扇入 53、93 个弱入口，**作主图会误导** |

规则：改行为、追调用、看热点 → 方法图。改 struct / Bean / 组件 → 类型图。只看目录 → 模块缩略。

Go 身份仓不该默认画类图：`AgentLogicImpl` 有方法，但大量节点会是 `MetaData` 这种空 struct。Java 仓相反。前端组件按类型画，普通函数按方法画。

跨平面不必先拆文件图：`DescribeAgent` 同时被管控 CRUD 和 `OAuth2Authorize` / `RegisterAgent` 调用，**一个方法节点、两边入边**就是关联。

真微服务：两张方法图，用 `@api` 与 `urlPath` 接 handler。没有对面 cache 不得画假图。

---

## 3. 怎么画

分层有向图（Sugiyama，LR）：调用方在左，被调方在右。extracted 实线带箭头，inferred 虚线，跨平面入边用另一色。

禁止默认力导向：方法图会糊成线团，类型图会把 dto 吸到中心。

点节点：ego-network + 弹窗（健康度 / 影响面 / 调用链 / 热点），证据落在**这个符号**上，不要回退成整个文件。

---

## 4. 弹窗（方法级口径）

以 `AgentLogicImpl.DescribeAgent` 为准，不是 `logic/agent.go` 整文件：

- **健康度**：调用边 extracted；打到它的路由名多为 inferred；热点 9 入口；下游 `Count` 同名 9 组会高估。不打百分制。
- **影响面**：谁调用这个方法（admin CRUD、OAuth、plugin）。入口 ≥ 5 则只加可选参数。不要把 dto 文件 93×0.3 算进来。
- **调用链**：`DescribeAIMAgent` → `DescribeAgent` → `FindOne`。
- **热点**：`DescribeAgent` 9、`Count` 7。类型扇入不是能力热点。

文件级 impact（37 强入口）仍可在弹窗里作为「所在文件」补充，但主数字要跟当前节点粒度走。

---

## 5. 检索仍是输入，画回这张图

- **字段** `Agent.ID`：切到类型/字段层，亮 `Agent` + literal `"_id"`，不亮 93 个接口。
- **同类** 「Agent CRUD」：高亮同形状的 handler 方法家族，标明骨架检索。 「列表页」：无指纹，失败显式化。
- **盲区** `Count`：亮 `AgentLogicImpl.Count` 与 `AgentRepoImpl.Count`（这正是方法图比文件图强的地方）。`_test.go` 不在图上，叠不出来。

---

## 6. 指令

`/repo-guard:graph` 打开方法图。`impact` / `trace` / `hot` 选中符号。`field` / `similar` 走检索。P1 的 `impact` 必须能吃 `file#Method`。

---

## 7. 明确不做

默认力导向；默认文件卡片泳道；把 dto 弱传播当强影响；Go 仓默认类图；假前端微服务图；改边权；hook 里建图。

---

## 8. 验收

1. 默认看见的是 `DescribeAIMAgent → DescribeAgent → FindOne`，不是 `admin/agent.go` 卡片
2. 能切到类型图看到 `AgentLogicImpl → AgentRepoImpl`，以及 dto `Agent`
3. 点 `DescribeAgent`：左右入边（管控 + 运行时）和出边 `FindOne` 同时亮
4. 盲区 Count 命中两个 `Count` 方法节点
5. 字段 `Agent.ID` 不出现 93 个入口

---

## 9. 微服务 → 文件 → 类 → 方法：做层级，不要一次铺完整大图

完整大图作为**数据**是对的：cache 里本来就有 module / class / function / call。默认**画面**不要把四层节点和全部连线一次性画出来。

| 关系 | 怎么画 | 不能怎么画 |
|---|---|---|
| 包含（树） | 展开/折叠、包围盒、辐射层级。边无箭头或浅灰 | 和调用边画成同一种线 |
| 依赖（图） | 当前可见层级的 import/call，带箭头 | 把 1950 条 call 和包含边混在一张力导向图里 |

**按需展开（语义缩放）**

1. 中心：微服务名（本仓 `webapi`）
2. 一圈：文件（或 API 域）。此时只画文件间 import
3. 点文件：展开类；若没有类（本仓 221 个函数、1 个 `Config`），方法直接挂在文件下，并标明「无类型」
4. 点类：展开方法
5. 点方法：才画调用边（含仓外 `pkg`）

「展开全部方法」可以做，但要标明会糊。NDepend / Understand / IntelliJ 都是一层主视图 + drill-down，不是一上来 400+ 节点。

跨仓：中心换成多个微服务，边只在 API/`pkg` 对齐处连，不要把两个仓的方法铺在同一张无层级图上。

---

## 10. 已实现：`repo-guard viz`（本地单仓体检 + 沙盘）

| 形态 | 命令 | 用途 |
|---|---|---|
| 静态页 | `repo-guard viz [--out <目录>]` | 体检与图浏览，payload 与 echarts 全内联，可离线发人。默认写 `<repo>/.codebuddy/.cache/viz/` |
| 沙盘 | `repo-guard viz --serve [--port 7788]` | 在图上调 impact / similar / trace / hot / check…，并模拟一次写入会不会被守卫拦 |
| 斜杠命令 | `/repo-guard:graph [static]` | 让 AI 起服务并报地址 |

**三条不变量**（`build/verify-viz.mjs` 守，挂在 `npm run check` 里）：

1. 沙盘 `/api/tool` 与 MCP `tools/call` 走同一个 `callTool`，text 逐字一致。
2. 沙盘调用 `sideEffects:false`：不写会话状态、不记埋点 —— 人点一下不会替 AI 放行守卫。
3. 写入模拟复用 pre-write 的判定与拒绝文案；循环门、范围门、红线内容级判定不模拟，页面上写明。

**体检口径**（`src/insight/health.ts`，纯函数，下期可搬去平台）：只列原始数字不打总分；
可信度按调用解析率与路由追通率分 high / medium / low，放在最前面；复杂度为「体量 × 调用点」近似；
上帝方法 = ≥50 行且扇入 ≥3（按四个 gateway 仓校准）。

**字段 / 同类在插件里的落点**：
- 字段 → `impact` 带 `symbol`（或 `file#Field`），走引擎的字段级分支：点访问读写 + 字符串键，
  别的结构体撞名的 tag 只计数不列出，不再把 dto 文件扩成全部接口。
- 同类 → `similar` 在没有页面指纹的后端仓改走方法家族（`src/insight/similar-methods.ts`）：
  同族成员按分层列出、给一条 接口层 → 逻辑层 → 存储层 的参考骨架、报 CRUD 缺口。

**下期**：回放（会话记录 + 埋点叠到图上）、跨仓视图、平台侧体检趋势。

## 11. 新功能需求：AI 自己找参考并照着写

用户只说「开发资产管理，包括增删改查」，不写「参考 xx 实现」。链路：

| 环节 | 位置 | 做什么 |
|---|---|---|
| 提示 | UserPromptSubmit（`featureHint`） | 原话同时有「开发/新增/实现」和「管理/接口/功能」时注入：拆成 resource + verbs 调 similar，方案首句写明「参考 X 实现 Y」 |
| 参考 | similar（`resource` / `verbs` / `template`） | 已存在 → 逐动作核对并附「另起一套」候选；不存在 → 3~5 张候选卡片（业务注释、下游是本仓存储还是外部服务、目录、接口数），AI 按语义挑，选的不是第 1 个就带 `template` 重查 |
| 守卫 | 新建门（需开 `newPageSimilar`） | 未查 similar 拦；查过但写的是别的资源（查 Asset 写 CreateWidget）也拦；带本仓前缀（CreateAIMAsset）算同一资源 |
| 比对 | Stop（`src/insight/conform.ts`） | 本轮新写的接口是否照参考骨架分层；跳过逻辑层 / 下游不一致 / 计划里「已有」却又写了一个 → 阻止停止（每会话最多 2 次），一致则只记埋点 |
| 证据 | `metrics.ndjson` | `feature_hint` → `similar_plan`（`new:Asset<-AIMAgents`）→ `conform_ok` / `conform_drift`，同一会话 id |

会话认领：宿主拉起 MCP 时不带 `CODEBUDDY_SESSION_ID`，查询曾记在 `_nosession`、与钩子连不上（查了 impact 仍被拦）。
现在钩子把「本仓当前会话」写进 `~/.repo-guard/state/_current/<repoId>.json`，MCP 与 CLI 拿不到环境变量时按仓认领（12 小时过期）。

手动比对：`repo-guard conform`（计划取本会话 similar 记录，改动取会话记录 ∪ git 工作区）。
