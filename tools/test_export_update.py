#!/usr/bin/env python3
"""
Updating a phone map with only what changed: the manifest every export carries, the update package
(export_update.py), the rules it is applied by (export_update.apply_update, and the phone's own code,
android/.../MapUpdate.kt, compiled and run here when a Kotlin compiler is at hand). No PDAL, no network.

  * every export zip has manifest.json: its data files with size and sha256 (never viewer.html or libs/), a map id
    that stays the same across exports, the export time, a hash over the file list;
  * two exports of the same inputs, made at different times, differ only in caves.json's export time: "nothing
    changed", no package; which big files are the same bytes is printed;
  * an update of each kind carries only what changed: marks only, surface features only, ridgewalking re-made, a
    picture, a file removed; mostly changed says so;
  * applying: the result is the new map, file for file; a wrong base, a map without a manifest, a damaged or cut
    package are refused with a plain message and nothing changes; a stop half way leaves the old map whole.

    python tools/test_export_update.py
"""
import glob, io, json, math, os, shutil, subprocess, sys, tempfile, time, zipfile
from pathlib import Path
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, ROOT)
import numpy as np
from PIL import Image
import export_terrain as et
import export_update as xu
import viewer_inline as vi

T0 = time.time()
fails = passes = 0
def check(label, ok, detail=''):
    global fails, passes
    if ok:
        passes += 1
    else:
        fails += 1
        print('FAIL', label, str(detail)[:700])

