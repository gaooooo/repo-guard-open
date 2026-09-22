/**
 * 分析器注册表 —— 「菜单」的数据来源（ADR-051 §5.2）。
 *
 * ── 它修的是哪个缺陷 ──
 * 重构前非 JS 仓库进来会拿到一张**空图且不报错**。空图是最坏的失败模式：
 * agent 会把"没有任何调用方"当成事实，据此判断"这个函数可以安全删除"。
 * 注册表用置信度阈值把它变成显式失败：所有分析器都低于 DETECT_THRESHOLD 时
 * 明确回"暂不支持该技术栈"，而不是给假答案。
 */
import { createLogger } from '../engine/shims/logger.js';

import { DETECT_THRESHOLD, type GraphAnalyzer, type DetectResult, type AnalyzeOptions } from './analyzer.js';
import { goGinAnalyzer, goTrpcAnalyzer } from './analyzers/go-gin.js';
import { javaSpringAnalyzer } from './analyzers/java-spring.js';
import { nodeBabelAnalyzer } from './analyzers/node-babel.js';
import { pythonAstAnalyzer } from './analyzers/python-ast.js';
import { webFrontendAnalyzer } from './analyzers/web-frontend.js';
import { emptyGraph, type CodeGraph } from './types.js';

const logger = createLogger('graph:registry');

/**
 * 内置分析器。**新增语言只需在这里加一行** —— 这是可插拔的全部代价。
 *
 * 登记顺序无关：`detectAnalyzers` 按置信度排序择优，不靠次序兜底。
 */
const ANALYZERS: GraphAnalyzer[] = [
  nodeBabelAnalyzer,
  pythonAstAnalyzer,
  webFrontendAnalyzer,
  goGinAnalyzer,
  goTrpcAnalyzer,
  javaSpringAnalyzer,
];

/** 菜单用：列出所有可选分析器（不含 detect/analyze 函数，可直接 JSON 化给前端） */
export function listAnalyzers() {
  return ANALYZERS.map((a) => ({
    name: a.name,
    label: a.label,
    language: a.language,
    frameworks: a.frameworks,
    extensions: a.extensions,
  }));
}

export function getAnalyzer(name: string): GraphAnalyzer | undefined {
  return ANALYZERS.find((a) => a.name === name);
}

/** 探测结果（带分析器标识，供菜单展示"推荐 / 备选"） */
export interface AnalyzerCandidate extends DetectResult {
  name: string;
  label: string;
  language: string;
}

/** 让所有分析器探测同一个仓库，按置信度降序返回。detect 抛错的记 0 分不中断 */
export async function detectAnalyzers(repoPath: string): Promise<AnalyzerCandidate[]> {
  const out: AnalyzerCandidate[] = [];
  for (const a of ANALYZERS) {
    try {
      const r = await a.detect(repoPath);
      out.push({ name: a.name, label: a.label, language: a.language, ...r });
    } catch (err) {
      logger.warn({ analyzer: a.name, err: (err as Error).message }, 'detect failed');
      out.push({
        name: a.name, label: a.label, language: a.language,
        confidence: 0, reason: `探测失败：${(err as Error).message.slice(0, 60)}`,
      });
    }
  }
  return out.sort((x, y) => y.confidence - x.confidence);
}

/**
 * 按仓库自动选分析器并建图。
 *
 * @param analyzerName 指定分析器（菜单里人工选了就传）。不传则自动探测取最高分。
 *
 * 人工指定时**跳过阈值检查** —— 用户明知技术栈而探测启发式判错时，
 * 人的判断优先于我们的规则。
 */
export async function buildGraphAuto(
  repoPath: string,
  analyzerName?: string,
  opts?: AnalyzeOptions,
): Promise<CodeGraph> {
  if (analyzerName) {
    const a = getAnalyzer(analyzerName);
    if (!a) {
      return {
        ...emptyGraph(repoPath),
        warnings: [`未知的分析器 '${analyzerName}'，可用：${ANALYZERS.map((x) => x.name).join(' / ')}`],
      };
    }
    return a.analyze(repoPath, opts);
  }

  const candidates = await detectAnalyzers(repoPath);
  const best = candidates[0];
  if (!best || best.confidence < DETECT_THRESHOLD) {
    const detail = candidates.map((c) => `${c.label}(${c.confidence.toFixed(2)}: ${c.reason})`).join('；');
    logger.warn({ repoPath, detail }, 'no analyzer matched');
    return {
      ...emptyGraph(repoPath),
      warnings: [
        `暂不支持该仓库的技术栈，无法建图。探测结果：${detail || '无可用分析器'}。` +
        `可在菜单中手动指定分析器，或联系管理员接入对应语言的分析器。`,
      ],
    };
  }

  logger.info({ repoPath, analyzer: best.name, confidence: best.confidence, reason: best.reason }, 'analyzer selected');
  const graph = await getAnalyzer(best.name)!.analyze(repoPath, opts);
  // 探测理由带进 warnings 是刻意的：让用户在结果页就能看到"为什么用了这个分析器"，
  // 否则图谱不对时无从判断是选错分析器还是解析有 bug
  return {
    ...graph,
    warnings: [`分析器：${best.label}（置信度 ${best.confidence.toFixed(2)} —— ${best.reason}）`, ...graph.warnings],
  };
}
