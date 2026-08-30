#!/usr/bin/env python3
"""
export_terrain.py  —  FLEX terrain + cave export pipeline

Usage:
  python export_terrain.py --ept <path/to/ept.json> \
                           --bbox <minLon> <minLat> <maxLon> <maxLat> \
                           --caves <path/to/caves.json> \
                           --out <output.zip> \
                           [--resolution 0.5] [--percentile 2] [--max-triangles 2000000]
"""

import argparse, json, math, os, struct, sys, tempfile, zipfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
VIEWER_BUILD_DIR = SCRIPT_DIR / 'viewer_build'

# Three.js r158 — fetched once and cached in viewer_build/libs/
VIEWER_LIBS = {
    'libs/three.min.js':
        'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js',
    'libs/OrbitControls.js':
        'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js',
    'libs/GLTFLoader.js':
        'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js',
    'libs/jszip.min.js':
        'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
}

import numpy as np
from scipy.interpolate import NearestNDInterpolator
from scipy.stats import binned_statistic_2d
import requests
from PIL import Image
import pygltflib

# ──────────────────────────────────────────────────────────────────────────────
# Coordinate helpers
# ──────────────────────────────────────────────────────────────────────────────

def latlon_to_utm(lat, lon):
    """Approximate WGS84 → UTM (returns easting, northing, zone)."""
    zone = int((lon + 180) / 6) + 1
    lon_rad = math.radians(lon)
    lat_rad = math.radians(lat)
    lon0 = math.radians((zone - 1) * 6 - 180 + 3)
    a, f = 6378137.0, 1 / 298.257223563
    b = a * (1 - f)
    e2 = 1 - (b / a) ** 2
    e = math.sqrt(e2)
    N = a / math.sqrt(1 - e2 * math.sin(lat_rad) ** 2)
    T = math.tan(lat_rad) ** 2
    C = e2 / (1 - e2) * math.cos(lat_rad) ** 2
    A = math.cos(lat_rad) * (lon_rad - lon0)
    M = a * ((1 - e2/4 - 3*e2**2/64 - 5*e2**3/256) * lat_rad
             - (3*e2/8 + 3*e2**2/32 + 45*e2**3/1024) * math.sin(2*lat_rad)
             + (15*e2**2/256 + 45*e2**3/1024) * math.sin(4*lat_rad)
             - (35*e2**3/3072) * math.sin(6*lat_rad))
    k0 = 0.9996
    easting  = k0 * N * (A + (1-T+C)*A**3/6 + (5-18*T+T**2+72*C-58*e2/(1-e2))*A**5/120) + 500000
    northing = k0 * (M + N*math.tan(lat_rad)*(A**2/2 + (5-T+9*C+4*C**2)*A**4/24
                     + (61-58*T+T**2+600*C-330*e2/(1-e2))*A**6/720))
    if lat < 0:
        northing += 10_000_000
    return easting, northing, zone

# ──────────────────────────────────────────────────────────────────────────────
# Step 1 — Read points from EPT
# ──────────────────────────────────────────────────────────────────────────────

def fetch_ept_points(ept_path, utm_bbox, progress=print):
    """Read all points from an EPT dataset within a UTM bounding box."""
    try:
        import pdal
    except ImportError:
        sys.exit("ERROR: pdal not installed. Run: conda install -c conda-forge python-pdal")

    minE, minN, maxE, maxN = utm_bbox
    pipeline_json = json.dumps({
        "pipeline": [
            {
                "type": "readers.ept",
                "filename": str(ept_path),
                "bounds": f"([{minE},{maxE}],[{minN},{maxN}])"
            }
        ]
    })
    progress("  Fetching EPT points...")
    p = pdal.Pipeline(pipeline_json)
    p.execute()
    arrays = p.arrays
    if not arrays:
        sys.exit("ERROR: No points returned from EPT for this bbox")
    arr = arrays[0]
    x = arr['X'].astype(np.float64)
    y = arr['Y'].astype(np.float64)
    z = arr['Z'].astype(np.float64)
    # Try to get RGB if available
    try:
        r = (arr['Red']   / 256).astype(np.uint8)
        g = (arr['Green'] / 256).astype(np.uint8)
        b = (arr['Blue']  / 256).astype(np.uint8)
    except Exception:
        r = g = b = np.full(len(x), 180, dtype=np.uint8)
    progress(f"  Fetched {len(x):,} points")
    return x, y, z, r, g, b

