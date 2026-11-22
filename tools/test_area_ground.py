#!/usr/bin/env python3
"""
area_ground.py on made-up clouds (numpy only, no PDAL, no network).

    python tools/test_area_ground.py

Scenes sit around the documentation example (45.1234, -100.5678). Pins down:
  * the ground follows a known slope (median of class 2) and stays close
    under a forest with few ground returns (cloth fills), never on canopy;
  * a pit whose floor is classed 7 is listed in pits.geojson (depth, count,
    class shares) while the ground over it is NOT lowered into it;
  * scattered multipath noise (single deep returns) gives no pit;
  * the file layout and grid.json of the contract, ground.npy row 0 south;
  * coverage: a ring larger than the points gives a NOTE and coverage < 1;
  * the points cache round-trips and respects its cap;
  * veg_shapes.py and the lidar_derive job through --area-dir give the same
    or better results than on their own; lidar_derive blanks cells outside
    the ring;
  * --demo runs; errors print a '! ' line and exit non-zero.
"""
import json, os, shutil, subprocess, sys, tempfile, time
HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, HERE)
import numpy as np
import area_ground as ag
import route_cost as rc
import lidar_derive as ld

fails = 0
passes = 0
T0 = time.time()


def check(label, ok, detail=''):
    global fails, passes
    if ok:
        passes += 1
    else:
        fails += 1
        print('FAIL', label, detail)


def cli(script, args):
    p = subprocess.run([sys.executable, os.path.join(HERE, script)] + args,
                       capture_output=True, text=True, timeout=600)
    return p.returncode, p.stdout + p.stderr


TMP = tempfile.mkdtemp(prefix='area_ground_')
E0, N0, ZONE = rc.example_origin()


def make_area(name, scene, ring=(0, 0, 160, 160), **extra):
    d = os.path.join(TMP, name)
    os.makedirs(d, exist_ok=True)
    x, y, z, c = scene
    npz = rc.write_npz(os.path.join(d, 'pts.npz'), x, y, z, c)
    prm = dict({'source': {'npz': npz}, 'area': ag.local_ring(*ring),
                'cell': 'auto', 'keep_points': True}, **extra)
    json.dump(prm, open(os.path.join(d, 'p.json'), 'w'))
    code, txt = cli('area_ground.py', ['--params', os.path.join(d, 'p.json'),
                                       '--area-dir', d])
    return d, code, txt


def ground_local(d):
    g, grid, m = ag.load_ground(d)
    return g, grid, m


def truth_on(grid):
    cx = grid.minx + (np.arange(grid.nx) + 0.5) * grid.cell - E0
    cy = grid.maxy - (np.arange(grid.ny) + 0.5) * grid.cell - N0
    X, Y = np.meshgrid(cx, cy)
    return X, Y, ag.demo_truth(X, Y)


# --- 1. slope + forest + class-7 pit + noise ------------------------------
d, code, txt = make_area('main', ag.demo_scene())
check('main run exits 0', code == 0, txt[-400:])
for f in ('ground.npy', 'grid.json', 'summary.json', 'pits.geojson',
          'coverage.png', 'direct.npy'):
    check(f'ground/{f} written', os.path.exists(os.path.join(d, 'ground', f)))
m = json.load(open(os.path.join(d, 'ground', 'grid.json')))
for k in ('x0', 'y0', 'cell', 'nx', 'ny', 'zone', 'south', 'epsg', 'bbox_utm', 'version'):
    check(f'grid.json has {k}', k in m)
raw = np.load(os.path.join(d, 'ground', 'ground.npy'))
check('ground.npy float32 ny x nx', raw.dtype == np.float32 and raw.shape == (m['ny'], m['nx']))
g, grid, _ = ground_local(d)
X, Y, T = truth_on(grid)
inner = (X > 3) & (X < 157) & (Y > 3) & (Y < 157)
cx, cy, r, dep = ag.DEMO_PIT
pitzone = np.hypot(X - cx, Y - cy) < r + 2
forest = (X > 92) & (X < 148) & (Y > 22) & (Y < 138)
open_ = inner & ~forest & ~pitzone
e = g - T
check('slope: ground within 0.1 m in the open (median |err|)',
      np.median(np.abs(e[open_])) < 0.1, np.median(np.abs(e[open_])))
check('slope: 99 % of open cells within 0.3 m', np.percentile(np.abs(e[open_]), 99) < 0.3,
      np.percentile(np.abs(e[open_]), 99))
