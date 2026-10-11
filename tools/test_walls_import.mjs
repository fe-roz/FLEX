// Walls import (walls.js): synthetic shapefile exports → PLT → flex.js's own
// parsePLT. Builds the .dbf tables in memory (made-up cave, neutral
// coordinates), so it needs no files and no Walls.
//   node tools/test_walls_import.mjs
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readWallsShapefileSets, wallsToPlt, parsePrj, isWallsSelection } from '../walls.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const proj4 = createRequire(import.meta.url)(path.join(root, 'PotreeCopied/libs/proj4/proj4.js'));
const src = fs.readFileSync(path.join(root, 'flex.js'), 'utf8');
const a = src.indexOf('function parsePLT('), b = src.indexOf('\nfunction ', a + 10);
const parsePLT = new Function(src.slice(a, b) + '\nreturn parsePLT;')();
const FT = 0.3048;
let ok = 0, bad = 0;
const t = (c, m) => { if (c) ok++; else { bad++; console.log('FAIL', m); } };

// ── a dBase III writer, just enough for Walls' tables ──
function dbf(fields, rows) {        // fields: [name, 'C'|'N', len, dec]
  const hlen = 32 + 32 * fields.length + 1, rlen = 1 + fields.reduce((s, f) => s + f[2], 0);
  const buf = new Uint8Array(hlen + rlen * rows.length + 1), dv = new DataView(buf.buffer);
  buf[0] = 3; dv.setUint32(4, rows.length, true); dv.setUint16(8, hlen, true); dv.setUint16(10, rlen, true);
  fields.forEach(([name, type, len, dec], i) => {
    const o = 32 + 32 * i;
    for (let k = 0; k < name.length; k++) buf[o + k] = name.charCodeAt(k);
    buf[o + 11] = type.charCodeAt(0); buf[o + 16] = len; buf[o + 17] = dec;
  });
  buf[hlen - 1] = 0x0D;
  rows.forEach((r, j) => {
    let o = hlen + j * rlen; buf[o++] = 0x20;
    for (const [name, type, len, dec] of fields) {
      const v = r[name];
      let s = v == null ? '' : type === 'N' ? Number(v).toFixed(dec) : String(v);
      s = type === 'N' ? s.padStart(len).slice(0, len) : s.padEnd(len).slice(0, len);
      for (let k = 0; k < len; k++) buf[o + k] = s.charCodeAt(k);
      o += len;
    }
  });
  buf[buf.length - 1] = 0x1A;
  return buf.buffer;
}
const fileOf = (name, data) => ({ name, arrayBuffer: async () => data, text: async () => data });

// ── the made-up cave (WGS84 UTM 14N, metres) ──
const E0 = 376700, N0 = 4997850, Z0 = 300;
const S = new Map();
const st = (pfx, nm, e, n, z, lr) => S.set(pfx + '|' + nm, { pfx, nm, e, n, z, lr });
for (let i = 0; i < 6; i++) st('AB', String(i + 1), E0 + 10 * i, N0 + 3 * i, Z0 - 2 * i, null);
S.get('AB|1').lr = [1, 1, 2, 0.5]; S.get('AB|3').lr = [0, 0, 0, 0]; S.get('AB|4').lr = [2, 3, null, 1];
const s4 = S.get('AB|4');
for (let j = 0; j < 4; j++) st('', 'B' + (j + 1), s4.e + 5, s4.n + 8 * (j + 1), s4.z + 1.5 * j, [0.5, 0.5, 1, 0.3]);
const V = [];
for (let i = 1; i <= 5; i++) V.push(['A1', 'Entrance series', 20180512, ['AB', String(i)], ['AB', String(i + 1)]]);
V.push(['A1', 'Entrance series', 20180512, ['AB', '6'], ['AB', '3']]);       // closes a loop, follows on
V.push(['B2', 'Upper level', 19990301, ['AB', '4'], ['', 'B1']]);
V.push(['B2', 'Upper level', 19990301, ['', 'B1'], ['', 'B2']]);
V.push(['B2', 'Upper level', 19990301, ['', 'B2'], ['', 'B3']]);
V.push(['B2', 'Upper level', 19990301, ['', 'B4'], ['', 'B3']]);              // entered from its far end
V.push(['B2', 'Upper level', 19990301, ['', 'B3'], ['', 'GONE']]);            // to-station not exported

