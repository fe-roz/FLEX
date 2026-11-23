#!/usr/bin/env python3
"""
The export's side of "V2 - Ridgewalking" (export_terrain.py --ridgewalk).

ridgewalk.py reads the returns and writes a ridge folder (ridge.json, lid.npy,
holes.npy, points.bin, shapes.bin, brush.npy + brush.json; x east / y north in
metres from ridge.json's `origin`, z absolute). This file turns that folder
into what an export carries:

  * the terrain DEM (the lid) on the ridge grid, with the cells to cut out
    (true entrances) and what the mesh must keep at full detail;
  * the hillshade of the lid (area_maps.slope_shade, the multidirectional one);
  * the sidecars in the viewer's frame (metres from the terrain's centre, the
    point clouds' vertical shift added): ridge_points.bin, ridge_shapes.bin,
    ridge_patches.bin, ridge.json;
  * "hillshade with brush": the brush classes baked over a hillshade picture
    (tex_hsb.jpg and its tiles).

numpy + scipy + Pillow; no PDAL here (the child process has it).
"""
import io
import json
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np

SCRIPT_DIR = Path(__file__).parent
PATCH_LIFT = 0.08                 # guessed openings lie this far above the ground (m)
DEPTH_CAP = 20                    # the viewer's depth ramp ends here (m)
# Mesh detail for this mode, in real units (the normal export ranks cells by
# curvature relative to the scene's own, so on quiet ground it spends its
# triangles on noise). Slope from STEEP_FROM degrees counts, STEEP_FULL and
# steeper come first; so do sharp edges: bending (1/m, of the lid smoothed
# over EDGE_SIGMA cells) from EDGE_FROM, which 3 cm of roughness stays under.
# Everything quieter scores 0 and is left to the coarse background grid.
STEEP_FROM, STEEP_FULL = 12.0, 35.0
EDGE_SIGMA, EDGE_FROM, EDGE_FULL = 1.5, 0.15, 0.6
RIM_CELLS = 3                     # full detail this many cells round a true hole
FLAT_DIV = 10                     # background grid = 1/10 of the triangles (normal export: 1/4)
# "Hillshade with brush" (tex_hsb.jpg): the brush classes over the hillshade.
# The one place for the look; bake_brush takes both as parameters.
BRUSH_CLASSES = ((0.6, (0x1f, 0x5f, 0x1f)),             # dense
                 (0.3, (0x5f, 0xae, 0x4f)),             # medium
                 (0.1, (0xb7, 0xe4, 0xa0)))             # light; under 0.1 and blank: nothing
BRUSH_OPACITY = 0.7


def brush_classes(colours=None):
    """BRUSH_CLASSES with other colours: 'light,medium,dense' as three RRGGBB
    values (a leading # is fine). None or '' = the usual ones."""
    if not colours:
        return BRUSH_CLASSES
    import re
    parts = [p.strip().lstrip('#') for p in str(colours).split(',')]
    if len(parts) != 3 or not all(re.fullmatch(r'[0-9a-fA-F]{6}', p) for p in parts):
        sys.exit("ERROR: --brush-colours takes three RRGGBB values: light,medium,dense (e.g. b7e4a0,5fae4f,1f5f1f)")
    rgb = [tuple(int(p[k:k + 2], 16) for k in (0, 2, 4)) for p in parts]
    cuts = sorted(c for c, _ in BRUSH_CLASSES)                  # light, medium, dense
    return tuple((cut, col) for cut, col in zip(reversed(cuts), reversed(rgb)))


def run_ridgewalk(out_dir, ept, bbox, polygon=None, also=(), progress=print, python=None, script=None, shapes=True):
    """Run ridgewalk.py as a child (same interpreter) and relay its `[ridge] NN% text` lines."""
    import os
    script = Path(script or os.environ.get('FLEX_RIDGE_SCRIPT') or SCRIPT_DIR / 'ridgewalk.py')
    if not script.exists():
        sys.exit("ERROR: ridgewalk.py is not next to export_terrain.py")
    cmd = [python or sys.executable, str(script), '--ept', str(ept)]
    for e in also or ():
        cmd += ['--also-ept', str(e)]
    cmd += ['--bbox', *[repr(float(v)) for v in bbox]]
    if polygon:
        cmd += ['--polygon', str(polygon)]
    cmd += ['--out', str(out_dir)]
    if not shapes:
        cmd += ['--no-shapes']
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
        sys.exit(f"ERROR: ridgewalk.py stopped with code {code}: " + ' | '.join(tail[-3:]))


