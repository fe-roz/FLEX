// FLEX project (field survey from the phones, drawn on its cave).
// Part of project.js, split into classic scripts that load in order (index.html);
// they share their functions through window._pjParts until project.js has loaded.
// Behaviour unchanged. See client/src/README.md.
(function () {
  'use strict';
  const X = window._pjParts;
  if (!X) return;                          // project-ui-kit.js found no flexlib.js
  const { $, api, pj, FIELD_COLOR, partsOf, FL, esc, stationPos, leadSummary } = X;

  // ── Field survey from the phones: drawn on its cave, view only ─────────────
  const declCache = new Map();
  async function declAt(lat, lon, year) {
    const k = `${lat.toFixed(2)},${lon.toFixed(2)},${Math.floor(year)}`;
    if (!declCache.has(k)) {
      try { declCache.set(k, (await (await fetch(`/api/declination?lat=${lat}&lon=${lon}&year=${year}`)).json()).declination); }
      catch (_) { declCache.set(k, null); }
    }
    return declCache.get(k);
  }
  const yearOf = d => { const t = Date.parse(d || ''); if (isNaN(t)) return new Date().getFullYear() + new Date().getMonth() / 12; const x = new Date(t); return x.getUTCFullYear() + x.getUTCMonth() / 12; };
  let fieldSrc = null, leadSrc = null;
  async function drawField() {
    const V = window.cesiumViewer;
    if (!V || !window.Cesium) return;
    if (!fieldSrc) { fieldSrc = new Cesium.CustomDataSource('pj-field'); V.dataSources.add(fieldSrc); }
    fieldSrc.entities.removeAll();
    pj.fieldPos = new Map();
    pj.fieldInfo = {};
    if (!pj.pid) return;
    const byCave = {};
    pj.P.order.forEach(id => { const sv = pj.P.surveys[id]; if (sv && sv.cave) (byCave[sv.cave] || (byCave[sv.cave] = [])).push(sv); });
    const color = Cesium.Color.fromCssColorString(FIELD_COLOR);
    for (const [cid, svs] of Object.entries(byCave)) {
      // Known stations of the cave, in a local east-north-up frame (true north).
      const known = new Map();
      let origin = null;
      partsOf(cid).forEach(({ imp, codes }) => {
        if (typeof imp._convertFn !== 'function') return;
        const add = (p, sv) => {
          if (!p.name || known.has(p.name) || !codes.has(sv || '')) return;
          const c = imp._convertFn(p.n, p.e, p.v);
          if (c) known.set(p.name, c);
        };
        (imp.parsed.stations || []).forEach(s => add(s, s.survey));
        (imp.parsed.segments || []).forEach(sg => sg.points.forEach(p => add(p, sg.survey)));
      });
      if (!known.size) continue;
      origin = known.values().next().value;
      const toFixed = Cesium.Transforms.eastNorthUpToFixedFrame(origin), toLocal = Cesium.Matrix4.inverse(toFixed, new Cesium.Matrix4());
      const loc = new Map();
      known.forEach((c, n) => { const p = Cesium.Matrix4.multiplyByPoint(toLocal, c, new Cesium.Cartesian3()); loc.set(n, [p.x, p.y, p.z]); });
      const carto = Cesium.Cartographic.fromCartesian(origin);
      const lat = Cesium.Math.toDegrees(carto.latitude), lon = Cesium.Math.toDegrees(carto.longitude);
      for (const sv of svs) {
        const entered = sv.decl != null && sv.decl !== '' && isFinite(Number(sv.decl)) ? Number(sv.decl) : null;
        const wmm = entered == null ? await declAt(lat, lon, yearOf(sv.date)) : null;
        const res = FL.computeSurvey(sv, loc, {
          decl: () => entered != null ? { v: entered, src: 'entered' } : wmm != null ? { v: wmm, src: 'WMM' } : { v: 0, src: 'unknown' },
          conv: () => 0,                                 // the local frame is true north
        });
        const W = a => Cesium.Matrix4.multiplyByPoint(toFixed, new Cesium.Cartesian3(a[0], a[1], a[2]), new Cesium.Cartesian3());
        res.legs.forEach(L => fieldSrc.entities.add({
          polyline: { positions: [W(L.a), W(L.b)], width: 3, material: color, depthFailMaterial: color.withAlpha(0.5) },
          properties: { isFieldShot: true, cave: cid, survey: sv.name, from: L.from, to: L.to },
        }));
        res.pos.forEach((p, name) => {
          if (known.has(name)) return;
          const w = W(p);
          pj.fieldPos.set(cid + '|' + name, w);
          fieldSrc.entities.add({
            position: w, point: { pixelSize: 7, color, outlineColor: Cesium.Color.BLACK, outlineWidth: 1, disableDepthTestDistance: 5000 },
            label: { text: name, font: '12px sans-serif', fillColor: color, pixelOffset: new Cesium.Cartesian2(8, -8), showBackground: true,
                     backgroundColor: Cesium.Color.BLACK.withAlpha(0.5), distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 400), disableDepthTestDistance: 5000 },
            name: `${name} (field)`,
            description: `Field survey “${esc(sv.name)}”${sv.date ? ', ' + esc(sv.date) : ''}${sv.team ? ' — ' + esc(sv.team) : ''}<br>Declination: ${res.decl.v.toFixed(2)}° (${res.decl.src})`,
            properties: { isFieldStation: true, cave: cid, stationName: name, survey: sv.name },
          });
        });
        pj.fieldInfo[sv.id] = { cave: cid, legs: res.legs.length, loose: res.loose.length, closures: res.closures, decl: res.decl };
      }
    }
    V.scene.requestRender && V.scene.requestRender();
  }
  // Active project leads (not the file's own, which FLEX already marks) as the
  // same "?" icon as file leads and FLEX Field; suggested ones (not accepted
  // yet) faded. A closed lead isn't drawn.
  function drawLeads() {
    const V = window.cesiumViewer;
    if (!V || !window.Cesium) return;
    if (!leadSrc) { leadSrc = new Cesium.CustomDataSource('pj-leads'); V.dataSources.add(leadSrc); }
    leadSrc.entities.removeAll();
    if (!pj.pid) return;
    const icon = typeof window._leadBillboardProps === 'function' ? window._leadBillboardProps() : null;
    const add = (target, fields, suggested, by, leadId) => {
      const t = FL.parseTarget(target);
      let pos = null, onGround = false, ownH = false, atLL = null;
      if (t.kind === 'station') pos = stationPos(t.cave, t.name);
      else if (t.kind === 'feature') {                  // a lead at a surface point (a dig)
        const f = pj.P.features[t.feature];
        // its own height if it has one (measured, surveyed, GPS), else the ground (ground-height.js)
        if (f && !f.removed && f.coords && f.coords.length) { pos = Cesium.Cartesian3.fromDegrees(f.coords[0][0], f.coords[0][1], f.coords[0][2] || 0); onGround = true; ownH = !!(f.hsrc && !(f.style && f.style.ct)); atLL = [f.coords[0][0], f.coords[0][1]]; }
      }
      if (!pos) return;
      const look = icon
        ? { billboard: Object.assign({}, icon, { color: suggested ? Cesium.Color.WHITE.withAlpha(0.45) : Cesium.Color.WHITE, scale: suggested ? 0.75 : 1, disableDepthTestDistance: 5000 },
                                     onGround ? { pixelOffset: new Cesium.Cartesian2(0, -12) } : {}) }
        : { label: { text: '?', font: 'bold 18px sans-serif', fillColor: Cesium.Color.fromCssColorString('#ffeb3b').withAlpha(suggested ? 0.5 : 1),
                     outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -14), disableDepthTestDistance: 5000 } };
      const le = leadSrc.entities.add(Object.assign({
        position: pos,
        name: (suggested ? 'Suggested lead at ' : 'Lead at ') + t.name,
        description: (suggested ? `Suggested by ${esc(by || '?')} — not accepted yet (Project → Suggestions).<br>` : '') + esc(leadSummary(fields)) + (fields.desc ? '<br>' + esc(fields.desc) : ''),
        properties: t.kind === 'feature' ? { isFeatureLead: true, leadId: leadId || '', isProjectLead: true, suggested: !!suggested }
          : { isFieldStation: true, cave: t.cave, stationName: t.name, isProjectLead: true, suggested: !!suggested },
      }, look));
      if (onGround && !ownH && window._groundH) window._groundH.track(le, atLL[0], atLL[1]);
    };
    Object.values(pj.P.leads).forEach(L => { if (!L.deleted && FL.leadActive(L) && L.source !== 'export') add(L.target, L.fields, false, null, L.id); });
    Object.values(pj.P.proposals).forEach(p => {
      const e = p.entry;
      if (p.state !== 'open' || e.op !== 'lead.set' || pj.P.leads[e.lead]) return;
      if (!FL.leadActive({ fields: e.fields || {} })) return;
      add(e.target, e.fields || {}, true, p.by);
    });
    V.scene.requestRender && V.scene.requestRender();
  }


  Object.assign(X, {
    declAt, yearOf, drawField, drawLeads,
  });
})();
