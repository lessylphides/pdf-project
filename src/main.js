import { GlobalWorkerOptions, Util, getDocument, PasswordResponses } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { bbox, inkPath, newId, resizeTo, simplify, translate } from './annotations.js';
import { exportPdf } from './save.js';
import { FONT_FAMILY, LINE_HEIGHT, baselineOffset, fontCss, loadEditorFonts, measureText, splitLines } from './text.js';

GlobalWorkerOptions.workerSrc = workerUrl;

const assetUrl = (p) => new URL(`pdfjs/${p}/`, document.baseURI).href;
const PDFJS_OPTIONS = {
  cMapUrl: assetUrl('cmaps'),
  cMapPacked: true,
  standardFontDataUrl: assetUrl('standard_fonts'),
  wasmUrl: assetUrl('wasm'),
  iccUrl: assetUrl('iccs'),
  enableXfa: false,
};

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const MAX_CANVAS_PIXELS = 16_000_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * pages[i] = {
 *   id, src (index into sources, or null for a blank page), index (0-based page in source),
 *   rotation (0/90/180/270), width, height (unrotated, points), view ([x0,y0,x1,y1] in PDF space),
 *   annotations: [...]
 * }
 * Only `pages` is part of undo history; everything in it is plain JSON.
 */
const state = {
  sources: [], // { doc: PDFDocumentProxy, task: loading task, bytes: Uint8Array, name }
  pages: [],
  images: new Map(), // imageId -> { bytes, mime, url }
  fileName: 'document.pdf',
  scale: 1,
  tool: 'select',
  selected: null, // { pageId, annId }
  current: 0,
};

const toolDefaults = {
  text: { color: '#111111', size: 14, bold: false, opacity: 1 },
  ink: { stroke: '#e11d48', width: 2, opacity: 1 },
  highlight: { fill: '#facc15', opacity: 0.45 },
  rect: { stroke: '#e11d48', fill: null, width: 2, opacity: 1 },
  ellipse: { stroke: '#e11d48', fill: null, width: 2, opacity: 1 },
  line: { stroke: '#e11d48', width: 2, opacity: 1 },
  whiteout: { fill: '#ffffff', opacity: 1 },
  image: { opacity: 1 },
};
toolDefaults.edittext = toolDefaults.text;

const TOOL_HINTS = {
  select: '개체를 클릭해 선택하고 끌어서 이동합니다. 텍스트는 더블클릭으로 수정합니다.',
  text: '글자를 넣을 곳을 클릭하세요. 입력을 마치려면 바깥을 클릭하거나 Esc를 누르세요.',
  edittext: '고칠 기존 글자를 클릭하세요. 원래 글자는 가려지고 그 자리에 새 글자를 쓸 수 있습니다.',
  ink: '끌어서 자유롭게 그립니다.',
  highlight: '강조할 영역을 끌어서 지정합니다.',
  rect: '끌어서 사각형을 그립니다. Shift: 정사각형',
  ellipse: '끌어서 원을 그립니다. Shift: 정원',
  line: '끌어서 직선을 그립니다. Shift: 45° 단위',
  whiteout: '가릴 영역을 끌어서 지정합니다. 가린 내용은 저장된 PDF에서 보이지 않습니다.',
};

// Non-serialized per-page caches.
const pdfPageCache = new Map(); // `${src}:${index}` -> Promise<PDFPageProxy>
const textItemCache = new Map(); // `${src}:${index}` -> Promise<items[]>
const pageEls = new Map(); // page.id -> { outer, inner, canvas, svg, renderedScale, task }
const thumbCache = new Map(); // `${page.id}:${rotation}` -> canvas

const pageById = (id) => state.pages.find((p) => p.id === id);
const pageKey = (pg) => `${pg.src}:${pg.index}`;

function getPdfPage(pg) {
  const key = pageKey(pg);
  if (!pdfPageCache.has(key)) pdfPageCache.set(key, state.sources[pg.src].doc.getPage(pg.index + 1));
  return pdfPageCache.get(key);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const history = { stack: [], index: -1, saved: -1 };

function commit() {
  history.stack.length = history.index + 1;
  history.stack.push(JSON.stringify(state.pages));
  if (history.stack.length > 200) {
    history.stack.shift();
    history.saved--;
  }
  history.index = history.stack.length - 1;
  updateButtons();
}

function resetHistory() {
  history.stack = [JSON.stringify(state.pages)];
  history.index = 0;
  history.saved = 0;
  updateButtons();
}

function restore(delta) {
  closeEditor(true);
  const next = history.index + delta;
  if (next < 0 || next >= history.stack.length) return;
  history.index = next;
  state.pages = JSON.parse(history.stack[next]);
  if (state.selected && !findAnn(state.selected)) state.selected = null;
  state.current = Math.min(state.current, state.pages.length - 1);
  rebuild();
  updateButtons();
}

const isDirty = () => history.index !== history.saved;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadSource(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const task = getDocument({ ...PDFJS_OPTIONS, data: bytes.slice() });
  task.onPassword = (update, reason) => {
    const msg = reason === PasswordResponses.INCORRECT_PASSWORD ? '비밀번호가 틀렸습니다. 다시 입력하세요:' : '이 PDF는 비밀번호로 보호되어 있습니다. 비밀번호:';
    const pw = prompt(msg);
    if (pw == null) task.destroy();
    else update(pw);
  };
  const doc = await task.promise;
  const src = state.sources.push({ doc, task, bytes, name: file.name }) - 1;
  const pages = [];
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    pdfPageCache.set(`${src}:${i}`, Promise.resolve(page));
    const view = [...page.view];
    pages.push({
      id: newId(),
      src,
      index: i,
      rotation: ((page.rotate % 360) + 360) % 360,
      width: view[2] - view[0],
      height: view[3] - view[1],
      view,
      annotations: [],
    });
  }
  return pages;
}

