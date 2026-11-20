// Lays out a parsed HWP document into pages of drawing items (points,
// origin at the top-left of the page).
//
// Hangul stores the result of its own layout with every paragraph: one
// "line segment" per line with the line's vertical position, height,
// baseline, horizontal start and width, and the first character on the line.
// Using those keeps page breaks, line breaks and vertical spacing identical to
// Hangul. Only the horizontal placement of characters inside a line is
// recomputed, with the substitute fonts, following the paragraph alignment.
import { circledNumber, langOf, normalizeChar, substitute } from './fonts.js';
import { mulMatrix } from './parse.js';

const PT = (v) => v / 100; // HWPUNIT -> points
const FULL_WIDTH = new Set(['·', '･']);
const HALF_PT = (v) => v / 200; // paragraph margins are stored doubled

/** Font keys a document needs (loaded before layout). */
export function fontKeysFor(doc) {
  const keys = new Set(['gothic-400', 'myeongjo-400']);
  const visit = (paras) => {
    for (const p of paras || []) {
      for (const t of p.text) {
        if (t.code != null || t.ch === ' ') continue;
        const cs = doc.charShapes[charShapeAt(p, t.pos)];
        if (!cs) continue;
        const lang = langOf(normalizeChar(t.ch));
        const face = doc.faces[lang]?.[cs.faceIds[lang]]?.name ?? doc.faces[0]?.[cs.faceIds[0]]?.name;
        keys.add(substitute(face, cs.bold));
      }
      for (const c of p.controls) {
        const k = c.ctrl;
        if (!k) continue;
        visit(k.paragraphs);
        for (const cell of k.cells || []) visit(cell.paragraphs);
        visit(k.caption?.paragraphs);
        const shapes = (s) => { if (!s) return; visit(s.text?.paragraphs); (s.children || []).forEach(shapes); };
        shapes(k.shape);
      }
    }
  };
  for (const s of doc.sections) visit(s.paragraphs);
  return keys;
}

export function layoutHwp(doc, fonts) {
  const ctx = {
    doc, fonts, pages: [], warnings: new Set(),
    pageNo: 0, header: [null, null, null], footer: [null, null, null], pageNumberCtrl: null,
  };
  doc.sections.forEach((section, i) => layoutSection(section, i, ctx));
  for (const page of ctx.pages) finishPage(page, ctx);
  return { pages: ctx.pages, warnings: [...ctx.warnings] };
}

// ---------------------------------------------------------------------------
// Pages and sections
// ---------------------------------------------------------------------------

function pageGeometry(pd) {
  const W = PT(pd.landscape ? pd.height : pd.width);
  const H = PT(pd.landscape ? pd.width : pd.height);
  const left = PT(pd.left + pd.gutter), right = PT(pd.right);
  const top = PT(pd.top + pd.header), bottom = PT(pd.bottom + pd.footer);
  return {
    W, H,
    body: { x: left, y: top, w: W - left - right, h: H - top - bottom },
    header: { x: left, y: PT(pd.top), w: W - left - right, h: PT(pd.header) },
    footer: { x: left, y: H - PT(pd.bottom + pd.footer), w: W - left - right, h: PT(pd.footer) },
  };
}

function newPage(ctx, section, geo) {
  ctx.pageNo++;
  const page = {
    width: geo.W, height: geo.H, geo, section,
    number: ctx.pageNo,
    back: [], main: [], front: [],
    header: currentHF(ctx.header, ctx.pageNo), footer: currentHF(ctx.footer, ctx.pageNo),
    pageNumberCtrl: ctx.pageNumberCtrl, hide: {}, footnotes: [], used: false,
  };
  ctx.pages.push(page);
  return page;
}

function currentHF(list, n) {
  // [both, even, odd]
  return (n % 2 === 0 ? list[1] : list[2]) || list[0];
}

const DEFAULT_PAGE = { width: 59528, height: 84188, left: 8504, right: 8504, top: 5668, bottom: 4252, header: 4252, footer: 4252, gutter: 0, landscape: false };

function layoutSection(section, index, ctx) {
  const pd = section.pageDef || ctx.lastPageDef || DEFAULT_PAGE;
  ctx.lastPageDef = pd;
  const geo = pageGeometry(pd);
  if (section.secd?.pageStart) ctx.pageNo = section.secd.pageStart - 1;
  let page = newPage(ctx, section, geo);
  if (section.secd) {
    page.hide.header = section.secd.hideFirstHeader;
    page.hide.footer = section.secd.hideFirstFooter;
    page.hide.pageNum = section.secd.hideFirstPageNum;
  }
  const columns = section.paragraphs.flatMap((p) => p.controls.filter((c) => c.ctrl?.id === 'cold').map((c) => c.ctrl))[0];
  let lastY = -Infinity;
  let lastX = 0;
  const flow = {
    origin: { x: geo.body.x, y: geo.body.y },
    page: () => page,
  };
  for (const para of section.paragraphs) {
    if (!para.lineSegs.length) synthesizeLineSegs(para, ctx, geo.body.w * 100, lastY === -Infinity ? 0 : lastY);
    para.lineSegs.forEach((seg, i) => {
      const pageBreak = (i === 0 && (para.breakType & 4) && page.used)
        || (seg.y < lastY - 1 && !(columns?.count > 1 && seg.x > lastX + 100));
      if (pageBreak) {
        page = newPage(ctx, section, geo);
      }
      // Compare line tops: with line spacing under 100% a line may start
      // inside the previous line's box without a page break.
      lastY = seg.y;
      lastX = seg.x;
      page.used = true;
    });
    layoutParagraph(para, flow.origin, ctx, { body: true, pageOf: segPages(para, section, ctx), geo });
    if (ctx.pages[ctx.pages.length - 1] !== page) {
      // A table continued onto new pages; the text after it is on the last one.
      page = ctx.pages[ctx.pages.length - 1];
      page.used = true;
      lastY = -Infinity;
    }
    // Controls that change page decorations from this page on.
    for (const c of para.controls) {
      const k = c.ctrl;
      if (!k) continue;
      const pg = ctx.segPageMap?.get(para)?.[0] || page;
      if (k.id === 'head') { ctx.header[k.applyTo] = k; setHF(pg, 'header', ctx); }
      if (k.id === 'foot') { ctx.footer[k.applyTo] = k; setHF(pg, 'footer', ctx); }
      if (k.id === 'pgnp') { ctx.pageNumberCtrl = k; for (const p of ctx.pages) if (p.number >= pg.number && p.section === section) p.pageNumberCtrl = k; }
      if (k.id === 'pghd') Object.assign(pg.hide, { header: k.hideHeader, footer: k.hideFooter, pageNum: k.hidePageNum, border: k.hideBorder });
    }
  }
}

