// Compass PLT survey files: the parser, the UTM inverse, and placing the parsed
// survey on the globe. Moved out of flex.js unchanged (the flex.js split, wave 0;
// see client/src/README.md for the pattern).
//
// Pure exports (no browser, no Cesium), node-testable:
//   utmToLatLon(easting, northing, zoneNum, isNorth) -> { lat, lon }   (degrees, WGS84)
//   parsePLT(text) -> { segments, stations, fixedStations, surveys, leads, utmZone, utmSouth, datum }
// Setup (needs Cesium, passed in, never imported):
//   setupCompassPlt({ Cesium }) -> { pltToCartesian(parsed, zoneOverride, southOverride) }
//
// flex.js imports parsePLT / utmToLatLon by name; window._ws.parse is parsePLT
// (survey_export.js and the tests read survey files through it).

// ── UTM → WGS84 (Transverse Mercator inverse, WGS84 ellipsoid) ───────────────
export function utmToLatLon(easting, northing, zoneNum, isNorth) {
  const a  = 6378137.0;
  const f  = 1 / 298.257223563;
  const e2 = 2*f - f*f;
  const ep2 = e2 / (1 - e2);
  const k0 = 0.9996;
  const E0 = 500000;
  const N0 = isNorth ? 0 : 10000000;

  const lon0 = ((zoneNum - 1) * 6 - 180 + 3) * Math.PI / 180;
  const M    = (northing - N0) / k0;
  const mu   = M / (a * (1 - e2/4 - 3*e2*e2/64 - 5*e2*e2*e2/256));

  const e1  = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu
    + (3*e1/2 - 27*Math.pow(e1,3)/32) * Math.sin(2*mu)
    + (21*e1*e1/16 - 55*Math.pow(e1,4)/32) * Math.sin(4*mu)
    + (151*Math.pow(e1,3)/96) * Math.sin(6*mu);

  const N1 = a / Math.sqrt(1 - e2 * Math.sin(phi1)**2);
  const T1 = Math.tan(phi1)**2;
  const C1 = ep2 * Math.cos(phi1)**2;
  const R1 = a*(1-e2) / Math.pow(1 - e2*Math.sin(phi1)**2, 1.5);
  const D  = (easting - E0) / (N1 * k0);

  const lat = phi1 - (N1*Math.tan(phi1)/R1) * (
    D*D/2
    - (5 + 3*T1 + 10*C1 - 4*C1*C1 - 9*ep2) * Math.pow(D,4)/24
    + (61 + 90*T1 + 298*C1 + 45*T1*T1 - 252*ep2 - 3*C1*C1) * Math.pow(D,6)/720
  );

  const lon = lon0 + (
    D
    - (1 + 2*T1 + C1) * Math.pow(D,3)/6
    + (5 - 2*C1 + 28*T1 - 3*C1*C1 + 8*ep2 + 24*T1*T1) * Math.pow(D,5)/120
  ) / Math.cos(phi1);

  return { lat: lat*180/Math.PI, lon: lon*180/Math.PI };
}

