#!/usr/bin/env python3
"""
route_cost.py on synthetic clouds (numpy only, no PDAL, no network).

    python tools/test_route_cost.py

Scenes are made-up points around the documentation example (45.1234,
-100.5678) at 1 m cells. Pins down:
  * the cloth from below keeps a cliff top (export_terrain.build_dem sinks it);
  * cliff weight 0 detours round a cliff band; weight 1 crosses it when the
    detour is long; a blocked straight line makes the corridor grow;
  * least_brush goes round a brush patch that a brush-blind route crosses;
  * a trail is followed at trail = 1 and ignored at trail = 0;
  * canopy and terrain shadows lower sun, and the shadiest route has less sun;
  * a second run with other weights / starts reuses the grids untouched;
  * dem both writes ground_above.npy, dem_diff.png and the comparison;
  * every time breakdown sums to time_min; routes.geojson has the contract's
    shape; the CLI prints ASCII and '! ' errors.
"""
import contextlib, io, json, math, os, shutil, sys, tempfile, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import numpy as np
import route_cost as rc
import lidar_derive as ld

fails = 0
passes = 0


def check(label, ok, detail=''):
    global fails, passes
    if ok:
        passes += 1
    else:
        fails += 1
        print('FAIL', label, detail)


T0 = time.time()
TMP = tempfile.mkdtemp(prefix='route_cost_test_')
QUIET = lambda m: None
ALL_FEATURES = []


def run(name, params, out=None):
    out = out or os.path.join(TMP, name)
    s = rc.run(params, out, say=QUIET)
    with open(os.path.join(out, 'routes.geojson')) as f:
        fc = json.load(f)
    ALL_FEATURES.extend(fc['features'])
    return s, fc, out


def route(fc, option='recommended', start=0):
    for f in fc['features']:
        p = f['properties']
        if p['option'] == option and p['start_index'] == start:
            return f
    return None


def local_xy(feature):
    """Route vertices back to scene-local metres."""
    import export_terrain as et
    e0, n0, zone = rc.example_origin()
    out = []
    for lon, lat, _ in feature['geometry']['coordinates']:
        e, n, _ = et.latlon_to_utm(lat, lon, zone)
        out.append((e - e0, n - n0))
    return np.array(out)


def densify(xy, step=0.5):
    pts = [xy[0]]
    for a, b in zip(xy[:-1], xy[1:]):
        n = max(1, int(np.hypot(*(b - a)) / step))
        for t in np.arange(1, n + 1) / n:
            pts.append(a + (b - a) * t)
    return np.array(pts)


def base_params(npz, W, H, end, starts, **kw):
    p = {'source': {'npz': npz}, 'end': rc.local_lonlat(*end),
         'starts': [rc.local_lonlat(*s) for s in starts], 'cell': 1.0,
         'dem': 'below', 'brush_band': [0.5, 2.0],
         'weights': dict(rc.DEFAULT_WEIGHTS), 'corridor_m': 80,
         'presets': [], 'units': 'm', 'area_bbox_utm': rc.local_bbox(0, 0, W, H)}
    p.update(kw)
    return p


# ---------------------------------------------------------------- functions
check('auto cell ~8 ground returns per cell', rc.auto_cell(8_000_000, 1e6) == 1.0)
check('auto cell clamps to 0.25 m', rc.auto_cell(10**9, 1e6) == 0.25)
check('auto cell clamps to 2 m', rc.auto_cell(1000, 1e6) == 2.0)
check('brush curve gentle at low fractions', rc.brush_g(0.1) < 0.05 and rc.brush_g(0.2) < 0.15)
check('brush curve steep at high fractions', rc.brush_g(0.6) > 1.5 and rc.brush_g(0.8) > 3)
check('steep cost 0 on the flat', abs(float(rc.steep_f(np.array(0.0)))) < 1e-9)
check('steep cost rises with grade', rc.steep_f(np.array(0.6)) > rc.steep_f(np.array(0.3)) > 1)

# The cloth keeps a 10 m cliff top; export_terrain.build_dem sinks it.
xs = np.arange(200) + 0.5
step = np.where(xs < 100, 10.0, 0.0)[None, :].repeat(40, 0)
cb = rc.cloth_below(step.astype(np.float32), 1.0)
err = np.abs(cb[20] - step[20])
check('cloth from below: top within 0.5 m beyond 4 m of the edge',
      err[:96].max() < 0.5, f'max {err[:96].max():.2f}')
