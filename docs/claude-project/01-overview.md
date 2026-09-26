# FLEX — overview

A cave and LiDAR visualiser. A CesiumJS globe with Potree point clouds in the
browser, a Node server behind it, and a Python pipeline that bakes an area into
a self-contained offline viewer or an Android app.

## Who it is for

Cavers and cave surveyors. The offline viewer is the part carried underground:
a phone, no signal, limited battery, often one-handed and muddy. That context
drives most of the design decisions — power use, touch target size, and
legibility at a glance matter more than visual polish.

## The three pieces

**The browser app** (`index.html`, `flex.js`, `server.js`) — the desktop tool
for exploring LiDAR, loading point clouds, importing cave surveys from PLT
files, and georectifying surveys onto real-world coordinates.

**The export pipeline** (`export_terrain.py`) — takes an EPT point cloud and a
bounding box, produces a DEM, meshes it, drapes satellite and hillshade imagery
over it, folds in the cave surveys, and emits a portable viewer.

**The offline viewer and Android app** (`viewer_build/viewer.html`, `android/`)
— a three.js scene carried into the field, with GPS, compass and a caver marker.

## Status

Functional and in real use, but rough in places. Licences and credits across the
vendored dependencies (`PotreeCopied/`, CesiumJS, three.js) need a proper pass.
The repo grew organically and `flex.js` is a single ~313 KB file.
