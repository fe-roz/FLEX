#!/usr/bin/env python3
"""
A phone map's manifest, and an UPDATE package: only the files that changed since an earlier map. Standard library only.

Every export zip carries `manifest.json` (written by export_terrain.py through add_manifest()):

    { format: 1, kind: 'map', name, map_id, exported: '2026-11-23T10:30:00Z', bytes,
      files: { '<name>': { size, sha256 [, content] } }, files_hash }

  files        the data files FLEX Field keeps (everything at the top of the zip except viewer.html, serve.bat,
               serve.sh, manifest.json, update.json; nothing under libs/). viewer.html is the desktop browser's
               single file: it repeats all the others and is never part of a manifest.
  content      caves.json only: its sha256 with the export's own time (meta.about.exported) taken out, so two exports
               that differ in nothing but when they were made count as the same map.
  files_hash   the manifest's identity: sha256 over the sorted lines "<name>\\t<size>\\t<sha256>\\n". An update names
               the files_hash of the map it was made against (its base); the phone applies it to that map only.
  map_id       the same for every export of one Process area (the server passes it) or, without one, of one name.

An update package (make_update()) is a zip with `update.json` first, then the files to add or replace:

    { format: 1, kind: 'update', name, map_id, base: { files_hash, exported }, manifest: <the NEW manifest>,
      add: [names], replace: [names], remove: [names], bytes }

It has no viewer.html: it is for FLEX Field. Nothing changed = no package (summary `same`); more than MOSTLY of the
new map's bytes changed = the package is made, and the summary says a full map is as good.

    python export_update.py manifest MAP.zip                       print the zip's manifest (made from its files)
    python export_update.py update --base BASE.json --new NEW.zip --out UPDATE.zip      print the summary as JSON

Tests: tools/test_export_update.py.
"""
import argparse
import hashlib
import json
import os
import sys
import zipfile

FORMAT = 1
MOSTLY = 0.8                         # above this share of the bytes a full map is as good
NOT_DATA = {'viewer.html', 'serve.bat', 'serve.sh', 'manifest.json', 'update.json'}
STORED = ('.jpg', '.jpeg', '.png', '.webp')      # already compressed: stored as they are


def is_data(name):
    """A data file of the map: at the top of the zip and not one of the desktop viewer's own files."""
    return bool(name) and '/' not in name and '\\' not in name and name not in NOT_DATA and not name.startswith('.')


def map_id_of(name):
    """The id of a map that has no Process area behind it: from its name (case and outer spaces do not count)."""
    return 'n' + hashlib.sha256(str(name or '').strip().lower().encode('utf-8')).hexdigest()[:16]


def clean_id(s):
    s = ''.join(c for c in str(s or '') if c.isalnum() or c in '-_')[:48]
    return s


