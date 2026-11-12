// Builds the edited PDF with pdf-lib.
//
// The first opened file is the base document: it is modified in place, so its
// form fields, bookmarks, metadata and other document-level structures are
// kept. Pages are re-ordered by rebuilding the page tree, pages from other
// files are copied in, and deleted pages are scrubbed and dropped from the file
// together with every object that only they used.
//
// Edits are written in two different ways:
//  - content edits (text, shapes, images, signatures, stamps, whiteout) are
//    drawn into the page content itself;
//  - comments (highlight, underline, notes) become standard PDF annotations
//    that other PDF apps list, show and can delete as annotations.
import {
  BlendMode, LineCapStyle, PDFArray, PDFCheckBox, PDFDict, PDFDocument, PDFDropdown, PDFHexString, PDFName,
  PDFOptionList, PDFPage, PDFPageTree, PDFRadioGroup, PDFRef, PDFStream, PDFString, PDFTextField,
  TextRenderingMode, beginText, degrees, endText, popGraphicsState, pushGraphicsState, rgb, setFontAndSize,
  setTextMatrix, setTextRenderingMode, showText,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { inkPath, unionRects } from './annotations.js';
import { repair } from './qpdf.js';
import { retainGlyphs } from './sfnt.js';
import { baselineOffset, getFontBytes, splitLines } from './text.js';

function color(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
const rgbArray = (hex) => {
  const c = color(hex);
  return [c.red, c.green, c.blue];
};
const num = (v) => Math.round(v * 1000) / 1000;

/** Loads a PDF into pdf-lib, letting qpdf rewrite it first if it is damaged. */
export async function loadForEditing(bytes) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    const fixed = await repair(bytes);
    if (!fixed) throw err;
    return PDFDocument.load(fixed, { updateMetadata: false });
  }
}

const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'].map((n) => PDFName.of(n));

/**
 * @param {object} p
 * @param {{bytes: Uint8Array}[]} p.sources opened PDF files (decrypted)
 * @param {object[]} p.pages page list in output order (see main.js)
 * @param {Map<string, {bytes: Uint8Array, mime: string}>} p.images
 * @param {{name: string, kind: string, value: any}[]} p.formValues edited form fields of the base file
 * @returns {Promise<{bytes: Uint8Array, missing: string[], formErrors: string[]}>}
 */
