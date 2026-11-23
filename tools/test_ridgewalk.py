#!/usr/bin/env python3
"""
ridgewalk.py on its made-up scene (numpy + scipy only, no PDAL, no network, < 30 s).

    python tools/test_ridgewalk.py

The scene (ridgewalk.DEMO): a vertical pit on the line between two tiles, a slanted pit with a deeper group
under a roof beside it, a tall wall with returns all over its face and an opening at its foot, a crack, a pit
0.8 m deep and one 1.5 m deep, two lone returns (one far from everything), one flight pass with stripes of
returns far below the ground, a patch of brush. Pins down:
  * the measure: a return is below ground when it lies more than 1 m behind the local face. The wall's face
    returns are under the lid (candidates) but on the face: no feature, no hole. The opening at its foot is a
    feature 1 to 3 m deep (not the wall's height). The 0.8 m pit is not found, the 1.5 m one is; with
    --min-behind 0.5 the shallow one is found too;
  * the files: ridge.json, lid.npy, holes.npy, points.bin (RWP1), shapes.bin (RWS1), brush.npy / brush.json;
  * the lid closes every opening at ground level;
  * each feature is classified right: returns in a group, open at the pit's mouth, the deep group joined to
    the slanted pit (one feature) with no hole above it, the way out sideways at the cliff, the lone return
    lone, the far one likely noise;
  * every shape reaches the surface;
  * the striped pass is flagged and its returns set aside, except those another pass confirms;
  * a shape never rests on a guessed link longer than 12 m (--max-link): two returns 15 m straight down are
    likely noise, no shape, no hole; the deep group 8 m from the slanted pit's end is still part of it;
  * a flagged pass is set aside over the whole area: its stripe is set aside also where it is too thin to be
    flagged on its own; a real pit it shares with good passes is kept;
  * the result does not depend on the tile cut (96 m tiles with workers against 48 m tiles in one process):
    the pit that sits on a tile line is neither cut nor doubled;
  * --npz with a polygon and --no-shapes.
"""
import io, json, os, sys, tempfile, time, contextlib
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import numpy as np
import ridgewalk as rw

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


