# .codebuddy 配置说明

这是本仓给 AI 用的控制面。按七类分文件，先看本页再改 JSON。
以下划线开头的键（如 **_**）是说明，加载时忽略。

**默认几乎不拦**：只有「公共层已有文件、本轮没查 impact」会拒绝。
规范默认只提醒。示例条目默认 confirmed/enabled 为 false，不会硬拦。

## 文件一览

| 文件 | 七类 | 必填？ | 空着会怎样 |
|---|---|---|---|
| （仓库根）CODEBUDDY.md | 工程事实 | 建议有 | 没有短事实可注入；本仓已生成骨架 |
| README.md | — | 本说明 | — |
| repo-facts.json | 工程事实 / 图谱 | 要生效就必须有 | 公共层守卫不拦，并提示未配置 |
| facts.json | 工程事实 | 可选 | 不注入使命/禁忌/任务路由 |
| redlines.json | 红线 | 可选 | rules 为空不拦任何符号 |
| process-gates.json | 过程门禁 | 可选 | 额外门全关；公共层 impact 仍由 repo-facts 驱动 |
| human-review.json | 人审 | 可选 | 没有或 enabled=false：红线仍直接拒绝 |
| standards.json | 技能库·规范总闸 | 可选 | 没有则规范不参与运行时（插件全局条目不生效） |
| merge-gates.example.json | 合并门禁 | 示例 | 不会自动生效，需贴到 CI / 宿主 permissions |
| standards/（目录） | 规范覆盖 | 一般不建 | 只在要覆盖某条插件规范时再建 |

---

## 1. 仓库根 CODEBUDDY.md（工程事实·给人看的短句）

宿主会话开始会整份注入。只写短事实，不写长步骤。

| 建议写 | 不要写 |
|---|---|
| 公共层以 repo-facts.json 为准 | 把整本架构文档贴进来 |
| 权威契约/设计稿的路径 | 符号禁令（应写红线） |
| 本仓组件库包名 | 「必须先查 impact」（过程门禁已硬拦） |

---

## 2. repo-facts.json（公共层清单）

init 根据图谱推测生成。**必须人过一眼**，猜错会漏拦或误伤。

| 字段 | 类型 | 说明 |
|---|---|---|
| version | 数字 | 格式版本，保持 1 |
| analyzer | 字符串 | 图谱分析器：web-frontend / go-trpc / node-babel 等，init 填写 |
| publicLayer | 字符串数组 | 公共层目录前缀。改这些目录下**已有**文件前必须先查 impact |
| componentLibrary | 字符串或 null | 内部 UI 组件库包名。`guard init` 会从 package.json 识别（如 @tencent/tea-component）；Go 仓为 null |
| componentMcp | 字符串或 null | 组件文档 MCP 在宿主里的注册名。Tea 默认 garden-mcp-component。写组件前注入「去查这个 MCP」 |
| lineLimit | 数字 | 单文件行数上限，超过只提醒不拒绝，默认 500 |
| generatedAt | 字符串 | init 生成时间，可忽略 |

改法：核对 publicLayer。前端再核对 componentLibrary / componentMcp（MCP 名必须和宿主里实际注册名一致）。后端常见 publicLayer 为 internal/pkg/、pkg/。

---

## 3. facts.json（工程事实·机器侧）

长句仍写 CODEBUDDY.md。这里给钩子用的结构化条目。

| 字段 | 类型 | 说明 |
|---|---|---|
| mission | 字符串 | 一两句话：这个服务是干什么的 |
| facts | 字符串数组 | 代码里读不出来的事实，会话开始注入 |
| discipline | 字符串数组 | 常驻纪律，条数宜少（最贵的几条） |
| knowledge | 对象数组 | 项目知识。enabled 必须为 true 才注入 |
| knowledge[].id | 字符串 | 稳定编号，如 PK-001 |
| knowledge[].topic | 字符串 | 短标题 |
| knowledge[].content | 字符串 | 正文 |
| knowledge[].enabled | 布尔 | false 时当草稿，不注入 |
| taboos | 字符串数组 | 团队禁忌，只注入不硬拦（意图型，硬拦会误伤） |
| stopConditions | 字符串数组 | 人审软名单：收不成符号的「这时问人」（T4 注入，靠自觉）。不是红线 |
| taskRoutes | 对象 | 按用户原话关键词注入「去读这些文件」 |
| taskRoutes.<名>.match | 字符串数组 | 命中任一关键词即走该路由 |
| taskRoutes.<名>.required | 字符串数组 | 必读文件路径，不是文件内容 |
| taskRoutes.<名>.hard_gate | 字符串 | 命中后附加的硬说明 |
| taskRoutes.<名>.enabled | 布尔 | 必须 true 才生效 |

init 按本仓目录生成：facts/knowledge 写真实分层；taskRoutes.required 只含存在的路径，默认 enabled=true。请人改 mission。已存在的 facts.json 不会被覆盖。

---

## 4. redlines.json（红线）

人写的符号锁：哪个标识符在哪些路径里不许少。空数组不拦。没有 protects 等于一句 prompt，拦不住。
「意图不清」不要写在这里，写 facts.json 的 stopConditions。

