"""
viewer_inline.py -- assemble the portable viewer's single-file HTML.

Standard library only, so tools/rebuild_viewer.py can re-make an export's
viewer.html with the current template on any Python, without the exporter's
numpy/scipy/PDAL stack. export_terrain.py imports it from here.
"""
import json
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
VIEWER_BUILD_DIR = SCRIPT_DIR / 'viewer_build'


def local_viewer_libs():
    """The vendored three.js libs in viewer_build/libs, keyed as the template
    names them ('libs/three.min.js' ...)."""
    d = VIEWER_BUILD_DIR / 'libs'
    return {'libs/' + p.name: p for p in sorted(d.glob('*.js'))} if d.exists() else {}


# ── Documents in an export ────────────────────────────────────────────────────
# The project's documents (scanned notes, photos...) that belong to the exported
# caves travel as: docs.json (the log entries, which pages exist, cave names)
# and one file per page image, docs_<sha256>.<ext>, flat in the zip root (the
# app's importer keeps only known basenames, see MapStore.isDataFile). The
# single-file viewer.html carries the same docs.json inline, plus the page
# images themselves as base64 while they fit in DOCS_INLINE_CAP; pages past the
# cap are read from their files beside viewer.html (an <img> loads those from
# file:// too, so serve.bat is not needed for them).
DOCS_INLINE_CAP = 12 * 1024 * 1024        # bytes of page images inlined in viewer.html
DOCS_TOTAL_CAP = 400 * 1024 * 1024        # bytes of page images in one export
DOCS_IMAGE_EXT = ('jpg', 'jpeg', 'png', 'webp')


def docs_page_file(h, ext):
    return f'docs_{h}.{ext}'


def load_docs(path, progress=print):
    """Read the job's docs input (written by export_docs.js): {project, caves,
    entries, pages: [{h, ext, path}]}. Returns (sidecar dict, [(zip name, Path)])
    with only pages whose file exists and fits DOCS_TOTAL_CAP."""
    raw = json.loads(Path(path).read_text(encoding='utf-8'))
    pages, files, total, seen = [], [], 0, set()
    for pg in raw.get('pages') or []:
        h, ext, fp = str(pg.get('h') or ''), str(pg.get('ext') or ''), pg.get('path')
        if len(h) != 64 or ext not in DOCS_IMAGE_EXT or not fp or (h, ext) in seen:
            continue
        f = Path(fp)
        if not f.is_file():
            continue
        size = f.stat().st_size
        if total + size > DOCS_TOTAL_CAP:
            progress(f"  Documents: page limit reached ({DOCS_TOTAL_CAP // 1048576} MB), some pages left out")
            break
        total += size
        seen.add((h, ext))
        pages.append({'h': h, 'ext': ext, 'size': size})
        files.append((docs_page_file(h, ext), f))
    side = {'format': 1, 'project': raw.get('project') or None, 'caves': raw.get('caves') or [],
            'entries': raw.get('entries') or [], 'pages': pages}
    # What a viewer that does not replay the entries can use: the document groups and, per document, its group and tagged pages.
    for k in ('groups', 'summary'):
        if raw.get(k):
            side[k] = raw[k]
    return side, files


def docs_inline_json(side, read_page, cap=DOCS_INLINE_CAP):
    """The text for PLACEHOLDER_DOCS_JSON: docs.json plus `inline` {sha: base64}
    for as many pages as fit under `cap` (smallest first). read_page(name) -> bytes.
    None when there is nothing to carry."""
    import base64
    if not side or not (side.get('entries') or side.get('pages')):     # (pages alone: inventory photos)
        return None
    out = dict(side)
    inline, used = {}, 0
    for pg in sorted(side.get('pages') or [], key=lambda p: p.get('size', 0)):
        if used + pg.get('size', 0) > cap:
            continue
        try:
            data = read_page(docs_page_file(pg['h'], pg['ext']))
        except Exception:
            continue
        used += len(data)
        inline[pg['h'] + '.' + pg['ext']] = base64.b64encode(data).decode('ascii')
    if inline:
        out['inline'] = inline
    return json.dumps(out, separators=(',', ':')).replace('</', '<\\/')


