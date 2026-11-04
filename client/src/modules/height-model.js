// height-model.js — one height model for everything drawn on the map (window._heightModel). Builds on ground-height.js
// (window._groundH: the ground measured once and kept).
//
//   Cave data (lines, stations, shots, their labels)   its own surveyed height, never touched here.
//   CalTopo items, and project items once linked        the ground, measured once and kept (_groundH.track). A CalTopo
//   (style.ct)                                          entrance with a  flex: … z=<m>  tag is drawn at that surveyed height.
//   FLEX points: My data, project points not yet sent   their own stored height (coords z), measured from the finest
//                                                       terrain when made or moved, with where it came from:
//                                                         hsrc = { k: 'ground', t: <terrain key> }   measured from terrain t
//                                                              | { k: 'survey' | 'gps' | 'file' }    never touched here
//                                                         hsrc.fileH = the height the imported file had (shown as "File height")
//                                                       An item with no hsrc is "ground, terrain unknown": measured once
//                                                       and stored.
//   Imports (KML, GPX, GeoJSON, KMZ)                    each point's ground is measured once and stored; the file's own
//                                                       height is kept (fileH). A KMZ placemark with an altitude and
//                                                       absolute altitudeMode keeps the file's height (k 'file').
//   Lines and areas                                     stay draped on the terrain; no vertex heights.
//   Finer terrain                                       when terrain is added that covers items measured from a coarser
//                                                       one: a notice, "Update heights from the new terrain (N points)".
//
// API (window._heightModel):
//   stamp(lon, lat, keep?)   -> Promise<{ coords: [[lon, lat, h]], hsrc }>  ground measured now; keep = an hsrc that is not
//                               ground (survey / gps / file) is returned as given, with the height `keep.h` if any
//   classify(entity, ext)    -> { k: 'ground'|'file', fileH, lon, lat }  how an imported point's height is treated
//   placeDataSource(ds, ext) a data file's points drawn at ground (or file) height, no Cesium clamping
//   isOwn(f)                 a project point that keeps its own height (has hsrc, not linked to CalTopo)
//   register(name, provider) offer: provider = { list(): [{ id, lon, lat, hsrc }], store(updates): Promise }
//   check(), update(), offerState()      the stale-heights offer
(function () {
  'use strict';
  const G = () => window._groundH;
  const C = () => window.Cesium;
  const DEG = 180 / Math.PI;
  const HM = {};

  const ground = t => ({ k: 'ground', t });
  /** Measure the ground at a spot and say what answered. */
  async function stamp(lon, lat, keep) {
    lon = +(+lon).toFixed(7); lat = +(+lat).toFixed(7);
    if (keep && keep.k && keep.k !== 'ground') { const hs = Object.assign({}, keep); delete hs.h; return { coords: [[lon, lat, keep.h != null ? +keep.h : 0]], hsrc: hs }; }
    const g = G();
    if (!g) return { coords: [[lon, lat, 0]], hsrc: ground('') };
    const m = await g.measure(lon, lat);
    return { coords: [[lon, lat, +m.h.toFixed(2)]], hsrc: ground(m.t), exact: m.exact };
  }
  HM.stamp = stamp;
  HM.ground = ground;
  HM.isOwn = f => !!(f && f.hsrc && !(f.style && f.style.ct));
  /** Same measuring for a list of spots at once: [[lon, lat]…] → [{ h, t }]. */
  HM.stampMany = async list => (G() ? G().measureMany(list) : list.map(() => ({ h: 0, t: '' })));

  // ── Imported points ──────────────────────────────────────────────────────
  const hrOf = e => {
    const now = C().JulianDate.now();
    for (const k of ['billboard', 'point', 'label']) {
      const g = e[k]; if (!g || !g.heightReference) continue;
      const v = g.heightReference.getValue ? g.heightReference.getValue(now) : g.heightReference;
      if (v !== undefined) return v;
    }
    return undefined;
  };
  /**
   * How an imported point (a loaded KML / GPX / GeoJSON entity) is treated.
   * Cesium keeps the file's altitude only for absolute / relative modes; a clamped KML placemark holds a scaled position,
   * whose inner value is still the file's own. ext: the file's extension. Only a KMZ placemark with an altitude and
   * absolute mode (Cesium's heightReference NONE on a plain position) keeps the file's height.
   */
  function classify(e, ext) {
    const Cs = C(), now = Cs.JulianDate.now();
    let p = e.position, raw = null;
    try {
      if (p instanceof Cs.ScaledPositionProperty) p = p._value;
      raw = p && p.getValue ? p.getValue(now) : p;
    } catch (_) { raw = null; }
    if (!raw) return null;
    const k = Cs.Cartographic.fromCartesian(raw);
    const lon = k.longitude * DEG, lat = k.latitude * DEG, fh = Number.isFinite(k.height) ? k.height : 0;
    const scaled = e.position instanceof Cs.ScaledPositionProperty;
    const hr = hrOf(e);
    const absolute = !scaled && (hr === undefined || hr === Cs.HeightReference.NONE);
    const keepFile = String(ext || '').toLowerCase() === 'kmz' && absolute && Math.abs(fh) > 0.001;
    return { k: keepFile ? 'file' : 'ground', fileH: Math.abs(fh) > 0.001 ? +fh.toFixed(2) : null, lon, lat, raw };
  }
  HM.classify = classify;

  /**
   * A data file's point entities: drawn at their ground (measured once and kept by _groundH, no Cesium clamping) or, for
   * a KMZ placemark with an absolute altitude, at the file's height. The file's own height is put in the entity's
   * properties (fileHeight, heightSource) for the info panel.
   */
  function placeDataSource(ds, ext) {
    const Cs = C(); if (!Cs || !ds) return 0;
    let n = 0;
    ds.entities.values.forEach(e => {
        if (!e.position || e.polygon || e.polyline) return;
      if (!(e.billboard || e.point || e.label)) return;
      const c = classify(e, ext); if (!c) return;
      ['billboard', 'point', 'label'].forEach(k => { if (e[k]) e[k].heightReference = Cs.HeightReference.NONE; });
      try {
        if (!e.properties) e.properties = new Cs.PropertyBag();
        const set = (k, v) => { if (e.properties.hasProperty(k)) e.properties[k] = v; else e.properties.addProperty(k, v); };
        if (c.fileH != null) set('fileHeight', c.fileH);
        set('heightSource', c.k);
      } catch (_) {}
      if (c.k === 'file') e.position = new Cs.ConstantPositionProperty(Cs.Cartesian3.fromDegrees(c.lon, c.lat, c.fileH));
      else if (G()) G().track(e, c.lon, c.lat);
      else e.position = new Cs.ConstantPositionProperty(Cs.Cartesian3.fromDegrees(c.lon, c.lat, 0));
      n++;
      });
    return n;
  }
  HM.placeDataSource = placeDataSource;

  /** Facts for the info panel: [['Height source', …], ['File height', …]] from an hsrc or an entity's properties. */
  HM.facts = (hsrc, fileH, fmt) => {
    const out = [], f = fileH != null ? fileH : (hsrc && hsrc.fileH);
    const src = hsrc && hsrc.k;
    if (src) out.push(['Height from', { ground: 'terrain (measured when it was made)', survey: 'survey', gps: 'GPS', file: 'the file' }[src] || src]);
    if (f != null && Number.isFinite(+f)) out.push(['File height', fmt ? fmt(+f) : (+f).toFixed(1) + ' m']);
    return out;
  };

  // ── Stale heights: finer terrain than the one a stored height was measured from ─
  const providers = new Map();
  HM.register = (name, p) => providers.set(name, p);
  const S = { n: 0, items: [], dismissed: '', node: null, timer: null, busy: false };
  HM.offerState = () => ({ n: S.n, shown: !!(S.node && S.node.isConnected), dismissed: S.dismissed });
  function stale() {
    const g = G(), out = [];
    if (!g) return out;
    providers.forEach((p, name) => {
      let list = []; try { list = p.list() || []; } catch (_) {}
      list.forEach(it => { if (it.hsrc && it.hsrc.k === 'ground' && g.finer(it.hsrc.t, it.lon, it.lat)) out.push(Object.assign({ provider: name }, it)); });
    });
    return out;
  }
  const sigOf = items => items.length + ':' + items.map(i => G().keyAt(i.lon, i.lat)).sort().filter((x, i, a) => a.indexOf(x) === i).join('|');
  function hide() { if (S.node) { S.node.remove(); S.node = null; } }
  function show(items) {
    S.items = items; S.n = items.length;
    const txt = `Update heights from the new terrain (${items.length} point${items.length === 1 ? '' : 's'})`;
    if (S.node && S.node.isConnected) { S.node.querySelector('.hm-t').textContent = txt; return; }
    const d = document.createElement('div');
    d.id = 'hm-offer'; d.className = 'hm-offer';
    d.innerHTML = '<span class="hm-t"></span><button type="button" class="hm-up">Update</button><button type="button" class="hm-no">Not now</button>';
    d.querySelector('.hm-t').textContent = txt;
    d.querySelector('.hm-up').addEventListener('click', () => update());
    d.querySelector('.hm-no').addEventListener('click', () => { S.dismissed = sigOf(S.items); hide(); });
    document.body.appendChild(d);
    S.node = d;
  }
  /** Look for stored ground heights that finer terrain now covers; offer to update them (not automatic, not blocking). */
  function check() {
    const items = stale();
    if (!items.length) { S.n = 0; S.items = []; hide(); return 0; }
    if (sigOf(items) === S.dismissed) return items.length;
    show(items);
    return items.length;
  }
  HM.check = check;
  /** Measure again and store: ground-sourced ones only (the list was made from those). */
  async function update() {
    if (S.busy) return 0;
    S.busy = true;
    try {
      const items = stale();
      const ms = await G().measureMany(items.map(i => [i.lon, i.lat]));
      const by = new Map();
      items.forEach((it, i) => { if (!ms[i].exact) return; (by.get(it.provider) || by.set(it.provider, []).get(it.provider)).push({ id: it.id, coords: [[it.lon, it.lat, +ms[i].h.toFixed(2)]], hsrc: Object.assign({}, it.hsrc, { k: 'ground', t: ms[i].t }) }); });
      let n = 0;
      for (const [name, ups] of by) { await providers.get(name).store(ups); n += ups.length; }
      S.dismissed = ''; hide(); check();
      return n;
    } finally { S.busy = false; }
  }
  HM.update = update;
  const later = () => { clearTimeout(S.timer); S.timer = setTimeout(check, 1200); };
  window.addEventListener('flex-terrain-changed', later);
  window.addEventListener('flex-ground-heights', later);

  const st = document.createElement('style');
  st.textContent = `.hm-offer { position: fixed; left: 50%; bottom: 62px; transform: translateX(-50%); z-index: 9000; display: flex; align-items: center; gap: 8px;
      background: rgba(20,20,30,.94); color: #fff; font: 12.5px system-ui, sans-serif; padding: 7px 12px; border-radius: 6px; border: 1px solid #6fd39a; box-shadow: 0 2px 10px rgba(0,0,0,.5); }
    .hm-offer button { font: inherit; padding: 2px 9px; border-radius: 4px; border: 1px solid #556; background: #2a2f3a; color: #fff; cursor: pointer; }
    .hm-offer .hm-up { background: #2f8f5b; border-color: #2f8f5b; }`;
  document.head.appendChild(st);

  window._heightModel = HM;
})();
