/**
 * 代码图谱的**跨语言统一契约**。
 *
 * 为什么单独成文件（原来这些类型和 Babel 建图逻辑挤在 graph-builder.ts 里）：
 * ADR-051 把建图拆成可插拔的 GraphAnalyzer 后，类型必须是所有分析器
 * （node-babel / python-ast / java-spring / 外部 MCP）共同依赖的**中立层**。
 * 若类型还留在 graph-builder.ts，各分析器 import 它就会形成循环依赖。
 *
 * ── 不可协商的一条 ──
 * 无论哪种语言的分析器，产出必须是这里的 CodeGraph。
 * 因为 analyzeImpact / hotSpots / traceRoute / query_code_graph 全部只依赖本结构，
 * 与语言无关 —— 这是"新增一种语言不用改查图代码"的全部前提。
 */

/** 模块（= 一个源文件） */
export interface ModuleNode {
  /** 相对仓库根路径 */
  file: string;
  /** 该文件 require/import 了哪些**本仓库内**的文件（第三方包不入图） */
  imports: string[];
  /** 被哪些文件引用（反向边，建图末尾统一回填） */
  importedBy: string[];
  /** 文件内定义的函数/方法数 */
  symbolCount: number;
}

/** 类（JS 里是 class 声明；也含"当作命名空间的导出对象"） */
export interface ClassNode {
  name: string;
  file: string;
  line: number;
  /** 'class' 真正的 class；'object' 是 const x = {...} 这种对象字面量命名空间 */
  kind: 'class' | 'object';
  methods: string[];
}

/** 函数/方法 */
export interface FunctionNode {
  name: string;
  file: string;
  line: number;
  endLine: number;
  /** 是否被导出（exported 的才可能被别的模块调用） */
  exported: boolean;
  /** 所属类/对象名（顶层函数为 null） */
  owner: string | null;
  /**
   * 定义形态，便于排查提取覆盖率。
   *
   * `component` / `hook` 是 web-frontend 分析器加的：前端仓里"这是个可复用组件"
   * 与"这是个普通工具函数"要能区分，否则 agent 无法回答"仓里已有哪些组件可复用"——
   * 而重复造组件正是前端 AI 代码腐化的主因。判据是生态硬约定
   * （PascalCase + 返回 JSX = 组件；use 开头 = hook），不是猜。
   */
  form: 'function' | 'method' | 'arrow' | 'exports-prop' | 'component' | 'hook';
}

/**
 * 边的可信度分级。
 *
 * ── 为什么必须有这一层 ──
 * 分析器里同时存在两类边：AST 直接读出来的（`import x from './y'`）与
 * **启发式推出来的**（vue 模板正则匹配、路由表 key 形似路径、构建配置正则捞 alias）。
 * 在此之前两者进图后完全等价，agent 无从区分哪条可信 ——
 * 于是它会用一条正则猜出来的边去论证"这个组件没人用，可以删"。
 *
 * 这正是 ADR-051 §5.8.5 那条教训的推广：**给工具加纪律的同时必须给工具划边界**。
 * 分级本身不减少边，只让消费端能把"猜的"单独列出来说清楚。
 *
 * 缺省视为 `extracted` —— 历史图谱与尚未改造的分析器不带这个字段（同 `analyzer?`）。
 */
export type EdgeTier = 'extracted' | 'inferred';

/**
 * 边的语义类型 —— **影响面加权**用（见 graph-builder.ts 的 EDGE_WEIGHTS）。
 *
 * 为什么需要：此前 analyzeImpact 是无权 BFS，"真渲染了这个组件"与
 * "只是 import 了它的一个类型"权重相同，结果是"受影响 22 个页面"里
 * 强弱混在一起，agent 分不出该重点回归哪几个。
 */
export type EdgeKind = 'call' | 'jsx' | 'api' | 'inherit';

/**
 * 一条调用边。
 *
 * ── 两个跨语言约定（由 web-frontend 引入，其它分析器不产出，故不影响既有图）──
 *   `toObj === '@api'`     —— 调用外部 HTTP 接口，`toMethod` 形如 `'POST /console/x'`，
 *                             `toFile` 为 null（目标不在本仓）。**这是跨仓联结点**：
 *                             它与后端仓 `RouteNode.urlPath` 处在同一命名空间。
 *   `toMethod === '<jsx>'` —— 组件引用（`<UserPicker/>`）。前端真正的"调用"发生在
 *                             渲染而非函数调用，不认它就等于没有调用图。
 */
