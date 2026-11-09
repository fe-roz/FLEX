#!/usr/bin/env python3
"""
Inventories (a chest at a station or surface point, with a dated log) in the export (no PDAL, no network):

  * convert_caves() writes caves.json `inventories`: xyz in the scene frame (a station's inventory sits where the
    station is), name, description, mode, the list text, contents with their dates, the log in order with who, action,
    items and photo references; malformed things are left out; an old payload (none) converts exactly as before;
  * a chest alone (no surveys, a surface point) is enough;
  * photos are page references (hash + type) and ride as docs_<sha>.<ext> listed in docs.json "pages", which may have
    no entries (load_docs / docs_inline_json take pages alone);
  * tools/make_synthetic_export.py --inventories builds a whole export that way.

    python tools/test_inventory_export.py
"""
import contextlib, io, json, os, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
sys.path.insert(0, ROOT)
import export_terrain as et
import viewer_inline as vi

fails = passes = 0
def check(label, ok, detail=''):
    global fails, passes
    if ok:
        passes += 1
    else:
        fails += 1
        print('FAIL', label, str(detail)[:600])

# Made-up place (Cave Ridge): lon/lat only as examples.
LON, LAT = -100.5678, 45.1234
zone = et.utm_zone_for(LON)
ce, cn, _ = et.latlon_to_utm(LAT, LON, zone)
H1, H2 = 'a' * 64, 'b' * 64

def run(payload):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, 'caves.json')
        json.dump(payload, open(p, 'w', encoding='utf-8'))
        with contextlib.redirect_stdout(io.StringIO()):
            return et.convert_caves(p, ce, cn, progress=lambda *a, **k: None, zone=zone)

inv = {'id': 'iv1', 'station': 'A2', 'cave': 'Cave Ridge', 'target': 'station:cave1:A2', 'kept': 'project', 'lon': LON + 0.0001, 'lat': LAT, 'elev': 1498.0,
       'name': 'Rope cache', 'desc': 'Blue barrel behind the boulder', 'mode': 'log', 'checked': '2026-03-02', 'stale': False,
       'contents': [{'name': 'Rope 50 m', 'qty': 3, 'changed': '2026-03-02', 'checked': '2026-03-02', 'since': '2026-03-02', 'stale': False},
                    {'name': 'Stove', 'qty': 1.5, 'changed': '2026-01-10', 'checked': '', 'since': '2026-01-10', 'stale': True}],
       'log': [{'id': 'e1', 'date': '2026-01-10', 'by': 'Ana', 'action': 'left', 'items': [{'name': 'Rope 50 m', 'qty': 2}, {'name': 'Stove', 'qty': 1.5}], 'text': 'In the barrel'},
               {'id': 'e2', 'date': '2026-03-02', 'by': 'T', 'action': 'checked', 'all': True, 'items': [{'name': 'Rope 50 m', 'qty': 3}], 'text': '',
                'photos': [{'h': H1, 'ext': 'jpg'}, {'h': 'nothex', 'ext': 'jpg'}, {'h': H2, 'ext': 'tif'}, {'h': H2, 'ext': 'png'}]},
               {'id': 'e3', 'date': '2026-04-05', 'by': '', 'action': 'bogus', 'items': [], 'text': 'Lid cracked'},
               {'date': 'no id'}, 'junk']}
surf = {'id': 'iv2', 'target': 'feature:f1', 'kept': 'mine', 'lon': LON, 'lat': LAT + 0.0002, 'elev': 1510.5, 'name': 'Dig tools', 'mode': 'list', 'list': '2 shovels\npick',
        'contents': [], 'checked': '', 'stale': True, 'log': []}
payload = {'surveys': [{'name': 'A - Cave Ridge', 'code': 'A', 'cave': 'Cave Ridge', 'color': '#00e5ff',
                        'shots': [{'from': [LON, LAT, 1500.0], 'to': [LON + 0.0001, LAT, 1498.0], 'from_name': 'A1', 'to_name': 'A2'}],
                        'stations': [{'name': 'A1', 'lon': LON, 'lat': LAT, 'elev': 1500.0}, {'name': 'A2', 'lon': LON + 0.0001, 'lat': LAT, 'elev': 1498.0}]}],
           'inventories': [inv, surf, {'name': 'no id'}, 'junk', {'id': 'iv3', 'lon': LON, 'lat': LAT, 'elev': 'x', 'mode': 'weird', 'name': 'x' * 200}]}
