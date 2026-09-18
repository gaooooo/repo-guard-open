/**
 * 内置组件库目录 —— 常见 UI 库的导出清单（名字 + 一句话 + 分类）。
 *
 * ── 为什么要内置这份数据 ──
 * `lib search` 要回答「本仓 UI 组件库里有没有现成的」。理想做法是解析
 * node_modules 里的 .d.ts 现算，但两个现实问题：
 *   · 用户仓可能没装依赖（CI 的浅检出、刚 clone 还没 install）；
 *   · 解析 d.ts 要几秒，而这个查询是 AI 在对话里同步调的。
 * 所以对最常见的几个库直接内置一份目录，拿不到就退回现算（见 library-catalog）。
 *
 * ── 为什么这份数据只有一句话描述，没有 props ──
 * props 必须现算。内置的 props 会过期，而**过期的 props 比没有 props 更坏**：
 * 模型会照着写，编译不过还得回头查。一句话描述只用于「有没有现成的」这一步筛选，
 * 筛中之后工具会明确要求去查真实 props。
 *
 * category 取值：general / form / data / nav / feedback / layout / other
 */

export interface CatalogEntry {
  /** 导出名，如 Select */
  name: string;
  /** 一句话用途 */
  oneLiner: string;
  /** 粗分类，用于检索时给人定位 */
  category: string;
}

/** @tencent/tea-component：62 个导出 */
const TEA_COMPONENT: CatalogEntry[] = [
  { name: "Affix", oneLiner: "固钉", category: "nav" },
  { name: "Alert", oneLiner: "警告提示", category: "feedback" },
  { name: "Anchor", oneLiner: "锚点", category: "nav" },
  { name: "AutoComplete", oneLiner: "自动完成", category: "form" },
  { name: "Avatar", oneLiner: "头像", category: "data" },
  { name: "Badge", oneLiner: "徽标", category: "data" },
  { name: "Breadcrumb", oneLiner: "面包屑", category: "nav" },
  { name: "Bubble", oneLiner: "气泡提示", category: "feedback" },
  { name: "Button", oneLiner: "按钮", category: "general" },
  { name: "Calendar", oneLiner: "日历", category: "data" },
  { name: "Card", oneLiner: "卡片", category: "data" },
  { name: "Cascader", oneLiner: "级联选择", category: "form" },
  { name: "Checkbox", oneLiner: "多选框", category: "form" },
  { name: "Collapse", oneLiner: "折叠面板", category: "data" },
  { name: "Copy", oneLiner: "复制", category: "general" },
  { name: "DatePicker", oneLiner: "日期选择", category: "form" },
  { name: "Drawer", oneLiner: "抽屉", category: "feedback" },
  { name: "Dropdown", oneLiner: "下拉菜单", category: "nav" },
  { name: "Empty", oneLiner: "空状态", category: "feedback" },
  { name: "ErrorTip", oneLiner: "错误提示", category: "feedback" },
  { name: "Form", oneLiner: "表单", category: "form" },
  { name: "Grid", oneLiner: "栅格布局", category: "layout" },
  { name: "H1", oneLiner: "一级标题", category: "general" },
  { name: "H2", oneLiner: "二级标题", category: "general" },
  { name: "H3", oneLiner: "三级标题", category: "general" },
  { name: "H4", oneLiner: "四级标题", category: "general" },
  { name: "H5", oneLiner: "五级标题", category: "general" },
  { name: "Icon", oneLiner: "图标", category: "general" },
  { name: "ImagePreview", oneLiner: "图片预览", category: "data" },
  { name: "Input", oneLiner: "输入框", category: "form" },
  { name: "InputAdornment", oneLiner: "输入装饰", category: "form" },
  { name: "InputNumber", oneLiner: "数字输入", category: "form" },
  { name: "Justify", oneLiner: "两端对齐布局", category: "layout" },
  { name: "Layout", oneLiner: "布局", category: "layout" },
  { name: "List", oneLiner: "列表", category: "data" },
  { name: "Loading", oneLiner: "加载中", category: "feedback" },
  { name: "LoadingTip", oneLiner: "加载提示", category: "feedback" },
  { name: "Menu", oneLiner: "菜单", category: "nav" },
  { name: "Modal", oneLiner: "对话框", category: "feedback" },
  { name: "Notification", oneLiner: "通知提醒", category: "feedback" },
  { name: "Pagination", oneLiner: "分页", category: "nav" },
  { name: "Progress", oneLiner: "进度条", category: "feedback" },
  { name: "Radio", oneLiner: "单选框", category: "form" },
  { name: "SearchBox", oneLiner: "搜索框", category: "form" },
  { name: "Segment", oneLiner: "分段控制器", category: "form" },
  { name: "Select", oneLiner: "下拉选择器，支持多选", category: "form" },
  { name: "Slider", oneLiner: "滑块", category: "form" },
  { name: "Status", oneLiner: "状态", category: "data" },
  { name: "Stepper", oneLiner: "步进器", category: "form" },
  { name: "Steps", oneLiner: "步骤条", category: "nav" },
  { name: "Switch", oneLiner: "开关", category: "form" },
  { name: "Table", oneLiner: "表格", category: "data" },
  { name: "Tabs", oneLiner: "选项卡", category: "nav" },
  { name: "Tag", oneLiner: "标签", category: "data" },
  { name: "Text", oneLiner: "文本", category: "general" },
  { name: "TextArea", oneLiner: "多行输入", category: "form" },
  { name: "TimePicker", oneLiner: "时间选择", category: "form" },
  { name: "Timeline", oneLiner: "时间轴", category: "data" },
  { name: "Transfer", oneLiner: "穿梭框", category: "form" },
  { name: "Tree", oneLiner: "树", category: "data" },
  { name: "TreeSelect", oneLiner: "树选择", category: "form" },
  { name: "Upload", oneLiner: "上传", category: "form" },
];

