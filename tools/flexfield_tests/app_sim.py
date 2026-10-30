"""Stand-in for the FLEX Field app's Kotlin side, for headless tests of the
map list and the viewer in app mode. Mirrors MainActivity.MapPathHandler
(routing + viewer substitution), LibStore (the project library: logs per
scope and device, pages by hash, sync files) and the AndroidHost surface over
HTTP; the page's AndroidHost is a mock that calls /__host/<method> with sync
XHR. Pickers are fed from queues the tests fill (pick_pages, pick_sync)."""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _work import WORK
import base64, hashlib, http.server, io, json, os, re, shutil, sys, threading, time, uuid, zipfile, urllib.parse
from pathlib import Path

FLEX = Path(__file__).resolve().parents[2]
STORE = Path(os.environ.get('FF_STORE', os.path.join(WORK, 'appstore')))
ZIP = os.environ.get('FF_ZIP', os.path.join(WORK, 'FLEX-Cave-Ridge.zip'))
DATA = {'terrain.glb', 'tex_sat.jpg', 'tex_hs.jpg', 'walls.bin', 'caves.json'}
MAPS = STORE / 'maps'
LIB = STORE / 'library'
SHARED = STORE / 'shared'
calls = []
staged = {}
pick_pages = []          # list of lists of file paths, one per picker launch
pick_sync = []           # sync zip paths, one per picker launch
shared = []              # files handed to the share sheet

# ── LibStore ─────────────────────────────────────────────────────────────────
SCOPE_RE = re.compile(r'^(docs|p-[A-Za-z0-9_-]{1,40})$')
DEV_RE = re.compile(r'^[A-Za-z0-9_-]{1,40}$')
ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,40}$')
HASH_RE = re.compile(r'^[0-9a-f]{64}$')
EXTS = {'jpg', 'png', 'webp', 'pdf'}
PAGE_PX = 2400

def lib_device():
    f = LIB / 'device.json'
    try:
        cur = json.loads(f.read_text()).get('id', '')
        if DEV_RE.match(cur): return cur
    except Exception: pass
    LIB.mkdir(parents=True, exist_ok=True)
    i = 'a' + uuid.uuid4().hex[:12]
    f.write_text(json.dumps({'id': i, 'created': int(time.time() * 1000)}))
    return i

def scope_dir(scope):
    if not SCOPE_RE.match(scope): return None
    d = LIB / scope; d.mkdir(parents=True, exist_ok=True); return d

def lib_read(scope):
    d = scope_dir(scope)
    if not d: return ''
    out = ''
    for f in sorted(d.glob('log-*.jsonl')):
        t = f.read_text(encoding='utf-8'); out += t + ('' if not t or t.endswith('\n') else '\n')
    return out

def lib_append(scope, line):
    d = scope_dir(scope)
    if not d: return False
    clean = line.replace('\n', ' ').replace('\r', ' ')
    try: e = json.loads(clean)
    except Exception: return False
    dev = lib_device()
    if e.get('dev') != dev or e.get('id') != f"{dev}.{e.get('seq')}" or not isinstance(e.get('seq'), int) or e['seq'] <= 0: return False
    with open(d / f'log-{dev}.jsonl', 'a', encoding='utf-8') as fh: fh.write(clean + '\n')
    return True

def known_ids(d):
    ids = set()
    for f in d.glob('log-*.jsonl'):
        for l in f.read_text(encoding='utf-8').splitlines():
            if l.strip():
                try: ids.add(json.loads(l).get('id'))
                except Exception: pass
    return ids

def blob_file(name):
    h, _, ext = name.partition('.')
    if not HASH_RE.match(h) or ext not in EXTS: return None
    f = LIB / 'blobs' / f'{h}.{ext}'
    return f if f.is_file() else None

def put_blob(b, ext):
    assert ext in EXTS
    h = hashlib.sha256(b).hexdigest()
    d = LIB / 'blobs'; d.mkdir(parents=True, exist_ok=True)
    if not (d / f'{h}.{ext}').is_file(): (d / f'{h}.{ext}').write_bytes(b)
    return {'h': h, 'ext': ext}

