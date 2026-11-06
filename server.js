const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { exec } = require('child_process');
const os = require('os');

// Proxied requests (map tiles and the like) give up after this long.
const PROXY_TIMEOUT_MS = 20000;

const settings = require('./settings');
const library = require('./library');
const caltopoApi = require('./caltopo_api');
const mine = require('./mine');                 // My data: the Recent list and survey cache once moved in   // private CalTopo maps (signed requests; key in user_files)

// ── CalTopo session cookie (stored in memory + persisted to file) ─────────────
const COOKIE_FILE = path.join(__dirname, '.caltopo_session');
let caltopoSessionCookie = _loadPersistedCookie();

function _loadPersistedCookie() {
    try {
        const data = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
        if (data) {
            console.log('[caltopo] Loaded persisted session cookie from file');
            return data;
        }
    } catch (e) {
        // File doesn't exist or can't be read — that's fine
    }
    return null;
}

function _persistCookie(cookie) {
    try {
        if (cookie) {
            fs.writeFileSync(COOKIE_FILE, cookie, 'utf8');
        } else {
            fs.unlinkSync(COOKIE_FILE);
        }
    } catch (e) {
        console.warn('[caltopo] Could not persist cookie to file:', e.message);
    }
}

// ── Helper: send a JSON response with CORS headers ───────────────────────────
function jsonResponse(res, data, status = 200) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const sanitizedPath = sanitizePath(parsedUrl.pathname);

    console.log(`Request: ${req.method} ${parsedUrl.pathname} -> ${sanitizedPath}`);

    if (sanitizedPath === '/caltopo/login' && req.method === 'POST') {
        handleCaltopoLogin(req, res);
    } else if (sanitizedPath === '/caltopo/logout' && req.method === 'POST') {
        caltopoSessionCookie = null;
        _persistCookie(null);
        console.log('[caltopo] Session cleared');
        jsonResponse(res, { ok: true });
    } else if (sanitizedPath === '/caltopo/status' && req.method === 'GET') {
        jsonResponse(res, { loggedIn: !!caltopoSessionCookie });
    // ── Update endpoints ──────────────────────────────────────────────────────
    } else if (sanitizedPath === '/api/updates/check' && req.method === 'GET') {
        handleUpdatesCheck(req, res);
    } else if (sanitizedPath === '/api/updates/apply' && req.method === 'POST') {
        handleUpdatesApply(req, res);
    // ── Recents (EPT + PLT) ───────────────────────────────────────────────────
    // (served from My data once it exists — mine.js; the old files until then)
    } else if (sanitizedPath === '/api/recents' && (req.method === 'GET' || req.method === 'POST')) {
        mine.handleRecents(req, res).then(done => { if (!done) (req.method === 'GET' ? handleRecentsGet : handleRecentsPost)(req, res); });
    } else if (sanitizedPath === '/api/plt-cache' && (req.method === 'GET' || req.method === 'POST')) {
        mine.handlePltCache(req, res, parsedUrl.query).then(done => { if (!done) (req.method === 'GET' ? handlePltCacheGet : handlePltCachePost)(req, res); });
    } else if (sanitizedPath === '/api/declination' && req.method === 'GET') {
        handleDeclinationLocal(req, res);
    } else if (sanitizedPath === '/api/entwine/config' && req.method === 'GET') {
        handleEntwineConfigGet(req, res);
    } else if (sanitizedPath === '/api/entwine/config' && req.method === 'POST') {
        handleEntwineConfigPost(req, res);
    } else if (sanitizedPath === '/api/entwine/datasets' && req.method === 'GET') {
        handleEntwineDatasets(req, res);
    } else if (sanitizedPath === '/api/entwine/status' && req.method === 'GET') {
        handleEntwineStatus(req, res);
    } else if (sanitizedPath === '/api/entwine/start' && req.method === 'POST') {
        handleEntwineStart(req, res);
    } else if (sanitizedPath === '/api/entwine/stop' && req.method === 'POST') {
        handleEntwineStop(req, res);
    } else if (sanitizedPath === '/api/export/terrain' && req.method === 'POST') {
        handleExportTerrain(req, res);
    } else if (sanitizedPath === '/api/export/docs-info' && req.method === 'GET') {
        // How many documents and page images "Include documents" would carry (export_docs.js)
        try {
            const q = parsedUrl.query || {};
            const pid = String(q.project || '');
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(pid)) return jsonResponse(res, { ok: true, docs: 0, pages: 0, bytes: 0 });
            const caves = q.caves ? String(q.caves).split(',').filter(c => /^[A-Za-z0-9_-]{1,64}$/.test(c)) : null;
            const c = require('./export_docs').collect(library, pid, caves);
            jsonResponse(res, { ok: true, docs: c.docs, pages: c.pages.length, bytes: c.bytes, skipped: c.skipped });
        } catch (e) { jsonResponse(res, { ok: false, error: String(e.message || e) }, 500); }
    } else if (sanitizedPath.startsWith('/api/export/status/') && req.method === 'GET') {
        handleExportStatus(req, res, sanitizedPath.slice('/api/export/status/'.length));
    } else if (sanitizedPath.startsWith('/api/export/download/') && req.method === 'GET') {
        handleExportDownload(req, res, sanitizedPath.slice('/api/export/download/'.length));
    // ── A project's own terrain + hillshade from the LiDAR (terrain_generate.js) ──
    } else if (sanitizedPath.startsWith('/api/terrain/')) {
        terrainGen.handle(req, res, sanitizedPath.slice('/api/terrain/'.length), parsedUrl.query);
    // ── The Jobs panel: running and recent server jobs, their log, Cancel (jobs_api.js) ──
    } else if (sanitizedPath === '/api/jobs' || sanitizedPath.startsWith('/api/jobs/')) {
        if (!jobsApi.handle(req, res, sanitizedPath.slice('/api/jobs'.length).replace(/^\//, ''))) jsonResponse(res, { ok: false, error: 'not found' }, 404);
    // ── LiDAR derivations (vegetation density, voids) ────────────────────────
    } else if (sanitizedPath === '/api/lidar/derive' && req.method === 'POST') {
        handleLidarDerive(req, res);
    } else if (sanitizedPath.startsWith('/api/lidar/status/') && req.method === 'GET') {
        handleLidarStatus(req, res, sanitizedPath.slice('/api/lidar/status/'.length));
    } else if (sanitizedPath.startsWith('/api/lidar/result/') && req.method === 'GET') {
        handleLidarResult(req, res, sanitizedPath.slice('/api/lidar/result/'.length));
    // ── Project library (notes, leads, documents; library.js) ────────────────
    } else if (sanitizedPath.startsWith('/api/caltopo/')) {
        caltopoApi.handle(req, res, sanitizedPath.slice('/api/caltopo/'.length), parsedUrl.query);
    } else if (sanitizedPath.startsWith('/api/mine/')) {
        mine.handle(req, res, sanitizedPath.slice('/api/mine/'.length), parsedUrl.query);
    } else if (sanitizedPath.startsWith('/api/lib/')) {
        library.handle(req, res, sanitizedPath.slice('/api/lib/'.length), parsedUrl.query);
    // ── CORS preflight ────────────────────────────────────────────────────────
    } else if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
    // ── Existing proxy + static file routes ───────────────────────────────────
    } else if (sanitizedPath === '/ot-wms') {
        // Dedicated OpenTopography WMS proxy.  Cesium appends WMS parameters
        // directly to the URL, so we just forward the query string as-is.
        const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
        const targetUrl = 'https://portal2.opentopography.org/geoserver/OPENTOPO/wms' + qs;
        handleProxyRequest(req, res, targetUrl);
    } else if (sanitizedPath === '/proxy') {
        // Extract the target URL from the query string.  The url= value
        // may itself contain & characters so we cannot rely on standard
        // query-string parsing.  Instead, take everything after "url=".
        const rawQuery = parsedUrl.query.url
            || (req.url.includes('?url=') ? decodeURIComponent(req.url.split('?url=')[1]) : null);
        handleProxyRequest(req, res, rawQuery);
    } else {
        handleFileRequest(req, res, sanitizedPath);
    }
});

