#!/usr/bin/env python3
"""
The "V2 - Ridgewalking" export (export_terrain.py --ridgewalk / --ridgewalk-dir, export_ridge.py).
No PDAL, no network: the ridge folder is a stand-in written here, to the contract's formats.

  * the zip carries the ridge files next to the usual ones; ridge.json says frame "viewer";
  * RIDGE in the single-file viewer.html holds the same bytes inline; ridge.json's `viewer` is the
    same object with file names (the slim shell); tools/rebuild_viewer.py keeps it;
  * the terrain has real holes: no triangle over a true-entrance cell (holes == 1);
  * the patches lie over the guessed cells (holes == 2), 0.08 m above the ground;
  * points and shapes are moved into the viewer's frame;
  * "hillshade with brush" (tex_hsb.jpg, and tex_hsb_<c>_<r>.jpg when tiled): the brush classes at 70 % over the
    hillshade, inlined as TERRAIN_HSB_B64; no tex_brush.png, no RIDGE.brush; --ridge-shapes none;
  * steep ground keeps its triangles, flat ground goes coarse;
  * --ridgewalk runs the step as a child and relays its progress;
  * a normal export is unchanged: RIDGE is null and no ridge file is in the zip.

    python tools/test_export_ridge.py
"""
import base64, io, json, os, re, struct, subprocess, sys, tempfile, time, zipfile
from pathlib import Path
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import numpy as np
from PIL import Image
import export_terrain as et
import export_ridge as er
import viewer_inline

T0 = time.time()
fails = passes = 0
def check(label, ok, detail=''):
    global fails, passes
    if ok:
        passes += 1
    else:
        fails += 1
        print('FAIL', label, detail)

