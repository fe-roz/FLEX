// inventory.js — inventories: a small chest at a cave station or a surface point, with a dated log of what was
// left, taken and checked there (the rules, replay and the maths are in viewer_build/libs/flexlib.js, "Inventories").
// Works like leads (flex-leads.js): where it is kept, the marker, the right-click item, the list in ❓ Leads, the export.
//
// Where an inventory is kept:
//   project open and the place is in it (a station of one of its caves, one of its surface points) → the project's log
//   otherwise (no project, a cave outside it, a My data point)                                      → My data's log
//     (user_files/mine, /api/mine/append): the same inv.* records, replayed by flexlib.replayProject(…, 'mine'). The
//     target is station:<cave key>:<station> (the cave key f.<file name, URL-escaped>, as leads) or feature:<id>.
// Photos are pages by content hash (like documents'), stored in the project's folder or My data's.
//
//   - the marker: a chest billboard with a short label at the station's own 3D place (cave data keeps its height), or
//     at a surface point (its own height if it has one, else the ground: window._groundH), faded when an item is
//     possibly out of date; the Inventories switch (Caves pane) hides them all;
//   - the card: contents table (item, quantity, last change, last checked), the log table (date, who, action, items,
//     photos), Add entry, a switch to keep a simple list instead (info-panel.js shows it for a clicked marker);
//   - right-click a station: Add inventory here…; right-click a surface point too; station cards have a button;
//   - ❓ Leads lists them in a section of their own;
//   - the export: window._inventory.exportAt / exportSurface → caves.json `inventories` (export-ui.js);
//   - moves: a cave that moves to another project takes the chests at its stations (flexlib caveBundle, done by the server);
//     a surface point that moves between the project and My data takes its chests (carryPoints, called by project-workspace.js).
//   - one id, one chest: when the project and My data both have a record of an inventory id (the phone adopts a chest of
//     My data into the project's log before its first change), the project's record is the one listed, drawn and exported.
//
// window._inventory = { all, lookup, load, redraw, visible, setVisible, addAtStation, addAtFeature, addEntry, editEntry,
//   editInventory, setMode, subject, card, cardSection, cardButton, cardNoProject, paneSection, exportAt, exportSurface,
//   stationPos, labelOf, open, lightbox, photoPages, atStation, carryPoints }
(function () {
  'use strict';
  const A = window._pjApi, FL = window.FlexLib;
  if (!A || !FL) return;
  const { pj, el, btn, esc, toast } = A;
  const V = () => window.cesiumViewer;
  const imps = () => (window._caveImports || []).filter(i => i && i.parsed);
  const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const mineCid = imp => (window._flexLeads ? window._flexLeads.mineCid(imp) : 'f.' + encodeURIComponent(imp.name));
  const short = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const blobUrl = p => '/api/lib/blob/' + p.h + '.' + (p.ext || 'jpg');
  const dayOf = t => { const d = t ? new Date(t) : new Date(), p = n => String(n).padStart(2, '0'); return isNaN(d) ? String(t).slice(0, 10) : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };     // a day, in this computer's time
  const today = () => dayOf();

  let showOn = lsGet('flex.inventories') !== '0';
  const visible = () => showOn;

  // ── Where they are kept ────────────────────────────────────────────────────
  let mineS = null;                                          // My data replayed (window._myData.state)
  async function mineLoad(force) {
    if (!window._myData) return null;
    try { mineS = await window._myData.state(!!force); } catch (e) { console.warn('[inventory] My data:', e); }
    return mineS;
  }
  const projectStore = { mine: false, label: 'the project', get P() { return pj.P; }, record: (op, data) => A.record(op, data) };
  const mineStore = {
    mine: true, label: 'My data',
    get P() { return mineS || FL.replayProject([], 'mine'); },
    async record(op, data) {
      if (!window._myData) return null;
      let e = null;
      try { e = await window._myData.record(op, data); } catch (err) { toast('Could not save: ' + err.message); return null; }
      await mineLoad(true);
      changed();
      return e;
    },
  };
  /**
   * Every live inventory: [{ inv, store }] (the open project's, then My data's). An id is listed once, the project's: when
   * the phone changes a chest that came from My data it takes the chest into the project's log first (same id), so after
   * the phone's sync file is imported both logs have it, and the project's record is the one listed, drawn and exported.
   */
  function all() {
    const out = [], seen = new Set();
    if (pj.pid && pj.P) FL.liveInventories(pj.P).forEach(inv => { seen.add(inv.id); out.push({ inv, store: projectStore }); });
    FL.liveInventories(mineS || {}).forEach(inv => { if (!seen.has(inv.id)) out.push({ inv, store: mineStore }); });
    return out;
  }
  /** { inv, store } for an inventory id (null when it is gone). */
  function lookup(id) {
    const P = pj.pid && pj.P && pj.P.inventories && pj.P.inventories[id];
    if (P && !P.deleted && P.target) return { inv: P, store: projectStore };
    const M = mineS && mineS.inventories && mineS.inventories[id];
    if (M && !M.deleted && M.target) return { inv: M, store: mineStore };
    return null;
  }

  // ── Places ─────────────────────────────────────────────────────────────────
  const stationPos = (cid, name) => (window._flexLeads ? window._flexLeads.stationPos(cid, name) : A.stationPos(cid, name));
  /** A surface point: { f, project } from the open project's features, else My data's. */
  function featureOf(fid) {
    const pf = pj.pid && pj.P && pj.P.features && pj.P.features[fid];
    if (pf && !pf.removed) return { f: pf, project: true };
    const mf = mineS && mineS.features && mineS.features[fid];
    if (mf && !mf.removed) return { f: mf, project: false };
    return null;
  }
  function labelOf(target) {
    const p = FL.parseTarget(target);
    if (p.kind === 'feature') { const F = featureOf(p.feature); return F && F.f.name ? F.f.name + ' (surface)' : 'a surface point'; }
    if (window._flexLeads) return window._flexLeads.labelOf(target);
    return A.targetLabel(target);
  }
  /** Where a station of a loaded cave file keeps its inventory: { target, store, label }. */
  function stationWhere(imp, code, station) {
    const cid = pj.pid && !pj.readonly ? A.caveFor(imp, code || '') : null;
    const c = cid || mineCid(imp), target = FL.T.station(c, station);
    return { target, store: cid ? projectStore : mineStore, label: labelOf(target) };
  }
  /** Inventories at a station of a loaded cave file: the project's and My data's. */
  function atStation(imp, code, station) {
    const pc = pj.pid ? A.caveFor(imp, code || '') : null, mc = FL.T.station(mineCid(imp), station), pt = pc ? FL.T.station(pc, station) : null;
    return all().filter(x => x.inv.target === mc || (pt && x.inv.target === pt));
  }
  /** Where a drawn thing sits: { pos (Cartesian3), surface, own, ll } or null while its cave is not loaded. */
  function placeOf(target) {
    const t = FL.parseTarget(target);
    if (t.kind === 'station') { const pos = stationPos(t.cave, t.name); return pos ? { pos, surface: false } : null; }
    if (t.kind === 'feature') {
      const F = featureOf(t.feature), c = F && F.f.coords && F.f.coords[0];
      if (!c || !window.Cesium) return null;
      // its own height if it has one (measured, surveyed, GPS), else the ground (ground-height.js), as a lead on it
      const own = !!(F.f.hsrc && !(F.f.style && F.f.style.ct));
      return { pos: Cesium.Cartesian3.fromDegrees(c[0], c[1], c[2] || 0), surface: true, own, ll: [c[0], c[1]] };
    }
    return null;
  }

  // ── The marker ─────────────────────────────────────────────────────────────
  const ICON_PX = 28;
  let iconCv = null;
  /** The chest, drawn on a canvas at 2x: an arched lid, a band and a lock, outlined and glowing so it reads on terrain. */
  function chestIcon() {
    if (iconCv) return iconCv;
    const S = ICON_PX * 2, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d'), k = S / 52;
    g.lineJoin = 'round'; g.lineCap = 'round'; g.lineWidth = 3 * k; g.strokeStyle = 'rgba(0,0,0,.88)';
    g.shadowColor = '#ffb020'; g.shadowBlur = 6 * k;
    g.beginPath(); g.moveTo(6 * k, 27 * k); g.bezierCurveTo(6 * k, 13 * k, 15 * k, 8 * k, 26 * k, 8 * k); g.bezierCurveTo(37 * k, 8 * k, 46 * k, 13 * k, 46 * k, 27 * k); g.closePath();
    g.fillStyle = '#f0b040'; g.fill(); g.stroke();
    g.beginPath(); g.rect(6 * k, 27 * k, 40 * k, 19 * k); g.fillStyle = '#c4801f'; g.fill(); g.shadowBlur = 0; g.stroke();
    g.beginPath(); g.moveTo(6 * k, 34 * k); g.lineTo(46 * k, 34 * k); g.lineWidth = 2 * k; g.stroke();
    g.lineWidth = 2.6 * k; g.beginPath(); g.rect(22 * k, 29 * k, 8 * k, 10 * k); g.fillStyle = '#ffe08a'; g.fill(); g.stroke();
    return (iconCv = c);
  }
  const markLabel = inv => short(inv.name || 'Inventory', 24) + (inv.stale ? ' (old)' : '');
  let src = null;
  function descHtml(inv) {
    return `<b>${esc(inv.name || 'Inventory')}</b><br>${esc(labelOf(inv.target))}` + (inv.desc ? '<br>' + esc(inv.desc) : '') + (FL.invLine(inv, 6) ? '<br>' + esc(FL.invLine(inv, 6)) : '');
  }
  function lookOf(inv, p) {
    const fade = inv.stale ? 0.55 : 1, C = Cesium;
    const off = p.surface ? -12 : 0;
    return {
      billboard: { image: chestIcon(), width: ICON_PX, height: ICON_PX, verticalOrigin: C.VerticalOrigin.BOTTOM, color: C.Color.WHITE.withAlpha(fade),
        pixelOffset: new C.Cartesian2(ICON_PX * 0.6, off), disableDepthTestDistance: 5000 },
      label: { text: markLabel(inv), font: '12px sans-serif', fillColor: C.Color.WHITE.withAlpha(inv.stale ? 0.7 : 1), outlineColor: C.Color.BLACK, outlineWidth: 3,
        style: C.LabelStyle.FILL_AND_OUTLINE, verticalOrigin: C.VerticalOrigin.BOTTOM, pixelOffset: new C.Cartesian2(ICON_PX * 0.6, off - ICON_PX - 2),
        distanceDisplayCondition: new C.DistanceDisplayCondition(0, 300), disableDepthTestDistance: 5000 },
    };
  }
  /** Draw (or update, keeping a selected marker selected) one chest per inventory whose place is on the map. */
  function redraw() {
    const v = V();
    if (!v || !window.Cesium) return;
    if (!src) { src = new Cesium.CustomDataSource('flex-inventories'); v.dataSources.add(src); }
    src.show = showOn;
    const want = new Map();
    all().forEach(x => { const p = placeOf(x.inv.target); if (p) want.set('inv-' + x.inv.id, { x, p }); });
    src.entities.values.slice().forEach(e => { if (!want.has(e.id)) src.entities.remove(e); });
    want.forEach(({ x, p }, id) => {
      const inv = x.inv, look = lookOf(inv, p);
      let e = src.entities.getById(id);
      if (!e) {
        e = src.entities.add(Object.assign({ id, position: p.pos, name: 'Inventory: ' + (inv.name || ''), description: descHtml(inv),
          properties: { isInventory: true, invId: inv.id, invKept: x.store.mine ? 'mine' : 'project' } }, look));
      } else {
        e.name = 'Inventory: ' + (inv.name || ''); e.description = descHtml(inv);
        e.billboard.color = look.billboard.color; e.label.text = look.label.text; e.label.fillColor = look.label.fillColor;
        e.properties.invKept = x.store.mine ? 'mine' : 'project';
        const cur = e.position && e.position.getValue(Cesium.JulianDate.now());
        if (!p.surface || p.own) { if (!cur || !Cesium.Cartesian3.equals(cur, p.pos)) e.position = p.pos; }
      }
      if (p.surface && !p.own && window._groundH) window._groundH.track(e, p.ll[0], p.ll[1]);
    });
    v.scene.requestRender && v.scene.requestRender();
  }
  function setVisible(on) {
    showOn = !!on;
    lsSet('flex.inventories', showOn ? '1' : '0');
    if (src) src.show = showOn;
    const cb = document.getElementById('lp-cave-inv-toggle'); if (cb && cb.checked !== showOn) cb.checked = showOn;
    const v = V(); v && v.scene.requestRender && v.scene.requestRender();
  }
  /** After any change to a My data inventory (the project's go through project.js, which calls redraw). */
  function changed() {
    redraw();
    if (A.refreshCard) A.refreshCard();
    if (A.render) A.render();
    if (window._info && window._info.changed) window._info.changed({ op: 'inv.set' });
    if (window._inspector && window._inspector.refresh) window._inspector.refresh();
  }
  /** Select an inventory's marker on the map (its card opens in the details panel); fly there with fly: true. */
  function open(x, opts) {
    const v = V(), id = x.inv ? x.inv.id : x, e = src && src.entities.getById('inv-' + id);
    if (!v || !e) { toast('That place isn’t on the map (is its cave loaded?)'); return false; }
    if (opts && opts.fly) { const pos = e.position.getValue(Cesium.JulianDate.now()); if (pos) v.camera.flyToBoundingSphere(new Cesium.BoundingSphere(pos, 25), { duration: 1.2 }); }
    v.selectedEntity = e;
    return true;
  }

  // ── Small dialogs (a form that stays open until it is right) ───────────────
  // enter: Enter in a one-line box presses the primary button (for a short form; the entry form has several lines to fill).
  function modal({ title, text, body, buttons, wide, enter }) {
    return new Promise(resolve => {
      const wrap = el('div', 'pj-modal inv-modal'), box = el('div', 'pj-modal-box' + (wide ? ' wide' : ''));
      box.appendChild(el('div', 'pj-modal-title', title));
      if (text) box.appendChild(el('div', 'pj-modal-text', text));
      box.appendChild(body);
      const msg = el('div', 'pj-conflict inv-msg'); msg.style.display = 'none'; box.appendChild(msg);
      const row = el('div', 'pj-modal-btns');
      const done = v => { wrap.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
      const key = e => {
        if (e.key === 'Escape') { e.stopPropagation(); done(null); }
        else if (enter && e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && e.target.type === 'text') { e.preventDefault(); const pb = [...row.querySelectorAll('.primary')][0]; if (pb) pb.click(); }
      };
      buttons.forEach(b => row.appendChild(btn(b.label, () => {
        if (b.value === null) return done(null);
        const bad = b.check && b.check();
        if (bad) { msg.textContent = bad; msg.style.display = ''; return; }
        done(b.value);
      }, (b.primary ? 'primary' : '') + (b.danger ? ' danger' : ''))));
      box.appendChild(row);
      wrap.appendChild(box);
      document.addEventListener('keydown', key, true);
      document.body.appendChild(wrap);
      const first = box.querySelector('input:not([type=checkbox]), textarea'); if (first) setTimeout(() => first.focus(), 30);
    });
  }
  const field = (label, node) => { const r = el('div', 'pj-f'); r.appendChild(el('div', 'pj-f-l', label)); r.appendChild(node); return r; };
  const input = (value, ph, area) => { const i = el(area ? 'textarea' : 'input', 'pj-input'); if (area) i.rows = area; i.value = value || ''; if (ph) i.placeholder = ph; return i; };

  /** The inventory itself: name, description, and whether it is a dated log or a simple list. cur: the replayed inventory, or null. */
  async function inventoryDialog(title, cur, canRemove) {
    const st = { mode: cur ? cur.mode : 'log' };
    const body = el('div', 'pj-form inv-form');
    const name = input(cur ? cur.name : '', 'e.g. Rope cache'), desc = input(cur ? cur.desc : '', 'Where exactly, what it is kept in…', 2), list = input(cur ? cur.list : '', 'One thing per line', 5);
    name.dataset.f = 'name'; desc.dataset.f = 'desc'; list.dataset.f = 'list';
    body.append(field('Name', name), field('Description', desc));
    if (cur && cur.conflicts) Object.keys(cur.conflicts).forEach(k => body.appendChild(el('div', 'pj-conflict', ['warn', `${k}: edited on two devices — ` + cur.conflicts[k].map(c => `“${short(c.v, 40)}” (${c.who})`).join(' / ') + '. Saving keeps what is in the box.'])));
    const listBox = el('div'); listBox.appendChild(field('The list', list));
    const sw = window.uiSwitch ? window.uiSwitch(st.mode === 'list', on => { st.mode = on ? 'list' : 'log'; listBox.style.display = on ? '' : 'none'; }, 'Keep it as a simple list instead of a dated log', { small: true }) : null;
    if (sw) { sw.classList.add('inv-modesw'); body.appendChild(sw); }
    listBox.style.display = st.mode === 'list' ? '' : 'none';
    body.appendChild(listBox);
    const buttons = [{ label: 'Cancel', value: null }];
    if (canRemove) buttons.push({ label: 'Remove inventory', value: 'rm', danger: true });
    buttons.push({ label: 'Save', value: 'ok', primary: true });
    const r = await modal({ title, body, buttons, wide: true, enter: true });
    if (!r) return null;
    return { remove: r === 'rm', name: name.value.trim(), desc: desc.value.trim(), mode: st.mode, list: list.value };
  }

  // ── Adding and changing inventories ────────────────────────────────────────
  async function createAt(target, store, label) {
    if (!(await A.ensureAuthor())) return null;
    await mineLoad();
    const r = await inventoryDialog('New inventory at ' + label, null, false);
    if (!r) return null;
    const body = FL.invSetBody(null, { target, name: r.name || 'Inventory at ' + short(label.split(' · ')[0], 30), desc: r.desc, mode: r.mode, list: r.list });
    const { op, ...data } = body;
    data.inv = FL.uid(12);
    const e = await store.record(op, data);
    if (!e) return null;
    redraw();
    setTimeout(() => open({ inv: { id: data.inv } }), 150);          // the new chest selected: its card is there to fill
    return data.inv;
  }
  /** "Add inventory here…" at a station of a loaded cave file. */
  async function addAtStation(imp, code, station) {
    if (!imp || !station) return null;
    await mineLoad();
    const w = stationWhere(imp, code, station);
    return createAt(w.target, w.store, w.label);
  }
  /** "Add inventory here…" at a surface point (a project feature or a My data point). */
  async function addAtFeature(fid) {
    await mineLoad();
    const F = featureOf(fid);
    if (!F || F.f.kind !== 'point') { toast('An inventory goes on a point (a station or a surface point)'); return null; }
    if (F.project && pj.readonly) { toast('This project is read-only'); return null; }
    return createAt(FL.T.feature(fid), F.project ? projectStore : mineStore, (F.f.name || 'a surface point') + ' (surface)');
  }
  async function editInventory(hit) {
    if (!(await A.ensureAuthor())) return;
    const { inv, store } = hit;
    const r = await inventoryDialog('Inventory · ' + labelOf(inv.target), inv, true);
    if (!r) return;
    if (r.remove) { await store.record('inv.del', { inv: inv.id, base: inv.heads.slice() }); toast('Inventory removed'); return; }
    const body = FL.invSetBody(inv, { name: r.name || inv.name, desc: r.desc, mode: r.mode, list: r.list });
    if (!body) return;
    const { op, ...data } = body;
    data.inv = inv.id;
    await store.record(op, data);
  }
  async function setMode(hit, mode) {
    const { inv, store } = hit;
    const next = { mode };
    if (mode === 'list' && !inv.list.trim() && inv.contents.length) next.list = inv.contents.map(c => (c.qty === 1 ? '' : c.qty + ' × ') + c.name).join('\n');     // start from what the log says
    const body = FL.invSetBody(inv, next);
    if (!body) return;
    const { op, ...data } = body;
    data.inv = inv.id;
    await store.record(op, data);
  }
  async function editList(hit) {
    if (!(await A.ensureAuthor())) return;
    const { inv, store } = hit;
    const body = el('div', 'pj-form'), list = input(inv.list, 'One thing per line', 8);
    list.dataset.f = 'list';
    body.appendChild(list);
    const r = await modal({ title: 'List · ' + (inv.name || 'Inventory'), body, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }], wide: true });
    if (!r) return;
    const b = FL.invSetBody(inv, { list: list.value });
    if (!b) return;
    const { op, ...data } = b;
    data.inv = inv.id;
    await store.record(op, data);
  }

  // ── Photos ─────────────────────────────────────────────────────────────────
  const PHOTO_PX = 2400;
  async function storeBlob(buf, ext, store) {
    const url = store.mine ? '/api/mine/blob?ext=' + ext : '/api/lib/blob?ext=' + ext + (pj.pid ? '&project=' + encodeURIComponent(pj.pid) : '');
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf });
    if (!r.ok) throw new Error('could not store the photo');
    return r.json();
  }
  /** A photo file into another store's folder (stored by content hash, so the same bytes keep the same name). */
  async function copyPhoto(p, store) {
    const r = await fetch(blobUrl(p));
    if (!r.ok) throw new Error('could not read a photo to move it');
    return storeBlob(await r.arrayBuffer(), p.ext || 'jpg', store);
  }

  // ── Moving with a surface point (project ⇄ My data) ────────────────────────
  /**
   * The chests at surface points that move between the project and My data (the point gets a new id there). They follow
   * with the same inventory ids and log entries, their photo files are copied into the other folder, and the old copy is
   * removed (History can undo it). Made at the other side first, so a chest is never in neither; repeating it adds nothing.
   * pairs: [[id here, id there]]; dir 'out': project → My data, 'in': My data → project. → how many chests moved.
   */
  async function carryPoints(pairs, dir) {
    if (!pairs || !pairs.length) return 0;
    await mineLoad(true);
    const from = dir === 'out' ? projectStore : mineStore, to = dir === 'out' ? mineStore : projectStore;
    let n = 0;
    for (const [a, b] of pairs) {
      const mv = FL.featureInvMove(from.P, a, to.P, b);
      if (!mv.put.length && !mv.clear.length) continue;
      for (const p of mv.photos) await copyPhoto(p, to);
      for (const e of mv.put) { const { op, ...d } = e; if (!(await to.record(op, d))) throw new Error('could not move the inventory at a surface point'); }
      for (const e of mv.clear) { const { op, ...d } = e; await from.record(op, d); }
      n += mv.clear.length;
    }
    if (n) { await mineLoad(true); redraw(); }
    return n;
  }
  /** Image files → pages (JPEG up to 2400 px, stored once by content hash, like a document's pages): { pages, failed }. */
  async function photoPages(files, store) {
    const pages = [], failed = [];
    for (const f of files) {
      try {
        const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
        const k = Math.min(1, PHOTO_PX / Math.max(bmp.width, bmp.height));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
        const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(bmp, 0, 0, cv.width, cv.height);
        const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
        const o = await storeBlob(await blob.arrayBuffer(), 'jpg', store);
        pages.push({ h: o.h, ext: 'jpg', w: cv.width, ht: cv.height, name: f.name });
      } catch (e) { console.warn('[inventory] photo', f && f.name, e); failed.push(f && f.name); }
    }
    return { pages, failed };
  }
  /** A photo full size over everything (click or Esc closes; ← → walk the entry's photos). */
  function lightbox(photos, i) {
    const w = el('div', 'pj-modal inv-lightbox');                  // (a modal: Esc closes only this, the panels behind stay)
    let k = i || 0;
    const img = el('img'), cap = el('div', 'inv-lb-cap');
    const show = n => { k = (n + photos.length) % photos.length; img.src = blobUrl(photos[k]); cap.textContent = photos.length > 1 ? `${k + 1} / ${photos.length}` + (photos[k].date ? ' · ' + photos[k].date : '') : (photos[k].date || ''); };
    const close = () => { w.remove(); document.removeEventListener('keydown', key, true); };
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } else if (e.key === 'ArrowRight') show(k + 1); else if (e.key === 'ArrowLeft') show(k - 1); };
    w.append(img, cap);
    w.addEventListener('click', e => { if (e.target === w || e.target === img) close(); });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(w);
    show(k);
  }
  const thumbs = (photos, cls) => {
    const box = el('div', 'inv-thumbs' + (cls ? ' ' + cls : ''));
    photos.forEach((p, i) => {
      const im = el('img'); im.loading = 'lazy'; im.src = blobUrl(p); im.alt = 'photo'; im.title = (p.date ? p.date + ' · ' : '') + (p.name || 'photo');
      im.addEventListener('click', e => { e.stopPropagation(); lightbox(photos, i); });
      box.appendChild(im);
    });
    return box;
  };

  /** Every photo of an inventory, newest first, each with the date of its entry (click: full size). */
  function photoGrid(photos) {
    const box = el('div', 'inv-grid');
    photos.forEach((p, i) => {
      const f = el('figure', 'inv-fig'), im = el('img');
      im.loading = 'lazy'; im.src = blobUrl(p); im.alt = 'photo'; im.title = (p.date || '') + (p.by ? ' · ' + p.by : '');
      im.addEventListener('click', () => lightbox(photos, i));
      f.append(im, el('figcaption', null, p.date || ''));
      box.appendChild(f);
    });
    return box;
  }

  // ── An entry of the log ────────────────────────────────────────────────────
  const ACT_LABEL = { left: 'Left', took: 'Took', checked: 'Checked', note: 'Note' };
  const itemsText = items => items.map(i => (i.qty === 1 ? '' : i.qty + ' × ') + i.name).join(', ');
  /** Add an entry to an inventory's log (cur: an entry to edit instead). preset: { action } */
  async function addEntry(hit, cur, preset) {
    if (!(await A.ensureAuthor())) return;
    const { inv, store } = hit;
    const st = { action: cur ? cur.action : (preset && preset.action) || 'left', date: cur ? cur.date : today(), by: cur ? cur.by : '', all: cur ? cur.all : false, text: cur ? cur.text : '',
      items: cur ? cur.items.map(x => ({ name: x.name, qty: String(x.qty) })) : [], photos: cur ? cur.photos.slice() : [], files: [] };
    // a check starts from what the log says is there: change the numbers, add what you find
    if (!cur && st.action === 'checked') st.items = inv.contents.map(c => ({ name: c.name, qty: String(c.qty) }));
    if (!st.items.length) st.items.push({ name: '', qty: '' });
    const body = el('div', 'pj-form inv-form');
    const chips = el('div', 'pj-chips inv-actions');
    const names = el('datalist'); names.id = 'inv-names';
    inv.contents.concat(inv.gone.map(g => ({ name: g.name }))).forEach(c => { const o = el('option'); o.value = c.name; names.appendChild(o); });
    const dateIn = input(st.date, '2026-03-02, or 2026-03 / 2019 if not sure'), byIn = input(st.by, A.who() || 'Names');
    dateIn.dataset.f = 'date'; byIn.dataset.f = 'by';
    dateIn.addEventListener('input', () => { st.date = dateIn.value; }); byIn.addEventListener('input', () => { st.by = byIn.value; });
    const itemsBox = el('div', 'inv-items'), itemsField = field('Items', itemsBox);
    const allSw = window.uiSwitch ? window.uiSwitch(st.all, on => { st.all = on; }, 'That was everything here (what is not listed is gone)', { small: true }) : null;
    const textIn = input(st.text, 'Anything worth saying (where exactly, what condition, who has the key…)', 3); textIn.dataset.f = 'text';
    textIn.addEventListener('input', () => { st.text = textIn.value; });
    const photoBox = el('div', 'inv-photobox');
    const paintItems = () => {
      itemsBox.textContent = '';
      itemsField.style.display = st.action === 'note' ? 'none' : '';
      if (allSw) allSw.style.display = st.action === 'checked' ? '' : 'none';
      st.items.forEach((it, k) => {
        const row = el('div', 'inv-item'), n = input(it.name, st.action === 'checked' ? 'Item you counted' : 'Item'), q = input(it.qty, '1');
        n.setAttribute('list', 'inv-names'); n.dataset.f = 'item'; q.dataset.f = 'qty'; q.classList.add('inv-qty'); q.setAttribute('inputmode', 'decimal');
        n.addEventListener('input', () => { it.name = n.value; }); q.addEventListener('input', () => { it.qty = q.value; });
        const x = btn(['x'], () => { st.items.splice(k, 1); if (!st.items.length) st.items.push({ name: '', qty: '' }); paintItems(); }, 'small'); x.title = 'Take this line out';
        row.append(n, q, x);
        itemsBox.appendChild(row);
      });
      itemsBox.appendChild(btn(['plus', 'Another item'], () => { st.items.push({ name: '', qty: '' }); paintItems(); const ins = itemsBox.querySelectorAll('input[data-f=item]'); ins[ins.length - 1].focus(); }, 'small'));
    };
    const paintPhotos = () => {
      photoBox.textContent = '';
      const row = el('div', 'inv-thumbs inv-edit');
      st.photos.forEach((p, k) => { const w = el('span', 'inv-th'), im = el('img'); im.src = blobUrl(p); w.append(im, btn(['x'], () => { st.photos.splice(k, 1); paintPhotos(); }, 'small')); row.appendChild(w); });
      st.files.forEach((f, k) => { const w = el('span', 'inv-th'), im = el('img'); im.src = URL.createObjectURL(f); im.onload = () => URL.revokeObjectURL(im.src); w.append(im, btn(['x'], () => { st.files.splice(k, 1); paintPhotos(); }, 'small')); row.appendChild(w); });
      photoBox.appendChild(row);
      photoBox.appendChild(btn(['image', 'Add photos…'], async () => { const fs = await A.pickFiles('image/*', true); if (fs.length) { st.files.push(...fs); paintPhotos(); } }, 'small'));
    };
    [['left', 'Left'], ['took', 'Took'], ['checked', 'Checked'], ['note', 'Note']].forEach(([k, label]) => {
      const b = btn(label, () => {
        st.action = k;
        chips.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
        if (k === 'checked' && !cur && st.items.every(i => !i.name.trim()) && inv.contents.length) st.items = inv.contents.map(c => ({ name: c.name, qty: String(c.qty) }));
        paintItems();
      }, 'chip' + (st.action === k ? ' on' : ''));
      b.dataset.act = k;
      chips.appendChild(b);
    });
    body.append(names, field('What happened', chips), field('Date', dateIn), field('Who (if not just you)', byIn), itemsField);
    if (allSw) body.appendChild(allSw);
    body.append(field('Note', textIn), field('Photos', photoBox));
    paintItems(); paintPhotos();
    const check = () => {
      if (!FL.dateKey(st.date)) return 'Date: write it like 2026-03-02 (or just 2026-03, or 2019 when you do not know more).';
      if (st.action !== 'note' && !FL.invItems(st.items).length) return 'List at least one item (or choose Note).';
      if (st.action === 'note' && !st.text.trim() && !st.photos.length && !st.files.length) return 'Write a note or add a photo.';
      return '';
    };
    const buttons = [{ label: 'Cancel', value: null }];
    if (cur) buttons.push({ label: 'Remove entry', value: 'rm', danger: true });
    buttons.push({ label: 'Save', value: 'ok', primary: true, check });
    const r = await modal({ title: (cur ? 'Entry of ' : 'New entry · ') + (inv.name || 'Inventory'), body, buttons, wide: true });
    if (!r) return;
    if (r === 'rm') { await store.record('inv.log', stripOp(FL.invLogRemoveBody(inv.id, cur))); toast('Entry removed'); return; }
    let pages = [];
    if (st.files.length) {
      toast(`Adding ${st.files.length} photo${st.files.length === 1 ? '' : 's'}…`);
      const res = await photoPages(st.files, store);
      res.failed.forEach(n => toast('Could not read ' + n));
      pages = res.pages;
    }
    const b = FL.invLogBody(inv.id, { date: st.date, by: st.by, action: st.action, items: st.items, all: st.all, photos: st.photos.concat(pages), text: st.text }, cur);
    if (!b) return;
    const e = await store.record('inv.log', stripOp(b));
    if (e) toast(cur ? 'Entry saved' : 'Entry added');
  }
  const stripOp = b => { const { op, ...d } = b; return d; };
  const editEntry = (hit, entry) => addEntry(hit, entry);

  // ── The card (contents, log, add an entry, simple list) ────────────────────
  const td = (text, cls) => { const c = el('td', cls || null); if (text != null) window.iconLabel(c, text); return c; };
  const thead = cols => { const h = el('thead'), r = el('tr'); cols.forEach(c => r.appendChild(el('th', null, c))); h.appendChild(r); return h; };
  const openLogs = new Set();                                  // inventories whose whole log is shown in the brief
  function contentsTable(inv) {
    const t = el('table', 'inv-tbl inv-contents');
    t.appendChild(thead(['Item', 'Qty', 'Last change', 'Last checked']));
    const tb = el('tbody');
    inv.contents.forEach(c => {
      const tr = el('tr', c.stale ? 'inv-stale' : '');
      tr.dataset.item = c.name;
      const nm = td(c.name); if (c.short) nm.title = 'More was taken than the log had; the record may be incomplete.';
      const ck = td(c.checked || 'never', c.checked ? '' : 'inv-never');
      if (c.stale) { ck.title = 'Possibly out of date: ' + (c.checked ? 'counted ' + c.checked : 'never counted, first seen ' + c.first); window.iconLabel(ck, ['warn', c.checked || 'never']); }
      tr.append(nm, td(String(c.qty), 'inv-q'), td(c.changed || '–'), ck);
      tb.appendChild(tr);
    });
    if (!inv.contents.length) { const tr = el('tr'), c = td(inv.log.length ? 'Nothing left there, as far as the log says.' : 'Nothing recorded yet. Add an entry: what you left, took, or counted.', 'inv-none'); c.colSpan = 4; tr.appendChild(c); tb.appendChild(tr); }
    t.appendChild(tb);
    return t;
  }
  function logTable(hit, full) {
    const { inv, store } = hit, t = el('table', 'inv-tbl inv-log');
    t.appendChild(thead(['Date', 'Who', 'Action', 'Items', 'Photos']));
    const tb = el('tbody');
    const rows = inv.log.slice().reverse(), cap = full || openLogs.has(inv.id) ? rows.length : 4;
    rows.slice(0, cap).forEach(e => {
      const tr = el('tr', 'inv-entry' + (e.conflicts ? ' inv-conf' : ''));
      tr.dataset.log = e.id;
      const what = el('td');
      if (e.items.length) what.appendChild(el('div', 'inv-items-t', itemsText(e.items) + (e.all ? ' (everything)' : '')));
      if (e.text) what.appendChild(el('div', 'inv-text', e.text));
      if (e.conflicts) what.appendChild(el('div', 'pj-conflict', ['warn', 'edited on two devices (open it and save to settle)']));
      tr.append(td(e.date, 'inv-d'), td(e.by || e.created.who || '?'), td(ACT_LABEL[e.action] || e.action, 'inv-a inv-a-' + e.action), what);
      const ph = el('td'); if (e.photos.length) ph.appendChild(thumbs(e.photos.map(p => Object.assign({ date: e.date }, p)))); tr.appendChild(ph);
      tr.title = 'Open this entry to change or remove it';
      tr.addEventListener('click', () => editEntry(hit, e));
      tb.appendChild(tr);
    });
    if (!inv.log.length) { const tr = el('tr'), c = td('No entries yet.', 'inv-none'); c.colSpan = 5; tr.appendChild(c); tb.appendChild(tr); }
    t.appendChild(tb);
    return t;
  }
  /** The inventory's card: a node (full: the larger panel, with the whole log). */
  function card(hit, full) {
    const { inv, store } = hit, box = el('div', 'inv-card');
    box.dataset.inv = inv.id;
    if (inv.conflicts) Object.keys(inv.conflicts).forEach(k => box.appendChild(el('div', 'pj-conflict', ['warn', `${k}: edited on two devices — ` + inv.conflicts[k].map(c => `“${short(c.v, 30)}” (${c.who})`).join(' / ')])));
    const top = el('div', 'inv-top');
    if (window.uiSwitch) {
      const sw = window.uiSwitch(inv.mode === 'list', on => setMode(hit, on ? 'list' : 'log'), 'Keep as a simple list', { small: true, title: 'A plain list of what is there, instead of a dated log' });
      sw.classList.add('inv-modesw'); top.appendChild(sw);
    }
    box.appendChild(top);
    if (inv.mode === 'list') {
      const lines = inv.list.split('\n').map(s => s.trim()).filter(Boolean);
      const ul = el('div', 'inv-list');
      if (lines.length) lines.forEach(l => ul.appendChild(el('div', 'inv-li', l))); else ul.appendChild(el('div', 'inv-none', 'Nothing listed yet.'));
      box.appendChild(ul);
      const age = inv.listAge;
      box.appendChild(el('div', 'inv-foot' + (inv.stale ? ' inv-old' : ''), inv.stale ? ['warn', `Possibly out of date: the list was last edited ${age} days ago.`] : (inv.fieldBy.list ? 'List last edited ' + dayOf(inv.fieldBy.list.t) + (inv.fieldBy.list.who ? ' by ' + inv.fieldBy.list.who : '') : '')));
      const acts = el('div', 'inv-acts');
      acts.appendChild(btn(['pencil', 'Edit list…'], () => editList(hit), 'small inv-editlist'));
      box.appendChild(acts);
      if (inv.log.length) box.appendChild(el('div', 'inv-foot', `The log (${inv.log.length} entr${inv.log.length === 1 ? 'y' : 'ies'}) is kept; switch the list off to see it again.`));
    } else {
      box.appendChild(contentsTable(inv));
      if (inv.gone.length) box.appendChild(el('div', 'inv-foot', 'Gone: ' + inv.gone.map(g => g.name).join(', ')));
      const foot = !inv.contents.length ? '' : inv.checked ? 'Last checked ' + inv.checked + (inv.stale ? '.' : '') : 'Never checked.';
      if (foot || inv.stale) box.appendChild(el('div', 'inv-foot' + (inv.stale ? ' inv-old' : ''), inv.stale ? ['warn', foot + ' Possibly out of date (limit ' + Math.round(inv.staleDays / 30.4) + ' months).'] : foot));
      const acts = el('div', 'inv-acts');
      acts.appendChild(btn(['plus', 'Add entry'], () => addEntry(hit), 'small primary inv-add'));
      acts.appendChild(btn(['check', 'Check…'], () => addEntry(hit, null, { action: 'checked' }), 'small inv-check'));
      box.appendChild(acts);
      box.appendChild(el('div', 'inv-h', `Log (${inv.log.length})`));
      box.appendChild(logTable(hit, full));
      if (inv.photos.length) {
        box.appendChild(el('div', 'inv-h', `Photos (${inv.photos.length})`));
        box.appendChild(photoGrid(full ? inv.photos : inv.photos.slice(0, 6)));
      }
      if (!full && inv.log.length > 4) {
        const more = btn(openLogs.has(inv.id) ? 'Show only the latest' : `Show all ${inv.log.length} entries`, () => { openLogs.has(inv.id) ? openLogs.delete(inv.id) : openLogs.add(inv.id); box.replaceWith(card(hit, false)); }, 'link');
        box.appendChild(more);
      }
    }
    return box;
  }

  // ── The info panel's subject (info-panel.js) ───────────────────────────────
  const cartoOf = p => { const k = Cesium.Cartographic.fromCartesian(p); return [Cesium.Math.toDegrees(k.longitude), Cesium.Math.toDegrees(k.latitude), k.height]; };
  function subject(id) {
    const hit = lookup(id);
    if (!hit) return null;
    const { inv, store } = hit;
    const ent = src && src.entities.getById('inv-' + id);
    let pos = null;
    try { const p = ent && ent.position && ent.position.getValue(Cesium.JulianDate.now()); if (p) pos = cartoOf(p); } catch (_) {}
    const at = labelOf(inv.target);
    const facts = [['At', at], ['Kept in', store.mine ? 'My data' : 'Project “' + (pj.P.name || pj.pid) + '”'], ['Kept as', inv.mode === 'list' ? 'a simple list' : 'a dated log'],
      ['Last checked', inv.mode === 'list' ? '–' : inv.checked || 'never'], ['Entries', String(inv.log.length)]];
    if (inv.stale) facts.push(['Note', 'Possibly out of date']);
    if (pos) facts.push(['Position', `${pos[1].toFixed(6)}, ${pos[0].toFixed(6)}`], ['Height', window._units ? window._units.height(pos[2]) : pos[2].toFixed(1) + ' m']);
    return {
      key: 'inventory:' + id, kind: 'inventory', icon: '🧰', title: inv.name || 'Inventory', line: 'Inventory · ' + at + (store.mine ? ' · My data' : ''), facts, desc: inv.desc || '',
      target: null, pos, self: { target: inv.target }, ref: null, notes: [], leads: [], docs: [], hideInfo: true, canAdd: false,
      edit: () => editInventory(lookup(id) || hit), card: full => card(lookup(id) || hit, full), refresh: () => subject(id),
    };
  }

  // ── Station cards (project.js): the inventories at a station and a button ──
  const rowEl = x => {
    const { inv, store } = x, r = el('div', 'pj-item inv-row' + (inv.stale ? ' inv-old' : ''));
    r.dataset.inv = inv.id;
    r.appendChild(el('div', 'pj-item-t', ['chest', inv.name || 'Inventory']));
    r.appendChild(el('div', 'pj-sub', [labelOf(inv.target), FL.invLine(inv, 3)].filter(Boolean).join(' · ')));
    const st = inv.mode === 'list' ? 'a simple list' : inv.checked ? 'checked ' + inv.checked : inv.contents.length ? 'never checked' : 'nothing recorded';
    r.appendChild(el('div', 'pj-sub', st + (inv.stale ? ' · possibly out of date' : '') + (store.mine && pj.pid ? ' · My data' : '')));
    r.addEventListener('click', () => open(x, { fly: true }));
    return r;
  };
  function cardSection(box, c, before) {
    if (!c || !c.imp || c.survey || c.level === 'cave' || !c.name) return;
    const list = atStation(c.imp, c.code || '', c.name);
    if (!list.length) return;
    const put = n => box.insertBefore(n, before || null);
    put(el('div', 'pj-h', 'Inventories'));
    list.forEach(x => put(rowEl(x)));
  }
  const cardButton = c => btn(['chest', 'Inventory'], () => addAtStation(c.imp, c.code || '', c.name));
  /** The station card with no project (or a cave outside it): its inventories above, and the button beside Lead. */
  function cardNoProject(box, c) {
    if (!c || !c.imp || c.survey || c.level === 'cave' || !c.name) return;
    const row = box.querySelector(':scope > .pj-card-btns');          // the Lead button's row (flex-leads.js)
    cardSection(box, c, row);
    if (row) row.appendChild(cardButton(c));
    else { const r = el('div', 'pj-row pj-card-btns'); r.appendChild(cardButton(c)); box.appendChild(r); }
  }

  // ── ❓ Leads: the inventories, a section of the pane ───────────────────────
  function paneSection(root, section) {
    section(root, 'Inventories', true, b => {
      const list = all();
      if (!list.length) b.appendChild(el('div', 'pj-note', 'None yet. Right-click a station or a surface point on the map and choose Add inventory here… The chest keeps a dated log of what was left, taken and checked there.'));
      else {
        const old = list.filter(x => x.inv.stale).length;
        b.appendChild(el('div', 'pj-sub', `${list.length} inventor${list.length === 1 ? 'y' : 'ies'}` + (old ? ` · ${old} possibly out of date` : '')));
      }
      list.slice(0, 200).forEach(x => b.appendChild(rowEl(x)));
    });
  }

  // ── The export (export-ui.js → caves.json `inventories`) ───────────────────
  const payload = (inv, store) => Object.assign(FL.invPayload(FL.invMark(inv)), { kept: store.mine ? 'mine' : 'project' });
  /**
   * The inventories at the stations of one loaded cave file: the project's (cave of the open project) and My data's, once each.
   * stnByName: station name → station object (n/e/v, survey). → [{ s, station, data }]; the caller adds position and cave name.
   */
  function exportAt(imp, stnByName) {
    const out = [], mc = mineCid(imp);
    const caveOf = s => (pj.pid ? A.caveFor(imp, s.survey || '') : null);
    all().forEach(({ inv, store }) => {
      const t = FL.parseTarget(inv.target);
      if (t.kind !== 'station') return;
      const s = stnByName.get(t.name);
      if (!s) return;
      if (store.mine ? t.cave !== mc : caveOf(s) !== t.cave) return;
      out.push({ s, station: t.name, data: payload(inv, store) });
    });
    return out;
  }
  /** The inventories at surface points: [{ lon, lat, elev, data }] (the caller keeps those inside the export area). */
  function exportSurface() {
    const out = [];
    all().forEach(({ inv, store }) => {
      const t = FL.parseTarget(inv.target);
      if (t.kind !== 'feature') return;
      const F = featureOf(t.feature), c = F && F.f.coords && F.f.coords[0];
      if (!c) return;
      const own = !!(F.f.hsrc && !(F.f.style && F.f.style.ct));
      let h = c[2] || 0;
      if (!own && window._groundH) { const g = window._groundH.pos(c[0], c[1]); if (g && Number.isFinite(g.h)) h = g.h; }
      out.push({ lon: c[0], lat: c[1], elev: h, data: payload(inv, store) });
    });
    return out;
  }

  // ── Right-click a surface point: Add inventory here… ───────────────────────
  function wrapMenu() {
    const prev = window._selMenu;
    window._selMenu = canvasPos => {
      const items = typeof prev === 'function' ? (prev(canvasPos) || []) : [];
      try {
        const v = V(), picked = v && window.Cesium ? v.scene.pick(canvasPos) : null, ent = picked && picked.id;
        const pv = k => (ent && ent.properties && ent.properties[k] ? ent.properties[k].getValue() : null);
        const fid = ent ? (pv('isProjectFeature') ? pv('featureId') : pv('myFeature')) : null;
        const F = fid ? featureOf(fid) : null;
        if (F && F.f.kind === 'point') items.push({ inv: true, label: 'Add inventory here…', run: () => addAtFeature(fid) });
      } catch (e) { console.warn('[inventory] menu', e); }
      return items;
    };
  }

  // ── Look ───────────────────────────────────────────────────────────────────
  const css = document.createElement('style');
  css.textContent = `
  .inv-card { margin: 8px 0 2px; font-size: 11.5px; color: #e8e8ee; }
  .inv-top { display: flex; align-items: center; margin-bottom: 6px; }
  .inv-tbl { width: 100%; border-collapse: collapse; margin: 2px 0 4px; }
  .inv-tbl th { text-align: left; font-weight: 500; font-size: 10.5px; color: rgba(255,255,255,.5); padding: 2px 6px 2px 0; white-space: nowrap; border-bottom: 1px solid rgba(255,255,255,.12); }
  .inv-tbl td { padding: 3px 6px 3px 0; vertical-align: top; border-bottom: 1px solid rgba(255,255,255,.06); overflow-wrap: anywhere; }
  .inv-tbl td.inv-q { font-variant-numeric: tabular-nums; }
  .inv-tbl td.inv-never { color: rgba(255,255,255,.5); } .inv-tbl tr.inv-stale td:last-child { color: #f2c24e; }
  .inv-tbl td.inv-none { color: rgba(255,255,255,.5); font-style: italic; }
  .inv-log tr.inv-entry { cursor: pointer; } .inv-log tr.inv-entry:hover td { background: rgba(255,255,255,.05); }
  .inv-log tr.inv-conf td { background: rgba(255,159,28,.08); }
  .inv-a { white-space: nowrap; } .inv-a-left { color: #6fd39a; } .inv-a-took { color: #f09b7a; } .inv-a-checked { color: #8ab4ec; } .inv-a-note { color: rgba(255,255,255,.65); }
  .inv-d { white-space: nowrap; }
  .inv-text { color: rgba(255,255,255,.7); white-space: pre-wrap; }
  .inv-h { font-weight: 700; margin: 10px 0 2px; }
  .inv-foot { color: rgba(255,255,255,.55); font-size: 11px; margin: 2px 0 4px; } .inv-foot.inv-old { color: #f2c24e; }
  .inv-acts { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0 2px; } .inv-acts .pj-btn { margin: 0; }
  .inv-list { margin: 4px 0; padding: 4px 8px; background: rgba(255,255,255,.05); border-radius: 6px; } .inv-li { padding: 1px 0; overflow-wrap: anywhere; }
  .inv-thumbs { display: flex; flex-wrap: wrap; gap: 3px; } .inv-thumbs img { width: 30px; height: 30px; object-fit: cover; border-radius: 3px; cursor: zoom-in; background: #222; }
  .inv-thumbs.inv-edit { margin-bottom: 4px; } .inv-th { position: relative; display: inline-block; } .inv-th img { width: 56px; height: 56px; }
  .inv-th .pj-btn { position: absolute; top: -4px; right: -4px; margin: 0; padding: 0 4px; line-height: 14px; }
  .inv-row.inv-old .pj-sub:last-child { color: #f2c24e; }
  .inv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(74px, 1fr)); gap: 6px; margin: 2px 0 4px; }
  .inv-fig { margin: 0; } .inv-fig img { width: 100%; height: 62px; object-fit: cover; border-radius: 4px; cursor: zoom-in; background: #222; display: block; }
  .inv-fig figcaption { font-size: 10px; color: rgba(255,255,255,.6); text-align: center; margin-top: 1px; }
  .inv-items { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
  .inv-item { display: flex; gap: 4px; width: 100%; } .inv-item .pj-input { flex: 1; min-width: 0; } .inv-item .inv-qty { flex: none; width: 74px; }
  .inv-form .pj-f { margin-bottom: 2px; }
  .inv-lightbox { position: fixed; inset: 0; z-index: 100003; background: rgba(0,0,0,.88); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
  .inv-lightbox img { max-width: 92vw; max-height: 86vh; background: #fff; } .inv-lb-cap { color: #ddd; font: 12px system-ui, sans-serif; }`;
  document.head.appendChild(css);

  // ── Starting ───────────────────────────────────────────────────────────────
  const wait = setInterval(() => {
    if (!window._myData || !V() || !window.Cesium) return;
    clearInterval(wait);
    const cb = document.getElementById('lp-cave-inv-toggle'); if (cb) cb.checked = showOn;
    mineLoad(true).then(() => { redraw(); if (A.render) A.render(); });
  }, 400);
  wrapMenu();

  window._inventory = { all, lookup, load: mineLoad, redraw, visible, setVisible, addAtStation, addAtFeature, addEntry, editEntry, editInventory, setMode, subject, card, cardSection, cardButton, cardNoProject,
    paneSection, exportAt, exportSurface, stationPos, labelOf, open, lightbox, photoPages, atStation, carryPoints };
})();
