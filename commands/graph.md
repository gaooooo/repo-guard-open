---
description: 打开图谱可视化页（code-atlas：多仓调用关系、接口连线、健康度）
---

在本仓根目录执行 `repo-guard atlas viz --open`（code-atlas 提供；没装就提示我 `npm i -g @tencent/code-atlas`），把输出里的页面路径告诉我。

如果本仓还不在 code-atlas 工作区（输出提示先 `repo-guard atlas add`），先执行 `repo-guard init --write` 再重试；多个工作区用 `--ws` 指定，不创建另一套图谱。

不要自己去读页面内容 —— 页面是给人看的。