async function openFile(file) {
  if (!file) return;
  if (isDirty() && !confirm('저장하지 않은 변경 사항이 있습니다. 새 파일을 열까요?')) return;
  await withBusy('PDF를 여는 중…', async () => {
    closeEditor(true);
    for (const s of state.sources) s.task.destroy();
    state.sources = [];
    pdfPageCache.clear();
    textItemCache.clear();
    thumbCache.clear();
    for (const { url } of state.images.values()) URL.revokeObjectURL(url);
    state.images.clear();
    for (const entry of pageEls.values()) entry.outer.remove();
    pageEls.clear();
    state.selected = null;
    state.current = 0;
    state.fileName = file.name;
    state.pages = await loadSource(file);
    resetHistory();
    $('empty').hidden = true;
    document.title = `${file.name} – PDF 편집 뷰어`;
    fitWidth(true);
    setStatus(`${file.name} · ${state.pages.length}쪽`);
  });
}

async function appendFile(file) {
  if (!file) return;
  await withBusy('페이지를 추가하는 중…', async () => {
    const pages = await loadSource(file);
    const at = state.pages.length ? state.current + 1 : 0;
    state.pages.splice(at, 0, ...pages);
    commit();
    rebuild();
    scrollToPage(at);
    setStatus(`${file.name}의 ${pages.length}쪽을 추가했습니다.`);
  });
}

// ---------------------------------------------------------------------------
// Page layout & rendering
// ---------------------------------------------------------------------------

const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const pg = pageById(e.target.dataset.pageId);
      if (pg) renderCanvas(pg);
    }
  },
  { root: $('viewer'), rootMargin: '600px 0px' },
);

function svg(tag, attrs = {}, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

function rotatedSize(pg) {
  return pg.rotation % 180 ? [pg.height, pg.width] : [pg.width, pg.height];
}

function createPageEl(pg) {
  const outer = document.createElement('div');
  outer.className = 'page';
  outer.dataset.pageId = pg.id;
  const inner = document.createElement('div');
  inner.className = 'page-inner';
  const overlay = svg('svg', { class: 'overlay' });
  inner.append(overlay);
  outer.append(inner);
  const entry = { outer, inner, canvas: null, svg: overlay, renderedScale: 0, task: null };
  overlay.addEventListener('pointerdown', (e) => onPointerDown(e, pageById(outer.dataset.pageId)));
  overlay.addEventListener('pointermove', (e) => onPointerMove(e, pageById(outer.dataset.pageId)));
  overlay.addEventListener('pointerup', (e) => onPointerUp(e));
  overlay.addEventListener('pointercancel', (e) => onPointerUp(e));
  overlay.addEventListener('dblclick', (e) => onDoubleClick(e, pageById(outer.dataset.pageId)));
  overlay.addEventListener('pointerleave', () => setHover(null));
  io.observe(outer);
  return entry;
}

function layoutPage(pg, entry) {
  const s = state.scale;
  const [rw, rh] = rotatedSize(pg);
  entry.outer.style.width = `${rw * s}px`;
  entry.outer.style.height = `${rh * s}px`;
  entry.inner.style.width = `${pg.width * s}px`;
  entry.inner.style.height = `${pg.height * s}px`;
  const W = pg.width * s, H = pg.height * s;
  const t = {
    0: 'none',
    90: `translate(${H}px, 0) rotate(90deg)`,
    180: `translate(${W}px, ${H}px) rotate(180deg)`,
    270: `translate(0, ${W}px) rotate(270deg)`,
  }[pg.rotation];
  entry.inner.style.transform = t;
  entry.svg.setAttribute('viewBox', `0 0 ${pg.width} ${pg.height}`);
}

/** Rebuild the page list to match state.pages, reusing existing DOM. */
function rebuild() {
  const container = $('pages');
  const live = new Set(state.pages.map((p) => p.id));
  for (const [id, entry] of pageEls) {
    if (!live.has(id)) {
      io.unobserve(entry.outer);
      entry.task?.cancel();
      entry.outer.remove();
      pageEls.delete(id);
    }
  }
  state.pages.forEach((pg, i) => {
    let entry = pageEls.get(pg.id);
    if (!entry) {
      entry = createPageEl(pg);
      pageEls.set(pg.id, entry);
    }
    layoutPage(pg, entry);
    if (container.children[i] !== entry.outer) container.insertBefore(entry.outer, container.children[i] ?? null);
    renderOverlay(pg);
    if (entry.renderedScale !== state.scale && isNearViewport(entry.outer)) renderCanvas(pg);
  });
  $('empty').hidden = state.pages.length > 0;
  rebuildThumbs();
  updateCurrentPage();
  updateButtons();
  updateProps();
}

function isNearViewport(el) {
  const v = $('viewer').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return r.bottom > v.top - 600 && r.top < v.bottom + 600;
}

async function renderCanvas(pg) {
  const entry = pageEls.get(pg.id);
  if (!entry || pg.src == null || entry.renderedScale === state.scale) return;
  const scale = state.scale;
  entry.renderedScale = scale;
  entry.task?.cancel();
  const page = await getPdfPage(pg);
  let dpr = window.devicePixelRatio || 1;
  const area = pg.width * pg.height * scale * scale;
  if (area * dpr * dpr > MAX_CANVAS_PIXELS) dpr = Math.sqrt(MAX_CANVAS_PIXELS / area);
  const viewport = page.getViewport({ scale: scale * dpr, rotation: 0 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport });
  entry.task = task;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.error(err);
    if (entry.renderedScale === scale) entry.renderedScale = 0;
    return;
  }
  if (entry.task !== task) return;
  entry.task = null;
  entry.canvas?.remove();
  entry.canvas = canvas;
  entry.inner.insertBefore(canvas, entry.svg);
}

// ---------------------------------------------------------------------------
// Overlay (annotations) rendering
// ---------------------------------------------------------------------------

let editor = null; // { pg, ann, textarea, original, isNew, whiteoutId }
let hover = null; // { pageId, item }

