#!/usr/bin/env python3
"""
ground_compare.py -- the three FLEX ground models, run on the same points and
the same grid, compared against each other, against the ground returns and
(for made-up scenes) against the TRUE ground. A study tool: it changes none of
the models, it calls them as their tools do.

    python3 tools/ground_compare.py --scene all --out DIR
    python3 tools/ground_compare.py --scene cliff,pit --out DIR --html VIEW.html
    python3 tools/ground_compare.py --points-npz AREA.npz --cell 1 --out DIR \
                                    [--html VIEW.html]

The models (names as the 3D view shows them):

  routes      "Routes ground"    route_cost.py: lowest class-2 return per cell,
              nearest fill, cloth from below with an upward push
              (cloth_below). Also what veg_shapes.build_ground uses.
  export      "Export ground"    export_terrain.build_dem on the class-2
              returns (as fetch_ept_points reads them), border_nodata_mask,
              filter_spikes (10 m, 1.5 m) -- the offline map Export and
              Terrain + hillshade.
  bushwhack   "Bushwhack ground" lidar_derive.build_ground_grid (median of the
              class-2 returns per cell, else the 5th percentile of every
              return in the cell) + fill_pyramid -- Bushwhack / voids.

Report folder:
  <model>.npy               the grid (row 0 north), float32, common cell
  diff_<a>_<b>.npy          a minus b
  truth.npy                 made-up scenes only
  summary.json, summary.txt
  (with several scenes: one sub-folder per scene, plus summary.json/.txt)

Residual sign everywhere: MODEL MINUS reference (positive = model above).
numpy + scipy only (plus the FLEX modules themselves). ASCII-only output.
Exit codes: 0 done, 1 failed, 2 bad arguments.
"""

import argparse
import base64
import json
import math
import os
import sys
import time
import tracemalloc

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import lidar_derive as ld            # noqa: E402
import route_cost as rc              # noqa: E402

GROUND = 2
MODELS = ("routes", "export", "bushwhack")
LABELS = {"routes": "Routes ground", "export": "Export ground",
          "bushwhack": "Bushwhack ground", "truth": "True ground"}
SLOPE_BANDS = ((0, 10, "flat <10"), (10, 30, "10-30"), (30, 45, "30-45"),
               (45, 91, ">45"))
SCENES = ("flat", "slope", "cliff", "forest", "pit", "pit_c7", "boulders",
          "ridge", "gully", "lownoise")
SCENE_TEXT = {
    "flat": "flat ground, light grass",
    "slope": "steady 35 deg slope",
    "cliff": "15 m vertical step (south half) and 70 deg face (north half)",
    "forest": "rolling ground under 75% canopy, few ground returns below it",
    "pit": "pits 5 m wide x 8 m deep and 2 m wide x 6 m deep, floor class 2",
    "pit_c7": "the same pits, floor and lower walls labelled class 7 (noise)",
    "boulders": "boulder field (0.8-2.5 m radius), boulders counted as ground",
    "ridge": "sharp convex ridge, 40 deg flanks",
    "gully": "narrow V gully 4 m wide 3 m deep between 20 deg slopes",
    "lownoise": "partial canopy plus low noise below ground (class 7 and 1)",
}


def say(msg):
    print(str(msg).encode("ascii", "replace").decode("ascii"), flush=True)


# --------------------------------------------------------------------------
# Made-up scenes with known true ground
# --------------------------------------------------------------------------

SIZE = 200.0            # m, square
GROUND_DENSITY = 6.0    # ground returns per m2 in the open


def _smooth_noise(rng, n=64, sigma=4.0):
    from scipy import ndimage
    a = ndimage.gaussian_filter(rng.standard_normal((n, n)), sigma, mode="wrap")
    return (a - a.mean()) / (a.std() + 1e-9)


def _sample_field(field, x, y):
    n = field.shape[0]
    i = np.clip((y / SIZE * n).astype(int), 0, n - 1)
    j = np.clip((x / SIZE * n).astype(int), 0, n - 1)
    return field[i, j]


def scene_truth(name):
    """z = f(x, y) for the scene's true ground (local metres)."""
    t35, t40, t20, t70 = (math.tan(math.radians(a)) for a in (35, 40, 20, 70))
    pits = scene_pits(name)

    def base(x, y):
        return 100.0 + 0.0 * x

    if name == "flat":
        return lambda x, y: 100.0 + 0.0 * x + 0.0 * y
    if name == "slope":
        return lambda x, y: 100.0 + t35 * x + 0.0 * y
    if name == "cliff":
        w = 15.0 / t70

        def f(x, y):
            step = np.where(x >= 100.0, 15.0, 0.0)
            face = 15.0 * np.clip((x - 100.0) / w, 0.0, 1.0)
            return 100.0 + 0.05 * x + np.where(y < 100.0, step, face)
        return f
    if name in ("forest", "lownoise"):
        return lambda x, y: (100.0 + 4.0 * np.sin(x / 25.0) * np.cos(y / 30.0)
                             + 0.03 * x)
    if name in ("pit", "pit_c7"):
        def f(x, y):
            z = 100.0 + math.tan(math.radians(5)) * x + 0.0 * y
            for (cx, cy, r, d) in pits:
                rr = np.hypot(x - cx, y - cy)
                s = np.clip((r - rr) / (0.4 * r), 0.0, 1.0)
                z = z - d * s
            return z
        return f
    if name == "boulders":
        rng = np.random.default_rng(7)
        b = [(rng.uniform(15, 185), rng.uniform(15, 185), rng.uniform(0.8, 2.5))
             for _ in range(70)]

        def f(x, y):
            z = 100.0 + 0.03 * x + 0.0 * y
            top = np.zeros_like(z)
            for (cx, cy, r) in b:
                q = 1.0 - ((x - cx) ** 2 + (y - cy) ** 2) / (r * r)
                top = np.maximum(top, 0.8 * r * np.sqrt(np.clip(q, 0, 1)))
            return z + top
        return f
    if name == "ridge":
        return lambda x, y: 140.0 - t40 * np.abs(x - 100.0) + 0.0 * y
    if name == "gully":
        return lambda x, y: (100.0 + t20 * np.abs(x - 100.0)
                             - 3.0 * np.clip(1.0 - np.abs(x - 100.0) / 2.0, 0, 1)
                             + 0.0 * y)
    raise ValueError("unknown scene " + name)


