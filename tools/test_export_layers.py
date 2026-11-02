#!/usr/bin/env python3
"""
Exports that use the project's terrain patches and map layers (no PDAL, no network):

  * apply_terrain_patches(): a patch (ellipsoid heights, NaN = no data) over the map terrain gives its
    own heights inside, the map's outside, and hands over smoothly at its edge, including at the
    empty corners a rotated DEM leaves (no cliff);
  * warp_lonlat_image(): a GeoTIFF layer's picture (lon/lat box) lands on the export's UTM frame;
  * a whole export with --dem-grid --terrain-patch --satellite-source image --hillshade image;
  * a tile layer that can't be fetched falls back instead of failing the export;
  * xyz_url(): {z} {x} {y} {-y} {reverseY} {s}.

    python tools/test_export_layers.py
"""
import contextlib, io, json, math, os, sys, tempfile, zipfile
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import numpy as np
from PIL import Image
import export_terrain as et

fails = passes = 0
def check(label, ok, detail=''):
    global fails, passes
    if ok:
        passes += 1
    else:
        fails += 1
        print('FAIL', label, detail)

# A made-up box 2.6 deg off its zone's central meridian: a lat/lon box is rotated in UTM there.
BBOX = (65.600, 40.000, 65.620, 40.015)
zone = et.utm_zone_for((BBOX[0] + BBOX[2]) / 2)
CELL = 5.0
def base_height(lat, lon): return 800.0 + 2000 * (lat - 40.0) - 900 * (lon - 65.6)     # the map's terrain
PATCH_UP = 12.0                                                                       # the patch is this much above the map
def patch_height(lat, lon): return base_height(lat, lon) + PATCH_UP + 3 * np.sin((lon - 65.6) * 3000)

def write_patch(path, W, S, E, N, cell_m, hole=None):
    mLon = 111320 * math.cos(math.radians((S + N) / 2))
    nx, ny = int(round((E - W) * mLon / cell_m)) + 1, int(round((N - S) * 110540 / cell_m)) + 1
    lon = W + (E - W) * np.arange(nx) / (nx - 1); lat = N - (N - S) * np.arange(ny) / (ny - 1)
    LON, LAT = np.meshgrid(lon, lat)
    g = patch_height(LAT, LON).astype(np.float32)
    if hole is not None:
        g[hole(LON, LAT)] = np.nan
    meta = {'west': W, 'south': S, 'east': E, 'north': N, 'nx': nx, 'ny': ny, 'cell_m': cell_m}
    Path(path).write_bytes(et.pack_terrain_patch(meta, g))
    return meta
