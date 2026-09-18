# 组件目录里不要放 README

`agents/` `commands/` `skills/` `output-styles/` 这四个目录下的每个 `.md`
都会被宿主当成一个**组件定义**载入。

真机实测踩过：`agents/README.md` 变成了一个名叫 `README` 的 agent，
出现在用户的 `/agents` 菜单里 —— 一条没有 `description`、点了不知道会发生什么的条目。

所以这三份说明文档在 `docs/` 下：

| 文档 | 对应目录 |
|---|---|
| [`docs/agents.md`](agents.md) | `agents/` —— 子代理定义、frontmatter 字段、插件 agent 不支持的三个字段 |
| [`docs/commands.md`](commands.md) | `commands/` —— 斜杠命令、为什么命令这么少 |
| [`docs/skills.md`](skills.md) | `skills/` —— 技能、description 怎么写、frontmatter hooks 的闸门 |

## 例外

`themes/README.md` 与 `monitors/README.md` 可以留在原地 ——
那两个目录是 Claude 标准字段，CodeBuddy **根本不加载**，放什么都不会被误读。
它们存在的意义就是说明"这个控制点在本宿主下无效"。

`templates/guard/README.md` 同理：`templates/` 不是宿主认识的组件目录，
它只是 `repo-guard guard init` 的数据源，而且 `guard init` 明确只铺 `.json`。
