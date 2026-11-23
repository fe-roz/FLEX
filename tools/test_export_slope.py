#!/usr/bin/env python3
"""
The slope map of an export (export_terrain.py --slope-map, export_slope.py) and the facts for the phone's
"About this map" card (export_about.py). No PDAL, no network: a stand-in ridge folder whose ground is strips of a
known slope (20, 28, 33, 40, 47, 55 and 70 degrees), and a normal LiDAR export whose DEM is handed in.

  * tex_slope.jpg: each strip in its class colour over the hillshade at 70 %, the 20 degree strip plain hillshade;
    the strength and the colours as options; tiled (tex_slope_<c>_<r>.jpg, meta `slope`) and untiled; inlined as
    TERRAIN_SLOPE_B64; the legend's classes in meta; rebuilt by tools/rebuild_viewer.py;
  * no slope map on map terrain (and it says why); a normal export is unchanged, the placeholder an empty string;
  * caves.json meta `about`: date, area, LiDAR dataset names (never the link), maps, ridgewalking counts, flagged
    passes and settings, the FLEX commit read without git.

    python tools/test_export_slope.py [--keep DIR]      (--keep: leave slope.zip, plain.zip, old.zip there, to look at)
"""
import base64, io, json, math, os, re, subprocess, sys, tempfile, time, zipfile
from pathlib import Path
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import numpy as np
from PIL import Image
import export_terrain as et
import export_slope as es
import export_about as ea
import viewer_inline as vi

os.environ['SOURCE_DATE_EPOCH'] = '1795000000'       # a fixed export time
T0 = time.time()
fails = passes = 0
def check(label, ok, detail=''):
    global fails, passes
    if ok:
        passes += 1
    else:
        fails += 1
        print('FAIL', label, str(detail)[:600])

LAT, LON = 45.1234, -100.5678
ZONE = et.utm_zone_for(LON)
CE, CN = et.latlon_to_utm(LAT, LON, ZONE)[:2]
CELL, STRIP = 0.3, 40                                # strips 12 m wide
DEGS = [20, 28, 33, 40, 47, 55, 70]
NX, NY = STRIP * len(DEGS), 240
OX, OY = round(CE - NX * CELL / 2, 1), round(CN - NY * CELL / 2, 1)
prof = np.concatenate([[0.0], np.cumsum(np.repeat(np.tan(np.radians(DEGS)) * CELL, STRIP))])[:NX]
lid = (1200.0 + np.tile(prof, (NY, 1))).astype(np.float32)
COUNTS = {'returns': 250000, 'below': 420, 'groups': 12, 'lone': 7, 'likely_noise': 3, 'pattern_noise': 96, 'features': 9, 'true_cells': 31, 'guessed_cells': 18}
PASSES = [{'id': 11, 'returns': 90000, 'deep': 4, 'share': 0.0, 'flagged': False}, {'id': 12, 'returns': 80000, 'deep': 300, 'share': 0.004, 'flagged': True}, {'id': 14, 'returns': 80000, 'deep': 2, 'share': 0.0, 'flagged': False}]

