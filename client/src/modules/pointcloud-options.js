// Point cloud look: the Potree material and EDL options the LiDAR panel offers
// (📊 LiDAR → Point cloud look): colour by, point size and sizing, shape,
// per-class visibility, intensity range / gamma, EDL. Applied to every loaded
// cloud, kept per computer in localStorage ("flex.pcopt"), and applied again
// to each cloud that loads later.
//
// Only what the person changed is stored and applied: a fresh install, or
// "Reset", leaves the material exactly as addPC sets it (potree-pointcloud.js).
// PC_OPTION_DEFAULTS below only mirrors those values so the controls can show
// them; keep it in step with the material setup in addPC.
//
// Pure exports (no browser), node-testable:
//   PC_OPTION_DEFAULTS, COLOUR_MODES, CLASS_LIST
//   sanitizeOptions(raw)                  -> clean object with only valid keys
//   applyMaterialOptions(material, opts)  -> sets the keys present in opts
//   applyViewerOptions(viewer, opts)      -> EDL keys present in opts
// Setup:
//   setupPointcloudOptions({ potreeViewer, storage })
//     -> { apply(pc), applyAll(), get(), set(patch), reset(), render() }
// Class visibility only hides points on screen; it never removes data, and the
// noise classes (7, 18) are kept in the cloud and in every filter.

export const PC_OPTION_DEFAULTS = {
  colour: 'composite', size: 0.29, sizeType: 2, shape: 1,
  iMin: 0, iMax: 65536, gamma: 3.02,
  edlOn: true, edlStrength: 0.4, edlRadius: 3.5,
};

// Potree's activeAttributeName for each choice.
export const COLOUR_MODES = {
  composite: { attr: 'composite', label: 'Composite (default)' },
  rgb: { attr: 'rgba', label: 'RGB' },
  intensity: { attr: 'intensity', label: 'Intensity' },
  elevation: { attr: 'elevation', label: 'Elevation' },
  classification: { attr: 'classification', label: 'Classification' },
  returns: { attr: 'return number', label: 'Return number' },
};

// ASPRS codes worth a switch. 7 and 18 are the noise classes (entrances live there).
export const CLASS_LIST = [
  [2, 'Ground'], [3, 'Low vegetation'], [4, 'Medium vegetation'], [5, 'High vegetation'],
  [6, 'Building'], [9, 'Water'], [1, 'Unclassified'], [0, 'Never classified'],
  [7, 'Low noise'], [18, 'High noise'],
];

const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : undefined;
const oneOf = (v, list) => list.includes(v) ? v : undefined;

export function sanitizeOptions(raw) {
  const o = {};
  if (!raw || typeof raw !== 'object') return o;
  const put = (k, v) => { if (v !== undefined) o[k] = v; };
  put('colour', typeof raw.colour === 'string' && COLOUR_MODES[raw.colour] ? raw.colour : undefined);
  put('size', num(raw.size, 0.02, 10));
  put('sizeType', oneOf(raw.sizeType, [0, 1, 2]));
  put('shape', oneOf(raw.shape, [0, 1, 2]));
  put('iMin', num(raw.iMin, 0, 65536));
  put('iMax', num(raw.iMax, 0, 65536));
  put('gamma', num(raw.gamma, 0.2, 6));
  put('edlOn', typeof raw.edlOn === 'boolean' ? raw.edlOn : undefined);
  put('edlStrength', num(raw.edlStrength, 0, 3));
  put('edlRadius', num(raw.edlRadius, 0.2, 10));
  if (Array.isArray(raw.hidden)) o.hidden = [...new Set(raw.hidden.filter(c => Number.isInteger(c) && c >= 0 && c <= 255))].sort((a, b) => a - b);
  if (o.iMin !== undefined && o.iMax !== undefined && o.iMin >= o.iMax) { delete o.iMin; delete o.iMax; }
  return o;
}

function ownClassification(material) {
  // Potree hands every material the same scheme object; give this one its own
  // copy before changing it, and make sure 17 and 18 have an entry of their own.
  if (material._flexOwnClasses) return material.classification;
  const src = material.classification || {};
  const copy = {};
  for (const k of Object.keys(src)) copy[k] = { ...src[k], color: Array.isArray(src[k].color) ? src[k].color.slice() : src[k].color };
  const noise = copy[7] ? copy[7].color : [1, 0, 1, 1];
  if (!copy[17]) copy[17] = { visible: true, name: 'bridge', color: [0.5, 0.5, 0.9, 1] };
  if (!copy[18]) copy[18] = { visible: true, name: 'high noise', color: Array.isArray(noise) ? noise.slice() : noise };
  material.classification = copy;
  material._flexOwnClasses = true;
  return copy;
}

export function applyMaterialOptions(material, opts) {
  if (!material || !opts) return;
  if (opts.colour) material.activeAttributeName = COLOUR_MODES[opts.colour].attr;
  if (opts.size !== undefined) material.size = opts.size;
  if (opts.sizeType !== undefined) material.pointSizeType = opts.sizeType;
  if (opts.shape !== undefined) material.shape = opts.shape;
  if (opts.iMin !== undefined || opts.iMax !== undefined) {
    const cur = material.intensityRange || [0, 65536];
    material.intensityRange = [opts.iMin !== undefined ? opts.iMin : cur[0], opts.iMax !== undefined ? opts.iMax : cur[1]];
  }
  if (opts.gamma !== undefined) material.intensityGamma = opts.gamma;
  if (opts.hidden) {
    const hidden = new Set(opts.hidden), cls = ownClassification(material);
    for (const k of Object.keys(cls)) if (/^\d+$/.test(k)) cls[k].visible = !hidden.has(+k);
    if (typeof material.recomputeClassification === 'function') material.recomputeClassification();
  }
}

