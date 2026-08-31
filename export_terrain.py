#!/usr/bin/env python3
"""
export_terrain.py  —  FLEX terrain + cave export pipeline

Usage:
  python export_terrain.py --ept <path/to/ept.json> \
                           --bbox <minLon> <minLat> <maxLon> <maxLat> \
                           --caves <path/to/caves.json> \
                           --out <output.zip> \
                           [--resolution 0.5] [--percentile 2] [--max-triangles 2000000]
"""

import argparse, json, math, os, struct, sys, tempfile, zipfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
VIEWER_BUILD_DIR = SCRIPT_DIR / 'viewer_build'

# Three.js r158 — fetched once and cached in viewer_build/libs/
VIEWER_LIBS = {
    'libs/three.min.js':
        'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js',
    'libs/OrbitControls.js':
        'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js',
    'libs/GLTFLoader.js':
        'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js',
    'libs/jszip.min.js':
        'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
}

import numpy as np
from scipy.interpolate import NearestNDInterpolator
from scipy.stats import binned_statistic_2d
import requests
from PIL import Image
import pygltflib

# ──────────────────────────────────────────────────────────────────────────────
# Coordinate helpers
# ──────────────────────────────────────────────────────────────────────────────

def latlon_to_utm(lat, lon):
    """Approximate WGS84 → UTM (returns easting, northing, zone)."""
    zone = int((lon + 180) / 6) + 1
    lon_rad = math.radians(lon)
    lat_rad = math.radians(lat)
    lon0 = math.radians((zone - 1) * 6 - 180 + 3)
    a, f = 6378137.0, 1 / 298.257223563
    b = a * (1 - f)
    e2 = 1 - (b / a) ** 2
    e = math.sqrt(e2)
    N = a / math.sqrt(1 - e2 * math.sin(lat_rad) ** 2)
    T = math.tan(lat_rad) ** 2
    C = e2 / (1 - e2) * math.cos(lat_rad) ** 2
    A = math.cos(lat_rad) * (lon_rad - lon0)
    M = a * ((1 - e2/4 - 3*e2**2/64 - 5*e2**3/256) * lat_rad
             - (3*e2/8 + 3*e2**2/32 + 45*e2**3/1024) * math.sin(2*lat_rad)
             + (15*e2**2/256 + 45*e2**3/1024) * math.sin(4*lat_rad)
             - (35*e2**3/3072) * math.sin(6*lat_rad))
    k0 = 0.9996
    easting  = k0 * N * (A + (1-T+C)*A**3/6 + (5-18*T+T**2+72*C-58*e2/(1-e2))*A**5/120) + 500000
    northing = k0 * (M + N*math.tan(lat_rad)*(A**2/2 + (5-T+9*C+4*C**2)*A**4/24
                     + (61-58*T+T**2+600*C-330*e2/(1-e2))*A**6/720))
    if lat < 0:
        northing += 10_000_000
    return easting, northing, zone

# ──────────────────────────────────────────────────────────────────────────────
# Step 1 — Read points from EPT
# ──────────────────────────────────────────────────────────────────────────────

def fetch_ept_points(ept_path, utm_bbox, bbox_latlon=None, progress=print):
    """Read ground-classified points from an EPT dataset within a UTM bounding box.

    Automatically detects the EPT dataset's native CRS by reading its ept.json,
    converts the query bbox to that CRS, and reprojects the output to UTM so
    downstream code always works in metres regardless of the source dataset.

    Ground classification strategy (in priority order):
      1. If the dataset already has ground labels (Classification == 2), use them.
      2. Otherwise run PDAL's SMRF filter to classify on the fly.
      3. If both fail, fall back to all returns (CSF cloth applied later).
    """
    try:
        import pdal
    except ImportError:
        sys.exit("ERROR: pdal not installed. Run: conda install -c conda-forge python-pdal")

    MIN_GROUND_PTS = 1000
    minE, minN, maxE, maxN = utm_bbox

    # ── Detect native CRS from ept.json ──────────────────────────────────────
    native_epsg = None
    utm_epsg    = None   # filled in below
    try:
        import urllib.request as _ur
        ept_str = str(ept_path)
        if ept_str.startswith('http'):
            with _ur.urlopen(ept_str, timeout=30) as _r:
                _meta = json.loads(_r.read())
        else:
            with open(ept_str) as _f:
                _meta = json.load(_f)
        _srs = _meta.get('srs', {})
        _h   = str(_srs.get('horizontal', '') or '')
        if _h.isdigit():
            native_epsg = int(_h)
        progress(f"  EPT native CRS: EPSG:{native_epsg or '?'}")
    except Exception as _e:
        progress(f"  Warning: could not read ept.json ({_e}); assuming native CRS == UTM")

    # Derive the UTM EPSG from our bbox (WGS84 UTM)
    if bbox_latlon:
        _lon0 = (bbox_latlon[0] + bbox_latlon[2]) / 2
        _lat0 = (bbox_latlon[1] + bbox_latlon[3]) / 2
        _zone = int((_lon0 + 180) / 6) + 1
        utm_epsg = (32600 + _zone) if _lat0 >= 0 else (32700 + _zone)

    # Convert bbox to native CRS if different from UTM.
    # Uses pure math for common CRSs so pyproj is not required.
    def _latlon_to_native(epsg, ll_bbox):
        """Convert (minLon,minLat,maxLon,maxLat) to the target EPSG bbox."""
        import math
        minLon, minLat, maxLon, maxLat = ll_bbox
        R = 6378137.0
        if epsg in (4326, 4269, 4167, 4283, 4019):  # geographic (degrees)
            return minLon, maxLon, minLat, maxLat
        elif epsg == 3857:                             # Web Mercator
            def _m(lon, lat):
                x = math.radians(lon) * R
                y = math.log(math.tan(math.pi/4 + math.radians(lat)/2)) * R
                return x, y
            x0, y0 = _m(minLon, minLat);  x1, y1 = _m(maxLon, maxLat)
            return min(x0,x1), max(x0,x1), min(y0,y1), max(y0,y1)
        else:
            return None  # unknown — will fall back

    if native_epsg and utm_epsg and native_epsg != utm_epsg:
        _converted = _latlon_to_native(native_epsg, bbox_latlon) if bbox_latlon else None
        if _converted:
            _bx0, _bx1, _by0, _by1 = _converted
            progress(f"  Converted bbox to EPSG:{native_epsg}: "
                     f"X [{_bx0:.1f},{_bx1:.1f}] Y [{_by0:.1f},{_by1:.1f}]")
        else:
            # Try pyproj as last resort
            try:
                from pyproj import Transformer
                _t = Transformer.from_crs(f"EPSG:{utm_epsg}", f"EPSG:{native_epsg}", always_xy=True)
                _x0, _y0 = _t.transform(minE, minN)
                _x1, _y1 = _t.transform(maxE, maxN)
                _bx0, _bx1 = min(_x0,_x1), max(_x0,_x1)
                _by0, _by1 = min(_y0,_y1), max(_y0,_y1)
                progress(f"  Converted bbox via pyproj to EPSG:{native_epsg}")
            except Exception as _e:
                progress(f"  Warning: bbox conversion unsupported for EPSG:{native_epsg} ({_e}); using UTM bounds")
                _bx0, _bx1, _by0, _by1 = minE, maxE, minN, maxN
                native_epsg = utm_epsg
    else:
        _bx0, _bx1, _by0, _by1 = minE, maxE, minN, maxN

    bounds_str = f"([{_bx0},{_bx1}],[{_by0},{_by1}])"

    # Reprojection step — added to every pipeline if native CRS != UTM
    reproj_step = []
    if native_epsg and utm_epsg and native_epsg != utm_epsg:
        reproj_step = [{"type": "filters.reprojection",
                        "in_srs":  f"EPSG:{native_epsg}",
                        "out_srs": f"EPSG:{utm_epsg}"}]

    def _run(extra_filters):
        pipeline = [{"type": "readers.ept", "filename": str(ept_path),
                     "bounds": bounds_str}] + reproj_step + extra_filters
        p = pdal.Pipeline(json.dumps({"pipeline": pipeline}))
        p.execute()
        return p.arrays[0] if p.arrays else None

    # ── Step A: try existing Classification==2 labels ────────────────────────
    progress("  Fetching EPT points (attempting pre-classified ground)...")
    arr = _run([{"type": "filters.range", "limits": "Classification[2:2]"}])
    if arr is not None and len(arr) >= MIN_GROUND_PTS:
        progress(f"  Using pre-classified ground: {len(arr):,} points")
    else:
        # ── Step B: run SMRF to classify ground on the fly ───────────────────
        progress("  No pre-classified ground found — running SMRF ground filter...")
        try:
            arr = _run([
                {"type": "filters.smrf",
                 "ignore": "Classification[7:7]",
                 "slope": 0.2, "window": 18, "threshold": 0.5, "scalar": 1.2},
                {"type": "filters.range", "limits": "Classification[2:2]"}
            ])
            if arr is not None and len(arr) >= MIN_GROUND_PTS:
                progress(f"  SMRF ground classification: {len(arr):,} ground points")
            else:
                raise RuntimeError("Too few ground points after SMRF")
        except Exception as e:
            # ── Step C: fallback — all returns, cloth handles it ─────────────
            progress(f"  WARNING: SMRF failed ({e}) — using all returns (cloth fallback)")
            arr = _run([])
            if arr is None or len(arr) == 0:
                sys.exit("ERROR: No points returned from EPT for this bbox")
            progress(f"  Fallback: {len(arr):,} points (all returns)")

    x = arr['X'].astype(np.float64)
    y = arr['Y'].astype(np.float64)
    z = arr['Z'].astype(np.float64)
    try:
        r = (arr['Red']   / 256).astype(np.uint8)
        g = (arr['Green'] / 256).astype(np.uint8)
        b = (arr['Blue']  / 256).astype(np.uint8)
    except Exception:
        r = g = b = np.full(len(x), 180, dtype=np.uint8)
    progress(f"  Fetched {len(x):,} points")
    return x, y, z, r, g, b

