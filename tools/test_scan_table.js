// Scan import: the table rules of viewer_build/libs/scan-import.js (no DOM).
// Words as a text reader returns them (boxes in pixels) -> rows, columns,
// which column is which shot field, cleaned values, flags, shots.
// Fixtures are made up here: a generator lays out a shot table the way a
// hand-written page reads (uneven spacing, a tilted page, a row written
// uphill, cells run together, the reader's letter/digit mix-ups).
//
//   node tools/test_scan_table.js
'use strict';
const path = require('path');
const S = require(path.join(__dirname, '../viewer_build/libs/scan-import.js'));

let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) { pass++; console.log('ok   ' + l); } else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i).slice(0, 600) : '')); } };

// A tiny repeatable random source.
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// Lay out a table as reader output. rows: arrays of cell text ('' = empty).
// colX: left edge of each column; skew: whole page turned (degrees);
// drift: { row: degrees } rows written uphill; nested: ML Kit's block/line
// shape instead of flat words; chars: per-character boxes.
function makeOcr(rows, o) {
  o = Object.assign({ colX: null, y0: 120, dy: 64, cw: 19, th: 30, skew: 0, drift: {}, jitter: 4, seed: 1, nested: false, chars: false, conf: {} }, o);
  const R = rng(o.seed);
  const colX = o.colX || rows[0].map((_, j) => 60 + j * 150);
  const th = o.skew * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
  const rot = (x, y) => [x * c - y * s, x * s + y * c];
  const words = [];
  rows.forEach((row, i) => {
    const dr = (o.drift[i] || 0) * Math.PI / 180;
    row.forEach((cell, j) => {
      if (cell == null || cell === '') return;
      let x = colX[j] + (R() - 0.5) * 2 * o.jitter;
      cell.split(' ').forEach(word => {
        const w = word.length * o.cw * (0.85 + 0.3 * R());
        const yb = o.y0 + i * o.dy + (R() - 0.5) * 2 * o.jitter + (x - colX[0]) * Math.tan(dr);
        const pts = [rot(x, yb), rot(x + w, yb), rot(x, yb + o.th), rot(x + w, yb + o.th)];
        const box = [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))].map(Math.round);
        const out = { text: word, box, conf: o.conf[word] != null ? o.conf[word] : 0.9, line: i };
        if (o.chars) out.chars = [...word].map((ch, k) => {
          const a = rot(x + k * w / word.length, yb), b = rot(x + (k + 1) * w / word.length, yb + o.th);
          return { text: ch, box: [Math.round(Math.min(a[0], b[0])), Math.round(Math.min(a[1], b[1])), Math.round(Math.max(a[0], b[0])), Math.round(Math.max(a[1], b[1]))], conf: 0.9 };
        });
        words.push(out);
        x += w + o.cw * 0.8;
      });
    });
  });
  const width = 2000, height = o.y0 + rows.length * o.dy + 200;
  if (!o.nested) return { width, height, words };
  // ML Kit shape: each row one line (as it often reads a ruled table), one block per 3 rows
  const blocks = [];
  rows.forEach((row, i) => {
    const ws = words.filter(w => w.line === i).map(w => { const x = Object.assign({}, w); delete x.line; return x; });
    if (!ws.length) return;
    if (i % 3 === 0) blocks.push({ text: '', lines: [] });
    blocks[blocks.length - 1].lines.push({ text: ws.map(w => w.text).join(' '), words: ws });
  });
  return { width, height, blocks };
}
const fieldsOf = t => t.columns.map(c => c.field);
const dataRows = t => t.rows.filter(r => r.kind === 'data' && !r.off);
const shotsOf = (t, opts) => S.resolve(t, opts || {}).shots;
const cellText = (t, ri, f, opts) => { const R = S.resolve(t, opts || {}); const k = t.columns.findIndex(c => c.field === f); return R.cells[ri][k]; };

