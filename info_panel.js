// info_panel.js — what a click on the map shows, in two steps.
//
//   Brief      in the details panel on the right (inspector.js): the name,
//              what it is, a few lines and how many photos, videos,
//              documents, notes and leads go with it. Clicking never edits.
//   Expanded   hovering the details panel a moment opens a larger panel
//              beside it with everything: position and height, the whole
//              description, notes, leads, photos and videos (played here),
//              documents. It goes away when the pointer leaves, unless it
//              was dragged by its header, pinned (📌) or used (a click
//              inside, e.g. on a video). × or Esc closes it.
//   Edit       a second step: ✏️ Edit in either panel.
//
// What it can show (a "subject"): a project's own point, line or area
// (project_features.js), a lead on a surface point, a cave, survey or station
// (their card in the details panel is the brief; selection.js, project.js),
// and any other map entity — CalTopo and data-file features, My data points
// (Cesium's own info box stays their brief). Generic for now: each kind can
// get its own look later.
//
// A video plays only here or in the document viewer (project.js), and stops
// for good — paused, source dropped, element removed — when this panel
// closes, collapses, changes subject or the document viewer opens.
(function () {
  'use strict';
  const A = window._pjApi;
  if (!A) { console.warn('[info] project.js missing'); return; }
  const { pj, FL, el, btn, esc } = A;
  const V = () => window.cesiumViewer;
  const API = '/api/lib/';
  const HOVER_MS = 600, LEAVE_MS = 450;
  const I = { subject: null, x: null, pinned: false, moved: false, tOpen: 0, tClose: 0, overIns: false, overX: false };
  window._infoState = I;                                  // tests

  // ── Subjects ─────────────────────────────────────────────────────────────
  const prop = (e, k) => (e && e.properties && e.properties[k] ? e.properties[k].getValue() : null);
  const KIND = { point: 'Point', line: 'Line', area: 'Area' }, KICON = { point: '📍', line: '〰️', area: '⬠' };
  const fmtLen = m => (m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m');
  function lenOf(cs) {
    let L = 0;
    for (let i = 1; i < cs.length; i++) {
      const [a, b] = [cs[i - 1], cs[i]], k = Math.PI / 180;
      const dl = (b[1] - a[1]) * k, dn = (b[0] - a[0]) * k, m = (a[1] + b[1]) / 2 * k;
      L += 6371008 * Math.hypot(dl, dn * Math.cos(m));
    }
    return L;
  }
  function areaOf(cs) {
    const lat0 = cs[0][1] * Math.PI / 180, mx = 111320 * Math.cos(lat0), my = 110540;
    let s = 0;
    for (let i = 0; i < cs.length; i++) { const a = cs[i], b = cs[(i + 1) % cs.length]; s += a[0] * mx * b[1] * my - b[0] * mx * a[1] * my; }
    return Math.abs(s / 2);
  }
  const fmtArea = a => (a >= 1e6 ? (a / 1e6).toFixed(2) + ' km²' : a >= 1e4 ? (a / 1e4).toFixed(2) + ' ha' : Math.round(a) + ' m²');
  const latlon = c => `${c[1].toFixed(6)}, ${c[0].toFixed(6)}`;
  // Ground height under a spot from the globe, when its tiles are in.
  function groundAt(lon, lat) {
    const v = V(); if (!v || !window.Cesium) return null;
    try { const h = v.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(lon, lat)); return Number.isFinite(h) ? h : null; } catch (_) { return null; }
  }
  function heightFacts(c) {
    const out = [];
    if (c[2]) out.push(['Height', c[2].toFixed(1) + ' m']);
    else { const g = groundAt(c[0], c[1]); if (g != null) out.push(['Ground height', g.toFixed(1) + ' m']); }
    return out;
  }
  const uniq = ds => { const seen = new Set(); return ds.filter(d => d && !seen.has(d.id) && seen.add(d.id)); };
  const docsOn = t => (pj.D ? FL.docsForTarget(pj.D, t) : []);
  const leadItem = L => ({ id: L.id, rec: L, fields: L.fields, active: FL.leadActive(L) });

  function featureSubject(id) {
    const f = pj.P && pj.P.features[id];
    if (!f || f.removed) return null;
    const t = FL.T.feature(id), cs = f.coords || [];
    const leads = Object.values(pj.P.leads).filter(L => !L.deleted && L.target === t);
    const folder = f.group ? FL.groupPath(pj.P, f.group).map(g => g.name).join(' / ') : '';
    const facts = [['Kind', KIND[f.kind] || f.kind], ['Folder', folder || '(top level)']];
    if (f.kind === 'point' && cs[0]) facts.push(['Position', latlon(cs[0])], ...heightFacts(cs[0]));
    if (f.kind === 'line' && cs.length) facts.push(['Length', fmtLen(lenOf(cs))], ['Points', String(cs.length)], ['Starts at', latlon(cs[0])]);
    if (f.kind === 'area' && cs.length > 2) facts.push(['Area', fmtArea(areaOf(cs))], ['Perimeter', fmtLen(lenOf(cs.concat([cs[0]])))], ['Points', String(cs.length)]);
    return {
      key: 'feature:' + id, kind: 'feature', icon: KICON[f.kind] || '•', title: f.name || KIND[f.kind] || 'Feature',
      line: [KIND[f.kind], folder].filter(Boolean).join(' · '), color: window._pjf ? window._pjf.colorOf(f) : null,
      facts, desc: f.desc || '', target: t,
      notes: FL.notesOn(pj.P, t), leads: leads.map(L => ({ item: leadItem(L), label: A.targetLabel(t) })),
      docs: uniq(docsOn(t).concat(...leads.map(L => docsOn(FL.T.lead(L.id))))),
      edit: () => window._pjf && window._pjf.editFeature(id), hideInfo: true, canAdd: true,
    };
  }
  function leadSubject(id) {
    const L = pj.P && pj.P.leads[id];
    if (!L || L.deleted) return null;
    const at = A.targetLabel(L.target), p = FL.parseTarget(L.target), f = p.kind === 'feature' ? pj.P.features[p.feature] : null;
    const facts = [['Status', FL.statusLabel(L.fields.status || 'open')], ['At', at]];
    if (L.fields.priority) facts.push(['Priority', String(L.fields.priority)]);
    if (L.fields.types && L.fields.types.length) facts.push(['Needs', L.fields.types.join(', ')]);
    if (f && f.coords && f.coords[0]) facts.push(['Position', latlon(f.coords[0])], ...heightFacts(f.coords[0]));
    const t = FL.T.lead(id);
    return {
      key: 'lead:' + id, kind: 'lead', icon: '❓', title: 'Lead at ' + at, line: A.leadSummary(L.fields), facts, desc: L.fields.desc || '', target: t,
      notes: FL.notesOn(pj.P, t), leads: [], docs: uniq(docsOn(t).concat(f ? docsOn(L.target) : [])),
      edit: () => A.editLead(null, at, leadItem(L)), hideInfo: true, canAdd: true,
    };
  }
  // A cave, survey or station: from the card in the details panel.
  function cardSubject() {
    const c = pj.card;
    if (!c || !pj.pid || !c.cid || !pj.P) return null;
    const cave = A.caveName(c.cid);
    if (c.level === 'cave') {
      const t = FL.T.cave(c.cid);
      const leads = Object.values(pj.P.leads).filter(L => !L.deleted && FL.parseTarget(L.target).cave === c.cid && FL.leadActive(L));
      return { key: t, kind: 'cave', icon: '🕳', title: cave, line: 'Cave', facts: [['Open leads', String(leads.length)]], desc: (pj.P.caves[c.cid] || {}).desc || '', target: t,
        notes: FL.notesOn(pj.P, t), leads: leads.slice(0, 30).map(L => ({ item: leadItem(L), label: A.targetLabel(L.target) })), docs: docsOn(t), canAdd: true };
    }
    if (c.survey) {
      const t = FL.T.survey(c.cid, c.code);
      return { key: t, kind: 'survey', icon: '〰️', title: 'Survey ' + (c.code || '(none)'), line: cave, facts: [['Cave', cave]], desc: '', target: t,
        notes: FL.notesOn(pj.P, t), leads: [], docs: uniq(docsOn(t).concat(docsOn(FL.T.cave(c.cid)))), canAdd: true };
    }
    const t = FL.T.station(c.cid, c.name);
    const facts = [['Cave', cave]];
    if (c.code) facts.push(['Survey', c.code]);
    const pos = A.stationPos(c.cid, c.name);
    if (pos && window.Cesium) { const k = Cesium.Cartographic.fromCartesian(pos); facts.push(['Position', `${Cesium.Math.toDegrees(k.latitude).toFixed(6)}, ${Cesium.Math.toDegrees(k.longitude).toFixed(6)}`], ['Height', k.height.toFixed(1) + ' m']); }
    const fs = FL.docsForStation(pj.D, pj.P, c.cid, c.name, c.code ? [c.code] : []);
    const leads = A.leadsAt(c.cid, c.name).filter(x => x.active);
    return { key: t, kind: 'station', icon: '📍', title: c.name, line: 'Station · ' + cave, facts, desc: '', target: t,
      notes: FL.notesOn(pj.P, t), leads: leads.map(x => ({ item: x, label: c.name, cid: c.cid, name: c.name })),
      docs: uniq([].concat(fs.station, fs.area || [], fs.segment || [], fs.survey, fs.cave, ...leads.filter(x => x.rec).map(x => docsOn(FL.T.lead(x.id))))), canAdd: true };
  }
  // Anything else on the map: a CalTopo or data-file feature, a My data point.
  function entitySubject(ent) {
    const now = window.Cesium ? Cesium.JulianDate.now() : null;
    const val = p => (p && p.getValue ? p.getValue(now) : p);
    const ll = c => { const k = Cesium.Cartographic.fromCartesian(c); return [Cesium.Math.toDegrees(k.longitude), Cesium.Math.toDegrees(k.latitude), k.height]; };
    const facts = [];
    let kind = 'Point';
    try {
      if (ent.polygon) { const h = val(ent.polygon.hierarchy), ps = h && h.positions ? h.positions.map(ll) : []; kind = 'Area'; if (ps.length > 2) facts.push(['Area', fmtArea(areaOf(ps))], ['Perimeter', fmtLen(lenOf(ps.concat([ps[0]])))]); }
      else if (ent.polyline) { const ps = (val(ent.polyline.positions) || []).map(ll); kind = 'Line'; if (ps.length > 1) facts.push(['Length', fmtLen(lenOf(ps))], ['Points', String(ps.length)], ['Starts at', latlon(ps[0])]); }
      else if (ent.position) { const c = ll(val(ent.position)); facts.push(['Position', latlon(c)]); facts.push(...heightFacts(c)); }
    } catch (_) {}
    const src = (window._ws && window._ws.vectorSources ? window._ws.vectorSources() : []).find(s => s.ds && s.ds.entities && s.ds.entities.contains && s.ds.entities.contains(ent));
    const mine = prop(ent, 'myFeature');
    const from = src ? src.name : mine ? 'My data' : '';
    facts.unshift(['Kind', kind]);
    if (from) facts.splice(1, 0, ['From', from]);
    const raw = String(val(ent.description) || '');
    const desc = raw.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
    return { key: 'ent:' + ent.id, kind: 'entity', icon: '•', title: ent.name || kind, line: [kind, from].filter(Boolean).join(' · '), facts, desc,
      target: null, notes: [], leads: [], docs: [], hideInfo: false, brief: 'strip' };
  }
  function subjectOf(ent) {
    if (!ent) return null;
    if (prop(ent, 'isCaveSurvey') || prop(ent, 'isFieldStation') || prop(ent, 'isProjectFootprint') || ent._caveLazy) return null;
    if (prop(ent, 'isProjectFeature')) { if (window._pjfState && window._pjfState.draw) return null; return featureSubject(prop(ent, 'featureId')); }
    if (prop(ent, 'isFeatureLead')) return leadSubject(prop(ent, 'leadId'));
    if (!ent.name && !ent.description) return null;
    return entitySubject(ent);
  }

  // ── Media lists ──────────────────────────────────────────────────────────
  const groups = docs => ({ photos: docs.filter(d => FL.docMedia(d) === 'photo'), videos: docs.filter(d => FL.docMedia(d) === 'video'), docs: docs.filter(d => !FL.docMedia(d)) });
  function counts(s) {
    const g = groups(s.docs || []), out = [];
    if (g.photos.length) out.push(`🖼 ${g.photos.length} photo${g.photos.length === 1 ? '' : 's'}`);
    if (g.videos.length) out.push(`🎞 ${g.videos.length} video${g.videos.length === 1 ? '' : 's'}`);
    if (g.docs.length) out.push(`📄 ${g.docs.length} document${g.docs.length === 1 ? '' : 's'}`);
    if (s.notes && s.notes.length) out.push(`📝 ${s.notes.length}`);
    if (s.leads && s.leads.length) out.push(`❓ ${s.leads.length}`);
    return out;
  }
  const videoUrl = d => (d.file && d.file.path && pj.pid ? API + 'file?project=' + encodeURIComponent(pj.pid) + '&path=' + encodeURIComponent(d.file.path) : null);
  function tile(d, isVid) {
    const t = el('button', 'inf-tile' + (isVid ? ' vid' : '')); t.type = 'button'; t.title = (d.title || 'Untitled') + (d.date ? ' · ' + d.date : '');
    const p = d.pages[0];
    if (p && p.ext !== 'pdf') { const im = el('img'); im.loading = 'lazy'; im.src = A.blobUrl(p); if (p.rot) im.style.transform = `rotate(${p.rot}deg)`; t.appendChild(im); }
    else t.appendChild(el('span', 'inf-tile-x', isVid ? '🎞' : '🖼'));
    if (isVid) t.appendChild(el('span', 'inf-play', '▶'));
    t.appendChild(el('span', 'inf-tile-t', d.title || 'Untitled'));
    return t;
  }

  // ── Brief (in the details panel) ─────────────────────────────────────────
  function briefNode(s) {
    const b = el('div', 'inf-brief' + (s.brief === 'strip' ? ' strip' : ''));
    if (s.brief !== 'strip') {
      const l = el('div', 'inf-line');
      if (s.color) { const sw = el('span', 'inf-sw'); sw.style.background = s.color; l.appendChild(sw); }
      l.appendChild(document.createTextNode(s.line || ''));
      b.appendChild(l);
      if (s.desc) b.appendChild(el('div', 'inf-desc clamp', s.desc));
      const c = counts(s);
      if (c.length) b.appendChild(el('div', 'inf-counts', c.join(' · ')));
    } else {
      const pos = (s.facts.find(f => f[0] === 'Position' || f[0] === 'Length' || f[0] === 'Area') || [])[1];
      if (pos) b.appendChild(el('div', 'inf-counts', pos));
    }
    const row = el('div', 'inf-acts');
    if (s.edit) row.appendChild(btn('✏️ Edit', () => { collapse(true); s.edit(); }, 'small'));
    row.appendChild(btn('⤢ More', () => { expand(); I.pinned = true; paintPin(); }, 'small'));
    row.appendChild(el('span', 'inf-hint', 'hover for more'));
    b.appendChild(row);
    return b;
  }

  // ── Expanded (movable) ───────────────────────────────────────────────────
  function sec(box, title, n) { box.appendChild(el('div', 'inf-h', title + (n != null ? ` (${n})` : ''))); }
  function render() {
    const s = I.subject, x = I.x;
    if (!s || !x) return;
    stopMedia();
    x.querySelector('.inf-x-title').textContent = `${s.icon || ''} ${s.title}`.trim();
    const ed = x.querySelector('.inf-x-edit'); ed.style.display = s.edit ? '' : 'none';
    const body = x.querySelector('.inf-x-body'); body.textContent = '';
    if (s.line) body.appendChild(el('div', 'inf-line', s.line));
    if (s.facts.length) {
      const t = el('table', 'inf-facts');
      s.facts.forEach(([k, v]) => { const r = el('tr'); r.append(el('th', null, k), el('td', null, v)); t.appendChild(r); });
      body.appendChild(t);
    }
    if (s.desc) { sec(body, 'Description'); body.appendChild(el('div', 'inf-desc', s.desc)); }
    if (s.notes.length) { sec(body, 'Notes', s.notes.length); s.notes.forEach(n => body.appendChild(A.noteEl(n))); }
    if (s.leads.length) { sec(body, 'Leads', s.leads.length); s.leads.forEach(L => body.appendChild(A.leadEl(L.cid || null, L.label, L.item))); }
    const g = groups(s.docs);
    if (g.photos.length) {
      sec(body, '🖼 Photos', g.photos.length);
      const grid = el('div', 'inf-grid');
      g.photos.forEach(d => { const t = tile(d, false); t.addEventListener('click', () => A.docOpen(d.id, 0)); grid.appendChild(t); });
      body.appendChild(grid);
    }
    if (g.videos.length) {
      sec(body, '🎞 Videos', g.videos.length);
      const player = el('div', 'inf-player');
      const grid = el('div', 'inf-grid');
      g.videos.forEach(d => {
        const t = tile(d, true);
        t.addEventListener('click', () => {
          const u = videoUrl(d);
          if (!u) { A.docOpen(d.id, 0); return; }               // no file to play: its document
          stopMedia();
          const head = el('div', 'inf-player-h');
          head.append(el('span', null, d.title || 'Video'), btn('■ Stop', stopMedia, 'small'), btn('⤢ Viewer', () => A.docOpen(d.id, 0), 'small'));
          const v = A.videoEl(u, d.pages[0] ? A.blobUrl(d.pages[0]) : null, 'inf-video');
          player.append(head, v);
          const vd = v.querySelector('video'); vd.autoplay = true;
          const pr = vd.play && vd.play(); if (pr && pr.catch) pr.catch(() => {});
          I.pinned = true; paintPin();                           // watching: it stays until closed
        });
        grid.appendChild(t);
      });
      body.append(player, grid);
    }
    if (g.docs.length) { sec(body, '📄 Documents', g.docs.length); g.docs.forEach(d => body.appendChild(A.docEl(d, s.target))); }
    if (!s.docs.length && s.target && pj.pid) body.appendChild(el('div', 'inf-none', 'No photos, videos or documents tagged to it yet.'));
    if (s.target && pj.pid && s.canAdd) {
      const r = el('div', 'inf-acts');
      r.append(btn('📄 Add files', () => A.addPages({ tags: [s.target] }), 'small'), btn('📝 Note', () => A.editNote(s.target, null), 'small'));
      body.appendChild(r);
    }
  }
  function paintPin() { if (I.x) I.x.querySelector('.inf-x-pin').classList.toggle('on', I.pinned); }
  function make() {
    const x = el('div'); x.id = 'info-x'; x.setAttribute('role', 'dialog'); x.setAttribute('aria-label', 'Details');
    x.innerHTML = '<div class="inf-x-head" title="Drag to move"><div class="inf-x-title"></div></div><div class="inf-x-body"></div>';
    const head = x.querySelector('.inf-x-head');
    const edit = btn('✏️ Edit', () => { const s = I.subject; collapse(true); if (s && s.edit) s.edit(); }, 'small inf-x-edit');
    const pin = btn('📌', () => { I.pinned = !I.pinned; paintPin(); }, 'small inf-x-pin'); pin.title = 'Keep it open';
    const close = el('button', 'inf-x-close', '×'); close.type = 'button'; close.title = 'Close (Esc)'; close.addEventListener('click', () => collapse(true));
    head.append(edit, pin, close);
    // Drag by the header: a moved panel stays (pinned).
    head.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const r = x.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const mv = ev => {
        x.style.left = Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dx)) + 'px';
        x.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy)) + 'px';
        if (!I.moved) { I.moved = true; I.pinned = true; paintPin(); }
      };
      const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); };
      document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
    });
    x.addEventListener('pointerdown', e => { if (!e.target.closest('.inf-x-head') && !e.target.closest('.inf-x-close')) { I.pinned = true; paintPin(); } });
    x.addEventListener('mouseenter', () => { I.overX = true; clearTimeout(I.tClose); });
    x.addEventListener('mouseleave', () => { I.overX = false; leaveSoon(); });
    // The wheel scrolls the panel, never the map behind it.
    x.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
    return x;
  }
  function place(x) {
    const ins = window._inspector && window._inspector.el, r = ins && ins.getBoundingClientRect();
    const w = Math.min(460, window.innerWidth - 24);
    x.style.width = w + 'px';
    const left = r && r.width ? r.left - w - 10 : window.innerWidth - w - 12;
    x.style.left = Math.max(8, left) + 'px';
    x.style.top = (r && r.width ? r.top : 52) + 'px';
  }
  function expand() {
    clearTimeout(I.tOpen);
    if (!I.subject) I.subject = cardSubject();
    if (!I.subject) return;
    if (!I.x) { I.x = make(); I.pinned = false; I.moved = false; document.body.appendChild(I.x); place(I.x); }
    paintPin();
    render();
  }
  /** Close the expanded panel (its video stopped and gone). */
  function collapse() {
    clearTimeout(I.tOpen); clearTimeout(I.tClose);
    if (!I.x) return;
    stopMedia();
    I.x.remove(); I.x = null; I.pinned = false; I.moved = false; I.overX = false;
  }
  function leaveSoon() {
    clearTimeout(I.tClose);
    if (!I.x || I.pinned) return;
    I.tClose = setTimeout(() => { if (!I.pinned && !I.overX && !I.overIns) collapse(); }, LEAVE_MS);
  }
  function stopMedia() {
    if (!I.x) return;
    const pl = I.x.querySelector('.inf-player');
    A.stopVideos(I.x);
    if (pl) pl.textContent = '';
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  /** Show a subject's brief in the details panel (null: none). */
  function show(s) {
    const same = s && I.subject && s.key === I.subject.key;
    I.subject = s;
    if (window._inspector) window._inspector.setBrief(s ? { node: briefNode(s), title: `${s.icon && s.brief !== 'strip' ? s.icon + ' ' : ''}${s.title}`, hideInfo: s.hideInfo } : null);
    if (I.x) { if (s && (same || I.pinned)) { if (!same || !I.x.querySelector('.inf-player video')) render(); } else collapse(); }
  }
  function clear() { I.subject = null; collapse(); if (window._inspector && window._inspector.brief()) window._inspector.setBrief(null); }
  /** Saved changes (project.js): the same thing again, fresh. */
  let tChg = 0;
  function changed() {
    clearTimeout(tChg);
    tChg = setTimeout(() => {
      const s = I.subject; if (!s) return;
      const fresh = s.kind === 'feature' ? featureSubject(s.key.slice(8)) : s.kind === 'lead' ? leadSubject(s.key.slice(5)) : s.kind === 'entity' ? s : cardSubject();
      if (!fresh) { clear(); return; }
      if (s.kind === 'feature' || s.kind === 'lead') show(fresh);
      else { I.subject = fresh; if (I.x && !I.x.querySelector('.inf-player video')) render(); }
    }, 150);
  }
  // The details panel closed (its ×, Esc, a click on empty map).
  function panelClosed() { if (I.subject || I.x) { I.subject = null; collapse(); } }

  const hook = setInterval(() => {
    const v = V(), ins = window._inspector;
    if (!v || !v.selectedEntityChanged || !ins) return;
    clearInterval(hook);
    v.selectedEntityChanged.addEventListener(ent => {
      const s = subjectOf(ent);
      if (s) show(s);
      else if (I.subject && I.subject.kind !== 'cave' && I.subject.kind !== 'survey' && I.subject.kind !== 'station') clear();
      else { I.subject = null; if (I.x) collapse(); }
    });
    // Hovering the details panel a moment: the larger panel (not over the segment panel).
    const box = ins.el;
    box.addEventListener('mouseenter', () => {
      I.overIns = true; clearTimeout(I.tClose);
      if (I.x || box.classList.contains('with-dock')) return;
      clearTimeout(I.tOpen);
      I.tOpen = setTimeout(() => {
        if (!I.overIns || document.querySelector('.pj-modal') || pj.gallery) return;
        if (!(I.subject && window._inspector.brief()) && !(pj.card && box.querySelector('#pj-card.open'))) return;
        if (!window._inspector.brief()) I.subject = cardSubject();
        expand();
      }, HOVER_MS);
    });
    box.addEventListener('mouseleave', () => { I.overIns = false; clearTimeout(I.tOpen); leaveSoon(); });
  }, 300);
  // Esc closes the larger panel first (a dialog or the document viewer take it before).
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !I.x || document.querySelector('.pj-modal') || pj.gallery) return;
    e.stopPropagation(); e.preventDefault();
    collapse();
  }, true);

  const st = document.createElement('style');
  st.textContent = `
  .inf-brief { padding: 8px 12px 10px; font-size: 12px; color: #e8e8ee; }
  .inf-brief.strip { padding: 4px 12px 8px; border-top: 1px solid rgba(255,255,255,.06); }
  .inf-line { color: rgba(255,255,255,.6); font-size: 11.5px; display: flex; align-items: center; gap: 6px; }
  .inf-sw { width: 10px; height: 10px; border-radius: 2px; flex: none; box-shadow: 0 0 0 1px rgba(0,0,0,.6); }
  .inf-desc { white-space: pre-wrap; word-break: break-word; margin: 6px 0 2px; line-height: 1.4; }
  .inf-desc.clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .inf-counts { color: rgba(255,255,255,.75); font-size: 11.5px; margin-top: 6px; }
  .inf-acts { display: flex; align-items: center; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .inf-acts .pj-btn { margin: 0; }
  .inf-hint { color: rgba(255,255,255,.35); font-size: 10.5px; margin-left: auto; }
  #info-x { position: fixed; z-index: 9600; max-height: calc(100vh - 70px); display: flex; flex-direction: column; background: rgba(16,18,26,.97); color: #e8e8ee;
    font: 12px system-ui, sans-serif; border: 1px solid rgba(255,255,255,.16); border-radius: 8px; box-shadow: 0 14px 40px rgba(0,0,0,.55); }
  #info-x .inf-x-head { display: flex; align-items: center; gap: 6px; padding: 8px 6px 7px 12px; border-bottom: 1px solid rgba(255,255,255,.08); cursor: move; user-select: none; flex: none; touch-action: none; }
  #info-x .inf-x-title { flex: 1; min-width: 0; font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #info-x .inf-x-head .pj-btn { margin: 0; cursor: pointer; }
  #info-x .inf-x-pin { opacity: .45; } #info-x .inf-x-pin.on { opacity: 1; border-color: #f2c24e; }
  #info-x .inf-x-close { background: none; border: none; color: #98a3a0; font-size: 20px; line-height: 1; padding: 0 6px 2px; border-radius: 4px; cursor: pointer; }
  #info-x .inf-x-close:hover { color: #fff; background: rgba(255,255,255,.08); }
  #info-x .inf-x-body { overflow-y: auto; overscroll-behavior: contain; padding: 8px 12px 12px; min-height: 0; }
  #info-x .inf-facts { border-collapse: collapse; margin: 6px 0 2px; width: 100%; }
  #info-x .inf-facts th { text-align: left; font-weight: 500; color: rgba(255,255,255,.5); padding: 2px 10px 2px 0; white-space: nowrap; vertical-align: top; width: 1%; }
  #info-x .inf-facts td { padding: 2px 0; word-break: break-word; }
  #info-x .inf-h { font-weight: 700; margin: 12px 0 5px; color: #f2f4f3; }
  #info-x .inf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; }
  #info-x .inf-tile { position: relative; padding: 0; height: 84px; border: 1px solid rgba(255,255,255,.15); border-radius: 6px; overflow: hidden; background: #222; cursor: pointer; color: #fff; }
  #info-x .inf-tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
  #info-x .inf-tile-x { display: flex; height: 100%; align-items: center; justify-content: center; font-size: 26px; }
  #info-x .inf-tile-t { position: absolute; left: 0; right: 0; bottom: 0; font-size: 10px; padding: 2px 4px; background: rgba(0,0,0,.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; }
  #info-x .inf-play { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -60%); font-size: 20px; width: 34px; height: 34px; line-height: 34px; border-radius: 50%; background: rgba(0,0,0,.55); }
  #info-x .inf-tile:hover { border-color: #8ab4ec; }
  #info-x .inf-player:not(:empty) { margin-bottom: 8px; }
  #info-x .inf-player-h { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; } #info-x .inf-player-h span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #info-x .inf-player-h .pj-btn { margin: 0; }
  #info-x .inf-video video { width: 100%; max-height: 50vh; background: #000; }
  #info-x .inf-none { color: rgba(255,255,255,.45); font-style: italic; margin-top: 10px; }`;
  document.head.appendChild(st);

  window._info = { show, clear, expand, collapse, stopMedia, changed, panelClosed, subjectOf, cardSubject, featureSubject };
})();
