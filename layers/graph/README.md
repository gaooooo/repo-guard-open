# 图谱

本层引用外部 code-atlas 工具包，不实现图谱算法。接入、初始化和开发者调用见 [docs/GRAPH.md](../../docs/GRAPH.md)。

开发者通过 `repo-guard atlas bind` 一次绑定；`repo-guard init --write` 准备本仓图谱，已安装/已建图则复用。CLI、MCP、Hook 使用同一绑定，查询回执由 Atlas 产生。红线和门禁策略本轮不改。
