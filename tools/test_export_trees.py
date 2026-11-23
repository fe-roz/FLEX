#!/usr/bin/env python3
"""
Trees and brush in an export (export_terrain.py --trees, export_trees.py). No PDAL, no network.

  * the vegetation step's records become trees.bin (FTR1, 20 bytes a tree): the kinds (brush mounds and low
    crowns -> mound, a tapering crown -> cone, else round), the foot on the export's own ground, radius in cm,
    a steady tint; trees outside a polygon are left out; the detail level follows the count;
  * the vegetation step runs as a child process in tiles (here a stand-in script that writes veg_shapes.py's
    own made-up scene for each tile): crowns on a tile line are kept once;
  * the zip carries trees.bin + trees.json, the single-file viewer.html has TREES with the file inline and
    trees.js inlined, tools/rebuild_viewer.py keeps it; with veg_shapes.py's real demo folder as --trees-dir;
  * an export without them is as it was: TREES is null, no trees.bin; a failing vegetation step leaves the
    trees out and the export is still made.

    python tools/test_export_trees.py [--keep DIR]     (--keep: leave trees.zip and plain.zip there, to look at)
"""
import base64, io, json, math, os, re, subprocess, sys, tempfile, time, zipfile
os.environ['SOURCE_DATE_EPOCH'] = '1795000000'       # a fixed export time, so two exports of the same thing are the same bytes
from pathlib import Path
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, ROOT)
import numpy as np
from PIL import Image
import export_terrain as et
import export_trees as xt
import viewer_inline as vi
import veg_shapes as vs
import route_cost as rc

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

# ── 1. Records -> kinds, the file ─────────────────────────────────────────────
#        x  y  zg   h    r   base kind dens  r1   r2   r3   r4        (kind: 0 dome, 1 cone, 2 brush)
recs = np.array([
    [0, 0, 100, 20.0, 3.0, 4, 1, .8, 1.0, 0.8, 0.5, 0.2],            # a spruce: cone
    [10, 0, 100, 15.0, 5.0, 3, 0, .8, 0.7, 1.0, 0.9, 0.5],           # a broadleaf: round
    [20, 0, 100, 12.0, 6.0, 5, 0, .8, 0.3, 0.6, 1.0, 0.7],           # an umbrella: round
    [30, 0, 100, 18.0, 2.5, 2, 1, .8, 0.9, 1.0, 0.85, 0.4],          # a column the step calls a cone: cone
    [40, 0, 100, 16.0, 2.5, 2, 1, .8, 0.5, 0.6, 1.0, 0.5],           # called a cone, but it swells above its start: round
    [50, 0, 100, 2.5, 1.5, 0.5, 0, .8, 1.0, 0.9, 0.6, 0.3],          # a low crown (the low layer, a shrub): mound
    [60, 0, 100, 1.2, 2.0, 0, 2, .5, 1.0, 0.9, 0.7, 0.3],            # brush: mound
    [70, 0, 100, 4.0, 3.0, 0, 2, .5, 1.0, 1.0, 0.8, 0.4],            # tall brush: still a mound
], np.float32)
k = xt.kinds_of(recs)
check('kinds: cone, round, round, cone, round, mound, mound, mound', k.tolist() == [0, 1, 1, 0, 1, 2, 2, 2], k.tolist())
check('a crown of exactly the low height is a mound, one just over it is a tree', xt.kinds_of(np.array([[0, 0, 0, xt.LOW_TREE_M, 1, 0, 0, 1, 1, 1, 1, 1], [0, 0, 0, xt.LOW_TREE_M + 0.1, 1, 0, 0, 1, 1, 1, 1, 1]], np.float32)).tolist() == [2, 1])
buf = xt.pack(recs[:, 0], recs[:, 1], recs[:, 2], recs[:, 3], recs[:, 4], k, xt.tints_of(recs[:, 0], recs[:, 1]))
check('trees.bin: FTR2, the count, 24 bytes a tree', buf[:4] == b'FTR2' and int.from_bytes(buf[4:8], 'little') == 8 and len(buf) == 8 + 8 * 24 and xt.RECORD == 24)
a = xt.unpack(buf)
check('…x, y, z, height as float32, radius in cm, kind, tint', a['x'].tolist() == recs[:, 0].tolist() and a['h'][0] == 20 and a['r'].tolist() == [300, 500, 600, 250, 250, 150, 200, 300] and a['kind'].tolist() == k.tolist())
import struct
check('…at the byte offsets of the contract, then the crown base (cm) and a spare', struct.unpack_from('<ffffHBBHH', buf, 8 + 24) == (10.0, 0.0, 100.0, 15.0, 500, 1, int(a['tint'][1]), 0, 0))
bufb = xt.pack(recs[:, 0], recs[:, 1], recs[:, 2], recs[:, 3], recs[:, 4], k, xt.tints_of(recs[:, 0], recs[:, 1]), base=[4, 3, 5, 2, 2, 0.5, 0, 700.0])
check('the crown\'s base above the foot, in cm (capped at what the field holds)', xt.unpack(bufb)['base'].tolist() == [400, 300, 500, 200, 200, 50, 0, 65535])
v1 = b'FTR1' + struct.pack('<I', 2) + struct.pack('<ffffHBB', 1, 2, 3, 20, 300, 0, 7) + struct.pack('<ffffHBB', 4, 5, 6, 2, 150, 2, 9)
o1 = xt.unpack(v1)
check('a version 1 file (FTR1, 20 bytes) is still read, with no crown base', len(o1) == 2 and o1['x'].tolist() == [1, 4] and o1['r'].tolist() == [300, 150] and o1['kind'].tolist() == [0, 2] and o1['tint'].tolist() == [7, 9] and o1['base'].tolist() == [0, 0])
t1, t2 = xt.tints_of(np.arange(500) * 3.7, np.arange(500) * 1.3), xt.tints_of(np.arange(500) * 3.7, np.arange(500) * 1.3)
check('the tint is steady (the same place, the same tint) and spread over the range', (t1 == t2).all() and t1.min() < 40 and t1.max() > 215 and 90 < t1.mean() < 165, (int(t1.min()), int(t1.max()), float(t1.mean())))
check('a radius too big for the field is capped, one of zero is 1 cm', xt.unpack(xt.pack([0, 0], [0, 0], [0, 0], [1, 1], [900.0, 0.0], [0, 0], [0, 0]))['r'].tolist() == [65535, 1])
for bad in (b'', b'RWP1\0\0\0\0', buf[:50], v1[:30]):
    try:
        xt.unpack(bad); check('a wrong or short file is refused', False)
    except ValueError:
        check('a wrong or short file is refused', True)