server.listen(settings.server.port, settings.server.address, () => {
    console.log(`Server is listening on http://${settings.server.address}:${settings.server.port}`);
});


function sanitizePath(urlPath) {
    // Decode the URL path
    const decodedPath = decodeURIComponent(urlPath);
    // Join it with the base directory
    const fullPath = path.join(__dirname, decodedPath);

    // Check if the resolved path begins with the base directory
    if (fullPath.startsWith(__dirname)) {
        return decodedPath; // Return the safe path
    }

    // Return the safe default if path is not valid
    return '/';
}

function handleFileRequest(req, res, sanitizedPath) {
    const filePath = path.join(__dirname, sanitizedPath === '/' ? 'index.html' : sanitizedPath);

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
            return;
        }

        // no-cache = "check with the server before reusing": without it the browser kept old
        // copies of index.html and the scripts after a git pull (e.g. a removed panel still
        // showing). An ETag (size + modification time to the millisecond) makes the check cheap and
        // exact: an unchanged file answers 304. (Not Last-Modified: whole seconds miss two saves
        // within one second, and a changed file was then answered "not modified".)
        const etag = '"' + stats.size.toString(36) + '-' + Math.round(stats.mtimeMs).toString(36) + '"';
        const head = { 'Content-Type': getContentType(filePath), 'Cache-Control': 'no-cache', 'ETag': etag };
        // The offline-cache worker lives in client/src/ but covers the whole app (scope "/").
        if (sanitizedPath === '/client/src/sw.js') head['Service-Worker-Allowed'] = '/';
        if ((req.headers['if-none-match'] || '').split(/\s*,\s*/).includes(etag)) {
            res.writeHead(304, { 'Cache-Control': 'no-cache', 'ETag': etag });
            res.end();
            return;
        }
        res.writeHead(200, head);
        fs.createReadStream(filePath).pipe(res);
    });
}

// ── CalTopo login handler ─────────────────────────────────────────────────────

function handleCaltopoLogin(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        try {
            const { cookie } = JSON.parse(body);
            if (!cookie) {
                jsonResponse(res, { ok: false, error: 'Missing cookie field' }, 400);
                return;
            }
            caltopoSessionCookie = cookie;
            _persistCookie(cookie);
            console.log('[caltopo] Session cookie stored');
            jsonResponse(res, { ok: true });
        } catch (e) {
            jsonResponse(res, { ok: false, error: 'Invalid JSON' }, 400);
        }
    });
}

function handleProxyRequest(req, res, targetUrl) {
    if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: Missing target URL');
        return;
    }

    const parsedTargetUrl = url.parse(targetUrl);

    if (!isWhitelisted(parsedTargetUrl.hostname)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: Domain not whitelisted');
        return;
    }

    // Only forward safe headers — drop origin, referer, cookie, and
    // connection-management headers that can confuse the upstream server
    // or cause the proxy to hang on keep-alive mismatches.
    const forwardHeaders = { host: parsedTargetUrl.hostname };
    const skipHeaders = new Set([
        'host', 'origin', 'referer', 'cookie', 'connection',
        'upgrade', 'proxy-connection', 'keep-alive',
        'transfer-encoding', 'te'
    ]);
    for (const [key, value] of Object.entries(req.headers)) {
        if (!skipHeaders.has(key.toLowerCase())) {
            forwardHeaders[key] = value;
        }
    }

    // Inject CalTopo session cookie + origin/referer when proxying caltopo.com
    if (parsedTargetUrl.hostname === 'caltopo.com') {
        if (caltopoSessionCookie) forwardHeaders['cookie'] = caltopoSessionCookie;
        forwardHeaders['origin'] = 'https://caltopo.com';
        forwardHeaders['referer'] = 'https://caltopo.com/';
    }

    // USGS services block headless requests — inject a browser-like User-Agent and Referer.
    // Do NOT inject Origin: ArcGIS servers reject requests where Origin looks spoofed.
    if (parsedTargetUrl.hostname && parsedTargetUrl.hostname.endsWith('.usgs.gov')) {
        forwardHeaders['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
        forwardHeaders['referer'] = 'https://ngmdb.usgs.gov/mapview/';
        forwardHeaders['accept'] = 'image/webp,image/apng,image/*,*/*;q=0.8';
        forwardHeaders['accept-language'] = 'en-US,en;q=0.9';
        forwardHeaders['accept-encoding'] = 'gzip, deflate, br';
        forwardHeaders['sec-fetch-site'] = 'same-origin';
        forwardHeaders['sec-fetch-mode'] = 'no-cors';
        forwardHeaders['sec-fetch-dest'] = 'image';
        delete forwardHeaders['origin'];
    }

    const options = {
        hostname: parsedTargetUrl.hostname,
        port: parsedTargetUrl.port || (parsedTargetUrl.protocol === 'https:' ? 443 : 80),
        path: parsedTargetUrl.path,
        method: req.method,
        headers: forwardHeaders
    };

    const proxyReq = (parsedTargetUrl.protocol === 'https:' ? https : http).request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, {
            ...proxyRes.headers,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        if (proxyRes.statusCode === 403) {
            // Collect body so we can log the ArcGIS error reason
            let body = '';
            proxyRes.on('data', chunk => { body += chunk; res.write(chunk); });
            proxyRes.on('end', () => {
                console.error('[proxy 403]', parsedTargetUrl.hostname, parsedTargetUrl.path.slice(0, 80));
                console.error('[proxy 403 body]', body.slice(0, 400));
                res.end();
            });
        } else {
            proxyRes.pipe(res);
        }
    });

    // An upstream that never answers would leave the browser's request open
    // for good. For a map tile that is worse than a failure: while every shown
    // layer is still waiting on its first tile, Cesium draws no globe at all.
    // So give up after a while and answer 504; Cesium then treats the tile as
    // failed and carries on.
    proxyReq.setTimeout(PROXY_TIMEOUT_MS, () => {
        proxyReq.destroy(Object.assign(new Error(`no answer in ${PROXY_TIMEOUT_MS / 1000} s`), { code: 'ETIMEDOUT' }));
    });

    proxyReq.on('error', (error) => {
        const timedOut = error && error.code === 'ETIMEDOUT';
        console.error(timedOut ? '[proxy timeout]' : 'Proxy error:', timedOut ? parsedTargetUrl.hostname + ' ' + parsedTargetUrl.path.slice(0, 80) : error);
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(timedOut ? 504 : 500, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(timedOut ? 'Upstream timeout' : 'Internal Server Error');
    });

    req.pipe(proxyReq);
}


