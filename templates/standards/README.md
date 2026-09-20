# templates/standards/ —— 五端研发规范标准模板

这是**全局层**（部门规范）。跟着插件版本走，改这里等于定制你们自己的部门模板。

规范内容清单见 [`docs/STANDARDS.md`](../../docs/STANDARDS.md)，落点机制见 [`docs/CONTROL-POINTS.md` §14](../../docs/CONTROL-POINTS.md)。

## 两层

```
templates/standards/              ← 全局层：所有项目的默认基线（本目录）
        ↓  repo-guard standards init --write
<你的仓库>/.codebuddy/standards/   ← 项目层：覆盖 / 关闭 / 新增，要进 git
```

合并 key 是条目的 **`id`**，不是文件名。项目层三种操作：

| 操作 | 写法 |
| :--- | :--- |
| 覆盖 | 同 id，**字段级浅合并** —— 只写要改的字段，其余继承全局层 |
| 关闭 | `{ "id": "FE-UI-001", "enabled": false, "override_reason": "本仓用设计系统托管颜色" }` |
| 新增 | 用 `PRJ-` 前缀的新 id，避免与未来版本的内置 id 撞 |

**放宽必须留痕。** 降低强度或关闭条目时必须写 `override_reason`，否则该 override 被忽略、仍按全局强度执行，并在 `standards audit` 里报 warn。

选「允许放宽但留痕」而不是「禁止放宽」：这是单机插件，没有企业策略层能兜住硬禁止。硬禁止的唯一后果是人把整个目录删掉 —— 那时连留痕都没了。

## 硬约束：默认零拦截

`standards.json` 的 `maxSeverity` 默认 `remind` —— **所有 ask/block 条目自动降级为提醒**。

> 一个装完就开始拦人的护栏插件，人的第一反应是卸载。
> 先看 `repo-guard governance` 的误伤率数据，再逐档上调。

唯一例外是公共层写前守卫（`CM-LAYER-002`）：它是插件的核心功能，由 `.codebuddy/repo-facts.json` 的 `publicLayer` 驱动，不受这里的开关控制。

## 硬约束：项目层不存在 = 零行为变化

全局层（本目录）**装上插件就存在**，所以它不驱动任何运行时行为 —— 否则所有人一升级插件就被迫接受一堆新注入。

| 场景 | 运行时（注入 / 提醒 / 拦截） | CLI（`standards list` / `check`） |
| :--- | :--- | :--- |
| 只有全局层 | **什么都不做** | 正常工作，可用于自查 |
| 铺了项目层 | 生效 | 正常工作 |

所以 `standards init --write` 那一步不是可选的装饰——**它才是让规范真正生效的开关**。

## 规范在什么时机生效

| 时机（`timing`） | 挂在哪 | 给什么 |
| :--- | :--- | :--- |
| `session_start` | `SessionStart` | 只给 `title` 列表 —— 让模型知道有这些约束 |
| `post_compact` | `PostCompact` | 同上，压缩后补注 |
| `prompt_submit` | `UserPromptSubmit` | 按 `tags` 命中，给**完整正文** |
| `post_write` | `PostToolUse` | 写完后的 `remind` 级提醒，带行号证据 |
| `pre_write` | `PreToolUse` | `block` / `ask` 判定 |
| `stop` | `Stop` | 交付前的证据检查 |

**注入面只给 title、正文留到命中时给**，是因为 45 条规范的正文远超 1500 token 的段预算。一份 3000 token 的「重要约束」里没有哪一条是重要的。

## 文件 = 端 = 注入单元

| 文件 | 端 | 默认启用 |
| :--- | :--- | :--- |
| `standards.json` | 总闸：`enabled` / `maxSeverity` / `stacks` / `stackDetect` | — |
| `l0-contract.json` | L0 跨端契约 | `on` |
| `common.json` | 全端共用 | `on` |
| `frontend-web.json` | 前端 Web / React | `auto` |
| `backend-service.json` | 后端 Go / Node / Java | `auto` |
| `database.json` | 数据库 | `auto` |
| `message-queue.json` | 消息队列 | `auto` |

按**端**切文件而不是按机制切：注入面每段 1500 token，五端全量必然撑爆，唯一可行的裁剪维度就是「当前改动落在哪个端」，所以文件即注入单元。按机制切会把一条规范撕到三处，改一条动三个文件。

⚠️ **前端仓必须把 `database` 与 `message-queue` 设为 `off`。**「字段」一词在前端指接口出入参、在数据库那边指 schema —— 同一句话触发两套门禁，结果是前端改个接口被要求写 migration。这是真实踩过的坑，见 `FE-SKIP-001`。

