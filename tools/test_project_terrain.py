"""Project terrain (export_terrain.py --project-terrain): the terrain patch
.bin and the hillshade map tiles, from synthetic ground points (no PDAL, no
network). Made-up place and shapes only.

    python tools/test_project_terrain.py [OUT_DIR]

With OUT_DIR the result is kept there (the browser test uses it as a fixture).
"""
import json, math, struct, sys, tempfile
from pathlib import Path
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import export_terrain as et

passes, fails = 0, []
def ok(label, cond, info=''):
    global passes
    if cond:
        passes += 1
    else:
        fails.append(label)
        print('FAIL', label, info)

# 1) The array UTM matches the scalar one.
rng = np.random.default_rng(3)
la = rng.uniform(30, 48, 50); lo = rng.uniform(-123, -117, 50)
E, N = et.latlon_to_utm_np(la, lo, 11)
ref = np.array([et.latlon_to_utm(a, b, 11)[:2] for a, b in zip(la, lo)])
ok('array UTM == scalar UTM', np.abs(E - ref[:, 0]).max() < 1e-6 and np.abs(N - ref[:, 1]).max() < 1e-6)

# 2) A synthetic ground: a tilted plane with a gentle wave and a round pit, in
# the UTM zone of a made-up spot; points over the area except a strip in the
# east the "dataset" doesn't reach.
LON0, LAT0 = -119.99, 37.995
zone = et.utm_zone_for(LON0)
e0, n0, _ = et.latlon_to_utm(LAT0, LON0, zone)
PIT = (e0 + 40.0, n0 - 20.0)            # the pit's centre (UTM)
def surface(e, n):
    de, dn = e - e0, n - n0
    r = np.hypot(e - PIT[0], n - PIT[1])
    return 500.0 + 0.08 * de - 0.03 * dn + 1.5 * np.sin(de / 35.0) - 6.0 * np.clip(1 - r / 15.0, 0, 1)
x = rng.uniform(e0 - 230, e0 + 230, 900_000)
y = rng.uniform(n0 - 180, n0 + 180, 900_000)
gap = x > e0 + 150                       # no data east of here
x, y = x[~gap], y[~gap]
z = surface(x, y)
# The area: a concave polygon (a notch on its north side), lon/lat.
ring_m = [(-180, -140), (190, -140), (190, 140), (60, 140), (60, 40), (-40, 40), (-40, 140), (-180, 140)]
def to_ll(de, dn):
    lat, lon = et.utm_to_latlon(e0 + de, n0 + dn, zone)
    return [float(lon), float(lat)]
poly = [to_ll(a, b) for a, b in ring_m]
Z_OFF = -24.512
out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix='ptest_'))
res = et.project_terrain(x, y, z, 'classified', out, None, poly_ll=poly, resolution=0.5,
                         z_offset=Z_OFF, name='Test terrain', progress=lambda m: None)

# 3) The terrain patch file
data = (out / 'terrain.bin').read_bytes()
hl = struct.unpack('<I', data[:4])[0]
meta, grid = et.read_terrain_patch(data)
ok('header is a FLEX terrain patch', meta.get('format') == 'flex-terrain-patch' and meta.get('version') == 2, meta)
ok('grid starts on a 4-byte boundary', (4 + hl) % 4 == 0, hl)
ok('file size = header + nx*ny floats', len(data) == 4 + hl + meta['nx'] * meta['ny'] * 4, (len(data), meta['nx'], meta['ny']))
pl = np.array(poly)
ok('bounds are the area’s', abs(meta['west'] - pl[:, 0].min()) < 1e-9 and abs(meta['north'] - pl[:, 1].max()) < 1e-9, meta)
ok('posts about 0.5 m apart, under the cap', 0.45 < meta['cell_m'] < 0.56 and max(meta['nx'], meta['ny']) <= et.PATCH_MAX_SIDE, meta)
ok('datum shift recorded', meta.get('datum_shift_m') == round(Z_OFF, 3) and meta.get('name') == 'Test terrain', meta)
dlon = (meta['east'] - meta['west']) / (meta['nx'] - 1); dlat = (meta['north'] - meta['south']) / (meta['ny'] - 1)
def post(de, dn):
    lon, lat = to_ll(de, dn)
    i = int(round((lon - meta['west']) / dlon)); j = int(round((meta['north'] - lat) / dlat))
    plon, plat = meta['west'] + i * dlon, meta['north'] - j * dlat
    pe, pn = et.latlon_to_utm(plat, plon, zone)[:2]
    return float(grid[j, i]), float(surface(pe, pn))
