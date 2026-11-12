# repo-guard v2 设计：开发过程控制

> 状态：已确认（2026-11-12，同日第二次修订：控制方式校正、init 引导、合并门提到 Beta）。Beta 已实现，实现中与原方案的差异见第 15 节。
> 取代 [PROCESS-GATES.md](PROCESS-GATES.md) 与 [DESIGN-SEVEN-LAYERS.md](DESIGN-SEVEN-LAYERS.md) 中的过程控制部分；图谱能力仍以 code-atlas 为准，不在本文范围。

---

## 1. 要解决的问题

做过程控制，是因为 vibe coding 会稳定地产生这几类问题：

| 现象 | 根因 | 控制手段 |
|---|---|---|
| 代码肿胀：过度防御、重复兜底、多余校验 | 模型默认"多写更稳" | 短开发基线 + 只量本次增量 + 精简审查 |
| 已有实现又写一份 | 写之前没去找 | 新建前查图谱（atlas hot / similar），写完 atlas review 查重 |
| 复杂度高，人读不懂 | 没有量化，也没有反馈 | 只量本次改到的函数（长度 / 嵌套 / 参数），超了就提醒 |
| 改了范围外的内容、顺手优化 | 任务没有边界 | 任务契约 + 范围检查 + "顺手发现"出口 |
| 红线 / 门禁 | 规则分散，默认不生效 | 单一配置；会话内回执和合并门用同一套检查 |

现状的问题不在能力不够：七层分类、二十多份配置、过程门禁默认全关，没有一条主线把"防肿胀、防重复、防越界"串起来。v2 的目标是**一条主线、一个配置文件、默认就有效果、启用了什么开发者都知道**。

## 2. 设计原则（业界共识）

1. **先规划，再执行**（Kiro / Spec Kit / plan 模式）：先写目标、不做什么、验收标准，再动手。防越界最有效的就是这一步。
2. **提示词短、讲原因、反复出现**：开头注入的长规范，会话一长就被冲淡。会话开始给约 6 行基线，每轮补一行任务摘要，上下文压缩后和子代理启动时补全量。不用 MUST / CRITICAL 这类强调词。
3. **确定性的事交给钩子，判断性的事交给审查**：路径能不能写、命令能不能跑由钩子硬判；"这段防御多不多余"由干净上下文的审查子代理判，正则判不了语义。
4. **只管新增代码**（Clean as You Code）：历史债和用户原有的改动不算 AI 的。
5. **按证据交付**：只认"最后一次写文件之后跑过验收命令、退出码是 0"，不认模型说"已验证"。
6. **从提醒逐级收紧**：先 remind 收数据，误伤低了再升 enforce。不自动清理，不循环修复。
7. **启用什么要告知**：init 逐项说明并让人选择；动工程共享文件（pre-commit / CI）一律默认不勾。

## 3. 控制方式与宿主约束

### 3.1 四种控制方式

| 方式 | 含义 | 宿主机制 |
|---|---|---|
| 提示 | 注入上下文，靠模型遵守，没有判断 | SessionStart / UserPromptSubmit / PostCompact / SubagentStart 的 `additionalContext` |
| 软判 | 钩子按规则判断，命中后提醒模型，不拦 | **PostToolUse** 的 `additionalContext`（写后提醒） |
| 强判 | 拒绝本次操作、弹窗让人确认，或不让模型结束 | PreToolUse 的 `permissionDecision: deny / ask`；Stop 的 `continue: false` + `reason` |
| 人判 | 展示给人，由人决定 | `systemMessage`（只给人看，不进模型上下文）；终端里可见的 MCP 调用 |

### 3.2 宿主约束（决定了上表的取舍）

- **PreToolUse 没有"只提醒不拦"的输出**：只能 `allow` / `deny` / `ask`。返回 `allow` 会绕过用户的权限确认，不可用作提醒。所以 **remind 档一律写后提醒（PostToolUse），写前钩子只输出 deny / ask 或什么都不输出**（沿用现有实现的铁律）。
- Stop 的 `decision: block` 已被宿主废弃，用 `continue: false` + `reason`；宿主没有实现 loop_limit，同一 reason 每会话只续跑一次，否则无限续跑。
- `UserPromptSubmit` 绝不阻塞；所有钩子超时 15~30 秒；钩子出错一律放行（fail-open）。
- matcher 同时覆盖 CLI 与 IDE 两套工具名（`Write|Edit|MultiEdit|NotebookEdit|write_to_file|replace_in_file|edit_file|multi_replace`）。

### 3.3 档位与总档位 `mode`

- 档位：`off` 不检查；`remind` 软判（写后提醒 / 回执里列出）；`enforce` 强判（写前拒绝或弹窗）。
- `mode` 是**启发式检查**（范围、复用、复杂度、体量、验证）的上限：`mode: remind` 时子项写 `enforce` 也只提醒。
- **红线不受 `mode` 约束**：红线是人明确写下的意图，按条目自己的 `action`（`remind` / `ask` / `block`）执行。`mode: off` 时红线仍生效，要关红线就删条目。
- **契约缺失拦截是例外**：默认 `remind` 档下仍拒绝一次（见 4.1）。代价只是模型补一次 `guard_task`，换来所有多文件任务都有边界。
- **公共层影响面拦截**沿用现有行为（强判），由 `publicLayer` 是否为空决定开关，不受 `mode` 约束。

