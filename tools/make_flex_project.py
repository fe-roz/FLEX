#!/usr/bin/env python3
"""Build a FLEX project (as a FLEX sync file) from survey files and map data.

    python tools/make_flex_project.py flex-project.json [-o FLEX-sync-<name>.zip]
    python tools/make_flex_project.py flex-project.json --install <FLEX folder>

Then in FLEX: 📁 (top left) → Sync files → ⇩ Import… → pick the zip. Or, with
--install, the project is written straight into that FLEX's library
(user_files/library; FLEX may be running — reload the page, then choose the
project with the 📁 button). The
project opens with its caves placed, its surface features in folders and its
leads marked. Re-running after changes and importing again updates the same
project (records keep their ids; nothing is duplicated). Note: every record
listed is written again with these values, replacing edits made to it in FLEX
since (a lead's status, a cave moved with Georectify).

flex-project.json (paths relative to it; every section optional):

{
  "project": "Ridge area",                 // project name
  "author": "Sam",                         // who the entries are logged under
  "caves": [
    { "name": "Ridge Cave", "plt": "ridge.plt",
      "entrance": { "station": "E1", "lat": 45.1234, "lon": -100.5678, "elev_m": 1478 },   // see "Heights" 
      "declination": null }                // only if the .plt azimuths are still magnetic
  ],
  "features": [                            // points, lines, areas → folders (FLEX only)
    { "file": "surface.geojson", "folder": "Surface" }       // .geojson .json .kml .gpx
  ],
  "leads": [                               // every POINT becomes a surface point + a lead on it
    { "file": "digs.geojson", "folder": "Digs", "types": ["Sediment dig"], "status": "open" }
  ],
  "estimated": [                           // a line drawn as a "cave" (one survey, EST): an
    { "name": "Stream (estimated)",        // estimated underground stream, a projected passage
      "file": "stream.geojson",
      "elev_m": 1380 }                     // its elevation (metres), unless the line has z values
  ]
}

- A cave without "entrance" still imports; FLEX asks where to put it the first
  time it loads (anchor a station to the globe).
- Lead fields read from each point's properties when present: name/title,
  description/desc, status (open, confirmed, unknown, surveyed, deadend,
  mopped, notalead), types (list or "a, b"), priority (1–5), potential, air,
  water, w, h (metres), seen, gear, effort, found.
- Coordinates are WGS84 longitude/latitude. Nothing leaves this computer: the
  zip is written next to the JSON.
- Heights: FLEX's globe uses heights above the WGS84 ellipsoid, not above sea
  level. elev_m = elevation above sea level + the local geoid height (about
  -30 m in much of the western US; NOAA/NGS GEOID or EGM96 calculators give
  it). A few metres off is fine — fix it in FLEX with 🎯 Georectify.
Standard library only.
"""
import argparse, hashlib, io, json, math, os, re, secrets, sys, time, zipfile
import xml.etree.ElementTree as ET

FT = 0.3048
LEAD_KEYS = {'status', 'types', 'priority', 'potential', 'air', 'water', 'w', 'h', 'seen', 'ground', 'hazards',
             'temp', 'sound', 'gear', 'effort', 'into', 'found', 'tie'}
STATUSES = {'open', 'confirmed', 'unknown', 'surveyed', 'deadend', 'mopped', 'notalead'}


def hid(*parts, n=12):
    return hashlib.sha1('|'.join(str(p) for p in parts).encode()).hexdigest()[:n]


# ── Reading map files → [{kind, coords:[[lon,lat,(z)]], name, desc, props, path:[folders]}] ──
def read_geojson(p):
    d = json.load(open(p, encoding='utf-8-sig'))
    feats = d.get('features', [d] if d.get('type') == 'Feature' else [])
    out = []
    for f in feats:
        g, pr = f.get('geometry') or {}, f.get('properties') or {}
        name = str(pr.get('title') or pr.get('name') or '')
        desc = str(pr.get('description') or pr.get('desc') or '')
        path = [x for x in str(pr.get('folder') or '').split('/') if x]
        t, c = g.get('type'), g.get('coordinates')
        parts = []
        if t == 'Point': parts = [('point', [c])]
        elif t == 'MultiPoint': parts = [('point', [x]) for x in c]
        elif t == 'LineString': parts = [('line', c)]
        elif t == 'MultiLineString': parts = [('line', x) for x in c]
        elif t == 'Polygon': parts = [('area', c[0][:-1] if c[0][0] == c[0][-1] else c[0])]
        elif t == 'MultiPolygon': parts = [('area', x[0][:-1] if x[0][0] == x[0][-1] else x[0]) for x in c]
        for k, cc in parts:
            out.append(dict(kind=k, coords=[list(map(float, x[:3])) for x in cc], name=name, desc=desc, props=pr, path=path))
    return out


