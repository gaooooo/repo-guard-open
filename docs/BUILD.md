# 构建与验收

## 每次改完跑这一条

```bash
npm run check
```

它按顺序做四件事，任何一步失败就停：

| 步骤 | 命令 | 守什么 |
|---|---|---|
| 1 | `tsc --noEmit` | 类型 |
| 2 | `node build/build.mjs` | 打包 + **冒烟**（产物必须能跑起来并输出帮助） |
| 3 | `node bin/verify-hooks.mjs` | 钩子回归 59 条：拦得对 **且** 不误伤 **且** 空配置零行为变化 |
| 4 | `node build/verify-parity.mjs` | 与旧产物逐字节比对 84 条 + MCP 长连接存活 |

**只有 `npm run check` 全绿才算改完。** 单跑 `npm run build` 不够 —— 它只保证能跑起来，
不保证行为没漂。

**而 `npm run check` 全绿也不等于能发版。** 发版前必须真机装一次：

```bash
codebuddy --plugin-dir /Users/gaoxin/Documents/AI/repo-guard
```

脚本测的是"我的代码对不对"，真机测的是"宿主是不是按我以为的方式用它"。
这两者不可互相替代 —— 已经有三个 bug 是在 `check` 全绿的情况下被真机抓出来的
（MCP 与宿主死锁、拒绝文案里的工具名没带命名空间、`agents/README.md` 被当成 agent）。
详见 `docs/DESIGN.md` 的 9.5。

## 单独命令

| 命令 | 什么时候用 |
|---|---|
| `npm run build` | 只要产物，不验收（比如想先手动试一下） |
| `npm run build:dev` | 不压缩 + sourcemap。排查产物里的异常栈时用 |
| `npm run typecheck` | 只看类型 |
| `npm run verify` | 只跑 59 条钩子回归 |
| `npm run verify:parity` | 只跑 84 条产物一致性 |
| `npm run pack` | 打部门模板包（= `check` + 打包），见下一节 |
| `node build/pack.mjs --no-archive` | 只产目录不打 tar.gz，便于 diff / review |
| `node build/verify-parity.mjs --case impact` | 只跑名字含 impact 的用例 |
| `node build/verify-parity.mjs --keep` | 保留临时 fixture 仓库，进去手动复现 |
| `node build/verify-parity.mjs --dump <目录>` | 把**旧产物**每个用例的输出写成文件。反推文案时用 |
| `node build/sync-py-source.mjs` | 改过 `py_graph.py` 之后必须跑，否则构建会失败 |

## 打部门模板包

```bash
npm run pack        # = npm run check + node build/pack.mjs
```

产出 `dist/repo-guard-<版本>/` 目录与同名 `.tar.gz`。分发链是三级的：

```
本仓（源码） --pack--> 模板包 --> 部门填 templates/ --> 各项目在 .codebuddy/ 定制
```

**一条判据决定了包里该有什么**：部门拿到的包里没有 `src/`、没有 `node_modules`，
`bin/repo-guard` 是 minify 过的单文件。所以**部门需要改的一切都必须以 JSON / MD
的形式躺在包里** —— 写死在 TypeScript 里的东西他们改不了。

### 三条硬断言（都在 `build/pack.mjs` 里）

| 断言 | 为什么 |
|---|---|
| 包内**绝不含 `package.json`**（递归查） | 产物是无扩展名 CJS，Node 按最近的 `package.json` 判定模块类型。包里出现任何一个声明了 `"type": "module"` 的，产物第一行 `require` 就炸，而 hook 层 fail-open 会把错误吞掉 —— 插件表面装着、实际全放行 |
| 版本号以 `.codebuddy-plugin/plugin.json` 为准，与 `package.json` 不一致即失败 | 宿主认前者。版本对不上的包发出去，部门反馈问题时我们会对着错误的源码版本查 |
| 白名单而非黑名单 | 黑名单在仓库长出新目录时会默默把它带进包。这个包要发给别的部门，多带一份内部文档就是事故 |

### 打包后的冒烟三连

`build.mjs` 的冒烟证明"产物在本仓能跑"，而这里要证明"产物**在包的目录布局下**能跑"：

1. `node <dist>/bin/repo-guard` → 帮助输出对
2. `<dist>/bin/repo-guard standards init`（干跑）→ 验证 `templates/` 的相对位置
3. `node <dist>/bin/verify-hooks.mjs` → 59 条全绿

第 2 条是关键：`standardsTemplateDir()` 用的是 `resolve(__dirname, '..', 'templates')`，
它依赖 `bin/` 与 `templates/` 是兄弟目录。白名单里少写一行 `templates`，
产物照样启动、帮助照样打印，**只有规范会静默消失**。

