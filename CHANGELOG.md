# CHANGELOG

## 0.3.0 —— v2 开发过程控制

### 安装方式

本仓库同时是插件市场：`/plugin marketplace add git@git.woa.com:shingao/repo-guard.git`，然后 `/plugin install repo-guard@repo-guard`；终端里执行一次 `repo-guard link`（见 README）。

### v2 开发过程控制（Beta，设计见 docs/DESIGN-v2.md）

- 单一配置：插件 `config/repo-guard.json`（全局层）+ 仓库 `.codebuddy/repo-guard.json`（项目层），项目层存在才启用。init 把全部可调字段（预算、档位、默认命令红线等）连同说明写进项目层，项目层整体覆盖全局层；`status` 列出与部门默认不同的项。
- 任务契约：MCP 新增 `guard_task` / `guard_note`；写第 2 个文件还没有契约时拒绝一次；每轮注入契约摘要，压缩后与子代理启动时（新挂 SubagentStart）重注入基线与契约。
- 写时控制：红线（路径 / 字段 / 内容 / 命令，按 action 执行、缺省 block、不受总档位约束；内置 5 条硬编码凭据规则；旧 `redlines.json` 的字段红线由 init 迁入，`audit` 改为体检 `repo-guard.json` 的字段红线）；remind 档写后提醒范围越界、新建前未查 atlas、本次新增或变长函数的长度 / 嵌套 / 参数、连续失败；enforce 档写前弹窗或拒绝。
- 改动回执（Stop）：对比写前快照计算范围、体量、复杂度、atlas 查重、噪声、验证证据、顺手发现；`systemMessage` 给人看，有待说明项时续跑让模型逐条说明。
- 新命令：`init`（交互接入与告知；`--plan --json` / `--apply` / `--yes` / `--merge-gate`）、`status`、`receipt`、`check --staged | --base`（合并门）；斜杠命令 `/repo-guard:init`。
- shell 写公共层的提醒从写前挪到执行后：写前的 `allow` + 说明会绕过用户对命令的权限确认。
- `post-bash` 中 atlas 绑定失效不再吞掉其余处理；新机器上没有 atlas 工作区时 init 使用 default。
- 复杂度提醒只算新函数超阈值、或已有函数被这次改动推过阈值；改动前已超阈值的函数不再提醒。修复把 `moment(x).format(y)` 这类调用误认成方法定义。
- 新增 `repo-guard link`：在 `~/.local/bin` 写一个启动器，每次运行时在已安装的插件中选版本最高的那份（项目级安装只在当前目录属于该项目时才算），插件升级后不用重新 link；目标已存在且不是启动器时不覆盖。
- 实测修复（前后端各两个真实需求的对照实验中发现）：
  - 模型用 `python3 - <<EOF`、`sed -i` 等命令直接改文件会绕开编辑工具：会话开始记 git 基线，命令执行后与结束时对比工作区，把经命令改动的文件纳入范围、复杂度、红线检查和回执。
  - 插件内注册的 MCP 工具名是 `mcp__plugin_repo_guard_code_atlas__*` / `mcp__plugin_repo_guard_repo_guard__*`（宿主把连字符转成下划线），post-atlas 的 matcher 与提示文案改为同时覆盖两套名字。
  - 延迟加载的 MCP 工具经 `DeferExecuteTool` 代理调用：新增该 matcher，从入参取真实工具名；拿不到结构化回执时只读缓存再查一次。
- 删除旧 `init` 的体检报告渲染（`renderInit`）；`init --write` 等同 `init --yes`，写 `repo-guard.json` 而不是 `repo-facts.json`。

### 统一外部 code-atlas 图谱接入

- 新增 `repo-guard atlas bind/status/<原生命令>`，CLI、MCP、Hook 使用同一 Node 与完整工具包，显式绑定失效不回退 PATH。
- `init` 默认只读预览；`--write` 才登记、建立或复用图谱。支持 `--ws` 与重复 `--with`，多工作区不静默选错。
- 图谱查询留痕消费 Atlas 实际回执，不按工具入参猜目标；失败、歧义和未匹配不记成功，trace 不代替 impact。
- code-atlas 配套源码补充原生查询回执、工作区元数据接口和文件级目标支持；本插件不复制图谱实现。
- 增加隔离图谱接入专项回归。红线/门禁配置和策略暂不重设计。

