#!/usr/bin/env python3
"""
area_tiles.py -- resilient, resumable tiled reading of an area's points (FLEX).

Used by area_ground.py for big areas and network sources. Each read tile is
fetched by a CHILD process (python area_tiles.py --child ...), so a PDAL
abort (a C++ pdal_error on one failed S3 request kills the process) costs
one try of one tile, not the job. The child writes the tile straight to disk
as a chunk of the area's points store:

    DIR/points/chunks/t0007.xl.npy  yl.npy  z.npy  cls.npy
    DIR/points/chunks/t0007.json    { tile, box, n, n_ground, zg_lo, zg_hi,
                                      ox, oy, bytes }   (written LAST)

A tile counts as done only when its .json exists and every array file has
the length it records; anything else is a partial tile and is read again.
So a second run on the same folder resumes. Tries per tile: 1 + the retry
delays (FLEX_AREA_RETRY_S, default "5,20,60" seconds); FLEX_AREA_WORKERS
tiles at once (default 4); FLEX_AREA_TILE_TIMEOUT_S per try (default 1200).

Tiles are an even lattice of `tile_m` squares from the area's south-west
corner (the ground grid's origin), with tile_m a whole number of cells, so
each ground cell belongs to exactly one tile and the per-cell medians can
be made tile by tile.

Test hook (child only): FLEX_AREA_TEST_ABORT="3:2,5:99" makes tile 3 abort
(os.abort, like PDAL) on its first 2 tries and tile 5 on its first 99.
"""

import json
import math
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

ARRS = ("xl", "yl", "z", "cls")
DTYPES = {"xl": np.float32, "yl": np.float32, "z": np.float32, "cls": np.uint8}


def plan(bbox, tile_m):
    """[(index, (e0, n0, e1, n1))] over bbox, tiles of tile_m from its SW corner."""
    e0, n0, e1, n1 = bbox
    nx = max(1, int(math.ceil((e1 - e0) / tile_m - 1e-9)))
    ny = max(1, int(math.ceil((n1 - n0) / tile_m - 1e-9)))
    out = []
    for j in range(ny):
        for i in range(nx):
            out.append((j * nx + i, (e0 + i * tile_m, n0 + j * tile_m,
                                     min(e1, e0 + (i + 1) * tile_m),
                                     min(n1, n0 + (j + 1) * tile_m))))
    return out


def chunk_dir(area_dir):
    return os.path.join(area_dir, "points", "chunks")


def tile_meta(cdir, t):
    """The tile's record when it is complete on disk, else None."""
    p = os.path.join(cdir, f"t{t:04d}.json")
    try:
        with open(p) as f:
            m = json.load(f)
        for k in ARRS:
            fp = os.path.join(cdir, f"t{t:04d}.{k}.npy")
            if m["n"] == 0:
                continue
            a = np.load(fp, mmap_mode="r")
            if len(a) != m["n"]:
                return None
        return m
    except Exception:
        return None


def tile_arrays(cdir, t, m=None):
    m = m or tile_meta(cdir, t)
    if m is None or m["n"] == 0:
        return None
    return {k: np.load(os.path.join(cdir, f"t{t:04d}.{k}.npy"), mmap_mode="r")
            for k in ARRS}


# --------------------------------------------------------------------------
# The child: read one tile, write it
# --------------------------------------------------------------------------

def _test_abort(cdir, t):
    spec = os.environ.get("FLEX_AREA_TEST_ABORT", "")
    for part in filter(None, spec.split(",")):
        tt, n = part.split(":")
        if int(tt) == t:
            cp = os.path.join(cdir, f"t{t:04d}.tries")
            k = int(open(cp).read()) if os.path.exists(cp) else 0
            with open(cp, "w") as f:
                f.write(str(k + 1))
            if k < int(n):
                # leave a partial file behind, as a killed read would
                np.save(os.path.join(cdir, f"t{t:04d}.xl.npy"), np.zeros(3, np.float32))
                os.abort()


def read_tile(source, box, zone, south):
    """x, y, z, cls (float64 x/y/z, uint8 cls) of the tile, half-open box."""
    import lidar_derive as ld
    xs, ys, zs, cs = [], [], [], []
    if "npz" in source:
        d = np.load(source["npz"], mmap_mode="r")
        x, y = np.asarray(d["x"]), np.asarray(d["y"])
        k = np.nonzero((x >= box[0]) & (x < box[2]) & (y >= box[1]) & (y < box[3]))[0]
        xs.append(x[k]); ys.append(y[k]); zs.append(np.asarray(d["z"])[k])
        cs.append(np.asarray(d["classification"])[k] if "classification" in d.files
                  else np.ones(len(k), np.uint8))
    else:
        import route_cost as rc
        epts = [source["ept"]] + [u for u in (source.get("ept_also") or []) if u]
        cover = rc.et().latlon_box_covering(box, zone, south)
        for url in epts:
            try:
                x, y, z, c, _ = ld.read_ept_all_classes(url, box, cover, zone=zone, south=south,
                                                        progress=lambda m: None)
            except SystemExit as e:
                if "no points" in str(e.code):
                    continue
                raise
            k = (x >= box[0]) & (x < box[2]) & (y >= box[1]) & (y < box[3])
            xs.append(x[k]); ys.append(y[k]); zs.append(z[k])
            cs.append(c[k] if c is not None else np.ones(int(k.sum()), np.uint8))
    cat = lambda L, dt: np.concatenate(L) if L else np.zeros(0, dt)
    return (cat(xs, float), cat(ys, float), cat(zs, float),
            np.clip(cat(cs, np.int16), 0, 255).astype(np.uint8))


