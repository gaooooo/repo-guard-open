# 七层控制重构 · 开发设计文档

状态：草案，作为后续改动的唯一依据。旧协作全景 L0–L6 仍是过程层内部实现，不再作为开发者添加规范时的目录。

相关：`docs/DESIGN.md`（原设计）· `docs/CONTROL-POINTS.md`（CodeBuddy 控制点）· `docs/hook-timeline-map.html`（时间轴）· `src/graph/PORTING.md`（图谱禁重构）· `src/engine/PORTING.md`（红线禁重构）。

---

## 1. 背景

repo-guard 今天按 **源码层 / 目标文件** 组织：`src/` 里图谱分析器、红线引擎、七道门、规范合并、hook 接线混在一起；`layers/` 按 deerclaw 的 identity/capability/constraint/process 铺配置。

编码阶段已经把资料重新分成七类：

| 分类 | 含义 |
|---|---|
| 工程事实 | 短事实合集，常驻或按路径注入 |
| 技能库 | 怎么做；可挂 MCP |
| 红线 | 哪个符号不许少（protects 次数变少才拦） |
| 过程门禁 | ReAct 内机器关 |
| 人审 | 把决定权交回人：T4 软名单 + T7b ask |
| 合并门禁 | 非 ReAct：工程侧 CI；Agent 侧宿主 permissions |
| 图谱 | 代码现算的结构，不是规范原文 |

问题：

1. 开发者不知道往哪加一条「UI 事实」或「人审」。
2. 图谱和红线判定曾捆在 `src/engine`（已拆到 `src/graph/` vs `src/engine/`）。
3. `stop_and_ask` 名为人审，实现却是 deny。
4. 合并门禁没有独立落点，容易被写进 Stop hook。

## 2. 目标

1. **一个 plugin 仓库**，目录按七类分层，开发者按层添加，不必懂 L0–L6。
2. **图谱源码在本仓 `src/graph/`**，与红线判定分开；不另开仓。以后若外置，plugin 只留 adapter + MCP + require_tool。
3. **分层控制落地**到 CodeBuddy 节点（T3 注入 / T6 rules / T7 拦与人审 / 仓外 CI），而不是再发明一套门。
4. **行为兼容**：项目层不存在 = 零行为变化；人审默认关；公共层未查 impact 仍是否决。

## 3. 非目标

- 本轮不重写图谱打分、不改边权（`PORTING.md`）。
- 不把 L0–L6 从运行时删掉；只是不再作为作者目录。
- 插件不强制宿主 `permissions` / 不代替 CI。
- 不自建知识库检索服务；大块语料继续 MCP 拉。
- 不把 `CODEBUDDY.md` / `rules` 打进插件包冒充分发（宿主不认插件 rules）。

## 4. 目标架构

```
┌─────────────────────────────────────────────────────────┐
│  plugin 仓库（本仓，不另开图谱仓）                          │
│  layers/     作者面：七类各一目录，加人只改这里            │
│  skills/     CodeBuddy 默认发现（技能库正文）              │
│  hooks/      事件拦截接线                                │
│  src/graph/  图谱引擎（analyzers / builder / report）      │
│  src/engine/ 红线判定（policy-* / 扫描器）                 │
│  src/        其余运行时：按层 load + 接到 T3–T11           │
└──────────────────────────┬──────────────────────────────┘
                           │ init --write（不覆盖已有）
┌──────────────────────────▼──────────────────────────────┐
│  被守护仓库 .codebuddy/  + 根 CODEBUDDY.md + rules/       │
└─────────────────────────────────────────────────────────┘
```

作者面与宿主发现面分离：

- 人写：`layers/<类>/`
- 宿主必须在根上的：`skills/` `hooks/` `agents/` `commands/` `.mcp.json`
- 技能层 README 指向根 `skills/`，避免搬目录导致插件加载器找不到。

## 5. 七层规格

### 5.1 工程事实

- **写**：短句。公共层、包名、权威源路径、模块专属事实。
- **不写**：步骤、符号禁令、必须先查图。
- **打包**：`facts.json` 还承载注入用的 taboos / stopConditions / taskRoutes。其中 stopConditions 语义属人审软名单。
- **节点**：
  - 全仓短合集 → 项目根 `CODEBUDDY.md`（T3 全量注入）
  - 按路径 → `.codebuddy/rules/*.md`（`alwaysApply: false` + `paths`，T6）
  - 插件侧 SessionStart 只补公共层/红线摘要，避免与 CODEBUDDY.md 重复
- **本仓模板**：`layers/facts/`
- **生成**：`init --write` 已写 `repo-facts.json`；`init --write --all` / `layers init --write` / `guard init --write` 按本仓目录生成 `facts.json`（required 只含真实路径，已存在不覆盖），并在缺失时写 CODEBUDDY 片段

### 5.2 技能库