function setHF(page, which, ctx) {
  page[which] = currentHF(ctx[which], page.number);
}

/** The page each line segment of a body paragraph lands on (pages already created in order). */
function segPages(para, section, ctx) {
  // Recompute the same page assignment as the loop in layoutSection: the
  // paragraph's segments end on the last page; walk backwards over breaks.
  const pages = [];
  let p = ctx.pages.length - 1;
  for (let i = para.lineSegs.length - 1; i >= 0; i--) {
    pages[i] = ctx.pages[p];
    if (i > 0 && para.lineSegs[i].y < para.lineSegs[i - 1].y - 1) p--;
  }
  (ctx.segPageMap ||= new Map()).set(para, pages);
  return pages;
}

// ---------------------------------------------------------------------------
// Paragraphs and lines
// ---------------------------------------------------------------------------

/**
 * Lays out a paragraph whose line segments are relative to `origin`.
 * opts.body: paragraph of the main text (segments may span pages; opts.pageOf[i] is each line's page)
 * opts.page: the page for everything (cells, text boxes, headers)
 */
function layoutParagraph(para, origin, ctx, opts) {
  const prevSplit = ctx.allowSplit;
  ctx.allowSplit = !!opts.body; // only tables in the main text may continue on the next page
  try {
    layoutParagraphInner(para, origin, ctx, opts);
  } finally {
    ctx.allowSplit = prevSplit;
  }
}

function layoutParagraphInner(para, origin, ctx, opts) {
  const { doc } = ctx;
  const ps = doc.paraShapes[para.paraShapeId] || doc.paraShapes[0];
  const segs = para.lineSegs;
  const pageFor = (i) => (opts.body ? opts.pageOf[i] : opts.page);

  // Paragraph border/background.
  const bf = ps && ps.borderFillId ? doc.borderFills[ps.borderFillId - 1] : null;
  if (bf && hasVisible(bf) && segs.length) {
    const groups = new Map();
    segs.forEach((s, i) => {
      const pg = pageFor(i);
      const g = groups.get(pg) || { top: Infinity, bottom: -Infinity, x: Infinity, r: -Infinity };
      g.top = Math.min(g.top, s.y);
      g.bottom = Math.max(g.bottom, s.y + s.height);
      g.x = Math.min(g.x, s.x);
      g.r = Math.max(g.r, s.x + s.width);
      groups.set(pg, g);
    });
    for (const [pg, g] of groups) {
      const sp = ps.borderSpace.map(PT);
      const box = { x: origin.x + PT(g.x) - sp[0], y: origin.y + PT(g.top) - sp[2], w: PT(g.r - g.x) + sp[0] + sp[1], h: PT(g.bottom - g.top) + sp[2] + sp[3] };
      drawBorderFill(pg.main, bf, box, ctx);
    }
  }

  // Floating objects anchored to this paragraph.
  for (const c of para.controls) {
    const k = c.ctrl;
    if (!k || k.inline || !isObject(k)) continue;
    const segIdx = Math.max(0, segs.findIndex((s, i) => c.pos >= s.pos && (i === segs.length - 1 || c.pos < segs[i + 1].pos)));
    const seg = segs[segIdx] || { y: 0, x: 0, width: 0 };
    const pg = pageFor(segIdx) || pageFor(0);
    if (!pg) continue;
    placeFloating(k, pg, {
      paraTop: origin.y + PT(segs[0]?.y ?? 0),
      paraX: origin.x + PT(seg.x), paraW: PT(seg.width),
      area: opts.area || pg.geo.body,
    }, ctx);
  }

  segs.forEach((seg, i) => {
    const pg = pageFor(i);
    if (pg) layoutLine(para, ps, i, origin, pg, ctx);
  });
}

function isObject(k) {
  return k.id === 'tbl ' || k.id === 'gso ' || k.id === 'eqed';
}

function charShapeAt(para, pos) {
  let id = para.charShapes[0].id;
  for (const c of para.charShapes) {
    if (c.pos <= pos) id = c.id;
    else break;
  }
  return id;
}