errs = []
for de, dn in [(-150, -100), (0, 0), (100, -60), (-100, 100), (120, 100), (-20, -120)]:
    h, true = post(de, dn)
    errs.append(h - (true + Z_OFF))
ok('heights = ground + z_offset (within 0.3 m)', max(abs(e) for e in errs) < 0.3, errs)
h, true = post(PIT[0] - e0, PIT[1] - n0)
rim = post(PIT[0] - e0 + 20, PIT[1] - n0)[0]
ok('the pit is in the terrain', abs(h - (true + Z_OFF)) < 0.5 and rim - h > 4, (h, true, rim))
ok('outside the polygon (the notch): no data', math.isnan(post(10, 100)[0]))
ok('where the dataset ends: no data', math.isnan(post(175, 0)[0]))
ok('min/max are the kept heights', abs(meta['min'] - float(np.nanmin(grid))) < 1e-3 and abs(meta['max'] - float(np.nanmax(grid))) < 1e-3)

# The cap: a big area is held to max_side posts a side.
dem = np.zeros((4000, 10)); xb = np.arange(4001) * 1.0; yb = np.arange(11) * 1.0
m2, g2 = et.terrain_patch_grid(dem + 1, xb + e0, yb + n0, 1.0, zone, False,
                               [LON0, LAT0, LON0 + 0.045, LAT0 + 0.00008], max_side=3000)
ok('grid capped at 3000 a side', m2['nx'] == 3000 and g2.shape == (m2['ny'], 3000), (m2['nx'], m2['ny']))

# A big area keeps its resolution: cut into overlapping patches of at most max_side posts on one lattice.
yb_big = np.arange(601) - 300.0                    # the box is tilted in UTM (grid convergence): a tall DEM reaches it all along
dem_big = (np.arange(4000)[:, None] * 0.01 + np.zeros((4000, 600))) + 100.0       # rises 0.01 m per cell eastwards
box_big = [LON0, LAT0, LON0 + 0.045, LAT0 + 0.00008]
parts = list(et.terrain_patch_tiles(dem_big, xb + e0, yb_big + n0, 1.0, zone, False, box_big))
ok('big area: two patches, none over 3000 a side', len(parts) == 2 and all(max(m['nx'], m['ny']) <= 3000 for m, _ in parts), [(m['nx'], m['ny']) for m, _ in parts])
ok('big area: posts keep ~1 m', all(0.9 < m['cell_m'] < 1.15 for m, _ in parts), [m['cell_m'] for m, _ in parts])
(ma, ga), (mb, gb) = parts
ov_m = (ma['east'] - mb['west']) * 111320 * math.cos(math.radians(LAT0))
ok('big area: overlap about 150 m, numbered parts', 140 < ov_m < 175 and ma['part'] == 1 and mb['part'] == 2, ov_m)
ok('big area: together they reach both ends', abs(ma['west'] - box_big[0]) < 1e-9 and abs(mb['east'] - box_big[2]) < 1e-9)
dl = (ma['east'] - ma['west']) / (ma['nx'] - 1)
ok('big area: one lattice (a post of the second is a post of the first)', abs(((mb['west'] - ma['west']) / dl + 0.5) % 1 - 0.5) < 1e-6)
j = ga.shape[0] // 2; x_of = lambda m, i: m['west'] + i * (m['east'] - m['west']) / (m['nx'] - 1)
ia = ga.shape[1] - 5; ib = int(round((x_of(ma, ia) - mb['west']) / dl))
ok('big area: the same ground in the overlap', abs(float(ga[j, ia]) - float(gb[j, ib])) < 0.02 and np.isfinite(ga[j, ia]), (ga[j, ia], gb[j, ib]))
huge = et.plan_patches([LON0, LAT0, LON0 + 0.4, LAT0 + 0.4], 0.5)
ok('huge area: at most 9 patches, posts widened to fit', len(huge['tiles']) <= et.PATCH_MAX_TILES and huge['cell_m'] > 0.5, (len(huge['tiles']), huge['cell_m']))
ok('1 km: one patch at the asked resolution', et.plan_patches([LON0, LAT0, LON0 + 0.011, LAT0 + 0.009], 0.5)['cell_m'] == 0.5)
ok('result.json lists the patches', [p['file'] for p in res['terrain_tiles']] == ['terrain.bin'] and res['terrain_tiles'][0]['nx'] == meta['nx'])

