# 工程事实

> **一句话。** 把代码里读不出来、但 Agent 每次干活都必须看见的短事实写进仓库，开场自动注入，不拦写入。

## 说明用途

让模型一进会话就知道：这个仓是什么、公共层在哪、分层怎么走、密钥从哪来。步骤、红线、先查图都不放这里。公共层清单必须人看过。

## 如何配置（写在业务仓里）

1. 下面示例全部来自业务仓 `backend-agent-identity` 的真实文件。
2. `repo-guard init --write` → `.codebuddy/repo-facts.json`
3. `repo-guard guard init --write` → `.codebuddy/facts.json`
4. 短句还可写进项目根 `CODEBUDDY.md`

## 字段说明

### `.codebuddy/repo-facts.json`

| 字段 | 含义 |
|---|---|
| `version` | 文件格式版本 |
| `analyzer` | 图谱用的分析器（本仓 `go-trpc`） |
| `publicLayer` | 公共层目录前缀。改这些目录下已有文件前必须先查 impact |
| `componentLibrary` | UI 组件库包名。后端仓为 `null` |
| `componentMcp` | 组件文档 MCP 在宿主里的注册名（本仓未配） |
| `lineLimit` | 单文件行数上限，超过只提醒不拒绝 |

### `.codebuddy/facts.json`

| 字段 | 含义 |
|---|---|
| `mission` | 一句话：本仓是干什么的 |
| `facts` | 代码读不出的短事实数组 |
| `discipline` | 常驻纪律 |
| `taboos` | 禁忌（不硬拦） |
| `knowledge[]` | 带 id/topic 的知识条目 |
| `knowledge[].id` | 条目编号 |
| `knowledge[].topic` | 短标题 |
| `knowledge[].content` | 正文 |
| `knowledge[].enabled` | `false` 不注入 |
| `stopConditions` | 人决策软名单，语义不属工程事实 |
| `taskRoutes` 的 match | 用户原话命中任一关键词即走该路由 |
| `taskRoutes` 的 required | 必读文件路径（必须真实存在） |
| `taskRoutes` 的 hard_gate | 注入的门禁说明 |
| `taskRoutes` 的 enabled | 是否启用 |

## 配置示例（10 条）

来源：`backend-agent-identity`。均为该仓已提交的配置，不是字段说明书。

### 1. `.codebuddy/repo-facts.json`

```json
{
  "version": 1,
  "analyzer": "go-trpc",
  "publicLayer": [
    "internal/config/",
    "internal/dto/",
    "internal/utils/"
  ],
  "componentLibrary": null,
  "lineLimit": 500,
  "generatedAt": "2026-09-21T14:00:22.947Z"
}
```

### 2. 项目根 `CODEBUDDY.md`

```markdown
# 本仓工程事实

- 本仓是 LLMSGW 身份服务（backend-agent-identity）：智能体/凭据/策略/资源与鉴权，不是业务单据服务。
- 分层：cmd → router → service/{admin,agent} → internal/logic → internal/repo（Mongo）→ internal/dto。两个服务：trpc.llmsgw.agent.yapi（/yunApi）与 trpc.llmsgw.agent.identity。
- 公共层目录以 `.codebuddy/repo-facts.json` 的 `publicLayer` 为准。改这些目录下**已有**文件前必须先查影响面。
- 权威入口：README.md（含错误码）、iwiki https://iwiki.woa.com/p/4018596336 。仓库 docs/ 当前为空，不要引用已删文档。
- 结构化事实与任务必读见 `.codebuddy/facts.json`。
```

### 3. `facts.json` · mission

```json
{
  "mission": "本仓是 LLMSGW（AI Agent 安全网关）的身份服务 backend-agent-identity：管理智能体/凭据/策略/资源，对外做鉴权与云 API，不处理业务单据。"
}
```

### 4. `facts.json` · facts（节选 2 条）

```json
{
  "facts": [
    "架构分层：cmd（进程入口）→ router（路由）→ service/admin 与 service/agent（接口）→ internal/logic（业务）→ internal/repo（Mongo）→ internal/dto（结构体）。禁止跨层直连 repo。",
    "两个 tRPC HTTP 服务：trpc.llmsgw.agent.yapi（云 API，路径 /yunApi，按 X-TC-Action 转到 /api/v1/<Action>）和 trpc.llmsgw.agent.identity（智能体侧身份接口）。版本头 2024-08-01 对应 v1。"
  ]
}
```

### 5. `facts.json` · discipline

```json
{
  "discipline": [
    "不许声称已测试——没跑过 go test / 相关命令就说没跑过。",
    "不许编造字段名，Mongo 字段与云 API 字段必须来自 dto/bson tag 或 README 错误码表。",
    "不许为了让测试通过而改断言或删用例。",
    "功能变更里禁止夹带无关重构和格式大扫除。",
    "发现与本次需求无关的脏代码：记录，不在本次修改。"
  ]
}
```

### 6. knowledge · bson 不受编译器保护

```json
{
  "id": "PK-ARCH-003",
  "topic": "bson 字段不受编译器保护",
  "content": "internal/repo 用 bson.M 字符串键。改字段必须同时改 struct tag、所有查询 filter、存量数据兼容，否则 go build 仍通过但线上读空。",
  "enabled": true
}
```

### 7. knowledge · 错误码已对云 API 暴露

```json
{
  "id": "PK-ARCH-004",
  "topic": "错误码已对云 API 暴露",
  "content": "constants 里 Aim 前缀错误码（如 AimAgentNotExist）写在 README。已发布码只增不删、不改语义。",
  "enabled": true
}
```

### 8. `facts.json` · taboos

```json
{
  "taboos": [
    "不要在 repo 里用字符串拼 Mongo 字段还不改 dto。",
    "不要在业务 logic 里直接调腾讯云 SDK；走 internal/tencent_* 封装。",
    "不要把 agent/、template/ 里的插件模板当成服务端可改热路径。",
    "不要提交含私钥、SecretKey、token 的配置。",
    "不要预测流水线结果；本仓 pipeline.yaml 需以实际运行为准。"
  ]
}
```

### 9. taskRoutes · auth

```json
{
  "auth": {
    "match": [
      "鉴权",
      "登录",
      "token",
      "身份",
      "认证",
      "JWT",
      "CIAM"
    ],
    "required": [
      "README.md",
      "CODEBUDDY.md",
      "internal/config/config.go",
      "router/router.go"
    ],
    "hard_gate": "改鉴权前先读 required，并说明落在 yapi 还是 identity 哪条链路。",
    "enabled": true
  }
}
```

### 10. taskRoutes · data（Mongo / bson）

```json
{
  "data": {
    "match": [
      "Mongo",
      "bson",
      "repo",
      "字段名",
      "集合"
    ],
    "required": [
      "README.md",
      "internal/repo/agent.go"
    ],
    "hard_gate": "改 bson 字段必须同时改 dto tag 与所有 filter，并考虑存量文档。",
    "enabled": true
  }
}
```

## 是否人审

**否。** 运行时不弹窗。人只在 init 后核对 `publicLayer`。

## 执行时机 / 原理

SessionStart / PostCompact 注入事实。UserPromptSubmit 按 taskRoutes.match 注入必读文件路径。不因此 deny。没有 `repo-facts.json` 则公共层守卫不生效。
