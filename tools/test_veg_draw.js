// veg-draw.js, the pure parts: parsing shapes.bin (version 1 and 2) / shell.bin / ground.bin, crown outlines, the batched
// crown mesh (counts by size, near and far levels, blocks, winding, heights, measured radii, variation), brush under
// crowns, the ranges drawn per frame, the shell mesh, the terrain-difference grid and its bilinear interpolation, settings clamp.
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
  const s = M.parseShapes(F.shapes, veg.shapes.count, veg.shapes.record);
  ok('fixture: version 2, record 48, profile', veg.version === 2 && veg.shapes.record === 48 && veg.shapes.profile.join() === '0.1,0.35,0.6,0.85');
  ok('shapes: count from veg.json, 12 floats a record', s.n === veg.shapes.count && s.stride === 12 && s.rec.length === s.n * 12);
  ok('shapes: record 0 is the tallest tree', s.rec[6] !== 2 && s.rec[3] >= s.rec[12 + 3]);
  ok('shapes: a short file gives what is there', M.parseShapes(F.shapes.slice(0, 48 * 5 + 7), 999, 48).n === 5);
  ok('shapes: typed array or Buffer accepted', M.parseShapes(Buffer.from(F.shapes), veg.shapes.count, 48).n === veg.shapes.count && M.parseShapes(new Uint8Array(F.shapes), null, 48).n === veg.shapes.count);
  ok('shapes: nothing is empty', M.parseShapes(null, 4).n === 0);
  const F1 = makeVegFixture({ seed: 3, version: 1 }), s1 = M.parseShapes(F1.shapes, F1.veg.shapes.count, F1.veg.shapes.record);
  ok('version 1: record 32, 8 floats, same scene', F1.veg.version === 1 && F1.veg.shapes.record === 32 && s1.stride === 8 && s1.n === s.n && s1.rec[0] === s.rec[0] && s1.rec[8] === s.rec[12]);
  ok('version 1: no record given reads 32', M.parseShapes(F1.shapes, null).stride === 8 && M.parseShapes(F1.shapes, null).n === s.n);
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

// ── outlines ──
{
  const r = [0.9, 1.0, 0.7, 0.3], R = M.outlineFn(r, false);
  ok('outline: through r1..r4 at 10/35/60/85 %', M.PROFILE_T.every((t, k) => near(R(t), r[k], 1e-9)), M.PROFILE_T.map(R));
  ok('outline: r0 = 0.6 r1 at the base, the full r1 when the crown reaches the ground', near(R(0), 0.54) && near(M.outlineFn(r, true)(0), 0.9));
  ok('outline: closes at the top, round (an arc from 85 %)', R(1) === 0 && near(R(0.925), 0.3 * Math.sqrt(0.75), 1e-9));
  let over = 0; for (let t = 0; t <= 0.85; t += 0.01) { const v = R(t); if (v > 1.0 + 1e-9 || v < 0) over++; }
  ok('outline: no overshoot past the widest (monotone cubic)', over === 0, over);
  const spike = M.outlineFn([1, 0.6, 0.2, 0.0], false);
  ok('outline: a spire keeps a small round cap (r4 >= CAP_MIN), not a needle', near(spike(0.85), M.CAP_MIN) && spike(0.95) > M.CAP_MIN * 0.6, [spike(0.85), spike(0.95)]);
  const rec = new Float32Array([0, 0, 0, 10, 3, 2, 1, 1, 0.5, 1.0, 0.8, 0.2]);
  ok('outlineOf: version 2 values', M.outlineOf(rec, 0, 12, 1).join() === [0.5, 1, 0.8, 0.2].map(Math.fround).join());
  ok('outlineOf: version 1 -> the kind\'s', M.outlineOf(rec, 0, 8, 1).join() === M.KIND_OUTLINE[1].join() && M.outlineOf(rec, 0, 8, 0).join() === M.KIND_OUTLINE[0].join());
  const bad = new Float32Array([0, 0, 0, 10, 3, 2, 0, 1, NaN, 1, 0.8, 0.2]), tiny = new Float32Array([0, 0, 0, 10, 3, 2, 2, 1, 0, 0.01, 0, 0]);
  ok('outlineOf: a bad or empty outline -> the kind\'s', M.outlineOf(bad, 0, 12, 0).join() === M.KIND_OUTLINE[0].join() && M.outlineOf(tiny, 0, 12, 2).join() === M.KIND_OUTLINE[2].join());
  const big = new Float32Array([0, 0, 0, 10, 3, 2, 0, 1, 0.5, 2.0, 1.0, 0.4]);
  ok('outlineOf: scaled so the widest is 1', near(M.outlineOf(big, 0, 12, 0)[1], 1) && near(M.outlineOf(big, 0, 12, 0)[0], 0.25));
}

