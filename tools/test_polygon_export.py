"""Polygon export area (export_terrain.py): the polygon tests, the mesh cut
at the line, the blanked textures, and a whole export from a synthetic map
terrain grid with --polygon. Synthetic data only; no network.

    python tools/test_polygon_export.py        (the exporter's environment)
"""
import io, json, math, os, sys, tempfile, zipfile
from pathlib import Path
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import export_terrain as et

passes, fails = 0, []
def ok(label, cond, info=''):
    global passes
    if cond:
        passes += 1
    else:
        fails.append(label)
        print('FAIL', label, info)

# A concave shape (an L with a notch), in metres
L = np.array([[-200, -150], [180, -150], [180, -20], [40, -20], [40, 60], [90, 60],
              [90, 140], [-200, 140]], dtype=float)
ok('area of the L', abs(et.polygon_area(L) - (380 * 290 - 140 * 160 + 50 * 80)) < 1e-6, et.polygon_area(L))

# 1) The grid test and the point test agree, and both match a slow reference.
rng = np.random.default_rng(7)
xs = np.linspace(-220, 200, 97); ys = np.linspace(-170, 160, 71)
G = et.polygon_inside_grid(L, xs, ys)
X, Y = np.meshgrid(xs, ys, indexing='ij')
ok('grid == points', np.array_equal(G, et.points_in_polygon(X, Y, L)))
def slow(px, py, poly):
    c = False
    for (x1, y1), (x2, y2) in zip(poly, np.roll(poly, -1, axis=0)):
        if (x1 <= px) != (x2 <= px) and py >= y1 + (px - x1) * (y2 - y1) / (x2 - x1):
            c = not c
    return c
P = rng.uniform([-220, -170], [200, 160], size=(3000, 2))
ok('points == reference', all(et.points_in_polygon(P[:, :1], P[:, 1:], L).ravel() == [slow(a, b, L) for a, b in P]))
ok('distance to edge', abs(et.polygon_edge_distance(np.array([0.0]), np.array([-140.0]), L)[0] - 10) < 1e-9)
ok('densified ring keeps vertices, step ≤ 0.8',
   all(any(np.allclose(v, r) for r in et.densify_ring(L, 0.8)) for v in L) and
   np.max(np.hypot(*np.diff(np.vstack([et.densify_ring(L, 0.8), et.densify_ring(L, 0.8)[:1]]), axis=0).T)) <= 0.8 + 1e-9)
ok('self-intersection found', et.self_intersecting(np.array([[0, 0], [10, 10], [10, 0], [0, 10]], float)))
ok('…and not for the L', not et.self_intersecting(L))

# 2) The mesh, cut at the line.
res = 1.0
nx, ny = 420, 320
x_bins = np.arange(nx + 1) * res; y_bins = np.arange(ny + 1) * res
cx = (np.arange(nx) - (nx - 1) / 2) * res; cy = (np.arange(ny) - (ny - 1) / 2) * res
CX, CY = np.meshgrid(cx, cy, indexing='ij')
dem = (12 * np.sin(CX / 37.0) * np.cos(CY / 23.0) + 0.02 * CX + 3 * np.exp(-((CX - 30) ** 2 + CY ** 2) / 300)).astype(np.float64)
budget = 60_000
quiet = lambda m: None
v_full, f_full = et.build_mesh(dem, x_bins, y_bins, 0, 0, budget, progress=quiet)
v, f = et.build_mesh(dem, x_bins, y_bins, 0, 0, budget, progress=quiet, clip=L)
V = v.astype(np.float64)
A, B, C = V[f[:, 0], :2], V[f[:, 1], :2], V[f[:, 2], :2]
area = 0.5 * np.abs((B[:, 0] - A[:, 0]) * (C[:, 1] - A[:, 1]) - (B[:, 1] - A[:, 1]) * (C[:, 0] - A[:, 0]))
rel = abs(area.sum() - et.polygon_area(L)) / et.polygon_area(L)
ok('mesh area = polygon area (cut at the line)', rel < 2e-4, rel)
cen = (A + B + C) / 3
ok('every triangle centre inside', et.points_in_polygon(cen[:, 0], cen[:, 1], L).all())
outv = ~et.points_in_polygon(V[:, 0], V[:, 1], L)
dline = et.polygon_edge_distance(V[outv, 0], V[outv, 1], L) if outv.any() else np.zeros(1)
ok('no vertex beyond the line (float32 rounding only)', dline.max() < 1e-3, dline.max())
# edges along the boundary: every boundary edge of the mesh lies on the polygon
edges = np.sort(np.vstack([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]), axis=1)
u, cnt = np.unique(edges, axis=0, return_counts=True)
bnd = u[cnt == 1]
mid = (V[bnd[:, 0], :2] + V[bnd[:, 1], :2]) / 2
dm = et.polygon_edge_distance(mid[:, 0], mid[:, 1], L)
ok('mesh outline lies on the polygon line', dm.max() < 1e-3, dm.max())
ok('…and runs all the way round it', abs(np.hypot(*(V[bnd[:, 0], :2] - V[bnd[:, 1], :2]).T).sum()
                                         - sum(math.hypot(*(b - a)) for a, b in zip(L, np.roll(L, -1, axis=0)))) < 1e-2)
