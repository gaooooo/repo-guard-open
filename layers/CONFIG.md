# 配置总索引

> 解压这个包之后先读这一页。它列全了**两层**里所有可以填的地方。

## 先搞清楚两层是什么

```
layers/                        ← 全局层：你（部门）按七类填这里
    ↓  分发给各项目
<项目仓>/.codebuddy/            ← 项目层：各项目自己填，进各自的 git
```

**两层之间有两种完全不同的生效机制，搞混会导致「填了没生效」：**

| 机制 | 谁用 | 全局层的角色 | 升级插件包时 |
| :--- | :--- | :--- | :--- |
| **运行时合并** | `skills/standards/` | 运行时**直接被读**，与项目层按条目 `id` 字段级合并 | 项目自动拿到新条目 |
| **一次性拷贝** | redlines / process-gates / facts | 只是**模板**，靠 `init` 命令拷过去，之后运行时只读项目层 | 项目**不会**自动拿到新内容 |

为什么不统一：规范是"部门基线 + 项目微调"，天然要合并；红线是"人写的意图，要进 git、过 review、能被 `audit` 验完整性"，必须是项目自己那一份。

---

## 全局层 · 你要填的地方

| 文件 | 填什么 | 不填会怎样 | 机制 |
| :--- | :--- | :--- | :--- |
| `skills/standards/standards.json` | 总闸、各端开关、端探测规则、注入预算 | 总闸开、强度压在 `remind`、各端 `auto` 探测 | 合并 |
| `skills/standards/<端>.json` | 该端的规范条目 | 出厂 56 条 | 合并 |
| `skills/standards/<端>/*.json` | 同上，条目多时的**分片** | — | 合并 |
| `redlines/redlines.json` | 部门通用红线（跨项目都成立的那些） | `rules: []`，不拦任何东西 | 拷贝 |
| `facts/repo-facts.defaults.json` | 行数上限、组件库包名、公共层惯例 | 500 / null / 空 | 拷贝 |
| `process-gates/**` | 协作七道门的阈值 | **全部默认关** | 拷贝 |
| 仓库根 `skills/**` | 长篇正文（规范的"怎么做"部分） | 出厂 3 个 | 渐进披露 |
| 仓库根 `hooks/hooks.json` | 钩子挂载点 | 9 个已挂、15 个留空占位 | 直接生效 |

### 六个端各是一个文件

| 文件 | 端 | 默认 |
| :--- | :--- | :--- |
| `l0-contract.json` | L0 跨端契约 | `on` |
| `common.json` | 全端共用 | `on` |
| `frontend-web.json` | 前端 Web / React | `auto` |
| `backend-service.json` | 后端 Go / Node / Java | `auto` |
| `database.json` | 数据库 | `auto` |
| `message-queue.json` | 消息队列 | `auto` |

**条目多了就分片**：建一个与端同名的目录，文件名对齐规范来源。两种形态并存，单文件先读。

```
standards/
├── backend-service.json          ← 继续放着，照常生效
└── backend-service/              ← 分片，文件名想叫什么叫什么
    ├── _填空指南.json             ← _ 开头的不会被加载，可以放说明
    ├── api-contract.json
    └── resilience.json
```

分片目录内**同一个 id 出现两次**时保留先出现的（按文件名排序），并在 `doctor` 里报出来。

条目的完整字段表、`check.kind` 六种判据、`block` 准入三条件 → 见 [`standards/README.md`](standards/README.md)。

---

## 项目层 · 各项目自己填

四份配置各管一件事，由四条对称的命令铺过去：

| 命令 | 生成 | 管什么 |
| :--- | :--- | :--- |
| `repo-guard init --write` | `.codebuddy/repo-facts.json` | **事实**：公共层目录、行数上限 |
| `repo-guard redlines init --write` | `.codebuddy/redlines.json` | **红线**：哪个符号不许少（protects+paths）。意图不清写 facts.json 的 stopConditions |
| `repo-guard guard init --write` | `.codebuddy/guard/` | **七道门**总闸与阈值 |
| `repo-guard standards init --write` | `.codebuddy/standards/` | **规范**的项目层覆盖 |

**都默认不写**，加 `--write` 才落盘；**已存在的文件一律不覆盖**。

项目层覆盖规范的三种写法：

