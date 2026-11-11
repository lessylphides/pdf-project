// Copies the PDF.js runtime assets (CJK cmaps, standard fonts, wasm decoders,
// ICC profiles) into public/ so Vite serves them in dev and build.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
const outRoot = join(process.cwd(), 'public', 'pdfjs');

mkdirSync(outRoot, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const from = join(pdfjsRoot, dir);
  if (existsSync(from)) cpSync(from, join(outRoot, dir), { recursive: true });
}
console.log('PDF.js assets copied to public/pdfjs');