// ── 1. A header row and a clean table ──────────────────────────────────────
const H1 = ['From', 'To', 'Dist', 'Azimuth', 'Incl', 'L', 'R', 'U', 'D', 'Notes'];
const X1 = [60, 190, 320, 450, 590, 720, 800, 880, 960, 1060];
const rows1 = [H1,
  ['A4', 'X1', '12.5', '245', '-5', '2', '3', '1', '0.5', ''],
  ['X1', 'X2', '8.3', '260', '+2', '1.5', '2', '1', '1', 'crawl'],
  ['X2', 'X3', '15.0', '271', '-12', '3', '4', '6', '2', ''],
  ['X3', 'X4', '6.2', '190', '0', '1', '1', '2', '0', 'small room']];
let t = S.buildTable(makeOcr(rows1, { colX: X1 }));
ok('header table: header row found, four data rows', t.rows.filter(r => r.kind === 'header').length === 1 && dataRows(t).length === 4, t.rows.map(r => r.kind));
ok('header table: columns named from the header', JSON.stringify(fieldsOf(t)) === JSON.stringify(['from', 'to', 'len', 'az', 'inc', 'l', 'r', 'u', 'd', 'note']), fieldsOf(t));
let sh = shotsOf(t);
ok('header table: four shots, values as written', sh.length === 4 && sh.every(s => s.ok) && sh[0].shot.from === 'A4' && sh[0].shot.to === 'X1' && sh[0].shot.len === '12.5' &&
  sh[1].shot.inc === '+2' && sh[3].shot.note === 'small room' && sh[2].shot.d === '2', sh.map(s => s.shot));
ok('header table: the shot flags are clean', sh.every(s => !s.flags.length), sh.map(s => s.flags));
const t1nest = S.buildTable(makeOcr(rows1, { colX: X1, nested: true, seed: 5 }));
ok('the reader\'s block/line/word shape reads the same', JSON.stringify(shotsOf(t1nest).map(s => s.shot)) === JSON.stringify(sh.map(s => s.shot)), shotsOf(t1nest).map(s => s.shot));

// ── 2. Handwriting read with the usual mix-ups ─────────────────────────────
const rows2 = [H1,
  ['A4', 'X1', 'l2.S', '245o', '-5', '2', '3', 'l', 'O.5', ''],
  ['X1', 'X2', '8,3', '26O', '+2', '1,5', '2', '1', '1', ''],
  ['X2', 'X3', '15.0', '271°', '-l2', '3', '4', '6', '2', ''],
  ['X3', 'X4', '6.2', '1900', 'O', '1', '1', '2', '0', ''],
  ['X4', 'X5', '12\'6"', '200', '-3', '', '', '', '', '']];
t = S.buildTable(makeOcr(rows2, { colX: X1, seed: 2, conf: { '-3': 0.42 } }));
sh = shotsOf(t);
ok('mix-ups: l2.S → 12.5, O.5 → 0.5, l → 1', sh[0].shot.len === '12.5' && sh[0].shot.d === '0.5' && sh[0].shot.u === '1', sh[0].shot);
ok('mix-ups: decimal comma 8,3 → 8.3 (also in LRUD)', sh[1].shot.len === '8.3' && sh[1].shot.l === '1.5', sh[1].shot);
ok('mix-ups: 26O → 260, -l2 → -12, a lone O → 0', sh[1].shot.az === '260' && sh[2].shot.inc === '-12' && sh[3].shot.inc === '0', [sh[1].shot, sh[2].shot, sh[3].shot]);
ok('degree signs: 245o → 245, 271° → 271, 1900 (° read as 0) → 190', sh[0].shot.az === '245' && sh[2].shot.az === '271' && sh[3].shot.az === '190', sh.map(s => s.shot.az));
ok('feet and inches: 12\'6" → 12.5', sh[4].shot.len === '12.5', sh[4].shot);
ok('a plus read as t: t2 → +2 in an inclination', S.fixNumber('t2', 'inc').text === '+2' && S.fixNumber('T2', 'len').text === '72', [S.fixNumber('t2', 'inc'), S.fixNumber('T2', 'len')]);
let c = cellText(t, 1, 'len');
ok('a fixed cell is flagged with what was read', c.level === S.DOUBT && /l2\.S/.test(c.flags.join()) && /12\.5/.test(c.flags.join()), c);
c = cellText(t, 4, 'az');
ok('° read as 0 is flagged as a doubt', c.level >= S.DOUBT && /°/.test(c.flags.join()), c);
c = cellText(t, 5, 'inc');
ok('a low-confidence reading is flagged', c.level >= S.DOUBT && /not sure/.test(c.flags.join()), c);
c = cellText(t, 1, 'inc');
ok('a clean cell has no flag', c.level === 0 && !c.flags.length, c);