const VF = [['FR_PREFIX','C',8,0],['FR_NAME','C',8,0],['TO_PREFIX','C',8,0],['TO_NAME','C',8,0],['CTR_X','N',12,2],['CTR_Y','N',12,2],
  ['CTR_Z','N',10,2],['LENGTH','N',10,2],['AZIMUTH','N',5,1],['INCLINE','N',6,1],['LINETYPE','C',8,0],['DATE','N',8,0],
  ['SRV_NAME','C',8,0],['SRV_TITLE','C',48,0]];
const SF = (xyLen, xyDec) => [['PREFIX','C',8,0],['NAME','C',8,0],['X','N',xyLen,xyDec],['Y','N',xyLen,xyDec],['Z','N',10,2],
  ['LEFT','N',8,1],['RIGHT','N',8,1],['UP','N',8,1],['DOWN','N',8,1],['LRUD_AZ','N',8,1]];
const PRJ = {
  wgs: 'PROJCS["WGS_1984_UTM_Zone_14N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]]]]',
  nad27: 'PROJCS["NAD_1927_UTM_Zone_14N",GEOGCS["GCS_North_American_1927",DATUM["D_North_American_1927",SPHEROID["Clarke_1866",6378206.4,294.9786982]]]]',
  geo: 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]]]',
};
const wgsUtm = '+proj=utm +zone=14 +datum=WGS84 +units=m +no_defs';
const frames = {
  utm: (e, n) => [e, n],
  nad27: (() => { const tr = proj4(wgsUtm, '+proj=utm +zone=14 +ellps=clrk66 +towgs84=-8,160,176,0,0,0,0 +units=m +no_defs'); return (e, n) => tr.forward([e, n]); })(),
  geo: (() => { const tr = proj4(wgsUtm, '+proj=longlat +datum=WGS84 +no_defs'); return (e, n) => tr.forward([e, n]); })(),
};
function exportSet(base, { prj, frame = 'utm', unit = 1, xyDec = 2 }) {
  const xy = frames[frame];
  const sRows = [...S.values()].map(s => {
    const [x, y] = xy(s.e, s.n), lr = s.lr || [null, null, null, null];
    const u = v => v == null ? null : v / unit;
    return { PREFIX: s.pfx, NAME: s.nm, X: x, Y: y, Z: s.z, LEFT: u(lr[0]), RIGHT: u(lr[1]), UP: u(lr[2]), DOWN: u(lr[3]) };
  });
  const vRows = V.map(([srv, title, date, fr, to]) => {
    const A = S.get(fr.join('|')), B = S.get(to.join('|')) || A;
    return { FR_PREFIX: fr[0], FR_NAME: fr[1], TO_PREFIX: to[0], TO_NAME: to[1], LENGTH: Math.hypot(B.e - A.e, B.n - A.n, B.z - A.z) / unit,
             DATE: date, SRV_NAME: srv, SRV_TITLE: title, LINETYPE: 'FF0000' };
  });
  const files = [
    fileOf(base + '_V.dbf', dbf(VF, vRows)),
    fileOf(base + '_S.dbf', dbf(SF(xyDec > 2 ? 14 : 12, xyDec), sRows)),
    fileOf(base + '_N.dbf', dbf([...SF(12, 2).slice(0, 5), ['NOTE', 'C', 64, 0]],
      [{ PREFIX: 'AB', NAME: '2', NOTE: 'Squeeze on left' }, { PREFIX: '', NAME: 'B3', NOTE: 'Blowing lead "big"' }])),
    fileOf(base + '_F.dbf', dbf([...SF(12, 2).slice(0, 5), ['FLAGNAME', 'C', 64, 0]],
      [{ PREFIX: 'AB', NAME: '1', FLAGNAME: 'ENTRANCE' }, { PREFIX: '', NAME: 'B3', FLAGNAME: 'LEAD' }])),
    fileOf(base + '_V.shp', new ArrayBuffer(100)),                // geometry: present, not read
  ];
  if (prj) files.push(fileOf(base + '_V.prj', PRJ[prj]));
  return files;
}