### 删除自带图谱引擎，图谱改由 code-atlas 提供

- 删除 `src/graph`、`src/insight`、`src/viz`、图谱缓存与 `assets/viz`；去掉 `@babel/*`、`echarts` 依赖与 parity / viz 回归。
- CLI 删除 `impact / hot / trace / similar / contracts / viz / conform`（敲了会提示改用同名 `atlas` 命令）；`scan` 转调 `atlas scan`；`init` 的公共层推测改用 `atlas hot --json`，本仓不在 atlas 工作区时先 `atlas add`。
- MCP 只剩 `check / lib_search / audit`；插件 `.mcp.json` 同时注册 `code-atlas`（`mcp__code-atlas__atlas_*`）。
- 新钩子 `post-atlas`（PostToolUse）记录 AI 对 `atlas_impact / atlas_reuse / atlas_trace` 的调用；`post-bash` 识别终端里的 `atlas impact|similar|hot`；Stop 写后比对改调 `atlas conform`。
- 没装 atlas 时 SessionStart 明说图谱相关守卫未生效。

### viz 文件总览展开后显示方法名

展开某个 `.go` 时，类型/方法挂在文件右侧（与四仓图同一套列偏移），画出 file/cls → 方法的包含边。
调用边落在方法节点上；对端未展开则接到对方文件，不再把 import 扇形扎在父文件上。

### facts.json 按仓库生成

`init --write --all` / `guard init --write` / `layers init --write` 不再拷贝身份服务示例模板。
按本仓目录、go.mod / package.json、repo-facts 生成架构事实；required 只含真实路径。
已存在的 `.codebuddy/facts.json` 不覆盖。默认 `init --write`（无 --all）stdout 不变。

### 配置面重构：支撑「部门模板包」三级分发

分发链从两级变成三级：**插件源码 →(`npm run pack`)→ 部门模板包 → 各项目 `.codebuddy/`**。
部门拿到的包里没有 `src/`、没有 `node_modules`，引擎是 minify 单文件 ——
**判据由此确定：部门需要改的一切，必须以 JSON / MD 的形式躺在包里。**

仍然只有两层（全局 `templates/` + 项目 `.codebuddy/`），没有引入第三层。

#### 新增

| 能力 | 说明 |
|---|---|
| `npm run pack` | 打模板包。白名单复制 + 三条硬断言（包内绝不含 `package.json`、版本号以 `plugin.json` 为准、冒烟三连含包内 59 条钩子回归） |
| `repo-guard doctor` | 配置体检。**是 `standards audit` 的超集，复用 `collectAuditFindings` 不重写判定** |
| `repo-guard redlines init [--write]` | 把 `templates/redlines.json` 拷进项目层。四个 init 至此对称 |
| standards 分片 | 一个端可以有 `<端>.json` 与 `<端>/*.json` 两种形态并存。`readdir` 结果排序、跳过 `_` 前缀、同层 id 重复报出来 |
| `override_policy` | `free` / `reason-required` / `locked`。部门限定项目层能改到什么程度 |
| `templates/CONFIG.md` | 部门解压后的唯一入口，列全两层所有可填点 |
| `templates/repo-facts.defaults.json` | 部门级行数上限 / 组件库 / 公共层惯例 |

#### 为什么红线走「拷贝」而不是「运行时合并」

试过合并，会打穿两处，而且都**无法用「旧产物有 bug」开脱**：

- `activeRules()` 在未配置仓里变非空 → `hook-session-start-unconfigured` 变红，
  而那条恰是 `KNOWN_DEVIATIONS['hook-session-start']` 的论证基石
- `hasRedlines()` 返回 true → `audit-unconfigured` 退出码从 2 变 0

改成 `init` 拷贝之后语义反而更正确：红线本就该进 git、过 review、能被 `audit` 验完整性，
而验的对象必须是这个仓库实际生效的那一份。`loadRedlines` / `hasRedlines` 一行未动。

同理，`repo-facts` 的部门默认值**只在 `readFacts` 的非 null 分支内补齐字段** ——
`if (!raw) return null` 是写前守卫的总开关，动它等于把 fail-open 翻成 fail-closed。

#### 修掉 5 个僵尸条目

