// Parses an HWP 5.x document into a plain object model used by layout.js.
//
// Units: HWPUNIT = 1/7200 inch (100 per point). Positions in the model keep
// HWPUNIT; the layout converts to points.
import { ByteReader, HwpError, TAG, ctrlId, inflate, openContainer, readRecords, recordTree } from './reader.js';

const LANGS = 7; // 한글, 영어, 한자, 일어, 기타, 기호, 사용자

export function parseHwp(bytes) {
  const streams = openContainer(bytes);
  const header = streams.get('FileHeader');
  if (!header) throw new HwpError('HWP 문서가 아니거나 손상된 파일입니다.');
  const sig = new TextDecoder('latin1').decode(header.subarray(0, 32)).replace(/\0+$/, '');
  if (!sig.startsWith('HWP Document File')) throw new HwpError('HWP 문서가 아니거나 손상된 파일입니다.');
  const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const v = hv.getUint32(32, true);
  const version = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const flags = hv.getUint32(36, true);
  const compressed = !!(flags & 1);
  if (flags & 2) throw new HwpError('암호가 걸린 HWP 문서입니다. 한글에서 암호를 해제한 뒤 열어 주세요.');
  if (flags & 4) throw new HwpError('배포용(편집·복사 제한) HWP 문서는 열 수 없습니다.');
  if (flags & 16) throw new HwpError('DRM으로 보호된 HWP 문서는 열 수 없습니다.');

  const read = (name) => {
    const s = streams.get(name);
    if (!s) return null;
    return compressed ? inflate(s) : s;
  };
  const docInfoBytes = read('DocInfo');
  if (!docInfoBytes) throw new HwpError('문서 정보(DocInfo)를 찾을 수 없습니다.');
  const doc = { version, compressed, ...parseDocInfo(readRecords(docInfoBytes)) };
  doc.sections = [];
  for (let i = 0; ; i++) {
    const s = read(`BodyText/Section${i}`);
    if (!s) break;
    doc.sections.push(parseSection(recordTree(readRecords(s)), doc));
  }
  if (!doc.sections.length) throw new HwpError('본문이 없는 문서입니다.');
  // Embedded images: BinData/BIN0001.png etc.
  doc.binData.forEach((b) => {
    if (b.type !== 'embed') return;
    const name = `BinData/BIN${b.id.toString(16).toUpperCase().padStart(4, '0')}.${b.ext}`;
    const raw = streams.get(name) || [...streams.entries()].find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    if (!raw) return;
    const compress = b.compression === 1 || (b.compression === 0 && compressed);
    try {
      b.bytes = compress ? inflate(raw) : raw;
    } catch {
      b.bytes = raw; // some writers store images uncompressed regardless of the flag
    }
  });
  return doc;
}

// ---------------------------------------------------------------------------
// DocInfo
// ---------------------------------------------------------------------------

