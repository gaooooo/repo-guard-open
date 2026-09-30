---
description: 打开本仓的图谱体检页与沙盘（健康度、复杂度，以及在图上模拟 impact / similar / trace / 写入守卫）
argument-hint: "[static]"
---

在本仓根目录启动 repo-guard 的图谱可视化。

- 参数为 `static` 时：执行 `node "${CODEBUDDY_PLUGIN_ROOT}/bin/repo-guard" viz`，生成静态页，把输出里的 `index.html` 路径告诉我。
- 否则：在**后台**执行 `node "${CODEBUDDY_PLUGIN_ROOT}/bin/repo-guard" viz --serve`（它会一直运行，不要等它退出），读到第一行里的 `http://127.0.0.1:<端口>/` 后告诉我地址。

然后用中文简要汇报输出里的可信度结论。可信度为 low 时要明确提醒我：这张图上的影响面结论会少报，不能当成"没有影响"。

不要自己去读页面内容，也不要在沙盘里替我点任何东西 —— 沙盘是给人看的。