export interface CallEdge {
  fromFile: string;
  /** 调用点所在函数（找不到时为 '<top>'） */
  fromFn: string;
  /** 被调对象名（如 codeBatchService）；'@api' 表示外部 HTTP 接口 */
  toObj: string | null;
  toMethod: string;
  /** 解析出的目标文件（靠 require 变量名反查；解析不到为 null） */
  toFile: string | null;
  line: number;
  /** 语义类型，影响加权。缺省按 'call' 处理 */
  kind?: EdgeKind;
  /** 可信度。缺省按 'extracted' 处理 */
  tier?: EdgeTier;
}

/**
 * 路由 = **影响范围的终点**（用户能直接看见的入口）。
 *
 * 后端是 HTTP 接口（`method` 为 GET/POST/…）；前端是**页面**（`method` 固定 `'PAGE'`，
 * `handlerFile/Fn` 指页面组件，`middlewares` 是 HOC 链如 `withCheck()`）。
 * 两者共用同一结构不是凑合：analyzeImpact 问的"改它会波及多少个对外入口"，
 * 在两种仓里是同一个问题，所以查图代码可以完全不变。
 */
export interface RouteNode {
  method: string;
  urlPath: string;
  /** 中间件链（如 verifyToken()） */
  middlewares: string[];
  /** handler 所在文件与方法 */
  handlerFile: string | null;
  handlerFn: string;
  file: string;
  line: number;
  /** 这条路由是怎么认出来的。缺省 'extracted'。见 EdgeTier */
  tier?: EdgeTier;
}

/**
 * Go struct 字段（及同类「带 tag 的成员」）。
 *
 * 可选：分析器不产出则查图走函数级 BFS，行为不变。
 * 用来回答「改 bson/json tag 会影响哪些读写点」，而不是把整个 dto 文件扩成全部接口。
 */
export interface FieldNode {
  file: string;
  struct: string;
  /** 源码里的字段名，如 Status */
  name: string;
  line: number;
  /** 解析到的 tag，如 { bson: 'status', json: 'Status' } */
  tags: Record<string, string>;
  /** Go：字段类型字面量，如 `logic.McpLogic`。缺省 = 分析器没采类型 */
  typeName?: string;
}

/**
 * 契约字符串的弱引用（tag 值、字面量、模板 SDK 标识符）。
 *
 * 必须标 `inferred`：这是词法命中，不是类型确认的边。
 * 禁止把这些写进 CallEdge —— 否则 template/*.js 会污染 resolvedCalls。
 */
export interface LiteralRef {
  value: string;
  file: string;
  line: number;
  via: 'tag' | 'string' | 'dot';
  tier: 'inferred';
}

/** 页面跳转（history.push / navigate）。只收 pathname 字面量，不猜变量。 */
export interface NavigationEdge {
  fromFile: string;
  fromFn: string;
  /** 已补前导 / */
  toPath: string;
  line: number;
  tier?: EdgeTier;
}

/**
 * 从调用点反推的一条接口契约。
 *
 * `api` 与 CallEdge.toMethod 同一命名空间（`'POST /yApi/...'`）。
 * 请求字段是顶层属性名；响应字段是成员链（`'data.items'`）。
 */
export interface ApiContract {
  api: string;
  service?: { file: string; name: string; line: number } | null;
  callSiteCount: number;
  request: ApiField[];
  response: ApiField[];
  /** 调用点之间字段集合不一致 */
  divergent?: boolean;
}

export interface ApiField {
  /** 请求=顶层属性名；响应=成员链，如 'data.items' */
  name: string;
  /** 推断不到就省略，禁止填 any */
  inferredType?: 'string' | 'number' | 'boolean' | 'array' | 'object';
  seen: { have: number; total: number };
  optional: boolean;
  sources: Array<{ file: string; line: number; expr?: string }>;
}

export type PageTag = 'list' | 'pagination' | 'search' | 'table' | 'form' | 'modal' | 'detail';

