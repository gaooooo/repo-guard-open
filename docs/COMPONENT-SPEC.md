# 组件规范说明（前端 · AI）

组件规范回答：**用哪套库、什么时候允许新建、公共件怎么改。**

落点是 **工程事实 + 组件库 MCP**，不是单独一类 JSON。长文在 `skills/frontend-react`，包名锁在 `repo-facts.json`，写前拉 `lib_search` / `hot`，改已有公共件先 `impact`。

---

## 一句话

包名锁死剪进事实；写前先查库、再查仓内高扇入；改公共件只增可选、先查影响面。**不要凭 antd / MUI 的记忆写内部库 props。**

---

## 和别的层怎么分

| 层 | 组件规范用它干什么 |
|---|---|
| 工程事实 | `componentLibrary` 包名；公共层目录。SessionStart 推一句「只用这个库」 |
| 图谱 MCP | `lib_search`（库里有没有）、`hot`（仓内高扇入）、`impact`（改已有件波及谁） |
| 过程门禁 | 新建组件可强制本轮查过 lib_search / hot（默认关，要写 pathPatterns） |
| 技能库 | `frontend-react`：为什么必须查、没装工具时读类型定义 |
| 规范 JSON | `FE-LIB-001/002/003`：锁死第二套库、新建先查、≥5 入口只加可选 prop |
| 红线 / 人审 | 一般不写组件用法。破坏性改签名停下来问人，走 stopConditions 或人确认 |

没有「组件规范.md」这一槽。包名进事实，用法靠拉 MCP，硬拦靠门禁/规范。

---

## 三条纪律

1. **用哪套库**
   以 `repo-facts.componentLibrary` 为准（init 推测、人过一眼）。禁止因为「那个库这个组件更好用」再引入第二套。
2. **何时允许新建**
   先 `lib_search`（intent 如「多选下拉」），再 `hot`。库里没有、仓里也不能复用，才自己写。抽象提问同样要查，不能因为没提到文件路径就跳过。
3. **改公共件**
   已有文件在公共层 → 先 `impact`。受影响入口 ≥ 5：只加**可选** prop，不改签名、不改默认行为、不把可选改必填。

内部组件库不在训练数据里。凭 antd / element / MUI 写出来的 props 几乎一定是错的，组件名也可能根本不存在。

---

## 现在机器能做什么

| 能力 | 默认 | 说明 |
|---|---|---|
| 事实注入「包名以 repo-facts 为准」 | 有 `repo-facts` 就会推 | 不硬拦 import |
| MCP `lib_search` / `hot` / `impact` | 拉 | 要人来调；描述里已经写了「别凭 antd 记忆」 |
| 公共层已有文件未查 impact → deny | **开** | 过程门禁核心，不单属于组件 |
| 新建组件未查 lib_search / hot → deny | **关** | `process-gates.json` 的 `newComponentLibSearch` / `newComponentHot`，必须填 pathPatterns |
| `FE-LIB-002/003` block + require_tool | 规范 `maxSeverity` 出厂 `remind` | 想硬拦要项目层把 maxSeverity 调上去，且铺了 `.codebuddy/standards/` |
| `FE-LIB-001` 禁止第二套库 | ask/remind 视 maxSeverity | `check.kind` 目前是 none，主要靠注入 + lint，不是完整锁 package.json |

所以：查库这件事，**工具已经有了**；「新建必查」要你开闸。没开闸时，靠 skill 和开场注入自觉。

---

## 怎么配

1. `repo-guard init --write` 生成公共层；`repo-guard guard init --write` 从 package.json 识别 `componentLibrary`（Go 仓保持 null）
2. 若用 Tea：确认 `componentMcp` 等于宿主里实际注册的 MCP 名（默认 `garden-mcp-component`）。写组件前注入会要求先查这个 MCP 的文档/props；`lib_search` 只回答「库里有没有」
3. CODEBUDDY.md 留一句：包名以 repo-facts 为准，组件 API 以 componentMcp 为准，不要凭其它库记忆写 props
4. 需要硬拦新建：打开 `admission`，把 `newComponentLibSearch` / `newComponentHot` 的 enabled 设为 true（pathPatterns 一般已由 init 填好）
5. 需要规范级 block：项目层 `standards.json` 提高 `maxSeverity`，并铺 standards
6. 写组件任务走 `frontend-react` + `code-impact` skill，并调用组件文档 MCP

