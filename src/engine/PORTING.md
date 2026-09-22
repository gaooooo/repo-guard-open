# src/engine —— 红线判定（移植区）

图谱分析器已经搬到 [`src/graph/`](../graph/PORTING.md)。**不要在这里重写打分，也不要在这里重写红线三层判定。**

本目录只剩红线与扫描：

| 这里 | 职责 |
|---|---|
| `policy-engine.ts` | 红线三层判定（结构化删除 / 意图正则 / paths 收窄） |
| `policy-audit.ts` | 红线体检：守空气 / 后门 / 证据失准 |
| `code-scanner.ts`、`sql-scanner.ts` | 词法索引，给 audit 找符号出现位置 |
| `public-layer-audit.ts`、`write-tool-args.ts`、`types.ts` | 公共层模式校验、写工具入参提取、`KnowledgeSnapshot` 等类型 |
| `shims/` | logger（stderr）与 token-estimator；图谱和红线共用 |

移植纪律、允许的改动、与 deerclaw 的对照见 `src/graph/PORTING.md`。