/** 一个页面 handler 的结构指纹，供 similar 匹配。不含 embedding。 */
export interface PageFingerprint {
  file: string;
  urlPath?: string;
  /** 该文件 import 的本地名（含第三方，如 Table / usePagination） */
  imports: string[];
  /** 该文件用到的 PascalCase JSX 标签（含第三方组件库） */
  jsx: string[];
  tags: PageTag[];
}

export interface CodeGraph {
  ok: boolean;
  repoDir: string;
  modules: ModuleNode[];
  classes: ClassNode[];
  functions: FunctionNode[];
  calls: CallEdge[];
  routes: RouteNode[];
  stats: {
    files: number;
    parseFailed: number;
    modules: number;
    classes: number;
    functions: number;
    exportedFunctions: number;
    calls: number;
    resolvedCalls: number;
    routes: number;
    /** 路由能追到 service 层的比例（衡量图谱可用性的核心指标） */
    routesTracedToService: number;
    buildMs: number;
  };
  warnings: string[];
  builtAt: number;
  /**
   * 产出这张图的分析器名（如 'node-babel'）。
   *
   * 可选是为了**不破坏已入库的历史图谱** —— code_graphs 表里存的是整个 CodeGraph
   * JSON，线上已有 1 条（anxin-console-server，255 文件）没有这个字段。
   * 设为必填会让读取历史行的类型断言失真。
   */
  analyzer?: string;
  /**
   * 从调用点反推的接口契约。缺省不存在 = 该分析器不产出契约（后端图行为不变）。
   *
   * 权威源是本仓库调用点，不是 yApi / swagger。调用点之间字段集合不一致时
   * `divergent: true`，消费端必须把差异展示出来，不准合并成一份假契约。
   */
  apiContracts?: ApiContract[];
  /**
   * 页面结构指纹。`similar` 用它找「这类活儿仓里怎么写」，hot 仍然只看扇入。
   * 只 web-frontend 产出。
   */
  pageFingerprints?: PageFingerprint[];
  /** 字面量页面跳转。缺省不存在 = 该分析器不产出。 */
  navigations?: NavigationEdge[];
  /**
   * struct 字段。缺省不存在 = 该分析器不产出字段维度（查图仍走函数级 BFS）。
   */
  fields?: FieldNode[];
  /**
   * tag / 字符串 / 点号访问的弱引用。缺省不存在 = 不产出。
   * 不得计入 stats.calls / resolvedCalls。
   */
  literalRefs?: LiteralRef[];
  /**
   * **本分析器自述看不见什么** —— 每条一句人话，直接透给 agent。
   *
   * ── 为什么做成数据而不是写在门禁文案里 ──
   * 盲区是**语言/框架特有**的（前端是样式与动态 import，Python 是 getattr 与装饰器注册，
   * Spring 是 DI 与反射）。写死在 hard_gate 里意味着每接一种语言就要手写一遍，
   * 而且后端仓的门禁里根本不会有前端那几条 —— 漏了不报错，只是 agent 少了一层防护。
   *
   * 做成分析器自述之后：门禁只写"注意本图谱的盲区（工具输出会列）"，
   * **新增语言时盲区说明自动跟着走**。
   *
   * 它防的是同一个失败模式：agent 把"图谱里没有调用者"读成"可以安全删除"。
   */
  blindSpots?: string[];
}

/**
 * 空图工厂。
 *
 * 每个分析器在"目录不存在 / 枚举失败 / 子进程崩了"时都要返回同一形状的空图，
 * 而不是抛异常 —— 知识层故障绝不能阻塞 ReAct。抽出来避免各分析器手抄 stats 的 11 个字段
 * （抄漏一个就是 undefined，前端 toLocaleString() 会崩）。
 */
export function emptyGraph(repoDir: string, analyzer?: string): CodeGraph {
  return {
    ok: false,
    repoDir,
    modules: [],
    classes: [],
    functions: [],
    calls: [],
    routes: [],
    stats: {
      files: 0, parseFailed: 0, modules: 0, classes: 0, functions: 0,
      exportedFunctions: 0, calls: 0, resolvedCalls: 0, routes: 0,
      routesTracedToService: 0, buildMs: 0,
    },
    warnings: [],
    builtAt: Date.now(),
    ...(analyzer ? { analyzer } : {}),
  };
}
