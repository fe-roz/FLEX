#!/usr/bin/env python3
"""
ridge_area.py: what the desktop map needs of a ridgewalking result (draw.json, patches.bin). No PDAL, no network.
The result is ridgewalk.py's own made-up scene (--demo), given the example place (45.1234, -100.5678) as a real run has.

    python tools/test_ridge_area.py
"""
import json, math, os, struct, subprocess, sys, tempfile, time
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, ROOT)
import numpy as np
import ridgewalk as rw

T0 = time.time()
fails = passes = 0
def check(label, ok, detail=''):
    global fails, passes
    if ok:
        passes += 1
    else:
        fails += 1
        print('FAIL', label, str(detail)[:500])

LAT, LON = 45.1234, -100.5678
with tempfile.TemporaryDirectory() as tmp:
    d = os.path.join(tmp, 'rw')
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'ridgewalk.py'), '--demo', d, '--workers', '2'], capture_output=True, text=True)
    check('the made-up scene ran', r.returncode == 0, r.stdout[-300:] + r.stderr[-300:])
    r0 = subprocess.run([sys.executable, os.path.join(ROOT, 'ridge_area.py'), d], capture_output=True, text=True)
    check('a result with no place on earth (the bare demo) is refused in plain words, exit 1', r0.returncode == 1 and 'no UTM zone' in r0.stdout and not os.path.exists(os.path.join(d, 'draw.json')), r0.stdout)
    e0, n0 = rw.lonlat_to_utm(np.array([LON]), np.array([LAT]), 14)
    E0, N0 = math.floor(float(e0[0])) - 96.0, math.floor(float(n0[0])) - 72.0
    m = json.load(open(os.path.join(d, 'ridge.json'))); m.update(epsg=32614, zone=14, south=False, origin=[E0, N0]); json.dump(m, open(os.path.join(d, 'ridge.json'), 'w'))
    r1 = subprocess.run([sys.executable, os.path.join(ROOT, 'ridge_area.py'), d], capture_output=True, text=True)
    check('with a place: exit 0, a last line in the step\'s own progress form, ASCII', r1.returncode == 0 and r1.stdout.strip().splitlines()[-1].startswith('[ridge] 100% for the map:') and r1.stdout.isascii(), r1.stdout + r1.stderr[-300:])
    D = json.load(open(os.path.join(d, 'draw.json')))
    lid = np.load(os.path.join(d, 'lid.npy')); holes = np.load(os.path.join(d, 'holes.npy'))
    ny, nx = lid.shape; cell = m['cell']
    check('draw.json: version, zone, origin, size and cell of the result', D['version'] == 1 and D['zone'] == 14 and D['south'] is False and D['origin'] == [E0, N0] and abs(D['size'][0] - nx * cell) < 1e-6 and abs(D['size'][1] - ny * cell) < 1e-6 and D['cell'] == cell, {k: D[k] for k in ('zone', 'origin', 'size', 'cell')})
    F = D['frame']; n = F['n']
    check('the frame: a 9 x 9 lattice of lon / lat over the rectangle, row 0 south, x first', n == 9 and len(F['lonlat']) == 81 and F['lonlat'][0][0] < F['lonlat'][8][0] and F['lonlat'][0][1] < F['lonlat'][72][1], F['lonlat'][:2])
    # the lattice is exact: back to UTM lands on the lattice
    ll = np.array(F['lonlat']); be, bn = rw.lonlat_to_utm(ll[:, 0], ll[:, 1], 14)
    gx, gy = np.meshgrid(E0 + np.linspace(0, 1, n) * nx * cell, N0 + np.linspace(0, 1, n) * ny * cell)
    check('…each node is its place (back to UTM within 2 cm)', float(np.abs(be - gx.ravel()).max()) < 0.02 and float(np.abs(bn - gy.ravel()).max()) < 0.02, (float(np.abs(be - gx.ravel()).max()), float(np.abs(bn - gy.ravel()).max())))
    # interpolating the lattice (as the page does) is good to millimetres here: the middle of a lattice cell
    mid_e, mid_n = E0 + nx * cell * 1.5 / 8, N0 + ny * cell * 2.5 / 8
    mlon, mlat = rw.utm_to_lonlat(np.array([mid_e]), np.array([mid_n]), 14, False)
    g = lambda i, j: ll[j * n + i]
    interp = (g(1, 2) + g(2, 2) + g(1, 3) + g(2, 3)) / 4
    check('…and half way between four nodes their mean is the true place to under a millimetre', abs(interp[0] - mlon[0]) * 78000 < 0.001 and abs(interp[1] - mlat[0]) * 111000 < 0.001, (interp, mlon, mlat))
    G = D['ground']
    check('the coarse ground: at most 64 a side, the lid\'s own heights at its corners, null where there is none', G['nx'] <= 64 and G['ny'] <= 64 and len(G['z']) == G['nx'] * G['ny'] and abs(G['z'][0] - float(lid[0, 0])) < 0.011 and abs(G['z'][-1] - float(lid[-1, -1])) < 0.011 and
          all(v is None or isinstance(v, float) for v in G['z']), (G['nx'], G['ny'], G['z'][:3]))
    feats = json.load(open(os.path.join(d, 'features.json')))['features']
    check('the features, each with the lon / lat of its anchor (back to UTM within 2 cm); features.json itself is left alone', len(D['features']) == len(feats) >= 4 and 'lon' not in feats[0] and all(
        abs(float(rw.lonlat_to_utm(np.array([f['lon']]), np.array([f['lat']]), 14)[0][0]) - (E0 + f['x'])) < 0.02 and abs(float(rw.lonlat_to_utm(np.array([f['lon']]), np.array([f['lat']]), 14)[1][0]) - (N0 + f['y'])) < 0.02 and
        f['id'] == g_['id'] and f['n'] == g_['n'] and f['box'] == g_['box'] for f, g_ in zip(D['features'], feats)), D['features'][:1])
    check('the counts come along', D['counts'].get('features') == len(feats) and D['counts'].get('true_cells') == int((holes == 1).sum()))
    buf = open(os.path.join(d, 'patches.bin'), 'rb').read()
    nt, ng, pc = struct.unpack_from('<IIf', buf, 4)
    P = np.frombuffer(buf, '<f4', (nt + ng) * 3, 16).reshape(-1, 3)
    check('patches.bin: RWQ1, the counts of true-entrance and guessed cells, the cell size, 12 bytes a cell', buf[:4] == b'RWQ1' and nt == int((holes == 1).sum()) and ng == int((holes == 2).sum()) and abs(pc - cell) < 1e-6 and len(buf) == 16 + (nt + ng) * 12 and nt > 0 and ng > 0, (nt, ng, pc, len(buf)))
    ci = np.floor(P[:, 0] / cell).astype(int); cj = np.floor(P[:, 1] / cell).astype(int)
    check('…cell centres, true cells first then guessed, each at the lid\'s height there', (holes[cj[:nt], ci[:nt]] == 1).all() and (holes[cj[nt:], ci[nt:]] == 2).all() and np.allclose(P[:, 2], lid[cj, ci], atol=1e-3) and
          np.allclose(P[:, 0] / cell - ci, 0.5, atol=1e-3))
    check('the two files are small (the grids they come from stay behind)', os.path.getsize(os.path.join(d, 'draw.json')) < 200_000 and os.path.getsize(os.path.join(d, 'patches.bin')) < os.path.getsize(os.path.join(d, 'holes.npy')))

print(f'{passes} passed, {fails} failed ({time.time() - T0:.1f} s)')
sys.exit(1 if fails else 0)
