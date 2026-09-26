# FLEX — constraints and hard-won gotchas

## Secrets (the rule that must not break)

The hillshade / Mapbox tile URL is a **private map on a public repo**. It is
entered in the export dialog at runtime and passed as `--hillshade-url`,
defaulting to empty. Never hardcode it, never commit it, never put it in an
example or test fixture.

`Tokens.js`, `FLEX.bat`, `FLEX.sh`, `.caltopo_session` and `user_files/` are
gitignored — local paths and credentials. Prefer explicit `git add` over
`git add -A`.

## Browser app

**Potree clouds are on `potreeViewer`**, not `window.viewer`. Loaded clouds:
`potreeViewer.scene.pointclouds`.

**`pcoGeometry.url` is mangled** — Potree strips the scheme and the `ept.json`
suffix, so it cannot be handed to PDAL. `index.html` wraps `window.addPC` to
capture the original URL first.

## Export pipeline

**EPT CRS is often EPSG:3857**, notably USGS public data, while bounds are in
UTM. `export_terrain.py` reads `ept.json` for the native EPSG and converts the
bbox with plain trigonometry, because the conda `entwine` env has no pyproj.
PDAL's own `filters.reprojection` converts the returned points.

**The Windows console is cp1252.** No Unicode arrows or box-drawing characters
in Python progress strings — they raise `UnicodeEncodeError` mid-export.

**PowerShell `>` and `Out-File` write UTF-16.** This silently corrupted
`.gitignore` once: every character space-separated, rule matched nothing. Use
`-Encoding ascii` or write the file from Python.

## Offline viewer

**three.js is r128**, older than most examples. No `CapsuleGeometry` (r130+).
`MeshLambertMaterial` has no `flatShading` — it is vertex-lit. For faceted
low-poly, bake flat normals into the geometry: de-index, then
`computeVertexNormals()`.

**Never raycast the terrain per frame.** three.js raycasting is a linear scan
over every triangle with no BVH, so one query against the ~2 M-triangle mesh
costs tens to hundreds of milliseconds. The viewer bins vertices into a height
grid once at load (`buildHeightGrid`) and samples that — measured at 200,000
lookups in ~31 ms. Grid resolution is derived from the vertex count; a
hold-out test on the real mesh showed accuracy improving monotonically with
resolution up to the 2048 cap, because decimation puts vertices where the
ground is rough. Holes are filled by a mip pyramid, not neighbour dilation.

**The render loop throttles itself deliberately.** Interaction opens a short
full-rate window; ambient animation runs at a few fps; a static scene issues no
GPU work at all; a backgrounded page draws nothing. Anything that animates
continuously will hold the loop awake and cost battery underground — wire it
into `markerNeedsEase()` / `_ambient` rather than assuming frames happen.

**GPS backs off when it cannot get a fix.** Fine accuracy, then coarse after
3 minutes, then suspended after 8. A receiver hunting for a fix it will never
get — which is exactly what happens underground — is one of the largest drains
on the device, often exceeding the 3D rendering.

**Geolocation needs a trustworthy origin.** `https://`, `http://localhost` and
`http://127.0.0.1` qualify. `file://`, `content://` and LAN IPs do not.

## Platform

The phone is the target: battery, no signal, one hand, gloves or mud. When
weighing a change, the ranking of what actually drains the battery is screen
on-time, then GPS hunting with no fix, then the WebGL render loop.