function renderOverlay(pg) {
  const entry = pageEls.get(pg.id);
  if (!entry) return;
  const root = entry.svg;
  root.replaceChildren();
  const s = state.scale;
  for (const a of pg.annotations) {
    if (editor && editor.ann.id === a.id) continue;
    drawAnnotation(root, a, s);
  }
  if (hover && hover.pageId === pg.id) {
    const it = hover.item;
    svg('rect', { class: 'textbox-guide', x: it.x - 1, y: it.y - 1, width: it.w + 2, height: it.h + 2, 'vector-effect': 'non-scaling-stroke' }, root);
  }
  const sel = state.selected;
  if (sel && sel.pageId === pg.id) {
    const a = pg.annotations.find((x) => x.id === sel.annId);
    if (a && !(editor && editor.ann.id === a.id)) {
      const b = bbox(a);
      const pad = 4 / s;
      svg('rect', {
        x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2,
        fill: 'none', stroke: 'var(--sel)', 'stroke-dasharray': '4 3', 'vector-effect': 'non-scaling-stroke',
        'pointer-events': 'none',
      }, root);
      const hs = 9 / s;
      svg('rect', {
        class: 'handle', 'data-handle': a.id,
        x: b.x + b.w + pad - hs / 2, y: b.y + b.h + pad - hs / 2, width: hs, height: hs,
        fill: '#fff', stroke: 'var(--sel)', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke',
      }, root);
    }
  }
}

