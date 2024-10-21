const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8081; // Define your port here

const server = http.createServer((req, res) => {
    const filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
            return;
        }
        
        res.writeHead(200, { 'Content-Type': getContentType(filePath) });
        fs.createReadStream(filePath).pipe(res);
    });
});

server.listen(PORT, () => {
    console.log(`Server is listening on http://localhost:${PORT}`);
});

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