/** Character metrics for layout: width and the font to draw with. */
function measure(ch, cs, ctx) {
  const { doc, fonts } = ctx;
  const n = normalizeChar(ch);
  const lang = langOf(n);
  const face = doc.faces[lang]?.[cs.faceIds[lang]]?.name ?? doc.faces[0]?.[cs.faceIds[0]]?.name ?? '';
  let key = substitute(face, cs.bold);
  let size = (cs.size / 100) * (cs.relSize[lang] || 100) / 100;
  if (cs.superscript || cs.subscript) size *= 0.68;
  const ratio = (cs.ratio[lang] || 100) / 100;
  const spacing = (cs.spacing[lang] || 0) / 100 * size;
  let kind = 'text';
  let special = null;
  if (n !== ' ' && !fonts.has(key, n)) {
    // The other family has a few glyphs this one lacks (same weight if loaded).
    const fam = key.startsWith('gothic') ? 'myeongjo' : 'gothic';
    const other = fonts.fonts.has(`${fam}-${key.split('-')[1]}`) ? `${fam}-${key.split('-')[1]}` : `${fam}-400`;
    if (fonts.has(other, n)) key = other;
    else if ((special = circledNumber(n))) kind = 'special';
    else kind = 'raster';
  }
  let adv;
  // Measured against Hangul's own line breaks: a space is half an em and the
  // middle dot is full width in Korean fonts, whatever the substitute font says.
  let pad = 0;
  if (n === ' ') adv = 0.5;
  else if (FULL_WIDTH.has(n) && kind === 'text') { adv = 1; kind = 'center'; }
  else if (kind === 'text') {
    adv = fonts.advance(key, n);
    // Korean, Chinese and full-width symbols are exactly one em in Hangul's
    // fonts; the substitutes are slightly narrower (0.94–0.95 em).
    if (adv > 0.85 && adv < 1 && (lang === 0 || lang === 2 || lang === 3 || lang === 5)) {
      pad = (1 - adv) * size * ratio;
      adv = 1;
    }
  }
  else if (kind === 'special') adv = special.kind === 'unit' ? unitWidth(special, key, fonts) : special.kind === 'paren' ? 1 : 1;
  else adv = lang === 1 || lang === 4 ? 0.6 : 1;
  return { ch: n, key, size, ratio, spacing, pad, width: adv * size * ratio + spacing, kind, special, lang, cs };
}

function unitWidth(sp, key, fonts) {
  let w = 0;
  for (const c of sp.text) w += fonts.advance(key, c);
  if (sp.sup) for (const c of sp.sup) w += fonts.advance(key, c) * 0.6;
  return w;
}

function layoutLine(para, ps, i, origin, page, ctx) {
  const { doc } = ctx;
  const segs = para.lineSegs;
  const seg = segs[i];
  const start = seg.pos;
  const end = i + 1 < segs.length ? segs[i + 1].pos : Infinity;
  const lineTop = origin.y + PT(seg.y);
  const baseline = lineTop + PT(seg.baseline);
  const indent = ps ? ps.indent : 0;
  const indentOff = (i === 0 && indent > 0) || (i > 0 && indent < 0) ? HALF_PT(Math.abs(indent)) : 0;
  const x0 = origin.x + PT(seg.x) + indentOff;
  const avail = Math.max(0, PT(seg.width) - indentOff);

  // Elements on this line, in order.
  const els = [];
  let forcedBreak = false;
  const ctrlAt = new Map();
  for (const c of para.controls) if (c.ctrl) ctrlAt.set(c.pos, c);
  const items = [];
  for (const t of para.text) if (t.pos >= start && t.pos < end) items.push({ pos: t.pos, t });
  for (const c of para.controls) if (c.ctrl && c.pos >= start && c.pos < end) items.push({ pos: c.pos, c });
  items.sort((a, b) => a.pos - b.pos);
  for (const it of items) {
    if (it.t) {
      const t = it.t;
      const cs = doc.charShapes[charShapeAt(para, t.pos)] || doc.charShapes[0];
      if (t.code === 13) continue;
      if (t.code === 10) { forcedBreak = true; continue; }
      if (t.code === 9) {
        const m = measure(' ', cs, ctx);
        els.push({ kind: 'tab', width: PT(t.tab?.width ?? 4000), leader: t.tab?.leader ?? 0, cs, size: m.size, pos: t.pos });
        continue;
      }
      if (t.code === 0 || (t.code != null && t.code < 32 && ![24, 30, 31].includes(t.code))) continue;
      let ch = t.ch;
      if (t.code === 24) ch = '-';
      if (t.code === 30) ch = ' ';
      if (t.code === 31) ch = ' ';
      const m = measure(ch, cs, ctx);
      if (t.code === 31) m.width = m.size * 0.5 * m.ratio + m.spacing; // fixed-width space
      m.isSpace = ch === ' ';
      m.pos = t.pos;
      els.push(m);
    } else {
      const k = it.c.ctrl;
      if (isObject(k) && k.inline) {
        const w = PT(k.width + k.margin[0] + k.margin[1]);
        els.push({ kind: 'obj', ctrl: k, width: w, pos: it.pos });
      } else if (k.id === 'atno' || k.id === 'fn  ' || k.id === 'en  ') {
        const cs = doc.charShapes[charShapeAt(para, it.pos)] || doc.charShapes[0];
        const num = k.id === 'atno' && k.kind === 0 ? page.number : k.number || 1;
        const text = k.id === 'atno' ? formatNumber(num, k.format) : `${num})`;
        for (const ch of text) {
          const m = measure(ch, k.id === 'atno' ? cs : { ...cs, superscript: true }, ctx);
          m.pos = it.pos;
          els.push(m);
        }
        if (k.id !== 'atno') page.footnotes.push(k);
      }
    }
  }
  if (!els.length) return;

  // Natural width without trailing spaces.
  let last = els.length - 1;
  while (last >= 0 && els[last].isSpace) last--;
  const content = els.slice(0, last + 1);
  let natural = 0;
  for (const e of content) natural += e.width;
  const align = ps ? ps.align : 1;
  const isLast = i === segs.length - 1 || forcedBreak;

  // Fit: shrink spaces first, then glyphs.
  let spaceScale = 1, glyphScale = 1;
  const spaces = content.filter((e, k) => e.isSpace && k > 0 && !content.slice(0, k).every((x) => x.isSpace));
  const spaceW = spaces.reduce((s, e) => s + e.width, 0);
  const over = natural - avail;
  if (over > 0.01) {
    if (spaceW * 0.5 >= over) spaceScale = 1 - over / spaceW;
    else {
      spaceScale = 0.5;
      const textW = content.filter((e) => e.kind !== 'obj' && e.kind !== 'tab' && !e.isSpace).reduce((s, e) => s + e.width, 0);
      const rem = over - spaceW * 0.5;
      glyphScale = textW > 0 ? Math.max(0.55, (textW - rem) / textW) : 1;
    }
  }
  let used = 0;
  for (const e of content) used += e.isSpace ? e.width * spaceScale : e.kind === 'obj' || e.kind === 'tab' ? e.width : e.width * glyphScale;
  const free = Math.max(0, avail - used);
  let x = x0;
  let extraSpace = 0, extraChar = 0;
  if ((align === 0 && !isLast) || align === 5) {
    if (spaces.length) extraSpace = free / spaces.length;
    // Very wide gaps mean the substitute font is narrower than the original:
    // spread what is left over the letters instead.
    const avgSize = content.reduce((s, e) => s + (e.size || 0), 0) / Math.max(1, content.length);
    const cap = avgSize * 0.8;
    if (extraSpace > cap || !spaces.length) {
      const rest = free - (spaces.length ? cap * spaces.length : 0);
      extraSpace = spaces.length ? cap : 0;
      const gaps = content.length - 1;
      if (gaps > 0 && rest > 0) extraChar = Math.min(rest / gaps, avgSize * 0.12);
    }
  } else if (align === 4) {
    const gaps = content.length - 1;
    if (gaps > 0) extraChar = free / gaps;
  } else if (align === 2) x += free;
  else if (align === 3) x += free / 2;

  // Place elements.
  const placed = [];
  for (let k = 0; k < els.length; k++) {
    const e = els[k];
    const inContent = k <= last;
    let w;
    if (e.isSpace) w = e.width * spaceScale + (inContent && spaces.includes(e) ? extraSpace : 0);
    else if (e.kind === 'obj' || e.kind === 'tab') w = e.width;
    else w = e.width * glyphScale;
    placed.push({ e, x, w });
    x += w + (inContent && k < last ? extraChar : 0);
  }

  // Emit text runs (words), decorations and inline objects.
  emitLine(placed, { lineTop, baseline, seg, glyphScale, extraChar }, page, ctx);
}

