#!/usr/bin/env python3
"""
veg_shapes.py -- light 3D shapes of the vegetation for FLEX.

    python veg_shapes.py --params PARAMS.json --out OUTDIR [--points-npz FILE]
    python veg_shapes.py --demo OUTDIR           (made-up scene, no PDAL)

From the LiDAR of an area and the ground under it, two "looks" that are much
lighter to draw and to keep than the cloud:

  shapes  one crown per tree with its outline measured from its own
          returns, plus low mounds for brush
  shell   a smoothed skin around the vegetation points (a "canopy cloud")

The contract with FLEX (params, veg.json, the .bin layouts) is in the
vegetation brief; outputs in OUTDIR:

    veg.json     the index: origin, frame, bbox, counts, stats, params
    shapes.bin   N x 12 float32: x y zg height radius base kind density
                 r1 r2 r3 r4 (version 2; record 48 bytes)
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
            Bumps on one crown are joined (a blunt lower top behind a
            shallow saddle); a tall tree's crown gives up the lower canopy
            around it (cells off its own fitted surface, in a partly flat
            patch), which gets crowns of its own.
            Per crown: every return (thinned to ~16 per m2 at medium) goes
            to the nearby crown whose envelope (from the canopy surface) it
            fits best at its height, so a neighbour's branches do not widen
            a crown and the watershed's cut does not narrow it. Height =
            the crown's highest cell; base = above the emptiest layer under
            its densest part (the trunk zone), else where its returns thin
            out going down; position = halfway between the top and the
            centre of its returns above the base. Outline: in 20 slices
            from base to top the 90th percentile of the returns' distance
            from that axis, capped by the canopy envelope at that height,
            slices with under 6 returns interpolated, lightly smoothed;
            radius = the widest, r1..r4 = the radius at 10/35/60/85 % of
            the crown as fractions of it (a prior by kind only when under
            3 slices could be measured). Kind (a label now) = cone when the
            top is narrow (r4 <= 0.6) and the crown is at least twice as
            long as it is wide, else dome. Density = share of the column's
            returns caught by the crown above its base.
  brush     returns min_height..brush_top, as a share of all returns per
            cell; cells under trees whose crown starts low are the tree's
            own branches and are left out. Brushy cells are pooled in tiles
            a few metres across: one mound per tile at the brushy cells'
            centre, radius from their area, height = 90th percentile of the
            cells' tops, outline = at each profile height the share of the
            mound's cells whose brush reaches it (as an area, so a flat
            thicket is a drum and scattered shrubs a dome), density =
            twice the band's share of all returns (0.05..1). Tiles grow if
            the record budget is exceeded.
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

VERSION = 2
GROUND_CLASS = 2
VEG_CLASSES = (0, 1, 3, 4, 5)      # never classified, unclassified, veg
NOISE_CLASSES = (7, 18)
MAX_HAG = 100.0                    # taller "vegetation" is an error
ROCK_MAX_H = 4.0                   # bare-rock "vegetation" is lower than this
RECORD = 12                        # float32 per shapes.bin record

DETAIL = {
    #        CHM cell, CHM smoothing sigma (m), finest shell voxel, brush
    #        tile, ground.bin cell, shape records per km2, shell triangles
    #        per km2 (the job's budget is the smaller of this and
    #        max_triangles)
    "low":    dict(chm=1.0, smooth=0.9, voxel=3.0, tile=6.0, gcell=10.0,
                   budget=30000, tri_km2=100000, keep=10.0),
    "medium": dict(chm=0.5, smooth=0.6, voxel=2.0, tile=4.0, gcell=5.0,
                   budget=60000, tri_km2=300000, keep=16.0),
    "high":   dict(chm=0.5, smooth=0.5, voxel=1.25, tile=3.0, gcell=5.0,
                   budget=120000, tri_km2=1000000, keep=32.0),
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


def top_sharpness(chm, tops_r, tops_c, cell):
    """How pointed each top is: the highest cell within 0.5 m of it minus
    the mean of the cells 1.0..1.5 m away (m). Conifer apexes drop 1-3 m
    there; a bump on a broad crown a few decimetres."""
    reach = int(math.ceil(1.5 / cell))
    P = np.pad(chm, reach, mode="edge")
    core, ring = [], []
    for i in range(-reach, reach + 1):
        for j in range(-reach, reach + 1):
            d = math.hypot(i, j) * cell
            v = P[tops_r + reach + i, tops_c + reach + j]
            if d <= 0.5:
                core.append(v)
            elif 1.0 <= d <= 1.5:
                ring.append(v)
    if not ring:
        return np.zeros(len(tops_r), np.float32)
    return np.max(core, axis=0) - np.mean(ring, axis=0)


def merge_tops(chm, chm_s, lab, tops_r, tops_c, cg):
    """Join crowns that are one crown with several bumps on it: a lower top
    whose saddle with a higher neighbour is shallow, which is itself blunt
    (a conifer apex is sharp) and which sits within half a crown's reach.
    Broad flat-topped crowns were cut into slivers in round 1. Returns the
    new labels and tops (the higher top of each group)."""
    n = len(tops_r)
    if n < 2:
        return lab, tops_r, tops_c, 0
    th = chm_s[tops_r, tops_c]
    sharp = top_sharpness(chm, tops_r, tops_c, cg.cell)
    A = np.concatenate([lab[:, :-1].ravel(), lab[:-1].ravel()])
    B = np.concatenate([lab[:, 1:].ravel(), lab[1:].ravel()])
    S = np.concatenate([np.minimum(chm_s[:, :-1], chm_s[:, 1:]).ravel(),
                        np.minimum(chm_s[:-1], chm_s[1:]).ravel()])
    k = (A > 0) & (B > 0) & (A != B)
    A, B, S = A[k], B[k], S[k]
    if not len(A):
        return lab, tops_r, tops_c, 0
    # Higher top = a (ties by label), lower = b; saddle = the highest
    # boundary cell between them.
    hiA = (th[A - 1] > th[B - 1]) | ((th[A - 1] == th[B - 1]) & (A < B))
    a = np.where(hiA, A, B).astype(np.int64)
    b = np.where(hiA, B, A).astype(np.int64)
    key = b * (n + 1) + a
    o = np.lexsort((-S, key))
    key, S, a, b = key[o], S[o], a[o], b[o]
    first = np.r_[0, np.nonzero(np.diff(key))[0] + 1]
    sad, a, b = S[first], a[first], b[first]
    tb = th[b - 1]
    dep = tb - sad
    dab = np.hypot(tops_r[a - 1] - tops_r[b - 1],
                   tops_c[a - 1] - tops_c[b - 1]) * cg.cell
    ok = (dep < 0.25 + 0.015 * tb) & (sharp[b - 1] < 0.3 + 0.02 * tb) & \
        (dab < 0.5 * crown_reach(tb) + 1.0)
    a, b, sad = a[ok], b[ok], sad[ok]
    if not len(a):
        return lab, tops_r, tops_c, 0
    # Each b joins the neighbour it shares the highest saddle with.
    o = np.lexsort((-sad, b))
    a, b = a[o], b[o]
    f = np.r_[True, b[1:] != b[:-1]]
    parent = np.arange(n + 1)
    parent[b[f]] = a[f]
    for _ in range(64):
        nxt = parent[parent]
        if np.array_equal(nxt, parent):
            break
        parent = nxt
    # A chain may not carry a top further than the root's reach.
    root = parent[1:]
    far = np.hypot(tops_r - tops_r[root - 1], tops_c - tops_c[root - 1]) * \
        cg.cell > crown_reach(th[root - 1])
    parent[1:][far] = np.arange(1, n + 1)[far]
    roots = np.nonzero(parent[1:] == np.arange(1, n + 1))[0] + 1
    new = np.zeros(n + 1, np.int32)
    new[roots] = np.arange(1, len(roots) + 1, dtype=np.int32)
    lab = new[parent[lab]] * (lab > 0)
    return lab.astype(np.int32), tops_r[roots - 1], tops_c[roots - 1], \
        n - len(roots)


LOWER_SLOPE = 1.0        # a lower canopy: cells flatter than this (rise / run) ...
LOWER_FLAT_M2 = 4.0      # ... over at least this many m2 of the patch


def lower_layer(chm, chm_s, lab, tops_r, tops_c, cg, tree_min):
    """A tall tree over a lower canopy: the watershed hands the lower
    canopy around it to the tall tree, whose crown then reads as wide as
    the whole patch. Per crown the surface near its top is fitted (drop =
    k1 d + k2 d^2 from the top); cells well off that surface carried
    outward and much lower than the top, in a patch that is partly flat
    (a canopy, not a crown's flank), leave the crown, and that lower layer
    gets its own tops and crowns. Returns labels, tops, count added."""
    n = len(tops_r)
    if n == 0:
        return lab, tops_r, tops_c, 0
    c = cg.cell
    rr, cc = np.nonzero(lab)
    L = lab[rr, cc]
    H = chm_s[tops_r, tops_c]
    d = np.hypot(rr - tops_r[L - 1], cc - tops_c[L - 1]) * c
    drop = np.maximum(0.0, H[L - 1] - chm_s[rr, cc])
    dmax = np.zeros(n + 1)
    np.maximum.at(dmax, L, d)
    inner = (d > 0.3) & (d <= np.maximum(1.5, 0.45 * dmax[L]))

    def S(w):
        return np.bincount(L[inner], w[inner], minlength=n + 1)[1:]
    di, dr = d, drop
    s2, s3, s4 = S(di ** 2), S(di ** 3), S(di ** 4)
    b1, b2 = S(dr * di), S(dr * di ** 2)
    det = s2 * s4 - s3 ** 2
    ok = det > 1e-9
    k1 = np.where(ok, (b1 * s4 - b2 * s3) / np.where(ok, det, 1), 0.0)
    k2 = np.where(ok, (s2 * b2 - s3 * b1) / np.where(ok, det, 1), 0.0)
    lin = b1 / np.maximum(s2, 1e-9)                 # k2 < 0: a cone
    k1 = np.where(k2 < 0, lin, k1)
    k2 = np.maximum(k2, 0.0)
    k1 = np.maximum(k1, 0.0)
    env = H[L - 1] - k1[L - 1] * d - k2[L - 1] * d * d
    h = H[L - 1]
    z = chm_s[rr, cc]
    # Far under that surface carried outward (a flat crown over a lower
    # one), or above it where a steep crown's own surface would already
    # have reached the lower canopy: either way not this crown's surface.
    cut = (d > 1.5) & (z < 0.7 * h) & \
        ((z < env - (0.2 * h + 1.0)) | (z > env + (0.1 * h + 1.0)))
    if not cut.any():
        return lab, tops_r, tops_c, 0
    # Only where that lower surface is a canopy of its own: a patch with a
    # good part flat (a crown's steep flank or rim is not one).
    from scipy import ndimage
    low = np.zeros(lab.shape, bool)
    low[rr[cut], cc[cut]] = True
    gy, gx = np.gradient(chm_s.astype(np.float64), c)
    flat = low & (np.hypot(gx, gy) < LOWER_SLOPE)
    comp, ncomp = ndimage.label(low, structure=np.ones((3, 3)))
    if ncomp == 0:
        return lab, tops_r, tops_c, 0
    nflat = np.bincount(comp[flat], minlength=ncomp + 1) * c * c
    low &= (nflat >= LOWER_FLAT_M2)[comp]
    if not low.any():
        return lab, tops_r, tops_c, 0
    lab = lab.copy()
    lab[low] = 0
    # The lower layer: its own tops and crowns, only on the cut cells.
    cs = np.where(low, chm_s, 0.0).astype(np.float32)
    t2r, t2c = find_tops(cs, cg, tree_min)
    if not len(t2r):
        return lab, tops_r, tops_c, 0
    lab2 = crowns(np.where(low, chm, 0.0), cs, cg, t2r, t2c, tree_min)
    lab2 = np.where(low, lab2, 0)
    add = lab2 > 0
    lab[add] = lab2[add] + n
    return lab, np.r_[tops_r, t2r], np.r_[tops_c, t2c], len(t2r)


CHM_BOUND = True
DEBUG = None        # a dict to receive the trees' intermediate arrays (diagnostics)
BASE_THIN = 0.45                     # base: a trunk zone thinner than this share
BASE_EDGE = 0.30                     # of the crown body's returns; else this
PROFILE = (0.10, 0.35, 0.60, 0.85)   # where r1..r4 are measured (of base..top)
NSLICE = 20                          # crown slices measured, base to top
NUB = 40                             # bins of a tree's own vertical profile
NLEV = 16                            # levels of the provisional envelope
NHIST = 64                           # distance bins per slice
SLICE_Q = 0.90                       # radius of a slice = this quantile
SLICE_MIN = 6                        # fewer returns than this: slice unknown
BRUSH_PROFILE = (1.0, 0.9, 0.7, 0.4)  # a low dome, unless measured
PRIOR = {0: (0.70, 1.0, 0.90, 0.50), 1: (1.0, 0.80, 0.50, 0.20)}


def _group_quantile(hist, q):
    """Per row of a (rows, bins) histogram, the q quantile in bin units
    (linear inside the bin); NaN for empty rows."""
    cs = np.cumsum(hist, axis=1)
    tot = cs[:, -1]
    want = q * tot
    j = np.argmax(cs >= want[:, None], axis=1)
    prev = np.where(j > 0, cs[np.arange(len(j)), np.maximum(j - 1, 0)], 0)
    inb = hist[np.arange(len(j)), j]
    frac = np.where(inb > 0, (want - prev) / np.maximum(inb, 1), 0.5)
    out = j + np.clip(frac, 0, 1)
    return np.where(tot > 0, out, np.nan)


def tree_records(V, f_c, chm, chm_s, lab, cg, tops_r, tops_c, tot_c,
                 min_h, brush_top, kinds_mode="auto", keep_m2=16.0):
    """Per crown: position, height, base, the measured outline (radius at
    PROFILE heights and the widest), kind, density. Returns (records,
    diag, base of every label for the brush)."""
    from scipy import ndimage
    n = len(tops_r)
    empty = (np.zeros((0, RECORD), np.float32),
             {"weak": np.zeros(0, bool), "slices_known": np.zeros(0, int),
              "slivers": 0,
              "stride": 1, "seconds": 0.0}, np.zeros(0, np.float32))
    if n == 0:
        return empty
    t0 = time.time()
    c = cg.cell
    # Local (V frame) coordinates of cell centres.
    cx0 = cg.minx - V.ox + 0.5 * c
    cy0 = cg.maxy - V.oy - 0.5 * c
    rr, cc = np.nonzero(lab)
    L = lab[rr, cc]
    ncell = np.bincount(L, minlength=n + 1)
    topx = cx0 + tops_c * c
    topy = cy0 - tops_r * c
    with np.errstate(invalid="ignore"):
        gx = np.bincount(L, cx0 + cc * c, minlength=n + 1)[1:] / np.maximum(ncell[1:], 1)
        gy = np.bincount(L, cy0 - rr * c, minlength=n + 1)[1:] / np.maximum(ncell[1:], 1)
    ax = np.r_[0.0, 0.5 * (topx + gx)]
    ay = np.r_[0.0, 0.5 * (topy + gy)]
    topH = np.r_[-1.0, chm[tops_r, tops_c]]

    # Provisional envelope from the canopy surface: at level k (height
    # k/NLEV of the top) the farthest crown cell whose canopy is that high.
    dcell = np.hypot(cx0 + cc * c - ax[L], cy0 - rr * c - ay[L])
    kc = np.clip((chm[rr, cc] / topH[L] * NLEV).astype(np.int64), 0, NLEV)
    R0 = np.zeros((n + 1) * (NLEV + 1))
    np.maximum.at(R0, L * (NLEV + 1) + kc, dcell + 0.5 * c)
    R0 = R0.reshape(n + 1, NLEV + 1)
    R0 = np.maximum.accumulate(R0[:, ::-1], axis=1)[:, ::-1]
    R0 = np.maximum(R0, 0.5)
    Rlab = R0[:, 0]

    # Candidates for each return: its crown and the crowns around it.
    # Cells just outside every crown (the floor / reach cut its skirt)
    # take the nearest crown within 2.5 m.
    far = lab == 0
    if far.any() and (~far).any():
        dist, (ir, ic) = ndimage.distance_transform_edt(far, return_indices=True)
        labx = np.where(dist * c <= 2.5, lab[ir, ic], 0).astype(np.int32)
    else:
        labx = lab
    A = np.concatenate([labx[:, :-1].ravel(), labx[:-1].ravel(),
                        labx[:-1, :-1].ravel(), labx[:-1, 1:].ravel()])
    B = np.concatenate([labx[:, 1:].ravel(), labx[1:].ravel(),
                        labx[1:, 1:].ravel(), labx[1:, :-1].ravel()])
    k = (A > 0) & (B > 0) & (A != B)
    pr = np.unique(np.concatenate([A[k] * (n + 1) + B[k],
                                   B[k] * (n + 1) + A[k]]).astype(np.int64))
    pa, pb = pr // (n + 1), pr % (n + 1)
    dd = np.hypot(ax[pa] - ax[pb], ay[pa] - ay[pb])
    o = np.lexsort((dd, pa))
    pa, pb = pa[o], pb[o]
    first = np.r_[0, np.nonzero(np.diff(pa))[0] + 1] if len(pa) else np.zeros(0, int)
    rank = np.arange(len(pa)) - np.repeat(first, np.diff(np.r_[first, len(pa)]))
    K = 8
    C = np.zeros((n + 1, K + 1), np.int64)
    C[:, 0] = np.arange(n + 1)
    sel = rank < K
    C[pa[sel], 1 + rank[sel]] = pb[sel]

    # Returns used: a regular thinning to about `keep_m2` per m2 (a
    # quantile per slice does not need every return).
    N = len(V.h)
    stride = max(1, int(round(N / (keep_m2 * cg.nx * cg.ny * c * c))))
    idx = np.arange(0, N, stride)
    pl = labx.ravel()[f_c[idx]]
    m_ = pl > 0
    idx, pl = idx[m_], pl[m_]
    px, py, ph = V.x[idx], V.y[idx], V.h[idx]
    del m_

    # Pass A: each return goes to the crown it fits best: distance over
    # that crown's envelope at the return's height (a neighbour's branches
    # under a lower crown's top go to the neighbour, not to it). Returns
    # well inside their own crown's envelope stay there without the test.
    axf, ayf = ax.astype(np.float32), ay.astype(np.float32)
    tHf = topH.astype(np.float32)
    R0f = (np.maximum(R0, 0.3) ** 2).astype(np.float32)
    lev = np.float32(NLEV)

    def q2(cand, x, y, h):
        tH = tHf[cand]
        kk = np.clip((h / np.maximum(tH, 0.1) * lev).astype(np.int32), 0, NLEV)
        d2 = (x - axf[cand]) ** 2 + (y - ayf[cand]) ** 2
        q = d2 / R0f[cand, kk]
        q[(cand == 0) | (h > tH + 0.5)] = np.inf
        return q

    own = np.zeros(len(idx), np.int32)
    qo = q2(pl, px, py, ph)
    easy = qo <= 0.5 ** 2
    own[easy] = pl[easy]
    hard = np.nonzero(~easy)[0]
    CH = 1 << 20
    for s in range(0, len(hard), CH):
        hi = hard[s:s + CH]
        cand = C[pl[hi]]
        q = q2(cand, px[hi, None], py[hi, None], ph[hi, None])
        j = np.argmin(q, axis=1)
        qm = q[np.arange(len(hi)), j]
        own[hi] = np.where(qm <= 1.5 ** 2, cand[np.arange(len(hi)), j], 0)
    del pl, qo, easy, hard

    # Height, crown centre, base from the returns each crown kept.
    a_ = own > 0
    o_ = own[a_]
    # Height: the highest cell of the crown's canopy (every return, not
    # only the thinned ones).
    height = np.zeros(n + 1, np.float32)
    np.maximum.at(height, L, chm[rr, cc])
    hgt = np.maximum(height, 0.1)
    ub = np.clip((ph[a_] / hgt[o_] * NUB).astype(np.int64), 0, NUB - 1)
    kb = o_.astype(np.int64) * NUB + ub
    prof = np.bincount(kb, minlength=(n + 1) * NUB).reshape(n + 1, NUB).astype(np.float64)
    sm = prof.copy()
    sm[:, 1:-1] = (prof[:, :-2] + prof[:, 1:-1] + prof[:, 2:]) / 3.0
    iu = np.arange(NUB)
    body = (iu >= 0.4 * NUB) & (iu < 0.9 * NUB)
    Bm = np.median(sm[:, body], axis=1)
    # The crown starts above the emptiest layer under its densest part
    # (the trunk zone between understory and crown), on the rising edge
    # out of it. If that layer is not thin (under BASE_THIN of the body),
    # going down from the densest part the crown ends where its returns
    # stay under BASE_EDGE of the body's for two bins; if they never do,
    # it reaches down to min_height.
    upper = iu >= 0.5 * NUB          # a lower layer can be denser than it
    pk = np.argmax(np.where(upper[None, :], sm, -1), axis=1)
    below = (iu[None, :] < pk[:, None]) & (iu[None, :] >= 1)
    vmin = np.where(below, sm, np.inf).min(axis=1)
    near = below & (sm <= (vmin + 0.15 * Bm)[:, None])
    jmin = np.where(near, iu[None, :], 0).max(axis=1)     # the highest such
    gap = np.isfinite(vmin) & (vmin < BASE_THIN * Bm)
    rise = vmin + 0.35 * (Bm - vmin)
    above_gap = (iu[None, :] > jmin[:, None]) & (sm >= rise[:, None])
    e1 = np.minimum(np.where(above_gap, iu[None, :], NUB).min(axis=1), pk)
    thin = sm < BASE_EDGE * Bm[:, None]
    two = thin & np.concatenate([thin[:, :1], thin[:, :-1]], axis=1)
    cand_b = two & (iu[None, :] < pk[:, None])
    low2 = np.where(cand_b, iu[None, :], -1).max(axis=1)
    edge = np.where(gap, e1, np.where(low2 >= 0, low2 + 1, -1))
    base = np.where(edge >= 0, edge / NUB * hgt, min_h)
    base = np.clip(base, 0.0, 0.85 * hgt).astype(np.float32)
    if DEBUG is not None:
        DEBUG.update(prof=prof, sm=sm, body=Bm, base=base, hgt=hgt, pk=pk)
    # Crown centre: the kept returns above the base.
    inb = ph[a_] >= base[o_]
    cntc = np.bincount(o_[inb], minlength=n + 1).astype(np.float64)
    with np.errstate(invalid="ignore"):
        mx = np.bincount(o_[inb], px[a_][inb], minlength=n + 1) / np.maximum(cntc, 1)
        my = np.bincount(o_[inb], py[a_][inb], minlength=n + 1) / np.maximum(cntc, 1)
    mx = np.where(cntc > 0, mx, ax); my = np.where(cntc > 0, my, ay)
    ax = np.r_[0.0, 0.5 * (topx + mx[1:])]
    ay = np.r_[0.0, 0.5 * (topy + my[1:])]

    if DEBUG is not None:
        DEBUG.update(own=own, idx=idx, ax=ax, ay=ay)
    # Pass B: per slice of the crown the SLICE_Q quantile of the kept
    # returns' distance from the axis.
    o2 = o_[inb]
    h2 = ph[a_][inb]
    d2 = np.hypot(px[a_][inb] - ax[o2], py[a_][inb] - ay[o2])
    clen = np.maximum(hgt - base, 0.1)
    sl = np.clip(((h2 - base[o2]) / clen[o2] * NSLICE).astype(np.int64), 0, NSLICE - 1)
    Rref = 2.0 * np.maximum(Rlab, 1.0)
    hb = np.clip((d2 / Rref[o2] * NHIST).astype(np.int64), 0, NHIST - 1)
    hist = np.bincount((o2 * NSLICE + sl) * NHIST + hb,
                       minlength=(n + 1) * NSLICE * NHIST)
    hist = hist.reshape((n + 1) * NSLICE, NHIST)
    cnt = hist.sum(1).reshape(n + 1, NSLICE)
    rq = _group_quantile(hist, SLICE_Q).reshape(n + 1, NSLICE)
    rq = rq / NHIST * Rref[:, None]
    del hist
    good = cnt >= SLICE_MIN
    rq = np.where(good, rq, np.nan)
    # The canopy surface bounds it from above: a branch at height z makes
    # its cell's canopy at least z high, so the crown at z lies within the
    # farthest cell of its crown whose canopy reaches z (the envelope).
    zs = base[:, None] + (np.arange(NSLICE) + 0.5)[None, :] / NSLICE * clen[:, None]
    ks = np.clip((zs / np.maximum(topH, 0.1)[:, None] * NLEV).astype(np.int64), 0, NLEV)
    Rchm = R0[np.arange(n + 1)[:, None], ks]
    if CHM_BOUND:
        rq = np.where(good, np.minimum(rq, Rchm), np.nan)
    good = good & (rq > 0)
    # Fill unknown slices along height (linear between known ones; above
    # the highest known slice taper to the top, below the lowest hold).
    zc = (np.arange(NSLICE) + 0.5) / NSLICE
    prof_r = np.zeros_like(rq)
    nknown = good.sum(1)
    for t in np.nonzero(nknown >= 1)[0]:
        g = good[t]
        zz = np.r_[zc[g], 1.0]
        vv = np.r_[rq[t, g], 0.0]
        prof_r[t] = np.interp(zc, zz, vv)
    # Smooth along height (light, 0.15-0.7-0.15), ends kept.
    sm_r = prof_r.copy()
    sm_r[:, 1:-1] = 0.15 * prof_r[:, :-2] + 0.7 * prof_r[:, 1:-1] + 0.15 * prof_r[:, 2:]
    widest = sm_r.max(axis=1)
    # The four PROFILE heights, linear between slice centres.
    pos = np.array(PROFILE) * NSLICE - 0.5
    i0 = np.clip(np.floor(pos).astype(int), 0, NSLICE - 1)
    i1 = np.clip(i0 + 1, 0, NSLICE - 1)
    w = np.clip(pos - i0, 0, 1)
    rP = sm_r[:, i0] * (1 - w) + sm_r[:, i1] * w
    weak = nknown < 3
    with np.errstate(invalid="ignore", divide="ignore"):
        fracs = rP / widest[:, None]

    # Kind, now a label from the measured outline: widest low and a narrow
    # top = cone; else dome.
    with np.errstate(invalid="ignore"):
        cone = (fracs[:, 3] <= 0.6) & ((hgt - base) >= 2.0 * widest)
    if kinds_mode == "dome":
        cone[:] = False
    kind = np.where(cone, 1.0, 0.0)
    # Too few returns to measure: the prior for its kind, at the label's
    # radius from the canopy surface.
    rad_area = np.sqrt(ncell * c * c / math.pi)
    for kd in (0, 1):
        mm = weak & (kind == kd)
        fracs[mm] = PRIOR[kd]
    widest = np.where(weak | ~np.isfinite(widest), rad_area, widest)
    # Never wider than the reach a crown may have from its top.
    widest = np.minimum(widest, crown_reach(hgt))
    fracs = np.clip(np.nan_to_num(fracs, nan=0.5), 0.02, 1.0)

    # Density: share of all the column's returns caught at or above the base.
    above = cntc * stride
    tot = np.bincount(lab.ravel(), tot_c.ravel(), minlength=n + 1)
    dens = np.clip(above / np.maximum(tot, 1), 0, 1)

    xs = ax[1:] + V.ox
    ys = ay[1:] + V.oy
    rec = np.zeros((n, RECORD), np.float32)
    rec[:, 0], rec[:, 1] = xs, ys
    rec[:, 3] = height[1:]
    rec[:, 4] = np.maximum(widest[1:], 0.5)
    rec[:, 5] = base[1:]
    rec[:, 6] = kind[1:]
    rec[:, 7] = dens[1:]
    rec[:, 8:12] = fracs[1:]
    # A small crown whose returns nearly all fit its neighbours better is
    # a sliver of them, not a tree (it would draw as a thin spike).
    sliver = weak[1:] & (rad_area[1:] < 1.5)
    ok = (ncell[1:] * c * c >= max(1.0, math.pi * 0.6 ** 2)) & \
        (height[1:] >= brush_top) & (cntc[1:] >= 3) & ~sliver
    if DEBUG is not None:
        DEBUG.update(rec_all=rec.copy(), ok=ok)
    diag = {"weak": weak[1:][ok], "slices_known": nknown[1:][ok],
            "slivers": int((sliver & (height[1:] >= brush_top)).sum()),
            "stride": stride, "seconds": time.time() - t0}
    rec = rec[ok]
    rec = rec[np.argsort(-rec[:, 3], kind="stable")]
    return rec, diag, base[1:]


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
    # Height: 90th percentile of the cells' tops in the tile (its top, not
    # its typical height: the outline below says how it tapers).
    tops = top[cells]
    o2 = np.lexsort((tops, tid))
    tops_sorted = tops[o2]
    pick = first + np.minimum(cnt - 1, (0.9 * (cnt - 1)).round().astype(int))
    h = np.maximum(tops_sorted[pick], min_h)
    rad = np.minimum(np.sqrt(cnt * bg.cell ** 2 / math.pi) * 1.25,
                     0.8 * k * bg.cell)
    # Outline measured like a crown seen from above: at each PROFILE height
    # the share of the mound's cells whose brush reaches it, as an area.
    tile_of = np.repeat(np.arange(len(first)), cnt)
    prof = np.empty((len(first), 4), np.float32)
    for j, f in enumerate(PROFILE):
        z = f * h
        share = np.add.reduceat((tops_sorted >= z[tile_of]).astype(np.float64),
                                first) / cnt
        prof[:, j] = np.sqrt(share)
    prof /= np.maximum(prof.max(axis=1, keepdims=True), 1e-6)
    prof = np.clip(prof, 0.15, 1.0)
    rec = np.zeros((int(keep.sum()), RECORD), np.float32)
    rec[:, 0], rec[:, 1] = xs[keep], ys[keep]
    rec[:, 3] = h[keep]
    rec[:, 4] = np.maximum(rad[keep], 0.5)
    rec[:, 5] = 0.0
    rec[:, 6] = 2.0
    rec[:, 7] = np.clip(fr[keep] * 2.0, 0.05, 1.0)
    rec[:, 8:12] = prof[keep]
    return rec


# --------------------------------------------------------------------------
# Shell: occupancy voxels -> fine surface nets -> simplified (veg_mesh.py)
# --------------------------------------------------------------------------
#
# The shell is extracted at a FINE voxel (SHELL_VOXEL by detail: crowns,
# gaps and understory are a few voxels across) and then simplified to the
# triangle budget by quadric edge collapse (veg_mesh.simplify), which keeps
# triangles where the surface bends and spends few where it is flat:
#
#   occupancy  share of 'full' per voxel (vh across, vz = vh / 2 tall, in
#              HAG), Gaussian smoothed (SHELL_SIGMA voxels) with zero
#              outside the area, so the canopy is rounded off at the
#              area's edge instead of cut by a vertical wall;
#   manifold   veg_mesh.well_composed raises the few samples needed so the
#              inside set has no diagonal-only contacts: surface nets then
#              gives every edge exactly two triangles (no non-manifold
#              junk for the simplifier to work around);
#   surface    surface nets, Taubin smoothed (removes the voxel steps, keeps
#              the blobs' size), pieces under SHELL_MIN_PIECE triangles
#              dropped;
#   simplify   to the budget (the smaller of max_triangles and the detail's
#              triangles per km2), in x, y, HAG metres so HAG is simply the
#              vertex's height; then veg_mesh.clean (duplicates, spikes);
#   error      the typical distance between the fine and the simplified
#              surface (sampled both ways), reported as error_m.
#
# The extraction voxel is the detail's, made coarser only when the cloud is
# too sparse for it, when the fine mesh would pass SHELL_FINE_MAX triangles
# (memory) or SHELL_FINE_RATIO times the budget (finer adds nothing after
# simplification), or when the field would pass SHELL_CELLS_MAX voxels. If
# the simplified mesh still does not fit (many tiny pieces), the voxel grows
# and it runs again.

SHELL_VOXEL = {"low": 3.0, "medium": 2.0, "high": 1.5}
SHELL_SIGMA = 1.0          # Gaussian smoothing of the occupancy, in voxels
SHELL_ISO = 0.18           # surface where the smoothed occupancy crosses this
SHELL_MIN_PIECE = 32       # pieces with fewer triangles are dropped
SHELL_FINE_MAX = 8000000   # most triangles extracted before simplifying
SHELL_FINE_RATIO = 20      # ... and at most this many times the budget
SHELL_CELLS_MAX = 150e6    # most voxels in the field


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
    import veg_mesh as vm
    return vm.surface_nets(F, iso)


def laplacian(verts, tris, iters=2, lam=0.5):
    import veg_mesh as vm
    return vm.taubin(verts, tris, iters=iters, lam=lam)


def shell_vz(vh):
    return max(1.0, 0.5 * vh)


def shell_at(V, need, vh, density, hmax):
    """The smoothed occupancy field at vh, padded with one layer of outside
    and made well-composed (see the notes above)."""
    from scipy import ndimage
    import veg_mesh as vm
    vz = shell_vz(vh)
    sg = ld.Grid(need[0], need[1], need[2], need[3], vh)
    F = occupancy(V, sg, vh, vz, hmax, density)
    F = ndimage.gaussian_filter(F, SHELL_SIGMA, mode="constant")
    F, _ = vm.well_composed(np.pad(F, 1), SHELL_ISO)
    return F, vz


def build_shell(V, need, voxel, max_tri, density, say):
    """The shell at the fine voxel `voxel` (coarser only if needed, see the
    notes above), simplified to max_tri. Returns x, y (UTM), hag, triangles,
    the extraction voxel, its height and info {simplified_from, error_m,
    error_p90_m, seconds_simplify}."""
    import veg_mesh as vm
    hmax = float(V.h.max()) + voxel
    w, h = need[2] - need[0], need[3] - need[1]
    v = max(voxel, round(2.5 / math.sqrt(max(density, 0.01)) * 4) / 4)
    v = max(v, (2.0 * w * h * hmax / SHELL_CELLS_MAX) ** (1 / 3.0))
    limit = min(SHELL_FINE_MAX, max(SHELL_FINE_RATIO * max_tri, 200000))
    for attempt in range(8):
        F, vz = shell_at(V, need, v, density, hmax)
        est = 2 * vm.count_active(F, SHELL_ISO)
        if est > limit and attempt < 4:
            v_new = v * math.sqrt(est / limit) * 1.03
            say(f"  shell at {v:.2f} m would be ~{est:,} triangles: "
                f"{v_new:.2f} m")
            v = v_new
            continue
        verts, tris = vm.surface_nets(F, SHELL_ISO)
        del F
        verts = vm.taubin(verts, tris, iters=4)
        # Index units -> metres from the area's corner (x, y) and HAG (z);
        # the pad shifts by one.
        verts[:, 0] = (verts[:, 0] - 1) * v
        verts[:, 1] = (verts[:, 1] - 1) * v
        verts[:, 2] = (verts[:, 2] - 1) * vz
        verts, tris, _ = vm.clean(verts, tris, min_tris=SHELL_MIN_PIECE,
                                  spike=0)
        T0 = len(tris)
        say(f"  shell at {v:.2f} x {vz:.2f} m voxels: {len(verts):,} "
            f"vertices, {T0:,} triangles")
        t0 = time.time()
        st = {}
        if T0 > max_tri:
            sv, st_, _ = vm.simplify(verts, tris, max_tri, stats=st,
                                     say=say)
        else:
            sv, st_ = verts, tris
        sv, st_, _ = vm.clean(sv, st_, min_tris=4, spike=0.35)
        t_simp = time.time() - t0
        if len(st_) <= max_tri:
            break
        v_new = v * 1.4
        say(f"  {len(st_):,} triangles after simplifying, over the budget: "
            f"{v_new:.2f} m")
        v = v_new
    if len(st_) > max_tri:
        # Last resort: keep the largest pieces that fit.
        lab, n = vm.components(len(sv), st_)
        tl = lab[st_[:, 0]]
        cnt = np.bincount(tl, minlength=n)
        order = np.argsort(-cnt)
        keep = np.zeros(n, bool)
        keep[order[np.cumsum(cnt[order]) <= max_tri]] = True
        sv, st_, _ = vm.compact(sv, st_[keep[tl]])
    err = {"mean": 0.0, "p90": 0.0}
    if len(st_) and len(st_) < T0:
        err = vm.mesh_error(verts, tris, sv, st_,
                            n=min(100000, max(1000, T0 // 4)))
    say(f"  simplified {T0:,} -> {len(st_):,} triangles in {t_simp:.1f} s, "
        f"typical error {err['mean']:.2f} m (90 % under {err['p90']:.2f} m)")
    xs = need[0] + sv[:, 0]
    ys = need[1] + sv[:, 1]
    hag = np.maximum(0.0, sv[:, 2])
    info = {"simplified_from": int(T0), "error_m": round(err["mean"], 3),
            "error_p90_m": round(err["p90"], 3),
            "simplify_s": round(t_simp, 2), "passes": st.get("passes", 0)}
    return xs, ys, hag, st_.astype(np.uint32), v, vz, info

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


def preview(path, frame, dem, ggrid, chm, cg, recs, bbox, has_data=None,
            max_px=640):
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
    if has_data is not None:                  # no returns at all: blank
        out |= ~has_data[r2, c2].reshape(H, W)
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
        lab, tr, tc, n_merged = merge_tops(chm, chm_s, lab, tr, tc, cg)
        lab, tr, tc, n_lower = lower_layer(chm, chm_s, lab, tr, tc, cg, tree_min)
        trees, diag, bases = tree_records(V, f_c, chm, chm_s, lab, cg, tr, tc,
                                          tot_c, min_h, brush_top,
                                          kinds_mode=prm.get("kinds", "auto"),
                                          keep_m2=D["keep"])
        say(f"  {len(tr):,} crowns ({n_merged:,} bumps joined to their crown, "
            f"{n_lower:,} in a lower layer under taller trees), "
            f"outlines measured ({diag.get('seconds', 0):.1f} s)")
        # Which crowns start low enough to own the brush band under them.
        low_base = bases < brush_top + 0.5
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
        diag = {"measured": int(len(trees) - diag["weak"].sum()),
                "prior": int(diag["weak"].sum()),
                "bumps_joined": int(n_merged), "lower_layer": int(n_lower),
                "slivers_dropped": int(diag.get("slivers", 0)),
                "thinning": int(diag["stride"]),
                "median_profile": [round(float(v), 2) for v in
                                   np.median(trees[:, 8:12], axis=0)]
                if len(trees) else [],
                "seconds": round(diag["seconds"], 2)}
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
        voxel = SHELL_VOXEL.get(prm["detail"], D["voxel"])
        if n_veg:
            sx, sy, shag, tris, vox, voxz, sinfo = build_shell(
                V, need, voxel, max_tri, density, say)
        else:
            sx = sy = shag = np.zeros(0)
            tris = np.zeros((0, 3), np.uint32)
            vox, voxz = voxel, shell_vz(voxel)
            sinfo = {"simplified_from": 0, "error_m": 0.0}
        shell = (sx, sy, shag, tris, vox, voxz, max_tri, sinfo)
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
                         **counts, "record": RECORD * 4,
                         "profile": list(PROFILE)}
    if shell is not None:
        sx, sy, shag, tris, vox, voxz, max_tri, sinfo = shell
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
                        "voxel_z_m": round(voxz, 3), "budget": int(max_tri),
                        **sinfo}
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
                cg, recs, bbox, has_data=tot_c > 0)
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
    if diag:
        veg["stats"]["outlines"] = diag
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


# --------------------------------------------------------------------------
# The made-up scene (tests and --demo)
# --------------------------------------------------------------------------

SYNTH_PROFILES = {                 # r1..r4 of the made-up crowns
    "spruce": (1.0, 0.80, 0.50, 0.20),
    "column": (0.85, 1.0, 0.85, 0.45),
    "broadleaf": (0.70, 1.0, 0.90, 0.50),
    "umbrella": (0.30, 0.60, 1.0, 0.70),
}


def outline_at(prof, u):
    """The contract's outline as a fraction of the widest radius at u
    (0 = base, 1 = top): linear through (0, 0.6 r1), r1..r4 at PROFILE,
    (1, 0)."""
    return np.interp(u, (0.0,) + tuple(PROFILE) + (1.0,),
                     (0.6 * prof[0],) + tuple(prof) + (0.0,))


def synth_scene(seed=3, density=20.0):
    """Points (local x, y, z, class) and the truth over a 200 x 160 m area
    on a gentle slope: conifers (cones), broadleaf (domes), a brush patch,
    open ground. Returns x, y, z, cls, truth dict."""
    rng = np.random.default_rng(seed)
    W, H = 200.0, 160.0

    def zf(x, y):
        return 300.0 + 0.08 * x + 0.03 * y + 1.5 * np.sin(x * 0.025)

    trees = []      # x, y, height, radius, base, kind, profile (r1..r4)
    # Conifers in the west, spaced 9-11 m: spruce-like (widest low, pointed)
    # and a narrower column with a rounder top.
    for i, (x, y) in enumerate([(20, 30), (31, 32), (22, 43), (34, 45),
                                (25, 57), (40, 60), (18, 70), (33, 74)]):
        h = 18 + (i * 7) % 12
        prof = SYNTH_PROFILES["spruce"] if i % 2 == 0 else SYNTH_PROFILES["column"]
        trees.append((x, y, float(h), 2.6 + 0.06 * h, 2.0 + 2 * (i % 4), 1, prof))
    # Broadleaf in the east, wider and flatter; two umbrella-like crowns
    # (widest near the top).
    for i, (x, y) in enumerate([(130, 30), (146, 36), (132, 50), (150, 55),
                                (138, 70)]):
        h = 11 + (i * 5) % 7
        prof = SYNTH_PROFILES["umbrella" if i in (1, 4) else "broadleaf"]
        trees.append((x, y, float(h), 5.0 + 0.2 * (i % 3), 0.35 * h, 0, prof))
    brush = (70.0, 100.0, 110.0, 140.0)     # x0, y0, x1, y1
    X, Y, Z, C = [], [], [], []
    n = int(W * H * density)
    gx = rng.uniform(0, W, n); gy = rng.uniform(0, H, n)
    under = np.zeros(n, bool)
    for (tx, ty, h, r, b, k, prof) in trees:
        under |= (gx - tx) ** 2 + (gy - ty) ** 2 < r * r
    keep = ~under | (rng.random(n) < 0.35)
    gx, gy = gx[keep], gy[keep]
    X.append(gx); Y.append(gy); Z.append(zf(gx, gy) + rng.normal(0, 0.03, len(gx)))
    C.append(np.full(len(gx), 2, np.uint8))
    uu = np.linspace(0, 1, 201)
    for ti, (tx, ty, h, r, b, k, prof) in enumerate(trees):
        Ru = r * outline_at(prof, uu)
        m = int(math.pi * r * r * density * 1.6)
        # First returns: from above, on the crown's upper surface.
        m1 = int(0.5 * m)
        rho = r * np.sqrt(rng.random(m1))
        # Upper surface at rho: the highest u whose radius still reaches it.
        reach = Ru[None, :] >= rho[:, None]
        ui = np.where(reach.any(1), 200 - np.argmax(reach[:, ::-1], axis=1), 0)
        pz = b + (h - b) * uu[ui] - rng.exponential(0.04 * (h - b), m1)
        a = rng.uniform(0, 2 * math.pi, m1)
        px, py = tx + rho * np.cos(a), ty + rho * np.sin(a)
        # Returns through the crown: along its length (more where it is
        # wide), near the outline, fewer inside.
        m2 = m - m1
        wgt = Ru / Ru.sum()
        u2 = rng.choice(uu, m2, p=wgt) + rng.uniform(-0.0025, 0.0025, m2)
        r2 = r * outline_at(prof, np.clip(u2, 0, 1)) * \
            (1 - np.minimum(1, rng.exponential(0.12, m2)))
        a2 = rng.uniform(0, 2 * math.pi, m2)
        px = np.r_[px, tx + r2 * np.cos(a2)]
        py = np.r_[py, ty + r2 * np.sin(a2)]
        pz = np.r_[pz, b + (h - b) * np.clip(u2, 0, 1)]
        X.append(px); Y.append(py); Z.append(zf(px, py) + np.maximum(pz, b))
        C.append(np.full(len(px), 1, np.uint8))
        # A few trunk returns.
        mt = int(3 * b) + 2
        X.append(tx + rng.normal(0, 0.15, mt)); Y.append(ty + rng.normal(0, 0.15, mt))
        Z.append(zf(tx, ty) + rng.uniform(0.2, max(0.5, b), mt))
        C.append(np.full(mt, 1, np.uint8))
        # Low shrubs under every third conifer (not part of its crown).
        if k == 1 and ti % 3 == 0:
            mu = int(math.pi * r * r * density * 0.3)
            ru = r * np.sqrt(rng.random(mu)); au = rng.uniform(0, 2 * math.pi, mu)
            ux, uy = tx + ru * np.cos(au), ty + ru * np.sin(au)
            X.append(ux); Y.append(uy)
            Z.append(zf(ux, uy) + rng.uniform(0.5, 1.4, mu))
            C.append(np.full(mu, 1, np.uint8))
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
