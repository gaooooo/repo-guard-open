# repo-guard

> 仓库体检与影响面守卫。**零服务端**——不连任何服务、不需要令牌，规则读仓库文件。**图谱由 [code-atlas](../code-atlas) 提供**（`atlas` CLI + MCP，`npm i -g @tencent/code-atlas`）。

装完之后 AI 会做三件它以前不做的事：改公共层代码**之前**先确认影响面、写完超长文件会被提醒、想绕道用 `sed` 写公共层会被记一笔。

开发者按七层往 [`layers/`](layers/) 添加内容（工程事实 / 技能库 / 红线 / 过程门禁 / 人审 / 合并门禁 / 图谱）。分层说明见 [`docs/PLUGIN-LAYERS.md`](docs/PLUGIN-LAYERS.md)。图谱不在本仓：由 code-atlas 提供，见下方「图谱由 code-atlas 提供」。

---

## 装完之后做什么

### 1. 接入本仓（v2 开发过程控制）

先让终端能用 `repo-guard` 命令（插件市场安装后插件的 `bin/` 不在 PATH 上）。在 CodeBuddy 会话里执行一次：

```bash
node "$CODEBUDDY_PLUGIN_ROOT/bin/repo-guard" link   # 或 /repo-guard:init 时按提示执行
```

它在 `~/.local/bin` 放一个启动器，每次运行时自动使用最新安装的 repo-guard，插件升级后不用重做。

```bash
repo-guard init            # 终端交互：识别本仓 → 逐项说明会启用的控制 → 你确认 → 写入
```

或在会话里用 `/repo-guard:init`，由 AI 用提问控件逐项问你。非交互环境用 `repo-guard init --yes`（推荐值，不碰 pre-commit / CI）。

init 会告诉你并让你确认：验收命令、公共层、建议红线、要不要把合并门（`repo-guard check --staged`）加进已有的 husky / lefthook / pre-commit 或本机 git hook（**默认不加**；CI 配置不自动改，只给可复制的步骤）。结果写进 `.codebuddy/repo-guard.json`，提交进 git 团队共享。

接入后每次会话自动生效：

| 环节 | 做什么 | 默认 |
|---|---|---|
| 开发基线 | 会话开始注入 6 行最简实现约定 | 注入 |
| 任务契约 | 写第 2 个文件前要求 AI 调 `guard_task` 声明目标 / 不做什么 / 范围 / 验收 | 拒绝一次 |
| 写时控制 | 越界、新建前没查 atlas、本次新增函数过长过深参数过多、连续失败 | 写后提醒 |
| 红线 | 受保护路径 / 危险命令按每条的 action（remind / ask / block） | 按规则 |
| 改动回执 | 结束时列出改了什么、越界、体量、复杂度、查重、噪声、验没验证、顺手发现 | 展示，有问题让 AI 逐条说明 |

```bash
repo-guard status          # 当前生效的控制、档位、值来自哪一层、合并门、图谱
repo-guard receipt         # 当前会话的改动回执
repo-guard check --staged  # 合并门（--base <分支> 给 CI 用）
```

想收紧时把 `.codebuddy/repo-guard.json` 的 `mode` 改成 `enforce`（先跑一段时间看 `repo-guard governance` 的误伤数据）。完整设计与字段说明见 [`docs/DESIGN-v2.md`](docs/DESIGN-v2.md)。

### 2. 确认公共层

⚠️ **公共层是推测出来的，一定要人过一眼。** 各仓目录约定不一样，猜错要么漏拦、要么天天误伤——后者会让人直接卸载。改 `.codebuddy/repo-guard.json` 的 `publicLayer` 即可（旧的 `repo-facts.json` 会在 init 时迁移过来）。前后端分仓可加 `--with ../backend --ws 项目名`，把相关仓放进同一图谱工作区。

### 3. （可选）配红线

配完跑一次 `repo-guard audit` —— 它会告诉你规则有没有腐烂。


`.codebuddy/redlines.json`：

```json
{ "rules": [
  { "id": "RL-001",
    "paths": ["src/api/**"],
    "rule": "这个接口有外部调用方，改名等于让对方 404",
    "confirmed": true }
] }
```

红线是**人写的意图**，代码里读不出来（"外部仍有调用方"静态分析推不出来），所以必须进 git，跟代码走同一个 PR。

