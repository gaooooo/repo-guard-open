# 本仓工程事实

- 公共层目录以 `.codebuddy/repo-facts.json` 的 `publicLayer` 为准。改这些目录下**已有**文件前必须先查影响面。
- 组件库包名以 `repo-facts.componentLibrary` 为准。若配置了 `componentMcp`，写组件前必须先查该 MCP 的文档和 props；`lib_search` 只回答「库里有没有」。不要凭其它库的记忆写 API。
- 契约 / 架构 / 设计稿的权威源路径写在下面，正文去读，不要在对话里复述全文。
