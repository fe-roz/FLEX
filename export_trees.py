#!/usr/bin/env python3
"""
The export's side of "Trees and brush" (export_terrain.py --trees).

veg_shapes.py reads the returns of the export area (straight from the EPT, as
it does for Analyze -> Vegetation shapes) and writes a folder with veg.json
and shapes.bin (version 2: 12 float32 a record: x y zg height radius base
kind density r1 r2 r3 r4; x east / y north in metres on the tangent plane at
veg.json's origin, zg the ground under it). This file runs it as a child with
its progress relayed and turns the records into what an export carries:

  trees.bin   "FTR1", uint32 n, then 20 bytes a tree: float32 x, y, z (the
              foot, in the VIEWER's frame: metres from the terrain's centre,
              the point clouds' vertical shift added), float32 height, uint16
              radius in cm, uint8 kind (0 cone, 1 round crown, 2 low mound),
              uint8 tint (0..255)
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
MAGIC = b'FTR1'
RECORD = 20                         # bytes a tree in trees.bin
CONE, ROUND, MOUND = 0, 1, 2        # trees.bin kinds
VEG_DOME, VEG_CONE, VEG_BRUSH = 0, 1, 2      # shapes.bin kinds (veg_shapes.py)
# A crown this low is drawn as a mound, like brush: the low layer under tall
# trees and shrubs the crown finder took for trees.
LOW_TREE_M = 3.0
# Sides of the solids by how many there are (the viewer has three levels):
# 0 full, 1 fewer sides, 2 fewest.
DETAIL_1_FROM, DETAIL_2_FROM = 120_000, 300_000
DTYPE = np.dtype([('x', '<f4'), ('y', '<f4'), ('z', '<f4'), ('h', '<f4'), ('r', '<u2'), ('kind', 'u1'), ('tint', 'u1')])
assert DTYPE.itemsize == RECORD


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


def bbox_ring(bbox):
    """[minLon, minLat, maxLon, maxLat] -> a closed lon/lat ring."""
    w, s, e, n = [float(v) for v in bbox]
    return [[w, s], [e, s], [e, n], [w, n], [w, s]]


def kinds_of(recs):
    """trees.bin kind per shapes.bin record [n, 12]: brush mounds and low
    crowns -> mound; a crown widest in its lower half -> cone; else round."""
    recs = np.asarray(recs, np.float32).reshape(-1, 12)
    vk, h = recs[:, 6], recs[:, 3]
    prof = recs[:, 8:12]                                   # r1..r4 at 10 / 35 / 60 / 85 % of the crown
    low_wide = prof[:, :2].max(axis=1) >= prof[:, 2:].max(axis=1)
    kind = np.where(low_wide, CONE, ROUND).astype(np.uint8)
    kind[(vk == VEG_BRUSH) | (h <= LOW_TREE_M)] = MOUND
    return kind


def tints_of(x, y):
    """0..255 a tree, the same for the same place (no random state): a little
    variation in the greens."""
    k = (np.floor(np.asarray(x, np.float64) * 7.3).astype(np.int64) * 73856093) ^ \
        (np.floor(np.asarray(y, np.float64) * 7.3).astype(np.int64) * 19349663)
    return ((k ^ (k >> 13)) & 255).astype(np.uint8)


def detail_for(count):
    return 2 if count >= DETAIL_2_FROM else (1 if count >= DETAIL_1_FROM else 0)


def pack(x, y, z, h, radius, kind, tint):
    n = len(x)
    a = np.zeros(n, DTYPE)
    a['x'], a['y'], a['z'], a['h'] = x, y, z, h
    a['r'] = np.clip(np.round(np.asarray(radius, np.float64) * 100.0), 1, 65535).astype(np.uint16)
    a['kind'], a['tint'] = kind, tint
    return MAGIC + struct.pack('<I', n) + a.tobytes()


def unpack(buf):
    if buf[:4] != MAGIC:
        raise ValueError("not a trees.bin (FTR1) file")
    n = struct.unpack_from('<I', buf, 4)[0]
    if len(buf) < 8 + n * RECORD:
        raise ValueError("trees.bin is cut short")
    return np.frombuffer(buf, DTYPE, n, 8)


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
    """A veg_shapes.py output folder, read."""

    def __init__(self, folder):
        d = self.dir = Path(folder)
        if not (d / 'veg.json').exists() or not (d / 'shapes.bin').exists():
            raise RuntimeError("no veg.json / shapes.bin in the trees folder")
        self.meta = m = json.loads((d / 'veg.json').read_text())
        raw = np.fromfile(d / 'shapes.bin', '<f4')
        rec = int((m.get('shapes') or {}).get('record') or 48) // 4
        if rec < 12 or len(raw) % rec:
            raise RuntimeError("shapes.bin is not version 2 (48-byte records)")
        self.recs = raw.reshape(-1, rec)[:, :12]
        st = m.get('stats') or {}
        self.zone, self.south = int(st.get('utm_zone') or 0), bool(st.get('south'))
        self.seconds = st.get('seconds')

    def utm(self):
        """The records' feet in UTM (the veg frame is a tangent plane at its
        origin: metres east / north; veg_shapes.Frame has the exact map back)."""
        import veg_shapes as vs
        import route_cost as rc
        o = self.meta['origin']
        zone = self.zone or rc.et().utm_zone_for(o['lon'])
        e0, n0 = rc.lonlat_to_xy(float(o['lon']), float(o['lat']), zone)
        f = vs.Frame(zone, self.south, e0, n0, float(o.get('h', 0.0)))
        x, y = self.recs[:, 0].astype(np.float64), self.recs[:, 1].astype(np.float64)
        if not len(x):
            return x, y
        pad = 10.0
        # the frame's own inverse is fitted on a UTM box: the records' reach round the origin
        f.fit_inverse((e0 + x.min() - pad, n0 + y.min() - pad, e0 + x.max() + pad, n0 + y.max() + pad))
        return f.to_utm(x, y)

    def binary(self, center_e, center_n, z_offset, dem=None, x_bins=None, y_bins=None, polygon=None, utm=None):
        """trees.bin in the viewer's frame. The foot stands on the export's
        own ground (`dem`, heights already shifted by z_offset) where it has
        one, else on the vegetation step's ground + z_offset. `polygon`: a UTM
        ring; trees whose foot is outside it are left out. Returns (bytes,
        counts {cone, round, mound, outside})."""
        e, n = utm if utm is not None else self.utm()
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
        buf = pack(e - center_e, n - center_n, z, r[:, 3], r[:, 4], kind, tints_of(e, n))
        counts = {'cone': int((kind == CONE).sum()), 'round': int((kind == ROUND).sum()),
                  'mound': int((kind == MOUND).sum()), 'outside': outside}
        return buf, counts
