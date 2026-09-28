#!/usr/bin/env python3
"""
Regression tests for the portable export's coordinate frame and hillshade.

No PDAL, no network: everything runs on synthetic data. Run from the FLEX
folder with the same Python that runs the exporter:

    python tools/test_export_frame.py

What it pins down, and why each one once went wrong:
  * UTM forward/inverse agree to well under a millimetre.
  * The export rectangle covers every part of the drawn lat/lon box. Off the
    zone's central meridian a lat/lon box is rotated in UTM, so a dataset
    stored in lat/lon or web mercator came back as a tilted footprint and the
    empty corner wedges were filled by smearing the edge sideways.
  * Border regions with no data are dropped from the mesh, while interior
    holes (canopy, water) are kept and filled.
  * Web-mercator imagery lands on the UTM grid with no offset.
  * The hillshade hole-fill leaves no steps (steps shade as jagged lines).
"""
import math, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import numpy as np
import export_terrain as et
from PIL import Image

fails = 0
passes = 0
def check(label, ok, detail=''):
    global fails, passes
    if ok:
        passes += 1
    else:
        fails += 1
        print('FAIL', label, detail)

# ── 1. UTM round trip ─────────────────────────────────────────────────────────
rng = np.random.default_rng(7)
for lat0, lon0 in [(36.5, -100.9), (41.5, -88.5), (-33.9, 18.4), (4.6, -74.1), (64.8, -147.7)]:
    zone = et.utm_zone_for(lon0); south = lat0 < 0
    worst = 0.0
    for _ in range(50):
        la = lat0 + rng.uniform(-0.2, 0.2); lo = lon0 + rng.uniform(-0.2, 0.2)
        e, n, _ = et.latlon_to_utm(la, lo, zone)
        la2, lo2 = et.utm_to_latlon(e, n, zone, south)
        err = math.hypot((float(la2) - la) * 111320, (float(lo2) - lo) * 111320 * math.cos(math.radians(la)))
        worst = max(worst, err)
    check(f'UTM round trip at {lat0},{lon0}', worst < 0.002, f'{worst * 1000:.3f} mm')

# ── 2. Rectangle covers the whole drawn box, far off the central meridian ────
box = (-100.915, 36.500, -100.900, 36.530)          # 1.9 deg west of zone 14's meridian
zone = et.utm_zone_for(-100.9)
rect = et.utm_rect_covering(box, zone, 0.5)
t = np.linspace(0, 1, 101)
edge = ([(box[1], box[0] + (box[2] - box[0]) * s) for s in t] + [(box[3], box[0] + (box[2] - box[0]) * s) for s in t] +
        [(box[1] + (box[3] - box[1]) * s, box[0]) for s in t] + [(box[1] + (box[3] - box[1]) * s, box[2]) for s in t])
inside = all(rect[0] - 1e-6 <= et.latlon_to_utm(la, lo, zone)[0] <= rect[2] + 1e-6 and
             rect[1] - 1e-6 <= et.latlon_to_utm(la, lo, zone)[1] <= rect[3] + 1e-6 for la, lo in edge)
check('UTM rectangle covers every edge point of the drawn box', inside)
# Parallels curve in UTM: the SW/NE corners alone miss a strip along the north
# and south edges (the old exporter took just those two).
old_h = et.latlon_to_utm(box[3], box[2], zone)[1] - et.latlon_to_utm(box[1], box[0], zone)[1]
check('rectangle is taller than the old two-corner box', (rect[3] - rect[1]) - old_h > 20,
      f'{(rect[3] - rect[1]) - old_h:.1f} m')
ll = et.latlon_box_covering(rect, zone)
check('lat/lon query box covers the rectangle', ll[0] <= box[0] and ll[1] <= box[1] and ll[2] >= box[2] and ll[3] >= box[3])

# ── 3. Border no-data vs interior holes ───────────────────────────────────────
res = 0.5
valid = rng.random((400, 600)) < 0.6                 # sparse ground returns: 40% empty cells
valid[:80, :] = False                                # dataset ends: west 40 m has nothing
valid[200:215, 300:320] = False                      # a pond inside the data
drop = et.border_nodata_mask(valid, res, progress=lambda m: None)
check('border strip with no data is dropped', drop[:72, :].mean() > 0.95, f'{drop[:72, :].mean():.2f}')
check('interior pond is kept (filled, not cut)', not drop[200:215, 300:320].any())
check('sparse single empty cells are kept', drop[120:, :].mean() < 0.01, f'{drop[120:, :].mean():.3f}')