async function check(label, opts, tol, units) {
  const files = exportSet('Ridge', opts);
  t(isWallsSelection(files), label + ': selection recognised');
  const [set] = await readWallsShapefileSets(files);
  const c = wallsToPlt(set, proj4), p = parsePLT(c.plt);
  t(c.zone === 14 && !c.south && p.utmZone === 14, label + ': zone 14N');
  t(c.stats.surveys === 2 && c.stats.shots === 10 && c.stats.skipped === 1, label + ': 2 surveys, 10 shots, 1 left out ' + JSON.stringify(c.stats));
  t(c.stats.units === units, label + ': LENGTH in ' + c.stats.units);
  t(p.surveys.map(s => s.code + '=' + s.desc).join(',') === 'A1=Entrance series,B2=Upper level', label + ': surveys');
  let worst = 0;
  for (const s of p.stations) {
    const k = s.name.includes(':') ? s.name.replace(':', '|') : '|' + s.name, r = S.get(k);
    worst = Math.max(worst, r ? Math.hypot(s.e - r.e, s.n - r.n, s.v - r.z) : Infinity);
  }
  t(worst < tol, `${label}: stations within ${tol} m (worst ${worst.toFixed(4)})`);
  const segs = p.segments.map(sg => sg.points.map(q => q.name).join(' ')).join(' | ');
  t(segs === 'AB:1 AB:2 AB:3 AB:4 AB:5 AB:6 AB:3 | AB:4 B1 B2 B3 B4', label + ': chains ' + segs);
  const lr = n => { const s = p.stations.find(q => q.name === n);
    return s && s.lrud ? [s.lrud.l, s.lrud.r, s.lrud.u, s.lrud.d].map(v => Math.round(v * 20) / 20) : null; };
  t(JSON.stringify(lr('AB:1')) === '[1,1,2,0.5]', label + ': LRUD in metres ' + JSON.stringify(lr('AB:1')));
  t(lr('AB:2') === null, label + ': blank LRUD → none');
  t(JSON.stringify(lr('AB:3')) === '[0,0,0,0]', label + ': 0/0/0/0 kept (FLEX draws a plain 2 ft tube)');
  t(JSON.stringify(lr('AB:4')) === '[2,3,-3,1]', label + ': one blank value → Compass sentinel');
  const com = n => (p.stations.find(q => q.name === n && q.comment) || {}).comment;
  t(com('AB:1') === '[ENTRANCE]' && com('AB:2') === 'Squeeze on left' && com('B3') === '[LEAD] Blowing lead big', label + ': notes and flags');
  t(p.leads.length === 1 && p.leads[0].station === 'B3' && p.leads[0].d === 'Blowing lead big', label + ': LEAD flag → lead');
  t(/^NA1 D 5 12 2018 /m.test(c.plt) && /^NB2 D 3 1 1999 /m.test(c.plt), label + ': survey dates');
  return c;
}

await check('UTM WGS84', { prj: 'wgs' }, 0.006, 'm');
await check('UTM, feet', { prj: 'wgs', unit: FT }, 0.006, 'ft');
const c27 = await check('UTM NAD27', { prj: 'nad27', frame: 'nad27' }, 0.02, 'm');
t(c27.warnings.some(w => /NAD27 shifted/.test(w)), 'NAD27 shift reported');
await check('lat/long', { prj: 'geo', frame: 'geo', xyDec: 8 }, 0.02, 'm');
{
  const [set] = await readWallsShapefileSets(exportSet('Ridge', {}));
  const c = wallsToPlt(set, proj4);
  t(c.zone === null && !/^G/m.test(c.plt) && c.warnings.some(w => /zone has to be entered/.test(w)), 'no .prj: zone left to the wizard');
}
{
  const [set] = await readWallsShapefileSets(exportSet('Ridge', { prj: 'geo', frame: 'geo', xyDec: 2 }));
  let err = ''; try { wallsToPlt(set, proj4); } catch (e) { err = e.message; }
  t(/export again from Walls with UTM/.test(err), 'two-decimal lat/long refused');
}
{
  let err = ''; try { await readWallsShapefileSets(exportSet('Ridge', { prj: 'wgs' }).filter(f => !/_S\.dbf$/.test(f.name))); }
  catch (e) { err = e.message; }
  t(/needs both Ridge_V\.dbf .* and Ridge_S\.dbf/.test(err), 'missing stations table explained');
}
t(!isWallsSelection([{ name: 'cave.plt' }]), 'a .plt is not a Walls selection');
const pz = parsePrj('PROJCS["NAD_1983_UTM_Zone_16S",GEOGCS["GCS_North_American_1983"]]');
t(pz.zone === 16 && pz.south && pz.datum === 'NAD83' && !pz.geographic, 'prj: zone, hemisphere, datum');

console.log(`${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