function parseDocInfo(records) {
  const out = {
    binData: [], faces: Array.from({ length: LANGS }, () => []), borderFills: [], charShapes: [],
    tabDefs: [], numberings: [], bullets: [], paraShapes: [], styles: [],
  };
  let faceCounts = null;
  let faceIndex = 0;
  for (const r of records) {
    const b = new ByteReader(r.data);
    switch (r.tag) {
      case TAG.ID_MAPPINGS: {
        const counts = [];
        while (b.remaining >= 4) counts.push(b.i32());
        faceCounts = counts.slice(1, 1 + LANGS);
        break;
      }
      case TAG.BIN_DATA: {
        const f = b.u16();
        const kind = f & 15;
        const item = { compression: (f >> 4) & 3 };
        if (kind === 0) Object.assign(item, { type: 'link', abs: b.bstr(), rel: b.bstr() });
        else if (kind === 1) Object.assign(item, { type: 'embed', id: b.u16(), ext: b.bstr().toLowerCase() });
        else Object.assign(item, { type: 'storage', id: b.u16() });
        out.binData.push(item);
        break;
      }
      case TAG.FACE_NAME: {
        const f = b.u8v();
        const face = { name: b.bstr() };
        if (f & 0x80) { b.u8v(); face.alt = b.bstr(); }
        if (f & 0x40) face.panose = Array.from(b.bytes(10));
        if (f & 0x20) face.base = b.bstr();
        // Faces are listed language by language, in ID_MAPPINGS order.
        let lang = 0, idx = faceIndex++;
        if (faceCounts) {
          while (lang < LANGS - 1 && idx >= faceCounts[lang]) { idx -= faceCounts[lang]; lang++; }
        }
        out.faces[lang].push(face);
        break;
      }
      case TAG.BORDER_FILL:
        out.borderFills.push(parseBorderFill(b));
        break;
      case TAG.CHAR_SHAPE:
        out.charShapes.push(parseCharShape(b));
        break;
      case TAG.TAB_DEF: {
        const attr = b.u32();
        const n = b.i32();
        const tabs = [];
        for (let i = 0; i < n && b.remaining >= 8; i++) {
          tabs.push({ pos: b.i32(), type: b.u8v(), fill: b.u8v() });
          b.u16();
        }
        out.tabDefs.push({ attr, tabs });
        break;
      }
      case TAG.NUMBERING:
        out.numberings.push(parseNumbering(b));
        break;
      case TAG.BULLET:
        out.bullets.push(parseBullet(b));
        break;
      case TAG.PARA_SHAPE:
        out.paraShapes.push(parseParaShape(b));
        break;
      case TAG.STYLE: {
        out.styles.push({ name: b.bstr(), en: b.bstr(), kind: b.u8v(), next: b.u8v(), lang: b.i16(), paraShape: b.u16(), charShape: b.u16() });
        break;
      }
    }
  }
  return out;
}

const BORDER_WIDTHS_MM = [0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];

function readBorder(b) {
  const type = b.u8v();
  const w = b.u8v();
  const color = b.color() || '#000000';
  return { type, width: (BORDER_WIDTHS_MM[w] ?? 0.12) * 72 / 25.4, color };
}

export function readFill(b) {
  const kind = b.u32();
  const fill = {};
  if (kind & 1) {
    fill.color = b.color();
    fill.patternColor = b.color();
    fill.pattern = b.i32(); // -1/255 none, 0 horizontal, 1 vertical, 2 backslash, 3 slash, 4 grid, 5 cross
  }
  if (kind & 4) {
    const type = b.i16(), angle = b.i16(), cx = b.i16(), cy = b.i16(), step = b.i16(), n = b.i16();
    const colors = [];
    for (let i = 0; i < Math.max(0, Math.min(n, 64)); i++) colors.push(b.color() || '#ffffff');
    fill.gradient = { type, angle, cx, cy, step, colors };
  }
  if (kind & 2) {
    fill.image = { mode: b.u8v(), brightness: b.i8(), contrast: b.i8(), effect: b.u8v(), binId: b.u16() };
  }
  return fill;
}

function parseBorderFill(b) {
  const attr = b.u16();
  const left = readBorder(b), right = readBorder(b), top = readBorder(b), bottom = readBorder(b), diagonal = readBorder(b);
  const fill = b.remaining >= 4 ? readFill(b) : {};
  return { attr, left, right, top, bottom, diagonal, slash: (attr >> 2) & 7, backslash: (attr >> 5) & 7, fill };
}

function parseCharShape(b) {
  const arr = (fn) => Array.from({ length: LANGS }, fn);
  const faceIds = arr(() => b.u16());
  const ratio = arr(() => b.u8v());
  const spacing = arr(() => b.i8());
  const relSize = arr(() => b.u8v());
  const offset = arr(() => b.i8());
  const size = b.i32();
  const f = b.u32();
  const shadowX = b.i8(), shadowY = b.i8();
  const color = b.color() || '#000000';
  const underlineColor = b.color() || color;
  const shadeColor = b.color();
  const shadowColor = b.color();
  const borderFillId = b.remaining >= 2 ? b.u16() : 0;
  const strikeColor = b.remaining >= 4 ? b.color() : color;
  return {
    faceIds, ratio, spacing, relSize, offset, size,
    italic: !!(f & 1), bold: !!(f & 2),
    underline: (f >> 2) & 3, underlineShape: (f >> 4) & 15,
    outline: (f >> 8) & 7, shadow: (f >> 11) & 3,
    emboss: !!(f & (1 << 13)), engrave: !!(f & (1 << 14)),
    superscript: !!(f & (1 << 15)), subscript: !!(f & (1 << 16)),
    strike: (f >> 18) & 7, emphasis: (f >> 21) & 15,
    shadowX, shadowY, color, underlineColor, shadeColor, shadowColor, borderFillId, strikeColor,
  };
}