### 3.4 配置面与控制面

配置面和控制面是每一项过程控制都有的两个方面，不是把控制项分成两堆：

- **配置面**：规定"要什么"，全部在 `.codebuddy/repo-guard.json`。红线（`redlines.*`）是其中一类，其余是过程控制的档位与阈值。
- **控制面**：规定"什么时候、用什么方式执行"，由钩子与 `repo-guard check` 实现。执行方式有四种：注入、提醒、展示、门禁（拦截）。门禁只是其中会拦人的那一种。

同一个字段可能因档位不同走不同的执行方式，例如 `task.scope` 在 remind 档是写后提醒，在 enforce 档是写前门禁。配置面为"无"的项是内置的，不对外暴露。

| 过程控制 | 配置面（`repo-guard.json`） | 控制面（时点 · 方式） |
|---|---|---|
| 开发基线 | `baseline.extra`（内置 6 行只读） | 会话开始、压缩后、子代理启动 · 注入 |
| 任务契约 | `task.contract` | 写前 · 门禁（拦一次）；每轮提问 · 注入摘要 |
| 范围越界 | `task.scope` | 写后 · 提醒（remind）/ 写前 · 门禁（enforce）；结束 · 回执 |
| 复用优先 | `reuse.beforeNew` | 写后 · 提醒 / 写前 · 门禁；结束 · 回执查重 |
| 公共层影响面 | `publicLayer` | 写前 · 门禁 |
| 复杂度与体量 | `budget.*` | 写后 · 提醒；结束 · 回执；合并门 |
| 验证 | `verify.commands`、`verify.onStop` | 结束 · 回执 / 门禁（enforce） |
| 红线（路径 / 字段 / 内容 / 命令） | `redlines.*` | 写前、命令前 · 门禁；写后 · 兜底提醒；合并门 |
| 改动回执 | `mode`（off 时关闭） | 结束 · 展示 + 要求说明 |
| 写后比对、循环提醒 | 无（内置） | 结束 · 门禁 / 写后 · 提醒 |
| 合并门 | 挂不挂、挂在哪由 init 选择（落在工程的 hook 文件里） | 提交或合并 · 退出码 |
| 总档位 | `mode` | 作用于上面所有启发式项 |

不属于这两个面、但支撑它们的三样东西：

| 支撑 | 内容 | 作用 |
|---|---|---|
| 状态 | 会话里记录的契约、写前快照、写入与命令记录、atlas 查询回执 | 控制面的判断依据（如"查过 impact 没有""最后一次写入之后跑过验收没有"）；不可配，也不执行动作 |
| 观测 | 埋点与 `repo-guard governance` | 记录每个控制点拦了多少、提醒了多少、有没有被绕过，用来回调配置面（何时升 enforce、阈值是否放宽） |
| 外部能力 | code-atlas（影响面、同类实现、查重） | 控制面调用它，它本身不属于 repo-guard 的控制 |

`init` 与 `status` 是配置面的管理入口：init 生成配置并告知开发者，status 查看当前生效的配置。

整体关系：配置面定义要什么 → 控制面在各时点执行 → 状态提供判断依据 → 观测回调配置面。

## 4. 主线

~~~
任务契约 ──→ 写时控制 ──→ 改动回执（交付门） ──→ 合并门（pre-commit / CI）
  事前           事中              事后                  入库
~~~

### 4.1 任务契约（事前）

- MCP 工具 `guard_task`：字段为 `goal`（目标）、`nonGoals`（不做什么）、`scope`（目录或文件 glob 数组）、`verify`（验收命令，可省，省略时用配置里的 `verify.commands`）、`reason`（扩范围时必填）。
- 契约由 AI 根据需求起草，开发者只需要看一眼；写错了直接打断让它改，AI 再调一次 `guard_task` 覆盖即可。
- 触发规则（`task.contract: auto`）：只改 1 个文件时不要求契约；开始写第 2 个不同文件时还没有契约，PreToolUse 拒绝一次并说明"先调用 guard_task 声明契约"。`required` 则第一次写就要求。测试文件、文档不计入文件数。
- 基线是**写前快照**：每个文件在本会话第一次经写工具改动之前，存一份当时的内容（新文件记为空）。体量、复杂度、噪声都只对 AI 写过的文件、对比这份快照计算，开发者原有的改动和会话中自己改的其他文件都不算进去；不依赖 git。超过 1MB 的文件不存快照，回执里列为「无基线」。
- 契约注入：每轮 UserPromptSubmit 注入一行摘要（目标 + 范围）；PostCompact 与 SubagentStart 注入全量。
- MCP 工具 `guard_note`：AI 发现范围外的问题（命名、重复查询、可优化处）记在这里，不改；回执里列给开发者决定。

### 4.2 写时控制（事中）