⚠️ **手写的规则会腐烂，而且人 review 发现不了。** reviewer 能判断「这条该不该加」，但验证不了「paths 写全了没」「evidence 行号还准不准」「protects 的符号是不是早就改名了」。所以配完红线要跑 `audit`：

```
✗ RL-001  上链状态字段不能删
    有 1 处出现位置不在声明的 paths 内 —— 这些位置是后门，agent 在那里改动不会被拦
      ⚠ src/common/chain.ts:1
      建议补进 paths: src/common/*.ts
✗ RL-002  这个常量不能改名
    受保护标识符在代码与 SQL 里都找不到 —— 这条红线在守空气，应删除或更正
```

**人写意图，机器验完整性。**

### 4. （可选）铺研发规范

```bash
repo-guard standards init --write
```

生成 `.codebuddy/standards/`：五端（L0 跨端契约 / 全端共用 / 前端 / 后端 / 数据库 / 消息队列）约 45 条规范。

两层：**全局层**在插件里（`layers/skills/standards/`，改它 = 定制部门模板），**项目层**在仓库里（按条目 `id` 字段级覆盖，要进 git）。

`maxSeverity` 默认 `remind` —— **铺完不会有任何新的拦截**。想开硬拦先看 `repo-guard governance` 的数据。

```bash
repo-guard standards list                      # 生效清单：哪些端、哪一层、实际强度
repo-guard standards check src/views/a.tsx     # 自查：这个文件违反了什么
repo-guard standards audit                     # 体检：有没有守空气、有没有被静默降级
```

⚠️ **纯前端仓要把 `standards.json` 的 `stacks.database` 与 `stacks.message-queue` 设成 `off`。**「字段」一词在前端指接口出入参、在数据库那边指 schema，两套门禁同时触发会导致前端改个接口被要求写 migration。

规范内容清单见 [`docs/STANDARDS.md`](docs/STANDARDS.md)，落点机制见 [`docs/CONTROL-POINTS.md` §14](docs/CONTROL-POINTS.md)。

### 5. 重开会话

插件在会话启动时加载，**必须重开会话才生效**。

---

## 命令

| 命令 | 干什么 |
|---|---|
| `init [--yes \| --plan --json \| --apply <JSON> \| --merge-gate <位置>]` | 接入：识别、告知、确认、写 `.codebuddy/repo-guard.json`；可选加合并门 |
| `link [--dir 目录]` | 把 `repo-guard` 命令放到终端可用的位置（默认 `~/.local/bin`） |
| `status` | 当前生效的控制与来源 |
| `receipt` | 当前会话的改动回执 |
| `scan` | 体量与结构：超长文件、循环依赖（转调 `atlas scan`）。**有问题非零退出**，可挂 CI |
| `check --staged \| --base <分支>` | 合并门：用回执同一套规则检查 diff；红线 block（及 enforce 档的问题）非零退出 |
| `check <文件…>` | 改动自查：碰没碰公共层和符号级红线 |
| `lib search <要什么>` | 本仓 UI 组件库里有没有现成的 |
| `audit` | **红线体检**：规则在不在守空气、paths 有没有后门、evidence 还准不准 |
| `redlines init [--write]` | 把部门红线模板铺进 `.codebuddy/redlines.json` |
| `doctor` | **配置体检**：JSON 坏没坏、条目会不会静默失效、注入配额还剩多少 |
| `governance` | 治理留痕报表：这些门在做有用功还是在骚扰人 |
| `guard init [--write]` | 铺开协作全景七道门的配置骨架（全部默认关，尚未接进运行时） |
| `standards list [--stack <端>]` | 研发规范生效清单：哪些端启用、来自哪一层、实际强度是多少 |
| `standards check <文件…>` | **规范自查**：这些文件违反了什么。人审/硬拦级非零退出，可挂 CI |
| `standards init [--write]` | 铺开五端研发规范模板（默认只提醒，不拦） |
| `standards audit` | **规范体检**：有没有守空气、有没有被静默降级、项目层放宽有没有留理由 |
| `mcp` | 作为 stdio MCP 给 AI 用（宿主自动拉起，不用手动跑） |
| `hook <name>` | 插件钩子（宿主调用） |

图谱命令 `impact / hot / trace / similar / contracts / conform / viz` 已移交 code-atlas，用同名的 `atlas <命令>`。

挂进流水线：

```bash
repo-guard scan || exit 1
```

---

## 它拦什么、不拦什么