`doctor` 上线当天就在出厂模板里查出 5 条**永远不会输出**的规范（56 条里的 9%）：
`L0-EN-004` `CM-CODE-001` `BE-ERR-002` `DB-SCHEMA-002` `DB-AUTH-001`。

根因是 `check.kind` 与 `timing` 的组合不兼容，而这个组合的规则**在代码里而不在文档里**：

- `kind: "none"` 不进 `scanFile` 的候选池（那里只收文件级判据），所以配 `post_write` 是空转
- `pre_write` / `pre_bash` / `stop` 三个 timing **没有任何代码读取** ——
  硬拦由 `severity` + `check.kind` 决定，与 timing 无关
- `require_evidence` 当前没有运行时求值器，声明 `landing: ["plugin"]` 等于插件在假装能管

`doctor` 把这三类分三个级别报：真僵尸报 error，能力缺口报 warn，
timing 里的装饰值报 info —— **能力缺口不能报成 error**，
否则部门会去改配置，而改成什么都没用，然后得出"这检查在乱报"的结论。

#### 顺手修掉一个潜伏的越界

`scanFile` 是 `evaluate.ts` 里唯一不自带 `isActionable` 闸门的导出（因为
`standards check` 必须能在只有全局层时给结论）。但 `post-write` 钩子直接调它，
意味着**部门往全局层加一条 `remind` + `post_write` + `content_regex` 的规范，
会让所有没铺项目层的仓库都开始收到提醒** —— 正是「项目层不存在 = 零行为变化」
要挡住的事。当前没有条目命中所以是潜伏的，闸门已补在调用方。



规范从"只能 CLI 自查"变成"AI 写代码过程中真的生效"。判定逻辑集中在
`src/standards/evaluate.ts`，**CLI 与 hook 共用同一份** —— 各写一套的后果是
"自查说没问题、实际被提醒"，那比没有自查更糟。

| 时机 | Hook | 给什么 |
|---|---|---|
| `session_start` / `post_compact` | `SessionStart` / `PostCompact` | 只给 `title` 列表 |
| `prompt_submit` | `UserPromptSubmit` | 按 `tags` 命中，给**完整正文** |
| `post_write` | `PostToolUse` | `remind` 级提醒，带行号证据 |
| `pre_write` | `PreToolUse` | `block` 判定（编译成 `PolicyRule` 交红线引擎 / `require_tool` 查会话状态） |

**注入面只给 title、正文留到命中时才给**：45 条规范的正文远超 1500 token 段预算，
会话开始时模型需要的是"知道有这些约束"，不是背下每条。正文在两处给 ——
`UserPromptSubmit` 按 tags 命中时（这一句话确实相关）、被拦/被提醒时（此刻必须知道为什么）。

#### 硬约束：项目层不存在 = 零行为变化

全局层（插件内 `templates/standards/`）**装上插件就存在**，拿它驱动注入意味着
所有人一升级插件就被迫接受一堆新输出。所以 `evaluate.ts` 的每个入口都先过
`isActionable()`，而它只认 `projectPresent`。

没铺 `.codebuddy/standards/` 时运行时什么都不做，此时全局层只服务 `standards check`
这类人主动跑的 CLI。**59 条 verify-hooks 与 76/84 parity 因此全部保持不变。**

#### 两处顺序/归属问题（实现时发现并修掉）

| 问题 | 为什么严重 |
|---|---|
| `require_tool` 判定排在公共层守卫之前 | 两者会判同一件事（模板 `CM-LAYER-002` 的 paths 就是公共层），而核心功能那份拒绝文案是真机调优过的 —— 它给出三种工具调法，因为模型按 `impact` 搜工具名会搜不到，然后判定「工具不存在」改用 grep 凑影响面。让 standards 那份较简的文案抢在前面等于丢掉这个调优成果。已改成核心守卫优先，standards 只管它覆盖不到的场景（新建文件的 similar/hot/lib、公共层之外的路径） |
| 拒绝文案指错配置文件 | `STD-` 前缀的规则来自 `.codebuddy/standards/`，但文案一律写「更新 .codebuddy/redlines.json」。模型照做会改错文件，然后以为改了没生效。已按 id 前缀分流 |

#### standards 的 block 不受 guard 的 L1 总闸控制

它有自己的总闸（`standards.json` 的 `enabled` + `maxSeverity`）。把 `maxSeverity`
调到 `block` 已经是极其明确的表态，再要求同时打开 guard 的 `L1_admission` 就成了
两套开关，人会困惑「我开了为什么不拦」。配置集中优先。