function isWhitelisted(hostname) {
    return settings.proxy.whitelist.some(entry => {
        if (entry instanceof RegExp) {
            return entry.test(hostname);
        }
        return entry === hostname;
    });
}

function getContentType(filePath) {
    const ext = path.extname(filePath);
    if (ext === '.html') return 'text/html';
    if (ext === '.js') return 'application/javascript';
    if (ext === '.css') return 'text/css';
    if (ext === '.json') return 'application/json';
    if (ext === '.txt') return 'text/plain';
    // Add more content types as needed
    return 'application/octet-stream'; // Default
}

// ── PLT cache handlers ───────────────────────────────────────────────────────

// ── WMM2025 Local Magnetic Declination Calculator ───────────────────────────
// Uses the World Magnetic Model 2025 (epoch 2025.0, valid 2025-2030) computed
// locally — no external API calls, no CORS issues, always works offline.
// GET /api/declination?lat=XX&lon=YY&year=YYYY (year optional, defaults to now)

function wmmDeclination(latDeg, lonDeg, altM, yearDecimal) {
  const COF = [
    [1,0,-29351.8,0.0,12.0,0.0],[1,1,-1410.8,4545.4,9.7,-21.5],[2,0,-2556.6,0.0,-11.6,0.0],[2,1,2951.1,-3133.6,-5.2,-27.7],
    [2,2,1649.3,-815.1,-8.0,-12.1],[3,0,1361.0,0.0,-1.3,0.0],[3,1,-2404.1,-56.6,-4.2,4.0],[3,2,1243.8,237.5,0.4,-0.3],
    [3,3,453.6,-549.5,-15.6,-4.1],[4,0,895.0,0.0,-1.6,0.0],[4,1,799.5,278.6,-2.4,-1.1],[4,2,55.7,-133.9,-6.0,4.1],
    [4,3,-281.1,212.0,5.6,1.6],[4,4,12.1,-375.6,-7.0,-4.4],[5,0,-233.2,0.0,0.6,0.0],[5,1,368.9,45.4,1.4,-0.5],
    [5,2,187.2,220.2,0.0,2.2],[5,3,-138.7,-122.9,0.6,0.4],[5,4,-142.0,43.0,2.2,1.7],[5,5,20.9,106.1,0.9,1.9],
    [6,0,64.4,0.0,-0.2,0.0],[6,1,63.8,-18.4,-0.4,0.3],[6,2,76.9,16.8,0.9,-1.6],[6,3,-115.7,48.8,1.2,-0.4],
    [6,4,-40.9,-59.8,-0.9,0.9],[6,5,14.9,10.9,0.3,0.7],[6,6,-60.7,72.7,0.9,0.9],[7,0,79.5,0.0,-0.0,0.0],[7,1,-77.0,-48.9,-0.1,0.6],
    [7,2,-8.8,-14.4,-0.1,0.5],[7,3,59.3,-1.0,0.5,-0.8],[7,4,15.8,23.4,-0.1,0.0],[7,5,2.5,-7.4,-0.8,-1.0],[7,6,-11.1,-25.1,-0.8,0.6],
    [7,7,14.2,-2.3,0.8,-0.2],[8,0,23.2,0.0,-0.1,0.0],[8,1,10.8,7.1,0.2,-0.2],[8,2,-17.5,-12.6,0.0,0.5],[8,3,2.0,11.4,0.5,-0.4],
    [8,4,-21.7,-9.7,-0.1,0.4],[8,5,16.9,12.7,0.3,-0.5],[8,6,15.0,0.7,0.2,-0.6],[8,7,-16.8,-5.2,-0.0,0.3],[8,8,0.9,3.9,0.2,0.2],
    [9,0,4.6,0.0,-0.0,0.0],[9,1,7.8,-24.8,-0.1,-0.3],[9,2,3.0,12.2,0.1,0.3],[9,3,-0.2,8.3,0.3,-0.3],[9,4,-2.5,-3.3,-0.3,0.3],
    [9,5,-13.1,-5.2,0.0,0.2],[9,6,2.4,7.2,0.3,-0.1],[9,7,8.6,-0.6,-0.1,-0.2],[9,8,-8.7,0.8,0.1,0.4],[9,9,-12.9,10.0,-0.1,0.1],
    [10,0,-1.3,0.0,0.1,0.0],[10,1,-6.4,3.3,0.0,0.0],[10,2,0.2,0.0,0.1,-0.0],[10,3,2.0,2.4,0.1,-0.2],[10,4,-1.0,5.3,-0.0,0.1],
    [10,5,-0.6,-9.1,-0.3,-0.1],[10,6,-0.9,0.4,0.0,0.1],[10,7,1.5,-4.2,-0.1,0.0],[10,8,0.9,-3.8,-0.1,-0.1],
    [10,9,-2.7,0.9,-0.0,0.2],[10,10,-3.9,-9.1,-0.0,-0.0],[11,0,2.9,0.0,0.0,0.0],[11,1,-1.5,0.0,-0.0,-0.0],
    [11,2,-2.5,2.9,0.0,0.1],[11,3,2.4,-0.6,0.0,-0.0],[11,4,-0.6,0.2,0.0,0.1],[11,5,-0.1,0.5,-0.1,-0.0],[11,6,-0.6,-0.3,0.0,-0.0],
    [11,7,-0.1,-1.2,-0.0,0.1],[11,8,1.1,-1.7,-0.1,-0.0],[11,9,-1.0,-2.9,-0.1,0.0],[11,10,-0.2,-1.8,-0.1,0.0],
    [11,11,2.6,-2.3,-0.1,0.0],[12,0,-2.0,0.0,0.0,0.0],[12,1,-0.2,-1.3,0.0,-0.0],[12,2,0.3,0.7,-0.0,0.0],[12,3,1.2,1.0,-0.0,-0.1],
    [12,4,-1.3,-1.4,-0.0,0.1],[12,5,0.6,-0.0,-0.0,-0.0],[12,6,0.6,0.6,0.1,-0.0],[12,7,0.5,-0.1,-0.0,-0.0],
    [12,8,-0.1,0.8,0.0,0.0],[12,9,-0.4,0.1,0.0,-0.0],[12,10,-0.2,-1.0,-0.1,-0.0],[12,11,-1.3,0.1,-0.0,0.0],
    [12,12,-0.7,0.2,-0.1,-0.1],
  ];
  const EPOCH = 2025.0, NMAX = 12, A = 6371.2, D2R = Math.PI / 180;
  const dt = (yearDecimal || EPOCH) - EPOCH;
  const G = [], H = [];
  for (let n = 0; n <= NMAX; n++) { G.push(new Float64Array(NMAX + 1)); H.push(new Float64Array(NMAX + 1)); }
  for (const [n, m, g, h, gd, hd] of COF) { G[n][m] = g + gd * dt; H[n][m] = h + hd * dt; }

  // Geodetic (WGS84) to geocentric spherical.
  const a = 6378.137, f = 1 / 298.257223563, e2 = f * (2 - f);
  const phi = latDeg * D2R, lam = lonDeg * D2R, hKm = (altM || 0) / 1000;
  const sP = Math.sin(phi), cP = Math.cos(phi);
  const Rc = a / Math.sqrt(1 - e2 * sP * sP);
  const p = (Rc + hKm) * cP, z = (Rc * (1 - e2) + hKm) * sP;
  const r = Math.hypot(p, z);
  const latC = Math.asin(z / r);                       // geocentric latitude
  const CT = Math.sin(latC), ST = Math.cos(latC);      // cos/sin of colatitude

  // Schmidt semi-normalised associated Legendre functions and d/dtheta.
  const P = [], DP = [];
  for (let n = 0; n <= NMAX; n++) { P.push(new Float64Array(NMAX + 1)); DP.push(new Float64Array(NMAX + 1)); }
  P[0][0] = 1;
  for (let n = 1; n <= NMAX; n++) {
    for (let m = 0; m <= n; m++) {
      if (n === m) {
        const k = n === 1 ? 1 : Math.sqrt((2 * n - 1) / (2 * n));
        P[n][n] = k * ST * P[n - 1][n - 1];
        DP[n][n] = k * (CT * P[n - 1][n - 1] + ST * DP[n - 1][n - 1]);
      } else {
        const d = Math.sqrt(n * n - m * m);
        const k2 = n >= 2 ? Math.sqrt((n - 1) * (n - 1) - m * m) : 0;
        const p2 = n >= 2 ? P[n - 2][m] : 0, dp2 = n >= 2 ? DP[n - 2][m] : 0;
        P[n][m] = ((2 * n - 1) * CT * P[n - 1][m] - k2 * p2) / d;
        DP[n][m] = ((2 * n - 1) * (CT * DP[n - 1][m] - ST * P[n - 1][m]) - k2 * dp2) / d;
      }
    }
  }

  // Field in the geocentric frame: X' north, Y' east, Z' down.
  let Xp = 0, Yp = 0, Zp = 0;
  for (let n = 1; n <= NMAX; n++) {
    const ar = Math.pow(A / r, n + 2);
    for (let m = 0; m <= n; m++) {
      const cm = Math.cos(m * lam), sm = Math.sin(m * lam);
      const gh = G[n][m] * cm + H[n][m] * sm;
      Xp += ar * gh * DP[n][m];
      Yp += ar * m * (G[n][m] * sm - H[n][m] * cm) * P[n][m];
      Zp -= ar * (n + 1) * gh * P[n][m];
    }
  }
  Yp = ST > 1e-9 ? Yp / ST : 0;
  // Rotate to the geodetic frame (Z doesn't affect D except through X).
  const psi = latC - phi;
  const X = Xp * Math.cos(psi) - Zp * Math.sin(psi);
  return Math.atan2(Yp, X) / D2R;
}

