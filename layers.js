/**
 * layers.js — Layer catalog, base/overlay management, and Knockout-bound viewModel.
 *
 * Extracted from flex.js.  Provides the imagery layer definitions, the
 * viewModel that drives the toolbar layer UI, and helper functions for
 * adding / switching layers on the Cesium viewer.
 */

// ---------------------------------------------------------------------------
// References set once by initLayers()
// ---------------------------------------------------------------------------

let imageryLayers = null;
let baseLayers = null;

// ---------------------------------------------------------------------------
// viewModel — Knockout-tracked state for the layer toolbar
// ---------------------------------------------------------------------------

export const viewModel = {
  showlidar: false,
  googleMapsOn: false,
  usgsRef: false,
  layers: [],
  baseLayers: [],
  upLayer: null,
  downLayer: null,
  selectedLayer: null,
  isSelectableLayer: function (layer) {
    return this.baseLayers.indexOf(layer) >= 0;
  },
  raise: function (layer, index) {
    imageryLayers.raise(layer);
    viewModel.upLayer = layer;
    var v = index - 1;
    if (v < 0) {
      v = 0;
    }
    viewModel.downLayer = viewModel.layers[v];
    updateLayerList();
    window.setTimeout(function () {
      viewModel.upLayer = viewModel.downLayer = null;
    }, 10);
  },
  lower: function (layer, index) {
    imageryLayers.lower(layer);
    var v = viewModel.layers.length - 1;
    if (viewModel.layers.length - 1 > index + 1) {
      v = index + 1;
    }
    viewModel.upLayer = viewModel.layers[v];
    viewModel.downLayer = layer;
    updateLayerList();
    window.setTimeout(function () {
      viewModel.upLayer = viewModel.downLayer = null;
    }, 10);
  },
  canRaise: function (layerIndex) {
    return layerIndex > 0;
  },
  canLower: function (layerIndex) {
    return layerIndex >= 0 && layerIndex < imageryLayers.length - 1;
  }
};

// ---------------------------------------------------------------------------
// Layer catalog
// ---------------------------------------------------------------------------

const layerCatalog = [];

function buildLayerCatalog() {
  layerCatalog.splice(0, layerCatalog.length);
  layerCatalog.push(
    {
      name: "Bing Maps Aerial",
      kind: "base",
      createProvider: () => Cesium.createWorldImageryAsync()
    },
    {
      name: "Bing Maps Road",
      kind: "base",
      createProvider: () =>
        Cesium.createWorldImageryAsync({
          style: Cesium.IonWorldImageryStyle.ROAD
        })
    },
    {
      name: "ArcGIS World Street Maps",
      kind: "base",
      createProvider: () =>
        Cesium.ArcGisMapServerImageryProvider.fromUrl(
          "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer"
        )
    },
    {
      name: "OpenStreetMaps",
      kind: "base",
      createProvider: () => new Cesium.OpenStreetMapImageryProvider()
    },
    {
      name: "Stamen Maps",
      kind: "base",
      createProvider: () =>
        new Cesium.OpenStreetMapImageryProvider({
          url: "https://stamen-tiles.a.ssl.fastly.net/watercolor/",
          fileExtension: "jpg",
          credit:
            "Map tiles by Stamen Design, under CC BY 3.0. Data by OpenStreetMap, under CC BY SA."
        })
    },
    {
      name: "Natural Earth II (local)",
      kind: "base",
      createProvider: () =>
        Cesium.TileMapServiceImageryProvider.fromUrl(
          Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII")
        )
    },
    {
      name: "USGS Shaded Relief (via WMTS)",
      kind: "base",
      createProvider: () =>
        new Cesium.WebMapTileServiceImageryProvider({
          url:
            "https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/WMTS",
          layer: "USGSShadedReliefOnly",
          style: "default",
          format: "image/jpeg",
          tileMatrixSetID: "default028mm",
          maximumLevel: 19,
          credit: "U. S. Geological Survey"
        })
    },
    // --- Overlays -----------------------------------------------------------
    {
      name: "Slope Angle",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: new Cesium.Resource({
            url: "https://caltopo.com/tile/sg/{z}/{x}/{y}.png",
            proxy: new Cesium.DefaultProxy("/proxy?url=")
          }),
          tilingScheme: new Cesium.WebMercatorTilingScheme(),
          maximumLevel: 18
        })
    },
    {
      name: "US Karst Map",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: "https://tiles.arcgis.com/tiles/hoKRg7d6zCP8hwp2/arcgis/rest/services/Carbonate_Karst/MapServer/tile/{z}/{y}/{x}?blankTile=false",
          tilingScheme: new Cesium.WebMercatorTilingScheme(),
          maximumLevel: 18
        })
    },
    {
      name: "OpenTopo datasets",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: "https://portal.opentopography.org/geoserver/OPENTOPO/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&FORMAT=image%2Fpng&TRANSPARENT=true&STYLES&LAYERS=OPENTOPO%3Adatasets_view&CQL_FILTER=is_global%20%3D%20false&SRS=EPSG%3A4326&WIDTH=256&HEIGHT=256&BBOX={westProjected}%2C{southProjected}%2C{eastProjected}%2C{northProjected}",
          tilingScheme: new Cesium.GeographicTilingScheme(),
          enablePickFeatures: false,
          pickFeaturesUrl: "https://portal.opentopography.org/geoserver/OPENTOPO/wms?0=C&1=Q&2=L&3=_&4=F&5=I&6=L&7=T&8=E&9=R&10=%20&11=%3D&12=%20&13=i&14=s&15=_&16=g&17=l&18=o&19=b&20=a&21=l&22=%20&23=%3D&24=%20&25=f&26=a&27=l&28=s&29=e&service=WMS&version=1.1.1&request=GetFeatureInfo&layers=OPENTOPO%3Adatasets_view&BBOX={westProjected}%2C{southProjected}%2C{eastProjected}%2C{northProjected}&width=256&height=256&srs=EPSG%3A4326&query_layers=OPENTOPO%3Adatasets_view&info_format=application%2Fjson&x={i}&y={j}",
          maximumLevel: 18
        })
    },
    {
      name: "NGMDB Mosaic",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () => {
        // NGMDB ImageServer uses exportImage (not a tiled service).
        // We build each tile URL manually and route through the local
        // CORS proxy so the browser can load the images.
        const base = "https://ngmdb-tiles.usgs.gov/arcgis/rest/services/mapview/ngmdbMosaic/ImageServer/exportImage";
        return new Cesium.UrlTemplateImageryProvider({
          customTags: {
            ngmdbProxy: (imageryProvider, x, y, level) => {
              const tilingScheme = imageryProvider.tilingScheme;
              const rect = tilingScheme.tileXYToNativeRectangle(x, y, level);
              const targetUrl = base +
                "?f=image" +
                "&bbox=" + rect.west + "," + rect.south + "," + rect.east + "," + rect.north +
                "&bboxSR=102100&imageSR=102100&size=512,512" +
                "&format=jpgpng" +
                '&mosaicRule={"ascending":true}';
              return targetUrl;
            }
          },
          url: "/proxy?url={ngmdbProxy}",
          tilingScheme: new Cesium.WebMercatorTilingScheme(),
          tileWidth: 512,
          tileHeight: 512,
          maximumLevel: 12,
          enablePickFeatures: false
        });
      }
    },
    {
      name: "Snow Depth",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: "https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer/export?bbox={westProjected}%2C{southProjected}%2C{eastProjected}%2C{northProjected}&bboxSR=102100&imageSR=102100&format=png32&transparent=true&layers=show%3A3&f=image",
          maximumLevel: 15
        })
    },
    {
      name: "Tile Coordinates",
      kind: "overlay",
      alpha: 1.0,
      show: false,
      createProvider: () => new Cesium.TileCoordinatesImageryProvider()
    }
  );
}