check('detail by count: full under 120,000, fewer sides to 300,000, fewest above', [xt.detail_for(n) for n in (0, 119_999, 120_000, 299_999, 300_000, 426_000)] == [0, 0, 1, 1, 2, 2])
o = xt.trees_object(8, 1)
check('TREES by name', o == {'version': 1, 'count': 8, 'detail': 1, 'file': 'trees.bin'})
check('TREES inline: the same bytes as base64', base64.b64decode(xt.trees_object(8, 0, data=buf)['file']) == buf)
check('progress lines are relayed as ASCII', xt.relay_line('  [4/6] Trees and brush → ok ') == 'Trees [4/6] Trees and brush ? ok')

# the export's own ground
dem = np.fromfunction(lambda i, j: 100.0 + i * 1.0 + j * 0.5, (11, 9))                 # [x, y]; cells of 2 m
xb, yb = 1000.0 + np.arange(12) * 2.0, 5000.0 + np.arange(10) * 2.0
z = xt.sample_dem(dem, xb, yb, np.array([1001.0, 1003.0, 1002.0, 1011.0, 990.0, 1021.9]), np.array([5001.0, 5001.0, 5002.0, 5009.0, 5001.0, 5001.0]))
check('the ground under a foot: at a cell centre its height, between centres in between, outside none', z[0] == 100 and z[1] == 101 and abs(z[2] - 100.75) < 1e-9 and abs(z[3] - 107.0) < 1e-9 and np.isnan(z[4]) and z[5] == 110, z.tolist())
dem2 = dem.copy(); dem2[3, 3] = np.nan
check('a blank cell beside the foot: none (the vegetation step\'s ground is used instead)', np.isnan(xt.sample_dem(dem2, xb, yb, np.array([1006.5]), np.array([5006.5]))[0]))
ring = [[0, 0], [10, 0], [10, 10], [0, 10]]
check('inside a ring: even-odd', xt.point_in_ring(np.array([5.0, 15.0, -1.0, 9.9]), np.array([5.0, 5.0, 5.0, 0.1]), ring).tolist() == [True, False, False, True])

