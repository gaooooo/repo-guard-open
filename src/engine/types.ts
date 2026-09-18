/**
 * MVP · 工程上下文治理 — 类型定义
 *
 * 承载业务仓库 `.knowledge/` 目录里的两类配置：
 *   - `policy.yaml` → 红线 / 禁止重构清单 / 停止条件（**规范性知识**，模型永远推不出来）
 *   - `index.yaml`  → task_routes：任务类型 → 必读文件清单（把"该读什么"从概率问题变确定性问题）
 *
 * 设计取舍：
 *   - 只做"仓库轨"：这些文件跟业务仓库的 commit 走，与代码零延迟锚定。
 *     约束类知识放平台会有更新窗口延迟——开发者刚提 breaking change，
 *     agent 可能仍基于过期红线自动改代码。
 *   - 字段全部可选 + 有默认值：一份手写残缺的 yaml 也不能让 agent 跑不起来。
 *   - 预留 `verify: 'llm'` 位但 MVP 不实现（求判定可复现）。
 */

/** 红线违规时的处置动作。MVP 只实现 stop_and_ask / warn。 */
export type ViolationAction = 'stop_and_ask' | 'warn';

/** 判定方式。MVP 只实现 auto（结构化+ 正则）；llm 预留位。 */
export type VerifyMode = 'auto' | 'llm';

/**
 * 一条红线规则。
 *
 * 判定逻辑（见 policy-engine）分三层：
 *   L1 结构化删除判定 — file_write 是全量覆盖写，读磁盘 before 可拿到**真 diff**
 *   L2 意图正则       — bash 场景，要求「受保护标识符」+「破坏性动作」同时命中
 *   L3 paths 收窄— 只在匹配路径生效，压误报
 */
export interface PolicyRule {
  /** 规则号，如 RL-001。用于中断消息与试跑器回显 */
  id: string;
  /** 一句话规则本身（会注入 prompt，给 LLM 看） */
  rule: string;
  /** 为什么（**最重要**：让 LLM 理解意图而非死记，也是给人看的评审依据） */
  reason?: string;
  /**
   * 受保护标识符：字段名 / 函数名 / 常量名。
   * L1 判定「before 含、after 不含」即视为删除；L2 要求与破坏性动作同时命中。
   */
  protects?: string[];
  /** 生效路径 glob（如 `upgrade/*.sql`）。为空 = 全仓库生效 */
  paths?: string[];
  /** 命中后的动作。默认 stop_and_ask */
  violation_action?: ViolationAction;
  /** 证据出处（如 `upgrade/x.sql:1313`）。仅供人看与界面展示，不参与判定 */
  evidence?: string;
  /** 判定方式。默认 auto */
  verify?: VerifyMode;
  /** 是否启用。默认 true —— 留一个不删规则也能关掉的开关 */
  enabled?: boolean;
  /** 是否已人工确认。false 时 agent 只能当线索，不能当强事实 */
  confirmed?: boolean;
  /**
   * 内容维度 matcher：对 diff 的新增行跑正则。缺省 = 只做路径维度。
   * 非法正则的 matcher 跳过，不让一条坏规则拖死整份红线。
   */
  contentMatchers?: ContentMatcher[];
}

export interface ContentMatcher {
  /** JS 正则源 */
  pattern: string;
  flags?: string;
  /** 命中时的 expect 文案 */
  message: string;
}

/** 禁止重构条目：AI 最爱重构"看起来脏"的历史代码，必须显式拦住 */
export interface NoRefactorEntry {
  path: string;
  reason?: string;
  confirmed?: boolean;
}

/** policy.yaml 的解析结果 */
export interface PolicyDoc {
  red_lines: PolicyRule[];
  no_refactor: NoRefactorEntry[];
  /** Agent 必须停下来问人的场景（纯文本，注入 prompt 供 LLM 自觉） */
  stop_conditions: string[];
}

/** 一条任务路由：任务类型 → 必读文件清单 */
export interface TaskRoute {
  /** 必读文件相对路径（相对仓库根） */
  required: string[];
  /** 该任务类型建议挂的 skill 名（MVP 仅展示，不自动挂载） */
  skills?: string[];
  /** 硬门禁一句话，注入 prompt */
  hard_gate?: string;
}

/** index.yaml 的解析结果 */
export interface IndexDoc {
  task_routes: Record<string, TaskRoute>;
}

/**
 * 一次加载的完整快照。
 * `ok: false` 表示未配置或加载失败 —— 此时全链路必须降级为"什么都不做"，
 * 绝不能因为知识层故障阻塞 ReAct（照抄ADR-037 workspace 的容错姿势）。
 */
export interface KnowledgeSnapshot {
  ok: boolean;
  /** 仓库根绝对路径 */
  repoDir: string;
  policy: PolicyDoc;
  index: IndexDoc;
  /** 实际读到的文件相对路径（供界面显示"本次加载了哪几份"） */
  loadedFiles: string[];
  /** 加载过程中的非致命问题（YAML 语法错、字段缺失等），供界面提示 */
  warnings: string[];
}

/** 红线判定结论 */
export interface PolicyVerdict {
  /** 是否应当拦截 */
  blocked: boolean;
  /** 命中的规则 */
  rule?: PolicyRule;
  /** 命中原因（人话，会拼进给 LLM 的中断消息） */
  detail?: string;
  /** 命中的受保护标识符 */
  matched?: string[];
  /** 走的哪一层判定，便于调试与试跑器回显 */
  layer?: 'structural_delete' | 'intent_regex' | 'no_refactor' | 'content_match';
}

/** 空快照工厂：未配置 / 加载失败时统一返回这个，让调用方无需判 null */
export function emptySnapshot(repoDir = ''): KnowledgeSnapshot {
  return {
    ok: false,
    repoDir,
    policy: { red_lines: [], no_refactor: [], stop_conditions: [] },
    index: { task_routes: {} },
    loadedFiles: [],
    warnings: [],
  };
}