| 操作 | 写法 |
| :--- | :--- |
| 覆盖 | 同 `id`，只写要改的字段，其余继承全局层 |
| 关闭 | `{ "id": "FE-UI-001", "enabled": false, "override_reason": "本仓用设计系统托管颜色" }` |
| 新增 | 用 `PRJ-` 前缀的新 id |

---

## 你能限定项目层改到什么程度

在全局层的条目上写 `override_policy`：

| 值 | 项目层能做什么 |
| :--- | :--- |
| `free`（缺省） | 放宽要写 `override_reason`，否则放宽被忽略 |
| `reason-required` | **任何**修改都要写 `override_reason` |
| `locked` | 放宽一律拒绝（写了理由也不行），`doctor` 报 error；**收紧仍然允许** |

```json
{ "id": "CM-SEC-001", "override_policy": "locked" }
```

`locked` 不是物理锁死 —— 项目层的人可以删掉整个 `.codebuddy/standards/`。它能做到的是**让放宽留下痕迹**（`doctor` 退出码非零，可以挂 CI）。硬禁止的唯一后果是人绕过整个机制。

---

## 填完怎么验

按这个顺序，每一步都不需要 `npm`：

```bash
bin/repo-guard doctor          # ① 配置体检：JSON 坏没坏、条目会不会静默失效、注入配额还剩多少
node bin/verify-hooks.mjs      # ② 59 条钩子回归：确认你填的红线没把正常写文件也拦了
bin/repo-guard standards list  # ③ 生效清单：哪些端、哪一层、实际强度
bin/repo-guard audit           # ④ 红线体检（需要项目层有 redlines.json）
```

**① 和 ② 是发包前必须跑的。**

`doctor` 会告诉你四类只有填配置时才会犯的错：

| 它报什么 | 意思 |
| :--- | :--- |
| JSON 语法错误 | 运行时会**静默**跳过这个文件（整个读配置链路都是 fail-safe 的），只有这里能看见 |
| 僵尸条目 | `check.kind` 与 `timing` 的组合永远不会输出。出厂模板里曾有 5 条这样的 |
| 注入配额 | `session_start` 超 1500 token 会**按行前缀截断**，排在后面的端整批消失 |
| id 前缀与端不符 | 复制条目忘了改 id，它会被分到另一个端的注入分组里 |

---

## 三条别踩的线

**① 出厂的 `repo-facts.defaults.json` 不要在本仓改。**
本仓有 5 条逐字节比对用例守着 `init --write` 的落盘内容。你在**自己部门的包**里改是预期用法；在插件源码仓里改会让回归全红。

**② 不要往 `componentLibrary` 里放"已知组件库识别表"。**
测试仓里就有 `antd`，一旦能识别出来，`lib-search` 的输出变化会被已登记的偏差掩盖 —— 你会拿到一个绿的回归和一个真实的 bug。

**③ 前端仓必须把 `database` 与 `message-queue` 设成 `off`。**
「字段」一词在前端指接口出入参、在数据库那边指 schema。两套门禁同时触发，结果是前端改个接口被要求写 migration。

---

## 为什么注释写在 `_` 开头的键里

JSON 不支持注释。三个选择里选了这个：

| 方案 | 问题 |
| :--- | :--- |
| 改用 JSONC | 生态支持不一致，`JSON.parse` 直接崩 |
| 注释另写 `.md` | 必然失同步 —— 改配置的人不会同时改文档 |
| `_` 字段（选这个） | 注释和配置同文件同位置，改不了一个忘另一个 |

加载时忽略所有 `_` 开头的键，分片目录里 `_` 开头的**文件**也不会被加载。

---

## 两条铁律（改配置时请一直记着）

**① 项目层不存在 = 零行为变化。**
全局层装上插件就存在。如果它能驱动运行时行为，所有人一升级插件就被迫接受一堆新输出。所以 `standards` 的每个运行时入口都先检查项目层在不在 —— 没铺项目层的仓库，规范只用于 `standards check` 这类人主动跑的命令。

**② 默认零拦截。**
`maxSeverity` 出厂 `remind`，所有 `ask`/`block` 条目自动降级为提醒。想开硬拦，先让项目跑一段时间 `repo-guard governance` 看误伤数据，再逐档上调。

> 一个装完就开始拦人的护栏插件，人的第一反应是卸载。
