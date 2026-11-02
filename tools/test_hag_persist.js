// Tests of client/src/modules/hag-persist.js: the saved-grid key and when it stops
// matching, the sparse snapshot round trip, the packed bytes after a restore, the LRU
// of margins that scrolled out (pan away and back gives the same grid as binning from
// scratch, with fewer nodes to bin again), and the size-cap eviction. Made-up data.
//
//   node tools/test_hag_persist.js
'use strict';
const path = require('path');
const M = f => require(path.join(__dirname, '..', 'client', 'src', 'modules', f));
const P = M('hag-persist.js'), H = M('pointcloud-hag.js');

let pass = 0, fail = 0;
const ok = (label, cond, info) => { if (cond) pass++; else { fail++; console.error('FAIL ' + label + (info !== undefined ? '\n  ' + JSON.stringify(info).slice(0, 600) : '')); } };
const NONE = H.HAG_NONE;

// ── keys ─────────────────────────────────────────────────────────────────────
{
  const m = Array.from({ length: 16 }, (_, i) => i % 5 === 0 ? 1 : 0);
  const c = { id: 'https://data.example.com/area/ept.json', bbox: [0, 0, 0, 1000, 1000, 100], tight: [1, 1, 1, 999, 999, 99], spacing: 2.5, matrix: m };
  const a = P.hash64(P.cloudFingerprint(c));
  ok('fingerprint: same cloud, same hash', a === P.hash64(P.cloudFingerprint({ ...c })) && /^[0-9a-f]{16}$/.test(a));
  ok('fingerprint: tiny float noise below 1 mm is the same', a === P.hash64(P.cloudFingerprint({ ...c, matrix: m.map(v => v + 1e-5) })));
  const moved = m.slice(); moved[12] = 3.5;
  ok('fingerprint: a moved world matrix is a different cloud', a !== P.hash64(P.cloudFingerprint({ ...c, matrix: moved })));
  ok('fingerprint: other bounds / spacing / source differ',
    a !== P.hash64(P.cloudFingerprint({ ...c, bbox: [0, 0, 0, 1001, 1000, 100] })) &&
    a !== P.hash64(P.cloudFingerprint({ ...c, spacing: 2.4 })) && a !== P.hash64(P.cloudFingerprint({ ...c, id: 'https://data.example.com/other/ept.json' })));
  const b = P.hash64('another');
  ok('dataset: order does not matter, a different set differs', P.datasetKey([a, b]) === P.datasetKey([b, a]) && P.datasetKey([a, b]) !== P.datasetKey([a]));

  const base = { ds: P.datasetKey([a]), cell: 0.5, env: 2, dimD: 2048, dimF: 1024 };
  const pre = P.gridPrefix(base);
  ok('prefix holds format, dataset, sizes, cell, radius', pre.startsWith('h' + P.HAG_FORMAT + '|') && pre.includes(base.ds) && pre.includes('d2048f1024') && pre.includes('c0.5') && pre.includes('e2'));
  ok('prefix: other cell / radius / dataset / grid size do not match',
    new Set([pre, P.gridPrefix({ ...base, cell: 1 }), P.gridPrefix({ ...base, env: 1 }), P.gridPrefix({ ...base, ds: P.datasetKey([b]) }), P.gridPrefix({ ...base, dimD: 1024 })]).size === 5);
  ok('prefix never holds the address', !pre.includes('example') && !pre.includes('ept'));

  const id1 = P.recordId(pre, 1000, 2000), id2 = P.recordId(pre, 5000.5, 2000), id3 = P.recordId(P.gridPrefix({ ...base, cell: 1 }), 1000, 2000);
  ok('recordId round trips the origin', JSON.stringify(P.parseRecordId(id2)) === '{"ox":5000.5,"oy":2000}');
  const cov = 1024;
  ok('pick: the window that holds the view, furthest from its edges', P.pickSnapshot([id1, id2, id3], pre, 1500, 2500, cov) === id1);
  ok('pick: none holds the view', P.pickSnapshot([id1, id2], pre, 3500, 2500, cov) === null);
  ok('pick: the other cell size is never offered', P.pickSnapshot([id3], pre, 1500, 2500, cov) === null);
  ok('superseded: a snapshot a quarter window away is replaced, a far one is kept',
    JSON.stringify(P.supersededIds([id1, id2], pre, 1100, 2100, cov)) === JSON.stringify([id1]));
}

// ── eviction ─────────────────────────────────────────────────────────────────
{
  const es = [{ id: 'a', used: 5, bytes: 40 }, { id: 'b', used: 1, bytes: 40 }, { id: 'c', used: 3, bytes: 40 }, { id: 'd', used: 9, bytes: 40 }];
  ok('eviction: under the cap drops nothing', P.planEviction(es, 200).length === 0);
  const v = P.planEviction(es, 100);        // 160 bytes, cap 100, goal 90 -> drop oldest until <= 90
  ok('eviction: oldest use first, down to 90% of the cap', JSON.stringify(v) === JSON.stringify(['b', 'c']), v);
  ok('eviction: also takes {key} rows', P.planEviction([{ key: 'x', used: 1, bytes: 10 }, { key: 'y', used: 2, bytes: 10 }], 15, 0.5)[0] === 'x');
}

