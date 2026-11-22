#!/usr/bin/env python3
"""
export_terrain.py with --area-dir: terrain from the area's shared ground
(area_ground.py) instead of build_dem. No PDAL, no network.

    python tools/test_export_area_ground.py

Made-up scene around the documentation example (45.1234, -100.5678): a
slope with a forest stand, a pit with a class-7 floor. Pins down:
  * load_area_dem returns the area ground on the export's cells, in the
    points' own heights (no shift there), and marks only class-2 cells valid;
  * project terrain (--project-terrain --area-dir): patch heights = ground +
    z_offset (same convention as build_dem's DEM), closer to the truth than
    build_dem's, no point cloud read, hillshade tiles made, result records
    z_offset and ground_source 'area';
  * the viewer export with --area-dir reads no point cloud, shades the DEM,
    records ground 'area' and applies the z offset;
  * errors: an area folder without ground stops with ERROR.
"""
import io, json, math, os, shutil, sys, tempfile, zipfile
HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, HERE)
import numpy as np
import export_terrain as et
import area_ground as ag
import route_cost as rc
from PIL import Image

fails = 0
passes = 0


def check(label, ok, detail=''):
    global fails, passes
    if ok:
        passes += 1
    else:
        fails += 1
        print('FAIL', label, detail)


TMP = tempfile.mkdtemp(prefix='exp_area_')
E0, N0, ZONE = rc.example_origin()
ZOFF = -24.5

# The area: points, ground
x, y, z, c = ag.demo_scene()
AREA = os.path.join(TMP, 'area')
os.makedirs(AREA)
npz = rc.write_npz(os.path.join(AREA, 'pts.npz'), x, y, z, c)
ag.run({'source': {'npz': npz}, 'area': ag.local_ring(0, 0, 160, 160), 'cell': 'auto'},
       AREA, say=lambda m: None)
ring = ag.local_ring(10, 10, 150, 150)
BBOX = [min(p[0] for p in ring), min(p[1] for p in ring), max(p[0] for p in ring), max(p[1] for p in ring)]
zone = et.utm_zone_for((BBOX[0] + BBOX[2]) / 2)
check('scene zone = area zone', zone == ZONE)

# 1. load_area_dem
rect = et.utm_rect_covering(BBOX, zone, 0.5)
dem, xb, yb, x0, y0, valid = et.load_area_dem(AREA, rect, 0.5, zone, False, progress=lambda m: None)
E, N = np.meshgrid(xb[:-1] + 0.25 - E0, yb[:-1] + 0.25 - N0, indexing='ij')
T = ag.demo_truth(E, N)
cx, cy, r, dep = ag.DEMO_PIT
openm = (np.hypot(E - cx, N - cy) > r + 2) & ~((E > 88) & (E < 152) & (N > 18) & (N < 142))
err = dem - T
check('area DEM = the ground, unshifted (median |err| < 0.1 m in the open)',
      np.median(np.abs(err[openm])) < 0.1, np.median(np.abs(err[openm])))
check('area DEM layout [x, y] with y northward', dem.shape == (len(xb) - 1, len(yb) - 1))
check('valid marks class-2 cells (not all in the forest)', 0.6 < valid.mean() < 1.0, valid.mean())

# 2. project terrain, area vs build_dem, same z convention
def no_points(*a, **k):
    raise AssertionError('must not read a point cloud')


def patch_err(out):
    meta, grid = et.read_terrain_patch(open(os.path.join(out, 'terrain.bin'), 'rb').read())
    lon = meta['west'] + (meta['east'] - meta['west']) * np.arange(meta['nx']) / (meta['nx'] - 1)
    lat = meta['north'] - (meta['north'] - meta['south']) * np.arange(meta['ny']) / (meta['ny'] - 1)
    LON, LAT = np.meshgrid(lon, lat)
    e, n = et.latlon_to_utm_np(LAT, LON, zone, False)
    el, nl = e - E0, n - N0
    t = ag.demo_truth(el, nl)
    keep = np.isfinite(grid) & (np.hypot(el - cx, nl - cy) > r + 2) & (el > 12) & (el < 148) & (nl > 12) & (nl < 148)
    return grid - ZOFF - t, keep, meta


real_fetch = et.fetch_ept_points
et.fetch_ept_points = no_points
out_a = os.path.join(TMP, 'pt_area')
res = et.project_terrain(None, None, None, 'classified', out_a, BBOX, resolution=0.5, z_offset=ZOFF,
                         spike_threshold=0, progress=lambda m: None, area_dir=AREA)
