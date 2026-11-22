#!/usr/bin/env python3
"""
area_ground.py -- the one shared ground of an analysed area (FLEX).

    python area_ground.py --params P.json --area-dir DIR [--points-npz FILE]
    python area_ground.py --demo DIR              (made-up scene, no PDAL)

params: { source: {ept, ept_also} | {npz}, area: [[lon, lat], ...] ring,
          cell: "auto" | metres, keep_points: true, points_cap_mb: 3072 }

The area's points are read once (route_cost.read_points). Outputs:

    DIR/ground/ground.npy    float32 ny x nx, row 0 = SOUTH
    DIR/ground/grid.json     { x0, y0, cell, nx, ny, zone, south, epsg,
                               bbox_utm, version, row0: "south" }
    DIR/ground/direct.npy    uint8, 1 = cell got class-2 returns
    DIR/ground/pits.geojson  possible pits (points), see below
    DIR/ground/summary.json  ring, cell, coverage, counts, notes, timings
    DIR/ground/coverage.png  where the ring got returns (grey = none)
    DIR/points/              optional cache of the points (below)

Ground, in plain words: per cell the MEDIAN of the class-2 returns where the
cell has any (only returns inside a generous plausible z band vote); cells
without class 2 are filled by route_cost.cloth_below run on the nearest-filled
medians (a cloth rising from below, so it never sits on canopy). No
all-returns fallback: that puts the ground on the canopy.

Possible pits: returns of ANY class (7 included) more than PIT_DEPTH below
the ground (bilinear) and also below the lowest ground of the 3 x 3 cells
around (so the foot of a cliff is not a pit), down to PIT_FLOOR. Cells with
such returns are joined into 8-connected clusters; a cluster is kept when it
has >= PIT_MIN_POINTS returns over >= 2 cells, spans <= PIT_MAX_SPAN m, and
those returns are >= PIT_MIN_SHARE of the returns near ground level in its
cells. A lone deep return is multipath and is left out. The ground is not
changed by pits.

The points cache (DIR/points/): route_cost.Points' compact store written as
plain .npy files -- xl.npy, yl.npy (float32 offsets from ox, oy), z.npy
(float32), cls.npy (uint8), points.json {ox, oy, n, bbox_utm, zone, south,
epsg, source, bytes}: 13 bytes a point, opened memory-mapped so a tool starts
at once and walks it in chunks. Written only when keep_points and the size is
under the cap (params.points_cap_mb, env FLEX_AREA_POINTS_CAP_MB, default
3072 MB); otherwise left out with a NOTE-free progress line.

Other tools (veg_shapes.py, lidar_derive.py) take --area-dir DIR and use
load_ground() / load_points() from here.
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

import lidar_derive as ld
import route_cost as rc

VERSION = 1
GROUND_CLASS = 2
PIT_DEPTH = 1.0          # m below the ground
PIT_LOCAL_MARGIN = 0.5   # m below the lowest ground of the 3 x 3 cells around
PIT_FLOOR = -60.0        # deeper than this is garbage
PIT_MIN_POINTS = 4
PIT_MIN_CELLS = 2
PIT_MAX_SPAN = 40.0      # m
PIT_MIN_SHARE = 0.3
NEAR_GROUND = 2.0        # |HAG| under this = a return near ground level
DEFAULT_CAP_MB = 3072

say_default = rc.ascii_say


# --------------------------------------------------------------------------
# Ground
# --------------------------------------------------------------------------

def cell_median(f, z, ncell):
    """Median per flat cell index (NaN where none) and the counts."""
    out = np.full(ncell, np.nan)
    cnt = np.bincount(f, minlength=ncell)
    if len(f):
        order = np.lexsort((z, f))
        zs = z[order]
        starts = np.concatenate([[0], np.cumsum(cnt)[:-1]])
        hit = cnt > 0
        out[hit] = zs[starts[hit] + cnt[hit] // 2]
    return out, cnt


def ground_from_points(P, grid, say=say_default):
    """(ground north-up float32, direct bool) on an ld.Grid."""
    ncell = grid.nx * grid.ny
    n_ground = int((P.cls == GROUND_CLASS).sum()) if P.cls is not None else 0
    if n_ground < 50:
        raise RuntimeError("the points have (almost) no ground class (2)")
    sub = slice(None, None, max(1, len(P) // 2_000_000))
    zlo, zhi = ld.plausible_ground_band(P.z[sub].astype(np.float64),
                                        P.cls[sub])
    fs, zs = [], []
    for x, y, z, _c in P.chunks(lambda c, z: (c == GROUND_CLASS) &
                                (z >= zlo) & (z <= zhi)):
        fs.append(grid.flat(x, y)); zs.append(z)
    f = np.concatenate(fs) if fs else np.zeros(0, np.int64)
    z = np.concatenate(zs) if zs else np.zeros(0)
    del fs, zs
    med, cnt = cell_median(f, z, ncell)
    del f, z
    med = med.reshape(grid.shape)
    direct = np.isfinite(med)
    if not direct.any():
        raise RuntimeError("no ground points inside the area")
    if direct.all():
        return med.astype(np.float32), direct
    cloth = rc.cloth_below(rc.nearest_fill(med), grid.cell)
    g = np.where(direct, med, cloth).astype(np.float32)
    return g, direct


# --------------------------------------------------------------------------
# One pass over every return: coverage counts and possible pits
# --------------------------------------------------------------------------

def scan_returns(P, grid, ground, say=say_default):
    from scipy import ndimage
    ncell = grid.nx * grid.ny
    gmin = ndimage.minimum_filter(ground, size=3, mode="nearest")
    tot = np.zeros(ncell, np.int64)
    near = np.zeros(ncell, np.int64)
    below_f, below_h, below_c, below_x, below_y = [], [], [], [], []
    for x, y, z, c in P.chunks():
        f = grid.flat(x, y)
        tot += np.bincount(f, minlength=ncell)
        hag = z - ld.sample_bilinear(ground, grid, x, y)
        near += np.bincount(f[np.abs(hag) < NEAR_GROUND], minlength=ncell)
        b = (hag < -PIT_DEPTH) & (hag > PIT_FLOOR)
        if b.any():
            b[b] &= z[b] < gmin.ravel()[f[b]] - PIT_LOCAL_MARGIN
        if b.any():
            below_f.append(f[b]); below_h.append(hag[b])
            below_c.append(c[b] if c is not None else np.zeros(int(b.sum()), np.uint8))
            below_x.append(x[b]); below_y.append(y[b])
    cat = (lambda L, dt: np.concatenate(L) if L else np.zeros(0, dt))
    B = dict(f=cat(below_f, np.int64), h=cat(below_h, float),
             c=cat(below_c, np.uint8), x=cat(below_x, float),
             y=cat(below_y, float))
    return tot.reshape(grid.shape), near.reshape(grid.shape), B


def find_pits(B, near, grid, zone, south):
    from scipy import ndimage
    ncell = grid.nx * grid.ny
    if not len(B["f"]):
        return [], 0
    cnt = np.bincount(B["f"], minlength=ncell).reshape(grid.shape)
    lab, n = ndimage.label(cnt > 0, structure=np.ones((3, 3), bool))
    if not n:
        return [], 0
    pl = lab.ravel()[B["f"]]                    # cluster of each return
    pits, dropped = [], 0
    order = np.argsort(pl, kind="stable")
    pl_s = pl[order]
    bounds = np.searchsorted(pl_s, np.arange(1, n + 2))
    cells_per = np.bincount(lab.ravel(), minlength=n + 1)
    near_per = np.bincount(lab.ravel(), weights=near.ravel(), minlength=n + 1)
    for k in range(1, n + 1):
        idx = order[bounds[k - 1]:bounds[k]]
        m = len(idx)
        if m < PIT_MIN_POINTS or cells_per[k] < PIT_MIN_CELLS:
            dropped += 1
            continue
        xs, ys = B["x"][idx], B["y"][idx]
        span = max(xs.max() - xs.min(), ys.max() - ys.min())
        if span > PIT_MAX_SPAN:
            dropped += 1
            continue
        share = m / float(m + near_per[k])
        if share < PIT_MIN_SHARE:
            dropped += 1
            continue
        hs, cs = B["h"][idx], B["c"][idx]
        j = int(np.argmin(hs))
        lon, lat = rc.xy_to_lonlat(np.array([xs.mean()]), np.array([ys.mean()]),
                                   zone, south)
        u, uc = np.unique(cs, return_counts=True)
        pits.append({"type": "Feature",
                     "geometry": {"type": "Point", "coordinates":
                                  [round(float(lon[0]), 8), round(float(lat[0]), 8)]},
                     "properties": {
                         "depth": round(float(-hs[j]), 2),
                         "depth_median": round(float(-np.median(hs)), 2),
                         "count": int(m), "cells": int(cells_per[k]),
                         "span_m": round(float(span), 1),
                         "share": round(float(share), 2),
                         "classes": {str(int(a)): round(float(b) / m, 3)
                                     for a, b in zip(u, uc)},
                         "utm": [round(float(xs.mean()), 2),
                                 round(float(ys.mean()), 2)]}})
    pits.sort(key=lambda p: -p["properties"]["depth"])
    for i, p in enumerate(pits):
        p["properties"]["id"] = i + 1
    return pits, dropped


# --------------------------------------------------------------------------
# Reading back (for the other tools)
# --------------------------------------------------------------------------

def load_ground(area_dir):
    """(ground north-up float32, ld.Grid, grid.json meta) or None."""
    d = os.path.join(area_dir, "ground")
    p = os.path.join(d, "grid.json")
    if not (os.path.exists(p) and os.path.exists(os.path.join(d, "ground.npy"))):
        return None
    with open(p) as f:
        m = json.load(f)
    g = np.load(os.path.join(d, "ground.npy"))
    grid = ld.Grid(m["x0"], m["y0"], m["x0"] + m["nx"] * m["cell"],
                   m["y0"] + m["ny"] * m["cell"], m["cell"])
    assert grid.shape == g.shape
    return np.ascontiguousarray(g[::-1]), grid, m


def area_ring(area_dir):
    """The area's lon/lat ring: area.json (the store's) or ground/summary.json."""
    for p in (os.path.join(area_dir, "area.json"),
              os.path.join(area_dir, "ground", "summary.json")):
        try:
            with open(p) as f:
                r = json.load(f).get("ring")
            if r and len(r) >= 3:
                return r
        except Exception:
            pass
    return None


def ground_crop(area_dir, bbox, pad_cells=2):
    """(ground north-up, ld.Grid) of the area ground cut to the cells over
    bbox (UTM e0, n0, e1, n1) plus a small pad; None when there is no area
    ground or it does not cover bbox."""
    G = load_ground(area_dir)
    if G is None:
        return None
    g, ag, _m = G
    tol = ag.cell
    if (bbox[0] < ag.minx - tol or bbox[1] < ag.miny - tol or
            bbox[2] > ag.maxx + tol or bbox[3] > ag.maxy + tol):
        return None
    c0 = max(0, int(math.floor((bbox[0] - ag.minx) / ag.cell)) - pad_cells)
    c1 = min(ag.nx, int(math.ceil((bbox[2] - ag.minx) / ag.cell)) + pad_cells)
    r0 = max(0, int(math.floor((ag.maxy - bbox[3]) / ag.cell)) - pad_cells)
    r1 = min(ag.ny, int(math.ceil((ag.maxy - bbox[1]) / ag.cell)) + pad_cells)
    grid = ld.Grid(ag.minx + c0 * ag.cell, ag.maxy - r1 * ag.cell,
                   ag.minx + c1 * ag.cell, ag.maxy - r0 * ag.cell, ag.cell)
    sub = np.ascontiguousarray(g[r0:r1, c0:c1])
    assert sub.shape == grid.shape
    return sub, grid


def ground_on(area_dir, grid):
    """The area ground sampled (bilinear) at the cell centres of another
    ld.Grid, north-up; None when there is no area ground."""
    G = load_ground(area_dir)
    if G is None:
        return None
    g, ag, _m = G
    if (abs(ag.minx - grid.minx) < 1e-6 and abs(ag.maxy - grid.maxy) < 1e-6
            and ag.cell == grid.cell and ag.shape == grid.shape):
        return g
    cx = grid.minx + (np.arange(grid.nx) + 0.5) * grid.cell
    cy = grid.maxy - (np.arange(grid.ny) + 0.5) * grid.cell
    X, Y = np.meshgrid(cx, cy)
    return ld.sample_bilinear(g, ag, X.ravel(), Y.ravel()).reshape(
        grid.shape).astype(np.float32)


def load_points(area_dir, bbox=None):
    """A route_cost.Points from DIR/points (memory-mapped), cropped to bbox
    (UTM e0, n0, e1, n1) when that is smaller than the cached box; None when
    there is no cache."""
    d = os.path.join(area_dir, "points")
    mp = os.path.join(d, "points.json")
    if not os.path.exists(mp):
        return None
    with open(mp) as f:
        m = json.load(f)
    try:
        arrs = {k: np.load(os.path.join(d, k + ".npy"), mmap_mode="r")
                for k in ("xl", "yl", "z", "cls")}
    except Exception:
        return None
    P = rc.Points(m["ox"], m["oy"])
    P.parts = None
    P.xl, P.yl, P.z, P.cls = arrs["xl"], arrs["yl"], arrs["z"], arrs["cls"]
    cb = m["bbox_utm"]
    if bbox is None or (bbox[0] <= cb[0] and bbox[1] <= cb[1] and
                        bbox[2] >= cb[2] and bbox[3] >= cb[3]):
        return P
    Q = rc.Points(m["ox"], m["oy"])
    for x, y, z, c in P.chunks(None):
        k = (x >= bbox[0]) & (x <= bbox[2]) & (y >= bbox[1]) & (y <= bbox[3])
        if k.any():
            Q.add(x[k], y[k], z[k], c[k])
    return Q.finish()


def points_meta(area_dir):
    try:
        with open(os.path.join(area_dir, "points", "points.json")) as f:
            return json.load(f)
    except Exception:
        return None


def save_points(P, d, meta):
    import shutil
    tmp = d + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    np.save(os.path.join(tmp, "xl.npy"), np.asarray(P.xl, np.float32))
    np.save(os.path.join(tmp, "yl.npy"), np.asarray(P.yl, np.float32))
    np.save(os.path.join(tmp, "z.npy"), np.asarray(P.z, np.float32))
    cls = P.cls if P.cls is not None else np.ones(len(P), np.uint8)
    np.save(os.path.join(tmp, "cls.npy"), np.asarray(cls, np.uint8))
    with open(os.path.join(tmp, "points.json"), "w") as f:
        json.dump(meta, f, indent=1)
    shutil.rmtree(d, ignore_errors=True)
    os.rename(tmp, d)


# --------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------

def polygon_mask(ring_xy, grid):
    import veg_shapes
    return veg_shapes.polygon_mask(ring_xy, grid)


def run(params, area_dir, say=say_default):
    t_start = time.time()
    timings = {}
    src = dict(params.get("source") or {})
    ring_ll = params.get("area")
    cell_spec = params.get("cell", "auto")
    notes = []
    if ring_ll is not None and (not isinstance(ring_ll, list) or len(ring_ll) < 3):
        raise RuntimeError("area must be a ring of at least 3 [lon, lat]")

    npz_ext = None
    if "npz" in src:
        nz = np.load(src["npz"], mmap_mode="r")
        epsg = int(src.get("epsg") or (nz["epsg"] if "epsg" in nz.files else 0))
        if not (32601 <= epsg <= 32660 or 32701 <= epsg <= 32760):
            raise RuntimeError("the npz needs UTM x/y: give its EPSG "
                               "(326zz / 327zz) as source.epsg or --points-epsg")
        zone, south = epsg % 100, epsg >= 32700
        x = nz["x"]; y = nz["y"]
        npz_ext = (float(x.min()), float(y.min()), float(x.max()), float(y.max()))
        del x, y, nz
    elif "ept" in src or "las" in src:
        if ring_ll is None:
            raise RuntimeError("params need 'area' (a lon/lat ring)")
        lon_c = sum(p[0] for p in ring_ll) / len(ring_ll)
        lat_c = sum(p[1] for p in ring_ll) / len(ring_ll)
        zone = rc.et().utm_zone_for(lon_c)
        south = lat_c < 0
    else:
        raise RuntimeError("params.source needs 'ept', 'las' or 'npz'")
    epsg = (32700 if south else 32600) + zone

    if ring_ll is None:
        e0, n0, e1, n1 = npz_ext
        ring_xy = [(e0, n0), (e1, n0), (e1, n1), (e0, n1), (e0, n0)]
        lon, lat = rc.xy_to_lonlat(np.array([p[0] for p in ring_xy]),
                                   np.array([p[1] for p in ring_xy]), zone, south)
        ring_ll = [[round(float(a), 8), round(float(b), 8)]
                   for a, b in zip(lon, lat)]
    else:
        ring_xy = [rc.lonlat_to_xy(p[0], p[1], zone) for p in ring_ll]
    bbox = (min(p[0] for p in ring_xy), min(p[1] for p in ring_xy),
            max(p[0] for p in ring_xy), max(p[1] for p in ring_xy))
    import veg_shapes
    area_m2 = veg_shapes.ring_area(ring_xy)
    if area_m2 < 100:
        raise RuntimeError("the area is too small (under 100 m2)")

    say(f"[1/4] Reading points (UTM zone {zone}{'S' if south else 'N'}, "
        f"{bbox[2] - bbox[0]:.0f} x {bbox[3] - bbox[1]:.0f} m)")
    t0 = time.time()
    P = rc.read_points(src, bbox, zone, south, say)
    timings["read_s"] = round(time.time() - t0, 2)

    say("[2/4] Ground (median of class 2, cloth below fills the rest)")
    t0 = time.time()
    n_ground = int((P.cls == GROUND_CLASS).sum()) if P.cls is not None else 0
    if cell_spec in (None, "auto"):
        cell = rc.auto_cell(n_ground, area_m2, lo=0.5, hi=2.0)
    else:
        cell = float(cell_spec)
    grid = ld.Grid(bbox[0], bbox[1], bbox[2], bbox[3], cell)
    ground, direct = ground_from_points(P, grid, say)
    inside = polygon_mask(ring_xy, grid)
    say(f"  ground {grid.nx}x{grid.ny} @ {cell} m, cells with class 2: "
        f"{direct[inside].mean() * 100:.1f}% of the area")
    timings["ground_s"] = round(time.time() - t0, 2)

    say("[3/4] Coverage and possible pits")
    t0 = time.time()
    tot, near, B = scan_returns(P, grid, ground, say)
    coverage = float((tot[inside] > 0).mean()) if inside.any() else 0.0
    pits, dropped = find_pits(B, near, grid, zone, south)
    # only pits inside the ring
    if pits:
        keep = []
        for p in pits:
            u = p["properties"]["utm"]
            c, r = grid.indices(np.array([u[0]]), np.array([u[1]]))
            if inside[r[0], c[0]]:
                keep.append(p)
        pits = keep
    timings["scan_s"] = round(time.time() - t0, 2)
    if coverage < 0.98:
        notes.append(f"LiDAR covers {coverage * 100:.0f} % of this area: "
                     f"the rest stays empty")
    if pits:
        notes.append(f"{len(pits)} possible pit{'s' if len(pits) != 1 else ''} "
                     f"found (returns below the ground): see pits.geojson")

    say("[4/4] Writing")
    t0 = time.time()
    gd = os.path.join(area_dir, "ground")
    os.makedirs(gd, exist_ok=True)
    np.save(os.path.join(gd, "ground.npy"),
            np.ascontiguousarray(ground[::-1]).astype(np.float32))
    np.save(os.path.join(gd, "direct.npy"),
            np.ascontiguousarray(direct[::-1]).astype(np.uint8))
    meta = {"x0": grid.minx, "y0": grid.miny, "cell": grid.cell,
            "nx": grid.nx, "ny": grid.ny, "zone": int(zone), "south": bool(south),
            "epsg": int(epsg),
            "bbox_utm": [grid.minx, grid.miny, grid.maxx, grid.maxy],
            "version": VERSION, "row0": "south"}
    with open(os.path.join(gd, "grid.json"), "w") as f:
        json.dump(meta, f, indent=1)
    with open(os.path.join(gd, "pits.geojson"), "w") as f:
        json.dump({"type": "FeatureCollection", "features": pits}, f, indent=1)
    rgba = np.zeros(grid.shape + (4,), np.uint8)
    rgba[inside & (tot > 0)] = (60, 170, 90, 150)
    rgba[inside & (tot == 0)] = (120, 120, 120, 200)
    ld.write_png(rgba, os.path.join(gd, "coverage.png"))

    pd = os.path.join(area_dir, "points")
    nbytes = 13 * len(P)
    cap_mb = params.get("points_cap_mb")
    if cap_mb is None:
        cap_mb = os.environ.get("FLEX_AREA_POINTS_CAP_MB") or DEFAULT_CAP_MB
    cap_mb = float(cap_mb)
    kept_points = False
    if params.get("keep_points", True) and nbytes <= cap_mb * 1e6:
        save_points(P, pd, {"ox": P.ox, "oy": P.oy, "n": len(P),
                            "bbox_utm": list(bbox), "zone": int(zone),
                            "south": bool(south), "epsg": int(epsg),
                            "source": rc.source_id(src), "bytes": nbytes,
                            "format": "route_cost.Points compact store, "
                                      "float32 xl/yl offsets from ox/oy, "
                                      "float32 z, uint8 cls"})
        kept_points = True
        say(f"  kept the points for the other tools ({nbytes / 1e6:.0f} MB)")
    else:
        import shutil
        shutil.rmtree(pd, ignore_errors=True)
        if params.get("keep_points", True):
            say(f"  points not kept: {nbytes / 1e6:.0f} MB is over the cap "
                f"({cap_mb:.0f} MB)")
    timings["write_s"] = round(time.time() - t0, 2)
    timings["total_s"] = round(time.time() - t_start, 2)

    summary = {"version": VERSION, "ring": ring_ll, "km2": round(area_m2 / 1e6, 4),
               "cell": cell, "nx": grid.nx, "ny": grid.ny,
               "points": int(len(P)), "ground_points": n_ground,
               "coverage": round(coverage, 4),
               "direct_share": round(float(direct[inside].mean()), 4),
               "pits": len(pits), "pit_clusters_dropped": int(dropped),
               "pit_rule": {"depth_m": PIT_DEPTH, "min_points": PIT_MIN_POINTS,
                            "min_cells": PIT_MIN_CELLS, "max_span_m": PIT_MAX_SPAN,
                            "min_share": PIT_MIN_SHARE},
               "points_kept": kept_points, "points_bytes": nbytes,
               "source": rc.source_id(src), "notes": notes,
               "timings": timings, "seconds": timings["total_s"]}
    with open(os.path.join(gd, "summary.json"), "w") as f:
        json.dump(summary, f, indent=1)
    for n in notes:
        say("NOTE: " + n)
    say(f"  done in {timings['total_s']:.1f} s")
    return summary


# --------------------------------------------------------------------------
# Demo: a made-up slope with forest, a pit with a class-7 floor, noise
# --------------------------------------------------------------------------

def demo_truth(x, y):
    return 100.0 + 0.25 * x + 2.0 * np.sin(y / 30.0)


DEMO_PIT = (60.0, 80.0, 3.0, 6.0)     # cx, cy, radius, depth (local m)


def demo_scene(seed=5, density=10.0, W=160.0, H=160.0, pit=DEMO_PIT,
               noise=True, forest=(90, 20, 150, 140)):
    """Local x, y, z, class: a slope, a forest stand (few ground returns),
    a pit whose floor is classed 7, scattered multipath noise."""
    rng = np.random.default_rng(seed)
    n = int(W * H * density)
    gx, gy = rng.uniform(0, W, n), rng.uniform(0, H, n)
    fx0, fy0, fx1, fy1 = forest
    inf = (gx >= fx0) & (gx <= fx1) & (gy >= fy0) & (gy <= fy1)
    keep = ~inf | (rng.random(n) < 0.06)
    gx, gy = gx[keep], gy[keep]
    gz = demo_truth(gx, gy) + rng.normal(0, 0.03, len(gx))
    gc = np.full(len(gx), 2, np.uint8)
    X, Y, Z, C = [gx], [gy], [gz], [gc]
    if pit:
        cx, cy, r, d = pit
        rr = np.hypot(gx - cx, gy - cy)
        inpit = rr < r
        gz[inpit] -= d * np.clip((r - rr[inpit]) / (0.4 * r), 0, 1)
        gc[inpit & (rr < 0.8 * r)] = 7
    # brush everywhere, canopy in the forest
    m = int(W * H * 0.8)
    vx, vy = rng.uniform(0, W, m), rng.uniform(0, H, m)
    X.append(vx); Y.append(vy); Z.append(demo_truth(vx, vy) + rng.uniform(0.3, 1.8, m))
    C.append(np.full(m, 3, np.uint8))
    m = int((fx1 - fx0) * (fy1 - fy0) * 12)
    vx, vy = rng.uniform(fx0, fx1, m), rng.uniform(fy0, fy1, m)
    X.append(vx); Y.append(vy); Z.append(demo_truth(vx, vy) + rng.uniform(8, 25, m))
    C.append(np.full(m, 5, np.uint8))
    if noise:
        m = int(W * H * 0.01)
        vx, vy = rng.uniform(0, W, m), rng.uniform(0, H, m)
        X.append(vx); Y.append(vy)
        Z.append(demo_truth(vx, vy) - rng.uniform(1.5, 15, m))
        C.append(np.where(rng.random(m) < 0.5, 7, 1).astype(np.uint8))
    return (np.concatenate(X), np.concatenate(Y), np.concatenate(Z),
            np.concatenate(C))


def local_ring(x0, y0, x1, y1):
    e0, n0, zone = rc.example_origin()
    xs = [x0, x1, x1, x0, x0]; ys = [y0, y0, y1, y1, y0]
    lon, lat = rc.xy_to_lonlat(np.array(xs) + e0, np.array(ys) + n0, zone, False)
    return [[round(float(a), 8), round(float(b), 8)] for a, b in zip(lon, lat)]


def demo(area_dir, say=say_default):
    os.makedirs(area_dir, exist_ok=True)
    x, y, z, c = demo_scene()
    npz = rc.write_npz(os.path.join(area_dir, "demo_points.npz"), x, y, z, c)
    params = {"source": {"npz": npz}, "area": local_ring(0, 0, 160, 160),
              "cell": "auto", "keep_points": True}
    with open(os.path.join(area_dir, "ground_params.json"), "w") as f:
        json.dump(params, f, indent=1)
    return run(params, area_dir, say=say)


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="The shared ground of an area (FLEX).")
    ap.add_argument("--params", help="PARAMS.json")
    ap.add_argument("--area-dir", help="the area folder (writes ground/, points/)")
    ap.add_argument("--points-npz", default=None,
                    help="points from an npz (x, y, z, classification, epsg) "
                         "instead of params.source")
    ap.add_argument("--points-epsg", type=int, default=None)
    ap.add_argument("--demo", metavar="DIR", default=None,
                    help="a made-up area into DIR")
    a = ap.parse_args(argv)
    try:
        if a.demo:
            demo(a.demo)
            return 0
        if not a.params or not a.area_dir:
            ap.error("--params and --area-dir are required (or --demo DIR)")
        with open(a.params) as f:
            params = json.load(f)
        if a.points_npz:
            params["source"] = {"npz": a.points_npz}
            if a.points_epsg:
                params["source"]["epsg"] = a.points_epsg
        run(params, a.area_dir)
        return 0
    except SystemExit as e:
        if e.code not in (None, 0):
            rc.ascii_say(f"! {e.code}")
            return 1
        return 0
    except Exception as e:
        import traceback
        if a.area_dir:
            try:
                os.makedirs(a.area_dir, exist_ok=True)
                with open(os.path.join(a.area_dir, "ground_log.txt"), "a") as f:
                    f.write(traceback.format_exc())
            except Exception:
                pass
        rc.ascii_say(f"! {type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
