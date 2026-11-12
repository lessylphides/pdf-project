// Copies runtime files that are loaded on demand (not bundled by Vite) into
// public/vendor so the app never depends on a third-party CDN:
//  - PDF.js: CJK cmaps, standard fonts, wasm image decoders, ICC profiles
//  - qpdf (wasm): removing a PDF password, repairing damaged files
//  - Tesseract.js: OCR worker, LSTM-only engine builds, Korean/English models
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = (name) => dirname(require.resolve(`${name}/package.json`));
const out = join(process.cwd(), 'public', 'vendor');

rmSync(out, { recursive: true, force: true });
const copy = (from, to) => {
  if (!existsSync(from)) throw new Error(`missing ${from}`);
  mkdirSync(dirname(join(out, to)), { recursive: true });
  cpSync(from, join(out, to), { recursive: true });
};

const pdfjs = pkg('pdfjs-dist');
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) copy(join(pdfjs, dir), join('pdfjs', dir));
copy(join(pdfjs, 'web', 'images'), 'pdfjs/images'); // icons for notes already in a PDF

copy(join(pkg('@neslinesli93/qpdf-wasm'), 'dist', 'qpdf.wasm'), 'qpdf/qpdf.wasm');

copy(join(pkg('tesseract.js'), 'dist', 'worker.min.js'), 'ocr/worker.min.js');
const core = pkg('tesseract.js-core');
for (const v of ['lstm', 'simd-lstm', 'relaxedsimd-lstm']) copy(join(core, `tesseract-core-${v}.wasm.js`), `ocr/core/tesseract-core-${v}.wasm.js`);
// "best_int" models: accurate and small enough for phones.
for (const lang of ['kor', 'eng']) copy(join(pkg(`@tesseract.js-data/${lang}`), '4.0.0_best_int', `${lang}.traineddata.gz`), `ocr/lang/${lang}.traineddata.gz`);

console.log('Runtime assets copied to public/vendor');