// ── 3. A page photographed at an angle ─────────────────────────────────────
t = S.buildTable(makeOcr(rows1, { colX: X1, skew: 4, seed: 3 }));
ok('tilted page (4°): skew found', Math.abs(Math.atan(t.skew) * 180 / Math.PI - 4) < 1, Math.atan(t.skew) * 180 / Math.PI);
ok('tilted page: same rows and fields', dataRows(t).length === 4 && JSON.stringify(fieldsOf(t)) === JSON.stringify(['from', 'to', 'len', 'az', 'inc', 'l', 'r', 'u', 'd', 'note']), [dataRows(t).length, fieldsOf(t)]);
ok('tilted page: same shots', JSON.stringify(shotsOf(t).map(s => s.shot)) === JSON.stringify(shotsOf(S.buildTable(makeOcr(rows1, { colX: X1 }))).map(s => s.shot)), shotsOf(t).map(s => s.shot));
t = S.buildTable(makeOcr(rows1, { colX: X1, skew: -6, seed: 4 }));
ok('tilted the other way (-6°): same shots', shotsOf(t).length === 4 && shotsOf(t)[2].shot.az === '271' && shotsOf(t)[3].shot.note === 'small room', shotsOf(t).map(s => s.shot));

// ── 4. One row written uphill ──────────────────────────────────────────────
t = S.buildTable(makeOcr(rows1, { colX: X1, drift: { 2: -2.6 }, seed: 6 }));
sh = shotsOf(t);
ok('a row drifting ~45 px up across the page stays one row', dataRows(t).length === 4 && sh[1].shot.from === 'X1' && sh[1].shot.d === '1' && sh[1].shot.note === 'crawl', sh.map(s => s.shot));
t = S.buildTable(makeOcr(rows1, { colX: X1, drift: { 1: 1.8, 3: -1.8 }, seed: 7, dy: 56 }));
ok('two rows drifting opposite ways, rows closer together: still four shots, LRUD in place', shotsOf(t).length === 4 && shotsOf(t).map(s => s.shot.r).join() === '3,2,4,1', shotsOf(t).map(s => s.shot));

// ── 5. Cells run together ──────────────────────────────────────────────────
const rows5 = [H1,
  ['A4', 'X1', '12.5', '245', '-5', '2', '3', '1', '0.5', ''],
  ['X1', 'X2', '8.3', '260', '+2', '1.5', '2', '1', '1', ''],
  ['X2', 'X3', '15.0', '271', '-12', '3', '4', '6', '2', ''],
  ['X3', 'X4', '6.2', '190', '0', '1', '1', '2', '0', '']];
let ocr5 = makeOcr(rows5, { colX: X1, seed: 8, chars: true });
// row 2: "260" and "+2" read as one word "260+2" spanning the Az and Incl columns
const w260 = ocr5.words.find(w => w.text === '260'), w2 = ocr5.words.find(w => w.text === '+2');
const merged = { text: '260+2', box: [w260.box[0], Math.min(w260.box[1], w2.box[1]), w2.box[2], Math.max(w260.box[3], w2.box[3])], conf: 0.8,
  chars: w260.chars.concat(w2.chars) };
ocr5.words = ocr5.words.filter(w => w !== w260 && w !== w2).concat([merged]);
t = S.buildTable(ocr5);
sh = shotsOf(t);
ok('merged cells with letter boxes: cut where the letters cross the gap', sh[1].shot.az === '260' && sh[1].shot.inc === '+2', sh[1].shot);
c = cellText(t, 2, 'az');
ok('merged cells are flagged', c.level >= S.DOUBT && /one word/.test(c.flags.join()), c);
// without letter boxes: cut in proportion
let ocr5b = makeOcr(rows5, { colX: X1, seed: 9 });
const a5 = ocr5b.words.find(w => w.text === '15.0'), b5 = ocr5b.words.find(w => w.text === '271');
ocr5b.words = ocr5b.words.filter(w => w !== a5 && w !== b5).concat([{ text: '15.0271', box: [a5.box[0], a5.box[1], b5.box[2], b5.box[3]], conf: 0.85 }]);
t = S.buildTable(ocr5b);
sh = shotsOf(t);
ok('merged cells without letter boxes: cut by letter position', sh[2].shot.len === '15.0' && sh[2].shot.az === '271', sh[2].shot);

