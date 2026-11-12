#!/usr/bin/env python3
"""Rebuild src/lib/quarto-themes/*.css: Quarto's reveal.js themes compiled
from quarto-cli's Sass sources (MIT, Posit Software, PBC) the way Quarto
layers them (functions, theme defaults, Quarto defaults, reveal.js mixins,
reveal.js theme template, Quarto rules, theme rules).

Needs network access and npx (for dart-sass). Run from the repository root:
    python3 scripts/build-quarto-themes.py [git-ref]
Web-font @imports are dropped; the app bundles those fonts (slide-fonts.ts).
"""
import os, re, subprocess, sys, tempfile, urllib.request

REF = sys.argv[1] if len(sys.argv) > 1 else 'main'
BASE = f'https://raw.githubusercontent.com/quarto-dev/quarto-cli/{REF}/src/resources/formats/revealjs/'
THEMES = ['beige', 'blood', 'dark', 'default', 'dracula', 'league', 'moon', 'night', 'serif', 'simple', 'sky', 'solarized']
REVEAL_SCSS = os.path.abspath('node_modules/reveal.js/css/theme')
OUT = os.path.abspath('src/lib/quarto-themes')
HEAD = '''@use "sass:color" as quarto-color;
@use "sass:math" as quarto-math;
@use "sass:map" as quarto-map;
@function str-replace($string, $search, $replace: "") { $index: str-index($string, $search); @if $index { @return str-slice($string, 1, $index - 1) + $replace + str-replace(str-slice($string, $index + str-length($search)), $search, $replace); } @return $string; }
'''

def fetch(path):
    with urllib.request.urlopen(BASE + path) as r:
        return r.read().decode()

def sections(text):
    parts = {}
    for m in re.finditer(r'/\*-- scss:(\w+) --\*/', text):
        rest = text[m.end():]
        nxt = re.search(r'/\*-- scss:\w+ --\*/', rest)
        parts[m.group(1)] = parts.get(m.group(1), '') + (rest[:nxt.start()] if nxt else rest)
    return parts

strip = lambda t: re.sub(r'@import url\([^)]*\);', '', t)
q = sections(fetch('quarto.scss'))
os.makedirs(OUT, exist_ok=True)
with tempfile.TemporaryDirectory() as tmp:
    for name in THEMES:
        t = sections(fetch(f'themes/{name}.scss'))
        src = '\n'.join([HEAD, q.get('uses', ''), t.get('uses', ''), q.get('functions', ''), t.get('functions', ''),
                         strip(t.get('defaults', '')), strip(q.get('defaults', '')),
                         '@import "template/mixins";', q.get('mixins', ''), t.get('mixins', ''),
                         '@import "template/theme";', q.get('rules', ''), t.get('rules', '')])
        scss, css = os.path.join(tmp, name + '.scss'), os.path.join(tmp, name + '.css')
        open(scss, 'w').write(src)
        subprocess.run(['npx', '-y', 'sass@1.83.0', '--no-source-map', '--style=compressed', '--quiet',
                        f'--load-path={REVEAL_SCSS}', scss, css], check=True)
        header = (f'/* Quarto reveal.js theme "{name}", compiled from quarto-cli (MIT, Copyright (c) Posit Software, PBC)\n'
                  '   and reveal.js (MIT, Copyright (c) Hakim El Hattab) by scripts/build-quarto-themes.py. Do not edit. */\n')
        open(os.path.join(OUT, name + '.css'), 'w').write(header + open(css).read())
        print('built', name)
