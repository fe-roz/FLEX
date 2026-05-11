/**
 * layers.js — Layer catalog and Knockout-bound viewModel.
 *
 * All imagery layers are managed through a two-tier system:
 *   LAYER_CATALOG  — the full set of available layers (never all loaded at once)
 *   active layers  — whatever is currently in cesiumViewer.imageryLayers
 *
 * flex.js decides which catalog entries are "active" (added to Cesium) based on
 * the saved session or the hardcoded defaults.  UI render + add/remove also live
 * in flex.js.  This module only owns the catalog definition and the low-level
 * Cesium add/remove helpers.
 */

// ---------------------------------------------------------------------------
// Reference set once by loadLayers()
// ---------------------------------------------------------------------------

let imageryLayers = null;

// ---------------------------------------------------------------------------
// viewModel — Knockout-tracked state for the layer toolbar
// ---------------------------------------------------------------------------

export const viewModel = {
  showlidar:    false,
  googleMapsOn: false,
  usgsRef:      false,
  layers:       [],   // active ImageryLayer objects, top → bottom order

  raise: function (layer) {
    imageryLayers.raise(layer);
    updateLayerList();
  },
  lower: function (layer) {
    imageryLayers.lower(layer);
    updateLayerList();
  },
  canRaise: function (layerIndex) {
    return layerIndex > 0;
  },
  canLower: function (layerIndex) {
    return layerIndex >= 0 && layerIndex < imageryLayers.length - 1;
  }
};

// ---------------------------------------------------------------------------
// Layer catalog — full set of available layers (not all active by default)
// ---------------------------------------------------------------------------

const layerCatalog = [];
export { layerCatalog as LAYER_CATALOG };

function buildLayerCatalog() {
  layerCatalog.splice(0, layerCatalog.length);
  layerCatalog.push(
    // ── Base maps ──────────────────────────────────────────────────────────
    {
      name:  "Bing Maps Aerial",
      alpha: 1.0,
      createProvider: () => Cesium.createWorldImageryAsync()
    },
    {
      name:  "Bing Maps Road",
      alpha: 1.0,
      createProvider: () =>
        Cesium.createWorldImageryAsync({
          style: Cesium.IonWorldImageryStyle.ROAD
        })
    },
    {
      name:  "ArcGIS World Street Maps",
      alpha: 1.0,
      createProvider: () =>
        Cesium.ArcGisMapServerImageryProvider.fromUrl(
          "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer"
        )
    },
    {
      name:  "OpenStreetMaps",
      alpha: 1.0,
      createProvider: () => new Cesium.OpenStreetMapImageryProvider()
    },
    {
      name:  "USGS Shaded Relief",
      alpha: 1.0,
      createProvider: () =>
        new Cesium.WebMapTileServiceImageryProvider({
          url:             "https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/WMTS",
          layer:           "USGSShadedReliefOnly",
          style:           "default",
          format:          "image/jpeg",
          tileMatrixSetID: "default028mm",
          maximumLevel:    19,
          credit:          "U. S. Geological Survey"
        })
    },
    // ── Overlays ───────────────────────────────────────────────────────────
    {
      name:  "Slope Angle",
      alpha: 1.0,
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: new Cesium.Resource({
            url:   "https://caltopo.com/tile/sg/{z}/{x}/{y}.png",
            proxy: new Cesium.DefaultProxy("/proxy?url=")
          }),
          tilingScheme: new Cesium.WebMercatorTilingScheme(),
          maximumLevel: 18
        })
    },
    {
      name:  "US Karst Map",
      alpha: 1.0,
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url:          "https://tiles.arcgis.com/tiles/hoKRg7d6zCP8hwp2/arcgis/rest/services/Carbonate_Karst/MapServer/tile/{z}/{y}/{x}?blankTile=false",
          tilingScheme: new Cesium.WebMercatorTilingScheme(),
          maximumLevel: 18
        })
    },
    {
      name:  "Roads & Trails (OSM)",
      alpha: 0.6,
      // OSM tiles are CORS-enabled — no proxy needed.
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url:          "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          tilingScheme: new Cesium.WebMercatorTilingScheme(),
          maximumLevel: 19,
          credit:       "© OpenStreetMap contributors"
        })
    },
    {
      name:  "NGMDB Mosaic",
      alpha: 1.0,
      createProvider: () => {
        const base = "https://ngmdb-tiles.usgs.gov/arcgis/rest/services/mapview/ngmdbMosaic/ImageServer/exportImage";
        return new Cesium.UrlTemplateImageryProvider({
          customTags: {
            ngmdbProxy: (imageryProvider, x, y, level) => {
              const tilingScheme = imageryProvider.tilingScheme;
              const rect = tilingScheme.tileXYToNativeRectangle(x, y, level);
              return base +
                "?f=image" +
                "&bbox="    + rect.west + "," + rect.south + "," + rect.east + "," + rect.north +
                "&bboxSR=102100&imageSR=102100&size=512,512" +
                "&format=jpgpng" +
                '&mosaicRule={"ascending":true}';
            }
          },
          url:               "/proxy?url={ngmdbProxy}",
          tilingScheme:      new Cesium.WebMercatorTilingScheme(),
          tileWidth:         512,
          tileHeight:        512,
          maximumLevel:      12,
          enablePickFeatures: false
        });
      }
    },
    {
      name:  "Snow Depth",
      alpha: 1.0,
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url:          "https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer/export?bbox={westProjected}%2C{southProjected}%2C{eastProjected}%2C{northProjected}&bboxSR=102100&imageSR=102100&format=png32&transparent=true&layers=show%3A3&f=image",
          maximumLevel: 15
        })
    },
    {
      name:  "Sentinel-2 Cloudless 2023",
      alpha: 1.0,
      createProvider: () =>
        new Cesium.WebMapServiceImageryProvider({
          url: new Cesium.Resource({
            url:   "https://tiles.maps.eox.at/wms",
            proxy: new Cesium.DefaultProxy("/proxy?url=")
          }),
          layers:     "s2cloudless-2023",
          parameters: { format: "image/jpeg", transparent: "false" },
          maximumLevel: 15,
          credit: "EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2023)"
        })
    }
  );
}

