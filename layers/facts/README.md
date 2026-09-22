# 工程事实

只写代码读不出来、但每次必须看见的短句。

- 常驻 → CODEBUDDY.md
- 按路径 → .codebuddy/rules/*.md
- repo-facts.defaults.json → init 部门默认（公共层 / 行数上限）
- facts.json → SessionStart 机器侧注入（使命、禁忌、任务路由）

`stopConditions` 也写在 facts.json 里，**语义属于人审软名单**（何时问人），不是工程事实，也不是红线。新写放这里；旧 redlines.json 的 stop_conditions 仍会合并注入。

组件库包名、设计稿/token 路径也是事实。组件怎么用见 [`docs/COMPONENT-SPEC.md`](../../docs/COMPONENT-SPEC.md)；页面怎么落地见 [`docs/UI-SPEC.md`](../../docs/UI-SPEC.md)。

init（layers init / guard init / init --write --all）按本仓目录生成项目层 .codebuddy/facts.json：
- 不拷本目录这份模板
- taskRoutes.required 只含真实存在的路径
- 仓库 docs/ 为空时不会写 docs/*.md
- 已存在的 facts.json 不覆盖

