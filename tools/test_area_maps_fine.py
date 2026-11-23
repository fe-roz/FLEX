#!/usr/bin/env python3
"""area_maps.py, round 2: the fine ground (median per cell + pyramid fill) from sparse ground returns, the
multidirectional hillshade, the slope level table, 16-level encoding (and decoding version 1), brush and voids in
blocks of 3 x maps_cell, and the maps step from stored points. Made-up scene in UTM 14N (near 45.1234, -100.5678)."""
import json, math, os, subprocess, sys, tempfile
import numpy as np
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
import area_maps as am
ok_n = bad_n = 0
def ok(name, cond, info=""):
    global ok_n, bad_n
    if cond: ok_n += 1
    else: bad_n += 1; print("FAIL", name, info)

# levels
ok("16 even levels", list(am.enc_even(np.array([0, 0.0624, 0.0626, 0.999, 1.5, np.nan]), 0, 1)) == [1, 1, 2, 16, 16, 0])
ok("slope table: 16 levels, 2-4 deg steps from 25 to 50", len(am.SLOPE_LEVELS) == 16 and all(0 < b - a <= 5 for a, b in zip(am.SLOPE_LEVELS, am.SLOPE_LEVELS[1:]) if 25 <= a < 50))
ok("slope encoding by edges", list(am.enc_edges(np.array([0, 4.9, 26, 27, 44.9, 45, 89, np.nan]), am.SLOPE_LEVELS)) == [1, 1, 6, 7, 12, 13, 16, 0])
m = am.slope_map()
ok("decode version 2 (values)", am.decode(np.array([0, 1, 13], np.uint8), m)[2] == 45 and np.isnan(am.decode(np.array([0], np.uint8), m)[0]))
ok("decode version 1 (1..255 over min..max)", abs(am.decode(np.array([255, 128], np.uint8), {"min": 0, "max": 90})[0] - 90) < 1e-9)

# multidirectional hillshade
cell = 1.0
yy, xx = np.mgrid[0:60, 0:60].astype(np.float32)
flat = np.zeros((60, 60), np.float32)
s, h = am.slope_shade(flat, cell)
ok("flat ground: slope 0, shade = sin(45 deg)", abs(float(s[30, 30])) < 1e-6 and abs(float(h[30, 30]) - math.sin(math.radians(45))) < 1e-4, float(h[30, 30]))
plane = (xx * 1.0).astype(np.float32)        # rises eastward 45 deg: faces west
s, h = am.slope_shade(plane, cell)
ok("plane 45 deg: slope 45", abs(float(s[30, 30]) - 45) < 0.01)
# west-facing slope (aspect 270): weights sin^2(270-az): 225 -> .5, 270 -> 0, 315 -> .5, 360 -> 1
L = lambda az: max(0.0, (-1 * math.cos(math.radians(45)) * math.sin(math.radians(az)) + math.sin(math.radians(45))) / math.sqrt(2))
want = (0.5 * L(225) + 0 * L(270) + 0.5 * L(315) + 1 * L(360)) / 2
ok("plane: the multidirectional formula", abs(float(h[30, 30]) - want) < 1e-4, (float(h[30, 30]), want))
r = np.hypot(xx - 30, yy - 30); cone = (30 - r).astype(np.float32)
s, h = am.slope_shade(cone, cell)
faces = [h[30, 45], h[45, 30], h[30, 15], h[15, 30]]     # E, N, W, S faces (row up = north)
ok("cone: every face keeps light (none black)", min(faces) > 0.15, faces)
ok("cone: slope 45 on the flanks", abs(float(s[30, 45]) - 45) < 1)

# pyramid fill: a smooth surface sampled at random cells (40 %), the rest filled
rng = np.random.default_rng(3)
true = (np.sin(xx / 9) * 3 + yy * 0.2).astype(np.float32)
med = np.where(rng.random(true.shape) < 0.4, true, np.nan).astype(np.float32)
fil = am.pyramid_fill(med)
err = np.abs(fil - true)
ok("fill: no gaps left", np.isfinite(fil).all())
ok("fill: data cells unchanged", np.allclose(fil[np.isfinite(med)], true[np.isfinite(med)]))
ok("fill: close to the true surface (mean error < 0.06 m)", float(err.mean()) < 0.06, float(err.mean()))
d2 = np.abs(np.diff(fil, 2, axis=1)); d2t = np.abs(np.diff(true, 2, axis=1))
ok("fill: smooth (no blocks: second differences stay small)", float(d2.max()) < 0.6 and float(np.percentile(d2, 99)) < 0.2, (float(d2.max()), float(np.percentile(d2, 99))))
med2 = med.copy(); med2[10:40, 10:40] = np.nan     # a 30 m gap
fil2 = am.pyramid_fill(med2)
ok("fill: a wide gap is bridged smoothly", np.isfinite(fil2).all() and float(np.abs(fil2 - true)[15:35, 15:35].mean()) < 1.0, float(np.abs(fil2 - true)[15:35, 15:35].mean()))

