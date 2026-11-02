// breakout.js — Breakout survey import. Reads a Breakout JSON export and turns
// each cave in it into Compass PLT text, so it goes through the same parser,
// renderer, recents cache, passage walls and export as a .plt file.
//
// Placement comes from the file's fixed stations (finished UTM coordinates in
// metres, written for nearly every station). A station without coordinates is
// placed from a shot to a neighbour that has them; anything not connected to
// a placed station is left out and counted.
//
// Leads ride along as ';LEAD' lines, which Compass readers ignore and
// parsePLT in flex.js collects.

const FT = 0.3048;

const LEN_UNITS = { m: 1, cm: 0.01, mm: 0.001, km: 1000, ft: FT, in: FT / 12, yd: 3 * FT, mi: 1609.344 };
const ANGLE_UNITS = { deg: 1, grad: 0.9, gon: 0.9, mil: 360 / 6400, rad: 180 / Math.PI };

// "12.5" in the trip's unit, or "5 in" / "3m" with its own.
function parseLength(v, defUnit) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v * (LEN_UNITS[defUnit] ?? FT) : null;
  if (Array.isArray(v)) return parseLength(v[0], v[1] || defUnit);
  const m = String(v).trim().match(/^(-?[\d.]+)\s*([a-z]*)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const u = (m[2] || defUnit || 'ft').toLowerCase();
  return n * (LEN_UNITS[u] ?? LEN_UNITS[defUnit] ?? FT);
}