# a cliff read as a crown: left out only when the ground itself explains the tree; never by height
def slope_dem(deg, n=400, cell=1.0, step_at=None, step=0.0):
    """[x, y] ground rising eastward at `deg`, with an optional cliff (a step up of `step` m at x = step_at)."""
    x = (np.arange(n) + 0.5) * cell
    z = 500.0 + x * math.tan(math.radians(deg)) + (step if step_at is None else np.where(x >= step_at, step, 0.0))
    return np.repeat(z[:, None], n, axis=1).astype(np.float32), np.arange(n + 1) * cell, np.arange(n + 1) * cell
def rise_at(dem, xb, yb, x, y, radius):
    foot = xt.sample_dem(dem, xb, yb, np.array([x]), np.array([y]))
    return float(xt.ground_rise(dem, xb, yb, np.array([x]), np.array([y]), np.array([radius + xt.CLIFF_REACH_M]), foot)[0])
d10 = slope_dem(10); d30 = slope_dem(30); d45 = slope_dem(45)
r10, r30 = rise_at(*d10, 200.0, 200.0, 12.0), rise_at(*d30, 200.0, 200.0, 12.0)
check('the ground within a 12 m crown (+ 2 m) rises about 2.5 m on a 10 degree slope and about 8 m on a 30 degree one', 2.0 < r10 < 3.2 and 7.5 < r30 < 9.2, (r10, r30))
check('a 100 m tree on a 10 degree slope stays (no height limit)', not xt.on_cliff(r10, 100.0))
check('a 100 m tree on a 30 degree slope stays: it stands far clear of the ground beside it', not xt.on_cliff(r30, 100.0))
check('a 75 m tree, 3 m wide, on a 30 degree slope stays', not xt.on_cliff(rise_at(*d30, 200.0, 200.0, 3.0), 75.0))
check('a 5 m tree on a 45 degree slope stays (5 m of rise within its crown is a slope, not a cliff)', not xt.on_cliff(rise_at(*d45, 200.0, 200.0, 3.0), 5.0), rise_at(*d45, 200.0, 200.0, 3.0))
dc = slope_dem(5, step_at=204.0, step=25.0)                                    # a 25 m cliff 4 m east of the foot
rc_ = rise_at(*dc, 200.0, 200.0, 5.0)
check('at the foot of a 25 m cliff the ground within the crown rises 25 m', 24.5 < rc_ < 27, rc_)
check('a 24 m "tree" there is the cliff: left out', bool(xt.on_cliff(rc_, 24.0)))
check('a 28 m one too (its top is within 15 % of its height of the cliff top)', bool(xt.on_cliff(rc_, 28.0)))
check('a 6 m "tree" under that cliff too (all of it is below the cliff top, inside its own crown)', bool(xt.on_cliff(rc_, 6.0)))
check('a 45 m tree at the foot of the 25 m cliff stays: it stands well clear of the cliff top', not xt.on_cliff(rc_, 45.0))
check('a 100 m tree there stays', not xt.on_cliff(rc_, 100.0))
check('the same cliff 12 m away from a 5 m wide crown: out of reach, the tree stays whatever its height', not xt.on_cliff(rise_at(*slope_dem(5, step_at=212.0, step=25.0), 200.0, 200.0, 5.0), 24.0))
check('a 6 m step is not a cliff: a 6 m tree beside it stays', not xt.on_cliff(rise_at(*slope_dem(5, step_at=203.0, step=6.0), 200.0, 200.0, 3.0), 6.0))
check('no ground in reach (outside the DEM): the tree stays', not xt.on_cliff(float('nan'), 30.0) and np.isnan(xt.ground_rise(dc[0], dc[1], dc[2], np.array([-50.0]), np.array([10.0]), np.array([5.0]), np.array([500.0]))[0]))
hole = dc[0].copy(); hole[204:, :] = np.nan
check('blank ground (a hole, outside the polygon) is not a cliff', np.nan_to_num(rise_at(hole, dc[1], dc[2], 200.0, 200.0, 5.0)) < 1.0)
fine = slope_dem(5, n=800, cell=0.5, step_at=204.0, step=25.0)
check('the same answer on a DEM of 0.5 m cells', abs(rise_at(*fine, 200.0, 200.0, 5.0) - rc_) < 1.0, rise_at(*fine, 200.0, 200.0, 5.0))

