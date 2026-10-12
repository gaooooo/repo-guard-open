# 人决策配置

> **一句话。** 规定什么时候把决定权交回人。本机弹窗问键盘前的人；指定 leader 用 canUseTool 调公司审批。

## 说明用途

红线破例、需求两种读法、不可逆操作。不审有没有查 impact。合入主干不是这一层。

## 如何配置（写在业务仓里）

1. 硬开关：`.codebuddy/human-review.json`
2. 软名单：`.codebuddy/facts.json` 的 `stopConditions`
3. Leader：宿主 `canUseTool` 回调里阻塞，脚本调飞书/企微/工单（本仓尚未接）
4. commit/push 配宿主 permissions.ask，不要写进 stopConditions

## 字段说明

### `.codebuddy/human-review.json`

| 字段 | 含义 |
|---|---|
| `enabled` | false 时红线命中仍 deny，不弹窗 |
| `onRedline` | ask：红线命中改为宿主确认框；deny：保持拒绝 |

未查 impact、循环失控、禁改清单即使打开也不问人。

### `.codebuddy/facts.json` 的 `stopConditions`

| 字段 | 含义 |
|---|---|
| `stopConditions[]` | 一句话一条。开场注入「这时问人」，不拦写入 |

不要把「先查 impact」或 git commit 写进来。

## 配置示例（10 条）

1～6 来自本仓原文；7～10 按身份服务语义补全。

### 1. `.codebuddy/human-review.json`（本仓未打开，红线命中仍 deny）

```json
{
  "enabled": false,
  "onRedline": "ask"
}
```

### 2. 若打开人决策（补全写法，非本仓当前值）

```json
{
  "enabled": true,
  "onRedline": "ask"
}
```

### 3. stopConditions

```json
[
  "需求有多种合理解读时停下来问人。"
]
```

### 4. stopConditions

```json
[
  "要改 Mongo 字段名、索引或存量数据形态时停下来问人。"
]
```

### 5. stopConditions

```json
[
  "要改鉴权、token 超时、私钥或 CIAM/STS 对接时停下来问人。"
]
```

### 6. stopConditions

```json
[
  "要改已发布云 API Action 名或错误码时停下来问人。"
]
```

### 7. stopConditions

```json
[
  "合入主干、发布、生产写操作必须由人决策。"
]
```

### 8. stopConditions（补全）

```json
[
  "要改 yapi 与 identity 两条 mux 的边界（管理面 vs 智能体运行时）时停下来问人。（补全）"
]
```

### 9. stopConditions（补全）

```json
[
  "要把 Rainbow 配置指到生产资源时停下来问人。（补全）"
]
```

### 10. stopConditions（补全）

```json
[
  "要删除或改名已对云 API 暴露的 OpenSaas Action 时停下来问人。（补全）",
  "要改 Biscuit / Cedar 策略语义时停下来问人。（补全）",
  "存量 Mongo 文档做不可逆迁移且无回滚方案时停下来问人。（补全）"
]
```

## 是否人审

**是。** 仅弹窗那一档强制。本仓 `enabled: false`，等于还没打开。软名单不保证停下。

## 执行时机 / 原理

软：SessionStart 注入。硬：PreToolUse 红线命中后 ask。Leader：canUseTool 执行前卡住。未查 impact / 循环 / 禁改仍 deny。
