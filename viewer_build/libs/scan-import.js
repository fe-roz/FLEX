/* FLEX: import survey shots from a scanned page (the viewer's "Import shots
 * from scan").
 *
 * A page (photographed now, a page of a document, or a file) is read on the
 * phone: FLEX Field's AndroidHost.ocrImage runs ML Kit's text reader offline
 * and hands back every word with its box. The words become a table (rows,
 * columns, which column is which shot field), the user checks it beside the
 * scan, and the shots go into a field survey through ffRecord('shot.add'),
 * the same path as typed shots, each with a link to its page (src: doc, page,
 * page hash, the row's box on the page).
 *
 * Two halves:
 *  - the table rules, no DOM: words -> rows -> columns -> fields -> cleaned
 *    values with flags -> shots. Node-tested by tools/test_scan_table.js.
 *  - the review screen: the scan with the words' boxes over it (pinch, pan,
 *    tap a box to pick its cell) and the editable table (tap a cell to see its
 *    box); portrait = scan on top, landscape = side by side.
 * Without the app's reader (a desktop browser, an older app) the same screen
 * opens with an empty table to type into beside the page.
 *
 * Works as a classic script (window.FlexScan, after flexlib.js) and under
 * Node (module.exports: the table rules only).
 */
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./flexlib.js') : root.FlexLib);
  if (node) module.exports = api;
  else root.FlexScan = api;
})(typeof self !== 'undefined' ? self : this, function (FL) {
  'use strict';

  // ── Shot fields ───────────────────────────────────────────────────────────
  const FIELDS = ['from', 'to', 'len', 'az', 'inc', 'baz', 'binc', 'l', 'r', 'u', 'd', 'lrud', 'note', 'skip'];
  const LABEL = { from: 'From', to: 'To', len: 'Length', az: 'Azimuth', inc: 'Incl.', baz: 'Back az', binc: 'Back incl.',
    l: 'L', r: 'R', u: 'U', d: 'D', lrud: 'LRUD (all 4)', note: 'Notes', skip: 'Ignore' };
  const NUMERIC = { len: 1, az: 1, inc: 1, baz: 1, binc: 1, l: 1, r: 1, u: 1, d: 1 };
  const LRUD = { l: 1, r: 1, u: 1, d: 1 };
  const ANGLE = { az: 1, baz: 1, inc: 1, binc: 1 };
  const SHOT_KEYS = ['from', 'to', 'len', 'az', 'inc', 'baz', 'binc', 'l', 'r', 'u', 'd'];
  const FT = (FL && FL.FT) || 0.3048;

  const num = v => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
  const median = a => {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const round2 = v => Math.round(v * 100) / 100;
  const parse = (t, f) => (FL ? FL.parseNum(t, LRUD[f] ? 'lrud' : undefined) : { v: num(t), raw: t });

  // ── OCR result -> words ───────────────────────────────────────────────────
  // ML Kit's blocks -> lines -> words (elements) -> chars (symbols), boxes
  // [x0, y0, x1, y1] in pixels of the image read. A flat { words: [...] }
  // (tests, other readers) works too.
  function wordsOf(ocr) {
    const out = [];
    const push = (w, line) => {
      const t = String(w && w.text != null ? w.text : '').trim();
      const b = w && w.box;
      if (!t || !Array.isArray(b) || b.length < 4) return;
      const [x0, y0, x1, y1] = b.map(Number);
      if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return;
      let chars = null;
      if (Array.isArray(w.chars) && w.chars.length) {
        chars = w.chars.filter(c => c && Array.isArray(c.box) && c.box.length >= 4 && String(c.text || '').trim())
          .map(c => ({ text: String(c.text).trim(), x0: +c.box[0], y0: +c.box[1], x1: +c.box[2], y1: +c.box[3], conf: num(c.conf) }));
        if (chars.map(c => c.text).join('') !== t.replace(/\s+/g, '')) chars = null;     // only when they spell the word
      }
      out.push({ i: out.length, text: t, x0, y0, x1, y1, conf: num(w.conf), line, chars });
    };
    if (!ocr) return out;
    if (Array.isArray(ocr.words)) ocr.words.forEach((w, k) => push(w, w.line != null ? w.line : 'w' + k));
    (ocr.blocks || []).forEach((b, bi) => (b.lines || []).forEach((l, li) => {
      const ws = l.words || l.elements || [];
      if (ws.length) ws.forEach(w => push(w, bi + '.' + li)); else push(l, bi + '.' + li);
    }));
    return out;
  }

  // ── Geometry: how the rows run, then rows ────────────────────────────────
  // Row slope (dy/dx) from each word and its nearest neighbour to the right on
  // about the same line: works whether the reader joined a row into one line
  // or cut it into cells.
  function estimateSkew(ws, H) {
    const slopes = [];
    const byX = ws.slice().sort((a, b) => a.x0 - b.x0);
    for (const a of ws) {
      const ay = (a.y0 + a.y1) / 2, ah = a.y1 - a.y0;
      let best = null, bd = Infinity;
      for (const b of byX) {
        if (b === a || b.x0 < a.x1 - 0.25 * ah) continue;
        const gap = b.x0 - a.x1;
        if (gap > 8 * H) break;
        const by = (b.y0 + b.y1) / 2;
        if (Math.abs(by - ay) > 0.7 * Math.max(ah, b.y1 - b.y0)) continue;
        const d = Math.max(0, gap) + 3 * Math.abs(by - ay);
        if (d < bd) { bd = d; best = b; }
      }
      if (best) {
        const dx = (best.x0 + best.x1) / 2 - (a.x0 + a.x1) / 2;
        if (dx > H) slopes.push(((best.y0 + best.y1) / 2 - ay) / dx);
      }
    }
    if (slopes.length < 3) return 0;
    return Math.max(-0.25, Math.min(0.25, median(slopes)));
  }
  // Coordinates turned by the skew: u along the rows, v down the page.
  function deskew(ws, slope) {
    const th = Math.atan(slope), c = Math.cos(th), s = Math.sin(th);
    ws.forEach(w => {
      const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2, hw = (w.x1 - w.x0) / 2, hh = (w.y1 - w.y0) / 2;
      w.u = cx * c + cy * s; w.v = -cx * s + cy * c;
      w.u0 = w.u - hw; w.u1 = w.u + hw; w.v0 = w.v - hh; w.v1 = w.v + hh; w.h = 2 * hh;
      if (w.chars) w.chars.forEach(ch => { ch.u = ((ch.x0 + ch.x1) / 2) * c + ((ch.y0 + ch.y1) / 2) * s; });
    });
    return (x, y) => [x * c + y * s, -x * s + y * c];
  }
  // Rows: sweep left to right; a word joins the row whose line, carried on
  // from its last word (with the row's own drift once it has a few words),
  // passes closest -- so a row written uphill still holds together.
  // Row pitch: from each word to the nearest word below it in the same column.
  function rowPitch(ws, H) {
    const d = [];
    for (const a of ws) {
      let best = Infinity;
      for (const b of ws) {
        if (b === a || b.v <= a.v + 0.5 * H) continue;
        const ov = Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0);
        if (ov < 0.3 * Math.min(a.u1 - a.u0, b.u1 - b.u0)) continue;
        if (b.v - a.v < best) best = b.v - a.v;
      }
      if (best < 6 * H) d.push(best);
    }
    return d.length >= 3 ? median(d) : 2 * H;
  }
  function clusterRows(ws, H) {
    const rows = [];
    const pitch = rowPitch(ws, H);
    const tol = Math.max(0.5 * H, Math.min(0.42 * pitch, 1.5 * H));
    // the row's line: a fit through its words once they spread out, else their mean height
    const fit = r => {
      const n = r.words.length;
      let su = 0, sv = 0, suu = 0, suv = 0;
      r.words.forEach(w => { su += w.u; sv += w.v; suu += w.u * w.u; suv += w.u * w.v; });
      const den = n * suu - su * su, spread = Math.max(...r.words.map(w => w.u)) - Math.min(...r.words.map(w => w.u));
      r.b = n >= 2 && den > 0 && spread > 2 * H ? Math.max(-0.08, Math.min(0.08, (n * suv - su * sv) / den)) : 0;
      r.a = (sv - r.b * su) / n;
    };
    ws.slice().sort((a, b) => a.u0 - b.u0).forEach(w => {
      let best = null, bd = Infinity;
      for (const r of rows) {
        const last = r.last;
        if (w.u0 < last.u1 - 0.3 * H && Math.abs(w.v - last.v) > 0.35 * H) continue;   // stacked under its last word
        const d = Math.abs(w.v - (r.a + r.b * w.u));
        if (d < bd) { bd = d; best = r; }
      }
      if (best && bd <= Math.max(tol, 0.5 * Math.min(w.h, 2 * H))) {
        best.words.push(w);
        if (w.u1 > best.last.u1) best.last = w;
        fit(best);
      } else { const r = { words: [w], last: w }; fit(r); rows.push(r); }
    });
    // Pieces of one row that started apart: side by side, at the same height.
    rows.forEach(r => { r.v = median(r.words.map(w => w.v)); r.u0 = Math.min(...r.words.map(w => w.u0)); r.u1 = Math.max(...r.words.map(w => w.u1)); });
    rows.sort((a, b) => a.v - b.v);
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length && rows[j].v - rows[i].v < 0.8 * tol; j++) {
        const a = rows[i], b = rows[j];
        if (!b.words.length || a.u1 > b.u0 + 0.2 * H && b.u1 > a.u0 + 0.2 * H) continue;
        a.words.push(...b.words); b.words = [];
        a.u0 = Math.min(a.u0, b.u0); a.u1 = Math.max(a.u1, b.u1); a.v = median(a.words.map(w => w.v));
      }
    }
    return rows.filter(r => r.words.length).map(r => {
      r.words.sort((a, b) => a.u0 - b.u0);
      return { words: r.words, v: median(r.words.map(w => w.v)), v0: Math.min(...r.words.map(w => w.v0)), v1: Math.max(...r.words.map(w => w.v1)) };
    }).sort((a, b) => a.v - b.v);
  }

  // ── Headers ───────────────────────────────────────────────────────────────
  // What people write over the columns, after the reader's usual letter
  // mix-ups (0/o, 1/l, 5/s) are undone. One-letter words only exactly.
  const VOCAB = {
    from: ['from', 'fr', 'frm', 'fromstn', 'stn', 'sta', 'station', 'stat', 'at'],
    to: ['to', 'tostn', 'tosta'],
    len: ['dist', 'distance', 'dis', 'len', 'length', 'lgth', 'tape', 'sd', 'slopedist', 'slopedistance', 'meas', 'measured', 'leng'],
    az: ['az', 'azi', 'azim', 'azimuth', 'azm', 'azmuth', 'bearing', 'brg', 'bear', 'comp', 'compass', 'bng', 'heading', 'hdg', 'dir', 'direction'],
    inc: ['inc', 'incl', 'inclin', 'inclination', 'clino', 'clin', 'cl', 'clinometer', 'vert', 'vertical', 'vang', 'angle', 'pitch', 'dip', 'grade'],
    l: ['l', 'left', 'lt', 'lft'], r: ['r', 'right', 'rt', 'rgt'], u: ['u', 'up', 'ceil', 'ceiling'], d: ['d', 'down', 'dn', 'floor'],
    lrud: ['lrud', 'lrud\'s', 'lruds'],
    note: ['notes', 'note', 'comment', 'comments', 'remarks', 'remark', 'desc', 'description', 'features', 'sketch'],
    skip: ['#', 'no', 'nr', 'num', 'shot', 'shotno', 'n'],
  };
  const MOD = { fs: ['fs', 'fore', 'fwd', 'foresight', 'f'], bs: ['bs', 'back', 'bk', 'backsight', 'rev', 'b', 'bck'] };
  const UNIT_WORDS = { ft: ['ft', 'feet', 'foot', 'fts'], m: ['m', 'meters', 'metres', 'meter', 'metre', 'mtrs', 'mts'] };
  const normH = s => String(s || '').toLowerCase().replace(/0/g, 'o').replace(/[1|!]/g, 'l').replace(/5/g, 's').replace(/[^a-z#']/g, '');
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  function vocabHit(tok, list) {
    if (!tok) return false;
    if (list.includes(tok)) return true;
    if (tok.length < 3) return false;
    const max = tok.length >= 8 ? 2 : 1;
    return list.some(w => w.length >= 3 && lev(tok, w, max) <= max);
  }
  // A header cell's text -> { field, mod: 'fs'|'bs'|'', unit }. field may be 'lrud', 'skip' or null.
  function headerField(text) {
    const raw = String(text || '').trim();
    let toks = raw.split(/[\s/()\[\]._:-]+/).map(normH).filter(Boolean);
    let unit = null, mod = '';
    toks = toks.filter(t => {
      if (UNIT_WORDS.ft.includes(t)) { unit = 'ft'; return false; }
      if (UNIT_WORDS.m.includes(t) && toks.length > 1) { unit = 'm'; return false; }
      return true;
    });
    if (/\(\s*m\s*\)/i.test(raw)) unit = 'm';
    if (/\(\s*ft\s*\)|'/i.test(raw) && !unit) unit = 'ft';
    if (!toks.length) return { field: null, mod, unit };
    const joined = toks.join('');
    const find = t0 => {
      for (const t of t0.includes('rn') ? [t0, t0.replace(/rn/g, 'm')] : [t0]) {
        for (const k of Object.keys(VOCAB)) {
          if (k === 'skip' && t.length > 4) continue;
          if (t.length <= 2 ? VOCAB[k].includes(t) : vocabHit(t, VOCAB[k])) return k;
        }
      }
      return null;
    };
    // Modifiers: "BS az", "Back incl", "FS", "Az BS"
    const rest = [];
    toks.forEach(t => {
      if (toks.length > 1 && (MOD.bs.includes(t) || (t.length >= 4 && vocabHit(t, ['back', 'backsight'])))) mod = 'bs';
      else if (toks.length > 1 && MOD.fs.includes(t)) mod = mod || 'fs';
      else rest.push(t);
    });
    if (toks.length === 1 && ['fs', 'fore', 'foresight', 'fwd'].includes(toks[0])) return { field: null, mod: 'fs', unit };
    if (toks.length === 1 && ['bs', 'back', 'backsight', 'bk'].includes(toks[0])) return { field: null, mod: 'bs', unit };
    let field = find(joined);
    if (!field) for (const t of rest) { field = find(t); if (field) break; }
    if (field === 'note' && rest.length > 1 && rest.every(t => t.length === 1 && 'lrud'.includes(t))) field = 'lrud';
    if (!field && rest.length >= 3 && rest.every(t => t.length === 1 && 'lrud'.includes(t))) field = 'lrud';
    return { field, mod, unit };
  }

  // ── Numbers and station names ────────────────────────────────────────────
  // The reader's usual mix-ups in a number: letters that look like digits, a
  // decimal comma, a degree sign read as o or 0, feet and inches. Every
  // change is listed, so the cell can say what was read.
  const DIGIT = { O: '0', o: '0', Q: '0', D: '0', l: '1', I: '1', '|': '1', i: '1', '!': '1', j: '1', J: '1', ']': '1', '[': '1',
    S: '5', s: '5', $: '5', Z: '2', z: '2', B: '8', G: '6', b: '6', g: '9', q: '9', T: '7' };
  const DITTO = /^(?:"|''|〃|”|“|„|do\.?|ditto|ii)$/i;
  const LIMIT = { len: [0, 1000], az: [0, 360], baz: [0, 360], inc: [-90, 90], binc: [-90, 90], l: [0, 300], r: [0, 300], u: [0, 300], d: [0, 300] };
  const inRange = (v, f) => v != null && v >= LIMIT[f][0] && (f === 'az' || f === 'baz' ? v < LIMIT[f][1] : v <= LIMIT[f][1]);
  function fixNumber(raw, field) {
    const fixes = [];
    let t = String(raw == null ? '' : raw).trim();
    if (!t) return { text: '', fixes };
    if (/^[-–—_~.]+$/.test(t)) return { text: '', fixes: ['a dash: not measured'] };
    t = t.replace(/^[−–—~]/, '-').replace(/\s+/g, ' ');
    const br = /^\((.*)\)$/.exec(t);
    if (br) { t = br[1].trim(); fixes.push('brackets'); }
    if (field === 'len' || LRUD[field]) {
      const m = /^(\d+)\s*['’′]\s*(?:(\d+(?:\.\d+)?)\s*(?:["”″]|'')?)?$/.exec(t);
      if (m) { t = String(round2(+m[1] + (m[2] ? +m[2] / 12 : 0))); fixes.push('feet and inches'); }
    }
    if ((field === 'inc' || field === 'binc') && /^[tT]\s?\d/.test(t)) { t = '+' + t.replace(/^[tT]\s?/, ''); fixes.push('t→+'); }
    if (ANGLE[field] && /\d\s*[°º˚*]$/.test(t)) t = t.replace(/\s*[°º˚*]$/, '');
    let deg = false;
    if (ANGLE[field] && /\d\s?o$/.test(t)) { t = t.replace(/\s?o$/, ''); deg = true; }
    // letters that are digits: only in something that is mostly a number
    const letters = [...t].filter(ch => DIGIT[ch] !== undefined);
    const digits = (t.match(/\d/g) || []).length;
    if (letters.length && (digits >= letters.length || (t.replace(/[-+.,\s]/g, '').length <= 3 && [...t.replace(/[-+.,\s]/g, '')].every(ch => DIGIT[ch] !== undefined || /\d/.test(ch))))) {
      const seen = [];
      t = [...t].map(ch => { if (DIGIT[ch] !== undefined) { if (!seen.includes(ch)) seen.push(ch); return DIGIT[ch]; } return ch; }).join('');
      fixes.push(seen.map(ch => ch + '→' + DIGIT[ch]).join(' '));
    }
    if (/^[-+]?\d+\s?,\s?\d+$/.test(t)) { t = t.replace(/\s?,\s?/, '.'); fixes.push('decimal comma'); }
    if (/^[-+]?\d+\s*\.\s*\d+$/.test(t) && /\s/.test(t)) t = t.replace(/\s*\.\s*/, '.');
    if (/^[-+]?\d+ \d+$/.test(t) && !LRUD[field]) { /* two numbers: left for the user (parseNum flags it) */ }
    if (/\d[.,;:]$/.test(t)) { t = t.slice(0, -1); fixes.push('stray mark'); }
    t = t.replace(/\.{2,}/g, '.');
    if (t[0] === '+' && !(field === 'inc' || field === 'binc')) t = t.slice(1);
    // a degree sign read as a final 0 ("2450"), or as o ("24o" = 24 or 240?)
    if (ANGLE[field]) {
      const v = num(t);
      if (deg) {
        const alt = num(t + '0');
        fixes.push(inRange(alt, field) && inRange(v, field) ? `° or 0? (${t} or ${t}0)` : '° read as o');
      } else if (v != null && !inRange(v, field) && /0$/.test(t) && inRange(num(t.slice(0, -1)), field)) {
        t = t.slice(0, -1); fixes.push('° read as 0?');
      }
    }
    return { text: t, fixes };
  }
  // Station names stay text; only the digits of "A1O" or "T 6" are tidied, and
  // a name that matches a known station but for case or a 0/O, 1/l mix-up
  // takes that station's spelling (so the shot ties in).
  const canon = s => String(s || '').toUpperCase().replace(/\s+/g, '').replace(/O/g, '0').replace(/[IL|]/g, '1');
  // names: the stations that exist (exact spellings win); extra: names read
  // elsewhere in the same table, used only when no existing station matches.
  function knownIndex(names, extra) {
    const exact = new Set(), map = new Map();
    const tier = (list, into) => {
      const m = new Map(), dup = new Set();
      (list || []).forEach(n => {
        n = String(n || '').trim(); if (!n) return;
        if (into) exact.add(n);
        const k = canon(n);
        if (m.has(k) && m.get(k) !== n) dup.add(k); else m.set(k, n);
      });
      dup.forEach(k => m.delete(k));
      m.forEach((v, k) => { if (!map.has(k)) map.set(k, v); });
    };
    tier(names, true);
    tier(extra, false);
    return { exact, map };
  }
  function fixStation(raw, known) {
    const fixes = [];
    let t = String(raw == null ? '' : raw).trim().replace(/[.,;:]+$/, '');
    if (!t) return { text: '', fixes };
    if (/^[A-Za-z]{1,4}\s+\d+[A-Za-z]?$/.test(t)) { t = t.replace(/\s+/, ''); fixes.push('space'); }
    const m = /^([A-Za-z]*?)([0-9OoIl|]*\d[0-9OoIl|]*)([A-Za-z]?)$/.exec(t);
    if (m && /[OoIl|]/.test(m[2]) && !(m[1] === '' && /^[OoIl|]/.test(m[2]) && !known)) {
      const d = m[2].replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
      if (d !== m[2]) { t = m[1] + d + m[3]; fixes.push('O→0 / l→1'); }
    }
    if (known && !known.exact.has(t)) {
      const hit = known.map.get(canon(t)) || known.map.get(canon(raw));
      if (hit && hit !== t) { t = hit; fixes.push('as station ' + hit); }
    }
    return { text: t, fixes };
  }

  // ── Columns ───────────────────────────────────────────────────────────────
  // Where the data rows have words: a column is an x range most rows write
  // in, a gap one few do (a word across a gap in one row is a merged cell, not
  // a bridge). Columns few rows use (notes, LRUD half filled in) come from
  // the words left over; header words name, split or add columns.
  function findColumns(dataRows, H) {
    // words of one cell written apart ("small room") count as one piece
    const units = [];
    dataRows.forEach(r => {
      let cur = null;
      r.words.forEach(w => {
        const alpha = /[A-Za-z]/.test(w.text) && !/\d/.test(w.text);
        if (cur && alpha && cur.alpha && w.u0 - cur.u1 < 1.0 * H) { cur.u1 = Math.max(cur.u1, w.u1); cur.u = (cur.u0 + cur.u1) / 2; }
        else { cur = { u0: w.u0, u1: w.u1, u: w.u, alpha }; units.push(cur); cur.row = r; }
      });
    });
    if (!units.length) return [];
    const uMin = Math.min(...units.map(w => w.u0)), uMax = Math.max(...units.map(w => w.u1));
    const bw = Math.max(1, H / 4), nb = Math.ceil((uMax - uMin) / bw) + 2;
    const bin = u => Math.max(0, Math.min(nb - 1, Math.floor((u - uMin) / bw)));
    const cov = new Float64Array(nb);
    dataRows.forEach(r => {
      const seen = new Uint8Array(nb);
      units.forEach(w => { if (w.row === r) for (let k = bin(w.u0 + 0.1 * H); k <= bin(w.u1 - 0.1 * H); k++) seen[k] = 1; });
      for (let k = 0; k < nb; k++) cov[k] += seen[k];
    });
    const N = dataRows.length;
    const T = N <= 1 ? 1 : Math.max(2, Math.ceil(0.25 * N));
    let runs = [];
    for (let k = 0; k < nb; k++) {
      if (cov[k] < T) continue;
      const last = runs[runs.length - 1];
      if (last && k - last[1] <= 1) last[1] = k; else runs.push([k, k]);
    }
    // narrow columns side by side (L R U D) whose gaps a few wide values
    // bridge: cut a run at a deep valley between two peaks
    const minW = Math.max(1, Math.round(0.4 * H / bw));
    const cut = ([a, b]) => {
      let best = -1, depth = 1;
      for (let k = a + minW; k <= b - minW; k++) {
        let pl = 0, pr = 0;
        for (let j = a; j < k; j++) pl = Math.max(pl, cov[j]);
        for (let j = k + 1; j <= b; j++) pr = Math.max(pr, cov[j]);
        const r = cov[k] / Math.min(pl, pr);
        if (r < depth && r <= 0.34) { depth = r; best = k; }
      }
      if (best < 0) return [[a, b]];
      let l = best, r = best;
      while (l - 1 > a && cov[l - 1] <= cov[best]) l--;
      while (r + 1 < b && cov[r + 1] <= cov[best]) r++;
      return cut([a, l - 1]).concat(cut([r + 1, b]));
    };
    runs = [].concat(...runs.map(cut)).filter(([a, b]) => b >= a);
    const cols = runs.map(([a, b]) => ({ u0: uMin + a * bw, u1: uMin + (b + 1) * bw }));
    // a piece belongs to a column when it covers a good part of it (a wide
    // "1.5" in a column of single digits) or its middle is in it
    const member = (w, c) => {
      const o = Math.min(w.u1, c.c1) - Math.max(w.u0, c.c0);
      return o >= 0.5 * Math.min(c.c1 - c.c0, w.u1 - w.u0) || (w.u >= c.c0 - 0.3 * H && w.u <= c.c1 + 0.3 * H);
    };
    cols.forEach(c => { c.c0 = c.u0; c.c1 = c.u1; });
    const left = units.filter(w => !cols.some(c => member(w, c))).sort((a, b) => a.u0 - b.u0);
    const weak = [];
    left.forEach(w => {
      const c = weak[weak.length - 1];
      if (c && w.u0 <= c.u1 + 0.5 * H) c.u1 = Math.max(c.u1, w.u1); else weak.push({ u0: w.u0, u1: w.u1 });
    });
    weak.forEach(c => {
      const over = cols.reduce((a, s) => a + Math.max(0, Math.min(c.u1, s.c1) - Math.max(c.u0, s.c0)), 0);
      if (over < 0.5 * (c.u1 - c.u0)) cols.push(Object.assign(c, { c0: c.u0, c1: c.u1 }));
    });
    cols.sort((a, b) => a.c0 - b.c0);
    // grow each column to its pieces, never past the middle of the gap to the next
    units.forEach(w => {
      const k = cols.findIndex(c => member(w, c));
      if (k < 0) return;
      cols[k].u0 = Math.min(cols[k].u0, w.u0); cols[k].u1 = Math.max(cols[k].u1, w.u1);
    });
    for (let k = 0; k + 1 < cols.length; k++) {
      if (cols[k].u1 > cols[k + 1].u0) {
        const mid = (cols[k].c1 + cols[k + 1].c0) / 2;
        cols[k].u1 = Math.min(cols[k].u1, mid); cols[k + 1].u0 = Math.max(cols[k + 1].u0, mid);
      }
    }
    return cols.map(c => ({ u0: c.u0, u1: c.u1, c0: c.c0, c1: c.c1 }));
  }
  // Header rows -> header cells (words close together are one cell; "L R U D"
  // written as one run is four).
  // Two words that each name a field stay two cells however close ("Azimuth
  // Incl"), except a station word after From / To ("To Stn").
  const STN_WORDS = ['stn', 'sta', 'station', 'stat'];
  function headerCells(hrows, H) {
    const cells = [];
    hrows.forEach((r, ri) => {
      let cur = null;
      r.words.forEach(w => {
        const a = cur && headerField(cur.words.map(x => x.text).join(' ')), b = headerField(w.text);
        const named = f => f && f !== 'skip';
        const apart = cur && named(a.field) && named(b.field) && !((a.field === 'from' || a.field === 'to') && STN_WORDS.includes(normH(w.text)));
        if (cur && w.u0 - cur.u1 < 0.9 * H && !apart) { cur.words.push(w); cur.u1 = Math.max(cur.u1, w.u1); }
        else { cur = { words: [w], u0: w.u0, u1: w.u1, level: ri }; cells.push(cur); }
      });
    });
    const out = [];
    cells.forEach(c => {
      const singles = c.words.length >= 2 && c.words.every(w => /^[lrudLRUD]$/.test(w.text));
      if (singles) c.words.forEach(w => out.push({ words: [w], u0: w.u0, u1: w.u1, level: c.level }));
      else out.push(c);
    });
    out.forEach(c => { c.text = c.words.map(w => w.text).join(' '); Object.assign(c, headerField(c.text)); c.u = (c.u0 + c.u1) / 2; });
    return out;
  }

  // ── Building the table ────────────────────────────────────────────────────
  const looksNum = t => /^[-+−–]?\d+([.,]\d+)?[°º]?$/.test(String(t).trim()) || /^\d+\/\d+$/.test(String(t).trim());
  function rowStats(r) {
    let nNum = 0, nVocab = 0;
    r.words.forEach(w => {
      if (looksNum(w.text) || looksNum(fixNumber(w.text, 'len').text) && /\d/.test(w.text)) nNum++;
      const h = headerField(w.text);
      if (h.field && h.field !== 'skip' || h.mod) nVocab++;
    });
    return { nNum, nVocab, n: r.words.length };
  }
  // OCR result -> table: { width, height, skew, H, unit, columns: [{ field, header, u0, u1, auto }],
  // rows: [{ kind: 'data'|'header'|'other', off, cells: [{ raw, box, conf, words, merged }] }], words }
  function buildTable(ocr, opts) {
    opts = opts || {};
    const ws = wordsOf(ocr);
    if (ws.length && !ws.some(w => w.conf > 0)) ws.forEach(w => { w.conf = null; });     // a reader that gives no confidence
    const table = { width: num(ocr && ocr.width) || 0, height: num(ocr && ocr.height) || 0, skew: 0, H: 0, unit: null,
      columns: [], rows: [], words: ws.map(w => ({ text: w.text, box: [w.x0, w.y0, w.x1, w.y1], conf: w.conf })) };
    if (!ws.length) return table;
    let H = Math.max(4, median(ws.map(w => w.y1 - w.y0)));
    // ruled lines read as text: tall thin strokes ("|", "l" between columns), long runs of dashes or underscores
    const kept = ws.filter(w => {
      const h = w.y1 - w.y0, wd = w.x1 - w.x0;
      if (/^[|lI1!\[\]()]+$/.test(w.text) && h > 1.8 * H && wd < 0.5 * H) return false;
      if (/^[-_=~.—–]{3,}$/.test(w.text) && wd > 3 * H) return false;
      return h < 3.5 * H;
    });
    if (kept.length !== ws.length) {
      ws.length = 0; kept.forEach(w => ws.push(w));
      H = Math.max(4, median(ws.map(w => w.y1 - w.y0)));
    }
    const slope = estimateSkew(ws, H);
    deskew(ws, slope);
    table.H = H; table.skew = slope;
    const rows = clusterRows(ws, H);
    // header rows: the first rows that read like column names (up to two),
    // rows above them (a title) left out; without a header, rows above the
    // first row with three numbers are left out
    const st = rows.map(rowStats);
    let firstData = st.findIndex(s => s.nNum >= 2);
    if (firstData < 0) firstData = rows.length;
    let hdr = [];
    for (let i = 0; i < Math.min(firstData, rows.length); i++) {
      const s = st[i];
      if (s.nVocab >= 2 && s.nVocab >= 0.5 * s.n && s.nNum <= 1) hdr.push(i);
      else if (hdr.length && s.nVocab >= 1 && s.nVocab >= 0.5 * s.n && s.nNum === 0) hdr.push(i);   // "FS BS" under "Az Inc"
    }
    hdr = hdr.filter((i, k) => k === 0 || i === hdr[k - 1] + 1).slice(-2);
    const top = hdr.length ? hdr[hdr.length - 1] + 1 : rows.findIndex(r => rowStats(r).nNum >= 3);
    const dataFrom = top < 0 ? 0 : top;
    const kinds = rows.map((r, i) => hdr.includes(i) ? 'header' : i < dataFrom ? 'other' : 'data');
    const dataRows = rows.filter((r, i) => kinds[i] === 'data');
    let cols = findColumns(dataRows, H);
    const hcells = headerCells(rows.filter((r, i) => kinds[i] === 'header'), H);
    // header cells name the columns under them; two names over one column split it; a name over no column adds one
    const lowest = hcells.length ? Math.max(...hcells.map(c => c.level)) : 0;
    const owner = c => {
      let best = -1, bo = 0;
      cols.forEach((col, k) => {
        const o = Math.min(c.u1, col.u1 + 0.4 * H) - Math.max(c.u0, col.u0 - 0.4 * H);
        if (o > bo) { bo = o; best = k; }
      });
      if (best < 0) {
        let bd = Infinity;
        cols.forEach((col, k) => { const d = Math.abs((col.u0 + col.u1) / 2 - c.u); if (d < bd && d < 1.5 * H + (col.u1 - col.u0) / 2) { bd = d; best = k; } });
      }
      return best;
    };
    hcells.filter(c => c.level === lowest).sort((a, b) => a.u - b.u).forEach(c => {
      if (!c.field && !c.mod) return;
      const k = owner(c);
      if (k < 0) { cols.push({ u0: c.u0, u1: c.u1, c0: c.u0, c1: c.u1, hc: [c] }); cols.sort((a, b) => a.u0 - b.u0); return; }
      (cols[k].hc || (cols[k].hc = [])).push(c);
    });
    // split columns that carry two names
    const split = [];
    cols.forEach(col => {
      const hc = (col.hc || []).sort((a, b) => a.u - b.u);
      if (hc.length < 2) { split.push(col); return; }
      hc.forEach((c, i) => {
        const a = i === 0 ? col.u0 : (hc[i - 1].u + c.u) / 2, b = i === hc.length - 1 ? col.u1 : (c.u + hc[i + 1].u) / 2;
        split.push({ u0: a, u1: b, c0: Math.max(a, Math.min(col.c0, b)), c1: Math.min(b, Math.max(col.c1, a)), hc: [c] });
      });
    });
    cols = split;
    // an upper header ("Azimuth" over FS | BS) names the columns it spans
    hcells.filter(c => c.level !== lowest && c.field).forEach(c => {
      cols.forEach(col => {
        const o = Math.min(c.u1, col.u1) - Math.max(c.u0, col.u0);
        if (o > 0.3 * Math.min(col.u1 - col.u0, c.u1 - c.u0)) (col.up || (col.up = [])).push(c);
      });
    });
    // fields from the headers
    cols.forEach(col => {
      const h = (col.hc || [])[0], up = (col.up || [])[0];
      let field = h && h.field, mod = (h && h.mod) || '';
      if (!field && up) field = up.field;
      if (field === 'az' && mod === 'bs') field = 'baz';
      if (field === 'inc' && mod === 'bs') field = 'binc';
      col.header = [up && up.text, h && h.text].filter(Boolean).join(' / ') || '';
      col.field = field || null;
      if (h && h.unit) table.unit = h.unit;
      if (up && up.unit) table.unit = up.unit;
    });
    // one LRUD header over four columns (written over the first, or across them)
    cols.forEach((col, k) => {
      if (col.field !== 'lrud') return;
      const hc = (col.hc || col.up || [])[0];
      const ov = hc ? cols.map((c2, j) => (Math.min(hc.u1 + H, c2.u1) - Math.max(hc.u0 - H, c2.u0) > 0 ? j : -1)).filter(j => j >= 0) : [];
      const s0 = Math.min(k, ov.length ? Math.min(...ov) : k);
      const four = cols.slice(s0, s0 + 4);
      if (four.length === 4 && four.every(c2 => c2 === col || !c2.field)) ['l', 'r', 'u', 'd'].forEach((f, i) => { four[i].field = f; });
    });
    // repeated names: Station Station -> From To; Az Az -> Az, Back az; Inc Inc -> Inc, Back incl.; a lone D among L R U
    const seen = {};
    const hasLRU = ['l', 'r', 'u'].every(f => cols.some(c => c.field === f));
    cols.forEach(col => {
      const f = col.field;
      if (!f) return;
      if (f === 'd' && !hasLRU && !cols.some(c => c.field === 'len')) col.field = 'len';
      if (seen[col.field]) {
        const next = { from: 'to', az: 'baz', inc: 'binc' }[col.field];
        col.field = next && !seen[next] ? next : (col.field === 'note' ? 'note' : 'skip');
      }
      seen[col.field] = true;
    });
    if (!table.unit && opts.unit) table.unit = opts.unit;
    // cells
    const cellsOf = r => {
      const cells = cols.map(() => ({ parts: [] }));
      r.words.forEach(w => assign(w, cols, cells, H));
      return cells.map(c => finishCell(c, H));
    };
    table.rows = rows.map((r, i) => ({ kind: kinds[i], off: kinds[i] !== 'data', cells: cellsOf(r) }));
    // a row read as two (some words written low, some high): two halves that
    // sit closer than a row apart and fill different columns are one row
    const pitch = rowPitch(ws, H);
    for (let i = 0; i + 1 < table.rows.length; i++) {
      const A = table.rows[i], B = table.rows[i + 1];
      if (A.kind !== 'data' || B.kind !== 'data' || rows[i + 1].v - rows[i].v > 0.6 * pitch) continue;
      if (A.cells.some((c, k) => c.raw && B.cells[k].raw)) continue;
      A.cells = A.cells.map((c, k) => (c.raw ? c : B.cells[k]));
      rows[i].v = (rows[i].v + rows[i + 1].v) / 2;
      table.rows.splice(i + 1, 1); rows.splice(i + 1, 1);
      i--;
    }
    // columns no header named: by what is in them
    table.columns = cols.map(c => ({ field: c.field || null, header: c.header || '', u0: c.u0, u1: c.u1, c0: c.c0, c1: c.c1, auto: !c.field }));
    guessFields(table);
    return table;
  }
  // A word to the column it overlaps most; a word across a gap (two cells read
  // as one) is cut where its letters cross into the next column.
  function assign(w, cols, cells, H) {
    if (!cols.length) return;
    // overlap with each column's core (negative = the gap to it)
    const ov = cols.map(c => Math.min(w.u1, c.c1) - Math.max(w.u0, c.c0));
    const wW = w.u1 - w.u0;
    const hits = ov.map((o, k) => (o >= Math.max(0.3 * H, 0.35 * Math.min(wW, cols[k].c1 - cols[k].c0)) ? k : -1)).filter(k => k >= 0);
    if (hits.length >= 2 && w.text.replace(/\s+/g, '').length >= 2 && /\d/.test(w.text)) {
      const chars = w.chars ? w.chars.map(c => ({ t: c.text, u: c.u, box: [c.x0, c.y0, c.x1, c.y1], conf: c.conf }))
        : [...w.text.replace(/\s+/g, '')].map((t, i, a) => {
          const f0 = i / a.length, f1 = (i + 1) / a.length;
          return { t, u: w.u0 + (f0 + f1) / 2 * wW, box: [w.x0 + f0 * (w.x1 - w.x0), w.y0, w.x0 + f1 * (w.x1 - w.x0), w.y1], conf: w.conf };
        });
      const colOf = u => { let best = hits[0], bd = Infinity; hits.forEach(k => { const c = cols[k]; const d = u < c.c0 ? c.c0 - u : u > c.c1 ? u - c.c1 : 0; if (d < bd) { bd = d; best = k; } }); return best; };
      const groups = [];
      chars.forEach(ch => {
        const k = colOf(ch.u), g = groups[groups.length - 1];
        if (g && g.k === k) { g.t += ch.t; g.box = union(g.box, ch.box); g.conf = minConf(g.conf, ch.conf); g.u1 = ch.u; }
        else groups.push({ k, t: ch.t, box: ch.box.slice(), conf: ch.conf, u0: ch.u, u1: ch.u });
      });
      if (groups.length >= 2) {
        groups.forEach(g => cells[g.k].parts.push({ text: g.t, box: g.box, conf: g.conf, u0: g.u0, u1: g.u1, word: w.i, merged: true }));
        return;
      }
    }
    const k = ov.indexOf(Math.max(...ov));
    cells[k].parts.push({ text: w.text, box: [w.x0, w.y0, w.x1, w.y1], conf: w.conf, u0: w.u0, u1: w.u1, word: w.i });
  }
  const union = (a, b) => (!a ? b && b.slice() : !b ? a.slice() : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
  const minConf = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
  function finishCell(c, H) {
    const ps = c.parts.sort((a, b) => a.u0 - b.u0);
    let raw = '';
    ps.forEach((p, i) => {
      if (!i) { raw = p.text; return; }
      const gap = p.u0 - ps[i - 1].u1;
      const glue = /[\d.,]$/.test(raw) && /^[\d.,]/.test(p.text) && gap < 0.35 * H || /^[.,]/.test(p.text) || /[.,]$/.test(raw);
      raw += (glue ? '' : ' ') + p.text;
    });
    const out = { raw, box: null, conf: null, words: [] };
    ps.forEach(p => { out.box = union(out.box, p.box); out.conf = minConf(out.conf, p.conf); if (!out.words.includes(p.word)) out.words.push(p.word); if (p.merged) out.merged = true; });
    return out;
  }

  // ── Columns no header named: by what is in them ──────────────────────────
  // Each column gets a score for every field from its numbers (ranges, signs,
  // decimals) and words; the fields keep the usual order of a survey book
  // (From To Length Azimuth [Back] Incl. [Back] L R U D Notes), any may be
  // missing, and fore/back pairs (azimuths 180° apart, inclinations of
  // opposite sign) and To = next From are rewarded.
  const SEQS = [
    ['from', 'to', 'len', 'az', 'baz', 'inc', 'binc', 'l', 'r', 'u', 'd', 'note'],
    ['from', 'to', 'len', 'az', 'inc', 'baz', 'binc', 'l', 'r', 'u', 'd', 'note'],
    ['from', 'to', 'az', 'inc', 'len', 'l', 'r', 'u', 'd', 'note'],
  ];
  const STN_RE = /^[A-Za-z]{0,4}[-_.]?\d+[A-Za-z]?$|^[A-Za-z]{1,3}\d*[A-Za-z]?\d*$/;
  const CORE = { len: 1, az: 1, inc: 1 };
  function colStats(texts) {
    const ne = texts.map(t => String(t || '').trim()).filter(Boolean);
    const s = { n: ne.length, fill: texts.length ? ne.length / texts.length : 0 };
    if (!ne.length) return s;
    const vals = [];
    let nNum = 0, nAlpha = 0, nNeg = 0, nSign = 0, nDec = 0, nStn = 0, len = 0;
    ne.forEach(t => {
      len += t.length;
      if (/[A-Za-z]/.test(t)) nAlpha++;
      if (STN_RE.test(t) && /\d/.test(t)) nStn++;
      const f = fixNumber(t, 'len').text;
      if (/^[-+]?\d+(\.\d+)?$/.test(f) && (/\d/.test(t) && (t.match(/[A-Za-z]/g) || []).length <= 1)) {
        nNum++; vals.push(+f);
        if (/^[-−–]/.test(t)) nNeg++;
        if (/^[-+−–]/.test(t)) nSign++;
        if (/[.,]/.test(t)) nDec++;
      }
    });
    const n = ne.length, abs = vals.map(Math.abs);
    Object.assign(s, { num: nNum / n, alpha: nAlpha / n, stn: nStn / n, neg: nNeg / n, sign: nSign / n, dec: nNum ? nDec / nNum : 0,
      vmin: vals.length ? Math.min(...vals) : null, vmax: vals.length ? Math.max(...vals) : null, vmed: vals.length ? median(vals) : null,
      amax: abs.length ? Math.max(...abs) : null, amed: abs.length ? median(abs) : null, avg: len / n, ints: vals.length && vals.every(v => Number.isInteger(v)) });
    return s;
  }
  function fieldScore(f, s) {
    if (!s.n) return f === 'skip' ? 0 : -0.1;
    const numeric = 2 * s.num - 1.5 * s.alpha;
    switch (f) {
      case 'from': case 'to': return 2.2 * s.stn + 0.8 * s.alpha - 2 * s.dec - 2 * s.neg + (s.fill > 0.6 ? 0.4 : -0.4) + (s.ints && s.vmax != null && s.vmax < 1000 ? 0.4 : 0);
      case 'len': return numeric + (s.vmin > 0 ? 0.8 : -1.5) + (s.vmed >= 1 && s.vmed <= 200 ? 0.5 : -1) + 0.9 * s.dec - 2.5 * s.neg + (s.vmax > 400 ? -2 : 0);
      case 'az': case 'baz': return numeric + (s.vmax != null && s.vmax < 360 && s.vmin >= 0 ? 0.8 : -2.5) + (s.vmax > 90 ? 1.3 : -0.6) - 2.5 * s.neg - 0.3 * s.dec;
      case 'inc': case 'binc': return numeric + (s.amax != null && s.amax <= 90 ? 0.8 : -2.5) + 1.6 * s.sign + (s.amed <= 45 ? 0.4 : -0.6);
      case 'l': case 'r': case 'u': case 'd': return numeric + (s.vmin >= 0 ? 0.5 : -2.5) + (s.vmax <= 50 ? 0.8 : -1.5) + (s.vmed <= 15 ? 0.4 : -0.3) - 0.3 * s.dec;
      case 'note': return 1.5 * s.alpha + (s.avg > 5 ? 0.8 : -0.3) - 2 * s.num - 0.5 * s.stn;
      default: return -0.3;
    }
  }
  const normStn = t => String(t || '').trim().toUpperCase();
  function chainScore(a, b) {      // To (b) of a row = From (a) of the next row
    let n = 0, hit = 0;
    for (let i = 0; i + 1 < a.length; i++) {
      if (!normStn(b[i]) || !normStn(a[i + 1])) continue;
      n++; if (normStn(b[i]) === normStn(a[i + 1])) hit++;
    }
    return n >= 2 ? hit / n : 0;
  }
  function pairScore(a, b, kind) {   // fore / back readings of one shot
    let n = 0, hit = 0;
    a.forEach((t, i) => {
      const x = num(fixNumber(t, kind).text), y = num(fixNumber(b[i], kind).text);
      if (x == null || y == null) return;
      n++;
      if (kind === 'az' ? Math.abs(((x - y) % 360 + 360) % 360 - 180) <= 6 : Math.abs(x + y) <= 3 && (Math.abs(x) >= 1 || Math.abs(y) >= 1)) hit++;
    });
    return n >= 2 ? hit / n : 0;
  }
  function guessFields(table) {
    const cols = table.columns;
    const data = table.rows.filter(r => r.kind === 'data');
    if (!cols.length) return;
    const texts = cols.map((c, k) => data.map(r => r.cells[k].raw));
    const stats = texts.map(colStats);
    const fixed = cols.map(c => c.field);
    const free = cols.map((c, k) => (c.field ? -1 : k)).filter(k => k >= 0);
    if (!free.length) return;
    const used = new Set(fixed.filter(Boolean));
    let best = null;
    SEQS.forEach(seq0 => {
      const seq = seq0.filter(f => !used.has(f) || f === 'note');
      // dp over the free columns: each takes the next unused field in order, or is skipped; Notes may repeat
      const C = free.length, S = seq.length;
      const dp = Array.from({ length: C + 1 }, () => new Array(S + 1).fill(-Infinity));
      const from = Array.from({ length: C + 1 }, () => new Array(S + 1).fill(null));
      dp[0][0] = 0;
      for (let i = 0; i < C; i++) for (let p = 0; p <= S; p++) {
        if (dp[i][p] === -Infinity) continue;
        const k = free[i];
        const sk = dp[i][p] + fieldScore('skip', stats[k]);
        if (sk > dp[i + 1][p]) { dp[i + 1][p] = sk; from[i + 1][p] = [p, 'skip']; }
        for (let q = p; q < S; q++) {
          const f = seq[q], nx = f === 'note' ? q : q + 1;
          // Length, Azimuth and Incl. are in nearly every book: a short table's small numbers are those before LRUD
          const v = dp[i][p] + fieldScore(f, stats[k]) + (CORE[f] && stats[k].n ? 1.5 : 0);
          if (v > dp[i + 1][nx]) { dp[i + 1][nx] = v; from[i + 1][nx] = [p, f]; }
        }
      }
      let p = 0, top = -Infinity;
      for (let q = 0; q <= S; q++) if (dp[C][q] > top) { top = dp[C][q]; p = q; }
      const pick = new Array(C);
      for (let i = C; i > 0; i--) { const [pp, f] = from[i][p]; pick[i - 1] = f; p = pp; }
      const fields = fixed.slice();
      free.forEach((k, i) => { fields[k] = pick[i]; });
      // rewards for pairs
      const at = f => fields.indexOf(f);
      let total = top;
      if (at('from') >= 0 && at('to') >= 0) total += 2.5 * chainScore(texts[at('from')], texts[at('to')]);
      if (at('az') >= 0 && at('baz') >= 0) total += 4 * pairScore(texts[at('az')], texts[at('baz')], 'az') - 1.5;
      if (at('inc') >= 0 && at('binc') >= 0) total += 4 * pairScore(texts[at('inc')], texts[at('binc')], 'inc') - 1.5;
      if (!best || total > best.total + 1e-9) best = { total, fields };
    });
    cols.forEach((c, k) => { if (!c.field) c.field = best.fields[k] || 'skip'; });
  }

  // ── Resolving: cleaned text, flags and shots ─────────────────────────────
  // Cell text = what the user typed, else what was read, cleaned for its
  // column's field. Flags: level 1 = check this (low confidence, a fix, a
  // ditto, merged cells), level 2 = wrong as it stands (FL.shotFlags,
  // parseNum's own). opts: { unit, known: [station names], low: 0.6 }.
  const DOUBT = 1, BAD = 2;
  function resolve(table, opts) {
    opts = opts || {};
    const unit = opts.unit || table.unit || 'ft';
    // stations: the ones given (the cave's) and the ones this table reads cleanly ("X10" makes "XlO" X10)
    const sk = table.columns.map((c, k) => (c.field === 'from' || c.field === 'to' ? k : -1)).filter(k => k >= 0);
    const clean = [];
    table.rows.forEach(r => { if (!r.off) sk.forEach(k => { const c = r.cells[k]; if (!c || c.edited) return; const f = fixStation(c.raw, null); if (/\d/.test(f.text)) clean.push(f.text); }); });
    const known = (opts.known && opts.known.length) || clean.length ? knownIndex(opts.known || [], clean) : null;
    const low = opts.low != null ? opts.low : 0.6;
    const cols = table.columns;
    const out = { cells: [], shots: [], unit };
    let prev = null, prevRow = null;
    table.rows.forEach((row, ri) => {
      const rc = cols.map(() => ({ text: '', flags: [], level: 0 }));
      out.cells.push(rc);
      const flag = (k, msg, lvl) => { if (k < 0 || !rc[k]) return; rc[k].flags.push(msg); rc[k].level = Math.max(rc[k].level, lvl); };
      cols.forEach((col, k) => {
        const cell = row.cells[k] || { raw: '' };
        const f = col.field || 'skip';
        const base = cell.edited ? String(cell.text || '') : String(cell.raw || '');
        let text = base.trim(), fixes = [];
        if (!cell.edited) {
          if (DITTO.test(text) && prevRow != null && f !== 'skip') {
            text = out.cells[prevRow][k].text;
            fixes = ['ditto: same as above'];
          } else if (f === 'from' || f === 'to') ({ text, fixes } = fixStation(text, known));
          else if (NUMERIC[f]) ({ text, fixes } = fixNumber(text, f));
          else if (f === 'lrud') text = text.replace(/\s+/g, ' ');
        }
        rc[k].text = text;
        if (row.off || f === 'skip') return;
        if (fixes.length && text !== base.trim()) flag(k, `read “${base.trim()}” as “${text}”` + (fixes.length ? ' (' + fixes.join(', ') + ')' : ''), DOUBT);
        else if (fixes.length && /ditto|°|dash/.test(fixes.join())) flag(k, fixes.join(', '), DOUBT);
        if (!cell.edited && cell.conf != null && cell.conf < low && text) flag(k, `not sure of this reading (${Math.round(cell.conf * 100)}%)`, DOUBT);
        if (!cell.edited && cell.merged) flag(k, 'read as one word with the next cell: check where it splits', DOUBT);
      });
      if (row.off) return;
      // the shot this row makes
      const shot = {};
      const idx = {};
      cols.forEach((col, k) => {
        const f = col.field;
        if (!f || f === 'skip') return;
        const t = rc[k].text;
        if (f === 'note') { if (t) shot.note = shot.note ? shot.note + ' ' + t : t; idx.note = k; return; }
        if (f === 'lrud') {
          idx.lrud = k;
          if (!t) return;
          const parts = t.split(/[\s,;]+/).filter(Boolean);
          const four = parts.length === 4 ? parts : (parts.length === 1 && t.split('/').length === 4 ? t.split('/') : null);
          if (four) ['l', 'r', 'u', 'd'].forEach((x, i) => { if (shot[x] == null) shot[x] = fixNumber(four[i], x).text; });
          else flag(k, 'LRUD: four numbers expected', BAD);
          return;
        }
        if (shot[f] == null || shot[f] === '') { shot[f] = t; idx[f] = k; }
      });
      const has = k => String(shot[k] || '').trim() !== '';
      if (!SHOT_KEYS.some(has)) {
        if (shot.note && prev) { prev.shot.note = (prev.shot.note ? prev.shot.note + ' ' : '') + shot.note; flag(idx.note, 'joined to the notes of the row above', DOUBT); }
        return;                                             // an empty row
      }
      if (!has('from') && prev && has('to') && String(prev.shot.to || '').trim()) {
        shot.from = String(prev.shot.to).trim();
        if (idx.from != null) { rc[idx.from].text = shot.from; flag(idx.from, 'From filled in from the row above', DOUBT); }
      }
      SHOT_KEYS.forEach(k => { if (shot[k] == null) shot[k] = ''; });
      const flags = FL ? FL.shotFlags(shot, { lenUnit: unit }) : [];
      const where = msg => {
        if (/^length/.test(msg)) return ['len'];
        if (/^back azimuth/.test(msg)) return ['baz'];
        if (/^back inclination/.test(msg)) return ['binc'];
        if (/^fore\/back azimuth/.test(msg)) return ['az', 'baz'];
        if (/^fore\/back inclination/.test(msg)) return ['inc', 'binc'];
        if (/^azimuth/.test(msg)) return ['az'];
        if (/^inclination/.test(msg)) return ['inc'];
        if (/^station name/.test(msg)) return ['from', 'to'].filter(k => !has(k));
        const m = /^([LRUD]) /.exec(msg);
        return m ? [m[1].toLowerCase()] : [];
      };
      flags.forEach(msg => where(msg).forEach(f => flag(idx[f] != null ? idx[f] : idx.lrud != null && LRUD[f] ? idx.lrud : -1, msg, BAD)));
      ['len', 'az', 'inc', 'baz', 'binc', 'l', 'r', 'u', 'd'].forEach(f => {
        if (idx[f] == null || !has(f)) return;
        const p = parse(shot[f], f);
        if (p.note) flag(idx[f], p.note, DOUBT);
      });
      // To that should be the next From, read differently ("A1O" / "A10")
      if (prev && has('from') && String(prev.shot.to || '').trim() && prev.shot.to !== shot.from && canon(prev.shot.to) === canon(shot.from)) {
        flag(idx.from, `From “${shot.from}” vs To “${prev.shot.to}” above`, DOUBT);
      }
      const ok = has('from') && has('to') && parse(shot.len, 'len').v != null;
      const item = { row: ri, shot, ok, flags };
      out.shots.push(item);
      prev = item; prevRow = ri;
    });
    // A decimal point the reader lost: in a column where most numbers carry
    // one ("12.5", "8.3"), a whole number ten times the others ("125").
    cols.forEach((col, k) => {
      if (!(col.field === 'len' || LRUD[col.field])) return;
      const live = table.rows.map((r, ri) => (r.off ? null : out.cells[ri][k])).filter(c => c && /^\d+(\.\d+)?$/.test(c.text));
      if (live.length < 4) return;
      const dec = live.filter(c => /\./.test(c.text));
      if (dec.length < 0.6 * live.length) return;
      const med = median(dec.map(c => +c.text));
      live.forEach(c => {
        const v = +c.text;
        if (/\./.test(c.text) || c.text.length < 2 || v < 5 * med || v / 10 < 0.3 * med || v / 10 > 3 * med) return;
        const guess = c.text.slice(0, -1) + '.' + c.text.slice(-1);
        c.flags.push(`a decimal point missing? (${guess})`); c.level = Math.max(c.level, DOUBT);
      });
    });
    return out;
  }

  // ── Small helpers the screen uses ────────────────────────────────────────
  // Lengths (and LRUD) from one unit to another, keeping a ledge "3/5".
  function convertShot(shot, from, to) {
    if (from === to) return Object.assign({}, shot);
    const k = from === 'm' ? 1 / FT : FT;
    const cv = (t, f) => {
      const s = String(t == null ? '' : t).trim();
      if (!s) return s;
      if (LRUD[f] && /\//.test(s)) return s.split('/').map(x => (num(x) == null ? x : String(round2(+x * k)))).join('/');
      const v = parse(s, f).v;
      return v == null ? s : String(round2(v * k));
    };
    const out = Object.assign({}, shot);
    ['len', 'l', 'r', 'u', 'd'].forEach(f => { if (out[f] != null) out[f] = cv(out[f], f); });
    return out;
  }
  // Station names -> an area spec for a page tag ("T6~T12,T12a"), see FL.areaHas.
  function areaSpec(names) {
    const groups = new Map(), loose = [];
    [...new Set((names || []).map(n => String(n || '').trim()).filter(Boolean))].forEach(n => {
      const m = /^(.*?)(\d+)$/.exec(n);
      if (!m) { loose.push(n); return; }
      const g = groups.get(m[1]) || []; g.push([+m[2], m[2]]); groups.set(m[1], g);
    });
    const parts = [];
    groups.forEach((g, pre) => {
      g.sort((a, b) => a[0] - b[0]);
      const lo = g[0], hi = g[g.length - 1];
      parts.push(lo[0] === hi[0] ? pre + lo[1] : pre + lo[1] + '~' + pre + hi[1]);
    });
    return parts.concat(loose).join(',').slice(0, 300);
  }
  // An empty table to type into: the usual columns, a few rows.
  function emptyTable(opts) {
    opts = opts || {};
    const fields = opts.fields || ['from', 'to', 'len', 'az', 'inc', 'l', 'r', 'u', 'd', 'note'];
    const n = opts.rows || 6;
    return { width: 0, height: 0, skew: 0, H: 0, unit: opts.unit || null, words: [],
      columns: fields.map(f => ({ field: f, header: '', auto: false })),
      rows: Array.from({ length: n }, () => ({ kind: 'data', off: false, cells: fields.map(() => ({ raw: '', box: null, conf: null, words: [] })) })) };
  }

  const T = { FIELDS, LABEL, NUMERIC, wordsOf, estimateSkew, buildTable, headerField, fixNumber, fixStation, knownIndex,
    colStats, fieldScore, resolve, convertShot, areaSpec, emptyTable, DOUBT, BAD };
  if (typeof document === 'undefined') return T;     // under Node: the rules only

  /* ════════════════════════════ the review screen ════════════════════════ */
  // Everything below runs in the viewer page and reads its state (ffPid,
  // ffState, ffD, stationMap...) only when the user acts, after the page's
  // own script has run.
  const W = window;
  const hasOcr = () => !!(W.AndroidHost && typeof W.AndroidHost.ocrImage === 'function');
  const hasCamera = () => !!(W.AndroidHost && typeof W.AndroidHost.takePhoto === 'function');
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const toast = m => { try { showToast(m); } catch (_) { console.log(m); } };
  const pid = () => (typeof ffPid !== 'undefined' ? ffPid : null);
  const docsState = () => (typeof ffD !== 'undefined' && ffD ? ffD.docs : {});
  const surveys = () => (typeof ffState !== 'undefined' ? ffState.order.filter(id => ffState.surveys[id]).map(id => ffState.surveys[id]) : []);
  const survey = id => (id && typeof ffState !== 'undefined' ? ffState.surveys[id] || null : null);
  const today = () => new Date().toISOString().slice(0, 10);
  const FCLASS = f => (f === 'from' || f === 'to' ? 'st' : NUMERIC[f] ? 'nu' : f === 'note' ? 'nt' : f === 'lrud' ? 'lr' : 'sk');

  // ── Styles (one block, everything under #scan-review) ─────────────────────
  function css() {
    if (document.getElementById('scan-review-css')) return;
    const st = mk('style'); st.id = 'scan-review-css';
    st.textContent = `
#scan-review { display: none; position: fixed; inset: 0; z-index: 75; background: #0b0b12; color: #eee; flex-direction: column;
  font: 15px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; pointer-events: all; }
#scan-review.open { display: flex; }
body.scan-open #mode-toast { z-index: 95; bottom: 96px; font-size: 14px; }
#scan-review button { font: inherit; color: inherit; cursor: pointer; }
.sr-btn { min-height: 44px; min-width: 44px; padding: 6px 12px; border-radius: 9px; border: 1px solid rgba(255,255,255,.2);
  background: rgba(255,255,255,.07); font-size: 15px; white-space: nowrap; }
.sr-btn.on { background: rgba(33,150,243,.38); border-color: #2196F3; }
.sr-btn.primary { background: #1e88e5; border-color: #64b5f6; font-weight: 700; }
.sr-btn:disabled { opacity: .4; }
.sr-top { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: #151522; border-bottom: 1px solid rgba(255,255,255,.1); }
.sr-title { flex: 1; min-width: 0; font-weight: 700; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-title small { display: block; font-weight: 400; font-size: 13px; opacity: .65; overflow: hidden; text-overflow: ellipsis; }
.sr-seg { display: flex; }
.sr-seg .sr-btn { border-radius: 0; min-width: 48px; }
.sr-seg .sr-btn:first-child { border-radius: 9px 0 0 9px; } .sr-seg .sr-btn:last-child { border-radius: 0 9px 9px 0; border-left: none; }
.sr-x { font-size: 20px; }
.sr-banner { display: none; align-items: center; gap: 8px; padding: 6px 10px; background: rgba(255,179,0,.14); border-bottom: 1px solid rgba(255,179,0,.4); font-size: 14px; flex-wrap: wrap; }
.sr-banner.show { display: flex; }
.sr-banner span { flex: 1; min-width: 160px; }
.sr-main { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.sr-scan { flex: 0 0 40%; position: relative; overflow: hidden; background: #000; touch-action: none; }
.sr-side { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
@media (orientation: portrait) {
  #scan-review.typing .sr-scan { flex-basis: 26%; }
}
@media (orientation: landscape) {
  .sr-main { flex-direction: row; }
  .sr-scan { flex: 0 0 50%; border-right: 1px solid rgba(255,255,255,.12); }
}
.sr-sheet { position: absolute; left: 0; top: 0; transform-origin: 0 0; --bw: 1.5; }
.sr-sheet img { position: absolute; left: 0; top: 0; transform-origin: 0 0; user-select: none; -webkit-user-drag: none; pointer-events: none; max-width: none; }
.sr-box { position: absolute; border: calc(var(--bw) * 1px) solid rgba(0,229,255,.55); border-radius: calc(var(--bw) * 2px); pointer-events: none; box-sizing: border-box; }
.sr-box.f1 { border-color: rgba(255,179,0,.95); background: rgba(255,179,0,.10); }
.sr-box.f2 { border-color: rgba(255,82,82,.95); background: rgba(255,82,82,.14); }
.sr-box.row { background: rgba(0,229,255,.10); }
.sr-hl { position: absolute; display: none; pointer-events: none; box-sizing: border-box; border: calc(var(--bw) * 3px) solid #ff4081;
  background: rgba(255,64,129,.18); border-radius: calc(var(--bw) * 3px); }
.sr-scanmsg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 20px; color: #bbb; font-size: 15px; }
.sr-zoom { position: absolute; right: 8px; bottom: 8px; display: flex; gap: 6px; }
.sr-zoom .sr-btn { background: rgba(20,20,30,.85); }
.sr-info { padding: 7px 10px; min-height: 22px; font-size: 14px; background: #12121c; border-bottom: 1px solid rgba(255,255,255,.08); }
.sr-info.f1 { color: #ffd27a; } .sr-info.f2 { color: #ff9b9b; }
.sr-tools { display: flex; gap: 6px; padding: 6px 8px; overflow-x: auto; border-bottom: 1px solid rgba(255,255,255,.08); scrollbar-width: none; }
.sr-tools .sr-btn { flex: 0 0 auto; }
.sr-wrap { flex: 1; min-height: 0; overflow: auto; -webkit-overflow-scrolling: touch; scroll-padding: 60px 0 0 52px; }
.sr-wait { padding: 24px 14px; font-size: 16px; opacity: .8; }
.sr-table { border-collapse: separate; border-spacing: 0; }
.sr-table thead th { position: sticky; top: 0; z-index: 3; background: #1a1a28; padding: 4px 2px; vertical-align: top; }
.sr-table select { font-size: 15px; min-height: 44px; width: 100%; min-width: 78px; background: #222234; color: #eee;
  border: 1px solid rgba(255,255,255,.25); border-radius: 8px; padding: 0 4px; }
.sr-hdr { font-size: 13px; opacity: .6; font-weight: 400; padding: 2px 2px 0; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-table td { padding: 2px; border-bottom: 1px solid rgba(255,255,255,.05); }
.sr-table td input { width: 100%; box-sizing: border-box; height: 44px; font-size: 16px; padding: 4px 6px; border-radius: 7px;
  background: rgba(0,0,0,.4); color: #eee; border: 1px solid rgba(255,255,255,.16); font-variant-numeric: tabular-nums; }
.sr-table td.st input { min-width: 70px; } .sr-table td.nu input { min-width: 70px; } .sr-table td.nt input { min-width: 150px; }
.sr-table td.lr input { min-width: 120px; } .sr-table td.sk input { min-width: 60px; opacity: .45; }
.sr-table td.f1 input { border-color: #ffb300; background: rgba(255,179,0,.14); }
.sr-table td.f2 input { border-color: #ff5252; background: rgba(255,82,82,.17); }
.sr-table td.sel input { outline: 3px solid #ff4081; outline-offset: -1px; }
.sr-table tr.off td input { opacity: .35; text-decoration: line-through; }
.sr-rh { position: sticky; left: 0; z-index: 2; background: #151522; padding: 2px; }
.sr-table thead .sr-rh { z-index: 4; }
.sr-rb { min-width: 44px; min-height: 44px; border-radius: 8px; border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.05); font-size: 14px; }
.sr-rb.on { background: rgba(33,150,243,.45); border-color: #2196F3; }
.sr-bottom { display: flex; align-items: center; gap: 8px; padding: 8px; background: #151522; border-top: 1px solid rgba(255,255,255,.1); flex-wrap: wrap; }
.sr-bottom label { font-size: 14px; opacity: .75; }
.sr-target { flex: 1; min-width: 120px; min-height: 44px; font-size: 15px; background: #222234; color: #eee; border: 1px solid rgba(255,255,255,.25); border-radius: 8px; }
.sr-add { flex: 2; min-width: 200px; }
@media (orientation: landscape) and (max-height: 500px) {
  .sr-top, .sr-bottom { padding: 4px 6px; } .sr-tools { padding: 4px 6px; } .sr-info { padding: 4px 8px; }
  .sr-btn, .sr-rb, .sr-target, .sr-table select, .sr-table td input { min-height: 40px; height: auto; }
  .sr-table td input { height: 40px; }
}`;
    document.head.appendChild(st);
  }

  // ── The page's text, read on the phone ────────────────────────────────────
  const pending = {};
  let reqSeq = 0;
  function readPage(page) {
    return new Promise((resolve, reject) => {
      const req = 'scan' + (++reqSeq) + '.' + Date.now().toString(36);
      const timer = setTimeout(() => { delete pending[req]; reject(new Error('the reader did not answer')); }, 90000);
      pending[req] = { resolve, timer };
      try { W.AndroidHost.ocrImage(page.h + (page.ext ? '.' + page.ext : ''), JSON.stringify({ req, map: W.FF_MAP_ID || '', rot: page.rot || 0 })); }
      catch (e) { clearTimeout(timer); delete pending[req]; reject(e); }
    });
  }
  // The app calls this with the result (AndroidHost.ocrImage -> ScanOcr.kt).
  W.ffOcrDone = function (ctxJson, resJson) {
    let ctx = {}, res = null;
    try { ctx = JSON.parse(ctxJson || '{}'); } catch (_) {}
    try { res = JSON.parse(resJson || 'null'); } catch (_) {}
    const p = pending[ctx.req];
    if (!p) return;
    clearTimeout(p.timer); delete pending[ctx.req];
    p.resolve(res);
  };

  // ── Opening: from the field-survey panel, a document page, a photo ───────
  let S = null;                 // the open review
  async function start(opts) {
    opts = opts || {};
    if (!pid()) { toast('No project for this map yet: ⋯ More → Project & sync'); return; }
    try { await ffEnsureAuthor(); } catch (_) {}
    const pages = pageDocs();
    const choices = [];
    if (hasCamera()) choices.push({ label: '📷 Photograph a page', value: 'photo', sub: 'The camera app takes it; the page is kept as a Shot table document', primary: true });
    if (pages.length) choices.push({ label: '📄 A page from Documents', value: 'doc', sub: pages.length + ' document' + (pages.length === 1 ? '' : 's') + ' with pages' });
    choices.push({ label: '🖼 A photo or scan from a file', value: 'file' });
    choices.push({ label: '⌨ No page: type the shots in', value: 'none' });
    const how = hasOcr() ? 'The phone reads the page (offline), then you check the table beside it.'
      : 'This device cannot read handwriting (FLEX Field on the phone does): the page is shown beside an empty table to type into.';
    const r = await ffChoose('Import shots from scan', how, choices);
    if (!r) return;
    if (r === 'none') return open({ page: null, sid: opts.sid });
    if (r === 'photo') return photo(opts);
    if (r === 'file') return pickFile(opts);
    const d = await pickDoc(pages);
    if (!d) return;
    const i = d.pages.length > 1 ? await pickPage(d) : 0;
    if (i == null) return;
    openFromDoc(d.id, i, opts);
  }
  // Documents with image pages, shot tables first.
  function pageDocs() {
    let list = [];
    try { list = FL.docsOf(ffD, ffP); } catch (_) { list = Object.values(docsState()); }
    return list.filter(d => d && (d.pages || []).some(p => p.ext !== 'pdf'))
      .sort((a, b) => (b.kind === 'shot-table') - (a.kind === 'shot-table') || String(b.date || '').localeCompare(String(a.date || '')));
  }
  async function pickDoc(list) {
    const v = await ffChoose('Which document?', null, list.slice(0, 40).map(d => ({ label: '📄 ' + (d.title || 'Untitled'), value: d.id,
      sub: `${d.pages.length} page${d.pages.length === 1 ? '' : 's'}${d.kind ? ' · ' + (FL.DOC_KIND_LABELS[d.kind] || d.kind) : ''}${d.date ? ' · ' + d.date : ''}` })));
    return v ? docsState()[v] : null;
  }
  async function pickPage(d) {
    const v = await ffChoose(d.title || 'Which page?', 'Which page holds the shots?', d.pages.map((p, i) => ({ label: `Page ${i + 1}${p.name ? ' · ' + p.name : ''}`, value: String(i) })).filter((o, i) => d.pages[i].ext !== 'pdf'));
    return v == null ? null : +v;
  }
  function openFromDoc(docId, index, opts) {
    const d = docsState()[docId];
    const pg = d && d.pages[index || 0];
    if (!pg) { toast('That page is not here'); return; }
    if (pg.ext === 'pdf') { toast('A PDF page can\'t be shown here: add it as images (FLEX Field turns PDFs into pages)'); return; }
    open(Object.assign({}, opts || {}, { page: { doc: docId, index: index || 0, h: pg.h, ext: pg.ext || 'jpg', rot: pg.rot || 0, name: pg.name || '', title: d.title || '' } }));
  }
  // A file: through the viewer's own page picker (the phone stores it as a
  // page, a browser too), which makes a Shot table document of it.
  let picking = null;
  async function pickFile(opts) {
    const req = 'scan' + Date.now().toString(36);
    const sv = survey(opts.sid);
    const tags = [FL.T.project(pid())];
    const cid = sv && typeof ffCaveId === 'function' ? ffCaveId(sv.cave || '') : null;
    if (cid && cid !== sv.cave) tags.push(FL.T.cave(cid));
    picking = { req, opts };
    if (!W.ffPagesPicked || !W.ffPagesPicked._scan) {
      const orig = W.ffPagesPicked;
      const wrapped = async function (ctxJson, resJson) {
        let ctx = {};
        try { ctx = JSON.parse(ctxJson || '{}'); } catch (_) {}
        const before = new Set((typeof ffEntries !== 'undefined' ? ffEntries.docs : []).map(e => e.id));
        await orig(ctxJson, resJson);
        if (!ctx.scan || !picking || ctx.scan !== picking.req) return;
        const o = picking.opts; picking = null;
        const added = (typeof ffEntries !== 'undefined' ? ffEntries.docs : []).filter(e => !before.has(e.id) && e.op === 'doc.add');
        const e = added[added.length - 1];
        if (e) openFromDoc(e.doc, 0, o);
      };
      wrapped._scan = true;
      W.ffPagesPicked = wrapped;
    }
    try { await ffHost.pickPages({ scan: req, kind: 'shot-table', open: false, tags, title: 'Shot table ' + today() }); }
    catch (e) { picking = null; toast('Could not open the file picker'); }
  }
  // A photo: the app hands the shot to the camera app and keeps it as a page.
  function photo(opts) {
    try { W.AndroidHost.takePhoto(JSON.stringify({ scan: 1, sid: opts.sid || null })); }
    catch (e) { toast('Could not start the camera'); }
  }
  // The app says a photo is stored (or the camera came back empty). Also asked
  // once after the page loads: the app may have been closed while the camera
  // was in front.
  W.ffPhotoReady = function () {
    let o = null;
    try { o = JSON.parse((W.AndroidHost && W.AndroidHost.photoResult && W.AndroidHost.photoResult()) || 'null'); } catch (_) {}
    if (!o) return;
    let ctx = {}, res = o.res || {};
    try { ctx = JSON.parse(o.ctx || '{}'); } catch (_) {}
    if (res.error) { toast(res.error); return; }
    const pg = (res.pages || [])[0];
    if (!pg) { if (!res.cancelled) toast((res.failed || []).length ? 'Could not read the photo' : 'No photo'); return; }
    if (ctx.inv && W.ViewerInv) { W.ViewerInv.pagesPicked(ctx, [pg]); return; }      // a photo for an inventory entry (libs/viewer-inventory.js)
    const sv = survey(ctx.sid);
    const tags = [FL.T.project(pid())];
    const cid = sv && typeof ffCaveId === 'function' ? ffCaveId(sv.cave || '') : null;
    if (cid && cid !== sv.cave) tags.push(FL.T.cave(cid));
    const id = ffUid();
    ffRecord('doc.add', { doc: id, title: 'Shot table ' + today(), kind: 'shot-table', date: today(), pages: [pg], tags }, null, 'docs');
    openFromDoc(id, 0, { sid: ctx.sid || null });
  };
  if (hasCamera()) {
    let tries = 0;
    const look = () => { if (typeof ffReady !== 'undefined' && ffReady) W.ffPhotoReady(); else if (++tries < 40) setTimeout(look, 1500); };
    W.addEventListener('load', () => setTimeout(look, 1500));
  }

  // ── The screen ────────────────────────────────────────────────────────────
  let R = null;                 // the screen's elements
  function frame() {
    css();
    let root = document.getElementById('scan-review');
    if (root) return R;
    root = mk('div'); root.id = 'scan-review';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Import shots from scan');
    R = { root };
    const top = mk('div', 'sr-top');
    R.title = mk('div', 'sr-title');
    R.turn = mk('button', 'sr-btn', '⟳'); R.turn.title = 'Turn the page a quarter (and read it again)';
    const seg = mk('div', 'sr-seg');
    R.ft = mk('button', 'sr-btn', 'ft'); R.m = mk('button', 'sr-btn', 'm');
    R.ft.title = 'Lengths and LRUD in feet'; R.m.title = 'Lengths and LRUD in metres';
    seg.append(R.ft, R.m);
    R.x = mk('button', 'sr-btn sr-x', '✕'); R.x.title = 'Close (the table is kept for this page)';
    top.append(R.title, R.turn, seg, R.x);
    R.banner = mk('div', 'sr-banner');
    const main = mk('div', 'sr-main');
    R.scan = mk('div', 'sr-scan');
    R.sheet = mk('div', 'sr-sheet');
    R.boxes = mk('div'); R.hl = mk('div', 'sr-hl');
    R.sheet.append(R.boxes, R.hl);
    R.msg = mk('div', 'sr-scanmsg');
    const zoom = mk('div', 'sr-zoom');
    R.fit = mk('button', 'sr-btn', '⤢'); R.fit.title = 'Whole page';
    zoom.append(R.fit);
    R.scan.append(R.sheet, R.msg, zoom);
    const side = mk('div', 'sr-side');
    R.info = mk('div', 'sr-info');
    const tools = mk('div', 'sr-tools');
    R.addRow = mk('button', 'sr-btn', '＋ Row'); R.addCol = mk('button', 'sr-btn', '＋ Column');
    R.skip = mk('button', 'sr-btn', '⊘ Skip'); R.merge = mk('button', 'sr-btn', '⇅ Merge'); R.del = mk('button', 'sr-btn', '🗑 Delete');
    R.skip.title = 'Leave the picked rows out (or use them again)'; R.merge.title = 'Join the picked rows into one'; R.del.title = 'Delete the picked rows';
    R.addRow.title = 'A new row under the picked cell'; R.addCol.title = 'Another column (Back az, Back incl., Notes…)';
    R.again = mk('button', 'sr-btn', '↻ Read again');
    tools.append(R.addRow, R.skip, R.merge, R.del, R.addCol, R.again);
    R.wrap = mk('div', 'sr-wrap');
    side.append(R.info, tools, R.wrap);
    main.append(R.scan, side);
    const bottom = mk('div', 'sr-bottom');
    const lab = mk('label', null, 'Add to'); R.target = mk('select', 'sr-target'); lab.htmlFor = R.target.id = 'sr-target';
    R.add = mk('button', 'sr-btn primary sr-add', 'Add shots');
    bottom.append(lab, R.target, R.add);
    root.append(top, R.banner, main, bottom);
    document.body.appendChild(root);
    R.x.addEventListener('click', () => close());
    R.ft.addEventListener('click', () => setUnit('ft'));
    R.m.addEventListener('click', () => setUnit('m'));
    R.turn.addEventListener('click', turn);
    R.fit.addEventListener('click', () => { fit(); xf(); });
    R.addRow.addEventListener('click', addRow);
    R.addCol.addEventListener('click', addCol);
    R.skip.addEventListener('click', skipRows);
    R.merge.addEventListener('click', mergeRows);
    R.del.addEventListener('click', deleteRows);
    R.again.addEventListener('click', () => readAgain());
    R.target.addEventListener('change', () => { S.sid = R.target.value === 'new' ? null : R.target.value; S.known = knownStations(S.sid); refresh(); });
    R.add.addEventListener('click', addShots);
    gestures(R.scan);
    W.addEventListener('resize', () => {           // the keyboard opening keeps the zoom; a page at full view refits
      if (!S || !S.img) return;
      const atFit = Math.abs(S.z - S.fz) < 1e-6, z = S.z, x = S.x, y = S.y;
      fit();
      if (!atFit) { S.z = z; S.x = x; S.y = y; }
      xf();
    });
    W.addEventListener('popstate', () => { if (S && S.pushed) { S.pushed = false; close(); } });
    return R;
  }

  async function open(opts) {
    const keep = !!(S && S.pushed);
    if (S) close(true);
    frame();
    const sid = opts.sid && survey(opts.sid) ? opts.sid : (typeof ffPanelSurvey !== 'undefined' && ffPanelOpen && !ffDocsOpen && survey(ffPanelSurvey) ? ffPanelSurvey : null);
    S = { page: opts.page || null, sid, unit: (survey(sid) && survey(sid).lenUnit) || 'ft', table: null, sel: null, rowSel: new Set(),
      z: 1, x: 0, y: 0, img: null, reading: false, dirty: false, pushed: false };
    S.known = knownStations(sid);
    R.root.classList.add('open');
    R.root.classList.remove('typing');
    document.body.classList.add('scan-open');
    if (keep) S.pushed = true;
    else { try { history.pushState({ flexScan: 1 }, ''); S.pushed = true; } catch (_) {} }
    R.title.textContent = '';
    R.title.append(document.createTextNode('Import shots from scan'));
    R.title.appendChild(mk('small', null, S.page ? [S.page.title, S.page.name || (S.page.doc ? 'page ' + (S.page.index + 1) : '')].filter(Boolean).join(' · ') : 'no page: type the shots'));
    R.boxes.textContent = ''; R.hl.style.display = 'none'; R.msg.textContent = '';
    R.sheet.querySelectorAll('img').forEach(i => i.remove());
    R.turn.style.display = S.page ? '' : 'none';
    banner(null);
    renderTargets();
    const me = S;
    if (S.page) await loadImage();
    else R.msg.textContent = 'No page. Type the shots into the table.';
    if (S !== me) return;                                  // closed while the page loaded
    const d = loadDraft();
    if (d) {
      S.table = d.table; S.unit = d.unit || S.unit; S.dirty = true;
      banner(`Your unsaved table from ${new Date(d.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} is back.`, [
        hasOcr() && S.page ? ['↻ Read the page again', () => readAgain(true)] : null, ['Start over', () => { dropDraft(); S.table = blankTable(); S.dirty = false; banner(null); render(); }]].filter(Boolean));
      render();
    } else if (S.page && hasOcr()) await read();
    else {
      S.table = blankTable();
      render();
      info(S.page ? 'This device can\'t read the page: type the shots beside it. (FLEX Field reads pages on the phone.)' : 'Type the shots; ＋ Row adds more.');
    }
  }
  function close(quiet) {
    if (!S) return;
    if (S.dirty) saveDraft(true);
    const pushed = S.pushed;
    S = null;
    if (R) R.root.classList.remove('open');
    document.body.classList.remove('scan-open');
    if (pushed && !quiet) { try { if (history.state && history.state.flexScan) history.back(); } catch (_) {} }
    if (!quiet && R) R.wrap.textContent = '';
  }
  function banner(text, actions) {
    R.banner.textContent = '';
    R.banner.classList.toggle('show', !!text);
    if (!text) return;
    R.banner.appendChild(mk('span', null, text));
    (actions || []).forEach(([label, fn]) => { const b = mk('button', 'sr-btn', label); b.addEventListener('click', fn); R.banner.appendChild(b); });
  }
  function info(text, lvl) { R.info.textContent = text || ''; R.info.className = 'sr-info' + (lvl ? ' f' + lvl : ''); }

  // An empty table with the target survey's columns (backsights if it has them),
  // the first From filled in where the survey ends.
  function blankTable() {
    const sv = survey(S.sid);
    const back = sv && sv.shots.some(s => String(s.baz || '').trim() || String(s.binc || '').trim());
    const t = T.emptyTable({ unit: S.unit, rows: 6, fields: back ? ['from', 'to', 'len', 'az', 'baz', 'inc', 'binc', 'l', 'r', 'u', 'd', 'note'] : null });
    if (sv) { const last = sv.shots[sv.shots.length - 1]; const c = t.rows[0].cells[0]; c.edited = true; c.text = String(last ? last.to : sv.tie || ''); }
    return t;
  }
  function knownStations(sid) {
    const sv = survey(sid), cave = sv ? (sv.cave || '') : null, out = new Set();
    try { stationMap.forEach(st => { if (st && st.name && (cave == null || (st.cave || '') === cave)) out.add(String(st.name)); }); } catch (_) {}
    surveys().forEach(s => { if (cave == null || (s.cave || '') === cave) s.shots.forEach(sh => { out.add(String(sh.from || '').trim()); out.add(String(sh.to || '').trim()); }); });
    out.delete('');
    return [...out];
  }

  // ── Reading ───────────────────────────────────────────────────────────────
  async function read() {
    const me = S;
    S.reading = true; S.table = null;
    info('Reading the page… (a few seconds)');
    render();
    let res = null, err = null;
    try { res = await readPage(S.page); } catch (e) { err = e; }
    if (S !== me) return;                                  // closed meanwhile
    S.reading = false;
    if (!err && (!res || res.ok === false)) err = new Error((res && res.error) || 'nothing came back');
    if (err) {
      S.table = blankTable();
      render();
      info('Could not read the page (' + err.message + '): type the shots beside it.', 2);
      return;
    }
    S.table = T.buildTable(res, { unit: S.unit });
    if (S.table.unit) S.unit = S.table.unit;
    const rows = S.table.rows.filter(r => !r.off).length;
    if (!rows) {
      S.table = blankTable();
      render();
      info('No table found on this page: type the shots beside it, or ⟳ turn the page if it is sideways.', 1);
      return;
    }
    render();
    const R2 = T.resolve(S.table, { unit: S.unit, known: S.known });
    const n1 = R2.cells.reduce((a, r) => a + r.filter(c => c.level >= 1).length, 0);
    info(`Read ${R2.shots.length} row${R2.shots.length === 1 ? '' : 's'}. ${n1 ? n1 + ' cell' + (n1 === 1 ? '' : 's') + ' to check (marked). ' : ''}Tap a cell to see it on the page; tap the page to find its cell.`, n1 ? 1 : 0);
  }
  async function readAgain(force) {
    if (!S || !S.page || !hasOcr()) { toast('This device can\'t read pages'); return; }
    if (S.dirty && !force) {
      const r = await ffDialog({ title: 'Read the page again?', text: 'Your changes to the table are lost.', buttons: [{ label: 'Cancel', value: null }, { label: 'Read again', value: 'ok', primary: true }] });
      if (!r) return;
    }
    dropDraft(); S.dirty = false; banner(null);
    await read();
  }
  async function turn() {
    if (!S || !S.page) return;
    if (S.dirty && hasOcr()) {
      const r = await ffDialog({ title: 'Turn the page?', text: 'It is read again, and your changes to the table are lost.', buttons: [{ label: 'Cancel', value: null }, { label: 'Turn', value: 'ok', primary: true }] });
      if (!r) return;
    }
    const prev = S.page.rot || 0, rot = (prev + 90) % 360;
    S.page.rot = rot;
    const d = S.page.doc && docsState()[S.page.doc];
    if (d && d.pages[S.page.index] && d.pages[S.page.index].h === S.page.h) { try { ffRecord('doc.rotate', { doc: d.id, h: S.page.h, rot, prev }, null, 'docs'); } catch (_) {} }
    if (S.img) { layoutSheet(); fit(); xf(); }
    if (hasOcr()) { dropDraft(); S.dirty = false; banner(null); await read(); }
    else drawBoxes();
  }

  // ── The scan: image, boxes, pinch / pan / tap ─────────────────────────────
  async function loadImage() {
    const me = S, pg = S.page;
    let url = null;
    try { url = await ffBlobUrl(pg.h, pg.ext); } catch (_) {}
    if (S !== me) return;
    if (!url) { R.msg.textContent = 'The page image is not on this device.'; return; }
    const img = new Image();
    img.alt = 'Scanned page';
    R.sheet.insertBefore(img, R.boxes);
    await new Promise(res => { img.onload = res; img.onerror = res; img.src = url; });
    if (S !== me) { img.remove(); return; }
    if (!img.naturalWidth) { img.remove(); R.msg.textContent = 'Could not show the page.'; return; }
    S.img = img;
    layoutSheet(); fit(); xf();
  }
  function layoutSheet() {
    const iw = S.img.naturalWidth, ih = S.img.naturalHeight, r = ((S.page.rot || 0) % 360 + 360) % 360;
    S.sw = r % 180 ? ih : iw; S.sh = r % 180 ? iw : ih;
    R.sheet.style.width = S.sw + 'px'; R.sheet.style.height = S.sh + 'px';
    S.img.style.width = iw + 'px'; S.img.style.height = ih + 'px';
    S.img.style.transform = r === 90 ? `translate(${ih}px,0) rotate(90deg)` : r === 180 ? `translate(${iw}px,${ih}px) rotate(180deg)` : r === 270 ? `translate(0,${iw}px) rotate(270deg)` : '';
  }
  function fit() {
    if (!S || !S.sw) return;
    const w = R.scan.clientWidth || 1, h = R.scan.clientHeight || 1;
    S.z = S.fz = Math.min(w / S.sw, h / S.sh);
    S.x = (w - S.sw * S.z) / 2; S.y = (h - S.sh * S.z) / 2;
  }
  function xf() {
    if (!S) return;
    R.sheet.style.transform = `translate(${S.x}px, ${S.y}px) scale(${S.z})`;
    R.sheet.style.setProperty('--bw', (1.5 / S.z).toFixed(3));
  }
  // OCR pixels -> sheet pixels
  const kx = () => (S.table && S.table.width && S.sw ? S.sw / S.table.width : 1);
  const ky = () => (S.table && S.table.height && S.sh ? S.sh / S.table.height : 1);
  const place = (n, b) => { const x = kx(), y = ky(); n.style.left = b[0] * x + 'px'; n.style.top = b[1] * y + 'px'; n.style.width = Math.max(2, (b[2] - b[0]) * x) + 'px'; n.style.height = Math.max(2, (b[3] - b[1]) * y) + 'px'; };
  function drawBoxes() {
    R.boxes.textContent = '';
    R.hl.style.display = 'none';
    S.wordCell = new Map();
    if (!S.table || !S.sw) return;
    S.table.rows.forEach((r, ri) => r.cells.forEach((c, k) => (c.words || []).forEach(wi => S.wordCell.set(wi, [ri, k]))));
    const lv = S.res ? S.res.cells : [];
    (S.table.words || []).forEach((w, i) => {
      const b = mk('div', 'sr-box');
      const rc = S.wordCell.get(i);
      const l = rc && lv[rc[0]] && lv[rc[0]][rc[1]] ? lv[rc[0]][rc[1]].level : 0;
      if (l) b.classList.add('f' + l);
      place(b, w.box);
      R.boxes.appendChild(b);
    });
  }
  // A cell's place on the page: its words, else where its row and column cross.
  function cellBox(ri, k) {
    const t = S.table, c = t.rows[ri] && t.rows[ri].cells[k];
    if (c && c.box) return c.box;
    let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
    (t.rows[ri] ? t.rows[ri].cells : []).forEach(cc => { if (cc.box) { y0 = Math.min(y0, cc.box[1]); y1 = Math.max(y1, cc.box[3]); } });
    t.rows.forEach(r => { const cc = r.cells[k]; if (cc && cc.box) { x0 = Math.min(x0, cc.box[0]); x1 = Math.max(x1, cc.box[2]); } });
    return isFinite(y0) && isFinite(x0) ? [x0, y0, x1, y1] : null;
  }
  function focusBox(b) {
    const w = R.scan.clientWidth, h = R.scan.clientHeight;
    const bx0 = b[0] * kx(), by0 = b[1] * ky(), bx1 = b[2] * kx(), by1 = b[3] * ky();
    const bh = Math.max(1, by1 - by0);
    let z = S.z;
    if (bh * z < 26) z = Math.min(S.fz * 12, 34 / bh);
    const sx0 = S.x + bx0 * z, sx1 = S.x + bx1 * z, sy0 = S.y + by0 * z, sy1 = S.y + by1 * z;
    const pad = 24;
    if (z !== S.z || sx0 < pad || sx1 > w - pad || sy0 < pad || sy1 > h - pad) {
      S.z = z;
      S.x = w / 2 - (bx0 + bx1) / 2 * z;
      S.y = h / 2 - (by0 + by1) / 2 * z;
      xf();
    }
  }
  function gestures(stage) {
    const pts = new Map();
    let base = null, moved = false, t0 = 0, lastTap = 0;
    const snap = () => { const a = [...pts.values()]; return a.length >= 2
      ? { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y), cx: (a[0].x + a[1].x) / 2, cy: (a[0].y + a[1].y) / 2 } : { d: 0, cx: a[0].x, cy: a[0].y }; };
    const rebase = () => { const s = snap(); base = { ...s, z: S.z, x: S.x, y: S.y }; };
    const local = e => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    stage.addEventListener('pointerdown', e => {
      if (!S || !S.sw || e.target.closest('.sr-zoom')) return;
      try { stage.setPointerCapture(e.pointerId); } catch (_) {}
      pts.set(e.pointerId, local(e));
      if (pts.size === 1) { moved = false; t0 = Date.now(); }
      rebase();
    });
    stage.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId) || !S) return;
      const p = local(e), q = pts.get(e.pointerId);
      if (Math.hypot(p.x - q.x, p.y - q.y) > 0 && pts.size === 1 && Math.hypot(p.x - base.cx, p.y - base.cy) > 8) moved = true;
      pts.set(e.pointerId, p);
      const s = snap();
      if (pts.size >= 2 && base.d > 0) {
        moved = true;
        const z = Math.max(S.fz * 0.5, Math.min(S.fz * 14, base.z * s.d / base.d)), k = z / base.z;
        S.z = z; S.x = s.cx - (base.cx - base.x) * k; S.y = s.cy - (base.cy - base.y) * k;
      } else if (moved) { S.x = base.x + (s.cx - base.cx); S.y = base.y + (s.cy - base.cy); }
      xf();
    });
    const end = e => {
      if (!pts.has(e.pointerId)) return;
      const p = local(e);
      pts.delete(e.pointerId);
      if (!pts.size && !moved && Date.now() - t0 < 500 && S) {
        const now = Date.now();
        if (now - lastTap < 300) { zoomAt(p.x, p.y, S.z > S.fz * 1.5 ? S.fz / S.z : 2.5); lastTap = 0; return; }
        lastTap = now;
        tapAt(p.x, p.y);
      }
      if (pts.size) rebase();
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('wheel', e => {
      if (!S || !S.sw) return;
      e.preventDefault();
      const p = local(e);
      zoomAt(p.x, p.y, e.deltaY < 0 ? 1.18 : 1 / 1.18);
    }, { passive: false });
  }
  function zoomAt(px, py, f) {
    const z = Math.max(S.fz * 0.5, Math.min(S.fz * 14, S.z * f)), k = z / S.z;
    S.x = px - (px - S.x) * k; S.y = py - (py - S.y) * k; S.z = z;
    xf();
  }
  // A tap on the page: the word under the finger (or the nearest within a
  // finger's width) -> its cell.
  function tapAt(px, py) {
    if (!S.table || !S.table.words) return;
    const sx = (px - S.x) / S.z / kx(), sy = (py - S.y) / S.z / ky();
    const reach = 22 / S.z / Math.min(kx(), ky());
    let best = -1, bd = Infinity;
    S.table.words.forEach((w, i) => {
      const b = w.box;
      const dx = sx < b[0] ? b[0] - sx : sx > b[2] ? sx - b[2] : 0, dy = sy < b[1] ? b[1] - sy : sy > b[3] ? sy - b[3] : 0;
      const d = Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = i; }
    });
    if (best < 0 || bd > reach) return;
    const rc = S.wordCell && S.wordCell.get(best);
    if (rc) { select(rc[0], rc[1], true); return; }
    place(R.hl, S.table.words[best].box); R.hl.style.display = 'block';
    info(`“${S.table.words[best].text}”: not in the table (a title or a row left out).`);
  }

  // ── The table ─────────────────────────────────────────────────────────────
  function render() {
    if (!S) return;
    R.ft.classList.toggle('on', S.unit === 'ft'); R.m.classList.toggle('on', S.unit === 'm');
    const ocr = hasOcr() && !!S.page;
    R.again.style.display = ocr ? '' : 'none';
    R.wrap.textContent = '';
    [R.addRow, R.addCol, R.skip, R.merge, R.del].forEach(b => { b.disabled = S.reading; });
    if (S.reading || !S.table) {
      R.wrap.appendChild(mk('div', 'sr-wait', S.reading ? 'Reading the page… (a few seconds)' : ''));
      R.add.disabled = true;
      return;
    }
    S.res = T.resolve(S.table, { unit: S.unit, known: S.known });
    const tbl = mk('table', 'sr-table');
    const head = mk('thead'), hr = mk('tr');
    hr.appendChild(mk('th', 'sr-rh'));
    S.table.columns.forEach((col, k) => {
      const th = mk('th');
      const sel = mk('select');
      sel.setAttribute('aria-label', 'Column ' + (k + 1) + ' is');
      FIELDS.forEach(f => { const o = mk('option', null, LABEL[f]); o.value = f; sel.appendChild(o); });
      sel.value = col.field || 'skip';
      sel.addEventListener('change', () => { col.field = sel.value; col.auto = false; changed(true); });
      th.appendChild(sel);
      if (col.header) th.appendChild(mk('div', 'sr-hdr', col.header));
      hr.appendChild(th);
    });
    head.appendChild(hr); tbl.appendChild(head);
    const body = mk('tbody');
    let n = 0;
    S.table.rows.forEach((row, ri) => {
      const tr = mk('tr'); tr.dataset.r = ri;
      if (row.off) tr.classList.add('off');
      const th = mk('th', 'sr-rh');
      const rb = mk('button', 'sr-rb' + (S.rowSel.has(ri) ? ' on' : ''), row.off ? (row.kind === 'header' ? 'H' : '⊘') : String(++n));
      rb.title = row.off ? (row.kind === 'header' ? 'Header row (left out)' : 'Left out') : 'Select this row';
      rb.setAttribute('aria-pressed', S.rowSel.has(ri) ? 'true' : 'false');
      rb.addEventListener('click', () => { if (S.rowSel.has(ri)) S.rowSel.delete(ri); else S.rowSel.add(ri); rb.classList.toggle('on', S.rowSel.has(ri)); rb.setAttribute('aria-pressed', S.rowSel.has(ri) ? 'true' : 'false'); markRows(); });
      th.appendChild(rb); tr.appendChild(th);
      S.table.columns.forEach((col, k) => {
        const f = col.field || 'skip', rc = S.res.cells[ri][k];
        const td = mk('td', FCLASS(f) + (rc.level ? ' f' + rc.level : ''));
        const inp = mk('input');
        inp.value = rc.text; inp.inputMode = NUMERIC[f] ? 'decimal' : 'text';
        inp.autocomplete = 'off'; inp.spellcheck = false; inp.setAttribute('autocapitalize', f === 'from' || f === 'to' ? 'characters' : 'off');
        inp.enterKeyHint = 'next';
        inp.dataset.r = ri; inp.dataset.c = k;
        inp.setAttribute('aria-label', `Row ${ri + 1}, ${LABEL[f]}`);
        inp.addEventListener('focus', () => { typing(true); select(ri, k, false); });
        inp.addEventListener('blur', () => setTimeout(() => { if (!R.wrap.contains(document.activeElement)) typing(false); }, 150));
        inp.addEventListener('input', () => { const c = row.cells[k]; c.edited = true; c.text = inp.value; S.dirty = true; soon(); });
        inp.addEventListener('keydown', e => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const all = [...R.wrap.querySelectorAll('td input')], i = all.indexOf(inp);
          if (all[i + 1]) all[i + 1].focus(); else addRow();
        });
        td.appendChild(inp); tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    tbl.appendChild(body);
    R.wrap.appendChild(tbl);
    drawBoxes();
    markRows();
    if (S.sel) select(S.sel.r, S.sel.c, null);
    counts();
  }
  // While typing in portrait the page shrinks, so the cell stays above the
  // keyboard (the app's full-screen WebView is not always resized for it).
  function typing(on) {
    if (!S || R.root.classList.contains('typing') === on) return;
    R.root.classList.toggle('typing', on);
    if (on) { void R.scan.clientHeight; const a = document.activeElement; if (a && a.tagName === 'INPUT') setTimeout(() => a.scrollIntoView({ block: 'nearest', inline: 'nearest' }), 50); }
  }
  // After typing: flags and the other cells follow (a ditto, a From filled in)
  let soonT = 0;
  function soon() { clearTimeout(soonT); soonT = setTimeout(() => refresh(), 180); }
  function refresh() {
    if (!S || !S.table) return;
    S.res = T.resolve(S.table, { unit: S.unit, known: S.known });
    R.wrap.querySelectorAll('td input').forEach(inp => {
      const ri = +inp.dataset.r, k = +inp.dataset.c, rc = S.res.cells[ri] && S.res.cells[ri][k];
      if (!rc) return;
      if (document.activeElement !== inp && inp.value !== rc.text) inp.value = rc.text;
      const td = inp.parentNode;
      td.classList.toggle('f1', rc.level === 1); td.classList.toggle('f2', rc.level === 2);
    });
    drawBoxes();
    markRows();
    if (S.sel) select(S.sel.r, S.sel.c, null);
    counts();
    saveDraft();
  }
  function changed(full) { S.dirty = true; if (full) render(); else refresh(); saveDraft(); }
  // Rows picked by their number: their words light up on the page.
  function markRows() {
    R.boxes.querySelectorAll('.row').forEach(b => b.classList.remove('row'));
    S.rowSel.forEach(ri => (S.table.rows[ri] ? S.table.rows[ri].cells : []).forEach(c => (c.words || []).forEach(wi => { const b = R.boxes.children[wi]; if (b) b.classList.add('row'); })));
  }
  // A cell picked (from the table: show its place on the page; from the page:
  // bring the cell into view, without opening the keyboard).
  function select(ri, k, fromScan) {
    if (!S || !S.table || !S.table.rows[ri]) return;
    S.sel = { r: ri, c: k };
    R.wrap.querySelectorAll('td.sel').forEach(td => td.classList.remove('sel'));
    const inp = R.wrap.querySelector(`td input[data-r="${ri}"][data-c="${k}"]`);
    if (inp) inp.parentNode.classList.add('sel');
    const b = S.sw ? cellBox(ri, k) : null;
    if (b) { place(R.hl, b); R.hl.style.display = 'block'; if (fromScan === false) focusBox(b); }
    else R.hl.style.display = 'none';
    if (fromScan && inp) inp.parentNode.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const col = S.table.columns[k], rc = S.res && S.res.cells[ri] && S.res.cells[ri][k], cell = S.table.rows[ri].cells[k];
    const row = S.table.rows[ri];
    const label = `Row ${S.table.rows.slice(0, ri + 1).filter(r => !r.off).length || '—'} · ${LABEL[col.field || 'skip']}`;
    if (row.off) info(`${label}: this row is left out (${row.kind === 'header' ? 'a header' : 'not a shot'}). ⊘ to use it.`);
    else if (rc && rc.flags.length) info(`${label}: ${rc.flags.join(' · ')}`, rc.level);
    else if (cell && cell.raw && !cell.edited && rc && cell.raw.trim() !== rc.text) info(`${label}: read “${cell.raw}”`);
    else info(label + (cell && cell.conf != null ? ` · read with ${Math.round(cell.conf * 100)}% confidence` : ''));
  }
  function counts() {
    const shots = S.res ? S.res.shots.filter(x => x.ok) : [];
    const sv = survey(S.sid);
    const n = shots.length;
    R.add.disabled = !n;
    R.add.textContent = n ? `Add ${n} shot${n === 1 ? '' : 's'} to ${sv ? '“' + sv.name + '”' : 'a new survey'}` : 'Add shots (each needs From, To, Length)';
  }
  function renderTargets() {
    R.target.textContent = '';
    surveys().forEach(sv => { const o = mk('option', null, `📐 ${sv.name} (${sv.shots.length})`); o.value = sv.id; R.target.appendChild(o); });
    const o = mk('option', null, '＋ New survey…'); o.value = 'new'; R.target.appendChild(o);
    R.target.value = S.sid || 'new';
  }
  function setUnit(u) { if (!S || S.unit === u) return; S.unit = u; if (S.table) S.table.unit = u; changed(true); }

  // ── Rows and columns ──────────────────────────────────────────────────────
  const blankCell = () => ({ raw: '', box: null, conf: null, words: [] });
  const picked = () => { const a = [...S.rowSel].sort((x, y) => x - y); if (!a.length && S.sel) a.push(S.sel.r); return a; };
  function addRow() {
    if (!S.table) return;
    const at = S.sel ? S.sel.r + 1 : S.table.rows.length;
    S.table.rows.splice(at, 0, { kind: 'data', off: false, cells: S.table.columns.map(blankCell) });
    S.rowSel = new Set([...S.rowSel].map(r => (r >= at ? r + 1 : r)));
    S.sel = { r: at, c: 0 };
    changed(true);
    const inp = R.wrap.querySelector(`td input[data-r="${at}"][data-c="0"]`);
    if (inp) { inp.parentNode.scrollIntoView({ block: 'nearest' }); inp.focus(); }
  }
  function addCol() {
    if (!S.table) return;
    const used = new Set(S.table.columns.map(c => c.field));
    const f = ['baz', 'binc', 'note', 'l', 'r', 'u', 'd'].find(x => !used.has(x)) || 'skip';
    S.table.columns.push({ field: f, header: '', auto: false });
    S.table.rows.forEach(r => r.cells.push(blankCell()));
    changed(true);
    R.wrap.scrollLeft = R.wrap.scrollWidth;
  }
  function skipRows() {
    const a = picked();
    if (!a.length) { toast('Tap a row number first'); return; }
    const off = !a.every(i => S.table.rows[i].off);
    a.forEach(i => { S.table.rows[i].off = off; if (!off) S.table.rows[i].kind = 'data'; });
    S.rowSel.clear();
    changed(true);
  }
  function mergeRows() {
    const a = [...S.rowSel].sort((x, y) => x - y);
    if (a.length < 2) { toast('Tap two or more row numbers, then Merge'); return; }
    const res = S.res || T.resolve(S.table, { unit: S.unit, known: S.known });
    const keep = S.table.rows[a[0]];
    keep.cells = S.table.columns.map((c, k) => {
      const texts = a.map(i => res.cells[i][k].text).filter(Boolean);
      const cells = a.map(i => S.table.rows[i].cells[k]);
      const box = cells.reduce((b, c2) => union(b, c2.box), null);
      return { raw: texts.join(' '), text: texts.join(' '), edited: true, box, conf: cells.reduce((m, c2) => minConf(m, c2.conf), null), words: [].concat(...cells.map(c2 => c2.words || [])) };
    });
    keep.off = false; keep.kind = 'data';
    for (let j = a.length - 1; j > 0; j--) S.table.rows.splice(a[j], 1);
    S.rowSel.clear(); S.sel = { r: a[0], c: 0 };
    changed(true);
  }
  async function deleteRows() {
    const a = picked();
    if (!a.length) { toast('Tap a row number first'); return; }
    if (a.length > 2) {
      const r = await ffDialog({ title: `Delete ${a.length} rows?`, buttons: [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'rm', danger: true }] });
      if (!r) return;
    }
    for (let j = a.length - 1; j >= 0; j--) S.table.rows.splice(a[j], 1);
    S.rowSel.clear(); S.sel = null;
    changed(true);
  }

  // ── Adding the shots ──────────────────────────────────────────────────────
  async function addShots() {
    if (!S || !S.table) return;
    const res = T.resolve(S.table, { unit: S.unit, known: S.known });
    const good = res.shots.filter(x => x.ok);
    if (!good.length) { toast('No complete rows: each shot needs From, To and Length'); return; }
    const marked = res.cells.reduce((a, r, ri) => a + (S.table.rows[ri].off ? 0 : r.filter(c => c.level >= 1).length), 0);
    const skipped = res.shots.length - good.length;
    if (marked || skipped) {
      const r = await ffDialog({ title: `Add ${good.length} shot${good.length === 1 ? '' : 's'}?`,
        text: [marked ? `${marked} cell${marked === 1 ? ' is' : 's are'} still marked to check.` : '', skipped ? `${skipped} row${skipped === 1 ? '' : 's'} without From, To or Length ${skipped === 1 ? 'is' : 'are'} left out.` : '', 'Shots can be corrected later in the survey too.'].filter(Boolean).join(' '),
        buttons: [{ label: 'Check them', value: null }, { label: 'Add', value: 'ok', primary: true }] });
      if (!r) { const first = res.cells.findIndex((r2, ri) => !S.table.rows[ri].off && r2.some(c => c.level >= 1)); if (first >= 0) select(first, res.cells[first].findIndex(c => c.level >= 1), true); return; }
    }
    try { await ffEnsureAuthor(); } catch (_) {}
    let sid = S.sid;
    if (!sid || !survey(sid)) { sid = await newSurvey(good[0].shot.from); if (!sid) return; }
    const sv = survey(sid);
    let unit = sv.lenUnit || 'ft';
    if (unit !== S.unit && !sv.shots.length) { ffRecord('survey.set', { sid, patch: { lenUnit: S.unit }, prev: { lenUnit: unit } }); unit = S.unit; }
    const pg = S.page, W0 = S.table.width, H0 = S.table.height;
    const rowBox = ri => {
      if (!W0 || !H0) return null;
      const b = S.table.rows[ri].cells.reduce((a, c) => union(a, c.box), null);
      return b ? b.map((v, i) => Math.round(v / (i % 2 ? H0 : W0) * 10000) / 10000) : null;
    };
    const list = good.map(x => {
      const shot = convertShot(x.shot, S.unit, unit);
      SHOT_KEYS.forEach(k => { shot[k] = String(shot[k] == null ? '' : shot[k]).trim(); });
      if (!shot.note) delete shot.note;
      const out = Object.assign({ id: ffUid() }, shot);
      if (pg) {
        out.src = { h: pg.h };
        if (pg.doc) { out.src.doc = pg.doc; out.src.page = pg.index; }
        const b = rowBox(x.row);
        if (b) { out.src.box = b; out.src.rot = pg.rot || 0; }
      }
      return ['shot.add', { sid, shot: out }];
    });
    if (typeof ffRecordMany === 'function') ffRecordMany(list);
    else list.forEach(([op, d]) => ffRecord(op, d));
    // the page is about these stations: tag it, so a station's card lists it
    let tagged = '';
    if (pg && pg.doc && docsState()[pg.doc]) {
      const cid = typeof ffCaveId === 'function' ? ffCaveId(sv.cave || '') : null;
      const spec = areaSpec([].concat(...good.map(x => [x.shot.from, x.shot.to])));
      if (cid && spec && typeof ffP !== 'undefined' && ffP.caves && ffP.caves[cid]) {
        const target = FL.T.area(cid, spec);
        if (!docsState()[pg.doc].tags[target]) { try { ffRecord('doc.tag', { doc: pg.doc, target }, null, 'docs'); tagged = spec; } catch (_) {} }
      }
    }
    const conv = S.unit !== unit ? ` (lengths turned from ${S.unit} to ${unit})` : '';
    dropDraft();
    S.dirty = false;
    close();
    try { ffGalleryClose(); } catch (_) {}
    try { ffOpenPanel(sid); } catch (_) {}
    toast(`Added ${list.length} shot${list.length === 1 ? '' : 's'} to “${sv.name}”${conv}${tagged ? ' · page tagged ' + tagged : ''}`);
  }
  // A new field survey for these shots: tied to the first From if the map
  // knows it (else to the selected station), in that station's cave.
  async function newSurvey(first) {
    const caves = typeof ffExportCaves === 'function' ? ffExportCaves() : [''];
    let cave = null;
    try { stationMap.forEach(st => { if (cave == null && st && st.name === first) cave = st.cave || ''; }); } catch (_) {}
    const selSt = typeof _selMesh !== 'undefined' && _selMesh && _selMesh._station;
    if (cave == null) cave = selSt ? selSt.cave || '' : caves[0] || '';
    const form = mk('div', 'ff-leadform');
    const row = (label, node) => { const r = mk('div', 'ff-lf'); r.appendChild(mk('div', 'ff-lf-l', label)); r.appendChild(node); form.appendChild(r); return node; };
    const name = row('Name', mk('input', 'ff-input')); name.value = (S.page && S.page.title ? S.page.title : 'Scan ' + today()).slice(0, 60);
    let caveSel = null;
    if (caves.length > 1) {
      caveSel = row('Cave', mk('select', 'ff-input'));
      caves.forEach(c => { const o = mk('option', null, c || '(no name)'); o.value = c; caveSel.appendChild(o); });
      caveSel.value = cave;
    }
    const tie = row('Tied to station', mk('input', 'ff-input')); tie.value = first || (selSt && selSt.name) || '';
    const r = await ffDialog({ title: 'New field survey', text: 'The shots go into a new field survey.', body: form,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Create', value: 'ok', primary: true }] });
    if (!r || !name.value.trim()) return null;
    const d = new Date();
    const sv = { id: ffUid(), name: name.value.trim().slice(0, 60), cave: caveSel ? caveSel.value : cave, tie: tie.value.trim(), lenUnit: S.unit,
      lrudAt: 'from', decl: null, date: d.toISOString().slice(0, 10), created: d.toISOString(), shots: [] };
    ffRecord('survey.add', { survey: sv });
    return sv.id;
  }

  // ── Drafts: a half-checked table survives closing (or the back button) ───
  const dkey = () => 'flexscan.draft.' + (S && S.page ? S.page.h : 'none');
  let draftT = 0;
  function saveDraft(now) {
    if (!S || !S.table || !S.dirty) return;
    const write = () => { try { const txt = JSON.stringify({ v: 1, t: Date.now(), unit: S.unit, rot: S.page ? S.page.rot || 0 : 0, table: S.table }); if (txt.length < 600000) localStorage.setItem(dkey(), txt); } catch (_) {} };
    clearTimeout(draftT);
    if (now) write(); else { const me = S; draftT = setTimeout(() => { if (S === me) write(); }, 700); }
  }
  function loadDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(dkey()) || 'null');
      return d && d.v === 1 && d.table && Array.isArray(d.table.rows) && (d.rot || 0) === (S.page ? S.page.rot || 0 : 0) ? d : null;
    } catch (_) { return null; }
  }
  function dropDraft() { clearTimeout(draftT); try { localStorage.removeItem(dkey()); } catch (_) {} }

  // ── Hooks the viewer calls ────────────────────────────────────────────────
  // The field-survey panel (ffRenderPanel): a button in the survey view and in the list.
  function panelHook(body, sv) {
    if (!body || body.querySelector('.sr-panel-btn')) return;
    const b = mk('button', 'fp-btn sr-panel-btn', '📷 Import shots from scan');
    b.title = 'Read a page of shot tables (photo, document page or file) and add its shots';
    b.addEventListener('click', () => start({ sid: sv ? sv.id : null }));
    const rows = body.querySelectorAll(':scope > .fp-row');
    if (sv && rows[0]) { const r = mk('div', 'fp-row'); r.appendChild(b); rows[0].after(r); }
    else if (!sv && rows.length) rows[rows.length - 1].appendChild(b);
    else { const r = mk('div', 'fp-row'); r.appendChild(b); body.appendChild(r); }
  }

  return Object.assign(T, { start, open, openFromDoc, panelHook, close,
    state: () => S, select: (r, c) => select(r, c, false), tap: tapAt, refresh });
});
