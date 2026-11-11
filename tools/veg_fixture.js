// veg_fixture.js — a made-up vegetation-shapes result (the files veg_shapes.py writes, see the vegetation contract)
// for tests of the drawer (client/src/modules/veg-draw.js). Example origin 45.1234, -100.5678; nothing real.
//
//   const { makeVegFixture } = require('./veg_fixture');
//   const { veg, shapes, shell, ground } = makeVegFixture({ seed: 1 });   // shapes / shell / ground: ArrayBuffer
//   node tools/veg_fixture.js OUTDIR      writes veg.json, shapes.bin, shell.bin, ground.bin there
//
// The scene (300 m x 300 m, gentle hill, ground ~1000 m):
//   west   a stand of conifers (cones), tallest in the middle
//   east   broadleaf trees (domes), some crowns touching
//   middle an open meadow with brush mounds; a few brush mounds under the trees too (lower density)
//   shell  blobby closed meshes over the stands and a low one over the brush (hag per vertex)
'use strict';

function rng(seed) {                 // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function groundAt(x, y) { return 1000 + 0.04 * x + 9 * Math.sin(x / 55) * Math.cos(y / 70) + 4 * Math.sin((x + y) / 37); }

function makeVegFixture(opts) {
  opts = opts || {};
  const R = rng(opts.seed || 1);
  const half = opts.half || 150;
  const nTrees = opts.trees || 320, nBrush = opts.brush || 160;
  const shapes = [];
  // trees
  for (let i = 0; i < nTrees; i++) {
    const conifer = i < nTrees * 0.55;
    let x, y;
    for (;;) {
      x = conifer ? -half + 10 + R() * (half - 40) : 30 + R() * (half - 40);
      y = -half + 10 + R() * (2 * half - 20);
      const d = conifer ? Math.hypot(x + 85, y) : Math.hypot(x - 90, y - 20);
      if (d < 110 && R() > d / 140) break;
    }
    const d = conifer ? Math.hypot(x + 85, y) : Math.hypot(x - 90, y - 20);
    const h = (conifer ? 14 + 18 * (1 - d / 120) : 9 + 11 * (1 - d / 130)) * (0.8 + 0.4 * R());
    const r = conifer ? h * (0.16 + 0.06 * R()) : h * (0.28 + 0.12 * R());
    const base = conifer ? h * (0.15 + 0.2 * R()) : h * (0.3 + 0.2 * R());
    shapes.push([x, y, groundAt(x, y), h, r, base, conifer ? 1 : 0, 0.5 + 0.5 * R()]);
  }
  shapes.sort((a, b) => b[3] - a[3]);
  // brush: the meadow, and a few under the trees with a lower density
  const brush = [];
  for (let i = 0; i < nBrush; i++) {
    const under = i < nBrush * 0.25;
    const x = under ? -half + 10 + R() * (2 * half - 20) : -30 + R() * 70;
    const y = -half + 10 + R() * (2 * half - 20);
    brush.push([x, y, groundAt(x, y), 0.6 + 1.3 * R(), 1.2 + 2.5 * R(), 0, 2, under ? 0.2 + 0.2 * R() : 0.5 + 0.5 * R()]);
  }
  const all = shapes.concat(brush);
  const sb = new Float32Array(all.length * 8);
  all.forEach((s, i) => sb.set(s, i * 8));

  // ground.bin: nodes at x0 + i*cell, y0 + j*cell, row 0 = south
  const cell = 10, x0 = -half, y0 = -half, nx = Math.round(2 * half / cell) + 1, ny = nx;
  const gb = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) gb[j * nx + i] = groundAt(x0 + i * cell, y0 + j * cell);

  // shell: deformed icospheres (closed, CCW from outside)
  const ico = icosphere(2);
  const verts = [], tris = [];
  const blob = (cx, cy, z0, rx, ry, rz, wob) => {
    const off = verts.length / 4, ph = R() * 6.28, ph2 = R() * 6.28;
    for (let k = 0; k < ico.v.length; k += 3) {
      const ux = ico.v[k], uy = ico.v[k + 1], uz = ico.v[k + 2];
      const f = 1 + wob * (0.5 * Math.sin(3 * ux + 2 * uy + ph) + 0.5 * Math.sin(4 * uy - 3 * uz + ph2));
      const x = cx + ux * rx * f, y = cy + uy * ry * f;
      const g = groundAt(x, y);
      const z = Math.max(g + 0.3, z0 + uz * rz * f);
      verts.push(x, y, z, z - g);
    }
    for (const t of ico.t) tris.push(off + t);
  };
  blob(-85, 0, groundAt(-85, 0) + 18, 55, 80, 11, 0.18);
  blob(-60, 70, groundAt(-60, 70) + 13, 30, 25, 8, 0.2);
  blob(90, 20, groundAt(90, 20) + 10, 45, 60, 6, 0.22);
  blob(110, -80, groundAt(110, -80) + 8, 25, 30, 5, 0.25);
  blob(5, -10, groundAt(5, -10) + 1.0, 30, 70, 1.2, 0.3);
  const V = verts.length / 4, T = tris.length / 3;
  const shellBuf = new ArrayBuffer(V * 16 + T * 12);
  new Float32Array(shellBuf, 0, V * 4).set(verts);
  new Uint32Array(shellBuf, V * 16, T * 3).set(tris);

  const nT = shapes.length, nC = shapes.filter(s => s[6] === 1).length;
  const veg = {
    version: 1,
    origin: { lon: -100.5678, lat: 45.1234, h: groundAt(0, 0) },
    frame: 'enu',
    bbox: [-half, -half, half, half],
    area_m2: 4 * half * half,
    shapes: { file: 'shapes.bin', count: all.length, trees: nT, cones: nC, domes: nT - nC, brush: brush.length, record: 32 },
    shell: { file: 'shell.bin', vertices: V, triangles: T, voxel_m: 2 },
    ground: { file: 'ground.bin', nx, ny, cell, x0, y0 },
    stats: { points: 123456, veg_points: 65432, max_height: Math.max(...shapes.map(s => s[3])), mean_tree_height: shapes.reduce((a, s) => a + s[3], 0) / nT, seconds: 1.5 },
    params: { detail: 'medium', min_height: 0.5, brush_top: 2, looks: ['shapes', 'shell'] },
  };
  return { veg, shapes: sb.buffer, shell: shellBuf, ground: gb.buffer, groundAt };
}

