# 人审说明

人审回答的是：**什么时候把决定权交回人。**

不是过程门禁（那是手续/冻结），不是红线（那是数符号）。引擎也不会识别「意图清不清」。

分两半，时刻不同、硬度不同。

---

## 一句话

收不成 `protects` 的「这时该问人」→ 写软名单，开场注入，靠自觉。
红线已经命中、想问人破不破例 → 打开硬开关，弹权限框。
合入主干 / `git commit` / 生产写 → 不是这一层，是合并门禁的宿主 `permissions.ask`。

---

## 两半

| | 软名单 | 硬开关 |
|---|---|---|
| 文件 | `.codebuddy/facts.json` 的 `stopConditions` | `.codebuddy/human-review.json` |
| 铺法 | `repo-guard guard init --write`（拷 facts.json） | `repo-guard layers init --write` |
| 时刻 | T4 SessionStart / PostCompact 注入 | T7b `permissionDecision: ask` |
| 拦工具吗 | 不拦。模型听了会停，不听照样 Write | 弹窗，人点允许/拒绝。模型在这一步已经停了 |
| 默认 | 模板里是示例句，人改成本仓场景 | `enabled: false`，红线仍 deny |

旧 `redlines.json` 里的 `stop_conditions` 注入时仍会合并进来；新写不要放红线文件。

---

## 软名单写什么

一句话一条，宜少（和禁忌、章程挤同一段注入预算）。

该写：

- 需求有两种合理解读时停下来问人，不要自己选一个继续做
- 要改已发布接口的语义（字段名没变、含义变了）时先问人
- 不可逆操作（删表、全量更新、无回滚）时先问人
- 发现需求和实现矛盾时停下来

不该写：

- 能点名的符号（那是红线 `protects`）
- 「改公共层先查 impact」（过程门禁已经硬拦）
- `git commit` / 生产 kubectl（合并门禁 · Agent 侧）

---

## 硬开关干什么

```json
{ "enabled": true, "onRedline": "ask" }
```

打开后：红线命中（`kind === redline`）从 deny 改成 ask，拒绝文案仍带 `reason` 和真 diff 证据。

`onRedline: deny` 或文件不存在 = 和以前一样直接拒绝。

**仍然直接 deny、不问：**

- 未查公共层 impact（手续）
- 循环失控（卡住了）
- 禁改清单（冻结）

规范编译出来的 `STD-` 红线命中时，当前实现也会走 ask（同样 `kind === redline`）。禁改不会。

`violation_action: stop_and_ask` 只是历史字段名，**判定 ask/deny 时不读它**。

---

## 和「意图不清 → 人审」

介绍里那句容易理解成：机器发现自己拿不准，自动弹窗。

实际没有这个分类器。真 diff 次数变少就是命中（证据硬）；没有符号可数就走不到 T7b。
「意图不清」只能写进软名单，靠模型自觉。

---

## 怎么配

1. 软：改 `.codebuddy/facts.json` 的 `stopConditions`，删掉【示例】或换成真场景
2. 硬：`.codebuddy/human-review.json` 设 `enabled: true`（先要红线能命中，即 `admission` 已开、`protects` 写了）
3. 合入/生产：把 `layers/merge-gates/permissions.ask.example.json` 贴进宿主配置，不要写进人审 JSON