# heights: every vertex on the DEM surface (bilinear)
def bil(px, py):
    fi = (px + (nx - 1) / 2 * res) / res; fj = (py + (ny - 1) / 2 * res) / res
    i0 = np.clip(np.floor(fi).astype(int), 0, nx - 2); j0 = np.clip(np.floor(fj).astype(int), 0, ny - 2)
    uu = fi - i0; vv = fj - j0
    return (dem[i0, j0] * (1 - uu) * (1 - vv) + dem[i0 + 1, j0] * uu * (1 - vv)
            + dem[i0, j0 + 1] * (1 - uu) * vv + dem[i0 + 1, j0 + 1] * uu * vv)
ok('vertex heights on the DEM', np.abs(V[:, 2] - bil(V[:, 0], V[:, 1])).max() < 1e-3)
frac = et.polygon_area(L) / ((nx - 1) * (ny - 1) * res * res)
ok('triangle budget spent inside', 0.8 * budget < len(f) <= 1.02 * budget, (len(f), budget, len(f_full)))
print(f'  mesh: polygon {frac * 100:.0f}% of the box; {len(f):,} triangles inside vs '
      f'{int(len(f_full) * frac):,} the whole-box mesh puts there')

# 3) Textures blanked outside.
grid = et.UtmGrid(-210, -160, 190, 150, 14)
rgb = (rng.random((310, 400, 3)) * 255).astype(np.uint8)
img = Image.fromarray(rgb)
before = io.BytesIO(); img.save(before, 'JPEG', quality=85)
et.blank_outside(img, grid, L)
arr = np.asarray(img)
# pixel centres
pe = grid.e0 + (np.arange(400) + 0.5) * grid.width / 400
pn = grid.n1 - (np.arange(310) + 0.5) * grid.height / 310
PE, PN = np.meshgrid(pe, pn)
ins = et.points_in_polygon(PE, PN, L)
dd = et.polygon_edge_distance(PE.ravel(), PN.ravel(), L).reshape(PE.shape)
deep_in = ins & (dd > 3); deep_out = ~ins & (dd > 3)
ok('inside pixels untouched', np.array_equal(arr[deep_in], rgb[deep_in]))
ok('outside pixels one colour', len(np.unique(arr[deep_out].reshape(-1, 3), axis=0)) == 1)
after = io.BytesIO(); img.save(after, 'JPEG', quality=85)
ok('JPEG smaller', after.tell() < before.tell(), (before.tell(), after.tell()))
hs = Image.fromarray((rng.random((310, 400)) * 255).astype(np.uint8), 'L')
et.blank_outside(hs, grid, L)
ok('greyscale hillshade too', len(np.unique(np.asarray(hs)[deep_out])) == 1)