function icosphere(sub) {
  const t = (1 + Math.sqrt(5)) / 2;
  let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const norm = p => { const l = Math.hypot(p[0], p[1], p[2]); return [p[0] / l, p[1] / l, p[2] / l]; };
  v = v.map(norm);
  for (let s = 0; s < sub; s++) {
    const mid = new Map(), nf = [];
    const m = (a, b) => { const k = a < b ? a + ',' + b : b + ',' + a; if (!mid.has(k)) { v.push(norm([(v[a][0] + v[b][0]) / 2, (v[a][1] + v[b][1]) / 2, (v[a][2] + v[b][2]) / 2])); mid.set(k, v.length - 1); } return mid.get(k); };
    for (const [a, b, c] of f) { const ab = m(a, b), bc = m(b, c), ca = m(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    f = nf;
  }
  return { v: v.flat(), t: f.flat() };
}

module.exports = { makeVegFixture, groundAt };

if (require.main === module) {
  const fs = require('fs'), path = require('path');
  const out = process.argv[2];
  if (!out) { console.error('usage: node tools/veg_fixture.js OUTDIR'); process.exit(2); }
  fs.mkdirSync(out, { recursive: true });
  const f = makeVegFixture({});
  fs.writeFileSync(path.join(out, 'veg.json'), JSON.stringify(f.veg, null, 1));
  fs.writeFileSync(path.join(out, 'shapes.bin'), Buffer.from(f.shapes));
  fs.writeFileSync(path.join(out, 'shell.bin'), Buffer.from(f.shell));
  fs.writeFileSync(path.join(out, 'ground.bin'), Buffer.from(f.ground));
  console.log('wrote', out, f.veg.shapes.count, 'shapes,', f.veg.shell.triangles, 'shell triangles');
}
