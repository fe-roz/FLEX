# client/src — FLEX's browser modules

`flex.js` (the main app, one big ES module at the repo root) is being split into
modules here. This file is the recipe: every split follows it, so modules look
alike and the behaviour of the app does not change.

No build step: the page loads `flex.js` as `<script type="module">`, and
`flex.js` imports these files by relative path
(`./client/src/modules/<name>.js`). The same files must also work unchanged in
a bundler (Vite) build, and the pure parts in Node tests.

## The pattern

Each module exports **one setup function** plus **pure named exports**:

```js
// client/src/modules/thing-list.js
export function sortThings(list) { … }            // pure: no DOM, no Cesium, no window

export function setupThingList({ Cesium, cesiumViewer, viewModel, flags, state, renderCaveList }) {
  // everything the section reads comes in through the argument …
  function addThing(x) { … }
  function clearThings() { … }
  if (typeof window !== 'undefined') window._thingList = { addThing, clearThings };   // hooks it defined before
  return { addThing, clearThings };                // … everything others call goes out here
}
```

- **`setupX({ … })`** for a section of flex.js that wires itself to the app;
  **`createX({ … })`** when flex.js may want more than one instance. One
  object argument, named fields, returns the module's API (an object).
- **Libraries are passed in or read from `window`, never imported.** No
  `import * as Cesium from "cesium"`, no import of Potree or three.js. Take
  `Cesium`, `Potree`, `THREE` as fields of the setup argument (flex.js passes
  the globals it uses today). Pure helpers that need a library take it as a
  parameter too.
- **Pure parts are separate exports** (parsers, maths, geometry, formatting):
  no `window`, `document`, `Cesium` or viewer inside them, so `tools/test_*.js`
  can `require()` them in Node.
- **No work at import time.** A module's top level only declares things. All
  imports are evaluated before `flex.js`'s own body runs, so anything done at
  import time would run *earlier* than it does today.
- A module may import another module of this folder (relative path) for its
  pure exports. It never imports `flex.js`. The older modules (`layers.js`,
  `cave-layers.js`, …) now live in this folder too (kebab-case names); flex.js
  imports them and passes them in. Only `flex.js`, `index.html` and the files the
  Node server `require`s (`server.js`, `settings.js`, `library.js`, `mine.js`,
  `caltopo_api.js`, `terrain_generate.js`) stay at the repo root.

## Names and places

- Folder: `client/src/modules/`; sub-folders for a group
  (`navigation-aids/`). File names kebab-case.
- Where a module does the same job as one in the other FLEX branch, it takes
  that name: `cesium-viewer.js`, `potree-viewer.js`, `cesium-interactions.js`,
  `navigation-aids/minimap.js`, `navigation-aids/minimap-sync.js`,
  `navigation-aids/compass.js`, `compass-plt.js`, `potree-pointcloud.js`,
  `cesium-datasources.js`. Ours-only modules use the same style
  (`cave-display.js`, `cave-georef.js`, `ui-misc.js`, …).
- Setup function: `setup` + the file name in CamelCase
  (`compass-plt.js` → `setupCompassPlt`).
- Inside a module, functions keep the names they had in flex.js where other code
  refers to them; a leading `_` may be dropped from the module's own name when
  flex.js re-binds it (`const { pltToCartesian: _pltToCartesian } = …`).

## Moving a section out of flex.js, step by step

1. **Pick a contiguous range** (your brief gives it) and read it whole.
2. **List every top-level name it touches**, with `grep -n` over all of
   `flex.js`, `index.html` and the other modules:
   - functions, `const`s and `let`s it **defines** — who else uses them?
   - names it **reads** that are defined elsewhere in flex.js (functions,
     `const`s, `let`s, imports, `cesiumViewer`, `scene`, `flags`, `viewModel` …);
   - shared `let`s it **writes**;
   - `window._*` hooks it **defines** or **uses**, and DOM ids it looks up;
   - functions that tests pull out of the flex.js *source* (see *Tests that
     read flex.js* below).
3. **Decide each name** by the rules below, then move the code. Change as
   little as possible inside the moved code: same statements, same order; only
   the way it reaches outside names changes.
4. **In flex.js**, import the module at the top with the other imports, and
   put the setup call **exactly where the code used to be**, destructuring the
   API to the old names so call sites stay as they are:
   ```js
   const { addThing, clearThings } = setupThingList({ Cesium, cesiumViewer, viewModel, flags, state: thingState, renderCaveList: _renderCaveList });
   ```
   Leave a two-line comment there saying where the code went.
5. Run the tests (below), and report (below).

