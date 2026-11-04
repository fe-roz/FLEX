# FLEX's edits to the vendored Potree

`PotreeCopied/` is stock **Potree 1.8.2** (github.com/potree/potree commit
3013577379b5c8530ebca3cdc980f7585ae2320f) plus the edits listed here. Every
edit is marked with a `FLEX` comment in the source (`grep -rn FLEX src`).
Files that are not listed are stock. Besides `src/`, the folder also keeps
FLEX's own `libs/Cesium/` (Cesium widgets css used by `index.html`, not in stock),
a few edited examples, and extra dependencies in `package.json` (`cesium`,
`mersenne-twister`).

Potree 1.8.2 merged the EPT and COPC loaders: both now create
`PointCloudCopcGeometryNode` nodes (in `src/PointCloudEptGeometry.js`) and decode
`.laz` data with the same worker (`EptLaszipDecoderWorker.js`, using the bundled
copc.js and laz-perf). So the failure-recovery and scan-angle edits cover COPC
(`.copc.laz`) as well as EPT laszip with no extra code.

**Build:** `cd PotreeCopied && npm install` (runs `gulp build pack`, output in
`build/potree/`, which is gitignored). Rebuild after every pull that touches
`PotreeCopied/src`, `libs` or `package.json`.

## Upgrading to a newer Potree

1. Get the stock tag the current copy is based on and the new one.
2. Overwrite `PotreeCopied/` with the new stock, but keep `libs/Cesium/`, the
   extra `package.json` dependencies and the FLEX-edited examples.
3. For each file below, 3-way merge: `git merge-file ours old-stock new-stock`
   (or re-apply by hand from the description, using `grep -rn FLEX` on the old
   tree). Files where the upstream code was reorganised (the loaders) need a
   manual re-apply; the description says what each edit must do.
4. `npm install`, then run `node tools/test_hag_shader.js` and the kit.

