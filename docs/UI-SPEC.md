# UI 规范说明（前端 · AI）

UI 规范回答：**怎么按本仓设计规范落地页面。**

设计稿路径、token 路径剪进**工程事实**（常驻或按路径 rules）。禁止裸色值、空态/加载/异常要齐，靠注入 + **写后提醒**。
「像不像稿」只问人，机器不硬拦。

---

## 一句话

权威源和 token 表是事实；落地时用 token、四件套写齐；色值/文案写完可以提醒。像素级像不像稿，插件判不了，停下来问。

---

## 和别的层怎么分

| 层 | UI 规范用它干什么 |
|---|---|
| 工程事实 | 设计稿听谁的（Figma 还是原型）、token 文件路径。短句进 CODEBUDDY.md；改 css/tsx 时再注 `rules/ui-tokens.md` |
| 规范 JSON | `FE-UI-001` 裸色值写后 remind；`FE-UI-002` 权威源 inject；`FE-UI-003` 四件套 inject |
| 过程门禁 | 不拦「好不好看」。PreToolUse 不挂 UI 提醒 |
| 人审 | 两个设计源打架、找不到 token、拿不准像不像稿 → 问人 |
| 组件规范 | 用哪套组件库；UI 规范不管包名 |
| 合并门禁 | 真正禁 any / 色值策略可归 lint，不在 Stop 硬拦 |

没有独立的「UI 规范」配置目录。事实管路径，规范 JSON 管提醒，像不像稿归人。

---

## 三条纪律

1. **权威源写死**
   Figma 还是 HTML 原型，听项目层写死的那个。两个源不一致不要自己折中。拿不到就问，不要对着截图目测。
2. **只用本仓 token**
   颜色、间距、圆角、字号走主题 token。不要写 `#xxx` / `rgb()`，也不要从稿上估一个近似值。找不到对应 token 就停。
3. **空态 / 加载 / 异常 / 栅格要齐**
   有数据请求的页面只写 happy path，真实数据下必然炸。

「像不像稿」：机器没有设计稿像素对比。不要用 hook deny 假装能判。

---

## 现在机器能做什么

| 能力 | 强度 | 说明 |
|---|---|---|
| SessionStart 注入 FE-UI-002/003 | inject | 知道有权威源和四件套；正文按任务再给 |
| 按路径注入 `layers/facts/rules/ui-tokens.md` | T6 | 改 tsx/css 时才出现，避免根事实膨胀 |
| 写后扫字面色值 `FE-UI-001` | **remind** | PostToolUse 提醒，不 deny |
| 裸色值 / 硬编码中文 | 提醒 | 真正禁掉走 lint，不在写前硬拦 |
| 像不像稿 | **不问机器** | landing: human |

出厂 `maxSeverity: remind`：即使有人把 UI 条目标成 block，也会被压成提醒——色值正则判不出「是不是设计 token 的合法例外」，硬拦必误伤。

---

## 怎么配

1. 在 CODEBUDDY.md 写死：设计稿权威源 URL/路径、token 文件路径
2. 需要时把 `layers/facts/rules/ui-tokens.md` 拷到项目 `.codebuddy/rules/`，填本仓 token 表路径
3. 铺 standards 后，写完带裸色值的 tsx/css 会收到 remind
4. 想禁死裸色值：上 lint，不要指望 PreToolUse
5. 模型拿不准像不像稿：停下来问，不要让它「先写一个接近的」

