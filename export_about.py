#!/usr/bin/env python3
"""
What the "About this map" card on the phone says (viewer_build/libs/about-map.js): written by the exporter into
caves.json meta `about`. Only facts the exporter has in hand; the viewer adds what it can count itself (caves,
stations) and shows an older export, which has no `about`, from what its meta says. Standard library only.
"""
import os
import time
from pathlib import Path


def flex_commit(root):
    """The commit FLEX was at, read from the checkout's files (no git program needed): 12 hex digits, or '' when
    this is not a checkout. Handles a worktree (.git is a file naming the real folder) and packed refs."""
    try:
        g = Path(root) / '.git'
        if g.is_file():
            g = Path(g.read_text().split('gitdir:', 1)[1].strip())
        head = (g / 'HEAD').read_text().strip()
        if not head.startswith('ref:'):
            return head[:12] if all(c in '0123456789abcdef' for c in head[:12]) and len(head) >= 12 else ''
        ref = head.split(':', 1)[1].strip()
        common = g
        if (g / 'commondir').exists():
            common = (g / (g / 'commondir').read_text().strip()).resolve()
        for base in (g, common):
            f = base / ref
            if f.exists():
                return f.read_text().strip()[:12]
        packed = common / 'packed-refs'
        if packed.exists():
            for line in packed.read_text().splitlines():
                if line.endswith(' ' + ref):
                    return line.split(' ', 1)[0][:12]
    except Exception:
        pass
    return ''


def dataset_name(ept):
    """A point cloud's name as far as its link tells: the folder its ept.json sits in. Never the link itself."""
    s = str(ept or '').replace('\\', '/').split('?', 1)[0].rstrip('/')
    if s.lower().endswith('.json') or s.lower().endswith('.copc.laz') or s.lower().endswith('.laz'):
        base = s.rsplit('/', 1)
        name = base[-1]
        if name.lower() in ('ept.json',) and len(base) == 2:
            name = base[0].rsplit('/', 1)[-1]
        else:
            name = name.rsplit('.', 2)[0] if name.lower().endswith('.copc.laz') else name.rsplit('.', 1)[0]
    else:
        name = s.rsplit('/', 1)[-1]
    name = name.replace('\\', '/').rsplit('/', 1)[-1]
    return name[:80]


def about(root, width_m, height_m, area_m2, polygon, terrain, cell_m, lidar=(), layers=None, ridge_meta=None,
          ridge_shapes=None, brush_opacity=None, slope_opacity=None, trees=None, features=None, marks=None, docs=None, now=None):
    """The dict for caves.json meta `about`. Everything optional is left out when there is nothing to say."""
    if now is None and os.environ.get('SOURCE_DATE_EPOCH', '').isdigit():      # a fixed clock, for builds that must repeat (the tests)
        now = int(os.environ['SOURCE_DATE_EPOCH'])
    t = time.gmtime(now if now is not None else time.time())
    out = {'v': 1, 'exported': time.strftime('%Y-%m-%dT%H:%M:%SZ', t),
           'area_km2': round(float(area_m2) / 1e6, 4), 'size_m': [round(float(width_m)), round(float(height_m))], 'polygon': bool(polygon),
           'terrain': terrain, 'cell_m': round(float(cell_m), 3)}
    commit = flex_commit(root)
    if commit:
        out['flex'] = {'commit': commit}
    names = [n for n in (dataset_name(e) for e in lidar or () if e) if n]
    if names:
        out['lidar'] = names
    if layers:
        out['layers'] = layers
    if ridge_meta:
        c = ridge_meta.get('counts') or {}
        passes = ridge_meta.get('passes') or []
        p = ridge_meta.get('params') or {}
        out['ridge'] = {'counts': {k: int(c[k]) for k in ('features', 'true_cells', 'guessed_cells', 'below', 'groups', 'lone', 'likely_noise', 'pattern_noise', 'returns') if isinstance(c.get(k), (int, float))},
                        'passes': len(passes), 'flagged': [str(x.get('id')) for x in passes if isinstance(x, dict) and x.get('flagged')][:40],
                        'params': {k: p[k] for k in ('min_behind', 'max_link', 'link', 'cell') if isinstance(p.get(k), (int, float))},
                        **({'shapes': bool(ridge_shapes)} if ridge_shapes is not None else {})}
    if brush_opacity is not None:
        out['brush'] = {'opacity': float(brush_opacity)}
    if slope_opacity is not None:
        out['slope'] = {'opacity': float(slope_opacity)}
    if trees:
        out['trees'] = trees
    if features:
        out['features'] = features
    if marks:
        out['marks'] = int(marks)
    if docs:
        out['docs'] = docs
    return out
