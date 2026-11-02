// Placing a UTM-georeferenced cave on the globe: the WGS84 → UTM forward
// conversion, the survey-height datum shift, and the survey-space → world
// function for UTM caves. Moved out of flex.js unchanged (the flex.js split,
// wave 1; see client/src/README.md for the pattern).
//
// Pure export (no browser, no Cesium), node-testable:
//   latLonToUtm(lat, lon, zone, isNorth = true) -> { e, n }   (Snyder; inverse of compass-plt.js utmToLatLon)
// Setup:
//   setupCaveUtm({ Cesium, viewModel, meanSeaLevel, utmToLatLon, computeWarpedOffset })
//     -> { pcDatumDz(lat, lon), caveUtmConvertFn(imp) }
//
// window._pcDatumDz is defined here (the export's terrain shift, index.html).

// Survey-space → world for a UTM-georeferenced cave (the anchor case builds
// its own convertFn inside _rerenderCave).
// WGS84 → UTM in a given zone (Snyder; the same series as the portable viewer
// and export_terrain.py). Used to bring rectify control points into a UTM
// cave's own coordinates.
export function latLonToUtm(lat, lon, zone, isNorth = true) {
  const a = 6378137.0, f = 1 / 298.257223563;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2), k0 = 0.9996;
  const latR = lat * Math.PI / 180;
  const lon0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(latR) ** 2);
  const T = Math.tan(latR) ** 2;
  const C = ep2 * Math.cos(latR) ** 2;
  const A = Math.cos(latR) * (lon * Math.PI / 180 - lon0);
  const M = a * ((1 - e2/4 - 3*e2**2/64 - 5*e2**3/256) * latR
            - (3*e2/8 + 3*e2**2/32 + 45*e2**3/1024) * Math.sin(2*latR)
            + (15*e2**2/256 + 45*e2**3/1024) * Math.sin(4*latR)
            - (35*e2**3/3072) * Math.sin(6*latR));
  const e = 500000 + k0 * N * (A + (1 - T + C) * A**3 / 6
            + (5 - 18*T + T**2 + 72*C - 58*ep2) * A**5 / 120);
  let n = k0 * (M + N * Math.tan(latR) * (A**2 / 2 + (5 - T + 9*C + 4*C**2) * A**4 / 24
            + (61 - 58*T + T**2 + 600*C - 330*ep2) * A**6 / 720));
  if (!isNorth) n += 10000000;
  return { e, n };
}


export function setupCaveUtm({
  Cesium, viewModel, meanSeaLevel, utmToLatLon,
  computeWarpedOffset: _computeWarpedOffset,      // (dE, dN, dV, pairs) -> { e, n, v }
} = {}) {
  if (!Cesium) throw new Error('cave-utm: Cesium missing');

  // Survey heights → the globe. Survey files, like LAS, hold heights above sea
  // level; Cesium wants heights above the ellipsoid. Point clouds get a vertical
  // shift for that (applyPcMatrix: EGM96 geoid, USGS −32 m, or the default
  // −32×0.766 m), and a UTM cave gets the same one, so it lines up with the
  // LiDAR and the terrain the LiDAR was matched to. Per cave, "as in file"
  // (georef.heights = 'file') turns it off.
  function _pcDatumDz(lat, lon) {
    if (viewModel.egm96) return meanSeaLevel(lat, lon);
    if (viewModel.usgsRef) return -32;
    return -32 * 0.766;
  }
  window._pcDatumDz = _pcDatumDz;          // the export's terrain shift (index.html)

  function _caveUtmConvertFn(imp) {
    const g = imp.georef || {};
    const zone = g.zone ?? imp.parsed.utmZone;
    if (!zone) return null;
    const isNorth = g.south !== undefined ? !g.south : !imp.parsed.utmSouth;

    // Vertical shift (see _pcDatumDz), worked out once at the cave's middle.
    // It is added to v before anything else, so control points still pin their
    // stations exactly where they were put.
    let dz = 0;
    if (g.heights !== 'file') {
      const st = imp.parsed.stations;
      let e = 0, n = 0, k = 0;
      for (const s of st) if (Number.isFinite(s.e) && Number.isFinite(s.n)) { e += s.e; n += s.n; k++; }
      if (k) { const ll = utmToLatLon(e / k, n / k, zone, isNorth); dz = _pcDatumDz(ll.lat, ll.lon); }
    }
    imp._heightDz = dz;          // drawn height − file height (elevation colours undo it)

    // Rectify control points: each pins a station to a picked position. They
    // warp the cave in its own UTM metres with the same method as anchored
    // caves (_computeWarpedOffset: one point shifts, two or more also rotate
    // and scale, three or more bend locally), around the stations' centroid.
    const pairs = [];
    let o = null;
    const cps = g.controlPoints || [];
    if (cps.length) {
      const byName = new Map();
      for (const st of imp.parsed.stations) if (!byName.has(st.name)) byName.set(st.name, st);
      const used = cps.map(cp => ({ cp, st: byName.get(cp.station) })).filter(x => x.st);
      if (used.length) {
        o = { e: 0, n: 0, v: 0 };
        for (const { st } of used) { o.e += st.e; o.n += st.n; o.v += st.v + dz; }
        o.e /= used.length; o.n /= used.length; o.v /= used.length;
        for (const { cp, st } of used) {
          const u = latLonToUtm(cp.lat, cp.lon, zone, isNorth);
          pairs.push({ src: { e: st.e - o.e, n: st.n - o.n, v: st.v + dz - o.v },
                       dst: { e: u.e - o.e, n: u.n - o.n, v: cp.elev - o.v } });
        }
      }
    }
    return (n, e, v) => {
      v += dz;
      if (pairs.length) {
        const w = _computeWarpedOffset(e - o.e, n - o.n, v - o.v, pairs);
        e = o.e + w.e; n = o.n + w.n; v = o.v + w.v;
      }
      const { lat, lon } = utmToLatLon(e, n, zone, isNorth);
      return Cesium.Cartesian3.fromDegrees(lon, lat, v);
    };
  }

  return { pcDatumDz: _pcDatumDz, caveUtmConvertFn: _caveUtmConvertFn };
}