r = run(payload)
iv = {i['id']: i for i in r.get('inventories', [])}
check('three inventories (the one with no id is dropped)', sorted(iv) == ['iv1', 'iv2', 'iv3'], list(iv))
a = iv['iv1']
st = {s['name']: s for s in r['surveys'][0]['stations']}
check('a station\'s inventory sits at the station (scene frame, height kept)', all(abs(a['xyz'][k] - st['A2']['xyz'][k]) < 1e-6 for k in range(3)) and a['xyz'][2] == 1498.0, [a['xyz'], st['A2']['xyz']])
check('name, description, mode, station, cave, target, kept, checked', (a['name'], a['desc'], a['mode'], a['station'], a['cave'], a['target'], a['kept'], a['checked']) ==
      ('Rope cache', 'Blue barrel behind the boulder', 'log', 'A2', 'Cave Ridge', 'station:cave1:A2', 'project', '2026-03-02'), a)
check('contents with their dates and the possibly-out-of-date flag; whole numbers stay whole', a['contents'][0] == {'name': 'Rope 50 m', 'qty': 3, 'changed': '2026-03-02', 'checked': '2026-03-02', 'since': '2026-03-02', 'stale': False} and a['contents'][1]['since'] == '2026-01-10'
      and a['contents'][1]['qty'] == 1.5 and a['contents'][1]['stale'] is True and isinstance(a['contents'][0]['qty'], int), a['contents'])
check('the log is kept in order with date, who, action, items, text; bad entries are left out', [e['id'] for e in a['log']] == ['e1', 'e2', 'e3'] and a['log'][0]['by'] == 'Ana'
      and a['log'][0]['items'] == [{'name': 'Rope 50 m', 'qty': 2}, {'name': 'Stove', 'qty': 1.5}] and a['log'][0]['text'] == 'In the barrel' and a['log'][1]['all'] is True, a['log'])
check('an unknown action counts as a note', a['log'][2]['action'] == 'note' and a['log'][2]['text'] == 'Lid cracked')
check('photos: page references with a good hash and a page-image type only', a['log'][1]['photos'] == [{'h': H1, 'ext': 'jpg'}, {'h': H2, 'ext': 'png'}] and 'photos' not in a['log'][0], a['log'][1].get('photos'))
b = iv['iv2']
check('a surface point\'s inventory: target feature, no station, at its lon/lat/elev; list mode keeps its text', 'station' not in b and b['target'] == 'feature:f1' and b['mode'] == 'list' and b['list'] == '2 shovels\npick'
      and b['xyz'][2] == 1510.5 and abs(b['xyz'][1] - 0.0002 * 111000) < 40 and b['stale'] is True and b['kept'] == 'mine', b)
c = iv['iv3']
check('junk is tamed: a mode other than list is log, a bad height is 0, a long name is cut', c['mode'] == 'log' and c['xyz'][2] == 0 and len(c['name']) == 80 and c['contents'] == [] and c['log'] == [], c)
check('the survey part is unchanged', len(r['surveys']) == 1 and len(r['surveys'][0]['lines']) == 1 and 'inventories' not in r['surveys'][0])

old = run({k: v for k, v in payload.items() if k != 'inventories'})
check('an old payload (no inventories) converts as before: no key', 'inventories' not in old and len(old['surveys']) == 1)
only = run({'surveys': [], 'inventories': [surf]})
check('a chest alone (no surveys) is enough', len(only['inventories']) == 1 and only['surveys'] == [])
check('convert_inventories(None) is empty', et.convert_inventories(None, ce, cn, zone) == [] and et.convert_inventories([], ce, cn, zone) == [])

