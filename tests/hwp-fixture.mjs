// Writes a small HWP 5 document for the end-to-end test: a title, a justified
// two-line paragraph and a bordered 2x2 table, with Hangul layout data
// (line segments) the way Hangul stores it.
import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const CFB = require('cfb');

class W {
  constructor() { this.parts = []; }
  u8(v) { const b = Buffer.alloc(1); b.writeUInt8(v & 255); this.parts.push(b); return this; }
  i8(v) { const b = Buffer.alloc(1); b.writeInt8(v); this.parts.push(b); return this; }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); this.parts.push(b); return this; }
  i16(v) { const b = Buffer.alloc(2); b.writeInt16LE(v); this.parts.push(b); return this; }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.parts.push(b); return this; }
  i32(v) { const b = Buffer.alloc(4); b.writeInt32LE(v); this.parts.push(b); return this; }
  str(s) { this.u16(s.length); this.parts.push(Buffer.from(s, 'utf16le')); return this; }
  buf() { return Buffer.concat(this.parts); }
}

const rec = (tag, level, data) => {
  const size = data.length;
  const head = Buffer.alloc(size >= 0xfff ? 8 : 4);
  head.writeUInt32LE((tag | (level << 10) | (Math.min(size, 0xfff) << 20)) >>> 0);
  if (size >= 0xfff) head.writeUInt32LE(size, 4);
  return Buffer.concat([head, data]);
};
const chid = (s) => (s.charCodeAt(0) << 24 | s.charCodeAt(1) << 16 | s.charCodeAt(2) << 8 | s.charCodeAt(3)) >>> 0;

function docInfo() {
  const out = [];
  out.push(rec(16, 0, new W().u16(1).u16(1).u16(1).u16(1).u16(1).u16(1).u16(1).u32(0).u32(0).u32(0).buf()));
  // binData, 7 face lists, borderFill, charShape, tabDef, numbering, bullet, paraShape, style, memo, track, author
  const ids = [0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 0, 0, 2, 0, 0, 0, 0];
  const w = new W();
  ids.forEach((v) => w.i32(v));
  out.push(rec(17, 0, w.buf()));
  for (let lang = 0; lang < 7; lang++) {
    out.push(rec(19, 1, new W().u8(0).str('함초롬바탕').buf()));
    out.push(rec(19, 1, new W().u8(0).str('맑은 고딕').buf()));
  }
  const border = (w, type, width, color) => w.u8(type).u8(width).u32(color);
  // 1: no border, 2: solid black border with light gray fill
  const bf1 = new W().u16(0);
  for (let i = 0; i < 5; i++) border(bf1, 0, 0, 0);
  bf1.u32(0);
  out.push(rec(20, 1, bf1.buf()));
  const bf2 = new W().u16(0);
  for (let i = 0; i < 4; i++) border(bf2, 1, 1, 0x000000);
  border(bf2, 0, 0, 0);
  bf2.u32(1).u32(0x00eeeeee).u32(0).i32(-1);
  out.push(rec(20, 1, bf2.buf()));
  const charShape = (face, size, bold) => {
    const w = new W();
    for (let i = 0; i < 7; i++) w.u16(face);
    for (let i = 0; i < 7; i++) w.u8(100);
    for (let i = 0; i < 7; i++) w.i8(0);
    for (let i = 0; i < 7; i++) w.u8(100);
    for (let i = 0; i < 7; i++) w.i8(0);
    w.i32(size).u32(bold ? 2 : 0).i8(10).i8(10).u32(0).u32(0).u32(0xffffffff).u32(0xb2b2b2).u16(1).u32(0);
    return w.buf();
  };
  out.push(rec(21, 1, charShape(0, 1100, false))); // 0: body 11pt serif
  out.push(rec(21, 1, charShape(1, 1800, true))); // 1: title 18pt bold sans
  out.push(rec(22, 1, new W().u32(0).i32(0).buf()));
  const paraShape = (align) => new W().u32(align << 2).i32(0).i32(0).i32(0).i32(0).i32(0).i32(160).u16(0).u16(0).u16(0)
    .i16(0).i16(0).i16(0).i16(0).u32(0).u32(0).u32(160).buf();
  out.push(rec(25, 1, paraShape(0))); // 0: justify
  out.push(rec(25, 1, paraShape(3))); // 1: center
  return Buffer.concat(out);
}

