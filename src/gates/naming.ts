/**
 * 资源命名工具 —— 新建门按「写的是哪个资源」判定时用。
 *
 * 从原自带图谱引擎的 similar-methods.ts 原样搬来（图谱算法已迁入 code-atlas），
 * 只保留纯字符串函数：不依赖图谱，钩子里可以零开销调用。
 * 规则必须与 code-atlas 的 similar 保持一致 —— 那边给出的 plan.keys 正是按同一套归一键算的。
 */

/** 动词前缀。顺序有意义：长的在前，避免 `Get` 抢走 `GetOrCreate` 这类 */
const VERBS = [
  'Describe', 'Create', 'Modify', 'Delete', 'Update', 'Remove', 'Get', 'List', 'Query',
  'Enable', 'Disable', 'Bind', 'Unbind', 'Search', 'Handle', 'Check', 'Sync', 'Refresh',
  'Download', 'Upload', 'Open', 'Register', 'Validate', 'Report', 'Add', 'Set', 'Batch',
] as const;

export type CrudVerb = 'Describe' | 'Create' | 'Modify' | 'Delete';

/** 拆出 {verb, family}。没有已知动词时 verb 为空、family 为原名 */
function splitVerb(name: string): { verb: string; family: string } {
  for (const v of VERBS) {
    if (name.startsWith(v) && name.length > v.length && /[A-Z]/.test(name[v.length])) {
      return { verb: v, family: name.slice(v.length) };
    }
  }
  return { verb: '', family: name };
}

/**
 * 家族归一键：小写 + 去复数。DescribeAIMCredentials 与 CreateAIMCredential 同族。
 * 复数只处理英文常见三种：-ies → -y（Categories）、-sses → -ss（Accesses）、-s。
 * 以 ss 结尾的单数（Access）不动 —— 否则会被砍成 acces，和 Accesses 分成两族。
 */
function familyKey(family: string): string {
  const k = family.toLowerCase();
  if (k.length <= 3) return k;
  if (k.endsWith('ies')) return `${k.slice(0, -3)}y`;
  if (k.endsWith('sses')) return k.slice(0, -2);
  if (k.endsWith('ss')) return k;
  return k.endsWith('s') ? k.slice(0, -1) : k;
}

/** 各种动词写法归一到 CRUD 四个动作 */
const VERB_CANON: Record<string, CrudVerb> = {
  describe: 'Describe', get: 'Describe', list: 'Describe', query: 'Describe', search: 'Describe', find: 'Describe', detail: 'Describe',
  create: 'Create', add: 'Create', insert: 'Create', new: 'Create',
  modify: 'Modify', update: 'Modify', set: 'Modify', edit: 'Modify',
  delete: 'Delete', remove: 'Delete',
};
function canonVerb(v: string): CrudVerb | null {
  return VERB_CANON[v.toLowerCase()] ?? null;
}

/**
 * 两个资源键算不算同一个资源：相同，或带了前缀（aimasset 与 asset）。
 * 真机实测：AI 查的是 Asset，写出来叫 CreateAIMAsset（照本仓 AIM 前缀的命名）——
 * 只认完全相同，新建门会误拦、写后比对会一个都对不上。
 */
export function sameResource(key: string, known: string[]): boolean {
  return known.some((k) => key === k || (k.length >= 3 && key.endsWith(k)) || (key.length >= 3 && k.endsWith(key)));
}

/**
 * 一段 Go 源码里定义了哪些「CRUD 动词 + 资源」的方法。新建门按资源判定时用：
 * 写的是 CreateAsset，本轮 similar 查的却只有 User —— 那 Asset 的参考还没拿。
 * 只认 Go 的 func 声明；前端走页面指纹，不按资源判。
 */
export function crudFamiliesInSource(src: string): Array<{ name: string; key: string; verb: CrudVerb }> {
  const out: Array<{ name: string; key: string; verb: CrudVerb }> = [];
  const re = /^func\s+(?:\([^)]*\)\s*)?([A-Z][A-Za-z0-9_]*)\s*[[(]/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const { verb, family } = splitVerb(m[1]);
    const v = canonVerb(verb);
    if (v && family.length >= 3) out.push({ name: m[1], key: familyKey(family), verb: v });
  }
  return out;
}