// ── 6. Missing LRUD ────────────────────────────────────────────────────────
const rows6 = [H1,
  ['A4', 'X1', '12.5', '245', '-5', '', '', '', '', ''],
  ['X1', 'X2', '8.3', '260', '+2', '', '', '', '', ''],
  ['X2', 'X3', '15.0', '271', '-12', '', '', '', '', 'pit'],
  ['X3', 'X4', '6.2', '190', '0', '', '', '', '', '']];
t = S.buildTable(makeOcr(rows6, { colX: X1, seed: 10 }));
ok('no LRUD written: the L R U D columns still come from the header', JSON.stringify(fieldsOf(t)) === JSON.stringify(['from', 'to', 'len', 'az', 'inc', 'l', 'r', 'u', 'd', 'note']), fieldsOf(t));
sh = shotsOf(t);
ok('no LRUD written: shots without LRUD, no LRUD flags, notes kept', sh.length === 4 && sh.every(s => s.ok && !s.shot.l && !s.flags.length) && sh[2].shot.note === 'pit', sh.map(s => [s.shot, s.flags]));
const rows6b = [H1,
  ['A4', 'X1', '12.5', '245', '-5', '2', '3', '1', '0.5', ''],
  ['X1', 'X2', '8.3', '260', '+2', '', '', '', '', ''],
  ['X2', 'X3', '15.0', '271', '-12', '', '', '', '', ''],
  ['X3', 'X4', '6.2', '190', '0', '1', '', '2', '', ''],
  ['X4', 'X5', '9.1', '182', '-4', '', '', '', '', '']];
t = S.buildTable(makeOcr(rows6b, { colX: X1, seed: 11 }));
sh = shotsOf(t);
ok('LRUD in a few rows only: each value in its own column', sh[0].shot.d === '0.5' && sh[3].shot.l === '1' && sh[3].shot.u === '2' && sh[3].shot.r === '' && sh[1].shot.l === '', sh.map(s => s.shot));

// ── 7. No header ───────────────────────────────────────────────────────────
const rows7 = rows1.slice(1).concat([['X4', 'X5', '9.1', '182', '-4', '2', '2', '1', '1', '']]);
t = S.buildTable(makeOcr(rows7, { colX: X1, seed: 12 }));
ok('no header: every row is data', t.rows.every(r => r.kind === 'data'), t.rows.map(r => r.kind));
ok('no header: fields from what the columns hold (From To Length Az Incl L R U D Notes)', JSON.stringify(fieldsOf(t)) === JSON.stringify(['from', 'to', 'len', 'az', 'inc', 'l', 'r', 'u', 'd', 'note']), fieldsOf(t));
ok('no header: shots as written', shotsOf(t).length === 5 && shotsOf(t)[4].shot.az === '182' && shotsOf(t)[0].shot.inc === '-5', shotsOf(t).map(s => s.shot));
// no header, numbered stations, no notes, no LRUD
const rows7b = [['1', '2', '22.4', '118', '-8'], ['2', '3', '17.9', '131', '-3'], ['3', '4', '9.5', '95', '+11'], ['4', '5', '30.2', '144', '-21'], ['5', '6', '12.0', '160', '-2']];
t = S.buildTable(makeOcr(rows7b, { colX: [60, 160, 260, 400, 520], seed: 13 }));
ok('no header, numbered stations: From To Length Az Incl', JSON.stringify(fieldsOf(t)) === JSON.stringify(['from', 'to', 'len', 'az', 'inc']), fieldsOf(t));
// no header, with backsights: az and back az 180° apart, incl and back incl opposite
const rows7c = [['A1', 'A2', '22.4', '118', '298', '-8', '+8'], ['A2', 'A3', '17.9', '131', '311', '-3', '+3'], ['A3', 'A4', '9.5', '95', '276', '+11', '-11'],
  ['A4', 'A5', '30.2', '144', '324', '-21', '+20'], ['A5', 'A6', '12.0', '160', '340', '-2', '+2']];