export function applyViewerOptions(viewer, opts) {
  if (!viewer || !opts) return;
  if (opts.edlOn !== undefined && viewer.setEDLEnabled) viewer.setEDLEnabled(opts.edlOn);
  if (opts.edlStrength !== undefined && viewer.setEDLStrength) viewer.setEDLStrength(opts.edlStrength);
  if (opts.edlRadius !== undefined && viewer.setEDLRadius) viewer.setEDLRadius(opts.edlRadius);
}

const KEY = 'flex.pcopt';

export function setupPointcloudOptions({ potreeViewer, storage } = {}) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const load = () => { try { return sanitizeOptions(JSON.parse(store.getItem(KEY))); } catch (_) { return {}; } };
  const save = o => { try { Object.keys(o).length ? store.setItem(KEY, JSON.stringify(o)) : store.removeItem(KEY); } catch (_) {} };
  let opts = load();

  // What the viewer shows before anyone touches it (flex.js sets EDL at start).
  const base = { ...PC_OPTION_DEFAULTS };
  try {
    if (potreeViewer.getEDLEnabled) base.edlOn = potreeViewer.getEDLEnabled();
    if (potreeViewer.getEDLStrength) base.edlStrength = potreeViewer.getEDLStrength();
    if (potreeViewer.getEDLRadius) base.edlRadius = potreeViewer.getEDLRadius();
  } catch (_) {}

  const clouds = () => (potreeViewer && potreeViewer.scene && potreeViewer.scene.pointclouds) || [];
  const cur = k => opts[k] !== undefined ? opts[k] : base[k];

  function apply(pc) { if (pc) applyMaterialOptions(pc.material, opts); }
  function applyAll() { clouds().forEach(apply); applyViewerOptions(potreeViewer, opts); }
  function set(patch) { opts = sanitizeOptions({ ...opts, ...patch }); save(opts); applyAll(); render(); }
  function reset() {
    const had = opts; opts = {}; save(opts);
    // Put things back to the defaults on the clouds already loaded.
    const back = { ...PC_OPTION_DEFAULTS, hidden: [], edlOn: base.edlOn, edlStrength: base.edlStrength, edlRadius: base.edlRadius };
    clouds().forEach(pc => applyMaterialOptions(pc.material, back));
    applyViewerOptions(potreeViewer, back);
    render();
    return had;
  }

  const $ = id => document.getElementById(id);
  function render() {
    if (typeof document === 'undefined' || !$('lp-opt-colour')) return;
    $('lp-opt-colour').value = cur('colour');
    $('lp-opt-size').value = cur('size');            $('lp-opt-size-label').textContent = (+cur('size')).toFixed(2);
    $('lp-opt-sizetype').value = String(cur('sizeType'));
    $('lp-opt-shape').value = String(cur('shape'));
    $('lp-opt-imin').value = cur('iMin');            $('lp-opt-imax').value = cur('iMax');
    $('lp-opt-gamma').value = cur('gamma');          $('lp-opt-gamma-label').textContent = (+cur('gamma')).toFixed(2);
    $('lp-opt-edl').checked = !!cur('edlOn');
    $('lp-opt-edl-strength').value = cur('edlStrength'); $('lp-opt-edl-strength-label').textContent = (+cur('edlStrength')).toFixed(2);
    $('lp-opt-edl-radius').value = cur('edlRadius');     $('lp-opt-edl-radius-label').textContent = (+cur('edlRadius')).toFixed(1);
    const hidden = new Set(opts.hidden || []);
    const box = $('lp-opt-classes');
    if (box && !box.childElementCount) {
      CLASS_LIST.forEach(([code, name]) => {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0;font-size:11px;';
        row.innerHTML = `<input type="checkbox" data-class="${code}"><span>${name}</span><span style="margin-left:auto;opacity:.45;">${code}</span>`;
        row.querySelector('input').addEventListener('change', e => {
          const h = new Set(opts.hidden || []);
          e.target.checked ? h.delete(code) : h.add(code);
          set({ hidden: [...h] });
        });
        box.appendChild(row);
      });
    }
    if (box) box.querySelectorAll('input[data-class]').forEach(i => { i.checked = !hidden.has(+i.dataset.class); });
    const lo = $('lp-opt-intensity-rows'); if (lo) lo.style.display = ['composite', 'intensity'].includes(cur('colour')) ? 'block' : 'none';
  }

  function wire() {
    if (typeof document === 'undefined' || !$('lp-opt-colour')) return;
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    on('lp-opt-colour', 'change', e => set({ colour: e.target.value }));
    on('lp-opt-size', 'input', e => set({ size: +e.target.value }));
    on('lp-opt-sizetype', 'change', e => set({ sizeType: +e.target.value }));
    on('lp-opt-shape', 'change', e => set({ shape: +e.target.value }));
    on('lp-opt-imin', 'change', e => set({ iMin: +e.target.value }));
    on('lp-opt-imax', 'change', e => set({ iMax: +e.target.value }));
    on('lp-opt-gamma', 'input', e => set({ gamma: +e.target.value }));
    on('lp-opt-edl', 'change', e => set({ edlOn: e.target.checked }));
    on('lp-opt-edl-strength', 'input', e => set({ edlStrength: +e.target.value }));
    on('lp-opt-edl-radius', 'input', e => set({ edlRadius: +e.target.value }));
    on('lp-opt-reset', 'click', reset);
  }

  wire();
  render();
  applyViewerOptions(potreeViewer, opts);       // remembered EDL, once flex.js has set its own
  return { apply, applyAll, get: () => ({ ...opts }), set, reset, render };
}