check('forest (6 % ground returns): median |err| < 0.3 m',
      np.median(np.abs(e[forest])) < 0.3, np.median(np.abs(e[forest])))
check('forest: ground never on the canopy (max err < 2 m)', np.max(e[forest]) < 2.0,
      np.max(e[forest]))
# row 0 south: the raw file's first row is the south edge
check('ground.npy row 0 is south', np.allclose(raw[0], g[-1]) and np.allclose(raw[-1], g[0]))
pits = json.load(open(os.path.join(d, 'ground', 'pits.geojson')))['features']
check('pit with a class-7 floor found (exactly one)', len(pits) == 1, len(pits))
if pits:
    p = pits[0]['properties']
    u = np.array(p['utm']) - (E0, N0)
    check('pit at the right place', np.hypot(u[0] - cx, u[1] - cy) < 2.0, u)
    check('pit depth ~ true depth', 3.0 < p['depth'] < dep + 1.0, p['depth'])
    check('pit classes mostly 7', p['classes'].get('7', 0) > 0.5, p['classes'])
    check('pit count >= 10', p['count'] >= 10, p['count'])
    lon, lat = pits[0]['geometry']['coordinates']
    check('pit geometry lon/lat', -101 < lon < -100 and 45 < lat < 45.3)
cen = np.hypot(X - cx, Y - cy) < 1.0
# the floor (class 7) is dep below the slope; the class-2 rim reaches 3 m
# down (its outer 20 %): the ground may follow the rim, never the floor
check('ground NOT lowered into the pit floor (above floor + 2 m)',
      np.min(e[cen]) > -dep + 2.0, np.min(e[cen]))
check('ground over the pit no lower than its class-2 rim (-3 m) + 0.3',
      np.min(e[cen]) > -3.3, np.min(e[cen]))
s = json.load(open(os.path.join(d, 'ground', 'summary.json')))
for k in ('coverage', 'pits', 'cell', 'ring', 'notes', 'seconds'):
    check(f'summary.json has {k}', k in s)
check('summary pits = 1', s['pits'] == 1)
check('coverage 1 when the points fill the ring', s['coverage'] > 0.99, s['coverage'])
check('NOTE line for the pit', any(l.startswith('NOTE: 1 possible pit') for l in txt.splitlines()), txt)
check('no coverage NOTE when covered', 'LiDAR covers' not in txt)
check('progress lines [i/n]', '[1/4]' in txt and '[4/4]' in txt)
check('ASCII only', all(ord(ch) < 128 for ch in txt))

# points cache
P = ag.load_points(d)
x, y, z, c = ag.demo_scene()
check('points cache round-trips', P is not None and len(P) == len(z), None if P is None else len(P))
pm = json.load(open(os.path.join(d, 'points', 'points.json')))
check('points.json size = 13 bytes a point', pm['bytes'] == 13 * len(z))
sub = ag.load_points(d, (E0 + 10, N0 + 10, E0 + 50, N0 + 50))
check('points cache crops to a smaller box', sub is not None and 0 < len(sub) < len(z) / 5,
      None if sub is None else len(sub))

# --- 2. noise only: no pits ----------------------------------------------
d2, code, txt = make_area('noise', ag.demo_scene(seed=9, pit=None))
s2 = json.load(open(os.path.join(d2, 'ground', 'summary.json')))
check('multipath noise only: no pit', code == 0 and s2['pits'] == 0, (code, s2.get('pits'), txt[-300:]))
check('noise only: no pit NOTE', not any(l.startswith('NOTE:') and 'pit' in l for l in txt.splitlines()))

# --- 3. ring larger than the points: coverage NOTE; cap 0 keeps no points -
d3, code, txt = make_area('cover', ag.demo_scene(seed=4, pit=None, noise=False),
                          ring=(0, 0, 240, 160), points_cap_mb=0)
s3 = json.load(open(os.path.join(d3, 'ground', 'summary.json')))
check('coverage ~ 2/3', code == 0 and 0.6 < s3['coverage'] < 0.72, s3.get('coverage'))
check('coverage NOTE', any(l.startswith('NOTE: LiDAR covers') for l in txt.splitlines()), txt)
check('cap 0: no points cache', not os.path.exists(os.path.join(d3, 'points')))
check('cap 0: load_points None', ag.load_points(d3) is None)

# --- 4. errors ------------------------------------------------------------
x, y, z, c = ag.demo_scene(seed=2, pit=None, noise=False)
d4, code, txt = make_area('noclass', (x, y, z, np.ones_like(c)))
check('no ground class: exit 1 with "! "', code == 1 and '! ' in txt, txt[-300:])
code, txt = cli('area_ground.py', ['--demo', os.path.join(TMP, 'demo')])
check('--demo runs', code == 0 and os.path.exists(os.path.join(TMP, 'demo', 'ground', 'pits.geojson')), txt[-300:])

