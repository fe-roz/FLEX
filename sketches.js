// sketches.js — sketches as files, and the Files view of a cave, survey or station.
//
// A sketch is a scan (jpg, png, webp, tiff or PDF) attached to a cave, a survey
// or a station. It is a project document (flexlib: kind "sketch-plan" or
// "sketch-profile"), tagged to its target, with the scan's pages as images for
// viewing and the original file kept (doc.file). In a project with a folder the
// original is filed on disk by the folder rules of doc 14 and never copied
// again:
//   cave                   Caves/<Cave>/<Cave> - general/<file>
//   survey, or a station   Caves/<Cave>/<Cave> - <code> <survey name>/<file>
//                          (an existing folder of that survey is used as it is)
// Without a folder the original is kept as a stored file of the project.
//
// Hooks: project.js's Files tab calls filesList() (the grouped view, drop a scan
// on it to attach); cave_columns.js ⋯ → Add sketch… calls addForFile(); the
// details panel counts sketches (info_panel.js, isSketch).
//
// window._sketches = { isSketch, attach, addForFile, filesList, targetLabel, ACCEPT }
(function () {
  'use strict';
  const A = window._pjApi;
  if (!A) return;
  const { pj, FL, el, btn, esc } = A;
  const ACCEPT = 'image/jpeg,image/png,image/webp,image/tiff,.jpg,.jpeg,.png,.webp,.tif,.tiff,application/pdf,.pdf';
  const EXT = { jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'webp', tif: 'tif', tiff: 'tif', pdf: 'pdf' };
  const extOf = n => EXT[(String(n || '').split('.').pop() || '').toLowerCase()] || '';
  const isSketch = d => !!d && /^sketch-/.test(d.kind || '');
  const clean = n => String(n || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '').replace(/^[. ]+/, '').trim().slice(0, 80);
  const VIDEO = /^(mp4|m4v|mov|webm|mkv|avi)$/, PHOTO = /^(jpe?g|png|webp|gif|heic)$/;

  // ── The project folder, as the server lists it (cached a few seconds) ─────
  const T = { pid: null, at: 0, folder: null, files: [], busy: null };
  async function tree(force) {
    if (!pj.pid) return { folder: null, files: [] };
    if (!force && T.pid === pj.pid && Date.now() - T.at < 4000) return T;
    if (T.busy) return T.busy;
    T.busy = (async () => {
      let o = { folder: null, files: [] };
      try { const r = await fetch('/api/lib/tree?project=' + encodeURIComponent(pj.pid)); if (r.ok) o = await r.json(); } catch (_) {}
      Object.assign(T, { pid: pj.pid, at: Date.now(), folder: o.folder || null, files: o.files || [] });
      T.busy = null;
      return T;
    })();
    return T.busy;
  }

  // ── Targets ───────────────────────────────────────────────────────────────
  const caveNameOf = cid => (cid ? A.caveName(cid) : '');
  function labelOf(target) {
    const t = FL.parseTarget(target);
    if (t.kind === 'cave') return 'the cave ' + caveNameOf(t.cave);
    if (t.kind === 'survey') return 'survey ' + (t.code || '(none)') + ' of ' + caveNameOf(t.cave);
    if (t.kind === 'station') return 'station ' + t.name + ' of ' + caveNameOf(t.cave);
    return A.targetLabel(target);
  }
  /** The survey (code, name) a target belongs to, from the loaded survey files. */
  function surveyOf(target, code) {
    const t = FL.parseTarget(target);
    if (t.kind === 'survey') code = t.code;
    else if (t.kind === 'station' && code == null) {
      A.partsOf(t.cave).forEach(({ imp, codes }) => {
        if (code != null) return;
        const s = (imp.parsed.stations || []).find(x => x.name === t.name && codes.has(x.survey || ''));
        if (s) code = s.survey || '';
      });
    }
    if (code == null || t.kind === 'cave') return null;
    let name = '';
    A.partsOf(t.cave).forEach(({ imp }) => { const s = (imp.parsed.surveys || []).find(x => x.code === code); if (s && !name) name = String(s.desc || s.name || ''); });
    return { code, name: name.trim() };
  }
  /** Where the original goes in the project folder (doc 14: one home per file). */
  function homeFolder(target, code, files) {
    const t = FL.parseTarget(target), cave = clean(caveNameOf(t.cave)) || 'Cave';
    const dirs = new Set(files.map(f => f.p.split('/').slice(0, -1).join('/')));
    const sub = p => [...dirs].filter(d => d.startsWith(p + '/') || d === p);
    const caveTop = (sub('Caves').map(d => d.split('/')[1]).filter(Boolean).find(n => n.toLowerCase() === cave.toLowerCase())) || cave;
    const base = 'Caves/' + caveTop;
    const sv = surveyOf(target, code);
    if (!sv) return base + '/' + caveTop + ' - general';
    const have = sub(base).map(d => d.split('/')[2]).filter(Boolean).find(n => n === `${caveTop} - ${sv.code}` || n.startsWith(`${caveTop} - ${sv.code} `));
    return base + '/' + (have || clean(`${caveTop} - ${sv.code} ${sv.name}`));
  }

  // ── Attach ────────────────────────────────────────────────────────────────
  async function needProject() {
    const r = await A.dialog({ title: 'Sketches need a project',
      text: 'A sketch is a scan kept in a project, with its cave, survey or station and, when the project has a folder, in that folder. Open or start a project first.',
      buttons: [{ label: 'Cancel', value: null }, { label: 'New project…', value: 'new', primary: true }] });
    if (r && r.button === 'new') await A.newProject();
  }
  /** Attach scans to a cave, survey or station target. opts: { files, code (survey of a station), kind }. Returns the new document ids. */
  async function attach(target, opts = {}) {
    if (!pj.pid) { await needProject(); return []; }
    if (!(await A.ensureAuthor())) return [];
    let files = opts.files ? Array.from(opts.files) : await A.pickFiles(ACCEPT);
    if (!files.length) return [];
    const bad = files.filter(f => !extOf(f.name));
    bad.forEach(f => A.toast(f.name + ': a sketch is a jpg, png, webp, tiff or PDF scan'));
    files = files.filter(f => extOf(f.name));
    if (!files.length) return [];
    const tr = await tree(true), folder = tr.folder;
    const ids = [];
    for (const f of files) {
      A.toast('Adding ' + f.name);
      const buf = new Uint8Array(await f.arrayBuffer());
      const ext = extOf(f.name), h = FL.sha256(buf);
      const { pages, failed } = await A.filesToPages([f]);
      if (!pages.length || failed.length) { A.toast('Could not read ' + f.name); if (!pages.length) continue; }
      const file = { h, ext, name: f.name, path: '', size: buf.length };
      if (folder) {
        const dir = homeFolder(target, opts.code, tr.files);
        try {
          const r = await fetch('/api/lib/putfile?project=' + encodeURIComponent(pj.pid) + '&h=' + h + '&ext=' + ext + '&path=' + encodeURIComponent(dir + '/' + f.name),
            { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf });
          const o = await r.json();
          if (r.ok && o.path) file.path = o.path; else A.toast('Could not file ' + f.name + ' in the project folder: ' + (o.error || r.status));
        } catch (e) { A.toast('Could not file ' + f.name + ' in the project folder'); }
      }
      if (!file.path) { try { await A.storeBytes(buf, ext); } catch (e) { A.toast('Could not keep the original of ' + f.name); } }
      const id = FL.uid(12), title = f.name.replace(/\.[^.]*$/, '').slice(0, 80);
      const e1 = await A.record('doc.add', { doc: id, title, kind: opts.kind || 'sketch-plan', date: '', pages, tags: [target] }, 'docs', { quiet: true });
      if (!e1) continue;
      await A.record('doc.file', { doc: id, file }, 'docs');
      ids.push(id);
    }
    if (ids.length) { T.at = 0; A.toast(ids.length === 1 ? 'Sketch added to ' + labelOf(target) : ids.length + ' sketches added to ' + labelOf(target)); }
    return ids;
  }
  /** ⋯ → Add sketch… on a cave row (cave_columns.js): the project cave(s) that survey file belongs to. */
  async function addForFile(name) {
    if (!pj.pid) { await needProject(); return; }
    const caves = FL.liveCaves(pj.P).filter(c => (c.sources || []).some(s => s.file === name));
    if (!caves.length) { A.toast('This cave is not in the project yet: move it in first (the arrow on its row), then add sketches'); return; }
    const cid = caves.length === 1 ? caves[0].id : await A.choose('Sketch for which cave?', null, caves.map(c => ({ label: c.name, value: c.id })));
    if (cid) await attach(FL.T.cave(cid));
  }

  // ── Changing a sketch or any file of the view ─────────────────────────────
  const rec = (op, data) => A.record(op, data, 'docs');
  async function rotate(d) {
    for (const p of d.pages) if (p.ext !== 'pdf') await rec('doc.rotate', { doc: d.id, h: p.h, rot: ((p.rot || 0) + 90) % 360, prev: p.rot || 0 });
  }
  async function rename(d) {
    const r = await A.dialog({ title: 'Rename', input: { value: d.title || '', placeholder: 'Title' }, buttons: [{ label: 'Cancel', value: null }, { label: 'Rename', value: 'ok', primary: true }] });
    const t = r && r.value.trim().slice(0, 80);
    if (t && t !== d.title) await rec('doc.set', { doc: d.id, fields: { title: t }, prev: { title: d.title || '' } });
  }
  async function remove(d) {
    const r = await A.dialog({ title: `Remove “${d.title || 'Untitled'}”?`,
      text: 'It leaves the Files views and can be restored from History. The file in the project folder is not deleted.',
      buttons: [{ label: 'Cancel', value: null }, { label: 'Remove', value: 'rm', danger: true }] });
    if (r) await rec('doc.del', { doc: d.id });
  }
  async function setKind(d, kind) { if (d.kind !== kind) await rec('doc.set', { doc: d.id, fields: { kind }, prev: { kind: d.kind || '' } }); }
  async function menu(d) {
    const sk = isSketch(d), canRot = d.pages.some(p => p.ext !== 'pdf');
    const opts = [{ label: ['doc', 'Open'], value: 'open' }];
    if (canRot) opts.push({ label: ['refresh', 'Rotate a quarter turn'], value: 'rot' });
    opts.push({ label: ['pencil', 'Rename…'], value: 'name' }, { label: ['link', 'Links…'], sub: 'which cave, survey or station it is about', value: 'link' });
    if (sk) opts.push({ label: ['pencil', d.kind === 'sketch-profile' ? 'Make it a plan sketch' : 'Make it a profile sketch'], value: 'kind' });
    else opts.push({ label: ['pencil', 'Mark as a sketch'], value: 'mark' });
    opts.push({ label: ['trash', 'Remove…'], value: 'rm' });
    const v = await A.choose(d.title || 'Untitled', A.docSub(d), opts, 'Close');
    if (v === 'open') A.docOpen(d.id, 0);
    else if (v === 'rot') await rotate(d);
    else if (v === 'name') await rename(d);
    else if (v === 'link') await A.editTags(d.id);
    else if (v === 'kind') await setKind(d, d.kind === 'sketch-profile' ? 'sketch-plan' : 'sketch-profile');
    else if (v === 'mark') await setKind(d, 'sketch-plan');
    else if (v === 'rm') await remove(d);
  }

  // ── The Files view ────────────────────────────────────────────────────────
  function thumb(d) {
    const p = d.pages[0], vid = FL.docMedia(d) === 'video';
    if (p && p.ext !== 'pdf') { const im = el('img', 'pj-thumb'); im.loading = 'lazy'; im.src = A.blobUrl(p); im.alt = ''; if (p.rot) im.style.transform = `rotate(${p.rot}deg)`; return im; }
    return el('div', 'pj-thumb pj-thumb-x', vid ? ['video'] : p ? 'PDF' : '—');
  }
  function docRow(d) {
    const r = el('div', 'pj-item pj-doc sk-row');
    r.dataset.doc = d.id;
    r.appendChild(thumb(d));
    const t = el('div', 'sk-t'); t.append(el('div', 'pj-item-t', d.title || 'Untitled'), el('div', 'pj-sub', A.docSub(d)));
    r.appendChild(t);
    if (d.pages.some(p => p.ext !== 'pdf')) { const b = btn(['refresh'], () => rotate(d), 'small sk-rot'); b.title = 'Rotate a quarter turn'; r.appendChild(b); }
    const m = btn(['more'], () => menu(d), 'small sk-more'); m.title = 'Open, rename, links, remove'; r.appendChild(m);
    r.addEventListener('click', () => A.docOpen(d.id, 0));
    return r;
  }
  const size = b => (b > 1 << 20 ? (b / (1 << 20)).toFixed(1) + ' MB' : b > 1024 ? Math.round(b / 1024) + ' kB' : b + ' B');
  function fileRow(f) {
    const name = f.p.split('/').pop(), x = (name.split('.').pop() || '').toLowerCase();
    const r = el('div', 'pj-item sk-gen');
    r.title = f.p;
    r.append(el('div', 'pj-item-t', [VIDEO.test(x) ? 'video' : PHOTO.test(x) ? 'image' : 'doc', name]), el('div', 'pj-sub', f.p.split('/').slice(0, -1).join('/') + ' · ' + size(f.s)));
    r.addEventListener('click', () => {
      if ((VIDEO.test(x) || PHOTO.test(x)) && A.fileOpen) A.fileOpen(f.p);
      else window.open('/api/lib/file?project=' + encodeURIComponent(pj.pid) + '&path=' + encodeURIComponent(f.p), '_blank', 'noopener');
    });
    return r;
  }
  /** Generated files of a cave: its survey export (Caves/<cave>/Survey/). */
  function generated(c) {
    if (c.level !== 'cave' || !c.cid || !T.files.length) return [];
    const cave = clean(caveNameOf(c.cid)).toLowerCase();
    return T.files.filter(f => { const p = f.p.split('/'); return p.length === 4 && p[0] === 'Caves' && p[1].toLowerCase() === cave && p[2] === 'Survey'; })
      .sort((a, b) => a.p.localeCompare(b.p));
  }
  let lastGen = '';
  /**
   * The Files tab body (project.js filesTab): sketches, documents, photos, videos and generated files, then what is
   * further down. Returns the "Add sketch…" button for the row below, or null (the old list is drawn).
   */
  function filesList(box, c, f) {
    const target = A.cardTarget(c);
    if (!pj.pid) return null;
    tree().then(() => { const sig = generated(c).map(x => x.p + x.s).join('|'); if (sig !== lastGen) { lastGen = sig; if (pj.card === c) A.refreshCard(); } });
    const groups = [['Sketches', d => isSketch(d)], ['Documents', d => !isSketch(d) && !FL.docMedia(d)], ['Photos', d => !isSketch(d) && FL.docMedia(d) === 'photo'], ['Videos', d => !isSketch(d) && FL.docMedia(d) === 'video']];
    const wrap = el('div', 'sk-files');
    const paint = (list, into) => groups.forEach(([title, test]) => {
      const ds = list.filter(test);
      if (!ds.length) return;
      into.appendChild(el('div', 'pj-h', `${title} (${ds.length})`));
      ds.forEach(d => into.appendChild(docRow(d)));
    });
    paint(f.own, wrap);
    const gen = generated(c);
    if (gen.length) { wrap.appendChild(el('div', 'pj-h', `Generated files (${gen.length})`)); gen.forEach(x => wrap.appendChild(fileRow(x))); }
    if (!f.own.length && !gen.length && !f.below.length) wrap.appendChild(el('div', 'pj-note', 'No files here yet. Drop a scan here, or use Add sketch…'));
    if (f.below.length) {
      const k = 'below:' + target;
      wrap.appendChild(btn(`${pj.fold === k ? '▾' : '▸'} ${f.below.length} more further down (${c.level === 'cave' ? 'its surveys and stations' : 'its stations'})`, () => { pj.fold = pj.fold === k ? null : k; A.refreshCard(); }, 'link'));
      if (pj.fold === k) paint(f.below, wrap);
    }
    box.appendChild(wrap);
    // Drop a scan on the tab to attach it as a sketch (property handlers: one set per render).
    const files = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    box.ondragover = e => { if (!files(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; box.classList.add('sk-drop'); };
    box.ondragleave = e => { if (!box.contains(e.relatedTarget)) box.classList.remove('sk-drop'); };
    box.ondrop = e => {
      box.classList.remove('sk-drop');
      if (!files(e)) return;
      e.preventDefault(); e.stopPropagation();
      attach(target, { files: e.dataTransfer.files, code: c.survey ? c.code : c.name ? c.code : undefined });
    };
    const add = btn(['plus', 'Add sketch…'], () => attach(target, { code: c.name ? c.code : undefined }), 'primary');
    add.title = 'A scan (jpg, png, webp, tiff or PDF) of a sketch for ' + labelOf(target) + ' — or drop it on this tab';
    return add;
  }

  const st = document.createElement('style');
  st.textContent = `
  .sk-row .sk-t { flex: 1; min-width: 0; }
  .sk-row .pj-btn.small { padding: 2px 5px; flex: none; }
  .sk-gen .pj-item-t { white-space: normal; }
  #pj-card.sk-drop { outline: 2px dashed #6fd39a; outline-offset: -4px; }`;
  document.head.appendChild(st);

  window._sketches = { isSketch, attach, addForFile, filesList, targetLabel: labelOf, ACCEPT, homeFolder, tree };
})();
