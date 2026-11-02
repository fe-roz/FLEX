// HTML screen-space label overlay: projects isUserLabel entity positions to
// screen coordinates each frame and draws them as DOM divs over both canvases.
// Moved out of flex.js unchanged (flex.js split, wave 2; see client/src/README.md).
//
// Setup: setupHtmlLabels({ Cesium, cesiumViewer, notifyPoiVisibilityChanged }) -> { updateHtmlLabels, htmlLabelState }

export function setupHtmlLabels({ Cesium, cesiumViewer, notifyPoiVisibilityChanged }) {

  const htmlLabelState = {
    enabled: true,
    container: document.getElementById('html_label_container'),
    // Map from entity.id → <div> element
    divs: new Map(),
  };

  // Wire POI / HTML labels toggle checkbox
  {
    const toggle = document.getElementById('html_labels_toggle');
    if (toggle) {
      toggle.addEventListener('change', () => {
        htmlLabelState.enabled = toggle.checked;
        notifyPoiVisibilityChanged(toggle.checked);
        if (!htmlLabelState.enabled) {
          // Clear all HTML divs and re-show native Cesium labels
          htmlLabelState.divs.forEach(div => div.remove());
          htmlLabelState.divs.clear();
          cesiumViewer.entities.values.forEach(e => {
            if (e.label && (
              (e.properties && e.properties.isUserLabel) ||
              (e.polyline && e.label)
            )) {
              e.label.show = true;
            }
          });
        }
      });
    }
  }

  function updateHtmlLabels() {
    if (!htmlLabelState.enabled || !htmlLabelState.container) return;

    const scene    = cesiumViewer.scene;
    const entities = cesiumViewer.entities.values;
    const now      = Cesium.JulianDate.now();
    const liveIds  = new Set(); // all entity IDs that should have a label div

    for (const entity of entities) {
      // Match user POI labels (Z/X/C) AND route labels (have label but no isUserLabel)
      if (!entity.label) continue;
      const isUserPoi   = entity.properties && entity.properties.isUserLabel;
      const isRoutLabel = entity.polyline && entity.label; // route entities have polyline + label
      if (!isUserPoi && !isRoutLabel) continue;
      if (!entity.position) continue;

      // Always suppress native Cesium label when HTML mode is on
      entity.label.show = false;

      liveIds.add(entity.id);
      if (entity.show === false) {                      // hidden (📍 Surface: a sitting's points switched off)
        const div = htmlLabelState.divs.get(entity.id);
        if (div) div.style.display = 'none';
        continue;
      }

      const worldPos = entity.position.getValue(now);
      if (!worldPos) continue;

      // Project to canvas coords — cartesianToCanvasCoordinates returns null if behind camera
      const screenPos = scene.cartesianToCanvasCoordinates(worldPos);
      if (!screenPos) {
        const div = htmlLabelState.divs.get(entity.id);
        if (div) div.style.display = 'none';
        continue;
      }

      // Off-screen cull (with margin so labels near edges don't pop)
      const margin = 60;
      if (screenPos.x < -margin || screenPos.x > window.innerWidth  + margin ||
          screenPos.y < -margin || screenPos.y > window.innerHeight + margin) {
        const div = htmlLabelState.divs.get(entity.id);
        if (div) div.style.display = 'none';
        continue;
      }

      // Create div on first appearance
      let div = htmlLabelState.divs.get(entity.id);
      if (!div) {
        div = document.createElement('div');
        div.className = 'html-label';
        const text = entity.label.text && entity.label.text.getValue
          ? entity.label.text.getValue(now)
          : (entity.label.text || entity.name || '');
        div.textContent = text;
        htmlLabelState.container.appendChild(div);
        htmlLabelState.divs.set(entity.id, div);
      }

      div.style.display = 'block';
      div.style.left    = Math.round(screenPos.x) + 'px';
      div.style.top     = Math.round(screenPos.y) + 'px';
    }

    // Remove divs for entities that have been deleted from the scene
    for (const [id, div] of htmlLabelState.divs) {
      if (!liveIds.has(id)) {
        div.remove();
        htmlLabelState.divs.delete(id);
      }
    }
  }

  return { updateHtmlLabels, htmlLabelState };
}
