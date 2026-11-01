// Segments and the review of suggestions in desktop FLEX (project doc 11).
//
// A segment is a group of a cave's shots surveyed together — one trip, one
// survey book — with its date, team, how much of it was checked against the
// original notes, and the documents (pages) it came from. Segments are
// optional: a project without any never sees them, and "Use segments" in the
// 📁 Project panel turns them off for a project that has them.
//
//   side panel (right)   click a shot or station: its segment — summary,
//                        problems, missing surveys, leads, files (pages open
//                        in the panel), notes — and the clicked station's own
//                        card; ◀ ▶ walk the segments that still have
//                        suggestions; ☰ every suggestion, grouped by what
//                        accepting it does
//   📁 Project → Segments counts by state, the list, use / labels / remove
//   Colour by            Review: each shot by its segment's state, with
//                        neighbouring segments in different shades;
//                        Segments: a colour per segment (window._caveShotColour)
//   Segment labels       the segment's name over its middle, close up
//   Missing surveys      survey versions (suggested or accepted) drawn dashed
//                        from the station they tie to. Their raw:
//                        { tie, tieCheck?, lenUnit, date, decl?, shots: [{ from,
//                        to, len, az, inc }] } — decl turns the azimuths into
//                        the survey file's north (without it, the magnetic
//                        declination for the date, file assumed true north);
//                        tieCheck "unconfirmed" → only a marker, no line
//
// Uses project.js through window._pjApi; nothing here is specific to one
// cave or one archive.
(function () {
  'use strict';
  const A = window._pjApi;
  if (!A) { console.warn('[segments] project.js missing'); return; }
  const { pj, FL, el, btn, esc, toast, dialog, record } = A;

  // ── Colours ──────────────────────────────────────────────────────────────
  const STATES = [
    ['problem', 'Confirmed problem', '#ff3b47'],
    ['review', 'Problems to review', '#ff8a1c'],
    ['unchecked', 'Not checked against notes', '#5f8fd6'],
    ['partly', 'Partly checked', '#e8d44d'],
    ['checked', 'Checked against notes', '#3ccf6e'],
  ];
  const STATE = Object.fromEntries(STATES.map(([k, l, c]) => [k, { label: l, css: c, rgb: hex(c) }]));
  const SHADES = [1, 0.66, 0.83];                 // neighbouring segments of one state differ
  const PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#86bcb6', '#d37295', '#a0cbe8']
    .map(hex);
  const OUTSIDE = hex('#4a4e55');      // a shot in no segment (the cave has segments)
  const NO_SEGS = hex('#7c8088');      // a cave without segments, or not in the project
  const MISSING_OPEN = '#ff4fd8', MISSING_ACCEPTED = '#b48cff';
  function hex(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
  const shade = (rgb, k) => rgb.map(x => x * k);

  const seg = { sel: null, info: new Map(), tab: 'summary', view: null, list: false, listText: '', listCave: '', open: {}, shown: {},
                versionSrc: null, selSrc: null, labels: null };
  window._pjSegState = seg;                       // tests

  // ── Settings (per project, this browser) ──────────────────────────────────
  const key = k => 'flex.pj.' + k + '.' + (pj.pid || '');
  const getB = (k, d) => { try { const v = localStorage.getItem(key(k)); return v == null ? d : v === '1'; } catch (_) { return d; } };
  const setB = (k, v) => { try { localStorage.setItem(key(k), v ? '1' : '0'); } catch (_) {} };
  const hasSegments = () => FL.segmentsOf(pj.P).length > 0;
  const on = () => !!pj.pid && hasSegments() && getB('segments', true);
  const showMissing = () => !!pj.pid && getB('missing', true);
  const showLabels = () => on() && getB('labels', false);

  // ── Per-cave lookups, cached until something changes ─────────────────────
  // idx (shot / station → segments), states, a colour slot per segment (no two
  // neighbours alike), and where its stations are (survey code, position).
  function info(cid) {
    if (!seg.info.has(cid)) {
      const segs = FL.segmentsOf(pj.P, cid);
      const idx = FL.segmentIndex(pj.P, cid);
      const nbr = new Map(segs.map(g => [g.id, new Set()]));
      idx.station.forEach(ids => ids.forEach(a => ids.forEach(b => { if (a !== b && nbr.has(a)) nbr.get(a).add(b); })));
      const slot = {};
      segs.slice().sort((a, b) => nbr.get(b.id).size - nbr.get(a.id).size).forEach(g => {
        const used = new Set([...nbr.get(g.id)].map(n => slot[n]).filter(x => x != null));
        let k = 0; while (used.has(k)) k++;
        slot[g.id] = k;
      });
      seg.info.set(cid, { any: segs.length > 0, idx, nbr, slot, states: FL.segmentStates(pj.P, pj.D, cid), where: null });
    }
    return seg.info.get(cid);
  }
  // Station → { survey, pos } for a cave's loaded files (pos: world, as drawn).
  function where(cid) {
    const I = info(cid);
    const parts = A.partsOf(cid);
    const sig = parts.map(({ imp }) => imp.name).join('|'), conv = parts.map(x => x.imp._convertFn);
    if (I.where && I.whereSig === sig && I.whereConv.length === conv.length && I.whereConv.every((f, i) => f === conv[i])) return I.where;
    const m = new Map();
    parts.forEach(({ imp, codes }) => {
      const cf = imp._convertFn;
      const add = (p, sv) => {
        if (!p.name || m.has(p.name) || !codes.has(sv || '')) return;
        m.set(p.name, { survey: sv || '', pos: typeof cf === 'function' ? cf(p.n, p.e, p.v) : null });
      };
      (imp.parsed.stations || []).forEach(s => add(s, s.survey));
      (imp.parsed.segments || []).forEach(sg => sg.points.forEach(p => add(p, sg.survey)));
    });
    I.where = m; I.whereSig = sig; I.whereConv = conv;
    return m;
  }
  const RANK = { problem: 0, review: 1, unchecked: 2, partly: 3, checked: 4 };
  function worst(I, ids) { return ids.filter(id => I.states[id]).sort((a, b) => RANK[I.states[a].state] - RANK[I.states[b].state])[0]; }

  // flex.js: Colour by → Review / Segments. (A, B, survey code) → [r, g, b, width?]
  window._caveShotColour = (imp, mode) => {
    if (!on()) return null;
    const caveOf = new Map();
    return (a, b, code) => {
      let cid = caveOf.get(code);
      if (cid === undefined) { cid = A.caveFor(imp, code) || null; caveOf.set(code, cid); }
      if (!cid) return NO_SEGS;
      const I = info(cid);
      if (!I.any) return NO_SEGS;
      const ids = I.idx.shot.get(a + '|' + b);
      if (!ids) return OUTSIDE;
      const id = worst(I, ids);
      if (!id) return OUTSIDE;
      if (mode === 'segment') return PALETTE[I.slot[id] % PALETTE.length];
      return shade(STATE[I.states[id].state].rgb, SHADES[I.slot[id] % SHADES.length]);
    };
  };
  const css = rgb => `rgb(${rgb.map(x => Math.round(x * 255)).join(',')})`;
  window._caveReviewLegendHtml = mode => {
    if (!pj.pid) return '';
    const note = t => `<div style="font-size:9px;opacity:0.6;margin-top:2px;">${t}</div>`;
    if (!hasSegments()) return note('This project has no segments.');
    if (!on()) return note('Segments are off for this project (📁 Project → Segments).');
    const lbl = `<label style="display:flex;align-items:center;gap:4px;font-size:10px;margin-top:4px;cursor:pointer;"><input type="checkbox" ${showLabels() ? 'checked' : ''} onchange="window._pjSeg.setLabels(this.checked)"> Segment names on the map (close up)</label>`;
    if (mode === 'segment') return note(`Each segment of “${esc(pj.P.name || 'the project')}” in its own colour; neighbours always differ. Click a shot for its segment.`) + lbl;
    const n = counts();
    return STATES.map(([k, l, c]) => `<div style="display:flex;align-items:center;gap:6px;font-size:9px;opacity:0.85;margin-top:2px;">
        <span style="flex:0 0 34px;height:7px;border-radius:3px;background:linear-gradient(90deg,${c} 0 50%,${css(shade(hex(c), SHADES[1]))} 50%);"></span><span>${l} (${n[k] || 0})</span></div>`).join('')
      + `<div style="display:flex;align-items:center;gap:6px;font-size:9px;opacity:0.7;margin-top:2px;"><span style="flex:0 0 34px;height:7px;border-radius:3px;background:#4a4e55;"></span><span>In no segment</span></div>`
      + note('Neighbouring segments in the same state are shown in different shades. Click a shot for its segment.') + lbl;
  };
  function counts() {
    const n = {};
    FL.liveCaves(pj.P).forEach(c => Object.values(info(c.id).states).forEach(s => { n[s.state] = (n[s.state] || 0) + 1; }));
    return n;
  }

  // ── Something changed: drop caches, redraw what depends on them ──────────
  let redrawTimer = null;
  function changed(e) {
    if (e && !/^(segment\.|accept$|reject$|note\.|lead\.|doc\.|survey\.version|cave\.)/.test(e.op)) return;
    seg.info.clear();
    if (seg.sel && !(pj.P.segments[seg.sel.sid] && !pj.P.segments[seg.sel.sid].removed)) seg.sel = null;
    if (dockOpen()) renderDock();
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => {
      const m = typeof window._caveColourModeNow === 'function' ? window._caveColourModeNow() : '';
      if (m === 'review' || m === 'segment') window._setCaveColourMode(m);
      drawVersions();
      drawSelection();
      drawLabels();
    }, 250);
  }

  // ── The selected segment: drawn over the cave, white ─────────────────────
  function segStations(g) { const s = []; g.shots.forEach(([a, b]) => { if (!s.includes(a)) s.push(a); if (!s.includes(b)) s.push(b); }); return s; }
  function drawSelection() {
    const V = window.cesiumViewer;
    if (!V || !window.Cesium) return [];
    if (!seg.selSrc) { seg.selSrc = new Cesium.CustomDataSource('pj-seg-sel'); V.dataSources.add(seg.selSrc); }
    seg.selSrc.entities.removeAll();
    const g = seg.sel && pj.P.segments[seg.sel.sid];
    if (!g || !on()) return [];
    const W = where(g.cave), pts = [];
    const white = Cesium.Color.WHITE;
    g.shots.forEach(([a, b]) => {
      const pa = W.get(a) && W.get(a).pos, pb = W.get(b) && W.get(b).pos;
      if (!pa || !pb) return;
      pts.push(pa, pb);
      seg.selSrc.entities.add({ polyline: { positions: [pa, pb], width: 5, material: white.withAlpha(0.9), depthFailMaterial: white.withAlpha(0.35) } });
    });
    V.scene.requestRender && V.scene.requestRender();
    return pts;
  }
  function flyToSegment(g) {
    const pts = drawSelection();
    if (!pts.length) { toast('That segment isn’t loaded (load the survey file of its cave)'); return; }
    const bs = Cesium.BoundingSphere.fromPoints(pts);
    bs.radius = Math.max(bs.radius * 1.4, 25);
    window.cesiumViewer.camera.flyToBoundingSphere(bs, { duration: 1.0 });
  }

  // ── Segment names on the map ─────────────────────────────────────────────
  function drawLabels() {
    const V = window.cesiumViewer;
    if (!V || !window.Cesium) return;
    if (seg.labels) { V.scene.primitives.remove(seg.labels); seg.labels = null; }
    if (!showLabels()) return;
    seg.labels = V.scene.primitives.add(new Cesium.LabelCollection());
    const ddc = new Cesium.DistanceDisplayCondition(0, 350);
    FL.liveCaves(pj.P).forEach(c => {
      const W = where(c.id);
      FL.segmentsOf(pj.P, c.id).forEach(g => {
        const mid = g.shots[Math.floor((g.shots.length - 1) / 2)];
        const pa = mid && W.get(mid[0]) && W.get(mid[0]).pos, pb = mid && W.get(mid[1]) && W.get(mid[1]).pos;
        if (!pa || !pb) return;
        seg.labels.add({ position: Cesium.Cartesian3.midpoint(pa, pb, new Cesium.Cartesian3()), text: g.name || g.id, font: '12px sans-serif',
          fillColor: Cesium.Color.WHITE, showBackground: true, backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
          pixelOffset: new Cesium.Cartesian2(0, -12), distanceDisplayCondition: ddc, disableDepthTestDistance: 2000 });
      });
    });
    V.scene.requestRender && V.scene.requestRender();
  }
  function setLabels(v) {
    setB('labels', !!v); drawLabels(); A.render();
    const m = typeof window._caveColourModeNow === 'function' ? window._caveColourModeNow() : '';
    if (m === 'review' || m === 'segment') { const lg = document.getElementById('lp-cave-colour-legend'); if (lg) lg.innerHTML = window._caveReviewLegendHtml(m); }
  }

  // ── Suggestions: what they are, where, what accepting does ───────────────
  function kindOf(p) {
    const e = p.entry;
    if (e.op === 'survey.version') return 'missing';
    if (e.op === 'note.set' && e.kind === 'issue') return 'issue';
    if (e.op === 'lead.set') return 'lead';
    if (e.op === 'note.set') return 'note';
    if (/^doc\./.test(e.op)) return 'doc';
    return 'other';
  }
  const GROUPS = [
    ['issue', '⚠', 'Problems with the survey data',
      'The notes and the cave file disagree (a reading, a station name, a shot). Accepting records it as a confirmed problem on that station or segment — a to-fix list; the cave file isn’t changed. Turning it down means it isn’t a problem.'],
    ['missing', '＋', 'Missing surveys',
      'Shots in the notes that aren’t in the cave file. Accepting keeps them as a separate version of that survey, beside the file — the file itself isn’t changed. Dashed on the map from the station they tie to when that tie fits the readings.'],
    ['lead', '❓', 'Leads',
      'Leads seen in the notes and sketches (the faded “?” on the map). Accepting adds the lead to the project’s lead list, and to FLEX Field with the next sync file.'],
    ['note', '📝', 'Notes on documents',
      'About the scans themselves: a file filed under the wrong survey, a date to correct. Accepting keeps the note on that document.'],
    ['doc', '📄', 'Documents', 'Changes to documents or their tags.'],
    ['other', '•', 'Other', ''],
  ];
  const GROUP = Object.fromEntries(GROUPS.map(g => [g[0], g]));
  // Segments a suggestion touches (its target is the segment or one of its stations).
  function segsOf(p) {
    const t = FL.parseTarget(FL.proposalTarget(p));
    if (!t.cave) return [];
    if (t.kind === 'segment') return [t.seg];
    if (t.kind === 'station') return info(t.cave).idx.station.get(t.name) || [];
    return [];
  }
  function caveOfProposal(p) {
    const t = FL.parseTarget(FL.proposalTarget(p));
    if (t.cave) return t.cave;
    const e = p.entry;
    const docId = e.doc || (t.kind === 'doc' ? t.doc : null);
    if (docId && pj.D.docs[docId]) { const c = pj.D.docs[docId].tagList.map(FL.parseTarget).find(x => x.cave); return c ? c.cave : ''; }
    return e.cave || '';
  }
  const segName = id => (pj.P.segments[id] || {}).name || id;
  // "station C8A · survey C · segment C· 1974-09-14" — where a target is.
  function whereText(target) {
    const t = FL.parseTarget(target);
    switch (t.kind) {
      case 'station': {
        const w = where(t.cave).get(t.name);
        const sgs = (info(t.cave).idx.station.get(t.name) || []).map(segName);
        return [`station ${t.name}`, w && w.survey ? `survey ${w.survey}` : '', sgs.length ? `segment ${sgs.slice(0, 2).join(', ')}` : ''].filter(Boolean).join(' · ');
      }
      case 'segment': return `segment ${segName(t.seg)}`;
      case 'doc': return `document “${(pj.D.docs[t.doc] || {}).title || '?'}”`;
      default: return target ? A.targetLabel(target) : 'the project';
    }
  }
  function effectText(p) {
    const e = p.entry, w = whereText(FL.proposalTarget(p));
    switch (kindOf(p)) {
      case 'issue': return `Records a confirmed problem on ${w}. Nothing in the cave file changes.`;
      case 'note': return `Keeps this note on ${w}.`;
      case 'lead': {
        const closed = !FL.leadActive({ fields: e.fields || {} });
        return `Adds a lead at ${w}` + (closed ? ` — as already ${FL.statusLabel(e.fields.status).toLowerCase()} (closed: on the list, not on the map).` : ' — open, on the lead list and the map.');
      }
      case 'missing': {
        const raw = e.raw || {}, n = (raw.shots || []).length;
        const tie = raw.tie ? `tied at ${raw.tie}` : 'with no known tie';
        const chk = { checked: 'the tie fits the readings', plausible: 'only one known station, so the tie can’t be cross-checked', unconfirmed: 'the stations it names don’t fit the readings — check the notes', none: '' }[raw.tieCheck || ''] || '';
        return `Adds ${n} shot${n === 1 ? '' : 's'} from the notes as a separate version of survey ${e.code || '?'}, ${tie}${chk ? ` (${chk})` : ''}. The cave file isn’t changed.`;
      }
      default: return A.describe(e);
    }
  }
  function titleText(p) {
    const e = p.entry;
    if (e.op === 'note.set') return e.text || '';
    if (e.op === 'lead.set') return (e.fields && e.fields.desc) || 'Lead';
    if (e.op === 'survey.version') return `Survey ${e.code || '?'}: ${e.note || ''}`;
    return A.describe(e);
  }
  async function decide(p, accept, note) {
    const docs = !!pj.D.proposals[p.id];
    const data = accept ? { ref: p.id, base: [p.id].concat(A.headsFor(p)) } : { ref: p.id };
    if (note) data[accept ? 'note' : 'why'] = note;
    return record(accept ? 'accept' : 'reject', data, docs ? 'docs' : null);
  }
  function pageBtns(evidence, row) {
    const seen = new Set();
    (evidence || []).forEach(x => {
      const h = x.page && x.page.h;
      if (!h || seen.has(h) || seen.size >= 3) return;
      seen.add(h);
      const d = A.docByPage(h);
      if (d) row.appendChild(btn('📄 ' + (x.page.label || d.title || 'page').replace(/^.* - (\d{4})/, '$1').slice(0, 52), () => view(d.id, d.pages.findIndex(q => q.h === h)), 'small'));
    });
  }
  // One suggestion: what it says, where, what accepting does, evidence, decide.
  function itemEl(p) {
    const r = el('div', 'pjs-q');
    const g = GROUP[kindOf(p)];
    r.appendChild(el('div', 'pjs-q-t', `${g[1]} ${titleText(p)}`));
    const tgt = FL.proposalTarget(p), t = FL.parseTarget(tgt);
    r.appendChild(el('div', 'pjs-q-w', 'Where: ' + whereText(tgt) + (p.confidence != null ? ` · ${Math.round(p.confidence * 100)}% sure` : '') + ` · from ${p.by || '?'}`));
    const ef = el('div', 'pjs-q-e'); ef.innerHTML = '<b>If accepted:</b> ' + esc(effectText(p)); r.appendChild(ef);
    const ev = (p.evidence || []).map(x => x.text).filter(Boolean).join(' · ');
    if (ev) r.appendChild(el('div', 'pjs-q-v', 'Evidence: ' + ev));
    const row = el('div', 'pj-row');
    if (t.kind === 'station') row.appendChild(btn('📍 Fly there', () => A.flyTo(t.cave, t.name), 'small'));
    pageBtns(p.evidence, row);
    if (row.children.length) r.appendChild(row);
    const row2 = el('div', 'pj-row');
    const note = el('input', 'pj-input pjs-note'); note.placeholder = 'note (optional)';
    row2.appendChild(note);
    row2.appendChild(btn('Accept', () => decide(p, true, note.value.trim()), 'small primary'));
    row2.appendChild(btn('Turn down', () => decide(p, false, note.value.trim()), 'small'));
    r.appendChild(row2);
    return r;
  }

  // ── The side panel ───────────────────────────────────────────────────────
  let dock = null;
  const dockOpen = () => !!(dock && dock.classList.contains('open'));
  function ensureDock() {
    if (dock) return dock;
    dock = el('div'); dock.id = 'pjs-dock';
    dock.innerHTML = '<div class="pjs-grip" title="Drag to resize"></div><div class="pjs-head"></div><div class="pjs-station"></div><div class="pjs-tabs"></div><div class="pjs-body"></div>';
    document.body.appendChild(dock);
    let w = 460; try { w = Number(localStorage.getItem('flex.pjs.dockW')) || 460; } catch (_) {}
    setWidth(w);
    dock.querySelector('.pjs-grip').addEventListener('mousedown', e => {
      e.preventDefault();
      const mv = ev => setWidth(window.innerWidth - ev.clientX);
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); try { localStorage.setItem('flex.pjs.dockW', String(parseInt(dock.style.width, 10))); } catch (_) {} };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    return dock;
  }
  function setWidth(w) {
    w = Math.max(320, Math.min(window.innerWidth * 0.7, w));
    dock.style.width = w + 'px';
    document.documentElement.style.setProperty('--pjs-w', w + 'px');
  }
  function openDock() {
    ensureDock();
    dock.classList.add('open');
    document.body.classList.add('pjs-docked');
    // The clicked station's / shot's card lives at the top of the panel.
    const card = document.getElementById('pj-card'), slot = dock.querySelector('.pjs-station');
    if (card && card.parentNode !== slot) slot.appendChild(card);
  }
  function closeDock() {
    if (!dock) return;
    dock.classList.remove('open');
    document.body.classList.remove('pjs-docked');
    const card = document.getElementById('pj-card');
    if (card) { card.classList.remove('open'); document.body.appendChild(card); }
    seg.sel = null; seg.view = null; drawSelection();
  }
  function showSegment(cid, sid, opts = {}) {
    seg.sel = { cid, sid }; seg.list = false; seg.view = null;
    if (opts.tab) seg.tab = opts.tab;
    openDock();
    renderDock();
    if (opts.fly) flyToSegment(pj.P.segments[sid]); else drawSelection();
  }
  function showList() { seg.list = true; seg.view = null; openDock(); renderDock(); }
  // Open suggestions per segment, and the segments of a cave that have any.
  function openBySeg(cid) {
    const I = info(cid);
    if (I.openBySeg) return I.openBySeg;
    const m = new Map();
    FL.reviewQueue(pj.P, pj.D).forEach(p => { if (caveOfProposal(p) === cid) segsOf(p).forEach(id => { if (!m.has(id)) m.set(id, []); m.get(id).push(p); }); });
    I.openBySeg = m;
    return m;
  }
  function toDo(cid) {
    const open = openBySeg(cid);
    return FL.segmentsOf(pj.P, cid).filter(g => (open.get(g.id) || []).length)
      .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  }
  function step(dir) {
    const s = seg.sel;
    const cid = s ? s.cid : (FL.liveCaves(pj.P).find(c => info(c.id).any) || {}).id;
    if (!cid) return;
    const list = toDo(cid);
    if (!list.length) { toast('No segment has suggestions left'); return; }
    let i = s ? list.findIndex(g => g.id === s.sid) : -1;
    if (i < 0) {           // the open segment has none left: continue from where it sorts
      const name = s ? segName(s.sid) : '';
      const k = list.findIndex(g => String(g.name).localeCompare(name, undefined, { numeric: true }) > 0);
      i = (k < 0 ? list.length : k) - (dir > 0 ? 1 : 0);
    }
    const g = list[((i + dir) % list.length + list.length) % list.length];
    const first = segStations(g)[0];
    if (first) A.openCard({ cid, name: first, code: (where(cid).get(first) || {}).survey || '' });
    showSegment(cid, g.id, { fly: true });
  }
  function head(box, title, sub) {
    box.textContent = '';
    const r = el('div', 'pjs-head-r');
    if (hasSegments() && on()) {
      const prev = btn('◀', () => step(-1), 'small'); prev.title = 'Previous segment with suggestions';
      r.appendChild(prev);
    }
    const t = el('div', 'pjs-title'); t.innerHTML = title; r.appendChild(t);
    if (hasSegments() && on()) {
      const next = btn('▶', () => step(1), 'small'); next.title = 'Next segment with suggestions';
      r.appendChild(next);
    }
    const all = btn('☰', showList, 'small' + (seg.list ? ' on' : '')); all.title = 'All suggestions';
    r.appendChild(all);
    r.appendChild(btn('✕', closeDock, 'small'));
    box.appendChild(r);
    if (sub) { const s = el('div', 'pj-sub'); s.innerHTML = sub; box.appendChild(s); }
  }
  function renderDock() {
    if (!dock) return;
    const H = dock.querySelector('.pjs-head'), T = dock.querySelector('.pjs-tabs'), B = dock.querySelector('.pjs-body');
    const keep = B.scrollTop;
    T.textContent = ''; B.textContent = '';
    dock.querySelector('.pjs-station').style.display = seg.list || seg.view ? 'none' : '';
    if (seg.view) renderViewer(H, T, B);
    else if (seg.list || !seg.sel || !on()) renderList(H, T, B);
    else renderSegment(H, T, B);
    B.scrollTop = keep;
  }
  function renderSegment(H, T, B) {
    const g = pj.P.segments[seg.sel.sid];
    if (!g || g.removed) { seg.sel = null; return renderList(H, T, B); }
    const cid = seg.sel.cid, I = info(cid), st = I.states[g.id] || { state: 'unchecked', done: 0, total: 0 };
    const S = STATE[st.state];
    const left = toDo(cid).length;
    head(H, `Segment <b>${esc(g.name || g.id)}</b> <span class="pjs-chip" style="background:${S.css}">${esc(S.label)}</span>`,
      `${esc(A.caveName(cid))} · ${left} segment${left === 1 ? '' : 's'} with suggestions left (◀ ▶)`);
    const stations = segStations(g), stSet = new Set(stations);
    const open = openBySeg(cid).get(g.id) || [];
    const byKind = k => open.filter(p => kindOf(p) === k);
    const confirmed = Object.values(pj.P.notes).filter(n => !n.deleted && n.kind === 'issue' && onSeg(n.target, cid, g.id, stSet));
    const notes = Object.values(pj.P.notes).filter(n => !n.deleted && n.kind !== 'issue' && onSeg(n.target, cid, g.id, stSet));
    const leads = Object.values(pj.P.leads).filter(L => !L.deleted && onSeg(L.target, cid, g.id, stSet));
    const vers = versionsAt(cid, stSet);
    const docs = docsOfSeg(cid, g, stSet);
    const tabs = [['summary', 'Summary'], ['problems', `Problems (${byKind('issue').length + confirmed.length})`], ['missing', `Missing (${vers.length})`],
                  ['leads', `Leads (${byKind('lead').length + leads.length})`], ['files', `Files (${docs.length})`], ['notes', `Notes (${notes.length + byKind('note').length})`]];
    tabs.forEach(([k, l]) => T.appendChild(btn(l, () => { seg.tab = k; B.scrollTop = 0; renderDock(); }, seg.tab === k ? 'on' : '')));
    const sec = (title, text) => { B.appendChild(el('div', 'pj-h', title)); if (text) B.appendChild(el('div', 'pjs-expl', text)); };
    const none = t => B.appendChild(el('div', 'pj-note', t));
    switch (seg.tab) {
      case 'problems':
        sec('To review', GROUP.issue[3]);
        byKind('issue').forEach(p => B.appendChild(itemEl(p)));
        if (!byKind('issue').length) none('Nothing to review.');
        if (confirmed.length) { sec('Confirmed problems'); confirmed.forEach(n => B.appendChild(noteRow(n))); }
        break;
      case 'missing':
        sec('Missing surveys tied here', GROUP.missing[3]);
        vers.forEach(v => B.appendChild(v.p ? itemEl(v.p) : versionRow(v)));
        if (!vers.length) none('None.');
        break;
      case 'leads':
        sec('Suggested', GROUP.lead[3]);
        byKind('lead').forEach(p => B.appendChild(itemEl(p)));
        if (!byKind('lead').length) none('No suggested leads.');
        if (leads.length) {
          sec('On the lead list');
          leads.forEach(L => {
            const r = el('div', 'pj-item'), t = FL.parseTarget(L.target);
            r.appendChild(el('div', 'pj-item-t', `❓ ${t.name || '?'} · ${FL.statusLabel(L.fields.status || 'open')}`));
            if (L.fields.desc) r.appendChild(el('div', 'pj-sub', L.fields.desc));
            r.addEventListener('click', () => t.name && A.flyTo(cid, t.name));
            B.appendChild(r);
          });
        }
        break;
      case 'files':
        if (!docs.length) none('No documents linked to this segment.');
        else {
          B.appendChild(el('div', 'pjs-expl', 'Click a document to read it here; ⤢ for full screen.'));
          const grid = el('div', 'pjs-grid');
          docs.forEach(({ d, at, why }) => {
            const c = el('div', 'pjs-thumb');
            const p = d.pages[at];
            if (p && p.ext !== 'pdf') { const im = el('img'); im.loading = 'lazy'; im.src = '/api/lib/blob/' + p.h + '.' + (p.ext || 'jpg'); if (p.rot) im.style.transform = `rotate(${p.rot}deg)`; c.appendChild(im); }
            else c.appendChild(el('div', 'pjs-pdf', 'PDF'));
            c.appendChild(el('div', 'pjs-cap', d.title || 'Untitled'));
            c.appendChild(el('div', 'pjs-cap2', `${d.pages.length} page${d.pages.length === 1 ? '' : 's'}${d.date ? ' · ' + d.date : ''} · ${why}`));
            c.addEventListener('click', () => view(d.id, at));
            grid.appendChild(c);
          });
          B.appendChild(grid);
        }
        break;
      case 'notes':
        B.appendChild(el('div', 'pjs-expl', 'Notes on this segment and its stations — including the reader’s remarks from transcribing the pages.'));
        byKind('note').forEach(p => B.appendChild(itemEl(p)));
        if (!notes.length && !byKind('note').length) none('No notes.');
        notes.forEach(n => B.appendChild(noteRow(n)));
        B.appendChild(btn('✏️ Note on this segment', () => A.editNote(FL.T.segment(cid, g.id)), 'small'));
        break;
      default: {
        const facts = el('div', 'pjs-facts');
        const surveys = [...new Set(stations.map(n => (where(cid).get(n) || {}).survey).filter(Boolean))];
        const len = segLength(cid, g);
        [['Date', g.date || '—'], ['Team', g.team || '—'], ['Survey', surveys.join(', ') || '—'],
         ['Shots', `${g.shots.length}${len ? ` · ${Math.round(len / 0.3048)} ft (${Math.round(len)} m)` : ''}`],
         ['Stations', stations.length > 8 ? `${stations[0]} … ${stations[stations.length - 1]} (${stations.length})` : stations.join(', ')],
         ['Source', g.desc || g.source || '—']].forEach(([k, v]) => {
          const r = el('div', 'pjs-fact'); r.appendChild(el('span', '', k)); r.appendChild(el('span', '', v)); facts.appendChild(r);
        });
        B.appendChild(facts);
        if (st.total) {
          const pct = Math.round(100 * st.done / st.total);
          B.appendChild(el('div', 'pj-sub', `${st.done} of ${st.total} shots checked against the notes (${pct}%)`));
          const bar = el('div', 'pjs-bar'); bar.innerHTML = `<div style="width:${pct}%"></div>`; B.appendChild(bar);
        } else B.appendChild(el('div', 'pj-sub', 'Not checked against notes.'));
        const tiles = el('div', 'pjs-tiles');
        [['problems', '⚠', byKind('issue').length, 'problems to review', confirmed.length ? `${confirmed.length} confirmed` : ''],
         ['missing', '＋', vers.length, 'missing surveys', ''],
         ['leads', '❓', byKind('lead').length, 'suggested leads', leads.length ? `${leads.length} on the list` : ''],
         ['files', '📄', docs.length, 'documents', ''], ['notes', '📝', notes.length, 'notes', '']].forEach(([k, i, n, l, x]) => {
          const t = el('div', 'pjs-tile' + (n ? ' has' : ''));
          t.innerHTML = `<div class="n">${i} ${n}</div><div>${esc(l)}</div>${x ? `<div class="x">${esc(x)}</div>` : ''}`;
          t.addEventListener('click', () => { seg.tab = k; renderDock(); });
          tiles.appendChild(t);
        });
        B.appendChild(tiles);
        const nb = [...(I.nbr.get(g.id) || [])].map(id => pj.P.segments[id]).filter(Boolean);
        if (nb.length) {
          B.appendChild(el('div', 'pj-h', 'Joins'));
          const row = el('div', 'pj-row');
          nb.sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))).forEach(n => row.appendChild(btn(n.name || n.id, () => showSegment(cid, n.id, { fly: true }), 'small chip')));
          B.appendChild(row);
        }
        const row = el('div', 'pj-row');
        row.appendChild(btn('Show on the map', () => flyToSegment(g), 'small'));
        B.appendChild(row);
      }
    }
  }
  function onSeg(target, cid, sid, stSet) {
    const t = FL.parseTarget(target);
    return t.cave === cid && ((t.kind === 'segment' && t.seg === sid) || (t.kind === 'station' && stSet.has(t.name)));
  }
  function segLength(cid, g) {
    const W = where(cid); let L = 0;
    g.shots.forEach(([a, b]) => { const pa = W.get(a) && W.get(a).pos, pb = W.get(b) && W.get(b).pos; if (pa && pb) L += Cesium.Cartesian3.distance(pa, pb); });
    return L;
  }
  // Documents of a segment: tagged to it, then to its stations; the page to open first.
  function docsOfSeg(cid, g, stSet) {
    const tag = FL.T.segment(cid, g.id), out = [];
    Object.values(pj.D.docs).forEach(d => {
      if (d.deleted) return;
      if (d.tags[tag]) out.push({ d, at: FL.pageFor(d, tag), why: 'pages of this segment' });
      else if (d.tagList.some(t => { const p = FL.parseTarget(t); return p.kind === 'station' && p.cave === cid && stSet.has(p.name); })) out.push({ d, at: 0, why: 'tagged to a station' });
    });
    return out.sort((a, b) => String(a.d.date || '').localeCompare(String(b.d.date || '')));
  }
  function noteRow(n) {
    const r = el('div', 'pj-item');
    r.appendChild(el('div', 'pj-item-t', (n.kind === 'issue' ? '⚠ ' : '📝 ') + n.text));
    r.appendChild(el('div', 'pj-sub', `${whereText(n.target)} · ${n.who || '?'}`));
    if (n.page && n.page.h) { const row = el('div', 'pj-row'); pageBtns([{ page: n.page }], row); r.appendChild(row); }
    r.addEventListener('click', e => { if (e.target.tagName !== 'BUTTON') A.editNote(n.target, n.id); });
    return r;
  }
  function versionRow(v) {
    const r = el('div', 'pj-item');
    r.appendChild(el('div', 'pj-item-t', `＋ Survey ${v.e.code || '?'} (accepted version): ${v.e.note || ''}`));
    r.appendChild(el('div', 'pj-sub', `${(v.e.raw.shots || []).length} shot(s), tied at ${v.e.raw.tie || '?'}`));
    return r;
  }

  // Every suggestion, grouped by what accepting it does.
  function renderList(H, T, B) {
    const q = FL.reviewQueue(pj.P, pj.D);
    head(H, '<b>Suggestions</b>', `${q.length} waiting. Nothing changes until you accept; each decision is logged under your name and goes to FLEX Field in sync files.`);
    const bar = el('div', 'pj-row pjs-filter');
    const cave = el('select', 'pj-input'); cave.appendChild(new Option('All caves', ''));
    FL.liveCaves(pj.P).forEach(c => cave.appendChild(new Option(c.name, c.id, false, c.id === seg.listCave)));
    const text = el('input', 'pj-input'); text.placeholder = 'Search (station, survey, words)'; text.value = seg.listText;
    cave.addEventListener('change', () => { seg.listCave = cave.value; renderDock(); });
    let tt = null;
    text.addEventListener('input', () => { clearTimeout(tt); tt = setTimeout(() => {
      seg.listText = text.value; renderDock();
      const x = dock.querySelector('.pjs-filter input'); if (x) { x.focus(); x.selectionStart = x.value.length; }
    }, 300); });
    bar.append(cave, text);
    B.appendChild(bar);
    if (hasSegments() && on()) {
      const w = el('div', 'pj-row');
      w.appendChild(btn('▶ Work segment by segment', () => step(1), 'primary small'));
      w.appendChild(el('span', 'pj-sub', 'opens each segment with suggestions in turn and flies there'));
      B.appendChild(w);
    }
    const txt = seg.listText.trim().toLowerCase();
    const shown = q.filter(p => (!seg.listCave || caveOfProposal(p) === seg.listCave)
      && (!txt || (titleText(p) + ' ' + whereText(FL.proposalTarget(p)) + ' ' + (p.evidence || []).map(x => x.text).join(' ')).toLowerCase().includes(txt)));
    GROUPS.forEach(([k, icon, label, expl]) => {
      const items = shown.filter(p => kindOf(p) === k);
      if (!items.length) return;
      const box = el('div', 'pjs-group');
      const h = el('div', 'pjs-group-h');
      const isOpen = !!seg.open[k];
      h.innerHTML = `<span>${isOpen ? '▾' : '▸'} ${icon} ${esc(label)}</span><b>${items.length}</b>`;
      h.addEventListener('click', () => { seg.open[k] = !isOpen; renderDock(); });
      box.appendChild(h);
      box.appendChild(el('div', 'pjs-expl', expl));
      if (isOpen) {
        const top = el('div', 'pj-row');
        const thr = el('input', 'pj-input pj-num'); thr.type = 'number'; thr.min = 0; thr.max = 100; thr.value = 90;
        top.append('Accept all of these at or above ', thr, '% sure ', btn('Accept', async () => {
          const t = Number(thr.value) / 100, sel = items.filter(p => (p.confidence || 0) >= t);
          if (!sel.length) { toast('None at that level'); return; }
          const ok = await dialog({ title: `Accept ${sel.length} suggestion(s)?`, text: 'One entry under your name; each stays in the history.', buttons: [{ label: 'Cancel', value: null }, { label: 'Accept', value: 'ok', primary: true }] });
          if (!ok) return;
          const proj = sel.filter(p => pj.P.proposals[p.id]), docs = sel.filter(p => pj.D.proposals[p.id]);
          if (proj.length) await record('accept', { refs: proj.map(p => p.id), base: proj.map(p => p.id).concat(...proj.map(A.headsFor)) });
          if (docs.length) await record('accept', { refs: docs.map(p => p.id), base: docs.map(p => p.id) }, 'docs');
        }, 'small'));
        box.appendChild(top);
        const n = seg.shown[k] || 40;
        items.slice(0, n).forEach(p => box.appendChild(itemEl(p)));
        if (items.length > n) box.appendChild(btn(`Show ${Math.min(40, items.length - n)} more`, () => { seg.shown[k] = n + 40; renderDock(); }, 'small'));
      }
      B.appendChild(box);
    });
    if (!shown.length) B.appendChild(el('div', 'pj-note', q.length ? 'Nothing matches.' : 'Nothing to review.'));
  }

  // ── Pages, in the panel ──────────────────────────────────────────────────
  function view(docId, i) { seg.view = { doc: docId, i: Math.max(0, i || 0), zoom: false }; openDock(); renderDock(); }
  function renderViewer(H, T, B) {
    const d = pj.D.docs[seg.view.doc];
    if (!d || !d.pages.length) { seg.view = null; return renderDock(); }
    const n = d.pages.length, i = Math.min(seg.view.i, n - 1), p = d.pages[i];
    H.textContent = '';
    const r = el('div', 'pjs-head-r');
    r.appendChild(btn('← Back', () => { seg.view = null; renderDock(); }, 'small'));
    const t = el('div', 'pjs-title'); t.innerHTML = `<b>${esc(d.title || 'Untitled')}</b>`; r.appendChild(t);
    r.appendChild(btn('✕', closeDock, 'small'));
    H.appendChild(r);
    const nav = el('div', 'pj-row');
    nav.appendChild(btn('‹', () => { seg.view.i = Math.max(0, i - 1); B.scrollTop = 0; renderDock(); }, 'small'));
    nav.appendChild(el('span', 'pj-sub', `page ${i + 1} of ${n}${p && p.name ? ' · ' + p.name : ''}${p && p.kind ? ' · ' + (FL.DOC_KIND_LABELS[p.kind] || p.kind) : ''}`));
    nav.appendChild(btn('›', () => { seg.view.i = Math.min(n - 1, i + 1); B.scrollTop = 0; renderDock(); }, 'small'));
    nav.appendChild(btn(seg.view.zoom ? 'Fit' : 'Zoom', () => { seg.view.zoom = !seg.view.zoom; renderDock(); }, 'small'));
    nav.appendChild(btn('⤢ Full screen', () => A.docOpen(d.id, i), 'small'));
    if (d.file) { const o = el('a', 'pj-btn small'); o.textContent = '📄 Original'; o.href = '/api/lib/blob/' + d.file.h + '.' + d.file.ext; o.target = '_blank'; o.rel = 'noopener'; o.title = d.file.path; nav.appendChild(o); }
    T.appendChild(nav);
    if (d.file && p && p.ext !== 'pdf') T.appendChild(el('div', 'pj-sub', 'Page image for viewing, made from the original (' + d.file.name + ').'));
    const box = el('div', 'pjs-page' + (seg.view.zoom ? ' zoom' : ''));
    if (p.ext === 'pdf') { const f = el('iframe'); f.src = '/api/lib/blob/' + p.h + '.pdf'; box.appendChild(f); }
    else { const im = el('img'); im.src = '/api/lib/blob/' + p.h + '.' + (p.ext || 'jpg'); if (p.rot) im.style.transform = `rotate(${p.rot}deg)`; im.addEventListener('click', () => { seg.view.zoom = !seg.view.zoom; renderDock(); }); box.appendChild(im); }
    B.appendChild(box);
    const segs = (p.targets || []).map(FL.parseTarget).filter(x => x.kind === 'segment').map(x => segName(x.seg));
    B.appendChild(el('div', 'pj-sub', (segs.length ? 'This page: segment ' + segs.join(', ') + ' · ' : '') + (d.desc || '')));
  }

  // ── Station card: hand the segment to the panel ──────────────────────────
  function card(box, c) {
    if (!on() || !c.cid) return;
    const I = info(c.cid);
    let ids = [];
    if (c.survey && c.ends && c.ends.length === 2) ids = I.idx.shot.get(c.ends[0] + '|' + c.ends[1]) || [];
    else if (c.name) ids = I.idx.station.get(c.name) || [];
    ids = ids.filter(id => pj.P.segments[id] && !pj.P.segments[id].removed);
    if (!ids.length) { if (I.any) box.appendChild(el('div', 'pj-sub', 'In no segment.')); return; }
    const cur = seg.sel && ids.includes(seg.sel.sid) ? seg.sel.sid : ids[0];
    const toSeg = id => (window._sel ? window._sel.toSegment(c.cid, id) : showSegment(c.cid, id));
    // Picked as a station or survey (selection.js): its segments as chips; the
    // segment panel opens only when a segment is what is selected.
    if (c.level && c.level !== 'segment') {
      const row = el('div', 'pj-row'); row.appendChild(el('span', 'pj-sub', ids.length > 1 ? 'Segments here: ' : 'Segment: '));
      ids.forEach(id => row.appendChild(btn(segName(id), () => toSeg(id), 'small chip')));
      box.appendChild(row);
      return;
    }
    if (ids.length > 1) {
      const row = el('div', 'pj-row'); row.appendChild(el('span', 'pj-sub', 'Segments here: '));
      ids.forEach(id => row.appendChild(btn(segName(id), () => toSeg(id), 'small chip' + (id === cur ? ' on' : ''))));
      box.appendChild(row);
    }
    if (!dockOpen() || !seg.sel || seg.sel.sid !== cur || seg.list || seg.view) setTimeout(() => showSegment(c.cid, cur), 0);
    else openDock();
  }

  // ── 📁 Project → Segments ───────────────────────────────────────────────
  function section(root, mk) {
    if (!pj.pid || !hasSegments()) return;
    const n = FL.segmentsOf(pj.P).length;
    mk(root, `Segments (${n})`, false, b => {
      const use = el('label', 'pj-row'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = on();
      cb.addEventListener('change', () => { setB('segments', cb.checked); if (!cb.checked) closeDock(); changed(null); A.render(); });
      use.append(cb, ' Use segments in this project');
      b.appendChild(use);
      if (!on()) { b.appendChild(el('div', 'pj-note', 'Off: segments are kept but not shown, coloured or listed. Tick to use them again.')); return; }
      const cnt = counts();
      const leg = el('div', 'pjs-legend');
      STATES.forEach(([k, l, c]) => { const r = el('div'); r.innerHTML = `<span class="pjs-sw" style="background:${c}"></span>${esc(l)}: ${cnt[k] || 0}`; leg.appendChild(r); });
      b.appendChild(leg);
      const row = el('div', 'pj-row');
      row.appendChild(btn('☰ Suggestions', showList, 'small primary'));
      row.appendChild(btn('▶ Segment by segment', () => step(1), 'small'));
      row.appendChild(btn('🎨 Review colours', () => window._setCaveColourMode && window._setCaveColourMode('review'), 'small'));
      row.appendChild(btn('🎨 A colour each', () => window._setCaveColourMode && window._setCaveColourMode('segment'), 'small'));
      b.appendChild(row);
      const lb = el('label', 'pj-row'); const lcb = el('input'); lcb.type = 'checkbox'; lcb.checked = showLabels();
      lcb.addEventListener('change', () => setLabels(lcb.checked));
      lb.append(lcb, ' Segment names on the map (close up)');
      b.appendChild(lb);
      const vs = versions();
      const ms = el('label', 'pj-row'); const mcb = el('input'); mcb.type = 'checkbox'; mcb.checked = showMissing();
      mcb.addEventListener('change', () => { setB('missing', mcb.checked); drawVersions(); });
      ms.append(mcb, ` Draw missing surveys (${vs.length}) — dashed from where they tie in`);
      b.appendChild(ms);
      const tabs = el('div', 'pj-tabs');
      const cur = seg.listState || 'review';
      [['review', 'To review'], ['problem', 'Problems'], ['unchecked', 'Not checked'], ['partly', 'Partly'], ['checked', 'Checked'], ['all', 'All']].forEach(([k, l]) =>
        tabs.appendChild(btn(l, () => { seg.listState = k; A.render(); }, k === cur ? 'on' : '')));
      b.appendChild(tabs);
      const list = [];
      FL.liveCaves(pj.P).forEach(c => { const I = info(c.id); FL.segmentsOf(pj.P, c.id).forEach(g => list.push({ g, c, st: I.states[g.id] })); });
      const shown = list.filter(x => cur === 'all' || (x.st && x.st.state === cur))
        .sort((a, b) => String(a.g.name || '').localeCompare(String(b.g.name || ''), undefined, { numeric: true }));
      if (!shown.length) b.appendChild(el('div', 'pj-note', 'None.'));
      shown.slice(0, 150).forEach(({ g, c, st }) => {
        const r = el('div', 'pj-item');
        r.innerHTML = `<div class="pj-item-t"><span class="pjs-sw" style="background:${STATE[st.state].css}"></span>${esc(g.name || g.id)} · ${esc(c.name)}</div>`;
        r.appendChild(el('div', 'pj-sub', [g.date, `${g.shots.length} shots`, st.total ? `${st.done}/${st.total} checked` : '', st.open ? `${st.open} problem(s) to review` : '', st.problems ? `${st.problems} confirmed` : '', st.leads ? `${st.leads} suggested lead(s)` : ''].filter(Boolean).join(' · ')));
        r.addEventListener('click', () => showSegment(c.id, g.id, { fly: true }));
        b.appendChild(r);
      });
      if (shown.length > 150) b.appendChild(el('div', 'pj-note', `…and ${shown.length - 150} more.`));
      b.appendChild(btn('Remove all segments from this project…', async () => {
        const ok = await dialog({ title: 'Remove all segments?', text: `${n} segment(s). They stay in the history and documents keep their tags; turning “Use segments” off is the lighter option.`,
          buttons: [{ label: 'Cancel', value: null }, { label: 'Remove', value: 'rm', danger: true }] });
        if (ok) await record('segment.del', { segs: FL.segmentsOf(pj.P).map(g => g.id) });
      }, 'small danger'));
    });
  }

  // ── Missing surveys: survey versions drawn from their tie station ────────
  // Suggested (open) and accepted ones with readings; turned-down ones not.
  function versions() {
    if (!pj.pid) return [];
    const out = [];
    Object.values(pj.P.proposals).forEach(p => { if (p.state === 'open' && p.entry.op === 'survey.version') out.push({ e: p.entry, open: true, p }); });
    Object.values(pj.P.surveyVersions).forEach(list => list.forEach(v => { const e = pj.P.byId.get(v.id); if (e) out.push({ e, open: false }); }));
    return out.filter(x => x.e.cave && x.e.raw);
  }
  const versionsAt = (cid, stSet) => versions().filter(v => v.e.cave === cid && stSet.has((v.e.raw && v.e.raw.tie) || v.e.tie || ''));
  // The survey file a tie station is in, with every station of that cave in
  // the file's own frame (x = east, y = north, z = up, metres): readings are
  // reduced there and placed with the file's own conversion, so a missing
  // survey sits exactly as the file's shots do, however the cave was placed.
  function tieFrame(cid, tie) {
    for (const { imp, codes } of A.partsOf(cid)) {
      if (typeof imp._convertFn !== 'function') continue;
      const loc = new Map();
      const add = (p, sv) => { if (p.name && !loc.has(p.name) && codes.has(sv || '')) loc.set(p.name, [p.e, p.n, p.v]); };
      (imp.parsed.stations || []).forEach(s => add(s, s.survey));
      (imp.parsed.segments || []).forEach(sg => sg.points.forEach(p => add(p, sg.survey)));
      if (!loc.has(tie)) continue;
      const W = a => imp._convertFn(a[1], a[0], a[2]);
      const c = W(loc.get(tie));
      if (!c) continue;
      const carto = Cesium.Cartographic.fromCartesian(c);
      return { loc, W, lat: Cesium.Math.toDegrees(carto.latitude), lon: Cesium.Math.toDegrees(carto.longitude) };
    }
    return null;
  }
  let drawing = 0;
  async function drawVersions() {
    const V = window.cesiumViewer;
    if (!V || !window.Cesium) return;
    const my = ++drawing;
    if (!seg.versionSrc) { seg.versionSrc = new Cesium.CustomDataSource('pj-missing'); V.dataSources.add(seg.versionSrc); }
    const src = seg.versionSrc;
    src.entities.removeAll();
    if (!showMissing()) return;
    let drawn = 0, marked = 0, unconfirmed = 0;
    for (const { e, open } of versions()) {
      const raw = e.raw || {};
      const tie = raw.tie || e.tie;
      const F = tie ? tieFrame(e.cave, tie) : null;
      if (!F) continue;
      const color = Cesium.Color.fromCssColorString(open ? MISSING_OPEN : MISSING_ACCEPTED);
      const W = F.W;
      const n = (raw.shots || []).length;
      const label = `${open ? 'Suggested' : 'Accepted'} missing survey ${e.code || ''} (${n} shot${n === 1 ? '' : 's'})`;
      const props = { isFieldStation: true, cave: e.cave, stationName: tie || '', survey: e.code || '' };
      const bad = raw.tieCheck === 'unconfirmed';
      let legs = [];
      if (!bad && n) {
        let d = raw.decl != null && isFinite(Number(raw.decl)) ? { v: Number(raw.decl), src: 'given' } : null;
        if (!d) { const w = await A.declAt(F.lat, F.lon, A.yearOf(raw.date)); d = w != null ? { v: w, src: 'WMM' } : { v: 0, src: 'unknown' }; }
        if (my !== drawing) return;
        const res = FL.computeSurvey({ tie, lenUnit: raw.lenUnit || 'ft', shots: raw.shots }, F.loc, { decl: () => d, conv: () => 0 });
        legs = res.legs;
        legs.forEach(L => src.entities.add({
          polyline: { positions: [W(L.a), W(L.b)], width: 3, material: new Cesium.PolylineDashMaterialProperty({ color, dashLength: 12 }),
                      depthFailMaterial: new Cesium.PolylineDashMaterialProperty({ color: color.withAlpha(0.4), dashLength: 12 }) },
          name: label, description: `${esc(L.from)} → ${esc(L.to)}<br>Drawn from the readings in the notes; not in the survey file.`,
          properties: props,
        }));
        if (legs.length) drawn++;
      }
      if (bad) unconfirmed++;
      src.entities.add({
        position: W(F.loc.get(tie)),
        label: { text: bad ? '＋?' : '＋', font: 'bold 16px sans-serif', fillColor: color, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
                 style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(10, 10), disableDepthTestDistance: 5000 },
        name: label + (bad ? ' — tie not confirmed' : ' ties in here'),
        description: bad ? 'The stations the notes name don’t fit the readings together, so it isn’t drawn: check the notes (Suggestions → Missing surveys).' : 'Drawn dashed from the readings in the notes.',
        properties: props,
      });
      marked++;
    }
    seg.versionStats = { drawn, marked, unconfirmed };
    V.scene.requestRender && V.scene.requestRender();
  }

  // ── Styles ───────────────────────────────────────────────────────────────
  const style = el('style');
  style.textContent = `
  #pjs-dock { position: fixed; top: 0; right: 0; bottom: 0; width: 460px; z-index: 9500; background: rgba(16,16,26,.97); color: #e8e8ee;
    font: 12px system-ui, sans-serif; display: none; flex-direction: column; box-shadow: -4px 0 18px rgba(0,0,0,.5); border-left: 1px solid rgba(255,255,255,.12); }
  #pjs-dock.open { display: flex; }
  .pjs-grip { position: absolute; left: -4px; top: 0; bottom: 0; width: 8px; cursor: ew-resize; }
  .pjs-head { padding: 8px 10px 4px; border-bottom: 1px solid rgba(255,255,255,.08); }
  .pjs-head-r { display: flex; align-items: center; gap: 4px; }
  .pjs-title { flex: 1; min-width: 0; font-size: 13px; }
  .pjs-station { max-height: 30vh; overflow: auto; border-bottom: 1px solid rgba(255,255,255,.08); }
  #pjs-dock #pj-card { position: static; width: auto; max-height: none; box-shadow: none; border: none; border-radius: 0; background: transparent; margin: 0; }
  #pjs-dock #pj-card:not(.open) { display: none; }
  .pjs-tabs { display: flex; flex-wrap: wrap; gap: 2px; padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,.08); }
  .pjs-tabs:empty { display: none; }
  .pjs-tabs .pj-btn.on { background: rgba(33,150,243,.45); border-color: #2196F3; }
  .pjs-body { flex: 1; overflow: auto; padding: 6px 10px 20px; }
  .pjs-chip { display: inline-block; font-size: 10px; color: #111; border-radius: 8px; padding: 0 6px; margin-left: 4px; font-weight: 600; }
  .pjs-sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
  .pjs-legend { font-size: 11px; opacity: .9; margin: 4px 0; line-height: 1.6; }
  .pjs-note { flex: 1; min-width: 90px; width: auto; padding: 2px 6px; font-size: 11px; }
  .pjs-filter > * { flex: 1; min-width: 120px; width: auto; }
  .pjs-expl { font-size: 11px; opacity: .65; margin: 2px 0 6px; line-height: 1.35; }
  .pjs-q { background: rgba(255,255,255,.05); border-radius: 6px; padding: 6px 8px; margin: 5px 0; }
  .pjs-q-t { font-weight: 600; line-height: 1.35; }
  .pjs-q-w { font-size: 11px; color: #9fd0ff; margin-top: 2px; }
  .pjs-q-e { font-size: 11px; margin-top: 3px; padding: 3px 6px; border-left: 3px solid #2196F3; background: rgba(33,150,243,.08); }
  .pjs-q-v { font-size: 11px; opacity: .7; margin-top: 3px; }
  .pjs-group { margin: 6px 0; }
  .pjs-group-h { display: flex; justify-content: space-between; cursor: pointer; padding: 6px 4px; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,.08); }
  .pjs-facts { display: grid; gap: 2px; margin: 6px 0; }
  .pjs-fact { display: grid; grid-template-columns: 70px 1fr; gap: 6px; }
  .pjs-fact span:first-child { opacity: .55; }
  .pjs-bar { height: 6px; background: rgba(255,255,255,.1); border-radius: 3px; margin: 3px 0 8px; }
  .pjs-bar div { height: 100%; background: #3ccf6e; border-radius: 3px; }
  .pjs-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 6px; margin: 8px 0; }
  .pjs-tile { background: rgba(255,255,255,.05); border-radius: 6px; padding: 6px 8px; cursor: pointer; opacity: .6; }
  .pjs-tile.has { opacity: 1; } .pjs-tile:hover { background: rgba(255,255,255,.1); }
  .pjs-tile .n { font-size: 15px; font-weight: 600; } .pjs-tile .x { font-size: 10px; opacity: .6; }
  .pjs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; margin-top: 6px; }
  .pjs-thumb { cursor: pointer; background: rgba(255,255,255,.04); border-radius: 6px; padding: 4px; }
  .pjs-thumb img { width: 100%; height: 140px; object-fit: cover; object-position: top; background: #fff; border-radius: 3px; display: block; }
  .pjs-pdf { height: 140px; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.08); }
  .pjs-cap { font-size: 11px; margin-top: 3px; line-height: 1.25; max-height: 2.5em; overflow: hidden; } .pjs-cap2 { font-size: 10px; opacity: .55; }
  .pjs-page { overflow: auto; background: #222; border-radius: 4px; }
  .pjs-page img { width: 100%; display: block; background: #fff; cursor: zoom-in; }
  .pjs-page.zoom img { width: 220%; max-width: none; cursor: zoom-out; }
  .pjs-page iframe { width: 100%; height: 75vh; border: 0; background: #fff; }
  .pjs-docked .cesium-viewer-infoBoxContainer { display: none; }`;
  document.head.appendChild(style);

  window._pjSeg = { on, changed, card, section, review: showList, showList, showSegment, closeDock, step, setLabels, drawVersions, info, effectText, segName, dockOpen };
  // Draw once the project and the caves are there.
  setTimeout(() => changed(null), 1500);
})();