| 检查 | remind（默认） | enforce |
|---|---|---|
| 范围越界 | 写后提醒"不在契约范围"，要求撤回或调 `guard_task` 扩范围并写理由；记进回执 | 写前弹窗（`ask`）让人确认 |
| 复用 | 新建文件 / 新增函数后，本轮没查过 atlas hot / similar 时提醒一次 | 写前拒绝，查过才放行 |
| 复杂度增量 | 本次新增或变长的函数超阈值，写后提醒一次（每函数一次） | 同左（写后无法拦） |
| shell 旁路写入 | 提醒（PreToolUse(Bash) 无法提醒，改为 PostToolUse(Bash) 写后提醒） | 同左（误伤率高，不拦） |
| 红线路径 / 命令 | 不受档位影响，按条目 `action`：`remind` 写后提醒 / `ask` 写前弹窗 / `block` 写前拒绝 | 同左 |
| 公共层影响面 | 改 `publicLayer` 下已有文件且本轮没查 atlas impact → 写前拒绝 | 同左 |
| 循环门 | 连续失败 3 次（或同文件写失败 2 次）时写后提醒"换个思路或停下来问人"，不拦；内部保护，不暴露配置 | 同左 |

### 4.3 改动回执（交付门，Stop）

结束前对比基线计算 diff，生成回执：

~~~
[repo-guard] 改了 5 个文件 | 越界 1 个（repo/agent.go：需要加查询条件）| 扩范围 1 次
体量    新增 96 行 / 删除 12 行，新文件 1 个，新函数 2 个
复杂度  无超限
复用    atlas review：无疑似重复
噪声    0 处只改格式 / 注释的片段
验证    go test ./internal/logic/agent/... 通过（在最后一次写入之后）
顺手发现 1 条：logic/agent/list.go:40 重复查询（未改）
~~~

- **给人看**：Stop 钩子的 `systemMessage`，不进模型上下文。
- **给模型看**：有待说明的项（越界、超预算、超复杂度、疑似重复、噪声、未验证）时，用 `continue: false` + `reason` 让模型续跑一次，在最终回复里逐条说明"保留的理由"或"已撤回"。**强制的是说明，不强制修改。**同一份回执每会话只续跑一次。
- `verify.onStop: enforce` 时，未验证改为要求先跑通验收命令再结束（同样每会话一次）。
- **噪声**：diff 中只改空白、格式、注释、import 顺序的片段，视为疑似顺手优化。
- **验证证据**：从 PostToolUse(Bash) 记录中找"最后一次写入之后执行、命中验收命令、退出码 0"的那次；找不到就写"未验证"。
- 超出体量预算时，提示可以跑 `/repo-guard:review`（二期）。
- 没有任何写操作的会话不出回执。`repo-guard receipt` 可随时在终端查看当前任务的回执。

**降级行为**（缺依赖时不报错，回执里注明）：

| 情况 | 影响 | 回执显示 |
|---|---|---|
| 非 git 仓 | 会话内回执照常（基线是写前快照）；合并门 `check` 不可用 | 回执不受影响；`check` 提示不是 git 仓 |
| 用 shell 改的文件、超过 1MB 的文件 | 没有写前快照，不量增量 | "无基线"，只列文件 |
| 没装 atlas / 本仓未登记 | 复用检查、公共层影响面、atlas review 跳过 | "图谱不可用，复用与影响面未检查" |
| 未配置验收命令 | 验证项无法判定 | "未配置验收命令"，不报失败 |

### 4.4 合并门（入库，Beta）

~~~bash
repo-guard check --staged               # 只查暂存区，给 pre-commit 用
repo-guard check --base origin/master   # 对比目标分支，给 CI 用；有问题非零退出
~~~

和回执是同一套代码，只是触发时机和基线不同：

| | 会话内（Stop） | 合并门（命令行） |
|---|---|---|
| 触发 | AI 每轮结束 | 人 `git commit` / 流水线 |
| 基线 | 任务开始时记的基线 | 暂存区 / `--base` 指定分支 |
| 能查 | 全部 | 只有能从 diff 算出的：红线、体量、复杂度、atlas 查重 |
| 查不了 | — | 范围越界、验证证据（没有契约和会话记录） |

它**不复用也不提取**工程已有的 lint / 测试，是一个额外的检查步骤。是否加入工程、加到哪里，在 init 第 ④ 步由人选择（见第 7 节），默认不加。和工程现有命令唯一的关系是 `verify.commands`：init 从 `Makefile`、`package.json` scripts、`go.mod` 推测候选，人确认。

## 5. 开发基线

会话开始（SessionStart）注入，内置，约 6 行；项目可用 `baseline.extra` 追加：

~~~
1. 只做任务契约里的事；发现其他问题记到 guard_note，不要改。
2. 新写函数、组件前先 atlas hot / similar，已有就复用。
3. 最简实现：不为假想需求加参数、配置、抽象层，不做不必要的拆分。
4. 校验只放在边界（用户输入、外部接口）；内部调用信任调用方，不重复判空、不叠兜底。
5. 不改无关代码的格式、命名、注释，不做顺手重构。
6. 完成前跑契约里的验收命令，如实报告结果。
~~~

## 6. 控制点总表

方式见 3.1；配置：**无** = 内置；**可选** = 有默认值；**确认** = init 推测、人确认；**必配** = 不配不生效。