# ──────────────────────────────────────────────────────────────────────────────
# Step 2 — Minimum-surface DEM (2nd percentile per cell)
# ──────────────────────────────────────────────────────────────────────────────

def build_dem(x, y, z, resolution, csf_iterations=80, progress=print):
    """
    Build a ground DEM using cloth-simulation-from-below (CSF).

    The cloth is initialised at the minimum-Z per cell (the lowest lidar return),
    then Laplacian smoothing is applied iteratively with collision constraints:
      - Ground cells: anchored at their actual minimum Z (collision keeps cloth ≤ min_z).
      - Tree/canopy cells: no ground return → cloth is pulled DOWN to neighbour level
        by Laplacian tension. They never affect the cloth's final position.
      - Cave/depression cells: min_z is genuinely low → cloth correctly dips there.

    This is equivalent to the Zhang et al. (2016) CSF algorithm but operating
    on the original (non-inverted) cloud, rising from below.
    """
    progress(f"  Building CSF cloth DEM at {resolution}m resolution...")
    x_min, x_max = x.min(), x.max()
    y_min, y_max = y.min(), y.max()
    x_bins = np.arange(x_min, x_max + resolution, resolution)
    y_bins = np.arange(y_min, y_max + resolution, resolution)

    # ── Minimum Z per cell (lowest hit = first contact from below) ────────────
    min_z, _, _, _ = binned_statistic_2d(x, y, z, statistic='min', bins=[x_bins, y_bins])

    # Fill empty cells (no returns) with nearest-neighbour interpolation
    rows, cols = min_z.shape
    xi, yi = np.meshgrid(np.arange(rows), np.arange(cols), indexing='ij')
    valid = np.isfinite(min_z)
    if not valid.all():
        interp = NearestNDInterpolator(
            list(zip(xi[valid], yi[valid])), min_z[valid]
        )
        min_z[~valid] = interp(xi[~valid], yi[~valid])

    # ── Cloth simulation ──────────────────────────────────────────────────────
    # Initialise cloth at min_z everywhere (already at ground for ground cells,
    # at tree-top for tree-only cells).  Smoothing pulls tree cells down;
    # collision prevents ground cells from being pulled above their real minimum.
    cloth = min_z.copy()
    progress(f"  CSF: {csf_iterations} smoothing iterations over {rows}×{cols} grid...")
    for it in range(csf_iterations):
        # Laplacian smoothing (4-neighbour average with edge padding)
        padded = np.pad(cloth, 1, mode='edge')
        cloth = (padded[:-2, 1:-1] + padded[2:, 1:-1] +
                 padded[1:-1, :-2] + padded[1:-1, 2:]) / 4.0
        # Collision: cloth cannot rise above the actual lowest return in each cell
        cloth = np.minimum(cloth, min_z)

    n_corrected = int((cloth < min_z - 0.05).sum())
    progress(f"  CSF done — {n_corrected:,} tree/canopy cells corrected")
    progress(f"  DEM grid: {rows}×{cols} ({rows*cols:,} cells)")
    return cloth, x_bins, y_bins, x_min, y_min

# ──────────────────────────────────────────────────────────────────────────────
# Step 3 — Build TIN mesh from DEM grid
# ──────────────────────────────────────────────────────────────────────────────

