// Minimal TrueType (sfnt) rewriting used before embedding the editor font.
//
// Two problems with @pdf-lib/fontkit and NanumGothic are worked around here:
//  1. fontkit crashes on the font's GPOS/GSUB tables ("Trying to access beyond
//     buffer length"). Precomposed Hangul and Latin need no glyph substitution,
//     so those tables are dropped.
//  2. fontkit's subsetter produces a font with missing glyphs. Instead, the
//     font is embedded whole, but with the outlines of every glyph that is not
//     used emptied out. Glyph IDs stay the same, so nothing else changes and
//     the embedded font is small.

const pad4 = (n) => (n + 3) & ~3;

function readTables(input) {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const numTables = view.getUint16(4);
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(...input.subarray(rec, rec + 4));
    const offset = view.getUint32(rec + 8);
    tables.set(tag, input.subarray(offset, offset + view.getUint32(rec + 12)));
  }
  return { version: view.getUint32(0), tables };
}

function checksum(bytes, offset, length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sum = 0;
  const end = offset + pad4(length);
  for (let i = offset; i < end; i += 4) sum = (sum + (i + 4 <= bytes.length ? view.getUint32(i) : 0)) >>> 0;
  return sum;
}

function writeFont(version, tables) {
  const entries = [...tables].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const n = entries.length;
  const headerSize = 12 + n * 16;
  const total = headerSize + entries.reduce((s, [, d]) => s + pad4(d.length), 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const entrySelector = Math.floor(Math.log2(n));
  const searchRange = 2 ** entrySelector * 16;
  view.setUint32(0, version);
  view.setUint16(4, n);
  view.setUint16(6, searchRange);
  view.setUint16(8, entrySelector);
  view.setUint16(10, n * 16 - searchRange);

  let offset = headerSize;
  let headOffset = -1;
  entries.forEach(([tag, data], i) => {
    out.set(data, offset);
    if (tag === 'head') {
      headOffset = offset;
      view.setUint32(offset + 8, 0); // checkSumAdjustment, computed below
    }
    const rec = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[rec + k] = tag.charCodeAt(k);
    view.setUint32(rec + 4, checksum(out, offset, data.length));
    view.setUint32(rec + 8, offset);
    view.setUint32(rec + 12, data.length);
    offset += pad4(data.length);
  });
  if (headOffset >= 0) view.setUint32(headOffset + 8, (0xb1b0afba - checksum(out, 0, total)) >>> 0);
  return out;
}

/** Return a copy of the font without the named tables. */
export function dropTables(input, drop) {
  const { version, tables } = readTables(input);
  for (const tag of drop) tables.delete(tag);
  return writeFont(version, tables);
}

/**
 * Return a copy of the font in which only the outlines of `keep` (glyph IDs,
 * plus glyph 0 and any composite components) remain. All glyph IDs, metrics
 * and the cmap are unchanged.
 */
export function retainGlyphs(input, keep) {
  const { version, tables } = readTables(input);
  const head = tables.get('head');
  const glyf = tables.get('glyf');
  const loca = tables.get('loca');
  const maxp = tables.get('maxp');
  if (!head || !glyf || !loca || !maxp) return input; // not a TrueType-outline font

  const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const numGlyphs = dv(maxp).getUint16(4);
  const longLoca = dv(head).getInt16(50) === 1;
  const lv = dv(loca);
  const off = (g) => (longLoca ? lv.getUint32(g * 4) : lv.getUint16(g * 2) * 2);
  const gv = dv(glyf);

  // Close over composite glyph components.
  const used = new Set([0]);
  const queue = [0, ...keep];
  while (queue.length) {
    const g = queue.pop();
    if (g >= numGlyphs) continue;
    used.add(g);
    const start = off(g), end = off(g + 1);
    if (end - start < 10 || gv.getInt16(start) >= 0) continue; // empty or simple glyph
    let p = start + 10;
    for (;;) {
      const flags = gv.getUint16(p);
      const component = gv.getUint16(p + 2);
      if (!used.has(component)) queue.push(component);
      p += 4 + (flags & 0x1 ? 4 : 2);
      if (flags & 0x8) p += 2;
      else if (flags & 0x40) p += 4;
      else if (flags & 0x80) p += 8;
      if (!(flags & 0x20)) break;
    }
  }

  let size = 0;
  for (const g of used) size += pad4(off(g + 1) - off(g));
  const newGlyf = new Uint8Array(size);
  const newLoca = new Uint8Array((numGlyphs + 1) * 4);
  const nl = dv(newLoca);
  let pos = 0;
  for (let g = 0; g < numGlyphs; g++) {
    nl.setUint32(g * 4, pos);
    if (!used.has(g)) continue;
    const data = glyf.subarray(off(g), off(g + 1));
    newGlyf.set(data, pos);
    pos += pad4(data.length);
  }
  nl.setUint32(numGlyphs * 4, pos);

  const newHead = head.slice();
  dv(newHead).setInt16(50, 1); // long loca offsets
  tables.set('head', newHead);
  tables.set('glyf', newGlyf);
  tables.set('loca', newLoca);
  return writeFont(version, tables);
}
