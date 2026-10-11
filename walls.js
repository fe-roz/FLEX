// walls.js — Walls import, from the shapefiles Walls exports.
//
// Walls compiles a project itself: units, prefixes, declination from the
// survey dates, the least-squares loop adjustment and the georeference. Its
// shapefile export (Segments tab → Details / Rpts… → Shapefile…) writes the
// finished result, and the attribute tables (.dbf) carry everything FLEX needs,
// so the geometry files (.shp/.shx) aren't read at all:
//   <base>_V.dbf  vectors   FR_PREFIX FR_NAME TO_PREFIX TO_NAME … LENGTH DATE SRV_NAME SRV_TITLE
//   <base>_S.dbf  stations  PREFIX NAME X Y Z LEFT RIGHT UP DOWN LRUD_AZ
//   <base>_N.dbf  notes     PREFIX NAME X Y Z NOTE           (optional)
//   <base>_F.dbf  flags     PREFIX NAME X Y Z FLAGNAME       (optional)
//   <base>_?.prj  datum and UTM zone (Walls writes it for WGS84, NAD83, NAD27)
// Each set becomes one cave, turned into Compass PLT text like the Breakout
// import, so it parses, renders, caches, reloads and exports exactly like a
// .plt. Each Walls survey file (SRV_NAME) is a PLT survey, titled SRV_TITLE.
//
// Coordinates: UTM metres (recommended export) or lat/long degrees, either
// way ending up as WGS84 UTM. NAD27 gets the standard CONUS mean shift
// (accurate to a few metres there); NAD83 is taken as WGS84 (under 2 m).
// LRUD units aren't documented for the export: they are taken to be the same
// as LENGTH's, which is told apart (metres or feet) by comparing LENGTH with
// the distance between each shot's stations.

const FT = 0.3048;

// ── dBase III table → { fields, records } ────────────────────────────────────
export function parseDbf(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  if (u8.length < 32) throw new Error('not a .dbf file');
  const n = dv.getUint32(4, true), hlen = dv.getUint16(8, true), rlen = dv.getUint16(10, true);
  const dec = new TextDecoder('windows-1252');
  const fields = [];
  for (let o = 32; o + 32 <= hlen && u8[o] !== 0x0D; o += 32) {
    let end = o;
    while (end < o + 11 && u8[end]) end++;
    fields.push({ name: dec.decode(u8.subarray(o, end)).trim().toUpperCase(),
                  type: String.fromCharCode(u8[o + 11]), len: u8[o + 16], dec: u8[o + 17] });
  }
  const records = [];
  for (let r = 0; r < n; r++) {
    const base = hlen + r * rlen;
    if (base + rlen > u8.length) break;
    if (u8[base] === 0x2A) continue;                    // '*' = deleted record
    const rec = {};
    let off = base + 1;
    for (const f of fields) {
      const raw = dec.decode(u8.subarray(off, off + f.len)).trim();
      off += f.len;
      if (f.type === 'N' || f.type === 'F') {
        const v = raw === '' || /^\*+$/.test(raw) ? NaN : parseFloat(raw);
        rec[f.name] = Number.isFinite(v) ? v : null;   // blank = not measured
      } else rec[f.name] = raw;
    }
    records.push(rec);
  }
  return { fields, records };
}

// ── The selected files → [{ base, V, S, N?, F?, prj? }], one per export set ──
export async function readWallsShapefileSets(files) {
  const sets = new Map();
  for (const f of files) {
    const m = f.name.match(/^(.*)_([VSNFW])\.(dbf|prj)$/i);
    if (!m) continue;
    const base = m[1], layer = m[2].toUpperCase(), ext = m[3].toLowerCase();
    if (!sets.has(base)) sets.set(base, { base });
    const s = sets.get(base);
    if (ext === 'prj') { if (!s.prj) s.prj = await f.text(); }
    else if (layer !== 'W') {
      const t = parseDbf(await f.arrayBuffer());
      s[layer] = t.records;
      if (layer === 'S') s.sFields = t.fields;
    }
  }
  const out = [];
  for (const s of sets.values()) {
    if (!s.V || !s.S) {
      throw new Error(`"${s.base}" needs both ${s.base}_V.dbf (vectors) and ${s.base}_S.dbf (stations); ` +
                      'select all the files Walls wrote');
    }
    out.push(s);
  }
  if (!out.length) throw new Error('no Walls shapefile set in the selection (files named <name>_V.dbf, <name>_S.dbf, …)');
  return out;
}

export function isWallsSelection(files) {
  return [...files].some(f => /_[VS]\.dbf$/i.test(f.name));
}

