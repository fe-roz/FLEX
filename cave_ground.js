// cave_ground.js — the ground above a cave, for colour by depth below ground.
//
// Each cave gets a grid of ground heights over its footprint (every station
// and shot, plus a margin), laid out in a level east/north frame centred on
// the cave. The grid is sampled once from the globe's terrain, and a drawn
// vertex's depth is then just a frame transform and a bilinear lookup — cheap
// enough for every wall vertex. Heights are above the ellipsoid, the same as
// everything Cesium draws, so cave and ground agree wherever the cave sits.

const C = () => window.Cesium;

// A level frame at a world point: east/north offsets of any world point, and
// its height above the ellipsoid from the tangent plane plus the Earth's
// curvature (good to centimetres 10 km out).
export function levelFrame(origin) {
  const Cs = C();
  const m = Cs.Transforms.eastNorthUpToFixedFrame(origin);
  const h0 = Cs.Cartographic.fromCartesian(origin).height, R2 = 2 * (6371000 + h0);
  const ox = origin.x, oy = origin.y, oz = origin.z;
  const Ex = m[0], Ey = m[1], Ez = m[2], Nx = m[4], Ny = m[5], Nz = m[6], Ux = m[8], Uy = m[9], Uz = m[10];
  const out = { e: 0, n: 0, h: 0 };
  return {
    // (x, y, z) → {e, n, h}. One shared result object: read it before calling again.
    at(x, y, z) {
      const dx = x - ox, dy = y - oy, dz = z - oz;
      const e = dx * Ex + dy * Ey + dz * Ez, n = dx * Nx + dy * Ny + dz * Nz;
      out.e = e; out.n = n;
      out.h = h0 + dx * Ux + dy * Uy + dz * Uz + (e * e + n * n) / R2;
      return out;
    },
    // (e, n) → Cartographic (longitude, latitude; height 0).
    carto(e, n) {
      const p = new Cs.Cartesian3(ox + e * Ex + n * Nx, oy + e * Ey + n * Ny, oz + e * Ez + n * Nz);
      const c = Cs.Cartographic.fromCartesian(p);
      c.height = 0;
      return c;
    },
  };
}

// Lay out a grid over a footprint (a flat [e0, n0, e1, n1, ...] list in the
// frame): cells near any footprint point are marked for sampling, the rest
// left empty. The cell size follows the marked area, so a long thin cave gets
// fine cells and a sprawling one coarser ones.
export function planGroundGrid(foot, { margin = 60, maxNodes = 40000, minCell = 5, maxGrid = 2e6 } = {}) {
  if (foot.length < 2) return null;
  let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
  for (let i = 0; i < foot.length; i += 2) {
    const e = foot[i], n = foot[i + 1];
    if (e < e0) e0 = e; if (e > e1) e1 = e; if (n < n0) n0 = n; if (n > n1) n1 = n;
  }
  e0 -= margin; n0 -= margin; e1 += margin; n1 += margin;
  // Footprint area, measured on a coarse grid of margin-sized cells.
  const cc = margin, cnx = Math.ceil((e1 - e0) / cc) + 1;
  const coarse = new Set();
  for (let i = 0; i < foot.length; i += 2) {
    const ci = Math.floor((foot[i] - e0) / cc), cj = Math.floor((foot[i + 1] - n0) / cc);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) coarse.add((cj + dj) * cnx + ci + di);
  }
  const area = coarse.size * cc * cc;
  const cell = Math.max(minCell, Math.sqrt(area / maxNodes), Math.sqrt((e1 - e0) * (n1 - n0) / maxGrid));
  const nx = Math.ceil((e1 - e0) / cell) + 1, ny = Math.ceil((n1 - n0) / cell) + 1;
  const mask = new Uint8Array(nx * ny), r = Math.ceil(margin / cell);
  for (let i = 0; i < foot.length; i += 2) {
    const ci = Math.round((foot[i] - e0) / cell), cj = Math.round((foot[i + 1] - n0) / cell);
    for (let j = Math.max(0, cj - r); j <= Math.min(ny - 1, cj + r); j++) {
      const row = j * nx;
      for (let k = Math.max(0, ci - r); k <= Math.min(nx - 1, ci + r); k++) mask[row + k] = 1;
    }
  }
  let nodes = 0;
  for (let k = 0; k < mask.length; k++) nodes += mask[k];
  return { e0, n0, cell, nx, ny, mask, nodes, h: null };
}