def build_mesh(dem, x_bins, y_bins, x_origin, y_origin, max_triangles=2_000_000, progress=print):
    """Convert DEM grid to a triangle mesh, decimate if needed."""
    progress("  Triangulating DEM...")
    rows, cols = dem.shape
    # Build vertex grid
    xi, yi = np.meshgrid(np.arange(rows), np.arange(cols), indexing='ij')
    vx = (xi.ravel() * (x_bins[1] - x_bins[0])).astype(np.float32)
    vy = (yi.ravel() * (y_bins[1] - y_bins[0])).astype(np.float32)
    vz = dem.ravel().astype(np.float32)
    # Centre on origin
    vx -= vx.mean(); vy -= vy.mean()
    vertices = np.column_stack([vx, vy, vz])
    # Build quads → 2 triangles each
    def idx(r, c): return r * cols + c
    faces = []
    for r in range(rows - 1):
        for c in range(cols - 1):
            a, b, c_, d = idx(r,c), idx(r+1,c), idx(r+1,c+1), idx(r,c+1)
            faces.append([a, b, c_])
            faces.append([a, c_, d])
    faces = np.array(faces, dtype=np.uint32)
    progress(f"  Raw mesh: {len(vertices):,} vertices, {len(faces):,} triangles")
    # Decimate if too large
    if len(faces) > max_triangles:
        try:
            import trimesh
            mesh = trimesh.Trimesh(vertices=vertices, faces=faces)
            ratio = max_triangles / len(faces)
            mesh = mesh.simplify_quadric_decimation(int(len(faces) * ratio))
            vertices = np.array(mesh.vertices, dtype=np.float32)
            faces = np.array(mesh.faces, dtype=np.uint32)
            progress(f"  Decimated: {len(vertices):,} vertices, {len(faces):,} triangles")
        except ImportError:
            progress("  WARNING: trimesh not installed, skipping decimation")
    return vertices, faces

# ──────────────────────────────────────────────────────────────────────────────
# Step 4 — Fetch satellite texture
# ──────────────────────────────────────────────────────────────────────────────

def fetch_satellite_texture(bbox_latlon, size=(2048, 2048), progress=print):
    """Download satellite imagery from ESRI World Imagery for the bbox."""
    minLon, minLat, maxLon, maxLat = bbox_latlon
    progress("  Fetching satellite texture from ESRI World Imagery...")
    url = (
        "https://services.arcgisonline.com/arcgis/rest/services/"
        "World_Imagery/MapServer/export"
        f"?bbox={minLon},{minLat},{maxLon},{maxLat}"
        f"&bboxSR=4326&size={size[0]},{size[1]}&imageSR=4326"
        "&format=jpg&f=image"
    )
    try:
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        img = Image.open(__import__('io').BytesIO(r.content)).convert('RGB')
        progress(f"  Texture downloaded: {img.size[0]}×{img.size[1]} px")
        return img
    except Exception as e:
        progress(f"  WARNING: Could not fetch satellite texture ({e}). Using grey.")
        return Image.new('RGB', size, (160, 160, 160))

# ──────────────────────────────────────────────────────────────────────────────
# Step 5 — Compute UV coordinates
# ──────────────────────────────────────────────────────────────────────────────

def compute_uvs(vertices, dem_shape, x_bins, y_bins):
    """
    Map vertex XY positions to UV texture coordinates [0..1].

    glTF UV convention: V=0 at top (north/maxLat), V=1 at bottom (south/minLat).
    Our Y axis increases northward, so V must be flipped: V = 1 - normalised_Y.
    U is unchanged: U=0 at west, U=1 at east.
    """
    x_range = (x_bins[-1] - x_bins[0])
    y_range = (y_bins[-1] - y_bins[0])
    x_mid = x_range / 2
    y_mid = y_range / 2
    u =       (vertices[:, 0] + x_mid) / x_range
    v = 1.0 - (vertices[:, 1] + y_mid) / y_range   # flip for glTF top-left origin
    return np.column_stack([u, v]).astype(np.float32)

# ──────────────────────────────────────────────────────────────────────────────
# Step 6 — Export GLB
# ──────────────────────────────────────────────────────────────────────────────

