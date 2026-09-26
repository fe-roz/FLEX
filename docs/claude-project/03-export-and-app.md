# FLEX — export pipeline and Android app

## The viewer template

`viewer_build/viewer.html` is a **template with placeholders**, not a runnable
page. `build_inline_viewer()` in `export_terrain.py` substitutes:

- `"PLACEHOLDER_GLB_B64"` → terrain geometry
- `"PLACEHOLDER_TEX_B64"` / `"PLACEHOLDER_HS_B64"` → satellite / hillshade texture
- `PLACEHOLDER_CAVES_JSON` → survey data as a JSON literal

**Always edit the template, never a generated export.** Both the browser export
and the Android build read it, so a fix there reaches everything without
re-running the DEM pipeline — which is the expensive part.

The template is **dual-mode**: each placeholder accepts either inline base64 or
a sidecar filename, sniffed by `isAssetRef()` and `loadB64Texture()`. One file
therefore serves both the single-file export and the slim shell the APK uses.

## Export output

A zip containing `viewer.html` with everything inlined (opens in any browser, no
server, no network — around 170 MB), plus the same assets as sidecars
(`terrain.glb`, `tex_sat.jpg`, `tex_hs.jpg`, `caves.json`, `libs/`) and
`serve.bat` / `serve.sh`.

The sidecars exist so the Android build does not have to decode a 170 MB
document back into the bytes the exporter already had.

## Viewer features

Orbit and fly/crane camera modes; tappable stations with survey details;
terrain opacity and brightness sliders; satellite/hillshade toggle; KML and KMZ
import; GPS with a compass-oriented 3D caver marker.

GPS button cycles: off → pin → follow → heading-up → off. Long-press anchors
the terrain to your current position, which lets the whole GPS path be tested
without travelling to the cave.

## Android app

```powershell
cd android
python tools\assemble_assets.py <export_dir> .. app\src\main\assets\flex
.\gradlew.bat installRelease
```

`cave.properties` is written by the assemble step and read by
`app/build.gradle.kts` to set the launcher label and `applicationId` suffix, so
each cave installs as a separate app.

### Why the app exists

Chrome refuses geolocation and device-orientation to `file://`, `content://`
and bare LAN-IP origins — none are "potentially trustworthy" origins, so the
request is denied outright and no permission prompt ever appears. This is a
browser security rule, not a setting, and nothing on the phone can change it.

`WebViewAssetLoader` serves the identical files over
`https://appassets.androidplatform.net/` — a trustworthy origin — and the app
grants the geolocation request itself in `WebChromeClient`. No socket is opened
and the app declares **no `INTERNET` permission**, which makes "offline" an
enforceable property rather than a claim.

### Build constraint

Gradle must be run by hand in PowerShell. The Android SDK lives in
`%LOCALAPPDATA%`, outside any folder shared with an agent, and `dl.google.com`
and Maven Central are blocked from the sandboxes. An agent can assemble the
assets; it cannot invoke the build.
