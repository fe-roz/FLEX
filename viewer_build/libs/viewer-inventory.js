/* FLEX Field / the portable viewer: inventories.
 *
 * An inventory is a chest at a station (or a surface point) with a dated log of what was left, taken and checked
 * there (left / took / checked / note, items with quantities, photos). The rules, the replay and the maths live in
 * flexlib.js ("Inventories", shared with FLEX on the PC); this file is the phone's side of it:
 *
 *  - the chests: drawn at the station's own place (or the surface point's) from the export's `inventories` and the
 *    phone's library together (one chest per inventory id), faded when something in it is possibly out of date, with an
 *    Inventories switch in 🎨 Display (remembered with the other display choices);
 *  - the card a tap on a chest opens: the contents table, the log table (photos open full screen), or the list in
 *    list mode;
 *  - Add entry / Check… are always there (an entry counts like a note); everything else (create an inventory at a
 *    station, rename, keep as a list or a dated log, edit the list, change or remove an entry, remove the inventory)
 *    waits behind the card's ✎ Edit, as every change but a note does in the viewer;
 *  - the station card's short "📦 2 inventories" line, 🔍 Find by inventory name and item, the change log's wording
 *    and undo.
 *
 * An inventory that came in the export is not in the phone's library until it is changed: then the export's record is
 * taken in first (FlexLib.invAdoptBodies: the same ids on every device, so two phones that both do it merge without a
 * conflict), then the change is recorded. Entries the export has and the library lacks (a newer export) are shown
 * and taken in the same way.
 *
 * Two halves: the rules without a DOM (Node-tested by tools/test_viewer_inventory.js) and the page. The page half
 * reads what viewer.html keeps (ffP, ffLinks, stationMap, ffRecord, …) when it runs, after the page's own script.
 * Works as a classic script (window.ViewerInv, after flexlib.js) and under Node (module.exports: the rules only).
 */
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./flexlib.js') : root.FlexLib);
  if (node) module.exports = api;
  else root.ViewerInv = api;
})(typeof self !== 'undefined' ? self : this, function (FL) {
  'use strict';

  /* ════════════════════════════ the rules (no DOM) ════════════════════════ */
  const str = v => (v == null ? '' : String(v));
  const isInv = e => !!e && typeof e.op === 'string' && e.op.indexOf('inv.') === 0 && e.inv != null && e.inv !== '';
  const logId = e => str(e.log != null && e.log !== '' ? e.log : e.id);
  const pad2 = n => String(n).padStart(2, '0');
  /** Today on this phone's clock, "2026-03-02". */
  const localDay = d => { d = d || new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
  const shortName = (t, n) => { t = str(t).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const itemsText = items => (items || []).map(i => (i.qty === 1 ? '' : i.qty + ' × ') + i.name).join(', ');
  /** What an inventory holds, as names: the contents of a log, the lines of a list. */
  const itemNames = r => (r.mode === 'list' ? str(r.list).split('\n').map(s => s.trim()).filter(Boolean) : (r.contents || []).map(c => c.name));
  const OLD_T = '2000-01-01T00:00:00.000Z';       // "edited long ago": for an exported list that was already out of date

  /** The library target an exported inventory gets here: a station of the project's cave (caveId, linked by the export's cave name), or the surface point it names; '' when there is none yet. */
  function libTarget(exp, caveId) {
    if (exp && exp.station) return caveId ? FL.T.station(caveId, str(exp.station)) : '';
    return /^feature:./.test(str(exp && exp.target)) ? str(exp.target) : '';
  }

  /**
   * The export's record as entries a replay can read, oldest first: the inv.set and one inv.log per exported entry (same ids
   * as FlexLib.invAdoptBodies makes, so they match what a device records when it adopts the inventory). Ids are made up
   * ("exp.<inv>.<n>", device "export"); times follow the entry's own date so entries of one day keep their order.
   * o.exportedAt: when the export was made (or imported), for a list that was not out of date then.
   */
  function virtualEntries(exp, target, o) {
    o = o || {};
    const exT = o.exportedAt || new Date().toISOString();
    const bodies = FL.invAdoptBodies(exp, target || str(exp.target) || FL.T.station('?', str(exp.station)));
    return bodies.map((b, i) => {
      const { op, ...rest } = b;
      let t = exT, who = '';
      if (op === 'inv.log') {
        who = str(b.by);
        const dk = FL.dateKey(b.date);
        if (dk) { const p = dk.split('-'); t = p[0] + '-' + (p[1] || '01') + '-' + (p[2] || '01') + 'T12:00:00.' + String(i).padStart(3, '0') + 'Z'; }
      } else if (exp.mode === 'list' && exp.stale) t = OLD_T;
      return Object.assign({ id: 'exp.' + str(exp.id) + '.' + i, dev: 'export', seq: i + 1, t, who, op }, rest);
    });
  }

  /**
   * The inventories to show: the library's, and the export's that the library does not have (or has only in part).
   *   o.entries   the library's entries in replay order (any ops; the inv.* ones are used)
   *   o.exported  caves.json `inventories`
   *   o.targetOf  (exp) → the library target the export's record gets here (default: libTarget with no cave)
   *   o.exportedAt  see virtualEntries
   * → [{ id, rec (a FlexLib.replayInventories record: contents, log, stale on this clock…), exp (the export's, or null),
   *      placed (the library has the inventory), missing ([exported entry ids the library lacks]), adopt (a change needs
   *      the export's record taken in first) }] by name. Removed inventories are left out.
   */
  function effective(o) {
    o = o || {};
    const lib = new Map(), ex = new Map();
    (o.entries || []).forEach(e => { if (isInv(e)) { const k = str(e.inv); (lib.get(k) || lib.set(k, []).get(k)).push(e); } });
    (o.exported || []).forEach(x => { if (x && x.id != null && x.id !== '' && !ex.has(str(x.id))) ex.set(str(x.id), x); });
    const all = [], meta = new Map();
    new Set([...lib.keys(), ...ex.keys()]).forEach(id => {
      const mine = lib.get(id) || [], exp = ex.get(id) || null;
      const placed = mine.some(e => e.op === 'inv.set' && e.target);
      const known = new Set();
      mine.forEach(e => { if (e.op === 'inv.log') known.add(logId(e)); });
      const before = [], after = [], missing = [];
      if (exp) {
        const v = virtualEntries(exp, o.targetOf ? o.targetOf(exp) : libTarget(exp, null), o);
        if (!placed) before.push(v[0]);
        v.slice(1).forEach(e => { if (!known.has(str(e.log))) { after.push(e); missing.push(str(e.log)); } });
      }
      all.push(...before, ...mine, ...after);
      meta.set(id, { exp, placed, missing, adopt: !!exp && (!placed || missing.length > 0) });
    });
    const recs = FL.replayInventories(all), list = [];
    meta.forEach((m, id) => {
      const rec = recs[id];
      if (!rec || rec.deleted || !rec.target) return;
      list.push(Object.assign({ id, rec }, m));
    });
    return list.sort((a, b) => str(a.rec.name).localeCompare(str(b.rec.name), undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1));
  }

  /**
   * What to record before a change to an inventory that came in the export: [[op, data, extra], …] for ViewerInv's host
   * (ffRecordMany) — the inv.set (unless the library has it) and the exported entries the library lacks, in the export's order,
   * each a millisecond after the one before so same-day entries keep their order. [] when the library has it all.
   */
  function adoptionPlan(item, target, now) {
    if (!item || !item.exp || !item.adopt || !target) return [];
    const miss = new Set(item.missing), out = [];
    FL.invAdoptBodies(item.exp, target).forEach(b => {
      const { op, ...data } = b;
      if (op === 'inv.set') { if (item.placed) return; }
      else { if (!miss.has(str(data.log))) return; data.source = 'export'; }
      out.push([op, data, { t: new Date((now == null ? Date.now() : now) + out.length).toISOString() }]);
    });
    return out;
  }

  /** The Find matches for a typed text: inventories by name (then description) and their items; best first. */
  function search(list, q) {
    q = str(q).trim().toLowerCase();
    if (!q) return [];
    const score = lc => { const i = lc.indexOf(q); return i < 0 ? -1 : lc === q ? 0 : i === 0 ? 1 : /[\s\-_.,(]/.test(lc[i - 1]) ? 2 : 3; };
    const out = [];
    (list || []).forEach(it => {
      const r = it.rec, name = r.name || 'Inventory';
      let s = score(name.toLowerCase());
      if (s < 0 && r.desc) { const d = score(r.desc.toLowerCase()); if (d >= 0) s = d + 3; }
      if (s >= 0) out.push({ kind: 'inventory', inv: it.id, text: name, score: s });
      const seen = new Set();
      itemNames(r).forEach(n => {
        const k = score(n.toLowerCase());
        if (k < 0 || seen.has(n.toLowerCase())) return;
        seen.add(n.toLowerCase());
        out.push({ kind: 'invitem', inv: it.id, text: n, score: k + 0.5 });
      });
    });
    return out.sort((a, b) => a.score - b.score || a.text.length - b.text.length || a.text.localeCompare(b.text));
  }

  /** A form's starting point: an entry to edit, or a new one ({ action, by, items }). */
  function draftOf(rec, cur, o) {
    o = o || {};
    if (cur) return { action: cur.action, date: cur.date, by: cur.by, all: !!cur.all, text: cur.text, items: cur.items.map(x => ({ name: x.name, qty: String(x.qty) })), photos: cur.photos.slice() };
    const d = { action: FL.INV.actions.includes(o.action) ? o.action : 'left', date: o.date || localDay(), by: str(o.by), all: false, text: '', items: [], photos: [] };
    if (d.action === 'checked') checkFill(rec, d);
    return d;
  }
  /** A check starts from what the log says is there (change the numbers, take out what is gone, add what you find); "that was everything" starts on, so a line taken out means it is gone. */
  function checkFill(rec, d) {
    if (d.items.every(i => !str(i.name).trim()) && rec.contents.length) { d.items = rec.contents.map(c => ({ name: c.name, qty: String(c.qty) })); d.all = true; }
    return d;
  }
  /** Why a form cannot be saved yet ('' when it can). */
  function checkDraft(d) {
    if (!FL.dateKey(d.date)) return 'Date: write it like 2026-03-02 (or just 2026-03, or 2019 when you do not know more).';
    if (d.action !== 'note' && !FL.invItems(d.items).length) return 'List at least one item (or choose Note).';
    if (d.action === 'note' && !str(d.text).trim() && !d.photos.length) return 'Write a note or add a photo.';
    return '';
  }

  const Core = { localDay, shortName, itemsText, itemNames, libTarget, virtualEntries, effective, adoptionPlan, search, draftOf, checkFill, checkDraft };
  if (typeof document === 'undefined') return Core;

  /* ════════════════════════════ the page ═════════════════════════════════ */
  // Page globals (viewer.html's own script): looked up when something runs, never at load.
  const W = window;
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const toast = m => { try { showToast(m); } catch (_) { console.log(m); } };
  const PG = {
    p: () => (typeof ffP !== 'undefined' ? ffP : null),
    pid: () => (typeof ffPid !== 'undefined' ? ffPid : null),
    links: () => (typeof ffLinks !== 'undefined' && ffLinks ? ffLinks : { byName: {}, byId: {} }),
    ready: () => typeof ffReady !== 'undefined' && !!ffReady,
    stations: () => (typeof stationMap !== 'undefined' ? stationMap : null),
  };
  const NONE = [];
  const exportedList = () => (typeof CAVES_DATA !== 'undefined' && CAVES_DATA && Array.isArray(CAVES_DATA.inventories) ? CAVES_DATA.inventories : NONE);
  const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) {} };
  const V3 = a => new THREE.Vector3(a[0], a[1], a[2]);

  // ── The model: what to show, worked out from the library and the export ─────────────────────────────
  // When the export was made, as near as the phone knows: the latest map import / update of the app's own map log.
  function exportedAt() {
    let t = '';
    try { (ffEntries.map || []).forEach(e => { if ((e.op === 'map.import' || e.op === 'map.update') && e.t > t) t = e.t; }); } catch (_) {}
    return t || new Date().toISOString();
  }
  let M = { p: null, l: null, n: -1, x: null, v: [], byId: new Map() };
  function model() {
    const p = PG.p(), l = PG.links(), n = Object.keys(l.byName).length, x = exportedList();
    if (M.p === p && M.l === l && M.n === n && M.x === x) return M;
    const entries = p && p.log ? p.log.filter(e => !e.proposed) : [];
    const list = effective({ entries, exported: x, exportedAt: exportedAt(), targetOf: exp => libTarget(exp, exp.station ? l.byName[str(exp.cave)] : null) || str(exp.target) });
    list.forEach(decorate);
    return (M = { p, l, n, x, v: list, byId: new Map(list.map(i => [i.id, i])) });
  }
  const get = id => model().byId.get(str(id)) || null;
  /** Where an inventory is: the export's cave name and station name (a station of a cave on this map), or the surface. */
  function decorate(it) {
    const t = FL.parseTarget(it.rec.target), exp = it.exp, l = PG.links();
    it.cave = null; it.station = ''; it.kind = 'surface';
    if (exp && exp.station) { it.kind = 'station'; it.cave = str(exp.cave); it.station = str(exp.station); }
    else if (t.kind === 'station') {
      it.kind = 'station'; it.station = str(t.name);
      it.cave = l.byId[t.cave] != null ? l.byId[t.cave] : null;           // a cave of the project that is not on this map: not drawn
    }
    it.where = it.kind === 'station' ? it.station + (it.cave ? ' · ' + it.cave : '') : 'a surface point';
    it.list = FL.invLine(it.rec, 4);
  }

  // Where a write would go: the library target of an inventory (its own, or the one the export's record gets here).
  function targetFor(it) {
    if (!it) return '';
    if (it.placed) return it.rec.target;
    return libTarget(it.exp, it.exp && it.exp.station ? PG.links().byName[str(it.exp.cave)] : null);
  }
  /** Why nothing can be written for this inventory now ('' when it can). */
  function cannotWrite(it) {
    if (!PG.pid()) return 'This map has no project yet: ⋯ More → Project & sync.';
    if (it && it.adopt && !targetFor(it)) return 'Link this cave to the project first (⋯ → Project & sync).';
    return '';
  }

  // ── Writing ─────────────────────────────────────────────────────────────────────────────────────────
  // The export's record into the library, when it is not there (or not all of it). true when the library has it.
  function adopt(it) {
    const plan = adoptionPlan(it, targetFor(it), Date.now());
    if (!plan.length) return true;
    if (typeof ffRecordMany === 'function') ffRecordMany(plan); else plan.forEach(([op, d, x]) => ffRecord(op, d, x));
    const r = PG.p() && PG.p().inventories && PG.p().inventories[it.id];
    return !!(r && r.target);
  }
  const libRec = id => { const p = PG.p(); return (p && p.inventories && p.inventories[str(id)]) || null; };
  async function ensureAuthor() { try { return await ffEnsureAuthor(); } catch (_) { return ''; } }

  /** A new entry, or the edit of one (curId); `draft` as the form fills it. true when something was recorded. */
  async function commitEntry(id, draft, curId) {
    const it = get(id);
    if (!it) return false;
    const why = cannotWrite(it);
    if (why) { toast(why); return false; }
    const plan = adoptionPlan(it, targetFor(it), Date.now());
    if (curId == null) {
      const { op, ...data } = FL.invLogBody(it.id, draft);
      const list = plan.concat([[op, data, { t: new Date(Date.now() + plan.length).toISOString() }]]);
      return list.length > 1 ? !!(ffRecordMany(list).length) : !!ffRecord(op, data);
    }
    if (plan.length && !adopt(it)) return false;
    const cur = (libRec(id) || { log: [] }).log.find(e => e.id === curId);
    if (!cur) { toast('That entry is gone'); return false; }
    const body = FL.invLogBody(it.id, draft, cur);
    if (!body) return false;
    const { op, ...data } = body;
    return !!ffRecord(op, data);
  }
  async function removeEntry(id, curId) {
    const it = get(id);
    if (!it) return false;
    const why = cannotWrite(it);
    if (why) { toast(why); return false; }
    if (!adopt(it)) return false;
    const cur = (libRec(id) || { log: [] }).log.find(e => e.id === curId);
    if (!cur) return false;
    const { op, ...data } = FL.invLogRemoveBody(it.id, cur);
    return !!ffRecord(op, data);
  }
  /** Change the inventory itself: next = any of { name, desc, mode, list }. */
  async function commitSet(id, next) {
    const it = get(id);
    if (!it) return false;
    const why = cannotWrite(it);
    if (why) { toast(why); return false; }
    if (!adopt(it)) return false;
    const body = FL.invSetBody(libRec(id), next);
    if (!body) return false;
    const { op, ...data } = body;
    data.inv = it.id;
    return !!ffRecord(op, data);
  }

  // ── Look ────────────────────────────────────────────────────────────────────────────────────────────
  function css() {
    if (document.getElementById('inv-css')) return;
    const s = mk('style'); s.id = 'inv-css';
    s.textContent = `
#inv-card { position: fixed; left: 0; right: 0; bottom: 0; z-index: 33; max-height: min(68vh, 600px); overflow-y: auto; overscroll-behavior: contain;
  background: rgba(10,10,20,.97); border-top: 1px solid rgba(255,255,255,.16); border-radius: 16px 16px 0 0; padding: 10px 14px 20px;
  transform: translateY(105%); transition: transform .26s ease; pointer-events: all; font-size: 12.5px; }
#inv-card.open { transform: translateY(0); }
@media (max-height: 480px) { #inv-card { right: 66px; max-height: 82vh; } }
.ic-head { display: flex; align-items: center; gap: 6px; }
.ic-title { flex: 1; min-width: 0; font-size: 16px; font-weight: 700; color: #f0b040; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ic-head .fp-btn { font-size: 11px; padding: 4px 8px; }
.ic-x { background: none; border: none; color: #aaa; font-size: 19px; cursor: pointer; padding: 2px 6px; }
.ic-sub { font-size: 11px; opacity: .6; margin: 2px 0 4px; }
.ic-chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 4px 0 6px; }
.ic-chip { font-size: 11px; padding: 2px 8px; border-radius: 11px; background: rgba(255,255,255,.09); white-space: nowrap; }
.ic-chip.old { background: rgba(240,176,64,.2); color: #f2c24e; }
.ic-acts { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 4px; }
.ic-acts .fp-btn { font-size: 12px; padding: 7px 11px; }
.ic-edit-acts { border: 1px dashed rgba(240,176,64,.35); border-radius: 8px; padding: 6px; }
.ic-h { font-size: 10px; text-transform: uppercase; letter-spacing: .7px; opacity: .5; margin: 10px 0 3px; }
.ic-note { font-size: 11px; opacity: .6; margin: 3px 0; }
.ic-warn { font-size: 11px; color: #f2c24e; margin: 3px 0; }
.inv-tbl { width: 100%; border-collapse: collapse; margin: 2px 0 4px; table-layout: auto; }
.inv-tbl th { text-align: left; font-weight: 500; font-size: 10px; color: rgba(255,255,255,.5); padding: 2px 6px 2px 0; white-space: nowrap; border-bottom: 1px solid rgba(255,255,255,.14); }
.inv-tbl td { padding: 4px 6px 4px 0; vertical-align: top; border-bottom: 1px solid rgba(255,255,255,.06); overflow-wrap: anywhere; }
.inv-tbl td.q { font-variant-numeric: tabular-nums; text-align: right; padding-right: 10px; }
.inv-tbl th.q { text-align: right; padding-right: 10px; }
.inv-tbl td.d { white-space: nowrap; }
.inv-tbl td.never { color: rgba(255,255,255,.5); }
.inv-tbl tr.old td.ck { color: #f2c24e; }
.inv-tbl td.none { color: rgba(255,255,255,.5); font-style: italic; }
.inv-log tr.row.editable { cursor: pointer; } .inv-log tr.row.editable:active td { background: rgba(255,255,255,.07); }
.inv-log tr.row.conf td { background: rgba(255,159,28,.08); }
.act { white-space: nowrap; } .act-left { color: #6fd39a; } .act-took { color: #f09b7a; } .act-checked { color: #8ab4ec; } .act-note { color: rgba(255,255,255,.65); }
.inv-text { color: rgba(255,255,255,.7); white-space: pre-wrap; }
.inv-list { margin: 4px 0; padding: 6px 9px; background: rgba(255,255,255,.06); border-radius: 6px; }
.inv-li { padding: 2px 0; overflow-wrap: anywhere; }
.inv-thumbs { display: flex; flex-wrap: wrap; gap: 3px; }
.inv-thumbs img { width: 30px; height: 30px; object-fit: cover; border-radius: 3px; background: #222; cursor: zoom-in; }
.inv-th { position: relative; display: inline-block; }
.inv-th img { width: 54px; height: 54px; }
.inv-th button { position: absolute; top: -5px; right: -5px; width: 20px; height: 20px; line-height: 16px; padding: 0; border-radius: 50%; border: 1px solid rgba(255,255,255,.4); background: #222; color: #fff; font-size: 11px; }
.ff-inv-line { background: rgba(240,176,64,.1); border-left: 3px solid #f0b040; border-radius: 4px; padding: 5px 8px; cursor: pointer; }
.ff-inv-line.old { border-left-color: #b8893a; }
.inv-form { display: flex; flex-direction: column; gap: 9px; }
.inv-f { display: flex; flex-direction: column; gap: 3px; }
.inv-f > label, .inv-fl { font-size: 11px; opacity: .6; }
.inv-acts-chips { display: flex; gap: 5px; }
.inv-acts-chips .fp-btn { flex: 1; padding: 8px 4px; font-size: 13px; }
.inv-items { display: flex; flex-direction: column; gap: 5px; align-items: stretch; }
.inv-item { display: flex; gap: 5px; } .inv-item .ff-input { flex: 1; min-width: 0; } .inv-item .inv-qty { flex: none; width: 70px; }
.inv-item .fp-btn { flex: none; padding: 0 10px; }
.inv-all { display: flex; align-items: center; gap: 8px; font-size: 12.5px; } .inv-all input { width: 20px; height: 20px; }
.inv-msg { color: #ffb36b; font-size: 12px; } .inv-msg[hidden] { display: none; }
#inv-photo { position: fixed; inset: 0; z-index: 85; background: rgba(0,0,0,.94); display: flex; align-items: center; justify-content: center; touch-action: none; }
#inv-photo img { max-width: 100%; max-height: 100%; transform-origin: center; user-select: none; -webkit-user-drag: none; background: #fff; }
#inv-photo .ip-cap { position: absolute; left: 0; right: 0; bottom: 14px; text-align: center; font-size: 12px; color: #ddd; pointer-events: none; text-shadow: 0 0 4px #000; }
#inv-photo .ip-x { position: absolute; top: 10px; right: 12px; font-size: 22px; background: rgba(0,0,0,.5); border: 1px solid rgba(255,255,255,.3); color: #fff; border-radius: 8px; padding: 2px 10px; }
#inv-photo .ip-nav { position: absolute; top: 50%; transform: translateY(-50%); font-size: 28px; background: rgba(0,0,0,.4); border: none; color: #fff; padding: 10px 12px; border-radius: 8px; }
#inv-photo .ip-prev { left: 6px; } #inv-photo .ip-next { right: 6px; }`;
    document.head.appendChild(s);
  }

  // ── The chests on the map ───────────────────────────────────────────────────────────────────────────
  const CHEST_WORLD_M = 1.2, CHEST_MIN_PX = 22, CHEST_MAX_PX = 32;       // a real-world size, held between two on-screen sizes
  const S = { group: null, sprites: new Map(), shown: true, timer: null, ui: false };
  /** The chest, drawn on a canvas: an arched lid, a band and a lock, outlined and glowing so it reads on terrain, walls and dark cave. */
  function drawChest(g, S0) {
    const k = S0 / 52;
    g.lineJoin = 'round'; g.lineCap = 'round'; g.lineWidth = 3 * k; g.strokeStyle = 'rgba(0,0,0,.88)';
    g.shadowColor = '#ffb020'; g.shadowBlur = 6 * k;
    g.beginPath(); g.moveTo(6 * k, 27 * k); g.bezierCurveTo(6 * k, 13 * k, 15 * k, 8 * k, 26 * k, 8 * k); g.bezierCurveTo(37 * k, 8 * k, 46 * k, 13 * k, 46 * k, 27 * k); g.closePath();
    g.fillStyle = '#f0b040'; g.fill(); g.stroke();
    g.beginPath(); g.rect(6 * k, 27 * k, 40 * k, 19 * k); g.fillStyle = '#c4801f'; g.fill(); g.shadowBlur = 0; g.stroke();
    g.beginPath(); g.moveTo(6 * k, 34 * k); g.lineTo(46 * k, 34 * k); g.lineWidth = 2 * k; g.stroke();
    g.lineWidth = 2.6 * k; g.beginPath(); g.rect(22 * k, 29 * k, 8 * k, 10 * k); g.fillStyle = '#ffe08a'; g.fill(); g.stroke();
  }
  const labelOf = rec => shortName(rec.name || 'Inventory', 14);
  /** The chest and its short name on one canvas (the sprite's picture). */
  function chestTexture(label) {
    const H = 64, font = '700 34px system-ui, -apple-system, "Segoe UI", sans-serif';
    const c = document.createElement('canvas'), g0 = c.getContext('2d');
    g0.font = font;
    const tw = Math.ceil(g0.measureText(label).width);
    c.width = H + 2 + tw + 12; c.height = H;
    const g = c.getContext('2d');
    drawChest(g, H);
    g.font = font; g.textBaseline = 'middle'; g.lineJoin = 'round'; g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.88)'; g.fillStyle = '#fff';
    g.strokeText(label, H + 2, H / 2 + 2); g.fillText(label, H + 2, H / 2 + 2);
    const tex = new THREE.CanvasTexture(c);
    return { tex, aspect: c.width / c.height };
  }
  function ensureGroup() {
    if (S.group) return S.group;
    css();
    S.group = new THREE.Group();
    S.group.visible = S.shown;
    scene.add(S.group);
    return S.group;
  }
  function makeSprite(it) {
    const label = labelOf(it.rec), { tex, aspect } = chestTexture(label);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false });
    if (W.FlexFx && FlexFx.patch) FlexFx.patch(mat);
    const sp = new THREE.Sprite(mat);
    sp.center.set(-0.12, 0.5);                      // to the right of the station, so its dot, name and lead mark stay clear
    sp.renderOrder = 3;
    sp.userData = { inv: it.id, label, aspect, px: CHEST_MIN_PX };
    return sp;
  }
  function dropSprite(sp) {
    S.group.remove(sp);
    if (sp.material.map) sp.material.map.dispose();
    sp.material.dispose();
  }
  function stationFor(cave, name, near) {
    const m = PG.stations();
    if (!m) return null;
    const pfx = cave ? cave + '|' : '';
    let best = null, bd = Infinity;
    for (let n = 1; n < 40; n++) {                  // a name used twice in a cave is "name", "name#2"… (the stations far apart)
      const st = m.get(pfx + name + (n > 1 ? '#' + n : ''));
      if (!st) break;
      if (!near) return st;
      const d = st.pos.distanceToSquared(near);
      if (d < bd) { bd = d; best = st; }
    }
    return best;
  }
  /** Where a chest stands (scene frame): its station's own place, else where the export put it, else a library surface point's. */
  function placeOf(it) {
    const exp = it.exp, near = exp && exp.xyz ? V3(exp.xyz) : null;
    if (it.kind === 'station') {
      if (it.cave == null) return null;
      const st = stationFor(it.cave, it.station, near);
      return st ? st.pos.clone() : near;
    }
    if (near) return near;
    const f = FL.parseTarget(it.rec.target), F = PG.p() && PG.p().features && PG.p().features[f.feature];
    const c = F && !F.removed && F.coords && F.coords[0];
    if (!c || typeof gpsToScene !== 'function') return null;
    const s = gpsToScene(c[1], c[0]);
    let z = c[2];
    try { const g = terrainZAt(s.x, s.y); if (g != null && isFinite(g)) z = g + 1; } catch (_) {}
    return z != null && isFinite(z) ? new THREE.Vector3(s.x, s.y, z) : null;
  }
  /** Bring the chests up to date: one per inventory that has a place on this map, none for the rest. */
  function redraw() {
    clearTimeout(S.timer); S.timer = null;
    if (typeof THREE === 'undefined' || typeof scene === 'undefined') return;
    ensureGroup();
    const want = new Set();
    model().v.forEach(it => {
      it.pos = placeOf(it);
      if (!it.pos) return;
      want.add(it.id);
      let sp = S.sprites.get(it.id);
      if (sp && sp.userData.label !== labelOf(it.rec)) { dropSprite(sp); sp = null; }
      if (!sp) { sp = makeSprite(it); S.group.add(sp); S.sprites.set(it.id, sp); }
      sp.position.copy(it.pos);
      sp.material.opacity = it.rec.stale ? 0.5 : 1;       // possibly out of date: faded
      sp.visible = true;
    });
    S.sprites.forEach((sp, id) => { if (!want.has(id)) { dropSprite(sp); S.sprites.delete(id); } });
    S.group.visible = S.shown;
    if (typeof requestRender === 'function') { requestRender(); wakeRender(); }
  }
  /** Soon (once for a burst of changes). */
  function refresh() {
    if (S.timer || !PG.ready()) return;
    S.timer = setTimeout(redraw, 0);
  }
  /** Every drawn frame: each chest is a real size held between two on-screen sizes (like the lead marks). */
  function size() {
    if (!S.group || !S.group.visible || !S.sprites.size) return;
    const h = renderer.domElement.clientHeight || window.innerHeight || 1, tanH = 2 * Math.tan(camera.fov * Math.PI / 360);
    S.sprites.forEach(sp => {
      const dist = Math.max(0.01, camera.position.distanceTo(sp.position));
      const px = Math.min(CHEST_MAX_PX, Math.max(CHEST_MIN_PX, CHEST_WORLD_M * h / (tanH * dist)));
      const u = tanH * px / h;
      sp.scale.set(u * sp.userData.aspect, u, 1);
      sp.userData.px = px;
    });
  }
  /** Chest's box on the page, in the canvas's pixels: { x0, y0, x1, y1 } or null (behind the camera). */
  function boxOf(sp, rect) {
    const v = sp.position.clone().project(camera);
    if (v.z > 1) return null;
    const ax = (v.x + 1) / 2 * rect.width, ay = (1 - v.y) / 2 * rect.height, ph = sp.userData.px, pw = ph * sp.userData.aspect;
    const x0 = ax - sp.center.x * pw, y0 = ay - (1 - sp.center.y) * ph;
    return { x0, y0, x1: x0 + pw, y1: y0 + ph };
  }
  /** A tap at (x, y) in the canvas's pixels: the nearest chest within a finger's width of its box → { id, d } (d: pixels from the box) or null. */
  function pick(x, y, rect) {
    if (!S.group || !S.group.visible) return null;
    const pad = Math.max(6, (typeof STATION_HIT_PX !== 'undefined' ? STATION_HIT_PX : 24) * 0.4);
    let best = null;
    S.sprites.forEach(sp => {
      if (!sp.visible || (W.FlexFx && FlexFx.tapFactor(sp.position) < 0.2)) return;        // faded or cut away by focus mode: not tappable
      const b = boxOf(sp, rect);
      if (!b) return;
      const d = Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1));
      if (d <= pad && (!best || d < best.d)) best = { id: sp.userData.inv, d };
    });
    return best;
  }

  // ── Small pieces: a form's modal, photos ────────────────────────────────────────────────────────────
  function modal({ title, text, body, buttons, wide }) {
    return new Promise(resolve => {
      const wrap = mk('div', 'ff-modal inv-modal'), box = mk('div', 'ff-modal-box' + (wide ? ' wide' : ''));
      box.appendChild(mk('div', 'ff-modal-title', title));
      if (text) box.appendChild(mk('div', 'ff-modal-text', text));
      box.appendChild(body);
      const msg = mk('div', 'inv-msg'); msg.hidden = true; box.appendChild(msg);
      const row = mk('div', 'fp-row ff-modal-btns');
      buttons.forEach(b => {
        const n = mk('button', 'fp-btn ' + (b.cls || '') + (b.primary ? ' active' : '') + (b.danger ? ' ff-danger' : ''), b.label);
        n.addEventListener('click', () => {
          if (b.value === null) { wrap.remove(); resolve(null); return; }
          const bad = b.check && b.check();
          if (bad) { msg.textContent = bad; msg.hidden = false; return; }
          wrap.remove(); resolve(b.value);
        });
        row.appendChild(n);
      });
      box.appendChild(row); wrap.appendChild(box); document.body.appendChild(wrap);
    });
  }
  const field = (label, node) => { const f = mk('div', 'inv-f'); f.appendChild(mk('label', null, label)); f.appendChild(node); return f; };
  const input = (value, ph, area) => { const i = mk(area ? 'textarea' : 'input', 'ff-input'); if (area) i.rows = area; else i.type = 'text'; i.value = value || ''; if (ph) i.placeholder = ph; return i; };
  const blobSrc = async (img, p) => { try { const u = await ffBlobUrl(p.h, p.ext); if (u) img.src = u; } catch (_) {} };

  /** A photo full screen: ‹ › through the entry's photos, pinch or wheel to zoom, drag to move, tap the ✕ (or Back) to close. */
  function showPhotos(photos, i) {
    css();
    const old = document.getElementById('inv-photo'); if (old) old.remove();
    const w = mk('div'); w.id = 'inv-photo';
    const img = mk('img'), cap = mk('div', 'ip-cap'), x = mk('button', 'ip-x', '✕'), pv = mk('button', 'ip-nav ip-prev', '‹'), nx = mk('button', 'ip-nav ip-next', '›');
    img.alt = 'photo';
    let k = i || 0, z = 1, tx = 0, ty = 0;
    const xf = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`; };
    const show = n => {
      k = ((n % photos.length) + photos.length) % photos.length; z = 1; tx = 0; ty = 0; xf();
      const p = photos[k], bits = [];
      if (photos.length > 1) bits.push(`${k + 1} / ${photos.length}`);
      if (p.date) bits.push(p.date);
      if (p.by) bits.push(p.by);
      cap.textContent = bits.join(' · ');
      img.removeAttribute('src'); blobSrc(img, p);
    };
    pv.style.display = nx.style.display = photos.length > 1 ? '' : 'none';
    pv.addEventListener('click', () => show(k - 1)); nx.addEventListener('click', () => show(k + 1));
    x.addEventListener('click', () => w.remove());
    const pts = new Map();
    let base = null;
    const snap = () => { const a = [...pts.values()]; return a.length >= 2 ? { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y), cx: (a[0].x + a[1].x) / 2, cy: (a[0].y + a[1].y) / 2 } : { d: 0, cx: a[0].x, cy: a[0].y }; };
    img.addEventListener('pointerdown', e => { img.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); base = Object.assign(snap(), { z, tx, ty }); });
    img.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const s = snap();
      if (pts.size >= 2 && base.d > 0) z = Math.max(1, Math.min(8, base.z * s.d / base.d));
      tx = base.tx + (s.cx - base.cx); ty = base.ty + (s.cy - base.cy);
      if (z === 1) { tx = 0; ty = 0; }
      xf();
    });
    const up = e => { pts.delete(e.pointerId); if (pts.size) base = Object.assign(snap(), { z, tx, ty }); };
    img.addEventListener('pointerup', up); img.addEventListener('pointercancel', up);
    w.addEventListener('wheel', e => { e.preventDefault(); z = Math.max(1, Math.min(8, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); if (z === 1) { tx = 0; ty = 0; } xf(); }, { passive: false });
    w.append(img, cap, pv, nx, x);
    document.body.appendChild(w);
    show(k);
  }
  function thumbs(photos, cls) {
    const box = mk('div', 'inv-thumbs' + (cls ? ' ' + cls : ''));
    photos.forEach((p, i) => {
      const im = mk('img'); im.alt = 'photo'; im.title = (p.date ? p.date + ' · ' : '') + (p.name || 'photo');
      blobSrc(im, p);
      im.addEventListener('click', e => { e.stopPropagation(); showPhotos(photos, i); });
      box.appendChild(im);
    });
    return box;
  }

  // ── The card ────────────────────────────────────────────────────────────────────────────────────────
  const C = { id: null, edit: false, all: false, el: null };
  const ACT = { left: 'Left', took: 'Took', checked: 'Checked', note: 'Note' };
  function ensureCard() {
    css();
    if (!C.el) { C.el = mk('div'); C.el.id = 'inv-card'; C.el.setAttribute('role', 'dialog'); C.el.setAttribute('aria-label', 'Inventory'); document.body.appendChild(C.el); }
    return C.el;
  }
  function closeOthers() {
    try { if (typeof closeSheet === 'function') closeSheet(); } catch (_) {}
    try { if (typeof closeFind === 'function') closeFind(); } catch (_) {}
    try { if (typeof ffClosePanel === 'function') ffClosePanel(); } catch (_) {}
  }
  /** Open an inventory's card. */
  function open(id) {
    const it = get(id);
    if (!it) return false;
    ensureCard();
    if (C.id !== it.id) { C.edit = false; C.all = false; }
    C.id = it.id;
    closeOthers();
    renderCard();
    C.el.classList.add('open');
    C.el.scrollTop = 0;
    return true;
  }
  function closeCard() {
    if (C.el) C.el.classList.remove('open');
    C.id = null; C.edit = false;
  }
  const isOpen = () => !!(C.el && C.el.classList.contains('open') && C.id);
  const btn = (text, cls, fn) => { const b = mk('button', 'fp-btn ' + (cls || ''), text); b.addEventListener('click', fn); return b; };
  const tbl = (cls, cols) => {
    const t = mk('table', 'inv-tbl ' + cls), h = mk('thead'), r = mk('tr');
    cols.forEach(c => r.appendChild(mk('th', Array.isArray(c) ? c[1] : null, Array.isArray(c) ? c[0] : c)));
    h.appendChild(r); t.appendChild(h);
    const b = mk('tbody'); t.appendChild(b);
    return { t, b };
  };
  const td = (text, cls) => mk('td', cls || null, text);
  function contentsTable(rec) {
    const { t, b } = tbl('inv-contents', ['Item', ['Qty', 'q'], 'Changed', 'Checked']);
    rec.contents.forEach(c => {
      const tr = mk('tr', c.stale ? 'old' : '');
      tr.dataset.item = c.name;
      const nm = td(c.name); if (c.short) nm.title = 'More was taken than the log had; the record may be incomplete.';
      const ck = td((c.stale ? '⚠ ' : '') + (c.checked || 'never'), 'ck' + (c.checked ? '' : ' never'));
      if (c.stale) ck.title = 'Possibly out of date: ' + (c.checked ? 'counted ' + c.checked : 'never counted, first seen ' + c.first);
      tr.append(nm, td(String(c.qty), 'q'), td(c.changed || '–', 'd'), ck);
      b.appendChild(tr);
    });
    if (!rec.contents.length) { const tr = mk('tr'), c = td(rec.log.length ? 'Nothing left there, as far as the log says.' : 'Nothing recorded yet. Add an entry: what you left, took, or counted.', 'none'); c.colSpan = 4; tr.appendChild(c); b.appendChild(tr); }
    return t;
  }
  function logTable(it, cap) {
    const rec = it.rec, { t, b } = tbl('inv-log', ['Date', 'Who', 'Action', 'Items', 'Photos']);
    const rows = rec.log.slice().reverse();
    rows.slice(0, cap).forEach(e => {
      const tr = mk('tr', 'row' + (C.edit ? ' editable' : '') + (e.conflicts ? ' conf' : ''));
      tr.dataset.log = e.id;
      const what = mk('td');
      if (e.items.length) what.appendChild(mk('div', 'inv-items-t', itemsText(e.items) + (e.all ? ' (everything)' : '')));
      if (e.text) what.appendChild(mk('div', 'inv-text', e.text));
      if (e.conflicts) what.appendChild(mk('div', 'ic-warn', '⚠ edited on two devices (open it and save to settle)'));
      const ph = mk('td'); if (e.photos.length) ph.appendChild(thumbs(e.photos.map(p => Object.assign({ date: e.date, by: e.by || e.created.who }, p))));
      tr.append(td(e.date, 'd'), td(e.by || e.created.who || '?'), td(ACT[e.action] || e.action, 'act act-' + e.action), what, ph);
      if (C.edit) tr.addEventListener('click', () => entryForm(it.id, e));
      b.appendChild(tr);
    });
    if (!rows.length) { const tr = mk('tr'), c = td('No entries yet.', 'none'); c.colSpan = 5; tr.appendChild(c); b.appendChild(tr); }
    return { t, more: rows.length - Math.min(rows.length, cap) };
  }
  function renderCard() {
    const it = C.id && get(C.id);
    if (!it) { closeCard(); return; }
    const el = ensureCard(), rec = it.rec, top = el.scrollTop;
    el.textContent = '';
    // title, Edit, close
    const head = mk('div', 'ic-head');
    head.appendChild(mk('div', 'ic-title', '📦 ' + (rec.name || 'Inventory')));
    const eb = btn(C.edit ? '✓ Done' : '✎ Edit', 'ic-edit' + (C.edit ? ' active' : ''), () => { C.edit = !C.edit; renderCard(); });
    eb.title = 'Show the edit actions for this inventory';
    const xb = mk('button', 'ic-x', '✕'); xb.title = 'Close'; xb.addEventListener('click', closeCard);
    head.append(eb, xb);
    el.appendChild(head);
    el.appendChild(mk('div', 'ic-sub', [it.where, rec.mode === 'list' ? 'a simple list' : 'a dated log', rec.desc].filter(Boolean).join(' · ')));
    // state
    const chips = mk('div', 'ic-chips');
    if (rec.mode === 'list') chips.appendChild(mk('span', 'ic-chip', itemNames(rec).length + ' on the list'));
    else {
      chips.appendChild(mk('span', 'ic-chip', rec.contents.length + (rec.contents.length === 1 ? ' item' : ' items')));
      chips.appendChild(mk('span', 'ic-chip', rec.checked ? 'checked ' + rec.checked : rec.contents.length ? 'never checked' : 'nothing recorded'));
    }
    if (rec.stale) chips.appendChild(mk('span', 'ic-chip old', 'possibly out of date'));
    el.appendChild(chips);
    if (rec.conflicts) Object.keys(rec.conflicts).forEach(k => el.appendChild(mk('div', 'ic-warn', `⚠ ${k} was edited on two devices: ` + rec.conflicts[k].map(c => `“${shortName(c.v, 30)}” (${c.who || '?'})`).join(' / ') + '. ✎ Edit and save to settle.')));
    // the body
    if (rec.mode === 'list') {
      const lines = itemNames(rec), box = mk('div', 'inv-list');
      if (lines.length) lines.forEach(l => box.appendChild(mk('div', 'inv-li', l))); else box.appendChild(mk('div', 'inv-li', 'Nothing listed yet.'));
      el.appendChild(box);
      const lf = rec.fieldBy && rec.fieldBy.list;
      if (rec.stale) el.appendChild(mk('div', 'ic-warn', '⚠ Possibly out of date' + (rec.listAge != null ? `: the list was last edited ${rec.listAge} days ago.` : '.')));
      else if (lf && lf.who) el.appendChild(mk('div', 'ic-note', 'List last edited ' + String(lf.t).slice(0, 10) + ' by ' + lf.who));
      if (rec.log.length) el.appendChild(mk('div', 'ic-note', `The log (${rec.log.length} entr${rec.log.length === 1 ? 'y' : 'ies'}) is kept; ✎ Edit → keep it as a dated log to see it again.`));
    } else {
      el.appendChild(contentsTable(rec));
      if (rec.gone.length) el.appendChild(mk('div', 'ic-note', 'Gone: ' + rec.gone.map(g => g.name).join(', ')));
      if (rec.stale) el.appendChild(mk('div', 'ic-warn', `⚠ Possibly out of date (limit ${Math.round((rec.staleDays || FL.INV.staleDays) / 30.4)} months).`));
      // an entry counts like a note: always there
      const acts = mk('div', 'ic-acts');
      const add = btn('＋ Add entry', 'active ic-add', () => entryForm(it.id, null)); add.title = 'Left, took, checked or a note, with the date and photos';
      acts.append(add, btn('✓ Check…', 'ic-check', () => entryForm(it.id, null, { action: 'checked' })));
      el.appendChild(acts);
    }
    // everything else waits behind Edit
    if (C.edit) {
      const ea = mk('div', 'ic-acts ic-edit-acts');
      ea.appendChild(btn('✎ Rename…', 'ic-rename', () => renameDialog(it.id)));
      if (rec.mode === 'list') {
        ea.appendChild(btn('☰ Edit the list…', 'ic-editlist', () => listDialog(it.id)));
        ea.appendChild(btn('▦ Keep as a dated log', 'ic-mode', () => setMode(it.id, 'log')));
      } else ea.appendChild(btn('☰ Keep as a simple list', 'ic-mode', () => setMode(it.id, 'list')));
      ea.appendChild(btn('🗑 Remove inventory', 'ic-remove ff-danger', () => removeInventory(it.id)));
      el.appendChild(ea);
    }
    if (rec.mode !== 'list') {
      el.appendChild(mk('div', 'ic-h', `Log (${rec.log.length})`));
      const cap = C.all ? rec.log.length : 6, lt = logTable(it, cap);
      el.appendChild(lt.t);
      if (lt.more > 0 || (C.all && rec.log.length > 6)) {
        const m = btn(C.all ? 'Show only the latest' : `Show all ${rec.log.length} entries`, 'ic-more', () => { C.all = !C.all; renderCard(); });
        el.appendChild(m);
      }
      if (C.edit && rec.log.length) el.appendChild(mk('div', 'ic-note', 'Tap an entry to change or remove it.'));
    }
    el.scrollTop = top;
  }

  // ── The entry form ──────────────────────────────────────────────────────────────────────────────────
  let F = null;                                           // the open form: { id, curId, st, paint }
  const DRAFT_KEY = () => 'flex_inv_draft|' + (typeof MAP_KEY !== 'undefined' ? MAP_KEY : '');
  const saveDraft = () => { if (F) lsSet(DRAFT_KEY(), JSON.stringify({ id: F.id, curId: F.curId, st: F.st, t: Date.now() })); };
  const dropDraft = () => lsSet(DRAFT_KEY(), null);
  const rememberBy = n => lsSet('flex_inv_by', n);
  const lastBy = () => { const v = lsGet('flex_inv_by'); return v != null && v !== '' ? v : (typeof ffWho === 'function' ? ffWho() : ''); };
  /** Add an entry (cur null) or change one; preset: { action }; draft: a saved form to carry on with. */
  async function entryForm(id, cur, preset, draft) {
    if (F) return;
    const it = get(id);
    if (!it) return;
    const why = cannotWrite(it);
    if (why) { toast(why); return; }
    await ensureAuthor();
    const rec = it.rec;
    const st = draft || draftOf(rec, cur, { action: preset && preset.action, by: lastBy() });
    F = { id, curId: cur ? cur.id : null, st };
    const body = mk('div', 'inv-form');
    const names = mk('datalist'); names.id = 'inv-names';
    rec.contents.map(c => c.name).concat(rec.gone.map(g => g.name)).forEach(n => { const o = mk('option'); o.value = n; names.appendChild(o); });
    const chips = mk('div', 'inv-acts-chips');
    const itemsBox = mk('div', 'inv-items'), itemsField = field('Items', itemsBox);
    const allBox = mk('label', 'inv-all'), allCb = mk('input'); allCb.type = 'checkbox'; allCb.className = 'inv-all-cb';
    allBox.append(allCb, mk('span', null, 'That was everything here (what is not listed is gone)'));
    allCb.checked = !!st.all; allCb.addEventListener('change', () => { st.all = allCb.checked; });
    const dateIn = input(st.date, '2026-03-02, or 2026-03 / 2019 if not sure'), byIn = input(st.by, 'Who');
    dateIn.classList.add('inv-date'); byIn.classList.add('inv-by');
    const dl = mk('datalist'); dl.id = 'inv-whos'; (typeof ffAuthors === 'function' ? ffAuthors() : []).forEach(n => { const o = mk('option'); o.value = n; dl.appendChild(o); }); byIn.setAttribute('list', 'inv-whos');
    dateIn.addEventListener('input', () => { st.date = dateIn.value; }); byIn.addEventListener('input', () => { st.by = byIn.value; });
    const textIn = input(st.text, 'Anything worth saying (where exactly, what condition, who has the key…)', 3); textIn.classList.add('inv-text-in');
    textIn.addEventListener('input', () => { st.text = textIn.value; });
    const photoBox = mk('div');
    const paintItems = () => {
      itemsBox.textContent = '';
      itemsField.style.display = st.action === 'note' ? 'none' : '';
      allBox.style.display = st.action === 'checked' ? '' : 'none';
      allCb.checked = !!st.all;
      if (!st.items.length) st.items.push({ name: '', qty: '' });
      st.items.forEach((x, k) => {
        const row = mk('div', 'inv-item'), n = input(x.name, st.action === 'checked' ? 'Item you counted' : 'Item'), q = input(x.qty, '1');
        n.setAttribute('list', 'inv-names'); n.classList.add('inv-name'); q.classList.add('inv-qty'); q.setAttribute('inputmode', 'decimal');
        n.addEventListener('input', () => { x.name = n.value; }); q.addEventListener('input', () => { x.qty = q.value; });
        const rm = btn('✕', 'inv-item-x', () => { st.items.splice(k, 1); paintItems(); }); rm.title = 'Take this line out';
        row.append(n, q, rm);
        itemsBox.appendChild(row);
      });
      itemsBox.appendChild(btn('＋ Another item', 'inv-more-item', () => { st.items.push({ name: '', qty: '' }); paintItems(); const ins = itemsBox.querySelectorAll('input.inv-name'); if (ins.length) ins[ins.length - 1].focus(); }));
    };
    const paintPhotos = () => {
      photoBox.textContent = '';
      if (st.photos.length) {
        const row = mk('div', 'inv-thumbs');
        st.photos.forEach((p, k) => {
          const w = mk('span', 'inv-th'), im = mk('img'); im.alt = 'photo'; blobSrc(im, p);
          const x = mk('button', null, '✕'); x.type = 'button'; x.title = 'Take this photo off the entry';
          x.addEventListener('click', () => { st.photos.splice(k, 1); saveDraft(); paintPhotos(); });
          w.append(im, x); row.appendChild(w);
        });
        photoBox.appendChild(row);
      }
      const row2 = mk('div', 'fp-row');
      if (W.AndroidHost && typeof W.AndroidHost.takePhoto === 'function') row2.appendChild(btn('📷 Take a photo', 'inv-photo-take', takePhoto));
      row2.appendChild(btn('🖼 Add photos…', 'inv-photo-add', pickPhotos));
      photoBox.appendChild(row2);
    };
    F.paint = () => { paintPhotos(); };
    [['left', 'Left'], ['took', 'Took'], ['checked', 'Checked'], ['note', 'Note']].forEach(([k, label]) => {
      const b = btn(label, 'inv-act' + (st.action === k ? ' active' : ''), () => {
        st.action = k;
        chips.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        if (k === 'checked' && !F.curId) checkFill(rec, st);
        paintItems();
      });
      b.dataset.act = k;
      chips.appendChild(b);
    });
    body.append(names, dl, field('What happened', chips), field('Date', dateIn), field('Who', byIn), itemsField, allBox, field('Note', textIn), field('Photos', photoBox));
    paintItems(); paintPhotos();
    const buttons = [{ label: 'Cancel', value: null, cls: 'inv-cancel' }];
    if (cur) buttons.push({ label: 'Remove entry', value: 'rm', danger: true, cls: 'inv-remove' });
    buttons.push({ label: 'Save', value: 'ok', primary: true, cls: 'inv-save', check: () => checkDraft(st) || cannotWrite(get(id)) });
    const r = await modal({ title: (cur ? 'Entry of ' : 'New entry · ') + (rec.name || 'Inventory'), text: it.where, body, buttons, wide: true });
    const curId = F.curId;
    F = null; dropDraft();
    if (!r) return;
    if (r === 'rm') { if (await removeEntry(id, curId)) toast('Entry removed'); return; }
    if (st.by.trim()) rememberBy(st.by.trim());
    if (await commitEntry(id, { date: st.date, by: st.by, action: st.action, items: st.items, all: st.all, photos: st.photos, text: st.text }, curId)) toast(curId ? 'Entry saved' : 'Entry added');
  }
  // Photos for the open form. In the app the camera app takes one (libs/scan-import.js's ffPhotoReady hands it back here), or the
  // phone's file picker adds several; in a browser the file picker only. Either way the picture is stored as a page (like a document's).
  function takePhoto() {
    saveDraft();
    try { W.AndroidHost.takePhoto(JSON.stringify({ inv: 1 })); } catch (e) { toast('Could not start the camera'); }
  }
  async function pickPhotos() {
    saveDraft();
    try { await ffHost.pickPages({ inv: 1 }); } catch (e) { toast('Could not open the file picker'); }
  }
  /** Pages the picker or the camera stored (ffPagesPicked / ffPhotoReady with ctx.inv): onto the open form, or onto the form the page had open when the camera app took over. */
  function pagesPicked(ctx, pages) {
    pages = (pages || []).filter(p => p && p.h);
    const img = pages.filter(p => p.ext !== 'pdf'), pdfs = pages.length - img.length;
    if (pdfs) toast('Photos only: a PDF can’t go in an inventory');
    if (!img.length) return;
    const photos = FL.invPhotos(img);
    if (F) { F.st.photos.push(...photos); saveDraft(); F.paint(); toast(photos.length === 1 ? 'Photo added' : photos.length + ' photos added'); return; }
    let d = null;
    try { d = JSON.parse(lsGet(DRAFT_KEY()) || 'null'); } catch (_) {}
    if (d && d.id && d.st && get(d.id) && Date.now() - (d.t || 0) < 6 * 3600e3) {            // the page was reloaded while the camera was in front: the form comes back
      d.st.photos = (d.st.photos || []).concat(photos);
      const it = get(d.id), cur = d.curId && it.rec.log.find(e => e.id === d.curId);
      open(d.id);
      entryForm(d.id, cur || null, null, d.st);
      return;
    }
    toast('Photo kept; add it to an entry of the inventory');
  }

  // ── The inventory itself: create, rename, list or log, remove ───────────────────────────────────────
  /** name, description, and (when asked) the list: { name, desc, mode, list } or null. */
  async function invDialog(title, cur, o) {
    o = o || {};
    const st = { mode: cur ? cur.mode : 'log' }, body = mk('div', 'inv-form');
    const name = input(cur ? cur.name : '', 'e.g. Rope cache'), desc = input(cur ? cur.desc : '', 'Where exactly, what it is kept in…', 2), list = input(cur ? cur.list : '', 'One thing per line', 5);
    name.classList.add('inv-name-in'); desc.classList.add('inv-desc-in'); list.classList.add('inv-list-in');
    if (!o.listOnly) body.append(field('Name', name), field('Description', desc));
    const listF = field('The list', list);
    if (o.askMode) {
      const lab = mk('label', 'inv-all'), cb = mk('input'); cb.type = 'checkbox'; cb.className = 'inv-mode-cb';
      lab.append(cb, mk('span', null, 'Keep it as a simple list instead of a dated log'));
      cb.addEventListener('change', () => { st.mode = cb.checked ? 'list' : 'log'; listF.style.display = cb.checked ? '' : 'none'; });
      body.appendChild(lab);
      listF.style.display = 'none';
    }
    if (o.askMode || o.listOnly) body.appendChild(listF);
    const r = await modal({ title, body, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true, cls: 'inv-save' }], wide: true });
    if (!r) return null;
    return { name: name.value.trim(), desc: desc.value.trim(), mode: st.mode, list: list.value };
  }
  /** "Add inventory here" on a station's card (behind its ✎ Edit). */
  async function addHere(st) {
    if (!PG.pid()) { toast('This map has no project yet: ⋯ More → Project & sync.'); return; }
    const target = typeof ffStTarget === 'function' ? ffStTarget(st) : null;
    if (!target) { toast('Link this cave to the project first (⋯ → Project & sync)'); return; }
    await ensureAuthor();
    const r = await invDialog('New inventory at ' + (st.name || 'this station'), null, { askMode: true });
    if (!r) return;
    const body = FL.invSetBody(null, { target, name: r.name || 'Inventory at ' + shortName(st.name, 30), desc: r.desc, mode: r.mode, list: r.list });
    const { op, ...data } = body;
    data.inv = FL.uid(12);
    if (!ffRecord(op, data)) return;
    redraw();
    open(data.inv);
    toast('Inventory added');
  }
  async function renameDialog(id) {
    const it = get(id);
    if (!it) return;
    await ensureAuthor();
    const r = await invDialog('Rename · ' + (it.rec.name || 'Inventory'), it.rec, {});
    if (!r) return;
    await commitSet(id, { name: r.name || it.rec.name, desc: r.desc });
  }
  async function listDialog(id) {
    const it = get(id);
    if (!it) return;
    await ensureAuthor();
    const r = await invDialog('List · ' + (it.rec.name || 'Inventory'), it.rec, { listOnly: true });
    if (!r) return;
    await commitSet(id, { list: r.list });
  }
  async function setMode(id, mode) {
    const it = get(id);
    if (!it) return;
    await ensureAuthor();
    const next = { mode };
    if (mode === 'list' && !it.rec.list.trim() && it.rec.contents.length) next.list = it.rec.contents.map(c => (c.qty === 1 ? '' : c.qty + ' × ') + c.name).join('\n');      // a list starts from what the log says
    await commitSet(id, next);
  }
  async function removeInventory(id) {
    const it = get(id);
    if (!it) return;
    if (!PG.pid()) { toast('This map has no project yet: ⋯ More → Project & sync.'); return; }
    await ensureAuthor();
    const ok = await modal({ title: `Remove “${it.rec.name || 'this inventory'}”?`, body: mk('div', 'ff-modal-text', 'It leaves the map. It stays in the history: 📝 Change log can bring it back.'),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Remove', value: 'rm', danger: true, cls: 'inv-confirm' }] });
    if (!ok) return;
    const rec = libRec(id);
    if (ffRecord('inv.del', { inv: it.id, base: rec ? rec.heads.slice() : [] })) { closeCard(); toast('Inventory removed'); }
  }

  // ── The rest of the page: station card, find, display, change log ───────────────────────────────────
  /** Inventories at a station (a station object of the map). */
  function at(st) {
    if (!st || !st.name) return [];
    return model().v.filter(it => it.kind === 'station' && it.station === st.name && it.cave != null && it.cave === str(st.cave));
  }
  /** The station card's short line: "📦 Rope cache" / "📦 2 inventories", opening the card. */
  function stationLine(box, st) {
    const list = at(st);
    if (!list.length) return;
    const row = mk('div', 'ff-inv-line' + (list.some(i => i.rec.stale) ? ' old' : ''));
    row.appendChild(mk('div', 'ff-note-t', list.length === 1 ? '📦 ' + (list[0].rec.name || 'Inventory') : `📦 ${list.length} inventories`));
    row.appendChild(mk('div', 'ff-note-m', list.length === 1 ? [list[0].rec.mode === 'list' ? 'a simple list' : list[0].list || 'nothing recorded', list[0].rec.stale ? 'possibly out of date' : ''].filter(Boolean).join(' · ') : list.map(i => i.rec.name || 'Inventory').join(', ')));
    row.addEventListener('click', async () => {
      if (list.length === 1) { open(list[0].id); return; }
      const v = await ffChoose('Inventories at ' + st.name, null, list.map(i => ({ label: '📦 ' + (i.rec.name || 'Inventory'), sub: i.list || '', value: i.id })));
      if (v) open(v);
    });
    box.appendChild(row);
  }
  /** "Add inventory here", in the card's edit actions. */
  function stationEdit(row, st) {
    if (!st || !st.name) return;
    const b = mk('button', 'fp-btn', '📦 Inventory'); b.id = 'ff-inv-add'; b.title = 'Keep a log of what is stored at this station';
    b.addEventListener('click', () => addHere(st));
    row.appendChild(b);
  }
  /** 🔍 Find: matches as the Find panel's own rows ({ e, score }, e shaped like its index entries). */
  function findMatches(q) {
    const list = model().v.filter(it => S.sprites.has(it.id));
    return search(list, q).map(h => {
      const it = get(h.inv), name = it.rec.name || 'Inventory';
      return { score: h.score - 0.25, e: { kind: h.kind, inv: h.inv, text: h.text, lc: h.text.toLowerCase(),
        sub: h.kind === 'inventory' ? ['Inventory', it.where, it.rec.mode === 'list' ? 'a simple list' : it.list].filter(Boolean).join(' · ') : `in ${name} · ${it.where}` } };
    });
  }
  /** Fly to a chest and open its card. */
  function go(id) {
    const it = get(id);
    if (!it) return;
    const sp = S.sprites.get(it.id);
    if (!sp) { toast('That place isn’t on this map'); return; }
    if (!S.group.visible) setVisible(true);
    if (typeof flyToPoint === 'function') flyToPoint(sp.position, 25);
    open(it.id);
  }
  const visible = () => S.shown;
  function setVisible(on) {
    S.shown = !!on;
    if (S.group) S.group.visible = S.shown;
    try { if (typeof dispSave === 'function' && typeof _dispRestored !== 'undefined' && _dispRestored) dispSave({ inv: S.shown }); } catch (_) {}
    if (typeof requestRender === 'function') { requestRender(); wakeRender(); }
  }
  /** After inv.* entries were recorded or replayed: the chests, the card and the station card follow. */
  function changed() {
    redraw();
    if (isOpen()) renderCard();
    if (typeof ffRefreshCard === 'function') { try { ffRefreshCard(); } catch (_) {} }
  }
  // The change log: wording and undo.
  const nameOf = id => { const r = libRec(id); if (r && r.name) return r.name; const x = exportedList().find(i => str(i.id) === str(id)); return x ? str(x.name) : 'an inventory'; };
  function describe(e) {
    const n = (e.op === 'inv.set' && e.fields && e.fields.name) || nameOf(e.inv), from = e.source === 'export' ? 'From the export: ' : '';      // (a set says the name it gave then)
    switch (e.op) {
      case 'inv.set': return e.source === 'export' ? `Inventory “${n}” taken from the export` : e.prev == null ? `New inventory “${n}”` : `Changed inventory “${n}” (${Object.keys(e.fields || {}).join(', ') || 'place'})`;
      case 'inv.log': {
        if (e.removed) return `Removed an entry of “${n}”`;
        if (e.prev) return `Edited an entry of “${n}”`;
        return from + `${FL.INV.labels[e.action] || 'Entry'} in “${n}”` + (e.items && e.items.length ? ': ' + itemsText(e.items) : e.text ? ': ' + shortName(e.text, 40) : '');
      }
      case 'inv.del': return `Removed inventory “${n}”`;
      case 'inv.restore': return `Restored inventory “${n}”`;
      default: return e.op;
    }
  }
  const inverse = e => FL.invUndo(e);
  /** What ⇪ Export project data adds. */
  function exportData() {
    return model().v.map(it => Object.assign(FL.invPayload(it.rec), { at: it.where }));
  }

  return Object.assign(Core, {
    visible, setVisible, refresh, redraw, changed, size, pick, open, closeCard, isOpen, go, at, stationLine, stationEdit, addHere,
    findMatches, describe, inverse, pagesPicked, exportData, entryForm, showPhotos,
    list: () => model().v, get, sprites: () => [...S.sprites.entries()].map(([id, sp]) => ({ id, x: sp.position.x, y: sp.position.y, z: sp.position.z, opacity: sp.material.opacity, visible: sp.visible && S.group.visible, label: sp.userData.label })),
    hitPoint: id => {                                            // the middle of a chest on the page, in client pixels (for taps in tests)
      const sp = S.sprites.get(str(id));
      if (!sp) return null;
      const r = renderer.domElement.getBoundingClientRect(), b = boxOf(sp, r);
      return b ? { x: r.left + (b.x0 + b.x1) / 2, y: r.top + (b.y0 + b.y1) / 2 } : null;
    },
  });
});