function handleDeclinationLocal(req, res) {
    try {
        const parsedUrl = require('url').parse('http://x' + req.url, true);
        const lat  = parseFloat(parsedUrl.query.lat);
        const lon  = parseFloat(parsedUrl.query.lon);
        const year = parsedUrl.query.year ? parseFloat(parsedUrl.query.year) : new Date().getFullYear();
        if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 360) {
            jsonResponse(res, { error: 'Missing or invalid lat/lon' }, 400);
            return;
        }
        const decl = wmmDeclination(lat, lon, 0, year);
        jsonResponse(res, { declination: parseFloat(decl.toFixed(4)), year, source: 'WMM2025 (local)' });
    } catch (e) {
        jsonResponse(res, { error: 'WMM computation failed: ' + e.message }, 500);
    }
}

// Stores each PLT file as user_files/plt_cache/<name>.plt so recents can
// reload surveys without requiring the user to re-pick the file.

const PLT_CACHE_DIR = path.join(__dirname, 'user_files', 'plt_cache');

function _safePltName(name) {
    // Strip path separators and keep only safe characters
    return name.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 200);
}

function handlePltCacheGet(req, res) {
    const parsedUrl = require('url').parse(require('url').resolve('http://x', req.url), true);
    const name = parsedUrl.query.name;
    if (!name) { res.writeHead(400); res.end('Missing name'); return; }
    const filePath = path.join(PLT_CACHE_DIR, _safePltName(name) + '.plt');
    try {
        if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        fs.createReadStream(filePath).pipe(res);
    } catch(e) {
        console.warn('[plt-cache] read error:', e.message);
        res.writeHead(500); res.end('Error');
    }
}

function handlePltCachePost(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        try {
            const { name, text } = JSON.parse(body);
            if (!name || !text) { jsonResponse(res, { ok: false, error: 'Missing name or text' }, 400); return; }
            if (!fs.existsSync(PLT_CACHE_DIR)) fs.mkdirSync(PLT_CACHE_DIR, { recursive: true });
            const filePath = path.join(PLT_CACHE_DIR, _safePltName(name) + '.plt');
            fs.writeFileSync(filePath, text, 'utf8');
            console.log('[plt-cache] saved', filePath);
            jsonResponse(res, { ok: true });
        } catch(e) {
            console.warn('[plt-cache] write error:', e.message);
            jsonResponse(res, { ok: false, error: e.message }, 400);
        }
    });
}


// ── Local Entwine server integration ─────────────────────────────────────────

const ENTWINE_CONFIG_FILE = path.join(__dirname, 'user_files', 'entwine_config.json');

function _loadEntwineConfig() {
    try {
        if (fs.existsSync(ENTWINE_CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(ENTWINE_CONFIG_FILE, 'utf8'));
        }
    } catch(e) { /* ignore */ }
    return null;
}

function handleEntwineConfigGet(req, res) {
    const cfg = _loadEntwineConfig();
    jsonResponse(res, cfg || { linked: false });
}

function handleEntwineConfigPost(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            if (!fs.existsSync(path.dirname(ENTWINE_CONFIG_FILE))) {
                fs.mkdirSync(path.dirname(ENTWINE_CONFIG_FILE), { recursive: true });
            }
            fs.writeFileSync(ENTWINE_CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
            console.log('[entwine] config saved:', JSON.stringify(data));
            jsonResponse(res, { ok: true });
        } catch(e) {
            jsonResponse(res, { ok: false, error: e.message }, 400);
        }
    });
}

