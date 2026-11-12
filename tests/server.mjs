// Minimal static file server for the built app (dist/), served under a
// sub-path like GitHub Pages does.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream', '.gz': 'application/gzip', '.icc': 'application/octet-stream',
};

export function serve(root, base = '/pdf-project/') {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (!url.pathname.startsWith(base)) { res.writeHead(302, { Location: base }); return res.end(); }
      let rel = decodeURIComponent(url.pathname.slice(base.length)) || 'index.html';
      let file = normalize(join(root, rel));
      if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
      if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}${base}` })));
}
