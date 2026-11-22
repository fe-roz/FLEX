// Node tests for weather-panel.js pure parts (no network). Made-up data only.
const W = require('./load_classic')(require('path').join(__dirname, '..', 'client', 'src', 'modules', 'weather-panel.js'));
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) { pass++; console.log('ok   ' + l); } else { fail++; console.log('FAIL ' + l + (i !== undefined ? ' ' + JSON.stringify(i).slice(0, 300) : '')); } };

/** A made-up Open-Meteo answer, 3 days, models suffixed like the real one. */
function fake(models, days, fz) {
  const t = [], dates = []; for (let d = 0; d < days; d++) { const ds = '2030-05-0' + (d + 1); dates.push(ds); for (let h = 0; h < 24; h++) t.push(ds + 'T' + String(h).padStart(2, '0') + ':00'); }
  const j = { timezone: 'America/Denver', utc_offset_seconds: -21600, elevation: 900, hourly: { time: t }, daily: { time: dates } };
  models.forEach((m, k) => {
    const hv = (f) => t.map((_, i) => f(i));
    j.hourly['temperature_2m_' + m] = hv(i => 5 + 8 * Math.sin((i % 24 - 9) / 24 * 2 * Math.PI) + k);
    j.hourly['precipitation_' + m] = hv(i => (i >= 30 && i < 34 ? 1.5 + k : 0)); j.hourly['rain_' + m] = hv(i => (i >= 30 && i < 32 ? 1.5 : 0));
    j.hourly['snowfall_' + m] = hv(i => (i >= 32 && i < 34 ? 1 : 0)); j.hourly['snow_depth_' + m] = hv(() => 0);
    j.hourly['freezing_level_height_' + m] = fz === false && m === 'ecmwf_ifs025' ? hv(() => null) : hv(i => 1500 + 40 * (i % 24) + k * 50);
    j.hourly['wind_speed_10m_' + m] = hv(i => 10 + (i % 7)); j.hourly['wind_gusts_10m_' + m] = hv(i => 20 + (i % 9) * 3);
    j.hourly['wind_direction_10m_' + m] = hv(() => 200); j.hourly['cloud_cover_' + m] = hv(i => (i * 4) % 100); j.hourly['weather_code_' + m] = hv(() => 3);
    j.daily['weather_code_' + m] = dates.map(() => 61); j.daily['temperature_2m_max_' + m] = dates.map((_, i) => 13 + k + i); j.daily['temperature_2m_min_' + m] = dates.map(() => -2 + k);
    j.daily['sunrise_' + m] = dates.map(d => d + 'T06:12'); j.daily['sunset_' + m] = dates.map(d => d + 'T20:01');
    j.daily['precipitation_sum_' + m] = dates.map((_, i) => (i === 1 ? 6 + 6 * k : 0)); j.daily['snowfall_sum_' + m] = dates.map((_, i) => (i === 1 ? 2 : 0)); j.daily['wind_gusts_10m_max_' + m] = dates.map(() => 55);
  });
  return j;
}

// URLs: rounding and nothing else
const u = W.omUrl(-100.56789, 45.12345, 1234, 10);
ok('url rounds to 2 decimals', /latitude=45\.12&/.test(u) && /longitude=-100\.57&/.test(u), u);
ok('url has no name-like extras', !/name|id=|cave/i.test(u) && /elevation=1230/.test(u));
ok('url asks for four models', /models=best_match,gfs_seamless,ecmwf_ifs025,icon_seamless/.test(u));
ok('nws url rounded', W.nwsPointsUrl(-100.56789, 45.12345) === 'https://api.weather.gov/points/45.12,-100.57');
ok('inUS yes / no', W.inUS(-100.5, 45.1) && !W.inUS(10, 50) && !W.inUS(-100, 10));
ok('storeKey', W.storeKey(-100.5678, 45.1234, 1234) === 'flex.weather.45.12,-100.57,1230');

const P = W.parseOM(fake(W.MODELS, 3));
ok('parse four models', P && P.models.length === 4 && P.t.length === 72 && P.dates.length === 3);
const P2 = W.parseOM(fake(W.MODELS, 3, false));
ok('a model with no freezing level still parses', P2.models.length === 4 && P2.h.ecmwf_ifs025.freezing_level_height.every(x => x == null));
const single = fake(['best_match'], 1); const s2 = {}; for (const k of Object.keys(single.hourly)) s2[k.replace('_best_match', '')] = single.hourly[k]; s2.time = single.hourly.time;
const d2 = {}; for (const k of Object.keys(single.daily)) d2[k.replace('_best_match', '')] = single.daily[k]; d2.time = single.daily.time;
ok('unsuffixed single-model answer parses', W.parseOM({ hourly: s2, daily: d2 }).models.length === 1);
ok('garbage returns null', W.parseOM({}) === null && W.parseOM(null) === null);

