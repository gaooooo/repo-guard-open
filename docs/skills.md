# skills/ —— 代理技能

技能是**模型调用**的（生效方式：【拉】）。CodeBuddy 按 `description` 判断什么时候
加载正文，正文里再指向具体工具。这是渐进式披露：不占常驻上下文。

## 现有

| 技能 | 什么时候被加载 |
|---|---|
| `code-impact` | 要改 / 重构 / 删除已存在的组件、hook、service、工具函数、接口、路由时 |
| `frontend-react` | 写 React 页面与组件时 |
| `backend-go` | 写 Go 服务时 |

## frontmatter 可用字段

| 字段 | 作用 |
|---|---|
| `name` `description` | 必填。**description 决定它会不会被加载**，比正文重要 |
| `allowed-tools` | 工具白名单，支持 `Bash(git:*)` / `Edit(src/**/*.ts)` |
| `context: fork` | 在独立上下文里跑（子代理），不污染主会话 |
| `agent` | fork 时用哪个 agent |
| `model` | fork 时用哪个模型 |
| `disable-model-invocation` | `true` = 只能人手动 `/skill-name` 触发 |
| `user-invocable` | `false` = 不在 `/` 菜单里出现，只给 AI 内部用 |
| `hooks` | **仅 `context: fork` 支持，且受 `allowUntrustedFrontmatterHooks` 闸门，默认被拒** |

## 关于 frontmatter hooks

插件分发的 Skill 里写 `hooks` 默认**不会生效** —— 用户得先在 `settings.json` 里
开 `allowUntrustedFrontmatterHooks`。

所以 repo-guard 的钩子全部走 `hooks/hooks.json`（不受闸门约束，启用即生效）。
**不要**为了图方便把钩子挪到 Skill frontmatter 里，那等于默认不生效。

## description 怎么写

这是技能唯一真正重要的部分。判据：**模型看完这句话能不能判断"现在该用它"**。

`code-impact` 的写法可以参考 —— 它列了触发词（改组件、改接口、重构、删除、影响面、
会不会影响、公共组件、复用），因为这些是人真实会说的话。
写"用于代码分析"这种描述，等于永远不会被加载。

## 待补充

| 打算做什么 | 为什么还没做 |
|---|---|
| `redline-authoring` —— 教人怎么写红线（什么该写成 protects、paths 怎么才不留后门） | 等 `audit` 在真实仓库上跑出足够多的腐烂案例，用真实案例写比编例子有用 |
| `backend-java` / `frontend-vue` | 引擎已支持这两个分析器（`java-spring` / `web-frontend` 认 .vue），但没有真实仓库验证过纪律措辞 |
| `guard-config` —— 教人配七道门 | 门本身还没接通（P4）。先教配置再实现是本末倒置 |
