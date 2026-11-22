"""area_maps.py -- compact value rasters of a processed area, for the browser's coloured map layers.

The tile route (area_tiles.js, GET /api/areas/tiles/...) reads these files by offset and applies a colour
ramp chosen in the browser, so the colours can change without re-running anything.

Files (one byte per cell, same grid as the area's ground):
    bush/brush.u8      share of returns in the brush band (0.3-1.5 m by default)
    bush/voids.u8      how far returns reach below the ground (m)
    ground/slope.u8    slope in degrees
    ground/hillshade.u8  shade under a light from the north-west, 45 deg up (0 = dark, 1 = lit)
    <folder>/maps.json { grid: { x0, y0, cell, nx, ny, zone, south, epsg, row0 },
                         maps: [ { id, file, units, min, max, suggest: [lo, hi] } ] }

Byte b: 0 = no data / nothing there; 1..255 = min + (b - 1) / 254 * (max - min).
x0, y0 = the west and south EDGES of the grid (UTM metres); cell centre i = x0 + (i + 0.5) * cell.
row0 = "north" (row 0 is the north edge, as the GeoTIFFs) or "south" (as ground.npy).

Made by the Ground step (area_ground.py) and the bushwhack step (lidar_derive.py --area-dir); for an area made
before them:  python3 area_maps.py AREA_DIR [--bush-out DIR] [--ground-out DIR]
(reads ground/ground.npy and bush/vegetation.tif + voids.tif; never the points).
"""
import json
import math
import os
import sys

import numpy as np

STRIP = 1024          # rows handled at a time: memory stays at a few strips, not the whole grid


def _grid_meta(src, row0):
    keys = ("x0", "y0", "cell", "nx", "ny", "zone", "south", "epsg")
    g = {k: src[k] for k in keys if k in src}
    g["row0"] = row0
    return g


def _scale(a, lo, hi, zero_is_nothing=False):
    """float array -> uint8 (0 = no data; 1..255 over lo..hi, clipped)."""
    a = np.asarray(a, dtype=np.float32)
    ok = np.isfinite(a)
    if zero_is_nothing:
        ok &= a != 0
    t = np.clip((np.where(ok, a, lo) - lo) / float(hi - lo), 0.0, 1.0)
    out = (1 + np.rint(t * 254)).astype(np.uint8)
    out[~ok] = 0
    return out


