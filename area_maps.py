"""area_maps.py -- the maps of a processed area (slope, hillshade, brush, voids) as compact level rasters, for the
browser's coloured map layers.

The tile route (area_tiles.js, GET /api/areas/tiles/...) reads these files by offset and applies a colour ramp
chosen in the browser, so the colours change without re-running anything.

Files (one byte per cell, 0 = no data / nothing there, 1..16 = a level):
    ground/slope.u8      slope, 16 levels at useful angles (SLOPE_LEVELS: 2-4 deg steps between 25 and 50 deg)
    ground/hillshade.u8  multidirectional hillshade, 16 even levels (0 dark .. 1 lit)
    bush/brush.u8        brush: of the returns that reached brush height (in the band or below it), the share the
                         band stopped; 16 even levels 0..1; blank where fewer than 5 returns got that far
    bush/voids.u8        how far returns reach below the ground, 16 levels of 1 m
    <folder>/maps.json   { version: 2, grid: { x0, y0, cell, nx, ny, zone, south, epsg, row0 },
                           maps: [ { id, file, units, levels: 16, values: [16 numbers], min, max, suggest: [lo, hi] } ] }
Byte b (1..16) stands for values[b - 1]. x0, y0 = the west and south EDGES of the grid (UTM metres);
row0 = "south" (row 0 is the south edge) or "north". Files of version 1 (no `values`: 1..255 over min..max) still draw.

The detail of the maps is separate from the area's saved ground (ground/ground.npy, used by the other tools):
    fine_maps()  slope and hillshade from a FINE ground made at `maps_cell` (e.g. 0.3 m) from the area's stored points
                 only for this (not kept), and brush / voids in blocks of 3 x maps_cell on their own grid.
                 The fine ground = per cell the median of the class-2 returns; cells without one are filled by a
                 multi-resolution pyramid (means of 2 x 2 valid cells, each level put back by bilinear
                 interpolation, then a few Laplace steps on the filled cells only), so the fill is smooth between ground
                 returns and never blocky; gaps wider than
                 the pyramid reaches (PYR_LEVELS) take the saved ground. No smoothing afterwards.
                 Works in strips with a halo; peak memory a few hundred MB plus the brush block counts.
    ground_maps() / bush_maps()  the same files from the saved ground / the bushwhack grids (the Ground and
                 bushwhack steps write these first; the maps step replaces them with the fine ones).

    python3 area_maps.py AREA_DIR --maps-cell 0.3 [--band 0.3 2.0] [--void-depth -1] [--void-min 3]
                         [--ground-out DIR] [--bush-out DIR]       (from the stored points: the maps step)
    python3 area_maps.py AREA_DIR [--ground-out DIR] [--bush-out DIR]   (from the saved ground and tifs; no points)
"""
import json
import math
import os
import sys
import time

import numpy as np

STRIP = 1024          # rows handled at a time
HALO = 128            # rows of halo round a strip (= 2 ** PYR_LEVELS: the pyramid sees the same cells in every strip)
RELAX = 12            # Laplace steps on the filled cells after the pyramid
PYR_LEVELS = 7        # the fill reaches gaps up to about 2 ** 7 cells; wider ones take the saved ground
LEVELS = 16
SLOPE_LEVELS = [0, 5, 10, 15, 20, 25, 27, 30, 32, 35, 38, 41, 45, 50, 60, 70]   # lower edge of each level (deg)
VOID_LEVELS = [float(i + 1) for i in range(LEVELS)]                            # 1 .. 16 m (level k: k .. k+1 m)
MAX_CELL, MIN_CELL = 2.0, 0.2


def even_values(lo, hi, n=LEVELS):
    """Centres of n even levels over lo..hi."""
    return [round(lo + (k + 0.5) * (hi - lo) / n, 6) for k in range(n)]


