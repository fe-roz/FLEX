#!/usr/bin/env python3
"""
Export with the terrain taken from FLEX's map (Cesium) instead of the LiDAR.

No PDAL, no network: a synthetic terrain is "sampled" on the same lon/lat grid
FLEX's browser code lays out (index.html _sampleMapTerrain), and the exporter
runs end to end on it with the satellite fetch stubbed. Run from the FLEX
folder with the exporter's Python:

    python tools/test_map_terrain.py

Pins down:
  * the browser's padded lon/lat grid covers the whole export rectangle, even
    off the zone's central meridian (no cell left to guess);
  * resampling onto the UTM cells returns the map's heights, unshifted;
  * the terrain hillshade is north-up and east-right like the textures;
  * a full export reads no point cloud, and records terrain 'map' and a
    'dem' hillshade;
  * tools/rebuild_viewer.py remakes that export's viewer.html from its own
    parts, byte for byte.
"""
import io, json, math, os, sys, tempfile, zipfile
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import numpy as np
import export_terrain as et
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

# A made-up box 2.6 deg off its zone's central meridian (zone 41, CM 63 E),
# about 25 x 22 km: a lat/lon box there is visibly rotated in UTM.
BBOX = (65.60, 40.00, 65.89, 40.20)
CENTRE_LAT = (BBOX[1] + BBOX[3]) / 2

def ground(lat, lon):
    """Smooth synthetic terrain, metres above the ellipsoid, plus a hill."""
    h = 800 + 2000 * (lat - 40.0) - 900 * (lon - 65.6)
    h += 120 * np.sin((lon - 65.6) * 40) * np.cos((lat - 40.0) * 35)
    # one round hill in the north-east, for the orientation check
    d2 = ((lat - 40.17) * 111.3) ** 2 + ((lon - 65.85) * 85.3) ** 2   # km^2
    return h + 300 * np.exp(-d2 / 1.0)

def browser_grid(bbox, cell):
    """The layout index.html's _sampleMapTerrain uses, with the same padding."""
    w, s, e, n = bbox
    mLat, mLon = 111320.0, 111320.0 * math.cos((s + n) / 2 * math.pi / 180)
    W, H = (e - w) * mLon, (n - s) * mLat
    pad = 0.06 * max(W, H) + 3 * cell
    nx = math.ceil((W + 2 * pad) / cell) + 1
    ny = math.ceil((H + 2 * pad) / cell) + 1
    lon0, lat0, dlon, dlat = w - pad / mLon, s - pad / mLat, cell / mLon, cell / mLat
    lon = lon0 + np.arange(nx) * dlon
    lat = lat0 + np.arange(ny) * dlat
    LON, LAT = np.meshgrid(lon, lat)            # row 0 = lat0
    return dict(lon0=lon0, lat0=lat0, dlon=dlon, dlat=dlat, nx=nx, ny=ny, cell=cell), ground(LAT, LON)

