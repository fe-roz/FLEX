"""
tex_tiles.py -- texture tiling for large exports (doc 05, doc 10 A5).

One texture caps the detail of a big export: its long side over 16384 px. Past
about 5 km the terrain is therefore split into a grid of equal tiles, each with
its own satellite and hillshade texture, so every tile gets the full texture
size. The tiles are sidecar files in the export:

    tex_sat_<col>_<row>.jpg      row 0 = north, col 0 = west
    tex_hs_<col>_<row>.jpg       (when the export has a hillshade)

and caves.json meta says so:  "texture_tiles": {"cols": C, "rows": R,
"sat": true, "hs": true}. The single tex_sat.jpg / tex_hs.jpg stay in the
export as the overview (and for a viewer that predates tiles). The viewer
splits the terrain mesh along the tile edges and gives each piece its tile.

Standard library only apart from what the callers pass in.
"""
import re

TILE_ABOVE_M = 5000.0      # tile an export whose long side is longer than this
TILE_TARGET_M = 5000.0     # ... into tiles about this long
TILE_MAX_SIDE = 4          # at most this many tiles along a side
TILE_RE = re.compile(r'^tex_(sat|hs)_(\d+)_(\d+)\.jpg$')


def plan_tiles(width_m, height_m, above_m=TILE_ABOVE_M, target_m=TILE_TARGET_M, max_side=TILE_MAX_SIDE):
    """(cols, rows) for an export of this size; (1, 1) = no tiling."""
    if max(width_m, height_m) <= above_m:
        return 1, 1
    cols = max(1, min(max_side, int(-(-width_m // target_m))))
    rows = max(1, min(max_side, int(-(-height_m // target_m))))
    return cols, rows


def tile_name(kind, col, row):
    return f'tex_{kind}_{col}_{row}.jpg'


def sub_extent(e0, n0, e1, n1, col, row, cols, rows):
    """UTM rectangle (e0, n0, e1, n1) of tile (col, row); row 0 is the north row."""
    w, h = (e1 - e0) / cols, (n1 - n0) / rows
    return (e0 + col * w, n1 - (row + 1) * h, e0 + (col + 1) * w, n1 - row * h)


def meta_entry(cols, rows, sat=True, hs=False):
    return {'cols': int(cols), 'rows': int(rows), 'sat': bool(sat), 'hs': bool(hs)}


def make_tiles(grid, cols, rows, mk_grid, sat_fn, hs_fn=None, blank_fn=None, hs_overview=None,
               progress=print, sat_quality=85, hs_quality=90):
    """Build every tile's textures and return ({file name: JPEG bytes}, has_hs).

    grid        the whole export's UtmGrid (e0, n0, e1, n1)
    mk_grid     (e0, n0, e1, n1) -> a UtmGrid for one tile, same zone
    sat_fn      (tile grid) -> PIL RGB image of the satellite for that tile
    hs_fn       (tile grid, fraction of the whole area) -> PIL image, or None for
                no hillshade; may raise, then the overview is cropped instead
    blank_fn    (image, tile grid) -> None, blanks outside the export polygon
    hs_overview PIL image of the whole hillshade, to crop when hs_fn cannot
    """
    import io
    out, has_hs = {}, hs_fn is not None or hs_overview is not None

    def jpeg(img, q):
        b = io.BytesIO()
        img.save(b, format='JPEG', quality=q)
        return b.getvalue()

    for r in range(rows):
        for c in range(cols):
            g = mk_grid(*sub_extent(grid.e0, grid.n0, grid.e1, grid.n1, c, r, cols, rows))
            frac = (g.width * g.height) / max(1e-9, grid.width * grid.height)
            progress(f'  Tile {c + 1},{r + 1} of {cols},{rows}: satellite')
            sat = sat_fn(g)
            if blank_fn:
                blank_fn(sat, g)
            out[tile_name('sat', c, r)] = jpeg(sat, sat_quality)
            del sat
            if not has_hs:
                continue
            img = None
            if hs_fn is not None:
                try:
                    progress(f'  Tile {c + 1},{r + 1} of {cols},{rows}: hillshade')
                    img = hs_fn(g, frac)
                except Exception as e:
                    progress(f'  WARNING: tile hillshade failed ({e}); cropping the overview')
            if img is None and hs_overview is not None:
                W, H = hs_overview.size
                img = hs_overview.crop((round(c * W / cols), round(r * H / rows),
                                        round((c + 1) * W / cols), round((r + 1) * H / rows)))
            if img is None:
                has_hs = False
                for k in [k for k in out if k.startswith('tex_hs_')]:
                    del out[k]
                continue
            if blank_fn:
                blank_fn(img, g)
            out[tile_name('hs', c, r)] = jpeg(img, hs_quality)
    return out, has_hs