## 条目字段

| 字段 | 必填 | 说明 |
| :--- | :--- | :--- |
| `id` | ✅ | 合并 key。前缀即端：`L0-` `CM-` `FE-` `BE-` `DB-` `MQ-` `PRJ-` |
| `title` | ✅ | 一行标题。注入面只注 title，正文留到命中时才给 |
| `body` | ✅ | 给模型看的正文。**注入文案与拒绝文案共用同一份**，不写两套 |
| `why` | | 为什么有这条。给人看的，不注入 |
| `paths` | block 级必填 | 适用路径 glob。`__PUBLIC_LAYER__` 占位符会展开为 `repo-facts.publicLayer` |
| `excludePaths` | | 排除路径。测试、mock、stories 通常要排 |
| `timing` | ✅ | `session_start` / `prompt_submit` / `pre_write` / `pre_bash` / `post_write` / `stop` / `post_compact` |
| `severity` | ✅ | `inject` / `remind` / `ask` / `block`，受 `maxSeverity` 压制 |
| `check` | ✅ | 判定方式，见下 |
| `landing` | ✅ | `plugin` / `lint` / `ci` / `permissions` / `human`。**没有 plugin 就是插件不假装能拦** |
| `hint` | block/ask 级建议填 | 被拦时的下一步。缺了模型会自己去找绕路 |
| `tags` | | 关键词，供 `prompt_submit` 按任务注入 |
| `enabled` | ✅ | 条目开关 |
| `confirmed` | | 人确认过判据吗。false 时 block 自动降级 remind |
| `override_reason` | 项目层放宽时必填 | 为什么放宽 |

### `check.kind` 六种

| kind | 判定 | 能 block 吗 |
| :--- | :--- | :--- |
| `none` | 不判定，只注入 | ❌ |
| `path_only` | 路径命中即触发 | ✅ |
| `protect_symbol` | 受保护标识符（`symbols[]`），走红线引擎的真 diff 判定 | ✅ |
| `content_regex` | 对写入内容跑正则（`patterns[]`） | ❌ **永不** |
| `require_tool` | 写之前必须先调过某个图谱工具（`tool`） | ✅ |
| `require_evidence` | 会话内必须出现过某类校验命令（`commands[]`） | ❌ |

**`content_regex` 永不 block**：正则判不出意图。「改断言」和「修正一个写错的断言」在文本层面一模一样，硬拦必然误伤。

### `block` 准入三条件

缺一即自动降级为 `remind`：

1. `paths` 非空 —— 全仓范围的硬拦一定误伤
2. `confirmed: true` —— 人确认过这条判据
3. `check.kind` ∈ {`protect_symbol`, `path_only`, `require_tool`}

## 为什么注释写在 `_` 字段里

JSON 不支持注释。三个选择：

| 方案 | 问题 |
| :--- | :--- |
| 改用 JSONC | 生态支持不一致，`JSON.parse` 直接崩 |
| 注释另写 .md | 必然失同步 —— 改配置的人不会同时改文档 |
| `_` 字段（选这个） | 注释和配置在同一个文件同一个位置，改不了一个忘另一个 |

加载时忽略所有以 `_` 开头的键。这也是 `templates/guard/` 的风格。

## 与 guard / repo-facts / redlines 的关系

四份配置各管一件事，都不迁移：

| 配置 | 管什么 |
| :--- | :--- |
| `.codebuddy/repo-facts.json` | **事实**：公共层目录、行数上限、组件库、分析器。从图谱推出来，人确认 |
| `.codebuddy/redlines.json` | **红线意图**：哪个符号不许怎么动。人手写，`protect_symbol` 的数据源 |
| `.codebuddy/guard/` | **七道门总闸与流程配置**：注入面、准入、循环、交付、复述 |
| `.codebuddy/standards/` | **研发规范**（本目录）：五端的标准、门禁、红线正文 |

standards 受 guard 的总闸约束：`L0_inject` 管注入面、`L1_admission` 管硬拦、`L5_delivery` 管 `require_evidence`。

## 落地顺序

```
1  独立 lint + 体量规则 + 进 CI           确定性规则有了硬落点
2  pre-commit + 契约标识符 CI 断言         脏代码进不了主干
3  repo-guard init --write                确认公共层
   repo-guard standards init --write      铺规范（inject / remind 生效）
4  逐条开 ask / block                     每开一条先看 governance 的数据
```

**不要跳到第 4 步。** 所有 `ask` / `block` 条目模板里默认 `enabled: false` 或被 `maxSeverity` 压着，这是刻意的。
