/* repo-guard 图谱体检与沙盘。数据来自 window.RG_DATA（静态）或 /api/view（--serve）。
 * 所有来自代码的字符串（方法名、路径、工具输出）一律经 esc() 或 textContent 写入，
 * 不拼进 innerHTML 的属性值以外的位置。 */
(function () {
  'use strict';

  var MODE = window.RG_MODE || 'static';
  var LAYERS = ['router', 'service', 'sdk', 'logic', 'repo', 'dto', 'other'];
  var LAYER_LABEL = { router: '路由', service: '接口层', sdk: 'SDK', logic: '逻辑层', repo: '存储层', dto: 'DTO', other: '其他' };
  var LAYER_COLOR = { router: '#a78bfa', service: '#5eead4', sdk: '#fbbf24', logic: '#60a5fa', repo: '#fb923c', dto: '#94a3b8', other: '#64748b' };
  var TONE = { target: '#f8fafc', entry: '#f43f5e', direct: '#f59e0b', indirect: '#fde68a', weak: '#64748b', ref: '#22d3ee' };

  var V, H; // view payload, health report
  var nmap = {}, fnMetric = {}, fileMetric = {}, linksBy = { call: [], import: [], owns: [] };
  var state = { tab: 'health', view: 'files', focus: null, expanded: {}, colorBy: 'layer', highlight: null, lastTool: null };
  var chart = echarts.init(document.getElementById('chart'), null, { renderer: 'canvas' });
  var side = document.getElementById('side');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }
  function short(id) { var n = nmap[id]; return n ? (n.kind === 'fn' || n.kind === 'cls' ? n.file + '#' + n.name : n.file || n.name) : id; }

  // ─────────────── 数据装载 ───────────────
  function load(data) {
    V = data.view; H = data.health;
    V.nodes.forEach(function (n) { nmap[n.id] = n; });
    H.functions.forEach(function (f) { fnMetric[f.id] = f; });
    H.files.forEach(function (f) { fileMetric[f.file] = f; });
    V.links.forEach(function (l) { (linksBy[l.rel] = linksBy[l.rel] || []).push(l); });
    $('repo').textContent = V.repo + (V.headSha ? ' @' + V.headSha : '');
    var t = $('trust'); t.textContent = '可信度 ' + H.trust.level; t.className = 'badge ' + H.trust.level;
    t.title = H.trust.reasons.join('\n');
    $('stats').textContent = [
      H.scale.files + ' 文件', H.scale.functions + ' 方法', H.scale.classes + ' 类型', H.scale.calls + ' 调用点',
      H.scale.routes + ' 路由', H.scale.fields + ' 字段',
      '调用解析 ' + H.trust.resolvedCalls + '/' + H.trust.totalCalls,
      '路由追通 ' + H.trust.tracedRoutes + '/' + H.trust.totalRoutes,
      '分析器 ' + (V.analyzer || '?'), '建图 ' + new Date(V.builtAt).toLocaleString(),
      MODE === 'serve' ? '沙盘：在线' : '沙盘：静态页不可用（repo-guard viz --serve）'
    ].join(' · ');
    render();
  }

  // ─────────────── 着色 ───────────────
  var scaleCache = {};
  function metricOf(n, key) {
    if (n.kind === 'fn') return n[key] || 0;
    if (n.kind === 'file') {
      var fm = fileMetric[n.file] || {};
      return { loc: fm.lines || 0, fanIn: fm.importedBy || 0, fanOut: fm.imports || 0, cx: (fm.lines || 0) * (fm.fns || 0) }[key] || 0;
    }
    return 0;
  }
  function p95(kind, key) {
    var k = kind + ':' + key;
    if (scaleCache[k] != null) return scaleCache[k];
    var xs = V.nodes.filter(function (n) { return n.kind === kind; }).map(function (n) { return metricOf(n, key); }).sort(function (a, b) { return a - b; });
    var v = xs.length ? xs[Math.floor(xs.length * 0.95)] || xs[xs.length - 1] : 1;
    return (scaleCache[k] = Math.max(1, v));
  }
  function heat(t) { // 0..1 → 青 → 黄 → 红
    t = Math.max(0, Math.min(1, t));
    var a = t < 0.5 ? [45, 212, 191] : [245, 158, 11], b = t < 0.5 ? [245, 158, 11] : [244, 63, 94];
    var u = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    return 'rgb(' + a.map(function (x, i) { return Math.round(x + (b[i] - x) * u); }).join(',') + ')';
  }
  function colorOf(n) {
    if (n.kind === 'svc') return '#e8eef6';
    var by = state.colorBy;
    if (by === 'layer') return LAYER_COLOR[n.layer] || '#64748b';
    if (by === 'public') return n.publicLayer ? '#f43f5e' : '#334155';
    if (n.kind === 'cls') return '#475569';
    var v = metricOf(n, by);
    if (!v) return '#334155';
    return heat(Math.log(1 + v) / Math.log(1 + p95(n.kind, by)));
  }
  function sizeOf(n) {
    if (n.kind === 'svc') return 40;
    if (n.kind === 'file') return 8 + Math.min(14, Math.sqrt((fileMetric[n.file] || {}).fns || 1) * 2);
    if (n.kind === 'cls') return 12;
    return Math.min(26, 8 + Math.sqrt(n.fanIn || 0) * 2.5) + (n.god ? 4 : 0);
  }

  // ─────────────── 布局 ───────────────
  // 分层列：调用方在左、被调方在右（路由 → 接口 → SDK → 逻辑 → 存储 → DTO）
  function layerX(layer, present) {
    var order = LAYERS.filter(function (l) { return !present || present[l]; });
    var i = order.indexOf(layer); return (i < 0 ? order.length : i) * 330;
  }

  function layoutFiles(nodes) {
    var cols = {}, kids = {};
    nodes.forEach(function (n) {
      if (n.kind === 'file') (cols[n.layer] = cols[n.layer] || []).push(n);
      else if (n.kind === 'fn' || n.kind === 'cls') (kids[n.file] = kids[n.file] || []).push(n);
    });
    var out = [];
    Object.keys(cols).forEach(function (layer) {
      var x = layerX(layer, cols), y = 60;
      out.push({ id: 'col:' + layer, name: LAYER_LABEL[layer] + ' · ' + cols[layer].length, kind: 'col', x: x, y: 10, fixed: true, symbolSize: 1, label: { show: true, color: LAYER_COLOR[layer], fontSize: 13, fontWeight: 600 } });
      cols[layer].sort(function (a, b) { return a.file.localeCompare(b.file); }).forEach(function (f) {
        out.push(Object.assign({}, f, { x: x, y: y, fixed: true }));
        y += 22;
        (kids[f.file] || []).sort(function (a, b) { return (a.kind === 'cls' ? 0 : 1) - (b.kind === 'cls' ? 0 : 1) || (a.line || 0) - (b.line || 0); })
          .forEach(function (k) { out.push(Object.assign({}, k, { x: x + 40, y: y, fixed: true })); y += 18; });
      });
    });
    return out;
  }

  function layoutRings(nodes) {
    var buckets = {};
    nodes.forEach(function (n) { if (n.kind !== 'svc') (buckets[n.layer] = buckets[n.layer] || []).push(n); });
    var out = [], cx = 0;
    LAYERS.forEach(function (layer) {
      var items = (buckets[layer] || []).sort(function (a, b) { return (b.fanIn || 0) - (a.fanIn || 0) || a.name.localeCompare(b.name); });
      if (!items.length) return;
      var ring = 0, i = 0, spacing = 24, maxR = 60;
      while (i < items.length) {
        ring++;
        var r = 40 + ring * 28, cap = Math.max(8, Math.floor(2 * Math.PI * r / spacing)), take = Math.min(cap, items.length - i);
        for (var k = 0; k < take; k++) {
          var ang = -Math.PI / 2 + 2 * Math.PI * k / take;
          out.push(Object.assign({}, items[i + k], { x: Math.cos(ang) * r, y: Math.sin(ang) * r, fixed: true, _ring: layer }));
        }
        i += take; maxR = r;
      }
      out.filter(function (n) { return n._ring === layer; }).forEach(function (n) { n.x += cx + maxR; });
      out.push({ id: 'col:' + layer, name: LAYER_LABEL[layer] + ' · ' + items.length, kind: 'col', x: cx + maxR, y: -maxR - 30, fixed: true, symbolSize: 1, label: { show: true, color: LAYER_COLOR[layer], fontSize: 13, fontWeight: 600 } });
      cx += 2 * maxR + 120;
    });
    return out;
  }

  /** 分层有向：按调用深度分列（负 = 调用方，正 = 被调方） */
  function layoutDepth(depth) {
    var cols = {};
    Object.keys(depth).forEach(function (id) { (cols[depth[id]] = cols[depth[id]] || []).push(id); });
    var out = [];
    Object.keys(cols).forEach(function (d) {
      var ids = cols[d].sort(function (a, b) { return ((nmap[a] || {}).layer || '').localeCompare((nmap[b] || {}).layer || '') || short(a).localeCompare(short(b)); });
      var h = ids.length * 34;
      ids.forEach(function (id, i) { var n = nmap[id]; if (n) out.push(Object.assign({}, n, { x: Number(d) * 300, y: i * 34 - h / 2, fixed: true })); });
    });
    return out;
  }

  // ─────────────── 视图 ───────────────
  function edgeStyle(rel) {
    if (rel === 'owns') return { color: '#334155', opacity: 0.25, width: 1, curveness: 0 };
    if (rel === 'import') return { color: '#64748b', opacity: 0.18, width: 1, type: 'dashed', curveness: 0.15 };
    if (rel === 'inferred') return { color: '#fbbf24', opacity: 0.7, width: 1.3, type: 'dashed', curveness: 0.12 };
    return { color: '#67e8f9', opacity: 0.55, width: 1.3, curveness: 0.2 };
  }
  function draw(nodes, links, opts) {
    opts = opts || {};
    var tone = opts.tone || {};
    var ids = {};
    nodes.forEach(function (n) { ids[n.id] = 1; });
    var data = nodes.map(function (n) {
      if (n.kind === 'col') return n;
      var t = tone[n.id];
      var labeled = opts.labelAll || t || n.id === state.focus || n.kind === 'file' || n.kind === 'cls' || n.god || (n.fanIn || 0) >= 4;
      return Object.assign({}, n, {
        symbolSize: sizeOf(n) + (n.id === state.focus ? 8 : 0),
        itemStyle: { color: t ? TONE[t] : colorOf(n), borderColor: n.god ? '#f43f5e' : n.id === state.focus ? '#fff' : 'transparent', borderWidth: n.god || n.id === state.focus ? 2 : 0 },
        label: { show: !!labeled, position: 'right', color: '#e8eef6', fontSize: 10, formatter: n.kind === 'file' ? n.file.split('/').slice(-2).join('/') : n.name }
      });
    });
    var ls = links.filter(function (l) { return ids[l.source] && ids[l.target]; }).map(function (l) {
      return { source: l.source, target: l.target, rel: l.rel, lineStyle: edgeStyle(l.rel), symbol: l.rel === 'call' || l.rel === 'inferred' ? ['none', 'arrow'] : ['none', 'none'], symbolSize: 7 };
    });
    chart.setOption({
      backgroundColor: '#0b1117', animation: false,
      tooltip: { confine: true, formatter: tooltip },
      series: [{
        type: 'graph', layout: 'none', data: data, links: ls, roam: true, draggable: false,
        emphasis: { focus: 'adjacency', lineStyle: { width: 2.5, opacity: 0.9 }, label: { show: true } },
        blur: { itemStyle: { opacity: 0.08 }, lineStyle: { opacity: 0.03 } },
        labelLayout: { hideOverlap: true }, scaleLimit: { min: 0.05, max: 8 }
      }]
    }, true);
  }
  function tooltip(x) {
    if (x.dataType === 'edge') return esc(({ call: '调用', inferred: '调用（同包词法推断）', import: 'import', owns: '包含' })[x.data.rel] || x.data.rel) + '<br>' + esc(short(x.data.source)) + ' → ' + esc(short(x.data.target));
    var n = x.data || {};
    if (n.kind === 'col') return esc(n.name);
    var lines = [esc(n.kind === 'file' ? n.file : n.file + '#' + n.name), esc(LAYER_LABEL[n.layer] || '')];
    if (n.kind === 'fn') lines.push('行数 ' + n.loc + ' · 扇入 ' + n.fanIn + ' · 扇出 ' + n.fanOut + ' · 近似复杂度 ' + n.cx + (n.god ? ' · 上帝方法' : ''));
    if (n.kind === 'file') { var fm = fileMetric[n.file] || {}; lines.push((fm.lines || '?') + ' 行 · ' + (fm.fns || 0) + ' 方法 · 被依赖 ' + (fm.importedBy || 0) + (fm.oversize ? ' · 超长' : '') + (fm.inCycle ? ' · 在环上' : '')); }
    return lines.join('<br>');
  }

  // 总览只画与「选中 / 展开」文件相连的边：Go 的 import 以包为单位展开到每个文件，全画是一堵墙
  function showFiles() {
    var nodes = V.nodes.filter(function (n) { return n.kind === 'file' || ((n.kind === 'fn' || n.kind === 'cls') && state.expanded[n.file]); });
    var focusFile = state.focus && nmap[state.focus] ? nmap[state.focus].file : null;
    var touch = function (id) { var n = nmap[id]; return n && (n.file === focusFile || state.expanded[n.file]); };
    var links = linksBy.import.concat(linksBy.call).filter(function (l) { return touch(l.source) || touch(l.target); });
    draw(layoutFiles(nodes), links);
  }
  function showMethods() {
    var nodes = V.nodes.filter(function (n) { return n.kind === 'fn'; });
    draw(layoutRings(nodes), linksBy.call);
  }
  function egoDepth(id, max) {
    var depth = {}; depth[id] = 0;
    [['calls', 1], ['callers', -1]].forEach(function (p) {
      var q = [id], d = 0;
      while (q.length && d < 2) {
        d++; var next = [];
        q.forEach(function (x) {
          ((V.rels[x] || {})[p[0]] || []).forEach(function (y) { if (depth[y] == null && Object.keys(depth).length < max) { depth[y] = p[1] * d; next.push(y); } });
        });
        q = next;
      }
    });
    return depth;
  }
  function showEgo(id) {
    if (!nmap[id]) return;
    state.focus = id; state.view = 'ego'; syncButtons();
    var n = nmap[id];
    var depth;
    if (n.kind === 'cls') {
      depth = {}; depth[id] = 0;
      V.links.forEach(function (l) { if (l.rel === 'owns' && l.source === id) depth[l.target] = 1; });
    } else if (n.kind === 'file') {
      depth = {}; depth[id] = 0;
      V.links.forEach(function (l) {
        if (l.rel === 'import' && l.source === id) depth[l.target] = 1;
        if (l.rel === 'import' && l.target === id) depth[l.source] = -1;
      });
    } else depth = egoDepth(id, 70);
    draw(layoutDepth(depth), V.links, { labelAll: true });
    renderSide();
  }
  function showHighlight(h) {
    state.highlight = h; state.view = 'ego'; syncButtons();
    var tone = {};
    h.groups.forEach(function (g) { g.nodes.forEach(function (id) { if (nmap[id] && !tone[id]) tone[id] = g.tone; }); });
    if (h.focus && nmap[h.focus]) state.focus = h.focus;
    var nodes;
    if (h.pos) {
      // 按关系摆：服务端给了列与行，每列垂直居中
      var colSize = {};
      Object.keys(h.pos).forEach(function (id) { var c = h.pos[id].col; colSize[c] = Math.max(colSize[c] || 0, h.pos[id].row + 1); });
      nodes = Object.keys(h.pos).filter(function (id) { return nmap[id]; }).map(function (id) {
        var p = h.pos[id];
        return Object.assign({}, nmap[id], { x: p.col * 320, y: (p.row - (colSize[p.col] - 1) / 2) * 34, fixed: true });
      });
    } else {
      var depth = {};
      Object.keys(tone).forEach(function (id) { var li = LAYERS.indexOf(nmap[id].layer); depth[id] = li < 0 ? LAYERS.length : li; });
      nodes = layoutDepth(depth);
    }
    var links = h.edges
      ? h.edges.map(function (e) { return { source: e.source, target: e.target, rel: e.inferred ? 'inferred' : 'call' }; })
      : V.links.filter(function (l) { return l.rel !== 'owns'; });
    draw(nodes, links, { tone: tone, labelAll: nodes.length < 90 });
  }
  function render() {
    if (state.view === 'files') showFiles();
    else if (state.view === 'methods') showMethods();
    else if (state.highlight && state.tab === 'sandbox') showHighlight(state.highlight);
    else if (state.focus) showEgo(state.focus);
    else showFiles();
    renderSide();
  }
  function syncButtons() {
    document.querySelectorAll('.modes button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-view') === state.view ? 'true' : 'false'); });
    document.querySelectorAll('.tabs button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-tab') === state.tab ? 'true' : 'false'); });
  }

  // ─────────────── 侧栏 ───────────────
  function listIds(ids, empty) {
    if (!ids || !ids.length) return "<p class='muted small'>" + esc(empty) + '</p>';
    return '<ul>' + ids.map(function (id) {
      var n = nmap[id], m = fnMetric[id];
      return "<li class='link' data-id='" + esc(id) + "'>" + esc(short(id)) + (m ? " <span class='muted small'>" + m.loc + '行 · 入' + m.fanIn + ' · 出' + m.fanOut + '</span>' : '') + (n ? '' : '') + '</li>';
    }).join('') + '</ul>';
  }
  function card(n, l, cls) { return "<div class='card " + (cls || '') + "'><div class='n'>" + esc(n) + "</div><div class='l'>" + esc(l) + '</div></div>'; }

  function healthSide() {
    var t = H.trust, L = H.lists;
    var html = '<h2>仓库体检 · ' + esc(H.repo) + '</h2>' +
      "<p class='muted small'>只列原始数字，不打总分。每个数字都能在图上点到对应节点。</p>" +
      "<div class='note " + (t.level === 'low' ? 'bad' : '') + "'><b>可信度 " + esc(t.level) + '</b>：' + t.reasons.map(esc).join('；') + '</div>' +
      "<div class='cards'>" +
      card(H.scale.files, '文件') + card(H.scale.functions, '方法') + card(H.scale.routes, '路由') +
      card(L.god.length, '上帝方法', L.god.length ? 'bad' : '') + card(L.oversize.length, '超 ' + H.lineLimit + ' 行文件', L.oversize.length ? 'mid' : '') +
      card(L.cycles.length, '循环依赖', L.cycles.length ? 'bad' : '') +
      card(H.audit ? H.audit.problems.length : '—', H.audit ? '红线有问题' : '无红线文件', H.audit && H.audit.problems.length ? 'bad' : '') +
      card(H.blindSpots.length, '盲区') + card(H.publicLayer.length || '—', '公共层前缀') +
      '</div>' +
      '<h3>上帝方法（≥' + H.godRule.minLoc + ' 行且扇入 ≥' + H.godRule.minFanIn + '：改不动也拆不动）</h3>' + listIds(L.god, '没有') +
      '<h3>近似复杂度 Top（体量 × 调用点，非圈复杂度）</h3>' + listIds(L.complex.slice(0, 10), '没有') +
      '<h3>扇入 Top（改它影响面最大）</h3>' + listIds(L.hottest.slice(0, 10), '没有已解析的调用') +
      '<h3>最长方法</h3>' + listIds(L.biggest.slice(0, 10), '没有') +
      '<h3>超长文件</h3>' + (L.oversize.length ? '<ul>' + L.oversize.slice(0, 20).map(function (o) { return "<li class='link' data-file='" + esc(o.file) + "'>" + esc(o.file) + " <span class='muted small'>" + o.lines + ' 行</span></li>'; }).join('') + '</ul>' : "<p class='muted small'>没有</p>") +
      '<h3>循环依赖</h3>' + (L.cycles.length ? '<ul>' + L.cycles.slice(0, 12).map(function (c, i) { return "<li class='link' data-cycle='" + i + "'>" + c.map(esc).join(' → ') + '</li>'; }).join('') + '</ul>' : "<p class='muted small'>没有</p>") +
      '<h3>路由热点（被最多入口依赖的下游方法）</h3>' + (H.hotSpots.length ? '<ul>' + H.hotSpots.map(function (s) { return '<li>' + esc(s.file + '#' + s.method) + " <span class='muted small'>" + s.routeCount + ' 个入口</span></li>'; }).join('') + '</ul>' : "<p class='muted small'>没有识别到入口与方法的关联</p>") +
      (H.audit ? '<h3>红线体检</h3>' + (H.audit.problems.length ? '<ul>' + H.audit.problems.map(function (p) { return '<li>[' + esc(p.ruleId) + '] ' + esc(p.severity) + ' · ' + esc(p.summary) + '</li>'; }).join('') + '</ul>' : "<p class='muted small'>" + H.audit.ruleCount + ' 条规则都还有效</p>') : '') +
      '<h3>盲区（图谱看不见的）</h3><ul>' + H.blindSpots.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>' +
      "<h3>图例</h3><div class='legend'>" + LAYERS.map(function (l) { return "<span><i style='background:" + LAYER_COLOR[l] + "'></i>" + LAYER_LABEL[l] + '</span>'; }).join('') + "<span><i style='border:2px solid #f43f5e'></i>上帝方法</span></div>";
    return html;
  }

  function nodeSide(id) {
    var n = nmap[id], r = V.rels[id] || { calls: [], callers: [], routes: [], fields: [] };
    if (!n) return '';
    var html = '<h2>' + esc(n.name) + "</h2><p class='muted small'>" + esc(n.file) + (n.line ? ':' + n.line : '') + (n.owner ? ' · ' + esc(n.owner) : '') + ' · ' + esc(LAYER_LABEL[n.layer] || n.kind) + (n.publicLayer ? ' · <b>公共层</b>' : '') + '</p>';
    if (n.kind === 'fn') {
      html += "<div class='chips'><span>行数 " + n.loc + '</span><span>扇入 ' + n.fanIn + '</span><span>扇出 ' + n.fanOut + '</span><span>近似复杂度 ' + n.cx + '</span>' + (n.god ? "<span class='bad'>上帝方法</span>" : '') + '</div>';
    }
    if (n.kind === 'file') {
      var fm = fileMetric[n.file] || {};
      html += "<div class='chips'><span>" + (fm.lines || '?') + ' 行</span><span>' + (fm.fns || 0) + ' 方法</span><span>被依赖 ' + (fm.importedBy || 0) + '</span><span>依赖 ' + (fm.imports || 0) + '</span>' + (fm.oversize ? "<span class='bad'>超长</span>" : '') + (fm.inCycle ? "<span class='bad'>在环上</span>" : '') + '</div>' +
        "<button type='button' id='expand'>" + (state.expanded[n.file] ? '收起方法' : '展开方法') + '</button>';
      var fns = V.nodes.filter(function (x) { return x.kind === 'fn' && x.file === n.file; }).map(function (x) { return x.id; });
      html += '<h3>方法</h3>' + listIds(fns, '无');
    }
    if (r.routes.length) html += '<h3>路由</h3><ul>' + r.routes.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    if (n.kind === 'fn') {
      html += '<h3>谁调用我（已解析）</h3>' + listIds(r.callers.slice(0, 40), '没有已解析的入边 —— 不等于没人调用，见盲区');
      html += '<h3>我调用谁（已解析）</h3>' + listIds(r.calls.slice(0, 40), '没有');
      var fam = (V.fam[n.fam] || []).filter(function (x) { return x !== id; });
      if (fam.length) html += '<h3>同族方法（' + esc(n.fam) + '）</h3>' + listIds(fam.slice(0, 20), '');
    }
    if (r.fields.length) html += '<h3>字段</h3><ul>' + r.fields.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>';
    return html;
  }

  // ─────────────── 沙盘 ───────────────
  var TOOLS = ['impact', 'similar', 'trace', 'hot', 'check', 'scan', 'audit', 'contracts', 'lib_search'];
  function defaultArgs(tool) {
    var n = nmap[state.focus] || {};
    var r = V.rels[state.focus] || {};
    if (tool === 'impact') return { file: n.file || '', symbol: n.kind === 'fn' ? n.name : '' };
    if (tool === 'similar' || tool === 'lib_search') return { intent: n.kind === 'fn' ? n.name : '' };
    if (tool === 'trace') return { urlPath: (r.routes && r.routes[0] ? r.routes[0].split(' ').slice(1).join(' ') : (V.routes[0] || {}).urlPath || '') };
    if (tool === 'check') return { files: n.file ? [n.file] : [] };
    if (tool === 'hot') return { limit: 10 };
    return {};
  }
  function cliOf(tool, a) {
    var q = function (s) { return /^[\w./#@:-]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "'\\''") + "'"; };
    if (tool === 'impact') return 'repo-guard impact ' + q(a.file + (a.symbol ? '#' + a.symbol : ''));
    if (tool === 'similar') return 'repo-guard similar ' + q(a.intent || '');
    if (tool === 'trace') return 'repo-guard trace ' + q(a.urlPath || '');
    if (tool === 'hot') return 'repo-guard hot --limit ' + (a.limit || 10);
    if (tool === 'check') return 'repo-guard check ' + (a.files || []).map(q).join(' ');
    if (tool === 'lib_search') return 'repo-guard lib search ' + q(a.intent || '');
    return 'repo-guard ' + tool;
  }
  function argsForm(tool, a) {
    if (tool === 'impact') return "<label>file</label><input id='a_file' value='" + esc(a.file) + "'><label>symbol</label><input id='a_symbol' placeholder='方法名或字段名，可空' value='" + esc(a.symbol) + "'>";
    if (tool === 'similar' || tool === 'lib_search') return "<label>intent</label><input id='a_intent' value='" + esc(a.intent) + "'>";
    if (tool === 'trace') return "<label>urlPath</label><input id='a_urlPath' list='routes' value='" + esc(a.urlPath) + "'><datalist id='routes'>" + V.routes.slice(0, 400).map(function (r) { return "<option value='" + esc(r.urlPath) + "'>" + esc(r.method) + '</option>'; }).join('') + '</datalist>';
    if (tool === 'check') return "<label>files</label><input id='a_files' placeholder='空格分隔' value='" + esc((a.files || []).join(' ')) + "'>";
    if (tool === 'hot') return "<label>limit</label><input id='a_limit' value='" + esc(a.limit) + "'>";
    return "<label></label><span class='muted small'>无参数</span>";
  }
  function readArgs(tool) {
    var v = function (id) { var e = $(id); return e ? e.value.trim() : ''; };
    if (tool === 'impact') { var o = { file: v('a_file') }; if (v('a_symbol')) o.symbol = v('a_symbol'); return o; }
    if (tool === 'similar' || tool === 'lib_search') return { intent: v('a_intent') };
    if (tool === 'trace') return { urlPath: v('a_urlPath') };
    if (tool === 'check') return { files: v('a_files').split(/\s+/).filter(Boolean) };
    if (tool === 'hot') return { limit: Number(v('a_limit')) || 10 };
    return {};
  }
  function sandboxSide() {
    var tool = state.sbTool || 'impact';
    var a = state.sbArgs && state.sbArgs.tool === tool ? state.sbArgs.args : defaultArgs(tool);
    var off = MODE !== 'serve';
    var n = nmap[state.focus];
    var html = '<h2>沙盘 · 模拟插件能力</h2>' +
      "<p class='muted small'>与 AI 经 MCP 调用走同一个 callTool，输出逐字一致；但<b>不写会话状态、不记埋点</b>，不会替 AI 放行守卫。</p>" +
      (off ? "<div class='note'>静态页不能实时调用。跑 <code>repo-guard viz --serve</code> 打开在线沙盘，或直接执行下方等价命令。</div>" : '') +
      "<p class='small'>当前节点：" + (n ? '<b>' + esc(short(n.id)) + '</b>' : "<span class='muted'>未选（在图上点一个方法 / 文件，参数会自动填好）</span>") + '</p>' +
      "<h3>1 · 调工具</h3><div class='form'><label>工具</label><select id='sbTool'>" + TOOLS.map(function (t) { return '<option' + (t === tool ? ' selected' : '') + '>' + t + '</option>'; }).join('') + '</select>' + argsForm(tool, a) + '</div>' +
      "<div class='actions'><button type='button' class='primary' id='runTool'" + (off ? ' disabled' : '') + '>调用</button></div>' +
      "<p class='muted small'>MCP：<code>mcp__repo-guard__" + esc(tool) + ' ' + esc(JSON.stringify(a)) + '</code><br>CLI：<code>' + esc(cliOf(tool, a)) + '</code></p>' +
      simPanel(n, off) +
      "<div id='sbOut'>" + (state.sbOut || '') + '</div>';
    return html;
  }
  // 模拟写入的假设状态。跨重绘保留；调工具成功后自动勾上对应项 —— 这就是 AI 的真实流程：
  // 被拦 → 去查 → 再写被放行。只存在页面内存里，不写真实会话状态
  var sw = { file: '', q: false, s: false, h: false, l: false, gate: '' };
  function simPanel(n, off) {
    if (!sw.file && n) sw.file = n.file;
    var ck = function (id, v, label) { return "<label><input type='checkbox' id='" + id + "'" + (v ? ' checked' : '') + '>' + label + '</label>'; };
    var gateOpt = function (v, label) { return "<option value='" + v + "'" + (sw.gate === v ? ' selected' : '') + '>' + label + '</option>'; };
    return "<h3>2 · 模拟 AI 改写一个文件</h3>" +
      "<div class='form'><label>file</label><input id='sw_file' value='" + esc(sw.file) + "' placeholder='仓库相对路径，可填不存在的新文件'>" +
      "<label>假设开门</label><select id='sw_gate'>" + gateOpt('', '不假设（按本仓真实配置）') + gateOpt('similar', '这个目录：新建前先查 similar') + gateOpt('hot', '这个目录：新建前先查 hot') + gateOpt('lib_search', '这个目录：新建前先查 lib_search') + '</select></div>' +
      "<p class='muted small'>本轮 AI 已经查过（假设）：</p>" +
      "<div class='checks'>" + ck('sw_q', sw.q, 'impact') + ck('sw_s', sw.s, 'similar') + ck('sw_h', sw.h, 'hot') + ck('sw_l', sw.l, 'lib_search') + '</div>' +
      "<p class='muted small'>在上面「调工具」成功调用后会自动勾上对应项。impact 只管改<b>已存在</b>的公共层文件；similar / hot / lib_search 只管<b>新建</b>文件，且这几道门默认关，要选「假设开门」才看得到效果。</p>" +
      "<div class='actions'><button type='button' id='runSim'" + (off ? ' disabled' : '') + ">判定这次写入</button><button type='button' id='resetSim'>清空假设</button></div>" +
      "<details class='small muted'><summary>演示：新建接口前必须先查 similar</summary><ol>" +
      '<li>file 填一个不存在的新文件，如 <code>service/admin/new_api.go</code></li>' +
      '<li>假设开门选「新建前先查 similar」，点判定 → <b>拦截</b>，并显示 AI 会收到的拒绝文案</li>' +
      '<li>在「调工具」里选 similar，intent 填 <code>AIMCredential</code>，点调用 → 自动勾上 similar</li>' +
      '<li>再点判定 → <b>放行</b></li></ol></details>';
  }
  function readSim() {
    var v = function (id) { var e = $(id); return e ? e : null; };
    if (v('sw_file')) sw.file = v('sw_file').value.trim();
    if (v('sw_gate')) sw.gate = v('sw_gate').value;
    ['q', 's', 'h', 'l'].forEach(function (k) { var e = v('sw_' + k); if (e) sw[k] = e.checked; });
  }
  var AUTO_TICK = { impact: 'q', similar: 's', hot: 'h', lib_search: 'l' };
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; });
    });
  }
  function highlightHtml(h) {
    if (!h || !h.groups.length) return "<p class='muted small'>这个工具没有可落到图上的结构化结果，看下面的原文。</p>";
    var total = h.groups.reduce(function (n, g) { return n + g.nodes.length; }, 0);
    return (h.reading ? "<p class='small'><b>怎么读：</b>" + esc(h.reading) + '</p>' : '') +
      "<ul class='groups'>" + h.groups.map(function (g, i) {
        return "<li class='link' data-group='" + i + "'><span class='tone' style='background:" + TONE[g.tone] + "'></span><b>" + esc(g.label) + '</b> · ' + g.nodes.length +
          "<div class='muted small'>" + esc(g.desc || '') + '</div></li>';
      }).join('') + '</ul>' +
      "<p class='muted small'>各组互斥，图上共 " + total + " 个点。点某一组只看这一组；点「全部」恢复。<span class='link' id='allGroups'>全部</span></p>" +
      (h.notes && h.notes.length ? "<div class='note'>" + h.notes.map(esc).join('<br>') + '</div>' : '');
  }
  function runTool() {
    var tool = state.sbTool || 'impact', args = readArgs(tool);
    readSim();
    state.sbArgs = { tool: tool, args: args };
    state.sbOut = "<p class='muted'>调用中…</p>"; renderSide();
    post('/api/tool', { name: tool, args: args }).then(function (r) {
      state.lastTool = r;
      var tick = AUTO_TICK[tool];
      // impact 按文件记：只有查的正是模拟写入的那个文件才算查过（与守卫口径一致）
      if (tick && (tool !== 'impact' || !sw.file || (args.file || '').split('#')[0] === sw.file)) {
        if (tool === 'impact' && !sw.file) sw.file = (args.file || '').split('#')[0];
        sw[tick] = true;
      }
      state.sbOut = (tick ? "<p class='muted small'>已在「模拟改写」里勾上「" + tool + "」（沙盘假设，未写入真实会话）。</p>" : '') +
        '<h3>图上高亮</h3>' + highlightHtml(r.highlight) + '<h3>AI 看到的原文</h3><pre></pre>';
      renderSide();
      side.querySelector('#sbOut pre').textContent = r.text;
      if (r.highlight && r.highlight.groups.length) showHighlight(r.highlight);
    }).catch(function (e) { state.sbOut = "<div class='note bad'>" + esc(e.message) + '</div>'; renderSide(); });
  }
  function runSim() {
    readSim();
    var body = { file: sw.file, queried: sw.q, similarSearched: sw.s, hotQueried: sw.h, libSearched: sw.l, assumeGate: sw.gate || null };
    post('/api/simulate-write', body).then(function (r) {
      state.sbOut = "<h3>判定</h3><p class='verdict " + r.verdict + "'>" + (r.verdict === 'deny' ? '拦截' : '放行') + ' · ' + esc(r.rel || body.file) + (r.exists ? '' : '（新建）') + '</p>' +
        '<ul>' + r.steps.map(function (s) { return '<li>' + esc(s.gate) + ' — ' + esc(s.verdict) + (s.note ? ' · ' + esc(s.note) : '') + '</li>'; }).join('') + '</ul>' +
        (r.redlines.length ? '<h3>路径命中的红线</h3><ul>' + r.redlines.map(function (x) { return '<li>' + esc(x.id) + '：' + esc(x.rule) + '</li>'; }).join('') + '</ul>' : '') +
        (r.reason ? '<h3>AI 会收到的拒绝文案（与真实 PreToolUse 一致）</h3><pre></pre>' : '') +
        "<p class='muted small'>未模拟：" + r.notSimulated.map(esc).join('；') + '</p>';
      renderSide();
      if (r.reason) side.querySelector('#sbOut pre').textContent = r.reason;
      if (r.rel && nmap['file:' + r.rel]) showHighlight({ focus: 'file:' + r.rel, groups: [{ label: '写入目标', tone: r.verdict === 'deny' ? 'entry' : 'target', desc: '', nodes: ['file:' + r.rel] }] });
    }).catch(function (e) { state.sbOut = "<div class='note bad'>" + esc(e.message) + '</div>'; renderSide(); });
  }

  function replaySide() {
    return '<h2>回放 · 下期</h2><p class="muted">把一次真实开发会话（CodeBuddy 会话记录 + 守卫埋点 + 会话状态）按时间轴叠到这张图上：AI 查了哪些节点、被拦在哪、最后改了哪些方法。</p>' +
      '<p class="muted small">本期先用「沙盘」演示能力，用「体检」看仓库现状。</p>';
  }

  function renderSide() {
    var html;
    if (state.tab === 'sandbox') html = sandboxSide() + (state.focus ? '<hr style="border-color:#243140">' + nodeSide(state.focus) : '');
    else if (state.tab === 'replay') html = replaySide();
    else html = state.focus && nmap[state.focus] ? nodeSide(state.focus) + "<button type='button' id='back'>回到体检总览</button>" : healthSide();
    side.innerHTML = html;
    bindSide();
  }
  function bindSide() {
    side.querySelectorAll('li[data-id]').forEach(function (li) { li.onclick = function () { state.highlight = null; showEgo(li.getAttribute('data-id')); }; });
    side.querySelectorAll('li[data-file]').forEach(function (li) { li.onclick = function () { var f = li.getAttribute('data-file'); state.expanded[f] = true; state.focus = 'file:' + f; state.view = 'files'; syncButtons(); render(); }; });
    side.querySelectorAll('li[data-cycle]').forEach(function (li) {
      li.onclick = function () {
        var c = H.lists.cycles[Number(li.getAttribute('data-cycle'))] || [];
        var depth = {}; c.slice(0, -1).forEach(function (f, i) { depth['file:' + f] = i; });
        state.view = 'ego'; syncButtons();
        var tone = {}; Object.keys(depth).forEach(function (k) { tone[k] = 'entry'; });
        draw(layoutDepth(depth), linksBy.import, { tone: tone, labelAll: true });
      };
    });
    side.querySelectorAll('li[data-group]').forEach(function (li) {
      li.onclick = function () {
        var h = state.lastTool.highlight, g = h.groups[Number(li.getAttribute('data-group'))];
        var keep = {}; g.nodes.forEach(function (id) { keep[id] = 1; });
        if (h.focus) keep[h.focus] = 1;
        var pos = null;
        if (h.pos) { pos = {}; Object.keys(h.pos).forEach(function (id) { if (keep[id]) pos[id] = h.pos[id]; }); }
        var tg = h.groups.filter(function (x) { return x.tone === 'target'; })[0];
        showHighlight({ focus: h.focus, groups: tg && tg !== g ? [tg, g] : [g], pos: pos,
          edges: h.edges ? h.edges.filter(function (e) { return keep[e.source] && keep[e.target]; }) : undefined });
      };
    });
    if ((b = $('allGroups'))) b.onclick = function () { showHighlight(state.lastTool.highlight); };
    var b;
    if ((b = $('back'))) b.onclick = function () { state.focus = null; state.view = 'files'; syncButtons(); render(); };
    if ((b = $('expand'))) b.onclick = function () { var f = nmap[state.focus].file; state.expanded[f] = !state.expanded[f]; state.view = 'files'; syncButtons(); render(); };
    if ((b = $('sbTool'))) b.onchange = function (e) { readSim(); state.sbTool = e.target.value; state.sbArgs = null; renderSide(); };
    if ((b = $('runTool'))) b.onclick = runTool;
    if ((b = $('runSim'))) b.onclick = runSim;
    if ((b = $('resetSim'))) b.onclick = function () { sw = { file: '', q: false, s: false, h: false, l: false, gate: '' }; state.sbOut = ''; renderSide(); };
    ['sw_file', 'sw_gate', 'sw_q', 'sw_s', 'sw_h', 'sw_l'].forEach(function (id) { var e = $(id); if (e) e.onchange = readSim; });
  }

  // ─────────────── 检索 ───────────────
  function jump(q) {
    var s = String(q || '').toLowerCase().trim();
    if (!s) return;
    var hit = V.nodes.find(function (n) { return n.kind === 'fn' && n.name.toLowerCase() === s; }) ||
      V.nodes.find(function (n) { return (n.name || '').toLowerCase() === s; }) ||
      V.nodes.find(function (n) { return ((n.file || '') + '#' + (n.name || '')).toLowerCase().indexOf(s) >= 0; });
    if (!hit) { side.innerHTML = "<h2>未命中</h2><p class='muted'>没有 " + esc(q) + ' 这个节点。空结果不等于不存在：它可能在盲区里。</p>'; return; }
    state.highlight = null;
    if (hit.kind === 'file') { state.expanded[hit.file] = true; state.focus = hit.id; state.view = 'files'; syncButtons(); render(); }
    else showEgo(hit.id);
  }
  function searchField(q) {
    var s = q.toLowerCase().trim();
    if (!s) return;
    var hits = V.fields.filter(function (f) { return f.key.toLowerCase().indexOf(s) >= 0 || f.name.toLowerCase() === s; });
    if (!hits.length) { side.innerHTML = "<h2>字段未命中</h2><p class='muted'>" + esc(q) + ' 不在本仓结构体字段里（分析器只采 Go struct 等带 tag 的成员）。</p>'; return; }
    if (MODE === 'serve' && hits.length) {
      state.tab = 'sandbox'; state.sbTool = 'impact'; state.focus = 'cls:' + hits[0].file + '#' + hits[0].struct;
      state.sbArgs = { tool: 'impact', args: { file: hits[0].file, symbol: hits[0].name } };
      syncButtons(); renderSide(); runTool(); return;
    }
    var cls = 'cls:' + hits[0].file + '#' + hits[0].struct;
    if (nmap[cls]) showEgo(cls);
    side.insertAdjacentHTML('afterbegin', "<div class='note'>字段命中 " + hits.length + '：' + hits.slice(0, 8).map(function (h) { return esc(h.key + ' @' + h.file); }).join(' · ') +
      '<br>字段级影响面要在沙盘里查：<code>' + esc('repo-guard impact ' + hits[0].file + '#' + hits[0].name) + '</code></div>');
  }
  function searchSimilar(q) {
    var s = q.trim();
    if (!s) return;
    if (MODE === 'serve') {
      state.tab = 'sandbox'; state.sbTool = 'similar'; state.sbArgs = { tool: 'similar', args: { intent: s } };
      syncButtons(); renderSide(); runTool(); return;
    }
    // 静态页：用内联的家族索引做同样的归族（去动词前缀 + 小写 + 去复数 s）
    var m = s.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [], id = m.sort(function (a, b) { return b.length - a.length; })[0] || '';
    var verbs = ['Describe', 'Create', 'Modify', 'Delete', 'Update', 'Remove', 'Get', 'List', 'Query', 'Enable', 'Disable', 'Bind', 'Unbind', 'Search', 'Handle', 'Check', 'Sync', 'Refresh', 'Download', 'Upload', 'Open', 'Register', 'Validate', 'Report', 'Add', 'Set', 'Batch'];
    var fam = id;
    verbs.some(function (v) { if (id.indexOf(v) === 0 && id.length > v.length && /[A-Z]/.test(id[v.length])) { fam = id.slice(v.length); return true; } return false; });
    var key = fam.toLowerCase(); if (key.length > 3 && key.slice(-1) === 's') key = key.slice(0, -1);
    var ids = V.fam[key] || [];
    if (!ids.length) Object.keys(V.fam).forEach(function (k) { if (k.indexOf(key) >= 0) ids = ids.concat(V.fam[k]); });
    if (!ids.length) { side.innerHTML = "<h2>同类未命中</h2><p class='muted'>没有 " + esc(s) + ' 家族。这是按命名的骨架检索，不是语义搜索。</p>'; return; }
    showHighlight({ focus: ids[0], groups: [{ label: '同族方法', tone: 'ref', nodes: ids }] });
    side.innerHTML = '<h2>同类 · ' + esc(fam) + "</h2><p class='muted small'>" + ids.length + ' 个方法（骨架检索）。家族缺口与分层骨架请在沙盘里查：<code>' + esc('repo-guard similar ' + s) + '</code></p>' + listIds(ids.slice(0, 60), '');
    bindSide();
  }

  // ─────────────── 事件 ───────────────
  chart.on('click', function (x) {
    if (x.dataType !== 'node') return;
    var n = x.data;
    if (n.kind === 'col' || n.kind === 'svc') return;
    state.highlight = null;
    if (n.kind === 'file' && state.view === 'files') { state.expanded[n.file] = !state.expanded[n.file]; state.focus = n.id; state.sbArgs = null; showFiles(); renderSide(); return; }
    state.sbArgs = null;
    showEgo(n.id);
  });
  document.querySelectorAll('.modes button').forEach(function (b) {
    b.onclick = function () { state.view = b.getAttribute('data-view'); if (state.view !== 'ego') state.highlight = null; syncButtons(); render(); };
  });
  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.onclick = function () { state.tab = b.getAttribute('data-tab'); syncButtons(); renderSide(); };
  });
  $('colorBy').onchange = function (e) { state.colorBy = e.target.value; render(); };
  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') jump(e.target.value); });
  $('field').addEventListener('keydown', function (e) { if (e.key === 'Enter') searchField(e.target.value); });
  $('similar').addEventListener('keydown', function (e) { if (e.key === 'Enter') searchSimilar(e.target.value); });
  window.addEventListener('resize', function () { chart.resize(); });

  if (MODE === 'serve') {
    fetch('/api/view').then(function (r) { return r.json(); }).then(load).catch(function (e) { side.textContent = '加载失败：' + e.message; });
  } else if (window.RG_DATA) {
    load(window.RG_DATA);
  } else {
    side.textContent = '没有数据。用 repo-guard viz 生成本页。';
  }
})();
