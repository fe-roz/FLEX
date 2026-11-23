#!/usr/bin/env python3
"""
Marks on ridgewalking features, the export's side. No PDAL, no network.

  * ridgewalk.py writes features.json (one entry a feature: anchor = its shallowest return, returns, deepest,
    box, true entrance / guessed, an id made from the anchor's place), here from its own made-up scene (--demo);
  * the exporter carries it as ridge_features.json in the viewer's frame with each anchor's lon / lat, and RIDGE
    names it (slim shell) or holds the list (the single-file viewer);
  * --ridge-marks FILE (the project's marks inside the area) becomes ridge_marks.json / RIDGE.marks: only the known
    fields, every value checked; no marks, no file and no key; tools/rebuild_viewer.py keeps both;
  * marks change nothing that is computed: the terrain, the returns and the shapes are byte for byte the same.

    python tools/test_export_ridge_marks.py
"""
import io, json, math, os, re, subprocess, sys, tempfile, time, zipfile
from pathlib import Path
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, ROOT)
import numpy as np
from PIL import Image
import export_terrain as et
import export_ridge as xr
import viewer_inline as vi

T0 = time.time()
fails = passes = 0
def check(label, ok, detail=''):
    global fails, passes
    if ok:
        passes += 1
    else:
        fails += 1
        print('FAIL', label, str(detail)[:600])

LAT, LON = 45.1234, -100.5678                      # the project's example place

# ── 1. Cleaning what the dialog sends ────────────────────────────────────────
raw = {'marks': [
    {'id': 'm1', 'kind': 'cave', 'note': 'Goes. </script><b>', 'lon': LON, 'lat': LAT, 'h': 512.345, 'who': 'Ana', 't': '2026-11-20T10:00:00.000Z', 'changes': 2,
     'feat': {'id': 'r1-2', 'depth': 9.876, 'returns': 41.4, 'entrance': 'true', 'size': [1, 2, 3], 'junk': 'x'}, 'extra': 1},
    {'id': 'm2', 'kind': 'unreached', 'lon': str(LON + 0.001), 'lat': LAT},
    {'id': 'm3', 'kind': 'dragon', 'lon': LON, 'lat': LAT},          # not a kind
    {'id': 'm4', 'kind': 'pit', 'lon': 'east', 'lat': LAT},           # no place
    {'id': '', 'kind': 'pit', 'lon': LON, 'lat': LAT},                # no id
    {'id': 'm5', 'kind': 'nothing', 'lon': LON, 'lat': 95},           # not on earth
    'nonsense', None,
]}
c = vi.clean_ridge_marks(raw)
check('cleaning: the two good marks stay, in order; the rest go', c and c['version'] == 1 and [m['id'] for m in c['marks']] == ['m1', 'm2'], c)
check('…only the known fields, numbers rounded, the feature\'s hint kept', c['marks'][0] == {'id': 'm1', 'kind': 'cave', 'note': 'Goes. </script><b>', 'lon': LON, 'lat': LAT, 'who': 'Ana', 't': '2026-11-20T10:00:00.000Z', 'h': 512.35 if False else 512.35,
      'feat': {'id': 'r1-2', 'depth': 9.88, 'returns': 41, 'entrance': 'true'}} or c['marks'][0]['h'] in (512.34, 512.35), c['marks'][0])
