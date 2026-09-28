# FLEX Viewer — Android

A WebView host for a FLEX portable cave export.

## Why this app exists

Chrome will not grant geolocation or device-orientation to a page whose origin
is `file://`, `content://`, or a bare LAN IP — none of those are "potentially
trustworthy" origins, so the request is refused outright and no permission
prompt is ever shown. That is why the exported viewer rendered fine on a phone
but could never get a GPS fix.

This app serves the identical files through `WebViewAssetLoader` at
`https://appassets.androidplatform.net/`, which *is* a trustworthy origin, and
grants the geolocation request itself from `WebChromeClient`. No socket is
opened and the app declares no `INTERNET` permission, so it is provably offline.

## Layout

```
app/src/main/assets/flex/
├── viewer.html      slim shell (~75 KB) — assets referenced, not inlined
├── terrain.glb      terrain geometry
├── tex_sat.jpg      satellite texture
├── tex_hs.jpg       hillshade texture
├── caves.json       survey data
└── libs/            three.js, OrbitControls, GLTFLoader, jszip
```

The single-file export inlines all of that as base64 into one ~180 MB HTML
document. That works in a desktop browser but risks an out-of-memory kill in a
WebView and wastes ~45 MB to base64 overhead, so the assets are split back out.

## Build

Requires Android Studio (or the SDK command-line tools) with a JDK 17.

```powershell
cd C:\Users\feroz\FLEX\android
.\gradlew.bat assembleRelease
```

Output: `app\build\outputs\apk\release\app-release.apk`

`release` is signed with the debug key on purpose, so the APK installs by
sideloading without any keystore setup. Do not publish it.

Install over USB with debugging enabled:

```powershell
.\gradlew.bat installRelease
```

## Building for a different cave

```powershell
python tools\assemble_assets.py <export_dir> .. app\src\main\assets\flex
.\gradlew.bat installRelease
```

That rewrites `cave.properties`, which `app/build.gradle.kts` reads to set the
launcher label and the `applicationId` suffix. Each cave therefore installs as
its own app instead of replacing the last one -- useful for carrying several
systems on one phone, but it does mean the first build after this change lands
alongside the old `com.feroz.flexviewer` install rather than upgrading it.
Uninstall that one by hand.

Pass `--name "Cave Ridge"` to override the label if the export folder name is ugly.

Exports made before the exporter wrote sidecar textures still work: the script
falls back to decoding them out of the 170 MB `viewer.html`, which is slow but
correct. Newer exports carry `tex_sat.jpg` and `tex_hs.jpg` directly and skip
that entirely.

The HTML shell is always rebuilt from `viewer_build/viewer.html`, so an old
export picks up viewer fixes without being re-exported.

## Debugging on device

Build `assembleDebug`, connect USB, then open `chrome://inspect` on the desktop
to attach devtools to the WebView.
