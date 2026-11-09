#!/usr/bin/env python3
"""
route_cost.py -- terrain-aware walking routes for FLEX.

    python route_cost.py --params PARAMS.json --out OUTDIR
    python route_cost.py --demo OUTDIR            (synthetic case, no PDAL)

From the LiDAR of an area it builds cost grids (ground, slope, cliffs, brush,
sun at equinox noon, trails) and finds the best walking line from each start
to one end, plus alternatives from presets when they differ. The contract with
FLEX (inputs, outputs) is in the FLEX routing brief; outputs:

    OUTDIR/grids/      ground.npy slope.npy cliff.npy brush.npy shade.npy
                       trail.npy grid.json + brush/slope/shade/ground_hs.png
                       (dem both: ground_above.npy, dem_diff.png)
    OUTDIR/routes.geojson
    OUTDIR/summary.json

Structure: everything after the point reader works on plain numpy arrays, so
it is tested without PDAL (tools/test_route_cost.py, --points-npz). PDAL is
needed only to read EPT or LAS/LAZ (the same conda env as Generate).

The cost model in plain words (all weights from params.weights):

  step cost = horizontal distance
              x ( distance + steep * f(grade) + brush * g(brush) + sun term
                  + climb * uphill grade )             [climb: least_climb only]
              x trail factor x cliff factor

  f(grade)  Tobler: how many times slower the step is than the best walking
            grade, minus one (0 on the flat, ~1.9 at 30 % up, ~7 at 60 % up).
            The grade is directional: along the step, from the ground slope.
  g(brush)  6 * b^2.5, b = fraction of all returns 0.5-2 m above ground:
            grass and light brush are nearly free (b 0.1 -> 0.02, 0.2 -> 0.11),
            heavy brush is steep (0.4 -> 0.61, 0.6 -> 1.67, 0.8 -> 3.4).
  sun term  sun weight > 0 (prefer sun): weight * (1 - sun);
            sun weight < 0 (prefer shade): |weight| * sun.  sun 0..1.
  trail     on a trail / road cell: x (1 - 0.9 * how good), and its brush cost
            is scaled by (1 - how good); a mapped trail also overrides a
            cliff flag (cut banks along roads).
  cliff     cells with slope over 45 deg on a >= 2 m baseline, or a step of
            more than 2 m to a neighbour.  cliff weight 0 = no step may enter,
            touch or cut the corner of one; otherwise x 30 / w^2 (w = 1 ->
            30x, 0.5 -> 120x), and the steep term is dropped on those steps.

Time: Tobler's hiking function 6 exp(-3.5 |grade + 0.05|) km/h, x 0.6 off
trail; brush slows off-trail steps by (1 + 4 b^2) (b 0.25 -> 1.25x,
0.5 -> 2x); cliff cells x 3 (scrambling).
"""

import hashlib
import json
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import lidar_derive as ld          # Grid, HAG, band fraction, PNG writer, ramps

VERSION = 1                        # bump when a grid's meaning changes (cache)
GROUND_CLASS = 2

DEFAULT_WEIGHTS = {"distance": 1.0, "steep": 1.0, "brush": 1.0, "cliff": 0.5,
                   "sun": 0.0, "trail": 1.0, "road": 1.0}
PRESETS = ("shortest", "least_brush", "shadiest", "least_climb")
OPTION_NAMES = {"recommended": "Recommended", "shortest": "Shortest",
                "least_brush": "Least brush", "shadiest": "Shadiest",
                "least_climb": "Least climb"}

CANOPY_MIN_HAG = 3.0     # returns above this cast shade
EYE_HAG = 1.5            # shade is judged at head height
CROWN_K = 0.6            # light extinction per metre through a crown of cover 1
CLIFF_SLOPE_DEG = 45.0
CLIFF_STEP_M = 2.0
CLIFF_BASELINE_M = 2.0
CLIFF_FACTOR = 30.0
HEAVY_BRUSH = 0.35       # warnings / brush_pct
IN_BRUSH = 0.25
TRAIL_BUFFER = {"trail": 1.5, "road": 3.0}   # metres either side


def ascii_say(msg):
    """Progress line, ASCII only (the Windows console is cp1252)."""
    s = str(msg).encode("ascii", "replace").decode("ascii")
    print(s, flush=True)


# --------------------------------------------------------------------------
# Projection helpers (export_terrain's own maths, so FLEX and exports agree)
# --------------------------------------------------------------------------

_ET = None


def et():
    global _ET
    if _ET is None:
        import export_terrain as _et
        _ET = _et
    return _ET


def lonlat_to_xy(lon, lat, zone):
    e, n, _ = et().latlon_to_utm(float(lat), float(lon), zone)
    return e, n


def xy_to_lonlat(x, y, zone, south):
    lat, lon = et().utm_to_latlon(np.asarray(x, float), np.asarray(y, float),
                                  zone, south)
    return lon, lat


# --------------------------------------------------------------------------
# Small raster tools
# --------------------------------------------------------------------------

def auto_cell(n_ground, area_m2, target=8.0, lo=0.25, hi=2.0):
    """Cell size giving about `target` ground returns per cell, to 0.25 m."""
    if n_ground <= 0 or area_m2 <= 0:
        return 1.0
    c = math.sqrt(target * area_m2 / float(n_ground))
    return float(min(hi, max(lo, round(c * 4) / 4)))


def bin_stat(x, y, v, grid, how):
    """Per-cell min or max (NaN where empty), north-up like ld.Grid."""
    n = grid.nx * grid.ny
    out = np.full(n, np.inf if how == "min" else -np.inf)
    f = grid.flat(x, y)
    (np.minimum if how == "min" else np.maximum).at(out, f, v)
    out[~np.isfinite(out)] = np.nan
    return out.reshape(grid.shape)


def nearest_fill(a):
    """NaN cells take the value of the nearest finite cell (EDT, one pass)."""
    from scipy import ndimage
    bad = ~np.isfinite(a)
    if not bad.any():
        return a
    if bad.all():
        return np.zeros_like(a)
    idx = ndimage.distance_transform_edt(bad, return_distances=False,
                                         return_indices=True)
    return a[tuple(idx)]


def _avg4(c):
    p = np.pad(c, 1, mode="edge")
    return 0.25 * (p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:])


# --------------------------------------------------------------------------
# DEMs: cloth from below (routing default) and from above
# --------------------------------------------------------------------------
#
# export_terrain.build_dem is a cloth from below without the force that holds
# the cloth up against the data: every iteration only averages and clamps to
# the lowest return, so convex ground sinks a little more each pass. Measured
# on a 10 m step: the cliff top is lowered by up to 9.5 m over 11 m (0.25 m
# cells), 25 m (0.5 m) and 58 m (1 m cells) -- at 1 m the cliff becomes a 10
# degree ramp and would vanish from the cost grid. These two keep its idea
# (min-Z per cell, nearest fill of empty cells, Laplacian cloth, collision with
# the lowest return) and add the missing force: the cloth is pushed toward the
# data by a constant step g each pass, so at rest it bends no tighter than
# KAPPA (1/m). A cliff top is rounded over about sqrt(2 H / KAPPA) metres
# (2 m step: 1.4 m, 10 m: 3.2 m); narrow spikes (below) and narrow pits
# (above) are bridged.

KAPPA = 2.0
CLOTH_ITERS = 250


def cloth_below(zmin, cell, kappa=KAPPA, iters=CLOTH_ITERS):
    """Cloth rising from below onto the lowest return of each cell."""
    g = kappa * cell * cell / 4.0
    c = zmin.astype(np.float64).copy()
    for _ in range(iters):
        c = np.minimum(_avg4(c) + g, zmin)
    return c.astype(np.float32)


def cloth_above(zmin, zmax, cell, kappa=KAPPA, iters=CLOTH_ITERS):
    """Cloth falling from the per-cell max Z onto the lowest returns."""
    g = kappa * cell * cell / 4.0
    c = zmax.astype(np.float64).copy()
    for _ in range(iters):
        c = np.maximum(_avg4(c) - g, zmin)
    return c.astype(np.float32)


def dem_compare(below, above, grid, zone, south):
    d = np.abs(above.astype(np.float64) - below)
    r, cidx = np.unravel_index(int(np.argmax(d)), d.shape)
    x = grid.minx + (cidx + 0.5) * grid.cell
    y = grid.maxy - (r + 0.5) * grid.cell
    lon, lat = xy_to_lonlat(x, y, zone, south)
    # Where they differ most: the 5 largest blobs' centres, coarsely.
    return {"mean_abs_m": round(float(d.mean()), 3),
            "p95_abs_m": round(float(np.percentile(d, 95)), 3),
            "max_abs_m": round(float(d.max()), 3),
            "max_at_lonlat": [round(float(lon), 7), round(float(lat), 7)],
            "cells_over_0_5m_pct": round(float((d > 0.5).mean() * 100), 2),
            "note": "above minus below; below erodes narrow tops, above "
                    "bridges narrow pits (cave entrances show here)"}


# --------------------------------------------------------------------------
# Slope, cliffs, brush, shade, trails
# --------------------------------------------------------------------------

def gradients(dem, cell, baseline=CLIFF_BASELINE_M):
    """dz/deast, dz/dnorth by central differences over >= `baseline` metres."""
    k = max(1, int(round(baseline / (2 * cell))))
    p = np.pad(dem.astype(np.float64), k, mode="edge")
    ny, nx = dem.shape
    gx = (p[k:k + ny, 2 * k:2 * k + nx] - p[k:k + ny, :nx]) / (2 * k * cell)
    gy = (p[:ny, k:k + nx] - p[2 * k:2 * k + ny, k:k + nx]) / (2 * k * cell)
    return gx.astype(np.float32), gy.astype(np.float32)