def export_glb(vertices, faces, uvs, texture_img, out_path, progress=print):
    """Package vertices + faces + UVs + texture into a GLB.

    The texture is stored as a data: URI in the glTF JSON chunk so THREE.js
    never makes a network / file:// request — works offline in any browser.
    """
    import io as _io, base64 as _b64
    progress("  Packaging GLB...")
    vert_bytes = vertices.astype(np.float32).tobytes()
    face_bytes = faces.astype(np.uint32).tobytes()
    uv_bytes   = uvs.astype(np.float32).tobytes()

    # Encode texture as data URI — lives in the JSON chunk, zero network fetches
    tex_buf = _io.BytesIO()
    texture_img.save(tex_buf, format='JPEG', quality=85)
    tex_data_uri = 'data:image/jpeg;base64,' + _b64.b64encode(tex_buf.getvalue()).decode('ascii')
    progress(f"  Texture data URI: {len(tex_data_uri)//1024} KB")

    def pad4(b): return b + b'\x00' * ((4 - len(b) % 4) % 4)
    vert_off  = 0
    face_off  = len(pad4(vert_bytes))
    uv_off    = face_off + len(pad4(face_bytes))
    total_bin = uv_off   + len(pad4(uv_bytes))
    blob = pad4(vert_bytes) + pad4(face_bytes) + pad4(uv_bytes)

    v_min = vertices.min(axis=0).tolist()
    v_max = vertices.max(axis=0).tolist()

    gltf = pygltflib.GLTF2(
        scene=0,
        scenes=[pygltflib.Scene(nodes=[0])],
        nodes=[pygltflib.Node(mesh=0)],
        meshes=[pygltflib.Mesh(primitives=[pygltflib.Primitive(
            attributes=pygltflib.Attributes(POSITION=0, TEXCOORD_0=2),
            indices=1, material=0
        )])],
        materials=[pygltflib.Material(
            pbrMetallicRoughness=pygltflib.PbrMetallicRoughness(
                baseColorTexture=pygltflib.TextureInfo(index=0),
                metallicFactor=0.0, roughnessFactor=1.0
            ),
            doubleSided=True
        )],
        textures=[pygltflib.Texture(source=0)],
        images=[pygltflib.Image(uri=tex_data_uri)],   # data: URI → no network fetch
        accessors=[
            pygltflib.Accessor(bufferView=0, componentType=pygltflib.FLOAT,
                count=len(vertices), type=pygltflib.VEC3, min=v_min, max=v_max),
            pygltflib.Accessor(bufferView=1, componentType=pygltflib.UNSIGNED_INT,
                count=len(faces)*3, type=pygltflib.SCALAR),
            pygltflib.Accessor(bufferView=2, componentType=pygltflib.FLOAT,
                count=len(uvs), type=pygltflib.VEC2),
        ],
        bufferViews=[
            pygltflib.BufferView(buffer=0, byteOffset=vert_off, byteLength=len(vert_bytes),
                target=pygltflib.ARRAY_BUFFER),
            pygltflib.BufferView(buffer=0, byteOffset=face_off, byteLength=len(face_bytes),
                target=pygltflib.ELEMENT_ARRAY_BUFFER),
            pygltflib.BufferView(buffer=0, byteOffset=uv_off,  byteLength=len(uv_bytes),
                target=pygltflib.ARRAY_BUFFER),
        ],
        buffers=[pygltflib.Buffer(byteLength=total_bin)],
    )
    gltf.set_binary_blob(blob)
    gltf.save_binary(str(out_path))
    size_mb = os.path.getsize(out_path) / 1e6
    progress(f"  GLB saved: {out_path} ({size_mb:.1f} MB)")

# ──────────────────────────────────────────────────────────────────────────────
# Step 7 — Download / cache Three.js viewer libs
# ──────────────────────────────────────────────────────────────────────────────