实现上 `judgeRedline` 新增 `extraRules` 参数走独立闸门：L1 关着时快照里的手写红线
不判，但 standards 的 block 仍判。

#### 又一处模板缺陷（真机发现）

后端与数据库模板里**没有一条** `timing` 含 `prompt_submit` —— 于是在后端仓问
「帮我改个接口字段名」时按任务注入完全没有输出。而"改字段"恰恰是最需要在动手前
拿到完整正文的操作。已给 15 条高价值条目补上（`BE-API-*` / `DB-SCHEMA-001` /
`DB-MIG-001` / `DB-RL-001` / `CM-FREEZE-001` / `MQ-*` 等）。

顺带去掉 `CM-LAYER-002` 的 `session_start` 时机：公共层那段正文已由核心功能的
`guardSegment` 注入，再注一遍是重复，而重复会稀释每条约束的分量。

#### 新增埋点

`standards_hit`（remind 级命中）/ `standards_deny`（block 级拦截），
供 `repo-guard governance` 回答"这些规范在做有用功还是在骚扰人"。

### 新增：五端研发规范标准模板（`templates/standards/`）

把研发规范做成**集中、两层、可修改**的插件模板。六个文件对应六个端（L0 跨端契约 /
全端共用 / 前端 Web·React / 后端 Go·Node·Java / 数据库 / 消息队列），共 45 条条目。

**两层而不是三层**：全局层在插件里（改它 = 定制部门模板，跟着版本走），项目层在
`<repo>/.codebuddy/standards/`（进 git）。合并 key 是条目 `id`，**字段级浅合并** ——
项目层只写要改的字段，其余继承全局层。这样团队不必整份抄一遍（抄了下次升级就拿不到新条目）。

**放宽必须留痕**：项目层降低强度或关闭条目时必须写 `override_reason`，否则该 override
**被忽略**并在 `standards audit` 里报 warn。选"允许放宽但留痕"而不是"禁止放宽"是因为
这是单机插件，没有企业策略层能兜住硬禁止 —— 硬禁止的唯一后果是人把整个目录删掉，
那时连留痕都没了。收紧不需要理由。

**默认零拦截**：`maxSeverity` 默认 `remind`，所有 ask/block 自动降级为提醒。
另有 **block 准入三条件**（`paths` 非空 + `confirmed: true` + 判据属
`protect_symbol`/`path_only`/`require_tool`），缺一即降级，并在 `standards list` 里
显式标出降级原因 —— 静默降级会让人以为配了就生效。`content_regex` **永不 block**：
正则判不出意图，"改断言"和"修正一个写错的断言"在文本层面一模一样。

### 两处方向性错误（设计过程中发现并修掉）

| 问题 | 为什么严重 |
|---|---|
| `__PUBLIC_LAYER__` 展开为空时留下空 `paths` | `itemAppliesToPath` 把空 `paths` 解释成**全仓适用**，于是一条只想管公共层的规范在没配公共层时突然适用全仓 —— 方向从"少管"翻成"全管"。改成：展开为空即关闭该条目并留一条告警 |
| `standards check` 把会话级条目按文件判定 | `none`（只注入）与 `require_evidence`（会话内跑过校验没）不是按文件判定的。按文件报会让每个文件后面跟一串"不编造字段""CI 不绿不许合"，那不是自查结果是噪音，而噪音会让人不看这份输出 |
| `protect_symbol` 在 `check` 里退化成纯路径命中 | 完整判定要真 diff（before 含、after 不含），只有 `PreToolUse` 拿得到；CLI 没有 diff。但退化成"路径命中即报"意味着 `paths` 覆盖的目录下每个文件都报"这里有受保护字段"——真机验证时 `router/router.go` 也报了 `error_description`，而它根本没提到这个词。改成**文件里确实出现该符号才算命中**并给出行号，语义同时变准：它回答的是"这个文件碰了受保护字段"，不假装能判断"你删了它"|

### 新增命令