function parseParaShape(b) {
  const f1 = b.u32();
  const p = {
    align: (f1 >> 2) & 7, // 0 justify, 1 left, 2 right, 3 center, 4 distribute, 5 split
    lineSpacingType: f1 & 3, // 0 percent, 1 fixed, 2 space only, 3 at least
    breakLatin: (f1 >> 5) & 3,
    breakHangul: (f1 >> 7) & 1,
    widowOrphan: !!(f1 & (1 << 16)),
    keepWithNext: !!(f1 & (1 << 17)),
    pageBreakBefore: !!(f1 & (1 << 19)),
    vAlign: (f1 >> 20) & 3,
    headShape: (f1 >> 23) & 3, // 0 none, 1 outline, 2 number, 3 bullet
    level: (f1 >> 25) & 7,
    marginLeft: b.i32(),
    marginRight: b.i32(),
    indent: b.i32(),
    spaceBefore: b.i32(),
    spaceAfter: b.i32(),
    lineSpacing: b.i32(),
    tabDefId: b.u16(),
    numberingId: b.u16(),
    borderFillId: b.u16(),
    borderSpace: [b.i16(), b.i16(), b.i16(), b.i16()],
  };
  if (b.remaining >= 4) p.flags2 = b.u32();
  if (b.remaining >= 4) {
    p.lineSpacingType = b.u32() & 31;
    if (b.remaining >= 4) p.lineSpacing = b.u32();
  }
  return p;
}

function readParaHead(b) {
  const attr = b.u32();
  const head = {
    align: attr & 3, // 0 left, 1 center, 2 right
    useInstanceWidth: !!(attr & 4),
    autoIndent: !!(attr & 8),
    distanceType: (attr >> 4) & 1,
    width: b.i16(),
    offset: b.i16(),
    charShapeId: b.u32(),
  };
  return head;
}

function parseNumbering(b) {
  const levels = [];
  for (let i = 0; i < 7 && b.remaining > 12; i++) {
    const h = readParaHead(b);
    h.format = b.bstr();
    levels.push(h);
  }
  const start = b.remaining >= 2 ? b.u16() : 1;
  const starts = [];
  for (let i = 0; i < 7 && b.remaining >= 4; i++) starts.push(b.u32());
  return { levels, start, starts };
}

function parseBullet(b) {
  const h = readParaHead(b);
  h.char = b.remaining >= 2 ? String.fromCharCode(b.u16()) : '•';
  return h;
}

// ---------------------------------------------------------------------------
// Body text
// ---------------------------------------------------------------------------

// Characters that take one code unit vs. eight (inline/extended controls).
const CHAR_CONTROLS = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31]);
const EXTENDED = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);

function parseSection(nodes, doc) {
  const section = { paragraphs: [], pageDef: null, pageBorderFills: [], footnoteShape: null };
  section.paragraphs = parseParagraphList(nodes, doc, section);
  return section;
}

/** Interprets sibling nodes: PARA_HEADER nodes are paragraphs. */
function parseParagraphList(nodes, doc, section) {
  const out = [];
  for (const n of nodes) if (n.tag === TAG.PARA_HEADER) out.push(parseParagraph(n, doc, section));
  return out;
}

