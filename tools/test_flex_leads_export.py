#!/usr/bin/env python3
"""
Leads kept in FLEX (a project's or My data's) in the export's caves.json (no PDAL, no network):

  * convert_caves() writes each lead with station, xyz (scene frame), description, width, height,
    date and, when the payload has them, status / source / id / priority;
  * a survey that has leads only (no shots, no stations) is kept;
  * an old payload (leads without status / source) converts exactly as before;
  * the viewer template reads a FLEX lead like a file lead (checked on the template's text).

    python tools/test_flex_leads_export.py
"""
import contextlib, io, json, os, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import export_terrain as et

fails = passes = 0
def check(label, ok, detail=''):
    global fails, passes
    if ok:
        passes += 1
    else:
        fails += 1
        print('FAIL', label, detail)

# Made-up place (Cave Ridge): lon/lat only as examples.
LON, LAT = -100.5678, 45.1234
zone = et.utm_zone_for(LON)
ce, cn, _ = et.latlon_to_utm(LAT, LON, zone)

def run(payload):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, 'caves.json')
        json.dump(payload, open(p, 'w', encoding='utf-8'))
        with contextlib.redirect_stdout(io.StringIO()):
            r = et.convert_caves(p, ce, cn, progress=lambda *a, **k: None, zone=zone)
        return r

payload = {'surveys': [
    {'name': 'A - Cave Ridge', 'code': 'A', 'cave': 'Cave Ridge', 'color': '#00e5ff',
     'shots': [{'from': [LON, LAT, 1500.0], 'to': [LON + 0.0001, LAT, 1498.0], 'from_name': 'A1', 'to_name': 'A2'}],
     'stations': [{'name': 'A1', 'lon': LON, 'lat': LAT, 'elev': 1500.0}],
     'leads': [
         {'station': 'A1', 'lon': LON, 'lat': LAT, 'elev': 1500.0, 'description': 'draughting squeeze', 'width': 0.4, 'height': 0.3,
          'date': '2026-10-02', 'status': 'confirmed', 'source': 'flex', 'id': 'lead-1', 'priority': '2'},
         {'station': 'A2', 'lon': LON + 0.0001, 'lat': LAT, 'elev': 1498.0, 'description': 'from the file'},
     ]},
    {'name': 'B - leads only', 'code': 'B', 'cave': 'Cave Ridge', 'color': '#ff8f00', 'shots': [], 'stations': [],
     'leads': [{'station': 'B1', 'lon': LON, 'lat': LAT + 0.0002, 'elev': 1510.0, 'status': 'open', 'source': 'flex', 'id': 'lead-2'}]},
]}
r = run(payload)
res = r if isinstance(r, dict) else None
if res is None:
    check('convert_caves returns the converted payload', False, type(r))
else:
    sv = {s['name']: s for s in res['surveys']}
    a = sv['A - Cave Ridge']['leads']
    check('two leads in survey A', len(a) == 2, a)
    l1 = a[0]
    check('station and description kept', l1['station'] == 'A1' and l1['description'] == 'draughting squeeze', l1)
    check('size and date kept', l1['width'] == 0.4 and l1['height'] == 0.3 and l1['date'] == '2026-10-02', l1)
    check('status / source / id / priority kept', (l1['status'], l1['source'], l1['id'], l1['priority']) == ('confirmed', 'flex', 'lead-1', '2'), l1)
    check('xyz in the scene frame, height kept', abs(l1['xyz'][0]) < 1e-6 and abs(l1['xyz'][1]) < 1e-6 and l1['xyz'][2] == 1500.0, l1['xyz'])
    l2 = a[1]
    check('an old-style lead has no status / source keys', 'status' not in l2 and 'source' not in l2 and 'id' not in l2 and l2['description'] == 'from the file', l2)
    check('a survey with leads only is kept, lead at its height', 'B - leads only' in sv and sv['B - leads only']['leads'][0]['xyz'][2] == 1510.0
          and abs(sv['B - leads only']['leads'][0]['xyz'][1] - 0.0002 * 111000) < 40, sv.get('B - leads only'))

# The viewer template: a FLEX lead is a lead (same sprite and card), keeps its id for the project, shows its status.
html = open(os.path.join(HERE, '..', 'viewer_build', 'viewer.html'), encoding='utf-8').read()
check('viewer: a lead with an id uses it as its project id', "ld.id ? String(ld.id)" in html)
check('viewer: the card shows a FLEX lead\'s status', "ld.source === 'flex'" in html)

print(f'{passes} passed, {fails} failed')
sys.exit(1 if fails else 0)
