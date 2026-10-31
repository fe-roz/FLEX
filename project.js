// Projects in desktop FLEX: caves, notes, leads, documents and sync files —
// the same library and the same rules as FLEX Field (viewer_build/libs/
// flexlib.js; storage in library.js under user_files/library/). Spec:
// project doc 11.
//
//   📁 Project panel   project, its caves (and which loaded file / surveys
//                      each is made of, with caves suggested inside a file),
//                      suggestions to review, leads, documents, sync files,
//                      history
//   station card      a clicked station (or shot): its notes, leads and
//                      documents, and buttons to add them
//   gallery           a document's pages: turn, tag, details, remove
//   field survey      shots taken on the phone, drawn on their cave (view only)
//
// Classic script: waits for flex.js (a module) to make the viewer.
(function () {
  'use strict';
  const FL = window.FlexLib;
  if (!FL) { console.warn('[project] flexlib.js missing'); return; }
  const API = '/api/lib/';
  const PAGE_PX = 2400;
  const FIELD_COLOR = '#ff9f1c';
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';

  // ── State ──────────────────────────────────────────────────────────────────
  const pj = {
    dev: null, pid: null, P: FL.replayProject([], ''), D: FL.replayDocs([]),
    proj: [], docs: [], projects: [], ready: false,
    leadShow: 'active', docTab: 'inbox', card: null, gallery: null,
  };
  window._pj = pj;                               // for the console and tests
  const $ = id => document.getElementById(id);
  const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(label, fn, cls) { const b = el('button', 'pj-btn' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', e => { e.stopPropagation(); fn(e); }); return b; }
  function when(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) + ' ' +
           d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  function fnv(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  function toast(msg) {
    let t = $('pj-toast');
    if (!t) { t = el('div'); t.id = 'pj-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('on');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 2600);
  }

  // ── Server ─────────────────────────────────────────────────────────────────
  async function api(path, opts) {
    const r = await fetch(API + path, opts);
    const ct = r.headers.get('Content-Type') || '';
    const out = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) throw new Error((out && out.error) || r.statusText);
    return out;
  }
  const post = (path, data) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const parseLines = t => String(t || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const blobUrl = p => API + 'blob/' + p.h + '.' + (p.ext || 'jpg');

  // ── Author ─────────────────────────────────────────────────────────────────
  const who = () => { try { return localStorage.getItem('flex.author') || ''; } catch (_) { return ''; } };
  async function ensureAuthor() {
    if (who()) return who();
    const r = await dialog({ title: 'Who is entering data?', text: 'Everything you add is logged under this name (in FLEX and in the sync files).',
      input: { value: '', placeholder: 'Your name' }, buttons: [{ label: 'Cancel', value: null }, { label: 'Use this name', value: 'ok', primary: true }] });
    if (r && r.value.trim()) { try { localStorage.setItem('flex.author', r.value.trim().slice(0, 40)); } catch (_) {} render(); }
    return who();
  }

  // ── Dialogs ────────────────────────────────────────────────────────────────
  function dialog({ title, text, html, body, input, textarea, buttons, wide }) {
    return new Promise(resolve => {
      const wrap = el('div', 'pj-modal');
      const box = el('div', 'pj-modal-box' + (wide ? ' wide' : ''));
      if (title) box.appendChild(el('div', 'pj-modal-title', title));
      if (text) box.appendChild(el('div', 'pj-modal-text', text));
      if (html) { const d = el('div', 'pj-modal-text'); d.innerHTML = html; box.appendChild(d); }
      if (body) box.appendChild(body);
      let field = null;
      if (input || textarea) {
        const o = input || textarea;
        field = el(textarea ? 'textarea' : 'input', 'pj-input');
        field.value = o.value || ''; field.placeholder = o.placeholder || '';
        if (textarea) field.rows = 6;
        box.appendChild(field);
      }
      const row = el('div', 'pj-modal-btns');
      const done = v => { wrap.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
      (buttons || [{ label: 'OK', value: 'ok', primary: true }]).forEach(bt => {
        row.appendChild(btn(bt.label, () => done(bt.value === null ? null : { button: bt.value, value: field ? field.value : '', box }),
          (bt.primary ? 'primary' : '') + (bt.danger ? ' danger' : '')));
      });
      box.appendChild(row);
      wrap.appendChild(box);
      wrap.addEventListener('mousedown', e => { if (e.target === wrap) done(null); });
      const key = e => {
        if (e.key === 'Escape') { e.stopPropagation(); done(null); }
        if (e.key === 'Enter' && field && !textarea && document.activeElement === field) { e.preventDefault(); const p = (buttons || []).find(b => b.primary); done(p ? { button: p.value, value: field.value, box } : null); }
      };
      document.addEventListener('keydown', key, true);
      document.body.appendChild(wrap);
      if (field) setTimeout(() => field.focus(), 30);
    });
  }
  async function choose(title, text, options, cancel = 'Cancel') {
    return new Promise(resolve => {
      const body = el('div', 'pj-choices');
      let picked = false;
      options.forEach(o => {
        const b = btn(o.label, () => { picked = true; b.closest('.pj-modal').remove(); resolve(o.value); }, o.primary ? 'primary' : '');
        if (o.sub) b.appendChild(el('div', 'pj-sub', o.sub));
        body.appendChild(b);
      });
      dialog({ title, text, body, buttons: [{ label: cancel, value: null }] }).then(() => { if (!picked) resolve(null); });
    });
  }

  // ── Load, record, replay ───────────────────────────────────────────────────
  // Reading the logs again keeps entries this page recorded meanwhile (a save
  // can land between the read and its answer — e.g. focus coming back from a
  // file picker during an import).
  async function loadAll() {
    const pid = pj.pid;
    pj.projects = await api('projects');
    const proj = pid ? parseLines(await api('read?scope=' + FL.projScope(pid))) : [];
    const docs = parseLines(await api('read?scope=docs'));
    const keep = (fresh, mine) => { const ids = new Set(fresh.map(e => e.id)); return fresh.concat(mine.filter(e => !ids.has(e.id))); };
    if (pid !== pj.pid) return;                                   // switched meanwhile: that load wins
    pj.proj = pid && pj.projPid === pid ? keep(proj, pj.proj) : proj;
    pj.projPid = pid;
    pj.docs = keep(docs, pj.docs);
    replay();
  }
  function replay() {
    pj.P = FL.replayProject(pj.proj, pj.pid || '');
    pj.D = FL.replayDocs(pj.docs);
  }
  /** A change: numbered by the server, then replayed here. */
  // quiet: many in a row (an import) — saved and kept, the screen refreshed once
  // afterwards with refresh().
  async function record(op, data, where, { quiet = false } = {}) {
    if (!pj.pid && where !== 'docs') { toast('Choose or create a project first (📁 Project)'); return null; }
    if (!(await ensureAuthor())) return null;
    const scope = where === 'docs' ? FL.DOCS : FL.projScope(pj.pid);
    let e;
    try { e = await post('append?scope=' + scope + (where === 'docs' && pj.pid ? '&project=' + encodeURIComponent(pj.pid) : ''), Object.assign({ t: new Date().toISOString(), who: who(), op }, data)); }
    catch (err) { toast('Could not save: ' + err.message); return null; }
    (where === 'docs' ? pj.docs : pj.proj).push(e);
    if (quiet) return e;
    replay();
    afterChange(e);
    return e;
  }
  function refresh(op) { replay(); afterChange({ op: op || 'feature.set' }); }
  function afterChange(e) {
    render();
    refreshCard();
    if (pj.gallery) galleryShow(pj.gallery.i);
    if (/^(survey|shot|cave)\.|^accept$/.test(e.op)) drawField();
    if (/^lead\.|^accept$|^reject$|^feature\./.test(e.op) || /^cave\./.test(e.op)) drawLeads();
    if (window._pjSeg) window._pjSeg.changed(e);
    if (window._pjf) window._pjf.changed(e);
  }
  // Switching project: what was on screen is saved and unloaded, the project's
  // things load (project_workspace.js). keep: a new project takes what is on
  // screen now instead.
  async function setProject(pid, { keep = false } = {}) {
    const prev = pj.pid, change = (pid || null) !== prev;
    if (change && window._pjWs && !keep) await window._pjWs.leave(prev);
    pj.pid = pid || null;
    try { pid ? localStorage.setItem('flex.project', pid) : localStorage.removeItem('flex.project'); } catch (_) {}
    await loadAll();
    render(); refreshCard(); drawField(); drawLeads();
    if (window._pjSeg) window._pjSeg.changed(null);
    if (window._pjf) window._pjf.changed(null);
    if (change && window._pjWs) { if (keep) await window._pjWs.adopt(); else await window._pjWs.enter(pj.pid); }
    if (window._pjWs) window._pjWs.label();
    if (window._pjf) window._pjf.changed(null);
  }

  // ── Caves: which project cave a loaded file (and survey) is ───────────────
  const imps = () => (window._caveImports || []).filter(i => i && i.parsed);
  function caveFor(imp, code) {
    if (!imp || !pj.pid) return null;
    for (const c of FL.liveCaves(pj.P)) {
      for (const s of c.sources || []) {
        if (s && s.file === imp.name && (!s.surveys || !s.surveys.length || s.surveys.includes(code || ''))) return c.id;
      }
    }
    return FL.caveForName(pj.P, imp.name);
  }
  const caveName = cid => (pj.P.caves[cid] && pj.P.caves[cid].name) || 'a cave';
  // Loaded files (and their surveys) of a project cave.
  function partsOf(cid) {
    const out = [];
    imps().forEach(imp => {
      const codes = [...new Set((imp.parsed.surveys || []).map(s => s.code).concat((imp.parsed.segments || []).map(s => s.survey || '')))];
      const mine = codes.filter(c => caveFor(imp, c) === cid);
      if (mine.length) out.push({ imp, codes: new Set(mine) });
    });
    return out;
  }
  function suggest(imp) {
    const dopt = imp.displayOptions || {};
    return FL.suggestCaves((imp.parsed.segments || []).map(sg => ({
      survey: sg.survey || '', surface: !!(sg.isSurface || (dopt.surfaceSurveys && dopt.surfaceSurveys[sg.survey || ''])),
      points: sg.points.filter(p => !p.excluded).map(p => ({ name: p.name, surface: !!p.isSurface })),
    })));
  }
  async function linkFile(imp) {
    if (!pj.pid) { toast('Choose or create a project first'); return; }
    const sug = suggest(imp);
    const cur = caveFor(imp, '');
    const opts = FL.liveCaves(pj.P).map(c => ({ label: (c.id === cur ? '✓ ' : '') + c.name, sub: 'this file is part of it', value: 'c:' + c.id }));
    opts.push({ label: `＋ A new cave “${imp.name}”`, sub: 'the whole file', value: 'new', primary: !opts.length });
    if (sug.caves.length > 1) opts.push({ label: `✂ ${sug.caves.length} caves in this file`, sub: 'surveys joined underground form a cave: ' +
      sug.caves.map(c => c.surveys.slice(0, 3).join(', ') + (c.surveys.length > 3 ? '…' : '')).join(' · '), value: 'split' });
    if (cur) opts.push({ label: 'Unlink this file', value: 'unlink' });
    const r = await choose(`“${imp.name}” is…`, 'Notes, leads and documents hang on project caves, so a renamed or re-versioned file stays the same cave.', opts);
    if (!r) return;
    if (r === 'unlink') {
      for (const c of FL.liveCaves(pj.P)) {
        const src = (c.sources || []).filter(s => s.file !== imp.name);
        if (src.length !== (c.sources || []).length) await record('cave.set', { cave: c.id, sources: src });
      }
      if (pj.P.aliases[imp.name]) await record('cave.unalias', { cave: pj.P.aliases[imp.name], alias: imp.name });
      return;
    }
    if (r === 'split') return splitFile(imp, sug);
    let cid;
    if (r === 'new') {
      const n = await dialog({ title: 'New cave', input: { value: imp.name.replace(/\.(plt|json)$/i, '') }, buttons: [{ label: 'Cancel', value: null }, { label: 'Create', value: 'ok', primary: true }] });
      if (!n || !n.value.trim()) return;
      cid = FL.uid(10);
      await record('cave.set', { cave: cid, name: n.value.trim().slice(0, 60), sources: [{ file: imp.name }] });
    } else {
      cid = r.slice(2);
      const c = pj.P.caves[cid];
      if (!(c.sources || []).some(s => s.file === imp.name && !(s.surveys && s.surveys.length)))
        await record('cave.set', { cave: cid, sources: (c.sources || []).filter(s => s.file !== imp.name).concat([{ file: imp.name }]) });
    }
    if (pj.P.aliases[imp.name] !== cid) await record('cave.alias', { cave: cid, alias: imp.name });
  }
  async function splitFile(imp, sug) {
    const form = el('div', 'pj-form');
    const base = imp.name.replace(/\.(plt|json)$/i, '');
    const descOf = {};
    (imp.parsed.surveys || []).forEach(s => { if (!(s.code in descOf)) descOf[s.code] = s.desc; });
    sug.caves.forEach((c, i) => {
      const row = el('div', 'pj-f');
      row.appendChild(el('div', 'pj-f-l', `${c.stations} stations · surveys ${c.surveys.join(', ')}`));
      const inp = el('input', 'pj-input'); inp.value = i === 0 ? base : `${base} – ${descOf[c.surveys[0]] || c.surveys[0]}`; inp.dataset.i = i;
      row.appendChild(inp); form.appendChild(row);
    });
    if (sug.surface.length) form.appendChild(el('div', 'pj-note', 'Surface surveys (not part of a cave): ' + sug.surface.join(', ')));
    const r = await dialog({ title: `Caves in “${imp.name}”`, text: 'Name them. Each becomes a project cave made of these surveys of this file.', body: form, wide: true,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Create caves', value: 'ok', primary: true }] });
    if (!r) return;
    const names = [...form.querySelectorAll('input')].map(i => i.value.trim());
    for (let i = 0; i < sug.caves.length; i++) {
      if (!names[i]) continue;
      await record('cave.set', { cave: FL.uid(10), name: names[i].slice(0, 60), sources: [{ file: imp.name, surveys: sug.caves[i].surveys }] });
    }
  }
  async function editCave(cid) {
    const c = pj.P.caves[cid];
    const r = await dialog({ title: 'Cave', input: { value: c.name }, wide: true,
      html: 'Made of: ' + ((c.sources || []).map(s => esc(s.file) + (s.surveys && s.surveys.length ? ' (surveys ' + esc(s.surveys.join(', ')) + ')' : '')).join('; ') || 'nothing loaded yet') +
        (Object.keys(pj.P.aliases).filter(a => pj.P.aliases[a] === cid).length ? '<br>Also known as: ' + esc(Object.keys(pj.P.aliases).filter(a => pj.P.aliases[a] === cid).join(', ')) : ''),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Remove from project', value: 'rm', danger: true }, { label: 'Save', value: 'ok', primary: true }] });
    if (!r) return;
    if (r.button === 'rm') { await record('cave.set', { cave: cid, removed: true }); return; }
    if (r.value.trim() && r.value.trim() !== c.name) await record('cave.set', { cave: cid, name: r.value.trim().slice(0, 60) });
  }

  // ── Stations: where they are, what is on them ──────────────────────────────
  function stationsOf(imp, name) {
    const out = (imp.parsed.stations || []).filter(s => s.name === name);
    if (out.length) return out;
    for (const sg of imp.parsed.segments || []) for (const p of sg.points) if (p.name === name) return [Object.assign({ survey: sg.survey }, p)];
    return [];
  }
  function stationPos(cid, name) {
    for (const { imp } of partsOf(cid)) {
      const s = stationsOf(imp, name)[0];
      if (s && typeof imp._convertFn === 'function') { const c = imp._convertFn(s.n, s.e, s.v); if (c) return c; }
    }
    const f = pj.fieldPos && pj.fieldPos.get(cid + '|' + name);
    return f || null;
  }
  // The export's leads (Breakout / Walls import) at a station of a loaded file.
  const exportLeadId = (cid, ld) => 'x' + fnv(cid + '|' + (ld.station || '') + '|' + (ld.d != null ? String(ld.d) : ''));
  function exportLeadFields(ld) {
    const f = { status: 'open' };
    if (ld.d) f.desc = String(ld.d);
    if (ld.w != null && isFinite(ld.w)) f.w = +(+ld.w).toFixed(2);
    if (ld.h != null && isFinite(ld.h)) f.h = +(+ld.h).toFixed(2);
    if (ld.t) f.found = String(ld.t);
    return f;
  }
  function leadsAt(cid, name) {
    const out = [], seen = new Set(), target = FL.T.station(cid, name);
    partsOf(cid).forEach(({ imp }) => (imp.parsed.leads || []).forEach(ld => {
      if (ld.station !== name || ld.done) return;
      const id = exportLeadId(cid, ld), rec = pj.P.leads[id];
      if (seen.has(id)) return;
      seen.add(id);
      if (rec && rec.deleted) return;
      out.push({ id, rec, ld, fields: rec ? rec.fields : exportLeadFields(ld), active: rec ? FL.leadActive(rec) : true });
    }));
    Object.values(pj.P.leads).forEach(L => {
      if (L.target !== target || seen.has(L.id) || L.deleted) return;
      out.push({ id: L.id, rec: L, ld: null, fields: L.fields, active: FL.leadActive(L) });
    });
    return out;
  }
  // Every lead of the project: project records plus export leads not yet adopted.
  function allLeads() {
    const out = [], seen = new Set();
    Object.values(pj.P.leads).forEach(L => { if (!L.deleted) { seen.add(L.id); out.push({ id: L.id, rec: L, fields: L.fields, active: FL.leadActive(L), target: L.target }); } });
    FL.liveCaves(pj.P).forEach(c => partsOf(c.id).forEach(({ imp, codes }) => (imp.parsed.leads || []).forEach(ld => {
      if (ld.done) return;
      const s = stationsOf(imp, ld.station)[0];
      if (s && !codes.has(s.survey || '')) return;
      const id = exportLeadId(c.id, ld);
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ id, rec: null, ld, fields: exportLeadFields(ld), active: true, target: FL.T.station(c.id, ld.station) });
    })));
    return out;
  }
  function leadSummary(f) {
    return [FL.statusLabel(f.status || 'open'), ...(f.types || []).slice(0, 2), f.priority ? 'P' + f.priority : '',
            f.w || f.h ? `${f.w ?? '?'}×${f.h ?? '?'} m` : '', f.confidence != null ? Math.round(f.confidence * 100) + '% sure' : ''].filter(Boolean).join(' · ');
  }
  function targetLabel(t) {
    const p = FL.parseTarget(t);
    switch (p.kind) {
      case 'project': return p.pid === pj.pid ? (pj.P.name || 'this project') : 'another project';
      case 'cave': return caveName(p.cave);
      case 'survey': return `survey ${p.code} · ${caveName(p.cave)}`;
      case 'station': return `${p.name} · ${caveName(p.cave)}`;
      case 'area': return `stations ${p.spec.replace(/~/g, '–')} · ${caveName(p.cave)}`;
      case 'segment': { const g = pj.P.segments[p.seg]; return `segment ${g ? g.name || g.id : p.seg} · ${caveName(p.cave)}`; }
      case 'lead': { const L = pj.P.leads[p.lead]; return 'lead' + (L && L.target ? ' at ' + targetLabel(L.target) : ''); }
      case 'doc': return '“' + ((pj.D.docs[p.doc] && pj.D.docs[p.doc].title) || 'document') + '”';
      case 'feature': { const f = pj.P.features[p.feature]; return '“' + ((f && f.name) || 'surface point') + '” (surface)'; }
      default: return t;
    }
  }

  // ── Notes ──────────────────────────────────────────────────────────────────
  async function editNote(target, noteId) {
    const cur = noteId ? pj.P.notes[noteId] : null;
    const r = await dialog({ title: (cur ? 'Note on ' : 'New note on ') + targetLabel(target), wide: true,
      html: cur ? `${esc(cur.created.who)}, ${when(cur.created.t)}` + (cur.history.length > 1 ? ` · last edit ${esc(cur.who)}, ${when(cur.t)}` : '') +
        (cur.conflict ? '<div class="pj-conflict">⚠ Edited on two devices:<br>' + cur.conflict.map(c => `<b>${esc(c.who)}</b>: ${esc(c.text)}`).join('<br>') + '<br>Saving keeps what is in the box.</div>' : '') : '',
      textarea: { value: cur ? cur.text : '', placeholder: 'What’s here?' },
      buttons: [{ label: 'Cancel', value: null }, ...(cur ? [{ label: 'Remove', value: 'rm', danger: true }] : []), { label: 'Save', value: 'ok', primary: true }] });
    if (!r) return;
    const text = r.button === 'rm' ? '' : r.value.trim();
    if (!cur && !text) return;
    if (cur && cur.text === text && !cur.conflict) return;
    await record('note.set', { note: cur ? cur.id : FL.uid(12), target, text, prev: cur ? cur.text : '', base: cur ? cur.heads : [] });
  }
  function noteEl(n) {
    const d = el('div', 'pj-item' + (n.conflict ? ' conflict' : ''));
    d.appendChild(el('div', 'pj-item-t', n.text || '(removed on one device)'));
    d.appendChild(el('div', 'pj-sub', `${n.who || '?'} · ${when(n.t)}${n.history.length > 1 ? ' · edited' : ''}${n.conflict ? ' · ⚠ edited on two devices' : ''}`));
    d.addEventListener('click', () => editNote(n.target, n.id));
    return d;
  }

  // ── Leads ──────────────────────────────────────────────────────────────────
  async function editLead(cid, name, item) {
    if (!(await ensureAuthor())) return;
    const lists = FL.leadLists(pj.P);
    const rec = item && item.rec;
    const cur = Object.assign({}, item ? item.fields : { status: 'open' });
    const vals = JSON.parse(JSON.stringify(cur));
    const form = el('div', 'pj-form');
    const conflicts = (rec && rec.conflicts) || {};
    FL.LEAD_FIELDS.forEach(fd => {
      if (fd.k === 'tie' && !vals.tie) return;           // only when there is one (archive leads)
      const row = el('div', 'pj-f');
      row.appendChild(el('div', 'pj-f-l', fd.label));
      const choices = fd.choices ? fd.choices.map(c => [c, c]) : fd.list ? lists[fd.list] : null;
      if (fd.kind === 'one' || fd.kind === 'many') {
        const box = el('div', 'pj-chips');
        const paint = () => box.querySelectorAll('button[data-v]').forEach(b => {
          const v = b.dataset.v;
          b.classList.toggle('on', fd.kind === 'one' ? vals[fd.k] === v : (vals[fd.k] || []).includes(v));
        });
        const chip = (v, label) => {
          const b = btn(label, () => {
            if (fd.kind === 'one') vals[fd.k] = vals[fd.k] === v ? undefined : v;
            else { const a = new Set(vals[fd.k] || []); a.has(v) ? a.delete(v) : a.add(v); vals[fd.k] = [...a]; }
            paint();
          }, 'chip');
          b.dataset.v = v;
          return b;
        };
        choices.forEach(([v, label]) => box.appendChild(chip(v, label)));
        if (fd.list && fd.list !== 'status') {
          const add = btn('＋', async () => {
            const r = await dialog({ title: 'Add to “' + fd.label + '”', text: 'Added for everyone in this project.', input: { value: '' },
              buttons: [{ label: 'Cancel', value: null }, { label: 'Add', value: 'ok', primary: true }] });
            if (!r || !r.value.trim()) return;
            const v = r.value.trim().slice(0, 40);
            await record('project.lists', { add: { [fd.list]: [v] } });
            const b = chip(v, v); box.insertBefore(b, add); b.click();
          }, 'chip');
          add.title = 'Add a choice to this project’s list';
          box.appendChild(add);
        }
        paint();
        row.appendChild(box);
      } else {
        const inp = el(fd.kind === 'area' ? 'textarea' : 'input', 'pj-input');
        if (fd.kind === 'area') inp.rows = 3;
        inp.value = vals[fd.k] != null ? vals[fd.k] : '';
        inp.addEventListener('input', () => {
          const t = inp.value.trim();
          vals[fd.k] = fd.kind === 'num' ? (t === '' ? undefined : (isFinite(Number(t.replace(',', '.'))) ? Number(t.replace(',', '.')) : t)) : (t || undefined);
        });
        row.appendChild(inp);
      }
      if (conflicts[fd.k]) row.appendChild(el('div', 'pj-conflict', '⚠ two devices: ' + conflicts[fd.k].map(c => `${Array.isArray(c.v) ? c.v.join(', ') : c.v} (${c.who})`).join(' / ')));
      form.appendChild(row);
    });
    if (rec && rec.sightings && rec.sightings.length) {
      const s = el('div', 'pj-f');
      s.appendChild(el('div', 'pj-f-l', `Seen ${rec.sightings.length} time(s)`));
      rec.sightings.forEach(x => {
        const d = docByPage(x.h) || pj.D.docs[x.doc];
        s.appendChild(btn(`${x.date || when(x.t)} · ${x.who || ''}${d ? ' · ' + (d.title || 'page') : ''}`, () => { if (d) docOpen(d.id, Math.max(0, d.pages.findIndex(p => p.h === x.h))); }, 'link'));
      });
      form.appendChild(s);
    }
    if (rec) form.appendChild(btn(`History (${rec.history.length})`, () => history(rec.history, 'Lead history')));
    const r = await dialog({ title: (rec || item ? 'Lead at ' : 'New lead at ') + name + (cid ? ' · ' + caveName(cid) : ''), body: form, wide: true,
      text: rec ? `Found ${rec.created.who}, ${when(rec.created.t)} · last change ${rec.updated.who}, ${when(rec.updated.t)}${rec.source ? ' · from ' + rec.source : ''}` : (item && item.ld ? 'From the survey file; saving makes it a project lead.' : null),
      buttons: [{ label: 'Cancel', value: null }, ...(rec ? [{ label: 'Remove', value: 'rm', danger: true }] : []), { label: 'Save', value: 'ok', primary: true }] });
    if (!r) return;
    const id = (item && item.id) || FL.uid(12);
    if (r.button === 'rm') { await record('lead.del', { lead: id, base: rec ? rec.heads : [] }); return; }
    const changed = {}, prev = {};
    const norm = v => (v === undefined || v === '' || (Array.isArray(v) && !v.length)) ? null : v;
    FL.LEAD_FIELDS.forEach(fd => {
      const a = vals[fd.k], b = cur[fd.k];
      if (JSON.stringify(norm(a)) !== JSON.stringify(norm(b)) || (!rec && norm(a) != null)) { changed[fd.k] = norm(a); prev[fd.k] = norm(b); }
    });
    if (!Object.keys(changed).length && rec && !rec.conflicts) return;
    if (rec && rec.conflicts) Object.keys(rec.conflicts).forEach(k => { if (!(k in changed)) changed[k] = vals[k] == null ? null : vals[k]; });
    const data = { lead: id, fields: changed, base: rec ? rec.heads : [] };
    if (!rec) { data.target = (item && item.target) || FL.T.station(cid, name); if (item && item.ld) data.source = 'export'; }
    else data.prev = prev;
    await record('lead.set', data);
  }
  function leadEl(cid, name, x) {
    const d = el('div', 'pj-item' + (x.active ? '' : ' closed') + (x.rec && x.rec.conflicts ? ' conflict' : ''));
    d.appendChild(el('div', 'pj-item-t', '❓ ' + leadSummary(x.fields)));
    if (x.fields.desc) d.appendChild(el('div', 'pj-sub', x.fields.desc));
    if (x.fields.tie) d.appendChild(el('div', 'pj-sub', '📍 ' + x.fields.tie));
    if (x.rec) d.appendChild(el('div', 'pj-sub', `${x.rec.updated.who} · ${when(x.rec.updated.t)}${x.rec.sightings ? ' · seen ' + x.rec.sightings.length + '×' : ''}`));
    else d.appendChild(el('div', 'pj-sub', 'from the survey file'));
    d.addEventListener('click', () => editLead(cid, name, x));
    return d;
  }

  // ── Documents ──────────────────────────────────────────────────────────────
  const docByPage = h => h && Object.values(pj.D.docs).find(d => !d.deleted && d.pages.some(p => p.h === h));
  function docSub(d) {
    const tags = d.tagList.filter(t => t !== FL.T.project(pj.pid)).map(targetLabel);
    return `${d.pages.length} page${d.pages.length === 1 ? '' : 's'}${d.kind ? ' · ' + (FL.DOC_KIND_LABELS[d.kind] || d.kind) : ''}${d.date ? ' · ' + d.date : ''} · ` +
      (tags.length ? tags.slice(0, 3).join(', ') + (tags.length > 3 ? ` +${tags.length - 3}` : '') : 'inbox') +
      (d.has_coordinates ? ' · 📌 shows coordinates' : '') + (d.conflicts ? ' · ⚠ edited on two devices' : '');
  }
  function docEl(d, target) {
    const r = el('div', 'pj-item pj-doc');
    const at = target ? FL.pageFor(d, target) : 0;
    const p = d.pages[at];
    if (p && p.ext !== 'pdf') { const im = el('img', 'pj-thumb'); im.loading = 'lazy'; im.src = blobUrl(p); if (p.rot) im.style.transform = `rotate(${p.rot}deg)`; r.appendChild(im); }
    else r.appendChild(el('div', 'pj-thumb pj-thumb-x', p ? 'PDF' : '—'));
    const t = el('div'); t.appendChild(el('div', 'pj-item-t', d.title || 'Untitled')); t.appendChild(el('div', 'pj-sub', docSub(d)));
    r.appendChild(t);
    r.addEventListener('click', () => docOpen(d.id, at));
    return r;
  }
  function fitCanvas(w, h) {
    const m = Math.max(w, h), k = m > PAGE_PX ? PAGE_PX / m : 1;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * k)); cv.height = Math.max(1, Math.round(h * k));
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    return cv;
  }
  async function storeBytes(buf, ext) { return api('blob?ext=' + ext + (pj.pid ? '&project=' + encodeURIComponent(pj.pid) : ''), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf }); }
  async function storeCanvas(cv, name) {
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
    const o = await storeBytes(await blob.arrayBuffer(), 'jpg');
    return { h: o.h, ext: 'jpg', w: cv.width, ht: cv.height, name };
  }
  let _pdfjs = null;
  function loadPdfJs() {
    if (_pdfjs) return _pdfjs;
    _pdfjs = new Promise((res, rej) => {
      if (window.pdfjsLib) return res(window.pdfjsLib);
      const s = document.createElement('script');
      s.src = PDFJS + 'pdf.min.js';
      // A worker can't load from another origin: fetch it and start it from a blob.
      s.onload = () => fetch(PDFJS + 'pdf.worker.min.js').then(r => r.text()).then(t => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([t], { type: 'application/javascript' }));
        res(window.pdfjsLib);
      }).catch(e => { _pdfjs = null; rej(new Error('PDF reader could not load (offline?)')); });
      s.onerror = () => { _pdfjs = null; rej(new Error('PDF reader could not load (offline?)')); };
      document.head.appendChild(s);
    });
    return _pdfjs;
  }
  /** Files → pages: photos and scans ≤ 2400 px JPEG, TIFF and PDF one page per sheet. */
  async function filesToPages(files, progress) {
    const pages = [], failed = [];
    for (const f of files) {
      try {
        progress && progress(f.name);
        if (/\.tiff?$/i.test(f.name) || f.type === 'image/tiff') {
          const buf = await f.arrayBuffer(), ifds = UTIF.decode(buf);
          const subs = ifds.filter(ifd => ifd.width || ifd.t256);
          for (let i = 0; i < subs.length; i++) {
            const ifd = subs[i];
            UTIF.decodeImage(buf, ifd);
            const w = ifd.width, h = ifd.height;
            if (!w || !h) continue;
            const rgba = UTIF.toRGBA8(ifd);
            const src = document.createElement('canvas'); src.width = w; src.height = h;
            src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
            const cv = fitCanvas(w, h); cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
            pages.push(await storeCanvas(cv, f.name + (subs.length > 1 ? ` (${i + 1})` : '')));
          }
        } else if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
          const buf = await f.arrayBuffer();
          let lib = null;
          try { lib = await loadPdfJs(); } catch (e) { toast(e.message + ' — keeping the PDF as one page'); }
          if (!lib) { const o = await storeBytes(buf, 'pdf'); pages.push({ h: o.h, ext: 'pdf', name: f.name }); continue; }
          const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
          for (let i = 1; i <= pdf.numPages; i++) {
            const pg = await pdf.getPage(i);
            const v1 = pg.getViewport({ scale: 1 });
            const vp = pg.getViewport({ scale: PAGE_PX / Math.max(v1.width, v1.height) });
            const cv = fitCanvas(vp.width, vp.height);
            await pg.render({ canvasContext: cv.getContext('2d'), viewport: pg.getViewport({ scale: vp.scale * cv.width / vp.width }) }).promise;
            pages.push(await storeCanvas(cv, `${f.name} (${i})`));
          }
        } else if (/^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|heic)$/i.test(f.name)) {
          const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
          const cv = fitCanvas(bmp.width, bmp.height); cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
          pages.push(await storeCanvas(cv, f.name));
        } else failed.push(f.name + ' (not an image, TIFF or PDF)');
      } catch (e) { console.warn('[project] page', f.name, e); failed.push(f.name); }
    }
    return { pages, failed };
  }
  function pickFiles(accept, multiple = true) {
    return new Promise(resolve => {
      const inp = el('input'); inp.type = 'file'; inp.multiple = multiple; inp.accept = accept; inp.style.display = 'none';
      inp.addEventListener('change', () => { resolve(Array.from(inp.files || [])); inp.remove(); });
      document.body.appendChild(inp); inp.click();
    });
  }
  /** Add files as a new document (tagged `tags`, else the project = inbox) or into `docId`. */
  async function addPages({ tags, docId, files } = {}) {
    if (!pj.pid) { toast('Choose or create a project first'); return; }
    if (!(await ensureAuthor())) return;
    files = files || await pickFiles('image/*,.tif,.tiff,application/pdf');
    if (!files.length) return;
    toast(`Adding ${files.length} file(s)…`);
    const { pages, failed } = await filesToPages(files, n => toast('Adding ' + n));
    failed.forEach(n => toast('Could not read ' + n));
    if (!pages.length) return;
    if (docId && pj.D.docs[docId]) {
      await record('doc.pages', { doc: docId, add: pages }, 'docs');
      toast(`Added ${pages.length} page(s)`);
      return;
    }
    const strip = n => n.replace(/\.[^.]*$/, '').replace(/ \(\d+\)$/, '');
    const title = pages.length === 1 || new Set(pages.map(p => strip(p.name))).size === 1 ? strip(pages[0].name) : `${strip(pages[0].name)} +${pages.length - 1}`;
    const id = FL.uid(12);
    await record('doc.add', { doc: id, title: title.slice(0, 80), kind: '', date: new Date().toISOString().slice(0, 10), pages,
      tags: tags && tags.length ? tags : [FL.T.project(pj.pid)] }, 'docs');
    toast(`New document, ${pages.length} page(s)`);
    docOpen(id, 0);
  }

  // Gallery
  function docOpen(id, i) {
    pj.gallery = { doc: id, i: i || 0 };
    let g = $('pj-gallery');
    if (!g) {
      g = el('div'); g.id = 'pj-gallery';
      g.innerHTML = '<div class="pjg-bar"><div class="pjg-title"></div><div class="pjg-btns"></div></div><div class="pjg-stage"><button class="pjg-prev">‹</button><div class="pjg-view"></div><button class="pjg-next">›</button></div><div class="pjg-tags"></div>';
      document.body.appendChild(g);
      g.querySelector('.pjg-prev').addEventListener('click', () => galleryShow(pj.gallery.i - 1));
      g.querySelector('.pjg-next').addEventListener('click', () => galleryShow(pj.gallery.i + 1));
      document.addEventListener('keydown', e => {
        if (!pj.gallery || document.querySelector('.pj-modal')) return;
        if (e.key === 'Escape') galleryClose();
        if (e.key === 'ArrowLeft') galleryShow(pj.gallery.i - 1);
        if (e.key === 'ArrowRight') galleryShow(pj.gallery.i + 1);
      });
    }
    g.classList.add('open');
    galleryShow(pj.gallery.i);
  }
  function galleryClose() { pj.gallery = null; const g = $('pj-gallery'); if (g) g.classList.remove('open'); }
  function galleryShow(i) {
    const g = $('pj-gallery'), G = pj.gallery;
    if (!g || !G) return;
    const d = pj.D.docs[G.doc];
    if (!d || d.deleted) { galleryClose(); return; }
    const n = d.pages.length;
    G.i = n ? Math.max(0, Math.min(n - 1, i)) : 0;
    const p = d.pages[G.i];
    g.querySelector('.pjg-title').innerHTML = `<b>${esc(d.title || 'Untitled')}</b> <span>${n ? (G.i + 1) + ' / ' + n : 'no pages'}${p && p.name ? ' · ' + esc(p.name) : ''}${p && p.kind ? ' · ' + esc(FL.DOC_KIND_LABELS[p.kind] || p.kind) : ''}</span>` +
      (p && p.ext !== 'pdf' && d.file ? ` <span class="pjg-render" title="FLEX shows page images made from the original for quick viewing; the original file is unchanged in the project folder: ${esc(d.file.path)}">page image for viewing</span>` : '');
    const bb = g.querySelector('.pjg-btns'); bb.textContent = '';
    if (d.file) { const a = el('a', 'pj-btn'); a.textContent = '📄 Original'; a.href = API + 'blob/' + d.file.h + '.' + d.file.ext; a.target = '_blank'; a.rel = 'noopener'; a.title = d.file.path + (d.file.ext === 'tif' ? ' (TIFF: opens in your image viewer)' : ''); bb.appendChild(a); }
    if (p && p.ext !== 'pdf') {
      bb.appendChild(btn('⟲', () => record('doc.rotate', { doc: d.id, h: p.h, rot: ((p.rot || 0) + 270) % 360, prev: p.rot || 0 }, 'docs')));
      bb.appendChild(btn('⟳', () => record('doc.rotate', { doc: d.id, h: p.h, rot: ((p.rot || 0) + 90) % 360, prev: p.rot || 0 }, 'docs')));
    }
    bb.appendChild(btn('🏷 Tags', () => editTags(d.id)));
    bb.appendChild(btn('✏️ Details', () => editDoc(d.id)));
    bb.appendChild(btn('＋ Pages', () => addPages({ docId: d.id })));
    bb.appendChild(btn('📝 Note', () => editNote(FL.T.doc(d.id), (FL.notesOn(pj.P, FL.T.doc(d.id))[0] || {}).id)));
    bb.appendChild(btn('⋯', () => docMenu(d.id)));
    bb.appendChild(btn('✕', galleryClose));
    const v = g.querySelector('.pjg-view'); v.textContent = '';
    if (p && p.ext === 'pdf') { const f = el('iframe', 'pjg-pdf'); f.src = blobUrl(p); v.appendChild(f); }
    else if (p) {
      const im = el('img', 'pjg-img'); im.src = blobUrl(p);
      const rot = p.rot || 0;
      im.style.transform = `rotate(${rot}deg)`;
      if (rot % 180) { im.style.maxWidth = 'calc(100vh - 140px)'; im.style.maxHeight = 'calc(100vw - 120px)'; }
      v.appendChild(im);
    }
    const tg = g.querySelector('.pjg-tags');
    const notes = FL.notesOn(pj.P, FL.T.doc(d.id));
    tg.textContent = docSub(d) + (d.desc ? ' — ' + d.desc : '') + (notes.length ? ` · 📝 ${notes[0].text}` : '');
    g.querySelector('.pjg-prev').disabled = G.i <= 0;
    g.querySelector('.pjg-next').disabled = G.i >= n - 1;
  }
  async function docMenu(docId) {
    const d = pj.D.docs[docId];
    const G = pj.gallery;
    const r = await choose(d.title || 'Document', `${d.pages.length} page(s) · added by ${(d.created && d.created.who) || '?'}, ${when(d.created && d.created.t)}`, [
      ...(d.pages.length ? [{ label: '✏️ This page: kind and date', value: 'page' }, { label: '🗑 Remove this page', value: 'drop' }] : []),
      { label: '📜 History', value: 'hist' }, { label: '🗑 Delete the document', value: 'del' }]);
    if (!r) return;
    const pg = d.pages[G ? G.i : 0];
    if (r === 'hist') history(d.history, 'Document history', 'docs');
    if (r === 'drop') await record('doc.droppage', { doc: docId, h: pg.h, page: pg, at: G ? G.i : 0 }, 'docs');
    if (r === 'del') {
      const ok = await dialog({ title: `Delete “${d.title}”?`, text: 'It stays in the history and can be restored from it.', buttons: [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'rm', danger: true }] });
      if (ok) { await record('doc.del', { doc: docId }, 'docs'); galleryClose(); }
    }
    if (r === 'page') {
      const form = el('div', 'pj-form');
      const k = kindInput(pg.kind || ''), dt = el('input', 'pj-input'); dt.value = pg.date || ''; dt.placeholder = '1994-07-16, 1994, 1970s…';
      form.append(labelled('Kind of this page', k), labelled('Date', dt));
      const r2 = await dialog({ title: 'Page ' + ((G ? G.i : 0) + 1), body: form, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }] });
      if (!r2) return;
      const fields = {};
      if (k.value.trim() !== (pg.kind || '')) fields.kind = k.value.trim();
      if (dt.value.trim() !== (pg.date || '')) fields.date = dt.value.trim();
      if (Object.keys(fields).length) await record('doc.page', { doc: docId, h: pg.h, fields }, 'docs');
    }
  }
  function labelled(label, input) { const r = el('div', 'pj-f'); r.appendChild(el('div', 'pj-f-l', label)); r.appendChild(input); return r; }
  function kindInput(v) {
    const i = el('input', 'pj-input'); i.value = v; i.placeholder = 'sketch-plan, shot-table, trip-report…';
    let dl = $('pj-kinds');
    if (!dl) { dl = el('datalist'); dl.id = 'pj-kinds'; FL.DOC_KINDS.forEach(k => { const o = el('option'); o.value = k; o.label = FL.DOC_KIND_LABELS[k]; dl.appendChild(o); }); document.body.appendChild(dl); }
    i.setAttribute('list', 'pj-kinds');
    return i;
  }
  async function editDoc(docId) {
    const d = pj.D.docs[docId];
    const form = el('div', 'pj-form');
    const ti = el('input', 'pj-input'); ti.value = d.title || '';
    const ki = kindInput(d.kind || '');
    const da = el('input', 'pj-input'); da.value = d.date || ''; da.placeholder = '1994-07-16, 1994, 1970s, c. 1975';
    const de = el('textarea', 'pj-input'); de.rows = 3; de.value = d.desc || '';
    const co = el('label', 'pj-check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!d.has_coordinates; co.append(cb, ' Shows coordinates');
    form.append(labelled('Title', ti), labelled('Kind', ki), labelled('Date (can be approximate)', da), labelled('Description', de), co);
    if (d.conflicts) form.appendChild(el('div', 'pj-conflict', '⚠ Edited on two devices: ' + Object.entries(d.conflicts).map(([k, v]) => k + ': ' + v.map(x => `${x.v} (${x.who})`).join(' / ')).join('; ')));
    const r = await dialog({ title: 'Document', body: form, wide: true, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }] });
    if (!r) return;
    const now = { title: ti.value.trim(), kind: ki.value.trim(), date: da.value.trim(), desc: de.value.trim(), has_coordinates: cb.checked };
    const fields = {}, prev = {};
    Object.keys(now).forEach(k => { const old = k === 'has_coordinates' ? !!d[k] : (d[k] || ''); if (now[k] !== old) { fields[k] = now[k]; prev[k] = old; } });
    if (Object.keys(fields).length || d.conflicts) await record('doc.set', { doc: docId, fields, prev }, 'docs');
  }
  // What a document can be tagged to: the project, its caves, their surveys and stations (loaded files), leads.
  function tagChoices() {
    const out = [{ label: 'Project · ' + (pj.P.name || 'this project'), target: FL.T.project(pj.pid) }];
    FL.liveCaves(pj.P).forEach(c => {
      out.push({ label: 'Cave · ' + c.name, target: FL.T.cave(c.id) });
      const svs = new Map(), sts = new Set();
      partsOf(c.id).forEach(({ imp, codes }) => {
        (imp.parsed.surveys || []).forEach(s => { if (codes.has(s.code) && !svs.has(s.code)) svs.set(s.code, s.desc); });
        (imp.parsed.stations || []).forEach(s => { if (s.name && codes.has(s.survey || '')) sts.add(s.name); });
      });
      svs.forEach((desc, code) => out.push({ label: `Survey ${code}${desc ? ' — ' + desc : ''} · ${c.name}`, target: FL.T.survey(c.id, code) }));
      [...sts].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach(n => out.push({ label: `Station ${n} · ${c.name}`, target: FL.T.station(c.id, n) }));
    });
    Object.values(pj.P.leads).forEach(L => { if (!L.deleted) out.push({ label: 'Lead · ' + targetLabel(L.target) + (L.fields.desc ? ' — ' + L.fields.desc.slice(0, 40) : ''), target: FL.T.lead(L.id) }); });
    return out;
  }
  async function editTags(docId) {
    if (!(await ensureAuthor())) return;
    const d = pj.D.docs[docId];
    const want = new Set(d.tagList);
    const body = el('div', 'pj-form');
    const chips = el('div', 'pj-chips');
    const all = tagChoices();
    const paintChips = () => {
      chips.textContent = '';
      [...want].forEach(t => { const b = btn(targetLabel(t) + ' ✕', () => { want.delete(t); paintChips(); }, 'chip on'); chips.appendChild(b); });
      if (!want.size) chips.appendChild(el('div', 'pj-note', 'No tags: the document is in no project.'));
    };
    const q = el('input', 'pj-input'); q.placeholder = 'Find a cave, survey, station or lead…';
    const list = el('div', 'pj-list pj-taglist');
    const paintList = () => {
      list.textContent = '';
      const s = q.value.trim().toLowerCase();
      all.filter(c => !want.has(c.target) && (!s || c.label.toLowerCase().includes(s))).slice(0, 40)
        .forEach(c => list.appendChild(btn('＋ ' + c.label, () => { want.add(c.target); paintChips(); paintList(); }, 'row')));
    };
    q.addEventListener('input', paintList);
    const area = btn('＋ Area: a set of stations…', async () => {
      const caves = FL.liveCaves(pj.P);
      if (!caves.length) return;
      const cid = caves.length === 1 ? caves[0].id : await choose('Area in which cave?', null, caves.map(c => ({ label: c.name, value: c.id })));
      if (!cid) return;
      const r = await dialog({ title: 'Stations this page covers', text: 'Names and ranges, comma separated: A10~A22 is A10 to A22 (same prefix). For pages that cover more than one station but not a whole survey.',
        input: { value: '', placeholder: 'A10~A22, B3' }, buttons: [{ label: 'Cancel', value: null }, { label: 'Add', value: 'ok', primary: true }] });
      if (r && r.value.trim()) { want.add(FL.T.area(cid, r.value.trim().replace(/\s*,\s*/g, ',').replace(/\s*~\s*/g, '~'))); paintChips(); }
    });
    body.append(el('div', 'pj-f-l', 'Tagged to'), chips, q, list, area);
    paintChips(); paintList();
    const r = await dialog({ title: 'Tags · ' + (d.title || 'document'), body, wide: true, buttons: [{ label: 'Cancel', value: null }, { label: 'Done', value: 'ok', primary: true }] });
    if (!r) return;
    for (const t of want) if (!d.tags[t]) await record('doc.tag', { doc: docId, target: t }, 'docs');
    for (const t of d.tagList) if (!want.has(t)) await record('doc.untag', { doc: docId, target: t }, 'docs');
  }

  // ── History and undo ───────────────────────────────────────────────────────
  function describe(e) {
    const pre = e.proposed ? `Suggested by ${e.proposed.by || e.who || '?'}${e.proposed.confidence != null ? ' (' + Math.round(e.proposed.confidence * 100) + '%)' : ''}: ` : '';
    const doc = id => '“' + ((pj.D.docs[id] && pj.D.docs[id].title) || 'document') + '”';
    const at = (rec, id) => { const r = rec[id]; return r && r.target ? targetLabel(r.target) : e.target ? targetLabel(e.target) : '?'; };
    const n = [].concat(e.ref != null ? [e.ref] : [], e.refs || []).length;
    const sv = id => (pj.P.surveys[id] && pj.P.surveys[id].name) || 'survey';
    const m = {
      'project.set': () => `Project “${e.name || ''}”`,
      'project.lists': () => 'Added to lists: ' + Object.values(e.add || {}).flat().join(', '),
      'cave.set': () => e.removed ? `Removed cave ${caveName(e.cave)}` : `Cave “${e.name || caveName(e.cave)}”${e.sources ? ' (made of ' + e.sources.map(s => s.file + (s.surveys && s.surveys.length ? ' ' + s.surveys.join(',') : '')).join('; ') + ')' : ''}`,
      'cave.alias': () => `“${e.alias}” is ${caveName(e.cave)}`,
      'cave.unalias': () => `“${e.alias}” is no longer ${caveName(e.cave)}`,
      'note.set': () => (e.text ? (e.prev ? 'Edited note at ' : 'Note at ') : 'Removed note at ') + at(pj.P.notes, e.note) + (e.text ? ': ' + e.text.slice(0, 60) : ''),
      'lead.set': () => (e.prev ? 'Lead at ' : 'New lead at ') + at(pj.P.leads, e.lead) + (e.proposed && e.fields && e.fields.desc ? ': ' + String(e.fields.desc).slice(0, 80)
        : e.fields ? ': ' + Object.keys(e.fields).map(k => k === 'status' ? FL.statusLabel(e.fields.status) : k).join(', ') : '') + (e.sighting ? ' (sighting)' : ''),
      'lead.del': () => 'Removed lead at ' + at(pj.P.leads, e.lead),
      'lead.restore': () => 'Restored lead at ' + at(pj.P.leads, e.lead),
      'doc.add': () => `Document ${doc(e.doc)}, ${(e.pages || []).length} page(s)`,
      'doc.pages': () => `Added ${(e.add || []).length} page(s) to ${doc(e.doc)}`,
      'doc.droppage': () => `Removed a page from ${doc(e.doc)}`,
      'doc.rotate': () => `Turned a page of ${doc(e.doc)}`,
      'doc.tag': () => `Tagged ${doc(e.doc)}: ${targetLabel(e.target)}`,
      'doc.untag': () => `Untagged ${doc(e.doc)}: ${targetLabel(e.target)}`,
      'doc.set': () => `Edited ${doc(e.doc)} (${Object.keys(e.fields || {}).join(', ')})`,
      'doc.page': () => `Page details in ${doc(e.doc)}`,
      'doc.del': () => `Deleted ${doc(e.doc)}`,
      'doc.restore': () => `Restored ${doc(e.doc)}`,
      'survey.add': () => `New field survey “${e.survey && e.survey.name}”`,
      'survey.set': () => `Changed field survey “${sv(e.id)}”`,
      'survey.delete': () => `Deleted field survey “${(e.prev && e.prev.name) || ''}”`,
      'survey.restore': () => `Restored field survey “${e.survey && e.survey.name}”`,
      'shot.add': () => `Shot ${e.shot && e.shot.from} → ${e.shot && e.shot.to} in “${sv(e.sid)}”`,
      'shot.set': () => `Edited shot in “${sv(e.sid)}”`,
      'shot.delete': () => `Deleted shot in “${sv(e.sid)}”`,
      'cave.update': () => `Updated ${caveName(e.cave)} from ${e.file || 'a file'} on a phone (approximate)`,
      'cave.revert': () => `Put ${caveName(e.cave)} back as exported`,
      'cavefile.set': () => e.removed ? `Removed survey file ${e.file} from the project` : e.h ? `Survey file ${e.file}${e.place ? ' and where it is placed' : ''}` : `Placed ${e.file}${e.place && e.place.station ? ' at station ' + e.place.station : ''}`,
      'layer.set': () => e.removed ? `Removed ${(pj.P.layers[e.layer] || {}).name || 'a layer'} from the project` : `${{ pointcloud: 'Point cloud', caltopo: 'CalTopo map', file: 'Data file' }[e.kind || (pj.P.layers[e.layer] || {}).kind] || 'Layer'} ${e.name || (pj.P.layers[e.layer] || {}).name || ''}`,
      'survey.version': () => e.raw && e.raw.tie ? `Survey ${e.code || ''} missing from the file: ${(e.raw.shots || []).length} shot(s) from ${e.raw.tie}${e.note ? ' — ' + e.note : ''}`
        : `New version of survey ${e.code} (${e.version || 'transcribed'})`,
      'segment.set': () => `Segment “${e.name || (pj.P.segments[e.seg] || {}).name || e.seg}” (${(e.shots || []).length} shots)`,
      'segment.del': () => `Removed ${[].concat(e.seg != null ? [e.seg] : [], e.segs || []).length} segment(s)`,
      accept: () => `Accepted ${n} suggestion(s)${e.note ? ': ' + e.note : ''}`,
      reject: () => `Turned down ${n} suggestion(s)${e.why ? ': ' + e.why : ''}`,
    };
    return pre + (m[e.op] ? m[e.op]() : e.op);
  }
  function inverse(e) {
    if (e.proposed) return null;
    switch (e.op) {
      case 'note.set': return { op: 'note.set', note: e.note, text: e.prev || '', prev: e.text || '', base: [e.id] };
      case 'lead.set': return e.prev ? { op: 'lead.set', lead: e.lead, fields: e.prev, prev: e.fields, base: [e.id] } : null;
      case 'lead.del': return { op: 'lead.restore', lead: e.lead, base: [e.id] };
      case 'lead.restore': return { op: 'lead.del', lead: e.lead, base: [e.id] };
      case 'doc.add': return { op: 'doc.del', doc: e.doc, _w: 'docs' };
      case 'doc.del': return { op: 'doc.restore', doc: e.doc, _w: 'docs' };
      case 'doc.restore': return { op: 'doc.del', doc: e.doc, _w: 'docs' };
      case 'doc.tag': return { op: 'doc.untag', doc: e.doc, target: e.target, _w: 'docs' };
      case 'doc.untag': return { op: 'doc.tag', doc: e.doc, target: e.target, _w: 'docs' };
      case 'doc.rotate': return e.prev != null ? { op: 'doc.rotate', doc: e.doc, h: e.h, rot: e.prev, prev: e.rot, _w: 'docs' } : null;
      case 'doc.set': return e.prev ? { op: 'doc.set', doc: e.doc, fields: e.prev, prev: e.fields, _w: 'docs' } : null;
      case 'doc.droppage': return e.page ? { op: 'doc.pages', doc: e.doc, add: [e.page], at: e.at, _w: 'docs' } : null;
      case 'cave.alias': return { op: 'cave.unalias', cave: e.cave, alias: e.alias };
      case 'cavefile.set': return e.removed ? { op: 'cavefile.set', file: e.file, removed: false } : null;
      case 'layer.set': return e.removed ? { op: 'layer.set', layer: e.layer, removed: false } : null;
      default: return null;
    }
  }
  function history(ids, title, where) {
    const byId = id => pj.P.byId.get(id) || pj.D.byId.get(id);
    const list = (ids ? ids.map(byId).filter(Boolean) : FL.sortEntries(pj.proj.concat(pj.docs.filter(e => {
      const d = pj.D.docs[e.doc]; return d && FL.docInProject(d, pj.P);
    })))).slice().reverse();
    const body = el('div', 'pj-list');
    if (!list.length) body.appendChild(el('div', 'pj-note', 'Nothing yet.'));
    list.slice(0, 400).forEach(e => {
      const r = el('div', 'pj-item');
      r.appendChild(el('div', 'pj-item-t', describe(e)));
      r.appendChild(el('div', 'pj-sub', `${e.who || '?'} · ${when(e.t)}${e.dev === pj.dev ? '' : ' · from ' + e.dev}${e.undoOf ? ' · undo' : ''}`));
      const inv = e.dev === pj.dev && inverse(e);
      if (inv) r.appendChild(btn('Undo', async () => {
        const { op, _w, ...data } = inv;
        await record(op, Object.assign(data, { undoOf: e.id }), _w || (where === 'docs' || /^doc\./.test(e.op) ? 'docs' : null));
        r.remove();
      }, 'small'));
      body.appendChild(r);
    });
    dialog({ title: title || 'History · ' + (pj.P.name || ''), body, wide: true, buttons: [{ label: 'Close', value: null }] });
  }

  // ── Suggestions to review (proposals from the archive or any helper) ───────
  async function review() {
    const body = el('div', 'pj-list');
    const thr = el('input', 'pj-input pj-num'); thr.type = 'number'; thr.min = 0; thr.max = 100; thr.value = 80;
    const top = el('div', 'pj-row');
    top.append('Accept all at or above ', thr, '% ', btn('Accept', async () => {
      const t = Number(thr.value) / 100;
      const q = FL.reviewQueue(pj.P, pj.D).filter(p => (p.confidence || 0) >= t);
      if (!q.length) { toast('None at that level'); return; }
      const proj = q.filter(p => pj.P.proposals[p.id]), docs = q.filter(p => pj.D.proposals[p.id]);
      if (proj.length) await record('accept', { refs: proj.map(p => p.id), base: proj.map(p => p.id).concat(...proj.map(headsFor)) });
      if (docs.length) await record('accept', { refs: docs.map(p => p.id), base: docs.map(p => p.id) }, 'docs');
      paint();
    }, 'primary'));
    const paint = () => {
      body.textContent = '';
      const q = FL.reviewQueue(pj.P, pj.D);
      if (!q.length) body.appendChild(el('div', 'pj-note', 'Nothing to review.'));
      q.slice(0, 300).forEach(p => {
        const r = el('div', 'pj-item');
        r.appendChild(el('div', 'pj-item-t', describe(p.entry)));
        const ev = (p.evidence || []).map(x => x.text).filter(Boolean).join(' · ');
        if (ev) r.appendChild(el('div', 'pj-sub', 'Evidence: ' + ev));
        const pages = (p.evidence || []).map(x => x.page && x.page.h).filter(Boolean);
        const row = el('div', 'pj-row');
        pages.slice(0, 3).forEach(h => { const d = docByPage(h); if (d) row.appendChild(btn('📄 ' + (d.title || 'page'), () => docOpen(d.id, d.pages.findIndex(x => x.h === h)), 'small')); });
        const docs = !!pj.D.proposals[p.id];
        row.appendChild(btn('Accept', async () => { await record('accept', { ref: p.id, base: [p.id].concat(headsFor(p)) }, docs ? 'docs' : null); paint(); }, 'small primary'));
        row.appendChild(btn('Turn down', async () => { await record('reject', { ref: p.id }, docs ? 'docs' : null); paint(); }, 'small'));
        r.appendChild(row);
        body.appendChild(r);
      });
    };
    paint();
    const wrap = el('div'); wrap.append(top, body);
    await dialog({ title: 'Suggestions to review', text: 'Suggestions change nothing until accepted. Accepting is logged under your name.', body: wrap, wide: true, buttons: [{ label: 'Close', value: null }] });
    render();
  }
  // The record heads a proposal builds on when accepted now (so it isn't a conflict).
  function headsFor(p) {
    const e = p.entry;
    if (e.op === 'lead.set' && pj.P.leads[e.lead]) return pj.P.leads[e.lead].heads || [];
    if (e.op === 'note.set' && pj.P.notes[e.note]) return pj.P.notes[e.note].heads || [];
    return [];
  }

  // ── Sync files ─────────────────────────────────────────────────────────────
  // jszip.min.js is in viewer_build/libs once an export has fetched it; else the CDN.
  function zipLib() {
    if (window.JSZip) return Promise.resolve(true);
    return new Promise(res => {
      const sc = document.createElement('script');
      sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      sc.onload = () => res(true);
      sc.onerror = () => { toast('The zip library could not load'); res(false); };
      document.head.appendChild(sc);
    });
  }
  async function makeSync(mode) {
    if (!pj.pid) return;
    if (!(await zipLib())) return;
    const sentRaw = (await api('kv?k=' + encodeURIComponent('sync-sent|' + pj.pid))).v;
    const sel = FL.selectForSync(pj.proj, pj.docs, pj.P, pj.D, sentRaw ? JSON.parse(sentRaw) : null, mode);
    if (!sel.count) { toast('Nothing new since the last sync file'); return; }
    const man = FL.syncManifest(pj.P, pj.dev, who(), sel);
    const z = new JSZip();
    z.file('manifest.json', JSON.stringify(man, null, 1));
    Object.entries(sel.entries).forEach(([sc, list]) => {
      const byDev = {};
      list.forEach(e => (byDev[e.dev] || (byDev[e.dev] = [])).push(JSON.stringify(e)));
      Object.entries(byDev).forEach(([dev, ls]) => z.file(`logs/${sc}/log-${dev}.jsonl`, ls.join('\n') + '\n'));
    });
    let missing = 0;
    for (const n of sel.blobs) {
      const r = await fetch(API + 'blob/' + n);
      if (!r.ok) { missing++; continue; }
      z.file('blobs/' + n, await r.arrayBuffer(), { compression: 'STORE' });
    }
    const blob = await z.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const slug = (pj.P.name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    const name = `FLEX-sync-${slug}-${(who() || pj.dev).replace(/[^A-Za-z0-9]+/g, '')}-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.zip`;
    const a = el('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    await post('kv', { k: 'sync-sent|' + pj.pid, v: JSON.stringify(sel.sent) });
    await post('kv', { k: 'sync-last|' + pj.pid, v: new Date().toISOString() });
    toast(`Sync file: ${sel.count} change(s), ${sel.blobs.length - missing} page(s)` + (missing ? ` (${missing} page(s) missing here)` : ''));
    render();
  }
  async function importSync(file) {
    file = file || (await pickFiles('.zip,application/zip', false))[0];
    if (!file) return;
    if (!(await zipLib())) return;
    try {
      const z = await JSZip.loadAsync(file);
      const mf = z.file('manifest.json');
      if (!mf) throw new Error('not a FLEX sync file (no manifest.json)');
      const man = JSON.parse(await mf.async('string'));
      if (man.format !== 'flex-sync') throw new Error('not a FLEX sync file');
      const scopes = {};
      for (const n of Object.keys(z.files)) {
        const m = /^logs\/([^/]+)\/log-([^/]+)\.jsonl$/.exec(n);
        if (!m || !/^(docs|p-[A-Za-z0-9_-]{1,40})$/.test(m[1])) continue;
        (scopes[m[1]] || (scopes[m[1]] = [])).push(...parseLines(await z.file(n).async('string')));
      }
      // The project first (a new one gets its folder), then its pages, so no entry points at a
      // page that isn't here, then the entries — all into that project's folder.
      const mpid = man.project && /^[A-Za-z0-9_-]{1,40}$/.test(man.project.id || '') ? man.project.id : '';
      const into = mpid ? '&project=' + encodeURIComponent(mpid) : '';
      if (mpid) await post('projects', { id: mpid, name: man.project.name || '' });
      const names = Object.keys(z.files).map(n => /^blobs\/([0-9a-f]{64}\.[a-z]{2,4})$/.exec(n)).filter(Boolean).map(m => m[1]);
      const { missing } = names.length ? await post('blobs-missing?x=1' + into, { names }) : { missing: [] };
      let pages = 0;
      for (const n of missing) {
        const [h, ext] = n.split('.');
        await api(`blob?ext=${ext}&h=${h}${into}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await z.file('blobs/' + n).async('arraybuffer') });
        pages++;
      }
      let added = 0;
      for (const [sc, list] of Object.entries(scopes)) added += (await post('merge?scope=' + sc + into, list)).added;
      const other = man.project && man.project.id && man.project.id !== pj.pid;
      if (!pj.pid && man.project && man.project.id) await setProject(man.project.id); else await loadAll();
      render(); refreshCard(); drawField(); drawLeads();
      dialog({ title: 'Sync file imported', text: `${added} new change(s) and ${pages} new page(s)` + (man.from && man.from.who ? ` from ${man.from.who}` : '') +
        (man.project ? ` for project “${man.project.name || man.project.id}”` : '') + '.' + (other ? ' That isn’t the open project; choose it in 📁 Project to see it.' : '') });
    } catch (e) {
      dialog({ title: 'Sync file not imported', text: e.message || String(e) });
    }
  }

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
      let pos = null, onGround = false;
      if (t.kind === 'station') pos = stationPos(t.cave, t.name);
      else if (t.kind === 'feature') {                  // a lead at a surface point (a dig)
        const f = pj.P.features[t.feature];
        if (f && !f.removed && f.coords && f.coords.length) { pos = Cesium.Cartesian3.fromDegrees(f.coords[0][0], f.coords[0][1], f.coords[0][2] || 0); onGround = true; }
      }
      if (!pos) return;
      const look = icon
        ? { billboard: Object.assign({}, icon, { color: suggested ? Cesium.Color.WHITE.withAlpha(0.45) : Cesium.Color.WHITE, scale: suggested ? 0.75 : 1, disableDepthTestDistance: 5000 },
                                     onGround ? { heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, pixelOffset: new Cesium.Cartesian2(0, -12) } : {}) }
        : { label: { text: '?', font: 'bold 18px sans-serif', fillColor: Cesium.Color.fromCssColorString('#ffeb3b').withAlpha(suggested ? 0.5 : 1),
                     outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -14), disableDepthTestDistance: 5000 } };
      leadSrc.entities.add(Object.assign({
        position: pos,
        name: (suggested ? 'Suggested lead at ' : 'Lead at ') + t.name,
        description: (suggested ? `Suggested by ${esc(by || '?')} — not accepted yet (📁 Project → Suggestions).<br>` : '') + esc(leadSummary(fields)) + (fields.desc ? '<br>' + esc(fields.desc) : ''),
        properties: t.kind === 'feature' ? { isFeatureLead: true, leadId: leadId || '', isProjectLead: true, suggested: !!suggested }
          : { isFieldStation: true, cave: t.cave, stationName: t.name, isProjectLead: true, suggested: !!suggested },
      }, look));
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

  // ── Station card ───────────────────────────────────────────────────────────
  function onSelect(entity) {
    const pr = entity && entity.properties;
    const get = k => (pr && pr[k] ? pr[k].getValue() : null);
    if (!pr) { closeCard(); return; }
    if (get('isFeatureLead')) { const L = pj.P.leads[get('leadId')]; if (L) editLead(null, targetLabel(L.target), { id: L.id, rec: L, fields: L.fields, active: FL.leadActive(L) }); return; }
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
    head.appendChild(el('div', 'pj-card-t', c.survey ? `Survey ${c.code || '(none)'}` : `📍 ${c.name}${c.field ? ' (field)' : ''}`));
    head.appendChild(btn('✕', closeCard, 'small'));
    box.appendChild(head);
    if (!pj.pid) {
      box.appendChild(el('div', 'pj-note', 'Notes, leads and documents belong to a project: open 📁 Project to choose or create one.'));
      return;
    }
    if (!c.cid) {
      box.appendChild(el('div', 'pj-note', `“${c.imp ? c.imp.name : 'This file'}” isn’t a cave of “${pj.P.name || 'this project'}” yet.`));
      if (c.imp) box.appendChild(btn('Link it to a cave…', async () => { await linkFile(c.imp); c.cid = caveFor(c.imp, c.code); renderCard(); }, 'primary'));
      return;
    }
    box.appendChild(el('div', 'pj-sub', caveName(c.cid) + (c.code && !c.survey ? ` · survey ${c.code}` : '')));
    const target = c.survey ? FL.T.survey(c.cid, c.code) : FL.T.station(c.cid, c.name);
    const sec = (title, items) => { if (!items.length) return; box.appendChild(el('div', 'pj-h', title)); items.forEach(i => box.appendChild(i)); };
    if (window._pjSeg) window._pjSeg.card(box, c);
    sec('Notes', FL.notesOn(pj.P, target).map(noteEl));
    if (!c.survey) {
      const ls = leadsAt(c.cid, c.name);
      sec('Leads', ls.map(x => leadEl(c.cid, c.name, x)));
      const fs = FL.docsForStation(pj.D, pj.P, c.cid, c.name, c.code ? [c.code] : []);
      sec('Documents · this station', fs.station.map(d => docEl(d)));
      sec('Documents · pages covering this area', (fs.area || []).map(d => docEl(d)));
      if (!window._pjSeg || window._pjSeg.on()) sec('Documents · its segment', (fs.segment || []).map(d => docEl(d, d.tagList.find(t => t.startsWith('segment:' + c.cid + ':')))));
      sec('Documents · survey ' + (c.code || ''), fs.survey.map(d => docEl(d)));
      if (!(window._pjSeg && window._pjSeg.on())) sec('Documents · the cave', fs.cave.map(d => docEl(d)));   // with segments: the side panel has the segment's
    } else {
      sec('Documents · this survey', FL.docsForTarget(pj.D, target).map(d => docEl(d)));
      if (!(window._pjSeg && window._pjSeg.on())) sec('Documents · the cave', FL.docsForTarget(pj.D, FL.T.cave(c.cid)).filter(d => !d.tags[target]).map(d => docEl(d)));
      if (c.ends.length) { const r = el('div', 'pj-row'); c.ends.forEach(n => r.appendChild(btn('📍 ' + n, () => openCard({ imp: c.imp, code: c.code, cid: c.cid, name: n }), 'small'))); box.appendChild(r); }
    }
    const row = el('div', 'pj-row pj-card-btns');
    row.appendChild(btn('✏️ Note', () => editNote(target)));
    if (!c.survey) row.appendChild(btn('❓ Lead', () => editLead(c.cid, c.name, null)));
    row.appendChild(btn('📄 Add pages', () => addPages({ tags: [target] })));
    row.appendChild(btn('🏷 From inbox', () => tagFromInbox(target)));
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

  // ── The panel ──────────────────────────────────────────────────────────────
  function section(parent, title, open, build) {
    const s = el('div', 'lp-section');
    const h = el('div', 'lp-section-header');
    h.innerHTML = `<span class="lp-section-arrow">${open ? '▾' : '▸'}</span> ${esc(title)}`;
    const b = el('div', 'lp-section-body' + (open ? ' open' : ''));
    const key = 'flex.pj.' + title.split(' ')[0];
    h.addEventListener('click', () => { const o = !b.classList.contains('open'); b.classList.toggle('open', o); h.querySelector('.lp-section-arrow').textContent = o ? '▾' : '▸'; try { localStorage.setItem(key, o ? '1' : '0'); } catch (_) {} });
    try { const v = localStorage.getItem(key); if (v != null) { const o = v === '1'; b.classList.toggle('open', o); h.querySelector('.lp-section-arrow').textContent = o ? '▾' : '▸'; } } catch (_) {}
    s.append(h, b); parent.appendChild(s);
    build(b);
  }
  function render() {
    const root = $('pj-panel');
    if (!root) return;
    root.textContent = '';
    section(root, 'Project', true, b => {
      const row = el('div', 'pj-row');
      const sel = el('select', 'pj-input');
      sel.appendChild(new Option('— choose a project —', ''));
      pj.projects.forEach(p => sel.appendChild(new Option(p.name || p.id, p.id, false, p.id === pj.pid)));
      sel.addEventListener('change', () => setProject(sel.value));
      row.appendChild(sel);
      row.appendChild(btn('＋ New', newProject, 'small'));
      if (pj.pid) row.appendChild(btn('✏️', renameProject, 'small'));
      b.appendChild(row);
      const r2 = el('div', 'pj-row pj-sub');
      r2.append(`Entering as: ${who() || '(not set)'} `, btn('change', async () => { try { localStorage.removeItem('flex.author'); } catch (_) {} await ensureAuthor(); render(); }, 'link'));
      b.appendChild(r2);
      if (!pj.pid) b.appendChild(el('div', 'pj-note', 'A project is an area: its caves (survey files and where they are placed), point clouds, CalTopo map, documents, notes, leads and field survey — opened together, saved together, shared with friends and FLEX Field by sync files. Without one, FLEX works as usual.'));
    });
    if (window._pjWs) window._pjWs.section(root, section);
    if (!pj.pid) { section(root, 'Sync files', true, b => b.appendChild(btn('⇩ Import a sync file…', () => importSync()))); return; }
    const q = FL.reviewQueue(pj.P, pj.D);
    if (q.length) section(root, `Suggestions (${q.length})`, true, b => {
      b.appendChild(el('div', 'pj-note', `${q.length} suggestion(s) waiting — from ${[...new Set(q.map(p => p.by))].join(', ')}. They change nothing until accepted.`));
      b.appendChild(btn('Review…', () => (window._pjSeg ? window._pjSeg.review() : review()), 'primary'));
    });
    if (window._pjSeg) window._pjSeg.section(root, section);
    section(root, 'Caves', true, b => {
      const caves = FL.liveCaves(pj.P);
      if (!caves.length) b.appendChild(el('div', 'pj-note', 'No caves yet: link a loaded survey file below.'));
      caves.forEach(c => {
        const parts = partsOf(c.id);
        const r = el('div', 'pj-item');
        r.appendChild(el('div', 'pj-item-t', c.name));
        r.appendChild(el('div', 'pj-sub', (c.sources || []).map(s => s.file + (s.surveys && s.surveys.length ? ` (survey${s.surveys.length > 1 ? 's' : ''} ${s.surveys.join(', ')})` : '')).join('; ') || 'no files'));
        if (!parts.length) r.appendChild(el('div', 'pj-sub', 'not loaded'));
        r.addEventListener('click', () => editCave(c.id));
        b.appendChild(r);
      });
      const files = imps();
      if (files.length) {
        b.appendChild(el('div', 'pj-h', 'Loaded survey files'));
        files.forEach(imp => {
          const codes = [...new Set((imp.parsed.segments || []).map(s => s.survey || ''))];
          const cids = [...new Set(codes.map(cd => caveFor(imp, cd)).filter(Boolean))];
          const r = el('div', 'pj-item');
          r.appendChild(el('div', 'pj-item-t', imp.name));
          r.appendChild(el('div', 'pj-sub', cids.length ? '→ ' + cids.map(caveName).join(', ') + (codes.some(cd => !caveFor(imp, cd)) ? ' · some surveys in no cave' : '') : 'not in this project — click to link'));
          r.addEventListener('click', () => linkFile(imp));
          b.appendChild(r);
        });
      }
    });
    section(root, 'Leads', false, b => {
      const all = allLeads();
      const tabs = el('div', 'pj-tabs');
      [['active', `Active (${all.filter(x => x.active).length})`], ['closed', `Closed (${all.filter(x => !x.active).length})`], ['all', `All (${all.length})`]].forEach(([k, l]) => {
        tabs.appendChild(btn(l, () => { pj.leadShow = k; render(); }, pj.leadShow === k ? 'on' : ''));
      });
      b.appendChild(tabs);
      const shown = all.filter(x => pj.leadShow === 'all' || (pj.leadShow === 'active') === x.active)
        .sort((a, b2) => (Number(a.fields.priority) || 9) - (Number(b2.fields.priority) || 9));
      if (!shown.length) b.appendChild(el('div', 'pj-note', 'None.'));
      shown.slice(0, 200).forEach(x => {
        const t = FL.parseTarget(x.target);
        const r = el('div', 'pj-item' + (x.active ? '' : ' closed'));
        r.appendChild(el('div', 'pj-item-t', t.kind === 'feature' ? targetLabel(x.target) : `${t.name || '?'} · ${caveName(t.cave)}`));
        r.appendChild(el('div', 'pj-sub', leadSummary(x.fields) + (x.fields.desc ? ' — ' + x.fields.desc : '')));
        r.addEventListener('click', () => {
          if (t.kind !== 'feature') return flyTo(t.cave, t.name);
          const f = pj.P.features[t.feature];
          if (f && window._pjf) window._pjf.highlight({ kind: f.kind, coords: f.coords }, true);
          if (x.rec) editLead(null, targetLabel(x.target), x);
        });
        b.appendChild(r);
      });
      b.appendChild(btn('⇩ CSV', leadsCsv, 'small'));
    });
    section(root, 'Documents', true, b => {
      const all = FL.docsOf(pj.D, pj.P);
      const inbox = all.filter(d => FL.docInbox(d, pj.P));
      const tabs = el('div', 'pj-tabs');
      [['inbox', `Inbox (${inbox.length})`], ['all', `All (${all.length})`]].forEach(([k, l]) => tabs.appendChild(btn(l, () => { pj.docTab = k; render(); }, pj.docTab === k ? 'on' : '')));
      b.appendChild(tabs);
      const add = btn('＋ Add files (photos, scans, TIFF, PDF)…', () => addPages({}), 'primary');
      b.appendChild(add);
      const drop = el('div', 'pj-drop', 'or drop files here');
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('on'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('on'));
      drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('on'); addPages({ files: Array.from(e.dataTransfer.files || []) }); });
      b.appendChild(drop);
      const list = pj.docTab === 'inbox' ? inbox : all.slice().sort((x, y) => (FL.dateKey(y.date) || '').localeCompare(FL.dateKey(x.date) || ''));
      if (!list.length) b.appendChild(el('div', 'pj-note', pj.docTab === 'inbox' ? 'Inbox empty: every document is tagged to a cave, survey, station or lead.' : 'No documents yet.'));
      list.slice(0, 300).forEach(d => b.appendChild(docEl(d)));
    });
    section(root, 'Field survey', false, b => {
      const svs = pj.P.order.map(id => pj.P.surveys[id]).filter(Boolean);
      if (!svs.length) b.appendChild(el('div', 'pj-note', 'Shots taken in FLEX Field arrive with sync files and are drawn here (orange), view only. Into survey data: Compass DAT export (later).'));
      svs.forEach(sv => {
        const inf = (pj.fieldInfo || {})[sv.id];
        const r = el('div', 'pj-item');
        r.appendChild(el('div', 'pj-item-t', `${sv.name} · ${caveName(sv.cave)}`));
        r.appendChild(el('div', 'pj-sub', `${sv.shots.length} shot(s)${sv.date ? ' · ' + sv.date : ''}${sv.team ? ' · ' + sv.team : ''}` +
          (inf ? ` · decl ${inf.decl.v.toFixed(2)}° (${inf.decl.src})${inf.loose ? ` · ${inf.loose} not tied in` : ''}${inf.closures.length ? ' · closure ' + inf.closures.map(x => x.err.toFixed(2) + ' m').join(', ') : ''}` : ' · tie-in station not loaded')));
        if (sv.tie) r.addEventListener('click', () => flyTo(sv.cave, sv.tie));
        b.appendChild(r);
      });
    });
    section(root, 'Sync files', true, b => {
      b.appendChild(el('div', 'pj-note', 'Share changes with FLEX Field and teammates: make a file, send it (email, cloud, cable); they import it. The first file has everything.'));
      const r = el('div', 'pj-row');
      r.append(btn('⇧ Make: changes since last', () => makeSync('since'), 'primary small'), btn('⇧ Everything', () => makeSync('all'), 'small'), btn('⇩ Import…', () => importSync(), 'small'));
      b.appendChild(r);
    });
    section(root, 'History', false, b => {
      const list = FL.sortEntries(pj.proj).slice(-8).reverse();
      list.forEach(e => { const r = el('div', 'pj-item'); r.appendChild(el('div', 'pj-item-t', describe(e))); r.appendChild(el('div', 'pj-sub', `${e.who || '?'} · ${when(e.t)}`)); b.appendChild(r); });
      b.appendChild(btn('Everything (with undo)…', () => history(null), 'small'));
    });
  }
  async function newProject() {
    const r = await dialog({ title: 'New project', text: 'Usually the name of the area.', input: { value: '', placeholder: 'Project name' },
      buttons: [{ label: 'Cancel', value: null }, { label: 'Create', value: 'ok', primary: true }] });
    if (!r || !r.value.trim()) return;
    const id = FL.uid(10), name = r.value.trim().slice(0, 60);
    const w = window._ws, loaded = w ? w.caves().length + w.pointClouds().length + (w.caltopo() ? 1 : 0) + w.dataFiles().length : 0;
    let keep = false;
    if (loaded && window._pjWs) {
      const c = await choose(`New project “${name}”`, `${loaded} thing(s) are loaded now (caves, point clouds, CalTopo, files).`, [
        { label: 'Start it with what is loaded now', sub: 'they become the project’s', value: 'keep', primary: true },
        { label: 'Start it empty', sub: 'what is loaded now is put away and comes back under “No project”', value: 'empty' }]);
      if (!c) return;
      keep = c === 'keep';
    }
    await post('projects', { id, name });
    pj.projects = await api('projects');
    await setProject(id, { keep });
    await record('project.set', { name });
    if (window._pjWs) window._pjWs.label();
  }
  async function renameProject() {
    const r = await dialog({ title: 'Project name', input: { value: pj.P.name || '' }, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }] });
    if (!r || !r.value.trim() || r.value.trim() === pj.P.name) return;
    await post('projects', { id: pj.pid, name: r.value.trim().slice(0, 60) });
    pj.projects = await api('projects');
    await record('project.set', { name: r.value.trim().slice(0, 60) });
  }
  function leadsCsv() {
    const cols = ['cave', 'station'].concat(FL.LEAD_FIELDS.map(f => f.k), ['confidence', 'source', 'updated_by', 'updated']);
    const q = v => { const s = Array.isArray(v) ? v.join('; ') : v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const rows = allLeads().map(x => { const t = FL.parseTarget(x.target); return [caveName(t.cave), t.name].concat(FL.LEAD_FIELDS.map(f => x.fields[f.k]),
      [x.fields.confidence, x.rec ? x.rec.source || '' : 'export', x.rec ? x.rec.updated.who : '', x.rec ? x.rec.updated.t : '']).map(q).join(','); });
    const a = el('a'); a.href = URL.createObjectURL(new Blob([cols.join(',') + '\n' + rows.join('\n') + '\n'], { type: 'text/csv' }));
    a.download = `leads-${(pj.P.name || 'project').replace(/[^A-Za-z0-9]+/g, '-')}.csv`; document.body.appendChild(a); a.click(); a.remove();
  }

  pj._filesToPages = filesToPages;               // tests
  pj._setProject = setProject;                   // tests

  // ── For project_segments.js (segments and the review queue) ───────────────
  window._pjApi = { pj, FL, el, btn, esc, when, toast, dialog, choose, record, render, refreshCard, openCard, flyTo,
    caveFor, caveName, partsOf, stationPos, stationsOf, docEl, docOpen, docByPage, describe, headsFor, targetLabel,
    editNote, noteEl, declAt, yearOf, imps, who, newProject, refresh, editLead };

  // ── What the export takes from the project (index.html _collectCavesInBbox) ─
  window._pjExport = () => pj.pid ? {
    project: { id: pj.pid, name: pj.P.name || '' },
    caveFor: (imp, code) => { const cid = caveFor(imp, code); return cid ? { id: cid, name: caveName(cid) } : null; },
  } : null;

  // ── Start ──────────────────────────────────────────────────────────────────
  async function start() {
    $('pj-panel') && $('pj-panel').closest('.collapse') && document.querySelector('[data-target="#projectCollapsible"]')
      ?.addEventListener('click', () => setTimeout(render, 0));
    try { pj.dev = (await api('device')).id; }
    catch (e) { console.warn('[project] library unavailable', e); const p = $('pj-panel'); if (p) p.textContent = 'The project library needs the FLEX server (node server.js).'; return; }
    try { pj.pid = localStorage.getItem('flex.project') || null; } catch (_) {}
    await loadAll();
    if (pj.pid && !pj.projects.some(p => p.id === pj.pid)) await setProject(null);
    pj.ready = true;
    render();
    if (window._pjWs) { window._pjWs.label(); if (pj.pid) window._pjWs.enter(pj.pid, { startup: true }); }
    const wait = setInterval(() => {
      const V = window.cesiumViewer;
      if (!V || !V.selectedEntityChanged) return;
      clearInterval(wait);
      V.selectedEntityChanged.addEventListener(onSelect);
      drawField(); drawLeads();
    }, 300);
    // Caves loaded or removed: refresh what depends on them.
    let lastSig = '';
    setInterval(() => {
      const sig = imps().map(i => i.name + ':' + (typeof i._convertFn === 'function')).join('|');
      if (sig !== lastSig) { lastSig = sig; render(); drawField(); drawLeads(); if (window._pjSeg) window._pjSeg.changed(null); }
    }, 1500);
    // Another tab may have written: reload when coming back.
    window.addEventListener('focus', async () => { if (pj.ready && !document.querySelector('.pj-modal')) { await loadAll(); render(); refreshCard(); if (window._pjSeg) window._pjSeg.changed(null); } });
  }

  const css = `
  #pj-panel { font-size: 12px; }
  .pj-btn { font: inherit; font-size: 12px; padding: 4px 9px; border-radius: 5px; cursor: pointer; color: #e8e8ee; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.2); margin: 2px 4px 2px 0; }
  .pj-btn:hover { background: rgba(255,255,255,.14); }
  .pj-btn.primary { background: rgba(33,150,243,.35); border-color: #2196F3; }
  .pj-btn.danger { color: #ffb0b0; border-color: rgba(255,107,107,.6); }
  .pj-btn.small { padding: 2px 7px; font-size: 11px; }
  .pj-btn.link { background: none; border: none; color: #8ec5ff; padding: 0 2px; text-decoration: underline; }
  .pj-btn.chip { border-radius: 12px; padding: 2px 9px; font-size: 11px; }
  .pj-btn.chip.on, .pj-tabs .pj-btn.on { background: rgba(33,150,243,.45); border-color: #2196F3; }
  .pj-btn.row { display: block; width: 100%; text-align: left; margin: 1px 0; }
  .pj-btn:disabled { opacity: .3; cursor: default; }
  .pj-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 4px 0; }
  .pj-row select { flex: 1; min-width: 0; }
  .pj-input { font: inherit; font-size: 12px; background: rgba(0,0,0,.35); color: #eee; border: 1px solid rgba(255,255,255,.25); border-radius: 5px; padding: 5px 7px; width: 100%; box-sizing: border-box; }
  .pj-num { width: 60px; }
  .pj-item { padding: 5px 6px; margin: 3px 0; border-radius: 6px; background: rgba(255,255,255,.05); cursor: pointer; }
  .pj-item:hover { background: rgba(255,255,255,.1); }
  .pj-item.closed { opacity: .6; }
  .pj-item.conflict { border-left: 3px solid #ff9f1c; }
  .pj-item-t { color: #f0f0f4; white-space: pre-wrap; overflow-wrap: anywhere; }
  .pj-sub { font-size: 11px; color: rgba(255,255,255,.55); overflow-wrap: anywhere; }
  .pj-note { font-size: 11px; color: rgba(255,255,255,.55); margin: 4px 0; line-height: 1.4; }
  .pj-h { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: rgba(255,255,255,.5); margin: 8px 0 2px; }
  .pj-tabs { display: flex; gap: 2px; margin: 2px 0 4px; }
  .pj-doc { display: flex; gap: 8px; align-items: center; }
  .pj-thumb { width: 44px; height: 44px; object-fit: cover; border-radius: 4px; background: #fff; flex: none; }
  .pj-thumb-x { display: flex; align-items: center; justify-content: center; color: #333; font-size: 10px; }
  .pj-drop { border: 1px dashed rgba(255,255,255,.25); border-radius: 6px; padding: 6px; text-align: center; color: rgba(255,255,255,.4); font-size: 11px; margin: 4px 0; }
  .pj-drop.on { border-color: #2196F3; color: #8ec5ff; }
  .pj-conflict { color: #ffc070; font-size: 11px; margin-top: 4px; }
  .pj-modal { position: fixed; inset: 0; z-index: 100001; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; font: 12px system-ui, sans-serif; }
  .pj-modal-box { width: min(440px, calc(100vw - 32px)); max-height: calc(100vh - 40px); overflow: auto; background: rgba(18,18,30,.98); color: #e8e8ee; border: 1px solid rgba(255,255,255,.18); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 9px; }
  .pj-modal-box.wide { width: min(640px, calc(100vw - 32px)); }
  .pj-modal-title { font-size: 14px; font-weight: 700; }
  .pj-modal-text { line-height: 1.45; color: rgba(255,255,255,.8); }
  .pj-modal-btns { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
  .pj-choices { display: flex; flex-direction: column; gap: 4px; }
  .pj-choices .pj-btn { text-align: left; padding: 7px 10px; }
  .pj-form { display: flex; flex-direction: column; gap: 7px; }
  .pj-f-l { font-size: 11px; color: rgba(255,255,255,.6); margin-bottom: 2px; }
  .pj-chips { display: flex; flex-wrap: wrap; }
  .pj-check { display: flex; gap: 6px; align-items: center; }
  .pj-list { display: flex; flex-direction: column; }
  .pj-taglist { max-height: 240px; overflow: auto; }
  #pj-card { position: fixed; right: 12px; bottom: 34px; width: 330px; max-height: 55vh; overflow: auto; z-index: 9000; background: rgba(18,18,30,.95); color: #e8e8ee;
             border: 1px solid rgba(255,255,255,.18); border-radius: 10px; padding: 10px 12px; font: 12px system-ui, sans-serif; display: none; box-shadow: 0 6px 24px rgba(0,0,0,.5); }
  #pj-card.open { display: block; }
  .pj-card-h { display: flex; justify-content: space-between; align-items: center; }
  .pj-card-t { font-weight: 700; font-size: 14px; }
  .pj-card-btns { margin-top: 8px; border-top: 1px solid rgba(255,255,255,.1); padding-top: 6px; }
  #pj-gallery { position: fixed; inset: 0; z-index: 100000; background: rgba(8,8,12,.97); color: #eee; display: none; flex-direction: column; font: 12px system-ui, sans-serif; }
  #pj-gallery.open { display: flex; }
  .pjg-bar { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; gap: 8px; flex-wrap: wrap; }
  .pjg-title span { color: rgba(255,255,255,.55); margin-left: 6px; }
  .pjg-title .pjg-render { font-size: 10.5px; padding: 1px 7px; border: 1px solid rgba(255,255,255,.25); border-radius: 99px; color: rgba(255,255,255,.7); white-space: nowrap; }
  .pjg-stage { flex: 1; display: flex; align-items: center; min-height: 0; }
  .pjg-view { flex: 1; height: 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .pjg-img { max-width: calc(100vw - 120px); max-height: calc(100vh - 140px); background: #fff; transition: transform .15s; }
  .pjg-pdf { width: calc(100vw - 120px); height: calc(100vh - 140px); border: 0; background: #fff; }
  .pjg-prev, .pjg-next { font-size: 40px; width: 50px; background: none; border: none; color: #fff; cursor: pointer; }
  .pjg-prev:disabled, .pjg-next:disabled { opacity: .15; }
  .pjg-tags { padding: 6px 14px 10px; color: rgba(255,255,255,.6); }
  #pj-toast { position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); background: rgba(20,20,30,.95); color: #fff; padding: 7px 14px; border-radius: 6px; z-index: 100002; opacity: 0; transition: opacity .2s; pointer-events: none; font: 12px system-ui, sans-serif; }
  #pj-toast.on { opacity: 1; }`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