# ──────────────────────────────────────────────────────────────────────────────
# Step 2 — Minimum-surface DEM (2nd percentile per cell)
# ──────────────────────────────────────────────────────────────────────────────

def build_dem(x, y, z, resolution, csf_iterations=500, progress=print):
    """
    Build a ground DEM using cloth-simulation-from-below (CSF).

    The cloth is initialised at the minimum-Z per cell (the lowest lidar return),
    then Laplacian smoothing is applied iteratively with collision constraints:
      - Ground cells: anchored at their actual minimum Z (collision keeps cloth ≤ min_z).
      - Tree/canopy cells: no ground return → cloth is pulled DOWN to neighbour level
        by Laplacian tension. They never affect the cloth's final position.
      - Cave/depression cells: min_z is genuinely low → cloth correctly dips there.

    This is equivalent to the Zhang et al. (2016) CSF algorithm but operating
    on the original (non-inverted) cloud, rising from below.
    """
    progress(f"  Building CSF cloth DEM at {resolution}m resolution...")
    x_min, x_max = x.min(), x.max()
    y_min, y_max = y.min(), y.max()
    x_bins = np.arange(x_min, x_max + resolution, resolution)
    y_bins = np.arange(y_min, y_max + resolution, resolution)

    # ── Minimum Z per cell (lowest hit = first contact from below) ────────────
    min_z, _, _, _ = binned_statistic_2d(x, y, z, statistic='min', bins=[x_bins, y_bins])

    # Fill empty cells (no returns) with nearest-neighbour interpolation
    rows, cols = min_z.shape
    xi, yi = np.meshgrid(np.arange(rows), np.arange(cols), indexing='ij')
    valid = np.isfinite(min_z)
    if not valid.all():
        interp = NearestNDInterpolator(
            list(zip(xi[valid], yi[valid])), min_z[valid]
        )
        min_z[~valid] = interp(xi[~valid], yi[~valid])

    # ── Cloth simulation ──────────────────────────────────────────────────────
    # Initialise cloth at min_z everywhere (already at ground for ground cells,
    # at tree-top for tree-only cells).  Smoothing pulls tree cells down;
    # collision prevents ground cells from being pulled above their real minimum.
    cloth = min_z.copy()
    progress(f"  CSF: {csf_iterations} smoothing iterations over {rows}×{cols} grid...")
    for it in range(csf_iterations):
        # Laplacian smoothing (4-neighbour average with edge padding)
        padded = np.pad(cloth, 1, mode='edge')
        cloth = (padded[:-2, 1:-1] + padded[2:, 1:-1] +
                 padded[1:-1, :-2] + padded[1:-1, 2:]) / 4.0
        # Collision: cloth cannot rise above the actual lowest return in each cell
        cloth = np.minimum(cloth, min_z)

    n_corrected = int((cloth < min_z - 0.05).sum())
    progress(f"  CSF done — {n_corrected:,} tree/canopy cells corrected")
    progress(f"  DEM grid: {rows}×{cols} ({rows*cols:,} cells)")
    return cloth, x_bins, y_bins, x_min, y_min


def filter_spikes(dem, resolution, radius_m=10.0, threshold_m=1.5, progress=print):
    """
    One-sided spike filter: removes upward outliers (trees, buildings) while
    leaving downward features (caves, sinkholes, depressions) completely untouched.

    For each cell, compute the local median over a window of radius_m metres.
    Cells that are more than threshold_m ABOVE the local median are replaced
    with the local median.  Cells at or below the median are never touched.
    """
    from scipy.ndimage import median_filter
    window = max(3, int(round(radius_m / resolution)) * 2 + 1)
    progress(f"  Spike filter: radius={radius_m}m ({window}-cell window), "
             f"threshold={threshold_m}m...")
    ref = median_filter(dem.astype(np.float32), size=window)
    delta = dem - ref
    spikes = delta > threshold_m
    n_spikes = int(spikes.sum())
    dem_clean = dem.copy()
    dem_clean[spikes] = ref[spikes]
    progress(f"  Spike filter: replaced {n_spikes:,} upward outlier cells "
             f"({n_spikes * 100.0 / dem.size:.1f}% of grid)")
    return dem_clean