# --- 5. veg_shapes through --area-dir ------------------------------------
import veg_shapes as vs
vd = os.path.join(TMP, 'veg')
code, txt = cli('veg_shapes.py', ['--demo', os.path.join(vd, 'plain')])
check('veg demo runs', code == 0, txt[-300:])
vp = json.load(open(os.path.join(vd, 'plain', 'params.json')))
json.dump({'source': vp['source'], 'area': vp['area'], 'cell': 'auto'},
          open(os.path.join(vd, 'gp.json'), 'w'))
code, txt = cli('area_ground.py', ['--params', os.path.join(vd, 'gp.json'), '--area-dir', vd])
check('area ground on the veg scene', code == 0, txt[-300:])
vp2 = dict(vp); vp2.pop('source')
json.dump(vp2, open(os.path.join(vd, 'vp.json'), 'w'))
code, txt = cli('veg_shapes.py', ['--params', os.path.join(vd, 'vp.json'),
                                  '--area-dir', vd, '--out', os.path.join(vd, 'veg')])
check('veg_shapes --area-dir runs (no source: the area points)', code == 0, txt[-400:])
check('veg uses the area ground and points', "Ground (the area's)" in txt and "area's cache" in txt, txt[:400])
if code == 0:
    a = json.load(open(os.path.join(vd, 'plain', 'veg.json')))
    b = json.load(open(os.path.join(vd, 'veg', 'veg.json')))
    truth, _o = vs.write_scene_npz(os.path.join(TMP, 'scene.npz'))
    na = a['counts']['trees'] if 'counts' in a else None

    def trees_found(path):
        recs = np.fromfile(os.path.join(path, 'shapes.bin'), np.float32).reshape(-1, 12)
        return recs
    ra, rb = trees_found(os.path.join(vd, 'plain')), trees_found(os.path.join(vd, 'veg'))
    ta, tb = (ra[:, 3] > 3).sum(), (rb[:, 3] > 3).sum()
    check('veg: same tree count within 1 (area-dir vs own ground)', abs(int(ta) - int(tb)) <= 1, (ta, tb))
    ha, hb = np.sort(ra[ra[:, 3] > 3, 3]), np.sort(rb[rb[:, 3] > 3, 3])
    if len(ha) == len(hb):
        check('veg: tree heights within 0.3 m', np.max(np.abs(ha - hb)) < 0.3, np.max(np.abs(ha - hb)))
    gb = np.fromfile(os.path.join(vd, 'veg', 'ground.bin'), np.float32)
    check('veg ground.bin NaN-free', np.isfinite(gb).all())

# --- 6. lidar_derive job through --area-dir ------------------------------
ring = s['ring']
bb = [min(p[0] for p in ring), min(p[1] for p in ring), max(p[0] for p in ring), max(p[1] for p in ring)]
npz = os.path.join(d, 'pts.npz')
code, txt = cli('lidar_derive.py', ['--points-npz', npz, '--bbox'] + [str(v) for v in bb]
                + ['--out-dir', os.path.join(d, 'bush_plain')])
check('lidar_derive on its own runs (--points-npz)', code == 0, txt[-300:])
code, txt = cli('lidar_derive.py', ['--ept', 'http://example.invalid/ept.json', '--bbox']
                + [str(v) for v in bb] + ['--area-dir', d, '--out-dir', os.path.join(d, 'bush')])
check('lidar_derive --area-dir runs (points from the cache, ept unused)', code == 0, txt[-300:])


def read_tif(path):
    try:
        from PIL import Image
        return np.array(Image.open(path), np.float32)
    except Exception:
        import tifffile
        return tifffile.imread(path).astype(np.float32)