| 字段 | 类型 | 说明 |
|---|---|---|
| rules | 数组 | 红线列表 |
| rules[].id | 字符串 | 稳定编号，如 RL-001，拦截文案会引用 |
| rules[].rule | 字符串 | 给模型看的一句话：禁止什么 |
| rules[].reason | 字符串 | 为什么（静态分析推不出来的那部分） |
| rules[].protects | 字符串数组 | 受保护标识符。写工具 before 有、after 无 = 在删它 |
| rules[].paths | 字符串数组 | glob。必须写全，漏掉的路径是后门 |
| rules[].violation_action | 字符串 | 建议 stop_and_ask |
| rules[].confirmed | 布尔 | 必须 true 才硬拦；示例为 false |

配完请跑：repo-guard audit（守空气 / 后门 / 行号）。

---

## 5. process-gates.json（过程门禁）

ReAct 内的机器开关。改公共层 impact **不在此文件**，由 repo-facts.publicLayer 驱动。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| inject | 布尔 | true | 是否注入 facts.json / 章程类内容（只推不拦） |
| admission | 布尔 | false | 总闸。false 时禁改/范围/新建图谱强制全不生效 |
| loop | 对象或布尔 | 关 | 循环门 |
| loop.enabled | 布尔 | false | 是否启用循环拦截 |
| loop.repeatToolCallThreshold | 数字 | 3 | 同一调用重复几次后拦 |
| loop.consecutiveFailThreshold | 数字 | 3 | 连续失败几次后拦 |
| loop.sameFileWriteFailThreshold | 数字 | 2 | 同文件写失败几次后拦 |
| signals | 布尔 | false | 会话收尾诚实信号，纯观测 |
| delivery | 对象 | 关 | 交付提醒（不硬拦 git commit） |
| delivery.enabled | 布尔 | false | 是否在 Stop 时提醒 |
| delivery.engineeringCheck | 字符串 | warn | warn 只提醒；block 会阻止停止（需同时 enabled） |
| delivery.maxDeliveryFiles | 数字或 null | null | 单次交付改动文件数上限 |
| governance | 布尔 | true | 本机埋点，不进 git |
| noRefactor | 数组 | [] | 整文件/目录冻结。confirmed=false 不当硬拦 |
| noRefactor[].path | 字符串 | | glob |
| noRefactor[].reason | 字符串 | | 必须写为什么冻 |
| noRefactor[].confirmed | 布尔 | | 要硬拦必须 true，且 admission 为 true |
| scope | 对象 | 关 | 范围门 |
| scope.enabled | 布尔 | false | 是否限制可写路径/文件数 |
| scope.allowlist | 字符串数组 | [] | 只允许写这些前缀，空=不限 |
| scope.maxFiles | 数字或 null | null | 单会话不同文件数上限 |
| newPageSimilar | 对象 | 关 | 新建页/接口前查 similar。`guard init` 按本仓目录填 pathPatterns；enabled 默认 false，硬拦还要 admission |
| newComponentHot | 对象 | 关 | 新建公共模块/组件前查 hot。同样由 init 填 pathPatterns |
| newComponentLibSearch | 对象 | 关 | 新建 UI 组件前查 lib_search。无组件目录则为空。硬拦后仍要再查 componentMcp 文档 |
| review | 对象 | 关 | AI 审查，建议手动 --agent，不要每次 Stop 都跑 |

要让禁改清单生效：admission=true 且条目 confirmed=true。

---

## 6. human-review.json（人审）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| enabled | 布尔 | false | false：红线命中仍 deny。true：按 onRedline 处理 |
| onRedline | 字符串 | ask | ask=宿主弹确认；deny=仍直接拒绝 |

未查 impact、循环失控、禁改清单即使人审打开也仍是否决（手续/冻结，不是「问人要不要改这个符号」）。

---

## 7. standards.json（规范总闸）

条目正文在插件全局层，这里只改开关。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| enabled | 布尔 | true | 总闸。false 整套规范不参与运行时 |
| maxSeverity | 字符串 | remind | inject / remind / ask / block。默认 remind=只提醒不拦 |
| stacks | 对象 | 见文件 | 各端 on / off / auto |
| stacks.l0-contract | | on | 跨端契约 |
| stacks.common | | on | 全端共用 |
| stacks.frontend-web | | auto | 前端 |
| stacks.backend-service | | auto | 后端 |
| stacks.database | | auto | 库。纯前端请设 off |
| stacks.message-queue | | auto | 队列。纯前端请设 off |
| injectBudgetTokens | 数字 | 1500 | 注入面每段上限 |
| stackDetect | 对象 | 见文件 | auto 时用来猜本仓有哪些端 |

覆盖某一条：建 .codebuddy/standards/xxx.json，写同 id，放宽必须带 override_reason。

---

## 8. merge-gates.example.json（合并门禁示例）

**不会自动生效。** 合入主干靠 CI 跑 lint / 测试 / repo-guard scan。
本文件是宿主 permissions.ask 的示例，请按需贴到项目或个人 settings。

| 字段 | 说明 |
|---|---|
| permissions.ask | 数组，匹配到这些工具调用时先问人 |

---

## 开发者最小操作

1. 核对 repo-facts.json 的 publicLayer
2. 改仓库根 CODEBUDDY.md 的短事实
3. 核对 facts.json 的 mission，按需改 knowledge / taskRoutes；redlines.json 里的【示例】改成本仓或删掉
4. 需要硬拦再把对应 confirmed/enabled 改为 true，并打开 process-gates.admission
