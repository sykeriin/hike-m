import http from 'http'; import fs from 'fs'; import path from 'path';
const root = process.cwd();
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/save?')) {
    const name = new URL(req.url, 'http://x').searchParams.get('name').replace(/[^a-z0-9_-]/gi, '');
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      fs.mkdirSync(path.join(root, 'screenshots'), { recursive: true });
      fs.writeFileSync(path.join(root, 'screenshots', name + '.jpg'), Buffer.from(body.includes(',') ? body.split(',')[1] : body, 'base64'));
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/mongolia-ridge.html';
  const f = path.join(root, p);
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(d); });
}).listen(5173, () => console.log('serving 5173'));
