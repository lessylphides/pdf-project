// Draws laid-out HWP pages into a PDF with pdf-lib. Text is real, searchable
// text in embedded (glyph-reduced) fonts; borders and shapes are vectors.
import {
  LineCapStyle, PDFDocument, TextRenderingMode, beginText, clip, endPath, endText, rectangle, popGraphicsState, pushGraphicsState, rgb,
  setCharacterSpacing, setCharacterSqueeze, setFillingRgbColor, setFontAndSize, setLineWidth,
  setStrokingRgbColor, setTextMatrix, setTextRenderingMode, showText,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { retainGlyphs } from '../sfnt.js';

const hex = (c) => {
  const n = parseInt((c || '#000000').slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const color = (c) => rgb(...hex(c));
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Dash pattern for an HWP line type at a given width. */
function dash(style, w) {
  const u = Math.max(w, 0.5);
  switch (style) {
    case 2: return [u * 4, u * 2.5]; // dashed
    case 3: return [u, u * 1.5]; // dotted
    case 4: return [u * 5, u * 2, u, u * 2]; // dash-dot
    case 5: return [u * 5, u * 2, u, u * 2, u, u * 2]; // dash-dot-dot
    case 6: return [u * 8, u * 3]; // long dash
    case 7: return [u * 0.1, u * 2.2]; // big dots (round caps)
    default: return undefined;
  }
}

/**
 * @param {{pages}} layout result of layoutHwp
 * @param {object} doc parsed document (for embedded images)
 * @param {FontSet} fonts
 * @param {object} env { convertImage(bytes, ext) -> {bytes, mime}|null, rasterize(item) -> {bytes,width,height}|null, onProgress }
 */
export async function renderPdf(layout, doc, fonts, env = {}) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setProducer('PDF 편집기 (HWP 변환)');
  pdf.setCreator('PDF 편집기');

  // Embed each font once, keeping only the glyphs that are used.
  const used = new Map();
  const note = (key, text) => used.set(key, (used.get(key) || '') + text);
  for (const page of layout.pages) {
    for (const list of [page.back, page.main, page.front]) {
      for (const it of list) {
        if (it.t === 'text') note(it.key, it.text);
        else if (it.t === 'special') note(it.key, `${it.sp.text}${it.sp.sup || ''}()0123456789`);
      }
    }
  }
  const embedded = new Map();
  for (const [key, text] of used) {
    const f = fonts.fonts.get(key);
    if (!f) continue;
    const ids = f.font.glyphsForString(`${text} `).map((g) => g.id);
    embedded.set(key, await pdf.embedFont(retainGlyphs(f.bytes, ids), { subset: false }));
  }

  const images = new Map(); // binId -> PDFImage | null
  const getImage = async (binId) => {
    if (images.has(binId)) return images.get(binId);
    const bin = doc.binData[binId - 1];
    let img = null;
    if (bin?.bytes) {
      try {
        const conv = env.convertImage ? await env.convertImage(bin.bytes, bin.ext) : { bytes: bin.bytes, mime: bin.ext === 'png' ? 'image/png' : 'image/jpeg' };
        if (conv) img = conv.mime === 'image/png' ? await pdf.embedPng(conv.bytes) : await pdf.embedJpg(conv.bytes);
      } catch (err) {
        console.warn('image', binId, err);
      }
    }
    images.set(binId, img);
    return img;
  };
  const rasterCache = new Map();

  let n = 0;
  for (const p of layout.pages) {
    const page = pdf.addPage([p.width, p.height]);
    const H = p.height;
    const ops = [];
    const fontKey = (key) => {
      const font = embedded.get(key);
      return font ? page.node.newFontDictionary(font.name, font.ref) : null;
    };
    const fontNames = new Map();
    const nameFor = (key) => {
      if (!fontNames.has(key)) fontNames.set(key, fontKey(key));
      return fontNames.get(key);
    };
    const flushOps = () => {
      if (ops.length) page.pushOperators(...ops.splice(0));
    };

    const drawText = (it, text, x, y, opts = {}) => {
      const font = embedded.get(it.key);
      const name = nameFor(it.key);
      if (!font || !name || !text) return;
      const fill = opts.color || it.color || '#000000';
      const skew = it.italic ? 0.21 : 0;
      ops.push(pushGraphicsState(), setFillingRgbColor(...hex(fill)));
      if (it.outline) ops.push(setStrokingRgbColor(...hex(fill)), setLineWidth(it.size * 0.03));
      ops.push(beginText(), setFontAndSize(name, it.size));
      if (it.outline) ops.push(setTextRenderingMode(TextRenderingMode.Outline));
      if (Math.abs((opts.hscale ?? it.hscale) - 1) > 1e-4) ops.push(setCharacterSqueeze(r3((opts.hscale ?? it.hscale) * 100)));
      if (Math.abs(it.cspace || 0) > 1e-4) ops.push(setCharacterSpacing(r3(it.cspace)));
      ops.push(setTextMatrix(1, 0, skew, 1, r3(x), r3(H - y)), showText(font.encodeText(text)), endText(), popGraphicsState());
    };

    const draw = async (it) => {
      switch (it.t) {
        case 'text': {
          if (it.shadow && it.shadowColor) {
            drawText(it, it.text, it.x + (it.shadowX || 10) / 100 * it.size, it.y + (it.shadowY || 10) / 100 * it.size, { color: it.shadowColor });
          }
          if (it.emboss || it.engrave) drawText(it, it.text, it.x + 0.4, it.y + (it.emboss ? 0.4 : -0.4), { color: '#bbbbbb' });
          drawText(it, it.text, it.x, it.y);
          break;
        }
        case 'special':
          drawSpecial(it);
          break;
        case 'raster': {
          const key = `${it.ch}|${it.family}|${it.bold}|${it.color}`;
          if (!rasterCache.has(key)) {
            let img = null;
            try {
              const r = env.rasterize ? await env.rasterize(it) : null;
              if (r) img = await pdf.embedPng(r.bytes);
            } catch (err) {
              console.warn('rasterize', err);
            }
            rasterCache.set(key, img);
          }
          const img = rasterCache.get(key);
          flushOps();
          if (img) page.drawImage(img, { x: it.x, y: H - it.y - it.size * 0.2, width: it.w, height: it.size * 1.08 });
          break;
        }
        case 'rect':
          flushOps();
          page.drawRectangle({ x: it.x, y: H - it.y - it.h, width: it.w, height: it.h, color: it.fill ? color(it.fill) : undefined, borderWidth: 0 });
          break;
        case 'hatch':
          drawHatch(it);
          break;
        case 'line':
          drawLine(it);
          break;
        case 'poly':
          drawPoly(it);
          break;
        case 'ellipse':
          drawEllipse(it);
          break;
        case 'image': {
          const img = await getImage(it.binId);
          flushOps();
          if (!img) {
            page.drawRectangle({ x: it.x, y: H - it.y - it.h, width: it.w, height: it.h, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5, color: rgb(0.95, 0.95, 0.95) });
            break;
          }
          drawImageCropped(img, it);
          break;
        }
      }
    };

    const drawLine = (it) => {
      flushOps();
      const style = it.style || 1;
      const w = Math.max(0.25, it.width || 0.5);
      if (style >= 8 && style <= 11) {
        // Double / triple lines: parallel thin strokes.
        const dx = it.x2 - it.x1, dy = it.y2 - it.y1;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const parts = style === 11 ? [[-1, 0.25], [0, 0.4], [1, 0.25]] : style === 8 ? [[-0.5, 0.33], [0.5, 0.33]] : style === 9 ? [[-0.5, 0.25], [0.5, 0.5]] : [[-0.5, 0.5], [0.5, 0.25]];
        const gap = w * 0.75;
        for (const [o, f] of parts) {
          page.drawLine({
            start: { x: it.x1 + nx * o * gap, y: H - (it.y1 + ny * o * gap) },
            end: { x: it.x2 + nx * o * gap, y: H - (it.y2 + ny * o * gap) },
            thickness: Math.max(0.25, w * f), color: color(it.color),
          });
        }
        return;
      }
      page.drawLine({
        start: { x: it.x1, y: H - it.y1 }, end: { x: it.x2, y: H - it.y2 },
        thickness: w, color: color(it.color), dashArray: dash(style, w),
        lineCap: style === 7 || style === 3 ? LineCapStyle.Round : LineCapStyle.Butt,
      });
      if (it.arrows) drawArrows(it, w);
    };

    const drawArrows = (it, w) => {
      const head = (x, y, fromX, fromY) => {
        const a = Math.atan2(y - fromY, x - fromX);
        const s = Math.max(3, w * 4);
        const p1 = [x - s * Math.cos(a - 0.4), y - s * Math.sin(a - 0.4)];
        const p2 = [x - s * Math.cos(a + 0.4), y - s * Math.sin(a + 0.4)];
        drawPoly({ points: [[x, y], p1, p2], closed: true, fill: it.color });
      };
      if (it.arrows[0]) head(it.x1, it.y1, it.x2, it.y2);
      if (it.arrows[1]) head(it.x2, it.y2, it.x1, it.y1);
    };

    const drawPoly = (it) => {
      flushOps();
      if (!it.points?.length) return;
      let d = `M ${r3(it.points[0][0])} ${r3(it.points[0][1])}`;
      for (const pt of it.points.slice(1)) d += ` L ${r3(pt[0])} ${r3(pt[1])}`;
      if (it.closed) d += ' Z';
      page.drawSvgPath(d, {
        x: 0, y: H,
        color: it.fill ? color(it.fill) : undefined,
        borderColor: it.stroke ? color(it.stroke.color) : undefined,
        borderWidth: it.stroke ? it.stroke.width : 0,
        borderDashArray: it.stroke ? dash(it.stroke.style, it.stroke.width) : undefined,
      });
    };

    const drawEllipse = (it) => {
      flushOps();
      const [cx, cy] = it.c;
      const ax = [it.a1[0] - cx, it.a1[1] - cy], ay = [it.a2[0] - cx, it.a2[1] - cy];
      const k = 0.5523;
      const P = (u, v) => `${r3(cx + ax[0] * u + ay[0] * v)} ${r3(cy + ax[1] * u + ay[1] * v)}`;
      const d = `M ${P(1, 0)} C ${P(1, k)} ${P(k, 1)} ${P(0, 1)} C ${P(-k, 1)} ${P(-1, k)} ${P(-1, 0)} C ${P(-1, -k)} ${P(-k, -1)} ${P(0, -1)} C ${P(k, -1)} ${P(1, -k)} ${P(1, 0)} Z`;
      page.drawSvgPath(d, {
        x: 0, y: H,
        color: it.fill ? color(it.fill) : undefined,
        borderColor: it.stroke ? color(it.stroke.color) : undefined,
        borderWidth: it.stroke ? it.stroke.width : 0,
      });
    };

    const drawHatch = (it) => {
      flushOps();
      const step = 3;
      const lines = [];
      const { x, y, w, h } = it;
      if (it.pattern === 0 || it.pattern === 4) for (let yy = y + step; yy < y + h; yy += step) lines.push([x, yy, x + w, yy]);
      if (it.pattern === 1 || it.pattern === 4) for (let xx = x + step; xx < x + w; xx += step) lines.push([xx, y, xx, y + h]);
      if (it.pattern === 2 || it.pattern === 3 || it.pattern === 5) {
        // Diagonals clipped to the box.
        for (let t = -h; t < w; t += step * 1.4) {
          const segs = [];
          if (it.pattern !== 3) segs.push([t, 0, t + h, h]); // backslash
          if (it.pattern !== 2) segs.push([t + h, 0, t, h]); // slash
          for (const [a, b, c, d] of segs) {
            const x1 = Math.max(0, Math.min(w, a)), x2 = Math.max(0, Math.min(w, c));
            const y1 = b + (x1 - a) * ((d - b) / (c - a || 1)), y2 = b + (x2 - a) * ((d - b) / (c - a || 1));
            if (Math.abs(x2 - x1) > 0.1) lines.push([x + x1, y + y1, x + x2, y + y2]);
          }
        }
      }
      for (const [a, b, c, d] of lines) page.drawLine({ start: { x: a, y: H - b }, end: { x: c, y: H - d }, thickness: 0.3, color: color(it.color) });
    };

    const drawImageCropped = (img, it) => {
      const c = it.crop;
      const [nw, nh] = it.natural;
      const cropped = c && nw > 0 && nh > 0 && (c.left > 0 || c.top > 0 || (c.right > 0 && c.right < nw - 1) || (c.bottom > 0 && c.bottom < nh - 1));
      if (!cropped) {
        page.drawImage(img, { x: it.x, y: H - it.y - it.h, width: it.w, height: it.h });
        return;
      }
      // Scale the whole image so the cropped region fills the box, clipped.
      const fw = (c.right - c.left) / nw || 1, fh = (c.bottom - c.top) / nh || 1;
      const fullW = it.w / fw, fullH = it.h / fh;
      const ox = it.x - (c.left / nw) * fullW, oy = it.y - (c.top / nh) * fullH;
      page.pushOperators(pushGraphicsState(), rectangle(r3(it.x), r3(H - it.y - it.h), r3(it.w), r3(it.h)), clip(), endPath());
      page.drawImage(img, { x: ox, y: H - oy - fullH, width: fullW, height: fullH });
      page.pushOperators(popGraphicsState());
    };

    const drawSpecial = (it) => {
      const { sp } = it;
      const s = it.size;
      if (sp.kind === 'circle' || sp.kind === 'filled') {
        flushOps();
        const d = Math.min(it.w, s) * 0.92;
        const cx = it.x + it.w / 2, cy = it.y - s * 0.36;
        page.drawEllipse({
          x: cx, y: H - cy, xScale: d / 2, yScale: d / 2,
          color: sp.kind === 'filled' ? color(it.color) : undefined,
          borderColor: sp.kind === 'filled' ? undefined : color(it.color),
          borderWidth: sp.kind === 'filled' ? 0 : Math.max(0.35, s * 0.055),
        });
        const ts = s * (sp.text.length > 1 ? 0.5 : 0.62);
        let tw = 0;
        for (const ch of sp.text) tw += fonts.advance(it.key, ch) * ts;
        drawText({ ...it, size: ts, hscale: sp.text.length > 2 ? 0.8 : 1, cspace: 0 }, sp.text, cx - (tw * (sp.text.length > 2 ? 0.8 : 1)) / 2, cy + ts * 0.36, { color: sp.kind === 'filled' ? '#ffffff' : it.color });
      } else if (sp.kind === 'paren') {
        let tw = 0;
        for (const ch of sp.text) tw += fonts.advance(it.key, ch) * s;
        const h = Math.min(1, it.w / (tw || 1));
        drawText({ ...it, hscale: h, cspace: 0 }, sp.text, it.x, it.y);
      } else if (sp.kind === 'unit') {
        let tw = 0;
        for (const ch of sp.text) tw += fonts.advance(it.key, ch) * s;
        drawText({ ...it, hscale: it.hscale, cspace: 0 }, sp.text, it.x, it.y);
        if (sp.sup) drawText({ ...it, size: s * 0.6, hscale: it.hscale, cspace: 0 }, sp.sup, it.x + tw * it.hscale, it.y - s * 0.4);
      }
    };

    for (const list of [p.back, p.main, p.front]) {
      for (const it of list) await draw(it);
    }
    flushOps();
    n++;
    env.onProgress?.(n, layout.pages.length);
    if (n % 3 === 0) await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
  }
  return pdf.save();
}