def write_ridge(d):
    d = Path(d); d.mkdir(parents=True, exist_ok=True)
    (d / 'ridge.json').write_text(json.dumps({'version': 1, 'epsg': 32600 + ZONE, 'zone': ZONE, 'south': False, 'origin': [OX, OY], 'cell': CELL, 'nx': NX, 'ny': NY,
        'params': {'cell': CELL, 'min_behind': 1.0, 'max_link': 12.0, 'link': 1.5, 'workers': 4}, 'counts': COUNTS, 'passes': PASSES, 'seconds': 1, 'notes': []}))
    np.save(d / 'lid.npy', lid); np.save(d / 'holes.npy', np.zeros((NY, NX), np.uint8))
    import struct
    (d / 'points.bin').write_bytes(b'RWP1' + struct.pack('<I', 0))
    br = np.full((NY // 3, NX // 3), 0.02, np.float32); br[:20, :] = 0.5
    np.save(d / 'brush.npy', br)
    (d / 'brush.json').write_text(json.dumps({'x0': 0, 'y0': 0, 'cell': CELL * 3, 'nx': NX // 3, 'ny': NY // 3, 'band': [0.3, 2.0]}))
    return d

def const(html, name):
    m = re.search(r'<script>const ' + name + r'\s*= "(.*?)";</script>', html, re.S)
    return m.group(1) if m else 'MISSING'
def strip_about(html):
    i = html.find('"about":'); d, j = 0, html.index('{', i)
    while True:
        d += (html[j] == '{') - (html[j] == '}'); j += 1
        if d == 0: break
    return html[:i] + '"x_old":1' + html[j:]

keep = Path(sys.argv[sys.argv.index('--keep') + 1]) if '--keep' in sys.argv else None
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    rdir = write_ridge(tmp / 'ridge')
    def no_points(*a, **k): raise AssertionError('no point cloud may be read')
    et.fetch_ept_points = no_points
    et.get_viewer_libs = lambda progress=print: vi.local_viewer_libs()
    et.fetch_satellite_texture = lambda grid, tex_size=8192, source='esri', progress=print: Image.new('RGB', grid.tex_dims(min(tex_size, 512)), (90, 110, 80))
    if et.pygltflib is None:
        et.export_glb = lambda vertices, faces, uvs, out_path, progress=print: Path(out_path).write_bytes(b'glb')
    d = 0.0006
    BBOX = (LON - d, LAT - d / 2, LON + d, LAT + d / 2)
    def run(name, extra):
        out = tmp / name
        argv, so = sys.argv, sys.stdout
        sys.argv = ['export_terrain.py', '--bbox', *map(str, BBOX), '--out', str(out), '--name', 'Cave Ridge', '--max-triangles', '30000', '--tex-size', '512', '--z-offset', '-24.5', *extra]
        log = io.StringIO()
        try:
            sys.stdout = log
            et.main()
        except SystemExit as ex:
            log.write(f'EXIT {ex}')
        finally:
            sys.stdout, sys.argv = so, argv
        return out, log.getvalue()
    RIDGE = ['--ept', 'http://localhost:8080/data/Cave_Ridge_2021/ept.json', '--also-ept', 'C:\\lidar\\Sink Valley 2019\\ept.json', '--ridgewalk-dir', str(rdir)]
    # the middle column of each strip, a few rows: in the picture, as [mean r, g, b]
    def strip_rgb(img, k, rows=slice(100, 140)):
        a = np.asarray(img.convert('RGB')).astype(float)
        c0 = int((k + 0.5) * STRIP * a.shape[1] / NX)
        return a[int(rows.start * a.shape[0] / NY):int(rows.stop * a.shape[0] / NY), c0 - 3:c0 + 4].reshape(-1, 3).mean(axis=0)
    COL = {28: (0xff, 0xe6, 0x00), 33: (0xff, 0x99, 0x00), 40: (0xff, 0x1a, 0x00), 47: (0xa0, 0x20, 0xf0), 55: (0x1f, 0x4f, 0xff), 70: (0, 0, 0)}

    # ── 1. the slope picture, untiled ────────────────────────────────────────
    out, log = run('slope.zip', RIDGE + ['--slope-map'])
    check('export with the slope map written', out.exists() and 'EXIT' not in log, log[-600:])
    z = zipfile.ZipFile(out); names = set(z.namelist())
    check('zip: tex_slope.jpg beside tex_hs.jpg and tex_hsb.jpg; no tiles for a small area', {'tex_slope.jpg', 'tex_hs.jpg', 'tex_hsb.jpg'} <= names and not [n for n in names if n.startswith('tex_slope_')], sorted(names))
    hs = Image.open(io.BytesIO(z.read('tex_hs.jpg'))); sl = Image.open(io.BytesIO(z.read('tex_slope.jpg')))
    check('the slope picture has the hillshade\'s size, in colour', sl.size == hs.size and sl.mode == 'RGB', (sl.size, sl.mode))
    for k, deg in enumerate(DEGS):
        got, g = strip_rgb(sl, k), strip_rgb(hs, k)
        want = g if deg < 27 else 0.3 * g + 0.7 * np.array(COL[deg], float)
        check(f'{deg} degrees: ' + ('the hillshade as it is' if deg < 27 else 'its class colour at 70 % over the hillshade'), np.abs(got - want).max() < 10, (got.round(), want.round()))
    meta = json.loads(z.read('caves.json'))['meta']
    check('meta slope_map: the strength and the six classes, for the legend', meta.get('slope_map') == {'opacity': 0.7, 'classes': [[27.0, 'ffe600'], [30.0, 'ff9900'], [35.0, 'ff1a00'], [45.0, 'a020f0'], [50.0, '1f4fff'], [60.0, '000000']]}, meta.get('slope_map'))
    html = z.read('viewer.html').decode('utf-8')
    check('single file: the slope picture inline as TERRAIN_SLOPE_B64', base64.b64decode(const(html, 'TERRAIN_SLOPE_B64')) == z.read('tex_slope.jpg') and 'PLACEHOLDER_SLOPE_B64' not in html.replace("!== 'PLACEHOLDER_SLOPE_B64'", ''))
    check('the log says how much of the area is steep', re.search(r'Slope map: \d+x\d+ px, \d+ KB; \d+% of the area is 27 degrees or steeper', log) is not None, log[-400:])
    r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rebuild_viewer.py'), str(out), '-o', str(tmp / 'rebuilt.zip')], capture_output=True, text=True)
    check('rebuild_viewer keeps the slope picture', r.returncode == 0 and const(zipfile.ZipFile(tmp / 'rebuilt.zip').read('viewer.html').decode('utf-8'), 'TERRAIN_SLOPE_B64') == const(html, 'TERRAIN_SLOPE_B64'), r.stderr[-300:])

    # ── 2. strength, colours ─────────────────────────────────────────────────
    out2, _ = run('strong.zip', RIDGE + ['--slope-map', '--slope-opacity', '1', '--slope-colours', '00ff00,00ff00,00ff00,#0000FF,0000ff,ffffff'])
    z2 = zipfile.ZipFile(out2); s2 = Image.open(io.BytesIO(z2.read('tex_slope.jpg')))
    check('--slope-opacity 1 and --slope-colours: the strips take the given colours in full', np.abs(strip_rgb(s2, 1) - [0, 255, 0]).max() < 14 and np.abs(strip_rgb(s2, 4) - [0, 0, 255]).max() < 14 and np.abs(strip_rgb(s2, 6) - 255).max() < 14, [strip_rgb(s2, k).round() for k in (1, 4, 6)])
    m2 = json.loads(z2.read('caves.json'))['meta']
    check('…and the legend gets them', m2['slope_map']['opacity'] == 1.0 and m2['slope_map']['classes'][3] == [45.0, '0000ff'] and m2['about']['slope'] == {'opacity': 1.0})
    for bad in ('ff0000', 'red,red,red,red,red,red', 'ff0000,00ff00,0000ff,ffffff,000000'):
        o3, l3 = run('bad.zip', RIDGE + ['--slope-map', '--slope-colours', bad])
        check(f'--slope-colours {bad}: refused', not o3.exists() and 'six RRGGBB values' in l3, l3[-200:])
    out4, log4 = run('nohs.zip', RIDGE + ['--slope-map', '--hillshade', 'none'])
    z4 = zipfile.ZipFile(out4); s4 = Image.open(io.BytesIO(z4.read('tex_slope.jpg')))
    check('no hillshade in the export: the slope colours on plain grey', 'tex_hs.jpg' not in z4.namelist() and np.abs(strip_rgb(s4, 0) - 205).max() < 6 and np.abs(strip_rgb(s4, 3) - (0.3 * 205 + 0.7 * np.array(COL[40], float))).max() < 10, [strip_rgb(s4, k).round() for k in (0, 3)])

    # ── 3. tiled ─────────────────────────────────────────────────────────────
    real_plan = et.plan_tiles; et.plan_tiles = lambda w, h: (2, 2)
    outt, logt = run('tiled.zip', RIDGE + ['--slope-map'])
    et.plan_tiles = real_plan
    zt = zipfile.ZipFile(outt); nt = set(zt.namelist())
    tiles = {f'tex_{k}_{c}_{r}.jpg' for k in ('sat', 'hs', 'hsb', 'slope') for c in range(2) for r in range(2)}
    check('tiled: a slope tile for every hillshade tile, and the overview', tiles <= nt and 'tex_slope.jpg' in nt, sorted(tiles - nt))
    tt = json.loads(zt.read('caves.json'))['meta'].get('texture_tiles')
    check('tiled: meta texture_tiles names slope like hs', tt == {'cols': 2, 'rows': 2, 'sat': True, 'hs': True, 'hsb': True, 'slope': True}, tt)
    th = Image.open(io.BytesIO(zt.read('tex_hs_1_0.jpg'))); ts = Image.open(io.BytesIO(zt.read('tex_slope_1_0.jpg')))        # the north-east tile: the east half, strips 3.5 to 7
    a, g = np.asarray(ts).astype(float), np.asarray(th.convert('L')).astype(float)
    cx = lambda strip: int(((strip + 0.5) * STRIP - NX / 2) * a.shape[1] / (NX / 2))
    for strip, deg in ((4, 47), (5, 55), (6, 70)):
        want = 0.3 * g[40:60, cx(strip)].mean() + 0.7 * np.array(COL[deg], float)
        check(f'tiled: {deg} degrees in its colour on the tile', ts.size == th.size and np.abs(a[40:60, cx(strip)].mean(axis=0) - want).max() < 12, (a[40:60, cx(strip)].mean(axis=0).round(), want.round()))
    import tex_tiles
    check('tex_tiles: slope tile names are tiles', tex_tiles.TILE_RE.match('tex_slope_1_0.jpg').group(1) == 'slope' and tex_tiles.TILE_RE.match('tex_hsb_1_0.jpg').group(1) == 'hsb')

    # ── 4. a normal LiDAR export (its own DEM), map terrain, and an export without the map ──
    def fake_dem(x, y, z, resolution, csf_iterations=500, progress=print, extent=None, return_valid=False):
        e0, n0, e1, n1 = extent
        nxc, nyc = int(round((e1 - e0) / resolution)), int(round((n1 - n0) / resolution))
        deg = np.array(DEGS, float)[np.minimum(np.arange(nxc) * len(DEGS) // nxc, len(DEGS) - 1)]              # the same seven strips across this grid
        d = np.repeat((1100.0 + np.cumsum(np.tan(np.radians(deg)) * resolution))[:, None], nyc, axis=1)
        return d, e0 + np.arange(nxc + 1) * resolution, n0 + np.arange(nyc + 1) * resolution, 0, 0, np.ones((nxc, nyc), bool)
    et.build_dem = fake_dem
    et.fetch_ept_points = lambda *a, **k: (np.zeros(4), np.zeros(4), np.zeros(4), None, None, None, 'classified')
    et.build_lidar_hillshade = lambda x, y, z, grid, covered_m2, mode='classified', max_px=16384, progress=print: (Image.new('L', grid.tex_dims(420), 180), 0.5)
    outl, logl = run('lidar.zip', ['--ept', 'https://example.org/usgs/Cave_Ridge_3DEP/ept.json', '--resolution', '0.5', '--spike-threshold', '0', '--slope-map'])
    check('normal LiDAR export with the slope map written', outl.exists() and 'EXIT' not in logl, logl[-600:])
    if outl.exists():
        zl = zipfile.ZipFile(outl); sll = Image.open(io.BytesIO(zl.read('tex_slope.jpg'))); a = np.asarray(sll).astype(float)
        w = a.shape[1]; col = lambda k: a[a.shape[0] // 2 - 5:a.shape[0] // 2 + 5, int((k + 0.5) * w / len(DEGS))].mean(axis=0)
        check('from the export\'s own DEM: gentle ground plain, 40 degrees red, 70 black',
              np.abs(col(0) - 180).max() < 8 and np.abs(col(3) - (0.3 * 180 + 0.7 * np.array(COL[40], float))).max() < 12 and np.abs(col(6) - 0.3 * 180).max() < 12, [col(k).round() for k in (0, 3, 6)])
        al = json.loads(zl.read('caves.json'))['meta']['about']
        check('about, LiDAR export: terrain lidar, the dataset\'s name and not its link, the slope strength, no ridgewalking', al['terrain'] == 'lidar' and al['lidar'] == ['Cave_Ridge_3DEP'] and 'example.org' not in json.dumps(al)
              and al['slope'] == {'opacity': 0.7} and al['layers']['slope'] is True and al['layers']['hsb'] is False and 'ridge' not in al, al)
    lon = BBOX[0] - 0.001 + np.arange(40) * 0.0001; lat = BBOX[1] - 0.001 + np.arange(30) * 0.0001
    (1200 + 300 * (lat[:, None] - LAT) + 200 * (lon[None, :] - LON)).astype('<f4').tofile(tmp / 'dem.bin')
    (tmp / 'dem.json').write_text(json.dumps({'lon0': float(lon[0]), 'lat0': float(lat[0]), 'dlon': 0.0001, 'dlat': 0.0001, 'nx': 40, 'ny': 30, 'cell': 2.0, 'file': 'dem.bin'}))
    outm, logm = run('map.zip', ['--dem-grid', str(tmp / 'dem.json'), '--slope-map'])
    zm = zipfile.ZipFile(outm); hm = zm.read('viewer.html').decode('utf-8'); mm = json.loads(zm.read('caves.json'))['meta']
    check('map terrain: no slope map, and the log says why', 'tex_slope.jpg' not in zm.namelist() and const(hm, 'TERRAIN_SLOPE_B64') == '' and 'slope_map' not in mm and 'not made on map terrain' in logm, logm[-300:])
    check('about, map terrain: terrain map, no LiDAR named, slope not among the maps', mm['about']['terrain'] == 'map' and 'lidar' not in mm['about'] and mm['about']['layers']['slope'] is False and 'slope' not in mm['about'], mm['about'])
    outp, logp = run('plain.zip', ['--dem-grid', str(tmp / 'dem.json')])
    zp = zipfile.ZipFile(outp); hp = zp.read('viewer.html').decode('utf-8')
    check('an export without the slope map: the placeholder is an empty string, no file, no meta, the same file list as ever', const(hp, 'TERRAIN_SLOPE_B64') == '' and 'slope_map' not in json.loads(zp.read('caves.json'))['meta']
          and {n for n in zp.namelist() if not n.startswith('libs/')} == {'terrain.glb', 'tex_sat.jpg', 'tex_hs.jpg', 'caves.json', 'viewer.html', 'serve.bat', 'serve.sh', 'manifest.json'}, sorted(zp.namelist()))
    check('asking for the map on map terrain changes nothing in the viewer (byte for byte the plain one)', hm == hp)

    # ── 5. the card's facts, ridgewalking export ─────────────────────────────
    A = meta['about']
    check('about: when (the fixed clock), version 1', A['v'] == 1 and A['exported'] == time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(1795000000)), A.get('exported'))
    check('about: the area and its size', abs(A['area_km2'] - NX * CELL * NY * CELL / 1e6) < 1e-4 and A['size_m'] == [round(NX * CELL), round(NY * CELL)] and A['polygon'] is False, (A['area_km2'], A['size_m']))
    check('about: terrain ridge at 0.3 m; the two datasets by name, never a link or a path', A['terrain'] == 'ridge' and A['cell_m'] == 0.3 and A['lidar'] == ['Cave_Ridge_2021', 'Sink Valley 2019']
          and 'localhost' not in json.dumps(A) and 'C:' not in json.dumps(A), A.get('lidar'))
    check('about: the maps', A['layers'] == {'aerial': 'bing', 'hillshade': 'lidar', 'hsb': True, 'slope': True}, A['layers'])
    R = A['ridge']
    check('about: ridgewalking counts, the flagged pass of three, the settings that matter', R['counts']['features'] == 9 and R['counts']['true_cells'] == 31 and R['counts']['guessed_cells'] == 18 and R['counts']['pattern_noise'] == 96
          and R['passes'] == 3 and R['flagged'] == ['12'] and R['params'] == {'min_behind': 1.0, 'max_link': 12.0, 'link': 1.5, 'cell': 0.3} and R['shapes'] is False, R)
    check('about: brush and slope strength', A['brush'] == {'opacity': 0.7} and A['slope'] == {'opacity': 0.7})
    check('about: the FLEX commit, read from the checkout without git', A.get('flex', {}).get('commit', '') == ea.flex_commit(Path(__file__).resolve().parent.parent) and (not A.get('flex') or re.fullmatch(r'[0-9a-f]{12}', A['flex']['commit'])), A.get('flex'))
    try:
        g = subprocess.run(['git', '-C', str(Path(__file__).resolve().parent.parent), 'rev-parse', 'HEAD'], capture_output=True, text=True, timeout=10)
        if g.returncode == 0 and (Path(__file__).resolve().parent.parent / '.git').exists():       # (a copy without its .git sits inside some other checkout: git would name that one)
            check('…and it is the commit git names', ea.flex_commit(Path(__file__).resolve().parent.parent) == g.stdout.strip()[:12], g.stdout.strip()[:12])
    except Exception:
        pass
    check('flex_commit of a folder that is no checkout: empty, no error', ea.flex_commit(tmp) == '')
    (tmp / 'co' / '.git' / 'refs' / 'heads').mkdir(parents=True); (tmp / 'co' / '.git' / 'HEAD').write_text('ref: refs/heads/main\n'); (tmp / 'co' / '.git' / 'packed-refs').write_text('# pack-refs\n0123456789abcdef0123456789abcdef01234567 refs/heads/main\n')
    check('flex_commit: packed refs', ea.flex_commit(tmp / 'co') == '0123456789ab')
    (tmp / 'co' / '.git' / 'HEAD').write_text('fedcba9876543210fedcba9876543210fedcba98\n')
    check('flex_commit: a detached HEAD', ea.flex_commit(tmp / 'co') == 'fedcba987654')
    check('dataset names: the folder of ept.json, a COPC file\'s name, a Windows path; never the link', ea.dataset_name('http://h:8080/a/b/Cave_Ridge/ept.json?x=1') == 'Cave_Ridge' and ea.dataset_name('https://h/x/ridge.copc.laz') == 'ridge'
          and ea.dataset_name('C:\\lidar\\Sink Valley\\ept.json') == 'Sink Valley' and ea.dataset_name('') == '', [ea.dataset_name('https://h/x/ridge.copc.laz')])

    if keep:
        keep.mkdir(parents=True, exist_ok=True)
        (keep / 'slope.zip').write_bytes(out.read_bytes()); (keep / 'plain.zip').write_bytes(outp.read_bytes())
        with zipfile.ZipFile(outp) as zi, zipfile.ZipFile(keep / 'old.zip', 'w', zipfile.ZIP_DEFLATED) as zo:          # as an export from before the card: no `about`
            for info in zi.infolist():
                data = zi.read(info.filename)
                if info.filename == 'viewer.html': data = strip_about(data.decode('utf-8')).encode('utf-8')
                if info.filename == 'caves.json': c = json.loads(data); c['meta'].pop('about', None); data = json.dumps(c).encode('utf-8')
                zo.writestr(info, data)

print(f'{passes} passed, {fails} failed ({time.time() - T0:.1f} s)')
sys.exit(1 if fails else 0)
