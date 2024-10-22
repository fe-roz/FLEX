const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const settings = require('./settings');

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const sanitizedPath = sanitizePath(parsedUrl.pathname);

    if (sanitizedPath === '/proxy' && parsedUrl.query.url) {
        handleProxyRequest(req, res, parsedUrl.query.url);
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

    const options = {
        hostname: parsedTargetUrl.hostname,
        port: parsedTargetUrl.port || (parsedTargetUrl.protocol === 'https:' ? 443 : 80),
        path: parsedTargetUrl.path,
        method: req.method,
        headers: { ...req.headers, host: parsedTargetUrl.hostname }
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