# ── 4. Mesh leaves the dropped region empty ──────────────────────────────────
dem = np.fromfunction(lambda i, j: 0.02 * i + 0.01 * j, (120, 160)).astype(np.float32)
xb = np.arange(121) * res; yb = np.arange(161) * res
dmask = np.zeros(dem.shape, bool); dmask[:30, :] = True; dmask[:, 140:] = True
v, f = et.build_mesh(dem, xb, yb, 0, 0, max_triangles=50000, progress=lambda m: None, drop=dmask)
rows, cols = dem.shape
cen = v[f].mean(axis=1)
ci = np.clip(np.rint((cen[:, 0] + (rows - 1) * res / 2) / res).astype(int), 0, rows - 1)
cj = np.clip(np.rint((cen[:, 1] + (cols - 1) * res / 2) / res).astype(int), 0, cols - 1)
check('no triangle centroid falls in a dropped cell', not dmask[ci, cj].any())
check('every vertex is used', len(np.unique(f)) == len(v))

# ── 5. Web-mercator imagery lands on the UTM grid ────────────────────────────
grid = et.UtmGrid(rect[0], rect[1], rect[0] + 600, rect[1] + 900, zone)
def pattern(E, N):
    return ((np.floor(E / 10) + np.floor(N / 10)) % 2) * 160 + 40
zoom, tile_px = 18, 256
llb = grid.latlon_box(margin_m=10)
wx0, wy0 = et._merc_world_px(llb[0], llb[3], zoom, tile_px)
wx1, wy1 = et._merc_world_px(llb[2], llb[1], zoom, tile_px)
ox, oy = math.floor(wx0), math.floor(wy0)
W, H = math.ceil(wx1) - ox, math.ceil(wy1) - oy
n = (2 ** zoom) * tile_px
I, J = np.meshgrid(np.arange(W) + ox + 0.5, np.arange(H) + oy + 0.5)
lon = I / n * 360 - 180
lat = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * J / n))))
EN = np.array([et.latlon_to_utm(a, b, zone)[:2] for a, b in zip(lat.ravel(), lon.ravel())])
merc = pattern(EN[:, 0], EN[:, 1]).reshape(H, W).astype(np.uint8)
canvas = Image.fromarray(np.dstack([merc] * 3))
ow, oh = grid.tex_dims(1200)
out = np.asarray(et.warp_mercator_to_utm(canvas, (ox, oy), zoom, tile_px, grid, ow, oh))[..., 0].astype(float)
pw, ph = grid.width / ow, grid.height / oh
Ii, Jj = np.meshgrid(np.arange(ow) + 0.5, np.arange(oh) + 0.5)
truth = pattern(grid.e0 + Ii * pw, grid.n1 - Jj * ph)
def best_shift(a, b, r=4):
    return max((np.corrcoef(a[r + dy:a.shape[0] - r + dy, r + dx:a.shape[1] - r + dx].ravel(),
                            b[r:-r, r:-r].ravel())[0, 1], dx, dy)
               for dy in range(-r, r + 1) for dx in range(-r, r + 1))
for name, sl in {'NW': (slice(0, 200), slice(0, 200)), 'SE': (slice(-200, None), slice(-200, None))}.items():
    c, dx, dy = best_shift(out[sl], truth[sl])
    check(f'imagery registration {name}', dx == 0 and dy == 0 and c > 0.9, f'shift {dx},{dy} corr {c:.3f}')

# ── 6. Hole fill is smooth ───────────────────────────────────────────────────
ramp = np.fromfunction(lambda i, j: 0.3 * i + 0.1 * j, (200, 200))
w = (rng.random(ramp.shape) < 0.3).astype(np.float32)
w[60:120, 60:120] = 0                                  # a big hole
filled = et.push_pull_fill((ramp * w).astype(np.float32), w)
err = np.abs(filled - ramp)[70:110, 70:110]
check('push-pull fills a hole in a sloping plane', err.max() < 0.4, f'max err {err.max():.2f}')
g = np.abs(np.diff(filled[60:120, 60:120], axis=1) - 0.1)
check('filled gradient has no jumps', g.max() < 0.08, f'max step error {g.max():.3f}')

# ── 7. Hillshade basics ─────────────────────────────────────────────────────
hs = et.multidirectional_hillshade(filled.astype(np.float32), 0.5, 0.5)
check('hillshade is uint8 with the grid shape', hs.dtype == np.uint8 and hs.shape == filled.shape)
cell, why, want = et.auto_hillshade_cell(4_000_000, 450_000, 400, 1120)
check('auto cell ~ one ground return per cell', 0.3 <= cell <= 0.4, f'{cell} ({why})')
cell, why, _ = et.auto_hillshade_cell(80_000_000, 9e6, 3000, 3000)
check('large areas are capped', cell >= 3000 / 16384 and 'capped' in why, f'{cell} ({why})')

print(('FAILED ' if fails else 'ok ') + f'{passes}/{passes + fails} checks')
sys.exit(1 if fails else 0)
