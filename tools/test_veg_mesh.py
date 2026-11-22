#!/usr/bin/env python3
"""
veg_mesh.py on known shapes (numpy + scipy only, no PDAL, no network).

    python tools/test_veg_mesh.py

Shapes are iso-surfaces of made-up fields (surface nets, as the vegetation
shell): a sphere, a torus, a bumpy slab, two blobs touching at an edge and a
corner, a thin sheet. Pins down:
  * simplify hits the triangle target exactly, keeps the surface closed (every
    edge in two triangles), oriented (counter-clockwise outside: positive
    volume, close to the original), its topology (Euler characteristic), no
    degenerate or needle triangles, and carries a per-vertex attribute;
  * the two-sided surface distance to the original stays small (printed);
  * open borders and non-manifold edges stay where they are;
  * max_error stops early;
  * well_composed makes surface nets manifold on a noisy field;
  * clean drops duplicates, back-to-back sheets, small pieces and smooths a
    spike;
  * distance_to_mesh is right on a sphere;
  * speed: a few hundred thousand triangles simplify in a few seconds.
"""
import math, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import numpy as np
import veg_mesh as vm

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


def grid(n):
    g = np.mgrid[0:n, 0:n, 0:n].astype(np.float64)
    return g - (n - 1) / 2.0


def mesh_of(F, iso=0.0):
    F, _ = vm.well_composed(np.pad(F, 1, constant_values=-1e3), iso)
    V, T = vm.surface_nets(F, iso)
    return V, T


def euler(V, T):
    used = np.unique(T)
    e, _ = vm.edge_counts(T)
    return len(used) - len(e) + len(T)


def closed(T):
    _, c = vm.edge_counts(T)
    return bool(len(c)) and bool(np.all(c == 2))


def min_quality(V, T):
    q, _ = vm._quality(V[T[:, 0]], V[T[:, 1]], V[T[:, 2]])
    return float(q.min())


def report(name, V0, T0_, V1, T1, secs):
    er = vm.mesh_error(V0, T0_, V1, T1, n=20000)
    print(f'  {name:<26} {len(T0_):>8,} -> {len(T1):>7,} triangles  '
          f'mean {er["mean"]:.3f}  p90 {er["p90"]:.3f}  max {er["max"]:.3f}'
          f'  ({secs:.2f} s)')
    return er


print('test_veg_mesh: known shapes (sizes in voxels)')

# ---------------------------------------------------------------- sphere
g = grid(64)
R = 24.0
Fs = R - np.sqrt((g ** 2).sum(0))
Vs, Ts = mesh_of(Fs)
Vs = vm.taubin(Vs, Ts, iters=4)
vol0 = vm.volume(Vs, Ts)
check('sphere extracted closed', closed(Ts))
check('sphere volume ~ 4/3 pi R^3', abs(vol0 / (4 / 3 * math.pi * R ** 3) - 1) < 0.03,
      vol0)
for frac in (0.5, 0.1, 0.02, 0.004):
    tgt = int(len(Ts) * frac)
    t = time.time()
    st = {}
    V1, T1, A1 = vm.simplify(Vs, Ts, tgt, attrs=Vs[:, 2], stats=st)
    er = report(f'sphere to {frac:g}', Vs, Ts, V1, T1, time.time() - t)
    tag = f'sphere {frac:g}: '
    check(tag + 'target hit', tgt - 1 <= len(T1) <= tgt, (len(T1), tgt, st))
    check(tag + 'closed', closed(T1))
    check(tag + 'genus 0', euler(V1, T1) == 2, euler(V1, T1))
    vol = vm.volume(V1, T1)
    vtol = 0.03 if len(T1) > 400 else 0.08       # 86 triangles: a polyhedron
    check(tag + 'outward, volume kept', vol > 0 and abs(vol / vol0 - 1) < vtol,
          vol / vol0)
    check(tag + 'no repeated corners',
          np.all((T1[:, 0] != T1[:, 1]) & (T1[:, 1] != T1[:, 2]) & (T1[:, 0] != T1[:, 2])))
    check(tag + 'no needles', min_quality(V1, T1) > 0.02, min_quality(V1, T1))
    r = np.linalg.norm(V1 - Vs.mean(0), axis=1)
    check(tag + 'on the sphere', np.abs(r - R).max() < (0.03 if len(T1) > 400 else 0.06) * R + 0.3,
          np.abs(r - R).max())
    check(tag + 'error small', er['mean'] < (0.02 if len(T1) > 400 else 0.03) * R and
          er['max'] < 0.1 * R, er)
    check(tag + 'attribute carried', A1.shape == (len(V1),) and
          np.abs(A1 - V1[:, 2]).max() < max(1.0, 3 * er['max']),
          np.abs(A1 - V1[:, 2]).max())
    check(tag + 'stats', st['to_tris'] == len(T1) and st['from_tris'] == len(Ts))