function handleEntwineDatasets(req, res) {
    const cfg = _loadEntwineConfig();
    if (!cfg || !cfg.path) {
        jsonResponse(res, { ok: false, error: 'No entwine path configured' }, 400);
        return;
    }
    const dir = cfg.path.replace(/^~/, os.homedir());
    try {
        if (!fs.existsSync(dir)) {
            jsonResponse(res, { ok: false, error: 'Path does not exist: ' + dir }, 404);
            return;
        }
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const datasets = [];
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const eptFile = path.join(dir, e.name, 'ept.json');
            if (fs.existsSync(eptFile)) {
                datasets.push({ name: e.name, url: (cfg.url || '').replace(/\/$/, '') + '/' + e.name });
            }
        }
        jsonResponse(res, { ok: true, datasets });
    } catch(e) {
        jsonResponse(res, { ok: false, error: e.message }, 500);
    }
}

// ── Entwine server process management ────────────────────────────────────────
const { spawn } = require('child_process');
let _entwineProcess = null;
let _entwineLog = [];

function _entwineRunning() { return _entwineProcess && !_entwineProcess.killed; }

function handleEntwineStatus(req, res) {
    const cfg = _loadEntwineConfig();
    if (!cfg || !cfg.url) { jsonResponse(res, { running: false, log: _entwineLog.slice(-10) }); return; }
    const urlObj = new URL(cfg.url);
    const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
    // Use GET so entwine (which may ignore HEAD) still responds
    const opts = { hostname: urlObj.hostname, port: urlObj.port || 80, path: '/', method: 'GET', timeout: 2000 };
    const probe = mod.request(opts, r => {
        r.resume(); // consume body
        jsonResponse(res, { running: true, processOwned: _entwineRunning(), log: _entwineLog.slice(-10) });
    });
    probe.on('error', () => { jsonResponse(res, { running: false, processOwned: _entwineRunning(), log: _entwineLog.slice(-10) }); });
    probe.on('timeout', () => { probe.destroy(); jsonResponse(res, { running: false, processOwned: _entwineRunning(), log: _entwineLog.slice(-10) }); });
    probe.end();
}

function handleEntwineStart(req, res) {
    if (_entwineRunning()) { jsonResponse(res, { ok: true, msg: 'already running' }); return; }
    const cfg = _loadEntwineConfig();
    if (!cfg || !cfg.path) { jsonResponse(res, { ok: false, error: 'Not configured' }, 400); return; }
    const dir = cfg.path.replace(/^~/, os.homedir());
    let port = 8080;
    try { port = parseInt(new URL(cfg.url).port) || 8080; } catch(e) {}
    _entwineLog = [];
    // entwine 3.x removed "serve" — use Node's http to serve the EPT directory as static files
    try {
        const http = require('http');
        const fsNode = require('fs');
        const pathNode = require('path');
        const mimeMap = { '.json':'application/json', '.bin':'application/octet-stream', '.laz':'application/octet-stream', '.gz':'application/octet-stream' };
        const srv = http.createServer((rq, rs) => {
            rs.setHeader('Access-Control-Allow-Origin', '*');
            rs.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
            if (rq.method === 'OPTIONS') { rs.writeHead(204); rs.end(); return; }
            const safePath = pathNode.normalize(rq.url.split('?')[0]);
            const filePath = pathNode.join(dir, safePath);
            if (!filePath.startsWith(pathNode.resolve(dir))) { rs.writeHead(403); rs.end(); return; }
            fsNode.stat(filePath, (err, stat) => {
                if (err || !stat.isFile()) { rs.writeHead(404); rs.end('Not found'); return; }
                const ext = pathNode.extname(filePath).toLowerCase();
                rs.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream', 'Content-Length': stat.size });
                if (rq.method === 'HEAD') { rs.end(); return; }
                fsNode.createReadStream(filePath).pipe(rs);
            });
        });
        srv.listen(port, () => { _entwineLog.push('EPT static server listening on port ' + port); console.log('[ept-srv] listening on', port); });
        srv.on('error', err => { _entwineLog.push('server error: ' + err.message); console.error('[ept-srv]', err.message); });
        _entwineProcess = { killed: false, kill: () => { srv.close(); _entwineProcess.killed = true; _entwineProcess = null; } };
        srv.on('close', () => { if (_entwineProcess) { _entwineProcess.killed = true; _entwineProcess = null; } });
        jsonResponse(res, { ok: true, msg: 'started', port });
    } catch(e) {
        jsonResponse(res, { ok: false, error: e.message }, 500);
    }
}

function handleEntwineStop(req, res) {
    if (!_entwineRunning()) { jsonResponse(res, { ok: true, msg: 'not running' }); return; }
    try { _entwineProcess.kill('SIGTERM'); } catch(e) {}
    jsonResponse(res, { ok: true, msg: 'stopped' });
}

// ── Git update handlers ───────────────────────────────────────────────────────

/**
 * GET /api/updates/check
 * Fetches from origin and reports how many commits behind HEAD is.
 * Response: { ok, behind, currentHash, remoteHash, error? }
 */
function handleUpdatesCheck(req, res) {
    const cwd = __dirname;
    // First fetch — don't fail the response if fetch itself fails (offline)
    exec('git fetch origin', { cwd }, (fetchErr) => {
        if (fetchErr) {
            console.warn('[updates] git fetch failed (offline?):', fetchErr.message);
        }
        // Count commits between HEAD and origin/HEAD
        exec('git rev-list HEAD..origin/HEAD --count', { cwd }, (countErr, countOut) => {
            if (countErr) {
                return jsonResponse(res, { ok: false, error: 'Not a git repo or no remote configured' }, 500);
            }
            const behind = parseInt(countOut.trim(), 10) || 0;
            // Grab the two hashes for display
            exec('git rev-parse --short HEAD', { cwd }, (hashErr, hashOut) => {
                const currentHash = hashErr ? '?' : hashOut.trim();
                exec('git rev-parse --short origin/HEAD', { cwd }, (rhashErr, rhashOut) => {
                    const remoteHash = rhashErr ? '?' : rhashOut.trim();
                    jsonResponse(res, { ok: true, behind, currentHash, remoteHash });
                });
            });
        });
    });
}

/**
 * POST /api/updates/apply
 * Runs `git pull --ff-only` and returns the output.
 * Response: { ok, output, error? }
 */
function handleUpdatesApply(req, res) {
    const cwd = __dirname;
    exec('git pull --ff-only', { cwd }, (err, stdout, stderr) => {
        const output = (stdout + stderr).trim();
        if (err) {
            console.error('[updates] git pull failed:', output);
            return jsonResponse(res, { ok: false, output, error: err.message }, 500);
        }
        console.log('[updates] git pull succeeded:', output);
        jsonResponse(res, { ok: true, output });
    });
}

