# -*- coding: utf-8 -*-
from pathlib import Path
import json, html, re

ROOT = Path('/Users/gaoxin/Documents/AI/repo-guard')
refs = json.loads(Path('/tmp/refs2.json').read_text())
land = json.loads(Path('/tmp/land.json').read_text())
css = Path('/tmp/ce.css').read_text()
BT = chr(96)

def esc(s):
    s = html.escape(s or '')
    return re.sub(BT + r'([^' + BT + r']+)' + BT, lambda m: '<code>%s</code>' % m.group(1), s)

def beats(color, a, b, d):
    return (
        '<h3>示例</h3><div class="beats">'
        '<div class="beat"><div class="n" style="color:%s">1 · 发生了什么</div><p>%s</p></div>'
        '<div class="beat"><div class="n" style="color:%s">2 · 这一层怎么卡</div><p>%s</p></div>'
        '<div class="beat"><div class="n" style="color:%s">3 · 谁拍板</div><p>%s</p></div></div>'
    ) % (color, a, color, b, color, d)

def tag(kind, text):
    return '<span class="tag %s">%s</span>' % (kind, esc(text))

def page(pid, kicker, title, body):
    return '<article class="page" id="p-%s"><div class="kicker">%s</div><h2>%s</h2>%s</article>' % (
        pid, esc(kicker), esc(title), body)

def mi_html(items):
    out = []
    for it in items:
        out.append('<div class="mi"><div class="t">%s</div>%s</div>' % (
            esc(it['t']), ('<div class="v">违反：%s</div>' % esc(it['v'])) if it.get('v') else ''))
    return ''.join(out)

def skill_page(key):
    r = refs[key]
    L = land[key]
    title = r['title']
    cards = ''.join('<div class="card"><div class="n">%s</div><p>%s</p></div>' % (esc(c['n']), esc(c['d'])) for c in r['concepts'])
    secs = []
    for s in r['sections']:
        secs.append('<div class="sec">%s</div>%s' % (esc(s['h']), mi_html(s['must'])))
    div = ('<p class="sub">%s</p>' % esc(r['div'])) if r.get('div') else ''
    cover = esc(r.get('cover') or '')
    body = (
        '<p class="sub">覆盖：%s</p>%s'
        '<h3>核心概念</h3><div class="cards">%s</div>'
        '<h3>规范是什么（必须）</h3><div class="panel">%s</div>'
        '<h3>在本工程怎么落地</h3><div class="panel"><p class="sub" style="margin:0">%s</p></div>'
        '<h3>怎么配置</h3><div class="panel"><p class="sub" style="margin:0">%s</p></div>'
        '<h3>是否人审</h3><p class="sub">技能本身不弹窗。能拦的已写在落点里（红线 / 过程 / 合并 / 人决策）。</p>'
        '%s'
        '<p class="doc">原文：references/%s</p>'
    ) % (cover, div, cards, ''.join(secs), esc(L['落点']), esc(L['配置']),
         beats('var(--skill)', esc(L['例1']), esc(L['例2']), esc(L['例3'])), r['file'])
    short = title.split(' ', 1)[-1]
    return page('sk'+key, '技能库 · '+key, short, body)

print('load ok', len(refs), len(land))