// ---------------------------------------------------------------------------
// Layer list helpers
// ---------------------------------------------------------------------------

function updateLayerList() {
  const n = imageryLayers.length;
  viewModel.layers.splice(0, viewModel.layers.length);
  // Push highest index first so viewModel.layers[0] = topmost (rendered last)
  for (let i = n - 1; i >= 0; --i) {
    viewModel.layers.push(imageryLayers.get(i));
  }
}

/**
 * Internal: create a provider, add to imageryLayers, Knockout-track the layer.
 * Returns the ImageryLayer, or null on failure.
 */
async function addLayerOption(name, imageryProviderPromise, alpha, show) {
  try {
    const imageryProvider = await Promise.resolve(imageryProviderPromise);
    const layer = imageryLayers.addImageryProvider(imageryProvider);
    layer.alpha = Cesium.defaultValue(alpha, 1.0);
    layer.show  = Cesium.defaultValue(show,  true);
    layer.name  = name;
    Cesium.knockout.track(layer, ["alpha", "show", "name"]);
    updateLayerList();
    return layer;
  } catch (error) {
    console.error(`[layers] error creating "${name}": ${error}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * loadLayers() — removes Cesium's auto-added default imagery layer and builds
 * the catalog.  Does NOT add any active layers — flex.js is responsible for
 * deciding which catalog entries to activate (based on saved session or defaults).
 */
export async function loadLayers() {
  imageryLayers = cesiumViewer.imageryLayers;

  // Remove whatever default layer Cesium added (typically Bing via Ion token).
  while (imageryLayers.length > 0) {
    imageryLayers.remove(imageryLayers.get(0), false /* don't destroy */);
  }

  buildLayerCatalog();
}

/**
 * addCatalogLayer(name, show, alpha)
 * Looks up a catalog entry by name, creates its provider, and adds it to the
 * active Cesium imagery stack.  Returns the ImageryLayer or null on failure.
 * Safe to call if the layer is already active — returns the existing layer.
 */
export async function addCatalogLayer(name, show = true, alpha = 1.0) {
  const def = layerCatalog.find(d => d.name === name);
  if (!def) {
    console.warn('[layers] Unknown catalog layer:', name);
    return null;
  }
  // Return existing layer if already active
  for (let i = 0; i < imageryLayers.length; i++) {
    if (imageryLayers.get(i).name === name) return imageryLayers.get(i);
  }
  return addLayerOption(name, def.createProvider(), alpha, show);
}

/**
 * removeCatalogLayer(layer)
 * Removes an active ImageryLayer from the Cesium stack and updates viewModel.
 */
export function removeCatalogLayer(layer) {
  if (!imageryLayers || !layer) return;
  imageryLayers.remove(layer, true /* destroy provider */);
  updateLayerList();
}

export { updateLayerList };
