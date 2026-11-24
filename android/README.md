# FLEX Field — Android

One app that opens FLEX map exports and takes them underground: terrain,
imagery and cave surveys, offline, with GPS and compass — plus notes, survey
note pages and new survey added on the phone, all in a change log.

## What it does

- **Map list.** Import a FLEX export (the zip from Export → portable viewer)
  with **Import map**, or open the zip with FLEX Field from Files, Drive or the
  share sheet. Each map keeps its own notes, note pages, field surveys, tracks
  and change log.
- **Updating a map.** Import a newer export of the same map: when its Map Name
  matches a map already on the phone, the app asks whether to update that map
  or import it separately. Updating replaces the terrain, imagery and caves and
  keeps everything added on the phone. ⋯ → *Update from a newer export…* does
  the same for a map whose name changed.
- **Updating a map with only what changed.** Every export carries `manifest.json` (each data
  file with its size and sha256, a map id that stays the same across exports, a hash over the
  list). "Make an update" on the PC (`export_update.py`, `export_updates.js`) writes an update
  package: `update.json` first (the hash of the map it was made against, the whole new manifest,
  what to add / replace / remove), then only the changed files; no `viewer.html`. The app
  (`MapUpdate.kt`, plain Kotlin; `MapStore.findForUpdate` / `applyUpdate`) finds the map by its
  id (else by name), refuses unless that map's own manifest is the update's base (a map imported
  before manifests: "needs the full map once"), builds the new set in `export.new` (changed
  files from the package, the rest as hard links to the files already there), checks every
  sha256, then swaps the folders; `MapStore` puts a map back whole at the next start if the phone
  went off in between. What was added on the phone is untouched, the map's log gets a
  `map.update` entry with `partial: true`, and `export/map_version.json` (exported, updated
  from, how many updates) is what "About this map" shows. The inbox banner names an update
  ("An update for <map> from your PC"): `Inbox.list()` reads the zip's first entry.
  `tools/test_export_update.py` compiles `MapUpdate.kt` on the PC (the Kotlin compiler inside
  Gradle) and runs the same cases against it as against the reference rules.
- **On a station's card:** ✏️ a note · 📄 its documents (the export's scanned
  notes, sketches and photos, and what was added on the phone; opened full
  screen, pinch to zoom), in Survey notes / Sketches / Media / Other with counts,
  the most specific first: the sketchbook page that covers the station (a page
  tagged A6~A8), then its survey's, then the cave's, never another survey's or
  cave's (`libs/viewer-docs.js`, with FlexLib's `docsFor`: the same order as on
  the desktop). A group that comes from a wider level says so ("from survey T");
  the survey and the cave on the card open their own cards (the survey's
  documents, else the cave's); a station whose shots were read from a scan says
  "From page 2 of …" · 📐 survey new passage from here. In a document, ✎ Edit
  shows 🏷 Tags (the whole document) and 🏷 Tag this page… (cave → survey →
  station or range, recent tags); new pages get a kind from their name.
- **🔧 Tools → 📐 Field survey:** typed shots (from, to, length, azimuth,
  inclination, optional backsights, LRUD in decimal feet; `3/5` = ledge, the
  larger value is used), tied to existing stations, drawn as lines, stations
  and walls. The form suggests station names the cave does not have yet (a shot
  to a name that exists closes a loop onto it, and says so). Declination is
  worked out offline from the World Magnetic Model for the survey date at the
  tie-in and shown as "Declination 10.3° E (WMM 2026 at T6)" (type one in to
  override it); 📍 Use my location takes one GPS fix, used for a survey tied to
  no station of the map, whose first station can be placed at the fix
  (approximate, marked) or started there from ＋ New survey. Misclosure is
  shown when a shot closes onto a station.
- **🔧 Tools → 🚩 Route:** tap the start and end stations (stations only), or
  type part of a name in the box under the bar at the top; with a route showing
  only its stations can be tapped and the rest is dimmed.
- **📷 Import shots from scan** (📐 Field survey, or ⋯ on a document page):
  photograph a page of shot tables with the camera app, or pick a document
  page or a file; the phone reads it with ML Kit's text reader (the bundled
  model, inside the APK: offline, no Play Services download), and the table
  opens beside the scan to check (tap a cell to see it on the page) before
  the shots go into a field survey, each linked to its page.
- **📦 Inventories:** a chest on the map where something is kept (the export
  carries them; 🎨 Display → Inventories shows or hides them, a faded chest has
  something possibly out of date), and a 📦 line on its station's card. The
  card shows the contents (item, quantity, last change, last checked) and the
  dated log (date, who, action, items, photos: tap one for full screen), or the
  list of a simple-list inventory. **＋ Add entry** (left, took, checked, note,
  with the date, who, items and photos from the camera app or from files) is
  always there; making an inventory, renaming it, list or log, and changing or
  removing an entry wait behind its ✎ Edit. An exported inventory is taken into
  the phone's library on the first change (the same ids on every phone, so two
  phones merge without a conflict). 🔍 Find looks them up by name and by item.