ca = rc.cloth_above(step.astype(np.float32), step.astype(np.float32), 1.0)
ea = np.abs(ca - step)[20]
check('cloth from above rests on the flats (fills only the cliff foot)',
      ea[:100].max() < 0.01 and ea[105:].max() < 0.01 and ea[100] > 0.5, ea[98:106])
pit = np.zeros((60, 60), np.float32); pit[29:31, 29:31] = -5
check('cloth from above bridges a 2 m pit',
      rc.cloth_above(pit, pit, 1.0)[30, 30] > -1.5)
check('cloth from below keeps the 2 m pit', rc.cloth_below(pit, 1.0)[30, 30] < -4.5)

# Terrain shadow: a 10 m wall, high to the south, at 45 N (sun 45 deg up).
wall = np.zeros((60, 20), np.float32); wall[30:] = 10.0
lit = rc.terrain_lit(wall, 1.0, 45.0)
check('terrain shadow: 5 m north of a 10 m wall is shaded', not lit[25, 10])
check('terrain shadow: 15 m north of it is lit', lit[15, 10])
check('terrain shadow: the wall top is lit', lit[40, 10])
lit_s = rc.terrain_lit(wall[::-1].copy(), 1.0, -45.0)
check('terrain shadow: southern hemisphere falls south', not lit_s[34, 10] and lit_s[44, 10])

# ---------------------------------------------------------------- cliff scene
W, H = 240.0, 200.0
x, y, z, c = rc.synth_cloud(W, H, rc.cliff_scene_z(170.0), density=4.0, seed=3)
npz_a = rc.write_npz(os.path.join(TMP, 'cliff.npz'), x, y, z, c)
pa = base_params(npz_a, W, H, (210, 40), [(30, 40)], dem='both', corridor_m=30)
pa['weights']['cliff'] = 0.0
sA, fcA, outA = run('cliff', pa)
gA = os.path.join(outA, 'grids')
rA = route(fcA)
check('cliff 0: a route is found', rA is not None)
if rA:
    st = rA['properties']['stats']
    check('cliff 0: no cliff cells on the route', st['cliff_cells'] == 0, st)
    check('cliff 0: detours north round the band',
          local_xy(rA)[:, 1].max() > 160, local_xy(rA)[:, 1].max())
check('blocked straight line: corridor grew', sA['corridor_grew'] >= 1, sA['corridor_grew'])
cliff = np.load(os.path.join(gA, 'cliff.npy'))
check('cliff band detected', cliff[50:195, 95:106].any(axis=1).mean() > 0.9)
check('cliff band ends where the ramp starts', not cliff[:15, :].any())
check('no cliffs on the open slope', not cliff[:, :80].any() and not cliff[:, 125:].any())

# dem both
for f in ('ground.npy', 'ground_above.npy', 'dem_diff.png', 'slope.npy', 'cliff.npy',
          'brush.npy', 'shade.npy', 'trail.npy', 'grid.json', 'brush.png', 'slope.png',
          'shade.png', 'ground_hs.png'):
    check(f'grids/{f} written', os.path.exists(os.path.join(gA, f)))
dc = sA.get('dem_compare') or {}
check('dem both: comparison in summary',
      all(k in dc for k in ('mean_abs_m', 'p95_abs_m', 'max_abs_m', 'max_at_lonlat')), dc)
gj = json.load(open(os.path.join(gA, 'grid.json')))
check('grid.json fields', all(k in gj for k in ('minx', 'maxx', 'miny', 'maxy', 'cell',
                                                  'nx', 'ny', 'epsg', 'bounds_lonlat')))
check('grid.json corners', len(gj['bounds_lonlat']) == 4 and
      abs(gj['bounds_lonlat'][0][1] - 45.12) < 0.05)

# Cache: other weights, a moved start, dem below -> same grids, untouched.
mt = {f: os.path.getmtime(os.path.join(gA, f)) for f in os.listdir(gA) if f != 'trail.npy'}
time.sleep(0.05)
pa2 = dict(pa, weights=dict(pa['weights'], cliff=1.0), dem='below',
           starts=[rc.local_lonlat(25, 45)], corridor_m=80)
sA2, fcA2, _ = run('cliff', pa2, out=outA)
check('cache: grids reused', sA2['grid_reused'] and sA2['grid_cache_key'] == sA['grid_cache_key'])
check('cache: no grid file touched',
      all(os.path.getmtime(os.path.join(gA, f)) == t for f, t in mt.items()))
