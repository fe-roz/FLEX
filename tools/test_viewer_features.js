// Test for the viewer's surface features (viewer_build/libs/viewer-features.js), without a browser.
//
// Loads the real three.js r128 the viewer ships and the module into one context with a made-up FEATURES
// (points with every symbol the desktop has, lines, areas, folders three deep, a long name, a line that
// runs off the map, an item in no folder), a flat-ish made-up ground, and checks: nothing at all when
// FEATURES is null or empty; the folder tree and its counts; what is drawn and how (never hidden by the
// terrain, after it, fixed size on screen; lines draped; width, colour and opacity carried); names only
// where they fit; every switch; a tap; the card; the Display rows; the saved choices; 500 items quickly.
// Example names only.
//
//   node tools/test_viewer_features.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
let fail = 0, pass = 0;
function ok(label, cond, info) {
  if (cond) { pass++; return; }
  fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + (typeof info === 'string' ? info : JSON.stringify(info)).slice(0, 500) : ''));
}
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;

// ── A made-up map: metres from 45.1234, -100.5678; the ground a gentle slope ──
const LAT0 = 45.1234, LON0 = -100.5678, MX = 111320 * Math.cos(LAT0 * Math.PI / 180), MY = 110540;
const ll = (x, y) => [+(LON0 + x / MX).toFixed(7), +(LAT0 + y / MY).toFixed(7)];
const groundAt = (x, y) => (Math.abs(x) > 500 || Math.abs(y) > 500) ? null : 1000 + 0.05 * x + 0.02 * y;   // no ground past 500 m
const SYMBOLS = ['dot', 'square', 'triangle', 'diamond', 'star', 'cross'];
function features() {
  const folders = [{ id: 'gA', name: 'Cave Ridge', parent: '' }, { id: 'gB', name: 'Entrances', parent: 'gA' }, { id: 'gC', name: 'Sinks', parent: 'gB' },
                   { id: 'gD', name: 'Trails', parent: '' }, { id: 'gE', name: 'Orphan', parent: 'nowhere' }];
  const items = [];
  SYMBOLS.forEach((s, i) => items.push({ id: 'p' + i, kind: 'point', name: 'Point ' + s, folder: 'gB', colour: '#ff0000', symbol: s, width: 2, opacity: 1, lonlat: [ll(-200 + i * 60, 100)] }));
  items.push({ id: 'pLong', kind: 'point', name: 'A very long name for a point that nobody could read on a phone screen at all', folder: 'gC', colour: '#00ff00', symbol: 'star', width: 2, opacity: 0.5, note: 'Blowing hole <b>under</b> the ledge\nsecond line', lonlat: [ll(0, -100)] });
  items.push({ id: 'pNoName', kind: 'point', name: '', folder: 'gC', colour: '#00ff00', symbol: 'dot', width: 2, opacity: 1, lonlat: [ll(40, -100)] });
  items.push({ id: 'pQuiet', kind: 'point', name: 'No label', folder: 'gC', colour: '#00ff00', symbol: 'dot', width: 2, opacity: 1, label: false, lonlat: [ll(80, -100)] });
  items.push({ id: 'pLoose', kind: 'point', name: 'Loose point', folder: '', colour: 'not-a-colour', symbol: 'heart', width: 2, opacity: 1, lonlat: [ll(-300, -300)] });
  items.push({ id: 'l1', kind: 'line', name: 'Old trail', folder: 'gD', colour: '#0000ff', symbol: 'dot', width: 4, opacity: 0.8, lonlat: [ll(-100, 0), ll(0, 0), ll(100, 50)] });
  items.push({ id: 'lOut', kind: 'line', name: 'Road out', folder: 'gD', colour: '#ffffff', symbol: 'dot', width: 1, opacity: 1, lonlat: [ll(400, 0), ll(700, 0)] });   // half inside the map
  items.push({ id: 'a1', kind: 'area', name: 'Sink field', folder: 'gA', colour: '#ffff00', symbol: 'dot', width: 2, opacity: 1, lonlat: [ll(200, 200), ll(300, 200), ll(300, 300), ll(200, 300)] });
  items.push({ id: 'pE', kind: 'point', name: 'In the orphan folder', folder: 'gE', colour: '#ff00ff', symbol: 'cross', width: 2, opacity: 1, lonlat: [ll(-350, 350)] });
  return { version: 1, folders, items };
}