| 命令 | 干什么 |
|---|---|
| `standards list [--stack <端>]` | 生效清单：哪些端启用、来自哪一层、实际强度、被降级的原因 |
| `standards check <文件…>` | 规范自查。**人审/硬拦级非零退出**，可挂 CI；提醒级不影响退出码（启发式判据卡流水线会被关掉） |
| `standards init [--write]` | 铺模板。与 `guard init` 同纪律：默认一个字节不写，已存在的绝不覆盖 |
| `standards audit` | 规范腐烂体检：空 `symbols` 的守空气、被静默降级的 block、会拦人但没写 `hint`、项目层放宽有没有留理由 |

### 图里的 4 个门禁名没有变成 4 道门

外部规范图里的 `modify_api` / `modify_database` / `modify_mq_schema` /
`modify_component` 与 `verification.buildCmd` / `testCoverageNote` /
`publicLayerPatterns` / `pageLayerPatterns` 是**另一套系统的字段名**，不引入，
而是落成 standards 条目复用现有机制（详见 `docs/CONTROL-POINTS.md` §14.5）。
其中 `modify_database` 对应的 `DB-*` 条目**刻意不强制查图谱** —— 库字段的
"影响面 0"是假信号，SQL、离线任务、其它服务全在图谱之外，一个不准的门禁比没有门禁更糟。

### 新增文档

- `docs/STANDARDS.md` —— 五端规范清单。每条给 id / 硬约束原文 / 适用路径 / 强度 /
  落点主体 / "不要写成"的反例，并明确列出**插件拦不住、必须外委**的那些
  （循环依赖与行数硬拦 → lint；密钥与覆盖率 → CI；碰生产与 `git commit` → 宿主
  `permissions.ask`）。不假装能拦是这份清单的底线。
- `docs/CONTROL-POINTS.md` 新增 §14「研发规范落点索引」—— 规范 `severity` → 控制点 →
  hook 事件 → 输出字段 → 权限链位置，以及四份配置（`repo-facts` / `redlines` /
  `guard/` / `standards/`）各管什么。

### 兼容性

`repo-facts.json` / `redlines.json` / `.codebuddy/guard/` **全部保留原路径原字段**，
一个都不迁移（README 那句"挪位置会破坏现有安装"仍然成立；而且 parity 有 5 条用例
在逐字节比对 `repo-facts.json` 的文件内容）。standards 只读它们：`publicLayer` 供
`__PUBLIC_LAYER__` 展开、`analyzer` 供端探测、`redlines.protects` 供 `protect_symbol`。

`npm run check` 全绿：typecheck + build + 59 条 verify-hooks + 76/84 parity
（8 个已知偏差为既有）。规范未铺设时零行为变化。

### 真机验证（两个生产仓）

在 `saas-web`（React + `@tencent/tea-component`）与 `backend-agent-identity`
（Go 1.24 + trpc）上跑过 `standards list` / `check`：

- **端探测两仓全对**，且前端仓自动跳过 database / message-queue —— `FE-SKIP-001`
  想要的效果不用人配就达成了
- **前端零误报**：抽样命中的 `color: '#0052D9'`、`const p: any`、
  `<List.Item>时间窗口：…</List.Item>` 逐条核对全是真阳性；用 `t('中文')` 包裹的
  文案正确不报
- **后端暴露了模板的真实缺陷**：`paths` 默认写的是 `internal/handler/**`，
  而这个仓的分层是 `router/ → service/{admin,agent}/ → internal/logic/ → internal/repo/`，
  于是 `BE-ERR-001` **静默失效**。这正是模板注释里警告过的那种失败 ——
  验证方式是 `standards audit` 看不出来的，只能靠在真仓上跑一遍 `check`
- 顺带发现模板里当示例写的 `error_description` 在这个仓是**真红线**
  （`internal/filter/oauth.go` 的 `AuthError` json tag，OAuth 2.0 标准字段）

一条配置教训（已写进给这两个仓的项目层配置）：`symbols` 不能填通用词。
填 `["error_description", "error"]` 时 `error` 单独命中 10 处；收窄成
`["error_description"]` 后精确命中 4 处、零误报。

### 验证逼出的三处模板改动

