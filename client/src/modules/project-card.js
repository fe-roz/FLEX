// FLEX project (station card, Files and History of what is selected).
// Part of project.js, split into classic scripts that load in order (index.html);
// they share their functions through window._pjParts until project.js has loaded.
// Behaviour unchanged. See client/src/README.md.
(function () {
  'use strict';
  const X = window._pjParts;
  if (!X) return;                          // project-ui-kit.js found no flexlib.js
  const { imps, caveFor, pj, $, el, caveName, btn, choose, linkFile, history, FL, noteEl, leadsAt, leadEl, docEl, docGroupsInto, editNote, editLead, addPages, partsOf, describe, when, inverse, record, allLeads, leadSummary, toast, targetLabel, docSub, stationPos, stationsOf } = X;

  // ── Station card ───────────────────────────────────────────────────────────
  function onSelect(entity) {
    const pr = entity && entity.properties;
    const get = k => (pr && pr[k] ? pr[k].getValue() : null);
    if (!pr) { closeCard(); if (window._sel) window._sel.clear(); return; }
    if (get('isCaveSurvey') && window._sel && window._sel.active()) return;     // selection.js chose what to show
    if (get('isFeatureLead') || get('isCaveLead')) { closeCard(); return; }        // the details panel shows it (info-panel.js); ✏️ there edits it
    if (get('isFieldStation')) { openCard({ cid: get('cave'), name: get('stationName'), field: true }); return; }
    if (!get('isCaveSurvey')) { closeCard(); return; }
    const imp = imps().find(i => i.name === get('surveyName'));
    const code = get('surveyCode') || '';
    const name = get('stationName');
    if (name) { openCard({ imp, code, cid: caveFor(imp, code), name }); return; }
    const ends = String(entity.name || '').split(' → ');
    openCard({ imp, code, cid: caveFor(imp, code), survey: true, ends: ends.length === 2 ? ends : [] });
  }
  function openCard(c) { pj.card = c; renderCard(); }
  function closeCard() { pj.card = null; const e = $('pj-card'); if (e) e.classList.remove('open'); }
  function refreshCard() { if (pj.card) renderCard(); }
  function renderCard() {
    const c = pj.card;
    let box = $('pj-card');
    if (!box) { box = el('div'); box.id = 'pj-card'; document.body.appendChild(box); }
    box.textContent = '';
    box.classList.add('open');
    const head = el('div', 'pj-card-h');
    head.appendChild(el('div', 'pj-card-t', c.level === 'cave' ? ['cave', c.cid ? caveName(c.cid) : (c.imp ? c.imp.name : 'Cave')] : c.survey ? `Survey ${c.code || '(none)'}` : ['pin', `${c.name}${c.field ? ' (field)' : ''}`]));
    head.appendChild(btn('✕', closeCard, 'small'));
    box.appendChild(head);
    if (!pj.pid) {
      box.appendChild(el('div', 'pj-note', 'Notes and documents belong to a project: open Project to choose or create one. A lead can be kept in My data without one.'));
      if (window._flexLeads) window._flexLeads.card(box, c);
      return;
    }
    if (!c.cid) {
      box.appendChild(el('div', 'pj-note', `“${c.imp ? c.imp.name : 'This file'}” isn’t a cave of “${pj.P.name || 'this project'}” yet.`));
      if (c.imp) box.appendChild(btn('Link it to a cave…', async () => { await linkFile(c.imp); c.cid = caveFor(c.imp, c.code); renderCard(); }, 'primary'));
      if (window._flexLeads) window._flexLeads.card(box, c);          // a lead there goes to My data
      return;
    }
    // Picked with selection.js: Details / Files / History.
    if (c.level) {
      const tgt = cardTarget(c), tab = pj.cardTab && pj.cardTabFor === tgt ? pj.cardTab : 'details';
      const files = filesOf(c), hist = historyOf(c);
      const tabs = el('div', 'pj-tabs pj-card-tabs');
      [['details', 'Details'], ['files', `Files (${files.own.length + files.below.length})`], ['history', `History (${hist.length})`]].forEach(([k, l]) =>
        tabs.appendChild(btn(l, () => { pj.cardTab = k; pj.cardTabFor = tgt; renderCard(); }, tab === k ? 'on' : '')));
      box.appendChild(tabs);
      if (tab === 'files') { filesTab(box, c, files); return; }
      if (tab === 'history') { box.appendChild(historyBody(hist)); return; }
    }
    if (c.level === 'cave') { caveCard(box, c); return; }
    box.appendChild(el('div', 'pj-sub', caveName(c.cid) + (c.code && !c.survey ? ` · survey ${c.code}` : '')));
    const target = c.survey ? FL.T.survey(c.cid, c.code) : FL.T.station(c.cid, c.name);
    const sec = (title, items) => { if (!items.length) return; box.appendChild(el('div', 'pj-h', title)); items.forEach(i => box.appendChild(i)); };
    if (window._pjSeg) window._pjSeg.card(box, c);
    sec('Notes', FL.notesOn(pj.P, target).map(noteEl));
    if (!c.survey) {
      const ls = leadsAt(c.cid, c.name);
      sec('Leads', ls.map(x => leadEl(c.cid, c.name, x)));
      docGroupsInto(box, docsForCard(c));          // the most specific level that has any, by group (flexlib docsFor)
    } else {
      docGroupsInto(box, docsForCard(c));
      if (c.ends.length) { const r = el('div', 'pj-row'); c.ends.forEach(n => r.appendChild(btn(['pin', n], () => openCard({ imp: c.imp, code: c.code, cid: c.cid, name: n }), 'small'))); box.appendChild(r); }
    }
    const row = el('div', 'pj-row pj-card-btns');
    row.appendChild(btn(['pencil', 'Note'], () => editNote(target)));
    if (!c.survey) row.appendChild(btn(['help', 'Lead'], () => editLead(c.cid, c.name, null)));
    row.appendChild(btn(['doc', 'Add pages'], () => addPages({ tags: [target] })));
    row.appendChild(btn(['tag', 'From inbox'], () => tagFromInbox(target)));
    box.appendChild(row);
  }
  // ── Files and History of what is selected (Details / Files / History) ─────
  const cardTarget = c => (c.level === 'cave' ? FL.T.cave(c.cid) : c.survey ? FL.T.survey(c.cid, c.code) : FL.T.station(c.cid, c.name));
  /** Stations of a survey, in the loaded survey files. */
  function stationsOfSurvey(cid, code) {
    const out = new Set();
    partsOf(cid).forEach(({ imp, codes }) => {
      if (!codes.has(code)) return;
      (imp.parsed.stations || []).forEach(st => { if ((st.survey || '') === code && st.name) out.add(st.name); });
      (imp.parsed.segments || []).forEach(sg => { if ((sg.survey || '') === code) sg.points.forEach(q => { if (q.name) out.add(q.name); }); });
    });
    return out;
  }
  /**
   * The documents of a card's selection (a cave, a survey or a station), the most specific level that has any, by group
   * (flexlib docsFor). Segments are looked at only when the project uses them (📁 Project → Segments).
   */
  function docsForCard(c) {
    if (!pj.pid || !pj.D || !c || !c.cid) return null;
    const seg = window._pjSeg && !window._pjSeg.on() ? { segments: [] } : {};
    if (c.level === 'cave') return FL.docsFor(pj.D, pj.P, FL.T.cave(c.cid), {});
    if (c.survey) return FL.docsFor(pj.D, pj.P, FL.T.survey(c.cid, c.code), Object.assign({ stations: [...stationsOfSurvey(c.cid, c.code)] }, seg));
    return FL.docsFor(pj.D, pj.P, FL.T.station(c.cid, c.name), Object.assign({ codes: c.code ? [c.code] : [] }, seg));
  }
  /** Is a target string (tag, note, lead…) below the selected thing? */
  function belowOf(c) {
    if (c.level === 'cave') return t => { const p = FL.parseTarget(t); return p.cave === c.cid && p.kind !== 'cave'; };
    if (c.survey) { const st = stationsOfSurvey(c.cid, c.code); return t => { const p = FL.parseTarget(t); return p.cave === c.cid && p.kind === 'station' && st.has(p.name); }; }
    return () => false;
  }
  /** Its own files, then everything below it (folded). */
  function filesOf(c) {
    const tgt = cardTarget(c), below = belowOf(c);
    const all = FL.docsOf(pj.D, pj.P);
    const own = all.filter(d => d.tags[tgt]);
    return { own, below: all.filter(d => !d.tags[tgt] && Object.keys(d.tags).some(below)) };
  }
  function filesTab(box, c, f) {
    const sk = window._sketches && window._sketches.filesList(box, c, f);     // sketches.js: grouped, with thumbnails; drop a scan to attach
    if (!sk) {
      if (!f.own.length && !f.below.length) box.appendChild(el('div', 'pj-note', 'No files here yet.'));
      f.own.forEach(d => box.appendChild(docEl(d)));
      if (f.below.length) {
        const k = 'below:' + cardTarget(c);
        const fold = btn(`${pj.fold === k ? '▾' : '▸'} ${f.below.length} more further down (${c.level === 'cave' ? 'its surveys and stations' : 'its stations'})`, () => { pj.fold = pj.fold === k ? null : k; renderCard(); }, 'link');
        box.appendChild(fold);
        if (pj.fold === k) f.below.forEach(d => box.appendChild(docEl(d)));
      }
    }
    const row = el('div', 'pj-row pj-card-btns');
    if (sk) row.appendChild(sk);                                              // the Add sketch button
    row.appendChild(btn(['doc', 'Add pages'], () => addPages({ tags: [cardTarget(c)] })));
    row.appendChild(btn(['tag', 'From inbox'], () => tagFromInbox(cardTarget(c))));
    box.appendChild(row);
  }
  /** Changes about it (and, for a cave or survey, about what is in it), newest first. */
  function historyOf(c) {
    const tgt = cardTarget(c), below = belowOf(c);
    const files = c.level === 'cave' ? new Set(((pj.P.caves[c.cid] || {}).sources || []).map(s => s.file)) : null;
    const about = e => {
      const ts = [e.target, e.cave ? FL.T.cave(e.cave) : null].concat(Array.isArray(e.tags) ? e.tags : []).filter(Boolean);   // doc.add carries its tags
      if (ts.some(t => t === tgt || below(t))) return true;
      if (files && (e.op === 'cavefile.set' || e.op === 'arealabel.set') && files.has(e.file || (pj.P.arealabels[e.label] || {}).file)) return true;
      if (c.level === 'cave' && e.op === 'segment.set' && e.cave === c.cid) return true;
      return false;
    };
    const docs = pj.docs.filter(e => { const d = pj.D.docs[e.doc]; return d && FL.docInProject(d, pj.P); });
    return FL.sortEntries(pj.proj.filter(about).concat(docs.filter(about))).slice().reverse();
  }
  function historyBody(list) {
    const body = el('div', 'pj-list');
    if (!list.length) body.appendChild(el('div', 'pj-note', 'Nothing yet.'));
    list.slice(0, 400).forEach(e => {
      const r = el('div', 'pj-item');
      r.appendChild(el('div', 'pj-item-t', describe(e)));
      r.appendChild(el('div', 'pj-sub', `${e.who || '?'} · ${when(e.t)}${e.dev === pj.dev ? '' : ' · from ' + e.dev}${e.undoOf ? ' · undo' : ''}`));
      const inv = e.dev === pj.dev && inverse(e);
      if (inv) r.appendChild(btn('Undo', async () => {
        const { op, _w, ...data } = inv;
        await record(op, Object.assign(data, { undoOf: e.id }), _w || (/^doc\./.test(e.op) ? 'docs' : null));
        r.remove();
      }, 'small'));
      body.appendChild(r);
    });
    return body;
  }
  // A whole cave (selection.js, the first click on it): its files, notes, leads, documents.
  function caveCard(box, c) {
    const cv = pj.P.caves[c.cid] || {};
    const parts = partsOf(c.cid);
    const st = parts.reduce((n, { imp }) => n + ((imp.parsed && imp.parsed.stations) || []).length, 0);
    const codes = new Set(parts.flatMap(({ codes }) => [...codes]));
    box.appendChild(el('div', 'pj-sub', [(cv.sources || []).map(s => s.file).join(', ') || 'no files', codes.size ? codes.size + ' survey' + (codes.size === 1 ? '' : 's') : '', st ? st + ' stations' : 'not loaded'].filter(Boolean).join(' · ')));
    const sysOf = FL.systemsOf(pj.P, c.cid), MC = window._pjMulti;
    sysOf.forEach(g => box.appendChild(el('div', 'pj-sub', ['folder', `System “${g.name}”: ${MC ? MC.systemLine(g) : g.caves.length + ' caves'}`])));
    const multiFile = (cv.sources || []).map(s => s.file).find(f => pj.P.cavefiles[f] && pj.P.cavefiles[f].multi);
    if (multiFile) {
      const others = FL.liveCaves(pj.P).filter(x => x.id !== c.cid && (x.sources || []).some(s => s.file === multiFile)).map(x => x.name);
      box.appendChild(el('div', 'pj-sub', `Multi-cave file ${multiFile}` + (others.length ? ' · also holds ' + others.join(', ') : '')));
    }
    const mcBtns = el('div', 'pj-row');
    if (MC) mcBtns.appendChild(btn(['folder', sysOf.length ? 'Systems…' : 'Add to a system…'], () => MC.caveSystems(c.cid), 'small'));
    box.appendChild(mcBtns);
    const target = FL.T.cave(c.cid);
    const sec = (title, items) => { if (!items.length) return; box.appendChild(el('div', 'pj-h', title)); items.forEach(i => box.appendChild(i)); };
    sec('Notes', FL.notesOn(pj.P, target).map(noteEl));
    const ls = allLeads().filter(x => x.active && FL.parseTarget(x.target).cave === c.cid)
      .sort((a, b) => (Number(a.fields.priority) || 9) - (Number(b.fields.priority) || 9));
    sec(`Open leads (${ls.length})`, ls.slice(0, 30).map(x => {
      const t = FL.parseTarget(x.target), r = el('div', 'pj-item');
      r.appendChild(el('div', 'pj-item-t', ['help', t.name || '?']));
      r.appendChild(el('div', 'pj-sub', leadSummary(x.fields) + (x.fields.desc ? ' — ' + x.fields.desc : '')));
      r.addEventListener('click', () => flyTo(c.cid, t.name));
      return r;
    }));
    docGroupsInto(box, docsForCard({ level: 'cave', cid: c.cid }));
    const row = el('div', 'pj-row pj-card-btns');
    row.appendChild(btn(['pencil', 'Note'], () => editNote(target)));
    row.appendChild(btn(['doc', 'Add pages'], () => addPages({ tags: [target] })));
    row.appendChild(btn(['tag', 'From inbox'], () => tagFromInbox(target)));
    box.appendChild(row);
  }
  async function tagFromInbox(target) {
    const inbox = FL.docsOf(pj.D, pj.P).filter(d => FL.docInbox(d, pj.P));
    if (!inbox.length) { toast('The inbox is empty'); return; }
    const id = await choose('Tag a document to ' + targetLabel(target), 'Documents in the inbox (tagged only to the project):', inbox.slice(0, 60).map(d => ({ label: d.title || 'Untitled', sub: docSub(d), value: d.id })));
    if (id) await record('doc.tag', { doc: id, target }, 'docs');
  }
  function flyTo(cid, name) {
    const pos = stationPos(cid, name), V = window.cesiumViewer;
    if (!pos || !V) { toast('That station isn’t loaded'); return; }
    V.camera.flyToBoundingSphere(new Cesium.BoundingSphere(pos, 25), { duration: 1.2 });
    const imp = (partsOf(cid)[0] || {}).imp;
    const s = imp && stationsOf(imp, name)[0];
    openCard({ imp, code: s ? s.survey || '' : '', cid, name });
  }


  Object.assign(X, {
    onSelect, openCard, closeCard, refreshCard, cardTarget, flyTo, docsForCard, stationsOfSurvey,
  });
})();