CELL = 50.0
zone = et.utm_zone_for((BBOX[0] + BBOX[2]) / 2)
with tempfile.TemporaryDirectory() as tmp:
    hdr, heights = browser_grid(BBOX, CELL)
    (open(os.path.join(tmp, 'dem.bin'), 'wb')).write(heights.astype('<f4').tobytes())
    hdr['file'] = 'dem.bin'
    hpath = os.path.join(tmp, 'dem.json')
    json.dump(hdr, open(hpath, 'w'))

    # ── 1. Resampling onto the export's UTM cells ────────────────────────────
    rect = et.utm_rect_covering(BBOX, zone, CELL)
    dem, xb, yb, x0, y0, valid = et.load_map_dem(hpath, rect, CELL, zone, progress=lambda m: None)
    check('padded lon/lat grid covers the whole UTM rectangle', bool(valid.all()),
          f'{int((~valid).sum())} cells uncovered')
    E, N = np.meshgrid(xb[:-1] + CELL / 2, yb[:-1] + CELL / 2, indexing='ij')
    lat, lon = et.utm_to_latlon(E, N, zone)
    err = np.abs(dem - ground(lat, lon))
    check('map heights come back at the cell centres, unshifted', float(err.max()) < 0.5,
          f'max error {err.max():.3f} m')
    check('DEM laid out [x, y] like build_dem', dem.shape == (len(xb) - 1, len(yb) - 1), str(dem.shape))
    drop = et.border_nodata_mask(valid, CELL, progress=lambda m: None)
    check('nothing dropped at the border', not drop.any())

    # ── 2. Terrain hillshade: north up, east right ───────────────────────────
    grid = et.UtmGrid(xb[0], yb[0], xb[-1], yb[-1], zone)
    img, hs_cell = et.dem_hillshade(dem, CELL, grid, progress=lambda m: None)
    a = np.asarray(img, dtype=np.float32)
    check('hillshade sized to the grid (upsampled)', a.shape[1] >= dem.shape[0] and a.shape[0] >= dem.shape[1]
          and abs(a.shape[1] / a.shape[0] - grid.width / grid.height) < 0.02, f'{a.shape} cell {hs_cell}')
    # The hill (north-east) is where the shading varies most.
    hh, ww = a.shape
    quads = {'NE': a[:hh // 3, 2 * ww // 3:], 'NW': a[:hh // 3, :ww // 3],
             'SE': a[2 * hh // 3:, 2 * ww // 3:], 'SW': a[2 * hh // 3:, :ww // 3]}
    spread = {k: float(np.percentile(v, 99) - np.percentile(v, 1)) for k, v in quads.items()}
    check('the north-east hill shows in the north-east corner', max(spread, key=spread.get) == 'NE', str(spread))

    # ── 3. Full export with --dem-grid: no point cloud, nothing fetched ──────
    def no_points(*a, **k):
        raise AssertionError('the map-terrain export must not read a point cloud')
    et.fetch_ept_points = no_points
    et.fetch_satellite_texture = lambda grid, tex_size=8192, source='esri', progress=print: \
        Image.new('RGB', grid.tex_dims(512), (90, 110, 80))
    out = os.path.join(tmp, 'out.zip')
    argv = sys.argv
    sys.argv = ['export_terrain.py', '--dem-grid', hpath, '--bbox', *map(str, BBOX), '--out', out,
                '--name', 'Test', '--max-triangles', '200000', '--tex-size', '1024', '--z-offset', '-24.5']
    log = io.StringIO()
    stdout = sys.stdout
    try:
        sys.stdout = log
        et.main()
    finally:
        sys.stdout, sys.argv = stdout, argv
    check('export written', os.path.exists(out), log.getvalue()[-800:])
    if os.path.exists(out):
        z = zipfile.ZipFile(out)
        names = set(z.namelist())
        check('zip holds the terrain, textures and viewer',
              {'terrain.glb', 'tex_sat.jpg', 'tex_hs.jpg', 'caves.json', 'viewer.html'} <= names, str(sorted(names)))
        meta = json.loads(z.read('caves.json'))['meta']
        check('meta: terrain from the map, dem hillshade, cell recorded',
              meta.get('terrain') == 'map' and meta.get('hillshade') == 'dem' and meta.get('terrain_cell_m') == CELL,
              json.dumps(meta))
        check('no vertical shift applied to map terrain', 'Applied FLEX point-cloud Z offset' not in log.getvalue())
        # Heights in the GLB: spot-check that the mesh spans the synthetic range.
        import pygltflib
        g = pygltflib.GLTF2().load_from_bytes(z.read('terrain.glb'))
        acc = g.accessors[g.meshes[0].primitives[0].attributes.POSITION]
        check('mesh heights span the map terrain',
              acc.min and acc.max and (acc.max[2] - acc.min[2]) > 300, f'{acc.min} {acc.max}')

        # ── 4. tools/rebuild_viewer.py remakes the same viewer from the parts ──
        import subprocess
        rebuilt = os.path.join(tmp, 'rebuilt.zip')
        r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rebuild_viewer.py'),
                            out, '-o', rebuilt], capture_output=True, text=True)
        check('rebuild_viewer runs', r.returncode == 0 and os.path.exists(rebuilt), r.stderr[-500:])
        if os.path.exists(rebuilt):
            z2 = zipfile.ZipFile(rebuilt)
            check('rebuilt viewer.html identical with the same template', z2.read('viewer.html') == z.read('viewer.html'))
            check('every other entry copied unchanged',
                  sorted(z2.namelist()) == sorted(z.namelist()) and
                  all(z2.read(n) == z.read(n) for n in z.namelist() if n != 'viewer.html'))

print(f'{passes} passed, {fails} failed')
sys.exit(1 if fails else 0)