| # | 环节 | 控制点 | 在哪里 | 方式 | 开发者配置 |
|---|---|---|---|---|---|
| 1 | 事前 | 开发基线 | SessionStart；PostCompact / SubagentStart 重注入 | 提示 | 无；可选 `baseline.extra` |
| 2 | 事前 | 起草契约 | MCP `guard_task` | 提示 + 人判 | 无 |
| 3 | 事前 | 没有契约就写代码 | PreToolUse（写工具） | **强判**：写第 2 个文件时拒绝一次（例外，见 3.3） | 可选 `task.contract` |
| 4 | 事前 | 记录基线 | `guard_task` 首次调用 | 内部机制 | 无 |
| 5 | 事前 | 每轮契约摘要 | UserPromptSubmit | 提示 | 无 |
| 6 | 事中 | 红线路径 | `ask`/`block`：PreToolUse；`remind`：PostToolUse | 按条目，**不受 mode 约束** | **必配** `redlines.paths` |
| 7 | 事中 | 红线命令 | `ask`/`block`：PreToolUse(Bash)；`remind`：PostToolUse(Bash) | 同上 | 可选（内置常见危险命令） |
| 8 | 事中 | 范围越界 | remind：PostToolUse；enforce：PreToolUse `ask` | 软判 / 强判 | 无（范围来自契约）；可选 `task.scope` |
| 9 | 事中 | 新建前没查 atlas | remind：PostToolUse；enforce：PreToolUse `deny` | 软判 / 强判 | 可选 `reuse.beforeNew`；依赖 atlas |
| 10 | 事中 | 改公共层前没查 impact | PreToolUse（写工具） | **强判** | **确认** `publicLayer` |
| 11 | 事中 | 复杂度增量 | PostToolUse（写工具） | 软判 | 可选 `budget.*` |
| 12 | 事中 | shell 旁路写入 | PostToolUse(Bash) | 软判 | 无 |
| 13 | 事中 | 循环门 | PostToolUse / PostToolUseFailure | 软判 | 无 |
| 14 | 事中 | 记录范围外问题 | MCP `guard_note` | 提示 | 无 |
| 15 | 事后 | 回执：越界、扩范围 | Stop | 人判 + 强判（要求说明） | 无 |
| 16 | 事后 | 回执：体量 | Stop | 同上 | 可选 `budget.addedLines` / `newFiles` |
| 17 | 事后 | 回执：复杂度 | Stop | 同上 | 同 #11 |
| 18 | 事后 | 回执：疑似重复 | Stop（`atlas review`） | 同上 | 依赖 atlas |
| 19 | 事后 | 回执：噪声 | Stop | 同上 | 无 |
| 20 | 事后 | 回执：验证证据 | Stop | 同上；`enforce` 时要求先跑通 | **确认** `verify.commands`；可选 `verify.onStop` |
| 21 | 事后 | 回执：顺手发现 | Stop | 人判 | 无 |
| 22 | 入库 | `check --staged` | 工程 pre-commit（init 可选加入） | 强判（非零退出） | init 第 ④ 步选择 |
| 23 | 入库 | `check --base` | 工程 CI（init 可选加入） | 强判（非零退出） | init 第 ④ 步选择 |
| 24 | 入库 | 本机 git hook | `.git/hooks/pre-commit`，不进 git | 强判 | init 第 ④ 步选择 |
| 25 | 二期 | 精简审查 `/repo-guard:review` | 子代理，手动触发 | 人判（列出可删的行） | 无 |

开发者实际需要过目的只有三项：`verify.commands`、`publicLayer`（都在 init 里确认推测值）、`redlines.paths`（想要红线时）。

## 7. init：接入与告知

init 是开发者第一次接触 repo-guard 的地方：每个控制点会做什么、默认怎么处理、要不要动工程文件，在这里讲清楚并让人选择。

### 7.1 流程

~~~
$ repo-guard init

① 环境检查
  ✓ git 仓库          ✓ code-atlas 已安装，本仓已登记到图谱
  ! 发现旧配置 repo-facts.json、redlines.json，会迁移进新配置

② 识别结果（推测值，下一步请你确认）
  技术栈     React + TS（tea 构建）
  验收命令   npm run lint、npm run test        ← 来自 package.json 的 scripts
  公共层     src/components/、src/utils/       ← 依据：被引用次数最多的目录
  建议红线   src/i18n/**（多语言文案）、**/*.generated.ts
  已有门禁   husky (pre-commit → lint-staged)、.orange-ci.yml

③ 会话中会启用的控制（说明 + 选择）
  控制点         做什么                          默认处理
  开发基线       会话开始注入 6 行最简实现约定   注入
  任务契约       写第 2 个文件前要求声明范围     拦一次
  范围越界       写到范围外时提醒并记进回执      提醒
  复用检查       新建前要求先查 atlas            提醒
  公共层影响面   改公共层前必须查 impact         拦截
  复杂度 / 体量  只量本次新增的代码              提醒
  红线           按每条规则自己的动作执行        按规则
  改动回执       结束时列出改了什么、验没验证    展示
  ? 总档位       › remind（推荐：先提醒、收集误伤数据） / enforce / off
  ? 任务契约     › auto（推荐） / required / off
  ? 验收命令     › [x] npm run lint  [x] npm run test  [ ] 自己填
  ? 公共层       › [x] src/components/  [x] src/utils/  [ ] 自己填
  ? 红线         › [x] src/i18n/** → ask  [ ] **/*.generated.ts → block  [ ] 跳过

