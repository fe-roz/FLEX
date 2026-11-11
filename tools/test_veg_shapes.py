#!/usr/bin/env python3
"""
veg_shapes.py on made-up clouds (numpy only, no PDAL, no network).

    python tools/test_veg_shapes.py

Scenes sit around the documentation example (45.1234, -100.5678). Pins down:
  * known trees (8 cones, 5 domes) are found once each, near their true
    position, with their height, crown radius, base and kind;
  * a brush patch gives mounds inside it, open ground gives nothing, a bare
    scene gives no shapes and no shell, a cliff face is not vegetation, and
    noise (class 7, a bird) makes no shape;
  * the area ring clips the result;
  * every .bin matches veg.json (sizes, record layout, ground NaN-free and
    row 0 south), the shell is closed, outward, in range and under budget;
  * the local frame is east/north on the tangent plane (convergence out);
  * --demo runs; errors print a '! ' line and exit non-zero; ASCII only.
"""
import contextlib, io, json, math, os, shutil, sys, tempfile, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import numpy as np
import veg_shapes as vs
import route_cost as rc

fails = 0
passes = 0


def check(label, ok, detail=''):
    global fails, passes
    if ok:
        passes += 1
    else:
        fails += 1
        print('FAIL', label, detail)


T0 = time.time()
TMP = tempfile.mkdtemp(prefix='veg_shapes_test_')
E0, N0, ZONE = rc.example_origin()


def quiet_run(params, out):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        veg = vs.run(params, out)
    return veg, buf.getvalue()


def ring_ll(x0, y0, x1, y1):
    ring = []
    for (xl, yl) in ((x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)):
        lon, lat = rc.xy_to_lonlat(np.array([E0 + xl]), np.array([N0 + yl]),
                                   ZONE, False)
        ring.append([float(lon[0]), float(lat[0])])
    return ring


def load(out):
    veg = json.load(open(os.path.join(out, 'veg.json')))
    shapes = None
    if 'shapes' in veg:
        shapes = np.fromfile(os.path.join(out, 'shapes.bin'), '<f4').reshape(-1, 8)
    shell = None
    if 'shell' in veg:
        buf = open(os.path.join(out, 'shell.bin'), 'rb').read()
        nv, nt = veg['shell']['vertices'], veg['shell']['triangles']
        V = np.frombuffer(buf, '<f4', nv * 4).reshape(nv, 4)
        T = np.frombuffer(buf, '<u4', nt * 3, nv * 16).reshape(nt, 3)
        shell = (V, T, len(buf))
    G = veg['ground']
    ground = np.fromfile(os.path.join(out, 'ground.bin'), '<f4')
    return veg, shapes, shell, ground


def frame_of(veg):
    o = veg['origin']
    e, n, _ = rc.et().latlon_to_utm(o['lat'], o['lon'], ZONE)
    F = vs.Frame(ZONE, False, e, n, o['h'])
    F.fit_inverse((e - 300, n - 300, e + 300, n + 300))
    return F


# --------------------------------------------------------------------------
# 1. The made-up forest
# --------------------------------------------------------------------------

npz = os.path.join(TMP, 'scene.npz')
truth, _ = vs.write_scene_npz(npz)
W, H = truth['W'], truth['H']
out = os.path.join(TMP, 'scene')
params = {'source': {'npz': npz}, 'area': ring_ll(0, 0, W, H),
          'looks': ['shapes', 'shell'], 'detail': 'medium',
          'min_height': 0.5, 'brush_top': 2.0, 'max_triangles': 300000}
veg, log = quiet_run(params, out)
veg, S, shell, ground = load(out)
fr = frame_of(veg)

trees = S[S[:, 6] != 2]
brush = S[S[:, 6] == 2]
check('trees counted', len(trees) == len(truth['trees']),
      f'{len(trees)} vs {len(truth["trees"])}')
check('veg.json counts', veg['shapes']['trees'] == len(trees) and
      veg['shapes']['brush'] == len(brush) and
      veg['shapes']['cones'] + veg['shapes']['domes'] == len(trees) and
      veg['shapes']['count'] == len(S))
check('trees first, tallest first',
      np.all(np.diff(trees[:, 3]) <= 1e-6) and
      np.all(S[:len(trees), 6] != 2), S[:, 6])