function makeViewer() {
  const ctx = { console: { warn() {}, log: console.log, error: console.error, info() {} }, Math, Promise, setTimeout, clearTimeout, Date, window: {} };
  const canvases = [];
  const g2d = () => new Proxy({ calls: [] }, { get: (t, k) => k in t ? t[k] : (...a) => { t.calls.push(k); }, set: (t, k, v) => { t[k] = v; return true; } });
  ctx.document = { createElement: () => { const c = { width: 0, height: 0, g: g2d(), getContext() { return c.g; } }; canvases.push(c); return c; } };
  ctx.window.document = ctx.document; ctx.window.innerWidth = 1200; ctx.window.innerHeight = 800;
  ctx.window.addEventListener = () => {};
  ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'three.min.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'viewer_build', 'libs', 'viewer-features.js'), 'utf8'), ctx);
  const THREE = ctx.THREE, VF = ctx.window.ViewerFeatures;
  const camera = new THREE.PerspectiveCamera(50, 1200 / 800, 1, 50000);
  camera.up.set(0, 0, 1); camera.position.set(0, -900, 1900); camera.lookAt(0, 0, 1000); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
  const v = { ctx, THREE, VF, canvases, camera, scene: new THREE.Scene(), redraws: 0, cards: [], flown: [], labels: [], listeners: {} };
  v.opts = (F, saved) => ({ THREE, scene: v.scene, camera, renderer: { domElement: { clientWidth: 1200, clientHeight: 800 } },
    controls: { addEventListener: (n, f) => { v.listeners[n] = f; } }, features: F, saved,
    toScene: (lat, lon) => ({ x: (lon - LON0) * MX, y: (lat - LAT0) * MY }), groundZ: groundAt,
    textSprite: (text, colour) => { v.labels.push([text, colour]); const sp = new THREE.Sprite(new THREE.SpriteMaterial()); return { sprite: sp, aspect: Math.max(1, text.length * 0.55) }; },
    showInfo: (t, s, rows) => v.cards.push([t, s, rows]), flyTo: p => v.flown.push(p), fmtLen: m => Math.round(m) + ' m', redraw: () => { v.redraws++; } });
  return v;
}
// the Display sheet's builders, as plain objects
function fakeUi() {
  const mk = (tag, cls, text) => ({ tag, className: cls || '', textContent: text == null ? '' : text, children: [], style: {}, dataset: {}, listeners: {},
    appendChild(c) { this.children.push(c); return c; }, addEventListener(n, f) { this.listeners[n] = f; },
    set id(v) { this._id = v; }, get id() { return this._id; } });
  const sheet = mk('div'); const heads = [], chips = [];
  const ui = { el: mk, sheet, head: t => heads.push(t), chips: c => chips.push(...c), close: () => { ui.closed = (ui.closed || 0) + 1; } };
  const box = () => sheet.children.find(c => c.className === 'vf-list');
  const wipe = b => { Object.defineProperty(b, 'textContent', { set(v) { if (v === '') b.children.length = 0; }, get() { return ''; }, configurable: true }); };
  return { ui, heads, chips, box, wipe };
}

