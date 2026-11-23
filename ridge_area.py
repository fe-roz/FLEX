#!/usr/bin/env python3
"""
ridge_area.py -- what the desktop map needs of a ridgewalking result (ridgewalk.py --out DIR), made once after the run.

    python ridge_area.py DIR

ridgewalk.py's lid.npy and holes.npy are grids of the whole area at 0.3 m (tens to hundreds of MB): too much to hand
to the browser. This writes two small files beside them, for client/src/modules/ridge-draw.js:

    draw.json    { version, zone, south, origin, size: [w, h], cell,
                   frame:  { n, lonlat: [[lon, lat], ...] }   the lon / lat of an n x n lattice over the area's rectangle
                           (row 0 south, x first): the page turns metres from the origin into places on the globe by
                           interpolating it, with no map projection of its own,
                   ground: { nx, ny, z: [...] }               the display ground (the lid) on a coarse lattice, null where
                           there is none: to set the features against the terrain the globe shows,
                   features: [...]                            features.json's list, each with the lon / lat of its anchor,
                   counts }
    patches.bin  "RWQ1", uint32 n_true, uint32 n_guessed, float32 cell, then float32 x, y, z for every true-entrance
                 cell and after them every guessed-opening cell (cell centres, z = the lid there; metres from the origin)

numpy only (and ridgewalk.py's own UTM formula). ASCII output.
"""
import json
import os
import struct
import sys

import numpy as np

FRAME_N = 9            # lattice of exact places (bilinear between them is good to millimetres over a few km)
GROUND_MAX = 64        # coarse ground: at most this many samples a side


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print(__doc__); return 2
    d = argv[0]
    meta = json.load(open(os.path.join(d, 'ridge.json')))
    ox, oy = (float(v) for v in meta['origin'])
    cell, nx, ny = float(meta['cell']), int(meta['nx']), int(meta['ny'])
    zone, south = meta.get('zone'), bool(meta.get('south'))
    if not zone:
        print('! the ridge result has no UTM zone (a made-up scene): no place on the map'); return 1
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from ridgewalk import utm_to_lonlat
    w, h = nx * cell, ny * cell
    g = np.linspace(0.0, 1.0, FRAME_N)
    X, Y = np.meshgrid(ox + g * w, oy + g * h)                      # row 0 south, x first
    lon, lat = utm_to_lonlat(X.ravel(), Y.ravel(), int(zone), south)
    frame = {'n': FRAME_N, 'lonlat': [[round(float(a), 8), round(float(b), 8)] for a, b in zip(lon, lat)]}

    lid = np.load(os.path.join(d, 'lid.npy'), mmap_mode='r')
    holes = np.load(os.path.join(d, 'holes.npy'), mmap_mode='r')
    gx, gy = min(GROUND_MAX, nx), min(GROUND_MAX, ny)
    ii = np.minimum(nx - 1, (np.linspace(0.0, 1.0, gx) * (nx - 1)).round().astype(np.int64))
    jj = np.minimum(ny - 1, (np.linspace(0.0, 1.0, gy) * (ny - 1)).round().astype(np.int64))
    G = np.asarray(lid[jj][:, ii], np.float64)
    ground = {'nx': int(gx), 'ny': int(gy), 'z': [None if not np.isfinite(v) else round(float(v), 2) for v in G.ravel()]}

    parts = []
    for kind in (1, 2):
        js, is_ = [], []
        for j0 in range(0, ny, 1024):                               # by bands: the grids are not read whole
            a, b = np.nonzero(np.asarray(holes[j0:j0 + 1024]) == kind)
            js.append(a + j0); is_.append(b)
        j = np.concatenate(js) if js else np.zeros(0, np.int64); i = np.concatenate(is_) if is_ else np.zeros(0, np.int64)
        z = np.zeros(len(j), np.float32)
        for j0 in range(0, ny, 1024):
            m = (j >= j0) & (j < j0 + 1024)
            if m.any():
                z[m] = np.asarray(lid[j0:j0 + 1024])[j[m] - j0, i[m]]
        ok = np.isfinite(z)
        parts.append(np.c_[(i[ok] + 0.5) * cell, (j[ok] + 0.5) * cell, z[ok]].astype('<f4'))
    with open(os.path.join(d, 'patches.bin'), 'wb') as f:
        f.write(b'RWQ1'); f.write(struct.pack('<IIf', len(parts[0]), len(parts[1]), cell))
        f.write(parts[0].tobytes()); f.write(parts[1].tobytes())

    feats = []
    fp = os.path.join(d, 'features.json')
    if os.path.exists(fp):
        feats = json.load(open(fp)).get('features') or []
        if feats:
            flon, flat = utm_to_lonlat(np.array([ox + float(t['x']) for t in feats]), np.array([oy + float(t['y']) for t in feats]), int(zone), south)
            for t, a, b in zip(feats, flon, flat):
                t['lon'] = round(float(a), 7); t['lat'] = round(float(b), 7)
    json.dump({'version': 1, 'zone': int(zone), 'south': south, 'origin': [ox, oy], 'size': [w, h], 'cell': cell, 'frame': frame, 'ground': ground,
               'features': feats, 'counts': meta.get('counts') or {}}, open(os.path.join(d, 'draw.json'), 'w'), separators=(',', ':'))
    print('[ridge] 100%% for the map: %d features, %d true-entrance cells, %d guessed' % (len(feats), len(parts[0]), len(parts[1])))
    return 0


if __name__ == '__main__':
    sys.exit(main())