// ── snapshot round trip ──────────────────────────────────────────────────────
const mk = (dim, label) => { const g = H.hagMakeGrid(dim, label); g.texture = { version: 1 }; return g; };
{
  const g = mk(64, 'detail'); H.hagAnchor(g, 0.5, 1000, 2000);
  let s = 7; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 64 * 64; i++) {
    const r = rnd();
    if (r < 0.3) { g.ground[i] = 100 + rnd() * 50; g.groundMax[i] = g.ground[i] + rnd() * 20; }
    else if (r < 0.5) g.fallback[i] = 90 + rnd() * 80;
  }
  const enc = P.encodeGrid(g);
  ok('encode is sparse (only cells that hold something)', enc.n > 0 && enc.n < 64 * 64 && enc.idx.length === enc.n);
  const h = mk(64, 'detail'); H.hagAnchor(h, 0.5, 5, 5);
  ok('decode into a grid of the same size', P.decodeGridInto(h, structuredClone(enc)) === true);
  ok('accumulators come back exactly', h.originX === g.originX && h.originY === g.originY &&
    h.ground.every((v, i) => v === g.ground[i]) && h.groundMax.every((v, i) => v === g.groundMax[i]) && h.fallback.every((v, i) => v === g.fallback[i]));
  ok('decode refuses another size / cell', !P.decodeGridInto(mk(32, 'x'), enc) && (() => { const q = mk(64, 'detail'); q.cell = 1; return !P.decodeGridInto(q, enc); })());
  const win = H.hagWindow(80, 180);
  H.hagRepackGrid(g, win.zMin, win.zSpan); H.hagRepackGrid(h, win.zMin, win.zSpan);
  ok('the packed texture bytes after a restore equal the original', Buffer.compare(Buffer.from(g.upload), Buffer.from(h.upload)) === 0 && g.filled === h.filled && g.groundCells === h.groundCells);
  // The impossible-value rule: a cell with data never packs a zero height; a cell without is alpha 0.
  let bad = 0;
  for (let i = 0; i < 64 * 64; i++) {
    const t = i * 4, a = h.upload[t + 3];
    if (a === 0 && (h.upload[t] || h.upload[t + 1] || h.upload[t + 2])) bad++;
    if (a !== 0 && h.upload[t] === 0 && h.upload[t + 1] === 0) bad++;
  }
  ok('restored texture: empty cells are all zero with alpha 0, filled cells never a zero height', bad === 0, bad);

  const pr = [['n1', 0, 0, 10, 10], ['n2', 500, 500, 700, 700], ['n3', -5, 0, 10, 10]];
  const keep = P.filterProcessed(pr, [{ minX: 0, minY: 0, maxX: 600, maxY: 600 }, { minX: -100, minY: -100, maxX: 800, maxY: 800 }]);
  ok('saved nodes: only those wholly inside every saved window are trusted', keep.length === 1 && keep[0][0] === 'n1', keep);
}