# Attributes with several columns, and a no-op target.
V1, T1, A1 = vm.simplify(Vs, Ts, len(Ts) // 10, attrs=np.stack([Vs[:, 0], -Vs[:, 1]], 1))
check('2-column attribute', A1.shape == (len(V1), 2) and
      np.abs(A1[:, 0] - V1[:, 0]).max() < 2 and np.abs(A1[:, 1] + V1[:, 1]).max() < 2)
V1, T1, _ = vm.simplify(Vs, Ts, len(Ts) + 10)
check('target above the count: unchanged', len(T1) == len(Ts) and np.allclose(V1, Vs))

# ---------------------------------------------------------------- torus
g = grid(72)
Rt, rt = 20.0, 7.0
q = np.sqrt(g[0] ** 2 + g[1] ** 2) - Rt
Ft = rt - np.sqrt(q ** 2 + g[2] ** 2)
Vt, Tt = mesh_of(Ft)
Vt = vm.taubin(Vt, Tt, iters=4)
volt = vm.volume(Vt, Tt)
check('torus genus 1', euler(Vt, Tt) == 0, euler(Vt, Tt))
for frac in (0.1, 0.01):
    tgt = int(len(Tt) * frac)
    t = time.time()
    V1, T1, _ = vm.simplify(Vt, Tt, tgt)
    er = report(f'torus to {frac:g}', Vt, Tt, V1, T1, time.time() - t)
    tag = f'torus {frac:g}: '
    check(tag + 'target hit', tgt - 1 <= len(T1) <= tgt, len(T1))
    check(tag + 'closed', closed(T1))
    check(tag + 'still a torus', euler(V1, T1) == 0, euler(V1, T1))
    big = len(T1) > 1000
    check(tag + 'volume kept', abs(vm.volume(V1, T1) / volt - 1) < (0.05 if big else 0.1),
          vm.volume(V1, T1) / volt)
    check(tag + 'error small', er['mean'] < (0.15 if big else 0.5) and er['max'] < 2.0, er)

# ---------------------------------------------------------------- bumpy slab
n = 80
g = np.mgrid[0:n, 0:n, 0:30].astype(np.float64)
h = 12 + 3 * np.sin(g[0] / 6.0) * np.cos(g[1] / 9.0) + \
    4 * np.exp(-((g[0] - 50) ** 2 + (g[1] - 30) ** 2) / 40.0)
Fb = np.minimum(h - g[2], g[2] - 3)
Fb = np.minimum(Fb, np.minimum(g[0] - 4, n - 5 - g[0]))
Fb = np.minimum(Fb, np.minimum(g[1] - 4, n - 5 - g[1]))
Vb, Tb = mesh_of(Fb)
Vb = vm.taubin(Vb, Tb, iters=4)
tgt = len(Tb) // 30
t = time.time()
V1, T1, _ = vm.simplify(Vb, Tb, tgt)
er = report('bumpy slab to 1/30', Vb, Tb, V1, T1, time.time() - t)
check('slab: target, closed, outward', tgt - 1 <= len(T1) <= tgt and closed(T1) and
      vm.volume(V1, T1) > 0, (len(T1), tgt))
check('slab: error small', er['mean'] < 0.15 and er['max'] < 1.5, er)
# Flat faces get few triangles, the bump many: triangle density on the bump
# (top, near (50, 30)) is higher than on the flat floor (the length term in
# the cost keeps flat triangles from growing without limit, so not by much).
c = V1[T1].mean(1)
nrm = vm.face_normals(V1, T1)
area = 0.5 * np.linalg.norm(nrm, axis=1)
top = nrm[:, 2] > 0
bump = top & (np.hypot(c[:, 0] - 51, c[:, 1] - 31) < 8)
un = nrm / np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
inner = (c[:, 0] > 14) & (c[:, 0] < n - 14) & (c[:, 1] > 14) & (c[:, 1] < n - 14)
bottom = (un[:, 2] < -0.95) & inner          # the flat floor, away from the rim
dens_bump = bump.sum() / max(area[bump].sum(), 1e-9)
dens_bottom = bottom.sum() / max(area[bottom].sum(), 1e-9)
check('slab: more triangles where it bends', dens_bump > 1.5 * dens_bottom,
      (dens_bump, dens_bottom))

# ---------------------------------------------------------------- touching blobs
# Two cubes of voxels meeting only along an edge, and two meeting only at a
# corner: surface nets alone would give non-manifold edges there.
F2 = -np.ones((30, 30, 30))
F2[5:12, 5:12, 5:12] = 1
F2[12:19, 12:19, 5:12] = 1          # edge contact
F2[19:26, 19:26, 12:19] = 1         # corner contact
Vraw, Traw = vm.surface_nets(np.pad(F2, 1, constant_values=-1), 0.0)
_, craw = vm.edge_counts(Traw)
check('touching blobs: raw surface nets is non-manifold', np.any(craw != 2))
Ff, raised = vm.well_composed(np.pad(F2, 1, constant_values=-1), 0.0)
V2, T2 = vm.surface_nets(Ff, 0.0)
check('touching blobs: well_composed raised a few samples', 0 < raised < 20, raised)
check('touching blobs: manifold after', closed(T2))
V2 = vm.taubin(V2, T2, iters=4)
V1, T1, _ = vm.simplify(V2, T2, 300)
check('touching blobs: simplified closed, one piece',
      closed(T1) and len(T1) == 300 and vm.components(len(V1), T1)[1] == 1)

# Noisy field: well_composed always gives a manifold.
rng = np.random.default_rng(5)
from scipy import ndimage
Fn = ndimage.gaussian_filter(rng.random((40, 40, 40)), 0.8)
iso = float(np.percentile(Fn, 70))
Vr, Tr = vm.surface_nets(np.pad(Fn, 1), iso)
_, cr = vm.edge_counts(Tr)
Fw, raised = vm.well_composed(np.pad(Fn, 1), iso)
Vw, Tw = vm.surface_nets(Fw, iso)
_, cw = vm.edge_counts(Tw)
check('noise: non-manifold before, none after', np.any(cr != 2) and np.all(cw == 2),
      (int((cr != 2).sum()), int((cw != 2).sum())))
check('noise: active count = vertices', vm.count_active(Fw, iso) == len(Vw))
Vw = vm.taubin(Vw, Tw, iters=4)
Vw, Tw, _ = vm.clean(Vw, Tw, min_tris=32, spike=0)
t = time.time()
# (hundreds of tunnels: a closed surface of that genus cannot go much lower
# without changing its topology, which simplify never does)
V1, T1, _ = vm.simplify(Vw, Tw, len(Tw) // 5)
report('noisy blobs to 1/5', Vw, Tw, V1, T1, time.time() - t)
check('noise: simplified, closed, no needles', len(Tw) // 5 - 1 <= len(T1) <= len(Tw) // 5
      and closed(T1) and euler(V1, T1) == euler(Vw, Tw)
      and min_quality(V1, T1) > 0.02, (len(T1), min_quality(V1, T1)))

# ---------------------------------------------------------------- thin sheet
# A sheet one voxel thick (the kind of layer that used to give fins): it
# stays a closed, oriented sheet; nothing sticks out of its bounding box.
g = np.mgrid[0:60, 0:60, 0:12].astype(np.float64)
Fsh = np.minimum(0.7 - np.abs(g[2] - 5 - 0.1 * g[0] * 0), np.minimum(
    np.minimum(g[0] - 5, 54 - g[0]), np.minimum(g[1] - 5, 54 - g[1])))
Vh, Th = mesh_of(Fsh)
Vh = vm.taubin(Vh, Th, iters=4)
lo, hi = Vh.min(0), Vh.max(0)
for tgt in (2000, 200):
    V1, T1, _ = vm.simplify(Vh, Th, tgt)
    V1, T1, _ = vm.clean(V1, T1)
    tag = f'thin sheet to {tgt}: '
    check(tag + 'closed, outward', closed(T1) and vm.volume(V1, T1) > 0)
    check(tag + 'nothing sticks out', np.all(V1.min(0) > lo - 0.5) and
          np.all(V1.max(0) < hi + 0.5), (V1.min(0) - lo, V1.max(0) - hi))
    check(tag + 'no needles', min_quality(V1, T1) > 0.02, min_quality(V1, T1))
    report(f'thin sheet to {tgt}', Vh, Th, V1, T1, 0.0)

# ---------------------------------------------------------------- borders
# An open grid (a plane with a border): border vertices never move.
k = 40
xx, yy = np.meshgrid(np.arange(k, dtype=float), np.arange(k, dtype=float))
Vp = np.stack([xx.ravel(), yy.ravel(), 0.3 * np.sin(xx.ravel() / 5)], 1)
idx = np.arange(k * k).reshape(k, k)
a, b, c_, d = idx[:-1, :-1].ravel(), idx[:-1, 1:].ravel(), idx[1:, 1:].ravel(), idx[1:, :-1].ravel()
Tp = np.concatenate([np.stack([a, b, c_], 1), np.stack([a, c_, d], 1)])
border = (Vp[:, 0] == 0) | (Vp[:, 0] == k - 1) | (Vp[:, 1] == 0) | (Vp[:, 1] == k - 1)
V1, T1, A1 = vm.simplify(Vp, Tp, 600, attrs=np.arange(len(Vp), dtype=float))
from scipy.spatial import cKDTree
dd, _ = cKDTree(V1).query(Vp[border])
check('open grid: border kept in place', dd.max() < 1e-9, dd.max())
check('open grid: interior simplified', 599 <= len(T1) <= 600, len(T1))

# ---------------------------------------------------------------- max_error
st = {}
V1, T1, _ = vm.simplify(Vs, Ts, 10, max_error=0.05, stats=st)
check('max_error stops early', len(T1) > 100 and st['stopped'] == 'max_error', (len(T1), st))
er = vm.mesh_error(Vs, Ts, V1, T1, n=10000)
check('max_error respected (typical)', er['mean'] < 0.05, er)

# ---------------------------------------------------------------- clean
Vc, Tc = Vs.copy(), Ts.copy()
extra = np.concatenate([Tc[:5], Tc[5:8][:, ::-1], Tc[10:11][:, [1, 2, 0]]])
dup = np.concatenate([Tc, extra])                     # 5 duplicates, 3 back-to-back, 1 rotated
# a tiny separate piece (a tetrahedron) far away
tv = np.array([[100, 100, 100], [101, 100, 100], [100, 101, 100], [100, 100, 101]], float)
tt = np.array([[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]) + len(Vc)
Vc2 = np.concatenate([Vc, tv])
Tc2 = np.concatenate([dup, tt, [[0, 0, 1]]])          # and a degenerate one
st = {}
V1, T1, _ = vm.clean(Vc2, Tc2, min_tris=20, spike=0, stats=st)
# back-to-back pairs leave a hole of 3 triangles (both copies go)
check('clean: duplicates and degenerate gone', st['duplicates'] >= 6, st)
check('clean: back-to-back sheet dropped', len(T1) == len(Ts) - 3, (len(T1), len(Ts)))
check('clean: small piece dropped', st['pieces_dropped'] == 1 and V1[:, 0].max() < 60, st)
# spike: pull one vertex far out
Vk = Vs.copy()
i = int(np.argmax(Vk[:, 2]))
Vk[i, 2] += 15
st = {}
V1, T1, _ = vm.clean(Vk, Ts, spike=0.35, stats=st)
check('clean: spike smoothed back', st['spikes_smoothed'] >= 1 and V1[:, 2].max() < Vs[:, 2].max() + 1.0,
      (st, V1[:, 2].max() - Vs[:, 2].max()))
V1, T1, _ = vm.clean(Vs, Ts)
check('clean: a good mesh is left alone', len(T1) == len(Ts) and np.allclose(V1, Vs))

# ---------------------------------------------------------------- distance
pts = rng.normal(size=(500, 3))
pts /= np.linalg.norm(pts, axis=1, keepdims=True)
cen = Vs.mean(0)
for off in (0.0, 2.0, -3.0):
    d = vm.distance_to_mesh(cen + pts * (R + off), Vs, Ts)
    check(f'distance at {off:+g}', np.abs(d - abs(off)).max() < 0.35, np.abs(d - abs(off)).max())

# ---------------------------------------------------------------- speed
g = grid(200)
Fbig = 88.0 - np.sqrt((g ** 2).sum(0)) + 2.5 * np.sin(g[0] / 7) * np.sin(g[1] / 5) * np.sin(g[2] / 6)
Vg, Tg = vm.surface_nets(np.pad(Fbig, 1, constant_values=-1e3), 0.0)
del Fbig, g
t = time.time()
st = {}
V1, T1, _ = vm.simplify(Vg, Tg, len(Tg) // 30, stats=st)
secs = time.time() - t
report('bumpy ball (speed)', Vg, Tg, V1, T1, secs)
check('speed: big mesh', len(Tg) > 250000 and secs < 20 and len(T1) >= len(Tg) // 30 - 1,
      (len(Tg), secs))

print(f'test_veg_mesh: {passes} passed, {fails} failed ({time.time() - T0:.1f} s)')
sys.exit(1 if fails else 0)