def get_viewer_libs(progress=print):
    """Download Three.js libs to viewer_build/libs/ (cached; re-downloaded only if missing)."""
    libs_dir = VIEWER_BUILD_DIR / 'libs'
    libs_dir.mkdir(parents=True, exist_ok=True)
    result = {}
    for zip_path, url in VIEWER_LIBS.items():
        fname = Path(zip_path).name
        local = libs_dir / fname
        if not local.exists() or local.stat().st_size < 1000:
            progress(f"  Downloading {fname}...")
            try:
                r = requests.get(url, timeout=60)
                r.raise_for_status()
                local.write_bytes(r.content)
                progress(f"  Cached {fname} ({len(r.content)//1024} KB)")
            except Exception as e:
                progress(f"  WARNING: Could not download {fname}: {e}")
                local = None
        else:
            progress(f"  {fname}: cached ({local.stat().st_size//1024} KB)")
        result[zip_path] = local
    return result


def build_inline_viewer(glb_path, caves_data, viewer_libs, progress=print):
    """
    Build a fully self-contained HTML file:
      - Three.js libs inlined as <script> blocks
      - terrain.glb embedded as base64 in a JS variable
      - caves_data embedded as a JSON literal

    The result opens directly in any mobile browser with no server needed.
    """
    import base64

    viewer_html_path = VIEWER_BUILD_DIR / 'viewer.html'
    if not viewer_html_path.exists():
        progress("  WARNING: viewer.html not found in viewer_build/")
        return '<p>viewer.html missing. Run export from FLEX directory.</p>'

    html = viewer_html_path.read_text(encoding='utf-8')

    # 1. Inline Three.js lib <script src=...> tags
    for zip_path, local in viewer_libs.items():
        fname = Path(zip_path).name
        src_tag = f'<script src="libs/{fname}"></script>'
        if src_tag not in html:
            continue
        if local and local.exists():
            js = local.read_text(encoding='utf-8', errors='replace')
            html = html.replace(src_tag, f'<script>\n{js}\n</script>')
            progress(f"  Inlined {fname} ({len(js)//1024} KB)")
        else:
            progress(f"  WARNING: {fname} not available — viewer may not work offline")

    # 2. Embed terrain.glb as base64
    progress(f"  Encoding terrain.glb as base64...")
    glb_bytes = Path(glb_path).read_bytes()
    glb_b64   = base64.b64encode(glb_bytes).decode('ascii')
    progress(f"  GLB base64: {len(glb_b64)//1024} KB")
    html = html.replace('"PLACEHOLDER_GLB_B64"', f'"{glb_b64}"')

    # 3. Embed caves data as JSON literal
    caves_json = json.dumps(caves_data, separators=(',', ':'))
    html = html.replace('PLACEHOLDER_CAVES_JSON', caves_json)

    progress(f"  Viewer HTML total: {len(html)//1024} KB")
    return html


# ──────────────────────────────────────────────────────────────────────────────
# Cave coordinate conversion
# ──────────────────────────────────────────────────────────────────────────────

