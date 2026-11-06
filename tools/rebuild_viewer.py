#!/usr/bin/env python3
"""
Re-make an export's viewer.html with the current viewer template.

An export zip carries its parts as sidecars (terrain.glb, tex_sat.jpg,
tex_hs.jpg, walls.bin, caves.json, docs.json) next to the single-file viewer.html. This
puts them back into the template in viewer_build/ -- so a viewer fix reaches
an export without running the terrain pipeline again. Standard library only:

    python tools/rebuild_viewer.py FLEX-Name.zip            -> FLEX-Name-rebuilt.zip
    python tools/rebuild_viewer.py FLEX-Name.zip -o out.zip

Every other entry is copied unchanged. (The Android build already reads the
template itself: re-run android/tools/assemble_assets.py instead.)
"""
import argparse, base64, json, os, sys, zipfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from viewer_inline import build_inline_viewer, local_viewer_libs, docs_inline_json


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('export', help='an export .zip from FLEX')
    ap.add_argument('-o', '--out', help='output zip (default: <export>-rebuilt.zip)')
    args = ap.parse_args()
    src = Path(args.export)
    out = Path(args.out) if args.out else src.with_name(src.stem + '-rebuilt.zip')
    if out.resolve() == src.resolve():
        sys.exit('ERROR: write to a new file (-o), not over the export being read')
    with zipfile.ZipFile(src) as z:
        names = set(z.namelist())
        missing = {'terrain.glb', 'tex_sat.jpg', 'caves.json'} - names
        if missing:
            sys.exit(f"ERROR: {src.name} has no {', '.join(sorted(missing))} -- an export from before the sidecars can't be rebuilt")
        caves = json.loads(z.read('caves.json'))
        tex_b64 = base64.b64encode(z.read('tex_sat.jpg')).decode('ascii')
        hs_b64 = base64.b64encode(z.read('tex_hs.jpg')).decode('ascii') if 'tex_hs.jpg' in names else None
        walls = z.read('walls.bin') if 'walls.bin' in names else None
        docs_json = docs_inline_json(json.loads(z.read('docs.json')), z.read) if 'docs.json' in names else None   # documents travel along
        html = build_inline_viewer(z.read('terrain.glb'), tex_b64, caves, local_viewer_libs(),
                                   progress=lambda m: print(m), hs_b64=hs_b64, walls_bytes=walls, docs_json=docs_json)
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zo:
            for info in z.infolist():
                if info.filename == 'viewer.html':
                    zo.writestr('viewer.html', html.encode('utf-8'))
                else:
                    zo.writestr(info, z.read(info.filename), compress_type=info.compress_type)
    print(f'Wrote {out} ({out.stat().st_size / 1e6:.0f} MB)')


if __name__ == '__main__':
    main()
