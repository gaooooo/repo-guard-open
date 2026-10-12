# 红线说明

红线回答一件事：**哪个符号，在哪些文件里，不许变少。**

它是人写进 git 的锁，不是 skill，也不是「意图不清就问人」。机器只数标识符出现次数，不理解「外部客户端会 404」这句人话——那句写在 `reason` 里，给人看、拦下来后给模型看。

项目文件：`.codebuddy/redlines.json`（`repo-guard redlines init --write` 从 `layers/redlines/redlines.json` 拷过去，已存在不覆盖）。不运行时合并：升级插件不会把新部门红线偷偷塞进已有仓库。

---

## 一句话

能点名「这个词不许删/改名」→ 写红线。说不清符号、只知道这时该问人 → 写 `facts.json` 的 `stopConditions`，不要写红线。

硬拦还要开过程门禁的 `admission`。只铺了 `redlines.json`、没开准入：开场会注入摘要，写入不会 deny。

---

## 和别的层怎么分

| 层    | 问的是      | 红线做不做                                                  |
| ---- | -------- | ------------------------------------------------------ |
| 工程事实 | 公共层在哪    | 不做。公共层 impact 是过程门禁核心                                  |
| 技能库  | 这类任务怎么做  | 不做。skill 拦不住 Write                                     |
| 过程门禁 | 查过没、转没转圈 | 红线判定挂在同一条写前链上，规则不写在门禁文件里                               |
| 人审   | 把决定权交回人  | 红线命中之后：默认 deny；`human-review.json` 打开改为 ask。引擎不判断「清不清」 |
| 图谱   | 谁在用这个文件  | 不做。影响面为 0 也不能代替红线                                      |
| 合并门禁 | 进主干过没过   | 不做                                                     |

---

## 一条红线长什么样

```json
{
  "id": "RL-001",
  "rule": "网关错误码字段 error_description 不许改名或删除",
  "reason": "已随 SDK 发布，线上多个版本的客户端在解析它，改名等于让对方 404",
  "protects": ["error_description"],
  "paths": ["internal/handler/**", "pkg/sdk/**"]
}
```

| 字段                 | 意思                                 | 缺了会怎样                                         |
| ------------------ | ---------------------------------- | --------------------------------------------- |
| `id`               | 稳定编号，拒绝文案里会引用                      | 这条被跳过                                         |
| `rule`             | 禁止什么（一句话）                          | 这条被跳过                                         |
| `protects`         | **锁**：要数的标识符（字段名 / 函数名 / 常量 / 错误码） | **拦不住**，只剩开场那句 prompt，和 skill 无异              |
| `paths`            | **锁在哪**：glob。漏写的路径就是后门             | 不写 = 全仓生效，容易误伤                                |
| `reason`           | **为什么**。静态分析推不出来的仓外事实              | 仍能拦，但人和模型不知道凭什么                               |
| `enabled`          | `false` 等于关掉这条、不删                  | 默认 true                                       |
| `evidence`         | `file:line`，给人核对                   | 不参与判定；漂了 `audit` 会说                           |
| `confirmed`        | 人是否确认过这条判据                         | **当前引擎不读**。模板写「false 不当硬拦」，实际上总闸是 `admission` |
| `violation_action` | 历史上叫 stop_and_ask                  | **当前不决定 ask/deny**。问人看 `human-review.json`    |

不要把 `rule` / `reason` 里的中文当成锁。仓里叫 `error_description`，你写成「错误描述」，等于没锁。

旧模板还可能带 `no_refactor`、`stop_conditions`：禁改清单已归过程门禁；停止条件新写请放 `facts.json`（旧字段注入时仍会合并进来）。

---

## 怎么拦

宿主在 Write / Edit / MultiEdit 落盘前打 `PreToolUse` → `hook pre-write`。

1. 读磁盘 **before**
2. 把这次编辑应用到 before，得到精确 **after**（所以增量 Edit 也能判，不只是全量覆盖写）
3. 词边界计数：`protects` 里某个词，before 出现 N 次、after 出现 M 次，N>0 且 M<N → 视为删除
4. 默认 `permissionDecision: deny`。人审打开且这次是红线命中（不是禁改）→ `ask`

同一文件只加注释、次数没少 → 放行。

有真 diff 时**忽略**从命令文本猜的「意图正则」（否则代码里的箭头函数会被当成 shell 重定向）。Bash 钩子**不跑**红线引擎，只提醒像不像在用 shell 写公共层。

SessionStart 会推红线摘要（只给 id 和 `rule`），正文在命中时才给。注入不是硬拦。

---

## 拦不住什么

- 没有 `protects`
- 字段名没变、语义变了
- 只增字段、不删旧名
- `paths` 没盖到的文件（后门）
- 没开 `admission`
- Bash / sed 原地改写绕过写工具
- 「需求两种读法，先别动手」——那是 `stopConditions`

---

## audit：验锁，不验那句中文

`repo-guard audit`（或 MCP `audit`）扫的是红线文件自己有没有烂。人工 review 判断「该不该加」，验不了指针。

| 检查   | 含义                           |
| ---- | ---------------------------- |
| 守空气  | `protects` 的符号在代码/SQL 里已经找不到 |
| 后门   | 符号还出现在声明 `paths` 之外，那边改名不会被拦 |
| 证据失准 | `evidence` 的行号漂了（不影响判定）      |
| 拦不住  | 没写 `protects`                |

覆盖度复用运行时同一套 glob，避免「体检说完整、运行时拦不住」。

---

## 怎么配

1. `repo-guard redlines init --write`
2. 把示例换成**本仓真实符号和路径**；空 `rules` 或只抄示例等于没锁
3. 进 git，跟代码走同一个 PR
4. `repo-guard audit`
5. 要硬拦：`process-gates.json` 里 `admission: true`
6. 命中后想问人而不是直接打死：再开 `.codebuddy/human-review.json`

部门模板只填跨项目都成立的符号。项目特有的由项目自己写。填错会拦住所有人——改完跑 `bin/verify-hooks.mjs`。

规范里 `severity: block` + `protect_symbol` 会编译成 `STD-` 开头的同一套锁，走 standards 自己的闸，不要求 `admission`。那是部门通用规范，不是本仓手写红线。
