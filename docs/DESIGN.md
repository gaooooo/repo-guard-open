# repo-guard 设计与开发文档

> 把 deerclaw 平台的「协作全景」质量过程控制，搬成一个**零服务端**的 CodeBuddy 插件。
>
> 版本 0.2.0 · 对应源码版改造（P0–P2 已完成，P3–P5 规划中）

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [CodeBuddy 插件的全部控制点](#2-codebuddy-插件的全部控制点)
3. [deerclaw 协作全景如何落到这些控制点](#3-deerclaw-协作全景如何落到这些控制点)
4. [架构与目录](#4-架构与目录)
5. [数据契约](#5-数据契约)
6. [构建与验证](#6-构建与验证)
7. [独立性论证](#7-独立性论证)
8. [与 deerclaw agent 的能力对比](#8-与-deerclaw-agent-的能力对比)
9. [风险、非目标与决策记录](#9-风险非目标与决策记录)

---

## 1. 背景与目标

### 1.1 deerclaw 那边是什么

deerclaw 是一个服务端多 agent 平台。它对「AI 写代码」这件事的质量控制，在 web-admin 里被画成一张图叫**协作全景**（`web-admin/src/pages/teams/TeamOverviewPanorama.tsx`）：一次任务从进群、路由、拆解、委派、专家干活、汇报走完，途中穿过 L0–L6 七道门。

配置面分四层：

| 层 | 语义 | 配置项 |
|---|---|---|
| 身份 | 团队是谁 | 团队章程（soul）、编制 |
| 能力 | **授予**，加一项 agent 更能干 | 代码库、项目知识、公共知识订阅、专家装备（skill / MCP） |
| 约束 | **收回**，加一项 agent 更受限 | 团队禁忌、仓库红线、开发前必读、范围与预算、循环防护、交付校验 |
| 流程 | 活怎么进来、经理怎么编排 | Manager Playbook、需求复述、群绑定 |

每个控制项还标了两个维度：**来源**（身份/能力/约束/流程）与**生效方式**（推 / 按任务 / 拉 / 硬 / 软）。

- **推** —— 平台在 agent 开始干活时主动塞进 system prompt
- **按任务** —— 先判定任务类型，再塞对应那一份
- **拉** —— 不预装正文，模型判断缺了才调工具取
- **硬** —— 代码会真拦，不听话也过不去
- **软** —— 只写进 prompt 当提醒，代码不强制

### 1.2 这边要什么

同样的质量控制，但：

- **不要服务端**。不连任何服务、不需要令牌、内网可用。
- **不要多 agent**。CodeBuddy 里只有一个人（屏幕前的你）和一个 agent，没有团队成员、没有委派。
- **图谱现算**。从本仓代码算，缓存本地，不进 git。
- **规则读仓库文件**。红线是人写的意图，跟代码走同一个 PR。

### 1.3 为什么值得做

deerclaw 的核心判断是：**AI 写代码的质量问题，绝大多数不是「模型不够聪明」，而是「它不知道这一改会波及什么」。** 影响面、红线意图、仓内既有写法，这三类信息静态分析能算、模型算不出来，而平台注入它们的成本远低于事后返工。

这个判断不依赖服务端。所以搬得动。

---

## 2. CodeBuddy 插件的全部控制点

这一节是完整清单。后面的映射表全部从这里挑。

### 2.1 Hooks —— 唯一能「拦停 / 改写」的机制

插件的 hooks 写在 `hooks/hooks.json`，或 `plugin.json` 的 `hooks` 字段（支持内联与自定义路径）。

> **关键安全事实**：插件 `hooks/hooks.json` 里的 hooks **不受 `allowUntrustedFrontmatterHooks` 闸门约束**，启用插件即生效。而 Skill / Agent 的 frontmatter `hooks` 默认被拒，要用户显式在 `settings.json` 里开。所以插件要分发 hook，就该走 `hooks/hooks.json`。

不同作用域（用户 / 项目 / 项目本地 / 企业策略 / 插件）的 hooks 是**合并**而非覆盖，同一事件的所有匹配 hooks 并行执行。

#### 事件全集

| 事件 | 触发时机 | matcher | 能不能改变执行流 |
|---|---|---|---|
| `SessionStart` | 会话创建或恢复 | `startup`/`resume`/`clear`/`compact` | 注入 `additionalContext`；stdout 直接进上下文 |
| `UserPromptSubmit` | 用户提交、AI 处理之前 | — | `continue:false` 拦掉提问；`additionalContext` 注入 |
| `PreToolUse` | 工具参数已建、执行之前 | 工具名正则 | **`permissionDecision: allow/deny/ask`** + **`modifiedInput`**（改写入参） |
| `PermissionRequest` | 权限对话框出现时 | — | 观测 |
| `PermissionDenied` | 被 auto 模式分类器拒绝 | — | 返回 `{retry:true}` 告知模型可重试 |
| `PostToolUse` | 工具成功之后 | 工具名正则 | `additionalContext`（追加）/ **`updatedToolOutput`**（整体替换结果） |
| `PostToolUseFailure` | 工具失败之后 | 工具名正则 | 同上 |
| `Notification` | 权限请求 / 60 秒空闲提醒 | `permission_prompt`/`idle_prompt`/`auth_success` | 观测（桌面提醒、IM 通知） |
| `SubagentStart` / `SubagentStop` | 子代理起 / 止 | — | `SubagentStop` 可 `continue:false` 让子代理继续 |
| `TaskCreated` / `TaskCompleted` | 任务表变更 | — | 观测 |
| `Stop` | 主 agent 响应结束（用户中断不触发） | — | **`continue:false` + `reason` → 阻止停止、驱动继续迭代**（reason 以 `isMeta` user message 注入 history） |
| `StopFailure` | 轮次因 API 错误结束 | — | 观测（输出与退出码被忽略） |
| `TeammateIdle` | 团队成员即将空闲 | — | 观测 |
| `InstructionsLoaded` | CODEBUDDY.md / `.codebuddy/rules/*.md` 进上下文 | — | 观测 |
| `ConfigChange` | 会话期间配置变更 | — | 观测 |
| `CwdChanged` | 工作目录变更（AI 执行 `cd`） | — | 观测 |
| `FileChanged` | 被监视文件在磁盘变更 | **文件名** | 观测 |
| `WorktreeCreate` / `WorktreeRemove` | 工作树建 / 删 | — | 环境准备与清理 |
| `PreCompact` | 上下文压缩之前 | `manual`/`auto` | 退出码 2 可**阻止压缩** |
| `PostCompact` | 压缩完成之后 | — | 仅观测，不能改压缩结果 |
| `Elicitation` / `ElicitationResult` | MCP 请求用户输入 前/后 | — | 观测 / 改写 |
| `SessionEnd` | 会话终止 | `clear`/`logout`/`prompt_input_exit`/`other` | 清理、持久化 |

#### Hook 的四种 type

| type | 机制 | 可用事件 | 适合什么 |
|---|---|---|---|
| `command` | shell 命令，stdin 收 JSON、stdout 出 JSON | 全部 | 确定性规则。快，本地执行 |
| `prompt` | 小模型（`lite` 槽位）语义判定，返回 `{ok, reason, impossible}` | 仅 `Stop` / `UserPromptSubmit` / `PreToolUse` | 上下文感知决策。支持 `continueOnBlock` 驱动多轮收敛 |
| `agent` | 起一个带工具的 subagent 做验证 | 全部 | 复杂验证（如 AI 代码审查） |
| `http` | 事件 JSON POST 到 URL | 全部 | 外部系统对接 |

公共字段：`matcher`、`timeout`（默认 60s，按命令配）、`once`。

#### Hook 输出的控制字段

```jsonc
// 所有事件通用
{
  "continue": false,          // 是否继续
  "stopReason": "...",        // continue:false 时给 Agent 看的原因（别名 reason）
  "suppressOutput": true,     // 在 transcript 里隐藏 stdout
  "systemMessage": "..."      // 只给用户看的警告，不传给 Agent
}

// PreToolUse
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "...",
    "modifiedInput": { "字段": "新值" }      // 执行前改写工具入参
}}

// PostToolUse
{ "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "...",              // 追加，结果只会变长
    "updatedToolOutput": "..."               // 替换，结果可以变短（省 token）
}}
```

退出码语义：`0` 正常（`UserPromptSubmit` / `SessionStart` 的 stdout 进上下文）；`2` 阻塞错误（消息优先取 stdout，stderr 仅作 fallback —— 所以调试日志写 stderr 是安全的）；其他非零非阻塞。

### 2.2 上下文与指令注入

| 手段 | 位置 | 生效方式 |
|---|---|---|
| Skills | `skills/<名>/SKILL.md` | 模型自主调用，渐进式披露（**拉**） |
| Slash commands | `commands/*.md` | 用户 `/plugin:cmd` 手动触发 |
| Output styles | `output-styles/`（`outputStyles`） | 改输出风格与系统提示 |
| `SessionStart` hook 的 `additionalContext` | hooks | **推**。插件注入「规则」的唯一正路 |
| `UserPromptSubmit` hook 的 `additionalContext` | hooks | **按任务**。先判任务类型再注入 |

> **插件不能分发 `.codebuddy/rules/`**。`plugin.json` 没有 `rules` 字段，规则只在用户级（`~/.codebuddy/rules/`）与项目级（`./.codebuddy/rules/`，仅 cwd 不向上）加载。插件想下发常驻规则，只能走 `SessionStart` 注入，或者由 `init --write` 生成规则文件让用户自己提交。

### 2.3 Agent / Skill / Command 的行为约束

**`agents/*.md` frontmatter**：`model`、`effort`（minimal→max）、`maxTurns`、`tools`（白名单）、`disallowedTools`、`skills`、`memory`（user/project/local）、`background`、`isolation: worktree`。

> 插件 agent **明确不支持** `hooks`、`mcpServers`、`permissionMode` —— 出于安全原因。

**`skills/*/SKILL.md` frontmatter**：`allowed-tools`（支持 `Bash(git:*)` / `Edit(src/**/*.ts)` 细粒度）、`context: fork`、`agent`、`model`、`disable-model-invocation`、`user-invocable`、`hooks`（**仅 fork 且需用户开 `allowUntrustedFrontmatterHooks`**）。

**`commands/*.md` frontmatter**：`allowed-tools`、`model`、`argument-hint`、`disable-model-invocation`。

### 2.4 把主线程整体换掉

插件根 `settings.json`（当前只认 `agent` 一个键）：

```json
{ "agent": "security-reviewer" }
```

把插件自带的 agent 提为主线程，接管 system prompt + 工具限制 + 模型。这是插件改变默认行为最重的开关。优先级：`product.json default` → **plugin agent** → `settings.json agent` → CLI `--agent`。

### 2.5 工具面与环境

| 手段 | 作用 |
|---|---|
| `.mcp.json` / `mcpServers` | 增删工具面 |
| `.lsp.json` / `lspServers` | 每次编辑后把诊断回灌给模型 |
| `bin/` | 目录进 Bash 的 `PATH`，裸命令可直接调 |
| `channels` | 向对话注入外部消息（绑定插件的某个 MCP server） |
| `userConfig` | 启用时提示用户填值 → `${user_config.KEY}` + `CODEBUDDY_PLUGIN_OPTION_*` 环境变量；敏感值进系统钥匙串 |
| 路径变量 | `${CODEBUDDY_PLUGIN_ROOT}`（更新会变）/ `${CODEBUDDY_PLUGIN_DATA}`（跨更新保留）/ `${CODEBUDDY_PROJECT_DIR}` |
| 生命周期 | `defaultEnabled`、`dependencies`（semver + 跨 marketplace 授权）、安装 scope（user/project/local/managed） |

### 2.6 宿主自带的权限层（插件改不了，但要知道它在）

这层归宿主，插件不能配，但它决定了「L2 执行门」在 CodeBuddy 里已经有人管：

- `permissions.allow` / `ask` / `deny` 规则（支持 `Bash(git push:*)`、`Read(./.env)`、`Edit(src/**)`、`WebFetch(domain:*)`、MCP 工具、Agent、Skill）
- `permissions.defaultMode`：`default` / `acceptEdits` / `auto` / `dontAsk` / `plan` / `bypassPermissions`
- `permissions.additionalDirectories`、`disableBypassPermissionsMode`、`disableAutoMode`、`subagentPermissionMode`
- `sandbox`：`enabled` / `autoAllowBashIfSandboxed` / `excludedCommands` / `allowUnsandboxedCommands`
- `autoMode` 分类器：`environment` / `allow` / `soft_deny` / `hard_deny`（自然语言规则）
- 受保护文件路径、信任目录
- 全局闸门：`disableAllHooks`、`allowUntrustedFrontmatterHooks`

---

## 3. deerclaw 协作全景如何落到这些控制点

### 3.1 先说清楚两边的结构性差异

| | deerclaw | CodeBuddy 插件 |
|---|---|---|
| 谁拥有 ReAct 循环 | 平台自己 | **宿主**，插件只能在事件边界插话 |
| 有几个 agent | Manager + 多专家，可委派 | 一个主 agent（+ 宿主自己的 subagent） |
| prompt 怎么拼 | 平台 `prompt-builder.ts` 全权组装 | 插件只能**追加** `additionalContext` |
| 谁在屏幕前 | 群里的人，异步 | 用户，同步 |
| 红线从哪来 | 数据库，保存即生效 | 仓库文件，跟 commit 走 |

由此产生三条设计底线：

1. **L0 只能追加不能重排**。deerclaw 的注入顺序（约束优先级 → 红线 → 仓库约定 → 章程 → 岗位 → 知识 → 记忆 → 技能索引 → 工具清单）在插件里做不到，插件的内容一定在宿主 system prompt 之后。
2. **L3 / L4 大部分只能观测**。插件拿不到 iteration 序号，也没有 `finalReason` 语义。
3. **委派、汇报 cadence、Manager Playbook 直接不搬**。CodeBuddy 里没有团队成员，`delegate_to_member` 的语义无处落地 —— 这也是 deerclaw 自己的 `allowlist.json` 里明确排除的东西（「团队章程带协作/委派语义，Claude Code 里没有团队成员」）。

### 3.2 逐道门的映射

#### L0 注入面

deerclaw：`src/context/prompt-builder.ts:260-450`，11 个段落依次注入，每段 1500 token 上限，超限**按行截断并显式标注**「已截断，完整清单见平台」（不静默截断）。

| 全景控制项 | deerclaw 生效方式 | CodeBuddy 落点 | 强度 |
|---|---|---|---|
| 团队章程 soul | 推 | 不搬（带协作/委派语义） | — |
| 岗位交底 | 推 | `agents/*.md` + 插件 `settings.json` 的 `agent` 键（可选） | 替换主线程 |
| 项目知识（≤1500 token） | 推 | `SessionStart` hook → `additionalContext` | 注入 |
| 团队禁忌 | 推 | `SessionStart` hook → `additionalContext` | 注入 |
| 仓库红线摘要 | 推 | `SessionStart` hook → `additionalContext` | 注入 |
| 仓库项目约定 | 推 | 同上（`repo-facts.json` 的公共层清单 + lineLimit，**已实现**） | 注入 |
| 开发前必读（task_routes） | **按任务** | `UserPromptSubmit` hook → 匹配任务类型 → `additionalContext` | 注入 |
| 公共知识 | 拉 | 不搬（无平台知识库）；对应能力是 `similar` / `lib search`，仍是「拉」 | — |
| 压缩后重注入 | 平台自己重建 prompt | `PostCompact` hook 重新注入 L0 | 注入 |

**已实现**的那一条现在长这样（`session-start` hook 的真实输出）：

```
本项目已接入 repo-guard。公共层目录：src/components/、src/utils/、src/services/。
改这些目录下**已有**的文件之前，必须先调 impact 工具确认影响面；受影响入口 ≥ 5 时只允许新增可选参数。
单文件超过 500 行需要拆分。影响面为 0 不等于可以删 —— 注意工具输出里的盲区清单。
```

未配置时明确说明守卫未生效，而不是沉默 —— 这条是 `verify-hooks` 的 F2 用例。

#### L1 准入门

deerclaw：`src/knowledge/policy-engine.ts` 三层判定 + `src/agent/control/scope-gate.ts` + `graph-query-guard.ts` + `library-catalog-guard.ts`。

| 控制项 | deerclaw 判据 | CodeBuddy 落点 | 强度 | 状态 |
|---|---|---|---|---|
| 红线 · 结构化删除 | file_write 读磁盘 before 拿真 diff，`count(before) > count(after)` 即视为删除 | `PreToolUse(Edit\|Write\|MultiEdit\|NotebookEdit)` → `deny` | **硬** | P4 |
| 红线 · 意图正则 | 受保护标识符 **+** 破坏性动作（`sed -i`/`DROP`/`TRUNCATE`/`rm`/`git reset --hard`/覆盖重定向）**双条件** | `PreToolUse(Bash)` → `deny` | **硬** | P4 |
| 红线 · paths 收窄 | `rule.paths` glob 匹配，未声明 = 全仓生效 | 同上（`policy-engine.ts` 已移植，逻辑复用） | **硬** | P4 |
| no_refactor 清单 | 路径命中即禁改 | `PreToolUse` 写工具 → `deny` | **硬** | P4 |
| 范围门 scopeGate | `{enabled:false, allowlist:[], maxFiles:null}`，违规 `scope_allowlist`/`scope_budget` | `PreToolUse` 写工具 → `deny`（会话内计文件数） | **硬**，默认关 | P4 |
| 图谱强制 · 改公共层 → impact | 会话内查过则放行 | `PreToolUse` 写工具 → `deny` + 指明调哪个工具 | **硬** | **已实现** |
| 图谱强制 · 新页面 → similar | 同上 | `PreToolUse` 写工具（新建 views 下文件） | **硬** | P4 |
| 图谱强制 · 新组件 → hot | 同上 | `PreToolUse` 写工具（新建组件层文件） | **硬** | P4 |
| 组件库目录 search | `componentLibrary.package` 存在时开启 | `PreToolUse` 写工具（新建组件层文件） | **硬** | P4 |
| shell 旁路观测 | — | `PreToolUse(Bash)` → `additionalContext` + 计数 | 提醒 | **已实现** |

两条重要的设计取舍，从 deerclaw 原样继承：

- **意图正则必须双条件**。只提到标识符（`grep chain_status`）不拦，必须同时命中破坏性动作。否则误伤率高到没法用。
- **新建公共层文件放行**。只有改**已有**文件才要求先查影响面 —— 新文件没有调用者，查了也是空。这是 `verify-hooks` 的 N2 用例。

#### L2 执行门

deerclaw：`src/agent/bash-tool.ts:653`，危险命令拦截 + 10 分钟超时 + 每专家独立 HOME。

CodeBuddy 里**这层归宿主**：`permissions.deny`、`sandbox.enabled`、`defaultMode`、受保护路径、信任目录。插件不该重复实现，只做两件事：

1. 在文档里告诉用户该怎么配 `permissions.deny`（给出建议配置）。
2. 对确实危险但宿主规则覆盖不到的命令给 `permissionDecision: "ask"`，把决定权交回人，而不是自己 deny。

#### L3 循环门

deerclaw：`src/agent/iteration-budget.ts:21` + `react-loop-guard.ts`。

| 控制项 | deerclaw 默认值 | CodeBuddy 落点 | 强度 |
|---|---|---|---|
| 重复 tool_call | `repeatToolCallThreshold: 3`，同 `(toolName, args-shape)` 连续 3 次 | `PostToolUse` 计数 → `PreToolUse` 短路 `deny` + 换路建议 | **硬** |
| 连续失败 | `consecutiveFailThreshold: 3` | `PostToolUseFailure` 计数 → `PreToolUse` `deny` | **硬** |
| 同文件写失败 | 2 次即短路 | 同上 | **硬** |
| 迭代预算 | `maxIterations: 80`，撞顶**优雅降级**出摘要而非冷截断 | 只能用「本会话工具调用总数」近似 → `Stop` hook 给 `additionalContext` 摘要 | **只提醒** |

**说实话**：只有前三条是可靠可执行的 —— 它们只依赖工具调用序列，`PreToolUse` 就能拦。迭代预算在 CodeBuddy 里没有对应物：宿主有自己的上下文管理与自动压缩，「该停时停」由宿主负责，插件掺和只会打架。

#### L4 诚实信号

deerclaw：`src/agent/manager-tools.ts:394`，`finalReason: success | reached_max_iterations | empty_output | error`，升级优先级 `error > reached_max_iterations > empty_output > success`；`error` 时填 `failureCategory`（11 类）与 `recoveryHint`。纯埋点，不拦。

CodeBuddy 落点：`Stop` / `SessionEnd` / `PostToolUseFailure` hook 写 metrics。**纯观测**，且只能近似 —— 插件看不到「子 agent 抛异常」「thinking_exhausted」这类内部状态。能算的只有：本会话工具调用数、失败数、有没有写操作、有没有跑过体检。

#### L5 交付门

deerclaw：`src/agent/control/delivery-gate.ts`。工程校验**始终硬拦提交**（前端 lint/test、后端 go test/build，仓里没 lint 则跳过）；交付瘦身与 AI 审查默认关。

| 控制项 | deerclaw | CodeBuddy 落点 | 强度 |
|---|---|---|---|
| 工程校验 | 始终硬拦，requireEvidence 在开 MR 前必须成功 | `Stop` hook 检查本会话是否有 lint/test/build 证据 | **默认只提醒**（见下） |
| 交付瘦身 | `{enabled:false, maxDeliveryFiles:null, evidencePatterns:[]}` | `Stop` hook，超文件数 `continue:false` | 硬，默认关 |
| AI 审查 | `{enabled:false, minRiskLevel:'medium', blockOnRequestChanges:false}` | `Stop` hook，`type: agent` | 默认关 |

**为什么 L5 在这边默认关**：deerclaw 的硬拦成立，是因为那边 agent 在平台自己的 workspace / worktree 里干活，「提交」是平台的动作，拦得住且拦对。CodeBuddy 里 agent 在**用户的工作树**上干活，`git commit` 是用户随时可能自己敲的动作；插件在 `Stop` 上硬拦会直接妨碍人。误伤率高的门会让人卸载插件 —— 这条优先于治理强度。

另外 `Stop` + `continue:false` 有死循环风险：模型反复触发同一校验会无限续跑。硬约束是**同 reason 每会话最多注入 1 次**。

#### L6 治理留痕

deerclaw：`agent_runs` 表（含 `trace_events`、`token_usage`、`appliedSegments`）+ 事件类型 `policy_violation` / `scope_violation` / `repeat_loop_detected` / `consecutive_fail_halt`，聚合成 `/admin/governance`。

CodeBuddy 落点：所有 hook 往 `$HOME/.repo-guard/metrics.ndjson` 追加，`SessionEnd` 汇总，`repo-guard governance` 命令出报表。

**为什么埋点在 `$HOME` 而不是仓库里**：埋点是跨仓、跨会话的个人数据，写进被守护的仓库会污染 git status（而这个插件的全部价值建立在「不干扰人」之上）。

#### 需求复述

deerclaw：`src/agent/requirement-restate.ts`，是七道门之外的独立一环，**默认开、零阻塞**，失败即放行只落库留痕。判据：复述/原文长度比在 [0.7, 1.3]、无结构性问题（有条件无结果 / 前后矛盾 / 主次颠倒）、无指代未决。核心指标是 `corrected`（用户下一条是否在纠错）。

CodeBuddy 落点：`UserPromptSubmit` hook（可用 `type: prompt` 让小模型判），只写 metrics，不拦。

### 3.3 全景控制项 → 落点总表

| 全景控制项（配置面 tab） | 来源层 | deerclaw 生效方式 | CodeBuddy 控制点 | 本插件状态 |
|---|---|---|---|---|
| 团队章程 soul | 身份 | 推 | — | 不搬 |
| 岗位交底 / 装备 | 身份 | 推 | `agents/*.md` + 插件 `settings.json.agent` | P4 可选 |
| 代码库 / 图谱 | 能力 | 拉 + 硬 | `.mcp.json`（9 个工具）+ CLI | **已实现** |
| 项目知识 | 能力 | 推 | `SessionStart` → `additionalContext` | P3 |
| 公共知识 | 能力 | 拉 | — | 不搬 |
| 专家 Skill / MCP | 能力 | 拉 | `skills/*/SKILL.md` + `.mcp.json` | **已实现** |
| 组件库目录 | 能力/约束 | 硬 | `lib search` + `PreToolUse` | 工具已实现，门禁 P4 |
| 团队禁忌 | 约束 | 推 | `SessionStart` → `additionalContext` | P3 |
| 仓库红线 | 约束 | 推 + 硬 | `SessionStart` 注入 + `PreToolUse` deny | 注入 P3 / 拦截 P4（引擎已就位） |
| 开发前必读 | 约束 | 按任务 | `UserPromptSubmit` → `additionalContext` | P3 |
| 范围与预算 | 约束 | 硬 | `PreToolUse` deny | P4 |
| 循环防护 | 约束 | 硬 | `PostToolUse` 计数 + `PreToolUse` 短路 | P4 |
| 交付校验 | 约束 | 硬 | `Stop` hook | P4，默认关 |
| Manager Playbook | 流程 | 软 | — | 不搬 |
| 需求复述 | 流程 | 零阻塞留痕 | `UserPromptSubmit` | P4 |
| 群绑定 | 流程 | — | — | 不搬（无 IM） |
| 治理总览 | 横切 | 留痕 | metrics.ndjson + `governance` 命令 | P5 |

---

## 4. 架构与目录

```
repo-guard/
├── .codebuddy-plugin/plugin.json   插件清单
├── package.json                    ⚠️ 绝不能加 "type": "module"（见 6.2）
├── tsconfig.json
├── build/
│   ├── build.mjs                   esbuild 打零依赖单文件 → bin/repo-guard
│   ├── sync-py-source.mjs          py_graph.py → 内嵌字符串
│   ├── verify-parity.mjs           新旧产物逐字节比对（66 用例）
│   └── baseline/repo-guard         黄金样本，勿删
├── bin/
│   ├── repo-guard                  构建产物（交付物，进 git）
│   └── verify-hooks.mjs            钩子回归矩阵（20 用例）
├── src/
│   ├── engine/                     ── 移植区，禁止重构（见 PORTING.md）──
│   │   ├── graph/{analyzer,registry,types}.ts
│   │   ├── graph/analyzers/        web-frontend / node-babel / go-gin /
│   │   │                          java-spring / python-ast + py_graph.py /
│   │   │                          frontend-contracts / lexical-utils
│   │   ├── graph-builder.ts        建图 + analyzeImpact / hotSpots /
│   │   │                          traceRoute / similarPages + 边权打分
│   │   ├── graph-report.ts         渲染 impact / trace / hot / similar / contracts
│   │   ├── graph-freshness.ts      缓存新鲜度判据
│   │   ├── policy-engine.ts        红线三层判定
│   │   ├── policy-audit.ts         红线体检（守空气 / 后门 / 证据失准）
│   │   ├── code-scanner.ts  sql-scanner.ts
│   │   ├── public-layer-audit.ts  write-tool-args.ts  types.ts
│   │   └── shims/{logger,token-estimator}.ts
│   ├── library/builtin-catalog.ts  内置组件库目录（antd 68 + tea 62）
│   ├── runtime/                    ── 适配层 ──
│   │   ├── paths.ts                仓库根解析、.codebuddy 路径、HOME 状态目录
│   │   ├── repo-facts.ts           repo-facts.json 读写
│   │   ├── redlines.ts             redlines.json → KnowledgeSnapshot
│   │   ├── graph-cache.ts          缓存 + 新鲜度 + 建图
│   │   ├── session-state.ts        会话内「查过哪些文件」
│   │   └── metrics.ts              埋点
│   ├── gates/                      ── 七道门（P3 起）──
│   ├── cli/                        init scan check impact hot trace
│   │                               similar lib contracts audit governance
│   ├── hooks/                      session-start pre-write pre-bash
│   │                               post-write session-end（+ P4 新增）
│   └── mcp/                        stdio JSON-RPC server
├── hooks/hooks.json
├── .mcp.json
├── commands/{impact,repo-check}.md
├── skills/{code-impact,backend-go,frontend-react}/SKILL.md
└── .codebuddy/guard/               ── 协作全景配置骨架（P3）──
    ├── guard.json                      总开关 + version
    ├── identity/{charter,roles}.json
    ├── capability/{project-knowledge,task-routes}.json
    ├── constraint/{taboos,no-refactor,stop-conditions,scope-gate}.json
    └── process/{graph-enforce,loop,delivery,review,restate}.json
```

### 4.1 三条分层纪律

1. **`src/engine/` 只能改 4 处**，清单在 `src/engine/PORTING.md`。打分权重、边类型、置信度阈值都是在真实仓库上调出来的，重写必然漂，而漂了**没有报错** —— 只表现为「影响面算出来不一样」。
2. **hook 里只读缓存，永不建图**。`pre-write` 只有 15 秒预算，`pre-bash` / `post-write` 只有 5 秒，而 web-frontend 分析器在万文件仓库上可能几十秒。缓存 miss 即 fail-open。建图只发生在 MCP / CLI（无超时约束）。
3. **`pre-write` 只允许输出 `deny` 或什么都不输出**。`verify-hooks` 把「有 `additionalContext`」一律判成 `context`，往 `pre-write` 挂提醒会让 7 条 allow 用例集体变红。提醒统一走 `SessionStart` / `UserPromptSubmit` / `PostToolUse`。

### 4.2 影响面算法（从 deerclaw 原样继承）

```
① 直接调用者 —— 图谱里谁调了它
② 沿反向依赖走，最多 3 跳
③ 落到入口上：处理文件在传播集里，或处理函数直接调了目标
```

打分 `分数 = 上一跳 × 边权 × 0.6`，多路径取最强。

| 边类型 | 权重 | 理由 |
|---|---|---|
| 函数调用 / JSX 引用 | 1.0 | 真用了 |
| 继承 | 0.9 | |
| 调后端接口 | 0.6 | |
| 模块 import | 0.5 | import 了不代表真用了 |

`≥ 0.5` 算强影响：直接调用 `1.0 × 0.6 = 0.6` 过线，两跳 import 约 `0.09` 不过线。

**每次查询都附盲区清单**。动态 import、样式引用、运行时拼接的路径都看不见；SQL、离线任务、其它服务完全在图谱之外。空图是最坏的失败模式 —— AI 会把「没有调用者」当成事实去删。所以所有分析器置信度都不够时，明确报「暂不支持这个技术栈」，不给空图。

---

## 5. 数据契约

### 5.1 落盘文件

| 文件 | 谁写 | 进 git | 说明 |
|---|---|---|---|
| `.codebuddy/repo-facts.json` | `init --write` | ✅ | 公共层清单、分析器、行数上限 |
| `.codebuddy/redlines.json` | **人手写** | ✅ | 红线意图。代码里读不出来 |
| `.codebuddy/guard/**` | `guard init --write`（P3） | ✅ | 七道门配置 |
| `.codebuddy/.cache/{graph,meta,catalog}.json` | 引擎 | ❌ | 图谱缓存，`init --write` 自动加进 `.gitignore` |
| `$HOME/.repo-guard/state/<sid>.json` | hook / MCP | ❌ | 会话内「查过哪些文件」 |
| `$HOME/.repo-guard/metrics.ndjson` | 全部 hook | ❌ | 治理埋点 |

```jsonc
// .codebuddy/repo-facts.json
{
  "version": 1,
  "analyzer": "web-frontend",
  "publicLayer": ["src/components/", "src/utils/", "src/services/"],
  "componentLibrary": null,
  "lineLimit": 500,
  "generatedAt": "2026-09-18T07:00:00.000Z"
}

// .codebuddy/redlines.json —— 形状即 engine/types.ts 的 PolicyRule[]
{ "rules": [{
  "id": "RL-001",
  "rule": "这个接口有外部调用方，改名等于让对方 404",
  "reason": "为什么。最重要的字段：让 LLM 理解意图而非死记",
  "protects": ["fetchUsers"],
  "paths": ["src/services/**"],
  "violation_action": "stop_and_ask",
  "evidence": "src/services/user.ts:2",
  "enabled": true,
  "confirmed": true
}]}
```

### 5.2 为什么图谱不进 git、红线必须进 git

图谱是代码的**投影** —— 删了重跑结果一模一样，所以不进 git、不用备份。缓存失效有两条判据，**都会触发重建**：

- git HEAD 变了（切分支、拉新代码）
- **源文件最大 mtime 变了**（管的是"改了还没提交"）

第二条很重要：刚改完还没提交时，图谱必须跟着更新，否则查出来的是旧答案。

红线不一样 —— 那是人写的**意图**，静态分析推不出来（"外部仍有调用方"永远算不出），丢了就永久损失。所以必须进 git，跟代码走同一个 PR。

### 5.3 人写意图，机器验完整性

手写的规则会腐烂，而且**人 review 发现不了**。reviewer 能判断「这条该不该加」，但验证不了「paths 写全了没」「evidence 行号还准不准」「protects 的符号是不是早就改名了」。所以 `audit` 命令专门验这三件事：

```
✗ RL-001  这个接口有外部调用方，改名等于让对方 404
    有 2 处出现位置不在声明的 paths 内 —— 这些位置是后门，agent 在那里改动不会被拦
    fetchUsers: 1/3 被覆盖，缺口 2 处
      ⚠ src/views/UserList/index.tsx:5 [code/code]
      建议补进 paths: src/views/UserList/*.tsx
✗ RL-003  这条规则在守空气
    受保护标识符在代码与 SQL 里都找不到 —— 这条红线在守空气，应删除或更正
```

### 5.4 MCP 工具契约（9 个）

| 工具 | 入参 | 回答什么 |
|---|---|---|
| `impact` | `{file}` | 改它会波及哪些页面和接口 |
| `hot` | `{limit?}` | 仓里有哪些被大量入口复用的东西，别重复造轮子 |
| `scan` | — | 超长文件、循环依赖 |
| `check` | `{files}` | 改动涉及的文件碰没碰公共层 / 命中红线 |
| `trace` | `{urlPath}` | 入口 → 处理函数 → 下游 → 后端接口，含反推出入参 |
| `similar` | `{intent, limit?}` | 这类页面本仓已经怎么写了 |
| `lib_search` | `{intent, limit?}` | 本仓 UI 组件库里有没有现成的 |
| `audit` | — | 红线还准不准 |
| `contracts` | `{api?, minCallSites?}` | 从调用点反推接口类型草稿（**必须人工 review**） |

工具描述本身承担教学功能，例如 `lib_search` 的描述里写着：「内部组件库不在你的训练数据里，凭 antd / MUI 经验写的 props 几乎一定是错的」。

---

## 6. 构建与验证

### 6.1 构建

```bash
npm install
npm run build          # esbuild → bin/repo-guard（压缩，零依赖单文件）
npm run build:dev      # 不压缩 + sourcemap，排查时用
npm run check          # typecheck + build + verify-hooks + verify-parity
```

产物必须是**单文件、无扩展名、CJS、零外部依赖**：

- 单文件 —— 插件装完不能有 `npm install` 这一步。插件更新会换目录，`node_modules` 留不住，而 hook 只有 5~15 秒预算，装依赖必然超时。
- CJS —— `@babel/traverse` 是 CJS，ESM 下 default interop 会变成 `{default: fn}`；打成 CJS 少一层不确定性，且无扩展名文件能直接 `node bin/repo-guard`。

### 6.2 三个已经踩过的坑（都已加自动化守卫）

**坑一：产物文件头被污染。** 原产物头部被插入 6 字节 `你是`，整个文件语法错误，20 条用例只过 11 条 —— 所有 hook 静默 fail-open，插件**表面装着、实际全放行，且没有任何报错**。
→ `build.mjs` 加冒烟步骤：构建完必须跑一次产物并检查帮助输出。

**坑二：`package.json` 的 `"type": "module"` 直接废掉产物。** 产物是无扩展名 CJS，Node 按最近的 `package.json` 判模块类型；声明成 module 就被当 ESM 解析，第一行 `require` 就 `ReferenceError`。原产物 zip 里根本没有 `package.json`，所以是 CJS。
→ `package.json` 里写死 `"//type"` 警告字段 + 冒烟步骤兜底。

**坑三：`py_graph.py` 与内嵌字符串失同步。** Python 分析器走子进程，脚本内容必须来自代码里的字符串（打包器不复制非 JS 资源，读文件在产物里必然 ENOENT）。两份漂移的症状是「Python 仓突然建不出图」，而 hook 层 fail-open 会把它吞掉，只表现为图谱变空。
→ `build.mjs` 每次构建硬校验一致性，不一致直接失败；改 `.py` 后跑 `build/sync-py-source.mjs` 同步。

### 6.3 两道验收闸门

**`bin/verify-hooks.mjs`（59 条）** —— 自建临时 git 仓库，按宿主契约给钩子灌 JSON。不碰任何真实仓库。

证明两件事：**拦得对**，而且**不误伤**。第二件比第一件重要 —— 误伤会让人直接卸载。

| 组 | 用例 | 验什么 |
|---|---|---|
| 拦得对 | P1 P2 A1 K1 G2 | 公共层已有文件、另一目录、绝对路径、`notebook_path`、查过 A 不放行 B |
| 不误伤 | N1 N2 T1 T2 G1 | 普通页面、新建公共层、同名前缀目录 `components-legacy`、仓库外路径、查过之后放行 |
| 提醒而非拦 | B1 B2 B3 W1 W2 S1 | shell 写公共层提醒、只读不提醒、非公共层不提醒、超长文件提醒、正常长度不提醒、会话开始注入 |
| fail-open | F1 F2 | 没配置时不拦、且明确提示守卫未生效 |
| 坏输入不崩 | E1 E2 | 空输入、缺 `tool_input` |

**`build/verify-parity.mjs`（84 条）** —— 新旧两份产物喂同样输入，逐字节比 stdout + 退出码。

为什么需要它：适配层没有源码，是反推重写的，而 `verify-hooks` 只校验 verdict 三态 —— 拦对了但文案、路径归一、退出码、JSON 字段漂了它一概看不见。

隔离策略：两侧各拿**独立的** fixture 仓库和独立 HOME（`init --write` 会改仓库、MCP 的 `impact` 会往 `$HOME` 写状态），两侧跑完各自的完整序列再成对比对。用例顺序有意义 —— `init --write` 之前跑的走「未配置」分支，之后跑的走「已配置」分支，两条都要覆盖。

fixture 必须**真的触发有数据的分支**。第一版 fixture 推不出公共层、0 个入口、无页面指纹，impact / trace / similar 全走空分支，parity 给的是假信心。现在两个 fixture：

- `web`：React + TS，路由表写成**变量声明的直接数组字面量**（包在 `createBrowserRouter(...)` 里分析器扫不到），页面里放 `Table` / `Pagination` / `Input` / `Form` / `Modal` 让页面指纹打出标签，两条 API 调用喂契约反推，外加超长文件、同名前缀目录、循环依赖
- `go`：go.mod + gin 路由 + handler → service → common 三层

现状：**verify-hooks 59/59，verify-parity 76/84 逐字节一致 + 8 个已登记的有意偏差，0 个未解释差异。**

### 6.4 已登记的有意偏差

parity 的闸门允许登记"明知不同且有意保留"的用例，但每条必须写清差在哪、为什么不改回去。
这个清单是给下一个人看的 —— 没有它，后来者看到 DIFF 只会以为是自己写坏了。

| 用例 | 差异 | 为什么不改回去 |
|---|---|---|
| `lib-search` / `mcp-lib-search` | 组件库检索的排序不同（命中集合是旧产物的超集） | 旧产物的打分函数逆向了 11 个查询仍拼不出来，而且它**自相矛盾**：单字查询「树」「选」有结果，但「框」返回空 —— 而「输入框」「多选框」「单选框」都含「框」。这更像缺陷而非设计。这是检索排序的启发式，不是行为契约 |
| `contracts-min1` | ① 类型草稿署名 `DeerClaw` → `repo-guard`；② 旧产物的 CLI 不认 `--min-call-sites`，把它的值当成了"只导这一条接口"的名字从而静默返回空结果，本版修了 | ① 独立插件里署一个用户机器上不存在的产品名，只会让人怀疑这段代码是哪来的；② 静默返回空结果是 bug，不该锁死 |
| `mcp-contracts-min1` | 同上第 ① 条 | 同上 |

另外一处不算偏差、但值得记的修复：旧产物在 macOS 上会把仓库内的**绝对路径**判成"不在仓库里"
（`/var` 是 `/private/var` 的符号链接，`mkdtemp` 给 `/var/...` 而 `process.cwd()` 返回 `/private/var/...`）。
本版在路径归一时两边都做 realpath。parity 的 `impact-abs` 用例已改成用 realpath 传参，
这样它校验的是"绝对路径能被接受"，而不是在比对一个错误行为。

---

## 7. 独立性论证

**结论：完全脱离 deerclaw 平台，可独立运行。** 以下是逐条证据。

### 7.1 依赖面

```
$ grep -oE 'require\("[^"]+"\)' bin/repo-guard | sort -u
require("node:child_process")
require("node:fs")
require("node:os")
require("node:path")
require("node:tty")
require("node:util")
```

产物只 require Node 内置模块。`@babel/parser` 与 `@babel/traverse` 已打进产物（所以不出现在 require 列表里）。**没有任何 npm 运行时依赖。**

### 7.2 网络

```
$ grep -coE "node:https|node:http\"|XMLHttpRequest" bin/repo-guard
0
$ grep -oE "\bfetch\(" bin/repo-guard | wc -l
0
$ grep -oE '"https?://[^"]{4,60}"' bin/repo-guard | sort -u
"http://foo.com"          # 测试用字面量
"http://foo.com/"
```

**零出网能力。** 没有 http/https 模块、没有 `fetch`、没有真实 URL。内网可用。

### 7.3 数据库与令牌

源码里 `drizzle` / `better-sqlite3` / `API_KEY` / `TOKEN` / `Bearer` 全部为零命中。唯一一个 DB 相关文件 `policy-source.ts`（红线的平台侧数据源：drizzle + `policy_rules` / `agent_configs` 表，按 agent 维度加载、按 `updated_at` 失效）**已在移植时删除**，等价物是 `src/runtime/redlines.ts` —— 从 `.codebuddy/redlines.json` 读，产出**同样形状**的 `KnowledgeSnapshot`，所以 `policy-engine` / `policy-audit` 全链路零改动。这正是原文件注释里强调的那条契约：「只换了红线从哪来，没换红线怎么用」。

### 7.4 外部进程

只有两个，都是可选的：

| 进程 | 用途 | 缺了会怎样 |
|---|---|---|
| `git` | 读 HEAD sha 做缓存新鲜度判据 | 退到只按源文件 mtime 判断 |
| `python3` | Python 仓的 AST 分析器 | Python 仓建不出图，其他技术栈不受影响 |

### 7.5 环境变量

```
CODEBUDDY_SESSION_ID / CLAUDE_SESSION_ID   会话隔离
HOME                                       状态与埋点目录
PATH                                       找 git / python3
REPO_GUARD_DEBUG / DEBUG                   调试开关
```

**没有一个是凭据或服务地址。**

### 7.6 一处待清理的命名残留

产物里有 `~/.deerclaw/library-packs`（组件库 d.ts 解析结果的本地缓存目录）。这是**目录名的历史包袱，不是依赖** —— 它是本机缓存，不连任何服务。适配层重写时应改成 `~/.repo-guard/library-packs`，避免用户误以为需要装 deerclaw。已列入 P2 待办。

### 7.7 运行前提

机器上有 **Node 18+**。没有别的。

---

## 8. 与 deerclaw agent 的能力对比

### 8.1 定位差异

这不是「插件版 = 弱化版平台」。两者回答的是不同问题：

- **deerclaw** 回答「一个团队怎么把活派下去并保证质量」—— 多 agent、异步、IM 入口、服务端托管。
- **repo-guard** 回答「一个人和一个 agent 结对时，怎么让 agent 不捅刀」—— 单 agent、同步、CLI 入口、零服务端。

所以大量 deerclaw 能力在这边**不是做不到，是没有意义**。

### 8.2 能力对比

| 能力 | deerclaw agent | repo-guard 插件 | 差异性质 |
|---|---|---|---|
| **图谱与影响面** | | | |
| 代码图谱建图 | 平台 `graph-builder`，索引状态入库 | 同一份引擎，本地现算 + 缓存 | **等同**（同一份代码） |
| 影响面打分 | 边权 1.0/0.9/0.6/0.5，阈值 0.5 | 完全一致 | **等同** |
| 多语言分析器 | 前端 / Node / Go / Java / Python | 完全一致 | **等同** |
| 盲区清单 | 每次查询附带 | 完全一致 | **等同** |
| 接口契约反推 | `contracts` | 完全一致 | **等同** |
| 同类页骨架 / 高扇入热点 | `similar` / `hot` | 完全一致 | **等同** |
| 组件库目录 | 内置 + d.ts 现算 | 完全一致（antd 68 + tea 62 内置） | **等同** |
| 跨仓图谱 | 多仓合并，按 agent 引用范围加载 | 单仓 | **缺失**（无多仓概念） |
| **红线与门禁** | | | |
| 红线三层判定 | `policy-engine.ts` | 同一份引擎 | **等同** |
| 红线体检（audit） | 有 | 完全一致 | **等同** |
| 红线数据源 | 数据库，**保存即生效** | 仓库文件，跟 commit 走 | **各有优劣**：平台改完即生效；文件版与代码零延迟锚定、可 review、可回溯 |
| 按 agent 维度降噪 | 专家只看自己引用的仓 | 无（只有一个仓） | **不适用** |
| 范围门 / 循环门 / 交付门 | 有，硬拦 | P4，映射见 §3.2 | **部分等同**（迭代预算只能近似） |
| 需求复述 | 有，零阻塞留痕 | P4 | **等同** |
| **执行环境** | | | |
| 沙箱 / 危险命令 | 平台 `bash-tool.ts` | **宿主承担**（`permissions` + `sandbox`） | **等同或更强**（宿主有 6 种权限模式 + 自然语言分类器） |
| 每 agent 独立 HOME | 有，含凭据物化 | 无 | **不适用**（单人单机） |
| task 级 worktree | 有 | **宿主承担**（`--worktree` / `isolation: worktree`） | **等同** |
| 超时保护 | 10 分钟硬编码 | 宿主 + hook `timeout` | 等同 |
| **上下文与知识** | | | |
| system prompt 组装 | 11 段全权组装，每段 1500 token，超限标注截断 | 只能**追加** `additionalContext` | **弱**：无法重排、无法覆盖宿主 prompt |
| 项目知识注入 | 有，按 agent 加载 | P3，`SessionStart` 注入 | 等同 |
| 团队禁忌 | 有 | P3 | 等同 |
| 开发前必读（按任务路由） | 有 | P3，`UserPromptSubmit` | 等同 |
| 公共知识库检索 | `search_knowledge`，FTS5 + 中文 2-gram | 无 | **缺失**（无知识库） |
| 三级记忆（team/agent/task） | `memories` 表 + importance 权重 | **宿主承担**（Auto Memory / Typed Memory / teamMemory） | **等同或更强** |
| 技能 | `skills` 表 + `skill_view` | `skills/*/SKILL.md`（渐进式披露） | **等同** |
| **多 agent 协作** | | | |
| Manager 拆解 / Playbook | 有 | 无 | **不搬**（无团队成员） |
| `delegate_to_member` / `delegate_parallel` | 有，带 `canDelegateTo` 白名单 | **宿主承担**（Agent 工具 + 团队功能） | 形态不同 |
| `handoff_to` / 嵌套深度上限 | 有 | 宿主（嵌套 5 层 / spawn 预算 200） | 宿主承担 |
| 汇报 cadence | `report_progress` | 无 | **不搬**（人就在屏幕前） |
| `finalReason` + 11 类失败分类 | 有，纯埋点 | 只能近似观测 | **弱** |
| **入口与管理** | | | |
| 企微 / IM 群绑定 | 有 | 无 | **不搬** |
| Web 管理面（team/agent/policy/知识/治理） | 有 | 无（配置即文件） | **不搬** |
| HTTP API + SSE | 有 | 无 | **不搬** |
| 斜杠命令 | `/tasklist` 等任务管理 | `/repo-guard:impact` 等 | 形态不同 |
| **治理与可观测** | | | |
| 执行追溯 | `agent_runs` 表：`trace_events` / `token_usage` / `appliedSegments` | `metrics.ndjson`（P5） | **弱**：无 token 真值、无注入段落明细 |
| 治理总览 | `/admin/governance` 聚合 | `repo-guard governance`（P5） | **弱**：单机、无跨团队聚合 |
| token 自校准 | 服务端 usage 真值回灌 EWMA | 无（拿不到 usage） | **缺失** |
| **模型层** | | | |
| provider / fallback 链 | openai / gongfeng / minimax + 429 降级 | **宿主承担** | 宿主承担 |
| 模型槽位 | agent → team → 全局 | 宿主（`model` / `variantModels` / `subagents` / `effort`） | **等同或更强** |
| **工程属性** | | | |
| 部署 | 服务端 + sqlite + 常驻进程 | 一个文件，Node 18+ | **显著更简单** |
| 内网可用 | 需要部署 | 天然可用（零出网） | **更强** |
| 凭据管理 | 加密入库 + per-agent 物化 | 不需要凭据 | **更强**（没有攻击面） |
| 起步成本 | 建团队、配专家、接仓库、建图 | `repo-guard init --write` | **显著更低** |

### 8.3 三条结论

1. **「算得准」这部分完全等同** —— 图谱、影响面、红线判定、红线体检、契约反推用的是同一份引擎代码，parity 逐字节守着。这是 deerclaw 里最难做、也最值钱的部分。

2. **「拦得住」这部分大体等同，两处真弱** ——
   - **迭代预算**：deerclaw 拥有 ReAct 循环，能在撞顶时优雅降级出摘要；插件拿不到 iteration 序号，只能近似观测。
   - **L0 注入顺序**：deerclaw 全权组装 11 段 prompt，插件只能追加。

3. **「管得动」这部分不搬** —— 多 agent 委派、IM 入口、Web 管理面、跨团队治理聚合，在单人单机场景里没有对应需求。要这些就该用平台。

---

## 9. 风险、非目标与决策记录

### 9.1 风险与对策

| 风险 | 对策 |
|---|---|
| 适配层反推漂移（差一个 `??` 就换分支） | `build/baseline/` 留旧产物，parity 逐字节比 stdout，差异必须人工判定，**不能直接刷新基线** |
| Babel CJS interop 在打包器下变 `traverse is not a function`；fail-open 会吞成「图谱突然空」 | parity 必须跑真实建图（TSX + Go 各一个仓），不能只跑 hook |
| hook 超时遇上万文件仓建图 | hook 只读缓存、永不建图；`SessionStart` 也不预热 |
| 门禁计数器写到 cwd 会污染用户仓库并让测试串味 | 全部走 `runtime/session-state.ts`（HOME 下）；加用例断言临时仓无新增文件 |
| `session_id` 在 `--resume` / compact 之后是否延续未验证 | id 变了等于状态清零（偏保守，可接受）；埋点带 cwd 做二级归并 |
| `Stop` + `continue:false` 反复触发死循环 | 同 reason 每会话注入上限 1 次，且 L5 默认关 |
| 公共层推测错 → 要么漏拦、要么天天误伤 | `init` 默认**一个字节都不写**，只报告推测与依据；`--write` 才生成；文档明确要求人过一眼 |
| 红线腐烂而 review 发现不了 | `audit` 命令验完整性（守空气 / 后门 / 证据失准） |

### 9.2 非目标

- 不做多 agent 委派、IM 入口、Web 管理面。
- 不做知识库。
- 不改用户的 lint 配置 —— `init` 只把建议片段打出来让人自己贴。
- 不替宿主做权限与沙箱。
- 不把图谱进 git。
- **当前只守一个仓**。多仓（一个会话挂多个仓、微服务之间的跨仓影响面）
  的边界、演进支点与落地分级见 [MULTI-REPO.md](./MULTI-REPO.md)。

### 9.3 关键决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 引擎**逐字移植**，不重写、不精简 | 打分权重与启发式是实测调出来的；重写会漂且漂了没报错 |
| D2 | 产物保持**零依赖单文件**，构建脚本放 `build/` | 装机体验零变化；插件更新会换目录，`node_modules` 留不住 |
| D3 | 删 `policy-source.ts`，等价物读 `redlines.json` | 那是 drizzle + deerclaw 表的平台侧数据源，零服务端下一行都跑不起来 |
| D4 | 七道门**照搬 deerclaw 默认值**，L5 交付门默认关 | agent 在用户工作树上干活，`Stop` 硬拦 commit 会妨碍人；误伤优先于治理强度 |
| D5 | 协作全景配置放 `.codebuddy/guard/` 分层目录，JSON 内嵌 `_why` | 四层目录对应全景的 tab；`_why` 与 deerclaw `allowlist.json` 同风格。空配置 = 零行为变化 |
| D6 | `repo-facts.json` / `redlines.json` 保持原路径 | 不破坏 `verify-hooks` 契约 |
| D7 | 适配层验收 = **逐字节对齐旧产物** | 没有源码可比对，只能拿旧产物当黄金样本 |
| D8 | 分阶段交付：先源码版（P0–P2）验过，再做协作全景（P3–P5） | 坑叠在一起难定位 |

### 9.4 阶段与状态

| 阶段 | 内容 | 验收 | 状态 |
|---|---|---|---|
| P0 | 基线固化 + parity 脚本 | parity 自比对全绿 | ✅ |
| P1 | 工程骨架 + 引擎移植 | typecheck 干净、产物单文件 | ✅ |
| P2 | 适配层反推重写 | verify-hooks + parity 无未解释差异 | ✅ |
| P3 | 全控制点骨架 + `.codebuddy/guard/` 配置 | `plugin validate` 通过、空配置零行为变化 | ✅ |
| P4 | 七道门接进运行时 | 每道门有独立用例，且阶段 C 证明零行为变化 | ✅ |
| P5 | 真机验证 + 治理总览 + 分发物料 | `--plugin-dir` 端到端跑通 | ✅ |
| P6 | 多仓（设计） | 见 [MULTI-REPO.md](./MULTI-REPO.md)。已落地的只有会话状态的仓库维度（G3 用例钉住），其余待排 | 📋 |

**当前验收状态**

```
npm run check
  ✅ typecheck 干净
  ✅ build 880 KB 单文件零依赖（含冒烟）
  ✅ verify-hooks   59/59
  ✅ verify-parity  76/84 逐字节 + 8 条已登记偏差 + MCP 长连接存活
```

真机 `--plugin-dir` 验证过的项：插件加载、9 个 MCP 工具可见且工具名为
`mcp__repo-guard__impact`、3 个 skill 载入、`repo-guard-reviewer` 出现在 `/agents`、
`SessionStart` 注入到位、斜杠命令 `/repo-guard:repo-check` 可触发、
以及完整闭环（拦住 → 调 impact → 判定低于阈值 → 放行 → 改对 → 复述盲区）。

### 9.5 真机验证抓到的三个 bug（脚本测不出来）

这三个都在 `npm run check` 全绿的情况下存在，只有真机装一次才暴露。
记在这里是因为它们代表了**三类脚本测试的盲区**：

| bug | 为什么脚本测不出来 | 现在怎么守 |
|---|---|---|
| **MCP server 与宿主死锁** —— 一次读完 stdin 再处理，而宿主写完 `initialize` 就等响应、不关闭 stdin | `printf ... \| repo-guard mcp` 的管道写完就 EOF，同步读立刻返回，所有用例照常通过 | `verify-parity` 末尾加了独立断言：写一帧、等、再写一帧，两帧都得有回复 |
| **拒绝文案里的工具名没带命名空间** —— 插件 MCP 工具真名是 `mcp__repo-guard__impact` | 脚本直接调 `repo-guard mcp` 的 `tools/call`，从不经过宿主的工具名解析 | 文案改成给三种调法（MCP 全名 / 斜杠命令 / CLI），并明确禁止用 grep 代替 |
| **`agents/README.md` 被载入成一个名叫 `README` 的 agent** | 脚本不读宿主的组件加载结果 | 说明文档移到 `docs/`，并在 `docs/README.md` 里写清这条纪律 |

**结论：脚本测的是"我的代码对不对"，真机测的是"宿主是不是按我以为的方式用它"。**
两者不可互相替代。发版前必须真机装一次 —— 这一步不能省。

### 9.5 P2 交付清单

```
src/runtime/     paths / repo-facts / redlines / graph-cache / session-state / metrics / guard
src/library/     builtin-catalog（antd 68 + tea 62）/ library-catalog
src/cli/         index / init / scan / render / trace / governance
src/hooks/       index（5 个钩子）
src/mcp/         server（9 个工具）
build/           build.mjs / sync-py-source.mjs / verify-parity.mjs / baseline/
```

P2 过程中发现并修掉的问题，都已加自动化守卫：

| 问题 | 守卫 |
|---|---|
| 产物文件头被污染 6 字节，整个引擎语法错误，20 条用例只过 11 条，且**所有 hook 静默 fail-open** | `build.mjs` 构建后冒烟跑一次产物并检查帮助输出 |
| `package.json` 的 `"type": "module"` 让无扩展名 CJS 产物被当 ESM 解析 | `package.json` 内写死 `"//type"` 警告 + 冒烟兜底 |
| 会话 id 在两个进程里来路不同（MCP 从环境变量、hook 从 stdin），不打通则守卫死循环 | `verify-hooks` 的 G1/G2 用例 |
| `findRoute` 的末段匹配会把 `/api/users` 撞到页面路由 `PAGE /users`，给出完全错误的调用链 | `src/cli/trace.ts` 只保留精确 + 忽略斜杠大小写两级；parity 的 `trace-api` / `mcp-trace` 用例 |
| CLI 把 `--min-call-sites` 的值当成位置参数，命令静默返回空结果 | `positionals()` 跳过带值选项；parity 的 `contracts-min1` 用例 |
| 行数统计与编辑器行号差 1 | parity 的 `scan` / `hook-post-write-long` 用例 |