④ 合并门（会修改工程文件，默认不加）
  repo-guard check 会在提交或合并时，用和会话回执同一套规则检查本次 diff。
  ? 加到哪里
    [ ] .husky/pre-commit，在 lint-staged 后加一行（会进 git，团队所有人生效）
    [ ] .orange-ci.yml，新增一个检查步骤（会进 git，影响流水线）
    [ ] 只装本机 git hook（不进 git，只对你自己生效）
    [x] 先不加，以后可以运行 repo-guard init --merge-gate

⑤ 即将写入
  新建  .codebuddy/repo-guard.json
  修改  .gitignore（追加 1 行缓存目录）
  修改  .husky/pre-commit（+1 行）       ← 仅当 ④ 勾选
  迁移后可删  .codebuddy/repo-facts.json、.codebuddy/redlines.json
  ? 确认写入 › Y / n / d（d 先看 diff）

✓ 完成。下一步：
  1. 重开 CodeBuddy 会话后生效
  2. 把 .codebuddy/repo-guard.json 提交进 git，团队共享同一份配置
  3. repo-guard status 查看当前生效的控制；repo-guard governance 查看误伤数据
~~~

检测不到 pre-commit 和 CI 的仓（如只有 Makefile 的后端仓），第 ④ 步只给两个选项：

~~~
  未检测到 pre-commit 或 CI 配置。
  ? [ ] 只装本机 git hook（不进 git）  [x] 先不加
  如果你们的 CI 在蓝盾页面上配置，可以加这一步：repo-guard check --base $TARGET_BRANCH
~~~

### 7.2 规则

1. **动工程共享文件一律默认不勾**：pre-commit 配置进 git 会影响整个团队，只在人明确勾选后修改，写入前可看配置内容。**CI 配置文件格式各异（阶段、镜像、触发条件），不自动改，只打印可复制的步骤**；蓝盾等网页上配置的 CI 同样只打印片段。**不替工程新建 CI 配置。**
2. **在已有 hook 后追加一行，不另起一套**：
   | 检测到 | 写入位置 |
   |---|---|
   | `.husky/pre-commit` | 文件末尾追加 `repo-guard check --staged` |
   | `lefthook.yml` | `pre-commit.commands` 下新增一项 |
   | `.pre-commit-config.yaml` | 新增一个 `local` hook |
   | CI 配置文件（如 `.orange-ci.yml`、`.code.yml`、`.gitlab-ci.yml`、GitHub Actions、Jenkinsfile） | 不自动改，打印步骤 `repo-guard check --base origin/$TARGET_BRANCH` |
   | 都没有 | 只提供"本机 git hook"（写 `.git/hooks/pre-commit`，已有非 sample 文件时追加不覆盖） |
   已存在 repo-guard 的那一行时跳过，重复运行不会加两遍。
3. **两条入口，同一套说明和选项**：
   - 人在终端：`repo-guard init` 逐项交互。
   - AI 在会话 / IDE：`/repo-guard:init` 斜杠命令，模型先调 `repo-guard init --plan --json` 拿识别结果和选项，用提问控件逐项问人，最后调 `repo-guard init --apply <选择>` 写入。
4. **非交互环境不弹提问**：`init --yes` 全部用推荐值，但不碰 pre-commit / CI；要加合并门必须显式 `--merge-gate husky|lefthook|pre-commit|ci|local`。
5. **已存在的 `repo-guard.json` 不覆盖**：再次运行 init 进入"补充"模式，只问缺失项和合并门。

### 7.3 init 之后的持续告知

- `repo-guard status`：列出当前生效的控制点、各自档位、值来自全局层还是项目层、合并门挂在哪里、atlas 是否可用。
- init 后的第一个会话：SessionStart 用 `systemMessage` 给开发者看一行"repo-guard 已启用：契约 auto、红线 1 条、合并门 husky；repo-guard status 查看详情"，之后不再显示。
- 配置文件每个字段附 `_` 开头的注释键，说明用途与可选值。

## 8. 配置

两层，各一个文件，结构相同：

- 全局层：插件内 `config/repo-guard.json`（部门改这里定制模板）
- 项目层：仓库内 `.codebuddy/repo-guard.json`（进 git，由 init 生成）

合并规则：项目层写了的字段（含数组，如 `redlines.commands`）整体覆盖全局层，没写的才继承。**init 把全部可调字段连同当前值和说明写进项目层**，开发者在一个文件里看全、就地改（删掉某条默认命令红线即不再生效）；内置开发基线只读，以 `baseline._builtin` 说明列出。全局层因此是 init 的模板和缺字段时的默认值：部门改默认值只影响之后新接入的仓和项目层缺的字段，`repo-guard status` 会列出本仓与部门默认不同的项。