def enc_even(a, lo, hi, n=LEVELS):
    """float -> uint8 (0 = no data; 1..n even levels over lo..hi, clipped)."""
    a = np.asarray(a, dtype=np.float32)
    ok = np.isfinite(a)
    k = np.floor((np.where(ok, a, lo) - lo) / float(hi - lo) * n)
    out = (1 + np.clip(k, 0, n - 1)).astype(np.uint8)
    out[~ok] = 0
    return out


def enc_edges(a, edges):
    """float -> uint8 (0 = no data; level k = edges[k-1] <= v < edges[k])."""
    a = np.asarray(a, dtype=np.float32)
    ok = np.isfinite(a)
    k = np.searchsorted(np.asarray(edges, np.float32), np.where(ok, a, edges[0]), side="right")
    out = np.clip(k, 1, len(edges)).astype(np.uint8)
    out[~ok] = 0
    return out


def decode(raw, m):
    """A map's bytes -> float values (NaN = no data), for tests and tools; version 1 and 2."""
    raw = np.asarray(raw)
    if m.get("values"):
        v = np.concatenate([[np.nan], np.asarray(m["values"], float)])
        return v[np.minimum(raw, len(m["values"]))]
    return np.where(raw == 0, np.nan, m["min"] + (raw.astype(float) - 1) / 254.0 * (m["max"] - m["min"]))


def _grid_meta(src, row0):
    keys = ("x0", "y0", "cell", "nx", "ny", "zone", "south", "epsg")
    g = {k: src[k] for k in keys if k in src and src[k] is not None}
    g["row0"] = row0
    return g


def _write_json(out_dir, grid, maps, extra=None):
    p = os.path.join(out_dir, "maps.json")
    d = {"version": 2, "grid": grid, "maps": maps}
    d.update(extra or {})
    with open(p + ".tmp", "w") as f:
        json.dump(d, f, indent=1)
    os.replace(p + ".tmp", p)


def _map(mid, file, units, values, suggest, **kw):
    d = {"id": mid, "file": file, "units": units, "levels": len(values), "values": values,
         "min": values[0], "max": values[-1], "suggest": suggest}
    d.update(kw)
    return d


def slope_map(units="degrees"):
    return _map("slope", "slope.u8", units, [float(v) for v in SLOPE_LEVELS], [0.0, 70.0], scale="edges")


def shade_map():
    return _map("hillshade", "hillshade.u8", "shade (0 dark, 1 lit; light from four directions)", even_values(0, 1), [0.0, 1.0])


def brush_map(units):
    return _map("brush", "brush.u8", units, even_values(0, 1), [0.0, 1.0], cuts=[0.1, 0.3, 0.6])


def voids_map():
    return _map("voids", "voids.u8", "m below ground", VOID_LEVELS, [1.0, 16.0], scale="edges")


# ── Slope and the multidirectional hillshade ─────────────────────────────────

MD_AZ = (225.0, 270.0, 315.0, 360.0)


def slope_shade(z, cell, alt_deg=45.0):
    """Slope (deg) and multidirectional shade (0..1) of a south-up height grid (row r+1 north of row r). NaN stays NaN.

    Shade = sum over the four lights (azimuth 225, 270, 315, 360 deg, 45 deg up) of w_az * hs_az / 2, where
    hs_az is the lit fraction under that light (the surface normal . the light) and w_az = sin^2(aspect - az),
    aspect = the downslope direction (clockwise from north): the weights of the four lights always add up to 2
    (GDAL's -multidirectional, after Mark 1992). A light along the slope's own direction gets little weight, so
    every face keeps relief whichever way it looks."""
    z = np.asarray(z, dtype=np.float32)
    dzdy, dzdx = np.gradient(z, cell)          # axis 0 = north (south-up), axis 1 = east
    k2 = dzdx * dzdx + dzdy * dzdy
    slope = np.degrees(np.arctan(np.sqrt(k2))).astype(np.float32)
    inv = 1.0 / np.sqrt(k2 + 1.0)
    aspect = np.arctan2(-dzdx, -dzdy)          # downslope azimuth, radians clockwise from north
    alt = math.radians(alt_deg)
    ca, sa = math.cos(alt), math.sin(alt)
    shade = np.zeros_like(z)
    for azd in MD_AZ:
        az = math.radians(azd)
        hs = np.clip((-dzdx * ca * math.sin(az) - dzdy * ca * math.cos(az) + sa) * inv, 0.0, 1.0)
        shade += (np.sin(aspect - az) ** 2) * hs
    shade *= 0.5
    return slope, np.clip(shade, 0.0, 1.0).astype(np.float32)


