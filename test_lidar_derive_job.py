"""End to end test of the derive job (the script /api/lidar/derive runs), without PDAL.

The PDAL read is replaced by a synthetic cloud (made-up place) and the real
main() does everything else: projection, grid, rasters, PNG/GeoTIFF files,
derived.json with raster_bounds_lonlat, log.txt. Then a failing read: the
reason must reach stderr (the server hands it to the panel) and log.txt.
Run: python3 test_lidar_derive_job.py
"""
import io, json, os, subprocess, sys, tempfile, contextlib
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lidar_derive as L
import export_terrain as et

BBOX = [-100.5688, 45.1224, -100.5668, 45.1244]       # ~160 x 220 m around the example point 45.1234, -100.5678
ok_n = fail_n = 0
def check(label, cond, info=""):
    global ok_n, fail_n
    if cond: ok_n += 1; print("ok   " + label)
    else: fail_n += 1; print("FAIL " + label, info)

def fake_read(ept, utm_bbox, bbox_latlon=None, progress=print, zone=None, south=False):
    check("covering box passed to the reader is a lat/lon box around the drawn one",
          bbox_latlon[0] <= BBOX[0] and bbox_latlon[3] >= BBOX[3], bbox_latlon)
    check("reader got the zone", zone == 10 and not south, zone)
    rng = np.random.default_rng(7)
    e0, n0, e1, n1 = utm_bbox
    n = 60000
    x = rng.uniform(e0, e1, n); y = rng.uniform(n0, n1, n)
    g = 800 + 0.1 * (x - e0)
    z = g.copy(); c = np.full(n, 2, np.uint8)
    veg = rng.random(n) < 0.4
    z[veg] += rng.uniform(0.4, 1.4, veg.sum()); c[veg] = 3
    pit = (np.hypot(x - (e0 + e1) / 2, y - (n0 + n1) / 2) < 8) & ~veg
    z[pit] -= 6; c[pit] = 7
    progress(f"  Read {n:,} synthetic points")
    return x, y, z, c, 32600 + zone

def run_main(out, reader):
    L.read_ept_all_classes = reader
    argv = ["--ept", "synthetic", "--bbox", *map(str, BBOX), "--out-dir", out, "--cell", "4"]
    so, se = io.StringIO(), io.StringIO()
    code = 0
    with contextlib.redirect_stdout(so), contextlib.redirect_stderr(se):
        try: L.main(argv)
        except SystemExit as e: code = e.code if isinstance(e.code, int) else 1
    return code, so.getvalue(), se.getvalue()

with tempfile.TemporaryDirectory() as d:
    out = os.path.join(d, "ok")
    code, so, se = run_main(out, fake_read)
    check("run exits 0", code == 0, (code, se))
    files = set(os.listdir(out))
    for f in ["vegetation.png", "vegetation.tif", "voids.png", "voids.tif", "ground.tif", "derived.json", "log.txt"]:
        check("output has " + f, f in files, sorted(files))
    meta = json.load(open(os.path.join(out, "derived.json")))
    rb = meta["raster_bounds_lonlat"]
    check("raster_bounds_lonlat covers the drawn box, within a few cells",
          rb[0] <= BBOX[0] + 1e-9 and rb[1] <= BBOX[1] + 1e-9 and rb[2] >= BBOX[2] - 1e-9 and rb[3] >= BBOX[3] - 1e-9
          and rb[0] > BBOX[0] - 5e-4 and rb[3] < BBOX[3] + 5e-4, rb)
    check("pit found as void cells", meta["void_cells"] > 0, meta["void_cells"])
    check("log.txt has the progress", "[4/4]" in open(os.path.join(out, "log.txt")).read())
    with open(os.path.join(out, "vegetation.png"), "rb") as f:
        check("vegetation.png is a PNG", f.read(8) == b"\x89PNG\r\n\x1a\n")

    # a failing read: the reason reaches stderr and log.txt, exit 1, no derived.json
    def bad_read(*a, **k): raise SystemExit("ERROR: no points returned from EPT for this bbox")
    out2 = os.path.join(d, "bad")
    code, so, se = run_main(out2, bad_read)
    check("failed run exits 1", code == 1, code)
    check("reason on stderr", "no points returned" in se, se)
    check("reason in log.txt", "no points returned" in open(os.path.join(out2, "log.txt")).read())
    check("no derived.json on failure", not os.path.exists(os.path.join(out2, "derived.json")))

    # an unexpected exception (a bug) is reported with its type and message
    def boom(*a, **k): raise ValueError("synthetic failure")
    code, so, se = run_main(os.path.join(d, "boom"), boom)
    check("exception reported", code == 1 and "ValueError: synthetic failure" in se, se)

    # the real command line without PDAL here: says so, plainly
    out3 = os.path.join(d, "nopdal")
    r = subprocess.run([sys.executable, os.path.join(HERE, "lidar_derive.py"), "--ept", "x",
                        "--bbox", *map(str, BBOX), "--out-dir", out3], capture_output=True, text=True)
    try:
        import pdal; have = True
    except ImportError: have = False
    if not have:
        check("CLI without PDAL: exit 1 + reason", r.returncode == 1 and "pdal not installed" in r.stderr, r.stderr)
        check("CLI without PDAL: log.txt written", os.path.exists(os.path.join(out3, "log.txt")))

print(f"\n{ok_n} passed, {fail_n} failed")
sys.exit(1 if fail_n else 0)