function formatNumber(n, format) {
  switch (format) {
    case 1: return String.fromCharCode(0x2460 + n - 1); // circled
    case 2: return toRoman(n).toUpperCase();
    case 3: return toRoman(n);
    case 4: return String.fromCharCode(64 + ((n - 1) % 26) + 1);
    case 5: return String.fromCharCode(96 + ((n - 1) % 26) + 1);
    case 8: return '가나다라마바사아자차카타파하'[(n - 1) % 14];
    default: return String(n);
  }
}

function toRoman(n) {
  const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  for (const [v, r] of map) while (n >= v) { s += r; n -= v; }
  return s;
}

function emitLine(placed, line, page, ctx) {
  const { lineTop, baseline, seg, glyphScale, extraChar } = line;
  let run = null;
  const flush = () => {
    if (run && run.text) page.main.push(run);
    run = null;
  };
  const decos = [];
  for (const { e, x, w } of placed) {
    if (e.kind === 'obj') {
      flush();
      const k = e.ctrl;
      const h = PT(k.height), mT = PT(k.margin[2]), mB = PT(k.margin[3]);
      const segH = PT(seg.height);
      // A tall object fills the line (its outer margins included); a small
      // one sits on the baseline like a character.
      const top = h + mT + mB >= segH - 1 ? lineTop + Math.min(mT, Math.max(0, segH - mB - h)) : baseline - h - mB;
      drawObject(k, x + PT(k.margin[0]), top, page, ctx);
      continue;
    }
    if (e.kind === 'tab') {
      flush();
      if (e.leader) decos.push({ kind: 'leader', x1: x + e.size * 0.2, x2: x + w - e.size * 0.2, y: baseline - e.size * 0.12, cs: e.cs, size: e.size, leader: e.leader });
      continue;
    }
    const cs = e.cs;
    const rise = cs.superscript ? e.size * 0.55 : cs.subscript ? -e.size * 0.2 : (cs.offset[e.lang] || 0) / 100 * (cs.size / 100);
    const y = baseline - rise;
    // Decorations span spaces too.
    if (cs.underline || cs.strike || (cs.shadeColor && cs.shadeColor !== '#ffffff')) {
      const d = decos[decos.length - 1];
      if (d && d.kind === 'deco' && d.cs === cs && Math.abs(d.x2 - x) < 0.5) d.x2 = x + w;
      else decos.push({ kind: 'deco', cs, x1: x, x2: x + w, y: baseline, size: e.size });
    }
    if (e.isSpace) { flush(); continue; }
    if (e.kind === 'center') {
      // Narrow glyph drawn in the middle of a full-width cell.
      flush();
      const gw = ctx.fonts.advance(e.key, e.ch) * e.size * e.ratio * glyphScale;
      page.main.push({ t: 'text', x: x + (w - gw) / 2, y, text: e.ch, key: e.key, size: e.size, hscale: e.ratio * glyphScale, cspace: 0, color: cs.color, italic: cs.italic });
      continue;
    }
    if (e.kind === 'special') {
      flush();
      page.main.push({ t: 'special', x, y, w, size: e.size, key: e.key, color: cs.color, sp: e.special, hscale: e.ratio * glyphScale });
      continue;
    }
    if (e.kind === 'raster') {
      flush();
      page.main.push({ t: 'raster', x, y, w, size: e.size, ch: e.ch, family: e.key.startsWith('myeongjo') ? 'serif' : 'sans', bold: cs.bold, color: cs.color });
      ctx.warnings.add('missing-glyph');
      continue;
    }
    const hscale = e.ratio * glyphScale;
    const cspace = ((e.spacing + e.pad) * glyphScale + extraChar) / hscale;
    if (run && run.key === e.key && run.size === e.size && run.cs === cs && run.y === y && Math.abs(run.endX - x) < 0.05 && Math.abs(run.hscale - hscale) < 1e-6 && Math.abs(run.cspace - cspace) < 1e-6) {
      run.text += e.ch;
      run.endX = x + w;
    } else {
      flush();
      run = {
        t: 'text', x, y, text: e.ch, key: e.key, size: e.size, hscale, cspace, cs, endX: x + w,
        color: cs.color, italic: cs.italic, outline: cs.outline, shadow: cs.shadow, shadowColor: cs.shadowColor,
        shadowX: cs.shadowX, shadowY: cs.shadowY, emboss: cs.emboss, engrave: cs.engrave,
      };
    }
  }
  flush();
  for (const d of decos) {
    if (d.kind === 'leader') {
      page.main.push({ t: 'line', x1: d.x1, y1: d.y, x2: d.x2, y2: d.y, color: d.cs.color, width: Math.max(0.4, d.size * 0.06), style: d.leader === 3 ? 3 : d.leader === 2 ? 2 : 3 });
      continue;
    }
    const { cs, size } = d;
    if (cs.shadeColor && cs.shadeColor !== '#ffffff') page.back.push({ t: 'rect', x: d.x1, y: lineTop + PT(seg.height - seg.textHeight) * 0, w: d.x2 - d.x1, h: PT(seg.height), fill: cs.shadeColor });
    if (cs.underline === 1 || cs.underline === 3) {
      const y = cs.underline === 1 ? d.y + size * 0.12 : d.y - size * 0.92;
      page.main.push({ t: 'line', x1: d.x1, y1: y, x2: d.x2, y2: y, color: cs.underlineColor, width: Math.max(0.4, size * 0.055), style: lineStyle(cs.underlineShape) });
    }
    if (cs.strike || cs.underline === 2) {
      const y = d.y - size * 0.3;
      page.main.push({ t: 'line', x1: d.x1, y1: y, x2: d.x2, y2: y, color: cs.strikeColor || cs.color, width: Math.max(0.4, size * 0.055), style: 1 });
    }
  }
}