def relay_line(line):
    """`[ridge] 42% reading tile 3` -> `Ridgewalking 42% reading tile 3` (ASCII only)."""
    s = line.strip()
    if s.startswith('[ridge]'):
        s = s[len('[ridge]'):].strip()
    return ('Ridgewalking ' + s).encode('ascii', 'replace').decode('ascii')


class Ridge:
    """A ridge folder, read."""
    def __init__(self, folder):
        d = self.dir = Path(folder)
        if not (d / 'ridge.json').exists():
            sys.exit(f"ERROR: no ridge.json in the ridge folder")
        self.meta = m = json.loads((d / 'ridge.json').read_text())
        self.cell = float(m['cell'])
        self.nx, self.ny = int(m['nx']), int(m['ny'])
        self.ox, self.oy = float(m['origin'][0]), float(m['origin'][1])
        self.zone = int(m['zone']) if m.get('zone') else int(str(m['epsg'])[-2:])
        self.south = bool(m['south']) if 'south' in m else str(m.get('epsg', '')).startswith('327')
        self.lid = np.load(d / 'lid.npy').astype(np.float32)           # [ny, nx], row 0 = south
        self.holes = np.load(d / 'holes.npy').astype(np.uint8)
        if self.lid.shape != (self.ny, self.nx) or self.holes.shape != (self.ny, self.nx):
            sys.exit("ERROR: the ridge folder's lid.npy / holes.npy do not match ridge.json's grid")
        self.blank = ~np.isfinite(self.lid)
        if self.blank.all():
            sys.exit("ERROR: the ridge ground is empty")
        self.filled = fill_nearest(self.lid, self.blank)

    @property
    def rect(self):
        return (self.ox, self.oy, self.ox + self.nx * self.cell, self.oy + self.ny * self.cell)

    def terrain(self, clipped=False):
        """The DEM in build_dem's layout ([x, y], y northward) with its bins,
        the cells to cut out and build_mesh's options for this mode.
        `clipped`: a polygon cuts the mesh, so blank cells along its line are
        left to that cut (the mesh ends exactly at the line, not at cells)."""
        from scipy.ndimage import binary_dilation, binary_erosion, gaussian_filter, laplace
        x_bins = self.ox + np.arange(self.nx + 1) * self.cell
        y_bins = self.oy + np.arange(self.ny + 1) * self.cell
        true = self.holes == 1
        blank = binary_erosion(self.blank, iterations=3) if clipped else self.blank
        drop = (true | blank).T
        slope = self.slope()
        score = np.clip((slope - STEEP_FROM) / (STEEP_FULL - STEEP_FROM), 0.0, None)   # > 1 past STEEP_FULL: steepest first
        bend = np.abs(laplace(gaussian_filter(self.filled, EDGE_SIGMA))) / (self.cell * self.cell)
        score = np.maximum(score, np.clip((bend - EDGE_FROM) / (EDGE_FULL - EDGE_FROM), 0.0, 1.0)).astype(np.float32)
        del bend
        force = binary_dilation(true, iterations=RIM_CELLS) | binary_dilation(self.holes == 2)
        force &= ~true
        return (self.filled.T.copy(), x_bins, y_bins, drop,
                dict(score=score.T, force=force.T, flat_div=FLAT_DIV))

    def _slope_shade(self):
        if getattr(self, '_ss', None) is None:
            from area_maps import slope_shade          # the multidirectional shade: one implementation
            self._ss = slope_shade(self.filled, self.cell)
        return self._ss

    def slope(self):
        """Slope of the lid, degrees, [ny, nx] south-up."""
        return self._slope_shade()[0]

    def hillshade(self, max_px=16384, tone=None):
        """The multidirectional hillshade of the lid as a PIL 'L' image, north
        up, on exactly the grid's rectangle. `tone` stretches 0..1 shade
        (export_terrain._tone_map, as the normal export's hillshade)."""
        from PIL import Image
        shade = self._slope_shade()[1][::-1]
        if tone is not None:
            shade = tone(shade)
        img = Image.fromarray(np.clip(shade * 255.0 + 0.5, 0, 255).astype(np.uint8))
        cell = self.cell
        if max(img.size) > max_px:
            k = max_px / max(img.size)
            img = img.resize((max(1, int(img.size[0] * k)), max(1, int(img.size[1] * k))), Image.LANCZOS)
            cell = self.cell / k
        return img, cell

    # ── Sidecars, in the viewer's frame ──────────────────────────────────────
    def shift(self, center_e, center_n, z_offset):
        return np.array([self.ox - center_e, self.oy - center_n, z_offset], dtype=np.float64)

    def points_bin(self, shift):
        p = self.dir / 'points.bin'
        if not p.exists():
            return pack_points(np.zeros((0, 3), np.float32), np.zeros(0, np.float32), np.zeros(0, np.uint8))
        xyz, depth, kind = read_points(p.read_bytes())
        return pack_points(xyz + shift, depth, kind)

    def shapes_bin(self, shift):
        p = self.dir / 'shapes.bin'
        if not p.exists():
            return None
        xyz, depth, tri = read_shapes(p.read_bytes())
        return pack_shapes(xyz + shift, depth, tri)

    def patches_bin(self, shift):
        """Triangle soup over the guessed cells (holes == 2): two triangles a
        cell, corners at the lid's corner heights + PATCH_LIFT."""
        jj, ii = np.nonzero(self.holes == 2)
        if not len(jj):
            return pack_patches(np.zeros((0, 3), np.float32))
        pad = np.pad(self.filled.astype(np.float64), 1, mode='edge')
        corner = (pad[:-1, :-1] + pad[1:, :-1] + pad[:-1, 1:] + pad[1:, 1:]) / 4.0      # [ny+1, nx+1]
        c = self.cell
        def P(dj, di):
            return np.column_stack([(ii + di) * c, (jj + dj) * c, corner[jj + dj, ii + di] + PATCH_LIFT])
        sw, se, ne, nw = P(0, 0), P(0, 1), P(1, 1), P(1, 0)
        tris = np.stack([sw, se, ne, sw, ne, nw], axis=1).reshape(-1, 3)                 # counter-clockwise from above
        return pack_patches(tris + shift)

    def has_brush(self):
        return (self.dir / 'brush.npy').exists() and (self.dir / 'brush.json').exists()

    def brush_values(self, grid_rect, w, h):
        """brush.npy (share 0..1, NaN = blank; row 0 = south, as ridgewalk.py
        writes it) sampled on a w x h picture of the UTM rectangle `grid_rect`
        (row 0 = north), nearest block. None: no brush."""
        if not self.has_brush():
            return None
        if getattr(self, '_brush', None) is None:
            m = json.loads((self.dir / 'brush.json').read_text())
            x0, y0 = float(m.get('x0', 0.0)), float(m.get('y0', 0.0))
            if abs(x0) < 1e5:                          # metres from the ridge origin (the contract); else UTM
                x0 += self.ox; y0 += self.oy
            self._brush = (np.load(self.dir / 'brush.npy').astype(np.float32), float(m['cell']), x0, y0)
        b, bc, x0, y0 = self._brush
        e0, n0, e1, n1 = grid_rect
        E = e0 + (np.arange(w) + 0.5) * (e1 - e0) / w
        N = n1 - (np.arange(h) + 0.5) * (n1 - n0) / h
        bi = np.floor((E - x0) / bc).astype(np.int64); bj = np.floor((N - y0) / bc).astype(np.int64)
        ok = ((bj >= 0) & (bj < b.shape[0]))[:, None] & ((bi >= 0) & (bi < b.shape[1]))[None, :]
        return np.where(ok, b[np.clip(bj, 0, b.shape[0] - 1)][:, np.clip(bi, 0, b.shape[1] - 1)], np.nan)

    def bake_brush(self, hs_img, grid_rect, opacity=BRUSH_OPACITY, classes=BRUSH_CLASSES):
        """"Hillshade with brush": the brush classes laid over a hillshade
        picture of `grid_rect` at `opacity`, at the picture's own size.
        `classes`: ((cut-off, (r, g, b)), ...), densest first; under the
        lowest cut-off and blank cells the hillshade shows as it is.
        Returns a PIL RGB image, or None when there is no brush."""
        from PIL import Image
        w, h = hs_img.size
        v = self.brush_values(grid_rect, w, h)
        if v is None:
            return None
        v = np.nan_to_num(v, nan=-1.0)
        base = np.asarray(hs_img.convert('RGB')).astype(np.float32)
        out = base.copy()
        a = np.float32(min(1.0, max(0.0, opacity)))
        for cut, col in sorted(classes):               # lightest first, denser classes over them
            m = v >= cut
            out[m] = (1 - a) * base[m] + a * np.array(col[:3], np.float32)
        return Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), 'RGB')

    def side_json(self, center_e, center_n, z_offset, files):
        """ridge.json for the zip: the step's own, plus the frame and the
        RIDGE object with file names (what a slim shell / the app puts in
        place of PLACEHOLDER_RIDGE_JSON)."""
        out = dict(self.meta)
        out['frame'] = 'viewer'
        out['viewer_frame'] = {'origin': [round(self.ox - center_e, 3), round(self.oy - center_n, 3)],
                               'z_offset': float(z_offset), 'patch_lift': PATCH_LIFT}
        out['viewer'] = ridge_object(self.meta, files)
        return out


