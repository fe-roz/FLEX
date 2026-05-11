const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { exec } = require('child_process');

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
    // ── CORS preflight ────────────────────────────────────────────────────────
    } else if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
    // ── Existing proxy + static file routes ───────────────────────────────────
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
        proxyRes.pipe(res);
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
