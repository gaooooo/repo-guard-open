# UI 规范

> **一句话。** 怎么按本仓设计规范落地页面。

## 说明用途

这是**前端**规范。机器能提醒别写裸色值；像不像稿只问人，不硬拦。

1. **权威源**：Figma 还是原型，听仓库写死的那个；两个源不一致不要自己折中，拿不到就问。
2. **只用本仓 token**：颜色/间距/字号走主题变量，不要写 `#xxx`、不要对着稿估一个近似值。
3. **四件套要齐**：有数据请求的页面，空态 / 加载 / 异常 / 栅格不能只写 happy path。
4. **写完可以提醒**：裸色值、硬编码文案 → 写后 remind；真要禁死走 lint，不在写前 deny。
5. **还原稿**：插件做不了像素对比，拿不准就停下来问人。

## 如何配置（写在前端仓里）

1. `CODEBUDDY.md` 写死设计稿 URL 与 token 文件路径。
2. `.codebuddy/rules/` 按路径注入（改 tsx/css 才出现）。
3. `.codebuddy/standards.json` 的 `maxSeverity` 与 `stacks.frontend-web`。
4. FE-UI-001/002/003 在插件全局层；项目层按 id 覆盖。
5. 下面 1～4 来自 `saas-web` 原文；5～10 为该前端仓补全（本仓尚未写 Figma/token 路径）。

## 字段说明

| 字段 | 文件 | 含义 |
|---|---|---|
| 设计稿权威源 | CODEBUDDY.md | Figma 或原型，听谁的写死 |
| token 路径 | CODEBUDDY.md / rules | 色值/间距从哪张表来 |
| rules 的 paths | .codebuddy/rules/*.md | 改哪些文件时才注入 token 说明 |
| `maxSeverity` | standards.json | `remind` 时 UI 条目不会 block |
| `stacks.frontend-web` | standards.json | `auto` 时有 tsx/views 则启用 |
| FE-UI-001 | standards 条目 | 写后扫描裸色值 |
| FE-UI-002 | standards 条目 | 权威源 inject |
| FE-UI-003 | standards 条目 | 空态/加载/异常/栅格 inject |
| 还原稿 | 人审 | 插件不做像素对比 |

## 配置示例（10 条）

### 1. 本仓真实：前端分析器 + 页面/组件目录

```json
{
  "analyzer": "web-frontend",
  "publicLayer": [
    "src/components/",
    "src/utils/",
    "src/hooks/",
    "src/services/"
  ]
}
```

### 2. 本仓真实：Tea 组件库（页面落地仍走这套视觉）

```json
{
  "componentLibrary": "@tencent/tea-component",
  "componentMcp": "garden-mcp-component"
}
```

### 3. 本仓真实：新建页 similar 指向 src/views

```json
{
  "newPageSimilar": {
    "enabled": false,
    "pathPatterns": [
      "src/views/**"
    ]
  }
}
```

### 4. 本仓真实：前端规范 auto + remind

```json
{
  "enabled": true,
  "maxSeverity": "remind",
  "frontend-web": "auto",
  "stackDetect.frontend-web": [
    "src/views/",
    "src/pages/",
    "src/components/",
    "*.tsx",
    "*.vue"
  ]
}
```

### 5. （补全）CODEBUDDY.md 写死设计稿权威源

```markdown
- 设计稿权威源：https://figma.com/file/<本仓文件 id>（不要同时参考另一份 HTML 原型）
```

### 6. （补全）token 文件路径

```markdown
- token 文件：src/theme/tokens.ts（颜色/间距/字号只走主题变量，禁止裸色值）
```

### 7. （补全）按路径注入 rules

```yaml
paths:
  - src/**/*.tsx
  - src/**/*.css
  - src/**/*.less
```

### 8. （补全）FE-UI-001 写后扫描裸色值

```json
{
  "id": "FE-UI-001",
  "severity": "remind",
  "timing": [
    "post_write"
  ],
  "title": "禁止裸色值"
}
```

### 9. （补全）FE-UI-003 四件套

```json
{
  "id": "FE-UI-003",
  "severity": "inject",
  "title": "空态/加载/异常/栅格必须齐"
}
```

### 10. （补全）还原稿只问人，不要写成 deny

```json
{
  "id": "FE-UI-LOOKALIKE",
  "severity": "inject",
  "landing": [
    "human"
  ],
  "title": "像不像稿停下来问人"
}
```

## 是否人审

**是（仅权威源打架 / 找不到 token / 像不像稿）。** 裸色值默认只 remind。

## 执行时机 / 原理

SessionStart 注入权威源与四件套。PostToolUse 写后 remind 裸色值。写前不挂 UI 提醒。像素对比插件做不了。