t = S.buildTable(makeOcr(rows7c, { colX: [60, 170, 280, 400, 510, 620, 730], seed: 14 }));
ok('no header, backsights: Az / Back az / Incl / Back incl found by their pairs', JSON.stringify(fieldsOf(t)) === JSON.stringify(['from', 'to', 'len', 'az', 'baz', 'inc', 'binc']), fieldsOf(t));
const rows7d = [['A1', 'A2', '22.4', '118', '-8', '298', '+8'], ['A2', 'A3', '17.9', '131', '-3', '311', '+3'], ['A3', 'A4', '9.5', '95', '+11', '276', '-11'],
  ['A4', 'A5', '30.2', '144', '-21', '324', '+20'], ['A5', 'A6', '12.0', '160', '-2', '340', '+2']];
t = S.buildTable(makeOcr(rows7d, { colX: [60, 170, 280, 400, 510, 620, 730], seed: 15 }));
ok('no header, backsights after the foresights: Az Incl Back az Back incl', JSON.stringify(fieldsOf(t)) === JSON.stringify(['from', 'to', 'len', 'az', 'inc', 'baz', 'binc']), fieldsOf(t));

// ── 8. Headers people write ────────────────────────────────────────────────
const rows8 = [['Sta', 'Sta', 'Dist (m)', 'Bearing', 'Clino', 'LRUD', '', '', '', 'Comments'],
  ['A4', 'X1', '3.81', '245', '-5', '0.6', '0.9', '0.3', '0.2', ''],
  ['X1', 'X2', '2.53', '260', '+2', '0.5', '0.6', '0.3', '0.3', 'wet']];
t = S.buildTable(makeOcr(rows8, { colX: X1, seed: 16 }));
ok('headers: Sta Sta → From To, Bearing, Clino, one LRUD over four columns, Comments', JSON.stringify(fieldsOf(t)) === JSON.stringify(['from', 'to', 'len', 'az', 'inc', 'l', 'r', 'u', 'd', 'note']), fieldsOf(t));
ok('headers: "(m)" sets metres', t.unit === 'm', t.unit);
const rows8b = [['From', 'To', 'Length', 'Azimuth', '', 'Inclination', '', 'Notes'],
  ['', '', '', 'FS', 'BS', 'FS', 'BS', ''],
  ['A1', 'A2', '22.4', '118', '298', '-8', '+8', ''],
  ['A2', 'A3', '17.9', '131', '311', '-3', '+3', ''],
  ['A3', 'A4', '9.5', '95', '276', '+11', '-11', 'squeeze']];
t = S.buildTable(makeOcr(rows8b, { colX: [60, 170, 280, 420, 530, 660, 790, 920], seed: 17 }));
ok('two header rows: Azimuth / Inclination over FS | BS', JSON.stringify(fieldsOf(t)) === JSON.stringify(['from', 'to', 'len', 'az', 'baz', 'inc', 'binc', 'note']), [fieldsOf(t), t.rows.map(r => r.kind)]);
sh = shotsOf(t);
ok('two header rows: backsights read, readings agree (no flags)', sh.length === 3 && sh[0].shot.baz === '298' && sh[2].shot.binc === '-11' && sh.every(s => !s.flags.length), sh.map(s => [s.shot, s.flags]));
// misspelt by the reader
const rows8c = [['Frorn', 'To', 'Dlst', 'Azimutn', 'lnc', 'L', 'R', 'U', 'D'], ['A4', 'X1', '12.5', '245', '-5', '2', '3', '1', '0.5'], ['X1', 'X2', '8.3', '260', '+2', '1.5', '2', '1', '1']];
t = S.buildTable(makeOcr(rows8c, { colX: X1.slice(0, 9), seed: 18 }));
ok('header words misread (Frorn, Dlst, Azimutn, lnc) still name the columns', JSON.stringify(fieldsOf(t)) === JSON.stringify(['from', 'to', 'len', 'az', 'inc', 'l', 'r', 'u', 'd']), fieldsOf(t));
// a title above the header
const rows8d = [['Cave Ridge', 'trip 3', '', '', '', '', '', '', '', ''], ...rows1];
t = S.buildTable(makeOcr(rows8d, { colX: X1, seed: 19 }));
ok('a title line above the header is left out', t.rows[0].kind === 'other' && t.rows[0].off && t.rows[1].kind === 'header' && dataRows(t).length === 4, t.rows.map(r => r.kind));