try:
    va = read_tif(os.path.join(d, 'bush_plain', 'voids.tif'))
    vb = read_tif(os.path.join(d, 'bush', 'voids.tif'))
    ja = json.load(open(os.path.join(d, 'bush_plain', 'derived.json')))
    jb = json.load(open(os.path.join(d, 'bush', 'derived.json')))
    check('derived.json written with --area-dir', jb.get('area_dir') is True)

    def pit_cells(v, j):
        gt = j['geotransform']
        ny, nx = v.shape
        xs = gt[0] + (np.arange(nx) + 0.5) * gt[1] - E0
        ys = gt[3] + (np.arange(ny) + 0.5) * gt[5] - N0
        XX, YY = np.meshgrid(xs, ys)
        near = np.hypot(XX - cx, YY - cy) < r
        return int((np.isfinite(v) & near).sum()), int((np.isfinite(v) & ~near & (np.hypot(XX - cx, YY - cy) > r + 3)).sum())
    pa, fa = pit_cells(va, ja)
    pb, fb = pit_cells(vb, jb)
    check('bush: the class-7 pit shows as voids at least as well', pb >= pa and pb >= 5, (pa, pb))
    check('bush: no more false voids away from the pit', fb <= fa + 2, (fa, fb))
    ga = read_tif(os.path.join(d, 'bush_plain', 'vegetation.tif'))
    gb_ = read_tif(os.path.join(d, 'bush', 'vegetation.tif'))
    if ga.shape == gb_.shape:
        ok = np.isfinite(ga) & np.isfinite(gb_)
        check('bush: vegetation fraction the same (median diff < 0.03)',
              np.median(np.abs(ga[ok] - gb_[ok])) < 0.03, np.median(np.abs(ga[ok] - gb_[ok])))
    # a triangle ring: cells outside blank
    tri = ag.local_ring(0, 0, 160, 160)[:3] + [ag.local_ring(0, 0, 160, 160)[0]]
    code, txt = cli('lidar_derive.py', ['--area-dir', d, '--area', json.dumps(tri),
                                        '--out-dir', os.path.join(d, 'bush_tri')])
    check('lidar_derive --area triangle runs', code == 0, txt[-300:])
    vt = read_tif(os.path.join(d, 'bush_tri', 'vegetation.tif'))
    fin = np.isfinite(vt).mean()
    check('cells outside the ring are blank (about half)', 0.4 < fin < 0.6, fin)
except Exception as ex:
    check('reading the bush rasters', False, repr(ex))

# --- 7. tiled reading: child processes, retries, resume, same result ------
os.environ['FLEX_AREA_RETRY_S'] = '0,0,0'
x, y, z, c = ag.demo_scene()
td = os.path.join(TMP, 'tiles')
os.makedirs(td)
tnpz = rc.write_npz(os.path.join(td, 'pts.npz'), x, y, z, c)
tring = ag.local_ring(0, 0, 160, 160)
quiet = lambda m: None
ref = ag.run({'source': {'npz': tnpz}, 'area': tring, 'cell': 1.0}, os.path.join(td, 'single'), say=quiet)


def tiled_cli(name, env=None, extra=None):
    d = os.path.join(td, name)
    os.makedirs(d, exist_ok=True)
    prm = dict({'source': {'npz': tnpz}, 'area': tring, 'cell': 1.0, 'tiled': True,
                'tile_m': 50}, **(extra or {}))
    json.dump(prm, open(os.path.join(d, 'p.json'), 'w'))
    e = dict(os.environ, **(env or {}))
    p = subprocess.run([sys.executable, os.path.join(HERE, 'area_ground.py'), '--params',
                        os.path.join(d, 'p.json'), '--area-dir', d],
                       capture_output=True, text=True, timeout=600, env=e)
    return d, p.returncode, p.stdout + p.stderr


g_ref = np.load(os.path.join(td, 'single', 'ground', 'ground.npy'))
pits_ref = json.load(open(os.path.join(td, 'single', 'ground', 'pits.geojson')))
d, code, txt = tiled_cli('plain')
check('tiled run exits 0', code == 0, txt[-400:])
check('tiled: progress "[1/4] reading tile i/n"', '[1/4] reading tile 16/16' in txt, txt[:600])
check('tiled: ground identical to the single pass',
      np.array_equal(np.load(os.path.join(d, 'ground', 'ground.npy')), g_ref))
check('tiled: pits identical to the single pass',
      json.load(open(os.path.join(d, 'ground', 'pits.geojson'))) == pits_ref)
st = json.load(open(os.path.join(d, 'ground', 'summary.json')))
check('tiled: summary tiles and chunk store', st['tiles']['tiles'] == 16 and st['tiles']['failed'] == 0
      and st['points_store'] == 'chunks', st.get('tiles'))
Pc = ag.load_points(d)
check('chunk store reads back (lazy, all points)', Pc is not None and len(Pc) == len(z))
sub = ag.load_points(d, (E0 + 10, N0 + 10, E0 + 50, N0 + 50))
nsub = sum(len(a[0]) for a in sub.chunks())
check('chunk store crops to a box', 0 < nsub < len(z) / 5 and len(sub.z) == nsub, nsub)

