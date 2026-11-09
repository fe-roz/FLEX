#!/usr/bin/env python3
"""
export_terrain.py --docs, end to end: a made-up project's documents (image pages, kinds,
a tag on one page) go through the exporter's own zip writer and come out as docs.json,
the page images beside it and a copy inside the single-file viewer.html.

No PDAL, no network: the terrain comes from a synthetic map grid (as tools/test_map_terrain.py)
and the satellite fetch is stubbed. Run from the FLEX folder with the exporter's Python:

    python tools/test_export_docs_zip.py

Pins down:
  * docs.json carries the log entries (doc.add with its kind, doc.pagetag naming a page by
    its sha256), the document groups and the per-document summary (kind, group, tagged pages);
  * every page image is a file of the zip, byte for byte, and inline in viewer.html;
  * a page that is not there or is a PDF is left out without stopping the export.
"""
import base64, hashlib, io, json, math, os, sys, tempfile, zipfile
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import numpy as np
import export_terrain as et
from PIL import Image

fails = passes = 0
def check(label, ok, detail=''):
    global fails, passes
    if ok:
        passes += 1
    else:
        fails += 1
        print('FAIL', label, detail)

BBOX = (-100.5800, 45.1200, -100.5600, 45.1400)          # the project's example place
CELL = 50.0
PJ, CAVE = 'pjtest0001', 'cavetest01'

def browser_grid(bbox, cell):
    w, s, e, n = bbox
    mLat, mLon = 111320.0, 111320.0 * math.cos((s + n) / 2 * math.pi / 180)
    W, H = (e - w) * mLon, (n - s) * mLat
    pad = 0.06 * max(W, H) + 3 * cell
    nx, ny = math.ceil((W + 2 * pad) / cell) + 1, math.ceil((H + 2 * pad) / cell) + 1
    lon0, lat0, dlon, dlat = w - pad / mLon, s - pad / mLat, cell / mLon, cell / mLat
    LON, LAT = np.meshgrid(lon0 + np.arange(nx) * dlon, lat0 + np.arange(ny) * dlat)
    h = 1500 + 800 * (LAT - s) + 100 * np.sin((LON - w) * 300)
    return dict(lon0=lon0, lat0=lat0, dlon=dlon, dlat=dlat, nx=nx, ny=ny, cell=cell), h