# ──────────────────────────────────────────────────────────────────────────────
# Step 3 — Build TIN mesh from DEM grid
# ──────────────────────────────────────────────────────────────────────────────

def build_mesh(dem, x_bins, y_bins, x_origin, y_origin, max_triangles=2_000_000, progress=print):
    """
    Build a curvature-adaptive TIN mesh from a DEM grid.

    Flat areas get a coarse background subgrid; high-curvature areas (ridges,
    sinkholes, cave entrances, rock outcrops) keep full resolution.  The result
    is a Delaunay triangulation of this importance-sampled point set, so flat
    terrain never wastes triangles.

    Algorithm
    ---------
    1. Compute |Laplacian| curvature of the smoothed DEM.
    2. Select a background subgrid at `flat_step` spacing (controls max triangle
       size in flat areas).
    3. Separately budget ~half of max_triangles for high-curvature vertices
       (those with the top-N curvature scores).
    4. Delaunay-triangulate the union of both sets.
    5. Quadric-decimate if still over max_triangles (trimesh, optional).
    """
    from scipy.ndimage import laplace, uniform_filter
    from scipy.spatial import Delaunay

    rows, cols = dem.shape
    dx = float(x_bins[1] - x_bins[0])
    dy = float(y_bins[1] - y_bins[0])
    n_cells = rows * cols

    # ── 1. Curvature map ──────────────────────────────────────────────────────
    # Smooth the DEM slightly to kill per-point noise before computing Laplacian
    smoothed = uniform_filter(dem.astype(np.float32), size=5)
    curv = np.abs(laplace(smoothed)).ravel()   # flat → ~0, ridges/sinkholes → large
    # Normalise against robust max (99th pct) to ignore extreme outliers
    curv_scale = float(np.percentile(curv, 99)) + 1e-9
    curv_norm = np.clip(curv / curv_scale, 0.0, 1.0)

    # ── 2. Background subgrid (flat areas) ───────────────────────────────────
    # flat_step: coarse spacing for genuinely flat cells.
    # Chosen so the subgrid alone produces roughly max_triangles/4 triangles.
    flat_step = max(2, int(math.sqrt(n_cells / (max_triangles / 4))))
    flat_step = min(flat_step, 32)   # never coarser than 32 cells

    sub_r = np.zeros(rows, dtype=bool); sub_r[::flat_step] = True
    sub_c = np.zeros(cols, dtype=bool); sub_c[::flat_step] = True
    subgrid_mask = (np.outer(sub_r, sub_c)).ravel()

    # ── 3. High-curvature vertices ────────────────────────────────────────────
    # Budget for curvature vertices: fill up to max_triangles/2 total vertices
    # (Delaunay produces ~2× as many triangles as vertices for a dense set)
    n_subgrid = int(subgrid_mask.sum())
    n_border  = 2 * rows + 2 * (cols - 2)   # rough border count
    n_curv_budget = max(0, max_triangles // 2 - n_subgrid - n_border)

    if n_curv_budget > 0 and n_curv_budget < n_cells:
        # Select top-N cells by curvature score
        threshold = float(np.partition(curv_norm, n_cells - n_curv_budget)
                          [n_cells - n_curv_budget])
        curv_mask = curv_norm >= threshold
    else:
        curv_mask = np.zeros(n_cells, dtype=bool)

    # ── 4. Union + border ─────────────────────────────────────────────────────
    keep = (subgrid_mask | curv_mask).reshape(rows, cols)
    keep[0, :] = keep[-1, :] = keep[:, 0] = keep[:, -1] = True   # always keep border

    r_idx, c_idx = np.where(keep)
    n_verts = len(r_idx)
    pct = n_verts * 100.0 / n_cells
    progress(f"  Adaptive sampling: {n_verts:,} vertices "
             f"({pct:.1f}% of {n_cells:,} grid cells, "
             f"flat step={flat_step}×{dx:.1f}m = {flat_step*dx:.0f}m triangles in flat areas)")

    # ── 5. Physical positions (centred on grid centre) ────────────────────────
    # dem.shape = (n_x_bins, n_y_bins): rows → easting (X), cols → northing (Y)
    vx = (r_idx * dx - (rows - 1) * dx / 2.0).astype(np.float32)   # row  → easting
    vy = (c_idx * dy - (cols - 1) * dy / 2.0).astype(np.float32)   # col  → northing
    vz = dem[r_idx, c_idx].astype(np.float32)
    vertices = np.column_stack([vx, vy, vz])

    # ── 6. 2-D Delaunay triangulation ─────────────────────────────────────────
    progress("  Delaunay triangulation...")
    tri = Delaunay(np.column_stack([vx.astype(np.float64),
                                     vy.astype(np.float64)]))
    faces = tri.simplices.astype(np.uint32)
    progress(f"  Adaptive mesh: {len(vertices):,} verts, {len(faces):,} tris")

    # ── 7. Optional quadric decimation if still over budget ───────────────────
    if len(faces) > max_triangles:
        try:
            import trimesh
            mesh = trimesh.Trimesh(vertices=vertices, faces=faces)
            ratio = max_triangles / len(faces)
            mesh = mesh.simplify_quadric_decimation(int(len(faces) * ratio))
            vertices = np.array(mesh.vertices, dtype=np.float32)
            faces    = np.array(mesh.faces,    dtype=np.uint32)
            progress(f"  Decimated: {len(vertices):,} verts, {len(faces):,} tris")
        except ImportError:
            progress("  WARNING: trimesh not installed — cannot further reduce triangle count")

    return vertices, faces

# ──────────────────────────────────────────────────────────────────────────────
# Step 4 — Fetch satellite texture
# ──────────────────────────────────────────────────────────────────────────────

def _physical_tex_dims(minLon, minLat, maxLon, maxLat, tex_size):
    """Return (tex_w, tex_h) matching the physical aspect ratio of the bbox."""
    lat_mid = (minLat + maxLat) / 2
    km_ew = (maxLon - minLon) * 111.32 * math.cos(math.radians(lat_mid))
    km_ns = (maxLat - minLat) * 111.32
    if km_ew >= km_ns:
        return tex_size, max(64, round(tex_size * km_ns / km_ew)), km_ew, km_ns
    else:
        return max(64, round(tex_size * km_ew / km_ns)), tex_size, km_ew, km_ns


def _fetch_esri(bbox_latlon, tex_size, progress):
    """
    Fetch ESRI World Imagery tiles and stitch — same source FLEX uses for its
    'Bing Maps Aerial' minimap layer (tile/{z}/{y}/{x} endpoint, no key needed).

    Zoom is chosen so native tile pixels exceed tex_size on the long axis.
    The stitched canvas is cropped to the precise geographic bbox then
    downsampled to tex_size (preserving aspect ratio).
    """
    import io as _io
    from PIL import Image as _PILImage
    _PILImage.MAX_IMAGE_PIXELS = None   # we build this canvas ourselves; no bomb risk
    minLon, minLat, maxLon, maxLat = bbox_latlon
    lat_mid = (minLat + maxLat) / 2

    # ── helpers (Web Mercator tile math) ─────────────────────────────────────
    def _tile_xy(lon, lat, z):
        n = 2 ** z
        tx = int((lon + 180) / 360 * n)
        lat_r = math.radians(lat)
        ty = int((1 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2 * n)
        return tx, max(0, min(ty, n - 1))

    def _px(lon, lat, z, tile_size=256):
        n = 2 ** z
        wx = (lon + 180) / 360 * n * tile_size
        lat_r = math.radians(lat)
        wy = (1 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2 * n * tile_size
        return wx, wy

    # ── choose zoom ───────────────────────────────────────────────────────────
    km_ew = (maxLon - minLon) * 111.32 * math.cos(math.radians(lat_mid))
    km_ns = (maxLat - minLat) * 111.32
    extent_m = max(km_ew, km_ns) * 1000
    zoom = max(10, min(19, math.ceil(
        math.log2(tex_size * 156543.034 * math.cos(math.radians(lat_mid)) / extent_m)
    )))

    # ── tile range ────────────────────────────────────────────────────────────
    tx_nw, ty_nw = _tile_xy(minLon, maxLat, zoom)
    tx_se, ty_se = _tile_xy(maxLon, minLat, zoom)
    n_tx = tx_se - tx_nw + 1
    n_ty = ty_se - ty_nw + 1
    progress(f"  ESRI tiles zoom={zoom}, {n_tx}×{n_ty}={n_tx*n_ty} tiles "
             f"({km_ew:.1f}×{km_ns:.1f} km)...")

    TILE = 256
    BASE = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile"
    canvas = Image.new('RGB', (n_tx * TILE, n_ty * TILE), (120, 120, 120))
    fetched = 0
    for ty in range(ty_nw, ty_se + 1):
        for tx in range(tx_nw, tx_se + 1):
            url = f"{BASE}/{zoom}/{ty}/{tx}"
            try:
                r = requests.get(url, timeout=15,
                                 headers={'User-Agent': 'Mozilla/5.0 (compatible; FLEX/1.0)'})
                r.raise_for_status()
                tile_img = Image.open(_io.BytesIO(r.content)).convert('RGB')
                canvas.paste(tile_img, ((tx - tx_nw) * TILE, (ty - ty_nw) * TILE))
                fetched += 1
            except Exception as e:
                progress(f"  WARNING: tile z={zoom}/{ty}/{tx} failed: {e}")

    if fetched == 0:
        raise RuntimeError("All ESRI tiles failed — no imagery fetched")
    progress(f"  Fetched {fetched}/{n_tx*n_ty} tiles")

    # ── crop to exact bbox ───────────────────────────────────────────────────
    wx0, wy0 = _px(minLon, maxLat, zoom)
    wx1, wy1 = _px(maxLon, minLat, zoom)
    ox = (tx_nw * TILE)
    oy = (ty_nw * TILE)
    box = (int(wx0 - ox), int(wy0 - oy), int(wx1 - ox), int(wy1 - oy))
    box = (max(0, box[0]), max(0, box[1]),
           min(canvas.width,  box[2]), min(canvas.height, box[3]))
    canvas = canvas.crop(box)

    # ── resize to requested tex_size (preserve aspect) ───────────────────────
    tex_w, tex_h = _physical_tex_dims(minLon, minLat, maxLon, maxLat, tex_size)[:2]
    canvas = canvas.resize((tex_w, tex_h), Image.LANCZOS)
    progress(f"  ESRI texture: {canvas.size[0]}×{canvas.size[1]} px")
    return canvas


def _fetch_bing(bbox_latlon, tex_size, progress):
    """
    Fetch Bing Maps Aerial tiles, stitch and crop to exact bbox.

    Uses the standard Bing quadkey tile system.  Tiles are 256×256 JPEG.
    Zoom level is chosen automatically to exceed tex_size native pixels on the
    long axis.  The stitched canvas is cropped to the precise geographic bbox
    then downsampled to the requested tex_size (physical-aspect-ratio output).
    """
    import io as _io, random as _rand
    from PIL import Image as _PILImage
    _PILImage.MAX_IMAGE_PIXELS = None   # we build this canvas ourselves; no bomb risk
    minLon, minLat, maxLon, maxLat = bbox_latlon
    lat_mid = (minLat + maxLat) / 2

    # ── helper functions ──────────────────────────────────────────────────────
    def _tile_xy(lon, lat, z):
        n = 2 ** z
        tx = int((lon + 180) / 360 * n)
        lat_r = math.radians(lat)
        ty = int((1 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2 * n)
        return tx, max(0, min(ty, n - 1))

    def _quadkey(tx, ty, z):
        key = []
        for i in range(z, 0, -1):
            d = 0
            mask = 1 << (i - 1)
            if tx & mask: d |= 1
            if ty & mask: d |= 2
            key.append(str(d))
        return ''.join(key)

    def _px(lon, lat, z, tile_size=256):
        """World-pixel coordinates at zoom z (y=0 at north)."""
        n = 2 ** z
        wx = (lon + 180) / 360 * n * tile_size
        lat_r = math.radians(lat)
        wy = (1 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2 * n * tile_size
        return wx, wy

    # ── choose zoom ───────────────────────────────────────────────────────────
    km_ew = (maxLon - minLon) * 111.32 * math.cos(math.radians(lat_mid))
    km_ns = (maxLat - minLat) * 111.32
    extent_m = max(km_ew, km_ns) * 1000
    # native m/px at zoom z = 156543.034 * cos(lat_mid_rad) / 2^z
    # we want m/px <= extent_m / tex_size  →  zoom >= log2(tex_size * 156543 * cos / extent_m)
    zoom = max(10, min(19, math.ceil(
        math.log2(tex_size * 156543.034 * math.cos(math.radians(lat_mid)) / extent_m)
    )))

    # ── tile range ────────────────────────────────────────────────────────────
    tx_nw, ty_nw = _tile_xy(minLon, maxLat, zoom)
    tx_se, ty_se = _tile_xy(maxLon, minLat, zoom)
    n_tx = tx_se - tx_nw + 1
    n_ty = ty_se - ty_nw + 1
    progress(f"  Bing zoom={zoom}, {n_tx}×{n_ty}={n_tx*n_ty} tiles "
             f"({km_ew:.1f}×{km_ns:.1f} km)...")

    TILE = 256
    canvas = Image.new('RGB', (n_tx * TILE, n_ty * TILE), (120, 120, 120))
    fetched = 0
    for ty in range(ty_nw, ty_se + 1):
        for tx in range(tx_nw, tx_se + 1):
            qk  = _quadkey(tx, ty, zoom)
            srv = _rand.randint(0, 3)
            url = f'https://ecn.t{srv}.tiles.virtualearth.net/tiles/a{qk}.jpeg?g=1'
            try:
                r = requests.get(url, timeout=15,
                                 headers={'User-Agent': 'FLEX-CaveViewer/1.0'})
                r.raise_for_status()
                tile_img = Image.open(_io.BytesIO(r.content)).convert('RGB')
                canvas.paste(tile_img, ((tx - tx_nw) * TILE, (ty - ty_nw) * TILE))
                fetched += 1
            except Exception as e:
                progress(f"  WARNING: tile {qk} failed: {e}")

    progress(f"  Fetched {fetched}/{n_tx*n_ty} tiles")

    # ── crop to exact bbox ───────────────────────────────────────────────────
    wx0, wy0 = _px(minLon, maxLat, zoom)   # north-west corner (top-left)
    wx1, wy1 = _px(maxLon, minLat, zoom)   # south-east corner (bottom-right)
    ox = tx_nw * TILE
    oy = ty_nw * TILE
    box = (max(0, int(wx0 - ox)),  max(0, int(wy0 - oy)),
           min(canvas.width,  math.ceil(wx1 - ox)),
           min(canvas.height, math.ceil(wy1 - oy)))
    cropped = canvas.crop(box)

    # ── resize to physical-aspect-ratio output ────────────────────────────────
    tex_w, tex_h, _, _ = _physical_tex_dims(minLon, minLat, maxLon, maxLat, tex_size)
    result = cropped.resize((tex_w, tex_h), Image.LANCZOS)
    progress(f"  Bing texture: {result.size[0]}×{result.size[1]} px")
    return result


def _fetch_xyz_tiles(bbox_latlon, tex_size, url_template, tile_px=256, progress=print):
    """
    Generic XYZ slippy-map tile fetcher.

    url_template: string with {z}, {x}, {y} placeholders.
    tile_px:      actual pixel size of each fetched tile (256 or 512 for @2x).
    URL order is {z}/{x}/{y} (standard XYZ / Mapbox / OpenStreetMap).
    """
    import io as _io
    from PIL import Image as _PILImage
    _PILImage.MAX_IMAGE_PIXELS = None   # we build this canvas ourselves; no bomb risk
    minLon, minLat, maxLon, maxLat = bbox_latlon
    lat_mid = (minLat + maxLat) / 2

    def _tile_xy(lon, lat, z):
        n = 2 ** z
        tx = int((lon + 180) / 360 * n)
        lat_r = math.radians(lat)
        ty = int((1 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2 * n)
        return tx, max(0, min(ty, n - 1))

    def _px(lon, lat, z):
        """World-pixel coords at zoom z (y=0 at north), tile_px per tile."""
        n = 2 ** z
        wx = (lon + 180) / 360 * n * tile_px
        lat_r = math.radians(lat)
        wy = (1 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2 * n * tile_px
        return wx, wy

    # Choose zoom: want native coverage >= tex_size on long axis
    km_ew = (maxLon - minLon) * 111.32 * math.cos(math.radians(lat_mid))
    km_ns = (maxLat - minLat) * 111.32
    extent_m = max(km_ew, km_ns) * 1000
    # m/px at zoom z = 156543.034 * cos(lat) / 2^z  (for 256-px tiles)
    # for tile_px tiles, scale: 156543.034 * (tile_px/256) * cos / 2^z
    zoom = max(10, min(19, math.ceil(
        math.log2(tex_size * 156543.034 * (tile_px / 256) *
                  math.cos(math.radians(lat_mid)) / extent_m)
    )))

    tx_nw, ty_nw = _tile_xy(minLon, maxLat, zoom)
    tx_se, ty_se = _tile_xy(maxLon, minLat, zoom)
    n_tx = tx_se - tx_nw + 1
    n_ty = ty_se - ty_nw + 1
    progress(f"  XYZ zoom={zoom}, {n_tx}×{n_ty}={n_tx*n_ty} tiles "
             f"({km_ew:.1f}×{km_ns:.1f} km), tile_px={tile_px}...")

    canvas = Image.new('RGB', (n_tx * tile_px, n_ty * tile_px), (120, 120, 120))
    fetched = 0
    for ty in range(ty_nw, ty_se + 1):
        for tx in range(tx_nw, tx_se + 1):
            url = url_template.replace('{z}', str(zoom)) \
                               .replace('{x}', str(tx)) \
                               .replace('{y}', str(ty))
            try:
                r = requests.get(url, timeout=20,
                                 headers={'User-Agent': 'FLEX-CaveViewer/1.0'})
                r.raise_for_status()
                tile_img = Image.open(_io.BytesIO(r.content)).convert('RGB')
                # Resize to tile_px if server returned different size
                if tile_img.size != (tile_px, tile_px):
                    tile_img = tile_img.resize((tile_px, tile_px), Image.LANCZOS)
                canvas.paste(tile_img, ((tx - tx_nw) * tile_px, (ty - ty_nw) * tile_px))
                fetched += 1
            except Exception as e:
                progress(f"  WARNING: tile {zoom}/{tx}/{ty} failed: {e}")

    progress(f"  Fetched {fetched}/{n_tx*n_ty} tiles")
    if fetched == 0:
        raise RuntimeError("All tiles failed")

    # Crop to exact bbox
    wx0, wy0 = _px(minLon, maxLat, zoom)
    wx1, wy1 = _px(maxLon, minLat, zoom)
    ox = tx_nw * tile_px
    oy = ty_nw * tile_px
    box = (max(0, int(wx0 - ox)), max(0, int(wy0 - oy)),
           min(canvas.width,  math.ceil(wx1 - ox)),
           min(canvas.height, math.ceil(wy1 - oy)))
    cropped = canvas.crop(box)

    tex_w, tex_h, _, _ = _physical_tex_dims(minLon, minLat, maxLon, maxLat, tex_size)
    result = cropped.resize((tex_w, tex_h), Image.LANCZOS)
    progress(f"  XYZ texture: {result.size[0]}×{result.size[1]} px")
    return result


def _fetch_mapbox(bbox_latlon, tex_size, url_template, progress=print):
    """
    Fetch tiles from a Mapbox Styles tile endpoint.
    The URL template uses {z}/{x}/{y} with @2x suffix (512 px tiles).
    """
    return _fetch_xyz_tiles(bbox_latlon, tex_size, url_template,
                            tile_px=512, progress=progress)


def fetch_satellite_texture(bbox_latlon, tex_size=8192, source='esri', progress=print):
    """Download satellite imagery.
    source='esri' (default) — tile-stitched ESRI World Imagery (same as FLEX)
    source='bing'            — Bing Maps Aerial tile-stitched
    """
    minLon, minLat, maxLon, maxLat = bbox_latlon
    fallback_size = _physical_tex_dims(minLon, minLat, maxLon, maxLat, tex_size)[:2]
    try:
        if source == 'bing':
            return _fetch_bing(bbox_latlon, tex_size, progress)
        else:
            return _fetch_esri(bbox_latlon, tex_size, progress)
    except Exception as e:
        progress(f"  WARNING: {source} imagery failed ({e}), trying Bing fallback...")
        try:
            return _fetch_bing(bbox_latlon, tex_size, progress)
        except Exception as e2:
            progress(f"  WARNING: Bing also failed ({e2}). Using grey.")
            return Image.new('RGB', fallback_size, (160, 160, 160))

# ──────────────────────────────────────────────────────────────────────────────
# Step 5 — Compute UV coordinates
# ──────────────────────────────────────────────────────────────────────────────

def compute_uvs(vertices, dem_shape, x_bins, y_bins):
    """
    Map vertex XY positions to UV texture coordinates [0..1].

    glTF UV convention: V=0 at top (north/maxLat), V=1 at bottom (south/minLat).
    Our Y axis increases northward, so V must be flipped: V = 1 - normalised_Y.
    U is unchanged: U=0 at west, U=1 at east.
    """
    x_range = (x_bins[-1] - x_bins[0])
    y_range = (y_bins[-1] - y_bins[0])
    x_mid = x_range / 2
    y_mid = y_range / 2
    u =       (vertices[:, 0] + x_mid) / x_range
    v = 1.0 - (vertices[:, 1] + y_mid) / y_range   # flip for glTF top-left origin
    return np.column_stack([u, v]).astype(np.float32)

# ──────────────────────────────────────────────────────────────────────────────
# Step 6 — Export GLB
# ──────────────────────────────────────────────────────────────────────────────

def export_glb(vertices, faces, uvs, out_path, progress=print):
    """Package vertices + faces + UVs into a geometry-only GLB (no embedded texture).

    The texture is handled separately as TERRAIN_TEX_B64 in the viewer HTML,
    applied via THREE.js with explicit flipY=false.  This avoids the flipY
    mismatch that occurs when GLTFLoader loads a data: URI texture from the
    GLB JSON chunk — in that code path THREE r128 cannot have its flipY
    overridden, which stretches/mirrors the satellite image.
    """
    progress("  Packaging GLB (geometry only)...")
    vert_bytes = vertices.astype(np.float32).tobytes()
    face_bytes = faces.astype(np.uint32).tobytes()
    uv_bytes   = uvs.astype(np.float32).tobytes()

    def pad4(b): return b + b'\x00' * ((4 - len(b) % 4) % 4)
    vert_off  = 0
    face_off  = len(pad4(vert_bytes))
    uv_off    = face_off + len(pad4(face_bytes))
    total_bin = uv_off   + len(pad4(uv_bytes))
    blob = pad4(vert_bytes) + pad4(face_bytes) + pad4(uv_bytes)

    v_min = vertices.min(axis=0).tolist()
    v_max = vertices.max(axis=0).tolist()

    gltf = pygltflib.GLTF2(
        scene=0,
        scenes=[pygltflib.Scene(nodes=[0])],
        nodes=[pygltflib.Node(mesh=0)],
        meshes=[pygltflib.Mesh(primitives=[pygltflib.Primitive(
            attributes=pygltflib.Attributes(POSITION=0, TEXCOORD_0=2),
            indices=1, material=0
        )])],
        # Plain white material — the viewer replaces it with the satellite texture
        materials=[pygltflib.Material(
            pbrMetallicRoughness=pygltflib.PbrMetallicRoughness(
                metallicFactor=0.0, roughnessFactor=1.0
            ),
            doubleSided=True
        )],
        accessors=[
            pygltflib.Accessor(bufferView=0, componentType=pygltflib.FLOAT,
                count=len(vertices), type=pygltflib.VEC3, min=v_min, max=v_max),
            pygltflib.Accessor(bufferView=1, componentType=pygltflib.UNSIGNED_INT,
                count=len(faces)*3, type=pygltflib.SCALAR),
            pygltflib.Accessor(bufferView=2, componentType=pygltflib.FLOAT,
                count=len(uvs), type=pygltflib.VEC2),
        ],
        bufferViews=[
            pygltflib.BufferView(buffer=0, byteOffset=vert_off, byteLength=len(vert_bytes),
                target=pygltflib.ARRAY_BUFFER),
            pygltflib.BufferView(buffer=0, byteOffset=face_off, byteLength=len(face_bytes),
                target=pygltflib.ELEMENT_ARRAY_BUFFER),
            pygltflib.BufferView(buffer=0, byteOffset=uv_off,  byteLength=len(uv_bytes),
                target=pygltflib.ARRAY_BUFFER),
        ],
        buffers=[pygltflib.Buffer(byteLength=total_bin)],
    )
    gltf.set_binary_blob(blob)
    gltf.save_binary(str(out_path))
    size_mb = os.path.getsize(out_path) / 1e6
    progress(f"  GLB saved: {out_path} ({size_mb:.1f} MB)")

# ──────────────────────────────────────────────────────────────────────────────
# Step 7 — Download / cache Three.js viewer libs
# ──────────────────────────────────────────────────────────────────────────────

def get_viewer_libs(progress=print):
    """Download Three.js libs to viewer_build/libs/ (cached; re-downloaded only if missing)."""
    libs_dir = VIEWER_BUILD_DIR / 'libs'
    libs_dir.mkdir(parents=True, exist_ok=True)
    result = {}
    for zip_path, url in VIEWER_LIBS.items():
        fname = Path(zip_path).name
        local = libs_dir / fname
        if not local.exists() or local.stat().st_size < 1000:
            progress(f"  Downloading {fname}...")
            try:
                r = requests.get(url, timeout=60)
                r.raise_for_status()
                local.write_bytes(r.content)
                progress(f"  Cached {fname} ({len(r.content)//1024} KB)")
            except Exception as e:
                progress(f"  WARNING: Could not download {fname}: {e}")
                local = None
        else:
            progress(f"  {fname}: cached ({local.stat().st_size//1024} KB)")
        result[zip_path] = local
    return result


def build_inline_viewer(glb_path, tex_b64, caves_data, viewer_libs, progress=print,
                        hs_b64=None):
    """
    Build a fully self-contained HTML file:
      - Three.js libs inlined as <script> blocks
      - terrain.glb (geometry only) embedded as base64
      - satellite texture embedded as separate base64 (flipY=false in viewer)
      - optional hillshade texture embedded as TERRAIN_HS_B64
      - caves_data embedded as a JSON literal

    The result opens directly in any mobile browser with no server needed.
    """
    import base64

    viewer_html_path = VIEWER_BUILD_DIR / 'viewer.html'
    if not viewer_html_path.exists():
        progress("  WARNING: viewer.html not found in viewer_build/")
        return '<p>viewer.html missing. Run export from FLEX directory.</p>'

    html = viewer_html_path.read_text(encoding='utf-8')

    # 1. Inline Three.js lib <script src=...> tags
    for zip_path, local in viewer_libs.items():
        fname = Path(zip_path).name
        src_tag = f'<script src="libs/{fname}"></script>'
        if src_tag not in html:
            continue
        if local and local.exists():
            js = local.read_text(encoding='utf-8', errors='replace')
            html = html.replace(src_tag, f'<script>\n{js}\n</script>')
            progress(f"  Inlined {fname} ({len(js)//1024} KB)")
        else:
            progress(f"  WARNING: {fname} not available — viewer may not work offline")

    # 2. Embed terrain.glb as base64
    progress(f"  Encoding terrain.glb as base64...")
    glb_bytes = Path(glb_path).read_bytes()
    glb_b64   = base64.b64encode(glb_bytes).decode('ascii')
    progress(f"  GLB base64: {len(glb_b64)//1024} KB")
    html = html.replace('"PLACEHOLDER_GLB_B64"', f'"{glb_b64}"')

    # 3. Embed satellite texture as separate base64 (viewer applies with flipY=false)
    progress(f"  Embedding satellite texture ({len(tex_b64)//1024} KB)...")
    html = html.replace('"PLACEHOLDER_TEX_B64"', f'"{tex_b64}"')

    # 4. Embed hillshade texture if provided
    if hs_b64:
        progress(f"  Embedding hillshade texture ({len(hs_b64)//1024} KB)...")
        html = html.replace('"PLACEHOLDER_HS_B64"', f'"{hs_b64}"')
    # (if not provided the placeholder stays, viewer JS will detect and hide the toggle)

    # 5. Embed caves data as JSON literal
    caves_json = json.dumps(caves_data, separators=(',', ':'))
    html = html.replace('PLACEHOLDER_CAVES_JSON', caves_json)

    progress(f"  Viewer HTML total: {len(html)//1024} KB")
    return html


# ──────────────────────────────────────────────────────────────────────────────
# Cave coordinate conversion
# ──────────────────────────────────────────────────────────────────────────────

def convert_caves(caves_path, utm_center_e, utm_center_n, progress=print):
    """
    Convert caves.json (lon/lat/alt from FLEX) to terrain-centred XYZ.

    Input format (from FLEX export button):
        {
          "surveys": [
            { "name": "...", "color": "#00e5ff",
              "shots": [ {"from":[lon,lat,alt], "to":[lon,lat,alt]}, ... ]
            }
          ]
        }

    Output format (viewer expects):
        {
          "surveys": [
            { "name": "...", "color": "#00e5ff",
              "lines": [ [[x1,y1,z1],[x2,y2,z2]], ... ]
            }
          ]
        }

    XYZ is centred on utm_center_e / utm_center_n. Z is WGS84 altitude (m).
    """
    with open(caves_path, encoding='utf-8') as f:
        raw = json.load(f)

    out = {"surveys": []}
    for survey in raw.get("surveys", []):
        lines = []
        shots_out = []
        for shot in survey.get("shots", []):
            from_coord = shot.get("from", [])
            to_coord   = shot.get("to",   [])
            if len(from_coord) < 3 or len(to_coord) < 3:
                continue
            lon1, lat1, alt1 = from_coord[:3]
            lon2, lat2, alt2 = to_coord[:3]
            e1, n1, _ = latlon_to_utm(lat1, lon1)
            e2, n2, _ = latlon_to_utm(lat2, lon2)
            from_xyz = [e1 - utm_center_e, n1 - utm_center_n, alt1]
            to_xyz   = [e2 - utm_center_e, n2 - utm_center_n, alt2]
            lines.append([from_xyz, to_xyz])
            # Preserve all extra metadata FLEX may include (names, LRUD, length…)
            shot_entry = {"from_xyz": from_xyz, "to_xyz": to_xyz}
            for key in ("from_name", "to_name", "length", "azimuth",
                        "inclination", "lrud", "compass", "clino"):
                if key in shot:
                    shot_entry[key] = shot[key]
            shots_out.append(shot_entry)
        # Convert stations (name, lon/lat/elev → scene XYZ, plus lrud/dist)
        stations_out = []
        for st in survey.get("stations", []):
            slon, slat, selev = st.get("lon", 0), st.get("lat", 0), st.get("elev", 0)
            se, sn, _ = latlon_to_utm(slat, slon)
            entry = {
                "name": st.get("name", ""),
                "xyz":  [se - utm_center_e, sn - utm_center_n, selev],
            }
            if st.get("lrud") is not None:
                entry["lrud"] = st["lrud"]
            if st.get("dist") is not None:
                entry["dist"] = st["dist"]
            stations_out.append(entry)

        out["surveys"].append({
            "name":     survey.get("name",  "Survey"),
            "color":    survey.get("color", "#00e5ff"),
            "lines":    lines,
            "shots":    shots_out,
            "stations": stations_out,
        })
    progress(f"  Converted {sum(len(s['lines']) for s in out['surveys']):,} shots across "
             f"{len(out['surveys'])} surveys")
    return out


# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ept',         required=True, help='Path to ept.json')
    ap.add_argument('--bbox',        required=True, nargs=4, type=float,
                    metavar=('minLon','minLat','maxLon','maxLat'))
    ap.add_argument('--caves',       default=None,  help='Path to caves.json (PLT lines)')
    ap.add_argument('--out',         default='export.zip')
    ap.add_argument('--resolution',  type=float, default=0.5, help='DEM cell size in metres')
    ap.add_argument('--percentile',  type=float, default=2,   help='Ground percentile (2=very low)')
    ap.add_argument('--max-triangles', type=int, default=2_000_000)
    ap.add_argument('--tex-size',      type=int,   default=8192)
    ap.add_argument('--spike-threshold', type=float, default=1.5,
                    help='Remove upward spikes > this many metres above local median '
                         '(10m radius window). Set to 0 to disable. Default: 1.5')
    ap.add_argument('--satellite-source', default='bing', choices=['esri', 'bing'],
                    help='Satellite imagery source: esri (default) or bing')
    ap.add_argument('--hillshade-url', default='',
        help='XYZ tile URL template for hillshade layer (use {z}/{x}/{y}). '
             'Leave empty to skip hillshade export.')
    args = ap.parse_args()

    minLon, minLat, maxLon, maxLat = args.bbox

    print(f"[export] BBox: ({minLat:.5f},{minLon:.5f}) -> ({maxLat:.5f},{maxLon:.5f})")

    # Convert bbox corners to UTM
    minE, minN, zone = latlon_to_utm(minLat, minLon)
    maxE, maxN, _    = latlon_to_utm(maxLat, maxLon)
    print(f"[export] UTM Zone {zone}: E {minE:.0f}–{maxE:.0f}, N {minN:.0f}–{maxN:.0f}")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)

        # 0. Download viewer libs (cached)
        print("[0/6] Downloading viewer libs...")
        viewer_libs = get_viewer_libs(progress=lambda m: print(f"[0/6] {m}"))

        # 1. Fetch points
        x, y, z, r, g, b = fetch_ept_points(
            args.ept, (minE, minN, maxE, maxN),
            bbox_latlon=(minLon, minLat, maxLon, maxLat),
            progress=lambda m: print(f"[1/6] {m}")
        )

        # 2. Build DEM
        dem, x_bins, y_bins, x0, y0 = build_dem(
            x, y, z, args.resolution,
            progress=lambda m: print(f"[2/6] {m}")
        )

        # Spike filter: remove upward outliers (trees/buildings) while preserving
        # downward features (caves, sinkholes).
        if args.spike_threshold > 0:
            dem = filter_spikes(
                dem, args.resolution,
                radius_m=10.0, threshold_m=args.spike_threshold,
                progress=lambda m: print(f"[2/7] {m}")
            )

        # Apply the same Z correction FLEX applies to Potree point clouds.
        # Default (both usgsRef and egm96 OFF): -32 * 0.766 ~ -24.5 m.
        # Cave survey positions were established against the corrected display,
        # so terrain must be shifted by the same amount to align.
        FLEX_PC_Z_OFFSET = -32 * 0.766  # metres
        dem += FLEX_PC_Z_OFFSET
        print(f"[2/6] Applied FLEX point-cloud Z offset: {FLEX_PC_Z_OFFSET:.3f} m")

        # Terrain centre in UTM (for cave coordinate conversion)
        utm_center_e = (x_bins[0] + x_bins[-1]) / 2
        utm_center_n = (y_bins[0] + y_bins[-1]) / 2

        # 3. Build mesh
        vertices, faces = build_mesh(
            dem, x_bins, y_bins, x0, y0, args.max_triangles,
            progress=lambda m: print(f"[3/6] {m}")
        )

        # 4. Satellite texture (proportional pixel dimensions)
        print(f"[4/7] Fetching satellite texture ({args.satellite_source.upper()})...")
        texture = fetch_satellite_texture(
            (minLon, minLat, maxLon, maxLat), tex_size=args.tex_size,
            source=args.satellite_source,
            progress=lambda m: print(f"[4/7] {m}")
        )

        # 4b. Hillshade texture (Mapbox or custom XYZ)
        hs_b64 = None
        if args.hillshade_url:
            print("[4b/7] Fetching hillshade texture (Mapbox/XYZ)...")
            try:
                hs_img = _fetch_mapbox(
                    (minLon, minLat, maxLon, maxLat), args.tex_size,
                    args.hillshade_url,
                    progress=lambda m: print(f"[4b/7] {m}")
                )
                import io as _hs_io, base64 as _hs_b64m
                hs_buf = _hs_io.BytesIO()
                hs_img.save(hs_buf, format='JPEG', quality=85)
                hs_b64 = _hs_b64m.b64encode(hs_buf.getvalue()).decode('ascii')
                print(f"[4b/7] Hillshade base64: {len(hs_b64)//1024} KB")
            except Exception as e:
                print(f"[4b/7] WARNING: hillshade fetch failed ({e}) — skipping")
        else:
            print("[4b/7] --hillshade-url is empty, skipping hillshade")

        # 5. UVs + GLB (geometry only) + separate texture encoding
        uvs = compute_uvs(vertices, dem.shape, x_bins, y_bins)
        glb_path = tmp / 'terrain.glb'
        export_glb(vertices, faces, uvs, glb_path,
                   progress=lambda m: print(f"[5/7] {m}"))

        # Encode satellite texture as plain base64 — viewer applies it with flipY=false
        import io as _tex_io, base64 as _tex_b64
        tex_buf = _tex_io.BytesIO()
        texture.save(tex_buf, format='JPEG', quality=85)
        tex_b64 = _tex_b64.b64encode(tex_buf.getvalue()).decode('ascii')
        print(f"[5/7] Satellite texture base64: {len(tex_b64)//1024} KB")

        # 6. Package ZIP
        print(f"[6/7] Writing {args.out}...")
        with zipfile.ZipFile(args.out, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.write(glb_path, 'terrain.glb')

            # Caves: convert lon/lat/alt -> terrain-centred XYZ
            # Derive UTM zone from bbox centre longitude
            bbox_center_lon = (minLon + maxLon) / 2
            bbox_center_lat = (minLat + maxLat) / 2
            utm_zone = int((bbox_center_lon + 180) / 6) + 1
            if args.caves and os.path.exists(args.caves):
                caves_out = convert_caves(
                    args.caves, utm_center_e, utm_center_n,
                    progress=lambda m: print(f"[6/6] {m}")
                )
            else:
                caves_out = {"surveys": []}
            # Embed coordinate meta so the viewer can convert GPS lat/lon -> scene XYZ
            caves_out["meta"] = {
                "utm_center_e": float(utm_center_e),
                "utm_center_n": float(utm_center_n),
                "utm_zone":     int(utm_zone),
                "z_offset":     float(FLEX_PC_Z_OFFSET),
                "center_lon":   float(bbox_center_lon),
                "center_lat":   float(bbox_center_lat),
            }
            zf.writestr('caves.json', json.dumps(caves_out))

            # Viewer HTML: fully self-contained (Three.js + GLB + textures + caves all inline)
            inline_html = build_inline_viewer(
                glb_path, tex_b64, caves_out, viewer_libs,
                progress=lambda m: print(f"[6/7] {m}"),
                hs_b64=hs_b64)
            zf.writestr('viewer.html', inline_html.encode('utf-8'))

            # serve.bat (Windows) — double-click to start local HTTP server
            zf.writestr('serve.bat',
                '@echo off\n'
                'cd /d "%~dp0"\n'
                'echo Starting FLEX viewer at http://localhost:8090/viewer.html\n'
                'start "" http://localhost:8090/viewer.html\n'
                'python -m http.server 8090\n'
                'pause\n')

            # serve.sh (macOS/Linux)
            zf.writestr('serve.sh',
                '#!/bin/bash\n'
                'cd "$(dirname "$0")"\n'
                'echo "Open http://localhost:8090/viewer.html"\n'
                'open "http://localhost:8090/viewer.html" 2>/dev/null || true\n'
                'python3 -m http.server 8090\n')

    sz = os.path.getsize(args.out) / 1e6
    print(f"[7/7] Done.")
    print(f"[done] {args.out} ({sz:.1f} MB)")

if __name__ == '__main__':
    main()
