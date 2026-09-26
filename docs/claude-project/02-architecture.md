# FLEX — architecture

## Running

`node server.js` serves on :8081; open `http://localhost:8081/index.html`.
`FLEX.bat` / `FLEX.sh` do both and are gitignored (absolute local paths).

## Files

| Path | Role |
|---|---|
| `index.html` | The whole UI — panels, menus, the export dialog |
| `flex.js` | Main app, ~313 KB. Cesium + Potree wiring, surveys, georectification |
| `server.js` | Node backend — static files, CalTopo proxy, EPT control, export jobs |
| `api.js` | API helpers |
| `layers.js` | Imagery and terrain layer definitions |
| `session.js` | Session persistence |
| `settings.js` | Server configuration |
| `context-menu.js` | Right-click menus |
| `export_terrain.py` | The export pipeline |
| `viewer_build/viewer.html` | Template for the portable viewer |
| `viewer_build/libs/` | Vendored three.js r128 and friends |
| `android/` | WebView wrapper app |
| `PotreeCopied/` | Vendored Potree — third party, do not refactor |

## Server API

- `/api/entwine/{config,datasets,start,status,stop}` — local EPT point cloud host
- `/api/export/{terrain,status/:id,download/:id}` — terrain export jobs
- `/api/plt-cache` — cave survey file cache
- `/api/declination` — magnetic declination lookup
- `/api/recents` — recent files
- `/api/updates/{check,apply}` — self-update

## Key globals in the browser app

- `potreeViewer` — the Potree viewer. **Not** `window.viewer`.
- `potreeViewer.scene.pointclouds` — currently loaded point clouds
- `window.addPC(url)` — loads an EPT dataset. `index.html` wraps this to capture
  the original URL, because Potree mangles it afterwards.

## Data flow for an export

1. UI collects bbox, EPT dataset, resolution, texture size, map sources
2. `POST /api/export/terrain` starts a job; the UI polls `/api/export/status/:id`
3. `export_terrain.py` reads the EPT via PDAL, builds a DEM, meshes and
   decimates it, fetches and stitches imagery tiles, converts the caves to
   terrain-centred XYZ, and writes a zip
4. The zip is fetched from `/api/export/download/:id`