# 4) A whole export: map terrain grid + polygon (network parts stubbed).
lat0, lon0 = 45.1234, -100.5678                       # the synthetic example location
mlat, mlon = 111320.0, 111320.0 * math.cos(math.radians(lat0))
poly_ll = [[lon0 + x / mlon, lat0 + y / mlat] for x, y in L * 1.5]
with tempfile.TemporaryDirectory() as td:
    td = Path(td)
    gnx, gny, cell = 340, 290, 2.0
    glon0, glat0 = lon0 - 330 / mlon, lat0 - 270 / mlat
    gx = (np.arange(gnx) * cell - 330); gy = (np.arange(gny) * cell - 270)
    GX, GY = np.meshgrid(gx, gy)                       # rows = lat
    H = (300 + 10 * np.sin(GX / 50) + 6 * np.cos(GY / 40)).astype('<f4')
    H.tofile(td / 'dem.bin')
    (td / 'dem.json').write_text(json.dumps({'lon0': glon0, 'lat0': glat0, 'dlon': cell / mlon, 'dlat': cell / mlat,
                                             'nx': gnx, 'ny': gny, 'cell': cell, 'file': 'dem.bin'}))
    (td / 'poly.json').write_text(json.dumps(poly_ll + [poly_ll[0]]))
    caves = {'surveys': [{'name': 'MAIN', 'color': '#00e5ff', 'shots': [
        {'from': [lon0, lat0, 280.0], 'to': [lon0 + 20 / mlon, lat0, 278.0], 'from_name': 'A0', 'to_name': 'A1'}],
        'stations': [{'name': 'A0', 'lon': lon0, 'lat': lat0, 'elev': 280.0}]}]}
    (td / 'caves.json').write_text(json.dumps(caves))
    et.fetch_satellite_texture = lambda grid, tex_size=0, source='', progress=print: \
        Image.fromarray((np.random.default_rng(1).random((256, 256, 3)) * 255).astype(np.uint8)).resize(grid.tex_dims(512))
    et.get_viewer_libs = lambda progress=print: {}
    out = td / 'out.zip'
    sys.argv = ['export_terrain.py', '--dem-grid', str(td / 'dem.json'), '--bbox', '0', '0', '0', '0',
                '--polygon', str(td / 'poly.json'), '--caves', str(td / 'caves.json'), '--out', str(out),
                '--name', 'Cave Ridge', '--hillshade', 'dem', '--max-triangles', '40000', '--tex-size', '512']
    log = io.StringIO()
    from contextlib import redirect_stdout
    with redirect_stdout(log):
        et.main()
    text = log.getvalue()
    ok('export ran', out.exists(), text[-2000:])
    z = zipfile.ZipFile(out)
    meta = json.loads(z.read('caves.json'))['meta']
    ok('meta has the polygon', len(meta.get('area_polygon') or []) == len(L), meta)
    ok('log says nothing outside is exported', 'nothing outside it is exported' in text)
    import pygltflib
    g = pygltflib.GLTF2.load_from_bytes(z.read('terrain.glb'))
    acc = g.accessors[g.meshes[0].primitives[0].attributes.POSITION]
    bv = g.bufferViews[acc.bufferView]
    blob = g.binary_blob()
    pos = np.frombuffer(blob, dtype=np.float32, count=acc.count * 3, offset=(bv.byteOffset or 0) + (acc.byteOffset or 0)).reshape(-1, 3)
    # the GLB is Y-up (x, z, -y) or (x, y, z)? Use whichever axis pair spans the polygon
    poly_m = np.array(meta['area_polygon'])
    cand = [(pos[:, 0], pos[:, 1]), (pos[:, 0], -pos[:, 2]), (pos[:, 0], pos[:, 2])]
    best = min(cand, key=lambda c: et.polygon_edge_distance(c[0][~et.points_in_polygon(c[0], c[1], poly_m)],
                                                            c[1][~et.points_in_polygon(c[0], c[1], poly_m)], poly_m).max(initial=0)
               + (0 if np.ptp(c[1]) > 1 else 1e9))
    outside = ~et.points_in_polygon(best[0], best[1], poly_m)
    dmax = et.polygon_edge_distance(best[0][outside], best[1][outside], poly_m).max(initial=0)
    ok('GLB vertices all inside the polygon (to float32)', dmax < 0.01, dmax)
    ok('GLB reaches the polygon all round', abs(np.ptp(best[0]) - np.ptp(poly_m[:, 0])) < 0.05 and abs(np.ptp(best[1]) - np.ptp(poly_m[:, 1])) < 0.05,
       (np.ptp(best[0]), np.ptp(poly_m[:, 0]), np.ptp(best[1]), np.ptp(poly_m[:, 1])))
    sat = Image.open(io.BytesIO(z.read('tex_sat.jpg')))
    corner = np.asarray(sat)[:6, -6:].reshape(-1, 3).astype(int)      # NE corner: outside the L
    ok('satellite blanked outside', np.ptp(corner, axis=0).max() < 12, corner[:3])

    # 5) The same polygon from a point cloud (fetch stubbed): points far
    # outside are not gridded, and the LiDAR hillshade is built and blanked.
    got = {}
    def fake_fetch(ept_path, utm_bbox, bbox_latlon=None, progress=print, zone=None, south=False, with_mode=False):
        e0, n0, e1, n1 = utm_bbox
        r = np.random.default_rng(3)
        n = 400_000
        x = r.uniform(e0, e1, n); y = r.uniform(n0, n1, n)
        z = 300 + 5 * np.sin((x - e0) / 40) + 3 * np.cos((y - n0) / 30)
        c = np.zeros(n, np.uint8)
        got['n'] = n
        return x, y, z, c, c, c, 'all'
    et.fetch_ept_points = fake_fetch
    out2 = td / 'out2.zip'
    sys.argv = ['export_terrain.py', '--ept', 'stub/ept.json', '--bbox', '0', '0', '0', '0',
                '--polygon', str(td / 'poly.json'), '--out', str(out2), '--name', 'Cave Ridge',
                '--hillshade', 'lidar', '--resolution', '2', '--max-triangles', '30000', '--tex-size', '512']
    log = io.StringIO()
    with redirect_stdout(log):
        et.main()
    text = log.getvalue()
    import re
    m = re.search(r'Polygon: kept ([\d,]+) of ([\d,]+) points', text)
    ok('points outside the polygon not gridded', m and int(m.group(1).replace(',', '')) < 0.92 * int(m.group(2).replace(',', '')), text[-1500:])
    z2 = zipfile.ZipFile(out2)
    ok('LiDAR export has a hillshade', 'tex_hs.jpg' in z2.namelist(), text[-1500:])
    hs2 = np.asarray(Image.open(io.BytesIO(z2.read('tex_hs.jpg'))).convert('L'))
    ok('LiDAR hillshade blanked outside', np.ptp(hs2[:6, -6:]) < 12)

print(f'{passes} passed, {len(fails)} failed')
sys.exit(1 if fails else 0)
