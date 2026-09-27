#!/usr/bin/env python3
"""
lidar_derive.py — height-above-ground derivations for FLEX.

Produces, from one pass over a point cloud:

  * a vegetation-density raster  ("how bad is the bushwhack here")
  * a void raster                ("how far below local ground do returns reach")
  * a filtered point set         (obvious garbage removed, everything else kept)

THE RULE THIS FILE EXISTS UNDER
-------------------------------
Automated classifiers label returns below the modelled ground surface as noise
(ASPRS class 7 / 18). A cave entrance is exactly where the ground surface is not
continuous, so those returns are not noise here -- they are the signal, and
finding them is much of the point of FLEX.

Therefore: no function in this file filters by classification in order to
discard points. Class 2 is read as a *reference surface* only. Negative
height-above-ground is a first-class output, not an error to clean up. The one
cutoff that does drop points exists for physically impossible returns
(multipath, atmospheric) and defaults deliberately generous.

Structure: the numeric core takes plain numpy arrays and has no PDAL or GDAL
dependency, so it can be tested anywhere. The readers and writers are thin
wrappers at the bottom.
"""

import math
import numpy as np

# ─────────────────────────────────────────────────────────────────────────────
# Grid bookkeeping
# ─────────────────────────────────────────────────────────────────────────────

class Grid:
    """A north-up raster covering [minx,maxx] x [miny,maxy] at `cell` metres.

    Row 0 is the NORTH edge, matching how GeoTIFF and every GIS expects a raster
    to be laid out, so nothing has to be flipped on the way out.
    """

    def __init__(self, minx, miny, maxx, maxy, cell):
        self.minx, self.miny = float(minx), float(miny)
        self.maxx, self.maxy = float(maxx), float(maxy)
        self.cell = float(cell)
        self.nx = max(1, int(math.ceil((self.maxx - self.minx) / self.cell)))
        self.ny = max(1, int(math.ceil((self.maxy - self.miny) / self.cell)))
        # Snap the extent up to a whole number of cells.
        self.maxx = self.minx + self.nx * self.cell
        self.maxy = self.miny + self.ny * self.cell

    @property
    def shape(self):
        return (self.ny, self.nx)

    def indices(self, x, y):
        """Column and row for each point. Row 0 is north."""
        col = np.floor((x - self.minx) / self.cell).astype(np.int64)
        row = np.floor((self.maxy - y) / self.cell).astype(np.int64)
        np.clip(col, 0, self.nx - 1, out=col)
        np.clip(row, 0, self.ny - 1, out=row)
        return col, row

    def flat(self, x, y):
        col, row = self.indices(x, y)
        return row * self.nx + col

    def geotransform(self):
        """GDAL-order affine: (originX, pixelW, 0, originY, 0, -pixelH)."""
        return (self.minx, self.cell, 0.0, self.maxy, 0.0, -self.cell)

    def __repr__(self):
        return (f"Grid({self.nx}x{self.ny} @ {self.cell} m, "
                f"x[{self.minx:.1f},{self.maxx:.1f}] y[{self.miny:.1f},{self.maxy:.1f}])")


def grid_for_points(x, y, cell, pad=0.0):
    return Grid(x.min() - pad, y.min() - pad, x.max() + pad, y.max() + pad, cell)


# ─────────────────────────────────────────────────────────────────────────────
# Ground surface
# ─────────────────────────────────────────────────────────────────────────────

GROUND_CLASS = 2

def plausible_ground_band(z, classification, ground_class=GROUND_CLASS,
                          margin=250.0):
    """A generous z range that ground could possibly lie in.

    Needed because of a genuine chicken-and-egg: the height filter that removes
    multipath garbage depends on the ground surface, but the ground surface is
    computed first -- so a return 600 m underground can end up *defining* ground
    for a cell that has no classified ground points, and the error propagates
    outward through the hole fill. That was measured at 346 m of error before
    this guard existed.

    This does NOT drop any point. Points outside the band still flow through to
    HAG, the void raster and the output; they are simply not allowed to vote on
    where the ground is. Keeping sub-ground returns while refusing to let
    obvious multipath define the surface is exactly the distinction THE RULE
    asks for.
    """
    if classification is not None and (classification == ground_class).any():
        ref = z[classification == ground_class]
    else:
        ref = z
    lo = np.percentile(ref, 0.5) - margin
    hi = np.percentile(ref, 99.5) + margin
    return float(lo), float(hi)