# the maps step from stored points: a made-up area with sparse ground returns
import area_ground as ag
X0, Y0 = 455000.0, 4997000.0
W = 60.0
with tempfile.TemporaryDirectory() as d:
    A = os.path.join(d, "a1"); os.makedirs(os.path.join(A, "ground"))
    # saved ground at 1 m (a plane 0.3 m/m eastward, the true surface)
    gm = {"x0": X0, "y0": Y0, "cell": 1.0, "nx": 60, "ny": 60, "zone": 14, "south": False, "epsg": 32614, "row0": "south"}
    json.dump(gm, open(os.path.join(A, "ground", "grid.json"), "w"))
    gx = (np.arange(60) + 0.5)[None, :].repeat(60, 0)
    np.save(os.path.join(A, "ground", "ground.npy"), (500 + 0.3 * gx).astype(np.float32))
    surf = lambda x, y: 500 + 0.3 * (x - X0) + 0.5 * np.sin((y - Y0) / 5)
    n = int(7 * W * W)                                   # 7 ground returns per m2
    gxs, gys = X0 + rng.uniform(0, W, n), Y0 + rng.uniform(0, W, n)
    nb = int(12 * 20 * W)                                # brush 1 m tall in x 0..20 m, 12 per m2
    bxs, bys = X0 + rng.uniform(0, 20, nb), Y0 + rng.uniform(0, W, nb)
    vx, vy = X0 + 40 + rng.uniform(0, 2, 50), Y0 + 40 + rng.uniform(0, 2, 50)    # a hole 3 m down
    x = np.concatenate([gxs, bxs, vx]); y = np.concatenate([gys, bys, vy])
    z = np.concatenate([surf(gxs, gys), surf(bxs, bys) + 1.0, surf(vx, vy) - 3.0])
    c = np.concatenate([np.full(n, 2), np.full(nb, 1), np.full(50, 7)]).astype(np.uint8)
    import route_cost as rc
    P = rc.Points(X0, Y0); P.add(x, y, z, c); P = P.finish()
    ag.save_points(P, os.path.join(A, "points"), {"ox": X0, "oy": Y0, "bbox_utm": [X0, Y0, X0 + W, Y0 + W]})
    lon, lat = -100.5678, 45.1234
    json.dump({"id": "a1", "ring": []}, open(os.path.join(A, "area.json"), "w"))
    r = subprocess.run([sys.executable, os.path.join(HERE, "area_maps.py"), A, "--maps-cell", "0.3", "--band", "0.3", "2.0"], capture_output=True, text=True)
    ok("maps step ran", r.returncode == 0, r.stdout[-400:] + r.stderr[-600:])
    gj = json.load(open(os.path.join(A, "ground", "maps.json"))); g = gj["grid"]
    ok("ground maps.json: 0.3 m, 200 x 200, 16 levels", g["cell"] == 0.3 and g["nx"] == 200 and g["ny"] == 200 and all(q["levels"] == 16 for q in gj["maps"]), g)
    ok("the fine ground is not kept", not [f for f in os.listdir(os.path.join(A, "ground")) if f.startswith(".fine")])
    ok("about half the cells had a ground return", 0.35 < gj["cells_with_ground"] < 0.6, gj["cells_with_ground"])
    sl = am.decode(np.fromfile(os.path.join(A, "ground", "slope.u8"), np.uint8).reshape(200, 200), gj["maps"][0])
    want_s = math.degrees(math.atan(0.3))     # ~16.7 deg (+ the small sine across y)
    mid = sl[20:180, 20:180]
    ok("slope of the made-up ground mostly in the 15-20 deg level", np.mean((mid >= 10) & (mid <= 20)) > 0.6, np.mean((mid >= 10) & (mid <= 20)))
    hs = np.fromfile(os.path.join(A, "ground", "hillshade.u8"), np.uint8).reshape(200, 200)
    ok("hillshade written, all levels in 1..16", hs.min() >= 1 and hs.max() <= 16)
    bj = json.load(open(os.path.join(A, "bush", "maps.json"))); bg = bj["grid"]
    ok("brush blocks of 0.9 m on their own grid", abs(bg["cell"] - 0.9) < 1e-9 and bg["nx"] == 67 and bj["block"] == bg["cell"], bg)
    bv = am.decode(np.fromfile(os.path.join(A, "bush", "brush.u8"), np.uint8).reshape(bg["ny"], bg["nx"]), bj["maps"][0])
    xs = (np.arange(bg["nx"]) + 0.5) * bg["cell"]
    inb, out = np.nanmean(bv[:, (xs > 2) & (xs < 18)]), np.nanmean(bv[:, (xs > 25) & (xs < 55)])
    ok("brush reads high in the brush (12 of 19 reaching)", 0.5 < inb < 0.75, inb)
    ok("brush reads none on bare ground", out < 0.07, out)
    ok("brush: 16 levels and cut-offs 10/30/60 %", bj["maps"][0]["levels"] == 16 and bj["maps"][0]["cuts"] == [0.1, 0.3, 0.6])
    vv = am.decode(np.fromfile(os.path.join(A, "bush", "voids.u8"), np.uint8).reshape(bg["ny"], bg["nx"]), bj["maps"][1])
    ok("the hole shows in voids (about 3 m)", np.nanmax(vv) >= 2 and np.isfinite(vv).sum() < 30, (np.nanmax(vv), np.isfinite(vv).sum()))
    # no stored points: a plain error
    import shutil; shutil.rmtree(os.path.join(A, "points"))
    r = subprocess.run([sys.executable, os.path.join(HERE, "area_maps.py"), A, "--maps-cell", "0.5"], capture_output=True, text=True)
    ok("no stored points: a plain error", r.returncode == 1 and "not stored" in r.stdout, r.stdout[-300:])
    r = subprocess.run([sys.executable, os.path.join(HERE, "area_maps.py"), A, "--maps-cell", "5"], capture_output=True, text=True)
    ok("a detail out of range is refused", r.returncode == 1, r.stdout[-200:])
print("test_area_maps_fine: %d passed, %d failed" % (ok_n, bad_n)); sys.exit(1 if bad_n else 0)
