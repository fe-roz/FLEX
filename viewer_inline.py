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


def build_inline_viewer(glb_path, tex_b64, caves_data, viewer_libs, progress=print,
                        hs_b64=None, walls_bytes=None, docs_json=None):
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

    progress(f"  Viewer HTML total: {len(html)//1024} KB")
    return html