def convert_caves(caves_path, utm_center_e, utm_center_n, progress=print):
    """
    Convert caves.json (lon/lat/alt from FLEX) to terrain-centred XYZ.

    Input format (from FLEX export button):
        {
          "surveys": [
            { "name": "...", "color": "#00e5ff",
              "shots": [ {"from":[lon,lat,alt], "to":[lon,lat,alt]}, ... ]
            }
          ]
        }

    Output format (viewer expects):
        {
          "surveys": [
            { "name": "...", "color": "#00e5ff",
              "lines": [ [[x1,y1,z1],[x2,y2,z2]], ... ]
            }
          ]
        }

    XYZ is centred on utm_center_e / utm_center_n. Z is WGS84 altitude (m).
    """
    with open(caves_path, encoding='utf-8') as f:
        raw = json.load(f)

    out = {"surveys": []}
    for survey in raw.get("surveys", []):
        lines = []
        shots_out = []
        for shot in survey.get("shots", []):
            from_coord = shot.get("from", [])
            to_coord   = shot.get("to",   [])
            if len(from_coord) < 3 or len(to_coord) < 3:
                continue
            lon1, lat1, alt1 = from_coord[:3]
            lon2, lat2, alt2 = to_coord[:3]
            e1, n1, _ = latlon_to_utm(lat1, lon1)
            e2, n2, _ = latlon_to_utm(lat2, lon2)
            from_xyz = [e1 - utm_center_e, n1 - utm_center_n, alt1]
            to_xyz   = [e2 - utm_center_e, n2 - utm_center_n, alt2]
            lines.append([from_xyz, to_xyz])
            # Preserve all extra metadata FLEX may include (names, LRUD, length…)
            shot_entry = {"from_xyz": from_xyz, "to_xyz": to_xyz}
            for key in ("from_name", "to_name", "length", "azimuth",
                        "inclination", "lrud", "compass", "clino"):
                if key in shot:
                    shot_entry[key] = shot[key]
            shots_out.append(shot_entry)
        # Convert stations (name, lon/lat/elev → scene XYZ, plus lrud/dist)
        stations_out = []
        for st in survey.get("stations", []):
            slon, slat, selev = st.get("lon", 0), st.get("lat", 0), st.get("elev", 0)
            se, sn, _ = latlon_to_utm(slat, slon)
            entry = {
                "name": st.get("name", ""),
                "xyz":  [se - utm_center_e, sn - utm_center_n, selev],
            }
            if st.get("lrud") is not None:
                entry["lrud"] = st["lrud"]
            if st.get("dist") is not None:
                entry["dist"] = st["dist"]
            stations_out.append(entry)

        out["surveys"].append({
            "name":     survey.get("name",  "Survey"),
            "color":    survey.get("color", "#00e5ff"),
            "lines":    lines,
            "shots":    shots_out,
            "stations": stations_out,
        })
    progress(f"  Converted {sum(len(s['lines']) for s in out['surveys']):,} shots across "
             f"{len(out['surveys'])} surveys")
    return out


# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ept',         required=True, help='Path to ept.json')
    ap.add_argument('--bbox',        required=True, nargs=4, type=float,
                    metavar=('minLon','minLat','maxLon','maxLat'))
    ap.add_argument('--caves',       default=None,  help='Path to caves.json (PLT lines)')
    ap.add_argument('--out',         default='export.zip')
    ap.add_argument('--resolution',  type=float, default=0.5, help='DEM cell size in metres')
    ap.add_argument('--percentile',  type=float, default=2,   help='Ground percentile (2=very low)')
    ap.add_argument('--max-triangles', type=int, default=2_000_000)
    ap.add_argument('--tex-size',    type=int, default=2048)
    args = ap.parse_args()

    minLon, minLat, maxLon, maxLat = args.bbox

    print(f"[export] BBox: ({minLat:.5f},{minLon:.5f}) -> ({maxLat:.5f},{maxLon:.5f})")

    # Convert bbox corners to UTM
    minE, minN, zone = latlon_to_utm(minLat, minLon)
    maxE, maxN, _    = latlon_to_utm(maxLat, maxLon)
    print(f"[export] UTM Zone {zone}: E {minE:.0f}–{maxE:.0f}, N {minN:.0f}–{maxN:.0f}")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)

        # 0. Download viewer libs (cached)
        print("[0/6] Downloading viewer libs...")
        viewer_libs = get_viewer_libs(progress=lambda m: print(f"[0/6] {m}"))

        # 1. Fetch points
        x, y, z, r, g, b = fetch_ept_points(
            args.ept, (minE, minN, maxE, maxN), progress=lambda m: print(f"[1/6] {m}")
        )

        # 2. Build DEM
        dem, x_bins, y_bins, x0, y0 = build_dem(
            x, y, z, args.resolution,
            progress=lambda m: print(f"[2/6] {m}")
        )

        # Apply the same Z correction FLEX applies to Potree point clouds.
        # Default (both usgsRef and egm96 OFF): -32 * 0.766 ~ -24.5 m.
        # Cave survey positions were established against the corrected display,
        # so terrain must be shifted by the same amount to align.
        FLEX_PC_Z_OFFSET = -32 * 0.766  # metres
        dem += FLEX_PC_Z_OFFSET
        print(f"[2/6] Applied FLEX point-cloud Z offset: {FLEX_PC_Z_OFFSET:.3f} m")

        # Terrain centre in UTM (for cave coordinate conversion)
        utm_center_e = (x_bins[0] + x_bins[-1]) / 2
        utm_center_n = (y_bins[0] + y_bins[-1]) / 2

        # 3. Build mesh
        vertices, faces = build_mesh(
            dem, x_bins, y_bins, x0, y0, args.max_triangles,
            progress=lambda m: print(f"[3/6] {m}")
        )

        # 4. Satellite texture
        texture = fetch_satellite_texture(
            (minLon, minLat, maxLon, maxLat), (args.tex_size, args.tex_size),
            progress=lambda m: print(f"[4/6] {m}")
        )

        # 5. UVs + GLB (texture embedded as data: URI inside the GLB JSON chunk)
        uvs = compute_uvs(vertices, dem.shape, x_bins, y_bins)
        glb_path = tmp / 'terrain.glb'
        export_glb(vertices, faces, uvs, texture, glb_path,
                   progress=lambda m: print(f"[5/6] {m}"))

        # 6. Package ZIP
        print(f"[6/6] Writing {args.out}...")
        with zipfile.ZipFile(args.out, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.write(glb_path, 'terrain.glb')

            # Caves: convert lon/lat/alt -> terrain-centred XYZ
            # Derive UTM zone from bbox centre longitude
            bbox_center_lon = (minLon + maxLon) / 2
            bbox_center_lat = (minLat + maxLat) / 2
            utm_zone = int((bbox_center_lon + 180) / 6) + 1
            if args.caves and os.path.exists(args.caves):
                caves_out = convert_caves(
                    args.caves, utm_center_e, utm_center_n,
                    progress=lambda m: print(f"[6/6] {m}")
                )
            else:
                caves_out = {"surveys": []}
            # Embed coordinate meta so the viewer can convert GPS lat/lon -> scene XYZ
            caves_out["meta"] = {
                "utm_center_e": float(utm_center_e),
                "utm_center_n": float(utm_center_n),
                "utm_zone":     int(utm_zone),
                "z_offset":     float(FLEX_PC_Z_OFFSET),
                "center_lon":   float(bbox_center_lon),
                "center_lat":   float(bbox_center_lat),
            }
            zf.writestr('caves.json', json.dumps(caves_out))

            # Viewer HTML: fully self-contained (Three.js + GLB + caves all inline)
            inline_html = build_inline_viewer(
                glb_path, caves_out, viewer_libs,
                progress=lambda m: print(f"[6/6] {m}"))
            zf.writestr('viewer.html', inline_html.encode('utf-8'))

            # serve.bat (Windows) — double-click to start local HTTP server
            zf.writestr('serve.bat',
                '@echo off\n'
                'cd /d "%~dp0"\n'
                'echo Starting FLEX viewer at http://localhost:8090/viewer.html\n'
                'start "" http://localhost:8090/viewer.html\n'
                'python -m http.server 8090\n'
                'pause\n')

            # serve.sh (macOS/Linux)
            zf.writestr('serve.sh',
                '#!/bin/bash\n'
                'cd "$(dirname "$0")"\n'
                'echo "Open http://localhost:8090/viewer.html"\n'
                'open "http://localhost:8090/viewer.html" 2>/dev/null || true\n'
                'python3 -m http.server 8090\n')

    sz = os.path.getsize(args.out) / 1e6
    print(f"[done] {args.out} ({sz:.1f} MB)")

if __name__ == '__main__':
    main()
