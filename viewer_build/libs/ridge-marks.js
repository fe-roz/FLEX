/* FLEX Field / the portable viewer: marks on ridgewalking features.
 *
 * A map exported with "V2 - Ridgewalking" shows what the LiDAR saw below the ground (libs/ridgewalk.js). Here a
 * feature is tapped and marked in the field: cave, pit, nothing, or not reached, with a note. The rules live in
 * flexlib.js ("Ridgewalking marks", shared with FLEX on the PC): a mark is a record of the project (rmark.set), it
 * belongs to a PLACE (features are worked out again at every export), the latest wins and the history is kept, and
 * it is tied to a feature by nearness (FlexLib.rmarkMatch). This file is the phone's side:
 *
 *  - the list of features comes with the export (RIDGE.features: each feature's anchor, box, deepest point,
 *    returns, true entrance / guessed, lon / lat); marks come from the phone's library and from the export
 *    (RIDGE.marks: the marks the project had when the map was made; the library's wins for the same mark);
 *  - a tap on a feature (its shape, its hole or patch, its returns) opens a card: what it is, the four marks as
 *    big buttons, a note, who marked it and when, and what others said;
 *  - a marked feature carries a small badge (cave green, pit blue, nothing grey, not reached amber); a mark whose
 *    feature is no longer there is drawn at its own place, with a dashed rim; features marked "nothing" are
 *    dimmed (libs/ridgewalk.js greys their shape and returns), and can be hidden;
 *  - 🎨 Display: Marks, Hide "nothing" (remembered with the other display choices).
 *
 * Marks never change what is computed: "nothing" only dims and hides on this screen.
 * Two halves: the rules without a DOM (Node-tested by tools/test_viewer_ridge_marks.js) and the page.
 * Works as a classic script (window.RidgeMarks, after flexlib.js) and under Node (module.exports).
 */
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./flexlib.js') : root.FlexLib, root);
  if (node) module.exports = api;
  else root.RidgeMarks = api;
})(typeof self !== 'undefined' ? self : this, function (FL, root) {
  'use strict';

  /* ════════════════════════════ the rules (no DOM) ════════════════════════ */
  const FT = 0.3048;
  const SYMBOL = { cave: 'C', pit: 'P', nothing: '✕', unreached: '?' };
  const ENTRANCE = { true: 'True entrance', guessed: 'Guessed opening', none: 'Below ground, no opening seen' };
  const DEFAULTS = { marks: true, hideNothing: false };
  const STATE_V = 1;
  const TAP_PX = 28;                     // a tap this near a feature's anchor, middle or deepest point is on it
  const DIM_PAD_M = 0.4;                 // a "nothing" feature's box, this much wider, is what gets dimmed

  const num = v => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  /** "32 ft (9.9 m)": both units, always. */
  function both(m) {
    if (num(m) === null) return '—';
    const f = m / FT;
    return (f < 10 ? f.toFixed(1) : String(Math.round(f))) + ' ft (' + (m < 10 ? m.toFixed(1) : String(Math.round(m))) + ' m)';
  }
  /** The export's list as the module keeps it: each feature with its place in the scene and on the map, or []. */
  function cleanFeatures(list) {
    const out = [], seen = new Set();
    (Array.isArray(list) ? list : []).forEach((f, i) => {
      if (!f || num(f.x) === null || num(f.y) === null || num(f.z) === null) return;
      let id = f.id != null && f.id !== '' ? String(f.id) : 'i' + i;
      while (seen.has(id)) id += '\'';
      seen.add(id);
      const b = Array.isArray(f.box) && f.box.length === 6 && f.box.every(v => num(v) !== null) ? f.box.map(Number) : [f.x, f.y, f.z, f.x, f.y, f.z].map(Number);
      out.push({ id, x: +f.x, y: +f.y, z: +f.z, n: Math.max(0, Math.round(num(f.n) || 0)), deepest: Math.max(0, num(f.deepest) || 0), box: b,
                 entrance: f.entrance === 'true' || f.entrance === 'guessed' ? f.entrance : 'none', lon: num(f.lon), lat: num(f.lat) });
    });
    return out;
  }
  /** What a mark keeps about a feature (flexlib's `feat`). */
  const featHint = f => ({ id: f.id, depth: f.deepest, returns: f.n, entrance: f.entrance, size: [f.box[3] - f.box[0], f.box[4] - f.box[1], f.box[5] - f.box[2]] });
  /** A feature as the matcher reads it: its anchor's lon / lat / height and its box in metres round the anchor. */
  const matchFeature = f => ({ id: f.id, lon: f.lon, lat: f.lat, h: f.z, box: [f.box[0] - f.x, f.box[1] - f.y, f.box[3] - f.x, f.box[4] - f.y] });
  /**
   * The marks to show: the library's live marks, and the export's marks the library does not know (by id; a mark the
   * library has removed stays removed). → [mark] (the export's are flagged `exported`).
   */
  function effective(project, exported) {
    const lib = (project && project.rmarks) || {};
    const out = FL.liveRmarks(project);
    (Array.isArray(exported) ? exported : []).forEach(x => { const m = FL.rmarkFromExport(x); if (m && !lib[m.id]) out.push(m); });
    return out;
  }
  /** Marks against features: FlexLib.rmarkMatch on the module's features (those with a place on the map). */
  const match = (marks, features) => FL.rmarkMatch(marks, features.filter(f => f.lon !== null && f.lat !== null).map(matchFeature));
  /**
   * The record a tap on a mark button makes. f: the feature (null for a mark on its own), cur: the mark that speaks for
   * it now (or the lone mark), next: { kind?, note?, removed? }. → the body for ffRecord ({ op, … }) or null (no change).
   * A mark the library does not have yet (it came in the export) is taken in whole, under its own id, so every phone
   * that does it makes the same mark.
   */
  function markBody(f, cur, next) {
    if (cur && !cur.exported) return FL.rmarkBody(cur, next);
    if (cur && cur.exported) {
      if (next.removed) { const b = FL.rmarkBody(null, { id: cur.id, kind: cur.kind, note: cur.note, lon: cur.lon, lat: cur.lat, h: cur.h, feat: cur.feat }); return b && Object.assign(b, { removed: true }); }
      const kind = next.kind || cur.kind, note = next.note != null ? next.note : cur.note;
      if (kind === cur.kind && String(note).trim() === cur.note) return null;
      return FL.rmarkBody(null, { id: cur.id, kind, note, lon: cur.lon, lat: cur.lat, h: cur.h, feat: f ? featHint(f) : cur.feat });
    }
    if (!f || !next.kind || f.lon === null || f.lat === null) return null;
    return FL.rmarkBody(null, { kind: next.kind, note: next.note || '', lon: f.lon, lat: f.lat, h: f.z, feat: featHint(f) });
  }
  /** The card's lines for a feature: [[label, text]]. */
  function featureRows(f) {
    const w = Math.max(f.box[3] - f.box[0], f.box[4] - f.box[1]), n = Math.min(f.box[3] - f.box[0], f.box[4] - f.box[1]);
    return [['Depth', both(f.deepest)], ['Returns', String(f.n)], ['Size', both(w) + ' × ' + both(n)]];
  }
  /** "Ana · 20 Nov 2026" */
  function byLine(who, t) {
    const d = t ? new Date(t) : null;
    const day = d && !isNaN(d) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    return [who || '', day].filter(Boolean).join(' · ');
  }
  /** The change log's wording for an rmark.set. */
  function describe(e) {
    if (e.removed === true) return 'Mark on a ridgewalking feature removed';
    if (e.removed === false && !e.kind) return 'Mark on a ridgewalking feature put back';
    const k = e.kind ? (FL.RMARK_LABELS[e.kind] || e.kind) : null, note = e.note ? ' — “' + String(e.note).slice(0, 60) + '”' : '';
    if (e.prev === null) return 'Ridgewalking feature marked: ' + (k || '?') + note;
    return 'Ridgewalking mark ' + (k ? 'changed to ' + k : 'note changed') + note;
  }
  function restore(saved) {
    const st = Object.assign({}, DEFAULTS);
    if (saved && typeof saved === 'object' && saved.v === STATE_V) Object.keys(DEFAULTS).forEach(k => { if (typeof saved[k] === 'boolean') st[k] = saved[k]; });
    return st;
  }
  /** The boxes ([x0, y0, z0, x1, y1, z1], scene) of the features a "nothing" mark speaks for. */
  function nothingBoxes(features, M) {
    return features.filter(f => M.byFeature[f.id] && M.byFeature[f.id].mark.kind === 'nothing')
      .map(f => [f.box[0] - DIM_PAD_M, f.box[1] - DIM_PAD_M, f.box[2] - DIM_PAD_M, f.box[3] + DIM_PAD_M, f.box[4] + DIM_PAD_M, f.box[5] + DIM_PAD_M]);
  }
  /**
   * Which feature a tap is on. pts: for each feature the screen places [x, y] (pixels) of its anchor, its middle and its
   * deepest point, or null when behind the camera; rect: its box on the screen [x0, y0, x1, y1] or null.
   * → { i, d } (index, pixels) of the feature nearest the tap within TAP_PX, else of the smallest box the tap is in, else null.
   */
  function nearestTap(px, py, shown) {
    let best = null, inBox = null;
    for (let i = 0; i < shown.length; i++) {
      const s = shown[i]; if (!s) continue;
      for (let k = 0; k < s.pts.length; k++) { const p = s.pts[k]; if (!p) continue; const d = Math.hypot(p[0] - px, p[1] - py); if (d <= TAP_PX && (!best || d < best.d)) best = { i, d }; }
      const r = s.rect;
      if (r && px >= r[0] && px <= r[2] && py >= r[1] && py <= r[3]) { const a = (r[2] - r[0]) * (r[3] - r[1]); if (!inBox || a < inBox.a) inBox = { i, a, d: TAP_PX * 0.75 }; }
    }
    return best || (inBox ? { i: inBox.i, d: inBox.d } : null);
  }

  /* ════════════════════════════ the page ══════════════════════════════════ */
  let S = null;      // everything of the running viewer; null = no feature list (a normal export, or an older ridge export)

  function loadList(ref, key) {
    if (Array.isArray(ref)) return Promise.resolve(ref);
    if (typeof ref === 'string' && ref) return fetch(ref).then(r => (r.ok ? r.json() : null)).then(j => (j && Array.isArray(j[key]) ? j[key] : [])).catch(() => []);
    return Promise.resolve([]);
  }
  function badgeTexture(kind, alone) {
    const key = kind + (alone ? ':a' : '');
    if (S.tex[key]) return S.tex[key];
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    g.beginPath(); g.arc(32, 32, 25, 0, Math.PI * 2); g.fillStyle = FL.RMARK_COLOURS[kind] || '#888'; g.fill();
    g.lineWidth = 5; g.strokeStyle = '#fff'; if (alone) g.setLineDash([9, 7]); g.stroke();
    g.fillStyle = kind === 'unreached' ? '#222' : '#fff'; g.font = '700 30px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(SYMBOL[kind] || '', 32, 34);
    const t = new S.THREE.CanvasTexture(c);
    return (S.tex[key] = t);
  }
  function refresh() {
    if (!S) return;
    const T = S.THREE;
    S.marks = effective(S.project ? S.project() : null, S.exported);
    S.M = match(S.marks, S.features);
    S.badges.forEach(b => S.group.remove(b)); S.badges = [];
    const add = (kind, alone, x, y, z, ref) => {
      const sp = new T.Sprite(new T.SpriteMaterial({ map: badgeTexture(kind, alone), depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true, fog: false }));
      sp.scale.set(0.042, 0.042, 1); sp.center.set(0.5, 0); sp.position.set(x, y, z); sp.renderOrder = 9; sp.name = 'rmark-' + kind + (alone ? '-alone' : '');
      sp.userData = ref; sp.raycast = function () {};
      sp.visible = S.st.marks && !(S.st.hideNothing && kind === 'nothing');
      S.group.add(sp); S.badges.push(sp);
    };
    S.features.forEach(f => { const m = S.M.byFeature[f.id]; if (m) add(m.mark.kind, false, f.x, f.y, f.z + 1.5, { feature: f.id }); });
    S.M.alone.forEach(m => {
      const p = S.toScene(m.lat, m.lon); if (!p) return;
      let z = num(m.h); if (z === null) { z = S.groundZ ? S.groundZ(p.x, p.y) : null; if (z === null || !isFinite(z)) z = 0; }
      m._scene = [p.x, p.y, z];
      add(m.kind, true, p.x, p.y, z + 1.5, { mark: m.id });
    });
    if (S.ridge && S.ridge.setDim) S.ridge.setDim(S.st.marks ? nothingBoxes(S.features, S.M) : [], S.st.marks && S.st.hideNothing);
    if (S.card && S.card.ref) renderCard();
    if (S.redraw) S.redraw();
  }
  // Where things are on the screen (pixels in the canvas's rect), or null behind the camera.
  function toPx(v, rect) { const q = v.project(S.camera); return q.z > 1 || q.z < -1 ? null : [(q.x + 1) / 2 * rect.width, (1 - q.y) / 2 * rect.height]; }
  function pick(px, py, rect) {
    if (!S || !S.features.length && !(S.M && S.M.alone.length)) return null;
    const T = S.THREE, v = new T.Vector3();
    const P = (x, y, z) => toPx(v.set(x, y, z), rect);
    const hiddenNothing = f => S.st.marks && S.st.hideNothing && S.M.byFeature[f.id] && S.M.byFeature[f.id].mark.kind === 'nothing';
    const shown = S.features.map(f => {
      if (hiddenNothing(f)) return null;
      const b = f.box, pts = [P(f.x, f.y, f.z), P((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2), P((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, b[2])];
      if (!pts[0] && !pts[1]) return null;
      let rect2 = null;
      if (Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) > 3) {             // a large feature: anywhere over it counts
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, ok = true;
        for (let k = 0; k < 8 && ok; k++) { const q = P(k & 1 ? b[3] : b[0], k & 2 ? b[4] : b[1], k & 4 ? b[5] : b[2]); if (!q) ok = false; else { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); } }
        if (ok) rect2 = [x0, y0, x1, y1];
      }
      return { pts, rect: rect2 };
    });
    const hit = nearestTap(px, py, shown);
    let lone = null;
    if (S.st.marks) S.M.alone.forEach(m => { if (!m._scene) return; const q = P(m._scene[0], m._scene[1], m._scene[2] + 1.5); if (!q) return; const d = Math.hypot(q[0] - px, q[1] - 12 - py); if (d <= TAP_PX && (!lone || d < lone.d)) lone = { mark: m.id, d }; });
    if (lone && (!hit || lone.d < hit.d)) return lone;
    return hit ? { feature: S.features[hit.i].id, d: hit.d } : null;
  }

  // ── the card ──
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function ensureCard() {
    if (S.card) return S.card;
    if (!document.getElementById('rm-style')) {
      const st = el('style'); st.id = 'rm-style';
      st.textContent = '#rm-card{position:fixed;left:10px;bottom:10px;z-index:60;width:min(340px,calc(100vw - 86px));max-height:70vh;overflow:auto;background:rgba(14,14,20,.94);color:#eee;border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:12px 12px 10px;font:13px system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5)}' +
        '#rm-card h3{margin:0 26px 2px 0;font-size:15px}#rm-card .rm-sub{opacity:.6;font-size:12px;margin-bottom:8px}#rm-card .rm-x{position:absolute;right:8px;top:6px;background:none;border:0;color:#eee;font-size:20px;padding:4px 8px}' +
        '#rm-card .rm-rows{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin-bottom:8px}#rm-card .rm-rows span:nth-child(odd){opacity:.55}' +
        '#rm-card .rm-btns{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0}#rm-card .rm-btn{min-height:46px;border-radius:9px;border:2px solid rgba(255,255,255,.22);background:rgba(255,255,255,.06);color:#eee;font:600 14px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;gap:8px}' +
        '#rm-card .rm-btn i{width:14px;height:14px;border-radius:50%;display:inline-block}#rm-card .rm-btn.a{color:#fff}' +
        '#rm-card textarea{width:100%;box-sizing:border-box;min-height:46px;background:rgba(255,255,255,.07);color:#eee;border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:6px 8px;font:13px system-ui,sans-serif}' +
        '#rm-card .rm-by{font-size:12px;margin:4px 0}#rm-card .rm-also{font-size:12px;opacity:.7}#rm-card .rm-foot{display:flex;gap:6px;justify-content:space-between;margin-top:6px}#rm-card .rm-small{background:none;border:1px solid rgba(255,255,255,.25);color:#eee;border-radius:7px;padding:5px 9px;font-size:12px}';
      document.head.appendChild(st);
    }
    const c = el('div'); c.id = 'rm-card'; c.style.display = 'none';
    ['pointerdown', 'click', 'touchstart', 'wheel'].forEach(ev => c.addEventListener(ev, e => e.stopPropagation()));
    document.body.appendChild(c);
    return (S.card = { el: c, ref: null });
  }
  function current(ref) {          // { f, cur, also } for a card's subject
    if (ref.feature != null) { const f = S.features.find(x => x.id === ref.feature), m = f && S.M.byFeature[f.id]; return { f, cur: m ? m.mark : null, also: m ? m.also : [] }; }
    const m = S.M.alone.find(x => x.id === ref.mark) || S.marks.find(x => x.id === ref.mark);
    return { f: null, cur: m || null, also: [] };
  }
  function renderCard() {
    const card = ensureCard(), { f, cur, also } = current(card.ref), c = card.el;
    if (!f && !cur) { closeCard(); return; }
    const keepNote = c.querySelector('textarea') && document.activeElement === c.querySelector('textarea') ? c.querySelector('textarea').value : null;
    c.textContent = '';
    const x = el('button', 'rm-x', '×'); x.title = 'Close'; x.addEventListener('click', closeCard); c.appendChild(x);
    c.appendChild(el('h3', '', f ? 'Ridgewalking feature' : 'Mark with no feature'));
    c.appendChild(el('div', 'rm-sub', f ? ENTRANCE[f.entrance] : 'Nothing is seen here on this map: the mark is kept at its own place.'));
    const rows = el('div', 'rm-rows');
    (f ? featureRows(f) : (cur && cur.feat ? [['Depth then', both(cur.feat.depth)], ['Returns then', cur.feat.returns != null ? String(cur.feat.returns) : '—']] : [])).forEach(r => { rows.appendChild(el('span', '', r[0])); rows.appendChild(el('span', '', r[1])); });
    c.appendChild(rows);
    if (cur) {
      const by = el('div', 'rm-by'); by.appendChild(el('b', '', 'Marked ' + FL.RMARK_LABELS[cur.kind])); by.appendChild(document.createTextNode('  ' + byLine(cur.updated && cur.updated.who, cur.updated && cur.updated.t) + (cur.exported ? ' · from the export' : '')));
      c.appendChild(by);
      const hist = (cur.history || []).filter(h => h.kind).slice(0, -1).reverse().slice(0, 4).map(h => FL.RMARK_LABELS[h.kind] + ' (' + byLine(h.who, h.t) + ')');
      const others = also.map(m => FL.RMARK_LABELS[m.kind] + ' (' + byLine(m.updated && m.updated.who, m.updated && m.updated.t) + ')' + (m.note ? ': ' + m.note : ''));
      if (others.length) c.appendChild(el('div', 'rm-also', 'Also marked: ' + others.join('; ')));
      if (hist.length) c.appendChild(el('div', 'rm-also', 'Before: ' + hist.join(', ')));
    }
    const btns = el('div', 'rm-btns');
    FL.RMARK_KINDS.forEach(k => {
      const b = el('button', 'rm-btn' + (cur && cur.kind === k ? ' a' : '')); b.dataset.kind = k;
      const dot = el('i'); dot.style.background = FL.RMARK_COLOURS[k]; b.appendChild(dot); b.appendChild(el('span', '', FL.RMARK_LABELS[k]));
      if (cur && cur.kind === k) { b.style.borderColor = FL.RMARK_COLOURS[k]; b.style.background = FL.RMARK_COLOURS[k] + '55'; }
      b.addEventListener('click', () => setMark(card.ref, { kind: k, note: c.querySelector('textarea').value }));
      btns.appendChild(b);
    });
    c.appendChild(btns);
    const ta = el('textarea'); ta.placeholder = 'Note (optional): what is there, what it needs'; ta.value = keepNote != null ? keepNote : (cur ? cur.note : ''); ta.maxLength = 2000;
    c.appendChild(ta);
    const foot = el('div', 'rm-foot');
    const save = el('button', 'rm-small', 'Save note'); save.dataset.act = 'note';
    save.addEventListener('click', () => { if (cur) setMark(card.ref, { note: ta.value }); else if (S.toast) S.toast('Choose a mark first'); });
    foot.appendChild(save);
    if (cur) { const clr = el('button', 'rm-small', 'Remove mark'); clr.dataset.act = 'remove'; clr.addEventListener('click', () => setMark(card.ref, { removed: true })); foot.appendChild(clr); }
    c.appendChild(foot);
    c.style.display = '';
  }
  function open(ref) {
    if (!S) return;
    if (typeof ref === 'string') ref = { feature: ref };
    ensureCard().ref = ref.feature != null ? { feature: ref.feature } : { mark: ref.mark };
    renderCard();
    if (S.redraw) S.redraw();
  }
  function closeCard() { if (S && S.card) { S.card.ref = null; S.card.el.style.display = 'none'; } }
  // A tap on a mark button: needs a project (asked for, as the rest of the viewer does), then one record.
  async function setMark(ref, next) {
    if (!S) return null;
    if (S.hasProject && !S.hasProject()) {
      if (S.ensureProject) await S.ensureProject();
      if (!S.hasProject()) { if (S.toast) S.toast('No project for this map yet'); return null; }
      refresh();
    }
    const { f, cur } = current(ref);
    const body = markBody(f, cur, next);
    if (!body) return null;
    if (S.ensureAuthor) { try { await S.ensureAuthor(); } catch (_) {} }       // who is marking (asked once, as for a note)
    const { op, ...data } = body;
    const e = S.record(op, data);
    refresh();
    if (S.card && S.card.ref && ref.feature == null && next.removed) closeCard();
    return e;
  }

  const R = {
    DEFAULTS, STATE_V, TAP_PX, SYMBOL, ENTRANCE, both, cleanFeatures, featHint, matchFeature, effective, match, markBody, featureRows, byLine, describe, restore, nothingBoxes, nearestTap,
    inverse: e => FL.rmarkUndo(e),

    // o: { THREE, scene, camera, features, marks (RIDGE's: a list or a file name each), saved, ridge (FlexRidge), project(),
    //      hasProject(), ensureProject(), ensureAuthor(), record(op, data), toScene(lat, lon) -> { x, y }, toLonLat(x, y) -> { lat, lon },
    //      groundZ(x, y), toast(text), redraw() }.  Resolves true when there is a list of features (or marks) to work with.
    init(o) {
      S = null;
      if (!o || (!o.features && !o.marks)) return Promise.resolve(false);
      return Promise.all([loadList(o.features, 'features'), loadList(o.marks, 'marks')]).then(([fl, ml]) => {
        const features = cleanFeatures(fl);
        features.forEach(f => { if ((f.lon === null || f.lat === null) && o.toLonLat) { const ll = o.toLonLat(f.x, f.y); if (ll) { f.lon = num(ll.lon); f.lat = num(ll.lat); } } });
        if (!features.length && !ml.length) return false;
        S = { THREE: o.THREE, scene: o.scene, camera: o.camera, features, exported: ml, st: restore(o.saved), ridge: o.ridge, project: o.project, hasProject: o.hasProject,
              ensureProject: o.ensureProject, ensureAuthor: o.ensureAuthor, record: o.record, toScene: o.toScene, groundZ: o.groundZ, toast: o.toast, redraw: o.redraw,
              group: new o.THREE.Group(), badges: [], tex: {}, marks: [], M: { byFeature: {}, alone: [], ofMark: {} }, card: null };
        S.group.name = 'ridge-marks'; S.scene.add(S.group);
        refresh();
        return true;
      });
    },
    active: () => !!S,
    refresh, pick, open, closeCard, setMark,
    state: () => (S ? Object.assign({}, S.st) : null),
    serialize: () => (S ? Object.assign({ v: STATE_V }, S.st) : undefined),
    // What is there: { features, marks, matched: { <feature id>: kind }, alone: [mark ids], badges }
    objects: () => (S ? { features: S.features, marks: S.marks, matched: Object.fromEntries(Object.entries(S.M.byFeature).map(([k, v]) => [k, v.mark.kind])), alone: S.M.alone.map(m => m.id), badges: S.badges, group: S.group } : null),
    set(key, v) {
      if (!S || !(key in DEFAULTS)) return;
      S.st[key] = !!v;
      refresh();
    },
    // The rows in Display (after "Below ground (V2)"). ui: { head, chips }.
    sheet(ui) {
      if (!S) return;
      const n = S.marks.length;
      ui.head('Marks on features' + (n ? ' (' + n + ')' : ''));
      ui.chips([['🏷', 'Marks', !!S.st.marks, on => R.set('marks', on)], ['🚫', 'Hide “nothing”', !!S.st.hideNothing, on => R.set('hideNothing', on)]]);
    },
  };
  return R;
});