function lineStyle(shape) {
  // underline shapes: 0 solid, 1 dashed, 2 dotted, 3 dash-dot, 4 dash-dot-dot, 5 long dash, 6 big dots, 7 double …
  return [1, 2, 3, 4, 5, 6, 7, 8][shape] ?? 1;
}

/** Simple line breaking for paragraphs saved without layout information. */
function synthesizeLineSegs(para, ctx, widthHwp, startY) {
  const { doc } = ctx;
  const ps = doc.paraShapes[para.paraShapeId] || doc.paraShapes[0];
  const left = ps ? Math.round(ps.marginLeft / 2) : 0;
  const right = ps ? Math.round(ps.marginRight / 2) : 0;
  const width = Math.max(1000, widthHwp - left - right);
  const segs = [];
  let lineStart = 0, w = 0, maxSize = 1000, lastSpace = -1;
  const pushLine = (pos, size) => {
    const h = Math.round(size);
    const spacing = ps?.lineSpacingType === 0 ? Math.round(h * ((ps.lineSpacing || 160) / 100 - 1)) : 0;
    const y = segs.length ? segs[segs.length - 1].y + segs[segs.length - 1].height + segs[segs.length - 1].spacing : startY + (ps ? Math.round(ps.spaceBefore / 2) : 0);
    segs.push({ pos, y, height: h, textHeight: h, baseline: Math.round(h * 0.85), spacing, x: left, width, flags: 0x60000 });
  };
  for (const t of para.text) {
    if (t.code === 13) continue;
    const cs = doc.charShapes[charShapeAt(para, t.pos)] || doc.charShapes[0];
    maxSize = Math.max(maxSize, cs.size);
    const m = measure(t.code === 9 ? ' ' : t.ch, cs, ctx);
    const cw = (t.code === 9 ? 4 * m.width : m.width) * 100;
    if (t.code === 10 || (w + cw > width && w > 0)) {
      const breakAt = t.code !== 10 && lastSpace > lineStart ? lastSpace : t.pos;
      pushLine(lineStart, maxSize);
      lineStart = t.code === 10 ? t.pos + 1 : breakAt;
      w = 0;
      for (const u of para.text) if (u.pos >= lineStart && u.pos <= t.pos && u.code !== 10) w += measure(u.ch || ' ', doc.charShapes[charShapeAt(para, u.pos)] || cs, ctx).width * 100;
      lastSpace = -1;
      continue;
    }
    if (t.ch === ' ') lastSpace = t.pos + 1;
    w += cw;
  }
  pushLine(lineStart, maxSize);
  segs[0].pos = 0;
  para.lineSegs = segs;
}

// ---------------------------------------------------------------------------
// Objects: tables, drawings, pictures, equations
// ---------------------------------------------------------------------------

function placeFloating(k, page, anchor, ctx) {
  const { geo } = page;
  const w = PT(k.width), h = PT(k.height);
  const hb = k.horzRelTo === 0 ? { x: 0, w: page.width } : k.horzRelTo === 3 ? { x: anchor.paraX, w: anchor.paraW } : { x: anchor.area.x, w: anchor.area.w };
  const vb = k.vertRelTo === 0 ? { y: 0, h: page.height } : k.vertRelTo === 1 ? { y: geo.body.y, h: geo.body.h } : { y: anchor.paraTop, h: geo.body.h };
  const ox = PT(k.x), oy = PT(k.y);
  let x = hb.x + ox;
  if (k.horzAlign === 1) x = hb.x + (hb.w - w) / 2 + ox;
  else if (k.horzAlign === 2 || k.horzAlign === 4) x = hb.x + hb.w - w - ox;
  let y = vb.y + oy;
  if (k.vertRelTo !== 2) {
    if (k.vertAlign === 1) y = vb.y + (vb.h - h) / 2 + oy;
    else if (k.vertAlign === 2) y = vb.y + vb.h - h - oy;
  }
  const layer = k.textWrap === 2 ? 'back' : k.textWrap === 3 ? 'front' : 'main';
  drawObject(k, x, y, page, ctx, layer);
}

