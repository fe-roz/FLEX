// docs_panel.js — 📄 Docs: the open project's folder as it is on disk.
//
// Every file under the project folder but .flex (/api/lib/tree), as folders
// with counts. A file FLEX knows as a document (its original, doc.file)
// opens in the document viewer; any other file opens in a new tab
// (/api/lib/file, read only). "To sort" is flagged when it has files.
// The documents list (inbox, tags, ＋ Add files) follows below (project.js).
(function () {
  'use strict';
  const A = window._pjApi;
  if (!A) return;
  const { pj, FL, el, btn, esc } = A;
  const S = { pid: null, tree: null, folder: null, open: new Set(['']), loading: false, at: 0, q: '' };
  window._pjDocsState = S;                               // tests

  async function load(force) {
    if (!pj.pid) return;
    if (S.loading || (!force && S.pid === pj.pid && S.tree && Date.now() - S.at < 15000)) return;
    S.loading = true;
    try {
      const r = await fetch('/api/lib/tree?project=' + encodeURIComponent(pj.pid));
      const o = r.ok ? await r.json() : { folder: null, files: [] };
      if (S.pid !== pj.pid) S.open = new Set(['']);
      S.pid = pj.pid; S.folder = o.folder; S.tree = o.files || []; S.at = Date.now();
    } catch (e) { console.warn('[docs]', e); }
    finally { S.loading = false; }
    A.render();
  }
  const icon = n => { const x = (n.split('.').pop() || '').toLowerCase();
    return /^(mp4|m4v|mov|webm|mkv)$/.test(x) ? '🎞' : /^(jpe?g|png|webp|gif|tiff?)$/.test(x) ? '🖼' : x === 'pdf' ? '📄' : /^(plt|dat|svx|mak|th|tro)$/.test(x) ? '🕳' : /^(kml|kmz|gpx|geojson|json)$/.test(x) ? '🗺' : /^(txt|md|csv|docx?|odt|rtf)$/.test(x) ? '📝' : '•'; };
  const size = b => (b > 1 << 20 ? (b / (1 << 20)).toFixed(1) + ' MB' : b > 1024 ? Math.round(b / 1024) + ' kB' : b + ' B');

  function build(files) {
    const root = { name: '', path: '', dirs: new Map(), files: [], n: 0 };
    files.forEach(f => {
      const parts = f.p.split('/');
      let d = root; d.n++;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts.slice(0, i + 1).join('/');
        if (!d.dirs.has(parts[i])) d.dirs.set(parts[i], { name: parts[i], path: p, dirs: new Map(), files: [], n: 0 });
        d = d.dirs.get(parts[i]); d.n++;
      }
      d.files.push(f);
    });
    return root;
  }
  function docsByPath() {
    const m = new Map();
    if (pj.D && pj.P) FL.docsOf(pj.D, pj.P).forEach(d => { if (d.file && d.file.path) m.set(d.file.path, d); });
    return m;
  }
  function open(f) {
    const d = docsByPath().get(f.p);
    if (d && A.docOpen) { A.docOpen(d.id); return; }
    window.open('/api/lib/file?project=' + encodeURIComponent(pj.pid) + '&path=' + encodeURIComponent(f.p), '_blank', 'noopener');
  }

  function tree(root, section) {
    if (!pj.pid) return;
    if (S.pid !== pj.pid || !S.tree) load(true);
    section(root, 'Project folder', true, b => {
      if (S.pid !== pj.pid || !S.tree) { b.appendChild(el('div', 'pj-sub', 'Reading the folder…')); return; }
      if (!S.folder) { b.appendChild(el('div', 'pj-note', 'This project has no folder of its own yet (it is still in the old library).')); return; }
      const top = el('div', 'pj-row');
      const path = el('span', 'pjd-path', S.folder);
      path.title = 'Click to copy the path';
      path.addEventListener('click', () => { try { navigator.clipboard.writeText(S.folder); A.toast('Folder path copied'); } catch (_) {} });
      top.appendChild(path);
      top.appendChild(btn('⟳', () => load(true), 'small'));
      b.appendChild(top);
      const find = el('input', 'pj-input pjd-find'); find.placeholder = 'Find a file…'; find.value = S.q;
      find.addEventListener('input', () => { S.q = find.value; paint(); });
      b.appendChild(find);
      const list = el('div', 'pjd-tree');
      b.appendChild(list);
      const docs = docsByPath();
      const row = (f, depth) => {
        const name = f.p.split('/').pop();
        const r = el('div', 'pjd-file');
        r.style.paddingLeft = (6 + depth * 14) + 'px';
        const d = docs.get(f.p);
        r.innerHTML = `<span>${icon(name)}</span><span class="pjd-n" title="${esc(f.p)}">${esc(name)}${d ? ' <span class="pjd-doc" title="A document in FLEX: opens with its pages and tags">doc</span>' : ''}</span><span class="pj-sub">${size(f.s)}</span>`;
        r.addEventListener('click', () => open(f));
        return r;
      };
      function paint() {
        list.textContent = '';
        const files = S.q ? S.tree.filter(f => f.p.toLowerCase().includes(S.q.toLowerCase())) : S.tree;
        if (S.q) { files.slice(0, 300).forEach(f => list.appendChild(row(f, 0))); if (!files.length) list.appendChild(el('div', 'pj-sub', 'No file matches.')); return; }
        const T = build(files);
        const dir = (d, depth) => {
          const ds = [...d.dirs.values()].sort((a, c) => (a.name === 'To sort') - (c.name === 'To sort') || a.name.localeCompare(c.name, undefined, { numeric: true }));
          ds.forEach(x => {
            const isOpen = S.open.has(x.path);
            const r = el('div', 'pjd-dir' + (x.name === 'To sort' && x.n ? ' pjd-sort' : ''));
            r.style.paddingLeft = (2 + depth * 14) + 'px';
            r.innerHTML = `<span>${isOpen ? '▾' : '▸'}</span><span>${x.name === 'To sort' ? '📥' : '📁'} ${esc(x.name)}</span><span class="pj-sub">${x.n}</span>`;
            r.addEventListener('click', () => { if (isOpen) S.open.delete(x.path); else S.open.add(x.path); paint(); });
            list.appendChild(r);
            if (isOpen) dir(x, depth + 1);
          });
          d.files.sort((a, c) => a.p.localeCompare(c.p, undefined, { numeric: true })).slice(0, 500).forEach(f => list.appendChild(row(f, depth)));
        };
        if (!S.tree.length) { list.appendChild(el('div', 'pj-note', 'The folder is empty.')); return; }
        dir(T, 0);
      }
      paint();
      b.appendChild(el('div', 'pj-note', `${S.tree.length} file${S.tree.length === 1 ? '' : 's'}. A file lives in one folder; what it is about shows in the documents below (tags). Files open read only.`));
    });
  }

  const st = document.createElement('style');
  st.textContent = `
  .pj-side { width: 440px; max-width: 100%; }
  .pjd-path { font: 10px ui-monospace, Consolas, monospace; color: rgba(255,255,255,.5); word-break: break-all; cursor: copy; flex: 1; }
  .pjd-find { margin: 4px 0; }
  .pjd-tree { max-height: 46vh; overflow-y: auto; border: 1px solid rgba(255,255,255,.08); border-radius: 6px; padding: 3px 0; }
  .pjd-dir, .pjd-file { display: grid; grid-template-columns: 14px 1fr auto; gap: 6px; align-items: center; padding: 2px 8px 2px 6px; cursor: pointer; font-size: 11.5px; }
  .pjd-dir, .pjd-file { color: #e8ece9; }
  .pjd-dir { font-weight: 600; }
  .pjd-dir:hover, .pjd-file:hover { background: rgba(255,255,255,.07); }
  .pjd-sort { color: #f2c24e; }
  .pjd-n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pjd-doc { font-size: 9px; color: #6fd39a; border: 1px solid rgba(111,211,154,.5); border-radius: 6px; padding: 0 4px; margin-left: 3px; }`;
  document.head.appendChild(st);

  window._pjDocs = { tree, load };
})();
