# 图谱

> **一句话。** 按当前代码现算结构：谁在用、会波及谁、仓里同类怎么写。

## 说明用途

提供 impact / similar / hot / lib_search / trace / contracts / scan。过程门禁可要求本轮必须查过。写文件瞬间不建图。本仓 analyzer 为 `go-trpc`，无 UI 组件库。

## 如何配置（写在业务仓里）

1. 公共层写在 `.codebuddy/repo-facts.json` 的 `publicLayer`。
2. 新建强制查图写在 `.codebuddy/process-gates.json`。
3. `.codebuddy/standards.json` 可开后端栈。
4. CI 可挂 `repo-guard scan`。

## 字段说明

图谱本身不建 graph.json。配置散落在事实、过程门禁、规范里。

| 字段 | 文件 | 含义 |
|---|---|---|
| `analyzer` | repo-facts.json | 用哪套分析器建图 |
| `publicLayer` | repo-facts.json | 改已有文件前必须 impact 的目录 |
| `lineLimit` | repo-facts.json | scan 超长文件阈值 |
| `componentLibrary` | repo-facts.json | 无 UI 库时为 `null` |
| `newPageSimilar.enabled` | process-gates.json | 新建 handler/路由前是否强制 similar |
| `newPageSimilar.pathPatterns` | process-gates.json | 哪些新建路径算「页面/接口」 |
| `newComponentHot.enabled` | process-gates.json | 新建公共模块前是否强制 hot |
| `newComponentHot.pathPatterns` | process-gates.json | 哪些路径算公共模块 |
| `newComponentLibSearch.enabled` | process-gates.json | 新建 UI 组件前是否强制 lib_search |
| `newComponentLibSearch.pathPatterns` | process-gates.json | 哪些路径算新建组件 |
| `admission` | process-gates.json | 新建强制的总闸，false 则只填了路径也不硬拦 |
| `stacks` / `stackDetect` | standards.json | 哪一端规范注入、如何探测 |
| `check.kind: require_tool` | standards 条目 | 写匹配路径前必须先调过指定图谱工具 |

## 配置示例（10 条）

来源：`backend-agent-identity`。本仓是 Go 身份服务，没有前端 `src/pages`。

### 1. 图谱分析器

```json
{
  "analyzer": "go-trpc"
}
```

### 2. 公共层目录（改已有文件前必须 impact）

```json
{
  "publicLayer": [
    "internal/config/",
    "internal/dto/",
    "internal/utils/"
  ]
}
```

### 3. 行数上限（图谱 scan 也会用）

```json
{
  "lineLimit": 500
}
```

### 4. 无 UI 组件库

```json
{
  "componentLibrary": null
}
```

### 5. 新建 logic/service/router 前查 similar

```json
{
  "newPageSimilar": {
    "enabled": false,
    "pathPatterns": [
      "internal/logic/**",
      "service/**",
      "router/**"
    ]
  }
}
```

### 6. 新建 dto/utils 前查 hot

```json
{
  "newComponentHot": {
    "enabled": false,
    "pathPatterns": [
      "internal/utils/**",
      "internal/dto/**"
    ]
  }
}
```

### 7. 无 UI 组件目录，lib_search 路径为空

```json
{
  "newComponentLibSearch": {
    "enabled": false,
    "pathPatterns": []
  }
}
```

### 8. 规范总闸（本仓已铺）

```json
{
  "enabled": true,
  "maxSeverity": "remind",
  "injectBudgetTokens": 1500
}
```

### 9. 后端栈探测路径（本仓命中 *.go / cmd / internal）

```json
{
  "backend-service": [
    "internal/handler/",
    "internal/service/",
    "cmd/",
    "*.go",
    "src/main/java/"
  ]
}
```

### 10. 数据库栈探测（本仓有 internal/repo）

```json
{
  "database": [
    "internal/repo/",
    "internal/model/",
    "migrations/",
    "*.sql"
  ]
}
```

## 是否人审

**否。** contracts 草稿必须人看过再落库。

## 执行时机 / 原理

模型调 MCP/CLI 时建图；PreToolUse 只读本轮查过没的会话戳。空图必须报失败。本仓 `admission` 仍为 false，因此 similar/hot 的 pathPatterns 已填但默认不硬拦。
