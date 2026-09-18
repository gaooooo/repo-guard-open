# themes/ —— Claude 标准字段，CodeBuddy 不加载

**这个目录在 CodeBuddy 下没有任何效果。** 列出来是为了标明控制点全集。

## 事实

`plugin.json` 的 `experimental.themes` 是 Claude Code 的插件字段。
CodeBuddy 的插件加载器**只识别、不加载到运行时** —— 从加载器返回的组件形状里
可以看到它只有 8 类：

```
agents / commands / skills / hooks / mcpServers / lspServers / outputStyles
/ settings{ agent, subagentStatusLine }
```

`themes` 不在其中。

## 所以

- 想改配色 → 用宿主自己的主题设置，插件管不了
- 要做跨 Claude Code / CodeBuddy 的插件 → 可以放 `themes/dracula.json`，
  在 Claude Code 下生效，在 CodeBuddy 下被忽略（不会报错）

repo-guard 是护栏插件，不碰配色。这个目录永久留空。