def _write_strips(path, rows, nrows, lo, hi, zero_is_nothing=False):
    """rows(r0, r1) -> float rows; written strip by strip. Returns a sample of valid values (for suggest)."""
    samp = []
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        for r0 in range(0, nrows, STRIP):
            a = rows(r0, min(nrows, r0 + STRIP))
            f.write(_scale(a, lo, hi, zero_is_nothing).tobytes())
            v = a[np.isfinite(a)]
            if zero_is_nothing:
                v = v[v != 0]
            if v.size:
                samp.append(v[:: max(1, v.size // 20000)])
    os.replace(tmp, path)
    return np.concatenate(samp) if samp else np.zeros(0, np.float32)


def _pct(s, p, d):
    return float(np.percentile(s, p)) if s.size else d


def _write_json(out_dir, grid, maps):
    p = os.path.join(out_dir, "maps.json")
    with open(p + ".tmp", "w") as f:
        json.dump({"version": 1, "grid": grid, "maps": maps}, f, indent=1)
    os.replace(p + ".tmp", p)


def bush_maps(veg, depth, grid_src, out_dir):
    """veg (share 0..1) and depth (m, negative below ground), both north-up (row 0 north), -> brush.u8, voids.u8, maps.json."""
    os.makedirs(out_dir, exist_ok=True)
    ny, nx = veg.shape
    g = _grid_meta(dict(grid_src, nx=nx, ny=ny), "north")
    s = _write_strips(os.path.join(out_dir, "brush.u8"), lambda a, b: veg[a:b], ny, 0.0, 1.0)
    hi = max(0.05, round(_pct(s, 98, 0.5), 2))
    maps = [{"id": "brush", "file": "brush.u8", "units": "share of returns 0.3-1.5 m", "min": 0.0, "max": 1.0,
             "suggest": [0.0, hi]}]
    s = _write_strips(os.path.join(out_dir, "voids.u8"), lambda a, b: -np.asarray(depth[a:b], np.float32), ny, 0.0, 20.0,
                      zero_is_nothing=True)
    maps.append({"id": "voids", "file": "voids.u8", "units": "m below ground", "min": 0.0, "max": 20.0,
                 "suggest": [1.0, max(2.0, round(_pct(s, 98, 10.0), 1))]})
    _write_json(out_dir, g, maps)
    return maps


def slope_shade(z, cell, az_deg=315.0, alt_deg=45.0):
    """Slope (deg) and shade (0..1) of a south-up height strip (row r+1 is north of row r). NaN stays NaN."""
    z = np.asarray(z, dtype=np.float32)
    dzdy, dzdx = np.gradient(z, cell)          # axis 0 = north (south-up), axis 1 = east
    k = np.sqrt(dzdx * dzdx + dzdy * dzdy)
    slope = np.degrees(np.arctan(k)).astype(np.float32)
    az, alt = math.radians(az_deg), math.radians(alt_deg)
    lx, ly, lz = math.cos(alt) * math.sin(az), math.cos(alt) * math.cos(az), math.sin(alt)
    shade = ((-dzdx * lx - dzdy * ly + lz) / np.sqrt(k * k + 1)).astype(np.float32)
    return slope, np.clip(shade, 0.0, 1.0)


def ground_maps(ground, grid_src, out_dir):
    """ground: south-up float32 (as ground/ground.npy, may be a memmap) -> slope.u8, hillshade.u8, maps.json."""
    os.makedirs(out_dir, exist_ok=True)
    ny, nx = ground.shape
    cell = float(grid_src["cell"])
    g = _grid_meta(dict(grid_src, nx=nx, ny=ny), "south")
    cache = {}

    def strip(a, b):
        if (a, b) not in cache:
            cache.clear()
            lo, hi = max(0, a - 1), min(ny, b + 1)          # one row of overlap each side: the gradient is right at the seams
            sl, sh = slope_shade(np.asarray(ground[lo:hi], np.float32), cell)
            cache[(a, b)] = (sl[a - lo: a - lo + (b - a)], sh[a - lo: a - lo + (b - a)])
        return cache[(a, b)]

    _write_strips(os.path.join(out_dir, "slope.u8"), lambda a, b: strip(a, b)[0], ny, 0.0, 90.0)
    _write_strips(os.path.join(out_dir, "hillshade.u8"), lambda a, b: strip(a, b)[1], ny, 0.0, 1.0)
    maps = [{"id": "slope", "file": "slope.u8", "units": "degrees", "min": 0.0, "max": 90.0, "suggest": [0.0, 60.0]},
            {"id": "hillshade", "file": "hillshade.u8", "units": "shade (0 dark, 1 lit)", "min": 0.0, "max": 1.0,
             "suggest": [0.0, 1.0]}]
    _write_json(out_dir, g, maps)
    return maps


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
    """Make the value rasters of an existing area from its saved files. Returns what was written."""
    done = []
    gd = os.path.join(area_dir, "ground")
    gj = os.path.join(gd, "grid.json")
    meta = json.load(open(gj)) if os.path.exists(gj) else None
    if meta and os.path.exists(os.path.join(gd, "ground.npy")):
        say("[1/2] slope and hillshade from ground/ground.npy")
        ground = np.load(os.path.join(gd, "ground.npy"), mmap_mode="r")
        ground_maps(ground, meta, ground_out or gd)
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
        bush_maps(veg, depth, src, bush_out or bd)
        done.append("bush")
    return done


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="Value rasters (brush, voids, slope, hillshade) of an existing processed area")
    ap.add_argument("area_dir")
    ap.add_argument("--bush-out", default=None, help="write brush/voids here instead of AREA_DIR/bush")
    ap.add_argument("--ground-out", default=None, help="write slope/hillshade here instead of AREA_DIR/ground")
    a = ap.parse_args(argv)
    done = convert(a.area_dir, a.bush_out, a.ground_out)
    print("Wrote: " + (", ".join(done) or "nothing (no ground.npy or vegetation.tif found)"))
    return 0 if done else 1


if __name__ == "__main__":
    sys.exit(main())