def slope_deg(gx, gy):
    return np.degrees(np.arctan(np.hypot(gx, gy))).astype(np.float32)


def cliff_mask(dem, slope, cell):
    """Slope over 45 deg on a >= 2 m baseline, or a > 2 m step to a neighbour."""
    m = slope > CLIFF_SLOPE_DEG
    p = np.pad(dem.astype(np.float64), 1, mode="edge")
    ny, nx = dem.shape
    step = np.zeros(dem.shape)
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr or dc:
                step = np.maximum(step, np.abs(
                    p[1 + dr:1 + dr + ny, 1 + dc:1 + dc + nx] - dem))
    return m | (step > CLIFF_STEP_M)


def terrain_lit(dem, cell, lat):
    """1 where the ground sees the equinox noon sun, by a horizon sweep.

    The sun is due south (north in the southern hemisphere) at elevation
    90 - |lat|; a shadow edge drops tan(elev) per metre away from the sun.
    """
    elev = math.radians(max(1.0, 90.0 - abs(lat)))
    drop = cell * math.tan(elev)
    d = dem.astype(np.float64)
    if lat < 0:
        d = d[::-1]
    ny = d.shape[0]
    lit = np.ones(d.shape, bool)
    h = d[ny - 1].copy()                   # rows grow southward: sun side last
    for r in range(ny - 2, -1, -1):
        h = np.maximum(d[r], h - drop)
        lit[r] = d[r] >= h - 0.05
    return lit[::-1] if lat < 0 else lit


def canopy_transmit(dem, cover, top, cell, lat, max_reach_m=150.0):
    """Light left after the noon ray from head height crosses the crowns."""
    elev = math.radians(max(1.0, 90.0 - abs(lat)))
    tan_e = math.tan(elev)
    if lat < 0:
        dem, cover, top = dem[::-1], cover[::-1], top[::-1]
    ny, nx = dem.shape
    tmax = float(top.max()) if top.size else 0.0
    K = int(min(max_reach_m, tmax / max(tan_e, 1e-3)) / cell) + 1
    att = CROWN_K * cell / math.cos(elev)
    log_t = np.zeros(dem.shape, np.float64)
    eye = dem.astype(np.float64) + EYE_HAG
    for k in range(1, min(K, ny) + 1):
        g = dem[k:].astype(np.float64)     # cells k rows toward the sun
        tp = top[k:]
        cv = cover[k:]
        h = eye[:ny - k] + k * cell * tan_e
        inside = (tp > 0) & (h >= g + CANOPY_MIN_HAG) & (h <= g + tp)
        log_t[:ny - k] -= np.where(inside, att * cv, 0.0)
    t = np.exp(log_t).astype(np.float32)
    return t[::-1] if lat < 0 else t


def sun_grid(dem, cover, top, cell, lat):
    return (terrain_lit(dem, cell, lat).astype(np.float32) *
            canopy_transmit(dem, cover, top, cell, lat))


def geojson_lines(fc, zone):
    """[(name, kind, [[(x, y), ...], ...]), ...] from a FeatureCollection."""
    out = []
    feats = fc.get("features", []) if isinstance(fc, dict) else []
    for i, ft in enumerate(feats):
        props = ft.get("properties") or {}
        geom = ft.get("geometry") or {}
        if geom.get("type") == "LineString":
            lines = [geom.get("coordinates") or []]
        elif geom.get("type") == "MultiLineString":
            lines = geom.get("coordinates") or []
        else:
            continue
        xy = [[lonlat_to_xy(p[0], p[1], zone) for p in ln if len(p) >= 2]
              for ln in lines]
        xy = [ln for ln in xy if ln]
        if xy:
            out.append((str(props.get("name") or ""),
                        str(props.get("kind", "trail")).lower(), xy))
    return out


def mark_lines(lines_xy, grid, buffer_m):
    """Cells within buffer_m of the polylines (at least the cells they cross)."""
    from scipy import ndimage
    hit = np.zeros(grid.shape, bool)
    for ln in lines_xy:
        if len(ln) == 1:
            ln = [ln[0], ln[0]]
        for (x0, y0), (x1, y1) in zip(ln[:-1], ln[1:]):
            L = math.hypot(x1 - x0, y1 - y0)
            n = max(2, int(L / (grid.cell / 3)) + 2)
            t = np.linspace(0, 1, n)
            xs, ys = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
            ok = ((xs >= grid.minx) & (xs < grid.maxx) &
                  (ys >= grid.miny) & (ys < grid.maxy))
            if ok.any():
                c, r = grid.indices(xs[ok], ys[ok])
                hit[r, c] = True
    if hit.any() and buffer_m > grid.cell * 0.5:
        hit = ndimage.distance_transform_edt(~hit) * grid.cell <= buffer_m
    return hit


def rasterize_trails(trails, grid, zone):
    """0 none, 1 trail, 2 road (road wins), from a GeoJSON of lon/lat lines."""
    out = np.zeros(grid.shape, np.uint8)
    if not trails:
        return out
    lines = geojson_lines(trails, zone)
    for kind, code in (("trail", 1), ("road", 2)):
        xy = [ln for _n, k, ls in lines if (k == "road") == (kind == "road")
              for ln in ls]
        if xy:
            out[mark_lines(xy, grid, TRAIL_BUFFER[kind])] = code
    return out


def nearest_on_lines(lines_xy, p):
    """The point of the polylines nearest to p."""
    best, bd = None, np.inf
    for ln in lines_xy:
        pts = np.array(ln, float)
        if len(pts) == 1:
            pts = np.vstack([pts, pts])
        a, b = pts[:-1], pts[1:]
        v = b - a
        L2 = np.maximum((v ** 2).sum(1), 1e-12)
        t = np.clip(((p - a) * v).sum(1) / L2, 0, 1)
        q = a + v * t[:, None]
        d = np.hypot(*(q - p).T)
        i = int(np.argmin(d))
        if d[i] < bd:
            bd, best = float(d[i]), (float(q[i, 0]), float(q[i, 1]))
    return best, bd


# --------------------------------------------------------------------------
# Grid building (numpy in, dict of rasters out)
# --------------------------------------------------------------------------

class Points:
    """A point cloud kept small: float32 offsets from an origin, float32 z,
    uint8 class (13 bytes a point; a 2 x 2 km area at 50 pts/m2 is ~2.7 GB).
    Every per-point pass walks it in chunks so no full-size float64
    temporaries are made."""

    CHUNK = 4_000_000

    def __init__(self, ox, oy):
        self.ox, self.oy = float(ox), float(oy)
        self.parts = []

    def add(self, x, y, z, cls):
        self.parts.append(((np.asarray(x) - self.ox).astype(np.float32),
                           (np.asarray(y) - self.oy).astype(np.float32),
                           np.asarray(z).astype(np.float32),
                           None if cls is None else
                           np.clip(np.asarray(cls), 0, 255).astype(np.uint8)))

    def finish(self):
        if len(self.parts) != 1:
            xs, ys, zs, cs = zip(*self.parts) if self.parts else ([], [], [], [])
            has_c = all(c is not None for c in cs) and len(cs) > 0
            self.parts = [(np.concatenate(xs) if xs else np.zeros(0, np.float32),
                           np.concatenate(ys) if ys else np.zeros(0, np.float32),
                           np.concatenate(zs) if zs else np.zeros(0, np.float32),
                           np.concatenate(cs) if has_c else None)]
        self.xl, self.yl, self.z, self.cls = self.parts[0]
        self.parts = None
        return self

    def __len__(self):
        return len(self.z)

    def chunks(self, select=None):
        """(x, y, z, cls, sel) in absolute metres, float64, a chunk at a time;
        select(cls, z) -> bool mask restricts the chunk."""
        n = len(self.z)
        for i in range(0, n, self.CHUNK):
            j = min(n, i + self.CHUNK)
            c = self.cls[i:j] if self.cls is not None else None
            z = self.z[i:j].astype(np.float64)
            if select is not None:
                m = select(c, z)
                if not m.any():
                    continue
                yield (self.xl[i:j][m] + self.ox, self.yl[i:j][m] + self.oy,
                       z[m], None if c is None else c[m])
            else:
                yield (self.xl[i:j] + self.ox, self.yl[i:j] + self.oy, z, c)


def points_from_arrays(x, y, z, cls):
    P = Points(float(np.min(x)) if len(x) else 0.0,
               float(np.min(y)) if len(y) else 0.0)
    P.add(x, y, z, cls)
    return P.finish()