function parseParagraph(node, doc, section) {
  const b = new ByteReader(node.data);
  let nChars = b.u32() & 0x7fffffff;
  b.u32(); // control mask
  const para = {
    paraShapeId: b.u16(),
    styleId: b.u8v(),
    breakType: b.u8v(), // bit0 section, 1 columns, 2 page, 3 column
    text: [], // [{ pos, ch }] for printable characters / char controls
    controls: [], // [{ pos, code, ctrl }]
    charShapes: [],
    lineSegs: [],
  };
  const ctrlNodes = [];
  for (const c of node.children) {
    switch (c.tag) {
      case TAG.PARA_TEXT: parseText(c.data, para); break;
      case TAG.PARA_CHAR_SHAPE: {
        const r = new ByteReader(c.data);
        while (r.remaining >= 8) para.charShapes.push({ pos: r.u32(), id: r.u32() });
        break;
      }
      case TAG.PARA_LINE_SEG: {
        const r = new ByteReader(c.data);
        while (r.remaining >= 36) {
          para.lineSegs.push({
            pos: r.i32(), y: r.i32(), height: r.i32(), textHeight: r.i32(), baseline: r.i32(),
            spacing: r.i32(), x: r.i32(), width: r.i32(), flags: r.u32(),
          });
        }
        break;
      }
      case TAG.CTRL_HEADER: ctrlNodes.push(c); break;
    }
  }
  if (!para.charShapes.length) para.charShapes.push({ pos: 0, id: 0 });
  // Extended control characters and CTRL_HEADER records appear in the same order.
  const ext = para.controls.filter((c) => EXTENDED.has(c.code));
  ext.forEach((c, i) => {
    const n = ctrlNodes[i];
    if (n) c.ctrl = parseControl(n, doc, section);
  });
  // Controls without a placeholder character (rare) are kept for layout.
  for (let i = ext.length; i < ctrlNodes.length; i++) para.controls.push({ pos: nChars, code: -1, ctrl: parseControl(ctrlNodes[i], doc, section) });
  para.length = nChars;
  return para;
}

function parseText(u8, para) {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = u8.length >> 1;
  for (let i = 0; i < n;) {
    const ch = view.getUint16(i * 2, true);
    if (ch < 32) {
      if (CHAR_CONTROLS.has(ch)) {
        para.text.push({ pos: i, ch: String.fromCharCode(ch), code: ch });
        i += 1;
      } else {
        const info = { pos: i, code: ch };
        if (ch === 9 && i + 8 <= n) {
          // Tab: width (HWPUNIT) as laid out by Hangul, then leader type.
          info.width = view.getUint32((i + 1) * 2, true);
          info.leader = view.getUint16((i + 3) * 2, true) & 0xff;
        }
        para.controls.push(info);
        if (ch === 9) para.text.push({ pos: i, ch: '\t', code: 9, tab: info });
        i += 8;
      }
    } else {
      // Keep surrogate pairs together.
      let s = String.fromCharCode(ch);
      if (ch >= 0xd800 && ch < 0xdc00 && i + 1 < n) {
        const lo = view.getUint16((i + 1) * 2, true);
        if (lo >= 0xdc00 && lo < 0xe000) {
          s += String.fromCharCode(lo);
          para.text.push({ pos: i, ch: s, units: 2 });
          i += 2;
          continue;
        }
      }
      para.text.push({ pos: i, ch: s });
      i += 1;
    }
  }
}

function readCommon(b) {
  const attr = b.u32();
  return {
    attr,
    inline: !!(attr & 1), // 글자처럼 취급
    affectLineSpacing: !!(attr & 4),
    vertRelTo: (attr >> 3) & 3, // 0 paper, 1 page, 2 paragraph
    vertAlign: (attr >> 5) & 7, // 0 top, 1 center, 2 bottom, 3 inside, 4 outside
    horzRelTo: (attr >> 8) & 3, // 0 paper, 1 page, 2 column, 3 paragraph
    horzAlign: (attr >> 10) & 7, // 0 left, 1 center, 2 right, 3 inside, 4 outside
    flowWithText: !!(attr & (1 << 13)),
    allowOverlap: !!(attr & (1 << 14)),
    widthRelTo: (attr >> 15) & 7,
    heightRelTo: (attr >> 18) & 3,
    textWrap: (attr >> 21) & 7, // 0 square, 1 top&bottom, 2 behind text, 3 in front of text
    textFlow: (attr >> 24) & 3,
    y: b.i32(),
    x: b.i32(),
    width: b.u32(),
    height: b.u32(),
    z: b.i32(),
    margin: [b.i16(), b.i16(), b.i16(), b.i16()], // left, right, top, bottom
    instanceId: b.u32(),
  };
}