# ── Surface features in an export ─────────────────────────────────────────────
# The open project's points, lines and areas that fall inside the export area
# (the Export dialog gathers them; view only on the phone). features.json:
#   { version: 1, folders: [{ id, name, parent }],
#     items: [{ id, kind: point|line|area, name, folder, colour, symbol, width, opacity, label?, note?,
#               lonlat: [[lon, lat], ...] }] }
# Drawn by viewer_build/libs/viewer-features.js from PLACEHOLDER_FEATURES_JSON.
FEATURE_KINDS = {'point': 1, 'line': 2, 'area': 3}            # kind: the fewest positions it needs
FEATURE_SYMBOLS = ('dot', 'square', 'triangle', 'diamond', 'star', 'cross')   # folder-style.js SYMBOLS
FEATURE_COLOUR = '#ffb020'                                    # project-features.js ROOT_COLOR
FEATURES_MAX_ITEMS, FEATURES_MAX_POSITIONS = 20000, 400000


def clean_features(raw):
    """features.json from what the dialog sent: only the known fields, every
    value checked, folders that nothing uses left out. None: nothing to carry."""
    import math, re
    if not isinstance(raw, dict) or not isinstance(raw.get('items'), list):
        return None
    txt = lambda v, n: re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', ' ', str(v if v is not None else ''))[:n]
    num = lambda v, lo, hi, d: min(hi, max(lo, float(v))) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else d
    folders = {}
    for g in raw.get('folders') or []:
        if isinstance(g, dict) and g.get('id'):
            folders[txt(g['id'], 64)] = {'id': txt(g['id'], 64), 'name': txt(g.get('name'), 80).strip() or 'Folder', 'parent': txt(g.get('parent'), 64)}
    items, used, npos = [], set(), 0
    for k, it in enumerate(raw['items'][:FEATURES_MAX_ITEMS]):
        if not isinstance(it, dict) or it.get('kind') not in FEATURE_KINDS:
            continue
        ll = [[round(float(c[0]), 7), round(float(c[1]), 7)] for c in (it.get('lonlat') or [])
              if isinstance(c, (list, tuple)) and len(c) >= 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in c[:2])
              and abs(c[0]) <= 180 and abs(c[1]) <= 90]
        if it['kind'] == 'point':
            ll = ll[:1]
        if len(ll) < FEATURE_KINDS[it['kind']] or npos + len(ll) > FEATURES_MAX_POSITIONS:
            continue
        npos += len(ll)
        folder = txt(it.get('folder'), 64)
        if folder not in folders:
            folder = ''
        col = str(it.get('colour') or '')
        o = {'id': txt(it.get('id'), 64) or f'f{k}', 'kind': it['kind'], 'name': txt(it.get('name'), 120).strip(), 'folder': folder,
             'colour': col.lower() if re.fullmatch(r'#[0-9a-fA-F]{6}', col) else FEATURE_COLOUR,
             'symbol': it.get('symbol') if it.get('symbol') in FEATURE_SYMBOLS else 'dot',
             'width': num(it.get('width'), 1, 10, 2), 'opacity': num(it.get('opacity'), 0.1, 1, 1)}
        if it.get('label') is False:
            o['label'] = False
        note = txt(it.get('note'), 4000).strip()
        if note:
            o['note'] = note
        o['lonlat'] = ll
        items.append(o)
        while folder and folder not in used:                  # the folder and the ones it sits in
            used.add(folder)
            folder = folders[folder]['parent'] if folders[folder]['parent'] in folders else ''
    if not items:
        return None
    keep = [dict(g, parent=g['parent'] if g['parent'] in used else '') for g in folders.values() if g['id'] in used]
    return {'version': 1, 'folders': keep, 'items': items}


def features_text(side):
    """The text for PLACEHOLDER_FEATURES_JSON (and the features.json file): compact JSON, safe inside a <script>."""
    return json.dumps(side, separators=(',', ':'), ensure_ascii=False).replace('</', '<\\/') if side else None


RIDGE_FILES = ('ridge_points.bin', 'ridge_patches.bin', 'ridge_shapes.bin')


def ridge_inline_json(side, read, names):
    """The text for PLACEHOLDER_RIDGE_JSON from an export's ridge.json (`side`)
    and its ridge files: the object ridge.json keeps under `viewer` (file
    names), each name replaced by the file's base64. None when there is none."""
    import base64
    obj = (side or {}).get('viewer')
    if not isinstance(obj, dict) or not obj.get('points'):
        return None
    out = dict(obj)
    out.pop('brush', None)                              # (round 1 exports: the overlay picture is no longer used)
    for k in ('points', 'patches', 'shapes'):
        name = out.get(k)
        out[k] = base64.b64encode(read(name)).decode('ascii') if name and name in names else None
    return json.dumps(out, separators=(',', ':'))