function drawObject(k, x, y, page, ctx, layer = 'main') {
  if (k.id === 'tbl ') return drawTable(k, x, y, page, ctx, layer);
  if (k.id === 'gso ' && k.shape) {
    const target = { ...page, main: page[layer] };
    drawShape(k.shape, null, { x, y, w: PT(k.width), h: PT(k.height) }, target, ctx, true);
    if (k.caption?.paragraphs?.length) {
      const capY = k.caption.side === 2 ? y - PT(k.caption.gap) - 12 : y + PT(k.height) + PT(k.caption.gap);
      for (const p of k.caption.paragraphs) layoutParagraph(p, { x, y: capY }, ctx, { page, area: { x, y: capY, w: PT(k.width), h: 20 } });
    }
    return;
  }
  if (k.id === 'eqed') {
    ctx.warnings.add('equation');
    const size = Math.max(6, PT(k.size || 1000));
    page[layer].push({ t: 'text', x, y: y + PT(k.height) * 0.8, text: (k.script || '').replace(/\s+/g, ' ').slice(0, 200), key: 'myeongjo-400', size, hscale: 1, cspace: 0, color: k.color || '#000000' });
  }
}

/** Column/row boundaries from cell sizes (cells may span several). */
function gridLines(cells, count, startKey, spanKey, sizeKey) {
  const pos = new Array(count + 1).fill(null);
  pos[0] = 0;
  for (let pass = 0; pass < count + 2; pass++) {
    let changed = false;
    for (const c of cells) {
      const a = c[startKey], b = Math.min(count, c[startKey] + c[spanKey]);
      if (pos[a] != null && pos[b] == null) { pos[b] = pos[a] + c[sizeKey]; changed = true; }
      else if (pos[b] != null && pos[a] == null) { pos[a] = pos[b] - c[sizeKey]; changed = true; }
    }
    if (!changed) break;
  }
  // Rows: a cell taller than the rows it spans grows the last row.
  for (const c of cells) {
    const a = c[startKey], b = Math.min(count, c[startKey] + c[spanKey]);
    if (pos[a] != null && pos[b] != null && pos[b] - pos[a] < c[sizeKey] - 1 && sizeKey === 'height') {
      const d = c[sizeKey] - (pos[b] - pos[a]);
      for (let i = b; i <= count; i++) if (pos[i] != null) pos[i] += d;
    }
  }
  // Fill gaps by interpolation.
  for (let i = 1; i <= count; i++) {
    if (pos[i] != null) continue;
    let j = i + 1;
    while (j <= count && pos[j] == null) j++;
    const prev = pos[i - 1];
    const next = j <= count ? pos[j] : prev + (j - i + 1) * 1000;
    for (let k = i; k < j; k++) pos[k] = prev + ((next - prev) * (k - i + 1)) / (j - i + 1);
  }
  return pos;
}

/** The page after `page` in the same section flow, created when needed. */
function nextPage(page, ctx) {
  const i = ctx.pages.indexOf(page);
  return ctx.pages[i + 1] || newPage(ctx, page.section, page.geo);
}

function drawTable(t, x, y, page, ctx, layer = 'main') {
  const colX = gridLines(t.cells, t.cols, 'col', 'colSpan', 'width');
  const rowY = gridLines(t.cells, t.rows, 'row', 'rowSpan', 'height');
  const pad = t.padding.map(PT); // left, right, top, bottom
  // A table that runs past the bottom of the body continues on the next
  // page, split between rows (Hangul stores only the first part's height).
  const parts = [];
  if (ctx.allowSplit && t.splitMode !== 0 && t.rows > 1) {
    let r0 = 0, top = y, pg = page;
    for (;;) {
      const bottom = pg.geo.body.y + pg.geo.body.h;
      let r1 = r0 + 1;
      while (r1 < t.rows && top + PT(rowY[r1 + 1] - rowY[r0]) <= bottom + 0.5) r1++;
      parts.push({ page: pg, r0, r1, top });
      if (r1 >= t.rows) break;
      pg = nextPage(pg, ctx);
      top = pg.geo.body.y;
      r0 = r1;
    }
  } else {
    parts.push({ page, r0: 0, r1: t.rows, top: y });
  }
  for (const part of parts) drawTablePart(t, part, colX, rowY, x, pad, ctx, layer);
  if (t.caption?.paragraphs?.length) {
    const last = parts[parts.length - 1];
    const target = { ...last.page, main: last.page[layer] };
    const h = PT(rowY[last.r1] - rowY[last.r0]);
    const capY = t.caption.side === 2 ? y - 14 : last.top + h + PT(t.caption.gap);
    for (const p of t.caption.paragraphs) layoutParagraph(p, { x, y: capY }, ctx, { page: target, area: { x, y: capY, w: PT(colX[t.cols]), h: 20 } });
  }
}

