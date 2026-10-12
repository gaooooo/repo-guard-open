> 完整开发设计见 [`DESIGN-SEVEN-LAYERS.md`](DESIGN-SEVEN-LAYERS.md)。

# plugin 七层结构

> 编码阶段资料分类：工程事实 · 技能库 · 红线 · 过程门禁 · 人审 · 合并门禁 · 图谱。
> 开发者往 `layers/` 加内容；CodeBuddy 默认目录（skills/hooks）仍在仓库根上，由各层 README 指过去。

## 源码层是不是就是图谱？

**不是全部。** 图谱和红线已经分开目录：

| 源码 | 是不是图谱 | 放哪 |
|---|---|---|
| 图谱引擎（analyzers / builder / report / insight） | 是 | **已移交 code-atlas**，本仓不再有源码 |
| `src/atlas/client.ts`、`src/hooks/atlas-track.ts` | 调用图谱 | 子进程调 `atlas … --json`；hook 只用 `--cache-only`，禁止建图 |
| `src/engine/policy-engine.ts`、`policy-audit.ts`、扫描器 | 否，红线判定 | **留在 plugin** `src/engine/` |
| `src/gates/`、`hooks/`、`standards/`、`cli/`、`mcp/` | 否，控制面接线 | **留在 plugin** |

以后若外置成独立仓，plugin 通过 MCP + adapter 调用；现在不做。产物仍是零依赖单文件。

## 两层：作者写的 vs 运行时

```
layers/                      开发者编写、按类添加（本仓）
    ↓ init --write / 文档约定
被守护仓库 .codebuddy/       团队共识，进 git
    ↓ 会话
CodeBuddy 控制点             T3 CODEBUDDY.md / T6 rules / T7 hook / 宿主 / CI
```

插件 **不能分发** `CODEBUDDY.md` 和 `.codebuddy/rules`。工程事实要靠 `init --write` 生成，或人把 `layers/facts/` 里的片段贴进项目仓。

## 七层 → 写入节点

| 层 | 开发者改哪 | 运行时落到哪 | 默认 |
|---|---|---|---|
| 1 工程事实 | `layers/facts/` | T3 `CODEBUDDY.md`（常驻）+ T6 `rules`（按路径）+ SessionStart 摘要 | 短、可加 |
| 2 技能库 | 仓库根 `skills/` + layers/skills/standards/ | T2 索引 / T6 正文；规范 JSON 运行时合并 | 拉 |
| 3 红线 | `layers/redlines/` → 项目 `redlines.json` | T7a：真 diff 里 `protects` 次数变少 → deny（人审打开则 ask） | 硬 |
| 4 过程门禁 | `layers/process-gates/` | T7a deny / T7e remind / T10 提醒 | 公共层守卫已开，其余默认关 |
| 5 人审 | `layers/human-review/` + `facts.json` 的 `stopConditions` | T4 注入「何时问人」（自觉）；T7b 红线命中后 ask | 硬开关默认关 |
| 6 合并门禁 | `layers/merge-gates/` | **非 ReAct**：工程侧 CI / pre-commit；Agent 侧宿主 permissions.ask | 插件不能强制，只给片段 |
| 7 图谱 | `layers/graph/`（说明）+ code-atlas（引擎） | T2 MCP；T7d 调用；T7a require_tool | 拉 + 可硬 |

## 和旧「七道门 L0–L6」的关系

L0–L6 仍是过程层内部实现，**不是**开发者添加规范时要选的目录。开发者只认上面七层。接线时：

- 过程门禁 ≈ L0 注入 + L1 准入机器拦 + L3 循环 + L5 提醒
- 人审 ≈ T4 stopConditions 注入 + 红线命中后的 T7b ask，不是新的 L7
- 合并门禁 ≈ 工程侧仓外 CI + Agent 侧宿主 permissions.ask，不是 Stop 硬拦
- 图谱 ≠ L 号