function drawAnnotation(root, a, s) {
  const common = { 'data-id': a.id, opacity: a.opacity ?? 1 };
  const blend = a.blend === 'multiply' ? 'mix-blend-mode: multiply' : null;
  switch (a.type) {
    case 'text': {
      const g = svg('g', common, root);
      const b = bbox(a);
      svg('rect', { class: 'text-hit', x: b.x, y: b.y, width: b.w, height: b.h }, g);
      const lines = splitLines(a.text);
      lines.forEach((line, i) => {
        const t = svg('text', {
          x: a.x, y: a.y + baselineOffset(a.size, i),
          'font-family': FONT_FAMILY, 'font-size': a.size, 'font-weight': a.bold ? 700 : 400, fill: a.color,
        }, g);
        t.textContent = line;
      });
      break;
    }
    case 'rect':
      svg('rect', {
        ...common, x: a.x, y: a.y, width: a.w, height: a.h, style: blend,
        fill: a.fill || 'none', stroke: a.stroke || 'none', 'stroke-width': a.stroke ? a.width : 0,
        'pointer-events': 'all',
      }, root);
      break;
    case 'ellipse':
      svg('ellipse', {
        ...common, cx: a.x + a.w / 2, cy: a.y + a.h / 2, rx: a.w / 2, ry: a.h / 2, style: blend,
        fill: a.fill || 'none', stroke: a.stroke || 'none', 'stroke-width': a.stroke ? a.width : 0,
        'pointer-events': 'all',
      }, root);
      break;
    case 'line': {
      const g = svg('g', common, root);
      const pts = { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 };
      svg('line', { ...pts, stroke: 'transparent', 'stroke-width': Math.max(a.width, 10 / s) }, g);
      svg('line', { ...pts, stroke: a.stroke, 'stroke-width': a.width, 'stroke-linecap': 'round', style: blend }, g);
      break;
    }
    case 'ink': {
      const g = svg('g', common, root);
      const d = inkPath(a.points);
      svg('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(a.width, 10 / s), 'stroke-linecap': 'round' }, g);
      svg('path', { d, fill: 'none', stroke: a.stroke, 'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', style: blend }, g);
      break;
    }
    case 'image': {
      const img = state.images.get(a.imageId);
      svg('image', { ...common, href: img?.url, x: a.x, y: a.y, width: a.w, height: a.h, preserveAspectRatio: 'none' }, root);
      break;
    }
  }
}

function setHover(h) {
  const prev = hover;
  hover = h;
  if (prev) { const p = pageById(prev.pageId); if (p) renderOverlay(p); }
  if (h && (!prev || prev.pageId !== h.pageId)) { const p = pageById(h.pageId); if (p) renderOverlay(p); }
}

// ---------------------------------------------------------------------------
// Pointer interaction
// ---------------------------------------------------------------------------

/** Client coordinates -> unrotated page points. */
function toModel(pg, e) {
  const r = pageEls.get(pg.id).outer.getBoundingClientRect();
  const X = (e.clientX - r.left) / state.scale;
  const Y = (e.clientY - r.top) / state.scale;
  switch (pg.rotation) {
    case 90: return { x: Y, y: pg.height - X };
    case 180: return { x: pg.width - X, y: pg.height - Y };
    case 270: return { x: pg.width - Y, y: X };
    default: return { x: X, y: Y };
  }
}

function findAnn(sel) {
  const pg = sel && pageById(sel.pageId);
  const ann = pg?.annotations.find((a) => a.id === sel.annId);
  return ann ? { pg, ann } : null;
}

function select(pg, ann) {
  const prev = state.selected && pageById(state.selected.pageId);
  state.selected = ann ? { pageId: pg.id, annId: ann.id } : null;
  if (prev && prev !== pg) renderOverlay(prev);
  if (pg) renderOverlay(pg);
  updateProps();
}

let drag = null;

function onPointerDown(e, pg) {
  if (e.button !== 0 || !pg) return;
  if (editor) {
    closeEditor();
    e.preventDefault();
    return;
  }
  const p = toModel(pg, e);
  const tool = state.tool;
  const d = toolDefaults[tool];

  if (tool === 'select') {
    const handle = e.target.closest('[data-handle]');
    const hit = e.target.closest('[data-id]');
    if (handle) {
      const { ann } = findAnn(state.selected);
      drag = { mode: 'resize', pg, ann, orig: structuredClone(ann), moved: false };
    } else if (hit) {
      const ann = pg.annotations.find((a) => a.id === hit.dataset.id);
      select(pg, ann);
      drag = { mode: 'move', pg, ann, last: p, moved: false };
    } else {
      select(null, null);
      return;
    }
  } else if (tool === 'text') {
    const ann = { id: newId(), type: 'text', kind: 'text', x: p.x, y: p.y - (d.size * LINE_HEIGHT) / 2, text: '', size: d.size, color: d.color, bold: d.bold, opacity: d.opacity };
    pg.annotations.push(ann);
    openEditor(pg, ann, { isNew: true });
    e.preventDefault();
    return;
  } else if (tool === 'edittext') {
    e.preventDefault();
    editExistingText(pg, p);
    return;
  } else if (tool === 'ink') {
    const ann = { id: newId(), type: 'ink', kind: 'ink', points: [[p.x, p.y]], stroke: d.stroke, width: d.width, opacity: d.opacity };
    pg.annotations.push(ann);
    drag = { mode: 'create', pg, ann, start: p };
  } else if (tool === 'line') {
    const ann = { id: newId(), type: 'line', kind: 'line', x1: p.x, y1: p.y, x2: p.x, y2: p.y, stroke: d.stroke, width: d.width, opacity: d.opacity };
    pg.annotations.push(ann);
    drag = { mode: 'create', pg, ann, start: p };
  } else if (['rect', 'ellipse', 'highlight', 'whiteout'].includes(tool)) {
    const ann = {
      id: newId(), type: tool === 'ellipse' ? 'ellipse' : 'rect', kind: tool,
      x: p.x, y: p.y, w: 0, h: 0,
      stroke: d.stroke ?? null, fill: d.fill ?? null, width: d.width ?? 0, opacity: d.opacity,
      blend: tool === 'highlight' ? 'multiply' : undefined,
    };
    pg.annotations.push(ann);
    drag = { mode: 'create', pg, ann, start: p };
  } else {
    return;
  }
  e.currentTarget.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onPointerMove(e, pg) {
  if (!drag) {
    if (state.tool === 'edittext' && pg && pg.src != null) {
      const p = toModel(pg, e);
      getTextItems(pg).then((items) => {
        const item = items.find((it) => hitItem(it, p));
        if (item !== hover?.item) setHover(item ? { pageId: pg.id, item } : null);
      });
    }
    return;
  }
  const { pg: dpg, ann } = drag;
  const p = toModel(dpg, e);
  if (drag.mode === 'move') {
    translate(ann, p.x - drag.last.x, p.y - drag.last.y);
    drag.last = p;
    drag.moved = true;
  } else if (drag.mode === 'resize') {
    const keepRatio = ann.type === 'image' ? !e.shiftKey : e.shiftKey;
    const pad = 4 / state.scale;
    resizeTo(ann, drag.orig, p.x - pad, p.y - pad, keepRatio);
    drag.moved = true;
  } else if (ann.type === 'ink') {
    const events = e.getCoalescedEvents?.() ?? [e];
    for (const ce of events) {
      const q = toModel(dpg, ce);
      ann.points.push([q.x, q.y]);
    }
  } else if (ann.type === 'line') {
    let { x, y } = p;
    if (e.shiftKey) {
      const dx = x - drag.start.x, dy = y - drag.start.y;
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      x = drag.start.x + Math.cos(ang) * len;
      y = drag.start.y + Math.sin(ang) * len;
    }
    ann.x2 = x;
    ann.y2 = y;
  } else {
    let w = p.x - drag.start.x, h = p.y - drag.start.y;
    if (e.shiftKey) {
      const m = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * m;
      h = Math.sign(h || 1) * m;
    }
    ann.x = Math.min(drag.start.x, drag.start.x + w);
    ann.y = Math.min(drag.start.y, drag.start.y + h);
    ann.w = Math.abs(w);
    ann.h = Math.abs(h);
  }
  renderOverlay(dpg);
  if (state.selected) updateProps();
}

function onPointerUp() {
  if (!drag) return;
  const { mode, pg, ann, moved } = drag;
  drag = null;
  if (mode === 'create') {
    const b = bbox(ann);
    const tooSmall = ann.type === 'ink' ? false : ann.type === 'line' ? Math.hypot(b.w, b.h) < 2 : b.w < 2 || b.h < 2;
    if (tooSmall) {
      pg.annotations.splice(pg.annotations.indexOf(ann), 1);
    } else {
      if (ann.type === 'ink') ann.points = simplify(ann.points, 0.6 / state.scale).map(([x, y]) => [round2(x), round2(y)]);
      commit();
    }
    renderOverlay(pg);
  } else if (moved) {
    commit();
    updateProps();
  }
}

const round2 = (v) => Math.round(v * 100) / 100;

function onDoubleClick(e, pg) {
  if (state.tool !== 'select' || !pg) return;
  const hit = e.target.closest('[data-id]');
  const ann = hit && pg.annotations.find((a) => a.id === hit.dataset.id);
  if (ann?.type === 'text') openEditor(pg, ann, { isNew: false });
}

// ---------------------------------------------------------------------------
// Text editing
// ---------------------------------------------------------------------------

function openEditor(pg, ann, { isNew, whiteoutId = null }) {
  closeEditor();
  const entry = pageEls.get(pg.id);
  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.spellcheck = false;
  ta.value = ann.text;
  editor = { pg, ann, textarea: ta, original: ann.text, isNew, whiteoutId };
  const fit = () => {
    const s = state.scale;
    const { w, h } = measureText(ann);
    ta.style.left = `${ann.x * s}px`;
    ta.style.top = `${ann.y * s}px`;
    ta.style.font = fontCss(ann.size * s, ann.bold);
    ta.style.lineHeight = String(LINE_HEIGHT);
    ta.style.color = ann.color;
    ta.style.width = `${Math.max(w * s + ann.size * s, 40)}px`;
    ta.style.height = `${Math.max(h * s, ann.size * s * LINE_HEIGHT)}px`;
  };
  editor.fit = fit;
  ta.addEventListener('input', () => {
    ann.text = ta.value;
    fit();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      closeEditor();
    }
    e.stopPropagation();
  });
  ta.addEventListener('blur', () => setTimeout(() => editor?.textarea === ta && closeEditor(), 0));
  fit();
  entry.inner.append(ta);
  select(pg, ann);
  renderOverlay(pg);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function closeEditor(silent = false) {
  if (!editor) return;
  const { pg, ann, textarea, original, isNew, whiteoutId } = editor;
  editor = null;
  textarea.remove();
  ann.text = ann.text.replace(/\s+$/, '');
  const changed = ann.text !== original || isNew;
  if (!ann.text.trim()) {
    const i = pg.annotations.indexOf(ann);
    if (i >= 0) pg.annotations.splice(i, 1);
    if (state.selected?.annId === ann.id) state.selected = null;
  }
  // A brand new empty text box (without a whiteout) is not a change at all.
  const meaningful = changed && !(isNew && !ann.text.trim() && !whiteoutId);
  if (meaningful && !silent) commit();
  renderOverlay(pg);
  updateProps();
}

function getTextItems(pg) {
  const key = pageKey(pg);
  if (!textItemCache.has(key)) {
    textItemCache.set(key, (async () => {
      const page = await getPdfPage(pg);
      const tc = await page.getTextContent();
      const vp = page.getViewport({ scale: 1, rotation: 0 });
      const items = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const tx = Util.transform(vp.transform, it.transform);
        if (Math.abs(tx[1]) > 1e-3 || Math.abs(tx[2]) > 1e-3) continue; // skip rotated/skewed text
        const fontHeight = Math.hypot(tx[2], tx[3]);
        const style = tc.styles[it.fontName] || {};
        const ascent = style.ascent ? style.ascent : style.descent ? 1 + style.descent : 0.8;
        items.push({ str: it.str, x: tx[4], y: tx[5] - fontHeight * ascent, w: it.width, h: fontHeight, baseline: tx[5], fontHeight });
      }
      return items;
    })().catch((err) => { console.error(err); return []; }));
  }
  return textItemCache.get(key);
}

const hitItem = (it, p) => p.x >= it.x - 1 && p.x <= it.x + it.w + 1 && p.y >= it.y - 1 && p.y <= it.y + it.h + 1;

async function editExistingText(pg, p) {
  if (pg.src == null) return setStatus('빈 페이지에는 기존 글자가 없습니다. 텍스트 도구를 사용하세요.');
  const items = await getTextItems(pg);
  const item = items.find((it) => hitItem(it, p));
  if (!item) return setStatus('클릭한 위치에서 글자를 찾지 못했습니다. (스캔한 문서라면 텍스트 도구와 지우개를 함께 사용하세요)');
  setHover(null);
  const wd = toolDefaults.whiteout;
  const pad = Math.max(1, item.fontHeight * 0.08);
  const white = {
    id: newId(), type: 'rect', kind: 'whiteout',
    x: item.x - pad, y: item.y - pad, w: item.w + pad * 2, h: item.h + pad * 2,
    stroke: null, fill: wd.fill, width: 0, opacity: 1,
  };
  const size = Math.round(item.fontHeight * 10) / 10;
  const text = {
    id: newId(), type: 'text', kind: 'text',
    x: item.x, y: item.baseline - baselineOffset(size, 0),
    text: item.str, size, color: '#000000', bold: false, opacity: 1,
  };
  pg.annotations.push(white, text);
  openEditor(pg, text, { isNew: true, whiteoutId: white.id });
  editor.textarea.select();
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

async function insertImage(file) {
  if (!file || !state.pages.length) return;
  let bytes = new Uint8Array(await file.arrayBuffer());
  let mime = file.type;
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  if (mime !== 'image/png' && mime !== 'image/jpeg') {
    const c = document.createElement('canvas');
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext('2d').drawImage(bitmap, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    bytes = new Uint8Array(await blob.arrayBuffer());
    mime = 'image/png';
  }
  const imageId = newId();
  state.images.set(imageId, { bytes, mime, url: URL.createObjectURL(new Blob([bytes], { type: mime })) });
  const pg = state.pages[state.current];
  const k = Math.min((pg.width * 0.6) / bitmap.width, (pg.height * 0.6) / bitmap.height, 1);
  const w = bitmap.width * k, h = bitmap.height * k;
  const ann = { id: newId(), type: 'image', kind: 'image', imageId, x: (pg.width - w) / 2, y: (pg.height - h) / 2, w, h, opacity: 1 };
  pg.annotations.push(ann);
  commit();
  setTool('select');
  select(pg, ann);
  setStatus('이미지를 넣었습니다. 끌어서 옮기고 모서리로 크기를 조절하세요.');
}

// ---------------------------------------------------------------------------
// Selection actions
// ---------------------------------------------------------------------------

function deleteSelected() {
  const found = findAnn(state.selected);
  if (!found) return;
  found.pg.annotations.splice(found.pg.annotations.indexOf(found.ann), 1);
  state.selected = null;
  commit();
  renderOverlay(found.pg);
  updateProps();
}

function duplicateSelected() {
  const found = findAnn(state.selected);
  if (!found) return;
  const copy = { ...structuredClone(found.ann), id: newId() };
  translate(copy, 10, 10);
  found.pg.annotations.push(copy);
  commit();
  select(found.pg, copy);
}

function bringToFront() {
  const found = findAnn(state.selected);
  if (!found) return;
  const list = found.pg.annotations;
  list.push(...list.splice(list.indexOf(found.ann), 1));
  commit();
  renderOverlay(found.pg);
}

let nudgeTimer = null;
function nudge(dx, dy) {
  const found = findAnn(state.selected);
  if (!found) return;
  translate(found.ann, dx, dy);
  renderOverlay(found.pg);
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(commit, 400);
}

// ---------------------------------------------------------------------------
// Page operations
// ---------------------------------------------------------------------------

function currentPage() {
  return state.pages[state.current];
}

function rotatePage(delta) {
  const pg = currentPage();
  if (!pg) return;
  closeEditor();
  pg.rotation = (pg.rotation + delta + 360) % 360;
  commit();
  rebuild();
  scrollToPage(state.current);
}

function movePage(delta) {
  const i = state.current, j = i + delta;
  if (j < 0 || j >= state.pages.length) return;
  closeEditor();
  [state.pages[i], state.pages[j]] = [state.pages[j], state.pages[i]];
  commit();
  rebuild();
  scrollToPage(j);
}

function insertBlank() {
  const pg = currentPage();
  if (!pg) return;
  const [w, h] = rotatedSize(pg);
  const blank = { id: newId(), src: null, index: 0, rotation: 0, width: w, height: h, view: [0, 0, w, h], annotations: [] };
  state.pages.splice(state.current + 1, 0, blank);
  commit();
  rebuild();
  scrollToPage(state.current + 1);
}

function deletePage() {
  if (state.pages.length <= 1) return setStatus('마지막 남은 페이지는 삭제할 수 없습니다.');
  closeEditor();
  const [removed] = state.pages.splice(state.current, 1);
  if (state.selected?.pageId === removed.id) state.selected = null;
  state.current = Math.min(state.current, state.pages.length - 1);
  commit();
  rebuild();
  setStatus(`${state.current + 1}쪽 위치의 페이지를 삭제했습니다. (Ctrl+Z로 되돌리기)`);
}

// ---------------------------------------------------------------------------
// Thumbnails, navigation, zoom
// ---------------------------------------------------------------------------

let thumbQueue = Promise.resolve();

function rebuildThumbs() {
  const box = $('thumbs');
  box.replaceChildren();
  state.pages.forEach((pg, i) => {
    const el = document.createElement('div');
    el.className = 'thumb';
    el.dataset.index = i;
    const frame = document.createElement('div');
    frame.className = 'box';
    const label = document.createElement('div');
    label.textContent = String(i + 1);
    el.append(frame, label);
    el.addEventListener('click', () => scrollToPage(i));
    box.append(el);
    const key = `${pg.id}:${pg.rotation}`;
    const cached = thumbCache.get(key);
    if (cached) frame.append(cached);
    else thumbQueue = thumbQueue.then(() => renderThumb(pg, key, frame)).catch(console.error);
  });
  highlightThumb();
}

async function renderThumb(pg, key, frame) {
  if (!frame.isConnected) return;
  const [rw, rh] = rotatedSize(pg);
  const k = 130 / Math.max(rw, rh);
  const canvas = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rw * k * dpr);
  canvas.height = Math.round(rh * k * dpr);
  canvas.style.width = `${Math.round(rw * k)}px`;
  canvas.style.height = `${Math.round(rh * k)}px`;
  if (pg.src != null) {
    const page = await getPdfPage(pg);
    const viewport = page.getViewport({ scale: k * dpr, rotation: pg.rotation });
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
  } else {
    const c = canvas.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, canvas.width, canvas.height);
  }
  thumbCache.set(key, canvas);
  if (frame.isConnected) frame.append(canvas);
}

function highlightThumb() {
  for (const el of $('thumbs').children) el.classList.toggle('current', Number(el.dataset.index) === state.current);
  const cur = $('thumbs').children[state.current];
  if (cur) {
    const box = $('thumbs').parentElement;
    const r = cur.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (r.top < b.top + 70 || r.bottom > b.bottom) cur.scrollIntoView({ block: 'nearest' });
  }
}

function scrollToPage(i) {
  const pg = state.pages[i];
  const entry = pg && pageEls.get(pg.id);
  if (!entry) return;
  const viewer = $('viewer');
  viewer.scrollTop = entry.outer.offsetTop - 16;
  state.current = i;
  updateCurrentPage();
}

function updateCurrentPage() {
  const viewer = $('viewer');
  const mid = viewer.getBoundingClientRect().top + viewer.clientHeight / 3;
  let best = Math.min(state.current, state.pages.length - 1);
  for (let i = 0; i < state.pages.length; i++) {
    const r = pageEls.get(state.pages[i].id)?.outer.getBoundingClientRect();
    if (r && r.top <= mid && r.bottom >= mid) { best = i; break; }
  }
  if (best < 0) best = 0;
  state.current = best;
  $('page-num').textContent = state.pages.length ? best + 1 : '-';
  $('page-count').textContent = state.pages.length || '-';
  highlightThumb();
  updateButtons();
}

function setScale(scale, anchorPage = true) {
  scale = Math.min(Math.max(scale, 0.1), 6);
  if (scale === state.scale) return;
  closeEditor();
  const viewer = $('viewer');
  const pg = currentPage();
  const entry = pg && pageEls.get(pg.id);
  const offset = entry ? (viewer.scrollTop - entry.outer.offsetTop) / state.scale : 0;
  state.scale = scale;
  $('zoom-label').textContent = `${Math.round(scale * 100)}%`;
  rebuild();
  if (anchorPage && entry) viewer.scrollTop = entry.outer.offsetTop + offset * scale;
}

function zoomStep(dir) {
  const s = state.scale;
  const next = dir > 0 ? ZOOM_STEPS.find((z) => z > s + 1e-6) : [...ZOOM_STEPS].reverse().find((z) => z < s - 1e-6);
  if (next) setScale(next);
}

function fitWidth(force) {
  if (!state.pages.length) return;
  const avail = $('viewer').clientWidth - 48;
  const maxW = Math.max(...state.pages.map((p) => rotatedSize(p)[0]));
  const s = Math.round(Math.min(Math.max(avail / maxW, 0.25), 3) * 100) / 100;
  if (force) state.scale = 0; // make setScale re-layout even if unchanged
  setScale(s, !force);
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

async function save() {
  if (!state.pages.length) return;
  closeEditor();
  const name = state.fileName.replace(/\.pdf$/i, '') + '_편집.pdf';
  // Ask for the destination first: the picker needs the click's user activation.
  let handle = null;
  if (window.showSaveFilePicker) {
    try {
      handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'PDF 문서', accept: { 'application/pdf': ['.pdf'] } }] });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      handle = null; // picker unavailable (e.g. in an iframe): fall back to a download
    }
  }
  await withBusy('PDF를 저장하는 중…', async () => {
    const { bytes, missing } = await exportPdf({ sources: state.sources, pages: state.pages, images: state.images });
    const blob = new Blob([bytes], { type: 'application/pdf' });
    let savedAs = name;
    if (handle) {
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      savedAs = handle.name;
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }
    history.saved = history.index;
    updateButtons();
    setStatus(`저장했습니다: ${savedAs} (${(bytes.length / 1024).toFixed(0)} KB)`);
    if (missing.length) {
      const msg = `글꼴에 없는 문자가 있어 저장된 PDF에서 빠졌습니다: ${missing.join(' ')}`;
      setStatus(msg);
      alert(msg);
    }
  });
}

