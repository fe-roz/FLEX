// veg-draw.js, the pure parts: parsing shapes.bin / shell.bin / ground.bin, the batched crown mesh (counts, winding,
// heights, variation), the shell mesh, the terrain-difference grid and its bilinear interpolation, settings clamp.
// Made-up data only (tools/veg_fixture.js). Run: node tools/test_veg_draw.js
'use strict';
const path = require('path');
const M = require('./load_classic')(path.join(__dirname, '..', 'client', 'src', 'modules', 'veg-draw.js'));
const { makeVegFixture, groundAt } = require('./veg_fixture');
let pass = 0, fail = 0;
const ok = (l, c, i) => { if (c) pass++; else { fail++; console.error('FAIL ' + l + (i !== undefined ? '\n  ' + JSON.stringify(i) : '')); } };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-6);

const F = makeVegFixture({ seed: 3 });
const veg = F.veg;

// ── parsing ──
{
  const s = M.parseShapes(F.shapes, veg.shapes.count);
  ok('shapes: count from veg.json', s.n === veg.shapes.count && s.rec.length === s.n * 8);
  ok('shapes: record 0 is the tallest tree', s.rec[6] !== 2 && s.rec[3] >= s.rec[8 + 3]);
  ok('shapes: a short file gives what is there', M.parseShapes(F.shapes.slice(0, 32 * 5 + 7), 999).n === 5);
  ok('shapes: typed array or Buffer accepted', M.parseShapes(Buffer.from(F.shapes), veg.shapes.count).n === veg.shapes.count && M.parseShapes(new Uint8Array(F.shapes), null).n === veg.shapes.count);
  ok('shapes: nothing is empty', M.parseShapes(null, 4).n === 0);
}
{
  const sh = M.parseShell(F.shell, veg.shell.vertices, veg.shell.triangles);
  ok('shell: vertices and triangles', sh.V === veg.shell.vertices && sh.T === veg.shell.triangles && sh.v.length === sh.V * 4 && sh.t.length === sh.T * 3);
  let thr = ''; try { M.parseShell(F.shell.slice(0, 100), veg.shell.vertices, veg.shell.triangles); } catch (e) { thr = e.message; }
  ok('shell: a short file is an error', /shorter/.test(thr), thr);
  const bad = F.shell.slice(0); new Uint32Array(bad, veg.shell.vertices * 16, 3)[1] = veg.shell.vertices + 5;
  thr = ''; try { M.parseShell(bad, veg.shell.vertices, veg.shell.triangles); } catch (e) { thr = e.message; }
  ok('shell: a corner past the vertices is an error', /corner/.test(thr), thr);
  ok('shell: absent is empty', M.parseShell(null, 0, 0).T === 0);
  // the fixture's blobs are closed and wound CCW from outside: normals point away from the blob's centre (mostly)
  let out = 0;
  for (let t = 0; t < 320; t++) {
    const [a, b, c] = [sh.t[t * 3], sh.t[t * 3 + 1], sh.t[t * 3 + 2]].map(i => [sh.v[i * 4], sh.v[i * 4 + 1], sh.v[i * 4 + 2]]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const ctr = [(a[0] + b[0] + c[0]) / 3 + 85, (a[1] + b[1] + c[1]) / 3, 0];
    if (n[0] * ctr[0] + n[1] * ctr[1] > 0 || n[2] > 0) out++;
  }
  ok('fixture shell: wound CCW from outside', out > 300, out);
}
{
  const g = veg.ground, gr = M.parseGround(F.ground, g.nx, g.ny);
  ok('ground: ny x nx', gr && gr.length === g.nx * g.ny);
  ok('ground: row 0 is south', near(gr[0], groundAt(g.x0, g.y0), 1e-3) && near(gr[g.nx * (g.ny - 1)], groundAt(g.x0, g.y0 + (g.ny - 1) * g.cell), 1e-3));
  ok('ground: short or missing is null', M.parseGround(F.ground.slice(0, 40), g.nx, g.ny) === null && M.parseGround(null, 3, 3) === null);
}

// ── bilinear, the terrain grid, the shift ──
{
  const g = new Float32Array([0, 10, 20, 30]);         // 2 x 2: (0,0)=0 (1,0)=10 (0,1)=20 (1,1)=30, cell 1
  ok('bilinear: corners', M.bilinear(g, 2, 2, 0, 0, 1, 1, 0, 0) === 0 && M.bilinear(g, 2, 2, 0, 0, 1, 1, 1, 1) === 30);
  ok('bilinear: middle', near(M.bilinear(g, 2, 2, 0, 0, 1, 1, 0.5, 0.5), 15) && near(M.bilinear(g, 2, 2, 0, 0, 1, 1, 0.25, 0), 2.5));
  ok('bilinear: clamped outside', M.bilinear(g, 2, 2, 0, 0, 1, 1, -5, -5) === 0 && M.bilinear(g, 2, 2, 0, 0, 1, 1, 9, 9) === 30);
  ok('bilinear: a 1 x 1 grid', M.bilinear(new Float32Array([7]), 1, 1, 0, 0, 1, 1, 3, 3) === 7);
  const sp = M.terrainGridSpec([-150, -150, 150, 150]);
  ok('terrain grid: <= 64 a side, nodes span the bbox', sp.nx <= 64 && sp.ny <= 64 && sp.nx >= 2 && near(sp.x0 + (sp.nx - 1) * sp.dx, 150));
  const big = M.terrainGridSpec([0, 0, 5000, 2000]);
  ok('terrain grid: a large area stays at 64', big.nx === 64 && big.ny === 64);
  const small = M.terrainGridSpec([0, 0, 15, 15]);
  ok('terrain grid: a small one is >= 2 a side', small.nx >= 2 && small.ny >= 2 && small.nx <= 3);
  // shown terrain = the job's ground - 1000 + a tilt: the shift is that difference everywhere
  const gs = { nx: veg.ground.nx, ny: veg.ground.ny, x0: veg.ground.x0, y0: veg.ground.y0, cell: veg.ground.cell };
  const gr = M.parseGround(F.ground, gs.nx, gs.ny);
  const tH = new Float32Array(sp.nx * sp.ny);
  for (let j = 0; j < sp.ny; j++) for (let i = 0; i < sp.nx; i++) { const x = sp.x0 + i * sp.dx, y = sp.y0 + j * sp.dy; tH[j * sp.nx + i] = M.bilinear(gr, gs.nx, gs.ny, gs.x0, gs.y0, gs.cell, gs.cell, x, y) - 1000 + 0.01 * x; }
  const sh = M.makeShift(sp, tH, gs, gr);
  ok('shift: the difference at nodes', near(sh.at(sp.x0, sp.y0), -1000 + 0.01 * sp.x0, 1e-3) && near(sh.at(150, 150), -1000 + 1.5, 1e-3));
  ok('shift: interpolated between nodes', near(sh.at(3.3, -7.1), -1000 + 0.033, 1e-3), sh.at(3.3, -7.1));
  tH[5] = NaN;
  const sh2 = M.makeShift(sp, tH, gs, gr);
  ok('shift: a missing sample is filled', isFinite(sh2.grid[5]) && Array.from(sh2.grid).every(isFinite));
  ok('shift: no ground.bin -> mean (all holes -> 0)', M.makeShift(sp, tH, gs, null).at(0, 0) === 0);
}

// ── the shapes mesh ──
{
  const s = M.parseShapes(F.shapes, veg.shapes.count);
  const c = k => M.profileCounts(M.PROFILES[k]);
  ok('profiles: dome / cone 48 triangles, brush 30', c(0).tris === 48 && c(1).tris === 48 && c(2).tris === 30, [c(0), c(1), c(2)]);
  const m = M.buildShapes(s.rec, s.n, { shift: () => 0, h0: 0, curvature: false });
  const want = veg.shapes.domes * c(0).tris + veg.shapes.cones * c(1).tris + veg.shapes.brush * c(2).tris;
  ok('shapes mesh: triangles = sum per kind', m.triangles === want && m.idx.length === want * 3, [m.triangles, want]);
  ok('shapes mesh: counts per kind', m.counts.dome === veg.shapes.domes && m.counts.cone === veg.shapes.cones && m.counts.brush === veg.shapes.brush);
  ok('shapes mesh: every index in range', m.idx.every(i => i < m.vertices));
  ok('shapes mesh: all finite', m.pos.every(isFinite) && m.aux.every(isFinite));
  // first shape: top vertex at zg + height, lowest crown vertex at zg + base; aux.y = the shape height
  const r = s.rec, H = r[3], zg = r[2], base = Math.min(r[5], H * 0.8);
  let zmin = Infinity; const nv = c(r[6]).verts; for (let v = 0; v < nv; v++) zmin = Math.min(zmin, m.pos[v * 3 + 2]);
  ok('shapes mesh: top at ground + height', near(m.pos[2], zg + H, 1e-3), [m.pos[2], zg + H]);
  ok('shapes mesh: crown starts at its base', near(zmin, zg + base, 1e-3), [zmin, zg + base]);
  ok('shapes mesh: aux = hag, shape height', near(m.aux[0], H, 1e-4) && near(m.aux[1], H, 1e-4) && near(m.aux[(nv - 1) * 2], base, 1e-3));
  // winding: outward normals (from the int8 normals and the faces) point away from the shape's axis
  let outward = 0, tot = 0;
  for (let t = 0; t < c(r[6]).tris; t++) {
    const [a, b, d] = [m.idx[t * 3], m.idx[t * 3 + 1], m.idx[t * 3 + 2]].map(i => [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const ctr = [(a[0] + b[0] + d[0]) / 3 - r[0], (a[1] + b[1] + d[1]) / 3 - r[1], (a[2] + b[2] + d[2]) / 3 - (zg + (base + H) / 2)];
    tot++; if (n[0] * ctr[0] + n[1] * ctr[1] + n[2] * ctr[2] > 0) outward++;
  }
  ok('shapes mesh: faces wound CCW from outside', outward === tot, [outward, tot]);
  const nTop = [m.nrm[0], m.nrm[1], m.nrm[2]];
  ok('shapes mesh: the top normal points up', nTop[2] > 100, nTop);
  // meta: kind, density, shape flag
  const lastV = m.vertices - 1;
  ok('shapes mesh: meta kind / shape flag', m.meta[0] === r[6] * 127 && m.meta[lastV * 4] === 254 && m.meta[3] === 0 && m.meta[lastV * 4 + 3] === 0);
  // variation: two identical trees at different places are not the same shape
  const two = new Float32Array([0, 0, 1000, 15, 4, 5, 0, 1, 37, 21, 1000, 15, 4, 5, 0, 1]);
  const m2 = M.buildShapes(two, 2, { curvature: false });
  const nv0 = c(0).verts;
  let diff = 0; for (let v = 1; v < nv0; v++) diff += Math.abs((m2.pos[v * 3] - 0) - (m2.pos[(nv0 + v) * 3] - 37));
  ok('shapes mesh: per-tree variation from the position', diff > 1, diff);
  const m3 = M.buildShapes(two, 2, { curvature: false });
  ok('shapes mesh: and repeatable', m3.pos.every((x, i) => x === m2.pos[i]));
  // the shift and the frame: local z = z + shift - h0 - drop
  const ms = M.buildShapes(two, 2, { shift: (x, y) => -1000 + x, h0: 5 });
  const drop = (37 * 37 + 21 * 21) / (2 * M.EARTH_R);
  ok('shapes mesh: shift at the centre, h0 and the plane drop', near(ms.pos[nv0 * 3 + 2] - m2.pos[nv0 * 3 + 2], -1000 + 37 - 5 - drop, 1e-3));
  ok('shapes mesh: bad kind -> dome, base > height kept inside', (() => { const b = M.buildShapes(new Float32Array([0, 0, 0, 10, 3, 50, 9, 1]), 1, { curvature: false }); return b.counts.dome === 1 && b.pos.every(isFinite); })());
  ok('shapes mesh: box', m.min[2] < m.max[2] && m.min[0] >= -160 && m.max[0] <= 160);
  // 60 000 shapes (a km² of dense forest) builds in reasonable time
  const many = new Float32Array(60000 * 8);
  for (let i = 0; i < 60000; i++) many.set([(i % 245) * 4, Math.floor(i / 245) * 4, 1000, 8 + (i % 13), 2.5, 3, i % 3, 0.7], i * 8);
  const t0 = Date.now(), mm = M.buildShapes(many, 60000, {});
  const ms60 = Date.now() - t0;
  ok('shapes mesh: 60k shapes under 3 s', ms60 < 3000, ms60);
  console.log('  60k shapes: ' + mm.triangles + ' triangles, ' + mm.vertices + ' vertices, built in ' + ms60 + ' ms, ~' + Math.round((mm.vertices * 28 + mm.triangles * 12) / 1048576) + ' MB on the GPU');
}

// ── the shell mesh ──
{
  const sh = M.parseShell(F.shell, veg.shell.vertices, veg.shell.triangles);
  const m = M.buildShell(sh, { shift: () => -1000, h0: 0, curvature: false });
  ok('shell mesh: same counts', m.vertices === sh.V && m.triangles === sh.T);
  ok('shell mesh: z shifted, hag kept, shell flag', near(m.pos[2], sh.v[2] - 1000, 1e-3) && near(m.aux[0], sh.v[3]) && m.meta[3] === 255);
  ok('shell mesh: normals set', Math.hypot(m.nrm[0], m.nrm[1], m.nrm[2]) > 110);
}

// ── settings ──
{
  const d = M.clampSettings({});
  ok('settings: defaults', d.look === 'shapes' && near(d.opacity, 0.35) && d.tint === 'height' && d.onTerrain === true && d.trees && d.brush);
  const s = M.clampSettings({ look: 'shell', opacity: 3, edge: -1, fill: '0.4', minHeight: 1e6, trees: 0, tint: 'plain', colourLow: '#ABCDEF', colourHigh: 'green', bogus: 1 });
  ok('settings: clamped', s.look === 'shell' && s.opacity === 1 && s.edge === 0 && near(s.fill, 0.4) && s.minHeight === 200 && s.trees === false && s.tint === 'plain');
  ok('settings: colours only as #rrggbb', s.colourLow === '#abcdef' && s.colourHigh === M.DEFAULTS.colourHigh);
  ok('settings: unknown fields dropped', !('bogus' in s));
  const k = M.clampSettings({ look: 'nope', opacity: 'x', minHeight: NaN }, s);
  ok('settings: bad values keep the previous', k.look === 'shell' && k.opacity === 1 && k.minHeight === 200);
  ok('settings: all four looks', ['shapes', 'shell', 'both', 'off'].every(l => M.clampSettings({ look: l }).look === l));
  ok('hexRgb', M.hexRgb('#ff8000').map(x => Math.round(x * 255)).join() === '255,128,0');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