"Runtime patch?" means: could FLEX instead keep stock Potree and replace
functions at startup (prototype patching, the other branch's approach). Where
the answer is "no", the reason is that the edit sits in the middle of a large
function or in a file the page does not control (shader text, worker).

## The edits

### 1. Height-above-ground filter: shader
`src/materials/shaders/pointcloud.vs` -- uniforms `uGroundTex*`, `uGroundModelMatrix`,
`uHagRange`, `uBushRange` and the `clip_hag_enabled` block in `main()` that
compares each point's height with the ground grid and culls or colours it. Why:
the filter is a FLEX feature (cave entrances / bushwhack: show points between two
heights above ground). Re-apply: copy the two marked blocks (uniform
declarations near the other uniforms, and the `{ // FLEX: height-above-ground
filter` block next to the other `clip_*` blocks in `main()`). Test:
`tools/test_hag_shader.js` compiles the real file and checks what it culls.
Runtime patch: **yes in principle** (`Potree.Shaders['pointcloud.vs']` is a
string that could be edited by text insertion before the first material is made),
but the injection points must be matched by text, so it breaks silently if
upstream edits those lines; and it needs edits 2 and 3 as well.

### 2. Height-above-ground filter: material uniforms
`src/materials/PointCloudMaterial.js` -- the `uGround*`, `uHag*`, `uBush*`
entries in `uniforms`. The textures use the custom type `"hagtex"` (a plain
`{width,height,data,version}`), deliberately not `"t"`, see edit 3. Re-apply: add
the block after `uFilterPointSourceIDClipRange`. Runtime patch: **yes** (the same
keys can be added to `material.uniforms` of every new material), but it is useless
without edit 3.

### 3. Height-above-ground filter: renderer
`src/PotreeRenderer.js` -- two blocks inside `renderOctree()`:
(a) `uGroundModelMatrix`, the node world matrix with the ground-grid origin
subtracted from its XY translation in float64 (an EPSG:3857 easting is about
-1.3e7, where one float32 step is about a metre); (b) the "height-above-ground
filter" block that uploads every `uGround*`/`uHag*`/`uBush*` uniform by name and
the two ground textures with raw GL calls (Potree's own texture helper tests
`instanceof THREE.DataTexture` against its bundled three.js, which fails for
textures made by the page's three.js: the "two three.js instances" rule in
doc 04). Re-apply: the (a) block goes right after `uniformMatrix4fv(lModelView, ...)`; the (b) block goes after the matcap texture is bound and before
the `material.snapEnabled` block (it uses and advances `currentTextureBindingPoint`). Runtime patch: **no**
-- `renderOctree` is a ~600 line method; a patch would be a full copy that has to
be diffed against upstream on every upgrade, which is no easier than this.

### 4. Distance-based LOD
`src/Potree.js` (exports `lodFarDistance`, `lodFarPenalty`, `lodNearDistance`) and
`src/Potree_update_visibility.js` (two marked blocks in the node loop of
`updatePointClouds`): nodes whose nearest point is beyond `lodFarDistance` need
`lodFarPenalty` times the minimum screen size to be refined, and loading priority
is divided by `1 + (d/lodNearDistance)^2`. Why: oblique views spent the point
budget on the horizon. Re-apply: the variables go next to the other exports in
`Potree.js`; in `Potree_update_visibility.js` replace the
`screenPixelRadius < pointcloud.minimumNodePixelSize` test with the `minPixels`
version and add the weight line after `weight` is computed. Runtime patch:
**no** -- the change is in the middle of `updatePointClouds` (a ~400 line function
that `viewer.js` calls as `Potree.updatePointClouds`); only a full copy would do.
The three settings themselves are plain runtime-settable values.

### 5. EPT/COPC load failure recovery (nodes never stranded)
`src/PointCloudEptGeometry.js`, class `PointCloudCopcGeometryNode`:
new `loadFailed(reason)` (the single release path: clears `loading`, decrements
`Potree.numNodesLoading`, sets an exponential back-off up to 60 s, idempotent),
`load()` skips a node still backing off and wraps the hierarchy fetch and
`loadPoints()` in try/catch, `doneLoading()` only decrements the counter if the
node still holds its slot and resets the back-off; `loadHierarchyPage()` of the EPT
geometry throws on an HTTP error instead of parsing an error page as JSON.
`src/loader/ept/LaszipLoader.js` (EPT laszip and COPC): `fetch` with a 60 s
timeout and HTTP status check in `EptLaszipLoader.load`, range-request failure in
`CopcLaszipLoader.load`, parse failure in both `parse` methods, and in
`EptLazBatcher.push` a `worker.onerror` plus try/catch around `onmessage` so a
corrupt chunk releases the node. Why: any failed request used to leave a node with
`loading === true` forever and leak the global counter until nothing loaded.
Re-apply: add `loadFailed` and the guards, then make every failure exit of every
loader call `node.loadFailed(...)`. Runtime patch: **yes** for the node class
(`load`, `loadFailed`, `doneLoading`, `loadHierarchy` on
`Potree.PointCloudCopcGeometryNode.prototype`) and the two `load` methods of the
loaders (`Potree.EptLaszipLoader.prototype`, `Potree.CopcLaszipLoader.prototype`);
**no** for the worker `onerror`/try-catch inside `EptLazBatcher.push` unless the
whole `push` is replaced (which edit 6 needs anyway).

`src/loader/ept/BinaryLoader.js` carries the same treatment for EPT `binary` data
(unchanged from before). Note: in stock 1.8.2 the binary and zstandard EPT
loaders no longer work at all (`node.url()`, `node.ept` and `node.key.b` no longer
exist on the merged node class), so this file is now dead code in practice. FLEX
needs EPT `dataType: laszip` or COPC. Runtime patch: n/a.

### 6. Scan angle attribute (angle of incidence)
`src/workers/EptLaszipDecoderWorker.js` reads `ScanAngle` (copc.js gives the
scan angle rank for point formats 0-5 and the scaled 16-bit angle, in degrees,
for 6-10) into a `scanAngle` float32 buffer; `src/loader/ept/LaszipLoader.js`
(`EptLazBatcher`) adds it to the geometry as the `scan angle` attribute. Why:
`flex.js` (incidence visualisation, survey-line fitting) reads
`geometry.attributes['scan angle']`. Re-apply: in the worker, one buffer, one
view, one getter, one line in the point loop; in the batcher, one
`g.setAttribute('scan angle', ...)`. Runtime patch: **no** for the worker (a
worker is a separate script loaded by URL; patching means serving a modified
copy), and the batcher part only by replacing `EptLazBatcher.prototype.push`.

### 7. Splat mode [beta]: ground as discs on the slope
`src/materials/shaders/pointcloud.vs` -- the `splat_enabled` block (uniforms `uSplat*`, varyings `vSplat*`,
`splatGroundZ()`, `doSplat()`) and its one-line call after `doClipping()` in `main()`.
`src/materials/shaders/pointcloud.fs` -- `#extension GL_EXT_frag_depth` also under `splat_enabled`, the
`uSplat*` / `vSplat*` declarations, a `gl_FragDepthEXT = gl_FragCoord.z` line (a shader that writes depth must write it on
every path) and the disc block at the end of `main()`.
`src/materials/PointCloudMaterial.js` -- the `uSplat*` entries in `uniforms` (`uSplatColTex` is the same plain
`{width,height,data,version}` descriptor as the ground grids, type `"hagtex"`).
`src/PotreeRenderer.js` -- `flexSplatSpacing()` (typical spacing of a node's class-2 points, once per node, cached on the
geometry node as `_flexSplatSp`), and in `renderOctree()` the `uSplatSp` upload in the node loop plus a block next to the
height-filter uploads that sends the `uSplat*` uniforms and the imagery mosaic (raw GL, LINEAR filter). Everything is
inside `material.defines.get('splat_enabled')`: with the define off (the default) no splat code is compiled, no uniform is
sent, no texture unit is used, and the picture is unchanged.
Why: FLEX's Splat mode (`client/src/modules/splat-mode.js`): ground (class 2 plus points within a band of the height
filter's ground grid) drawn as one disc per point, lying on the local ground plane (normal from the grid's slope), coloured
per pixel from an imagery mosaic; other points as dark green dots, normal, or hidden. The fragment shader intersects the
pixel's ray with the disc plane, discards outside the ellipse, writes the true depth (`gl_FragDepthEXT`) and, with EDL, the
log depth in alpha. The pass stays opaque: FLEX renders with `useHQ = false`, so Potree's two-pass weighted splatting is not
used; the soft edge and the opacity are screen-door discard (opacity noise depends on the pixel only, edge noise on the
disc too, so overlapping discs fill each other's edge). Depth of each disc is pushed back by 0.1 x the node's spacing so
finer discs win over the coarse ones that lie above curved ground. The view matrix is a pure rotation of the world
(= ground-grid) frame, so normals and view offsets go between the two with `mat3(viewMatrix)`; that also holds for
EPSG:3857 clouds whose matrix stretches z.
Re-apply: copy the marked blocks; the GLSL comments must not contain backticks (the shaders are built into a JS template
string). Runtime patch: **no** (the fragment shader, the renderer node loop and the material uniforms are all edited).
Test: kit `tests/test_splat.js` (synthetic laszip EPT); `tools/test_splat_mode.js` for the pure parts.

## Changed by the 1.8.2 move (not FLEX edits, but FLEX relies on them)

* The GPS time attribute is now called `gps-time` on every geometry (it was
  `gpsTime` for EPT in 1.8). `flex.js` line 9221 reads
  `g.attributes['gps-time'] || g.attributes.gpsTime`.
* The old decoder's GPS-time typo fix (`= min` -> `- min`) is no longer needed:
  1.8.2 computes it correctly.
* `fallbackProjection` (second SRS candidate) is gone from the EPT geometry in
  stock 1.8.2; nothing in FLEX used it.