> 顺带：`verify-hooks.mjs` 进包之后，部门乱填 `templates/redlines.json`
> 会被这 59 条当场抓住。那是部门侧唯一自动化的「别把大家全拦死」闸门。

### 部门侧怎么自检

包里没有 npm，所以 `npm run check` 跑不了。两条替代：

```bash
bin/repo-guard doctor       # 配置体检：JSON 坏没坏、条目会不会静默失效、注入配额
node bin/verify-hooks.mjs   # 59 条钩子回归
```

`doctor` 存在的理由：整个读配置链路都是 **fail-safe** 的（`readJson` 吞异常、
`sanitizeItem` 逐条净化、`loadGuardConfig` 退默认值）。这在运行时是对的 ——
配置语法错误不该让人的操作失败。代价是**改坏了没有任何反馈**，
部门写错一个逗号，症状只是"这几条规范不生效"。`doctor` 把这些被吞掉的错误翻出来。

## 改完什么要跑什么

| 改了 | 必须跑 |
|---|---|
| `src/**` | `npm run check` |
| `src/engine/graph/analyzers/py_graph.py` | `node build/sync-py-source.mjs` 然后 `npm run check` |
| `hooks/hooks.json` / `.mcp.json` / `.lsp.json` / `plugin.json` | `codebuddy plugin validate .` + 会话里 `/reload-plugins` |
| `skills/**` / `commands/**` / `agents/**` | 会话里 `/reload-plugins`（不用重新构建） |
| `templates/guard/**` | JSON 语法 + `repo-guard guard init` 干跑一次看文件清单对不对 |
| `src/mcp/**` | `npm run check`（parity 末尾有 MCP 长连接断言）**+ 真机装一次** |

## 组件目录里不要放 README

`agents/` `commands/` `skills/` `output-styles/` 下的每个 `.md` 都会被宿主
当成**一个组件定义**载入。`agents/README.md` 会变成一个名叫 `README` 的 agent，
出现在用户的 `/agents` 菜单里。

说明文档放 `docs/`：`docs/agents.md` `docs/commands.md` `docs/skills.md`。

## 装到会话里试

```bash
# 开发时直接加载，不用安装
codebuddy --plugin-dir /Users/gaoxin/Documents/AI/repo-guard

# 改完插件配置后热加载（不用重启）
/reload-plugins

# 看加载详情与错误
codebuddy --debug --plugin-dir ./repo-guard
```

`--plugin-dir` 与已安装的同名市场插件冲突时，本地副本在该会话中优先。

## 构建产物的三条硬要求

| 要求 | 为什么 | 谁在守 |
|---|---|---|
| 单文件、无扩展名、零外部依赖 | 插件更新会换目录，`node_modules` 留不住；hook 只有 15 秒预算，装依赖必然超时 | `build.mjs` 的 `--packages=bundle` |
| CJS 而非 ESM | `@babel/traverse` 是 CJS，ESM 下 default interop 会变成 `{default: fn}`；无扩展名文件要能直接 `node bin/repo-guard` | `--format=cjs` |
| `package.json` **绝不能加 `"type": "module"`** | 产物是无扩展名 CJS，Node 按最近的 package.json 判模块类型；声明成 module 就被当 ESM，第一行 `require` 就 `ReferenceError`，而 hook 层 fail-open 会把错误吞掉 —— 插件表面装着、实际全放行 | `package.json` 里的 `"//type"` 警告 + `build.mjs` 的冒烟 |

## parity 报 DIFF 了怎么办

**不要直接刷新基线。** 逐条判定是哪种情况：

1. **旧产物是对的，我写漂了** → 改代码
2. **旧产物有 bug，新版是对的** → 加进 `build/verify-parity.mjs` 的 `KNOWN_DEVIATIONS`，
   **必须写清差在哪、为什么不改回去**
3. **用例本身在比对一个错误行为** → 改用例（例子：`impact-abs` 原来用未解析的临时路径，
   触发了旧产物在 macOS 上的 `/private` 符号链接 bug，改成 realpath 后两侧才都有意义）

当前有 8 条已知偏差，跑 parity 时会打印原因。

## 基线是什么、能不能删

`build/baseline/repo-guard` 是改造前那份压缩产物的副本，**不能删**。

适配层（CLI / hook / MCP）在 deerclaw 里**没有源码** —— 它是按 `verify-hooks.mjs`
的用例契约加旧产物的字符串反推重写的。基线是唯一的黄金样本，删了 parity 就没有基准。