def ridge_object(meta, files, data=None):
    """The viewer's RIDGE: file names, or inline base64 when `data` {name: bytes} is given."""
    import base64
    def ref(name):
        if name not in files:
            return None
        return base64.b64encode(data[name]).decode('ascii') if data is not None else name
    return {'version': 1, 'counts': meta.get('counts') or {},
            'points': ref('ridge_points.bin'), 'patches': ref('ridge_patches.bin'),
            'shapes': ref('ridge_shapes.bin'), 'depthCap': DEPTH_CAP}


def fill_nearest(a, blank):
    if not blank.any():
        return a.copy()
    from scipy.ndimage import distance_transform_edt
    idx = distance_transform_edt(blank, return_distances=False, return_indices=True)
    return a[tuple(idx)]


# ── File formats (little-endian; the contract) ───────────────────────────────
def read_points(buf):
    if buf[:4] != b'RWP1':
        sys.exit("ERROR: points.bin is not an RWP1 file")
    n = struct.unpack_from('<I', buf, 4)[0]
    xyz = np.frombuffer(buf, '<f4', n * 3, 8).reshape(n, 3).astype(np.float64)
    depth = np.frombuffer(buf, '<f4', n, 8 + 12 * n)
    kind = np.frombuffer(buf, 'u1', n, 8 + 16 * n)
    return xyz, depth, kind


