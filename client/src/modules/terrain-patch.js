// terrain-patch.js — a high-resolution terrain patch inside world terrain.
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
  const WORLD_CACHE = 48;       // world tiles kept per provider for edge tiles
  const SKIRT_FACTOR = 6;       // skirts this many times Cesium's default

  const schemes = new WeakMap();
  /** The finest level worth answering for this DEM: the first whose sample spacing reaches the DEM's own post
   *  spacing (finer levels only bilinear-interpolate the same posts, and every level down is 4x the tiles,
   *  all baked on the main thread). A fixed 19 made a 2 m DEM build ~64x more tiles up close than useful. */
  function levelFor(ts, p) {
    try {
      const lat0 = C.Math.toRadians((p.south + p.north) / 2), mLon = 111320 * Math.cos(lat0);
      const post = Math.max(0.05, Math.min(p.dlon * mLon, p.dlat * 110540));           // metres between DEM posts
      const widthM = l => C.Math.toDegrees(ts.rectangle.width) / ts.getNumberOfXTilesAtLevel(l) * mLon;
      for (let l = MIN_LEVEL + 1; l < DEFAULT_MAX_LEVEL; l++) if (widthM(l) / (TILE - 1) <= post) return l;
    } catch (_) {}
    return DEFAULT_MAX_LEVEL;
  }
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

  // ── Fast globe.getHeight on patch tiles ─────────────────────────────────────────────────────
  // Cesium's GlobeSurfaceTile.pick (what globe.getHeight ends in) tests the ray against every triangle of the
  // tile: ~8,500 for a 65 x 65 patch tile, about 0.5 ms a call, and the camera-collision check plus FLEX's own
  // ground-height reads make two or more calls every frame (it doubled the frame cost over the patch). For the
  // vertical rays getHeight casts, the triangles are bucketed once per mesh by their footprint in the tile's
  // (u,v) square, and only the few in the ray's bucket are tested, with the same Cesium routine on the same
  // decoded positions — so the answer is the one the full scan gives.
  const GRID = 16, UVPAD = 3 / 4095;            // buckets a side; texture coordinates are 12-bit packed, so pad the footprints
  const buckets = new WeakMap();
  function bucketsOf(mesh) {
    let b = buckets.get(mesh);
    if (b) return b;
    const { vertices, indices, encoding } = mesh, nTri = indices.length / 3, uv = new C.Cartesian2();
    const nv = vertices.length / encoding.stride;
    const vu = new Float32Array(nv), vv = new Float32Array(nv);
    for (let i = 0; i < nv; i++) { encoding.decodeTextureCoordinates(vertices, i, uv); vu[i] = uv.x; vv[i] = uv.y; }
    const start = new Uint32Array(GRID * GRID + 1), box = new Int32Array(nTri * 4);
    const cell = x => Math.min(GRID - 1, Math.max(0, Math.floor(x * GRID)));
    for (let t = 0; t < nTri; t++) {
      const a = indices[3 * t], c = indices[3 * t + 1], d = indices[3 * t + 2];
      const x0 = cell(Math.min(vu[a], vu[c], vu[d]) - UVPAD), x1 = cell(Math.max(vu[a], vu[c], vu[d]) + UVPAD);
      const y0 = cell(Math.min(vv[a], vv[c], vv[d]) - UVPAD), y1 = cell(Math.max(vv[a], vv[c], vv[d]) + UVPAD);
      box[4 * t] = x0; box[4 * t + 1] = x1; box[4 * t + 2] = y0; box[4 * t + 3] = y1;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) start[y * GRID + x + 1]++;
    }
    for (let k = 0; k < GRID * GRID; k++) start[k + 1] += start[k];
    const fill = start.slice(0, GRID * GRID), list = new Uint32Array(start[GRID * GRID]);
    for (let t = 0; t < nTri; t++) for (let y = box[4 * t + 2]; y <= box[4 * t + 3]; y++) for (let x = box[4 * t]; x <= box[4 * t + 1]; x++) list[fill[y * GRID + x]++] = t;
    b = { start, list };
    buckets.set(mesh, b);
    return b;
  }
  /** Flag a tile's data (and, in turn, the tiles Cesium upsamples from it where the world has no finer data) so
   *  globe.getHeight uses the bucketed pick on them. */
  function markPatchTile(data) {
    data._flexPatchTile = true;
    const up = data.upsample;
    if (typeof up === 'function') data.upsample = function () {
      const r = up.apply(this, arguments);
      return r && typeof r.then === 'function' ? r.then(d => { if (d && !d._flexPatchTile) markPatchTile(d); return d; }) : r;
    };
    return data;
  }
  let pickHooked = false;
  const pickStats = { fast: 0, full: 0, why: {} };   // calls answered by the buckets / by Cesium's full scan (and why)
  /** Hook GlobeSurfaceTile.prototype.pick once (the viewer needs a tile with data to reach the prototype). */
  function hookPick(viewer) {
    if (pickHooked || !viewer || !viewer.scene) return;
    const find = () => {
      try { for (const t of viewer.scene.globe._surface._tilesToRender) if (t.data && t.data.pick) return Object.getPrototypeOf(t.data); } catch (_) {}
      return null;
    };
    const apply = proto => {
      const orig = proto.pick, v0 = new C.Cartesian3(), v1 = new C.Cartesian3(), v2 = new C.Cartesian3(), cart = new C.Cartesian3();
      proto.pick = function (ray, mode, projection, cullBackFaces, result) {
        const mesh = this.renderedMesh, td = this.terrainData;
        if (mode !== undefined || cullBackFaces || !mesh || !td || !td._flexPatchTile || !this.tileBoundingRegion || !this.tileBoundingRegion.rectangle) {
          pickStats.full++; const w = mode !== undefined ? 'mode' : cullBackFaces ? 'cull' : !mesh ? 'nomesh' : !td ? 'noterraindata' : !td._flexPatchTile ? 'notpatch:' + (td.constructor && td.constructor.name) : 'noregion';
          pickStats.why[w] = (pickStats.why[w] || 0) + 1;
          return orig.call(this, ray, mode, projection, cullBackFaces, result);
        }
        try {
          // the ray is globe.getHeight's: along the geodetic surface normal, so its direction gives longitude and latitude
          const dir = ray.direction, rect = this.tileBoundingRegion.rectangle;
          const lon = Math.atan2(dir.y, dir.x), lat = Math.atan2(dir.z, Math.hypot(dir.x, dir.y));
          const u = (lon - rect.west) / (rect.east - rect.west), v = (lat - rect.south) / (rect.north - rect.south);
          if (!(u >= -0.01 && u <= 1.01 && v >= -0.01 && v <= 1.01)) return orig.call(this, ray, mode, projection, cullBackFaces, result);
          const b = bucketsOf(mesh), cx = Math.min(GRID - 1, Math.max(0, Math.floor(u * GRID))), cy = Math.min(GRID - 1, Math.max(0, Math.floor(v * GRID)));
          const { vertices, indices, encoding } = mesh, k = cy * GRID + cx;
          let minT = Number.MAX_VALUE;
          for (let q = b.start[k]; q < b.start[k + 1]; q++) {
            const i = b.list[q] * 3;
            const t = C.IntersectionTests.rayTriangleParametric(ray, encoding.getExaggeratedPosition(vertices, indices[i], v0), encoding.getExaggeratedPosition(vertices, indices[i + 1], v1), encoding.getExaggeratedPosition(vertices, indices[i + 2], v2), false);
            if (t !== undefined && t < minT && t >= 0) minT = t;
          }
          pickStats.fast++;
          return minT !== Number.MAX_VALUE ? C.Ray.getPoint(ray, minT, result) : undefined;
        } catch (_) { return orig.call(this, ray, mode, projection, cullBackFaces, result); }
      };
      proto.pick._flexOrig = orig; pickHooked = true;
    };
    const proto = find();
    if (proto) { apply(proto); return; }
    const off = viewer.scene.postRender.addEventListener(() => { if (pickHooked) { off(); return; } const p = find(); if (p) { apply(p); off(); } });
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
      this._base = base; this._p = patch; this._max = patch.maxLevel || levelFor(base.tilingScheme, patch);
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
    getLevelMaximumGeometricError(level) {        // asked for every tile every frame: remembered per level
      const c = this._gerr || (this._gerr = []);
      return level in c ? c[level] : (c[level] = this._base.getLevelMaximumGeometricError(level));
    }

    _inside(lon, lat) { return lon >= this._w && lon <= this._e && lat >= this._s && lat <= this._n; }
    /** Does the tile touch the patch (and is it a level the patch answers)? */
    _overlaps(x, y, level) {
      // answers every level up to DEFAULT_MAX_LEVEL (a height asked for at a fixed fine level must still be the
      // patch's); _max only stops refinement: tiles at _max report no children (childTileMask below)
      if (level < MIN_LEVEL || level > Math.max(this._max, DEFAULT_MAX_LEVEL) || x < 0 || y < 0) return false;
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
        const w = await this._worldAt(ax, ay, l);
        if (w) return w;
      }
      return null;
    }
    /** One world tile, shared: the many fine tiles along a patch edge all want the same coarse world tile, which was
     *  requested (and parsed) again for each of them. The last few are kept; a failed request is not remembered. */
    _worldAt(ax, ay, l) {
      const cache = this._wcache || (this._wcache = new Map()), key = l + '/' + ax + '/' + ay;
      let pr = cache.get(key);
      if (pr) { cache.delete(key); cache.set(key, pr); return pr; }
      pr = (async () => {
        let data; try { data = await this._base.requestTileGeometry(ax, ay, l); } catch (_) { data = null; }
        return data && typeof data.interpolateHeight === 'function' ? { data, rect: this.tilingScheme.tileXYToRectangle(ax, ay, l) } : null;
      })();
      cache.set(key, pr);
      pr.then(w => { if (!w) cache.delete(key); }, () => cache.delete(key));
      if (cache.size > WORLD_CACHE) cache.delete(cache.keys().next().value);
      return pr;
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
      markPatchTile(data);
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


  // ── A DEM (GeoTIFF read by custom-layers.js) → one or several patches ───────────────────────
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
    // (a provider without availability, e.g. the plain ellipsoid, can't say its most detailed level: ask one)
    // One call for the lot: Cesium groups the positions by tile and requests each tile once, where batches of 2000
    // (45 for a 6 km patch, one after the other) asked for the same tiles again and waited a round trip each.
    const part = base.availability ? await C.sampleTerrainMostDetailed(base, pos) : await C.sampleTerrain(base, MIN_LEVEL, pos);
    part.forEach((c, q) => { wh[q] = c.height; });
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
    hookPick(viewer);
    return tp;
  }
  /** Fill the unknown cells of a lattice from the nearest known ones, one ring at a time: each unknown cell
   *  takes the mean of its already-known 4-neighbours. Same result as rescanning the lattice once per ring,
   *  but each cell is visited once (a ragged polygon left many rings, and that rescan was the slow part). */
  function spread(v, known, nx, ny) {
    let left = 0; for (let k = 0; k < known.length; k++) if (!known[k]) left++;
    if (left === known.length) { v.fill(0); return; }
    const queued = new Uint8Array(known.length);
    let ring = [];
    const nb = (k, f) => { const i = k % nx, j = (k - i) / nx; if (i > 0) f(k - 1); if (i < nx - 1) f(k + 1); if (j > 0) f(k - nx); if (j < ny - 1) f(k + nx); };
    for (let k = 0; k < known.length; k++) if (!known[k]) { let touch = false; nb(k, q => { if (known[q]) touch = true; }); if (touch) { ring.push(k); queued[k] = 1; } }
    while (ring.length) {
      const vals = new Float64Array(ring.length);
      ring.forEach((k, r) => { let s = 0, c = 0; nb(k, q => { if (known[q]) { s += v[q]; c++; } }); vals[r] = s / c; });
      ring.forEach((k, r) => { v[k] = vals[r]; known[k] = 1; });
      const next = [];
      ring.forEach(k => nb(k, q => { if (!known[q] && !queued[q]) { queued[q] = 1; next.push(q); } }));
      ring = next;
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
  window._terrainPatch = { install, uninstall, uninstallAll, parse, pack, edgeField, plan, bake, MAX_SIDE, MAX_TILES, OVERLAP_M, PatchTerrainProvider, RAMP_M, pickStats };
})();