// ---------------------------------------------------------------------------
// Toolbar, properties panel, status
// ---------------------------------------------------------------------------

const PROP_FIELDS = {
  text: ['color', 'size', 'bold', 'opacity'],
  ink: ['color', 'width', 'opacity'],
  line: ['color', 'width', 'opacity'],
  rect: ['color', 'nostroke', 'width', 'fill', 'nofill', 'opacity'],
  ellipse: ['color', 'nostroke', 'width', 'fill', 'nofill', 'opacity'],
  highlight: ['fill', 'opacity'],
  whiteout: ['fill'],
  image: ['opacity'],
};
const KIND_LABEL = { text: '텍스트', ink: '펜', line: '선', rect: '사각형', ellipse: '원', highlight: '형광펜', whiteout: '지우개(가리기)', image: '이미지', edittext: '글자 수정' };
const TOOL_LABEL = { select: '선택', ...KIND_LABEL };

/** The object the properties panel edits: the selection, or the tool defaults. */
function propTarget() {
  const found = findAnn(state.selected);
  if (found) return { kind: found.ann.kind, obj: found.ann, pg: found.pg };
  const kind = state.tool === 'edittext' ? 'text' : state.tool;
  if (toolDefaults[kind] && PROP_FIELDS[kind]) return { kind, obj: toolDefaults[kind], pg: null };
  return null;
}

