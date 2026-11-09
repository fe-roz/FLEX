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
  const DOC_KINDS = ['sketch-plan', 'sketch-profile', 'cross-sections', 'shot-table', 'trip-report', 'map', 'photo', 'video',
                     'letter', 'notes', 'topodroid', 'other'];
  const DOC_KIND_LABELS = { 'sketch-plan': 'Sketch (plan)', 'sketch-profile': 'Sketch (profile)', 'cross-sections': 'Cross-sections',
    'shot-table': 'Shot table', 'trip-report': 'Trip report', map: 'Map', photo: 'Photo', video: 'Video', letter: 'Letter', notes: 'Field notes',
    topodroid: 'TopoDroid export', other: 'Other' };
  // Media, shown apart from the papers: 'video' (its kind, or the original is a
  // video file), 'photo' (its kind, or no kind and only photo images), else ''.
  const VIDEO_EXT = /^(mp4|m4v|mov|webm|mkv|avi)$/i, PHOTO_EXT = /^(jpe?g|png|webp|heic|heif|gif)$/i;
  function docMedia(d) {
    if (!d) return '';
    if (d.kind === 'video' || (d.file && VIDEO_EXT.test(d.file.ext || ''))) return 'video';
    if (d.kind === 'photo') return 'photo';
    if (d.kind) return '';
    if (d.file) return PHOTO_EXT.test(d.file.ext || '') ? 'photo' : '';
    const ps = d.pages || [];
    return ps.length && ps.every(p => PHOTO_EXT.test(String(p.name || '').split('.').pop()) && !/\.(tiff?|pdf)\b/i.test(p.name || '')) ? 'photo' : '';
  }
  // A date to sort by (approximate dates sort at their start): "1970s" → "1970".
  function dateKey(d) {
    const s = String(d || '');
    const m = /(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(s);
    return m ? m[1] + (m[2] ? '-' + m[2] : '') + (m[3] ? '-' + m[3] : '') : '';
  }

  // ── Document groups: the four lists documents are shown in (decided 2026-11-08) ─
  //   Survey notes  shot tables, field-note scans, TopoDroid exports
  //   Sketches      plan, profile, cross-sections
  //   Media         photos, videos
  //   Other         trip reports, maps, letters, anything else (and any kind this list does not know)
  // A document's kind says its group (a page's own kind says the page's). No kind: only photo images, or a video
  // file, is Media; anything else is Other. The order here is the order the lists are shown in.
  const DOC_GROUPS = [
    { id: 'notes', label: 'Survey notes', kinds: ['shot-table', 'notes', 'topodroid'] },
    { id: 'sketches', label: 'Sketches', kinds: ['sketch-plan', 'sketch-profile', 'cross-sections'] },
    { id: 'media', label: 'Media', kinds: ['photo', 'video'] },
    { id: 'other', label: 'Other', kinds: ['trip-report', 'map', 'letter', 'other'] },
  ];
  // Older or free-typed spellings of a kind (the details box lets a person type any text).
  const KIND_ALIAS = { 'survey-notes': 'notes', 'field-notes': 'notes', 'survey-note': 'notes', 'shot-tables': 'notes', 'topodroid-export': 'notes', dwg: 'notes', dxf: 'notes',
    sketch: 'sketch-plan', sketches: 'sketch-plan', 'cross-section': 'cross-sections', section: 'cross-sections', sections: 'cross-sections',
    photos: 'photo', photograph: 'photo', image: 'photo', videos: 'video', media: 'photo', 'trip-reports': 'trip-report', report: 'trip-report', maps: 'map', letters: 'letter' };
  const KIND_GROUP = {};
  DOC_GROUPS.forEach(g => g.kinds.forEach(k => { KIND_GROUP[k] = g.id; }));
  const groupLabel = id => (DOC_GROUPS.find(g => g.id === id) || DOC_GROUPS[DOC_GROUPS.length - 1]).label;
  function docGroup(kind) {
    const k = String(kind == null ? '' : kind).trim().toLowerCase().replace(/[\s_]+/g, '-');
    if (KIND_GROUP[k]) return KIND_GROUP[k];
    if (KIND_ALIAS[k]) return KIND_GROUP[KIND_ALIAS[k]];
    return 'other';
  }
  // The group of a document (see above), and of one of its pages (the page's own kind wins, else the document's).
  function docGroupOf(d) {
    if (!d) return 'other';
    if (d.kind === 'video' || (d.file && VIDEO_EXT.test(d.file.ext || ''))) return 'media';
    if (d.kind) return docGroup(d.kind);
    const pk = (d.pages || []).find(p => p && p.kind);
    if (pk) return docGroup(pk.kind);
    return docMedia(d) ? 'media' : 'other';
  }
  const pageGroup = (d, p) => (p && p.kind ? docGroup(p.kind) : docGroupOf(d));
  // Documents split by group, in the groups' order: [{ id, label, docs }]; empty groups left out unless opts.all.
  function groupDocs(docs, opts = {}) {
    const by = {};
    (docs || []).forEach(d => { const g = (opts.of || docGroupOf)(d); (by[g] || (by[g] = [])).push(d); });
    return DOC_GROUPS.map(g => ({ id: g.id, label: g.label, docs: by[g.id] || [] })).filter(g => opts.all || g.docs.length);
  }
  // A sensible kind for a file being added (the person can change it): { name, type, camera } → kind.
  // `camera`: the picture carries camera data (exifCamera). A photo from a camera is Media; a scan (TIFF, a scanner
  // app's file name, a PDF) is Survey notes or Other; a TopoDroid export is Survey notes.
  function suggestKind(f) {
    const name = String((f && f.name) || ''), type = String((f && f.type) || ''), ext = (name.split('.').pop() || '').toLowerCase();
    if (VIDEO_EXT.test(ext) || /^video\//.test(type)) return 'video';
    if (/^(dxf|dwg|th|th2)$/.test(ext)) return 'topodroid';
    if (f && f.camera) return 'photo';
    if (/^(IMG|DSC|PXL|MVIMG|DJI|GOPR|P\d{6})[-_ ]?\d+/i.test(name)) return 'photo';
    if (/sketch/i.test(name)) return 'sketch-plan';
    if (/\b(shot|table)/i.test(name)) return 'shot-table';
    if (/scan|notes?\b|sheet|survey|book|page/i.test(name) || ext === 'tif' || ext === 'tiff' || type === 'image/tiff') return 'notes';
    if (ext === 'pdf' || type === 'application/pdf') return 'other';
    if (PHOTO_EXT.test(ext) || /^image\//.test(type)) return 'photo';
    return 'other';
  }
  // Does a JPEG carry camera data (an Exif block with a Make or Model)? bytes: Uint8Array (the first 64 KB is enough).
  function exifCamera(bytes) {
    const b = bytes;
    if (!b || b.length < 12 || b[0] !== 0xff || b[1] !== 0xd8) return false;
    let o = 2;
    while (o + 4 < b.length && b[o] === 0xff) {
      const m = b[o + 1], len = (b[o + 2] << 8) | b[o + 3];
      if (m === 0xe1 && b[o + 4] === 0x45 && b[o + 5] === 0x78 && b[o + 6] === 0x69 && b[o + 7] === 0x66) {      // "Exif"
        const t = o + 10, le = b[t] === 0x49, u16 = i => (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
        const u32 = i => (le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0 : ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0);
        if (t + 8 > b.length) return false;
        const ifd = t + u32(t + 4);
        if (ifd + 2 > b.length) return false;
        const n = u16(ifd);
        for (let i = 0; i < n && ifd + 2 + i * 12 + 12 <= b.length; i++) { const tag = u16(ifd + 2 + i * 12); if (tag === 0x010f || tag === 0x0110) return true; }
        return false;
      }
      if (m === 0xda || len < 2) break;
      o += 2 + len;
    }
    return false;
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
  const TRIP_LISTS = ['people', 'caves', 'links'];
  function emptyProject(pid) {
    return { id: pid, name: '', desc: '', lists: {}, caves: {}, aliases: {}, notes: {}, leads: {},
             surveys: {}, order: [], caveUpdates: {}, surveyVersions: {}, segments: {}, cavefiles: {}, systems: {}, layers: {}, features: {}, groups: {}, arealabels: {}, trips: {}, proposals: {}, archived: null, footprint: null, moves: {}, log: [], byId: new Map() };
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
        // Lifecycle (doc 14, rule 9). Older readers fall through to `default` and ignore all three.
        //   project.archive    { archived: true|false, note? }   archived = hidden from the list, read-only; last writer wins
        //   project.footprint  { ring: [[lon, lat], …] | null }  a hand-drawn outline replacing the computed one; null clears it
        //   cave.moved         { move, dir: 'out'|'in', cave, name, files, peer: { id, name } }   a cave moved to / from another
        //                      project: the record both projects keep (`move` is one id per move, so a repeat is one record)
        case 'project.archive': S.archived = e.archived === false ? null : { t: e.t, who: e.who, note: e.note ? String(e.note) : '' }; break;
        case 'project.footprint': {
          const ring = Array.isArray(e.ring) ? e.ring.filter(c => Array.isArray(c) && Number.isFinite(+c[0]) && Number.isFinite(+c[1])).map(c => [+c[0], +c[1]]) : [];
          S.footprint = ring.length >= 3 ? { ring, t: e.t, who: e.who } : null;
          break;
        }
        case 'cave.moved': {
          if (e.move == null || e.move === '') break;
          const peer = { id: String((e.peer && e.peer.id) || ''), name: String((e.peer && e.peer.name) || '') };
          const dir = e.dir === 'in' ? 'in' : 'out';
          S.moves[e.move] = { id: String(e.move), dir, cave: e.cave, name: String(e.name || ''), files: clone(e.files || []), peer, t: e.t, who: e.who };
          if (S.caves[e.cave]) { if (dir === 'out') S.caves[e.cave].movedTo = peer; else { S.caves[e.cave].movedTo = null; S.caves[e.cave].movedFrom = peer; } }
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
          // Multi-cave survey file (doc 14, rule 3): `multi` marks a file that holds several caves (they are project caves
          // with sources [{ file, surveys }]); `surfaceAdd` / `surfaceDel` mark surveys of the file as surface traverses
          // (not part of any cave). Older readers ignore all three.
          if (e.multi != null) f.multi = !!e.multi;
          if (Array.isArray(e.surfaceAdd) || Array.isArray(e.surfaceDel)) {
            const cur = f.surface || (f.surface = []);
            (e.surfaceAdd || []).forEach(v => { v = String(v); if (!cur.includes(v)) cur.push(v); });
            if (e.surfaceDel) f.surface = cur.filter(v => !e.surfaceDel.map(String).includes(v));
          }
          f.updated = { t: e.t, who: e.who };
          break;
        }
        // A system groups caves (doc 14, rule 3); their files stay separate. `add` / `remove`: cave ids (the last writer in
        // replay order wins per cave, so two devices adding different caves both count); `removed` deletes it.
        case 'system.set': {
          if (e.system == null || e.system === '') break;
          const g = S.systems[e.system] || (S.systems[e.system] = { id: String(e.system), name: '', desc: '', caves: [], created: { t: e.t, who: e.who } });
          if (e.name != null) g.name = String(e.name);
          if (e.desc != null) g.desc = String(e.desc);
          (e.add || []).forEach(c => { c = String(c); if (!g.caves.includes(c)) g.caves.push(c); });
          if (e.remove) g.caves = g.caves.filter(c => !e.remove.map(String).includes(c));
          if (e.removed != null) g.removed = !!e.removed;
          g.updated = { t: e.t, who: e.who };
          break;
        }
        // Surface features the project keeps itself (FLEX only — CalTopo keeps
        // its own): points, lines, areas in groups that can nest.
        case 'feature.set': {
          const f = S.features[e.feature] || (S.features[e.feature] = { id: e.feature, created: { t: e.t, who: e.who } });
          ['kind', 'name', 'desc', 'group'].forEach(k => { if (e[k] != null) f[k] = String(e[k]); });
          if (Array.isArray(e.coords)) { f.coords = e.coords.filter(c => Array.isArray(c) && c.length >= 2).map(c => c.slice(0, 3).map(Number)); if (e.hsrc == null) delete f.hsrc; }   // new place, height source unknown
          if (e.style != null) f.style = clone(e.style);
          // Where the stored height (coords z) of a point came from: { k: 'ground', t: <terrain key> } | { k: 'survey'|'gps'|'file' },
          // with fileH = the height the imported file had. A record without it leaves the old value; none ever = "ground, terrain unknown".
          if (e.hsrc != null && typeof e.hsrc === 'object') f.hsrc = clone(e.hsrc);
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
          if (Array.isArray(e.bounds) && e.bounds.length === 4 && e.bounds.every(Number.isFinite)) l.bounds = e.bounds.map(Number);   // a map image: [west, south, east, north]
          ['minZoom', 'maxZoom'].forEach(k => { if (Number.isInteger(e[k]) && e[k] >= 0 && e[k] <= 24) l[k] = e[k]; });          // tiles: the levels there are (none asked for outside them)
          if (e.order != null) l.order = Number(e.order);
          if (e.removed != null) l.removed = !!e.removed;
          l.updated = { t: e.t, who: e.who };
          break;
        }
        // Area labels: names for parts of a cave ("Big Room"), on a survey
        // file of the project (`file`, as in cavefile.set), placed in that
        // file's own survey coordinates (n, e, v metres, like its stations), so
        // they follow the cave wherever it is placed. Each field: the last
        // writer in replay order (two devices editing different fields both
        // count); `removed` deletes, removed: false brings it back.
        case 'arealabel.set': {
          if (e.label == null || e.label === '') break;
          const a = S.arealabels[e.label] || (S.arealabels[e.label] = { id: String(e.label), file: '', text: '', n: 0, e: 0, v: 0, created: { t: e.t, who: e.who }, history: [] });
          if (e.file != null) a.file = String(e.file);
          if (e.text != null) a.text = String(e.text);
          ['n', 'e', 'v'].forEach(k => { if (e[k] != null && Number.isFinite(Number(e[k]))) a[k] = Number(e[k]); });
          if (e.removed != null) a.removed = !!e.removed;
          a.history.push(e.id);
          a.updated = { t: e.t, who: e.who };
          break;
        }
        // Trips: a day or a run of days underground or in the field, with who
        // went, the caves visited and links to that trip's segments, notes and
        // documents (photos). Scalars (name, start, end, desc, removed): the
        // last writer in replay order. Lists (people, caves, links): `add` /
        // `drop` deltas, so two devices adding different people both count.
        // Older readers fall through to `default` and ignore the op.
        case 'trip.set': {
          if (e.trip == null || e.trip === '') break;
          const t = S.trips[e.trip] || (S.trips[e.trip] = { id: String(e.trip), name: '', start: '', end: '', desc: '', people: [], caves: [], links: [], created: { t: e.t, who: e.who }, history: [] });
          ['name', 'start', 'end', 'desc'].forEach(k => { if (e[k] != null) t[k] = String(e[k]); });
          if (e.removed != null) t.removed = !!e.removed;
          // Old records may carry `planned`, `obj` and the `leads` list (planned trips,
          // since removed): read and ignored.
          TRIP_LISTS.forEach(k => {
            ((e.drop && e.drop[k]) || []).forEach(v => { t[k] = t[k].filter(x => x !== String(v)); });
            ((e.add && e.add[k]) || []).forEach(v => { v = String(v).trim(); if (v && !t[k].includes(v)) t[k].push(v); });
          });
          t.history.push(e.id);
          t.updated = { t: e.t, who: e.who };
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
  // Systems (system.set): live ones by name, each with its live caves' ids (a removed or moved-away cave drops out).
  const liveSystems = S => Object.values((S && S.systems) || {}).filter(g => !g.removed)
    .map(g => Object.assign({}, g, { caves: g.caves.filter(c => S.caves[c] && !S.caves[c].removed) }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '') || (a.id < b.id ? -1 : 1));
  const systemsOf = (S, cid) => liveSystems(S).filter(g => g.caves.includes(cid));
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
      // Page tags (doc.pagetag / doc.pageuntag, a page named by its sha256 `h`) land in the page's `targets`; one that
      // arrives before its page (another device's clock) waits here and is applied when the page is added.
      const pend = {};
      const setPT = (pg, t, on) => { const cur = pg.targets || (pg.targets = []), i = cur.indexOf(t); if (on && i < 0) cur.push(t); else if (!on && i >= 0) cur.splice(i, 1); };
      const putPage = p => {
        const q = Object.assign({ rot: 0 }, clone(p));
        if (pend[q.h]) { pend[q.h].forEach(([t, on]) => setPT(q, t, on)); delete pend[q.h]; }
        return q;
      };
      r.entries.forEach(e => {
        switch (e.op) {
          case 'doc.add':
            if (!d.created) d.created = { who: e.who, t: e.t };
            ['title', 'kind', 'date', 'desc'].forEach(k => { if (e[k] != null) d[k] = String(e[k]); });
            if (e.has_coordinates != null) d.has_coordinates = !!e.has_coordinates;
            (e.pages || []).forEach(p => { if (!d.pages.some(q => q.h === p.h)) d.pages.push(putPage(p)); });
            (e.tags || []).forEach(t => { d.tags[t] = true; });
            break;
          case 'doc.set':
            ['title', 'kind', 'date', 'desc'].forEach(k => { if (e.fields && e.fields[k] != null) d[k] = String(e.fields[k]); });
            if (e.fields && e.fields.has_coordinates != null) d.has_coordinates = !!e.fields.has_coordinates;
            break;
          case 'doc.page': d.pages.forEach(p => { if (p.h === e.h) ['kind', 'date'].forEach(k => { if (e.fields && e.fields[k] != null) p[k] = String(e.fields[k]); }); }); break;
          case 'doc.pages': {
            const at = e.at != null && e.at >= 0 ? Math.min(e.at, d.pages.length) : d.pages.length;
            const add = (e.add || []).filter(p => !d.pages.some(q => q.h === p.h)).map(putPage);
            d.pages.splice(at, 0, ...add);
            break;
          }
          // A tag on one page of the document ("the sketchbook's page 5 is stations T6~T8"). The page is named by its
          // content hash, so the tag stays with the page when pages are reordered, inserted or removed and put back.
          case 'doc.pagetag': case 'doc.pageuntag': {
            const t = e.target == null ? '' : String(e.target), on = e.op === 'doc.pagetag', pg = d.pages.find(q => q.h === e.h);
            if (!t || !e.h) break;
            if (pg) setPT(pg, t, on); else (pend[e.h] || (pend[e.h] = [])).push([t, on]);
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
  // Every target a document is tagged to: its own tags (`tagList`) and its pages' tags (`pages[].targets`, from
  // doc.pagetag, or from a doc.add that listed them). A page tag is a tag of the document too: a document with a
  // page tagged to a station of the project is in the project.
  function docTargets(d) {
    const out = ((d && d.tagList) || Object.keys((d && d.tags) || {})).slice();
    ((d && d.pages) || []).forEach(p => ((p && p.targets) || []).forEach(t => { if (!out.includes(t)) out.push(t); }));
    return out;
  }
  const hasPageTags = d => ((d && d.pages) || []).some(p => p && p.targets && p.targets.length);
  // Is a document in project S (tagged to it, or to anything of it)?
  function docInProject(d, S) {
    return docTargets(d).some(t => {
      const p = parseTarget(t);
      if (p.kind === 'project') return p.pid === S.id;
      if (p.cave) return !!S.caves[p.cave] && !S.caves[p.cave].movedTo;      // a cave moved to another project takes its documents along
      if (p.kind === 'lead') return !!S.leads[p.lead];
      if (p.kind === 'feature') return !!(S.features && S.features[p.feature]);
      return false;
    });
  }
  // Inbox: in the project but tagged to nothing more specific than it (no page tagged either).
  const docInbox = (d, S) => d.tagList.every(t => t === T.project(S.id)) && d.tagList.length > 0 && !hasPageTags(d);
  function docsOf(D, S, opts = {}) {
    return Object.values(D.docs).filter(d => (opts.deleted ? d.deleted : !d.deleted) && docInProject(d, S))
      .sort((a, b) => String(b.created && b.created.t).localeCompare(String(a.created && a.created.t)));
  }

  // ── Documents for a selection: the most specific tags first ────────────────
  // A station's documents, most specific first (decided 2026-11-08):
  //   station — tagged to the station, or a page of it tagged to the station or to a range that covers it (T6~T8)
  //   segment — then the segments the station is in (if the project uses segments)
  //   survey  — then the survey it belongs to
  //   cave    — then the cave
  //   project — then the project's untagged documents (the inbox)
  // docsFor stops at the first of these that has any (the others are not looked at), so a station never shows the
  // documents of other surveys, other stations or other caves. A survey: its documents, else (its stations'), else
  // the cave's, else the project's; a cave: its own, else its surveys' and stations', else the project's.
  // One exception, for a station only: Survey notes and Sketches it has none of at its own level are taken from its
  // segment or survey (a photo of the station does not hide the survey's sketches). opts.topUp = false turns that off.
  const LEVEL_RANK = { own: 0, station: 0, area: 1, segment: 2, survey: 3, within: 4, cave: 5, project: 6 };
  // How many stations an area spec names (a range counts its numbers): narrower = more specific.
  function areaSpan(spec) {
    const split = x => { const m = /^(.*?)(\d+)([^\d]*)$/.exec(String(x).trim()); return m ? { pre: m[1], num: +m[2] } : null; };
    let n = 0;
    String(spec || '').split(',').forEach(item => {
      item = item.trim();
      if (!item) return;
      const k = item.indexOf('~');
      if (k < 0) { n++; return; }
      const a = split(item.slice(0, k)), b = split(item.slice(k + 1));
      n += a && b && a.pre === b.pre ? Math.abs(a.num - b.num) + 1 : 2;
    });
    return n || 1;
  }
  // What a person types for "these stations" as an area spec: "T6 to T8", "T6–T8", "T6 - T8", "T6~8" → "T6~T8"
  // (a bare number after the dash takes the first station's prefix); several items by comma. `known`: station names
  // (array or Set) that stay as typed ("A1-2" is a station when there is one). "T6-8" is read as a range only when
  // it is not a known station.
  function normalizeSpec(text, known) {
    const kn = known ? (known instanceof Set ? known : new Set(known)) : null;
    return String(text == null ? '' : text).split(/[,;\n]+/).map(x => x.trim()).filter(Boolean).map(it => {
      if (kn && kn.has(it)) return it;
      let m = /^(.+?)\s*(?:~|–|—|\s-\s|\s+to\s+)\s*(.+)$/i.exec(it);
      if (!m) { const m2 = /^([A-Za-z_.]*\d+[A-Za-z]*)-(\d+[A-Za-z]*)$/.exec(it); if (m2) m = [it, m2[1], m2[2]]; }
      if (!m) return it;
      const a = m[1].trim();
      let b = m[2].trim();
      const pa = /^(.*?)\d+[^\d]*$/.exec(a), pb = /^(.*?)\d+[^\d]*$/.exec(b);
      if (pa && pb && pb[1] === '' && pa[1] !== '') b = pa[1] + b;
      return a + '~' + b;
    }).join(',');
  }
  // A station or range typed by a person → the tag target: one plain name is a station, anything with a range or
  // a list is an area of the cave. null for nothing typed.
  function specTarget(cid, text, known) {
    const spec = normalizeSpec(text, known);
    if (!spec) return null;
    return /[~,]/.test(spec) ? T.area(cid, spec) : T.station(cid, spec);
  }
  // The names of `names` that an area spec covers (to show "= T6, T7, T8" while it is being typed).
  const areaStations = (spec, names) => (names || []).filter(n => areaHas(spec, n));
  // Which level of a selection a tag stands for: { kind, tiers: [[levels]…] (most specific first), levelOf(tag) → level | null }.
  function docsCtx(S, target, opts) {
    const t = parseTarget(target), kind = t.kind;
    const pid = (S && S.id) || (kind === 'project' ? t.pid : '');
    const names = opts.stations ? new Set(opts.stations) : null;
    const covers = spec => !!names && [...names].some(n => areaHas(spec, n));
    const ctx = { kind, pid, tiers: null, levelOf: () => null, target };
    if (kind === 'station') {
      const codes = [].concat(opts.codes || []);
      const segs = new Set(opts.segments ? opts.segments : (S && S.segments ? segmentsAt(S, t.cave, t.name).map(g => g.id) : []));
      ctx.tiers = [['station', 'area'], ['segment'], ['survey'], ['cave'], ['project']];
      ctx.levelOf = tag => {
        const p = parseTarget(tag);
        if (p.kind === 'station') return p.cave === t.cave && p.name === t.name ? 'station' : null;
        if (p.kind === 'area') return p.cave === t.cave && areaHas(p.spec, t.name) ? 'area' : null;
        if (p.kind === 'segment') return p.cave === t.cave && segs.has(p.seg) ? 'segment' : null;
        if (p.kind === 'survey') return p.cave === t.cave && codes.includes(p.code) ? 'survey' : null;
        if (p.kind === 'cave') return p.cave === t.cave ? 'cave' : null;
        return p.kind === 'project' && p.pid === pid ? 'project' : null;
      };
    } else if (kind === 'survey' || kind === 'segment') {
      ctx.tiers = [[kind], ['within'], ['cave'], ['project']];
      ctx.levelOf = tag => {
        const p = parseTarget(tag);
        if (p.kind === kind) return p.cave === t.cave && (kind === 'survey' ? p.code === t.code : p.seg === t.seg) ? kind : null;
        if (p.kind === 'station') return p.cave === t.cave && !!names && names.has(p.name) ? 'within' : null;
        if (p.kind === 'area') return p.cave === t.cave && covers(p.spec) ? 'within' : null;
        if (p.kind === 'cave') return p.cave === t.cave ? 'cave' : null;
        return p.kind === 'project' && p.pid === pid ? 'project' : null;
      };
    } else if (kind === 'cave') {
      ctx.tiers = [['cave'], ['within'], ['project']];
      ctx.levelOf = tag => {
        const p = parseTarget(tag);
        if (p.kind === 'cave') return p.cave === t.cave ? 'cave' : null;
        if (p.kind === 'survey' || p.kind === 'station' || p.kind === 'area' || p.kind === 'segment') return p.cave === t.cave ? 'within' : null;
        return p.kind === 'project' && p.pid === pid ? 'project' : null;
      };
    } else if (kind === 'project') {
      ctx.tiers = [['project']];
      ctx.levelOf = tag => { const p = parseTarget(tag); return p.kind === 'project' && p.pid === t.pid ? 'project' : null; };
    } else if (kind === 'lead' || kind === 'feature' || kind === 'doc') {
      ctx.tiers = [['own']];
      ctx.levelOf = tag => (tag === target ? 'own' : null);
    }
    return ctx;
  }
  // The ways a document meets a selection: [{ level, via: 'doc' | 'page', tag, page }] (page = index, -1 for a document tag).
  // A document tagged only to the project is "general" (the inbox) and meets the project level; one that is tagged to
  // anything else, or has a tagged page, does not — it is about something specific, and that is not this.
  function docHits(d, ctx) {
    const hits = [], tl = d.tagList || Object.keys(d.tags || {});
    const general = tl.length > 0 && tl.every(t => t === T.project(ctx.pid)) && !hasPageTags(d);
    tl.forEach(t => { const lv = ctx.levelOf(t); if (lv && (lv !== 'project' || general)) hits.push({ level: lv, via: 'doc', tag: t, page: -1 }); });
    (d.pages || []).forEach((p, i) => ((p && p.targets) || []).forEach(t => { const lv = ctx.levelOf(t); if (lv && lv !== 'project') hits.push({ level: lv, via: 'page', tag: t, page: i }); }));
    return hits;
  }
  // Where a document came from, in words: "this station", "stations T6–T8", "survey T", "the cave Cave Ridge"…
  function levelFrom(level, tag, ctx, S) {
    const p = parseTarget(tag || ''), cave = cid => { const c = S && S.caves && S.caves[cid]; return c && c.name ? ' ' + c.name : ''; };
    switch (level) {
      case 'station': return ctx.kind === 'station' ? 'this station' : 'station ' + (p.name || '');
      case 'area': return 'stations ' + String(p.spec || '').replace(/~/g, '–').replace(/,/g, ', ');
      case 'segment': { const g = S && S.segments && S.segments[p.seg]; return 'segment ' + ((g && (g.name || g.id)) || p.seg || ''); }
      case 'survey': return 'survey ' + (p.code || '');
      case 'within': return ctx.kind === 'cave' ? 'its surveys and stations' : 'its stations';
      case 'cave': return 'the cave' + cave(p.cave);
      case 'project': return 'the project';
      default: return '';
    }
  }
  function docsFor(D, S, target, opts = {}) {
    const ctx = docsCtx(S, target, opts), paper = ['notes', 'sketches'];
    const out = { target, kind: ctx.kind || '', level: '', own: true, empty: true, items: [], docs: [], groups: [], by: {} };
    if (!ctx.tiers || !D) return out;
    const tierItems = ctx.tiers.map(() => []);
    Object.values(D.docs).forEach(d => {
      if (d.deleted) return;
      const hits = docHits(d, ctx);
      if (!hits.length) return;
      ctx.tiers.forEach((levels, ti) => {
        const h = hits.filter(x => levels.includes(x.level));
        if (!h.length) return;
        const best = h.reduce((a, b) => (LEVEL_RANK[b.level] < LEVEL_RANK[a.level] ? b : a));
        const ph = h.filter(x => x.via === 'page').sort((a, b) => a.page - b.page || LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
        const page = ph.length ? ph[0].page : 0, lead = ph.length ? ph[0] : best;
        tierItems[ti].push({ doc: d, id: d.id, level: best.level, via: ph.length ? 'page' : 'doc', tag: lead.tag, page, pages: [...new Set(ph.map(x => x.page))].sort((a, b) => a - b),
          group: pageGroup(d, ph.length ? d.pages[page] : null), from: levelFrom(best.level, lead.tag, ctx, S), fallback: ti > 0, tier: ti,
          span: parseTarget(lead.tag).kind === 'area' ? areaSpan(parseTarget(lead.tag).spec) : 0 });
      });
    });
    const recent = x => String((x.doc.created && x.doc.created.t) || '');
    const cmpItem = (a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || (a.via === 'page' ? 0 : 1) - (b.via === 'page' ? 0 : 1) || a.span - b.span
      || recent(b).localeCompare(recent(a)) || String(a.doc.title || '').localeCompare(String(b.doc.title || '')) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    tierItems.forEach(l => l.sort(cmpItem));
    const first = tierItems.findIndex(l => l.length);
    if (first < 0) return out;
    let items = tierItems[first].slice();
    if (ctx.kind === 'station' && opts.topUp !== false && first < ctx.tiers.findIndex(l => l.includes('survey'))) {
      // Survey notes and sketches the station has none of at its own level: from its segment, else its survey.
      const have = new Set(items.map(x => x.group)), seen = new Set(items.map(x => x.id));
      paper.filter(g => !have.has(g)).forEach(g => {
        for (let ti = first + 1; ti < ctx.tiers.length && !ctx.tiers[ti].includes('cave'); ti++) {
          const more = tierItems[ti].filter(x => x.group === g && !seen.has(x.id));
          if (more.length) { more.forEach(x => { items.push(x); seen.add(x.id); }); break; }
        }
      });
    }
    out.items = items;
    out.level = items[0].level;
    out.own = first === 0;
    out.empty = false;
    out.docs = items.map(x => x.doc).filter((d, i, a) => a.indexOf(d) === i);
    out.groups = DOC_GROUPS.map(g => {
      const its = items.filter(x => x.group === g.id), fb = its.length > 0 && its.every(x => x.fallback);
      return { id: g.id, label: g.label, items: its, docs: its.map(x => x.doc), level: its[0] ? its[0].level : '', fallback: fb, from: fb ? its[0].from : '' };
    }).filter(g => g.items.length);
    out.groups.forEach(g => { out.by[g.id] = g.items; });
    return out;
  }
  // Documents for a station, each by the most specific way it is tagged to it: { station, area, segment, survey, cave }
  // (lists of documents, none in two). Page tags count (a page tagged to the station, or to a range covering it).
  // docsFor is the same lookup with the strict order; this keeps the older callers (FLEX Field) working.
  function docsForStation(D, S, cave, name, codes) {
    const ctx = docsCtx(S, T.station(cave, name), { codes });
    const out = { station: [], area: [], segment: [], survey: [], cave: [] };
    Object.values(D.docs).forEach(d => {
      if (d.deleted) return;
      const hits = docHits(d, ctx).filter(h => h.level !== 'project');
      if (hits.length) out[hits.reduce((a, b) => (LEVEL_RANK[b.level] < LEVEL_RANK[a.level] ? b : a)).level].push(d);
    });
    return out;
  }
  // The pages of a document that cover a target: tagged to exactly it, or (for a station) to a range that has it.
  function pagesCovering(d, target) {
    const t = parseTarget(target), out = [];
    ((d && d.pages) || []).forEach((p, i) => {
      const ts = (p && p.targets) || [];
      if (ts.includes(target) || (t.kind === 'station' && ts.some(x => { const q = parseTarget(x); return q.kind === 'area' && q.cave === t.cave && areaHas(q.spec, t.name); }))) out.push(i);
    });
    return out;
  }
  // The page of a document that covers a target (pages may list `targets`), else the first.
  function pageFor(d, target) {
    const c = pagesCovering(d, target);
    return c.length ? c[0] : 0;
  }


  // ── Lifecycle: snapshots, moving a cave between projects ──────────────────
  // A snapshot is the log as it was: the entries up to a moment, replayed. `at`
  // is an ISO time, or a day ("2026-03-12" = the end of that day, local time).
  function snapshotTime(at) {
    const s = String(at || '');
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999).toISOString();
    const d = new Date(s);
    return isNaN(d) ? null : d.toISOString();
  }
  const entriesAt = (entries, at) => { const t = snapshotTime(at); return t ? (entries || []).filter(e => e && (!e.t || e.t <= t)) : (entries || []).slice(); };
  const replayProjectAt = (entries, pid, at) => replayProject(entriesAt(entries, at), pid);
  const replayDocsAt = (entries, at) => replayDocs(entriesAt(entries, at));
  // The days (local) something was recorded on, newest first, for choosing a snapshot.
  function changeDays(entries) {
    const days = new Set();
    (entries || []).forEach(e => { const d = new Date(e.t); if (!isNaN(d)) days.add(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')); });
    return [...days].sort().reverse();
  }
  const targetCave = t => { const p = parseTarget(t); return p.cave || null; };
  // Everything that goes with a project cave when it moves: its survey files (stored by fingerprint), aliases,
  // segments, area labels, notes and leads on it, and the documents tagged to it (sketches included — they follow
  // by the cave's id, so they need no copy of their entries; their files are copied by the host).
  // `shared`: survey files other live caves also use — the host refuses to move those.
  function caveBundle(S, D, cid) {
    const c = S && S.caves[cid];
    if (!c || c.removed) return null;
    const aliases = Object.keys(S.aliases).filter(a => S.aliases[a] === cid);
    const names = [];
    (c.sources || []).map(s => s.file).concat(aliases).forEach(n => { if (n && !names.includes(n) && S.cavefiles[n] && !S.cavefiles[n].removed && S.cavefiles[n].h) names.push(n); });
    const others = liveCaves(S).filter(x => x.id !== cid);
    const shared = names.filter(n => others.some(x => (x.sources || []).some(s => s.file === n) || S.aliases[n] === x.id));
    const segments = Object.values(S.segments).filter(g => g.cave === cid && !g.removed);
    const leads = Object.values(S.leads).filter(L => !L.deleted && targetCave(L.target) === cid);
    const leadIds = new Set(leads.map(L => L.id));
    const notes = Object.values(S.notes).filter(n => !n.deleted && !n.conflict && (targetCave(n.target) === cid || (parseTarget(n.target).kind === 'lead' && leadIds.has(parseTarget(n.target).lead))));
    const labels = Object.values(S.arealabels).filter(a => !a.removed && a.text && names.includes(a.file));
    const docs = D ? Object.values(D.docs).filter(d => !d.deleted && docTargets(d).some(t => targetCave(t) === cid)) : [];
    const blobs = new Map();
    names.forEach(n => { const f = S.cavefiles[n]; blobs.set(f.h + '.' + (f.ext || 'plt'), { h: f.h, ext: f.ext || 'plt' }); });
    const readable = [];
    docs.forEach(d => {
      d.pages.forEach(p => { if (p.h) blobs.set(p.h + '.' + (p.ext || 'jpg'), { h: p.h, ext: p.ext || 'jpg' }); });
      if (d.file && d.file.h) { blobs.set(d.file.h + '.' + d.file.ext, { h: d.file.h, ext: d.file.ext }); if (d.file.path) readable.push({ h: d.file.h, ext: d.file.ext, path: d.file.path }); }
    });
    names.forEach(n => { if (S.cavefiles[n].multi && !shared.includes(n)) shared.push(n); });   // a multi-cave file never goes with one cave
    return { cave: clone(c), id: cid, aliases, files: names.map(n => clone(S.cavefiles[n])), shared, segments: clone(segments), leads: clone(leads), notes: clone(notes),
             labels: clone(labels), docs: docs.map(d => d.id), blobs: [...blobs.values()], readable,
             counts: { files: names.length, segments: segments.length, leads: leads.length, notes: notes.length, labels: labels.length, docs: docs.length } };
  }
  // A survey file name free in the destination (a different file already uses it): "name (2).plt".
  function moveRenames(B, destS) {
    const rename = {};
    B.files.forEach(f => {
      const cur = destS && destS.cavefiles[f.file];
      if (!cur || cur.removed || cur.h === f.h) return;
      const m = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(f.file);
      for (let k = 2; k < 100; k++) { const n = `${m[1]} (${k})${m[2] || ''}`; if (!destS.cavefiles[n] || destS.cavefiles[n].removed) { rename[f.file] = n; break; } }
    });
    return rename;
  }
  // The entries the destination needs (without id / dev / seq / t / who, which the host adds). What the destination
  // already has the same is left out, so moving again — or finishing a move that stopped halfway — adds nothing twice.
  function caveMoveEntries(B, destS, rename) {
    const out = [], rn = n => (rename && rename[n]) || n, live = (o, k) => o && !o[k || 'removed'];
    const c = B.cave, sources = (c.sources || []).map(s => Object.assign({}, clone(s), { file: rn(s.file) }));
    const dc = destS && destS.caves[B.id];
    if (!dc || dc.removed || dc.name !== c.name || (dc.desc || '') !== (c.desc || '') || !same(dc.sources, sources)) out.push({ op: 'cave.set', cave: B.id, name: c.name, sources, desc: c.desc || '', removed: false });
    B.aliases.forEach(a => { if (!destS || destS.aliases[rn(a)] !== B.id) out.push({ op: 'cave.alias', cave: B.id, alias: rn(a) }); });
    B.files.forEach(f => {
      const d = destS && destS.cavefiles[rn(f.file)];
      if (!(live(d) && d.h === f.h && same(d.place || null, f.place || null))) out.push({ op: 'cavefile.set', file: rn(f.file), h: f.h, ext: f.ext || 'plt', place: f.place || null, removed: false });
    });
    B.segments.forEach(g => {
      const d = destS && destS.segments[g.id];
      const mine = { name: g.name, date: g.date || '', team: g.team || '', desc: g.desc || '', source: g.source || '', shots: g.shots || [] };
      if (!(live(d) && same({ name: d.name, date: d.date || '', team: d.team || '', desc: d.desc || '', source: d.source || '', shots: d.shots || [] }, mine)))
        out.push(Object.assign({ op: 'segment.set', seg: g.id, cave: B.id }, mine, g.check != null ? { check: g.check } : {}));
    });
    B.labels.forEach(a => {
      const d = destS && destS.arealabels[a.id];
      if (!(live(d) && d.text === a.text && d.file === rn(a.file) && d.n === a.n && d.e === a.e && d.v === a.v)) out.push({ op: 'arealabel.set', label: a.id, file: rn(a.file), text: a.text, n: a.n, e: a.e, v: a.v, removed: false });
    });
    B.leads.forEach(L => {
      const d = destS && destS.leads[L.id];
      if (d && !d.deleted && same(d.fields, L.fields) && d.target === L.target) return;
      if (d && d.deleted) out.push({ op: 'lead.restore', lead: L.id });
      out.push(Object.assign({ op: 'lead.set', lead: L.id, target: L.target, fields: clone(L.fields) }, d ? { base: d.heads } : {}, L.source ? { source: L.source } : {}));
      if (!d || d.deleted) (L.sightings || []).forEach(s => { const x = clone(s); delete x.who; delete x.t; delete x.entry; out.push({ op: 'lead.set', lead: L.id, target: L.target, sighting: x }); });
    });
    B.notes.forEach(n => {
      const d = destS && destS.notes[n.id];
      if (d && !d.deleted && !d.conflict && d.text === n.text && d.target === n.target) return;
      out.push(Object.assign({ op: 'note.set', note: n.id, target: n.target, text: n.text }, d ? { base: d.heads } : {}, n.kind ? { kind: n.kind } : {}, n.page ? { page: n.page } : {}));
    });
    return out;
  }
  // What the source records to let the cave go: it is removed (its history stays; History can undo each step).
  function caveMoveClear(B, S) {
    const out = [];
    B.leads.forEach(L => { if (S.leads[L.id] && !S.leads[L.id].deleted) out.push({ op: 'lead.del', lead: L.id }); });
    B.notes.forEach(n => { if (S.notes[n.id] && !S.notes[n.id].deleted) out.push({ op: 'note.set', note: n.id, target: n.target, text: '', prev: n.text, base: S.notes[n.id].heads }); });
    if (B.segments.length) out.push({ op: 'segment.del', segs: B.segments.map(g => g.id) });
    B.labels.forEach(a => out.push({ op: 'arealabel.set', label: a.id, file: a.file, removed: true }));
    B.files.forEach(f => out.push({ op: 'cavefile.set', file: f.file, removed: true }));
    liveSystems(S).filter(g => g.caves.includes(B.id)).forEach(g => out.push({ op: 'system.set', system: g.id, remove: [B.id] }));
    out.push({ op: 'cave.set', cave: B.id, removed: true });
    return out;
  }
  const moveRecord = (move, dir, B, peer) => ({ op: 'cave.moved', move, dir, cave: B.id, name: B.cave.name, files: B.files.map(f => f.file), peer: { id: peer.id, name: peer.name || '' } });
  // A project's moves, newest first (both directions), for History and the record on a project card.
  const movesOf = S => Object.values((S && S.moves) || {}).sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));

  // ── Workspace: what a project loads ───────────────────────────────────────
  const liveCavefiles = S => Object.values((S && S.cavefiles) || {}).filter(f => !f.removed && f.h).sort((a, b) => a.file.localeCompare(b.file));
  const liveLayers = S => Object.values((S && S.layers) || {}).filter(l => !l.removed).sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name)));

  // ── Area labels of a survey file (arealabel.set) ─────────────────────────
  // { id, file, text, n, e, v } in the order they were made.
  const areaLabelsOf = (S, file) => Object.values((S && S.arealabels) || {})
    .filter(a => !a.removed && a.text && (file == null || a.file === file))
    .sort((a, b) => (a.created.t < b.created.t ? -1 : a.created.t > b.created.t ? 1 : a.id < b.id ? -1 : 1));
  // The id of a label that had none (kept in a cave's look before projects
  // kept them): made from the file and the label, so two devices moving the
  // same label into the project make one record, not two.
  const areaLabelId = (file, lb) => 'al' + sha256(new TextEncoder().encode([file, lb.text, (+lb.n).toFixed(2), (+lb.e).toFixed(2), (+lb.v).toFixed(2)].join('|'))).slice(0, 16);

  // What a label is now, kept in an edit as `prev` so History can undo it.
  const areaLabelState = a => (a ? { text: a.text, n: a.n, e: a.e, v: a.v, removed: !!a.removed } : null);
  // The entry that undoes an arealabel.set: back to `prev`, or gone again
  // when it made the label (prev: null). Old entries without prev: none.
  function areaLabelUndo(e) {
    if (!e || e.op !== 'arealabel.set' || e.prev === undefined) return null;
    const out = { op: 'arealabel.set', label: e.label, file: e.file, base: [e.id] };
    if (e.prev === null) return Object.assign(out, { removed: true, prev: { text: e.text, n: e.n, e: e.e, v: e.v, removed: !!e.removed } });
    return Object.assign(out, clone(e.prev), { prev: { text: e.text, n: e.n, e: e.e, v: e.v, removed: !!e.removed } });
  }


  // ── Trips (trip.set) ─────────────────────────────────────────────────────
  // { id, name, start, end ('' = a one-day trip), desc, people: [names as
  // entered], caves: [project cave ids], links: ['segment:<id>' | 'note:<id>'
  // | 'doc:<id>'] }. Links are kept on the trip; tripSuggest only proposes.
  const tripState = t => (t ? { name: t.name, start: t.start, end: t.end, desc: t.desc, removed: !!t.removed } : null);
  // The body of the entry that turns trip `cur` (null: a new one) into `next`
  // ({ name, start, end, desc, people, caves, links }, any subset); null when
  // nothing changes. Carries `prev` so History can undo it (tripUndo).
  function tripEdit(cur, next) {
    const body = {}, prev = {};
    ['name', 'start', 'end', 'desc'].forEach(k => {
      if (next[k] == null) return;
      const v = String(next[k]);
      if (!cur || cur[k] !== v) { body[k] = v; prev[k] = cur ? cur[k] : ''; }
    });
    if (cur && cur.removed && next.removed !== true) { body.removed = false; prev.removed = true; }
    if (next.removed === true && (!cur || !cur.removed)) { body.removed = true; prev.removed = false; }
    TRIP_LISTS.forEach(k => {
      if (!Array.isArray(next[k])) return;
      const want = [...new Set(next[k].map(x => String(x).trim()).filter(Boolean))], have = cur ? cur[k] : [];
      const add = want.filter(x => !have.includes(x)), drop = have.filter(x => !want.includes(x));
      if (add.length) (body.add || (body.add = {}))[k] = add;
      if (drop.length) (body.drop || (body.drop = {}))[k] = drop;
    });
    if (!cur) return Object.assign({ op: 'trip.set', prev: null }, body);
    if (!Object.keys(body).length) return null;
    return Object.assign({ op: 'trip.set', prev }, body);
  }
  // The entry that undoes a trip.set: a new trip is removed, an edit goes back
  // (fields restored, added things dropped and dropped ones added). Entries
  // without `prev` have no undo.
  function tripUndo(e) {
    if (!e || e.op !== 'trip.set' || e.prev === undefined) return null;
    const out = { op: 'trip.set', trip: e.trip, base: [e.id] };
    if (e.prev === null) return Object.assign(out, { removed: true, prev: { removed: false } });
    const back = {};
    Object.keys(e.prev).forEach(k => { back[k] = e.prev[k]; });
    const now = {};
    ['name', 'start', 'end', 'desc', 'removed'].forEach(k => { if (e[k] != null) now[k] = e[k]; });
    Object.assign(out, back, { prev: now });
    if (e.add) out.drop = e.add;
    if (e.drop) out.add = e.drop;
    return out;
  }
  // Live trips, newest first (by start, then end, then name).
  const TRIP_NONE = '_none';           // the reserved record that keeps items marked "not part of a trip"
  const tripsOf = (S, opts) => Object.values((S && S.trips) || {}).filter(t => t.id !== TRIP_NONE && (opts && opts.removed ? t.removed : !t.removed))
    .sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : (a.end || a.start) < (b.end || b.start) ? 1 : (a.end || a.start) > (b.end || b.start) ? -1 : a.name.localeCompare(b.name)));
  // Trips that visited a cave, or hold a link ('segment:<id>' …).
  const tripsFor = (S, o) => tripsOf(S).filter(t => (o.cave && t.caves.includes(o.cave)) || (o.link && t.links.includes(o.link)));
  // A day "YYYY-MM-DD" from a date text (approximate dates have none), and from an ISO time (this device's day).
  const fullDay = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim()); return m ? m[0] : ''; };
  const tripDays = t => { const a = fullDay(t.start), b = fullDay(t.end) || a; return a ? [a, b < a ? a : b] : null; };
  const dayNum = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;
  // The trips of a project as the person sees them: its trip records (they win),
  // and trips suggested from survey dates. A suggested trip is surveys of the
  // project on the same day or on consecutive days that no trip record holds
  // (and none marked "not part of a trip"), plus the documents dated inside
  // those days. Returns { groups: [{ id, suggested, name, start, end ('' = one
  // day), people, segments: [seg], docs: [doc] }], by: Map('segment:<id>' |
  // 'doc:<id>' -> group) }. A suggested group's id is 'sug:<first day>'.
  function tripGroups(S, D) {
    const groups = [], by = new Map();
    const segs = segmentsOf(S), docs = D ? docsOf(D, S) : [];
    const segBy = new Map(segs.map(g => ['segment:' + g.id, g])), docBy = new Map(docs.map(d => ['doc:' + d.id, d]));
    const none = new Set(S && S.trips && S.trips[TRIP_NONE] && !S.trips[TRIP_NONE].removed ? S.trips[TRIP_NONE].links : []);
    tripsOf(S).forEach(t => {
      const G = { id: t.id, suggested: false, name: t.name, start: t.start, end: t.end, people: t.people.slice(), segments: [], docs: [] };
      t.links.forEach(k => {
        if (by.has(k)) return;
        if (segBy.has(k)) { G.segments.push(segBy.get(k)); by.set(k, G); }
        else if (docBy.has(k)) { G.docs.push(docBy.get(k)); by.set(k, G); }
      });
      groups.push(G);
    });
    const free = segs.filter(g => !by.has('segment:' + g.id) && !none.has('segment:' + g.id) && fullDay(g.date))
      .sort((a, b) => fullDay(a.date).localeCompare(fullDay(b.date)) || String(a.name).localeCompare(String(b.name)));
    const sug = [];
    free.forEach(g => {
      const d = fullDay(g.date), last = sug[sug.length - 1];
      if (last && dayNum(d) - dayNum(last.last) <= 1) { last.segments.push(g); if (d > last.last) last.last = d; }
      else sug.push({ first: d, last: d, segments: [g] });
    });
    sug.forEach(c => {
      const G = { id: 'sug:' + c.first, suggested: true, name: '', start: c.first, end: c.last > c.first ? c.last : '', people: [], segments: c.segments, docs: [] };
      c.segments.forEach(g => by.set('segment:' + g.id, G));
      docs.forEach(d => { const k = 'doc:' + d.id, x = fullDay(d.date); if (x && x >= c.first && x <= c.last && !by.has(k) && !none.has(k)) { G.docs.push(d); by.set(k, G); } });
      groups.push(G);
    });
    return { groups, by };
  }
  // The trip.set entries that move an item ('segment:<id>' | 'doc:<id>') to
  // another trip: to = { trip: <id> } (a suggested id makes that trip real, with
  // everything in it), { none: true } or { create: { name, start, end, people } }.
  // [{ trip, body }] for the host to record (each body from tripEdit).
  function tripMoves(S, D, key, to) {
    const out = [], G = tripGroups(S, D), trips = (S && S.trips) || {};
    const edit = (id, f) => { const cur = trips[id] || null, body = tripEdit(cur, f(cur ? cur.links.slice() : [])); if (body) out.push({ trip: id, body }); };
    Object.values(trips).forEach(t => { if (!t.removed && t.links.includes(key) && !(to.trip === t.id) && !(to.none && t.id === TRIP_NONE)) edit(t.id, l => ({ links: l.filter(k => k !== key) })); });
    if (to.none) edit(TRIP_NONE, l => ({ links: l.concat(key) }));
    else if (to.create) { const c = to.create; out.push({ trip: uid(10), body: tripEdit(null, { name: c.name || '', start: c.start || '', end: c.end && c.end !== c.start ? c.end : '', people: c.people || [], links: [key] }) }); }
    else if (to.trip && String(to.trip).startsWith('sug:')) {
      const g = G.groups.find(x => x.id === to.trip);
      if (g) out.push({ trip: uid(10), body: tripEdit(null, { name: '', start: g.start, end: g.end, links: [key].concat(g.segments.map(x => 'segment:' + x.id), g.docs.map(x => 'doc:' + x.id)).filter((k, i, a) => a.indexOf(k) === i) }) });
    } else if (to.trip) edit(to.trip, l => ({ links: l.includes(key) ? l : l.concat(key) }));
    return out;
  }

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
    Object.values((D && D.docs) || {}).forEach(d => { if (!d.deleted) docTargets(d).forEach(t => bump(t, 'docs')); });
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
    out[pScope].forEach(e => { if (e.op === 'layer.set' && e.blob) blobs.add(e.blob); });
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

  // ── Systems and multi-cave survey files (doc 14, rule 3) ───────────────────
  // Totals of a system: length adds up; depth is the deepest cave's, or — when statsOf gives the heights (lo / hi, m) —
  // the span of all of them together (caves of one system are connected, so the system is as deep as its extremes).
  // statsOf(cid) → { len, depth, lo?, hi? } | null
  function systemTotals(sys, statsOf) {
    let len = 0, depth = 0, lo = Infinity, hi = -Infinity, n = 0, seen = 0;
    (sys.caves || []).forEach(cid => {
      const x = statsOf(cid);
      n++;
      if (!x) return;
      seen++;
      len += +x.len || 0;
      depth = Math.max(depth, +x.depth || 0);
      if (Number.isFinite(x.lo) && Number.isFinite(x.hi)) { lo = Math.min(lo, x.lo); hi = Math.max(hi, x.hi); }
    });
    if (Number.isFinite(lo) && Number.isFinite(hi)) depth = Math.max(depth, hi - lo);
    return { caves: n, loaded: seen, len, depth };
  }
  // Which caves claim a survey of a file: a source without `surveys` claims the whole file.
  const claims = (c, file, code) => (c.sources || []).some(s => s && s.file === file && (!s.surveys || !s.surveys.length || s.surveys.includes(code)));
  // The groups inside a survey file: the caves made of its surveys, the surveys marked surface, and the rest
  // ("Surface / not yet sorted"). A file that is not multi-cave and has one cave reads as that cave holding it all.
  // codes: the survey codes in the file.
  function fileGroups(S, file, codes) {
    const f = (S && S.cavefiles && S.cavefiles[file]) || {};
    const surface = (f.surface || []).filter(c => codes.includes(c));
    const caves = liveCaves(S).filter(c => (c.sources || []).some(s => s && s.file === file)).map(c => ({ id: c.id, name: c.name, surveys: [] }));
    const unsorted = [];
    codes.forEach(code => {
      if (surface.includes(code)) return;
      const g = caves.find(x => claims(S.caves[x.id], file, code));
      if (g) g.surveys.push(code); else unsorted.push(code);
    });
    return { multi: !!f.multi, surface, caves, unsorted };
  }
  // The records that make a file multi-cave with the caves the user settled on.
  //   assign: { <survey code>: 'surface' | 'unsorted' | { cave: <cave id> } | { name: <new cave's name> } }
  // Caves keep their other files; a cave left with no survey of this file drops the file from its sources. A cave id that
  // is not in the project is made. Returns { ops, caves: { <cave id>: [codes] } }; entries are ready for record().
  function planMulti(S, file, codes, assign, uid) {
    const f = (S && S.cavefiles && S.cavefiles[file]) || {};
    const per = {}, fresh = {}, names = {}, surf = [];
    codes.forEach(code => {
      const a = assign[code];
      if (a === 'surface') { surf.push(code); return; }
      if (!a || a === 'unsorted') return;
      let id = a.cave;
      if (!id && a.name) { id = fresh[a.name] || (fresh[a.name] = uid()); }
      if (id) { (per[id] || (per[id] = [])).push(code); if (a.name) names[id] = a.name; }
    });
    const ops = [];
    const old = f.surface || [];
    const add = surf.filter(c => !old.includes(c)), del = old.filter(c => codes.includes(c) && !surf.includes(c));
    const cf = { op: 'cavefile.set', file };
    if (!f.multi) cf.multi = true;
    if (add.length) cf.surfaceAdd = add;
    if (del.length) cf.surfaceDel = del;
    if (Object.keys(cf).length > 2) ops.push(cf);
    const ids = new Set(Object.keys(per));
    liveCaves(S).forEach(c => { if ((c.sources || []).some(s => s && s.file === file)) ids.add(c.id); });
    ids.forEach(id => {
      const c = S.caves[id] && !S.caves[id].removed ? S.caves[id] : null, mine = (per[id] || []).slice().sort();
      const rest = ((c && c.sources) || []).filter(s => s && s.file !== file);
      const sources = mine.length ? rest.concat([{ file, surveys: mine }]) : rest;
      const renamed = c && names[id] && names[id] !== c.name;
      if (c && same(c.sources || [], sources) && !renamed) return;
      const op = { op: 'cave.set', cave: id, sources };
      if (!c) { op.name = names[id] || ''; op.created = true; } else { op.prevSources = clone(c.sources || []); if (renamed) { op.name = names[id]; op.prevName = c.name; } }
      ops.push(op);
    });
    // Aliases made the whole file one cave; with several caves in it the file name must not pick one.
    if (S.aliases && S.aliases[file] && ids.size > 1) ops.push({ op: 'cave.unalias', cave: S.aliases[file], alias: file });
    return { ops, caves: per };
  }
  // Undo of system.set / cave.set made here / cavefile.set flags: the entry that puts the earlier state back (or null).
  function systemUndo(e) {
    if (e.op !== 'system.set') return null;
    const o = { op: 'system.set', system: e.system, base: [e.id] };
    let n = 0;
    if (e.created) { o.removed = true; return o; }
    if (e.removed != null) { o.removed = !e.removed; n++; }
    if (e.prevName != null) { o.name = e.prevName; n++; }
    if (e.add && e.add.length) { o.remove = e.add; n++; }
    if (e.remove && e.remove.length) { o.add = e.remove; n++; }
    return n ? o : null;
  }
  function multiUndo(e) {
    if (e.op === 'cave.set') {
      if (e.created) return { op: 'cave.set', cave: e.cave, removed: true };
      if (e.prevSources) return Object.assign({ op: 'cave.set', cave: e.cave, sources: e.prevSources }, e.prevName != null ? { name: e.prevName } : {});
    }
    if (e.op === 'cavefile.set' && !e.removed && !e.h && (e.multi != null || e.surfaceAdd || e.surfaceDel))
      return { op: 'cavefile.set', file: e.file, multi: e.multi != null ? !e.multi : undefined, surfaceAdd: e.surfaceDel, surfaceDel: e.surfaceAdd };
    return null;
  }
  // Entrances of a cave (markers whose tag carries its id): the main one is where the file is placed, else the first found.
  // tags: [{ cid, station, at: [lon, lat, h?], z?, placedHere? }] (project_features.js scanTags). Returns the cave's tags, main first.
  function entrancesOf(tags, cid) {
    const mine = (tags || []).filter(t => t && t.cid === cid);
    const i = mine.findIndex(t => t.placedHere);
    if (i > 0) mine.unshift(mine.splice(i, 1)[0]);
    return mine.map((t, k) => Object.assign({}, t, { main: k === 0 }));
  }
  // How a file is fitted to its entrance markers: the first marker places it, every other marker (another entrance, or
  // the entrance of another cave in the same file) pins its station (a control point) so the whole file follows them.
  // tags: markers of the file's caves, main first; stations: the file's station names (a marker on none is left out).
  function entranceFit(tags, stations) {
    const has = n => !stations || (stations.has ? stations.has(n) : stations.includes(n));
    const use = (tags || []).filter(t => t && t.station && t.at && has(t.station));
    if (!use.length) return null;
    const main = use[0], seen = new Set([main.station]), pins = [];
    use.slice(1).forEach(t => {
      if (seen.has(t.station)) return;
      seen.add(t.station);
      pins.push({ station: t.station, lat: t.at[1], lon: t.at[0], elev: Number.isFinite(t.z) ? t.z : (t.at[2] || 0) });
    });
    return { main, pins };
  }

  return {
    FORMAT, FT, DOCS, projScope, scopeProject, sha256, uid, clone, nowIso, same, cmp, sortEntries, surveyCode,
    T, parseTarget, areaHas, DOC_KINDS, DOC_KIND_LABELS, docMedia, dateKey, resolveProposals, reviewQueue, causalOrder, LEAD, LEAD_FIELDS, leadLists, statusLabel, leadActive, heads,
    replayProject, replayDocs, caveForName, liveCaves, notesOn, leadsOn,
    docInProject, docInbox, docsOf, docsForStation, docsForTarget, pageFor,
    DOC_GROUPS, docGroup, docGroupOf, pageGroup, groupDocs, groupLabel, suggestKind, exifCamera, docTargets, hasPageTags, docsFor, pagesCovering, areaSpan, normalizeSpec, specTarget, areaStations,
    segmentsOf, segmentIndex, segmentsAt, proposalTarget, segmentStates, liveCavefiles, liveLayers, areaLabelsOf, areaLabelId, areaLabelState, areaLabelUndo,
    tripState, tripEdit, tripUndo, tripsOf, tripsFor, tripGroups, tripMoves, tripDays, fullDay, TRIP_NONE,
    snapshotTime, entriesAt, replayProjectAt, replayDocsAt, changeDays, caveBundle, moveRenames, caveMoveEntries, caveMoveClear, moveRecord, movesOf,
    liveFeatures, liveGroups, groupPath, featuresGeoJSON, featuresKML, featuresGPX, flexTag, makeFlexTag,
    selectForSync, syncManifest, newEntries,
    parseNum, shotFlags, shotReading, computeSurvey, stationLruds, suggestCaves,
    liveSystems, systemsOf, systemTotals, fileGroups, planMulti, systemUndo, multiUndo, entrancesOf, entranceFit,
  };
});
