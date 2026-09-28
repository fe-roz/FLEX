#!/usr/bin/env python3
"""
Build the APK asset tree from a FLEX portable export.

The export ships two forms of the same data: a single ~170 MB viewer.html with
everything inlined as base64 (for opening in a desktop browser with no server),
and the same assets as plain sidecar files. The app wants the sidecars -- a
WebView has to parse the entire document before it can draw anything, and base64
costs ~33% on top of already-compressed JPEG and GLB.

Exports made before the sidecars existed are still supported: the textures are
decoded back out of viewer.html, which is slow but correct.

The HTML shell is always rebuilt from the current viewer_build/viewer.html
template rather than taken from the export, so an old export picks up viewer
fixes without being re-exported.

Usage:
    python3 assemble_assets.py <export_dir> <flex_dir> <out_assets_dir> [--name "Cave Ridge"]

--name is only needed for exports made before the map-name field existed.
"""
import argparse, base64, io, json, os, re, shutil, sys

def human(n):
    for u in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or u == 'GB':
            return '%.1f %s' % (n, u)
        n /= 1024.0

def slugify(s):
    # Android package segments must start with a letter and hold only letters,
    # digits and underscores. Lowercase throughout by convention.
    s = re.sub(r'[^a-z0-9]+', '', (s or '').lower())
    if not s or not s[0].isalpha():
        s = 'c' + s
    return s or 'cave'

def label_safe(s):
    """A cave name that survives the trip to the launcher label.

    The name goes cave.properties -> Gradle resValue -> an Android string
    resource. A straight apostrophe ("Soldier's Cave") is a hard AAPT error
    there, '&' and '<' break the generated XML, and a leading '@' or '?' is
    read as a reference. Swap them for look-alikes that need no escaping, so
    the build never depends on how the plugin escapes.
    """
    s = (s or '').replace("'", '\u2019').replace('"', '\u201d').replace('&', ' and ')
    s = re.sub(r'[<>\\]', '', s)
    s = re.sub(r'\s+', ' ', s).strip().lstrip('@?')
    return s

def props_value(s):
    """Escape for a .properties value: Properties.load() reads ISO-8859-1, so
    anything past ASCII goes as \\uXXXX."""
    return ''.join(ch if 32 <= ord(ch) < 127 else '\\u%04x' % ord(ch) for ch in s)

