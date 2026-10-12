# 红线

> **一句话。** 防止 AI 把对外还在用的字段、接口、错误码删掉或改名——这些名字一少，外部调用方就会挂。

## 说明用途

锁的是内容不是手续。人点名不能动的名字；机器对照这一次真 diff，出现次数变少就拦住。

## 如何配置（写在业务仓里）

1. 业务仓 `.codebuddy/redlines.json`（下例来自 `backend-agent-identity`）。
2. 每条必填 `id` / `paths` / `protects` / `rule`；`confirmed: true` 才硬拦。
3. 配完跑 `repo-guard audit`。
4. 硬拦需 `process-gates.json` 的 `admission: true`。弹窗破例走人决策。

## 字段说明

文件：`.codebuddy/redlines.json` 的 `rules[]`。

| 字段 | 含义 |
|---|---|
| `id` | 规则编号，如 `RL-001` |
| `rule` | 一句话锁什么（给人看，也给拦截文案） |
| `reason` | 为什么锁。机器不靠它判定 |
| `protects` | 锁：要数的标识符。没有它等于没锁 |
| `paths` | glob。必须写全，漏掉的路径是后门 |
| `violation_action` | 历史字段；ask/deny 以人决策开关为准，引擎不读它 |
| `confirmed` | `true` 才当硬拦。模板示例为 `false` 不会拦 |

## 配置示例（10 条）

前 5 条是该仓 `.codebuddy/redlines.json` 原文。后 5 条按本仓身份服务语义补全（仍 `confirmed: false`，要硬拦需人改 protects 并 confirmed）。

### 1. `RL-001` 已发布错误码字段不得改名或删除

```json
{
  "id": "RL-001",
  "rule": "已发布错误码字段不得改名或删除",
  "reason": "【示例】已随 SDK 发布，旧客户端在解析",
  "protects": [
    "error_code",
    "error_description"
  ],
  "paths": [
    "internal/**",
    "pkg/**"
  ],
  "violation_action": "stop_and_ask",
  "confirmed": false
}
```

### 2. `RL-002` 鉴权结论字段不得削弱语义

```json
{
  "id": "RL-002",
  "rule": "鉴权结论字段不得削弱语义",
  "reason": "【示例】网关按该字段做放行，改语义会造成越权或误杀",
  "protects": [
    "allow",
    "deny",
    "auth_result"
  ],
  "paths": [
    "internal/**"
  ],
  "violation_action": "stop_and_ask",
  "confirmed": false
}
```

### 3. `RL-003` 密钥与 token 不得写入代码或配置仓库

```json
{
  "id": "RL-003",
  "rule": "密钥与 token 不得写入代码或配置仓库",
  "reason": "【示例】凭据进入版本库即视为泄露，必须轮转",
  "protects": [
    "secret",
    "private_key",
    "access_token"
  ],
  "paths": [
    "**/*"
  ],
  "violation_action": "stop_and_ask",
  "confirmed": false
}
```

### 4. `RL-004` 对外接口路径与方法不得原地破坏性修改

```json
{
  "id": "RL-004",
  "rule": "对外接口路径与方法不得原地破坏性修改",
  "reason": "【示例】破坏性变更必须新增接口并给共存期",
  "protects": [
    "Handle",
    "Register",
    "Route"
  ],
  "paths": [
    "router/**",
    "cmd/**"
  ],
  "violation_action": "stop_and_ask",
  "confirmed": false
}
```

### 5. `RL-005` 主键与租户隔离字段不得删除

```json
{
  "id": "RL-005",
  "rule": "主键与租户隔离字段不得删除",
  "reason": "【示例】缺少租户字段会导致串数据",
  "protects": [
    "tenant_id",
    "app_id",
    "uin"
  ],
  "paths": [
    "internal/dto/**",
    "internal/model/**"
  ],
  "violation_action": "stop_and_ask",
  "confirmed": false
}
```

### 6. `RL-006` 已发布 Aim 错误码不得删改语义（补全）

```json
{
  "id": "RL-006",
  "rule": "已发布 Aim 错误码不得删改语义",
  "reason": "补全：README 已对外列出 AimAgentNotExist 等，旧客户端在解析",
  "protects": [
    "AimAgentNotExist",
    "AimUnauthorized",
    "AimInvalidParameter"
  ],
  "paths": [
    "constants/**",
    "README.md"
  ],
  "confirmed": false
}
```

### 7. `RL-007` Mongo Agent 主键字段不得改名（补全）

```json
{
  "id": "RL-007",
  "rule": "Mongo Agent 主键字段不得改名",
  "reason": "补全：repo 用 bson.M 字符串键，改名编译器不报错但线上读空",
  "protects": [
    "agentId",
    "agent_id",
    "_id"
  ],
  "paths": [
    "internal/repo/**",
    "internal/dto/**"
  ],
  "confirmed": false
}
```

### 8. `RL-008` JWT / Biscuit 相关字段不得削弱（补全）

```json
{
  "id": "RL-008",
  "rule": "JWT / Biscuit 相关字段不得削弱",
  "reason": "补全：身份服务签发与校验依赖这些名字",
  "protects": [
    "jwt",
    "biscuit",
    "expires_at"
  ],
  "paths": [
    "internal/**"
  ],
  "confirmed": false
}
```

### 9. `RL-009` 云 API Action 路由不得原地破坏性改名（补全）

```json
{
  "id": "RL-009",
  "rule": "云 API Action 路由不得原地破坏性改名",
  "reason": "补全：X-TC-Action 转到 /api/v1/<Action>，改名等于对端 404",
  "protects": [
    "X-TC-Action",
    "yunApi",
    "OpenSaas"
  ],
  "paths": [
    "router/**",
    "service/**"
  ],
  "confirmed": false
}
```

### 10. `RL-010` 运行时私钥配置键不得写进仓库示例（补全）

```json
{
  "id": "RL-010",
  "rule": "运行时私钥配置键不得写进仓库示例",
  "reason": "补全：Auth.PrivateKey 只允许运行时注入",
  "protects": [
    "PrivateKey",
    "SecretKey",
    "Rainbow"
  ],
  "paths": [
    "etc/**",
    "internal/config/**"
  ],
  "confirmed": false
}
```

## 是否人审

**可配置。** 默认机器拒绝。打开人决策后改为弹窗。本仓 `human-review.json` 当前 `enabled: false`，因此命中仍是否决而不是问人。

## 执行时机 / 原理

PreToolUse 对 Write/Edit 算出真 diff 之后，数 `protects` 出现次数，变少则 deny（人决策打开则为 ask）。
