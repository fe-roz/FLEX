// caltopo-send.js — hand project items over to the CalTopo map, only when the person asks.
//
//   window._ctSend (and module.exports under Node, for tools/test_caltopo_send.js: the pure part)
//
//   send({ feature: id } | { group: gid } | { all: true })   preview → confirm → send → summary
//   notIn(P, src)        the project's features that are not in CalTopo (caltopo-match.js, minus the ones
//                        already sent: see "The link")
//   notInIds(P, src)     the same as a Set of ids, or null with no CalTopo map loaded
//   isNotIn(f)           one feature
//   can()                '' or why nothing can be sent now (no private CalTopo map loaded …)
//   reminder()           null | { n, old, html } — the note for 📍 Surface: at least one item not in CalTopo (can't be
//                        dismissed; it goes by itself when nothing is left) / edits waiting > 1 day
//   highlight(on?)       marks every not-in-CalTopo item on the map (a halo) and, in 📍 Surface, its row (toggles);
//                        hlSync() keeps it current as items are sent (ends by itself when none is left); hlOn()
//   removeCopies(list)   the separate, confirmed step: take items out of the project once they are in CalTopo
//   parseTag(desc) / makeTag(cave, station, {z, id})   cave entrance tags (see below)
//
// What goes: a point → a CalTopo Marker; a line or an area → a Shape (LineString / Polygon), each with name,
// description, colour and (points) symbol. Folders: the project folder path is matched by name against the
// CalTopo folders (case-insensitive); the missing ones are created, parents first. Nothing is sent without the
// preview and the person's OK, and the writes go out one after the other (caltopo_api.js spaces them ≥ 1 s).
//
// The link: after CalTopo takes an item, the project feature records `style.ct = { map, fid }` (a feature.set,
// so it travels with the project and 📁 History shows it). A feature with a link to a feature the loaded map has
// is "in CalTopo" and is never sent twice; if CalTopo's feature is later deleted, the link stops counting. Sent
// while CalTopo was unreachable: `{ map, fid: null }`, which counts while the edit waits in the queue; once it is
// sent, caltopo-match.js (same kind, name, within 15 m) pairs the two. _ctMatch itself pairs by name and place
// only — it has no stored link.
//
// Cave entrance tags (a point's description, one line):
//   flex: cave=<name>; station=<station>; z=<metres>; id=<cave id>
// z (height of the entrance) and id (the cave's id in the project) are optional: tags without them, as older
// FLEX wrote them, read as before, and FlexLib.flexTag (which only knows cave and station) skips the extra keys.
(function (root, factory) {
  const M = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = M;
  else root._ctSend = M;
})(typeof window !== 'undefined' ? window : this, function (root) {
  'use strict';
  const BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

  // ── Entrance tags ─────────────────────────────────────────────────────────
  function parseTag(desc) {
    const m = /(?:^|\n|>)\s*flex\s*:\s*([^\n<]+)/i.exec(String(desc || ''));
    if (!m) return null;
    const kv = {};
    m[1].split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) kv[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim(); });
    if (!kv.cave) return null;
    const out = { cave: kv.cave, station: kv.station || '' };
    const z = kv.z !== undefined && kv.z !== '' ? Number(kv.z) : NaN;
    if (isFinite(z)) out.z = z;
    if (kv.id) out.id = kv.id;
    return out;
  }
  function makeTag(cave, station, extra) {
    const x = extra || {};
    let s = `flex: cave=${cave}; station=${station}`;
    if (x.z != null && isFinite(+x.z)) s += `; z=${+(+x.z).toFixed(1)}`;
    if (x.id) s += `; id=${String(x.id).replace(/[;\n]/g, ' ')}`;
    return s;
  }

  // ── What CalTopo gets ─────────────────────────────────────────────────────
  const hex = c => { const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim()); return m ? m[1].toUpperCase() : 'FFB020'; };
  const KIND = { point: 'Point', line: 'Line', area: 'Area' };
  const titleOf = f => String(f.name || KIND[f.kind] || 'Feature').slice(0, 120);
  /** A project feature as a CalTopo feature (Marker or Shape). colour: '#rrggbb'. */
  function toCalTopo(f, folderId, colour) {
    const c = (f.coords || []).filter(p => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])).map(p => [+p[0], +p[1]]);
    const props = { title: titleOf(f), description: String(f.desc || '') };
    if (folderId) props.folderId = String(folderId);
    let geometry;
    if (f.kind === 'point') {
      geometry = { type: 'Point', coordinates: c[0] };
      props.class = 'Marker'; props['marker-color'] = hex(colour); props['marker-symbol'] = (f.style && f.style.symbol) || 'point';
    } else if (f.kind === 'area') {
      const ring = c.slice(); if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) ring.push(ring[0]);
      geometry = { type: 'Polygon', coordinates: [ring] };
      props.class = 'Shape'; props.stroke = hex(colour); props['stroke-width'] = 2; props.fill = hex(colour); props['fill-opacity'] = 0.25;
    } else {
      geometry = { type: 'LineString', coordinates: c };
      props.class = 'Shape'; props.stroke = hex(colour); props['stroke-width'] = 3;
    }
    return { type: 'Feature', geometry, properties: props };
  }
  /**
   * The folders to find or create, and which item goes where.
   *   P: the project (groups), feats: the features to send, ctFolders: [{id, title, folderId}] CalTopo has,
   *   pathOf(groupId) → [names] from the top.
   * → { folders: [{ key, name, parent: key|null, id: existing id | null }], items: [{ f, folder: key|null }] }
   */
  function plan(feats, ctFolders, pathOf) {
    const norm = s => String(s || '').trim().toLowerCase();
    const folders = [], byKey = new Map(), items = [];
    const find = (parentId, name) => (ctFolders || []).find(x => String(x.folderId || '') === String(parentId || '') && norm(x.title) === norm(name));
    feats.forEach(f => {
      const names = f.group ? pathOf(f.group) : [];
      let parentKey = null, parentId = null, known = true;
      names.forEach(nm => {
        const key = (parentKey || '') + '\u0001' + norm(nm);
        if (!byKey.has(key)) {
          const ex = known ? find(parentId, nm) : null;
          const fo = { key, name: String(nm || 'Folder'), parent: parentKey, id: ex ? String(ex.id) : null };
          byKey.set(key, fo); folders.push(fo);
        }
        const fo = byKey.get(key);
        known = known && !!fo.id; parentId = fo.id; parentKey = key;
      });
      items.push({ f, folder: parentKey });
    });
    return { folders, items };
  }

  if (!BROWSER) return { parseTag, makeTag, toCalTopo, plan, hex };

  // ══ In the browser ════════════════════════════════════════════════════════
  const A = () => window._pjApi, W = () => window._ctWrite, M = () => window._ctMatch, FL = () => window.FlexLib;
  const PJ = () => window._pj || {};
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ic = (n, s) => (window.icon ? window.icon(n, s || 14) : '');
  const toast = m => { const a = A(); if (a && a.toast) a.toast(m); };
  const ctSrc = () => { const w = window._ws; return (w && w.vectorSources && w.vectorSources().find(s => s.kind === 'caltopo')) || null; };
  let busy = false;

  /** Why nothing can be sent now ('' when it can). */
  function can() {
    const pj = PJ(), w = W();
    if (!pj.pid || !pj.P) return 'Open the project first.';
    if (!w || !w.available()) return 'Load the project’s CalTopo map with a key that can write first (📍 Surface → CalTopo map).';
    if (!ctSrc()) return 'The project’s CalTopo map is not loaded.';
    return '';
  }
  const linked = f => {
    const c = f.style && f.style.ct, w = W();
    if (!c || !w || !w.available() || c.map !== w.mapId()) return false;
    if (c.fid) return w.has(c.fid);
    const t = titleOf(f);
    return w.pending().some(p => p.what === 'create' && p.state === 'waiting' && p.title === t);
  };
  function notIn(P, src) {
    const m = M();
    if (!m || !P) return [];
    if (src === undefined) src = ctSrc();
    if (!src) return [];
    return m.unmatched(P, src).filter(f => !linked(f));
  }
  function notInIds(P, src) {
    if (src === undefined) src = ctSrc();
    if (!src || !M() || !P) return null;
    try { return new Set(notIn(P, src).map(f => f.id)); } catch (e) { console.warn('[ctsend]', e); return null; }
  }
  const isNotIn = f => { const s = ctSrc(); return !!(s && M() && !M().matchFeature(f, s) && !linked(f)); };

  // ── The note in 📍 Surface ────────────────────────────────────────────────
  // The highlight: a halo on the map for every item that is not in CalTopo (a data source of its own).
  let hlFlag = false, hlSig = '', hlDs = null;
  function hlSync() {
    const v = window.cesiumViewer, pj = PJ();
    const list = hlFlag && pj.P && window.Cesium ? notIn(pj.P) : [];
    if (hlFlag && !list.length) hlFlag = false;                 // nothing left: it ends by itself
    const sig = hlFlag ? list.map(f => f.id + ':' + (f.coords || []).length).join('|') : '';
    if (sig === hlSig) return hlFlag;
    hlSig = sig;
    if (!v || !window.Cesium) return hlFlag;
    if (!hlDs) { hlDs = new Cesium.CustomDataSource('ct-notin-highlight'); v.dataSources.add(hlDs); }
    hlDs.entities.removeAll();
    const C = Cesium.Color.fromCssColorString('#ff6a00');
    list.forEach(f => {
      const pos = (f.coords || []).map(p => Cesium.Cartesian3.fromDegrees(p[0], p[1], p[2] || 0));
      if (!pos.length) return;
      if (f.kind === 'point') hlDs.entities.add({ position: pos[0], properties: { ctNotInHl: f.id }, point: { pixelSize: 26, color: C.withAlpha(0.22), outlineColor: C, outlineWidth: 3, heightReference: Cesium.HeightReference.CLAMP_TO_TERRAIN, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      else hlDs.entities.add({ properties: { ctNotInHl: f.id }, polyline: { positions: f.kind === 'area' ? pos.concat([pos[0]]) : pos, width: 8, material: new Cesium.PolylineGlowMaterialProperty({ color: C, glowPower: 0.3 }), clampToGround: true, classificationType: Cesium.ClassificationType.TERRAIN } });
    });
    if (v.scene.requestRender) v.scene.requestRender();
    return hlFlag;
  }
  function highlight(on) { hlFlag = on === undefined ? !hlFlag : !!on; hlSig = hlFlag ? '' : hlSig; if (!hlFlag) hlSig = 'x'; return hlSync(); }
  function reminder() {
    const w = W(), pj = PJ();
    if (!w || !w.available() || !pj.P) return null;
    const n = notIn(pj.P).length;
    const old = w.pending().filter(p => p.state === 'waiting' && Date.now() - (p.at || 0) > 86400000).length;
    const bits = [];
    if (n >= 1) bits.push(`${n} item${n === 1 ? '' : 's'} not in CalTopo — <button type="button" class="sc-link" data-tool="ctsend">Send…</button> · <button type="button" class="sc-link${hlFlag ? ' sc-on' : ''}" data-tool="cthl" title="${hlFlag ? 'Remove the marks' : 'Mark them on the map and in the list'}">${hlFlag ? 'Clear highlight' : 'Highlight'}</button>`);
    if (old) bits.push(`${old} edit${old === 1 ? '' : 's'} waiting for CalTopo for over a day — <button type="button" class="sc-link" data-tool="ctretry">Try now</button>`);
    if (!bits.length) return null;
    return { n, old, html: `<div class="sc-remind" data-ctremind>${ic('info', 13)} <span>${bits.join(' · ')}</span></div>` };
  }

  // ── Sending ───────────────────────────────────────────────────────────────
  function pick(target, P) {
    const FLb = FL(), all = notIn(P);
    if (target.feature) return all.filter(f => f.id === target.feature);
    if (target.group) return all.filter(f => FLb.groupPath(P, f.group).some(g => g.id === target.group));
    return all;
  }
  const pathOf = (P, gid) => FL().groupPath(P, gid).map(g => g.name || 'Folder');
  const colourOf = f => (window._pjf && window._pjf.colorOf ? window._pjf.colorOf(f) : (f.style && f.style.color)) || '#ffb020';

  function preview(P, pl, single) {
    const a = A();
    const folderNew = pl.folders.filter(x => !x.id);
    const rows = pl.items.slice(0, 200).map(it => {
      const p = it.f.group ? pathOf(P, it.f.group).join(' / ') : '';
      return `<div class="cts-row"><span class="cts-k">${KIND[it.f.kind] || ''}</span> <b>${esc(titleOf(it.f))}</b>${p ? ` <span class="cts-p">→ ${esc(p)}</span>` : ''}</div>`;
    }).join('') + (pl.items.length > 200 ? `<div class="cts-p">… and ${pl.items.length - 200} more</div>` : '');
    const n = pl.items.length;
    const html = `<style>.cts-list{max-height:34vh;overflow:auto;margin:6px 0;font-size:12px}.cts-row{padding:2px 0}.cts-k{display:inline-block;min-width:34px;opacity:.6;font-size:10.5px;text-transform:uppercase}.cts-p{opacity:.65}.cts-set{margin-top:8px;font-size:11.5px;opacity:.8}.cts-set input{width:48px}</style>
      <div>${n} item${n === 1 ? '' : 's'} will be added to the CalTopo map${folderNew.length ? `, and ${folderNew.length} folder${folderNew.length === 1 ? '' : 's'} created there (${folderNew.map(x => esc(x.name)).join(', ')})` : ''}. The project keeps its copies; they stop being marked “not in CalTopo”.${n > 20 ? ' CalTopo is asked gently, about one item a second.' : ''}</div>
      <div class="cts-list">${rows}</div>`;
    return a.dialog({ title: 'Send to CalTopo', html, wide: true, buttons: [{ label: 'Cancel', value: null }, { label: `Send ${n} to CalTopo`, value: 'go', primary: true }] })
      .then(r => !!(r && r.button === 'go'));
  }

  function progressBox() {
    const a = A(), wrap = a.el('div', 'pj-modal'), box = a.el('div', 'pj-modal-box wide');
    const title = a.el('div', 'pj-modal-title', 'Sending to CalTopo'), msg = a.el('div', 'pj-modal-text', 'Starting…');
    const bar = a.el('div', ''), fill = a.el('div', '');
    bar.style.cssText = 'height:6px;border-radius:3px;background:rgba(255,255,255,.12);margin:8px 0;overflow:hidden';
    fill.style.cssText = 'height:100%;width:0;background:var(--ui-on,#3ecf8e);transition:width .2s';
    bar.appendChild(fill);
    const btns = a.el('div', 'pj-modal-btns'), stop = { v: false };
    const sb = a.btn('Stop', () => { stop.v = true; sb.disabled = true; msg.textContent = 'Stopping after this one…'; });
    btns.appendChild(sb);
    box.append(title, msg, bar, btns); wrap.appendChild(box); document.body.appendChild(wrap);
    return { stop, set(done, total, text) { fill.style.width = (total ? Math.round(100 * done / total) : 0) + '%'; msg.textContent = text; }, box, btns, msg, title, bar, close: () => wrap.remove() };
  }

  /** The whole thing. target: { feature } | { group } | { all }. → the summary, or null. */
  async function send(target) {
    const a = A(), w = W(), pj = PJ();
    const why = can();
    if (why) { toast(why); return null; }
    if (busy) { toast('Already sending to CalTopo'); return null; }
    const P = pj.P, feats = pick(target || { all: true }, P);
    if (!feats.length) { toast('Everything here is already in CalTopo'); return null; }
    const pl = plan(feats, w.folders(), g => pathOf(P, g));
    if (!(await preview(P, pl, !!(target && target.feature)))) return null;
    busy = true;
    const ui = progressBox(), total = pl.folders.filter(x => !x.id).length + pl.items.length;
    const sum = { sent: [], queued: [], failed: [], skipped: [], readOnly: '' };
    let done = 0;
    const tick = text => ui.set(done, total, text);
    try {
      // Folders first, parents before children.
      const ids = new Map(pl.folders.filter(x => x.id).map(x => [x.key, x.id])), dead = new Set();
      for (const fo of pl.folders.filter(x => !x.id)) {
        if (ui.stop.v || sum.readOnly) { dead.add(fo.key); continue; }
        if (fo.parent && !ids.has(fo.parent)) { dead.add(fo.key); continue; }
        tick(`Creating the folder “${fo.name}”…`);
        const r = await w.create({ type: 'Feature', geometry: null, properties: { class: 'Folder', title: fo.name, folderId: fo.parent ? ids.get(fo.parent) : undefined } }, { quiet: true });
        done++;
        if (r && r.ok && r.fid) ids.set(fo.key, String(r.fid));
        else { dead.add(fo.key); if (r && r.readOnly) sum.readOnly = r.error; else if (r && r.queued) fo.why = 'CalTopo could not be reached'; else fo.why = (r && r.error) || 'CalTopo refused it'; }
      }
      let i = 0;
      for (const it of pl.items) {
        const f = it.f, name = titleOf(f);
        i++;
        if (ui.stop.v || sum.readOnly) { sum.skipped.push({ f, why: sum.readOnly ? 'the key can only read' : 'stopped' }); continue; }
        if (it.folder && !ids.has(it.folder)) {
          const fo = pl.folders.find(x => x.key === it.folder);
          sum.skipped.push({ f, why: `its folder could not be created${fo && fo.why ? ' (' + fo.why + ')' : ''}` }); done++; continue;
        }
        tick(`${i} of ${pl.items.length}: ${name}`);
        const r = await w.create(toCalTopo(f, it.folder ? ids.get(it.folder) : null, colourOf(f)), { quiet: true });
        done++;
        if (r && r.ok) sum.sent.push({ f, fid: String(r.fid || (r.feature && r.feature.id) || '') });
        else if (r && r.queued) sum.queued.push({ f });
        else { if (r && r.readOnly) sum.readOnly = r.error; sum.failed.push({ f, why: (r && r.error) || 'CalTopo refused it' }); }
      }
      // The links, all at once, then one re-read of the map.
      const map = w.mapId(), quiet = { quiet: true };
      for (const s of sum.sent.concat(sum.queued)) {
        const st = Object.assign({}, s.f.style || {}, { ct: { map, fid: s.fid || null } });
        await a.record('feature.set', { feature: s.f.id, style: st }, undefined, quiet);
      }
      if (sum.sent.length || sum.queued.length) { if (a.refresh) a.refresh('feature.set'); }
      tick('Reading the map again…');
      await w.refresh();
    } finally { busy = false; }
    await summary(ui, sum);
    window.dispatchEvent(new CustomEvent('flex-feature-edited'));
    return sum;
  }

  async function summary(ui, sum) {
    const a = A();
    const lines = [];
    if (sum.sent.length) lines.push(`<div><b>${sum.sent.length}</b> added to CalTopo.</div>`);
    if (sum.queued.length) lines.push(`<div><b>${sum.queued.length}</b> waiting: CalTopo could not be reached, they go when it is back (nothing to do).</div>`);
    if (sum.failed.length) lines.push(`<div><b>${sum.failed.length}</b> not sent:</div>` + sum.failed.slice(0, 8).map(x => `<div class="cts-p">· ${esc(titleOf(x.f))}: ${esc(x.why)}</div>`).join(''));
    if (sum.skipped.length) lines.push(`<div><b>${sum.skipped.length}</b> not sent yet (${esc(sum.skipped[0].why)}). Run Send again for them.</div>`);
    if (sum.readOnly) lines.push(`<div class="cts-p" style="margin-top:6px">${esc(sum.readOnly)}</div>`);
    ui.title.textContent = 'Sent to CalTopo';
    ui.msg.innerHTML = lines.join('') || 'Nothing was sent.';
    ui.bar.remove(); ui.btns.innerHTML = '';
    const done = new Promise(res => {
      ui.btns.appendChild(a.btn('Close', () => { ui.close(); res(null); }, 'primary'));
      if (sum.sent.length) ui.btns.insertBefore(a.btn('Remove the project copies…', async () => { const n = await removeCopies(sum.sent.map(s => s.f)); if (n) { ui.close(); res(null); } }, 'danger'), ui.btns.firstChild);
    });
    return done;
  }

  /** The separate step: take items out of the project once they are in CalTopo (undo in 📁 History). → how many. */
  async function removeCopies(list) {
    const a = A(), pj = PJ();
    list = (list || []).filter(f => pj.P && pj.P.features[f.id] && !pj.P.features[f.id].removed);
    if (!list.length) return 0;
    const r = await a.dialog({ title: 'Remove the project copies?', text: `${list.length} item${list.length === 1 ? ' is' : 's are'} in CalTopo now, and CalTopo is the source of truth. Remove ${list.length === 1 ? 'its' : 'their'} copy from the project? The CalTopo items stay. Undo in 📁 History.`,
      buttons: [{ label: 'Keep them', value: null }, { label: `Remove ${list.length} from the project`, value: 'rm', danger: true }] });
    if (!r || r.button !== 'rm') return 0;
    let n = 0;
    for (const f of list) if (await a.record('feature.set', { feature: f.id, removed: true }, undefined, { quiet: true })) n++;
    if (n && a.refresh) a.refresh('feature.set');
    toast(`Removed ${n} project cop${n === 1 ? 'y' : 'ies'} (undo in 📁 History)`);
    return n;
  }

  return { send, notIn, notInIds, isNotIn, can, reminder, highlight, hlSync, hlOn: () => hlFlag, removeCopies, parseTag, makeTag, toCalTopo, plan, hex, _linked: linked };
});