export async function exportPdf({ sources, pages, images, formValues = [] }) {
  const base = await loadForEditing(sources[0].bytes);
  base.registerFontkit(fontkit);
  const ctx = base.context;

  // --- Page list --------------------------------------------------------
  const basePages = base.getPages();
  for (const p of basePages) {
    // Pages are moved directly under a new root node, so they must carry the
    // attributes they used to inherit from their old parents.
    for (const key of INHERITABLE) {
      if (!p.node.get(key)) {
        const v = p.node.getInheritableAttribute(key);
        if (v) p.node.set(key, v);
      }
    }
  }
  const copied = new Map(); // `${src}:${index}` -> PDFPage
  const bySource = new Map();
  for (const pg of pages) {
    if (pg.src == null || pg.src === 0) continue;
    if (!bySource.has(pg.src)) bySource.set(pg.src, new Set());
    bySource.get(pg.src).add(pg.index);
  }
  for (const [src, set] of bySource) {
    const doc = await loadForEditing(sources[src].bytes);
    const indices = [...set];
    const result = await base.copyPages(doc, indices);
    indices.forEach((idx, i) => copied.set(`${src}:${idx}`, result[i]));
  }

  const outPages = pages.map((pg) => {
    if (pg.src == null) {
      const page = PDFPage.create(base);
      page.setSize(pg.width, pg.height);
      return page;
    }
    return pg.src === 0 ? basePages[pg.index] : copied.get(`${pg.src}:${pg.index}`);
  });

  const root = PDFPageTree.withContext(ctx);
  const rootRef = ctx.register(root);
  for (const p of outPages) {
    root.pushLeafNode(p.ref);
    p.node.setParent(rootRef);
  }
  base.catalog.set(PDFName.of('Pages'), rootRef);
  base.pageCache.invalidate();
  base.pageCount = outPages.length;
  for (const p of outPages) base.pageMap.set(p.node, p);

  const kept = new Set(outPages.map((p) => p.ref.tag));
  const removed = basePages.filter((p) => !kept.has(p.ref.tag));
  if (removed.length) scrubRemovedPages(base, removed, rootRef);

  // --- Fonts & images -------------------------------------------------
  // Each weight is embedded once, keeping only the outlines of the glyphs
  // used (see sfnt.js for why fontkit's own subsetting is not used).
  const usedText = { regular: '', bold: '' };
  for (const pg of pages) {
    for (const a of pg.annotations) if (a.type === 'text') usedText[a.bold ? 'bold' : 'regular'] += a.text;
    for (const w of pg.ocr?.words || []) usedText.regular += w.text;
  }
  for (const f of formValues) if (typeof f.value === 'string') usedText.regular += f.value;
  const fonts = {};
  const missing = new Set();
  const getFont = async (bold) => {
    const key = bold ? 'bold' : 'regular';
    if (!fonts[key]) {
      const bytes = await getFontBytes(bold);
      const font = fontkit.create(bytes);
      for (const ch of usedText[key]) if (/\S/.test(ch) && !font.hasGlyphForCodePoint(ch.codePointAt(0))) missing.add(ch);
      const glyphIds = font.glyphsForString(usedText[key] + ' ').map((g) => g.id);
      fonts[key] = await base.embedFont(retainGlyphs(bytes, glyphIds), { subset: false });
    }
    return fonts[key];
  };
  const embeddedImages = new Map();
  const getImage = async (id) => {
    if (!embeddedImages.has(id)) {
      const img = images.get(id);
      embeddedImages.set(id, img.mime === 'image/jpeg' ? await base.embedJpg(img.bytes) : await base.embedPng(img.bytes));
    }
    return embeddedImages.get(id);
  };

  // --- Form fields ------------------------------------------------------
  const formErrors = formValues.length ? await fillForm(base, formValues, await getFont(false)) : [];

  // --- Page edits -------------------------------------------------------
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    const page = outPages[i];
    page.setRotation(degrees(pg.rotation));
    const ocrWords = pg.ocr?.words || [];
    if (!pg.annotations.length && !ocrWords.length) continue;

    // Isolate the original content in q/Q so a graphics state it leaves
    // behind (e.g. an unbalanced transform) cannot shift our drawings.
    page.translateContent(0, 0);

    const [x0, , , y1] = pg.view;
    const X = (x) => x0 + x;
    const Y = (y) => y1 - y;

    if (ocrWords.length) await drawInvisibleText(page, ocrWords, await getFont(false), X, Y);

    for (const a of pg.annotations) {
      const opacity = a.opacity ?? 1;
      const blendMode = a.blend === 'multiply' ? BlendMode.Multiply : undefined;
      switch (a.type) {
        case 'text': {
          if (!a.text.trim()) break;
          const font = await getFont(a.bold);
          splitLines(a.text).forEach((line, li) => {
            if (!line) return;
            page.drawText(line, { x: X(a.x), y: Y(a.y + baselineOffset(a.size, li)), size: a.size, font, color: color(a.color), opacity });
          });
          break;
        }
        case 'rect':
          page.drawRectangle({
            x: X(a.x), y: Y(a.y + a.h), width: a.w, height: a.h,
            color: a.fill ? color(a.fill) : undefined, opacity,
            borderColor: a.stroke ? color(a.stroke) : undefined, borderWidth: a.stroke ? a.width : 0, borderOpacity: opacity,
            blendMode,
          });
          break;
        case 'ellipse':
          page.drawEllipse({
            x: X(a.x + a.w / 2), y: Y(a.y + a.h / 2), xScale: a.w / 2, yScale: a.h / 2,
            color: a.fill ? color(a.fill) : undefined, opacity,
            borderColor: a.stroke ? color(a.stroke) : undefined, borderWidth: a.stroke ? a.width : 0, borderOpacity: opacity,
            blendMode,
          });
          break;
        case 'line':
          page.drawLine({
            start: { x: X(a.x1), y: Y(a.y1) }, end: { x: X(a.x2), y: Y(a.y2) },
            thickness: a.width, color: color(a.stroke), opacity, lineCap: LineCapStyle.Round, blendMode,
          });
          break;
        case 'ink':
          // drawSvgPath uses SVG (y-down) coordinates from the given origin,
          // which matches the annotation model directly.
          page.drawSvgPath(inkPath(a.points), {
            x: x0, y: y1, borderColor: color(a.stroke), borderWidth: a.width, borderOpacity: opacity,
            borderLineCap: LineCapStyle.Round, blendMode,
          });
          break;
        case 'image': {
          const img = await getImage(a.imageId);
          page.drawImage(img, { x: X(a.x), y: Y(a.y + a.h), width: a.w, height: a.h, opacity });
          break;
        }
        case 'markup':
          addMarkupAnnotation(base, page, a, X, Y);
          break;
        case 'note':
          addNoteAnnotation(base, page, a, X, Y);
          break;
      }
    }
  }

  base.setModificationDate(new Date());
  collectGarbage(ctx);
  const bytes = await base.save({ updateFieldAppearances: false });
  return { bytes, missing: [...missing], formErrors };
}