def build_ground_grid(x, y, z, classification, grid, stat="median",
                      ground_class=GROUND_CLASS, fallback_percentile=5.0,
                      z_band=None):
    """Ground elevation per cell, from ground-classified points where available.

    `stat` is "median" (robust, default) or "mean" (faster).

    Why not the minimum, which is the obvious choice? Because the classifier has
    already decided which points are ground. Taking the minimum of those just
    picks the downhill corner of the cell, which on a slope biases ground low by
    roughly (cell/2)*tan(slope) -- about 0.6 m on a 2 m cell at 30 degrees, well
    inside the 1-5 ft band that matters for vegetation. The median of points
    already known to be ground sits near the cell centre instead.

    Cells with no ground-classified points fall back to a low percentile of ALL
    returns in that cell, and cells with nothing at all are left NaN for the
    pyramid fill to handle.

    Returns (ground, direct_mask) -- ground is float32 (NaN where unknown),
    direct_mask marks cells resolved from actual ground points.
    """
    ny, nx = grid.shape
    ground = np.full(ny * nx, np.nan, dtype=np.float64)

    if z_band is None:
        z_band = plausible_ground_band(z, classification, ground_class)
    zlo, zhi = z_band
    sane = (z >= zlo) & (z <= zhi)      # eligible to define ground, not to survive

    flat_all = grid.flat(x, y)

    if classification is not None:
        is_ground = (classification == ground_class) & sane
    else:
        is_ground = np.zeros(len(x), dtype=bool)

    direct = np.zeros(ny * nx, dtype=bool)

    if is_ground.any():
        gf = flat_all[is_ground]
        gz = z[is_ground]
        _assign_cell_stat(ground, direct, gf, gz, stat, ny * nx)

    # Cells with no ground points: a low percentile of everything present is a
    # reasonable stand-in, and is what you want under dense canopy.
    missing = ~direct
    if missing.any():
        need = missing[flat_all] & sane
        if need.any():
            mf = flat_all[need]
            mz = z[need]
            filled = _cell_percentile(mf, mz, fallback_percentile, ny * nx)
            take = np.isnan(ground) & ~np.isnan(filled)
            ground[take] = filled[take]

    return ground.reshape(ny, nx).astype(np.float32), direct.reshape(ny, nx)


def ground_points_per_cell(x, y, classification, grid, ground_class=GROUND_CLASS):
    """Mean ground returns per cell -- the number that decides whether a chosen
    cell size is actually supportable.

    Finer is not automatically better. Below roughly 4 ground points per cell
    the per-cell statistic becomes noisy and total error *rises* even though
    slope bias falls, so a UI offering cell size should show this alongside it.
    """
    if classification is None:
        return 0.0
    n = int((classification == ground_class).sum())
    return n / float(grid.nx * grid.ny)


def _assign_cell_stat(out, direct, flat_idx, vals, stat, ncells):
    if stat == "mean":
        counts = np.bincount(flat_idx, minlength=ncells)
        sums = np.bincount(flat_idx, weights=vals, minlength=ncells)
        hit = counts > 0
        out[hit] = sums[hit] / counts[hit]
        direct |= hit
        return
    # median: sort by cell then value, and pick the middle of each run.
    order = np.lexsort((vals, flat_idx))
    fi = flat_idx[order]
    vv = vals[order]
    starts = np.searchsorted(fi, np.arange(ncells), side="left")
    ends = np.searchsorted(fi, np.arange(ncells), side="right")
    counts = ends - starts
    hit = counts > 0
    mid = starts[hit] + counts[hit] // 2
    out[hit] = vv[mid]
    direct |= hit


