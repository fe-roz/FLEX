// trips.js — 🧭 Trips: the open project's trips (a day or a run of days, who
// went, the caves visited, and that trip's surveys, notes and photos).
//
// A trip is a project record (flexlib `trip.set`, saved at once like points,
// with History / undo, carried by sync files). The links to segments, notes and
// documents are kept on the trip; FLEX suggests them from the trip's days and
// caves (FL.tripSuggest) and the person accepts or removes them. project.js
// draws the panel (`window._pjTrips.section`, called from its render()).
(function () {
  'use strict';
  const A = window._pjApi;
  if (!A) return;
  const { pj, FL, el, btn, esc, dialog, toast, record } = A;
  const st = { open: null, picked: new Set() };           // the open trip; ticked suggestions
  window._pjTripsState = st;                              // tests

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const parts = d => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null; };
  /** "10 Oct 2026", "10–12 Oct 2026", "30 Oct – 2 Nov 2026" (a one-day trip has no end). */
  function range(t) {
    const a = parts(t.start), b = parts(t.end);
    if (!a) return 'No date';
    const one = x => `${x.d} ${MONTHS[x.m]} ${x.y}`;
    if (!b || (b.y === a.y && b.m === a.m && b.d === a.d)) return one(a);
    if (b.y !== a.y) return `${one(a)} – ${one(b)}`;
    if (b.m !== a.m) return `${a.d} ${MONTHS[a.m]} – ${b.d} ${MONTHS[b.m]} ${b.y}`;
    return `${a.d}–${b.d} ${MONTHS[a.m]} ${a.y}`;
  }
  const caveNames = t => t.caves.map(c => A.caveName(c)).filter(Boolean);
  const live = () => FL.tripsOf(pj.P);

  // ── What a trip links to ───────────────────────────────────────────────────
  function linked(t) {
    const segs = [], notes = [], docs = [];
    t.links.forEach(k => {
      const i = k.indexOf(':'), kind = k.slice(0, i), id = k.slice(i + 1);
      if (kind === 'segment') { const g = pj.P.segments[id]; if (g && !g.removed) segs.push(g); }
      else if (kind === 'note') { const n = pj.P.notes[id]; if (n && !n.deleted) notes.push(n); }
      else if (kind === 'doc') { const d = pj.D && pj.D.docs[id]; if (d && !d.deleted) docs.push(d); }
    });
    segs.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.name).localeCompare(String(b.name)));
    return { segs, notes, docs, photos: docs.filter(d => FL.docMedia(d) === 'photo'), other: docs.filter(d => FL.docMedia(d) !== 'photo') };
  }
  /** Length of a segment in metres from the loaded survey (0 when its cave is not loaded). */
  function segLength(g) {
    let L = 0;
    try { g.shots.forEach(([a, b]) => { const pa = A.stationPos(g.cave, a), pb = A.stationPos(g.cave, b); if (pa && pb) L += Cesium.Cartesian3.distance(pa, pb); }); } catch (_) {}
    return L;
  }
  const lenText = m => m ? `${Math.round(m)} m (${Math.round(m / 0.3048)} ft)` : '';

  // ── Saving ─────────────────────────────────────────────────────────────────
  async function save(id, next) {
    const cur = id ? pj.P.trips[id] : null;
    const body = FL.tripEdit(cur, next);
    if (!body) return null;
    const e = await record('trip.set', Object.assign({ trip: id || FL.uid(10) }, body));
    A.render();
    return e;
  }
  const setLinks = (t, f) => save(t.id, { links: f(t.links.slice()) });

  // ── Edit / new ─────────────────────────────────────────────────────────────
  function knownPeople() {
    const s = new Set();
    live().forEach(t => t.people.forEach(p => s.add(p)));
    FL.segmentsOf(pj.P).forEach(g => String(g.team || '').split(/[,;]/).forEach(p => { p = p.trim(); if (p) s.add(p); }));
    return [...s].sort();
  }
  async function edit(t, draft) {
    const v = Object.assign({ name: t ? t.name : '', start: t ? t.start : '', end: t ? t.end : '', desc: t ? t.desc : '',
      people: t ? t.people : [], caves: t ? t.caves : [] }, draft || {});
    if (!(await A.ensureAuthor())) return;
    const body = el('div', 'tr-form');
    const field = (label, node) => { const r = el('div', 'pj-f'); r.appendChild(el('div', 'pj-f-l', label)); r.appendChild(node); body.appendChild(r); return node; };
    const inp = (type, value, ph) => { const i = el('input', 'pj-input'); i.type = type; i.value = value || ''; if (ph) i.placeholder = ph; return i; };
    const name = field('Name', inp('text', v.name, 'e.g. Cave Ridge weekend'));
    name.dataset.f = 'name';
    const dates = el('div', 'tr-dates');
    const start = inp('date', v.start), end = inp('date', v.end);
    start.dataset.f = 'start'; end.dataset.f = 'end';
    const dr = el('div', 'pj-f'); dr.appendChild(el('div', 'pj-f-l', 'Date, and the last day if it lasted several days'));
    dates.append(start, el('span', 'pj-sub', 'to'), end); dr.appendChild(dates); body.appendChild(dr);
    const people = field('People (names, separated by commas)', inp('text', v.people.join(', '), 'e.g. A. Tester, B. Tester'));
    people.setAttribute('list', 'tr-people-list');
    people.dataset.f = 'people';
    const dl = document.createElement('datalist'); dl.id = 'tr-people-list';
    knownPeople().forEach(p => dl.appendChild(new Option(p)));
    body.appendChild(dl);
    const cr = el('div', 'pj-f'); cr.appendChild(el('div', 'pj-f-l', 'Caves visited'));
    const box = el('div', 'tr-caves');
    const caves = FL.liveCaves(pj.P);
    if (!caves.length) box.appendChild(el('div', 'pj-sub', 'The project has no caves yet.'));
    caves.forEach(c => {
      const l = el('label', 'tr-cave'), cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'keep-box'; cb.value = c.id; cb.checked = v.caves.includes(c.id);
      l.append(cb, document.createTextNode(' ' + c.name)); box.appendChild(l);
    });
    cr.appendChild(box); body.appendChild(cr);
    const desc = field('Notes about the trip', Object.assign(el('textarea', 'pj-input'), { rows: 3, value: v.desc }));
    desc.dataset.f = 'desc';
    const r = await dialog({ title: t ? 'Edit trip' : 'New trip', body, wide: true,
      buttons: [{ label: 'Cancel', value: null }, { label: t ? 'Save' : 'Create trip', value: 'ok', primary: true }] });
    if (!r) return;
    const a = start.value, b = end.value;
    const typed = () => ({ name: name.value, start: a, end: b, desc: desc.value, people: people.value.split(',').map(x => x.trim()).filter(Boolean), caves: [...box.querySelectorAll('input:checked')].map(i => i.value) });
    if (!a) { toast('A trip needs a date'); return edit(t, typed()); }
    if (b && b < a) { toast('The last day is before the first'); return edit(t, typed()); }
    const next = { name: name.value.trim() || ('Trip ' + a), start: a, end: b && b !== a ? b : '', desc: desc.value.trim(),
      people: people.value.split(',').map(x => x.trim()).filter(Boolean), caves: [...box.querySelectorAll('input:checked')].map(i => i.value) };
    const e = await save(t && t.id, next);
    if (e && !t) { st.open = e.trip; st.picked = new Set(); A.render(); }
  }
  async function remove(t) {
    const r = await dialog({ title: 'Delete this trip?', text: `“${t.name}” (${range(t)}) is removed from the list. Its surveys, notes and photos stay; History can bring the trip back.`,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Delete trip', value: 'del', danger: true }] });
    if (!r) return;
    if (st.open === t.id) st.open = null;
    await save(t.id, { removed: true });
  }

  // ── The card ───────────────────────────────────────────────────────────────
  function sub(card, title, n) { const h = el('div', 'tr-h', title + (n != null ? ` (${n})` : '')); card.appendChild(h); return h; }
  function removeX(t, key, what) {
    const b = btn(['x'], () => setLinks(t, l => l.filter(k => k !== key)), 'small tr-x'); b.title = 'Take ' + what + ' off this trip (it stays in the project)'; return b;
  }
  function segRow(t, g) {
    const r = el('div', 'pj-item tr-row'), len = segLength(g);
    const x = el('div', 'tr-main');
    x.appendChild(el('div', 'pj-item-t', ['ruler', g.name || g.id]));
    x.appendChild(el('div', 'pj-sub', [A.caveName(g.cave), g.date, `${g.shots.length} shots`, lenText(len)].filter(Boolean).join(' · ')));
    r.append(x, removeX(t, 'segment:' + g.id, 'this survey'));
    r.addEventListener('click', () => { if (window._pjSeg) window._pjSeg.showSegment(g.cave, g.id, { fly: true }); });
    return r;
  }
  function row(node, t, key, what) {
    const r = el('div', 'tr-row'); node.classList.add('tr-main'); r.append(node, removeX(t, key, what)); return r;
  }
  function photoThumb(t, d) {
    const w = el('div', 'tr-photo'), p = d.pages[0];
    if (p && p.ext !== 'pdf') { const im = el('img', 'tr-img'); im.loading = 'lazy'; im.src = A.blobUrl(p); if (p.rot) im.style.transform = `rotate(${p.rot}deg)`; im.alt = d.title || 'Photo'; w.appendChild(im); }
    else w.appendChild(el('div', 'tr-img tr-img-x', ['image']));
    w.title = d.title || 'Photo';
    w.addEventListener('click', () => A.docOpen(d.id, 0));
    const x = removeX(t, 'doc:' + d.id, 'this photo'); w.appendChild(x);
    return w;
  }
  function suggestions(card, t) {
    const sg = FL.tripSuggest(pj.P, pj.D, t);
    const items = [].concat(
      sg.segments.map(g => ({ key: 'segment:' + g.id, label: ['ruler', `${g.name || g.id} · ${A.caveName(g.cave)} · ${g.date}`] })),
      sg.notes.map(n => ({ key: 'note:' + n.id, label: ['note', `${(n.text || '').slice(0, 70)} · ${A.targetLabel(n.target)}`] })),
      sg.docs.map(d => ({ key: 'doc:' + d.id, label: [FL.docMedia(d) === 'photo' ? 'image' : 'doc', `${d.title || 'Untitled'}${d.date ? ' · ' + d.date : ''}`] })));
    if (!items.length) return;
    const box = el('div', 'tr-sug');
    box.appendChild(el('div', 'tr-h', `Suggested from the dates and caves (${items.length})`));
    box.appendChild(el('div', 'pj-sub', 'Surveys, notes and photos from the trip’s days in the caves it visited. Tick what belongs to this trip.'));
    items.forEach(it => {
      const l = el('label', 'tr-sug-i'), cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'keep-box'; cb.checked = st.picked.has(it.key);
      cb.addEventListener('change', () => { cb.checked ? st.picked.add(it.key) : st.picked.delete(it.key); });
      const tx = el('span', '', it.label);
      l.append(cb, tx); box.appendChild(l);
    });
    const bar = el('div', 'pj-row');
    bar.appendChild(btn(['check', 'Add ticked'], () => {
      const ks = items.map(i => i.key).filter(k => st.picked.has(k));
      if (!ks.length) { toast('Tick what to add'); return; }
      ks.forEach(k => st.picked.delete(k));
      setLinks(t, l => l.concat(ks));
    }, 'small primary'));
    bar.appendChild(btn('Add all', () => { items.forEach(i => st.picked.delete(i.key)); setLinks(t, l => l.concat(items.map(i => i.key))); }, 'small'));
    box.appendChild(bar);
    card.appendChild(box);
  }
  function card(t) {
    const c = el('div', 'tr-card'), L = linked(t);
    const top = el('div', 'pj-row');
    top.appendChild(btn(['pencil', 'Edit'], () => edit(t), 'small'));
    top.appendChild(btn(['trash', 'Delete'], () => remove(t), 'small'));
    c.appendChild(top);
    if (t.desc) c.appendChild(el('div', 'pj-sub tr-desc', t.desc));
    sub(c, 'People', t.people.length);
    const pr = el('div', 'pj-row tr-chips');
    if (!t.people.length) pr.appendChild(el('span', 'pj-sub', 'None named.'));
    t.people.forEach(p => pr.appendChild(el('span', 'tr-chip', ['user', p])));
    c.appendChild(pr);
    sub(c, 'Caves visited', t.caves.length);
    const cr = el('div', 'pj-row tr-chips');
    if (!t.caves.length) cr.appendChild(el('span', 'pj-sub', 'None picked (Edit to pick them).'));
    t.caves.forEach(id => cr.appendChild(el('span', 'tr-chip', ['cave', A.caveName(id) || id])));
    c.appendChild(cr);
    suggestions(c, t);
    const total = L.segs.reduce((s, g) => s + segLength(g), 0);
    sub(c, 'Surveys', L.segs.length);
    if (!L.segs.length) c.appendChild(el('div', 'pj-sub', 'None linked.'));
    L.segs.forEach(g => c.appendChild(segRow(t, g)));
    if (total) c.appendChild(el('div', 'pj-sub tr-total', 'Surveyed on this trip: ' + lenText(total)));
    sub(c, 'Notes', L.notes.length);
    if (!L.notes.length) c.appendChild(el('div', 'pj-sub', 'None linked.'));
    L.notes.forEach(n => c.appendChild(row(A.noteEl(n), t, 'note:' + n.id, 'this note')));
    sub(c, 'Photos', L.photos.length);
    if (!L.photos.length) c.appendChild(el('div', 'pj-sub', 'None linked.'));
    else { const g = el('div', 'tr-photos'); L.photos.forEach(d => g.appendChild(photoThumb(t, d))); c.appendChild(g); }
    if (L.other.length) { sub(c, 'Documents and videos', L.other.length); L.other.forEach(d => c.appendChild(row(A.docEl(d), t, 'doc:' + d.id, 'this document'))); }
    return c;
  }

  // ── The list ───────────────────────────────────────────────────────────────
  function section(parent, sectionFn) {
    const all = pj.pid && pj.P ? live() : [];
    sectionFn(parent, `Trips (${all.length})`, true, b => {
      b.appendChild(el('div', 'pj-row')).appendChild(btn(['plus', 'New trip'], () => edit(null), 'small primary'));
      if (!all.length) { b.appendChild(el('div', 'pj-note', 'A trip is a day or a few days in the field: who went, which caves, and that trip’s surveys, notes and photos. Make one with New trip; FLEX suggests the surveys, notes and photos from its dates.')); return; }
      all.forEach(t => {
        const open = st.open === t.id;
        const r = el('div', 'pj-item tr-item' + (open ? ' open' : ''));
        r.dataset.trip = t.id;
        r.appendChild(el('div', 'pj-item-t', ['compass', t.name || 'Trip']));
        const cv = caveNames(t);
        r.appendChild(el('div', 'pj-sub', [range(t), t.people.length ? t.people.length + (t.people.length === 1 ? ' person' : ' people') : '',
          cv.length ? cv.slice(0, 3).join(', ') + (cv.length > 3 ? ` +${cv.length - 3}` : '') : ''].filter(Boolean).join(' · ')));
        r.addEventListener('click', () => { st.open = open ? null : t.id; st.picked = new Set(); A.render(); });
        b.appendChild(r);
        if (open) b.appendChild(card(t));
      });
    });
  }

  const css = document.createElement('style');
  css.textContent = `
  .tr-item { cursor: pointer; } .tr-item.open { border-color: var(--ui-on, #3fb871); }
  .tr-card { margin: 0 0 8px 6px; padding: 4px 0 4px 8px; border-left: 2px solid rgba(255,255,255,.15); }
  .tr-h { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; opacity: .6; margin: 8px 0 3px; font-weight: 700; }
  .tr-row { display: flex; align-items: center; gap: 6px; } .tr-row .tr-main { flex: 1; min-width: 0; }
  .tr-chips { flex-wrap: wrap; gap: 4px; } .tr-chip { background: rgba(255,255,255,.1); border-radius: 10px; padding: 1px 8px; font-size: 12px; }
  .tr-photos { display: grid; grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); gap: 4px; }
  .tr-photo { position: relative; aspect-ratio: 1; cursor: pointer; border-radius: 4px; overflow: hidden; background: rgba(255,255,255,.08); }
  .tr-img { width: 100%; height: 100%; object-fit: cover; display: block; } .tr-img-x { display: flex; align-items: center; justify-content: center; }
  .tr-photo .tr-x { position: absolute; top: 2px; right: 2px; padding: 0 2px; line-height: 1; background: rgba(0,0,0,.65); border-radius: 3px; }
  .tr-sug { border: 1px dashed rgba(255,255,255,.25); border-radius: 6px; padding: 4px 8px 6px; margin: 6px 0; }
  .tr-sug-i { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; margin: 2px 0; cursor: pointer; }
  .tr-dates { display: flex; gap: 6px; align-items: center; } .tr-caves { max-height: 140px; overflow: auto; }
  .tr-cave { display: block; margin: 1px 0; cursor: pointer; } .tr-total { margin-top: 3px; }
  .tr-desc { white-space: pre-wrap; margin: 4px 0; }`;
  document.head.appendChild(css);

  window._pjTrips = { section, range, edit, remove, save, linked, state: st };
})();
