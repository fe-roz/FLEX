// compass-dat.js — Compass .dat survey data import. A DAT file holds the raw
// readings of one cave's surveys (header, then FROM TO LENGTH BEARING INC … lines,
// surveys split by a form feed). Here: parse it, reduce the readings to station
// positions, and write them as Compass PLT text, so it goes through the same
// parser, wizard (anchor / UTM), renderer, recents cache and export as a .plt.
//
// A DAT has no coordinates: the cave's first station is 0,0,0 (or `origin`),
// the PLT is local, and the wizard places it.
//
// Supported: FORMAT string units (bearing D/Q/R, length D/I/M, LRUD D/I/M,
// inclination D/M/G/R/W), LRUD order, shot item order, backsights, flags
// (#|LPXC#), DECLINATION, CORRECTIONS / CORRECTIONS2, comments, several surveys.
// Not supported: closure adjustment (loops are not distributed), DISCOVERY and
// other header extras are ignored, stations not connected to the origin are
// left out and counted. Station and survey names are kept as the file has them
// (spaces would break PLT, so they become "_"). Pure: no DOM, loads under Node.
//
// Not built on flexlib's field-survey reduction: that one has no units, bearing
// forms, corrections or flags. The maths (fore/back mean, declination) is the same.

const FT = 0.3048;
const MISSING = v => v == null || v <= -990;          // Compass writes -999 for "no reading"

export function isCompassDat(text) {
  const t = String(text || '').slice(0, 4000);
  return /SURVEY NAME\s*:/i.test(t) && /DECLINATION\s*:/i.test(t);
}

