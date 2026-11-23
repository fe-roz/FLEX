#!/usr/bin/env python3
"""
Surface features in an export (export_terrain.py --features, viewer_inline.clean_features). No PDAL, no network.

  * the zip carries features.json (only the known fields, every value checked) and the single-file viewer.html
    has the same object as FEATURES, with viewer-features.js inlined; tools/rebuild_viewer.py keeps it;
  * what is cleaned: unknown kinds, positions that are not numbers, a point with more than one position, a line
    with one, colours, symbols, width and opacity out of range, folders nothing uses, a name that would end the
    script block;
  * an export without them is as it was: FEATURES is null and no features.json.

    python tools/test_export_features.py [--keep DIR]     (--keep: leave big.zip, the made-up 300 items, and plain.zip there, to look at)
"""
import io, json, math, os, re, subprocess, sys, tempfile, time, zipfile
from pathlib import Path
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import numpy as np
from PIL import Image
import export_terrain as et
import viewer_inline as vi

os.environ['SOURCE_DATE_EPOCH'] = '1795000000'       # a fixed export time, so two exports of the same thing are the same bytes
T0 = time.time()
fails = passes = 0
def check(label, ok, detail=''):
    global fails, passes
    if ok:
        passes += 1
    else:
        fails += 1
        print('FAIL', label, str(detail)[:500])

LAT, LON = 45.1234, -100.5678                      # the project's example place
MX, MY = 111320 * math.cos(math.radians(LAT)), 110540
def ll(x, y): return [round(LON + x / MX, 7), round(LAT + y / MY, 7)]
SYMBOLS = ['dot', 'square', 'triangle', 'diamond', 'star', 'cross']
COLOURS = ['#ff5252', '#40c4ff', '#69f0ae', '#ffd740', '#e040fb', '#ffffff']

