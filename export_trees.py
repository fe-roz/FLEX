#!/usr/bin/env python3
"""
The export's side of "Trees and brush" (export_terrain.py --trees).

veg_shapes.py reads the returns of the export area (straight from the EPT, as
it does for Analyze -> Vegetation shapes) and writes a folder with veg.json
and shapes.bin (version 2: 12 float32 a record: x y zg height radius base
kind density r1 r2 r3 r4; x east / y north in metres on the tangent plane at
veg.json's origin, zg the ground under it). This file runs it as a child with
its progress relayed and turns the records into what an export carries:

  trees.bin   "FTR2", uint32 n, then 24 bytes a tree: float32 x, y, z (the
              foot, in the VIEWER's frame: metres from the terrain's centre,
              the point clouds' vertical shift added), float32 height, uint16
              radius in cm, uint8 kind (0 cone, 1 round crown, 2 low mound),
              uint8 tint (0..255), uint16 the crown's base above the foot in
              cm, uint16 spare. (Version 1, "FTR1", 20 bytes, had no base.)
  TREES       { version: 1, count, file, detail } for PLACEHOLDER_TREES_JSON
              (`file`: the name, or inline base64 in the single-file viewer)

The phone draws each record as one of three stock solids stretched to its
height and radius (viewer_build/libs/trees.js). numpy only here; PDAL is the
child's.
"""
import base64
import json
import os
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np

SCRIPT_DIR = Path(__file__).parent
MAGIC = b'FTR2'                     # version 2: + the crown's base (version 1, "FTR1", 20 bytes, had none; unpack reads both)
RECORD = 24                         # bytes a tree in trees.bin
CONE, ROUND, MOUND = 0, 1, 2        # trees.bin kinds
VEG_DOME, VEG_CONE, VEG_BRUSH, VEG_TALL_BRUSH = 0, 1, 2, 3      # shapes.bin kinds (veg_shapes.py)
# A crown this low is drawn as a mound, like brush: the low layer under tall
# trees and shrubs the crown finder took for trees. Taller brush is told from
# trees by its shape, where the returns are: veg_shapes.py marks it (kind 3,
# tall_brush) and it is a mound here too, as tall and as wide as measured. A
# shapes.bin made before that kind has none, and only this height decides.
LOW_TREE_M = 3.0
# Sides of the solids by how many there are (the viewer has three levels):
# 0 full, 1 fewer sides, 2 fewest.
DETAIL_1_FROM, DETAIL_2_FROM = 120_000, 300_000
# The vegetation step holds a tile's whole cloud in memory (about 4 GB a km2 of dense cloud): the export runs it
# in tiles of at most TILE_M a side, each read MARGIN_M wider so crowns on a tile line are whole.
TILE_M, MARGIN_M = 700.0, 15.0
TILE_TRIES = 3                      # a tile whose step fails is run again, up to this many times in all
DTYPE = np.dtype([('x', '<f4'), ('y', '<f4'), ('z', '<f4'), ('h', '<f4'), ('r', '<u2'), ('kind', 'u1'), ('tint', 'u1'),
                  ('base', '<u2'), ('spare', '<u2')])
DTYPE_V1 = np.dtype([('x', '<f4'), ('y', '<f4'), ('z', '<f4'), ('h', '<f4'), ('r', '<u2'), ('kind', 'u1'), ('tint', 'u1')])
assert DTYPE.itemsize == RECORD and DTYPE_V1.itemsize == 20
# A cliff read as a crown. No height limit of any kind (there are 100 m trees): a tree is left out only when the
# ground itself explains it: within its crown's radius + CLIFF_REACH_M the export's ground rises CLIFF_RISE_M or
# more above its foot (a cliff, not a slope: 8 m within a crown) AND the tree's top does not stand clear of that
# ground by more than the larger of CLIFF_CLEAR_M and CLIFF_CLEAR_SHARE of its height.
CLIFF_REACH_M, CLIFF_RISE_M, CLIFF_CLEAR_M, CLIFF_CLEAR_SHARE = 2.0, 8.0, 2.0, 0.15