function updateProps() {
  const t = propTarget();
  const fields = t ? PROP_FIELDS[t.kind] : [];
  for (const row of document.querySelectorAll('#props [data-prop]')) row.classList.toggle('hidden', !fields.includes(row.dataset.prop));
  $('sel-actions').hidden = !findAnn(state.selected);
  $('props-target').textContent = !t
    ? `${TOOL_LABEL[state.tool]} 도구에는 설정할 속성이 없습니다.`
    : t.pg ? `선택한 개체: ${KIND_LABEL[t.kind]}` : `${TOOL_LABEL[state.tool]} 도구 기본값`;
  if (!t) return;
  const o = t.obj;
  const strokeKey = t.kind === 'text' ? 'color' : 'stroke';
  if (o[strokeKey]) $('p-color').value = o[strokeKey];
  $('p-nostroke').checked = !o.stroke;
  if (o.fill) $('p-fill').value = o.fill;
  $('p-nofill').checked = !o.fill;
  if (o.width != null) { $('p-width').value = o.width || 2; $('o-width').value = o.width; }
  $('p-opacity').value = o.opacity ?? 1;
  $('o-opacity').value = `${Math.round((o.opacity ?? 1) * 100)}%`;
  if (o.size != null) $('p-size').value = o.size;
  $('p-bold').checked = !!o.bold;
}