def ground_maps(ground, grid_src, out_dir):
    """Slope and hillshade from the saved ground (south-up float32, may be a memmap), at its cell."""
    os.makedirs(out_dir, exist_ok=True)
    ny, nx = ground.shape
    cell = float(grid_src["cell"])
    g = _grid_meta(dict(grid_src, nx=nx, ny=ny), "south")
    with open(os.path.join(out_dir, "slope.u8.tmp"), "wb") as fs_, open(os.path.join(out_dir, "hillshade.u8.tmp"), "wb") as fh:
        for r0 in range(0, ny, STRIP):
            r1 = min(ny, r0 + STRIP)
            lo, hi = max(0, r0 - 1), min(ny, r1 + 1)
            sl, sh = slope_shade(np.asarray(ground[lo:hi], np.float32), cell)
            fs_.write(enc_edges(sl[r0 - lo: r0 - lo + (r1 - r0)], SLOPE_LEVELS).tobytes())
            fh.write(enc_even(sh[r0 - lo: r0 - lo + (r1 - r0)], 0, 1).tobytes())
    for f in ("slope.u8", "hillshade.u8"):
        os.replace(os.path.join(out_dir, f + ".tmp"), os.path.join(out_dir, f))
    maps = [slope_map(), shade_map()]
    _write_json(out_dir, g, maps, {"maps_cell": cell, "source": "saved ground"})
    return maps


def bush_maps(veg, depth, grid_src, out_dir, brush_units="share of returns 0.3-1.5 m"):
    """veg (share 0..1) and depth (m, negative below ground), both north-up (row 0 north), -> brush.u8, voids.u8, maps.json."""
    os.makedirs(out_dir, exist_ok=True)
    ny, nx = veg.shape
    g = _grid_meta(dict(grid_src, nx=nx, ny=ny), "north")
    with open(os.path.join(out_dir, "brush.u8.tmp"), "wb") as fb, open(os.path.join(out_dir, "voids.u8.tmp"), "wb") as fv:
        for r0 in range(0, ny, STRIP):
            r1 = min(ny, r0 + STRIP)
            fb.write(enc_even(veg[r0:r1], 0, 1).tobytes())
            d = -np.asarray(depth[r0:r1], np.float32)
            d[~(d > 0)] = np.nan
            fv.write(enc_edges(d, VOID_LEVELS).tobytes())
    for f in ("brush.u8", "voids.u8"):
        os.replace(os.path.join(out_dir, f + ".tmp"), os.path.join(out_dir, f))
    maps = [brush_map(brush_units), voids_map()]
    _write_json(out_dir, g, maps)
    return maps


# ── The fine ground ──────────────────────────────────────────────────────────

def _down2(a):
    """2 x 2 mean of the valid cells (NaN where none); odd edges padded."""
    h, w = a.shape
    if h % 2 or w % 2:
        a = np.pad(a, ((0, h % 2), (0, w % 2)), constant_values=np.nan)
    ok = np.isfinite(a)
    v = np.where(ok, a, 0.0)
    s = v[0::2, 0::2] + v[1::2, 0::2] + v[0::2, 1::2] + v[1::2, 1::2]
    n = ok[0::2, 0::2].astype(np.float32) + ok[1::2, 0::2] + ok[0::2, 1::2] + ok[1::2, 1::2]
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(n > 0, s / np.maximum(n, 1), np.nan).astype(np.float32)