def made_up(n=300, half=380.0):
    """About n made-up items around "Cave Ridge": points with every symbol, trails, areas, folders three deep."""
    rng = np.random.default_rng(11)
    folders = [{'id': 'g_ridge', 'name': 'Cave Ridge', 'parent': ''},
               {'id': 'g_ent', 'name': 'Entrances', 'parent': 'g_ridge'}, {'id': 'g_sinks', 'name': 'Sinks', 'parent': 'g_ent'},
               {'id': 'g_blow', 'name': 'Blowing holes', 'parent': 'g_ent'},
               {'id': 'g_trails', 'name': 'Trails and roads', 'parent': ''}, {'id': 'g_old', 'name': 'Old trails', 'parent': 'g_trails'},
               {'id': 'g_camp', 'name': 'Camp', 'parent': ''}, {'id': 'g_water', 'name': 'Water', 'parent': 'g_camp'}, {'id': 'g_spr', 'name': 'Springs', 'parent': 'g_water'},
               {'id': 'g_unused', 'name': 'Empty folder', 'parent': ''}]
    pf = ['g_ridge', 'g_ent', 'g_sinks', 'g_blow', 'g_camp', 'g_water', 'g_spr', '']
    items = []
    for i in range(n):
        x, y = (rng.random(2) * 2 - 1) * half
        if i % 10 == 7:                                              # a trail
            k = 12 + int(rng.integers(0, 30)); a = rng.random() * 6.28
            xs = x + np.cumsum(np.cos(a + np.cumsum(rng.normal(0, 0.25, k))) * 14); ys = y + np.cumsum(np.sin(a + np.cumsum(rng.normal(0, 0.25, k))) * 14)
            items.append({'id': f'it{i}', 'kind': 'line', 'name': f'Trail {i}', 'folder': 'g_old' if i % 20 == 7 else 'g_trails', 'colour': COLOURS[i % 6],
                          'symbol': 'dot', 'width': 1 + i % 5, 'opacity': 1, 'lonlat': [ll(a_, b_) for a_, b_ in zip(xs, ys)]})
        elif i % 10 == 9:                                            # an area
            r = 12 + rng.random() * 30; k = 9
            items.append({'id': f'it{i}', 'kind': 'area', 'name': f'Sink field {i}', 'folder': 'g_sinks', 'colour': COLOURS[(i // 10) % 6], 'symbol': 'dot',
                          'width': 2, 'opacity': 0.9, 'note': 'Several shallow sinks; none open.',
                          'lonlat': [ll(x + r * (0.7 + 0.3 * math.sin(3 * t)) * math.cos(t), y + r * math.sin(t)) for t in np.linspace(0, 6.28, k, endpoint=False)]})
        else:
            f = pf[i % len(pf)]
            items.append({'id': f'it{i}', 'kind': 'point', 'name': ['Pit', 'Blowing hole', 'Spring', 'Dig', 'Sink', 'Camp'][i % 6] + f' {i}', 'folder': f,
                          'colour': COLOURS[pf.index(f) % 6], 'symbol': SYMBOLS[pf.index(f) % 6], 'width': 2, 'opacity': 1,
                          **({'note': 'Drafting on a cold morning.\nCheck again in winter.'} if i % 6 == 1 else {}), 'lonlat': [ll(x, y)]})
    items.append({'id': 'long', 'kind': 'point', 'name': 'The entrance with a very long name that somebody typed in full on the desktop', 'folder': 'g_ent',
                  'colour': '#ff5252', 'symbol': 'star', 'width': 2, 'opacity': 1, 'lonlat': [ll(20, 30)]})
    items.append({'id': 'road', 'kind': 'line', 'name': 'Road out', 'folder': 'g_trails', 'colour': '#ffffff', 'symbol': 'dot', 'width': 5, 'opacity': 0.9,
                  'lonlat': [ll(-half * 0.5, -half * 0.8), ll(0, -half * 0.9), ll(half * 0.9, -half * 0.7), ll(half * 1.6, -half * 0.6)]})     # runs off the map
    return {'version': 1, 'folders': folders, 'items': items}

def features_const(html):
    m = re.search(r'<script>const FEATURES = (.*?);</script>', html, re.S)
    return json.loads(m.group(1).replace('<\\/', '</')) if m else 'MISSING'

keep = Path(sys.argv[sys.argv.index('--keep') + 1]) if '--keep' in sys.argv else None
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    def no_points(*a, **k): raise AssertionError('no point cloud may be read')
    et.fetch_ept_points = no_points
    et.get_viewer_libs = lambda progress=print: vi.local_viewer_libs()          # the vendored libs: no download
    def fake_sat(grid, tex_size=8192, source='esri', progress=print):          # a mottled green, no network
        w, h = grid.tex_dims(min(tex_size, 1024))
        yy, xx = np.mgrid[0:h, 0:w]
        g = (95 + 30 * np.sin(xx / 37.0) * np.cos(yy / 23.0) + 12 * np.sin((xx + yy) / 7.0)).astype(np.uint8)
        return Image.fromarray(np.dstack([(g * 0.75).astype(np.uint8), g, (g * 0.6).astype(np.uint8)]))
    et.fetch_satellite_texture = fake_sat
    if et.pygltflib is None:
        et.export_glb = lambda vertices, faces, uvs, out_path, progress=print: Path(out_path).write_bytes(b'glb')
    d = 0.0052
    BBOX = (LON - d, LAT - d * 0.7, LON + d, LAT + d * 0.7)                    # about 820 x 780 m
    lon = BBOX[0] - 0.002 + np.arange(140) * 0.0001; lat = BBOX[1] - 0.002 + np.arange(110) * 0.0001
    LO, LA = np.meshgrid(lon, lat)
    H = (1200 + 60 * np.sin((LO - LON) * 900) * np.cos((LA - LAT) * 1100) + 25 * np.sin((LO - LON) * 2600 + 1) + 4000 * (LA - LAT)).astype('<f4')
    H.tofile(tmp / 'dem.bin')
    (tmp / 'dem.json').write_text(json.dumps({'lon0': float(lon[0]), 'lat0': float(lat[0]), 'dlon': 0.0001, 'dlat': 0.0001, 'nx': 140, 'ny': 110, 'cell': 4.0, 'file': 'dem.bin'}))
    def run(name, extra):
        out = tmp / name
        argv, so = sys.argv, sys.stdout
        sys.argv = ['export_terrain.py', '--dem-grid', str(tmp / 'dem.json'), '--bbox', *map(str, BBOX), '--out', str(out), '--name', 'Cave Ridge',
                    '--max-triangles', '60000', '--tex-size', '1024', *extra]
        log = io.StringIO()
        try:
            sys.stdout = log
            et.main()
        except SystemExit as ex:
            log.write(f'EXIT {ex}')
        finally:
            sys.stdout, sys.argv = so, argv
        return out, log.getvalue()

    # ── 1. An export without features is as it was ───────────────────────────
    out0, log0 = run('plain.zip', [])
    z0 = zipfile.ZipFile(out0); h0 = z0.read('viewer.html').decode('utf-8')
    check('plain export: FEATURES is null, nothing left of the placeholder', features_const(h0) is None and 'PLACEHOLDER_FEATURES_JSON' not in h0.replace("'PLACEHOLDER_' + 'FEATURES_JSON'", ''), str(features_const(h0))[:80])
    check('plain export: the same file list as ever', {n for n in z0.namelist() if not n.startswith('libs/')} == {'terrain.glb', 'tex_sat.jpg', 'tex_hs.jpg', 'caves.json', 'viewer.html', 'serve.bat', 'serve.sh'}, sorted(z0.namelist()))
    check('plain export: the log does not mention them', 'Surface features' not in log0)
    out0b, _ = run('plain2.zip', ['--features', str(tmp / 'not-there.json')])
    check('a features file that is not there changes nothing', zipfile.ZipFile(out0b).read('viewer.html') == z0.read('viewer.html') and 'features.json' not in zipfile.ZipFile(out0b).namelist())
    (tmp / 'empty.json').write_text(json.dumps({'folders': [{'id': 'a', 'name': 'A', 'parent': ''}], 'items': []}))
    out0c, _ = run('plain3.zip', ['--features', str(tmp / 'empty.json')])
    check('an empty project changes nothing either: byte for byte the plain viewer', zipfile.ZipFile(out0c).read('viewer.html') == z0.read('viewer.html') and 'features.json' not in zipfile.ZipFile(out0c).namelist())
    (tmp / 'broken.json').write_text('{ not json')
    out0d, logd = run('plain4.zip', ['--features', str(tmp / 'broken.json')])
    check('a broken features file: a warning, and the export still made', out0d.exists() and 'could not be read' in logd and 'features.json' not in zipfile.ZipFile(out0d).namelist(), logd[-200:])

    # ── 2. The made-up project, through the exporter ─────────────────────────
    raw = made_up(300)
    (tmp / 'feat.json').write_text(json.dumps(raw))
    out, log = run('big.zip', ['--features', str(tmp / 'feat.json')])
    check('export with features written', out.exists() and 'EXIT' not in log, log[-600:])
    z = zipfile.ZipFile(out); names = set(z.namelist())
    check('zip: features.json beside the usual files', {'features.json', 'viewer.html', 'terrain.glb', 'caves.json'} <= names, sorted(names))
    side = json.loads(z.read('features.json'))
    check('features.json: version 1, every item, the folders in use (the empty one left out)', side['version'] == 1 and len(side['items']) == 302
          and {g['id'] for g in side['folders']} == {g['id'] for g in raw['folders']} - {'g_unused'}, [len(side['items']), [g['id'] for g in side['folders']]])
    kinds = {k: sum(1 for it in side['items'] if it['kind'] == k) for k in ('point', 'line', 'area')}
    check('points, lines and areas', kinds == {'point': 241, 'line': 31, 'area': 30} and f"{kinds['point']} points, {kinds['line']} lines, {kinds['area']} areas in 9 folders" in log, (kinds, log[-300:]))
    it = {i['id']: i for i in side['items']}
    check('an item keeps colour, symbol, width, opacity, folder, note', it['it1'] == {'id': 'it1', 'kind': 'point', 'name': 'Blowing hole 1', 'folder': 'g_ent', 'colour': '#40c4ff', 'symbol': 'square',
          'width': 2.0, 'opacity': 1.0, 'note': 'Drafting on a cold morning.\nCheck again in winter.', 'lonlat': raw['items'][1]['lonlat']}, it['it1'])
    check('a line that runs off the map goes whole', len(it['road']['lonlat']) == 4 and it['road']['width'] == 5)
    html = z.read('viewer.html').decode('utf-8')
    check('single file: FEATURES is the same object', features_const(html) == side)
    check('single file: viewer-features.js is inlined', 'root.ViewerFeatures = V' in html and '<script src="libs/viewer-features.js">' not in html)
    check('the lib travels in the zip for the app', 'libs/viewer-features.js' in names)
    r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rebuild_viewer.py'), str(out), '-o', str(tmp / 'rebuilt.zip')], capture_output=True, text=True)
    check('rebuild_viewer keeps FEATURES', r.returncode == 0 and features_const(zipfile.ZipFile(tmp / 'rebuilt.zip').read('viewer.html').decode('utf-8')) == side, r.stderr[-300:])
    r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rebuild_viewer.py'), str(out0), '-o', str(tmp / 'rebuilt0.zip')], capture_output=True, text=True)
    check('rebuild_viewer of a plain export: FEATURES null', r.returncode == 0 and features_const(zipfile.ZipFile(tmp / 'rebuilt0.zip').read('viewer.html').decode('utf-8')) is None, r.stderr[-300:])
    if keep:
        keep.mkdir(parents=True, exist_ok=True)
        (keep / 'big.zip').write_bytes(out.read_bytes())
        (keep / 'plain.zip').write_bytes(out0.read_bytes())

    # ── 3. What is cleaned ───────────────────────────────────────────────────
    P = lambda **k: dict({'id': 'x', 'kind': 'point', 'name': 'N', 'folder': '', 'colour': '#112233', 'symbol': 'star', 'width': 3, 'opacity': 0.5, 'lonlat': [ll(0, 0)]}, **k)
    c = vi.clean_features({'folders': [{'id': 'a', 'name': 'A', 'parent': 'gone'}, {'id': 'b', 'name': '', 'parent': 'a'}, {'id': 'c', 'name': 'C', 'parent': ''}, 'junk', {'name': 'no id'}],
                           'items': [P(id='ok', folder='b'), P(id='k', kind='circle'), P(id='nopos', lonlat=[]), P(id='nan', lonlat=[[float('nan'), 1]]), P(id='far', lonlat=[[200, 10]]),
                                     P(id='two', lonlat=[ll(0, 0), ll(5, 5)]), P(id='line1', kind='line', lonlat=[ll(0, 0)]), P(id='area2', kind='area', lonlat=[ll(0, 0), ll(1, 1)]),
                                     P(id='col', colour='red'), P(id='sym', symbol='heart'), P(id='wide', width=99, opacity=-3), P(id='str', width='4', opacity=None),
                                     P(id='fold', folder='nowhere'), P(id='quiet', label=False), P(id='extra', secret='x', lonlat=[ll(1, 2) + [1234.5]]),
                                     P(id='evil', name='a</script><script>alert(1)</script>', note='x' * 5000), 'junk', None]})
    ci = {i['id']: i for i in c['items']}
    check('unknown kinds, items without a usable position and junk are dropped', set(ci) == {'ok', 'two', 'col', 'sym', 'wide', 'str', 'fold', 'quiet', 'extra', 'evil'}, sorted(ci))
    check('a point keeps one position', len(ci['two']['lonlat']) == 1)
    check('a bad colour is the project\'s default, an unknown symbol a dot', ci['col']['colour'] == '#ffb020' and ci['sym']['symbol'] == 'dot')
    check('width 1..10 and opacity 0.1..1; not a number: the defaults', ci['wide']['width'] == 10 and ci['wide']['opacity'] == 0.1 and ci['str']['width'] == 2 and ci['str']['opacity'] == 1)
    check('an unknown folder is no folder', ci['fold']['folder'] == '')
    check('label off is kept, on is left out', ci['quiet'].get('label') is False and 'label' not in ci['ok'])
    check('only the known fields; heights are not carried', 'secret' not in ci['extra'] and len(ci['extra']['lonlat'][0]) == 2)
    check('folders: the one in use and the ones it sits in; an unknown parent is the top; a nameless one is "Folder"',
          c['folders'] == [{'id': 'a', 'name': 'A', 'parent': ''}, {'id': 'b', 'name': 'Folder', 'parent': 'a'}], c['folders'])
    check('a note is cut at 4000 characters', len(ci['evil']['note']) == 4000)
    txt = vi.features_text(c)
    check('a name with </script> cannot end the block, and reads back the same', '</script>' not in txt and json.loads(txt.replace('<\\/', '</')) == c)
    check('nothing to carry: None', vi.clean_features({'items': []}) is None and vi.clean_features(None) is None and vi.clean_features({'items': 'x'}) is None and vi.features_text(None) is None)
    (tmp / 'evil.json').write_text(json.dumps({'folders': [], 'items': [P(id='evil', name='a</script><script>window.HACKED=1</script>')]}))
    oute, _ = run('evil.zip', ['--features', str(tmp / 'evil.json')])
    ze = zipfile.ZipFile(oute); he = ze.read('viewer.html').decode('utf-8')
    check('in the export: the file has the name as typed, the page has it made safe', json.loads(ze.read('features.json'))['items'][0]['name'].endswith('</script>')
          and features_const(he)['items'][0]['name'] == 'a</script><script>window.HACKED=1</script>' and 'window.HACKED=1</script>' not in he)

print(f'{passes} passed, {fails} failed ({time.time() - T0:.1f} s)')
sys.exit(1 if fails else 0)
