# 控制面规范（HTML + Markdown）

本目录是一份可点开的规范站：左侧树形菜单，右侧把对应 `.md` 渲染成 HTML。

## 怎么打开

- 直接打开 `index.html`（`file://` 也可以：依赖同目录 `contents.js`）。
- 或在本目录执行 `python3 -m http.server 8765` 后访问。
- 改了 markdown 后运行 `python3 gen_contents.py` 再刷新。

## 目录

- `index.html` — 菜单与 markdown 渲染
- `contents.js` — markdown 打包，给 file:// 用
- `md/overview.md` — 七层总览
- `md/facts.md` `redline.md` `graph.md` `process.md` `human.md` `merge.md` — 控制面
- `md/component.md` `md/ui.md` — 组件 / UI 规范
- `md/skills/*.md` — 技能库，**后端提供的原文，未改内容**
- `md/00-gate-index.md` — G-01～G-07 门禁索引原文

技能库 01～15 来自 references，只复制不改写。
