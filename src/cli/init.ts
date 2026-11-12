/**
 * init 的图谱侧推断：code-atlas 返回的数据形状，以及从高扇入热点推测公共层。
 * 接入流程本身（识别、告知、选择、写入）在 src/control/cli.ts。
 */
/** `atlas scan --json` 里 init 用到的字段（与 code-atlas 的 ScanResult 相同） */
export interface ScanResult {
  lineLimit: number;
  oversize: Array<{ file: string; lines: number }>;
  cycles: string[][];
}

/** `atlas hot --json` 的一条热点 */
export interface HotSpot {
  file: string;
  method?: string;
  routeCount: number;
}

/**
 * init 从 code-atlas 拿到的图谱信息。atlas 不可用时 available=false，
 * 图谱相关推断（公共层、体量、循环依赖）整段跳过，其余体检照常。
 */
export interface AtlasInitInfo {
  available: boolean;
  version?: string | null;
  workspace?: string;
  repoId?: string;
  role?: string;
  stats?: { files?: number; nodes?: number; edges?: number };
  /** 本次 init 是否把仓加进了工作区、花了多久 */
  addedMs?: number;
  /** atlas 可用但拿图谱失败时的原因 */
  error?: string;
  hot: HotSpot[] | null;
  scan: ScanResult | null;
}

/** 一条体检发现。`action` 非空表示它在"照这个顺序做"里有对应动作 */
/**
 * 「公共层」的层名白名单。
 *
 * ── 为什么光靠扇入不够 ──
 * 只按扇入 + 前两级目录分组，在 Java 这类深层布局上会推出 `src/main/` ——
 * 那是**整个源码树**。把整棵树标成公共层等于每次写文件都要先查影响面，
 * 也就是等于把人挡在外面。守一切等于什么都没守。
 *
 * 真正的判据是：「公共层」是一个**有名字的概念**（组件 / 工具 / 服务 / 公共），
 * 不是"凡是被引用得多的目录"。所以在扇入排序之上再要求目录名落在这个集合里。
 *
 * 宁缺毋滥：漏掉一个目录，人在 repo-facts.json 里手动加一行就好；
 * 而多推一个错的目录会天天误伤，然后插件被卸载。
 */
const LAYER_NAMES = new Set([
  // 前端
  'components', 'component', 'comps', 'widgets', 'hooks', 'hook',
  'composables', 'mixins', 'directives', 'store', 'stores', 'styles',
  // 通用分层
  'utils', 'util', 'helpers', 'helper', 'common', 'commons', 'shared', 'share',
  'core', 'lib', 'libs', 'sdk', 'constants', 'config', 'configs',
  'types', 'interfaces', 'dto', 'domain', 'entity', 'entities',
  // 服务与数据
  'services', 'service', 'api', 'apis', 'client', 'clients',
  'models', 'model', 'repository', 'repositories', 'dao', 'mapper', 'mappers',
  // 路由与中间件
  'middleware', 'middlewares', 'router', 'routers', 'routes', 'plugins',
]);

export interface PublicLayerGuess {
  prefix: string;
  /** 推测依据：哪个文件、被几个入口引用 */
  evidenceFile: string;
  routeCount: number;
}

/**
 * 从 code-atlas 的高扇入热点推测公共层。
 *
 * 判据是**扇入 + 层名**：被入口（页面 / 路由）引用得越多越像公共层，
 * 但目录名还得真的像一个层（见 LAYER_NAMES 的说明）。
 *
 * 为什么按前两级目录分组：`src/components/DataTable/index.tsx` 的公共层单位是
 * `src/components/` 而不是 `src/components/DataTable/`——
 * 前者是人心里的"公共组件目录"，后者只是一个组件。粒度取错会让配置长到没人看。
 *
 * 为什么不含页面目录：页面是入口本身，没人引用它们，自然不会出现在热点里。
 *
 * 热点来自 `atlas hot --json --limit 200`（code-atlas 的 hotSpots，与原自带引擎同一算法）。
 * 这是"用扇入而不是用目录名关键词"的附带好处 —— 不用维护 views/pages 黑名单。
 */
export function guessPublicLayer(hot: HotSpot[]): PublicLayerGuess[] {
  const best = new Map<string, { file: string; count: number }>();
  for (const s of hot) {
    const segs = s.file.split('/');
    if (segs.length < 3) continue; // 至少 `a/b/c` 才有"前两级目录"
    if (!LAYER_NAMES.has(segs[1].toLowerCase())) continue;
    const prefix = `${segs[0]}/${segs[1]}/`;
    const cur = best.get(prefix);
    if (!cur || s.routeCount > cur.count) {
      best.set(prefix, { file: s.file, count: s.routeCount });
    }
  }
  return [...best.entries()]
    .map(([prefix, v]) => ({ prefix, evidenceFile: v.file, routeCount: v.count }))
    .sort((a, b) => b.routeCount - a.routeCount || a.prefix.localeCompare(b.prefix));
}
