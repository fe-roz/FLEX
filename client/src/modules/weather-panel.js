// weather-panel.js — a small Weather card for an area: "Weather: <name>", from Open-Meteo (several models side by side) and, in the US,
// the National Weather Service's text forecast as a second opinion.
//
//   Entry points   🔬 Analyze → Weather (the area picker's area, Show weather); right-click the map → Weather here;
//                  window._weather.open({ name, ring }) or open({ name, lon, lat }).
//   Points         the area's centre; when the ground spans more than 300 m of height also its lowest and highest sampled spot,
//                  each with its elevation (terrain shown, sampled on a coarse grid).
//   Privacy        coordinates are rounded to 2 decimals (about 1 km) before any request and NOTHING else is sent: no names, no ids.
//                  Requests: GET api.open-meteo.com/v1/forecast, and (US only) GET api.weather.gov/points/<lat,lon> then its forecast link.
//   Offline        the last answer per point is kept in localStorage (flex.weather.*) and shown, marked with its age, when the
//                  request fails. The service worker never keeps these requests (sw.js NEVER_HOST).
//   Charts         hand-drawn SVG, drawn once per change (no animation).
//
// window._weather = { open, close, refresh, state, pure, sampler }   sampler: optional async ([{lon,lat}]) => [metres] (tests)
// Node (tools/test_weather.js): module.exports = pure.
(function (root) {
  'use strict';

  // ── Pure ──────────────────────────────────────────────────────────────────
  const MODELS = ['best_match', 'gfs_seamless', 'ecmwf_ifs025', 'icon_seamless'];
  const MODEL_NAME = { best_match: 'Best match', gfs_seamless: 'GFS', ecmwf_ifs025: 'ECMWF', icon_seamless: 'ICON' };
  const HOURLY = ['temperature_2m', 'precipitation', 'rain', 'snowfall', 'snow_depth', 'freezing_level_height', 'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'cloud_cover', 'weather_code'];
  const DAILY = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'sunrise', 'sunset', 'precipitation_sum', 'snowfall_sum', 'wind_gusts_10m_max'];
  const SPREAD_M = 300;

  const r2 = x => Math.round(x * 100) / 100;
  const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
  const mean = a => { const v = a.filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const maxOf = a => { const v = a.filter(x => x != null); return v.length ? Math.max(...v) : null; };
  const minOf = a => { const v = a.filter(x => x != null); return v.length ? Math.min(...v) : null; };

  /** The Open-Meteo request: coordinates to 2 decimals, elevation to 10 m, nothing else about the place. */
  function omUrl(lon, lat, elev, days) {
    const q = ['latitude=' + r2(lat), 'longitude=' + r2(lon)];
    if (num(elev) != null) q.push('elevation=' + Math.round(elev / 10) * 10);
    q.push('hourly=' + HOURLY.join(','), 'daily=' + DAILY.join(','), 'timezone=auto', 'forecast_days=' + (days || 10), 'models=' + MODELS.join(','));
    return 'https://api.open-meteo.com/v1/forecast?' + q.join('&');
  }
  const nwsPointsUrl = (lon, lat) => 'https://api.weather.gov/points/' + r2(lat) + ',' + r2(lon);
  /** Roughly the US (50 states): the only places the NWS answers. */
  const inUS = (lon, lat) => (lat >= 24 && lat <= 50 && lon >= -125 && lon <= -66) || (lat >= 51 && lat <= 72 && lon >= -170 && lon <= -129) || (lat >= 18 && lat <= 23 && lon >= -161 && lon <= -154);
  const storeKey = (lon, lat, elev) => 'flex.weather.' + r2(lat) + ',' + r2(lon) + ',' + (num(elev) != null ? Math.round(elev / 10) * 10 : 'x');

  /** Open-Meteo JSON → { tz, offset, elevation, models, t[], h[model][var][], dates[], d[model][var][] }. Variables come suffixed per model. */
  function parseOM(j) {
    if (!j || !j.hourly || !j.hourly.time) return null;
    const out = { tz: j.timezone || '', offset: num(j.utc_offset_seconds) || 0, elevation: num(j.elevation), t: j.hourly.time.slice(), dates: ((j.daily || {}).time || []).slice(), models: [], h: {}, d: {} };
    const pick = (blk, base, m) => { const a = blk[base + '_' + m] || (m === MODELS[0] && blk[base]) || null; return a ? a.map(num) : null; };
    const strs = (blk, base, m) => { const a = blk[base + '_' + m] || (m === MODELS[0] && blk[base]) || null; return a ? a.slice() : null; };
    MODELS.forEach(m => {
      const H = {}, D = {}; let any = false;
      HOURLY.forEach(v => { const a = pick(j.hourly, v, m); H[v] = a || out.t.map(() => null); if (a && a.some(x => x != null)) any = true; });
      DAILY.forEach(v => { const a = (v === 'sunrise' || v === 'sunset') ? strs(j.daily || {}, v, m) : pick(j.daily || {}, v, m); D[v] = a || out.dates.map(() => null); });
      if (any) { out.models.push(m); out.h[m] = H; out.d[m] = D; }
    });
    return out.models.length ? out : null;
  }

  /** WMO weather code → plain words. */
  function codeWords(c) {
    if (c == null) return '';
    if (c === 0) return 'Clear'; if (c <= 2) return 'Mostly clear'; if (c === 3) return 'Overcast';
    if (c === 45 || c === 48) return 'Fog'; if (c >= 51 && c <= 57) return 'Drizzle';
    if (c >= 61 && c <= 65) return c === 65 ? 'Heavy rain' : 'Rain'; if (c === 66 || c === 67) return 'Freezing rain';
    if (c >= 71 && c <= 77) return c === 75 ? 'Heavy snow' : 'Snow'; if (c >= 80 && c <= 82) return 'Showers';
    if (c === 85 || c === 86) return 'Snow showers'; if (c === 95) return 'Thunderstorm'; if (c === 96 || c === 99) return 'Thunder, hail';
    return '';
  }
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayName = d => { const t = new Date(d + 'T12:00:00Z'); return WD[t.getUTCDay()] + ' ' + t.getUTCDate() + ' ' + MO[t.getUTCMonth()]; };
  const dayShort = d => WD[new Date(d + 'T12:00:00Z').getUTCDay()] + ' ' + (+d.slice(8, 10));
  const hhmm = s => (s ? String(s).slice(11, 16) : '');

  // units: sys 'metric' | 'imperial'
  const U = {
    temp: (c, s) => c == null ? '–' : Math.round(s === 'imperial' ? c * 9 / 5 + 32 : c) + '°',
    tempUnit: s => s === 'imperial' ? '°F' : '°C',
    rain: (mm, s) => mm == null ? '–' : s === 'imperial' ? (mm / 25.4).toFixed(2) + ' in' : (mm < 10 ? mm.toFixed(1) : Math.round(mm)) + ' mm',
    snow: (cm, s) => cm == null ? '–' : s === 'imperial' ? (cm / 2.54).toFixed(1) + ' in' : (cm < 10 ? cm.toFixed(1) : Math.round(cm)) + ' cm',
    wind: (kmh, s) => kmh == null ? '–' : s === 'imperial' ? Math.round(kmh * 0.621371) + ' mph' : Math.round(kmh) + ' km/h',
    len: (m, s) => m == null ? '–' : s === 'imperial' ? Math.round(m * 3.28084) + ' ft' : Math.round(m) + ' m',
  };
  const conv = {                      // number in display units, for the charts
    temp: (c, s) => c == null ? null : s === 'imperial' ? c * 9 / 5 + 32 : c,
    wind: (k, s) => k == null ? null : s === 'imperial' ? k * 0.621371 : k,
    len: (m, s) => m == null ? null : s === 'imperial' ? m * 3.28084 : m,
    rain: (mm, s) => mm == null ? null : s === 'imperial' ? mm / 25.4 : mm,
  };

  /** Which model leads: the first with temperatures. */
  const lead = P => P.models[0];

  /** One row per day in dates[i0..i1]: lead model's numbers, plus the lowest and highest across models. */
  function dayRows(P, i0, i1) {
    const rows = [], m0 = lead(P), H = P.h[m0];
    for (let i = i0; i <= i1 && i < P.dates.length; i++) {
      const date = P.dates[i], D = P.d[m0], across = k => P.models.map(m => P.d[m][k][i]).filter(x => x != null);
      const idx = []; P.t.forEach((s, k) => { if (s.slice(0, 10) === date) idx.push(k); });
      const next = P.dates[i + 1];
      const night = []; P.t.forEach((s, k) => { const h = +s.slice(11, 13); if ((s.slice(0, 10) === date && h >= 18) || (next && s.slice(0, 10) === next && h <= 8)) night.push(H.temperature_2m[k]); });
      const cloud = mean(idx.map(k => H.cloud_cover[k]));
      const ps = across('precipitation_sum'), ss = across('snowfall_sum');
      rows.push({
        date, name: dayName(date), short: dayShort(date), words: codeWords(D.weather_code[i]),
        hi: D.temperature_2m_max[i], lo: D.temperature_2m_min[i], hiRange: [minOf(across('temperature_2m_max')), maxOf(across('temperature_2m_max'))],
        night: night.some(x => x != null) ? minOf(night) : null,
        precip: D.precipitation_sum[i], precipRange: [minOf(ps), maxOf(ps)], snow: D.snowfall_sum[i], snowRange: [minOf(ss), maxOf(ss)],
        gust: D.wind_gusts_10m_max[i], cloud, rise: hhmm(D.sunrise[i]), set: hhmm(D.sunset[i]),
        disagree: ps.length > 1 && (maxOf(ps) - minOf(ps) >= Math.max(3, 0.5 * maxOf(ps))),
      });
    }
    return rows;
  }
  /** Hour indexes [a, b) covering the days i0..i1. */
  function hourSpan(P, i0, i1) {
    const d0 = P.dates[i0], d1 = P.dates[Math.min(i1, P.dates.length - 1)]; let a = -1, b = P.t.length;
    P.t.forEach((s, k) => { const d = s.slice(0, 10); if (a < 0 && d >= d0) a = k; if (d > d1 && b === P.t.length) b = k; });
    return [Math.max(0, a), b];
  }
  /** The local "now" in the same form as the hourly times. */
  const nowLocal = (P, ms) => new Date((ms == null ? Date.now() : ms) + (P.offset || 0) * 1000).toISOString().slice(0, 16);

  /** Where the freezing level is against the point's elevation: { share (0..1 of hours below you), text }. */
  function snowLine(P, a, b, elev, sys) {
    let fz = null; for (const m of P.models) { const v = P.h[m].freezing_level_height.slice(a, b); if (v.some(x => x != null)) { fz = v; break; } }
    if (!fz || num(elev) == null) return { share: null, text: fz ? '' : 'The models give no freezing level here.' };
    const ok = fz.filter(x => x != null), below = ok.filter(x => x < elev).length;
    const lo = Math.min(...ok), hi = Math.max(...ok), share = below / ok.length;
    const rng = U.len(lo, sys) + ' to ' + U.len(hi, sys);
    const text = share === 0 ? `Snow line is above you the whole time (freezing level ${rng}; you are at ${U.len(elev, sys)}).`
      : share === 1 ? `Snow line is below you the whole time (freezing level ${rng}; you are at ${U.len(elev, sys)}): expect snow or ice here.`
        : `Snow line is below you for ${Math.round(share * 100)}% of the hours (freezing level ${rng}; you are at ${U.len(elev, sys)}).`;
    return { share, text, lo, hi };
  }

  /** The area's points: centre, plus lowest and highest sample when the ground spans more than SPREAD_M. samples [{lon,lat,h}], centre {lon,lat,h?} */
  function pickPoints(centre, samples) {
    const pts = [{ key: 'centre', label: 'Middle', lon: centre.lon, lat: centre.lat, elev: num(centre.h) }];
    const ok = (samples || []).filter(s => num(s.h) != null);
    if (!ok.length) return pts;
    const lo = ok.reduce((a, s) => s.h < a.h ? s : a), hi = ok.reduce((a, s) => s.h > a.h ? s : a);
    if (pts[0].elev == null) pts[0].elev = ok.reduce((a, s) => a + s.h, 0) / ok.length;
    if (hi.h - lo.h > SPREAD_M) { pts.push({ key: 'low', label: 'Lowest', lon: lo.lon, lat: lo.lat, elev: lo.h }); pts.push({ key: 'high', label: 'Highest', lon: hi.lon, lat: hi.lat, elev: hi.h }); }
    return pts;
  }
  /** A coarse grid of sample places inside a ring's box (n × n, centres of cells), only those in the ring. */
  function gridIn(ring, n) {
    const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const inside = (x, y) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
    const out = [];
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) { const x = x0 + (x1 - x0) * (i + 0.5) / n, y = y0 + (y1 - y0) * (k + 0.5) / n; if (inside(x, y)) out.push({ lon: x, lat: y }); }
    ring.forEach(p => out.push({ lon: p[0], lat: p[1] }));
    return out;
  }
  const centreOf = ring => { const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]); return { lon: (Math.min(...xs) + Math.max(...xs)) / 2, lat: (Math.min(...ys) + Math.max(...ys)) / 2 }; };

  /** NWS answers → periods [{name, start, text, short, temp, unit, pop, wind}] */
  function parseNWS(j) {
    const ps = j && j.properties && j.properties.periods; if (!Array.isArray(ps)) return null;
    return ps.map(p => ({ name: p.name || '', start: String(p.startTime || '').slice(0, 10), startFull: p.startTime || '', text: p.detailedForecast || p.shortForecast || '', short: p.shortForecast || '', temp: num(p.temperature), unit: p.temperatureUnit || 'F', pop: p.probabilityOfPrecipitation && num(p.probabilityOfPrecipitation.value), wind: p.windSpeed || '', night: p.isDaytime === false }));
  }

  // ── SVG charts ─────────────────────────────────────────────────────────────
  const W = 720, ML = 40, MR = 8;
  const C = { grid: 'rgba(255,255,255,.12)', text: 'rgba(255,255,255,.62)', best: '#ff9f43', other: 'rgba(255,200,140,.38)', rain: '#4aa3ff', snow: '#e8f1ff', gust: '#f0c14b', wind: '#7bd88f', cloud: 'rgba(190,200,220,.45)', ice: '#8fd3ff', you: '#ff6b6b', now: 'rgba(255,255,255,.55)' };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f1 = x => (Math.round(x * 10) / 10).toString();
  /** A "nice" axis range and ticks. */
  function niceTicks(lo, hi, n) {
    if (lo == null || hi == null) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { hi = lo + 1; }
    const raw = (hi - lo) / (n || 4), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p, step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
    const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step, t = [];
    for (let v = a; v <= b + step / 2; v += step) t.push(+v.toFixed(6));
    return { lo: a, hi: b, ticks: t };
  }
  /** Frame for a chart: title, y ticks, day lines and labels. series draw callback gets (X, Y). */
  function frame(P, a, b, h, title, yr, unit, draw, opt) {
    opt = opt || {};
    const n = Math.max(1, b - a), X = i => ML + (W - ML - MR) * (i - a + 0.5) / n, Hh = h - 34, T = 18, Y = v => T + Hh * (1 - (v - yr.lo) / (yr.hi - yr.lo));
    let s = `<svg class="wx-svg" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(title)}" xmlns="http://www.w3.org/2000/svg">`;
    s += `<text x="${ML}" y="11" class="wx-ct">${esc(title)}${unit ? ' <tspan class="wx-cu">(' + esc(unit) + ')</tspan>' : ''}</text>`;
    yr.ticks.forEach(v => { s += `<line x1="${ML}" x2="${W - MR}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="${C.grid}"/><text x="${ML - 4}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end" class="wx-ax">${esc(opt.yfmt ? opt.yfmt(v) : f1(v))}</text>`; });
    for (let i = a; i < b; i++) {
      if (P.t[i].slice(11, 13) === '00') {
        s += `<line x1="${(X(i) - (W - ML - MR) / n / 2).toFixed(1)}" x2="${(X(i) - (W - ML - MR) / n / 2).toFixed(1)}" y1="${T}" y2="${T + Hh}" stroke="${C.grid}" stroke-dasharray="2 3"/>`;
      }
      if (P.t[i].slice(11, 13) === '12') s += `<text x="${X(i).toFixed(1)}" y="${h - 6}" text-anchor="middle" class="wx-ax">${esc(dayShort(P.t[i].slice(0, 10)))}</text>`;
    }
    s += draw(X, Y, Hh + T, T);
    if (opt.now != null && opt.now >= a && opt.now < b) s += `<line x1="${X(opt.now).toFixed(1)}" x2="${X(opt.now).toFixed(1)}" y1="${T}" y2="${T + Hh}" stroke="${C.now}" stroke-width="1.2"/><text x="${(X(opt.now) + 3).toFixed(1)}" y="${T + 9}" class="wx-ax">now</text>`;
    return s + '</svg>';
  }
  const path = (xs, ys) => { let d = '', pen = false; xs.forEach((x, i) => { if (ys[i] == null) { pen = false; return; } d += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + ys[i].toFixed(1); pen = true; }); return d; };
  const rng = (vals, pad) => { const v = vals.filter(x => x != null); if (!v.length) return niceTicks(0, 1, 3); const lo = Math.min(...v), hi = Math.max(...v), p = (hi - lo) * (pad || 0.05); return niceTicks(lo - p, hi + p, 4); };
  const slice = (arr, a, b) => arr.slice(a, b);

  /** Temperature: every model a line (lead model strong), 0 line. */
  function chartTemp(P, a, b, sys, now) {
    const all = []; P.models.forEach(m => slice(P.h[m].temperature_2m, a, b).forEach(v => all.push(conv.temp(v, sys))));
    const z = conv.temp(0, sys), yr = rng(all.concat([z]));
    return frame(P, a, b, 150, 'Temperature', yr, U.tempUnit(sys), (X, Y) => {
      let s = `<line x1="${ML}" x2="${W - MR}" y1="${Y(z).toFixed(1)}" y2="${Y(z).toFixed(1)}" stroke="${C.ice}" stroke-dasharray="5 3"/><text x="${W - MR - 2}" y="${(Y(z) - 3).toFixed(1)}" text-anchor="end" class="wx-ax" fill="${C.ice}">freezing</text>`;
      P.models.slice().reverse().forEach(m => {
        const xs = [], ys = []; for (let i = a; i < b; i++) { xs.push(X(i)); ys.push(P.h[m].temperature_2m[i] == null ? null : Y(conv.temp(P.h[m].temperature_2m[i], sys))); }
        s += `<path d="${path(xs, ys)}" fill="none" stroke="${m === lead(P) ? C.best : C.other}" stroke-width="${m === lead(P) ? 2 : 1}"/>`;
      });
      return s;
    }, { now, yfmt: v => Math.round(v) });
  }
  /** Rain (blue) and snow (white) per hour, in mm of water; other models' totals as ticks. */
  function chartPrecip(P, a, b, sys, now) {
    const H = P.h[lead(P)], n = b - a, bw = Math.max(1, (W - ML - MR) / n - 0.6), vals = [];
    for (let i = a; i < b; i++) vals.push(conv.rain(H.precipitation[i] || 0, sys));
    const yr = niceTicks(0, Math.max(...vals, sys === 'imperial' ? 0.04 : 1), 3);
    return frame(P, a, b, 120, 'Rain and snow per hour', yr, (sys === 'imperial' ? 'in' : 'mm') + ' of water; white = snow', (X, Y, base) => {
      let s = '';
      for (let i = a; i < b; i++) {
        const tot = H.precipitation[i] || 0; if (tot <= 0) continue;
        const rain = Math.min(tot, H.rain[i] != null ? H.rain[i] : (H.temperature_2m[i] != null && H.temperature_2m[i] > 0 ? tot : 0)), snow = Math.max(0, tot - rain);
        const yt = Y(conv.rain(tot, sys)), yr_ = Y(conv.rain(rain, sys)), x = X(i) - bw / 2;
        if (snow > 0) s += `<rect x="${x.toFixed(1)}" y="${yt.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, yr_ - yt).toFixed(1)}" fill="${C.snow}"><title>${esc(P.t[i].replace('T', ' '))} snow ${esc(U.snow(H.snowfall[i], sys))}</title></rect>`;
        if (rain > 0) s += `<rect x="${x.toFixed(1)}" y="${yr_.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, base - yr_).toFixed(1)}" fill="${C.rain}"><title>${esc(P.t[i].replace('T', ' '))} rain ${esc(U.rain(rain, sys))}</title></rect>`;
      }
      return s;
    }, { now, yfmt: v => (sys === 'imperial' ? v.toFixed(2) : f1(v)) });
  }
  /** Wind (green) and gusts (yellow), lead model; the other models' gusts faint. */
  function chartWind(P, a, b, sys, now) {
    const all = []; P.models.forEach(m => slice(P.h[m].wind_gusts_10m, a, b).forEach(v => all.push(conv.wind(v, sys))));
    const yr = niceTicks(0, Math.max(...all.filter(x => x != null), 10), 4);
    return frame(P, a, b, 130, 'Wind (green) and gusts (yellow)', yr, sys === 'imperial' ? 'mph' : 'km/h', (X, Y) => {
      const ln = (arr, col, w) => { const xs = [], ys = []; for (let i = a; i < b; i++) { xs.push(X(i)); ys.push(arr[i] == null ? null : Y(conv.wind(arr[i], sys))); } return `<path d="${path(xs, ys)}" fill="none" stroke="${col}" stroke-width="${w}"/>`; };
      let s = '';
      P.models.slice(1).forEach(m => { s += ln(P.h[m].wind_gusts_10m, 'rgba(240,193,75,.3)', 1); });
      return s + ln(P.h[lead(P)].wind_gusts_10m, C.gust, 1.6) + ln(P.h[lead(P)].wind_speed_10m, C.wind, 1.8);
    }, { now });
  }
  /** Cloud cover band, 0-100 %. */
  function chartCloud(P, a, b, sys, now) {
    const H = P.h[lead(P)];
    return frame(P, a, b, 80, 'Cloud cover', { lo: 0, hi: 100, ticks: [0, 50, 100] }, '%', (X, Y, base) => {
      const xs = [], ys = []; for (let i = a; i < b; i++) { xs.push(X(i)); ys.push(H.cloud_cover[i] == null ? null : Y(H.cloud_cover[i])); }
      let d = ''; const ok = xs.map((x, i) => ys[i] == null ? null : i).filter(i => i != null);
      if (ok.length) d = 'M' + xs[ok[0]].toFixed(1) + ' ' + base.toFixed(1) + ok.map(i => 'L' + xs[i].toFixed(1) + ' ' + ys[i].toFixed(1)).join('') + 'L' + xs[ok[ok.length - 1]].toFixed(1) + ' ' + base.toFixed(1) + 'Z';
      return `<path d="${d}" fill="${C.cloud}" stroke="rgba(210,220,240,.8)" stroke-width="1"/>`;
    }, { now });
  }
  /** Freezing level (every model) against the point's elevation (red dashed). */
  function chartFreeze(P, a, b, elev, sys, now) {
    const all = [conv.len(elev, sys)]; P.models.forEach(m => slice(P.h[m].freezing_level_height, a, b).forEach(v => all.push(conv.len(v, sys))));
    const yr = rng(all, 0.08);
    return frame(P, a, b, 140, 'Freezing level against your height', yr, sys === 'imperial' ? 'ft' : 'm', (X, Y) => {
      let s = '';
      P.models.slice().reverse().forEach(m => { const xs = [], ys = []; for (let i = a; i < b; i++) { xs.push(X(i)); ys.push(P.h[m].freezing_level_height[i] == null ? null : Y(conv.len(P.h[m].freezing_level_height[i], sys))); } s += `<path d="${path(xs, ys)}" fill="none" stroke="${m === lead(P) ? C.ice : 'rgba(143,211,255,.35)'}" stroke-width="${m === lead(P) ? 2 : 1}"/>`; });
      if (num(elev) != null) { const y = Y(conv.len(elev, sys)); s += `<line x1="${ML}" x2="${W - MR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${C.you}" stroke-width="1.4" stroke-dasharray="6 3"/><text x="${W - MR - 2}" y="${(y - 3).toFixed(1)}" text-anchor="end" class="wx-ax" fill="${C.you}">you ${esc(U.len(elev, sys))}</text>`; }
      return s;
    }, { now, yfmt: v => Math.round(v) });
  }

  /** The age of a saved answer in words. */
  function ageWords(ms) {
    const m = Math.round(ms / 60000);
    if (m < 2) return 'just now'; if (m < 90) return m + ' min ago'; const h = Math.round(m / 60); if (h < 36) return h + ' h ago';
    return Math.round(h / 24) + ' days ago';
  }
  /** Packing hints in plain words from the day rows of the lead model. */
  function hints(rows, sys) {
    const out = [], lo = minOf(rows.map(r => r.night != null ? r.night : r.lo)), hi = maxOf(rows.map(r => r.hi));
    if (lo != null && lo <= 0) out.push(`Freezing at night (down to ${U.temp(lo, sys)}${U.tempUnit(sys).slice(1)}): ice on roads and in creeks is possible.`);
    const sn = maxOf(rows.map(r => r.snow)); if (sn != null && sn >= 1) out.push(`Snow expected (up to ${U.snow(sn, sys)} in a day).`);
    const pr = maxOf(rows.map(r => r.precip)); if (pr != null && pr >= 10) out.push(`A wet day is likely (${U.rain(pr, sys)}): creeks and low crossings may rise.`);
    const g = maxOf(rows.map(r => r.gust)); if (g != null && g >= 50) out.push(`Strong gusts (${U.wind(g, sys)}).`);
    if (rows.some(r => r.disagree)) out.push('The models disagree about the rain: treat it as uncertain.');
    if (hi != null && hi >= 30) out.push('Hot afternoons: bring extra water.');
    return out;
  }

  const pure = { MODELS, omUrl, nwsPointsUrl, inUS, storeKey, parseOM, parseNWS, codeWords, dayRows, hourSpan, nowLocal, snowLine, pickPoints, gridIn, centreOf, niceTicks, chartTemp, chartPrecip, chartWind, chartCloud, chartFreeze, ageWords, hints, U, r2, dayName };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (!root || !root.document) return;

  // ── The panel ─────────────────────────────────────────────────────────────
  const w = root, doc = root.document;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const lget = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lset = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (_) { return false; } };
  const ldel = k => { try { localStorage.removeItem(k); } catch (_) {} };
  const sysNow = () => { try { return w._units && w._units.system ? w._units.system() : 'metric'; } catch (_) { return 'metric'; } };
  const S = { name: '', points: [], idx: 0, data: {}, i0: 0, i1: 7, busy: false, msg: '' };
  let card = null;

  function remember(key, rec) {            // keep the answer; at most 12 points kept
    const idxK = 'flex.weather.index'; let idx = []; try { idx = JSON.parse(lget(idxK) || '[]'); } catch (_) {}
    idx = idx.filter(k => k !== key); idx.push(key);
    while (idx.length > 12) ldel(idx.shift());
    if (!lset(key, JSON.stringify(rec))) { while (idx.length > 1) { ldel(idx.shift()); if (lset(key, JSON.stringify(rec))) break; } }
    lset(idxK, JSON.stringify(idx));
  }
  async function getJson(url) { const r = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }

  /** Fetch one point (Open-Meteo, then NWS in the US); on failure fall back to the kept copy. */
  async function load(pt) {
    const key = storeKey(pt.lon, pt.lat, pt.elev); let rec = null, err = '';
    try {
      const om = await getJson(omUrl(pt.lon, pt.lat, pt.elev, 10)); if (!parseOM(om)) throw new Error('empty answer');
      let nws = null;
      if (inUS(pt.lon, pt.lat)) { try { const p = await getJson(nwsPointsUrl(pt.lon, pt.lat)); nws = parseNWS(await getJson(p.properties.forecast)); } catch (_) { nws = null; } }
      rec = { at: Date.now(), om, nws }; remember(key, rec);
    } catch (e) {
      err = String(e.message || e);
      try { rec = JSON.parse(lget(key) || 'null'); } catch (_) { rec = null; }
      if (rec) rec.stale = true;
    }
    S.data[pt.key] = rec ? { rec, P: parseOM(rec.om), err } : { rec: null, P: null, err };
    return S.data[pt.key];
  }
  const defaultRange = P => [0, Math.min(7, P.dates.length - 1)];

  async function sampleElevations(pts) {
    if (w._weather && w._weather.sampler) return w._weather.sampler(pts);
    const C = w.Cesium, v = w.cesiumViewer; if (!C || !v) return pts.map(() => null);
    const prov = v.terrainProvider, carto = pts.map(p => C.Cartographic.fromDegrees(p.lon, p.lat));
    try { const r = prov && prov.availability ? await C.sampleTerrainMostDetailed(prov, carto) : await C.sampleTerrain(prov, 11, carto); return r.map(c => c.height); } catch (_) { return pts.map(() => null); }
  }

  async function open(o) {
    o = o || {};
    let ring = o.ring && o.ring.length >= 3 ? o.ring : null, centre;
    if (ring) centre = centreOf(ring); else if (num(o.lon) != null && num(o.lat) != null) centre = { lon: +o.lon, lat: +o.lat }; else return { ok: false, error: 'no place' };
    S.name = o.name || 'this place'; S.msg = 'Finding heights…'; S.idx = 0; S.data = {}; S.points = [{ key: 'centre', label: 'Middle', lon: centre.lon, lat: centre.lat, elev: null }];
    ensure(); paint();
    const samples = ring ? gridIn(ring, 5) : [];
    const hs = await sampleElevations([centre].concat(samples));
    centre.h = hs[0]; S.points = pickPoints(centre, samples.map((s, i) => ({ lon: s.lon, lat: s.lat, h: hs[i + 1] })));
    return refresh();
  }
  async function refresh() {
    if (!S.points.length) return { ok: false };
    S.busy = true; S.msg = 'Fetching the forecast…'; paint();
    await Promise.all(S.points.map(load));
    S.busy = false; S.msg = '';
    const d = S.data[S.points[S.idx].key]; if (d && d.P) { const r = defaultRange(d.P); if (S.i1 >= d.P.dates.length || S.i0 > S.i1) { S.i0 = r[0]; S.i1 = r[1]; } }
    paint(); return { ok: true };
  }

  // ── Painting ──
  function ensure() {
    if (card && doc.body.contains(card)) { card.hidden = false; return; }
    card = el('div'); card.id = 'wx-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Weather');
    doc.body.appendChild(card);
  }
  function close() { if (card) card.hidden = true; }
  function td(t, cls) { const c = el('td', cls); if (t != null) c.textContent = t; return c; }

  function paint() {
    if (!card || card.hidden) return;
    const sys = sysNow(), pt = S.points[S.idx], D = pt && S.data[pt.key], P = D && D.P;
    card.textContent = '';
    const head = el('div', 'wx-head'); head.appendChild(el('b', 'wx-title', 'Weather: ' + S.name));
    const rb = el('button', 'wx-btn', S.busy ? 'Fetching…' : 'Refresh'); rb.id = 'wx-refresh'; rb.disabled = S.busy; rb.addEventListener('click', refresh);
    const cb = el('button', 'wx-btn', '✕'); cb.id = 'wx-close'; cb.title = 'Close'; cb.addEventListener('click', close);
    head.append(rb, cb); card.appendChild(head);
    card.appendChild(el('div', 'wx-priv', 'Only the place rounded to about 1 km goes to Open-Meteo' + (pt && inUS(pt.lon, pt.lat) ? ' and the US National Weather Service' : '') + ': no names, nothing else.'));
    if (S.msg) card.appendChild(el('div', 'wx-msg', S.msg));
    if (S.points.length > 1) {
      const tabs = el('div', 'wx-tabs'); S.points.forEach((p, i) => { const b = el('button', 'wx-tab' + (i === S.idx ? ' on' : ''), p.label + (p.elev != null ? ' · ' + U.len(p.elev, sys) : '')); b.dataset.i = i; b.addEventListener('click', () => { S.idx = i; paint(); }); tabs.appendChild(b); });
      card.appendChild(tabs);
    } else if (pt && pt.elev != null) card.appendChild(el('div', 'wx-sub', 'Height ' + U.len(pt.elev, sys)));
    if (!P) { if (!S.busy && !S.msg) card.appendChild(el('div', 'wx-err', D && D.err ? 'No forecast: ' + friendly(D.err) + ' Nothing saved from before for this place.' : 'No forecast yet.')); return; }
    // source / age
    const rec = D.rec, age = Date.now() - rec.at;
    const src = el('div', 'wx-src' + (rec.stale ? ' stale' : ''));
    src.textContent = (rec.stale ? 'OFFLINE: showing the forecast fetched ' + ageWords(age) + ' (' + new Date(rec.at).toLocaleString() + '). ' + friendly(D.err) + ' ' : 'Forecast fetched at ' + new Date(rec.at).toLocaleTimeString() + '. ')
      + 'Model run: ' + (rec.om.model_run || 'not given by Open-Meteo') + '. Models: ' + P.models.map(m => MODEL_NAME[m]).join(', ') + '.';
    card.appendChild(src);
    // range
    const rr = el('div', 'wx-range'); rr.appendChild(el('span', null, 'Days'));
    const sel = (id, v, set) => { const s = el('select'); s.id = id; P.dates.forEach((d, i) => s.appendChild(new Option(dayName(d), i))); s.value = v; s.addEventListener('change', () => { set(+s.value); if (S.i1 < S.i0) { S.i1 = S.i0; } paint(); }); return s; };
    rr.append(sel('wx-from', S.i0, v => { S.i0 = v; }), el('span', null, 'to'), sel('wx-to', Math.min(S.i1, P.dates.length - 1), v => { S.i1 = v; if (S.i0 > v) S.i0 = v; }));
    card.appendChild(rr);
    const rows = dayRows(P, S.i0, S.i1);
    const tb = el('table', 'wx-days'); tb.id = 'wx-days';
    const th = el('tr'); ['Day', '', 'High', 'Low', 'Night low', 'Rain', 'Snow', 'Gusts', 'Cloud', 'Sun'].forEach(t => th.appendChild(el('th', null, t))); const hd = el('thead'); hd.appendChild(th); tb.appendChild(hd);
    const rg = (lo, hi, f) => lo != null && hi != null && Math.abs(hi - lo) > 0.05 ? ' (' + f(lo) + '–' + f(hi) + ')' : '';
    const bd = el('tbody');
    rows.forEach(r => {
      const tr = el('tr'); tr.dataset.date = r.date;
      tr.append(td(r.name, 'wx-dn'), td(r.words, 'wx-w'), td(U.temp(r.hi, sys) + rg(r.hiRange[0], r.hiRange[1], v => U.temp(v, sys))), td(U.temp(r.lo, sys)), td(U.temp(r.night, sys)),
        td(U.rain(r.precip, sys) + rg(r.precipRange[0], r.precipRange[1], v => U.rain(v, sys)), r.disagree ? 'wx-dis' : ''), td(U.snow(r.snow, sys) + rg(r.snowRange[0], r.snowRange[1], v => U.snow(v, sys))), td(U.wind(r.gust, sys)), td(r.cloud == null ? '–' : Math.round(r.cloud) + '%'), td(r.rise + ' / ' + r.set));
      bd.appendChild(tr);
    });
    tb.appendChild(bd); card.appendChild(tb);
    card.appendChild(el('div', 'wx-note', 'Brackets: the lowest and highest of the models. Temperatures are for ' + (pt.elev != null ? 'the height above' : 'the area') + '; night low = 18:00 to 08:00.'));
    hints(rows, sys).forEach(t => card.appendChild(el('div', 'wx-hint', t)));
    // charts
    const [a, b] = hourSpan(P, S.i0, S.i1), now = P.t.indexOf(nowLocal(P).slice(0, 13) + ':00');
    const sl = snowLine(P, a, b, pt.elev, sys); if (sl.text) { const t = el('div', 'wx-snow', sl.text); t.id = 'wx-snowline'; card.appendChild(t); }
    const ch = el('div', 'wx-charts'); ch.id = 'wx-charts';
    ch.innerHTML = chartTemp(P, a, b, sys, now) + chartPrecip(P, a, b, sys, now) + chartWind(P, a, b, sys, now) + chartCloud(P, a, b, sys, now) + chartFreeze(P, a, b, pt.elev, sys, now);
    card.appendChild(ch);
    card.appendChild(el('div', 'wx-note', 'Orange or blue-grey thick line: best-match model; thin lines: the other models. Wider gaps between lines mean the models disagree.'));
    // NWS
    const ns = rec.nws && rec.nws.length ? rec.nws.filter(p => p.start >= P.dates[S.i0] && p.start <= P.dates[S.i1]) : [];
    if (ns.length) {
      const bx = el('div', 'wx-nws'); bx.id = 'wx-nws'; bx.appendChild(el('div', 'wx-h', 'US National Weather Service, second opinion'));
      ns.slice(0, 14).forEach(p => { const r = el('div', 'wx-nwsrow'); r.append(el('b', null, p.name + ': '), doc.createTextNode(p.text)); bx.appendChild(r); });
      card.appendChild(bx);
    }
  }
  function friendly(e) {
    e = String(e || ''); if (!e) return '';
    if (/HTTP 429/.test(e)) return 'The forecast service says too many requests: try again in a few minutes.';
    if (/HTTP 5\d\d/.test(e)) return 'The forecast service is having trouble.';
    if (/HTTP 4\d\d/.test(e)) return 'The forecast service refused the request (' + e + ').';
    if (/Failed to fetch|NetworkError|Load failed|aborted/i.test(e)) return 'No internet connection to the forecast service.';
    return 'Could not read the forecast (' + e + ').';
  }

  const css = doc.createElement('style');
  css.textContent = `
  #wx-card { position: fixed; z-index: 9000; left: 76px; top: 56px; width: min(780px, calc(100vw - 96px)); max-height: calc(100vh - 80px); overflow: auto; background: rgba(24,26,32,.97); color: #e8e8ee; border: 1px solid rgba(255,255,255,.2); border-radius: 6px; padding: 10px 12px; font-size: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.5); }
  #wx-card[hidden] { display: none; }
  #wx-card .wx-head { display: flex; align-items: center; gap: 6px; } #wx-card .wx-title { flex: 1; font-size: 14px; }
  #wx-card .wx-btn, #wx-card .wx-tab { background: #222; color: #eee; border: 1px solid #555; border-radius: 3px; padding: 3px 9px; font-size: 11px; cursor: pointer; }
  #wx-card .wx-btn:disabled { opacity: .5; } #wx-card .wx-tabs { display: flex; gap: 5px; margin: 6px 0; }
  #wx-card .wx-tab { border-radius: 10px; } #wx-card .wx-tab.on { border-color: #ff9f43; color: #ff9f43; }
  #wx-card .wx-priv, #wx-card .wx-note, #wx-card .wx-sub { font-size: 10.5px; color: rgba(255,255,255,.55); margin: 3px 0; }
  #wx-card .wx-msg { color: #f0c14b; margin: 4px 0; } #wx-card .wx-err { color: #ff9a8a; margin: 8px 0; }
  #wx-card .wx-src { font-size: 11px; margin: 5px 0; color: rgba(255,255,255,.75); } #wx-card .wx-src.stale { color: #f0c14b; border-left: 3px solid #f0c14b; padding-left: 6px; }
  #wx-card .wx-range { display: flex; gap: 6px; align-items: center; margin: 6px 0; } #wx-card select { background: #222; color: #eee; border: 1px solid #555; border-radius: 3px; padding: 2px 4px; font-size: 11px; }
  #wx-card table.wx-days { width: 100%; border-collapse: collapse; font-size: 11px; }
  #wx-card .wx-days th { text-align: left; font-weight: 500; color: rgba(255,255,255,.5); padding: 2px 5px 2px 0; border-bottom: 1px solid rgba(255,255,255,.15); white-space: nowrap; }
  #wx-card .wx-days td { padding: 3px 5px 3px 0; border-bottom: 1px solid rgba(255,255,255,.07); white-space: nowrap; font-variant-numeric: tabular-nums; }
  #wx-card .wx-dn { font-weight: 600; } #wx-card .wx-w { color: rgba(255,255,255,.7); } #wx-card .wx-dis { color: #f0c14b; }
  #wx-card .wx-hint { margin: 3px 0; padding-left: 8px; border-left: 2px solid #ff9f43; }
  #wx-card .wx-svg { width: 100%; height: auto; display: block; margin-top: 6px; } #wx-card .wx-ct { font-size: 11px; fill: #e8e8ee; font-weight: 600; } #wx-card .wx-cu { font-weight: 400; fill: rgba(255,255,255,.55); }
  #wx-card .wx-ax { font-size: 9.5px; fill: rgba(255,255,255,.6); }
  #wx-card .wx-snow { margin: 4px 0; color: #8fd3ff; }
  #wx-card .wx-nws { margin-top: 8px; } #wx-card .wx-h { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: rgba(255,255,255,.5); margin: 4px 0; } #wx-card .wx-nwsrow { margin: 3px 0; font-size: 11px; }
  #weather-host .wx-note { font-size: 10.5px; color: rgba(255,255,255,.55); margin: 2px 0 4px; }`;
  doc.head.appendChild(css);

  w._weather = { open, close, refresh, state: () => S, pure, sampler: null };

  // ── Hooks: the Analyze section (fallback when Analyze by area is missing) and the map's right-click menu ──
  function mk() {
    const host = doc.getElementById('weather-host'); if (!host || w._areas) return;
    const b = el('button', 'wx-btn', 'Weather for the chosen area'); b.type = 'button'; b.id = 'wx-go';
    b.addEventListener('click', () => { const a = w._areaPicker && w._areaPicker.create ? null : null; void a; const ea = w._exportArea; if (ea && (ea.polygon || ea.bbox)) open({ name: ea.label || 'chosen area', ring: ea.polygon && ea.polygon.length >= 3 ? ea.polygon : [[ea.bbox[0], ea.bbox[1]], [ea.bbox[2], ea.bbox[1]], [ea.bbox[2], ea.bbox[3]], [ea.bbox[0], ea.bbox[3]]] }); });
    host.append(el('div', 'wx-note', 'Forecast for the area: temperature, rain, snow, wind and the snow line.'), b);
  }
  function wrapMenu() {
    const prev = w._selMenu;
    w._selMenu = pos => {
      const items = typeof prev === 'function' ? (prev(pos) || []) : [];
      try {
        const v = w.cesiumViewer, C = w.Cesium; let c = v.camera.pickEllipsoid(pos, v.scene.globe.ellipsoid);
        if (c) { const g = C.Cartographic.fromCartesian(c); items.push({ label: 'Weather here', run: () => open({ name: 'here', lon: C.Math.toDegrees(g.longitude), lat: C.Math.toDegrees(g.latitude) }) }); }
      } catch (_) {}
      return items;
    };
  }
  const start = () => { mk(); wrapMenu(); };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();
  w.addEventListener('flex-units-changed', () => paint());
})(typeof window !== 'undefined' ? window : this);