def write_tile(cdir, t, box, ox, oy, x, y, z, c):
    for k in ARRS:                         # a new try starts clean
        for suf in (".npy", ".tmp.npy"):
            p = os.path.join(cdir, f"t{t:04d}.{k}{suf}")
            if os.path.exists(p):
                os.remove(p)
    arrs = {"xl": (x - ox).astype(np.float32), "yl": (y - oy).astype(np.float32),
            "z": z.astype(np.float32), "cls": c.astype(np.uint8)}
    if len(z):
        for k, a in arrs.items():
            tmp = os.path.join(cdir, f"t{t:04d}.{k}.tmp.npy")
            np.save(tmp, a)
            os.replace(tmp, os.path.join(cdir, f"t{t:04d}.{k}.npy"))
    g = c == 2
    zg = z[g]
    m = {"tile": t, "box": list(box), "n": int(len(z)), "n_ground": int(g.sum()),
         "zg_lo": float(np.percentile(zg, 0.5)) if len(zg) else None,
         "zg_hi": float(np.percentile(zg, 99.5)) if len(zg) else None,
         "ox": ox, "oy": oy, "bytes": int(13 * len(z))}
    tmp = os.path.join(cdir, f"t{t:04d}.json.tmp")
    with open(tmp, "w") as f:
        json.dump(m, f)
    os.replace(tmp, os.path.join(cdir, f"t{t:04d}.json"))
    return m


def child_main(argv):
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--child", action="store_true")
    ap.add_argument("--job", required=True)
    ap.add_argument("--tile", type=int, required=True)
    a = ap.parse_args(argv)
    with open(a.job) as f:
        job = json.load(f)
    cdir = job["cdir"]
    t = a.tile
    box = job["tiles"][str(t)]
    _test_abort(cdir, t)
    x, y, z, c = read_tile(job["source"], box, job["zone"], job["south"])
    m = write_tile(cdir, t, box, job["ox"], job["oy"], x, y, z, c)
    print(json.dumps({"n": m["n"]}))
    return 0


# --------------------------------------------------------------------------
# The parent: every tile, in children, with retries; resumes
# --------------------------------------------------------------------------

def fetch_all(area_dir, source, bbox, tile_m, zone, south, say, stop_after=None):
    """Read every tile not yet on disk. Returns (done {t: meta}, failed [t], tiles)."""
    cdir = chunk_dir(area_dir)
    os.makedirs(cdir, exist_ok=True)
    tiles = plan(bbox, tile_m)
    ox, oy = float(bbox[0]), float(bbox[1])
    job = {"cdir": cdir, "source": source, "zone": int(zone), "south": bool(south),
           "ox": ox, "oy": oy, "tiles": {str(t): list(b) for t, b in tiles}}
    # a store made for another box / tile size / source is not reused
    sig = json.dumps({"bbox": [round(v, 3) for v in bbox], "tile_m": tile_m,
                      "source": source, "zone": int(zone)}, sort_keys=True)
    sp = os.path.join(cdir, "store.json")
    old = None
    try:
        old = open(sp).read()
    except Exception:
        pass
    if old != sig:
        for f in os.listdir(cdir):
            os.remove(os.path.join(cdir, f))
        with open(sp, "w") as f:
            f.write(sig)
    jp = os.path.join(cdir, "job.json")
    with open(jp, "w") as f:
        json.dump(job, f)
    done = {}
    todo = []
    for t, _b in tiles:
        m = tile_meta(cdir, t)
        if m is not None:
            done[t] = m
        else:
            todo.append(t)
    n = len(tiles)
    if done:
        say(f"[1/4] {len(done)} of {n} tiles already on disk (resuming)")
    delays = [float(v) for v in os.environ.get("FLEX_AREA_RETRY_S", "5,20,60").split(",") if v.strip()]
    workers = max(1, int(os.environ.get("FLEX_AREA_WORKERS", "4")))
    timeout = float(os.environ.get("FLEX_AREA_TILE_TIMEOUT_S", "1200"))
    if stop_after is not None:
        todo = todo[:stop_after]
    count = [len(done)]
    failed = []

    def one(t):
        err = ""
        for k in range(len(delays) + 1):
            if k:
                time.sleep(delays[k - 1])
            try:
                p = subprocess.run([sys.executable, os.path.abspath(__file__), "--child",
                                    "--job", jp, "--tile", str(t)],
                                   capture_output=True, text=True, timeout=timeout)
                ok = p.returncode == 0
                err = (p.stderr or "").strip().splitlines()[-1:] or [f"exit {p.returncode}"]
                err = err[0]
            except subprocess.TimeoutExpired:
                ok, err = False, "timed out"
            m = tile_meta(cdir, t) if ok else None
            if m is not None:
                return t, m, k
            say(f"  tile {t + 1}: try {k + 1} failed ({err[:120]})"
                + (f", again in {delays[k]:.0f} s" if k < len(delays) else ""))
        return t, None, len(delays)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for fut in as_completed([ex.submit(one, t) for t in todo]):
            t, m, _k = fut.result()
            if m is None:
                failed.append(t)
                continue
            done[t] = m
            count[0] += 1
            say(f"[1/4] reading tile {count[0]}/{n} ({m['n']:,} points)")
    return done, failed, tiles


if __name__ == "__main__":
    if "--child" in sys.argv:
        sys.exit(child_main(sys.argv[1:]))
    print("area_tiles.py is used by area_ground.py")
    sys.exit(2)