# a tile whose child aborts twice, then succeeds
d, code, txt = tiled_cli('flaky', {'FLEX_AREA_TEST_ABORT': '5:2'})
check('aborting child retried: exit 0', code == 0, txt[-400:])
check('aborting child: two failed tries reported', txt.count('tile 6: try') == 2, txt[-600:])
check('aborting child: same ground in the end',
      np.array_equal(np.load(os.path.join(d, 'ground', 'ground.npy')), g_ref))
check('aborting child: no NOTE about unread tiles', 'could not be read' not in txt)

# a tile that always fails: NOTE, gap in coverage, exit 0 (1 of 16 <= 25 %)
d, code, txt = tiled_cli('dead', {'FLEX_AREA_TEST_ABORT': '5:99'})
st = json.load(open(os.path.join(d, 'ground', 'summary.json'))) if code == 0 else {}
check('one dead tile: exit 0', code == 0, txt[-400:])
check('one dead tile: NOTE', any(l.startswith('NOTE: LiDAR could not be read for 1 of 16 tiles')
                                 for l in txt.splitlines()), txt[-600:])
check('one dead tile: coverage gap', 0.85 < st.get('coverage', 0) < 0.97, st.get('coverage'))
check('one dead tile: coverage NOTE too', 'NOTE: LiDAR covers' in txt)
# too many dead tiles: exit 1 with "! ", chunks kept for a later run
d, code, txt = tiled_cli('dead5', {'FLEX_AREA_TEST_ABORT': '1:99,2:99,5:99,6:99,9:99'})
check('5 of 16 dead (> 25 %): exit 1 with "! "', code == 1 and any(l.startswith('! ') and 'could not be read for 5 of 16' in l for l in txt.splitlines()),
      txt[-400:])
check('5 dead: no ground written', not os.path.exists(os.path.join(d, 'ground', 'ground.npy')))
# ... and a second run with the network back resumes: only those 5 are read
d2, code, txt = tiled_cli('dead5')
check('resume: exit 0', code == 0, txt[-400:])
check('resume: 11 tiles already on disk', '11 of 16 tiles already on disk' in txt, txt[:400])
check('resume: reads only the missing ones', '[1/4] reading tile 16/16' in txt and '[1/4] reading tile 11/16' not in txt,
      txt[:800])
check('resume: ground identical', np.array_equal(np.load(os.path.join(d2, 'ground', 'ground.npy')), g_ref))

# interrupted run (stopped after 6 tiles) leaves a partial file: detected and redone
d, code, txt = tiled_cli('stop', extra={'_stop_after': 6})
check('interrupted run exits 1', code == 1, txt[-300:])
cd_ = os.path.join(d, 'points', 'chunks')
done6 = sorted(f for f in os.listdir(cd_) if f.endswith('.json') and f.startswith('t'))
check('6 tiles on disk after the interruption', len(done6) == 6, done6)
np.save(os.path.join(cd_, 't0006.xl.npy'), np.zeros(5, np.float32))      # a half-written tile
os.remove(os.path.join(cd_, 't0002.z.npy'))                              # a damaged one
d, code, txt = tiled_cli('stop', extra={'_stop_after': None})
check('resume after interruption: exit 0', code == 0, txt[-300:])
check('resume after interruption: the damaged tile is read again', '5 of 16 tiles already on disk' in txt, txt[:300])
check('resume after interruption: ground identical',
      np.array_equal(np.load(os.path.join(d, 'ground', 'ground.npy')), g_ref))
# veg_shapes and lidar_derive read the chunk store through --area-dir
d = os.path.join(td, 'plain')
code, txt = cli('lidar_derive.py', ['--area-dir', d, '--out-dir', os.path.join(d, 'bush')])
check('lidar_derive --area-dir on the chunk store', code == 0 and "area's cache" in txt, txt[-300:])
vp = {'looks': ['shapes'], 'detail': 'medium'}
json.dump(vp, open(os.path.join(d, 'vp.json'), 'w'))
code, txt = cli('veg_shapes.py', ['--params', os.path.join(d, 'vp.json'), '--area-dir', d,
                                  '--out', os.path.join(d, 'veg')])
check('veg_shapes --area-dir on the chunk store', code == 0 and "area's cache" in txt, txt[-300:])


shutil.rmtree(TMP, ignore_errors=True)
print(f'test_area_ground: {passes} passed, {fails} failed ({time.time() - T0:.1f} s)')
sys.exit(1 if fails else 0)
