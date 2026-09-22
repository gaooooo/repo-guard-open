# layers/ — 作者面（七类 + 机器 JSON）

加人、加规范、改部门模板，只改这里。不要在 src/hooks 里新开一类。
部门填数见 CONFIG.md。

| 目录 | 分类 | 给人看的 | 机器 JSON |
|---|---|---|---|
| facts/ | 工程事实 | CODEBUDDY.snippet.md、rules/ | facts.json（含 stopConditions 注入打包）、repo-facts.defaults.json |
| skills/ | 技能库 | 正文在仓库根 skills/ | task-routes.json；skills/standards/ 五端规范 |
| redlines/ | 红线 | README | redlines.json（只写 rules / protects+paths+reason） |
| process-gates/ | 过程门禁 | README | process-gates.json |
| human-review/ | 人审 | README | ask.json（T7b 硬开关）；软名单在 facts.json stopConditions |
| merge-gates/ | 合并门禁 | README | permissions.ask.example.json（Agent 侧）；CI 片段（工程侧） |
| graph/ | 图谱 | 何时必须查图 | 引擎在 src/graph/ |

init 把 JSON 拷到项目 .codebuddy/（已存在不覆盖）。facts.json 例外：按本仓目录生成，不拷模板假路径。规范 standards 是运行时合并，其余是一次性拷贝。
汇报用规范大纲：七类规范-汇报稿.md（总表）+ 各层 SPEC.md。
来源是 references/ 的 00 门禁与 01～15 工程规范，按控制点切到七类，条款细写后续再补。