// ── .prj → { zone, south, datum, geographic } ───────────────────────────────
export function parsePrj(text) {
  const t = String(text || '');
  const out = { zone: null, south: false, datum: null, geographic: false };
  const z = t.match(/UTM[_ ]?Zone[_ ]?(\d{1,2})\s*([NS])?/i);
  if (z) { out.zone = parseInt(z[1], 10); out.south = (z[2] || 'N').toUpperCase() === 'S'; }
  if (/1927|NAD27|Clarke[_ ]1866/i.test(t)) out.datum = 'NAD27';
  else if (/1983|NAD83/i.test(t)) out.datum = 'NAD83';
  else if (/WGS[_ ]?(19)?84/i.test(t)) out.datum = 'WGS84';
  out.geographic = /^\s*GEOGCS/i.test(t) && !/PROJCS/i.test(t);
  return out;
}

const DATUM_PROJ = {
  WGS84: '+datum=WGS84',
  NAD83: '+datum=WGS84',                                         // < 2 m apart
  NAD27: '+ellps=clrk66 +towgs84=-8,160,176,0,0,0,0',           // CONUS mean shift
};
const utmDef = (zone, south, datum) =>
  `+proj=utm +zone=${zone}${south ? ' +south' : ''} ${DATUM_PROJ[datum] || DATUM_PROJ.WGS84} +units=m +no_defs`;

