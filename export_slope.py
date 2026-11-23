#!/usr/bin/env python3
"""
The slope map of an export (export_terrain.py --slope-map): the slope-angle colours laid over the hillshade,
at the hillshade's own resolution (tex_slope.jpg and its tiles), one more map to choose on the phone.

The colours are the desktop slope layer's "CalTopo style" classes (client/src/modules/area-maps.js, ramp
`caltopo`): nothing under 27 degrees, then yellow, orange, red, purple, blue, and black above 60. They and the
strength are parameters (SLOPE_CLASSES, SLOPE_OPACITY), the way the brush classes are.

Where the slope comes from: the ground the export's terrain is built from, on its own cells: the
ridgewalking ground (area_maps.slope_shade, the same one the desktop's slope map uses) or the LiDAR DEM. An
export on map terrain has no slope map: that terrain is tens of metres a cell, too coarse to say where it is
steep. numpy + Pillow.
"""
import math
import re
import sys

import numpy as np

# (from this many degrees, (r, g, b)); under the first: nothing.
SLOPE_CLASSES = ((27.0, (0xff, 0xe6, 0x00)),      # yellow  27-30
                 (30.0, (0xff, 0x99, 0x00)),      # orange  30-35
                 (35.0, (0xff, 0x1a, 0x00)),      # red     35-45
                 (45.0, (0xa0, 0x20, 0xf0)),      # purple  45-50
                 (50.0, (0x1f, 0x4f, 0xff)),      # blue    50-60
                 (60.0, (0x00, 0x00, 0x00)))      # black   60 and steeper
SLOPE_OPACITY = 0.7


def slope_classes(colours=None):
    """SLOPE_CLASSES with other colours: six RRGGBB values, gentlest class first. None or '' = the usual ones."""
    if not colours:
        return SLOPE_CLASSES
    parts = [p.strip().lstrip('#') for p in str(colours).split(',')]
    if len(parts) != len(SLOPE_CLASSES) or not all(re.fullmatch(r'[0-9a-fA-F]{6}', p) for p in parts):
        sys.exit("ERROR: --slope-colours takes six RRGGBB values, for 27, 30, 35, 45, 50 and 60 degrees "
                 "(e.g. ffe600,ff9900,ff1a00,a020f0,1f4fff,000000)")
    return tuple((deg, tuple(int(p[k:k + 2], 16) for k in (0, 2, 4))) for (deg, _), p in zip(SLOPE_CLASSES, parts))


def legend(classes=SLOPE_CLASSES, opacity=SLOPE_OPACITY):
    """What the viewer's legend needs (caves.json meta `slope_map`): [[from degrees, 'rrggbb'], ...] and the strength."""
    return {'opacity': float(opacity), 'classes': [[float(d), '%02x%02x%02x' % tuple(c)] for d, c in classes]}


def dem_slope(dem, cell):
    """Slope in degrees of a DEM in build_dem's layout ([x, y], y northward), as rows north to south."""
    z = np.asarray(dem, dtype=np.float32).T[::-1]             # [row north->south, col west->east]
    dzdy, dzdx = np.gradient(z, float(cell))
    return np.degrees(np.arctan(np.hypot(dzdx, dzdy))).astype(np.float32)


def crop(slope, grid_rect, rect):
    """The part of a slope picture (rows north to south, covering grid_rect = e0, n0, e1, n1) over `rect`."""
    e0, n0, e1, n1 = grid_rect
    h, w = slope.shape
    c0 = int(round((rect[0] - e0) / (e1 - e0) * w)); c1 = int(round((rect[2] - e0) / (e1 - e0) * w))
    r0 = int(round((n1 - rect[3]) / (n1 - n0) * h)); r1 = int(round((n1 - rect[1]) / (n1 - n0) * h))
    c0, c1 = max(0, min(w - 1, c0)), max(1, min(w, c1)); r0, r1 = max(0, min(h - 1, r0)), max(1, min(h, r1))
    return slope[r0:max(r1, r0 + 1), c0:max(c1, c0 + 1)]


def bake(base_img, slope, opacity=SLOPE_OPACITY, classes=SLOPE_CLASSES):
    """The slope classes over a picture (the hillshade) at `opacity`: `slope` (degrees, rows north to south,
    any size, covering the same rectangle) is brought to the picture's size; where it is under the first class
    or not a number the picture shows as it is. Returns a PIL RGB image."""
    from PIL import Image
    w, h = base_img.size
    s = np.nan_to_num(np.asarray(slope, dtype=np.float32), nan=0.0)
    if s.shape != (h, w):
        # the classes are edges: smooth (bilinear) when the picture is finer than the slope, the steepest of each block when coarser
        if s.shape[0] > h or s.shape[1] > w:
            ky, kx = max(1, s.shape[0] // h), max(1, s.shape[1] // w)
            hh, ww = (s.shape[0] // ky) * ky, (s.shape[1] // kx) * kx
            s = s[:hh, :ww].reshape(hh // ky, ky, ww // kx, kx).max(axis=(1, 3))
        s = np.asarray(Image.fromarray(s, 'F').resize((w, h), Image.BILINEAR), dtype=np.float32)
    basef = np.asarray(base_img.convert('RGB')).astype(np.float32)
    out = basef.copy()
    a = np.float32(min(1.0, max(0.0, opacity)))
    for deg, col in sorted(classes):
        m = s >= deg
        out[m] = (1 - a) * basef[m] + a * np.array(col[:3], np.float32)
    return Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), 'RGB')