| 改动 | 原因 |
|---|---|
| 后端 / 数据库 / MQ 的 `paths` 改成**多候选并列** | 模板只写 `internal/handler/**`，而真实仓的分层是 `router/ → service/{admin,agent}/ → internal/logic/ → internal/repo/`，于是 `BE-*` 全部静默失效。多写不会误伤（不存在的目录不会命中），漏写则整条规范无声消失 |
| 前端 `FE-API-001` 的 `paths` 补 `src/api/**` | `src/**/api/**` 里的 `**` 要求中间有段，匹配不到 `src/api/x.ts` —— 而那正是这个仓的布局 |
| `BE-ERR-001` 从内容正则降为只注入 | 模板里只匹配 `OAuthResponse` 一个词，真实仓 13 处命中**全是合规使用**（OAuth 路由本来就该挂这个壳）。正确判据是「admin 侧标识 + OAuth 壳同行同现」，而「admin 侧」在各仓叫什么模板猜不到 —— 猜错就是纯误报。改成模板只给正文，双条件正则交项目层填，`_note` 里带真实示例 |

第三条是这次验证最值得记的一件事：**判据写不准时，正确的做法是降级为只注入，而不是写一个宽松的正则凑合。**
宽松正则的产出是 13 条噪音，而噪音会让人关掉整套门禁。

### 项目层配置的真实用法：关掉重复项，而不是再加一堆

两个仓都已有成体系的 `.codebuddy/rules/`（后端的 `mongo-field-naming.md`
讲 bson tag 三处联动、`verify-before-done.md` 讲本仓零测试包清单；前端的
「接口层写法规范」「静态可分析性规范」讲怎么写才能被图谱静态提取）。

所以给这两个仓写的项目层配置里，**7 条是关闭**（每条写明 `override_reason`
指向对应的 rules 文件），其余是把 `paths` / `body` / `hint` 对准本仓 ——
没有新增任何一条规范。两套规则说同一件事的后果是注入面翻倍，而且措辞不一致时
模型不知道听谁的。

这也正好把「放宽必须留痕」跑通了：`standards audit` 能列出是谁关的、为什么关、
该去看哪份文件。

### 修掉的严重问题

| 问题 | 影响 | 怎么发现的 |
|---|---|---|
| **会话状态的 key 不带仓库维度** | 状态放在 `$HOME`（不能放仓库里，会污染 `git status`），而 key 是**仓库相对路径**。两个仓都有 `src/index.ts` 时 key 就撞：在 A 仓查过影响面，写 B 仓那个同名文件**直接放行**。守卫方向性地从"多拦"变成"漏拦" | 讨论多仓演进时顺出来的 |

修法：新增 `repoId()`（realpath 归一 + FNV-1a 短 hash，**不引入 `node:crypto`**，
产物 require 列表是独立性论证的一部分），凡是 key 含路径或含"本仓知识"的状态
一律走 `scopePrefix(repoDir)`。状态格式版本升到 3，**版本不匹配时整份丢弃** ——
旧格式没有仓前缀，混着读会让"查过"判定时真时假，那比丢掉状态坏得多（丢掉只是多拦一次）。

会话级计数器（`toolCalls` / `consecutiveFail` / `repeatCount` / `evidence` / `stopNotices`
与 `countSessionFiles`）**故意不带仓**：它们回答的是"这个 agent 这一轮的行为"，
按仓拆开会让每个仓各自从 0 数起，L3 循环门与范围预算直接失效。
函数签名本身就是这份划分的文档 —— 带 `repoDir` 的是仓级，不带的是会话级。

回归用例 **G3**「在另一个仓查过，不放行本仓的同名文件」钉住这条：
去掉仓前缀，G3 立刻从 deny 变 allow（已实测）。verify-hooks 58 → 59 条。

### 新增文档

- `docs/MULTI-REPO.md` —— 多仓演进。写清当前单仓假设的准确边界（含两个**已经存在**
  的静默错误：`findRepoRoot` 在 monorepo 子包停住导致图谱范围被截断；多根工作区被当成
  一个大仓、各子仓的 `redlines.json` 全被忽略）、演进支点「仓由文件决定而非 cwd 决定」、
  本地与服务端图谱的分工（服务端拿不到未提交改动，是结构性的；而对方仓只需要默认分支，
  多分支维度因此塌成 1）、以及跨仓契约索引的三级落地。
  盘点出跨仓能力的第一个必做项是**后端→后端的出向调用识别** ——
  前端侧 `@api` 边已经产出 `POST /path`、后端侧 `RouteNode` 已经产出 `method + urlPath`，
  两端 join key 现成，缺的只有 Go / Java / Python 分析器不认自己调了别的服务。

