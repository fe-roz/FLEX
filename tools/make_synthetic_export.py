#!/usr/bin/env python3
"""
Make a small, entirely made-up FLEX export: rolling terrain, a satellite-ish
texture, and a cave ("Cave Ridge") with LRUDs, a branch, a pitch, unmeasured
and placeholder stations, a lead, an area label and passage walls. The same
files a real export writes (terrain.glb, tex_sat.jpg, caves.json, walls.bin,
the single-file viewer.html, libs/), as a folder and as a zip.

For trying FLEX Field on a phone, and for the headless tests, without any real
survey data. Every number here is synthetic; the place is the project's
example coordinates.

    python tools/make_synthetic_export.py OUT_DIR [--name "Cave Ridge"]

Needs the exporter's environment (numpy, Pillow, pygltflib).
"""
import argparse, io, json, math, os, shutil, sys, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np
from PIL import Image, ImageDraw
from export_terrain import export_glb, latlon_to_utm, utm_zone_for
from viewer_inline import build_inline_viewer, local_viewer_libs
from cave_walls import pack_walls

LAT0, LON0 = 45.1234, -100.5678          # the project's example place
W, H = 1000.0, 800.0                     # terrain extent, metres
FT = 0.3048


def ground(x, y):
    return 500 + 30 * math.sin(x / 150) + 20 * math.cos(y / 120) + 8 * math.sin((x + y) / 60)


def terrain(n=81):
    xs = np.linspace(-W / 2, W / 2, n)
    ys = np.linspace(-H / 2, H / 2, n)
    verts, uvs = [], []
    for j, y in enumerate(ys):
        for i, x in enumerate(xs):
            verts.append([x, y, ground(x, y)])
            uvs.append([i / (n - 1), 1 - j / (n - 1)])      # V = 0 at north
    faces = []
    for j in range(n - 1):
        for i in range(n - 1):
            a, b, c, d = j * n + i, j * n + i + 1, (j + 1) * n + i, (j + 1) * n + i + 1
            faces += [[a, b, d], [a, d, c]]
    return np.array(verts, np.float64), np.array(faces, np.uint32), np.array(uvs, np.float32)


def texture(path):
    im = Image.new('RGB', (1024, 820), (58, 82, 48))
    d = ImageDraw.Draw(im)
    for k in range(0, 1024, 64):
        d.line([(k, 0), (k, 820)], fill=(80, 104, 66), width=2)
    for k in range(0, 820, 64):
        d.line([(0, k), (1024, k)], fill=(80, 104, 66), width=2)
    d.ellipse([380, 300, 470, 380], fill=(120, 110, 90))         # a clearing over the entrance
    d.rectangle([0, 600, 1024, 640], fill=(150, 140, 120))        # a track
    im.save(path, 'JPEG', quality=85)


# Station: name, x, y, depth below ground (m), L, R, U, D in feet (None = not measured)
MAIN = [
    ('A0', -40, 20, 2, 4, 4, 6, 1),
    ('A1', -25, 22, 8, 3, 3, 5, 1),
    ('A2', -10, 18, 14, 1, 1.5, 3, 0.5),        # narrow
    ('A3', 5, 15, 18, 2, 2, 1.5, 0.5),           # low
    ('A4', 22, 12, 20, 6, 6, 10, 2),             # roomy
    ('A5', 40, 10, 21, 8, 7, 12, 3),
    ('A6', 58, 14, 22, None, None, None, None),  # not measured
    ('A7', 75, 20, 22, 0, 0, 0, 0),              # 0/0/0/0 placeholder
    ('A8', 90, 26, 23, 3, 3, 4, 1),
    ('A9', 90.2, 26.1, 38, 3, 3, 4, 2),          # bottom of a 15 m pitch
    ('A10', 104, 30, 40, 4, 4, 6, 1),
]
BRANCH = [
    ('A4', None, None, None, None, None, None, None),
    ('B1', 28, 30, 21, 2, 2, 3, 1),
    ('B2', 32, 46, 23, 1, 1, 2, 0.5),
    ('B3', 30, 62, 25, 2, 3, 4, 1),
]


def place(rows, known):
    out = []
    for name, x, y, dep, *lrud in rows:
        if x is None:
            out.append((name, known[name], None))
            continue
        p = [x, y, ground(x, y) - dep]
        known[name] = p
        lr = None if lrud[0] is None else [v * FT for v in lrud]
        out.append((name, p, lr))
    return out