from pathlib import Path

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    # the map terrain grid, laid out as the browser does (padded, row 0 = south)
    w, s, e, n = BBOX
    mLat, mLon = 111320.0, 111320.0 * math.cos(math.radians((s + n) / 2))
    pad = 0.06 * max((e - w) * mLon, (n - s) * mLat) + 3 * CELL
    nx, ny = math.ceil(((e - w) * mLon + 2 * pad) / CELL) + 1, math.ceil(((n - s) * mLat + 2 * pad) / CELL) + 1
    lon0, lat0, dlon, dlat = w - pad / mLon, s - pad / mLat, CELL / mLon, CELL / mLat
    LON, LAT = np.meshgrid(lon0 + np.arange(nx) * dlon, lat0 + np.arange(ny) * dlat)
    (tmp / 'dem.bin').write_bytes(base_height(LAT, LON).astype('<f4').tobytes())
    hdr = dict(lon0=lon0, lat0=lat0, dlon=dlon, dlat=dlat, nx=nx, ny=ny, cell=CELL, file='dem.bin')
    (tmp / 'dem.json').write_text(json.dumps(hdr))

    # ── 1. patches over the map terrain ──────────────────────────────────────
    rect = et.utm_rect_covering(BBOX, zone, CELL)
    dem0, xb, yb, _, _, valid = et.load_map_dem(str(tmp / 'dem.json'), rect, CELL, zone, progress=lambda m: None)
    E, N = np.meshgrid(xb[:-1] + CELL / 2, yb[:-1] + CELL / 2, indexing='ij')
    lat, lon = et.utm_to_latlon(E, N, zone)
    # a patch over the middle of the box, a triangle at its north-west with no data (the corner of a rotated DEM)
    pw, ps, pe, pn = w + 0.003, s + 0.003, e - 0.003, n - 0.003
    cut = lambda LO, LA: ((LO - pw) / (pe - pw) + (pn - LA) / (pn - ps)) < 0.5
    write_patch(tmp / 'p1.bin', pw, ps, pe, pn, 2.0, hole=cut)
    dem1, share = et.apply_terrain_patches(dem0.copy(), xb, yb, zone, False, [str(tmp / 'p1.bin')], progress=lambda m: None)
    d = dem1 - dem0
    inside = (lon > pw) & (lon < pe) & (lat > ps) & (lat < pn)
    deep = inside & ((lon - pw) * mLon > 150) & ((pe - lon) * mLon > 150) & ((lat - ps) * mLat > 150) & ((pn - lat) * mLat > 150) \
           & (((lon - pw) / (pe - pw) + (pn - lat) / (pn - ps)) > 0.5 + 150 / 1000)
    ok_deep = deep & (np.abs(d - PATCH_UP) < 4)
    check('deep inside the patch the heights are the patch\'s (map + 12 m, within its 3 m ripple)', deep.sum() > 50 and ok_deep.sum() == deep.sum(),
          (int(deep.sum()), int(ok_deep.sum()), float(d[deep].min()) if deep.any() else None))
    check('outside the patch the map terrain is untouched', float(np.abs(d[~inside]).max()) == 0.0)
    corner = inside & (((lon - pw) / (pe - pw) + (pn - lat) / (pn - ps)) < 0.5)
    check('in the empty corner the map terrain is untouched', corner.sum() > 20 and float(np.abs(d[corner]).max()) == 0.0, int(corner.sum()))
    # no step: neighbouring cells never differ by more than the ramp allows (12 m over 60 m = 1.5 x 12/60 per metre)
    step = max(float(np.abs(np.diff(d, axis=0)).max()), float(np.abs(np.diff(d, axis=1)).max()))
    check(f'no cliff at the patch edge or the empty corner (largest step between {CELL:g} m cells < 4.5 m)', step < 4.5, step)
    check('share of the area the patch reached is reported', 0.05 < share < 0.9, share)
    # two patches: the later wins
    write_patch(tmp / 'p2.bin', pw, ps, pe, pn, 2.0)
    dem2, _ = et.apply_terrain_patches(dem0.copy(), xb, yb, zone, False, [str(tmp / 'p1.bin'), str(tmp / 'p2.bin')], progress=lambda m: None)
    check('a second patch fills the empty corner', float(np.abs((dem2 - dem0)[corner & (((lon - pw) / (pe - pw) + (pn - lat) / (pn - ps)) < 0.3)]).max()) > 3)

    # ── 2. a picture on a lon/lat box ────────────────────────────────────────
    img = Image.new('RGBA', (200, 100), (200, 0, 0, 255))
    img.paste((0, 0, 200, 255), (100, 0, 200, 100))
    img.paste((0, 0, 0, 0), (0, 0, 200, 20))                      # a transparent strip along the north
    img.save(tmp / 'layer.png')
    bw, bs, be, bn = w + 0.004, s + 0.004, e - 0.004, n - 0.004
    grid = et.UtmGrid(xb[0], yb[0], xb[-1], yb[-1], zone)
    tex, cover = et.warp_lonlat_image(str(tmp / 'layer.png'), (bw, bs, be, bn), grid, *grid.tex_dims(600))
    a = np.asarray(tex)
    def px_at(lo, la):
        ee, nn = et.latlon_to_utm(la, lo, zone)[:2]
        return a[int((grid.n1 - nn) / grid.height * a.shape[0]), int((ee - grid.e0) / grid.width * a.shape[1])]
    midlat = (bs + bn) / 2
    check('picture: west half red, east half blue', tuple(px_at(bw + (be - bw) * 0.25, midlat)) == (200, 0, 0) and tuple(px_at(bw + (be - bw) * 0.75, midlat)) == (0, 0, 200),
          (px_at(bw + (be - bw) * 0.25, midlat), px_at(bw + (be - bw) * 0.75, midlat)))
    check('picture: outside its box the fill', tuple(px_at(w - 0.0001, midlat)) == (160, 160, 160), px_at(w - 0.0001, midlat))
    check('picture: transparent strip takes the fill', tuple(px_at(bw + (be - bw) * 0.25, bn - (bn - bs) * 0.05)) == (160, 160, 160), px_at(bw + (be - bw) * 0.25, bn - (bn - bs) * 0.05))
    check('picture: coverage reported', 0.2 < cover < 0.9, cover)
    try:
        et.layer_texture(grid, 400, 'image', '', 256, str(tmp / 'layer.png'), (10, 10, 10.1, 10.1))
        check('picture away from the area is refused', False)
    except ValueError:
        check('picture away from the area is refused', True)
    check('xyz_url placeholders', et.xyz_url('http://x/{s}/{z}/{x}/{y}.png', 3, 2, 5) == 'http://x/a/5/3/2.png'
          and et.xyz_url('http://x/{z}/{x}/{-y}.png', 3, 2, 5) == 'http://x/5/3/29.png'
          and et.xyz_url('http://x/{z}/{x}/{reverseY}.png', 3, 2, 5) == 'http://x/5/3/29.png')

    # ── 3. a whole export ────────────────────────────────────────────────────
    def no_points(*a, **k): raise AssertionError('no point cloud may be read')
    et.fetch_ept_points = no_points
    et.get_viewer_libs = lambda progress=print: {}
    seen = {}
    def fake_glb(vertices, faces, uvs, out_path, progress=print):
        seen['v'] = np.asarray(vertices); Path(out_path).write_bytes(b'glb')
    et.export_glb = fake_glb
    def run(extra):
        out = tmp / 'out.zip'
        argv, so = sys.argv, sys.stdout
        sys.argv = ['export_terrain.py', '--dem-grid', str(tmp / 'dem.json'), '--bbox', *map(str, BBOX), '--out', str(out),
                    '--name', 'Test', '--max-triangles', '300000', '--tex-size', '600', '--z-offset', '-24.5', *extra]
        log = io.StringIO()
        try:
            sys.stdout = log
            et.main()
        except SystemExit as ex:
            log.write(f'EXIT {ex}')
        finally:
            sys.stdout, sys.argv = so, argv
        return out, log.getvalue()
    out, log = run([])
    base_v = seen['v'].copy()
    out, log = run(['--terrain-patch', str(tmp / 'p1.bin'), '--terrain-patch', str(tmp / 'p2.bin'),
                    '--satellite-source', 'image', '--satellite-image', str(tmp / 'layer.png'), '--satellite-bounds', *map(str, (bw, bs, be, bn)),
                    '--hillshade', 'image', '--hillshade-image', str(tmp / 'layer.png'), '--hillshade-bounds', *map(str, (bw, bs, be, bn))])
    check('export written', out.exists(), log[-600:])
    if out.exists():
        z = zipfile.ZipFile(out)
        meta = json.loads(z.read('caves.json'))['meta']
        check('meta: 2 patches, satellite from the layer, image hillshade', meta.get('terrain_patches') == 2 and meta.get('satellite') == 'image' and meta.get('hillshade') == 'image', meta)
        check('log: project terrain used', 'Project terrain used for' in log, log[-400:])
        raised = float(seen['v'][:, 2].mean() - base_v[:, 2].mean())
        check('the mesh is higher on average, by about the patch\'s share of the area x 12 m', 0.5 * share * PATCH_UP < raised < 1.2 * share * PATCH_UP, (raised, share))
        tex_sat = np.asarray(Image.open(io.BytesIO(z.read('tex_sat.jpg'))).convert('RGB')).astype(int)
        red = ((tex_sat[:, :, 0] > 150) & (tex_sat[:, :, 2] < 80)).sum(); blue = ((tex_sat[:, :, 2] > 150) & (tex_sat[:, :, 0] < 80)).sum()
        check('the satellite texture is the layer (red and blue both present)', red > 5000 and blue > 5000, (int(red), int(blue)))
        hs = np.asarray(Image.open(io.BytesIO(z.read('tex_hs.jpg'))).convert('RGB')).astype(int)
        check('the hillshade texture is the layer', ((hs[:, :, 0] > 150) & (hs[:, :, 2] < 80)).sum() > 5000)

    # a tile link that gives nothing: the export still finishes, on Bing/grey, and says so
    et.fetch_satellite_texture = lambda grid, tex_size=8192, source='esri', progress=print: Image.new('RGB', grid.tex_dims(300), (90, 110, 80))
    out, log = run(['--satellite-source', 'xyz', '--satellite-url', 'http://127.0.0.1:9/{z}/{x}/{y}.png', '--hillshade', 'image'])
    check('unusable tile link: export still written', out.exists(), log[-500:])
    check('unusable tile link: says it fell back', 'could not be used' in log and 'taking Bing imagery instead' in log, log[-500:])
    check('unusable hillshade layer: shades the terrain instead', 'shading the terrain instead' in log, log[-500:])

print(f'export layers: {passes} passed, {fails} failed')
sys.exit(1 if fails else 0)
