/* FLEX: documents in the portable viewer and FLEX Field.
 *
 * What the phone shows for a station, a survey or a cave, and how documents and
 * single pages get tagged. The rules are the desktop's (FlexLib.docsFor, decided
 * 2026-11-08), never re-invented here:
 *   - a station: the sketch page that covers it (a page tag such as A6~A8) or the
 *     book that holds it, tagged to the station; none: its survey's; then the
 *     cave's; then the project's untagged ones; never another survey's or cave's
 *   - a survey: its own; none: the cave's
 *   - split into Survey notes / Sketches / Media / Other, with a count each, and
 *     "from survey T" when a group is not the selection's own
 *   - a document opens at the page it was found by ("page 2: stations A2–A4")
 *
 * Also here: the station / survey / cave cards' documents, the Documents panel's
 * lists, the gallery's page tags, the tag picker (cave → survey → station or
 * range, recent tags, the map's stations as suggestions, whole document or one
 * page), the kind a new document gets (FlexLib.suggestKind), and "From page N of
 * <document>" for a shot read from a scan (shot.src).
 *
 * Works as a classic script (window.FlexDocs, after flexlib.js) and under Node
 * (module.exports: the rules without the DOM, tools/test_viewer_docs.js).
 *
 * The page-level code uses the viewer's own functions and state (viewer.html):
 *   ffD ffP ffPid ffLinks ffState ffBuilt stationMap CAVES_DATA  state
 *   ffRecord ffRecordMany ffEnsureAuthor ffDialog fpRow showToast ffTargetLabel
 *   ffDocOpen ffGalleryShow ffOpenDocs ffAddPages ffNoteEl ffEditNote
 *   ffStCave ffStCodes ffDocSub ffBaseSurveys clearStationHighlight flyToPoint
 * Hooks in viewer.html call: stationCard, openSurvey, openCave, refresh,
 * fillList, galleryInit, galleryCaption, editTags, kindFor, kindForFiles,
 * kindChips.
 */
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./flexlib.js') : root.FlexLib);
  if (node) module.exports = api;
  else root.FlexDocs = api;
})(typeof self !== 'undefined' ? self : this, function (FL) {
  'use strict';

  const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
  // The kind a group's chip stands for (the kind decides the group).
  const GROUP_KIND = { notes: 'notes', sketches: 'sketch-plan', media: 'photo', other: 'other' };
  const GROUP_ICON = { notes: '📋', sketches: '✏️', media: '🖼', other: '📄' };

  // ══ Rules (no DOM) ══════════════════════════════════════════════════════════

  // A target as the card of its own cave says it: "stations A2–A4", "station A3", "survey T" (the cave is understood).
  function shortLabel(t, label) {
    const p = FL.parseTarget(t);
    switch (p.kind) {
      case 'area': return 'stations ' + String(p.spec || '').replace(/~/g, '–').replace(/,/g, ', ');
      case 'station': return 'station ' + p.name;
      case 'survey': return 'survey ' + p.code;
      case 'cave': return 'the cave';
      default: return label ? label(t) : String(t);
    }
  }
  // " · page 2: stations A2–A4": why a lookup opened a document at that page (only when it was found by a page tag).
  function pageNote(d, i, item, label) {
    if (!item || item.via !== 'page') return '';
    const p = d && d.pages && d.pages[i], ts = p && p.targets && p.targets.length ? p.targets.slice() : [];
    if (item.tag && ts.includes(item.tag)) ts.unshift(...ts.splice(ts.indexOf(item.tag), 1));
    return ts.length ? ` · page ${i + 1}: ${ts.slice(0, 2).map(t => shortLabel(t, label)).join(', ')}` : '';
  }
  // What a document row says under its title.
  function subOf(d, note) {
    const m = FL.docMedia(d), n = (d.pages || []).length;
    const what = m === 'video' ? 'Video' : m === 'photo' ? (n > 1 ? n + ' photos' : 'Photo')
      : `${n} page${n === 1 ? '' : 's'}${d.kind ? ' · ' + (FL.DOC_KIND_LABELS[d.kind] || d.kind) : ''}`;
    return what + (d.date ? ' · ' + d.date : '') + (note || '');
  }
  // "Survey notes (2)" and " · from survey T" for a group of a docsFor result.
  const groupHeading = g => ({ text: `${g.label} (${g.items.length})`, from: g.from ? ' · from ' + g.from : '' });
  // How many documents a lookup found, not counting the project's untagged ones (those wait behind a link).
  const count = res => (res && !res.empty ? res.items.filter(x => x.level !== 'project').length : 0);

  // The surveys of an export (and the ones made on the phone), by cave and survey code: the stations each has.
  // surveys: [{ name, cave, color, stations: [{ name }], shots: [{ from_name, to_name }], lines }].
  function surveyIndex(surveys) {
    const map = new Map();
    (surveys || []).forEach(sv => {
      const code = FL.surveyCode(sv.name);
      if (!code) return;
      const key = (sv.cave || '') + '|' + code;
      let r = map.get(key);
      if (!r) map.set(key, r = { key, cave: sv.cave || '', code, name: sv.name, color: sv.color, stations: new Set(), shots: 0 });
      if (/ — ./.test(sv.name) && !/ — ./.test(r.name)) r.name = sv.name;           // "A — Main line" over a bare "A"
      (sv.stations || []).forEach(s => { if (s && s.name) r.stations.add(String(s.name)); });
      (sv.shots || []).forEach(s => { if (s.from_name) r.stations.add(String(s.from_name)); if (s.to_name) r.stations.add(String(s.to_name)); });
      r.shots += (sv.shots || sv.lines || []).length;
    });
    return map;
  }
  const descOf = (name, code) => { const s = String(name || ''), i = s.indexOf(' — '); return i < 0 ? (s === code ? '' : s) : s.slice(i + 3).trim(); };
  // The surveys and station names of one cave (its name on the map): what the tag picker suggests from.
  function stationInfo(index, cave) {
    const surveys = [], all = new Set();
    index.forEach(r => {
      if (r.cave !== (cave || '')) return;
      r.stations.forEach(n => all.add(n));
      surveys.push({ code: r.code, desc: descOf(r.name, r.code), name: r.name, stations: [...r.stations].sort(natural) });
    });
    return { surveys: surveys.sort((a, b) => natural(a.code, b.code)), all: [...all].sort(natural) };
  }

  // Tag suggestions: what was typed first (a range, a list, a station), then stations of the chosen cave and survey, then the rest.
  // o: { text, cave: { id, name } | null, info: stationInfo(), survey: code, has(target), others: [{ label, target }] } → [{ target, label, sub }] (40 at most)
  function suggest(o) {
    const text = String(o.text || '').trim(), tl = text.toLowerCase(), seen = new Set(), has = o.has || (() => false);
    const add = (list, target, label, sub) => { if (target && !seen.has(target) && !has(target)) { seen.add(target); list.push({ target, label, sub: sub || '' }); } };
    const cave = o.cave, inf = o.info || { surveys: [], all: [] };
    const svRec = o.survey ? inf.surveys.find(s => s.code === o.survey) : null;
    const pool = svRec ? svRec.stations : inf.all;
    const typed = [], sts = [], rest = [];
    if (cave && text) {
      const spec = FL.normalizeSpec(text, inf.all);
      const rangeText = (head, a, n) => FL.normalizeSpec(head + a + '~' + n, inf.all);
      const label = sp => `Stations ${sp.replace(/~/g, '–').replace(/,/g, ', ')} · ${cave.name}`;
      const cover = sp => { const cov = FL.areaStations(sp, inf.all); return cov.length ? `${cov.length} station${cov.length === 1 ? '' : 's'}: ${cov.slice(0, 6).join(', ')}${cov.length > 6 ? '…' : ''}` : ''; };
      // the end of a range being typed ("A6~", "A6~A"): offer the stations that can finish it
      const li = text.lastIndexOf(','), head = li >= 0 ? text.slice(0, li + 1) : '', tail = text.slice(li + 1).trim();
      const rm = /^(.+?)\s*(?:~|–|—|\s+to\s+)\s*([^~]*)$/i.exec(tail);
      const ends = [];
      if (rm && pool.length) {
        const a = rm[1].trim(), b = rm[2].trim().toLowerCase(), ai = pool.indexOf(a);
        const pre = x => { const m = /^(.*?)\d+[^\d]*$/.exec(x); return m ? m[1] : null; };
        (ai >= 0 ? pool.slice(ai + 1) : pool).filter(n => n !== a && pre(n) === pre(a) && (!b || n.toLowerCase().startsWith(b))).slice(0, 12).forEach(n => ends.push(rangeText(head, a, n)));
      }
      const partial = !!rm && ends.length > 0 && !pool.includes(rm[2].trim());
      if (/[~,]/.test(spec) && !/~$/.test(spec) && !partial) {
        const cov = cover(spec);
        add(typed, FL.T.area(cave.id, spec), label(spec), cov || (inf.all.length ? 'no station of the loaded survey matches this' : 'taken as typed (the survey file is not loaded)'));
      } else if (spec && pool.includes(spec)) add(typed, FL.T.station(cave.id, spec), `Station ${spec} · ${cave.name}`, '');
      ends.forEach(sp => add(typed, FL.T.area(cave.id, sp), label(sp), cover(sp)));
    }
    if (cave) {
      const hits = pool.filter(n => !text || n.toLowerCase().includes(tl));
      hits.sort((a, b) => (b.toLowerCase().startsWith(tl) ? 1 : 0) - (a.toLowerCase().startsWith(tl) ? 1 : 0));
      hits.slice(0, 30).forEach(n => add(sts, FL.T.station(cave.id, n), `Station ${n} · ${cave.name}`, ''));
      const spec = text ? FL.normalizeSpec(text, inf.all) : '';
      if (spec && !/[~,]/.test(spec) && !hits.length) add(typed, FL.T.station(cave.id, spec), `Station ${spec} · ${cave.name}`, inf.all.length ? 'not in the loaded survey' : 'taken as typed (the survey file is not loaded)');
    }
    const mine = c => (cave && c.target.includes(':' + cave.id) ? 0 : 1);
    (o.others || []).filter(c => !text || c.label.toLowerCase().includes(tl)).sort((a, b) => mine(a) - mine(b)).forEach(c => add(rest, c.target, c.label, ''));
    return (text ? typed.concat(sts, rest) : typed.concat(rest, sts)).slice(0, 40);
  }

  // What to record so a document (and each of its pages) ends up with the wanted tags: [[op, data]…].
  // docWant: Set of targets; pageWant: Map page index → Set of targets.
  function tagOps(d, docWant, pageWant) {
    const ops = [];
    d.tagList.forEach(t => { if (!docWant.has(t)) ops.push(['doc.untag', { doc: d.id, target: t }]); });
    docWant.forEach(t => { if (!d.tags[t]) ops.push(['doc.tag', { doc: d.id, target: t }]); });
    d.pages.forEach((p, i) => {
      const want = pageWant.get(i) || new Set(), cur = p.targets || [];
      cur.forEach(t => { if (!want.has(t)) ops.push(['doc.pageuntag', { doc: d.id, h: p.h, target: t }]); });
      want.forEach(t => { if (!cur.includes(t)) ops.push(['doc.pagetag', { doc: d.id, h: p.h, target: t }]); });
    });
    return ops;
  }

  // Recent tags that still mean something here (kept per phone): the project's own, the project's caves and what is tagged inside them.
  function recentKeep(list, S, pid) {
    return (Array.isArray(list) ? list : []).filter(t => {
      if (typeof t !== 'string') return false;
      const p = FL.parseTarget(t);
      if (p.kind === 'project') return p.pid === pid;
      if (['cave', 'survey', 'station', 'area', 'segment'].includes(p.kind)) return !!(S && S.caves && S.caves[p.cave] && !S.caves[p.cave].removed);
      return false;
    });
  }

  // Shots of the field surveys at a station that were read from a scanned page (shot.src): one entry per page.
  // surveys: field surveys with the export's cave name; D: the documents replay.
  function scanSources(surveys, cave, name, D) {
    const n = String(name || '').trim(), out = new Map();
    if (!n) return [];
    (surveys || []).forEach(sv => {
      if ((sv.cave || '') !== (cave || '')) return;
      (sv.shots || []).forEach(sh => {
        const src = sh && sh.src;
        if (!src || !src.doc || (String(sh.from || '').trim() !== n && String(sh.to || '').trim() !== n)) return;
        const d = D && D.docs && D.docs[src.doc];
        if (!d || d.deleted || !d.pages.length) return;
        let i = src.h ? d.pages.findIndex(p => p.h === src.h) : -1;                     // by the page itself: reordering does not lose it
        if (i < 0) i = Math.max(0, Math.min(d.pages.length - 1, Number(src.page) || 0));
        const k = d.id + '|' + i;
        const r = out.get(k) || out.set(k, { doc: d.id, index: i, title: d.title || 'Untitled', shots: [], surveys: [] }).get(k);
        r.shots.push(`${sh.from} → ${sh.to}`);
        if (sv.name && !r.surveys.includes(sv.name)) r.surveys.push(sv.name);
      });
    });
    return [...out.values()].sort((a, b) => a.title.localeCompare(b.title) || a.index - b.index);
  }

  // The kind a new document gets from its first page's name (a camera photo: Media, a scan: Survey notes, a PDF: Other…).
  // A page may carry `camera: true` when the host knows the picture came from a camera.
  function kindForPages(pages) {
    const p = (pages || [])[0];
    if (!p) return '';
    const name = String(p.name || '').replace(/ \(\d+\)$/, '');
    return FL.suggestKind({ name, type: p.ext === 'pdf' ? 'application/pdf' : '', camera: !!p.camera });
  }

  // ══ Page code (needs the viewer) ═════════════════════════════════════════════
  const inPage = typeof document !== 'undefined';
  const $ = id => document.getElementById(id);
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const caveIdOf = name => (ffLinks.byName[name != null ? name : ''] || null);                // export cave name → cave id
  const caveNameOf = cid => (ffLinks.byId[cid] != null ? ffLinks.byId[cid] : null);           // cave id → export cave name
  const projectCaveName = cid => (ffP.caves[cid] && ffP.caves[cid].name) || caveNameOf(cid) || 'a cave';
  const allSurveys = () => (typeof ffBaseSurveys === 'function' ? ffBaseSurveys() : ((CAVES_DATA && CAVES_DATA.surveys) || [])).concat(typeof ffBuilt !== 'undefined' ? ffBuilt : []);
  // The survey index, kept until the surveys change (ffBuilt and ffState are new objects after every change).
  let IDX = null, IDX_A = null, IDX_B = null;
  function index() {
    const a = typeof ffBuilt !== 'undefined' ? ffBuilt : null, b = typeof ffState !== 'undefined' ? ffState : null;
    if (!IDX || IDX_A !== a || IDX_B !== b) { IDX = surveyIndex(allSurveys()); IDX_A = a; IDX_B = b; }
    return IDX;
  }
  const label = t => ffTargetLabel(t);

  // The documents of a station by the rules above, or null (no project / the cave is not linked).
  function stationDocs(st) {
    if (!st || !st.name || !ffPid) return null;
    const cid = ffStCave(st);
    return cid ? FL.docsFor(ffD, ffP, FL.T.station(cid, st.name), { codes: ffStCodes(st) }) : null;
  }
  function surveyDocs(cave, code) {
    const cid = caveIdOf(cave), r = index().get(cave + '|' + code);
    return ffPid && cid ? FL.docsFor(ffD, ffP, FL.T.survey(cid, code), { stations: r ? [...r.stations] : [] }) : null;
  }
  function caveDocs(cave) {
    const cid = caveIdOf(cave);
    return ffPid && cid ? FL.docsFor(ffD, ffP, FL.T.cave(cid), {}) : null;
  }

  function css() {
    if ($('ffd-css')) return;
    const s = mk('style'); s.id = 'ffd-css';
    s.textContent = `
    .ffd-box { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
    .ffd-group { display: flex; flex-direction: column; }
    .ffd-gh { font-size: 11px; margin: 7px 0 1px; line-height: 1.3; }
    .ffd-gh b { font-weight: 700; }
    .ffd-from { opacity: .6; }
    .ffd-doc { padding: 7px 4px; }
    .ffd-doc .fp-ic { color: inherit; font-weight: 400; }
    #info-panel .ffd-doc .fp-t1 { font-size: 13px; }
    .ffd-pager { display: inline-flex; gap: 3px; align-items: center; }
    .ffd-more, .ffd-link { background: none; border: none; color: #8cc7ff; font-size: 12px; padding: 6px 4px; text-align: left;
      cursor: pointer; text-decoration: underline; text-underline-offset: 2px; font-family: inherit; }
    .ffd-scan { border-left: 3px solid #7bd88f; background: rgba(123,216,143,.09); border-radius: 4px; padding: 6px 8px; cursor: pointer; margin-top: 4px; }
    .ffd-scan .t1 { font-size: 13px; }
    .ffd-scan .t2 { font-size: 10px; opacity: .55; margin-top: 2px; }
    .ffd-lead { font-size: 10px; text-transform: uppercase; letter-spacing: .6px; opacity: .45; margin: 8px 0 0; }
    .ffd-sl { text-decoration: underline dotted; text-underline-offset: 2px; cursor: pointer; padding: 6px 2px; }
    .ffd-empty { font-size: 11px; opacity: .55; margin: 4px 0; }
    #ff-gallery .ffg-tags { white-space: normal; line-height: 1.35; max-height: 4.4em; overflow-y: auto; }
    #ff-gallery .ffg-pt { display: none; padding: 4px 10px 6px; background: rgba(20,20,30,.95); z-index: 2; }
    #ff-gallery.editing .ffg-pt { display: block; }
    .ffd-pick { display: flex; flex-direction: column; gap: 8px; }
    .ffd-pick .ffd-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .ffd-pick .ffd-lbl { font-size: 11px; opacity: .6; }
    .ffd-pick select { flex: 1; min-width: 0; padding: 8px 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,.18); background: rgba(0,0,0,.35); color: #eee; font-size: 13px; font-family: inherit; }
    .ffd-pick .fp-btn.ff-chip.page { border-style: dashed; }
    .ffd-pick .ffd-sug { max-height: 210px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
    .ffd-pick .ffd-sug button { text-align: left; padding: 9px 10px; font-size: 13px; }
    .ffd-pick .ffd-sug button.first { outline: 1px solid rgba(33,150,243,.85); }
    .ffd-pick .ffd-sug .sub { font-size: 11px; opacity: .6; margin-top: 2px; }
    .ffd-pick .ffd-hint:empty { display: none; }
    .ffd-pick .ffd-hint { font-size: 11px; opacity: .6; }
    .ffd-kinds { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }`;
    document.head.appendChild(s);
  }
  if (inPage) css();

  // ── Rows and groups ────────────────────────────────────────────────────────
  // One document, opening at the page it was found by (item.page).
  function docRow(item) {
    const d = item.doc, n = (d.pages || []).length;
    const at = n ? Math.max(0, Math.min(item.page || 0, n - 1)) : 0;
    const r = fpRow(GROUP_ICON[item.group] || '📄', d.title || 'Untitled', subOf(d, pageNote(d, at, item, label)), () => ffDocOpen(d.id, at));
    r.classList.add('ffd-doc');
    r.dataset.doc = d.id; r.dataset.page = String(at); r.dataset.level = item.level; r.dataset.via = item.via;
    return r;
  }
  // A docsFor result as groups: "Survey notes (2) · from survey T" and the documents. `limit`: rows shown per group before
  // "N more…". The project's untagged documents (the last resort) always wait behind "Show N not yet sorted…".
  function groupsInto(box, res, o = {}) {
    if (!res || res.empty) return 0;
    const lim = o.limit || 999;
    res.groups.forEach(g => {
      const wrap = mk('div', 'ffd-group'); wrap.dataset.group = g.id;
      const hd = groupHeading(g), h = mk('div', 'ffd-gh');
      h.appendChild(mk('b', null, hd.text));
      if (hd.from) h.appendChild(mk('span', 'ffd-from', hd.from));
      wrap.appendChild(h);
      const rows = g.items.map(docRow);
      const keep = g.fallback && g.level === 'project' ? 0 : rows.length > lim + 1 ? lim : rows.length;
      rows.slice(0, keep).forEach(r => wrap.appendChild(r));
      if (keep < rows.length) {
        const more = mk('button', 'ffd-more', keep ? `${rows.length - keep} more…` : `Show ${rows.length} not yet sorted…`);
        more.addEventListener('click', e => { e.stopPropagation(); rows.slice(keep).forEach(r => wrap.insertBefore(r, more)); more.remove(); });
        wrap.appendChild(more);
      }
      box.appendChild(wrap);
    });
    return res.items.length;
  }
  // The shots of a station that came from a scanned page: "From page 2 of <document>", opening at that page.
  function scanRows(st) {
    return scanSources(Object.values(ffState.surveys || {}), st.cave || '', st.name, ffD).map(s => {
      const r = mk('div', 'ffd-scan'); r.dataset.doc = s.doc; r.dataset.page = String(s.index);
      r.appendChild(mk('div', 't1', `📷 From page ${s.index + 1} of “${s.title}”`));
      r.appendChild(mk('div', 't2', `${s.shots.slice(0, 4).join(', ')}${s.shots.length > 4 ? ` +${s.shots.length - 4}` : ''}${s.surveys.length ? ' · ' + s.surveys.join(', ') : ''}`));
      r.addEventListener('click', () => ffDocOpen(s.doc, s.index));
      return r;
    });
  }
  // Documents tagged to a lead of the station (project leads only): their own small groups.
  function leadRows(st) {
    const out = [];
    if (typeof ffLeadsAt !== 'function' || !ffPid) return out;
    ffLeadsAt(st).forEach(it => {
      if (!it.rec || !it.id) return;
      const res = FL.docsFor(ffD, ffP, FL.T.lead(it.id), {});
      if (res.empty) return;
      const box = mk('div', 'ffd-box'); box.dataset.lead = it.id;
      box.appendChild(mk('div', 'ffd-lead', '❓ ' + ((it.fields && it.fields.desc) || 'Lead')));
      groupsInto(box, res, { limit: 3 });
      out.push(box);
    });
    return out;
  }

  // ── The station card ────────────────────────────────────────────────────────
  let CARD = null;                    // an open survey or cave card: { kind, cave, code, edit }
  // The Survey row of the station card: the survey and the cave in it open their own cards.
  function linkSurveyRow(st) {
    const rows = $('info-rows');
    if (!rows || !st) return;
    const row = [...rows.querySelectorAll('.fx-row')].find(r => { const l = r.querySelector('.lbl'); return l && /^Survey:/.test(l.textContent); });
    const val = row && row.querySelector('.val');
    if (!val) return;
    const code = ffStCodes(st)[0];
    if (!code || !ffPid) return;
    const cave = st.cave || '', link = (text, fn) => { const s = mk('span', 'ffd-sl', text); s.addEventListener('click', e => { e.stopPropagation(); fn(); }); return s; };
    val.textContent = '';
    val.appendChild(link(st.surveyName || '—', () => openSurvey(cave, code)));
    if (st.cave) { val.appendChild(document.createTextNode(' · ')); val.appendChild(link(st.cave, () => openCave(cave))); }
  }
  // The documents part of a station's card (after its notes, leads and buttons): groups, scanned shots, lead documents.
  // `docBtn`: the card's "📄 Documents" button, which learns the count.
  function stationCard(box, st, docBtn) {
    CARD = null;
    const res = stationDocs(st);
    if (res && docBtn) { const n = count(res); if (n) docBtn.textContent = `📄 Documents · ${n}`; }
    const sec = mk('div', 'ffd-box'); sec.id = 'ffd-station';
    if (res) groupsInto(sec, res, { limit: 3 });
    scanRows(st).forEach(r => sec.appendChild(r));
    leadRows(st).forEach(r => sec.appendChild(r));
    if (sec.childNodes.length) box.appendChild(sec);
    linkSurveyRow(st);
  }

  // ── Survey and cave cards (the details panel) ───────────────────────────────
  function showCard(title, color, chips) {
    const t = $('info-title'); t.textContent = title; t.style.color = color || '#00e5ff';
    $('info-subtitle').textContent = '';
    const rows = $('info-rows'); rows.textContent = '';
    const c = mk('div', 'st-chips');
    chips.forEach(x => { const s = mk('span', 'chip' + (x.fn ? ' ffd-sl' : ''), x.text); if (x.fn) s.addEventListener('click', x.fn); c.appendChild(s); });
    rows.appendChild(c);
    const info = $('info-panel'); info.scrollTop = 0; info.classList.add('open');
    return rows;
  }
  function surveyBounds(cave, set) {
    const b = new THREE.Box3();
    stationMap.forEach(st => { if ((st.cave || '') === cave && set.has(st.name)) b.expandByPoint(st.pos); });
    return b;
  }
  function showOnMap(b) {
    if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3()).length();
    flyToPoint(c, Math.max(30, size * 0.9));
  }
  function cardButtons(box, target, extra) {
    const row = mk('div', 'fp-row');
    const nb = mk('button', 'fp-btn active', '✏️ Add note'); nb.id = 'ff-add-note';
    nb.addEventListener('click', () => ffEditNote(target));
    row.appendChild(nb);
    (extra || []).forEach(b => row.appendChild(b));
    const eb = mk('button', 'fp-btn ff-edit-btn' + (CARD.edit ? ' active' : ''), CARD.edit ? '✓ Done' : '✎ Edit');
    eb.id = 'ff-edit-btn'; eb.title = 'Show the edit actions for this card';
    eb.style.cssText = 'font-size:11px;padding:4px 8px;opacity:.8';
    eb.addEventListener('click', () => { CARD.edit = !CARD.edit; refresh(); });
    row.appendChild(eb);
    box.appendChild(row);
    if (CARD.edit) {
      const r2 = mk('div', 'fp-row ff-edit-actions');
      const ab = mk('button', 'fp-btn', '＋ Add pages here'); ab.id = 'ffd-add-pages';
      ab.title = 'Photos, scans or PDFs about this; they are tagged to it';
      ab.addEventListener('click', () => ffAddPages(null, null, [target]));
      r2.appendChild(ab);
      box.appendChild(r2);
    }
  }
  function notesInto(box, target) {
    FL.notesOn(ffP, target).forEach(n => box.appendChild(ffNoteEl(n, !!(CARD && CARD.edit))));
  }
  function surveyCard() {
    const r = index().get(CARD.cave + '|' + CARD.code);
    if (!r) { CARD = null; return false; }
    clearStationHighlight();
    const cid = caveIdOf(CARD.cave);
    const rows = showCard(r.name, r.color, [
      { text: `${r.stations.size} station${r.stations.size === 1 ? '' : 's'}` }, { text: `${r.shots} shot${r.shots === 1 ? '' : 's'}` },
      ...(CARD.cave ? [{ text: CARD.cave, fn: () => openCave(CARD.cave) }] : [])]);
    const box = mk('div', 'ff-card'); box.id = 'ffd-card'; box.dataset.kind = 'survey';
    if (!cid || !ffPid) box.appendChild(mk('div', 'fp-note', ffPid ? 'This cave isn’t linked to the project: ⋯ More → Project & sync.' : 'This map has no project yet: ⋯ More → Project & sync.'));
    else {
      const target = FL.T.survey(cid, CARD.code);
      notesInto(box, target);
      const show = mk('button', 'fp-btn', '🎯 Show'); show.addEventListener('click', () => showOnMap(surveyBounds(CARD.cave, r.stations)));
      cardButtons(box, target, [show]);
      const sec = mk('div', 'ffd-box'); sec.id = 'ffd-survey';
      const res = surveyDocs(CARD.cave, CARD.code);
      if (!groupsInto(sec, res, { limit: 4 })) sec.appendChild(mk('div', 'ffd-empty', 'No documents for this survey, its cave or the project yet.'));
      box.appendChild(sec);
    }
    rows.appendChild(box);
    return true;
  }
  function caveCard() {
    const cid = caveIdOf(CARD.cave), inf = stationInfo(index(), CARD.cave);
    if (cid == null) { CARD = null; return false; }
    clearStationHighlight();
    const rows = showCard(projectCaveName(cid), '#00e5ff', [{ text: `${inf.surveys.length} survey${inf.surveys.length === 1 ? '' : 's'}` }, { text: `${inf.all.length} station${inf.all.length === 1 ? '' : 's'}` }]);
    const box = mk('div', 'ff-card'); box.id = 'ffd-card'; box.dataset.kind = 'cave';
    if (!ffPid) box.appendChild(mk('div', 'fp-note', 'This map has no project yet: ⋯ More → Project & sync.'));
    else {
      const target = FL.T.cave(cid);
      notesInto(box, target);
      cardButtons(box, target, []);
      const sec = mk('div', 'ffd-box'); sec.id = 'ffd-cave';
      if (inf.surveys.length) {
        sec.appendChild(mk('div', 'ffd-gh', 'Surveys'));
        inf.surveys.forEach(s => { const row = fpRow('〰️', s.name, `${s.stations.length} station${s.stations.length === 1 ? '' : 's'}`, () => openSurvey(CARD.cave, s.code)); row.classList.add('ffd-svrow'); row.dataset.code = s.code; sec.appendChild(row); });
      }
      if (!groupsInto(sec, caveDocs(CARD.cave), { limit: 4 })) sec.appendChild(mk('div', 'ffd-empty', 'No documents for this cave or the project yet.'));
      box.appendChild(sec);
    }
    rows.appendChild(box);
    return true;
  }
  function openSurvey(cave, code) {
    if (!code) return false;
    const edit = CARD && CARD.kind === 'survey' && CARD.cave === cave && CARD.code === code ? CARD.edit : false;
    CARD = { kind: 'survey', cave: cave || '', code, edit };
    return surveyCard();
  }
  function openCave(cave) {
    const edit = CARD && CARD.kind === 'cave' && CARD.cave === (cave || '') ? CARD.edit : false;
    CARD = { kind: 'cave', cave: cave || '', edit };
    return caveCard();
  }
  // After a change: the open survey or cave card is drawn again (true when there was one).
  function refresh() {
    if (!CARD) return false;
    const info = $('info-panel');
    if (!info || !info.classList.contains('open')) { CARD = null; return false; }
    return CARD.kind === 'survey' ? surveyCard() : caveCard();
  }
  if (inPage) new MutationObserver(() => { if (CARD && !$('info-panel').classList.contains('open')) CARD = null; })
    .observe($('info-panel'), { attributes: true, attributeFilter: ['class'] });

  // ── The Documents panel's lists ────────────────────────────────────────────
  // tab: 'station' | 'surveys' | 'inbox' | 'all'. true when handled.
  function fillList(list, tab, st, all) {
    const note = t => list.appendChild(mk('div', 'fp-note', t));
    const grouped = docs => {
      FL.groupDocs(docs).forEach(g => {
        const wrap = mk('div', 'ffd-group'); wrap.dataset.group = g.id;
        const h = mk('div', 'ffd-gh'); h.appendChild(mk('b', null, `${g.label} (${g.docs.length})`)); wrap.appendChild(h);
        g.docs.forEach(d => { const r = fpRow(GROUP_ICON[g.id] || '📄', d.title || 'Untitled', ffDocSub(d), () => ffDocOpen(d.id, 0)); r.classList.add('ffd-doc'); r.dataset.doc = d.id; wrap.appendChild(r); });
        list.appendChild(wrap);
      });
    };
    if (tab === 'station' && st) {
      const res = stationDocs(st);
      if (!res) note('This cave isn’t linked to the project: ⋯ More → Project & sync.');
      else if (res.empty) note('Nothing tagged here yet. ＋ Add pages, or tag a document from the Inbox.');
      else groupsInto(list, res, {});
      scanRows(st).forEach(r => list.appendChild(r));
      return true;
    }
    if (tab === 'surveys') { surveysList(list); return true; }
    if (tab === 'inbox') {
      const inbox = all.filter(d => FL.docInbox(d, ffP));
      grouped(inbox);
      if (!inbox.length) note('Inbox empty: every document is tagged to a cave, survey, station or lead.');
      return true;
    }
    if (tab === 'all') {
      grouped(all);
      if (!all.length) note('No documents yet. ＋ Add pages: photos, scans (TIFF too) or PDFs of survey notes, trip reports, maps…');
      return true;
    }
    return false;
  }
  // Surveys of the caves on this map, each with what it has: tap one for its card.
  function surveysList(list) {
    const idx = index(), names = Object.keys(ffLinks.byName);
    if (!names.length) { list.appendChild(mk('div', 'fp-note', 'No cave on this map is linked to the project: ⋯ More → Project & sync.')); return; }
    const say = res => {
      const n = count(res);
      if (!res || res.empty || (!n && res.level === 'project')) return 'no documents';
      if (res.own) return `${n} document${n === 1 ? '' : 's'}`;
      return `none of its own · ${n} from ${res.level === 'cave' ? 'the cave' : res.level === 'within' ? 'its stations' : 'the project'}`;
    };
    names.forEach(cave => {
      const cid = caveIdOf(cave), inf = stationInfo(idx, cave);
      list.appendChild(mk('div', 'fp-h', projectCaveName(cid)));
      const cr = fpRow('🕳', projectCaveName(cid), `${inf.surveys.length} survey${inf.surveys.length === 1 ? '' : 's'} · ${say(caveDocs(cave))}`, () => { ffClosePanel(); openCave(cave); });
      cr.classList.add('ffd-caverow'); cr.dataset.cave = cave; list.appendChild(cr);
      inf.surveys.forEach(s => {
        const r = fpRow('〰️', s.name, `${s.stations.length} station${s.stations.length === 1 ? '' : 's'} · ${say(surveyDocs(cave, s.code))}`, () => { ffClosePanel(); openSurvey(cave, s.code); });
        r.classList.add('ffd-svrow'); r.dataset.cave = cave; r.dataset.code = s.code; list.appendChild(r);
      });
    });
  }

  // ── The gallery: this page's tags, and "Tag this page…" behind Edit ────────
  function galleryInit(g) {
    if (!g || g.querySelector('.ffg-pt')) return;
    const row = mk('div', 'ffg-pt');
    const b = mk('button', 'fp-btn ffg-tagpage', '🏷 Tag this page…');
    b.title = 'Say which station, or which range of stations (A6~A8), this page is about';
    b.addEventListener('click', () => { if (ffGallery) editTags(ffGallery.doc, { page: ffGallery.i }); });
    row.appendChild(b);
    const after = g.querySelector('.ffg-tags');
    if (after && after.parentNode) after.parentNode.insertBefore(row, after.nextSibling); else g.appendChild(row);
  }
  // The caption under the title: the document's tags, and this page's own.
  function galleryCaption(g, d, i) {
    const tg = g && g.querySelector('.ffg-tags'), pg = d && d.pages[i];
    if (!tg || !pg) return;
    const doc = d.tagList.filter(t => t !== FL.T.project(ffPid)).map(label).join(' · ') || 'inbox — 🏷 to tag a survey or station';
    const mine = (pg.targets || []).map(label);
    tg.textContent = mine.length ? `This page: ${mine.join(' · ')}  —  Document: ${doc}` : doc;
    tg.dataset.pageTags = mine.length ? '1' : '';
    const b = g.querySelector('.ffg-tagpage');
    if (b) b.textContent = mine.length ? '🏷 Tag this page… (' + mine.length + ')' : '🏷 Tag this page…';
  }

  // ── The tag picker: cave → survey → station or range ───────────────────────
  const RECENT = 'flexfield_recent_tags', LASTCAVE = 'flexfield_tag_cave';
  const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* storage off: nothing is remembered */ } };
  function recentTags() {
    let l = [];
    try { l = JSON.parse(lsGet(RECENT) || '[]'); } catch (_) {}
    return recentKeep(l, ffP, ffPid);
  }
  function pushRecent(targets) {
    const keep = recentTags().filter(t => !targets.includes(t));
    lsSet(RECENT, JSON.stringify(targets.filter(t => !/^project:/.test(t)).concat(keep).slice(0, 12)));
    const c = targets.map(t => FL.parseTarget(t).cave).find(Boolean);
    if (c) lsSet(LASTCAVE, c);
  }
  // What a document can be tagged to besides stations: the project, its caves and surveys, surface points, leads.
  function otherChoices(idx) {
    const out = [];
    if (ffPid) out.push({ label: 'Project · ' + (ffP.name || 'this project'), target: FL.T.project(ffPid) });
    FL.liveCaves(ffP).forEach(c => {
      out.push({ label: 'Cave · ' + c.name, target: FL.T.cave(c.id) });
      const nm = caveNameOf(c.id);
      if (nm != null) stationInfo(idx, nm).surveys.forEach(s => out.push({ label: `Survey ${s.code}${s.desc ? ' — ' + s.desc : ''} · ${c.name}`, target: FL.T.survey(c.id, s.code) }));
    });
    try { FL.liveFeatures(ffP).forEach(f => out.push({ label: `${{ point: 'Point', line: 'Line', area: 'Area' }[f.kind] || 'Feature'} · ${f.name || '(no name)'} (surface)`, target: FL.T.feature(f.id) })); } catch (_) {}
    Object.values(ffP.leads || {}).forEach(L => { if (!L.deleted) out.push({ label: 'Lead · ' + label(L.target) + (L.fields && L.fields.desc ? ' — ' + String(L.fields.desc).slice(0, 40) : ''), target: FL.T.lead(L.id) }); });
    return out;
  }
  // o: { doc, page (an index: new tags go on that page) }. Resolves { S, added, d } when Done, null when cancelled.
  async function pickTags(o) {
    const d = ffD.docs[o.doc];
    if (!d) return null;
    const idx = index(), caves = FL.liveCaves(ffP).sort((a, b) => (caveNameOf(a.id) == null) - (caveNameOf(b.id) == null) || a.name.localeCompare(b.name));
    const S = { scope: o.page != null && d.pages.length ? 'page' : 'doc', page: o.page != null ? Math.max(0, Math.min(d.pages.length - 1, o.page)) : 0, text: '', survey: '' };
    S.docWant = new Set(d.tagList);
    S.pageWant = new Map();
    d.pages.forEach((p, i) => { if (p.targets && p.targets.length) S.pageWant.set(i, new Set(p.targets)); });
    const own = [...new Set([...S.docWant, ...[...S.pageWant.values()].flatMap(s => [...s])].map(t => FL.parseTarget(t).cave).filter(c => c && ffP.caves[c] && caveNameOf(c) != null))];
    const last = lsGet(LASTCAVE);
    S.cave = (own.length === 1 && own[0]) || (last && ffP.caves[last] && !ffP.caves[last].removed && caveNameOf(last) != null && last) || (caves.find(c => caveNameOf(c.id) != null) || caves[0] || {}).id || '';
    const added = [];
    const scopeSet = () => { if (S.scope === 'doc') return S.docWant; if (!S.pageWant.has(S.page)) S.pageWant.set(S.page, new Set()); return S.pageWant.get(S.page); };
    const has = t => scopeSet().has(t);
    const addTag = t => { if (!t || has(t)) return; scopeSet().add(t); added.push(t); S.text = ''; q.value = ''; paint(); };
    const body = mk('div', 'ffd-pick');
    const scopeRow = mk('div', 'ffd-row ffd-scope'), chipsBox = mk('div', 'ff-chips ffd-chips'), recentBox = mk('div', 'ff-chips ffd-recent');
    const pickRow = mk('div', 'ffd-row');
    const caveSel = mk('select', 'ffd-cave'), surSel = mk('select', 'ffd-survey');
    const q = mk('input', 'ff-input ffd-q');
    q.placeholder = 'Station, or a range like A6~A8';
    q.autocomplete = 'off'; q.setAttribute('autocapitalize', 'characters'); q.setAttribute('enterkeyhint', 'done');
    const sug = mk('div', 'ffd-sug'), hint = mk('div', 'ffd-hint');
    const addBtn = mk('button', 'fp-btn active ffd-add', '＋ Add');
    addBtn.title = 'Add the station or range typed; with nothing typed, the survey chosen, else the cave';
    pickRow.append(caveSel, surSel);
    body.append(scopeRow, mk('div', 'ffd-lbl', 'Tagged to'), chipsBox, recentBox, pickRow);
    const qRow = mk('div', 'ffd-row'); q.style.flex = '1'; qRow.append(q, addBtn);
    body.append(qRow, sug, hint);
    const infoOf = cid => { const nm = caveNameOf(cid); return nm != null ? stationInfo(idx, nm) : { surveys: [], all: [] }; };
    let choices = null;
    const others = () => choices || (choices = otherChoices(idx).filter(c => !/^station:/.test(c.target)));
    function paintScope() {
      scopeRow.textContent = '';
      if (!d.pages.length) return;
      const lbl = mk('span', 'ffd-lbl', 'A new tag goes on'); lbl.style.flexBasis = '100%';
      scopeRow.appendChild(lbl);
      const chip = (text, on, fn, into) => { const b = mk('button', 'fp-btn ff-chip' + (on ? ' active' : ''), text); b.addEventListener('click', fn); (into || scopeRow).appendChild(b); return b; };
      chip('the whole document', S.scope === 'doc', () => { S.scope = 'doc'; paint(); }).classList.add('ffd-scope-doc');
      const pager = mk('span', 'ffd-pager'); scopeRow.appendChild(pager);
      const go = k => chip(k < 0 ? '‹' : '›', false, () => { S.page = Math.max(0, Math.min(d.pages.length - 1, S.page + k)); S.scope = 'page'; paint(); }, pager);
      if (d.pages.length > 1) go(-1).classList.add('ffd-prev');
      chip(`page ${S.page + 1} of ${d.pages.length}`, S.scope === 'page', () => { S.scope = 'page'; paint(); }, pager).classList.add('ffd-scope-page');
      if (d.pages.length > 1) go(1).classList.add('ffd-next');
    }
    function paintChips() {
      chipsBox.textContent = '';
      const chip = (text, set, t, cls) => { const b = mk('button', 'fp-btn ff-chip active ' + (cls || ''), text + ' ✕'); b.addEventListener('click', () => { set.delete(t); paint(); }); b.dataset.target = t; chipsBox.appendChild(b); };
      [...S.docWant].forEach(t => chip((t === FL.T.project(ffPid) ? 'Project · ' : '') + label(t), S.docWant, t, 'doc'));
      [...S.pageWant.entries()].sort((a, b) => a[0] - b[0]).forEach(([i, set]) => [...set].forEach(t => chip(`p${i + 1} · ${label(t)}`, set, t, 'page')));
      if (!chipsBox.childNodes.length) chipsBox.appendChild(mk('div', 'fp-note', 'No tags: the document is in no project.'));
    }
    function paintRecent() {
      recentBox.textContent = '';
      const r = recentTags().filter(t => !has(t)).slice(0, 6);
      if (!r.length) return;
      recentBox.appendChild(mk('span', 'ffd-lbl', 'Recent'));
      r.forEach(t => { const b = mk('button', 'fp-btn ff-chip', '＋ ' + label(t)); b.dataset.target = t; b.addEventListener('click', () => addTag(t)); recentBox.appendChild(b); });
    }
    function paintSelects() {
      caveSel.textContent = ''; surSel.textContent = '';
      if (!caves.length) caveSel.appendChild(new Option('(no caves in this project)', ''));
      caves.forEach(c => caveSel.appendChild(new Option(c.name + (caveNameOf(c.id) == null ? ' (not on this map)' : ''), c.id, false, c.id === S.cave)));
      const sv = infoOf(S.cave).surveys;
      surSel.appendChild(new Option(sv.length ? 'any survey' : 'surveys not on this map', ''));
      sv.forEach(s => surSel.appendChild(new Option(`Survey ${s.code}${s.desc ? ' — ' + s.desc.slice(0, 30) : ''}`, s.code, false, s.code === S.survey)));
      surSel.disabled = !sv.length;
    }
    const suggestions = () => suggest({ text: S.text, cave: S.cave && ffP.caves[S.cave] ? { id: S.cave, name: ffP.caves[S.cave].name } : null, info: infoOf(S.cave), survey: S.survey, has, others: others() });
    function paintSug() {
      sug.textContent = '';
      const l = suggestions();
      l.forEach((s, i) => {
        const b = mk('button', 'fp-btn' + (i === 0 && S.text.trim() ? ' first' : ''), s.label); b.dataset.target = s.target;
        if (s.sub) b.appendChild(mk('div', 'sub', s.sub));
        b.addEventListener('click', () => addTag(s.target));
        sug.appendChild(b);
      });
      if (!l.length) sug.appendChild(mk('div', 'fp-note', S.text.trim() ? 'Nothing matches.' : 'Everything is already added.'));
      hint.textContent = S.cave && !infoOf(S.cave).all.length ? 'This cave’s survey is not on this map, so stations cannot be suggested: type a name or a range (A6~A8) and it is taken as written.' : '';
    }
    function paint() { paintScope(); paintChips(); paintRecent(); paintSelects(); paintSug(); }
    caveSel.addEventListener('change', () => { S.cave = caveSel.value; S.survey = ''; paint(); });
    surSel.addEventListener('change', () => { S.survey = surSel.value; paintSug(); });
    q.addEventListener('input', () => { S.text = q.value; paintSug(); });
    q.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); e.stopPropagation();
      const first = suggestions()[0];
      if (first) { addTag(first.target); q.focus(); }
    });
    addBtn.addEventListener('click', () => {
      const first = S.text.trim() ? suggestions()[0] : null;
      if (first) addTag(first.target);
      else if (S.cave && S.survey) addTag(FL.T.survey(S.cave, S.survey));
      else if (S.cave) addTag(FL.T.cave(S.cave));
      q.value = ''; S.text = ''; paintSug();
    });
    paint();
    PICK = { S, added, q, caveSel, surSel, addTag };
    const r = await ffDialog({ title: 'Tags · ' + (d.title || 'document'), body, wide: true, buttons: [{ label: 'Cancel', value: null }, { label: 'Done', value: 'ok', primary: true }] });
    PICK = null;
    return r ? { S, added, d } : null;
  }
  let PICK = null;
  // Change the tags of a document, or of one of its pages (opts.page). Everything changed is recorded together
  // (doc.tag / doc.untag on the document, doc.pagetag / doc.pageuntag on a page); undo is in the change log.
  async function editTags(docId, opts = {}) {
    await ffEnsureAuthor();
    const res = await pickTags({ doc: docId, page: opts.page != null ? opts.page : null });
    if (!res) return false;
    const ops = tagOps(res.d, res.S.docWant, res.S.pageWant);
    if (!ops.length) return false;
    ffRecordMany(ops.map(([op, data]) => [op, data]), 'docs');
    pushRecent(res.added.slice().reverse());
    const g = $('ff-gallery');
    if (g && ffGallery && ffGallery.doc === docId) galleryCaption(g, ffD.docs[docId], ffGallery.i);
    if (typeof showToast === 'function') showToast(`${ops.length} tag change${ops.length === 1 ? '' : 's'} saved`);
    return true;
  }

  // ── The kind of a new document ─────────────────────────────────────────────
  const kindFor = (pages, ctx) => (ctx && ctx.kind) || kindForPages(pages);
  // Files picked in a browser: a JPEG with camera data (Exif Make / Model) is a photo, a scan is Survey notes…
  async function kindForFiles(files) {
    const f = (files || [])[0];
    if (!f) return '';
    let camera = false;
    if (/\.jpe?g$/i.test(f.name) || f.type === 'image/jpeg') { try { camera = FL.exifCamera(new Uint8Array(await f.slice(0, 65536).arrayBuffer())); } catch (_) {} }
    return FL.suggestKind({ name: f.name, type: f.type, camera });
  }
  // The four groups as chips under a Kind input (the kind decides the group).
  function kindChips(form) {
    const inp = form && form.querySelector('input[data-k="kind"]');
    if (!inp || form.querySelector('.ffd-kinds')) return;
    const row = mk('div', 'ffd-kinds');
    const paint = () => row.querySelectorAll('button').forEach(b => b.classList.toggle('active', FL.docGroup(inp.value) === b.dataset.group && !!inp.value.trim()));
    FL.DOC_GROUPS.forEach(g => {
      const b = mk('button', 'fp-btn ff-chip', g.label); b.dataset.group = g.id; b.type = 'button';
      b.addEventListener('click', () => { if (FL.docGroup(inp.value) !== g.id || !inp.value.trim()) inp.value = GROUP_KIND[g.id]; paint(); });
      row.appendChild(b);
    });
    inp.addEventListener('input', paint);
    inp.parentNode.appendChild(row);
    paint();
  }

  return {
    // rules
    shortLabel, pageNote, subOf, groupHeading, count, surveyIndex, stationInfo, suggest, tagOps, recentKeep, scanSources, kindForPages, descOf,
    GROUP_KIND, GROUP_ICON,
    // page
    stationDocs, surveyDocs, caveDocs, stationCard, openSurvey, openCave, refresh, fillList, galleryInit, galleryCaption,
    editTags, kindFor, kindForFiles, kindChips, groupsInto, docRow,
    card: () => CARD, picker: () => PICK,
  };
});