const rows = W.dayRows(P, 0, 2);
ok('three day rows', rows.length === 3 && rows[1].name === 'Thu 2 May');
ok('model ranges', rows[1].precip === 6 && rows[1].precipRange[0] === 6 && rows[1].precipRange[1] === 24, rows[1].precipRange);
ok('models disagree flagged', rows[1].disagree && !rows[0].disagree);
ok('night low from 18:00 to 08:00', rows[0].night != null && rows[0].night <= rows[0].lo + 20);
ok('sun times', rows[0].rise === '06:12' && rows[0].set === '20:01');
ok('hour span for a day range', JSON.stringify(W.hourSpan(P, 1, 2)) === '[24,72]');
ok('nowLocal uses the offset', W.nowLocal(P, Date.UTC(2030, 4, 1, 18, 30)) === '2030-05-01T12:30');

const sl = W.snowLine(P, 0, 72, 2000, 'metric'), sl2 = W.snowLine(P, 0, 72, 500, 'metric'), sl3 = W.snowLine(P, 0, 72, 5000, 'metric');
ok('snow line: above you', sl2.share === 0 && /above you/.test(sl2.text), sl2.text);
ok('snow line: below you', sl3.share === 1 && /below you/.test(sl3.text));
ok('snow line: part of the time', sl.share > 0 && sl.share < 1, sl.share);
ok('snow line without elevation says nothing wrong', W.snowLine(P, 0, 72, null, 'metric').share === null);

// points
const flat = W.pickPoints({ lon: 1, lat: 2, h: 500 }, [{ lon: 1, lat: 2, h: 450 }, { lon: 1, lat: 2.1, h: 650 }]);
ok('flat area: one point', flat.length === 1 && flat[0].elev === 500);
const steep = W.pickPoints({ lon: 1, lat: 2, h: 900 }, [{ lon: 1, lat: 2, h: 400 }, { lon: 1.1, lat: 2.1, h: 1400 }, { lon: 1, lat: 2.2, h: 900 }]);
ok('steep area: centre, lowest, highest', steep.length === 3 && steep[1].elev === 400 && steep[2].elev === 1400 && steep[1].label === 'Lowest');
ok('centre height filled from samples when unknown', W.pickPoints({ lon: 1, lat: 2 }, [{ lon: 1, lat: 2, h: 100 }])[0].elev === 100);
const g = W.gridIn([[0, 0], [1, 0], [1, 1], [0, 1]], 5);
ok('grid inside the ring plus corners', g.length === 29, g.length);

// units
ok('units metric', W.U.temp(12.4, 'metric') === '12°' && W.U.wind(50, 'metric') === '50 km/h' && W.U.len(1000, 'metric') === '1000 m');
ok('units imperial', W.U.temp(0, 'imperial') === '32°' && W.U.wind(100, 'imperial') === '62 mph' && W.U.len(1000, 'imperial') === '3281 ft' && W.U.rain(25.4, 'imperial') === '1.00 in');

// charts are SVG and survive nulls
['chartTemp', 'chartPrecip', 'chartWind', 'chartCloud'].forEach(n => { const s = W[n](P2, 0, 72, 'metric', 10); ok(n + ' draws svg', /^<svg/.test(s) && /<\/svg>$/.test(s) && !/NaN/.test(s)); });
const fzs = W.chartFreeze(P2, 0, 72, 1200, 'imperial', -1); ok('chartFreeze draws svg with you line', /you 3937 ft/.test(fzs) && !/NaN/.test(fzs), fzs.slice(-200));
ok('precip chart marks snow in white', /fill="#e8f1ff"/.test(W.chartPrecip(P, 0, 72, 'metric', -1)));

// NWS
const n = W.parseNWS({ properties: { periods: [{ name: 'Tonight', startTime: '2030-05-01T18:00:00-06:00', detailedForecast: 'Clear.', temperature: 30, temperatureUnit: 'F', probabilityOfPrecipitation: { value: 10 }, windSpeed: '5 mph', isDaytime: false }] } });
ok('nws parse', n.length === 1 && n[0].start === '2030-05-01' && n[0].night && n[0].pop === 10);
ok('nws junk', W.parseNWS({}) === null);

// misc
ok('hints', W.hints(rows, 'metric').some(t => /Freezing at night/.test(t)) && W.hints(rows, 'metric').some(t => /disagree/.test(t)));
ok('age words', W.ageWords(30000) === 'just now' && W.ageWords(3 * 3600e3) === '3 h ago' && W.ageWords(3 * 86400e3) === '3 days ago');
ok('weather words', W.codeWords(0) === 'Clear' && W.codeWords(75) === 'Heavy snow' && W.codeWords(95) === 'Thunderstorm');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
