# 组件目录里不要放 README

`agents/` `commands/` `skills/` 这三个目录下的每个 `.md`
都会被宿主当成一个**组件定义**载入。

真机实测踩过：`agents/README.md` 变成了一个名叫 `README` 的 agent，
出现在用户的 `/agents` 菜单里 —— 一条没有 `description`、点了不知道会发生什么的条目。

所以这三份说明文档在 `docs/` 下：

| 文档 | 对应目录 |
|---|---|
| [`docs/agents.md`](agents.md) | `agents/` —— 子代理定义、frontmatter 字段、插件 agent 不支持的三个字段 |
| [`docs/commands.md`](commands.md) | `commands/` —— 斜杠命令、为什么命令这么少 |
| [`docs/skills.md`](skills.md) | `skills/` —— 技能、description 怎么写、frontmatter hooks 的闸门 |

控制面说明与示例（汇报页，左菜单右内容）：[`control-examples.html`](control-examples.html)。

分层重构：[`DESIGN-SEVEN-LAYERS.md`](DESIGN-SEVEN-LAYERS.md)（作者目录 `layers/`）。

过程门禁说明：[`PROCESS-GATES.md`](PROCESS-GATES.md)。

红线说明：[`REDLINES.md`](REDLINES.md)。

图谱说明：[`GRAPH.md`](GRAPH.md)。

人审说明：[`HUMAN-REVIEW.md`](HUMAN-REVIEW.md)。

合并门禁说明：[`MERGE-GATES.md`](MERGE-GATES.md)。

组件规范说明：[`COMPONENT-SPEC.md`](COMPONENT-SPEC.md)。

UI 规范说明：[`UI-SPEC.md`](UI-SPEC.md)。

`layers/process-gates/README.md` 可以留在 `layers/`：那不是宿主认识的组件目录，
只是 `repo-guard guard init` 的数据源，而且 `guard init` 明确只铺 `.json`。