## 0.2.0 —— 源码版 + 协作全景七道门

### 这一版最重要的一件事

**`bin/repo-guard` 从一个无源码的压缩产物，变成了从 `src/` 构建出来的东西。**

0.1.0 的那份产物是打包好的，源码在任何地方都找不到 —— deerclaw 工作区、git 历史、
两个产物 zip 里都只有压缩文件。这一版：

- 图谱引擎（各语言 analyzer + 建图 + 打分 + 红线判定 + 红线体检）从 deerclaw
  逐字移植到 `src/engine/`，改动纪律见 `src/engine/PORTING.md`
- CLI / hook / MCP 适配层按 `bin/verify-hooks.mjs` 的用例契约与旧产物的字符串
  **反推重写**，逐字节比对守着（`build/verify-parity.mjs`，84 条）

### 修掉的严重问题

| 问题 | 影响 | 怎么发现的 |
|---|---|---|
| **产物文件头被插入 6 字节脏数据** | 整个引擎语法错误，**所有 hook 静默 fail-open —— 插件表面装着、实际全放行，且没有任何报错**。20 条用例只过 11 条 | 固化基线时跑 verify-hooks |
| **MCP server 与宿主死锁** | 一次读完 stdin 再处理，而宿主写完 `initialize` 就等响应、不关闭 stdin。双方僵死，界面永远显示"服务仍在连接中"，**9 个工具一个都不出现** | 真机装载 |
| **拒绝文案里的工具名是错的** | 文案写「请先调用 impact 工具」，但插件 MCP 工具的真名带命名空间（`mcp__repo-guard__impact`）。模型搜不到 → 判定"工具不存在" → 改用 grep 凑影响面。守卫拦住了，却把它推向更差的替代方案 | 真机端到端 |
| **`toRepoRelative` 对新建深层目录的文件判成"仓库外"** | `pre-write` **跳过全部门禁**静默放行。`realpathOrSelf` 只回退一层父目录，而新建文件常常连父目录都不存在 | 扩充 verify-hooks 时 |
| **`agents/README.md` 被载入成一个名叫 `README` 的 agent** | 污染用户的 `/agents` 菜单 | 真机装载 |
| **`package.json` 加 `"type": "module"` 直接废掉产物** | 产物是无扩展名 CJS，Node 按最近的 package.json 判模块类型 → 被当 ESM → 第一行 `require` 就 `ReferenceError`，而 hook 层 fail-open 把错误吞掉 | 抓 baseline 输出时 |
| **CLI 把 `--min-call-sites` 的值当位置参数** | `contracts --min-call-sites 1` 静默返回空结果 | 补 parity 用例时 |
| **行数统计与编辑器行号差 1** | 提醒里的数字和人打开文件看到的对不上 | parity |
| **`findRoute` 的末段匹配把 `/api/users` 撞到页面路由** | `trace` 输出一条完全无关的调用链，模型会当成"这个后端接口的实现在这儿" | parity |
| **公共层推测在深层布局上推出 `src/main/`** | 那是整个源码树。守一切等于什么都没守，Java 仓每次写文件都会被拦 | 补 Java fixture 时 |
| **macOS 上绝对路径被判成仓库外** | `/var` 是 `/private/var` 的符号链接 | parity |

### 新增：协作全景七道门

把 deerclaw「团队协作全景」的 L0–L6 落到 CodeBuddy 的控制点上。
配置骨架在 `templates/guard/`，由 `repo-guard guard init --write` 铺到
被守护仓库的 `.codebuddy/guard/`。

**所有门默认关，装完不会有任何新的拦截。** `verify-hooks` 的阶段 C
（删掉 guard 配置后重跑基线用例）就是这条的证据。