def relay_line(line):
    """A line of veg_shapes.py's progress -> `Trees ...` (ASCII only)."""
    return ('Trees ' + line.strip()).encode('ascii', 'replace').decode('ascii')


def run_veg(out_dir, ept, ring_ll, also=(), progress=print, python=None, script=None, detail='medium'):
    """Run veg_shapes.py as a child (same interpreter) for the lon/lat ring,
    shapes only (no canopy shell), and relay its progress lines."""
    script = Path(script or os.environ.get('FLEX_TREES_SCRIPT') or SCRIPT_DIR / 'veg_shapes.py')
    if not script.exists():
        sys.exit("ERROR: veg_shapes.py is not next to export_terrain.py")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    source = {'ept': str(ept)}
    if also:
        source['ept_also'] = [str(e) for e in also if e]
    params = {'source': source, 'area': [[float(p[0]), float(p[1])] for p in ring_ll],
              'looks': ['shapes'], 'detail': detail}
    pfile = out_dir / 'params.json'
    pfile.write_text(json.dumps(params))
    cmd = [python or sys.executable, str(script), '--params', str(pfile), '--out', str(out_dir)]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            encoding='utf-8', errors='replace', bufsize=1)
    tail = []
    for line in proc.stdout:
        line = line.rstrip()
        if not line:
            continue
        tail.append(line); del tail[:-12]
        progress(relay_line(line))
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f"veg_shapes.py stopped with code {code}: " + ' | '.join(tail[-3:]))


def tile_grid(rect, tile_m=None, polygon=None):
    """Split a UTM rectangle into equal tiles no wider than tile_m; with a
    polygon (UTM ring), only the tiles it reaches. -> [(i, j, (x0, y0, x1, y1))]"""
    tile_m = tile_m or TILE_M
    x0, y0, x1, y1 = [float(v) for v in rect]
    nx = max(1, int(np.ceil((x1 - x0) / tile_m - 1e-9))); ny = max(1, int(np.ceil((y1 - y0) / tile_m - 1e-9)))
    out = []
    for j in range(ny):
        for i in range(nx):
            core = (x0 + (x1 - x0) * i / nx, y0 + (y1 - y0) * j / ny, x0 + (x1 - x0) * (i + 1) / nx, y0 + (y1 - y0) * (j + 1) / ny)
            if polygon is None or rect_meets_ring(core, polygon):
                out.append((i, j, core))
    return out


def rect_meets_ring(r, ring):
    """Does the rectangle (x0, y0, x1, y1) share ground with the ring? (a grid
    of points of the rectangle inside the ring, or a ring corner inside it)"""
    ring = np.asarray(ring, np.float64)
    if ((ring[:, 0] >= r[0]) & (ring[:, 0] <= r[2]) & (ring[:, 1] >= r[1]) & (ring[:, 1] <= r[3])).any():
        return True
    gx, gy = np.meshgrid(np.linspace(r[0], r[2], 9), np.linspace(r[1], r[3], 9))
    return bool(point_in_ring(gx.ravel(), gy.ravel(), ring).any())