function parseControl(node, doc, section) {
  const b = new ByteReader(node.data);
  const id = ctrlId(b.u32());
  const ctrl = { id };
  switch (id) {
    case 'secd': {
      ctrl.attr = b.u32();
      ctrl.columnGap = b.i16();
      b.i16(); b.i16();
      ctrl.defaultTab = b.u32();
      ctrl.numberingId = b.u16();
      ctrl.pageStart = b.u16();
      for (const c of node.children) {
        const r = new ByteReader(c.data);
        if (c.tag === TAG.PAGE_DEF) {
          const pd = {
            width: r.u32(), height: r.u32(),
            left: r.u32(), right: r.u32(), top: r.u32(), bottom: r.u32(),
            header: r.u32(), footer: r.u32(), gutter: r.u32(), attr: r.u32(),
          };
          pd.landscape = !!(pd.attr & 1);
          section.pageDef ||= pd;
          ctrl.pageDef = pd;
        } else if (c.tag === TAG.FOOTNOTE_SHAPE) {
          section.footnoteShape ||= { raw: true };
        } else if (c.tag === TAG.PAGE_BORDER_FILL) {
          const f = r.u32();
          section.pageBorderFills.push({
            relToPaper: !!(f & 1), includeHeader: !!(f & 2), includeFooter: !!(f & 4), fillArea: (f >> 3) & 3,
            margin: [r.i16(), r.i16(), r.i16(), r.i16()], borderFillId: r.u16(),
          });
        }
      }
      ctrl.hideFirstHeader = !!(ctrl.attr & 1);
      ctrl.hideFirstFooter = !!(ctrl.attr & 2);
      ctrl.hideFirstPageNum = !!(ctrl.attr & 4);
      ctrl.hideFirstBorder = !!(ctrl.attr & 8);
      section.secd ||= ctrl;
      break;
    }
    case 'cold': {
      const a = b.u16();
      ctrl.type = a & 3;
      ctrl.count = Math.max(1, (a >> 2) & 0xff);
      ctrl.direction = (a >> 10) & 3;
      ctrl.sameWidth = !!(a & (1 << 12));
      ctrl.gap = b.i16();
      ctrl.widths = [];
      if (!ctrl.sameWidth) for (let i = 0; i < ctrl.count; i++) ctrl.widths.push(b.u16());
      b.u16();
      ctrl.line = { type: b.u8v(), width: (BORDER_WIDTHS_MM[b.u8v()] ?? 0.12) * 72 / 25.4, color: b.color() || '#000000' };
      break;
    }
    case 'head':
    case 'foot': {
      const attr = b.u32();
      ctrl.applyTo = attr & 3; // 0 both, 1 even, 2 odd
      ctrl.paragraphs = listParagraphs(node.children, doc, section).paragraphs;
      break;
    }
    case 'fn  ':
    case 'en  ': {
      ctrl.number = b.u32();
      ctrl.paragraphs = listParagraphs(node.children, doc, section).paragraphs;
      break;
    }
    case 'atno':
    case 'nwno': {
      const attr = b.u32();
      ctrl.kind = attr & 15; // 0 page, 1 footnote, 2 endnote, 3 picture, 4 table, 5 equation
      ctrl.format = (attr >> 4) & 0xff;
      ctrl.number = b.u16();
      ctrl.userChar = b.u16();
      ctrl.prefix = b.u16();
      ctrl.suffix = b.u16();
      break;
    }
    case 'pgnp': {
      const attr = b.u32();
      ctrl.format = attr & 0xff;
      ctrl.position = (attr >> 8) & 15;
      ctrl.userChar = b.u16();
      ctrl.prefix = b.u16();
      ctrl.suffix = b.u16();
      ctrl.dash = b.u16();
      section.pageNumber = ctrl;
      break;
    }
    case 'pghd': {
      const attr = b.u32();
      ctrl.hideHeader = !!(attr & 1);
      ctrl.hideFooter = !!(attr & 2);
      ctrl.hideBorder = !!(attr & 8);
      ctrl.hideFill = !!(attr & 16);
      ctrl.hidePageNum = !!(attr & 32);
      break;
    }
    case 'tbl ':
      Object.assign(ctrl, readCommon(b), parseTable(node.children, doc, section));
      break;
    case 'gso ':
      Object.assign(ctrl, readCommon(b));
      ctrl.caption = captionOf(node.children, doc, section);
      ctrl.shape = parseShapeNodes(node.children.filter((c) => c.tag === TAG.SHAPE_COMPONENT), doc, section, true)[0] || null;
      break;
    case 'eqed':
      Object.assign(ctrl, readCommon(b));
      for (const c of node.children) {
        if (c.tag === TAG.EQEDIT) {
          const r = new ByteReader(c.data);
          r.u32();
          ctrl.script = r.bstr();
          ctrl.size = r.u32();
          ctrl.color = r.color() || '#000000';
        }
      }
      break;
    default:
      if (id.startsWith('%')) {
        ctrl.field = true;
        ctrl.attr = b.u32();
      }
  }
  return ctrl;
}

