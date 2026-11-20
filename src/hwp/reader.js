// Low-level readers for HWP 5.x binary documents: the compound file
// container, compressed streams and the record format.
//
// This program was developed with reference to the HWP document file (.hwp)
// format specification published by Hancom Inc.
// 본 제품은 한글과컴퓨터의 한/글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
import CFB from 'cfb';
import { inflateSync } from 'fflate';

export class HwpError extends Error {}

/** Opens the compound file and returns a stream lookup by path ("BodyText/Section0"). */
export function openContainer(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] !== 0xd0 || u8[1] !== 0xcf || u8[2] !== 0x11 || u8[3] !== 0xe0) {
    if (u8[0] === 0x50 && u8[1] === 0x4b) throw new HwpError('HWPX(개방형 한글 문서) 형식은 아직 지원하지 않습니다.');
    const head = new TextDecoder('latin1').decode(u8.subarray(0, 32));
    if (head.startsWith('HWP Document File V')) throw new HwpError('한글 97 이전(HWP 3.x) 문서는 지원하지 않습니다. 한글에서 최신 형식으로 다시 저장해 주세요.');
    throw new HwpError('HWP 문서가 아니거나 손상된 파일입니다.');
  }
  const cfb = CFB.read(u8, { type: 'array' });
  const streams = new Map();
  cfb.FullPaths.forEach((p, i) => {
    const entry = cfb.FileIndex[i];
    if (entry.type === 2 && entry.content) streams.set(p.replace(/^[^/]*\//, ''), toU8(entry.content));
  });
  return streams;
}

function toU8(c) {
  return c instanceof Uint8Array ? c : Uint8Array.from(c);
}

/** HWP streams are raw-deflate compressed when the file header says so. */
export function inflate(data) {
  return inflateSync(data);
}

export class ByteReader {
  constructor(u8, offset = 0, end = u8.length) {
    this.u8 = u8;
    this.view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.pos = offset;
    this.end = end;
  }
  get remaining() { return this.end - this.pos; }
  ok(n) { return this.pos + n <= this.end; }
  u8v() { return this.ok(1) ? this.view.getUint8(this.pos++) : 0; }
  i8() { const v = this.ok(1) ? this.view.getInt8(this.pos) : 0; this.pos += 1; return v; }
  u16() { const v = this.ok(2) ? this.view.getUint16(this.pos, true) : 0; this.pos += 2; return v; }
  i16() { const v = this.ok(2) ? this.view.getInt16(this.pos, true) : 0; this.pos += 2; return v; }
  u32() { const v = this.ok(4) ? this.view.getUint32(this.pos, true) : 0; this.pos += 4; return v; }
  i32() { const v = this.ok(4) ? this.view.getInt32(this.pos, true) : 0; this.pos += 4; return v; }
  f64() { const v = this.ok(8) ? this.view.getFloat64(this.pos, true) : 0; this.pos += 8; return v; }
  skip(n) { this.pos += n; }
  bytes(n) { const b = this.u8.subarray(this.pos, Math.min(this.pos + n, this.end)); this.pos += n; return b; }
  /** Length-prefixed UTF-16LE string. */
  bstr() {
    const n = this.u16();
    if (!this.ok(n * 2)) { this.pos = this.end; return ''; }
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.view.getUint16(this.pos + i * 2, true));
    this.pos += n * 2;
    return s;
  }
  /** COLORREF (0x00BBGGRR) -> "#rrggbb", or null when "no color" (high byte set). */
  color() {
    const v = this.u32();
    if (v >>> 24) return null;
    const r = v & 255, g = (v >> 8) & 255, b = (v >> 16) & 255;
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
  }
}

/**
 * Splits a stream into records: { tag, level, data }.
 * Header: 10-bit tag, 10-bit level, 12-bit size (0xfff = size follows as u32).
 */
export function readRecords(u8) {
  const out = [];
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 0;
  while (p + 4 <= u8.length) {
    const h = view.getUint32(p, true);
    p += 4;
    const tag = h & 0x3ff;
    const level = (h >>> 10) & 0x3ff;
    let size = h >>> 20;
    if (size === 0xfff) {
      if (p + 4 > u8.length) break;
      size = view.getUint32(p, true);
      p += 4;
    }
    if (p + size > u8.length) size = u8.length - p;
    out.push({ tag, level, data: u8.subarray(p, p + size) });
    p += size;
  }
  return out;
}

/** Builds a tree from the flat, level-annotated record list. */
export function recordTree(records) {
  const root = { tag: -1, level: -1, children: [] };
  const stack = [root];
  for (const r of records) {
    const node = { tag: r.tag, level: r.level, data: r.data, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= r.level) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

export const TAG = {
  DOCUMENT_PROPERTIES: 16,
  ID_MAPPINGS: 17,
  BIN_DATA: 18,
  FACE_NAME: 19,
  BORDER_FILL: 20,
  CHAR_SHAPE: 21,
  TAB_DEF: 22,
  NUMBERING: 23,
  BULLET: 24,
  PARA_SHAPE: 25,
  STYLE: 26,
  PARA_HEADER: 66,
  PARA_TEXT: 67,
  PARA_CHAR_SHAPE: 68,
  PARA_LINE_SEG: 69,
  PARA_RANGE_TAG: 70,
  CTRL_HEADER: 71,
  LIST_HEADER: 72,
  PAGE_DEF: 73,
  FOOTNOTE_SHAPE: 74,
  PAGE_BORDER_FILL: 75,
  SHAPE_COMPONENT: 76,
  TABLE: 77,
  SHAPE_COMPONENT_LINE: 78,
  SHAPE_COMPONENT_RECTANGLE: 79,
  SHAPE_COMPONENT_ELLIPSE: 80,
  SHAPE_COMPONENT_ARC: 81,
  SHAPE_COMPONENT_POLYGON: 82,
  SHAPE_COMPONENT_CURVE: 83,
  SHAPE_COMPONENT_OLE: 84,
  SHAPE_COMPONENT_PICTURE: 85,
  SHAPE_COMPONENT_CONTAINER: 86,
  CTRL_DATA: 87,
  EQEDIT: 88,
  SHAPE_COMPONENT_TEXTART: 90,
};

/** Four-character control ids are stored as a big-endian u32. */
export function ctrlId(u32) {
  return String.fromCharCode((u32 >>> 24) & 255, (u32 >>> 16) & 255, (u32 >>> 8) & 255, u32 & 255);
}
