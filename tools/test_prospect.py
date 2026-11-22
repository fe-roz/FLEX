#!/usr/bin/env python3
"""Tests for prospect.py on its made-up scene (no PDAL):
python3 tools/test_prospect.py"""

import csv
import json
import math
import os
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import prospect as pr          # noqa: E402
import route_cost as rc        # noqa: E402

FAILS = []
N = [0]


def check(cond, msg):
    N[0] += 1
    if not cond:
        FAILS.append(msg)
        print("FAIL", msg)


def local(p):
    e0, n0, zone = rc.example_origin()
    x, y = rc.lonlat_to_xy(p["lon"], p["lat"], zone)
    return x - e0, y - n0


def near(cands, kind, xy, r):
    out = []
    for p in cands:
        if p["kind"] != kind:
            continue
        x, y = local(p)
        if math.hypot(x - xy[0], y - xy[1]) <= r:
            out.append(p)
    return out


def quiet(_m):
    pass


def main():
    tmp = tempfile.mkdtemp(prefix="prospect_test_")
    try:
        out = os.path.join(tmp, "demo")
        summary, cands = pr.demo(out, say=quiet)
        listed = [p for p in cands if not p.get("isolated")]
        D = pr.DEMO

        # A: the sink with a class-2 floor
        a = near(listed, "A", D["sink2"][:2], 4.0)
        check(len(a) == 1, f"one A at the class-2 sink, got {len(a)}")
        if a:
            check(1.8 <= a[0]["depth_m"] <= 2.7, f"sink depth {a[0]['depth_m']}")
            check(a[0]["measured"] > 0.7, "sink measured by class 2")
            check(a[0]["floor_above"] is False, "bare sink: nothing above")
            check(a[0]["nearest_known_name"] == "Cave Ridge T6" and
                  15 <= a[0]["nearest_known_m"] <= 25, "nearest known")
            check(a[0]["title"].startswith("A-0001 sink"), a[0]["title"])
        # B: the class-7-floor sink, brush over it
        b7 = near(listed, "B", D["sink7"][:2], 4.0)
        check(len(b7) == 1, f"one B at the class-7 sink, got {len(b7)}")
        if b7:
            p = b7[0]
            check(p["share_c7"] > 0.8, f"class-7 share {p['share_c7']}")
            check(p["floor_above"] is True and p["floor_above_h"] is not None
                  and p["floor_above_h"] < 2.5, "brush over the class-7 sink")
            check(not p["isolated"], "class-7 sink not isolated")
            check(p.get("pit_id"), "class-7 sink is an area pit")
        # B: the shaft
        sh = near(listed, "B", D["shaft"][:2], 2.0)
        check(len(sh) == 1, f"one B at the shaft, got {len(sh)}")
        if sh:
            p = sh[0]
            check(5.5 <= p["depth_m"] <= 6.5, f"shaft depth {p['depth_m']}")
            check(p["points"] == 7, f"shaft points {p['points']}")
            check(p["floor_above"] is False, "nothing over the shaft")
            check(p["continuous"] and not p["isolated"], "shaft continuous")
            check(p["span_m"] <= 3.0, f"shaft span {p['span_m']}")
        # C: the alcove
        ax = D["alcove"][0]
        c = near(listed, "C", (ax, D["cliff_y"] + 3.5), 4.0)
        check(len(c) == 1, f"one C at the alcove, got {len(c)}")
        if c:
            p = c[0]
            check(p["face_slope_deg"] > 70, f"face slope {p['face_slope_deg']}")
            check(12 <= p["face_height_m"] <= 20, f"face height {p['face_height_m']}")
            check(150 <= p["aspect_deg"] <= 210, f"aspect {p['aspect_deg']}")
            check(1.5 <= p["depth_into_face_m"] <= 6, "depth into face")
            check(p["points"] >= 50, "alcove points")
        # multipath: every single deep point listed, flagged isolated
        iso = [p for p in cands if p.get("isolated")]
        for (mx, my) in pr.demo_scene()[4]["multipath"]:
            m = near(iso, "B", (mx, my), 1.5)
            check(len(m) == 1 and m[0]["points"] == 1,
                  f"multipath at {mx},{my} flagged isolated")
        check(not near(listed, "B", (20, 150), 3) , "multipath not listed")
        # bare and forest ground give nothing else
        feats = [D["sink2"][:2], D["sink7"][:2], D["shaft"][:2],
                 (ax, D["cliff_y"] + 3.5)]
        stray = [p["id"] for p in listed
                 if min(math.hypot(local(p)[0] - f[0], local(p)[1] - f[1])
                        for f in feats) > 12]
        check(not stray, f"nothing on plain ground, got {stray}")
        check(summary["counts"] == {"A": 2, "B": 2, "C": 1},
              f"counts {summary['counts']}")

        # files
        g = json.load(open(os.path.join(out, "candidates.geojson")))
        ga = json.load(open(os.path.join(out, "candidates_areas.geojson")))
        gi = json.load(open(os.path.join(out, "candidates_isolated.geojson")))
        ids = [f["properties"]["id"] for f in g["features"]]
        check(ids == [f["properties"]["id"] for f in ga["features"]],
              "points and areas share ids")
        check(len(ids) == len(set(ids)) and len(ids) == len(listed), "ids")
        for f in g["features"]:
            pp = f["properties"]
            for k in ("id", "kind", "lon", "lat", "ground_z", "points",
                      "floor_above", "cell", "tag", "note", "title",
                      "description", "nearest_known_m", "nearest_known_name"):
                check(k in pp, f"{pp['id']} has {k}")
            check(pp["tag"] == "" and pp["note"] == "", "empty tag/note")
            lon, lat = f["geometry"]["coordinates"]
            check(-101 < lon < -100 and 45 < lat < 45.3, "lon/lat order")
        for f in ga["features"]:
            ring = f["geometry"]["coordinates"][0]
            check(ring[0] == ring[-1] and len(ring) >= 4, "closed ring")
            check(pr._signed_area(ring) > 0, "exterior ring CCW")
        check(all(f["properties"]["isolated"] for f in gi["features"]),
              "isolated file holds only isolated")
        root = ET.parse(os.path.join(out, "candidates.kml")).getroot()
        ns = "{http://www.opengis.net/kml/2.2}"
        names = [pm.find(ns + "name").text for pm in root.iter(ns + "Placemark")]
        check(len(names) == len(cands), "KML has every candidate")
        check(len(root.findall(f"./{ns}Document/{ns}Folder")) == 3,
              "KML folder per kind")
        rows = list(csv.DictReader(open(os.path.join(out, "candidates.csv"))))
        check([r["id"] for r in rows] == [p["id"] for p in cands], "CSV ids")
        lj = json.load(open(os.path.join(out, "layers.json")))
        for n in ("depth", "below", "steep"):
            check(n in lj and os.path.exists(os.path.join(out, lj[n]["file"]))
                  and os.path.exists(os.path.join(out, n + ".pgw")), f"{n} layer")
            b = lj[n]["bounds"]
            check(b["west"] < b["east"] and b["south"] < b["north"], f"{n} bounds")
        sm = json.load(open(os.path.join(out, "summary.json")))
        check("timings" in sm and "a_dropped" in sm, "summary")

        # the same area as a chunk store gives the same candidates
        out2 = os.path.join(tmp, "tiled")
        params = json.load(open(os.path.join(out, "params.json")))
        params["tiled"] = True
        try:
            _s2, c2 = pr.run_standalone(params, out2, say=quiet)
            pts = json.load(open(os.path.join(out2, "_area", "points",
                                              "points.json")))
            check("tiles" in pts, "chunk store used")
            key = lambda L: sorted((p["id"], p["points"], p["depth_m"]) for p in L)
            check(key(c2) == key(cands), "chunk store: same candidates")
        except Exception as e:
            check(False, f"chunk store run: {type(e).__name__}: {e}")

        # --area-dir on the demo's area, CLI, NOTE line
        import subprocess
        r = subprocess.run([sys.executable, os.path.join(ROOT, "prospect.py"),
                            "--area-dir", os.path.join(out, "_area"),
                            "--out", os.path.join(tmp, "cli")],
                           capture_output=True, text=True, timeout=300)
        check(r.returncode == 0 and "NOTE: 5 candidates (2 sinks, 2 below-ground"
              in r.stdout, "CLI --area-dir: " + r.stdout[-300:] + r.stderr[-300:])
        # error paths
        empty = os.path.join(tmp, "empty")
        os.makedirs(empty)
        r = subprocess.run([sys.executable, os.path.join(ROOT, "prospect.py"),
                            "--area-dir", empty], capture_output=True,
                           text=True, timeout=60)
        check(r.returncode == 1 and r.stdout.strip().splitlines()[-1].startswith("! "),
              "no ground -> ! line, exit 1")
        bad = os.path.join(tmp, "bad.json")
        json.dump({"min_depth": "deep"}, open(bad, "w"))
        r = subprocess.run([sys.executable, os.path.join(ROOT, "prospect.py"),
                            "--area-dir", os.path.join(out, "_area"),
                            "--params", bad, "--out", os.path.join(tmp, "x")],
                           capture_output=True, text=True, timeout=60)
        check(r.returncode == 1 and "min_depth" in r.stdout, "bad param")
        for bp in ({"c_slope": 10}, {"b_floor": 0}, {"cell": "big"},
                   {"a_min_area": 0}):
            try:
                pr.clean_params(bp)
                check(False, f"clean_params accepts {bp}")
            except RuntimeError:
                pass
        r = subprocess.run([sys.executable, os.path.join(ROOT, "prospect.py")],
                           capture_output=True, text=True, timeout=60)
        check(r.returncode != 0, "no arguments -> error")
        # the depression fill itself
        import numpy as np
        dem = np.full((200, 200), 10.0)
        dem[50:60, 50:60] = 8.0
        dem[100:110, 100:110] = 12.0
        f = pr.fill_depressions(dem, np.zeros(dem.shape, bool))
        check(np.allclose(f[50:60, 50:60], 10.0) and
              np.allclose(f[100:110, 100:110], 12.0) and
              np.allclose(f[:40], 10.0), "fill_depressions")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"{N[0] - len(FAILS)}/{N[0]} checks passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
