const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { exec } = require('child_process');
const os = require('os');

const settings = require('./settings');

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
    } else if (sanitizedPath === '/api/recents' && req.method === 'GET') {
        handleRecentsGet(req, res);
    } else if (sanitizedPath === '/api/recents' && req.method === 'POST') {
        handleRecentsPost(req, res);
    } else if (sanitizedPath === '/api/plt-cache' && req.method === 'GET') {
        handlePltCacheGet(req, res);
    } else if (sanitizedPath === '/api/plt-cache' && req.method === 'POST') {
        handlePltCachePost(req, res);
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
    } else if (sanitizedPath.startsWith('/api/export/status/') && req.method === 'GET') {
        handleExportStatus(req, res, sanitizedPath.slice('/api/export/status/'.length));
    } else if (sanitizedPath.startsWith('/api/export/download/') && req.method === 'GET') {
        handleExportDownload(req, res, sanitizedPath.slice('/api/export/download/'.length));
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

        res.writeHead(200, { 'Content-Type': getContentType(filePath) });
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

    proxyReq.on('error', (error) => {
        console.error('Proxy error:', error);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
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
    // WMM2025 Gauss coefficients [n, m, g(nT), h(nT), gdot(nT/yr), hdot(nT/yr)]
    // Source: NOAA NCEI WMM2025 (released Dec 2024), epoch 2025.0
    const COF = [
        [1,0,-29351.8,0.0,12.5,0.0],[1,1,-1410.8,4545.4,4.9,-20.8],
        [2,0,-2556.6,0.0,-12.5,0.0],[2,1,2951.6,-3133.4,-5.7,-7.4],[2,2,1649.3,-815.1,-0.7,10.4],
        [3,0,1249.2,0.0,0.0,0.0],[3,1,-603.0,-56.2,-1.0,0.3],[3,2,482.0,237.7,-0.2,-0.6],[3,3,-43.5,-547.4,-1.1,0.1],
        [4,0,427.2,0.0,-1.0,0.0],[4,1,-185.8,282.0,0.7,-0.1],[4,2,-88.6,221.8,-2.0,-2.8],[4,3,-88.4,-27.6,0.4,0.5],[4,4,72.3,-198.2,0.7,0.1],
        [5,0,-166.7,0.0,-0.4,0.0],[5,1,-70.1,-28.2,0.1,-0.3],[5,2,-40.1,50.5,0.4,0.0],[5,3,80.5,20.5,0.2,0.6],[5,4,-12.6,80.6,0.0,-0.1],[5,5,-14.6,-25.6,-0.2,0.1],
        [6,0,-23.6,0.0,0.0,0.0],[6,1,73.9,-27.8,-0.3,-0.2],[6,2,118.5,-34.2,0.5,0.7],[6,3,-90.0,31.9,-0.9,0.1],[6,4,0.3,6.2,0.3,-0.1],[6,5,12.9,-13.3,-0.3,-0.2],[6,6,-17.8,-8.3,0.1,0.5],
        [7,0,79.1,0.0,0.1,0.0],[7,1,-48.5,8.3,-0.2,0.1],[7,2,23.5,-15.3,-0.5,0.0],[7,3,-0.6,-1.5,-0.2,0.1],[7,4,-15.7,12.9,0.1,-0.2],[7,5,2.4,-1.6,0.1,0.0],[7,6,7.1,-18.0,0.2,0.1],[7,7,7.6,-11.5,0.0,0.2],
        [8,0,24.9,0.0,0.0,0.0],[8,1,14.4,-7.9,-0.4,0.0],[8,2,-3.3,-7.0,0.0,0.0],[8,3,6.3,1.7,0.1,-0.1],[8,4,-5.0,9.8,0.0,0.1],[8,5,-3.0,0.7,0.0,0.0],[8,6,-1.2,-0.9,0.0,0.0],[8,7,4.3,-9.3,0.0,0.0],[8,8,-1.7,3.4,-0.1,0.0],
        [9,0,5.0,0.0,0.0,0.0],[9,1,-29.1,5.4,0.5,0.0],[9,2,-8.6,-2.4,0.2,0.1],[9,3,6.6,-7.5,-0.2,0.0],[9,4,-4.0,1.2,0.0,0.0],[9,5,0.5,4.8,0.0,0.0],[9,6,1.5,-4.2,0.0,0.0],[9,7,-8.7,-1.3,-0.1,0.0],[9,8,-3.1,0.0,0.0,0.0],[9,9,0.0,-3.1,0.0,0.0],
        [10,0,-0.2,0.0,0.0,0.0],[10,1,4.1,1.7,0.0,0.0],[10,2,1.0,-0.8,0.0,0.0],[10,3,3.3,2.8,0.0,0.0],[10,4,0.0,2.3,0.0,0.0],[10,5,-0.3,-2.7,0.0,0.0],[10,6,0.5,-1.0,0.0,0.0],[10,7,0.2,-2.5,0.0,0.0],[10,8,0.0,0.2,0.0,0.0],[10,9,0.4,-0.1,0.0,0.0],[10,10,-0.7,0.5,0.0,0.0],
        [11,0,-0.2,0.0,0.0,0.0],[11,1,0.0,0.9,0.0,0.0],[11,2,0.1,0.3,0.0,0.0],[11,3,0.7,-0.9,0.0,0.0],[11,4,0.6,0.2,0.0,0.0],[11,5,-0.4,0.8,0.0,0.0],[11,6,-0.4,0.2,0.0,0.0],[11,7,0.2,-0.2,0.0,0.0],[11,8,0.0,0.2,0.0,0.0],[11,9,0.4,-0.3,0.0,0.0],[11,10,0.2,0.1,0.0,0.0],[11,11,-0.1,0.0,0.0,0.0],
        [12,0,0.1,0.0,0.0,0.0],[12,1,0.0,0.1,0.0,0.0],[12,2,-0.2,0.1,0.0,0.0],[12,3,0.5,-0.2,0.0,0.0],[12,4,-0.2,0.1,0.0,0.0],[12,5,0.5,0.2,0.0,0.0],[12,6,0.2,-0.1,0.0,0.0],[12,7,0.1,-0.2,0.0,0.0],[12,8,0.0,0.0,0.0,0.0],[12,9,-0.1,0.1,0.0,0.0],[12,10,0.1,0.0,0.0,0.0],[12,11,0.0,-0.1,0.0,0.0],[12,12,0.0,0.0,0.0,0.0],
    ];
    const EPOCH = 2025.0, NMAX = 12, R0 = 6371.2, D2R = Math.PI / 180;
    const dt = (yearDecimal || EPOCH) - EPOCH;

    // Apply secular variation to get time-adjusted coefficients
    const G = [], H = [];
    for (let i = 0; i <= NMAX+1; i++) { G.push(new Float64Array(NMAX+2)); H.push(new Float64Array(NMAX+2)); }
    for (const [n, m, g, h, gd, hd] of COF) { G[n][m] = g + gd*dt; H[n][m] = h + hd*dt; }

    // WGS84 geodetic -> geocentric spherical
    const a = 6378.137, f = 1/298.257223563, e2 = 2*f - f*f;
    const phi = latDeg * D2R, lam = lonDeg * D2R, altKm = (altM || 0) / 1000;
    const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
    const Nell = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
    const p = (Nell + altKm) * cosPhi;
    const zc = (Nell * (1 - e2) + altKm) * sinPhi;
    const r = Math.sqrt(p*p + zc*zc);
    const theta = Math.acos(zc / r); // geocentric colatitude
    const ST = Math.sin(theta), CT = Math.cos(theta);

    // Schmidt quasi-normal Legendre polynomials P[n][m] and derivatives dP/dtheta
    const P = [], DP = [];
    for (let i = 0; i <= NMAX+1; i++) { P.push(new Float64Array(NMAX+2)); DP.push(new Float64Array(NMAX+2)); }
    P[0][0]=1; DP[0][0]=0; P[1][0]=CT; DP[1][0]=-ST; P[1][1]=ST; DP[1][1]=CT;
    for (let n = 2; n <= NMAX; n++) {
        // m=0: standard Legendre recursion (Schmidt=Legendre for m=0)
        P[n][0]  = ((2*n-1)*CT*P[n-1][0] - (n-1)*P[n-2][0]) / n;
        DP[n][0] = ((2*n-1)*(CT*DP[n-1][0] - ST*P[n-1][0]) - (n-1)*DP[n-2][0]) / n;
        // m=n diagonal
        const c1 = Math.sqrt((2*n-1)/(2*n));
        P[n][n]  = P[n-1][n-1] * ST * c1;
        DP[n][n] = (DP[n-1][n-1]*ST + P[n-1][n-1]*CT) * c1;
        // m=n-1 sub-diagonal
        const c2 = Math.sqrt(2*n-1);
        P[n][n-1]  = P[n-1][n-1] * CT * c2;
        DP[n][n-1] = (-P[n-1][n-1]*ST + DP[n-1][n-1]*CT) * c2;
        // m=n-2 down to 1
        for (let m = n-2; m >= 1; m--) {
            const K1 = Math.sqrt(((2*n-1)*(2*n+1)) / ((n-m)*(n+m)));
            const K2 = Math.sqrt(((2*n+1)*(n+m-1)*(n-m-1)) / ((2*n-3)*(n-m)*(n+m)));
            P[n][m]  = K1*CT*P[n-1][m] - K2*P[n-2][m];
            DP[n][m] = K1*(-ST*P[n-1][m] + CT*DP[n-1][m]) - K2*DP[n-2][m];
        }
    }

    // Sum spherical harmonic field components: B_theta (southward), B_phi (eastward)
    let Btheta = 0, Bphi = 0;
    for (let n = 1; n <= NMAX; n++) {
        const ratio = Math.pow(R0/r, n+2);
        for (let m = 0; m <= n; m++) {
            const gm = G[n][m], hm = H[n][m];
            const cosML = Math.cos(m*lam), sinML = Math.sin(m*lam);
            Btheta -= ratio * DP[n][m] * (gm*cosML + hm*sinML);
            if (ST > 1e-6) Bphi += ratio * P[n][m] * m * (gm*sinML - hm*cosML) / ST;
        }
    }
    // X=northward=-Btheta, Y=eastward=Bphi; Declination=atan2(Y,X)
    return Math.atan2(Bphi, -Btheta) * 180 / Math.PI;
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

const CONDA_PYTHON = 'C:\\Users\\feroz\\miniconda3\\envs\\entwine\\python.exe';
const EXPORT_SCRIPT = path.join(__dirname, 'export_terrain.py');
const EXPORT_OUT_DIR = path.join(__dirname, 'user_files', 'exports');

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
            resolution  = 1.0,
            max_triangles = 500000,
            tex_size    = 2048,
        } = params;
        if (!bbox || bbox.length !== 4) return jsonResponse(res, { ok: false, error: 'bbox required: [minLon,minLat,maxLon,maxLat]' }, 400);

        const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        if (!fs.existsSync(EXPORT_OUT_DIR)) fs.mkdirSync(EXPORT_OUT_DIR, { recursive: true });
        const outZip = path.join(EXPORT_OUT_DIR, `export_${jobId}.zip`);
        const ept = eptPath || path.join(require('os').homedir(), 'entwine', 'marbles', 'ept.json');

        _exportJobs[jobId] = { status: 'running', progress: [], outPath: outZip, error: null };
        jsonResponse(res, { ok: true, jobId });

        // Write caves JSON to a temp file so Python can read it
        let cavesFilePath = null;
        if (caves && caves.surveys && caves.surveys.length > 0) {
            cavesFilePath = path.join(EXPORT_OUT_DIR, `caves_${jobId}.json`);
            fs.writeFileSync(cavesFilePath, JSON.stringify(caves));
        }

        const args = [
            EXPORT_SCRIPT,
            '--ept',           ept,
            '--bbox',          ...bbox.map(String),
            '--out',           outZip,
            '--resolution',    String(resolution),
            '--max-triangles', String(max_triangles),
            '--tex-size',      String(tex_size),
        ];
        if (cavesFilePath) args.push('--caves', cavesFilePath);

        const proc = spawn(CONDA_PYTHON, args);
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
            // Clean up temp caves file
            if (cavesFilePath && fs.existsSync(cavesFilePath)) {
                try { fs.unlinkSync(cavesFilePath); } catch(_) {}
            }
            if (code === 0 && fs.existsSync(outZip)) {
                _exportJobs[jobId].status = 'done';
                console.log('[export] done:', jobId);
            } else {
                _exportJobs[jobId].status = 'error';
                _exportJobs[jobId].error = `Process exited with code ${code}`;
                console.error('[export] failed:', jobId, code);
            }
        });
    });
}