/** A LIST_HEADER followed by its paragraphs among sibling nodes. */
function listParagraphs(nodes, doc, section, start = 0) {
  const i = nodes.findIndex((n, k) => k >= start && n.tag === TAG.LIST_HEADER);
  if (i < 0) return { header: null, paragraphs: [], next: start };
  const lh = nodes[i];
  const count = new ByteReader(lh.data).i16();
  const paras = [];
  let k = i + 1;
  // Paragraphs are either siblings of the list header or its children.
  const pool = lh.children.some((c) => c.tag === TAG.PARA_HEADER) ? lh.children : null;
  if (pool) {
    for (const c of pool) if (c.tag === TAG.PARA_HEADER) paras.push(parseParagraph(c, doc, section));
  } else {
    while (k < nodes.length && nodes[k].tag === TAG.PARA_HEADER && paras.length < Math.max(count, 1)) {
      paras.push(parseParagraph(nodes[k], doc, section));
      k++;
    }
  }
  return { header: lh, paragraphs: paras, next: k };
}

function captionOf(nodes, doc, section) {
  const first = nodes.findIndex((n) => n.tag === TAG.LIST_HEADER);
  const shapeAt = nodes.findIndex((n) => n.tag === TAG.SHAPE_COMPONENT || n.tag === TAG.TABLE);
  if (first < 0 || (shapeAt >= 0 && first > shapeAt)) return null;
  const { header, paragraphs } = listParagraphs(nodes, doc, section, first);
  const b = new ByteReader(header.data);
  b.u16(); b.u16(); b.u32();
  const attr = b.u32();
  return { side: attr & 3, fullWidth: !!(attr & 4), width: b.u32(), gap: b.i16(), maxWidth: b.u32(), paragraphs };
}

