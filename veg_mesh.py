#!/usr/bin/env python3
"""
veg_mesh.py -- triangle mesh tools for FLEX's vegetation shell (numpy + scipy).

    simplify(verts, tris, target_tris, attrs=None, ...) -> verts, tris, attrs
    clean(verts, tris, attrs=None, ...)                 -> verts, tris, attrs
    distance_to_mesh(points, verts, tris)               -> distances
    mesh_error(verts0, tris0, verts1, tris1)            -> {mean, p90, max, ...}
    edge_counts(tris), volume(verts, tris)              checks used by the tests

simplify is quadric error edge collapse (Garland and Heckbert), run in passes
so that each pass is plain numpy over all edges at once instead of a priority
queue walked one edge at a time:

  1. every vertex carries the sum of the quadrics of the planes of the
     triangles around it (area weighted), plus a very small pull toward its
     own position so flat places stay well defined;
  2. every edge gets a cost: the quadric error at the best point for the
     merged vertex (the quadric's minimum when it lies near the edge, else
     the best of the ends and the midpoint), plus a small term for the
     edge's length so long thin triangles are not made;
  3. a pass collapses the edges that are the cheapest within two rings of
     both their ends. No two of them touch a common triangle, so every
     check below sees each triangle once and they can all be applied
     together;
  4. a collapse is refused when the surface would stop being a manifold
     (the two ends must share exactly two neighbours, the link condition;
     no vertex may drop under three neighbours), when a triangle around it
     would flip or turn by more than ~75 degrees, or when it would leave a
     needle triangle;
  5. repeat until the triangle count reaches the target (the last pass takes
     only the cheapest collapses it needs) or nothing can be collapsed.

A pass removes several percent of the vertices, so a few million triangles
take a few dozen passes; each pass is a handful of sorts and bincounts.
Vertices on edges that are not shared by exactly two triangles (open borders,
non-manifold junctions) never move. Orientation is kept (only indices change,
and flips are refused). Per-vertex attributes are interpolated along the
collapsed edge at the merged vertex's position.

clean removes what is not a surface: triangles with a repeated corner or no
area, duplicate triangles (and back-to-back pairs, a sheet of no thickness),
pieces with few triangles or a small extent, and smooths "spike" vertices
whose ring of triangles folds back on itself (the tip of a fin).
"""

import math

import numpy as np

# Quadric layout per vertex: a2 ab ac ad b2 bc bd c2 cd d2 (plane a x + b y +
# c z + d = 0, weighted by the triangle's area).
_QA2, _QAB, _QAC, _QAD, _QB2, _QBC, _QBD, _QC2, _QCD, _QD2 = range(10)


def _say_none(msg):
    pass


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------

def face_normals(verts, tris):
    """Unnormalised normals (length = twice the area)."""
    p0, p1, p2 = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    return np.cross(p1 - p0, p2 - p0)


