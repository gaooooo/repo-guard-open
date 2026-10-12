# 组件规范

> **一句话。** 用哪套库、什么时候允许新建、公共组件怎么改。

## 说明用途

这是**前端**规范。内部组件库不在模型训练数据里，凭 antd / MUI 写 props 几乎一定是错的。

1. **用哪套库**：以 `repo-facts.componentLibrary` 为准，禁止再引第二套。
2. **props 以 MCP 为准**：写组件前必须查 `componentMcp` 的文档/API；`lib_search` 只回答「库里有没有」。不要凭 antd / MUI 记忆写内部库。
3. **何时允许新建**：先 `lib_search`，再 `hot`；库里没有、仓里也不能复用，才自己写。
4. **改已有公共件**：先 `impact`；波及入口 ≥ 5 只加可选 prop，不改签名、不改默认行为。

## 如何配置（写在前端仓里）

1. `.codebuddy/repo-facts.json`：`componentLibrary`、`componentMcp`、`publicLayer`。
2. 项目根 `CODEBUDDY.md` 写明包名以 repo-facts 为准、API 以 MCP 为准。
3. `.codebuddy/process-gates.json`：`newComponentLibSearch` / `newComponentHot`；硬拦还要 `admission: true`。
4. 规范条目在插件 `frontend-web.json`；项目层 `.codebuddy/standards.json` 只改开关。
5. 下面 JSON 来自前端仓 `saas-web`。

## 字段说明

| 字段 | 文件 | 含义 |
|---|---|---|
| `componentLibrary` | repo-facts.json | UI 组件库 npm 包名 |
| `componentMcp` | repo-facts.json | 组件文档 MCP 在宿主里的注册名，须与宿主一致 |
| `publicLayer` | repo-facts.json | 公共组件目录；改已有文件前必须 impact |
| `newComponentLibSearch.enabled` | process-gates.json | 新建组件前是否强制 lib_search |
| `newComponentLibSearch.pathPatterns` | process-gates.json | 哪些路径算「新建组件」 |
| `newComponentHot.enabled` / `pathPatterns` | process-gates.json | 新建公共模块前是否强制 hot |
| `admission` | process-gates.json | 硬拦总闸。false 则只填了路径也不硬拦 |
| `check.kind: require_tool` | standards 条目 | 写前必须先调过 lib_search / hot / impact |
| `stacks.frontend-web` | standards.json | `on` / `off` / `auto` |

## 配置示例（10 条）

1～7 为 `saas-web` 原文；8～10 按本仓 Tea 前端语义补全规范条目（项目层尚未覆盖这些 id）。

### 1. `.codebuddy/repo-facts.json`

```json
{
  "version": 1,
  "analyzer": "web-frontend",
  "publicLayer": [
    "src/components/",
    "src/utils/",
    "src/hooks/",
    "src/services/"
  ],
  "componentLibrary": "@tencent/tea-component",
  "lineLimit": 500,
  "generatedAt": "2026-09-21T14:00:22.604Z",
  "componentMcp": "garden-mcp-component"
}
```

### 2. 项目根 `CODEBUDDY.md`（组件相关句）

```markdown
- 组件库包名以 `repo-facts.componentLibrary` 为准；不要凭其它库的记忆写 props。
```

### 3. 公共层含组件目录

```json
{
  "publicLayer": [
    "src/components/",
    "src/utils/",
    "src/hooks/",
    "src/services/"
  ]
}
```

### 4. 新建组件前 lib_search（路径已填，enabled 仍为 false）

```json
{
  "newComponentLibSearch": {
    "enabled": false,
    "pathPatterns": [
      "src/components/**"
    ]
  }
}
```

### 5. 新建公共模块前 hot

```json
{
  "newComponentHot": {
    "enabled": false,
    "pathPatterns": [
      "src/components/**",
      "src/utils/**",
      "src/hooks/**",
      "src/services/**"
    ]
  }
}
```

### 6. 新建页 similar

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

### 7. 前端栈开关与探测

```json
{
  "frontend-web": "auto",
  "stackDetect": [
    "src/views/",
    "src/pages/",
    "src/components/",
    "*.tsx",
    "*.vue"
  ],
  "maxSeverity": "remind"
}
```

### 8. （补全）禁止第二套库 FE-LIB-001

```json
{
  "id": "FE-LIB-001",
  "title": "禁止再引入 antd / MUI",
  "paths": [
    "package.json",
    "src/**"
  ],
  "severity": "remind"
}
```

### 9. （补全）新建前查库 FE-LIB-002

```json
{
  "id": "FE-LIB-002",
  "check": {
    "kind": "require_tool",
    "tool": "lib_search"
  },
  "paths": [
    "src/components/**"
  ],
  "severity": "block"
}
```

### 10. （补全）改公共件先 impact FE-LIB-003

```json
{
  "id": "FE-LIB-003",
  "check": {
    "kind": "require_tool",
    "tool": "impact"
  },
  "paths": [
    "src/components/**"
  ],
  "body": "受影响入口 ≥ 5 时只加可选 prop，不改签名、不改默认行为"
}
```

## 是否人审

**否（用法）。** 破坏性改签名走人决策。本仓 `admission: false`，新建强制尚未硬拦。

## 执行时机 / 原理

开场注入包名与 MCP 名。写前过程门禁 / require_tool 可硬拦未查库。MCP 在模型调工具时拉文档。`lib_search` 只回答有没有，具体 props 以 `garden-mcp-component` 为准。
