// Builds the edited PDF with pdf-lib: copies the pages in their new order,
// applies rotations, and draws every annotation into the page content.
import { BlendMode, LineCapStyle, PDFDocument, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { inkPath } from './annotations.js';
import { retainGlyphs } from './sfnt.js';
import { baselineOffset, getFontBytes, splitLines } from './text.js';

function color(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/**
 * @param {object} p
 * @param {{bytes: Uint8Array}[]} p.sources original PDF files
 * @param {object[]} p.pages page list (see main.js)
 * @param {Map<string, {bytes: Uint8Array, mime: string}>} p.images
 * @returns {Promise<{bytes: Uint8Array, missing: string[]}>} the PDF, and any
 *   characters the embedded font cannot display
 */
export async function exportPdf({ sources, pages, images }) {
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);

  // Copy pages per source in a single call so shared resources (fonts,
  // images) are copied once instead of once per page.
  const copied = new Map(); // `${src}:${index}` -> PDFPage
  const bySource = new Map();
  for (const pg of pages) {
    if (pg.src == null) continue;
    if (!bySource.has(pg.src)) bySource.set(pg.src, new Set());
    bySource.get(pg.src).add(pg.index);
  }
  for (const [src, set] of bySource) {
    const doc = await PDFDocument.load(sources[src].bytes, { ignoreEncryption: true, updateMetadata: false });
    const indices = [...set];
    const result = await out.copyPages(doc, indices);
    indices.forEach((idx, i) => copied.set(`${src}:${idx}`, result[i]));
  }

  // Embed each weight once, keeping only the outlines of the glyphs used
  // (see sfnt.js for why fontkit's own subsetting is not used).
  const usedText = { regular: '', bold: '' };
  for (const pg of pages) for (const a of pg.annotations) if (a.type === 'text') usedText[a.bold ? 'bold' : 'regular'] += a.text;
  const fonts = {};
  const missing = new Set();
  const getFont = async (bold) => {
    const key = bold ? 'bold' : 'regular';
    if (!fonts[key]) {
      const bytes = await getFontBytes(bold);
      const font = fontkit.create(bytes);
      for (const ch of usedText[key]) if (/\S/.test(ch) && !font.hasGlyphForCodePoint(ch.codePointAt(0))) missing.add(ch);
      const glyphIds = font.glyphsForString(usedText[key]).map((g) => g.id);
      fonts[key] = await out.embedFont(retainGlyphs(bytes, glyphIds), { subset: false });
    }
    return fonts[key];
  };
  const embeddedImages = new Map();
  const getImage = async (id) => {
    if (!embeddedImages.has(id)) {
      const img = images.get(id);
      embeddedImages.set(id, img.mime === 'image/jpeg' ? await out.embedJpg(img.bytes) : await out.embedPng(img.bytes));
    }
    return embeddedImages.get(id);
  };

  for (const pg of pages) {
    let page;
    if (pg.src == null) {
      page = out.addPage([pg.width, pg.height]);
    } else {
      page = out.addPage(copied.get(`${pg.src}:${pg.index}`));
    }
    page.setRotation(degrees(pg.rotation));
    if (!pg.annotations.length) continue;

    // Isolate the original content in q/Q so a graphics state it leaves
    // behind (e.g. an unbalanced transform) cannot shift our drawings.
    page.translateContent(0, 0);

    const [x0, , , y1] = pg.view;
    const X = (x) => x0 + x;
    const Y = (y) => y1 - y;

    for (const a of pg.annotations) {
      const opacity = a.opacity ?? 1;
      const blendMode = a.blend === 'multiply' ? BlendMode.Multiply : undefined;
      switch (a.type) {
        case 'text': {
          if (!a.text.trim()) break;
          const font = await getFont(a.bold);
          splitLines(a.text).forEach((line, i) => {
            if (!line) return;
            page.drawText(line, {
              x: X(a.x),
              y: Y(a.y + baselineOffset(a.size, i)),
              size: a.size,
              font,
              color: color(a.color),
              opacity,
            });
          });
          break;
        }
        case 'rect':
          page.drawRectangle({
            x: X(a.x),
            y: Y(a.y + a.h),
            width: a.w,
            height: a.h,
            color: a.fill ? color(a.fill) : undefined,
            opacity,
            borderColor: a.stroke ? color(a.stroke) : undefined,
            borderWidth: a.stroke ? a.width : 0,
            borderOpacity: opacity,
            blendMode,
          });
          break;
        case 'ellipse':
          page.drawEllipse({
            x: X(a.x + a.w / 2),
            y: Y(a.y + a.h / 2),
            xScale: a.w / 2,
            yScale: a.h / 2,
            color: a.fill ? color(a.fill) : undefined,
            opacity,
            borderColor: a.stroke ? color(a.stroke) : undefined,
            borderWidth: a.stroke ? a.width : 0,
            borderOpacity: opacity,
            blendMode,
          });
          break;
        case 'line':
          page.drawLine({
            start: { x: X(a.x1), y: Y(a.y1) },
            end: { x: X(a.x2), y: Y(a.y2) },
            thickness: a.width,
            color: color(a.stroke),
            opacity,
            lineCap: LineCapStyle.Round,
            blendMode,
          });
          break;
        case 'ink':
          // drawSvgPath uses SVG (y-down) coordinates from the given origin,
          // which matches the annotation model directly.
          page.drawSvgPath(inkPath(a.points), {
            x: x0,
            y: y1,
            borderColor: color(a.stroke),
            borderWidth: a.width,
            borderOpacity: opacity,
            borderLineCap: LineCapStyle.Round,
            blendMode,
          });
          break;
        case 'image': {
          const img = await getImage(a.imageId);
          page.drawImage(img, { x: X(a.x), y: Y(a.y + a.h), width: a.w, height: a.h, opacity });
          break;
        }
      }
    }
  }

  return { bytes: await out.save(), missing: [...missing] };
}