rA2 = route(fcA2)
if rA2:
    st2 = rA2['properties']['stats']
    check('cliff 1: crosses the band when the detour is long', st2['cliff_cells'] > 0, st2)
    check('cliff 1: shorter than the detour', st2['length_m'] < rA['properties']['stats']['length_m'])
    check('cliff 1: warning names the cliff band',
          any('cliff band' in w for w in rA2['properties']['warnings']))
else:
    check('cliff 1: a route is found', False)

# Start lines: every cell of a road is a start; the cheapest wins.
def road(*pts, kind='road', name=''):
    return {'type': 'Feature', 'properties': {'kind': kind, 'name': name},
            'geometry': {'type': 'LineString',
                         'coordinates': [rc.local_lonlat(*p) for p in pts]}}


pl = dict(pa, starts=[], corridor_m=40,
          start_lines={'type': 'FeatureCollection', 'features': [
              road((10, 5), (10, 195), name='West road')]})
sL, fcL, _ = run('cliff', pl, out=outA)
rL = route(fcL, start=0)
check('start line: grids reused', sL['grid_reused'])
check('start line: a route from the road', rL is not None and
      rL['properties']['start_kind'] == 'line' and rL['properties']['best'])
if rL:
    import export_terrain as et
    e0, n0, zone = rc.example_origin()
    lon, lat = rL['properties']['start_lonlat']
    ex, ny_, _ = et.latlon_to_utm(lat, lon, zone)
    check('start line: leaves the road near the cliff gap (north)',
          ny_ - n0 > 130 and abs(ex - e0 - 10) < 4, (ex - e0, ny_ - n0))
    check('start line: label names the road', 'West road' in rL['properties']['label'])
pl2 = dict(pl, start_lines={'type': 'FeatureCollection', 'features': [
    road((10, 5), (10, 195), name='West road'), road((150, 3), (238, 3), name='East road')]})
_, fcL2, _ = run('cliff', pl2, out=outA)
best = [f for f in fcL2['features'] if f['properties'].get('best')]
check('two start lines: the near one is best', len(best) == 1 and
      best[0]['properties']['start_name'] == 'East road')
check('two start lines: the far road (over 1.5x) is not offered',
      not any(f['properties'].get('start_name') == 'West road' for f in fcL2['features']))

# Shared cache dir: a new OUTDIR finds the grid set by its key.
cache = os.path.join(TMP, 'cache')
s1, _, _ = run('cacheA', dict(pa2), out=os.path.join(TMP, 'cA'))  # writes cA/grids
rc.run(pa2, os.path.join(TMP, 'cB'), cache_dir=cache, say=QUIET)  # builds into cache
sC = rc.run(pa2, os.path.join(TMP, 'cC'), cache_dir=cache, say=QUIET)
check('cache dir: a fresh OUTDIR reuses the cached set', sC['grid_reused'])
check('cache dir: OUTDIR/grids filled', os.path.exists(os.path.join(TMP, 'cC', 'grids', 'ground.npy')))
pa3 = dict(pa2, brush_band=[0.3, 1.5])
sD = rc.run(pa3, os.path.join(TMP, 'cD'), cache_dir=cache, say=QUIET)
check('cache: another brush band rebuilds', not sD['grid_reused'])

# dem_method export: export_terrain.build_dem as Generate uses it, cached apart.
pe = dict(pa, dem='below', dem_method='export')
sE, _, outE = run('cliff_export', pe)
check('dem_method export: own cache key', sE['grid_cache_key'] != sA['grid_cache_key'])
g_csf = np.load(os.path.join(gA, 'ground.npy'))
g_exp = np.load(os.path.join(outE, 'grids', 'ground.npy'))
check('dem_method export: same grid', g_csf.shape == g_exp.shape)
top = np.abs(g_exp[60:150, 92:99] - g_csf[60:150, 92:99]).max()
check('dem_method export: build_dem sinks the cliff top (> 1 m)', top > 1.0, top)
check('cloth csf vs export agree away from the cliff',
      np.abs(g_exp[60:150, 20:60] - g_csf[60:150, 20:60]).max() < 0.3)

# Cache pruning keeps the newest sets.
pc_dir = os.path.join(TMP, 'prune')
os.makedirs(pc_dir)
for i in range(4):
    d = os.path.join(pc_dir, f'k{i}'); os.makedirs(d)
    open(os.path.join(d, 'grid.json'), 'w').write('{}')
    os.utime(d, (1000 + i, 1000 + i))
rc.prune_cache(pc_dir, keep=2, say=QUIET)
check('cache prune keeps the newest', sorted(os.listdir(pc_dir)) == ['k2', 'k3'])

