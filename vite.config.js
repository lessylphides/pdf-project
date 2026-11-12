import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { defineConfig } from 'vite';

// Content Security Policy for the built app: only this site's own scripts,
// WebAssembly allowed (PDF image decoders, qpdf, OCR), no plug-ins, no forms
// posting anywhere. Documents never leave the device.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' blob: data:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

/** Writes sw.js: the app shell is cached at install, everything else on first use. */
function serviceWorker() {
  let outDir;
  return {
    name: 'service-worker',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir; },
    transformIndexHtml(html) {
      return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
    closeBundle() {
      const files = walk(outDir).map((f) => relative(outDir, f).split('\\').join('/'));
      // Large or rarely used files (OCR, seal font, CJK maps) are cached when first used.
      const shell = files.filter((f) => !f.startsWith('vendor/') && !f.endsWith('.map') && f !== 'sw.js' && !/Myeongjo/.test(f));
      const hash = createHash('sha256');
      for (const f of shell) hash.update(f).update(String(statSync(join(outDir, f)).size));
      const version = hash.digest('hex').slice(0, 12);
      writeFileSync(join(outDir, 'sw.js'), `// Generated at build time.
const CACHE = 'pdf-editor-${version}';
const SHELL = ${JSON.stringify(['./', ...shell])};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('pdf-editor-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // Network first so updates arrive; the cached page works offline.
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put('./', copy));
      return res;
    }).catch(() => caches.match('./')));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  })));
});
`);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [serviceWorker()],
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  server: { host: true },
  preview: { host: true },
});