def box_walls(stations):
    """Blocky walls between consecutive stations, as FLEX would send them."""
    pos, idx = [], []
    for (n1, a, l1), (n2, b, l2) in zip(stations, stations[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        hz = math.hypot(dx, dy) or 1.0
        lx, ly = -dy / hz, dx / hz
        def sec(p, lr):
            l, r, u, d = [max(0.05, v) if lr else FT for v in (lr or [FT] * 4)]
            if lr and all(v == 0 for v in lr):
                l = r = u = d = FT
            return [[p[0] + lx * l, p[1] + ly * l, p[2] + u], [p[0] - lx * r, p[1] - ly * r, p[2] + u],
                    [p[0] - lx * r, p[1] - ly * r, p[2] - d], [p[0] + lx * l, p[1] + ly * l, p[2] - d]]
        s1, s2 = sec(a, l1 or l2), sec(b, l2 or l1)
        base = len(pos) // 3
        for v in s1 + s2:
            pos += [round(c, 3) for c in v]
        for k in range(4):
            k2 = (k + 1) % 4
            idx += [base + k, base + 4 + k, base + 4 + k2, base + k, base + 4 + k2, base + k2]
    return pos, idx


def caves_json(e0, n0, zone):
    known = {}
    main = place(MAIN, known)
    branch = place(BRANCH, known)
    surveys = []
    for name, cave, color, sts in (('Main line', 'Cave Ridge', '#00e5ff', main),
                                   ('North branch', 'Cave Ridge', '#ffab40', branch)):
        lines, shots, stations = [], [], []
        for (n1, a, _), (n2, b, _) in zip(sts, sts[1:]):
            lines.append([a, b])
            dx, dy, dz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
            L = math.sqrt(dx * dx + dy * dy + dz * dz)
            shots.append({'from_xyz': a, 'to_xyz': b, 'from_name': n1, 'to_name': n2, 'length': round(L, 2),
                          'azimuth': round(math.degrees(math.atan2(dx, dy)) % 360, 1),
                          'inclination': round(math.degrees(math.atan2(dz, math.hypot(dx, dy))), 1)})
        for n, p, lr in sts:
            if lr is None and n in [s['name'] for s in stations]:
                continue
            st = {'name': n, 'xyz': p}
            if lr is not None:
                st['lrud'] = [round(v, 3) for v in lr]
            stations.append(st)
        sv = {'name': name, 'cave': cave, 'color': color, 'lines': lines, 'shots': shots, 'stations': stations}
        if name == 'North branch':
            sv['leads'] = [{'station': 'B3', 'xyz': known['B3'], 'description': 'Tight crawl continues north, air',
                            'width': 0.4, 'height': 0.3, 'date': '2026-09-01'}]
        surveys.append(sv)
    walls = []
    for sts, color in ((main, '#00e5ff'), (branch, '#ffab40')):
        pos, idx = box_walls([s if s[2] is not None or s[0] != 'A4' else (s[0], s[1], [6 * FT, 6 * FT, 10 * FT, 2 * FT]) for s in sts])
        walls.append({'color': color, 'opacity': 0.55, 'positions': pos, 'indices': idx})
    out = {'surveys': surveys,
           'labels': [{'text': 'Big Room', 'xyz': [40, 10, ground(40, 10) - 15]}],
           'passages': walls}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out_dir')
    ap.add_argument('--name', default='Cave Ridge')
    a = ap.parse_args()
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    zone = utm_zone_for(LON0)
    e0, n0, _ = latlon_to_utm(LAT0, LON0, zone)

    v, f, uv = terrain()
    export_glb(v, f, uv, out / 'terrain.glb', progress=lambda m: None)
    texture(out / 'tex_sat.jpg')
    caves = caves_json(e0, n0, zone)
    data, desc = pack_walls(caves.pop('passages'))
    (out / 'walls.bin').write_bytes(data)
    caves['walls'] = desc
    caves['meta'] = {
        'name': a.name, 'format_version': 2,
        'utm_center_e': e0, 'utm_center_n': n0, 'utm_zone': zone, 'z_offset': -24.5,
        'center_lon': LON0, 'center_lat': LAT0,
        'extent_utm': [e0 - W / 2, n0 - H / 2, e0 + W / 2, n0 + H / 2],
        'hillshade': None, 'hillshade_cell_m': None, 'terrain': 'lidar', 'terrain_cell_m': 12.5,
    }
    (out / 'caves.json').write_text(json.dumps(caves), encoding='utf-8')
    libs = local_viewer_libs()
    (out / 'libs').mkdir(exist_ok=True)
    for zp, p in libs.items():
        shutil.copyfile(p, out / 'libs' / p.name)
    import base64
    tex_b64 = base64.b64encode((out / 'tex_sat.jpg').read_bytes()).decode('ascii')
    html = build_inline_viewer(out / 'terrain.glb', tex_b64, caves, libs, progress=lambda m: None,
                               walls_bytes=data)
    (out / 'viewer.html').write_text(html, encoding='utf-8')
    slug = a.name.replace(' ', '-')
    with zipfile.ZipFile(out.parent / f'FLEX-{slug}.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
        for name in ('terrain.glb', 'tex_sat.jpg', 'walls.bin', 'caves.json', 'viewer.html'):
            zf.write(out / name, name)
        for p in sorted((out / 'libs').glob('*.js')):
            zf.write(p, 'libs/' + p.name)
    print(f'wrote {out} and {out.parent / f"FLEX-{slug}.zip"}')


if __name__ == '__main__':
    main()
