# 合并门禁（Agent / 工程）

> **一句话。** 卡写完了进不进主干、Agent 的危险命令现在能不能跑。

## 说明用途

工程侧是 CI 与代码平台（G-01～G-07）。Agent 侧是宿主 permissions.ask。插件只给片段，**不会自动生效**。

## 如何配置（写在业务仓里）

1. 本仓示例文件：`.codebuddy/merge-gates.example.json`（要贴进宿主 settings 才生效）。
2. 流水线：本仓有 `pipeline.yaml`、`Makefile`、`Dockerfile`。
3. 可挂 `repo-guard scan` / `audit`。
4. CODEOWNERS / 保护分支在代码平台配，不在插件 JSON 里。

## 字段说明

### `.codebuddy/merge-gates.example.json`（贴进宿主才生效）

| 字段 | 含义 |
|---|---|
| `permissions.ask[]` | 宿主权限规则。Agent 跑匹配的 Bash 前弹确认框 |
| 规则写法 | `Bash(git commit:*)` 这类 matcher，不是本仓自创 DSL |

插件不会自动把该文件装进宿主。人在自己终端敲 commit 也不走这层。

### 工程侧（不在这份 JSON 里）

| 落点 | 含义 |
|---|---|
| G-01～G-07 | 流水线/平台阻断级门禁，见 `md/00-gate-index.md` |
| `repo-guard scan` | 超长文件、循环依赖，可挂 CI |
| CODEOWNERS / 保护分支 | 代码平台配置 |

## 配置示例（10 条）

1～7 来自本仓 `merge-gates.example.json` 原文；8～10 按本仓补全工程侧。

### 1. 宿主 ask `Bash(git commit:*)`

```json
{
  "permissions": {
    "ask": [
      "Bash(git commit:*)"
    ]
  }
}
```

### 2. 宿主 ask `Bash(git push:*)`

```json
{
  "permissions": {
    "ask": [
      "Bash(git push:*)"
    ]
  }
}
```

### 3. 宿主 ask `Bash(git reset:*)`

```json
{
  "permissions": {
    "ask": [
      "Bash(git reset:*)"
    ]
  }
}
```

### 4. 宿主 ask `Bash(kubectl:*)`

```json
{
  "permissions": {
    "ask": [
      "Bash(kubectl:*)"
    ]
  }
}
```

### 5. 宿主 ask `Bash(mysql:*)`

```json
{
  "permissions": {
    "ask": [
      "Bash(mysql:*)"
    ]
  }
}
```

### 6. 宿主 ask `Bash(redis-cli:*)`

```json
{
  "permissions": {
    "ask": [
      "Bash(redis-cli:*)"
    ]
  }
}
```

### 7. 宿主 ask `Bash(rm:*)`

```json
{
  "permissions": {
    "ask": [
      "Bash(rm:*)"
    ]
  }
}
```

### 8. 完整 ask 列表（本仓原文一次贴进宿主）

```json
{
  "permissions": {
    "ask": [
      "Bash(git commit:*)",
      "Bash(git push:*)",
      "Bash(git reset:*)",
      "Bash(kubectl:*)",
      "Bash(mysql:*)",
      "Bash(redis-cli:*)",
      "Bash(rm:*)"
    ]
  }
}
```

### 9. 工程侧（补全）：本仓 Makefile 测试目标应对齐 G-02

```bash
go test ./...
```

### 10. 工程侧（补全）：CI 可挂图谱体检

```bash
repo-guard scan || exit 1
```

## 是否人审

**是。** 合入时 CR/必审人；危险命令问键盘前的人。本仓 example **尚未**自动生效。

## 执行时机 / 原理

工程侧在合入/CI，非 ReAct。Agent 侧在 Bash 执行前由宿主 ask。CI 里未决 ask 会变 deny。G-01～G-07 原文见 `md/00-gate-index.md`。