- **写**：怎么做；可写「必须先调某某 MCP」。
- **节点**：T2 只注册 name+description；T6 展开正文。
- **正文位置**：仓库根 `skills/<name>/SKILL.md`（宿主约定）。
- **六份规范**（架构/编码/接口/提交/组件/UI）都是技能文档主题，事实句剪进工程事实。

### 5.3 红线

- **写**：`protects` + `paths` 是锁，`reason` 是人的意图。必须进 git。
- **拦什么**：Write/Edit 算出真 diff 后，受保护标识符出现次数变少。
- **不拦**：「意图不清」、字段名没变只改语义、Bash 绕道（只提醒）。这些收不成 `protects`。
- **与人审**：默认 deny。`human-review.json` 打开后，**已经命中的红线**改为 ask。引擎不判断清不清。
- **引擎**：继续 `policy-engine.ts`，禁止另写一套。配完跑 `audit`（守空气 / paths 后门 / evidence 行号）。

### 5.4 过程门禁

- **范围**：ReAct 内、机器拍板。
- **已落地**：公共层已有文件未查 impact → deny（核心，不受 L1 总闸）。
- **默认关**：循环、范围、新建图谱强制、Stop 交付提醒。
- **禁止**：Stop 硬拦 git commit；PreToolUse 挂提醒。

### 5.5 人审

- **独立层**，不是过程门禁的一章，也不是红线。
- **软名单（T4）**：`facts.json` 的 `stopConditions`。收不成符号的「这时停下来问人」，只注入、不拦。
- **硬开关（T7b）**：`.codebuddy/human-review.json`。默认关。打开后只把**红线命中**从 deny 改为 `permissionDecision: ask`。
- **仍 deny**：未查 impact、循环短路、禁改清单——那是手续/冻结，不是「问人要不要改这个符号」。
- 宿主 `permissions.ask`（合入/生产）是合并门禁侧的补充，不是 `stopConditions`。

### 5.6 合并门禁

- **非 ReAct 旁路**。卡的是进主干，不是 T10。
- **工程侧**：CI / pre-commit（lint、测试、scan）。
- **Agent 侧**：宿主 `permissions.ask`（commit / 生产写）。插件给片段，人贴到项目。

### 5.7 图谱

- **不是规范拆出来的**。代码现算。
- **plugin 侧**：MCP 工具 + require_tool + publicLayer 来自推测。
- **hook 内禁止建图**。缓存 miss fail-open。
- **源码**：`src/graph/`。

## 6. 图谱源码放哪

**不另开仓。** 图谱源码已搬到本 plugin 仓库的 `src/graph/`，和红线判定分开。

| | 路径 |
|---|---|
| 源码 | `src/graph/`（analyzers / builder / report / registry / types） |
| 作者说明 | `layers/graph/` |
| 运行时调用 | MCP tools + `src/runtime/graph-cache.ts`（hook 只读缓存） |
| 红线判定 | `src/engine/policy-engine.ts` / `policy-audit.ts`（不是图谱，不要捆回去） |

只允许改路径和 import，禁止重写打分。纪律见 `src/graph/PORTING.md`。

## 7. 运行时接线（按 Agent 时间）

| 时刻 | 层 |
|---|---|
| T0–T1 | 无资料。进程与 hooks 快照 |
| T2 | 技能索引、图谱/组件 MCP 注册 |
| T3 | 工程事实：CODEBUDDY.md + alwaysApply rules |
| T4 | SessionStart 摘要（事实/红线），PostCompact 必须能重注 |
| T5 | 按任务点名 skill、「去读」路径 |
| T6 | skill 正文；rules 路径命中 |
| T7a | 过程门禁 deny、红线 deny |
| T7b | 人审 ask |
| T7c | 宿主执行（plugin 不实现） |
| T7d | 图谱/组件 MCP 真正跑 |
| T7e | 过程门禁 remind |
| T10 | 交付提醒；↺ continue:false 回 T6 |
| 旁路 | 合并门禁（CI / 人 commit） |
| T11 | 留痕，不进 git |

`rules` 不是第八类，是工程事实的第二种写入节点。

## 8. 目录迁移

### 8.1 新增（作者面）

```
layers/
  README.md
  facts/                 CODEBUDDY.snippet.md  rules/*.md
  skills/README.md       指向根 skills/
  redlines/README.md
  process-gates/README.md
  human-review/          ask.json + README
  merge-gates/           permissions.ask.example.json
  graph/README.md
src/layers/              运行时 load（人审已落地）
docs/PLUGIN-LAYERS.md    给人看的地图（本设计的摘要）
```

### 8.2 暂不搬、只做映射

| 旧位置 | 映射到 |
|---|---|
| `layers/process-gates/process/*` | 过程门禁 |
| `layers/redlines/redlines.json` | 红线 |
| `layers/facts/repo-facts.defaults.json` | 工程事实 |
| `layers/skills/standards/*` | 技能库下的规范目录（运行时合并） |
| `src/gates/*` | 过程门禁实现，内部仍可叫 L1/L3 |
| `src/graph/**` | 图谱源码（已搬家） |

