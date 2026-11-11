#!/usr/bin/env python3
"""
veg_shapes.py -- light 3D shapes of the vegetation for FLEX.

    python veg_shapes.py --params PARAMS.json --out OUTDIR [--points-npz FILE]
    python veg_shapes.py --demo OUTDIR           (made-up scene, no PDAL)

From the LiDAR of an area and the ground under it, two "looks" that are much
lighter to draw and to keep than the cloud:

  shapes  one simple crown per tree (dome or cone) plus low mounds for brush
  shell   a smoothed skin around the vegetation points (a "canopy cloud")

The contract with FLEX (params, veg.json, the .bin layouts) is in the
vegetation brief; outputs in OUTDIR:

    veg.json     the index: origin, frame, bbox, counts, stats, params
    shapes.bin   N x 8 float32: x y zg height radius base kind density
    shell.bin    V x 4 float32 (x y z hag) then T x 3 uint32 (CCW outside)
    ground.bin   ny x nx float32, row 0 south, the job's ground (coarse)
    preview.png  top-down picture (ground shading, canopy, crowns, brush)

params.json: source {ept, ept_also} or {npz}; area (lon/lat ring; optional
with npz); looks; detail low|medium|high; min_height (0.5); brush_top (2.0);
max_triangles (300000).

How, in plain words:

  ground    route_cost's corrected cloth from below (cloth_below) on the
            lowest ground return of each cell; not export_terrain.build_dem,
            which lets convex ground sink. Height above ground (HAG) per
            point by bilinear sampling.
  cleaning  vegetation = classes 0, 1, 3, 4, 5 (1 = unclassified counts:
            many clouds have only 1 and 2) between min_height and 100 m up.
            Dropped: noise (7, 18), buildings (6), water, wires and other
            classes; returns with almost no others in the 6 x 6 x 6 m box
            hanging below them (birds, stray multipath, wires over open
            ground); on steep ground returns that do not clear the highest
            ground within 1 m (> 45 deg) or 2 m (> 60 deg) by min_height (a cliff face
            beside its own top); and "rock": returns in cells where
            the ground is steep, no return in 3 m around reaches the
            ground and nothing within 6 m stands 4 m tall (a rock knob the
            cloth bridged is not brush; a crown hiding the ground is taller).
  trees     canopy height model (max HAG per cell, pits filled), smoothed;
            tops = local maxima in a window that grows with height (octagon
            max filters); crowns by a marker watershed (flooding by levels from the tops),
            cut at a floor and a reach that grow with the tree's height.
            Per crown: radius from its area, height from its highest
            return, base where the crown's vertical profile of returns runs
            out going down from its densest metre, density = share of the
            column's returns caught by the crown, and the kind from how fast
            the CHM falls away from the top (pointed apex = cone).
  brush     returns min_height..brush_top, as a share of all returns per
            cell; cells under trees whose crown starts low are the tree's
            own branches and are left out. Brushy cells are pooled in tiles
            a few metres across: one mound per tile at the brushy cells'
            centre, radius from their area, height = 75th percentile of the
            cells' tops. Tiles grow if the record budget is exceeded.
  shell     occupancy voxels (x, y, HAG; half as tall as wide) of the
            cleaned returns, Gaussian smoothed, surface nets (a vertex per
            crossing cube, a quad per crossing edge), Taubin smoothed;
            coarser voxels until the triangle count fits the budget (the
            smaller of max_triangles and the detail's triangles per km2). Vertices go back to absolute
            heights on the job's ground.

The local frame: x, y are metres east and north of the origin on the tangent
plane at the origin, computed exactly for every output point (UTM -> lat/lon
-> ECEF at the origin's height -> ENU), so grid convergence and the UTM scale
factor are both taken out; z stays the cloud's own height. The ground grid
uses the inverse map fitted by a quadratic (residual reported, ~mm).

Structure: everything after the point reader works on numpy arrays, so it is
tested without PDAL (tools/test_veg_shapes.py). PDAL is needed only to read
EPT or LAS/LAZ (route_cost.read_points).
"""

import json
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import lidar_derive as ld          # Grid, sample_bilinear, write_png
import route_cost as rc            # read_points, Points, cloth_below, ...

VERSION = 1
GROUND_CLASS = 2
VEG_CLASSES = (0, 1, 3, 4, 5)      # never classified, unclassified, veg
NOISE_CLASSES = (7, 18)
MAX_HAG = 100.0                    # taller "vegetation" is an error
ROCK_MAX_H = 4.0                   # bare-rock "vegetation" is lower than this
RECORD = 8                         # float32 per shapes.bin record

DETAIL = {
    #        CHM cell, CHM smoothing sigma (m), finest shell voxel, brush
    #        tile, ground.bin cell, shape records per km2, shell triangles
    #        per km2 (the job's budget is the smaller of this and
    #        max_triangles)
    "low":    dict(chm=1.0, smooth=0.9, voxel=3.0, tile=6.0, gcell=10.0,
                   budget=30000, tri_km2=100000),
    "medium": dict(chm=0.5, smooth=0.6, voxel=2.0, tile=4.0, gcell=5.0,
                   budget=60000, tri_km2=300000),
    "high":   dict(chm=0.5, smooth=0.5, voxel=1.25, tile=3.0, gcell=5.0,
                   budget=120000, tri_km2=1000000),
}

say_default = rc.ascii_say


# --------------------------------------------------------------------------
# The local east/north frame
# --------------------------------------------------------------------------

_A, _F = 6378137.0, 1 / 298.257223563
_E2 = _F * (2 - _F)


def _ecef(lat, lon, h):
    la, lo = np.radians(lat), np.radians(lon)
    N = _A / np.sqrt(1 - _E2 * np.sin(la) ** 2)
    return ((N + h) * np.cos(la) * np.cos(lo),
            (N + h) * np.cos(la) * np.sin(lo),
            (N * (1 - _E2) + h) * np.sin(la))


class Frame:
    """UTM <-> local east/north metres on the tangent plane at the origin."""

    def __init__(self, zone, south, e0, n0, h0):
        self.zone, self.south = zone, south
        self.e0, self.n0, self.h0 = float(e0), float(n0), float(h0)
        lat, lon = rc.et().utm_to_latlon(np.array([e0]), np.array([n0]),
                                         zone, south)
        self.lat0, self.lon0 = float(lat[0]), float(lon[0])
        self.X0 = np.array(_ecef(self.lat0, self.lon0, self.h0), float)
        la, lo = math.radians(self.lat0), math.radians(self.lon0)
        self.R = np.array([[-math.sin(lo), math.cos(lo), 0.0],
                           [-math.sin(la) * math.cos(lo),
                            -math.sin(la) * math.sin(lo), math.cos(la)]])
        self._inv = None

    def to_enu(self, e, n):
        e = np.asarray(e, np.float64); n = np.asarray(n, np.float64)
        lat, lon = rc.et().utm_to_latlon(e, n, self.zone, self.south)
        X, Y, Z = _ecef(lat, lon, self.h0)
        d = np.stack([X - self.X0[0], Y - self.X0[1], Z - self.X0[2]])
        out = np.tensordot(self.R, d, axes=1)
        return out[0], out[1]

    def fit_inverse(self, bbox_utm):
        """Quadratic map east/north -> UTM over the bbox; returns the max
        residual in metres (checked on points between the fit's)."""
        x0, y0, x1, y1 = bbox_utm
        pad = 50.0
        g = np.linspace(0, 1, 17)
        E, N = np.meshgrid(x0 - pad + (x1 - x0 + 2 * pad) * g,
                           y0 - pad + (y1 - y0 + 2 * pad) * g)
        E, N = E.ravel(), N.ravel()
        xe, yn = self.to_enu(E, N)
        A = self._basis(xe, yn)
        self._inv = (np.linalg.lstsq(A, E - self.e0, rcond=None)[0],
                     np.linalg.lstsq(A, N - self.n0, rcond=None)[0])
        gm = (g[:-1] + g[1:]) / 2
        E2, N2 = np.meshgrid(x0 + (x1 - x0) * gm, y0 + (y1 - y0) * gm)
        xe2, yn2 = self.to_enu(E2.ravel(), N2.ravel())
        eb, nb = self.to_utm(xe2, yn2)
        return float(np.max(np.hypot(eb - E2.ravel(), nb - N2.ravel())))

    @staticmethod
    def _basis(x, y):
        x = np.asarray(x, np.float64) / 1000.0
        y = np.asarray(y, np.float64) / 1000.0
        return np.stack([np.ones_like(x), x, y, x * x, x * y, y * y,
                         x ** 3, x * x * y, x * y * y, y ** 3], axis=1)

    def to_utm(self, x, y):
        A = self._basis(x, y)
        return A @ self._inv[0] + self.e0, A @ self._inv[1] + self.n0

    def lonlat(self):
        return self.lon0, self.lat0