def run_veg_tiled(out_dir, ept, rect, zone, south, polygon=None, also=(), progress=print, python=None, script=None,
                  tile_m=None, margin=None, detail='medium'):
    """The vegetation step over a UTM rectangle, tile by tile (one child after
    the other), so its memory follows the tile, not the area: about 4 GB a
    km2 of dense cloud otherwise. Each tile is read with `margin` metres more
    all round, so crowns on a tile line are whole; a tree is kept by the tile
    its foot stands in (Trees). Writes out_dir/tiles.json."""
    import route_cost as rc
    margin = MARGIN_M if margin is None else float(margin)
    out_dir = Path(out_dir); out_dir.mkdir(parents=True, exist_ok=True)
    tiles = tile_grid(rect, tile_m, polygon)
    index = {'version': 1, 'zone': int(zone), 'south': bool(south), 'rect': [float(v) for v in rect], 'margin': margin, 'tiles': []}
    for k, (i, j, core) in enumerate(tiles):
        name = f't_{i}_{j}'
        e = np.array([core[0] - margin, core[2] + margin, core[2] + margin, core[0] - margin])
        n = np.array([core[1] - margin, core[1] - margin, core[3] + margin, core[3] + margin])
        lon, lat = rc.xy_to_lonlat(e, n, int(zone), bool(south))
        ring = [[float(a), float(b)] for a, b in zip(lon, lat)]
        ring.append(ring[0])
        pct = lambda m, k=k: progress(f"Trees {int(100 * k / len(tiles))}% tile {k + 1}/{len(tiles)}: {m[len('Trees '):]}")
        for attempt in range(TILE_TRIES):                        # a read over the network can fail once: the tile is tried again
            try:
                run_veg(out_dir / name, ept, ring, also=also, progress=pct, python=python, script=script, detail=detail)
                break
            except RuntimeError as e:
                if attempt + 1 == TILE_TRIES:
                    raise
                pct(f"Trees tile {k + 1} failed, trying it again ({str(e)[:120]})")
        index['tiles'].append({'dir': name, 'core': [float(v) for v in core]})
        (out_dir / 'tiles.json').write_text(json.dumps(index))
    return index


def bbox_ring(bbox):
    """[minLon, minLat, maxLon, maxLat] -> a closed lon/lat ring."""
    w, s, e, n = [float(v) for v in bbox]
    return [[w, s], [e, s], [e, n], [w, n], [w, s]]


def kinds_of(recs):
    """trees.bin kind per shapes.bin record [n, 12]: brush mounds, tall brush
    and low crowns -> mound; a tapering crown -> cone; else round."""
    recs = np.asarray(recs, np.float32).reshape(-1, 12)
    vk, h = recs[:, 6], recs[:, 3]
    prof = recs[:, 8:12]                                   # r1..r4 at 10 / 35 / 60 / 85 % of the crown
    # A cone is what the vegetation step itself calls one (a narrow top on a crown at least twice as long as
    # wide). Measured outlines are nearly all widest at the bottom, cones and domes alike, so "widest in its
    # lower half" alone would make nine trees in ten a cone; a crown that swells above its start never is one.
    swells = prof[:, 2:].max(axis=1) > prof[:, :2].max(axis=1)
    kind = np.where((vk == VEG_CONE) & ~swells, CONE, ROUND).astype(np.uint8)
    kind[(vk == VEG_BRUSH) | (vk == VEG_TALL_BRUSH) | (h <= LOW_TREE_M)] = MOUND
    return kind


def tints_of(x, y):
    """0..255 a tree, the same for the same place (no random state): a little
    variation in the greens."""
    k = (np.floor(np.asarray(x, np.float64) * 7.3).astype(np.int64) * 73856093) ^ \
        (np.floor(np.asarray(y, np.float64) * 7.3).astype(np.int64) * 19349663)
    return ((k ^ (k >> 13)) & 255).astype(np.uint8)


def detail_for(count):
    return 2 if count >= DETAIL_2_FROM else (1 if count >= DETAIL_1_FROM else 0)


def pack(x, y, z, h, radius, kind, tint, base=None):
    """trees.bin, version 2. `base`: the crown's base above the foot, metres (None: 0)."""
    n = len(x)
    a = np.zeros(n, DTYPE)
    if base is not None:
        a['base'] = np.clip(np.round(np.nan_to_num(np.asarray(base, np.float64)) * 100.0), 0, 65535).astype(np.uint16)
    a['x'], a['y'], a['z'], a['h'] = x, y, z, h
    a['r'] = np.clip(np.round(np.asarray(radius, np.float64) * 100.0), 1, 65535).astype(np.uint16)
    a['kind'], a['tint'] = kind, tint
    return MAGIC + struct.pack('<I', n) + a.tobytes()


