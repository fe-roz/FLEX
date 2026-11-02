#!/usr/bin/env python3
"""
export_terrain.py  —  FLEX terrain + cave export pipeline

Usage:
  python export_terrain.py --ept <path/to/ept.json> \
                           --bbox <minLon> <minLat> <maxLon> <maxLat> \
                           --caves <path/to/caves.json> \
                           --out <output.zip> \
                           [--name "Map name"] [--hillshade lidar|url|none]
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

from viewer_inline import build_inline_viewer   # stdlib only (tools/rebuild_viewer.py)
from tex_tiles import plan_tiles, make_tiles, meta_entry   # texture tiles for areas over ~5 km

import numpy as np
from scipy.interpolate import NearestNDInterpolator
from scipy.stats import binned_statistic_2d
import requests
from PIL import Image
try:
    import pygltflib            # only the viewer export writes a GLB; --project-terrain does not
except ImportError:             # pragma: no cover
    pygltflib = None

# ──────────────────────────────────────────────────────────────────────────────
# Coordinate helpers
# ──────────────────────────────────────────────────────────────────────────────

def utm_zone_for(lon):
    return int((lon + 180) / 6) + 1


def latlon_to_utm(lat, lon, zone=None):
    """WGS84 -> UTM (returns easting, northing, zone).

    `zone` forces a zone. An export has to live in ONE zone: the bbox centre's.
    Converting each corner in its own zone puts a box that straddles a zone line
    into two unrelated coordinate systems at once.
    """
    if zone is None:
        zone = utm_zone_for(lon)
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


def utm_to_latlon(easting, northing, zone, south=False):
    """UTM -> WGS84 (lat, lon) in degrees. Accepts scalars or numpy arrays.

    Snyder's footpoint-latitude inverse, the exact counterpart of
    latlon_to_utm() above; agrees with pyproj to well under a millimetre inside
    a zone. Needed to warp web-mercator imagery onto the UTM terrain grid.
    """
    a, f = 6378137.0, 1 / 298.257223563
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    k0 = 0.9996
    x = np.asarray(easting, dtype=np.float64) - 500000.0
    y = np.asarray(northing, dtype=np.float64) - (10_000_000.0 if south else 0.0)
    M = y / k0
    mu = M / (a * (1 - e2/4 - 3*e2**2/64 - 5*e2**3/256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    phi1 = (mu + (3*e1/2 - 27*e1**3/32) * np.sin(2*mu)
               + (21*e1**2/16 - 55*e1**4/32) * np.sin(4*mu)
               + (151*e1**3/96) * np.sin(6*mu)
               + (1097*e1**4/512) * np.sin(8*mu))
    s1, c1 = np.sin(phi1), np.cos(phi1)
    N1 = a / np.sqrt(1 - e2 * s1**2)
    T1 = np.tan(phi1)**2
    C1 = ep2 * c1**2
    R1 = a * (1 - e2) / (1 - e2 * s1**2)**1.5
    D = x / (N1 * k0)
    lat = phi1 - (N1 * np.tan(phi1) / R1) * (
          D**2/2 - (5 + 3*T1 + 10*C1 - 4*C1**2 - 9*ep2) * D**4/24
          + (61 + 90*T1 + 298*C1 + 45*T1**2 - 252*ep2 - 3*C1**2) * D**6/720)
    lon = (D - (1 + 2*T1 + C1) * D**3/6
           + (5 - 2*C1 + 28*T1 - 3*C1**2 + 8*ep2 + 24*T1**2) * D**5/120) / c1
    lon0 = math.radians((zone - 1) * 6 - 180 + 3)
    return np.degrees(lat), np.degrees(lon) + math.degrees(lon0)


def utm_rect_covering(bbox_latlon, zone, cell, samples=32):
    """The upright UTM rectangle that covers a lat/lon box, snapped outward to
    whole cells.

    A lat/lon box is NOT an upright rectangle in UTM: away from the zone's
    central meridian it is rotated by the meridian convergence (about 1.1 deg at
    1.9 deg off-meridian, 37 N) and its edges are slightly curved. The SW and NE
    corners alone, which the exporter once used, miss strips along the north
    and south edges. Worse, a dataset stored in lat/lon or web mercator, queried
    with the lat/lon box, came back as a tilted footprint inside an upright
    grid, and the empty corner wedges were filled by copying the nearest edge
    sideways. Sampling every edge and taking the envelope covers the whole
    drawn box; the caller then queries enough data to fill all of it.
    """
    minLon, minLat, maxLon, maxLat = bbox_latlon
    t = np.linspace(0.0, 1.0, samples + 1)
    lons = np.concatenate([minLon + (maxLon - minLon) * t, np.full_like(t, maxLon),
                           maxLon - (maxLon - minLon) * t, np.full_like(t, minLon)])
    lats = np.concatenate([np.full_like(t, minLat), minLat + (maxLat - minLat) * t,
                           np.full_like(t, maxLat), maxLat - (maxLat - minLat) * t])
    es, ns = [], []
    for la, lo in zip(lats, lons):
        e, n, _ = latlon_to_utm(float(la), float(lo), zone)
        es.append(e); ns.append(n)
    e0 = math.floor(min(es) / cell) * cell
    n0 = math.floor(min(ns) / cell) * cell
    e1 = math.ceil(max(es) / cell) * cell
    n1 = math.ceil(max(ns) / cell) * cell
    return e0, n0, e1, n1


def latlon_box_covering(utm_rect, zone, south=False, samples=32):
    """The lat/lon box that covers an upright UTM rectangle -- the inverse of
    utm_rect_covering(), used to ask lat/lon-native sources (EPT in EPSG:3857 or
    4326, web tiles) for enough area that the whole rectangle is backed by data.
    """
    e0, n0, e1, n1 = utm_rect
    t = np.linspace(0.0, 1.0, samples + 1)
    es = np.concatenate([e0 + (e1 - e0) * t, np.full_like(t, e1),
                         e1 - (e1 - e0) * t, np.full_like(t, e0)])
    ns = np.concatenate([np.full_like(t, n0), n0 + (n1 - n0) * t,
                         np.full_like(t, n1), n1 - (n1 - n0) * t])
    lat, lon = utm_to_latlon(es, ns, zone, south)
    return float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max())

# ──────────────────────────────────────────────────────────────────────────────
# Step 1 — Read points from EPT
# ──────────────────────────────────────────────────────────────────────────────

def fetch_ept_points(ept_path, utm_bbox, bbox_latlon=None, progress=print,
                     zone=None, south=False, with_mode=False):
    """Read ground-classified points from an EPT dataset within a UTM bounding box.

    `utm_bbox` and `bbox_latlon` must describe the SAME area -- the caller passes
    the UTM rectangle it wants covered and the lat/lon box that covers it, and
    whichever matches the dataset's native CRS is used for the query. `zone`
    fixes the UTM zone (default: the bbox centre's). With `with_mode` the return
    gains a last element saying how ground was found: 'classified', 'smrf' or
    'all' (no ground labels at all -- every return, cloth handles it).

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
    if zone is not None:
        utm_epsg = (32700 if south else 32600) + int(zone)
    elif bbox_latlon:
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
                # Every corner, not just two: in anything but a sibling UTM
                # grid the rectangle comes back rotated.
                _cx, _cy = _t.transform([minE, maxE, maxE, minE], [minN, minN, maxN, maxN])
                _bx0, _bx1 = min(_cx), max(_cx)
                _by0, _by1 = min(_cy), max(_cy)
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
    mode = 'classified'
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
                mode = 'smrf'
                progress(f"  SMRF ground classification: {len(arr):,} ground points")
            else:
                raise RuntimeError("Too few ground points after SMRF")
        except Exception as e:
            # ── Step C: fallback — all returns, cloth handles it ─────────────
            progress(f"  WARNING: SMRF failed ({e}) — using all returns (cloth fallback)")
            mode = 'all'
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
    if with_mode:
        return x, y, z, r, g, b, mode
    return x, y, z, r, g, b

# ──────────────────────────────────────────────────────────────────────────────
# Step 2 — Minimum-surface DEM (2nd percentile per cell)
# ──────────────────────────────────────────────────────────────────────────────

def build_dem(x, y, z, resolution, csf_iterations=500, progress=print,
              extent=None, return_valid=False):
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

    `extent` (e0, n0, e1, n1) fixes the grid to a chosen UTM rectangle instead
    of wherever the points happen to reach; points outside it are ignored. With
    `return_valid` the result gains a mask of cells that held at least one
    return, before any filling -- the only honest record of where data was.
    """
    progress(f"  Building CSF cloth DEM at {resolution}m resolution...")
    if extent is not None:
        x_min, y_min, x_max, y_max = extent
        nxc = max(1, int(round((x_max - x_min) / resolution)))
        nyc = max(1, int(round((y_max - y_min) / resolution)))
        x_bins = x_min + np.arange(nxc + 1) * resolution
        y_bins = y_min + np.arange(nyc + 1) * resolution
    else:
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
    valid_raw = valid.copy()
    if not valid.any():
        sys.exit("ERROR: no points fall inside the export rectangle")
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
    if return_valid:
        return cloth, x_bins, y_bins, x_min, y_min, valid_raw
    return cloth, x_bins, y_bins, x_min, y_min


def border_nodata_mask(valid, resolution, block_m=4.0, min_blocks=8, progress=print):
    """Cells to leave out of the mesh because the dataset simply does not reach
    them -- as opposed to holes inside the data, which are filled as before.

    Every empty cell gets a value from its nearest neighbour so the cloth has
    something to work on. Inside the data that is right: canopy, water and
    buildings leave small holes and the fill bridges them. Beyond the edge of
    the dataset it is wrong: the edge row is copied outward and reads as terrain
    smeared sideways. The two are told apart by scale and by where they sit:
    work on blocks of a few metres (a block with even one return is data), and
    drop only empty regions of real size that touch the border of the grid.

    Done on blocks rather than cells because sparse ground returns at 0.5 m
    leave single empty cells everywhere, and those percolate: a cell-level
    flood from the border would eat the whole forest.
    """
    from scipy.ndimage import label
    nx, ny = valid.shape
    b = max(1, int(round(max(block_m, 8 * resolution) / resolution)))
    bx, by = -(-nx // b), -(-ny // b)
    pad = np.zeros((bx * b, by * b), dtype=bool)
    pad[:nx, :ny] = valid
    covered = pad.reshape(bx, b, by, b).any(axis=(1, 3))
    lab, n = label(~covered)
    if n == 0:
        return np.zeros_like(valid, dtype=bool)
    edge = np.unique(np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]]))
    edge = edge[edge > 0]
    sizes = np.bincount(lab.ravel(), minlength=n + 1)
    drop_ids = [i for i in edge if sizes[i] >= min_blocks]
    out_blk = np.isin(lab, drop_ids)
    mask = np.repeat(np.repeat(out_blk, b, axis=0), b, axis=1)[:nx, :ny]
    if mask.any():
        progress(f"  No coverage along the border: {mask.mean() * 100:.1f}% of the grid "
                 f"left out of the mesh instead of smeared")
    return mask


# ──────────────────────────────────────────────────────────────────────────────
# Polygon export area
# ──────────────────────────────────────────────────────────────────────────────
# The area can be a polygon instead of the whole box: a hard cut, nothing
# outside it is exported. The export frame stays the upright UTM rectangle
# around it, so nothing downstream changes; the polygon is a mask inside that
# frame -- on the points read (fewer to grid and shade), on the mesh (cut
# exactly at the line, see build_mesh, with the triangle budget spent inside)
# and on the textures (blanked outside, which only shrinks the JPEGs: the
# texture is still one rectangle).
#
# Polygons are open rings of (x, y) vertices; inside is by the even-odd rule.

def load_polygon(path):
    """[[lon, lat], ...] from a JSON file -> float array (n, 2), open ring.
    A repeated closing vertex and repeated neighbours are dropped."""
    pts = np.asarray(json.loads(Path(path).read_text()), dtype=np.float64)
    if pts.ndim != 2 or pts.shape[1] < 2:
        sys.exit("ERROR: --polygon must hold [[lon, lat], ...]")
    pts = pts[:, :2]
    keep = np.ones(len(pts), dtype=bool)
    keep[1:] = np.any(pts[1:] != pts[:-1], axis=1)
    pts = pts[keep]
    if len(pts) > 1 and np.all(pts[0] == pts[-1]):
        pts = pts[:-1]
    if len(pts) < 3 or not np.isfinite(pts).all():
        sys.exit("ERROR: the export polygon needs at least 3 distinct points")
    if not ((-180 <= pts[:, 0]) & (pts[:, 0] <= 180) & (-90 <= pts[:, 1]) & (pts[:, 1] <= 90)).all():
        sys.exit("ERROR: the export polygon is not in lon/lat degrees")
    return pts


def polygon_to_utm(poly_ll, zone):
    """Vertices to UTM in the export's zone. Edges stay straight in UTM; over
    an export's few kilometres that is within millimetres of the lon/lat line."""
    return np.array([latlon_to_utm(float(la), float(lo), zone)[:2] for lo, la in poly_ll])


def polygon_area(poly):
    x, y = poly[:, 0], poly[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def polygon_inside_grid(poly, xs, ys):
    """Whether each (xs[i], ys[j]) is inside: bool [len(xs), len(ys)].
    One scanline per x, so it is exact at every grid point and cheap however
    many vertices the polygon has."""
    P = np.asarray(poly, dtype=np.float64)
    Q = np.roll(P, -1, axis=0)
    x1, y1, x2, y2 = P[:, 0], P[:, 1], Q[:, 0], Q[:, 1]
    ys = np.asarray(ys, dtype=np.float64)
    out = np.zeros((len(xs), len(ys)), dtype=bool)
    for i, x in enumerate(np.asarray(xs, dtype=np.float64)):
        m = (x1 <= x) != (x2 <= x)                     # edges this vertical line crosses
        if not m.any():
            continue
        yc = np.sort(y1[m] + (x - x1[m]) * (y2[m] - y1[m]) / (x2[m] - x1[m]))
        out[i] = (np.searchsorted(yc, ys, side='right') % 2) == 1
    return out


def points_in_polygon(px, py, poly):
    """Even-odd test for scattered points (same rule as polygon_inside_grid)."""
    px = np.asarray(px, dtype=np.float64); py = np.asarray(py, dtype=np.float64)
    inside = np.zeros(px.shape, dtype=bool)
    P = np.asarray(poly, dtype=np.float64)
    Q = np.roll(P, -1, axis=0)
    for (x1, y1), (x2, y2) in zip(P, Q):
        if x1 == x2:
            continue
        m = (x1 <= px) != (x2 <= px)
        yc = y1 + (px[m] - x1) * (y2 - y1) / (x2 - x1)
        inside[m] ^= py[m] >= yc
    return inside


def points_near_polygon(x, y, poly_utm, rect, reach, resolution):
    """Mask of the points within about `reach` of the polygon (UTM), so the
    cells along the line are backed by real returns. Coarse cells, dilated:
    cheap for tens of millions of points."""
    from scipy.ndimage import binary_dilation as _bd
    cc = max(4 * resolution, reach / 3)
    gx = np.arange(rect[0] - reach, rect[2] + reach + cc, cc)
    gy = np.arange(rect[1] - reach, rect[3] + reach + cc, cc)
    near = _bd(polygon_inside_grid(poly_utm, gx + cc / 2, gy + cc / 2),
               iterations=int(math.ceil(reach / cc)) + 1)
    ix = np.clip(((x - gx[0]) // cc).astype(np.int64), 0, len(gx) - 1)
    iy = np.clip(((y - gy[0]) // cc).astype(np.int64), 0, len(gy) - 1)
    return near[ix, iy]


def polygon_edge_distance(px, py, poly):
    """Distance from each point to the nearest edge of the polygon."""
    px = np.asarray(px, dtype=np.float64); py = np.asarray(py, dtype=np.float64)
    d = np.full(px.shape, np.inf)
    P = np.asarray(poly, dtype=np.float64)
    Q = np.roll(P, -1, axis=0)
    for (x1, y1), (x2, y2) in zip(P, Q):
        ex, ey = x2 - x1, y2 - y1
        L2 = ex * ex + ey * ey
        t = np.clip(((px - x1) * ex + (py - y1) * ey) / L2, 0.0, 1.0) if L2 > 0 else 0.0
        d = np.minimum(d, np.hypot(px - (x1 + t * ex), py - (y1 + t * ey)))
    return d


def densify_ring(poly, step):
    """The ring with extra points on every edge, no more than `step` apart;
    the original vertices are kept, so the outline is exactly the polygon's."""
    out = []
    P = np.asarray(poly, dtype=np.float64)
    for a, b in zip(P, np.roll(P, -1, axis=0)):
        n = max(1, int(math.ceil(math.hypot(*(b - a)) / step)))
        t = np.arange(n)[:, None] / n
        out.append(a + t * (b - a))
    return np.vstack(out)


def self_intersecting(poly):
    """True if two non-adjacent edges cross (checked up to 4000 edges)."""
    P = np.asarray(poly, dtype=np.float64)
    n = len(P)
    if n < 4 or n > 4000:
        return False
    A, B = P, np.roll(P, -1, axis=0)
    def orient(p, q, r):
        return np.sign((q[..., 0] - p[..., 0]) * (r[..., 1] - p[..., 1])
                       - (q[..., 1] - p[..., 1]) * (r[..., 0] - p[..., 0]))
    for i in range(n):
        j = np.arange(i + 2, n)
        if i == 0:
            j = j[j != n - 1]
        if not len(j):
            continue
        a, b, c, d = A[i], B[i], A[j], B[j]
        if np.any((orient(a, b, c) * orient(a, b, d) < 0) & (orient(c, d, a) * orient(c, d, b) < 0)):
            return True
    return False


def blank_outside(img, grid, poly, margin_px=2):
    """Paint the texture outside the polygon (UTM) one flat colour, in place:
    the average of what is inside, so mipmaps along the edge stay true. The
    mesh ends at the line, so nothing out there is ever shown; flat pixels
    just compress to almost nothing. A couple of pixels past the line are
    kept for texture filtering."""
    from PIL import ImageDraw
    W, H = img.size
    sx, sy = W / grid.width, H / grid.height
    pix = [(float((e - grid.e0) * sx), float((grid.n1 - n) * sy)) for e, n in poly]
    outside = Image.new('L', (W, H), 255)
    d = ImageDraw.Draw(outside)
    d.polygon(pix, fill=0)
    d.line(pix + pix[:1], fill=0, width=2 * margin_px + 1)
    small_w, small_h = max(1, W // 16), max(1, H // 16)
    arr = np.asarray(img.convert('RGB').resize((small_w, small_h)), dtype=np.float64).reshape(-1, 3)
    sel = np.asarray(outside.resize((small_w, small_h)), dtype=np.uint8).ravel() == 0
    rgb = arr[sel].mean(axis=0) if sel.any() else np.array([128.0, 128.0, 128.0])
    fill = int(round(rgb.mean())) if img.mode == 'L' else tuple(int(round(v)) for v in rgb)
    img.paste(fill, mask=outside)
    return img


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

def build_mesh(dem, x_bins, y_bins, x_origin, y_origin, max_triangles=2_000_000, progress=print,
               drop=None, clip=None):
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

    `drop` marks cells with no data behind them (see border_nodata_mask); they
    get no vertices and no triangles, and the cells along their edge are all
    kept so the cut is clean rather than stepped at the coarse grid spacing.

    `clip` is the export polygon, in the mesh's own (grid-centred) metres: the
    mesh is cut exactly at its line. Vertices outside it, or closer to the
    line than about half a cell, are left out and the line itself is put in
    as vertices (heights from the DEM) no more than 0.8 cell apart, close
    enough that the triangulation keeps its edges; then triangles whose
    centre is outside go. The vertex budget is spent inside the polygon.
    """
    from scipy.ndimage import laplace, uniform_filter, binary_dilation, binary_erosion
    from scipy.spatial import Delaunay

    rows, cols = dem.shape
    dx = float(x_bins[1] - x_bins[0])
    dy = float(y_bins[1] - y_bins[0])
    n_cells = rows * cols
    cx = np.arange(rows) * dx - (rows - 1) * dx / 2.0     # cell centres, as the vertices below
    cy = np.arange(cols) * dy - (cols - 1) * dy / 2.0
    region = None
    if clip is not None:
        clip = np.asarray(clip, dtype=np.float64)
        inside_c = polygon_inside_grid(clip, cx, cy)
        if not inside_c.any():
            sys.exit("ERROR: the export polygon holds no terrain cell")
        region = binary_dilation(inside_c, iterations=2)
        edge_c = binary_dilation(inside_c) != binary_erosion(inside_c, border_value=1)
        band = binary_dilation(edge_c, iterations=2)
        n_cells = int(region.sum())
        progress(f"  Polygon: {inside_c.mean() * 100:.1f}% of the rectangle; the mesh is cut at its line")

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

    if region is not None:
        n_subgrid = int((subgrid_mask & region.ravel()).sum())
        n_border = int(sum(math.hypot(*(b - a)) for a, b in zip(clip, np.roll(clip, -1, axis=0))) / (0.8 * min(dx, dy)))
        n_curv_budget = max(0, max_triangles // 2 - n_subgrid - n_border)
    cand = curv_norm if region is None else curv_norm[region.ravel()]
    if n_curv_budget > 0 and n_curv_budget < len(cand):
        # Select top-N cells by curvature score
        threshold = float(np.partition(cand, len(cand) - n_curv_budget)
                          [len(cand) - n_curv_budget])
        curv_mask = curv_norm >= threshold
    else:
        curv_mask = np.zeros(rows * cols, dtype=bool)
    del cand

    # ── 4. Union + border ─────────────────────────────────────────────────────
    keep = (subgrid_mask | curv_mask).reshape(rows, cols)
    keep[0, :] = keep[-1, :] = keep[:, 0] = keep[:, -1] = True   # always keep border
    if drop is not None and drop.any():
        rim = binary_dilation(drop) & ~drop
        keep |= rim
        keep &= ~drop
    if region is not None:
        # Only inside, and not hard against the line (the line gets its own).
        keep &= inside_c
        near = keep & band
        ri, ci = np.where(near)
        too_close = polygon_edge_distance(cx[ri], cy[ci], clip) < 0.45 * min(dx, dy)
        keep[ri[too_close], ci[too_close]] = False

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
    if region is not None:
        # The polygon's line as vertices, heights bilinear from the DEM.
        ring = densify_ring(clip, 0.8 * min(dx, dy))
        fi = np.clip((ring[:, 0] + (rows - 1) * dx / 2.0) / dx, 0, rows - 1)
        fj = np.clip((ring[:, 1] + (cols - 1) * dy / 2.0) / dy, 0, cols - 1)
        i0 = np.minimum(np.floor(fi).astype(np.int64), max(0, rows - 2)); j0 = np.minimum(np.floor(fj).astype(np.int64), max(0, cols - 2))
        i1 = np.minimum(i0 + 1, rows - 1); j1 = np.minimum(j0 + 1, cols - 1)
        u = fi - i0; v = fj - j0
        rz = (dem[i0, j0] * (1 - u) * (1 - v) + dem[i1, j0] * u * (1 - v)
              + dem[i0, j1] * (1 - u) * v + dem[i1, j1] * u * v)
        n_ring = len(ring)
        vx = np.concatenate([vx, ring[:, 0].astype(np.float32)])
        vy = np.concatenate([vy, ring[:, 1].astype(np.float32)])
        vz = np.concatenate([vz, rz.astype(np.float32)])
        progress(f"  Polygon line: {n_ring:,} vertices")
    vertices = np.column_stack([vx, vy, vz])

    # ── 6. 2-D Delaunay triangulation ─────────────────────────────────────────
    progress("  Delaunay triangulation...")
    tri = Delaunay(np.column_stack([vx.astype(np.float64),
                                     vy.astype(np.float64)]))
    faces = tri.simplices.astype(np.uint32)
    if region is not None:
        # Delaunay fills the convex hull: drop the triangles whose centre is
        # outside the polygon. Far from the line a cell look-up decides; near
        # it, the exact test.
        P = vertices[:, :2].astype(np.float64)
        cen = (P[faces[:, 0]] + P[faces[:, 1]] + P[faces[:, 2]]) / 3.0
        ci = np.clip(np.rint((cen[:, 0] + (rows - 1) * dx / 2.0) / dx).astype(np.int64), 0, rows - 1)
        cj = np.clip(np.rint((cen[:, 1] + (cols - 1) * dy / 2.0) / dy).astype(np.int64), 0, cols - 1)
        ins = inside_c[ci, cj]
        nb = band[ci, cj]
        ins[nb] = points_in_polygon(cen[nb, 0], cen[nb, 1], clip)
        faces = faces[ins]
    if drop is not None and drop.any():
        # Delaunay fills the convex hull, so it bridges straight across any
        # dropped region. Test each triangle's centroid and edge midpoints
        # against the mask and discard the ones that land in it.
        def _cell(px, py):
            ci = np.clip(np.rint((px + (rows - 1) * dx / 2.0) / dx).astype(np.int64), 0, rows - 1)
            cj = np.clip(np.rint((py + (cols - 1) * dy / 2.0) / dy).astype(np.int64), 0, cols - 1)
            return drop[ci, cj]
        P = vertices[:, :2].astype(np.float64)
        a, b_, c = P[faces[:, 0]], P[faces[:, 1]], P[faces[:, 2]]
        bad = _cell(*((a + b_ + c) / 3.0).T)
        for m in ((a + b_) / 2.0, (b_ + c) / 2.0, (c + a) / 2.0):
            bad |= _cell(*m.T)
        faces = faces[~bad]
    if (drop is not None and drop.any()) or region is not None:
        used = np.zeros(len(vertices), dtype=bool)
        used[faces.ravel()] = True
        remap = np.cumsum(used) - 1
        vertices = vertices[used]
        faces = remap[faces].astype(np.uint32)
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

# Imagery is fetched as web-mercator tiles but the terrain is a UTM grid. The
# two differ by a rotation (the meridian convergence) and a scale, both of which
# grow with distance from the zone's central meridian, so a tile mosaic cropped
# to a lat/lon box and stretched over the terrain is misplaced by tens of metres
# near the edges. Everything below builds the mosaic for a lat/lon box that
# covers the terrain rectangle, then resamples it pixel-by-pixel into the UTM
# grid, so imagery, hillshade, terrain, caves and GPS all share one frame.

class UtmGrid:
    """The export's frame: an upright UTM rectangle in one zone."""
    def __init__(self, e0, n0, e1, n1, zone, south=False):
        self.e0, self.n0, self.e1, self.n1 = float(e0), float(n0), float(e1), float(n1)
        self.zone, self.south = int(zone), bool(south)

    @property
    def width(self):  return self.e1 - self.e0
    @property
    def height(self): return self.n1 - self.n0

    def tex_dims(self, long_side):
        """Pixel size with the rectangle's own aspect ratio, long side = long_side."""
        if self.width >= self.height:
            return int(long_side), max(64, int(round(long_side * self.height / self.width)))
        return max(64, int(round(long_side * self.width / self.height))), int(long_side)

    def latlon_box(self, margin_m=0.0):
        return latlon_box_covering((self.e0 - margin_m, self.n0 - margin_m,
                                    self.e1 + margin_m, self.n1 + margin_m),
                                   self.zone, self.south)


def _merc_world_px(lon, lat, zoom, tile_px):
    """Web-mercator world pixel coordinates (y=0 at the north edge)."""
    n = (2.0 ** zoom) * tile_px
    lat_r = np.radians(np.clip(lat, -85.0511, 85.0511))
    wx = (np.asarray(lon) + 180.0) / 360.0 * n
    wy = (1.0 - np.log(np.tan(lat_r) + 1.0 / np.cos(lat_r)) / math.pi) / 2.0 * n
    return wx, wy


def _choose_zoom(lat_mid, target_mpp, tile_px, zmin=10, zmax=19):
    """Smallest zoom whose pixels are at least as fine as target_mpp.

    Ground resolution of a tile_px tile at zoom z is 156543.034 * cos(lat) / 2^z
    * (256 / tile_px). The old fetchers multiplied by (tile_px / 256) instead,
    which asked 512-px tile servers for one zoom level too many (4x the tiles).
    """
    mpp0 = 156543.034 * math.cos(math.radians(lat_mid)) * (256.0 / tile_px)
    z = math.ceil(math.log2(mpp0 / max(target_mpp, 1e-6)))
    return max(zmin, min(zmax, z))


def _stitch_tiles(ll_box, zoom, tile_px, url_for, headers, progress, label,
                  timeout=15):
    """Download and paste every tile covering ll_box. Returns the mosaic and the
    world-pixel position of its top-left corner."""
    import io as _io
    from PIL import Image as _PILImage
    _PILImage.MAX_IMAGE_PIXELS = None   # we build this canvas ourselves; no bomb risk
    minLon, minLat, maxLon, maxLat = ll_box
    wx0, wy0 = _merc_world_px(minLon, maxLat, zoom, tile_px)
    wx1, wy1 = _merc_world_px(maxLon, minLat, zoom, tile_px)
    n_tiles = 2 ** zoom
    tx0, ty0 = int(wx0 // tile_px), max(0, int(wy0 // tile_px))
    tx1, ty1 = int(wx1 // tile_px), min(n_tiles - 1, int(wy1 // tile_px))
    ntx, nty = tx1 - tx0 + 1, ty1 - ty0 + 1
    progress(f"  {label} zoom={zoom}, {ntx}x{nty}={ntx * nty} tiles...")
    canvas = Image.new('RGB', (ntx * tile_px, nty * tile_px), (120, 120, 120))
    fetched = 0
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            url = url_for(tx, ty, zoom)
            try:
                r = requests.get(url, timeout=timeout, headers=headers)
                r.raise_for_status()
                tile = Image.open(_io.BytesIO(r.content)).convert('RGB')
                if tile.size != (tile_px, tile_px):
                    tile = tile.resize((tile_px, tile_px), Image.LANCZOS)
                canvas.paste(tile, ((tx - tx0) * tile_px, (ty - ty0) * tile_px))
                fetched += 1
            except Exception as e:
                progress(f"  WARNING: {label} tile {zoom}/{tx}/{ty} failed: {e}")
    progress(f"  Fetched {fetched}/{ntx * nty} tiles")
    if fetched == 0:
        raise RuntimeError(f"All {label} tiles failed")
    return canvas, tx0 * tile_px, ty0 * tile_px


def warp_mercator_to_utm(canvas, origin_px, zoom, tile_px, grid, out_w, out_h,
                         step=128, fill=(120, 120, 120)):
    """Resample a web-mercator mosaic into the UTM grid.

    Output pixel edges line up with the grid rectangle exactly -- the same frame
    compute_uvs() maps the mesh into. PIL's MESH transform does the work in C:
    each step x step block of output maps to a source quad whose corners are
    projected exactly, with bilinear interpolation inside. Over 128 px the
    UTM-to-mercator map is affine to far below a pixel.
    """
    ox, oy = origin_px
    # Pre-shrink when the mosaic is much finer than the output so the resample
    # does not alias; zoom levels come in factors of two, so this is common.
    mpp_out = grid.width / out_w
    lat_mid = (grid.latlon_box()[1] + grid.latlon_box()[3]) / 2
    mpp_src = 156543.034 * math.cos(math.radians(lat_mid)) / (2 ** zoom) * (256.0 / tile_px)
    scale = 1.0
    if mpp_out / mpp_src > 1.25:
        scale = mpp_src / mpp_out
        canvas = canvas.resize((max(1, int(round(canvas.width * scale))),
                                max(1, int(round(canvas.height * scale)))), Image.LANCZOS)
    xs = np.unique(np.concatenate([np.arange(0, out_w, step), [out_w]]))
    ys = np.unique(np.concatenate([np.arange(0, out_h, step), [out_h]]))
    I, J = np.meshgrid(xs, ys)
    E = grid.e0 + I / out_w * grid.width
    N = grid.n1 - J / out_h * grid.height
    lat, lon = utm_to_latlon(E, N, grid.zone, grid.south)
    wx, wy = _merc_world_px(lon, lat, zoom, tile_px)
    sx = (wx - ox) * scale
    sy = (wy - oy) * scale
    data = []
    for r in range(len(ys) - 1):
        for c in range(len(xs) - 1):
            box = (int(xs[c]), int(ys[r]), int(xs[c + 1]), int(ys[r + 1]))
            quad = (sx[r, c], sy[r, c], sx[r + 1, c], sy[r + 1, c],
                    sx[r + 1, c + 1], sy[r + 1, c + 1], sx[r, c + 1], sy[r, c + 1])
            data.append((box, tuple(float(v) for v in quad)))
    return canvas.transform((out_w, out_h), Image.MESH, data,
                            resample=Image.BICUBIC, fillcolor=fill)


def _bing_quadkey(tx, ty, z):
    key = []
    for i in range(z, 0, -1):
        d = 0
        mask = 1 << (i - 1)
        if tx & mask: d |= 1
        if ty & mask: d |= 2
        key.append(str(d))
    return ''.join(key)


def xyz_url(template, tx, ty, z):
    """A slippy-map URL for tile (tx, ty) at zoom z from a template with {z} {x} {y}
    ({reverseY} or {-y}: rows counted from the south; {s}: a subdomain)."""
    flip = str(2 ** z - 1 - ty)
    return (template.replace('{z}', str(z)).replace('{x}', str(tx)).replace('{reverseY}', flip)
            .replace('{-y}', flip).replace('{y}', str(ty)).replace('{s}', 'a'))


def warp_lonlat_image(path, bounds, grid, out_w, out_h, fill=(160, 160, 160), step=256):
    """A picture that lies on a lon/lat box (west, south, east, north; its rows run linearly
    from north to south: how FLEX keeps a GeoTIFF layer) resampled onto the UTM grid, as
    warp_mercator_to_utm() does for tiles. Returns (RGB image, share of pixels the picture covers);
    pixels it does not cover (or has no alpha for) take `fill`."""
    from scipy.ndimage import map_coordinates
    Image.MAX_IMAGE_PIXELS = None
    src = Image.open(path).convert('RGBA')
    sw, sh = src.size
    W, S, E, N = [float(v) for v in bounds]
    arr = np.asarray(src, dtype=np.float32)
    out = np.empty((out_h, out_w, 3), dtype=np.uint8)
    covered = 0
    cols = grid.e0 + (np.arange(out_w) + 0.5) / out_w * grid.width
    for j0 in range(0, out_h, step):
        j1 = min(out_h, j0 + step)
        rows = grid.n1 - (np.arange(j0, j1) + 0.5) / out_h * grid.height
        EE, NN = np.meshgrid(cols, rows)
        lat, lon = utm_to_latlon(EE, NN, grid.zone, grid.south)
        fx = (lon - W) / (E - W) * sw - 0.5
        fy = (N - lat) / (N - S) * sh - 0.5
        inside = (fx >= -0.5) & (fx <= sw - 0.5) & (fy >= -0.5) & (fy <= sh - 0.5)
        bands = [map_coordinates(arr[:, :, b], [fy, fx], order=1, mode='nearest') for b in range(4)]
        a = (bands[3] / 255.0) * inside
        for b in range(3):
            out[j0:j1, :, b] = np.clip(bands[b] * a + fill[b] * (1 - a) + 0.5, 0, 255).astype(np.uint8)
        covered += int((a > 0.5).sum())
    return Image.fromarray(out, 'RGB'), covered / float(out_w * out_h)


def fetch_imagery(grid, tex_size, source='bing', url_template=None, progress=print, tile_px=None):
    """Imagery for the export rectangle, resampled onto the UTM grid.

    source: 'bing' or 'esri' (satellite), or 'xyz' with url_template holding
    {z}/{x}/{y} (a hillshade or any other slippy-map layer; 512-px tiles unless
    tile_px says otherwise). {reverseY} / {-y} count rows from the south (TMS), {s} is 'a'.
    """
    import random as _rand
    out_w, out_h = grid.tex_dims(tex_size)
    ll = grid.latlon_box(margin_m=2 * grid.width / out_w + 1.0)
    lat_mid = (ll[1] + ll[3]) / 2
    target_mpp = grid.width / out_w
    if source == 'bing':
        tile_px, label = 256, 'Bing'
        url_for = lambda tx, ty, z: (f'https://ecn.t{_rand.randint(0, 3)}.tiles.virtualearth.net'
                                     f'/tiles/a{_bing_quadkey(tx, ty, z)}.jpeg?g=1')
        headers = {'User-Agent': 'FLEX-CaveViewer/1.0'}
    elif source == 'esri':
        tile_px, label = 256, 'ESRI'
        base = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile'
        url_for = lambda tx, ty, z: f'{base}/{z}/{ty}/{tx}'
        headers = {'User-Agent': 'Mozilla/5.0 (compatible; FLEX/1.0)'}
    elif source == 'xyz':
        if not url_template:
            raise ValueError('xyz imagery needs a url_template')
        tile_px, label = int(tile_px or 512), 'XYZ'
        url_for = lambda tx, ty, z: xyz_url(url_template, tx, ty, z)
        headers = {'User-Agent': 'FLEX-CaveViewer/1.0'}
    else:
        raise ValueError(f'unknown imagery source {source!r}')
    zoom = _choose_zoom(lat_mid, target_mpp, tile_px)
    canvas, ox, oy = _stitch_tiles(ll, zoom, tile_px, url_for, headers, progress, label)
    img = warp_mercator_to_utm(canvas, (ox, oy), zoom, tile_px, grid, out_w, out_h)
    progress(f"  {label} texture: {out_w}x{out_h} px, warped onto UTM zone {grid.zone} "
             f"({target_mpp:.2f} m/px)")
    return img


def layer_texture(grid, tex_size, kind, url, tile_px, image, bounds, progress=print):
    """A project map layer as an export texture: kind 'xyz' (tiles from `url`, fetched now: needs the
    internet unless the tiles are on this computer) or 'image' (a picture on a lon/lat box).
    Raises when it gives nothing, so the caller can fall back."""
    if kind == 'xyz':
        if not url:
            raise ValueError('no tile link')
        return fetch_imagery(grid, tex_size, source='xyz', url_template=url, tile_px=tile_px, progress=progress)
    if not image or not bounds:
        raise ValueError('no picture')
    out_w, out_h = grid.tex_dims(tex_size)
    img, share = warp_lonlat_image(image, bounds, grid, out_w, out_h)
    if share < 0.01:
        raise ValueError('the picture is not on the exported area')
    progress(f"  Map layer picture: {out_w}x{out_h} px, covers {share * 100:.0f}% of the area")
    return img


def fetch_satellite_texture(grid, tex_size=8192, source='esri', progress=print):
    """Satellite imagery for the grid; falls back to the other source, then grey."""
    order = [source] + [s for s in ('bing', 'esri') if s != source]
    for src in order:
        try:
            return fetch_imagery(grid, tex_size, source=src, progress=progress)
        except Exception as e:
            progress(f"  WARNING: {src} imagery failed ({e})")
    progress("  WARNING: no imagery source worked. Using grey.")
    return Image.new('RGB', grid.tex_dims(tex_size), (160, 160, 160))


# ──────────────────────────────────────────────────────────────────────────────
# Step 4c — Hillshade from the LiDAR ground returns
# ──────────────────────────────────────────────────────────────────────────────

HS_AZIMUTHS = (225.0, 270.0, 315.0, 360.0)   # degrees clockwise from north
HS_ALTITUDE = 45.0


def auto_hillshade_cell(n_ground, covered_m2, width_m, height_m,
                        floor=0.25, max_px=16384, max_mpix=64.0):
    """Finest cell the ground returns support, within texture limits.

    About one ground return per cell: finer than that and most cells are
    interpolated, so the extra pixels show interpolation rather than ground.
    Never finer than `floor`. Capped so the long side fits one GPU texture
    (`max_px`) and the whole grid stays under `max_mpix` megapixels, which keeps
    the float working arrays to a few hundred MB.
    Returns (cell, reason, want): reason names whichever limit decided it,
    want is the density-only cell before any floor or cap.
    """
    dens = n_ground / max(covered_m2, 1.0)
    want = math.sqrt(1.0 / dens) if dens > 0 else 1.0
    cell = max(floor, math.ceil(want * 20 - 1e-9) / 20)   # up to the next 5 cm
    reason = f'{dens:.1f} ground returns/m2'
    if cell <= floor + 1e-9 and want < floor:
        reason += f', held at the {floor} m floor'
    lim_px = max(width_m, height_m) / max_px
    lim_mp = math.sqrt(width_m * height_m / (max_mpix * 1e6))
    if lim_px > cell:
        cell, reason = math.ceil(lim_px * 100) / 100, f'long side capped at {max_px} px'
    if lim_mp > cell:
        cell, reason = math.ceil(lim_mp * 100) / 100, f'capped at {max_mpix:.0f} MP'
    return cell, reason, want


def push_pull_fill(zsum, wsum, relax=8):
    """Fill a sparsely sampled raster smoothly.

    `zsum`/`wsum` are per-pixel weighted sums and weights. Halve repeatedly
    (summing 2x2 blocks) until every pixel has support, then walk back up,
    blending each level with a BILINEAR upsample of the coarser one wherever its
    own weight is short of 1. A pyramid that copies coarse cells straight down
    leaves steps at every hole boundary, and a hillshade draws each step as a
    dark jagged line; this one leaves none.

    Block averages sit at the centroid of their points, not the block centre,
    so on a slope the plain version sags inside large holes (2.7 m across a
    30 m hole on a 31 deg slope). A few relaxation passes per level -- each
    under-supported pixel pulled toward its neighbours' mean -- make the fill
    close to harmonic, which reproduces planes: 0.2 m on the same test.
    Returns float32 values.
    """
    from scipy.ndimage import zoom as _zoom
    levels = [(zsum.astype(np.float32), wsum.astype(np.float32))]
    while True:
        zc, wc = levels[-1]
        if (wc > 0).all() or min(zc.shape) < 2:
            break
        h, w = zc.shape
        h2, w2 = -(-h // 2), -(-w // 2)
        zp = np.zeros((h2 * 2, w2 * 2), np.float32); zp[:h, :w] = zc
        wp = np.zeros((h2 * 2, w2 * 2), np.float32); wp[:h, :w] = wc
        levels.append((zp.reshape(h2, 2, w2, 2).sum(axis=(1, 3)),
                       wp.reshape(h2, 2, w2, 2).sum(axis=(1, 3))))
    zc, wc = levels[-1]
    with np.errstate(invalid='ignore', divide='ignore'):
        val = np.where(wc > 0, zc / np.where(wc > 0, wc, 1), np.nan)
    if np.isnan(val).all():
        return np.zeros(zsum.shape, dtype=np.float32)
    val = np.where(np.isnan(val), np.nanmean(val), val)
    for zl, wl in reversed(levels[:-1]):
        h, w = zl.shape
        up = _zoom(val, 2, order=1, mode='nearest', grid_mode=True)[:h, :w]
        if up.shape != (h, w):                  # odd sizes: pad by edge
            up = np.pad(up, ((0, h - up.shape[0]), (0, w - up.shape[1])), mode='edge')
        lack = np.clip(1.0 - wl, 0.0, 1.0)
        val = (zl + lack * up) / (wl + lack)
        free = lack > 0
        if relax and free.any():
            for _ in range(relax):
                pv = np.pad(val, 1, mode='edge')
                avg = (pv[:-2, 1:-1] + pv[2:, 1:-1] + pv[1:-1, :-2] + pv[1:-1, 2:]) * 0.25
                val = np.where(free, (zl + lack * avg) / (wl + lack), val)
    return val.astype(np.float32)


def lidar_ground_surface(x, y, z, grid, cell, mode='classified'):
    """Bare-earth elevation on a regular grid covering `grid`, row 0 = north.

    Ground returns are splatted bilinearly onto the four surrounding pixel
    centres (weights by distance), which keeps sub-cell position and averages
    out per-point noise without the blockiness of a per-cell statistic. Pixels
    no return reached are filled smoothly (push_pull_fill). Without ground labels
    ('all' mode, every return) a per-pixel minimum stands in, which is the best
    bare-earth guess available there.
    Returns (surface float32 [ny, nx], pixel width m, pixel height m).
    """
    nx = max(1, int(round(grid.width / cell)))
    ny = max(1, int(round(grid.height / cell)))
    pw, ph = grid.width / nx, grid.height / ny
    fx = (x - grid.e0) / pw - 0.5
    fy = (grid.n1 - y) / ph - 0.5
    inside = (fx > -1) & (fx < nx) & (fy > -1) & (fy < ny)
    fx, fy, zz = fx[inside], fy[inside], z[inside]
    if mode == 'all':
        i = np.clip(np.rint(fx).astype(np.int64), 0, nx - 1)
        j = np.clip(np.rint(fy).astype(np.int64), 0, ny - 1)
        flat = j * nx + i
        order = np.lexsort((zz, flat))
        flat_s = flat[order]
        first = np.ones(len(flat_s), dtype=bool)
        first[1:] = flat_s[1:] != flat_s[:-1]
        wsum = np.zeros(nx * ny, dtype=np.float64)
        zsum = np.zeros(nx * ny, dtype=np.float64)
        wsum[flat_s[first]] = 1.0
        zsum[flat_s[first]] = zz[order][first]
        zref = 0.0
    else:
        i0 = np.floor(fx).astype(np.int64)
        j0 = np.floor(fy).astype(np.int64)
        tx = fx - i0
        ty = fy - j0
        wsum = np.zeros(nx * ny, dtype=np.float32)
        zsum = np.zeros(nx * ny, dtype=np.float32)
        zref = float(np.median(zz)) if len(zz) else 0.0
        zr = zz - zref                          # keep the sums well conditioned
        for di, dj, w in ((0, 0, (1 - tx) * (1 - ty)), (1, 0, tx * (1 - ty)),
                          (0, 1, (1 - tx) * ty),       (1, 1, tx * ty)):
            ii = i0 + di
            jj = j0 + dj
            ok = (ii >= 0) & (ii < nx) & (jj >= 0) & (jj < ny)
            flat = jj[ok] * nx + ii[ok]
            wsum += np.bincount(flat, weights=w[ok], minlength=nx * ny)
            zsum += np.bincount(flat, weights=w[ok] * zr[ok], minlength=nx * ny)
    surf = push_pull_fill(zsum.reshape(ny, nx), wsum.reshape(ny, nx)) + np.float32(zref)
    return surf, pw, ph


def multidirectional_hillshade(dem, pw, ph, azimuths=HS_AZIMUTHS, altitude=HS_ALTITUDE):
    """Shade from several light directions, each weighted by how well it shows
    the local slope, so relief reads the same whichever way a feature faces.

    Weighting is the one gdaldem -multidirectional uses: a light direction
    counts most where it strikes the slope side-on (weight sin^2 of the angle
    between the downslope direction and the light). A single north-west light
    flattens anything running NW-SE; this does not.
    `dem` rows run north to south. Returns uint8 [ny, nx].
    """
    dzdx = np.empty_like(dem, dtype=np.float32)
    dzdy = np.empty_like(dem, dtype=np.float32)
    # Central differences; one-sided at the edges.
    dzdx[:, 1:-1] = (dem[:, 2:] - dem[:, :-2]) / (2 * pw)
    dzdx[:, 0] = (dem[:, 1] - dem[:, 0]) / pw
    dzdx[:, -1] = (dem[:, -1] - dem[:, -2]) / pw
    # Rows run north->south, so the northward gradient is minus the row step.
    dzdy[1:-1, :] = -(dem[2:, :] - dem[:-2, :]) / (2 * ph)
    dzdy[0, :] = -(dem[1, :] - dem[0, :]) / ph
    dzdy[-1, :] = -(dem[-1, :] - dem[-2, :]) / ph
    slope = np.arctan(np.hypot(dzdx, dzdy))
    # Downslope direction, clockwise from north.
    aspect = np.arctan2(-dzdx, -dzdy)
    zen = math.radians(90.0 - altitude)
    cz, sz = math.cos(zen), math.sin(zen)
    cs, ss = np.cos(slope), np.sin(slope)
    num = np.zeros_like(dem, dtype=np.float32)
    den = np.zeros_like(dem, dtype=np.float32)
    for az in azimuths:
        a = math.radians(az)
        shade = np.clip(cz * cs + sz * ss * np.cos(a - aspect), 0.0, 1.0)
        w = np.sin(aspect - a) ** 2
        num += w * shade
        den += w
    flat = den < 1e-6
    out = np.where(flat, cz, num / np.maximum(den, 1e-6))
    return np.clip(_tone_map(out) * 255.0 + 0.5, 0, 255).astype(np.uint8)


def _tone_map(v, mid=0.62):
    """Stretch a hillshade to use the whole grey range.

    Blending several light directions pulls every value toward the middle (on
    moderate slopes half the image lands within 20 grey levels), so the relief
    is all there but faint. Stretch between robust extremes, then bend with a
    gamma that puts the median at `mid` -- light enough that shadowed detail
    stays readable, dark enough that highlights do not blow out.
    """
    lo, med, hi = np.percentile(v[::4, ::4], [0.5, 50.0, 99.7])
    if hi - lo < 1e-6:
        return np.full_like(v, mid)
    t = np.clip((v - lo) / (hi - lo), 0.0, 1.0)
    tm = min(0.95, max(0.05, (med - lo) / (hi - lo)))
    return t ** (math.log(mid) / math.log(tm))


def build_lidar_hillshade(x, y, z, grid, covered_m2, mode='classified',
                          max_px=16384, progress=print):
    """Multi-directional hillshade of the ground returns, pixel-aligned with the
    terrain mesh (same UTM rectangle as compute_uvs() and the satellite).

    Built from the points, not from the terrain mesh: the mesh is a decimated,
    cloth-smoothed surface made for a phone to draw, and shading it would throw
    away exactly the small features (sink rims, entrances, ledges) a hillshade
    is for.
    Returns (PIL grayscale image, cell size m).
    """
    from scipy.ndimage import gaussian_filter
    n_in = int(((x >= grid.e0) & (x < grid.e1) & (y >= grid.n0) & (y < grid.n1)).sum())
    cell, why, want = auto_hillshade_cell(n_in, covered_m2, grid.width, grid.height,
                                          max_px=max_px)
    progress(f"  Hillshade cell {cell:.2f} m ({why})")
    surf, pw, ph = lidar_ground_surface(x, y, z, grid, cell, mode)
    # At about one return per pixel, per-point noise (a few cm) shows up as
    # scan-line striping on every slope. A 0.7 px blur removes it and leaves
    # pits and ledges a metre across untouched; when a cap made pixels coarser
    # than the data, each already averages several returns and needs less.
    sigma = 0.7 * min(1.0, want / cell)
    if sigma > 0.2:
        surf = gaussian_filter(surf, sigma)
    shade = multidirectional_hillshade(surf, pw, ph)
    img = Image.fromarray(shade)          # uint8 2-D -> 'L'
    progress(f"  Hillshade: {img.size[0]}x{img.size[1]} px")
    return img, cell


def dem_hillshade(dem, cell, grid, max_px=16384, target_cell=2.5, progress=print):
    """Multi-directional hillshade of the terrain DEM itself, pixel-aligned with
    the mesh. Quick, and the only hillshade there is when the terrain came from
    the map rather than the LiDAR. A coarse DEM is upsampled (cubic) toward
    `target_cell` first, so its pixels don't shade as blocks.
    `dem` is build_dem's layout, [x, y] with y northward.
    Returns (PIL grayscale image, cell size m).
    """
    from scipy.ndimage import zoom
    surf = np.asarray(dem, dtype=np.float32).T[::-1]        # rows north -> south
    long_side = max(surf.shape)
    k = int(max(1, min(4, math.floor(cell / target_cell), max_px // max(1, long_side))))
    if k > 1:
        surf = zoom(surf, k, order=3)
    pw, ph = grid.width / surf.shape[1], grid.height / surf.shape[0]
    shade = multidirectional_hillshade(surf, pw, ph)
    img = Image.fromarray(shade)
    progress(f"  Hillshade from the terrain: {img.size[0]}x{img.size[1]} px, {cell / k:.2f} m")
    return img, cell / k


def load_map_dem(dem_grid_path, rect, cell, zone, south=False, progress=print):
    """The terrain FLEX's map shows (Cesium), sampled in the browser on a
    regular lon/lat grid, resampled onto the export's UTM cells (bilinear at
    each cell centre). Heights are already in the map's frame, so no vertical
    shift is applied. Returns (dem [x, y], x_bins, y_bins, x0, y0, valid).

    `dem_grid_path`: JSON {lon0, lat0, dlon, dlat, nx, ny, file}; `file` (next
    to it) holds ny rows of nx little-endian float32, row 0 = lat0, NaN where
    the map had nothing.
    """
    hdr = json.loads(Path(dem_grid_path).read_text())
    nx, ny = int(hdr['nx']), int(hdr['ny'])
    raw = np.fromfile(Path(dem_grid_path).parent / hdr['file'], dtype='<f4')
    if raw.size != nx * ny:
        sys.exit(f"ERROR: map terrain grid holds {raw.size} heights, expected {nx}x{ny}")
    H = raw.reshape(ny, nx).astype(np.float64)
    x_min, y_min, x_max, y_max = rect
    nxc = max(1, int(round((x_max - x_min) / cell)))
    nyc = max(1, int(round((y_max - y_min) / cell)))
    x_bins = x_min + np.arange(nxc + 1) * cell
    y_bins = y_min + np.arange(nyc + 1) * cell
    progress(f"  Map terrain: {nx}x{ny} samples -> {nxc}x{nyc} cells of {cell:g} m")
    E, N = np.meshgrid(x_bins[:-1] + cell / 2, y_bins[:-1] + cell / 2, indexing='ij')
    lat, lon = utm_to_latlon(E, N, zone, south)
    fx = (lon - float(hdr['lon0'])) / float(hdr['dlon'])
    fy = (lat - float(hdr['lat0'])) / float(hdr['dlat'])
    inside = (fx >= 0) & (fy >= 0) & (fx <= nx - 1) & (fy <= ny - 1)
    i0 = np.clip(np.floor(fx).astype(np.int64), 0, max(0, nx - 2))
    j0 = np.clip(np.floor(fy).astype(np.int64), 0, max(0, ny - 2))
    u = np.clip(fx - i0, 0, 1); v = np.clip(fy - j0, 0, 1)
    i1 = np.minimum(i0 + 1, nx - 1); j1 = np.minimum(j0 + 1, ny - 1)
    dem = (H[j0, i0] * (1 - u) * (1 - v) + H[j0, i1] * u * (1 - v)
           + H[j1, i0] * (1 - u) * v + H[j1, i1] * u * v)
    dem[~inside] = np.nan
    valid = np.isfinite(dem)
    if not valid.any():
        sys.exit("ERROR: the map terrain grid does not cover the export rectangle")
    if not valid.all():
        rows, cols = dem.shape
        xi, yi = np.meshgrid(np.arange(rows), np.arange(cols), indexing='ij')
        dem[~valid] = NearestNDInterpolator(list(zip(xi[valid], yi[valid])), dem[valid])(xi[~valid], yi[~valid])
    return dem, x_bins, y_bins, x_min, y_min, valid


RAMP_M = 60.0   # metres inside a patch's edge over which it hands over to the terrain beneath (as terrain-patch.js)


def apply_terrain_patches(dem, x_bins, y_bins, zone, south, patch_files, progress=print):
    """Lay the project's terrain patches (terrain-patch.js files, ellipsoid heights in the frame the caves
    use, NaN = no data) over the map DEM, in order (a later one over an earlier). At each cell centre a
    patch gives its own height (bilinear), and fades into what lies beneath over the last RAMP_M metres
    before its edge, or before the edge of its data (a rotated DEM's empty corners), so there is no step.
    Returns (dem, share of the cells a patch reached)."""
    from scipy.ndimage import distance_transform_edt
    cell = float(x_bins[1] - x_bins[0])
    E, N = np.meshgrid(x_bins[:-1] + cell / 2, y_bins[:-1] + cell / 2, indexing='ij')
    lat, lon = utm_to_latlon(E, N, zone, south)
    del E, N
    reached = np.zeros(dem.shape, dtype=bool)
    for path in patch_files:
        meta, g = read_terrain_patch(Path(path).read_bytes())
        W, S, Ee, Nn = meta['west'], meta['south'], meta['east'], meta['north']
        nx, ny = int(meta['nx']), int(meta['ny'])
        box = (lon >= W) & (lon <= Ee) & (lat >= S) & (lat <= Nn)
        if not box.any():
            continue
        mLon = 111320 * math.cos(math.radians((S + Nn) / 2)); mLat = 110540
        # metres from each post to the nearest post without data (the box edge counts, by a ring of "no data")
        ok = np.zeros((ny + 2, nx + 2), dtype=bool)
        ok[1:-1, 1:-1] = np.isfinite(g)
        dist = distance_transform_edt(ok, sampling=((Nn - S) / (ny - 1) * mLat, (Ee - W) / (nx - 1) * mLon)).astype(np.float32)[1:-1, 1:-1]
        ii, jj = np.nonzero(box)
        fx = (lon[ii, jj] - W) / (Ee - W) * (nx - 1)
        fy = (Nn - lat[ii, jj]) / (Nn - S) * (ny - 1)
        x0 = np.clip(np.floor(fx).astype(np.int64), 0, nx - 2); y0 = np.clip(np.floor(fy).astype(np.int64), 0, ny - 2)
        u = np.clip(fx - x0, 0, 1); v = np.clip(fy - y0, 0, 1)
        h = (g[y0, x0] * (1 - u) * (1 - v) + g[y0, x0 + 1] * u * (1 - v) + g[y0 + 1, x0] * (1 - u) * v + g[y0 + 1, x0 + 1] * u * v).astype(np.float64)
        d = (dist[y0, x0] * (1 - u) * (1 - v) + dist[y0, x0 + 1] * u * (1 - v) + dist[y0 + 1, x0] * (1 - u) * v + dist[y0 + 1, x0 + 1] * u * v)
        t = np.clip(d / RAMP_M, 0, 1)
        keep = np.isfinite(h) & (d > 0)
        w = (t * t * (3 - 2 * t))                           # 0 at the edge, 1 from RAMP_M in
        base = dem[ii, jj]
        dem[ii[keep], jj[keep]] = (base + w * (h - base))[keep]
        reached[ii[keep], jj[keep]] = True
        progress(f"  Project terrain patch ({nx}x{ny} posts of {meta.get('cell_m', '?')} m): {int(keep.sum()):,} cells")
    return dem, float(reached.mean())


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
    # Libraries that live only in the repo (flexlib.js, utif.js): no download.
    for local in sorted(libs_dir.glob('*.js')):
        key = 'libs/' + local.name
        if key not in result:
            result[key] = local
    return result


# ──────────────────────────────────────────────────────────────────────────────
# Cave coordinate conversion
# ──────────────────────────────────────────────────────────────────────────────

def convert_caves(caves_path, utm_center_e, utm_center_n, progress=print, zone=None):
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
            e1, n1, _ = latlon_to_utm(lat1, lon1, zone)
            e2, n2, _ = latlon_to_utm(lat2, lon2, zone)
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
            se, sn, _ = latlon_to_utm(slat, slon, zone)
            entry = {
                "name": st.get("name", ""),
                "xyz":  [se - utm_center_e, sn - utm_center_n, selev],
            }
            if st.get("lrud") is not None:
                entry["lrud"] = st["lrud"]
            if st.get("dist") is not None:
                entry["dist"] = st["dist"]
            if st.get("comment"):
                entry["comment"] = st["comment"]
            stations_out.append(entry)

        survey_out = {
            "name":     survey.get("name",  "Survey"),
            "color":    survey.get("color", "#00e5ff"),
            "lines":    lines,
            "shots":    shots_out,
            "stations": stations_out,
        }
        # Cave the survey belongs to: the viewer keys station names per cave,
        # so two caves' station "1" stay two stations.
        if survey.get("cave"):
            survey_out["cave"] = survey["cave"]
        # The survey's code on its own (the name is "code — description").
        if survey.get("code") is not None:
            survey_out["code"] = str(survey["code"])
        # Open leads: station name, position and the note/size/date, if any.
        leads_out = []
        for ld in survey.get("leads", []):
            le, ln, _ = latlon_to_utm(ld.get("lat", 0), ld.get("lon", 0), zone)
            entry = {"station": ld.get("station", ""),
                     "xyz": [le - utm_center_e, ln - utm_center_n, ld.get("elev", 0)]}
            for key in ("description", "width", "height", "date"):
                if ld.get(key) is not None:
                    entry[key] = ld[key]
            leads_out.append(entry)
        if leads_out:
            survey_out["leads"] = leads_out
        out["surveys"].append(survey_out)
    # Area labels named in FLEX: text at a point, same conversion as stations.
    labels_out = []
    for lb in raw.get("labels", []):
        if not lb.get("text"):
            continue
        le, ln, _ = latlon_to_utm(lb.get("lat", 0), lb.get("lon", 0), zone)
        labels_out.append({"text": str(lb["text"])[:60],
                           "xyz": [le - utm_center_e, ln - utm_center_n, lb.get("elev", 0)]})
    if labels_out:
        out["labels"] = labels_out
    # The FLEX project these caves belong to, and each cave's id (doc 11): the
    # phone links them without asking. Ids are random, names as the user typed.
    proj = raw.get("project")
    if isinstance(proj, dict) and proj.get("id"):
        out["_project"] = {"id": str(proj["id"])[:40], "name": str(proj.get("name") or "")[:60]}
    cave_ids = [{"id": str(c["id"])[:40], "name": str(c.get("name") or "")}
                for c in (raw.get("cave_ids") or []) if isinstance(c, dict) and c.get("id")]
    if cave_ids:
        out["_caves"] = cave_ids
    progress(f"  Converted {sum(len(s['lines']) for s in out['surveys']):,} shots across "
             f"{len(out['surveys'])} surveys")

    # Passage walls (optional): meshes FLEX drew from the LRUDs, sent as a flat
    # lon/lat/alt vertex list plus triangle indices. Converted with the same
    # latlon_to_utm and centre as the shots, so the walls sit on the lines.
    #   in:  {"color", "opacity", "lonlat": [lon,lat,alt,...], "indices": [...]}
    #   out: {"color", "opacity", "positions": [x,y,z,...],   "indices": [...]}
    passages_out = []
    for pg in raw.get("passages", []) or []:
        ll = pg.get("lonlat") or []
        idx = pg.get("indices") or []
        nv = len(ll) // 3
        if nv < 3 or len(idx) < 3:
            continue
        pos = []
        for i in range(nv):
            lon, lat, alt = ll[3 * i], ll[3 * i + 1], ll[3 * i + 2]
            e, n, _ = latlon_to_utm(lat, lon, zone)
            pos.extend((round(e - utm_center_e, 3), round(n - utm_center_n, 3), round(alt, 3)))
        tris = []                       # drop whole triangles, never single indices
        for t in range(0, len(idx) - 2, 3):
            tri = (int(idx[t]), int(idx[t + 1]), int(idx[t + 2]))
            if all(0 <= k < nv for k in tri):
                tris.extend(tri)
        idx = tris
        passages_out.append({
            "color":     pg.get("color", "#00e5ff"),
            "opacity":   float(pg.get("opacity", 0.55)),
            "positions": pos,
            "indices":   idx,
        })
    if passages_out:
        out["passages"] = passages_out
        progress(f"  Converted passage walls: "
                 f"{sum(len(p['indices']) // 3 for p in passages_out):,} triangles")
    return out


# ──────────────────────────────────────────────────────────────────────────────
# Project terrain (--project-terrain OUT_DIR)
# ──────────────────────────────────────────────────────────────────────────────
# The same ground, DEM and "From LiDAR" hillshade as the export, kept by a FLEX
# project instead of packed into a viewer: the DEM as a terrain patch (the .bin
# terrain-patch.js reads: uint32 LE header length, JSON header padded with
# spaces to a 4-byte boundary, float32 LE ellipsoid heights on a lon/lat grid,
# first row = north, NaN = no data) and the hillshade as web-mercator XYZ
# tiles (PNG, grey + alpha, transparent outside the area and where the data
# runs out). Nothing here reads a point cloud, so it is tested with synthetic
# points (tools/test_project_terrain.py).

PATCH_MAX_SIDE = 3000      # grid posts a side of one patch, as the browser bake (terrain-patch.js): ~36 MB, under the library's 40 MB blob limit
TILE_PX = 256


def latlon_to_utm_np(lat, lon, zone, south=False):
    """latlon_to_utm() for arrays, in one fixed zone and hemisphere (the frame's)."""
    lat_r = np.radians(np.asarray(lat, dtype=np.float64))
    lon_r = np.radians(np.asarray(lon, dtype=np.float64))
    lon0 = math.radians((zone - 1) * 6 - 180 + 3)
    a, f = 6378137.0, 1 / 298.257223563
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    s, c = np.sin(lat_r), np.cos(lat_r)
    N = a / np.sqrt(1 - e2 * s ** 2)
    T = np.tan(lat_r) ** 2
    C = ep2 * c ** 2
    A = c * (lon_r - lon0)
    M = a * ((1 - e2/4 - 3*e2**2/64 - 5*e2**3/256) * lat_r
             - (3*e2/8 + 3*e2**2/32 + 45*e2**3/1024) * np.sin(2*lat_r)
             + (15*e2**2/256 + 45*e2**3/1024) * np.sin(4*lat_r)
             - (35*e2**3/3072) * np.sin(6*lat_r))
    k0 = 0.9996
    e = k0 * N * (A + (1-T+C)*A**3/6 + (5-18*T+T**2+72*C-58*ep2)*A**5/120) + 500000
    n = k0 * (M + N*np.tan(lat_r)*(A**2/2 + (5-T+9*C+4*C**2)*A**4/24
                                   + (61-58*T+T**2+600*C-330*ep2)*A**6/720))
    if south:
        n = n + 10_000_000
    return e, n


def box_ring(bbox, step_deg=None):
    """A lat/lon box as a ring of points along its edges (its edges are not
    straight in UTM, so they are walked rather than given by four corners)."""
    w, s, e, n = bbox
    t = np.linspace(0.0, 1.0, 33)[:-1]
    return np.vstack([np.c_[w + (e - w) * t, np.full_like(t, s)], np.c_[np.full_like(t, e), s + (n - s) * t],
                      np.c_[e - (e - w) * t, np.full_like(t, n)], np.c_[np.full_like(t, w), n - (n - s) * t]])


PATCH_MAX_TILES = 9        # patches for one area (3 x 3): each is up to ~36 MB; same limit as the browser bake (terrain-patch.js)
PATCH_OVERLAP_M = 150      # neighbouring patches overlap by this, more than twice the hand-over strip


def _sample_box(dem, x_bins, y_bins, resolution, zone, south, lons, lats_all, keep):
    """The DEM sampled bilinearly at (lons x lats_all) (degrees; lats from north to south), NaN where
    outside the DEM or where `keep` (bool [x, y]) is False. float32 [len(lats_all), len(lons)]."""
    nxc, nyc = dem.shape
    grid = np.full((len(lats_all), len(lons)), np.nan, dtype=np.float32)
    for j0 in range(0, len(lats_all), 256):                # in bands: a 3000 x 3000 grid at once is a GB of temporaries
        lats = lats_all[j0:j0 + 256]
        LON, LAT = np.meshgrid(lons, lats)
        e, n = latlon_to_utm_np(LAT, LON, zone, south)
        fx = (e - x_bins[0]) / resolution - 0.5            # cell centre i sits at x_bins[0] + (i + 0.5) * res
        fy = (n - y_bins[0]) / resolution - 0.5
        inside = (fx >= -0.5) & (fx <= nxc - 0.5) & (fy >= -0.5) & (fy <= nyc - 0.5)
        i0 = np.clip(np.floor(fx).astype(np.int64), 0, max(0, nxc - 2))
        j0c = np.clip(np.floor(fy).astype(np.int64), 0, max(0, nyc - 2))
        i1, j1 = np.minimum(i0 + 1, nxc - 1), np.minimum(j0c + 1, nyc - 1)
        u = np.clip(fx - i0, 0, 1); v = np.clip(fy - j0c, 0, 1)
        h = (dem[i0, j0c] * (1 - u) * (1 - v) + dem[i1, j0c] * u * (1 - v)
             + dem[i0, j1] * (1 - u) * v + dem[i1, j1] * u * v)
        if keep is not None:
            inside &= keep[np.clip(np.rint(fx).astype(np.int64), 0, nxc - 1),
                           np.clip(np.rint(fy).astype(np.int64), 0, nyc - 1)]
        grid[j0:j0 + len(lats)] = np.where(inside, h, np.nan)
    return grid


def terrain_patch_grid(dem, x_bins, y_bins, resolution, zone, south, ll_box, keep=None,
                       max_side=PATCH_MAX_SIDE):
    """The DEM (build_dem's [x, y] layout, values at cell centres, already in
    the frame's heights) sampled bilinearly on ONE lon/lat grid over ll_box.
    Posts about `resolution` apart, at most `max_side` a side (coarser if the
    box needs more; terrain_patch_tiles() keeps the resolution instead). Where
    `keep` (bool [x, y]) is False, or outside the DEM, the post is NaN:
    terrain-patch.js fills it from the world terrain.
    Returns (meta, grid float32 [ny, nx], row 0 = north)."""
    W, S, E, N = [float(v) for v in ll_box]
    lat0 = math.radians((S + N) / 2)
    mLon, mLat = 111320 * math.cos(lat0), 110540
    nx = int(round((E - W) * mLon / resolution)) + 1
    ny = int(round((N - S) * mLat / resolution)) + 1
    k = min(1.0, max_side / max(nx, ny))
    nx, ny = max(2, int(round(nx * k))), max(2, int(round(ny * k)))
    grid = _sample_box(dem, x_bins, y_bins, resolution, zone, south,
                       W + (E - W) * np.arange(nx) / (nx - 1), N - (N - S) * np.arange(ny) / (ny - 1), keep)
    return _patch_meta(grid, W, S, E, N, nx, ny, mLon)


def _patch_meta(grid, W, S, E, N, nx, ny, mLon):
    ok = np.isfinite(grid)
    if not ok.any():
        sys.exit("ERROR: no terrain inside the area")
    meta = {'west': W, 'south': S, 'east': E, 'north': N, 'nx': nx, 'ny': ny,
            'units': 'm', 'heightReference': 'WGS84 ellipsoid',
            'min': float(grid[ok].min()), 'max': float(grid[ok].max()),
            'cell_m': round((E - W) * mLon / (nx - 1), 3)}
    return meta, grid


def plan_patches(ll_box, resolution, max_side=PATCH_MAX_SIDE, max_tiles=PATCH_MAX_TILES,
                 overlap_m=PATCH_OVERLAP_M):
    """How a lon/lat box is cut into patches of at most max_side posts a side (the
    same plan as terrain-patch.js plan()): the posts keep `resolution` and one lattice, the
    patches overlap by overlap_m, and if that takes more than max_tiles of them the
    posts are widened (by 4% steps) until it fits.
    Returns {cell_m, nx, ny, tiles: [(i0, j0, w, h)] in posts of the whole lattice}."""
    W, S, E, N = [float(v) for v in ll_box]
    mLon, mLat = 111320 * math.cos(math.radians((S + N) / 2)), 110540
    cell = max(float(resolution), 0.01)
    while True:
        nx = int(round((E - W) * mLon / cell)) + 1
        ny = int(round((N - S) * mLat / cell)) + 1
        ov = int(math.ceil(overlap_m / cell))
        def cut(n):
            if n <= max_side:
                return [(0, n)]
            out, a, st = [], 0, max_side - ov
            while True:
                b = min(n, a + max_side)
                out.append((a, b - a))
                if b >= n:
                    return out
                a += st
        tx, ty = cut(nx), cut(ny)
        if len(tx) * len(ty) <= max_tiles:
            return {'cell_m': cell, 'nx': nx, 'ny': ny,
                    'tiles': [(i0, j0, max(2, w), max(2, h)) for j0, h in ty for i0, w in tx]}
        cell *= 1.04


def terrain_patch_tiles(dem, x_bins, y_bins, resolution, zone, south, ll_box, keep=None,
                        max_side=PATCH_MAX_SIDE, max_tiles=PATCH_MAX_TILES, overlap_m=PATCH_OVERLAP_M):
    """Like terrain_patch_grid(), but a big area keeps its resolution: it is cut into
    overlapping patches (plan_patches). Yields (meta, grid) one at a time, west to east then
    north to south, leaving out a patch that holds no data. meta['part'] is its number (1-based)
    when there are several; meta['dem_cell_m'] the resolution asked for."""
    W, S, E, N = [float(v) for v in ll_box]
    mLon = 111320 * math.cos(math.radians((S + N) / 2))
    pl = plan_patches(ll_box, resolution, max_side, max_tiles, overlap_m)
    dlon, dlat = (E - W) / (pl['nx'] - 1), (N - S) / (pl['ny'] - 1)
    made = 0
    for k, (i0, j0, w, h) in enumerate(pl['tiles']):
        west, north = W + i0 * dlon, N - j0 * dlat
        east, south_ = west + (w - 1) * dlon, north - (h - 1) * dlat
        grid = _sample_box(dem, x_bins, y_bins, resolution, zone, south,
                           west + dlon * np.arange(w), north - dlat * np.arange(h), keep)
        if not np.isfinite(grid).any():
            continue
        meta, grid = _patch_meta(grid, west, south_, east, north, w, h, mLon)
        meta['cell_m'] = round(dlon * mLon, 3)
        meta['dem_cell_m'] = float(resolution)
        if len(pl['tiles']) > 1:
            meta['part'] = k + 1
        made += 1
        yield meta, grid
    if not made:
        sys.exit("ERROR: no terrain inside the area")


def pack_terrain_patch(meta, grid):
    """Bytes of a terrain patch file, as terrain-patch.js pack() writes it."""
    head = json.dumps(dict({'format': 'flex-terrain-patch', 'version': 2}, **meta),
                      separators=(',', ':')).encode('utf-8')
    pad = (4 - ((4 + len(head)) % 4)) % 4
    g = np.ascontiguousarray(grid, dtype='<f4')
    return struct.pack('<I', len(head) + pad) + head + b' ' * pad + g.tobytes()


def read_terrain_patch(data):
    """(meta, grid [ny, nx]) from terrain patch bytes (for tests and checks)."""
    n = struct.unpack('<I', data[:4])[0]
    meta = json.loads(data[4:4 + n].decode('utf-8'))
    grid = np.frombuffer(data, dtype='<f4', offset=4 + n, count=meta['nx'] * meta['ny'])
    return meta, grid.reshape(meta['ny'], meta['nx'])


def tile_range(ll_box, z):
    """XYZ tiles (x0, y0, x1, y1 inclusive) covering a lon/lat box at zoom z."""
    w, s, e, n = ll_box
    wx0, wy0 = _merc_world_px(w, n, z, TILE_PX)
    wx1, wy1 = _merc_world_px(e, s, z, TILE_PX)
    top = 2 ** z - 1
    return (int(min(top, max(0, wx0 // TILE_PX))), int(min(top, max(0, wy0 // TILE_PX))),
            int(min(top, max(0, (wx1 - 1e-9) // TILE_PX))), int(min(top, max(0, (wy1 - 1e-9) // TILE_PX))))


def tile_bounds(x, y, z):
    """(west, south, east, north) degrees of an XYZ tile."""
    n = 2.0 ** z
    lon = lambda i: i / n * 360.0 - 180.0
    lat = lambda j: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * j / n))))
    return lon(x), lat(y + 1), lon(x + 1), lat(y)


def tile_zooms(ll_box, cell, max_zoom=21):
    """(min, max) zoom: the finest level's pixels are at least as fine as the
    hillshade's; the coarsest is the finest level where the whole area takes
    at most four tiles (Cesium asks for every tile of its minimum level at
    once; zoomed out further the area is a few pixels anyway)."""
    lat_mid = (ll_box[1] + ll_box[3]) / 2
    zmax = _choose_zoom(lat_mid, cell, TILE_PX, zmin=1, zmax=max_zoom)
    zmin = zmax
    while zmin > 0:
        x0, y0, x1, y1 = tile_range(ll_box, zmin)
        if (x1 - x0 + 1) * (y1 - y0 + 1) <= 4:
            break
        zmin -= 1
    return zmin, zmax


def write_tile_pyramid(img, grid, ll_box, out_dir, cell, progress=print, max_zoom=21):
    """XYZ tiles of a grey + alpha picture of the UTM grid (img: PIL 'LA', its
    edges on the grid's rectangle). The finest level is resampled from the
    picture (a bilinear QUAD per tile: over one tile the UTM-to-mercator map
    is affine to far below a pixel); each coarser one is the level below
    halved, 2 x 2 tiles into one. Fully transparent tiles are not written (the
    server answers them with an empty tile). Returns (zmin, zmax, count)."""
    out_dir = Path(out_dir)
    zmin, zmax = tile_zooms(ll_box, cell, max_zoom)
    W, H = img.size
    sx, sy = W / grid.width, H / grid.height
    x0, y0, x1, y1 = tile_range(ll_box, zmax)
    progress(f"  Tiles: zoom {zmin}-{zmax}, {(x1 - x0 + 1) * (y1 - y0 + 1)} at zoom {zmax}")
    have = set()
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            w, s, e, n = tile_bounds(tx, ty, zmax)
            E, N = latlon_to_utm_np(np.array([n, s, s, n]), np.array([w, w, e, e]), grid.zone, grid.south)
            px = (E - grid.e0) * sx
            py = (grid.n1 - N) * sy
            if px.max() < 0 or py.max() < 0 or px.min() > W or py.min() > H:
                continue
            quad = tuple(float(v) for pair in zip(px, py) for v in pair)   # UL, LL, LR, UR
            t = img.transform((TILE_PX, TILE_PX), Image.QUAD, quad, resample=Image.BILINEAR, fillcolor=(0, 0))
            if t.getchannel('A').getbbox() is None:
                continue
            p = out_dir / str(zmax) / str(tx)
            p.mkdir(parents=True, exist_ok=True)
            t.save(p / f'{ty}.png', compress_level=6)
            have.add((tx, ty))
        if (ty - y0) % 16 == 0:
            progress(f"  Tiles: zoom {zmax}, row {ty - y0 + 1} of {y1 - y0 + 1}")
    count = len(have)
    for z in range(zmax - 1, zmin - 1, -1):
        parents = {(x // 2, y // 2) for x, y in have}
        nxt = set()
        for px_, py_ in parents:
            big = Image.new('LA', (2 * TILE_PX, 2 * TILE_PX), (0, 0))
            for dx in (0, 1):
                for dy in (0, 1):
                    c = (2 * px_ + dx, 2 * py_ + dy)
                    if c in have:
                        with Image.open(out_dir / str(z + 1) / str(c[0]) / f'{c[1]}.png') as ch:
                            big.paste(ch.convert('LA'), (dx * TILE_PX, dy * TILE_PX))
            t = big.reduce(2)
            if t.getchannel('A').getbbox() is None:
                continue
            p = out_dir / str(z) / str(px_)
            p.mkdir(parents=True, exist_ok=True)
            t.save(p / f'{py_}.png', compress_level=6)
            nxt.add((px_, py_))
        have = nxt
        count += len(have)
    progress(f"  Tiles: {count} written")
    return zmin, zmax, count


def area_alpha(size, grid, poly_utm, drop=None):
    """Alpha (PIL 'L', 255 = shown) over the UTM grid picture: inside the
    polygon, and not where the dataset doesn't reach (`drop`, build_dem layout)."""
    from PIL import ImageDraw
    W, H = size
    sx, sy = W / grid.width, H / grid.height
    a = Image.new('L', (W, H), 0)
    ImageDraw.Draw(a).polygon([(float((e - grid.e0) * sx), float((grid.n1 - n) * sy)) for e, n in poly_utm], fill=255)
    if drop is not None and drop.any():
        d = Image.fromarray(np.where(drop.T[::-1], 0, 255).astype(np.uint8)).resize((W, H), Image.NEAREST)
        a = Image.fromarray(np.minimum(np.asarray(a), np.asarray(d)))
    return a


def project_terrain(x, y, z, ground_mode, out_dir, bbox, poly_ll=None, resolution=0.5,
                    z_offset=-32 * 0.766, spike_threshold=1.5, name='', max_px=16384,
                    source='', progress=print):
    """Ground points (UTM, in the zone of the area's centre) -> the project's
    terrain patch and hillshade tiles in out_dir:
        terrain.bin      the DEM as a terrain patch (ellipsoid heights = DEM + z_offset)
        tiles/z/x/y.png  the "From LiDAR" hillshade
        result.json      what was made (bounds, sizes, zooms)
    The steps are the export's: build_dem (lowest return per cell, cloth),
    border_nodata_mask, filter_spikes, z_offset; build_lidar_hillshade."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    say = lambda step: (lambda m: progress(f"[{step}/4] {m}"))
    if poly_ll is None:
        poly_ll = box_ring(bbox)
    else:
        poly_ll = np.asarray(poly_ll, dtype=np.float64)
        bbox = [float(poly_ll[:, 0].min()), float(poly_ll[:, 1].min()),
                float(poly_ll[:, 0].max()), float(poly_ll[:, 1].max())]
    zone = utm_zone_for((bbox[0] + bbox[2]) / 2)
    south = (bbox[1] + bbox[3]) / 2 < 0
    rect = utm_rect_covering(bbox, zone, resolution)
    c = resolution
    rect = (rect[0] - c, rect[1] - c, rect[2] + c, rect[3] + c)
    poly_utm = polygon_to_utm(poly_ll, zone)

    # DEM, exactly as the export builds it
    dem, x_bins, y_bins, x0, y0, valid = build_dem(x, y, z, resolution, progress=say(2),
                                                   extent=rect, return_valid=True)
    drop = border_nodata_mask(valid, resolution, progress=say(2))
    del valid
    if spike_threshold > 0:
        dem = filter_spikes(dem, resolution, radius_m=10.0, threshold_m=spike_threshold, progress=say(2))
    dem = dem + z_offset
    say(2)(f"Applied FLEX point-cloud Z offset: {z_offset:.3f} m")
    cells_in = polygon_inside_grid(poly_utm, x_bins[:-1] + resolution / 2, y_bins[:-1] + resolution / 2)
    covered_m2 = float((cells_in & ~drop).sum()) * resolution ** 2
    # Posts on the line itself take the cell just outside it too (one cell's grace).
    from scipy.ndimage import binary_dilation as _bd
    keep = _bd(cells_in, iterations=1) & ~drop

    # The terrain patch(es), on a lon/lat grid over the area: one, or a few overlapping ones for a big area
    parts = []
    nm = name or 'LiDAR terrain'
    for meta, tgrid in terrain_patch_tiles(dem, x_bins, y_bins, resolution, zone, south, bbox, keep=keep):
        fn = 'terrain.bin' if not parts else f'terrain_{len(parts) + 1}.bin'
        meta.update({'name': nm if 'part' not in meta else f"{nm} (part {meta['part']})",
                     'source': source or 'LiDAR ground returns',
                     'datum_shift_m': round(float(z_offset), 3), 'ground': ground_mode,
                     'dem_cell_m': float(resolution)})
        (out_dir / fn).write_bytes(pack_terrain_patch(meta, tgrid))
        parts.append({'file': fn, 'bounds': [meta['west'], meta['south'], meta['east'], meta['north']],
                      'nx': meta['nx'], 'ny': meta['ny'], 'cell_m': meta['cell_m'],
                      'min': meta['min'], 'max': meta['max'], 'name': meta['name']})
        say(2)(f"Terrain patch {len(parts)}: {meta['nx']}x{meta['ny']} posts of {meta['cell_m']} m, "
               f"heights {meta['min']:.1f} to {meta['max']:.1f} m (ellipsoid)")
        del tgrid
    meta = {'name': nm, 'west': min(p['bounds'][0] for p in parts), 'south': min(p['bounds'][1] for p in parts),
            'east': max(p['bounds'][2] for p in parts), 'north': max(p['bounds'][3] for p in parts)}
    meta.update(nx=parts[0]['nx'], ny=parts[0]['ny'], cell_m=parts[0]['cell_m'],
                min=min(p['min'] for p in parts), max=max(p['max'] for p in parts))

    # The "From LiDAR" hillshade, transparent outside the area
    grid = UtmGrid(x_bins[0], y_bins[0], x_bins[-1], y_bins[-1], zone, south)
    say(3)("Building hillshade from LiDAR ground returns...")
    hs, hs_cell = build_lidar_hillshade(x, y, z, grid, covered_m2, mode=ground_mode,
                                        max_px=max_px, progress=say(3))
    alpha = area_alpha(hs.size, grid, poly_utm, drop)
    a = np.asarray(alpha)
    L = np.asarray(hs).copy()
    if (a > 0).any():
        L[a == 0] = int(round(float(L[a > 0].mean())))      # flat outside: no dark fringe when levels are halved
    img = Image.merge('LA', (Image.fromarray(L), alpha))
    del hs, L, a, alpha
    say(4)("Cutting map tiles...")
    zmin, zmax, count = write_tile_pyramid(img, grid, bbox, out_dir / 'tiles', hs_cell, progress=say(4))
    tiles = {'format': 'flex-tiles', 'scheme': 'xyz', 'tile_px': TILE_PX, 'ext': 'png',
             'bounds': [round(float(v), 8) for v in bbox], 'minzoom': zmin, 'maxzoom': zmax,
             'count': count, 'cell_m': float(hs_cell), 'name': meta['name']}
    (out_dir / 'tiles' / 'tiles.json').write_text(json.dumps(tiles, indent=1))
    result = {
        'terrain': {'file': 'terrain.bin', 'bounds': parts[0]['bounds'],
                    'nx': parts[0]['nx'], 'ny': parts[0]['ny'], 'cell_m': parts[0]['cell_m'],
                    'min': meta['min'], 'max': meta['max']},
        'terrain_tiles': parts,              # every patch, in order (the first is 'terrain'); later ones lie over earlier ones
        'tiles': dict(tiles, dir='tiles'),
        'z_offset': float(z_offset), 'ground': ground_mode, 'name': meta['name'],
        'utm_zone': zone, 'area_km2': round(polygon_area(poly_utm) / 1e6, 4),
    }
    (out_dir / 'result.json').write_text(json.dumps(result, indent=1))
    progress(f"[done] Project terrain: {len(parts)} patch(es), {count} tiles (zoom {zmin}-{zmax})")
    return result


# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ept',         default=None, help='Path to ept.json (the LiDAR terrain)')
    ap.add_argument('--dem-grid',    default=None,
                    help='Terrain from the map instead of the LiDAR: a grid FLEX sampled '
                         '(JSON header; see load_map_dem). No point cloud is read.')
    ap.add_argument('--bbox',        required=True, nargs=4, type=float,
                    metavar=('minLon','minLat','maxLon','maxLat'))
    ap.add_argument('--caves',       default=None,  help='Path to caves.json (PLT lines)')
    ap.add_argument('--polygon',     default=None,
                    help='Export only inside this polygon: JSON [[lon, lat], ...]. A hard cut '
                         '(terrain ends exactly at the line); the frame is the box around it, '
                         'and --bbox is replaced by the polygon\'s bounds.')
    ap.add_argument('--out',         default='export.zip')
    ap.add_argument('--name',        default='',
                    help='Map name, shown in the viewer title bar and used for the app label')
    ap.add_argument('--z-offset',    type=float, default=None,
                    help="Vertical shift for the DEM (m), as FLEX shifts its point clouds; default -32*0.766")
    ap.add_argument('--resolution',  type=float, default=0.5, help='DEM cell size in metres')
    ap.add_argument('--percentile',  type=float, default=2,   help='Ground percentile (2=very low)')
    ap.add_argument('--max-triangles', type=int, default=2_000_000)
    ap.add_argument('--tex-size',      type=int,   default=8192)
    ap.add_argument('--spike-threshold', type=float, default=1.5,
                    help='Remove upward spikes > this many metres above local median '
                         '(10m radius window). Set to 0 to disable. Default: 1.5')
    ap.add_argument('--satellite-source', default='bing', choices=['esri', 'bing', 'xyz', 'image'],
                    help='Satellite imagery source: esri (default) or bing; xyz = tiles from '
                         '--satellite-url; image = a picture on a lon/lat box (--satellite-image, '
                         '--satellite-bounds). A layer that fails falls back to bing/esri.')
    ap.add_argument('--satellite-url', default='', help='XYZ tile URL template for --satellite-source xyz.')
    ap.add_argument('--satellite-tile-px', type=int, default=256, help='Tile size of --satellite-url (default 256).')
    ap.add_argument('--satellite-image', default=None, help='Picture (png/webp/jpg) for --satellite-source image.')
    ap.add_argument('--satellite-bounds', nargs=4, type=float, metavar=('W', 'S', 'E', 'N'), default=None,
                    help='Lon/lat box of --satellite-image, in degrees.')
    ap.add_argument('--terrain-patch', action='append', default=[], metavar='BIN',
        help='With --dem-grid: a project terrain patch (terrain-patch.js file) laid over the map terrain '
             'where it covers the area; repeat for several (later ones on top).')
    ap.add_argument('--hillshade-image', default=None, help='Picture on a lon/lat box for --hillshade image.')
    ap.add_argument('--hillshade-bounds', nargs=4, type=float, metavar=('W', 'S', 'E', 'N'), default=None)
    ap.add_argument('--hillshade-tile-px', type=int, default=512, help='Tile size of --hillshade-url (default 512).')
    ap.add_argument('--hillshade', default=None, choices=['none', 'lidar', 'dem', 'url', 'image'],
        help='Hillshade layer: lidar (built from the ground returns; default), '
             'dem (shaded terrain DEM, quick), url (tiles from --hillshade-url) '
             'or none. If omitted: url when --hillshade-url is given, otherwise '
             'lidar. With --dem-grid, lidar becomes dem.')
    ap.add_argument('--hillshade-url', default='',
        help='XYZ tile URL template for --hillshade url (use {z}/{x}/{y}).')
    ap.add_argument('--hillshade-max-px', type=int, default=16384,
        help='Longest side of the LiDAR hillshade texture (default 16384, the '
             'largest single texture most GPUs accept).')
    ap.add_argument('--project-terrain', default=None, metavar='OUT_DIR',
        help='Instead of a viewer export: the DEM as a terrain patch (terrain.bin) and the '
             'LiDAR hillshade as XYZ map tiles (tiles/), for a FLEX project. Needs --ept.')
    ap.add_argument('--also-ept', action='append', default=[], metavar='EPT',
        help='With --project-terrain: more datasets, their ground returns used together.')
    args = ap.parse_args()
    map_terrain = bool(args.dem_grid)
    if not map_terrain and not args.ept:
        sys.exit("ERROR: give --ept (LiDAR terrain) or --dem-grid (map terrain)")
    hs_mode = args.hillshade or ('url' if args.hillshade_url else 'lidar')
    if hs_mode == 'url' and not args.hillshade_url:
        print("[export] --hillshade url without --hillshade-url; building it from the terrain instead")
        hs_mode = 'lidar'
    if map_terrain and hs_mode == 'lidar':
        hs_mode = 'dem'                    # no LiDAR read: shade the map's terrain
    if map_terrain:
        hdr = json.loads(Path(args.dem_grid).read_text())
        args.resolution = float(hdr.get('cell') or args.resolution)
        print(f"[export] Terrain from the map, {args.resolution:g} m cells (no point cloud read)")
    map_name = (args.name or '').strip()

    poly_ll = None
    if args.polygon:
        poly_ll = load_polygon(args.polygon)
        args.bbox = [float(poly_ll[:, 0].min()), float(poly_ll[:, 1].min()),
                     float(poly_ll[:, 0].max()), float(poly_ll[:, 1].max())]
    minLon, minLat, maxLon, maxLat = args.bbox
    print(f"[export] BBox: ({minLat:.5f},{minLon:.5f}) -> ({maxLat:.5f},{maxLon:.5f})")
    if map_name:
        print(f"[export] Name: {map_name}")

    # One UTM zone for the whole export: the bbox centre's.
    bbox_center_lon = (minLon + maxLon) / 2
    bbox_center_lat = (minLat + maxLat) / 2
    zone = utm_zone_for(bbox_center_lon)
    south = bbox_center_lat < 0

    # The terrain is an upright UTM rectangle covering everything drawn. Points
    # are requested for a little more than that so every cell has real data
    # behind it, whatever CRS the dataset is stored in.
    rect = utm_rect_covering(args.bbox, zone, args.resolution)
    poly_utm = None
    if poly_ll is not None:
        poly_utm = polygon_to_utm(poly_ll, zone)
        # One more cell all round: mesh vertices sit at cell centres, half a
        # cell in from the rectangle, and the line has to be inside them.
        c = args.resolution
        rect = (rect[0] - c, rect[1] - c, rect[2] + c, rect[3] + c)
        rect_area = (rect[2] - rect[0]) * (rect[3] - rect[1])
        print(f"[export] Polygon: {len(poly_utm)} points, {polygon_area(poly_utm) / 1e6:.3f} km^2 "
              f"({polygon_area(poly_utm) / rect_area * 100:.0f}% of its box); nothing outside it is exported")
        if self_intersecting(poly_utm):
            print("[export] WARNING: the polygon's edges cross; inside is taken by the even-odd rule")
    pad = max(5.0, 4 * args.resolution)
    q_rect = (rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad)
    q_ll = latlon_box_covering(q_rect, zone, south)
    print(f"[export] UTM zone {zone}: E {rect[0]:.0f}-{rect[2]:.0f}, N {rect[1]:.0f}-{rect[3]:.0f} "
          f"({(rect[2]-rect[0])/1000:.2f} x {(rect[3]-rect[1])/1000:.2f} km)")

    if args.project_terrain:
        # A project's own terrain: same points, DEM and hillshade, kept as a
        # terrain patch and map tiles instead of a viewer (project_terrain()).
        if map_terrain:
            sys.exit("ERROR: --project-terrain needs the LiDAR (--ept), not --dem-grid")
        parts, modes = [], []
        for k, ept in enumerate([args.ept] + list(args.also_ept or [])):
            x, y, z, r, g, b, mode = fetch_ept_points(
                ept, q_rect, bbox_latlon=q_ll, progress=lambda m: print(f"[1/4] {m}"),
                zone=zone, south=south, with_mode=True)
            del r, g, b
            if poly_utm is not None:
                n0 = len(x)
                keep = points_near_polygon(x, y, poly_utm, rect, pad + 2 * args.resolution, args.resolution)
                x, y, z = x[keep], y[keep], z[keep]
                print(f"[1/4] Polygon: kept {len(x):,} of {n0:,} points")
            parts.append((x, y, z)); modes.append(mode)
        x = np.concatenate([p[0] for p in parts]); y = np.concatenate([p[1] for p in parts])
        z = np.concatenate([p[2] for p in parts]); del parts
        # Ground found the least reliable way decides how the hillshade treats them all.
        mode = 'all' if 'all' in modes else ('smrf' if 'smrf' in modes else 'classified')
        z_off = args.z_offset if args.z_offset is not None else -32 * 0.766
        project_terrain(x, y, z, mode, args.project_terrain, args.bbox, poly_ll=poly_ll,
                        resolution=args.resolution, z_offset=z_off,
                        spike_threshold=args.spike_threshold, name=map_name,
                        max_px=args.hillshade_max_px,
                        source=', '.join(Path(str(e).rstrip('/')).parent.name or str(e)
                                         for e in [args.ept] + list(args.also_ept or [])))
        return

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)

        # 0. Download viewer libs (cached)
        print("[0/7] Downloading viewer libs...")
        viewer_libs = get_viewer_libs(progress=lambda m: print(f"[0/7] {m}"))

        FLEX_PC_Z_OFFSET = args.z_offset if args.z_offset is not None else -32 * 0.766  # metres
        if map_terrain:
            # 1-2. The map's terrain, sampled by FLEX: already a bare-earth DEM in
            # the frame the caves are drawn in, so no cloth, spikes or shift.
            print("[1/7] Terrain from the map: no point cloud to read")
            x = y = z = None
            ground_mode = 'map'
            dem, x_bins, y_bins, x0, y0, valid = load_map_dem(
                args.dem_grid, rect, args.resolution, zone, south,
                progress=lambda m: print(f"[2/7] {m}"))
            if args.terrain_patch:
                dem, patch_share = apply_terrain_patches(dem, x_bins, y_bins, zone, south, args.terrain_patch,
                                                         progress=lambda m: print(f"[2/7] {m}"))
                print(f"[2/7] Project terrain used for {patch_share * 100:.0f}% of the area")
            drop = border_nodata_mask(valid, args.resolution,
                                      progress=lambda m: print(f"[2/7] {m}"))
            covered_m2 = float((~drop).sum()) * args.resolution ** 2
            del valid
        else:
            if args.terrain_patch:
                print("[1/7] Project terrain patches are for the map-terrain export; the LiDAR is used as it is")
            # 1. Fetch points
            x, y, z, r, g, b, ground_mode = fetch_ept_points(
                args.ept, q_rect, bbox_latlon=q_ll,
                progress=lambda m: print(f"[1/7] {m}"),
                zone=zone, south=south, with_mode=True,
            )
            del r, g, b
            if poly_utm is not None:
                # Only points within reach of the polygon (a margin so the cells
                # along the line are backed by real returns).
                n0 = len(x)
                k = points_near_polygon(x, y, poly_utm, rect, pad + 2 * args.resolution, args.resolution)
                x, y, z = x[k], y[k], z[k]
                print(f"[1/7] Polygon: kept {len(x):,} of {n0:,} points")
                del k

            # 2. Build DEM on the rectangle, and find where the dataset runs out
            dem, x_bins, y_bins, x0, y0, valid = build_dem(
                x, y, z, args.resolution,
                progress=lambda m: print(f"[2/7] {m}"),
                extent=rect, return_valid=True,
            )
            drop = border_nodata_mask(valid, args.resolution,
                                      progress=lambda m: print(f"[2/7] {m}"))
            covered_m2 = float((~drop).sum()) * args.resolution ** 2
            del valid

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
            # FLEX sends the shift its point clouds have now (--z-offset: EGM96 /
            # USGS / default toggles); without it, the default.
            dem += FLEX_PC_Z_OFFSET
            print(f"[2/7] Applied FLEX point-cloud Z offset: {FLEX_PC_Z_OFFSET:.3f} m")

        # Terrain centre in UTM (for cave coordinate conversion)
        utm_center_e = (x_bins[0] + x_bins[-1]) / 2
        utm_center_n = (y_bins[0] + y_bins[-1]) / 2
        clip = None
        if poly_utm is not None:
            clip = poly_utm - np.array([utm_center_e, utm_center_n])
            # The hillshade's resolution follows the area that is really kept.
            cells_in = polygon_inside_grid(poly_utm, x_bins[:-1] + args.resolution / 2,
                                           y_bins[:-1] + args.resolution / 2)
            covered_m2 = float((~drop & cells_in).sum()) * args.resolution ** 2
            del cells_in
        # The frame every texture is resampled into -- exactly the span
        # compute_uvs() maps the mesh onto.
        grid = UtmGrid(x_bins[0], y_bins[0], x_bins[-1], y_bins[-1], zone, south)

        # 3. Build mesh
        vertices, faces = build_mesh(
            dem, x_bins, y_bins, x0, y0, args.max_triangles,
            progress=lambda m: print(f"[3/7] {m}"),
            drop=drop, clip=clip,
        )

        # 4. Satellite texture, warped onto the UTM grid
        print(f"[4/7] Fetching satellite texture ({args.satellite_source.upper()})...")
        texture = None
        sat_used = args.satellite_source
        if args.satellite_source in ('xyz', 'image'):
            # a map layer of the project as the texture; if it can't be had, the usual satellite imagery
            try:
                texture = layer_texture(grid, args.tex_size, args.satellite_source, args.satellite_url,
                                        args.satellite_tile_px, args.satellite_image, args.satellite_bounds,
                                        progress=lambda m: print(f"[4/7] {m}"))
            except Exception as e:
                print(f"[4/7] WARNING: the map layer could not be used ({e}); taking Bing imagery instead")
                sat_used = 'bing'
        if texture is None:
            texture = fetch_satellite_texture(
                grid, tex_size=args.tex_size, source=('bing' if args.satellite_source in ('xyz', 'image') else args.satellite_source),
                progress=lambda m: print(f"[4/7] {m}")
            )
        if poly_utm is not None:
            blank_outside(texture, grid, poly_utm)

        # 4b. Hillshade: from the LiDAR itself, or from a tile URL
        import io as _hs_io
        hs_bytes = None
        hs_cell = None
        if hs_mode == 'lidar':
            print("[4b/7] Building hillshade from LiDAR ground returns...")
            try:
                hs_img, hs_cell = build_lidar_hillshade(
                    x, y, z, grid, covered_m2, mode=ground_mode,
                    max_px=args.hillshade_max_px,
                    progress=lambda m: print(f"[4b/7] {m}"))
                if poly_utm is not None:
                    blank_outside(hs_img, grid, poly_utm)
                hs_buf = _hs_io.BytesIO()
                hs_img.save(hs_buf, format='JPEG', quality=90)
                hs_bytes = hs_buf.getvalue()
                del hs_img
            except Exception as e:
                print(f"[4b/7] WARNING: LiDAR hillshade failed ({e}) - skipping")
        elif hs_mode == 'dem':
            print("[4b/7] Building hillshade from the terrain...")
            try:
                hs_img, hs_cell = dem_hillshade(dem, args.resolution, grid,
                                                max_px=args.hillshade_max_px,
                                                progress=lambda m: print(f"[4b/7] {m}"))
                if poly_utm is not None:
                    blank_outside(hs_img, grid, poly_utm)
                hs_buf = _hs_io.BytesIO()
                hs_img.save(hs_buf, format='JPEG', quality=90)
                hs_bytes = hs_buf.getvalue()
                del hs_img
            except Exception as e:
                print(f"[4b/7] WARNING: terrain hillshade failed ({e}) - skipping")
        elif hs_mode == 'url':
            print("[4b/7] Fetching hillshade tiles...")
            try:
                hs_img = fetch_imagery(grid, args.tex_size, source='xyz',
                                       url_template=args.hillshade_url, tile_px=args.hillshade_tile_px,
                                       progress=lambda m: print(f"[4b/7] {m}"))
                if poly_utm is not None:
                    blank_outside(hs_img, grid, poly_utm)
                hs_buf = _hs_io.BytesIO()
                hs_img.save(hs_buf, format='JPEG', quality=85)
                hs_bytes = hs_buf.getvalue()
                del hs_img
            except Exception as e:
                print(f"[4b/7] WARNING: hillshade fetch failed ({e}) - skipping")
        elif hs_mode == 'image':
            print("[4b/7] Hillshade from a map layer picture...")
            try:
                if not args.hillshade_image or not args.hillshade_bounds:
                    raise ValueError('no picture')
                hs_w, hs_h = grid.tex_dims(min(args.tex_size, args.hillshade_max_px))
                hs_img, share = warp_lonlat_image(args.hillshade_image, args.hillshade_bounds, grid, hs_w, hs_h, fill=(180, 180, 180))
                if share < 0.01:
                    raise ValueError('the picture is not on the exported area')
                print(f"[4b/7] Map layer picture: {hs_w}x{hs_h} px, covers {share * 100:.0f}% of the area")
            except Exception as e:
                print(f"[4b/7] WARNING: the hillshade layer could not be used ({e}); shading the terrain instead")
                hs_mode = 'dem'
                try:
                    hs_img, hs_cell = dem_hillshade(dem, args.resolution, grid, max_px=args.hillshade_max_px,
                                                    progress=lambda m: print(f"[4b/7] {m}"))
                except Exception as e2:
                    hs_img = None
                    print(f"[4b/7] WARNING: terrain hillshade failed ({e2}) - skipping")
            if hs_img is not None:
                if poly_utm is not None:
                    blank_outside(hs_img, grid, poly_utm)
                hs_buf = _hs_io.BytesIO()
                hs_img.save(hs_buf, format='JPEG', quality=90)
                hs_bytes = hs_buf.getvalue()
                del hs_img
        else:
            print("[4b/7] Hillshade: none")
        hs_b64 = None
        if hs_bytes:
            import base64 as _hs_b64m
            hs_b64 = _hs_b64m.b64encode(hs_bytes).decode('ascii')
            print(f"[4b/7] Hillshade: {len(hs_bytes)//1024} KB "
                  f"({len(hs_b64)//1024} KB as base64)")
        # 4c. Past ~5 km one texture caps the detail: every tile of the area gets
        # its own satellite + hillshade at full size (tex_tiles.py). The single
        # textures above stay as the overview.
        tile_files, tile_hs = {}, False
        tcols, trows = plan_tiles(grid.width, grid.height)
        if tcols * trows > 1:
            print(f"[4c/7] Texture tiles: {tcols} x {trows}")
            tile_files, tile_hs = make_tiles(
                grid, tcols, trows, lambda e0, n0, e1, n1: UtmGrid(e0, n0, e1, n1, zone, south),
                lambda g: fetch_satellite_texture(g, tex_size=args.tex_size, source=args.satellite_source,
                                                  progress=lambda m: print(f"[4c/7] {m}")),
                (lambda g, frac: build_lidar_hillshade(x, y, z, g, covered_m2 * frac, mode=ground_mode,
                                                       max_px=args.hillshade_max_px)[0]) if hs_bytes and hs_mode == 'lidar'
                else (lambda g, frac: fetch_imagery(g, args.tex_size, source='xyz', url_template=args.hillshade_url))
                if hs_bytes and hs_mode == 'url' else None,
                (lambda im, g: blank_outside(im, g, poly_utm)) if poly_utm is not None else None,
                hs_overview=Image.open(_hs_io.BytesIO(hs_bytes)) if hs_bytes else None,
                progress=lambda m: print(f"[4c/7] {m}"))
        del x, y, z

        # 5. UVs + GLB (geometry only) + separate texture encoding
        uvs = compute_uvs(vertices, dem.shape, x_bins, y_bins)
        glb_path = tmp / 'terrain.glb'
        export_glb(vertices, faces, uvs, glb_path,
                   progress=lambda m: print(f"[5/7] {m}"))

        # Encode satellite texture as plain base64 — viewer applies it with flipY=false
        import io as _tex_io, base64 as _tex_b64
        tex_buf = _tex_io.BytesIO()
        texture.save(tex_buf, format='JPEG', quality=85)
        tex_bytes = tex_buf.getvalue()
        tex_b64 = _tex_b64.b64encode(tex_bytes).decode('ascii')
        print(f"[5/7] Satellite texture: {len(tex_bytes)//1024} KB "
              f"({len(tex_b64)//1024} KB as base64)")

        # 6. Package ZIP
        print(f"[6/7] Writing {args.out}...")
        with zipfile.ZipFile(args.out, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.write(glb_path, 'terrain.glb')

            # Textures as sidecar files as well as inline base64. The single-file
            # viewer.html below still carries them for the no-server browser case,
            # but the app build wants them as plain JPEGs -- and it already has
            # them right here. Without this, packaging an APK means decoding a
            # 170 MB HTML back into the very bytes we are holding now.
            # ZIP_STORED: JPEG is already compressed, deflating it again buys
            # nothing and costs real time on a 50 MB texture.
            zf.writestr(zipfile.ZipInfo('tex_sat.jpg'), tex_bytes,
                        compress_type=zipfile.ZIP_STORED)
            if hs_bytes:
                zf.writestr(zipfile.ZipInfo('tex_hs.jpg'), hs_bytes,
                            compress_type=zipfile.ZIP_STORED)
            for tname, tbytes in tile_files.items():
                zf.writestr(zipfile.ZipInfo(tname), tbytes, compress_type=zipfile.ZIP_STORED)

            # The Three.js libs, so an export is self-sufficient for an app build
            # without needing the FLEX checkout alongside it.
            for zip_path, local in viewer_libs.items():
                if local and local.exists():
                    zf.write(local, 'libs/' + Path(zip_path).name)

            # Caves: convert lon/lat/alt -> terrain-centred XYZ, in the export's zone
            if args.caves and os.path.exists(args.caves):
                caves_out = convert_caves(
                    args.caves, utm_center_e, utm_center_n,
                    progress=lambda m: print(f"[6/7] {m}"),
                    zone=zone,
                )
            else:
                caves_out = {"surveys": []}
            # Embed coordinate meta so the viewer can convert GPS lat/lon -> scene XYZ.
            # `name` titles the viewer and names the Android app.
            caves_out["meta"] = {
                # Bumped when the export's layout changes, so FLEX Field (which
                # brings its own viewer) knows what it is reading. 1 = before
                # this field existed; every version stays readable.
                "format_version": 2,
                "name":         map_name,
                "utm_center_e": float(utm_center_e),
                "utm_center_n": float(utm_center_n),
                "utm_zone":     int(zone),
                "z_offset":     float(FLEX_PC_Z_OFFSET),
                "center_lon":   float(bbox_center_lon),
                "center_lat":   float(bbox_center_lat),
                "extent_utm":   [float(grid.e0), float(grid.n0), float(grid.e1), float(grid.n1)],
                "hillshade":    (hs_mode if hs_bytes else None),
                "hillshade_cell_m": (float(hs_cell) if hs_cell else None),
                "terrain":      ('map' if map_terrain else 'lidar'),
                "terrain_cell_m": float(args.resolution),
                "terrain_patches": len(args.terrain_patch) if map_terrain else 0,
                "satellite":    sat_used,
            }
            if tile_files:
                caves_out["meta"]["texture_tiles"] = meta_entry(tcols, trows, True, tile_hs)
            if caves_out.get("_project"):
                caves_out["meta"]["project"] = caves_out.pop("_project")
            if caves_out.get("_caves"):
                caves_out["meta"]["caves"] = caves_out.pop("_caves")
            caves_out.pop("_project", None)
            caves_out.pop("_caves", None)
            if poly_utm is not None:
                # The export area, in the viewer's frame (metres from the centre).
                caves_out["meta"]["area_polygon"] = [[round(float(e - utm_center_e), 2), round(float(n - utm_center_n), 2)]
                                                     for e, n in poly_utm]
            # Passage walls travel as a binary sidecar (cave_walls.py), not as
            # JSON: a third of the size, and the viewer loads it with no parse.
            walls_bytes = None
            if caves_out.get("passages"):
                from cave_walls import pack_walls
                walls_bytes, walls_desc = pack_walls(caves_out.pop("passages"))
                if walls_desc:
                    caves_out["walls"] = walls_desc
                    zf.writestr('walls.bin', walls_bytes)
                    print(f"[6/7] Passage walls: walls.bin {len(walls_bytes)//1024} KB, "
                          f"{sum(g['icount'] for g in walls_desc['groups'])//3:,} triangles")
                else:
                    walls_bytes = None
            zf.writestr('caves.json', json.dumps(caves_out))

            # Viewer HTML: fully self-contained (Three.js + GLB + textures + caves all inline)
            inline_html = build_inline_viewer(
                glb_path, tex_b64, caves_out, viewer_libs,
                progress=lambda m: print(f"[6/7] {m}"),
                hs_b64=hs_b64, walls_bytes=walls_bytes)
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
