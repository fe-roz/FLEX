// Points of Interest panel list and the "My points" export (window._exportPoi).
// Moved out of flex.js unchanged (flex.js split, wave 2; see client/src/README.md).
//
// Setup: setupPoiList({ Cesium, cesiumViewer, downloadBlob }) -> { renderPoiList }

export function setupPoiList({ Cesium, cesiumViewer, downloadBlob }) {
  function renderPoiList() {
    const list   = document.getElementById('lp-poi-list');
    const group  = document.getElementById('lp-poi-group');
    const badge  = document.getElementById('lp-poi-count-badge');
    if (!list) return;

    const entities = cesiumViewer.entities.values.filter(
      e => e.properties && e.properties.isUserLabel
    );

    // Update count badge
    if (badge) {
      badge.textContent = entities.length;
      badge.style.display = entities.length ? 'inline' : 'none';
    }
    if (group) group.style.display = entities.length ? 'block' : 'none';

    list.innerHTML = '';
    entities.forEach(entity => {
      const name = (entity.label && entity.label.text && entity.label.text.getValue
        ? entity.label.text.getValue(Cesium.JulianDate.now())
        : entity.label?.text) || entity.id;
      const row = document.createElement('div');
      row.className = 'lp-row';
      row.innerHTML =
        `<span class="lp-row-name" style="font-size:10px;" title="${name}">${name}</span>` +
        `<button class="lp-remove-btn" title="Delete">✕</button>`;
      row.querySelector('.lp-remove-btn').addEventListener('click', () => {
        if (window._myData) window._myData.forgetPoint(entity);
        cesiumViewer.entities.remove(entity);
        renderPoiList();
      });
      list.appendChild(row);
    });
  }

  window._exportPoi = function(format) {
    const entities = new Cesium.EntityCollection();
    cesiumViewer.entities.values
      .filter(e => e.properties && e.properties.isUserLabel)
      .forEach(e => entities.add(e));

    if (format === 'kmz') {
      Cesium.exportKml({ entities, kmz: true })
        .then(r => downloadBlob('points_of_interest.kmz', r.kmz))
        .catch(console.error);
    } else {
      // GeoJSON — build manually from entity positions
      const features = cesiumViewer.entities.values
        .filter(e => e.properties && e.properties.isUserLabel && e.position)
        .map(e => {
          const cart = e.position.getValue(Cesium.JulianDate.now());
          const carto = Cesium.Cartographic.fromCartesian(cart);
          const name = (e.label?.text?.getValue
            ? e.label.text.getValue(Cesium.JulianDate.now())
            : e.label?.text) || '';
          return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [
              Cesium.Math.toDegrees(carto.longitude),
              Cesium.Math.toDegrees(carto.latitude),
              carto.height
            ]},
            properties: { name }
          };
        });
      const geojson = JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
      const blob = new Blob([geojson], { type: 'application/geo+json' });
      downloadBlob('points_of_interest.geojson', blob);
    }
  };

  return { renderPoiList };
}
