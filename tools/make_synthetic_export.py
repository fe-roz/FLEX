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
        [--extent-km 6]      a larger terrain (default 1 x 0.8 km); over 5 km it is
                             tiled the way the exporter does (tex_tiles.py)
        [--flex-leads]       one lead kept in FLEX on the main line (status, source, id, priority)
        [--field-fixture]    extra data for tools/test_viewer_field.js: leads whose
                             survey order differs from the straight-line one, shots
                             with no from/to names, a bare survey code beside the
                             same code with a description, a code shared by two
                             surveys, and a station name used twice

Needs the exporter's environment (numpy, Pillow, pygltflib).
"""
import argparse, io, json, math, os, shutil, sys, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np
from PIL import Image, ImageDraw
from export_terrain import export_glb, latlon_to_utm, utm_zone_for
from tex_tiles import plan_tiles, tile_name, meta_entry
from viewer_inline import build_inline_viewer, local_viewer_libs
from cave_walls import pack_walls

LAT0, LON0 = 45.1234, -100.5678          # the project's example place
W, H = 1000.0, 800.0                     # terrain extent, metres
FT = 0.3048


def ground(x, y):
    return 500 + 30 * math.sin(x / 150) + 20 * math.cos(y / 120) + 8 * math.sin((x + y) / 60)


def terrain(n=81):
    global W, H
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


# --field-fixture: a side loop that leaves A1, runs a long way round and comes
# back close (in a straight line) to A0; and two small surveys sharing a code.
LOOP = [
    ('A1', None, None, None, None, None, None, None),
    ('S1', -25, 200, 6, 3, 3, 4, 1),
    ('S2', -60, 200, 6, 3, 3, 4, 1),
    ('X1', -60, 62, 6, 3, 3, 4, 1),
]
CODE_C1 = [('C1', 60, 100, 5, 2, 2, 3, 1), ('C2', 70, 110, 5, 2, 2, 3, 1)]
CODE_C2 = [('A1', 300, 300, 5, 2, 2, 3, 1), ('C3', 310, 310, 5, 2, 2, 3, 1)]

def caves_json(e0, n0, zone, fixture=False, flex_leads=False):
    known = {}
    main = place(MAIN, known)
    branch = place(BRANCH, known)
    surveys = []
    plan = [('Main line', 'Cave Ridge', '#00e5ff', main), ('North branch', 'Cave Ridge', '#ffab40', branch)]
    if fixture:
        # place() keys stations by name, so the second "A1" is placed on its own.
        plan += [('Side loop', 'Cave Ridge', '#b388ff', place(LOOP, known)),
                 ('C', 'Cave Ridge', '#69f0ae', place(CODE_C1, known)),
                 ('C \u2014 Crawl to the north', 'Cave Ridge', '#ff80ab', place(CODE_C2, {}))]
    for name, cave, color, sts in plan:
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
        if fixture and name in ('C', 'C \u2014 Crawl to the north'):
            sv['code'] = 'C'
        if fixture and name == 'North branch':
            for sh in shots:                       # an older export: shots carry no station names
                sh.pop('from_name', None); sh.pop('to_name', None)
        if fixture and name == 'Main line':
            sv['leads'] = [{'station': 'A10', 'xyz': known['A10'], 'description': 'Water crawl', 'width': 0.6, 'height': 0.4}]
        if fixture and name == 'Side loop':
            sv['leads'] = [{'station': 'X1', 'xyz': known['X1'], 'description': 'Dig at the end', 'width': 0.5, 'height': 0.5}]
        if flex_leads and name == 'Main line':          # a lead kept in FLEX (project / My data), as the desktop export writes it
            sv['leads'] = [{'station': 'A10', 'xyz': known['A10'], 'description': 'Draughting squeeze', 'width': 0.4, 'height': 0.3,
                            'date': '2026-10-02', 'status': 'confirmed', 'source': 'flex', 'id': 'flexlead-1', 'priority': '2'}]
        if name == 'North branch':
            sv['leads'] = [{'station': 'B3', 'xyz': known['B3'], 'description': 'Tight crawl continues north, air',
                            'width': 0.4, 'height': 0.3, 'date': '2026-09-01'}]
        surveys.append(sv)
    walls = []
    for sts, color in ((main, '#00e5ff'), (branch, '#ffab40')):   # (walls: the first two surveys only)
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
    ap.add_argument('--extent-km', type=float, default=0, help='terrain size, long side (default 1 km x 0.8 km)')
    ap.add_argument('--field-fixture', action='store_true')
    ap.add_argument('--flex-leads', action='store_true', help='a lead kept in FLEX (source flex, status, id, priority) on the main line')
    a = ap.parse_args()
    global W, H
    if a.extent_km:
        W, H = a.extent_km * 1000.0, a.extent_km * 800.0
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    zone = utm_zone_for(LON0)
    e0, n0, _ = latlon_to_utm(LAT0, LON0, zone)

    v, f, uv = terrain()
    export_glb(v, f, uv, out / 'terrain.glb', progress=lambda m: None)
    texture(out / 'tex_sat.jpg')
    caves = caves_json(e0, n0, zone, a.field_fixture, a.flex_leads)
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
    tiles = []
    cols, rows = plan_tiles(W, H)
    if cols * rows > 1:
        # One flat colour per tile (so a test can see which tile is where), a
        # grey hillshade, and the overview for a viewer that cannot read tiles.
        Image.new('L', (512, 410), 128).save(out / 'tex_hs.jpg', 'JPEG')
        for r in range(rows):
            for c in range(cols):
                col = (40 + 190 * c // max(1, cols - 1), 60 + 150 * r // max(1, rows - 1), 90 + 30 * (c + r))
                Image.new('RGB', (256, 256), col).save(out / tile_name('sat', c, r), 'JPEG', quality=95)
                Image.new('L', (256, 256), 60 + 40 * (c + r)).save(out / tile_name('hs', c, r), 'JPEG', quality=95)
                tiles += [tile_name('sat', c, r), tile_name('hs', c, r)]
        caves['meta']['texture_tiles'] = meta_entry(cols, rows, True, True)
        caves['meta']['hillshade'] = 'lidar'
    (out / 'caves.json').write_text(json.dumps(caves), encoding='utf-8')
    libs = local_viewer_libs()
    (out / 'libs').mkdir(exist_ok=True)
    for zp, p in libs.items():
        shutil.copyfile(p, out / 'libs' / p.name)
    import base64
    tex_b64 = base64.b64encode((out / 'tex_sat.jpg').read_bytes()).decode('ascii')
    hs_b64 = base64.b64encode((out / 'tex_hs.jpg').read_bytes()).decode('ascii') if tiles else None
    html = build_inline_viewer(out / 'terrain.glb', tex_b64, caves, libs, progress=lambda m: None,
                               walls_bytes=data, hs_b64=hs_b64)
    (out / 'viewer.html').write_text(html, encoding='utf-8')
    slug = a.name.replace(' ', '-')
    with zipfile.ZipFile(out.parent / f'FLEX-{slug}.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
        for name in ('terrain.glb', 'tex_sat.jpg', 'walls.bin', 'caves.json', 'viewer.html', *(['tex_hs.jpg'] if tiles else []), *tiles):
            zf.write(out / name, name)
        for p in sorted((out / 'libs').glob('*.js')):
            zf.write(p, 'libs/' + p.name)
    print(f'wrote {out} and {out.parent / f"FLEX-{slug}.zip"}')


if __name__ == '__main__':
    main()