// ── the shapes mesh ──
{
  const s = M.parseShapes(F.shapes, veg.shapes.count, 48);
  ok('counts: a sapling 20-30 triangles, a big tree 48-70, far 12, brush 21 / 12',
    M.shapeCounts(0, 1.2, 3, 0).tris === 20 && M.shapeCounts(0, 1.5, 6, 0).tris === 30 && M.shapeCounts(1, 7, 30, 0).tris === 70 && M.shapeCounts(0, 5, 15, 0).tris === 48 &&
    M.shapeCounts(1, 7, 30, 1).tris === 12 && M.shapeCounts(2, 2, 1.5, 0).tris === 21 && M.shapeCounts(2, 2, 1.5, 1).tris === 12);
  const m = M.buildShapes(s.rec, s.n, { shift: () => 0, h0: 0, curvature: false, stride: 12 });
  let wantN = 0, wantF = 0;
  for (let i = 0; i < s.n; i++) {
    const o = i * 12, k = Math.round(s.rec[o + 6]), H = s.rec[o + 3], base = k === 2 ? 0 : Math.min(s.rec[o + 5], H * 0.8);
    const Hb = k === 2 ? Math.min(H, Math.max(M.brushCaps(s.rec, s.n, 12)[i], H * 0.65)) : H;
    wantN += M.shapeCounts(k, s.rec[o + 4], Hb - base, 0).tris; wantF += M.shapeCounts(k, s.rec[o + 4], Hb - base, 1).tris;
  }
  ok('shapes mesh: triangles = near + far per shape', m.trianglesNear === wantN && m.trianglesFar === wantF && m.triangles === wantN + wantF && m.idx.length === m.triangles * 3, [m.trianglesNear, wantN, m.trianglesFar, wantF]);
  ok('shapes mesh: counts per kind', m.counts.dome === veg.shapes.domes && m.counts.cone === veg.shapes.cones && m.counts.brush === veg.shapes.brush);
  {
    // tall brush (kind 3: a crown that is brush by its shape) is a label only: drawn as a tree (a dome from its crown base, tree colour), like any unknown kind
    const tb = new Float32Array([0, 0, 0, 4.5, 3, 1.5, 3, 0.8, 1, 0.9, 0.7, 0.4, 20, 0, 0, 4.5, 3, 1.5, 0, 0.8, 1, 0.9, 0.7, 0.4, 40, 0, 0, 1.5, 3, 0, 2, 0.8, 1, 0.9, 0.7, 0.4]);
    const mt = M.buildShapes(tb, 3, { shift: () => 0, h0: 0, curvature: false, stride: 12 });
    const zOf = (a, b) => { let lo = Infinity, hi = -Infinity; for (let v = 0; v < mt.vertices; v++) { const x = mt.pos[v * 3]; if (x > a && x < b) { lo = Math.min(lo, mt.pos[v * 3 + 2]); hi = Math.max(hi, mt.pos[v * 3 + 2]); } } return [lo, hi]; };
    const z3 = zOf(-10, 10), z0 = zOf(10, 30);
    let metaOk = true; for (let v = 0; v < mt.vertices; v++) { const x = mt.pos[v * 3]; if (mt.meta[v * 4] !== (x > 30 ? 2 * 127 : 0)) metaOk = false; }
    ok('shapes mesh: tall brush (kind 3) is drawn as a tree: a dome from its crown base to its height, the same as kind 0', mt.counts.dome === 2 && mt.counts.brush === 1 && mt.counts.cone === 0 && near(z3[0], z0[0], 0.05) && near(z3[1], z0[1], 0.2) && z3[0] > 1.2 && z3[1] > 4.0 && metaOk, [mt.counts, z3, z0]);
  }
  ok('shapes mesh: every index in range', m.idx.every(i => i < m.vertices));
  ok('shapes mesh: all finite', m.pos.every(isFinite));
  // blocks: [lod][class][tile] laid out end to end over the whole index buffer
  const B = m.blocks;
  let at = 0, contiguous = true;
  for (let l = 0; l < 2; l++) for (let c = 0; c < B.start[l].length; c++) for (let t = 0; t < B.tiles.length; t++) { if (B.start[l][c][t] !== at) contiguous = false; at += B.count[l][c][t]; }
  ok('blocks: end to end, the whole buffer', contiguous && at === m.idx.length, [at, m.idx.length]);
  // a block holds only its own lod (meta.w) and class (ctr.w = the class's switch distance)
  let wrong = 0;
  for (let l = 0; l < 2; l++) for (let c = 0; c < B.start[l].length; c++) for (let t = 0; t < B.tiles.length; t++)
    for (let q = B.start[l][c][t]; q < B.start[l][c][t] + B.count[l][c][t]; q++) { const v = m.idx[q]; if (m.meta[v * 4 + 3] !== (l ? 128 : 0) + c) wrong++; }
  ok('blocks: each holds its own level and size class', wrong === 0, wrong);
  // first shape: near mesh = top pole, rings, bottom pole; top at ground + height, bottom pole at the crown's base
  const r = s.rec, H = r[3], zg = r[2], base = Math.min(r[5], H * 0.8), nv = M.shapeCounts(r[6], r[4], H - base, 0).verts;
  let zmin = Infinity; for (let v = 0; v < nv; v++) zmin = Math.min(zmin, m.pos[v * 3 + 2]);
  ok('shapes mesh: top at ground + height', near(m.pos[2], zg + H, 1e-3), [m.pos[2], zg + H]);
  ok('shapes mesh: crown starts at its base', near(zmin, zg + base, 1e-3), [zmin, zg + base]);
  ok('shapes mesh: aux = hag, shape height (cm)', near(m.aux[0] / 100, H, 0.006) && near(m.aux[1] / 100, H, 0.006) && near(m.aux[(nv - 1) * 2] / 100, base, 0.006));
  // the measured outline shows: ring radii follow r1..r4 (x radius; within the small per-tree variation)
  {
    const big = new Float32Array([0, 0, 0, 30, 6.5, 5, 1, 1, 1.0, 0.8, 0.5, 0.2]);
    const mb = M.buildShapes(big, 1, { curvature: false, stride: 12 });
    const seg = M.SEG[3], ts = M.ringsFor(25, 3), rad = [];
    for (let q = 0; q < ts.length; q++) { let a = 0; for (let k = 0; k < seg; k++) { const v = 1 + q * seg + k; a += Math.hypot(mb.pos[v * 3] - 0, mb.pos[v * 3 + 1] - 0); } rad.push(a / seg / 6.5); }
    const want = [1.0, 0.8, 0.5, 0.2], kp = (1 + 1 / Math.cos(Math.PI / seg)) / 2;
    ok('shapes mesh: a big crown has the five rings, radii = the measured outline', ts.length === 5 && want.every((w, k) => Math.abs(rad[k] / kp - w) < 0.1), rad.map(x => (x / kp).toFixed(2)));
    ok('shapes mesh: the cap ring is round, not a point', rad[4] / kp > M.CAP_MIN * 0.6, rad[4]);
  }
  // winding: outward normals point away from the shape's axis, near and far
  const windOut = (mm, t0, t1, cx, cy, cz) => {
    let outward = 0;
    for (let t = t0; t < t1; t++) {
      const [a, b, d] = [mm.idx[t * 3], mm.idx[t * 3 + 1], mm.idx[t * 3 + 2]].map(i => [mm.pos[i * 3], mm.pos[i * 3 + 1], mm.pos[i * 3 + 2]]);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const ctr = [(a[0] + b[0] + d[0]) / 3 - cx, (a[1] + b[1] + d[1]) / 3 - cy, (a[2] + b[2] + d[2]) / 3 - cz];
      if (n[0] * ctr[0] + n[1] * ctr[1] + n[2] * ctr[2] > 0) outward++;
    }
    return outward;
  };
  for (const [nm, rec1] of [['tree', [0, 0, 100, 20, 4, 3, 0, 1, 0.7, 1, 0.9, 0.5]], ['spire', [0, 0, 100, 25, 2.5, 2, 1, 1, 1, 0.78, 0.48, 0.18]], ['umbrella', [0, 0, 100, 15, 5, 7, 0, 1, 0.3, 0.6, 1, 0.7]], ['brush', [0, 0, 100, 1.5, 2, 0, 2, 1, 1, 0.9, 0.7, 0.4]]]) {
    const one = M.buildShapes(new Float32Array(rec1), 1, { curvature: false, stride: 12 }), B1 = one.blocks;
    const range = l => { let a = Infinity, z = 0; for (let c = 0; c < 4; c++) for (let t = 0; t < B1.tiles.length; t++) if (B1.count[l][c][t]) { a = Math.min(a, B1.start[l][c][t] / 3); z = Math.max(z, (B1.start[l][c][t] + B1.count[l][c][t]) / 3); } return [a, z]; };
    const [n0, n1] = range(0), [f0, f1] = range(1), cz = 100 + (rec1[6] === 2 ? 0.4 : (rec1[5] + rec1[3]) / 2);
    ok('winding: ' + nm + ' near and far wound CCW from outside', windOut(one, n0, n1, 0, 0, cz) === n1 - n0 && windOut(one, f0, f1, 0, 0, cz) === f1 - f0, [windOut(one, n0, n1, 0, 0, cz), n1 - n0, windOut(one, f0, f1, 0, 0, cz), f1 - f0]);
  }
  const nTop = [m.nrm[0], m.nrm[1], m.nrm[2]];
  ok('shapes mesh: the top normal points up', nTop[2] > 100, nTop);
  // meta: kind, density; near 0 / far 128
  const lastV = m.vertices - 1;
  const c0 = M.sizeClass(r[4]);
  ok('shapes mesh: meta kind / level + class', m.meta[0] === r[6] * 127 && m.meta[3] === c0 && m.meta[lastV * 4] === 254 && m.meta[lastV * 4 + 3] >= 128 && m.meta[nv * 4 + 3] === 128 + c0);
  ok('shapes mesh: ctr = from the vertex to the shape\'s middle (cm)', near(m.pos[0] + m.ctr[0] / 100, r[0], 0.006) && near(m.pos[2] + m.ctr[2] / 100, zg + (base + H) / 2, 0.006) && near(m.pos[3 * 3 + 2] + m.ctr[3 * 4 + 2] / 100, zg + (base + H) / 2, 0.006));
  // version 1 still draws, the outline from kind
  const F1 = makeVegFixture({ seed: 3, version: 1 }), s1 = M.parseShapes(F1.shapes, F1.veg.shapes.count, 32);
  const m1 = M.buildShapes(s1.rec, s1.n, { curvature: false, stride: 8 });
  ok('version 1: builds, same shapes, all finite, in range', m1.counts.cone === m.counts.cone && m1.pos.every(isFinite) && m1.idx.every(i => i < m1.vertices));
  // variation: two identical trees at different places are not the same shape
  const two = new Float32Array([0, 0, 1000, 15, 4, 5, 0, 1, 0.7, 1, 0.9, 0.5, 37, 21, 1000, 15, 4, 5, 0, 1, 0.7, 1, 0.9, 0.5]);
  const m2 = M.buildShapes(two, 2, { curvature: false, stride: 12 });
  const nv0 = M.shapeCounts(0, 4, 10, 0).verts, s1v = nv0 + 8;
  let diff = 0; for (let v = 1; v < nv0; v++) diff += Math.abs((m2.pos[v * 3] - 0) - (m2.pos[(s1v + v) * 3] - 37));
  ok('shapes mesh: per-tree variation from the position', diff > 1, diff);
  // … but small: no ring is more than ~25 % off its measured radius
  let worst = 0; const seg = M.SEG[M.sizeClass(4)], ts = M.ringsFor(10, M.sizeClass(4)), R2 = M.outlineFn([0.7, 1, 0.9, 0.5], false), kp = (1 + 1 / Math.cos(Math.PI / seg)) / 2;
  for (let q = 0; q < ts.length; q++) for (let k = 0; k < seg; k++) { const v = s1v + 1 + q * seg + k, d = Math.hypot(m2.pos[v * 3] - 37, m2.pos[v * 3 + 1] - 21) / (4 * kp * R2(ts[q])); worst = Math.max(worst, Math.abs(d - 1)); }
  ok('shapes mesh: variation never hides the outline (<= 25 % off)', worst < 0.25, worst);
  const m3 = M.buildShapes(two, 2, { curvature: false, stride: 12 });
  ok('shapes mesh: and repeatable', m3.pos.every((x, i) => x === m2.pos[i]));
  // the shift and the frame: local z = z + shift - h0 - drop
  const ms = M.buildShapes(two, 2, { shift: (x, y) => -1000 + x, h0: 5, stride: 12 });
  const drop = (37 * 37 + 21 * 21) / (2 * M.EARTH_R);
  ok('shapes mesh: shift at the centre, h0 and the plane drop', near(ms.pos[s1v * 3 + 2] - m2.pos[s1v * 3 + 2], -1000 + 37 - 5 - drop, 1e-3));
  ok('shapes mesh: bad kind -> dome, base > height kept inside', (() => { const b = M.buildShapes(new Float32Array([0, 0, 0, 10, 3, 50, 9, 1]), 1, { curvature: false }); return b.counts.dome === 1 && b.pos.every(isFinite); })());
  {
    const sl = M.buildShapes(new Float32Array([0, 0, 0, 10, 3, 9.5, 1, 1]), 1, { curvature: false });
    let zmin2 = Infinity; for (let q = 0; q < sl.vertices; q++) zmin2 = Math.min(zmin2, sl.pos[q * 3 + 2]);
    ok('shapes mesh: a crown base above 80 % of the height is held at 80 % (never a sliver)', near(zmin2, 8, 1e-4), zmin2);
  }
  ok('shapes mesh: box', m.min[2] < m.max[2] && m.min[0] >= -160 && m.max[0] <= 160);
  // brush under a crown that starts higher is held below it
  {
    const recs = new Float32Array([0, 0, 0, 20, 5, 3, 0, 1, 0.7, 1, 0.9, 0.5, 1, 1, 0, 1.9, 2, 0, 2, 1, 1, 0.9, 0.7, 0.4, 30, 30, 0, 1.9, 2, 0, 2, 1, 1, 0.9, 0.7, 0.4]);
    const caps = M.brushCaps(recs, 3, 12);
    ok('brush: held under a crown above it, free in the open', near(caps[1], 3 * 0.95, 1e-6) && caps[2] === Infinity && caps[0] === Infinity, Array.from(caps));
  }
  // a brush clump on a slope: its foot ring follows the ground (no gap on the downhill side)
  {
    const slope = (x, y) => 100 + 0.6 * x;
    const one = new Float32Array([0, 0, 100, 1.8, 2, 0, 2, 1, 1, 0.9, 0.7, 0.4]);
    const flat = M.buildShapes(one, 1, { curvature: false, stride: 12 }), sl = M.buildShapes(one, 1, { curvature: false, stride: 12, groundAt: slope });
    let worst = 0, up = 0;
    for (let k = 0; k < 7; k++) {
      const v = 1 + k, gz = slope(sl.pos[v * 3], sl.pos[v * 3 + 1]) - 100;
      if (gz < 0) worst = Math.max(worst, Math.abs(sl.pos[v * 3 + 2] - (gz - 0.1 + flat.pos[v * 3 + 2])));
      else up = Math.max(up, Math.abs(sl.pos[v * 3 + 2] - (flat.pos[v * 3 + 2] - 0.1)));
    }
    ok('brush on a slope: the foot ring reaches down to the ground, never up (no inverted faces uphill)', worst < 1e-3 && up < 1e-3, [worst, up]);
  }
  // 60 000 shapes (a km² of dense forest) builds in reasonable time, and is lighter than round 1's 48 per tree
  const many = new Float32Array(60000 * 12);
  for (let i = 0; i < 60000; i++) many.set([(i % 245) * 4, Math.floor(i / 245) * 4, 1000, 8 + (i % 13), 1.5 + (i % 7) * 0.5, 2 + (i % 3), i % 3, 0.7, 0.8, 1, 0.8, 0.4], i * 12);
  const t0 = Date.now(), mm = M.buildShapes(many, 60000, { stride: 12 });
  const ms60 = Date.now() - t0;
  ok('shapes mesh: 60k shapes under 3 s', ms60 < 3000, ms60);
  ok('shapes mesh: near triangles average under 40 a shape', mm.trianglesNear / 60000 < 40, mm.trianglesNear / 60000);
  console.log('  60k shapes: ' + mm.trianglesNear + ' near + ' + mm.trianglesFar + ' far triangles, ' + mm.vertices + ' vertices, built in ' + ms60 + ' ms, ~' + Math.round((mm.vertices * M.VERTEX_BYTES + mm.triangles * 12) / 1048576) + ' MB on the GPU');
  // ranges per frame: camera over one corner, low: near blocks only around it, far blocks for the rest
  const Bm = mm.blocks, z = 1010;
  const all = M.pickRanges(Bm, [490, 490, 5000], null, 4);
  const sum = l => l.reduce((a, x) => a + x[1], 0);
  ok('ranges: from far above, every far block and no near one', all.near.length === 0 && sum(all.far) === mm.trianglesFar * 3, [all.near.length, sum(all.far), mm.trianglesFar * 3]);
  const inside = M.pickRanges(Bm, [0, 0, z], null, 1);
  ok('ranges: low in a corner, some near and some far, a handful of ranges', inside.near.length > 0 && inside.far.length > 0 && inside.near.length + inside.far.length <= 40 && sum(inside.near) < mm.trianglesNear * 3, [inside.near.length, inside.far.length]);
  ok('ranges: inside the index buffer', inside.near.concat(inside.far).every(([a, c]) => a >= 0 && c > 0 && a + c <= mm.idx.length));
  // the ranges hold every shape that should be drawn near (the shader decides per shape, the CPU must not miss one)
  let missing = 0;
  const inRange = (q, list) => list.some(([a, c]) => q >= a && q < a + c);
  for (let c = 0; c < 4; c++) for (let t = 0; t < Bm.tiles.length; t++) {
    const n = Bm.count[0][c][t]; if (!n) continue;
    for (let q = Bm.start[0][c][t]; q < Bm.start[0][c][t] + n; q += 3) {
      const v = mm.idx[q], d = Math.hypot(mm.pos[v * 3] + mm.ctr[v * 4] / 100, mm.pos[v * 3 + 1] + mm.ctr[v * 4 + 1] / 100, mm.pos[v * 3 + 2] + mm.ctr[v * 4 + 2] / 100 - z);
      if (d < M.SWITCH_M[c] * 1.2 && !inRange(q, inside.near)) missing++;
    }
  }
  ok('ranges: no near shape inside its distance is left out', missing === 0, missing);
  ok('ranges: tiles out of view are not drawn', M.pickRanges(Bm, [0, 0, z], () => false, 1).near.length === 0);
}

// ── the shell mesh ──
{
  const sh = M.parseShell(F.shell, veg.shell.vertices, veg.shell.triangles);
  const m = M.buildShell(sh, { shift: () => -1000, h0: 0, curvature: false });
  ok('shell mesh: same counts', m.vertices === sh.V && m.triangles === sh.T);
  ok('shell mesh: z shifted, hag kept (cm), shell flag', near(m.pos[2], sh.v[2] - 1000, 1e-3) && near(m.aux[0] / 100, sh.v[3], 0.006) && m.meta[3] === 255);
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
  ok('settings: lod 1 by default, 0.25..4', d.lod === 1 && M.clampSettings({ lod: 9 }).lod === 4 && M.clampSettings({ lod: 0 }).lod === 0.25);
  const k = M.clampSettings({ look: 'nope', opacity: 'x', minHeight: NaN }, s);
  ok('settings: bad values keep the previous', k.look === 'shell' && k.opacity === 1 && k.minHeight === 200);
  ok('settings: all four looks', ['shapes', 'shell', 'both', 'off'].every(l => M.clampSettings({ look: l }).look === l));
  ok('hexRgb', M.hexRgb('#ff8000').map(x => Math.round(x * 255)).join() === '255,128,0');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