| 行为 | 结果 |
|---|---|
| 改公共层**已有**文件，本轮没查过影响面 | **拒绝**，并告诉它去调哪个工具 |
| 改公共层文件，已经查过影响面 | 放行 |
| **新建**公共层文件 | 放行 |
| 改普通业务文件 | 放行 |
| 写完的文件超过行数上限 | 提醒，不拒绝 |
| 用 `sed`、重定向等写公共层 | 提醒 + 计数，**不拒绝**（拦 shell 误伤率太高） |
| 本仓还没跑过 `init` | **全部放行**，并在会话开始时说明守卫未生效 |
| 写完的文件命中研发规范（色值 / `any` / 硬编码中文 / 裸 goroutine…） | 提醒，带行号，**不拒绝** |
| 改动删除了规范声明的受保护字段 | 按 `maxSeverity` 决定。默认 `remind` = 只提醒 |
| 本仓没铺 `.codebuddy/standards/` | 规范**完全不参与**运行时，插件行为与接入规范前逐字节相同 |

最后两条是有意的：**没有配置就不拦**，绝不能因为工具没配好就把人挡在外面；
规范也一样 —— 全局层跟着插件走，但只有仓库里铺了项目层才算团队表了态。

---

## 自检

```bash
node bin/verify-hooks.mjs
```

自建临时仓库跑 58 条用例，覆盖拦截、放行、路径归一、不误伤同名前缀目录、未配置时 fail-open、坏输入不崩、七道门逐门验、空配置零行为变化。**不碰任何真实仓库。**

改过钩子逻辑就跑一遍——证明「拦得对」容易，证明「不误伤」才是难的。

---

## 从源码构建

这个插件是**源码版**：`bin/repo-guard` 是构建产物，源码在 `src/`。

```bash
npm install
npm run check      # 改完只需要跑这一条
```

`npm run check` 依次运行类型检查、构建冒烟、钩子回归、事实初始化和图谱接入专项回归。图谱专项需指定工具包，未找到时会明确 SKIP，不能声称图谱接入已验证。

只跑 `npm run build` 不够 —— 它只保证产物能跑起来，不保证行为没漂。

## 分发给其他部门

```bash
npm run pack        # = npm run check + 打包，产出 dist/repo-guard-<版本>/ 与 .tar.gz
```

包里**没有 `src/`、没有 `node_modules`**，引擎是 minify 过的单文件。所以判据很明确：
**部门需要改的一切，都以 JSON / MD 的形式躺在 `layers/` 里。**

部门解压后读 [`layers/CONFIG.md`](layers/CONFIG.md) —— 它列全了两层所有可填点。
填完在包内跑自检，两条都不需要 npm：

```bash
bin/repo-guard doctor       # 配置体检
node bin/verify-hooks.mjs   # 83 条钩子回归，确认填的红线没把正常写文件也拦了（图谱相关几条需要 atlas）
```

部门可以在条目上写 `override_policy: "locked"` 限定各项目能改到什么程度。

| 目录 | 是什么 |
|---|---|
| `src/engine/` | 红线判定。禁止改打分，见 PORTING.md |
| `src/atlas/` | 调外部 `atlas` CLI 的客户端（图谱全部来自 code-atlas） |
| `src/runtime/` | 仓库定位、配置读写、会话状态、埋点 |
| `src/cli/` `src/hooks/` `src/mcp/` | 三个入口。共用一个二进制，因为它们要共享会话状态 |
| `build/` | 构建、打包脚本与 init 回归 |
| `layers/process-gates/` | 协作全景七道门的配置骨架，全部默认关 |
| `layers/skills/standards/` | 五端研发规范标准模板（全局层），`src/standards/` 是它的加载与合并 |

完整构建说明见 [`docs/BUILD.md`](docs/BUILD.md)，设计与控制点映射见 [`docs/DESIGN.md`](docs/DESIGN.md)，
多仓：从放着几个仓的父目录打开会话时，钩子按被改文件所在仓的配置判（CLI 仍按 cwd），见 [`docs/MULTI-REPO.md`](docs/MULTI-REPO.md)。

---

## 图谱接入：只用 code-atlas 工具包

repo-guard 只编排开发过程，不解析代码、不复制图谱算法、不读取 Atlas 内部数据库。影响面、同类/复用、链路、契约、review 和可视化均由 code-atlas 提供。红线/门禁配置不在本轮调整范围。

### 一次绑定，所有入口使用同一工具包

本地源码工具包示例（其他开发者换成自己的安装目录）：