// ── Compass PLT parser ────────────────────────────────────────────────────────
// Returns { segments, stations, fixedStations, utmZone, utmSouth, datum }
// All metric distances in metres; coords are survey-local N/E/V in metres.
export function parsePLT(text) {
  const lines = text.split(/\r?\n/);
  const result = {
    segments:      [],  // [{points:[{n,e,v,excluded}], survey?}]
    stations:      [],  // [{n,e,v,name,survey,surveyDesc}]
    fixedStations: [],  // [{name,n,e,v}] — UTM metres
    surveys:       [],  // [{code,desc}] in order encountered
    leads:         [],  // [{station, d, done, t, w, h}] — FLEX ';LEAD' lines (Breakout import)
    utmZone:       null,
    utmSouth:      false,
    datum:         null,
  };

  let currentSeg    = null;
  let lastPt        = null;
  let currentSurvey = null;  // {code, desc}

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Fixed station: P<name><whitespace><N> <E> <V>
    // Matches lines like:  PSURVEYBASE 4136789.3 567234.1 1234.5
    if (/^P\S+\s+[\d.\-]+\s+[\d.\-]+\s+[\d.\-]+/.test(line)) {
      const m = line.match(/^P(\S+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)/);
      if (m) {
        result.fixedStations.push({
          name: m[1],
          n: parseFloat(m[2]) * 0.3048,  // feet → metres
          e: parseFloat(m[3]) * 0.3048,
          v: parseFloat(m[4]) * 0.3048,
        });
      }
      continue;
    }

    // FLEX extension written by the Breakout import: ';LEAD<TAB>station<TAB>{json}'.
    // Compass ignores ';' lines; nothing else in a real PLT starts with it.
    if (line.startsWith(';LEAD\t')) {
      const parts = line.split('\t');
      try { result.leads.push({ station: parts[1], ...JSON.parse(parts.slice(2).join('\t')) }); }
      catch (_) { /* malformed lead line: skip it */ }
      continue;
    }

    const cmd  = line[0];
    const rest = line.slice(1).trim();

    if (cmd === 'O') {
      result.datum = rest;
    } else if (cmd === 'N') {
      // Survey name line: N<code> <day-of-week> <month> <day> <year> C<description>
      // e.g. "NME D 3 24 2013 CEntrance series"
      const nCode = rest.split(/\s+/)[0] || rest;
      const nDescM = rest.match(/C(.+)$/);
      const nDesc = nDescM ? nDescM[1].trim() : '';
      // The survey's date (D <month> <day> <year>), for the info panel.
      const nDate = rest.match(/^\S+\s+D\s+(\d{1,2})\s+(\d{1,2})\s+(\d{2,4})\b/);
      const nIso = nDate ? `${nDate[3].length === 2 ? '19' + nDate[3] : nDate[3]}-${nDate[1].padStart(2, '0')}-${nDate[2].padStart(2, '0')}` : '';
      currentSurvey = { code: nCode, desc: nDesc };
      result.surveys.push(nIso ? { code: nCode, desc: nDesc, date: nIso } : { code: nCode, desc: nDesc });
      // New survey starts a new segment context
      currentSeg = null;
      lastPt = null;
    } else if (cmd === 'G') {
      const z = parseInt(rest, 10);
      result.utmZone  = Math.abs(z);
      result.utmSouth = z < 0;
    } else if (cmd === 'M' || cmd === 'D' || cmd === 'd') {
      // Strip trailing quoted comment ("...") then tokenize
      const _commentMatch = rest.match(/"([^"]*)"$/);
      const stripped = _commentMatch ? rest.slice(0, _commentMatch.index).trim() : rest.trim();
      const _lineComment = _commentMatch ? _commentMatch[1].trim() : null;
      const parts = stripped.split(/\s+/);
      if (parts.length >= 3) {
        const pt = {
          n:        parseFloat(parts[0]) * 0.3048,
          e:        parseFloat(parts[1]) * 0.3048,
          v:        parseFloat(parts[2]) * 0.3048,
          excluded: cmd === 'd',
          comment:  _lineComment || null,
        };
        if (cmd === 'M') {
          currentSeg = { points: [pt], survey: currentSurvey?.code || '', surveyDesc: currentSurvey?.desc || '' };
          result.segments.push(currentSeg);
        } else if (currentSeg) {
          currentSeg.points.push(pt);
        }
        lastPt = pt;

        // Parse inline tokens after the three coordinates:
        //   S<name>               → station name
        //   P <l> <u> <d> <r>    → LRUD passage dimensions
        //   I <dist>              → distance from entrance
        //   F or F<flags>         → flags (skip)
        let ti = 3;
        while (ti < parts.length) {
          const tok = parts[ti];
          if (tok.length > 1 && tok[0] === 'S') {
            // Inline station name: S<name> (e.g. S0, SA1, SDA11, SBC2, SC2a)
            pt.name = tok.slice(1).trim();
          } else if (tok === 'P' && ti + 4 < parts.length) {
            // Inline LRUD dimensions
            pt.lrud = {
              l: parseFloat(parts[ti+1]) * 0.3048,
              u: parseFloat(parts[ti+2]) * 0.3048,
              d: parseFloat(parts[ti+3]) * 0.3048,
              r: parseFloat(parts[ti+4]) * 0.3048,
            };
            ti += 4;
          } else if (tok === 'I' && ti + 1 < parts.length) {
            // Inline distance from entrance
            pt.dist = parseFloat(parts[ti+1]) * 0.3048;
            ti += 1;
          } else if (tok[0] === 'F') {
            pt.flags = tok.slice(1);  // e.g. 'S'=surface, 'L'=loop, 'P'=passage
            if (pt.flags.includes('S')) {
              if (currentSeg) currentSeg.isSurface = true;
              pt.isSurface = true;
            }
          }
          ti++;
        }
        // If station name found inline, add to stations list
        if (pt.name) {
          result.stations.push({ ...pt, survey: currentSurvey?.code || '', surveyDesc: currentSurvey?.desc || '' });
        }
      }
    } else if (cmd === 'S' && lastPt && !lastPt.name) {
      // Standalone S line: only use if point doesn't already have an inline name
      const sname = rest.trim();
      if (sname && !/^[A-Z]\s/.test(sname)) {  // skip survey-header S lines like "STEST-MF"
        lastPt.name = sname;
        result.stations.push({ ...lastPt, name: sname, survey: currentSurvey?.code || '', surveyDesc: currentSurvey?.desc || '' });
      }
    } else if (cmd === 'P' && lastPt && !lastPt.lrud && /^[\d.\-]+\s/.test(rest)) {
      // Standalone P line for LRUD (only if not already set inline)
      const parts = rest.split(/\s+/);
      if (parts.length >= 4) {
        lastPt.lrud = {
          l: parseFloat(parts[0]) * 0.3048,
          u: parseFloat(parts[1]) * 0.3048,
          d: parseFloat(parts[2]) * 0.3048,
          r: parseFloat(parts[3]) * 0.3048,
        };
      }
    } else if (cmd === 'I' && lastPt && lastPt.dist == null) {
      // Standalone I line for distance (only if not already set inline)
      lastPt.dist = parseFloat(rest) * 0.3048;
    }
  }

  // Post-parse: mark stations as surface if:
  //   1. Their coordinates appear in a surface-flagged segment (FS flag), OR
  //   2. Their survey has no shots at all (station-only surveys = surface benchmarks)
  const _surveyHasShots = new Set(result.segments.map(s => s.survey));
  const _surfaceKeys = new Set();
  for (const seg of result.segments) {
    if (seg.isSurface) {
      for (const pt of seg.points) {
        _surfaceKeys.add(`${pt.e.toFixed(2)},${pt.n.toFixed(2)},${pt.v.toFixed(2)}`);
      }
    }
  }
  for (const stn of result.stations) {
    if (!_surveyHasShots.has(stn.survey)) { stn.isSurface = true; continue; }
    const key = `${stn.e.toFixed(2)},${stn.n.toFixed(2)},${stn.v.toFixed(2)}`;
    if (_surfaceKeys.has(key)) stn.isSurface = true;
  }

  // A station is listed again each time a chain restarts from it (M back to
  // it, or a later survey tying in). Keep one entry per name and position, or
  // a large cave draws thousands of duplicate station dots.
  const _seenStn = new Set();
  result.stations = result.stations.filter(st => {
    const k = `${st.name}|${st.e.toFixed(2)}|${st.n.toFixed(2)}|${st.v.toFixed(2)}`;
    if (_seenStn.has(k)) return false;
    _seenStn.add(k);
    return true;
  });

  return result;
}

