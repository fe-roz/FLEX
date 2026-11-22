#!/usr/bin/env python3
"""
prospect.py -- cave-entrance prospect layers from LiDAR (FLEX).

    python prospect.py --area-dir DIR [--out DIR/prospect] [--params P.json]
    python prospect.py --params P.json --out OUTDIR [--points-npz FILE]
    python prospect.py --demo OUTDIR             (made-up scene, no PDAL)

With --area-dir the area's shared ground and points cache (area_ground.py)
are used as they are: no point reading, no ground of its own; the ring comes
from area.json. Without it (--points-npz, params.source, --demo) an area
folder is first built inside OUTDIR/_area by area_ground's own run.

Candidates to LOOK AT, with honest attributes. No score, no ranking, and no
candidate is dropped because of a flag: the flags are shown.

  A  closed depressions (sinks, pits, dolines) in the ground: the ground is
     filled (morphological reconstruction from the area's edge, started from
     a coarse block-max fill so it converges in a few hundred passes on a
     3000 x 3000 grid), depth = filled - ground. 8-connected cells deeper
     than A_EDGE are a region; kept when the deepest cell reaches min_depth
     and the area is a_min_area..a_max_area m2. Dropped and counted in
     summary.json: regions larger than a_flat_area whose bottom is flat (half
     the cells within 0.3 m of the deepest: a pond, a road or river fill) and
     large regions on the area's edge (a cut-off valley).
     Attributes: max depth, area, rim-to-floor (median ground on the rim
     minus the floor), mean rim slope, elongation (long / short axis),
     measured = share of its cells with class-2 returns (low = the ground
     there is the cloth's fill, an artefact is more likely).
  B  low returns: returns of every class except 18 by area_ground's pit rule
     (more than b_depth (1 m) below the ground and also 0.5 m below the
     lowest ground of the 3 x 3 cells around, down to b_floor) that are not
     next to a steep face (those are C). Cells holding them are joined
     8-connected; every cluster is listed. Attributes: points, deepest,
     depth spread, horizontal span, class shares (7, 1, 2, other), share of
     the near-ground returns in its cells, `isolated` (fewer than 3 returns,
     or the returns do not reach up to the surface in steps of at most
     b_max_gap m: single points far below are typical multipath), `pit_id`
     (the matching area_ground possible pit, so this layer never contradicts
     pits.geojson: every pit there is one of these or a C).
  C  cliff-side openings: the same below-ground returns within c_reach m of
     a steep cell (slope over c_slope deg on a 2 m baseline), clustered the
     same way. Attributes: face slope, face height (ground range within 5 m),
     aspect (the way the face looks, deg from north), points, depth into the
     face (horizontal distance from the returns to the nearest open ground
     at their height).

  floor_above (every kind): any return more than 0.5 m ABOVE the ground over
  the candidate's cells (canopy, brush, an overhang), with the lowest such
  height. Not having one is more interesting, but it is never filtered on.

Outputs in OUT: candidates.geojson (points), candidates_areas.geojson
(outlines: the convex hull of the cells), candidates.kml, candidates.csv,
depth.png / below.png / steep.png with .pgw world files (UTM) and
layers.json (lon/lat corners and bounds), summary.json. Last line before
"done": NOTE: N candidates (A sinks, B below-ground clusters, C cliff
openings).
"""

import csv
import json
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import area_ground as ag
import lidar_derive as ld
import route_cost as rc

VERSION = 1
say_default = rc.ascii_say

DEFAULTS = {
    "cell": "auto",          # "auto" = the area ground's cell
    "min_depth": 0.5,        # A: deepest cell of a depression (m)
    "a_edge": 0.10,          # A: a cell is in a depression when deeper than this
    "a_min_area": 4.0,       # m2
    "a_max_area": 20000.0,   # m2
    "a_flat_area": 1500.0,   # m2: larger and flat-bottomed = pond / road fill
    "b_depth": ag.PIT_DEPTH,             # m below the ground
    "b_local_margin": ag.PIT_LOCAL_MARGIN,
    "b_floor": -100.0,       # deeper is ignored (m)
    "b_max_gap": 3.0,        # m: continuity step from the surface down
    "above_min": 0.5,        # m: a return over a candidate counts above this
    "c_slope": 55.0,         # deg
    "c_reach": 3.0,          # m from a steep cell
    "known": None,           # GeoJSON points file (or a FeatureCollection)
}
HIGH_NOISE = 18


def clean_params(params):
    p = dict(DEFAULTS)
    for k, v in (params or {}).items():
        p[k] = v
    for k in ("min_depth", "a_edge", "a_min_area", "a_max_area", "a_flat_area",
              "b_depth", "b_local_margin", "b_floor", "b_max_gap",
              "above_min", "c_slope", "c_reach"):
        try:
            p[k] = float(p[k])
        except (TypeError, ValueError):
            raise RuntimeError(f"{k} must be a number")
    if p["cell"] not in (None, "auto"):
        try:
            p["cell"] = float(p["cell"])
        except (TypeError, ValueError):
            raise RuntimeError("cell must be 'auto' or metres")
        if not 0.1 <= p["cell"] <= 5.0:
            raise RuntimeError("cell must be 0.1 .. 5 m")
    if p["min_depth"] <= 0 or p["b_depth"] <= 0:
        raise RuntimeError("min_depth and b_depth must be > 0")
    if not 0 < p["a_min_area"] < p["a_max_area"]:
        raise RuntimeError("need 0 < a_min_area < a_max_area")
    if not 20.0 <= p["c_slope"] < 90.0:
        raise RuntimeError("c_slope must be 20 .. 90 deg")
    if p["b_floor"] >= -p["b_depth"]:
        raise RuntimeError("b_floor must be below -b_depth")
    return p


# --------------------------------------------------------------------------
# A: depression fill
# --------------------------------------------------------------------------

