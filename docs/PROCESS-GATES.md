# 过程门禁说明

范围：**ReAct 内、机器拍板**。管的是这次写入的手续——查过没、改没改出范围、转没转圈、跑没跑过校验。

不是红线（不数 `protects`），不是人审（不问「这个符号能不能动」），也不是合并门禁（不代替 lint / CI / `git commit` 权限）。

项目文件：`.codebuddy/process-gates.json`（`repo-guard guard init --write` 从 `layers/process-gates/process-gates.json` 拷过去，已存在不覆盖）。

---

## 一句话

出厂只有一件硬事：**改公共层已有文件，本轮没查 impact → deny**。其余默认关，要开闸才上场。

---

## 和别的层怎么分

| 层 | 问的是 | 过程门禁做不做 |
|---|---|---|
| 工程事实 | 公共层在哪、行数上限 | 只用 `repo-facts.json` 的清单，不在这里填目录 |
| 红线 | 哪个符号不许少 | 判定挂在同一条写前链上，但规则写 `redlines.json`；`admission: false` 时不上膛 |
| 人审 | 何时把决定权交回人 | 不做。`stopConditions` 是 T4 注入；红线命中后的 ask 是 `human-review.json` |
| 图谱 | 影响面 / 同类 / 热点 | 门禁只要求「本轮查过没」，不在 hook 里建图 |
| 合并门禁 | 进主干前过没过 | 不做。Stop 不硬拦 `git commit` |

---

## 默认就在跑：公共层 impact

| | |
|---|---|
| 拦 | 文件在 `repo-facts.json` 的 `publicLayer` 下 **且已存在** **且** 本会话没查过该文件的 impact |
| 放 | 新建公共层文件；公共层之外；已经查过 impact 的同一文件；仓库外路径 |
| 开关 | **不受** `admission` 控制。没 `repo-facts.json` → 不拦，并明说守卫未生效 |
| 落点 | `PreToolUse` 写工具（Write / Edit / MultiEdit 等）→ `permissionDecision: deny` |
| Bash | 命令看起来像在用 shell 写公共层 → **只提醒不拦**（路径可能是变量拼的，硬拦误伤率不可接受） |

查过之后放行也记一笔，用来看这道门有没有在做有用功。

影响面为 0 ≠ 可以删。拒绝文案每次都堵这句，并给出 MCP / 斜杠命令 / CLI 绝对路径三种查法（只写 `impact` 模型会搜不到工具，改去 grep）。

---

## 写前判定链（`PreToolUse`）

按代价排序。模型已经卡住时，再让它去查影响面没有意义，所以循环在最前。

1. **循环门**（要开 `loop`）
2. **红线 / 禁改**（红线另见红线层；禁改要开 `admission`）
3. **范围门**（要开 `admission` + `scope.enabled`）
4. **新建文件的图谱强制**（要开 `admission` + 对应子开关，且人写了 `pathPatterns`）
5. **公共层守卫**（核心，不受 admission 控制）
6. **规范 `require_tool`**（要铺了项目层 standards；管核心守卫覆盖不到的新建 / 非公共层路径）

这一步只允许 deny / ask / 什么都不输出。提醒不挂在写前，否则每次正常写文件都变成干预。

异常一律 fail-open：hook 崩了等于没这道门，不能把人的写入弄失败。

---

## `process-gates.json` 里有什么

### 注入 `inject`（默认开，只推不拦）

SessionStart / PostCompact 推使命、禁忌、停止条件、红线摘要。  
UserPromptSubmit 按任务路由注入「去读这些文件」。

**禁止** `continue: false` 吃掉用户提问。内容来自 `facts.json`，不来自本文件的长文。

### 准入 `admission`（默认关）

打开之后，下面几项才可能硬拦。公共层 impact **不**靠这个开关。

#### 禁改 `noRefactor`

路径 glob 命中即 deny：「这段代码脏得有原因，先找人确认」。不问人。

模板里的示例带 `confirmed: false`。当前引擎**不读**这个字段，真正总闸是 `admission`。打开准入前先改成本仓真实路径，或把示例删掉。

