// Offline cache, the page's side: registers the service worker (client/src/sw.js) that
// keeps map tiles and point-cloud data as they load, holds the setting and the size
// cap, shows what is kept, and clears it. Also tells the height filter whether it may
// keep its ground grid between visits (pointcloud-hag.js / hag-persist.js).
//
// A classic script (index.html loads it near the end, like the other window._ modules).
// window._offline = { available, enabled, setEnabled, gridsOn, capMb, setCapMb, stats,
//                     clear, ready, status, controlled }
//
// Settings (localStorage, this computer):
//   flex.offline.on     '0' = off; anything else = on (the default)
//   flex.offline.capMb  size cap in MB for tiles + point-cloud data (default 2048)
//   flex.offline.force  '1' = also work in an automated browser (the tests set it)
// In an automated browser (navigator.webdriver) the worker is NOT registered unless
// force is set: a worker answers requests before the test tools can see them, so the
// browser tests would stop working. People never have that flag.
(function () {
  'use strict';
  const LS = { on: 'flex.offline.on', cap: 'flex.offline.capMb', force: 'flex.offline.force' };
  const SW_URL = '/client/src/sw.js';
  const DEFAULT_CAP_MB = 2048;
  const get = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

  const secure = typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator;
  const automated = !!navigator.webdriver && get(LS.force) !== '1';
  const enabled = () => get(LS.on) !== '0';
  const capMb = () => { const v = parseFloat(get(LS.cap)); return v > 0 ? v : DEFAULT_CAP_MB; };
  // The ground-grid store works without the worker (it is IndexedDB), but follows the same switch.
  const gridsOn = () => enabled() && !automated;

  let reg = null, status = 'starting', readyP = null;

  function say() {
    if (!secure) return 'Not available on this address (the browser only allows it on localhost or https).';
    if (automated) return 'Off in an automated browser.';
    if (!enabled()) return 'Off. Nothing new is saved and saved data is not used.';
    if (status === 'on') return 'On.';
    return status === 'starting' ? 'Starting…' : status;
  }

  function register() {
    if (!secure || automated) { status = 'unavailable'; return Promise.resolve(null); }
    if (!enabled()) {
      status = 'off';
      return navigator.serviceWorker.getRegistrations()
        .then(rs => Promise.all(rs.map(r => r.unregister()))).catch(() => {}).then(() => null);
    }
    return navigator.serviceWorker.register(SW_URL, { scope: '/', updateViaCache: 'none' })
      .then(r => { reg = r; return navigator.serviceWorker.ready; })
      .then(r => { reg = r; status = 'on'; return talk({ type: 'config', cap: capMb() * 1048576 }); })
      .then(() => reg)
      .catch(e => { status = 'Could not start (' + (e && e.message ? e.message : e) + ').'; return null; });
  }

  /** One message to the worker, one answer. null when there is no worker. */
  function talk(msg, timeout) {
    return new Promise(resolve => {
      const w = (reg && (reg.active || reg.waiting || reg.installing)) || (navigator.serviceWorker && navigator.serviceWorker.controller);
      if (!w) return resolve(null);
      const ch = new MessageChannel();
      const t = setTimeout(() => resolve(null), timeout || 8000);
      ch.port1.onmessage = e => { clearTimeout(t); resolve(e.data); };
      try { w.postMessage(msg, [ch.port2]); } catch (_) { clearTimeout(t); resolve(null); }
    });
  }

  async function stats() {
    const sw = await talk({ type: 'stats' });
    let grids = { n: 0, bytes: 0 };
    try { if (window._hagStore) grids = await window._hagStore.stats(); } catch (_) {}
    return { worker: sw, grids };
  }

  async function clear() {
    const sw = await talk({ type: 'clear' });
    try { if (window._hagStore) await window._hagStore.clearAll(); } catch (_) {}
    try { if (window._hag && window._hag.margins) window._hag.margins.clear(); } catch (_) {}
    return sw;
  }

  async function setCapMb(mb) {
    mb = Math.max(0.001, +mb || DEFAULT_CAP_MB);
    set(LS.cap, String(mb));
    return talk({ type: 'config', cap: mb * 1048576 });
  }

  async function setEnabled(on) {
    set(LS.on, on ? '1' : '0');
    readyP = register();
    await readyP;
    return enabled();
  }

  const mb = b => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : b >= 1048576 ? Math.round(b / 1048576) + ' MB' : Math.max(0, Math.round(b / 1024)) + ' KB';

  // ── The Settings section ───────────────────────────────────────────────────
  function buildUi() {
    const body = document.getElementById('offline-cache-body');
    if (!body || body.dataset.built) return;
    body.dataset.built = '1';
    body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:2px 0; font-size:11px;';
    const sw = window.uiSwitch
      ? window.uiSwitch(enabled(), on => { setEnabled(on).then(refresh); }, 'Save maps and point clouds as you browse', { id: 'offline_on' })
      : null;
    if (sw) wrap.appendChild(sw);
    const state = document.createElement('div');
    state.id = 'offline_state'; state.style.cssText = 'margin-top:4px; color:rgba(255,255,255,0.55);';
    const capRow = document.createElement('label');
    capRow.style.cssText = 'display:block; margin-top:6px;';
    capRow.innerHTML = 'Keep up to <input type="number" id="offline_cap" min="0.1" step="0.5" style="width:62px; background:#1a1a1a; color:#eee; border:1px solid #444; border-radius:3px; padding:1px 4px;"> GB';
    const use = document.createElement('div');
    use.id = 'offline_use'; use.style.cssText = 'margin-top:4px; color:rgba(255,255,255,0.7);';
    const btn = document.createElement('button');
    btn.id = 'offline_clear'; btn.type = 'button'; btn.className = 'btn btn-sm btn-secondary';
    btn.style.cssText = 'width:100%; margin-top:6px;'; btn.textContent = 'Clear cached map data';
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:4px; color:rgba(255,255,255,0.4);';
    note.textContent = 'Places you have looked at open faster, and open with no network. The oldest data goes first when the size is reached. The app itself is never kept out of date. Terrain and imagery from Cesium ion are not saved.';
    wrap.append(state, capRow, use, btn, note);
    body.appendChild(wrap);
    const cap = capRow.querySelector('input');
    cap.value = String(+(capMb() / 1024).toFixed(2));
    cap.addEventListener('change', () => { const gb = parseFloat(cap.value); if (gb > 0) setCapMb(gb * 1024).then(refresh); });
    btn.addEventListener('click', () => { btn.disabled = true; clear().then(refresh).then(() => { btn.disabled = false; }); });
  }

  async function refresh() {
    const state = document.getElementById('offline_state'), use = document.getElementById('offline_use');
    if (state) state.textContent = say();
    const sw = document.getElementById('offline_on'); if (sw) sw.checked = enabled();
    if (!use) return;
    const s = await stats();
    const k = (s.worker && s.worker.kinds) || {};
    const parts = [];
    if (k.tile) parts.push(k.tile.n.toLocaleString() + ' map tiles');
    if (k.pc) parts.push(k.pc.n.toLocaleString() + ' point-cloud pieces');
    if (s.grids.n) parts.push(s.grids.n + ' ground grid' + (s.grids.n > 1 ? 's' : ''));
    use.textContent = s.worker
      ? 'Using ' + mb((s.worker.bytes || 0) + (s.grids.bytes || 0)) + (parts.length ? ' (' + parts.join(', ') + ')' : '') + '.'
      : (s.grids.n ? 'Using ' + mb(s.grids.bytes) + ' for ground grids.' : '');
  }

  window._offline = {
    available: () => secure && !automated,
    enabled, setEnabled, gridsOn, capMb, setCapMb, stats, clear, talk,
    status: () => status, controlled: () => !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    ready: () => readyP || Promise.resolve(null),
    refresh,
  };

  readyP = register();
  const start = () => { buildUi(); refresh(); readyP.then(refresh); setInterval(() => { const b = document.getElementById('offline-cache-body'); if (b && b.offsetParent) refresh(); }, 10000); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