matched = set()
kind_ok = 0
for (tx, ty, h, r, b, k) in truth['trees']:
    xe, yn = fr.to_enu(np.array([E0 + tx]), np.array([N0 + ty]))
    d = np.hypot(trees[:, 0] - xe[0], trees[:, 1] - yn[0])
    i = int(np.argmin(d))
    matched.add(i)
    t = trees[i]
    check(f'tree at {tx},{ty} found', d[i] < 1.5, f'{d[i]:.2f} m off')
    check(f'tree at {tx},{ty} height', abs(t[3] - h) < 0.15 * h + 0.5,
          f'{t[3]:.1f} vs {h}')
    check(f'tree at {tx},{ty} radius', abs(t[4] - r) < 0.35 * r + 0.3,
          f'{t[4]:.2f} vs {r}')
    check(f'tree at {tx},{ty} base', abs(t[5] - b) < 0.2 * h + 1.0,
          f'{t[5]:.1f} vs {b}')
    zg = truth['zf'](tx, ty)
    check(f'tree at {tx},{ty} ground', abs(t[2] - zg) < 0.3, f'{t[2]:.2f} vs {zg:.2f}')
    check(f'tree at {tx},{ty} density in 0..1', 0 < t[7] <= 1)
    kind_ok += int(t[6] == k)
check('one shape per tree', len(matched) == len(truth['trees']))
check('cone / dome guessed', kind_ok >= len(truth['trees']) - 1,
      f'{kind_ok}/{len(truth["trees"])}')

# Brush: mounds inside the patch, base 0, sensible heights; none in the open.
bx0, by0, bx1, by1 = truth['brush']
xe, yn = fr.to_enu(np.array([E0 + bx0, E0 + bx1]), np.array([N0 + by0, N0 + by1]))
inb = (brush[:, 0] > xe[0] - 3) & (brush[:, 0] < xe[1] + 3) & \
    (brush[:, 1] > yn[0] - 3) & (brush[:, 1] < yn[1] + 3)
check('brush mounds made', inb.sum() >= 40, inb.sum())
near_tree = np.zeros(len(brush), bool)
for t in trees:
    near_tree |= np.hypot(brush[:, 0] - t[0], brush[:, 1] - t[1]) < t[4] + 2.0
check('no brush away from the patch', np.all(inb | near_tree),
      brush[~(inb | near_tree)][:3])
check('brush heights', np.all((brush[:, 3] >= 0.5) & (brush[:, 3] <= 2.0)) and
      np.all(brush[:, 5] == 0), brush[:, 3].min())
check('brush radius a few metres', np.all((brush[:, 4] > 0.5) & (brush[:, 4] < 4)))
ox0, oy0, ox1, oy1 = truth['open']
xe, yn = fr.to_enu(np.array([E0 + ox0, E0 + ox1]), np.array([N0 + oy0, N0 + oy1]))
inopen = (S[:, 0] > xe[0]) & (S[:, 0] < xe[1]) & (S[:, 1] > yn[0]) & (S[:, 1] < yn[1])
check('open ground stays empty', inopen.sum() == 0, inopen.sum())
# Noise: the bird at (100, 20) and the class 7 returns at (60, 130).
for (nx_, ny_) in ((100.0, 20.0), (60.0, 130.0)):
    xe, yn = fr.to_enu(np.array([E0 + nx_]), np.array([N0 + ny_]))
    check(f'no shape at the noise {nx_},{ny_}',
          not np.any(np.hypot(S[:, 0] - xe[0], S[:, 1] - yn[0]) < 4))
check('stats', veg['stats']['points'] > 0 and
      0 < veg['stats']['veg_points'] < veg['stats']['points'] and
      20 < veg['stats']['max_height'] < 30 and veg['stats']['seconds'] >= 0)
check('progress lines', '[1/6]' in log and '[6/6]' in log and
      all(ord(ch) < 128 for ch in log))

# Files against veg.json.
for k in ('version', 'origin', 'frame', 'bbox', 'area_m2', 'shapes', 'shell',
          'ground', 'stats', 'params'):
    check(f'veg.json has {k}', k in veg)
check('frame enu', veg['frame'] == 'enu' and veg['version'] == 1)
check('record 32', veg['shapes']['record'] == 32 and
      os.path.getsize(os.path.join(out, 'shapes.bin')) == 32 * len(S))