def edge_counts(tris):
    """Undirected edge -> number of triangles using it (sorted pairs)."""
    t = np.asarray(tris, np.int64)
    e = np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]])
    e.sort(1)
    n = int(t.max()) + 1 if len(t) else 1
    u, c = np.unique(e[:, 0] * n + e[:, 1], return_counts=True)
    return np.stack([u // n, u % n], 1), c


def volume(verts, tris):
    """Signed volume (positive = counter-clockwise seen from outside)."""
    if len(tris) == 0:
        return 0.0
    v = np.asarray(verts, np.float64)
    c = v.mean(0)
    p0, p1, p2 = v[tris[:, 0]] - c, v[tris[:, 1]] - c, v[tris[:, 2]] - c
    return float(np.einsum('ij,ij->i', p0, np.cross(p1, p2)).sum() / 6.0)


def compact(verts, tris, attrs=None):
    """Drop unused vertices and renumber."""
    used = np.zeros(len(verts), bool)
    used[tris.ravel()] = True
    remap = np.cumsum(used) - 1
    tris = remap[tris].astype(np.int64)
    verts = verts[used]
    if attrs is not None:
        attrs = attrs[used]
    return verts, tris, attrs


def _quality(p0, p1, p2):
    """4 sqrt(3) area / sum of squared edges: 1 equilateral, 0 needle."""
    n = np.cross(p1 - p0, p2 - p0)
    a2 = np.einsum('ij,ij->i', n, n)
    s = (np.einsum('ij,ij->i', p1 - p0, p1 - p0) +
         np.einsum('ij,ij->i', p2 - p1, p2 - p1) +
         np.einsum('ij,ij->i', p0 - p2, p0 - p2))
    return 2.0 * math.sqrt(3.0) * np.sqrt(a2) / np.maximum(s, 1e-300), n


def _vertex_quadrics(verts, tris, reg):
    nv = len(verts)
    n = face_normals(verts, tris)
    ln = np.linalg.norm(n, axis=1)
    area = 0.5 * ln
    ok = ln > 0
    u = np.zeros_like(n)
    u[ok] = n[ok] / ln[ok, None]
    d = -np.einsum('ij,ij->i', u, verts[tris[:, 0]])
    a, b, c = u[:, 0], u[:, 1], u[:, 2]
    comps = (a * a, a * b, a * c, a * d, b * b, b * c, b * d, c * c, c * d,
             d * d)
    Q = np.empty((nv, 10), np.float64)
    idx = tris.ravel()
    for k, comp in enumerate(comps):
        w = np.repeat(comp * area, 3)
        Q[:, k] = np.bincount(idx, w, minlength=nv)
    varea = np.bincount(idx, np.repeat(area, 3), minlength=nv) / 3.0
    # A small pull toward the vertex's own position: w |p - v|^2.
    w = reg * max(float(area.mean()) if len(area) else 1.0, 1e-12)
    x, y, z = verts[:, 0], verts[:, 1], verts[:, 2]
    Q[:, _QA2] += w
    Q[:, _QB2] += w
    Q[:, _QC2] += w
    Q[:, _QAD] -= w * x
    Q[:, _QBD] -= w * y
    Q[:, _QCD] -= w * z
    Q[:, _QD2] += w * (x * x + y * y + z * z)
    return Q, varea


def _qerr(q, p):
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    return (q[:, _QA2] * x * x + 2 * q[:, _QAB] * x * y +
            2 * q[:, _QAC] * x * z + q[:, _QB2] * y * y +
            2 * q[:, _QBC] * y * z + q[:, _QC2] * z * z +
            2 * (q[:, _QAD] * x + q[:, _QBD] * y + q[:, _QCD] * z) +
            q[:, _QD2])


def _qmin(q):
    """Minimum point of each quadric (3x3 solve by cofactors) and whether it
    is well conditioned."""
    a, b, c = q[:, _QA2], q[:, _QAB], q[:, _QAC]
    e, f, i = q[:, _QB2], q[:, _QBC], q[:, _QC2]
    r0, r1, r2 = -q[:, _QAD], -q[:, _QBD], -q[:, _QCD]
    A = e * i - f * f
    B = c * f - b * i
    C = b * f - c * e
    E = a * i - c * c
    F = b * c - a * f
    I = a * e - b * b
    det = a * A + b * B + c * C
    tr = a + e + i
    good = np.abs(det) > 1e-10 * np.maximum(tr, 1e-300) ** 3
    sd = np.where(good, det, 1.0)
    x = (A * r0 + B * r1 + C * r2) / sd
    y = (B * r0 + E * r1 + F * r2) / sd
    z = (C * r0 + F * r1 + I * r2) / sd
    return np.stack([x, y, z], 1), good


def _edge_costs(Q, V, ea, eb, chunk=1 << 20):
    """Per edge: the merged vertex's position, its quadric error and the
    squared edge length, in chunks (bounded memory). The position is the
    quadric's minimum where it is well defined and near the edge, else the
    best of the midpoint and the two ends."""
    m = len(ea)
    best = np.empty((m, 3))
    cbest = np.empty(m)
    L2 = np.empty(m)
    for s in range(0, m, chunk):
        a, b = ea[s:s + chunk], eb[s:s + chunk]
        q = Q[a] + Q[b]
        pa, pb = V[a], V[b]
        pm = 0.5 * (pa + pb)
        popt, good = _qmin(q)
        l2 = np.einsum('ij,ij->i', pb - pa, pb - pa)
        dm = popt - pm
        good &= np.einsum('ij,ij->i', dm, dm) <= l2      # stay near the edge
        bp = np.where(good[:, None], popt, pm)
        cb = _qerr(q, bp)
        bad = np.nonzero(~good)[0]
        if len(bad):
            qb = q[bad]
            for p_ in (pa[bad], pb[bad]):
                c_ = _qerr(qb, p_)
                take = c_ < cb[bad]
                bp[bad[take]] = p_[take]
                cb[bad[take]] = c_[take]
        best[s:s + chunk] = bp
        cbest[s:s + chunk] = np.maximum(cb, 0.0)
        L2[s:s + chunk] = l2
    return best, cbest, L2


# --------------------------------------------------------------------------
# Simplify
# --------------------------------------------------------------------------

def simplify(verts, tris, target_tris, attrs=None, shape_weight=0.001,
             max_error=None, reg=1e-5, min_quality=0.03, max_turn_deg=75.0,
             max_passes=400, rounds=40, pass_frac=0.3, say=None,
             stats=None):
    """Quadric error edge collapse down to target_tris triangles.

    verts (n, 3), tris (m, 3) counter-clockwise, attrs (n,) or (n, k) or
    None. shape_weight: cost of an edge's length relative to the error (a
    collapse costs error + shape_weight * length^2 per unit area), keeps
    triangles near even. max_error (m, optional): stop early when the
    cheapest remaining collapse would move the surface by more than this
    (rms over the merged vertex's planes). Returns (verts, tris, attrs),
    compacted; stats (a dict, optional) gets passes, collapses, the rms
    error estimate of the last accepted collapses ('last_rms') and seconds.
    """
    import time
    from scipy import sparse
    say = say or _say_none
    t0 = time.time()
    V = np.array(verts, np.float64)
    T = np.array(tris, np.int64).reshape(-1, 3)
    A = None
    if attrs is not None:
        A = np.array(attrs, np.float64)
        squeeze = A.ndim == 1
        if squeeze:
            A = A[:, None]
    nv = len(V)
    target_tris = int(max(0, target_tris))
    info = {"passes": 0, "collapses": 0, "from_tris": int(len(T)),
            "last_rms": 0.0, "stopped": "target"}
    if len(T) <= target_tris or len(T) == 0:
        out = compact(V, T, A)
        if A is not None and squeeze:
            out = (out[0], out[1], out[2][:, 0])
        if stats is not None:
            stats.update(info, seconds=round(time.time() - t0, 3))
        return out

    # Drop degenerate triangles first; lock vertices on edges that are not
    # shared by exactly two triangles.
    T = T[(T[:, 0] != T[:, 1]) & (T[:, 1] != T[:, 2]) & (T[:, 2] != T[:, 0])]
    Q, varea = _vertex_quadrics(V, T, reg)
    locked = np.zeros(nv, bool)
    # One sort of the undirected edges, each tagged with its direction: an
    # edge is fine when it has exactly two uses, one each way.
    d = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    lo, hi = np.minimum(d[:, 0], d[:, 1]), np.maximum(d[:, 0], d[:, 1])
    k2 = np.sort((lo * nv + hi) * 2 + (d[:, 0] > d[:, 1]))
    del d, lo, hi
    k = k2 >> 1
    start = np.r_[True, k[1:] != k[:-1]]
    gi = np.cumsum(start) - 1
    cnt = np.bincount(gi)
    nfl = np.bincount(gi, k2 & 1)
    badg = (cnt != 2) | (nfl != 1)
    kb = k[start][badg]
    locked[kb // nv] = True
    locked[kb % nv] = True
    del k2, k, start, gi, cnt, nfl, badg, kb
    cos_turn = math.cos(math.radians(max_turn_deg))
    live_v = nv
    touched = np.zeros(nv, np.int64)     # last pass a vertex's ring changed
    rk = np.zeros(0, np.int64)          # refused edges (a * n + b) ...
    rp = np.zeros(0, np.int64)          # ... and the pass that refused them
    rej_why = {"link": 0, "flip": 0, "needle": 0}

    for it in range(max_passes):
        F = len(T)
        if F <= target_tris:
            break
        # Compact when much of the vertex array is dead.
        if it and live_v < 0.6 * len(V):
            used = np.zeros(len(V), bool)
            used[T.ravel()] = True
            remap = np.cumsum(used) - 1
            T = remap[T]
            n_old = len(V)
            V, Q, varea, locked = V[used], Q[used], varea[used], locked[used]
            touched = touched[used]
            if A is not None:
                A = A[used]
            ra, rb = rk // n_old, rk % n_old
            okr = used[ra] & used[rb]
            rk = remap[ra[okr]] * len(V) + remap[rb[okr]]
            rp = rp[okr]
            o_ = np.argsort(rk)
            rk, rp = rk[o_], rp[o_]
        n = len(V)
        # Undirected edges: on a closed oriented manifold each appears once
        # as (a, b) with a < b. Others touch locked vertices anyway.
        e_dir = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
        e = e_dir[e_dir[:, 0] < e_dir[:, 1]]
        ea, eb = e[:, 0], e[:, 1]
        cand = ~(locked[ea] | locked[eb])
        ea, eb = ea[cand], eb[cand]
        if len(ea) == 0:
            info["stopped"] = "locked"
            break
        best, cbest, L2 = _edge_costs(Q, V, ea, eb)
        ar = np.maximum(varea[ea] + varea[eb], 1e-12)
        score = cbest + shape_weight * L2 * ar
        if max_error is not None:
            okm = cbest <= (max_error ** 2) * ar
            if not okm.any():
                info["stopped"] = "max_error"
                break
            score = np.where(okm, score, np.inf)
        # Only the cheaper part of the edges competes in a pass (keeps the
        # order close to a one-at-a-time greedy collapse).
        need = int(math.ceil((F - target_tris) / 2.0))
        fin = np.isfinite(score)
        # Edges refused before, whose surroundings have not changed since,
        # would be refused again: leave them out.
        if len(rk):
            ekey = ea * n + eb
            pos = np.minimum(np.searchsorted(rk, ekey), len(rk) - 1)
            hit = rk[pos] == ekey
            hp = rp[pos]
            stale = hit & (touched[ea] < hp) & (touched[eb] < hp)
            fin &= ~stale
            score = np.where(stale, np.inf, score)
        if pass_frac < 1.0:
            kth = max(need, int(pass_frac * len(score)))
            if kth < len(score):
                thr = np.partition(score, kth)[kth]
                fin &= score <= thr
        # Local minima within two rings: rank -> unique keys. Rounds:
        # refused edges drop out, the neighbourhoods of accepted ones are
        # blocked, the rest choose again.
        # The key: the score's float bits with the edge's index in the low
        # bits (unique, nearly the score's order, no sort needed).
        nbits = max(1, int(len(score) - 1).bit_length())
        sc = np.where(fin, score, 0.0).astype(np.float64)
        key = (sc.view(np.int64) >> nbits << nbits) | np.arange(len(score))
        BIG = np.iinfo(np.int64).max
        key[~fin] = BIG
        deg = np.bincount(T.ravel(), minlength=n)

        def self_check(si):
            """Refuse collapses that break the manifold, flip or turn a
            triangle too far, or leave a needle."""
            sa, sb, sp = ea[si], eb[si], best[si]
            ns = len(si)
            own = np.full(n, -1, np.int64)
            own[sa] = np.arange(ns)
            own[sb] = np.arange(ns)
            to = own[T].max(1)
            aff = np.nonzero(to >= 0)[0]
            Ta = T[aff]
            o = to[aff]
            isa = Ta == sa[o][:, None]
            isb = Ta == sb[o][:, None]
            # Link condition: the ends share exactly two neighbours (the
            # far corners of the edge's two triangles), each keeping >= 3.
            other = ~(isa | isb)
            ha = isa.any(1)
            hb = isb.any(1)
            r, c = np.nonzero(other)
            w = Ta[r, c]
            ro = o[r]
            k2 = np.concatenate([(ro[ha[r]] * n + w[ha[r]]) * 2,
                                 (ro[hb[r]] * n + w[hb[r]]) * 2 + 1])
            k2.sort()
            k2 = k2[np.r_[True, k2[1:] != k2[:-1]]]
            kk = k2 >> 1
            com = kk[1:][kk[1:] == kk[:-1]]
            co, cw = com // n, com % n
            ncom = np.bincount(co, minlength=ns)
            reject = ncom != 2
            # (a border vertex may keep one triangle)
            spare = deg[cw] - np.where(locked[cw], 1, 3)
            dmin = np.full(ns, 99, np.int64)
            np.minimum.at(dmin, co, spare)
            reject |= dmin <= 0
            reject |= (deg[sa] + deg[sb] - 4) < 3
            rej_why["link"] += int(reject.sum())
            mv = isa | isb
            chk = mv.sum(1) == 1
            Ta, o, mv = Ta[chk], o[chk], mv[chk]
            P0 = V[Ta]
            P1 = P0.copy()
            r, cidx = np.nonzero(mv)
            P1[r, cidx] = sp[o[r]]
            q0, n0 = _quality(P0[:, 0], P0[:, 1], P0[:, 2])
            q1, n1 = _quality(P1[:, 0], P1[:, 1], P1[:, 2])
            l0 = np.linalg.norm(n0, axis=1)
            l1 = np.linalg.norm(n1, axis=1)
            dot = np.einsum('ij,ij->i', n0, n1)
            flip = (dot <= cos_turn * l0 * l1) | \
                (l1 <= 1e-12 * np.maximum(l0, 1e-300))
            needle = (q1 < min_quality) & (q1 < q0)
            bf = np.zeros(ns, bool)
            bf[o[flip]] = True
            bn = np.zeros(ns, bool)
            bn[o[needle]] = True
            rej_why["flip"] += int((bf & ~reject).sum())
            rej_why["needle"] += int((bn & ~bf & ~reject).sum())
            return reject | bf | bn

        blocked = np.zeros(n, bool)
        acc_all = []
        new_rej = []
        n_acc = 0
        live = key != BIG
        for rnd in range(rounds):
            live &= ~blocked[ea] & ~blocked[eb]
            li = np.nonzero(live)[0]
            if len(li) == 0:
                break
            la, lb, lk = ea[li], eb[li], key[li]
            m1 = np.full(n, BIG, np.int64)
            np.minimum.at(m1, la, lk)
            np.minimum.at(m1, lb, lk)
            # two rings: the neighbours' minima, through every edge (both
            # ways; on a closed mesh e_dir holds each edge in each direction)
            m2 = m1.copy()
            np.minimum.at(m2, e_dir[:, 0], m1[e_dir[:, 1]])
            si = li[(lk == m2[la]) & (lk == m2[lb])]
            if len(si) == 0:
                break
            reject = self_check(si)
            live[np.searchsorted(li, si[reject])] = False
            new_rej.append(si[reject])
            ok = si[~reject]
            if len(ok):
                acc_all.append(ok)
                n_acc += len(ok)
                bv = np.zeros(n, bool)
                bv[ea[ok]] = True
                bv[eb[ok]] = True
                tb = bv[T].any(1)
                blocked[T[tb].ravel()] = True
            if n_acc >= need or (rnd and len(ok) < 0.01 * n_acc):
                break
        if not acc_all:
            info["stopped"] = "stuck"
            break
        acc = np.concatenate(acc_all)
        # Each collapse removes two triangles: take only what is needed.
        if len(acc) > need:
            acc = acc[np.argsort(score[acc], kind='stable')[:need]]
        a, b, p = ea[acc], eb[acc], best[acc]
        # Remember refusals; mark the rings that change now.
        bv = np.zeros(n, bool)
        bv[a] = True
        bv[b] = True
        touched[T[bv[T].any(1)].ravel()] = it + 1
        nr = np.concatenate(new_rej) if new_rej else np.zeros(0, np.int64)
        if len(nr):
            keep_old = (touched[rk // n] <= rp) & (touched[rk % n] <= rp) \
                if len(rk) else np.zeros(0, bool)
            rk = np.concatenate([rk[keep_old], ea[nr] * n + eb[nr]])
            rp = np.concatenate([rp[keep_old],
                                 np.full(len(nr), it + 1, np.int64)])
            rk, ui = np.unique(rk, return_index=True)
            rp = rp[ui]
        if A is not None:
            ab = V[b] - V[a]
            t = np.einsum('ij,ij->i', p - V[a], ab) / np.maximum(
                np.einsum('ij,ij->i', ab, ab), 1e-300)
            t = np.clip(t, 0.0, 1.0)[:, None]
            A[a] = (1 - t) * A[a] + t * A[b]
        info["last_rms"] = float(np.sqrt(np.max(
            cbest[acc] / np.maximum(varea[a] + varea[b], 1e-12))))
        V[a] = p
        Q[a] += Q[b]
        varea[a] += varea[b]
        remap = np.arange(n)
        remap[b] = a
        T = remap[T]
        T = T[(T[:, 0] != T[:, 1]) & (T[:, 1] != T[:, 2]) &
              (T[:, 2] != T[:, 0])]
        live_v -= len(acc)
        info["passes"] = it + 1
        info["collapses"] += int(len(acc))
        if it % 5 == 0:
            say(f"    pass {it + 1}: {len(T):,} triangles "
                f"({len(acc):,} collapses, {time.time() - t0:.1f} s)")
    else:
        info["stopped"] = "passes"
    V, T, A = compact(V, T, A)
    if A is not None and squeeze:
        A = A[:, 0]
    info["seconds"] = round(time.time() - t0, 3)
    info["to_tris"] = int(len(T))
    info["refused"] = rej_why
    if stats is not None:
        stats.update(info)
    return V, T, A


# --------------------------------------------------------------------------
# Clean
# --------------------------------------------------------------------------

def components(nv, tris):
    """Connected component label per vertex (through triangles), count."""
    from scipy import sparse
    from scipy.sparse import csgraph
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]]])
    G = sparse.coo_matrix((np.ones(len(e), np.int8), (e[:, 0], e[:, 1])),
                          shape=(nv, nv))
    n, lab = csgraph.connected_components(G, directed=False)
    return lab, n


def clean(verts, tris, attrs=None, min_tris=20, min_size=0.0,
          min_volume=0.0, spike=0.35, spike_iters=3, say=None, stats=None):
    """Remove what is not a surface; returns (verts, tris, attrs) compacted.

    * triangles with a repeated corner or (nearly) no area;
    * duplicate triangles; two triangles on the same corners facing opposite
      ways (a sheet of no thickness) are both dropped;
    * connected pieces with fewer than min_tris triangles, an extent
      (bounding box diagonal) under min_size, or |volume| under min_volume;
    * spike vertices: the area-weighted mean normal of the triangles around
      a vertex is shorter than `spike` times their total area (the ring
      folds back, as at the tip of a fin) -> the vertex moves to the mean
      of its neighbours, spike_iters times (only those vertices move).
    """
    say = say or _say_none
    V = np.array(verts, np.float64)
    T = np.array(tris, np.int64).reshape(-1, 3)
    A = None if attrs is None else np.array(attrs, np.float64)
    info = {"in_tris": int(len(T))}
    if len(T) == 0:
        if stats is not None:
            stats.update(info, out_tris=0)
        return V[:0], T, (None if A is None else A[:0])
    T = T[(T[:, 0] != T[:, 1]) & (T[:, 1] != T[:, 2]) & (T[:, 2] != T[:, 0])]
    # Duplicates and back-to-back pairs.
    s = np.sort(T, 1)
    nv = len(V)
    key = (s[:, 0] * nv + s[:, 1]) * nv + s[:, 2] if nv < 2 ** 21 else None
    if key is None:
        _, inv, cnt = np.unique(s, axis=0, return_inverse=True,
                                return_counts=True)
    else:
        _, inv, cnt = np.unique(key, return_inverse=True, return_counts=True)
    inv = inv.ravel()
    dup = cnt[inv] > 1
    keep = ~dup
    if dup.any():
        # Of a group of identical corner sets keep one triangle only when
        # all of them face the same way (a plain duplicate).
        di = np.nonzero(dup)[0]
        # orientation parity: even permutation of the sorted order or not
        par = _parity(T[di])
        g = inv[di]
        pos = np.bincount(g, par == 0, minlength=len(cnt))
        neg = np.bincount(g, par == 1, minlength=len(cnt))
        same = (pos == 0) | (neg == 0)
        first = np.zeros(len(cnt), bool)
        o = np.argsort(g, kind='stable')
        gs = g[o]
        firsts = o[np.r_[True, gs[1:] != gs[:-1]]]
        keep[di[firsts]] = same[g[firsts]]
        del first
    info["duplicates"] = int(dup.sum() - keep[dup].sum()) if dup.any() else 0
    T = T[keep]
    # Zero-area triangles.
    n = face_normals(V, T)
    ln = np.linalg.norm(n, axis=1)
    scale = np.median(ln) if len(ln) else 1.0
    zero = ln <= 1e-9 * max(scale, 1e-300)
    info["zero_area"] = int(zero.sum())
    T = T[~zero]
    # Small pieces.
    if len(T):
        lab, nc = components(nv, T)
        tl = lab[T[:, 0]]
        tcount = np.bincount(tl, minlength=nc)
        drop = tcount < min_tris
        if min_size > 0:
            mn = np.full((nc, 3), np.inf)
            mx = np.full((nc, 3), -np.inf)
            used = np.zeros(nv, bool)
            used[T.ravel()] = True
            for d in range(3):
                np.minimum.at(mn[:, d], lab[used], V[used, d])
                np.maximum.at(mx[:, d], lab[used], V[used, d])
            diag = np.linalg.norm(np.where(np.isfinite(mx - mn), mx - mn, 0), axis=1)
            drop |= diag < min_size
        if min_volume > 0:
            p0, p1, p2 = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
            c = V[T.ravel()].mean(0)
            sv = np.einsum('ij,ij->i', p0 - c, np.cross(p1 - c, p2 - c)) / 6.0
            vol = np.bincount(tl, sv, minlength=nc)
            drop |= np.abs(vol) < min_volume
        info["pieces"] = int(nc)
        info["pieces_dropped"] = int(drop[np.unique(tl)].sum())
        T = T[~drop[tl]]
    # Spikes.
    moved = 0
    for _ in range(max(0, spike_iters)):
        if not len(T) or spike <= 0:
            break
        n = face_normals(V, T)
        ln = np.linalg.norm(n, axis=1)
        idx = T.ravel()
        sn = np.stack([np.bincount(idx, np.repeat(n[:, d], 3), minlength=nv)
                       for d in range(3)], 1)
        sa_ = np.bincount(idx, np.repeat(ln, 3), minlength=nv)
        bad = (np.linalg.norm(sn, axis=1) < spike * sa_) & (sa_ > 0)
        if not bad.any():
            break
        e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
        cnt = np.bincount(e[:, 0], minlength=nv)
        avg = np.stack([np.bincount(e[:, 0], V[e[:, 1], d], minlength=nv)
                        for d in range(3)], 1) / np.maximum(cnt, 1)[:, None]
        V[bad] = avg[bad]
        if A is not None:
            if A.ndim == 1:
                aa = np.bincount(e[:, 0], A[e[:, 1]], minlength=nv) / np.maximum(cnt, 1)
            else:
                aa = np.stack([np.bincount(e[:, 0], A[e[:, 1], k], minlength=nv)
                               for k in range(A.shape[1])], 1) / np.maximum(cnt, 1)[:, None]
            A[bad] = aa[bad]
        moved += int(bad.sum())
    info["spikes_smoothed"] = moved
    V, T, A = compact(V, T, A)
    info["out_tris"] = int(len(T))
    if stats is not None:
        stats.update(info)
    return V, T, A


def _parity(t):
    """0 when (t0, t1, t2) is an even rotation of its sorted order, else 1."""
    a, b, c = t[:, 0], t[:, 1], t[:, 2]
    # rotate so the smallest is first, then even iff the next is the middle
    m = np.argmin(t, axis=1)
    r1 = np.where(m == 0, b, np.where(m == 1, c, a))
    r2 = np.where(m == 0, c, np.where(m == 1, a, b))
    return (r1 > r2).astype(np.int8)


# --------------------------------------------------------------------------
# Iso-surface of a 3-D field
# --------------------------------------------------------------------------

def surface_nets(F, iso):
    """Vertices (in sample-index units) and CCW-outside triangles of the
    iso-surface of F (inside = F > iso). F must be padded with outside."""
    inside = F > iso
    nx, ny, nz = F.shape
    c = inside[:-1, :-1, :-1].astype(np.uint8)
    any_in = np.zeros(c.shape, bool)
    all_in = np.ones(c.shape, bool)
    corners = [(i, j, k) for i in (0, 1) for j in (0, 1) for k in (0, 1)]
    for (i, j, k) in corners:
        s = inside[i:nx - 1 + i, j:ny - 1 + j, k:nz - 1 + k]
        any_in |= s
        all_in &= s
    active = any_in & ~all_in
    del any_in, all_in, c
    ai, aj, ak = np.nonzero(active)
    del active
    cube_lin = (ai * (ny - 1) + aj) * (nz - 1) + ak
    # Vertex = mean of the edge crossings of the cube.
    acc = np.zeros((len(ai), 3), np.float64)
    num = np.zeros(len(ai), np.float64)
    edges = []
    for (i, j, k) in corners:
        for d in range(3):
            o = [i, j, k]
            if o[d] == 1:
                continue
            o2 = list(o); o2[d] = 1
            edges.append((tuple(o), tuple(o2)))
    for a, b in edges:
        fa = F[ai + a[0], aj + a[1], ak + a[2]]
        fb = F[ai + b[0], aj + b[1], ak + b[2]]
        cr = (fa > iso) != (fb > iso)
        t = np.where(cr, (iso - fa) / np.where(cr, fb - fa, 1.0), 0.0)
        for d in range(3):
            acc[:, d] += np.where(cr, a[d] + (b[d] - a[d]) * t, 0.0)
        num += cr
    verts = acc / np.maximum(num, 1)[:, None]
    verts[:, 0] += ai; verts[:, 1] += aj; verts[:, 2] += ak
    verts += 0.5          # sample i sits at the centre of voxel i
    del acc, num

    def vid(i, j, k):
        lin = (i * (ny - 1) + j) * (nz - 1) + k
        p = np.searchsorted(cube_lin, lin)
        return p

    tris = []
    # Edges along axis a between samples s and s + e_a; the quad joins the
    # four cubes around it, ordered CCW about +a in the (b, c) plane.
    for a in range(3):
        b, cax = (a + 1) % 3, (a + 2) % 3
        sl0 = [slice(None)] * 3
        sl1 = [slice(None)] * 3
        sl0[a] = slice(0, F.shape[a] - 1)
        sl1[a] = slice(1, F.shape[a])
        i0 = inside[tuple(sl0)]
        i1 = inside[tuple(sl1)]
        cross = i0 != i1
        out_pos = i0 & ~i1                # outward normal along +a
        idx = np.nonzero(cross)
        flip = ~out_pos[idx]
        del cross, out_pos, i0, i1
        p = [idx[0], idx[1], idx[2]]
        ok = (p[b] >= 1) & (p[cax] >= 1)
        p = [q[ok] for q in p]
        flip = flip[ok]
        quad = []
        for db, dc in ((-1, -1), (0, -1), (0, 0), (-1, 0)):
            q = list(p)
            q[b] = p[b] + db
            q[cax] = p[cax] + dc
            quad.append(vid(q[0], q[1], q[2]))
        q0, q1, q2, q3 = quad
        t1 = np.stack([q0, q1, q2], 1)
        t2 = np.stack([q0, q2, q3], 1)
        t1f = np.stack([q0, q2, q1], 1)
        t2f = np.stack([q0, q3, q2], 1)
        t1 = np.where(flip[:, None], t1f, t1)
        t2 = np.where(flip[:, None], t2f, t2)
        tris.append(np.concatenate([t1, t2]))
    tris = np.concatenate(tris) if tris else np.zeros((0, 3), np.int64)
    return verts, tris


def taubin(verts, tris, iters=2, lam=0.5, mu=-0.53):
    """Taubin smoothing (shrink by lam, inflate by mu, alternately), so blobs
    keep their size; uniform weights over the edges."""
    if len(tris) == 0:
        return verts
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    n = len(verts)
    deg = np.bincount(e[:, 0], minlength=n) + np.bincount(e[:, 1], minlength=n)
    v = verts.copy()
    for it in range(iters):
        s = np.zeros_like(v)
        for d in range(3):
            s[:, d] = np.bincount(e[:, 0], v[e[:, 1], d], minlength=n) + \
                np.bincount(e[:, 1], v[e[:, 0], d], minlength=n)
        avg = s / np.maximum(deg, 1)[:, None]
        # Taubin: shrink then inflate a little, so blobs keep their size.
        k = lam if it % 2 == 0 else mu
        v = v + k * (avg - v)
    return v

def well_composed(F, iso, max_iter=20):
    """F with the fewest samples raised just above iso so that the inside set
    (F > iso) has no diagonal-only contacts: no 2x2 square in any axis plane
    with only one diagonal inside, no 2x2x2 cube with only two opposite
    corners inside (or outside). Surface nets then gives a manifold: every
    edge in exactly two triangles. Of the two samples that could join a
    diagonal the one with the higher F is raised. Returns (F, raised)."""
    F = np.array(F, np.float32, copy=True)
    up = np.float32(iso + 1e-3 * max(1.0, abs(iso)))
    total = 0
    corners = [(i, j, k) for i in (0, 1) for j in (0, 1) for k in (0, 1)]

    def cs(o):
        return tuple(slice(o[d], F.shape[d] - 1 + o[d]) for d in range(3))
    for _ in range(max_iter):
        inside = F > iso
        fill = np.zeros(inside.shape, bool)
        for (p, q) in ((0, 1), (0, 2), (1, 2)):
            def sl(dp, dq):
                s_ = [slice(None)] * 3
                s_[p] = slice(dp, F.shape[p] - 1 + dp)
                s_[q] = slice(dq, F.shape[q] - 1 + dq)
                return tuple(s_)
            a, b = inside[sl(0, 0)], inside[sl(1, 0)]
            c, d = inside[sl(0, 1)], inside[sl(1, 1)]
            k1 = a & d & ~b & ~c
            k2 = b & c & ~a & ~d
            if not (k1.any() or k2.any()):
                continue
            pick_b = F[sl(1, 0)] >= F[sl(0, 1)]
            pick_a = F[sl(0, 0)] >= F[sl(1, 1)]
            fill[sl(1, 0)] |= k1 & pick_b
            fill[sl(0, 1)] |= k1 & ~pick_b
            fill[sl(0, 0)] |= k2 & pick_a
            fill[sl(1, 1)] |= k2 & ~pick_a
        cnt = np.zeros(tuple(n - 1 for n in F.shape), np.int8)
        for o in corners:
            cnt += inside[cs(o)]
        for o in corners[:4]:
            opp = tuple(1 - v for v in o)
            k = (cnt == 2) & inside[cs(o)] & inside[cs(opp)]
            if k.any():
                fill[cs((1 - o[0], o[1], o[2]))] |= k
            k = (cnt == 6) & ~inside[cs(o)] & ~inside[cs(opp)]
            if k.any():
                fill[cs(o)] |= k
        fill &= ~inside
        n = int(fill.sum())
        if n == 0:
            break
        F[fill] = up
        total += n
    return F, total


def count_active(F, iso):
    """Number of cubes the surface crosses (= surface nets vertices; about
    half the triangles)."""
    inside = F > iso
    nx, ny, nz = F.shape
    any_in = np.zeros((nx - 1, ny - 1, nz - 1), bool)
    all_in = np.ones((nx - 1, ny - 1, nz - 1), bool)
    for i in (0, 1):
        for j in (0, 1):
            for k in (0, 1):
                s_ = inside[i:nx - 1 + i, j:ny - 1 + j, k:nz - 1 + k]
                any_in |= s_
                all_in &= s_
    return int((any_in & ~all_in).sum())



# --------------------------------------------------------------------------
# Error
# --------------------------------------------------------------------------

def _point_tri_dist2(p, a, b, c):
    """Squared distance from points p to triangles (a, b, c), row by row
    (Ericson, Real-Time Collision Detection 5.1.5)."""
    ab, ac, ap = b - a, c - a, p - a
    d1 = np.einsum('ij,ij->i', ab, ap)
    d2 = np.einsum('ij,ij->i', ac, ap)
    bp = p - b
    d3 = np.einsum('ij,ij->i', ab, bp)
    d4 = np.einsum('ij,ij->i', ac, bp)
    cp = p - c
    d5 = np.einsum('ij,ij->i', ab, cp)
    d6 = np.einsum('ij,ij->i', ac, cp)
    va = d3 * d6 - d5 * d4
    vb = d5 * d2 - d1 * d6
    vc = d1 * d4 - d3 * d2
    out = np.empty(len(p))
    done = np.zeros(len(p), bool)

    def put(m, q):
        nonlocal done
        m = m & ~done
        if m.any():
            dd = p[m] - q[m]
            out[m] = np.einsum('ij,ij->i', dd, dd)
            done |= m
    eps = 1e-300
    put((d1 <= 0) & (d2 <= 0), a)
    put((d3 >= 0) & (d4 <= d3), b)
    put((d6 >= 0) & (d5 <= d6), c)
    m = (vc <= 0) & (d1 >= 0) & (d3 <= 0)
    v = d1 / np.where(np.abs(d1 - d3) > eps, d1 - d3, eps)
    put(m, a + v[:, None] * ab)
    m = (vb <= 0) & (d2 >= 0) & (d6 <= 0)
    w = d2 / np.where(np.abs(d2 - d6) > eps, d2 - d6, eps)
    put(m, a + w[:, None] * ac)
    m = (va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0)
    den = (d4 - d3) + (d5 - d6)
    w2 = (d4 - d3) / np.where(np.abs(den) > eps, den, eps)
    put(m, b + w2[:, None] * (c - b))
    den = va + vb + vc
    den = np.where(np.abs(den) > eps, den, eps)
    v = vb / den
    w = vc / den
    put(np.ones(len(p), bool), a + ab * v[:, None] + ac * w[:, None])
    return out


def distance_to_mesh(points, verts, tris, k=16, chunk=200000):
    """Distance from each point to the nearest of the k triangles whose
    centroids are nearest (exact point-triangle distance; close to the true
    distance to the mesh when triangles are not much larger than the gaps
    between them)."""
    from scipy.spatial import cKDTree
    P = np.asarray(points, np.float64)
    Vv = np.asarray(verts, np.float64)
    Tt = np.asarray(tris, np.int64)
    if len(Tt) == 0 or len(P) == 0:
        return np.full(len(P), np.inf)
    cen = Vv[Tt].mean(1)
    tree = cKDTree(cen)
    k = min(k, len(Tt))
    out = np.empty(len(P))
    for s in range(0, len(P), chunk):
        p = P[s:s + chunk]
        _, ii = tree.query(p, k=k)
        ii = ii.reshape(len(p), k)
        pr = np.repeat(p, k, axis=0)
        t = Tt[ii.ravel()]
        d2 = _point_tri_dist2(pr, Vv[t[:, 0]], Vv[t[:, 1]], Vv[t[:, 2]])
        out[s:s + chunk] = np.sqrt(d2.reshape(len(p), k).min(1))
    return out


def sample_surface(verts, tris, n, seed=0):
    """n points spread over the surface by area."""
    rng = np.random.default_rng(seed)
    nn = face_normals(verts, tris)
    a = np.linalg.norm(nn, axis=1)
    if a.sum() <= 0:
        return verts[tris[:, 0]][:n]
    f = rng.choice(len(tris), size=n, p=a / a.sum())
    u, v = rng.random(n), rng.random(n)
    flip = u + v > 1
    u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    p0, p1, p2 = verts[tris[f, 0]], verts[tris[f, 1]], verts[tris[f, 2]]
    return p0 + u[:, None] * (p1 - p0) + v[:, None] * (p2 - p0)


def mesh_error(verts0, tris0, verts1, tris1, n=100000, seed=0):
    """Two-sided surface distance (sampled): original -> simplified and back.
    Returns mean, p90, p99, max (m) of the larger side at each statistic,
    plus each side's mean."""
    s0 = sample_surface(np.asarray(verts0, float), np.asarray(tris0), n, seed)
    s1 = sample_surface(np.asarray(verts1, float), np.asarray(tris1), n, seed + 1)
    d01 = distance_to_mesh(s0, verts1, tris1)
    d10 = distance_to_mesh(s1, verts0, tris0)
    st = {}
    for name, f in (("mean", np.mean), ("p90", lambda x: np.percentile(x, 90)),
                    ("p99", lambda x: np.percentile(x, 99)), ("max", np.max)):
        st[name] = float(max(f(d01), f(d10)))
    st["mean_fwd"] = float(d01.mean())
    st["mean_back"] = float(d10.mean())
    return st