// Footprint points along a polyline of frame positions, at most `step` apart.
export function pushFootLine(foot, pts, step) {
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    foot.push(p.e, p.n);
    if (k + 1 < pts.length) {
      const q = pts[k + 1], d = Math.hypot(q.e - p.e, q.n - p.n), m = Math.floor(d / step);
      for (let s = 1; s <= m; s++) { const t = s / (m + 1); foot.push(p.e + (q.e - p.e) * t, p.n + (q.n - p.n) * t); }
    }
  }
}

// Sample the marked nodes from a terrain provider. Fills G.h (NaN where
// unmarked or the terrain had nothing); resolves to G, or null on timeout.
export async function sampleGroundGrid(G, frame, terrainProvider, { timeoutMs = 90000 } = {}) {
  const Cs = C();
  const idx = [], cartos = [];
  for (let j = 0; j < G.ny; j++) for (let i = 0; i < G.nx; i++) {
    const k = j * G.nx + i;
    if (!G.mask[k]) continue;
    idx.push(k);
    cartos.push(frame.carto(G.e0 + i * G.cell, G.n0 + j * G.cell));
  }
  const timeout = new Promise(res => setTimeout(() => res(null), timeoutMs));
  // Most detailed where the provider says what it has (Cesium World Terrain);
  // a fixed, fine level for one that doesn't.
  const sample = terrainProvider.availability
    ? Cs.sampleTerrainMostDetailed(terrainProvider, cartos)
    : Cs.sampleTerrain(terrainProvider, 14, cartos);
  const got = await Promise.race([sample, timeout]);
  if (!got) return null;
  const h = new Float32Array(G.nx * G.ny).fill(NaN);
  for (let m = 0; m < idx.length; m++) {
    const v = got[m] && got[m].height;
    if (Number.isFinite(v)) h[idx[m]] = v;
  }
  G.h = h;
  G.frame = frame;
  return G;
}

// Ground height at (e, n) in the grid's frame: bilinear, or the weighted mean
// of whichever corners have a height; NaN off the sampled area.
export function gridHeight(G, e, n) {
  const fx = (e - G.e0) / G.cell, fy = (n - G.n0) / G.cell;
  const i = Math.floor(fx), j = Math.floor(fy);
  if (i < 0 || j < 0 || i >= G.nx - 1 || j >= G.ny - 1) return NaN;
  const u = fx - i, w = fy - j, k = j * G.nx + i, H = G.h;
  const a = H[k], b = H[k + 1], c = H[k + G.nx], d = H[k + G.nx + 1];
  const wa = (1 - u) * (1 - w), wb = u * (1 - w), wc = (1 - u) * w, wd = u * w;
  if (a === a && b === b && c === c && d === d) return a * wa + b * wb + c * wc + d * wd;
  let s = 0, ws = 0;
  if (a === a) { s += a * wa; ws += wa; }
  if (b === b) { s += b * wb; ws += wb; }
  if (c === c) { s += c * wc; ws += wc; }
  if (d === d) { s += d * wd; ws += wd; }
  return ws > 1e-9 ? s / ws : NaN;
}

// Is the ground at (e, n) from LiDAR (a grid from mergeLidarGround)?
export function gridFromLidar(G, e, n) {
  if (!G.lidar) return false;
  const i = Math.round((e - G.e0) / G.cell), j = Math.round((n - G.n0) / G.cell);
  return i >= 0 && j >= 0 && i < G.nx && j < G.ny && G.lidar[j * G.nx + i] === 1;
}

// Is (e, n) inside the part of the grid that was sampled?
export function gridCovers(G, e, n) {
  const i = Math.round((e - G.e0) / G.cell), j = Math.round((n - G.n0) / G.cell);
  return i >= 0 && j >= 0 && i < G.nx && j < G.ny && G.mask[j * G.nx + i] === 1;
}

// Depth below ground of a world point (m; negative above the ground, NaN off
// the grid).
export function depthBelowGround(G, x, y, z) {
  const p = G.frame.at(x, y, z), h = p.h;
  return gridHeight(G, p.e, p.n) - h;
}