function applyProp(field, final) {
  const t = propTarget();
  if (!t) return;
  const targets = [t.obj];
  if (t.pg && toolDefaults[t.kind]) targets.push(toolDefaults[t.kind]); // remember as the new default
  for (const o of targets) {
    switch (field) {
      case 'color': if (t.kind === 'text') o.color = $('p-color').value; else { o.stroke = $('p-color').value; if (!o.width) o.width = 2; } break;
      case 'nostroke': o.stroke = $('p-nostroke').checked ? null : $('p-color').value; if (o.stroke && !o.width) o.width = 2; break;
      case 'fill': o.fill = $('p-fill').value; break;
      case 'nofill': o.fill = $('p-nofill').checked ? null : $('p-fill').value; break;
      case 'width': o.width = Number($('p-width').value); break;
      case 'opacity': o.opacity = Number($('p-opacity').value); break;
      case 'size': { const v = Number($('p-size').value); if (v >= 1) o.size = v; break; }
      case 'bold': o.bold = $('p-bold').checked; break;
    }
  }
  if (t.kind === 'rect' || t.kind === 'ellipse') {
    // Never leave a shape with neither stroke nor fill (it would be invisible).
    if (!t.obj.stroke && !t.obj.fill) { t.obj.stroke = $('p-color').value; t.obj.width ||= 2; }
  }
  $('o-width').value = $('p-width').value;
  $('o-opacity').value = `${Math.round(Number($('p-opacity').value) * 100)}%`;
  if (t.pg) {
    renderOverlay(t.pg);
    if (editor && editor.ann === t.obj) editor.fit();
    if (final && !editor) commit();
  }
  if (final) updateProps();
}