// ---------------------------------------------------------------------------
// Deleted pages
// ---------------------------------------------------------------------------

/**
 * Empties deleted pages and detaches their form widgets, so that bookmarks or
 * fields that still point at them cannot keep their content in the file.
 */
function scrubRemovedPages(doc, removed, rootRef) {
  const ctx = doc.context;
  const removedTags = new Set(removed.map((p) => p.ref.tag));
  for (const p of removed) {
    p.node.setParent(rootRef); // do not keep the old page tree alive
    p.node.set(PDFName.of('Contents'), ctx.obj([]));
    p.node.set(PDFName.of('Resources'), ctx.obj({}));
    for (const key of ['Annots', 'Thumb', 'B', 'PieceInfo', 'Metadata', 'AA']) p.node.delete(PDFName.of(key));
  }
  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acroForm?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return;
  const onRemovedPage = (dict) => {
    const p = dict.get(PDFName.of('P'));
    return p instanceof PDFRef && removedTags.has(p.tag);
  };
  // Returns true if the node (field or widget) should be dropped.
  const prune = (ref) => {
    const node = ctx.lookup(ref);
    if (!(node instanceof PDFDict)) return false;
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) {
      for (let i = kids.size() - 1; i >= 0; i--) if (prune(kids.get(i))) kids.remove(i);
      if (kids.size() === 0) return true;
      return false;
    }
    return onRemovedPage(node);
  };
  for (let i = fields.size() - 1; i >= 0; i--) if (prune(fields.get(i))) fields.remove(i);
}