function drawTablePart(t, part, colX, rowY, x, pad, ctx, layer) {
  const { doc } = ctx;
  const target = { ...part.page, main: part.page[layer] };
  const top = rowY[part.r0], bottom = rowY[part.r1];
  const offY = part.top - PT(top);
  const boxes = [];
  for (const c of t.cells) {
    const y1 = rowY[c.row], y2 = rowY[Math.min(t.rows, c.row + c.rowSpan)];
    if (y2 <= top || y1 >= bottom) continue;
    const x1 = colX[c.col], x2 = colX[Math.min(t.cols, c.col + c.colSpan)];
    const cy1 = Math.max(y1, top), cy2 = Math.min(y2, bottom);
    boxes.push({
      c, starts: y1 >= top,
      full: { x: x + PT(x1), y: offY + PT(y1), w: PT(x2 - x1), h: PT(y2 - y1) },
      box: { x: x + PT(x1), y: offY + PT(cy1), w: PT(x2 - x1), h: PT(cy2 - cy1) },
      bf: doc.borderFills[c.borderFillId - 1],
    });
  }
  // Fills first, then contents, then borders on top.
  for (const { box, bf } of boxes) if (bf) drawFill(target.main, bf.fill, box, ctx);
  for (const { c, full, starts } of boxes) {
    if (!starts) continue; // a cell split across pages shows its text on the first part
    const innerH = full.h - pad[2] - pad[3];
    let contentH = 0;
    for (const p of c.paragraphs) for (const s of p.lineSegs) contentH = Math.max(contentH, PT(s.y + s.height));
    let off = 0;
    if (c.vAlign === 1) off = Math.max(0, (innerH - contentH) / 2);
    else if (c.vAlign === 2) off = Math.max(0, innerH - contentH);
    const origin = { x: full.x + pad[0], y: full.y + pad[2] + off };
    for (const p of c.paragraphs) {
      if (!p.lineSegs.length) synthesizeLineSegs(p, ctx, (full.w - pad[0] - pad[1]) * 100, 0);
      layoutParagraph(p, origin, ctx, { page: target, area: full });
    }
  }
  for (const { box, bf } of boxes) if (bf) drawBorders(target.main, bf, box);
}

function hasVisible(bf) {
  return [bf.left, bf.right, bf.top, bf.bottom].some((b) => b.type > 0) || !!bf.fill?.color || !!bf.fill?.gradient;
}

function drawBorderFill(list, bf, box, ctx) {
  drawFill(list, bf.fill, box, ctx);
  drawBorders(list, bf, box);
}

function drawFill(list, fill, box) {
  if (!fill) return;
  const color = fill.color || fill.gradient?.colors?.[0];
  if (color) list.push({ t: 'rect', ...box, fill: color });
  if (fill.pattern >= 0 && fill.pattern <= 5 && fill.patternColor) list.push({ t: 'hatch', ...box, color: fill.patternColor, pattern: fill.pattern });
}

function drawBorders(list, bf, box) {
  const { x, y, w, h } = box;
  const edge = (b, x1, y1, x2, y2) => {
    if (!b || b.type === 0) return;
    list.push({ t: 'line', x1, y1, x2, y2, color: b.color, width: b.width, style: b.type });
  };
  edge(bf.top, x, y, x + w, y);
  edge(bf.bottom, x, y + h, x + w, y + h);
  edge(bf.left, x, y, x, y + h);
  edge(bf.right, x + w, y, x + w, y + h);
  if (bf.diagonal && bf.diagonal.type > 0) {
    if (bf.slash) edge(bf.diagonal, x, y + h, x + w, y);
    if (bf.backslash) edge(bf.diagonal, x, y, x + w, y + h);
  }
}

/**
 * Draws a drawing object. `parentM` maps the shape's coordinates into the
 * object box (HWPUNIT); `box` is the object box on the page (points).
 */
function drawShape(s, parentM, box, page, ctx, top) {
  let M = s.matrix || [1, 0, 0, 1, 0, 0];
  if (parentM) M = mulMatrix(parentM, M);
  else if (top) {
    // Fit the shape's transformed extent into the object box.
    const pts = [[0, 0], [s.initWidth, 0], [s.initWidth, s.initHeight], [0, s.initHeight]].map((p) => apply(M, p));
    const minX = Math.min(...pts.map((p) => p[0])), minY = Math.min(...pts.map((p) => p[1]));
    M = mulMatrix([1, 0, 0, 1, -minX, -minY], M);
  }
  const toPage = (p) => {
    const q = apply(M, p);
    return [box.x + PT(q[0]), box.y + PT(q[1])];
  };
  const stroke = s.line && s.line.width > 0 && s.line.type !== 0 && s.line.color ? { color: s.line.color, width: Math.max(0.25, PT(s.line.width)), style: s.line.type } : null;
  const strokeAlways = s.line && s.line.color && s.line.width > 0 ? { color: s.line.color, width: Math.max(0.25, PT(s.line.width)), style: Math.max(1, s.line.type) } : null;
  const fill = s.fill?.color || s.fill?.gradient?.colors?.[0] || null;
  switch (s.kind) {
    case '$con':
      for (const c of s.children || []) drawShape(c, M, box, page, ctx, false);
      break;
    case '$pic': {
      const r = s.imageRect || [0, 0, s.initWidth, 0, s.initWidth, s.initHeight, 0, s.initHeight];
      const quad = [[r[0], r[1]], [r[2], r[3]], [r[4], r[5]], [r[6], r[7]]].map(toPage);
      const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
      const bx = Math.min(...xs), by = Math.min(...ys);
      page.main.push({ t: 'image', x: bx, y: by, w: Math.max(...xs) - bx, h: Math.max(...ys) - by, binId: s.binId, crop: s.crop, natural: [r[2] - r[0], r[5] - r[1]], effect: s.effect });
      if (s.line && s.line.width > 0 && s.line.color && (s.line.type || 0) > 0) {
        page.main.push({ t: 'poly', points: quad, closed: true, stroke: { color: s.line.color, width: Math.max(0.25, PT(s.line.width)), style: s.line.type } });
      }
      break;
    }
    case '$rec': {
      const pts = (s.points || [[0, 0], [s.initWidth, 0], [s.initWidth, s.initHeight], [0, s.initHeight]]).map(toPage);
      page.main.push({ t: 'poly', points: pts, closed: true, fill, stroke: strokeAlways, round: s.round });
      break;
    }
    case '$lin': {
      const pts = (s.points || [[0, 0], [s.initWidth, s.initHeight]]).map(toPage);
      if (strokeAlways) page.main.push({ t: 'line', x1: pts[0][0], y1: pts[0][1], x2: pts[1][0], y2: pts[1][1], color: strokeAlways.color, width: strokeAlways.width, style: strokeAlways.style, arrows: [s.line.arrowStart, s.line.arrowEnd] });
      break;
    }
    case '$ell': {
      const e = s.ellipse;
      const c = e ? e.center : [s.initWidth / 2, s.initHeight / 2];
      const a1 = e ? e.axis1 : [s.initWidth, s.initHeight / 2];
      const a2 = e ? e.axis2 : [s.initWidth / 2, s.initHeight];
      page.main.push({ t: 'ellipse', c: toPage(c), a1: toPage(a1), a2: toPage(a2), fill, stroke: strokeAlways });
      break;
    }
    case '$arc': {
      const c = [s.initWidth / 2, s.initHeight / 2];
      page.main.push({ t: 'ellipse', c: toPage(c), a1: toPage([s.initWidth, s.initHeight / 2]), a2: toPage([s.initWidth / 2, s.initHeight]), stroke: strokeAlways });
      break;
    }
    case '$pol':
    case '$cur': {
      const pts = (s.points || []).map(toPage);
      if (pts.length >= 2) {
        const closed = s.kind === '$pol' && (fill || (pts.length > 2 && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 0.5));
        page.main.push({ t: 'poly', points: pts, closed, fill: closed ? fill : null, stroke: strokeAlways });
      }
      break;
    }
    case '$ole':
      ctx.warnings.add('ole');
      break;
    default:
      break;
  }
  if (s.text?.paragraphs?.length) {
    const p0 = toPage([0, 0]);
    const pad = s.text.padding.map(PT);
    const w = PT(s.width), h = PT(s.height);
    let contentH = 0;
    for (const p of s.text.paragraphs) for (const sg of p.lineSegs) contentH = Math.max(contentH, PT(sg.y + sg.height));
    const innerH = h - pad[2] - pad[3];
    const off = s.text.vAlign === 1 ? Math.max(0, (innerH - contentH) / 2) : s.text.vAlign === 2 ? Math.max(0, innerH - contentH) : 0;
    const origin = { x: p0[0] + pad[0], y: p0[1] + pad[2] + off };
    for (const p of s.text.paragraphs) {
      if (!p.lineSegs.length) synthesizeLineSegs(p, ctx, (w - pad[0] - pad[1]) * 100, 0);
      layoutParagraph(p, origin, ctx, { page, area: { x: p0[0], y: p0[1], w, h } });
    }
  }
}