# ── photos as pages of a docs input with no entries ──────────────────────────
with tempfile.TemporaryDirectory() as tmp:
    f1, f2 = os.path.join(tmp, H1 + '.jpg'), os.path.join(tmp, H2 + '.png')
    open(f1, 'wb').write(b'\xff\xd8' + b'1' * 98); open(f2, 'wb').write(b'\x89PNG' + b'2' * 296)
    inp = os.path.join(tmp, 'docs_input.json')
    json.dump({'project': None, 'caves': [], 'entries': [], 'pages': [{'h': H1, 'ext': 'jpg', 'path': f1, 'size': 100}, {'h': H2, 'ext': 'png', 'path': f2, 'size': 300},
                                                                  {'h': 'c' * 64, 'ext': 'jpg', 'path': os.path.join(tmp, 'missing.jpg')}]}, open(inp, 'w'))
    side, files = vi.load_docs(inp, progress=lambda m: None)
    check('load_docs: pages alone are read (no entries), only files that exist', side['entries'] == [] and [p['h'] for p in side['pages']] == [H1, H2] and [n for n, _ in files] == [f'docs_{H1}.jpg', f'docs_{H2}.png'], side)
    text = vi.docs_inline_json(side, lambda n: dict(files)[n].read_bytes())
    j = json.loads(text) if text else None
    check('docs_inline_json: pages alone are carried (a viewer.html would hold them inline)', j is not None and j['entries'] == [] and sorted(j['inline']) == [f'{H1}.jpg', f'{H2}.png'], text and text[:200])
    j0 = json.loads(vi.docs_inline_json(side, lambda n: dict(files)[n].read_bytes(), 150))
    check('…up to the inline cap, smallest first; the rest is read from its file', sorted(j0.get('inline', {})) == [f'{H1}.jpg'], j0.get('inline', {}).keys())
    check('docs_inline_json: nothing at all (no entries, no pages) is None', vi.docs_inline_json({'entries': [], 'pages': []}, lambda n: b'') is None and vi.docs_inline_json(None, lambda n: b'') is None)

# ── a whole made-up export with inventories ──────────────────────────────────
with tempfile.TemporaryDirectory() as tmp:
    out = os.path.join(tmp, 'export')
    env = dict(os.environ)
    extra = os.path.expanduser('~/opt/pylibs')
    if os.path.isdir(extra):
        env['PYTHONPATH'] = extra + (os.pathsep + env['PYTHONPATH'] if env.get('PYTHONPATH') else '')
    try:
        subprocess.run([sys.executable, os.path.join(HERE, 'make_synthetic_export.py'), out, '--inventories'], env=env, check=True, capture_output=True, timeout=300)
        built = True
    except Exception as e:                          # (no numpy / pygltflib here: the part above stands on its own)
        built = False
        print('note: the synthetic export was not built:', str(getattr(e, 'stderr', e))[:200])
    if built:
        caves = json.load(open(os.path.join(out, 'caves.json')))
        docs = json.load(open(os.path.join(out, 'docs.json')))
        ivs = {i['name']: i for i in caves['inventories']}
        sts = {s['name']: s['xyz'] for sv in caves['surveys'] for s in sv['stations']}
        check('export: the made-up chest at A5 sits at that station', ivs['Rope cache']['xyz'] == sts['A5'] and ivs['Rope cache']['station'] == 'A5' and ivs['Rope cache']['cave'] == 'Cave Ridge')
        check('export: a simple list and a surface chest are there', ivs['Old stash']['mode'] == 'list' and ivs['Dig tools']['target'] == 'feature:fsurf1' and 'station' not in ivs['Dig tools'])
        photos = [p for e in ivs['Rope cache']['log'] for p in e.get('photos', [])]
        check('export: the log\'s photos are listed in docs.json pages, as files beside caves.json', len(photos) == 2 and docs['entries'] == [] and sorted(p['h'] for p in docs['pages']) == sorted(p['h'] for p in photos)
              and all(os.path.exists(os.path.join(out, f"docs_{p['h']}.{p['ext']}")) for p in photos), [photos, docs])
        html = open(os.path.join(out, 'viewer.html'), encoding='utf-8').read()
        check('export: the single-file viewer carries the pages inline and the inventories', 'window.DOCS_EXPORT = {"format":1' in html and '"inline"' in html and 'Rope cache' in html and 'Blue barrel behind the boulder' in html)
        check('export: the project is named for FLEX Field to link', caves['meta']['project']['id'] == 'pjtest0001')

print(f'{passes} passed, {fails} failed')
sys.exit(1 if fails else 0)