- **🔧 Tools → 📝 Change log:** who changed what and when, with undo. Everything
  is logged under the name shown on ✍ (switchable, last used by default).
- **⋯ → Export field data** writes the notes, field surveys (with computed
  positions) and the full log as JSON. ⋯ on the map list → *Share notes, pages
  & log* zips a map's notes, note pages, log and tracks.

## Why an app at all

Chrome refuses geolocation and device orientation to `file://`, `content://`
and bare LAN-IP pages. The app serves everything through `WebViewAssetLoader`
at `https://appassets.androidplatform.net/`, a trustworthy origin, and grants
location itself. It declares no `INTERNET` permission, so it is offline by
construction. ML Kit's usage-log uploader asks for `INTERNET` in its own
manifest; the app's manifest removes it again (`tools:node="remove"`) and
unregisters the uploader's backend. Check a new build with
`aapt2 dump permissions app-debug.apk`: location and `ACCESS_NETWORK_STATE`
only. No `CAMERA` permission either: "Photograph a page" goes through the
phone's camera app, which needs none while the app does not declare it.

## Layout

```
app/src/main/java/.../MainActivity.kt    WebView, file pickers, JS bridge (AndroidHost), /map/ routing
app/src/main/java/.../MapStore.kt        storage, zip import, legacy exports, note pages, log
app/src/main/flexfield-assets/flexfield/index.html   the map list
../viewer_build/                         the viewer, used as an asset folder as-is
```

On the phone (app-private storage):

```
files/maps/<id>/map.json             name, dates
files/maps/<id>/export/              terrain.glb, tex_sat.jpg, tex_hs.jpg, walls.bin, caves.json (+ ridge_*.bin, ridge.json, tex_hsb.jpg)
files/maps/<id>/user/log.jsonl       the change log (notes and field surveys are rebuilt from it)
files/maps/<id>/user/notes/<survey>/ note pages
```

Only the export's data files are unpacked; the zip's big single-file
`viewer.html` is skipped. Exports made before the sidecar files existed are
unpacked from that `viewer.html` instead (slower, once).

### Maps sent from the PC ("Send to phone")

FLEX on the PC can send an export over the USB cable with adb (`phone_api.js`); the app
takes it in `Inbox.kt`, with no permission and no network:

- **A local socket**, `flexfield_inbox` (a unix socket of the app, opened in `onCreate`; not an
  internet socket, so no `INTERNET` permission): the PC runs `adb forward tcp:0
  localabstract:flexfield_inbox` and streams the zip (`PING` / `SEND <bytes> <name>`); only adb
  (the shell user) is answered; the file is kept in the app's own `files/inbox/`.
- **A folder**, `Android/data/com.feroz.flexfield/files/inbox/` on the shared storage, that
  `adb push` can write. Whether the app can read what adb put there differs between phones, so
  every time the map list asks, the app writes what it found and whether it could read it to
  `files/inbox_status.json` beside it; the PC reads that and, if the copy is no use, moves it to
  `Download` and says so.

The map list (`flexfield/index.html`) shows "1 map from your PC is waiting" with **Import**
(the normal import: name match, update) and ✕ (discard); bridge methods `inboxList`,
`inboxImport`, `inboxDiscard`. The PC's copy is deleted once the map is in.

An export made with **Include surface features** also carries `features.json`
(the project's points, lines and areas, view only: `viewer_build/libs/viewer-features.js`,
🎨 Display → Surface features); `MapStore.FEATURES_FILE` keeps it and `MainActivity`
puts its name in place of `PLACEHOLDER_FEATURES_JSON` (`null` for a map without it).

An export made with **Trees and brush** also carries `trees.bin` (one 24-byte
record a tree or bush; the 20-byte version 1 is read too) and `trees.json` (the count, the kinds, the detail
level). `MapStore.kt` keeps both (`TREES_FILE`, `TREES_INFO`),
`MainActivity.kt` hands the viewer `trees.json`'s `viewer` object as `TREES`
(drawn by `viewer_build/libs/trees.js`: 🎨 Display → Trees and brush); a map
without them gets `null`.