def fill_depressions(dem, outlet, max_iter=5000):
    """Lowest surface >= dem with no closed depression, draining to the
    outlet cells (8-connected). Morphological reconstruction by erosion,
    started from a block-max fill of a 4x coarser grid (an upper bound, so the
    result is exact) -- recursive, so it converges in few passes."""
    from scipy import ndimage
    dem = dem.astype(np.float64)
    ny, nx = dem.shape
    out = outlet.copy()
    out[0, :] = out[-1, :] = out[:, 0] = out[:, -1] = True
    big = float(np.max(dem)) + 1.0
    if min(ny, nx) > 96:
        b = 4
        py, px = (-ny) % b, (-nx) % b
        dp = np.pad(dem, ((0, py), (0, px)), mode="edge")
        op = np.pad(out, ((0, py), (0, px)), mode="edge")
        cd = dp.reshape(dp.shape[0] // b, b, dp.shape[1] // b, b).max(axis=(1, 3))
        co = op.reshape(op.shape[0] // b, b, op.shape[1] // b, b).any(axis=(1, 3))
        cf = fill_depressions(cd, co, max_iter)
        m = np.repeat(np.repeat(cf, b, 0), b, 1)[:ny, :nx]
        m = np.maximum(m, dem)
    else:
        m = np.full_like(dem, big)
    m[out] = dem[out]
    for it in range(max_iter):
        prev = m
        m = np.maximum(dem, ndimage.minimum_filter(m, size=3, mode="nearest"))
        if it % 4 == 3 and np.array_equal(m, prev):
            break
    return m


def region_props(lab, n, depth, dem, slope, direct, cell):
    """Per region (1..n): stats as dict of arrays."""
    from scipy import ndimage
    idx = np.arange(1, n + 1)
    cnt = ndimage.sum_labels(np.ones_like(depth), lab, idx)
    dmax = ndimage.maximum(depth, lab, idx)
    floor = ndimage.minimum(dem, lab, idx)
    meas = ndimage.mean(direct.astype(float), lab, idx)
    return dict(cells=np.asarray(cnt), dmax=np.asarray(dmax),
                floor=np.asarray(floor), measured=np.asarray(meas))


def elongation(rr, cc):
    if len(rr) < 3:
        return 1.0
    c = np.cov(np.stack([rr.astype(float), cc.astype(float)]))
    ev = np.sort(np.linalg.eigvalsh(c + np.eye(2) * 1 / 12.0))
    return float(math.sqrt(ev[1] / max(ev[0], 1e-9)))


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def hull_ring(rr, cc, grid):
    """Convex hull of the cells' corners, UTM, closed."""
    x0 = grid.minx + cc * grid.cell
    y0 = grid.maxy - rr * grid.cell
    xs = np.concatenate([x0, x0 + grid.cell, x0, x0 + grid.cell])
    ys = np.concatenate([y0, y0, y0 - grid.cell, y0 - grid.cell])
    pts = np.unique(np.stack([xs, ys], 1), axis=0)
    try:
        from scipy.spatial import ConvexHull
        h = ConvexHull(pts)
        ring = pts[h.vertices]
    except Exception:
        ring = np.array([[xs.min(), ys.min()], [xs.max(), ys.min()],
                         [xs.max(), ys.max()], [xs.min(), ys.max()]])
    return np.vstack([ring, ring[:1]])


def to_ll(x, y, zone, south):
    lon, lat = rc.xy_to_lonlat(np.atleast_1d(np.asarray(x, float)),
                               np.atleast_1d(np.asarray(y, float)), zone, south)
    return np.asarray(lon), np.asarray(lat)


def read_known(spec, zone, south):
    """[(x, y, name)] from a GeoJSON file path or FeatureCollection dict."""
    if not spec:
        return []
    if isinstance(spec, str):
        with open(spec) as f:
            spec = json.load(f)
    feats = spec.get("features", []) if isinstance(spec, dict) else spec
    out = []
    for f in feats:
        g = (f or {}).get("geometry") or {}
        if g.get("type") != "Point":
            continue
        lon, lat = g["coordinates"][:2]
        x, y = rc.lonlat_to_xy(lon, lat, zone)
        pr = f.get("properties") or {}
        out.append((x, y, str(pr.get("name") or pr.get("title") or "")))
    return out


def rnd(v, d=2):
    return None if v is None else round(float(v), d)


# --------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------

def run(params, out_dir, area_dir, say=say_default):
    t_start = time.time()
    T = {}
    prm = clean_params(params)
    os.makedirs(out_dir, exist_ok=True)
    from scipy import ndimage

    say("[1/6] Area ground and points")
    t0 = time.time()
    G = ag.load_ground(area_dir)
    if G is None:
        raise RuntimeError("the area folder has no ground (run area_ground.py)")
    ground_a, agrid, meta = G
    zone, south = int(meta["zone"]), bool(meta["south"])
    P = ag.load_points(area_dir)
    if P is None:
        raise RuntimeError("the area folder has no points cache (area_ground "
                           "keep_points) -- prospect needs every return")
    ring_ll = ag.area_ring(area_dir)
    dpath = os.path.join(area_dir, "ground", "direct.npy")
    direct_a = (np.ascontiguousarray(np.load(dpath)[::-1]).astype(bool)
                if os.path.exists(dpath) else np.ones(agrid.shape, bool))
    if prm["cell"] in (None, "auto") or abs(prm["cell"] - agrid.cell) < 1e-6:
        grid, ground, direct = agrid, ground_a.astype(np.float32), direct_a
    else:
        grid = ld.Grid(agrid.minx, agrid.miny, agrid.maxx, agrid.maxy,
                       prm["cell"])
        ground = ag.ground_on(area_dir, grid).astype(np.float32)
        cx = grid.minx + (np.arange(grid.nx) + 0.5) * grid.cell
        cy = grid.maxy - (np.arange(grid.ny) + 0.5) * grid.cell
        c_, _ = agrid.indices(cx, np.full_like(cx, agrid.maxy - 1e-6))
        _, r_ = agrid.indices(np.full_like(cy, agrid.minx), cy)
        direct = direct_a[np.ix_(r_, c_)]
    cell = grid.cell
    if ring_ll:
        ring_xy = [rc.lonlat_to_xy(p[0], p[1], zone) for p in ring_ll]
    else:
        ring_xy = [(grid.minx, grid.miny), (grid.maxx, grid.miny),
                   (grid.maxx, grid.maxy), (grid.minx, grid.maxy)]
    inside = ag.polygon_mask(ring_xy, grid)
    import veg_shapes
    area_km2 = veg_shapes.ring_area(ring_xy) / 1e6
    say(f"  {len(P):,} points, ground {grid.nx}x{grid.ny} @ {cell} m, "
        f"{area_km2:.3f} km2")
    pits = []
    pp = os.path.join(area_dir, "ground", "pits.geojson")
    if os.path.exists(pp):
        with open(pp) as f:
            pits = json.load(f).get("features", [])
    known = read_known(prm.get("known"), zone, south)
    T["load_s"] = round(time.time() - t0, 2)

    # Slope and steep cells (2 m baseline).
    gx, gy = rc.gradients(ground, cell, baseline=2.0)
    slope = rc.slope_deg(gx, gy)
    steep = (slope > prm["c_slope"]) & inside
    rcells = max(1, int(round(prm["c_reach"] / cell)))
    near_steep = ndimage.binary_dilation(
        steep, structure=np.ones((3, 3), bool), iterations=rcells)
    gmin = ndimage.minimum_filter(ground, size=3, mode="nearest")

    # One pass over every return.
    say("[2/6] One pass over the returns (below, above, counts)")
    t0 = time.time()
    ncell = grid.nx * grid.ny
    tot = np.zeros(ncell, np.int64)
    near = np.zeros(ncell, np.int64)
    n2 = np.zeros(ncell, np.int64)
    above_min = np.full(ncell, np.inf, np.float32)
    BX, BY, BZ, BH, BC, BF = [], [], [], [], [], []
    for x, y, z, c in P.chunks():
        if c is None:
            c = np.ones(len(z), np.uint8)
        f = grid.flat(x, y)
        tot += np.bincount(f, minlength=ncell)
        n2 += np.bincount(f[c == 2], minlength=ncell)
        hag = z - ld.sample_bilinear(ground, grid, x, y)
        near += np.bincount(f[np.abs(hag) < ag.NEAR_GROUND], minlength=ncell)
        ab = (hag > prm["above_min"]) & (c != HIGH_NOISE)
        if ab.any():
            np.minimum.at(above_min, f[ab], hag[ab].astype(np.float32))
        b = (hag < -prm["b_depth"]) & (hag > prm["b_floor"]) & (c != HIGH_NOISE)
        if b.any():
            b[b] &= z[b] < gmin.ravel()[f[b]] - prm["b_local_margin"]
        if b.any():
            BX.append(x[b]); BY.append(y[b]); BZ.append(z[b])
            BH.append(hag[b]); BC.append(c[b]); BF.append(f[b])
    cat = (lambda L, dt: np.concatenate(L) if L else np.zeros(0, dt))
    B = dict(x=cat(BX, float), y=cat(BY, float), z=cat(BZ, float),
             h=cat(BH, float), c=cat(BC, np.uint8), f=cat(BF, np.int64))
    del BX, BY, BZ, BH, BC, BF
    above_min = above_min.reshape(grid.shape)
    near = near.reshape(grid.shape)
    n2 = n2.reshape(grid.shape)
    tot = tot.reshape(grid.shape)
    say(f"  {len(B['h']):,} returns below the ground "
        f"({time.time() - t0:.1f} s)")
    T["scan_s"] = round(time.time() - t0, 2)

    def floor_above(rr, cc):
        r0, r1 = max(0, rr.min() - 1), min(grid.ny, rr.max() + 2)
        c0, c1 = max(0, cc.min() - 1), min(grid.nx, cc.max() + 2)
        m = np.zeros((r1 - r0, c1 - c0), bool)
        m[rr - r0, cc - c0] = True
        v = above_min[r0:r1, c0:c1][m]
        lo = float(v.min()) if v.size else math.inf
        return (bool(np.isfinite(lo)), rnd(lo) if np.isfinite(lo) else None)

    cands = []

    def base(kind, x, y, rr, cc, npts):
        lon, lat = to_ll(x, y, zone, south)
        fa, fa_h = floor_above(rr, cc)
        c_, r_ = grid.indices(np.array([x]), np.array([y]))
        d = {"id": "", "kind": kind, "lon": round(float(lon[0]), 8),
             "lat": round(float(lat[0]), 8),
             "ground_z": rnd(ground[r_[0], c_[0]]),
             "points": int(npts), "floor_above": fa,
             "floor_above_h": fa_h, "cell": cell}
        if known:
            ds = [math.hypot(x - kx, y - ky) for kx, ky, _ in known]
            j = int(np.argmin(ds))
            d["nearest_known_m"] = round(ds[j], 1)
            d["nearest_known_name"] = known[j][2]
        return d

    # ---------------------------------------------------------------- A
    say("[3/6] A: closed depressions")
    t0 = time.time()
    outlet = ~inside
    filled = fill_depressions(ground, outlet)
    depth = (filled - ground).astype(np.float32)
    depth[~inside] = 0
    lab, n = ndimage.label(depth > prm["a_edge"], structure=np.ones((3, 3), bool))
    dropped = {"too_shallow": 0, "too_small": 0, "too_large": 0,
               "flat_fill": 0, "edge": 0}
    keepA = np.zeros(n + 1, bool)
    if n:
        st = region_props(lab, n, depth, ground, slope, direct, cell)
        area = st["cells"] * cell * cell
        objs = ndimage.find_objects(lab)
        edge_zone = ndimage.binary_dilation(outlet | _border(grid.shape),
                                            iterations=2)
        for k in range(1, n + 1):
            dm, ar = st["dmax"][k - 1], area[k - 1]
            if dm < prm["min_depth"]:
                dropped["too_shallow"] += 1
                continue
            if ar < prm["a_min_area"]:
                dropped["too_small"] += 1
                continue
            if ar > prm["a_max_area"]:
                dropped["too_large"] += 1
                continue
            sl = objs[k - 1]
            m = lab[sl] == k
            dv = depth[sl][m]
            at_edge = bool(edge_zone[sl][m].any())
            if ar > prm["a_flat_area"] and (dv > dm - 0.3).mean() > 0.5:
                dropped["flat_fill"] += 1
                continue
            if at_edge and ar > prm["a_flat_area"]:
                dropped["edge"] += 1
                continue
            keepA[k] = True
            rr, cc = np.nonzero(m)
            rr = rr + sl[0].start; cc = cc + sl[1].start
            j = int(np.argmax(dv))
            xb = grid.minx + (cc[j] + 0.5) * cell
            yb = grid.maxy - (rr[j] + 0.5) * cell
            # rim: one cell around
            pad = (slice(max(0, sl[0].start - 2), sl[0].stop + 2),
                   slice(max(0, sl[1].start - 2), sl[1].stop + 2))
            mm = lab[pad] == k
            rim = ndimage.binary_dilation(mm, structure=np.ones((3, 3), bool)) & ~mm
            rimz = ground[pad][rim]
            rims = slope[pad][rim]
            d = base("A", xb, yb, rr, cc, int(n2[rr, cc].sum()))
            d.update({
                "depth_m": rnd(dm), "area_m2": rnd(ar, 1),
                "rim_to_floor_m": rnd(np.median(rimz) - st["floor"][k - 1])
                if rimz.size else None,
                "rim_slope_deg": rnd(rims.mean(), 1) if rims.size else None,
                "elongation": rnd(elongation(rr, cc)),
                "measured": rnd(st["measured"][k - 1]),
                "at_edge": at_edge,
                "_cells": (rr, cc), "_sort": -dm})
            cands.append(d)
    nA = len(cands)
    say(f"  {nA:,} depressions kept of {n:,} regions "
        f"({', '.join(f'{v} {k}' for k, v in dropped.items() if v)}) "
        f"({time.time() - t0:.1f} s)")
    T["a_s"] = round(time.time() - t0, 2)

    # ------------------------------------------------------------ B and C
    say("[4/6] B and C: clusters of returns below the ground")
    t0 = time.time()
    nb = np.zeros(0, int)
    if len(B["f"]):
        cntb = np.bincount(B["f"], minlength=ncell).reshape(grid.shape)
        blab, nb_ = ndimage.label(cntb > 0, structure=np.ones((3, 3), bool))
        pl = blab.ravel()[B["f"]]
        order = np.argsort(pl, kind="stable")
        bounds = np.searchsorted(pl[order], np.arange(1, nb_ + 2))
        # pits.geojson ids by cluster
        pit_of = {}
        for p in pits:
            u = p["properties"].get("utm")
            if not u:
                continue
            c_, r_ = grid.indices(np.array([u[0]]), np.array([u[1]]))
            k = int(blab[r_[0], c_[0]])
            if k == 0:   # centroid between cells: nearest labelled cell
                r0, c0 = r_[0], c_[0]
                w = blab[max(0, r0 - 3):r0 + 4, max(0, c0 - 3):c0 + 4]
                if (w > 0).any():
                    k = int(np.bincount(w[w > 0]).argmax())
            if k:
                pit_of.setdefault(k, []).append(p["properties"].get("id"))
        for k in range(1, nb_ + 1):
            idx = order[bounds[k - 1]:bounds[k]]
            if not len(idx):
                continue
            xs, ys, zs, hs, cs = (B["x"][idx], B["y"][idx], B["z"][idx],
                                  B["h"][idx], B["c"][idx])
            fr = B["f"][idx]
            cells_u = np.unique(fr)
            rr, cc = cells_u // grid.nx, cells_u % grid.nx
            if not inside[rr, cc].any():
                continue
            m = len(idx)
            deep = -hs
            ds = np.sort(np.concatenate([[0.0], deep]))
            gaps = np.diff(ds)
            continuous = bool(gaps.max() <= prm["b_max_gap"] + prm["b_depth"]
                              if len(gaps) else False)
            # the first step (surface to shallowest) may be b_depth larger:
            # nothing shallower than b_depth can be selected.
            isolated = bool(m < 3 or not continuous)
            span = float(max(xs.max() - xs.min(), ys.max() - ys.min()) + cell)
            j = int(np.argmax(deep))
            is_c = bool(near_steep[rr, cc].mean() >= 0.5)
            kind = "C" if is_c else "B"
            xc, yc = float(np.mean(xs)), float(np.mean(ys))
            d = base(kind, xc, yc, rr, cc, m)
            nearg = int(near[rr, cc].sum())
            u, uc = np.unique(cs, return_counts=True)
            share = {int(a): float(b) / m for a, b in zip(u, uc)}
            d.update({
                "depth_m": rnd(deep[j]),
                "depth_spread_m": rnd(deep.max() - deep.min()),
                "shallowest_m": rnd(deep.min()),
                "span_m": rnd(span, 1),
                "cells": int(len(cells_u)),
                "share_c7": rnd(share.get(7, 0.0), 3),
                "share_c1": rnd(share.get(1, 0.0), 3),
                "share_c2": rnd(share.get(2, 0.0), 3),
                "share_other": rnd(1.0 - share.get(7, 0) - share.get(1, 0)
                                   - share.get(2, 0), 3),
                "share_of_near": rnd(m / float(m + nearg), 3),
                "continuous": continuous, "isolated": isolated,
                "pit_id": ",".join(str(v) for v in pit_of.get(k, [])) or None,
            })
            if is_c:
                sl_c = slope[rr, cc]
                r0, r1 = max(0, rr.min() - 5), min(grid.ny, rr.max() + 6)
                c0, c1 = max(0, cc.min() - 5), min(grid.nx, cc.max() + 6)
                w5 = max(1, int(round(5.0 / cell)))
                R0, R1 = max(0, rr.min() - w5), min(grid.ny, rr.max() + w5 + 1)
                C0, C1 = max(0, cc.min() - w5), min(grid.nx, cc.max() + w5 + 1)
                gw = ground[R0:R1, C0:C1]
                # aspect from the steepest cells around
                win_s = slope[r0:r1, c0:c1]
                wgx, wgy = gx[r0:r1, c0:c1], gy[r0:r1, c0:c1]
                wm = win_s > prm["c_slope"]
                if not wm.any():
                    wm = win_s >= win_s.max()
                ax, ay = -float(wgx[wm].mean()), -float(wgy[wm].mean())
                aspect = (math.degrees(math.atan2(ax, ay)) + 360) % 360
                # depth into the face: distance to open ground at their height
                zmed = float(np.median(zs))
                open_ = ground[R0:R1, C0:C1] <= zmed + 1.0
                if open_.any():
                    dist = ndimage.distance_transform_edt(~open_) * cell
                    pc, pr = grid.indices(xs, ys)
                    into = float(np.max(dist[np.clip(pr - R0, 0, R1 - R0 - 1),
                                             np.clip(pc - C0, 0, C1 - C0 - 1)]))
                else:
                    into = None
                d.update({"face_slope_deg": rnd(np.max(win_s), 1),
                          "face_height_m": rnd(gw.max() - gw.min(), 1),
                          "aspect_deg": rnd(aspect, 0),
                          "depth_into_face_m": rnd(into, 1)})
                # behind a face the returns sit far below the (top) surface
                # by nature: continuity is not asked, only >= 3 returns
                d["isolated"] = isolated = bool(m < 3)
            d["_cells"] = (rr, cc)
            d["_sort"] = (1 if isolated else 0, -float(deep[j]) - 0.01 * m)
            cands.append(d)
    T["bc_s"] = round(time.time() - t0, 2)

    # ids, titles
    out = []
    counts = {}
    for kind in ("A", "B", "C"):
        L = [d for d in cands if d["kind"] == kind]
        L.sort(key=lambda d: d["_sort"])
        for i, d in enumerate(L):
            d["id"] = f"{kind}-{i + 1:04d}"
            d["title"], d["description"] = describe(d)
            d["tag"] = ""
            d["note"] = ""
        counts[kind] = len(L)
        out.extend(L)
    nB_iso = sum(1 for d in out if d["kind"] == "B" and d.get("isolated"))
    nC_iso = sum(1 for d in out if d["kind"] == "C" and d.get("isolated"))
    say(f"  B {counts['B']:,} clusters ({nB_iso:,} isolated), "
        f"C {counts['C']:,} ({nC_iso:,} isolated) ({time.time() - t0:.1f} s)")

    # ------------------------------------------------------------ outputs
    say("[5/6] Rasters")
    t0 = time.time()
    layers = write_rasters(out_dir, grid, zone, south, depth, keepA, lab,
                           B, slope, steep, inside, prm)
    T["rasters_s"] = round(time.time() - t0, 2)
    say("[6/6] Writing candidates")
    t0 = time.time()
    write_vectors(out_dir, out, grid, zone, south)
    T["vectors_s"] = round(time.time() - t0, 2)
    T["total_s"] = round(time.time() - t_start, 2)
    used = {k: v for k, v in prm.items() if k != "known" or isinstance(v, str)}
    summary = {
        "version": VERSION, "area_km2": round(area_km2, 4), "cell": cell,
        "grid": [grid.nx, grid.ny], "points": int(len(P)),
        "counts": counts,
        "isolated": {"B": nB_iso, "C": nC_iso},
        "per_km2": {k: round(v / max(area_km2, 1e-9), 1)
                    for k, v in counts.items()},
        "per_km2_not_isolated": {
            "A": round(counts["A"] / max(area_km2, 1e-9), 1),
            "B": round((counts["B"] - nB_iso) / max(area_km2, 1e-9), 1),
            "C": round((counts["C"] - nC_iso) / max(area_km2, 1e-9), 1)},
        "a_regions": int(n), "a_dropped": dropped,
        "below_returns": int(len(B["h"])),
        "area_pits": len(pits),
        "ground": {"direct_share": rnd(direct[inside].mean(), 4),
                   "steep_share": rnd(steep[inside].mean(), 4),
                   "z_min": rnd(ground[inside].min()),
                   "z_max": rnd(ground[inside].max())},
        "params": used, "layers": layers, "timings": T,
    }
    with open(os.path.join(out_dir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=1)
    say(f"NOTE: {len(out)} candidates ({counts['A']} sinks, {counts['B']} "
        f"below-ground clusters, {counts['C']} cliff openings)")
    say(f"  done in {T['total_s']:.1f} s")
    return summary, out


def _border(shape):
    b = np.zeros(shape, bool)
    b[0, :] = b[-1, :] = b[:, 0] = b[:, -1] = True
    return b


def describe(d):
    k = d["kind"]
    fa = (f"returns above it from {d['floor_above_h']} m up (canopy or brush)"
          if d["floor_above"] else "nothing above it (open sky)")
    if k == "A":
        t = f"{d['id']} sink {d['depth_m']:.1f} m"
        s = (f"Closed depression {d['depth_m']} m deep, {d['area_m2']} m2, "
             f"rim to floor {d['rim_to_floor_m']} m, rim slope "
             f"{d['rim_slope_deg']} deg, elongation {d['elongation']}; "
             f"{int(round(d['measured'] * 100))} % of its cells have ground "
             f"returns" + ("" if d["measured"] >= 0.5 else
                           " (mostly filled ground: may be an artefact)")
             + f"; {fa}.")
    else:
        what = "below-ground returns" if k == "B" else "returns behind a steep face"
        t = (f"{d['id']} {'low returns' if k == 'B' else 'cliff opening'} "
             f"{d['depth_m']:.1f} m" + (" (isolated)" if d["isolated"] else ""))
        s = (f"{d['points']} {what}, deepest {d['depth_m']} m, from "
             f"{d['shallowest_m']} m, over {d['span_m']} m; class 7 "
             f"{int(round(d['share_c7'] * 100))} %, class 1 "
             f"{int(round(d['share_c1'] * 100))} %, class 2 "
             f"{int(round(d['share_c2'] * 100))} %; "
             + ("isolated: likely multipath noise; " if d["isolated"] else
                ("reaches up to the surface; " if k == "B" else ""))
             + (f"area pit {d['pit_id']}; " if d.get("pit_id") else ""))
        if k == "C":
            s += (f"face {d['face_slope_deg']} deg, {d['face_height_m']} m "
                  f"high, facing {d['aspect_deg']} deg, about "
                  f"{d['depth_into_face_m']} m into it; ")
        s += fa + "."
    if d.get("nearest_known_m") is not None:
        s += f" Nearest known: {d['nearest_known_name'] or '?'} at " \
             f"{d['nearest_known_m']} m."
    return t, s


PUBLIC_SKIP = ("_cells", "_sort")


def public(d):
    return {k: v for k, v in d.items() if k not in PUBLIC_SKIP}


def write_vectors(out_dir, cands, grid, zone, south):
    pts, polys = [], []
    for d in cands:
        pr = public(d)
        pts.append({"type": "Feature", "geometry": {
            "type": "Point", "coordinates": [d["lon"], d["lat"]]},
            "properties": pr})
        rr, cc = d["_cells"]
        ring = hull_ring(rr, cc, grid)
        lon, lat = to_ll(ring[:, 0], ring[:, 1], zone, south)
        coords = [[round(float(a), 8), round(float(b), 8)]
                  for a, b in zip(lon, lat)]
        if _signed_area(coords) < 0:       # RFC 7946: exterior CCW
            coords = coords[::-1]
        polys.append({"type": "Feature", "geometry": {
            "type": "Polygon", "coordinates": [coords]},
            "properties": {"id": d["id"], "kind": d["kind"],
                           "title": d["title"]}})
        d["_ring"] = coords
    for name, feats in (("candidates.geojson", pts),
                        ("candidates_areas.geojson", polys)):
        with open(os.path.join(out_dir, name), "w") as f:
            json.dump({"type": "FeatureCollection", "features": feats}, f)
    # CSV
    keys = []
    for d in cands:
        for k in public(d):
            if k not in keys:
                keys.append(k)
    with open(os.path.join(out_dir, "candidates.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys or ["id"])
        w.writeheader()
        for d in cands:
            w.writerow({k: ("" if v is None else v) for k, v in public(d).items()})
    write_kml(os.path.join(out_dir, "candidates.kml"), cands)


def _signed_area(c):
    a = 0.0
    for (x1, y1), (x2, y2) in zip(c[:-1], c[1:]):
        a += x1 * y2 - x2 * y1
    return a


KIND_NAMES = {"A": "A sinks (closed depressions)",
              "B": "B low returns (below ground)",
              "C": "C cliff openings"}
KIND_COL = {"A": "ff0080ff", "B": "ffff40c0", "C": "ff00e0ff"}   # aabbggrr


def _x(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;"))


def write_kml(path, cands):
    L = ['<?xml version="1.0" encoding="UTF-8"?>',
         '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
         '<name>Prospect candidates</name>']
    for k, col in KIND_COL.items():
        for iso in (0, 1):
            c = col if not iso else "80" + col[2:]
            L.append(f'<Style id="s{k}{iso}"><IconStyle><color>{c}</color>'
                     f'<scale>{0.9 if not iso else 0.6}</scale><Icon><href>'
                     'http://maps.google.com/mapfiles/kml/shapes/'
                     'placemark_circle.png</href></Icon></IconStyle>'
                     f'<LineStyle><color>{c}</color><width>2</width></LineStyle>'
                     f'<PolyStyle><color>40{col[2:]}</color></PolyStyle></Style>')
    for kind in ("A", "B", "C"):
        L.append(f"<Folder><name>{_x(KIND_NAMES[kind])}</name>")
        groups = [("", [d for d in cands if d["kind"] == kind and
                        not d.get("isolated")])]
        iso = [d for d in cands if d["kind"] == kind and d.get("isolated")]
        if iso:
            groups.append(("isolated (likely multipath)", iso))
        for gname, ds in groups:
            if gname:
                L.append(f"<Folder><name>{_x(gname)}</name>")
            for d in ds:
                st = f"#s{kind}{1 if d.get('isolated') else 0}"
                ext = "".join(f'<Data name="{_x(k)}"><value>{_x("" if v is None else v)}'
                              f'</value></Data>' for k, v in public(d).items())
                ring = " ".join(f"{a},{b}" for a, b in d["_ring"])
                L.append(f"<Placemark><name>{_x(d['title'])}</name>"
                         f"<description>{_x(d['description'])}</description>"
                         f"<styleUrl>{st}</styleUrl>"
                         f"<ExtendedData>{ext}</ExtendedData><MultiGeometry>"
                         f"<Point><coordinates>{d['lon']},{d['lat']}</coordinates></Point>"
                         f"<Polygon><outerBoundaryIs><LinearRing><coordinates>{ring}"
                         f"</coordinates></LinearRing></outerBoundaryIs></Polygon>"
                         f"</MultiGeometry></Placemark>")
            if gname:
                L.append("</Folder>")
        L.append("</Folder>")
    L.append("</Document></kml>")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))


DEPTH_RAMP = [(0.0, (255, 230, 120)), (0.4, (255, 140, 40)),
              (0.8, (200, 30, 60)), (1.0, (90, 0, 90))]
STEEP_RAMP = [(0.0, (240, 200, 60)), (0.5, (230, 100, 30)), (1.0, (150, 20, 20))]


def write_rasters(out_dir, grid, zone, south, depth, keepA, lab, B, slope,
                  steep, inside, prm):
    layers = {}
    # depth: kept depressions only, others faint
    dv = np.where(keepA[lab] & (depth > prm["a_edge"]), depth, np.nan)
    rgba, _, _ = ld.colorize(dv, DEPTH_RAMP, 0.0, max(2.0, 2 * prm["min_depth"]))
    other = (~keepA[lab]) & (depth > prm["a_edge"]) & inside
    rgba[other] = (160, 160, 160, 90)
    _save(out_dir, "depth.png", rgba, grid, layers, zone, south,
          "closed-depression depth, 0 .. %.1f m (grey: dropped regions)"
          % max(2.0, 2 * prm["min_depth"]))
    # below: below-ground returns per cell, log scale
    cnt = np.bincount(B["f"], minlength=grid.nx * grid.ny).reshape(grid.shape) \
        if len(B["f"]) else np.zeros(grid.shape)
    bv = np.where(cnt > 0, np.log2(cnt + 1.0), np.nan)
    rgba, _, _ = ld.colorize(bv, ld.VOID_RAMP, 1.0, 6.0)
    # make single returns visible
    rgba[cnt > 0, 3] = 255
    _save(out_dir, "below.png", rgba, grid, layers, zone, south,
          "returns below the ground per cell (log2, 1 .. 63+)")
    sv = np.where(steep, slope, np.nan)
    rgba, _, _ = ld.colorize(sv, STEEP_RAMP, prm["c_slope"], 85.0)
    _save(out_dir, "steep.png", rgba, grid, layers, zone, south,
          "slope over %g deg (2 m baseline)" % prm["c_slope"])
    with open(os.path.join(out_dir, "layers.json"), "w") as f:
        json.dump(layers, f, indent=1)
    return layers


def _save(out_dir, name, rgba, grid, layers, zone, south, what):
    ld.write_png(rgba, os.path.join(out_dir, name))
    with open(os.path.join(out_dir, name[:-4] + ".pgw"), "w") as f:
        f.write(f"{grid.cell}\n0\n0\n{-grid.cell}\n"
                f"{grid.minx + grid.cell / 2}\n{grid.maxy - grid.cell / 2}\n")
    cx = [grid.minx, grid.maxx, grid.maxx, grid.minx]
    cy = [grid.maxy, grid.maxy, grid.miny, grid.miny]
    lon, lat = to_ll(cx, cy, zone, south)
    layers[name[:-4]] = {
        "file": name, "what": what,
        "corners_lonlat": {k: [round(float(lon[i]), 8), round(float(lat[i]), 8)]
                           for i, k in enumerate(("nw", "ne", "se", "sw"))},
        "bounds": {"west": round(float(lon.min()), 8),
                   "south": round(float(lat.min()), 8),
                   "east": round(float(lon.max()), 8),
                   "north": round(float(lat.max()), 8)},
        "world_file": name[:-4] + ".pgw",
        "epsg": (32700 if south else 32600) + zone,
        "note": "the image is north-up in UTM; the lon/lat bounds are its "
                "enclosing box (UTM grid convergence is a fraction of a "
                "degree)"}


# --------------------------------------------------------------------------
# Standalone: build an area folder first
# --------------------------------------------------------------------------

def run_standalone(params, out_dir, say=say_default):
    adir = os.path.join(out_dir, "_area")
    gp = {"source": params.get("source") or {}, "cell": params.get("cell", "auto"),
          "keep_points": True, "points_cap_mb": 1e9}
    if params.get("area"):
        gp["area"] = params["area"]
    if params.get("tiled") is not None:
        gp["tiled"] = bool(params["tiled"])
    say("Building the area ground (area_ground.py)")
    ag.run(gp, adir, say=lambda m: say("  " + str(m)))
    p = dict(params)
    p.pop("cell", None)       # the area ground is already on that cell
    p.pop("tiled", None)
    return run(p, out_dir, adir, say=say)


# --------------------------------------------------------------------------
# Demo: a made-up scene with known truth
# --------------------------------------------------------------------------

DEMO_W, DEMO_H = 220.0, 220.0
DEMO = {
    "sink2": (50.0, 50.0, 8.0, 2.5),       # cx, cy, r, depth: class-2 floor
    "sink7": (150.0, 60.0, 5.0, 3.0),      # class-7 floor, brush over it
    "shaft": (60.0, 120.0, 0.75, 6.0),     # 1.5 m wide, 6 m deep
    "cliff_y": 185.0, "cliff_h": 15.0,     # face over 2 m north of cliff_y
    "alcove": (70.0, 3.0, 2.5),            # x, width, depth into the face
    "forest": (110.0, 90.0, 200.0, 160.0),
}


def demo_ground(x, y):
    """Gentle slope, a cliff (rising north) along y = cliff_y."""
    t = np.clip((y - DEMO["cliff_y"]) / 2.0, 0, 1)
    return 200.0 + 0.04 * x + 0.02 * y + DEMO["cliff_h"] * t


def demo_scene(seed=7, density=8.0):
    rng = np.random.default_rng(seed)
    W, H = DEMO_W, DEMO_H
    n = int(W * H * density)
    gx, gy = rng.uniform(0, W, n), rng.uniform(0, H, n)
    fx0, fy0, fx1, fy1 = DEMO["forest"]
    inf = (gx >= fx0) & (gx <= fx1) & (gy >= fy0) & (gy <= fy1)
    keep = ~inf | (rng.random(n) < 0.3)
    cx, cy, r, _d = DEMO["shaft"]
    keep &= np.hypot(gx - cx, gy - cy) > r          # no ground in the shaft
    gx, gy = gx[keep], gy[keep]
    gz = demo_ground(gx, gy) + rng.normal(0, 0.03, len(gx))
    gc = np.full(len(gx), 2, np.uint8)
    # sinks: bowls
    for key, floor_cls in (("sink2", 2), ("sink7", 7)):
        cx, cy, r, d = DEMO[key]
        rr = np.hypot(gx - cx, gy - cy)
        m = rr < r
        gz[m] -= d * (1 - (rr[m] / r) ** 2)
        if floor_cls == 7:
            gc[rr < 0.75 * r] = 7
    X, Y, Z, C = [gx], [gy], [gz], [gc]
    # shaft: a handful of returns down its walls and floor (class 1)
    cx, cy, r, d = DEMO["shaft"]
    k = 7
    a = rng.uniform(0, 2 * math.pi, k); rr = r * np.sqrt(rng.random(k)) * 0.9
    X.append(cx + rr * np.cos(a)); Y.append(cy + rr * np.sin(a))
    Z.append(demo_ground(cx, cy) - np.array([1.4, 2.2, 3.0, 3.9, 4.6, 5.4, 6.0]))
    C.append(np.ones(k, np.uint8))
    # alcove: returns behind the face, at the foot's height
    ax, aw, ad = DEMO["alcove"]
    k = 60
    px = rng.uniform(ax - aw / 2, ax + aw / 2, k)
    py = DEMO["cliff_y"] + 2.0 + rng.uniform(0.3, ad, k)
    X.append(px); Y.append(py)
    Z.append(demo_ground(px, np.full(k, DEMO["cliff_y"] - 0.5)) +
             rng.uniform(0.0, 2.0, k))
    C.append(np.ones(k, np.uint8))
    # forest canopy, brush over sink7
    fa = (fx1 - fx0) * (fy1 - fy0)
    m = int(fa * 10)
    vx, vy = rng.uniform(fx0, fx1, m), rng.uniform(fy0, fy1, m)
    X.append(vx); Y.append(vy); Z.append(demo_ground(vx, vy) + rng.uniform(8, 25, m))
    C.append(np.full(m, 5, np.uint8))
    cx, cy, r, d = DEMO["sink7"]
    m = 400
    a = rng.uniform(0, 2 * math.pi, m); rr = (r + 1) * np.sqrt(rng.random(m))
    vx, vy = cx + rr * np.cos(a), cy + rr * np.sin(a)
    X.append(vx); Y.append(vy); Z.append(demo_ground(vx, vy) + rng.uniform(0.6, 1.8, m))
    C.append(np.full(m, 3, np.uint8))
    # multipath: single points 20-80 m below, scattered over bare ground
    mp = np.array([[20, 150], [100, 20], [190, 20], [30, 90], [95, 160],
                   [200, 120]], float)
    X.append(mp[:, 0]); Y.append(mp[:, 1])
    Z.append(demo_ground(mp[:, 0], mp[:, 1]) - np.array([20, 35, 50, 65, 80, 28.0]))
    C.append(np.array([7, 7, 1, 7, 1, 7], np.uint8))
    truth = {"multipath": mp.tolist()}
    return (np.concatenate(X), np.concatenate(Y), np.concatenate(Z),
            np.concatenate(C), truth)


def demo(out_dir, say=say_default):
    os.makedirs(out_dir, exist_ok=True)
    x, y, z, c, truth = demo_scene()
    npz = rc.write_npz(os.path.join(out_dir, "demo_points.npz"), x, y, z, c)
    e0, n0, zone = rc.example_origin()
    kx, ky = DEMO["sink2"][0] + 20, DEMO["sink2"][1]
    lon, lat = to_ll(e0 + kx, n0 + ky, zone, False)
    known = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates":
                                         [float(lon[0]), float(lat[0])]},
         "properties": {"name": "Cave Ridge T6"}}]}
    kp = os.path.join(out_dir, "known.geojson")
    with open(kp, "w") as f:
        json.dump(known, f)
    params = {"source": {"npz": npz},
              "area": ag.local_ring(0, 0, DEMO_W, DEMO_H),
              "cell": 0.5, "known": kp}
    with open(os.path.join(out_dir, "params.json"), "w") as f:
        json.dump(params, f, indent=1)
    return run_standalone(params, out_dir, say=say)


