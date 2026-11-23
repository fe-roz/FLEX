#!/usr/bin/env python3
"""The area brush map: of the returns that reached brush height, the share the band stopped.
Made-up scene: the same brush in the open and under a canopy must read the same; bare ground reads 0;
a cell that almost nothing reaches is left blank."""
import json, os, subprocess, sys, tempfile
import numpy as np
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ok_n = bad_n = 0
def ok(name, cond, info=""):
    global ok_n, bad_n
    if cond: ok_n += 1
    else: bad_n += 1; print("FAIL", name, info)

rng = np.random.default_rng(5)
X0, Y0 = 455000.0, 4997000.0                      # made-up UTM 14N, near the example 45.1234, -100.5678
def pts(n_per_m2, x0, x1, z, cls):
    n = int(n_per_m2 * (x1 - x0) * 60)
    return rng.uniform(x0, x1, n), rng.uniform(0, 60, n), np.full(n, z) + rng.normal(0, 0.03, n), np.full(n, cls, np.uint8)
parts = [pts(3, 0, 90, 0.0, 2),                    # ground everywhere
         pts(12, 0, 30, 1.0, 1),                   # brush in the open (x 0-30)
         pts(12, 30, 60, 1.0, 1), pts(60, 30, 60, 15.0, 1),   # the same brush under a canopy (x 30-60)
         ]                                         # x 60-90: bare
x = np.concatenate([p[0] for p in parts]) + X0; y = np.concatenate([p[1] for p in parts]) + Y0
z = np.concatenate([p[2] for p in parts]) + 500.0; c = np.concatenate([p[3] for p in parts])
with tempfile.TemporaryDirectory() as d:
    npz = os.path.join(d, "p.npz"); np.savez(npz, x=x, y=y, z=z.astype(np.float32), classification=c, epsg=32614)
    area = os.path.join(d, "area"); pj = os.path.join(d, "p.json"); json.dump({"cell": 1.0}, open(pj, "w"))
    r = subprocess.run([sys.executable, os.path.join(HERE, "area_ground.py"), "--params", pj, "--area-dir", area, "--points-npz", npz],
                       capture_output=True, text=True)
    ok("ground made", r.returncode == 0, r.stdout[-300:] + r.stderr[-300:])
    out = os.path.join(area, "bush")
    r = subprocess.run([sys.executable, os.path.join(HERE, "lidar_derive.py"), "--area-dir", area, "--out-dir", out],
                       capture_output=True, text=True)
    ok("bushwhack ran on the area", r.returncode == 0, r.stdout[-300:] + r.stderr[-300:])
    m = json.load(open(os.path.join(out, "maps.json"))); g = m["grid"]
    b = [q for q in m["maps"] if q["id"] == "brush"][0]
    raw = np.fromfile(os.path.join(out, b["file"]), np.uint8).reshape(g["ny"], g["nx"])
    sys.path.insert(0, HERE); import area_maps
    val = area_maps.decode(raw, b)            # 16 levels (round 2): each level stands for its centre
    xs = g["x0"] + (np.arange(g["nx"]) + 0.5) * g["cell"] - X0
    openb = np.nanmean(val[:, (xs > 3) & (xs < 27)]); under = np.nanmean(val[:, (xs > 33) & (xs < 57)])
    bare = val[:, (xs > 63) & (xs < 87)]
    ok("brush in the open reads about 0.8 (12 of 15 returns reaching it)", 0.7 < openb < 0.92, openb)
    ok("the same brush under a canopy reads the same (not diluted)", abs(under - openb) < 0.06, (openb, under))
    ok("bare ground reads nothing", np.nanmax(np.nan_to_num(bare)) < 0.05, np.nanmax(np.nan_to_num(bare)))
    ok("the units say what is measured", "reaching" in b["units"], b["units"])
    dj = json.load(open(os.path.join(out, "derived.json")))
    ok("derived.json names the measure", dj.get("brush_measure") == "reached", dj.get("brush_measure"))
print("test_brush_measure: %d passed, %d failed" % (ok_n, bad_n)); sys.exit(1 if bad_n else 0)