G = veg['ground']
check('ground.bin size', ground.size == G['nx'] * G['ny'] and
      os.path.getsize(os.path.join(out, 'ground.bin')) == 4 * G['nx'] * G['ny'])
check('ground NaN-free', np.all(np.isfinite(ground)))
g2 = ground.reshape(G['ny'], G['nx'])
# Row 0 south: the scene rises 0.03 m per m northward.
check('ground row 0 is south', g2[-1].mean() > g2[0].mean() + 2,
      (g2[0].mean(), g2[-1].mean()))
check('ground covers the bbox', G['x0'] <= veg['bbox'][0] and G['y0'] <= veg['bbox'][1] and
      G['x0'] + (G['nx'] - 1) * G['cell'] >= veg['bbox'][2] and
      G['y0'] + (G['ny'] - 1) * G['cell'] >= veg['bbox'][3])
# ground.bin is the scene's ground in the local frame.
jj, ii = G['ny'] // 2, G['nx'] // 3
e, n = fr.to_utm(np.array([G['x0'] + ii * G['cell']]), np.array([G['y0'] + jj * G['cell']]))
zt = truth['zf'](e[0] - E0, n[0] - N0)
check('ground.bin heights', abs(g2[jj, ii] - zt) < 0.3, f'{g2[jj, ii]:.2f} vs {zt:.2f}')
check('origin h is the ground', abs(veg['origin']['h'] - truth['zf'](W / 2, H / 2)) < 0.3)
check('area', abs(veg['area_m2'] - W * H) < 0.01 * W * H, veg['area_m2'])
# The UTM rectangle is turned by the grid convergence (~1.1 deg here) in
# the east/north frame, so its bbox is a little wider than W x H.
gam = math.radians(1.1)
check('bbox', abs((veg['bbox'][2] - veg['bbox'][0]) - (W * math.cos(gam) + H * math.sin(gam))) < 1.5 and
      abs((veg['bbox'][3] - veg['bbox'][1]) - (H * math.cos(gam) + W * math.sin(gam))) < 1.5, veg['bbox'])
check('params as used', veg['params']['detail'] == 'medium' and
      veg['params']['looks'] == ['shapes', 'shell'])
check('preview written', os.path.getsize(os.path.join(out, 'preview.png')) > 1000)

