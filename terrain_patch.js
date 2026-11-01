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
      const lon = C.Math.toDegrees(lonRad), lat = C.Math.toDegrees(latRad), d = this._depth(lon, lat);
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
      const part = await C.sampleTerrainMostDetailed(base, pos.slice(k, k + 2000));
      part.forEach((c, q) => { wh[k + q] = c.height; });
    }
    // cells with no data (outside the DEM's own edge) take the world terrain's height
    let holes = false; for (let k = 0; k < grid.length; k++) if (grid[k] !== grid[k]) { holes = true; break; }
    if (holes) {
      const at = (lon, lat) => {
        let fx = (lon - m.west) / dxd, fy = (m.north - lat) / dyd;
        fx = Math.min(Math.max(fx, 0), nxd - 1.001); fy = Math.min(Math.max(fy, 0), nyd - 1.001);
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        return (wh[y0 * nxd + x0] * (1 - tx) + wh[y0 * nxd + x0 + 1] * tx) * (1 - ty) + (wh[(y0 + 1) * nxd + x0] * (1 - tx) + wh[(y0 + 1) * nxd + x0 + 1] * tx) * ty;
      };
      for (let j = 0; j < m.ny; j++) for (let i = 0; i < m.nx; i++) { const k = j * m.nx + i; if (grid[k] !== grid[k]) grid[k] = at(m.west + i * m.dlon, m.north - j * m.dlat); }
    }
    const dgrid = new Float32Array(nxd * nyd), tmp = new PatchTerrainProvider(base, Object.assign({}, m, { grid, dxd, dyd, nxd, nyd, dgrid }));
    for (let k = 0; k < dgrid.length; k++) dgrid[k] = wh[k] - tmp._grid(m.west + (k % nxd) * dxd, m.north - Math.floor(k / nxd) * dyd);
    const tp = new PatchTerrainProvider(base, Object.assign({}, m, { grid, dgrid, dxd, dyd, nxd, nyd }));
    viewer.terrainProvider = tp;
    return tp;
  }
  /** Take every patch off, back to the original terrain. */
  function uninstallAll(viewer) {
    let tp = viewer.terrainProvider, changed = false;
    while (tp instanceof PatchTerrainProvider) { tp = tp._base; changed = true; }
    if (changed) viewer.terrainProvider = tp;
    return changed;
  }
  const uninstall = uninstallAll;
  window._terrainPatch = { install, uninstall, uninstallAll, parse, pack, PatchTerrainProvider };
})();
