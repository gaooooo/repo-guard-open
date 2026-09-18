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
| 3 | `node bin/verify-hooks.mjs` | 钩子回归 58 条：拦得对 **且** 不误伤 **且** 空配置零行为变化 |
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
| `npm run verify` | 只跑 20 条钩子回归 |
| `npm run verify:parity` | 只跑 69 条产物一致性 |
| `node build/verify-parity.mjs --case impact` | 只跑名字含 impact 的用例 |
| `node build/verify-parity.mjs --keep` | 保留临时 fixture 仓库，进去手动复现 |
| `node build/verify-parity.mjs --dump <目录>` | 把**旧产物**每个用例的输出写成文件。反推文案时用 |
| `node build/sync-py-source.mjs` | 改过 `py_graph.py` 之后必须跑，否则构建会失败 |

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

当前有 4 条已知偏差，跑 parity 时会打印原因。

## 基线是什么、能不能删

`build/baseline/repo-guard` 是改造前那份压缩产物的副本，**不能删**。

适配层（CLI / hook / MCP）在 deerclaw 里**没有源码** —— 它是按 `verify-hooks.mjs`
的用例契约加旧产物的字符串反推重写的。基线是唯一的黄金样本，删了 parity 就没有基准。
