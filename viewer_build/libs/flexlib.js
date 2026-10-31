/* FLEX project library: what people add to a project (caves, documents,
 * notes, leads, field survey) as append-only logs, one per device, and the
 * state those logs replay to. Shared by the portable viewer / FLEX Field and
 * desktop FLEX. No DOM, no storage: the hosts (Android, the FLEX server,
 * IndexedDB in a plain browser) keep the files.
 *
 * Storage (same on every host):
 *   library/device.json             this device's id
 *   library/blobs/<sha256>.<ext>    document pages, stored once by content
 *   library/<scope>/log-<dev>.jsonl one append-only log per device and scope
 * Scopes: "p-<project id>" for a project, "docs" for documents (a document
 * can be listed in several projects, so its entries are not in one project).
 *
 * Entry: { id: "<dev>.<seq>", dev, seq, t (ISO), who, op, ... }. A device
 * only ever writes its own log; merging another device's entries is a union
 * by id. Records people edit (notes, leads, documents) carry `base`: the
 * entries of that record the device had seen. Two entries that both build on
 * the same state, neither seeing the other, are a conflict: both are kept and
 * shown until someone saves the record again (which builds on both).
 *
 * MIT-style use within FLEX; no dependencies. Works as a classic script
 * (window.FlexLib) and under Node (module.exports).
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.FlexLib = lib;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FORMAT = 1;
  const FT = 0.3048;
  const DOCS = 'docs';
  const projScope = pid => 'p-' + pid;
  const scopeProject = scope => (String(scope).startsWith('p-') ? String(scope).slice(2) : null);

  // ── SHA-256 (pages are stored by content hash; crypto.subtle is missing on
  // file:// pages, so this is the fallback) ─────────────────────────────────
  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const n = b.length, padLen = ((n + 9 + 63) >> 6) << 6;
    const m = new Uint8Array(padLen);
    m.set(b); m[n] = 0x80;
    const dv = new DataView(m.buffer);
    dv.setUint32(padLen - 8, Math.floor(n / 0x20000000)); dv.setUint32(padLen - 4, (n << 3) >>> 0);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    const r = (x, k) => (x >>> k) | (x << (32 - k));
    for (let o = 0; o < padLen; o += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + 4 * i);
      for (let i = 16; i < 64; i++) {
        const s0 = r(W[i - 15], 7) ^ r(W[i - 15], 18) ^ (W[i - 15] >>> 3), s1 = r(W[i - 2], 17) ^ r(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      let [a, bb, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + W[i]) >>> 0;
        const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += bb; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return Array.from(H, x => x.toString(16).padStart(8, '0')).join('');
  }

  // ── Small helpers ──────────────────────────────────────────────────────────
  function uid(n = 12) {
    const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    const c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto.getRandomValues(new Uint8Array(n)) : null;
    for (let i = 0; i < n; i++) s += a[(c ? c[i] : Math.floor(Math.random() * 256)) % 36];
    return s;
  }
  const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const nowIso = () => new Date().toISOString();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Replay order: time, then device, then sequence — the same on every device.
  function cmp(a, b) {
    if (a.t !== b.t) return a.t < b.t ? -1 : 1;
    if (a.dev !== b.dev) return String(a.dev) < String(b.dev) ? -1 : 1;
    return (a.seq || 0) - (b.seq || 0);
  }
  function sortEntries(list) { return list.slice().sort(cmp); }
  // Replay order that respects cause and effect even when device clocks
  // disagree: an entry comes after the earlier entries of its own device and
  // after every entry it builds on (`base`); otherwise by time.
  function causalOrder(list) {
    const sorted = sortEntries(list);
    const byId = new Map(sorted.map(e => [e.id, e]));
    const lastOfDev = new Map();
    const deps = new Map();
    sorted.slice().sort((a, b) => (a.dev === b.dev ? (a.seq || 0) - (b.seq || 0) : (a.dev < b.dev ? -1 : 1))).forEach(e => {
      const d = [];
      const prev = lastOfDev.get(e.dev);
      if (prev) d.push(prev.id);
      lastOfDev.set(e.dev, e);
      (e.base || []).forEach(b => { if (byId.has(b) && b !== e.id) d.push(b); });
      deps.set(e.id, d);
    });
    const done = new Set(), out = [], waiting = new Map();
    const release = e => {
      const stack = [e];
      while (stack.length) {
        const x = stack.pop();
        if (done.has(x.id)) continue;
        const miss = deps.get(x.id).find(d => !done.has(d));
        if (miss) { (waiting.get(miss) || waiting.set(miss, []).get(miss)).push(x); continue; }
        done.add(x.id); out.push(x);
        const w = waiting.get(x.id);
        if (w) { waiting.delete(x.id); for (let i = w.length - 1; i >= 0; i--) stack.push(w[i]); }
      }
    };
    sorted.forEach(release);
    if (out.length < sorted.length) sorted.forEach(e => { if (!done.has(e.id)) { done.add(e.id); out.push(e); } });  // cycles: by time
    return out;
  }
  function dedupe(list) { const m = new Map(); list.forEach(e => { if (e && e.id && !m.has(e.id)) m.set(e.id, e); }); return [...m.values()]; }
  // A survey's code from an export's survey name ("A — Main line" → "A").
  const surveyCode = name => String(name || '').split(' — ')[0].trim();

  // ── Targets: what a note, a tag or a lead is attached to ──────────────────
  //   project:<pid>   cave:<cid>   survey:<cid>:<code>   station:<cid>:<name>
  //   area:<cid>:<spec>   lead:<lid>   doc:<did>   segment:<cid>:<sid>   feature:<fid>
  // An area is a set of stations for pages that cover more than one station
  // but no whole survey: names and ranges, comma separated ("A10~A22,B3").
  const T = {
    project: pid => 'project:' + pid,
    cave: cid => 'cave:' + cid,
    survey: (cid, code) => 'survey:' + cid + ':' + code,
    station: (cid, name) => 'station:' + cid + ':' + name,
    area: (cid, spec) => 'area:' + cid + ':' + spec,
    lead: lid => 'lead:' + lid,
    doc: did => 'doc:' + did,
    segment: (cid, sid) => 'segment:' + cid + ':' + sid,
    feature: fid => 'feature:' + fid,          // a surface point (a lead at a dig, a spring…)
  };
  function parseTarget(t) {
    const s = String(t || ''), i = s.indexOf(':');
    if (i < 0) return { kind: '' };
    const kind = s.slice(0, i), rest = s.slice(i + 1);
    if (kind === 'project') return { kind, pid: rest };
    if (kind === 'cave') return { kind, cave: rest };
    if (kind === 'lead') return { kind, lead: rest };
    if (kind === 'doc') return { kind, doc: rest };
    if (kind === 'feature') return { kind, feature: rest };
    if (kind === 'survey' || kind === 'station' || kind === 'area' || kind === 'segment') {
      const j = rest.indexOf(':');
      const cave = j < 0 ? rest : rest.slice(0, j), v = j < 0 ? '' : rest.slice(j + 1);
      return kind === 'survey' ? { kind, cave, code: v } : kind === 'station' ? { kind, cave, name: v }
        : kind === 'segment' ? { kind, cave, seg: v } : { kind, cave, spec: v };
    }
    return { kind };
  }
  // Does an area spec cover a station? "A10~A22" = same prefix, number between
  // (A10, A10a, A11 … A22); otherwise names must match exactly.
  function areaHas(spec, name) {
    const n = String(name || '').trim();
    if (!n) return false;
    const split = x => { const m = /^(.*?)(\d+)([^\d]*)$/.exec(String(x).trim()); return m ? { pre: m[1], num: +m[2], suf: m[3] } : null; };
    return String(spec || '').split(',').some(item => {
      item = item.trim();
      if (!item) return false;
      const k = item.indexOf('~');
      if (k < 0) return item === n;
      const a = split(item.slice(0, k)), b = split(item.slice(k + 1)), x = split(n);
      if (!a || !b || !x || a.pre !== b.pre || x.pre !== a.pre) return false;
      const lo = Math.min(a.num, b.num), hi = Math.max(a.num, b.num);
      return x.num >= lo && x.num <= hi;
    });
  }

  // ── Documents: kinds (per document, or per page when a file mixes them) ──
  // Dates may be approximate: "1994-07-16", "1994-07", "1994", "1970s", "c. 1975".
  const DOC_KINDS = ['sketch-plan', 'sketch-profile', 'cross-sections', 'shot-table', 'trip-report', 'map', 'photo',
                     'letter', 'notes', 'other'];
  const DOC_KIND_LABELS = { 'sketch-plan': 'Sketch (plan)', 'sketch-profile': 'Sketch (profile)', 'cross-sections': 'Cross-sections',
    'shot-table': 'Shot table', 'trip-report': 'Trip report', map: 'Map', photo: 'Photo', letter: 'Letter', notes: 'Notes', other: 'Other' };
  // A date to sort by (approximate dates sort at their start): "1970s" → "1970".
  function dateKey(d) {
    const s = String(d || '');
    const m = /(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(s);
    return m ? m[1] + (m[2] ? '-' + m[2] : '') + (m[3] ? '-' + m[3] : '') : '';
  }

  // ── Proposals (the archive processor, or any helper that only suggests) ──
  // An entry with `proposed: { by, confidence, evidence }` changes nothing
  // until an `accept` names it (`ref` or `refs`); `reject` turns it down. On
  // accept the proposal applies at the accept's place in the history, with
  // the reviewer's corrections (`fields`) and the accept's `base`, so it
  // builds on what the reviewer saw.
  function resolveProposals(ordered) {
    const out = [], props = {}, stash = new Map();
    ordered.forEach(e => {
      if (e.proposed) {
        stash.set(e.id, e);
        props[e.id] = { id: e.id, op: e.op, entry: e, by: e.proposed.by || e.who, confidence: e.proposed.confidence,
                        evidence: e.proposed.evidence || [], state: 'open' };
        return;
      }
      if (e.op === 'accept' || e.op === 'reject') {
        const refs = [].concat(e.ref != null ? [e.ref] : [], e.refs || []);
        refs.forEach(ref => {
          const p = stash.get(ref), rec = props[ref];
          if (!p || !rec) return;
          if (e.op === 'reject') { if (rec.state === 'open') { rec.state = 'rejected'; rec.decided = { who: e.who, t: e.t, why: e.why }; } return; }
          if (rec.state === 'accepted') return;
          rec.state = 'accepted'; rec.decided = { who: e.who, t: e.t };
          const x = clone(p);
          delete x.proposed;
          if (e.fields) { if (x.fields) Object.assign(x.fields, clone(e.fields)); else Object.assign(x, clone(e.fields)); }
          x.base = [...new Set((p.base || []).concat((e.base || []).filter(b => b !== p.id)))];
          x.t = e.t;
          x.accepted = { id: e.id, who: e.who, t: e.t, by: rec.by };
          out.push(x);
        });
        return;
      }
      out.push(e);
    });
    return { effective: out, proposals: props };
  }
  // Open proposals of a project and its documents, most confident first.
  function reviewQueue(S, D) {
    const all = Object.values((S && S.proposals) || {}).concat(Object.values((D && D.proposals) || {}));
    return all.filter(p => p.state === 'open').sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  }

  // ── Leads: the fields and their choices ───────────────────────────────────
  // Lists are per project and can be extended (project.lists); these are the
  // defaults every project starts with.
  const LEAD = {
    // [value, label, active]. Active leads are the list to plan from; closed
    // ones leave it but keep their history and can be reopened.
    status: [
      ['open', 'Open', true], ['confirmed', 'Confirmed', true], ['unknown', 'Unknown', true],
      ['surveyed', 'Surveyed into', false], ['deadend', 'Dead end', false], ['mopped', 'Mop-up done', false],
      ['notalead', 'Not a lead', false],
    ],
    types: [
      'Open survey', 'Mop-up', 'Bedrock dig', 'Sediment dig', 'Boulder choke', 'Free climb', 'Aid climb',
      'Aid traverse', 'Rope drop / pit', 'Dive', 'Unknown',
    ],
    air: ['None', 'Blowing in', 'Blowing out', 'Strong in', 'Strong out', 'Unknown'],
    water: ['Dry', 'Drips', 'Flowing', 'Pool / sump', 'Unknown'],
    hazards: ['Loose rock', 'Bad air', 'Flooding', 'Fragile formations', 'Exposure / fall', 'Cold / wet'],
  };
  // The form, in order. kind: one (single choice) · many (multi) · text · num · area (long text)
  const LEAD_FIELDS = [
    { k: 'status', label: 'Status', kind: 'one', list: 'status' },
    { k: 'types', label: 'What it needs', kind: 'many', list: 'types' },
    { k: 'priority', label: 'Priority (1 = highest)', kind: 'one', choices: ['1', '2', '3', '4', '5'] },
    { k: 'potential', label: 'Potential', kind: 'one', choices: ['Low', 'Medium', 'High', 'Unknown'] },
    { k: 'desc', label: 'Description', kind: 'area' },
    { k: 'air', label: 'Air', kind: 'one', list: 'air' },
    { k: 'water', label: 'Water', kind: 'one', list: 'water' },
    { k: 'w', label: 'Width of what continues (m)', kind: 'num' },
    { k: 'h', label: 'Height (m)', kind: 'num' },
    { k: 'seen', label: 'Length / depth seen (m)', kind: 'num' },
    { k: 'ground', label: 'Sediment / rock', kind: 'text' },
    { k: 'hazards', label: 'Hazards', kind: 'many', list: 'hazards' },
    { k: 'temp', label: 'Temperature', kind: 'text' },
    { k: 'sound', label: 'Sounds / echo', kind: 'text' },
    { k: 'gear', label: 'Gear needed', kind: 'text' },
    { k: 'effort', label: 'People / time estimate', kind: 'text' },
    { k: 'into', label: 'Surveyed into (survey)', kind: 'text' },
    { k: 'found', label: 'Found by / when', kind: 'text' },
    { k: 'tie', label: 'Station tie (when it isn’t certain)', kind: 'text' },
  ];
  function leadLists(S) {
    const out = {};
    Object.keys(LEAD).forEach(k => {
      const base = LEAD[k].map(x => (Array.isArray(x) ? x.slice(0, 2) : [x, x]));
      const extra = ((S && S.lists && S.lists[k]) || []).filter(v => !base.some(b => b[0] === v)).map(v => [v, v]);
      out[k] = base.concat(extra);
    });
    return out;
  }
  const statusLabel = v => (LEAD.status.find(s => s[0] === v) || [v, v || 'Open'])[1];
  // Active unless its status is one of the closed ones (no status = open).
  const leadActive = l => !l.deleted && (LEAD.status.find(s => s[0] === (l.fields && l.fields.status)) || [0, 0, true])[2];

  // ── Record history and conflicts ─────────────────────────────────────────
  // A record (note, lead, document) is a list of entries. Heads: entries no
  // other entry of the record builds on. More than one head = edits that
  // never saw each other.
  function heads(rec) {
    const sup = new Set();
    rec.entries.forEach(e => (e.base || []).forEach(b => sup.add(b)));
    return rec.entries.filter(e => !sup.has(e.id));
  }

  // ── Project replay ────────────────────────────────────────────────────────
  function emptyProject(pid) {
    return { id: pid, name: '', desc: '', lists: {}, caves: {}, aliases: {}, notes: {}, leads: {},
             surveys: {}, order: [], caveUpdates: {}, surveyVersions: {}, segments: {}, cavefiles: {}, layers: {}, features: {}, groups: {}, proposals: {}, log: [], byId: new Map() };
  }
  function applyFieldSurvey(e, S) {
    const sv = e.sid != null ? S.surveys[e.sid] : null;
    switch (e.op) {
      case 'survey.add': case 'survey.restore': {
        const s = clone(e.survey);
        if (!s.shots) s.shots = [];
        S.surveys[s.id] = s;
        if (!S.order.includes(s.id)) S.order.push(s.id);
        return true;
      }
      case 'survey.set': if (S.surveys[e.id]) Object.assign(S.surveys[e.id], clone(e.patch)); return true;
      case 'survey.delete': delete S.surveys[e.id]; S.order = S.order.filter(x => x !== e.id); return true;
      case 'shot.add':
        if (sv) {
          const i = e.index != null && e.index >= 0 && e.index <= sv.shots.length ? e.index : sv.shots.length;
          sv.shots.splice(i, 0, clone(e.shot));
        }
        return true;
      case 'shot.set':
        if (sv) { const i = sv.shots.findIndex(s => s.id === e.shot.id); if (i >= 0) sv.shots[i] = clone(e.shot); }
        return true;
      case 'shot.delete': if (sv) sv.shots = sv.shots.filter(s => s.id !== e.shotId); return true;
      case 'cave.update': S.caveUpdates[e.cave] = { id: e.id, file: e.file, plt: e.plt, fit: e.fit, t: e.t, who: e.who }; return true;
      case 'cave.revert': delete S.caveUpdates[e.cave]; return true;
      default: return false;
    }
  }
  function replayProject(entries, pid) {
    const S = emptyProject(pid);
    const recs = { note: {}, lead: {} };
    const ordered = causalOrder(dedupe(entries));   // the same entry merged twice counts once
    ordered.forEach(e => { S.byId.set(e.id, e); S.log.push(e); });
    const R = resolveProposals(ordered);
    S.proposals = R.proposals;
    R.effective.forEach(e => {
      if (applyFieldSurvey(e, S)) return;
      switch (e.op) {
        case 'project.set':
          if (e.name != null) S.name = String(e.name);
          if (e.desc != null) S.desc = String(e.desc);
          break;
        case 'project.lists':
          Object.keys(e.add || {}).forEach(k => {
            const cur = S.lists[k] || (S.lists[k] = []);
            (e.add[k] || []).forEach(v => { v = String(v).trim(); if (v && !cur.includes(v)) cur.push(v); });
          });
          break;
        case 'cave.set': {
          const c = S.caves[e.cave] || (S.caves[e.cave] = { id: e.cave, name: '', sources: [], desc: '', t: e.t, who: e.who });
          if (e.name != null) c.name = String(e.name);
          if (e.sources != null) c.sources = clone(e.sources);
          if (e.desc != null) c.desc = String(e.desc);
          if (e.removed != null) c.removed = !!e.removed;
          c.updated = { t: e.t, who: e.who };
          break;
        }
        case 'cave.alias': if (e.alias != null) S.aliases[String(e.alias)] = e.cave; break;
        case 'cave.unalias': if (S.aliases[String(e.alias)] === e.cave) delete S.aliases[String(e.alias)]; break;
        case 'survey.version': {
          // A corrected / rebuilt survey (transcribed notes): kept beside the
          // original, never replacing it.
          const k = e.cave + '|' + e.code;
          (S.surveyVersions[k] || (S.surveyVersions[k] = [])).push({ id: e.id, version: e.version || e.id, of: e.of || null,
            raw: clone(e.raw), provenance: clone(e.provenance || []), note: e.note || '', who: e.who, t: e.t });
          break;
        }
        case 'segment.set': {
          // A segment: shots of a cave surveyed together (one trip, one book).
          // Optional — a project without segments never sees them.
          const g = S.segments[e.seg] || (S.segments[e.seg] = { id: e.seg, cave: e.cave, name: '', shots: [], t: e.t, who: e.who });
          ['cave', 'name', 'date', 'team', 'desc', 'source'].forEach(k => { if (e[k] != null) g[k] = String(e[k]); });
          if (Array.isArray(e.shots)) g.shots = e.shots.filter(x => Array.isArray(x) && x.length === 2).map(x => [String(x[0]), String(x[1])]);
          if (e.check != null) g.check = clone(e.check);
          g.removed = false;
          g.updated = { t: e.t, who: e.who };
          break;
        }
        case 'segment.del': [].concat(e.seg != null ? [e.seg] : [], e.segs || []).forEach(id => { if (S.segments[id]) S.segments[id].removed = true; }); break;
        // The project as a workspace: its survey files (the file itself, stored
        // by hash, so a sync file carries it) with where they are placed, and
        // what else it loads (point clouds, CalTopo maps, data files).
        case 'cavefile.set': {
          const f = S.cavefiles[e.file] || (S.cavefiles[e.file] = { file: e.file, t: e.t, who: e.who });
          ['h', 'ext'].forEach(k => { if (e[k] != null) f[k] = String(e[k]); });
          if (e.place !== undefined) { f.place = clone(e.place); f.placed = { t: e.t, who: e.who }; }
          if (e.removed != null) f.removed = !!e.removed; else if (e.h) f.removed = false;
          if (e.display !== undefined) f.display = clone(e.display);           // My data: the cave's style
          if (e.lastUsed != null) f.lastUsed = String(e.lastUsed);
          if (e.group != null) f.group = String(e.group);
          f.updated = { t: e.t, who: e.who };
          break;
        }
        // Surface features the project keeps itself (FLEX only — CalTopo keeps
        // its own): points, lines, areas in groups that can nest.
        case 'feature.set': {
          const f = S.features[e.feature] || (S.features[e.feature] = { id: e.feature, created: { t: e.t, who: e.who } });
          ['kind', 'name', 'desc', 'group'].forEach(k => { if (e[k] != null) f[k] = String(e[k]); });
          if (Array.isArray(e.coords)) f.coords = e.coords.filter(c => Array.isArray(c) && c.length >= 2).map(c => c.slice(0, 3).map(Number));
          if (e.style != null) f.style = clone(e.style);
          if (e.removed != null) f.removed = !!e.removed;
          f.updated = { t: e.t, who: e.who };
          break;
        }
        case 'group.set': {
          const g = S.groups[e.group] || (S.groups[e.group] = { id: e.group, name: '', parent: '' });
          ['name', 'parent', 'color', 'kind', 'savedAt'].forEach(k => { if (e[k] != null) g[k] = String(e[k]); });
          if (e.caves !== undefined) g.caves = clone(e.caves);                 // My data: a saved cave set
          if (e.removed != null) g.removed = !!e.removed;
          g.updated = { t: e.t, who: e.who };
          break;
        }
        case 'layer.set': {
          const l = S.layers[e.layer] || (S.layers[e.layer] = { id: e.layer, t: e.t, who: e.who });
          ['kind', 'url', 'name', 'group'].forEach(k => { if (e[k] != null) l[k] = String(e[k]); });
          if (e.interval != null) l.interval = Number(e.interval);
          if (e.lastUsed != null) l.lastUsed = String(e.lastUsed);
          if (e.blob != null) l.blob = String(e.blob);                         // a data file stored by fingerprint ("<sha>.<ext>")
          if (e.order != null) l.order = Number(e.order);
          if (e.removed != null) l.removed = !!e.removed;
          l.updated = { t: e.t, who: e.who };
          break;
        }
        case 'note.set': (recs.note[e.note] || (recs.note[e.note] = { id: e.note, entries: [] })).entries.push(e); break;
        case 'lead.set': case 'lead.del': case 'lead.restore':
          (recs.lead[e.lead] || (recs.lead[e.lead] = { id: e.lead, entries: [] })).entries.push(e); break;
        default: break;                       // map.* and anything newer: history only
      }
    });
    // Notes: the latest head's text; two heads with different text: conflict.
    Object.values(recs.note).forEach(r => {
      const first = r.entries[0];
      const hs = heads(r);
      const cur = hs.reduce((a, b) => (cmp(a, b) < 0 ? b : a));
      const n = { id: r.id, target: r.entries.reduce((a, e) => e.target || a, first.target), text: cur.text || '', who: cur.who, t: cur.t,
                  kind: r.entries.reduce((a, e) => (e.kind != null ? String(e.kind) : a), ''),
                  page: r.entries.reduce((a, e) => (e.page != null ? clone(e.page) : a), null),
                  created: { who: first.who, t: first.t }, history: r.entries.map(e => e.id), heads: hs.map(e => e.id) };
      const texts = new Set(hs.map(e => e.text || ''));
      if (hs.length > 1 && texts.size > 1) n.conflict = hs.map(e => ({ id: e.id, text: e.text || '', who: e.who, t: e.t }));
      if (!n.text && !n.conflict) n.deleted = true;
      S.notes[r.id] = n;
    });
    // Leads: fields applied in order (last writer per field); conflicts per field.
    Object.values(recs.lead).forEach(r => {
      const first = r.entries[0];
      const L = { id: r.id, target: first.target, fields: {}, fieldBy: {}, created: { who: first.who, t: first.t },
                  history: r.entries.map(e => e.id), deleted: false };
      r.entries.forEach(e => {
        if (e.target) L.target = e.target;
        if (e.op === 'lead.del') { L.deleted = true; return; }
        if (e.op === 'lead.restore') { L.deleted = false; return; }
        Object.keys(e.fields || {}).forEach(k => { L.fields[k] = clone(e.fields[k]); L.fieldBy[k] = { who: e.who, t: e.t }; });
        if (e.source) L.source = e.source;
        if (e.sighting) (L.sightings || (L.sightings = [])).push(Object.assign({ who: e.who, t: e.t, entry: e.id }, clone(e.sighting)));
      });
      const hs = heads(r);
      L.heads = hs.map(e => e.id);
      if (hs.length > 1) {
        const by = {};
        hs.forEach(e => Object.keys(e.fields || {}).forEach(k => (by[k] || (by[k] = [])).push({ id: e.id, v: e.fields[k], who: e.who, t: e.t })));
        Object.keys(by).forEach(k => {
          const vals = by[k];
          if (vals.length > 1 && new Set(vals.map(x => JSON.stringify(x.v))).size > 1) (L.conflicts || (L.conflicts = {}))[k] = vals;
        });
      }
      L.updated = { who: r.entries[r.entries.length - 1].who, t: r.entries[r.entries.length - 1].t };
      S.leads[r.id] = L;
    });
    return S;
  }
  // The cave an export's cave name stands for (an alias, else a cave of that name).
  function caveForName(S, name) {
    if (!S) return null;
    const n = String(name || '');
    if (S.aliases[n] && S.caves[S.aliases[n]] && !S.caves[S.aliases[n]].removed) return S.aliases[n];
    const low = n.trim().toLowerCase();
    const c = Object.values(S.caves).find(c => !c.removed && c.name.trim().toLowerCase() === low);
    return c ? c.id : null;
  }
  const liveCaves = S => Object.values((S && S.caves) || {}).filter(c => !c.removed).sort((a, b) => a.name.localeCompare(b.name));
  // Notes / leads on a target, newest first.
  const notesOn = (S, target) => Object.values(S.notes).filter(n => n.target === target && !n.deleted).sort((a, b) => (a.t < b.t ? 1 : -1));
  const leadsOn = (S, target) => Object.values(S.leads).filter(l => l.target === target && !l.deleted);

  // ── Documents replay (scope "docs") ──────────────────────────────────────
  function replayDocs(entries) {
    const D = { docs: {}, byId: new Map(), log: [], proposals: {} };
    const recs = {};
    const ordered = causalOrder(dedupe(entries));
    ordered.forEach(e => { D.byId.set(e.id, e); D.log.push(e); });
    const R = resolveProposals(ordered);
    D.proposals = R.proposals;
    R.effective.forEach(e => {
      if (!/^doc\./.test(e.op) || !e.doc) return;
      (recs[e.doc] || (recs[e.doc] = { id: e.doc, entries: [] })).entries.push(e);
    });
    Object.values(recs).forEach(r => {
      // A document starts with its doc.add, wherever the clocks put it.
      r.entries = r.entries.filter(e => e.op === 'doc.add').concat(r.entries.filter(e => e.op !== 'doc.add'));
      const d = { id: r.id, title: '', kind: '', date: '', desc: '', pages: [], tags: {}, deleted: false, file: null,
                  history: r.entries.map(e => e.id) };
      r.entries.forEach(e => {
        switch (e.op) {
          case 'doc.add':
            if (!d.created) d.created = { who: e.who, t: e.t };
            ['title', 'kind', 'date', 'desc'].forEach(k => { if (e[k] != null) d[k] = String(e[k]); });
            if (e.has_coordinates != null) d.has_coordinates = !!e.has_coordinates;
            (e.pages || []).forEach(p => { if (!d.pages.some(q => q.h === p.h)) d.pages.push(Object.assign({ rot: 0 }, clone(p))); });
            (e.tags || []).forEach(t => { d.tags[t] = true; });
            break;
          case 'doc.set':
            ['title', 'kind', 'date', 'desc'].forEach(k => { if (e.fields && e.fields[k] != null) d[k] = String(e.fields[k]); });
            if (e.fields && e.fields.has_coordinates != null) d.has_coordinates = !!e.fields.has_coordinates;
            break;
          case 'doc.page': d.pages.forEach(p => { if (p.h === e.h) ['kind', 'date'].forEach(k => { if (e.fields && e.fields[k] != null) p[k] = String(e.fields[k]); }); }); break;
          case 'doc.pages': {
            const at = e.at != null && e.at >= 0 ? Math.min(e.at, d.pages.length) : d.pages.length;
            const add = (e.add || []).filter(p => !d.pages.some(q => q.h === p.h)).map(p => Object.assign({ rot: 0 }, clone(p)));
            d.pages.splice(at, 0, ...add);
            break;
          }
          case 'doc.droppage': d.pages = d.pages.filter(p => p.h !== e.h); break;
          case 'doc.order': if (Array.isArray(e.order)) d.pages.sort((a, b) => e.order.indexOf(a.h) - e.order.indexOf(b.h)); break;
          case 'doc.rotate': d.pages.forEach(p => { if (p.h === e.h) p.rot = ((Number(e.rot) || 0) % 360 + 360) % 360; }); break;
          case 'doc.tag': d.tags[e.target] = true; break;
          case 'doc.untag': delete d.tags[e.target]; break;
          case 'doc.del': d.deleted = true; break;
          case 'doc.restore': d.deleted = false; break;
          // The original file the page images were made from (they are renderings for viewing).
          case 'doc.file': if (e.file && /^[0-9a-f]{64}$/.test(e.file.h || '')) d.file = { h: e.file.h, ext: String(e.file.ext || ''), name: String(e.file.name || ''), path: String(e.file.path || ''), size: Number(e.file.size) || 0 }; break;
          default: break;
        }
        d.updated = { who: e.who, t: e.t };
      });
      const hs = heads({ entries: r.entries.filter(e => e.op === 'doc.set') });
      if (hs.length > 1) {
        const by = {};
        hs.forEach(e => Object.keys(e.fields || {}).forEach(k => (by[k] || (by[k] = [])).push({ id: e.id, v: e.fields[k], who: e.who, t: e.t })));
        Object.keys(by).forEach(k => { if (by[k].length > 1 && new Set(by[k].map(x => JSON.stringify(x.v))).size > 1) (d.conflicts || (d.conflicts = {}))[k] = by[k]; });
      }
      d.tagList = Object.keys(d.tags);
      D.docs[r.id] = d;
    });
    return D;
  }
  // Is a document in project S (tagged to it, or to anything of it)?
  function docInProject(d, S) {
    return d.tagList.some(t => {
      const p = parseTarget(t);
      if (p.kind === 'project') return p.pid === S.id;
      if (p.cave) return !!S.caves[p.cave];
      if (p.kind === 'lead') return !!S.leads[p.lead];
      return false;
    });
  }
  // Inbox: in the project but tagged to nothing more specific than it.
  const docInbox = (d, S) => d.tagList.every(t => t === T.project(S.id)) && d.tagList.length > 0;
  function docsOf(D, S, opts = {}) {
    return Object.values(D.docs).filter(d => (opts.deleted ? d.deleted : !d.deleted) && docInProject(d, S))
      .sort((a, b) => String(b.created && b.created.t).localeCompare(String(a.created && a.created.t)));
  }
  // Documents for a station: tagged to the station, then to its surveys, then its cave.
  function docsForStation(D, S, cave, name, codes) {
    const st = T.station(cave, name), svs = (codes || []).map(c => T.survey(cave, c));
    const live = Object.values(D.docs).filter(d => !d.deleted);
    const inArea = d => d.tagList.some(t => { const p = parseTarget(t); return p.kind === 'area' && p.cave === cave && areaHas(p.spec, name); });
    const segs = segmentsAt(S, cave, name).map(g => T.segment(cave, g.id));
    const station = live.filter(d => d.tags[st]);
    const area = live.filter(d => !d.tags[st] && inArea(d));
    const segment = live.filter(d => !d.tags[st] && !area.includes(d) && segs.some(s => d.tags[s]));
    const survey = live.filter(d => !d.tags[st] && !area.includes(d) && !segment.includes(d) && svs.some(s => d.tags[s]));
    const caveDocs = live.filter(d => !d.tags[st] && !area.includes(d) && !segment.includes(d) && !survey.includes(d) && d.tags[T.cave(cave)]);
    return { station, area, segment, survey, cave: caveDocs };
  }
  // The page of a document that covers a target (pages may list `targets`), else the first.
  function pageFor(d, target) {
    const i = (d && d.pages || []).findIndex(p => Array.isArray(p.targets) && p.targets.includes(target));
    return i < 0 ? 0 : i;
  }

  // ── Workspace: what a project loads ───────────────────────────────────────
  const liveCavefiles = S => Object.values((S && S.cavefiles) || {}).filter(f => !f.removed && f.h).sort((a, b) => a.file.localeCompare(b.file));
  const liveLayers = S => Object.values((S && S.layers) || {}).filter(l => !l.removed).sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name)));

  // ── Surface features (the project's own; FLEX only — not in CalTopo) ──────
  // { id, kind: point | line | area, coords: [[lon, lat, h?]…], name, desc, group, style: { color } }
  // Groups nest by parent; a feature in a removed group goes to the top.
  function liveGroups(S) {
    const all = (S && S.groups) || {};
    const alive = id => { const seen = new Set(); while (id && all[id] && !seen.has(id)) { if (all[id].removed) return false; seen.add(id); id = all[id].parent; } return true; };
    return Object.values(all).filter(g => alive(g.id)).sort((a, b) => a.name.localeCompare(b.name));
  }
  function liveFeatures(S, group) {
    const groups = new Set(liveGroups(S).map(g => g.id));
    return Object.values((S && S.features) || {}).filter(f => !f.removed && f.coords && f.coords.length)
      .map(f => (f.group && !groups.has(f.group) ? Object.assign({}, f, { group: '' }) : f))
      .filter(f => group === undefined || (f.group || '') === group)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }
  // A group and everything under it.
  function groupPath(S, id) { const out = [], seen = new Set(); while (id && S.groups[id] && !seen.has(id)) { seen.add(id); out.unshift(S.groups[id]); id = S.groups[id].parent; } return out; }
  function underGroup(S, gid) {
    if (!gid) return liveFeatures(S);
    const kids = new Set([gid]);
    let grew = true;
    while (grew) { grew = false; liveGroups(S).forEach(g => { if (kids.has(g.parent) && !kids.has(g.id)) { kids.add(g.id); grew = true; } }); }
    return liveFeatures(S).filter(f => kids.has(f.group));
  }
  // Downloads, for CalTopo's import (GeoJSON / KML / GPX). The group path goes
  // in a "folder" property / KML folders so the grouping survives.
  function featuresGeoJSON(S, gid) {
    const folder = f => groupPath(S, f.group).map(g => g.name).join('/');
    return { type: 'FeatureCollection', features: underGroup(S, gid).map(f => ({
      type: 'Feature', id: f.id,
      properties: { title: f.name || '', description: f.desc || '', folder: folder(f), 'marker-color': (f.style && f.style.color) || undefined, stroke: f.kind !== 'point' ? (f.style && f.style.color) || undefined : undefined },
      geometry: f.kind === 'point' ? { type: 'Point', coordinates: f.coords[0] }
        : f.kind === 'area' ? { type: 'Polygon', coordinates: [f.coords.concat([f.coords[0]])] } : { type: 'LineString', coordinates: f.coords },
    })) };
  }
  const xml = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function featuresKML(S, gid, title) {
    const kml = c => c.map(p => `${p[0]},${p[1]},${p[2] || 0}`).join(' ');
    const abgr = hex => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); return m ? 'ff' + m[1].slice(4, 6) + m[1].slice(2, 4) + m[1].slice(0, 2) : 'ff00a5ff'; };
    const pm = f => `<Placemark><name>${xml(f.name)}</name><description>${xml(f.desc)}</description>` +
      `<Style><IconStyle><color>${abgr(f.style && f.style.color)}</color></IconStyle><LineStyle><color>${abgr(f.style && f.style.color)}</color><width>3</width></LineStyle><PolyStyle><color>40${abgr(f.style && f.style.color).slice(2)}</color></PolyStyle></Style>` +
      (f.kind === 'point' ? `<Point><coordinates>${kml(f.coords)}</coordinates></Point>`
        : f.kind === 'area' ? `<Polygon><outerBoundaryIs><LinearRing><coordinates>${kml(f.coords.concat([f.coords[0]]))}</coordinates></LinearRing></outerBoundaryIs></Polygon>`
        : `<LineString><coordinates>${kml(f.coords)}</coordinates></LineString>`) + '</Placemark>';
    const feats = underGroup(S, gid), groups = liveGroups(S);
    const top = gid ? (S.groups[gid] || {}).parent || '' : '';
    const folder = (pid) => groups.filter(g => (g.parent || '') === pid && (!gid || pid !== top || g.id === gid))
      .map(g => `<Folder><name>${xml(g.name)}</name>${folder(g.id)}${feats.filter(f => f.group === g.id).map(pm).join('')}</Folder>`).join('');
    const body = (gid ? '' : feats.filter(f => !f.group).map(pm).join('')) + folder(gid ? top : '');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xml(title || 'FLEX features')}</name>${body}</Document></kml>\n`;
  }
  function featuresGPX(S, gid) {
    const pt = (p, tag) => `<${tag} lat="${p[1]}" lon="${p[0]}">${p[2] != null ? `<ele>${p[2]}</ele>` : ''}</${tag}>`;
    const feats = underGroup(S, gid);
    const wpts = feats.filter(f => f.kind === 'point').map(f => `<wpt lat="${f.coords[0][1]}" lon="${f.coords[0][0]}"><name>${xml(f.name)}</name><desc>${xml(f.desc)}</desc></wpt>`).join('');
    const trks = feats.filter(f => f.kind !== 'point').map(f => `<trk><name>${xml(f.name)}</name><desc>${xml(f.desc)}</desc><trkseg>${(f.kind === 'area' ? f.coords.concat([f.coords[0]]) : f.coords).map(p => pt(p, 'trkpt')).join('')}</trkseg></trk>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="FLEX" xmlns="http://www.topografix.com/GPX/1/1">${wpts}${trks}</gpx>\n`;
  }
  // A cave tag in a point's description (CalTopo marker or FLEX point):
  //   flex: cave=Ridge Cave; station=E1
  // → { cave, station }. One per description; case-insensitive keys.
  function flexTag(desc) {
    const m = /(?:^|\n|>)\s*flex\s*:\s*([^\n<]+)/i.exec(String(desc || ''));
    if (!m) return null;
    const out = {};
    m[1].split(';').forEach(kv => { const i = kv.indexOf('='); if (i > 0) out[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim(); });
    return out.cave ? { cave: out.cave, station: out.station || '' } : null;
  }
  const makeFlexTag = (cave, station) => `flex: cave=${cave}; station=${station}`;

  // ── Segments (optional): shots of a cave surveyed together ────────────────
  // { id, cave, name, date, team, desc, shots: [[from, to]…], check: { done, total } }
  // `check`: how many of its shots were checked against the original notes.
  const segmentsOf = (S, cid) => Object.values((S && S.segments) || {}).filter(g => !g.removed && (cid == null || g.cave === cid));
  // Lookups for a cave: shot "from|to" (either way) → segment ids, station → segment ids.
  function segmentIndex(S, cid) {
    const shot = new Map(), station = new Map();
    const add = (m, k, id) => { const a = m.get(k); if (!a) m.set(k, [id]); else if (!a.includes(id)) a.push(id); };
    segmentsOf(S, cid).forEach(g => g.shots.forEach(([a, b]) => {
      add(shot, a + '|' + b, g.id); add(shot, b + '|' + a, g.id);
      add(station, a, g.id); add(station, b, g.id);
    }));
    return { shot, station };
  }
  const segmentsAt = (S, cid, name) => segmentsOf(S, cid).filter(g => g.shots.some(([a, b]) => a === name || b === name));
  // What a proposal is about: its entry's target (notes, leads, survey versions carry one).
  function proposalTarget(p) {
    const e = p && p.entry;
    if (!e) return '';
    if (e.target) return e.target;
    if (e.op === 'lead.set' || e.op === 'note.set') return '';
    return e.cave && e.tie ? T.station(e.cave, e.tie) : '';
  }
  // Review state of every segment of a cave: open problems (suggested notes of
  // kind "issue", suggested survey versions; suggested leads and other notes
  // counted apart, as `leads` and `notes`) and accepted problem notes (kind "issue") on the
  // segment or its stations, documents, how much was checked.
  // state: problem · review · checked · partly · unchecked.
  function segmentStates(S, D, cid) {
    const segs = segmentsOf(S, cid), out = {};
    const idx = segmentIndex(S, cid);
    const bump = (t, key) => {
      const p = parseTarget(t);
      if (p.cave !== cid) return;
      const ids = p.kind === 'segment' ? [p.seg] : p.kind === 'station' ? (idx.station.get(p.name) || []) : [];
      ids.forEach(id => { if (out[id]) out[id][key]++; });
    };
    segs.forEach(g => { out[g.id] = { open: 0, leads: 0, notes: 0, problems: 0, docs: 0, done: g.check ? +g.check.done || 0 : 0, total: g.check ? +g.check.total || 0 : 0 }; });
    // Suggested leads are counted apart: a lead isn't something wrong with the survey.
    // Problems are suggested notes of kind "issue" and suggested survey versions; other notes count as `notes`.
    reviewQueue(S, D).forEach(p => {
      const e = p.entry;
      bump(proposalTarget(p), e.op === 'lead.set' ? 'leads' : (e.op === 'note.set' && e.kind === 'issue') || e.op === 'survey.version' ? 'open' : 'notes');
    });
    Object.values(S.notes).forEach(n => { if (!n.deleted && n.kind === 'issue') bump(n.target, 'problems'); });
    Object.values((D && D.docs) || {}).forEach(d => { if (!d.deleted) d.tagList.forEach(t => bump(t, 'docs')); });
    Object.values(out).forEach(o => {
      const f = o.total ? o.done / o.total : 0;
      o.state = o.problems ? 'problem' : o.open ? 'review' : f >= 0.9 ? 'checked' : f > 0 ? 'partly' : 'unchecked';
    });
    return out;
  }
  const docsForTarget = (D, target) => Object.values(D.docs).filter(d => !d.deleted && d.tags[target]);

  // ── Sync files ────────────────────────────────────────────────────────────
  // What goes in a sync file for project P: its entries and the entries of
  // its documents, either everything or what was not in this device's last
  // sync file for P (`sent`: { scope: { dev: lastSeq } }), plus the pages
  // those document entries reference.
  function selectForSync(projectEntries, docEntries, S, D, sent, mode) {
    const all = mode === 'all';
    const after = (scope, e) => all || !(sent && sent[scope] && sent[scope][e.dev] >= e.seq);
    const pScope = projScope(S.id);
    const docIds = new Set(Object.values(D.docs).filter(d => docInProject(d, S)).map(d => d.id));
    // A document entry, or an accept / reject of one (they name the proposal, not the document).
    const docOf = e => e.doc ? docIds.has(e.doc)
      : [].concat(e.ref != null ? [e.ref] : [], e.refs || []).some(r => { const x = D.byId.get(r); return x && x.doc && docIds.has(x.doc); });
    const out = { [pScope]: projectEntries.filter(e => after(pScope, e)),
                  [DOCS]: docEntries.filter(e => after(DOCS, e) && docOf(e)) };
    const blobs = new Set();
    out[DOCS].forEach(e => (e.pages || e.add || []).forEach(p => p && p.h && blobs.add(p.h + '.' + (p.ext || 'jpg'))));
    out[pScope].forEach(e => { if (e.op === 'cavefile.set' && e.h) blobs.add(e.h + '.' + (e.ext || 'plt')); });   // survey files travel too
    const next = clone(sent || {});
    Object.keys(out).forEach(sc => out[sc].forEach(e => {
      const m = next[sc] || (next[sc] = {});
      if (!(m[e.dev] >= e.seq)) m[e.dev] = e.seq;
    }));
    return { entries: out, blobs: [...blobs], sent: next,
             count: out[pScope].length + out[DOCS].length };
  }
  function syncManifest(S, dev, who, sel) {
    const scopes = {};
    Object.keys(sel.entries).forEach(sc => {
      const m = scopes[sc] = {};
      sel.entries[sc].forEach(e => { const r = m[e.dev] || (m[e.dev] = { from: e.seq, to: e.seq, n: 0 }); r.from = Math.min(r.from, e.seq); r.to = Math.max(r.to, e.seq); r.n++; });
    });
    return { format: 'flex-sync', version: FORMAT, created: nowIso(), from: { dev, who: who || '' },
             project: { id: S.id, name: S.name || '' }, scopes, blobs: sel.blobs.length };
  }
  // Entries from a sync file that this device doesn't have yet, per scope and device.
  function newEntries(knownIds, incoming) {
    const out = [];
    const seen = new Set();
    incoming.forEach(e => {
      if (!e || !e.id || !e.dev || !(e.seq > 0) || knownIds.has(e.id) || seen.has(e.id)) return;
      if (e.id !== e.dev + '.' + e.seq) return;          // malformed: skip rather than guess
      seen.add(e.id);
      out.push(e);
    });
    return out.sort((a, b) => (a.dev === b.dev ? a.seq - b.seq : (a.dev < b.dev ? -1 : 1)));
  }

  // ── Field survey: numbers and reduction (shared by the viewer and FLEX) ──
  // A cell as typed → { v, raw, flag }. LRUD: "3/5" is a ledge, the larger
  // value is used; a hyphen, comma or space between numbers is flagged.
  function parseNum(raw, kind) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return { v: null, raw: '' };
    if (kind === 'lrud') {
      if (/^\d*\.?\d+\s*\/\s*\d*\.?\d+(\s*\/\s*\d*\.?\d+)*$/.test(s)) {
        const parts = s.split('/').map(Number);
        return { v: Math.max(...parts), raw: s, note: 'ledge: larger value used' };
      }
      if (/^\d*\.?\d+\s*[-,\s]\s*\d*\.?\d+$/.test(s)) return { v: null, raw: s, flag: 'two numbers — which one?' };
    }
    const v = Number(s.replace(',', '.'));
    if (!isFinite(v)) return { v: null, raw: s, flag: 'not a number' };
    return { v, raw: s };
  }
  function shotFlags(sh, sv) {
    const f = [], ft = (sv.lenUnit || 'ft') === 'ft';
    const len = parseNum(sh.len), az = parseNum(sh.az), inc = parseNum(sh.inc);
    if (len.flag || len.v == null) f.push('length ' + (len.flag || 'missing'));
    else if (len.v <= 0) f.push('length ≤ 0');
    else if (len.v > (ft ? 400 : 120)) f.push('length unusually long');
    if (az.flag) f.push('azimuth ' + az.flag);
    else if (az.v != null && (az.v < 0 || az.v >= 360)) f.push('azimuth outside 0–360');
    if (inc.flag) f.push('inclination ' + inc.flag);
    else if (inc.v != null && Math.abs(inc.v) > 90) f.push('inclination beyond ±90');
    if (az.v == null && (inc.v == null || Math.abs(inc.v) < 90) && !az.flag) {
      if (parseNum(sh.baz).v == null) f.push('azimuth missing');
    }
    const baz = parseNum(sh.baz), binc = parseNum(sh.binc);
    if (baz.flag) f.push('back azimuth ' + baz.flag);
    if (binc.flag) f.push('back inclination ' + binc.flag);
    if (az.v != null && baz.v != null) {
      const d = Math.abs(((az.v - (baz.v + 180)) % 360 + 540) % 360 - 180);
      if (d > 2) f.push(`fore/back azimuth differ by ${d.toFixed(1)}°`);
    }
    if (inc.v != null && binc.v != null && Math.abs(inc.v + binc.v) > 2)
      f.push(`fore/back inclination differ by ${Math.abs(inc.v + binc.v).toFixed(1)}°`);
    ['l', 'r', 'u', 'd'].forEach(k => {
      const p = parseNum(sh[k], 'lrud');
      if (p.flag) f.push(k.toUpperCase() + ' ' + p.flag);
      else if (p.v != null && (p.v < 0 || p.v * (ft ? FT : 1) > 300)) f.push(k.toUpperCase() + ' implausible');
    });
    if (!String(sh.from || '').trim() || !String(sh.to || '').trim()) f.push('station name missing');
    return f;
  }
  // One reading per shot: fore and back averaged; a backsight alone stands in.
  function shotReading(sh) {
    const az = parseNum(sh.az).v, baz = parseNum(sh.baz).v;
    const inc = parseNum(sh.inc).v, binc = parseNum(sh.binc).v;
    let A = null;
    if (az != null && baz != null) {
      const b = (baz + 180) % 360;
      const s = Math.sin(az * Math.PI / 180) + Math.sin(b * Math.PI / 180), c = Math.cos(az * Math.PI / 180) + Math.cos(b * Math.PI / 180);
      A = (Math.atan2(s, c) * 180 / Math.PI + 360) % 360;
    } else if (az != null) A = az;
    else if (baz != null) A = (baz + 180) % 360;
    let I = null;
    if (inc != null && binc != null) I = (inc - binc) / 2;
    else if (inc != null) I = inc;
    else if (binc != null) I = -binc;
    return { len: parseNum(sh.len).v, az: A, inc: I == null ? 0 : I };
  }
  // Shots → positions in a frame of x = east, y = north, z = up (metres).
  // `known`: Map key → [x, y, z]; keys are `${prefix}${station name}`.
  // `decl(sv, tiePos)` → { v, src }; `conv(tiePos)` → grid convergence (0 in a true-north frame).
  // Works outward from every known station in both directions; reports
  // closures (both ends known) and shots that are not tied in.
  function computeSurvey(sv, known, { prefix = '', decl, conv } = {}) {
    const key = n => prefix + String(n || '').trim();
    const pos = new Map();
    const get = k => pos.get(k) || (known.has(k) ? known.get(k).slice() : null);
    const tie = get(key(sv.tie)) || null;
    const D = decl ? decl(sv, tie) : { v: 0, src: 'none' };
    const C = conv ? conv(tie) : 0;
    const unit = (sv.lenUnit || 'ft') === 'ft' ? FT : 1;
    const legs = [], closures = [];
    const vec = (r, sign) => {
      const g = ((r.az == null ? 0 : r.az) + D.v - C) * Math.PI / 180, i = r.inc * Math.PI / 180;
      const L = r.len * unit, hz = L * Math.cos(i);
      return [sign * hz * Math.sin(g), sign * hz * Math.cos(g), sign * L * Math.sin(i)];
    };
    const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const todo = sv.shots.map((sh, i) => ({ sh, i, r: shotReading(sh) })).filter(o => o.r.len != null && o.r.len > 0);
    let progress = true, travelled = 0;
    const done = new Set();
    while (progress) {
      progress = false;
      for (const o of todo) {
        if (done.has(o.i)) continue;
        const fk = key(o.sh.from), tk = key(o.sh.to);
        const F = get(fk), Tp = get(tk);
        if (F && Tp) {
          const calc = add(F, vec(o.r, 1));
          travelled += o.r.len * unit;
          closures.push({ shot: o.i, at: o.sh.to, err: dist(calc, Tp), along: travelled, dz: calc[2] - Tp[2] });
          legs.push({ i: o.i, from: o.sh.from, to: o.sh.to, a: F, b: Tp });
        } else if (F) { const b = add(F, vec(o.r, 1)); pos.set(tk, b); legs.push({ i: o.i, from: o.sh.from, to: o.sh.to, a: F, b }); travelled += o.r.len * unit; }
        else if (Tp) { const a = add(Tp, vec(o.r, -1)); pos.set(fk, a); legs.push({ i: o.i, from: o.sh.from, to: o.sh.to, a, b: Tp }); travelled += o.r.len * unit; }
        else continue;
        done.add(o.i); progress = true;
      }
    }
    const loose = sv.shots.map((_, i) => i).filter(i => !done.has(i));
    legs.sort((x, y) => x.i - y.i);
    return { pos, legs, closures, loose, decl: D, conv: C };
  }
  // LRUD per station (at From by default, or at To), metres; '–' = not measured.
  function stationLruds(sv) {
    const unit = (sv.lenUnit || 'ft') === 'ft' ? FT : 1, out = new Map();
    sv.shots.forEach(sh => {
      const at = (sv.lrudAt === 'to' ? sh.to : sh.from);
      if (!at) return;
      const v = ['l', 'r', 'u', 'd'].map(k => { const p = parseNum(sh[k], 'lrud'); return p.v == null ? null : p.v * unit; });
      if (v.every(x => x == null)) return;
      const k = String(at).trim();
      if (!out.has(k)) out.set(k, v.map(x => (x == null ? '–' : x)));
    });
    return out;
  }

  // ── Caves inside one survey file ─────────────────────────────────────────
  // Suggested caves: stations joined by underground shots form one cave;
  // surface shots (a surface survey, or a P-flagged point) don't join. Each
  // survey goes with the cave holding most of its stations.
  // segments: [{ survey, surface, points: [{ name, surface }] }]
  function suggestCaves(segments) {
    const parent = new Map();
    const find = x => { let r = x; while (parent.get(r) !== r) r = parent.get(r); let y = x; while (parent.get(y) !== r) { const n = parent.get(y); parent.set(y, r); y = n; } return r; };
    const node = n => { if (!parent.has(n)) parent.set(n, n); return n; };
    const union = (a, b) => { const ra = find(node(a)), rb = find(node(b)); if (ra !== rb) parent.set(ra, rb); };
    const surfaceSurveys = new Set();
    (segments || []).forEach(seg => {
      if (seg.surface) surfaceSurveys.add(seg.survey || '');
      let prev = null;
      (seg.points || []).forEach(p => {
        if (!p.name) { prev = null; return; }
        node(p.name);
        if (prev && !seg.surface && !p.surface && !prev.surface) union(prev.name, p.name);
        prev = p;
      });
    });
    const votes = {};                       // survey → { root → count }
    (segments || []).forEach(seg => {
      if (seg.surface) return;
      (seg.points || []).forEach(p => {
        if (!p.name || p.surface) return;
        const v = votes[seg.survey || ''] || (votes[seg.survey || ''] = {});
        const r = find(p.name);
        v[r] = (v[r] || 0) + 1;
      });
    });
    const groups = {};
    Object.keys(votes).forEach(sv => {
      const best = Object.entries(votes[sv]).sort((a, b) => b[1] - a[1])[0][0];
      (groups[best] || (groups[best] = { surveys: [], stations: 0 })).surveys.push(sv);
    });
    const size = {};
    parent.forEach((_, n) => { const r = find(n); size[r] = (size[r] || 0) + 1; });
    const out = Object.entries(groups).map(([r, g]) => ({ surveys: g.surveys.sort(), stations: size[r] || 0 }))
      .sort((a, b) => b.stations - a.stations);
    return { caves: out, surface: [...surfaceSurveys].filter(s => !votes[s]).sort() };
  }

  return {
    FORMAT, FT, DOCS, projScope, scopeProject, sha256, uid, clone, nowIso, same, cmp, sortEntries, surveyCode,
    T, parseTarget, areaHas, DOC_KINDS, DOC_KIND_LABELS, dateKey, resolveProposals, reviewQueue, causalOrder, LEAD, LEAD_FIELDS, leadLists, statusLabel, leadActive, heads,
    replayProject, replayDocs, caveForName, liveCaves, notesOn, leadsOn,
    docInProject, docInbox, docsOf, docsForStation, docsForTarget, pageFor,
    segmentsOf, segmentIndex, segmentsAt, proposalTarget, segmentStates, liveCavefiles, liveLayers,
    liveFeatures, liveGroups, groupPath, featuresGeoJSON, featuresKML, featuresGPX, flexTag, makeFlexTag,
    selectForSync, syncManifest, newEntries,
    parseNum, shotFlags, shotReading, computeSurvey, stationLruds, suggestCaves,
  };
});
