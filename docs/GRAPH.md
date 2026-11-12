# code-atlas 图谱接入

repo-guard 是开发过程框架，code-atlas 是唯一图谱工具包。规则与流程由前者管理；解析、索引、跨仓关系、影响面、复用、契约、自查、可视化由后者提供。红线/门禁策略另行设计，本轮不调整。

## 架构与配置主体

| 部分 | 职责 | 谁配置 |
|---|---|---|
| 插件 .mcp.json | 经统一启动器注册原生 Atlas MCP | P：插件维护者 |
| 本机 ~/.repo-guard/atlas.json | Node / bin 绑定和项目工作区选择，不进 git | U：开发者，通过 atlas bind/init 命令 |
| 项目 .code-atlas.json | 可选请求封装、路径改写、架构展示 | J：项目开发者，遵循 Atlas 手册 |
| 项目 .codebuddy/repo-facts.json | 既有公共层配置，不代表图谱扫描范围 | J：项目开发者 |
| code-atlas 索引与缓存 | 工具包自动维护 | X：不由开发者编辑 |

不新增第三层规则配置，不把本机路径写入团队配置。

~~~text
AI 原生 atlas_* MCP ─┐
统一 CLI ────────────┼→ 同一 Node + code-atlas/bin/atlas → Atlas 图谱能力
Hook 的只读调用 ─────┘
                        ↓ 有效机器回执
                 repo-guard 会话状态与留痕
~~~

## 开发者接入

~~~bash
# 一次绑定本地工具包；路径换成自己的
repo-guard atlas bind /path/to/code-atlas --node /path/to/node
repo-guard atlas status

# npm 全局安装过时，不带路径会自动发现并保存当前安装
repo-guard atlas bind

# 在业务仓执行，相关仓由 --with 显式提供，可重复
repo-guard init --write --ws myproject --with ../backend
~~~

已登记的仓不会被重复添加，有效缓存由 Atlas 复用。索引或代码变化由 Atlas 自己更新。默认 init 只读缓存，不 add、不 sync；--write 才准备图谱和写既有事实配置。没有强制生成红线、门禁或规范配置。

多个工作区需显式 --ws；单一工作区可自动复用。选择写入本机绑定，不改 Atlas 的全局默认工作区。兄弟仓只登记图谱，不写它的治理配置。

绑定失效不回退其他版本，不自动安装/升级。完整工具包包含 assets 和 CodeGraph 平台依赖，不能只复制 bin/atlas。

## 日常调用

| 任务 | AI MCP | 统一 CLI |
|---|---|---|
| 修改/删除前 | atlas_impact，target=文件#符号/类型.字段 | repo-guard atlas impact '文件#符号' |
| 新接口/页面前 | atlas_reuse，kind=similar | repo-guard atlas similar 需求 --resource User --verbs Create |
| 方法/组件复用 | atlas_reuse，kind=reuse | repo-guard atlas hot 需求 |
| 请求链路 | atlas_trace | repo-guard atlas trace 接口名 |
| 写完自查 | atlas_review | repo-guard atlas review --ws myproject |
| 前后端字段 | atlas_contracts，check=true | repo-guard atlas contracts --check |
| 体检、展示 | Atlas CLI | repo-guard atlas scan / viz --open |

原生命令参数透传。trace 以目标业务仓 cwd 为起点，不支持 --repo。未安装 repo-guard 命令时使用 node /插件目录/bin/repo-guard。

图谱已有单独 atlas install 接入时，检查助手实际 MCP 的来源；本插件不自动删除用户/项目接入。重绑定后重开会话。具体 Atlas 参数、平台支持和安装要求以工具包 docs/INSTALL.md、docs/USAGE.md 为准。

## 回执与只读边界

Atlas 影响面、链路、热点/复用、同类输出 receipt。MCP 放在 structuredContent.receipt；CLI --json 放在 receipt。形状包含 schemaVersion、kind、status、workspace、实际 repos、targets 和可选 plan。

- status=ok 才记录成功；not_found/ambiguous、异常或缺回执不记录。
- 目标成功解析而入口数为 0，说明查询完成，不说明可以删除。
- trace 只留痕，不满足 impact 的手续。
- repo-guard 不解析节点/边，不再通过工具入参推断符号归属，不保存图谱缓存。
- MCP 回执与统一 CLI 直接记录，不二次查询。简单成功的原生 CLI 可只读缓存核验，复杂 shell 不作凭据。
- Hook 中的登记查询只读 metadata；--cache-only 不更新索引。原有 Stop conform 接线保持，仍有有限超时与续跑预算，门禁策略另行设计。
- 旧版工具包无回执时不会假装查询成功；本轮需要使用配套源码构建，不能仅看同一版本号就认定契约相同。

## 验证

~~~bash
REPO_GUARD_ATLAS_BIN=/path/to/code-atlas/bin/atlas npm run check
~~~

专项回归覆盖统一绑定、原生 MCP、只读预览、初始化复用、多工作区、字段回执、查询失败与错误退出码。全部使用临时 HOME、ATLAS_HOME 和业务仓。没有工具包的专项回归明确 SKIP，不代表通过图谱验收。

图谱 review 是静态自查，不代替 test/build，也看不见工作区外和部分动态调用。
