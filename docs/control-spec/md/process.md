# 过程门禁

> **一句话。** 红线拦内容违不违规；过程门禁拦这步做了没有、该查的查了没有。

## 说明用途

管这一轮怎么动手：改公共层先查影响面、别转圈、别改太散、冻结目录别碰、改完要有检查痕迹。不拦 git commit。

## 如何配置（写在业务仓里）

1. 业务仓 `.codebuddy/process-gates.json`（下例来自 `backend-agent-identity`）。
2. 公共层 impact 由 `repo-facts.json` 的 publicLayer 驱动，不靠 admission。
3. 本仓 `admission: false`，因此 noRefactor / similar / hot 虽已填路径，默认不硬拦。
4. 自定义检查脚本写进 `delivery.evidencePatterns`（本仓尚未填）。

## 字段说明

文件：`.codebuddy/process-gates.json`。

| 字段 | 含义 |
|---|---|
| `inject` | 是否注入 facts/红线摘要（只推不拦） |
| `admission` | 禁改/范围/新建查图的总闸。公共层 impact 不靠它 |
| `loop.enabled` | 循环门 |
| `loop.repeatToolCallThreshold` | 同一调用指纹重复几次后拦 |
| `loop.consecutiveFailThreshold` | 连续失败几次后拦 |
| `loop.sameFileWriteFailThreshold` | 同文件写失败几次后拦 |
| `delivery.enabled` | Stop 时是否做交付检查 |
| `delivery.engineeringCheck` | `warn` 只提醒；`block` 不准停 |
| `delivery.maxDeliveryFiles` | 单次改动文件数上限，`null` 不限 |
| `delivery.evidencePatterns` | 额外认哪些命令片段（本仓未填） |
| `noRefactor[].path` | 冻结 glob |
| `noRefactor[].reason` | 为什么冻 |
| `noRefactor[].confirmed` | 要硬拦必须 true，且 admission 为 true |
| `scope.enabled` | 范围门 |
| `scope.allowlist` | 只允许写这些前缀，空=不限 |
| `scope.maxFiles` | 单会话不同文件数上限 |
| `signals` | 会话收尾诚实信号，纯观测 |
| `governance` | 本机埋点，不进 git |

## 配置示例（10 条）

来源：该仓 `.codebuddy/process-gates.json` 原文。

### 1. 总闸

```json
{
  "inject": true,
  "admission": false,
  "signals": false,
  "governance": true
}
```

### 2. 循环门（当前关）

```json
{
  "loop": {
    "enabled": false,
    "repeatToolCallThreshold": 3,
    "consecutiveFailThreshold": 3,
    "sameFileWriteFailThreshold": 2
  }
}
```

### 3. 交付门（当前关，模式 warn）

```json
{
  "delivery": {
    "enabled": false,
    "engineeringCheck": "warn",
    "maxDeliveryFiles": null
  }
}
```

### 4. 禁改 · 历史兼容

```json
{
  "path": "internal/legacy/**",
  "reason": "【示例】历史兼容逻辑，边界条件缺少测试",
  "confirmed": false
}
```

### 5. 禁改 · 迁移脚本

```json
{
  "path": "internal/migrate/**",
  "reason": "【示例】一次性迁移脚本，改动风险不可逆",
  "confirmed": false
}
```

### 6. 禁改 · 第三方代码

```json
{
  "path": "third_party/**",
  "reason": "【示例】第三方生成代码，应改上游再生成",
  "confirmed": false
}
```

### 7. 禁改 · 生成物

```json
{
  "path": "**/generated/**",
  "reason": "【示例】生成物，不要手改",
  "confirmed": false
}
```

### 8. 禁改 · 兼容入口

```json
{
  "path": "cmd/compat/**",
  "reason": "【示例】兼容入口，冻结直到明确下线方案",
  "confirmed": false
}
```

### 9. 新建 logic/service/router 前查 similar（路径已按本仓填好，enabled 仍为 false）

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

### 10. 范围门（当前关）

```json
{
  "scope": {
    "enabled": false,
    "allowlist": [],
    "maxFiles": null
  }
}
```

## 是否人审

**否。** 手续没做完直接拒绝。本仓 admission 关闭时，除公共层 impact 外上述条目不硬拦。

## 执行时机 / 原理

PreToolUse 写前判定；Bash 前记证据；Stop 时交付门。看会话戳和命令文本。公共层三个目录见 repo-facts.publicLayer：internal/config、internal/dto、internal/utils。