#### 范围 `scope`

- `allowlist`：名单外的文件不让改（即使改得对，review 也不会预期看到）
- `maxFiles`：单会话涉及文件数上限。这是**失控探测器**（一次任务改到第 15 个文件通常意味着理解错了），不是为了省事。建议 10–20。已改过的文件不重复计数。

#### 新建图谱强制

只管**新建**文件；已存在的文件走 impact，不走这三条。

| 开关 | 要求本轮先查 |
|---|---|
| `newPageSimilar` | similar（前端：同类页；后端：同类 handler/接口） |
| `newComponentHot` | hot（仓内高扇入，别重造） |
| `newComponentLibSearch` | lib search（组件库有没有现成的） |

`repo-guard guard init --write` 会按本仓**已有目录**填 pathPatterns（前端 views/pages/components，后端 handler/logic/router 与 pkg/utils）。enabled 默认 false。硬拦还要打开 `admission` 和对应 enabled。人可以改 glob；已有非空 patterns 不会被覆盖。

「查过」按**会话 + 仓库**记，不按文件记：similar / hot / lib 回答的是「这类东西仓里怎么写」，查一次对整批新建都适用。按文件记是骚扰。不能拿 A 仓的查询放行 B 仓。

### 循环 `loop`（默认关）

捕捉失控，不是捕捉一次写错。

| 项 | 默认阈值 | 行为 |
|---|---|---|
| 同一调用指纹重复 | 3 | deny |
| 连续失败 | 3 | deny |
| 同文件写失败 | 2 | deny |
| 迭代预算 | 80 | **只观测**。插件拿不到宿主的 round 序号，Stop 上给摘要，不阻止停止 |

指纹取路径和命令，**不取文件内容**：改一个字再试一次是卡住时的典型动作，把内容算进指纹会永远到不了阈值。

阈值不要调到 2：第 1 次可能是笔误，第 2 次是没看懂报错，第 3 次才是出不来。

### 交付 `delivery`（默认关）

Stop 时看本轮有没有写文件、命令里像不像跑过校验。

- 改了文件但没跑 lint/test/build → **提醒**（默认不 deny）
- 同一会话同一句只提醒一次，防止 Stop 死循环
- `engineeringCheck: "block"` 才阻止停止，仍然不硬拦 `git commit`

证据是弱的：只看命令文本里有没有 `lint` / `test` / `build` / `tsc --noEmit` 这些词，**不能看过没过**。文案必须说清这一点。

真要拦提交：宿主 `permissions.ask` 配 `git commit` / `git push`（合并门禁 · Agent 侧）。

### 诚实信号 `signals`（默认关）

会话结束记一笔近似结论（写了没、失败没、跑过校验没）。插件看不到宿主内部的 success / max_iterations，报表上按近似读，不要当成平台那套 finalReason。

### 治理留痕 `governance`（默认开）

deny / ask 等事件写到 `$HOME` 下，**不进你的 git**。只观测。

### 审查 `review`（默认关）

预留：达到风险等级时拉审查 agent。不是合并门禁的 G-01～G-07。

---

## 明确不做

- 不预测、不代替 G-01～G-07
- hook 里不建图（写前只有十几秒预算；缓存 miss 就放行）
- 不把 lint 失败写成 Stop 硬拦
- 不把「意图不清」收成手续（写 `facts.json` 的 `stopConditions`）
- 不数标识符出现次数（那是红线）

---

## 怎么开

1. `repo-guard guard init --write` 铺 `.codebuddy/process-gates.json`（已存在不覆盖）
2. 先确认 `.codebuddy/repo-facts.json` 的 `publicLayer` 是人看过的
3. 需要硬拦红线 / 禁改 / 范围 / 新建强制时，把 `admission` 设为 `true`，再改对应子项
4. 循环、交付同样：先开总闸，再改阈值
5. `repo-guard guard show` 看实际生效；总闸关着时子项 `enabled: true` 也不生效

`verify-hooks` 里有一组「删掉过程门禁配置后，公共层守卫仍在、提问不再注入」的用例：项目层不存在 = 除核心 impact 外零行为变化。

