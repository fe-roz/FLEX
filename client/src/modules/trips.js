// trips.js — "Same trip" and the Trip… action. There is no Trips panel: a trip
// is only a way to see which surveys and documents belong together.
//
// FLEX suggests trips from survey dates (FL.tripGroups: surveys of the project
// on the same day or on consecutive days, plus the documents dated inside
// them). A trip record (flexlib `trip.set`; links `segment:<id>`, `doc:<id>`)
// wins over a suggestion. Trip… on a survey or a document corrects it: pick
// another trip, start a new one, or "not part of a trip".
//
// window._pjTrips = {
//   range(t)            "10 Oct 2026", "10–12 Oct 2026" …
//   shortRange(t)       "12–13 Oct" (no year)
//   group(key)          the trip group of 'segment:<id>' | 'doc:<id>', or null
//   sameTrip(key)       { label, node } when other surveys / documents share the trip, else null
//   pick(key)           the Trip… dialog (resolves when closed)
// }
(function () {
  'use strict';
  const A = window._pjApi;
  if (!A) return;
  const { pj, FL, el, btn, dialog, toast, record } = A;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const parts = d => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null; };
  const same = (a, b) => b.y === a.y && b.m === a.m && b.d === a.d;
  /** "10 Oct 2026", "10–12 Oct 2026", "30 Oct – 2 Nov 2026" (a one-day trip has no end). */
  function range(t) {
    const a = parts(t.start), b = parts(t.end);
    if (!a) return 'No date';
    const one = x => `${x.d} ${MONTHS[x.m]} ${x.y}`;
    if (!b || same(a, b)) return one(a);
    if (b.y !== a.y) return `${one(a)} – ${one(b)}`;
    if (b.m !== a.m) return `${a.d} ${MONTHS[a.m]} – ${b.d} ${MONTHS[b.m]} ${b.y}`;
    return `${a.d}–${b.d} ${MONTHS[a.m]} ${a.y}`;
  }
  /** "12 Oct", "12–13 Oct", "30 Oct – 2 Nov". */
  function shortRange(t) {
    const a = parts(t.start), b = parts(t.end);
    if (!a) return '';
    if (!b || same(a, b)) return `${a.d} ${MONTHS[a.m]}`;
    if (b.m !== a.m || b.y !== a.y) return `${a.d} ${MONTHS[a.m]} – ${b.d} ${MONTHS[b.m]}`;
    return `${a.d}–${b.d} ${MONTHS[a.m]}`;
  }

  const groups = () => (pj.pid && pj.P ? FL.tripGroups(pj.P, pj.D) : { groups: [], by: new Map() });
  const group = key => groups().by.get(key) || null;

  /** The surveys and documents that share the trip of `key` (not counting `key`), or null. */
  function sameTrip(key) {
    const g = group(key);
    if (!g) return null;
    const segs = g.segments.filter(s => 'segment:' + s.id !== key), docs = g.docs.filter(d => 'doc:' + d.id !== key);
    if (!segs.length && !docs.length) return null;
    const node = el('span', 'tr-same');
    node.dataset.trip = g.id;
    const sep = () => node.appendChild(document.createTextNode(' · '));
    if (segs.length) {
      node.appendChild(document.createTextNode(segs.length === 1 ? 'survey ' : 'surveys '));
      segs.forEach((s, i) => {
        if (i) node.appendChild(document.createTextNode(', '));
        const b = btn(s.name || s.id, () => { if (window._pjSeg) window._pjSeg.showSegment(s.cave, s.id, { fly: true }); }, 'link tr-seg');
        b.dataset.seg = s.id; b.title = 'Open this survey';
        node.appendChild(b);
      });
    }
    if (docs.length) {
      if (segs.length) sep();
      const list = el('span', 'tr-docs');
      list.style.display = 'none';
      docs.forEach(d => {
        const b = btn(d.title || 'Untitled', () => A.docOpen(d.id, 0), 'link tr-doc');
        b.dataset.doc = d.id; b.style.display = 'block';
        list.appendChild(b);
      });
      const t = btn(`${docs.length} ${docs.length === 1 ? 'document' : 'documents'}`, () => { list.style.display = list.style.display === 'none' ? '' : 'none'; }, 'link tr-docs-t');
      t.title = 'Show them';
      node.append(t, list);
    }
    const when = shortRange(g);
    return { label: 'Same trip' + (g.name || when ? ` (${[g.name, when].filter(Boolean).join(', ')})` : ''), node, group: g };
  }

  // ── Trip… ──────────────────────────────────────────────────────────────────
  function knownPeople() {
    const s = new Set();
    FL.tripsOf(pj.P).forEach(t => t.people.forEach(p => s.add(p)));
    FL.segmentsOf(pj.P).forEach(g => String(g.team || '').split(/[,;]/).forEach(p => { p = p.trim(); if (p) s.add(p); }));
    return [...s].sort();
  }
  const describe = g => `${range(g)}${g.name ? ' · ' + g.name : ''} · ${g.segments.length} ${g.segments.length === 1 ? 'survey' : 'surveys'}, ${g.docs.length} ${g.docs.length === 1 ? 'document' : 'documents'}${g.suggested ? ' (suggested)' : ''}`;

  /** Pick the trip of a survey or document: another trip, a new one, or none. */
  async function pick(key, draft) {
    if (!pj.pid || !pj.P) return;
    if (!(await A.ensureAuthor())) return;
    const G = groups(), cur = G.by.get(key) || null;
    const nt = pj.P.trips[FL.TRIP_NONE];
    const isNone = !cur && !!nt && !nt.removed && nt.links.includes(key);
    const d = Object.assign({ choice: draft ? 'new' : (cur ? cur.id : isNone ? 'none' : null), name: '', start: '', end: '', people: '' }, draft || {});
    const body = el('div', 'tr-form');
    body.appendChild(el('div', 'pj-sub', key.startsWith('segment:') ? 'Which trip was this survey part of? Surveys on the same day or on consecutive days are suggested as one trip.' : 'Which trip does this document belong to?'));
    const list = el('div', 'tr-list');
    const radio = (value, label, checked) => {
      const l = el('label', 'tr-opt'), r = document.createElement('input');
      r.type = 'radio'; r.name = 'tr-pick'; r.value = value; r.checked = checked; r.className = 'keep-box';
      l.append(r, document.createTextNode(' ' + label)); list.appendChild(l); return r;
    };
    G.groups.forEach(g => radio(g.id, describe(g), d.choice === g.id));
    radio('none', 'Not part of a trip', d.choice === 'none');
    radio('new', 'Start a new trip…', d.choice === 'new');
    body.appendChild(list);
    const form = el('div', 'tr-new');
    const field = (label, node) => { const r = el('div', 'pj-f'); r.appendChild(el('div', 'pj-f-l', label)); r.appendChild(node); form.appendChild(r); return node; };
    const inp = (type, value, ph) => { const i = el('input', 'pj-input'); i.type = type; i.value = value || ''; if (ph) i.placeholder = ph; return i; };
    const name = field('Name (optional)', inp('text', d.name, 'e.g. Cave Ridge weekend'));
    const dates = el('div', 'tr-dates');
    const start = inp('date', d.start), end = inp('date', d.end);
    dates.append(start, el('span', 'pj-sub', 'to'), end);
    const dr = el('div', 'pj-f'); dr.appendChild(el('div', 'pj-f-l', 'Date, and the last day if it lasted several days')); dr.appendChild(dates); form.appendChild(dr);
    const people = field('People (optional, separated by commas)', inp('text', d.people, 'e.g. A. Tester, B. Tester'));
    people.setAttribute('list', 'tr-people-list');
    const dl = document.createElement('datalist'); dl.id = 'tr-people-list';
    knownPeople().forEach(p => dl.appendChild(new Option(p)));
    form.appendChild(dl);
    name.dataset.f = 'name'; start.dataset.f = 'start'; end.dataset.f = 'end'; people.dataset.f = 'people';
    body.appendChild(form);
    const radios = [...list.querySelectorAll('input')];
    const show = () => { const r = radios.find(x => x.checked); form.style.display = r && r.value === 'new' ? '' : 'none'; };
    radios.forEach(r => r.addEventListener('change', show)); show();
    // typing a new trip's details picks "Start a new trip"
    [name, start, end, people].forEach(i => i.addEventListener('input', () => { radios.find(x => x.value === 'new').checked = true; show(); }));
    const ans = await dialog({ title: 'Trip…', body, wide: true, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }] });
    if (!ans) return;
    const ch = (radios.find(x => x.checked) || {}).value;
    if (!ch) return;
    const typed = () => ({ choice: 'new', name: name.value, start: start.value, end: end.value, people: people.value });
    let to;
    if (ch === 'none') to = { none: true };
    else if (ch === 'new') {
      if (!start.value) { toast('A new trip needs a date'); return pick(key, typed()); }
      if (end.value && end.value < start.value) { toast('The last day is before the first'); return pick(key, typed()); }
      to = { create: { name: name.value.trim(), start: start.value, end: end.value, people: people.value.split(',').map(x => x.trim()).filter(Boolean) } };
    } else to = { trip: ch };
    if (cur && ch === cur.id && !cur.suggested) return;
    const moves = FL.tripMoves(pj.P, pj.D, key, to);
    for (const m of moves) await record('trip.set', Object.assign({ trip: m.trip }, m.body));
    A.render();
  }

  const css = document.createElement('style');
  css.textContent = `
  .tr-list { max-height: 220px; overflow: auto; margin: 6px 0; } .tr-opt { display: block; margin: 2px 0; cursor: pointer; font-size: 12.5px; }
  .tr-dates { display: flex; gap: 6px; align-items: center; } .tr-new { margin-top: 6px; }
  .tr-same .link { padding: 0; } .tr-docs { margin: 2px 0 0 8px; }
  .tr-line { margin: 6px 0; font-size: 12px; }`;
  document.head.appendChild(css);

  window._pjTrips = { range, shortRange, group, sameTrip, pick };
})();
