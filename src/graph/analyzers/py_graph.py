"""
Python 代码图谱提取器 —— 输出与 TS 侧 CodeGraph 完全一致的 JSON。

── 为什么用标准库 ast 而不是 tree-sitter ──
`ast` 是 Python 标准库，零依赖（子进程不能假设目标机器 pip 装了东西），
且给出的是**带 scope 语义的 AST** 而非 tree-sitter 的纯 CST：
  · 函数嵌套关系、装饰器、类方法归属都是结构化字段，不用自己推
  · `ast.get_source_segment` / `end_lineno` 直接给行号区间
换成 tree-sitter 反而要自己重写这些。这是 ADR-051 §5.3
"每种语言用它自己最强的解析器"的具体落地。

── 用法 ──
  python3 py_graph.py <repoDir>
stdout 输出单行 JSON（CodeGraph shape）；解析失败也返回合法 JSON（ok=false + warnings），
**绝不抛异常到 stderr 后退出** —— TS 侧靠 stdout 判定，崩了就拿不到诊断信息。

── 与 node-babel 的对称性 ──
刻意保持相同的字段与容错姿势：单文件解析失败只计数不中断、
文件数超限只建模块级依赖、warnings 上限 20 条。
这样两个分析器的产出在 analyzeImpact / hotSpots / traceRoute 里表现一致。
"""
import ast
import json
import os
import sys
import time

SKIP_DIRS = {
    'node_modules', '.git', 'vendor', 'target', 'build', 'dist', 'out',
    'logs', 'coverage', '.idea', '__pycache__', '.next', 'files', 'public',
    '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache', 'site-packages',
    'migrations',  # Django 自动生成的迁移，噪音大且不体现业务依赖
}
EXTS = ('.py',)
MAX_FILE_BYTES = 2 * 1024 * 1024
FUNCTION_LEVEL_FILE_LIMIT = 3000
MAX_DEPTH = 12
MAX_WARNINGS = 20

# 路由装饰器：FastAPI / Flask 都是 @<obj>.<method>('/path')
HTTP_METHODS = {'get', 'post', 'put', 'delete', 'patch', 'head', 'options'}


def walk(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        depth = dirpath[len(root):].count(os.sep)
        if depth > MAX_DEPTH:
            dirnames[:] = []
            continue
        # 原地裁剪 dirnames 才能让 os.walk 不进入这些目录
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith('.')]
        for fn in filenames:
            if fn.endswith(EXTS):
                out.append(os.path.join(dirpath, fn))
    return out


def rel(root, p):
    return os.path.relpath(p, root).replace(os.sep, '/')


def resolve_import(root, from_file, module, level):
    """
    把 import 目标解析成本仓库内的相对路径。第三方包返回 None（不入图）。

    level>0 是相对 import（`from .svc import x`），基准是当前文件所在包；
    level==0 是绝对 import，按仓库根拼 —— 这对"仓库根就是包根"的常见布局成立，
    对 src-layout（代码在 src/ 下）会漏，接受这个不精确：
    漏解析只是少一条边，而错解析会造出假依赖，后者危害大得多。
    """
    if not module and level == 0:
        return None
    if level > 0:
        base = os.path.dirname(from_file)
        for _ in range(level - 1):
            base = os.path.dirname(base)
        parts = module.split('.') if module else []
    else:
        base = root
        parts = module.split('.')

    cand_base = os.path.join(base, *parts) if parts else base
    for cand in (cand_base + '.py', os.path.join(cand_base, '__init__.py')):
        try:
            if os.path.isfile(cand):
                return rel(root, cand)
        except OSError:
            pass
    return None


def decorator_route(dec):
    """
    从装饰器节点抽 (METHOD, path)。认三种真实写法：
      @app.get('/x')            FastAPI
      @router.post('/x')        FastAPI APIRouter
      @app.route('/x', methods=['POST'])   Flask
    认不出返回 None —— 不猜，宁可少一条路由。
    """
    if not isinstance(dec, ast.Call) or not isinstance(dec.func, ast.Attribute):
        return None
    attr = dec.func.attr
    if not dec.args or not isinstance(dec.args[0], ast.Constant) or not isinstance(dec.args[0].value, str):
        return None
    path = dec.args[0].value

    if attr in HTTP_METHODS:
        return (attr.upper(), path)

    if attr == 'route':
        # Flask：方法在 methods= 关键字里，缺省 GET
        for kw in dec.keywords:
            if kw.arg == 'methods' and isinstance(kw.value, (ast.List, ast.Tuple)):
                for el in kw.value.elts:
                    if isinstance(el, ast.Constant) and isinstance(el.value, str):
                        return (el.value.upper(), path)
        return ('GET', path)
    return None


