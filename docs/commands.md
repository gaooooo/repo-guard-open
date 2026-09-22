# commands/ —— 斜杠命令

注册成 `/repo-guard:<名字>`。命名空间是强制的，防止插件之间撞名。

## 现有

| 命令 | 用途 |
|---|---|
| `/repo-guard:impact` | 改动前算影响面 |
| `/repo-guard:repo-check` | 体量与结构体检 |
| `/repo-guard:audit` | 红线体检：守空气 / 后门 / 证据失准 |
| `/repo-guard:governance` | 治理留痕报表 |

## frontmatter 可用字段

| 字段 | 作用 |
|---|---|
| `description` | 补全提示里显示 |
| `argument-hint` | 参数提示，如 `[文件路径]` |
| `allowed-tools` | 工具白名单，支持细粒度 `Bash(npm run:*)` / `Edit(src/**/*.ts)` |
| `model` | 指定这条命令用哪个模型 |
| `disable-model-invocation` | `true` = 只能人手动触发，模型不能自己调 |

命令正文里可用：`$ARGUMENTS`（全部参数）、`$1` `$2`（位置参数）、
`` `!命令` ``（内联 shell）、`@path/to/file`（内联文件）。

## 为什么命令这么少

能力主要走两条路，命令只是第三条：

1. **MCP 工具**（9 个）—— 模型自己判断什么时候调，这是主路
2. **Skills** —— 渐进式披露，模型按需加载正文
3. **命令** —— 给**人**用的入口。人想主动看一眼时敲一下

`impact` / `scan` 这些模型会自己调，做成命令只是方便人手动触发。
把每个工具都包一层命令会让 `/` 菜单变成噪音。

## 待补充

| 打算做什么 | 为什么还没做 |
|---|---|
| `/repo-guard:guard-init` —— 把 `layers/process-gates/` 铺进用户仓库的 `.codebuddy/guard/` | 七道门配置还没接进运行时（P4）。先铺一堆没人读的配置文件只会让人困惑 |
| `/repo-guard:trace` `/repo-guard:similar` `/repo-guard:lib` | 这三个是模型该自己调的，人手动触发的场景少。要加也是等有人提 |
