# 合并门禁（非 ReAct）

介绍见 [`docs/MERGE-GATES.md`](../../docs/MERGE-GATES.md)。

非 ReAct 旁路，卡的是进主干。工程侧：lint + pre-commit + CI + CODEOWNERS。Agent 侧：插件只给 `permissions.ask` 片段。强制不了宿主权限，也替不了 CI。不要写进 Stop hook。
