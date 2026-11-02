// folder_style.js — a folder's display settings, applied to everything inside
// it (📍 Surface; the folder's ⋯ menu and its palette button open the dialog).
//
// Settings: { labels: true|false, color: '#rrggbb', width: 1–10 (lines and
// outlines, px), symbol: 'dot'|'square'|'triangle'|'diamond'|'star'|'cross'
// (points), opacity: 0.1–1 }. A setting left out leaves each item as it is.
// A folder inside another wins over the outer one, setting by setting. Only
// what FLEX draws changes: nothing is written to CalTopo or to a data file.
//
// Folder keys:
//   project:<group id>    a project folder        project:   the project's features in no folder
//   mydata:<group id>     a My data sitting ("Points <date time>")
//   caltopo:<folder id>   a CalTopo folder, also _markers / _lines / _polygons (the
//                         loose features, flex.js)      caltopo:   the whole CalTopo map
//   file:<url>|<path>     a data file's folder, path by names: '/Trails/Old'
//                         file:<url>|   the whole file
// Where each is kept:
//   project   colour: the folder's colour in the project's records (group.set
//             color, as ✏️ sets it; shared with everyone on the project); the
//             rest on this computer, per project (the records have no field
//             for them yet)
//   mydata    on this computer
//   caltopo   on this computer, per map (CalTopo itself is not changed)
//   file      on this computer, per file (data files stay read-only)
//
// window._folderStyle = {
//   get(key)                 → the folder's own settings ({} when none)
//   set(key, s, {all})       merge s into them (a field set to null clears it; s = null
//                            clears all) and apply; all: a project folder's colour also
//                            replaces the own colours of what is inside (undo in History)
//   dialog(key)              the dialog; → the saved settings, or null (Cancel)
//   apply()                  apply every folder's settings to what is drawn now
//   effective(entity)        the merged settings an entity gets, or null
//   keys()                   [keys with settings] (tests)
//   label(key)               the folder's name for titles
// }
(function () {
  'use strict';
  const PJ = () => window._pj || {}, V = () => window.cesiumViewer, ws = () => window._ws, FL = () => window.FlexLib;
  const SYMBOLS = ['dot', 'square', 'triangle', 'diamond', 'star', 'cross'];
  const SYM_NAME = { dot: 'Dot', square: 'Square', triangle: 'Triangle', diamond: 'Diamond', star: 'Star', cross: 'Cross' };
  const FIELDS = ['labels', 'color', 'width', 'symbol', 'opacity'];

  // ── Storage ──────────────────────────────────────────────────────────────
  const mapId = u => (String(u || '').match(/\/m\/([A-Za-z0-9]+)/) || [])[1] || String(u || '');
  const ctSrc = () => { const w = ws(); return (w && w.vectorSources && w.vectorSources().find(s => s.kind === 'caltopo')) || null; };
  function split(key) {
    key = String(key || '');
    const i = key.indexOf(':'), kind = key.slice(0, i), rest = key.slice(i + 1);
    if (kind === 'file') { const j = rest.lastIndexOf('|'); return { kind, url: j < 0 ? rest : rest.slice(0, j), id: j < 0 ? '' : rest.slice(j + 1) }; }
    return { kind, id: rest };
  }
  function store(k) {
    if (k.kind === 'project') return 'flex.fstyle.pj.' + (PJ().pid || 'none');
    if (k.kind === 'mydata') return 'flex.fstyle.md';
    if (k.kind === 'caltopo') { const s = ctSrc(); return 'flex.fstyle.ct.' + mapId((window._ctWrite && window._ctWrite.mapId && window._ctWrite.mapId()) || (s && s.url) || ''); }
    if (k.kind === 'file') return 'flex.fstyle.file.' + k.url;
    return null;
  }
  const cache = new Map();
  function readStore(name) {
    if (!cache.has(name)) { let o = {}; try { o = JSON.parse(localStorage.getItem(name) || '{}') || {}; } catch (_) { o = {}; } cache.set(name, o); }
    return cache.get(name);
  }
  function writeStore(name, o) { cache.set(name, o); try { localStorage.setItem(name, JSON.stringify(o)); } catch (_) {} }
  function clean(s) {
    const o = {};
    if (!s) return o;
    if (typeof s.labels === 'boolean') o.labels = s.labels;
    if (s.color && /^#[0-9a-f]{6}$/i.test(s.color)) o.color = s.color.toLowerCase();
    if (s.width != null && isFinite(+s.width) && +s.width > 0) o.width = Math.min(10, Math.max(1, +s.width));
    if (s.symbol && SYMBOLS.includes(s.symbol)) o.symbol = s.symbol;
    if (s.opacity != null && isFinite(+s.opacity)) o.opacity = Math.min(1, Math.max(0.1, +s.opacity));
    return o;
  }
  const groupOf = id => { const P = PJ().P; const g = P && P.groups && P.groups[id]; return g && !g.removed ? g : null; };
  function get(key) {
    const k = split(key), name = store(k);
    if (!name) return {};
    const o = Object.assign({}, readStore(name)[k.id] || {});
    if (k.kind === 'project' && k.id) { delete o.color; const g = groupOf(k.id); if (g && g.color) o.color = String(g.color).toLowerCase(); }
    return o;
  }
  async function set(key, s, opts) {
    const k = split(key), name = store(k);
    if (!name) return null;
    const all = readStore(name), cur = Object.assign({}, all[k.id] || {});
    let next;
    if (s === null) next = {};
    else { next = cur; FIELDS.forEach(f => { if (s[f] === null) delete next[f]; else if (s[f] !== undefined) next[f] = s[f]; }); next = clean(next); }
    // A project folder's colour lives in the project's records.
    if (k.kind === 'project' && k.id) {
      const A = window._pjApi, g = groupOf(k.id);
      const want = s === null ? undefined : s.color;
      if (A && g && want !== undefined) {
        const c = want ? clean({ color: want }).color : '';
        if (c !== undefined && String(g.color || '') !== String(c || '')) {
          const P = PJ().P, F = FL();
          const inside = opts && opts.all && c ? F.liveFeatures(P).filter(f => f.style && f.style.color && F.groupPath(P, f.group).some(x => x.id === k.id)) : [];
          const subs = opts && opts.all && c ? F.liveGroups(P).filter(x => x.id !== k.id && x.color && F.groupPath(P, x.id).some(y => y.id === k.id)) : [];
          const quiet = inside.length || subs.length ? { quiet: true } : undefined;
          await A.record('group.set', { group: k.id, color: c || '' }, null, quiet);
          if (quiet) {
            await Promise.all(inside.map(f => A.record('feature.set', { feature: f.id, style: {} }, null, { quiet: true }))
              .concat(subs.map(x => A.record('group.set', { group: x.id, color: '' }, null, { quiet: true }))));
            if (A.refresh) A.refresh('feature.set');
          }
        }
      }
      delete next.color;
    }
    const out = Object.assign({}, all);
    if (Object.keys(next).length) out[k.id] = next; else delete out[k.id];
    writeStore(name, out);
    gen++;
    await apply();
    try { window.dispatchEvent(new CustomEvent('flex-folder-style', { detail: { key, settings: get(key) } })); } catch (_) {}
    return get(key);
  }
  function keys() {
    const out = [];
    const add = (prefix, name) => Object.keys(readStore(name)).forEach(id => out.push(prefix + id));
    add('project:', store({ kind: 'project' }));
    add('mydata:', store({ kind: 'mydata' }));
    add('caltopo:', store({ kind: 'caltopo' }));
    const w = ws();
    if (w) w.vectorSources().filter(s => s.kind === 'file').forEach(s => add('file:' + s.url + '|', store({ kind: 'file', url: s.url })));
    const P = PJ().P, F = FL();
    if (P && F) F.liveGroups(P).forEach(g => { if (g.color && !out.includes('project:' + g.id)) out.push('project:' + g.id); });
    return out;
  }

  // ── Which folders an entity is in (outermost first) ─────────────────────
  let myS = null, myT = 0;
  async function myState() {
    if (!window._myData) return null;
    if (!myS || Date.now() - myT > 3000) { try { myS = await window._myData.state(); myT = Date.now(); } catch (_) {} }
    return myS;
  }
  const prop = (e, k) => { const p = e.properties && e.properties[k]; return p && p.getValue ? p.getValue() : p; };
  const namePath = list => { let p = ''; return list.map(e => (p += '/' + (e.name || e.id))); };
  function chainOf(e, src) {
    const anc = []; let a = e.parent, n = 0;
    while (a && n++ < 50) { anc.unshift(a); a = a.parent; }
    if (src.kind === 'caltopo') {
      const st = readStore(store({ kind: 'caltopo' }));
      return [st[''] || null].concat(anc.map(x => st[/^ctf-/.test(x.id) ? x.id.slice(4) : x.id] || null));
    }
    const st = readStore(store({ kind: 'file', url: src.url }));
    return [st[''] || null].concat(namePath(anc).map(p => st[p] || null));
  }
  const merge = list => { const o = {}; list.forEach(s => { if (s) Object.assign(o, s); }); return Object.keys(o).length ? o : null; };
  function effective(e) {
    if (!e) return null;
    const P = PJ().P, F = FL();
    const fid = prop(e, 'featureId');
    if (fid && prop(e, 'isProjectFeature')) {
      const f = P && P.features[fid]; if (!f || !F) return null;
      const st = readStore(store({ kind: 'project' }));
      const s = merge(f.group ? F.groupPath(P, f.group).map(g => st[g.id] || null) : [st[''] || null]);
      if (s && f.group) delete s.color;                     // drawn by project_features.js from the records
      return s && Object.keys(s).length ? s : null;
    }
    const my = prop(e, 'myFeature');
    if (my) {
      const S = myS, g = S && S.features && S.features[my] && S.features[my].group;
      return g ? merge([readStore(store({ kind: 'mydata' }))[g] || null]) : null;
    }
    const w = ws(); if (!w) return null;
    const src = w.vectorSources().find(s => s.ds && s.ds.entities.getById(e.id) === e);
    return src ? merge(chainOf(e, src)) : null;
  }

  // ── Drawing ──────────────────────────────────────────────────────────────
  const now = () => Cesium.JulianDate.now();
  const val = p => (p && p.getValue ? p.getValue(now()) : p);
  const matColor = m => { try { const c = m && (m.color !== undefined ? val(m.color) : null); return c ? c.clone() : null; } catch (_) { return null; } };
  const symCache = new Map();
  function symbolImage(sym, css) {
    const k = sym + css; if (symCache.has(k)) return symCache.get(k);
    const c = document.createElement('canvas'); c.width = c.height = 20;
    const g = c.getContext('2d'); g.fillStyle = css; g.strokeStyle = '#000'; g.lineWidth = 1.5; g.beginPath();
    const P = pts => { pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); };
    if (sym === 'square') g.rect(4, 4, 12, 12);
    else if (sym === 'triangle') P([[10, 2.5], [17.5, 16.5], [2.5, 16.5]]);
    else if (sym === 'diamond') P([[10, 2], [18, 10], [10, 18], [2, 10]]);
    else if (sym === 'star') { const pts = []; for (let i = 0; i < 10; i++) { const r = i % 2 ? 3.6 : 8.5, a = -Math.PI / 2 + i * Math.PI / 5; pts.push([10 + r * Math.cos(a), 10.5 + r * Math.sin(a)]); } P(pts); }
    else if (sym === 'cross') P([[7, 2], [13, 2], [13, 7], [18, 7], [18, 13], [13, 13], [13, 18], [7, 18], [7, 13], [2, 13], [2, 7], [7, 7]]);
    else g.arc(10, 10, 6, 0, Math.PI * 2);
    g.fill(); g.stroke();
    symCache.set(k, c); return c;
  }
  function orig(e) {
    if (e._fs0) return e._fs0;
    const o = {};
    if (e.point) { o.pointColor = val(e.point.color) ? val(e.point.color).clone() : Cesium.Color.WHITE.clone(); o.pointShow = e.point.show === undefined ? true : val(e.point.show) !== false; }
    if (e.polyline) { o.lineColor = matColor(e.polyline.material); o.lineWidth = val(e.polyline.width); o.lineMat = e.polyline.material; }
    if (e.polygon) { o.fillColor = matColor(e.polygon.material); o.fillMat = e.polygon.material; }
    if (e.billboard) { o.bbColor = val(e.billboard.color) ? val(e.billboard.color).clone() : null; o.bbImage = e.billboard.image; o.bbScale = e.billboard.scale; }
    o.hadLabel = !!e.label; o.hadBillboard = !!e.billboard;
    e._fs0 = o;
    return o;
  }
  function restore(e) {
    const o = e._fs0; if (!o) return;
    if (e.point && o.pointColor) { e.point.color = o.pointColor; e.point.show = o.pointShow; }
    if (e.polyline && o.lineMat !== undefined) { e.polyline.material = o.lineMat; if (o.lineWidth != null) e.polyline.width = o.lineWidth; }
    if (e.polygon && o.fillMat !== undefined) e.polygon.material = o.fillMat;
    if (o.hadBillboard && e.billboard) { e.billboard.image = o.bbImage; e.billboard.scale = o.bbScale; e.billboard.color = o.bbColor || undefined; }
    else if (!o.hadBillboard && e.billboard) e.billboard = undefined;
    if (!o.hadLabel && e.label) e.label = undefined;
    else if (e.label && !window._surfLabelsOff && !e._pjfHid) e.label.show = true;
    e._fsNoLabel = false; e._fsNoPoint = false;
    delete e._fs0; delete e._fsSig;
  }
  const hasGraphics = e => !!(e.point || e.polyline || e.polygon || e.billboard || e.label);
  function style(e, s) {
    const sig = s ? JSON.stringify(s) : '';
    if (e._fsSig === sig || (!sig && !e._fs0)) return;
    if (e._fs0) restore(e);
    if (!s) { e._fsSig = ''; return; }
    const o = orig(e), op = s.opacity != null ? s.opacity : 1;
    const col = s.color ? Cesium.Color.fromCssColorString(s.color) : null;
    const tint = (base, a) => { const c = (col || base || Cesium.Color.WHITE).clone(); c.alpha = (base ? base.alpha : 1) * a; return c; };
    let pointCol = null;
    if (e.point && o.pointColor) { pointCol = tint(o.pointColor, op); e.point.color = pointCol; }
    if (e.polyline && (col || op !== 1 || s.width)) {
      if (col || op !== 1) e.polyline.material = new Cesium.ColorMaterialProperty(tint(o.lineColor, op));
      if (s.width) e.polyline.width = s.width;
    }
    if (e.polygon && (col || op !== 1) && (o.fillColor || col)) { const c = tint(o.fillColor || Cesium.Color.WHITE.withAlpha(0.25), op); if (!o.fillColor) c.alpha = 0.25 * op; e.polygon.material = new Cesium.ColorMaterialProperty(c); }
    if (e.billboard && o.hadBillboard && (col || op !== 1)) e.billboard.color = tint(o.bbColor || Cesium.Color.WHITE, op);
    // Symbol: points drawn as a small shape in their colour.
    if (s.symbol && e.position && (e.point || o.hadBillboard)) {
      const c = pointCol || (e.point ? val(e.point.color) : null) || col || Cesium.Color.ORANGE;
      if (s.symbol === 'dot' && e.point) { /* the dot is the point itself */ }
      else {
        const img = symbolImage(s.symbol, c.withAlpha(1).toCssColorString());
        if (o.hadBillboard) { e.billboard.image = img; e.billboard.scale = 1; e.billboard.color = Cesium.Color.WHITE.withAlpha(op); }
        else e.billboard = { image: img, color: Cesium.Color.WHITE.withAlpha(op), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: 5000, verticalOrigin: Cesium.VerticalOrigin.CENTER };
        if (e.point) { e.point.show = false; e._fsNoPoint = true; }
        e._fsSym = s.symbol;
      }
    }
    // Names.
    if (s.labels === false) { e._fsNoLabel = true; if (e.label) e.label.show = false; }
    else if (s.labels === true && e.position) {
      if (!e.label && window._pjfLabel) e.label = window._pjfLabel(e.name || '');
      if (e.label && !window._surfLabelsOff && !e._pjfHid) e.label.show = true;
    }
    e._fsSig = sig;
  }
  let gen = 0, busy = false, again = false;
  async function apply() {
    if (!window.Cesium || !V()) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      await myState();
      const F = window._pjfState;
      if (F && F.src) F.src.entities.values.forEach(e => style(e, effective(e)));
      const w = ws();
      if (w) w.vectorSources().forEach(src => src.ds.entities.values.forEach(e => { if (hasGraphics(e)) style(e, merge(chainOf(e, src))); }));
      V().entities.values.forEach(e => { if (prop(e, 'myFeature')) style(e, effective(e)); });
      if (V().scene.requestRender) V().scene.requestRender();
    } catch (err) { console.warn('[folder style]', err); }
    finally { busy = false; if (again) { again = false; setTimeout(apply, 0); } }
  }

  // ── The dialog ───────────────────────────────────────────────────────────
  function label(key) {
    const k = split(key), P = PJ().P;
    if (k.kind === 'project') { const g = k.id && groupOf(k.id); return g ? g.name || 'Folder' : 'Not in a folder'; }
    if (k.kind === 'mydata') { const S = myS, g = S && S.groups && S.groups[k.id]; return (g && g.name) || 'Points'; }
    if (k.kind === 'caltopo') {
      if (!k.id) return 'CalTopo map';
      const s = ctSrc(), e = s && s.ds.entities.getById('ctf-' + k.id); return (e && e.name) || 'CalTopo folder';
    }
    if (k.kind === 'file') { if (!k.id) { const s = (ws() ? ws().vectorSources() : []).find(x => x.url === k.url); return (s && s.name) || 'Data file'; } return k.id.split('/').pop() || 'Folder'; }
    return P ? 'Folder' : 'Folder';
  }
  async function dialog(key) {
    const A = window._pjApi; if (!A) return null;
    await myState();
    const k = split(key), cur = get(key), el = A.el;
    const body = el('div', 'fs-form');
    const row = (t, x, note) => { const r = el('label', 'fs-row'); r.appendChild(el('span', 'fs-l', t)); r.appendChild(x); if (note) r.appendChild(el('small', 'fs-n', note)); body.appendChild(r); return r; };
    const sel = (opts, v) => { const s = el('select', 'pj-input fs-sel'); opts.forEach(([val, t]) => s.appendChild(new Option(t, val))); s.value = v; return s; };
    const names = sel([['', 'As each item is'], ['on', 'Shown'], ['off', 'Hidden']], cur.labels === true ? 'on' : cur.labels === false ? 'off' : '');
    names.dataset.f = 'labels'; row('Names', names);
    const cWrap = el('span', 'fs-c');
    const cOn = el('input'); cOn.type = 'checkbox'; cOn.className = 'keep-box'; cOn.checked = !!cur.color; cOn.dataset.f = 'colorOn';
    const col = el('input'); col.type = 'color'; col.value = cur.color || '#ffb020'; col.dataset.f = 'color';
    col.addEventListener('input', () => { cOn.checked = true; });
    cWrap.append(cOn, col, el('span', 'fs-n', ' one colour for all'));
    row('Colour', cWrap);
    let allBox = null;
    if (k.kind === 'project' && k.id) {
      const r = el('label', 'fs-row fs-sub'); allBox = el('input'); allBox.type = 'checkbox'; allBox.className = 'keep-box'; allBox.checked = true; allBox.dataset.f = 'all';
      r.append(el('span', 'fs-l', ''), allBox, el('span', 'fs-n', ' also items and subfolders with a colour of their own')); body.appendChild(r);
    }
    const width = sel([['', 'As each item is']].concat([1, 2, 3, 4, 5, 6, 8, 10].map(n => [String(n), n + ' px'])), cur.width ? String(cur.width) : '');
    width.dataset.f = 'width'; row('Line width', width);
    const sym = sel([['', 'As each item is']].concat(SYMBOLS.map(s => [s, SYM_NAME[s]])), cur.symbol || '');
    sym.dataset.f = 'symbol'; row('Symbol', sym, 'points');
    const op = el('input'); op.type = 'range'; op.min = '10'; op.max = '100'; op.step = '5'; op.value = String(Math.round((cur.opacity != null ? cur.opacity : 1) * 100)); op.dataset.f = 'opacity';
    const opv = el('span', 'fs-n', op.value + ' %'); op.addEventListener('input', () => { opv.textContent = op.value + ' %'; });
    const ow = el('span', 'fs-c'); ow.append(op, opv); row('Opacity', ow);
    const where = k.kind === 'project' ? (k.id ? 'The colour is the folder’s colour in the project; the rest is kept on this computer.' : 'Kept on this computer.')
      : k.kind === 'caltopo' ? 'Kept on this computer for this map. CalTopo is not changed.'
      : k.kind === 'file' ? 'Kept on this computer for this file. The file is not changed.' : 'Kept on this computer.';
    body.appendChild(el('div', 'fs-where', where));
    const r = await A.dialog({ title: `Display: “${label(key)}”`, text: 'For everything in this folder.', body,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Reset', value: 'reset' }, { label: 'Save', value: 'ok', primary: true }] });
    if (!r) return null;
    if (r.button === 'reset') return set(key, { labels: null, color: k.kind === 'project' && k.id ? undefined : null, width: null, symbol: null, opacity: null });
    const s = {
      labels: names.value === 'on' ? true : names.value === 'off' ? false : null,
      color: cOn.checked ? col.value : (k.kind === 'project' && k.id ? undefined : null),
      width: width.value ? +width.value : null,
      symbol: sym.value || null,
      opacity: +op.value >= 100 ? null : +op.value / 100,
    };
    return set(key, s, { all: !!(allBox && allBox.checked) });
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  const prev = window._onVectorSourcesChanged;
  window._onVectorSourcesChanged = (...a) => { if (prev) prev(...a); setTimeout(apply, 0); };
  window.addEventListener('flex-caltopo-changed', () => setTimeout(apply, 50));
  // My data points come and go without an event; projects open and close.
  setInterval(() => { if (keys().length) apply(); }, 2000);

  const st = document.createElement('style');
  st.textContent = `
  .fs-form { display: flex; flex-direction: column; gap: 6px; margin: 8px 0 4px; min-width: 300px; }
  .fs-row { display: grid; grid-template-columns: 90px auto 1fr; align-items: center; gap: 6px; margin: 0; font-size: 12.5px; }
  .fs-row.fs-sub { margin-top: -4px; }
  .fs-l { opacity: .75; }
  .fs-n { opacity: .6; font-size: 11.5px; }
  .fs-c { display: inline-flex; align-items: center; gap: 6px; }
  .fs-c input[type=color] { width: 40px; height: 22px; padding: 0; border: none; background: none; }
  .fs-sel { padding: 2px 4px; font-size: 12px; }
  .fs-where { font-size: 11px; opacity: .55; margin-top: 4px; }`;
  document.head.appendChild(st);

  window._folderStyle = { get, set, dialog, apply, effective, keys, label, SYMBOLS };
})();