# 4) The tiles
T = json.loads((out / 'tiles' / 'tiles.json').read_text())
zmin, zmax = T['minzoom'], T['maxzoom']
ok('tiles.json: xyz pyramid with bounds', T['format'] == 'flex-tiles' and len(T['bounds']) == 4 and zmin <= zmax, T)
mpp = 156543.034 * math.cos(math.radians(LAT0)) / 2 ** zmax
ok('finest level at least as fine as the hillshade', mpp <= T['cell_m'] + 1e-9 and mpp > T['cell_m'] / 2, (mpp, T['cell_m']))
for zz in range(zmin, zmax + 1):
    x0, y0, x1, y1 = et.tile_range(T['bounds'], zz)
    n = sum(1 for tx in range(x0, x1 + 1) for ty in range(y0, y1 + 1) if (out / 'tiles' / str(zz) / str(tx) / f'{ty}.png').exists())
    ok(f'zoom {zz} has tiles', n > 0, zz)
x0, y0, x1, y1 = et.tile_range(T['bounds'], zmin)
ok('coarsest level is at most 4 tiles', (x1 - x0 + 1) * (y1 - y0 + 1) <= 4, (zmin, x0, y0, x1, y1))
ok('result.json names both', res['terrain']['nx'] == meta['nx'] and res['tiles']['maxzoom'] == zmax)

def pixel_ll(tx, ty, z, px, py):
    n = 2.0 ** z
    lon = (tx + (px + 0.5) / 256) / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (ty + (py + 0.5) / 256) / n))))
    return lon, lat
def inside_poly(lon, lat):
    c = False
    for (xi, yi), (xj, yj) in zip(poly, poly[-1:] + poly[:-1]):
        if (xi <= lon) != (xj <= lon) and lat >= yi + (lon - xi) * (yj - yi) / (xj - xi):
            c = not c
    return c
gap_lon = to_ll(150, 0)[0]
agree = total = outside_clear = outside_n = gap_clear = gap_n = 0
x0, y0, x1, y1 = et.tile_range(T['bounds'], zmax)
for tx in range(x0, x1 + 1):
    for ty in range(y0, y1 + 1):
        f = out / 'tiles' / str(zmax) / str(tx) / f'{ty}.png'
        if not f.exists():
            continue
        A = np.asarray(Image.open(f).convert('LA'))[:, :, 1]
        for py in range(4, 256, 12):
            for px in range(4, 256, 12):
                lon, lat = pixel_ll(tx, ty, zmax, px, py)
                e, nn = et.latlon_to_utm(lat, lon, zone)[:2]
                # the distance to the polygon's edge, in metres: skip the line itself
                d = float(et.polygon_edge_distance(np.array([e]), np.array([nn]), et.polygon_to_utm(np.array(poly), zone))[0])
                if d < 2.0 or abs(e - (e0 + 150)) < 8:
                    continue
                ins = inside_poly(lon, lat)
                if lon > gap_lon:
                    gap_n += 1; gap_clear += A[py, px] == 0
                    continue
                total += 1; agree += (A[py, px] > 0) == ins
                if not ins:
                    outside_n += 1; outside_clear += A[py, px] == 0
ok('tiles are georeferenced: shown exactly inside the area (≥99%)', total > 200 and agree / total >= 0.99, (agree, total))
ok('transparent outside the area', outside_n > 20 and outside_clear == outside_n, (outside_clear, outside_n))
ok('transparent where the data ends', gap_n > 10 and gap_clear == gap_n, (gap_clear, gap_n))

