// Browser services for the HWP converter: font files, image conversion,
// and drawing glyphs the bundled fonts do not have.
import gothic400 from '@expo-google-fonts/nanum-gothic/400Regular/NanumGothic_400Regular.ttf?url';
import gothic700 from '@expo-google-fonts/nanum-gothic/700Bold/NanumGothic_700Bold.ttf?url';
import gothic800 from '@expo-google-fonts/nanum-gothic/800ExtraBold/NanumGothic_800ExtraBold.ttf?url';
import myeongjo400 from '@expo-google-fonts/nanum-myeongjo/400Regular/NanumMyeongjo_400Regular.ttf?url';
import myeongjo700 from '@expo-google-fonts/nanum-myeongjo/700Bold/NanumMyeongjo_700Bold.ttf?url';
import myeongjo800 from '@expo-google-fonts/nanum-myeongjo/800ExtraBold/NanumMyeongjo_800ExtraBold.ttf?url';
import { convertHwpToPdf } from './index.js';

const FONT_URLS = {
  'gothic-400': gothic400, 'gothic-700': gothic700, 'gothic-800': gothic800,
  'myeongjo-400': myeongjo400, 'myeongjo-700': myeongjo700, 'myeongjo-800': myeongjo800,
};

async function loadFont(key) {
  const res = await fetch(FONT_URLS[key]);
  if (!res.ok) throw new Error(`글꼴을 불러오지 못했습니다 (${key})`);
  return new Uint8Array(await res.arrayBuffer());
}

const canvasBlob = (c, type, q) => new Promise((r) => c.toBlob(r, type, q));

/** PNG/JPEG pass through; other formats are converted with the browser's decoder. */
async function convertImage(bytes, ext) {
  const sig = bytes.subarray(0, 4);
  if (sig[0] === 0x89 && sig[1] === 0x50) return { bytes, mime: 'image/png' };
  if (sig[0] === 0xff && sig[1] === 0xd8) {
    // Progressive or CMYK JPEGs are re-encoded only if pdf-lib rejects them later.
    return { bytes, mime: 'image/jpeg' };
  }
  const type = { bmp: 'image/bmp', gif: 'image/gif', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff' }[ext] || '';
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type }));
  } catch {
    return null; // WMF/EMF and other formats the browser cannot decode
  }
  const max = 2400;
  const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bitmap.width * k));
  c.height = Math.max(1, Math.round(bitmap.height * k));
  const g = c.getContext('2d');
  g.drawImage(bitmap, 0, 0, c.width, c.height);
  // Keep transparency where there is any; otherwise JPEG is far smaller.
  let alpha = false;
  if (ext === 'gif' || ext === 'png' || ext === 'webp' || ext === 'bmp') {
    const data = g.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < data.length; i += 16) if (data[i] < 250) { alpha = true; break; }
  }
  const blob = alpha ? await canvasBlob(c, 'image/png') : await canvasBlob(c, 'image/jpeg', 0.9);
  c.width = c.height = 0;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: alpha ? 'image/png' : 'image/jpeg' };
}

const SANS = "'Apple SD Gothic Neo','Noto Sans CJK KR','Noto Sans KR','Malgun Gothic','PingFang SC','Hiragino Sans','Microsoft YaHei',sans-serif";
const SERIF = "'AppleMyungjo','Noto Serif CJK KR','Noto Serif KR','Batang','Songti SC','Hiragino Mincho ProN','SimSun',serif";

/** Draws a character the bundled fonts lack with the device's own fonts. */
async function rasterize(it) {
  const scale = 8; // px per point
  const s = it.size * scale;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(it.w * scale));
  c.height = Math.ceil(s * 1.08);
  const g = c.getContext('2d');
  g.font = `${it.bold ? 700 : 400} ${s}px ${it.family === 'serif' ? SERIF : SANS}`;
  g.fillStyle = it.color || '#000';
  g.textBaseline = 'alphabetic';
  const m = g.measureText(it.ch);
  if (!m.width) return null;
  const k = Math.min(1, c.width / m.width);
  g.setTransform(k, 0, 0, 1, (c.width - m.width * k) / 2, 0);
  g.fillText(it.ch, 0, s * 0.88);
  const blob = await canvasBlob(c, 'image/png');
  return { bytes: new Uint8Array(await blob.arrayBuffer()) };
}

export function convertHwp(bytes, onProgress) {
  return convertHwpToPdf(bytes, { loadFont, convertImage, rasterize, onProgress });
}