// ── 9. Ditto marks, missing From, station names ────────────────────────────
const rows9 = [H1,
  ['A4', 'X1', '12.5', '245', '-5', '2', '3', '1', '0.5', ''],
  ['', 'X2', '8.3', '260', '+2', '"', '"', '1', '1', ''],
  ['X2', 'X3', '15.0', '271', '-12', '3', '4', '6', '2', 'ends in a'],
  ['', '', '', '', '', '', '', '', '', 'small room'],
  ['X 3', 'X4', '6.2', '190', '0', '1', '1', '2', '0', '']];
t = S.buildTable(makeOcr(rows9, { colX: X1, seed: 20 }));
sh = shotsOf(t);
ok('a missing From is the To above (flagged)', sh[1].shot.from === 'X1' && /row above/.test(cellText(t, 2, 'from').flags.join()), [sh[1].shot, cellText(t, 2, 'from')]);
ok('ditto marks copy the cell above (flagged)', sh[1].shot.l === '2' && sh[1].shot.r === '3' && /ditto/.test(cellText(t, 2, 'l').flags.join()), [sh[1].shot, cellText(t, 2, 'l')]);
ok('a notes-only row joins the notes above', sh.length === 4 && sh[2].shot.note === 'ends in a small room', sh.map(s => s.shot.note));
ok('"X 3" → X3', sh[3].shot.from === 'X3', sh[3].shot);
const rows9b = [H1, ['a4', 'XlO', '12.5', '245', '-5', '', '', '', '', ''], ['X1O', 'X11', '8.3', '260', '+2', '', '', '', '', '']];
t = S.buildTable(makeOcr(rows9b, { colX: X1, seed: 21 }));
sh = shotsOf(t, { known: ['A4', 'A5', 'B1'] });
ok('station names: known A4 for "a4", X1O → X10, XlO → X10', sh[0].shot.from === 'A4' && sh[0].shot.to === 'X10' && sh[1].shot.from === 'X10', sh.map(s => s.shot));

// ── 10. Edits and remapping (what the review screen does) ──────────────────
t = S.buildTable(makeOcr(rows1, { colX: X1, seed: 22 }));
t.rows[1].cells[2].edited = true; t.rows[1].cells[2].text = '13.0';
ok('an edited cell wins over what was read', shotsOf(t)[0].shot.len === '13.0', shotsOf(t)[0].shot);
t.columns[4].field = 'binc';
sh = shotsOf(t);
ok('a column set to Back incl. moves its values', sh[0].shot.binc === '-5' && sh[0].shot.inc === '', sh[0].shot);
t.columns[4].field = 'inc';
t.columns[t.columns.findIndex(c => c.field === 'note')].field = 'skip';
ok('a column set to Ignore is left out', !shotsOf(t)[3].shot.note, shotsOf(t)[3].shot);
t.rows[2].off = true;
ok('a row switched off makes no shot', shotsOf(t).length === 3, shotsOf(t).length);
const bad = S.buildTable(makeOcr([H1, ['A4', 'X1', '', '245', '-5', '', '', '', '', ''], ['X1', 'X2', '8.3', '385', '+2', '', '', '', '', '']], { colX: X1, seed: 23 }));
sh = shotsOf(bad);
ok('a row without a length is not a shot; an azimuth over 360 is flagged', !sh[0].ok && sh[1].ok && cellText(bad, 2, 'az').level === S.BAD, [sh, cellText(bad, 2, 'az')]);

