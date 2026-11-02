// The Layers panel: the section toggle (window._lpToggle) and the manual layer
// list (viewModel.layers -> rows with show switch, opacity, remove, drag to
// reorder, "+ Add layer" picker). Moved out of flex.js unchanged (the flex.js
// split, wave 2; see client/src/README.md).
//
// Setup:
//   setupLayerList({ Cesium, viewModel, LAYER_CATALOG, addCatalogLayer, removeCatalogLayer,
//                    updateLayerList, saveSession, notifyPanelSectionToggled })
//     -> { subscribeLayerToSession, renderLayerList }
//
// Hooks defined here: window._lpToggle, window._renderLayerList, window._updateLayerList.

export function setupLayerList({
  Cesium, viewModel, LAYER_CATALOG, addCatalogLayer, removeCatalogLayer,
  updateLayerList, saveSession, notifyPanelSectionToggled,
} = {}) {
  if (!Cesium) throw new Error('layer-list: Cesium missing');

// ── Layers Panel ──────────────────────────────────────────────────────────────

/** Toggle a .lp-section-body open/closed */
window._lpToggle = function(headerEl) {
  const body  = headerEl.nextElementSibling;
  const arrow = headerEl.querySelector('.lp-section-arrow');
  const open  = body.classList.toggle('open');
  if (arrow) arrow.style.transform = open ? '' : 'rotate(-90deg)';
  // Persist collapse state if this section has an ID
  if (body.id) notifyPanelSectionToggled(body.id, open);
};

// ── Overlay drag-and-drop ─────────────────────────────────────────────────────

// ── Layer list (fully manual render — no Knockout foreach) ───────────────────
// viewModel.layers[] is the source of truth. We own the DOM and sync back.

/**
 * Wire a freshly-added ImageryLayer to the session save system.
 * Must be called once per layer after addCatalogLayer() resolves.
 */
function subscribeLayerToSession(layer) {
  if (!layer?.name) return;
  Cesium.knockout.getObservable(layer, 'show')?.subscribe(() => saveSession());
  Cesium.knockout.getObservable(layer, 'alpha')?.subscribe(() => saveSession());
}

window._renderLayerList = () => renderLayerList();
window._updateLayerList = updateLayerList;
function renderLayerList() {
  const body = document.getElementById('lp-layers-body');
  if (!body) return;
  body.innerHTML = '';

  // All active layers in one flat list (top → bottom in viewModel order).
  const active = viewModel.layers.filter(l => l.name);

  // ── Mouse-event drag state ─────────────────────────────────────────────
  // We use mousedown → document mousemove/mouseup instead of the HTML5 DnD
  // API because Cesium's event handling disrupts native drag events.
  let _dragSrcIdx = null;
  let _dragGhost  = null;
  let _isDragging = false;
  let _dragStartY = 0;

  // Rows get a secondary class so we can find only layer rows (not other
  // .lp-row elements that appear in the panel for other sections).
  const LP_ROW_CLS = 'lp-layer-row';
  const _lrows = () => Array.from(body.querySelectorAll('.' + LP_ROW_CLS));

  function _cleanupDrag() {
    if (_dragGhost) { _dragGhost.remove(); _dragGhost = null; }
    _lrows().forEach(r => { r.style.opacity = ''; r.classList.remove('lp-drag-over'); });
    _dragSrcIdx = null;
    _isDragging = false;
    document.removeEventListener('mousemove', _onDragMove);
    document.removeEventListener('mouseup',   _onDragUp);
  }

  function _onDragMove(e) {
    if (_dragSrcIdx === null) return;
    if (!_isDragging) {
      if (Math.abs(e.clientY - _dragStartY) < 4) return;  // 4px dead zone
      _isDragging = true;
      const rs = _lrows();
      if (rs[_dragSrcIdx]) rs[_dragSrcIdx].style.opacity = '0.35';
    }
    if (_dragGhost) {
      _dragGhost.style.left = (e.clientX + 14) + 'px';
      _dragGhost.style.top  = (e.clientY - 10) + 'px';
    }
    // Highlight the row closest to the cursor
    const rs = _lrows();
    rs.forEach(r => r.classList.remove('lp-drag-over'));
    let best = null, bestDist = Infinity;
    for (const r of rs) {
      const rect = r.getBoundingClientRect();
      const dist = Math.abs(e.clientY - (rect.top + rect.height / 2));
      if (dist < bestDist) { bestDist = dist; best = r; }
    }
    if (best) best.classList.add('lp-drag-over');
  }

  function _onDragUp(e) {
    const srcIdx      = _dragSrcIdx;
    const wasDragging = _isDragging;
    // Read row positions BEFORE cleanupDrag wipes state
    const rs = _lrows();
    let targetIdx = null, bestDist = Infinity;
    for (let j = 0; j < rs.length; j++) {
      const rect = rs[j].getBoundingClientRect();
      const dist = Math.abs(e.clientY - (rect.top + rect.height / 2));
      if (dist < bestDist) { bestDist = dist; targetIdx = j; }
    }
    _cleanupDrag();
    if (!wasDragging || srcIdx === null || targetIdx === null || targetIdx === srcIdx) return;
    const movedLayer = active[srcIdx];
    const steps = targetIdx - srcIdx;
    if (steps < 0) {
      for (let s = 0; s < -steps; s++) viewModel.raise(movedLayer);
    } else {
      for (let s = 0; s < steps; s++) viewModel.lower(movedLayer);
    }
    saveSession();
    renderLayerList();
  }
  // ── End of drag state setup ────────────────────────────────────────────

  active.forEach((layer, i) => {
    const row = document.createElement('div');
    row.className = 'lp-row ' + LP_ROW_CLS;
    row.style.cssText = 'display:flex; align-items:center; padding:2px 0; gap:4px;';

    // ⠿ drag handle (visual affordance only — the whole row is draggable)
    const handle = document.createElement('span');
    handle.textContent = '⠿';
    handle.className = 'lp-drag-handle';
    handle.style.userSelect = 'none';
    handle.title = 'Drag to reorder';

    // Visibility switch (ui_kit.js)
    const chk = window.uiSwitch(!!layer.show, on => { layer.show = on; }, null, { small: true });
    chk.setAttribute('aria-label', 'Show ' + layer.name);

    // Name label
    const nameSpan = document.createElement('span');
    const ctl = layer._custom && layer._custom.owner === 'c';      // from the CalTopo map (caltopo_layers.js): a line icon, read-only
    if (ctl && window.icon) { nameSpan.innerHTML = window.icon('map', 12, 'lp-ct-ico'); nameSpan.appendChild(document.createTextNode(' ' + layer.name)); }
    else window.iconLabel(nameSpan, layer._custom ? [layer._custom.owner === 'p' ? 'folder' : 'user', layer.name] : layer.name);
    if (layer._custom) nameSpan.title = ctl ? 'From the CalTopo map (change or remove it in CalTopo)' : layer._custom.owner === 'p' ? 'Part of the project' : 'In My data';
    if (layer._custom && layer._custom.warn) { const w = document.createElement('span'); w.className = 'lp-warn'; w.textContent = ' no tiles'; w.style.color = '#fc6'; nameSpan.appendChild(w); nameSpan.title += '. ' + layer._custom.warn; }
    nameSpan.style.cssText = 'flex:1; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';

    // Opacity slider
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0'; slider.max = '1'; slider.step = '0.01';
    slider.value = String(layer.alpha ?? 1);
    slider.style.cssText = 'width:62px; flex-shrink:0;';
    slider.addEventListener('input', () => { layer.alpha = parseFloat(slider.value); });

    // × Remove button
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove from active layers';
    removeBtn.style.cssText = 'background:none; border:none; cursor:pointer; color:rgba(255,100,100,0.65); font-size:15px; flex-shrink:0; padding:0 2px; line-height:1;';
    if (layer._custom && layer._custom.owner === 'c') { removeBtn.title = 'Part of the CalTopo map: remove it there'; removeBtn.style.visibility = 'hidden'; }   // read-only: no ✕ (space kept so sliders line up)
    removeBtn.addEventListener('mouseenter', () => { removeBtn.style.color = 'rgba(255,60,60,1)'; });
    removeBtn.addEventListener('mouseleave', () => { removeBtn.style.color = 'rgba(255,100,100,0.65)'; });
    removeBtn.addEventListener('click', () => {
      if (layer._custom && window._customLayers) { window._customLayers.removeById(layer._custom.id); return; }
      removeCatalogLayer(layer);
      saveSession();
      renderLayerList();
    });

    row.appendChild(handle);
    row.appendChild(chk);
    row.appendChild(nameSpan);
    row.appendChild(slider);
    row.appendChild(removeBtn);
    body.appendChild(row);

    // ── Reorder via mousedown → document mousemove/mouseup ───────────────
    row.addEventListener('mousedown', e => {
      // Let checkboxes, sliders, and buttons handle their own clicks
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      if (e.button !== 0) return;
      e.preventDefault();   // prevent text selection while dragging
      _dragSrcIdx = i;
      _dragStartY = e.clientY;
      _isDragging = false;
      // Floating ghost label that follows the cursor
      _dragGhost = document.createElement('div');
      _dragGhost.textContent = '⠿ ' + layer.name;
      _dragGhost.style.cssText =
        'position:fixed;z-index:99999;pointer-events:none;white-space:nowrap;' +
        'padding:3px 10px;border-radius:4px;font-size:11px;' +
        'background:rgba(28,32,50,0.97);border:1px solid rgba(255,255,255,0.3);' +
        'color:rgba(255,255,255,0.9);box-shadow:0 3px 12px rgba(0,0,0,0.6);' +
        `left:${e.clientX + 14}px;top:${e.clientY - 10}px;`;
      document.body.appendChild(_dragGhost);
      document.addEventListener('mousemove', _onDragMove);
      document.addEventListener('mouseup',   _onDragUp);
    });
  });

  // ── Add layer button + picker dropdown ───────────────────────────────────
  const activeNames = new Set(active.map(l => l.name));
  const available   = LAYER_CATALOG.filter(d => !activeNames.has(d.name));

  const footer = document.createElement('div');
  footer.style.cssText = 'margin-top:5px; position:relative;';

  const addBtn = document.createElement('button');
  addBtn.textContent = '+ Add layer';
  addBtn.style.cssText = [
    'width:100%; font-size:10px; padding:3px 0;',
    'background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.2);',
    'border-radius:4px; color:rgba(255,255,255,0.75); cursor:pointer; letter-spacing:0.03em;',
  ].join('');
  if (available.length === 0 && !window._customLayers) {
    addBtn.disabled = true;
    addBtn.style.opacity = '0.38';
    addBtn.title = 'All catalog layers are already active';
  }
  footer.appendChild(addBtn);

  // Picker panel (hidden until + is clicked)
  const picker = document.createElement('div');
  picker.style.cssText = [
    'display:none; position:absolute; top:calc(100% + 2px); left:0; right:0; z-index:60;',
    'background:rgba(18,20,28,0.98); border:1px solid rgba(255,255,255,0.2);',
    'border-radius:6px; overflow:hidden; box-shadow:0 4px 14px rgba(0,0,0,0.55);',
    'max-height:220px; overflow-y:auto;',
  ].join('');

  available.forEach(def => {
    const item = document.createElement('div');
    item.textContent = def.name;
    item.style.cssText = 'padding:6px 10px; font-size:11px; color:rgba(255,255,255,0.85); cursor:pointer; white-space:nowrap;';
    item.addEventListener('mouseenter', () => { item.style.background = 'rgba(255,255,255,0.1)'; });
    item.addEventListener('mouseleave', () => { item.style.background = ''; });
    item.addEventListener('click', async () => {
      picker.style.display = 'none';
      addBtn.disabled = true;
      addBtn.textContent = `⏳ Adding ${def.name}…`;
      const newLayer = await addCatalogLayer(def.name, true, 1.0);
      if (newLayer) {
        subscribeLayerToSession(newLayer);
        saveSession();
      }
      renderLayerList();   // re-render with the new layer in the active list
    });
    picker.appendChild(item);
  });

  if (window._customLayers) {            // your own: a GeoTIFF or a tile link (custom_layers.js); in a project they go into it (📁)
    [[['doc', 'GeoTIFF file…'], () => window._customLayers.pickFile()], [['link', 'Tile link…'], () => window._customLayers.askTiles()]].forEach(([label, fn]) => {
      const item = document.createElement('div');
      window.iconLabel(item, label);
      item.style.cssText = 'padding:6px 10px; font-size:11px; color:rgba(255,255,255,0.85); cursor:pointer; white-space:nowrap; border-top:1px solid rgba(255,255,255,0.1);';
      item.addEventListener('mouseenter', () => { item.style.background = 'rgba(255,255,255,0.1)'; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });
      item.addEventListener('click', () => { picker.style.display = 'none'; fn(); });
      picker.appendChild(item);
    });
  }
  footer.appendChild(picker);
  body.appendChild(footer);

  // Toggle picker on button click; close when clicking anywhere outside
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = picker.style.display === 'none';
    picker.style.display = opening ? 'block' : 'none';
    if (opening) {
      const onOutside = (e2) => {
        if (!footer.contains(e2.target)) {
          picker.style.display = 'none';
          document.removeEventListener('click', onOutside, true);
        }
      };
      // Defer so the opening click itself isn't captured
      setTimeout(() => document.addEventListener('click', onOutside, true), 0);
    }
  });
}


  return { subscribeLayerToSession, renderLayerList };
}