def _cell_percentile(flat_idx, vals, pct, ncells):
    out = np.full(ncells, np.nan, dtype=np.float64)
    order = np.lexsort((vals, flat_idx))
    fi = flat_idx[order]
    vv = vals[order]
    starts = np.searchsorted(fi, np.arange(ncells), side="left")
    ends = np.searchsorted(fi, np.arange(ncells), side="right")
    counts = ends - starts
    hit = counts > 0
    k = starts[hit] + np.minimum(counts[hit] - 1,
                                 (counts[hit] * (pct / 100.0)).astype(np.int64))
    out[hit] = vv[k]
    return out


def fill_pyramid(grid_arr, max_levels=12):
    """Fill NaN cells from progressively coarser averages of the same raster.

    Dilation needs one pass per cell of reach, which at these resolutions is
    hundreds of millions of operations. Halving repeatedly fills any hole in
    log(N) passes instead, and is what the offline viewer's height grid uses.
    """
    out = grid_arr.astype(np.float32).copy()
    if not np.isnan(out).any():
        return out

    levels = [out]
    cur = out
    for _ in range(max_levels):
        ny, nx = cur.shape
        if ny < 2 or nx < 2:
            break
        hy, hx = ny // 2, nx // 2
        blk = cur[:hy * 2, :hx * 2].reshape(hy, 2, hx, 2)
        with np.errstate(invalid="ignore"):
            coarse = np.nanmean(blk, axis=(1, 3)).astype(np.float32)
        levels.append(coarse)
        cur = coarse
        if not np.isnan(coarse).any():
            break

    # Walk back down, filling holes from the level above.
    for li in range(len(levels) - 2, -1, -1):
        fine = levels[li]
        coarse = levels[li + 1]
        holes = np.isnan(fine)
        if not holes.any():
            continue
        ry, rx = np.nonzero(holes)
        cy = np.clip(ry // 2, 0, coarse.shape[0] - 1)
        cx = np.clip(rx // 2, 0, coarse.shape[1] - 1)
        fine[ry, rx] = coarse[cy, cx]
    return levels[0]


def sample_bilinear(ground, grid, x, y):
    """Bilinear ground elevation at arbitrary coordinates.

    Sampling the grid rather than using a constant per cell removes the
    blockiness and most of the residual slope bias, which is the difference
    between a usable 1-5 ft band and a noisy one.
    """
    ny, nx = ground.shape
    fx = (x - grid.minx) / grid.cell - 0.5
    fy = (grid.maxy - y) / grid.cell - 0.5
    x0 = np.floor(fx).astype(np.int64)
    y0 = np.floor(fy).astype(np.int64)
    tx = (fx - x0).astype(np.float32)
    ty = (fy - y0).astype(np.float32)
    x1, y1 = x0 + 1, y0 + 1
    np.clip(x0, 0, nx - 1, out=x0); np.clip(x1, 0, nx - 1, out=x1)
    np.clip(y0, 0, ny - 1, out=y0); np.clip(y1, 0, ny - 1, out=y1)
    a = ground[y0, x0]; b = ground[y0, x1]
    c = ground[y1, x0]; d = ground[y1, x1]
    return ((a * (1 - tx) + b * tx) * (1 - ty) +
            (c * (1 - tx) + d * tx) * ty)


def compute_hag(x, y, z, ground, grid):
    return z - sample_bilinear(ground, grid, x, y)


# ─────────────────────────────────────────────────────────────────────────────
# Derived rasters
# ─────────────────────────────────────────────────────────────────────────────

def band_fraction(x, y, hag, grid, lo, hi, min_points=4):
    """Fraction of returns per cell whose HAG falls in [lo, hi].

    A fraction, not a raw count: raw counts track scan density as much as
    vegetation, so a densely flown strip reads as thick brush. The proportion of
    returns coming back from the understory is what actually says how hard the
    ground is to walk through.

    Returns (fraction, total_counts). Cells under `min_points` are NaN.
    """
    ncells = grid.nx * grid.ny
    flat = grid.flat(x, y)
    total = np.bincount(flat, minlength=ncells).astype(np.float32)
    inband = np.bincount(flat[(hag >= lo) & (hag <= hi)],
                         minlength=ncells).astype(np.float32)
    frac = np.full(ncells, np.nan, dtype=np.float32)
    ok = total >= min_points
    frac[ok] = inband[ok] / total[ok]
    return frac.reshape(grid.shape), total.reshape(grid.shape)


def void_raster(x, y, hag, grid, depth_threshold=-1.0, min_points=1):
    """Where do returns reach below local ground, and how far?

    This is the entrance-finding channel. Two outputs, because they answer
    different questions:
      depth  -- the most-below-ground HAG in the cell (how deep does it go)
      count  -- how many returns are below the threshold (is it a real void or
                one stray point)

    A single deep return is usually multipath. A cluster of them is a hole.
    """
    ncells = grid.nx * grid.ny
    flat = grid.flat(x, y)
    below = hag <= depth_threshold

    depth = np.full(ncells, np.nan, dtype=np.float32)
    count = np.zeros(ncells, dtype=np.float32)

    if below.any():
        bf = flat[below]
        bh = hag[below].astype(np.float64)
        count = np.bincount(bf, minlength=ncells).astype(np.float32)
        # Deepest (most negative) per cell via a sorted run scan.
        order = np.lexsort((bh, bf))
        fi = bf[order]; vv = bh[order]
        starts = np.searchsorted(fi, np.arange(ncells), side="left")
        ends = np.searchsorted(fi, np.arange(ncells), side="right")
        hit = (ends - starts) > 0
        depth[hit] = vv[starts[hit]].astype(np.float32)   # first == smallest

    depth[count < min_points] = np.nan
    return depth.reshape(grid.shape), count.reshape(grid.shape)


# ─────────────────────────────────────────────────────────────────────────────
# Point filtering
# ─────────────────────────────────────────────────────────────────────────────

def filter_by_hag(hag, low_cut=-20.0, high_cut=120.0):
    """Keep points whose HAG is physically plausible.

    This removes garbage, NOT "noise". The defaults are deliberately generous:
    -20 m still keeps anything that could be a pit, a sink or a fissure, while
    discarding multipath returns hundreds of metres underground. Tighten it only
    with a specific reason, and never on the basis of classification.
    """
    return (hag >= low_cut) & (hag <= high_cut) & np.isfinite(hag)


def recommend_cell_size(n_ground, area_m2, target_per_cell=8.0,
                        lo=0.5, hi=10.0):
    """Suggest a cell size for the ground grid given the data actually present.

    Finer is not automatically better, which is easy to get wrong. Smaller cells
    cut slope bias -- measured at (cell/2)*tan(slope), so 0.23 m on a 2 m cell at
    14 degrees -- but once a cell holds only two or three ground returns the
    per-cell statistic is sampling noise, and total error rises sharply. On the
    validation cloud, 1 m cells were ten times worse than 2 m for exactly this
    reason. Aim for about eight ground returns per cell and the two effects
    balance.
    """
    if n_ground <= 0 or area_m2 <= 0:
        return 2.0
    cell = math.sqrt(target_per_cell * area_m2 / float(n_ground))
    return float(min(hi, max(lo, round(cell * 2) / 2)))   # nearest 0.5 m


# ─────────────────────────────────────────────────────────────────────────────
# Colour ramps
# ─────────────────────────────────────────────────────────────────────────────

def _ramp(stops, t):
    """Piecewise-linear ramp. `stops` is [(pos, (r,g,b)), ...] over 0..1."""
    t = np.clip(t, 0.0, 1.0)
    out = np.zeros(t.shape + (3,), dtype=np.float32)
    for i in range(len(stops) - 1):
        p0, c0 = stops[i]
        p1, c1 = stops[i + 1]
        m = (t >= p0) & (t <= p1)
        if not m.any():
            continue
        u = ((t[m] - p0) / max(p1 - p0, 1e-9))[:, None]
        out[m] = np.array(c0, np.float32) * (1 - u) + np.array(c1, np.float32) * u
    return out


VEG_RAMP = [(0.00, (26, 94, 46)),    # open forest floor — walkable
            (0.25, (94, 158, 48)),
            (0.50, (223, 202, 60)),
            (0.75, (232, 133, 38)),
            (1.00, (196, 42, 34))]   # solid brush

VOID_RAMP = [(0.00, (40, 20, 70)),
             (0.35, (86, 44, 152)),
             (0.70, (0, 168, 214)),
             (1.00, (140, 240, 255))]


def colorize(values, ramp, vmin=None, vmax=None, nodata_alpha=0):
    """Raster -> RGBA uint8, NaN transparent. Returns (rgba, vmin, vmax)."""
    v = np.asarray(values, dtype=np.float32)
    finite = np.isfinite(v)
    if vmin is None:
        vmin = float(np.nanpercentile(v[finite], 2)) if finite.any() else 0.0
    if vmax is None:
        vmax = float(np.nanpercentile(v[finite], 98)) if finite.any() else 1.0
    if vmax <= vmin:
        vmax = vmin + 1e-6
    t = (v - vmin) / (vmax - vmin)
    rgb = _ramp(ramp, np.where(finite, t, 0.0))
    rgba = np.zeros(v.shape + (4,), dtype=np.uint8)
    rgba[..., :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    rgba[..., 3] = np.where(finite, 255, nodata_alpha).astype(np.uint8)
    return rgba, vmin, vmax


# ─────────────────────────────────────────────────────────────────────────────
# Writers
# ─────────────────────────────────────────────────────────────────────────────

def write_png(rgba, path):
    from PIL import Image
    Image.fromarray(rgba, mode="RGBA").save(path, optimize=True)
    return path


def write_geotiff(values, grid, path, epsg=None, nodata=np.nan):
    """Single-band float GeoTIFF.

    Uses GDAL when present. Without it, falls back to a plain TIFF plus a
    world file and a .prj, which QGIS, CalTopo and ArcGIS all read as
    georeferenced -- so the fallback is genuinely usable, not a placeholder.
    Returns a list of every file written.
    """
    arr = np.asarray(values, dtype=np.float32)
    try:
        from osgeo import gdal, osr
        drv = gdal.GetDriverByName("GTiff")
        ds = drv.Create(str(path), grid.nx, grid.ny, 1, gdal.GDT_Float32,
                        options=["COMPRESS=DEFLATE", "TILED=YES"])
        ds.SetGeoTransform(grid.geotransform())
        if epsg:
            srs = osr.SpatialReference()
            srs.ImportFromEPSG(int(epsg))
            ds.SetProjection(srs.ExportToWkt())
        band = ds.GetRasterBand(1)
        band.WriteArray(arr)
        band.SetNoDataValue(float("nan"))
        ds.FlushCache()
        ds = None
        return [str(path)]
    except Exception:
        pass

    from PIL import Image
    Image.fromarray(arr, mode="F").save(str(path))
    written = [str(path)]
    base = str(path).rsplit(".", 1)[0]
    gt = grid.geotransform()
    # World file references pixel CENTRES, hence the half-cell shift.
    with open(base + ".tfw", "w") as f:
        f.write(f"{gt[1]:.10f}\n0.0\n0.0\n{gt[5]:.10f}\n"
                f"{gt[0] + gt[1]/2:.6f}\n{gt[3] + gt[5]/2:.6f}\n")
    written.append(base + ".tfw")
    if epsg:
        try:
            from osgeo import osr
            srs = osr.SpatialReference(); srs.ImportFromEPSG(int(epsg))
            with open(base + ".prj", "w") as f:
                f.write(srs.ExportToWkt())
            written.append(base + ".prj")
        except Exception:
            with open(base + ".epsg", "w") as f:
                f.write(f"EPSG:{int(epsg)}\n")
            written.append(base + ".epsg")
    return written


# ─────────────────────────────────────────────────────────────────────────────
# EPT reader
# ─────────────────────────────────────────────────────────────────────────────
#
# NOTE ON DUPLICATION: the CRS detection and bbox conversion below mirror
# fetch_ept_points() in export_terrain.py. That is deliberate, not an oversight.
# The export's reader filters to Classification==2 deep inside itself, which is
# exactly what this module must not do, and unifying them would mean editing a
# working export path that cannot be tested from here. Once both have run
# against real data they should be merged behind one bounds/CRS helper.

def read_ept_all_classes(ept_path, utm_bbox, bbox_latlon=None, progress=print):
    """Every point in the bbox, with classification, reprojected to UTM.

    Unlike the export's reader this applies NO classification filter. Class 7
    and 18 come back with everything else, because in this project those are
    where the entrances are.

    Returns (x, y, z, classification, utm_epsg).
    """
    try:
        import pdal
    except ImportError:
        raise SystemExit("ERROR: pdal not installed. "
                         "Run: conda install -c conda-forge python-pdal")
    import json as _json

    minE, minN, maxE, maxN = utm_bbox

    native_epsg = None
    try:
        import urllib.request as _ur
        s = str(ept_path)
        if s.startswith("http"):
            with _ur.urlopen(s, timeout=30) as r:
                meta = _json.loads(r.read())
        else:
            with open(s) as f:
                meta = _json.load(f)
        h = str((meta.get("srs") or {}).get("horizontal", "") or "")
        if h.isdigit():
            native_epsg = int(h)
        progress(f"  EPT native CRS: EPSG:{native_epsg or '?'}")
        dims = [d.get("name") for d in meta.get("schema", [])]
        if "Classification" not in dims:
            progress("  WARNING: no Classification dimension; ground will come "
                     "from a low percentile of all returns instead of class 2")
    except Exception as e:
        progress(f"  Warning: could not read ept.json ({e}); assuming native CRS == UTM")

    utm_epsg = None
    if bbox_latlon:
        lon0 = (bbox_latlon[0] + bbox_latlon[2]) / 2
        lat0 = (bbox_latlon[1] + bbox_latlon[3]) / 2
        zone = int((lon0 + 180) / 6) + 1
        utm_epsg = (32600 + zone) if lat0 >= 0 else (32700 + zone)

    def _latlon_to_native(epsg, ll):
        minLon, minLat, maxLon, maxLat = ll
        R = 6378137.0
        if epsg in (4326, 4269, 4167, 4283, 4019):
            return minLon, maxLon, minLat, maxLat
        if epsg == 3857:
            def m(lon, lat):
                return (math.radians(lon) * R,
                        math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * R)
            x0, y0 = m(minLon, minLat)
            x1, y1 = m(maxLon, maxLat)
            return min(x0, x1), max(x0, x1), min(y0, y1), max(y0, y1)
        return None

    if native_epsg and utm_epsg and native_epsg != utm_epsg:
        conv = _latlon_to_native(native_epsg, bbox_latlon) if bbox_latlon else None
        if conv:
            bx0, bx1, by0, by1 = conv
            progress(f"  Converted bbox to EPSG:{native_epsg}")
        else:
            try:
                from pyproj import Transformer
                t = Transformer.from_crs(f"EPSG:{utm_epsg}", f"EPSG:{native_epsg}",
                                         always_xy=True)
                x0, y0 = t.transform(minE, minN)
                x1, y1 = t.transform(maxE, maxN)
                bx0, bx1 = min(x0, x1), max(x0, x1)
                by0, by1 = min(y0, y1), max(y0, y1)
            except Exception as e:
                progress(f"  Warning: bbox conversion unsupported ({e}); using UTM bounds")
                bx0, bx1, by0, by1 = minE, maxE, minN, maxN
                native_epsg = utm_epsg
    else:
        bx0, bx1, by0, by1 = minE, maxE, minN, maxN

    pipeline = [{"type": "readers.ept", "filename": str(ept_path),
                 "bounds": f"([{bx0},{bx1}],[{by0},{by1}])"}]
    if native_epsg and utm_epsg and native_epsg != utm_epsg:
        pipeline.append({"type": "filters.reprojection",
                         "in_srs": f"EPSG:{native_epsg}",
                         "out_srs": f"EPSG:{utm_epsg}"})

    progress("  Reading EPT (all classes)...")
    p = pdal.Pipeline(_json.dumps({"pipeline": pipeline}))
    p.execute()
    if not p.arrays or len(p.arrays[0]) == 0:
        raise SystemExit("ERROR: no points returned from EPT for this bbox")
    arr = p.arrays[0]

    x = arr["X"].astype(np.float64)
    y = arr["Y"].astype(np.float64)
    z = arr["Z"].astype(np.float64)
    try:
        c = arr["Classification"].astype(np.int16)
    except Exception:
        c = None
        progress("  No Classification in returned data")
    progress(f"  Read {len(x):,} points")
    if c is not None:
        vals, counts = np.unique(c, return_counts=True)
        progress("  Classes: " + ", ".join(f"{v}:{n:,}" for v, n in zip(vals, counts)))
    return x, y, z, c, utm_epsg


# ─────────────────────────────────────────────────────────────────────────────
# Orchestration
# ─────────────────────────────────────────────────────────────────────────────

def derive(x, y, z, classification, cell=None, veg_band=(0.30, 1.50),
           void_depth=-1.0, void_min_points=3, low_cut=-20.0, high_cut=120.0,
           stat="median", progress=print):
    """One pass: ground grid, HAG, vegetation raster, void raster, keep mask."""
    area = (x.max() - x.min()) * (y.max() - y.min())
    n_ground = int((classification == GROUND_CLASS).sum()) if classification is not None else 0
    if cell is None:
        cell = recommend_cell_size(n_ground or len(x), area)
        progress(f"  Auto cell size: {cell} m")

    grid = grid_for_points(x, y, cell)
    per_cell = ground_points_per_cell(x, y, classification, grid)
    progress(f"  {grid}  ground returns/cell: {per_cell:.1f}")
    if 0 < per_cell < 4:
        progress(f"  WARNING: only {per_cell:.1f} ground returns per cell. "
                 f"Below ~4 the per-cell statistic is sampling noise and error "
                 f"rises; consider {recommend_cell_size(n_ground, area)} m cells.")

    ground, direct = build_ground_grid(x, y, z, classification, grid, stat=stat)
    progress(f"  Ground from class {GROUND_CLASS}: "
             f"{direct.mean()*100:.1f}% of cells direct")
    ground = fill_pyramid(ground)

    hag = compute_hag(x, y, z, ground, grid)
    veg, total = band_fraction(x, y, hag, grid, veg_band[0], veg_band[1])
    depth, vcount = void_raster(x, y, hag, grid, void_depth, void_min_points)
    keep = filter_by_hag(hag, low_cut, high_cut)

    progress(f"  HAG: p1 {np.nanpercentile(hag,1):.1f} m, "
             f"p99 {np.nanpercentile(hag,99):.1f} m")
    progress(f"  Filter keeps {keep.sum():,} of {len(x):,} "
             f"({keep.sum()/len(x)*100:.2f}%) — dropped "
             f"{(~keep).sum():,} implausible returns")
    nv = int(np.isfinite(depth).sum())
    progress(f"  Void cells (>= {void_min_points} returns below "
             f"{void_depth} m): {nv:,}")

    return dict(grid=grid, ground=ground, direct=direct, hag=hag,
                veg=veg, total=total, void_depth=depth, void_count=vcount,
                keep=keep, cell=cell, ground_per_cell=per_cell)


def main():
    import argparse, os, json as _json
    ap = argparse.ArgumentParser(
        description="Derive vegetation-density and void rasters from LiDAR.")
    ap.add_argument("--ept", required=True)
    ap.add_argument("--bbox", required=True, nargs=4, type=float,
                    metavar=("minLon", "minLat", "maxLon", "maxLat"))
    ap.add_argument("--out-dir", default="lidar_derived")
    ap.add_argument("--cell", type=float, default=None,
                    help="ground cell size in metres (default: from data density)")
    ap.add_argument("--veg-band", nargs=2, type=float, default=[0.30, 1.50],
                    metavar=("LOW", "HIGH"), help="understory band, metres AGL")
    ap.add_argument("--void-depth", type=float, default=-1.0,
                    help="a return this far below ground counts toward a void")
    ap.add_argument("--void-min-points", type=int, default=3)
    ap.add_argument("--low-cut", type=float, default=-20.0,
                    help="discard returns below this HAG. Garbage removal only: "
                         "keep it generous, real voids live down here")
    ap.add_argument("--high-cut", type=float, default=120.0)
    ap.add_argument("--stat", choices=["median", "mean"], default="median")
    a = ap.parse_args()

    os.makedirs(a.out_dir, exist_ok=True)
    minLon, minLat, maxLon, maxLat = a.bbox

    # Reuse the export's projection helper so both agree on UTM.
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "export_terrain", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                       "export_terrain.py"))
    et = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(et)
    e0, n0 = et.latlon_to_utm(minLat, minLon)
    e1, n1 = et.latlon_to_utm(maxLat, maxLon)
    utm_bbox = (min(e0, e1), min(n0, n1), max(e0, e1), max(n0, n1))
    print(f"[1/4] UTM bbox: {utm_bbox}")

    x, y, z, cls, epsg = read_ept_all_classes(
        a.ept, utm_bbox, (minLon, minLat, maxLon, maxLat),
        progress=lambda m: print(f"[2/4] {m}"))

    r = derive(x, y, z, cls, cell=a.cell, veg_band=tuple(a.veg_band),
               void_depth=a.void_depth, void_min_points=a.void_min_points,
               low_cut=a.low_cut, high_cut=a.high_cut, stat=a.stat,
               progress=lambda m: print(f"[3/4] {m}"))

    g = r["grid"]
    veg_rgba, vlo, vhi = colorize(r["veg"], VEG_RAMP, 0.0,
                                  max(0.05, float(np.nanpercentile(r["veg"], 98))))
    write_png(veg_rgba, os.path.join(a.out_dir, "vegetation.png"))
    write_geotiff(r["veg"], g, os.path.join(a.out_dir, "vegetation.tif"), epsg)

    vd = -r["void_depth"]                       # positive metres below ground
    void_rgba, dlo, dhi = colorize(vd, VOID_RAMP)
    write_png(void_rgba, os.path.join(a.out_dir, "voids.png"))
    write_geotiff(r["void_depth"], g, os.path.join(a.out_dir, "voids.tif"), epsg)
    write_geotiff(r["ground"], g, os.path.join(a.out_dir, "ground.tif"), epsg)

    meta = dict(
        bbox_lonlat=[minLon, minLat, maxLon, maxLat],
        utm_bbox=list(utm_bbox), epsg=epsg, cell=r["cell"],
        grid=[g.nx, g.ny], geotransform=list(g.geotransform()),
        veg_band=list(a.veg_band), veg_range=[vlo, vhi],
        void_depth_threshold=a.void_depth, void_range=[dlo, dhi],
        ground_returns_per_cell=r["ground_per_cell"],
        cells_direct_fraction=float(r["direct"].mean()),
        points_total=int(len(x)), points_kept=int(r["keep"].sum()),
        void_cells=int(np.isfinite(r["void_depth"]).sum()),
    )
    with open(os.path.join(a.out_dir, "derived.json"), "w") as f:
        _json.dump(meta, f, indent=2)
    print(f"[4/4] Wrote {a.out_dir}/ "
          f"(vegetation, voids, ground + derived.json)")


if __name__ == "__main__":
    main()
