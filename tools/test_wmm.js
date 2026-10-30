// Checks the WMM2025 declination in server.js (and the copy in the portable
// viewer) against reference values from an independent implementation
// (pygeomag, a port of NOAA's geomag), at random places and dates in
// 2025-2030. Synthetic points only.
//
//   node tools/test_wmm.js
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
// [lat, lon, height m, decimal year, declination deg]
const REF = [
  [45.1234, -100.5678, 0, 2026.0, 5.27546],
  [-28.187, -125.694, 1953, 2025.36, 15.94702],
  [5.741, -48.352, 174, 2027.54, -18.61599],
  [-74.001, -23.888, 210, 2025.45, -4.68088],
  [-12.077, 117.667, 371, 2026.12, 0.98088],
  [20.389, 161.175, 1731, 2026.98, 3.2444],
  [76.201, -163.23, 2575, 2026.45, 4.86328],
  [-56.919, -137.595, 925, 2029.08, 38.05135],
  [-51.084, 29.376, 1917, 2026.86, -41.86854],
  [7.639, -157.396, 179, 2026.03, 8.87102],
  [28.864, -26.067, 942, 2027.93, -6.92295],
  [-7.49, -72.084, 2383, 2028.49, -9.05947],
  [-40.945, 26.793, 1576, 2029.38, -37.62164],
  [36.711, -76.342, 2941, 2025.59, -10.74777],
  [-13.1, 92.571, 456, 2027.44, -3.00156],
  [-73.727, 60.558, 2294, 2027.87, -72.78454],
  [60.076, -67.051, 2086, 2027.97, -21.30734],
  [12.783, -15.766, 2520, 2029.72, -5.03459],
  [-4.144, 59.095, 182, 2028.51, -5.30384],
  [23.541, 177.515, 2466, 2026.42, 6.94914],
  [-18.273, 60.715, 68, 2027.31, -15.66282],
  [-53.112, -137.846, 177, 2028.84, 33.72025],
  [-59.306, -90.859, 1173, 2029.36, 27.8885],
  [-67.107, -18.293, 1648, 2029.42, -8.90864],
  [51.085, 131.034, 835, 2027.08, -13.20663]
];
let fail = 0;
for (const [file, label] of [['server.js', 'server'], [path.join('viewer_build', 'viewer.html'), 'viewer']]) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const m = src.match(/function wmmDeclination\([\s\S]*?\n\}\n/);
  if (!m) { console.error('FAIL ' + label + ': wmmDeclination not found'); fail++; continue; }
  const wmm = new Function(m[0] + '\nreturn wmmDeclination;')();
  let worst = 0;
  for (const [lat, lon, h, y, d] of REF) worst = Math.max(worst, Math.abs(wmm(lat, lon, h, y) - d));
  if (worst > 1e-3) { console.error('FAIL ' + label + ': worst error ' + worst.toFixed(4) + ' deg'); fail++; }
  else console.log('ok ' + label + ': ' + REF.length + ' points, worst error ' + worst.toExponential(1) + ' deg');
}
process.exit(fail ? 1 : 0);