function apply(m, p) {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

// ---------------------------------------------------------------------------
// Page decorations: header, footer, page number, footnotes, page border
// ---------------------------------------------------------------------------

function finishPage(page, ctx) {
  const { geo } = page;
  const section = page.section;
  // Page border / background (both pages).
  const pbf = section.pageBorderFills?.[0];
  if (pbf && pbf.borderFillId && !page.hide.border) {
    const bf = ctx.doc.borderFills[pbf.borderFillId - 1];
    if (bf && hasVisible(bf)) {
      const m = pbf.margin.map(PT);
      const base = pbf.relToPaper ? { x: 0, y: 0, w: page.width, h: page.height } : geo.body;
      const box = { x: base.x - (pbf.relToPaper ? -m[0] : m[0]), y: base.y - (pbf.relToPaper ? -m[2] : m[2]), w: base.w + (pbf.relToPaper ? -(m[0] + m[1]) : m[0] + m[1]), h: base.h + (pbf.relToPaper ? -(m[2] + m[3]) : m[2] + m[3]) };
      drawFill(page.back, bf.fill, box, ctx);
      drawBorders(page.front, bf, box);
    }
  }
  const hf = (ctrl, area) => {
    if (!ctrl?.paragraphs) return;
    for (const p of ctrl.paragraphs) {
      if (!p.lineSegs.length) synthesizeLineSegs(p, ctx, area.w * 100, 0);
      layoutParagraph(p, { x: area.x, y: area.y }, ctx, { page, area });
    }
  };
  if (!page.hide.header) hf(page.header, geo.header);
  if (!page.hide.footer) hf(page.footer, geo.footer);
  const pn = page.pageNumberCtrl;
  if (pn && pn.position > 0 && !page.hide.pageNum) {
    const text = (pn.dash ? `${String.fromCharCode(pn.dash)} ` : '') + formatNumber(page.number, pn.format) + (pn.dash ? ` ${String.fromCharCode(pn.dash)}` : '');
    const size = 10;
    const key = 'myeongjo-400';
    let w = 0;
    for (const ch of text) w += ctx.fonts.advance(key, ch) * size;
    const pos = pn.position;
    const isTop = [1, 2, 3, 7, 9].includes(pos);
    const area = isTop ? geo.header : geo.footer;
    const odd = page.number % 2 === 1;
    let x;
    if ([2, 5].includes(pos)) x = area.x + (area.w - w) / 2;
    else if ([3, 6].includes(pos) || ([7, 8].includes(pos) && odd) || ([9, 10].includes(pos) && !odd)) x = area.x + area.w - w;
    else x = area.x;
    const y = area.y + area.h / 2 + size * 0.35;
    page.main.push({ t: 'text', x, y, text, key, size, hscale: 1, cspace: 0, color: '#000000' });
  }
  if (page.footnotes.length) {
    ctx.warnings.add('footnote');
    let y = geo.body.y + geo.body.h;
    const blocks = page.footnotes.map((fn) => {
      let h = 0;
      for (const p of fn.paragraphs || []) for (const s of p.lineSegs) h = Math.max(h, PT(s.y + s.height));
      return { fn, h };
    });
    const total = blocks.reduce((s, b) => s + b.h, 0) + 6;
    y -= total;
    page.main.push({ t: 'line', x1: geo.body.x, y1: y, x2: geo.body.x + geo.body.w * 0.3, y2: y, color: '#000000', width: 0.4, style: 1 });
    y += 4;
    for (const b of blocks) {
      for (const p of b.fn.paragraphs || []) layoutParagraph(p, { x: geo.body.x, y }, ctx, { page, area: geo.body });
      y += b.h;
    }
  }
}
