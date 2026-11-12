// Text recognition for scanned pages with Tesseract.js. All files (engine,
// Korean/English models) are served from this site, never a CDN, and the
// recognition runs in a worker on this device.
const base = (p) => new URL(`vendor/ocr/${p}`, document.baseURI).href;
let workerPromise = null;

async function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker, OEM } = await import('tesseract.js');
      return createWorker(['kor', 'eng'], OEM.LSTM_ONLY, {
        workerPath: base('worker.min.js'),
        corePath: base('core/'),
        langPath: base('lang'),
        workerBlobURL: false,
        logger: (m) => workerPromise.onProgress?.(m),
      });
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  workerPromise.onProgress = onProgress;
  return workerPromise;
}

/**
 * Recognizes the text on a rendered page.
 * @param {HTMLCanvasElement} canvas page rendered at `scale` px per point
 * @returns {Promise<{x, y, w, h, base, text}[]>} words in page points
 *   (top-left origin); `base` is the baseline's distance from the top
 */
export async function recognize(canvas, scale, onProgress) {
  const worker = await getWorker(onProgress);
  const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false, hocr: false, tsv: false });
  const words = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        const bl = line.baseline;
        for (const w of line.words) {
          const text = w.text.trim();
          if (!text || w.confidence < 30) continue;
          const { x0, y0, x1, y1 } = w.bbox;
          // Baseline of this word, interpolated along the line's baseline.
          let base = y1;
          if (bl?.has_baseline && bl.x1 !== bl.x0) {
            const cx = (x0 + x1) / 2;
            base = bl.y0 + ((bl.y1 - bl.y0) * (cx - bl.x0)) / (bl.x1 - bl.x0);
            if (base < y0 || base > y1 + (y1 - y0) * 0.5) base = y1;
          }
          words.push({
            x: round(x0 / scale), y: round(y0 / scale), w: round((x1 - x0) / scale), h: round((y1 - y0) / scale),
            base: round(base / scale), text,
          });
        }
      }
    }
  }
  return words;
}

const round = (v) => Math.round(v * 100) / 100;

export async function terminate() {
  if (!workerPromise) return;
  const w = await workerPromise.catch(() => null);
  workerPromise = null;
  await w?.terminate();
}