// ── margins: pan away and back ───────────────────────────────────────────────
// A tiny scan: nodes are squares of points; binning is R = 0 (each point only its own
// cell), which is what makes "same as binning from scratch" an exact statement.
{
  const DIM = 512, CELL = 1, T = P.TILE;
  let s = 99; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const nodes = [];
  nodes.push({ key: 'root', minX: 0, minY: 0, maxX: 2048, maxY: 1024, pts: [] });
  for (let x = 0; x < 2048; x += 256) for (let y = 0; y < 1024; y += 256) nodes.push({ key: `n${x}_${y}`, minX: x, minY: y, maxX: x + 256, maxY: y + 256, pts: [] });
  // Every point lives in exactly one node: sparse ones in the root, dense ones in the tiles.
  for (const n of nodes) {
    const count = n.key === 'root' ? 4000 : 6000;
    for (let i = 0; i < count; i++) n.pts.push([n.minX + rnd() * (n.maxX - n.minX), n.minY + rnd() * (n.maxY - n.minY), 100 + rnd() * 60, rnd() < 0.6 ? 2 : 1]);
  }

  const bin = (D, n) => {                       // same min / max rules as the scan, R = 0
    let c = 0;
    for (const [x, y, z, cls] of n.pts) {
      const cx = ((x - D.originX) / D.cell) | 0, cy = ((y - D.originY) / D.cell) | 0;
      if (cx < 0 || cx >= D.dim || cy < 0 || cy >= D.dim || x < D.originX || y < D.originY) continue;
      const k = cy * D.dim + cx; c++;
      if (cls === 2) { if (z < D.ground[k]) D.ground[k] = z; if (z > D.groundMax[k]) D.groundMax[k] = z; }
      else if (z < D.fallback[k]) D.fallback[k] = z;
    }
    return c;
  };
  const fresh = (ox, oy) => { const g = mk(DIM, 'detail'); H.hagAnchor(g, CELL, ox + DIM / 2, oy + DIM / 2); for (const n of nodes) if (H.hagOverlaps(n, H.hagExtent(g))) bin(g, n); return g; };
  const same = (a, b) => a.originX === b.originX && a.originY === b.originY &&
    a.ground.every((v, i) => v === b.ground[i]) && a.groundMax.every((v, i) => v === b.groundMax[i]) && a.fallback.every((v, i) => v === b.fallback[i]);

  // One session: the scan's own steps, with or without the margin cache.
  const session = useCache => {
    const g = mk(DIM, 'detail'), cache = new P.MarginCache(), led = new P.BinLedger();
    const processed = new Map(); let binned = 0, requeued = 0;
    H.hagAnchor(g, CELL, 256, 256);
    const pass = () => { for (const n of nodes) { if (processed.has(n.key) || !H.hagOverlaps(n, H.hagExtent(g))) continue; bin(g, n); binned++; processed.set(n.key, { minX: n.minX, minY: n.minY, maxX: n.maxX, maxY: n.maxY, seq: led.next(n.key) }); } };
    const go = (cx, cy) => {
      const before = H.hagExtent(g); let sh = null;
      H.hagShift(g, cx, cy, useCache ? {
        before: (nx, ny) => P.marginCapture(cache, 'detail', g, Math.round(nx / CELL), Math.round(ny / CELL), led.captured()),
        after: (ox, oy) => { const oax = Math.round(ox / CELL), oay = Math.round(oy / CELL); sh = { oax, oay, r: P.marginRestore(cache, 'detail', g, oax, oay) }; },
      } : undefined);
      const rects = H.hagExposed(before, H.hagExtent(g));
      for (const [key, bb] of processed) {
        if (!rects.some(r => H.hagOverlaps(bb, r))) continue;
        if (sh && P.nodeCovered('detail', g, sh.oax, sh.oay, bb, sh.r.restored, bb.seq || 0)) continue;
        led.requeued(key, bb.seq); processed.delete(key); requeued++;
      }
      pass();
    };
    pass();
    return { g, go, stats: () => ({ binned, requeued }), cache };
  };
  const steps = [[256 + 300, 256], [256 + 600, 256], [256 + 300, 256], [256, 256], [256, 256 + 300], [256 + 400, 256 + 200], [256, 256]];
  const A = session(false), B = session(true);
  let exactA = true, exactB = true;
  for (const [cx, cy] of steps) {
    A.go(cx, cy); B.go(cx, cy);
    const want = fresh(B.g.originX, B.g.originY);
    exactA = exactA && same(A.g, want); exactB = exactB && same(B.g, want);
  }
  ok('panning with no cache keeps the grid exact (baseline)', exactA);
  ok('panning away and back with the margin cache gives exactly the grid binned from scratch', exactB);
  ok('the cache bins fewer nodes again than no cache', B.stats().binned < A.stats().binned && B.stats().requeued < A.stats().requeued, { A: A.stats(), B: B.stats() });
  ok('margin cache holds whole tiles only and respects its cap', (() => { const c = new P.MarginCache(1000); for (let i = 0; i < 20; i++) c.set('k' + i, { bytes: 300, seq: 1 }); return c.bytes <= 1000 && c.size === 3 && !c.has('k0') && c.has('k19'); })());
  ok('margin cache: a use refreshes it (LRU)', (() => { const c = new P.MarginCache(700); c.set('a', { bytes: 300 }); c.set('b', { bytes: 300 }); c.get('a'); c.set('c', { bytes: 300 }); return c.has('a') && !c.has('b') && c.has('c'); })());
  // A node binned after a copy was taken (so the copy lacks it) must be binned again.
  const g2 = mk(DIM, 'detail'); H.hagAnchor(g2, CELL, 256, 256);
  const cache2 = new P.MarginCache(), led2 = new P.BinLedger();
  const seqOld = led2.next('old');                        // binned before the copy
  P.marginCapture(cache2, 'detail', g2, 400, 0, led2.captured());
  const seqNew = led2.next('new');                        // binned after it
  H.hagShift(g2, 256 + 144, 256);                          // window now starts at x = 400 ... sits inside copied tiles
  g2.originX = 0; g2.originY = 0;                          // back to where the copy was taken for the check below
  const r2 = P.marginRestore(cache2, 'detail', g2, 400, 0);
  const bbox = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  ok('a node binned before the copy is covered, one binned after it is not',
    r2.restored.size > 0 && P.nodeCovered('detail', g2, 400, 0, bbox, r2.restored, seqOld) === true && P.nodeCovered('detail', g2, 400, 0, bbox, r2.restored, seqNew) === false, { n: r2.restored.size, seqOld, seqNew });
  // A node waiting to be binned again when a copy is taken is not in that copy.
  const led3 = new P.BinLedger(); const s1 = led3.next('p'); led3.requeued('p', s1); const cs = led3.captured(); const s2 = led3.next('p');
  ok('ledger: a node pending at a copy is newer than the copy; an ordinary re-bin keeps its seq', s2 > cs && (() => { const l = new P.BinLedger(); const a = l.next('q'); l.requeued('q', a); return l.next('q') === a; })(), { s1, cs, s2 });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
