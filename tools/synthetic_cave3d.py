"""
A made-up multi-level cave for looking at the viewer's 3D drawing (see-through
walls, focus mode): four galleries stacked over each other, a shaft that joins
two of them, smooth elliptical walls like FLEX's Smooth mode draws them. Every
number is synthetic. Used by tools/make_synthetic_export.py --cave3d and by the
kit's test_viewer_3d.

    stations(ground)  -> [(survey name, colour, [(station, x, y, depth, l, r, u, d)])]
    tube(rows, ...)   -> (positions, indices) of one gallery's wall, outward-facing triangles
"""
import math

FT = 0.3048

# name, colour, rows of (station, x, y, depth below ground (m), L, R, U, D (m))
LEVELS = [
    ('Upper gallery', '#ff4081', [
        ('U1', -35, -15, 9, 2.0, 2.0, 1.8, 1.0), ('U2', -12, -4, 10, 2.5, 2.5, 2.2, 1.2),
        ('U3', 8, 6, 11, 3.0, 3.0, 2.5, 1.5), ('U4', 24, 12, 11.5, 2.5, 2.5, 2.2, 1.2),
        ('U5', 40, 22, 12, 2.0, 2.0, 2.0, 1.0), ('U6', 60, 35, 12, 2.0, 2.0, 1.8, 1.0)]),
    ('Main gallery', '#00e5ff', [
        ('M1', -40, 20, 20, 2.0, 2.0, 2.0, 1.0), ('M2', -22, 22, 20.5, 2.5, 2.5, 2.5, 1.2),
        ('M3', -4, 18, 21, 3.0, 3.0, 3.0, 1.5), ('M4', 24, 13, 21, 4.0, 4.0, 4.0, 2.0),
        ('M5', 44, 10, 21.5, 3.5, 3.5, 3.5, 2.0), ('M6', 66, 14, 22, 2.5, 2.5, 2.5, 1.5),
        ('M7', 90, 26, 23, 2.0, 2.0, 2.0, 1.2)]),
    ('Parallel gallery', '#69f0ae', [
        ('P1', -15, 34, 19, 1.8, 1.8, 1.8, 1.0), ('P2', 6, 30, 19.5, 2.2, 2.2, 2.2, 1.2),
        ('P3', 30, 26, 20, 2.5, 2.5, 2.5, 1.4), ('P4', 54, 28, 20, 2.0, 2.0, 2.0, 1.2),
        ('P5', 80, 34, 21, 1.8, 1.8, 1.8, 1.0)]),
    ('Lower crawl', '#ffab40', [
        ('L1', -25, 4, 31, 1.5, 1.5, 1.0, 0.8), ('L2', -2, 8, 31.5, 1.8, 1.8, 1.2, 1.0),
        ('L3', 22, 4, 32, 2.0, 2.0, 1.5, 1.0), ('L4', 48, 0, 32, 1.6, 1.6, 1.2, 0.9),
        ('L5', 72, 6, 33, 1.5, 1.5, 1.0, 0.8)]),
    ('Shaft', '#b388ff', [
        ('U4', 24, 12, 11.5, 1.8, 1.8, 1.8, 1.8), ('S1', 24, 12.4, 16, 2.2, 2.2, 1.5, 1.5),
        ('M4', 24, 13, 21, 2.0, 2.0, 1.8, 1.8)]),
]


def stations(ground):
    """[(survey name, colour, [(station name, [x, y, z], [l, r, u, d])])] with z from the ground function."""
    out = []
    for name, colour, rows in LEVELS:
        pts = []
        for st, x, y, dep, l, r, u, d in rows:
            pts.append((st, [float(x), float(y), ground(x, y) - dep], [l, r, u, d]))
        out.append((name, colour, pts))
    return out


def _unit(v):
    n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) or 1.0
    return (v[0] / n, v[1] / n, v[2] / n)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def tube(pts, sides=16):
    """Smooth elliptical tube through the stations: pts = [(name, [x,y,z], [l,r,u,d])].
    Returns (positions [x,y,z,...], indices) - triangles wound so the outside is the front face."""
    pos, idx = [], []
    n = len(pts)
    rings = []
    for i, (_, p, lr) in enumerate(pts):
        a = pts[max(0, i - 1)][1]
        b = pts[min(n - 1, i + 1)][1]
        t = _unit((b[0] - a[0], b[1] - a[1], b[2] - a[2]))
        side = _cross(t, (0.0, 0.0, 1.0))
        if abs(side[0]) + abs(side[1]) < 1e-3:       # vertical: any horizontal axis will do
            side = (1.0, 0.0, 0.0)
        side = _unit(side)
        up = _unit(_cross(side, t))
        l, r, u, d = lr
        ring = []
        for k in range(sides):
            th = 2 * math.pi * k / sides
            c, s = math.cos(th), math.sin(th)
            w = (r if c >= 0 else l) * c
            h = (u if s >= 0 else d) * s
            ring.append([p[0] + side[0] * w + up[0] * h, p[1] + side[1] * w + up[1] * h, p[2] + side[2] * w + up[2] * h])
        rings.append((ring, t, p))
    for ring, _, _ in rings:
        for v in ring:
            pos += [round(c, 3) for c in v]
    for i in range(n - 1):
        a0, b0 = i * sides, (i + 1) * sides
        for k in range(sides):
            k2 = (k + 1) % sides
            idx += [a0 + k, b0 + k, a0 + k2, a0 + k2, b0 + k, b0 + k2]
    for end, flip in ((0, False), (n - 1, True)):          # close both ends with a fan
        ring, t, p = rings[end]
        c = len(pos) // 3
        # push the centre a little outward along the passage so the cap is a shallow dome
        sgn = -1.0 if end == 0 else 1.0
        pos += [round(p[0] + sgn * t[0] * 0.6, 3), round(p[1] + sgn * t[1] * 0.6, 3), round(p[2] + sgn * t[2] * 0.6, 3)]
        base = end * sides
        for k in range(sides):
            k2 = (k + 1) % sides
            idx += [c, base + k, base + k2] if end == 0 else [c, base + k2, base + k]
    return pos, idx


def caves_data(ground):
    """The cave as caves.json's {surveys, labels, passages} (passages = walls, one group per gallery)."""
    surveys, passages = [], []
    for name, colour, pts in stations(ground):
        lines, shots, sts = [], [], []
        for (n1, a, _), (n2, b, _) in zip(pts, pts[1:]):
            lines.append([a, b])
            dx, dy, dz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
            L = math.sqrt(dx * dx + dy * dy + dz * dz)
            shots.append({'from_xyz': a, 'to_xyz': b, 'from_name': n1, 'to_name': n2, 'length': round(L, 2),
                          'azimuth': round(math.degrees(math.atan2(dx, dy)) % 360, 1),
                          'inclination': round(math.degrees(math.atan2(dz, math.hypot(dx, dy))), 1)})
        for n, p, lr in pts:
            sts.append({'name': n, 'xyz': p, 'lrud': [round(v, 3) for v in lr]})
        surveys.append({'name': name, 'cave': 'Cave Ridge', 'color': colour, 'lines': lines, 'shots': shots, 'stations': sts})
        pos, idx = tube(pts)
        passages.append({'color': colour, 'opacity': 0.55, 'positions': pos, 'indices': idx})
    return {'surveys': surveys, 'labels': [{'text': 'Big Room', 'xyz': [24, 13, ground(24, 13) - 18]}], 'passages': passages}
