// FLEX project (project caves, stations, notes, leads).
// Part of project.js, split into classic scripts that load in order (index.html);
// they share their functions through window._pjParts until project.js has loaded.
// Behaviour unchanged. See client/src/README.md.
(function () {
  'use strict';
  const X = window._pjParts;
  if (!X) return;                          // project-ui-kit.js found no flexlib.js
  const { pj, FL, toast, $, choose, record, dialog, el, esc, fnv, when, ensureAuthor, btn } = X;
  // defined in a later part: called only after every part has loaded
  const docByPage = (...a) => X.docByPage(...a);
  const docOpen = (...a) => X.docOpen(...a);
  const history = (...a) => X.history(...a);

  // ── Caves: which project cave a loaded file (and survey) is ───────────────
  const imps = () => (window._caveImports || []).filter(i => i && i.parsed);
  function caveFor(imp, code) {
    if (!imp || !pj.pid) return null;
    const cf = pj.P.cavefiles[imp.name], multi = !!(cf && cf.multi && !cf.removed);
    if (multi && (cf.surface || []).includes(code || '')) return null;      // a surface traverse belongs to no cave
    for (const c of FL.liveCaves(pj.P)) {
      for (const s of c.sources || []) {
        if (s && s.file === imp.name && (!s.surveys || !s.surveys.length || s.surveys.includes(code || ''))) return c.id;
      }
    }
    return multi ? null : FL.caveForName(pj.P, imp.name);                  // multi-cave: a survey nobody claimed is "Surface / not yet sorted"
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
  const surfaceMarked = (file, code) => { const f = pj.P && pj.P.cavefiles[file]; return !!(f && !f.removed && (f.surface || []).includes(code)); };
  function suggest(imp) {
    const dopt = imp.displayOptions || {};
    return FL.suggestCaves((imp.parsed.segments || []).map(sg => ({
      survey: sg.survey || '', surface: !!(sg.isSurface || (dopt.surfaceSurveys && dopt.surfaceSurveys[sg.survey || '']) || surfaceMarked(imp.name, sg.survey || '')),
      points: sg.points.filter(p => !p.excluded).map(p => ({ name: p.name, surface: !!p.isSurface })),
    })));
  }
  async function linkFile(imp) {
    if (!pj.pid) { toast('Choose or create a project first'); return; }
    const sug = suggest(imp);
    const cur = caveFor(imp, '');
    const opts = FL.liveCaves(pj.P).map(c => ({ label: (c.id === cur ? '✓ ' : '') + c.name, sub: 'this file is part of it', value: 'c:' + c.id }));
    opts.push({ label: ['plus', `A new cave “${imp.name}”`], sub: 'the whole file', value: 'new', primary: !opts.length });
    const multiNow = !!(pj.P.cavefiles[imp.name] && pj.P.cavefiles[imp.name].multi);
    if (sug.caves.length > 1 || multiNow) opts.push({ label: ['scissors', multiNow ? 'Caves in this multi-cave file…' : `${sug.caves.length} caves in this file`], sub: multiNow ? 'change which survey belongs to which cave' : 'a multi-cave file: surveys joined underground form a cave: ' +
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
    if (r === 'split') return multiCave(imp);
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
  // ── Multi-cave survey files (doc 14, rule 3) ──────────────────────────────
  // One file placed once, marked multi-cave; its caves are named groups of its surveys (project caves with
  // sources [{ file, surveys }]), surveys nobody claimed are "Surface / not yet sorted", surface traverses are marked.
  function codesOf(imp) {
    const m = new Map();
    (imp.parsed.surveys || []).forEach(sv => { if (!m.has(sv.code)) m.set(sv.code, { code: sv.code, desc: sv.desc || '', stations: 0 }); });
    (imp.parsed.segments || []).forEach(sg => {
      const c = sg.survey || '';
      if (!m.has(c)) m.set(c, { code: c, desc: '', stations: 0 });
      m.get(c).stations += (sg.points || []).filter(p => p.name).length;
    });
    return [...m.values()];
  }
  async function multiCave(imp) {
    const cf = pj.P.cavefiles[imp.name];
    if (!cf || cf.removed) { toast('Put the file in the project first (💾 Save)'); return; }
    const list = codesOf(imp), codes = list.map(x => x.code);
    const g = FL.fileGroups(pj.P, imp.name, codes);
    const base = imp.name.replace(/\.(plt|json)$/i, '');
    const caves = [], assign = {};
    let seq = 0;
    const addCave = (id, name) => { const c = { key: 'k' + (++seq), id: id || FL.uid(10), name, isNew: !id }; caves.push(c); return c; };
    const fromSuggestion = () => {
      const sug = suggest(imp), keep = g.caves.slice();
      caves.length = 0; Object.keys(assign).forEach(k => delete assign[k]);
      sug.caves.forEach((c, i) => {
        const ex = keep[i], d = (list.find(x => x.code === c.surveys[0]) || {}).desc;
        const k = addCave(ex && ex.id, ex ? ex.name : i === 0 ? base : `${base} – ${d || c.surveys[0] || i + 1}`);
        c.surveys.forEach(sv => { assign[sv] = k.key; });
      });
      codes.forEach(sv => { if (!assign[sv]) assign[sv] = sug.surface.includes(sv) || surfaceMarked(imp.name, sv) ? 'surface' : 'unsorted'; });
    };
    if (g.multi || g.caves.length > 1) {
      g.caves.forEach(c => { const k = addCave(c.id, c.name); k.isNew = false; c.surveys.forEach(sv => { assign[sv] = k.key; }); });
      g.surface.forEach(sv => { assign[sv] = 'surface'; });
      codes.forEach(sv => { if (!assign[sv]) assign[sv] = 'unsorted'; });
    } else fromSuggestion();
    const body = el('div', 'pj-form'), top = el('div', 'pj-f'), tbl = el('div', 'pj-f');
    body.append(top, tbl);
    const label = c => c.name || '(unnamed cave)';
    function paint() {
      top.textContent = '';
      top.appendChild(el('div', 'pj-f-l', 'Caves in this file'));
      caves.forEach(c => {
        const row = el('div', 'pj-row'), inp = el('input', 'pj-input'); inp.value = c.name; inp.placeholder = 'Cave name';
        inp.addEventListener('input', () => { c.name = inp.value; tbl.querySelectorAll(`option[value="${c.key}"]`).forEach(o => { o.textContent = label(c); }); });
        row.append(inp, btn('✕', () => { codes.forEach(sv => { if (assign[sv] === c.key) assign[sv] = 'unsorted'; }); caves.splice(caves.indexOf(c), 1); paint(); }, 'small'));
        row.lastChild.title = 'Take this cave out of the list (its surveys go to “Surface / not yet sorted”)';
        top.appendChild(row);
      });
      const row = el('div', 'pj-row');
      row.append(btn(['plus', 'Add a cave'], () => { addCave(null, ''); paint(); }, 'small'), btn('Start from the caves FLEX finds', () => { fromSuggestion(); paint(); }, 'small'));
      top.appendChild(row);
      tbl.textContent = '';
      tbl.appendChild(el('div', 'pj-f-l', 'Surveys: which cave, or not part of one'));
      list.forEach(x => {
        const row = el('div', 'pj-row'), sel = el('select', 'pj-input');
        const opt = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
        caves.forEach(c => opt(c.key, label(c)));
        opt('unsorted', 'Surface / not yet sorted'); opt('surface', 'Surface traverse');
        sel.value = assign[x.code] && [...sel.options].some(o => o.value === assign[x.code]) ? assign[x.code] : 'unsorted';
        assign[x.code] = sel.value;
        sel.addEventListener('change', () => { assign[x.code] = sel.value; });
        row.append(el('span', 'pj-sub', `${x.code || '(no code)'}${x.desc ? ' · ' + x.desc : ''} · ${x.stations} stations`), sel);
        tbl.appendChild(row);
      });
    }
    paint();
    const buttons = [{ label: 'Cancel', value: null }];
    if (g.multi) buttons.push({ label: 'Not a multi-cave file', value: 'off' });
    buttons.push({ label: 'Save', value: 'ok', primary: true });
    const r = await dialog({ title: `Caves in “${imp.name}”`, wide: true, body, buttons,
      text: 'A multi-cave file is placed once; each cave is a named group of its surveys. Surveys under “Surface / not yet sorted” belong to no cave yet; surface traverses are marked so they stay out of every cave. Entrance markers of its caves fit the whole file.' });
    if (!r) return;
    if (r.button === 'off') { await record('cavefile.set', { file: imp.name, multi: false }); return; }
    const map = {};
    codes.forEach(sv => {
      const a = assign[sv], c = caves.find(x => x.key === a);
      map[sv] = a === 'surface' ? 'surface' : c ? { cave: c.id, name: (c.name || '').trim().slice(0, 60) || base } : 'unsorted';
    });
    const plan = FL.planMulti(pj.P, imp.name, codes, map, () => FL.uid(10));
    for (const o of plan.ops) { const d = Object.assign({}, o); delete d.op; await record(o.op, d); }
    const empty = g.caves.filter(c => !plan.caves[c.id]);
    toast(plan.ops.length ? `${imp.name}: ${Object.keys(plan.caves).length} cave${Object.keys(plan.caves).length === 1 ? '' : 's'}` + (empty.length ? `; “${empty[0].name}” has no survey here now` : '') : 'Nothing changed');
  }

  // ── Systems: caves grouped, their files separate ───────────────────────────
  function caveStatsOf(cid) {
    const parts = partsOf(cid);
    if (!parts.length) return null;
    let len = 0, lo = Infinity, hi = -Infinity, n = 0;
    parts.forEach(({ imp, codes }) => (imp.parsed.segments || []).forEach(sg => {
      if (codes && !codes.has(sg.survey || '')) return;
      for (let i = 1; i < sg.points.length; i++) { const p = sg.points[i - 1], q = sg.points[i]; if (!q.excluded) len += Math.hypot(q.n - p.n, q.e - p.e, q.v - p.v); }
      sg.points.forEach(p => { if (p.isSurface) return; if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; n++; });
    }));
    return { len, depth: n ? hi - lo : 0, lo: n ? lo : undefined, hi: n ? hi : undefined };
  }
  const fmtM = v => (v >= 1000 ? (v / 1000).toFixed(2) + ' km' : Math.round(v) + ' m');
  function systemLine(sys) {
    const T = FL.systemTotals(sys, caveStatsOf);
    return `${sys.caves.length} cave${sys.caves.length === 1 ? '' : 's'}` + (T.loaded ? ` · ${fmtM(T.len)} surveyed · ${Math.round(T.depth)} m deep` + (T.loaded < T.caves ? ` (${T.loaded} of ${T.caves} loaded)` : '') : ' · not loaded');
  }
  /** Create (sid null) or edit a system: its name and which caves are in it; or delete it. */
  async function editSystem(sid, pre) {
    const cur = sid ? FL.liveSystems(pj.P).find(g => g.id === sid) : null;
    if (sid && !cur) return;
    const all = FL.liveCaves(pj.P);
    if (!all.length) { toast('No caves in the project yet'); return; }
    const body = el('div', 'pj-form'), inp = el('input', 'pj-input'); inp.value = cur ? cur.name : ''; inp.placeholder = 'System name';
    body.appendChild(inp);
    const ticks = all.map(c => {
      const lab = el('label', 'pj-row'), cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'keep-box';
      cb.checked = cur ? cur.caves.includes(c.id) : (pre || []).includes(c.id);
      lab.append(cb, ' ' + c.name); body.appendChild(lab);
      return { c, cb };
    });
    const buttons = [{ label: 'Cancel', value: null }];
    if (cur) buttons.push({ label: 'Delete system', value: 'del', danger: true });
    buttons.push({ label: cur ? 'Save' : 'Create', value: 'ok', primary: true });
    const r = await dialog({ title: cur ? 'System: ' + cur.name : 'New system', text: 'A system groups caves that connect or belong together. Their survey files stay separate.', body, buttons });
    if (!r) return;
    if (r.button === 'del') { await record('system.set', { system: sid, removed: true }); return; }
    const name = inp.value.trim().slice(0, 60);
    if (!name) { toast('A system needs a name'); return; }
    const want = ticks.filter(x => x.cb.checked).map(x => x.c.id), have = cur ? cur.caves : [];
    const add = want.filter(c => !have.includes(c)), remove = have.filter(c => !want.includes(c));
    if (!cur) { await record('system.set', { system: FL.uid(10), name, add, created: true }); return; }
    const d = { system: sid };
    if (name !== cur.name) { d.name = name; d.prevName = cur.name; }
    if (add.length) d.add = add;
    if (remove.length) d.remove = remove;
    if (Object.keys(d).length > 1) await record('system.set', d);
  }
  /** A cave's systems: tick the ones it is part of, or start a new one with it. */
  async function caveSystems(cid) {
    const sys = FL.liveSystems(pj.P), inIt = new Set(FL.systemsOf(pj.P, cid).map(g => g.id));
    const opts = sys.map(g => ({ label: (inIt.has(g.id) ? '✓ ' : '') + g.name, sub: inIt.has(g.id) ? 'take ' + caveName(cid) + ' out of it' : 'put ' + caveName(cid) + ' in it', value: 's:' + g.id }));
    opts.push({ label: ['plus', 'A new system with this cave…'], value: 'new', primary: !opts.length });
    const r = await choose('Systems of “' + caveName(cid) + '”', 'A system groups caves; their survey files stay separate.', opts);
    if (!r) return;
    if (r === 'new') { await editSystem(null, [cid]); return; }
    const id = r.slice(2);
    await record('system.set', inIt.has(id) ? { system: id, remove: [cid] } : { system: id, add: [cid] });
  }
  /** Systems of the project (⋯ on a cave, the Caves pane): list, new, edit. */
  async function systemsDialog() {
    const opts = FL.liveSystems(pj.P).map(g => ({ label: ['folder', g.name], sub: systemLine(g) + (g.caves.length ? ' · ' + g.caves.map(caveName).join(', ') : ''), value: 's:' + g.id }));
    opts.push({ label: ['plus', 'New system…'], sub: 'a system groups caves; their survey files stay separate', value: 'new', primary: !opts.length });
    const r = await choose('Systems', opts.length > 1 ? 'Pick one to rename it, change its caves or delete it.' : 'No systems yet.', opts);
    if (r === 'new') return editSystem(null);
    if (r) return editSystem(r.slice(2));
  }
  async function editCave(cid) {
    const c = pj.P.caves[cid];
    const r = await dialog({ title: 'Cave', input: { value: c.name }, wide: true,
      html: 'Made of: ' + ((c.sources || []).map(s => esc(s.file) + (s.surveys && s.surveys.length ? ' (surveys ' + esc(s.surveys.join(', ')) + ')' : '')).join('; ') || 'nothing loaded yet') +
        (Object.keys(pj.P.aliases).filter(a => pj.P.aliases[a] === cid).length ? '<br>Also known as: ' + esc(Object.keys(pj.P.aliases).filter(a => pj.P.aliases[a] === cid).join(', ')) : '') +
        (FL.systemsOf(pj.P, cid).length ? '<br>In the system: ' + esc(FL.systemsOf(pj.P, cid).map(g => g.name).join(', ')) : '') +
        ((c.sources || []).some(s => pj.P.cavefiles[s.file] && pj.P.cavefiles[s.file].multi) ? '<br>Its file holds several caves (a multi-cave file).' : ''),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Remove from project', value: 'rm', danger: true }, { label: 'Systems…', value: 'sys' }, { label: 'Save', value: 'ok', primary: true }] });
    if (!r) return;
    if (r.button === 'sys') return caveSystems(cid);
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
        (cur.conflict ? '<div class="pj-conflict">' + window.icon('warn', '1.15em', 'ico-l') + 'Edited on two devices:<br>' + cur.conflict.map(c => `<b>${esc(c.who)}</b>: ${esc(c.text)}`).join('<br>') + '<br>Saving keeps what is in the box.</div>' : '') : '',
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
    d.appendChild(el('div', 'pj-sub', `${n.who || '?'} · ${when(n.t)}${n.history.length > 1 ? ' · edited' : ''}${n.conflict ? ' · edited on two devices' : ''}`));
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
          const add = btn(['plus'], async () => {
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
      if (conflicts[fd.k]) row.appendChild(el('div', 'pj-conflict', ['warn', 'two devices: ' + conflicts[fd.k].map(c => `${Array.isArray(c.v) ? c.v.join(', ') : c.v} (${c.who})`).join(' / ')]));
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
    d.appendChild(el('div', 'pj-item-t', ['help', leadSummary(x.fields)]));
    if (x.fields.desc) d.appendChild(el('div', 'pj-sub', x.fields.desc));
    if (x.fields.tie) d.appendChild(el('div', 'pj-sub', ['pin', x.fields.tie]));
    if (x.rec) d.appendChild(el('div', 'pj-sub', `${x.rec.updated.who} · ${when(x.rec.updated.t)}${x.rec.sightings ? ' · seen ' + x.rec.sightings.length + '×' : ''}`));
    else d.appendChild(el('div', 'pj-sub', 'from the survey file'));
    d.addEventListener('click', () => editLead(cid, name, x));
    return d;
  }


  // The multi-cave and system tools, for the 🕳 Caves pane, the info panel and project_workspace.js's ⋯ menu.
  const redraw = fn => async (...a) => { const r = await fn(...a); if (window._caveCols) window._caveCols.render(); return r; };
  window._pjMulti = { multiCave: redraw(multiCave), editSystem: redraw(editSystem), caveSystems: redraw(caveSystems), systemsDialog: redraw(systemsDialog), systemLine, caveStatsOf, codesOf, surfaceMarked };

  Object.assign(X, {
    multiCave, editSystem, caveSystems, systemsDialog,
    imps, caveFor, caveName, partsOf, linkFile, editCave, stationsOf, stationPos, leadsAt, allLeads, leadSummary, targetLabel, editNote, noteEl, editLead, leadEl,
  });
})();