standards 五端 JSON 继续工作，直到有迁移脚本按条目 `severity`/`check.kind` 拆到七层。禁止手撕导致运行时空洞。

### 8.3 被守护仓库落盘

```
CODEBUDDY.md                 工程事实合集
.codebuddy/rules/*.md        按路径事实
.codebuddy/repo-facts.json   公共层等机器事实
.codebuddy/redlines.json
.codebuddy/human-review.json 人审开关，默认无此文件=关
.codebuddy/guard/            旧七道门配置，过程门禁仍读它
```

生成纪律：默认不写；`--write` 才写；已存在不覆盖。

## 9. 行为兼容

| 条件 | 必须 |
|---|---|
| 无 `.codebuddy/repo-facts.json` | 公共层守卫不拦，并明说未生效 |
| 无 `human-review.json` 或 `enabled:false` | 红线仍 deny，与改前一致 |
| 无 `layers/` 作者改动 | `npm run check` 全绿 |
| `verify-hooks` 58 条 | 继续在无 guard 的临时仓上跑 |

新增人审只在项目显式打开后改变红线处置。

## 10. 分期

### P0 设计冻结（本文）

评审冻结后已搬 src/graph/；templates/ 已并入 layers/。

### P1 作者面 + 人审接线（本迭代）

- [x] `layers/` 七目录与 README
- [x] `src/layers/human-review.ts` + PreToolUse `ask`
- [x] `repo-guard layers` 打印地图
- [x] `repo-guard layers init [--write]`：把人审/合并门禁/事实片段铺到项目（不覆盖）
- [x] SessionStart 文案标明「工程事实见 CODEBUDDY.md」
- [x] `verify-hooks` 增加：无 human-review 时红线仍 deny；打开后 ask（HR-1 / HR-2）

### P2 过程门禁收口

- 公共层守卫、循环、graph-enforce 的配置入口统一到 `layers/process-gates/` 说明，运行时仍读 `guard/` 或一次兼容读取
- Stop 交付保持默认关

### P3 工程事实生成 / 一次铺齐

- `repo-guard init --write --all` 一次铺齐：repo-facts、CODEBUDDY.md（缺失才写）、红线、guard、standards、人审/合并门禁片段。
- 默认 `init --write` **不变**（parity 锁 stdout）。
- `CODEBUDDY.md` 已存在则跳过。

### P3b 工程事实生成

- `init --write` 可选生成 `CODEBUDDY.md` 片段（文件已存在则跳过）
- 示例 rules 按探测到的前端栈决定是否铺 `ui-tokens.md`

### P4 图谱目录搬家（仍在本仓）

- [x] `src/engine/graph*` → `src/graph/`，只改路径，不改算法
- parity 必须先绿

### P5 作者面与机器面对齐

- [x] 删除 templates/，全部进 layers/
- [x] identity/capability 归入 facts/ 与 skills/；init 仍铺到项目 .codebuddy/guard/
- 条目仍按端切文件（注入预算），不手撕 56 条

### P6 删除轮（本工程未上线，无用即删）

不保留「占位以免将来用」。**已经删掉的：**

- 需求复述：`src/gates/restate.ts`、`layers/process-gates/process/restate.json`、hook 调用、verify R-1/R-2/R-3
- `themes/` `monitors/` `output-styles/`（宿主不加载的占位）
- `layers/process-gates/identity/roles.json`（没有任何运行时读取）
- `src/engine/graph*` 空壳（已迁到 `src/graph/`；`src/engine/` 只留红线判定，不改名——还在被 import）

**还不能删，因为仍在跑（不是债务，是未拆完的运行时）：**

- （已完成）规范在 layers/skills/standards/
- 项目仓仍读 .codebuddy/guard/identity|capability（init 从 layers 拷入）
- L0–L6 作为 `src/gates` 内部名 —— 不是作者目录，运行时还在用

## 11. 验收

- `npm run check`（typecheck + build + verify-hooks + parity）
- 无项目层配置时，hook 输出与改前一致
- 开发者只看 `layers/README.md` 能回答「新加一条 UI 事实 / 一条红线 / 一道人审 分别放哪」
- 时间轴图（`docs/hook-timeline-map.html`）与七层映射不互相发明新类

## 12. 风险

| 风险 | 对策 |
|---|---|
| 两套目录（layers vs layers/process-gates vs standards）让人更晕 | 作者只宣传 layers；旧路径在 README 标「运行时兼容，勿新增」 |
| 人审 ask 变 deny 误伤 | 默认关；verify-hooks 钉住 |
| 拆图谱仓打分漂 | 禁止重构；parity；PORTING 随仓走 |
| CODEBUDDY.md 与 SessionStart 重复 | SessionStart 只补机器摘要，长事实只在 CODEBUDDY.md |
