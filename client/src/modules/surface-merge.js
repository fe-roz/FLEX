// surface-merge.js — the ONE tree of 📍 Surface: CalTopo is the master, the project's folders and items are merged in.
//
//   window._surfMerge (and module.exports under Node, for tools/test_surface_merge.js: the pure part)
//
//   build({ ct, groups, feats, moved }) → root
//       ct      [{ id, name, folder, loose?, kids: [...] }]   the CalTopo map's tree (entities: 'ctf-…' folders, 'ct-…' items)
//       groups  [{ id, name, parent }]                         the project's live folders
//       feats   [{ id, name, group, kind }]                    the project's items that are NOT in CalTopo (still to send)
//       moved   { <ct id>: [folder names] }                    CalTopo things held to move into a folder that is not in CalTopo yet
//       A project folder is the CalTopo folder of the same name under the same parent (case-insensitive, trimmed: the
//       matching Send uses); a project folder with no CalTopo folder is "to send". Items already in CalTopo are not
//       passed in: they show once, as the CalTopo item.
//     node: { name, path:[names], ct: ctNode|null, gid, gids:[…], toSend, kids:[node], items:[leaf] }
//     leaf: { name, ct: ctNode|null, feat: feat|null }
//   find(root, path) → node | null          sendCount(node) → { items, folders } still to send in it
//   within(a, b) → b is a, or inside a
//
// Browser part: ensureGroupPath(names) → project folder id (made when missing); drop(token, path, root) → the move the
// drag and drop asks for. CalTopo things are held (caltopo-write.js) until Send; project things move at once.
(function (root, factory) {
  const M = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = M;
  else root._surfMerge = M;
})(typeof window !== 'undefined' ? window : this, function (root) {
  'use strict';
  const norm = s => String(s == null ? '' : s).trim().toLowerCase();
  const cmp = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true });
  const mk = (name, path) => ({ name, path, ct: null, gid: null, gids: [], toSend: false, kids: [], items: [], fmap: new Map() });

  function build({ ct, groups, feats, moved }) {
    const rootN = mk('', []);
    moved = moved || {};
    const deferred = [];
    const addCt = (par, c, mv) => {
      const key = norm(c.name);
      let n = par.fmap.get(key);
      if (!n || n.ct) { const fresh = mk(c.name, par.path.concat(c.name)); if (!n) par.fmap.set(key, fresh); n = fresh; par.kids.push(n); }
      n.ct = c; if (mv) n.moved = true;     // (a project-only node of that name is reused: it was added to the tree already)
      (c.kids || []).forEach(k => place(n, k));
    };
    const place = (par, c) => {
      if (moved[c.id] && !c.loose) { deferred.push({ par, c }); return; }
      if (c.folder) addCt(par, c); else par.items.push({ name: c.name, ct: c, feat: null });
    };
    (ct || []).forEach(c => place(rootN, c));

    const gs = groups || [], byParent = new Map();
    gs.forEach(g => { const k = g.parent || ''; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(g); });
    const known = new Set(gs.map(g => g.id));
    const fBy = new Map();
    (feats || []).forEach(f => { const k = f.group && known.has(f.group) ? f.group : ''; if (!fBy.has(k)) fBy.set(k, []); fBy.get(k).push(f); });
    const addGroup = (par, g) => {
      const key = norm(g.name);
      let n = par.fmap.get(key);
      if (!n) { n = mk(g.name || 'Folder', par.path.concat(g.name || 'Folder')); n.toSend = true; par.fmap.set(key, n); par.kids.push(n); }
      n.gids.push(g.id); if (!n.gid) n.gid = g.id;
      (byParent.get(g.id) || []).forEach(c => addGroup(n, c));
      (fBy.get(g.id) || []).forEach(f => n.items.push({ name: f.name || '', ct: null, feat: f }));
    };
    (byParent.get('') || []).forEach(g => addGroup(rootN, g));
    // groups whose parent is gone are treated as top level
    gs.filter(g => g.parent && !known.has(g.parent)).forEach(g => addGroup(rootN, g));
    (fBy.get('') || []).forEach(f => rootN.items.push({ name: f.name || '', ct: null, feat: f }));

    // held moves into a folder that is not in CalTopo yet (found by name path); else they stay where CalTopo has them
    deferred.forEach(({ par, c }) => {
      const t = find(rootN, moved[c.id]);
      const to = t || par;
      if (c.folder) addCt(to, c, !!t);
      else to.items.push({ name: c.name, ct: c, feat: null, moved: !!t });
    });

    const order = n => {
      n.kids.sort((a, b) => ((a.ct ? 0 : 1) - (b.ct ? 0 : 1)) || (a.ct ? 0 : cmp(a, b)));
      n.items.sort((a, b) => ((a.ct ? 0 : 1) - (b.ct ? 0 : 1)) || (a.ct ? 0 : cmp(a, b)));
      n.kids.forEach(order);
    };
    order(rootN);
    return rootN;
  }
  function find(rootN, path) {
    let n = rootN;
    for (const nm of path || []) {
      n = n.kids.find(k => norm(k.name) === norm(nm));
      if (!n) return null;
    }
    return n;
  }
  const within = (a, b) => !!a && !!b && b.path.length >= a.path.length && a.path.every((x, i) => norm(x) === norm(b.path[i]));
  function sendCount(n) {
    let items = n.items.filter(i => i.feat).length, folders = n.toSend && n.path.length ? 1 : 0;
    n.kids.forEach(k => { const c = sendCount(k); items += c.items; folders += c.folders; });
    return { items, folders };
  }
  if (typeof window === 'undefined') return { build, find, within, sendCount, norm };

  // ══ In the browser ═══════════════════════════════════════════════════════
  const A = () => window._pjApi, PJ = () => window._pj || {}, FL = () => window.FlexLib, W = () => window._ctWrite;
  const toast = m => { const a = A(); if (a && a.toast) a.toast(m); };

  /** The project folder at this name path, made (parents first) when it isn't there. '' for the top level. */
  async function ensureGroupPath(names) {
    const a = A(), P = PJ().P, L = FL();
    if (!names || !names.length) return '';
    const live = L.liveGroups(P);
    let parent = '', made = false;
    for (const nm of names) {
      const hit = !made && live.find(g => (g.parent || '') === parent && norm(g.name) === norm(nm));
      if (hit) { parent = hit.id; continue; }
      const id = L.uid(10);
      await a.record('group.set', { group: id, name: String(nm).slice(0, 80), parent }, undefined, { quiet: true });
      parent = id; made = true;
    }
    if (made && a.refresh) a.refresh('group.set');
    return parent;
  }

  /**
   * The drag and drop. token: 'ct:<entity id>' (a CalTopo item or folder) · 'f:<project item>' · 'g:<project folder>' ·
   * 'my:<My data point>'; path: the target folder's names ([] = the map). → a short message, or '' when nothing happened.
   * CalTopo things are held (Send); project things move now; My data points wait for 💾 Save (the usual move).
   */
  async function drop(token, path, rootN) {
    const a = A(), w = W(), P = PJ().P, L = FL();
    const target = find(rootN, path);
    if (!target) return '';
    const m = /^(ct|f|g|my):(.+)$/.exec(token || '');
    if (!m) return '';
    const kind = m[1], id = m[2];
    const grp = async () => (target.gid ? target.gid : ensureGroupPath(path));
    if (kind === 'ct') {
      if (!w || !w.available()) return 'The CalTopo map is not loaded.';
      const folder = /^ctf-/.test(id), fid = id.replace(/^ctf?-/, '');
      const src = folder ? (function walk(n) { if (n.ct && n.ct.id === id) return n; for (const k of n.kids) { const r = walk(k); if (r) return r; } return null; })(rootN) : null;
      if (src && within(src, target)) return 'A folder can’t go into itself.';
      const parentId = target.ct && /^ctf-/.test(target.ct.id) && !target.ct.loose ? target.ct.id.slice(4) : null;
      if (target.ct && !target.ct.loose && parentId) await w.update(fid, { folderId: parentId }, { quiet: true });
      else if (!path.length || (target.ct && target.ct.loose)) await w.update(fid, { folderId: null }, { quiet: true });
      else await w.update(fid, {}, { toPath: path, quiet: true });
      if (src && src.gids.length) {                       // its project folders go along, so they still match it by name
        const to = await grp();
        for (const g of src.gids) if (g !== to && to !== g) await a.record('group.set', { group: g, parent: to }, undefined, { quiet: true });
        if (a.refresh) a.refresh('group.set');
      }
      return 'held';
    }
    if (kind === 'f') {
      const to = await grp();
      await a.record('feature.set', { feature: id, group: to });
      return 'moved';
    }
    if (kind === 'g') {
      const to = await grp();
      const inside = new Set([id]); let grew = true;
      while (grew) { grew = false; L.liveGroups(P).forEach(g => { if (inside.has(g.parent) && !inside.has(g.id)) { inside.add(g.id); grew = true; } }); }
      if (inside.has(to)) return 'A folder can’t go into itself.';
      await a.record('group.set', { group: id, parent: to });
      return 'moved';
    }
    if (kind === 'my') {
      const pw = window._pjWs;
      if (!pw || !pw.moveItem) return '';
      if (pw.movingItem('point', id) === 'in') return 'It is already waiting to move into the project.';
      const S = window._myData && (await window._myData.state());
      const f = S && S.features && S.features[id];
      await pw.moveItem({ kind: 'point', id, name: (f && f.name) || 'Point', dir: 'in', target: path.slice() });
      return 'queued';
    }
    return '';
  }
  return { build, find, within, sendCount, norm, ensureGroupPath, drop };
});
