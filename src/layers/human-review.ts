/**
 * 人审层。默认关闭：配置文件不存在 = 与接入前逐字节相同。
 */
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_DIR } from '../runtime/paths.js';

export interface HumanReviewConfig {
  enabled: boolean;
  onRedline: 'ask' | 'deny';
}

const DEFAULT: HumanReviewConfig = { enabled: false, onRedline: 'ask' };

export function loadHumanReview(repoDir: string): HumanReviewConfig {
  const p = path.join(repoDir, CONFIG_DIR, 'human-review.json');
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch {
    return DEFAULT;
  }
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      enabled: v.enabled === true,
      onRedline: v.onRedline === 'deny' ? 'deny' : 'ask',
    };
  } catch {
    return DEFAULT;
  }
}

export function redlineShouldAsk(cfg: HumanReviewConfig): boolean {
  return cfg.enabled && cfg.onRedline === 'ask';
}