// ---------------------------------------------------------------------------
// Layer list helpers
// ---------------------------------------------------------------------------

function updateLayerList() {
  const numLayers = imageryLayers.length;
  viewModel.layers.splice(0, viewModel.layers.length);
  for (let i = numLayers - 1; i >= 0; --i) {
    viewModel.layers.push(imageryLayers.get(i));
  }
}

async function addBaseLayerOption(name, imageryProviderPromise) {
  try {
    const imageryProvider = await Promise.resolve(imageryProviderPromise);
    const layer = new Cesium.ImageryLayer(imageryProvider);
    layer.name = name;
    baseLayers.push(layer);
    updateLayerList();
  } catch (error) {
    console.error(`There was an error while creating ${name}. ${error}`);
  }
}

async function addLayerOption(name, imageryProviderPromise, alpha, show) {
  try {
    const imageryProvider = await Promise.resolve(imageryProviderPromise);
    const layer = imageryLayers.addImageryProvider(imageryProvider);
    layer.alpha = Cesium.defaultValue(alpha, 0.5);
    layer.show = Cesium.defaultValue(show, true);
    layer.name = name;
    Cesium.knockout.track(layer, ["alpha", "show", "name"]);
    updateLayerList();
  } catch (error) {
    console.error(`There was an error while creating ${name}. ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Async layer loading — kicks off all provider creation.  Safe to call
 * fire-and-forget; individual layer failures are caught and logged.
 *
 * Must be called after cesiumViewer exists and after
 * Cesium.knockout.track(viewModel) has been called.
 */
export async function loadLayers() {
  imageryLayers = cesiumViewer.imageryLayers;
  baseLayers = viewModel.baseLayers;

  buildLayerCatalog();

  const promises = layerCatalog.map((layerDef) => {
    if (layerDef.kind === "base") {
      return addBaseLayerOption(layerDef.name, layerDef.createProvider());
    }
    return addLayerOption(
      layerDef.name,
      layerDef.createProvider(),
      layerDef.alpha,
      layerDef.show
    );
  });
  await Promise.allSettled(promises);
}

export { updateLayerList };
