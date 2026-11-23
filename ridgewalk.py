#!/usr/bin/env python3
"""
V2 - Ridgewalking, the step: what the LiDAR returns say is BELOW the ground.

    python ridgewalk.py --ept URL [--also-ept URL ...] --bbox W S E N [--polygon ring.json] --out DIR
                        [--tile 96] [--margin 12] [--workers N] [--no-shapes] [--cell 0.3]
    python ridgewalk.py --npz FILE --out DIR     points from a file (x, y, z, c, psid, and rn / nr when known; metres): tests
    python ridgewalk.py --demo DIR               a made-up scene, no PDAL, no network

The method (numbers in PARAMS):
  * fine ground: the median of the ground returns (class 2) per cell, gaps filled;
  * the lid: the ground closed over everything narrower than 2 m, and never under the level water would
    stand at in a closed hollow. It is the ground as you would walk it; it is also the display ground;
  * candidates: the returns more than 0.5 m under the lid at right angles to it;
  * a candidate is BELOW GROUND when it lies more than --min-behind (1 m) BEHIND THE LOCAL FACE: a plane fitted
    in 3D to the last returns around it that are not candidates (2.5 m around, then 1.5, then 4; at least 12
    returns; the outer sheet only), so returns lying on a wall under an overhanging lid are the wall, not a
    cave. Candidates found to lie on the face join it and the fit is repeated. Its depth is that distance (at
    most 35 m). No face can be fitted (too deep, nothing around): the lid's measure stands and it is kept;
  * patterned noise: a flight pass whose returns are deep below ground (> 3 m) far more often than the other passes'
    (>= 1 % of its returns, >= 8 x the others' share, >= 30 such returns) has its below returns set aside,
    except those another pass confirms (one within 1.5 m);
  * groups: below returns within 1.5 m of each other (2 or more); the rest are lone, and a lone return
    farther than 5 m from any other is likely noise;
  * every grouped return has a way out: the nearest point of the lid surface (sideways at a cliff). It is
    OPEN when no returns lie on the lid around that point (a hole in the ground returns: a true entrance),
    ROOFED when they do. Roofed returns are tied to a return nearer the surface, never farther than their
    own way out; a feature is the returns joined that way, wrapped in one skin when it has 4 or more;
  * holes: cells cut by open returns are true entrances (1); where a wrapped feature comes out under a
    roof the opening is a guess (2).

How the area is worked (what depends on the tile cut is said in ridge.json "notes"):
  1. the returns are read tile by tile into scratch files (PDAL, with PointSourceId);
  2. per tile, with a margin: the fine ground, stitched into one grid;
  3. one coarse water fill of the whole area (the ground thinned to 4 cells by the lowest), which is a
     floor under every tile's own fill: a hollow wider than a tile gets one level, not one per tile;
  4. per tile, with a margin: the lid, stitched into lid.npy; then the returns of the tile against it;
  5. the pass statistics per tile + its 8 neighbours; the noise, groups and lone returns over the WHOLE
     area at once (only the below returns are held, not the cloud), so no group is cut by a tile;
  6. the grouped returns fall into clusters (6 m apart on the map); each cluster is worked in a voxel box
     just around it, against the stitched lid: features are never cut or doubled, and a tile with nothing
     below ground costs almost nothing.

Outputs: see the header of write_outputs(). numpy + scipy; PDAL only for --ept.
"""
import argparse, heapq, json, math, os, shutil, sys, time
import numpy as np

PARAMS = dict(
    cell=0.3,            # m, the grid
    lid_width=2.0,       # m, the closing
    below=0.5,           # m under the lid, at right angles: the candidates
    measure='normal',    # a candidate is below ground when it lies behind the local face
    min_behind=1.0,      # m behind the face
    face_radius=[2.5, 1.5, 4.0], face_min=12, face_sheet=0.35, face_rms=0.30, face_passes=4, face_smooth=10, face_cap=150,
    max_depth=35.0,      # m
    link=1.5,            # m, returns closer than this are one group
    lone_far=5.0,        # m, a lone return farther than this from any other = likely noise
    deep=3.0,            # m, "deep" for the pass statistics
    pass_share=0.01, pass_ratio=8.0, pass_min=30, pass_confirm=1.5, pass_others=1000,
    pass_block=96.0,     # m, the statistics are kept per block of this size and judged on a block and its 8 neighbours
    max_link=12.0,       # m, the longest guessed link (a tie, or the way out to the surface) a shape may rest on
    wrap=2.0,            # m, one skin per feature
    wrap_min=4,          # returns
    hug=0.9, pull=0.5,   # wall vertices within hug of a return go half-way to it
    cluster=6.0,         # m on the map, grouped returns farther apart are worked separately
    cluster_max=64.0,     # m, a larger cluster is split (memory)
    coarse=4,            # cells, the area-wide water fill
    brush_band=[0.3, 2.0], brush_block=3, brush_min=5,
    simplify_error=0.05, # m
)
CELL = PARAMS['cell']
_C = None                # the run's settings, in every worker


def say(pct, text):
    print('[ridge] %2d%% %s' % (max(0, min(100, int(pct))), text), flush=True)


# ---------------------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------------------
def disc(r):
    k = int(np.ceil(r)); yy, xx = np.mgrid[-k:k + 1, -k:k + 1]
    return (xx * xx + yy * yy) <= r * r + 0.5


def ball(r):
    k = int(np.ceil(r)); a = np.arange(-k, k + 1) ** 2
    return np.add.outer(np.add.outer(a, a), a) <= r * r + 0.5


def bilin(A, px, py, cell):
    """A sampled at (px, py) metres from the corner of A's cell [0, 0]; values sit at the cell centres."""
    H, W = A.shape
    fx = np.clip(px / cell - 0.5, 0, max(W - 1.001, 0)); fy = np.clip(py / cell - 0.5, 0, max(H - 1.001, 0))
    i0 = fx.astype(int); j0 = fy.astype(int); a = fx - i0; b = fy - j0
    i1 = np.minimum(i0 + 1, W - 1); j1 = np.minimum(j0 + 1, H - 1)
    return A[j0, i0] * (1 - a) * (1 - b) + A[j0, i1] * a * (1 - b) + A[j1, i0] * (1 - a) * b + A[j1, i1] * a * b


def water_fill(Z):
    """Priority flood: every closed hollow filled to its spill height; the edge of Z is the outlet."""
    H, W = Z.shape
    out = Z.tolist(); done = [[False] * W for _ in range(H)]; pq = []
    for r in range(H):
        for q in ((0, W - 1) if 0 < r < H - 1 else range(W)):
            if not done[r][q]:
                done[r][q] = True; pq.append((out[r][q], r, q))
    heapq.heapify(pq)
    pop = heapq.heappop; push = heapq.heappush
    nb = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))
    while pq:
        h, r, q = pop(pq)
        for dr, dq in nb:
            rr = r + dr; qq = q + dq
            if 0 <= rr < H and 0 <= qq < W and not done[rr][qq]:
                done[rr][qq] = True
                v = out[rr][qq]
                if v < h:
                    out[rr][qq] = h; v = h
                push(pq, (v, rr, qq))
    return np.array(out, Z.dtype)


def fill_nan_nearest(A):
    from scipy import ndimage
    bad = ~np.isfinite(A)
    if not bad.any() or bad.all():
        return A
    idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
    return A[idx[0], idx[1]]


def in_ring(x, y, ring):
    """Even-odd test of points against a closed ring [[x, y], ...]."""
    x = np.asarray(x, 'f8'); y = np.asarray(y, 'f8'); ins = np.zeros(x.shape, bool)
    R = np.asarray(ring, 'f8'); n = len(R)
    for k in range(n):
        x0, y0 = R[k]; x1, y1 = R[(k + 1) % n]
        if y0 == y1:
            continue
        c = ((y0 <= y) & (y < y1)) | ((y1 <= y) & (y < y0))
        if c.any():
            ins ^= c & (x < x0 + (y - y0) * (x1 - x0) / (y1 - y0))
    return ins


# ---- map projection without pyproj (the exporting PC's PDAL environment may not have it) ----------------
_A, _F = 6378137.0, 1 / 298.257223563
_E2 = _F * (2 - _F)


def lonlat_to_utm(lon, lat, zone):
    lon = np.asarray(lon, 'f8'); lat = np.asarray(lat, 'f8')
    lo = np.radians(lon); la = np.radians(lat); lo0 = math.radians((zone - 1) * 6 - 180 + 3)
    N = _A / np.sqrt(1 - _E2 * np.sin(la) ** 2); T = np.tan(la) ** 2; C = _E2 / (1 - _E2) * np.cos(la) ** 2
    A = np.cos(la) * (lo - lo0); e2 = _E2
    M = _A * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * la - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * np.sin(2 * la)
              + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * np.sin(4 * la) - (35 * e2 ** 3 / 3072) * np.sin(6 * la))
    ep = e2 / (1 - e2)
    x = 0.9996 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T ** 2 + 72 * C - 58 * ep) * A ** 5 / 120) + 500000
    y = 0.9996 * (M + N * np.tan(la) * (A ** 2 / 2 + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24 + (61 - 58 * T + T ** 2 + 600 * C - 330 * ep) * A ** 6 / 720))
    return x, np.where(lat < 0, y + 1e7, y)


def utm_to_lonlat(x, y, zone, south):
    e2 = _E2; ep = e2 / (1 - e2)
    x = np.asarray(x, 'f8') - 500000.0; y = np.asarray(y, 'f8') - (1e7 if south else 0.0)
    mu = y / 0.9996 / (_A * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    p = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * np.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * np.sin(4 * mu)
         + (151 * e1 ** 3 / 96) * np.sin(6 * mu) + (1097 * e1 ** 4 / 512) * np.sin(8 * mu))
    s, c = np.sin(p), np.cos(p)
    N1 = _A / np.sqrt(1 - e2 * s ** 2); T1 = np.tan(p) ** 2; C1 = ep * c ** 2; R1 = _A * (1 - e2) / (1 - e2 * s ** 2) ** 1.5
    D = x / (N1 * 0.9996)
    lat = p - (N1 * np.tan(p) / R1) * (D ** 2 / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep) * D ** 4 / 24
                                       + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep - 3 * C1 ** 2) * D ** 6 / 720)
    lon = (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep + 24 * T1 ** 2) * D ** 5 / 120) / c
    return np.degrees(lon) + ((zone - 1) * 6 - 180 + 3), np.degrees(lat)


def lonlat_to_crs(lon, lat, code):
    """lon/lat -> the cloud's own CRS (for the query bounds only; PDAL reprojects the points)."""
    if code == 4326:
        return np.asarray(lon, 'f8'), np.asarray(lat, 'f8')
    if code in (3857, 900913):
        return np.radians(lon) * _A, np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)) * _A
    if 32601 <= code <= 32660 or 32701 <= code <= 32760:
        return lonlat_to_utm(lon, lat, code % 100)
    from pyproj import Transformer
    return Transformer.from_crs(4326, code, always_xy=True).transform(np.asarray(lon, 'f8'), np.asarray(lat, 'f8'))