def extract_const(html, name):
    """Pull the quoted value of `const <name> = "...";` without regexing 170 MB."""
    m = re.search(r'(?:const|let|var)\s+%s\s*=\s*"' % re.escape(name), html)
    if not m:
        return None
    start = m.end()
    return html[start:html.index('"', start)]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('export_dir')
    ap.add_argument('flex_dir')
    ap.add_argument('out_dir')
    ap.add_argument('--name', default=None,
                    help='Cave name for the app label; defaults to the map name typed '
                         'in FLEX before exporting, then to the export folder name')
    a = ap.parse_args()
    export_dir, flex_dir, out_dir = a.export_dir, a.flex_dir, a.out_dir

    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(os.path.join(out_dir, 'libs'), exist_ok=True)

    # ── textures: sidecars if the export has them, else dig them out ─────────
    need_html_scan = []
    for const, out_name in (('TERRAIN_TEX_B64', 'tex_sat.jpg'),
                            ('TERRAIN_HS_B64',  'tex_hs.jpg')):
        src = os.path.join(export_dir, out_name)
        if os.path.exists(src):
            shutil.copyfile(src, os.path.join(out_dir, out_name))
            print('  sidecar %-14s %s' % (out_name, human(os.path.getsize(src))))
        else:
            need_html_scan.append((const, out_name))

    if need_html_scan:
        src_html = os.path.join(export_dir, 'viewer.html')
        print('  no sidecar for %s; decoding from %s (%s)'
              % (', '.join(n for _, n in need_html_scan), 'viewer.html',
                 human(os.path.getsize(src_html))))
        html = io.open(src_html, encoding='utf-8', errors='replace').read()
        for const, out_name in need_html_scan:
            b64 = extract_const(html, const)
            if not b64 or b64.startswith('PLACEHOLDER'):
                print('    %-16s absent - skipping %s' % (const, out_name))
                continue
            raw = base64.b64decode(b64)
            io.open(os.path.join(out_dir, out_name), 'wb').write(raw)
            print('    %-16s %s base64 -> %s %s'
                  % (const, human(len(b64)), out_name, human(len(raw))))
            del b64, raw
        del html

    # ── geometry + survey data ───────────────────────────────────────────────
    for name in ('terrain.glb', 'caves.json'):
        shutil.copyfile(os.path.join(export_dir, name), os.path.join(out_dir, name))
        print('  copied %-14s %s' % (name, human(os.path.getsize(os.path.join(out_dir, name)))))

    # ── three.js and friends: prefer the export's own copy ──────────────────
    libs_src = os.path.join(export_dir, 'libs')
    if not os.path.isdir(libs_src):
        libs_src = os.path.join(flex_dir, 'viewer_build', 'libs')
    for lib in sorted(os.listdir(libs_src)):
        if lib.endswith('.js'):
            shutil.copyfile(os.path.join(libs_src, lib), os.path.join(out_dir, 'libs', lib))
    print('  copied libs/    %d files from %s' %
          (len([l for l in os.listdir(libs_src) if l.endswith('.js')]), libs_src))

    # ── the shell, always from the current template ─────────────────────────
    tpl = io.open(os.path.join(flex_dir, 'viewer_build', 'viewer.html'),
                  encoding='utf-8').read()
    caves_json = io.open(os.path.join(export_dir, 'caves.json'), encoding='utf-8').read()
    json.loads(caves_json)   # fail here, not silently in the browser
    # Inside a <script>, "</" in any name would end the block early.
    caves_json = caves_json.replace('</', '<\\/')

    has_hs = os.path.exists(os.path.join(out_dir, 'tex_hs.jpg'))
    for old, new in [('"PLACEHOLDER_GLB_B64"', '"terrain.glb"'),
                     ('"PLACEHOLDER_TEX_B64"', '"tex_sat.jpg"'),
                     ('"PLACEHOLDER_HS_B64"',  '"tex_hs.jpg"' if has_hs else '"PLACEHOLDER_HS_B64"'),
                     ('PLACEHOLDER_CAVES_JSON', caves_json)]:
        if old not in tpl:
            print('  WARNING: %s not found in template' % old)
        tpl = tpl.replace(old, new)
    out_html = os.path.join(out_dir, 'viewer.html')
    io.open(out_html, 'w', encoding='utf-8').write(tpl)
    print('  wrote viewer.html %s' % human(os.path.getsize(out_html)))

    # ── cave identity for the Gradle build ──────────────────────────────────
    # The map name typed in FLEX's export panel travels in caves.json.
    meta_name = ((json.loads(caves_json).get('meta') or {}).get('name') or '').strip()
    name = a.name or meta_name or os.path.basename(os.path.normpath(export_dir))
    name = re.sub(r'^FLEX[- ]?Portable[- ]?Viewer[- ]?', '', name, flags=re.I)
    name = re.sub(r'[-_]+', ' ', name).strip() or 'Cave'
    name = label_safe(name) or 'Cave'
    props = os.path.join(flex_dir, 'android', 'cave.properties')
    io.open(props, 'w', encoding='utf-8').write(
        '# Written by tools/assemble_assets.py; read by app/build.gradle.kts.\n'
        '# Identity is per cave so several exports can be installed side by side\n'
        '# instead of overwriting one another.\n'
        'cave.name=%s\ncave.id=%s\n' % (props_value(name), slugify(name)))
    print('  cave.properties  name=%s  id=%s' % (name, slugify(name)))

    total = sum(os.path.getsize(os.path.join(dp, f))
                for dp, _, fs in os.walk(out_dir) for f in fs)
    print('\nAsset tree total: %s' % human(total))

if __name__ == '__main__':
    main()