# The pit shows where it is: strong shading contrast within 12 m of its centre, little on the plain.
def shade_near(de, dn, r=12):
    lon0, lat0 = to_ll(de, dn)
    vals = []
    for tx in range(x0, x1 + 1):
        for ty in range(y0, y1 + 1):
            f = out / 'tiles' / str(zmax) / str(tx) / f'{ty}.png'
            if not f.exists():
                continue
            LA = np.asarray(Image.open(f).convert('LA')).astype(float)
            for py in range(0, 256, 2):
                for px in range(0, 256, 2):
                    lon, lat = pixel_ll(tx, ty, zmax, px, py)
                    if abs(lon - lon0) * 111320 * math.cos(math.radians(lat0)) < r and abs(lat - lat0) * 110540 < r and LA[py, px, 1] > 0:
                        vals.append(LA[py, px, 0])
    return np.std(vals) if vals else 0
s_pit, s_plain = shade_near(PIT[0] - e0, PIT[1] - n0), shade_near(-120, -100)
ok('the pit shows in the hillshade where it is', s_pit > 3 * max(s_plain, 1.0), (s_pit, s_plain))

# A coarser tile is the finer level halved: its alpha covers the same ground.
zc = zmax - 1
x0c, y0c, x1c, y1c = et.tile_range(T['bounds'], zc)
f = next((out / 'tiles' / str(zc) / str(tx) / f'{ty}.png' for tx in range(x0c, x1c + 1) for ty in range(y0c, y1c + 1)
          if (out / 'tiles' / str(zc) / str(tx) / f'{ty}.png').exists()), None)
ok('coarser tile is grey + alpha, 256 px', f is not None and Image.open(f).mode == 'LA' and Image.open(f).size == (256, 256))

# 5) The command line (what the server runs), with the PDAL read stubbed by
# synthetic points: two datasets, a bbox, the shift passed through.
calls = []
def fake_fetch(ept, utm_bbox, bbox_latlon=None, progress=print, zone=None, south=False, with_mode=False):
    calls.append((ept, zone))
    r = np.random.default_rng(len(calls))
    xs = r.uniform(utm_bbox[0], utm_bbox[2], 60_000); ys = r.uniform(utm_bbox[1], utm_bbox[3], 60_000)
    c = np.zeros(len(xs), np.uint8)
    return xs, ys, surface(xs, ys), c, c, c, ('classified' if len(calls) == 1 else 'smrf')
real_fetch, et.fetch_ept_points = et.fetch_ept_points, fake_fetch
cli_out = Path(tempfile.mkdtemp(prefix='ptcli_'))
w, s = to_ll(-60, -50); e, n = to_ll(60, 50)
argv0 = sys.argv
sys.argv = ['export_terrain.py', '--ept', 'https://example.invalid/a/ept.json', '--also-ept', 'https://example.invalid/b/ept.json',
            '--bbox', str(w), str(s), str(e), str(n), '--resolution', '1.0', '--z-offset', '-10', '--name', 'CLI terrain',
            '--project-terrain', str(cli_out)]
try:
    import contextlib, io
    with contextlib.redirect_stdout(io.StringIO()):
        et.main()
finally:
    sys.argv = argv0; et.fetch_ept_points = real_fetch
R = json.loads((cli_out / 'result.json').read_text())
m3, g3 = et.read_terrain_patch((cli_out / 'terrain.bin').read_bytes())
ok('CLI: both datasets read, in the area’s zone', [c[0].split('/')[-2] for c in calls] == ['a', 'b'] and all(c[1] == zone for c in calls), calls)
ok('CLI: z offset and name passed through', R['z_offset'] == -10 and m3['name'] == 'CLI terrain' and R['ground'] == 'smrf', R)
ok('CLI: bbox area fully covered, 1 m posts', np.isfinite(g3).mean() > 0.99 and 0.9 < m3['cell_m'] < 1.1, (np.isfinite(g3).mean(), m3['cell_m']))
h3 = float(g3[m3['ny'] // 2, m3['nx'] // 2]); clat = (m3['south'] + m3['north']) / 2; clon = (m3['west'] + m3['east']) / 2
ce, cn = et.latlon_to_utm(clat, clon, zone)[:2]
ok('CLI: heights shifted by -10', abs(h3 - (float(surface(ce, cn)) - 10)) < 0.6, (h3, float(surface(ce, cn))))
ok('CLI: tiles written', (cli_out / 'tiles' / 'tiles.json').exists())

print(f'{passes} passed, {len(fails)} failed')
sys.exit(1 if fails else 0)