et.fetch_ept_points = real_fetch
ea, ka, meta_a = patch_err(out_a)
check('area patch: heights = ground + z_offset (median |err| < 0.12 m)',
      np.median(np.abs(ea[ka])) < 0.12, np.median(np.abs(ea[ka])))
check('area patch: mean bias under 0.1 m', abs(ea[ka].mean()) < 0.1, ea[ka].mean())
check('result: z_offset and ground_source', res['z_offset'] == ZOFF and res.get('ground_source') == 'area'
      and res['ground'] == 'classified', json.dumps({k: res[k] for k in ('z_offset', 'ground')}))
check('hillshade tiles made', os.path.exists(os.path.join(out_a, 'tiles', 'tiles.json')) and res['tiles']['count'] > 0)
check('patch heightReference ellipsoid, datum_shift recorded',
      meta_a['heightReference'] == 'WGS84 ellipsoid' and meta_a.get('datum_shift_m') == ZOFF)
k2 = c == 2
X, Y = x[k2] + E0, y[k2] + N0
out_b = os.path.join(TMP, 'pt_bd')
et.project_terrain(X, Y, z[k2], 'classified', out_b, BBOX, resolution=0.5, z_offset=ZOFF,
                   progress=lambda m: None)
eb, kb, _ = patch_err(out_b)
m = ka & kb
check('same vertical frame as build_dem (|mean diff| < 0.5 m)', abs((ea - eb)[m].mean()) < 0.5, (ea - eb)[m].mean())
check('area patch closer to the truth than build_dem (RMS)',
      np.sqrt((ea[m] ** 2).mean()) <= np.sqrt((eb[m] ** 2).mean()),
      (np.sqrt((ea[m] ** 2).mean()), np.sqrt((eb[m] ** 2).mean())))

# 3. the viewer export with --area-dir
et.fetch_ept_points = no_points
et.fetch_satellite_texture = lambda grid, tex_size=8192, source='esri', progress=print: \
    Image.new('RGB', grid.tex_dims(512), (90, 110, 80))
out = os.path.join(TMP, 'out.zip')


def run_main(argv):
    old, stdout = sys.argv, sys.stdout
    log = io.StringIO()
    code = 0
    try:
        sys.argv = ['export_terrain.py'] + argv
        sys.stdout = log
        et.main()
    except SystemExit as e:
        code = e.code if e.code not in (None, 0) else 0
    finally:
        sys.stdout, sys.argv = stdout, old
    return code, log.getvalue()


code, log = run_main(['--area-dir', AREA, '--bbox', *map(str, BBOX), '--out', out, '--name', 'Cave Ridge',
                      '--max-triangles', '100000', '--tex-size', '1024', '--z-offset', str(ZOFF),
                      '--resolution', '0.5'])
check('export with --area-dir written (no --ept needed)', code == 0 and os.path.exists(out), log[-800:])
if os.path.exists(out):
    zf = zipfile.ZipFile(out)
    meta = json.loads(zf.read('caves.json'))['meta']
    check('meta: lidar terrain from the area ground, dem hillshade',
          meta.get('terrain') == 'lidar' and meta.get('ground') == 'area' and meta.get('hillshade') == 'dem',
          json.dumps(meta))
    check('meta z_offset', meta.get('z_offset') == ZOFF)
    check('z offset applied', 'Applied FLEX point-cloud Z offset' in log)
    check('tex_hs.jpg present', 'tex_hs.jpg' in zf.namelist())
    import pygltflib
    g = pygltflib.GLTF2().load_from_bytes(zf.read('terrain.glb'))
    acc = g.accessors[g.meshes[0].primitives[0].attributes.POSITION]
    tmin = ag.demo_truth(np.array([10.0]), np.array([10.0, 150.0])).min()
    tmax = ag.demo_truth(np.array([150.0]), np.array([10.0, 150.0])).max()
    span = max(acc.max) - min(acc.min) if acc.max else 0
    check('mesh spans the scene', acc.max is not None and span > 0.8 * (tmax - tmin), f'{acc.min} {acc.max}')

# 4. errors
empty = os.path.join(TMP, 'empty')
os.makedirs(empty)
code, log = run_main(['--area-dir', empty, '--bbox', *map(str, BBOX), '--project-terrain',
                      os.path.join(TMP, 'pt_err')])
check('area folder without ground: ERROR', code != 0 and 'ERROR' in str(code) + log, (code, log[-300:]))
et.fetch_ept_points = real_fetch

shutil.rmtree(TMP, ignore_errors=True)
print(f'test_export_area_ground: {passes} passed, {fails} failed')
sys.exit(1 if fails else 0)