// ── Ground from loaded LiDAR ────────────────────────────────────────────────
// The ground-classified (ASPRS class 2) returns of point clouds already in
// memory, binned onto a grid's sampled nodes: the mean height of the returns
// within half a cell of each node. Only class 2 counts as ground; every other
// class is left alone (noise below the surface is never taken for it).
// clouds: [{ nodes: [{ pos, cls, m }], zScale, toLonLat(x, y) → [lon, lat],
//            toScene(lon, lat) → [x, y] }] — pos/cls the node's attributes,
// m its matrixWorld elements; world z / zScale is the height on the globe.
// Works in slices of `budgetMs` so a big cloud doesn't freeze the page.
export async function binLidarGround(G, frame, clouds, { budgetMs = 12 } = {}) {
  const Cs = C();
  const n = G.nx * G.ny, sum = new Float64Array(n), cnt = new Uint32Array(n);
  const P = new Cs.Cartesian3();
  let t0 = performance.now(), points = 0;
  for (const cl of clouds) {
    // The grid's outline in the cloud's own coordinates, padded, to skip far
    // points before the costly part.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const E1 = G.e0 + (G.nx - 1) * G.cell, N1 = G.n0 + (G.ny - 1) * G.cell;
    for (const [e, nn] of [[G.e0, G.n0], [E1, G.n0], [G.e0, N1], [E1, N1], [(G.e0 + E1) / 2, G.n0], [(G.e0 + E1) / 2, N1], [G.e0, (G.n0 + N1) / 2], [E1, (G.n0 + N1) / 2]]) {
      const c = frame.carto(e, nn);
      const [x, y] = cl.toScene(Cs.Math.toDegrees(c.longitude), Cs.Math.toDegrees(c.latitude));
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const pad = 0.05 * Math.max(x1 - x0, y1 - y0) + 4 * G.cell;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    for (const nd of cl.nodes) {
      const { pos, cls, m } = nd;
      const N = Math.min(pos.length / 3, cls.length);
      for (let i = 0, o = 0; i < N; i++, o += 3) {
        if (Math.round(cls[i]) !== 2) continue;
        const x = pos[o], y = pos[o + 1], z = pos[o + 2];
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
        if (wx < x0 || wx > x1 || wy < y0 || wy > y1) continue;
        const h = (m[2] * x + m[6] * y + m[10] * z + m[14]) / cl.zScale;
        const [lon, lat] = cl.toLonLat(wx, wy);
        Cs.Cartesian3.fromDegrees(lon, lat, h, undefined, P);
        const q = frame.at(P.x, P.y, P.z);
        const gi = Math.round((q.e - G.e0) / G.cell), gj = Math.round((q.n - G.n0) / G.cell);
        if (gi < 0 || gj < 0 || gi >= G.nx || gj >= G.ny) continue;
        const k = gj * G.nx + gi;
        if (!G.mask[k]) continue;
        sum[k] += h; cnt[k]++; points++;
      }
      if (performance.now() - t0 > budgetMs) { await new Promise(r => setTimeout(r, 0)); t0 = performance.now(); }
    }
  }
  return { sum, cnt, points };
}

// A copy of grid G with the LiDAR ground in: nodes with returns take their
// mean; sampled nodes with none take the mean of LiDAR nodes up to two cells
// away; the rest keep G's height (the terrain). grid.lidar flags the nodes
// now from LiDAR; share: their part of the sampled nodes.
export function mergeLidarGround(G, sum, cnt) {
  const n = G.nx * G.ny, h = G.h ? Float32Array.from(G.h) : new Float32Array(n).fill(NaN);
  const lid = new Float32Array(n).fill(NaN), lidar = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (cnt[k]) lid[k] = sum[k] / cnt[k];
  let fromLidar = 0;
  for (let j = 0; j < G.ny; j++) for (let i = 0; i < G.nx; i++) {
    const k = j * G.nx + i;
    if (!G.mask[k]) continue;
    if (lid[k] === lid[k]) { h[k] = lid[k]; lidar[k] = 1; fromLidar++; continue; }
    let s = 0, c = 0;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= G.nx || jj >= G.ny) continue;
      const v = lid[jj * G.nx + ii];
      if (v === v) { s += v; c++; }
    }
    if (c) { h[k] = s / c; lidar[k] = 1; fromLidar++; }
  }
  const grid = { ...G, h, lidar, source: 'lidar', lidarNodes: fromLidar, _coverFor: null };
  return { grid, share: G.nodes ? fromLidar / G.nodes : 0 };
}