# tiles
g = xt.tile_grid((0, 0, 1000, 1000))
check('a 1 km square is 2 x 2 tiles of 500 m; 600 m is one; 1.5 x 0.6 km is 3 x 1', len(g) == 4 and g[0][2] == (0, 0, 500, 500) and g[3][2] == (500, 500, 1000, 1000) and len(xt.tile_grid((0, 0, 600, 600))) == 1 and len(xt.tile_grid((0, 0, 1500, 600))) == 3)
check('with a polygon only the tiles it reaches are run', [t[:2] for t in xt.tile_grid((0, 0, 2000, 2000), polygon=[[10, 10], [300, 10], [300, 300], [10, 300]])] == [(0, 0)] and
      len(xt.tile_grid((0, 0, 2000, 2000), polygon=[[-50, -50], [2050, -50], [2050, 2050], [-50, 2050]])) == 9 and len(xt.tile_grid((0, 0, 2000, 2000), polygon=[[600, 900], [1500, 900], [1500, 1100], [600, 1100]])) == 3)

keep = Path(sys.argv[sys.argv.index('--keep') + 1]) if '--keep' in sys.argv else None
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    # ── 2. veg_shapes.py's own made-up scene, as a trees folder ───────────────
    demo = tmp / 'demo'
    vs.demo(str(demo), say=lambda *a, **k: None)
    veg = json.loads((demo / 'veg.json').read_text())
    T = xt.Trees(demo)
    check('the demo folder: every record read, in UTM zone 14 north', len(T.recs) == veg['shapes']['count'] and T.zone == 14 and T.south is False and T.tiles == 1 and len(T.e) == len(T.recs))
    e0, n0 = rc.lonlat_to_xy(veg['origin']['lon'], veg['origin']['lat'], 14)
    i = int(np.argmax(np.hypot(T.recs[:, 0], T.recs[:, 1])))
    fr = vs.Frame(14, False, e0, n0, veg['origin']['h'])
    bx, by = fr.to_enu(T.e, T.n)
    check('feet go from the step\'s east / north frame back to UTM: the frame\'s own forward map lands on the records, to the centimetre', np.abs(bx - T.recs[:, 0]).max() < 0.01 and np.abs(by - T.recs[:, 1]).max() < 0.01, (float(np.abs(bx - T.recs[:, 0]).max()), float(np.abs(by - T.recs[:, 1]).max())))
    check('…which is not plain addition: grid north is not true north here (over a metre at the edge of the scene)', 0.5 < np.hypot(T.e[i] - e0 - T.recs[i, 0], T.n[i] - n0 - T.recs[i, 1]) < 5)
    b, c = T.binary(e0, n0, -24.5)
    A = xt.unpack(b)
    nb = veg['shapes']['brush']
    check('trees.bin of the demo: every record, brush as mounds, its conifers as cones and broadleaf as round crowns', len(A) == len(T.recs) and c['mound'] >= nb and c['cone'] >= 3 and c['round'] >= 2 and c['cone'] + c['round'] + c['mound'] == len(A) and c['outside'] == 0, c)
    check('…in the viewer frame (metres from the centre given), the step\'s ground + the vertical shift, heights and radii as measured', abs(A['x'][i] - (T.e[i] - e0)) < 0.01 and abs(A['z'][i] - (T.recs[i, 2] - 24.5)) < 1e-3 and abs(A['h'][i] - T.recs[i, 3]) < 1e-4 and abs(A['r'][i] / 100 - T.recs[i, 4]) < 0.006)
    half = [[e0 - 500, n0 - 500], [e0, n0 - 500], [e0, n0 + 500], [e0 - 500, n0 + 500]]
    b2, c2 = T.binary(e0, n0, -24.5, polygon=half)
    check('with a polygon: trees whose foot is outside it are left out, and counted', 0 < len(xt.unpack(b2)) < len(A) and c2['outside'] == len(A) - len(xt.unpack(b2)) and (xt.unpack(b2)['x'] <= 0.01).all(), c2)
    flat = np.full((400, 400), 250.0); fx, fy = e0 - 200 + np.arange(401) * 1.0, n0 - 200 + np.arange(401) * 1.0
    b3, c3 = T.binary(e0, n0, -24.5, dem=flat, x_bins=fx, y_bins=fy)
    check('with the export\'s ground: every foot stands on it', np.allclose(xt.unpack(b3)['z'], 250.0))
    A3 = xt.unpack(b3)
    check('on that gentle ground the cliff rule removes nothing', c3['cliff'] == 0 and len(A3) == len(T.recs) and all(v == 0 for v in c3['cliff_by_height'].values()), c3)
    trees_only = T.recs[:, 6] != 2
    check('the crown\'s base travels: the step\'s own, for trees; none for mounds', (A3['base'][A3['kind'] == 2] == 0).all() and (A3['base'][A3['kind'] != 2] > 0).any() and
          np.allclose(A3['base'][A3['kind'] != 2] / 100.0, np.minimum(T.recs[xt.kinds_of(T.recs) != 2, 5], T.recs[xt.kinds_of(T.recs) != 2, 3] * 0.9), atol=0.006))
    # the same trees with a 30 m cliff 2 m east of one of them (a tree under 32 m): the cliff explains that one
    kd = xt.kinds_of(T.recs)
    j = int(np.nonzero((kd != 2) & (T.recs[:, 3] < 32) & (T.recs[:, 3] > 8))[0][0])
    line = T.e[j] + 2.0
    cl = flat.copy(); cl[int(math.ceil(line - fx[0])):, :] = 280.0
    b4, c4 = T.binary(e0, n0, -24.5, dem=cl, x_bins=fx, y_bins=fy)
    A4 = xt.unpack(b4)
    kept = np.isin(np.round(T.e - e0, 2), np.round(A4['x'].astype(np.float64), 2))
    check('with a 30 m cliff beside a tree: that tree is left out, counted by height; no mound and nothing over 45 m goes', not kept[j] and 0 < len(A3) - len(A4) == c4['cliff'] == sum(c4['cliff_by_height'].values()) and
          c4['cliff_by_height']['over 45 m'] == 0 and (A4['kind'] == 2).sum() == (A3['kind'] == 2).sum(), c4)
    check('…and every tree left out stood within its crown\'s reach of the cliff line, on the low side, its top under 15 % clear of the cliff top',
          all(T.e[i] < line + 1 and line - T.e[i] <= T.recs[i, 4] + xt.CLIFF_REACH_M + 1.5 and T.recs[i, 3] <= 30 + max(2, 0.15 * T.recs[i, 3]) + 0.5 for i in np.nonzero(~kept)[0]), c4)

    # ── 3. The step as a child process, in tiles (a stand-in script) ──────────
    stub = tmp / 'veg_stub.py'
    stub.write_text('''import json, sys, os
sys.path.insert(0, %r)
import numpy as np, veg_shapes as vs, route_cost as rc
a = sys.argv; p = json.load(open(a[a.index('--params') + 1])); out = a[a.index('--out') + 1]
if os.environ.get('VEG_STUB_FAIL'): print('reading tile 1/1'); sys.exit(3)
once = os.environ.get('VEG_STUB_FAIL_ONCE')
if once and not os.path.exists(once): open(once, 'w').close(); print('could not read from the network'); sys.exit(134)
ring = p['area']; zone = 14
xy = [rc.lonlat_to_xy(q[0], q[1], zone) for q in ring]
x0, y0, x1, y1 = min(q[0] for q in xy), min(q[1] for q in xy), max(q[0] for q in xy), max(q[1] for q in xy)
print('[1/6] Reading points (stub)'); print('  ' + json.dumps(p['source']) + ' looks ' + ','.join(p['looks']))
# one tree every 50 m of UTM (so tiles agree on them; none on a tile line), all the way into the margin; a mound beside each
E, N = np.meshgrid(np.arange(np.floor(x0 / 50) * 50 + 25, x1, 50), np.arange(np.floor(y0 / 50) * 50 + 25, y1, 50)); E, N = E.ravel(), N.ravel()
k = (E >= x0) & (N >= y0); E, N = E[k], N[k]
ex, ny = (x0 + x1) / 2, (y0 + y1) / 2
f = vs.Frame(zone, False, ex, ny, 300.0)
recs = []
for e, n in zip(E, N):
    for de, kind, h, r in ((0, 1, 20.0, 3.0), (7, 2, 1.5, 2.0)):
        x, y = f.to_enu(np.array([e + de]), np.array([n]))
        recs.append([x[0], y[0], 300.0, h, r, 1, kind, .5, 1, .8, .5, .2])
np.array(recs, '<f4').tofile(os.path.join(out, 'shapes.bin'))
json.dump({'version': 2, 'origin': {'lon': f.lon0, 'lat': f.lat0, 'h': 300.0}, 'frame': 'enu', 'shapes': {'file': 'shapes.bin', 'count': len(recs), 'record': 48},
           'stats': {'utm_zone': zone, 'south': False, 'seconds': 1.5}}, open(os.path.join(out, 'veg.json'), 'w'))
print('Done in 1.5 s')
''' % ROOT)
    lines = []
    R = (376000.0, 4997000.0, 377000.0, 4998000.0)                             # 1 km: 2 x 2 tiles
    idx = xt.run_veg_tiled(tmp / 'tiled', '/data/cave-ridge/ept.json', R, 14, False, also=['/data/other/ept.json'], progress=lines.append, script=stub)
    check('the step ran once a tile (4), each in its own folder, with its lon/lat ring and the point clouds', len(idx['tiles']) == 4 and all((tmp / 'tiled' / t['dir'] / 'veg.json').exists() for t in idx['tiles']) and
          json.loads((tmp / 'tiled' / 't_0_0' / 'params.json').read_text())['source'] == {'ept': '/data/cave-ridge/ept.json', 'ept_also': ['/data/other/ept.json']} and
          json.loads((tmp / 'tiled' / 't_0_0' / 'params.json').read_text())['looks'] == ['shapes'], idx)
    check('its progress is relayed with the tile and a percentage', any(l.startswith('Trees 0% tile 1/4: [1/6] Reading points') for l in lines) and any(l.startswith('Trees 75% tile 4/4: Done') for l in lines), lines[:3])
    TT = xt.Trees(tmp / 'tiled')
    want = len(np.arange(376000, 377000, 50)) ** 2
    key = np.round((TT.e[TT.recs[:, 6] == 1] - 25) / 50) * 1e6 + np.round((TT.n[TT.recs[:, 6] == 1] - 25) / 50)
    check('every tree once: the ones in a tile\'s margin belong to the neighbour (400 trees, 400 mounds)', len(TT.recs) == 2 * want and len(np.unique(key)) == want and TT.tiles == 4 and abs(TT.seconds - 6.0) < 1e-6, (len(TT.recs), want))
    check('…at their own places, to the centimetre, across the tile line', np.abs((TT.e[TT.recs[:, 6] == 1] - 25) / 50 - np.round((TT.e[TT.recs[:, 6] == 1] - 25) / 50)).max() * 50 < 0.02)
    poly = [[376100, 4997100], [376400, 4997100], [376400, 4997400], [376100, 4997400]]
    idx2 = xt.run_veg_tiled(tmp / 'tiled_poly', '/data/cave-ridge/ept.json', R, 14, False, polygon=poly, progress=lambda m: None, script=stub)
    check('with a polygon in one corner only that tile is run', [t['dir'] for t in idx2['tiles']] == ['t_0_0'])
    os.environ['VEG_STUB_FAIL'] = '1'
    try:
        xt.run_veg_tiled(tmp / 'tiled_fail', '/data/cave-ridge/ept.json', R, 14, False, progress=lambda m: None, script=stub); check('a step that fails says so', False)
    except RuntimeError as ex:
        check('a step that fails every time says so, with its last lines', 'code 3' in str(ex) and 'reading tile' in str(ex), ex)
    del os.environ['VEG_STUB_FAIL']
    os.environ['VEG_STUB_FAIL_ONCE'] = str(tmp / 'failed_once'); again = []
    idx3 = xt.run_veg_tiled(tmp / 'tiled_retry', '/data/cave-ridge/ept.json', R, 14, False, progress=again.append, script=stub)
    del os.environ['VEG_STUB_FAIL_ONCE']
    check('a tile whose read fails once is run again: all four tiles arrive, and the log says it was tried again', len(idx3['tiles']) == 4 and len(xt.Trees(tmp / 'tiled_retry').recs) == len(TT.recs) and
          sum('trying it again' in l for l in again) == 1 and any('tile 1/4: tile 1 failed, trying it again (veg_shapes.py stopped with code 134' in l for l in again), [l for l in again if 'again' in l])

    # ── 4. Through the exporter ───────────────────────────────────────────────
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
    # the demo scene's own place: a box round its origin
    olon, olat = veg['origin']['lon'], veg['origin']['lat']
    d = 0.0016
    BBOX = (olon - d, olat - d * 0.7, olon + d, olat + d * 0.7)                 # about 250 x 250 m
    lon = BBOX[0] - 0.002 + np.arange(80) * 0.0001; lat = BBOX[1] - 0.002 + np.arange(70) * 0.0001
    LO, LA = np.meshgrid(lon, lat)
    H = (1200 + 30 * np.sin((LO - olon) * 900) * np.cos((LA - olat) * 1100) + 4000 * (LA - olat)).astype('<f4')
    H.tofile(tmp / 'dem.bin')
    (tmp / 'dem.json').write_text(json.dumps({'lon0': float(lon[0]), 'lat0': float(lat[0]), 'dlon': 0.0001, 'dlat': 0.0001, 'nx': 80, 'ny': 70, 'cell': 4.0, 'file': 'dem.bin'}))
    def run(name, extra):
        out = tmp / name
        argv, so = sys.argv, sys.stdout
        sys.argv = ['export_terrain.py', '--dem-grid', str(tmp / 'dem.json'), '--bbox', *map(str, BBOX), '--out', str(out), '--name', 'Cave Ridge',
                    '--max-triangles', '40000', '--tex-size', '512', *extra]
        log = io.StringIO()
        try:
            sys.stdout = log
            et.main()
        except SystemExit as ex:
            log.write(f'EXIT {ex}')
        finally:
            sys.stdout, sys.argv = so, argv
        return out, log.getvalue()
    def trees_const(html):
        m = re.search(r'<script>const TREES = (.*?);</script>', html, re.S)
        return json.loads(m.group(1)) if m else 'MISSING'

    out0, log0 = run('plain.zip', [])
    z0 = zipfile.ZipFile(out0); h0 = z0.read('viewer.html').decode('utf-8')
    check('plain export: TREES is null, nothing left of the placeholder', trees_const(h0) is None and 'PLACEHOLDER_TREES_JSON' not in h0.replace("'PLACEHOLDER_' + 'TREES_JSON'", ''), str(trees_const(h0))[:80])
    check('plain export: the same file list as ever', {n for n in z0.namelist() if not n.startswith('libs/')} == {'terrain.glb', 'tex_sat.jpg', 'tex_hs.jpg', 'caves.json', 'viewer.html', 'serve.bat', 'serve.sh'}, sorted(z0.namelist()))
    check('plain export: the log does not mention trees; the module travels in libs/', 'Trees' not in log0 and 'libs/trees.js' in z0.namelist())
    outn, logn = run('plain2.zip', ['--trees'])                                 # no point cloud given
    check('--trees without a point cloud: a warning, the export made without them, the viewer byte for byte the plain one', outn.exists() and 'trees and brush left out' in logn and 'trees.bin' not in zipfile.ZipFile(outn).namelist() and
          zipfile.ZipFile(outn).read('viewer.html') == z0.read('viewer.html'), logn[-300:])
    outb, logb = run('plain3.zip', ['--trees-dir', str(tmp / 'nowhere')])
    check('a trees folder that is not one: the same', 'trees and brush left out' in logb and zipfile.ZipFile(outb).read('viewer.html') == z0.read('viewer.html'))

    out, log = run('trees.zip', ['--trees-dir', str(demo)])
    z = zipfile.ZipFile(out); names = z.namelist()
    check('the zip carries trees.bin and trees.json', 'trees.bin' in names and 'trees.json' in names, names)
    tb = z.read('trees.bin'); A = xt.unpack(tb); side = json.loads(z.read('trees.json'))
    check('trees.json: the count, the kinds, the detail and the TREES object by file name', side['count'] == len(A) == len(T.recs) and side['cone'] + side['round'] + side['mound'] == len(A) and side['detail'] == 0 and side['viewer'] == {'version': 1, 'count': len(A), 'detail': 0, 'file': 'trees.bin'}, side)
    check('the log says how many of each', re.search(r'Trees and brush: \d+ \(\d+ cones, \d+ round crowns, \d+ low mounds\), trees\.bin \d+ KB, detail 0', log) is not None, log[-400:])
    check('trees.json counts what the cliff rule left out (nothing on this ground)', side['cliff'] == 0 and 'cliff_by_height' in side and 'a cliff explains' not in log, side)
    meta = json.loads(z.read('caves.json'))['meta']
    ce, cn = meta['utm_center_e'], meta['utm_center_n']
    check('feet are in the viewer frame: metres from the terrain\'s centre', abs((A['x'][i] + ce) - T.e[i]) < 0.01 and abs((A['y'][i] + cn) - T.n[i]) < 0.01)
    # the terrain's own height under each foot: the map DEM the test made
    lonf, latf = rc.xy_to_lonlat(T.e, T.n, 14, False)
    hz = 1200 + 30 * np.sin((lonf - olon) * 900) * np.cos((latf - olat) * 1100) + 4000 * (latf - olat)       # (map terrain is drawn as it is: no point-cloud shift)
    inside = (np.abs(A['x']) < 110) & (np.abs(A['y']) < 110)
    check('feet stand on the export\'s own ground, not on the vegetation step\'s (which is 900 m lower here)', inside.sum() > 20 and np.abs(A['z'][inside] - hz[inside]).max() < 1.5 and abs(float(np.median(T.recs[:, 2])) - float(np.median(A['z']))) > 500,
          (float(np.abs(A['z'][inside] - hz[inside]).max()), float(np.median(T.recs[:, 2])), float(np.median(A['z']))))
    h = z.read('viewer.html').decode('utf-8')
    tc = trees_const(h)
    check('the single-file viewer: TREES with the file inline (the same bytes), trees.js inlined', isinstance(tc, dict) and tc['count'] == len(A) and tc['detail'] == 0 and base64.b64decode(tc['file']) == tb and 'root.FlexTrees = R' in h and 'src="libs/trees.js"' not in h)
    def no_about(t):                                   # the "About this map" facts differ (they count the trees): leave them out of the comparison
        i = t.find('"about":')
        if i < 0: return t
        d, j = 0, t.index('{', i)
        while True:
            d += (t[j] == '{') - (t[j] == '}'); j += 1
            if d == 0: break
        return t[:i] + t[j:]
    check('the rest of the viewer is the plain one', no_about(h.replace(json.dumps(tc, separators=(',', ':')), 'null')) == no_about(h0))
    reb = tmp / 'rebuilt.zip'
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'rebuild_viewer.py'), str(out), '-o', str(reb)], capture_output=True, text=True)
    check('tools/rebuild_viewer.py keeps the trees', r.returncode == 0 and trees_const(zipfile.ZipFile(reb).read('viewer.html').decode('utf-8')) == tc and zipfile.ZipFile(reb).read('trees.bin') == tb, r.stderr[-300:])
    r0 = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'rebuild_viewer.py'), str(out0), '-o', str(tmp / 'rebuilt0.zip')], capture_output=True, text=True)
    check('…and a plain export rebuilt has TREES null', r0.returncode == 0 and trees_const(zipfile.ZipFile(tmp / 'rebuilt0.zip').read('viewer.html').decode('utf-8')) is None)

    # a polygon: the left half of the box
    (tmp / 'poly.json').write_text(json.dumps([[BBOX[0], BBOX[1]], [olon, BBOX[1]], [olon, BBOX[3]], [BBOX[0], BBOX[3]]]))
    outp, logp = run('poly.zip', ['--trees-dir', str(demo), '--polygon', str(tmp / 'poly.json')])
    zp = zipfile.ZipFile(outp); Ap = xt.unpack(zp.read('trees.bin')); sp = json.loads(zp.read('trees.json')); mp = json.loads(zp.read('caves.json'))['meta']
    check('with --polygon: only the trees inside it, the others counted as left out', 0 < len(Ap) < len(A) and sp['outside'] > 0 and sp['outside'] + len(Ap) <= len(A) and 'outside the polygon left out' in logp and
          ((Ap['x'] + mp['utm_center_e']) <= rc.lonlat_to_xy(olon, olat, 14)[0] + 0.5).all(), (len(Ap), len(A), sp))

    # the child process through the exporter (the stand-in), tiled
    os.environ['FLEX_TREES_SCRIPT'] = str(stub)
    def fake_points(*a, **k): raise AssertionError('no point cloud may be read')
    oute, loge = run('child.zip', ['--trees', '--ept', '/data/cave-ridge/ept.json'])
    del os.environ['FLEX_TREES_SCRIPT']
    ze = zipfile.ZipFile(oute)
    check('--trees runs the step as a child before the terrain, relays its progress under [1/7], and the trees arrive', 'trees.bin' in ze.namelist() and '[1/7] Trees 0% tile 1/1: [1/6] Reading points (stub)' in loge and
          loge.index('[1/7] Trees 100%') < loge.index('[2/7]') and len(xt.unpack(ze.read('trees.bin'))) > 10, loge[:600])
    if keep:
        keep.mkdir(parents=True, exist_ok=True)
        for f in (out, out0):
            (keep / f.name).write_bytes(f.read_bytes())

print(f'{passes} passed, {fails} failed ({time.time() - T0:.1f} s)')
sys.exit(1 if fails else 0)