def scene_pits(name):
    if name in ("pit", "pit_c7"):
        return [(70.0, 100.0, 2.5, 8.0), (140.0, 100.0, 1.0, 6.0)]
    return []


def make_scene(name, seed=1):
    """Points (x, y, z, classification) for a made-up scene, local metres."""
    rng = np.random.default_rng(seed)
    truth = scene_truth(name)
    area = SIZE * SIZE
    xs, ys, zs, cs = [], [], [], []

    def add(x, y, z, c):
        xs.append(x); ys.append(y); zs.append(z)
        cs.append(np.full(len(x), c, np.uint8) if np.isscalar(c) else c)

    n = int(area * GROUND_DENSITY)
    gx, gy = rng.uniform(0, SIZE, n), rng.uniform(0, SIZE, n)
    canopy = np.zeros(n, bool)
    if name in ("forest", "lownoise"):
        field = _smooth_noise(rng)
        thr = np.percentile(field, 25 if name == "forest" else 55)
        canopy = _sample_field(field, gx, gy) > thr
        # under canopy only ~1 in 10 pulses reaches the ground
        keep = ~canopy | (rng.random(n) < 0.10)
        gx, gy, canopy = gx[keep], gy[keep], canopy[keep]
    pits = scene_pits(name)
    if pits:
        # inside a pit fewer pulses reach the floor
        inside = np.zeros(len(gx), bool)
        for (cx, cy, r, d) in pits:
            inside |= np.hypot(gx - cx, gy - cy) < r
        keep = ~inside | (rng.random(len(gx)) < 0.5)
        gx, gy = gx[keep], gy[keep]
    gz = truth(gx, gy) + rng.normal(0, 0.03, len(gx))
    gc = np.full(len(gx), GROUND, np.uint8)
    if name in ("forest", "lownoise"):
        under = canopy[:len(gx)] if len(canopy) == len(gx) else np.zeros(len(gx), bool)
        missed = under & (rng.random(len(gx)) < 0.15)
        gc[missed] = 1                      # classifier missed some
    if name == "pit_c7":
        low = gz - truth(gx, gy) < 0
        tz = truth(gx, gy)
        base = 100.0 + math.tan(math.radians(5)) * gx
        gc[(base - tz) > 1.0] = 7           # the pit called noise
    if name == "boulders":
        # boulder tops: the classifier keeps the big ones as ground only
        flat = 100.0 + 0.03 * gx
        tall = (gz - flat) > 0.3
        gc[tall & ((gz - flat) < 1.2)] = 1
    add(gx, gy, gz, gc)

    # low vegetation everywhere (grass, brush)
    m = int(area * 0.6)
    vx, vy = rng.uniform(0, SIZE, m), rng.uniform(0, SIZE, m)
    add(vx, vy, truth(vx, vy) + rng.uniform(0.1, 0.6, m), 3)

    if name in ("forest", "lownoise"):
        field_c = canopy_field = None  # noqa: F841
        m = int(area * 8.0)
        vx, vy = rng.uniform(0, SIZE, m), rng.uniform(0, SIZE, m)
        rng2 = np.random.default_rng(seed)
        field = _smooth_noise(rng2)
        thr = np.percentile(field, 25 if name == "forest" else 55)
        inside = _sample_field(field, vx, vy) > thr
        vx, vy = vx[inside], vy[inside]
        h = rng.uniform(12, 30, len(vx))
        add(vx, vy, truth(vx, vy) + h, 5)
        k = len(vx) // 6
        add(vx[:k], vy[:k], truth(vx[:k], vy[:k]) + rng.uniform(0.5, 4, k), 3)

    if name == "lownoise":
        m = int(area * 0.05)                # ~1% of returns
        nx_, ny_ = rng.uniform(0, SIZE, m), rng.uniform(0, SIZE, m)
        dz = rng.uniform(0.3, 20.0, m)
        cls = np.where(rng.random(m) < 0.5, 7, 1).astype(np.uint8)
        add(nx_, ny_, truth(nx_, ny_) - dz, cls)
        m2 = 200                            # multipath garbage far below
        nx_, ny_ = rng.uniform(0, SIZE, m2), rng.uniform(0, SIZE, m2)
        add(nx_, ny_, truth(nx_, ny_) - 80.0, 7)

    x = np.concatenate(xs); y = np.concatenate(ys)
    z = np.concatenate(zs).astype(np.float64)
    c = np.concatenate(cs).astype(np.uint8)
    return {"x": x, "y": y, "z": z, "classification": c, "truth": truth,
            "pits": pits, "name": name}