/** antd：68 个导出 */
const ANTD: CatalogEntry[] = [
  { name: "Affix", oneLiner: "固钉", category: "nav" },
  { name: "Alert", oneLiner: "警告提示", category: "feedback" },
  { name: "Anchor", oneLiner: "锚点", category: "nav" },
  { name: "App", oneLiner: "应用包裹", category: "general" },
  { name: "AutoComplete", oneLiner: "自动完成", category: "form" },
  { name: "Avatar", oneLiner: "头像", category: "data" },
  { name: "Badge", oneLiner: "徽标", category: "data" },
  { name: "Breadcrumb", oneLiner: "面包屑", category: "nav" },
  { name: "Button", oneLiner: "按钮", category: "general" },
  { name: "Calendar", oneLiner: "日历", category: "data" },
  { name: "Card", oneLiner: "卡片", category: "data" },
  { name: "Carousel", oneLiner: "走马灯", category: "data" },
  { name: "Cascader", oneLiner: "级联选择", category: "form" },
  { name: "Checkbox", oneLiner: "多选框", category: "form" },
  { name: "Col", oneLiner: "栅格列", category: "layout" },
  { name: "Collapse", oneLiner: "折叠面板", category: "data" },
  { name: "ColorPicker", oneLiner: "颜色选择", category: "form" },
  { name: "ConfigProvider", oneLiner: "全局化配置", category: "general" },
  { name: "DatePicker", oneLiner: "日期选择", category: "form" },
  { name: "Descriptions", oneLiner: "描述列表", category: "data" },
  { name: "Divider", oneLiner: "分割线", category: "layout" },
  { name: "Drawer", oneLiner: "抽屉", category: "feedback" },
  { name: "Dropdown", oneLiner: "下拉菜单", category: "nav" },
  { name: "Empty", oneLiner: "空状态", category: "feedback" },
  { name: "Flex", oneLiner: "弹性布局", category: "layout" },
  { name: "FloatButton", oneLiner: "悬浮按钮", category: "general" },
  { name: "Form", oneLiner: "表单", category: "form" },
  { name: "Image", oneLiner: "图片", category: "data" },
  { name: "Input", oneLiner: "输入框", category: "form" },
  { name: "InputNumber", oneLiner: "数字输入", category: "form" },
  { name: "Layout", oneLiner: "布局", category: "layout" },
  { name: "List", oneLiner: "列表", category: "data" },
  { name: "Mentions", oneLiner: "提及", category: "form" },
  { name: "Menu", oneLiner: "菜单", category: "nav" },
  { name: "Message", oneLiner: "全局提示", category: "feedback" },
  { name: "Modal", oneLiner: "对话框", category: "feedback" },
  { name: "Notification", oneLiner: "通知提醒框", category: "feedback" },
  { name: "Pagination", oneLiner: "分页", category: "nav" },
  { name: "Popconfirm", oneLiner: "气泡确认", category: "feedback" },
  { name: "Popover", oneLiner: "气泡卡片", category: "feedback" },
  { name: "Progress", oneLiner: "进度条", category: "feedback" },
  { name: "QRCode", oneLiner: "二维码", category: "data" },
  { name: "Radio", oneLiner: "单选框", category: "form" },
  { name: "Rate", oneLiner: "评分", category: "form" },
  { name: "Result", oneLiner: "结果", category: "feedback" },
  { name: "Row", oneLiner: "栅格行", category: "layout" },
  { name: "Segmented", oneLiner: "分段控制器", category: "form" },
  { name: "Select", oneLiner: "选择器，支持多选", category: "form" },
  { name: "Skeleton", oneLiner: "骨架屏", category: "feedback" },
  { name: "Slider", oneLiner: "滑动输入条", category: "form" },
  { name: "Space", oneLiner: "间距", category: "layout" },
  { name: "Spin", oneLiner: "加载中", category: "feedback" },
  { name: "Statistic", oneLiner: "统计数值", category: "data" },
  { name: "Steps", oneLiner: "步骤条", category: "nav" },
  { name: "Switch", oneLiner: "开关", category: "form" },
  { name: "Table", oneLiner: "表格", category: "data" },
  { name: "Tabs", oneLiner: "标签页", category: "nav" },
  { name: "Tag", oneLiner: "标签", category: "data" },
  { name: "TimePicker", oneLiner: "时间选择", category: "form" },
  { name: "Timeline", oneLiner: "时间轴", category: "data" },
  { name: "Tooltip", oneLiner: "文字提示", category: "feedback" },
  { name: "Tour", oneLiner: "漫游式引导", category: "feedback" },
  { name: "Transfer", oneLiner: "穿梭框", category: "form" },
  { name: "Tree", oneLiner: "树", category: "data" },
  { name: "TreeSelect", oneLiner: "树选择", category: "form" },
  { name: "Typography", oneLiner: "排版", category: "general" },
  { name: "Upload", oneLiner: "上传", category: "form" },
  { name: "Watermark", oneLiner: "水印", category: "feedback" },
];

/** 包名 → 内置目录。命中即用，未命中由 library-catalog 退回现算 d.ts。 */
const BUILTIN: Record<string, CatalogEntry[]> = {
  '@tencent/tea-component': TEA_COMPONENT,
  antd: ANTD,
};

/**
 * 取某个包的内置目录。返回**副本** —— 调用方会排序、过滤、打分，
 * 直接把模块级常量交出去，一次查询就会永久改掉后续所有查询的结果。
 */
export function builtinCatalog(pkg: string): CatalogEntry[] | null {
  const hit = BUILTIN[pkg];
  return hit ? hit.map((e) => ({ ...e })) : null;
}

/** 有内置目录的包名清单，供 init 报告认得出哪些组件库。 */
export function builtinPackages(): string[] {
  return Object.keys(BUILTIN);
}
