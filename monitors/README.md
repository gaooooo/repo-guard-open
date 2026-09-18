# monitors/ —— Claude 标准字段，CodeBuddy 不启动

**这个目录在 CodeBuddy 下没有任何效果。** 列出来是为了标明控制点全集。

## 事实

`plugin.json` 的 `experimental.monitors` 指向 `monitors/monitors.json`，
是 Claude Code 的后台 monitor 机制。CodeBuddy **只识别、不启动**。

## 如果它能用，repo-guard 会拿它做什么

一个后台 monitor 正好补上当前架构里最弱的一环：**图谱预热**。

现在的约束是「钩子里只读缓存，永不建图」—— 因为 `pre-write` 只有 15 秒预算，
而万文件级仓库建图要几十秒。代价是：切完分支的第一次 `impact` 查询要等建图，
或者 hook 因为缓存 miss 而 fail-open（漏拦一次）。

有 monitor 的话就可以：监视 `.git/HEAD` 与源文件 mtime，在后台重建图谱，
让 hook 永远命中缓存。

## 现在怎么补这个缺口

用 `hooks/hooks.json` 的 `FileChanged` 事件（matcher 填文件名）。
它不是常驻进程，但事件驱动足够 —— 见 hooks.json 里 `FileChanged` 那一节的注释。

这个目录永久留空。