# --------------------------------------------------------------------------
# The three models, called as their tools call them
# --------------------------------------------------------------------------

def _ground_select(z, cls):
    n_ground = int((cls == GROUND).sum()) if cls is not None else 0
    use = n_ground >= 50
    zlo, zhi = ld.plausible_ground_band(z[::max(1, len(z) // 2_000_000)],
                                        cls[::max(1, len(z) // 2_000_000)]
                                        if use else None)
    m = (z >= zlo) & (z <= zhi)
    if use:
        m &= cls == GROUND
    return m


def model_routes(P, grid):
    """route_cost.build_grids 'csf' below DEM (= veg_shapes.build_ground)."""
    m = _ground_select(P["z"], P["classification"])
    zmin = rc.bin_stat(P["x"][m], P["y"][m], P["z"][m], grid, "min")
    return rc.cloth_below(rc.nearest_fill(zmin), grid.cell), None


def model_export(P, grid, spike=1.5):
    """export_terrain: build_dem + border_nodata_mask + filter_spikes on the
    class-2 returns (fetch_ept_points reads Classification[2:2])."""
    et = rc.et()
    cls = P["classification"]
    m = cls == GROUND if (cls == GROUND).sum() >= 50 else np.ones(len(cls), bool)
    ext = (grid.minx, grid.miny, grid.maxx, grid.maxy)
    dem, _xb, _yb, _x0, _y0, valid = et.build_dem(
        P["x"][m], P["y"][m], P["z"][m], grid.cell, progress=lambda s: None,
        extent=ext, return_valid=True)
    drop = et.border_nodata_mask(valid, grid.cell, progress=lambda s: None)
    if spike > 0:
        dem = et.filter_spikes(dem, grid.cell, radius_m=10.0, threshold_m=spike,
                               progress=lambda s: None)
    out = np.ascontiguousarray(dem.T[::-1]).astype(np.float32)
    drop = np.ascontiguousarray(drop.T[::-1])
    if out.shape != grid.shape:              # rounding of the extent
        fix = np.full(grid.shape, np.nan, np.float32)
        h, w = min(out.shape[0], grid.ny), min(out.shape[1], grid.nx)
        fix[-h:, :w] = out[-h:, :w]
        out = rc.nearest_fill(fix)
        dfix = np.zeros(grid.shape, bool)
        dfix[-h:, :w] = drop[-h:, :w]
        drop = dfix
    return out, drop


def model_bushwhack(P, grid):
    """lidar_derive.derive's ground: build_ground_grid (median) + fill_pyramid."""
    g, _direct = ld.build_ground_grid(P["x"], P["y"], P["z"], P["classification"],
                                      grid, stat="median")
    return ld.fill_pyramid(g), None


RUNNERS = {"routes": model_routes, "export": model_export,
           "bushwhack": model_bushwhack}


def default_cell(model, P, area_m2):
    n_ground = int((P["classification"] == GROUND).sum())
    if model == "routes":
        return rc.auto_cell(n_ground, area_m2)
    if model == "export":
        return 0.5                           # export / terrain_generate default
    return ld.recommend_cell_size(n_ground or len(P["x"]), area_m2)


def run_model(name, P, grid, memory=True):
    t0 = time.perf_counter()
    g, drop = RUNNERS[name](P, grid)
    secs = time.perf_counter() - t0
    peak = None
    if memory:
        tracemalloc.start()
        RUNNERS[name](P, grid)
        peak = tracemalloc.get_traced_memory()[1] / 1e6
        tracemalloc.stop()
    return g.astype(np.float32), drop, secs, peak


# --------------------------------------------------------------------------
# Statistics
# --------------------------------------------------------------------------

def _r(v, n=3):
    return None if v is None or not np.isfinite(v) else round(float(v), n)


def err_stats(e):
    e = np.asarray(e, np.float64)
    e = e[np.isfinite(e)]
    if e.size == 0:
        return {"n": 0}
    p = np.percentile(e, [1, 5, 50, 95, 99])
    return {"n": int(e.size), "mean": _r(e.mean()), "median": _r(p[2]),
            "rms": _r(math.sqrt(float((e * e).mean()))),
            "mean_abs": _r(np.abs(e).mean()),
            "p1": _r(p[0]), "p5": _r(p[1]), "p95": _r(p[3]), "p99": _r(p[4]),
            "max_abs": _r(np.abs(e).max())}


def by_band(e, slope):
    out = {}
    for lo, hi, lab in SLOPE_BANDS:
        m = (slope >= lo) & (slope < hi)
        out[lab] = err_stats(e[m])
    return out


def slope_of(surface, cell):
    gx, gy = rc.gradients(surface, cell)
    return rc.slope_deg(gx, gy)


def curvature_class(surface, cell, scale_m=6.0):
    """-1 concave (hollow, gully), 0 plain, +1 convex (ridge, cliff top)."""
    from scipy import ndimage
    k = max(1, int(round(scale_m / cell)))
    sm = ndimage.uniform_filter(surface.astype(np.float64), 2 * k + 1, mode="nearest")
    d = surface - sm               # above the local mean = convex
    out = np.zeros(surface.shape, np.int8)
    out[d > 0.5] = 1
    out[d < -0.5] = -1
    return out


def cell_centres(grid):
    xc = grid.minx + (np.arange(grid.nx) + 0.5) * grid.cell
    yc = grid.maxy - (np.arange(grid.ny) + 0.5) * grid.cell
    return np.meshgrid(xc, yc)


def lowest_return(P, grid):
    return rc.bin_stat(P["x"], P["y"], P["z"], grid, "min")


def ground_density(P, grid):
    m = P["classification"] == GROUND
    f = grid.flat(P["x"][m], P["y"][m])
    return (np.bincount(f, minlength=grid.nx * grid.ny).reshape(grid.shape)
            / (grid.cell * grid.cell))


def pit_survival(g, grid, pits, truth_grid=None):
    """Depth kept at each pit: (rim level - lowest inside) / true depth."""
    X, Y = cell_centres(grid)
    out = []
    for (cx, cy, r, d) in pits:
        rr = np.hypot(X - cx, Y - cy)
        ring = (rr > r + 2) & (rr < r + 5)
        inner = rr < max(0.6 * r, 0.75 * grid.cell)
        if not inner.any():
            inner = rr <= rr.min()
        rim = float(np.median(g[ring]))
        low = float(np.min(g[inner]))
        kept = (rim - low) / d
        out.append({"width_m": round(2 * r, 1), "depth_m": d,
                    "depth_seen_m": _r(rim - low, 2), "kept": _r(kept, 2)})
    return out


def pair_diff(a, b, mask=None):
    d = (a.astype(np.float64) - b)
    if mask is not None:
        d = d[mask]
    ad = np.abs(d)
    return {"mean": _r(d.mean()), "mean_abs": _r(ad.mean()),
            "p95_abs": _r(np.percentile(ad, 95)), "max_abs": _r(ad.max()),
            "pct_over_0_5m": _r((ad > 0.5).mean() * 100, 2),
            "pct_over_2m": _r((ad > 2.0).mean() * 100, 2)}


def point_residuals(g, grid, P, max_n=4_000_000, seed=3):
    """model minus each class-2 return (bilinear model height), a sample."""
    idx = np.nonzero(P["classification"] == GROUND)[0]
    if len(idx) > max_n:
        idx = np.sort(np.random.default_rng(seed).choice(idx, max_n, replace=False))
    x, y, z = P["x"][idx], P["y"][idx], P["z"][idx]
    inside = (x >= grid.minx) & (x < grid.maxx) & (y >= grid.miny) & (y < grid.maxy)
    x, y, z = x[inside], y[inside], z[inside]
    r = ld.sample_bilinear(g, grid, x, y).astype(np.float64) - z
    return r, x, y


# --------------------------------------------------------------------------
# One comparison run
# --------------------------------------------------------------------------

def make_grid(P, cell, extent=None):
    if extent is None:
        x0 = math.floor(float(P["x"].min())); y0 = math.floor(float(P["y"].min()))
        x1 = math.ceil(float(P["x"].max())); y1 = math.ceil(float(P["y"].max()))
    else:
        x0, y0, x1, y1 = extent
    nx = max(1, int(round((x1 - x0) / cell)))
    ny = max(1, int(round((y1 - y0) / cell)))
    return ld.Grid(x0, y0, x0 + nx * cell, y0 + ny * cell, cell)


def compare(P, cell, out_dir, memory=True, defaults=True, truth=None, pits=(),
            label="", extent=None, log=say):
    os.makedirs(out_dir, exist_ok=True)
    grid = make_grid(P, cell, extent)
    area_km2 = (grid.maxx - grid.minx) * (grid.maxy - grid.miny) / 1e6
    log(f"  grid {grid.nx}x{grid.ny} @ {cell} m, {len(P['x']):,} points")
    G, rep = {}, {"label": label, "cell_m": cell, "nx": grid.nx, "ny": grid.ny,
                  "size_m": [grid.maxx - grid.minx, grid.maxy - grid.miny],
                  "points": int(len(P["x"])),
                  "ground_points": int((P["classification"] == GROUND).sum()),
                  "class7_points": int((P["classification"] == 7).sum()),
                  "models": {}}
    drops = {}
    for m in MODELS:
        g, drop, secs, peak = run_model(m, P, grid, memory)
        G[m], drops[m] = g, drop
        np.save(os.path.join(out_dir, m + ".npy"), g)
        rep["models"][m] = {"label": LABELS[m], "seconds": _r(secs, 2),
                            "peak_mb": _r(peak, 1),
                            "seconds_per_km2": _r(secs / max(area_km2, 1e-9), 1),
                            "peak_mb_per_km2": _r(peak / max(area_km2, 1e-9), 0)
                            if peak is not None else None}
        log(f"  {LABELS[m]}: {secs:.2f} s" + (f", peak {peak:.0f} MB" if peak else ""))
    valid = np.ones(grid.shape, bool)
    if drops["export"] is not None:
        valid &= ~drops["export"]
        rep["export_border_dropped_pct"] = _r(drops["export"].mean() * 100, 2)

    # reference slope / convexity: truth if known, else the median-of-ground grid
    if truth is not None:
        X, Y = cell_centres(grid)
        T = truth(X, Y).astype(np.float32)
        np.save(os.path.join(out_dir, "truth.npy"), T)
        ref = T
    else:
        from scipy import ndimage
        ref = ndimage.uniform_filter(G["bushwhack"], 3, mode="nearest")
    slope = slope_of(ref, cell)
    curv = curvature_class(ref, cell)
    dens = ground_density(P, grid)
    under = dens < 1.0
    rep["reference"] = "true ground" if truth is not None else \
        "median of class-2 returns (Bushwhack ground, 3-cell smoothed)"
    rep["slope_share_pct"] = {lab: _r(((slope >= lo) & (slope < hi)).mean() * 100, 1)
                              for lo, hi, lab in SLOPE_BANDS}
    rep["sparse_ground_pct"] = _r(under.mean() * 100, 1)

    low = lowest_return(P, grid)
    for m in MODELS:
        g, R = G[m], rep["models"][m]
        if truth is not None:
            e = (g - T)
            R["vs_truth"] = err_stats(e[valid])
            R["vs_truth_by_slope"] = by_band(e[valid], slope[valid])
            R["vs_truth_convex"] = err_stats(e[valid & (curv == 1)])
            R["vs_truth_concave"] = err_stats(e[valid & (curv == -1)])
            R["vs_truth_sparse_ground"] = err_stats(e[valid & under])
        r, px, py = point_residuals(g, grid, P)
        f = grid.flat(px, py)
        okp = valid.ravel()[f]
        R["vs_ground_returns"] = err_stats(r[okp])
        R["vs_ground_returns_by_slope"] = by_band(r[okp], slope.ravel()[f][okp])
        cf = curv.ravel()[f]
        R["vs_ground_returns_convex"] = err_stats(r[okp & (cf == 1)])
        R["vs_ground_returns_concave"] = err_stats(r[okp & (cf == -1)])
        R["vs_ground_returns_plain"] = err_stats(r[okp & (cf == 0)])
        R["vs_lowest_return"] = err_stats((g - low)[valid & np.isfinite(low)])
        R["vs_lowest_return_ground_cells"] = err_stats(
            (g - low)[valid & np.isfinite(low) & ~under])
        if pits:
            R["pits"] = pit_survival(g, grid, pits)
    if truth is not None and pits:
        rep["pits_truth"] = pit_survival(T, grid, pits)

    rep["differences"] = {}
    for i, a in enumerate(MODELS):
        for b in MODELS[i + 1:]:
            d = G[a] - G[b]
            np.save(os.path.join(out_dir, f"diff_{a}_{b}.npy"), d.astype(np.float32))
            rep["differences"][f"{a}-{b}"] = pair_diff(G[a], G[b], valid)
            rep["differences"][f"{a}-{b}"]["cliff_cells"] = \
                pair_diff(G[a], G[b], valid & (slope >= 45)) if (valid & (slope >= 45)).any() else None
            rep["differences"][f"{a}-{b}"]["convex_cells"] = \
                pair_diff(G[a], G[b], valid & (curv == 1)) if (valid & (curv == 1)).any() else None
            rep["differences"][f"{a}-{b}"]["sparse_ground_cells"] = \
                pair_diff(G[a], G[b], valid & under) if (valid & under).any() else None

    if defaults:
        rep["own_default_cell"] = {}
        area_m2 = area_km2 * 1e6
        for m in MODELS:
            c = default_cell(m, P, area_m2)
            g2 = make_grid(P, c, extent)
            g, drop, secs, peak = run_model(m, P, g2, memory)
            ok = np.ones(g2.shape, bool) if drop is None else ~drop
            r, px, py = point_residuals(g, g2, P)
            okp = ok.ravel()[g2.flat(px, py)]
            D = {"cell_m": c, "seconds": _r(secs, 2), "peak_mb": _r(peak, 1),
                 "vs_ground_returns": err_stats(r[okp])}
            if truth is not None:
                X2, Y2 = cell_centres(g2)
                D["vs_truth"] = err_stats((g - truth(X2, Y2))[ok])
                if pits:
                    D["pits"] = pit_survival(g, g2, pits)
            rep["own_default_cell"][m] = D
            log(f"  {LABELS[m]} at its own {c} m: {secs:.2f} s")

    with open(os.path.join(out_dir, "summary.json"), "w") as fh:
        json.dump(rep, fh, indent=1)
    with open(os.path.join(out_dir, "summary.txt"), "w") as fh:
        fh.write(text_summary(rep))
    return rep, G, grid, valid


def _fmt(s, k="mean"):
    v = s.get(k) if s else None
    return "   n/a" if v is None else f"{v:+6.2f}"


def text_summary(rep):
    L = [f"Ground comparison: {rep.get('label', '')}",
         f"cell {rep['cell_m']} m, grid {rep['nx']}x{rep['ny']}, "
         f"{rep['points']:,} points ({rep['ground_points']:,} class 2, "
         f"{rep['class7_points']:,} class 7)",
         "Residuals are MODEL MINUS reference, metres (+ = model above).", ""]
    has_truth = "vs_truth" in rep["models"]["routes"]
    hdr = "model              time s  peak MB"
    L.append(hdr)
    for m in MODELS:
        R = rep["models"][m]
        pk = "   n/a" if R["peak_mb"] is None else f"{R['peak_mb']:7.0f}"
        L.append(f"{LABELS[m]:<18} {R['seconds']:6.2f}  {pk}")
    L.append("")
    blocks = [("vs_truth", "Against the TRUE ground")] if has_truth else []
    blocks += [("vs_ground_returns", "Against the class-2 ground returns"),
               ("vs_lowest_return", "Against the lowest return per cell")]
    for key, title in blocks:
        L.append(title + ":   mean  median     rms     p5     p95")
        for m in MODELS:
            s = rep["models"][m][key]
            L.append(f"  {LABELS[m]:<18} {_fmt(s)} {_fmt(s, 'median')} "
                     f"{_fmt(s, 'rms')} {_fmt(s, 'p5')} {_fmt(s, 'p95')}")
        L.append("")
    bk = "vs_truth_by_slope" if has_truth else "vs_ground_returns_by_slope"
    L.append(("By slope (vs truth" if has_truth else "By slope (vs ground returns")
             + "), mean / rms:")
    L.append("  " + " " * 18 + "".join(f"{lab:>16}" for _, _, lab in SLOPE_BANDS))
    for m in MODELS:
        row = rep["models"][m][bk]
        L.append(f"  {LABELS[m]:<18}" + "".join(
            f"{_fmt(row[lab]):>8}/{_fmt(row[lab], 'rms').strip():>7}"
            for _, _, lab in SLOPE_BANDS))
    L.append("")
    ck = "vs_truth" if has_truth else "vs_ground_returns"
    L.append("Convex / concave ground (mean):")
    for m in MODELS:
        R = rep["models"][m]
        L.append(f"  {LABELS[m]:<18} convex {_fmt(R.get(ck + '_convex'))}  "
                 f"concave {_fmt(R.get(ck + '_concave'))}")
    L.append("")
    if "pits" in rep["models"]["routes"]:
        L.append("Pits, share of the depth kept (1.00 = all of it):")
        for m in MODELS:
            L.append(f"  {LABELS[m]:<18} " + "  ".join(
                f"{p['width_m']} m wide: {p['kept']:.2f}" for p in rep["models"][m]["pits"]))
        L.append("")
    L.append("Differences between models (a minus b): mean, mean |d|, p95 |d|, % > 0.5 m")
    for k, d in rep["differences"].items():
        a, b = k.split("-")
        L.append(f"  {LABELS[a]} - {LABELS[b]}: {d['mean']:+.2f}  {d['mean_abs']:.2f}  "
                 f"{d['p95_abs']:.2f}  {d['pct_over_0_5m']:.1f}%")
    if "own_default_cell" in rep:
        L.append("")
        L.append("Each at its own default cell:")
        for m in MODELS:
            D = rep["own_default_cell"][m]
            t = D.get("vs_truth") or D["vs_ground_returns"]
            L.append(f"  {LABELS[m]:<18} {D['cell_m']} m  {D['seconds']:.2f} s  "
                     f"{'truth' if 'vs_truth' in D else 'returns'} mean {_fmt(t)} rms {_fmt(t, 'rms')}")
    return "\n".join(L) + "\n"


# --------------------------------------------------------------------------
# The 3D view (one self-contained HTML file)
# --------------------------------------------------------------------------

def _b64(a):
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode("ascii")


def _down(a, k):
    if k == 1:
        return a
    ny, nx = a.shape[0] // k, a.shape[1] // k
    return a[:ny * k, :nx * k].reshape(ny, k, nx, k).mean(axis=(1, 3))


def find_spots(G, grid, P, valid, slope, curv, dens):
    """Telling places, local metres from the south-west corner."""
    spots = []
    from scipy import ndimage
    dre = np.abs(G["routes"] - G["export"])
    drb = np.abs(G["routes"] - G["bushwhack"])
    dall = np.maximum(dre, np.maximum(drb, np.abs(G["export"] - G["bushwhack"])))
    dall = ndimage.uniform_filter(np.where(valid, dall, 0), 5)
    edge = max(3, int(20 / grid.cell))
    inner = np.zeros(grid.shape, bool)
    inner[edge:-edge, edge:-edge] = True

    def pick(mask, why, used):
        s = np.where(mask & inner, dall, -1)
        for (r0, c0) in used:
            s[max(0, r0 - 40):r0 + 40, max(0, c0 - 40):c0 + 40] = -1
        r, c = np.unravel_index(int(np.argmax(s)), s.shape)
        if s[r, c] <= 0:
            return None
        used.append((r, c))
        x = (c + 0.5) * grid.cell
        y = (grid.ny - r - 0.5) * grid.cell
        return {"label": why, "x": round(x, 1), "y": round(y, 1),
                "spread": round(float(dall[r, c]), 2)}

    used = []
    for mask, why in ((slope >= 45, "Cliff"), (curv == 1, "Convex ridge"),
                      (dens < 0.5, "Dense canopy"), (np.ones_like(valid), "Largest spread")):
        s = pick(mask, why, used)
        if s:
            spots.append(s)
    # pit-like: a local hollow in the lowest returns that a model fills
    low = lowest_return(P, grid)
    lowf = rc.nearest_fill(low)
    hollow = ndimage.minimum_filter(lowf, 3) < ndimage.median_filter(lowf, 15) - 2.0
    filled = (np.maximum(G["routes"], G["export"]) - lowf) > 1.5
    s = pick(hollow & filled & (dens >= 0.5), "Pit-like hollow", used)
    if s:
        spots.append(s)
    return spots


def view_dataset(name, label, G, grid, P, valid, truth=None, view_cell=2.0,
                 max_pts=500_000, summary_lines=(), spots=None):
    k = max(1, int(round(view_cell / grid.cell)))
    models = {m: G[m] for m in MODELS}
    if truth is not None:
        X, Y = cell_centres(grid)
        models["truth"] = truth(X, Y).astype(np.float32)
    lo = min(float(np.nanmin(v)) for v in models.values())
    hi = max(float(np.nanmax(v)) for v in models.values())
    scale = max((hi - lo) / 65000.0, 0.001)
    out = {"name": name, "label": label, "cell": grid.cell * k,
           "fine_cell": grid.cell, "zmin": lo, "zscale": scale, "models": {},
           "resid": {}, "summary": list(summary_lines)}
    # residual vs ground returns per view cell
    ri = np.nonzero(P["classification"] == GROUND)[0]
    if len(ri) > 3_000_000:
        ri = np.random.default_rng(5).choice(ri, 3_000_000, replace=False)
    gx, gy, gz = P["x"][ri], P["y"][ri], P["z"][ri]
    vgrid = ld.Grid(grid.minx, grid.miny, grid.minx + (grid.nx // k) * k * grid.cell,
                    grid.miny + (grid.ny // k) * k * grid.cell, grid.cell * k)
    inside = (gx >= vgrid.minx) & (gx < vgrid.maxx) & (gy >= vgrid.miny) & (gy < vgrid.maxy)
    # rows of the fine grid are counted from the north: keep the south-aligned
    # part so view cells line up with fine cells
    off = grid.ny - (grid.ny // k) * k
    for m, a in models.items():
        v = _down(a[off:, :], k).astype(np.float64)
        out["models"][m] = _b64(np.clip(np.round((v - lo) / scale), 0, 65535).astype(np.uint16))
        f = vgrid.flat(gx[inside], gy[inside])
        r = ld.sample_bilinear(a, grid, gx[inside], gy[inside]) - gz[inside]
        n = np.bincount(f, minlength=vgrid.nx * vgrid.ny)
        s = np.bincount(f, weights=r, minlength=vgrid.nx * vgrid.ny)
        mean = np.where(n > 0, s / np.maximum(n, 1), np.nan)
        q = np.where(np.isfinite(mean), np.clip(np.round(mean / 0.05), -127, 127), -128)
        out["resid"][m] = _b64(q.astype(np.int8))
    out["nx"], out["ny"] = vgrid.nx, vgrid.ny
    # thinned ground returns, local metres (x, y at 2 cm, z on the model scale)
    pi = np.nonzero(inside)[0]
    if len(pi) > max_pts:
        pi = np.random.default_rng(6).choice(pi, max_pts, replace=False)
    px = np.clip(np.round((gx[pi] - vgrid.minx) / 0.02), 0, 65535).astype(np.uint16)
    py = np.clip(np.round((gy[pi] - vgrid.miny) / 0.02), 0, 65535).astype(np.uint16)
    pz = np.clip(np.round((gz[pi] - lo) / scale), 0, 65535).astype(np.uint16)
    out["pts"] = _b64(np.stack([px, py, pz], 1).ravel())
    out["spots"] = spots or []
    return out


def write_html(datasets, path, three_dir=None):
    three_dir = three_dir or os.path.join(ROOT, "viewer_build", "libs")
    with open(os.path.join(three_dir, "three.min.js")) as fh:
        three = fh.read()
    with open(os.path.join(three_dir, "OrbitControls.js")) as fh:
        orbit = fh.read()
    with open(os.path.join(HERE, "ground_compare_view.html")) as fh:
        page = fh.read()
    data = json.dumps({"datasets": datasets}, separators=(",", ":"))
    page = page.replace("/*THREE_JS*/", three.replace("</script", "<\\/script"))
    page = page.replace("/*ORBIT_JS*/", orbit.replace("</script", "<\\/script"))
    page = page.replace("\"__DATA__\"", data)
    with open(path, "w") as fh:
        fh.write(page)
    return path


def headline(rep):
    """A few plain-words lines for the view's summary panel."""
    L = []
    has_truth = "vs_truth" in rep["models"]["routes"]
    key = "vs_truth" if has_truth else "vs_ground_returns"
    what = "the true ground" if has_truth else "the ground returns"
    for m in MODELS:
        s = rep["models"][m][key]
        L.append(f"{LABELS[m]}: on average {abs(s['mean']):.2f} m "
                 f"{'above' if s['mean'] > 0 else 'below'} {what} "
                 f"(typical miss {s['rms']:.2f} m).")
    bk = "vs_truth_by_slope" if has_truth else "vs_ground_returns_by_slope"
    for m in MODELS:
        b = rep["models"][m][bk].get(">45", {})
        if b.get("n"):
            L.append(f"On cliffs (over 45 deg) {LABELS[m]} is {abs(b['mean']):.2f} m "
                     f"{'above' if b['mean'] > 0 else 'below'} on average.")
    if "pits" in rep["models"]["routes"]:
        for m in MODELS:
            L.append(f"{LABELS[m]} keeps " + ", ".join(
                f"{int(round(p['kept'] * 100))}% of the {p['width_m']:g} m pit"
                for p in rep["models"][m]["pits"]) + ".")
    for m in MODELS:
        R = rep["models"][m]
        L.append(f"{LABELS[m]} took {R['seconds']:.1f} s"
                 + (f" and {R['peak_mb']:.0f} MB." if R["peak_mb"] else "."))
    return L


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def load_npz(path):
    d = np.load(path)
    for k in ("x", "y", "z", "classification"):
        if k not in d:
            raise ValueError(f"{path}: missing key {k}")
    return {"x": np.asarray(d["x"], np.float64), "y": np.asarray(d["y"], np.float64),
            "z": np.asarray(d["z"], np.float64),
            "classification": np.asarray(d["classification"], np.uint8)}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Compare the three FLEX ground models.")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--scene", help="made-up scene(s): " + ", ".join(SCENES)
                     + " (comma list or all)")
    src.add_argument("--points-npz", help="npz with x, y, z, classification (UTM m)")
    ap.add_argument("--out", required=True, help="report folder")
    ap.add_argument("--cell", type=float, default=1.0, help="common cell, m (1)")
    ap.add_argument("--no-defaults", action="store_true",
                    help="skip the runs at each model's own default cell")
    ap.add_argument("--no-mem", action="store_true", help="skip peak-memory runs")
    ap.add_argument("--html", help="also write the 3D view here")
    ap.add_argument("--view-cell", type=float, default=2.0, help="3D view cell, m (2)")
    ap.add_argument("--three-dir", help="folder with three.min.js and OrbitControls.js")
    try:
        a = ap.parse_args(argv)
    except SystemExit as e:
        return 2 if e.code else 0
    if a.cell <= 0 or a.cell > 20:
        say("ERROR: --cell must be in (0, 20]")
        return 2
    try:
        datasets = []
        if a.scene:
            names = list(SCENES) if a.scene == "all" else a.scene.split(",")
            bad = [n for n in names if n not in SCENES]
            if bad:
                say("ERROR: unknown scene(s): " + ", ".join(bad))
                return 2
            allrep = {}
            for n in names:
                say(f"Scene {n}: {SCENE_TEXT[n]}")
                S = make_scene(n)
                rep, G, grid, valid = compare(
                    S, a.cell, os.path.join(a.out, n) if len(names) > 1 else a.out,
                    memory=not a.no_mem, defaults=not a.no_defaults,
                    truth=S["truth"], pits=S["pits"], label=f"{n}: {SCENE_TEXT[n]}",
                    extent=(0.0, 0.0, SIZE, SIZE))
                allrep[n] = rep
                if a.html:
                    datasets.append(view_dataset(
                        n, SCENE_TEXT[n], G, grid, S, valid, truth=S["truth"],
                        view_cell=min(a.view_cell, 1.0), summary_lines=headline(rep),
                        spots=scene_spots(n)))
            if len(names) > 1:
                with open(os.path.join(a.out, "summary.json"), "w") as fh:
                    json.dump(allrep, fh, indent=1)
                with open(os.path.join(a.out, "summary.txt"), "w") as fh:
                    fh.write(scenes_table(allrep))
                say(scenes_table(allrep))
            else:
                say(text_summary(allrep[names[0]]))
        else:
            say("Reading points")
            P = load_npz(a.points_npz)
            rep, G, grid, valid = compare(P, a.cell, a.out, memory=not a.no_mem,
                                          defaults=not a.no_defaults, label="points file")
            say(text_summary(rep))
            if a.html:
                ref = G["bushwhack"]
                spots = find_spots(G, grid, P, valid, slope_of(ref, grid.cell),
                                   curvature_class(ref, grid.cell),
                                   ground_density(P, grid))
                datasets.append(view_dataset("area", "The test area", G, grid, P,
                                             valid, view_cell=a.view_cell,
                                             summary_lines=headline(rep), spots=spots))
        if a.html:
            write_html(datasets, a.html, a.three_dir)
            say("3D view: " + a.html)
        return 0
    except Exception as e:                       # noqa: BLE001
        say(f"ERROR: {type(e).__name__}: {e}")
        return 1


def scene_spots(n):
    return {"cliff": [{"label": "Vertical step", "x": 100, "y": 50},
                      {"label": "70 deg face", "x": 100, "y": 150}],
            "pit": [{"label": "5 m pit", "x": 70, "y": 100},
                    {"label": "2 m pit", "x": 140, "y": 100}],
            "pit_c7": [{"label": "5 m pit", "x": 70, "y": 100},
                       {"label": "2 m pit", "x": 140, "y": 100}],
            "ridge": [{"label": "Ridge crest", "x": 100, "y": 100}],
            "gully": [{"label": "Gully", "x": 100, "y": 100}],
            }.get(n, [{"label": "Centre", "x": 100, "y": 100}])


def scenes_table(allrep):
    L = ["Made-up scenes, error against the TRUE ground (model minus truth, m)",
         "scene      model               mean   median    rms    p95|e|  >45deg mean",
         ]
    for n, rep in allrep.items():
        for m in MODELS:
            s = rep["models"][m]["vs_truth"]
            b = rep["models"][m]["vs_truth_by_slope"][">45"]
            L.append(f"{n:<10} {LABELS[m]:<18} {s['mean']:+6.2f}  {s['median']:+6.2f}  "
                     f"{s['rms']:6.2f}  {max(abs(s['p5']), abs(s['p95'])):6.2f}   "
                     f"{_fmt(b)}")
        if "pits" in rep["models"]["routes"]:
            for m in MODELS:
                L.append(f"{'':<10} {LABELS[m]:<18} pit depth kept: " + ", ".join(
                    f"{p['width_m']:g} m: {p['kept']:.2f}" for p in rep["models"][m]["pits"]))
    L.append("")
    L.append("Time and peak memory at the common cell (s / MB):")
    for n, rep in allrep.items():
        L.append(f"{n:<10} " + "  ".join(
            f"{LABELS[m].split()[0]} {rep['models'][m]['seconds']:.2f}/"
            f"{(rep['models'][m]['peak_mb'] or 0):.0f}" for m in MODELS))
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    sys.exit(main())