function parseTable(nodes, doc, section) {
  const t = { cells: [], caption: null };
  let k = 0;
  const tableIdx = nodes.findIndex((n) => n.tag === TAG.TABLE);
  if (tableIdx > 0) t.caption = captionOf(nodes.slice(0, tableIdx), doc, section);
  if (tableIdx >= 0) {
    const b = new ByteReader(nodes[tableIdx].data);
    const attr = b.u32();
    t.splitMode = attr & 3; // 0 no split, 1 split by cell, 2 split
    t.repeatHeader = !!(attr & 4);
    t.rows = b.u16();
    t.cols = b.u16();
    t.cellSpacing = b.i16();
    t.padding = [b.i16(), b.i16(), b.i16(), b.i16()];
    t.rowCounts = [];
    for (let i = 0; i < t.rows; i++) t.rowCounts.push(b.u16());
    t.borderFillId = b.u16();
    k = tableIdx + 1;
  }
  while (k < nodes.length) {
    if (nodes[k].tag !== TAG.LIST_HEADER) { k++; continue; }
    const { header, paragraphs, next } = listParagraphs(nodes, doc, section, k);
    const b = new ByteReader(header.data);
    b.u16(); b.u16();
    const attr = b.u32();
    const cell = {
      vAlign: (attr >> 5) & 3, // 0 top, 1 center, 2 bottom
      col: b.u16(), row: b.u16(), colSpan: b.u16(), rowSpan: b.u16(),
      width: b.u32(), height: b.u32(),
      padding: [b.i16(), b.i16(), b.i16(), b.i16()],
      borderFillId: b.u16(),
      paragraphs,
    };
    t.cells.push(cell);
    k = Math.max(next, k + 1);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Drawing objects
// ---------------------------------------------------------------------------

function readMatrix(b) {
  const a = b.f64(), c = b.f64(), e = b.f64(), bb = b.f64(), d = b.f64(), f = b.f64();
  return [a, bb, c, d, e, f]; // canvas order
}

export function mulMatrix(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function readLineInfo(b) {
  const color = b.color();
  const width = b.i32();
  const attr = b.u32();
  return { color, width, type: attr & 63, endCap: (attr >> 6) & 15, arrowStart: (attr >> 10) & 63, arrowEnd: (attr >> 16) & 63 };
}

function parseShapeNodes(nodes, doc, section, topLevel) {
  const shapes = [];
  for (const node of nodes) {
    if (node.tag !== TAG.SHAPE_COMPONENT) continue;
    const b = new ByteReader(node.data);
    let kind = ctrlId(b.u32());
    if (topLevel) {
      const second = ctrlId(b.u32());
      if (second.startsWith('$')) kind = second;
    }
    const s = {
      kind, // $pic $rec $lin $ell $pol $cur $arc $con $ole
      xInGroup: b.i32(), yInGroup: b.i32(), groupLevel: b.u16(), localVersion: b.u16(),
      initWidth: b.u32(), initHeight: b.u32(), width: b.u32(), height: b.u32(),
    };
    const flags = b.u32();
    s.flipH = !!(flags & 1);
    s.flipV = !!(flags & 2);
    s.angle = b.i16();
    s.center = [b.i32(), b.i32()];
    const nMat = b.u16();
    let m = readMatrix(b);
    for (let i = 0; i < nMat; i++) {
      const scale = readMatrix(b);
      const rot = readMatrix(b);
      m = mulMatrix(m, mulMatrix(scale, rot));
    }
    s.matrix = m;
    if (kind === '$con') {
      const n = b.u16();
      b.skip(n * 4);
      s.children = parseShapeNodes(node.children, doc, section, false);
    } else if (kind !== '$pic' && kind !== '$ole') {
      if (b.remaining >= 13) {
        s.line = readLineInfo(b);
        b.u8v(); // outline style
        if (b.remaining >= 4) s.fill = readFill(b);
      }
    }
    for (const c of node.children) {
      const r = new ByteReader(c.data);
      switch (c.tag) {
        case TAG.SHAPE_COMPONENT_PICTURE: {
          s.line = readLineInfo(r);
          s.imageRect = [r.i32(), r.i32(), r.i32(), r.i32(), r.i32(), r.i32(), r.i32(), r.i32()];
          s.crop = { left: r.i32(), top: r.i32(), right: r.i32(), bottom: r.i32() };
          s.padding = [r.i16(), r.i16(), r.i16(), r.i16()];
          s.brightness = r.i8();
          s.contrast = r.i8();
          s.effect = r.u8v(); // 0 normal, 1 grayscale, 2 black & white
          s.binId = r.u16();
          break;
        }
        case TAG.SHAPE_COMPONENT_LINE:
          s.points = [[r.i32(), r.i32()], [r.i32(), r.i32()]];
          break;
        case TAG.SHAPE_COMPONENT_RECTANGLE:
          s.round = r.u8v();
          s.points = [[r.i32(), r.i32()], [r.i32(), r.i32()], [r.i32(), r.i32()], [r.i32(), r.i32()]];
          break;
        case TAG.SHAPE_COMPONENT_ELLIPSE:
          r.u32();
          s.ellipse = { center: [r.i32(), r.i32()], axis1: [r.i32(), r.i32()], axis2: [r.i32(), r.i32()] };
          break;
        case TAG.SHAPE_COMPONENT_POLYGON:
        case TAG.SHAPE_COMPONENT_CURVE: {
          // Point count (u32), then (x, y) pairs.
          const n = r.u32();
          const pts = [];
          if (n < 100000 && r.remaining >= n * 8) for (let i = 0; i < n; i++) pts.push([r.i32(), r.i32()]);
          s.points = pts;
          if (c.tag === TAG.SHAPE_COMPONENT_CURVE) {
            s.segmentTypes = Array.from(r.bytes(Math.max(0, n - 1))); // 0 line, 1 curve
          }
          break;
        }
        case TAG.LIST_HEADER: {
          const lp = listParagraphs(node.children, doc, section, node.children.indexOf(c));
          r.u16(); r.u16();
          const attr = r.u32();
          s.text = { vAlign: (attr >> 5) & 3, padding: [r.i16(), r.i16(), r.i16(), r.i16()], maxWidth: r.u32(), paragraphs: lp.paragraphs };
          break;
        }
      }
    }
    shapes.push(s);
  }
  return shapes;
}