def _tag(e): return e.tag.split('}')[-1]


def read_kml(p):
    root = ET.parse(p).getroot()
    out = []

    def coords(txt):
        r = []
        for tok in (txt or '').split():
            v = tok.split(',')
            if len(v) >= 2: r.append([float(x) for x in v[:3]])
        return r

    def walk(node, path):
        for ch in node:
            t = _tag(ch)
            if t in ('Folder', 'Document'):
                nm = next((x.text for x in ch if _tag(x) == 'name'), None)
                walk(ch, path + [nm] if (t == 'Folder' and nm) else path)
            elif t == 'Placemark':
                name = next((x.text or '' for x in ch if _tag(x) == 'name'), '')
                desc = next((x.text or '' for x in ch if _tag(x) == 'description'), '')
                for g in ch.iter():
                    gt = _tag(g)
                    cc = next((x.text for x in g if _tag(x) == 'coordinates'), None) if gt in ('Point', 'LineString') else None
                    if gt == 'Point' and cc: out.append(dict(kind='point', coords=coords(cc)[:1], name=name, desc=desc, props={}, path=path))
                    elif gt == 'LineString' and cc: out.append(dict(kind='line', coords=coords(cc), name=name, desc=desc, props={}, path=path))
                    elif gt == 'outerBoundaryIs':
                        ring = next((x for x in g.iter() if _tag(x) == 'coordinates'), None)
                        if ring is not None:
                            c = coords(ring.text)
                            if len(c) > 1 and c[0][:2] == c[-1][:2]: c = c[:-1]
                            out.append(dict(kind='area', coords=c, name=name, desc=desc, props={}, path=path))
    walk(root, [])
    return out


def read_gpx(p):
    root = ET.parse(p).getroot()
    out = []
    def pt(e):
        c = [float(e.get('lon')), float(e.get('lat'))]
        ele = next((x.text for x in e if _tag(x) == 'ele'), None)
        return c + [float(ele)] if ele else c
    txt = lambda e, k: next((x.text or '' for x in e if _tag(x) == k), '')
    for e in root:
        t = _tag(e)
        if t == 'wpt': out.append(dict(kind='point', coords=[pt(e)], name=txt(e, 'name'), desc=txt(e, 'desc'), props={}, path=[]))
        elif t == 'rte': out.append(dict(kind='line', coords=[pt(x) for x in e if _tag(x) == 'rtept'], name=txt(e, 'name'), desc=txt(e, 'desc'), props={}, path=[]))
        elif t == 'trk':
            for seg in (x for x in e if _tag(x) == 'trkseg'):
                out.append(dict(kind='line', coords=[pt(x) for x in seg if _tag(x) == 'trkpt'], name=txt(e, 'name'), desc=txt(e, 'desc'), props={}, path=[]))
    return out


def read_any(p):
    ext = os.path.splitext(p)[1].lower()
    if ext in ('.geojson', '.json'): return read_geojson(p)
    if ext == '.kml': return read_kml(p)
    if ext == '.gpx': return read_gpx(p)
    sys.exit(f'{p}: use GeoJSON, KML or GPX (unzip a .kmz to get its doc.kml)')