def caves_content(data):
    """caves.json's sha256 with the time it was exported left out (None when it is not that kind of file)."""
    try:
        j = json.loads(data.decode('utf-8'))
        about = j.get('meta', {}).get('about')
        if isinstance(about, dict):
            about.pop('exported', None)
        return hashlib.sha256(json.dumps(j, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()
    except Exception:
        return None


def files_of(zf):
    """{ name: { size, sha256 [, content] } } of a zip's data files, hashed in pieces (a terrain is tens of MB)."""
    out = {}
    for info in zf.infolist():
        if info.is_dir() or not is_data(info.filename):
            continue
        h = hashlib.sha256(); n = 0; keep = [] if info.filename == 'caves.json' else None
        with zf.open(info) as f:
            while True:
                b = f.read(1 << 20)
                if not b:
                    break
                h.update(b); n += len(b)
                if keep is not None:
                    keep.append(b)
        d = {'size': n, 'sha256': h.hexdigest()}
        if keep is not None:
            c = caves_content(b''.join(keep))
            if c:
                d['content'] = c
        out[info.filename] = d
    return out


def files_hash(files):
    h = hashlib.sha256()
    for name in sorted(files):
        h.update(('%s\t%d\t%s\n' % (name, int(files[name]['size']), files[name]['sha256'])).encode('utf-8'))
    return h.hexdigest()


def manifest_of(zip_path, name='', map_id='', exported=''):
    with zipfile.ZipFile(zip_path) as zf:
        files = files_of(zf)
    return {'format': FORMAT, 'kind': 'map', 'name': str(name or ''), 'map_id': clean_id(map_id) or map_id_of(name), 'exported': str(exported or ''),
            'bytes': sum(f['size'] for f in files.values()), 'files': files, 'files_hash': files_hash(files)}


def add_manifest(zip_path, name='', map_id='', exported=''):
    """Put manifest.json into a finished export zip; returns the manifest."""
    m = manifest_of(zip_path, name, map_id, exported)
    with zipfile.ZipFile(zip_path, 'a', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('manifest.json', json.dumps(m, separators=(',', ':')))
    return m


def read_manifest(zip_path):
    """The manifest a zip carries, or one made from its files (an export from before manifests)."""
    with zipfile.ZipFile(zip_path) as zf:
        if 'manifest.json' in zf.namelist():
            m = json.loads(zf.read('manifest.json').decode('utf-8'))
            if valid(m):
                return m
    return manifest_of(zip_path)


def valid(m):
    if not isinstance(m, dict) or m.get('format') != FORMAT or not isinstance(m.get('files'), dict) or not m['files']:
        return False
    for n, f in m['files'].items():
        if not is_data(n) or not isinstance(f, dict) or not isinstance(f.get('size'), int) or not isinstance(f.get('sha256'), str) or len(f['sha256']) != 64:
            return False
    return m.get('files_hash') == files_hash(m['files'])


def same_file(a, b):
    if a['sha256'] == b['sha256'] and a['size'] == b['size']:
        return True
    return bool(a.get('content')) and a.get('content') == b.get('content')


def diff(base, new):
    """What turns the base map into the new one: { add, replace, remove, same, bytes (of add + replace), total, share }.
    A caves.json that differs only in its export time is not a change by itself; when anything else changed it goes
    along (the phone's files must match the new manifest byte for byte)."""
    bf, nf = base['files'], new['files']
    add = sorted(n for n in nf if n not in bf)
    remove = sorted(n for n in bf if n not in nf)
    rep = sorted(n for n in nf if n in bf and not same_file(bf[n], nf[n]))
    if not (add or remove or rep):
        return {'add': [], 'replace': [], 'remove': [], 'same': True, 'bytes': 0, 'total': int(new.get('bytes') or 0), 'share': 0.0}
    rep = sorted(n for n in nf if n in bf and (bf[n]['sha256'] != nf[n]['sha256'] or bf[n]['size'] != nf[n]['size']))
    b = sum(nf[n]['size'] for n in add + rep); tot = sum(f['size'] for f in nf.values())
    return {'add': add, 'replace': rep, 'remove': remove, 'same': False, 'bytes': b, 'total': tot, 'share': round(b / max(1, tot), 4)}


def make_update(base, new_zip, out_zip):
    """Write the update package that turns the map `base` (a manifest) into the map in new_zip. Returns the summary:
    { same, mostly, add, replace, remove, bytes, total, share, package_bytes, full_bytes, map_id, name, base, to }.
    Nothing changed: no file is written."""
    if not valid(base):
        raise ValueError('the earlier map has no usable manifest')
    new = read_manifest(new_zip)
    d = diff(base, new)
    out = dict(d, mostly=d['share'] > MOSTLY, full_bytes=os.path.getsize(new_zip), package_bytes=0, map_id=new.get('map_id', ''), name=new.get('name', ''),
               base={'files_hash': base['files_hash'], 'exported': base.get('exported', '')}, to=new.get('exported', ''))
    if d['same']:
        return out
    upd = {'format': FORMAT, 'kind': 'update', 'name': new.get('name', ''), 'map_id': new.get('map_id', ''), 'base': out['base'], 'manifest': new,
           'add': d['add'], 'replace': d['replace'], 'remove': d['remove'], 'bytes': d['bytes']}
    tmp = out_zip + '.part'
    with zipfile.ZipFile(new_zip) as src, zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as dst:
        dst.writestr(zipfile.ZipInfo('update.json'), json.dumps(upd, separators=(',', ':')), compress_type=zipfile.ZIP_STORED)       # first, uncompressed: read without unpacking the rest
        for n in d['add'] + d['replace']:
            zi = zipfile.ZipInfo(n); zi.compress_type = zipfile.ZIP_STORED if n.lower().endswith(STORED) else zipfile.ZIP_DEFLATED
            with src.open(n) as f, dst.open(zi, 'w', force_zip64=True) as o:
                while True:
                    b = f.read(1 << 20)
                    if not b:
                        break
                    o.write(b)
    os.replace(tmp, out_zip)
    out['package_bytes'] = os.path.getsize(out_zip)
    return out


class Refused(Exception):
    """An update that cannot be applied; nothing was changed. The message is for the user."""


NEEDS_FULL = 'This update needs the full map once: the map here was made before updates existed. Send the full map, then updates will work.'
WRONG_BASE = 'This update was made for another version of this map (%s); the map here is %s. Send the full map, or the update made for this version.'
CORRUPT = 'The update is damaged (%s). Nothing was changed: send it again.'


def read_update(zip_path):
    try:
        with zipfile.ZipFile(zip_path) as zf:
            if 'update.json' not in zf.namelist():
                return None
            u = json.loads(zf.read('update.json').decode('utf-8'))
    except (zipfile.BadZipFile, ValueError, OSError):
        raise Refused(CORRUPT % 'the zip cannot be read')
    ok = (isinstance(u, dict) and u.get('format') == FORMAT and u.get('kind') == 'update' and valid(u.get('manifest')) and isinstance(u.get('base'), dict)
          and all(isinstance(u.get(k), list) and all(is_data(n) for n in u[k]) for k in ('add', 'replace', 'remove')))
    if not ok:
        raise Refused(CORRUPT % 'its description cannot be read')
    return u


def sha_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def apply_update(export_dir, update_zip, fail_after=None):
    """The rules FLEX Field applies an update by (MapStore.kt applyUpdate does the same; this one is the reference the
    tests run). export_dir = a map's data files with its manifest.json. The new set is built in a folder beside it,
    every file checked against the new manifest, then swapped in; until the swap the old map is whole.
    fail_after (tests): stop after that many files, as a phone switched off half way would."""
    u = read_update(update_zip)
    if u is None:
        raise Refused('This zip is not an update.')
    try:
        cur = json.load(open(os.path.join(export_dir, 'manifest.json'), encoding='utf-8'))
    except Exception:
        cur = None
    if not valid(cur):
        raise Refused(NEEDS_FULL)
    if cur['files_hash'] != u['base'].get('files_hash'):
        raise Refused(WRONG_BASE % (u['base'].get('exported') or 'unknown', cur.get('exported') or 'unknown'))
    new = u['manifest']; changed = set(u['add']) | set(u['replace'])
    work = export_dir.rstrip('/\\') + '.new'; old = export_dir.rstrip('/\\') + '.old'
    import shutil
    shutil.rmtree(work, ignore_errors=True); os.makedirs(work)
    try:
        with zipfile.ZipFile(update_zip) as zf:
            have = set(zf.namelist()); done = 0
            for name, f in sorted(new['files'].items()):
                dst = os.path.join(work, name)
                if name in changed:
                    if name not in have:
                        raise Refused(CORRUPT % ('%s is missing' % name))
                    with zf.open(name) as src, open(dst, 'wb') as o:
                        shutil.copyfileobj(src, o, 1 << 20)
                else:
                    src = os.path.join(export_dir, name)
                    if not os.path.isfile(src):
                        raise Refused(WRONG_BASE % (u['base'].get('exported') or 'unknown', 'missing ' + name))
                    try:
                        os.link(src, dst)                 # no copy: the same bytes under a second name
                    except OSError:
                        shutil.copyfile(src, dst)
                if os.path.getsize(dst) != f['size'] or sha_file(dst) != f['sha256']:
                    raise Refused(CORRUPT % ('%s is not what the update says' % name) if name in changed else WRONG_BASE % (u['base'].get('exported') or 'unknown', 'changed: ' + name))
                done += 1
                if fail_after is not None and done >= fail_after:
                    raise KeyboardInterrupt('stopped half way (a test)')
        with open(os.path.join(work, 'manifest.json'), 'w', encoding='utf-8') as o:
            json.dump(new, o, separators=(',', ':'))
    except Refused:
        shutil.rmtree(work, ignore_errors=True)
        raise
    except zipfile.BadZipFile:
        shutil.rmtree(work, ignore_errors=True)
        raise Refused(CORRUPT % 'the zip cannot be read')
    shutil.rmtree(old, ignore_errors=True)
    os.rename(export_dir, old); os.rename(work, export_dir)
    shutil.rmtree(old, ignore_errors=True)
    return {'from': cur.get('exported', ''), 'to': new.get('exported', ''), 'added': len(u['add']), 'replaced': len(u['replace']), 'removed': len(u['remove']), 'bytes': u.get('bytes', 0)}


def recover(export_dir):
    """After an interrupted update: the half-built set goes; a map caught between the two renames gets its old files back."""
    import shutil
    base = export_dir.rstrip('/\\')
    if not os.path.isdir(base) and os.path.isdir(base + '.old'):
        os.rename(base + '.old', base)
    shutil.rmtree(base + '.new', ignore_errors=True); shutil.rmtree(base + '.old', ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)
    m = sub.add_parser('manifest'); m.add_argument('zip')
    u = sub.add_parser('update'); u.add_argument('--base', required=True); u.add_argument('--new', required=True); u.add_argument('--out', required=True)
    a = ap.parse_args(argv)
    if a.cmd == 'manifest':
        print(json.dumps(read_manifest(a.zip)))
        return 0
    base = json.load(open(a.base, encoding='utf-8'))
    if isinstance(base, dict) and 'manifest' in base and 'files' not in base:       # the server's export_<id>.json
        base = base['manifest']
    try:
        print(json.dumps(make_update(base, a.new, a.out)))
    except ValueError as e:
        print('ERROR: %s' % e, file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
