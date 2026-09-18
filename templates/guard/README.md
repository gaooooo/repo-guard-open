# templates/guard/ —— 协作全景七道门配置骨架

这是**模板**，不是生效配置。

## 怎么生效

```
templates/guard/          （插件里，跟着版本走）
        ↓  repo-guard guard init --write   ← P4 实现，尚未接通
<你的仓库>/.codebuddy/guard/   （生效位置，要进 git）
```

铺过去之后要进 git —— 这些是团队共识，不是个人偏好。

## 硬约束：空配置 = 零行为变化

所有门的 `enabled` 缺省一律 `false`。装完插件不会有任何新的拦截。

> 一个装完就开始拦人的护栏插件，人的第一反应是卸载。
> 让人先看 `repo-guard governance` 的数据，再逐个打开。

唯一例外是 L0 注入面与 L6 留痕：前者只注入不拦，后者只写自己的文件，都没有误伤风险。

## 目录 = 协作全景的四层配置面

| 目录 | 语义 | 文件 |
|---|---|---|
| `identity/` | 身份：团队是谁 | `charter.json` `roles.json` |
| `capability/` | 能力：**授予**，加一项 agent 更能干 | `project-knowledge.json` `task-routes.json` |
| `constraint/` | 约束：**收回**，加一项 agent 更受限 | `taboos.json` `no-refactor.json` `stop-conditions.json` `scope-gate.json` |
| `process/` | 流程：活怎么进来、怎么收尾 | `graph-enforce.json` `loop.json` `delivery.json` `review.json` `restate.json` |

外加 `guard.json` 是七道门的总闸。

## 不在这里的两份配置

`.codebuddy/repo-facts.json`（公共层清单）和 `.codebuddy/redlines.json`（红线意图）
**保持原路径不动**。它们已经在用，挪位置会破坏现有安装。

## 为什么注释写在 JSON 的 `_` 字段里

JSON 不支持注释。三个选择：

| 方案 | 问题 |
|---|---|
| 改用 JSONC | 生态支持不一致，`JSON.parse` 直接崩 |
| 注释另写 .md | 必然失同步 —— 改配置的人不会同时改文档 |
| `_` 字段（选这个） | 注释和配置在同一个文件同一个位置，改不了一个忘另一个 |

这也是 deerclaw 自己 `allowlist.json` 的风格（那边叫 `_why`）。
加载时忽略所有以 `_` 开头的键。

## 当前实现状态

| 门 | 状态 |
|---|---|
| L0 注入面 | 部分：公共层清单已注入（`session-start` 钩子）；章程 / 项目知识 / 禁忌 / 必读待补充 |
| L1 准入门 | 部分：**公共层写前守卫已在跑**（核心功能）；红线三层判定引擎已移植但未接钩子；范围门待补充 |
| L2 执行门 | 交宿主，永久不做 |
| L3 循环门 | 待补充（前三项可做，迭代预算只能近似） |
| L4 诚实信号 | 待补充，纯观测 |
| L5 交付门 | 待补充，且默认只提醒 |
| L6 治理留痕 | **已在跑**，`repo-guard governance` 出报表 |
| 需求复述 | 待补充，默认关（这里比 deerclaw 保守，理由见 `process/restate.json`） |
