# FLEX — open work

Kept here so a new conversation starts with the backlog rather than rebuilding
it. Update as things land.

## Offline viewer

- **Survey descriptions** are not fully resolved. A third pass looks in
  `_caveImports` `parsed.surveys[]` and `station.surveyDesc`, but it is unclear
  whether FLEX's PLT parser exposes them. Needs a runtime inspection of
  `_caveImports` to find the real field names.
- **Station tap targets are tiny** — the station balls are small on a phone.
  Wants an expanded raycast threshold or an invisible larger hit mesh. Note the
  height-grid work: do not solve this with a per-frame terrain raycast.
- **Label clutter** — at zoomed-out views all station labels overlap. Wants
  distance-based culling or LOD.
- **`from_name` / `to_name` on shots are empty.** Stations come from point
  entities and `_caveImports`; shots only carry `from_xyz` / `to_xyz`.
- **Survey name collisions** if several PLT files cover the same survey code.
- **Texture size vs GPU limits.** Exports default to 16384 px, which is above
  what many mobile GPUs accept and is roughly 1 GB of VRAM as RGBA. The viewer
  queries `MAX_TEXTURE_SIZE` and downscales only if the device cannot take it,
  so the failure mode is handled — but re-exporting at 8192 would cut texture
  memory 4× for about 0.5 m/px, still well past what a phone screen resolves.

## Export pipeline

- **Z alignment** between cave lines and terrain depends on
  `FLEX_PC_Z_OFFSET` (currently −24.5 m) and may need per-export calibration.
- **Point clouds are not included in exports** — terrain mesh only. Could be
  added if the size is acceptable.

## Android app

- Currently one export per app build. `assemble_assets.py` plus
  `cave.properties` make rebuilding for another cave cheap, but an
  in-app picker that reads exports from a folder on the phone would avoid
  rebuilding at all. The Kotlin was structured with that in mind.
- Release builds are signed with the debug key so sideloading needs no keystore
  ceremony. Fine for personal use; would need a real key to distribute.

## Repo

- Licences and credits across vendored dependencies need a proper pass.
- `flex.js` is a single ~313 KB file.