/** A paragraph: text units (strings or control placeholders), line segments, children records. */
function paragraph(level, { paraShape = 0, charShape = 0, units, segs, controls = [] }) {
  const text = new W();
  let n = 0;
  for (const u of units) {
    if (typeof u === 'string') { for (const ch of u) { text.u16(ch.charCodeAt(0)); n++; } } else {
      // Extended control: code, ctrl id (2 units), 4 reserved units, code again.
      text.u16(u.code).u32(chid(u.id)).u16(0).u16(0).u16(0).u16(0).u16(u.code);
      n += 8;
    }
  }
  text.u16(13);
  n++;
  const out = [rec(66, level, new W().u32(n).u32(0).u16(paraShape).u8(0).u8(0).u16(1).u16(0).u16(segs.length).u32(0).buf())];
  out.push(rec(67, level + 1, text.buf()));
  out.push(rec(68, level + 1, new W().u32(0).u32(charShape).buf()));
  const ls = new W();
  for (const s of segs) ls.i32(s.pos).i32(s.y).i32(s.h).i32(s.h).i32(Math.round(s.h * 0.85)).i32(s.sp ?? 0).i32(s.x ?? 0).i32(s.w).u32(0x60000);
  out.push(rec(69, level + 1, ls.buf()));
  for (const c of controls) out.push(c(level + 1));
  return Buffer.concat(out);
}

function section() {
  const pageDef = new W().u32(59528).u32(84188).u32(8504).u32(8504).u32(5668).u32(4252).u32(4252).u32(4252).u32(0).u32(0).buf();
  const secd = (level) => Buffer.concat([
    rec(71, level, new W().u32(chid('secd')).u32(0).i16(1134).i16(0).i16(0).u32(8000).u16(0).u16(0).u16(0).u16(0).u16(0).u32(0).u32(0).buf()),
    rec(73, level + 1, pageDef),
  ]);
  const W_BODY = 42520;
  const p0 = paragraph(0, {
    paraShape: 1, charShape: 1, units: [{ code: 2, id: 'secd' }, '한글 문서 변환 테스트'],
    segs: [{ pos: 0, y: 0, h: 1800, w: W_BODY }], controls: [secd],
  });
  const body = '이 문서는 자동 테스트를 위해 만든 한글 파일입니다. 한글이 저장한 줄 배치 정보에 따라 두 줄로 나뉘며 양쪽 정렬로 표시됩니다.';
  const p1 = paragraph(0, { units: [body], segs: [{ pos: 0, y: 3200, h: 1100, w: W_BODY, sp: 660 }, { pos: 38, y: 4960, h: 1100, w: W_BODY }] });
  // 2x2 table, inline ("treat as character"), 40000 x 4000 HWPUNIT.
  const cellW = 20000, cellH = 2000;
  const cell = (row, col, text, level) => Buffer.concat([
    rec(72, level, new W().u16(1).u16(0).u32(1 << 5).u16(col).u16(row).u16(1).u16(1).u32(cellW).u32(cellH).i16(510).i16(510).i16(141).i16(141).u16(2).u32(cellW - 1020).buf()),
    paragraph(level, { units: [text], segs: [{ pos: 0, y: 0, h: 1100, w: cellW - 1020 }] }),
  ]);
  const table = (level) => Buffer.concat([
    rec(71, level, new W().u32(chid('tbl ')).u32(1 | (2 << 3) | (3 << 8) | (1 << 21)).i32(0).i32(0).u32(cellW * 2).u32(cellH * 2).i32(0).i16(0).i16(0).i16(0).i16(0).u32(1).buf()),
    rec(77, level + 1, new W().u32(2).u16(2).u16(2).i16(0).i16(510).i16(510).i16(141).i16(141).u16(2).u16(2).u16(1).buf()),
    cell(0, 0, '신청인', level + 1), cell(0, 1, '홍길동', level + 1),
    cell(1, 0, '연락처', level + 1), cell(1, 1, '010-0000-0000', level + 1),
  ]);
  const p2 = paragraph(0, { units: [{ code: 11, id: 'tbl ' }], segs: [{ pos: 0, y: 7300, h: cellH * 2, w: W_BODY }], controls: [table] });
  return Buffer.concat([p0, p1, p2]);
}

export function makeHwp() {
  const header = Buffer.alloc(256);
  header.write('HWP Document File', 0, 'latin1');
  header.writeUInt32LE(0x05010000, 32);
  header.writeUInt32LE(1, 36); // compressed
  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, '/FileHeader', header);
  CFB.utils.cfb_add(cfb, '/DocInfo', deflateRawSync(docInfo()));
  CFB.utils.cfb_add(cfb, '/BodyText/Section0', deflateRawSync(section()));
  return new Uint8Array(CFB.write(cfb, { type: 'buffer' }));
}