def run(args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        J = rw.main(args)
    return J, buf.getvalue()


def load(d):
    R = dict(J=json.load(open(os.path.join(d, 'ridge.json'))), lid=np.load(os.path.join(d, 'lid.npy')), holes=np.load(os.path.join(d, 'holes.npy')),
             brush=np.load(os.path.join(d, 'brush.npy')), bj=json.load(open(os.path.join(d, 'brush.json'))))
    R['xyz'], R['depth'], R['kind'] = rw.read_points_bin(os.path.join(d, 'points.bin'))
    if os.path.exists(os.path.join(d, 'debug.npz')):
        R['dbg'] = dict(np.load(os.path.join(d, 'debug.npz')))
    return R


tmp = tempfile.mkdtemp(prefix='ridge_test_')
D = rw.DEMO; cell = 0.3
A = os.path.join(tmp, 'a')
J, log = run(['--demo', A, '--debug', '--workers', '4'])
R = load(A)
t_first = time.time() - T0

# ---- the files
check('progress lines are [ridge] NN% and ASCII', all(l.startswith('[ridge] ') and '%' in l[:13] for l in log.strip().splitlines()) and log.isascii(), log[:200])
for k in ('version', 'epsg', 'zone', 'south', 'origin', 'bbox_utm', 'bbox_lonlat', 'cell', 'nx', 'ny', 'params', 'counts', 'passes', 'seconds', 'notes'):
    check('ridge.json has ' + k, k in R['J'])
for k in ('returns', 'below', 'groups', 'lone', 'likely_noise', 'pattern_noise', 'features', 'true_cells', 'guessed_cells', 'candidates', 'on_face', 'no_face'):
    check('counts has ' + k, isinstance(R['J']['counts'].get(k), int), str(R['J']['counts'].get(k)))
nx, ny = R['J']['nx'], R['J']['ny']
check('version 1, cell 0.3', R['J']['version'] == 1 and abs(R['J']['cell'] - 0.3) < 1e-9)
check('params say the measure', R['J']['params'].get('measure') == 'normal' and R['J']['params'].get('min_behind') == 1.0, str(R['J']['params'].get('min_behind')))
check('grid covers the scene', abs(nx * cell - D['size'][0]) < 1.0 and abs(ny * cell - D['size'][1]) < 1.0, '%d %d' % (nx, ny))
check('lid.npy float32 [ny, nx]', R['lid'].dtype == np.float32 and R['lid'].shape == (ny, nx), str(R['lid'].shape))
check('holes.npy uint8 [ny, nx], values 0 1 2', R['holes'].dtype == np.uint8 and R['holes'].shape == (ny, nx) and set(np.unique(R['holes'])) <= {0, 1, 2})
raw = open(os.path.join(A, 'points.bin'), 'rb').read(); n = int(np.frombuffer(raw, '<u4', 1, 4)[0])
check('points.bin RWP1 and its size', raw[:4] == b'RWP1' and len(raw) == 8 + n * 17, '%d %d' % (len(raw), n))
raw = open(os.path.join(A, 'shapes.bin'), 'rb').read(); nv, nt = (int(v) for v in np.frombuffer(raw, '<u4', 2, 4))
check('shapes.bin RWS1 and its size', raw[:4] == b'RWS1' and len(raw) == 12 + nv * 16 + nt * 12 and nt > 0, '%d %d %d' % (len(raw), nv, nt))
sv, sd, st = rw.read_shapes_bin(os.path.join(A, 'shapes.bin'))
check('shape triangles index their vertices', st.max() < nv and np.isfinite(sv).all())
check('brush.npy in blocks of 3 cells', R['brush'].dtype == np.float32 and R['brush'].shape == ((ny + 2) // 3, (nx + 2) // 3) and
      R['bj']['nx'] == R['brush'].shape[1] and R['bj']['ny'] == R['brush'].shape[0] and abs(R['bj']['cell'] - 0.9) < 1e-6 and R['bj']['band'] == [0.3, 2.0], str(R['bj']))
check('counts match the files', R['J']['counts']['below'] == int((R['kind'] < 3).sum()) and R['J']['counts']['pattern_noise'] == int((R['kind'] == 3).sum())
      and R['J']['counts']['true_cells'] == int((R['holes'] == 1).sum()) and R['J']['counts']['guessed_cells'] == int((R['holes'] == 2).sum()))

# ---- the lid: row 0 = south, the ground with every opening closed
jj, ii = np.mgrid[0:ny, 0:nx]; gx = (ii + 0.5) * cell; gy = (jj + 0.5) * cell
gz = rw.demo_ground(gx, gy); away = np.abs(gy - D['cliff_y']) > 1.5
err = np.abs(R['lid'] - gz)[away]
check('the lid is the ground (row 0 = south)', np.isfinite(R['lid']).all() and np.median(err) < 0.05 and err.max() < 0.6, 'median %.3f max %.2f' % (np.median(err), err.max()))


def at(x, y, r):
    return np.hypot(gx - x, gy - y) <= r


px, py, pr, pd = D['pit']
check('the lid closes the pit', np.abs(R['lid'] - gz)[at(px, py, pr)].max() < 0.5, '%.2f' % np.abs(R['lid'] - gz)[at(px, py, pr)].max())
xyz, dep, kind, dbg = R['xyz'], R['depth'], R['kind'], R['dbg']
dx, dy = dbg['x'], dbg['y']
check('debug rows are the below returns', len(dx) == int((kind < 3).sum()))


def near(x, y, r):
    return np.hypot(dx - x, dy - y) <= r


# ---- the vertical pit (on the tile line x = 96)
m = near(px, py, pr + 0.3)
check('pit: its returns are below, in a group', m.sum() >= 180 and (dbg['kind'][m] == 0).all(), '%d' % m.sum())
check('pit: most returns are open (a true entrance), way out straight up', dbg['open'][m].mean() > 0.5 and not dbg['sideways'][m].any(), '%.2f' % dbg['open'][m].mean())
check('pit: depth is right', abs(dbg['depth'][m].max() - pd) < 0.5, '%.2f' % dbg['depth'][m].max())
h1 = R['holes'] == 1; h2 = R['holes'] == 2
check('pit: a true-entrance hole about its size', 0.5 * np.pi * pr * pr < h1[at(px, py, pr + 1.5)].sum() * cell * cell < 2.2 * np.pi * pr * pr and h1[at(px, py, pr - 0.6)].all(),
      '%.1f m2' % (h1[at(px, py, pr + 1.5)].sum() * cell * cell))
check('pit: the hole is not spread beyond it', not h1[at(px, py, pr + 4) & ~at(px, py, pr + 1.5)].any())
# ---- the slanted pit and the deep group joined to it
sx, sy, sr, sl = D['slant']; ex, ey, ed = D['slant_deep']
ms = (np.abs(dy - sy) < 1.6) & (dx > sx - 1) & (dx < sx + sl + 1); md = near(ex, ey, 2.0)
check('slanted pit: in a group, open at the mouth, roofed below', ms.sum() >= 150 and (dbg['kind'][ms] == 0).all() and 3 <= dbg['open'][ms].sum() < 0.5 * ms.sum(), '%d open of %d' % (dbg['open'][ms].sum(), ms.sum()))
check('deep group: roofed, in a group', md.sum() >= 25 and (dbg['kind'][md] == 0).all() and not dbg['open'][md].any())
fs = np.unique(dbg['feature'][ms]); fd = np.unique(dbg['feature'][md])
check('deep group: joined to the slanted pit (one feature)', len(fd) == 1 and fd[0] >= 0 and fd[0] in fs, '%s %s' % (fs, fd))
check('slanted pit: a true-entrance hole at its mouth', h1[at(sx + 1, sy, sr)].sum() >= 10, '%d' % h1[at(sx + 1, sy, sr)].sum())
check('deep group: no hole cut above it', not h1[at(ex, ey, 1.5)].any())
tl = dbg['link_len'][md & (dbg['link'] == 1)]
check('deep group: it hangs on a tie of about 8 m (under max_link), not on a way out of 14 m', len(tl) and 6.0 < tl.max() <= 12.0 and not (dbg['link'][md] == 3).any()
      and dbg['way_out'][md].min() > 12.0, '%s' % (np.round(tl.max(), 1) if len(tl) else None))
# ---- two returns 15 m straight down, nothing between them and the surface: no shape, no hole, likely noise
qx, qy, qd = D['deep_pair']; m = near(qx, qy, 0.5)
check('deep pair: written as likely noise, in no feature', m.sum() == 2 and (dbg['kind'][m] == 2).all() and (dbg['feature'][m] == -1).all() and R['J']['counts']['no_link'] == 2,
      '%s %s' % (dbg['kind'][m], R['J']['counts'].get('no_link')))
check('deep pair: no hole, no patch', not (R['holes'] > 0)[at(qx, qy, 4)].any())
check('params say max_link', R['J']['params'].get('max_link') == 12.0)
# ---- the wall: its face returns are under the lid but on the face; the opening at its foot is a feature
ox, ol = D['cliff_open']; oy = D['cliff_y']; run_ = D['cliff_run']
check('wall: thousands of its face returns are candidates (under the lid)', R['J']['counts']['on_face'] > 5000, str(R['J']['counts']['on_face']))
band = (dy > oy - 1.5) & (dy < oy + run_ + 1.5) & (np.abs(dx - ox) > 3)
check('wall: none of them is below ground', band.sum() == 0, '%d' % band.sum())
gband = (gy > oy - 1.5) & (gy < oy + run_ + 1.5) & (np.abs(gx - ox) > 4)
check('wall: no hole, no guessed opening on it', not (R['holes'] > 0)[gband].any(), '%d' % (R['holes'] > 0)[gband].sum())
mc = (np.abs(dx - ox) < 1.3) & (dy > oy) & (dy < oy + run_ + ol + 0.5)
check('opening at the foot of the wall: in a group, one feature', mc.sum() >= 50 and (dbg['kind'][mc] == 0).all() and len(np.unique(dbg['feature'][mc])) == 1, '%d' % mc.sum())
check('opening: depths are how far behind the face (1 to 3 m), not the height of the wall', dbg['depth'][mc].min() >= 1.0 and 2.5 < dbg['depth'][mc].max() < 4.0,
      '%.2f..%.2f' % (dbg['depth'][mc].min(), dbg['depth'][mc].max()))
check('opening: the way out is sideways, and open where the face has its gap', dbg['sideways'][mc].mean() > 0.9 and dbg['open'][mc].mean() > 0.3, '%.2f %.2f' % (dbg['sideways'][mc].mean(), dbg['open'][mc].mean()))
check('opening: its hole is on the wall line, not on the ground above the passage', (h1 | h2)[(np.abs(gx - ox) < 2) & (np.abs(gy - oy) < 2.0)].any() and
      not h1[(np.abs(gx - ox) < 2) & (gy > oy + run_ + 1.5) & (gy < oy + run_ + ol)].any())
# ---- the two small pits
qx, qy, qr, qd = D['pit_shallow']
check('pit 0.8 m deep: not found (no return, no hole)', near(qx, qy, qr + 1).sum() == 0 and not (R['holes'] > 0)[at(qx, qy, qr + 1)].any(), '%d' % near(qx, qy, qr + 1).sum())
qx, qy, qr, qd = D['pit_low']; m = near(qx, qy, qr + 0.3)
check('pit 1.5 m deep: found, in a group, its depth right', m.sum() >= 40 and (dbg['kind'][m] == 0).all() and abs(np.median(dbg['depth'][m]) - qd) < 0.15, '%d' % m.sum())
check('pit 1.5 m deep: a true-entrance hole', h1[at(qx, qy, qr)].sum() >= 30, '%d' % h1[at(qx, qy, qr)].sum())
# ---- the crack
c0, c1, cy, cw, cd = D['crack']
mk = (dx > c0) & (dx < c1) & (np.abs(dy - cy) < 0.5)
check('crack: in a group', mk.sum() >= 75 and (dbg['kind'][mk] == 0).all(), '%d' % mk.sum())
check('crack: open returns and a true-entrance hole along it', dbg['open'][mk].sum() >= 5 and h1[(gx > c0) & (gx < c1) & (np.abs(gy - cy) < 1.0)].sum() >= 20)
# ---- lone returns
lx, ly, ld = D['lone_far']; m = near(lx, ly, 0.5)
check('lone return far from any other: likely noise', m.sum() == 1 and dbg['kind'][m][0] == 2 and abs(dbg['depth'][m][0] - ld) < 0.3)
lx, ly, ld = D['lone_near']; m = near(lx, ly, 0.3)
check('lone return near a feature: lone', m.sum() == 1 and dbg['kind'][m][0] == 1)
check('lone returns are in no feature', (dbg['feature'][dbg['kind'] > 0] == -1).all() and (dbg['feature'][dbg['kind'] == 0] >= 0).all())
# ---- the striped pass
P = {p['id']: p for p in R['J']['passes']}
check('the striped pass is flagged, the others are not', P[D['stripe_pass']]['flagged'] and not any(p['flagged'] for k, p in P.items() if k != D['stripe_pass']), str(R['J']['passes']))
x0, x1, y0, y1 = D['stripes']; nstripe = len(np.arange(x0 + 2, x1, 4.0)) * len(np.arange(y0 + 5, y1 - 5, 1.0))
k3 = kind == 3
check('the stripes are set aside', k3.sum() == nstripe, '%d of %d' % (k3.sum(), nstripe))
check('set aside = in the points file as kind 3, with their depth', (dep[k3] > 3).all() and (xyz[k3, 0] > x0).all())
check('no stripe became a group', not ((dx > x0 + 1) & (dbg['depth'] > 3) & (np.hypot(dx - D['confirmed'][0], dy - D['confirmed'][1]) > 2) & (np.abs(dy - cy) > 2) &
                                        (dy < D['cliff_y'] - 2)).any())
kx, ky, kd = D['confirmed']; m = near(kx, ky, 1.5)
check('returns of the striped pass that another pass confirms are kept', m.sum() == 9 and R['J']['counts']['pattern_confirmed'] == 3, '%d %d' % (m.sum(), R['J']['counts']['pattern_confirmed']))
# ---- every shape reaches the surface
import veg_mesh
lab, nc = veg_mesh.components(nv, st.astype(np.int64))
used = np.zeros(nv, bool); used[st.ravel()] = True
top = np.full(nc, np.inf); np.minimum.at(top, lab[used], sd[used]); top = top[np.isfinite(top)]
check('every shape reaches the surface', R['J']['counts']['not_reaching'] == 0 and len(top) > 0 and top.max() < 0.75, '%d pieces, highest vertex of the worst %.2f m down' % (len(top), top.max()))
check('deep pair: no shape', not (np.hypot(sv[:, 0] - D['deep_pair'][0], sv[:, 1] - D['deep_pair'][1]) < 4).any())
for name, (x, y, r) in dict(pit=(px, py, 3.5), slant=(sx + 4, sy, 5), deep=(ex, ey, 3), cliff=(ox, oy + 2, 4), crack=((c0 + c1) / 2, cy, 9)).items():
    check('a shape at the ' + name, (np.hypot(sv[:, 0] - x, sv[:, 1] - y) < r).sum() > 10)
flatg = np.abs(sv[:, 1] - D['cliff_y']) > 1.5          # (the lid between two cells of a cliff is not a height)
check('shapes stay under the lid', (sd >= 0).all() and (sv[:, 2] <= rw.bilin(R['lid'].astype('f8'), sv[:, 0].astype('f8'), sv[:, 1].astype('f8'), cell) + 0.35)[flatg].all())
check('the pit shape goes to its floor', sd[np.hypot(sv[:, 0] - px, sv[:, 1] - py) < 3.5].max() > pd - 1.0)
check('shapes are light', nt < 40000, '%d triangles' % nt)
# ---- brush
b0, b1, b2, b3 = D['brush']; S = 0.9
bj, bi = np.mgrid[0:R['brush'].shape[0], 0:R['brush'].shape[1]]; bx = (bi + 0.5) * S; by = (bj + 0.5) * S
inp = (bx > b0 + 1) & (bx < b1 - 1) & (by > b2 + 1) & (by < b3 - 1); outp = (bx < b0 - 1) | (bx > b1 + 1) | (by < b2 - 1) | (by > b3 + 1)
check('brush: the patch reads about 0.4', abs(np.nanmean(R['brush'][inp]) - 0.4) < 0.06, '%.3f' % np.nanmean(R['brush'][inp]))
check('brush: none elsewhere, blank where too few returns reach', np.nanmax(R['brush'][outp & (np.abs(by - D['cliff_y']) > 2) & (np.abs(by - py) > 6)]) < 0.2 and np.isnan(R['brush']).any())

# ---- the tile cut does not change the result
B = os.path.join(tmp, 'b')
run(['--demo', B, '--debug', '--workers', '1', '--tile', '48'])
Rb = load(B)
ka = np.lexsort(R['xyz'].T); kb = np.lexsort(Rb['xyz'].T)
check('other tiles: the same returns below, the same kinds', len(R['xyz']) == len(Rb['xyz']) and np.array_equal(R['xyz'][ka], Rb['xyz'][kb]) and np.array_equal(R['kind'][ka], Rb['kind'][kb]),
      '%d %d' % (len(R['xyz']), len(Rb['xyz'])))
ca, cb = R['J']['counts'], Rb['J']['counts']
check('other tiles: the same counts', all(ca[k] == cb[k] for k in ('below', 'groups', 'lone', 'likely_noise', 'pattern_noise', 'features')), '%s / %s' % (ca, cb))
check('other tiles: the same lid', np.nanmax(np.abs(R['lid'] - Rb['lid'])) < 0.05, '%.3f' % np.nanmax(np.abs(R['lid'] - Rb['lid'])))
check('other tiles: the same holes', (R['holes'] != Rb['holes']).sum() <= 0.02 * max(1, (R['holes'] > 0).sum()), '%d cells differ of %d' % ((R['holes'] != Rb['holes']).sum(), (R['holes'] > 0).sum()))
check('the pit on the tile line is whole and single', abs(int(h1[at(px, py, pr + 1.5)].sum()) - int((Rb['holes'] == 1)[at(px, py, pr + 1.5)].sum())) <= 3)

# ---- --npz, a polygon, --no-shapes
x, y, z, c, ps, last = rw.demo_points()
npz = os.path.join(tmp, 'pts.npz'); np.savez(npz, x=x + 5000.0, y=y + 7000.0, z=z, c=c, psid=ps, rn=np.ones(len(x), 'u1'), nr=np.where(last, 1, 2).astype('u1'))
ring = os.path.join(tmp, 'ring.json'); json.dump([[5000, 7000], [5120, 7000], [5120, 7090], [5000, 7090]], open(ring, 'w'))
Cd = os.path.join(tmp, 'c')
run(['--npz', npz, '--polygon', ring, '--out', Cd, '--no-shapes', '--workers', '2'])
Rc = load(Cd)
check('--npz: origin taken from the file', Rc['J']['origin'] == [5000.0, 7000.0], str(Rc['J']['origin']))
check('--no-shapes: no shapes.bin', not os.path.exists(os.path.join(Cd, 'shapes.bin')) and Rc['J']['params']['shapes'] is False)
ins = (gx < 120) & (gy < 90)
check('polygon: the lid is blank outside it and whole inside', np.isnan(Rc['lid'][~ins & ((gx > 120.5) | (gy > 90.5))]).all() and np.isfinite(Rc['lid'][(gx < 119.5) & (gy < 89.5)]).all())
check('polygon: no returns, no holes outside', (Rc['xyz'][:, 0] <= 120.01).all() and (Rc['xyz'][:, 1] <= 90.01).all() and not (Rc['holes'] > 0)[~ins].any())
check('polygon: the pits inside are still found', (Rc['holes'] == 1)[at(px, py, pr)].sum() > 50 and Rc['J']['counts']['pattern_noise'] == 0 and 300 < Rc['J']['counts']['below'] < ca['below'])
# ---- --min-behind, and a file without return numbers (every return counts as last)
npz2 = os.path.join(tmp, 'pts2.npz'); np.savez(npz2, x=x, y=y, z=z, c=c, psid=ps)
Dd = os.path.join(tmp, 'd')
run(['--npz', npz, '--out', Dd, '--no-shapes', '--min-behind', '0.5', '--debug', '--workers', '4'])
Rd = load(Dd); qx, qy, qr, qd = D['pit_shallow']
md = np.hypot(Rd['dbg']['x'] - qx, Rd['dbg']['y'] - qy) < qr + 0.3
check('--min-behind 0.5: the 0.8 m pit is found', md.sum() >= 40 and abs(np.median(Rd['dbg']['depth'][md]) - qd) < 0.15 and (Rd['holes'] == 1)[at(qx, qy, qr)].sum() >= 30
      and Rd['J']['params']['min_behind'] == 0.5, '%d' % md.sum())
check('--min-behind 0.5: more returns are below ground', Rd['J']['counts']['below'] > ca['below'], '%d' % Rd['J']['counts']['below'])
Ee = os.path.join(tmp, 'e')
run(['--npz', npz2, '--out', Ee, '--no-shapes', '--debug', '--workers', '4'])
Re = load(Ee); wb = ((Re['dbg']['y'] > oy - 1.5) & (Re['dbg']['y'] < oy + run_ + 1.5) & (np.abs(Re['dbg']['x'] - ox) > 3)).sum()
check('no return numbers: still runs, the wall still not a feature', wb == 0 and abs(Re['J']['counts']['below'] - ca['below']) <= 0.05 * ca['below'], '%d on the wall, %d below' % (wb, Re['J']['counts']['below']))
# ---- a bad pass is bad everywhere: its stripes run on into ground where it is too thin to be flagged on its own
rng = np.random.default_rng(5); n = 400 * 96 * 3
gx_ = rng.uniform(0, 400, n); gy_ = rng.uniform(0, 96, n)
far = (np.hypot(gx_ - 350, gy_ - 30) < 1.6)                                   # a real pit out there, 2.5 m deep
P = [(gx_, gy_, 50 + 0.01 * gx_ + rng.normal(0, 0.03, n) - 2.5 * far, np.full(n, 2), rng.integers(1, 4, n))]
k = 9000; bx_ = rng.uniform(0, 95, k); by_ = rng.uniform(0, 96, k)             # the bad pass: thick in the west ...
P.append((bx_, by_, 50 + 0.01 * bx_, np.full(k, 2), np.full(k, 9)))
for lx in np.arange(4, 95, 4.0):                                              # ... with its stripes there,
    ly = np.arange(5, 91, 1.0); P.append((np.full(len(ly), lx), ly, 50 + 0.01 * lx - 12 - 5 * np.sin(ly / 4), np.full(len(ly), 1), np.full(len(ly), 9)))
k = 2000; bx_ = rng.uniform(300, 395, k); by_ = rng.uniform(0, 96, k)          # and thin in the east: 2000 returns,
P.append((bx_, by_, 50 + 0.01 * bx_, np.full(k, 2), np.full(k, 9)))
ly = np.arange(50, 75, 1.0); P.append((np.full(len(ly), 320.0), ly, 50 + 3.2 - 12 - 5 * np.sin(ly / 4), np.full(len(ly), 1), np.full(len(ly), 9)))     # one stripe of 25 (under the 30 it takes)
k = 12; a_ = rng.uniform(0, 6.28, k)                                           # the bad pass also sees the pit's floor
P.append((350 + 1.2 * np.cos(a_), 30 + 1.2 * np.sin(a_), np.full(k, 50 + 3.5 - 2.5), np.full(k, 1), np.full(k, 9)))
cat = lambda i: np.concatenate([p[i] for p in P])
npz3 = os.path.join(tmp, 'pts3.npz'); np.savez(npz3, x=cat(0), y=cat(1), z=cat(2), c=cat(3).astype('u1'), psid=cat(4).astype('i4'))
Ff = os.path.join(tmp, 'f')
run(['--npz', npz3, '--out', Ff, '--no-shapes', '--debug', '--workers', '4'])
Rf = load(Ff); df = Rf['dbg']; Pf = {p['id']: p for p in Rf['J']['passes']}
tp = df['tile_pass']; east = tp[(tp[:, 2] == 9) & (tp[:, 1] >= 3)]
check('bad pass: flagged in the west, in no block of the east (too thin there)', Pf[9]['flagged'] and Pf[9]['blocks_flagged'] >= 1 and len(east) and not east[:, 9].any(), str(east[:, [1, 6, 9]].tolist()))
st_e = (Rf['xyz'][:, 0] > 319) & (Rf['xyz'][:, 0] < 321) & (Rf['depth'] > 5)
check('bad pass: its stripe in the east is set aside too', st_e.sum() == 25 and (Rf['kind'][st_e] == 3).all() and not ((df['x'] > 319) & (df['x'] < 321) & (df['depth'] > 5)).any(),
      '%d, kinds %s' % (st_e.sum(), np.unique(Rf['kind'][st_e])))
mp_ = np.hypot(df['x'] - 350, df['y'] - 30) < 1.6
check('a real pit seen by the bad pass and by good passes: kept, the bad pass\'s returns in it too', mp_.sum() >= 20 and (df['kind'][mp_] == 0).all() and (df['psid'][mp_] == 9).sum() == 12
      and (df['confirmed_by'][mp_ & (df['psid'] == 9)] != 9).all() and (df['confirmed_by'][mp_ & (df['psid'] == 9)] >= 0).all() and (Rf['holes'] == 1).sum() > 30, '%d, of the bad pass %d' % (mp_.sum(), (df['psid'][mp_] == 9).sum()))
check('ridge.json says what each pass lost', Pf[9]['set_aside'] == int((Rf['kind'] == 3).sum()) and Pf[9]['kept_confirmed'] == 12 and all(p['set_aside'] == 0 for k_, p in Pf.items() if k_ != 9),
      '%s %s' % (Pf[9]['set_aside'], Pf[9]['kept_confirmed']))
check('work folder removed', not os.path.exists(os.path.join(A, '_work')))

import shutil
shutil.rmtree(tmp, ignore_errors=True)
dt = time.time() - T0
check('under 30 s', dt < 30, '%.1f s' % dt)
print('%d passed, %d failed, %.1f s (first run %.1f s; demo: %d returns, %d below, %d groups, %d features, %d shape triangles)' % (
    passes, fails, dt, t_first, ca['returns'], ca['below'], ca['groups'], ca['features'], nt))
sys.exit(1 if fails else 0)
