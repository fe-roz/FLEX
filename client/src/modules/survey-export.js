// survey-export.js — a cave's survey written out as Survex (.svx), CSV (one
// row per shot) and Compass plot (.plt), from what FLEX holds of it: the
// parsed survey file (flex.js parsePLT), its placement and, in a project, its
// segments' dates and teams.
//
// FLEX keeps station positions, not the readings taken in the cave, so every
// shot is worked out from the two stations it joins: length, azimuth (from
// the file's north) and inclination are the reduced shot. Each file says so
// in its header, with what it can't carry.
//
// Browser: window._surveyExport = { model, svx, csv, plt, files }.
// Node (tests): module.exports, same functions.
//
//   model(parsed, { name, georef, segments })   → { name, surveys: [{ code, desc, date, team, shots, stations }], … }
//   files(parsed, opts, formats)                → [{ name: '<cave>.svx', text, type }]
(function (root) {
  'use strict';
  const FT = 0.3048;
  const r3 = x => (Math.round(x * 1000) / 1000).toFixed(3);
  const r2 = x => (Math.round(x * 100) / 100).toFixed(2);
  const deg = Math.PI / 180;

  /** One shot between two parsed points (metres). */
  function shot(a, b) {
    const dn = b.n - a.n, de = b.e - a.e, dv = b.v - a.v;
    const h = Math.hypot(dn, de), len = Math.hypot(h, dv);
    let az = Math.atan2(de, dn) / deg; if (az < 0) az += 360;
    const inc = len > 1e-9 ? Math.atan2(dv, h) / deg : 0;
    return { len, az: h > 1e-6 ? az : null, inc };          // az null: plumbed (straight up or down) or zero length
  }

  /** The teams of a segment list, by survey: survey code → [names]. */
  function splitTeam(t) { return String(t || '').split(/\s*(?:[,;&/+]|\band\b)\s*/i).map(s => s.trim()).filter(Boolean); }

  /**
   * What gets written, from parsePLT's result.
   * opts.name: the cave's name; opts.georef: FLEX's placement (anchor / utm / none);
   * opts.segments: [{ date, team, shots: [[from, to]…] }] (project segments of this cave).
   */
  function model(parsed, opts) {
    opts = opts || {};
    const surveys = [], byCode = new Map();
    const getSurvey = code => {
      let s = byCode.get(code);
      if (!s) {
        const info = (parsed.surveys || []).find(x => x.code === code) || { code, desc: '' };
        s = { code, desc: info.desc || '', date: info.date || '', team: [], shots: [], stations: new Map(), passages: [] };
        byCode.set(code, s); surveys.push(s);
      }
      return s;
    };
    (parsed.surveys || []).forEach(x => getSurvey(x.code));
    let unnamed = 0;
    const nameOf = p => p.name || (p._xname || (p._xname = '_u' + (++unnamed)));
    const station = new Map();                              // name → first position seen
    const lossy = { unnamed: 0, excluded: 0, flags: new Set(), comments: 0, leads: (parsed.leads || []).length, plumbed: 0 };
    (parsed.segments || []).forEach(seg => {
      const s = getSurvey(seg.survey || '');
      seg.points.forEach((p, i) => {
        const nm = nameOf(p);
        if (!p.name) lossy.unnamed++;
        if (!station.has(nm)) station.set(nm, { n: p.n, e: p.e, v: p.v });
        if (p.lrud && !s.stations.has(nm)) s.stations.set(nm, p.lrud);
        if (p.lrud) { if (!i || !s.passages.length || s.passages[s.passages.length - 1].seg !== seg) s.passages.push({ seg, list: [] }); s.passages[s.passages.length - 1].list.push([nm, p.lrud]); }
        if (!i) return;
        const a = seg.points[i - 1], k = shot(a, p);
        if (k.az == null && k.len > 1e-6) lossy.plumbed++;
        const flags = String(p.flags || '');
        flags.split('').forEach(f => f && lossy.flags.add(f));
        if (p.excluded) lossy.excluded++;
        if (p.comment) lossy.comments++;
        s.shots.push({ from: nameOf(a), to: nm, len: k.len, az: k.az, inc: k.inc, fromLrud: a.lrud || null, toLrud: p.lrud || null,
          flags, excluded: !!p.excluded, surface: flags.includes('S') || !!p.isSurface, comment: p.comment || '', a, b: p, dist: p.dist });
      });
    });
    // Segments: date and team for the surveys whose shots they hold.
    const segs = Array.isArray(opts.segments) ? opts.segments : [];
    if (segs.length) {
      const segOf = new Map();
      segs.forEach(g => (g.shots || []).forEach(([a, b]) => { segOf.set(a + '|' + b, g); segOf.set(b + '|' + a, g); }));
      surveys.forEach(s => {
        const team = new Set(), dates = new Set();
        s.shots.forEach(k => { const g = segOf.get(k.from + '|' + k.to); if (!g) return; splitTeam(g.team).forEach(x => team.add(x)); if (g.date) dates.add(String(g.date).slice(0, 10)); });
        s.team = [...team];
        if (!s.date && dates.size) s.date = [...dates].sort()[0];
      });
    }
    const first = (parsed.segments || []).find(g => g.points.length);
    return { name: opts.name || parsed._fileName || 'Cave', surveys: surveys.filter(s => s.shots.length || s.stations.size), station,
      firstStation: first ? nameOf(first.points[0]) : null, georef: opts.georef || null, parsed, lossy,
      utmZone: parsed.utmZone || null, utmSouth: !!parsed.utmSouth, datum: parsed.datum || null, fixed: parsed.fixedStations || [] };
  }

  const today = () => new Date().toISOString().slice(0, 10);
  function lossLines(M, fmt) {
    const L = M.lossy, out = [];
    out.push('Shots are worked out from the station positions FLEX holds (it keeps positions, not the readings):');
    out.push('length, azimuth and inclination are the reduced shots, with any loop closure of the source in them;');
    out.push('instrument readings, back-sights, calibrations and the original units are not kept.');
    out.push('No splays: the survey file FLEX reads holds none apart from ordinary shots.');
    if (fmt !== 'plt' && L.leads) out.push(L.leads + ' lead(s) in FLEX\'s survey file are not written here (they are in the .plt).');
    if (fmt === 'csv') out.push('L/R/U/D are at the From station; a station only ever reached as the last of a line keeps its LRUD in the .svx and .plt only.');
    if (L.unnamed) out.push(L.unnamed + ' unnamed station(s) got names starting with _u.');
    if (L.excluded) out.push(L.excluded + ' shot(s) were marked "not drawn" in the source' + (fmt === 'svx' ? ' (kept as normal legs, with a comment)' : fmt === 'csv' ? ' (flag d)' : '') + '.');
    if (fmt === 'svx' && L.flags.size) out.push('Compass shot flags: S → *flags surface, L → *flags duplicate; others (' + ([...L.flags].filter(f => !/[SL]/.test(f)).join('') || 'none') + ') only as comments.');
    if (fmt !== 'plt' && L.plumbed) out.push(L.plumbed + ' plumbed shot(s) (straight up or down): no azimuth.');
    return out;
  }

  // ── Survex ────────────────────────────────────────────────────────────────
  const svxName = s => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_') || '_';
  const svxQuote = s => '"' + String(s || '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ') + '"';
  function utmZoneOf(lon) { return Math.min(60, Math.max(1, Math.floor((((lon + 180) % 360) + 360) % 360 / 6) + 1)); }
  function svx(M) {
    // Station names Survex takes: letters, digits, _ and -. Others changed, collisions numbered.
    const map = new Map(), used = new Set(), renamed = [];
    const sn = n => {
      if (map.has(n)) return map.get(n);
      let s = svxName(n), k = 2;
      while (used.has(s)) s = svxName(n) + '_' + k++;
      used.add(s); map.set(n, s); if (s !== n) renamed.push(n + ' → ' + s);
      return s;
    };
    M.surveys.forEach(s => { s.shots.forEach(k => { sn(k.from); sn(k.to); }); s.stations.forEach((_, n) => sn(n)); });
    const g = M.georef || {}, L = [], body = [];
    L.push('; ' + M.name + ' — survey written by FLEX on ' + today());
    L.push('; Units: metres and degrees (tape in metres; compass and clino in degrees).');
    lossLines(M, 'svx').forEach(x => L.push('; ' + x));
    if (renamed.length) L.push('; Station names changed for Survex: ' + renamed.slice(0, 40).join(', ') + (renamed.length > 40 ? ' …' : ''));
    L.push('*begin ' + svxName(M.name));
    L.push('*title ' + svxQuote(M.name));
    L.push('*units tape metres');
    L.push('*units compass clino degrees');
    if (g.mode === 'anchor' && isFinite(g.lat) && isFinite(g.lon)) {
      const st = g.station && g.station !== '__first__' && M.station.has(g.station) ? g.station : M.firstStation;
      const z = utmZoneOf(+g.lon), d = g.declination == null ? 0 : +g.declination;
      L.push('; Placed in FLEX: station ' + st + ' anchored at longitude, latitude, height (metres, as FLEX holds it: WGS84).');
      L.push('; Azimuths are from the survey file\'s north; FLEX turns the cave by the declination below to place it, and so does Survex.');
      L.push('*cs long-lat');
      L.push('*cs out UTM' + z + (+g.lat < 0 ? 'S' : 'N'));
      L.push('*declination ' + r2(d) + ' degrees');
      L.push('*fix ' + sn(st) + ' ' + (+g.lon).toFixed(7) + ' ' + (+g.lat).toFixed(7) + ' ' + r3(+g.elev || 0));
    } else if (M.firstStation) {
      const p = M.station.get(M.firstStation);
      const utm = (g.mode === 'utm' && (g.zone || M.utmZone)) || (!g.mode && M.utmZone);
      if (utm) {
        const south = g.mode === 'utm' && g.south != null ? !!g.south : M.utmSouth;
        L.push('; Placed in FLEX by the survey file\'s own UTM coordinates (zone ' + utm + (south ? 'S' : 'N') + '); azimuths are grid bearings.');
        L.push('*cs UTM' + utm + (south ? 'S' : 'N'));
        L.push('*cs out UTM' + utm + (south ? 'S' : 'N'));
      } else L.push('; Not placed: the first station is fixed at its position in the survey file (metres).');
      L.push('*declination 0 degrees');
      L.push('*fix ' + sn(M.firstStation) + ' ' + r3(p.e) + ' ' + r3(p.n) + ' ' + r3(p.v));
    }
    M.surveys.forEach(s => {
      body.push('');
      body.push('*begin ; survey ' + (s.code || '(no name)') + (s.desc ? ': ' + s.desc.replace(/[\r\n]+/g, ' ') : ''));
      if (/^\d{4}-\d{2}-\d{2}$/.test(s.date)) body.push('*date ' + s.date.replace(/-/g, '.'));
      s.team.forEach(t => body.push('*team ' + svxQuote(t)));
      if (s.shots.length) {
        body.push('*data normal from to tape compass clino');
        let surf = false, dup = false;
        s.shots.forEach(k => {
          const wantSurf = k.surface, wantDup = k.flags.includes('L');
          if (wantSurf !== surf) { body.push('*flags ' + (wantSurf ? '' : 'not ') + 'surface'); surf = wantSurf; }
          if (wantDup !== dup) { body.push('*flags ' + (wantDup ? '' : 'not ') + 'duplicate'); dup = wantDup; }
          const note = [k.excluded ? 'not drawn in source' : '', k.flags ? 'flags ' + k.flags : '', k.comment].filter(Boolean).join('; ');
          const plumb = k.az == null && k.len > 1e-6;
          body.push(sn(k.from) + ' ' + sn(k.to) + ' ' + r3(k.len) + ' ' + (plumb ? '-' : r2(k.az == null ? 0 : k.az)) + ' ' + (plumb ? (k.inc > 0 ? 'up' : 'down') : r2(k.inc)) + (note ? ' ; ' + note.replace(/[\r\n]+/g, ' ') : ''));
        });
        if (surf) body.push('*flags not surface');
        if (dup) body.push('*flags not duplicate');
      }
      s.passages.forEach(ps => {                             // one passage per line of shots
        body.push('*data passage station left right up down');
        ps.list.forEach(([n, l]) => body.push(sn(n) + ' ' + r3(l.l) + ' ' + r3(l.r) + ' ' + r3(l.u) + ' ' + r3(l.d)));
      });
      body.push('*end');
    });
    return L.concat(body, ['', '*end ' + svxName(M.name), '']).join('\n');
  }

  // ── CSV ───────────────────────────────────────────────────────────────────
  const csvCell = v => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const CSV_COLS = ['survey', 'from', 'to', 'length_m', 'azimuth_deg', 'inclination_deg', 'left_m', 'right_m', 'up_m', 'down_m', 'date', 'flags', 'comment'];
  function csv(M) {
    const L = ['# ' + M.name + ' — shots written by FLEX on ' + today()];
    L.push('# Units: metres and degrees. Azimuth from the survey file\'s north' +
      (M.georef && M.georef.mode === 'anchor' ? ' (FLEX adds a declination of ' + r2(M.georef.declination || 0) + '° to place the cave)' : '') + '; inclination up is positive.');
    lossLines(M, 'csv').forEach(x => L.push('# ' + x));
    L.push(CSV_COLS.join(','));
    M.surveys.forEach(s => s.shots.forEach(k => {
      const l = k.fromLrud;
      const fl = (k.excluded ? 'd' : '') + k.flags;
      L.push([s.code, k.from, k.to, r3(k.len), k.az == null ? '' : r2(k.az), r2(k.inc),
        l ? r3(l.l) : '', l ? r3(l.r) : '', l ? r3(l.u) : '', l ? r3(l.d) : '', s.date || '', fl, k.comment].map(csvCell).join(','));
    }));
    return L.join('\n') + '\n';
  }

  // ── Compass plot (.plt) ───────────────────────────────────────────────────
  // Positions in feet (the format's unit), as parsePLT reads them back.
  const ft = m => (m / FT).toFixed(2);
  const pltName = s => String(s || '').replace(/\s+/g, '_') || '_';
  function plt(M) {
    const P = M.parsed, segs = P.segments || [];
    let bb = null;
    const grow = (b, p) => b ? [Math.min(b[0], p.n), Math.max(b[1], p.n), Math.min(b[2], p.e), Math.max(b[3], p.e), Math.min(b[4], p.v), Math.max(b[5], p.v)] : [p.n, p.n, p.e, p.e, p.v, p.v];
    segs.forEach(g => g.points.forEach(p => { bb = grow(bb, p); }));
    const box = b => b ? b.map(ft).join(' ') : '0 0 0 0 0 0';
    const L = [];
    L.push('; ' + M.name + ' — Compass plot file written by FLEX on ' + today());
    L.push('; Units: positions and passage sizes (LRUD) in feet, as the format has them; FLEX shows metres.');
    const g = M.georef || {};
    if (g.mode === 'anchor') L.push('; Placed in FLEX: station ' + (g.station || '') + ' at latitude ' + g.lat + ', longitude ' + g.lon + ', height ' + g.elev + ' m, declination ' + (g.declination == null ? 0 : g.declination) + '°.');
    L.push('; Written from the positions FLEX holds: stations, passage sizes, distances, flags, comments and FLEX leads as read; no original readings.');
    L.push('Z ' + box(bb));
    L.push('S' + String(M.name).replace(/[\r\n]+/g, ' '));
    if (M.datum) L.push('O' + M.datum);
    if (M.utmZone) L.push('G' + (M.utmSouth ? -M.utmZone : M.utmZone));
    const bySurvey = new Map();
    segs.forEach(sg => { const k = sg.survey || ''; if (!bySurvey.has(k)) bySurvey.set(k, []); bySurvey.get(k).push(sg); });
    const order = (P.surveys || []).map(s => s.code).filter(c => bySurvey.has(c));
    bySurvey.forEach((_, k) => { if (!order.includes(k)) order.push(k); });
    order.forEach(code => {
      const info = (P.surveys || []).find(s => s.code === code) || { code, desc: '' };
      const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(info.date || '');
      L.push('N' + pltName(code || 'SURVEY') + ' D ' + (dm ? (+dm[2]) + ' ' + (+dm[3]) + ' ' + dm[1] : '1 1 1') + ' C' + String(info.desc || '').replace(/[\r\n]+/g, ' '));
      let sb = null;
      bySurvey.get(code).forEach(sg => sg.points.forEach((p, i) => {
        sb = grow(sb, p);
        const t = [i ? (p.excluded ? 'd' : 'D') : 'M', ft(p.n), ft(p.e), ft(p.v), 'S' + pltName(p.name || p._xname)];
        if (p.lrud) t.push('P', ft(p.lrud.l), ft(p.lrud.u), ft(p.lrud.d), ft(p.lrud.r));
        if (p.dist != null && isFinite(p.dist)) t.push('I', ft(p.dist));
        if (p.flags) t.push('F' + p.flags);
        L.push(t.join(' ') + (p.comment ? ' "' + String(p.comment).replace(/"/g, "'") + '"' : ''));
      }));
      L.push('X ' + box(sb));
    });
    (M.fixed || []).forEach(f => L.push('P' + pltName(f.name) + ' ' + ft(f.n) + ' ' + ft(f.e) + ' ' + ft(f.v)));
    (P.leads || []).forEach(ld => { const o = Object.assign({}, ld); delete o.station; L.push(';LEAD\t' + ld.station + '\t' + JSON.stringify(o)); });
    return L.join('\r\n') + '\r\n';
  }

  const FORMATS = { svx: { fn: svx, type: 'text/plain' }, csv: { fn: csv, type: 'text/csv' }, plt: { fn: plt, type: 'text/plain' } };
  /** The files for the formats asked for (default all three), named after the cave. */
  function files(parsed, opts, formats) {
    const M = model(parsed, opts);
    const base = String((opts && opts.fileBase) || M.name).replace(/\.(plt|json)$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim() || 'Cave';
    return (formats && formats.length ? formats : ['svx', 'csv', 'plt']).filter(f => FORMATS[f])
      .map(f => ({ name: base + '.' + f, text: FORMATS[f].fn(M), type: FORMATS[f].type }));
  }

  const api = { model, svx, csv, plt, files, CSV_COLS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root._surveyExport = api;
})(typeof window !== 'undefined' ? window : null);
