// Font loading and text measurement shared by the on-screen preview and the
// PDF export, so a text box looks the same in the editor and in the saved file.
import regularUrl from '@expo-google-fonts/nanum-gothic/400Regular/NanumGothic_400Regular.ttf?url';
import boldUrl from '@expo-google-fonts/nanum-gothic/700Bold/NanumGothic_700Bold.ttf?url';
import { dropTables } from './sfnt.js';

export const FONT_FAMILY = 'EditorSans';
export const LINE_HEIGHT = 1.25;

/** Ascent/descent as a fraction of font size; refined once the font loads. */
export const metrics = { ascent: 0.8, descent: 0.2 };

const fontBytes = { regular: null, bold: null };
const ctx = document.createElement('canvas').getContext('2d');

export async function loadEditorFonts() {
  const faces = [
    new FontFace(FONT_FAMILY, `url(${regularUrl})`, { weight: '400' }),
    new FontFace(FONT_FAMILY, `url(${boldUrl})`, { weight: '700' }),
  ];
  await Promise.all(faces.map((f) => f.load().then(() => document.fonts.add(f))));
  ctx.font = `400 100px ${FONT_FAMILY}`;
  const m = ctx.measureText('가Ag');
  if (m.fontBoundingBoxAscent) {
    metrics.ascent = m.fontBoundingBoxAscent / 100;
    metrics.descent = Math.abs(m.fontBoundingBoxDescent) / 100;
  }
}

/** Raw TTF bytes for embedding in the exported PDF. */
export async function getFontBytes(bold) {
  const key = bold ? 'bold' : 'regular';
  if (!fontBytes[key]) {
    const res = await fetch(bold ? boldUrl : regularUrl);
    // fontkit cannot parse this font's layout tables; see sfnt.js.
    fontBytes[key] = dropTables(new Uint8Array(await res.arrayBuffer()), ['GPOS', 'GSUB']);
  }
  return fontBytes[key];
}

export function fontCss(size, bold) {
  return `${bold ? 700 : 400} ${size}px ${FONT_FAMILY}`;
}

export function splitLines(text) {
  return String(text ?? '').split('\n');
}

/** Width/height of a text annotation in page points. */
export function measureText(ann) {
  ctx.font = fontCss(ann.size, ann.bold);
  const lines = splitLines(ann.text);
  let w = 0;
  for (const line of lines) w = Math.max(w, ctx.measureText(line).width);
  return { w, h: lines.length * ann.size * LINE_HEIGHT };
}

/**
 * Distance from the top of the text box to the baseline of line `i`.
 * Mirrors how a CSS line box places glyphs (half-leading above the ascent),
 * which keeps the textarea editor and the rendered result aligned.
 */
export function baselineOffset(size, i) {
  const lineBox = size * LINE_HEIGHT;
  const halfLeading = (lineBox - (metrics.ascent + metrics.descent) * size) / 2;
  return i * lineBox + halfLeading + metrics.ascent * size;
}