### Shared state: the one rule

**A shared `let` stays in flex.js; the module gets an accessor.** A top-level
`let` that is used *outside* the range you move stays declared in flex.js, and
you pass a small object with a getter and setter for it:

```js
// flex.js
let _caveColourMode = 'survey';
const caveDisplayState = {
  get colourMode() { return _caveColourMode; },
  set colourMode(v) { _caveColourMode = v; },
};
… setupCaveDisplay({ …, state: caveDisplayState });

// module
state.colourMode = 'elev';            // writes the flex.js variable
if (state.colourMode === 'depth') …   // reads it live
```

- Group several variables in one accessor object per module (`state`).
- Variables used **only** inside the moved range move into the module as
  plain module-private `let`s inside `setupX`.
- Objects and arrays that are **never reassigned** (`flags`, `caltopoState`,
  `_caveImports`, `viewModel`, the viewers, `scene`) are passed as they are —
  mutating them is shared already; no accessor needed.
- Never copy a `let`'s value into the argument (`{ mode: _caveColourMode }`):
  the module would keep a stale copy.

Why this rule: modules of the same wave are built in parallel and must not
depend on each other; with the state in flex.js every module depends only on
flex.js's wiring. When a later wave finds that one module owns a variable
completely, that variable can move in then.

### Functions in both directions

- Moved code that **calls a function staying in flex.js**: pass it in
  (`renderCaveList: _renderCaveList`). flex.js `function` declarations are
  hoisted, so passing them at setup time is safe.
- If the function is itself a `const` that is set up **later** in flex.js,
  pass a lazy wrapper: `flyToCave: (...a) => _flyToCave(...a)`.
- Code staying in flex.js that **calls a moved function**: the setup returns
  it and flex.js binds it to the old name (step 4).

### Order of execution

flex.js is a top-level-await module: its body runs top to bottom, with
`await`s in between where events, timers and other scripts can run. A moved
section must run at the same point, which is why the setup call goes where
the code was.

One trap: a `function` declaration was hoisted (usable from line 1); a
`const { f } = setupX()` binding is not (using it before that line throws
"Cannot access 'f' before initialization"). Before moving, check whether
anything that runs **before** the section's line calls its functions — at
load time, or from an event handler or timer that can fire during an earlier
`await`. If so, either call setupX earlier (as soon as its arguments exist) or
keep a hoisted forwarder in flex.js. Pure exports are imports, so they are
available everywhere, at once — this is why parsers and maths go there.

### `window._*` hooks

Other files (`index.html`'s inline script, `project.js`, the columns, the
editors, the tests) reach flex.js through `window._*` hooks
(`window._ws`, `window._caveImports`, `window._loadPltRecent`, …). A hook the
moved section defined is **still defined, with the same name, type and
members, at the same moment** — assign it inside `setupX` where the old code
assigned it, or keep the assignment line in flex.js right after the setup call.
Hooks it only uses are read through `window` at call time, as before.

`test_hooks` (browser kit) compares every `window._*` name and type, the
function members of each hook object, and the page's other globals with a
baseline taken before the split. A hook that disappears or changes type fails
it.

### Tests that read flex.js

Some tests pull functions or text out of the flex.js *source*:

- `tools/test_replace_survey.js` grabs `_caveFindStation`,
  `_replaceSurveyPlan`, `_replaceGeoref` and `_jsonCopy` by regex.
- the browser kit's `test_switches` greps flex.js for the Recent-PLT
  `keep-box` checkbox markup;
- every browser kit test rewrites `await Cesium.createWorldTerrainAsync()` in
  **flex.js** to a flat terrain while serving it. Keep that call in flex.js
  (pass the provider into a viewer module) or the tests will fetch real
  terrain.

When you move such code, export it from the module and change the test to
`require()` it (as `test_survey_export.js` does for `parsePLT`); for kit tests,
say so in your report.

## Testing a module

- **Node test for the pure parts:** `tools/test_<module>.js` (plain Node, no
  framework: a small `ok(label, cond, info)` helper, `N passed, M failed`,
  exit 1 on failure). Import with
  `require(path.join(__dirname, '..', 'client', 'src', 'modules', '<name>.js'))`
  (`client/package.json` marks the folder as ES modules; Node loads them with
  `require`). Synthetic data only. Write tests as independent blocks with one
  assertion helper so they can move to Vitest later.