def build_grids(P, grid, band, dem_mode, lat, say=ascii_say, method="csf"):
    """All cached cost inputs from a Points cloud in UTM metres.

    method "csf": the cloths in this file; "export": export_terrain.build_dem
    as Generate uses it (cloth from below without the restoring force) for
    the below DEM -- kept for comparison, it sinks cliff tops."""
    t0 = time.time()
    n_ground = int((P.cls == GROUND_CLASS).sum()) if P.cls is not None else 0
    use_class = n_ground >= 50
    if not use_class:
        say("  no ground class: the cloth works on all returns")
    sub = slice(None, None, max(1, len(P) // 2_000_000))
    zs = P.z[sub].astype(np.float64)
    cs = P.cls[sub] if (P.cls is not None and use_class) else None
    zlo, zhi = ld.plausible_ground_band(zs, cs)
    del zs, cs

    def ground_sel(c, z):
        m = (z >= zlo) & (z <= zhi)
        return m & (c == GROUND_CLASS) if use_class else m

    ncell = grid.nx * grid.ny
    zmin = np.full(ncell, np.inf)
    zmax = np.full(ncell, -np.inf)
    for x, y, z, _c in P.chunks(ground_sel):
        f = grid.flat(x, y)
        np.minimum.at(zmin, f, z)
        np.maximum.at(zmax, f, z)
    zmin[~np.isfinite(zmin)] = np.nan
    zmax[~np.isfinite(zmax)] = np.nan
    zmin, zmax = zmin.reshape(grid.shape), zmax.reshape(grid.shape)
    valid = np.isfinite(zmin)
    if not valid.any():
        raise RuntimeError("no ground points inside the grid")
    zmin, zmax = nearest_fill(zmin), nearest_fill(zmax)
    say(f"  ground cells with returns: {valid.mean() * 100:.1f}% "
        f"({time.time() - t0:.1f} s)")
    out = {"valid": valid}
    if dem_mode in ("below", "both") and method == "export":
        say("  export_terrain.build_dem (cloth from below, as Generate)")
        xs, ys, zs = [], [], []
        for x, y, z, _c in P.chunks(ground_sel):
            xs.append(x); ys.append(y); zs.append(z)
        cl, _xb, _yb, _x0, _y0 = et().build_dem(
            np.concatenate(xs), np.concatenate(ys), np.concatenate(zs),
            grid.cell, progress=lambda m: None,
            extent=(grid.minx, grid.miny, grid.maxx, grid.maxy))
        del xs, ys, zs
        out["below"] = np.ascontiguousarray(cl.T[::-1]).astype(np.float32)
    elif dem_mode in ("below", "both"):
        say(f"  cloth from below ({CLOTH_ITERS} passes, {grid.nx}x{grid.ny})")
        out["below"] = cloth_below(zmin, grid.cell)
    if dem_mode in ("above", "both"):
        say(f"  cloth from above ({CLOTH_ITERS} passes)")
        out["above"] = cloth_above(zmin, zmax, grid.cell)
    del zmin, zmax
    dem = out["above"] if dem_mode == "above" else out["below"]
    out["ground"] = dem
    gx, gy = gradients(dem, grid.cell)
    out["gx"], out["gy"] = gx, gy
    out["slope"] = slope_deg(gx, gy)
    out["cliff"] = cliff_mask(dem, out["slope"], grid.cell)
    say(f"  slope and cliffs: {out['cliff'].mean() * 100:.2f}% cliff cells "
        f"({time.time() - t0:.1f} s)")

    # One chunked pass over every return: HAG against the routing DEM, then
    # the brush band fraction (as lidar_derive.band_fraction) and the canopy.
    tot = np.zeros(ncell); inband = np.zeros(ncell); high = np.zeros(ncell)
    top = np.zeros(ncell, np.float32)
    for x, y, z, _c in P.chunks():
        hag = z - ld.sample_bilinear(dem, grid, x, y)
        f = grid.flat(x, y)
        tot += np.bincount(f, minlength=ncell)
        inband += np.bincount(f[(hag >= band[0]) & (hag <= band[1])],
                              minlength=ncell)
        hi = hag >= CANOPY_MIN_HAG
        if hi.any():
            high += np.bincount(f[hi], minlength=ncell)
            np.maximum.at(top, f[hi], np.minimum(hag[hi], 80.0).astype(np.float32))
    brush = np.where(tot >= 2, inband / np.maximum(tot, 1), np.nan)
    out["brush"] = np.nan_to_num(nearest_fill(brush.reshape(grid.shape)),
                                 nan=0.0).astype(np.float32)
    cover = np.where(tot > 0, high / np.maximum(tot, 1), 0).reshape(
        grid.shape).astype(np.float32)
    top = top.reshape(grid.shape)
    say(f"  brush and canopy: mean brush {out['brush'].mean():.2f}, "
        f"canopy cover {cover.mean() * 100:.0f}% ({time.time() - t0:.1f} s)")
    out["shade"] = sun_grid(dem, cover, top, grid.cell, lat)
    say(f"  sun at equinox noon: {(out['shade'] >= 0.5).mean() * 100:.0f}% "
        f"of cells in sun ({time.time() - t0:.1f} s for the grids)")
    return out


# --------------------------------------------------------------------------
# Cost and search
# --------------------------------------------------------------------------

def tobler_kmh(grade):
    return 6.0 * np.exp(-3.5 * np.abs(grade + 0.05))


def steep_f(grade):
    g = np.clip(grade, -1.2, 1.2)
    return np.maximum(0.0, np.exp(3.5 * (np.abs(g + 0.05) - 0.05)) - 1.0)


def brush_g(b):
    return 6.0 * np.power(np.clip(b, 0.0, 1.0), 2.5)


def preset_weights(name, w):
    w = dict(w)
    w.setdefault("climb", 0.0)
    if name == "shortest":
        w.update(distance=1.0, steep=0.0, brush=0.0, sun=0.0, trail=0.0,
                 road=0.0, climb=0.0)
    elif name == "least_brush":
        w["brush"] = 4.0 * max(1.0, float(w.get("brush", 1.0)))
    elif name == "shadiest":
        w["sun"] = -1.0
    elif name == "least_climb":
        w["climb"] = 8.0          # 1 m up costs like 8 m of walking
    return w


class CostModel:
    """Per-cell cost arrays for one weight set, and step costs between cells."""

    def __init__(self, G, trail, weights):
        w = dict(DEFAULT_WEIGHTS)
        w.update({k: float(v) for k, v in (weights or {}).items()})
        self.w = w
        tw = np.where(trail == 2, w.get("road", 0), np.where(
            trail == 1, w.get("trail", 0), 0.0)).astype(np.float32)
        tw = np.clip(tw, 0.0, 1.0)
        self.tw = tw
        sun = G["shade"]
        ws = max(-1.0, min(1.0, w.get("sun", 0.0)))
        sun_term = ws * (1.0 - sun) if ws >= 0 else (-ws) * sun
        self.base = (max(w.get("distance", 1.0), 0.01) +
                     max(w.get("brush", 0.0), 0) * brush_g(G["brush"]) * (1 - tw)
                     + sun_term).astype(np.float32)
        self.tf = (1.0 - 0.9 * tw).astype(np.float32)
        self.cliff = G["cliff"] & (tw <= 0)
        wc = max(0.0, min(1.0, w.get("cliff", 0.5)))
        self.cliff_factor = np.inf if wc <= 0 else CLIFF_FACTOR / (wc * wc)
        self.steep = max(0.0, w.get("steep", 1.0))
        self.climb = max(0.0, w.get("climb", 0.0))
        self.gx, self.gy = G["gx"], G["gy"]
        self.cell = G["cell"]
        self.shape = sun.shape

    @staticmethod
    def crossed(dr, dc):
        if dr and dc and abs(dr) == abs(dc):
            return [(dr, 0), (0, dc)]
        if abs(dc) == 2:
            s = int(np.sign(dc))
            return [(0, s), (dr, s)]
        if abs(dr) == 2:
            s = int(np.sign(dr))
            return [(s, 0), (s, dc)]
        return []

    def step_cost(self, R, C, dr, dc):
        """Cost of stepping from cells (R, C) by (dr, dc); inf if blocked.
        Callers keep (R+dr, C+dc) and the crossed cells inside the grid."""
        R2, C2 = R + dr, C + dc
        cells = [(R, C), (R2, C2)] + [(R + a, C + b)
                                      for a, b in self.crossed(dr, dc)]
        base = sum(self.base[r, c] for r, c in cells) / len(cells)
        tf = sum(self.tf[r, c] for r, c in cells) / len(cells)
        cl = np.zeros(len(R), bool)
        for r, c in cells:
            cl |= self.cliff[r, c]
        d = self.cell * math.hypot(dr, dc)
        de, dn = dc * self.cell / d, -dr * self.cell / d
        gx = 0.5 * (self.gx[R, C] + self.gx[R2, C2])
        gy = 0.5 * (self.gy[R, C] + self.gy[R2, C2])
        grade = gx * de + gy * dn
        terr = self.steep * steep_f(grade) + self.climb * np.maximum(grade, 0)
        cost = d * (base + np.where(cl, 0.0, terr)) * tf
        cost = np.where(cl, cost * self.cliff_factor, cost)
        return cost.astype(np.float64)


def offsets(conn):
    o = [(dr, dc) for dr in (-1, 0, 1) for dc in (-1, 0, 1) if dr or dc]
    if conn >= 16:
        o += [(1, 2), (2, 1), (-1, 2), (-2, 1), (1, -2), (2, -1),
              (-1, -2), (-2, -1)]
    return o


def search(model, mask, end_rc, conn, limit=np.inf):
    """Dijkstra from the end over the masked cells (edges reversed, so the
    distances are costs of walking TO the end). Returns (dist, nxt, ids)
    on the full grid: dist inf where not reached, nxt = flat index of the next
    cell toward the end."""
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import dijkstra
    ny, nx = mask.shape
    R, C = np.nonzero(mask)
    ids = np.full(mask.shape, -1, np.int64)
    ids[R, C] = np.arange(len(R))
    rows, cols, data = [], [], []
    for dr, dc in offsets(conn):
        need = [(dr, dc)] + model.crossed(dr, dc)
        ok = np.ones(len(R), bool)
        for a, b in need:
            ok &= (R + a >= 0) & (R + a < ny) & (C + b >= 0) & (C + b < nx)
        r, c = R[ok], C[ok]
        ok2 = mask[r + dr, c + dc]
        r, c = r[ok2], c[ok2]
        if not len(r):
            continue
        w = model.step_cost(r, c, dr, dc)
        fin = np.isfinite(w)
        r, c, w = r[fin], c[fin], np.maximum(w[fin], 1e-9)
        rows.append(ids[r + dr, c + dc])    # reversed: from v ...
        cols.append(ids[r, c])              # ... to u, weight c(u -> v)
        data.append(w)
    n = len(R)
    if rows:
        g = csr_matrix((np.concatenate(data),
                        (np.concatenate(rows), np.concatenate(cols))),
                       shape=(n, n))
    else:
        g = csr_matrix((n, n))
    src = int(ids[end_rc])
    d, pred = dijkstra(g, directed=True, indices=src, return_predecessors=True,
                       limit=limit)
    dist = np.full(mask.shape, np.inf)
    dist[R, C] = d
    nxt = np.full(mask.shape, -1, np.int64)
    good = pred >= 0
    nxt[R[good], C[good]] = R[pred[good]] * nx + C[pred[good]]
    return dist, nxt, int(g.nnz)


def trace(nxt, start_rc, end_rc, nx):
    path = [start_rc]
    cur = start_rc[0] * nx + start_rc[1]
    endf = end_rc[0] * nx + end_rc[1]
    guard = nxt.size
    while cur != endf and guard > 0:
        cur = int(nxt.flat[cur])
        if cur < 0:
            return None
        path.append((cur // nx, cur % nx))
        guard -= 1
    return path


def line_cells(a, b):
    """8-connected cells from a to b (row, col)."""
    (r0, c0), (r1, c1) = a, b
    n = max(abs(r1 - r0), abs(c1 - c0))
    if n == 0:
        return [a]
    t = np.arange(n + 1) / n
    rr = np.rint(r0 + (r1 - r0) * t).astype(int)
    cc = np.rint(c0 + (c1 - c0) * t).astype(int)
    return list(zip(rr.tolist(), cc.tolist()))


def path_cost(model, cells):
    tot = 0.0
    for (r0, c0), (r1, c1) in zip(cells[:-1], cells[1:]):
        tot += float(model.step_cost(np.array([r0]), np.array([c0]),
                                     r1 - r0, c1 - c0)[0])
    return tot


def corridor_mask(grid, ends_rc, starts_rc, radius_m):
    """Cells within radius_m of any straight line start -> end."""
    ny, nx = grid.shape
    rr, cc = np.mgrid[0:ny, 0:nx]
    rr = rr.astype(np.float32); cc = cc.astype(np.float32)
    m = np.zeros((ny, nx), bool)
    rad = radius_m / grid.cell
    er, ec = ends_rc
    for sr, sc in starts_rc:
        vr, vc = er - sr, ec - sc
        L2 = float(vr * vr + vc * vc) or 1.0
        t = np.clip(((rr - sr) * vr + (cc - sc) * vc) / L2, 0, 1)
        d2 = (rr - sr - t * vr) ** 2 + (cc - sc - t * vc) ** 2
        m |= d2 <= rad * rad
    return m


def grow_check(mask, dist, paths, targets, best, model, grid):
    """Cells on the corridor edge from which the corridor should grow:
    the best path runs within 2 cells of the edge, or an edge cell is still
    cheap (its cost to the end plus the straight distance to that start, at
    a low per-metre cost -- the 25th percentile of the corridor's cells --
    is under that start's best cost). Unreached starts grow the whole edge."""
    from scipy import ndimage
    inner = ndimage.binary_erosion(mask, border_value=1)
    edge = mask & ~inner
    edge[0, :] = edge[-1, :] = False
    edge[:, 0] = edge[:, -1] = False
    if not edge.any():
        return None
    trig = np.zeros(mask.shape, bool)
    if any(b is None or not np.isfinite(b) for b in best):
        return edge
    dedge = ndimage.distance_transform_edt(~edge)
    for p in paths:
        if p is None:
            continue
        pr = np.array([c[0] for c in p]); pc = np.array([c[1] for c in p])
        near = dedge[pr, pc] <= 2.0
        if near.any():
            trig |= edge & (ndimage.distance_transform_edt(
                ~_points_mask(mask.shape, pr[near], pc[near])) <= 4)
    per_m = float(np.percentile((model.base * model.tf)[mask], 25))
    er, ec = np.nonzero(edge)
    de = dist[er, ec]
    for t, b in zip(targets, best):
        if t.get("dmap") is not None:
            dm = t["dmap"][er, ec]
        else:
            sr, sc = t["rc"]
            dm = np.hypot(er - sr, ec - sc) * grid.cell
        lb = de + dm * per_m
        cheap = np.isfinite(de) & (lb < b * 0.999)
        trig[er[cheap], ec[cheap]] = True
    return trig if trig.any() else None


def _points_mask(shape, r, c):
    m = np.zeros(shape, bool)
    m[r, c] = True
    return m


def snap_cell(rc, model, grid, radius_m=10.0):
    """Nearest cell that is not a blocked cliff (blocked only at cliff 0)."""
    r, c = rc
    ny, nx = grid.shape
    if not (0 <= r < ny and 0 <= c < nx):
        return None
    if not (np.isinf(model.cliff_factor) and model.cliff[r, c]):
        return (r, c)
    k = int(math.ceil(radius_m / grid.cell))
    r0, r1 = max(0, r - k), min(ny, r + k + 1)
    c0, c1 = max(0, c - k), min(nx, c + k + 1)
    sub = ~model.cliff[r0:r1, c0:c1]
    if not sub.any():
        return None
    rr, cc = np.nonzero(sub)
    i = int(np.argmin((rr + r0 - r) ** 2 + (cc + c0 - c) ** 2))
    return (int(rr[i] + r0), int(cc[i] + c0))


def solve(model, grid, end_rc, targets, corridor_m, conn, mask0=None,
          max_rounds=8, say=ascii_say):
    """Best path from every target to the end, growing the corridor as needed.

    A target is {"rc": cell} (a start point) or {"rc": the line cell nearest
    the end, "mask": the line's cells, "dmap": metres to the line} (a start
    line: every cell of it is a start, the cheapest wins). Returns paths,
    best costs, the start cell of each, the final mask, growth rounds and
    the number of settled cells."""
    from scipy import ndimage
    reps = [t["rc"] for t in targets]
    mask = mask0.copy() if mask0 is not None else corridor_mask(
        grid, end_rc, reps, corridor_m)
    for rc in [end_rc] + reps:
        mask[rc] = True
    grew = 0
    # Upper bound for the early exit: walking the straight cell lines.
    ub = [path_cost(model, line_cells(s, end_rc)) for s in reps]
    limit = max(ub) * 1.0001 + 1e-6 if ub and all(np.isfinite(ub)) else np.inf
    while True:
        t0 = time.time()
        dist, nxt, nnz = search(model, mask, end_rc, conn, limit)
        best, chosen = [], []
        for t in targets:
            if t.get("mask") is not None:
                cand = t["mask"] & np.isfinite(dist)
                if cand.any():
                    rr, cc = np.nonzero(cand)
                    i = int(np.argmin(dist[rr, cc]))
                    chosen.append((int(rr[i]), int(cc[i])))
                    best.append(float(dist[rr[i], cc[i]]))
                else:
                    chosen.append(t["rc"]); best.append(np.inf)
            else:
                chosen.append(t["rc"]); best.append(float(dist[t["rc"]]))
        paths = [trace(nxt, s, end_rc, grid.nx) if np.isfinite(b) else None
                 for s, b in zip(chosen, best)]
        say(f"  search: {int(mask.sum()):,} cells, {nnz:,} steps, "
            f"{time.time() - t0:.1f} s")
        if grew >= max_rounds:
            break
        trig = grow_check(mask, dist, paths, targets, best, model, grid)
        if trig is None:
            break
        add = ndimage.distance_transform_edt(~trig) * grid.cell <= corridor_m
        new = mask | add
        if new.sum() == mask.sum():
            break
        mask = new
        grew += 1
        say(f"  corridor grows ({grew}): now {int(mask.sum()):,} cells")
    settled = int(np.isfinite(dist).sum())
    return paths, best, chosen, mask, grew, settled


# --------------------------------------------------------------------------
# Route stats, geometry, options
# --------------------------------------------------------------------------

def route_stats(path, G, model, grid, zone, south, units):
    """Stats, warnings, profile and lon/lat geometry for one cell path."""
    cell = grid.cell
    R = np.array([p[0] for p in path]); C = np.array([p[1] for p in path])
    dem = G["ground"]
    elev = dem[R, C].astype(np.float64)
    brush = G["brush"][R, C].astype(np.float64)
    sun = G["shade"][R, C].astype(np.float64)
    slope = G["slope"][R, C].astype(np.float64)
    cliff = G["cliff"][R, C]
    ontr = model.tw[R, C] > 0
    onany = G["trail"][R, C] > 0
    dR, dC = np.diff(R), np.diff(C)
    d = np.hypot(dR, dC) * cell
    de = np.where(d > 0, dC * cell / np.maximum(d, 1e-9), 0)
    dn = np.where(d > 0, -dR * cell / np.maximum(d, 1e-9), 0)
    gx = 0.5 * (G["gx"][R[:-1], C[:-1]] + G["gx"][R[1:], C[1:]])
    gy = 0.5 * (G["gy"][R[:-1], C[:-1]] + G["gy"][R[1:], C[1:]])
    grade = np.clip(gx * de + gy * dn, -3, 3)
    # per-step attributes: mean of the two cells
    sb = 0.5 * (brush[:-1] + brush[1:])
    ss = 0.5 * (sun[:-1] + sun[1:])
    sc = cliff[:-1] | cliff[1:]
    st = ontr[:-1] & ontr[1:]
    sa = onany[:-1] & onany[1:]
    L = float(d.sum())

    k = np.where(st, 1.0, 0.6)
    t_flat = d / 1000.0 / (6.0 * k) * 60.0
    t_terr = d / 1000.0 / (tobler_kmh(grade) * k) * 60.0
    t_terr = np.where(sc, t_terr * 3.0, t_terr)
    extra = t_terr - t_flat
    t_brush = np.where(st, 0.0, t_terr * 4.0 * sb ** 2)
    walk = float(t_flat[~st].sum()); trail_t = float(t_flat[st].sum())
    climb_t = float(extra[grade >= 0].sum()); desc_t = float(extra[grade < 0].sum())
    brush_t = float(t_brush.sum())
    bd = {"walk_min": round(walk, 1), "climb_min": round(climb_t, 1),
          "descent_min": round(desc_t, 1), "brush_min": round(brush_t, 1),
          "trail_min": round(trail_t, 1)}
    time_min = round(sum(bd.values()), 1)

    # climb with a 0.3 m hysteresis (the DEM has small ripples)
    climb = descent = 0.0
    ref = elev[0] if len(elev) else 0.0
    for e in elev[1:]:
        if e - ref >= 0.3:
            climb += e - ref; ref = e
        elif ref - e >= 0.3:
            descent += ref - e; ref = e
    # steepest part: grade over ~5 m of route
    win = max(1, int(round(5.0 / cell)))
    if len(grade) >= win:
        ker = np.ones(win) / win
        gsm = np.convolve(np.abs(grade) * d, ker, "valid") / np.maximum(
            np.convolve(d, ker, "valid"), 1e-9)
        max_grade = float(gsm.max()) * 100
    else:
        max_grade = float(np.abs(grade).max() * 100) if len(grade) else 0.0

    def pct(m):
        return round(float(d[m].sum() / L * 100) if L > 0 else 0.0, 1)

    stats = {"length_m": round(L, 1), "climb_m": round(climb, 1),
             "descent_m": round(descent, 1), "time_min": time_min,
             "time_breakdown": bd, "max_grade_pct": round(max_grade, 1),
             "brush_pct": pct(sb >= IN_BRUSH), "sun_pct": pct(ss >= 0.5),
             "cliff_cells": int(cliff[1:-1].sum()) if len(cliff) > 2 else 0,
             "on_trail_pct": pct(sa)}

    warnings = []
    # cliff runs; a run touching the start or the end is said as such (an
    # entrance in a cliff face has to be reached across it)
    runs = []
    i = 0
    while i < len(d):
        if sc[i]:
            j = i
            while j + 1 < len(d) and sc[j + 1]:
                j += 1
            runs.append((float(d[i:j + 1].sum()), i == 0, j == len(d) - 1))
            i = j + 1
        else:
            i += 1
    for rl, at_start, at_end in runs:
        where = (" at the start" if at_start else "") + \
            (" at the end" if at_end and not at_start else "")
        if where and rl <= 2 * cell:
            warnings.append(f"the line{where} is on cliff ground")
        else:
            warnings.append(f"crosses a cliff band for "
                            f"{fmt_len(max(rl, cell), units)}{where}")
    heavy = pct(sb >= HEAVY_BRUSH)
    if heavy >= 15:
        warnings.append(f"{heavy:.0f}% in heavy brush")
    if max_grade > 60:
        warnings.append(f"steep: up to {max_grade:.0f}% grade "
                        f"({math.degrees(math.atan(max_grade / 100)):.0f} deg)")
    if (R == 0).any() or (C == 0).any() or (R == grid.ny - 1).any() or \
            (C == grid.nx - 1).any():
        warnings.append("runs along the edge of the LiDAR area; a better line "
                        "may lie outside it")
    nv = (~G["valid"][R, C]).mean() if "valid" in G else 0
    if nv > 0.2:
        warnings.append(f"{nv * 100:.0f}% of the line is over cells without "
                        "ground returns (filled)")

    # profile (<= 600 points) and the simplified geometry
    cum = np.concatenate([[0.0], np.cumsum(d)])
    step = max(1, int(math.ceil(len(path) / 600)))
    idx = list(range(0, len(path), step))
    if idx[-1] != len(path) - 1:
        idx.append(len(path) - 1)
    profile = [[round(float(cum[i]), 1), round(float(elev[i]), 2),
                round(float(brush[i]), 3), round(float(slope[i]), 1)]
               for i in idx]
    keep = [0]
    for i in range(1, len(path) - 1):
        if (dR[i - 1], dC[i - 1]) != (dR[i], dC[i]):
            keep.append(i)
    keep.append(len(path) - 1)
    xs = grid.minx + (C[keep] + 0.5) * cell
    ys = grid.maxy - (R[keep] + 0.5) * cell
    lon, lat = xy_to_lonlat(xs, ys, zone, south)
    coords = [[round(float(a), 7), round(float(b), 7), round(float(e), 2)]
              for a, b, e in zip(np.atleast_1d(lon), np.atleast_1d(lat),
                                 elev[keep])]
    if len(coords) == 1:
        coords.append(list(coords[0]))
    return stats, warnings, profile, coords


def fmt_len(m, units):
    if units == "ft":
        ft = m * 3.28084
        return f"{ft:.0f} ft" if ft < 1000 else f"{m / 1609.344:.2f} mi"
    return f"{m:.0f} m" if m < 1000 else f"{m / 1000:.2f} km"


def fmt_time(mins):
    mins = int(round(mins))
    return f"{mins} min" if mins < 60 else f"{mins // 60} h {mins % 60:02d} min"


def differs(p, others, cell, thr_m=None, frac=0.25):
    """A preset's path counts as a different option when at least 25% of it
    lies more than max(10 m, 4 cells) from every option already kept."""
    from scipy.spatial import cKDTree
    thr = thr_m or max(10.0, 4 * cell)
    P = np.array(p, float) * cell
    for q in others:
        d, _ = cKDTree(np.array(q, float) * cell).query(P)
        if (d > thr).mean() < frac:
            return False
    return True


# --------------------------------------------------------------------------
# Points: PDAL readers (EPT, LAS/LAZ) and the debug npz
# --------------------------------------------------------------------------

def _smrf_if_needed(x, y, z, cls, say):
    if cls is not None and (cls == GROUND_CLASS).sum() >= 1000:
        return cls
    say("  no ground class in the data: running SMRF")
    import pdal
    arr = np.zeros(len(x), dtype=[("X", "f8"), ("Y", "f8"), ("Z", "f8"),
                                  ("Classification", "u1")])
    arr["X"], arr["Y"], arr["Z"] = x, y, z
    p = pdal.Pipeline(json.dumps({"pipeline": [
        {"type": "filters.assign", "value": "Classification = 1"},
        {"type": "filters.smrf", "slope": 0.2, "window": 18,
         "threshold": 0.5, "scalar": 1.2}]}), arrays=[arr])
    p.execute()
    return p.arrays[0]["Classification"].astype(np.int16)


def _tiles(bbox, tile_m):
    e0, n0, e1, n1 = bbox
    nx = max(1, int(math.ceil((e1 - e0) / tile_m)))
    ny = max(1, int(math.ceil((n1 - n0) / tile_m)))
    for j in range(ny):
        for i in range(nx):
            yield (e0 + (e1 - e0) * i / nx, n0 + (n1 - n0) * j / ny,
                   e0 + (e1 - e0) * (i + 1) / nx, n0 + (n1 - n0) * (j + 1) / ny)


def _read_las_tile(files, epsg_in, utm_epsg, bbox):
    import pdal
    stages = [{"type": "readers.las", "filename": f} for f in files]
    if epsg_in:
        for s in stages:
            s["override_srs"] = f"EPSG:{int(epsg_in)}"
    if len(stages) > 1:
        stages.append({"type": "filters.merge"})
    stages.append({"type": "filters.reprojection", "out_srs": f"EPSG:{utm_epsg}"})
    e0, n0, e1, n1 = bbox
    stages.append({"type": "filters.crop", "bounds": f"([{e0},{e1}],[{n0},{n1}])"})
    p = pdal.Pipeline(json.dumps({"pipeline": stages}))
    p.execute()
    if not p.arrays or not len(p.arrays[0]):
        return None
    a = p.arrays[0]
    try:
        c = a["Classification"].astype(np.int16)
    except Exception:
        c = None
    return a["X"], a["Y"], a["Z"], c


def read_points(source, utm_bbox, zone, south, say, tile_m=600.0):
    """A Points cloud (UTM metres) for the bbox. PDAL sources are read in
    tiles of about tile_m so the full structured arrays never coexist."""
    e0, n0, e1, n1 = utm_bbox
    P = Points(e0, n0)

    def add(x, y, z, c, box):
        k = (x >= box[0]) & (x < box[2]) & (y >= box[1]) & (y < box[3])
        if k.any():
            P.add(x[k], y[k], z[k], None if c is None else c[k])
        return int(k.sum())

    if "npz" in source:
        d = np.load(source["npz"])
        x, y = d["x"], d["y"]
        k = (x >= e0) & (x <= e1) & (y >= n0) & (y <= n1)
        cls = d["classification"][k] if "classification" in d.files else None
        P.add(x[k], y[k], d["z"][k], cls)
        del x, y, k
    elif "ept" in source or "las" in source:
        try:
            import pdal  # noqa: F401
        except ImportError:
            raise RuntimeError("pdal not installed (conda install -c "
                               "conda-forge python-pdal), as for Generate")
        tiles = list(_tiles(utm_bbox, tile_m))
        files = None
        if "las" in source:
            files = source["las"] if isinstance(source["las"], list) else [source["las"]]
        for ti, box in enumerate(tiles):
            say(f"  reading tile {ti + 1}/{len(tiles)}")
            if files:
                r = _read_las_tile(files, source.get("epsg"),
                                   (32700 if south else 32600) + zone, box)
                if r is None:
                    continue
                x, y, z, c = r
            else:
                cover = et().latlon_box_covering(box, zone, south)
                try:
                    x, y, z, c, _ = ld.read_ept_all_classes(
                        source["ept"], box, cover, zone=zone, south=south,
                        progress=lambda m: None)
                except SystemExit as e:
                    if "no points" in str(e.code):
                        continue
                    raise
            add(x, y, z, c, box)
            del x, y, z, c
    else:
        raise RuntimeError("params.source needs 'ept' or 'las'")
    P.finish()
    if not len(P):
        raise RuntimeError("no LiDAR points in the route area")
    say(f"  {len(P):,} points in the area")
    if "npz" not in source:
        ng = int((P.cls == GROUND_CLASS).sum()) if P.cls is not None else 0
        if ng < 1000:
            x = P.xl.astype(np.float64) + P.ox
            y = P.yl.astype(np.float64) + P.oy
            P.cls = _smrf_if_needed(x, y, P.z.astype(np.float64), None,
                                    say).astype(np.uint8)
            del x, y
    return P


# --------------------------------------------------------------------------
# Cache
# --------------------------------------------------------------------------

GRID_FILES = ("ground.npy", "slope.npy", "cliff.npy", "brush.npy",
              "shade.npy", "valid.npy", "gx.npy", "gy.npy", "grid.json")


def source_id(source):
    s = dict(source)
    if "las" in s:
        files = s["las"] if isinstance(s["las"], list) else [s["las"]]
        s["las"] = sorted(os.path.abspath(f) for f in files)
        s["las_mtime"] = [round(os.path.getmtime(f)) if os.path.exists(f) else 0
                          for f in s["las"]]
    if "npz" in s:
        s["npz"] = os.path.abspath(s["npz"])
        s["npz_mtime"] = round(os.path.getmtime(s["npz"])) \
            if os.path.exists(s["npz"]) else 0
    return json.dumps(s, sort_keys=True)


def cache_key(src_id, bbox, cell_spec, band, dem, method="csf"):
    k = json.dumps([VERSION, src_id, [round(v, 1) for v in bbox], str(cell_spec),
                    [round(b, 3) for b in band], dem]
                   + ([method] if method != "csf" else []), sort_keys=True)
    return hashlib.sha1(k.encode()).hexdigest()[:16]


def dem_ok(cached, wanted):
    return cached == wanted or (cached == "both" and wanted in ("below",))


def find_cached(dirs, src_id, need_bbox, cell_spec, band, dem, method="csf"):
    """A cached grid set with the same source, cell, band and dem whose area
    covers the bbox needed now (so moved starts / end reuse it)."""
    for d in dirs:
        meta_p = os.path.join(d, "grid.json")
        if not os.path.exists(meta_p):
            continue
        try:
            with open(meta_p) as f:
                m = json.load(f)
        except Exception:
            continue
        k = m.get("cache") or {}
        if k.get("version") != VERSION or k.get("source") != src_id:
            continue
        if str(k.get("cell_spec")) != str(cell_spec):
            continue
        if [round(b, 3) for b in k.get("band", [])] != [round(b, 3) for b in band]:
            continue
        if not dem_ok(k.get("dem"), dem):
            continue
        if k.get("method", "csf") != method:
            continue
        if not all(os.path.exists(os.path.join(d, f)) for f in GRID_FILES):
            continue
        if dem == "both" and not os.path.exists(os.path.join(d, "ground_above.npy")):
            continue
        e0, n0, e1, n1 = need_bbox
        if m["minx"] <= e0 + 1e-6 and m["miny"] <= n0 + 1e-6 and \
                m["maxx"] >= e1 - 1e-6 and m["maxy"] >= n1 - 1e-6:
            return d, m
    return None, None


def load_grids(d, m):
    G = {}
    for f in GRID_FILES:
        if f.endswith(".npy"):
            G[f[:-4]] = np.load(os.path.join(d, f))
    if os.path.exists(os.path.join(d, "ground_above.npy")):
        G["above"] = np.load(os.path.join(d, "ground_above.npy"))
    G["cliff"] = G["cliff"].astype(bool)
    G["valid"] = G["valid"].astype(bool)
    return G


def _hillshade(dem, cell):
    gx, gy = gradients(dem, cell, baseline=cell * 2)
    az, alt = math.radians(315), math.radians(45)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, -gy)          # direction the slope faces
    hs = (math.sin(alt) * np.cos(slope) +
          math.cos(alt) * np.sin(slope) * np.cos(az - aspect))
    v = np.clip(hs, 0, 1)
    g = (v * 255).astype(np.uint8)
    return np.dstack([g, g, g, np.full_like(g, 255)])


SLOPE_RAMP = [(0.0, (240, 240, 230)), (0.33, (250, 210, 90)),
              (0.66, (230, 110, 40)), (1.0, (150, 20, 40))]
SUN_RAMP = [(0.0, (30, 50, 90)), (0.5, (130, 140, 150)), (1.0, (255, 220, 90))]
DIFF_RAMP = [(0.0, (250, 250, 250)), (0.3, (120, 190, 230)),
             (0.7, (60, 80, 200)), (1.0, (120, 0, 120))]


def write_grids(d, G, grid, meta, say):
    os.makedirs(d, exist_ok=True)
    np.save(os.path.join(d, "ground.npy"), G["ground"].astype(np.float32))
    np.save(os.path.join(d, "slope.npy"), G["slope"])
    np.save(os.path.join(d, "cliff.npy"), G["cliff"].astype(np.uint8))
    np.save(os.path.join(d, "brush.npy"), G["brush"])
    np.save(os.path.join(d, "shade.npy"), G["shade"])
    np.save(os.path.join(d, "valid.npy"), G["valid"].astype(np.uint8))
    np.save(os.path.join(d, "gx.npy"), G["gx"])
    np.save(os.path.join(d, "gy.npy"), G["gy"])
    rgba, _, _ = ld.colorize(G["brush"], ld.VEG_RAMP, 0.0, 0.6)
    ld.write_png(rgba, os.path.join(d, "brush.png"))
    rgba, _, _ = ld.colorize(G["slope"], SLOPE_RAMP, 0.0, 60.0)
    rgba[G["cliff"]] = (120, 0, 30, 255)
    ld.write_png(rgba, os.path.join(d, "slope.png"))
    rgba, _, _ = ld.colorize(G["shade"], SUN_RAMP, 0.0, 1.0)
    ld.write_png(rgba, os.path.join(d, "shade.png"))
    ld.write_png(_hillshade(G["ground"], grid.cell),
                 os.path.join(d, "ground_hs.png"))
    if "above" in G and "below" in G:
        np.save(os.path.join(d, "ground_above.npy"), G["above"])
        diff = np.abs(G["above"] - G["below"])
        rgba, _, _ = ld.colorize(diff, DIFF_RAMP, 0.0, 2.0)
        ld.write_png(rgba, os.path.join(d, "dem_diff.png"))
    with open(os.path.join(d, "grid.json"), "w") as f:
        json.dump(meta, f, indent=1)
    say(f"  wrote the grids to {d}")


def grid_meta(grid, zone, south, key, cache):
    xs = [grid.minx, grid.maxx, grid.maxx, grid.minx]
    ys = [grid.maxy, grid.maxy, grid.miny, grid.miny]
    lon, lat = xy_to_lonlat(xs, ys, zone, south)
    return {"minx": grid.minx, "maxx": grid.maxx, "miny": grid.miny,
            "maxy": grid.maxy, "cell": grid.cell, "nx": grid.nx, "ny": grid.ny,
            "epsg": (32700 if south else 32600) + zone,
            "bounds_lonlat": [[round(float(a), 8), round(float(b), 8)]
                              for a, b in zip(lon, lat)],
            "bounds_order": "nw, ne, se, sw (raster corners; row 0 is north)",
            "raster_bounds_lonlat": [float(min(lon)), float(min(lat)),
                                     float(max(lon)), float(max(lat))],
            "shade_values": "sun at equinox noon, 0 = full shade, 1 = full sun",
            "trail_values": "0 none, 1 trail, 2 road",
            "cache_key": key, "cache": cache}


def prune_cache(cache_dir, keep=8, say=ascii_say):
    """Keep the newest `keep` grid sets in a shared cache folder."""
    import shutil
    sets = []
    for n in os.listdir(cache_dir):
        d = os.path.join(cache_dir, n)
        if os.path.exists(os.path.join(d, "grid.json")):
            sets.append((os.path.getmtime(d), d))     # dir mtime = last use
    for _t, d in sorted(sets, reverse=True)[keep:]:
        shutil.rmtree(d, ignore_errors=True)
        say(f"  cache: removed an old grid set ({os.path.basename(d)})")


def link_or_copy(src, dst):
    import shutil
    if os.path.abspath(src) == os.path.abspath(dst):
        return
    if os.path.exists(dst):
        os.remove(dst)
    try:
        os.link(src, dst)
    except Exception:
        shutil.copy2(src, dst)


# --------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------

def run(params, out_dir, cache_dir=None, say=ascii_say):
    t_start = time.time()
    timings = {}
    os.makedirs(out_dir, exist_ok=True)
    src = params.get("source") or {}
    end = params.get("end")
    starts = params.get("starts") or []
    start_lines = params.get("start_lines")
    if not end or not (starts or start_lines):
        raise RuntimeError("params need 'end' and at least one start "
                           "(starts or start_lines)")
    cell_spec = params.get("cell", "auto")
    dem = params.get("dem", "below")
    if dem not in ("below", "above", "both"):
        raise RuntimeError("dem must be below, above or both")
    band = [float(v) for v in params.get("brush_band", [0.5, 2.0])]
    dem_method = params.get("dem_method", "csf")
    if dem_method not in ("csf", "export"):
        raise RuntimeError("dem_method must be csf or export")
    cache_dir = cache_dir or params.get("cache_dir") or \
        os.environ.get("FLEX_ROUTE_CACHE") or None
    weights = dict(DEFAULT_WEIGHTS)
    weights.update(params.get("weights") or {})
    corridor_m = float(params.get("corridor_m", 300))
    presets = [p for p in params.get("presets", list(PRESETS)) if p in PRESETS]
    units = params.get("units", "m")

    # Zone: from the npz's EPSG, else the centre of the ends.
    lons = [end[0]] + [s[0] for s in starts]
    lats = [end[1]] + [s[1] for s in starts]
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
    else:
        zone = et().utm_zone_for(sum(lons) / len(lons))
        south = (sum(lats) / len(lats)) < 0
    lat0 = sum(lats) / len(lats)
    pts = [lonlat_to_xy(lo, la, zone) for lo, la in zip(lons, lats)]
    # Start lines: every cell under them is a start. The area covers the
    # part of each line nearest the end.
    slines = geojson_lines(start_lines, zone) if start_lines else []
    line_near = []
    for _n, _k, ls in slines:
        q, dq = nearest_on_lines(ls, np.array(pts[0]))
        line_near.append((q, dq))
    bbox_pts = pts + [q for q, _ in line_near]
    margin = float(params.get("area_margin_m", max(2 * corridor_m, 200.0)))
    snap = 50.0
    need = (min(p[0] for p in bbox_pts) - margin, min(p[1] for p in bbox_pts) - margin,
            max(p[0] for p in bbox_pts) + margin, max(p[1] for p in bbox_pts) + margin)
    need = (math.floor(need[0] / snap) * snap, math.floor(need[1] / snap) * snap,
            math.ceil(need[2] / snap) * snap, math.ceil(need[3] / snap) * snap)
    if npz_ext:                            # no data beyond the file
        need = (max(need[0], npz_ext[0]), max(need[1], npz_ext[1]),
                min(need[2], npz_ext[2]), min(need[3], npz_ext[3]))
    if "area_bbox_utm" in params:          # tests / callers may pin the area
        need = tuple(float(v) for v in params["area_bbox_utm"])
    sid = source_id(src)
    gdir = os.path.join(out_dir, "grids")
    look = [gdir]
    if cache_dir:
        if os.path.isdir(cache_dir):
            look += [os.path.join(cache_dir, n) for n in sorted(os.listdir(cache_dir))]
    found, meta = find_cached(look, sid, need, cell_spec, band, dem, dem_method)
    counts = {}
    if found:
        say(f"[1/4] Reusing cost grids ({meta['cache_key']}), "
            f"{meta['nx']}x{meta['ny']} @ {meta['cell']} m")
        grid = ld.Grid(meta["minx"], meta["miny"], meta["maxx"], meta["maxy"],
                       meta["cell"])
        G = load_grids(found, meta)
        if found != gdir:
            try:
                os.utime(found)        # last use, for prune_cache
            except OSError:
                pass
        key = meta["cache_key"]
        reused = True
        if found != gdir:
            os.makedirs(gdir, exist_ok=True)
            for f in os.listdir(found):
                link_or_copy(os.path.join(found, f), os.path.join(gdir, f))
        counts.update(meta.get("counts") or {})
    else:
        reused = False
        say(f"[1/4] Reading points (UTM zone {zone}{'S' if south else 'N'}, "
            f"{(need[2] - need[0]):.0f} x {(need[3] - need[1]):.0f} m)")
        t0 = time.time()
        P = read_points(src, need, zone, south, say)
        timings["read_s"] = round(time.time() - t0, 2)
        area = (need[2] - need[0]) * (need[3] - need[1])
        ng = int((P.cls == GROUND_CLASS).sum()) if P.cls is not None else len(P)
        if cell_spec == "auto" or cell_spec is None:
            cell = auto_cell(ng, area)
            say(f"  auto cell: {cell} m ({ng / area:.1f} ground returns per m2)")
        else:
            cell = float(cell_spec)
        grid = ld.Grid(need[0], need[1], need[2], need[3], cell)
        say(f"[2/4] Cost grids {grid.nx}x{grid.ny} @ {cell} m, dem {dem}")
        t0 = time.time()
        G = build_grids(P, grid, band, dem, lat0, say, method=dem_method)
        timings["grids_s"] = round(time.time() - t0, 2)
        counts.update(points=int(len(P)), ground_points=ng)
        key = cache_key(sid, need, cell_spec, band, dem, dem_method)
        cache = {"version": VERSION, "source": sid, "cell_spec": str(cell_spec),
                 "band": band, "dem": dem, "method": dem_method}
        meta = grid_meta(grid, zone, south, key, cache)
        meta["counts"] = dict(counts)
        if dem == "both":
            meta["dem_compare"] = dem_compare(G["below"], G["above"], grid,
                                              zone, south)
        target = os.path.join(cache_dir, key) if cache_dir else gdir
        write_grids(target, G, grid, meta, say)
        if cache_dir:
            prune_cache(cache_dir, keep=int(params.get("cache_keep", 8)), say=say)
        if cache_dir:
            os.makedirs(gdir, exist_ok=True)
            for f in os.listdir(target):
                link_or_copy(os.path.join(target, f), os.path.join(gdir, f))
        del P
    G["cell"] = grid.cell
    counts["cells"] = int(grid.nx * grid.ny)

    # Trails: cheap, rasterised every run (not part of the cache key).
    G["trail"] = rasterize_trails(params.get("trails"), grid, zone)
    np.save(os.path.join(gdir, "trail.npy"), G["trail"])

    # Ends in grid cells.
    def rc_of(p):
        c, r = grid.indices(np.array([p[0]]), np.array([p[1]]))
        return (int(r[0]), int(c[0]))
    end_xy, start_xy = pts[0], pts[1:]
    for p in pts:
        if not (grid.minx <= p[0] <= grid.maxx and grid.miny <= p[1] <= grid.maxy):
            raise RuntimeError("an end or start lies outside the LiDAR grid")
    from scipy import ndimage
    line_t = []           # (index, name, kind, mask, dmap, nearest cell)
    for li, ((name, kind, ls), (q, dq)) in enumerate(zip(slines, line_near)):
        m = mark_lines(ls, grid, max(grid.cell, float(
            params.get("start_line_buffer_m", 2.0))))
        if not m.any():
            say(f"  start line {li + 1} lies outside the LiDAR grid: skipped")
            continue
        dmap = ndimage.distance_transform_edt(~m).astype(np.float32) * grid.cell
        rr, cc = np.nonzero(m)
        er, ec = rc_of(end_xy)
        i = int(np.argmin((rr - er) ** 2 + (cc - ec) ** 2))
        line_t.append((li, name or f"{kind} {li + 1}", kind, m, dmap,
                       (int(rr[i]), int(cc[i]))))
    n_pt = len(start_xy)
    if slines and not line_t and not n_pt:
        raise RuntimeError("no start line crosses the LiDAR grid")

    conn = params.get("connectivity", "auto")
    say("[3/4] Searching from the end")
    t0 = time.time()
    options = [("recommended", weights)] + [(p, preset_weights(p, weights))
                                            for p in presets]
    results = []          # (option, start_index, path, best, model, start cell)
    corridor_grew = 0
    settled = 0
    mask_final = None
    for oi, (name, w) in enumerate(options):
        model = CostModel(G, G["trail"], w)
        end_rc = snap_cell(rc_of(end_xy), model, grid)
        if end_rc is None:
            raise RuntimeError("the end is inside a blocked cliff area")
        targets, tidx = [], []
        for i, s in enumerate(start_xy):
            rc = snap_cell(rc_of(s), model, grid)
            if rc is not None:
                targets.append({"rc": rc}); tidx.append(i)
        for li, _nm, _k, m, dmap, near in line_t:
            usable = (m & ~model.cliff) if np.isinf(model.cliff_factor) else m
            if not usable.any():
                continue
            rc = near if usable[near] else snap_cell(near, model, grid, 50.0)
            if rc is None:
                continue
            targets.append({"rc": rc, "mask": usable, "dmap": dmap})
            tidx.append(n_pt + li)
        if not targets:
            raise RuntimeError("every start is inside a blocked cliff area")
        if conn == "auto":
            est = corridor_mask(grid, end_rc, [t["rc"] for t in targets],
                                corridor_m).sum() if mask_final is None \
                else mask_final.sum()
            cn = 16 if est <= 2_000_000 else 8
        else:
            cn = int(conn)
        paths, best, chosen, mask, grew, st = solve(
            model, grid, end_rc, targets, corridor_m, cn,
            mask0=mask_final, say=say)
        if oi == 0:
            corridor_grew = grew
            settled = st
            mask_final = mask
        else:
            corridor_grew += grew
            mask_final = mask_final | mask
        for i, p, b, c in zip(tidx, paths, best, chosen):
            results.append((name, i, p, b, model, c))
        say(f"  {OPTION_NAMES[name]}: done")
    timings["search_s"] = round(time.time() - t0, 2)

    # With start lines: the cheapest line is the answer; other lines are kept
    # when within 1.5 x its cost (recommended) -- presets keep only their
    # cheapest line.
    def is_line(si):
        return si >= n_pt
    line_best = {}
    for name, si, path, best, model, c in results:
        if is_line(si) and path is not None:
            line_best[name] = min(line_best.get(name, np.inf), best)

    say("[4/4] Route stats")
    feats = []
    kept = {}
    missing = []
    line_names = {n_pt + li: nm for li, nm, _k, _m, _d, _n in line_t}
    for name, si, path, best, model, c in results:
        if path is None:
            if name == "recommended":
                missing.append(si)
            continue
        is_best_line = False
        if is_line(si):
            lb = line_best.get(name, np.inf)
            is_best_line = best <= lb
            if name == "recommended" and best > 1.5 * lb:
                continue
            if name != "recommended" and not is_best_line:
                continue
        key_si = "lines" if (is_line(si) and name != "recommended") else si
        if name != "recommended":
            others = kept.get(key_si, []) if key_si != "lines" else \
                [q for k, v in kept.items() if not isinstance(k, str) and is_line(k)
                 for q in v]
            if not differs(path, others, grid.cell):
                say(f"  {OPTION_NAMES[name]} (start {si + 1}): same as an "
                    "option already kept")
                continue
        kept.setdefault(si, []).append(path)
        stats, warns, prof, coords = route_stats(path, G, model, grid, zone,
                                                 south, units)
        label = (f"{OPTION_NAMES[name]}: {fmt_len(stats['length_m'], units)}, "
                 f"{fmt_time(stats['time_min'])}")
        if is_line(si):
            label = f"From {line_names[si]} - " + label
        elif n_pt > 1 or line_t:
            label = f"Start {si + 1} - " + label
        sx = grid.minx + (c[1] + 0.5) * grid.cell
        sy = grid.maxy - (c[0] + 0.5) * grid.cell
        slon, slat = xy_to_lonlat(np.array([sx]), np.array([sy]), zone, south)
        props = {"id": f"{name}-{si}", "option": name, "start_index": si,
                 "label": label, "stats": stats, "warnings": warns,
                 "profile": prof,
                 "start_kind": "line" if is_line(si) else "point",
                 "start_lonlat": [round(float(slon[0]), 7),
                                  round(float(slat[0]), 7)]}
        if is_line(si):
            props["start_line"] = si - n_pt
            props["start_name"] = line_names[si]
            props["best"] = bool(is_best_line)
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": "LineString", "coordinates": coords}})
        say(f"  {label}")
    for si in missing:
        what = f"start line {si - n_pt + 1}" if is_line(si) else f"start {si + 1}"
        if is_line(si) and line_best.get("recommended") is not None:
            say(f"  no route from {what} (other lines have one)")
        else:
            say(f"! no route found from {what} (blocked by cliffs or outside "
                "the LiDAR)")
    with open(os.path.join(out_dir, "routes.geojson"), "w") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f)
    counts.update(routes=len(feats), corridor_cells=int(mask_final.sum())
                  if mask_final is not None else 0, settled_cells=settled,
                  starts=len(start_xy), start_lines=len(line_t),
                  unreachable_starts=len(missing))
    summary = {"cell": grid.cell, "grid_cache_key": key,
               "grid_reused": reused, "corridor_grew": corridor_grew,
               "elapsed_s": round(time.time() - t_start, 2),
               "timings": timings, "counts": counts, "params": params}
    if meta.get("dem_compare"):
        summary["dem_compare"] = meta["dem_compare"]
    with open(os.path.join(out_dir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=1)
    say(f"Done in {summary['elapsed_s']:.1f} s: {len(feats)} route(s)")
    return summary


# --------------------------------------------------------------------------
# Synthetic clouds (tests and --demo)
# --------------------------------------------------------------------------

EXAMPLE_LAT, EXAMPLE_LON = 45.1234, -100.5678


def example_origin():
    """UTM origin of the synthetic scenes (the documentation example point)."""
    e, n, zone = et().latlon_to_utm(EXAMPLE_LAT, EXAMPLE_LON)
    return math.floor(e / 100) * 100, math.floor(n / 100) * 100, zone


def synth_cloud(width, height, zfun, density=6.0, brush=(), trees=(), seed=1):
    """Points (local x, y, z, class) over [0,width] x [0,height].

    brush: (x0, y0, x1, y1, fraction) patches of returns 0.6-1.9 m up making
    that fraction of all returns; trees: (x0, y0, x1, y1, height) stands of
    crowns from 0.55 h to h, which also hide half the ground returns."""
    rng = np.random.default_rng(seed)
    n = int(width * height * density)
    gx = rng.uniform(0, width, n); gy = rng.uniform(0, height, n)
    keep = np.ones(n, bool)
    for (x0, y0, x1, y1, h) in trees:
        inside = (gx >= x0) & (gx <= x1) & (gy >= y0) & (gy <= y1)
        keep &= ~(inside & (rng.random(n) < 0.5))
    gx, gy = gx[keep], gy[keep]
    X = [gx]; Y = [gy]; Z = [zfun(gx, gy) + rng.normal(0, 0.03, len(gx))]
    K = [np.full(len(gx), 2, np.int16)]
    for (x0, y0, x1, y1, frac) in brush:
        a = (x1 - x0) * (y1 - y0)
        m = int(a * density * frac / max(1e-6, 1 - frac))
        bx = rng.uniform(x0, x1, m); by = rng.uniform(y0, y1, m)
        X.append(bx); Y.append(by)
        Z.append(zfun(bx, by) + rng.uniform(0.6, 1.9, m))
        K.append(np.full(m, 3, np.int16))
    for (x0, y0, x1, y1, h) in trees:
        a = (x1 - x0) * (y1 - y0)
        m = int(a * density * 2)
        tx = rng.uniform(x0, x1, m); ty = rng.uniform(y0, y1, m)
        X.append(tx); Y.append(ty)
        Z.append(zfun(tx, ty) + rng.uniform(0.55 * h, h, m))
        K.append(np.full(m, 5, np.int16))
    return (np.concatenate(X), np.concatenate(Y), np.concatenate(Z),
            np.concatenate(K))


def write_npz(path, xl, yl, z, cls):
    e0, n0, zone = example_origin()
    np.savez(path, x=xl + e0, y=yl + n0, z=z, classification=cls,
             epsg=np.int64(32600 + zone))
    return path


def local_lonlat(xl, yl):
    e0, n0, zone = example_origin()
    lon, lat = xy_to_lonlat(np.array([xl + e0]), np.array([yl + n0]), zone, False)
    return [float(lon[0]), float(lat[0])]


def local_bbox(x0, y0, x1, y1):
    e0, n0, _ = example_origin()
    return [e0 + x0, n0 + y0, e0 + x1, n0 + y1]


def cliff_scene_z(gap_y=170.0):
    """Gentle rise east, a 6 m step down at x = 100 for y < gap_y that
    flattens into a walkable ramp north of it."""
    def z(x, y):
        w = 0.3 + 20.0 * np.clip((y - gap_y) / 20.0, 0, 1)
        return 100.0 + 0.03 * x - 6.0 / (1.0 + np.exp(-(x - 100.0) / w))
    return z


def demo(out_dir, say=ascii_say):
    """A synthetic case with every ingredient: a cliff band with a gap, a
    brush patch, a stand of trees and a trail. Writes OUTDIR/points.npz,
    params.json and the normal outputs."""
    os.makedirs(out_dir, exist_ok=True)
    W, H = 240.0, 200.0
    zf = cliff_scene_z(170.0)
    x, y, z, c = synth_cloud(W, H, zf, density=6.0,
                             brush=[(30, 60, 80, 110, 0.6)],
                             trees=[(130, 70, 190, 110, 14.0)], seed=7)
    npz = write_npz(os.path.join(out_dir, "points.npz"), x, y, z, c)
    params = {
        "source": {"npz": npz},
        "end": local_lonlat(215, 40),
        "starts": [local_lonlat(20, 40), local_lonlat(20, 150)],
        "cell": 1.0, "dem": "both", "brush_band": [0.5, 2.0],
        "weights": dict(DEFAULT_WEIGHTS, cliff=0.0),
        "trails": {"type": "FeatureCollection", "features": [{
            "type": "Feature", "properties": {"kind": "trail", "name": "Example trail"},
            "geometry": {"type": "LineString", "coordinates": [
                local_lonlat(20, 150), local_lonlat(110, 185),
                local_lonlat(200, 120)]}}]},
        "corridor_m": 60, "presets": list(PRESETS), "units": "m",
        "area_bbox_utm": local_bbox(0, 0, W, H),
    }
    with open(os.path.join(out_dir, "params.json"), "w") as f:
        json.dump(params, f, indent=1)
    return run(params, out_dir, say=say)


# --------------------------------------------------------------------------

def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="Terrain-aware walking routes "
                                 "from LiDAR (FLEX).")
    ap.add_argument("--params", help="PARAMS.json")
    ap.add_argument("--out", help="output folder")
    ap.add_argument("--cache-dir", default=None,
                    help="shared folder of cached grid sets (one per key)")
    ap.add_argument("--points-npz", default=None,
                    help="debug: points from an npz (x, y, z, classification, "
                         "epsg) instead of params.source")
    ap.add_argument("--points-epsg", type=int, default=None,
                    help="EPSG of the npz x/y when the file has no 'epsg' "
                         "(a UTM code, 326zz or 327zz)")
    ap.add_argument("--demo", metavar="OUTDIR", default=None,
                    help="write a synthetic case to OUTDIR")
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
        run(params, a.out, cache_dir=a.cache_dir)
        return 0
    except SystemExit as e:
        if e.code not in (None, 0):
            ascii_say(f"! {e.code}")
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
        ascii_say(f"! {type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
