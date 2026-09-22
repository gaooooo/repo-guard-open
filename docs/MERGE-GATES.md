# 合并门禁说明（Agent / 工程）

**非 ReAct 旁路。** 卡的是进主干，不是会话里的 Stop。

工程侧：lint + pre-commit + CI + CODEOWNERS（以及托管平台的保护分支、必审人）。
Agent 侧：宿主 `permissions.ask`（commit / push / 生产写）。

插件 **只给 `permissions.ask` 片段**。强制不了宿主权限，也替不了 CI。**不要写进 Stop hook。**

作者面：`layers/merge-gates/permissions.ask.example.json`。`layers init --write` 拷到项目后仍不会自动生效，要人贴进宿主配置。

---

## 一句话

过程门禁和红线管 **ReAct 里这次写入**；合并门禁管 **这段改动能不能进主干**。两条路，不要用 Stop 去拦 `git commit`。

---

## 和别的层怎么分

| 层 | 问的是 | 合并门禁做不做 |
|---|---|---|
| 过程门禁 | 这次写入手续过没过 | 不做。Stop 只提醒，不硬拦提交 |
| 红线 | 哪个符号不许少 | 不做。最多把 `audit` 挂进 CI |
| 人审 | 红线命中后问不问人 | 不做。宿主 ask 是「这类命令先问人」，不带红线 reason |
| 图谱 | 影响面 | 不做。`scan` 可挂流水线，但是体检不是合入策略 |

---

## 两半

| | 工程侧 | Agent 侧 |
|---|---|---|
| 卡住谁 | 进主干的那一次合入 | 模型在会话里敲的危险命令 |
| 落点 | lint、pre-commit、CI、CODEOWNERS、保护分支 | 宿主 `permissions.ask` |
| 插件给什么 | `repo-guard scan` 等可挂流水线的命令（有问题非零退出） | `permissions.ask.example.json`，人贴 |
| 强制得了吗 | 替不了你们的 lint/测试/SAST/CODEOWNERS | 强制不了宿主权限 |

---

## Agent 侧：只给 ask 片段

模板（**不会自动生效**）：

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

贴进宿主 permissions，不是 `.codebuddy/human-review.json`，也不是 Stop hook。弹的是宿主确认框。

---

## 工程侧：lint / pre-commit / CI / CODEOWNERS

这些都在会话外面。插件不内置扫描器，仓库自己接：

| 落点 | 干什么 |
|---|---|
| lint / 格式化 | G-03 一类：静态检查过了才能合 |
| pre-commit | 提交前本地拦一层 |
| CI | 构建、测试、`repo-guard scan`、SAST、依赖 |
| CODEOWNERS + 保护分支 | G-07：必审人、门禁未过不得合入 |

插件能挂进流水线的命令：

| 命令 | 干什么 |
|---|---|
| `repo-guard scan` | 超行数、循环依赖；有问题非零，可 `scan || exit 1` |
| `repo-guard audit` | 红线指针还准不准 |
| `repo-guard standards check` | 规范命中（和写后提醒同一套判定） |
| `repo-guard doctor` | 配置写错、僵尸条目 |

---

## 不要写进 Stop hook

CodeBuddy 里 `git commit` 常常是人自己敲的。Stop 上 deny 会妨碍人，误伤率高的门会被卸掉，连提醒都没了。

真要拦提交：宿主 `permissions.ask`。真要卡主干：CI + CODEOWNERS。

---

## 和 G-01～G-07

那七条是进主干的阻断级纪律。模型只读结论，不读阈值；未取得结论视为未通过；禁止改判据、调阈值、加 skip。

插件不实现这七条，只保证不在 Stop 上假装自己是 CI。G-04 过了（体量没爆）不等于没有过度设计。

---

## 怎么配

1. `repo-guard layers init --write` → `.codebuddy/merge-gates.permissions.example.json`（仍不生效）
2. 按需把 ask 列表贴进宿主 settings
3. pre-commit / CI 接 lint、测试、`repo-guard scan`
4. CODEOWNERS 和保护分支在代码托管平台配，不写进插件 JSON