/**
 * The parts that need Cesium. Called by flex.js where this section used to be.
 * @param {object} deps
 * @param {object} deps.Cesium  the Cesium namespace (window.Cesium in FLEX)
 * @returns {{ pltToCartesian: function }}
 */
export function setupCompassPlt({ Cesium } = {}) {
  if (!Cesium) throw new Error('compass-plt: Cesium missing');

  // ── Convert parsed PLT coords → Cesium Cartesian3 positions ──────────────────
  // Uses the UTM zone from the file (or override from wizard).
  // Returns null if georef fails.
  function pltToCartesian(parsed, zoneOverride, southOverride) {
    const zone   = zoneOverride  ?? parsed.utmZone;
    const isNorth = southOverride !== undefined ? !southOverride : !parsed.utmSouth;

    if (!zone) return null;

    const convert = (n, e, v) => {
      const { lat, lon } = utmToLatLon(e, n, zone, isNorth);
      return Cesium.Cartesian3.fromDegrees(lon, lat, v);
    };

    // Build polyline position arrays per segment
    const segPositions = parsed.segments.map(seg =>
      seg.points
        .filter(p => !p.excluded)
        .map(p => convert(p.n, p.e, p.v))
        .filter(Boolean)
    ).filter(arr => arr.length >= 2);

    // Station positions
    const stationPositions = parsed.stations.map(s => ({
      pos:  convert(s.n, s.e, s.v),
      name: s.name,
      dist: s.dist,
    })).filter(x => x.pos);

    return { segPositions, stationPositions };
  }

  return { pltToCartesian };
}