(async () => {
  // ── 1. Nothing at all without features ──────────────────────────────────────
  for (const F of [null, undefined, { version: 1, folders: [], items: [] }, { surveys: [] }]) {
    const v = makeViewer();
    const r = await v.VF.init(v.opts(F));
    ok('no features: init says false, nothing in the scene, not active', r === false && v.scene.children.length === 0 && !v.VF.active() && v.VF.serialize() === undefined && v.VF.pick(1, 1, { width: 10, height: 10 }) === null, [r, v.scene.children.length]);
    const u = fakeUi(); v.VF.sheet(u.ui);
    ok('no features: no rows in Display', u.heads.length === 0 && u.ui.sheet.children.length === 0);
  }

  // ── 2. The made-up project ──────────────────────────────────────────────────
  const v = makeViewer(), F = features(), T = v.THREE;
  ok('init with features', await v.VF.init(v.opts(F)) === true && v.VF.active() && v.VF.count() === F.items.length, v.VF.count());
  const fo = v.VF.folders(), byId = Object.fromEntries(fo.map(f => [f.id, f]));
  ok('folders in tree order, parents first, by name; "No folder" last', fo.map(f => f.id).join(',') === 'gA,gB,gC,gE,gD,', fo.map(f => f.id));
  ok('three levels deep with their paths', byId.gC.depth === 2 && byId.gC.path === 'Cave Ridge / Entrances / Sinks' && byId.gB.depth === 1 && byId.gA.depth === 0);
  ok('a folder whose parent is not in the file is a top folder', byId.gE.depth === 0 && byId.gE.parent === '');
  ok('counts: own items and everything below', byId.gA.items === 1 && byId.gA.total === 1 + 6 + 3 && byId.gB.items === 6 && byId.gB.total === 9 && byId.gC.total === 3 && byId[''].total === 1, fo);
  const O = v.VF.objects();
  ok('one group per folder, and the names apart', Object.keys(O.groups).length === 6 && v.scene.children.length === 7 && O.labels.name === 'features-labels');

  // points
  const rec = id => O.recs.find(r => r.item.id === id);
  const pts = O.recs.filter(r => r.sprite);
  ok('every point is a sprite of a fixed size on screen, never hidden by the terrain, drawn after it',
     pts.length === 11 && pts.every(r => r.sprite.isSprite && r.sprite.material.sizeAttenuation === false && r.sprite.material.depthTest === false && r.sprite.renderOrder > 1), pts.length);
  const sc = 2 * Math.tan(50 * Math.PI / 360) * 18 / 800;
  ok('18 px on an 800 px screen', near(rec('p0').sprite.scale.x, sc, 1e-6) && near(rec('p0').sprite.scale.y, sc, 1e-6));
  ok('a point stands on the ground (0.6 m over it)', near(rec('p0').sprite.position.z, groundAt(-200, 100) + 0.6, 0.01) && near(rec('p0').sprite.position.x, -200, 0.05), rec('p0').sprite.position);
  const maps = SYMBOLS.map((s, i) => rec('p' + i).sprite.material.map);
  ok('every symbol the desktop has gets its own picture', new Set(maps).size === 6 && v.VF.SYMBOLS.join() === SYMBOLS.join());
  ok('the same symbol and colour share one picture; opacity is the item\'s', rec('pNoName').sprite.material.map === rec('pQuiet').sprite.material.map && rec('pLong').sprite.material.opacity === 0.5);
  ok('an unknown symbol is a dot, a bad colour the project\'s default', rec('pLoose').sprite.material.map !== maps[0] && v.canvases.some(c => c.g.fillStyle === '#ffb020'));
  SYMBOLS.forEach(s => { const c = v.VF.symbolCanvas(s, '#123456', 64); ok('symbol ' + s + ' is drawn (outline twice, fill once)', c.g.calls.filter(k => k === 'stroke').length === 2 && c.g.calls.filter(k => k === 'fill').length === 1 && c.g.fillStyle === '#123456'); });

  // lines
  const gD = O.groups.gD, lm = gD.children.find(c => c.name === 'features-lines');
  ok('a folder\'s lines are one mesh, through the terrain, after it', gD.children.length === 1 && lm && lm.material === O.lineMat && lm.material.depthTest === false && lm.material.transparent && lm.renderOrder > 1);
  const A = n => lm.geometry.getAttribute(n);
  const r1 = rec('l1');
  ok('the line is draped: a ground height every few metres', r1.xyz.length / 3 > 40 && near(r1.length, 100 + Math.hypot(100, 50), 0.5), [r1.xyz.length / 3, r1.length]);
  let worst = 0; for (let i = 0; i < r1.xyz.length; i += 3) worst = Math.max(worst, Math.abs(r1.xyz[i + 2] - (groundAt(r1.xyz[i], r1.xyz[i + 1]) + 0.6)));
  ok('every vertex 0.6 m over the ground under it', worst < 0.01, worst);
  const nseg1 = r1.xyz.length / 3 - 1, rOut = rec('lOut'), nsegOut = rOut.xyz.length / 3 - 1;
  ok('four vertices and two triangles a segment', A('position').count === 4 * (nseg1 + nsegOut) && lm.geometry.index.count === 6 * (nseg1 + nsegOut), [A('position').count, nseg1, nsegOut]);
  ok('width in pixels and colour with opacity per vertex', A('wpx').getX(0) === 4 && near(A('col').getZ(0), 1) && near(A('col').getX(0), 0) && near(A('col').getW(0), 0.8, 1e-6)
     && A('wpx').getX(4 * nseg1) === 1 && near(A('col').getX(4 * nseg1), 1), [A('wpx').getX(0), A('col').getW(0)]);
  ok('each end of a quad knows the other end, on both sides', A('other').getX(0) === A('position').getX(2) && A('side').getX(0) === 1 && A('side').getX(1) === -1 && A('side').getX(2) === -1 && A('side').getX(3) === 1);
  ok('the screen size reaches the shader', O.lineMat.uniforms.res.value.x === 1200 && O.lineMat.uniforms.res.value.y === 800 && /wpx \/ res/.test(O.lineMat.vertexShader));
  let zOut = []; for (let i = 0; i < rOut.xyz.length; i += 3) zOut.push(rOut.xyz[i + 2]);
  ok('a line that leaves the map keeps the last height it had (no dive to zero)', zOut.every(z => z > 1000) && near(zOut[zOut.length - 1], groundAt(500, 0) + 0.6, 0.3), zOut.slice(-3));

  // areas
  const gA = O.groups.gA, fill = gA.children.find(c => c.name === 'features-fill'), al = gA.children.find(c => c.name === 'features-lines');
  ok('an area: its outline (closed) and a light fill', fill && al && fill.geometry.index.count === 6 && near(fill.geometry.getAttribute('color').getW(0), 0.18, 1e-6) && fill.material.depthTest === false, fill && fill.geometry.index.count);
  const ra = rec('a1');
  ok('outline length and area measured', near(ra.length, 400, 1) && near(ra.area, 10000, 30) && near(ra.at.x, 250, 1) && near(ra.at.y, 250, 1), [ra.length, ra.area, ra.at]);

  // names
  const named = O.recs.filter(r => r.label && r.label.visible).map(r => r.item.id);
  ok('names: shown for named items, not for the unnamed one or the one with its label off', named.includes('l1') && named.includes('a1') && !named.includes('pNoName') && !named.includes('pQuiet') && !rec('pQuiet').label, named);
  ok('a long name is cut short with an ellipsis; the colour is the item\'s, lightened', v.labels.some(l => l[0].length === 30 && l[0].endsWith('…')) && v.VF.labelColour('#ff0000') === '#ff8c8c' && v.VF.shortName('abc') === 'abc', v.labels.filter(l => l[0].length > 25));
  ok('names are fixed in size and never hidden by the terrain', rec('l1').label.material.sizeAttenuation === false && rec('l1').label.material.depthTest === false);
  ok('names are worked out again when the view comes to rest, not per frame', typeof v.listeners.end === 'function' && typeof v.listeners.change === 'function');
  // crowded names: 40 points on one spot show one name
  const vc = makeViewer();
  await vc.VF.init(vc.opts({ version: 1, folders: [], items: Array.from({ length: 40 }, (_, i) => ({ id: 'c' + i, kind: 'point', name: 'Crowd ' + i, folder: '', colour: '#ffffff', symbol: 'dot', width: 2, opacity: 1, lonlat: [ll(i * 0.01, 0)] })) }));
  ok('names that would overlap are left out: 40 points on one spot show one name', vc.VF.objects().labelsShown === 1 && vc.labels.length === 40 - 39 + 0 || vc.VF.objects().labelsShown === 1, [vc.VF.objects().labelsShown, vc.labels.length]);

  // ── 3. Switches ─────────────────────────────────────────────────────────────
  const before = v.redraws;
  v.VF.setFolder('gB', false);
  ok('a folder off hides it and the folders inside it; the rest stay', !O.groups.gB.visible && !O.groups.gC.visible && O.groups.gA.visible && O.groups.gD.visible && v.redraws > before);
  ok('…and their names', !rec('p0').label || !rec('p0').label.visible);
  ok('folders() says so', v.VF.folders().find(f => f.id === 'gC').shown === false && v.VF.folders().find(f => f.id === 'gC').on === true && v.VF.folders().find(f => f.id === 'gB').on === false);
  ok('saved choices', JSON.stringify(v.VF.serialize()) === JSON.stringify({ all: true, labels: true, off: ['gB'] }));
  v.VF.setFolder('gB', true);
  ok('on again', O.groups.gB.visible && O.groups.gC.visible);
  v.VF.setLabels(false);
  ok('Names off: no names, the items stay', !O.labels.visible && O.groups.gA.visible);
  v.VF.setLabels(true);
  v.VF.setAll(false);
  ok('All off: every folder and the names hidden, no tap answers', Object.values(O.groups).every(g => !g.visible) && !O.labels.visible && v.VF.pick(600, 400, { width: 1200, height: 800 }) === null);
  v.VF.setAll(true);
  const v2 = makeViewer();
  await v2.VF.init(v2.opts(features(), { all: true, labels: false, off: ['gD', 'gone'] }));
  ok('saved choices come back', !v2.VF.objects().groups.gD.visible && v2.VF.objects().groups.gA.visible && !v2.VF.objects().labels.visible && v2.VF.state().off.includes('gD'));

  // ── 4. A tap ────────────────────────────────────────────────────────────────
  const rect = { width: 1200, height: 800 };
  const scr = p => { const q = p.clone().project(v.camera); return [(q.x + 1) * 600, (1 - q.y) * 400]; };
  let s = scr(rec('p3').at), hit = v.VF.pick(s[0] + 5, s[1] - 4, rect);
  ok('a tap near a point finds it', hit && hit.id === 'p3' && hit.d < 8, hit);
  s = scr(new T.Vector3(-50, 0, groundAt(-50, 0) + 0.6)); hit = v.VF.pick(s[0], s[1] + 6, rect);
  ok('a tap on a line finds it', hit && hit.id === 'l1', hit);
  s = scr(new T.Vector3(250, 200, groundAt(250, 200))); hit = v.VF.pick(s[0], s[1], rect);
  ok('a tap on an area\'s outline finds it', hit && hit.id === 'a1', hit);
  ok('a tap on bare ground finds nothing', v.VF.pick(40, 40, rect) === null);
  v.VF.setFolder('gD', false); s = scr(new T.Vector3(-50, 0, groundAt(-50, 0) + 0.6));
  ok('a hidden folder\'s items do not answer', v.VF.pick(s[0], s[1], rect) === null);
  v.VF.setFolder('gD', true);
  ok('open: the card with name, folder path and note (HTML made safe)', v.VF.open('pLong') === true && v.cards.length === 1 && v.cards[0][0].startsWith('A very long name') && /view only/.test(v.cards[0][1])
     && v.cards[0][2][0][1] === 'Cave Ridge / Entrances / Sinks' && v.cards[0][2][1][1] === 'Blowing hole &lt;b&gt;under&lt;/b&gt; the ledge<br>second line', v.cards[0]);
  ok('a line\'s card has its length, an area\'s its outline and area, an unnamed point is "Point"', v.VF.info('l1')[2].some(r => r[0] === 'Length' && r[1] === '212 m') && v.VF.info('a1')[2].some(r => r[0] === 'Area' && /^(1\.00 ha|9999 m\u00b2)$/.test(r[1]))
     && v.VF.info('pNoName')[0] === 'Point' && v.VF.info('pLoose')[2][0][1] === 'No folder', [v.VF.info('l1'), v.VF.info('a1')]);
  ok('an unknown id opens nothing', v.VF.open('nope') === false && v.VF.info('nope') === null);
  ok('nothing here can change the data: no edit or delete in the API', !Object.keys(v.VF).some(k => /edit|delete|remove|save|add/i.test(k)));

  // ── 5. The Display rows ─────────────────────────────────────────────────────
  const u = fakeUi(); v.VF.sheet(u.ui); const box = u.box(); u.wipe(box);
  ok('Display: a "Surface features" head, All (n) and Names chips', u.heads.join() === 'Surface features' && u.chips.length === 2 && u.chips[0][1] === 'All (14)' && u.chips[0][2] === true && u.chips[1][1] === 'Names');
  let rows = box.children;
  ok('one row per folder, indented by depth, with its count', rows.length === 6 && rows[0].dataset.folder === 'gA' && rows[2].style.paddingLeft === '42px' && rows[0].children[1].children[0].textContent === '10 items · 1 here', rows.map(r => r.dataset.folder));
  const sw = r => r.children[2];
  ok('each with an On / Off switch', rows.every(r => sw(r).tag === 'button' && sw(r).textContent === 'On'));
  sw(rows[1]).listeners.click({ stopPropagation() {} });
  rows = box.children;
  ok('the switch turns the folder off, and the folders inside are dimmed', !O.groups.gB.visible && sw(rows[1]).textContent === 'Off' && rows[2].style.opacity === '0.45' && rows[0].style.opacity === '1');
  sw(rows[1]).listeners.click({ stopPropagation() {} });
  rows = box.children;
  rows[1].listeners.click();
  rows = box.children;
  ok('a tap on a folder lists its items', rows.length === 6 + 6 && rows[2].dataset.item === 'p3' || rows.filter(r => r.dataset.item).length === 6, rows.map(r => r.dataset.item || r.dataset.folder));
  const itemRow = rows.find(r => r.dataset.item === 'p2');
  itemRow.listeners.click();
  ok('a tap on an item closes the sheet, flies to it and opens its card', u.ui.closed === 1 && v.flown.length === 1 && near(v.flown[0].x, -80, 0.1) && v.cards[v.cards.length - 1][0] === 'Point triangle', [u.ui.closed, v.flown]);
  u.chips[0][3](false);
  ok('the All chip turns everything off', v.VF.state().all === false && box.children[0].style.opacity === '0.45');
  u.chips[0][3](true);

  // ── 6. 500 items ────────────────────────────────────────────────────────────
  const big = { version: 1, folders: Array.from({ length: 20 }, (_, i) => ({ id: 'f' + i, name: 'Folder ' + i, parent: i % 5 ? 'f' + (i - 1) : '' })), items: [] };
  for (let i = 0; i < 500; i++) {
    const x = (i % 25) * 36 - 450, y = Math.floor(i / 25) * 44 - 440, folder = 'f' + (i % 20);
    if (i % 5 === 3) big.items.push({ id: 'i' + i, kind: 'line', name: 'Trail ' + i, folder, colour: '#33aaff', symbol: 'dot', width: 3, opacity: 1, lonlat: Array.from({ length: 40 }, (_, k) => ll(x + k * 0.8, y + 6 * Math.sin(k / 3))) });
    else if (i % 5 === 4) big.items.push({ id: 'i' + i, kind: 'area', name: 'Area ' + i, folder, colour: '#ffaa00', symbol: 'dot', width: 2, opacity: 0.7, lonlat: Array.from({ length: 12 }, (_, k) => ll(x + 12 * Math.cos(k * Math.PI / 6), y + 12 * Math.sin(k * Math.PI / 6))) });
    else big.items.push({ id: 'i' + i, kind: 'point', name: 'Point ' + i, folder, colour: ['#ff5555', '#55ff55', '#5599ff'][i % 3], symbol: SYMBOLS[i % 6], width: 2, opacity: 1, lonlat: [ll(x, y)] });
  }
  const vb = makeViewer(), t0 = Date.now();
  await vb.VF.init(vb.opts(big));
  const ms = Date.now() - t0, Ob = vb.VF.objects();
  const draws = Object.values(Ob.groups).reduce((n, g) => n + g.children.filter(c => !c.isSprite).length, 0);
  ok('500 items build in well under a second (' + ms + ' ms)', ms < 1000 && vb.VF.count() === 500, ms);
  ok('lines and fills are merged per folder: 200 lines and areas in ' + draws + ' meshes', draws <= 40 && draws >= 8, draws);
  ok('symbol pictures are shared: at most 18 for 300 points', new Set(Ob.recs.filter(r => r.sprite).map(r => r.sprite.material.map)).size <= 18);
  ok('names are capped (at most 140 at once), made only when shown', Ob.labelsShown > 20 && Ob.labelsShown <= 140 && vb.labels.length <= 500, [Ob.labelsShown, vb.labels.length]);
  const t1 = Date.now(); for (let k = 0; k < 20; k++) vb.VF.relabel(); const per = (Date.now() - t1) / 20;
  ok('working the names out again takes a few ms (' + per.toFixed(1) + ' ms)', per < 30, per);
  const t2 = Date.now(); for (let k = 0; k < 50; k++) vb.VF.pick(300 + k * 9, 400, rect); const tap = (Date.now() - t2) / 50;
  ok('a tap is answered in a few ms (' + tap.toFixed(1) + ' ms)', tap < 30, tap);

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