| 门 | 落点 | 强度 |
|---|---|---|
| L0 注入面 | `SessionStart` / `PostCompact` 注入章程·知识·禁忌·红线摘要（每段 1500 token 按行截断并标注）；`UserPromptSubmit` 按任务类型注入必读 | 注入 |
| L1 红线硬拦 | `PreToolUse` 写工具 → 结构化删除判定。**顺带比 deerclaw 更强**：那边只有全量覆盖写能拿到真 diff，这里把 `Edit` 的替换应用一遍算出精确 after，增量编辑也能判 | 硬 |
| L1 禁改清单 / 范围门 / 图谱强制 | 同上 | 硬 |
| L2 执行门 | 交宿主的 `permissions` / `sandbox`，插件永不实现 | 宿主 |
| L3 循环门 | `PostToolUse` / `PostToolUseFailure` 计数 → `PreToolUse` 短路。迭代预算只能近似观测 | 硬 / 观测 |
| L4 诚实信号 | `SessionEnd` 落近似埋点（标 `approximate: true`） | 观测 |
| L5 交付门 | `Stop` 检查工程校验证据。**默认只提醒** —— agent 在用户的工作树上干活，硬拦 commit 会妨碍人 | 默认关 |
| L6 治理留痕 | 全部 hook 写 `$HOME/.repo-guard/metrics.ndjson`，`repo-guard governance` 出报表 | 留痕 |

### 新增命令

- `repo-guard governance` —— 治理留痕报表：这些门在做有用功还是在骚扰人
- `repo-guard guard init [--write]` —— 铺七道门配置骨架
- `repo-guard guard show` —— 打印**实际生效**的配置。回答「我配了为什么没生效」

### 新增插件组件

`agents/repo-guard-reviewer.md`（只读审查者，不默认激活）、
`output-styles/guarded.md`（占位）、
`commands/{audit,governance}.md`、
根 `settings.json` 与 `.lsp.json`（都留空并写明为什么）、
`hooks/hooks.json` 列出**全部 24 个事件**（已挂 9 个，其余留空并写明打算做什么）。

### 从宿主源码里核实的四条事实

这四条都与官方文档或现有插件案例不一致：

1. **`timeout` 单位是秒**，实现是 `(timeout ?? 60) * 1000`。内部市场有插件写
   `120000`（当毫秒用），那等于 33 小时，相当于没有超时
2. **`loop_limit` 宿主未实现**。qeri / lintbot 都在 `Stop` 上写了它防死循环，
   CodeBuddy 会**静默忽略**。所以用 `continue:false` 必须自己做上限
3. **插件能贡献的组件只有 8 类**：`agents` `commands` `skills` `hooks`
   `mcpServers` `lspServers` `outputStyles` `settings{agent, subagentStatusLine}`。
   **没有 `rules`** —— 插件无法下发 `.codebuddy/rules/`
4. **`Setup` 事件存在但不在官方文档的事件清单里**

### 验收

```
npm run check     # typecheck → build（含冒烟）→ verify-hooks → verify-parity
```

- `verify-hooks` 58 条（从 20 条扩充）：阶段 A 基线契约 20 条 + 阶段 B 七道门 34 条
  + 阶段 C 删掉 guard 验零行为变化 4 条
- `verify-parity` 84 条逐字节比对 + MCP 长连接存活断言，8 条已登记的有意偏差
- fixture 覆盖 5 个技术栈：web-frontend / go-gin / java-spring / python-ast / node-babel
- 真机 `--plugin-dir` 端到端验证：拦住 → 调 `impact` → 拿到强影响入口 → 判定低于阈值
  → 放行 → 改对 → 主动复述盲区

### 已登记的 8 条有意偏差

跑 `npm run verify:parity` 会打印每条的原因。三类：

1. **旧产物有 bug**：`--min-call-sites` 被当位置参数、macOS 绝对路径判仓库外
2. **旧产物的行为该改**：`impact` 工具名没带命名空间导致模型找不到、
   类型草稿署名 `DeerClaw`、帮助里缺新命令
3. **无法还原**：`lib search` 的排序。逆向 11 个查询仍拼不出旧产物的打分函数，
   而且它自相矛盾（单字查「树」「选」有结果，查「框」返回空，可是「输入框」
   「多选框」都含「框」）。判定为缺陷而非设计

### 已知限制

- **`node-babel` 的路由判据是启发式**：要求 `router.get('/x', ctrl.method)` 这种
  形态（对象名叫 router/api/app/mux + handler 是成员表达式）。裸标识符
  （`router.get('/x', listUsers)`）认不出来，会得到 **0 个入口** ——
  而「受影响入口 0」会被模型读成"可以安全删"
- **L3 迭代预算只能近似**：插件拿不到 iteration 序号，只能用工具调用总数推
- **L0 只能追加不能重排**：注入内容一定排在宿主 system prompt 之后

---

## 0.1.0

初版。压缩产物，无源码。