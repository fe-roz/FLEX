# Third-party software in FLEX

FLEX ships some libraries inside the repo and loads others from a CDN at run
time. Each is used under its own licence, listed here. A vendored file keeps
its original licence header; folders with a `LICENSE` file keep it beside the
code.

## Vendored in `viewer_build/libs/` (the portable viewer, FLEX Field, and parts of desktop FLEX)

| Library | Version | Licence | Source | Files |
|---|---|---|---|---|
| three.js | r128 | MIT | https://github.com/mrdoob/three.js | `three.min.js` |
| three.js OrbitControls | r128 | MIT | https://github.com/mrdoob/three.js (`examples/js/controls/`) | `OrbitControls.js` |
| three.js GLTFLoader | r128 | MIT | https://github.com/mrdoob/three.js (`examples/js/loaders/`) | `GLTFLoader.js` |
| JSZip | 3.10.1 | MIT or GPL-3.0 (dual; used under MIT) | https://github.com/Stuk/jszip | `jszip.min.js` |
| UTIF.js | 3.1.0 | MIT | https://github.com/photopea/UTIF.js | `utif.js` |
| pako (inflate build) | 2.2.0 | MIT and Zlib | https://github.com/nodeca/pako | `pako_inflate.min.js` |

`viewer_build/libs/flexlib.js` is FLEX's own code.

## Vendored in `PotreeCopied/` (a copy of Potree)

| Library | Version | Licence | Source | Files |
|---|---|---|---|---|
| Potree | 1.8.2 (stock, plus FLEX's own edits listed in `PotreeCopied/FLEX_PATCHES.md`) | BSD-2-Clause | https://github.com/potree/potree | `PotreeCopied/` (licence: `PotreeCopied/LICENSE`) |

Potree bundles further libraries in `PotreeCopied/libs/`, each with its licence
file in its own folder. The ones desktop FLEX loads (`index.html`):

| Library | Version | Licence | Source | Files |
|---|---|---|---|---|
| jQuery | 3.1.1 | MIT | https://jquery.com | `libs/jquery/` |
| jQuery UI | 1.12.1 | MIT | https://jqueryui.com | `libs/jquery-ui/` |
| Spectrum colour picker | 1.8.0 | MIT | https://github.com/bgrins/spectrum | `libs/spectrum/` |
| BinaryHeap (Eloquent JavaScript) | 2013 | MIT | https://eloquentjavascript.net | `libs/other/BinaryHeap.js` |
| tween.js | 0.15.0 | MIT | https://github.com/tweenjs/tween.js | `libs/tween/` |
| D3 | 3.5.5 | BSD-3-Clause | https://github.com/d3/d3 | `libs/d3/` |
| proj4js | 2.6.2 | MIT | https://github.com/proj4js/proj4js | `libs/proj4/` |
| OpenLayers | 3.11.2 | BSD-2-Clause | https://openlayers.org | `libs/openlayers3/` (the minimap) |
| i18next | 1.8.0 | MIT | https://www.i18next.com | `libs/i18next/` |
| jsTree | 3.3.8 | MIT | https://www.jstree.com | `libs/jstree/` |
| plasio laslaz.js | — | MIT | https://github.com/verma/plasio | `libs/plasio/` |
| copc.js + laz-perf (COPC and LAZ decoding, bundled into Potree 1.8.2) | as shipped in Potree 1.8.2 | MIT (copc.js); laz-perf: check upstream | https://github.com/connormanning/copc.js | `libs/copc/` |
| three.js (Potree's copy) | r124 | MIT | https://github.com/mrdoob/three.js | `libs/three.js/` |
| CesiumJS (Potree's copy; FLEX uses its `Widgets/widgets.css`) | — | Apache-2.0 | https://github.com/CesiumGS/cesium | `libs/Cesium/` |

## Loaded from a CDN at run time (not in the repo)

| Library | Version | Licence | Loaded from | Used by |
|---|---|---|---|---|
| CesiumJS | 1.122 | Apache-2.0 | https://cesium.com/downloads/cesiumjs/releases/1.122/ | `index.html` (the globe) |
| Cesium Sandcastle `bucket.css` | — | Apache-2.0 | https://sandcastle.cesium.com/templates/bucket.css | `index.html` (page base style) |
| Bootstrap (CSS and JS) | 4.0.0 | MIT | https://cdn.jsdelivr.net/npm/bootstrap@4.0.0/ | `index.html` |
| Popper.js | 1.12.9 | MIT | https://cdn.jsdelivr.net/npm/popper.js@1.12.9/ | `index.html` (for Bootstrap) |
| jQuery (slim) | 3.2.1 | MIT | https://code.jquery.com/ | `index.html` (for Bootstrap) |
| egm96-universal | 1.1.1 | MIT | https://esm.sh/egm96-universal@1.1.1 (https://github.com/nicolas-van/egm96-universal) | `flex.js` (EGM96 geoid heights) |
| PDF.js | 3.11.174 | Apache-2.0 | https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/ | `project.js` (document pages) |
| JSZip | 3.10.1 | MIT or GPL-3.0 | https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/ | `project.js` (fallback when the vendored copy is missing); `export_terrain.py` fetches it into `viewer_build/libs/` if absent |

`export_terrain.py` likewise fetches three.js r128, OrbitControls and
GLTFLoader from https://cdn.jsdelivr.net/npm/three@0.128.0/ only when the
vendored copies are missing.

## Node packages (`package.json`, installed by `npm install`)

| Package | Licence | Source |
|---|---|---|
| cesium | Apache-2.0 | https://github.com/CesiumGS/cesium |
| http-proxy | MIT | https://github.com/http-party/node-http-proxy |
| potree (npm) | BSD-2-Clause | https://www.npmjs.com/package/potree |

## Icons

`icons.js` holds FLEX's line icons. They follow the style of Lucide
(https://lucide.dev, ISC licence: 24-unit grid, stroke 1.5); the shapes are
drawn for FLEX.

## Map data

Map layers (imagery, topographic and geology maps, terrain, LiDAR) are fetched
from their providers at run time and are not part of FLEX. Each provider's own
terms of use apply.