// ── 11. Many made-up pages ─────────────────────────────────────────────────
// Random tables (4-17 shots, LRUD sometimes missing, notes now and then) laid
// out with a tilted page (±4°), a row written uphill (±1.5°), words off their
// line by up to ±6 px (text 30 px high, rows 56-82 px apart): every one must
// come back exactly. Rougher pages (±5°, ±2°, ±10 px, rows from 52 px) are
// counted, not required.
function randomPage(seed, header, rough) {
  const R = rng(seed);
  const n = 4 + Math.floor(R() * 14), rows = header ? [H1] : [];
  for (let i = 0; i < n; i++) {
    const lr = () => (R() < 0.2 ? '' : String(Math.round(R() * 16) / 2));
    rows.push(['X' + (i + 1), 'X' + (i + 2), (1 + R() * 30).toFixed(1), String(Math.floor(R() * 360)), (R() < 0.5 ? '-' : '+') + Math.floor(R() * 40), lr(), lr(), lr(), lr(), R() < 0.25 ? 'mud floor' : '']);
  }
  const skew = (R() - 0.5) * (rough ? 10 : 8), drift = {};
  if (R() < 0.5) drift[1 + Math.floor(R() * n)] = (R() - 0.5) * (rough ? 4 : 3);
  const jitter = 2 + R() * (rough ? 8 : 4), dy = (rough ? 52 : 56) + R() * (rough ? 30 : 26);
  return { rows, data: rows.slice(header ? 1 : 0), ocr: makeOcr(rows, { colX: X1, skew, drift, jitter, dy, seed }) };
}
function samePage(p) {
  const t = S.buildTable(p.ocr), shots = S.resolve(t).shots;
  return shots.length === p.data.length && shots.every((s, i) => {
    const d = p.data[i], g = s.shot;
    return [g.from, g.to, g.len, g.az, g.inc.replace(/^\+/, ''), g.l, g.r, g.u, g.d, g.note || ''].join('|') === [d[0], d[1], d[2], d[3], d[4].replace(/^\+/, ''), d[5], d[6], d[7], d[8], d[9]].join('|');
  });
}
let good = 0, total = 0, missed = [];
for (const header of [true, false]) for (let seed = 1; seed <= 60; seed++) { total++; if (samePage(randomPage(seed * 7 + (header ? 1 : 0), header, false))) good++; else missed.push((header ? 'H' : 'noH') + seed); }
ok(`${total} made-up pages (with and without a header) come back exactly`, good === total, missed);
good = 0; total = 0;
for (const header of [true, false]) for (let seed = 1; seed <= 60; seed++) { total++; if (samePage(randomPage(seed * 13 + (header ? 1 : 0), header, true))) good++; }
console.log(`     rougher pages: ${good} of ${total} exactly right`);
ok('rougher pages: at least 85% exactly right', good >= 0.85 * total, good + '/' + total);

// ── 12. Helpers ────────────────────────────────────────────────────────────
ok('feet → metres keeps a ledge', JSON.stringify(S.convertShot({ len: '10', l: '3/5', r: '', az: '100' }, 'ft', 'm')) === JSON.stringify({ len: '3.05', l: '0.91/1.52', r: '', az: '100' }), S.convertShot({ len: '10', l: '3/5', r: '', az: '100' }, 'ft', 'm'));
ok('area spec of stations', S.areaSpec(['A4', 'X1', 'X2', 'X3', 'X10', 'X10a']) === 'A4,X1~X10,X10a', S.areaSpec(['A4', 'X1', 'X2', 'X3', 'X10', 'X10a']));
ok('empty table to type into', (() => { const e = S.emptyTable({ rows: 3 }); return e.rows.length === 3 && e.columns.length === 10 && S.resolve(e).shots.length === 0; })());
ok('nothing read → an empty table, no crash', S.buildTable({ width: 100, height: 100, blocks: [] }).rows.length === 0);
ok('header words: Back az, BS inc, FS, Slope dist (ft)', S.headerField('Back az').field === 'baz' || (S.headerField('Back az').field === 'az' && S.headerField('Back az').mod === 'bs'),
  [S.headerField('Back az'), S.headerField('BS inc'), S.headerField('FS'), S.headerField('Slope dist (ft)')]);
ok('header words: units', S.headerField('Slope dist (ft)').field === 'len' && S.headerField('Slope dist (ft)').unit === 'ft' && S.headerField('Dist m').unit === 'm', [S.headerField('Slope dist (ft)'), S.headerField('Dist m')]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