def _up2(c, shape):
    """Bilinear 2x upsampling of a coarse level to `shape` (cell centres: fine i sits at coarse (i + 0.5) / 2 - 0.5)."""
    def axis(n_f, n_c):
        t = (np.arange(n_f) + 0.5) / 2.0 - 0.5
        i0 = np.clip(np.floor(t).astype(np.int64), 0, n_c - 1)
        i1 = np.clip(i0 + 1, 0, n_c - 1)
        f = np.clip(t - np.floor(t), 0, 1).astype(np.float32)
        f[t < 0] = 0
        return i0, i1, f
    r0, r1, fr = axis(shape[0], c.shape[0])
    c0, c1, fc = axis(shape[1], c.shape[1])
    a = c[r0] * (1 - fr)[:, None] + c[r1] * fr[:, None]
    return a[:, c0] * (1 - fc)[None, :] + a[:, c1] * fc[None, :]


def pyramid_fill(med, levels=PYR_LEVELS):
    """Cells with a value keep it; empty cells get the bilinear interpolation of the next coarser level (2 x 2 means
    of valid cells), level by level from the coarsest: smooth between data, exact at data. NaN only where a whole
    2 ** levels block round it is empty."""
    pyr = [np.asarray(med, np.float32)]
    for _ in range(levels):
        if min(pyr[-1].shape) < 2:
            break
        pyr.append(_down2(pyr[-1]))
    filled = pyr[-1]
    for lv in range(len(pyr) - 2, -1, -1):
        a = pyr[lv]
        up = _up2(filled, a.shape)
        if np.isnan(up).any():                       # a NaN neighbour in the coarse level: use what is there
            up2 = _up2(np.where(np.isfinite(filled), filled, 0), a.shape)
            w = _up2(np.isfinite(filled).astype(np.float32), a.shape)
            with np.errstate(invalid="ignore", divide="ignore"):
                up = np.where(w > 0.01, up2 / np.maximum(w, 1e-6), np.nan)
        filled = np.where(np.isfinite(a), a, up).astype(np.float32)
    return relax(filled, ~np.isfinite(np.asarray(med)))


def relax(z, free, iters=RELAX):
    """A few Jacobi steps of the Laplace equation on the `free` (filled) cells only: removes the small kinks the
    pyramid leaves where a filled cell meets a measured one; measured cells never change."""
    if not free.any():
        return z
    z = z.copy()
    for _ in range(iters):
        p = np.pad(z, 1, mode="edge")
        avg = 0.25 * (p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:])
        ok = free & np.isfinite(avg)
        z[ok] = avg[ok]
    return z


def _ring_mask(ring_xy, x0, y0, cell, nx, r0, r1):
    """Inside the polygon (even-odd), per cell centre, for rows r0..r1 (south-up)."""
    m = np.zeros((r1 - r0, nx), bool)
    if not ring_xy:
        m[:] = True
        return m
    P = np.asarray(ring_xy, float)
    xa, ya = P[:-1], P[1:]
    for i, r in enumerate(range(r0, r1)):
        y = y0 + (r + 0.5) * cell
        c = (xa[:, 1] <= y) != (ya[:, 1] <= y)
        if not c.any():
            continue
        e, f = xa[c], ya[c]
        xs = np.sort(e[:, 0] + (y - e[:, 1]) * (f[:, 0] - e[:, 0]) / (f[:, 1] - e[:, 1]))
        for a, b in zip(xs[0::2], xs[1::2]):
            c0 = max(0, int(math.ceil((a - x0) / cell - 0.5)))
            c1 = min(nx, int(math.floor((b - x0) / cell - 0.5)) + 1)
            if c1 > c0:
                m[i, c0:c1] = True
    return m


