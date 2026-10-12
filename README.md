# repo-guard

> 仓库体检与影响面守卫。**零服务端**——不连任何服务、不需要令牌，规则读仓库文件。**图谱由 [code-atlas](../code-atlas) 提供**（`atlas` CLI + MCP，`npm i -g code-atlas`）。

装完之后 AI 会做三件它以前不做的事：改公共层代码**之前**先确认影响面、写完超长文件会被提醒、想绕道用 `sed` 写公共层会被记一笔。

开发者按七层往 [`layers/`](layers/) 添加内容（工程事实 / 技能库 / 红线 / 过程门禁 / 人审 / 合并门禁 / 图谱）。分层说明见 [`docs/PLUGIN-LAYERS.md`](docs/PLUGIN-LAYERS.md)。图谱不在本仓：由 code-atlas 提供，见下方「图谱由 code-atlas 提供」。

---

## 装完之后做什么

### 1. 跑一次体检

```bash
repo-guard init
```

它会告诉你：这个仓是什么技术栈、多少文件超行数上限、有没有循环依赖、检查命令和流水线缺哪几步、以及**推测的公共层目录和推测依据**。

**一个字节都不会写。** 想生成配置再加 `--write`。

### 2. 确认公共层，生成配置

```bash
repo-guard init --write
```

生成 `.codebuddy/repo-facts.json`（公共层清单、行数上限），并往 `.gitignore` 追加缓存目录。

⚠️ **公共层是推测出来的，一定要人过一眼。** 各仓目录约定不一样，猜错要么漏拦、要么天天误伤——后者会让人直接卸载。打开 `repo-facts.json` 改 `publicLayer` 即可。

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
| `init [--write]` | 体检 + 生成配置 |
| `scan` | 体量与结构：超长文件、循环依赖（转调 `atlas scan`）。**有问题非零退出**，可挂 CI |
| `check <文件…>` | 改动自查：碰没碰公共层和红线 |
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

`npm run check` 按序做四件事，任一失败即停：类型检查 → 打包（含冒烟）→ 58 条钩子回归 → 84 条与旧产物的逐字节比对。

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

## 图谱由 code-atlas 提供

repo-guard 不再自带图谱引擎。影响面、同类实现、热点、接口契约、体量体检、写后比对、可视化全部由 code-atlas 提供：

| 谁用 | 怎么用 |
|---|---|
| AI | 插件 `.mcp.json` 同时注册了 `code-atlas` MCP，工具名 `mcp__code-atlas__atlas_impact / atlas_trace / atlas_explore / atlas_reuse / atlas_contracts / atlas_workspace` |
| 人 | `atlas impact <文件#符号>`、`atlas hot`、`atlas similar`、`atlas trace`、`atlas viz --open` 等 |
| 钩子 | 子进程调 `atlas … --json --cache-only`（钩子里禁止建图，缓存缺失就放行） |

守卫怎么知道 AI「查过了」：PostToolUse 钩子 `post-atlas` 在 AI 调完 `atlas_impact / atlas_reuse / atlas_trace` 后把查过的文件 / 资源记进会话状态；
AI 在终端里跑 `atlas impact|similar|hot` 时由 `post-bash` 识别。Stop 时的写后比对调 `atlas conform`。

- 安装：`npm i -g code-atlas`。`repo-guard init` 发现本仓不在 atlas 工作区时会先 `atlas add` 建索引。
- 没装 atlas：会话开始会明说「图谱相关守卫未生效」；公共层守卫照常拦，但 AI 查不了影响面。
- 测试或未全局安装时可设 `REPO_GUARD_ATLAS_BIN=<code-atlas>/bin/atlas`。

> ⚠️ **影响面为 0 不等于可以删。** 动态 import、样式引用、运行时拼接的路径、SQL、离线任务、其它服务都可能在图谱之外。

---

## 运行要求

机器上有 Node 18+。引擎已打包进 `bin/repo-guard`（约 840 KB 单文件），**没有任何外部依赖，不装 npm 包、不下载东西、内网可用**。

只在两处会起子进程，都是可选的：`git`（读 HEAD 做缓存新鲜度判断，没有就退到只看文件 mtime）、`python3`（Python 仓的分析器，没有就只是 Python 仓建不出图）。

**零出网**：产物里没有 `node:http(s)`、没有 `fetch`、没有任何真实 URL，也不读任何令牌。