/** Drops every indirect object that is no longer reachable from the trailer. */
function collectGarbage(ctx) {
  const seen = new Set();
  const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info].filter(Boolean);
  while (stack.length) {
    let o = stack.pop();
    if (o instanceof PDFRef) {
      if (seen.has(o.tag)) continue;
      seen.add(o.tag);
      o = ctx.lookup(o);
    }
    if (o instanceof PDFDict) for (const [, v] of o.entries()) stack.push(v);
    else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    else if (o instanceof PDFStream) stack.push(o.dict);
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

async function fillForm(doc, values, font) {
  const errors = [];
  let form;
  try {
    form = doc.getForm();
  } catch {
    return values.map((v) => v.name);
  }
  for (const { name, kind, value } of values) {
    try {
      const field = form.getFieldMaybe(name);
      if (!field) continue;
      if (field instanceof PDFTextField) {
        field.setText(String(value ?? ''));
      } else if (field instanceof PDFCheckBox) {
        if (value) field.check();
        else field.uncheck();
      } else if (field instanceof PDFRadioGroup) {
        if (value) field.select(value);
        else field.clear();
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        const list = (Array.isArray(value) ? value : [value]).filter((v) => v != null && v !== '');
        if (list.length) field.select(field instanceof PDFDropdown ? list[0] : list);
        else field.clear();
      } else {
        continue;
      }
      if (field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList) field.updateAppearances(font);
      else field.defaultUpdateAppearances();
    } catch (err) {
      console.warn('form field', name, kind, err);
      errors.push(name);
    }
  }
  // Appearances are now generated with a Korean-capable font; stop viewers
  // from regenerating them with a font that may not have the glyphs.
  form.acroForm.dict.delete(PDFName.of('NeedAppearances'));
  return errors;
}

// ---------------------------------------------------------------------------
// OCR text layer
// ---------------------------------------------------------------------------

/** Invisible text (render mode 3) over each recognized word: searchable and selectable. */
async function drawInvisibleText(page, words, font, X, Y) {
  const key = page.node.newFontDictionary(font.name, font.ref);
  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  for (const w of words) {
    const size = Math.max(1, (w.base - w.y) * 1.15);
    const natural = font.widthOfTextAtSize(w.text, size);
    if (!natural) continue;
    const sx = w.w / natural;
    ops.push(setFontAndSize(key, size), setTextMatrix(num(sx), 0, 0, 1, num(X(w.x)), num(Y(w.base))), showText(font.encodeText(w.text)));
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}

// ---------------------------------------------------------------------------
// Standard annotations (comments)
// ---------------------------------------------------------------------------

function appearance(ctx, bbox, content, resources = {}) {
  return ctx.register(ctx.flateStream(content, { Type: 'XObject', Subtype: 'Form', BBox: bbox, Resources: resources }));
}

function addAnnotation(doc, page, dict) {
  const ref = doc.context.register(doc.context.obj(dict));
  page.node.addAnnot(ref);
  return ref;
}

function addMarkupAnnotation(doc, page, a, X, Y) {
  const ctx = doc.context;
  const quads = a.quads.filter((q) => q.w > 0.5 && q.h > 0.5);
  if (!quads.length) return;
  const b = unionRects(quads);
  const rect = [X(b.x), Y(b.y + b.h), X(b.x + b.w), Y(b.y)].map(num);
  const quadPoints = [];
  for (const q of quads) {
    const l = X(q.x), r = X(q.x + q.w), t = Y(q.y), bt = Y(q.y + q.h);
    quadPoints.push(l, t, r, t, l, bt, r, bt);
  }
  const [cr, cg, cb] = rgbArray(a.color);
  const opacity = a.opacity ?? 1;
  let content;
  const resources = {};
  if (a.kind === 'underline') {
    content = `${num(cr)} ${num(cg)} ${num(cb)} rg\n`;
    for (const q of quads) {
      const th = Math.max(0.5, q.h / 14);
      content += `${num(X(q.x))} ${num(Y(q.y + q.h) + th * 0.5)} ${num(q.w)} ${num(th)} re f\n`;
    }
    if (opacity < 1) {
      resources.ExtGState = { GS0: { Type: 'ExtGState', CA: opacity, ca: opacity } };
      content = `/GS0 gs\n${content}`;
    }
  } else {
    resources.ExtGState = { GS0: { Type: 'ExtGState', BM: 'Multiply', CA: opacity, ca: opacity } };
    content = `/GS0 gs\n${num(cr)} ${num(cg)} ${num(cb)} rg\n`;
    for (const q of quads) content += `${num(X(q.x))} ${num(Y(q.y + q.h))} ${num(q.w)} ${num(q.h)} re f\n`;
  }
  const ap = appearance(ctx, rect, content, resources);
  addAnnotation(doc, page, {
    Type: 'Annot',
    Subtype: a.kind === 'underline' ? 'Underline' : 'Highlight',
    Rect: rect,
    QuadPoints: quadPoints.map(num),
    C: [cr, cg, cb].map(num),
    CA: opacity,
    F: 4,
    M: PDFString.fromDate(new Date()),
    NM: PDFHexString.fromText(a.id),
    AP: { N: ap },
    P: page.ref,
  });
}

function addNoteAnnotation(doc, page, a, X, Y) {
  const ctx = doc.context;
  const s = a.w;
  const rect = [X(a.x), Y(a.y + s), X(a.x + s), Y(a.y)].map(num);
  const [cr, cg, cb] = rgbArray(a.color);
  // Speech bubble icon drawn in a 20x20 box, scaled to the note size.
  const k = num(s / 20);
  const icon = [
    `${k} 0 0 ${k} 0 0 cm`,
    `${num(cr)} ${num(cg)} ${num(cb)} rg 0.25 0.25 0.25 RG 1 w 1 j`,
    '3 19 m 17 19 l 18.1 19 19 18.1 19 17 c 19 8 l 19 6.9 18.1 6 17 6 c',
    '9 6 l 4.5 1.5 l 5 6 l 3 6 l 1.9 6 1 6.9 1 8 c 1 17 l 1 18.1 1.9 19 3 19 c h B',
    '0.25 0.25 0.25 RG 1.2 w 1 J 5 15 m 15 15 l S 5 12 m 15 12 l S 5 9 m 11 9 l S',
  ].join('\n');
  const ap = appearance(ctx, [0, 0, s, s], icon);
  addAnnotation(doc, page, {
    Type: 'Annot',
    Subtype: 'Text',
    Rect: rect,
    Contents: PDFHexString.fromText(a.text || ''),
    Name: 'Comment',
    C: [cr, cg, cb].map(num),
    F: 4 | 8 | 16, // Print, NoZoom, NoRotate
    Open: false,
    M: PDFString.fromDate(new Date()),
    NM: PDFHexString.fromText(a.id),
    AP: { N: ap },
    P: page.ref,
  });
}