def _sample_saved(gsaved, gm, xs, ys):
    """Bilinear from the saved ground (south-up) at UTM xs (cols) x ys (rows) -> (len(ys), len(xs))."""
    cs = float(gm["cell"])
    fx = np.clip((xs - gm["x0"]) / cs - 0.5, 0, gm["nx"] - 1.001)
    fy = np.clip((ys - gm["y0"]) / cs - 0.5, 0, gm["ny"] - 1.001)
    ix, iy = np.floor(fx).astype(np.int64), np.floor(fy).astype(np.int64)
    tx, ty = (fx - ix).astype(np.float32), (fy - iy).astype(np.float32)
    base = int(iy.min())
    rows = np.asarray(gsaved[base: int(iy.max()) + 2], np.float32)
    iy = iy - base
    iy1 = np.minimum(iy + 1, len(rows) - 1)
    a = rows[iy][:, ix] * (1 - tx)[None, :] + rows[iy][:, ix + 1] * tx[None, :]
    b = rows[iy1][:, ix] * (1 - tx)[None, :] + rows[iy1][:, ix + 1] * tx[None, :]
    return a * (1 - ty)[:, None] + b * ty[:, None]


def _groups(P):
    """The point store as groups to read one after another (one per stored tile, or the whole store)."""
    if hasattr(P, "tiles") and hasattr(P, "cdir"):
        import area_ground as ag
        return [ag.ChunkPoints(P.cdir, [tm], P.ox, P.oy, P.bbox) for tm in P.tiles]
    return [P]


def plan_cell(maps_cell, gm):
    """'auto' / None -> the saved ground's cell; a number is kept within MIN_CELL..MAX_CELL."""
    if maps_cell in (None, "auto", ""):
        return float(gm["cell"])
    c = float(maps_cell)
    if not (MIN_CELL <= c <= MAX_CELL):
        raise ValueError("the map detail must be between %g and %g m" % (MIN_CELL, MAX_CELL))
    return c


