"""Headless tests of FLEX Field: the viewer in a browser (projects and caves,
notes, leads, documents with TIFF pages, field survey, change log, undo, sync
files between two browser profiles and an edit conflict), the viewer and map
list in app mode against a stand-in for the Kotlin side (app_sim.py: import,
update, the project library, pages picked on the phone, sync files written
and read, delete), and updating a cave from a PLT. All on a made-up export
("Cave Ridge", tools/make_synthetic_export.py); no real survey data. The rules
themselves (replay, merge, conflicts, survey maths) are in
tools/test_flexlib.js (node).

    pip install playwright && python -m playwright install chromium
    python tools/flexfield_tests/run_all.py          (the exporter's environment)

Files (the synthetic export, screenshots) go to $FF_WORK or a temp folder.
"""
import os, subprocess, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from _work import WORK

def prepare():
    exp = Path(WORK) / 'export'
    if not (exp / 'caves.json').exists():
        subprocess.run([sys.executable, str(HERE.parent / 'make_synthetic_export.py'), str(exp)], check=True)
    img = Path(WORK) / 'notepage.png'
    if not img.exists():
        from PIL import Image, ImageDraw
        im = Image.new('RGB', (900, 1200), 'white'); d = ImageDraw.Draw(im)
        for k in range(12):
            d.line([(40, 100 + 80 * k), (860, 100 + 80 * k)], fill='black', width=2)
        im.save(img)

if __name__ == '__main__':
    prepare()
    bad = []
    for t in ('test_ff_browser.py', 'test_ff_app.py', 'test_ff_update.py'):
        print(f'── {t}', flush=True)
        r = subprocess.run([sys.executable, str(HERE / t)], env={**os.environ, 'FF_WORK': WORK})
        if r.returncode:
            bad.append(t)
    print('all passed' if not bad else 'FAILED: ' + ', '.join(bad))
    sys.exit(1 if bad else 0)