// "12.5", "12-6" (feet-inches), -999 → metres/feet number or null.
function num(tok, unit) {
  if (tok == null) return null;
  const s = String(tok).trim();
  if (unit === 'I') {
    const m = s.match(/^(-?\d+)(?:[-'\s]+(\d*\.?\d+)"?)?$/);
    if (m && m[2] != null && !MISSING(+m[1])) { const f = +m[1]; return f + (f < 0 ? -1 : 1) * (+m[2] / 12); }
  }
  const v = parseFloat(s);
  return Number.isFinite(v) && !MISSING(v) ? v : null;
}

// Bearing token(s) → degrees. Quads: N45E, N 45 E (three tokens), N45.5W.
function bearing(toks, i, unit) {
  const t = toks[i];
  if (t == null) return { v: null, n: 1 };
  if (unit === 'Q') {
    let s = t, n = 1;
    if (/^[NSns]$/.test(t) && toks[i + 2] != null) { s = t + toks[i + 1] + toks[i + 2]; n = 3; }
    const m = s.match(/^([NSns])\s*(\d+(?:\.\d+)?)(?:[-:](\d+(?:\.\d+)?))?\s*([EWew])$/);
    if (m) {
      const a = +m[2] + (m[3] ? +m[3] / 60 : 0);
      const ns = m[1].toUpperCase(), ew = m[4].toUpperCase();
      return { v: ns === 'N' ? (ew === 'E' ? a : 360 - a) : (ew === 'E' ? 180 - a : 180 + a), n };
    }
    if (/^[NSns]$/.test(t)) return { v: null, n: 1 };   // a quad cut short
  }
  const v = parseFloat(t);
  if (!Number.isFinite(v) || MISSING(v)) return { v: null, n: 1 };
  return { v: unit === 'R' ? v * 0.9 : v, n: 1 };
}

// Inclination token → degrees, or for unit W the depth (a length).
function incl(tok, unit) {
  if (tok == null) return null;
  const s = String(tok).trim();
  if (unit === 'M') {
    const m = s.match(/^(-?\d+)[-:](\d+(?:\.\d+)?)$/);
    if (m && !MISSING(+m[1])) { const d = +m[1]; return d + (/^-/.test(s) ? -1 : 1) * (+m[2] / 60); }
  }
  const v = parseFloat(s);
  if (!Number.isFinite(v) || MISSING(v)) return null;
  if (unit === 'G') return Math.atan(v / 100) * 180 / Math.PI;
  if (unit === 'R') return v * 0.9;
  return v;
}

function parseFormat(f) {
  const s = (f || 'DDDDLUDRLADBF').trim();
  const units = { bearing: s[0] || 'D', length: s[1] || 'D', lrud: s[2] || 'D', inc: s[3] || 'D' };
  let lrudOrder = [...(s.slice(4, 8).toUpperCase())].filter(c => 'LRUD'.includes(c));
  if (lrudOrder.length !== 4) lrudOrder = ['L', 'U', 'D', 'R'];
  const rest = s.slice(8);
  const shotOrder = [...rest].filter(c => 'LAD'.includes(c));        // length, azimuth, inclination (D)
  const backOrder = [...rest].filter(c => c === 'a' || c === 'd');   // back azimuth, back inclination
  const tail = rest.replace(/[LADad]/g, '');
  const backsights = backOrder.length > 0 || /B/.test(tail);
  const flags = /F$/.test(tail) || /F/.test(tail.slice(-1));
  return {
    units, lrudOrder,
    shotOrder: shotOrder.length === 3 ? shotOrder : ['L', 'A', 'D'],
    backOrder: backOrder.length === 2 ? backOrder : ['a', 'd'],
    backsights, flags,
  };
}

function parseHeaderDate(s) {
  const m = String(s || '').match(/(\d{1,2})\s+(\d{1,2})\s+(\d{2,4})/);
  if (!m) return null;
  let y = +m[3];
  if (m[3].length <= 2) y += y < 40 ? 2000 : 1900;
  return { m: +m[1], d: +m[2], y };
}

const safe = s => String(s).replace(/\s+/g, '_');

function parseShot(line, fm) {
  const comment = [];
  const toks = line.trim().split(/\s+/);
  if (toks.length < 5) return null;
  const sh = { from: toks[0], to: toks[1] };
  let i = 2;
  const items = {};
  for (const c of fm.shotOrder) {
    if (c === 'L') items.len = num(toks[i++], fm.units.length);
    else if (c === 'A') { const b = bearing(toks, i, fm.units.bearing); items.az = b.v; i += b.n; }
    else { items.inc = incl(toks[i++], fm.units.inc); }
  }
  const lr = {};
  for (const c of fm.lrudOrder) lr[c] = num(toks[i++], fm.units.lrud);
  for (const k of 'LRUD') if (lr[k] != null && lr[k] < 0) lr[k] = null;
  if (fm.backsights) {
    for (const c of fm.backOrder) {
      if (c === 'a') { const b = bearing(toks, i, fm.units.bearing); items.baz = b.v; i += b.n; }
      else items.binc = incl(toks[i++], fm.units.inc);
    }
  }
  let rest = toks.slice(i).join(' ');
  let flags = '';
  if (fm.flags) {
    const m = rest.match(/^#\|([A-Za-z]*)#\s*/);
    if (m) { flags = m[1].toUpperCase(); rest = rest.slice(m[0].length); }
  }
  comment.push(rest.trim());
  return { ...sh, ...items, lrud: lr, flags, comment: comment.join(' ').trim() };
}

// → { caveName, surveys:[{name,date,comment,team,declination,format,corr,corr2,shots}] }
export function parseDat(text) {
  const blocks = String(text).replace(/\x1a/g, '').split('\f').filter(b => b.trim());
  const surveys = [];
  let caveName = '';
  for (const b of blocks) {
    const lines = b.split(/\r?\n/);
    let k = 0;
    while (k < lines.length && !lines[k].trim()) k++;
    const cave = (lines[k++] || '').trim();
    if (!caveName) caveName = cave;
    const sv = { name: '', date: null, comment: '', team: '', declination: 0, format: parseFormat(null), corr: [0, 0, 0], corr2: [0, 0], shots: [], cave };
    let headerDone = false;
    for (; k < lines.length; k++) {
      const ln = lines[k];
      if (!ln.trim()) continue;
      let m;
      if ((m = ln.match(/^\s*SURVEY NAME\s*:\s*(.*)$/i))) { sv.name = m[1].trim(); continue; }
      if ((m = ln.match(/^\s*SURVEY DATE\s*:\s*(.*?)(?:\s+COMMENT\s*:\s*(.*))?$/i))) { sv.date = parseHeaderDate(m[1]); sv.comment = (m[2] || '').trim(); continue; }
      if (/^\s*SURVEY TEAM\s*:/i.test(ln)) { sv.team = (lines[++k] || '').trim(); continue; }
      if (/^\s*DECLINATION\s*:/i.test(ln)) {
        const dm = ln.match(/DECLINATION\s*:\s*(-?[\d.]+)/i); if (dm) sv.declination = parseFloat(dm[1]) || 0;
        const fmm = ln.match(/FORMAT\s*:\s*(\S+)/i); if (fmm) sv.format = parseFormat(fmm[1]);
        const cm = ln.match(/CORRECTIONS\s*:\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/i);
        if (cm) sv.corr = [+cm[1], +cm[2], +cm[3]];
        const c2 = ln.match(/CORRECTIONS2\s*:\s*(-?[\d.]+)\s+(-?[\d.]+)/i);
        if (c2) sv.corr2 = [+c2[1], +c2[2]];
        continue;
      }
      if (/^\s*FROM\s+TO\b/i.test(ln)) { headerDone = true; continue; }
      if (/^\s*[A-Z ]+:/.test(ln) && !headerDone) continue;     // DISCOVERY: … and other header lines
      headerDone = true;
      const sh = parseShot(ln, sv.format);
      if (sh) sv.shots.push(sh);
    }
    if (sv.name || sv.shots.length) surveys.push(sv);
  }
  return { caveName, surveys };
}

function meanAz(a, b) {
  const r = Math.PI / 180;
  return (Math.atan2(Math.sin(a * r) + Math.sin(b * r), Math.cos(a * r) + Math.cos(b * r)) / r + 360) % 360;
}

// One shot's vector in metres [dE, dN, dUp] (or null with no length), after
// corrections, backsight averaging and declination.
function shotVector(sh, sv, depthOf) {
  const u = sv.format.units;
  if (sh.len == null) return null;
  const L = (u.length === 'M' ? sh.len : sh.len * FT) + sv.corr[2] * FT;     // length correction is in feet
  const f = sh.az != null ? (sh.az + sv.corr[0]) % 360 : null;
  const b = sh.baz != null ? (sh.baz + sv.corr2[0] + 180) % 360 : null;
  let az = f != null && b != null ? meanAz(f, b) : f != null ? f : b;
  let dz = null, inc = null;
  if (u.inc === 'W') {                                        // depth gauge: inc column is depth at the TO station
    const d1 = sh.inc == null ? null : (u.length === 'M' ? sh.inc : sh.inc * FT);
    const d0 = depthOf(sh.from);
    if (d1 != null && d0 != null) { dz = d0 - d1; sh._depth = d1; }
  } else {
    const fi = sh.inc != null ? sh.inc + sv.corr[1] : null;
    const bi = sh.binc != null ? sh.binc + sv.corr2[1] : null;
    inc = fi != null && bi != null ? (fi - bi) / 2 : fi != null ? fi : bi != null ? -bi : 0;
  }
  if (dz != null) { dz = Math.max(-L, Math.min(L, dz)); inc = Math.asin(dz / L) * 180 / Math.PI; }
  else if (inc == null) inc = 0;
  if (az == null) az = 0;
  const g = (az + sv.declination) * Math.PI / 180, i = inc * Math.PI / 180;
  const hz = L * Math.cos(i);
  return [hz * Math.sin(g), hz * Math.cos(g), L * Math.sin(i)];
}

// parseDat() result → station positions in metres (x east, y north, z up).
// The first station of the first shot is `origin` ([0,0,0]) unless `from` names one.
export function reduceDat(dat, { from } = {}) {
  const pos = new Map();
  const depth = new Map();
  const all = [];
  for (const sv of dat.surveys) for (const sh of sv.shots) {
    if (sh.flags.includes('X')) continue;                     // X: left out of all processing
    all.push([sh, sv]);
  }
  const rootName = from || (all.length ? all[0][0].from : null);
  if (rootName == null) return { pos, unplaced: new Set(), shots: all };
  pos.set(rootName, [0, 0, 0]);
  depth.set(rootName, 0);
  const vec = new Map();
  let added = true;
  while (added) {
    added = false;
    for (const [sh, sv] of all) {
      const a = pos.get(sh.from), b = pos.get(sh.to);
      if ((a && b) || (!a && !b)) continue;
      let v = vec.get(sh);
      if (!v) { v = shotVector(sh, sv, n => (depth.has(n) ? depth.get(n) : 0)); vec.set(sh, v); }
      if (!v) continue;
      if (a) { pos.set(sh.to, [a[0] + v[0], a[1] + v[1], a[2] + v[2]]); if (sh._depth != null) depth.set(sh.to, sh._depth); }
      else pos.set(sh.from, [b[0] - v[0], b[1] - v[1], b[2] - v[2]]);
      added = true;
    }
  }
  const unplaced = new Set();
  for (const [sh] of all) { if (!pos.has(sh.from)) unplaced.add(sh.from); if (!pos.has(sh.to)) unplaced.add(sh.to); }
  return { pos, unplaced, shots: all };
}

const f3 = x => (x / FT).toFixed(3);

// DAT text → { name, plt, stats, warnings } (PLT in feet, local: no zone line).
export function datToPlt(text, opts = {}) {
  const dat = parseDat(text);
  if (!dat.surveys.length) throw new Error('no surveys found in this DAT file');
  const { pos, unplaced } = reduceDat(dat, opts);
  const name = dat.caveName || 'Compass DAT';
  const lines = [`Z ${name.replace(/[\r\n"]+/g, ' ')}`, 'O WGS84'];
  const warnings = [];
  const names = new Set();
  let shots = 0, noLength = 0, left = 0;
  for (const sv of dat.surveys) {
    const d = sv.date;
    const dateTok = d ? `${d.m} ${d.d} ${d.y}` : '1 1 1900';
    lines.push(`N${safe(sv.name || 'S')} D ${dateTok} C${sv.comment.replace(/[\r\n]+/g, ' ')}`);
    // LRUD at the FROM station of each shot.
    const lr = new Map();
    for (const sh of sv.shots) {
      const l = sh.lrud || {};
      if (!lr.has(sh.from) && ['L', 'U', 'D', 'R'].some(k => l[k] != null)) lr.set(sh.from, l);
    }
    const lunit = sv.format.units.lrud === 'M' ? 1 : FT;
    let open = null;
    const point = (cmd, n, comment) => {
      const p = pos.get(n);
      let l = `${cmd} ${f3(p[1])} ${f3(p[0])} ${f3(p[2])} S${safe(n)}`;
      const r = lr.get(n);
      if (r) {
        const g = x => (x == null ? '-9.90' : (x * lunit / FT).toFixed(2));
        l += ` P ${g(r.L)} ${g(r.U)} ${g(r.D)} ${g(r.R)}`;
      }
      if (comment) l += ` "${comment.replace(/[\r\n"]+/g, ' ')}"`;
      lines.push(l);
      names.add(n);
    };
    for (const sh of sv.shots) {
      if (sh.flags.includes('X')) { left++; continue; }
      if (sh.len == null) { noLength++; open = null; continue; }
      if (!pos.has(sh.from) || !pos.has(sh.to)) { open = null; continue; }
      if (open !== sh.from) point('M', sh.from);
      point(sh.flags.includes('P') ? 'd' : 'D', sh.to, sh.comment);
      open = sh.to;
      shots++;
    }
  }
  if (unplaced.size) warnings.push(`${unplaced.size} stations are not connected to the first station and were left out`);
  if (noLength) warnings.push(`${noLength} shots without a length were skipped`);
  return {
    name, plt: lines.join('\n') + '\n', warnings,
    stats: { surveys: dat.surveys.length, shots, stations: names.size, unplaced: unplaced.size, left },
  };
}