def build_inline_viewer(glb_path, tex_b64, caves_data, viewer_libs, progress=print,
                        hs_b64=None, walls_bytes=None, docs_json=None, ridge_json=None, hsb_b64=None,
                        features_json=None):
    """
    glb_path: the terrain.glb file, or its bytes.

    Build a fully self-contained HTML file:
      - Three.js libs inlined as <script> blocks
      - terrain.glb (geometry only) embedded as base64
      - satellite texture embedded as separate base64 (flipY=false in viewer)
      - optional hillshade texture embedded as TERRAIN_HS_B64
      - caves_data embedded as a JSON literal

    The result opens directly in any mobile browser with no server needed.
    """
    import base64

    viewer_html_path = VIEWER_BUILD_DIR / 'viewer.html'
    if not viewer_html_path.exists():
        progress("  WARNING: viewer.html not found in viewer_build/")
        return '<p>viewer.html missing. Run export from FLEX directory.</p>'

    html = viewer_html_path.read_text(encoding='utf-8')

    # 1. Inline Three.js lib <script src=...> tags
    for zip_path, local in viewer_libs.items():
        fname = Path(zip_path).name
        src_tag = f'<script src="libs/{fname}"></script>'
        if src_tag not in html:
            continue
        if local and local.exists():
            js = local.read_text(encoding='utf-8', errors='replace')
            html = html.replace(src_tag, f'<script>\n{js}\n</script>')
            progress(f"  Inlined {fname} ({len(js)//1024} KB)")
        else:
            progress(f"  WARNING: {fname} not available — viewer may not work offline")

    # 2. Embed terrain.glb as base64
    progress(f"  Encoding terrain.glb as base64...")
    glb_bytes = bytes(glb_path) if isinstance(glb_path, (bytes, bytearray)) else Path(glb_path).read_bytes()
    glb_b64   = base64.b64encode(glb_bytes).decode('ascii')
    progress(f"  GLB base64: {len(glb_b64)//1024} KB")
    html = html.replace('"PLACEHOLDER_GLB_B64"', f'"{glb_b64}"')

    # 3. Embed satellite texture as separate base64 (viewer applies with flipY=false)
    progress(f"  Embedding satellite texture ({len(tex_b64)//1024} KB)...")
    html = html.replace('"PLACEHOLDER_TEX_B64"', f'"{tex_b64}"')

    # 4. Embed hillshade texture if provided
    if hs_b64:
        progress(f"  Embedding hillshade texture ({len(hs_b64)//1024} KB)...")
        html = html.replace('"PLACEHOLDER_HS_B64"', f'"{hs_b64}"')
    # (if not provided the placeholder stays, viewer JS will detect and hide the toggle)

    # 4a. "Hillshade with brush" (the ridgewalking export's tex_hsb.jpg); an empty string when there is none
    html = html.replace('"PLACEHOLDER_HSB_B64"', f'"{hsb_b64 or ""}"')

    # 4b. Embed passage walls (walls.bin) as base64 — same bytes as the sidecar
    if walls_bytes:
        walls_b64 = base64.b64encode(walls_bytes).decode('ascii')
        progress(f"  Embedding passage walls ({len(walls_b64)//1024} KB)...")
        html = html.replace('"PLACEHOLDER_WALLS_B64"', f'"{walls_b64}"')

    # 5. Embed caves data as JSON literal
    caves_json = json.dumps(caves_data, separators=(',', ':'))
    # Inside a <script>, "</" in any string (a survey or map name) would end
    # the block early. "<\/" is the same string to JavaScript.
    caves_json = caves_json.replace('</', '<\\/')
    html = html.replace('PLACEHOLDER_CAVES_JSON', caves_json)

    # 6. Documents (docs.json, see above); 'null' leaves the viewer to look for docs.json beside it
    html = html.replace('PLACEHOLDER_DOCS_JSON', docs_json or 'null')

    # 7. V2 - Ridgewalking (export_ridge.py): the RIDGE object, 'null' for every other export
    html = html.replace('PLACEHOLDER_RIDGE_JSON', ridge_json or 'null')

    # 8. Surface features (features.json, see clean_features): 'null' for an export without them
    html = html.replace('PLACEHOLDER_FEATURES_JSON', features_json or 'null')

    progress(f"  Viewer HTML total: {len(html)//1024} KB")
    return html