def unpack(buf):
    """The records of a trees.bin, version 2 or 1 (version 1 comes back with base 0)."""
    if buf[:4] not in (MAGIC, b'FTR1'):
        raise ValueError("not a trees.bin (FTR1 / FTR2) file")
    v1 = buf[:4] == b'FTR1'
    n = struct.unpack_from('<I', buf, 4)[0]
    if len(buf) < 8 + n * (20 if v1 else RECORD):
        raise ValueError("trees.bin is cut short")
    if not v1:
        return np.frombuffer(buf, DTYPE, n, 8)
    old = np.frombuffer(buf, DTYPE_V1, n, 8)
    a = np.zeros(n, DTYPE)
    for k in DTYPE_V1.names:
        a[k] = old[k]
    return a


def ground_rise(dem, x_bins, y_bins, e, n, reach, foot_z):
    """For each foot: the highest ground of the export's DEM ([x, y], blank =
    NaN) within `reach` metres of it, minus the ground at the foot (`foot_z`).
    The DEM is first taken down to cells of about 1 m (the highest of each
    block). NaN where there is no ground in reach."""
    from numpy.lib.stride_tricks import sliding_window_view
    dem = np.asarray(dem, np.float32)
    cell = float(x_bins[1] - x_bins[0])
    k = max(1, int(round(1.0 / cell)))
    nx, ny = (dem.shape[0] // k) * k, (dem.shape[1] // k) * k
    if nx < k or ny < k or not len(e):
        return np.full(len(e), np.nan)
    hi = np.where(np.isfinite(dem[:nx, :ny]), dem[:nx, :ny], -np.inf).reshape(nx // k, k, ny // k, k).max(axis=(1, 3))
    c = cell * k
    ix = np.floor((np.asarray(e, np.float64) - x_bins[0]) / c).astype(np.int64)
    iy = np.floor((np.asarray(n, np.float64) - y_bins[0]) / c).astype(np.int64)
    inside = (ix >= 0) & (iy >= 0) & (ix < hi.shape[0]) & (iy < hi.shape[1])
    R = np.maximum(1, np.ceil(np.asarray(reach, np.float64) / c).astype(np.int64))
    top = np.full(len(ix), -np.inf)
    for r in np.unique(R[inside]):                              # trees of one reach together: a disc of 2r+1 cells
        sel = np.nonzero(inside & (R == r))[0]
        pad = np.pad(hi, r, constant_values=-np.inf)
        win = sliding_window_view(pad, (2 * r + 1, 2 * r + 1))
        yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
        disc = (xx * xx + yy * yy) <= r * r
        for a in range(0, len(sel), 20000):
            s = sel[a:a + 20000]
            top[s] = np.where(disc, win[ix[s], iy[s]], -np.inf).max(axis=(1, 2))
    return np.where(np.isfinite(top), top - np.asarray(foot_z, np.float64), np.nan)


def on_cliff(rise, height):
    """The rule (see CLIFF_*): the ground in the crown's reach rises like a
    cliff, and the tree's top does not stand clear of it."""
    rise = np.asarray(rise, np.float64); height = np.asarray(height, np.float64)
    clear = np.maximum(CLIFF_CLEAR_M, CLIFF_CLEAR_SHARE * height)
    return np.isfinite(rise) & (rise >= CLIFF_RISE_M) & (height <= rise + clear)


def trees_object(count, detail, data=None, name='trees.bin'):
    """The viewer's TREES: the file by name, or inline base64 when `data` is given."""
    return {'version': 1, 'count': int(count), 'detail': int(detail),
            'file': base64.b64encode(data).decode('ascii') if data is not None else name}


def sample_dem(dem, x_bins, y_bins, e, n):
    """Bilinear height of the export's DEM ([x, y], cell centres between the
    bins) at UTM e, n; NaN outside it or where a corner is blank."""
    dem = np.asarray(dem)
    cx = float(x_bins[1] - x_bins[0]); cy = float(y_bins[1] - y_bins[0])
    fx = (np.asarray(e, np.float64) - x_bins[0]) / cx - 0.5
    fy = (np.asarray(n, np.float64) - y_bins[0]) / cy - 0.5
    nx, ny = dem.shape
    ok = (fx >= -0.5) & (fy >= -0.5) & (fx <= nx - 0.5) & (fy <= ny - 0.5)
    fx = np.clip(fx, 0, nx - 1); fy = np.clip(fy, 0, ny - 1)
    i0 = np.minimum(np.floor(fx).astype(np.int64), max(nx - 2, 0)); j0 = np.minimum(np.floor(fy).astype(np.int64), max(ny - 2, 0))
    i1 = np.minimum(i0 + 1, nx - 1); j1 = np.minimum(j0 + 1, ny - 1)
    tx = fx - i0; ty = fy - j0
    z = (dem[i0, j0] * (1 - tx) * (1 - ty) + dem[i1, j0] * tx * (1 - ty)
         + dem[i0, j1] * (1 - tx) * ty + dem[i1, j1] * tx * ty)
    return np.where(ok, z, np.nan)


def point_in_ring(e, n, ring):
    """Even-odd test of points against a ring [[e, n], ...]."""
    e = np.asarray(e, np.float64); n = np.asarray(n, np.float64)
    ring = np.asarray(ring, np.float64)
    inside = np.zeros(len(e), bool)
    x0, y0 = ring[-1]
    for x1, y1 in ring:
        if y0 != y1:
            cross = ((y0 > n) != (y1 > n)) & (e < (x1 - x0) * (n - y0) / (y1 - y0) + x0)
            inside ^= cross
        x0, y0 = x1, y1
    return inside


class Trees:
    """The vegetation step's output, read: one veg_shapes.py folder (veg.json,
    shapes.bin), or a folder of tiles (tiles.json, written by run_veg_tiled).
    `recs` [n, 12] are shapes.bin's records, `e`, `n` their feet in UTM zone
    `zone`."""

    def __init__(self, folder, zone=None, south=None):
        d = self.dir = Path(folder)
        self.seconds = 0.0
        parts = []
        if (d / 'tiles.json').exists():
            idx = json.loads((d / 'tiles.json').read_text())
            zone = int(idx['zone']) if zone is None else zone
            south = bool(idx['south']) if south is None else south
            for t in idx['tiles']:
                recs, e, n, secs = self._one(d / t['dir'], zone, south)
                x0, y0, x1, y1 = t['core']                       # each tree belongs to the tile its foot is in
                k = (e >= x0) & (e < x1) & (n >= y0) & (n < y1)
                parts.append((recs[k], e[k], n[k]))
                self.seconds += secs
            self.tiles = len(idx['tiles'])
        else:
            recs, e, n, secs = self._one(d, zone, south)
            parts.append((recs, e, n))
            self.seconds, self.tiles = secs, 1
        self.zone, self.south = self._zone
        self.recs = np.concatenate([p[0] for p in parts]) if parts else np.zeros((0, 12), np.float32)
        self.e = np.concatenate([p[1] for p in parts]) if parts else np.zeros(0)
        self.n = np.concatenate([p[2] for p in parts]) if parts else np.zeros(0)

    def _one(self, d, zone, south):
        """(records, e, n, seconds) of one veg_shapes.py folder, in UTM `zone`
        (None: the folder's own). The veg frame is a tangent plane at its
        origin, metres east / north; veg_shapes.Frame has the exact map back."""
        import veg_shapes as vs
        import route_cost as rc
        if not (d / 'veg.json').exists() or not (d / 'shapes.bin').exists():
            raise RuntimeError("no veg.json / shapes.bin in the trees folder")
        m = json.loads((d / 'veg.json').read_text())
        raw = np.fromfile(d / 'shapes.bin', '<f4')
        rec = int((m.get('shapes') or {}).get('record') or 48) // 4
        if rec < 12 or len(raw) % rec:
            raise RuntimeError("shapes.bin is not version 2 (48-byte records)")
        recs = raw.reshape(-1, rec)[:, :12]
        st, o = m.get('stats') or {}, m['origin']
        vzone = int(st.get('utm_zone') or rc.et().utm_zone_for(o['lon']))
        vsouth = bool(st.get('south')) if 'south' in st else float(o['lat']) < 0
        if zone is None:
            zone, south = vzone, vsouth
        self._zone = (int(zone), bool(south))
        x, y = recs[:, 0].astype(np.float64), recs[:, 1].astype(np.float64)
        if not len(x):
            return recs, x, y, float(st.get('seconds') or 0)
        e0, n0 = rc.lonlat_to_xy(float(o['lon']), float(o['lat']), vzone)
        f = vs.Frame(vzone, vsouth, e0, n0, float(o.get('h', 0.0)))
        pad = 10.0
        f.fit_inverse((e0 + x.min() - pad, n0 + y.min() - pad, e0 + x.max() + pad, n0 + y.max() + pad))
        e, n = f.to_utm(x, y)
        if (vzone, vsouth) != (int(zone), bool(south)):          # the export's zone is another one (an area on a zone line)
            lon, lat = rc.xy_to_lonlat(e, n, vzone, vsouth)
            en = np.array([rc.lonlat_to_xy(a, b, int(zone)) for a, b in zip(lon, lat)], np.float64)
            e, n = en[:, 0], en[:, 1]
        return recs, e, n, float(st.get('seconds') or 0)

    def utm(self):
        return self.e, self.n

    def binary(self, center_e, center_n, z_offset, dem=None, x_bins=None, y_bins=None, polygon=None, utm=None):
        """trees.bin in the viewer's frame. The foot stands on the export's
        own ground (`dem`, heights already shifted by z_offset) where it has
        one, else on the vegetation step's ground + z_offset. `polygon`: a UTM
        ring; trees whose foot is outside it are left out. With the DEM,
        trees a cliff explains are left out too (on_cliff; never by height
        alone). Returns (bytes, counts {cone, round, mound, outside, cliff,
        cliff_by_height})."""
        e, n = utm if utm is not None else (self.e, self.n)
        r = self.recs
        keep = np.isfinite(e) & np.isfinite(n) & (r[:, 3] > 0) & (r[:, 4] > 0)
        outside = 0
        if polygon is not None and len(e):
            inside = point_in_ring(e, n, polygon)
            outside = int((keep & ~inside).sum())
            keep &= inside
        e, n, r = e[keep], n[keep], r[keep]
        z = r[:, 2].astype(np.float64) + float(z_offset)
        if dem is not None and len(e):
            zd = sample_dem(dem, x_bins, y_bins, e, n)
            z = np.where(np.isfinite(zd), zd, z)
        kind = kinds_of(r)
        cliff, by_h = 0, {}
        if dem is not None and len(e):
            tree = kind != MOUND
            rise = ground_rise(dem, x_bins, y_bins, e, n, r[:, 4].astype(np.float64) + CLIFF_REACH_M, z)
            drop = tree & on_cliff(rise, r[:, 3])
            cliff = int(drop.sum())
            for lo, hi_, name in ((0, 15, 'under 15 m'), (15, 30, '15-30 m'), (30, 45, '30-45 m'), (45, 1e9, 'over 45 m')):
                by_h[name] = int((drop & (r[:, 3] > lo) & (r[:, 3] <= hi_)).sum())
            if cliff:
                e, n, r, z, kind = e[~drop], n[~drop], r[~drop], z[~drop], kind[~drop]
        base = np.where(kind == MOUND, 0.0, np.clip(r[:, 5], 0.0, r[:, 3] * 0.9))     # the crown's base above the foot
        buf = pack(e - center_e, n - center_n, z, r[:, 3], r[:, 4], kind, tints_of(e, n), base=base)
        counts = {'cone': int((kind == CONE).sum()), 'round': int((kind == ROUND).sum()),
                  'mound': int((kind == MOUND).sum()), 'outside': outside, 'cliff': cliff, 'cliff_by_height': by_h}
        return buf, counts
