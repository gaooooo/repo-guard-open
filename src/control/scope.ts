/**
 * 范围与红线的匹配。纯函数，钩子、回执、check 共用。
 */
import path from 'node:path';

import { globMatch } from '../engine/policy-engine.js';
import type { CommandRedline, PathRedline } from './config.js';
import type { TaskContract } from '../runtime/session-state.js';

/** glob 归一：目录前缀（以 / 结尾）或不含通配的目录名 → 加 ** */
export function matches(pattern: string, rel: string): boolean {
  const p = pattern.trim().replace(/^\.\//, '');
  if (!p) return false;
  if (p.endsWith('/')) return rel.startsWith(p) || globMatch(p + '**', rel);
  if (!/[*?]/.test(p)) return rel === p || rel.startsWith(p + '/');
  return globMatch(p, rel);
}

/** 文件是否在契约范围内。同时按仓库相对路径和会话目录相对路径判（多仓工作区可写「子仓/路径」） */
export function inScope(contract: TaskContract, rel: string, abs: string): boolean {
  const fromCwd = path.relative(contract.cwd, abs).split(path.sep).join('/');
  const cands = [rel];
  if (fromCwd && !fromCwd.startsWith('..')) cands.push(fromCwd);
  return contract.scope.some((g) => cands.some((c) => matches(g, c)));
}

/** 测试与文档不计入契约的「第 2 个文件」，也不算越界 */
export function isAuxFile(rel: string): boolean {
  return (
    /(^|\/)(__tests__|tests?|spec|testdata|docs?)\//i.test(rel) ||
    /[._-](test|spec)\.[a-z0-9]+$/i.test(rel) ||
    /_test\.go$/.test(rel) ||
    /\.(md|mdx|txt|rst)$/i.test(rel)
  );
}

export function pathRedlines(rules: PathRedline[], rel: string): PathRedline[] {
  return rules.filter((r) => matches(r.glob, rel));
}

/** 把命令按 && ; || | 换行拆开，逐段匹配 */
export function splitCommand(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\||\n/)
    .map((x) => x.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

function wildcard(pattern: string, text: string): boolean {
  const re = pattern
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.+^$(){}|[\]\\?]/g, '\\$&')
    .replace(/\*/g, '.*');
  try {
    return new RegExp('^' + re + '$').test(text);
  } catch {
    return false;
  }
}

export function commandRedlines(rules: CommandRedline[], cmd: string): CommandRedline[] {
  const parts = splitCommand(cmd);
  return rules.filter((r) => parts.some((p) => wildcard(r.pattern, p)));
}

/** 契约的文字形态：guard_task 回显、注入、回执共用 */
export function contractText(c: TaskContract, fallbackVerify: string[] = []): string {
  const verify = c.verify.length ? c.verify : fallbackVerify;
  return [
    '  目标  ' + c.goal,
    c.nonGoals.length ? '  不做  ' + c.nonGoals.join('；') : '',
    '  范围  ' + c.scope.join(', '),
    '  验收  ' + (verify.length ? verify.join(' && ') : '（未配置验收命令）'),
  ]
    .filter(Boolean)
    .join('\n');
}

/** 一行摘要：每轮提问时注入 */
export function contractLine(c: TaskContract): string {
  return 'repo-guard 当前任务契约：' + c.goal + '｜范围 ' + c.scope.join(', ') + (c.nonGoals.length ? '｜不做 ' + c.nonGoals.join('；') : '');
}