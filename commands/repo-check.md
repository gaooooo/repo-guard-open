---
description: 仓库体检：超长文件、循环依赖、工程配置缺口
---

在仓库根跑 `atlas scan`（code-atlas 提供，也可用 `repo-guard scan` 转调；没装就提示我 `npm i -g @tencent/code-atlas`），然后用中文汇报：

1. 超过行数上限的文件有几个、最大的是哪个
2. 循环依赖有几处
3. 针对最严重的两三项，给出具体可执行的下一步

如果结果显示 `configured=false` 之类的提示，**先说清楚本仓还没配齐规则**，不要把"没命中"说成"没问题"。
