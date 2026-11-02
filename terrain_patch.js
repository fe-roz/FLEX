// terrain_patch.js — a high-resolution terrain patch inside world terrain.
//
// Wraps the viewer's terrain provider. Where a tile lies in the patch (a baked grid of WGS84
// ellipsoid heights) its heights come from the grid; elsewhere from the original provider.
// The same height function is used at every zoom level — the grid inside the patch, the world
// terrain outside, and a smooth hand-over in a strip just inside the patch edge (the grid plus
// the world-minus-grid difference measured once at install, fading to nothing) — so tiles of
// different levels agree and nothing pops as you zoom. Height queries (sampleTerrainMostDetailed)
// see the patch too.
//
//   const tp = await window._terrainPatch.install(viewer, '/api/lib/blob/<sha>.bin');
//   window._terrainPatch.uninstallAll(viewer);
//
// File (".bin", one blob): uint32 LE header length, header JSON (utf-8, padded with spaces so the
// grid starts on a 4-byte boundary), then float32 LE heights, row-major, first row = north edge.
// Header: { format:'flex-terrain-patch', version:2, west, south, east, north, nx, ny, name, … } (degrees).
//
// NaN posts mean "no DEM here" (the corners a rotated UTM DEM leaves in its lon/lat box, or the
// outside of a polygon). Those take the world terrain, and the hand-over strip is measured from the
// DEM's own edge (distance to the nearest NaN post) as well as from the box, so there is no step at
// the real edge of the data. A big area is several patches side by side, overlapping by more than
// the strip: each later one hands over to the earlier ones' terrain at its edge.
(function () {
  'use strict';
  const C = window.Cesium;
  const TILE = 65;              // samples per tile side
  const MIN_LEVEL = 11;         // never replace tiles coarser than this
  const DEFAULT_MAX_LEVEL = 19; // finest level the patch answers
  const RAMP_M = 60;            // metres inside the patch edge over which the hand-over to world terrain fades
  const STEP = 20;              // metres between world-minus-grid measurements
  const SKIRT_FACTOR = 6;       // skirts this many times Cesium's default

  const schemes = new WeakMap();
  function skirtScheme(ts) {
    let p = schemes.get(ts);
    if (!p) {
      p = new Proxy(ts, { get(t, k) {
        const v = t[k];
        if (k === 'getNumberOfXTilesAtLevel') return level => (level === 0 ? t.getNumberOfXTilesAtLevel(0) / SKIRT_FACTOR : t.getNumberOfXTilesAtLevel(level));
        return typeof v === 'function' ? v.bind(t) : v;
      } });
      schemes.set(ts, p);
    }
    return p;
  }
  const fall = t => { const s = Math.min(Math.max(t, 0), 1); return 1 - s * s * (3 - 2 * s); };

  /** Distance from each post to the nearest NaN post, as bytes: 0 = no data, 1..254 = distance / RAMP_M * 254 (254 = RAMP_M or more).
   *  mx, my = metres per post step east and north. Returns null when the grid has no NaN. */
  function edgeField(grid, nx, ny, mx, my) {
    let any = false;
    for (let k = 0; k < grid.length; k++) if (grid[k] !== grid[k]) { any = true; break; }
    if (!any) return null;
    const dg = Math.hypot(mx, my), INF = 1e9, d = new Float32Array(nx * ny);
    for (let k = 0; k < d.length; k++) d[k] = grid[k] !== grid[k] ? 0 : INF;
    const relax = (k, j, i, di, dj, w) => { const ii = i + di, jj = j + dj; if (ii < 0 || ii >= nx || jj < 0 || jj >= ny) return; const v = d[jj * nx + ii] + w; if (v < d[k]) d[k] = v; };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const k = j * nx + i; if (d[k] === 0) continue; relax(k, j, i, -1, 0, mx); relax(k, j, i, 0, -1, my); relax(k, j, i, -1, -1, dg); relax(k, j, i, 1, -1, dg); }
    for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) { const k = j * nx + i; if (d[k] === 0) continue; relax(k, j, i, 1, 0, mx); relax(k, j, i, 0, 1, my); relax(k, j, i, 1, 1, dg); relax(k, j, i, -1, 1, dg); }
    const out = new Uint8Array(nx * ny);
    for (let k = 0; k < out.length; k++) out[k] = d[k] === 0 ? 0 : Math.max(1, Math.min(254, Math.ceil(d[k] / RAMP_M * 254)));
    return out;
  }

  class PatchTerrainProvider {
    constructor(base, patch) {
      this._base = base; this._p = patch; this._max = patch.maxLevel || DEFAULT_MAX_LEVEL;
      this.tilingScheme = base.tilingScheme;
      const p = patch, d = C.Math.toRadians;
      this._w = d(p.west); this._e = d(p.east); this._s = d(p.south); this._n = d(p.north);
      const lat0 = d((p.south + p.north) / 2);
      this._mLon = 111320 * Math.cos(lat0); this._mLat = 110540;     // metres per degree
      const av = base.availability, self = this;
      this.availability = av ? new Proxy(av, {
        get(t, k) {
          if (k === 'computeMaximumLevelAtPosition') return pos => (self._inside(pos.longitude, pos.latitude) ? self._max : t.computeMaximumLevelAtPosition(pos));
          const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
        }
      }) : undefined;
    }
    get errorEvent() { return this._base.errorEvent; }
    get credit() { return this._base.credit; }
    get hasWaterMask() { return this._base.hasWaterMask; }
    get hasVertexNormals() { return false; }
    get ready() { return true; }
    get readyPromise() { return Promise.resolve(true); }
    getLevelMaximumGeometricError(level) { return this._base.getLevelMaximumGeometricError(level); }

    _inside(lon, lat) { return lon >= this._w && lon <= this._e && lat >= this._s && lat <= this._n; }
    /** Does the tile touch the patch (and is it a level the patch answers)? */
    _overlaps(x, y, level) {
      if (level < MIN_LEVEL || level > this._max || x < 0 || y < 0) return false;
      const r = this.tilingScheme.tileXYToRectangle(x, y, level);
      return r.east > this._w && r.west < this._e && r.north > this._s && r.south < this._n;
    }
    /** Is the whole tile deeper inside the patch than the hand-over strip (so it needs no world data)? */
    _wholly(r) {
      const mx = RAMP_M / this._mLon * Math.PI / 180, my = RAMP_M / this._mLat * Math.PI / 180;
      return r.west >= this._w + mx && r.east <= this._e - mx && r.south >= this._s + my && r.north <= this._n - my;
    }
    _grid(lon, lat) {         // bilinear from the grid (degrees in), clamped to its edge
      const p = this._p;
      let fx = (lon - p.west) / p.dlon, fy = (p.north - lat) / p.dlat;
      fx = Math.min(Math.max(fx, 0), p.nx - 1.001); fy = Math.min(Math.max(fy, 0), p.ny - 1.001);
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, g = p.grid, nx = p.nx;
      const a = g[y0 * nx + x0], b = g[y0 * nx + x0 + 1], c = g[(y0 + 1) * nx + x0], d = g[(y0 + 1) * nx + x0 + 1];
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
    _delta(lon, lat) {        // world minus grid, on the coarse grid measured at install
      const p = this._p;
      let fx = (lon - p.west) / p.dxd, fy = (p.north - lat) / p.dyd;
      fx = Math.min(Math.max(fx, 0), p.nxd - 1.001); fy = Math.min(Math.max(fy, 0), p.nyd - 1.001);
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, g = p.dgrid, n = p.nxd;
      return (g[y0 * n + x0] * (1 - tx) + g[y0 * n + x0 + 1] * tx) * (1 - ty) + (g[(y0 + 1) * n + x0] * (1 - tx) + g[(y0 + 1) * n + x0 + 1] * tx) * ty;
    }
    /** Metres inside the patch edge (negative outside). */
    _depth(lonDeg, latDeg) {
      const p = this._p;
      return Math.min((lonDeg - p.west) * this._mLon, (p.east - lonDeg) * this._mLon, (latDeg - p.south) * this._mLat, (p.north - latDeg) * this._mLat);
    }
    /** The patch's height at a point inside it, handing over to the world terrain at the edge. */
    height(lonRad, latRad) {
      const lon = C.Math.toDegrees(lonRad), lat = C.Math.toDegrees(latRad);
      let d = this._depth(lon, lat);
      const p = this._p;
      if (p.edge) {                    // the strip also fades from the DEM's own edge
        let fx = (lon - p.west) / p.dlon, fy = (p.north - lat) / p.dlat;      // bilinear, so the strip is smooth
        fx = Math.min(Math.max(fx, 0), p.nx - 1.001); fy = Math.min(Math.max(fy, 0), p.ny - 1.001);
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, E = p.edge, n = p.nx;
        const e = (E[y0 * n + x0] * (1 - tx) + E[y0 * n + x0 + 1] * tx) * (1 - ty) + (E[(y0 + 1) * n + x0] * (1 - tx) + E[(y0 + 1) * n + x0 + 1] * tx) * ty;
        d = Math.min(d, e / 254 * RAMP_M);               // 0 in the empty corners: all delta, so exactly the world terrain
      }
      const w = d >= RAMP_M ? 0 : fall(d / RAMP_M);
      return this._grid(lon, lat) + (w > 0 ? w * this._delta(lon, lat) : 0);
    }
    /** Heights of the tile the world provider would give here, or the nearest coarser one that exists. */
    async _worldTile(x, y, level) {
      for (let l = level; l >= 0; l--) {
        const k = level - l, ax = x >> k, ay = y >> k;
        const av = this._base.getTileDataAvailable ? this._base.getTileDataAvailable(ax, ay, l) : undefined;
        if (av === false) continue;
        let data; try { data = await this._base.requestTileGeometry(ax, ay, l); } catch (_) { data = null; }
        if (data && typeof data.interpolateHeight === 'function') return { data, rect: this.tilingScheme.tileXYToRectangle(ax, ay, l) };
      }
      return null;
    }
    async requestTileGeometry(x, y, level, request) {
      if (!this._overlaps(x, y, level)) return this._base.requestTileGeometry(x, y, level, request);
      const r = this.tilingScheme.tileXYToRectangle(x, y, level), buf = new Float32Array(TILE * TILE), N = TILE - 1;
      const world = this._wholly(r) ? null : await this._worldTile(x, y, level);
      for (let j = 0; j < TILE; j++) {
        const lat = r.north - (r.north - r.south) * j / N;
        for (let i = 0; i < TILE; i++) {
          const lon = r.west + (r.east - r.west) * i / N;
          let h;
          if (this._inside(lon, lat)) h = this.height(lon, lat);
          else {
            h = world ? world.data.interpolateHeight(world.rect, lon, lat) : undefined;
            if (h === undefined || isNaN(h)) h = this.height(Math.min(Math.max(lon, this._w), this._e), Math.min(Math.max(lat, this._s), this._n));
          }
          buf[j * TILE + i] = h;
        }
      }
      const data = new C.HeightmapTerrainData({
        buffer: buf, width: TILE, height: TILE, childTileMask: level < this._max ? 15 : 0,
        structure: { heightScale: 1, heightOffset: 0, elementsPerHeight: 1, stride: 1, elementMultiplier: 256, isBigEndian: false },
        createdByUpsampling: false
      });
      // Cesium hangs a skirt below each height-map tile of (estimated level error x 4) — too little to
      // hide a join with a world tile. It derives that from the tile count at level 0.
      const mesh = data.createMesh.bind(data);
      data.createMesh = opts => mesh(Object.assign({}, opts, { tilingScheme: skirtScheme(opts.tilingScheme) }));
      return data;
    }
    getTileDataAvailable(x, y, level) { return this._overlaps(x, y, level) ? true : (this._base.getTileDataAvailable ? this._base.getTileDataAvailable(x, y, level) : undefined); }
    loadTileDataAvailability(x, y, level) { return this._overlaps(x, y, level) ? undefined : (this._base.loadTileDataAvailability ? this._base.loadTileDataAvailability(x, y, level) : undefined); }
  }

  /** Read the one-blob file. */
  function parse(buf) {
    const dv = new DataView(buf), n = dv.getUint32(0, true);
    const m = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
    if (m.format !== 'flex-terrain-patch') throw new Error('not a FLEX terrain patch');
    const off = 4 + n, grid = new Float32Array(buf.slice(off, off + m.nx * m.ny * 4));
    if (grid.length !== m.nx * m.ny) throw new Error('terrain patch: size mismatch');
    m.dlon = (m.east - m.west) / (m.nx - 1); m.dlat = (m.north - m.south) / (m.ny - 1);
    return { meta: m, grid };
  }
  /** Make the one-blob file: meta (west, south, east, north, nx, ny, …) and a Float32Array grid. */
  function pack(meta, grid) {
    const head = new TextEncoder().encode(JSON.stringify(Object.assign({ format: 'flex-terrain-patch', version: 2 }, meta)));
    const pad = (4 - ((4 + head.length) % 4)) % 4, off = 4 + head.length + pad;
    const out = new Uint8Array(off + grid.length * 4);
    new DataView(out.buffer).setUint32(0, head.length + pad, true);
    out.set(head, 4); out.fill(32, 4 + head.length, off);
    out.set(new Uint8Array(grid.buffer, grid.byteOffset, grid.length * 4), off);
    return out;
  }


  // ── A DEM (GeoTIFF read by custom_layers.js) → one or several patches ───────────────────────
  const MAX_SIDE = 3000;          // posts a side of one patch: 36 MB as float32, under the library's 40 MB blob limit
  const MAX_TILES = 9;            // patches for one DEM (3 x 3 at most: ~4.4 km a side at 0.5 m, 324 MB of heights in memory)
  const OVERLAP_M = 150;          // neighbouring patches overlap by this (more than twice the hand-over strip)
  /** Where the patches go: the DEM's lon/lat box W,S,E,N and cell (m) → { cell_m, nx, ny, tiles: [{i0, j0, nx, ny}] } in posts of the full grid. */
  function plan(W, S, E, N, cellM) {
    const mLon = 111320 * Math.cos((S + N) / 2 * Math.PI / 180), mLat = 110540;
    let cell = Math.max(cellM, 0.01);
    for (;;) {
      const nx = Math.round((E - W) * mLon / cell) + 1, ny = Math.round((N - S) * mLat / cell) + 1, ov = Math.ceil(OVERLAP_M / cell);
      const cut = n => { const t = []; if (n <= MAX_SIDE) return [[0, n]]; const st = MAX_SIDE - ov; for (let a = 0; ; a += st) { const b = Math.min(n, a + MAX_SIDE); t.push([a, b - a]); if (b >= n) break; } return t; };
      const tx = cut(nx), ty = cut(ny);
      if (tx.length * ty.length <= MAX_TILES) {
        const tiles = []; for (const [j0, h] of ty) for (const [i0, w] of tx) tiles.push({ i0, j0, nx: Math.max(2, w), ny: Math.max(2, h) });
        return { cell_m: cell, nx, ny, tiles, mLon, mLat };
      }
      cell *= 1.04;                // too many patches: coarser posts (the smallest step that fits)
    }
  }
  /** Heights (T: { w, h, vals, nd, proj, toXY(col,row) }; dz is added) on the lon/lat posts [i0, i0+nx) x [j0, j0+ny) of a plan, or null if there are none. */
  function bakeBox(T, dz, W, N, dlon, dlat, t) {
    const P = window.proj4;
    const fwd = T.proj === null ? (lon, lat) => [lon, lat] : (P ? (lon, lat) => P('WGS84', T.proj, [lon, lat]) : null);
    if (!fwd) throw new Error('the projection library is missing');
    const west = W + t.i0 * dlon, north = N - t.j0 * dlat, east = west + (t.nx - 1) * dlon, south = north - (t.ny - 1) * dlat;
    const nx = t.nx, ny = t.ny, G = 48, gx = new Float64Array((G + 1) * (G + 1)), gy = new Float64Array((G + 1) * (G + 1));
    const t0 = T.toXY(0, 0), tx = T.toXY(1, 0), ty = T.toXY(0, 1);
    const a = tx[0] - t0[0], b = ty[0] - t0[0], c2 = tx[1] - t0[1], d = ty[1] - t0[1], det = a * d - b * c2;
    for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) {
      const xy = fwd(west + (east - west) * i / G, north - (north - south) * j / G), dx = xy[0] - t0[0], dy = xy[1] - t0[1];
      gx[j * (G + 1) + i] = (d * dx - b * dy) / det; gy[j * (G + 1) + i] = (-c2 * dx + a * dy) / det;
    }
    const z = T.vals, nd = T.nd, bad = v => v !== v || (nd != null && v === nd) || v < -1e30 || v > 1e30;
    const grid = new Float32Array(nx * ny).fill(NaN);
    let lo = Infinity, hi = -Infinity;
    for (let y = 0; y < ny; y++) {
      const fy = y / (ny - 1) * G, j = Math.min(G - 1, Math.floor(fy)), v = fy - j;
      for (let x = 0; x < nx; x++) {
        const fx = x / (nx - 1) * G, i = Math.min(G - 1, Math.floor(fx)), u = fx - i, q = j * (G + 1) + i, q2 = q + G + 1;
        const sc = (gx[q] * (1 - u) + gx[q + 1] * u) * (1 - v) + (gx[q2] * (1 - u) + gx[q2 + 1] * u) * v - 0.5;     // pixel centres sit at +0.5
        const sr = (gy[q] * (1 - u) + gy[q + 1] * u) * (1 - v) + (gy[q2] * (1 - u) + gy[q2 + 1] * u) * v - 0.5;
        if (sc < -0.5 || sr < -0.5 || sc > T.w - 0.5 || sr > T.h - 0.5) continue;
        const c0 = Math.min(T.w - 2, Math.max(0, Math.floor(sc))), r0 = Math.min(T.h - 2, Math.max(0, Math.floor(sr)));
        const fc = Math.min(1, Math.max(0, sc - c0)), fr = Math.min(1, Math.max(0, sr - r0));
        const v00 = z[r0 * T.w + c0], v10 = z[r0 * T.w + c0 + 1], v01 = z[(r0 + 1) * T.w + c0], v11 = z[(r0 + 1) * T.w + c0 + 1];
        if (bad(v00) || bad(v10) || bad(v01) || bad(v11)) continue;
        const h = (v00 * (1 - fc) + v10 * fc) * (1 - fr) + (v01 * (1 - fc) + v11 * fc) * fr + dz;
        grid[y * nx + x] = h; if (h < lo) lo = h; if (h > hi) hi = h;
      }
    }
    if (lo === Infinity) return null;
    return { meta: { west, south, east, north, nx, ny, units: 'm', heightReference: 'WGS84 ellipsoid', min: lo, max: hi }, grid };
  }
  /** A DEM → patches [{ meta, grid }]: one if it fits in MAX_SIDE posts a side, else a few overlapping ones (empty ones left out).
   *  `each(patch, index, plan)` (optional, may be async) gets each patch as soon as it is made, so a caller can store it and let it go (then `tiles` is empty). */
  async function bake(T, dz, each) {
    if (!T.vals) throw new Error('this is not a DEM (one band of heights)');
    const P = window.proj4;
    const inv = T.proj === null ? (x, y) => [x, y] : (P ? (x, y) => P(T.proj, 'WGS84', [x, y]) : null);
    if (!inv) throw new Error('the projection library is missing');
    let W = 180, S = 90, E = -180, N = -90;
    const edge = (c, r) => { const ll = inv(...T.toXY(c, r)); W = Math.min(W, ll[0]); E = Math.max(E, ll[0]); S = Math.min(S, ll[1]); N = Math.max(N, ll[1]); };
    for (let i = 0; i <= 32; i++) { const c = T.w * i / 32, r = T.h * i / 32; edge(c, 0); edge(c, T.h); edge(0, r); edge(T.w, r); }
    if (!(E > W && N > S)) throw new Error('its position makes no sense (check its map projection)');
    const mLon = 111320 * Math.cos((S + N) / 2 * Math.PI / 180), mLat = 110540;
    const p0 = T.toXY(0, 0), p1 = T.toXY(1, 1);
    const cm = Math.max(Math.abs(p1[0] - p0[0]) * (T.proj === null ? mLon : 1), Math.abs(p1[1] - p0[1]) * (T.proj === null ? mLat : 1));
    const pl = plan(W, S, E, N, cm), dlon = (E - W) / (pl.nx - 1), dlat = (N - S) / (pl.ny - 1), out = [];
    let n = 0;
    for (const t of pl.tiles) {
      const r = bakeBox(T, dz, W, N, dlon, dlat, t);
      if (!r) continue;
      r.meta.cell_m = +(dlon * mLon).toFixed(3); r.meta.dem_cell_m = +cm.toFixed(3);
      if (each) await each(r, n, pl); else out.push(r);
      n++;
    }
    if (!n) throw new Error('no heights found in it');
    return { tiles: out, count: n, plan: pl };
  }

  /** Put the patch over whatever terrain the viewer has now (earlier patches stay underneath). */
  async function install(viewer, url, opts) {
    const { meta: m, grid } = parse(await (await fetch(url)).arrayBuffer());
    if (opts && opts.maxLevel) m.maxLevel = opts.maxLevel;
    const base = viewer.terrainProvider;
    const dxd = STEP / (111320 * Math.cos(C.Math.toRadians((m.south + m.north) / 2))), dyd = STEP / 110540;
    const nxd = Math.floor((m.east - m.west) / dxd) + 1, nyd = Math.floor((m.north - m.south) / dyd) + 1;
    // world terrain heights on a ~20 m lattice over the patch
    const wh = new Float32Array(nxd * nyd), pos = [];
    for (let j = 0; j < nyd; j++) for (let i = 0; i < nxd; i++) pos.push(C.Cartographic.fromDegrees(m.west + i * dxd, m.north - j * dyd));
    for (let k = 0; k < pos.length; k += 2000) {
      // (a provider without availability, e.g. the plain ellipsoid, can't say its most detailed level: ask one)
      const part = base.availability ? await C.sampleTerrainMostDetailed(base, pos.slice(k, k + 2000)) : await C.sampleTerrain(base, MIN_LEVEL, pos.slice(k, k + 2000));
      part.forEach((c, q) => { wh[k + q] = c.height; });
    }
    // cells with no data (outside the DEM's own edge) take the world terrain's height; the hand-over
    // strip is then measured from the DEM's real edge, not only from the box
    const edge = edgeField(grid, m.nx, m.ny, (m.east - m.west) / (m.nx - 1) * 111320 * Math.cos(C.Math.toRadians((m.south + m.north) / 2)), (m.north - m.south) / (m.ny - 1) * 110540);
    const worldAt = (lon, lat) => {
      let fx = (lon - m.west) / dxd, fy = (m.north - lat) / dyd;
      fx = Math.min(Math.max(fx, 0), nxd - 1.001); fy = Math.min(Math.max(fy, 0), nyd - 1.001);
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      return (wh[y0 * nxd + x0] * (1 - tx) + wh[y0 * nxd + x0 + 1] * tx) * (1 - ty) + (wh[(y0 + 1) * nxd + x0] * (1 - tx) + wh[(y0 + 1) * nxd + x0 + 1] * tx) * ty;
    };
    // world minus grid at each lattice node, from the DEM's own posts only (a NaN corner of the cell is left out)
    const gridAt = (lon, lat) => {
      let fx = (lon - m.west) / m.dlon, fy = (m.north - lat) / m.dlat;
      fx = Math.min(Math.max(fx, 0), m.nx - 1.001); fy = Math.min(Math.max(fy, 0), m.ny - 1.001);
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      let s = 0, ws = 0;
      for (let q = 0; q < 4; q++) {
        const dx = q & 1, dy = q >> 1, v = grid[(y0 + dy) * m.nx + x0 + dx];
        if (v !== v) continue;
        const w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty); s += v * w; ws += w;
      }
      return ws > 1e-9 ? s / ws : NaN;
    };
    const dgrid = new Float32Array(nxd * nyd), known = new Uint8Array(nxd * nyd);
    for (let k = 0; k < dgrid.length; k++) {
      const g = gridAt(m.west + (k % nxd) * dxd, m.north - Math.floor(k / nxd) * dyd);
      if (g === g) { dgrid[k] = wh[k] - g; known[k] = 1; }
    }
    m.edge = edge;
    if (edge) spread(dgrid, known, nxd, nyd);
    const tp = new PatchTerrainProvider(base, Object.assign({}, m, { grid, dgrid, dxd, dyd, nxd, nyd }));
    // an empty post holds (world - delta): the DEM's surface carried on, so the grid is continuous across the edge and
    // grid + delta is exactly the world terrain there
    if (edge) for (let j = 0; j < m.ny; j++) for (let i = 0; i < m.nx; i++) { const k = j * m.nx + i; if (edge[k] === 0) { const lon = m.west + i * m.dlon, lat = m.north - j * m.dlat; grid[k] = worldAt(lon, lat) - tp._delta(lon, lat); } }
    viewer.terrainProvider = tp;
    return tp;
  }
  /** Fill the unknown cells of a lattice from the nearest known ones (repeated one-cell growth). */
  function spread(v, known, nx, ny) {
    let left = 0; for (let k = 0; k < known.length; k++) if (!known[k]) left++;
    if (left === known.length) { v.fill(0); return; }
    while (left > 0) {
      const add = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i; if (known[k]) continue;
        let s = 0, c = 0;
        if (i > 0 && known[k - 1]) { s += v[k - 1]; c++; } if (i < nx - 1 && known[k + 1]) { s += v[k + 1]; c++; }
        if (j > 0 && known[k - nx]) { s += v[k - nx]; c++; } if (j < ny - 1 && known[k + nx]) { s += v[k + nx]; c++; }
        if (c) add.push(k, s / c);
      }
      if (!add.length) break;
      for (let q = 0; q < add.length; q += 2) { v[add[q]] = add[q + 1]; known[add[q]] = 1; left--; }
    }
  }
  /** Take every patch off, back to the original terrain. */
  function uninstallAll(viewer) {
    let tp = viewer.terrainProvider, changed = false;
    while (tp instanceof PatchTerrainProvider) { tp = tp._base; changed = true; }
    if (changed) viewer.terrainProvider = tp;
    return changed;
  }
  const uninstall = uninstallAll;
  window._terrainPatch = { install, uninstall, uninstallAll, parse, pack, edgeField, plan, bake, MAX_SIDE, MAX_TILES, OVERLAP_M, PatchTerrainProvider, RAMP_M };
})();