check('…a number sent as text is read; no height and no feature are simply left out', c['marks'][1] == {'id': 'm2', 'kind': 'unreached', 'note': '', 'lon': round(LON + 0.001, 7), 'lat': LAT, 'who': '', 't': ''}, c['marks'][1])
check('nothing usable: None (no file is written)', vi.clean_ridge_marks({'marks': []}) is None and vi.clean_ridge_marks(None) is None and vi.clean_ridge_marks({'marks': [{'kind': 'cave'}]}) is None and vi.clean_ridge_marks('x') is None)
check('a plain list is read too; at most `limit` are kept', len(vi.clean_ridge_marks(raw['marks'])['marks']) == 2 and len(vi.clean_ridge_marks([dict(raw['marks'][0], id='k%d' % i) for i in range(30)], limit=7)['marks']) == 7)

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    # ── 2. The step's own list, from its made-up scene ────────────────────────
    def demo(name):
        d = tmp / name
        r = subprocess.run([sys.executable, os.path.join(ROOT, 'ridgewalk.py'), '--demo', str(d), '--workers', '2'], capture_output=True, text=True)
        return d, r
    rdir, r1 = demo('rw')
    check('ridgewalk.py --demo ran and wrote features.json', r1.returncode == 0 and (rdir / 'features.json').exists(), r1.stdout[-300:] + r1.stderr[-300:])
    FJ = json.loads((rdir / 'features.json').read_text()); F = FJ['features']
    meta = json.loads((rdir / 'ridge.json').read_text())
    check('one entry a feature (as many as ridge.json counts), version 1', FJ['version'] == 1 and len(F) == meta['counts']['features'] and len(F) >= 4, (len(F), meta['counts']))
    check('each: id, anchor, returns, deepest, box, entrance', all(set(f) == {'id', 'x', 'y', 'z', 'n', 'deepest', 'box', 'entrance'} and len(f['box']) == 6 and f['n'] >= 2 and f['deepest'] > 0 and f['entrance'] in ('true', 'guessed', 'none') for f in F), F[:1])
    check('the anchor is inside the feature\'s box, at its top (the shallowest return is the highest here)', all(f['box'][0] - 1e-6 <= f['x'] <= f['box'][3] + 1e-6 and f['box'][1] - 1e-6 <= f['y'] <= f['box'][4] + 1e-6 and abs(f['z'] - f['box'][5]) < 2.0 for f in F), F[:2])
    check('the scene\'s pits are true entrances, and it has a guessed opening', sum(f['entrance'] == 'true' for f in F) >= 3 and any(f['entrance'] == 'guessed' for f in F), [f['entrance'] for f in F])
    # against the step's own points: the returns counted are the grouped ones in the box
    buf = (rdir / 'points.bin').read_bytes(); xyz, depth, kind = xr.read_points(buf)
    big = max(F, key=lambda f: f['n'])
    inb = (kind == 0) & (xyz[:, 0] >= big['box'][0] - .01) & (xyz[:, 0] <= big['box'][3] + .01) & (xyz[:, 1] >= big['box'][1] - .01) & (xyz[:, 1] <= big['box'][4] + .01) & (xyz[:, 2] >= big['box'][2] - .01) & (xyz[:, 2] <= big['box'][5] + .01)
    check('the biggest feature: its returns are the grouped returns in its box, its deepest is theirs', abs(int(inb.sum()) - big['n']) <= max(3, big['n'] // 20) and abs(float(depth[inb].max()) - big['deepest']) < 0.5, (int(inb.sum()), big))
    check('ids are made from the anchor\'s place and differ', len({f['id'] for f in F}) == len(F) and all(re.fullmatch(r'r[0-9a-f]+-[0-9a-f]+(\.\d+)?', f['id']) for f in F), [f['id'] for f in F])
    rdir2, _ = demo('rw2')
    F2 = json.loads((rdir2 / 'features.json').read_text())['features']
    check('a second run gives the same ids at the same places (a hint that survives a re-run)', [(f['id'], f['x'], f['y']) for f in F2] == [(f['id'], f['x'], f['y']) for f in F])

    # the demo has no place on earth: give it the example one (as a real run has)
    E0, N0, _z = et.latlon_to_utm(LAT, LON, 14)
    E0, N0 = math.floor(E0) - 96.0, math.floor(N0) - 72.0
    for d in (rdir,):
        m = json.loads((d / 'ridge.json').read_text()); m.update(epsg=32614, zone=14, south=False, origin=[E0, N0]); (d / 'ridge.json').write_text(json.dumps(m))

    # ── 3. Through the exporter ───────────────────────────────────────────────
    def no_points(*a, **k): raise AssertionError('no point cloud may be read by the export itself')
    et.fetch_ept_points = no_points
    et.get_viewer_libs = lambda progress=print: vi.local_viewer_libs()
    et.fetch_satellite_texture = lambda grid, tex_size=8192, source='esri', progress=print: Image.new('RGB', grid.tex_dims(tex_size), (90, 110, 80))
    if et.pygltflib is None:
        et.export_glb = lambda vertices, faces, uvs, out_path, progress=print: Path(out_path).write_bytes(b'glb')
    lat0, lon0 = et.utm_to_latlon(np.array([E0, E0 + 192.0]), np.array([N0, N0 + 144.0]), 14, False)
    BBOX = (float(lon0[0]), float(lat0[0]), float(lon0[1]), float(lat0[1]))
    def run(name, extra):
        out = tmp / name
        argv, so = sys.argv, sys.stdout
        sys.argv = ['export_terrain.py', '--bbox', *map(str, BBOX), '--out', str(out), '--name', 'Cave Ridge', '--max-triangles', '30000', '--tex-size', '512', '--ridgewalk-dir', str(rdir), *extra]
        log = io.StringIO()
        try:
            sys.stdout = log
            et.main()
        except SystemExit as ex:
            log.write(f'EXIT {ex}')
        finally:
            sys.stdout, sys.argv = so, argv
        return out, log.getvalue()
    def ridge_const(html):
        m = re.search(r'<script>const RIDGE = (.*?);</script>', html, re.S)
        return json.loads(m.group(1).replace('<\\/', '</')) if m else 'MISSING'

    out, log = run('plain.zip', [])
    z = zipfile.ZipFile(out); names = z.namelist()
    check('the export is made and carries ridge_features.json, no ridge_marks.json', out.exists() and 'EXIT' not in log and 'ridge_features.json' in names and 'ridge_marks.json' not in names, log[-500:])
    side = json.loads(z.read('ridge.json')); RF = json.loads(z.read('ridge_features.json'))['features']
    cm = json.loads(z.read('caves.json'))['meta']
    check('ridge.json\'s RIDGE names the list by file (the slim shell, the app); no marks key', side['viewer'].get('features') == 'ridge_features.json' and 'marks' not in side['viewer'], side['viewer'])
    check('the list has every feature, in the viewer\'s frame: metres from the terrain\'s centre, the point clouds\' vertical shift added', len(RF) == len(F) and all(
        abs(g['x'] - (E0 + f['x'] - cm['utm_center_e'])) < 0.02 and abs(g['y'] - (N0 + f['y'] - cm['utm_center_n'])) < 0.02 and abs(g['z'] - (f['z'] + cm['z_offset'])) < 0.02 and
        abs(g['box'][5] - (f['box'][5] + cm['z_offset'])) < 0.02 and abs(g['box'][0] - (E0 + f['box'][0] - cm['utm_center_e'])) < 0.02 and g['n'] == f['n'] and g['deepest'] == f['deepest'] and g['entrance'] == f['entrance'] and g['id'] == f['id']
        for f, g in zip(F, RF)), (F[0], RF[0], cm['utm_center_e']))
    back = [et.latlon_to_utm(g['lat'], g['lon'], 14)[:2] for g in RF]
    check('each anchor\'s lon / lat is its place (back to UTM within 2 cm)', all(abs(b[0] - (E0 + f['x'])) < 0.02 and abs(b[1] - (N0 + f['y'])) < 0.02 for b, f in zip(back, F)), (back[0], E0 + F[0]['x']))
    pts = xr.read_points(z.read('ridge_points.bin'))[0]
    g0 = RF[0]
    check('an anchor is one of the returns the viewer draws (the same frame as ridge_points.bin)', float(np.min(np.linalg.norm(pts - np.array([g0['x'], g0['y'], g0['z']]), axis=1))) < 0.03)
    h = z.read('viewer.html').decode('utf-8'); R = ridge_const(h)
    check('the single-file viewer: RIDGE holds the list itself; no marks', isinstance(R, dict) and R.get('features') == RF and 'marks' not in R, str(R)[:200] if not isinstance(R, dict) else list(R))

    (tmp / 'marks.json').write_text(json.dumps({'marks': raw['marks'] + [{'id': 'here', 'kind': 'pit', 'note': 'Rope needed: 12 m', 'lon': RF[1]['lon'], 'lat': RF[1]['lat'], 'h': RF[1]['z'], 'who': 'Bo', 't': '2026-11-21T09:00:00.000Z', 'feat': {'id': RF[1]['id'], 'depth': RF[1]['deepest'], 'returns': RF[1]['n'], 'entrance': RF[1]['entrance']}}]}))
    outm, logm = run('marks.zip', ['--ridge-marks', str(tmp / 'marks.json')])
    zm = zipfile.ZipFile(outm)
    MK = json.loads(zm.read('ridge_marks.json')) if 'ridge_marks.json' in zm.namelist() else None
    check('with --ridge-marks: ridge_marks.json, cleaned (3 marks), and the log says so', MK and MK['version'] == 1 and [m['id'] for m in MK['marks']] == ['m1', 'm2', 'here'] and 'Marks on ridgewalking features: 3 carried along' in logm, logm[-400:])
    Rm = ridge_const(zm.read('viewer.html').decode('utf-8'))
    check('RIDGE names it by file in ridge.json and holds the marks in the single-file viewer (a note with </script> in it does not end the script)', json.loads(zm.read('ridge.json'))['viewer'].get('marks') == 'ridge_marks.json' and
          isinstance(Rm, dict) and Rm['marks'] == MK['marks'] and Rm['marks'][0]['note'] == 'Goes. </script><b>' and Rm['features'] == RF)
    same = [n for n in ('terrain.glb', 'ridge_points.bin', 'ridge_shapes.bin', 'ridge_patches.bin', 'ridge_features.json', 'tex_hs.jpg', 'tex_hsb.jpg') if n in names]
    check('marks change nothing that is computed: terrain, returns, shapes, patches, features and the hillshades are byte for byte the same', len(same) >= 5 and all(zm.read(n) == z.read(n) for n in same), same)
    for bad, label in ((tmp / 'nowhere.json', 'a marks file that is not there'), (tmp / 'empty.json', 'no marks in the file'), (tmp / 'broken.json', 'a broken marks file')):
        if 'empty' in bad.name: bad.write_text('{"marks": []}')
        if 'broken' in bad.name: bad.write_text('{ not json')
        ob, lb = run('bad.zip', ['--ridge-marks', str(bad)])
        zb = zipfile.ZipFile(ob)
        check(label + ': the export is made, without marks', 'ridge_marks.json' not in zb.namelist() and 'marks' not in ridge_const(zb.read('viewer.html').decode('utf-8')) and ('could not be read' in lb) == ('broken' in bad.name), lb[-200:])
    reb = tmp / 'rebuilt.zip'
    rr = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'rebuild_viewer.py'), str(outm), '-o', str(reb)], capture_output=True, text=True)
    Rr = ridge_const(zipfile.ZipFile(reb).read('viewer.html').decode('utf-8')) if rr.returncode == 0 else None
    check('tools/rebuild_viewer.py keeps the list and the marks', rr.returncode == 0 and Rr and Rr.get('features') == RF and Rr.get('marks') == MK['marks'], rr.stderr[-300:])
    # an older ridge folder (no features.json): no list, no key, everything else as it was
    (rdir / 'features.json').unlink()
    oo, lo = run('old.zip', [])
    zo = zipfile.ZipFile(oo)
    check('a ridge folder from before the list: no ridge_features.json, no key in RIDGE, the export made', 'ridge_features.json' not in zo.namelist() and 'features' not in ridge_const(zo.read('viewer.html').decode('utf-8')) and
          'features' not in json.loads(zo.read('ridge.json'))['viewer'] and zo.read('ridge_points.bin') == z.read('ridge_points.bin'))

print(f'{passes} passed, {fails} failed ({time.time() - T0:.1f} s)')
sys.exit(1 if fails else 0)