An export with ridgewalking also carries `brush.bin` (the bushwhack grid: a
share and a height a cell, "FBR1") and `brush.json` (the grid's place and the
classes). `MapStore.kt` keeps both (`BRUSH_FILE`, `BRUSH_INFO`),
`MainActivity.kt` hands the viewer `brush.json`'s `viewer` object as `BRUSH`
(drawn as small rounded bushes by `viewer_build/libs/brush-bushes.js`, a look
registered with the hub in `brush-blocks.js`, whose low blocks are the
fall-back; how dense the brush is shows as how solid a bush is. Single bushes
are drawn out to the distance of ⋯ More → Brush detail: Normal 180 m, Far
360 m (the default), Very far 600 m, with a triangle limit of 0.9, 1.8 and
3 million; clumps carry the brush beyond. ⋯ More → Simpler bushes far away,
on by default, draws bushes past 150 m with 9 triangles. Both are kept per
project (`DISP.brushDetail`, `DISP.brushSimple`). The Brush chip of 🎨 Display → Trees and brush
switches them, a hold on a chip opens its opacity slider, and the Light /
Medium / Dense chips under it switch each density class); a map without them
gets `null`.

An export made with **V2 - Ridgewalking** also carries `ridge_points.bin`,
`ridge_shapes.bin`, `ridge_patches.bin`, `ridge.json` and `tex_hsb.jpg` (the
hillshade with the brush map on it, a third Imagery choice; `tex_hsb_<c>_<r>.jpg`
tiles on a big export).
`MapStore.kt` keeps them at import (`RIDGE_FILES`), `MainActivity.kt` serves
them and hands their names to the viewer (`RIDGE`, drawn by
`viewer_build/libs/ridgewalk.js`: 🎨 Display → Below ground (V2)); a map
without them gets `null` and looks as before. A map imported with an older
build of the app has to be imported again (or updated from the same zip) to
get those files. The build command is unchanged.

A ridgewalking export also carries `ridge_features.json` (the list of features:
anchor, box, depth, returns, true entrance / guessed, lon / lat) and, when the
project had marks in the area, `ridge_marks.json`; both are in `RIDGE_FILES`
and named in `RIDGE`. `viewer_build/libs/ridge-marks.js` uses them: tap a
feature, mark it cave / pit / nothing / not reached. A mark is a record of the
map's project (`rmark.set` in the library's log, rules in `flexlib.js`), so it
needs no new storage and travels in the sync file as it is.

The viewer is bundled in the app, not taken from each export, so a viewer fix
reaches every map with one rebuild; it reads every older export layout.

## Build

Android Studio or the SDK command-line tools, JDK 17.

```powershell
cd android                            # from the FLEX checkout
.\gradlew.bat installRelease          # or assembleRelease → app\build\outputs\apk\release\
```

`release` is signed with the debug key so it sideloads with no keystore. Do not
publish it.

The package is `com.feroz.flexfield`, so it installs next to the old per-cave
apps (`com.feroz.flexviewer.*`) instead of replacing them; uninstall those by
hand. Tracks and pins recorded in an old app stay in that app (export them
there as GPX/KML first if you want them).

A made-up test map: `python tools\make_synthetic_export.py out\test` writes
`out\FLEX-Cave-Ridge.zip` (needs the exporter's conda environment).

## Building on Linux (the FLEX server)

Nothing system-wide: the JDK and the SDK live under `~/opt/`, environment
variables are set per command, no shell profile is touched.

```bash
# one-time: JDK 17 (Temurin) and the Android command-line tools
mkdir -p ~/opt/dl ~/opt/jdk17 ~/opt/android-sdk/cmdline-tools
curl -fsSL -o ~/opt/dl/jdk17.tgz "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse"
tar xzf ~/opt/dl/jdk17.tgz -C ~/opt/jdk17 --strip-components=1
# commandlinetools-linux-<n>_latest.zip: current <n> is on https://developer.android.com/studio
curl -fsSL -o ~/opt/dl/cmdtools.zip https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip
unzip -q ~/opt/dl/cmdtools.zip -d ~/opt/dl/x && mv ~/opt/dl/x/cmdline-tools ~/opt/android-sdk/cmdline-tools/latest
export JAVA_HOME=~/opt/jdk17 ANDROID_HOME=~/opt/android-sdk ANDROID_SDK_ROOT=~/opt/android-sdk
yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-34" "build-tools;34.0.0" "platform-tools"

# every build
cd android
export JAVA_HOME=~/opt/jdk17 ANDROID_HOME=~/opt/android-sdk ANDROID_SDK_ROOT=~/opt/android-sdk
./gradlew --no-daemon assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
```

The APK bundles only `viewer_build/` (viewer template and `libs/`),
`flexfield-assets/` and ML Kit's text reader (~18 MB of native code for the
two ARM ABIs, `ndk.abiFilters` in `app/build.gradle.kts`; drop that line for
an x86 emulator); no map data. `unzip -l` the APK and check `assets/` before
handing it out. Gradle puts its caches in `~/.gradle`.

## Debugging on device

Build `assembleDebug`, connect USB, open `chrome://inspect` on the desktop and
attach to the WebView.

`tools/assemble_assets.py` is the old per-cave build (one APK per export); the
app no longer uses it.