# --------------------------------------------------------------------------

def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="Cave-entrance prospect layers "
                                 "from LiDAR (FLEX).")
    ap.add_argument("--area-dir", default=None,
                    help="an area folder (area_ground.py): its ground, points "
                         "and ring")
    ap.add_argument("--params", help="PARAMS.json (thresholds; source/area "
                                     "without --area-dir)")
    ap.add_argument("--out", help="output folder (default AREA_DIR/prospect)")
    ap.add_argument("--points-npz", default=None)
    ap.add_argument("--points-epsg", type=int, default=None)
    ap.add_argument("--demo", metavar="OUTDIR", default=None)
    a = ap.parse_args(argv)
    try:
        if a.demo:
            demo(a.demo)
            return 0
        params = {}
        if a.params:
            with open(a.params) as f:
                params = json.load(f)
        if a.area_dir:
            out = a.out or os.path.join(a.area_dir, "prospect")
            a.out = out
            run(params, out, a.area_dir)
            return 0
        if a.points_npz:
            params["source"] = {"npz": a.points_npz}
            if a.points_epsg:
                params["source"]["epsg"] = a.points_epsg
        if not a.out or not (a.params or a.points_npz):
            ap.error("--area-dir DIR, or --params and --out (or --demo OUTDIR)")
        run_standalone(params, a.out)
        return 0
    except SystemExit as e:
        if e.code not in (None, 0):
            rc.ascii_say(f"! {e.code}")
            return 1 if e.code != 2 else 2
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