function parseAngle(v, defUnit) {
  if (v == null || v === '') return null;
  const m = String(v).trim().match(/^(-?[\d.]+)\s*([a-z%]*)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const u = (m[2] || defUnit || 'deg').toLowerCase();
  if (u === '%') return Math.atan(n / 100) * 180 / Math.PI;     // percent grade
  return n * (ANGLE_UNITS[u] ?? 1);
}

// Mean of two bearings in degrees, around the circle.
function meanAzm(a, b) {
  const r = Math.PI / 180;
  const x = Math.cos(a * r) + Math.cos(b * r), y = Math.sin(a * r) + Math.sin(b * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

// A shot's vector in metres (dE, dN, dV) from its measurements, or null.
function shotVector(meas, trip) {
  let dist = null, azF = null, azB = null, inF = null, inB = null;
  for (const m of meas || []) {
    const d = parseLength(m.dist, trip.distUnit);
    if (d != null && dist == null) dist = d;
    const az = parseAngle(m.azm, trip[m.dir === 'bs' ? 'azmBsUnit' : 'azmFsUnit'] || trip.angleUnit);
    const inc = parseAngle(m.inc, trip[m.dir === 'bs' ? 'incBsUnit' : 'incFsUnit'] || trip.angleUnit);
    if (m.dir === 'bs') {
      if (az != null) azB = trip.azmBacksightsCorrected ? az : (az + 180) % 360;
      if (inc != null) inB = trip.incBacksightsCorrected ? inc : -inc;
    } else {
      if (az != null) azF = az;
      if (inc != null) inF = inc;
    }
  }
  if (dist == null) return null;
  const azm = azF != null && azB != null ? meanAzm(azF, azB) : (azF ?? azB);
  const inc = inF != null && inB != null ? (inF + inB) / 2 : (inF ?? inB ?? 0);
  const r = Math.PI / 180;
  const h = dist * Math.cos(inc * r);
  if (azm == null && Math.abs(Math.abs(inc) - 90) > 1e-6) return null;
  const a = (azm ?? 0) * r;
  return [h * Math.sin(a), h * Math.cos(a), dist * Math.sin(inc * r)];
}

// Walk a trip's survey list into shots: [{from, to, meas, excludeDist, comment}].
// The list alternates station / shot slot; a slot that is {} or null means no
// shot between the surrounding stations (Breakout uses it to restart a chain).
function tripShots(trip) {
  const shots = [];
  let prev = null, slot = null;
  for (const it of trip.survey || []) {
    if (it && it.station != null) {
      if (prev != null && slot && slot.measurements && slot.measurements.length) {
        shots.push({ from: prev, to: String(it.station), meas: slot.measurements,
                     excludeDist: !!slot.excludeDist, comment: slot.comment || null });
      }
      prev = String(it.station);
      slot = null;
    } else {
      slot = it || {};
    }
  }
  return shots;
}

function tripLruds(trip) {
  const out = new Map();
  for (const it of trip.survey || []) {
    if (!it || it.station == null || !Array.isArray(it.lrud) || out.has(String(it.station))) continue;
    const [l, r, u, d] = it.lrud.map(v => parseLength(v, trip.distUnit));
    if ([l, r, u, d].some(v => v != null)) out.set(String(it.station), { l, r, u, d });
  }
  return out;
}

const fmt = x => (x / FT).toFixed(3);                          // metres → PLT feet
const safeName = s => String(s).replace(/\s+/g, '_');
const safeText = s => String(s).replace(/[\r\n"]+/g, ' ').trim();

function convertCave(caveName, cave) {
  // Station coordinates (metres, UTM) from fixedStations.
  const pos = new Map();
  let zone = null, south = false;
  for (const fs of cave.fixedStations || []) {
    if (fs.utmZone != null) { zone = Math.abs(parseInt(fs.utmZone, 10)); south = String(fs.utmZone).startsWith('-') || fs.utmZoneSouth === true; }
    const unit = fs.distUnit || 'm';
    for (const [name, c] of Object.entries(fs.stations || {})) {
      const n = parseLength(c.north, unit), e = parseLength(c.east, unit), v = parseLength(c.elev, unit);
      if ([n, e, v].every(Number.isFinite)) pos.set(String(name), [e, n, v]);
    }
  }
  const trips = cave.trips || [];
  const tripShotLists = trips.map(tripShots);

  // Place stations missing from fixedStations by walking shots out from placed ones.
  // Raw shot bearings are magnetic/survey north, while Breakout's coordinates
  // already include declination and grid convergence (about -2 deg at the
  // Kentucky caves). Measure that rotation from shots whose both ends are
  // placed and apply it to the computed ones.
  const allShots = [];
  tripShotLists.forEach((list, ti) => list.forEach(s => allShots.push([s, trips[ti]])));
  const rots = [];
  for (const [s, trip] of allShots) {
    const a = pos.get(s.from), b = pos.get(s.to);
    if (!a || !b) continue;
    const v = shotVector(s.meas, trip);
    if (!v || Math.hypot(v[0], v[1]) < 3 || Math.hypot(b[0] - a[0], b[1] - a[1]) < 3) continue;
    let r = Math.atan2(b[0] - a[0], b[1] - a[1]) - Math.atan2(v[0], v[1]);
    r = Math.atan2(Math.sin(r), Math.cos(r));
    rots.push(r);
  }
  rots.sort((x, y) => x - y);
  const rot = rots.length ? rots[rots.length >> 1] : 0;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const turn = v => [v[0] * cr + v[1] * sr, -v[0] * sr + v[1] * cr, v[2]];
  let added = true;
  while (added) {
    added = false;
    for (const [s, trip] of allShots) {
      const a = pos.get(s.from), b = pos.get(s.to);
      if ((a && b) || (!a && !b)) continue;
      const raw = shotVector(s.meas, trip);
      if (!raw) continue;
      const vec = turn(raw);
      if (a) pos.set(s.to, [a[0] + vec[0], a[1] + vec[1], a[2] + vec[2]]);
      else pos.set(s.from, [b[0] - vec[0], b[1] - vec[1], b[2] - vec[2]]);
      added = true;
    }
  }

  const lines = [];
  lines.push(`Z ${safeText(caveName)}`);
  if (zone) lines.push(`G${south ? -zone : zone}`);
  lines.push('O WGS84');
  const stationNames = new Set();
  const unplaced = new Set();
  let shotCount = 0;

  trips.forEach((trip, ti) => {
    const code = 'T' + String(ti + 1).padStart(4, '0');
    const dt = trip.date ? new Date(trip.date) : null;
    const dateTok = dt && !isNaN(dt) ? `${dt.getUTCMonth() + 1} ${dt.getUTCDate()} ${dt.getUTCFullYear()}` : '1 1 1900';
    const desc = safeText(trip.name || code) + (trip.date ? ` (${String(trip.date).slice(0, 10)})` : '');
    lines.push(`N${code} D ${dateTok} C${desc}`);
    const lruds = tripLruds(trip);
    let open = null;                                   // last point emitted in the current segment
    const point = (cmd, name, comment) => {
      const [e, n, v] = pos.get(name);
      let l = `${cmd} ${fmt(n)} ${fmt(e)} ${fmt(v)} S${safeName(name)}`;
      const lr = lruds.get(name);
      if (lr) {
        const f = x => (x == null || !Number.isFinite(x) ? '-9.90' : (x / FT).toFixed(2));
        l += ` P ${f(lr.l)} ${f(lr.u)} ${f(lr.d)} ${f(lr.r)}`;
      }
      if (comment) l += ` "${safeText(comment)}"`;
      lines.push(l);
      stationNames.add(name);
    };
    for (const s of tripShotLists[ti]) {
      if (!pos.has(s.from) || !pos.has(s.to)) {
        if (!pos.has(s.from)) unplaced.add(s.from);
        if (!pos.has(s.to)) unplaced.add(s.to);
        open = null;
        continue;
      }
      if (open !== s.from) point('M', s.from);
      point('D', s.to, s.comment);
      open = s.to;
      shotCount++;
    }
  });

  // Leads: one ';LEAD' line each — station, then a small JSON record.
  let leadCount = 0;
  for (const ld of cave.leads || []) {
    if (!ld || ld.station == null || !pos.has(String(ld.station))) continue;
    const rec = { d: ld.description || '', done: !!ld.done };
    if (ld.date) rec.t = String(ld.date).slice(0, 10);
    const w = ld.width ? parseLength(ld.width[0], ld.width[1]) : null;
    const h = ld.height ? parseLength(ld.height[0], ld.height[1]) : null;
    if (w != null) rec.w = +w.toFixed(2);
    if (h != null) rec.h = +h.toFixed(2);
    lines.push(`;LEAD\t${safeName(ld.station)}\t${JSON.stringify(rec)}`);
    leadCount++;
  }

  return {
    name: caveName, zone, south, plt: lines.join('\n') + '\n',
    stats: { trips: trips.length, stations: stationNames.size, shots: shotCount,
             unplaced: unplaced.size, leads: leadCount },
  };
}

// → [{name, zone, south, plt, stats}] for every cave in the file.
export function breakoutToPlt(data) {
  if (!data || typeof data !== 'object' || !data.caves) throw new Error('not a Breakout file (no "caves")');
  return Object.entries(data.caves).map(([name, cave]) => convertCave(name, cave));
}

export function isBreakoutFile(data) {
  return !!(data && typeof data === 'object' && data.caves && typeof data.caves === 'object');
}
