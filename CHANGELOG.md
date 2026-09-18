# CHANGELOG

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
