/**
 * GraphAnalyzer —— 可插拔的代码图谱分析器契约（ADR-051 §5.2）。
 *
 * ── 为什么要这层抽象 ──
 * 重构前 graph-builder.ts 把三件事焊死在一起：
 *   遍历文件（EXTS 写死 6 个 JS 扩展名）→ Babel 解析 → 认 router.post() 这种 koa 路由
 * 后果是 **Java/Go/Python 仓库进来得到一张空图，而且不报错**（最坏的失败模式：
 * 静默给出"这个仓没有任何依赖关系"的假答案，agent 会据此做出错误的影响面判断）。
 *
 * ── 为什么按「语言 × 框架」分而不只按语言 ──
 * 路由识别是**框架**相关的：Spring 是 @RequestMapping、Gin 是 r.POST、
 * FastAPI 是 @app.get。Spring 和 Quarkus 都是 Java 但注解完全不同。
 * 所以菜单上给人选的是"Java + Spring"，不是"Java"。
 */
import type { CodeGraph } from './types.js';

/** detect 的结果 */
export interface DetectResult {
  /**
   * 0-1 置信度。
   *
   * 为什么不是 boolean：同一个仓可能多个分析器都能处理（Node 仓既有 koa 又有
   * express 路由），需要排序择优；更重要的是有了阈值就能在"所有分析器都低于阈值"时
   * 明确告诉用户"这个仓库暂不支持"，而不是给一张空图。
   */
  confidence: number;
  /** 判定依据，直接显示给用户（如"发现 package.json 且 dependencies 含 koa"） */
  reason: string;
}

/** 建图时的可选约定。各分析器不认识的键必须忽略，不得据此失败。 */
export interface AnalyzeOptions {
  /**
   * 相对仓库根的目录前缀，不入主图。
   * `agent/` 只排除仓根下的 agent/，不会误伤 `service/agent/`。
   */
  skipDirs?: string[];
}

export interface GraphAnalyzer {
  /** 唯一标识，如 'node-babel' / 'python-fastapi' */
  readonly name: string;
  /** 展示名，菜单里给人看 */
  readonly label: string;
  /** 语言 */
  readonly language: string;
  /** 能识别路由的框架列表（空数组 = 只建依赖图不认路由） */
  readonly frameworks: string[];
  /** 处理的文件扩展名 */
  readonly extensions: string[];

  /** 能不能处理这个仓库。看 package.json / pom.xml / go.mod / requirements.txt */
  detect(repoPath: string): Promise<DetectResult>;

  /**
   * 建图。
   *
   * 契约：**绝不抛异常**。失败返回 ok:false + warnings 说明原因
   *（与现有 policy 加载同一姿势 —— 知识层故障不阻塞 ReAct）。
   * `opts` 可缺省；不认识的选项必须忽略。
   */
  analyze(repoPath: string, opts?: AnalyzeOptions): Promise<CodeGraph>;
}

/** 低于此置信度视为"不支持该仓库"，宁可明确报错也不给空图 */
export const DETECT_THRESHOLD = 0.3;