~~~jsonc
{
  "mode": "remind",
  "task":        { "contract": "auto", "scope": "remind" },
  "budget":      { "addedLines": 300, "newFiles": 5, "funcLines": 60, "nesting": 4, "params": 5 },
  "reuse":       { "beforeNew": "remind" },
  "publicLayer": ["src/components/", "src/utils/"],
  "verify":      { "commands": ["npm run lint", "npm run test"], "onStop": "remind" },
  "redlines": {
    "paths":    [{ "glob": "src/i18n/**", "action": "ask", "reason": "多语言文案由专人维护" }],
    "commands": [{ "pattern": "git push --force*", "action": "block", "reason": "会覆盖他人提交" }]
  },
  "baseline": { "extra": ["本仓禁止新增 util 包"] }
}
~~~

| 属性 | 含义 | 默认 |
|---|---|---|
| `mode` | 启发式检查（范围、复用、复杂度、体量、验证）的总档位上限。不约束红线、契约缺失拦截、公共层影响面（见 3.3） | `remind` |
| `task.contract` | 写代码前是否要声明契约。`off` / `auto`（写第 2 个文件时要求）/ `required`（第一次写就要求） | `auto` |
| `task.scope` | 写到契约范围外时：`remind` 写后提醒并进回执；`enforce` 写前弹窗让人确认 | `remind` |
| `budget.addedLines` | 本次任务相对基线的净新增行数上限，超出在回执提示、建议精简审查 | 300 |
| `budget.newFiles` | 本次新建文件数上限（抓"拆得过碎"），测试文件不计 | 5 |
| `budget.funcLines` | 本次新增或变长的函数的行数上限，历史函数不管 | 60 |
| `budget.nesting` | 本次改到的函数的最大嵌套层数 | 4 |
| `budget.params` | 本次新增函数的参数个数上限 | 5 |
| `reuse.beforeNew` | 新建文件 / 函数时本轮未查 atlas hot / similar：`remind` 写后提醒；`enforce` 写前拒绝，查过才放行 | `remind` |
| `publicLayer` | 公共层目录。改其中已有文件前必须查 atlas impact，否则拒绝；为空则不检查。init 推测、人确认 | init 推测值 |
| `verify.commands` | 验收命令，init 推测后人确认；契约未写验收命令时用这里的 | init 推测值 |
| `verify.onStop` | 结束时最后一次写入后没跑过或没跑通验收命令：`remind` 让 AI 如实说明；`enforce` 让它先跑通再结束（每会话最多一次） | `remind` |
| `redlines.paths` | 受保护路径，每条 `glob` / `action`（`remind`/`ask`/`block`）/ `reason`。不受 `mode` 约束 | `[]` |
| `redlines.commands` | 受保护命令（如 `git push --force*`、`rm -rf*`），字段同上 | 几条常见危险命令 |
| `redlines.fields` | 字段红线：`protects`（字段名 / 函数名 / 错误码）在 `paths` 内的文件里出现次数不许变少（删除或改名）；`action` 缺省 `block`。init 从旧 `redlines.json` 迁移；`repo-guard audit` 体检字段是否还存在、有没有出现在 `paths` 外 | `[]` |
| `redlines.content` | 内容红线：新增的行里不许出现匹配 `pattern`（JS 正则）的内容，文件原有内容不算；`action` 缺省 `block` | 5 条硬编码凭据（腾讯云 SecretId、AWS AccessKey、私钥、平台令牌、通用 secret/password 赋值） |
| `baseline.extra` | 追加在内置开发基线后的本仓约定，每行一条，建议不超过 5 行 | `[]` |

合并门挂在哪里不写进配置——它体现为工程文件里的一行，`repo-guard status` 通过检测这些文件报告。`repo-guard doctor` 负责报告 JSON 错误、未知字段、取值越界。

## 9. 开发者体验

~~~
你：给智能体列表加一个"按创建时间筛选"