def pack_points(xyz, depth, kind):
    return (b'RWP1' + struct.pack('<I', len(xyz)) + np.asarray(xyz, '<f4').tobytes()
            + np.asarray(depth, '<f4').tobytes() + np.asarray(kind, 'u1').tobytes())


def read_shapes(buf):
    if buf[:4] != b'RWS1':
        sys.exit("ERROR: shapes.bin is not an RWS1 file")
    nv, nt = struct.unpack_from('<II', buf, 4)
    xyz = np.frombuffer(buf, '<f4', nv * 3, 12).reshape(nv, 3).astype(np.float64)
    depth = np.frombuffer(buf, '<f4', nv, 12 + 12 * nv)
    tri = np.frombuffer(buf, '<u4', nt * 3, 12 + 16 * nv)
    return xyz, depth, tri


def pack_shapes(xyz, depth, tri):
    return (b'RWS1' + struct.pack('<II', len(xyz), len(tri) // 3) + np.asarray(xyz, '<f4').tobytes()
            + np.asarray(depth, '<f4').tobytes() + np.asarray(tri, '<u4').tobytes())


def pack_patches(xyz):
    return b'RWT1' + struct.pack('<I', len(xyz)) + np.asarray(xyz, '<f4').tobytes()


def read_patches(buf):
    n = struct.unpack_from('<I', buf, 4)[0]
    return np.frombuffer(buf, '<f4', n * 3, 8).reshape(n, 3)
