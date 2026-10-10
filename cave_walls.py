"""
Binary sidecar for cave passage walls (walls.bin).

The walls FLEX draws from survey LRUDs can run to a million triangles. As JSON
inside caves.json that is ~35 MB the WebView must parse before anything draws;
as raw typed arrays it is a third of that and loads with no parsing at all —
the viewer wraps the bytes in Float32Array / Uint16Array / Uint32Array views.

Layout: little-endian blocks, each starting on a 4-byte boundary, described by
a small JSON descriptor that travels in caves.json under "walls":

    {"file": "walls.bin", "bytes": N, "groups": [
        {"color": "#rrggbb", "opacity": 0.55,
         "vcount": V, "pos_offset": o1,            # V*3 uint16, quantised x,y,z
         "origin": [x0, y0, z0], "step": [sx, sy, sz],  # x = x0 + q * sx, etc.
         "icount": I, "idx_offset": o2, "ibytes": 2|4}   # I uint16/uint32
    ]}

Positions are scene XYZ (metres from the export centre), quantised to 16 bits
per axis over each group's own bounding box: step = span / 65535, so a group
2 km across lands on a 3 cm grid and anything under 6.5 km stays inside 10 cm
— far below what LRUDs measure. Half the bytes of float32. Indices are 16-bit
wherever a group has fewer than 65 536 vertices.

Shared by export_terrain.py (new exports) and android/tools/assemble_assets.py
(which converts exports made while walls still travelled as JSON).
"""
import struct


def _align4(buf):
    pad = (-len(buf)) % 4
    if pad:
        buf.extend(b'\0' * pad)


def pack_walls(passages, file_name='walls.bin'):
    """passages: [{"color", "opacity", "positions": [x,y,z,...], "indices": [...]}]
    Returns (bytes, descriptor) — descriptor is None when there is nothing to pack."""
    buf = bytearray()
    groups = []
    for pg in passages or []:
        pos = pg.get('positions') or []
        idx = pg.get('indices') or []
        vcount = len(pos) // 3
        icount = (len(idx) // 3) * 3
        if vcount < 3 or icount < 3:
            continue
        _align4(buf)
        pos_offset = len(buf)
        origin, step = [], []
        for ax in range(3):
            vals = pos[ax: vcount * 3: 3]
            lo, hi = min(vals), max(vals)
            origin.append(lo)
            step.append(max((hi - lo) / 65535.0, 1e-6))
        q = [0] * (vcount * 3)
        for i in range(vcount * 3):
            ax = i % 3
            q[i] = min(65535, max(0, int(round((pos[i] - origin[ax]) / step[ax]))))
        buf.extend(struct.pack('<%dH' % len(q), *q))
        _align4(buf)
        idx_offset = len(buf)
        ibytes = 2 if vcount < 65536 else 4
        buf.extend(struct.pack('<%d%s' % (icount, 'H' if ibytes == 2 else 'I'),
                               *[int(k) for k in idx[:icount]]))
        groups.append({
            'color': pg.get('color', '#00e5ff'),
            'opacity': float(pg.get('opacity', 0.55)),
            'vcount': vcount, 'pos_offset': pos_offset,
            'origin': [round(v, 4) for v in origin], 'step': step,
            'icount': icount, 'idx_offset': idx_offset, 'ibytes': ibytes,
        })
    if not groups:
        return b'', None
    _align4(buf)
    return bytes(buf), {'file': file_name, 'bytes': len(buf), 'groups': groups}


def unpack_walls(data, desc):
    """Inverse of pack_walls, for tests: returns the passages list."""
    out = []
    for g in desc['groups']:
        q = struct.unpack_from('<%dH' % (g['vcount'] * 3), data, g['pos_offset'])
        o, st = g['origin'], g['step']
        pos = [o[i % 3] + q[i] * st[i % 3] for i in range(len(q))]
        idx = list(struct.unpack_from('<%d%s' % (g['icount'], 'H' if g['ibytes'] == 2 else 'I'),
                                      data, g['idx_offset']))
        out.append({'color': g['color'], 'opacity': g['opacity'], 'positions': pos, 'indices': idx})
    return out