# ── A line → PLT (local feet, true north) ─────────────────────────────────────
def line_to_plt(name, coords, elev_m):
    lon0, lat0 = coords[0][0], coords[0][1]
    R = 6378137.0
    def ne(c):
        n = math.radians(c[1] - lat0) * R
        e = math.radians(c[0] - lon0) * R * math.cos(math.radians((c[1] + lat0) / 2))
        return n, e
    z = [c[2] if len(c) > 2 and c[2] is not None else elev_m for c in coords]
    if any(v is None for v in z): sys.exit(f'"{name}": give "elev_m" (the line has no elevations)')
    pts = [(ne(c)[0] / FT, ne(c)[1] / FT, (z[i] - z[0]) / FT) for i, c in enumerate(coords)]
    ns, es, vs = zip(*pts)
    box = f'{min(ns):.2f}\t{max(ns):.2f}\t{min(es):.2f}\t{max(es):.2f}\t{min(vs):.2f}\t{max(vs):.2f}'
    lines = [f'Z\t{box}', 'S' + name.upper(), f'NEST\tD 1 1 2000\tC{name} (estimated, not surveyed)']
    for i, (n, e, v) in enumerate(pts):
        lines.append(f'{"M" if i == 0 else "D"}\t{n:.2f}\t{e:.2f}\t{v:.2f}\tSEST{i}\tP\t-9.90\t-9.90\t-9.90\t-9.90')
    lines.append(f'X\t{box}')
    return '\r\n'.join(lines) + '\r\n', 'EST0', z[0]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('spec'); ap.add_argument('-o', '--out')
    ap.add_argument('--install', metavar='FLEX_FOLDER', help='write the project into that FLEX installation instead of a zip')
    a = ap.parse_args()
    base = os.path.dirname(os.path.abspath(a.spec))
    S = json.load(open(a.spec, encoding='utf-8-sig'))
    P = lambda f: os.path.join(base, f)
    name = S.get('project') or 'My caves'
    pid = 'p' + hid('project', name, n=10)
    dev = 'import' + secrets.token_hex(4)
    who = S.get('author') or 'import'
    t0 = time.time()
    entries, blobs, seq = [], {}, [0]
    report = []

    def E(op, **k):
        seq[0] += 1
        t = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(t0)) + '.%03dZ' % (seq[0] % 1000)
        e = dict(id=f'{dev}.{seq[0]}', dev=dev, seq=seq[0], t=t, who=who, op=op); e.update(k); entries.append(e)

    E('project.set', name=name)

    # Caves (survey files with their placement)
    def add_cave(cname, text, place, file_name=None):
        fn = file_name or cname
        h = hashlib.sha256(text.encode('utf-8')).hexdigest()
        blobs[h + '.plt'] = text.encode('utf-8')
        cid = 'c' + hid('cave', cname, n=10)
        E('cave.set', cave=cid, name=cname[:60], sources=[{'file': fn}])
        E('cave.alias', cave=cid, alias=fn)
        E('cavefile.set', file=fn, h=h, ext='plt', place=place, removed=False)
        return cid

    for c in S.get('caves', []):
        text = open(P(c['plt']), encoding='utf-8', errors='replace').read()
        ent = c.get('entrance')
        place = None
        if ent:
            if not re.search(r'\sS' + re.escape(str(ent['station'])) + r'\s', text):
                sys.exit(f'cave "{c["name"]}": station {ent["station"]} is not in {c["plt"]}')
            place = {'mode': 'anchor', 'station': str(ent['station']), 'lat': float(ent['lat']), 'lon': float(ent['lon']),
                     'elev': float(ent.get('elev_m') or 0), 'survey': '', 'declination': c.get('declination')}
            if not ent.get('elev_m'): report.append(f'cave "{c["name"]}": no elev_m — placed at 0 m; fix in FLEX (🎯 Georectify)')
        else:
            report.append(f'cave "{c["name"]}": no entrance given — FLEX will ask where it is when it first loads')
        add_cave(c['name'], text, place, file_name=c['name'])
        report.append(f'cave "{c["name"]}" from {c["plt"]}')

    # Folders and features
    groups = {}
    def group_for(path):
        parent = ''
        for i in range(len(path)):
            key = '/'.join(path[:i + 1])
            if key not in groups:
                gid = 'g' + hid('group', key, n=10)
                E('group.set', group=gid, name=path[i][:80], parent=parent); groups[key] = gid
            parent = groups[key]
        return parent

    def add_feature(it, folder, i, src):
        fid = 'f' + hid('feature', src, folder, it['kind'], json.dumps(it['coords'][:3]), it['name'], i)
        g = group_for([x for x in ([folder] if folder else []) + it['path'] if x])
        style = {}
        col = it['props'].get('marker-color') or it['props'].get('stroke') or it['props'].get('color')
        if col and re.match(r'^#?[0-9a-fA-F]{6}$', str(col)): style['color'] = '#' + str(col).lstrip('#').lower()
        k = dict(feature=fid, kind=it['kind'], coords=it['coords'], name=it['name'][:120], desc=it['desc'][:4000], group=g)
        if style: k['style'] = style
        E('feature.set', **k)
        return fid

    for fs in S.get('features', []):
        items = read_any(P(fs['file']))
        for i, it in enumerate(items): add_feature(it, fs.get('folder') or os.path.splitext(fs['file'])[0], i, fs['file'])
        report.append(f'{len(items)} feature(s) from {fs["file"]}')

    # Leads at surface points (digs…)
    for ls in S.get('leads', []):
        items = [x for x in read_any(P(ls['file'])) if x['kind'] == 'point']
        for i, it in enumerate(items):
            fid = add_feature(it, ls.get('folder') or 'Leads', i, ls['file'])
            pr = it['props']
            fields = {'status': str(pr.get('status') or ls.get('status') or 'open').lower()}
            if fields['status'] not in STATUSES: fields['status'] = 'open'
            types = pr.get('types') or ls.get('types') or []
            if isinstance(types, str): types = [x.strip() for x in types.split(',') if x.strip()]
            if types: fields['types'] = types
            if it['desc'] or it['name']: fields['desc'] = (it['desc'] or it['name'])[:2000]
            for kk in LEAD_KEYS - {'status', 'types'}:
                if pr.get(kk) not in (None, ''): fields[kk] = pr[kk]
            E('lead.set', lead='l' + hid('lead', fid), target='feature:' + fid, fields=fields, source='import')
        report.append(f'{len(items)} lead(s) from {ls["file"]}')

    # Estimated passages / streams as a cave
    for es in S.get('estimated', []):
        lines = [x for x in read_any(P(es['file'])) if x['kind'] == 'line']
        if not lines: sys.exit(f'{es["file"]}: no line in it')
        for j, ln in enumerate(lines):
            nm = es.get('name') or ln['name'] or 'Estimated'
            if len(lines) > 1: nm = f'{nm} {j + 1}'
            text, st, z0 = line_to_plt(nm, ln['coords'], es.get('elev_m'))
            add_cave(nm, text, {'mode': 'anchor', 'station': st, 'lat': ln['coords'][0][1], 'lon': ln['coords'][0][0], 'elev': float(z0),
                                'survey': '', 'declination': None})
            report.append(f'estimated "{nm}" ({len(ln["coords"])} points) from {es["file"]}')

    # The sync file (what FLEX's own "Make sync file" writes)
    scope = 'p-' + pid
    man = {'format': 'flex-sync', 'version': 1, 'created': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t0)),
           'from': {'dev': dev, 'who': who}, 'project': {'id': pid, 'name': name},
           'scopes': {scope: {dev: {'from': 1, 'to': seq[0], 'n': seq[0]}}}, 'blobs': len(blobs)}
    if a.install:
        lib = os.path.join(a.install, 'user_files', 'library')
        if not os.path.isfile(os.path.join(a.install, 'server.js')): sys.exit(f'{a.install} is not a FLEX folder (no server.js)')
        os.makedirs(os.path.join(lib, scope), exist_ok=True); os.makedirs(os.path.join(lib, 'blobs'), exist_ok=True)
        with open(os.path.join(lib, scope, f'log-{dev}.jsonl'), 'a', encoding='utf-8') as fh:   # a new file: this run's device
            fh.write('\n'.join(json.dumps(e, ensure_ascii=False) for e in entries) + '\n')
        for n, b in blobs.items():
            f = os.path.join(lib, 'blobs', n)
            if not os.path.exists(f): open(f, 'wb').write(b)
        pf = os.path.join(lib, 'projects.json')
        try: plist = json.load(open(pf, encoding='utf-8'))
        except Exception: plist = []
        if not any(x.get('id') == pid for x in plist): plist.append({'id': pid, 'name': name}); json.dump(plist, open(pf, 'w', encoding='utf-8'))
        print('\n'.join(report))
        print(f'{len(entries)} entries, {len(blobs)} survey file(s) installed into {lib}')
        print(f'In FLEX: reload the page, 📁 (top left) → choose “{name}”.')
        return
    out = a.out or os.path.join(base, 'FLEX-sync-' + re.sub(r'[^A-Za-z0-9]+', '-', name).strip('-').lower() + '.zip')
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('manifest.json', json.dumps(man, indent=1))
        z.writestr(f'logs/{scope}/log-{dev}.jsonl', '\n'.join(json.dumps(e, ensure_ascii=False) for e in entries) + '\n')
        for n, b in blobs.items(): z.writestr('blobs/' + n, b, compress_type=zipfile.ZIP_STORED)
    print('\n'.join(report))
    print(f'{len(entries)} entries, {len(blobs)} survey file(s) -> {out}')
    print('In FLEX: 📁 (top left) → Sync files → ⇩ Import… → this file.')


if __name__ == '__main__':
    main()