# ---------------------------------------------------------------- brush scene
W, H = 200.0, 140.0
x, y, z, c = rc.synth_cloud(W, H, lambda x, y: 100 + 0.02 * x, density=4.0,
                            brush=[(60, 15, 140, 125, 0.6)], seed=4)
npz_b = rc.write_npz(os.path.join(TMP, 'brush.npz'), x, y, z, c)
pb = base_params(npz_b, W, H, (185, 70), [(15, 70)], presets=['least_brush'])
pb['weights']['brush'] = 0.0
sB, fcB, outB = run('brush', pb)
br = np.load(os.path.join(outB, 'grids', 'brush.npy'))
check('brush grid: patch ~0.6, open ground ~0', br[70, 100] > 0.45 and br[70, 20] < 0.05,
      (br[70, 100], br[70, 20]))


def frac_in_patch(f):
    p = densify(local_xy(f))
    inside = (p[:, 0] > 62) & (p[:, 0] < 138) & (p[:, 1] > 17) & (p[:, 1] < 123)
    return inside.mean()


rB, lB = route(fcB), route(fcB, 'least_brush')
check('brush-blind route crosses the patch', rB and frac_in_patch(rB) > 0.3)
check('least_brush is offered', lB is not None)
if lB:
    check('least_brush goes round the patch', frac_in_patch(lB) < 0.03, frac_in_patch(lB))
    check('least_brush has less brush',
          lB['properties']['stats']['brush_pct'] < rB['properties']['stats']['brush_pct'])
    check('least_brush is longer', lB['properties']['stats']['length_m'] >
          rB['properties']['stats']['length_m'])
pb2 = dict(pb, weights=dict(pb['weights'], brush=1.0))
_, fcB2, _ = run('brush', pb2, out=outB)
check('brush 1: the recommended route avoids the patch too',
      frac_in_patch(route(fcB2)) < 0.03)
check('brush 1: least_brush same as recommended -> not repeated',
      route(fcB2, 'least_brush') is None)

# ---------------------------------------------------------------- trail scene
W, H = 240.0, 160.0
x, y, z, c = rc.synth_cloud(W, H, lambda x, y: 100 + 0 * x, density=4.0, seed=5)
npz_c = rc.write_npz(os.path.join(TMP, 'trail.npz'), x, y, z, c)
trails = {'type': 'FeatureCollection', 'features': [{
    'type': 'Feature', 'properties': {'kind': 'trail', 'name': 'Example trail'},
    'geometry': {'type': 'LineString', 'coordinates': [
        rc.local_lonlat(20, 60), rc.local_lonlat(120, 140), rc.local_lonlat(220, 60)]}}]}
pc = base_params(npz_c, W, H, (220, 60), [(20, 60)], trails=trails)
_, fcC, outC = run('trail', pc)
tr = np.load(os.path.join(outC, 'grids', 'trail.npy'))
check('trail rasterised with a buffer', tr[159 - 100, 70] == 1 and tr.sum() > 300, tr.sum())
rC = route(fcC)
check('trail 1: followed', rC['properties']['stats']['on_trail_pct'] > 75,
      rC['properties']['stats'])
check('trail 1: time on the trail in the breakdown',
      rC['properties']['stats']['time_breakdown']['trail_min'] > 0)
pc0 = dict(pc, weights=dict(pc['weights'], trail=0.0, road=0.0))
_, fcC0, _ = run('trail', pc0, out=outC)
rC0 = route(fcC0)
check('trail 0: ignored (straight line)', rC0['properties']['stats']['on_trail_pct'] < 15 and
      rC0['properties']['stats']['length_m'] < 210, rC0['properties']['stats'])
pr = dict(pc, trails={'type': 'FeatureCollection', 'features': [dict(
    trails['features'][0], properties={'kind': 'road'})]},
    weights=dict(pc['weights'], trail=0.0, road=1.0))
_, fcR, outR = run('trail', pr, out=outC)
check('road kind uses the road weight', route(fcR)['properties']['stats']['on_trail_pct'] > 75)
check('road rasterised as 2', (np.load(os.path.join(outC, 'grids', 'trail.npy')) == 2).any())

# ---------------------------------------------------------------- shade scene
W, H = 240.0, 180.0
x, y, z, c = rc.synth_cloud(W, H, lambda x, y: 100 + 0 * x, density=4.0,
                            trees=[(0, 80, 240, 130, 15.0)], seed=6)
