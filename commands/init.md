---
description: 接入 repo-guard：识别本仓、逐项说明会启用的过程控制并让我确认，然后写入配置
argument-hint: ""
---

帮我在当前仓库接入 repo-guard。CLI 用 `node "${CODEBUDDY_PLUGIN_ROOT}/bin/repo-guard"`（变量没被替换时改用 `repo-guard`），下文记作 `RG`。

0. 先跑 `command -v repo-guard`。找不到时执行 `node "${CODEBUDDY_PLUGIN_ROOT}/bin/repo-guard" link`，把输出原样告诉我（它在 `~/.local/bin` 放一个启动器；提示不在 PATH 上时，把它给的那一行命令也告诉我）。合并门和终端命令都依赖它。
1. 在仓库根跑 `RG init --plan --json`，拿到识别结果。不要跑不带参数的 `RG init`（那是给人在终端里交互用的）。
2. 用中文简要告诉我：
   - 环境：是不是 git 仓、code-atlas 是否可用、有没有旧配置要迁移、是不是已经接入过（`existing: true` 时只补缺的字段和合并门）
   - 识别结果：技术栈、验收命令候选、公共层候选、建议红线、已有的 pre-commit / CI
   - `controls` 里每一项控制做什么、默认怎么处理（逐条列出，这是告知环节，不要省略）
3. 用提问控件逐项问我（每项都给出推荐值，推荐值放第一个）：
   - 总档位：remind（推荐，先提醒、收集误伤数据）/ enforce / off
   - 任务契约：auto（推荐，写第 2 个文件时要求声明）/ required / off
   - 验收命令：多选，默认勾 `checked: true` 的候选，允许我补充
   - 公共层：多选，同上；为空表示不做公共层影响面检查
   - 红线：多选，默认勾 `checked: true` 的建议
   - 合并门：多选，**默认一个都不勾**。说明 `shared: true` 的位置会进 git、影响整个团队；`editable: false` 的（CI 配置）不会自动改，只给我可复制的步骤；`local` 只对我自己生效
   已经接入过时只问缺的字段和合并门。
4. 按我的选择拼 JSON，跑 `RG init --apply '<JSON>'`。JSON 形如：
   `{"mode":"remind","contract":"auto","verify":["npm run lint"],"publicLayer":["src/components/"],"redlines":[{"glob":"**/*.pb.go","action":"block","reason":"生成代码"}],"mergeGate":[]}`
   `mergeGate` 可选值：husky / lefthook / pre-commit / local。选了 CI 的，把 `ciSnippet` 那一步原样给我，不要自己改 CI 文件。
5. 原样转述命令输出，最后提醒我：重开会话后生效；把 `.codebuddy/repo-guard.json`（以及改动的 hook 文件）提交进 git；随时可用 `RG status` 查看生效的控制。

不要替我做选择，也不要在我确认之前写任何文件。