function setTool(tool) {
  if (tool === 'image') {
    if (!state.pages.length) return;
    $('file-image').click();
    return;
  }
  closeEditor();
  state.tool = tool;
  $('viewer').dataset.tool = tool;
  for (const b of document.querySelectorAll('#tools [data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
  if (tool !== 'select') select(null, null);
  setHover(null);
  if (tool === 'edittext') for (const pg of state.pages) if (pg.src != null) getTextItems(pg);
  if (state.pages.length && TOOL_HINTS[tool]) setStatus(TOOL_HINTS[tool]);
  updateProps();
}

function updateButtons() {
  const has = state.pages.length > 0;
  $('btn-save').disabled = !has;
  $('btn-save').textContent = isDirty() ? '저장 •' : '저장';
  $('btn-undo').disabled = history.index <= 0;
  $('btn-redo').disabled = history.index >= history.stack.length - 1;
  $('btn-append').disabled = !has;
  for (const id of ['btn-rot-left', 'btn-rot-right', 'btn-blank']) $(id).disabled = !has;
  $('btn-delete-page').disabled = state.pages.length <= 1;
  $('btn-move-up').disabled = !has || state.current <= 0;
  $('btn-move-down').disabled = !has || state.current >= state.pages.length - 1;
}

function setStatus(msg) {
  $('status').textContent = msg;
}

async function withBusy(msg, fn) {
  $('busy-text').textContent = msg;
  $('busy').hidden = false;
  try {
    await fn();
  } catch (err) {
    console.error(err);
    const text = /encrypt/i.test(String(err?.message)) ? '암호화된 PDF라서 저장할 수 없습니다.' : `오류: ${err?.message || err}`;
    setStatus(text);
    alert(text);
  } finally {
    $('busy').hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wire() {
  const openPicker = () => $('file-open').click();
  $('btn-open').onclick = openPicker;
  $('btn-open-2').onclick = openPicker;
  $('btn-append').onclick = () => $('file-append').click();
  $('btn-save').onclick = save;
  $('btn-undo').onclick = () => restore(-1);
  $('btn-redo').onclick = () => restore(1);
  $('file-open').onchange = (e) => { openFile(e.target.files[0]); e.target.value = ''; };
  $('file-append').onchange = (e) => { appendFile(e.target.files[0]); e.target.value = ''; };
  $('file-image').onchange = (e) => { insertImage(e.target.files[0]).catch((err) => setStatus(`이미지를 넣지 못했습니다: ${err.message}`)); e.target.value = ''; };
  for (const b of document.querySelectorAll('#tools [data-tool]')) b.onclick = () => setTool(b.dataset.tool);
  $('btn-zoom-in').onclick = () => zoomStep(1);
  $('btn-zoom-out').onclick = () => zoomStep(-1);
  $('btn-fit').onclick = () => fitWidth(false);
  $('btn-rot-left').onclick = () => rotatePage(-90);
  $('btn-rot-right').onclick = () => rotatePage(90);
  $('btn-move-up').onclick = () => movePage(-1);
  $('btn-move-down').onclick = () => movePage(1);
  $('btn-blank').onclick = insertBlank;
  $('btn-delete-page').onclick = deletePage;
  $('btn-dup').onclick = duplicateSelected;
  $('btn-front').onclick = bringToFront;
  $('btn-del').onclick = deleteSelected;

  const propInputs = { 'p-color': 'color', 'p-nostroke': 'nostroke', 'p-fill': 'fill', 'p-nofill': 'nofill', 'p-width': 'width', 'p-opacity': 'opacity', 'p-size': 'size', 'p-bold': 'bold' };
  for (const [id, field] of Object.entries(propInputs)) {
    const el = $(id);
    if (el.type !== 'checkbox') el.addEventListener('input', () => applyProp(field, false));
    el.addEventListener('change', () => applyProp(field, true));
  }

  const viewer = $('viewer');
  let scrollRaf = 0;
  viewer.addEventListener('scroll', () => {
    cancelAnimationFrame(scrollRaf);
    scrollRaf = requestAnimationFrame(updateCurrentPage);
  });
  viewer.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setScale(state.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  viewer.addEventListener('dragover', (e) => { e.preventDefault(); viewer.classList.add('dragover'); });
  viewer.addEventListener('dragleave', () => viewer.classList.remove('dragover'));
  viewer.addEventListener('drop', (e) => {
    e.preventDefault();
    viewer.classList.remove('dragover');
    const file = [...e.dataTransfer.files].find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const img = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (file) {
      if (state.pages.length && confirm('현재 문서 뒤에 이 PDF의 페이지를 추가할까요?\n(취소를 누르면 새 문서로 엽니다)')) appendFile(file);
      else openFile(file);
    } else if (img) insertImage(img);
  });

  window.addEventListener('resize', () => updateCurrentPage());
  window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

  const keyTools = { v: 'select', t: 'text', e: 'edittext', p: 'ink', h: 'highlight', r: 'rect', o: 'ellipse', l: 'line', w: 'whiteout', i: 'image' };
  document.addEventListener('keydown', (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 's') { e.preventDefault(); save(); return; }
    if (mod && k === 'o') { e.preventDefault(); $('file-open').click(); return; }
    if (inField) return;
    if (mod && k === 'z') { e.preventDefault(); restore(e.shiftKey ? 1 : -1); return; }
    if (mod && k === 'y') { e.preventDefault(); restore(1); return; }
    if (mod && k === 'd') { e.preventDefault(); duplicateSelected(); return; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoomStep(1); return; }
    if (mod && k === '-') { e.preventDefault(); zoomStep(-1); return; }
    if (mod) return;
    if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelected(); return; }
    if (k === 'escape') { if (state.selected) select(null, null); else setTool('select'); return; }
    const step = e.shiftKey ? 10 : 1;
    const arrows = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] };
    if (arrows[k] && state.selected) { e.preventDefault(); nudge(...arrows[k]); return; }
    if (keyTools[k] && state.pages.length) setTool(keyTools[k]);
  });
}

wire();
setTool('select');
updateButtons();
loadEditorFonts().catch((err) => console.warn('Editor font failed to load', err));

if (import.meta.env.DEV) window.__pdfEditor = { state, history, openFile, exportPdf };
