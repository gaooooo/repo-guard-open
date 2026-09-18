# 这个目录是给「在本仓开发 repo-guard」用的

**它不是分发物的一部分，也不会影响装了这个插件的用户。**

## settings.local.json 是什么

```json
{
  "enableAllProjectMcpServers": true,
  "enabledMcpjsonServers": ["repo-guard"]
}
```

它让"在 repo-guard 仓库里开 CodeBuddy 会话"时，自动批准本仓 `.mcp.json` 里声明的
`repo-guard` MCP server —— 也就是**用自己的工具开发自己**。

## 为什么它不会误伤用户

`.codebuddy/settings.*.json` 是**工作区**配置，宿主按当前 cwd 往上找。
插件装到 `~/.codebuddy/plugins/cache/...` 之后那里不是任何人的工作区，
所以这个文件是惰性的。

宿主真正读的插件配置只有三处：`.codebuddy-plugin/plugin.json`、
插件根的 `settings.json`（只认 `agent` / `subagentStatusLine`）、
以及各组件目录。**不含 `.codebuddy/`。**

## 别在这里放什么

- 不要放 `permissions` —— 那会让"在本仓开发"的权限习惯和别处不一样，
  导致你写出的守卫在自己机器上表现和用户机器上不同
- 不要放 `hooks` —— 插件的钩子走 `hooks/hooks.json`。在这里再写一份会
  **双重触发**，而且只在开发机上双重触发，是很难查的一类假象

## 还有一个 .cache/

`.codebuddy/.cache/` 是 repo-guard 对**本仓自己**建的图谱缓存（本仓也是个 TS 仓库，
可以被自己分析）。已在 `.gitignore` 里。