# Shell.
V, T, nbytes = shell
check('shell.bin size', nbytes == 16 * len(V) + 12 * len(T))
check('shell has triangles', len(T) > 500 and veg['shell']['voxel_m'] > 0, len(T))
check('shell indices in range', T.max() < len(V))
check('shell under budget', len(T) <= 300000)
check('shell hag >= 0', V[:, 3].min() >= 0)
check('shell hag below the tallest tree', V[:, 3].max() < 35)
# z = ground + hag.
gzv = np.array([truth['zf'](*(np.array(fr.to_utm(np.array([v[0]]), np.array([v[1]]))).ravel()
                              - np.array([E0, N0]))) for v in V[::max(1, len(V) // 300)]])
dz = (V[::max(1, len(V) // 300), 2] - V[::max(1, len(V) // 300), 3]) - gzv
check('shell z = ground + hag', np.abs(dz).max() < 0.3, np.abs(dz).max())
e = np.sort(np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]), axis=1)
_, cnt = np.unique(e[:, 0].astype(np.int64) * len(V) + e[:, 1], return_counts=True)
check('shell closed (edges shared by 2)', (cnt == 2).mean() > 0.995, (cnt == 2).mean())
P = V[:, :3].astype(np.float64) - V[:, :3].mean(0)
vol = np.einsum('ij,ij->i', P[T[:, 0]], np.cross(P[T[:, 1]], P[T[:, 2]])).sum() / 6
check('shell outward (CCW from outside)', vol > 0, vol)
check('shell vertices inside the area', np.all((V[:, 0] > veg['bbox'][0] - 10) &
                                               (V[:, 0] < veg['bbox'][2] + 10)))

# Budget.
out_b = os.path.join(TMP, 'budget')
p2 = dict(params, looks=['shell'], max_triangles=2000)
veg_b, _ = quiet_run(p2, out_b)
check('max_triangles honoured', veg_b['shell']['triangles'] <= 2000,
      veg_b['shell']['triangles'])
check('only the asked look', 'shapes' not in veg_b and
      not os.path.exists(os.path.join(out_b, 'shapes.bin')))

# Area ring clips: the western half only (the conifers).
out_c = os.path.join(TMP, 'clip')
veg_c, _ = quiet_run(dict(params, area=ring_ll(0, 0, 90, H), looks=['shapes']), out_c)
Sc = np.fromfile(os.path.join(out_c, 'shapes.bin'), '<f4').reshape(-1, 8)
tc = Sc[Sc[:, 6] != 2]
check('area ring clips', len(tc) == 8 and np.all(tc[:, 6] == 1), (len(tc), tc[:, 6]))

# Detail levels run and order sensibly.
outs = {}
for d in ('low', 'high'):
    outs[d], _ = quiet_run(dict(params, detail=d), os.path.join(TMP, d))
check('low and high run', outs['low']['shapes']['trees'] >= 10 and
      outs['high']['shapes']['trees'] >= 10)
check('low shell lighter', outs['low']['shell']['triangles'] <=
      veg['shell']['triangles'] <= outs['high']['shell']['triangles'] * 1.05)

# --------------------------------------------------------------------------
# 2. Bare ground and a cliff
# --------------------------------------------------------------------------

rng = np.random.default_rng(5)
n = 120 * 100 * 15
x = rng.uniform(0, 120, n); y = rng.uniform(0, 100, n)
step = 10.0 / (1 + np.exp(-(x - 60) / 0.2))          # a 10 m cliff at x = 60
z = 200 + 0.02 * y + step + rng.normal(0, 0.03, n)
c = np.full(n, 2, np.uint8)
# The face: dense unclassified returns standing up the step.
m = 6000
fx = 60 + rng.uniform(-0.6, 0.6, m); fy = rng.uniform(0, 100, m)
fz = 200 + 0.02 * fy + rng.uniform(0.3, 9.7, m)
X = np.concatenate([x, fx]); Y = np.concatenate([y, fy]); Z = np.concatenate([z, fz])
C = np.concatenate([c, np.ones(m, np.uint8)])
npz2 = os.path.join(TMP, 'cliff.npz')
np.savez(npz2, x=X + E0, y=Y + N0, z=Z, classification=C, epsg=np.int64(32600 + ZONE))
out2 = os.path.join(TMP, 'cliff')
veg2, _ = quiet_run({'source': {'npz': npz2}}, out2)
S2 = np.fromfile(os.path.join(out2, 'shapes.bin'), '<f4').reshape(-1, 8)
check('cliff face is not vegetation', len(S2) == 0, S2[:5])
check('cliff: area from the npz', abs(veg2['area_m2'] - 120 * 100) < 300, veg2['area_m2'])

# Bare: only the ground.
npz3 = os.path.join(TMP, 'bare.npz')
np.savez(npz3, x=x + E0, y=y + N0, z=200 + 0.05 * x + rng.normal(0, 0.03, n),
         classification=c, epsg=np.int64(32600 + ZONE))
out3 = os.path.join(TMP, 'bare')
veg3, _ = quiet_run({'source': {'npz': npz3}}, out3)
check('bare ground: no shapes', veg3['shapes']['count'] == 0 and
      os.path.getsize(os.path.join(out3, 'shapes.bin')) == 0)
check('bare ground: no shell', veg3['shell']['triangles'] == 0 and
      os.path.getsize(os.path.join(out3, 'shell.bin')) == 0)
check('bare ground: ground.bin still there',
      os.path.getsize(os.path.join(out3, 'ground.bin')) == 4 * veg3['ground']['nx'] * veg3['ground']['ny'])

# --------------------------------------------------------------------------
# 3. The local frame
# --------------------------------------------------------------------------

# Off the central meridian, where UTM grid north and true north differ.
lat0, lon0 = 45.1234, -100.5678
e0, n0, z0 = rc.et().latlon_to_utm(lat0, lon0)
F = vs.Frame(z0, False, e0, n0, 500.0)
check('frame origin', abs(F.lat0 - lat0) < 1e-7 and abs(F.lon0 - lon0) < 1e-7)
x_, y_ = F.to_enu(np.array([e0]), np.array([n0]))
check('origin at 0, 0', abs(x_[0]) < 1e-6 and abs(y_[0]) < 1e-6)
# 1 km due north (same longitude): east stays 0, north = the meridian arc.
a, f_ = 6378137.0, 1 / 298.257223563
e2 = f_ * (2 - f_)
M = a * (1 - e2) / (1 - e2 * math.sin(math.radians(lat0)) ** 2) ** 1.5
M_h = M + 500.0            # the frame's plane is at the origin's height
dlat = 1000.0 / M
en, nn, _ = rc.et().latlon_to_utm(lat0 + math.degrees(dlat), lon0, z0)
x_, y_ = F.to_enu(np.array([en]), np.array([nn]))
check('true north is +y', abs(x_[0]) < 0.01 and abs(y_[0] - 1000.0 * M_h / M) < 0.02,
      (x_[0], y_[0]))
naive = math.hypot(en - e0, nn - n0)
check('UTM offsets would be rotated (convergence)', abs(en - e0) > 5, en - e0)
# 1 km due east along the parallel: x = 1000 m, y = the parallel's curve.
Nn = a / math.sqrt(1 - e2 * math.sin(math.radians(lat0)) ** 2)
dlon = 1000.0 / (Nn * math.cos(math.radians(lat0)))
ee, ne, _ = rc.et().latlon_to_utm(lat0, lon0 + math.degrees(dlon), z0)
x_, y_ = F.to_enu(np.array([ee]), np.array([ne]))
check('true east is +x', abs(x_[0] - 1000.0 * (Nn + 500) / Nn) < 0.02 and abs(y_[0]) < 0.15,
      (x_[0], y_[0]))
err = F.fit_inverse((e0 - 600, n0 - 600, e0 + 600, n0 + 600))
check('inverse map within 1 cm', err < 0.01, err)
xs, ys = F.to_enu(np.array([e0 + 400.0, e0 - 300]), np.array([n0 - 200.0, n0 + 500]))
eb, nb = F.to_utm(xs, ys)
check('round trip', np.all(np.abs(eb - [e0 + 400, e0 - 300]) < 0.01) and
      np.all(np.abs(nb - [n0 - 200, n0 + 500]) < 0.01))

# --------------------------------------------------------------------------
# 4. CLI: --demo, errors
# --------------------------------------------------------------------------

def cli(argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = vs.main(argv)
    return code, buf.getvalue()


dd = os.path.join(TMP, 'demo')
code, txt = cli(['--demo', dd])
check('--demo exits 0', code == 0, txt[-300:])
check('--demo writes everything', all(os.path.exists(os.path.join(dd, f)) for f in
      ('veg.json', 'shapes.bin', 'shell.bin', 'ground.bin', 'preview.png', 'params.json')))
check('--demo ascii', all(ord(ch) < 128 for ch in txt))

bad = os.path.join(TMP, 'bad.json')
for label, prm in (('bad detail', {'source': {'npz': npz}, 'detail': 'ultra'}),
                   ('no source', {'area': ring_ll(0, 0, 10, 10)}),
                   ('ept without area', {'source': {'ept': 'http://example.invalid/ept.json'}}),
                   ('bad looks', {'source': {'npz': npz}, 'looks': ['trunks']}),
                   ('min over top', {'source': {'npz': npz}, 'min_height': 3, 'brush_top': 2})):
    json.dump(prm, open(bad, 'w'))
    code, txt = cli(['--params', bad, '--out', os.path.join(TMP, 'err')])
    check(f'error exits 1: {label}', code == 1, txt)
    check(f'error has a "! " line: {label}', any(l.startswith('! ') for l in txt.splitlines()), txt)
npz_nozone = os.path.join(TMP, 'nozone.npz')
np.savez(npz_nozone, x=x[:1000] + E0, y=y[:1000] + N0, z=z[:1000], classification=c[:1000])
json.dump({'source': {'npz': npz_nozone}}, open(bad, 'w'))
code, txt = cli(['--params', bad, '--out', os.path.join(TMP, 'err')])
check('npz without epsg refused', code == 1 and '! ' in txt, txt)
code, txt = cli(['--params', bad, '--out', os.path.join(TMP, 'err2'),
                 '--points-npz', npz_nozone, '--points-epsg', str(32600 + ZONE)])
check('--points-epsg supplies it', code == 0, txt[-300:])

shutil.rmtree(TMP, ignore_errors=True)
print(f'test_veg_shapes: {passes} passed, {fails} failed ({time.time() - T0:.1f} s)')
sys.exit(1 if fails else 0)