function handleExportStatus(req, res, jobId) {
    const job = _exportJobs[jobId];
    if (!job) return jsonResponse(res, { ok: false, error: 'Unknown job' }, 404);
    // Return last progress line as 'message' and a rough progress % based on step markers
    const lines = job.progress;
    const last = lines[lines.length - 1] || '';
    let pct = 5;
    if      (last.includes('[1/') || last.includes('Fetching')) pct = 15;
    else if (last.includes('[2/') || last.includes('Building CSF')) pct = 40;
    else if (last.includes('[3/') || last.includes('Triangul')) pct = 55;
    else if (last.includes('[4/') || last.includes('satellite')) pct = 70;
    else if (last.includes('[5/') || last.includes('Packaging GLB')) pct = 85;
    else if (last.includes('[6/') || last.includes('Writing')) pct = 95;
    if (job.status === 'done') pct = 100;
    jsonResponse(res, { status: job.status, progress: pct, message: last, error: job.error });
}

function handleExportDownload(req, res, jobId) {
    const job = _exportJobs[jobId];
    if (!job || job.status !== 'done') return jsonResponse(res, { ok: false, error: 'Not ready' }, 404);
    const stat = fs.statSync(job.outPath);
    res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="flex_export_${jobId}.zip"`,
        'Content-Length': stat.size,
        'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(job.outPath).pipe(res);
}
