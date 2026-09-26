# FLEX

A cave and LiDAR visualiser: a CesiumJS globe with Potree point clouds in the
browser, a small Node server behind it, and a Python pipeline that bakes any
area into a self-contained offline viewer — or an Android app you can carry
underground.

2024 National Speleological Society convention talk:
https://docs.google.com/presentation/d/1ijDiJJ1g6IRt8oCFVmPTKpNqkT0I9oWBMN1QG8OYKQc/edit?usp=sharing

Demo video: https://feroz.us/FLEX-demo.mp4

---

## Install

Node 18 or newer:

```
npm install
```

For terrain export you also need Python 3 with PDAL, GDAL, NumPy, SciPy and
Pillow. A conda environment is the least painful route:

```
conda create -n entwine -c conda-forge python pdal python-pdal gdal numpy scipy pillow
```

## Run

```
node server.js
```

then open http://localhost:8081/index.html.

On Windows, `FLEX.bat` starts the server and a browser together. Copy
`Tokens.js.example` to `Tokens.js` and fill in your own API keys; both are
gitignored.

---

## What it does

- **Globe and terrain** — CesiumJS with several imagery and elevation sources
- **Point clouds** — Potree, from local or remote EPT datasets. The server can
  start and stop a local EPT host from the UI
- **Cave surveys** — imports PLT files, draws surveys as coloured lines with
  stations, and supports georectification: pin stations to world coordinates and
  warp the survey with IDW rubber-sheeting
- **CalTopo integration** through an authenticated proxy

---

## Portable offline viewer

The export dialog bakes the current area into a standalone viewer: a terrain
mesh from LiDAR, satellite and optional hillshade imagery, and the cave surveys.

```
python export_terrain.py --ept <ept.json> --bbox <minLon> <minLat> <maxLon> <maxLat> \
                         --caves caves.json --out export.zip
```

The zip holds a single `viewer.html` with everything inlined — it opens in any
browser with no server and no network — plus the same assets as sidecar files
(`terrain.glb`, `tex_sat.jpg`, `tex_hs.jpg`, `caves.json`, `libs/`) for the
Android build, and `serve.bat` / `serve.sh` for serving it locally.

The viewer has orbit and fly/crane camera modes, tappable stations with survey
details, terrain opacity and brightness, a satellite/hillshade toggle, KML and
KMZ import, and GPS with a compass-oriented caver marker.

Useful flags: `--resolution` (DEM cell size, default 0.5 m), `--max-triangles`
(default 2 M), `--tex-size` (default 8192), `--satellite-source` (`bing` or
`esri`), `--hillshade-url` (any XYZ tile template; empty by default).

---

## Android app

A WebView wrapper that carries one export offline, in `android/`:

```powershell
cd android
python tools\assemble_assets.py <export_dir> .. app\src\main\assets\flex
.\gradlew.bat installRelease
```

It exists for one specific reason. Chrome refuses geolocation to `file://`,
`content://` and bare LAN-IP origins — they are not "potentially trustworthy"
origins, so the request is denied and no permission prompt ever appears. The app
serves the identical files over `https://appassets.androidplatform.net/` through
`WebViewAssetLoader` and grants the permission itself, so GPS and the compass
work with no network at all. It declares no `INTERNET` permission.

Each cave gets its own `applicationId`, so several install side by side.

---

## Status and credits

Still rough in places, and licences and credits across the vendored
dependencies need a proper pass. `PotreeCopied/` is a vendored copy of
[Potree](https://github.com/potree/potree) by Markus Schütz. The globe is
[CesiumJS](https://cesium.com/platform/cesiumjs/); the offline viewer uses
[three.js](https://threejs.org/).

See `CLAUDE.md` for architecture notes and the non-obvious pitfalls.