# --------------------------------------------------------------------------
# Small raster helpers
# --------------------------------------------------------------------------

def polygon_mask(ring_xy, grid):
    """Cells of an ld.Grid whose centres are inside the polygon (even-odd)."""
    cx = grid.minx + (np.arange(grid.nx) + 0.5) * grid.cell
    cy = grid.maxy - (np.arange(grid.ny) + 0.5) * grid.cell
    X, Y = np.meshgrid(cx, cy)
    inside = np.zeros(X.shape, bool)
    pts = list(ring_xy)
    if pts[0] != pts[-1]:
        pts.append(pts[0])
    for (xa, ya), (xb, yb) in zip(pts[:-1], pts[1:]):
        if ya == yb:
            continue
        crosses = (ya > Y) != (yb > Y)
        xi = xa + (Y - ya) * (xb - xa) / (yb - ya)
        inside ^= crosses & (X < xi)
    return inside


def ring_area(ring):
    p = np.asarray(ring, float)
    x, y = p[:, 0], p[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def octagon_max(a, r_cells):
    """Max over an octagon of radius r cells (two separable rectangles), a
    cheap stand-in for a disc that keeps the window round-ish."""
    from scipy import ndimage
    r = int(max(1, round(r_cells)))
    s = int(max(0, round(r * 0.70710678 * 1.0)))
    big = 2 * r + 1
    small = 2 * s + 1
    m1 = ndimage.maximum_filter(a, size=(big, small), mode="nearest")
    m2 = ndimage.maximum_filter(a, size=(small, big), mode="nearest")
    m3 = ndimage.maximum_filter(a, size=(2 * int(round(r * 0.85)) + 1,) * 2,
                                mode="nearest")
    return np.maximum(np.maximum(m1, m2), m3)


def window_radius(h):
    """Local-maximum window radius (m) for a top of height h: wider for taller
    trees, whose crowns are wider and whose tops sit further apart."""
    return np.clip(0.9 + 0.055 * np.asarray(h, float), 1.0, 4.5)


def crown_reach(h):
    """How far (m) a crown may spread from its top."""
    return np.clip(1.5 + 0.28 * np.asarray(h, float), 2.0, 14.0)


# --------------------------------------------------------------------------
# Ground and the cleaned vegetation returns
# --------------------------------------------------------------------------

def build_ground(P, grid, say):
    """route_cost's cloth from below on the lowest ground return per cell."""
    t0 = time.time()
    n_ground = int((P.cls == GROUND_CLASS).sum()) if P.cls is not None else 0
    use_class = n_ground >= 50
    if not use_class:
        say("  no ground class: the cloth works on all returns")
    sub = slice(None, None, max(1, len(P) // 2_000_000))
    zs = P.z[sub].astype(np.float64)
    cs = P.cls[sub] if (P.cls is not None and use_class) else None
    zlo, zhi = ld.plausible_ground_band(zs, cs)

    def ground_sel(c, z):
        m = (z >= zlo) & (z <= zhi)
        if c is not None:
            m &= ~np.isin(c, NOISE_CLASSES)
            if use_class:
                m &= c == GROUND_CLASS
        return m

    zmin = np.full(grid.nx * grid.ny, np.inf)
    for x, y, z, _c in P.chunks(ground_sel):
        np.minimum.at(zmin, grid.flat(x, y), z)
    zmin[~np.isfinite(zmin)] = np.nan
    zmin = zmin.reshape(grid.shape)
    valid = np.isfinite(zmin)
    if not valid.any():
        raise RuntimeError("no ground points inside the area")
    dem = rc.cloth_below(rc.nearest_fill(zmin), grid.cell)
    say(f"  ground {grid.nx}x{grid.ny} @ {grid.cell} m, cells with ground "
        f"returns {valid.mean() * 100:.1f}% ({time.time() - t0:.1f} s)")
    return dem, valid


class Veg:
    """The cleaned vegetation returns: local UTM offsets (float32) and HAG."""


def cliff_guard(dem, slope, cell):
    """The highest ground within 1 m on steep cells (> 45 deg) and within
    2 m on cliffs (> 60 deg); elsewhere the ground itself. A return must
    clear it by min_height to count as vegetation: a cliff face stands next
    to its own top, a shrub does not."""
    from scipy import ndimage
    out = dem.astype(np.float32).copy()
    for reach, steep in ((1.0, 45.0), (2.0, 60.0)):
        k = 2 * max(1, int(round(reach / cell))) + 1
        hi = ndimage.maximum_filter(dem, size=k, mode="nearest")
        # The cells beside a steep one too: the foot of a face is flat.
        m = ndimage.maximum_filter(slope > steep, size=3, mode="nearest")
        out = np.where(m, np.maximum(hi, out), out)
    return out.astype(np.float32)


def collect(P, dem, ggrid, cg, bg, inside_c, min_h, say, dem_hi=None):
    """One chunked pass: HAG of every return; per CHM cell the lowest return
    HAG and the count of all returns; per brush cell the same count; the
    vegetation candidates (class, height, inside the area)."""
    t0 = time.time()
    nc = cg.nx * cg.ny
    nb = bg.nx * bg.ny
    lowest = np.full(nc, np.inf, np.float32)
    tot_c = np.zeros(nc, np.int64)
    tot_b = np.zeros(nb, np.int64)
    xs, ys, hs = [], [], []
    inside_flat = inside_c.ravel()
    for x, y, z, c in P.chunks():
        keep = np.ones(len(z), bool) if c is None else ~np.isin(c, NOISE_CLASSES)
        x, y, z = x[keep], y[keep], z[keep]
        c = None if c is None else c[keep]
        hag = (z - ld.sample_bilinear(dem, ggrid, x, y)).astype(np.float32)
        fc = cg.flat(x, y)
        tot_c += np.bincount(fc, minlength=nc)
        tot_b += np.bincount(bg.flat(x, y), minlength=nb)
        np.minimum.at(lowest, fc, hag)
        v = (hag >= min_h) & (hag <= MAX_HAG) & inside_flat[fc]
        if dem_hi is not None:
            v &= (z - dem_hi.ravel()[ggrid.flat(x, y)]) >= min_h
        if c is not None:
            v &= np.isin(c, VEG_CLASSES)
        xs.append((x[v] - P.ox).astype(np.float32))
        ys.append((y[v] - P.oy).astype(np.float32))
        hs.append(hag[v])
    V = Veg()
    V.ox, V.oy = P.ox, P.oy
    V.x = np.concatenate(xs) if xs else np.zeros(0, np.float32)
    V.y = np.concatenate(ys) if ys else np.zeros(0, np.float32)
    V.h = np.concatenate(hs) if hs else np.zeros(0, np.float32)
    lowest[~np.isfinite(lowest)] = np.nan
    say(f"  {len(V.h):,} vegetation candidates ({time.time() - t0:.1f} s)")
    return V, lowest.reshape(cg.shape), tot_c.reshape(cg.shape), \
        tot_b.reshape(bg.shape)


def take(V, m):
    W = Veg()
    W.ox, W.oy = V.ox, V.oy
    W.x, W.y, W.h = V.x[m], V.y[m], V.h[m]
    return W


def flat_local(V, grid):
    """ld.Grid.flat for the local float32 offsets (no float64 copies kept)."""
    col = np.floor((V.x + (V.ox - grid.minx)) / grid.cell).astype(np.int64)
    row = np.floor(((grid.maxy - V.oy) - V.y) / grid.cell).astype(np.int64)
    np.clip(col, 0, grid.nx - 1, out=col)
    np.clip(row, 0, grid.ny - 1, out=row)
    return row * grid.nx + col


def clean(V, cg, lowest, slope_c, density, say):
    """Drop isolated returns, returns far above the canopy around them and
    returns over steep ground that never reaches the ground (rock)."""
    from scipy import ndimage
    t0 = time.time()
    n0 = len(V.h)
    if n0 == 0:
        return V, {}
    # 1. support: returns in the 2 m voxel of each return, the 8 around it
    # and the two layers below (a 6 x 6 x 6 m box hanging from it). Birds,
    # stray multipath and wires over open ground have almost none; a pointed
    # tree top has its crown under it.
    v = 2.0
    nxv = int(math.ceil(cg.nx * cg.cell / v)) + 1
    nyv = int(math.ceil(cg.ny * cg.cell / v)) + 1
    nzv = int(math.ceil(MAX_HAG / v)) + 1
    ix = np.clip(((V.x + (V.ox - cg.minx)) / v).astype(np.int64), 0, nxv - 1)
    iy = np.clip((((cg.maxy - V.oy) - V.y) / v).astype(np.int64), 0, nyv - 1)
    iz = np.clip((V.h / v).astype(np.int64), 0, nzv - 1)
    lin = (iz * nyv + iy) * nxv + ix
    del ix, iy, iz
    cnt = np.bincount(lin, minlength=nxv * nyv * nzv).astype(np.float32)
    cnt = cnt.reshape(nzv, nyv, nxv)
    hz = ndimage.uniform_filter(cnt, (1, 3, 3), mode="constant") * 9.0
    sup = hz.copy()
    sup[1:] += hz[:-1]
    sup[2:] += hz[:-2]
    del hz
    del cnt
    need = max(3.0, 0.08 * density)
    keep = sup.ravel()[lin] >= need - 0.5
    del sup, lin
    n_iso = int((~keep).sum())
    V = take(V, keep)
    n_high = 0

    # 3. rock: steep ground, no return near the ground within 3 m and
    # nothing tall there either (a knob the cloth bridged reads as a few
    # metres of "vegetation"; a crown that hides the ground stands taller).
    r = max(1, int(round(1.5 / cg.cell)))
    lo = np.where(np.isfinite(lowest), lowest, 99.0)
    near = ndimage.minimum_filter(lo, size=2 * r + 1, mode="nearest")
    f = flat_local(V, cg)
    top = np.zeros(cg.nx * cg.ny, np.float32)
    np.maximum.at(top, f, V.h)
    tall = ndimage.maximum_filter(top.reshape(cg.shape), size=4 * r + 1,
                                  mode="nearest")
    rock = (slope_c > 35.0) & (near > 0.6) & (tall < ROCK_MAX_H)
    is_rock = rock.ravel()[f]
    n_rock = int(is_rock.sum())
    V = take(V, ~is_rock)
    say(f"  cleaned: {n_iso:,} isolated or floating, "
        f"{n_rock:,} on bare steep rock; {len(V.h):,} left "
        f"({time.time() - t0:.1f} s)")
    return V, {"isolated": n_iso, "rock": n_rock,
               "rock_cells_pct": round(float(rock.mean() * 100), 2)}


# --------------------------------------------------------------------------
# Trees
# --------------------------------------------------------------------------

def canopy_model(V, cg, smooth_m):
    from scipy import ndimage
    f = flat_local(V, cg)
    chm = np.zeros(cg.nx * cg.ny, np.float32)
    np.maximum.at(chm, f, V.h)
    chm = chm.reshape(cg.shape)
    # Pits (cells the pulses missed inside a crown) take the 3x3 median.
    med = ndimage.median_filter(chm, size=3)
    chm = np.where(chm < med - 0.8, med, chm).astype(np.float32)
    chm_s = ndimage.gaussian_filter(chm, smooth_m / cg.cell).astype(np.float32)
    return chm, chm_s, f


def find_tops(chm_s, cg, tree_min):
    """(rows, cols) of tops: cells equal to the max in a window that grows
    with their height; plateaus give one top."""
    from scipy import ndimage
    radii = np.arange(1.0, 4.51, 0.5)
    want = window_radius(chm_s)
    is_top = np.zeros(chm_s.shape, bool)
    cand = chm_s >= tree_min
    for i, r in enumerate(radii):
        lo = radii[i - 1] + 0.25 if i else 0.0
        hi = r + 0.25
        band = cand & (want >= lo) & (want < hi)
        if not band.any():
            continue
        m = octagon_max(chm_s, r / cg.cell)
        is_top |= band & (chm_s >= m - 1e-4)
    lab, n = ndimage.label(is_top, structure=np.ones((3, 3)))
    if n == 0:
        return np.zeros(0, int), np.zeros(0, int)
    rows, cols = np.nonzero(lab)
    ids = lab[rows, cols]
    order = np.argsort(ids, kind="stable")
    ids, rows, cols = ids[order], rows[order], cols[order]
    first = np.r_[0, np.nonzero(np.diff(ids))[0] + 1]
    cnt = np.diff(np.r_[first, len(ids)])
    r = np.add.reduceat(rows, first) / cnt
    c = np.add.reduceat(cols, first) / cnt
    return np.round(r).astype(int), np.round(c).astype(int)


def flood(chm_s, tops_r, tops_c, floor, dz=0.4, max_it=8, max_age=8):
    """Marker watershed by descending levels: from the tops down, every cell
    joins the crown of its highest labelled neighbour once the water level
    reaches it. (scipy's watershed_ift weighs height *differences*, which
    leaks steep cones into the background, so it is not used.)"""
    ny, nx = chm_s.shape
    W = nx + 2
    lab = np.zeros((ny + 2) * W, np.int32)
    hp = np.full((ny + 2) * W, -1e9, np.float32)
    hp.reshape(ny + 2, W)[1:-1, 1:-1] = chm_s
    seeds = (tops_r + 1) * W + (tops_c + 1)
    lab[seeds] = np.arange(1, len(seeds) + 1, dtype=np.int32)
    rr, cc = np.nonzero(chm_s >= floor)
    cells = (rr + 1) * W + (cc + 1)
    hmax = float(chm_s.max())
    lev = np.floor((hmax - chm_s[rr, cc]) / dz).astype(np.int64)
    o = np.argsort(lev, kind="stable")
    cells, lev = cells[o], lev[o]
    bounds = np.searchsorted(lev, np.arange(lev.max() + 2 if len(lev) else 1))
    offs = np.array([-1, 1, -W, W])
    pend = np.zeros(0, np.int64)
    age = np.zeros(0, np.int32)
    for k in range(len(bounds) - 1):
        new = cells[bounds[k]:bounds[k + 1]]
        new = new[lab[new] == 0]
        cand = np.concatenate([pend, new])
        cage = np.concatenate([age, np.zeros(len(new), np.int32)])
        for _ in range(max_it):
            if not len(cand):
                break
            nb = cand[:, None] + offs[None, :]
            nl = lab[nb]
            nh = np.where(nl > 0, hp[nb], -1e9)
            j = np.argmax(nh, axis=1)
            pick = nl[np.arange(len(cand)), j]
            g = pick > 0
            if not g.any():
                break
            lab[cand[g]] = pick[g]
            cand, cage = cand[~g], cage[~g]
        cage = cage + 1
        keep = cage < max_age
        pend, age = cand[keep], cage[keep]
    return lab.reshape(ny + 2, W)[1:-1, 1:-1].copy()


def crowns(chm, chm_s, cg, tops_r, tops_c, tree_min):
    """Crowns from the tops, cut to cells above a floor and within a reach
    that grow with the tree's height."""
    n = len(tops_r)
    if n == 0:
        return np.zeros(chm.shape, np.int32)
    top_h = chm_s[tops_r, tops_c]
    lab = flood(chm_s, tops_r, tops_c, tree_min * 0.5)
    rr, cc = np.nonzero(lab)
    L = lab[rr, cc]
    h = top_h[L - 1]
    d = np.hypot(rr - tops_r[L - 1], cc - tops_c[L - 1]) * cg.cell
    ok = (chm[rr, cc] >= np.maximum(tree_min * 0.6, 0.18 * h)) & \
        (d <= crown_reach(h))
    lab[rr[~ok], cc[~ok]] = 0
    return lab


def tree_records(V, f_c, chm, chm_s, lab, cg, tops_r, tops_c, tot_c,
                 min_h, brush_top, kinds_mode="auto"):
    """Per crown: position, height, radius, base, kind, density."""
    n = len(tops_r)
    if n == 0:
        return np.zeros((0, RECORD), np.float32), {}
    flat = lab.ravel()
    ncell = np.bincount(flat, minlength=n + 1)[1:]
    area = ncell * cg.cell ** 2
    radius = np.sqrt(area / math.pi)
    # Centroid of the crown cells.
    rr, cc = np.nonzero(lab)
    L = lab[rr, cc]
    sr = np.bincount(L, rr, minlength=n + 1)[1:]
    sc = np.bincount(L, cc, minlength=n + 1)[1:]
    with np.errstate(invalid="ignore", divide="ignore"):
        cr = np.where(ncell > 0, sr / np.maximum(ncell, 1), tops_r)
        ccol = np.where(ncell > 0, sc / np.maximum(ncell, 1), tops_c)
    # Position: halfway between the top and the crown's centroid.
    pr = 0.5 * (tops_r + cr)
    pc = 0.5 * (tops_c + ccol)
    x = cg.minx + (pc + 0.5) * cg.cell
    y = cg.maxy - (pr + 0.5) * cg.cell

    # Height: the crown's highest cleaned return.
    pl = flat[f_c]
    inn = pl > 0
    height = np.zeros(n + 1, np.float32)
    np.maximum.at(height, pl[inn], V.h[inn])
    height = height[1:]

    # Vertical profile in 1 m bins -> crown base.
    nb = int(math.ceil(MAX_HAG)) + 1
    hb = np.minimum(V.h[inn].astype(np.int64), nb - 1)
    prof = np.bincount(pl[inn].astype(np.int64) * nb + hb,
                       minlength=(n + 1) * nb).reshape(n + 1, nb)[1:]
    pts_in = prof.sum(1)
    top_bin = np.maximum(0, np.floor(height).astype(int))
    idx = np.arange(nb)[None, :]
    # The densest metre in the upper 80 % of the tree.
    upper = idx >= (0.2 * height)[:, None]
    pk = np.argmax(np.where(upper & (idx <= top_bin[:, None]), prof, -1), axis=1)
    peak = prof[np.arange(n), pk]
    thin = prof < np.maximum(1, 0.12 * peak)[:, None]
    gap = thin & np.roll(thin, 1, axis=1)          # two thin metres in a row
    gap[:, 0] = thin[:, 0]
    cand = gap & (idx < pk[:, None]) & (idx >= int(min_h))
    lowgap = np.where(cand, idx, -1).max(axis=1)
    base = np.where(lowgap >= 0, lowgap + 1.0, min_h).astype(np.float32)
    base = np.minimum(base, 0.85 * height)
    base = np.maximum(base, 0.0)

    # Density: share of all the column's returns caught at or above the base.
    above = np.zeros(n + 1)
    sel = inn.copy()
    sel[inn] = V.h[inn] >= base[pl[inn] - 1]
    above = np.bincount(pl[sel], minlength=n + 1)[1:]
    tot = np.bincount(flat, tot_c.ravel(), minlength=n + 1)[1:]
    density = np.clip(above / np.maximum(tot, 1), 0, 1)

    # Kind: how steeply the CHM falls away from the top. Mean drop per metre
    # over the inner 0.6 of the crown; a cone keeps ~ (h-base)/r all the way,
    # a dome is nearly flat near its top.
    d = np.hypot(rr - tops_r[L - 1], cc - tops_c[L - 1]) * cg.cell
    R = radius[L - 1]
    drop = np.maximum(0.0, height[L - 1] - chm[rr, cc])
    near = (d > 0.6) & (d <= np.maximum(1.0, 0.6 * R))
    s_cnt = np.bincount(L[near], minlength=n + 1)[1:]
    s_sum = np.bincount(L[near], (drop / np.maximum(d, 0.1))[near],
                        minlength=n + 1)[1:]
    apex = s_sum / np.maximum(s_cnt, 1)
    # Shape: drop at half the radius over drop at the rim (cone ~0.5,
    # paraboloid ~0.25, hemisphere ~0.13).
    mid = (d > 0.35 * R) & (d <= 0.65 * R)
    rim = (d > 0.8 * R)
    dm = np.bincount(L[mid], drop[mid], minlength=n + 1)[1:] / \
        np.maximum(np.bincount(L[mid], minlength=n + 1)[1:], 1)
    dr = np.bincount(L[rim], drop[rim], minlength=n + 1)[1:] / \
        np.maximum(np.bincount(L[rim], minlength=n + 1)[1:], 1)
    shape_q = dm / np.maximum(dr, 0.1)
    slender = (height - base) / np.maximum(radius, 0.5)
    # Pointed and steep, or simply much longer than wide (a narrow crown
    # whose smoothed top reads rounded is still a conifer's).
    cone = ((apex >= 0.9) & (shape_q >= 0.33) & (slender >= 1.6)) | \
        (slender >= 2.8)
    if kinds_mode == "dome":
        cone[:] = False
    kind = np.where(cone, 1.0, 0.0)

    ok = (ncell * cg.cell ** 2 >= max(1.0, math.pi * 0.6 ** 2)) & \
        (height >= brush_top) & (pts_in >= 3)
    rec = np.zeros((n, RECORD), np.float32)
    rec[:, 0], rec[:, 1] = x, y
    rec[:, 3] = height
    rec[:, 4] = np.maximum(radius, 0.5)
    rec[:, 5] = base
    rec[:, 6] = kind
    rec[:, 7] = density
    diag = {"apex": apex[ok], "shape_q": shape_q[ok], "slender": slender[ok]}
    rec = rec[ok]
    rec = rec[np.argsort(-rec[:, 3], kind="stable")]
    return rec, diag


# --------------------------------------------------------------------------
# Brush
# --------------------------------------------------------------------------

def brush_mounds(V, bg, tot_b, lab, cg, trees_low_base, min_h, brush_top,
                 tile, density, inside_b):
    """Mounds a tile wide over cells where returns between min_height and
    brush_top make a real share of all returns."""
    nb = bg.nx * bg.ny
    m = (V.h >= min_h) & (V.h < brush_top)
    fb = flat_local(take(V, m), bg)
    band = np.bincount(fb, minlength=nb)
    top = np.zeros(nb, np.float32)
    np.maximum.at(top, fb, V.h[m])
    frac = band / np.maximum(tot_b.ravel(), 1)
    need = max(2.0, 0.03 * density * bg.cell ** 2)
    brushy = (frac >= 0.08) & (band >= need) & inside_b.ravel()
    # Under a crown that starts low the band returns are the tree's own.
    cx = bg.minx + (np.arange(bg.nx) + 0.5) * bg.cell
    cy = bg.maxy - (np.arange(bg.ny) + 0.5) * bg.cell
    X, Y = np.meshgrid(cx, cy)
    c = np.clip(((X - cg.minx) / cg.cell).astype(int), 0, cg.nx - 1)
    r = np.clip(((cg.maxy - Y) / cg.cell).astype(int), 0, cg.ny - 1)
    if trees_low_base is not None and len(trees_low_base):
        from scipy import ndimage
        own = (lab > 0) & trees_low_base[np.maximum(lab - 1, 0)]
        k = 2 * int(round(1.5 / cg.cell)) + 1      # their skirts, 1.5 m out
        own = ndimage.maximum_filter(own, size=k)
        brushy &= ~own[r, c].ravel()
    cells = np.nonzero(brushy)[0]
    if len(cells) == 0:
        return np.zeros((0, RECORD), np.float32)
    k = max(1, int(round(tile / bg.cell)))
    br, bc = cells // bg.nx, cells % bg.nx
    tx, ty = bc // k, br // k
    ntx = bg.nx // k + 1
    tid = ty * ntx + tx
    order = np.argsort(tid, kind="stable")
    tid, cells, br, bc = tid[order], cells[order], br[order], bc[order]
    first = np.r_[0, np.nonzero(np.diff(tid))[0] + 1]
    cnt = np.diff(np.r_[first, len(tid)])
    keep = cnt >= max(2, int(0.2 * k * k))
    xs = bg.minx + (np.add.reduceat(bc, first) / cnt + 0.5) * bg.cell
    ys = bg.maxy - (np.add.reduceat(br, first) / cnt + 0.5) * bg.cell
    fr = np.add.reduceat(frac[cells], first) / cnt
    # Height: 75th percentile of the cells' tops in the tile.
    tops = top[cells]
    o2 = np.lexsort((tops, tid))
    tops_sorted = tops[o2]
    pick = first + np.minimum(cnt - 1, (0.75 * (cnt - 1)).round().astype(int))
    h = tops_sorted[pick]
    rad = np.minimum(np.sqrt(cnt * bg.cell ** 2 / math.pi) * 1.25,
                     0.8 * k * bg.cell)
    rec = np.zeros((int(keep.sum()), RECORD), np.float32)
    rec[:, 0], rec[:, 1] = xs[keep], ys[keep]
    rec[:, 3] = np.maximum(h[keep], min_h)
    rec[:, 4] = np.maximum(rad[keep], 0.5)
    rec[:, 5] = 0.0
    rec[:, 6] = 2.0
    rec[:, 7] = np.clip(fr[keep] * 2.0, 0.05, 1.0)
    return rec


# --------------------------------------------------------------------------
# Shell: occupancy voxels -> surface nets
# --------------------------------------------------------------------------

def occupancy(V, sg, vh, vz, hmax, density):
    """Share of 'full' per voxel (vh across, vz tall, in HAG), 0..1."""
    nx, ny = sg.nx, sg.ny
    nz = int(math.ceil(hmax / vz)) + 1
    ix = np.clip(((V.x + (V.ox - sg.minx)) / vh).astype(np.int64), 0, nx - 1)
    iy = np.clip(((V.y + (V.oy - sg.miny)) / vh).astype(np.int64), 0, ny - 1)
    iz = np.clip((V.h / vz).astype(np.int64), 0, nz - 1)
    cnt = np.bincount((ix * ny + iy) * nz + iz, minlength=nx * ny * nz)
    cnt = cnt.reshape(nx, ny, nz).astype(np.float32)
    full = max(2.0, 0.06 * density * vh * vz)
    return np.minimum(1.0, cnt / full)


def surface_nets(F, iso):
    """Vertices (in sample-index units) and CCW-outside triangles of the
    iso-surface of F (inside = F > iso). F must be padded with outside."""
    inside = F > iso
    nx, ny, nz = F.shape
    c = inside[:-1, :-1, :-1].astype(np.uint8)
    any_in = np.zeros(c.shape, bool)
    all_in = np.ones(c.shape, bool)
    corners = [(i, j, k) for i in (0, 1) for j in (0, 1) for k in (0, 1)]
    for (i, j, k) in corners:
        s = inside[i:nx - 1 + i, j:ny - 1 + j, k:nz - 1 + k]
        any_in |= s
        all_in &= s
    active = any_in & ~all_in
    del any_in, all_in, c
    ai, aj, ak = np.nonzero(active)
    del active
    cube_lin = (ai * (ny - 1) + aj) * (nz - 1) + ak
    # Vertex = mean of the edge crossings of the cube.
    acc = np.zeros((len(ai), 3), np.float64)
    num = np.zeros(len(ai), np.float64)
    edges = []
    for (i, j, k) in corners:
        for d in range(3):
            o = [i, j, k]
            if o[d] == 1:
                continue
            o2 = list(o); o2[d] = 1
            edges.append((tuple(o), tuple(o2)))
    for a, b in edges:
        fa = F[ai + a[0], aj + a[1], ak + a[2]]
        fb = F[ai + b[0], aj + b[1], ak + b[2]]
        cr = (fa > iso) != (fb > iso)
        t = np.where(cr, (iso - fa) / np.where(cr, fb - fa, 1.0), 0.0)
        for d in range(3):
            acc[:, d] += np.where(cr, a[d] + (b[d] - a[d]) * t, 0.0)
        num += cr
    verts = acc / np.maximum(num, 1)[:, None]
    verts[:, 0] += ai; verts[:, 1] += aj; verts[:, 2] += ak
    verts += 0.5          # sample i sits at the centre of voxel i
    del acc, num

    def vid(i, j, k):
        lin = (i * (ny - 1) + j) * (nz - 1) + k
        p = np.searchsorted(cube_lin, lin)
        return p

    tris = []
    # Edges along axis a between samples s and s + e_a; the quad joins the
    # four cubes around it, ordered CCW about +a in the (b, c) plane.
    for a in range(3):
        b, cax = (a + 1) % 3, (a + 2) % 3
        sl0 = [slice(None)] * 3
        sl1 = [slice(None)] * 3
        sl0[a] = slice(0, F.shape[a] - 1)
        sl1[a] = slice(1, F.shape[a])
        i0 = inside[tuple(sl0)]
        i1 = inside[tuple(sl1)]
        cross = i0 != i1
        out_pos = i0 & ~i1                # outward normal along +a
        idx = np.nonzero(cross)
        flip = ~out_pos[idx]
        del cross, out_pos, i0, i1
        p = [idx[0], idx[1], idx[2]]
        ok = (p[b] >= 1) & (p[cax] >= 1)
        p = [q[ok] for q in p]
        flip = flip[ok]
        quad = []
        for db, dc in ((-1, -1), (0, -1), (0, 0), (-1, 0)):
            q = list(p)
            q[b] = p[b] + db
            q[cax] = p[cax] + dc
            quad.append(vid(q[0], q[1], q[2]))
        q0, q1, q2, q3 = quad
        t1 = np.stack([q0, q1, q2], 1)
        t2 = np.stack([q0, q2, q3], 1)
        t1f = np.stack([q0, q2, q1], 1)
        t2f = np.stack([q0, q3, q2], 1)
        t1 = np.where(flip[:, None], t1f, t1)
        t2 = np.where(flip[:, None], t2f, t2)
        tris.append(np.concatenate([t1, t2]))
    tris = np.concatenate(tris) if tris else np.zeros((0, 3), np.int64)
    return verts, tris


def laplacian(verts, tris, iters=2, lam=0.5):
    if len(tris) == 0:
        return verts
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    n = len(verts)
    deg = np.bincount(e[:, 0], minlength=n) + np.bincount(e[:, 1], minlength=n)
    v = verts.copy()
    for it in range(iters):
        s = np.zeros_like(v)
        for d in range(3):
            s[:, d] = np.bincount(e[:, 0], v[e[:, 1], d], minlength=n) + \
                np.bincount(e[:, 1], v[e[:, 0], d], minlength=n)
        avg = s / np.maximum(deg, 1)[:, None]
        # Taubin: shrink then inflate a little, so blobs keep their size.
        k = lam if it % 2 == 0 else -0.53
        v = v + k * (avg - v)
    return v


SHELL_SIGMA = 0.75       # Gaussian smoothing of the occupancy, in voxels
SHELL_ISO = 0.18         # surface where the smoothed occupancy crosses this


def shell_at(V, need, vh, density, hmax):
    from scipy import ndimage
    vz = max(1.0, 0.5 * vh)
    sg = ld.Grid(need[0], need[1], need[2], need[3], vh)
    F = occupancy(V, sg, vh, vz, hmax, density)
    F = ndimage.gaussian_filter(F, SHELL_SIGMA)
    verts, tris = surface_nets(np.pad(F, 1), SHELL_ISO)
    return verts, tris, vz


def build_shell(V, need, voxel, max_tri, density, say):
    """Surface nets at `voxel` across (half that tall, at least 1 m), made
    coarser until it fits max_tri. The size is searched in log-log (the
    count falls roughly as a power of the voxel size) toward 90 % of the
    budget; the finest result that fits is kept."""
    hmax = float(V.h.max()) + voxel
    target = 0.9 * max_tri
    samples = []                 # (v, triangles)
    best = None
    v = voxel
    for attempt in range(7):
        verts, tris, vz = shell_at(V, need, v, density, hmax)
        T = len(tris)
        say(f"  shell at {v:.2f} x {vz:.2f} m voxels: {len(verts):,} "
            f"vertices, {T:,} triangles")
        samples.append((v, max(T, 1)))
        if T <= max_tri and (best is None or v < best[2]):
            best = (verts, tris, v, vz)
        if best is not None and (best[2] <= voxel + 1e-9 or
                                 len(best[1]) >= 0.75 * max_tri):
            break
        over = [s_ for s_ in samples if s_[1] > max_tri]
        under = [s_ for s_ in samples if s_[1] <= max_tri]
        if over and under:
            (v0, t0) = max(over)              # coarsest that did not fit
            (v1, t1) = min(under)             # finest that fits
            p = math.log(t0 / t1) / max(1e-6, math.log(v1 / v0))
            v_new = v0 * (t0 / target) ** (1.0 / max(p, 0.5))
            v_new = min(max(v_new, v0 * 1.02), v1 * 0.98)
            if v_new >= v1 * 0.97 or v_new <= v0 * 1.01:
                break
        else:
            p = 2.6
            if len(samples) >= 2:
                (va, ta), (vb, tb) = samples[-2], samples[-1]
                if vb != va and ta != tb:
                    p = max(0.5, math.log(ta / tb) / math.log(vb / va))
            v_new = v * (T / target) ** (1.0 / p)
            v_new = max(v_new, v * 1.05)
        v = v_new
    if best is None:
        raise RuntimeError("the shell does not fit max_triangles")
    verts, tris, v, vz = best
    verts = laplacian(verts, tris, iters=4)
    # Index units -> metres (x, y in UTM, z = HAG); the pad shifts by one.
    xs = need[0] + (verts[:, 0] - 1) * v
    ys = need[1] + (verts[:, 1] - 1) * v
    hag = np.maximum(0.0, (verts[:, 2] - 1) * vz)
    return xs, ys, hag, tris.astype(np.uint32), v, vz


# --------------------------------------------------------------------------
# Preview
# --------------------------------------------------------------------------

def hillshade(dem, cell):
    gy, gx = np.gradient(dem.astype(np.float64), cell)
    nz = 1.0 / np.sqrt(1 + gx * gx + gy * gy)
    # light from the north-west, 45 deg up (row 0 = north here)
    lx, ly, lz = -0.5, 0.5, 0.7071
    s = (-gx * lx + gy * ly + lz) * nz
    return np.clip(s, 0, 1)


def preview(path, frame, dem, ggrid, chm, cg, recs, bbox, max_px=900):
    """Top-down, north up, in the local frame: hillshade, canopy height in
    greens, crown rims (cones darker), brush mounds in brown."""
    x0, y0, x1, y1 = bbox
    span = max(x1 - x0, y1 - y0, 1.0)
    px = span / max_px
    W = max(16, int(math.ceil((x1 - x0) / px)))
    H = max(16, int(math.ceil((y1 - y0) / px)))
    gx = x0 + (np.arange(W) + 0.5) * px
    gyv = y1 - (np.arange(H) + 0.5) * px
    X, Y = np.meshgrid(gx, gyv)
    E, N = frame.to_utm(X.ravel(), Y.ravel())
    hs = hillshade(dem, ggrid.cell)
    c, r = ggrid.indices(E, N)
    shade = hs[r, c].reshape(H, W)
    c2, r2 = cg.indices(E, N)
    h = chm[r2, c2].reshape(H, W)
    rgb = np.stack([shade * 200 + 30] * 3, -1)
    t = np.clip(h / max(1.0, float(np.percentile(h[h > 0], 98)) if (h > 0).any() else 1.0), 0, 1)
    green = np.stack([40 + 150 * t, 90 + 140 * t, 40 + 30 * t], -1)
    a = np.clip(h / 2.0, 0, 1)[..., None] * 0.85
    rgb = rgb * (1 - a) + green * a
    img = np.zeros((H, W, 4), np.uint8)
    img[..., :3] = np.clip(rgb, 0, 255)
    out = ((E < ggrid.minx) | (E > ggrid.maxx) | (N < ggrid.miny) |
           (N > ggrid.maxy)).reshape(H, W)
    img[..., 3] = np.where(out, 0, 255)

    def ring(xc, yc, rad, col, fill=False):
        n = max(8, int(2 * math.pi * rad / px))
        if fill:
            ys_, xs_ = np.mgrid[-rad:rad:px * 0.7, -rad:rad:px * 0.7]
            k = xs_ ** 2 + ys_ ** 2 <= rad * rad
            qx = xc + xs_[k]; qy = yc + ys_[k]
        else:
            a_ = np.linspace(0, 2 * math.pi, n, endpoint=False)
            qx = xc + rad * np.cos(a_); qy = yc + rad * np.sin(a_)
        ci = ((qx - x0) / px).astype(int)
        ri = ((y1 - qy) / px).astype(int)
        ok = (ci >= 0) & (ci < W) & (ri >= 0) & (ri < H)
        img[ri[ok], ci[ok], :3] = col

    for rec in recs:
        if rec[6] == 2:
            ring(rec[0], rec[1], rec[4], (150, 110, 60), fill=True)
    for rec in recs:
        if rec[6] != 2:
            ring(rec[0], rec[1], rec[4],
                 (10, 60, 20) if rec[6] == 1 else (230, 255, 120))
            ci, ri = int((rec[0] - x0) / px), int((y1 - rec[1]) / px)
            if 0 <= ci < W and 0 <= ri < H:
                img[ri, ci, :3] = (255, 40, 40)
    ld.write_png(img, path)


# --------------------------------------------------------------------------
# The job
# --------------------------------------------------------------------------

def clean_params(params):
    p = dict(params or {})
    looks = p.get("looks") or ["shapes", "shell"]
    if isinstance(looks, str):
        looks = [looks]
    looks = [l for l in looks if l in ("shapes", "shell")]
    if not looks:
        raise RuntimeError("looks must name shapes and/or shell")
    detail = p.get("detail", "medium")
    if detail not in DETAIL:
        raise RuntimeError("detail must be low, medium or high")
    out = {
        "source": p.get("source") or {},
        "looks": looks,
        "detail": detail,
        "min_height": float(p.get("min_height", 0.5)),
        "brush_top": float(p.get("brush_top", 2.0)),
        "max_triangles": int(p.get("max_triangles", 300000)),
    }
    if p.get("area"):
        out["area"] = p["area"]
    if not (0.0 <= out["min_height"] < out["brush_top"] <= 20.0):
        raise RuntimeError("need 0 <= min_height < brush_top <= 20")
    if out["max_triangles"] < 1000:
        raise RuntimeError("max_triangles must be at least 1000")
    for k in ("kinds", "area_bbox_utm"):        # tests and diagnostics
        if k in p:
            out[k] = p[k]
    return out


def run(params, out_dir, say=say_default):
    t_start = time.time()
    timings = {}
    os.makedirs(out_dir, exist_ok=True)
    prm = clean_params(params)
    src = prm["source"]
    D = DETAIL[prm["detail"]]
    min_h, brush_top = prm["min_height"], prm["brush_top"]
    ring_ll = prm.get("area")
    if ring_ll is not None:
        if not isinstance(ring_ll, list) or len(ring_ll) < 3:
            raise RuntimeError("area must be a ring of at least 3 [lon, lat]")

    # Zone, the area in UTM.
    npz_ext = None
    if "npz" in src:
        nz = np.load(src["npz"])
        epsg = int(src.get("epsg") or (nz["epsg"] if "epsg" in nz.files else 0))
        if not (32601 <= epsg <= 32660 or 32701 <= epsg <= 32760):
            raise RuntimeError("the npz needs UTM x/y: give its EPSG "
                               "(326zz / 327zz) as source.epsg or --points-epsg")
        zone, south = epsg % 100, epsg >= 32700
        npz_ext = (float(nz["x"].min()), float(nz["y"].min()),
                   float(nz["x"].max()), float(nz["y"].max()))
        del nz
    elif "ept" in src or "las" in src:
        if ring_ll is None:
            raise RuntimeError("params need 'area' (a lon/lat ring)")
        lon_c = sum(p[0] for p in ring_ll) / len(ring_ll)
        lat_c = sum(p[1] for p in ring_ll) / len(ring_ll)
        zone = rc.et().utm_zone_for(lon_c)
        south = lat_c < 0
    else:
        raise RuntimeError("params.source needs 'ept', 'las' or 'npz'")
    ring_xy = None
    if ring_ll is not None:
        ring_xy = [rc.lonlat_to_xy(p[0], p[1], zone) for p in ring_ll]
        need = (min(p[0] for p in ring_xy), min(p[1] for p in ring_xy),
                max(p[0] for p in ring_xy), max(p[1] for p in ring_xy))
        if npz_ext:
            need = (max(need[0], npz_ext[0]), max(need[1], npz_ext[1]),
                    min(need[2], npz_ext[2]), min(need[3], npz_ext[3]))
            if need[2] <= need[0] or need[3] <= need[1]:
                raise RuntimeError("the area is outside the points")
    else:
        need = npz_ext
    if "area_bbox_utm" in prm:
        need = tuple(float(v) for v in prm["area_bbox_utm"])
    if ring_xy is None:
        ring_xy = [(need[0], need[1]), (need[2], need[1]),
                   (need[2], need[3]), (need[0], need[3])]
    area_m2 = ring_area(ring_xy)
    if area_m2 < 100:
        raise RuntimeError("the area is too small (under 100 m2)")
    if area_m2 > 25e6:
        raise RuntimeError("the area is too large (over 25 km2)")
    say(f"[1/6] Reading points (UTM zone {zone}{'S' if south else 'N'}, "
        f"{need[2] - need[0]:.0f} x {need[3] - need[1]:.0f} m, "
        f"detail {prm['detail']})")
    t0 = time.time()
    P = rc.read_points(src, need, zone, south, say)
    timings["read_s"] = round(time.time() - t0, 2)
    n_points = len(P)
    density = n_points / max(area_m2, 1.0)

    # Ground.
    say("[2/6] Ground (cloth from below)")
    t0 = time.time()
    ng = int((P.cls == GROUND_CLASS).sum()) if P.cls is not None else n_points
    gcell = rc.auto_cell(ng, (need[2] - need[0]) * (need[3] - need[1]),
                         lo=0.5, hi=2.0)
    ggrid = ld.Grid(need[0], need[1], need[2], need[3], gcell)
    dem, gvalid = build_ground(P, ggrid, say)
    timings["ground_s"] = round(time.time() - t0, 2)

    # The frame: origin at the middle of the area, h = ground there.
    ex, ny_ = 0.5 * (need[0] + need[2]), 0.5 * (need[1] + need[3])
    h0 = float(ld.sample_bilinear(dem, ggrid, np.array([ex]), np.array([ny_]))[0])
    frame = Frame(zone, south, ex, ny_, h0)
    inv_err = frame.fit_inverse(need)

    # Grids for the canopy and brush, HAG, cleaning.
    say("[3/6] Height above ground, cleaning")
    t0 = time.time()
    cchm = max(D["chm"], round(math.sqrt(2.5 / max(density, 0.1)) * 4) / 4)
    cg = ld.Grid(need[0], need[1], need[2], need[3], cchm)
    bg = ld.Grid(need[0], need[1], need[2], need[3], 2 * cchm)
    inside_c = polygon_mask(ring_xy, cg)
    inside_b = polygon_mask(ring_xy, bg)
    gx, gy = rc.gradients(dem, ggrid.cell)
    slope = rc.slope_deg(gx, gy)
    V, lowest, tot_c, tot_b = collect(P, dem, ggrid, cg, bg, inside_c,
                                      min_h, say,
                                      cliff_guard(dem, slope, ggrid.cell))
    del P
    # Slope on the CHM grid (nearest).
    cx = cg.minx + (np.arange(cg.nx) + 0.5) * cg.cell
    cy = cg.maxy - (np.arange(cg.ny) + 0.5) * cg.cell
    gc, _ = ggrid.indices(cx, np.full_like(cx, cg.maxy - 1e-6))
    _, gr = ggrid.indices(np.full_like(cy, cg.minx), cy)
    slope_c = slope[np.ix_(gr, gc)]
    V, cleaned = clean(V, cg, lowest, slope_c, density, say)
    timings["clean_s"] = round(time.time() - t0, 2)
    n_veg = int(len(V.h))
    hmax = float(V.h.max()) if n_veg else 0.0

    # Shapes.
    recs = np.zeros((0, RECORD), np.float32)
    chm = np.zeros(cg.shape, np.float32)
    counts = {}
    diag = {}
    if n_veg:
        chm, chm_s, f_c = canopy_model(V, cg, D["smooth"])
    if "shapes" in prm["looks"]:
        say("[4/6] Trees and brush")
        t0 = time.time()
        if not n_veg:
            chm_s, f_c = chm, np.zeros(0, np.int64)
        tree_min = max(brush_top, 2.0)
        tr, tc = find_tops(chm_s, cg, tree_min) if n_veg else (np.zeros(0, int),) * 2
        lab = crowns(chm, chm_s, cg, tr, tc, tree_min)
        trees, diag = tree_records(V, f_c, chm, chm_s, lab, cg, tr, tc, tot_c,
                                   min_h, brush_top,
                                   kinds_mode=prm.get("kinds", "auto"))
        # Which crowns start low enough to own the brush band under them.
        low_base = np.zeros(len(tr), bool)
        if len(tr):
            low_base = _label_bases(V, f_c, lab, len(tr), min_h) < brush_top + 0.5
        budget = int(D["budget"] * area_m2 / 1e6) + 50
        tile = D["tile"]
        while True:
            brush = brush_mounds(V, bg, tot_b, lab, cg, low_base, min_h,
                                 brush_top, tile, density, inside_b)
            if len(trees) + len(brush) <= budget or tile > 40:
                break
            tile *= 1.4
            say(f"  over the record budget ({len(trees) + len(brush):,} > "
                f"{budget:,}): brush tiles {tile:.1f} m")
        recs = np.concatenate([trees, brush]) if len(brush) else trees
        timings["shapes_s"] = round(time.time() - t0, 2)
        counts = {"trees": int(len(trees)),
                  "cones": int((trees[:, 6] == 1).sum()),
                  "domes": int((trees[:, 6] == 0).sum()),
                  "brush": int(len(brush))}
        say(f"  {counts['trees']:,} trees ({counts['cones']:,} cones, "
            f"{counts['domes']:,} domes), {counts['brush']:,} brush mounds "
            f"({time.time() - t0:.1f} s)")

    # Shell.
    shell = None
    if "shell" in prm["looks"]:
        say("[5/6] Shell")
        t0 = time.time()
        max_tri = min(prm["max_triangles"],
                      max(20000, int(D["tri_km2"] * area_m2 / 1e6)))
        if n_veg:
            sx, sy, shag, tris, vox, voxz = build_shell(V, need, D["voxel"],
                                                        max_tri, density, say)
        else:
            sx = sy = shag = np.zeros(0)
            tris = np.zeros((0, 3), np.uint32)
            vox, voxz = D["voxel"], max(1.0, D["voxel"] / 2)
        shell = (sx, sy, shag, tris, vox, voxz, max_tri)
        timings["shell_s"] = round(time.time() - t0, 2)

    # Outputs in the local frame.
    say("[6/6] Writing")
    t0 = time.time()
    bx, byy = frame.to_enu(np.array([p[0] for p in ring_xy]),
                           np.array([p[1] for p in ring_xy]))
    bbox = [float(bx.min()), float(byy.min()), float(bx.max()), float(byy.max())]
    veg = {"version": VERSION,
           "origin": {"lon": round(frame.lon0, 8), "lat": round(frame.lat0, 8),
                      "h": round(h0, 3)},
           "frame": "enu",
           "bbox": [round(v, 2) for v in bbox],
           "area_m2": round(float(ring_area(np.stack([bx, byy], 1))), 1)}
    if "shapes" in prm["looks"]:
        if len(recs):
            e, n = recs[:, 0].astype(np.float64), recs[:, 1].astype(np.float64)
            recs[:, 2] = ld.sample_bilinear(dem, ggrid, e, n)
            xe, yn = frame.to_enu(e, n)
            recs[:, 0], recs[:, 1] = xe, yn
        recs.astype("<f4").tofile(os.path.join(out_dir, "shapes.bin"))
        veg["shapes"] = {"file": "shapes.bin", "count": int(len(recs)),
                         **counts, "record": RECORD * 4}
    if shell is not None:
        sx, sy, shag, tris, vox, voxz, max_tri = shell
        V4 = np.zeros((len(sx), 4), np.float32)
        if len(sx):
            zg = ld.sample_bilinear(dem, ggrid, sx, sy)
            xe, yn = frame.to_enu(sx, sy)
            V4[:, 0], V4[:, 1] = xe, yn
            V4[:, 2] = zg + shag
            V4[:, 3] = shag
        with open(os.path.join(out_dir, "shell.bin"), "wb") as f:
            f.write(V4.astype("<f4").tobytes())
            f.write(np.ascontiguousarray(tris, "<u4").tobytes())
        veg["shell"] = {"file": "shell.bin", "vertices": int(len(V4)),
                        "triangles": int(len(tris)), "voxel_m": round(vox, 3),
                        "voxel_z_m": round(voxz, 3), "budget": int(max_tri)}
    # Ground in the local frame, row 0 south; x0, y0 = the south-west sample.
    gc_ = D["gcell"]
    gx0 = math.floor(bbox[0] / gc_) * gc_ - gc_
    gy0 = math.floor(bbox[1] / gc_) * gc_ - gc_
    gnx = int(math.ceil((bbox[2] + gc_ - gx0) / gc_)) + 1
    gny = int(math.ceil((bbox[3] + gc_ - gy0) / gc_)) + 1
    GX, GY = np.meshgrid(gx0 + np.arange(gnx) * gc_, gy0 + np.arange(gny) * gc_)
    E, N = frame.to_utm(GX.ravel(), GY.ravel())
    gz = ld.sample_bilinear(dem, ggrid, E, N).reshape(gny, gnx).astype("<f4")
    gz = np.nan_to_num(gz, nan=h0)
    gz.tofile(os.path.join(out_dir, "ground.bin"))
    veg["ground"] = {"file": "ground.bin", "nx": gnx, "ny": gny, "cell": gc_,
                     "x0": gx0, "y0": gy0,
                     "note": "row 0 south; sample (i, j) at x0 + i*cell, "
                             "y0 + j*cell (cell centres)"}
    trees_h = recs[recs[:, 6] != 2, 3] if len(recs) else np.zeros(0)
    timings["write_s"] = round(time.time() - t0, 2)
    try:
        preview(os.path.join(out_dir, "preview.png"), frame, dem, ggrid, chm,
                cg, recs, bbox)
        veg["preview"] = "preview.png"
    except Exception as e:                       # preview is optional
        say(f"  (no preview: {type(e).__name__})")
    secs = round(time.time() - t_start, 1)
    veg["stats"] = {"points": int(n_points), "veg_points": n_veg,
                    "max_height": round(hmax, 2),
                    "mean_tree_height": round(float(trees_h.mean()), 2)
                    if len(trees_h) else 0.0,
                    "seconds": secs,
                    "points_per_m2": round(density, 1),
                    "chm_cell": cchm, "ground_cell": gcell,
                    "cleaned": cleaned, "timings": timings,
                    "frame_inverse_err_m": round(inv_err, 4),
                    "utm_zone": zone, "south": bool(south)}
    if diag and len(diag.get("apex", [])):
        veg["stats"]["kind_metrics"] = {
            k: [round(float(np.percentile(v, q)), 2) for q in (10, 50, 90)]
            for k, v in diag.items()}
    used = dict(prm)
    used.pop("area_bbox_utm", None)
    veg["params"] = used
    with open(os.path.join(out_dir, "veg.json"), "w") as f:
        json.dump(veg, f, indent=1)
    sizes = {n: os.path.getsize(os.path.join(out_dir, n))
             for n in ("shapes.bin", "shell.bin", "ground.bin")
             if os.path.exists(os.path.join(out_dir, n))}
    say("  " + ", ".join(f"{k} {v / 1e6:.2f} MB" for k, v in sizes.items()))
    say(f"Done in {secs:.1f} s")
    return veg


def _label_bases(V, f_c, lab, n, min_h):
    """Crown base per label (same rule as tree_records), unfiltered."""
    pl = lab.ravel()[f_c]
    inn = pl > 0
    nb = int(math.ceil(MAX_HAG)) + 1
    hb = np.minimum(V.h[inn].astype(np.int64), nb - 1)
    prof = np.bincount(pl[inn].astype(np.int64) * nb + hb,
                       minlength=(n + 1) * nb).reshape(n + 1, nb)[1:]
    height = np.zeros(n + 1, np.float32)
    np.maximum.at(height, pl[inn], V.h[inn])
    height = height[1:]
    idx = np.arange(nb)[None, :]
    upper = idx >= (0.2 * height)[:, None]
    top_bin = np.floor(height).astype(int)
    pk = np.argmax(np.where(upper & (idx <= top_bin[:, None]), prof, -1), axis=1)
    peak = prof[np.arange(n), pk]
    thin = prof < np.maximum(1, 0.12 * peak)[:, None]
    gap = thin & np.roll(thin, 1, axis=1)
    gap[:, 0] = thin[:, 0]
    cand = gap & (idx < pk[:, None]) & (idx >= int(min_h))
    lowgap = np.where(cand, idx, -1).max(axis=1)
    return np.where(lowgap >= 0, lowgap + 1.0, min_h)


# --------------------------------------------------------------------------
# The made-up scene (tests and --demo)
# --------------------------------------------------------------------------

def synth_scene(seed=3, density=20.0):
    """Points (local x, y, z, class) and the truth over a 200 x 160 m area
    on a gentle slope: conifers (cones), broadleaf (domes), a brush patch,
    open ground. Returns x, y, z, cls, truth dict."""
    rng = np.random.default_rng(seed)
    W, H = 200.0, 160.0

    def zf(x, y):
        return 300.0 + 0.08 * x + 0.03 * y + 1.5 * np.sin(x / 40.0)

    trees = []      # x, y, height, radius, base, kind
    # Conifers in the west, spaced 9-11 m.
    for i, (x, y) in enumerate([(20, 30), (31, 32), (22, 43), (34, 45),
                                (25, 57), (40, 60), (18, 70), (33, 74)]):
        h = 18 + (i * 7) % 12
        trees.append((x, y, float(h), 2.2 + 0.05 * h, 1.0 + (i % 3), 1))
    # Broadleaf in the east, wider and flatter.
    for i, (x, y) in enumerate([(130, 30), (146, 36), (132, 50), (150, 55),
                                (138, 70)]):
        h = 11 + (i * 5) % 7
        trees.append((x, y, float(h), 5.0 + 0.2 * (i % 3), 0.35 * h, 0))
    brush = (70.0, 100.0, 110.0, 140.0)     # x0, y0, x1, y1
    X, Y, Z, C = [], [], [], []
    n = int(W * H * density)
    gx = rng.uniform(0, W, n); gy = rng.uniform(0, H, n)
    under = np.zeros(n, bool)
    for (tx, ty, h, r, b, k) in trees:
        under |= (gx - tx) ** 2 + (gy - ty) ** 2 < r * r
    keep = ~under | (rng.random(n) < 0.35)
    gx, gy = gx[keep], gy[keep]
    X.append(gx); Y.append(gy); Z.append(zf(gx, gy) + rng.normal(0, 0.03, len(gx)))
    C.append(np.full(len(gx), 2, np.uint8))
    for (tx, ty, h, r, b, k) in trees:
        m = int(math.pi * r * r * density * 1.6)
        rr = r * np.sqrt(rng.random(m))
        a = rng.uniform(0, 2 * math.pi, m)
        px, py = tx + rr * np.cos(a), ty + rr * np.sin(a)
        u = rr / r
        if k == 1:
            surf = h - (h - b) * u
        else:
            surf = b + (h - b) * np.sqrt(np.maximum(0, 1 - u * u)) * 0.85 + \
                (h - b) * 0.15 * (1 - u)
        depth = rng.exponential(0.12 * (h - b), m)
        pz = np.maximum(b, surf - depth)
        X.append(px); Y.append(py); Z.append(zf(px, py) + pz)
        C.append(np.full(m, 1, np.uint8))
        # A few trunk returns.
        mt = int(3 * b) + 2
        X.append(tx + rng.normal(0, 0.15, mt)); Y.append(ty + rng.normal(0, 0.15, mt))
        Z.append(zf(tx, ty) + rng.uniform(0.2, max(0.5, b), mt))
        C.append(np.full(mt, 1, np.uint8))
    bx0, by0, bx1, by1 = brush
    m = int((bx1 - bx0) * (by1 - by0) * density * 0.6)
    px = rng.uniform(bx0, bx1, m); py = rng.uniform(by0, by1, m)
    X.append(px); Y.append(py); Z.append(zf(px, py) + rng.uniform(0.6, 1.6, m))
    C.append(np.full(m, 1, np.uint8))
    # Noise: a bird high up, a few low noise returns (class 7).
    X.append(np.array([100.0, 100.3])); Y.append(np.array([20.0, 20.2]))
    Z.append(zf(100.0, 20.0) + np.array([45.0, 45.4])); C.append(np.array([1, 1], np.uint8))
    X.append(np.array([60.0, 61.0])); Y.append(np.array([130.0, 131.0]))
    Z.append(zf(60.0, 130.0) + np.array([25.0, -8.0])); C.append(np.array([7, 7], np.uint8))
    truth = {"trees": trees, "brush": brush, "open": (160.0, 100.0, 200.0, 160.0),
             "W": W, "H": H, "zf": zf}
    return (np.concatenate(X), np.concatenate(Y), np.concatenate(Z),
            np.concatenate(C), truth)


def write_scene_npz(path, seed=3, density=20.0):
    x, y, z, c, truth = synth_scene(seed, density)
    e0, n0, zone = rc.example_origin()
    np.savez(path, x=x + e0, y=y + n0, z=z, classification=c,
             epsg=np.int64(32600 + zone))
    return truth, (e0, n0, zone)


def demo(out_dir, say=say_default):
    """The made-up scene around the documentation example (45.1234,
    -100.5678): conifers, broadleaf, brush, open ground. Writes
    OUTDIR/points.npz, params.json and the normal outputs."""
    os.makedirs(out_dir, exist_ok=True)
    npz = os.path.join(out_dir, "points.npz")
    truth, (e0, n0, zone) = write_scene_npz(npz)
    ring = []
    for (xl, yl) in ((0, 0), (truth["W"], 0), (truth["W"], truth["H"]),
                     (0, truth["H"]), (0, 0)):
        lon, lat = rc.xy_to_lonlat(np.array([e0 + xl]), np.array([n0 + yl]),
                                   zone, False)
        ring.append([round(float(lon[0]), 8), round(float(lat[0]), 8)])
    params = {"source": {"npz": npz}, "area": ring,
              "looks": ["shapes", "shell"], "detail": "medium",
              "min_height": 0.5, "brush_top": 2.0, "max_triangles": 300000}
    with open(os.path.join(out_dir, "params.json"), "w") as f:
        json.dump(params, f, indent=1)
    return run(params, out_dir, say=say)


# --------------------------------------------------------------------------

def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="Light vegetation shapes from "
                                 "LiDAR (FLEX).")
    ap.add_argument("--params", help="PARAMS.json")
    ap.add_argument("--out", help="output folder")
    ap.add_argument("--points-npz", default=None,
                    help="points from an npz (x, y, z, classification, epsg) "
                         "instead of params.source")
    ap.add_argument("--points-epsg", type=int, default=None,
                    help="EPSG of the npz x/y when the file has no 'epsg' "
                         "(a UTM code, 326zz or 327zz)")
    ap.add_argument("--demo", metavar="OUTDIR", default=None,
                    help="write a made-up scene to OUTDIR")
    a = ap.parse_args(argv)
    try:
        if a.demo:
            demo(a.demo)
            return 0
        if not a.params or not a.out:
            ap.error("--params and --out are required (or --demo OUTDIR)")
        with open(a.params) as f:
            params = json.load(f)
        if a.points_npz:
            params["source"] = {"npz": a.points_npz}
            if a.points_epsg:
                params["source"]["epsg"] = a.points_epsg
        run(params, a.out)
        return 0
    except SystemExit as e:
        if e.code not in (None, 0):
            rc.ascii_say(f"! {e.code}")
            return 1
        return 0
    except Exception as e:
        import traceback
        if a.out:
            try:
                os.makedirs(a.out, exist_ok=True)
                with open(os.path.join(a.out, "log.txt"), "a") as f:
                    f.write(traceback.format_exc())
            except Exception:
                pass
        rc.ascii_say(f"! {type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
