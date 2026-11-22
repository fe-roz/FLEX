#!/usr/bin/env python3
"""Tests for tools/ground_compare.py (made-up scenes only, no real data)."""

import contextlib
import io
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))

import numpy as np            # noqa: E402
import ground_compare as gc   # noqa: E402

FAILS = []


def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        FAILS.append(msg)


def quiet(fn, *a, **k):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **k)


def main():
    tmp = tempfile.mkdtemp(prefix="gc_test_")

    # every scene builds, has ground returns and a finite truth
    for n in gc.SCENES:
        S = gc.make_scene(n)
        t = S["truth"](S["x"][:1000], S["y"][:1000])
        check(len(S["x"]) > 100000 and (S["classification"] == 2).sum() > 10000
              and np.isfinite(t).all(), f"scene {n} builds")
    S = gc.make_scene("lownoise")
    check((S["classification"] == 7).sum() > 500, "lownoise has class 7 points")
    S = gc.make_scene("pit_c7")
    check((S["classification"] == 7).sum() > 10, "pit_c7 labels the pit floor 7")

    # flat scene: all three within sane bounds of the truth
    out = os.path.join(tmp, "flat")
    rc_ = quiet(gc.main, ["--scene", "flat", "--out", out, "--no-mem"])
    check(rc_ == 0, "flat run exits 0")
    rep = json.load(open(os.path.join(out, "summary.json")))
    for m in gc.MODELS:
        s = rep["models"][m]["vs_truth"]
        check(abs(s["mean"]) < 0.15 and s["rms"] < 0.3,
              f"flat: {m} mean {s['mean']} rms {s['rms']} within bounds")
        for k in ("vs_ground_returns", "vs_ground_returns_by_slope",
                  "vs_lowest_return", "seconds", "peak_mb"):
            check(k in rep["models"][m], f"flat: {m} has {k}")
        check(os.path.exists(os.path.join(out, m + ".npy")), f"flat: {m}.npy written")
    for k in ("routes-export", "routes-bushwhack", "export-bushwhack"):
        check(k in rep["differences"], f"difference {k} reported")
    check(os.path.exists(os.path.join(out, "diff_routes_export.npy")), "diff grid written")
    check(os.path.exists(os.path.join(out, "truth.npy")), "truth grid written")
    check(set(rep["own_default_cell"]) == set(gc.MODELS), "own default cell runs")
    txt = open(os.path.join(out, "summary.txt")).read()
    check(all(ord(c) < 128 for c in txt), "summary.txt is ASCII")

    # pits: depth kept is reported, and a class-2 pit survives in Routes/Bushwhack
    out = os.path.join(tmp, "pits")
    rc_ = quiet(gc.main, ["--scene", "pit,pit_c7", "--out", out, "--no-mem",
                          "--no-defaults"])
    check(rc_ == 0, "pit scenes exit 0")
    rep = json.load(open(os.path.join(out, "summary.json")))
    kept = {m: [p["kept"] for p in rep["pit"]["models"][m]["pits"]] for m in gc.MODELS}
    check(min(kept["routes"]) > 0.8 and min(kept["bushwhack"]) > 0.8,
          f"class-2 pits survive in routes/bushwhack {kept}")
    k7 = {m: [p["kept"] for p in rep["pit_c7"]["models"][m]["pits"]] for m in gc.MODELS}
    check(min(k7["bushwhack"]) > 0.8, f"bushwhack keeps class-7 pits {k7['bushwhack']}")

    # points file input and the 3D view
    S = gc.make_scene("slope")
    npz = os.path.join(tmp, "pts.npz")
    np.savez(npz, x=S["x"] + 500000.0, y=S["y"] + 5000000.0, z=S["z"],
             classification=S["classification"], epsg=32600)
    html = os.path.join(tmp, "view.html")
    rc_ = quiet(gc.main, ["--points-npz", npz, "--out", os.path.join(tmp, "npz"),
                          "--no-mem", "--no-defaults", "--cell", "2", "--html", html])
    check(rc_ == 0, "points-npz run with --html exits 0")
    page = open(html).read() if os.path.exists(html) else ""
    check("THREE.WebGLRenderer" in page and "__DATA__" not in page
          and "/*THREE_JS*/" not in page, "view has three.js and data inlined")
    check("500" not in json.loads(page.split("var DATA = ", 1)[1].split(";\n", 1)[0])
          ["datasets"][0].get("label", ""), "view carries no absolute coordinates label")
    check("http://" not in page.split("<script>", 1)[0] and "src=\"http" not in page,
          "view loads nothing from the network")

    # exit codes
    check(quiet(gc.main, ["--scene", "nosuch", "--out", tmp]) == 2, "unknown scene exits 2")
    check(quiet(gc.main, ["--scene", "flat", "--out", tmp, "--cell", "-1"]) == 2,
          "bad cell exits 2")
    check(quiet(gc.main, ["--out", tmp]) == 2, "no input exits 2")
    check(quiet(gc.main, ["--points-npz", os.path.join(tmp, "missing.npz"),
                          "--out", tmp]) == 1, "missing file exits 1")

    print(f"\n{'FAILED ' + str(len(FAILS)) if FAILS else 'all passed'}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
