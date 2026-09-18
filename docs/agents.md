# agents/ —— 子代理定义

插件可贡献子代理。它们出现在 `/agents` 里，模型也可以按任务上下文自动调用。

## 现有

| 文件 | 用途 | 是否默认激活 |
|---|---|---|
| `repo-guard-reviewer.md` | 只读的改动审查者：算影响面、扫红线、查体量，不写代码 | ❌ 需要用户在 `/agents` 里选，或 `--agent repo-guard-reviewer` |

**没有默认激活任何 agent。** 插件根 `settings.json` 的 `agent` 键能把某个 agent
提为主线程，但那意味着接管用户的系统提示词 —— repo-guard 是护栏不是人格，
装一个护栏插件却发现自己的 agent 被换掉，是会让人立刻卸载的那类惊喜。

## frontmatter 可用字段

| 字段 | 作用 |
|---|---|
| `name` `description` | 必填。description 决定模型什么时候自动调它 |
| `model` | 模型 ID / 别名 / `lite` / `reasoning` / `inherit` |
| `effort` | `minimal` `low` `medium` `high` `xhigh` `max` |
| `maxTurns` | 最大轮次 |
| `tools` | 工具白名单。省略则继承主线程全部工具 |
| `disallowedTools` | 黑名单。与 `tools` 都写时黑名单优先 |
| `skills` | 自动加载的技能名 |
| `memory` | `user` / `project` / `local` |
| `background` | `true` = 总在后台跑 |
| `isolation` | 唯一有效值 `"worktree"` |

## 插件 agent 明确不支持的三个字段

`hooks`、`mcpServers`、`permissionMode` —— 出于安全原因被禁。所以：

- 想在子代理生命周期里挂钩子 → 走 `hooks/hooks.json` 的 `SubagentStart` / `SubagentStop`
- 想给子代理专属工具 → 只能靠 `tools` 白名单从插件的 `.mcp.json` 里挑
- 想改子代理权限模式 → 只有用户能配（`settings.json` 的 `subagentPermissionMode`）

## 待补充

| 打算做什么 | 为什么还没做 |
|---|---|
| `repo-guard-fixer` —— 拿着 audit 结果去修红线文件（补 paths、删守空气的规则） | 修红线是在改**人的意图声明**，得有人 review。让 agent 自动改风险太大，先让 `audit` 把问题说清楚 |
| L5 交付门的 `type: agent` 验证器 | 交付门默认关（见 `templates/guard/process/delivery.json`）。开启后这里需要一个能跑 lint/test 的 agent |
