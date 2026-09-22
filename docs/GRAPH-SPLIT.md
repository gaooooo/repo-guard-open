# 图谱源码位置

**不另开仓。** 图谱源码留在本 plugin 仓库，和红线判定分开目录。

| | 路径 |
|---|---|
| 源码（已搬家） | `src/graph/`：`analyzers/` · `graph-builder.ts` · `graph-report.ts` · `registry.ts` · `types.ts` |
| 移植纪律 | `src/graph/PORTING.md`（只改路径，不改打分） |
| 作者说明 | `layers/graph/` |
| hook 只读缓存 | `src/runtime/graph-cache.ts`（禁止在 hook 里建图；缓存 miss fail-open） |
| MCP / CLI | `src/mcp/server.ts`、`src/cli/*` 调 builder/report |
| 红线引擎（不是图谱） | `src/engine/policy-engine.ts` · `policy-audit.ts` · 扫描器 |

以后若外置成独立仓，plugin 只留 adapter + MCP；**现在不做**。用户装的仍是零依赖单文件 `bin/repo-guard`。