- **Behaviour unchanged:** the browser kit tests that cover the section, plus
  `test_hooks`, plus all `tools/` node tests:
  ```bash
  FLEX=~/w_<name> PORT_BASE=<port> RUN=<name> ~/flex-tests/run.sh -j 6 test_hooks <tests for the section>
  for t in ~/w_<name>/tools/test_*.js; do node "$t" >/dev/null 2>&1 || echo "FAIL $t"; done
  ```
- A quick identity check is worth it for a parser or maths: run the old
  function (from `git show dev:flex.js`) and the module's on the same inputs
  and compare the JSON.

## Reporting

Short, in this order:
- what moved: flex.js line ranges (on `dev`) → module, its exports;
- flex.js line count before / after;
- shared `let`s that now go through an accessor, and anything passed as a lazy
  wrapper or set up earlier than its old line (and why);
- hooks added or changed (should be none changed);
- tests touched outside the module and the test results (pass/fail lines);
- anything the next wave must know (interlocking sections, risky variables);
- the commit hash.

## Modules so far

| Module | From flex.js | Exports |
|---|---|---|
| `modules/compass-plt.js` | UTM → WGS84, Compass PLT parser, PLT → Cartesian3 (wave 0, the template) | `utmToLatLon`, `parsePLT` (pure); `setupCompassPlt({ Cesium })` → `{ pltToCartesian }` |
| `modules/cesium-interactions.js` | mouse-button mapping, SpaceMouse init, input handler, fly speed, key flags, touch fly, fly tick (wave 1) | `getFlagForKeyCode`, `isLatchedFlag`, `clampFlyMult`, `flySpeedMps`, `downloadBlob` (pure); `setupCesiumInteractions({…})` → `{ handler, spaceMouse, getFlyMultiplier, setCameraButtons }` |
| `modules/cave-import.js` | Cave Survey: recents (EPT + PLT), cave sets, wizard, Walls / Breakout loading, anchored / UTM render, replace survey, globe pick, `_displayUpdateRecent` | `jsonCopy`, `escH`, `btnCss`, `georefLabel`, `caveFindStation`, `replaceSurveyPlan`, `replaceGeoref` (pure); `setupCaveImport({ Cesium, cesiumViewer, viewModel, caveImports, state, … })` |
| `modules/cave-georef.js` | Georectification (rectify panel, control points) and the warp | `computeWarpedOffset` (pure); `setupCaveGeoref({ … })` |
| `modules/cave-display.js` | show/hide, the cave list, selection, re-anchor hooks, line/station drawing, colour by, display options | `SURVEY_PALETTE`, `defaultDisplayOptions`, `CAVE_COLOUR_MODES`, `fitColourRange`; `setupCaveDisplay(...)` |
| `modules/cave-passages.js` | passage volumes from LRUDs, section frames | LRUD helpers, frames, spline, `buildBlocky`/`buildSmooth`, `PASSAGE_*`; `setupCavePassages(...)` |
| `modules/cave-leads-labels.js` | lead markers, area labels and their panel, their visibility switches | `setupCaveLeadsLabels(...)` |
| `modules/cave-depth.js` | station points, level frame, ground grids, depth from loaded LiDAR | `caveElevAt`, `lidarGroundAt`; `setupCaveDepth(...)` |
| `modules/cave-utm.js` | UTM placement of caves (`_caveUtmConvertFn`, `_pcDatumDz`) | `latLonToUtm`; `setupCaveUtm(...)` |
| `modules/cave-style-panel.js` | the cave style panel and "one style for every loaded cave" | `setupCaveStylePanel(...)` |
| `modules/compass-dat.js` | Compass `.dat` import: parse (all FORMAT variants, backsights, flags), reduce readings to positions, write local PLT text for the wizard (`isCompassDat`, `parseDat`, `reduceDat`, `datToPlt`); pure | none; Node-tested by `tools/test_compass_dat.js` |
| `modules/*` (older, moved from the repo root) | `api`, `layers`, `session`, `context-menu`, `spacemouse`, `breakout`, `walls`, `cave-layers`, `cave-ground` (ES modules imported by flex.js) and the classic scripts index.html loads in order: `ui-kit`, `icons`, `proxy-url-generator`, `my-data`, `project`, `project-segments`, `project-workspace`, `caltopo-match/send/write/layers`, `projects-panel`, `docs-panel`, `trips`, `sketches`, `selection`, `project-features`, `inspector`, `feature-editor`, `info-panel`, `flex-rail`, `survey-export`, `cave-columns`, `folder-style`, `surface-columns`, `row-menu`, `terrain-patch`, `minimap-view`, `custom-layers`, `globe-watchdog` | unchanged; `survey-export`, `caltopo-match/send/layers`, `terrain-patch` also load under Node in `tools/test_*.js` |
| `page/page-glue.js` | index.html's head script: `copyCoords`, `addEPT`, `addKMZ`, rail/nav-panel toggles | classic script (page wiring, not a feature module) |
| `page/export-ui.js` | the export dialog: bbox/polygon draw, KML polygon, cave collection, LiDAR analysis, progress polling | classic script, window hooks (`_refreshEptDatasets`, …) |
| `page/hag-controls.js` | live HAG filter controls (`#lp-hag-*`) | classic script, calls `window._hag*` |