LAT, LON = 45.1234, -100.5678                      # the project's example place
BIG = ['terrain.glb', 'tex_sat.jpg', 'tex_hs.jpg', 'tex_hsb.jpg', 'tex_slope.jpg', 'ridge_shapes.bin', 'ridge_points.bin', 'ridge_patches.bin']

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    def demo(name, extra=()):
        d = tmp / name
        r = subprocess.run([sys.executable, os.path.join(ROOT, 'ridgewalk.py'), '--demo', str(d), '--workers', '1', *extra], capture_output=True, text=True)
        assert r.returncode == 0, r.stdout[-300:] + r.stderr[-300:]
        E0, N0, _z = et.latlon_to_utm(LAT, LON, 14)
        E0, N0 = math.floor(E0) - 96.0, math.floor(N0) - 72.0
        m = json.loads((d / 'ridge.json').read_text()); m.update(epsg=32614, zone=14, south=False, origin=[E0, N0]); (d / 'ridge.json').write_text(json.dumps(m))
        return d, E0, N0
    rdir, E0, N0 = demo('rw')
    rdir2, _, _ = demo('rw2', ['--min-behind', '0.5'])
    et.fetch_ept_points = lambda *a, **k: (_ for _ in ()).throw(AssertionError('no point cloud may be read'))
    et.get_viewer_libs = lambda progress=print: vi.local_viewer_libs()
    SAT = [(90, 110, 80)]
    et.fetch_satellite_texture = lambda grid, tex_size=8192, source='esri', progress=print: Image.new('RGB', grid.tex_dims(tex_size), SAT[0])
    if et.pygltflib is None:
        et.export_glb = lambda vertices, faces, uvs, out_path, progress=print: Path(out_path).write_bytes(b'glb')
    lat0, lon0 = et.utm_to_latlon(np.array([E0, E0 + 192.0]), np.array([N0, N0 + 144.0]), 14, False)
    BBOX = (float(lon0[0]), float(lat0[0]), float(lon0[1]), float(lat0[1]))
    CLOCK = [1795000000]
    def run(name, extra=(), ridge=None, map_id='area-a1'):
        out = tmp / name
        CLOCK[0] += 3600; os.environ['SOURCE_DATE_EPOCH'] = str(CLOCK[0])          # every export an hour after the one before
        argv, so = sys.argv, sys.stdout
        sys.argv = ['export_terrain.py', '--bbox', *map(str, BBOX), '--out', str(out), '--name', 'Cave Ridge', '--max-triangles', '30000', '--tex-size', '512',
                    '--ridgewalk-dir', str(ridge or rdir), '--slope-map', '--manifest-out', str(out) + '.manifest.json', *(['--map-id', map_id] if map_id else []), *extra]
        log = io.StringIO()
        try:
            sys.stdout = log
            et.main()
        except SystemExit as ex:
            log.write(f'EXIT {ex}')
        finally:
            sys.stdout, sys.argv = so, argv
        assert out.exists() and 'EXIT' not in log.getvalue(), log.getvalue()[-600:]
        return out
    feats = lambda n: {'version': 1, 'folders': [{'id': 'g1', 'name': 'Entrances'}], 'items': [{'id': 'it%d' % i, 'kind': 'point', 'name': 'Pit %d' % i, 'folder': 'g1', 'colour': '#ffcc00', 'symbol': 'dot', 'width': 2, 'opacity': 1, 'lonlat': [[LON + i * 1e-5, LAT]]} for i in range(n)]}
    (tmp / 'f1.json').write_text(json.dumps(feats(3))); (tmp / 'f2.json').write_text(json.dumps(feats(5)))
    (tmp / 'marks.json').write_text(json.dumps({'marks': [{'id': 'm1', 'kind': 'cave', 'note': 'Goes', 'lon': LON, 'lat': LAT, 'who': 'Ana', 't': '2026-11-20T10:00:00.000Z'},
                                                         {'id': 'm2', 'kind': 'nothing', 'lon': LON + 1e-4, 'lat': LAT, 'who': 'Bo', 't': '2026-11-21T10:00:00.000Z'}]}))
    F1 = ['--features', str(tmp / 'f1.json')]

    # ── 1. The manifest ───────────────────────────────────────────────────────
    A = run('a.zip', F1)
    za = zipfile.ZipFile(A); names = za.namelist()
    MA = json.loads(za.read('manifest.json'))
    data = sorted(n for n in names if xu.is_data(n))
    check('every export has manifest.json: format 1, a map, its name, the export time', MA['format'] == 1 and MA['kind'] == 'map' and MA['name'] == 'Cave Ridge' and MA['exported'] == json.loads(za.read('caves.json'))['meta']['about']['exported'], {k: MA[k] for k in ('format', 'kind', 'name', 'exported')})
    check('it lists the data files and only them: no viewer.html, nothing of libs/, not itself', sorted(MA['files']) == data and 'viewer.html' not in MA['files'] and 'viewer.html' in names and not any('/' in n for n in MA['files']) and 'manifest.json' not in MA['files']
          and {'terrain.glb', 'tex_sat.jpg', 'tex_hs.jpg', 'tex_hsb.jpg', 'tex_slope.jpg', 'caves.json', 'ridge_points.bin', 'ridge_shapes.bin', 'features.json'} <= set(data), data)
    import hashlib
    check('each with its size and sha256', all(MA['files'][n] == dict({'size': len(za.read(n)), 'sha256': hashlib.sha256(za.read(n)).hexdigest()}, **({'content': MA['files'][n].get('content')} if n == 'caves.json' else {})) for n in data))
    check('files_hash is the hash over the file list; the manifest checks out', MA['files_hash'] == xu.files_hash(MA['files']) and xu.valid(MA) and MA['bytes'] == sum(f['size'] for f in MA['files'].values()))
    check('--manifest-out writes the same manifest beside the zip', json.loads(Path(str(A) + '.manifest.json').read_text()) == MA)
    check('the map id is the one given', MA['map_id'] == 'area-a1')
    N1 = run('n1.zip', F1, map_id=''); N2 = run('n2.zip', F1, map_id='')
    check('without one it is made from the name: the same for every export of that name', xu.read_manifest(N1)['map_id'] == xu.read_manifest(N2)['map_id'] == xu.map_id_of(' cave ridge ') and xu.map_id_of('Other') != xu.map_id_of('Cave Ridge'))
    bad = json.loads(json.dumps(MA)); bad['files']['tex_sat.jpg']['size'] += 1
    check('a manifest whose list was touched does not check out', not xu.valid(bad) and not xu.valid({}) and not xu.valid(None))

    # ── 2. The same inputs again, an hour later ───────────────────────────────
    A2 = run('a2.zip', F1)
    M2 = xu.read_manifest(A2)
    differ = sorted(n for n in MA['files'] if MA['files'][n]['sha256'] != M2['files'][n]['sha256'])
    stable = [n for n in BIG if n in MA['files'] and n not in differ]
    print('  same bytes in two exports of the same inputs: %s' % ', '.join(sorted(set(MA['files']) - set(differ))))
    print('  differ: %s' % (', '.join(differ) or 'none'))
    check('two exports of the same inputs: every big file is the same bytes', stable == [n for n in BIG if n in MA['files']], differ)
    check('…only caves.json differs (it holds the export time), and without that time it is the same', differ == ['caves.json'] and MA['files']['caves.json']['content'] == M2['files']['caves.json']['content'] and MA['exported'] != M2['exported'], differ)
    s = xu.make_update(MA, str(A2), str(tmp / 'u_same.zip'))
    check('nothing changed: said so, and no package is written', s['same'] is True and s['bytes'] == 0 and not (tmp / 'u_same.zip').exists() and s['add'] == s['replace'] == s['remove'] == [], s)

    # ── 3. An update of each kind ─────────────────────────────────────────────
    def upd(name, base_m, new_zip):
        out = tmp / name
        s = xu.make_update(base_m, str(new_zip), str(out))
        z = zipfile.ZipFile(out) if out.exists() else None
        return s, z, out
    B = run('b.zip', F1 + ['--ridge-marks', str(tmp / 'marks.json')]); MB = xu.read_manifest(B)
    s, z, UB = upd('u_marks.zip', MA, B)
    check('marks only: the marks, ridge.json (it names them) and caves.json; nothing big', s['add'] == ['ridge_marks.json'] and s['replace'] == ['caves.json', 'ridge.json'] and s['remove'] == [] and not s['mostly'] and s['share'] < 0.2, s)
    check('…the package: update.json first, then exactly those files; no viewer.html, no manifest of its own', z.namelist() == ['update.json', 'ridge_marks.json', 'caves.json', 'ridge.json'], z.namelist())
    U = json.loads(z.read('update.json'))
    check('update.json: format, the map id, the base it was made against, the whole new manifest, the lists', U['format'] == 1 and U['kind'] == 'update' and U['map_id'] == 'area-a1' and U['name'] == 'Cave Ridge' and U['base'] == {'files_hash': MA['files_hash'], 'exported': MA['exported']}
          and U['manifest'] == MB and U['add'] == s['add'] and U['replace'] == s['replace'] and U['remove'] == [], {k: U[k] for k in ('base', 'add', 'replace', 'remove')})
    check('…its files are the new map\'s bytes; the sizes are told (update against full)', all(z.read(n) == zipfile.ZipFile(B).read(n) for n in s['add'] + s['replace']) and s['package_bytes'] == UB.stat().st_size and s['full_bytes'] == B.stat().st_size and s['package_bytes'] * 5 < s['full_bytes'], (s['package_bytes'], s['full_bytes']))
    C = run('c.zip', ['--features', str(tmp / 'f2.json')])
    s, z, UC = upd('u_feat.zip', MA, C)
    check('surface features only: features.json and caves.json', s['add'] == [] and s['replace'] == ['caves.json', 'features.json'] and s['remove'] == [], s)
    D = run('d.zip', F1, ridge=rdir2)
    s, z, UD = upd('u_ridge.zip', MA, D)
    check('ridgewalking re-made: its points, shapes and list go; the aerial picture does not', {'ridge_points.bin', 'ridge_shapes.bin', 'ridge_features.json', 'ridge.json', 'caves.json'} <= set(s['replace']) and 'tex_sat.jpg' not in s['replace'] and 'features.json' not in s['replace'], s['replace'])
    SAT[0] = (120, 90, 60)
    E = run('e.zip', F1)
    SAT[0] = (90, 110, 80)
    s, z, UE = upd('u_pic.zip', MA, E)
    check('another aerial picture: tex_sat.jpg and caves.json, stored as it is', s['replace'] == ['caves.json', 'tex_sat.jpg'] and z.getinfo('tex_sat.jpg').compress_type == zipfile.ZIP_STORED and z.getinfo('caves.json').compress_type == zipfile.ZIP_DEFLATED, s['replace'])
    G = run('g.zip', [])
    s, z, UG = upd('u_gone.zip', MA, G)
    check('surface features no longer carried: features.json is removed (and is not in the package)', s['remove'] == ['features.json'] and 'features.json' not in z.namelist() and 'features.json' not in json.loads(z.read('update.json'))['manifest']['files'], s)
    small = json.loads(json.dumps(MA)); small['files'] = {'caves.json': MA['files']['caves.json']}; small['files_hash'] = xu.files_hash(small['files'])
    s, z, UM = upd('u_most.zip', small, A2)
    check('mostly changed (over 80 % of the bytes): the package is made and says a full map is as good', s['mostly'] is True and s['share'] > 0.8 and UM.exists(), s['share'])
    try:
        xu.make_update({'format': 1, 'files': {}}, str(B), str(tmp / 'x.zip')); r = 'made'
    except ValueError as ex:
        r = str(ex)
    check('an earlier map without a usable manifest: no update can be made from it', r == 'the earlier map has no usable manifest' and not (tmp / 'x.zip').exists(), r)
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'export_update.py'), 'update', '--base', str(A) + '.manifest.json', '--new', str(B), '--out', str(tmp / 'cli.zip')], capture_output=True, text=True)
    check('the command line gives the same summary as JSON', r.returncode == 0 and json.loads(r.stdout)['replace'] == ['caves.json', 'ridge.json'] and zipfile.ZipFile(tmp / 'cli.zip').read('update.json') == zipfile.ZipFile(UB).read('update.json'), r.stdout[:200] + r.stderr[:200])

    # ── 4. Applying: the reference rules, then the phone's own code ───────────
    def unpack(zip_path, d, manifest=True):
        d = Path(d); shutil.rmtree(d, ignore_errors=True); d.mkdir(parents=True)
        with zipfile.ZipFile(zip_path) as zz:
            for n in zz.namelist():
                if xu.is_data(n) or (manifest and n == 'manifest.json'):
                    (d / n).write_bytes(zz.read(n))
        return d
    def state(d):
        return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(Path(d).iterdir()) if p.name not in ('manifest.json', 'map_version.json')}
    def want(zip_path):
        m = xu.read_manifest(zip_path); return {n: f['sha256'] for n, f in m['files'].items()}
    cut = tmp / 'u_cut.zip'; cut.write_bytes(UD.read_bytes()[:UD.stat().st_size // 2])
    wrong = tmp / 'u_wrongfile.zip'
    with zipfile.ZipFile(UB) as src, zipfile.ZipFile(wrong, 'w') as dst:
        for n in src.namelist():
            dst.writestr(n, src.read(n) if n != 'ridge_marks.json' else b'{"version":1,"marks":[]}')
    missing = tmp / 'u_missing.zip'
    with zipfile.ZipFile(UB) as src, zipfile.ZipFile(missing, 'w') as dst:
        for n in src.namelist():
            if n != 'ridge.json': dst.writestr(n, src.read(n))

    def py_apply(d, z, fail_after=None):
        try:
            r = xu.apply_update(str(d), str(z), fail_after=fail_after); return 'OK %s %s %d %d %d' % (r['from'], r['to'], r['added'], r['replaced'], r['removed'])
        except xu.Refused as ex:
            return 'REFUSED ' + str(ex)
        except KeyboardInterrupt:
            return 'STOPPED'
    def py_recover(d): xu.recover(str(d)); return 'OK'

    # the phone's code, compiled here when the Kotlin compiler that comes with Gradle and a JDK are at hand
    kt = None
    gl = sorted(glob.glob(os.path.expanduser('~/.gradle/wrapper/dists/gradle-*/*/gradle-*/lib')))
    java = os.path.join(os.environ.get('JAVA_HOME') or os.path.expanduser('~/opt/jdk17'), 'bin', 'java')
    if gl and os.path.exists(java) and glob.glob(gl[-1] + '/kotlin-compiler-embeddable-*.jar'):
        std = glob.glob(gl[-1] + '/kotlin-stdlib-[0-9]*.jar')[0]; ko = tmp / 'kt'
        r = subprocess.run([java, '-cp', gl[-1] + '/*', 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-nowarn', '-cp', std, '-d', str(ko),
                            os.path.join(ROOT, 'android/app/src/main/java/com/feroz/flexviewer/MapUpdate.kt'), os.path.join(ROOT, 'tools/flexfield_tests/MapUpdateMain.kt')], capture_output=True, text=True)
        check('MapUpdate.kt compiles on its own (plain Kotlin, no Android)', r.returncode == 0 and (ko / 'MapUpdateMainKt.class').exists(), r.stdout[-600:] + r.stderr[-600:])
        if r.returncode == 0:
            kcall = lambda *a: subprocess.run([java, '-cp', '%s:%s' % (ko, std), 'MapUpdateMainKt', *map(str, a)], capture_output=True, text=True).stdout.strip() or 'NO OUTPUT'
            kt = (lambda d, z, fail_after=None: kcall('apply', d, z, *([fail_after] if fail_after is not None else [])), lambda d: kcall('recover', d))
            check('the phone tells an update from a map by the zip\'s first entry', kcall('peek', UB) == 'UPDATE area-a1 Cave Ridge' and kcall('peek', A) == 'NOT' and kcall('peek', cut).startswith('UPDATE'), [kcall('peek', UB), kcall('peek', A)])
    else:
        print('  (no Kotlin compiler here: the phone\'s own apply code is not run, only the reference rules)')

    for who, (apply, recover) in [('rules', (py_apply, py_recover))] + ([('phone code', kt)] if kt else []):
        L = lambda t: '%s: %s' % (who, t)
        d = unpack(A, tmp / ('m_' + who.replace(' ', '')) / 'export')
        r = apply(d, UB)
        check(L('marks update applied: the map is the new map, file for file'), r == 'OK %s %s 1 2 0' % (MA['exported'], MB['exported']) and state(d) == want(B) and json.loads((d / 'manifest.json').read_text())['files_hash'] == MB['files_hash'], r)
        check(L('nothing is left beside it'), sorted(p.name for p in d.parent.iterdir()) == ['export'], sorted(p.name for p in d.parent.iterdir()))
        r = apply(d, UB)
        check(L('the same update a second time is refused: the map is no longer its base'), r.startswith('REFUSED This update was made for another version of this map (%s); the map here is %s.' % (MA['exported'], MB['exported'])) and state(d) == want(B), r)
        d = unpack(A, tmp / ('m_' + who.replace(' ', '')) / 'export')
        for z, label, nm in ((UC, 'features', C), (None, None, None)):
            if z: check(L('%s update applied' % label), apply(d, z).startswith('OK') and state(d) == want(nm))
        d = unpack(A, d)
        check(L('ridgewalking update applied'), apply(d, UD).startswith('OK') and state(d) == want(D))
        d = unpack(A, d)
        check(L('picture update applied'), apply(d, UE).startswith('OK') and state(d) == want(E))
        d = unpack(A, d)
        r = apply(d, UG)
        check(L('an update that removes a file: it is gone afterwards'), r.endswith(' 0 1 1') and state(d) == want(G) and not (d / 'features.json').exists(), r)
        # chained: A -> B, then an update made against B
        d = unpack(A, d); apply(d, UB)
        sBD = xu.make_update(MB, str(D), str(tmp / 'u_bd.zip'))
        check(L('a second update, made against the updated map, applies on top'), apply(d, tmp / 'u_bd.zip').startswith('OK') and state(d) == want(D) and 'ridge_marks.json' in sBD['remove'], sBD['remove'])
        # refusals: nothing changes
        d = unpack(C, d); before = state(d)
        r = apply(d, UB)
        check(L('wrong base (another version of the map): refused in plain words, nothing changed'), r.startswith('REFUSED This update was made for another version') and state(d) == before and sorted(p.name for p in d.parent.iterdir()) == ['export'], r)
        d = unpack(A, d, manifest=False); before = state(d)
        r = apply(d, UB)
        check(L('a map from before manifests: "needs the full map once", nothing changed'), r == 'REFUSED ' + xu.NEEDS_FULL and state(d) == before, r)
        d = unpack(A, d); before = state(d)
        r = apply(d, wrong)
        check(L('a file that is not what the update says: refused, nothing changed'), r == 'REFUSED ' + xu.CORRUPT % 'ridge_marks.json is not what the update says' and state(d) == before and sorted(p.name for p in d.parent.iterdir()) == ['export'], r)
        r = apply(d, missing)
        check(L('a file missing from the package: refused, nothing changed'), r == 'REFUSED ' + xu.CORRUPT % 'ridge.json is missing' and state(d) == before, r)
        r = apply(d, cut)
        check(L('a package cut in half: refused, nothing changed'), r.startswith('REFUSED The update is damaged') and state(d) == before and sorted(p.name for p in d.parent.iterdir()) == ['export'], r)
        r = apply(d, A)
        check(L('a full map is not an update'), r == 'REFUSED This zip is not an update.' and state(d) == before, r)
        (d / 'tex_hs.jpg').write_bytes(b'not the picture')
        r = apply(d, UB)
        check(L('a map whose own file is not what its manifest says: refused (the full map is needed)'), r.startswith('REFUSED This update was made for another version') and 'tex_hs.jpg' in r, r)
        # stopped half way
        d = unpack(A, d); before = state(d)
        r = apply(d, UD, 3)
        check(L('stopped half way: the old map is whole'), r == 'STOPPED' and state(d) == before and (d.parent / 'export.new').exists(), r)
        recover(d)
        check(L('…tidied at the next start; the update then applies'), sorted(p.name for p in d.parent.iterdir()) == ['export'] and state(d) == before and apply(d, UD).startswith('OK') and state(d) == want(D))
        os.rename(d, str(d) + '.old'); os.makedirs(str(d) + '.new')
        recover(d)
        check(L('stopped between the two renames: the old map comes back'), sorted(p.name for p in d.parent.iterdir()) == ['export'] and state(d) == want(D))
    if kt:
        d = unpack(A, tmp / 'm_ver' / 'export'); kt[0](d, UB); v1 = json.loads((d / 'map_version.json').read_text())
        kt[0](d, tmp / 'u_bd.zip'); v2 = json.loads((d / 'map_version.json').read_text())
        check('phone code: the map remembers what it was updated from (for About this map)', v1 == {'exported': MB['exported'], 'updated_from': MA['exported'], 'updates': 1, 'first': MA['exported']}
              and v2['updated_from'] == MB['exported'] and v2['updates'] == 2 and v2['first'] == MA['exported'] and v2['exported'] == xu.read_manifest(D)['exported'], [v1, v2])

dt = time.time() - T0
print('%d passed, %d failed (%.1f s)' % (passes, fails, dt))
sys.exit(1 if fails else 0)
