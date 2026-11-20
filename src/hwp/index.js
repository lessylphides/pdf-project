// HWP -> PDF conversion entry point (runs entirely on this device).
import { HwpError } from './reader.js';
import { parseHwp } from './parse.js';
import { FontSet } from './fonts.js';
import { fontKeysFor, layoutHwp } from './layout.js';
import { renderPdf } from './render.js';

export { HwpError };

export const WARNINGS = {
  'missing-glyph': '대체 글꼴에 없는 일부 글자(한자 등)는 그림으로 넣었습니다. 이 글자들은 검색되지 않습니다.',
  equation: '수식은 수식 원문으로 표시했습니다.',
  ole: '문서에 포함된 OLE 개체(차트·다른 프로그램 개체)는 표시하지 못했습니다.',
  footnote: '각주는 쪽 아래에 간단한 형태로 표시했습니다.',
};

export function isHwp(bytes, name = '') {
  if (/\.hwp$/i.test(name)) return true;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] !== 0xd0 || u8[1] !== 0xcf) return false;
  // A compound file that has a FileHeader stream with the HWP signature.
  const text = new TextDecoder('latin1').decode(u8.subarray(0, Math.min(u8.length, 65536)));
  return text.includes('HWP Document File');
}

/**
 * @param {Uint8Array} bytes .hwp file
 * @param {object} env { loadFont(key) -> bytes, convertImage, rasterize, onProgress(stage, done, total) }
 * @returns {Promise<{ pdf: Uint8Array, pages: number, warnings: string[] }>}
 */
export async function convertHwpToPdf(bytes, env) {
  env.onProgress?.('parse');
  const doc = parseHwp(bytes);
  const fonts = new FontSet(env.loadFont);
  env.onProgress?.('fonts');
  await fonts.ensure(fontKeysFor(doc));
  env.onProgress?.('layout');
  const layout = layoutHwp(doc, fonts);
  const pdf = await renderPdf(layout, doc, fonts, {
    convertImage: env.convertImage,
    rasterize: env.rasterize,
    onProgress: (done, total) => env.onProgress?.('render', done, total),
  });
  return { pdf, pages: layout.pages.length, warnings: layout.warnings.map((w) => WARNINGS[w] || w), doc };
}