const safeName = s => String(s).replace(/\s+/g, '_');
const safeText = s => String(s).replace(/["\s]+/g, ' ').trim();
const fmt = x => (x / FT).toFixed(3);                           // metres → PLT feet
const median = a => { if (!a.length) return NaN; const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };

// ── One export set → { name, zone, south, plt, stats, warnings } ────────────
// proj4: the proj4js function (window.proj4), for datum shifts and lat/long;
// without it those steps are skipped with a warning.
export function wallsToPlt(set, proj4) {
  const warnings = [];
  const name = set.base;
  const key = (p, n) => { p = String(p || '').trim(); n = String(n || '').trim(); return n ? (p ? p + ':' + n : n) : ''; };

  // Stations
  const st = new Map();
  for (const r of set.S) {
    const k = key(r.PREFIX, r.NAME);
    if (!k || st.has(k) || ![r.X, r.Y].every(Number.isFinite)) continue;
    st.set(k, { x: r.X, y: r.Y, z: Number.isFinite(r.Z) ? r.Z : 0, lrud: [r.LEFT, r.RIGHT, r.UP, r.DOWN] });
  }
  if (!st.size) throw new Error(`"${name}": no stations with coordinates in ${name}_S.dbf`);

  // Frame: UTM in a known zone, UTM in an unknown zone (no .prj), or lat/long.
  const prj = set.prj ? parsePrj(set.prj) : null;
  const pts = [...st.values()];
  const looksGeo = pts.every(p => Math.abs(p.x) <= 180 && Math.abs(p.y) <= 90);
  const geographic = prj ? (prj.geographic || (!prj.zone && looksGeo)) : looksGeo;
  const datum = (prj && prj.datum) || 'WGS84';
  let zone = prj && prj.zone, south = !!(prj && prj.south);
  if (geographic) {
    // The X/Y columns are N12.2 in a UTM export; if a lat/long export keeps
    // two decimals, that is ~1 km — useless. Refuse rather than misplace.
    const xf = (set.sFields || []).find(f => f.name === 'X');
    if (xf && xf.dec < 6) {
      throw new Error(`"${name}" has lat/long coordinates to ${xf.dec} decimals (~${Math.round(111000 / 10 ** xf.dec)} m); ` +
                      'export again from Walls with UTM coordinates');
    }
    const lon = median(pts.map(p => p.x)), lat = median(pts.map(p => p.y));
    zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1)); south = lat < 0;
    if (!proj4) throw new Error('lat/long export needs proj4 to convert to UTM');
    const tr = proj4(`+proj=longlat ${DATUM_PROJ[datum] || DATUM_PROJ.WGS84} +no_defs`, utmDef(zone, south, 'WGS84'));
    for (const p of pts) { const [e, n] = tr.forward([p.x, p.y]); p.x = e; p.y = n; }
    warnings.push('lat/long export converted to UTM zone ' + zone + (south ? 'S' : 'N') + ' (a UTM export avoids the conversion)');
  } else if (zone && datum === 'NAD27') {
    if (proj4) {
      const tr = proj4(utmDef(zone, south, 'NAD27'), utmDef(zone, south, 'WGS84'));
      for (const p of pts) { const [e, n] = tr.forward([p.x, p.y]); p.x = e; p.y = n; }
      warnings.push('NAD27 shifted to WGS84 (CONUS mean shift, a few metres)');
    } else warnings.push('NAD27 left unshifted (no proj4): expect an offset of up to a few hundred metres');
  }
  if (!zone) warnings.push('no .prj with a UTM zone: the zone has to be entered');

  // LENGTH units (and so LRUD units): metres or feet?
  const ratios = [];
  for (const v of set.V) {
    const a = st.get(key(v.FR_PREFIX, v.FR_NAME)), b = st.get(key(v.TO_PREFIX, v.TO_NAME));
    if (!a || !b || !Number.isFinite(v.LENGTH)) continue;
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (d > 1) ratios.push(v.LENGTH / d);
  }
  const ratio = median(ratios);
  let unit = 1, units = 'm';
  if (ratio > 2.6 && ratio < 4.1) { unit = FT; units = 'ft'; }
  else if (!(ratio > 0.8 && ratio < 1.25)) {
    warnings.push(Number.isFinite(ratio) ? `LENGTH/distance ratio ${ratio.toFixed(2)}: LRUDs taken as metres`
                                         : 'no shot lengths to check: LRUDs taken as metres');
  }

  // Notes, flags, leads
  const notes = new Map(), flags = new Map();
  for (const r of set.N || []) {
    const k = key(r.PREFIX, r.NAME), t = safeText(r.NOTE || '');
    if (k && t) notes.set(k, notes.has(k) ? notes.get(k) + '; ' + t : t);
  }
  for (const r of set.F || []) {
    const k = key(r.PREFIX, r.NAME), t = safeText(r.FLAGNAME || '');
    if (k && t) { if (!flags.has(k)) flags.set(k, []); if (!flags.get(k).includes(t)) flags.get(k).push(t); }
  }

  const lines = [`Z ${safeText(name)}`];
  if (zone) lines.push(`G${south ? -zone : zone}`);
  lines.push('O WGS84');

  // Vectors, grouped by survey file in the order Walls wrote them.
  const bySrv = new Map();
  for (const v of set.V) {
    const code = safeName(String(v.SRV_NAME || '').trim() || 'WALLS');
    if (!bySrv.has(code)) bySrv.set(code, { title: String(v.SRV_TITLE || '').trim(), date: null, vecs: [] });
    const g = bySrv.get(code);
    if (!g.date && Number.isFinite(v.DATE) && v.DATE > 18000101) g.date = v.DATE;
    g.vecs.push(v);
  }
  const emitted = new Set();
  const lrudTok = lr => {
    const vals = lr.map(x => Number.isFinite(x) ? x * unit : null);
    if (vals.every(x => x == null)) return '';
    const f = x => (x == null ? '-9.90' : (x / FT).toFixed(2));
    return ` P ${f(vals[0])} ${f(vals[2])} ${f(vals[3])} ${f(vals[1])}`;     // PLT order: L U D R
  };
  let shots = 0, skipped = 0;
  for (const [code, g] of bySrv) {
    const d = g.date ? String(Math.round(g.date)) : null;
    const dateTok = d && d.length === 8 ? `${+d.slice(4, 6)} ${+d.slice(6, 8)} ${d.slice(0, 4)}` : '1 1 1900';
    lines.push(`N${code} D ${dateTok} C${safeText(g.title || code)}`);
    let open = null;
    const point = (cmd, k) => {
      const p = st.get(k);
      let l = `${cmd} ${fmt(p.y)} ${fmt(p.x)} ${fmt(p.z)} S${safeName(k)}${lrudTok(p.lrud)}`;
      if (!emitted.has(k)) {
        emitted.add(k);
        const c = [(flags.get(k) || []).map(f => '[' + f + ']').join(' '), notes.get(k) || ''].filter(Boolean).join(' ');
        if (c) l += ` "${c}"`;
      }
      lines.push(l);
    };
    for (const v of g.vecs) {
      let a = key(v.FR_PREFIX, v.FR_NAME), b = key(v.TO_PREFIX, v.TO_NAME);
      if (!a || !b || a === b || !st.has(a) || !st.has(b)) { skipped++; continue; }
      if (open === b) [a, b] = [b, a];                  // entered from its far end: keep the chain going
      if (open !== a) point('M', a);
      point('D', b);
      open = b;
      shots++;
    }
  }

  // Leads: stations flagged with anything containing "lead".
  let leads = 0;
  for (const [k, fl] of flags) {
    if (!emitted.has(k) || !fl.some(f => /lead/i.test(f))) continue;
    lines.push(`;LEAD\t${safeName(k)}\t${JSON.stringify({ d: notes.get(k) || fl.join(', '), done: false })}`);
    leads++;
  }
  if (skipped) warnings.push(`${skipped} vectors left out (a station missing from ${name}_S.dbf, or no to-station)`);

  return {
    name, zone: zone || null, south, plt: lines.join('\n') + '\n', warnings,
    stats: { surveys: bySrv.size, shots, stations: emitted.size, skipped, leads, notes: notes.size, units, datum },
  };
}
