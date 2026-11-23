// ridge-marks.js — marks on ridgewalking features, the desktop's side.
// On the phone (FLEX Field, viewer_build/libs/ridge-marks.js) a feature of a "V2 - Ridgewalking" map is marked cave,
// pit, nothing or not reached, with a note. The marks are records of the project (rmark.set; the rules, the replay
// and the nearness matching are in viewer_build/libs/flexlib.js, "Ridgewalking marks") and come back in a sync
// file like everything else. Here, for the OPEN PROJECT:
//   - the map: a small round badge at each mark's own place (cave green, pit blue, nothing grey, not reached amber,
//     the phone's colours and letters), with its kind beside it when near; click it for the details panel: kind,
//     note, who, when, the depth and returns of the feature as it was, what was said before; the mark can be
//     changed and removed there too (a new record; the latest wins, as on the phone);
//   - ❓ Leads: a section "Ridgewalking marks" listing them, the latest first; a row flies to its mark;
//   - the export: window._ridgeMarks.exportIn(bbox, polygon) → the marks inside the area, which an export with
//     V2 - Ridgewalking carries so the phone shows them from the start (export-ui.js → --ridge-marks).
// A mark never changes what a ridgewalking run computes.
//
// window._ridgeMarks = { all, redraw, subject, paneSection, open, exportIn, set, create, setVisible }
(function () {
  'use strict';
  const A = window._pjApi, FL = window.FlexLib;
  if (!A || !FL || !FL.liveRmarks) return;
  const { pj, el, btn, toast } = A;
  const V = () => window.cesiumViewer;
  const ICON_PX = 22, SYMBOL = { cave: 'C', pit: 'P', nothing: '✕', unreached: '?' };
  const FT = 0.3048;
  const both = m => (m == null || !isFinite(m) ? '–' : (m / FT < 10 ? (m / FT).toFixed(1) : Math.round(m / FT)) + ' ft (' + (m < 10 ? (+m).toFixed(1) : Math.round(m)) + ' m)');
  const dayOf = t => { const d = t ? new Date(t) : null; return d && !isNaN(d) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; };
  const byLine = u => [u && u.who, dayOf(u && u.t)].filter(Boolean).join(' · ');
  const ENTRANCE = { true: 'True entrance', guessed: 'Guessed opening', none: 'No opening seen' };

  let src = null;
  const icons = {};
  function icon(kind) {
    if (icons[kind]) return icons[kind];
    const S = ICON_PX * 2, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 4, 0, Math.PI * 2); g.fillStyle = FL.RMARK_COLOURS[kind] || '#888'; g.fill();
    g.lineWidth = 3.5; g.strokeStyle = '#fff'; g.stroke();
    g.fillStyle = kind === 'unreached' ? '#222' : '#fff'; g.font = '700 ' + Math.round(S * 0.5) + 'px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(SYMBOL[kind] || '', S / 2, S / 2 + 1);
    return (icons[kind] = c);
  }
  /** The open project's live marks, the latest change first. */
  const all = () => (pj.pid && pj.P ? FL.liveRmarks(pj.P) : []);
  const lookup = id => (pj.pid && pj.P && pj.P.rmarks ? pj.P.rmarks[id] : null);

  /** One badge a mark, at its own place (its recorded height; the ground when it has none). */
  function redraw() {
    const v = V();
    if (!v || !window.Cesium) return;
    const C = Cesium;
    if (!src) { src = new C.CustomDataSource('flex-ridge-marks'); v.dataSources.add(src); }
    const want = new Map();
    all().forEach(m => want.set('rmark-' + m.id, m));
    src.entities.values.slice().forEach(e => { if (!want.has(e.id)) src.entities.remove(e); });
    want.forEach((m, id) => {
      const own = m.h != null && isFinite(m.h);
      const pos = C.Cartesian3.fromDegrees(m.lon, m.lat, own ? m.h + 1 : 0);
      const name = 'Marked: ' + FL.RMARK_LABELS[m.kind];
      let e = src.entities.getById(id);
      if (!e) {
        e = src.entities.add({ id, position: pos, name, properties: { isRidgeMark: true, markId: m.id, markKind: m.kind },
          billboard: { image: icon(m.kind), width: ICON_PX, height: ICON_PX, verticalOrigin: C.VerticalOrigin.BOTTOM, disableDepthTestDistance: 5000 },
          label: { text: FL.RMARK_LABELS[m.kind], font: '12px sans-serif', fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: C.VerticalOrigin.BOTTOM, pixelOffset: new C.Cartesian2(0, -ICON_PX - 2), distanceDisplayCondition: new C.DistanceDisplayCondition(0, 400), disableDepthTestDistance: 5000 } });
      } else {
        e.name = name; e.billboard.image = icon(m.kind); e.label.text = FL.RMARK_LABELS[m.kind]; e.properties.markKind = m.kind;
        if (own) e.position = pos;
      }
      if (!own && window._groundH) window._groundH.track(e, m.lon, m.lat);
    });
    src.show = showOn;
    v.scene.requestRender && v.scene.requestRender();
    try { window.dispatchEvent(new CustomEvent('flex-rmarks-changed')); } catch (_) {}       // ridge-draw.js ties the marks to its features
  }
  /** The badges on or off (the Marks switch of a processed area's Ridgewalking result, ridge-draw.js). */
  let showOn = true;
  function setVisible(on) { showOn = !!on; if (src) src.show = showOn; const v = V(); v && v.scene.requestRender && v.scene.requestRender(); }
  /** A new mark at a place: { kind, note, lon, lat, h, feat } → one record (flexlib's rmarkBody), or null. */
  async function create(o) {
    const body = FL.rmarkBody(null, o || {});
    if (!body) return null;
    const { op, ...data } = body;
    const e = await A.record(op, data);
    redraw();
    return e;
  }
  /** Select a mark's badge (its details open); fly there with fly: true. */
  function open(id, opts) {
    const v = V(), e = src && src.entities.getById('rmark-' + id);
    if (!v || !e) { toast('That mark is not on the map'); return false; }
    if (opts && opts.fly) { const p = e.position.getValue(Cesium.JulianDate.now()); if (p) v.camera.flyToBoundingSphere(new Cesium.BoundingSphere(p, 40), { duration: 1.2 }); }
    v.selectedEntity = e;
    return true;
  }
  /** Change a mark: { kind?, note?, removed? } → one new record (flexlib's rmarkBody), or nothing when nothing changes. */
  async function set(id, next) {
    const cur = lookup(id);
    if (!cur) return null;
    const body = FL.rmarkBody(cur, next);
    if (!body) return null;
    const { op, ...data } = body;
    const e = await A.record(op, data);
    redraw();
    if (window._info && window._info.changed) window._info.changed({ op: 'rmark.set' });
    return e;
  }

  // ── The details panel (info-panel.js) ─────────────────────────────────────
  function card(id) {
    const m = lookup(id), box = el('div', 'rm-card');
    if (!m) return box;
    // who, when and what the feature was: here, not only behind More
    const f = m.feat || {}, lines = [byLine(m.updated)];
    if (f.depth != null || f.returns != null) lines.push([f.depth != null ? both(f.depth) + ' deep' : '', f.returns != null ? f.returns + ' returns' : '', f.entrance ? (ENTRANCE[f.entrance] || '').toLowerCase() : ''].filter(Boolean).join(' \u00b7 ') + ' (when marked)');
    const before = m.history.filter(h => h.kind).slice(0, -1).map(h => FL.RMARK_LABELS[h.kind] + ' (' + byLine(h) + ')');
    if (before.length) lines.push('Before: ' + before.slice(-4).join(', '));
    lines.push(`${m.lat.toFixed(6)}, ${m.lon.toFixed(6)}`);
    lines.filter(Boolean).forEach(t => box.appendChild(el('div', 'pj-sub rm-fact', t)));
    const row = el('div', 'pj-row rm-kinds');
    FL.RMARK_KINDS.forEach(k => {
      const b = btn(FL.RMARK_LABELS[k], () => set(id, { kind: k }), 'small');
      b.dataset.kind = k;
      b.style.borderLeft = '6px solid ' + FL.RMARK_COLOURS[k];
      if (m.kind === k) { b.classList.add('active'); b.style.fontWeight = '700'; b.style.background = FL.RMARK_COLOURS[k] + '44'; }
      row.appendChild(b);
    });
    box.appendChild(row);
    const ta = el('textarea', 'pj-input rm-note'); ta.rows = 2; ta.placeholder = 'Note'; ta.value = m.note || ''; ta.style.width = '100%';
    box.appendChild(ta);
    const r2 = el('div', 'pj-row');
    r2.appendChild(btn('Save note', () => set(id, { note: ta.value }), 'small'));
    r2.appendChild(btn('Remove mark', () => set(id, { removed: true }), 'small'));
    box.appendChild(r2);
    return box;
  }
  function subject(id) {
    const m = lookup(id);
    if (!m || m.removed || !m.kind) return null;
    const f = m.feat || {};
    const facts = [['Mark', FL.RMARK_LABELS[m.kind]], ['By', byLine(m.updated)]];
    if (m.created && (m.created.who !== (m.updated || {}).who || m.created.t !== (m.updated || {}).t)) facts.push(['First marked', byLine(m.created)]);
    if (f.depth != null) facts.push(['Depth then', both(f.depth)]);
    if (f.returns != null) facts.push(['Returns then', String(f.returns)]);
    if (f.entrance) facts.push(['Seen as', ENTRANCE[f.entrance] || f.entrance]);
    const before = m.history.filter(h => h.kind).slice(0, -1).map(h => FL.RMARK_LABELS[h.kind] + ' (' + byLine(h) + ')');
    if (before.length) facts.push(['Before', before.slice(-4).join(', ')]);
    facts.push(['Position', `${m.lat.toFixed(6)}, ${m.lon.toFixed(6)}`]);
    if (m.h != null) facts.push(['Height', window._units ? window._units.height(m.h) : m.h.toFixed(1) + ' m']);
    return {
      key: 'rmark:' + id, kind: 'rmark', icon: '🏷', title: 'Marked: ' + FL.RMARK_LABELS[m.kind], line: 'Ridgewalking feature · marked in the field', facts, desc: m.note || '',
      target: null, pos: [m.lon, m.lat, m.h != null ? m.h : 0], self: {}, ref: null, notes: [], leads: [], docs: [], hideInfo: true, canAdd: false,
      card: () => card(id), refresh: () => subject(id),
    };
  }

  // ── ❓ Leads: the marks, a section of the pane ─────────────────────────────
  function paneSection(root, section) {
    const list = all();
    if (!pj.pid || !list.length) return;                       // (nothing to say on a project nobody ridgewalked)
    section(root, 'Ridgewalking marks', true, b => {
      const n = k => list.filter(m => m.kind === k).length;
      b.appendChild(el('div', 'pj-sub', `${list.length} mark${list.length === 1 ? '' : 's'} from the field: ` + FL.RMARK_KINDS.filter(n).map(k => n(k) + ' ' + FL.RMARK_LABELS[k].toLowerCase()).join(', ')));
      list.slice(0, 300).forEach(m => {
        const r = el('div', 'pj-item rm-row'); r.dataset.mark = m.id; r.dataset.kind = m.kind;
        const t = el('div', 'pj-item-t');
        const dot = el('span', 'rm-dot'); dot.style.cssText = 'display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:6px;vertical-align:-1px;background:' + FL.RMARK_COLOURS[m.kind];
        t.appendChild(dot); t.appendChild(document.createTextNode(FL.RMARK_LABELS[m.kind] + (m.feat && m.feat.depth != null ? ' · ' + both(m.feat.depth) + ' deep' : '')));
        r.appendChild(t);
        if (m.note) r.appendChild(el('div', 'pj-sub', m.note.length > 110 ? m.note.slice(0, 109) + '…' : m.note));
        r.appendChild(el('div', 'pj-sub', byLine(m.updated) + (m.history.length > 1 ? ' · changed ' + (m.history.length - 1) + ' time' + (m.history.length > 2 ? 's' : '') : '')));
        r.addEventListener('click', () => open(m.id, { fly: true }));
        b.appendChild(r);
      });
    });
  }
  /** The marks an export of this area carries (the box [w, s, e, n], and the polygon when there is one). */
  const exportIn = (bbox, ring) => (pj.pid && pj.P ? FL.rmarksPayload(pj.P, bbox, ring) : []);

  window._ridgeMarks = { all, redraw, subject, paneSection, open, exportIn, set, create, setVisible };
})();