// ── Recents handlers ──────────────────────────────────────────────────────────

const RECENTS_FILE = path.join(__dirname, 'user_files', 'recents.json');

function handleRecentsGet(req, res) {
    try {
        if (fs.existsSync(RECENTS_FILE)) {
            const raw = fs.readFileSync(RECENTS_FILE, 'utf8');
            jsonResponse(res, JSON.parse(raw));
        } else {
            jsonResponse(res, { ept: [], plt: [] });
        }
    } catch (e) {
        console.warn('[recents] read error:', e.message);
        jsonResponse(res, { ept: [], plt: [] });
    }
}

function handleRecentsPost(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            const dir = path.dirname(RECENTS_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(RECENTS_FILE, JSON.stringify(data, null, 2), 'utf8');
            jsonResponse(res, { ok: true });
        } catch (e) {
            console.warn('[recents] write error:', e.message);
            jsonResponse(res, { ok: false, error: e.message }, 400);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Terrain Export  (/api/export/*)
// ─────────────────────────────────────────────────────────────────────────────

const _exportJobs = {};  // jobId → { status, progress, outPath, error }

// The interpreter that has PDAL. Machine specific, so it is configuration,
// not code: set FLEX_PYTHON to point at your own env. The fallback is a
// stock miniconda layout and keeps no one's home directory in a public repo.
const CONDA_PYTHON = process.env.FLEX_PYTHON || (process.platform === 'win32'
  ? path.join(os.homedir(), 'miniconda3', 'envs', 'entwine', 'python.exe')
  : path.join(os.homedir(), 'miniconda3', 'envs', 'entwine', 'bin', 'python'));
const EXPORT_SCRIPT = path.join(__dirname, 'export_terrain.py');
const EXPORT_OUT_DIR = path.join(__dirname, 'user_files', 'exports');
// The same pipeline run for a project: its DEM as a terrain patch, its hillshade as map tiles.
const terrainGen = require('./terrain_generate')({ python: CONDA_PYTHON, script: EXPORT_SCRIPT, library });

function handleExportTerrain(req, res) {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        let params;
        try { params = JSON.parse(body); } catch(e) {
            return jsonResponse(res, { ok: false, error: 'Invalid JSON' }, 400);
        }
        const {
            bbox,
            eptPath,
            caves,           // JSON object from FLEX (surveys with lon/lat/alt shots)
            resolution        = 1.0,
            max_triangles     = 2000000,
            tex_size          = 16384,
            satellite_source  = 'bing',
            hillshade_mode    = 'lidar',     // 'lidar' | 'url' | 'none'
            hillshade_url     = '',
            name              = '',
            z_offset          = null,        // the point clouds' vertical shift in FLEX (m)
            dem_grid          = null,        // terrain from the map instead of the LiDAR (see below)
            polygon           = null,        // [[lon, lat], ...]: export only inside it (hard cut)
            terrain_patches   = null,        // ['<sha>.bin', ...]: the project's terrain patches, laid over the map terrain
            satellite_layer   = null,        // a map layer as the satellite texture (satellite_source 'layer'): see exportLayerArgs
            hillshade_layer   = null,        // a map layer as the hillshade texture (hillshade_mode 'layer')
            docs_project      = null,        // project id: carry its documents (export_docs.js), with docs_caves = the exported caves' ids
            docs_caves        = null,
        } = params;
        const hsMode  = ['lidar', 'dem', 'url', 'none', 'layer'].includes(hillshade_mode) ? hillshade_mode : 'lidar';
        // Map terrain: heights FLEX sampled from its own 3D terrain on a lon/lat
        // grid, base64 float32 (row 0 = lat0). Then no point cloud is needed.
        let demGrid = null;
        if (dem_grid) {
            const g = dem_grid, nx = g.nx | 0, ny = g.ny | 0;
            const num = v => typeof v === 'number' && Number.isFinite(v);
            if (!(nx >= 2 && ny >= 2 && nx * ny <= 20e6 && [g.lon0, g.lat0, g.dlon, g.dlat, g.cell].every(num)
                  && g.dlon > 0 && g.dlat > 0 && g.cell > 0 && typeof g.heights === 'string'))
                return jsonResponse(res, { ok: false, error: 'dem_grid is malformed' }, 400);
            const bytes = Buffer.from(g.heights, 'base64');
            if (bytes.length !== nx * ny * 4)
                return jsonResponse(res, { ok: false, error: `dem_grid holds ${bytes.length} bytes, expected ${nx * ny * 4}` }, 400);
            demGrid = { bytes, header: { lon0: g.lon0, lat0: g.lat0, dlon: g.dlon, dlat: g.dlat, nx, ny, cell: g.cell } };
        }
        // Free text from the UI goes to the exporter as one argv element (spawn,
        // no shell), so only length and control characters need policing.
        const mapName = String(name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60);
        if (!bbox || bbox.length !== 4) return jsonResponse(res, { ok: false, error: 'bbox required: [minLon,minLat,maxLon,maxLat]' }, 400);
        // Export area polygon: plain numbers only, lon/lat ranges, a sane size.
        let poly = null;
        if (polygon != null) {
            const okPt = p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
                              && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
            if (!Array.isArray(polygon) || polygon.length < 3 || polygon.length > 20000 || !polygon.every(okPt))
                return jsonResponse(res, { ok: false, error: 'polygon must be 3 to 20000 [lon, lat] points' }, 400);
            poly = polygon.map(p => [+p[0], +p[1]]);
        }
        if (!eptPath && !demGrid) return jsonResponse(res, { ok: false, error: 'eptPath is required — select a dataset in the export panel, or take the terrain from the map' }, 400);

        const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        if (!fs.existsSync(EXPORT_OUT_DIR)) fs.mkdirSync(EXPORT_OUT_DIR, { recursive: true });
        const outZip = path.join(EXPORT_OUT_DIR, `export_${jobId}.zip`);
        const ept = eptPath;

        // Download name from the map name: "Cave Ridge" -> FLEX-Cave-Ridge.zip
        const slug = mapName.normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
                            .replace(/[\s_]+/g, '-').slice(0, 48);
        const filename = slug ? `FLEX-${slug}.zip` : `flex_export_${jobId}.zip`;
        _exportJobs[jobId] = { status: 'running', progress: [], outPath: outZip, error: null, filename, name: mapName || 'Offline map', started: Date.now(), ended: null, cancelled: false, proc: null };
        jsonResponse(res, { ok: true, jobId });

        // Write caves JSON to a temp file so Python can read it
        let cavesFilePath = null;
        if (caves && caves.surveys && caves.surveys.length > 0) {
            cavesFilePath = path.join(EXPORT_OUT_DIR, `caves_${jobId}.json`);
            fs.writeFileSync(cavesFilePath, JSON.stringify(caves));
        }

        let polyFile = null;
        if (poly) {
            polyFile = path.join(EXPORT_OUT_DIR, `polygon_${jobId}.json`);
            fs.writeFileSync(polyFile, JSON.stringify(poly));
        }

        // Map terrain grid: the heights and a small header next to them.
        let demFiles = [];
        if (demGrid) {
            const bin = path.join(EXPORT_OUT_DIR, `dem_${jobId}.bin`), hdr = path.join(EXPORT_OUT_DIR, `dem_${jobId}.json`);
            fs.writeFileSync(bin, demGrid.bytes);
            fs.writeFileSync(hdr, JSON.stringify({ ...demGrid.header, file: path.basename(bin) }));
            demFiles = [bin, hdr];
        }

        const args = [
            EXPORT_SCRIPT,
            ...(demGrid ? ['--dem-grid', demFiles[1]] : ['--ept', ept]),
            '--bbox',              ...bbox.map(String),
            '--out',               outZip,
            '--resolution',        String(resolution),
            '--max-triangles',     String(max_triangles),
            '--tex-size',          String(tex_size),
        ];
        // Map layers as textures and the project's terrain patches (terrain_generate.js exportLayerArgs / exportPatchFiles)
        const satArgs = satellite_source === 'layer' ? terrainGen.exportLayerArgs('satellite', satellite_layer, settings.server.port) : null;
        args.push(...(satArgs || ['--satellite-source', satellite_source === 'esri' ? 'esri' : 'bing']));
        const hsLayer = hsMode === 'layer' ? terrainGen.exportLayerArgs('hillshade', hillshade_layer, settings.server.port) : null;
        args.push(...(hsMode === 'layer' ? (hsLayer || ['--hillshade', demGrid ? 'dem' : 'lidar']) : ['--hillshade', (hsMode === 'url' && !hillshade_url) ? 'lidar' : hsMode]));
        if (demGrid) for (const f of terrainGen.exportPatchFiles(terrain_patches)) args.push('--terrain-patch', f);
        if (hsMode === 'url' && hillshade_url) args.push('--hillshade-url', hillshade_url);
        if (mapName) args.push('--name', mapName);
        if (cavesFilePath) args.push('--caves', cavesFilePath);
        if (polyFile) args.push('--polygon', polyFile);
        // The project's documents that belong to these caves: entries + page images
        if (typeof docs_project === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(docs_project)) {
            try {
                const ids = Array.isArray(docs_caves) ? docs_caves.filter(c => typeof c === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(c)) : null;
                const c = require('./export_docs').collect(library, docs_project, ids);
                if (c.entries.length) {
                    const f = path.join(EXPORT_OUT_DIR, `docs_${jobId}.json`);
                    fs.writeFileSync(f, JSON.stringify(c));
                    args.push('--docs', f);
                    _exportJobs[jobId].progress.push(`Documents: ${c.docs} (${c.pages.length} pages, ${(c.bytes / 1048576).toFixed(1)} MB)` +
                        (c.skipped.pdf ? `; ${c.skipped.pdf} PDF page(s) stay in the project` : ''));
                }
            } catch (e) { _exportJobs[jobId].progress.push('⚠ Documents left out: ' + (e.message || e)); }
        }
        if (typeof z_offset === 'number' && Number.isFinite(z_offset) && Math.abs(z_offset) < 200)
            args.push('--z-offset', String(z_offset));

        const proc = spawn(CONDA_PYTHON, args);
        _exportJobs[jobId].proc = proc;
        proc.on('error', e => { _exportJobs[jobId].progress.push(`⚠ Could not start Python (${e.code || e.message})`); });
        proc.stdout.on('data', d => {
            d.toString().split('\n').forEach(line => {
                line = line.trim();
                if (!line) return;
                console.log('[export]', line);
                _exportJobs[jobId].progress.push(line);
            });
        });
        proc.stderr.on('data', d => {
            d.toString().split('\n').forEach(line => {
                line = line.trim();
                if (!line) return;
                console.warn('[export-err]', line);
                _exportJobs[jobId].progress.push('⚠ ' + line);
            });
        });
        proc.on('close', code => {
            // Clean up temp caves and map-terrain files
            for (const f of [cavesFilePath, polyFile, ...demFiles]) {
                if (f && fs.existsSync(f)) { try { fs.unlinkSync(f); } catch(_) {} }
            }
            _exportJobs[jobId].ended = Date.now(); _exportJobs[jobId].proc = null;
            if (code === 0 && fs.existsSync(outZip) && !_exportJobs[jobId].cancelled) {
                _exportJobs[jobId].status = 'done';
                console.log('[export] done:', jobId);
            } else {
                _exportJobs[jobId].status = 'error';
                _exportJobs[jobId].error = _exportJobs[jobId].cancelled ? 'Cancelled' : `Process exited with code ${code}`;
                console.error('[export] failed:', jobId, code);
            }
        });
    });
}

function exportPct(job) {
    // A rough progress % from the last line's step marker
    const lines = job.progress;
    const last = lines[lines.length - 1] || '';
    // Step markers first: "[4/7] Fetching satellite..." also says "Fetching",
    // which the keyword fallbacks would read as step 1.
    const PCT = { '0': 5, '1': 15, '2': 40, '3': 55, '4': 65, '4b': 78, '5': 85, '6': 95, '7': 98 };
    let pct = 5;
    const step = /\[(\d)(b?)\/\d\]/.exec(last);
    if (step && PCT[step[1] + step[2]] !== undefined) pct = PCT[step[1] + step[2]];
    else if (last.includes('Building CSF')) pct = 40;
    else if (last.includes('Triangul')) pct = 55;
    else if (last.includes('Packaging GLB')) pct = 85;
    if (job.status === 'done') pct = 100;
    return pct;
}
function handleExportStatus(req, res, jobId) {
    const job = _exportJobs[jobId];
    if (!job) return jsonResponse(res, { ok: false, error: 'Unknown job' }, 404);
    const last = job.progress[job.progress.length - 1] || '';
    jsonResponse(res, { status: job.status, progress: exportPct(job), message: last, error: job.error,
                        filename: job.filename });
}

function handleExportDownload(req, res, jobId) {
    const job = _exportJobs[jobId];
    if (!job || job.status !== 'done') return jsonResponse(res, { ok: false, error: 'Not ready' }, 404);
    const stat = fs.statSync(job.outPath);
    res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${job.filename || `flex_export_${jobId}.zip`}"`,
        'Content-Length': stat.size,
        'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(job.outPath).pipe(res);
}

// ── LiDAR derivations ────────────────────────────────────────────────────────
// Vegetation density and void rasters from a bbox, via lidar_derive.py. Same
// job shape as the terrain export: POST returns a jobId, the client polls
// status, then fetches the rasters. Kept as its own set of routes rather than
// folded into the export because the intents differ -- one makes a portable
// viewer, the other answers a question about an area.

const _lidarJobs = {};   // jobId -> { status, progress, outDir, error }
const LIDAR_SCRIPT  = path.join(__dirname, 'lidar_derive.py');
const LIDAR_OUT_DIR = path.join(__dirname, 'user_files', 'lidar');
// Running and recent jobs of the three kinds, for the Jobs panel (jobs_api.js)
const jobsApi = require('./jobs_api')({ sources: {
    export:  { jobs: _exportJobs, pct: exportPct, download: id => '/api/export/download/' + id },
    terrain: { jobs: terrainGen.jobs, pct: terrainGen.pctOf },
    analyze: { jobs: _lidarJobs, pct: lidarPct },
} });

function handleLidarDerive(req, res) {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        let params;
        try { params = JSON.parse(body); } catch (e) {
            return jsonResponse(res, { ok: false, error: 'Invalid JSON' }, 400);
        }
        const {
            bbox,
            eptPath,
            cell            = null,      // null => chosen from data density
            veg_band        = [0.30, 1.50],
            void_depth      = -1.0,
            void_min_points = 3,
            // Garbage removal only. Generous on purpose: real voids live below
            // ground and must survive. Never tighten this to "clean up noise".
            low_cut         = -20.0,
            high_cut        = 120.0,
            stat            = 'median',
        } = params;

        if (!bbox || bbox.length !== 4)
            return jsonResponse(res, { ok: false, error: 'bbox required: [minLon,minLat,maxLon,maxLat]' }, 400);
        if (!eptPath)
            return jsonResponse(res, { ok: false, error: 'eptPath is required — select a loaded dataset' }, 400);

        const jobId  = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const outDir = path.join(LIDAR_OUT_DIR, jobId);
        fs.mkdirSync(outDir, { recursive: true });

        _lidarJobs[jobId] = { status: 'running', progress: [], outDir, error: null, errLines: [], name: 'Analyze: vegetation and voids', started: Date.now(), ended: null, cancelled: false, proc: null };
        jsonResponse(res, { ok: true, jobId });

        const args = [
            LIDAR_SCRIPT,
            '--ept',             eptPath,
            '--bbox',            ...bbox.map(String),
            '--out-dir',         outDir,
            '--veg-band',        String(veg_band[0]), String(veg_band[1]),
            '--void-depth',      String(void_depth),
            '--void-min-points', String(void_min_points),
            '--low-cut',         String(low_cut),
            '--high-cut',        String(high_cut),
            '--stat',            stat,
        ];
        if (cell) args.push('--cell', String(cell));

        const proc = spawn(CONDA_PYTHON, args);
        _lidarJobs[jobId].proc = proc;
        proc.stdout.on('data', d => {
            d.toString().split('\n').forEach(line => {
                line = line.trim();
                if (!line) return;
                console.log('[lidar]', line);
                _lidarJobs[jobId].progress.push(line);
            });
        });
        proc.stderr.on('data', d => {
            d.toString().split('\n').forEach(line => {
                line = line.trim();
                if (!line) return;
                console.warn('[lidar-err]', line);
                _lidarJobs[jobId].progress.push('! ' + line);
                _lidarJobs[jobId].errLines.push(line);
            });
        });
        // Python could not even start (wrong FLEX_PYTHON): say so, not "code null".
        proc.on('error', e => { _lidarJobs[jobId].errLines.push(`Could not start Python (${e.code || e.message})`); });
        proc.on('close', code => {
            const job = _lidarJobs[jobId];
            const ok = code === 0 && fs.existsSync(path.join(outDir, 'derived.json')) && !job.cancelled;
            job.status = ok ? 'done' : 'error'; job.ended = Date.now(); job.proc = null;
            try { fs.writeFileSync(path.join(outDir, 'log.txt'), job.progress.join('\n') + '\n'); } catch (_) {}   // the whole output, for the Jobs panel's Log
            if (!ok && job.cancelled) { job.error = 'Cancelled'; try { fs.appendFileSync(path.join(outDir, 'log.txt'), 'CANCELLED\n'); } catch (_) {} }
            else if (!ok) {
                // The reason, for the panel: the last lines the script wrote on stderr
                // (its own "ERROR: ..." line comes last), kept in log.txt too.
                const lines = _lidarJobs[jobId].errLines.filter(l => !/^\s*File "|^\s+\S/.test(l));
                const why = (lines.length ? lines : _lidarJobs[jobId].errLines).slice(-3).join(' | ');
                _lidarJobs[jobId].error = (why || 'Nothing was written') + ` (exit ${code})`;
                try { fs.appendFileSync(path.join(outDir, 'log.txt'), 'FAILED: ' + _lidarJobs[jobId].error + '\n'); } catch (_) {}
            }
            console.log('[lidar]', ok ? 'done: ' + jobId : 'failed: ' + jobId + ' (' + code + ')');
        });
    });
}

function lidarPct(job) {
    const lines = job.progress;
    const last  = lines[lines.length - 1] || '';
    let pct = 5;
    if      (last.includes('[1/')) pct = 10;
    else if (last.includes('[2/')) pct = 35;
    else if (last.includes('[3/')) pct = 75;
    else if (last.includes('[4/')) pct = 95;
    if (job.status === 'done')  pct = 100;
    if (job.status === 'error') pct = 100;
    return pct;
}
function handleLidarStatus(req, res, jobId) {
    const job = _lidarJobs[jobId];
    if (!job) return jsonResponse(res, { ok: false, error: 'Unknown job' }, 404);
    const last  = job.progress[job.progress.length - 1] || '';
    const pct = lidarPct(job);
    let meta = null;
    if (job.status === 'done') {
        try { meta = JSON.parse(fs.readFileSync(path.join(job.outDir, 'derived.json'), 'utf8')); }
        catch (_) {}
    }
    jsonResponse(res, { status: job.status, progress: pct, message: last,
                        error: job.error, meta });
}

// Serves a file out of a finished job: the PNG overlays, derived.json, or a
// GeoTIFF for download. Path is <jobId>/<filename>, filename whitelisted.
function handleLidarResult(req, res, rest) {
    const parts = rest.split('/');
    const jobId = parts[0];
    const name  = parts.slice(1).join('/');
    const job   = _lidarJobs[jobId];
    if (!job || job.status !== 'done')
        return jsonResponse(res, { ok: false, error: 'Not ready' }, 404);
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.includes('..'))
        return jsonResponse(res, { ok: false, error: 'Bad name' }, 400);

    const file = path.join(job.outDir, name);
    if (!file.startsWith(job.outDir) || !fs.existsSync(file))
        return jsonResponse(res, { ok: false, error: 'Not found' }, 404);

    const ext  = path.extname(name).toLowerCase();
    const type = ext === '.png'  ? 'image/png'
               : ext === '.json' ? 'application/json'
               : ext === '.tif'  ? 'image/tiff'
               : 'application/octet-stream';
    const head = { 'Content-Type': type,
                   'Content-Length': fs.statSync(file).size,
                   'Access-Control-Allow-Origin': '*' };
    if (ext === '.tif') head['Content-Disposition'] = `attachment; filename="${name}"`;
    res.writeHead(200, head);
    fs.createReadStream(file).pipe(res);
}