# ---------------------------------------------------------------------------------------------------------
# Tiles and scratch files
# ---------------------------------------------------------------------------------------------------------
def tile_list(C):
    T = C['tile_c']
    return [(tj, ti) for tj in range((C['ny'] + T - 1) // T) for ti in range((C['nx'] + T - 1) // T)]


def tile_cells(C, t):
    T = C['tile_c']
    return t[0] * T, min(C['ny'], (t[0] + 1) * T), t[1] * T, min(C['nx'], (t[1] + 1) * T)


def pfile(C, t):
    return os.path.join(C['tmp'], 'p_%d_%d.npz' % t)


_cache = {}


def load_tile(C, t):
    """The returns of one tile (x, y metres from the origin; z; class; pass), a few kept in memory."""
    if t in _cache:
        return _cache[t]
    p = pfile(C, t)
    if os.path.exists(p):
        with np.load(p) as Z:
            d = (Z['x'], Z['y'], Z['z'], Z['c'], Z['psid'], Z['last'].astype(bool) if 'last' in Z.files else np.ones(len(Z['x']), bool))
    else:
        d = (np.zeros(0, 'f4'), np.zeros(0, 'f4'), np.zeros(0, 'f4'), np.zeros(0, 'u1'), np.zeros(0, 'i4'), np.zeros(0, bool))
    if len(_cache) >= 12:
        _cache.pop(next(iter(_cache)))
    _cache[t] = d
    return d


def load_box(C, x0, y0, x1, y1, ground_only=False, core=None):
    """x, y, z (f8), class, pass, last-return flag of the returns in a box (metres from the origin), from the tile
    files; with core (a tile) a seventh array says which returns are that tile's own."""
    Tm = C['tile_c'] * C['cell']; out = []
    for tj in range(max(0, int(y0 // Tm)), int(y1 // Tm) + 1):
        for ti in range(max(0, int(x0 // Tm)), int(x1 // Tm) + 1):
            x, y, z, c, ps, la = load_tile(C, (tj, ti))
            if not len(x):
                continue
            m = (x >= x0) & (x < x1) & (y >= y0) & (y < y1)
            if ground_only:
                m &= c == 2
            if m.any():
                out.append((x[m], y[m], z[m], c[m], ps[m], la[m], np.full(int(m.sum()), (tj, ti) == core)))
    if not out:
        r = (np.zeros(0), np.zeros(0), np.zeros(0), np.zeros(0, 'u1'), np.zeros(0, 'i4'), np.zeros(0, bool), np.zeros(0, bool))
    else:
        r = tuple(np.concatenate([o[k] for o in out]).astype('f8') if k < 3 else np.concatenate([o[k] for o in out]) for k in range(7))
    return r if core is not None else r[:6]


def _init(C):
    global _C
    _C = C
    _cache.clear()


def _child(conn, C, fn, it):
    try:
        _init(C); conn.send((True, fn(it)))
    except BaseException as e:
        conn.send((False, '%s' % (str(e)[:120] or type(e).__name__)))


def _one(args):
    """One item in a process of its own, stopped when it gives no answer in time (a stalled download)."""
    import multiprocessing as mp
    C, fn, it, timeout = args
    a, b = mp.Pipe(False); p = mp.Process(target=_child, args=(b, C, fn, it), daemon=True); p.start(); b.close()
    try:
        r = a.recv() if a.poll(timeout) else (False, 'no answer in %d s' % timeout)
    except (EOFError, OSError):
        r = (False, 'the process stopped')
    if p.is_alive():
        p.terminate()
    p.join(5)
    return r


def pmap(C, fn, items, lo, hi, text, lost=None, own=False):
    """fn over items in the worker processes (unordered), with progress lines from lo to hi per cent.
    A worker that dies (PDAL can take the process down) or a read that stalls (120 s) does not stop the run:
    what was not finished is tried again, each item in a process of its own, up to 3 times; an item
    still failing gives lost(item, why) when that is given, else the run stops. own: every item in a
    process of its own from the start (the reads: a second EPT read in one process has taken it down)."""
    from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
    items = list(items); n = len(items); last = [0.0]; k = 0

    def tick(k):
        if time.time() - last[0] > 1.0 or k == n:
            last[0] = time.time(); say(lo + (hi - lo) * k / max(1, n), '%s %d / %d' % (text, k, n))
    if C['workers'] <= 1 or n <= 1:
        _init(C)
        for it in items:
            k += 1; r = fn(it); tick(k); yield r
        return
    Cw = {q: v for q, v in C.items() if not q.startswith('_')}
    if C.get('_pool') is None:
        C['_pool'] = ProcessPoolExecutor(C['workers'], initializer=_init, initargs=(Cw,))
    futs = {} if own else {C['_pool'].submit(fn, it): it for it in items}; left = [(it, '') for it in items] if own else []
    for f in as_completed(futs):
        try:
            r = f.result()
        except Exception as e:
            left.append((futs[f], '%s' % (str(e)[:120] or type(e).__name__))); continue
        k += 1; tick(k); yield r
    if not left:
        return
    if not own:
        try: C['_pool'].shutdown(wait=False, cancel_futures=True)
        except Exception: pass
        C['_pool'] = None
        say(lo + (hi - lo) * k / max(1, n), '%s: %d not finished (%s), trying them again' % (text, len(left), left[0][1]))
    left = [it for it, _w in left]; why = {}
    for attempt in range(3):
        if not left: break
        nxt = []
        with ThreadPoolExecutor(min(C['workers'], len(left))) as th:
            for it, (ok, r) in zip(left, th.map(_one, [(Cw, fn, it, C.get('read_timeout') if own else None) for it in left])):
                if ok:
                    k += 1; tick(k); yield r
                else:
                    nxt.append(it); why[id(it)] = r
        left = nxt
    for it in left:
        if lost is None:
            raise SystemExit('[ridge] %s failed: %s' % (text, why.get(id(it))))
        k += 1; tick(k); yield lost(it, why.get(id(it)))


# ---------------------------------------------------------------------------------------------------------
# 1. reading
# ---------------------------------------------------------------------------------------------------------
def w_read(t):
    """One tile from the EPT source(s) into its scratch file. Returns (tile, points, error or None)."""
    C = _C; cell = C['cell']; j0, j1, i0, i1 = tile_cells(C, t)
    x0, y0, x1, y1 = i0 * cell, j0 * cell, i1 * cell, j1 * cell
    ex = np.array([x0, x1, x0, x1, (x0 + x1) / 2]) + C['ox']; ey = np.array([y0, y0, y1, y1, (y0 + y1) / 2]) + C['oy']
    lon, lat = utm_to_lonlat(ex, ey, C['zone'], C['south'])
    parts = []; err = None
    for k, (url, code) in enumerate(C['epts']):
        qx, qy = lonlat_to_crs(lon, lat, code)
        pad = 3.0 if code != 4326 else 3e-5
        if code in (3857, 900913):
            pad /= max(0.2, math.cos(math.radians(float(lat[4]))))
        pipe = [{"type": "readers.ept", "filename": url,
                 "bounds": "([%.8f,%.8f],[%.8f,%.8f])" % (qx.min() - pad, qx.max() + pad, qy.min() - pad, qy.max() + pad)},
                {"type": "filters.reprojection", "out_srs": "EPSG:%d" % C['epsg']}]
        a = None
        for attempt in range(3):
            try:
                import pdal
                pl = pdal.Pipeline(json.dumps(pipe)); pl.execute(); a = pl.arrays[0]; break
            except Exception as e:      # the network, mostly: try again
                err = '%s' % (str(e).splitlines()[0][:160] if str(e) else type(e).__name__); time.sleep(1.5 * (attempt + 1))
        if a is None:
            return t, 0, err or 'read failed'
        x = a['X'] - C['ox']; y = a['Y'] - C['oy']
        m = (x >= x0) & (x < x1) & (y >= y0) & (y < y1)
        ps = a['PointSourceId'][m].astype('i4') if 'PointSourceId' in a.dtype.names else np.zeros(int(m.sum()), 'i4')
        la = (a['ReturnNumber'][m] == a['NumberOfReturns'][m]) if 'ReturnNumber' in a.dtype.names and 'NumberOfReturns' in a.dtype.names else np.ones(int(m.sum()), bool)
        parts.append((x[m].astype('f4'), y[m].astype('f4'), a['Z'][m].astype('f4'), a['Classification'][m].astype('u1'), ps + 100000 * k, la.astype('u1')))
        del a
    n = sum(len(p[0]) for p in parts)
    np.savez(pfile(C, t), x=np.concatenate([p[0] for p in parts]), y=np.concatenate([p[1] for p in parts]),
             z=np.concatenate([p[2] for p in parts]), c=np.concatenate([p[3] for p in parts]), psid=np.concatenate([p[4] for p in parts]),
             last=np.concatenate([p[5] for p in parts]))
    return t, n, None


def split_points(C, x, y, z, c, psid, last):
    """Points held in memory (--npz, --demo) into the same scratch files a read makes."""
    Tm = C['tile_c'] * C['cell']
    key = (y // Tm).astype(np.int64) * 100000 + (x // Tm).astype(np.int64)
    o = np.argsort(key, kind='stable'); ks, st = np.unique(key[o], return_index=True); en = list(st[1:]) + [len(o)]
    for k, a, b in zip(ks, st, en):
        i = o[a:b]
        np.savez(pfile(C, (int(k // 100000), int(k % 100000))), x=x[i].astype('f4'), y=y[i].astype('f4'), z=z[i].astype('f4'),
                 c=c[i].astype('u1'), psid=psid[i].astype('i4'), last=last[i].astype('u1'))


# ---------------------------------------------------------------------------------------------------------
# 2. fine ground, 4. lid, classification
# ---------------------------------------------------------------------------------------------------------
def w_ground(t):
    """The fine ground of one tile (worked with the margin), written into the area grid; its coarse lows."""
    from scipy import ndimage
    C = _C; cell = C['cell']; M = C['marg_c']; K = C['coarse']
    j0, j1, i0, i1 = tile_cells(C, t)
    J0, J1, I0, I1 = max(0, j0 - M), min(C['ny'], j1 + M), max(0, i0 - M), min(C['nx'], i1 + M)
    x, y, z = load_box(C, I0 * cell, J0 * cell, I1 * cell, J1 * cell, ground_only=True)[:3]
    H, W = J1 - J0, I1 - I0
    core = (slice(j0 - J0, j1 - J0), slice(i0 - I0, i1 - I0))
    cj, ci = (j1 - j0 + K - 1) // K, (i1 - i0 + K - 1) // K
    if len(x):
        ix = np.clip((x / cell).astype(int) - I0, 0, W - 1); iy = np.clip((y / cell).astype(int) - J0, 0, H - 1)
        flat = iy * W + ix
        o = np.lexsort((z, flat)); fs = flat[o]; zz = z[o]
        u, st, cnt = np.unique(fs, return_index=True, return_counts=True)
        G = np.full(H * W, np.nan); G[u] = zz[st + cnt // 2]; G = G.reshape(H, W)
        have = np.isfinite(G)
    if not len(x) or not have[core].any():
        return t, np.full((cj, ci), np.nan, 'f4'), 0.0
    idx = ndimage.distance_transform_edt(~have, return_distances=False, return_indices=True)
    F = G[idx[0], idx[1]]
    for _ in range(60):                         # nearest, then the filled cells relaxed
        F = np.where(have, G, ndimage.uniform_filter(F, 3, mode='nearest'))
    Gc = F[core].astype('f4')
    np.load(C['gfile'], mmap_mode='r+')[j0:j1, i0:i1] = Gc
    P = np.full((cj * K, ci * K), np.inf, 'f4'); P[:Gc.shape[0], :Gc.shape[1]] = Gc
    return t, P.reshape(cj, K, ci, K).min((1, 3)), float(have[core].mean())


def w_lid(t):
    """The lid of one tile (worked with the margin on the stitched ground), written into lid.npy."""
    from scipy import ndimage
    C = _C; M = C['marg_c']; K = C['coarse']
    j0, j1, i0, i1 = tile_cells(C, t)
    J0, J1, I0, I1 = max(0, j0 - M), min(C['ny'], j1 + M), max(0, i0 - M), min(C['nx'], i1 + M)
    G = np.array(np.load(C['gfile'], mmap_mode='r')[J0:J1, I0:I1], 'f8')
    if not np.isfinite(G[j0 - J0:j1 - J0, i0 - I0:i1 - I0]).any():
        return t, False
    G = fill_nan_nearest(G)
    CF = np.load(C['cfile'], mmap_mode='r')
    jj = np.minimum(np.arange(J0, J1) // K, CF.shape[0] - 1); ii = np.minimum(np.arange(I0, I1) // K, CF.shape[1] - 1)
    floor = np.array(CF[np.ix_(jj, ii)], 'f8'); floor[~np.isfinite(floor)] = -np.inf
    WF = water_fill(np.maximum(G, floor))        # the area's coarse fill is the floor: one level per hollow
    L = np.maximum(ndimage.grey_closing(G, footprint=disc(PARAMS['lid_width'] / 2 / C['cell']), mode='nearest'), WF)
    np.load(C['lfile'], mmap_mode='r+')[j0:j1, i0:i1] = L[j0 - J0:j1 - J0, i0 - I0:i1 - I0].astype('f4')
    return t, True


def lid_window(C, J0, J1, I0, I1):
    """A window of the stitched lid with its slope cosine; blanks filled from the nearest cell."""
    from scipy import ndimage
    L = fill_nan_nearest(np.array(np.load(C['lfile'], mmap_mode='r')[J0:J1, I0:I1], 'f8'))
    Ls = ndimage.uniform_filter(L, 3, mode='nearest'); gy, gx = np.gradient(Ls, C['cell'])
    return L, 1.0 / np.sqrt(1 + gx * gx + gy * gy)


def face_fit(Q, S, outd, key, chunk=512):
    """How far each point of Q lies BEHIND THE LOCAL FACE: a plane fitted in 3D to the surface returns S around it
    (the radii in turn, at least face_min returns; the outer sheet: what lies more than face_sheet behind the plane
    is dropped and the plane refitted, three times; a rough fit at the first radius goes on to the next). outd is
    the air side for each point. Where there are more than face_cap returns around a point the fit uses about that
    many of them, picked by key (a number 0..1 per surface return that does not depend on the tile). Returns behind
    (NaN = no fit) and the plane's unit normal (towards the air)."""
    from itertools import chain
    from scipy.spatial import cKDTree
    P_ = PARAMS; n = len(Q); behind = np.full(n, np.nan); nvec = np.zeros((n, 3))
    if len(S) < P_['face_min'] or not n:
        return behind, nvec
    tree = cKDTree(S); todo = np.arange(n); sheet = -P_['face_sheet']; cap = P_['face_cap']
    for ri, r in enumerate(P_['face_radius']):
        left = []
        for a in range(0, len(todo), chunk):
            ids = todo[a:a + chunk]
            cnt = tree.query_ball_point(Q[ids], r, return_length=True)
            ok = cnt >= P_['face_min']; left.append(ids[~ok]); ids = ids[ok]; ln = cnt[ok]
            if not len(ids):
                continue
            flat = np.fromiter(chain.from_iterable(tree.query_ball_point(Q[ids], r)), np.int64, int(ln.sum()))
            rep = np.repeat(np.arange(len(ids)), ln); scale = np.ones(len(ids))
            if (ln > cap).any():                                   # many returns: about cap of them make the same plane
                sel = key[flat] * ln[rep] < cap
                flat = flat[sel]; rep = rep[sel]; l2 = np.bincount(rep, minlength=len(ids))
                scale = ln / np.maximum(l2, 1); ln = l2
                if (ln == 0).any():                                # (cannot happen in practice: cap of many)
                    raise ValueError('face fit: no returns left')
            st = np.r_[0, np.cumsum(ln)[:-1]]
            D = S[flat] - Q[ids][rep]                              # from each point to its neighbours

            def plane(w):
                if w is None:
                    k = ln.astype('f8'); Dw = D
                else:
                    k = np.add.reduceat(w.astype('f8'), st); Dw = D * w[:, None]
                c = np.add.reduceat(Dw, st, 0) / np.maximum(k, 1)[:, None]
                d = D - c[rep]
                if w is not None: d = d * w[:, None]
                u = np.add.reduceat(np.c_[d[:, 0] * d[:, 0], d[:, 0] * d[:, 1], d[:, 0] * d[:, 2], d[:, 1] * d[:, 1], d[:, 1] * d[:, 2], d[:, 2] * d[:, 2]], st, 0)
                return c, np.linalg.eigh(u[:, [0, 1, 2, 1, 3, 4, 2, 4, 5]].reshape(-1, 3, 3))[1][:, :, 0]
            c, nrm = plane(None)
            nrm[(nrm * outd[ids]).sum(1) < 0] *= -1
            active = np.ones(len(ids), bool)
            for _ in range(3):
                keep = ((D - c[rep]) * nrm[rep]).sum(1) > sheet
                active &= np.add.reduceat(keep.astype('f8'), st) * scale >= 10
                if not active.any():
                    break
                c2, n2 = plane(keep)
                n2[(n2 * nrm).sum(1) < 0] *= -1
                c[active] = c2[active]; nrm[active] = n2[active]
            dd = ((D - c[rep]) * nrm[rep]).sum(1); m = dd > sheet
            km = np.add.reduceat(m.astype('f8'), st)
            with np.errstate(invalid='ignore', divide='ignore'):
                rms = np.sqrt(np.add.reduceat(dd * dd * m, st) / km)
            acc = (rms < P_['face_rms']) | (ri > 0)
            behind[ids[acc]] = (c[acc] * nrm[acc]).sum(1); nvec[ids[acc]] = nrm[acc]
            left.append(ids[~acc])
        todo = np.concatenate(left) if left else np.zeros(0, int)
        if not len(todo):
            break
    return behind, nvec


def w_classify(t):
    """The returns of one tile against the stitched lid: the candidates (under the lid), how far each lies behind
    the local face (worked with the margin, so a fit near the tile's edge sees its neighbours), the pass
    statistics, brush counts."""
    from scipy import ndimage
    C = _C; cell = C['cell']; P_ = PARAMS; B = 3 * P_['face_smooth'] + 4
    M = max(C['marg_c'], int(math.ceil(2.2 * max(P_['face_radius']) / cell)))
    j0, j1, i0, i1 = tile_cells(C, t)
    lidm = np.load(C['lfile'], mmap_mode='r')
    if not np.isfinite(lidm[j0:j1, i0:i1]).any():
        return t, None
    x, y, z, c, ps, last, own = load_box(C, max(0, i0 - M) * cell, max(0, j0 - M) * cell, min(C['nx'], i1 + M) * cell, min(C['ny'], j1 + M) * cell, core=t)
    if C.get('ring') is not None and own.any():
        own = own & in_ring(x, y, C['ring'])
    if not own.any():
        return t, None
    J0, J1, I0, I1 = max(0, j0 - M - B), min(C['ny'], j1 + M + B), max(0, i0 - M - B), min(C['nx'], i1 + M + B)
    L, cosm = lid_window(C, J0, J1, I0, I1)
    lx = x - I0 * cell; ly = y - J0 * cell; H, W = L.shape
    ix = np.clip((lx / cell).astype(int), 0, W - 1); iy = np.clip((ly / cell).astype(int), 0, H - 1)
    dv = bilin(L, lx, ly, cell) - z
    cand = dv * cosm[iy, ix] > P_['below']
    BS = P_['pass_block']; bk = (y[own] // BS).astype(np.int64) * 100000 + (x[own] // BS).astype(np.int64)
    uk, un = np.unique(np.c_[bk, ps[own]], axis=0, return_counts=True)
    stats = [(int(k_), int(p), int(n)) for (k_, p), n in zip(uk, un)]          # block, pass, returns (blocks do not depend on the tile size)
    # brush: of the returns that got down to brush height, the share the band stopped (as lidar_derive.py)
    G = fill_nan_nearest(np.array(np.load(C['gfile'], mmap_mode='r')[J0:J1, I0:I1], 'f8'))
    hag = z[own] - bilin(G, lx[own], ly[own], cell); lo, hi = P_['brush_band']; S = P_['brush_block']
    bj0, bi0 = j0 // S, i0 // S; bh, bw = (j1 - 1) // S - bj0 + 1, (i1 - 1) // S - bi0 + 1
    f = (np.clip(iy[own] + J0, j0, j1 - 1) // S - bj0) * bw + (np.clip(ix[own] + I0, i0, i1 - 1) // S - bi0)
    inband = np.bincount(f[(hag >= lo) & (hag <= hi)], minlength=bh * bw).reshape(bh, bw)
    under = np.bincount(f[(hag < lo) & (hag > -1.0)], minlength=bh * bw).reshape(bh, bw)
    # the measure: behind the local face, fitted to the last returns that are not candidates; candidates that turn
    # out to lie on the face join it and the fit is repeated
    ci = np.flatnonzero(cand); behind = np.full(len(ci), np.nan); nvec = np.zeros((len(ci), 3))
    if len(ci) and own[ci].any():
        gy, gx = np.gradient(ndimage.gaussian_filter(L, P_['face_smooth'], mode='nearest'), cell)       # the air side: the coarse ground's slope
        outd = np.c_[-gx[iy[ci], ix[ci]], -gy[iy[ci], ix[ci]], np.ones(len(ci))]; outd /= np.linalg.norm(outd, axis=1)[:, None]
        K = 4; reach = int(np.ceil(max(P_['face_radius']) / (K * cell))) + 1
        nearc = np.zeros((H // K + 1, W // K + 1), bool); nearc[iy[ci] // K, ix[ci] // K] = True
        nearc = ndimage.maximum_filter(nearc, 2 * reach + 1)
        si = np.flatnonzero(last & ~cand & nearc[iy // K, ix // K])
        XYZ = np.c_[lx, ly, z]; Q = XYZ[ci]; cl = last[ci]; onface = np.zeros(len(ci), bool)
        key = np.abs(np.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453) % 1.0
        todo = np.arange(len(ci))
        for _ in range(P_['face_passes']):
            use = np.r_[si, ci[onface & cl]]
            behind[todo], nvec[todo] = face_fit(Q[todo], XYZ[use], outd[todo], key[use])
            new_on = np.isfinite(behind) & (behind < P_['face_sheet'])
            ch = (new_on != onface) & cl                         # the surface changed here: only what is around is fitted again
            onface = new_on
            if not ch.any():
                break
            from scipy.spatial import cKDTree
            todo = np.flatnonzero(cKDTree(Q[ch]).query(Q, distance_upper_bound=max(P_['face_radius']))[0] < np.inf)
    k = own[ci]; ci = ci[k]; behind = behind[k]; nvec = nvec[k]
    return t, dict(n=int(own.sum()), stats=stats, x=x[ci], y=y[ci], z=z[ci], dv=dv[ci], ps=ps[ci], behind=behind,
                   foot=np.where(np.isfinite(behind), behind, 0.0)[:, None] * nvec, brush=(bj0, bi0, inband.astype('i4'), under.astype('i4')))


# ---------------------------------------------------------------------------------------------------------
# 6. features: one cluster of grouped returns in a voxel box around it
# ---------------------------------------------------------------------------------------------------------
def w_clusters(job):
    return [w_cluster(j) for j in job]


def w_cluster(job):
    """idx (into the area's below returns) and their x, y, z, depth -> shapes, hole cells, per-return facts."""
    from scipy import ndimage, sparse
    from scipy.sparse import csgraph
    from scipy.spatial import cKDTree
    C = _C; cell = VOX = C['cell']; P = PARAMS
    idx, g4 = job                       # x, y, z, depth behind the face, depth under the lid, the foot on the face (3), fitted
    gd = g4[:, 4]; fit = g4[:, 8] > 0
    # the lid around the cluster: far enough that every return's nearest way out is inside the window
    pad = min(max(float(gd.max()), 4.0), P['max_depth']) + 2.0
    I0 = max(0, int((g4[:, 0].min() - pad) / cell)); I1 = min(C['nx'], int((g4[:, 0].max() + pad) / cell) + 1)
    J0 = max(0, int((g4[:, 1].min() - pad) / cell)); J1 = min(C['ny'], int((g4[:, 1].max() + pad) / cell) + 1)
    Lw, cosw = lid_window(C, J0, J1, I0, I1)
    gp = np.c_[g4[:, 0] - I0 * cell, g4[:, 1] - J0 * cell, g4[:, 2]]         # metres from the window's corner
    H, W = Lw.shape
    # the lid surface as points: every cell's height, plus the faces between cells where the lid steps (cliffs)
    jj_, ii_ = np.mgrid[0:H, 0:W]; cxs = (ii_ + 0.5) * cell; cys = (jj_ + 0.5) * cell
    SP = [np.c_[cxs.ravel(), cys.ravel(), Lw.ravel()]]
    for dj, di in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        drop = Lw - np.roll(Lw, (-dj, -di), (0, 1)); ok_ = drop > cell
        if dj == 1: ok_[-1, :] = False
        if dj == -1: ok_[0, :] = False
        if di == 1: ok_[:, -1] = False
        if di == -1: ok_[:, 0] = False
        if ok_.any():
            k_ = np.ceil(drop[ok_] / cell).astype(int); rep_ = np.repeat(np.arange(int(ok_.sum())), k_)
            step = (np.arange(len(rep_)) - np.repeat(np.cumsum(k_) - k_, k_) + 1) * cell
            SP.append(np.c_[cxs[ok_][rep_] + di * cell / 2, cys[ok_][rep_] + dj * cell / 2, Lw[ok_][rep_] - np.minimum(step, drop[ok_][rep_])])
    SP = np.concatenate(SP); stree = cKDTree(SP)
    ds, ek = stree.query(gp); E = SP[ek]                    # every return's way out
    horiz = np.linalg.norm(E[:, :2] - gp[:, :2], axis=1); vertd = np.abs(E[:, 2] - gp[:, 2])
    # open = no returns on the surface where the return comes out (an entrance); roofed = there are. Where it comes
    # out: the foot of the perpendicular on its fitted face (any return there is the face); with no fit, its way
    # out on the lid (the returns lying on the lid there)
    T = np.where(fit[:, None], gp + g4[:, 5:8], E)
    px, py, pz = load_box(C, T[:, 0].min() - 1 + I0 * cell, T[:, 1].min() - 1 + J0 * cell, T[:, 0].max() + 1 + I0 * cell, T[:, 1].max() + 1 + J0 * cell)[:3]
    cnt = np.zeros(len(gp), int)
    if len(px):
        px = px - I0 * cell; py = py - J0 * cell
        g0 = np.array([T[:, 0].min() - 1, T[:, 1].min() - 1]); gs = (int((T[:, 0].max() + 1 - g0[0]) // 1.0) + 1, int((T[:, 1].max() + 1 - g0[1]) // 1.0) + 1)
        nearT = np.zeros(gs, bool); nearT[((T[:, 0] - g0[0]) // 1.0).astype(int), ((T[:, 1] - g0[1]) // 1.0).astype(int)] = True
        nearT = ndimage.maximum_filter(nearT, 3)               # only the returns around a way out are looked at
        m = nearT[np.clip(((px - g0[0]) // 1.0).astype(int), 0, gs[0] - 1), np.clip(((py - g0[1]) // 1.0).astype(int), 0, gs[1] - 1)]
        px, py, pz = px[m], py[m], pz[m]
    if len(px):
        if fit.any():
            cnt[fit] = cKDTree(np.c_[px, py, pz]).query_ball_point(T[fit], 0.6, return_length=True)
        if not fit.all():
            pix = np.clip((px / cell).astype(int), 0, W - 1); piy = np.clip((py / cell).astype(int), 0, H - 1)
            near = np.abs((bilin(Lw, px, py, cell) - pz) * cosw[piy, pix]) < P['below']
            if near.any():
                cnt[~fit] = cKDTree(np.c_[px[near], py[near], pz[near]]).query_ball_point(T[~fit], 0.6, return_length=True)
    openp = cnt < 3
    ML = C['max_link']; tg = cKDTree(gp)
    openp &= ds <= ML                   # a way out longer than max_link is a guess no shape may rest on

    def links(gp, ds, E, openp, tg):
        """Roofed returns: each tied to the nearest return that is nearer the surface, never farther than its own way
        out or max_link; else to an open return close by; else straight out through the roof when that is no longer
        than max_link; else it hangs on nothing of its own (none)."""
        ri = np.flatnonzero(~openp); z0 = np.zeros(0, bool)
        if not len(ri):
            return ri, np.zeros(0, int), z0, z0, z0, np.zeros(0, int), np.zeros((0, 3)), np.zeros((0, 3))
        K = min(64, len(gp))
        dd, jj = tg.query(gp[ri], k=K); dd = dd.reshape(len(ri), -1); jj = jj.reshape(len(ri), -1)
        dd2 = np.where(ds[jj] < ds[ri][:, None] - 0.10, dd, np.inf); pick = dd2.argmin(1)
        dist = dd2[np.arange(len(ri)), pick]; par = jj[np.arange(len(ri)), pick]
        for q in np.flatnonzero(~np.isfinite(dist)):
            hi_ = np.flatnonzero(ds < ds[ri[q]] - 0.10)
            if len(hi_):
                d_ = np.linalg.norm(gp[hi_] - gp[ri[q]], axis=1); k_ = d_.argmin(); dist[q] = d_[k_]; par[q] = hi_[k_]
        up = ~np.isfinite(dist) | (dist > np.minimum(ML, ds[ri]))
        A_ = gp[ri]; B_ = np.where(up[:, None], E[ri], gp[par]); toent = np.zeros(len(ri), bool); ok2 = np.zeros(len(ri), int)
        if openp.any():
            opts_ = gp[openp]; od, ok2 = cKDTree(opts_).query(A_)
            toent = up & (od <= np.minimum(6.0, 1.5 * ds[ri] + 1.0)); B_[toent] = opts_[ok2[toent]]
        none = up & ~toent & (ds[ri] > ML)
        return ri, par, up, toent, none, ok2, A_, B_

    def features(gp, openp, tg, ri, par, up, toent, none, ok2):
        pr_ = tg.query_pairs(P['link'], output_type='ndarray')
        ea = [pr_[:, 0]]; eb = [pr_[:, 1]]
        if len(ri):
            tie_ = ~up & ~toent
            ea.append(ri[tie_]); eb.append(par[tie_])
            if toent.any():
                ea.append(ri[toent]); eb.append(np.flatnonzero(openp)[ok2[toent]])
        ea = np.concatenate(ea); eb = np.concatenate(eb)
        return csgraph.connected_components(sparse.coo_matrix((np.ones(len(ea)), (ea, eb)), shape=(len(gp), len(gp))), directed=False)
    # a feature must reach the surface by links no longer than max_link: one of its returns has to have a way out
    # (open, or straight through the roof) that short. The returns of a feature that has none make no shape, no hole.
    L_ = links(gp, ds, E, openp, tg); nf, flab = features(gp, openp, tg, *L_[:6])
    anch = openp.copy(); anch[L_[0][L_[2] & ~L_[3] & ~L_[4]]] = True
    keepf = np.isin(flab, np.unique(flab[anch])); dropped = idx[~keepf]
    if not keepf.all():
        idx, g4, gp, E, ds, horiz, vertd, openp = idx[keepf], g4[keepf], gp[keepf], E[keepf], ds[keepf], horiz[keepf], vertd[keepf], openp[keepf]
        if not len(idx):
            z = np.zeros(0, np.int64)
            return dict(idx=idx, flab=z, openp=z.astype(bool), side=z.astype(bool), ltype=z.astype('u1'), llen=np.zeros(0), wayout=np.zeros(0), dropped=dropped,
                        nf=0, wrapped=0, shapes=0, left=0, joined=0, true=z, guess=z, mesh=None)
        tg = cKDTree(gp)
    # the voxel box: just around the returns and their ways out
    bp = 3.0
    vi0 = max(0, int((min(gp[:, 0].min(), E[:, 0].min()) - bp) / cell)); vi1 = min(W, int((max(gp[:, 0].max(), E[:, 0].max()) + bp) / cell) + 1)
    vj0 = max(0, int((min(gp[:, 1].min(), E[:, 1].min()) - bp) / cell)); vj1 = min(H, int((max(gp[:, 1].max(), E[:, 1].max()) + bp) / cell) + 1)
    L = Lw[vj0:vj1, vi0:vi1]; nj, ni = L.shape
    zlo = gp[:, 2].min() - 1.5; zhi = float(L.max()) + 1.0; nz = int(np.ceil((zhi - zlo) / VOX))
    zc = zlo + (np.arange(nz) + 0.5) * VOX
    underlid = zc[None, None, :] <= (L[:, :, None] + 0.2)

    def vox(p):
        return (np.clip((p[:, 1] / VOX).astype(int) - vj0, 0, nj - 1), np.clip((p[:, 0] / VOX).astype(int) - vi0, 0, ni - 1),
                np.clip(((p[:, 2] - zlo) / VOX).astype(int), 0, nz - 1))

    def tubes(A_, B_, rad):
        T_ = np.zeros((nj, ni, nz), bool)
        if not len(A_): return T_
        sl_ = np.linalg.norm(B_ - A_, axis=1); ns = np.maximum(2, np.ceil(sl_ / (VOX * 0.5)).astype(int))
        rep = np.repeat(np.arange(len(A_)), ns)
        tt = (np.arange(len(rep)) - np.repeat(np.cumsum(ns) - ns, ns)) / np.repeat(ns - 1, ns)
        T_[vox(A_[rep] + (B_[rep] - A_[rep]) * tt[:, None])] = True
        return ndimage.binary_dilation(T_, structure=ball(rad))

    def closing(V, r):
        return ndimage.binary_closing(np.pad(V, 3), structure=ball(r))[3:-3, 3:-3, 3:-3]
    gv = vox(gp)
    # entrances: open returns go straight to their way out (up on flat ground, sideways at the foot of a cliff)
    Vent = tubes(gp[openp], E[openp], 1.0)
    # where the way out is mostly straight up (a pit on open ground), the whole cell above the return is open air
    vert = openp & (horiz < 0.5 * vertd)
    if vert.any():
        Fz = np.full((nj, ni), np.inf); np.minimum.at(Fz, (gv[0][vert], gv[1][vert]), gp[vert, 2])
        Vent |= np.isfinite(Fz)[:, :, None] & (zc[None, None, :] >= Fz[:, :, None] - VOX / 2) & (zc[None, None, :] <= L[:, :, None] + 0.2)
    Vx = Vent.copy()
    # roofed returns: tied to the nearest return that is nearer the surface, never farther than their own way out
    ltype = np.zeros(len(gp), 'u1'); llen = ds.copy()          # the link each return hangs on: 0 its way out (open), 1 a tie, 2 to an entrance, 3 out through the roof, 4 none of its own
    ri, par, up, toent, none, ok2, A_, B_ = links(gp, ds, E, openp, tg)
    if len(ri):
        A_, B_ = np.where(none[:, None], A_, A_), np.where(none[:, None], A_, B_)       # (none: no tube)
        Vx |= tubes(A_[~none], B_[~none], 1.0)
        ltype[ri] = np.where(none, 4, np.where(toent, 2, np.where(up, 3, 1))); llen[ri] = np.linalg.norm(B_ - A_, axis=1)
    # one skin around each feature: its returns (joined by nearness, ties and entrance links) wrapped together
    nf, flab = features(gp, openp, tg, ri, par, up, toent, none, ok2)
    pv = np.c_[gv[0], gv[1], gv[2]]; WRAP = P['wrap']
    pad_ = int(np.ceil(WRAP / VOX)) + 2; fsz = np.bincount(flab, minlength=nf); wrapped = []
    for f_ in np.flatnonzero(fsz >= P['wrap_min']):
        q = pv[flab == f_]; lo = np.maximum(q.min(0) - pad_, 0); hi = np.minimum(q.max(0) + pad_ + 1, [nj, ni, nz])
        Pb = np.zeros(hi - lo, bool); Pb[tuple((q - lo).T)] = True
        dil = ndimage.distance_transform_edt(~Pb) * VOX <= WRAP
        clo = (ndimage.distance_transform_edt(np.pad(dil, 1))[1:-1, 1:-1, 1:-1] * VOX > WRAP) | Pb
        Vx[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]] |= clo
        wrapped.append((lo, hi, clo))
    Vtrue = Vent.copy()                 # what the open returns alone cut: the true entrances
    # openings: at true entrances, and wherever a wrapped feature comes out, also through a roof (a guess)
    for lo, hi, w_ in wrapped:
        Vent[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]] |= w_
    if len(ri):
        bigr = (fsz[flab[ri]] >= P['wrap_min']) & ~none
        Vent |= tubes(A_[bigr], B_[bigr], 1.0)
    Vent = closing(Vent, 2.0) & underlid
    Vx = closing(Vx, 2.0)
    for k_ in np.flatnonzero(Vx.any((0, 1))):       # a ring of wall returns at one level = an open pit: fill it
        Vx[:, :, k_] = ndimage.binary_fill_holes(Vx[:, :, k_])
    Vx &= underlid
    # every shape must reach the surface: one that does not is joined to the nearest that does, or to the lid
    S6 = ndimage.generate_binary_structure(3, 1); nfix = 0
    airn = ndimage.binary_dilation(zc[None, None, :] > L[:, :, None] - 0.15, structure=S6)
    off = np.array([vj0, vi0])
    for _ in range(6):
        lab3, nb = ndimage.label(Vx, structure=S6)
        okl = np.unique(lab3[Vx & airn]); bad = np.setdiff1d(np.arange(1, nb + 1), okl)
        if not len(bad): break
        okv = np.argwhere(np.isin(lab3, okl)); tr_ok = cKDTree(okv[:: max(1, len(okv) // 200000)]) if len(okv) else None
        T_ = np.zeros_like(Vx)
        for bl in bad:
            vx_ = np.argwhere(lab3 == bl); vs = vx_[:: max(1, len(vx_) // 3000)]
            dS, kS = stree.query(np.c_[(vs[:, 1] + vi0 + 0.5) * VOX, (vs[:, 0] + vj0 + 0.5) * VOX, zc[vs[:, 2]]]); mS = dS.argmin()
            a_ = vs[mS].astype(float); pS = SP[kS[mS]]; dep = float(dS[mS])
            b_ = np.array([pS[1] / VOX - vj0, pS[0] / VOX - vi0, (pS[2] - zlo) / VOX + 1])
            far_ = dep > ML
            if tr_ok is not None:
                d_, q_ = tr_ok.query(vs); m_ = d_.argmin()
                if d_[m_] * VOX <= min(8.0, max(2.0, dep)): a_ = vs[m_].astype(float); b_ = tr_ok.data[q_[m_]]; far_ = False
            if far_:                    # only a link longer than max_link would join it: no shape
                Vx[lab3 == bl] = False; continue
            ns_ = int(np.ceil(np.linalg.norm(b_ - a_) * 2)) + 2; ln = (a_ + (b_ - a_) * np.linspace(0, 1, ns_)[:, None]).round().astype(int)
            ln = ln[(ln[:, 0] >= 0) & (ln[:, 0] < nj) & (ln[:, 1] >= 0) & (ln[:, 1] < ni) & (ln[:, 2] >= 0) & (ln[:, 2] < nz)]
            T_[ln[:, 0], ln[:, 1], ln[:, 2]] = True; nfix += 1
        Vx |= ndimage.binary_dilation(T_, structure=ball(1.5)); Vx &= underlid
    lab3, nb = ndimage.label(Vx, structure=S6)
    left = nb - len(np.unique(lab3[Vx & airn]))
    # the ground: real holes only at true entrances; a guessed opening is a patch
    Vt = closing(Vtrue, 2.0) & underlid
    truem = (Vt & airn).any(2)
    guess = ((Vent & airn) & ~ndimage.binary_dilation(Vt, structure=ball(2.0))).any(2)
    guess &= ~ndimage.binary_dilation(truem, iterations=2)
    gj0, gi0 = J0 + vj0, I0 + vi0
    tj, ti = np.nonzero(truem); qj, qi = np.nonzero(guess)
    out = dict(idx=idx, flab=flab, openp=openp, side=horiz > vertd, ltype=ltype, llen=llen, wayout=ds, dropped=dropped, nf=int(nf), wrapped=len(wrapped), shapes=int(nb), left=int(left), joined=nfix,
               true=((tj + gj0) * C['nx'] + ti + gi0).astype(np.int64), guess=((qj + gj0) * C['nx'] + qi + gi0).astype(np.int64), mesh=None)
    if C['shapes'] and Vx.any():
        out['mesh'] = shape_mesh(C, Vx, L, zc, zlo, gp, gj0, gi0, I0, J0, Lw, stree)
    return out


def shape_mesh(C, Vx, L, zc, zlo, gp, gj0, gi0, I0, J0, Lw, stree):
    """The walls of the shapes in a box: the surface of (rock = under the lid and outside every shape), its ground
    part dropped, simplified, then hugged half-way onto the returns with the mouth left alone. A vertex's depth is its
    distance from the lid surface (straight up on flat ground, sideways at a wall)."""
    import veg_mesh
    from scipy.spatial import cKDTree
    VOX = cell = C['cell']; P = PARAMS; nj, ni, nz = Vx.shape
    F = np.clip((L.astype('f4')[:, :, None] - zc.astype('f4')[None, None, :]) / np.float32(VOX), -1, 1); F[Vx] = -1.0
    vv, tt = veg_mesh.surface_nets(np.pad(F, 1, constant_values=-1.0), 0.0)[:2]
    vv = np.asarray(vv, 'f8') - 1.0; tt = np.asarray(tt)
    if not len(tt):
        return None
    edge = (vv[:, 0] < 0.6) | (vv[:, 0] > nj - 1.6) | (vv[:, 1] < 0.6) | (vv[:, 1] > ni - 1.6) | (vv[:, 2] < 0.6)
    tt = tt[~edge[tt].any(1)]
    if not len(tt):
        return None
    vv = np.asarray(veg_mesh.taubin(vv, tt, iters=2), 'f8')
    # metres from the window's corner
    V = np.c_[(vv[:, 1] + gi0 - I0 + 0.5) * VOX, (vv[:, 0] + gj0 - J0 + 0.5) * VOX, zlo + (vv[:, 2] + 0.5) * VOX]
    tt = tt[((bilin(Lw, V[:, 0], V[:, 1], cell) - V[:, 2])[tt] > 0.45).any(1)]      # (cheap first cut: straight down is never less)
    if not len(tt):
        return None
    V, tt = veg_mesh.compact(V, tt)[:2]
    dep = stree.query(V)[0]
    tt = tt[(dep[tt] > 0.45).any(1)]                      # the shape part: the ground around it is the exporter's
    if not len(tt):
        return None
    V, tt = veg_mesh.compact(V, tt)[:2]
    if len(tt) > 40:
        try:
            V, tt, _a = veg_mesh.simplify(V, tt, max(24, len(tt) // 30), max_error=P['simplify_error'])
        except Exception:
            pass
    V = np.asarray(V, 'f8'); tt = np.asarray(tt)
    dep = stree.query(V)[0]
    wall = np.flatnonzero(dep > 0.45)
    if len(wall):
        d0, k0 = cKDTree(gp).query(V[wall]); nr = d0 <= P['hug']
        fade = np.clip((dep[wall][nr] - 0.6) / 1.5, 0, 1)[:, None]     # no pull in the first 0.6 m, full from 2.1 m down
        V[wall[nr]] += P['pull'] * fade * (gp[k0[nr]] - V[wall[nr]])
        dep = stree.query(V)[0]
    V[:, 0] += I0 * cell; V[:, 1] += J0 * cell
    return V.astype('f4'), dep.astype('f4'), tt.astype('u4')


# ---------------------------------------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------------------------------------
def split_cluster(xy, idx, limit):
    """A cluster larger than the limit is cut at the middle of its longer side (said in the notes)."""
    ext = xy[idx].max(0) - xy[idx].min(0)
    if ext.max() <= limit or len(idx) < 8:
        return [idx]
    a = int(ext.argmax()); v = xy[idx, a]; m = v < (v.min() + v.max()) / 2
    return split_cluster(xy, idx[m], limit) + split_cluster(xy, idx[~m], limit)


def run(C, notes):
    from scipy import sparse
    from scipy.sparse import csgraph
    from scipy.spatial import cKDTree
    P = PARAMS; cell = C['cell']; nx, ny = C['nx'], C['ny']; out = C['out']; K = P['coarse']
    tiles = tile_list(C); stages = C['stages'] = {}; tt = [time.time()]

    def lap(name):
        stages[name] = round(time.time() - tt[0], 1); tt[0] = time.time()
    if C.get('ring') is not None:               # tiles the polygon does not reach are not worked
        keep = []
        for t in tiles:
            j0, j1, i0, i1 = tile_cells(C, t)
            gx, gy = np.meshgrid(np.linspace(i0 * cell, i1 * cell, 9), np.linspace(j0 * cell, j1 * cell, 9))
            R = np.asarray(C['ring'])
            if in_ring(gx.ravel(), gy.ravel(), R).any() or ((R[:, 0] >= i0 * cell) & (R[:, 0] <= i1 * cell) & (R[:, 1] >= j0 * cell) & (R[:, 1] <= j1 * cell)).any():
                keep.append(t)
        C['read_tiles'] = keep
    work = C.get('read_tiles', tiles)
    C['gfile'] = os.path.join(C['tmp'], 'ground.npy'); C['cfile'] = os.path.join(C['tmp'], 'coarse.npy'); C['lfile'] = os.path.join(out, 'lid.npy')
    for f in (C['gfile'], C['lfile']):
        m = np.lib.format.open_memmap(f, mode='w+', dtype='<f4', shape=(ny, nx)); m[:] = np.nan; del m
    C['_pool'] = None
    try:
        # 1. read
        if C.get('epts'):
            failed = []; npts = 0
            for t, n, err in pmap(C, w_read, work, 1, 40, 'reading tiles', lost=lambda t, why: (t, 0, 'the reader stopped: %s' % why), own=True):
                npts += n
                if err: failed.append((t, err))
            if failed:
                notes.append('%d of %d tiles could not be read and are blank (first: %s)' % (len(failed), len(work), failed[0][1]))
                say(40, '%d tiles could not be read: left blank' % len(failed))
            if len(failed) == len(work):
                raise SystemExit('[ridge] no tile could be read: %s' % failed[0][1])
        lap('read')
        # 2. fine ground + the coarse lows
        ch, cw = (ny + K - 1) // K, (nx + K - 1) // K
        coarse = np.full((ch, cw), np.nan, 'f4'); cover = []
        for t, cm, share in pmap(C, w_ground, work, 40, 50, 'ground'):
            j0, j1, i0, i1 = tile_cells(C, t)
            coarse[j0 // K:j0 // K + cm.shape[0], i0 // K:i0 // K + cm.shape[1]] = cm
            if share: cover.append(share)
        lap('ground')
        # 3. the area's coarse water fill (blank cells are outlets)
        say(50, 'water fill of the area')
        blank = ~np.isfinite(coarse)
        if blank.all():
            raise SystemExit('[ridge] no ground returns (class 2) in the area')
        cz = np.where(blank, -1e9, coarse).astype('f8')
        np.save(C['cfile'], np.where(blank, np.nan, water_fill(np.pad(cz, 1, constant_values=-1e9))[1:-1, 1:-1]).astype('f4'))
        lap('area_fill')
        # 4. lid, then the returns against it
        for _r in pmap(C, w_lid, work, 52, 60, 'lid'):
            pass
        lap('lid')
        cand = []; stats = {}; nret = 0
        S = P['brush_block']; by, bx = (ny + S - 1) // S, (nx + S - 1) // S
        b_in = np.zeros((by, bx), 'i4'); b_un = np.zeros((by, bx), 'i4')
        for t, r in pmap(C, w_classify, work, 60, 70, 'returns against the lid'):
            if r is None: continue
            nret += r['n']
            for k_, p, n in r['stats']:
                a = stats.setdefault((k_ // 100000, k_ % 100000), {}).setdefault(p, [0, 0]); a[0] += n
            bj0, bi0, a, b = r['brush']; b_in[bj0:bj0 + a.shape[0], bi0:bi0 + a.shape[1]] += a; b_un[bj0:bj0 + a.shape[0], bi0:bi0 + a.shape[1]] += b
            if len(r['x']):
                cand.append((r['x'], r['y'], r['z'], r['dv'], r['ps'], np.zeros(len(r['x']), np.int64), r['behind'], r['foot']))
        cat = lambda k, dt: np.concatenate([c[k] for c in cand]).astype(dt) if cand else np.zeros(0, dt)
        X, Y, Z, DV, PS, _u, BH = cat(0, 'f8'), cat(1, 'f8'), cat(2, 'f8'), cat(3, 'f8'), cat(4, 'i8'), cat(5, 'i8'), cat(6, 'f8')
        FT = np.concatenate([c[7] for c in cand]) if cand else np.zeros((0, 3))
        # below ground = behind the local face by more than min_behind; no face could be fitted: the lid's measure stands
        FIT = np.isfinite(BH); ok = ~FIT | (BH > C['min_behind'])
        ncand = len(X); nonface = int((FIT & ~ok).sum()); nofit = int((~FIT).sum())
        X, Y, Z, PS, FT, FIT = X[ok], Y[ok], Z[ok], PS[ok], FT[ok], FIT[ok]
        TK = (Y // P['pass_block']).astype(np.int64) * 100000 + (X // P['pass_block']).astype(np.int64)      # the statistics block of each
        DVL = DV[ok]; DV = np.where(FIT, BH[ok], DVL)            # from here on the depth is the distance behind the face
        dk, dn = np.unique(np.c_[TK, PS][DV > P['deep']], axis=0, return_counts=True)
        for (tk, p), q in zip(dk, dn):
            stats.setdefault((int(tk // 100000), int(tk % 100000)), {}).setdefault(int(p), [0, 0])[1] = int(q)
        lap('returns')
        # 5. patterned noise: a pass is judged per block of 96 m on the statistics of the block and its 8 neighbours;
        # a pass flagged anywhere is a bad pass everywhere: its returns below ground are set aside over the whole
        # area, except those a pass that is NOT flagged confirms (one of its returns within 1.5 m)
        say(70, 'flight passes')
        tot = {}; flagged_tiles = {}; trows = []
        for t, st in stats.items():
            for p, (n, d) in st.items():
                a = tot.setdefault(p, [0, 0]); a[0] += n; a[1] += d
            blk = {}
            for dj in (-1, 0, 1):
                for di in (-1, 0, 1):
                    for p, (n, d) in stats.get((t[0] + dj, t[1] + di), {}).items():
                        a = blk.setdefault(p, [0, 0]); a[0] += n; a[1] += d
            alln = sum(v[0] for v in blk.values()); alld = sum(v[1] for v in blk.values())
            for p in st:
                n, d = blk[p]; others = (alld - d) / max(1, alln - n); share = d / max(1, n)
                fl = alln - n >= P['pass_others'] and d >= P['pass_min'] and share >= P['pass_share'] and share >= P['pass_ratio'] * max(others, 1e-5)
                trows.append((t[0], t[1], p, st[p][0], st[p][1], n, d, alln - n, alld - d, int(fl)))
                if fl:
                    flagged_tiles[p] = flagged_tiles.get(p, 0) + 1
        isbad = np.isin(PS, list(flagged_tiles)) if flagged_tiles else np.zeros(len(X), bool)
        kind = np.zeros(len(X), 'u1'); confirmed = 0; confby = np.full(len(X), -1, np.int64)
        if isbad.any():
            ci = np.flatnonzero(isbad); gi = np.flatnonzero(~isbad)
            if len(gi):
                d_, q_ = cKDTree(np.c_[X[gi], Y[gi], Z[gi]]).query(np.c_[X[ci], Y[ci], Z[ci]]); okc = d_ <= P['pass_confirm']
                confirmed = int(okc.sum()); confby[ci[okc]] = PS[gi[q_[okc]]]; ci = ci[~okc]
            kind[ci] = 3
        passes = [dict(id=int(p), returns=int(n), deep=int(d), share=round(d / max(1, n), 5), flagged=p in flagged_tiles, blocks_flagged=int(flagged_tiles.get(p, 0)),
                       tiles_flagged=int(flagged_tiles.get(p, 0)), set_aside=int(((kind == 3) & (PS == p)).sum()), kept_confirmed=int((isbad & (kind == 0) & (PS == p)).sum()))
                  for p, (n, d) in sorted(tot.items())]
        # groups, lone, likely noise: over the whole area at once
        say(72, 'groups')
        bi = np.flatnonzero((kind == 0) & (DV <= P['max_depth'])); too_deep = int(((kind == 0) & (DV > P['max_depth'])).sum())
        pts = np.c_[X[bi], Y[bi], Z[bi]]; ngroups = 0; kb = np.zeros(len(bi), 'u1')
        if len(bi):
            tr = cKDTree(pts); pr = tr.query_pairs(P['link'], output_type='ndarray')
            ncomp, lab = csgraph.connected_components(sparse.coo_matrix((np.ones(len(pr)), (pr[:, 0], pr[:, 1])), shape=(len(bi), len(bi))), directed=False)
            size = np.bincount(lab, minlength=ncomp); lone = size[lab] == 1; kb[lone] = 1; ngroups = int((size >= 2).sum())
            if len(bi) > 1:
                d2, _ = tr.query(pts, k=2); kb[lone & (d2[:, 1] > P['lone_far'])] = 2
            else:
                kb[lone] = 2
        keep = np.r_[bi, np.flatnonzero(kind == 3)]
        pX, pY, pZ, pD = X[keep], Y[keep], Z[keep], DV[keep]; pK = np.r_[kb, np.full(int((kind == 3).sum()), 3, 'u1')]
        lap('noise_groups')
        # 6. clusters of grouped returns, each worked in its own box
        gi = np.flatnonzero(kb == 0); res = []; nsplit = 0
        if len(gi):
            xy = pts[gi, :2]; pr = cKDTree(xy).query_pairs(P['cluster'], output_type='ndarray')
            nc, cl = csgraph.connected_components(sparse.coo_matrix((np.ones(len(pr)), (pr[:, 0], pr[:, 1])), shape=(len(gi), len(gi))), directed=False)
            o = np.argsort(cl, kind='stable'); cuts = np.flatnonzero(np.diff(cl[o])) + 1; jobs = []
            for part in np.split(o, cuts):
                ps_ = split_cluster(xy, part, P['cluster_max']); nsplit += len(ps_) > 1
                for q in ps_:
                    jobs.append((gi[q], np.c_[pts[gi[q]], DV[bi][gi[q]], DVL[bi][gi[q]], FT[bi][gi[q]], FIT[bi][gi[q]]]))
            # jobs near each other go to the same worker (it keeps the tiles' returns in memory); big ones first
            Tm = C['tile_c'] * cell; byt = {}
            for j in jobs:
                byt.setdefault((int(j[1][:, 1].mean() // Tm), int(j[1][:, 0].mean() // Tm)), []).append(j)
            batches = sorted(byt.values(), key=lambda b: -sum(len(j[0]) for j in b))
            for rr in pmap(C, w_clusters, batches, 73, 96, 'features (%d clusters)' % len(jobs)):
                res.extend(rr)
            if nsplit:
                notes.append('%d clusters of returns were wider than %g m and were worked in parts (ties across the cut are not made)' % (nsplit, P['cluster_max']))
    finally:
        if C.get('_pool') is not None:
            C['_pool'].shutdown()
        C.pop('_pool', None)
    lap('features')
    say(96, 'writing')
    holes = np.zeros(ny * nx, 'u1'); V = []; D = []; T = []; nv = 0
    feat = np.full(len(bi), -1, np.int64); openp = np.zeros(len(bi), bool); side = np.zeros(len(bi), bool)
    ltype = np.full(len(bi), 255, 'u1'); llen = np.zeros(len(bi), 'f4'); wayout = np.zeros(len(bi), 'f4')
    cnt = dict(features=0, wrapped=0, shapes=0, not_reaching=0); fo = 0
    for r in res: holes[r['guess']] = 2
    nolink = 0
    for r in res:
        holes[r['true']] = 1
        if len(r['dropped']):           # only a link longer than max_link would hold them: likely noise, no shape
            kb[r['dropped']] = 2; nolink += len(r['dropped'])
        feat[r['idx']] = r['flab'] + fo; fo += r['nf']; openp[r['idx']] = r['openp']; side[r['idx']] = r['side']
        ltype[r['idx']] = r['ltype']; llen[r['idx']] = r['llen']; wayout[r['idx']] = r['wayout']
        cnt['features'] += r['nf']; cnt['wrapped'] += r['wrapped']; cnt['shapes'] += r['shapes']; cnt['not_reaching'] += r['left']
        if r['mesh'] is not None:
            v, d, t = r['mesh']; V.append(v); D.append(d); T.append(t + nv); nv += len(v)
    if nolink:
        pK[:len(bi)] = kb; ngroups = len(np.unique(lab[kb == 0]))
    holes = holes.reshape(ny, nx)
    lid = np.load(C['lfile'], mmap_mode='r+')
    if C.get('ring') is not None:               # nothing outside the polygon
        xs = (np.arange(nx) + 0.5) * cell
        for j in range(0, ny, 256):
            ys = (np.arange(j, min(ny, j + 256)) + 0.5) * cell; gx, gy = np.meshgrid(xs, ys)
            m = ~in_ring(gx.ravel(), gy.ravel(), C['ring']).reshape(gx.shape)
            lid[j:j + 256][m] = np.nan; holes[j:j + 256][m] = 0
    holes[~np.isfinite(lid)] = 0
    lid.flush(); del lid
    reach = b_in + b_un
    brush = np.where(reach >= P['brush_min'], b_in / np.maximum(reach, 1), np.nan).astype('f4')
    counts = dict(returns=int(nret), below=int(len(bi)), groups=ngroups, lone=int((kb == 1).sum()), likely_noise=int((kb == 2).sum()),
                  pattern_noise=int((kind == 3).sum()), pattern_confirmed=confirmed, deeper_than_max=too_deep,
                  candidates=int(ncand), on_face=nonface, no_face=nofit, no_link=int(nolink),
                  features=cnt['features'], wrapped=cnt['wrapped'], shapes=cnt['shapes'], not_reaching=cnt['not_reaching'],
                  true_cells=int((holes == 1).sum()), guessed_cells=int((holes == 2).sum()),
                  deepest=round(float(pD[pK < 3].max()), 2) if (pK < 3).any() else 0.0, shape_triangles=int(sum(len(t) for t in T)))
    write_outputs(C, holes, (pX, pY, pZ, pD, pK), (V, D, T) if C['shapes'] else None, brush)
    if C.get('debug'):
        np.savez(os.path.join(out, 'debug.npz'), x=pts[:, 0] if len(bi) else np.zeros(0), y=pts[:, 1] if len(bi) else np.zeros(0),
                 z=pts[:, 2] if len(bi) else np.zeros(0), depth=DV[bi], kind=kb, feature=feat, open=openp, sideways=side,
                 link=ltype, link_len=llen, way_out=wayout, psid=PS[bi], confirmed_by=confby[bi], tile=TK[bi],
                 noise=np.c_[X, Y, Z, DV, PS][kind == 3], tile_pass=np.array(trows, np.int64).reshape(-1, 10))
    return counts, passes, (float(np.mean(cover)) if cover else 0.0)


def write_outputs(C, holes, pts, shapes, brush):
    """lid.npy is already in place (float32 [ny, nx], row 0 = south). Little-endian:
    holes.npy   uint8 [ny, nx]: 0 none, 1 true-entrance cell, 2 guessed-opening cell
    points.bin  "RWP1", uint32 n, float32 xyz[n*3], float32 depth[n], uint8 kind[n] (0 group, 1 lone, 2 likely noise, 3 patterned noise)
    shapes.bin  "RWS1", uint32 nv, uint32 nt, float32 xyz[nv*3], float32 depth[nv], uint32 tri[nt*3]
    brush.npy   float32 [by, bx] share 0..1 or NaN, blocks of 3 cells; brush.json its frame
    x east, y north in metres from the origin, z absolute metres."""
    out = C['out']
    np.save(os.path.join(out, 'holes.npy'), holes)
    X, Y, Z, D, K = pts
    with open(os.path.join(out, 'points.bin'), 'wb') as f:
        f.write(b'RWP1'); f.write(np.uint32(len(X)).astype('<u4').tobytes())
        f.write(np.c_[X, Y, Z].astype('<f4').tobytes()); f.write(D.astype('<f4').tobytes()); f.write(K.astype('u1').tobytes())
    sp = os.path.join(out, 'shapes.bin')
    if shapes is not None:
        V, D_, T = shapes
        V = np.concatenate(V) if V else np.zeros((0, 3), 'f4'); D_ = np.concatenate(D_) if D_ else np.zeros(0, 'f4'); T = np.concatenate(T) if T else np.zeros((0, 3), 'u4')
        with open(sp, 'wb') as f:
            f.write(b'RWS1'); f.write(np.array([len(V), len(T)], '<u4').tobytes())
            f.write(V.astype('<f4').tobytes()); f.write(D_.astype('<f4').tobytes()); f.write(T.astype('<u4').tobytes())
    elif os.path.exists(sp):
        os.remove(sp)
    np.save(os.path.join(out, 'brush.npy'), brush)
    S = PARAMS['brush_block']
    json.dump(dict(x0=0.0, y0=0.0, cell=round(C['cell'] * S, 6), nx=int(brush.shape[1]), ny=int(brush.shape[0]), band=PARAMS['brush_band']),
              open(os.path.join(out, 'brush.json'), 'w'))


def read_points_bin(path):
    b = open(path, 'rb').read(); assert b[:4] == b'RWP1'; n = int(np.frombuffer(b, '<u4', 1, 4)[0])
    return (np.frombuffer(b, '<f4', n * 3, 8).reshape(n, 3), np.frombuffer(b, '<f4', n, 8 + 12 * n), np.frombuffer(b, 'u1', n, 8 + 16 * n))


def read_shapes_bin(path):
    b = open(path, 'rb').read(); assert b[:4] == b'RWS1'; nv, nt = (int(v) for v in np.frombuffer(b, '<u4', 2, 4))
    return (np.frombuffer(b, '<f4', nv * 3, 12).reshape(nv, 3), np.frombuffer(b, '<f4', nv, 12 + 12 * nv), np.frombuffer(b, '<u4', nt * 3, 12 + 16 * nv).reshape(nt, 3))


# ---------------------------------------------------------------------------------------------------------
# The made-up scene (--demo, tests, the other steps' tests)
# ---------------------------------------------------------------------------------------------------------
DEMO = dict(
    size=(192.0, 144.0),
    cliff_y=110.1, cliff_h=10.0, cliff_run=1.2, cliff_lip=0.45,   # a wall: 10 m up over 1.2 m, the ground above it reaching out over its top
    talus=(2.0, 1.2),                            # the ground rises 1.2 m over the last 2 m to the wall's foot
    pit=(96.0, 38.0, 2.0, 9.0),                  # x, y, radius, depth: a vertical pit (on the line between two tiles)
    slant=(37.0, 38.0, 2.2, 8.0),                # x, y, mouth radius, length: a pit going down at 45 degrees to the east
    slant_deep=(51.0, 38.0, 14.0),               # x, y, depth: a group under a roof, about 8 m from the pit's end: joined to it by a tie
    deep_pair=(20.0, 60.0, 15.0),                # two returns 15 m straight down with nothing above them: no shape (max_link)
    cliff_open=(140.0, 3.3),                     # x of the opening at the foot of the wall, how far its returns run into the rock
    pit_shallow=(70.0, 20.0, 1.5, 0.8),          # x, y, radius, depth: too shallow to be found
    pit_low=(120.0, 20.0, 1.5, 1.5),             # deep enough
    crack=(130.0, 146.0, 38.0, 0.6, 4.0),        # x from, x to, y, width, depth
    lone_far=(20.0, 100.0, 7.0), lone_near=(39.0, 34.5, 3.0),
    stripes=(150.0, 190.0, 10.0, 100.0), stripe_pass=9, confirmed=(164.0, 60.0, 5.0),
    brush=(60.0, 90.0, 60.0, 90.0),
)


def demo_ground(x, y):
    tw, th = DEMO['talus']
    return (100.0 + 0.02 * x + 0.04 * y + 0.3 * np.sin(x / 23.0) * np.cos(y / 31.0) + th * np.clip((y - DEMO['cliff_y'] + tw) / tw, 0, 1)
            + np.where(y > DEMO['cliff_y'] + DEMO['cliff_lip'], DEMO['cliff_h'], 0.0))


def demo_points(seed=3):
    """x, y, z, class, pass, last-return flag of the made-up scene (see DEMO)."""
    D = DEMO; rng = np.random.default_rng(seed); W, H = D['size']
    n = int(W * H * 9)
    x = rng.uniform(0, W, n); y = rng.uniform(0, H, n)
    px, py, pr, pd = D['pit']; sx, sy, sr, sl = D['slant']; c0, c1, cy, cw, cd = D['crack']
    keep = (np.hypot(x - px, y - py) > pr) & (np.hypot(x - sx, y - sy) > sr) & ~((x > c0) & (x < c1) & (np.abs(y - cy) < cw / 2))
    keep &= ~((y > D['cliff_y']) & (y <= D['cliff_y'] + D['cliff_lip']))
    x, y = x[keep], y[keep]; z = demo_ground(x, y) + rng.normal(0, 0.03, len(x))
    for qx, qy, qr, qd in (D['pit_shallow'], D['pit_low']):          # two small pits: the ground returns reach their floors
        z = z - np.where(np.hypot(x - qx, y - qy) < qr, qd, 0.0)
    P = [(x, y, z, np.full(len(x), 2), rng.integers(1, 5, len(x)), np.ones(len(x), bool))]

    def add(ax, ay, az, cls=1, ps=None, last=True):
        ax = np.atleast_1d(np.asarray(ax, 'f8')); k = len(ax)
        P.append((ax, np.broadcast_to(np.asarray(ay, 'f8'), (k,)).copy(), np.broadcast_to(np.asarray(az, 'f8'), (k,)).copy(),
                  np.full(k, cls), rng.integers(1, 5, k) if ps is None else np.full(k, ps), np.full(k, last)))
    # the vertical pit: returns down its wall and on its floor
    a = rng.uniform(0, 2 * np.pi, 140); d = rng.uniform(0.9, pd, 140); g = float(demo_ground(px, py))
    add(px + (pr - 0.15) * np.cos(a), py + (pr - 0.15) * np.sin(a), g - d)
    a = rng.uniform(0, 2 * np.pi, 50); r = pr * np.sqrt(rng.uniform(0, 1, 50)) * 0.9
    add(px + r * np.cos(a), py + r * np.sin(a), g - pd + rng.normal(0, 0.05, 50), cls=2)
    # the slanted pit, and a deeper group to the east of its end
    s = rng.uniform(0.9, sl, 170); a = rng.uniform(0, 2 * np.pi, 170); g = float(demo_ground(sx, sy))
    add(sx + s + 0.5 * np.cos(a), sy + 1.1 * np.sin(a), g - s + 0.5 * np.cos(a))
    dx, dy, dd = D['slant_deep']; q = rng.normal(0, 0.45, (30, 3))
    add(dx + q[:, 0], dy + q[:, 1], float(demo_ground(dx, dy)) - dd + q[:, 2])
    # the wall's face: returns all over it, except at the opening at its foot; then the opening's returns, running
    # into the rock from the face
    ox_, ol = D['cliff_open']; cy0, run, ch = D['cliff_y'], D['cliff_run'], D['cliff_h']; k = int(W * ch * 10)
    fx = rng.uniform(0, W, k); ft = rng.uniform(0, 1, k)
    m = ~((np.abs(fx - ox_) < 1.0) & (ft * ch < 2.2)); fx, ft = fx[m], ft[m]
    add(fx, cy0 + ft * run + rng.normal(0, 0.02, len(fx)), demo_ground(fx, np.full(len(fx), cy0)) + ft * ch)
    k = 70; hh = rng.uniform(0.4, 1.8, k); gl = float(demo_ground(ox_, cy0))
    add(ox_ + rng.uniform(-0.8, 0.8, k), cy0 + hh / ch * run + rng.uniform(0.3, ol, k), gl + hh)
    # the crack
    k = 80; cx_ = rng.uniform(c0 + 0.3, c1 - 0.3, k)
    add(cx_, cy + rng.uniform(-0.2, 0.2, k), demo_ground(cx_, np.full(k, cy)) - rng.uniform(1.0, cd, k))
    lx, ly, ld = D['deep_pair']; add(np.full(2, lx), ly, float(demo_ground(lx, ly)) - ld - np.array([0.0, 0.6]))
    # lone returns
    lx, ly, ld = D['lone_far']; add(lx, ly, float(demo_ground(lx, ly)) - ld)
    lx, ly, ld = D['lone_near']; add(lx, ly, float(demo_ground(lx, ly)) - ld)
    # one pass with stripes of returns far below the ground, and its ordinary returns
    x0, x1, y0, y1 = D['stripes']; k = 12000
    sx_ = rng.uniform(x0, x1, k); sy_ = rng.uniform(y0, y1, k)
    add(sx_, sy_, demo_ground(sx_, sy_) + rng.normal(0, 0.03, k), cls=2, ps=D['stripe_pass'])
    for lx in np.arange(x0 + 2, x1, 4.0):
        ly = np.arange(y0 + 5, y1 - 5, 1.0)
        add(np.full(len(ly), lx), ly, demo_ground(np.full(len(ly), lx), ly) - (12 + 8 * np.sin(ly / 5.0 + lx)), ps=D['stripe_pass'])
    # a real group right on a stripe, seen by the other passes: the stripe's returns beside it are kept
    kx, ky, kd = D['confirmed']; q = rng.normal(0, 0.3, (6, 3)); lxs = np.full(3, kx + 2 - (kx - x0 - 2) % 4.0)
    add(kx + q[:, 0], ky + q[:, 1], float(demo_ground(kx, ky)) - kd + q[:, 2])
    add(np.full(3, kx), ky + np.array([-0.5, 0.0, 0.5]), float(demo_ground(kx, ky)) - kd, ps=D['stripe_pass'])
    # brush: returns 0.3-2 m above the ground in one patch
    b0, b1, b2, b3 = D['brush']; k = int((b1 - b0) * (b3 - b2) * 6)
    bx_ = rng.uniform(b0, b1, k); by_ = rng.uniform(b2, b3, k)
    add(bx_, by_, demo_ground(bx_, by_) + rng.uniform(0.35, 1.9, k), cls=3, last=False)
    cat = lambda i, dt: np.concatenate([p[i] for p in P]).astype(dt)
    return cat(0, 'f8'), cat(1, 'f8'), cat(2, 'f8'), cat(3, 'u1'), cat(4, 'i4'), cat(5, bool)


# ---------------------------------------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(description='V2 - Ridgewalking: the returns below the ground, their shapes and the ground with its openings.')
    ap.add_argument('--ept'); ap.add_argument('--also-ept', action='append', default=[])
    ap.add_argument('--bbox', nargs=4, type=float, metavar=('W', 'S', 'E', 'N'))
    ap.add_argument('--polygon', help='JSON ring [[lon, lat], ...] (with --npz: [[x, y], ...] in the file\'s metres)')
    ap.add_argument('--npz'); ap.add_argument('--demo', metavar='DIR'); ap.add_argument('--out')
    ap.add_argument('--tile', type=float, default=96.0); ap.add_argument('--margin', type=float, default=12.0)
    ap.add_argument('--workers', type=int, default=0); ap.add_argument('--no-shapes', action='store_true')
    ap.add_argument('--cell', type=float, default=PARAMS['cell'])
    ap.add_argument('--min-behind', type=float, default=PARAMS['min_behind'], help='m behind the local face for a return to count as below ground')
    ap.add_argument('--max-link', type=float, default=PARAMS['max_link'], help='m, the longest guessed link (tie or way out) a shape may rest on')
    ap.add_argument('--debug', action='store_true', help='also write debug.npz (per below return: feature, open, sideways)')
    ap.add_argument('--keep-work', action='store_true', help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    t0 = time.time(); out = a.demo or a.out
    if not out or not (a.demo or a.npz or (a.ept and (a.bbox or a.polygon))):
        ap.error('give --ept URL --bbox W S E N --out DIR, or --npz FILE --out DIR, or --demo DIR')
    os.makedirs(out, exist_ok=True)
    cell = float(a.cell); K = PARAMS['coarse']
    C = dict(out=out, tmp=os.path.join(out, '_work'), cell=cell, coarse=K, tile_c=max(K, int(round(a.tile / cell / K)) * K),
             marg_c=max(4, int(round(a.margin / cell))), shapes=not a.no_shapes, debug=a.debug,
             workers=a.workers or max(1, min((os.cpu_count() or 2) - 1, 20)), ox=0.0, oy=0.0, read_timeout=120, min_behind=float(a.min_behind), max_link=float(a.max_link))
    shutil.rmtree(C['tmp'], ignore_errors=True); os.makedirs(C['tmp'])
    notes = []; ring = None
    if a.polygon:
        ring = json.load(open(a.polygon))
        if isinstance(ring, dict): ring = ring.get('ring') or ring.get('coordinates') or ring.get('polygon')
        while ring and isinstance(ring[0][0], (list, tuple)): ring = ring[0]
        ring = np.asarray(ring, 'f8')[:, :2]
    meta = dict(epsg=None, zone=None, south=False, bbox_lonlat=None)
    say(0, 'start')
    if a.ept:
        import urllib.request
        bb = a.bbox or [ring[:, 0].min(), ring[:, 1].min(), ring[:, 0].max(), ring[:, 1].max()]
        W_, S_, E_, N_ = (float(v) for v in bb)
        zone = int(((W_ + E_) / 2 + 180) / 6) + 1; south = (S_ + N_) / 2 < 0
        ex, ey = lonlat_to_utm(np.linspace(W_, E_, 9)[None, :].repeat(9, 0).ravel(), np.linspace(S_, N_, 9)[:, None].repeat(9, 1).ravel(), zone)
        C['ox'] = float(math.floor(ex.min())); C['oy'] = float(math.floor(ey.min()))
        C['nx'] = int(math.ceil((ex.max() - C['ox']) / cell)); C['ny'] = int(math.ceil((ey.max() - C['oy']) / cell))
        C['zone'] = zone; C['south'] = bool(south); C['epsg'] = (32700 if south else 32600) + zone; C['epts'] = []
        for url in [a.ept] + list(a.also_ept):
            try:
                J = json.load(urllib.request.urlopen(url, timeout=60) if '://' in url else open(url))
                code = int((J.get('srs') or {}).get('horizontal') or 0)
            except Exception as e:
                raise SystemExit('[ridge] cannot read the point cloud description: %s' % str(e)[:160])
            if not code:
                raise SystemExit('[ridge] the point cloud does not say its coordinate system')
            if 'PointSourceId' not in [d.get('name') for d in J.get('schema', [])]:
                notes.append('a cloud has no flight pass ids: no patterned-noise check for it')
            C['epts'].append((url, code))
        if ring is not None:
            rx, ry = lonlat_to_utm(ring[:, 0], ring[:, 1], zone); C['ring'] = np.c_[rx - C['ox'], ry - C['oy']]
        meta = dict(epsg=C['epsg'], zone=zone, south=bool(south), bbox_lonlat=[W_, S_, E_, N_])
    else:
        if a.demo:
            x, y, z, c, ps, last = demo_points()
        else:
            with np.load(a.npz) as Zf:
                x, y, z = (np.asarray(Zf[k], 'f8') for k in ('x', 'y', 'z')); c = np.asarray(Zf['c'])
                ps = np.asarray(Zf['psid']) if 'psid' in Zf.files else np.zeros(len(x), 'i4')
                if 'psid' not in Zf.files: notes.append('the file has no flight pass ids: no patterned-noise check')
                last = (np.asarray(Zf['rn']) == np.asarray(Zf['nr'])) if 'rn' in Zf.files and 'nr' in Zf.files else np.ones(len(x), bool)
        C['ox'] = float(math.floor(x.min())); C['oy'] = float(math.floor(y.min()))
        x = x - C['ox']; y = y - C['oy']
        C['nx'] = int(math.ceil((x.max() + 1e-6) / cell)); C['ny'] = int(math.ceil((y.max() + 1e-6) / cell))
        if ring is not None: C['ring'] = ring - [C['ox'], C['oy']]
        split_points(C, x, y, z, c, ps, last); del x, y, z, c, ps, last
    say(1, 'area %.0f x %.0f m, %d tiles, %d workers' % (C['nx'] * cell, C['ny'] * cell, len(tile_list(C)), C['workers']))
    counts, passes, cover = run(C, notes)
    notes.append('Tile-independent: groups, lone returns, noise and features (worked over the whole area, each cluster in its own box). '
                 'Depends on the tile cut: the fill of ground gaps near a tile\'s margin edge; the water level of a hollow wider than the '
                 'margin whose rim is thinner than %g m (the area-wide fill is on a %g m grid); the face fits use the returns within 12 m of the tile, so a chain of '
                 'candidates joining the face from farther away is not followed. The patterned-noise decision is made on blocks of %g m that '
                 'do not move with the tile size; a pass flagged in any block is set aside over the whole area.' % (2 * K * cell, K * cell, PARAMS['pass_block']))
    if not a.keep_work:
        shutil.rmtree(C['tmp'], ignore_errors=True)
    ox, oy = C['ox'], C['oy']
    J = dict(version=1, epsg=meta['epsg'], zone=meta['zone'], south=meta['south'], origin=[ox, oy],
             bbox_utm=[ox, oy, ox + C['nx'] * cell, oy + C['ny'] * cell], bbox_lonlat=meta['bbox_lonlat'], cell=cell, nx=C['nx'], ny=C['ny'],
             params=dict(PARAMS, cell=cell, min_behind=C['min_behind'], max_link=C['max_link'], tile=C['tile_c'] * cell, margin=C['marg_c'] * cell, workers=C['workers'], shapes=C['shapes']),
             counts=counts, passes=passes, ground_cover=round(cover, 3), stages=C.get('stages'), seconds=round(time.time() - t0, 1), notes=notes)
    json.dump(J, open(os.path.join(out, 'ridge.json'), 'w'), indent=1)
    say(100, 'done in %.0f s: %d returns, %d below the ground in %d groups, %d lone, %d likely noise, %d patterned noise; %d features' % (
        J['seconds'], counts['returns'], counts['below'], counts['groups'], counts['lone'], counts['likely_noise'], counts['pattern_noise'], counts['features']))
    return J


if __name__ == '__main__':
    main()