def fine_maps(area_dir, maps_cell, ground_out=None, bush_out=None, band=(0.3, 2.0), void_depth=-1.0, void_min=3,
              brush=True, say=print):
    """The maps step: slope + hillshade from a fine ground at maps_cell, brush + voids in blocks of 3 x maps_cell,
    all from the area's stored points. Returns a summary dict."""
    HERE = os.path.dirname(os.path.abspath(__file__))
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import area_ground as ag
    import route_cost as rc
    t0 = time.time()
    gd = os.path.join(area_dir, "ground")
    gm = json.load(open(os.path.join(gd, "grid.json")))
    gsaved = np.load(os.path.join(gd, "ground.npy"), mmap_mode="r")
    P = ag.load_points(area_dir)
    if P is None:
        raise RuntimeError("the points of this area are not stored on this computer: run Ground again (it reads the LiDAR)")
    cell = plan_cell(maps_cell, gm)
    W, H = gm["nx"] * gm["cell"], gm["ny"] * gm["cell"]
    nx, ny = int(math.ceil(W / cell - 1e-6)), int(math.ceil(H / cell - 1e-6))
    x0, y0, zone = float(gm["x0"]), float(gm["y0"]), int(gm["zone"])
    ground_out = ground_out or gd
    os.makedirs(ground_out, exist_ok=True)
    try:
        area = json.load(open(os.path.join(area_dir, "area.json")))
        ring_xy = [rc.lonlat_to_xy(p[0], p[1], zone) for p in area.get("ring") or []]
    except Exception:
        ring_xy = []
    groups = _groups(P)
    say("[1/4] Fine ground at %g m: %d x %d cells (%.0f M), %d groups of points" % (cell, nx, ny, nx * ny / 1e6, len(groups)))

    # 1. per cell the median of the class-2 returns (a temporary file, deleted at the end)
    medf = os.path.join(ground_out, ".fine_median.npy")
    med = np.lib.format.open_memmap(medf, mode="w+", dtype=np.float32, shape=(ny * nx,))
    med[:] = np.nan
    nground = 0
    for gi, G in enumerate(groups):
        fs_, zs = [], []
        for x, y, z, _c in G.chunks(lambda c, z: c == ag.GROUND_CLASS):
            ci = np.floor((x - x0) / cell).astype(np.int64)
            ri = np.floor((y - y0) / cell).astype(np.int64)
            k = (ci >= 0) & (ci < nx) & (ri >= 0) & (ri < ny)
            fs_.append(ri[k] * nx + ci[k]); zs.append(z[k])
        if fs_:
            f = np.concatenate(fs_); z = np.concatenate(zs)
            nground += len(f)
            if len(f):
                uf, inv = np.unique(f, return_inverse=True)
                mm, _ = ag.cell_median(inv, z, len(uf))
                med[uf] = mm.astype(np.float32)
        if gi % 10 == 0:
            say("[1/4] ground returns, group %d/%d" % (gi + 1, len(groups)))
    med.flush()
    med2 = med.reshape(ny, nx)
    direct = 0

    # 2. fill, slope, hillshade, strip by strip; the filled fine ground goes to a temporary file for the brush step
    gnf = os.path.join(ground_out, ".fine_ground.npy")
    gnd = np.lib.format.open_memmap(gnf, mode="w+", dtype=np.float32, shape=(ny, nx))
    sl_f = open(os.path.join(ground_out, "slope.u8.tmp"), "wb")
    hs_f = open(os.path.join(ground_out, "hillshade.u8.tmp"), "wb")
    xs = x0 + (np.arange(nx) + 0.5) * cell
    fallback = 0
    for r0 in range(0, ny, STRIP):
        r1 = min(ny, r0 + STRIP)
        a0, a1 = max(0, r0 - HALO), min(ny, r1 + HALO)
        win = np.array(med2[a0:a1], np.float32)
        direct += int(np.isfinite(win[r0 - a0: r1 - a0]).sum())
        fil = pyramid_fill(win)
        bad = ~np.isfinite(fil)
        if bad.any():                                   # gaps wider than the pyramid: the saved ground
            ys = y0 + (np.arange(a0, a1) + 0.5) * cell
            sv = _sample_saved(gsaved, gm, xs, ys)
            fallback += int(bad[r0 - a0: r1 - a0].sum())
            fil = np.where(bad, sv, fil)
        sl, sh = slope_shade(fil, cell)
        inside = _ring_mask(ring_xy, x0, y0, cell, nx, r0, r1)
        s, h = sl[r0 - a0: r1 - a0], sh[r0 - a0: r1 - a0]
        s[~inside] = np.nan; h[~inside] = np.nan
        sl_f.write(enc_edges(s, SLOPE_LEVELS).tobytes())
        hs_f.write(enc_even(h, 0, 1).tobytes())
        gnd[r0:r1] = fil[r0 - a0: r1 - a0]
        say("[2/4] slope and hillshade, rows %d/%d" % (r1, ny))
    sl_f.close(); hs_f.close()
    gnd.flush()
    del med, med2
    os.remove(medf)
    for f in ("slope.u8", "hillshade.u8"):
        os.replace(os.path.join(ground_out, f + ".tmp"), os.path.join(ground_out, f))
    gg = _grid_meta(dict(gm, x0=x0, y0=y0, cell=cell, nx=nx, ny=ny), "south")
    info = {"maps_cell": cell, "source": "points", "ground_returns": nground,
            "cells_with_ground": round(direct / float(nx * ny), 3), "cells_from_saved_ground": round(fallback / float(nx * ny), 4),
            "fill": "median of class 2 per cell; empty cells: multi-resolution pyramid, bilinear (%d levels), then %d Laplace steps on them; wider gaps: the saved ground" % (PYR_LEVELS, RELAX)}
    _write_json(ground_out, gg, [slope_map(), shade_map()], info)
    out = dict(info, nx=nx, ny=ny)

    # 3. brush and voids in blocks of 3 x cell, heights above the fine ground
    if brush:
        bush_out = bush_out or os.path.join(area_dir, "bush")
        os.makedirs(bush_out, exist_ok=True)
        bc = 3 * cell
        bx, by = int(math.ceil(W / bc - 1e-6)), int(math.ceil(H / bc - 1e-6))
        say("[3/4] Brush and voids in %.2f m blocks: %d x %d" % (bc, bx, by))
        nb = bx * by
        inband = np.zeros(nb, np.int32); below = np.zeros(nb, np.int32)
        vcount = np.zeros(nb, np.int32); depth = np.full(nb, np.inf, np.float32)
        lo, hi = float(band[0]), float(band[1])
        for gi, G in enumerate(groups):
            for x, y, z, _c in G.chunks():
                ci = np.floor((x - x0) / cell).astype(np.int64)
                ri = np.floor((y - y0) / cell).astype(np.int64)
                k = (ci >= 0) & (ci < nx) & (ri >= 0) & (ri < ny)
                if not k.any():
                    continue
                ci, ri, z = ci[k], ri[k], z[k]
                rmin, rmax = int(ri.min()), int(ri.max())
                rows = np.asarray(gnd[rmin: rmax + 1])
                hag = (z - rows[ri - rmin, ci]).astype(np.float32)
                b = np.minimum(ri // 3, by - 1) * bx + np.minimum(ci // 3, bx - 1)
                b0 = int(b.min()); bl = b - b0; n = int(bl.max()) + 1
                m1 = (hag >= lo) & (hag <= hi)
                m2 = (hag < lo) & (hag > -1.0)
                inband[b0:b0 + n] += np.bincount(bl[m1], minlength=n).astype(np.int32)
                below[b0:b0 + n] += np.bincount(bl[m2], minlength=n).astype(np.int32)
                mv = hag <= void_depth
                if mv.any():
                    vcount[b0:b0 + n] += np.bincount(bl[mv], minlength=n).astype(np.int32)
                    np.minimum.at(depth, b[mv], hag[mv])
            if gi % 10 == 0:
                say("[3/4] all returns, group %d/%d" % (gi + 1, len(groups)))
        reached = inband + below
        veg = np.where(reached >= 5, inband / np.maximum(reached, 1).astype(np.float32), np.nan).astype(np.float32).reshape(by, bx)
        dd = np.where(vcount >= void_min, -depth, np.nan).astype(np.float32).reshape(by, bx)
        del inband, below, vcount, depth, reached
        for r0 in range(0, by, STRIP):
            r1 = min(by, r0 + STRIP)
            inside = _ring_mask(ring_xy, x0, y0, bc, bx, r0, r1)
            veg[r0:r1][~inside] = np.nan; dd[r0:r1][~inside] = np.nan
        np.asarray(enc_even(veg, 0, 1)).tofile(os.path.join(bush_out, "brush.u8.tmp"))
        np.asarray(enc_edges(dd, VOID_LEVELS)).tofile(os.path.join(bush_out, "voids.u8.tmp"))
        for f in ("brush.u8", "voids.u8"):
            os.replace(os.path.join(bush_out, f + ".tmp"), os.path.join(bush_out, f))
        bg = _grid_meta(dict(gm, x0=x0, y0=y0, cell=bc, nx=bx, ny=by), "south")
        units = "share of the returns reaching %g-%g m that the band stopped" % (lo, hi)
        _write_json(bush_out, bg, [brush_map(units), voids_map()], {"maps_cell": cell, "block": bc, "band": [lo, hi],
                                                                    "void_depth": void_depth, "void_min": void_min})
        out.update(block=bc, bx=bx, by=by)
    del gnd
    os.remove(gnf)
    out["seconds"] = round(time.time() - t0, 1)
    say("[4/4] Maps written in %.0f s (cells with a ground return: %.0f %%)" % (out["seconds"], 100 * out["cells_with_ground"]))
    return out


def _read_tif(path):
    """A single-band float GeoTIFF as written by lidar_derive.write_geotiff (GDAL or the plain-TIFF fallback)."""
    try:
        from osgeo import gdal
        ds = gdal.Open(path)
        return ds.GetRasterBand(1).ReadAsArray().astype(np.float32)
    except Exception:
        pass
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    return np.asarray(Image.open(path), dtype=np.float32)


def convert(area_dir, bush_out=None, ground_out=None, say=print):
    """The map files of an existing area from its saved ground and tifs (no points). Returns what was written."""
    done = []
    gd = os.path.join(area_dir, "ground")
    gj = os.path.join(gd, "grid.json")
    meta = json.load(open(gj)) if os.path.exists(gj) else None
    if meta and os.path.exists(os.path.join(gd, "ground.npy")):
        say("[1/2] slope and hillshade from ground/ground.npy")
        ground_maps(np.load(os.path.join(gd, "ground.npy"), mmap_mode="r"), meta, ground_out or gd)
        done.append("ground")
    bd = os.path.join(area_dir, "bush")
    dj = os.path.join(bd, "derived.json")
    if os.path.exists(dj) and os.path.exists(os.path.join(bd, "vegetation.tif")):
        say("[2/2] brush and voids from bush/vegetation.tif + voids.tif")
        d = json.load(open(dj))
        bb = d.get("utm_bbox")
        src = {"x0": bb[0], "y0": bb[1], "cell": d.get("cell"), "epsg": d.get("epsg")}
        if meta:
            src.update(zone=meta.get("zone"), south=meta.get("south"))
        veg = _read_tif(os.path.join(bd, "vegetation.tif"))
        vp = os.path.join(bd, "voids.tif")
        depth = _read_tif(vp) if os.path.exists(vp) else np.full(veg.shape, np.nan, np.float32)
        if not src.get("cell"):
            src["cell"] = (bb[2] - bb[0]) / veg.shape[1]
        band = d.get("veg_band") or [0.3, 1.5]
        bush_maps(veg, depth, src, bush_out or bd, "share of returns %g-%g m" % tuple(band))
        done.append("bush")
    return done


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="The map files (slope, hillshade, brush, voids) of a processed area")
    ap.add_argument("area_dir")
    ap.add_argument("--maps-cell", default=None, help="'auto' or metres (%g-%g): make the maps from the stored points" % (MIN_CELL, MAX_CELL))
    ap.add_argument("--band", nargs=2, type=float, default=[0.3, 2.0], help="brush height band (m above ground)")
    ap.add_argument("--void-depth", type=float, default=-1.0)
    ap.add_argument("--void-min", type=int, default=3)
    ap.add_argument("--no-brush", action="store_true", help="slope and hillshade only")
    ap.add_argument("--bush-out", default=None, help="write brush/voids here instead of AREA_DIR/bush")
    ap.add_argument("--ground-out", default=None, help="write slope/hillshade here instead of AREA_DIR/ground")
    a = ap.parse_args(argv)
    if a.maps_cell is not None:
        try:
            s = fine_maps(a.area_dir, a.maps_cell, a.ground_out, a.bush_out, tuple(a.band), a.void_depth, a.void_min,
                          brush=not a.no_brush, say=lambda m: print(m, flush=True))
        except (RuntimeError, ValueError) as e:
            print("! " + str(e), flush=True)
            return 1
        print("NOTE: maps at %g m; %.0f %% of the cells had a ground return, the rest filled between them"
              % (s["maps_cell"], 100 * s["cells_with_ground"]), flush=True)
        return 0
    done = convert(a.area_dir, a.bush_out, a.ground_out)
    print("Wrote: " + (", ".join(done) or "nothing (no ground.npy or vegetation.tif found)"))
    return 0 if done else 1


if __name__ == "__main__":
    sys.exit(main())