# ── The stand-in scene: a made-up hillside by "Cave Ridge" ───────────────────
LAT, LON = 45.1234, -100.5678
ZONE = et.utm_zone_for(LON)
CE, CN = et.latlon_to_utm(LAT, LON, ZONE)[:2]
CELL, NX, NY = 0.3, 400, 300                       # 120 x 90 m
OX, OY = round(CE - NX * CELL / 2, 1), round(CN - NY * CELL / 2, 1)
Z_OFF = -24.5
jj, ii = np.mgrid[0:NY, 0:NX]
lid = (1200.0 + 0.004 * ii + 0.002 * jj).astype(np.float32)          # nearly flat ground ...
cliff = (ii >= 250) & (ii < 262)
lid += np.where(ii >= 262, 14.0, 0.0).astype(np.float32)             # ... and a 14 m cliff, 3.6 m wide
lid[cliff] += ((ii[cliff] - 250) / 12.0 * 14.0).astype(np.float32)
ROUGH = (np.random.default_rng(7).random((NY, NX)) * 0.02).astype(np.float32)     # 2 cm of roughness, as real ground has
lid += ROUGH
holes = np.zeros((NY, NX), np.uint8)
holes[100:107, 60:66] = 1                                             # a pit: a true entrance
holes[200, 150] = 1                                                   # one lone true cell
holes[150:154, 300:305] = 2                                           # a guessed opening
holes[40:43, 252:256] = 2                                             # another, on the cliff
pts = np.array([[19.0, 31.0, 1195.0], [19.3, 31.2, 1190.5], [90.0, 46.0, 1210.0], [5.0, 5.0, 1199.0]], np.float32)
pdepth = np.array([5.1, 9.6, 4.2, 1.0], np.float32)
pkind = np.array([0, 0, 1, 3], np.uint8)
sv = np.array([[18.0, 30.0, 1200.0], [20.0, 30.0, 1200.0], [19.0, 32.0, 1200.0], [19.0, 31.0, 1192.0]], np.float32)
sdepth = np.array([0, 0, 0, 8.0], np.float32)
stri = np.array([0, 1, 2, 0, 1, 3, 1, 2, 3, 2, 0, 3], np.uint32)
BC = CELL * 3
brush = np.full((NY // 3, NX // 3), 0.02, np.float32)
brush[10:20, 10:20] = 0.2; brush[30:40, 10:20] = 0.45; brush[50:60, 10:20] = 0.9; brush[70:80, 10:20] = np.nan
COUNTS = {'returns': 1000, 'below': 4, 'groups': 1, 'lone': 1, 'likely_noise': 0, 'pattern_noise': 1, 'features': 1,
          'true_cells': int((holes == 1).sum()), 'guessed_cells': int((holes == 2).sum())}

def write_ridge(d, shapes=True, with_brush=True):
    d = Path(d); d.mkdir(parents=True, exist_ok=True)
    (d / 'ridge.json').write_text(json.dumps({
        'version': 1, 'epsg': 32600 + ZONE, 'zone': ZONE, 'south': False, 'origin': [OX, OY],
        'bbox_utm': [OX, OY, OX + NX * CELL, OY + NY * CELL], 'cell': CELL, 'nx': NX, 'ny': NY, 'params': {},
        'counts': COUNTS, 'passes': [], 'seconds': 1, 'notes': []}))
    np.save(d / 'lid.npy', lid); np.save(d / 'holes.npy', holes)
    (d / 'points.bin').write_bytes(b'RWP1' + struct.pack('<I', len(pts)) + pts.tobytes() + pdepth.tobytes() + pkind.tobytes())
    if shapes:
        (d / 'shapes.bin').write_bytes(b'RWS1' + struct.pack('<II', len(sv), len(stri) // 3) + sv.tobytes() + sdepth.tobytes() + stri.tobytes())
    if with_brush:
        np.save(d / 'brush.npy', brush)
        (d / 'brush.json').write_text(json.dumps({'x0': 0, 'y0': 0, 'cell': BC, 'nx': NX // 3, 'ny': NY // 3, 'band': [0.3, 2.0]}))
    return d

def hsb_const(html):
    m = re.search(r'<script>const TERRAIN_HSB_B64 = "(.*?)";</script>', html, re.S)
    return m.group(1) if m else 'MISSING'

def ridge_const(html):
    m = re.search(r'<script>const RIDGE = (.*?);</script>', html, re.S)
    return json.loads(m.group(1)) if m else 'MISSING'

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    rdir = write_ridge(tmp / 'ridge')
    def no_points(*a, **k): raise AssertionError('no point cloud may be read by the export itself')
    et.fetch_ept_points = no_points
    et.get_viewer_libs = lambda progress=print: viewer_inline.local_viewer_libs()        # the vendored libs: no download
    et.fetch_satellite_texture = lambda grid, tex_size=8192, source='esri', progress=print: Image.new('RGB', grid.tex_dims(tex_size), (90, 110, 80))
    seen = {}
    real_glb = et.export_glb
    def spy_glb(vertices, faces, uvs, out_path, progress=print):
        seen['v'] = np.asarray(vertices).copy(); seen['f'] = np.asarray(faces).copy()
        if et.pygltflib is None:                       # an interpreter without it: the mesh is what is checked
            Path(out_path).write_bytes(b'glb'); return
        return real_glb(vertices, faces, uvs, out_path, progress=progress)
    et.export_glb = spy_glb
    d = 0.0009
    BBOX = (LON - d, LAT - d / 2, LON + d, LAT + d / 2)
    def run(name, extra):
        out = tmp / name
        argv, so = sys.argv, sys.stdout
        sys.argv = ['export_terrain.py', '--bbox', *map(str, BBOX), '--out', str(out), '--name', 'Cave Ridge',
                    '--max-triangles', '24000', '--tex-size', '512', '--z-offset', str(Z_OFF), *extra]
        log = io.StringIO()
        try:
            sys.stdout = log
            et.main()
        except SystemExit as ex:
            log.write(f'EXIT {ex}')
        finally:
            sys.stdout, sys.argv = so, argv
        return out, log.getvalue()

    # ── 1. The ridge export ──────────────────────────────────────────────────
    out, log = run('ridge.zip', ['--ept', 'unused/ept.json', '--ridgewalk-dir', str(rdir)])
    check('ridge export written', out.exists() and 'EXIT' not in log, log[-800:])
    z = zipfile.ZipFile(out)
    names = set(z.namelist())
    want = {'terrain.glb', 'tex_sat.jpg', 'tex_hs.jpg', 'caves.json', 'viewer.html', 'serve.bat', 'serve.sh',
            'ridge.json', 'ridge_points.bin', 'ridge_shapes.bin', 'ridge_patches.bin', 'tex_hsb.jpg'}
    check('zip: the usual files and the ridge files', want <= names, sorted(want - names))
    check('zip: no brush overlay picture, no tiles for a small area', 'tex_brush.png' not in names and not [n for n in names if n.startswith('tex_hsb_') or n.startswith('tex_hs_')], sorted(names))
    caves = json.loads(z.read('caves.json'))
    meta = caves['meta']
    check('no caves: an empty survey list, ridgewalk marked in meta', caves['surveys'] == [] and meta.get('ridgewalk') == 1 and meta.get('hillshade') == 'lidar', meta)
    check('terrain cell is the ridge cell', abs(meta['terrain_cell_m'] - CELL) < 1e-9 and meta['utm_zone'] == ZONE)
    ce, cn = meta['utm_center_e'], meta['utm_center_n']
    check('frame: centred on the ridge grid', abs(ce - (OX + NX * CELL / 2)) < 1e-6 and abs(cn - (OY + NY * CELL / 2)) < 1e-6, (ce, cn))
    side = json.loads(z.read('ridge.json'))
    check('ridge.json: the step\'s own, frame viewer', side.get('frame') == 'viewer' and side['counts'] == COUNTS and side['nx'] == NX)
    slim = side.get('viewer')
    check('slim RIDGE: file names', slim == {'version': 1, 'counts': COUNTS, 'points': 'ridge_points.bin', 'patches': 'ridge_patches.bin',
                                             'shapes': 'ridge_shapes.bin', 'depthCap': 20}, slim)
    html = z.read('viewer.html').decode('utf-8')
    R = ridge_const(html)
    check('single file RIDGE: an object, no placeholder left', isinstance(R, dict) and 'PLACEHOLDER_RIDGE_JSON' not in html, str(R)[:80])
    if isinstance(R, dict):
        check('single file RIDGE: version, counts, depthCap', R['version'] == 1 and R['counts'] == COUNTS and R['depthCap'] == 20)
        for k, f in (('points', 'ridge_points.bin'), ('patches', 'ridge_patches.bin'), ('shapes', 'ridge_shapes.bin')):
            check(f'single file RIDGE.{k}: the bytes of {f}', '.' not in R[k] and base64.b64decode(R[k]) == z.read(f))

    # points and shapes in the viewer's frame
    sh = np.array([OX - ce, OY - cn, Z_OFF])
    xyz, dep, kind = er.read_points(z.read('ridge_points.bin'))
    check('points: moved into the viewer frame, depth and kind kept', np.allclose(xyz, pts + sh, atol=1e-3) and np.array_equal(dep, pdepth) and np.array_equal(kind, pkind), xyz[:1])
    sx, sd, st = er.read_shapes(z.read('ridge_shapes.bin'))
    check('shapes: moved into the viewer frame, triangles kept', np.allclose(sx, sv + sh, atol=1e-3) and np.array_equal(st, stri) and np.array_equal(sd, sdepth))

    # real holes in the terrain
    v, f = seen['v'], seen['f']
    P = v[:, :2].astype(np.float64)
    def cell_of(xy):
        return (np.floor((xy[:, 1] + NY * CELL / 2) / CELL).astype(int).clip(0, NY - 1),
                np.floor((xy[:, 0] + NX * CELL / 2) / CELL).astype(int).clip(0, NX - 1))
    A, B, C = P[f[:, 0]], P[f[:, 1]], P[f[:, 2]]
    def covered(q):                                   # is the point q inside any triangle (2-D)?
        d1 = (q[0] - B[:, 0]) * (A[:, 1] - B[:, 1]) - (A[:, 0] - B[:, 0]) * (q[1] - B[:, 1])
        d2 = (q[0] - C[:, 0]) * (B[:, 1] - C[:, 1]) - (B[:, 0] - C[:, 0]) * (q[1] - C[:, 1])
        d3 = (q[0] - A[:, 0]) * (C[:, 1] - A[:, 1]) - (C[:, 0] - A[:, 0]) * (q[1] - A[:, 1])
        neg = (d1 < 0) | (d2 < 0) | (d3 < 0); pos = (d1 > 0) | (d2 > 0) | (d3 > 0)
        return bool((~(neg & pos)).any())
    hj, hi = np.nonzero(holes == 1)
    centres = np.column_stack([(hi + 0.5) * CELL - NX * CELL / 2, (hj + 0.5) * CELL - NY * CELL / 2])
    check('holes: no triangle over the centre of any true-entrance cell', not any(covered(q) for q in centres))
    cj, ci = cell_of((A + B + C) / 3)
    check('holes: no triangle centred in a true-entrance cell', not (holes[cj, ci] == 1).any())
    check('holes: the ground right beside the pit is there', covered(np.array([(58.5) * CELL - NX * CELL / 2, (103.5) * CELL - NY * CELL / 2])))
    check('guessed cells are NOT cut', covered(np.array([(302.5) * CELL - NX * CELL / 2, (151.5) * CELL - NY * CELL / 2])))
    vj, vi = cell_of(P)
    rim = np.zeros_like(holes, bool); rim[99:108, 59:67] = True; rim &= holes != 1
    got = np.zeros_like(rim); got[vj, vi] = True
    check('holes: every cell of the pit\'s rim has its vertex', got[rim].all(), int((~got[rim]).sum()))
    check('heights: the lid plus the z offset', abs(float(v[:, 2].min()) - (float(lid.min()) + Z_OFF)) < 0.03, float(v[:, 2].min()))

    # steep against flat
    tj, ti = cell_of((A + B + C) / 3)
    on_cliff = (ti >= 248) & (ti < 264)
    dens_s = on_cliff.sum() / (16 * NY * CELL * CELL); dens_f = (~on_cliff).sum() / ((NX - 16) * NY * CELL * CELL)
    check('mesh: the cliff keeps far more triangles per m2 than the flat ground', dens_s > 6 * dens_f, (dens_s, dens_f))
    check('mesh: the cliff is at full detail (about 2 triangles a cell)', dens_s * CELL * CELL > 1.6, dens_s * CELL * CELL)
    check('mesh: inside the budget', len(f) <= 24000 * 1.05, len(f))
    ms = side.get('mesh') or {}
    check('log and ridge.json: triangles on steep / flat ground', 'Ridge mesh:' in log and ms.get('steep_tris', 0) > 0 and ms.get('flat_tris', 0) > 0, ms)
    print(f"  scene: {len(f):,} triangles; cliff {dens_s:.1f} per m2, flat {dens_f:.2f} per m2; "
          f"steep {ms.get('steep_tris')} / flat {ms.get('flat_tris')}")

    # patches
    pt = er.read_patches(z.read('ridge_patches.bin'))
    n2 = int((holes == 2).sum())
    check('patches: RWT1, two triangles a guessed cell', z.read('ridge_patches.bin')[:4] == b'RWT1' and len(pt) == 6 * n2, (len(pt), n2))
    pc = pt.reshape(-1, 3, 3).mean(axis=1)
    pj, pi = cell_of(pc[:, :2].astype(np.float64))
    check('patches: every triangle lies in a guessed cell, every guessed cell has two', (holes[pj, pi] == 2).all()
          and np.array_equal(np.bincount(pj * NX + pi, minlength=NX * NY).reshape(NY, NX), 2 * (holes == 2)))
    flat_p = pt[(pt[:, 0] + NX * CELL / 2) / CELL > 290]                 # the patch on the flat part
    ex = 1200.0 + 0.004 * ((flat_p[:, 0] + NX * CELL / 2) / CELL - 0.5) + 0.002 * ((flat_p[:, 1] + NY * CELL / 2) / CELL - 0.5) + 14.0 + Z_OFF + 0.08
    check('patches: 0.08 m above the ground at the cell corners', np.allclose(flat_p[:, 2], ex + 0.01, atol=0.012), float(np.abs(flat_p[:, 2] - ex).max()))

    # brush picture and hillshade
    hs = Image.open(io.BytesIO(z.read('tex_hs.jpg')))
    check('hillshade: one pixel a cell on the grid', hs.size == (NX, NY) and hs.mode == 'L', hs.size)
    ha = np.asarray(hs).astype(int)
    check('hillshade: the cliff shows', abs(int(ha[:, 252:260].mean()) - int(ha[:, 100:200].mean())) > 25, (ha[:, 252:260].mean(), ha[:, 100:200].mean()))
    hb = Image.open(io.BytesIO(z.read('tex_hsb.jpg')))
    check('hillshade with brush: the hillshade\'s size, in colour', hb.size == hs.size and hb.mode == 'RGB', (hb.size, hb.mode))
    check('hillshade with brush: inlined in the single file, brush opacity in meta', base64.b64decode(hsb_const(html)) == z.read('tex_hsb.jpg') and meta.get('hillshade_brush') == {'opacity': 0.7}, meta.get('hillshade_brush'))
    hba = np.asarray(hb).astype(float)
    def block(bj, bi=15):                                # mean colour of brush block (bj, bi) there, and the hillshade's grey
        rows = slice(NY - 3 * bj - 3 + 1, NY - 3 * bj - 1); cols = slice(3 * bi + 1, 3 * bi + 2)
        return hba[rows, cols].reshape(-1, 3).mean(axis=0), float(ha[rows, cols].mean())
    def near(bj, col, op=0.7):
        got, g = block(bj)
        want = (1 - op) * g + op * np.array(col, float) if col else np.array([g, g, g])
        return bool(np.abs(got - want).max() < 9), (got.round(), want.round())
    for label, bj, col in (('none: the hillshade', 5, None), ('light', 15, (0xb7, 0xe4, 0xa0)), ('medium', 35, (0x5f, 0xae, 0x4f)),
                           ('dense', 55, (0x1f, 0x5f, 0x1f)), ('blank: the hillshade', 75, None)):
        okc, det = near(bj, col)
        check(f'hillshade with brush: {label} at 70 %', okc, det)

    # --brush-opacity and --ridge-shapes none
    outb, logb = run('strong.zip', ['--ridgewalk-dir', str(rdir), '--brush-opacity', '0.8', '--ridge-shapes', 'none'])
    zb = zipfile.ZipFile(outb)
    hba = np.asarray(Image.open(io.BytesIO(zb.read('tex_hsb.jpg')))).astype(float)
    ha = np.asarray(Image.open(io.BytesIO(zb.read('tex_hs.jpg')))).astype(int)
    okc, det = near(55, (0x1f, 0x5f, 0x1f), 0.8)
    check('--brush-opacity 0.8: dense brush nearly its own colour', okc and json.loads(zb.read('caves.json'))['meta']['hillshade_brush'] == {'opacity': 0.8}, det)
    Rb = ridge_const(zb.read('viewer.html').decode('utf-8'))
    check('--ridge-shapes none: no ridge_shapes.bin, RIDGE.shapes null, the rest there', 'ridge_shapes.bin' not in zb.namelist() and Rb['shapes'] is None and Rb['points']
          and json.loads(zb.read('ridge.json'))['viewer']['shapes'] is None)

    # tiled (a big area): every tile has its hillshade with brush, meta names it
    real_plan = et.plan_tiles
    et.plan_tiles = lambda w, h: (2, 2)
    outt, logt = run('tiled.zip', ['--ridgewalk-dir', str(rdir)])
    et.plan_tiles = real_plan
    zt = zipfile.ZipFile(outt); nt = set(zt.namelist())
    tiles = {f'tex_{k}_{c}_{r}.jpg' for k in ('sat', 'hs', 'hsb') for c in range(2) for r in range(2)}
    check('tiled: sat, hs and hsb tiles, and the overviews', tiles <= nt and {'tex_hs.jpg', 'tex_hsb.jpg', 'tex_sat.jpg'} <= nt, sorted(tiles - nt))
    tt = json.loads(zt.read('caves.json'))['meta'].get('texture_tiles')
    check('tiled: meta texture_tiles names hsb like hs', tt == {'cols': 2, 'rows': 2, 'sat': True, 'hs': True, 'hsb': True}, tt)
    t_hs = Image.open(io.BytesIO(zt.read('tex_hs_0_1.jpg'))); t_hb = Image.open(io.BytesIO(zt.read('tex_hsb_0_1.jpg')))   # the south-west tile holds the light and medium blocks
    ta = np.asarray(t_hb).astype(float); tg = np.asarray(t_hs.convert('L')).astype(float)
    r0, c0 = (NY // 2 - 3 * 15 - 2), 3 * 15 + 1                                  # brush block (15, 15) in that tile
    want = 0.3 * tg[r0, c0] + 0.7 * np.array([0xb7, 0xe4, 0xa0], float)
    check('tiled: the tile is the hillshade tile with the brush on it', t_hb.size == t_hs.size and t_hb.mode == 'RGB' and np.abs(ta[r0, c0] - want).max() < 12
          and np.abs(ta[5, 5] - tg[5, 5]).max() < 6, (ta[r0, c0], want))
    import tex_tiles
    check('tex_tiles: hsb tile names are tiles', tex_tiles.TILE_RE.match('tex_hsb_1_0.jpg') and tex_tiles.TILE_RE.match('tex_hs_1_0.jpg').group(1) == 'hs')

    # rebuild_viewer keeps RIDGE
    r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rebuild_viewer.py'), str(out), '-o', str(tmp / 'rebuilt.zip')],
                       capture_output=True, text=True)
    check('rebuild_viewer runs', r.returncode == 0, r.stderr[-300:])
    if r.returncode == 0:
        R2 = ridge_const(zipfile.ZipFile(tmp / 'rebuilt.zip').read('viewer.html').decode('utf-8'))
        h2 = zipfile.ZipFile(tmp / 'rebuilt.zip').read('viewer.html').decode('utf-8')
        check('rebuild_viewer: the same RIDGE and hillshade with brush', R2 == R and hsb_const(h2) == hsb_const(html))

    # ── 2. No shapes, no brush: null, not missing ────────────────────────────
    out2, log2 = run('bare.zip', ['--ridgewalk-dir', str(write_ridge(tmp / 'bare', shapes=False, with_brush=False))])
    z2 = zipfile.ZipFile(out2)
    R = ridge_const(z2.read('viewer.html').decode('utf-8'))
    check('no shapes / brush: null in RIDGE, no such files', isinstance(R, dict) and R['shapes'] is None and 'brush' not in R and R['points'] and hsb_const(z2.read('viewer.html').decode('utf-8')) == ''
          and not ({'ridge_shapes.bin', 'tex_brush.png', 'tex_hsb.jpg'} & set(z2.namelist())), log2[-300:])

    # ── 3. A polygon: the mesh ends at its line, the holes stay ──────────────
    ring = [[BBOX[0] + 0.0002, BBOX[1] + 0.0001], [BBOX[2] - 0.0002, BBOX[1] + 0.0001], [BBOX[2] - 0.0003, BBOX[3] - 0.0001], [BBOX[0] + 0.0003, BBOX[3] - 0.0001]]
    (tmp / 'ring.json').write_text(json.dumps(ring))
    ring_utm = et.polygon_to_utm(np.array(ring), ZONE)
    lid_all = lid.copy()
    ins = et.polygon_inside_grid(ring_utm, OX + (np.arange(NX) + 0.5) * CELL, OY + (np.arange(NY) + 0.5) * CELL).T
    lid[~ins] = np.nan
    out3, log3 = run('poly.zip', ['--ridgewalk-dir', str(write_ridge(tmp / 'poly')), '--polygon', str(tmp / 'ring.json')])
    lid[:] = lid_all
    check('polygon export written', out3.exists() and 'EXIT' not in log3, log3[-600:])
    v, f = seen['v'], seen['f']
    P = v[:, :2].astype(np.float64); A, B, C = P[f[:, 0]], P[f[:, 1]], P[f[:, 2]]
    cen = (A + B + C) / 3 + [OX + NX * CELL / 2, OY + NY * CELL / 2]
    check('polygon: every triangle inside the line', et.points_in_polygon(cen[:, 0], cen[:, 1], ring_utm).all())
    check('polygon: the pit is still cut, heights are finite', not any(covered(q) for q in centres[:6]) and np.isfinite(v).all())

    # ── 4. --ridgewalk runs the step as a child and relays its lines ─────────
    stub = tmp / 'fake_ridgewalk.py'
    stub.write_text("import shutil, sys\n"
                    "a = sys.argv\n"
                    "print('[ridge] 10% reading tile 1 of 2', flush=True)\n"
                    "print('[ridge] 80% stitching', flush=True)\n"
                    "assert '--ept' in a and '--bbox' in a and len(a[a.index('--bbox') + 1:a.index('--bbox') + 5]) == 4\n"
                    f"shutil.copytree({str(rdir)!r}, a[a.index('--out') + 1], dirs_exist_ok=True)\n"
                    "print('[ridge] 100% done', flush=True)\n")
    os.environ['FLEX_RIDGE_SCRIPT'] = str(stub)
    out4, log4 = run('child.zip', ['--ept', 'made-up/ept.json', '--ridgewalk'])
    check('--ridgewalk: export written from the child\'s folder', out4.exists() and 'ridge_points.bin' in zipfile.ZipFile(out4).namelist(), log4[-600:])
    check('--ridgewalk: progress relayed as export steps', '[1/7] Ridgewalking 10% reading tile 1 of 2' in log4 and '[1/7] Ridgewalking 100% done' in log4, log4[:400])
    stub.write_text(stub.read_text().replace("print('[ridge] 100% done', flush=True)", f"open({str(tmp / 'child_args.txt')!r}, 'w').write(' '.join(a))"))
    out4b, log4b = run('child2.zip', ['--ept', 'made-up/ept.json', '--ridgewalk', '--ridge-shapes', 'none'])
    check('--ridge-shapes none: the step is told --no-shapes, and no shapes file is carried', ' --no-shapes' in (tmp / 'child_args.txt').read_text()
          and out4b.exists() and 'ridge_shapes.bin' not in zipfile.ZipFile(out4b).namelist(), log4b[-300:])
    stub.write_text("import sys\nprint('[ridge] 5% reading')\nprint('no such dataset')\nsys.exit(3)\n")
    out5, log5 = run('fail.zip', ['--ept', 'made-up/ept.json', '--ridgewalk'])
    check('--ridgewalk: a failed step stops the export and says why', not out5.exists() and 'EXIT' in log5 and 'no such dataset' in log5, log5[-300:])
    del os.environ['FLEX_RIDGE_SCRIPT']
    _, log6 = run('bad.zip', ['--ridgewalk'])
    check('--ridgewalk without a point cloud is refused', 'needs a point cloud' in log6, log6[-200:])

    # ── 5. A normal export is unchanged ──────────────────────────────────────
    lon = BBOX[0] - 0.001 + np.arange(40) * 0.0001; lat = BBOX[1] - 0.001 + np.arange(30) * 0.0001
    H = (1200 + 300 * (lat[:, None] - LAT) + 200 * (lon[None, :] - LON)).astype('<f4')
    H.tofile(tmp / 'dem.bin')
    (tmp / 'dem.json').write_text(json.dumps({'lon0': float(lon[0]), 'lat0': float(lat[0]), 'dlon': 0.0001, 'dlat': 0.0001, 'nx': 40, 'ny': 30, 'cell': 2.0, 'file': 'dem.bin'}))
    out7, log7 = run('normal.zip', ['--dem-grid', str(tmp / 'dem.json')])
    check('normal export written', out7.exists(), log7[-600:])
    if out7.exists():
        z7 = zipfile.ZipFile(out7)
        n7 = set(z7.namelist())
        h7 = z7.read('viewer.html').decode('utf-8')
        check('normal export: RIDGE is null', ridge_const(h7) is None and 'PLACEHOLDER_RIDGE_JSON' not in h7.replace("'PLACEHOLDER_' + 'RIDGE_JSON'", ''), str(ridge_const(h7))[:60])
        check('normal export: the hillshade-with-brush placeholder is an empty string', hsb_const(h7) == '' and '"PLACEHOLDER_HSB_B64"' not in h7, hsb_const(h7)[:40])
        check('normal export: no hillshade_brush in meta', 'hillshade_brush' not in json.loads(z7.read('caves.json'))['meta'])
        check('normal export: the same file list as ever', {n for n in n7 if not n.startswith('libs/')} == {'terrain.glb', 'tex_sat.jpg', 'tex_hs.jpg', 'caves.json', 'viewer.html', 'serve.bat', 'serve.sh'}, sorted(n7))
        check('normal export: no ridgewalk in meta', 'ridgewalk' not in json.loads(z7.read('caves.json'))['meta'])
    _, log8 = run('both.zip', ['--dem-grid', str(tmp / 'dem.json'), '--ridgewalk'])
    check('--ridgewalk with map terrain is refused', 'not with --dem-grid' in log8, log8[-200:])

    # build_mesh: the mode's options off = the mesh as it always was
    dem = (np.fromfunction(lambda i, j: 0.02 * i + 3 * np.sin(j / 9.0), (90, 120))).astype(np.float32)
    xb = np.arange(91) * 0.5; yb = np.arange(121) * 0.5
    v1, f1 = et.build_mesh(dem, xb, yb, 0, 0, max_triangles=6000, progress=lambda m: None)
    v2, f2 = et.build_mesh(dem, xb, yb, 0, 0, max_triangles=6000, progress=lambda m: None, score=None, force=None, flat_div=4)
    check('build_mesh: defaults give the same bytes', v1.tobytes() == v2.tobytes() and f1.tobytes() == f2.tobytes())

print(f'{passes} passed, {fails} failed ({time.time() - T0:.1f} s)')
sys.exit(1 if fails else 0)