def dec_name(dec):
    """装饰器的展示名，用于 middlewares（如 @requires_auth → requires_auth）"""
    node = dec.func if isinstance(dec, ast.Call) else dec
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Name):
        return node.id
    return '<expr>'


def build(repo_dir):
    t0 = time.time()
    empty = {
        'ok': False, 'repoDir': repo_dir,
        'modules': [], 'classes': [], 'functions': [], 'calls': [], 'routes': [],
        'stats': {
            'files': 0, 'parseFailed': 0, 'modules': 0, 'classes': 0, 'functions': 0,
            'exportedFunctions': 0, 'calls': 0, 'resolvedCalls': 0, 'routes': 0,
            'routesTracedToService': 0, 'buildMs': 0,
        },
        'warnings': [], 'builtAt': int(time.time() * 1000),
        'analyzer': 'python-ast',
    }
    if not repo_dir or not os.path.isdir(repo_dir):
        empty['warnings'] = ['%s 不是有效目录' % repo_dir]
        return empty

    try:
        files = walk(repo_dir)
    except OSError as e:
        empty['warnings'] = ['枚举源文件失败：%s' % e]
        return empty

    if not files:
        empty['ok'] = True
        empty['stats']['buildMs'] = int((time.time() - t0) * 1000)
        return empty

    warnings = []
    function_level = len(files) <= FUNCTION_LEVEL_FILE_LIMIT
    if not function_level:
        warnings.append(
            '文件数 %d 超过 %d，仅构建模块级依赖（跳过函数级与调用链）'
            % (len(files), FUNCTION_LEVEL_FILE_LIMIT)
        )

    modules = {}
    classes = []
    functions = []
    calls = []
    routes = []
    # `${file}::${name}` → 目标文件。把 `from .svc import do` 里的 do 解析回定义处
    var_to_file = {}
    parse_failed = 0

    for full in files:
        R = rel(repo_dir, full)
        try:
            if os.path.getsize(full) > MAX_FILE_BYTES:
                continue
            with open(full, 'r', encoding='utf-8', errors='replace') as f:
                code = f.read()
        except OSError:
            parse_failed += 1
            continue

        try:
            tree = ast.parse(code, filename=R)
        except (SyntaxError, ValueError) as e:
            parse_failed += 1
            if len(warnings) < MAX_WARNINGS:
                warnings.append('%s 解析失败：%s' % (R, str(e)[:80]))
            continue

        mod = {'file': R, 'imports': [], 'importedBy': [], 'symbolCount': 0}
        modules[R] = mod

        # ── 第一遍：import（后面认调用要靠它反查目标文件）──
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for a in node.names:
                    tgt = resolve_import(repo_dir, full, a.name, 0)
                    if tgt:
                        if tgt not in mod['imports']:
                            mod['imports'].append(tgt)
                        var_to_file['%s::%s' % (R, (a.asname or a.name).split('.')[0])] = tgt
            elif isinstance(node, ast.ImportFrom):
                tgt = resolve_import(repo_dir, full, node.module or '', node.level or 0)
                if tgt:
                    if tgt not in mod['imports']:
                        mod['imports'].append(tgt)
                    for a in node.names:
                        var_to_file['%s::%s' % (R, a.asname or a.name)] = tgt

        if not function_level:
            continue

        # ── 第二遍：类 / 函数 / 路由 / 调用 ──
        # 用显式栈遍历而非 ast.walk，因为要维护"当前所属类"与"当前所属函数"
        def visit_body(body, owner, fn_stack):
            for node in body:
                if isinstance(node, ast.ClassDef):
                    methods = []
                    for m in node.body:
                        if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            methods.append(m.name)
                    classes.append({
                        'name': node.name, 'file': R, 'line': node.lineno,
                        'kind': 'class', 'methods': methods,
                    })
                    visit_body(node.body, node.name, fn_stack)

                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    # Python 没有 export 概念：下划线开头视为私有，其余算对外可见。
                    # 这是社区约定（PEP 8），比"全部标 exported"更有信息量。
                    exported = not node.name.startswith('_')
                    functions.append({
                        'name': node.name, 'file': R, 'line': node.lineno,
                        'endLine': getattr(node, 'end_lineno', node.lineno),
                        'exported': exported,
                        'owner': owner,
                        'form': 'method' if owner else 'function',
                    })
                    # 路由装饰器
                    mws = []
                    hit = None
                    for dec in node.decorator_list:
                        r = decorator_route(dec)
                        if r and hit is None:
                            hit = r
                        else:
                            mws.append(dec_name(dec))
                    if hit:
                        routes.append({
                            'method': hit[0], 'urlPath': hit[1], 'middlewares': mws,
                            'handlerFile': R, 'handlerFn': node.name,
                            'file': R, 'line': node.lineno,
                            # 装饰器是明确的路由声明，非启发式
                            'tier': 'extracted',
                        })
                    visit_body(node.body, owner, fn_stack + [node.name])

                else:
                    # 非定义语句：收集其中的调用边
                    for sub in ast.walk(node):
                        if not isinstance(sub, ast.Call):
                            continue
                        f = sub.func
                        if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name):
                            obj, meth = f.value.id, f.attr
                        elif isinstance(f, ast.Name):
                            obj, meth = None, f.id
                        else:
                            continue
                        key = '%s::%s' % (R, obj if obj else meth)
                        calls.append({
                            'fromFile': R,
                            'fromFn': fn_stack[-1] if fn_stack else '<top>',
                            'toObj': obj,
                            'toMethod': meth,
                            'toFile': var_to_file.get(key),
                            'line': sub.lineno,
                            'kind': 'call',
                            'tier': 'extracted',
                        })

        try:
            visit_body(tree.body, None, [])
        except RecursionError:
            parse_failed += 1
            if len(warnings) < MAX_WARNINGS:
                warnings.append('%s 遍历失败：嵌套过深' % R)

    # ── 回填反向依赖边 ──
    for m in modules.values():
        for dep in m['imports']:
            t = modules.get(dep)
            if t and m['file'] not in t['importedBy']:
                t['importedBy'].append(m['file'])
    for fn in functions:
        m = modules.get(fn['file'])
        if m:
            m['symbolCount'] += 1

    # ── 路由 → service 追通率 ──
    traced = 0
    for r in routes:
        if not r['handlerFile']:
            continue
        target = next(
            (f for f in functions if f['file'] == r['handlerFile'] and f['name'] == r['handlerFn']),
            None,
        )
        if not target:
            continue
        inner = [
            c for c in calls
            if c['fromFile'] == r['handlerFile']
            and target['line'] <= c['line'] <= target['endLine']
            and c['toFile']
        ]
        if inner:
            traced += 1

    build_ms = int((time.time() - t0) * 1000)
    return {
        'ok': True, 'repoDir': repo_dir,
        'modules': list(modules.values()),
        'classes': classes, 'functions': functions, 'calls': calls, 'routes': routes,
        'stats': {
            'files': len(files), 'parseFailed': parse_failed,
            'modules': len(modules), 'classes': len(classes), 'functions': len(functions),
            'exportedFunctions': sum(1 for f in functions if f['exported']),
            'calls': len(calls),
            'resolvedCalls': sum(1 for c in calls if c['toFile']),
            'routes': len(routes), 'routesTracedToService': traced,
            'buildMs': build_ms,
        },
        'warnings': warnings, 'builtAt': int(time.time() * 1000),
        'analyzer': 'python-ast',
        'blindSpots': [
            "绝对 import 按仓库根解析，src-layout（代码在 src/ 下）布局的依赖边会漏",
            "getattr / importlib 动态导入 / 装饰器注册的调用不可见",
            "Django migrations 目录被跳过，不在图中",
            "下划线开头视为私有、其余视为导出，是 PEP 8 约定而非语言层事实",
        ],
    }


def main():
    repo = sys.argv[1] if len(sys.argv) > 1 else ''
    try:
        g = build(repo)
    except Exception as e:  # noqa: BLE001 —— 兜底：任何异常都要输出合法 JSON
        g = {
            'ok': False, 'repoDir': repo,
            'modules': [], 'classes': [], 'functions': [], 'calls': [], 'routes': [],
            'stats': {
                'files': 0, 'parseFailed': 0, 'modules': 0, 'classes': 0, 'functions': 0,
                'exportedFunctions': 0, 'calls': 0, 'resolvedCalls': 0, 'routes': 0,
                'routesTracedToService': 0, 'buildMs': 0,
            },
            'warnings': ['建图异常：%s: %s' % (type(e).__name__, str(e)[:120])],
            'builtAt': int(time.time() * 1000),
            'analyzer': 'python-ast',
        }
    sys.stdout.write(json.dumps(g, ensure_ascii=False))


if __name__ == '__main__':
    main()
