# FLEX — working notes for Claude

Cave and LiDAR visualiser: CesiumJS globe + Potree point clouds in the browser,
driven by a small Node server, plus a Python pipeline that bakes an area into a
self-contained offline viewer and an Android app.

FLEX is **open source and public**. Nothing private belongs in this repo — see
*Secrets* below, it is the one rule that must not be broken.

---

## Running it

```
node server.js            # serves on :8081
http://localhost:8081/index.html
```

`FLEX.bat` (Windows) and `FLEX.sh` do both steps. Both are gitignored: they
contain absolute local paths.

Node deps: `cesium`, `http-proxy`, `potree`. `PotreeCopied/` is a vendored
Potree checkout, not a submodule — treat it as third-party and don't refactor it.

---

## Layout

| Path | Role |
|---|---|
| `index.html` | The whole UI: panels, menus, the export dialog |
| `flex.js` | Main app (~313 KB). Cesium + Potree wiring, surveys, georectification |
| `server.js` | Node backend. Static files, CalTopo proxy, EPT control, export jobs |
| `api.js`, `layers.js`, `session.js`, `settings.js`, `context-menu.js` | Backend and UI helpers |
| `export_terrain.py` | PDAL → DEM → mesh → textures → portable viewer zip |
| `viewer_build/viewer.html` | **Template** for the portable viewer (see below) |
| `viewer_build/libs/` | Vendored three.js r128, OrbitControls, GLTFLoader, jszip |
| `android/` | WebView wrapper app for one export |
| `PotreeCopied/` | Vendored Potree — third party |

Server API: `/api/entwine/*` (point cloud serving), `/api/export/*` (terrain
export jobs), `/api/plt-cache`, `/api/declination`, `/api/recents`,
`/api/updates/*`.

---

## The portable viewer

`viewer_build/viewer.html` is a **template with placeholders**, not a runnable
page. `build_inline_viewer()` in `export_terrain.py` substitutes:

- `"PLACEHOLDER_GLB_B64"` → terrain geometry
- `"PLACEHOLDER_TEX_B64"` / `"PLACEHOLDER_HS_B64"` → satellite / hillshade texture
- `PLACEHOLDER_CAVES_JSON` → survey data as a JSON literal

**Edit the template, never an export.** Every export and every app build reads
it, so a fix there reaches everything without re-running the DEM pipeline.

It is deliberately **dual-mode**: each placeholder accepts either inline base64
or a sidecar filename. `isAssetRef()` and `loadB64Texture()` sniff which.
That is what lets one file serve both the 170 MB single-file export (opens in a
desktop browser, no server) and the slim shell the APK uses.

An export zip contains: `viewer.html` (everything inlined), plus `terrain.glb`,
`caves.json`, `tex_sat.jpg`, `tex_hs.jpg` and `libs/` as sidecars, plus
`serve.bat` / `serve.sh`.

---

## Android app

```powershell
cd android
python tools\assemble_assets.py <export_dir> .. app\src\main\assets\flex
.\gradlew.bat installRelease
```

`cave.properties` is written by the assemble step and read by
`app/build.gradle.kts` to set the launcher label and the `applicationId` suffix,
so each cave installs as its own app.

**The build must run in PowerShell, not through an agent shell.** The Android
SDK lives in `%LOCALAPPDATA%`, outside any connected folder, and `dl.google.com`
and Maven Central are blocked from the sandboxes. Assets can be assembled by an
agent; Gradle cannot be invoked by one.

**Why the app exists at all:** Chrome refuses geolocation and device-orientation
to `file://`, `content://` and bare LAN-IP origins — they are not "potentially
trustworthy", so the request is denied with no prompt. `WebViewAssetLoader`
serves the same files over `https://appassets.androidplatform.net/`, and the app
grants the permission itself in `WebChromeClient`. The app declares **no
`INTERNET` permission**, which makes "works offline" enforceable rather than
claimed. Keep it that way.

---

## Secrets

The hillshade / Mapbox tile URL is a **private** map on a public repo. It is
entered in the export dialog at runtime and passed through as
`--hillshade-url`, defaulting to empty. Never hardcode it, never commit it,
never put it in an example or a test fixture.

`Tokens.js`, `FLEX.bat`, `FLEX.sh`, `.caltopo_session` and `user_files/` are
gitignored and contain local paths or credentials. Check `git status` before
committing rather than `git add -A`.

---

## Gotchas that have already cost time

**Potree point clouds live on `potreeViewer`**, not `window.viewer`. Loaded
clouds are `potreeViewer.scene.pointclouds`.

**`pcoGeometry.url` is mangled** — Potree strips the scheme and the `ept.json`
suffix, so it cannot be handed to PDAL. `index.html` wraps `window.addPC` to
capture the original URL before Potree sees it.

**EPT CRS is often EPSG:3857**, notably USGS public data, while bounds are in
UTM. `export_terrain.py` reads `ept.json` for the native EPSG and converts the
bbox with plain trigonometry — the conda `entwine` env has no pyproj. PDAL's own
`filters.reprojection` converts the returned points.

**Windows console is cp1252.** No Unicode arrows or box characters in Python
progress strings; they raise `UnicodeEncodeError` mid-export.

**PowerShell `>` and `Out-File` write UTF-16.** This silently corrupted
`.gitignore` once — every character space-separated, rule matched nothing. Use
`-Encoding ascii`, or write the file from Python.

**three.js in the viewer is r128** and older than most examples. No
`CapsuleGeometry` (r130+). `MeshLambertMaterial` has no `flatShading` — it is
vertex-lit; bake flat normals into the geometry instead (de-index, then
`computeVertexNormals`).

**Never raycast the terrain per frame.** three.js raycasting is a linear scan
over every triangle with no BVH, so one query against the ~2 M-triangle mesh
costs tens to hundreds of milliseconds. The viewer bins vertices into a height
grid once at load (`buildHeightGrid`) and samples that. Grid resolution is
derived from the vertex count; holes are filled by a mip pyramid, not by
neighbour dilation, which would need one pass per cell of reach.

**The viewer throttles itself on purpose.** Interaction opens a short full-rate
window, ambient animation runs at a few fps, and a static scene issues no GPU
work at all. If you add something that animates continuously, it will hold the
loop awake and cost battery underground — wire it into `markerNeedsEase()` /
`_ambient` rather than assuming a frame will happen.