`page/` holds index.html's former inline scripts as **classic** `<script src>` files at the same place in the page, so they run at parse time exactly as the inline code did (an ES module would be deferred). They are not importable.
| `modules/search-pins.js` | search pins (geocoder result → pin + fly-in), `window._clearSearchPins` | `escapeHtml` (pure); `setupSearchPins(...)` |
| `modules/selection-monitor.js` | floating "Add Point Cloud" button, 100 ms selected-entity watcher | `setupSelectionMonitor(...)` |
| `modules/update-checker.js` | `window._checkForUpdates` | `setupUpdateChecker()` |
| `modules/poi-list.js` | Points of Interest panel list, `window._exportPoi` | `setupPoiList(...)` (called early in flex.js) |
| `modules/workspace-hooks.js` | `window._ws` (project workspace hooks), `_caveGeometry` | `setupWorkspaceHooks(...)` |
| `modules/measure-mode.js` | depth / distance measurement mode (V) | `setupMeasureMode(...)` |
| `modules/html-labels.js` | HTML screen-space label overlay | `setupHtmlLabels(...)` |
| `modules/project-ui-kit.js` … `project-panel.js` | `project.js` split into 8 **classic scripts** (not ES modules: `project.js` is a classic script whose `window._pjApi` must exist while the page is still parsing), loaded in order by `index.html` and sharing functions through a temporary `window._pjParts` that `project.js` (now just the `_pjApi` / `_pjExport` / start glue and the CSS) deletes. `ui-kit`: state `pj`, `el`/`btn`/`when`/`toast`, `dialog`/`choose`; `records`: server calls, author, load/record/replay, `setProject`, archive, banner; `caves`: project caves, stations, notes, leads; `docs`: documents, page viewer, tags; `history`: History/undo, suggestions, sync files; `field`: field survey and lead markers; `card`: station card, Files/History tabs; `panel`: the 📁 panel, new/rename project | none (no ES exports); each fills `window._pjParts` |
| `modules/cesium-datasources.js` | LiDAR footprint sources (USGS boundaries, backend catalog), OpenTopography WMS layer and click-to-query, Data Files list | `setupCesiumDatasources(...)` |
| `modules/caltopo-map.js` | the CalTopo map link (KML and private-map JSON, in-place refresh), status row, key dialog, bookmarklet login | `normalizeCaltopoUrl`, `caltopoMapId`, `caltopoFeatureSig` (pure); `setupCaltopoMap(...)` |
| `modules/layer-list.js` | the Layers panel: section toggle and the manual layer list | `setupLayerList(...)` |
| `modules/potree-pointcloud.js` | `window.addPC` + its interceptor (tracks loaded URLs), the restore-point-clouds banner, the Point Cloud list (wave 2) | `pcNameFromUrl`, `pcUrlKey` (pure); `setupPotreePointcloud({ THREE, Potree, proj4, potreeViewer, viewModel, applyPcMatrix, notifyPcLoaded, saveSession })` → `{ renderPcList, removePc, showPcRestorePrompt, pcUrlByName }` |
| `modules/pointcloud-incidence.js` | Angle of Incidence visualisation (cylinders along the scan angle, flight-path estimate) | `flightLineHue`, `angleHue`, `headingsFromSamples`, `FLIGHT_ALT`, `NADIR_THRESHOLD` (pure); `setupPointcloudIncidence({ THREE, potreeViewer })` → `{ incidenceState, updateIncidenceLines, clearIncidenceLines }` |
| `modules/pointcloud-hag.js` | Height-Above-Ground live filter: ground grids, texture packing, scan, uniforms / define, `window._hag*` | `hagMakeGrid`, `hagTranslate`, `hagAnchor`, `hagShift`, `hagExposed`, `hagWindow`, `hagRepackGrid`, `hagReadCell`, `HAG_*` (pure); `setupPointcloudHag({ potreeViewer })` |
| `modules/entwine-local.js` | Local Entwine server integration (link, picker, start) and `window._entwine*` | `setupEntwineLocal({ ic })` → `{ loadEntwineConfig }` |
| `modules/cesium-viewer.js` | Cesium viewer creation + options, FOV, InfoBox sandbox, scene / globe settings, camera controller, Google 3D tiles, layer activation from session / defaults (wave 3). `await Cesium.createWorldTerrainAsync()` stays in flex.js | `cesiumViewerOptions`, `GLOBE_TRANSLUCENCY`, `DEFAULT_LAYERS` (pure); `setupCesiumViewer`, `setupInfoBox`, `setupCesiumScene`, `setupCameraController`, `addPhotorealisticTileset`, `setupLayerActivation` |
| `modules/potree-viewer.js` | `ClassificationScheme`, `new Potree.Viewer` + settings (`window.potreeViewer`), `applyPcMatrix` | `createClassificationScheme`, `pcMatrixElements` (pure); `setupPotreeViewer({ Potree, flags })`, `createApplyPcMatrix` |
| `modules/render-loop.js` | the per-frame `loop()` (Cesium render, Cesium to Potree camera sync, Potree update / render, incidence, compass, labels, measure) | `potreeCameraHeight`, `potreeFovDegrees`, `incidenceRefreshDue` (pure); `setupRenderLoop(...)` returns `{ loop }`; flex.js calls `requestAnimationFrame(loop)` |
| `modules/session-restore.js` | start-up `setTimeout(0)` restore: point-cloud prompt, CalTopo, data files, My data points, cave / POI visibility, panel sections | `setupSessionRestore(...)` |
| `modules/scene-controls.js` | cave toggle, Scene checkboxes, Point Budget / Detail / Load range / Far cutoff, footprint and Google tiles subscribers | `formatPointBudget`, `formatFarDistance` (pure); `setupSceneControls(...)` |
| `modules/workflow-panel.js` | AOI drawing (`stopAoiDrawMode` …), AOI / process-area styling and catalog, LAN-server connect / disconnect and monitor, queue manager + polling, `updateWorkflowButtons` (registered with api.js), `initWorkflowPanel` (wave 4) | `isAoiGeometry`, `escapeHtml`, `formatDownloadStatus`, `formatIntegrityStatus`, `formatEptStatus` (pure); `setupWorkflowPanel({ Cesium, cesiumViewer, workflowState, backendApi, setText, appendWorkflowLog, setWorkflowActionStatus, setWorkflowBusy, registerUpdateWorkflowButtons, loadBackendCatalog })` returns `{ initWorkflowPanel, updateWorkflowButtons, stopAoiDrawMode, stopWorkflowPolling, refreshServerMonitor, onWorkflowEntitySelected, hideProcessAreaLayer, updateWorkflowSelectionLabels, updateWorkflowPanelVisibility, updateStatusCards }` |
| `modules/jobs-panel.js` (classic script, like `offline-cache.js`) | The Jobs panel along the bottom of the map (doc 23 §1.1): running / waiting / failed jobs, Cancel, Log, Retry, Send now, Recent jobs, a browser notice when a job ends in a background tab. Server jobs (terrain, export, analyze) come from `GET /api/jobs` (`jobs_api.js`; Cancel `POST /api/jobs/<kind>.<id>/cancel`, Log `GET …/log`) and survive a reload; CalTopo edits waiting come from `_ctWrite.pending()` | `fmtElapsed`, `stepOfMessage`, `pillText` (pure, Node-tested by `tools/test_jobs_panel.js`); `window._jobs = { add({ id, kind, name, cancel?, retry?, log?, server? }) → { progress(frac, step), done(note), fail(reason), cancelled(), log(line), waiting(text) }, list, recent, dismiss, showLog, toggle, config }` |
| `modules/units.js` | metric / imperial (Settings → Units, `flex.units` in localStorage), `window._units` (`len`, `dist`, `height`, `climb`, `area`, `duration`, `fmt…`, `set`, `system`), event `flex-units-changed` | classic script, also loads under Node: `make(sys)` (pure formatters); `tools/test_route_stats.js` |
| `modules/route-stats.js` | a line's Route section in the info panel (height graph: terrain + LiDAR ground, steepest stretch, climb / descent, Tobler and Naismith times, points on the way within 10 / 25 / 50 m, start / end connections) and the nearest points / lines to a point; `window._routeStats` | classic script, also loads under Node: `resample`, `climbDescent`, `steepest`, `tobler`, `naismith`, `distToPolyline`, `pointsAlong`, `nearestPoints`, `nearestLines`, `connections`, `timesOf`, `recorded`, `distBrg`, `compassText`; `tools/test_route_stats.js` |