with tempfile.TemporaryDirectory() as tmp:
    # the grid the browser would have sampled
    hdr, heights = browser_grid(BBOX, CELL)
    open(os.path.join(tmp, 'dem.bin'), 'wb').write(heights.astype('<f4').tobytes())
    hdr['file'] = 'dem.bin'
    hpath = os.path.join(tmp, 'dem.json')
    json.dump(hdr, open(hpath, 'w'))

    # three image pages, made here, stored by their hash like the library does
    pages, files = [], {}
    for i, col in enumerate([(180, 60, 60), (60, 180, 60), (60, 60, 180)]):
        b = io.BytesIO(); Image.new('RGB', (64 + i, 48), col).save(b, 'JPEG', quality=80); data = b.getvalue()
        h = hashlib.sha256(data).hexdigest()
        f = os.path.join(tmp, h + '.jpg'); open(f, 'wb').write(data)
        pages.append({'h': h, 'ext': 'jpg', 'w': 64 + i, 'ht': 48, 'name': f'p{i}.jpg', 'path': f}); files[h] = data
    ghost = {'h': 'f' * 64, 'ext': 'jpg', 'path': os.path.join(tmp, 'missing.jpg')}        # listed, not on disk
    pdf = {'h': 'e' * 64, 'ext': 'pdf', 'path': os.path.join(tmp, 'x.pdf')}
    def E(seq, op, **d):
        return dict({'id': f'x.{seq}', 'dev': 'x', 'seq': seq, 't': f'2026-03-01T10:00:{seq:02d}Z', 'who': 'T', 'op': op}, **d)
    pg = lambda p: {k: p[k] for k in ('h', 'ext', 'w', 'ht', 'name') if k in p}
    entries = [
        E(1, 'doc.add', doc='book', title='Sketchbook 3', kind='sketch-plan', pages=[pg(pages[0]), pg(pages[1])], tags=[f'project:{PJ}', f'survey:{CAVE}:Main line']),
        E(2, 'doc.pagetag', doc='book', h=pages[1]['h'], target=f'area:{CAVE}:A2~A4'),
        E(3, 'doc.add', doc='photo', title='Passage photo', kind='photo', pages=[pg(pages[2])], tags=[f'project:{PJ}', f'station:{CAVE}:A3']),
    ]
    groups = [{'id': 'notes', 'label': 'Survey notes', 'kinds': ['shot-table', 'notes', 'topodroid']}, {'id': 'sketches', 'label': 'Sketches', 'kinds': ['sketch-plan']},
              {'id': 'media', 'label': 'Media', 'kinds': ['photo', 'video']}, {'id': 'other', 'label': 'Other', 'kinds': ['other']}]
    summary = [{'id': 'book', 'title': 'Sketchbook 3', 'kind': 'sketch-plan', 'group': 'sketches', 'pages': 2, 'tagged': [{'i': 1, 'h': pages[1]['h'], 'targets': [f'area:{CAVE}:A2~A4']}]},
               {'id': 'photo', 'title': 'Passage photo', 'kind': 'photo', 'group': 'media', 'pages': 1, 'tagged': []}]
    docs_in = os.path.join(tmp, 'docs_input.json')
    json.dump({'project': {'id': PJ, 'name': 'Test Project'}, 'caves': [{'id': CAVE, 'name': 'Cave Ridge'}], 'entries': entries,
               'pages': pages + [ghost, pdf], 'groups': groups, 'summary': summary}, open(docs_in, 'w'))

    # the exporter, end to end (no point cloud, nothing fetched)
    def no_points(*a, **k):
        raise AssertionError('the map-terrain export must not read a point cloud')
    et.fetch_ept_points = no_points
    et.fetch_satellite_texture = lambda grid, tex_size=8192, source='esri', progress=print: Image.new('RGB', grid.tex_dims(256), (90, 110, 80))
    out = os.path.join(tmp, 'out.zip')
    argv, stdout, log = sys.argv, sys.stdout, io.StringIO()
    sys.argv = ['export_terrain.py', '--dem-grid', hpath, '--bbox', *map(str, BBOX), '--out', out, '--name', 'Test',
                '--max-triangles', '20000', '--tex-size', '256', '--docs', docs_in]
    try:
        sys.stdout = log
        et.main()
    finally:
        sys.stdout, sys.argv = stdout, argv
    check('export written', os.path.exists(out), log.getvalue()[-800:])
    if os.path.exists(out):
        z = zipfile.ZipFile(out)
        names = set(z.namelist())
        check('zip holds docs.json and each page image beside the viewer', 'docs.json' in names and all(f'docs_{p["h"]}.jpg' in names for p in pages), sorted(names))
        check('a missing page and a PDF page are left out, the export goes on', f'docs_{ghost["h"]}.jpg' not in names and not any(n.endswith('.pdf') for n in names))
        side = json.loads(z.read('docs.json'))
        check('docs.json: the entries, with the kind and the page tag (a page named by its sha256)',
              [e['op'] for e in side['entries']] == ['doc.add', 'doc.pagetag', 'doc.add'] and side['entries'][1]['h'] == pages[1]['h'] and side['entries'][1]['target'] == f'area:{CAVE}:A2~A4'
              and side['entries'][0]['kind'] == 'sketch-plan', side['entries'])
        check('docs.json: the groups, and the summary with the tagged page', [g['id'] for g in side.get('groups', [])] == ['notes', 'sketches', 'media', 'other']
              and side['summary'][0]['tagged'][0]['h'] == pages[1]['h'] and side['summary'][0]['group'] == 'sketches', {k: side.get(k) for k in ('groups', 'summary')})
        check('docs.json lists the three page images', sorted(p['h'] for p in side['pages']) == sorted(p['h'] for p in pages), side['pages'])
        check('page images are byte for byte what the library had', all(z.read(f'docs_{p["h"]}.jpg') == files[p['h']] for p in pages))
        html = z.read('viewer.html').decode('utf-8')
        at = html.index('window.DOCS_EXPORT = ') + len('window.DOCS_EXPORT = ')
        depth, in_str, i, end = 0, False, at, -1
        while i < len(html):
            ch = html[i]
            if in_str:
                if ch == '\\': i += 1
                elif ch == '"': in_str = False
            elif ch == '"': in_str = True
            elif ch == '{': depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0: end = i + 1; break
            i += 1
        inl = json.loads(html[at:end])
        check('viewer.html carries the same entries, groups and the page images inline',
              len(inl['entries']) == 3 and len(inl['groups']) == 4 and all(base64.b64decode(inl['inline'][p['h'] + '.jpg']) == files[p['h']] for p in pages), list(inl))

print(f'{passes} passed, {fails} failed')
sys.exit(1 if fails else 0)