AI 调用 guard_task（终端可见）：
  目标  列表接口支持 created_at 时间范围筛选，前端加日期选择器
  不做  不改分页逻辑，不动其他筛选项，不重构 service 层
  范围  internal/logic/agent/**, router/agent.go, src/pages/agent/list/**
  验收  go test ./internal/logic/agent/...

AI 开始写代码……
~~~

- 契约写错了：直接打断说"范围还要加 repo 层"，AI 更新契约。
- AI 写了范围外文件：写后收到提醒，要么撤回，要么调 `guard_task` 扩范围并写理由（终端可见），并进回执。
- AI 发现别的问题：调 `guard_note` 记下，不改。
- 结束时：终端出现回执；模型在最终回复里逐条说明保留理由或已撤回。

开发者多出来的成本是开头看一眼契约。钩子只能强制"契约存在"和"写入路径在范围内"，契约本身写得好不好取决于模型，所以这一眼是必要的。

## 10. 安装与使用

一次性安装（每台机器）：

~~~bash
npm i -g @tencent/code-atlas                         # 图谱依赖
/plugin marketplace add <部门插件市场的 git 地址>     # 在 CodeBuddy 里执行
/plugin install repo-guard@<市场名>
~~~

每个仓接入一次：终端运行 `repo-guard init`，或在会话里用 `/repo-guard:init`，按第 7 节逐项确认；完成后把 `.codebuddy/repo-guard.json`（以及第 ④ 步改动的工程文件）提交进 git。旧配置（`repo-facts.json`、`redlines.json`、`guard/`）由 init 一次性迁移，迁移后运行时只读 `repo-guard.json`，`doctor` 提示旧文件可删。

日常：

- 重开一次会话后照常提需求，契约、提醒、回执都是自动的。
- `repo-guard status`：当前生效的控制。
- `repo-guard receipt`：当前任务回执。
- `repo-guard governance`：各项提醒 / 拦截的误伤数据，决定是否把 `mode` 调成 `enforce`。
- `repo-guard init --merge-gate`：以后再决定加合并门。
- `/repo-guard:review`：觉得改多了时手动触发精简审查（二期）。

## 11. 钩子与工具映射

| 挂点 / 入口 | 做什么 |
|---|---|
| SessionStart | 注入开发基线 + `baseline.extra`；有未结束的契约时注入契约；init 后首个会话 `systemMessage` 告知已启用的控制 |
| UserPromptSubmit | 注入一行契约摘要；埋点。不阻塞 |
| PreToolUse（写工具） | 只输出 deny / ask 或不输出：契约缺失、红线 `ask`/`block`、公共层影响面、enforce 档的范围与复用 |
| PreToolUse（Bash） | 红线命令 `ask`/`block` |
| PostToolUse（写工具） | remind 档提醒：范围越界、复用、复杂度增量、红线 `remind`、循环门；记录写入时间与文件 |
| PostToolUse（Bash） | 记录命令与退出码（验证证据）；识别 atlas 命令；shell 旁路写入提醒；红线命令 `remind` |
| PostToolUseFailure | 循环门失败计数 |
| PostToolUse（atlas MCP） | 记录 impact / hot / similar 查询回执 |
| Stop | 生成回执：`systemMessage` 给人；`continue: false` + `reason` 续跑一次给模型 |
| PostCompact / SubagentStart | 重注入基线与契约全量 |
| MCP `guard_task` / `guard_note` | 声明 / 更新契约；记录顺手发现 |
| CLI `init`（`--plan` / `--apply` / `--yes` / `--merge-gate`） | 接入与告知（第 7 节） |
| CLI `status` / `receipt` / `check` / `doctor` / `governance` | 生效清单；回执；合并门；配置体检；误伤数据 |
| 斜杠命令 `/repo-guard:init` | AI 引导接入，用提问控件逐项确认 |

## 12. 对现有代码的取舍

- **保留并复用**：atlas 集成（`src/atlas/`）、会话状态（`src/runtime/session-state.ts`）、写前守卫（`src/runtime/guard.ts`）、红线运行时、metrics / governance、MCP server、graph-enforce / admission（归入公共层影响面与复用）、循环门（改为写后提醒）、`init` 的仓库识别逻辑（`src/cli/init.ts`、`facts-from-repo.ts`）。
- **合并进 `repo-guard.json`**：`layers/process-gates/` 下 9 份 JSON、`guard.json`、`redlines.json`、`task-routes.json`、`repo-facts.json`（`publicLayer` 等）。相关回归用例（如 `build/verify-facts-init.mjs`）随之更新。
- **去掉**：`emitAllowWithNote` 这类 PreToolUse `allow` + 说明的输出（会绕过用户权限确认）。
- **放到二期**：standards 规范引擎（`src/standards/` 与 56 条条目）、七层分类、human-review / merge-gates 两个独立层、`hooks.json` 中的空占位。Beta 里规范库改为按任务加载的 markdown skill；能机器检查的条目收编进红线或体量预算。

## 13. 分期

| 期 | 内容 |
|---|---|
| Beta | 开发基线、任务契约与范围、写时控制（第 6 节 #1–#14）、改动回执与降级行为、单一配置、init 引导（含旧配置迁移、合并门可选加入）、`status` / `receipt` / `check --staged / --base`、`/repo-guard:init` |
| 二期 | 精简审查子代理 `/repo-guard:review`、符号级红线（受保护函数不许删）、enforce 档全面可用 |
| 三期 | 规范库重新接入、治理数据驱动阈值调整 |

## 14. 已确认决策

| 决策 | 结论 | 理由 |
|---|---|---|
| 契约默认 | `auto`：写第 2 个文件时要求 | 小改动不打扰，多文件任务必须有边界 |
| 契约缺失拦截 | 默认档下也拒绝一次，作为 `mode` 的例外 | 代价只是补一次 `guard_task` |
| 越界默认 | `remind`（写后提醒）+ 进回执 | 让越界被看见，不打断开发 |
| remind 档的实现 | 一律写后提醒（PostToolUse），写前只 deny / ask | PreToolUse 无"只提醒"输出，`allow` 会绕过权限确认 |
| 红线与 `mode` | 红线按条目 `action` 执行，不受 `mode` 约束 | 红线是人明确写下的意图，配了就该生效 |
| 公共层 | 新增 `publicLayer` 字段，init 推测、人确认 | 迁移 `repo-facts.json` 的公共层，影响面拦截继续可用 |
| 降级 | 非 git / 无 atlas / 无验收命令时跳过对应项，回执注明 | 缺依赖不应让插件报错或拦人 |
| 循环门 | 连续失败时写后提醒，不拦，不暴露配置 | 内部保护，避免空转 |
| 规范引擎 | 放二期 | Beta 少一大块配置，先跑通流程 |
| 回执展示 | `systemMessage` 给人 + `continue: false` 续跑一次给模型 | 人能直接看到；模型只说明一次，不无限续跑 |
| 合并门 | 提到 Beta；init 第 ④ 步可选加入工程 pre-commit / CI / 本机 hook，默认不加 | 合并门是告知与选择的一部分；共享文件由人决定 |
| 不建 CI | 只在已有配置里追加一步，或打印片段 | CI 是共享基础设施 |
| init 入口 | 终端交互 + `/repo-guard:init`（`--plan` / `--apply`），非交互 `--yes` 不碰共享文件 | 人和 AI 两条入口，同一套说明 |
| 自动清理 | 不做 | 历史债与用户改动不算 AI 的；删不删由人决定 |

## 15. 实现说明（Beta，2026-11-12）

与上文方案的差异和补充细节，以代码为准：

| 项 | 实现 | 理由 |
|---|---|---|
| 启用条件 | 项目层 `.codebuddy/repo-guard.json` 存在才启用 v2；全局层只给项目层没写的字段提供默认值 | init 是告知环节，没跑过 init 的仓不应突然被契约拦；装了插件但没接入的仓零行为变化 |
| 基线 | 写前快照（见 4.1），不用 `git stash create` | 只算 AI 经写工具改过的文件，最准确；非 git 仓也能用 |
| 斜杠命令 | `/repo-guard:init`（插件命令强制带命名空间），精简审查二期为 `/repo-guard:review` | 宿主规则 |
| CI | 不自动改 CI 文件，只打印步骤；可自动追加的是 husky / lefthook / pre-commit / 本机 git hook | CI 格式各异，自动改容易改坏流水线 |
| 共享 hook 写法 | `if command -v repo-guard >/dev/null 2>&1; then repo-guard check --staged; fi`；本机 hook 写当前 CLI 的绝对路径 | 进 git 的文件不能写某个人机器上的路径；PATH 上没有就跳过、不挡提交 |
| `check` 退出码 | 红线 `block` 始终非零；体量、复杂度、查重、噪声只在 `mode: enforce` 时非零，remind 档只报告 | 与总档位语义一致 |
| 回执频率 | 只在上次回执之后有新写入时出回执；续跑每会话最多 3 次 | 防止撤回改动后反复续跑 |
| 复用提醒 | 只在本仓已登记到 atlas 时提醒（未登记时查也查不到） | 避免无效提醒 |
| 旧配置 | `repo-facts.json` 的公共层、`redlines.json` 的字段红线（`protects`）与内容规则（`contentMatchers`）迁入新配置（示例条目和已关闭的不迁，统一为 `block`）；接入 v2 的仓不再读 `.codebuddy/guard/` | 旧版字段红线要打开 `guard/` 的 `admission` 才硬拦，v2 不读 `guard/` 后在接入仓里拦不住，所以并入 `repo-guard.json` 且不受总档位约束（2026-11-12 用户确认） |
| 字段 / 内容红线判定 | 写前按这次写入算出改后内容判定（block 拒绝 / ask 弹窗）；算不出时（参数形状不认识）写后对比写前快照兜底提醒撤回；合并门 `check` 同样判定。通用凭据正则要求值同时含字母和数字、排除明显占位，在 4 个真实仓存量代码上只命中 1 处测试里的仿真密钥 | 误拦低、覆盖常见泄露 |
| shell 写公共层提醒 | 从写前（`allow` + 说明）挪到执行后（PostToolUse），对所有仓生效 | `allow` 会绕过用户对命令的权限确认 |
| 项目配置内容 | init 写全部可调字段（含默认命令红线），项目层整体覆盖全局层；已有配置再跑 init 只补缺的字段、保留已有值；`status` 列出与部门默认不同的项 | 开发者要能在一个文件里看到并改所有控制；代价是部门默认值不再自动下发到已接入的仓（2026-11-12 用户确认） |
| 经命令改动的文件 | 会话开始记 git 基线（`git stash create`，干净时为 HEAD，加当时的未跟踪文件）；每条命令执行后与结束时对比工作区，基线后变化且没经编辑工具的文件补快照、跑写后检查并进回执 | 实测中模型用 `python3 - <<EOF` 改文件，绕开了编辑工具和写前写后钩子 |
| 插件内 MCP 工具名 | 钩子 matcher 与提示文案同时覆盖 `mcp__plugin_repo_guard_<服务>__*` 与 `mcp__<服务>__*`；另挂 `DeferExecuteTool`，从入参取真实工具名，拿不到结构化回执时只读缓存再查一次 | 宿主把插件名、服务名的连字符转成下划线且 matcher 不做等价；MCP 工具默认延迟加载、经代理调用 |
| 复杂度提醒口径 | 新函数超阈值、或已有函数被这次改动推过阈值才提醒；改动前已超阈值的函数再变长不提醒 | 实测中前端页面组件本来就 150 行以上，每次加功能都被提醒，属于历史债 |
| 函数度量 | 零依赖启发式：Go / TS / JS / Java 等花括号语言与 Python；认不出的语言跳过 | 宁可漏报不要误报 |

验证：`npm run check`（含 `bin/verify-control.mjs` 70 条 v2 用例、`bin/verify-hooks.mjs` 100 条既有用例）。