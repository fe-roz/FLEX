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
    const H = Math.max(4, median(ws.map(w => w.y1 - w.y0)));
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
          const v = dp[i][p] + fieldScore(f, stats[k]);
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
          if (DITTO.test(text) && prevRow && (f !== 'skip')) {
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
      if (!has('from') && prev && has.call(null, 'to') && String(prev.shot.to || '').trim()) {
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
  return T;
});
