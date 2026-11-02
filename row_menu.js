// row_menu.js — the ⋯ menu on every row of 📍 Surface (surface_columns.js puts
// the button in each row's .cc-tools and calls open()).
//
// Item (point, line, area; project, My data, CalTopo; data files):
//   Info · Edit · Rename · Colour · Label on/off · Move to folder · Fly to · Delete
//   Every edit goes through the shared editor (feature_editor.js, window._featEdit),
//   so an item edits the same way from here and from the info panel. Where
//   _featEdit.canEdit says no (data files, CalTopo read without a key that can
//   write), the entries are there but off, with the reason as their tooltip.
// Folder (the row's data-fkey, a folder_style.js key):
//   Display… (window._folderStyle.dialog) · Names on/off (_folderStyle.set labels)
//   · Rename · New subfolder · Move · Delete (asks: move what is inside up one
//   level, or delete it too).
//     project:<gid>   the project's records (group.set / feature.set, undo in 📁 History)
//     mydata:<gid>    My data's records (a sitting's group: no folders inside it)
//     caltopo:<fid>   window._ctWrite (update title / folderId, create a Folder, remove)
//     caltopo:_markers / _lines / _polygons, file:…   display only (FLEX's grouping,
//                     data files are read-only); project:, caltopo:  Display and Names
//
// One menu component: Esc or a click outside closes it, ↑ ↓ move between
// entries, it is kept on screen.
//
// window._rowMenu = {
//   open({ rkey } | { fkey }, anchor)   → the menu element
//   close()
//   entries({ rkey } | { fkey })       → [{ id, label, disabled, title }] (tests)
//   ref(rkey)                          → what _featEdit is handed for a row key
// }
(function () {
  'use strict';
  const FE = () => window._featEdit, FS = () => window._folderStyle, A = () => window._pjApi, W = () => window._ctWrite;
  const PJ = () => window._pj || {}, PF = () => window._pjf, MD = () => window._myData, FL = () => window.FlexLib;
  const ic = (n, s) => (window.icon ? window.icon(n, s || 15) : '');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = t => { const a = A(); if (a && a.toast) a.toast(t); };
  const redraw = () => { if (window._surfCols && window._surfCols.refresh) window._surfCols.refresh(); };
  const ctSrc = () => { const w = window._ws; return (w && w.vectorSources && w.vectorSources().find(s => s.kind === 'caltopo')) || null; };

  // ── The menu ─────────────────────────────────────────────────────────────
  let M = null;
  function close() {
    if (!M) return;
    const m = M; M = null;
    document.removeEventListener('pointerdown', m._off, true);
    document.removeEventListener('keydown', m._key, true);
    window.removeEventListener('resize', close);
    m.remove();
  }
  /** entries: [{ id, icon, label, title, disabled, run } | '-'] */
  function show(title, entries, anchor) {
    close();
    const m = document.createElement('div');
    m.className = 'rm-menu'; m.setAttribute('role', 'menu'); m.id = 'row-menu';
    m.innerHTML = (title ? `<div class="rm-t" title="${esc(title)}">${esc(title)}</div>` : '') + entries.map((x, i) => (x === '-' ? '<div class="rm-sep"></div>'
      : `<button type="button" role="menuitem" data-i="${i}" data-act="${esc(x.id)}"${x.disabled ? ' disabled aria-disabled="true"' : ''}${x.title ? ` title="${esc(x.title)}"` : ''}>${ic(x.icon)}<span>${esc(x.label)}</span></button>`)).join('');
    document.body.appendChild(m);
    // Kept on screen: below the button, or above it; right-aligned to it when wide.
    const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 20, right: 20, top: 20, bottom: 20 };
    const w = m.offsetWidth, h = m.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    let left = r.left; if (left + w > vw - 8) left = r.right - w; left = Math.max(8, Math.min(left, vw - w - 8));
    let top = r.bottom + 3; if (top + h > vh - 8) top = r.top - h - 3; top = Math.max(8, Math.min(top, vh - h - 8));
    m.style.left = left + 'px'; m.style.top = top + 'px';
    const items = () => [...m.querySelectorAll('button:not([disabled])')];
    m._off = e => { if (!m.contains(e.target) && !(anchor && anchor.contains && anchor.contains(e.target))) close(); };
    m._key = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); if (anchor && anchor.focus) anchor.focus(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); const L = items(); if (!L.length) return;
        const i = L.indexOf(document.activeElement), n = e.key === 'ArrowDown' ? (i + 1) % L.length : (i <= 0 ? L.length - 1 : i - 1);
        L[n].focus();
      }
    };
    setTimeout(() => { if (M === m) document.addEventListener('pointerdown', m._off, true); }, 0);
    document.addEventListener('keydown', m._key, true);
    window.addEventListener('resize', close);
    m.addEventListener('click', e => {
      const b = e.target.closest('button[data-i]'); if (!b || b.disabled) return;
      const x = entries[+b.dataset.i]; close();
      Promise.resolve().then(() => x.run()).then(() => redraw()).catch(err => { console.warn('[row menu]', err); toast('That didn’t work: ' + (err.message || err)); });
    });
    M = m;
    const L = items(); if (L[0]) L[0].focus({ preventScroll: true });
    return m;
  }

  // ── Items ────────────────────────────────────────────────────────────────
  /** What _featEdit is handed for a row key. */
  function ref(rkey) {
    rkey = String(rkey || '');
    let m;
    if ((m = rkey.match(/^f:(.+)$/))) return { source: 'project', id: m[1] };
    if ((m = rkey.match(/^my:(.+)$/))) return { source: 'mydata', id: m[1] };
    if (/^ct-/.test(rkey)) { const s = ctSrc(), e = s && s.ds.entities.getById(rkey); return e || { source: 'caltopo', id: rkey.slice(3) }; }
    if ((m = rkey.match(/^e:(.*)#([^#]*)$/))) {
      const w = window._ws, s = w && w.vectorSources().find(x => (x.url || x.name) === m[1]);
      const e = s && s.ds.entities.getById(m[2]); return e || { source: 'file', id: m[2] };
    }
    return null;
  }
  async function askText(title, value, label) {
    const a = A(); if (!a) return null;
    const r = await a.dialog({ title, input: { value: value || '', placeholder: 'Name' }, buttons: [{ label: 'Cancel', value: null }, { label: label || 'Save', value: 'ok', primary: true }] });
    if (!r || r.button !== 'ok') return null;
    const v = String(r.value || '').trim();
    return v || null;
  }
  async function askColour(title, value) {
    const a = A(); if (!a) return null;
    const body = a.el('div', 'rm-form'), col = a.el('input'); col.type = 'color'; col.value = value || '#ffb020'; col.className = 'rm-colour';
    body.appendChild(col);
    const r = await a.dialog({ title, body, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }] });
    return r && r.button === 'ok' ? col.value.toLowerCase() : null;
  }
  /** Pick a folder from [{ id, name, depth }]; top: the label of '' (or none). → id, or null (Cancel). */
  async function askFolder(title, list, current, top) {
    const a = A(); if (!a) return null;
    const body = a.el('div', 'rm-form'), sel = a.el('select', 'pj-input rm-folder');
    if (top) sel.appendChild(new Option(top, ''));
    list.forEach(f => { const o = new Option('  '.repeat(f.depth || 0) + f.name, f.id); if (f.off) o.disabled = true; sel.appendChild(o); });
    sel.value = current || '';
    body.appendChild(sel);
    const r = await a.dialog({ title, body, buttons: [{ label: 'Cancel', value: null }, { label: 'Move', value: 'ok', primary: true }] });
    return r && r.button === 'ok' ? sel.value : null;
  }
  function flyTo(r, rkey) {
    const P = PF(); if (!P || !r || !r.coords || !r.coords.length) return;
    return P.highlight({ kind: r.kind, coords: r.coords, key: /^e:|^ct-/.test(rkey) ? 'e:' + (r.entity ? r.entity.id : rkey) : rkey }, true);
  }
  function info(r) {
    const I = window._info; if (!I || !r) return;
    const s = r.source === 'project' ? I.featureSubject(r.id) : r.entity ? I.subjectOf(r.entity) : null;
    if (!s) { toast('Nothing to show for it'); return; }
    I.show(s); I.expand();
  }
  function itemEntries(rkey) {
    const E = FE(), x = ref(rkey), r = E && x ? E.refOf(x) : null;
    if (!r) return { title: '', list: [] };
    const can = E.canEdit(x), off = !can.ok, why = can.reason || '';
    const ed = (o) => Object.assign(o, off ? { disabled: true, title: why } : {});
    let lab;
    if (r.label == null) lab = { id: 'label', icon: 'tag', label: 'Label on/off', disabled: true, title: off ? why : r.source === 'caltopo' ? 'CalTopo shows the names as the map has them (folder ⋯ → Names for FLEX’s view)' : 'Only points have a label of their own (folder ⋯ → Names)' };
    else lab = ed({ id: 'label', icon: 'tag', label: r.label !== false ? 'Label off' : 'Label on', run: () => E.label(x, r.label === false) });
    const list = [
      { id: 'info', icon: 'info', label: 'Info', run: () => info(r) },
      ed({ id: 'edit', icon: 'pencil', label: 'Edit…', run: () => E.open(x) }),
      ed({ id: 'rename', icon: 'text', label: 'Rename…', run: async () => { const n = await askText(`Rename “${r.name || 'it'}”`, r.name, 'Rename'); if (n && n !== r.name) await E.rename(x, n); } }),
      ed({ id: 'colour', icon: 'palette', label: 'Colour…', run: async () => { const c = await askColour(`Colour of “${r.name || 'it'}”`, r.color); if (c && c !== String(r.color || '').toLowerCase()) await E.colour(x, c); } }),
      lab,
      ed({ id: 'moveto', icon: 'folder-move', label: 'Move to folder…', run: async () => {
        const f = await askFolder(`Move “${r.name || 'it'}” to`, E.folders(x), r.folder, r.source === 'mydata' ? '(no group)' : '(top level)');
        if (f !== null && f !== (r.folder || '')) await E.moveTo(x, f);
      } }),
      Object.assign({ id: 'fly', icon: 'target', label: 'Fly to', run: () => flyTo(r, rkey) }, r.coords && r.coords.length ? {} : { disabled: true, title: 'It has no position' }),
      '-',
      ed({ id: 'delete', icon: 'trash', label: 'Delete…', run: () => E.del(x) }),
    ];
    return { title: r.name || 'Item', list };
  }

  // ── Folders ──────────────────────────────────────────────────────────────
  function split(key) {
    key = String(key || ''); const i = key.indexOf(':');
    return { kind: key.slice(0, i), id: key.slice(i + 1) };
  }
  const LOOSE = /^_(markers|lines|polygons)$/;
  /** Asks what happens to what is inside. → 'up' | 'all' | null; n: how many things inside. */
  async function askDelete(name, n, then) {
    const a = A(); if (!a) return null;
    if (!n) { const r = await a.dialog({ title: `Delete the folder “${name}”?`, text: 'It is empty. ' + then, buttons: [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'all', danger: true }] }); return r ? 'all' : null; }
    const r = await a.dialog({ title: `Delete the folder “${name}”?`, text: `It has ${n} thing${n === 1 ? '' : 's'} inside. What happens to ${n === 1 ? 'it' : 'them'}? ` + then,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Move them up one level', value: 'up', primary: true }, { label: 'Delete them too', value: 'all', danger: true }] });
    return r ? r.button : null;
  }
  function projectFolder(gid) {
    const a = A(), P = PJ().P, L = FL(), g = P && P.groups && P.groups[gid];
    if (!g || g.removed) return [];
    const quiet = { quiet: true };
    const rec = (op, d) => a.record(op, d, undefined, quiet);
    const desc = () => { const ids = new Set([gid]); let grew = true; const gs = L.liveGroups(P); while (grew) { grew = false; gs.forEach(x => { if (ids.has(x.parent) && !ids.has(x.id)) { ids.add(x.id); grew = true; } }); } return ids; };
    return [
      { id: 'rename', icon: 'text', label: 'Rename…', run: async () => { const n = await askText(`Rename the folder “${g.name}”`, g.name, 'Rename'); if (n && n !== g.name) await a.record('group.set', { group: gid, name: n.slice(0, 80) }); } },
      { id: 'newsub', icon: 'folder-plus', label: 'New subfolder…', run: () => PF().editGroup(null, gid) },
      { id: 'move', icon: 'folder-move', label: 'Move…', run: async () => {
        const inside = desc(), list = [];
        const walk = (pid, d) => L.liveGroups(P).filter(x => (x.parent || '') === pid).sort((x, y) => String(x.name).localeCompare(String(y.name), undefined, { numeric: true }))
          .forEach(x => { list.push({ id: x.id, name: x.name || 'Folder', depth: d, off: inside.has(x.id) }); walk(x.id, d + 1); });
        walk('', 0);
        const to = await askFolder(`Move the folder “${g.name}” into`, list, g.parent || '', '(top level)');
        if (to !== null && to !== (g.parent || '') && !inside.has(to)) await a.record('group.set', { group: gid, parent: to });
      } },
      '-',
      { id: 'delete', icon: 'trash', label: 'Delete…', run: async () => {
        const inside = desc(), feats = L.liveFeatures(P).filter(f => inside.has(f.group)), subs = L.liveGroups(P).filter(x => x.id !== gid && inside.has(x.id));
        const how = await askDelete(g.name, feats.length + subs.length, 'Undo in 📁 History.');
        if (!how) return;
        const up = g.parent || '';
        if (how === 'up') {
          await Promise.all(L.liveFeatures(P).filter(f => f.group === gid).map(f => rec('feature.set', { feature: f.id, group: up }))
            .concat(L.liveGroups(P).filter(x => x.parent === gid).map(x => rec('group.set', { group: x.id, parent: up }))));
        } else {
          await Promise.all(feats.map(f => rec('feature.set', { feature: f.id, removed: true })).concat(subs.map(x => rec('group.set', { group: x.id, removed: true }))));
        }
        await rec('group.set', { group: gid, removed: true });
        a.refresh('group.set');
        toast(how === 'up' ? `Deleted “${g.name}”; what was inside moved up one level (undo in 📁 History)` : `Deleted “${g.name}” and everything in it (undo in 📁 History)`);
      } },
    ];
  }
  function myFolder(gid) {
    const S = MD() && MD().cached && MD().cached(), g = S && S.groups && S.groups[gid];
    if (!g) return [];
    const flat = 'A My data group holds points only: no folders inside it';
    return [
      { id: 'rename', icon: 'text', label: 'Rename…', run: async () => { const n = await askText(`Rename “${g.name || 'Points'}”`, g.name, 'Rename'); if (n && n !== g.name) { await MD().record('group.set', { group: gid, name: n.slice(0, 80) }); await MD().state(true); } } },
      { id: 'newsub', icon: 'folder-plus', label: 'New subfolder…', disabled: true, title: flat },
      { id: 'move', icon: 'folder-move', label: 'Move…', disabled: true, title: flat },
      '-',
      { id: 'delete', icon: 'trash', label: 'Delete…', run: async () => {
        const pts = Object.values(S.features || {}).filter(f => !f.removed && f.group === gid);
        const how = await askDelete(g.name || 'Points', pts.length, '');
        if (!how) return;
        const E = FE();
        if (how === 'up') { for (const f of pts) await MD().update(f.id, { group: '' }); }
        else for (const f of pts) { if (E) await E.del({ source: 'mydata', id: f.id }, { confirm: false }); else await MD().forgetPoint({ properties: { myFeature: { getValue: () => f.id } } }); }
        await MD().record('group.set', { group: gid, removed: true });
        await MD().state(true);
        toast(how === 'up' ? `Deleted “${g.name || 'Points'}”; its points are kept, in no group` : `Deleted “${g.name || 'Points'}” and its points`);
      } },
    ];
  }
  function ctFolder(fid) {
    const C = W(), ok = !!(C && (!C.available || C.available())), src = ctSrc();
    const why = !C ? 'Read-only: this FLEX can’t write to CalTopo yet.' : 'Read-only: FLEX can’t write to CalTopo right now (it needs the CalTopo key on this computer, and a key that can write).';
    const ent = src && src.ds.entities.getById('ctf-' + fid);
    const name = (ent && ent.name) || (C && C.feature && C.feature(fid) && C.feature(fid).properties.title) || 'Folder';
    const off = o => Object.assign(o, ok ? {} : { disabled: true, title: why });
    const parentOf = () => { const j = C.feature && C.feature(fid); if (j && j.properties && j.properties.folderId) return String(j.properties.folderId); const p = ent && ent.parent; return p && /^ctf-/.test(p.id) && !LOOSE.test(p.id.slice(4)) ? p.id.slice(4) : null; };
    const ents = () => (src ? src.ds.entities.values : []);
    const under = e => { for (let a = e.parent, n = 0; a && n < 50; a = a.parent, n++) if (a === ent) return true; return false; };
    const bare = id => String(id).replace(/^ctf?-/, '');
    const folderIds = () => { const fs = (C.folders && C.folders()) || []; const kids = new Set([String(fid)]); let grew = true; while (grew) { grew = false; fs.forEach(f => { if (f.folderId && kids.has(String(f.folderId)) && !kids.has(String(f.id))) { kids.add(String(f.id)); grew = true; } }); } return { fs, kids }; };
    return [
      off({ id: 'rename', icon: 'text', label: 'Rename…', run: async () => { const n = await askText(`Rename the CalTopo folder “${name}”`, name, 'Rename'); if (n && n !== name) await C.update(fid, { title: n }); } }),
      off({ id: 'newsub', icon: 'folder-plus', label: 'New subfolder…', run: async () => { const n = await askText(`A new folder in “${name}”`, '', 'Add'); if (n) await C.create({ type: 'Feature', geometry: null, properties: { class: 'Folder', title: n, folderId: fid } }); } }),
      off({ id: 'move', icon: 'folder-move', label: 'Move…', run: async () => {
        const { fs, kids } = folderIds(), list = [];
        const walk = (pid, d) => fs.filter(f => String(f.folderId || '') === pid).sort((x, y) => String(x.title).localeCompare(String(y.title), undefined, { numeric: true }))
          .forEach(f => { list.push({ id: String(f.id), name: f.title || 'Folder', depth: d, off: kids.has(String(f.id)) }); walk(String(f.id), d + 1); });
        walk('', 0);
        const cur = parentOf() || '';
        const to = await askFolder(`Move the CalTopo folder “${name}” into`, list, cur, '(top level)');
        if (to !== null && to !== cur && !kids.has(to)) await C.update(fid, { folderId: to || null });
      } }),
      '-',
      off({ id: 'delete', icon: 'trash', label: 'Delete…', run: async () => {
        const all = ents().filter(under), direct = all.filter(e => e.parent === ent);
        const how = await askDelete(name, all.length, 'This changes the CalTopo map, for everyone who uses it.');
        if (!how) return;
        if (how === 'up') { const up = parentOf(); for (const e of direct) await C.update(bare(e.id), { folderId: up }); }
        else for (const e of all.slice().reverse()) await C.remove(bare(e.id));
        await C.remove(fid);
      } }),
    ];
  }
  function folderEntries(fkey) {
    const S = FS(), k = split(fkey);
    const title = S && S.label ? S.label(fkey) : 'Folder';
    const list = [{ id: 'display', icon: 'sliders', label: 'Display…', title: 'Names, colour, line width, symbol, opacity for everything inside', run: () => S.dialog(fkey) }];
    const displayOnly = k.kind === 'file' || (k.kind === 'caltopo' && LOOSE.test(k.id));
    if (displayOnly) return { title, list };
    const cur = S ? (S.get(fkey) || {}) : {}, on = cur.labels !== false;
    list.push({ id: 'names', icon: 'tag', label: on ? 'Names off' : 'Names on', title: on ? 'Hide the names of everything inside' : 'Show the names of everything inside', run: () => S.set(fkey, { labels: !on }) });
    let more = [];
    if (k.kind === 'project' && k.id) more = projectFolder(k.id);
    else if (k.kind === 'mydata' && k.id) more = myFolder(k.id);
    else if (k.kind === 'caltopo' && k.id) more = ctFolder(k.id);
    if (more.length) list.push('-', ...more);
    return { title, list };
  }

  function build(o) { return o && o.rkey ? itemEntries(o.rkey) : o && o.fkey != null ? folderEntries(o.fkey) : { title: '', list: [] }; }
  function open(o, anchor) {
    if (M && anchor && M._anchor === anchor) { close(); return null; }     // the same ⋯ again: closes
    const b = build(o);
    if (!b.list.length) { toast('Nothing to do with it here'); return null; }
    const m = show(b.title, b.list, anchor);
    m._anchor = anchor;
    return m;
  }
  const entries = o => build(o).list.filter(x => x !== '-').map(x => ({ id: x.id, label: x.label, disabled: !!x.disabled, title: x.title || '' }));

  const st = document.createElement('style');
  st.textContent = `
  .rm-menu { position: fixed; z-index: 9950; min-width: 180px; max-width: 280px; background: rgba(20,22,30,.98); border: 1px solid rgba(255,255,255,.15); border-radius: 7px; padding: 4px; display: flex; flex-direction: column; box-shadow: 0 10px 30px rgba(0,0,0,.5); font: 12px system-ui, sans-serif; color: #e8ece9; }
  .rm-menu .rm-t { color: rgba(255,255,255,.55); font-size: 11px; padding: 3px 8px 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rm-menu button { display: flex; align-items: center; gap: 8px; background: none; border: none; color: inherit; text-align: left; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .rm-menu button:hover:not([disabled]), .rm-menu button:focus-visible { background: rgba(255,255,255,.09); outline: none; }
  .rm-menu button:focus-visible { box-shadow: inset 0 0 0 1px var(--ui-focus, #8ab4ec); }
  .rm-menu button[disabled] { opacity: .4; cursor: default; }
  .rm-menu button[data-act="delete"]:not([disabled]) { color: #ff8a7a; }
  .rm-menu .rm-sep { height: 1px; background: rgba(255,255,255,.1); margin: 3px 4px; }
  .rm-form { margin: 6px 0; } .rm-colour { width: 60px; height: 30px; padding: 0; border: none; background: none; } .rm-folder { width: 100%; }`;
  document.head.appendChild(st);

  window._rowMenu = { open, close, entries, ref, get el() { return M; } };
})();
