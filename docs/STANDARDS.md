# 研发规范标准清单（5 端）

> 这份文档是**内容**：各端要遵循什么、哪条能硬拦、哪条只能提醒、哪条根本不该由插件管。
> 对应的**机制**（落到哪个文件哪个字段哪个 hook）见 [`CONTROL-POINTS.md` §14](CONTROL-POINTS.md#14-研发规范落点索引)。
> 对应的**可执行配置**是 `templates/standards/`，铺到仓库后在 `<repo>/.codebuddy/standards/`。

---

## 0. 怎么读这份清单

### 两层规范

| 层 | 位置 | 谁维护 | 语义 |
| :--- | :--- | :--- | :--- |
| **全局** | 插件内 `templates/standards/*.json` | 规范owner（改这里 = 定制部门模板） | 所有项目的默认基线 |
| **项目** | `<repo>/.codebuddy/standards/*.json` | 仓库维护者，**进 git** | 覆盖 / 关闭 / 新增全局条目 |

合并按 `id`，字段级浅合并 —— 项目层只写要改的字段，其余继承全局。

**放宽必须留痕**：项目层降低强度或 `enabled:false` 时必须写 `override_reason`，否则该 override 被忽略、仍按全局强度执行。选「允许放宽但留痕」而不是「禁止放宽」，是因为这是单机插件，硬禁止的唯一后果是人把整个目录删掉 —— 那时连留痕都没了。

### 四级强度

| 强度 | 行为 | 什么时候用 |
| :--- | :--- | :--- |
| `inject` | 只进上下文，不判定 | 说不清判据但必须知道的事 |
| `remind` | 写完后提醒（`PostToolUse`） | 判据是启发式的，会误判 |
| `ask` | 转人工确认（`PreToolUse` → ask） | 后果人承担不了，但判据可靠 |
| `block` | 直接拒绝（`PreToolUse` → deny） | 判据是硬证据，且改错等于线上故障 |

**`block` 准入三条件**，缺一自动降级为 `remind`：
1. `paths` 非空 —— 全仓范围的硬拦一定误伤
2. `confirmed: true` —— 人确认过这条判据
3. `check.kind` ∈ {`protect_symbol`, `path_only`, `require_tool`} —— `content_regex` 永不 block，正则判不出意图

### 五种落点主体

| 落点 | 含义 |
| :--- | :--- |
| `plugin` | repo-guard 能在过程中判定 |
| `lint` | 交给 eslint / stylelint / golangci-lint / tsc —— 确定性规则的正确归属 |
| `ci` | 交给流水线 —— 唯一能"卡住合并"的地方 |
| `permissions` | 交给宿主 `.codebuddy/settings.json` 的 `permissions.ask` / `deny` |
| `human` | 只能人判断，插件只负责把它摆到眼前 |

> **一条规范可以有多个落点。** 典型组合是 `plugin + lint`：lint 是硬落点（拦得住、可审计），plugin 负责在 AI 写之前/写之后把它说出来，减少返工。

---

## 1. L0 跨端契约

> **双方共同遵守，单方不得擅自修改。** 这一层的每一条都跨仓，所以插件只能提醒，硬落点全在 CI。

| id | 规范 | 硬约束 | 强度 | 落点 | 不要写成 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `L0-CT-001` | 接口契约 OpenAPI | 契约有唯一权威源；改契约必须先改权威源再改代码，不许代码先行 | `inject` | ci, human | 「以代码为准」 |
| `L0-CT-002` | 错误码字典 | 错误码只增不改；新增必须进字典；禁止就地发明错误码 | `remind` | plugin, ci | 散落在各 handler 里的字面量 |
| `L0-CT-003` | 字段与枚举字典 | 字段名与枚举值来自字典；禁止凭语义相近就复用别的字段 | `remind` | plugin, ci | 「看起来一样就用它」 |
| `L0-CT-004` | Trace-ID 透传 | 入口生成、全链路透传、日志必带；跨服务调用不许丢 | `inject` | plugin, lint | 只在出问题时才加 |
| `L0-EN-001` | Lint 与类型检查 | 每个仓都要有可独立执行的 lint + 类型检查命令 | `inject` | lint, ci | prompt 里的格式说教 |
| `L0-EN-002` | 契约 diff 校验 | MR 必须跑契约 diff；破坏性变更必须显式标注并通知对端 | `inject` | ci | 只靠 code review 碰运气 |
| `L0-EN-003` | CI 门禁与覆盖率 | CI 不绿不许合；覆盖率缺口必须显式说明 | `inject` | ci | 「本地已测」 |
| `L0-EN-004` | MR 模板与 CR | MR 必须说明改了什么契约、影响哪些对端 | `inject` | ci, human | 空 MR 描述 |

**为什么 L0 这一层插件几乎全是 `inject`：** 契约的另一端在别的仓库里，插件只看得见本仓。能判定的只有"本仓有没有违反自己声明的契约"，而这件事 CI 的契约 diff 做得比插件好。插件在这里的价值是**让 AI 在动手前就知道这些字段不是自己家的**。

---

## 2. 全端共用

> 这些不是前端专属。后端、数据库、MQ、测试都要接，只换命令。

| id | 规范 | 硬约束 | 适用路径 | 强度 | 落点 | 不要写成 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `CM-CODE-001` | 体量 | 单文件超过 `lineLimit`（默认 500 行）需拆分，按本仓已有的拆法拆 | 全仓 | `remind` | plugin, lint | prompt 里的格式说教 |
| `CM-CODE-002` | 循环依赖 | 不许新增循环依赖 | 全仓 | `remind` | lint, ci | 「以后再解」 |
| `CM-CODE-003` | 类型 | 公共边界必须有显式类型；不许用宽类型绕过检查 | 全仓 | `inject` | lint | — |
| `CM-LAYER-001` | 依赖单向 | 依赖只能单向流动，禁止反向 import | 全仓 | `remind` | lint, plugin | 「目录建议」散文 |
| `CM-LAYER-002` | 公共层纪律 | 页面/单业务逻辑不准塞进公共层；公共层路径清单必须人点头，不用工具默认值 | `publicLayer` | **`block`** | plugin | 工具自动猜的目录 |
| `CM-VCS-001` | 提交/分支/MR | 脏代码进不了主干 —— pre-commit + commitlint + CODEOWNERS + CI 四件套 | 全仓 | `inject` | ci, permissions | 只靠模型自觉 |
| `CM-VERIFY-001` | 验证 | 没跑本仓校验命令不能交；**本地绿不算，CI 才是唯一证据** | 全仓 | `remind` | plugin, ci | 「已测」三个字 |
| `CM-SEC-001` | 密钥 | 密钥不进仓、不打日志 | 全仓 | `remind` | ci, plugin | 岗位交底当唯一手段 |
| `CM-SEC-002` | 生产环境 | 无授权不碰生产 —— 生产相关命令必须人确认 | 全仓 | `ask` | permissions | 插件自己拦 |
| `CM-FREEZE-001` | 禁改 | 「看起来脏」的历史代码默认不动；只有明确的 refactor 任务才允许动，且必须先查影响面 | 禁改清单 | **`block`** | plugin | 写进人格 SOUL |
| `CM-HONEST-001` | 契约诚实 | 不编造需求/文档里没有的字段；字段必须来自 trace 或真实类型定义 | 全仓 | `inject` | plugin, human | 只靠 code review 碰运气 |
| `CM-HONEST-002` | 拿不准停下 | 需求与现有实现矛盾时停下来问，**不要自己挑一个继续做** | 全仓 | `inject` | human | 「按最可能的理解处理」 |

**`CM-LAYER-002` 是这一层唯一的硬拦，而且已经在跑。** 判据是硬的：文件在 `repo-facts.publicLayer` 里、且文件已存在、且本轮没查过影响面 → deny。新建公共层文件放行（新建时拦人的容错空间远小于改已有文件）。

**`CM-HONEST-002` 最有价值也最难落。** 模型遇到矛盾时的默认行为是挑一个继续做，而那通常是错的那个。这条只能注入，因为"什么算矛盾"本身需要人判断。

---

## 3. 前端（Web / React）

> 真正前端特有的是 **UI · 组件库 · i18n · 调用契约**。编码和提交不要再算「前端四件套」，那些在第 2 节。

| id | 规范 | 硬约束 | 适用路径 | 强度 | 落点 | 不要写成 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `FE-UI-001` | 主题 token | 只用本仓 token，禁止发明色值 | `src/**/*.{tsx,less,scss}` | `remind` | plugin, lint | 目测一个近似值 |
| `FE-UI-002` | 设计稿权威源 | 设计稿权威源必须写死（Figma 还是 HTML 原型，听谁的）；拿不到就停下来问 | 全仓 | `inject` | human | 两个源都参考 |
| `FE-UI-003` | 状态完备 | 空态 / 加载 / 异常 / 栅格四件套不许省 | 页面层 | `inject` | human | 只写 happy path |
| `FE-LIB-001` | 组件库锁死 | 包名锁死（如 `@tencent/tea-component`）；禁止引入第二套 UI 库 | `package.json`, 全仓 | `ask` | plugin, lint | 「这个组件那个库更好」 |
| `FE-LIB-002` | 新建先查库 | 新建组件前必须先查组件库目录，再查仓内高扇入组件 | 组件目录 | `block`（默认关） | plugin | 直接造一个 |
| `FE-LIB-003` | 公共件签名 | 公共组件受影响入口 ≥ 5 时只允许新增可选 prop | `publicLayer` | **`block`** | plugin | 加个必填参数然后改所有调用点 |
| `FE-API-001` | 调用契约 | 先 `trace` 再对字段，**禁止凭名字猜**；看起来像 typo 的标识符可能是兼容别名 | 请求层 | `remind` | plugin, human | 「这个字段名写错了，我改对」 |
| `FE-LAYER-001` | 分层目录 | `views/pages` 与 `components/hooks` 职责分离；单页逻辑不进公共层；公共层路径必须人确认 | 全仓 | `remind` | plugin, lint | 「目录建议」散文 |
| `FE-I18N-001` | i18n | JSX 不写死中文，文案走 key | `src/**/*.tsx` | `remind` | lint | 「先写死回头再提」 |
| `FE-TYPE-001` | TS 边界 | 禁随意 `any`；公共类型显式导出 | `src/**/*.ts{,x}` | `remind` | lint, ci | `as any` 过编译 |
| `FE-SKIP-001` | 跳过库/MQ 规范 | 前端仓**跳过** `DB-*` 与 `MQ-*` —— 「字段」一词会误伤，把改接口判成改库 | 全仓 | 元规则 | plugin | 全端规范一把梭 |

**`FE-SKIP-001` 不是一条规范，是一条元规则。** 它解决的是真实踩过的坑：「改字段」在前端指的是改接口出入参，在数据库那边指的是改 schema。同一句话触发两套门禁，结果是前端改个接口被要求写 migration。所以端探测必须先做，命中前端就把 `DB-*`/`MQ-*` 整组排除。

**第一波不必接**（ToB 控制台 ROI 低于契约和 i18n）：埋点、前端权限点、路由 query 对齐、性能预算、a11y。有了再加。

---

## 4. 后端（Go / Node / Java）

> 后端没有 UI/组件。对应前端「组件库」的是**对外接口契约**；对应「调用核对」的是**错误封装和字段红线**。

| id | 规范 | 硬约束 | 适用路径 | 强度 | 落点 | 不要写成 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `BE-API-001` | 只增可选 | 对外接口只增可选字段；不许改已有字段的类型与语义 | handler/dto/api | `ask` | plugin, ci | 「反正调用方不多」 |
| `BE-API-002` | SDK 字段冻结 | 已随 SDK 下发的字段名**一字不改**（如 `error_description`） | handler/dto/api | **`block`** | plugin, ci | 「这个命名不规范，统一一下」 |
| `BE-API-003` | 扇出过大先报告 | 受影响入口 ≥ 5 时先报告影响面，不许直接改 | `publicLayer` | **`block`** | plugin | 一次性改完所有调用点 |
| `BE-LAYER-001` | 分层 | `handler → service → repository → domain`，**禁止反向依赖**；本仓目录别名（如 `logic/`）能不能改名写岗位交底，不改跨仓基座 | 全仓 | `remind` | lint, plugin | 「顺手统一一下目录名」 |
| `BE-ERR-001` | 错误封装分层 | 给谁看就套哪层壳。admin 接口禁套 `OAuthResponse` | handler | `remind` | plugin | 所有错误一套壳 |
| `BE-ERR-002` | agent 错误 | agent 侧禁套错封装 | agent 目录 | `remind` | plugin | 复制隔壁的 wrap |
| `BE-CODE-001` | 语言惯例 | gofmt；错误用 `%w` wrap；**每个 goroutine 必有 ctx 与退出路径** | `**/*.go` | `remind` | lint | 裸 `go func(){}` |
| `BE-AUTH-001` | 鉴权/越权 | 权限条件下推到 WHERE，**禁止查出来再 `if uid !=`** | repository/service | `remind` | plugin, human | 应用层过滤 |
| `BE-RETRY-001` | 超时/重试/幂等 | 全链路超时预算；写操作必须幂等；重复提交要能识别 | 全仓 | `inject` | human | 写进红线（风格拦不住） |
| `BE-OBS-001` | 可观测 | 结构化日志；不打密钥；日志字段名稳定 | 全仓 | `remind` | plugin, lint | 出问题再加日志 |
| `BE-CONF-001` | 配置 | 运行时配置文件（如 `etc/trpc_go.yaml`）纳入公共层，改之前查影响面 | 配置目录 | **`block`** | plugin | 「就改个超时时间」 |
| `BE-VERIFY-001` | 验证诚实 | `go test` / `go build` / `go vet` 必须进 CI；**build 过 ≠ 字段安全**；覆盖率缺口写进说明 | 全仓 | `remind` | plugin, ci | 「编译通过了」 |

**`BE-RETRY-001` 刻意只做 `inject`。** 超时/重试/幂等是**风格问题**，判据依赖上下文（一个查询接口不需要幂等）。写成红线必然误伤，误伤的门会被关掉，然后连提醒都没了。

**后端第一波只接**：契约、分层、编码、提交/验证、字段红线、禁改。鉴权/幂等/超时第二天再挂 skill，不要第一天塞满常驻注入面。

---

## 5. 数据库

> **独立一端，比后端更危险。** 图谱和 grep 都看不到 SQL、离线任务、其它服务里的字段下游。所以**不能并进「后端编码」**。

| id | 规范 | 硬约束 | 适用路径 | 强度 | 落点 | 不要写成 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `DB-SCHEMA-001` | 三处联动 | 改字段必须同时改：tag（如 bson tag）、结构体、查询字面量（如 `bson.M{}`）。漏一处是静默的数据错误，没有报错 | repo/model | `remind` | plugin, human | 只改结构体 |
| `DB-SCHEMA-002` | 字段常量 | 新代码用字段常量，不写字符串字面量 | repo/model | `remind` | plugin, lint | 到处散落的 `"user_id"` |
| `DB-MIG-001` | 无 migration 不改字段 | 改任何 schema 字段之前必须先有对应 migration | repo/model/migrations | `remind` | plugin, ci, human | 「先改代码，migration 回头补」 |
| `DB-MIG-002` | migration 幂等 | migration 必须幂等，重复执行结果一致 | `**/migrations/**` | `remind` | plugin, ci | 一次性脚本 |
| `DB-RL-001` | 字段红线 | 删列、改语义、线上还在用的名字 —— 一律停下问人 | 红线 `paths` | **`block`** | plugin, human | 「影响面 0，可以删」 |
| `DB-QUERY-001` | 查询与事务 | 索引、N+1、事务边界显式声明 | repo | `remind` | plugin, human | 一般不进红线 |
| `DB-AUTH-001` | 数据权限 | 过滤条件下推，与 `BE-AUTH-001` 同一条 | repo | `remind` | plugin | 两套规则 |
| `DB-VERIFY-001` | 验证诚实 | 仓储层零测试时，**绿测试不是安全信号** —— 覆盖率缺口必须写进交付说明 | repo | `remind` | plugin, ci | 「测试全绿」 |

**`DB-RL-001` 刻意不强制查图谱。** 「影响面 0」只说明「图看得见的范围内没有调用方」，不等于可以删 —— SQL、离线任务、其它服务完全在图谱之外。所以这条的判据是**红线 `protects` 符号 + 人确认**，不是影响面数字。

---

## 6. 消息队列

> 和数据库同类：跨进程，单仓图算不出另一端。

| id | 规范 | 硬约束 | 适用路径 | 强度 | 落点 | 不要写成 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `MQ-SCHEMA-001` | 只增可选 | Topic / 消息体只增可选字段 | mq/消息定义 | `ask` | plugin, ci | 改字段类型 |
| `MQ-SCHEMA-002` | 同步发布 | 生产者与消费者**必须同步发布**；只改一端等于线上消息解析失败 | mq/消息定义 | `inject` | ci, human | 「先发生产者」 |
| `MQ-RL-001` | 关键字段 | 关键字段叠红线保护 | 红线 `paths` | **`block`** | plugin, human | 「这个字段没人用」 |
| `MQ-SEM-001` | 消费语义 | 幂等、重投、顺序三件事必须明确 | 消费者 | `inject` | human | 假设消息只来一次 |
| `MQ-HIST-001` | 历史分支 | 「多余的消费分支」往往是事故留下的，**默认不动** | 消费者 | `inject` | plugin, human | 当脏代码清掉 |

**`MQ-SCHEMA-002` 只能 `inject`。** 生产者和消费者通常在两个仓库里，插件看不到另一端。硬落点只能是 CI 的契约 diff 加人的 review。

---

## 7. 插件拦不住的，明确外委

**不假装能拦**是这份清单的底线。下面这些规范 repo-guard 只负责在上下文里说出来，判定与阻断在别处：

| 规范 | 为什么插件拦不住 | 交给谁 |
| :--- | :--- | :--- |
| `CM-CODE-002` 循环依赖 | 需要全量图 + 增量判定，成本在 hook 的时间预算之外 | `import/no-cycle`、golangci-lint |
| `CM-CODE-001` 行数硬拦 | 存量超长文件遍地都是，硬拦等于没法干活 | `max-lines` lint 规则（新文件严、存量放宽） |
| `FE-I18N-001` i18n | AST 级判定，正则会把注释和测试也算进去 | `eslint-plugin-tea-i18n` |
| `FE-TYPE-001` 禁 `any` | 同上 | `tsc --strict` + CI |
| `CM-SEC-001` 密钥 | 插件只能做弱正则提醒，真正的判定要熵检测 + 历史扫描 | CI secret scan + pre-commit |
| `CM-SEC-002` 碰生产 | 插件的 deny 是黑盒，用户无法在 `/permissions` 面板里审计 | 宿主 `permissions.ask: ["Bash(kubectl:*)", "Bash(mysql:*)", ...]` |
| `CM-VCS-001` 提交门禁 | `git commit` 是**人随时会敲的动作**，插件在 `Stop` 上硬拦会直接妨碍人 | 宿主 `permissions.ask: ["Bash(git commit:*)"]` + pre-commit + CI |
| `L0-EN-002` 契约 diff | 需要对端契约，跨仓 | CI |
| `L0-EN-003` 覆盖率门禁 | 唯一能"卡住合并"的地方是流水线 | CI |
| `L0-EN-004` MR 模板 / CODEOWNERS | 平台能力 | 代码平台 |

> 一句话：**确定性规则归 lint，阻断合并归 CI，安全边界归宿主 permissions，过程中的"你现在要动的东西很贵"归插件。**

---

## 8. 接入顺序

四步，和图里的建议一致 —— 先做能独立执行的确定性检查，再做过程注入，最后才是硬拦。

| 步 | 做什么 | 产出 |
| :--- | :--- | :--- |
| 1 | 独立 lint + 体量规则 + 进 CI | 确定性规则有了硬落点 |
| 2 | pre-commit + 契约标识符 CI 断言 | 脏代码进不了主干 |
| 3 | `repo-guard init --write` 确认公共层；`standards init --write` 铺规范 | 过程注入生效（`inject` / `remind` 级） |
| 4 | 逐条开 `ask` / `block`，每开一条先看 `repo-guard governance` 的数据 | 硬拦生效，且有误伤率数据支撑 |

**不要跳到第 4 步。** 所有 `ask` / `block` 条目模板里默认 `enabled: false`，这是刻意的：一个装完就开始拦人的护栏，人的第一反应是卸载。