~~~bash
node bin/repo-guard atlas bind /Users/gaoxin/Documents/AI/code-atlas --node /Users/gaoxin/.nvm/versions/node/v22.12.0/bin/node
node bin/repo-guard atlas status
~~~

已安装 npm 包时，可用 `repo-guard atlas bind` 自动发现当前 PATH 上的安装并保存绝对路径。绑定保存在本机 `$HOME/.repo-guard/atlas.json`，不进业务仓 Git。显式绑定失效会报错，不偷偷换到 PATH 上另一版本；移动工具包、切换 Node 后重新绑定。

插件 `.mcp.json` 通过 `repo-guard atlas mcp` 启动真正的 Atlas MCP，stdio 透传、不重定义工具。绑定后重开助手会话。若此前单独用过 `atlas install`，请在助手中检查实际 code-atlas MCP 的来源与路径，避免项目/用户/插件注册不同版本；不会自动删已有接入。

### 初始化业务工程

~~~bash
# 从目标业务仓运行；init 默认预览，不隐式建图
repo-guard init
repo-guard init --write --ws myproject --with ../backend
~~~

- 已登记且缓存有效：由 Atlas 复用；代码或缓存版本变化：由 Atlas 更新。
- `--with` 可重复，只登记相关仓，不改兄弟仓的治理配置。
- 本仓只属于一个工作区时自动复用；多个工作区需 `--ws` 明确选择一次，选择保存在本机绑定中。
- 不自动安装或升级工具包；缺少 Atlas 会明确提示，图谱不可用不等于已经验证。

### 日常使用

| 开发时机 | AI 原生 MCP | 人的统一 CLI |
|---|---|---|
| 修改已有代码前 | atlas_impact | repo-guard atlas impact '文件#符号' |
| 新页面/接口前 | atlas_reuse，kind=similar | repo-guard atlas similar 需求 |
| 新方法/组件前 | atlas_reuse，kind=reuse | repo-guard atlas hot 需求 |
| 理解请求链路 | atlas_trace | repo-guard atlas trace 接口名 |
| 写完、提交前 | atlas_review | repo-guard atlas review --ws myproject |
| 联调字段 | atlas_contracts，check=true | repo-guard atlas contracts --check |
| 可视化 | /repo-guard:graph | repo-guard atlas viz --ws myproject --open |

多工作区显式传 `--ws`；trace 在目标工程目录运行，不支持 `--repo`。完整原生参数见 code-atlas 的 docs/USAGE.md。未全局安装 repo-guard 时将命令前缀换成 `node /插件目录/bin/repo-guard`。

### 查询留痕与边界

Atlas 的影响面、链路、热点/复用、同类查询输出机器回执（CLI JSON 的 receipt / MCP 的 structuredContent.receipt）。repo-guard 只消费状态、实际仓/目标和已有参考计划，不靠工具入参或文本猜结果。失败、目标未匹配、歧义、旧版无回执不产生成功查询凭据。trace 不冒充 impact。

统一 CLI 直接记查询回执；MCP 由 post-atlas 记。简单的成功原生 CLI 查询由 post-bash 只读缓存核验；复杂 shell 不作凭据，建议使用统一 CLI。写后 conform 延续既有 Stop 接线，不在本轮重新设计门禁。

图谱查询与缓存由外部包维护。普通查询会检查更新，写前 Hook 不建图。未配置的旧门禁策略保持不变：即使 Atlas 缺失，已有公共层守卫仍可能要求查询；请先完成绑定。

图谱是静态分析，**影响面为 0 不等于可以删除**。review 不替代运行测试，也不保证工作区外调用方安全。

专项回归：
~~~bash
REPO_GUARD_ATLAS_BIN=/path/to/code-atlas/bin/atlas node bin/verify-atlas.mjs
~~~

---

## 运行要求

机器上有 Node 18+。repo-guard 自身为单文件产物，不需要运行时 npm 依赖；图谱需要完整 code-atlas 工具包、对应 CodeGraph 平台依赖与资源。

本插件会调用 `git` 与绑定的 code-atlas 子进程；图谱平台依赖和环境检查以 `repo-guard atlas doctor` 为准。

源码分析与图谱存储在本机，不上传源码。code-atlas 交互式命令可能检查版本元数据，完全离线时设置 `ATLAS_NO_UPDATE_CHECK=1`；安装包下载和版本检查不等于图谱服务。