def add_pages(paths):
    from PIL import Image
    pages, tiffs, failed = [], [], []
    for p in paths:
        name = Path(p).name
        try:
            if name.lower().endswith('.pdf'):
                failed.append(name)                     # PdfRenderer: not simulated
            elif re.search(r'(?i)\.tiff?$', name):
                tok = uuid.uuid4().hex[:12]
                (LIB / 'tmp').mkdir(parents=True, exist_ok=True)
                shutil.copyfile(p, LIB / 'tmp' / f'{tok}.tif')
                tiffs.append({'token': tok, 'name': name})
            else:
                im = Image.open(p).convert('RGB')
                m = max(im.size)
                if m > PAGE_PX: im = im.resize((max(1, im.width * PAGE_PX // m), max(1, im.height * PAGE_PX // m)))
                buf = io.BytesIO(); im.save(buf, 'JPEG', quality=85)
                pages.append(dict(put_blob(buf.getvalue(), 'jpg'), w=im.width, ht=im.height, name=name))
        except Exception:
            failed.append(name)
    return {'pages': pages, 'tiffs': tiffs, 'failed': failed}

def projects():
    try: return json.loads((LIB / 'projects.json').read_text())
    except Exception: return []

def set_project(i, name):
    if not ID_RE.match(i or ''): return False
    lst = projects(); found = False
    for p in lst:
        if p.get('id') == i:
            found = True
            if name.strip(): p['name'] = name.strip()[:60]
    if not found: lst.append({'id': i, 'name': name.strip()[:60]})
    LIB.mkdir(parents=True, exist_ok=True); (LIB / 'projects.json').write_text(json.dumps(lst)); return True

def project_name(i):
    return next((p.get('name', '') for p in projects() if p.get('id') == i), '')

def kv():
    try: return json.loads((LIB / 'kv.json').read_text())
    except Exception: return {}

def kv_set(k, v):
    if len(k) > 200 or len(v) > 200000: return False
    o = kv(); o[k] = v; LIB.mkdir(parents=True, exist_ok=True); (LIB / 'kv.json').write_text(json.dumps(o)); return True

def write_sync(out, manifest, entries_json, blobs_json):
    json.loads(manifest)
    entries, names = json.loads(entries_json), json.loads(blobs_json)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('manifest.json', manifest)
        for scope, arr in entries.items():
            if not SCOPE_RE.match(scope): continue
            by = {}
            for e in arr:
                if DEV_RE.match(e.get('dev', '')): by.setdefault(e['dev'], []).append(json.dumps(e))
            for dev, ls in by.items(): z.writestr(f'logs/{scope}/log-{dev}.jsonl', '\n'.join(ls) + '\n')
        for n in names:
            f = blob_file(n)
            if f: z.write(f, 'blobs/' + f.name, compress_type=zipfile.ZIP_STORED)

def import_sync(path):
    manifest, logs, pages = None, {}, 0
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if n == 'manifest.json': manifest = json.loads(z.read(n).decode('utf-8')); continue
            m = re.match(r'^logs/([^/]+)/log-([^/]+)\.jsonl$', n)
            if m and SCOPE_RE.match(m.group(1)) and DEV_RE.match(m.group(2)):
                for l in z.read(n).decode('utf-8').split('\n'):
                    if l.strip():
                        try: logs.setdefault(m.group(1), []).append(json.loads(l))
                        except Exception: pass
                continue
            m = re.match(r'^blobs/([0-9a-f]{64})\.([a-z]{2,4})$', n)
            if m and m.group(2) in EXTS and not (LIB / 'blobs' / f'{m.group(1)}.{m.group(2)}').is_file():
                b = z.read(n)
                if hashlib.sha256(b).hexdigest() == m.group(1): put_blob(b, m.group(2)); pages += 1
    if manifest is None: return {'ok': False, 'error': 'Not a FLEX sync file (no manifest).'}
    if manifest.get('format') != 'flex-sync': return {'ok': False, 'error': 'Not a FLEX sync file.'}
    added = 0
    for scope, lst in logs.items():
        d = scope_dir(scope)
        if not d: continue
        known = known_ids(d); new = []
        for e in lst:
            if isinstance(e.get('seq'), int) and e['seq'] > 0 and e.get('id') == f"{e.get('dev')}.{e['seq']}" and e['id'] not in known:
                known.add(e['id']); new.append(e)
        new.sort(key=lambda e: (e['dev'], e['seq']))
        for e in new:
            with open(d / f"log-{e['dev']}.jsonl", 'a', encoding='utf-8') as fh: fh.write(json.dumps(e) + '\n')
        added += len(new)
    p = manifest.get('project')
    if p and p.get('id'): set_project(p['id'], p.get('name', ''))
    return {'ok': True, 'project': p, 'from': manifest.get('from'), 'entries': added, 'pages': pages}

def info(i):
    try: return json.loads((MAPS / i / 'map.json').read_text())
    except Exception: return None

def dsize(d):
    return sum(f.stat().st_size for f in Path(d).rglob('*') if f.is_file()) if Path(d).exists() else 0

def log_append(i, entry):
    u = MAPS / i / 'user'; u.mkdir(parents=True, exist_ok=True)
    with open(u / 'log.jsonl', 'a', encoding='utf-8') as f: f.write(json.dumps(entry) + '\n')

def stage(path):
    tok = uuid.uuid4().hex[:12]
    d = STORE / '.staging' / tok; d.mkdir(parents=True)
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            b = n.split('/')[-1]
            if b in DATA and not (d / b).exists(): (d / b).write_bytes(z.read(n))
    meta = json.loads((d / 'caves.json').read_text()).get('meta', {})
    return tok, d, meta.get('name', ''), meta.get('format_version', 1)

def commit(d, name, fv, target, author):
    now = int(time.time() * 1000)
    if target:
        ex = MAPS / target / 'export'; shutil.rmtree(ex); d.rename(ex)
        inf = info(target); inf.update(exportName=name, formatVersion=fv, updatedAt=now)
        (MAPS / target / 'map.json').write_text(json.dumps(inf))
        log_append(target, {'id': uuid.uuid4().hex[:12], 't': time.strftime('%Y-%m-%dT%H:%M:%SZ'), 'who': author or '?', 'op': 'map.update', 'export': name})
        return target
    i = uuid.uuid4().hex[:12]
    (MAPS / i).mkdir(parents=True); d.rename(MAPS / i / 'export'); (MAPS / i / 'user').mkdir()
    (MAPS / i / 'map.json').write_text(json.dumps({'id': i, 'name': name or 'Map', 'exportName': name, 'formatVersion': fv, 'importedAt': now, 'updatedAt': now}))
    log_append(i, {'id': uuid.uuid4().hex[:12], 't': time.strftime('%Y-%m-%dT%H:%M:%SZ'), 'who': author or '?', 'op': 'map.import', 'export': name})
    return i

def host(method, a):
    calls.append((method, a))
    if method == 'listMaps':
        out = []
        for d in MAPS.iterdir() if MAPS.exists() else []:
            inf = info(d.name)
            if not inf: continue
            lg = d / 'user' / 'log.jsonl'
            inf.update(size=dsize(d / 'export'), logCount=len(lg.read_text().splitlines()) if lg.exists() else 0)
            if inf.get('project'): inf['projectName'] = project_name(inf['project'])
            out.append(inf)
        return json.dumps(out)
    if method == 'logRead':
        f = MAPS / a[0] / 'user' / 'log.jsonl'; return f.read_text() if f.exists() else ''
    if method == 'logAppend':
        json.loads(a[1]); log_append(a[0], json.loads(a[1])); return True
    if method == 'libDevice': return lib_device()
    if method == 'libRead': return lib_read(a[0])
    if method == 'libAppend': return lib_append(a[0], a[1])
    if method == 'libPutBlob':
        try: return json.dumps(put_blob(base64.b64decode(a[0]), a[1]))
        except Exception: return 'null'
    if method == 'libProjects': return json.dumps(projects())
    if method == 'libSetProject': return set_project(a[0], a[1])
    if method == 'libMapProject': return (info(a[0]) or {}).get('project', '')
    if method == 'libSetMapProject':
        inf = info(a[0])
        if not inf or not ID_RE.match(a[1] or ''): return False
        inf['project'] = a[1]; (MAPS / a[0] / 'map.json').write_text(json.dumps(inf)); return True
    if method == 'libKvGet': return kv().get(a[0], '')
    if method == 'libKvSet': return kv_set(a[0], a[1])
    if method == 'libTmpDone':
        if re.match(r'^[0-9a-f]{12}$', a[0]): (LIB / 'tmp' / f'{a[0]}.tif').unlink(missing_ok=True)
        return None
    if method == 'libPickPages':
        return json.dumps(add_pages(pick_pages.pop(0))) if pick_pages else None
    if method == 'libSyncImport':
        if not pick_sync: return None
        try: return json.dumps(import_sync(pick_sync.pop(0)))
        except Exception as e: return json.dumps({'ok': False, 'error': str(e)})
    if method == 'libSyncWrite':
        name = re.sub(r'[^A-Za-z0-9._-]', '_', a[0])[:100]
        if not name.endswith('.zip'): name += '.zip'
        SHARED.mkdir(parents=True, exist_ok=True)
        for f in SHARED.glob('FLEX-sync-*'): f.unlink()
        write_sync(SHARED / name, a[1], a[2], a[3]); shared.append(SHARED / name); return True
    if method == 'deleteMap':
        shutil.rmtree(MAPS / a[0]); return True
    if method == 'renameMap':
        inf = info(a[0]); inf['name'] = a[1]; (MAPS / a[0] / 'map.json').write_text(json.dumps(inf)); return True
    if method == 'importZip':
        tok, d, name, fv = stage(ZIP)
        target, author = a[0] or None, a[1]
        if target: return json.dumps({'done': dict(info(commit(d, name, fv, target, author)), updated=True)})
        matches = [info(x.name) for x in MAPS.iterdir() if info(x.name) and info(x.name).get('exportName', '').lower() == name.lower()] if MAPS.exists() else []
        if not matches: return json.dumps({'done': dict(info(commit(d, name, fv, None, author)), updated=False)})
        staged[tok] = (d, name, fv)
        return json.dumps({'ask': {'token': tok, 'name': name, 'matches': matches}})
    if method == 'resolveImport':
        tok, action, target, author = a
        d, name, fv = staged.pop(tok)
        if action == 'update': return json.dumps({'done': dict(info(commit(d, name, fv, target, author)), updated=True)})
        if action == 'new': return json.dumps({'done': dict(info(commit(d, name, fv, None, author)), updated=False)})
        shutil.rmtree(d); return json.dumps({'cancelled': True})
    if method in ('shareMapData', 'shareFile', 'homeReady', 'setKeepAwake', 'importIncoming'): return True
    if method == 'appVersion': return '2.0-sim'
    if method == 'isNativeHost': return True
    return None

def viewer_for(i):
    t = (FLEX / 'viewer_build' / 'viewer.html').read_text(encoding='utf-8')
    has = lambda f: (MAPS / i / 'export' / f).is_file()
    return (t.replace('"PLACEHOLDER_GLB_B64"', '"terrain.glb"')
             .replace('"PLACEHOLDER_TEX_B64"', '"tex_sat.jpg"' if has('tex_sat.jpg') else '"PLACEHOLDER_TEX_B64"')
             .replace('"PLACEHOLDER_HS_B64"', '"tex_hs.jpg"' if has('tex_hs.jpg') else '"PLACEHOLDER_HS_B64"')
             .replace('"PLACEHOLDER_WALLS_B64"', '"walls.bin"' if has('walls.bin') else '"PLACEHOLDER_WALLS_B64"')
             .replace('PLACEHOLDER_CAVES_JSON', 'ffSidecarJson("caves.json")'))

MIME = {'.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary',
        '.jpg': 'image/jpeg', '.png': 'image/png', '.bin': 'application/octet-stream', '.tif': 'image/tiff'}

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, body, mime, code=200):
        if isinstance(body, str): body = body.encode('utf-8')
        self.send_response(code); self.send_header('Content-Type', mime); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        p = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        if p == '/assets/flexfield/index.html':
            return self.send((FLEX / 'android/app/src/main/flexfield-assets/flexfield/index.html').read_bytes(), 'text/html')
        m = re.match(r'^/lib/(blob|tmp)/([^/]+)$', p)
        if m:
            f = blob_file(m.group(2)) if m.group(1) == 'blob' else (LIB / 'tmp' / f'{m.group(2)}.tif' if re.match(r'^[0-9a-f]{12}$', m.group(2)) else None)
            if not f or not f.is_file(): return self.send(b'', 'text/plain', 404)
            return self.send(f.read_bytes(), MIME.get(f.suffix, 'application/octet-stream'))
        m = re.match(r'^/map/([A-Za-z0-9_-]+)/(.+)$', p)
        if not m or not (MAPS / m.group(1)).is_dir(): return self.send(b'', 'text/plain', 404)
        i, rest = m.groups()
        if rest == 'viewer.html': return self.send(viewer_for(i), 'text/html')
        if rest.startswith('libs/'): f = FLEX / 'viewer_build' / rest
        elif rest in DATA: f = MAPS / i / 'export' / rest
        else: return self.send(b'', 'text/plain', 404)
        if not f.is_file(): return self.send(b'', 'text/plain', 404)
        self.send(f.read_bytes(), MIME.get(f.suffix, 'application/octet-stream'))
    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        a = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'[]')
        r = host(p.split('/')[-1], a)
        self.send(json.dumps(r), 'application/json')

MOCK = r"""
(() => {
  const call = (m, args) => { const x = new XMLHttpRequest(); x.open('POST', '/__host/' + m, false);
    x.setRequestHeader('Content-Type', 'application/json'); x.send(JSON.stringify(args)); return JSON.parse(x.responseText); };
  const H = {};
  ['listMaps','logRead','logAppend','deleteMap','renameMap','shareMapData','shareFile','homeReady',
   'setKeepAwake','appVersion','isNativeHost','importIncoming',
   'libDevice','libRead','libAppend','libPutBlob','libProjects','libSetProject','libMapProject','libSetMapProject',
   'libKvGet','libKvSet','libTmpDone','libSyncWrite'].forEach(m => { H[m] = (...a) => call(m, a); });
  H.openMap = id => { call('openMap', [id]); location.href = '/map/' + id + '/viewer.html'; };
  const after = r => setTimeout(() => { const o = JSON.parse(r);
    if (o.ask) window.ffImportAsk(JSON.stringify(o.ask)); else if (o.done) window.ffImportDone(JSON.stringify(o.done));
    else if (o.cancelled && window.ffImportCancelled) window.ffImportCancelled(); }, 50);
  H.importZip = (t, a) => { window.ffImportProgress && window.ffImportProgress('Unpacking'); after(call('importZip', [t, a])); };
  H.resolveImport = (...a) => after(call('resolveImport', a));
  // pickers answer later, like the activity results do
  H.libPickPages = ctx => { const r = call('libPickPages', [ctx]); if (r) setTimeout(() => window.ffPagesPicked(ctx, r), 50); };
  H.libSyncImport = () => { const r = call('libSyncImport', []); if (r) setTimeout(() => window.ffSyncImported(r), 50); };
  window.AndroidHost = H;
})();
"""

def serve(port):
    MAPS.mkdir(parents=True, exist_ok=True)
    s = http.server.ThreadingHTTPServer(('127.0.0.1', port), H)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s