npz_d = rc.write_npz(os.path.join(TMP, 'shade.npz'), x, y, z, c)
pd = base_params(npz_d, W, H, (220, 77), [(20, 77)], presets=['shadiest'])
pd['weights']['sun'] = 1.0
_, fcD, outD = run('shade', pd)
sun = np.load(os.path.join(outD, 'grids', 'shade.npy'))
row = lambda yy: int(H - 1 - yy)
check('sun: open ground south of the trees is lit', sun[row(40), 100] > 0.9, sun[row(40), 100])
check('sun: under the trees is shaded', sun[row(110), 100] < 0.5, sun[row(110), 100])
check('sun: 10 m north of the stand is in its shadow', sun[row(140), 100] < 0.5,
      sun[row(140), 100])
check('sun: 30 m north of the stand is lit', sun[row(160), 100] > 0.9, sun[row(160), 100])
sunny, shady = route(fcD), route(fcD, 'shadiest')
check('shadiest offered', shady is not None)
if shady:
    check('shade lowers sun_pct', shady['properties']['stats']['sun_pct'] + 30 <
          sunny['properties']['stats']['sun_pct'],
          (shady['properties']['stats']['sun_pct'], sunny['properties']['stats']['sun_pct']))

# ---------------------------------------------------------------- contract shape
STAT_KEYS = ('length_m', 'climb_m', 'descent_m', 'time_min', 'time_breakdown',
             'max_grade_pct', 'brush_pct', 'sun_pct', 'cliff_cells', 'on_trail_pct')
BD_KEYS = ('walk_min', 'climb_min', 'descent_min', 'brush_min', 'trail_min')
okshape = oksum = True
for f in ALL_FEATURES:
    p = f.get('properties', {})
    g = f.get('geometry', {})
    st = p.get('stats', {})
    good = (f.get('type') == 'Feature' and g.get('type') == 'LineString' and
            len(g.get('coordinates', [])) >= 2 and
            all(len(v) == 3 and all(math.isfinite(t) for t in v) and
                -180 <= v[0] <= 180 and -90 <= v[1] <= 90 for v in g['coordinates']) and
            all(k in p for k in ('id', 'option', 'start_index', 'label', 'stats',
                                 'warnings', 'profile')) and
            p['option'] in ('recommended', 'shortest', 'least_brush', 'shadiest',
                            'least_climb') and
            all(k in st for k in STAT_KEYS) and
            all(k in st['time_breakdown'] for k in BD_KEYS) and
            all(len(r) == 4 for r in p['profile']) and isinstance(p['warnings'], list))
    if not good:
        okshape = False
        print('  bad feature', json.dumps(f)[:300])
    if abs(sum(st['time_breakdown'].values()) - st['time_min']) > 0.051:
        oksum = False
        print('  breakdown', st)
    try:
        p['label'].encode('ascii')
    except Exception:
        okshape = False
check(f'routes.geojson features have the contract shape ({len(ALL_FEATURES)})', okshape)
check('time breakdown sums to time_min', oksum)
check('profile distance ends at the length', all(
    abs(f['properties']['profile'][-1][0] - f['properties']['stats']['length_m']) < 0.2
    for f in ALL_FEATURES))
check('summary fields', all(k in sA for k in ('cell', 'grid_cache_key', 'corridor_grew',
                                               'elapsed_s', 'counts', 'params')))

# ---------------------------------------------------------------- CLI
pfile = os.path.join(TMP, 'p.json')
json.dump(pc, open(pfile, 'w'))
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = rc.main(['--params', pfile, '--out', os.path.join(TMP, 'cli')])
txt = buf.getvalue()
check('CLI exit 0', code == 0, txt[-300:])
check('CLI progress is ASCII', all(ord(ch) < 128 for ch in txt))
check('CLI progress has steps', '[1/4]' in txt and '[4/4]' in txt)
bad = dict(pc, end=rc.local_lonlat(5000, 5000))
json.dump(bad, open(pfile, 'w'))
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = rc.main(['--params', pfile, '--out', os.path.join(TMP, 'cli_bad')])
check('CLI error: exit 1 and a "! " line', code == 1 and
      any(l.startswith('! ') for l in buf.getvalue().splitlines()), buf.getvalue()[-200:])

# demo
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = rc.main(['--demo', os.path.join(TMP, 'demo')])
check('--demo writes a case', code == 0 and os.path.exists(
    os.path.join(TMP, 'demo', 'routes.geojson')) and os.path.exists(
    os.path.join(TMP, 'demo', 'grids', 'dem_diff.png')))

shutil.rmtree(TMP, ignore_errors=True)
print(f'{passes} passed, {fails} failed ({time.time() - T0:.0f} s)')
sys.exit(1 if fails else 0)
