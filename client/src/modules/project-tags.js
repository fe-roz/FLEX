// FLEX project (the quick tag picker: what a document, or one page of it, is about).
// Part of project.js, split into classic scripts that load in order (index.html), between project-caves.js
// and project-docs.js; they share their functions through window._pjParts until project.js has loaded.
//
// One picker for adding and for viewing a document: cave → survey → station or range (T6~T8), with the
// current tags shown and removable, recent tags one click away, and several tags at once. A tag goes on the
// whole document, or on the one page being looked at (doc.pagetag, flexlib). Tagging a new document asks the
// same questions plus what the files are (Survey notes, Sketches, Media, Other).
//
//   X.editTags(docId, { page })        change the tags of a document (page: scope to that page)
//   X.askNewDoc({ names, kind, tags })  before files are added: → { tags, kind } or null
//   X.stationInfo(cid)                 { surveys: [{ code, desc, stations }], all: [names] } of the loaded survey files
(function () {
  'use strict';
  const X = window._pjParts;
  if (!X) return;                          // project-ui-kit.js found no flexlib.js
  const { pj, FL, el, btn, dialog, toast, ensureAuthor, record, partsOf, targetLabel, caveName } = X;
  const refresh = (...a) => X.refresh(...a);
  const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });

  // ── Recent tags (per computer; only those that still mean something in this project) ──
  const RECENT = 'flex.recentTags', LASTCAVE = 'flex.tagCave';
  const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  function recentTags() {
    let l = [];
    try { l = JSON.parse(lsGet(RECENT) || '[]'); } catch (_) {}
    return (Array.isArray(l) ? l : []).filter(t => {
      if (typeof t !== 'string') return false;
      const p = FL.parseTarget(t);
      if (p.kind === 'project') return p.pid === pj.pid;
      if (['cave', 'survey', 'station', 'area', 'segment'].includes(p.kind)) return !!(pj.P.caves[p.cave] && !pj.P.caves[p.cave].removed);
      return false;
    });
  }
  // targets: most recent first. The cave of the newest becomes the cave the next picker starts with.
  function pushRecent(targets) {
    const keep = recentTags().filter(t => !targets.includes(t));
    lsSet(RECENT, JSON.stringify(targets.filter(t => !/^project:/.test(t)).concat(keep).slice(0, 12)));
    const c = targets.map(t => FL.parseTarget(t).cave).find(Boolean);
    if (c) lsSet(LASTCAVE, c);
  }

  // ── What is in a cave's loaded survey files: surveys and station names ───────────────────
  function stationInfo(cid) {
    const byCode = new Map(), all = new Set();
    partsOf(cid).forEach(({ imp, codes }) => {
      (imp.parsed.surveys || []).forEach(s => { if (codes.has(s.code) && s.code && !byCode.has(s.code)) byCode.set(s.code, { code: s.code, desc: String(s.desc || s.name || '').trim(), stations: new Set() }); });
      const put = (code, name) => { if (!name) return; all.add(name); const r = byCode.get(code || ''); if (r) r.stations.add(name); };
      (imp.parsed.stations || []).forEach(s => { if (codes.has(s.survey || '')) put(s.survey, s.name); });
      (imp.parsed.segments || []).forEach(sg => { if (codes.has(sg.survey || '')) sg.points.forEach(q => put(sg.survey, q.name)); });
    });
    return { surveys: [...byCode.values()].map(r => ({ code: r.code, desc: r.desc, stations: [...r.stations].sort(natural) })).sort((a, b) => natural(a.code, b.code)), all: [...all].sort(natural) };
  }

  // What a document can be tagged to besides stations: the project, its caves and surveys, surface points, leads.
  function tagChoices() {
    const out = [{ label: 'Project · ' + (pj.P.name || 'this project'), target: FL.T.project(pj.pid) }];
    FL.liveCaves(pj.P).forEach(c => {
      out.push({ label: 'Cave · ' + c.name, target: FL.T.cave(c.id) });
      stationInfo(c.id).surveys.forEach(s => out.push({ label: `Survey ${s.code}${s.desc ? ' — ' + s.desc : ''} · ${c.name}`, target: FL.T.survey(c.id, s.code) }));
    });
    FL.liveFeatures(pj.P).forEach(f => out.push({ label: `${{ point: 'Point', line: 'Line', area: 'Area' }[f.kind] || 'Feature'} · ${f.name || '(no name)'} (surface)`, target: FL.T.feature(f.id) }));
    Object.values(pj.P.leads).forEach(L => { if (!L.deleted) out.push({ label: 'Lead · ' + targetLabel(L.target) + (L.fields.desc ? ' — ' + L.fields.desc.slice(0, 40) : ''), target: FL.T.lead(L.id) }); });
    return out;
  }

  // ── The picker ────────────────────────────────────────────────────────────
  // o: { doc, page (index: tag that page), title, newDoc: { names, kind }, tags (a new document's starting tags), cave (a hint) }
  async function pick(o) {
    const d = o.doc ? pj.D.docs[o.doc] : null;
    if (o.doc && !d) return null;
    const S = { scope: o.page != null && d ? 'page' : 'doc', page: o.page != null ? o.page : 0, text: '', survey: '', note: '' };
    S.docWant = new Set(d ? d.tagList : (o.tags || []));
    S.pageWant = new Map();
    if (d) d.pages.forEach((p, i) => { if (p.targets && p.targets.length) S.pageWant.set(i, new Set(p.targets)); });
    S.kind = o.newDoc ? o.newDoc.kind || '' : null;
    // the cave to pick from: the document's own, else the one used last, else the first
    const caves = FL.liveCaves(pj.P);
    const own = [...new Set([...S.docWant, ...[...S.pageWant.values()].flatMap(s => [...s])].map(t => FL.parseTarget(t).cave).filter(c => c && pj.P.caves[c]))];
    const last = lsGet(LASTCAVE);
    S.cave = (o.cave && pj.P.caves[o.cave] && o.cave) || (own.length === 1 && own[0]) || (last && pj.P.caves[last] && !pj.P.caves[last].removed && last) || (caves[0] && caves[0].id) || '';
    const added = [];                                    // targets added in this dialog (for the recent list)
    const scopeSet = () => { if (S.scope === 'doc' || !d) return S.docWant; if (!S.pageWant.has(S.page)) S.pageWant.set(S.page, new Set()); return S.pageWant.get(S.page); };
    const has = t => scopeSet().has(t);
    const addTag = t => { if (!t || has(t)) return; scopeSet().add(t); added.push(t); S.text = ''; q.value = ''; paint(); };
    const body = el('div', 'pj-form pt-form');
    // Document kind (new documents only)
    let kindRow = null;
    if (o.newDoc) {
      kindRow = el('div', 'pj-row pt-kind');
      body.appendChild(el('div', 'pj-f-l', `What ${o.newDoc.names.length === 1 ? 'is this file' : 'are these ' + o.newDoc.names.length + ' files'}?  ${o.newDoc.names.slice(0, 3).join(', ')}${o.newDoc.names.length > 3 ? '…' : ''}`));
      body.appendChild(kindRow);
    }
    const scopeRow = el('div', 'pj-row pt-scope');
    const chipsBox = el('div', 'pj-chips pt-chips');
    const recentBox = el('div', 'pt-recent');
    const pickRow = el('div', 'pj-row pt-pick');
    const caveSel = el('select', 'pj-input pt-sel'), surSel = el('select', 'pj-input pt-sel');
    pickRow.append(caveSel, surSel);
    const q = el('input', 'pj-input pt-q');
    q.placeholder = 'Station, range like T6~T8, or search surveys, surface points, leads…';
    q.autocomplete = 'off';
    const sug = el('div', 'pj-list pj-taglist pt-sug');
    const hint = el('div', 'pj-note pt-hint');
    body.append(scopeRow, el('div', 'pj-f-l', 'Tagged to'), chipsBox, recentBox, pickRow, q, sug, hint);

    // ── drawing ──
    const infoCache = new Map();
    function info() { if (!S.cave) return { surveys: [], all: [] }; if (!infoCache.has(S.cave)) infoCache.set(S.cave, stationInfo(S.cave)); return infoCache.get(S.cave); }
    let choices = null;
    const others = () => choices || (choices = tagChoices().filter(c => !/^station:/.test(c.target)));
    function paintKind() {
      if (!kindRow) return;
      kindRow.textContent = '';
      FL.DOC_GROUPS.forEach(g => {
        const on = FL.docGroup(S.kind) === g.id;
        kindRow.appendChild(btn(g.label, () => { if (FL.docGroup(S.kind) !== g.id) S.kind = ({ notes: 'notes', sketches: 'sketch-plan', media: 'photo', other: 'other' })[g.id]; paint(); }, 'chip' + (on ? ' on' : '')));
      });
    }
    function paintScope() {
      scopeRow.textContent = '';
      if (!d || !d.pages.length) return;
      scopeRow.appendChild(el('span', 'pj-sub', 'A new tag goes on '));
      scopeRow.appendChild(btn('the whole document', () => { S.scope = 'doc'; paint(); }, 'chip' + (S.scope === 'doc' ? ' on' : '')));
      scopeRow.appendChild(btn(`page ${S.page + 1} of ${d.pages.length}`, () => { S.scope = 'page'; paint(); }, 'chip' + (S.scope === 'page' ? ' on' : '')));
      if (d.pages.length > 1) {
        const go = (k) => btn(k < 0 ? '‹' : '›', () => { S.page = Math.max(0, Math.min(d.pages.length - 1, S.page + k)); S.scope = 'page'; paint(); }, 'small');
        scopeRow.append(go(-1), go(1));
      }
    }
    function paintChips() {
      chipsBox.textContent = '';
      const chip = (label, set, t, cls) => chipsBox.appendChild(btn(label + ' ✕', () => { set.delete(t); paint(); }, 'chip on ' + (cls || '')));
      [...S.docWant].forEach(t => chip(targetLabel(t), S.docWant, t));
      [...S.pageWant.entries()].sort((a, b) => a[0] - b[0]).forEach(([i, set]) => [...set].forEach(t => chip(`p${i + 1} · ${targetLabel(t)}`, set, t, 'pt-pagechip')));
      if (!chipsBox.childNodes.length) chipsBox.appendChild(el('div', 'pj-note', d ? 'No tags: the document is in no project.' : 'No tags yet: it goes to the project’s inbox.'));
    }
    function paintRecent() {
      recentBox.textContent = '';
      const r = recentTags().filter(t => !has(t)).slice(0, 6);
      if (!r.length) return;
      recentBox.appendChild(el('span', 'pj-sub', 'Recent: '));
      r.forEach(t => recentBox.appendChild(btn('＋ ' + targetLabel(t), () => addTag(t), 'chip')));
    }
    function paintSelects() {
      caveSel.textContent = ''; surSel.textContent = '';
      if (!caves.length) caveSel.appendChild(new Option('(no caves in this project)', ''));
      caves.forEach(c => caveSel.appendChild(new Option(c.name, c.id, false, c.id === S.cave)));
      const sv = info().surveys;
      surSel.appendChild(new Option(sv.length ? 'any survey' : 'surveys not loaded', ''));
      sv.forEach(s => surSel.appendChild(new Option(`Survey ${s.code}${s.desc ? ' — ' + s.desc.slice(0, 30) : ''}`, s.code, false, s.code === S.survey)));
      surSel.disabled = !sv.length;
    }
    function suggestions() {
      const text = S.text.trim(), tl = text.toLowerCase(), seen = new Set();
      const add = (list, target, label, sub) => { if (target && !seen.has(target) && !has(target)) { seen.add(target); list.push({ target, label, sub: sub || '' }); } };
      const cave = S.cave && pj.P.caves[S.cave], inf = info();
      const svRec = S.survey ? inf.surveys.find(s => s.code === S.survey) : null;
      const pool = svRec ? svRec.stations : inf.all;
      const typed = [], sts = [], rest = [];
      if (cave && text) {
        const spec = FL.normalizeSpec(text, inf.all);
        const rangeText = (head, a, n) => FL.normalizeSpec(head + a + '~' + n, inf.all);
        const label = sp => `Stations ${sp.replace(/~/g, '–').replace(/,/g, ', ')} · ${cave.name}`;
        const cover = sp => { const cov = FL.areaStations(sp, inf.all); return cov.length ? `${cov.length} station${cov.length === 1 ? '' : 's'}: ${cov.slice(0, 6).join(', ')}${cov.length > 6 ? '…' : ''}` : ''; };
        // the end of a range being typed ("T6~", "T6~T"): offer the stations that can finish it
        const li = text.lastIndexOf(','), head = li >= 0 ? text.slice(0, li + 1) : '', tail = text.slice(li + 1).trim();
        const rm = /^(.+?)\s*(?:~|–|—|\s+to\s+)\s*([^~]*)$/i.exec(tail);
        const ends = [];
        if (rm && pool.length) {
          const a = rm[1].trim(), b = rm[2].trim().toLowerCase(), ai = pool.indexOf(a);
          const pre = x => { const m = /^(.*?)\d+[^\d]*$/.exec(x); return m ? m[1] : null; };           // a range is stations with one prefix: T6~T8
          (ai >= 0 ? pool.slice(ai + 1) : pool).filter(n => n !== a && pre(n) === pre(a) && (!b || n.toLowerCase().startsWith(b))).slice(0, 12).forEach(n => ends.push(rangeText(head, a, n)));
        }
        const partial = !!rm && ends.length > 0 && !pool.includes(rm[2].trim());          // what follows the dash is not a whole station yet
        if (/[~,]/.test(spec) && !/~$/.test(spec) && !partial) {                         // a range or a list, as typed
          const cov = cover(spec);
          add(typed, FL.T.area(S.cave, spec), label(spec), cov || (inf.all.length ? 'no station of the loaded survey matches this' : 'taken as typed (the survey file is not loaded)'));
        } else if (spec && pool.includes(spec)) add(typed, FL.T.station(S.cave, spec), `Station ${spec} · ${cave.name}`, '');
        ends.forEach(sp => add(typed, FL.T.area(S.cave, sp), label(sp), cover(sp)));
      }
      if (cave) {
        const hits = pool.filter(n => !text || n.toLowerCase().includes(tl));
        hits.sort((a, b) => (b.toLowerCase().startsWith(tl) ? 1 : 0) - (a.toLowerCase().startsWith(tl) ? 1 : 0));
        hits.slice(0, 30).forEach(n => add(sts, FL.T.station(S.cave, n), `Station ${n} · ${cave.name}`, ''));
        const spec = text ? FL.normalizeSpec(text, inf.all) : '';
        if (spec && !/[~,]/.test(spec) && !hits.length) add(typed, FL.T.station(S.cave, spec), `Station ${spec} · ${cave.name}`, inf.all.length ? 'not in the loaded survey' : 'taken as typed (the survey file is not loaded)');
      }
      // the rest: project, caves, surveys, surface points, leads — the chosen cave's first
      const mine = c => (S.cave && c.target.includes(':' + S.cave) ? 0 : 1);
      others().filter(c => !text || c.label.toLowerCase().includes(tl)).sort((a, b) => mine(a) - mine(b)).forEach(c => add(rest, c.target, c.label, ''));
      return (text ? typed.concat(sts, rest) : typed.concat(rest, sts)).slice(0, 40);
    }
    function paintSug() {
      sug.textContent = '';
      const l = suggestions();
      l.forEach((s, i) => {
        const b = btn(['plus', s.label], () => addTag(s.target), 'row' + (i === 0 && S.text.trim() ? ' pt-first' : ''));
        if (s.sub) b.appendChild(el('div', 'pj-sub', s.sub));
        sug.appendChild(b);
      });
      if (!l.length) sug.appendChild(el('div', 'pj-note', S.text.trim() ? 'Nothing matches.' : 'Everything is already added.'));
      const inf = info();
      hint.textContent = S.cave && !inf.all.length ? 'This cave’s survey file is not loaded, so stations cannot be suggested: type a name or a range (T6~T8) and it is taken as written.' : '';
    }
    function paint() { paintKind(); paintScope(); paintChips(); paintRecent(); paintSelects(); paintSug(); }
    caveSel.addEventListener('change', () => { S.cave = caveSel.value; S.survey = ''; paint(); });
    surSel.addEventListener('change', () => { S.survey = surSel.value; paintSug(); });
    q.addEventListener('input', () => { S.text = q.value; paintSug(); });
    q.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); e.stopPropagation();
      const first = suggestions()[0];
      if (first) { addTag(first.target); q.value = ''; q.focus(); }
    });
    // "Add": the most specific thing filled in: the typed station or range, else the survey chosen, else the cave
    const addBtn = btn(['plus', 'Add tag'], () => {
      const first = S.text.trim() ? suggestions()[0] : null;
      if (first) addTag(first.target);
      else if (S.cave && S.survey) addTag(FL.T.survey(S.cave, S.survey));
      else if (S.cave) addTag(FL.T.cave(S.cave));
      q.value = ''; S.text = ''; paintSug();
    }, 'small pt-add');
    addBtn.title = 'Add the station or range typed; with nothing typed, the survey chosen, else the cave';
    pickRow.appendChild(addBtn);
    paint();
    const title = o.title || (o.newDoc ? 'Add ' + (o.newDoc.names.length === 1 ? 'a file' : o.newDoc.names.length + ' files') : 'Tags · ' + (d.title || 'document'));
    const r = await dialog({ title, body, wide: true, buttons: [{ label: 'Cancel', value: null }, { label: o.newDoc ? 'Add' : 'Done', value: 'ok', primary: true }] });
    if (!r) return null;
    if (o.newDoc) { pushRecent(added.slice().reverse()); return { tags: [...S.docWant], kind: S.kind || '' }; }
    return { S, added, d };
  }

  // Change the tags of a document (or of one page of it). Everything changed is recorded together.
  async function editTags(docId, opts = {}) {
    if (!(await ensureAuthor())) return;
    if (pj.readonly) { toast(pj.mode === 'snapshot' ? 'A snapshot is read-only: leave it to change the project' : 'This project is archived (read-only): unarchive it to change it'); return; }
    const res = await pick({ doc: docId, page: opts.page != null ? opts.page : null, cave: opts.cave });
    if (!res) return;
    const { S, added, d } = res, ops = [];
    d.tagList.forEach(t => { if (!S.docWant.has(t)) ops.push(['doc.untag', { doc: docId, target: t }]); });
    S.docWant.forEach(t => { if (!d.tags[t]) ops.push(['doc.tag', { doc: docId, target: t }]); });
    d.pages.forEach((p, i) => {
      const want = S.pageWant.get(i) || new Set(), cur = p.targets || [];
      cur.forEach(t => { if (!want.has(t)) ops.push(['doc.pageuntag', { doc: docId, h: p.h, target: t }]); });
      want.forEach(t => { if (!cur.includes(t)) ops.push(['doc.pagetag', { doc: docId, h: p.h, target: t }]); });
    });
    if (!ops.length) return;
    let done = 0;
    for (let i = 0; i < ops.length; i++) { if (await record(ops[i][0], ops[i][1], 'docs', { quiet: true })) done++; }
    if (done) { pushRecent(added.slice().reverse()); refresh('doc.tag'); }
  }
  // Before files are added as a new document: what they are and what they are about.
  async function askNewDoc(o) {
    if (pj.readonly) return null;
    return pick({ newDoc: { names: o.names || [], kind: o.kind || '' }, tags: o.tags && o.tags.length ? o.tags : [FL.T.project(pj.pid)] });
  }

  const st = document.createElement('style');
  st.textContent = `
  .pt-form { gap: 6px; }
  .pt-chips { display: flex; flex-wrap: wrap; }
  .pt-pagechip { border-style: dashed; }
  .pt-recent { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; }
  .pt-pick { flex-wrap: nowrap; }
  .pt-sel { flex: 1; min-width: 0; width: auto; }
  .pt-add { flex: none; }
  .pt-sug { max-height: 220px; overflow: auto; }
  .pt-first { outline: 1px solid rgba(33,150,243,.7); }
  .pt-hint:empty { display: none; }`;
  document.head.appendChild(st);

  Object.assign(X, { editTags, askNewDoc, stationInfo, tagChoices, recentTags });
})();
