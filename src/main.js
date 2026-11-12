import { AnnotationLayer, AnnotationMode, GlobalWorkerOptions, Util, getDocument, PasswordResponses } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import './style.css';
import { bbox, canResize, inkPath, newId, resizeTo, simplify, translate, unionRects } from './annotations.js';
import { icon } from './icons.js';
import { decrypt, looksEncrypted } from './qpdf.js';
import { drawSignature, makeStamp, stampFromPhoto } from './sign.js';
import * as store from './storage.js';
import { FONT_FAMILY, LINE_HEIGHT, baselineOffset, fontCss, loadEditorFonts, measureText, splitLines } from './text.js';
import { alertDialog, confirmDialog, h, isSheetOpen, promptDialog, setBusyText, showSheet, toast, withBusy } from './ui.js';

GlobalWorkerOptions.workerSrc = workerUrl;

const vendorUrl = (p) => new URL(`vendor/pdfjs/${p}/`, document.baseURI).href;
const PDFJS_OPTIONS = {
  cMapUrl: vendorUrl('cmaps'),
  cMapPacked: true,
  standardFontDataUrl: vendorUrl('standard_fonts'),
  wasmUrl: vendorUrl('wasm'),
  iccUrl: vendorUrl('iccs'),
  enableXfa: false,
  isEvalSupported: false, // never run code generated from a PDF
};

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const IS_IOS = /iP(hone|ad|od)/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// iOS limits total canvas memory; keep each page canvas smaller there.
const MAX_CANVAS_PIXELS = IS_IOS ? 5_000_000 : 16_000_000;
const WIDE = () => window.matchMedia('(min-width: 1000px)').matches;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * pages[i] = {
 *   id, src (index into sources, or null for a blank page), index (0-based page in source),
 *   rotation (0/90/180/270), width, height (unrotated, points), view ([x0,y0,x1,y1] in PDF space),
 *   annotations: [...], ocr: { words: [...] } | undefined
 * }
 * Only `pages` is part of undo history; everything in it is plain JSON.
 */
const state = {
  sources: [], // { doc: PDFDocumentProxy, task, bytes: Uint8Array (decrypted), name, linkService }
  pages: [],
  images: new Map(), // imageId -> { bytes, mime, url }
  fileName: 'document.pdf',
  scale: 1,
  fitMode: true,
  tool: 'select',
  tab: 'view',
  selected: null, // { pageId, annId }
  current: 0,
  sensitive: false, // opened with a password: not autosaved
  formDirty: false,
  formTouched: new Set(), // ids of form fields (in the first file) the user changed
  pencilOnly: readPref('pencilOnly', false),
};

const toolDefaults = {
  text: { color: '#111111', size: 14, bold: false, opacity: 1 },
  ink: { stroke: '#1d3fbf', width: 2, opacity: 1 },
  rect: { stroke: '#e11d48', fill: null, width: 2, opacity: 1 },
  ellipse: { stroke: '#e11d48', fill: null, width: 2, opacity: 1 },
  line: { stroke: '#e11d48', width: 2, opacity: 1 },
  whiteout: { fill: '#ffffff', opacity: 1 },
  highlight: { color: '#facc15', opacity: 0.5 },
  underline: { color: '#e11d48', opacity: 1 },
  note: { color: '#facc15' },
  image: { opacity: 1 },
};
toolDefaults.edittext = toolDefaults.text;

const DRAG_TOOLS = new Set(['ink', 'rect', 'ellipse', 'line', 'whiteout', 'highlight', 'underline']);
const TAP_TOOLS = new Set(['text', 'edittext', 'note']);

const TOOL_HINTS = {
  text: '글자를 넣을 곳을 누르세요.',
  edittext: '고칠 기존 글자를 누르세요. 원래 글자를 가리고 그 자리에 고쳐 씁니다.',
  ink: '끌어서 자유롭게 그립니다. 두 손가락으로 화면을 움직입니다.',
  rect: '끌어서 사각형을 그립니다.',
  ellipse: '끌어서 원을 그립니다.',
  line: '끌어서 직선을 그립니다.',
  whiteout: '가릴 영역을 끌어서 지정합니다.',
  highlight: '강조할 글자 위를 끌어서 지나가세요.',
  underline: '밑줄을 그을 글자 위를 끌어서 지나가세요.',
  note: '메모를 붙일 곳을 누르세요.',
};

// Non-serialized per-page caches.
const pdfPageCache = new Map(); // `${src}:${index}` -> Promise<PDFPageProxy>
const textItemCache = new Map(); // `${src}:${index}` -> Promise<items[]>
const pageEls = new Map(); // page.id -> { outer, inner, canvas, svg, annDiv, renderedScale, task }
const thumbCache = new Map(); // `${page.id}:${rotation}` -> canvas
const fieldInfoCache = new Map(); // src -> Promise<Map<annotationId, info>>

const pageById = (id) => state.pages.find((p) => p.id === id);
const pageKey = (pg) => `${pg.src}:${pg.index}`;

function getPdfPage(pg) {
  const key = pageKey(pg);
  if (!pdfPageCache.has(key)) pdfPageCache.set(key, state.sources[pg.src].doc.getPage(pg.index + 1));
  return pdfPageCache.get(key);
}

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(`pdfedit.${key}`);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try { localStorage.setItem(`pdfedit.${key}`, JSON.stringify(value)); } catch { /* private mode */ }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const history = { stack: [], index: -1, saved: -1 };

function commit() {
  history.stack.length = history.index + 1;
  history.stack.push(JSON.stringify(state.pages));
  if (history.stack.length > 150) {
    history.stack.shift();
    history.saved--;
  }
  history.index = history.stack.length - 1;
  updateButtons();
  scheduleAutosave();
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
  scheduleAutosave();
  clearSearchResults();
}

const isDirty = () => history.index !== history.saved || state.formDirty;

// ---------------------------------------------------------------------------
// Opening files
// ---------------------------------------------------------------------------

/** Reads a file, removing its password if it has one. Returns decrypted bytes or null if cancelled. */
async function readPdfFile(file) {
  let bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksEncrypted(bytes)) return { bytes, encrypted: false };
  // Files that only restrict printing/editing open with an empty password.
  const open = await decrypt(bytes, '');
  if (open) return { bytes: open, encrypted: true, hadPassword: false };
  let message = '이 PDF는 비밀번호로 보호되어 있습니다.';
  for (;;) {
    const pw = await promptDialog({
      title: '비밀번호 입력',
      label: `${message}\n"${file.name}"`,
      type: 'password',
      ok: '열기',
      help: '비밀번호를 풀어서 엽니다. 편집 후 저장한 파일에는 비밀번호가 없습니다.',
    });
    if (pw == null) return null;
    const out = await withBusy('비밀번호를 해제하는 중…', () => decrypt(bytes, pw));
    if (out) return { bytes: out, encrypted: true, hadPassword: true };
    message = '비밀번호가 틀렸습니다. 다시 입력하세요.';
  }
}

function makeLinkService(srcIndex) {
  return {
    externalLinkEnabled: true,
    isInPresentationMode: false,
    eventBus: null,
    get pagesCount() { return state.pages.length; },
    addLinkAttributes(link, url) {
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer nofollow';
    },
    getDestinationHash: () => '#',
    getAnchorUrl: () => '#',
    async goToDestination(dest) {
      try {
        const doc = state.sources[srcIndex].doc;
        const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
        if (!Array.isArray(explicit)) return;
        const ref = explicit[0];
        const index = typeof ref === 'object' ? await doc.getPageIndex(ref) : ref;
        const at = state.pages.findIndex((p) => p.src === srcIndex && p.index === index);
        if (at >= 0) scrollToPage(at);
      } catch (err) {
        console.warn(err);
      }
    },
    goToPage(n) {
      const at = state.pages.findIndex((p) => p.src === srcIndex && p.index === n - 1);
      if (at >= 0) scrollToPage(at);
    },
    executeNamedAction() {},
    executeSetOCGState() {},
    setHash() {},
    navigateTo() {},
  };
}

async function loadSource(bytes, name) {
  const task = getDocument({ ...PDFJS_OPTIONS, data: bytes.slice() });
  task.onPassword = (update, reason) => {
    // qpdf removes passwords before this point; this is a last resort.
    promptDialog({ title: '비밀번호 입력', label: reason === PasswordResponses.INCORRECT_PASSWORD ? '비밀번호가 틀렸습니다.' : '비밀번호가 필요합니다.', type: 'password' })
      .then((pw) => (pw == null ? task.destroy() : update(pw)));
  };
  const doc = await task.promise;
  const src = state.sources.length;
  state.sources.push({ doc, task, bytes, name, linkService: makeLinkService(src) });
  const pages = [];
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    pdfPageCache.set(`${src}:${i}`, Promise.resolve(page));
    const view = [...page.view];
    pages.push({
      id: newId(), src, index: i, rotation: ((page.rotate % 360) + 360) % 360,
      width: view[2] - view[0], height: view[3] - view[1], view, annotations: [],
    });
  }
  return pages;
}

function resetDocument() {
  closeEditor(true);
  closeSearch();
  for (const s of state.sources) s.task.destroy();
  state.sources = [];
  pdfPageCache.clear();
  textItemCache.clear();
  thumbCache.clear();
  fieldInfoCache.clear();
  for (const { url } of state.images.values()) URL.revokeObjectURL(url);
  state.images.clear();
  for (const entry of pageEls.values()) entry.outer.remove();
  pageEls.clear();
  state.selected = null;
  state.current = 0;
  state.pages = [];
  state.formDirty = false;
  state.formTouched = new Set();
  state.sensitive = false;
}

async function openFile(file) {
  if (!file) return;
  if (state.pages.length && isDirty() && !(await confirmDialog('지금 문서의 편집 내용은 저장하지 않으면 사라집니다. 새 파일을 열까요?', { ok: '새 파일 열기' }))) return;
  try {
    const read = await readPdfFile(file);
    if (!read) return;
    await withBusy('PDF를 여는 중…', async () => {
      resetDocument();
      state.fileName = file.name || 'document.pdf';
      state.sensitive = !!read.hadPassword;
      state.pages = await loadSource(read.bytes, state.fileName);
      resetHistory();
      afterOpen();
    });
    if (read.hadPassword) toast('비밀번호를 해제했습니다. 보안을 위해 이 문서는 자동 저장하지 않습니다.', { duration: 5000 });
    else if (read.encrypted) toast('편집 제한이 걸린 PDF를 열었습니다. 저장하면 제한이 풀린 파일이 됩니다.', { duration: 5000 });
    if (state.sensitive) await store.clearSession().catch(() => {});
    else {
      store.saveSources(state.sources).catch((err) => console.warn('autosave', err));
      scheduleAutosave(0);
    }
  } catch (err) {
    showError('PDF를 열지 못했습니다', err);
  }
}

function afterOpen() {
  $('empty').hidden = true;
  $('doc-title').textContent = state.fileName;
  document.title = `${state.fileName} – PDF 편집기`;
  state.fitMode = true;
  fitWidth(true);
  setTab('view');
  if (WIDE()) openPanel(true);
  checkForms();
}

async function appendFile(file) {
  if (!file || !state.pages.length) return;
  try {
    const read = await readPdfFile(file);
    if (!read) return;
    await withBusy('페이지를 추가하는 중…', async () => {
      const pages = await loadSource(read.bytes, file.name);
      const at = state.current + 1;
      state.pages.splice(at, 0, ...pages);
      if (read.hadPassword) state.sensitive = true;
      commit();
      rebuild();
      scrollToPage(at);
      toast(`${file.name}의 ${pages.length}쪽을 추가했습니다.`);
    });
    if (state.sensitive) store.clearSession().catch(() => {});
    else store.saveSources(state.sources).catch((err) => console.warn('autosave', err));
  } catch (err) {
    showError('페이지를 추가하지 못했습니다', err);
  }
}

async function checkForms() {
  const src = state.sources[0];
  if (!src) return;
  const infos = await getFieldInfo(0).catch(() => new Map());
  if (infos.size) toast('이 PDF에는 입력 칸이 있습니다. 칸을 눌러 바로 입력하세요.', { duration: 4500 });
}

// ---------------------------------------------------------------------------
// Autosave (this device only)
// ---------------------------------------------------------------------------

let autosaveTimer = null;
function scheduleAutosave(delay = 800) {
  if (state.sensitive || !state.pages.length) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    const formValues = state.sources.map((s) => formValuesOf(s.doc));
    store.saveSessionState({
      fileName: state.fileName,
      pages: state.pages,
      images: [...state.images].map(([id, { bytes, mime }]) => [id, { bytes, mime }]),
      formValues: structuredCloneSafe(formValues),
      formTouched: [...state.formTouched],
      dirty: isDirty(),
    }).catch((err) => console.warn('autosave', err));
  }, delay);
}

/** Form field values typed into a document: { annotationId: { value } }, or null. */
function formValuesOf(doc) {
  const { map } = doc.annotationStorage.serializable;
  return map?.size ? Object.fromEntries(map) : null;
}

function structuredCloneSafe(v) {
  try { return structuredClone(v); } catch { return null; }
}

async function showRestoreCard() {
  const card = $('restore-card');
  let session = null;
  try { session = await store.loadSession(); } catch { /* storage unavailable */ }
  if (!session) { card.hidden = true; return; }
  const when = new Date(session.state.savedAt).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  card.replaceChildren(
    h('div', { class: 'restore-info' },
      h('strong', {}, '이전 작업 이어서 하기'),
      h('span', { class: 'muted small' }, `${session.state.fileName} · ${when}`)),
    h('div', { class: 'restore-actions' },
      h('button', { class: 'btn small', onclick: async () => { await store.clearSession(); card.hidden = true; } }, '지우기'),
      h('button', { class: 'btn primary small', onclick: () => restoreSession(session) }, '이어서 하기')),
  );
  card.hidden = false;
}

async function restoreSession(session) {
  try {
    await withBusy('이전 작업을 불러오는 중…', async () => {
      resetDocument();
      for (const s of session.sources) await loadSource(s.bytes, s.name);
      state.fileName = session.state.fileName;
      for (const [id, img] of session.state.images || []) {
        state.images.set(id, { ...img, url: URL.createObjectURL(new Blob([img.bytes], { type: img.mime })) });
      }
      (session.state.formValues || []).forEach((values, i) => {
        const storage = state.sources[i]?.doc.annotationStorage;
        if (!values || !storage) return;
        for (const [id, value] of Object.entries(values)) storage.setValue(id, value);
      });
      state.pages = session.state.pages;
      state.formTouched = new Set(session.state.formTouched || []);
      state.formDirty = state.formTouched.size > 0;
      resetHistory();
      if (session.state.dirty) history.saved = -1; // still unsaved
      else state.formDirty = false;
      afterOpen();
    });
    $('restore-card').hidden = true;
    updateButtons();
  } catch (err) {
    showError('이전 작업을 불러오지 못했습니다', err);
  }
}

async function closeDocument() {
  if (!state.pages.length) return;
  if (isDirty() && !(await confirmDialog('저장하지 않은 편집 내용이 있습니다. 문서를 닫으면 이 기기에 보관된 작업도 지워집니다.', { ok: '닫기', danger: true }))) return;
  resetDocument();
  await store.clearSession().catch(() => {});
  history.stack = [];
  history.index = -1;
  history.saved = -1;
  rebuild();
  $('empty').hidden = false;
  $('doc-title').textContent = 'PDF 편집기';
  document.title = 'PDF 편집기';
  openPanel(false);
  showRestoreCard();
}

// ---------------------------------------------------------------------------
// Page layout & rendering
// ---------------------------------------------------------------------------

const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const pg = pageById(e.target.dataset.pageId);
      if (!pg) continue;
      if (e.isIntersecting) renderCanvas(pg);
      else releaseCanvas(pg);
    }
  },
  { root: $('viewer'), rootMargin: '900px 300px' },
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
  const entry = { outer, inner, canvas: null, svg: overlay, annDiv: null, renderedScale: 0, task: null };
  const pgOf = () => pageById(outer.dataset.pageId);
  overlay.addEventListener('pointerdown', (e) => onPointerDown(e, pgOf()));
  overlay.addEventListener('pointermove', (e) => onPointerMove(e, pgOf()));
  overlay.addEventListener('pointerup', (e) => onPointerUp(e, pgOf()));
  overlay.addEventListener('pointercancel', (e) => onPointerCancel(e));
  overlay.addEventListener('touchstart', (e) => {
    // Dragging an object must not scroll the page.
    if (state.tool === 'select' && e.target.closest?.('[data-id],[data-handle]') && e.touches.length === 1) e.preventDefault();
  }, { passive: false });
  // In select mode the overlay lets taps through to form fields and links;
  // a tap on empty space clears the selection.
  outer.addEventListener('pointerdown', (e) => {
    if (state.tool === 'select' && !e.target.closest('[data-id],[data-handle]') && state.selected) select(null, null);
  });
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
  entry.inner.style.setProperty('--scale-factor', s);
  entry.inner.style.setProperty('--total-scale-factor', s);
  const W = pg.width * s, H = pg.height * s;
  entry.inner.style.transform = {
    0: 'none',
    90: `translate(${H}px, 0) rotate(90deg)`,
    180: `translate(${W}px, ${H}px) rotate(180deg)`,
    270: `translate(0, ${W}px) rotate(270deg)`,
  }[pg.rotation];
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
  renderOptbar();
}

function isNearViewport(el) {
  const v = $('viewer').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return r.bottom > v.top - 900 && r.top < v.bottom + 900;
}

function releaseCanvas(pg) {
  const entry = pageEls.get(pg.id);
  if (!entry?.canvas) return;
  entry.task?.cancel();
  entry.task = null;
  entry.canvas.width = entry.canvas.height = 0; // frees the bitmap right away on iOS
  entry.canvas.remove();
  entry.canvas = null;
  entry.renderedScale = 0;
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
  canvas.className = 'page-canvas';
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const forms = pg.src === 0;
  const task = page.render({
    canvas, canvasContext: canvas.getContext('2d'), viewport,
    annotationMode: forms ? AnnotationMode.ENABLE_FORMS : AnnotationMode.ENABLE,
  });
  entry.task = task;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.error(err);
    if (entry.renderedScale === scale) entry.renderedScale = 0;
    canvas.width = canvas.height = 0;
    return;
  }
  if (entry.task !== task) { canvas.width = canvas.height = 0; return; }
  entry.task = null;
  if (entry.canvas) { entry.canvas.width = entry.canvas.height = 0; entry.canvas.remove(); }
  entry.canvas = canvas;
  entry.inner.insertBefore(canvas, entry.inner.firstChild);
  if (!entry.annDiv) renderAnnotationLayer(pg, entry, page).catch((err) => console.warn('annotation layer', err));
}

/** Form fields, links and pop-up notes that are already in the PDF. */
async function renderAnnotationLayer(pg, entry, page) {
  const annotations = await page.getAnnotations({ intent: 'display' });
  if (!annotations.length || entry.annDiv) return;
  const source = state.sources[pg.src];
  const div = document.createElement('div');
  div.className = 'annotationLayer';
  entry.annDiv = div;
  entry.inner.insertBefore(div, entry.svg);
  const viewport = page.getViewport({ scale: 1, rotation: 0 }).clone({ dontFlip: true });
  const layer = new AnnotationLayer({
    div, page, viewport, annotationStorage: source.doc.annotationStorage, linkService: source.linkService,
    accessibilityManager: null, annotationCanvasMap: null, annotationEditorUIManager: null, structTreeLayer: null,
  });
  const forms = pg.src === 0;
  if (forms) {
    // PDF.js also writes default values into its storage while rendering, so
    // only fields the user actually changed count as edits.
    const touched = (e) => {
      const id = e.target.closest?.('[data-element-id]')?.dataset.elementId;
      if (!id) return;
      state.formTouched.add(id);
      state.formDirty = true;
      updateButtons();
      scheduleAutosave();
    };
    div.addEventListener('input', touched);
    div.addEventListener('change', touched);
  }
  await layer.render({
    annotations,
    imageResourcesPath: vendorUrl('images'),
    renderForms: forms,
    enableScripting: false,
    hasJSActions: false,
    fieldObjects: forms ? await source.doc.getFieldObjects().catch(() => null) : null,
    enableAnnotationEditing: false,
  });
}

// ---------------------------------------------------------------------------
// Overlay (edits) rendering
// ---------------------------------------------------------------------------

let editor = null; // { pg, ann, textarea, original, isNew, whiteoutId }

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
  drawSearchHits(root, pg);
  if (drag?.preview && drag.pg === pg) {
    for (const q of drag.preview) svg('rect', { class: 'markup-guide', x: q.x, y: q.y, width: q.w, height: q.h }, root);
  }
  const sel = state.selected;
  if (sel && sel.pageId === pg.id) {
    const a = pg.annotations.find((x) => x.id === sel.annId);
    if (a && !(editor && editor.ann.id === a.id)) {
      const b = bbox(a);
      const pad = 5 / s;
      svg('rect', {
        class: 'sel-box', x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, 'vector-effect': 'non-scaling-stroke',
      }, root);
      if (canResize(a)) {
        const g = svg('g', { 'data-handle': a.id }, root);
        const cx = b.x + b.w + pad, cy = b.y + b.h + pad;
        svg('circle', { cx, cy, r: 22 / s, fill: 'transparent' }, g); // finger-sized hit area
        svg('circle', { class: 'handle', cx, cy, r: 7 / s, 'vector-effect': 'non-scaling-stroke' }, g);
      }
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
      splitLines(a.text).forEach((line, i) => {
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
      }, root);
      break;
    case 'ellipse':
      svg('ellipse', {
        ...common, cx: a.x + a.w / 2, cy: a.y + a.h / 2, rx: a.w / 2, ry: a.h / 2, style: blend,
        fill: a.fill || 'none', stroke: a.stroke || 'none', 'stroke-width': a.stroke ? a.width : 0,
      }, root);
      break;
    case 'line': {
      const g = svg('g', common, root);
      const pts = { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 };
      svg('line', { ...pts, stroke: 'transparent', 'stroke-width': Math.max(a.width, 16 / s) }, g);
      svg('line', { ...pts, stroke: a.stroke, 'stroke-width': a.width, 'stroke-linecap': 'round', style: blend }, g);
      break;
    }
    case 'ink': {
      const g = svg('g', common, root);
      const d = inkPath(a.points);
      svg('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(a.width, 16 / s), 'stroke-linecap': 'round' }, g);
      svg('path', { d, fill: 'none', stroke: a.stroke, 'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', style: blend }, g);
      break;
    }
    case 'image': {
      const img = state.images.get(a.imageId);
      svg('image', { ...common, href: img?.url, x: a.x, y: a.y, width: a.w, height: a.h, preserveAspectRatio: 'none' }, root);
      break;
    }
    case 'markup': {
      const g = svg('g', { ...common, opacity: 1 }, root);
      for (const q of a.quads) {
        if (a.kind === 'underline') {
          const th = Math.max(0.5, q.h / 14);
          svg('rect', { x: q.x, y: q.y, width: q.w, height: q.h, fill: 'transparent' }, g);
          svg('rect', { x: q.x, y: q.y + q.h - th * 1.5, width: q.w, height: th, fill: a.color, opacity: a.opacity ?? 1 }, g);
        } else {
          svg('rect', { x: q.x, y: q.y, width: q.w, height: q.h, fill: a.color, opacity: a.opacity ?? 0.5, style: 'mix-blend-mode: multiply' }, g);
        }
      }
      break;
    }
    case 'note': {
      const g = svg('g', { ...common, class: 'note-icon' }, root);
      const k = a.w / 20;
      const icon = svg('g', { transform: `translate(${a.x} ${a.y}) scale(${k})` }, g);
      svg('path', {
        d: 'M3 1h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4.5 4.5L5 14H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2Z',
        fill: a.color, stroke: '#3f3f46', 'stroke-width': 1,
      }, icon);
      svg('path', { d: 'M5 5h10M5 8h10M5 11h6', stroke: '#3f3f46', 'stroke-width': 1.2, 'stroke-linecap': 'round' }, icon);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Text on the page (PDF text, plus OCR words)
// ---------------------------------------------------------------------------

function getTextItems(pg) {
  if (pg.src == null) return Promise.resolve(ocrItems(pg));
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
  return textItemCache.get(key).then((items) => items.concat(ocrItems(pg)));
}

function ocrItems(pg) {
  return (pg.ocr?.words || []).map((w) => ({
    str: w.text, x: w.x, y: w.y, w: w.w, h: w.h, baseline: w.base, fontHeight: Math.max(4, (w.base - w.y) * 1.15), ocr: true,
  }));
}

const hitItem = (it, p) => p.x >= it.x - 1 && p.x <= it.x + it.w + 1 && p.y >= it.y - 1 && p.y <= it.y + it.h + 1;

/** Groups text items into lines (top to bottom), each with per-character boxes. */
function textLines(items) {
  const sorted = [...items].sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(l.baseline - it.baseline) < Math.min(l.h, it.h) * 0.45);
    if (line) {
      line.items.push(it);
      line.y = Math.min(line.y, it.y);
      line.bottom = Math.max(line.bottom, it.y + it.h);
      line.h = line.bottom - line.y;
    } else {
      lines.push({ baseline: it.baseline, y: it.y, bottom: it.y + it.h, h: it.h, items: [it] });
    }
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    l.chars = [];
    for (const it of l.items) {
      const chars = [...it.str];
      const cw = it.w / Math.max(chars.length, 1);
      chars.forEach((c, i) => l.chars.push({ c, x: it.x + cw * i, w: cw }));
    }
  }
  return lines.sort((a, b) => a.y - b.y);
}

/** Quads covering the text between two points in reading order (like selecting text). */
function quadsBetween(lines, s, e, rect) {
  const lineAt = (p) => {
    let best = -1, dist = Infinity;
    lines.forEach((l, i) => {
      const d = p.y < l.y ? l.y - p.y : p.y > l.bottom ? p.y - l.bottom : 0;
      if (d < dist) { dist = d; best = i; }
    });
    return dist <= (lines[best]?.h ?? 0) * 0.6 ? best : -1;
  };
  let si = lineAt(s), ei = lineAt(e);
  if (si < 0 || ei < 0) {
    const inBand = lines.map((l, i) => (l.bottom > rect.y && l.y < rect.y + rect.h ? i : -1)).filter((i) => i >= 0);
    if (!inBand.length) return null;
    if (si < 0) si = s.y <= e.y ? inBand[0] : inBand[inBand.length - 1];
    if (ei < 0) ei = s.y <= e.y ? inBand[inBand.length - 1] : inBand[0];
  }
  if (si > ei || (si === ei && s.x > e.x)) { [si, ei] = [ei, si]; [s, e] = [e, s]; }
  const quads = [];
  for (let i = si; i <= ei; i++) {
    const l = lines[i];
    const from = i === si ? s.x : -Infinity;
    const to = i === ei ? e.x : Infinity;
    const chars = l.chars.filter((c) => c.x + c.w / 2 >= from && c.x + c.w / 2 <= to && c.c.trim());
    if (!chars.length) continue;
    const x1 = chars[0].x, x2 = chars[chars.length - 1].x + chars[chars.length - 1].w;
    quads.push({ x: round2(x1), y: round2(l.y), w: round2(x2 - x1), h: round2(l.h) });
  }
  return quads;
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
  renderOptbar();
}

let drag = null;
let tap = null; // pending tap for tap tools: { pg, x, y, t, id }
let fingerPan = null; // one-finger scrolling while drawing with a pencil
let gestureActive = false;

function onPointerDown(e, pg) {
  if (e.pointerType === 'touch' && !e.isPrimary) {
    // A second finger means a pinch or pan, not a drawing.
    cancelDrag();
    tap = null;
    fingerPan = null;
    return;
  }
  if (!pg || (e.pointerType === 'mouse' && e.button !== 0) || gestureActive || drag) return;
  if (editor) {
    closeEditor();
    e.preventDefault();
    return;
  }
  const tool = state.tool;
  if (e.pointerType === 'pen' && !state.penSeen) {
    state.penSeen = true;
    if (!readPref('pencilAsked', false)) {
      writePref('pencilAsked', true);
      setPencilOnly(true);
      toast('Apple Pencil을 감지했습니다. 이제 손가락은 화면 이동, 펜슬은 그리기에 씁니다. (메뉴에서 바꿀 수 있음)', { duration: 6000 });
    }
  }
  if (DRAG_TOOLS.has(tool) && state.pencilOnly && e.pointerType === 'touch') {
    const v = $('viewer');
    fingerPan = { id: e.pointerId, x: e.clientX, y: e.clientY, left: v.scrollLeft, top: v.scrollTop };
    e.currentTarget.setPointerCapture(e.pointerId);
    return;
  }
  const p = toModel(pg, e);
  const d = toolDefaults[tool];

  if (tool === 'select') {
    const handle = e.target.closest('[data-handle]');
    const hit = e.target.closest('[data-id]');
    if (handle) {
      const { ann } = findAnn(state.selected);
      drag = { mode: 'resize', pg, ann, orig: structuredClone(ann), moved: false };
    } else if (hit) {
      const ann = pg.annotations.find((a) => a.id === hit.dataset.id);
      const wasSelected = state.selected?.annId === ann.id;
      select(pg, ann);
      drag = { mode: 'move', pg, ann, last: p, start: { x: e.clientX, y: e.clientY }, moved: false, wasSelected };
    } else {
      return;
    }
  } else if (TAP_TOOLS.has(tool)) {
    tap = { pg, x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
    return; // acted on in pointerup, so the keyboard can open on iOS
  } else if (tool === 'ink') {
    const ann = { id: newId(), type: 'ink', kind: 'ink', points: [[p.x, p.y]], stroke: d.stroke, width: d.width, opacity: d.opacity };
    pg.annotations.push(ann);
    drag = { mode: 'create', pg, ann, start: p };
  } else if (tool === 'line') {
    const ann = { id: newId(), type: 'line', kind: 'line', x1: p.x, y1: p.y, x2: p.x, y2: p.y, stroke: d.stroke, width: d.width, opacity: d.opacity };
    pg.annotations.push(ann);
    drag = { mode: 'create', pg, ann, start: p };
  } else if (tool === 'highlight' || tool === 'underline') {
    drag = { mode: 'markup', pg, start: p, end: p, lines: null, preview: [] };
    getTextItems(pg).then((items) => { if (drag?.mode === 'markup') { drag.lines = textLines(items); updateMarkupPreview(); } });
  } else if (['rect', 'ellipse', 'whiteout'].includes(tool)) {
    const ann = {
      id: newId(), type: tool === 'ellipse' ? 'ellipse' : 'rect', kind: tool,
      x: p.x, y: p.y, w: 0, h: 0, stroke: d.stroke ?? null, fill: d.fill ?? null, width: d.width ?? 0, opacity: d.opacity,
    };
    pg.annotations.push(ann);
    drag = { mode: 'create', pg, ann, start: p };
  } else {
    return;
  }
  drag.pointerId = e.pointerId;
  e.currentTarget.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function updateMarkupPreview() {
  const { start, end, lines } = drag;
  const rect = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) };
  const quads = lines?.length ? quadsBetween(lines, start, end, rect) : null;
  drag.preview = quads ?? (rect.w > 2 && rect.h > 2 ? [rect] : []);
  drag.fromText = !!quads;
  renderOverlay(drag.pg);
}

function onPointerMove(e) {
  if (fingerPan && e.pointerId === fingerPan.id) {
    const v = $('viewer');
    v.scrollLeft = fingerPan.left - (e.clientX - fingerPan.x);
    v.scrollTop = fingerPan.top - (e.clientY - fingerPan.y);
    return;
  }
  if (!drag || e.pointerId !== drag.pointerId) return;
  const { pg: dpg, ann } = drag;
  const p = toModel(dpg, e);
  if (drag.mode === 'move') {
    if (!drag.moved && Math.hypot(e.clientX - drag.start.x, e.clientY - drag.start.y) < 4) return;
    translate(ann, p.x - drag.last.x, p.y - drag.last.y);
    drag.last = p;
    drag.moved = true;
  } else if (drag.mode === 'resize') {
    const keepRatio = ann.type === 'image' ? !e.shiftKey : e.shiftKey;
    const pad = 5 / state.scale;
    resizeTo(ann, drag.orig, p.x - pad, p.y - pad, keepRatio);
    drag.moved = true;
  } else if (drag.mode === 'markup') {
    drag.end = p;
    updateMarkupPreview();
    return;
  } else if (ann.type === 'ink') {
    for (const ce of e.getCoalescedEvents?.() ?? [e]) {
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
    let w = p.x - drag.start.x, h0 = p.y - drag.start.y;
    if (e.shiftKey) {
      const m = Math.max(Math.abs(w), Math.abs(h0));
      w = Math.sign(w || 1) * m;
      h0 = Math.sign(h0 || 1) * m;
    }
    ann.x = Math.min(drag.start.x, drag.start.x + w);
    ann.y = Math.min(drag.start.y, drag.start.y + h0);
    ann.w = Math.abs(w);
    ann.h = Math.abs(h0);
  }
  renderOverlay(dpg);
}

function onPointerUp(e, pg) {
  if (fingerPan && e.pointerId === fingerPan.id) { fingerPan = null; return; }
  if (tap && e.pointerId === tap.id) {
    const t = tap;
    tap = null;
    if (Math.hypot(e.clientX - t.x, e.clientY - t.y) < 10 && e.timeStamp - t.t < 800 && pg) handleTap(pg, toModel(pg, e));
    return;
  }
  if (!drag || e.pointerId !== drag.pointerId) return;
  const { mode, ann, moved } = drag;
  const dpg = drag.pg;
  const finished = drag;
  drag = null;
  if (mode === 'create') {
    const b = bbox(ann);
    const tooSmall = ann.type === 'ink' ? false : ann.type === 'line' ? Math.hypot(b.w, b.h) < 2 : b.w < 2 || b.h < 2;
    if (tooSmall) {
      dpg.annotations.splice(dpg.annotations.indexOf(ann), 1);
    } else {
      if (ann.type === 'ink') ann.points = simplify(ann.points, 0.6 / state.scale).map(([x, y]) => [round2(x), round2(y)]);
      commit();
    }
    renderOverlay(dpg);
  } else if (mode === 'markup') {
    const quads = finished.preview;
    if (quads?.length) {
      const d = toolDefaults[state.tool];
      dpg.annotations.push({ id: newId(), type: 'markup', kind: state.tool, quads, color: d.color, opacity: d.opacity });
      commit();
    } else if (!finished.lines?.length) {
      toast('이 페이지에서 글자를 찾지 못했습니다. 스캔 문서라면 끌어서 영역을 지정하세요.');
    }
    renderOverlay(dpg);
  } else if (moved) {
    commit();
    renderOptbar();
  } else if (mode === 'move' && finished.wasSelected) {
    // Second tap on a selected object opens it.
    if (ann.type === 'text') openEditor(dpg, ann, { isNew: false });
    else if (ann.type === 'note') editNote(dpg, ann);
  }
}

function onPointerCancel(e) {
  if (fingerPan && e.pointerId === fingerPan.id) fingerPan = null;
  if (tap && e.pointerId === tap.id) tap = null;
  if (drag && e.pointerId === drag.pointerId) cancelDrag();
}

function cancelDrag() {
  if (!drag) return;
  const { mode, pg, ann } = drag;
  if (mode === 'create') pg.annotations.splice(pg.annotations.indexOf(ann), 1);
  else if (mode === 'move' || mode === 'resize') {
    // Undo the partial move by reloading the last committed state of this page.
    const saved = JSON.parse(history.stack[history.index]).find((p) => p.id === pg.id);
    if (saved) pg.annotations = saved.annotations;
  }
  drag = null;
  renderOverlay(pg);
}

function handleTap(pg, p) {
  const tool = state.tool;
  const d = toolDefaults[tool];
  if (tool === 'text') {
    const ann = { id: newId(), type: 'text', kind: 'text', x: p.x, y: p.y - (d.size * LINE_HEIGHT) / 2, text: '', size: d.size, color: d.color, bold: d.bold, opacity: d.opacity };
    pg.annotations.push(ann);
    openEditor(pg, ann, { isNew: true });
  } else if (tool === 'edittext') {
    editExistingText(pg, p);
  } else if (tool === 'note') {
    addNote(pg, p);
  }
}

const round2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Touch gestures: pinch to zoom, two-finger pan
// ---------------------------------------------------------------------------

function setupGestures() {
  const viewer = $('viewer');
  const pagesEl = $('pages');
  let pinch = null;
  const center = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  viewer.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2 || !state.pages.length) return;
    e.preventDefault();
    cancelDrag();
    tap = null;
    fingerPan = null;
    gestureActive = true;
    const c = center(e.touches);
    const pr = pagesEl.getBoundingClientRect();
    pinch = { d0: dist(e.touches), c0: c, c: c, r: 1, anchor: anchorAt(c), origin: { x: c.x - pr.left, y: c.y - pr.top } };
    pagesEl.style.transformOrigin = `${pinch.origin.x}px ${pinch.origin.y}px`;
  }, { passive: false });

  viewer.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length < 2) return;
    e.preventDefault();
    const c = center(e.touches);
    const minR = 0.25 / state.scale, maxR = 5 / state.scale;
    pinch.r = Math.min(Math.max(dist(e.touches) / pinch.d0, minR), maxR);
    pinch.c = c;
    pagesEl.style.transform = `translate(${c.x - pinch.c0.x}px, ${c.y - pinch.c0.y}px) scale(${pinch.r})`;
  }, { passive: false });

  const end = (e) => {
    if (!pinch || e.touches.length >= 2) return;
    const { r, c, c0, anchor } = pinch;
    pinch = null;
    pagesEl.style.transform = '';
    setTimeout(() => { gestureActive = false; }, 50);
    if (Math.abs(r - 1) < 0.03) {
      viewer.scrollLeft -= c.x - c0.x;
      viewer.scrollTop -= c.y - c0.y;
      return;
    }
    state.fitMode = false;
    setScale(state.scale * r, { anchor, at: c });
  };
  viewer.addEventListener('touchend', end);
  viewer.addEventListener('touchcancel', end);
  // Stop Safari's own page zoom.
  for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

/** The page and relative position under a screen point, to keep it in place across zooms. */
function anchorAt(pt) {
  for (const pg of state.pages) {
    const r = pageEls.get(pg.id)?.outer.getBoundingClientRect();
    if (r && pt.y >= r.top - 8 && pt.y <= r.bottom + 8) return { id: pg.id, fx: (pt.x - r.left) / r.width, fy: (pt.y - r.top) / r.height };
  }
  return null;
}

function restoreAnchor(anchor, at) {
  const entry = anchor && pageEls.get(anchor.id);
  if (!entry) return;
  const viewer = $('viewer');
  const r = entry.outer.getBoundingClientRect();
  viewer.scrollLeft += r.left + anchor.fx * r.width - at.x;
  viewer.scrollTop += r.top + anchor.fy * r.height - at.y;
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
  ta.setAttribute('autocapitalize', 'off');
  ta.value = ann.text;
  editor = { pg, ann, textarea: ta, original: ann.text, isNew, whiteoutId };
  const fit = () => {
    const s = state.scale;
    const { w, h: th } = measureText(ann);
    ta.style.left = `${ann.x * s}px`;
    ta.style.top = `${ann.y * s}px`;
    ta.style.font = fontCss(ann.size * s, ann.bold);
    ta.style.lineHeight = String(LINE_HEIGHT);
    ta.style.color = ann.color;
    ta.style.width = `${Math.max(w * s + ann.size * s, 60)}px`;
    ta.style.height = `${Math.max(th * s, ann.size * s * LINE_HEIGHT)}px`;
  };
  editor.fit = fit;
  ta.addEventListener('input', () => { ann.text = ta.value; fit(); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      closeEditor();
    }
    e.stopPropagation();
  });
  ta.addEventListener('blur', () => setTimeout(() => editor?.textarea === ta && !ta.matches(':focus') && closeEditor(), 120));
  fit();
  entry.inner.append(ta);
  select(pg, ann);
  renderOverlay(pg);
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(ta.value.length, ta.value.length);
  // Keep the box visible above the on-screen keyboard.
  setTimeout(() => ta.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350);
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
  const meaningful = changed && !(isNew && !ann.text.trim() && !whiteoutId);
  if (meaningful && !silent) commit();
  renderOverlay(pg);
  renderOptbar();
}

async function editExistingText(pg, p) {
  const items = await getTextItems(pg);
  const item = items.find((it) => hitItem(it, p));
  if (!item) {
    toast(items.length ? '누른 위치에서 글자를 찾지 못했습니다. 글자 위를 정확히 눌러 주세요.' : '이 페이지에는 글자 정보가 없습니다. 스캔 문서라면 [페이지 → 문자 인식]을 먼저 하세요.', { duration: 4500 });
    return;
  }
  const wd = toolDefaults.whiteout;
  const pad = Math.max(1, item.fontHeight * 0.08);
  const white = {
    id: newId(), type: 'rect', kind: 'whiteout',
    x: item.x - pad, y: item.y - pad, w: item.w + pad * 2, h: item.h + pad * 2, stroke: null, fill: wd.fill, width: 0, opacity: 1,
  };
  const size = Math.round(item.fontHeight * 10) / 10;
  const text = {
    id: newId(), type: 'text', kind: 'text', x: item.x, y: item.baseline - baselineOffset(size, 0),
    text: item.str, size, color: '#000000', bold: false, opacity: 1,
  };
  pg.annotations.push(white, text);
  openEditor(pg, text, { isNew: true, whiteoutId: white.id });
  editor.textarea.select();
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

async function noteDialog(text, existing) {
  const ta = h('textarea', { class: 'field note-text', rows: 5, placeholder: '메모 내용' });
  ta.value = text;
  const actions = [{ label: '취소', value: null }];
  if (existing) actions.push({ label: '삭제', value: 'delete', danger: true });
  actions.push({ label: '저장', value: 'save', primary: true });
  const v = await showSheet({ title: existing ? '메모' : '메모 붙이기', content: ta, actions, onOpen: () => setTimeout(() => ta.focus(), 60) });
  return v === 'save' ? { text: ta.value.trim() } : v;
}

async function addNote(pg, p) {
  const r = await noteDialog('', false);
  if (!r?.text) return;
  const size = 20;
  const ann = { id: newId(), type: 'note', kind: 'note', x: round2(p.x - size / 2), y: round2(p.y - size / 2), w: size, h: size, text: r.text, color: toolDefaults.note.color };
  pg.annotations.push(ann);
  commit();
  renderOverlay(pg);
  toast('메모를 붙였습니다. 저장하면 다른 PDF 앱에서도 메모로 보입니다.');
}

async function editNote(pg, ann) {
  const r = await noteDialog(ann.text, true);
  if (r === 'delete') {
    deleteSelected();
  } else if (r?.text != null && r.text !== ann.text) {
    if (!r.text) return deleteSelected();
    ann.text = r.text;
    commit();
  }
}

// ---------------------------------------------------------------------------
// Images, signatures, stamps
// ---------------------------------------------------------------------------

async function registerImage(blob, mime = blob.type) {
  let bytes = new Uint8Array(await blob.arrayBuffer());
  if (mime !== 'image/png' && mime !== 'image/jpeg') {
    const bitmap = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext('2d').drawImage(bitmap, 0, 0);
    bytes = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
    mime = 'image/png';
  }
  const imageId = newId();
  state.images.set(imageId, { bytes, mime, url: URL.createObjectURL(new Blob([bytes], { type: mime })) });
  return imageId;
}

/** Visible centre of the current page, in page points. */
function visibleCenter(pg) {
  const r = pageEls.get(pg.id).outer.getBoundingClientRect();
  const v = $('viewer').getBoundingClientRect();
  const cx = (Math.max(r.left, v.left) + Math.min(r.right, v.right)) / 2;
  const cy = (Math.max(r.top, v.top) + Math.min(r.bottom, v.bottom)) / 2;
  return toModel(pg, { clientX: cx, clientY: cy });
}

/** Places an image on the current page, sized to `targetW` points wide (at most). */
function placeImage(imageId, natW, natH, kind, targetW) {
  const pg = state.pages[state.current];
  if (!pg) return;
  const k = Math.min(targetW / natW, (pg.width * 0.8) / natW, (pg.height * 0.8) / natH);
  const w = round2(natW * k), hh = round2(natH * k);
  const c = visibleCenter(pg);
  const x = Math.min(Math.max(c.x - w / 2, 0), pg.width - w);
  const y = Math.min(Math.max(c.y - hh / 2, 0), pg.height - hh);
  const ann = { id: newId(), type: 'image', kind, imageId, x: round2(x), y: round2(y), w, h: hh, opacity: 1 };
  pg.annotations.push(ann);
  commit();
  setTool('select');
  select(pg, ann);
  toast('끌어서 위치를 옮기고, 오른쪽 아래 동그라미로 크기를 조절하세요.');
}

async function insertImage(file) {
  if (!file || !state.pages.length) return;
  try {
    const bitmap = await createImageBitmap(file);
    const imageId = await registerImage(file, file.type);
    placeImage(imageId, bitmap.width, bitmap.height, 'image', state.pages[state.current].width * 0.6);
  } catch (err) {
    showError('이미지를 넣지 못했습니다', err);
  }
}

const SIGN_WIDTH = 140; // pt (about 5 cm)
const STAMP_WIDTH = 56; // pt (about 2 cm)

async function useSignatureResult(res, kind) {
  if (!res) return;
  if (res.keep) {
    await store.libraryAdd({ id: newId(), kind, blob: res.blob, width: res.width, height: res.height, created: Date.now() }).catch((err) => console.warn(err));
    await loadLibrary();
  }
  const imageId = await registerImage(res.blob, 'image/png');
  placeImage(imageId, res.width, res.height, kind, kind === 'stamp' ? STAMP_WIDTH : SIGN_WIDTH);
}

let library = [];
const libraryImageIds = new Map(); // library item id -> imageId in this document
async function loadLibrary() {
  try {
    library = await store.libraryList();
  } catch {
    library = [];
  }
  if (state.tab === 'sign') renderToolbar();
}

async function placeLibraryItem(item) {
  if (!state.pages.length) return;
  let imageId = libraryImageIds.get(item.id);
  if (!imageId || !state.images.has(imageId)) {
    imageId = await registerImage(item.blob, 'image/png');
    libraryImageIds.set(item.id, imageId);
  }
  placeImage(imageId, item.width, item.height, item.kind, item.kind === 'stamp' ? STAMP_WIDTH : SIGN_WIDTH);
}

async function manageLibrary() {
  const list = h('div', { class: 'lib-manage' });
  const render = () => {
    list.replaceChildren();
    if (!library.length) list.append(h('p', { class: 'muted' }, '보관한 서명·도장이 없습니다.'));
    for (const item of library) {
      const url = URL.createObjectURL(item.blob);
      list.append(h('div', { class: 'lib-row' },
        h('div', { class: 'lib-thumb checker' }, h('img', { src: url, alt: '' })),
        h('span', {}, item.kind === 'stamp' ? '도장' : '서명'),
        h('span', { class: 'muted small' }, new Date(item.created).toLocaleDateString('ko-KR')),
        h('button', {
          class: 'btn small danger',
          onclick: async () => {
            await store.libraryDelete(item.id);
            await loadLibrary();
            render();
          },
        }, '삭제')));
    }
  };
  render();
  await showSheet({ title: '서명·도장 보관함', content: h('div', {}, h('p', { class: 'muted small' }, '보관함은 이 기기의 브라우저에만 저장됩니다.'), list), actions: [{ label: '닫기', primary: true }] });
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
  renderOptbar();
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

const currentPage = () => state.pages[state.current];

function rotatePage(delta) {
  const pg = currentPage();
  if (!pg) return;
  closeEditor();
  pg.rotation = (pg.rotation + delta + 360) % 360;
  commit();
  rebuild();
  scrollToPage(state.current);
}

function movePageTo(from, to) {
  if (from === to || to < 0 || to >= state.pages.length) return;
  closeEditor();
  const [pg] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, pg);
  commit();
  rebuild();
  scrollToPage(to);
}

function insertBlank() {
  const pg = currentPage();
  if (!pg) return;
  const [w, hh] = rotatedSize(pg);
  const blank = { id: newId(), src: null, index: 0, rotation: 0, width: w, height: hh, view: [0, 0, w, hh], annotations: [] };
  state.pages.splice(state.current + 1, 0, blank);
  commit();
  rebuild();
  scrollToPage(state.current + 1);
  toast('빈 페이지를 추가했습니다.');
}

async function deletePage() {
  if (state.pages.length <= 1) return toast('마지막 남은 페이지는 삭제할 수 없습니다.');
  closeEditor();
  const n = state.current + 1;
  const [removed] = state.pages.splice(state.current, 1);
  if (state.selected?.pageId === removed.id) state.selected = null;
  state.current = Math.min(state.current, state.pages.length - 1);
  commit();
  rebuild();
  clearSearchResults();
  toast(`${n}쪽을 삭제했습니다.`, { action: { label: '되돌리기', onClick: () => restore(-1) } });
}

// ---------------------------------------------------------------------------
// Thumbnails panel (sidebar on wide screens, bottom sheet on phones)
// ---------------------------------------------------------------------------

let thumbQueue = Promise.resolve();
const thumbIo = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbIo.unobserve(e.target);
    const pg = pageById(e.target.dataset.pageId);
    if (pg) {
      const frame = e.target.querySelector('.thumb-box');
      thumbQueue = thumbQueue.then(() => renderThumb(pg, `${pg.id}:${pg.rotation}`, frame)).catch(console.error);
    }
  }
}, { root: $('thumbs'), rootMargin: '300px' });

function rebuildThumbs() {
  const box = $('thumbs');
  box.replaceChildren();
  state.pages.forEach((pg, i) => {
    const frame = h('div', { class: 'thumb-box' });
    const [rw, rh] = rotatedSize(pg);
    frame.style.aspectRatio = `${rw} / ${rh}`;
    const el = h('button', { class: 'thumb', 'data-index': i, 'data-page-id': pg.id, 'aria-label': `${i + 1}쪽` },
      frame, h('span', { class: 'thumb-label' }, String(i + 1)));
    el.addEventListener('click', () => {
      if (thumbDrag.suppressClick) return;
      scrollToPage(i);
    });
    setupThumbDrag(el, i);
    box.append(el);
    const cached = thumbCache.get(`${pg.id}:${pg.rotation}`);
    if (cached) frame.append(cached);
    else thumbIo.observe(el);
  });
  highlightThumb();
}

async function renderThumb(pg, key, frame) {
  if (!frame?.isConnected) return;
  const [rw, rh] = rotatedSize(pg);
  const k = 160 / Math.max(rw, rh);
  const canvas = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rw * k * dpr);
  canvas.height = Math.round(rh * k * dpr);
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

const thumbDrag = { suppressClick: false };
function setupThumbDrag(el, index) {
  let timer = null, start = null, active = false, ghost = null, target = index;
  const clear = () => {
    clearTimeout(timer);
    timer = null;
    if (ghost) ghost.remove();
    ghost = null;
    for (const t of $('thumbs').children) t.classList.remove('drop-before', 'drop-after', 'dragging');
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    timer = setTimeout(() => {
      active = true;
      thumbDrag.suppressClick = true;
      el.setPointerCapture(start.id);
      el.classList.add('dragging');
      navigator.vibrate?.(15);
    }, e.pointerType === 'mouse' ? 150 : 380);
  });
  el.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    if (!active) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) { clearTimeout(timer); start = null; }
      return;
    }
    e.preventDefault();
    for (const t of $('thumbs').children) t.classList.remove('drop-before', 'drop-after');
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.thumb');
    if (!over) return;
    const r = over.getBoundingClientRect();
    const horizontal = $('thumbs').scrollWidth > $('thumbs').clientWidth + 4 || getComputedStyle($('thumbs')).display === 'grid';
    const after = horizontal ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
    const oi = Number(over.dataset.index);
    target = after ? oi + 1 : oi;
    over.classList.add(after ? 'drop-after' : 'drop-before');
  });
  el.addEventListener('touchstart', (e) => { if (active) e.preventDefault(); }, { passive: false });
  el.addEventListener('touchmove', (e) => { if (active) e.preventDefault(); }, { passive: false });
  const finish = (commitMove) => {
    const was = active;
    active = false;
    start = null;
    clear();
    if (was) {
      setTimeout(() => { thumbDrag.suppressClick = false; }, 50);
      if (commitMove) {
        const to = target > index ? target - 1 : target;
        if (to !== index) movePageTo(index, to);
      }
    }
  };
  el.addEventListener('pointerup', () => finish(true));
  el.addEventListener('pointercancel', () => finish(false));
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

function highlightThumb() {
  for (const el of $('thumbs').children) el.classList.toggle('current', Number(el.dataset.index) === state.current);
  const cur = $('thumbs').children[state.current];
  if (cur && $('pages-panel').classList.contains('open')) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function openPanel(open) {
  const panel = $('pages-panel');
  panel.classList.toggle('open', open);
  $('panel-backdrop').classList.toggle('show', open && !WIDE());
  document.body.classList.toggle('panel-open', open);
  if (open) highlightThumb();
  // The viewer changes width on wide screens.
  if (state.fitMode) requestAnimationFrame(() => fitWidth(false));
}

function renderPanelActions() {
  const box = $('panel-actions');
  box.replaceChildren(
    ...[
      ['rotateLeft', '왼쪽 회전', () => rotatePage(-90)],
      ['rotateRight', '오른쪽 회전', () => rotatePage(90)],
      ['up', '앞으로', () => movePageTo(state.current, state.current - 1)],
      ['down', '뒤로', () => movePageTo(state.current, state.current + 1)],
      ['pageAdd', '빈 페이지', insertBlank],
      ['fileAdd', 'PDF 추가', () => $('file-append').click()],
      ['trash', '삭제', deletePage],
    ].map(([ic, label, fn]) => {
      const b = h('button', { class: 'tool small', onclick: fn, title: label }, icon(ic, { size: 20 }), h('span', {}, label));
      return b;
    }),
  );
}

// ---------------------------------------------------------------------------
// Navigation & zoom
// ---------------------------------------------------------------------------

function scrollToPage(i, smooth = false) {
  const pg = state.pages[i];
  const entry = pg && pageEls.get(pg.id);
  if (!entry) return;
  $('viewer').scrollTo({ top: entry.outer.offsetTop - 8, behavior: smooth ? 'smooth' : 'auto' });
  state.current = i;
  updateCurrentPage(true);
}

function updateCurrentPage(keep = false) {
  const viewer = $('viewer');
  if (!keep) {
    const mid = viewer.getBoundingClientRect().top + viewer.clientHeight / 3;
    let best = Math.min(state.current, state.pages.length - 1);
    for (let i = 0; i < state.pages.length; i++) {
      const r = pageEls.get(state.pages[i].id)?.outer.getBoundingClientRect();
      if (r && r.top <= mid && r.bottom >= mid) { best = i; break; }
    }
    state.current = Math.max(best, 0);
  }
  const pill = $('page-pill');
  pill.hidden = !state.pages.length;
  pill.textContent = `${state.current + 1} / ${state.pages.length}`;
  highlightThumb();
  updateButtons();
}

function setScale(scale, { anchor = null, at = null } = {}) {
  scale = Math.min(Math.max(scale, 0.25), 5);
  if (Math.abs(scale - state.scale) < 1e-4) return;
  closeEditor();
  const viewer = $('viewer');
  const vr = viewer.getBoundingClientRect();
  const focus = at || { x: vr.left + vr.width / 2, y: vr.top + viewer.clientHeight / 3 };
  const a = anchor || anchorAt(focus);
  state.scale = scale;
  rebuild();
  restoreAnchor(a, focus);
  renderToolbar();
}

function zoomStep(dir) {
  state.fitMode = false;
  const s = state.scale;
  const next = dir > 0 ? ZOOM_STEPS.find((z) => z > s + 1e-6) : [...ZOOM_STEPS].reverse().find((z) => z < s - 1e-6);
  if (next) setScale(next);
}

function fitWidth(force) {
  if (!state.pages.length) return;
  const viewer = $('viewer');
  const avail = viewer.clientWidth - (viewer.clientWidth < 600 ? 16 : 48);
  const maxW = Math.max(...state.pages.map((p) => rotatedSize(p)[0]));
  const s = Math.round(Math.min(Math.max(avail / maxW, 0.25), 3) * 1000) / 1000;
  if (force) {
    state.scale = 0;
    setScale(s, { anchor: null, at: null });
    scrollToPage(state.current);
  } else setScale(s);
}

async function gotoPageDialog() {
  if (!state.pages.length) return;
  const n = state.pages.length;
  const v = await promptDialog({
    title: '페이지 이동', label: `이동할 페이지 (1 – ${n})`, value: String(state.current + 1), type: 'number', inputmode: 'numeric', ok: '이동',
    validate: (x) => (Number.isInteger(Number(x)) && Number(x) >= 1 && Number(x) <= n ? null : `1부터 ${n} 사이의 숫자를 입력하세요.`),
  });
  if (v != null) scrollToPage(Number(v) - 1);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const search = { query: '', results: [], index: -1, token: 0 };

function openSearch() {
  if (!state.pages.length) return;
  $('searchbar').hidden = false;
  document.body.classList.add('searching');
  $('search-input').focus();
  $('search-input').select();
}

function closeSearch() {
  $('searchbar').hidden = true;
  document.body.classList.remove('searching');
  clearSearchResults();
  search.query = '';
  $('search-input').value = '';
}

function clearSearchResults() {
  const pagesHit = new Set(search.results.map((r) => r.pageId));
  search.results = [];
  search.index = -1;
  $('search-count').textContent = '';
  for (const id of pagesHit) { const pg = pageById(id); if (pg) renderOverlay(pg); }
}

/** Finds the query in every page, ignoring spaces and letter case. */
async function runSearch(query) {
  const token = ++search.token;
  clearSearchResults();
  search.query = query;
  const q = query.replace(/\s+/g, '').toLowerCase();
  if (!q) return;
  $('search-count').textContent = '찾는 중…';
  const results = [];
  for (const pg of state.pages) {
    const lines = textLines(await getTextItems(pg));
    if (token !== search.token) return;
    const chars = [];
    for (const l of lines) for (const c of l.chars) if (c.c.trim()) chars.push({ ...c, line: l });
    const text = chars.map((c) => c.c.toLowerCase()).join('');
    let from = 0;
    for (;;) {
      const at = text.indexOf(q, from);
      if (at < 0) break;
      const rects = [];
      for (let i = at; i < at + q.length; i++) {
        const c = chars[i];
        const last = rects[rects.length - 1];
        if (last && last.line === c.line) last.x2 = c.x + c.w;
        else rects.push({ line: c.line, x1: c.x, x2: c.x + c.w });
      }
      results.push({ pageId: pg.id, rects: rects.map((r) => ({ x: r.x1, y: r.line.y, w: r.x2 - r.x1, h: r.line.h })) });
      from = at + q.length;
    }
  }
  search.results = results;
  if (!results.length) {
    $('search-count').textContent = '결과 없음';
    return;
  }
  // Start from the first result at or after the current page.
  const curIdx = state.current;
  const order = (r) => state.pages.findIndex((p) => p.id === r.pageId);
  const first = results.findIndex((r) => order(r) >= curIdx);
  for (const id of new Set(results.map((r) => r.pageId))) renderOverlay(pageById(id));
  gotoResult(first >= 0 ? first : 0);
}

function gotoResult(i) {
  const n = search.results.length;
  if (!n) return;
  const prev = search.results[search.index];
  search.index = ((i % n) + n) % n;
  const r = search.results[search.index];
  $('search-count').textContent = `${search.index + 1} / ${n}`;
  if (prev && prev.pageId !== r.pageId) renderOverlay(pageById(prev.pageId));
  const pg = pageById(r.pageId);
  renderOverlay(pg);
  // Scroll the hit into view.
  const entry = pageEls.get(pg.id);
  const viewer = $('viewer');
  const b = unionRects(r.rects);
  const cx = (b.x + b.w / 2) / pg.width, cy = (b.y + b.h / 2) / pg.height;
  const pt = rotatePoint(pg, cx, cy);
  const [rw, rh] = rotatedSize(pg);
  viewer.scrollTo({
    top: entry.outer.offsetTop + pt.y * rh * state.scale - viewer.clientHeight / 2,
    left: entry.outer.offsetLeft + pt.x * rw * state.scale - viewer.clientWidth / 2,
  });
}

/** Relative position (0..1) in the unrotated page -> relative position on screen. */
function rotatePoint(pg, fx, fy) {
  switch (pg.rotation) {
    case 90: return { x: 1 - fy, y: fx };
    case 180: return { x: 1 - fx, y: 1 - fy };
    case 270: return { x: fy, y: 1 - fx };
    default: return { x: fx, y: fy };
  }
}

function drawSearchHits(root, pg) {
  search.results.forEach((r, i) => {
    if (r.pageId !== pg.id) return;
    for (const q of r.rects) {
      svg('rect', { class: `search-hit ${i === search.index ? 'current' : ''}`, x: q.x - 1, y: q.y - 1, width: q.w + 2, height: q.h + 2, rx: 1.5 }, root);
    }
  });
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

let ocrCancelled = false;
async function runOcr(all) {
  if (!state.pages.length) return;
  closeEditor();
  let targets = all ? [...state.pages] : [currentPage()];
  // Pages that already contain text do not need recognition.
  const withText = [];
  for (const pg of targets) {
    if (pg.src == null) continue;
    const items = await getTextItems(pg);
    if (items.some((it) => !it.ocr)) withText.push(pg);
  }
  if (all) {
    targets = targets.filter((p) => p.src != null && !withText.includes(p));
    if (!targets.length) return alertDialog('모든 페이지에 이미 글자 정보가 있어서 문자 인식이 필요하지 않습니다.', '문자 인식');
  } else {
    if (targets[0].src == null) return toast('빈 페이지에는 인식할 글자가 없습니다.');
    if (withText.length && !(await confirmDialog('이 페이지에는 이미 글자 정보가 있습니다. 그래도 문자 인식을 할까요?', { title: '문자 인식', ok: '인식하기' }))) return;
  }
  const ok = await confirmDialog(
    `${targets.length}쪽에서 한국어·영어 글자를 인식합니다.\n처음 한 번은 인식용 데이터(약 6MB)를 내려받으며, 휴대폰에서는 한 쪽에 수십 초가 걸릴 수 있습니다. 인식은 이 기기 안에서만 이루어집니다.`,
    { title: '문자 인식 (OCR)', ok: '시작' },
  );
  if (!ok) return;
  const { recognize, terminate } = await import('./ocr.js');
  ocrCancelled = false;
  const cancelBtn = $('busy-cancel');
  cancelBtn.hidden = false;
  cancelBtn.onclick = () => { ocrCancelled = true; terminate(); };
  let words = 0, done = 0;
  try {
    await withBusy('문자 인식 준비 중…', async () => {
      for (const [i, pg] of targets.entries()) {
        if (ocrCancelled) break;
        const label = `문자 인식 중… ${i + 1}/${targets.length}쪽`;
        setBusyText(label);
        const page = await getPdfPage(pg);
        const scale = Math.min(3, 2600 / Math.max(pg.width, pg.height));
        const viewport = page.getViewport({ scale, rotation: 0 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const g = canvas.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: g, viewport, background: '#ffffff' }).promise;
        const result = await recognize(canvas, scale, (m) => {
          if (m.status === 'recognizing text') setBusyText(`${label} (${Math.round(m.progress * 100)}%)`);
          else if (/load/.test(m.status)) setBusyText('인식 데이터를 불러오는 중…');
        });
        canvas.width = canvas.height = 0;
        if (ocrCancelled) break;
        pg.ocr = { words: result };
        words += result.length;
        done++;
      }
    });
  } catch (err) {
    if (!ocrCancelled) showError('문자 인식에 실패했습니다', err);
  } finally {
    cancelBtn.hidden = true;
  }
  if (done) {
    commit();
    clearSearchResults();
    toast(`${done}쪽에서 단어 ${words}개를 인식했습니다. 검색·글자 수정에 쓸 수 있고, 저장하면 PDF에서도 검색됩니다.`, { duration: 6000 });
  } else if (ocrCancelled) {
    toast('문자 인식을 중지했습니다.');
  }
}

// ---------------------------------------------------------------------------
// Save, download, share
// ---------------------------------------------------------------------------

/** Field id -> info, for mapping PDF.js form values back to field names. */
function getFieldInfo(src) {
  if (!fieldInfoCache.has(src)) {
    fieldInfoCache.set(src, (async () => {
      const doc = state.sources[src].doc;
      const map = new Map();
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        for (const a of await page.getAnnotations()) {
          if (a.subtype === 'Widget' && a.fieldName) map.set(a.id, a);
        }
      }
      return map;
    })());
  }
  return fieldInfoCache.get(src);
}

async function collectFormValues() {
  const doc = state.sources[0]?.doc;
  const all = doc && formValuesOf(doc);
  if (!all) return [];
  const info = await getFieldInfo(0);
  const touchedNames = new Set([...state.formTouched].map((id) => info.get(id)?.fieldName).filter(Boolean));
  const byName = new Map();
  for (const [id, v] of Object.entries(all)) {
    const a = info.get(id);
    if (!a || !touchedNames.has(a.fieldName) || v == null || typeof v !== 'object' || !('value' in v)) continue;
    if (a.fieldType === 'Tx') byName.set(a.fieldName, { name: a.fieldName, kind: 'text', value: v.value });
    else if (a.fieldType === 'Btn' && a.checkBox) byName.set(a.fieldName, { name: a.fieldName, kind: 'checkbox', value: !!v.value });
    else if (a.fieldType === 'Btn' && a.radioButton) {
      if (v.value) byName.set(a.fieldName, { name: a.fieldName, kind: 'radio', value: a.buttonValue });
      else if (!byName.has(a.fieldName)) byName.set(a.fieldName, { name: a.fieldName, kind: 'radio', value: null });
    } else if (a.fieldType === 'Ch') byName.set(a.fieldName, { name: a.fieldName, kind: 'choice', value: v.value });
  }
  return [...byName.values()];
}

async function buildPdf() {
  closeEditor();
  // Focused form inputs commit their value on blur.
  document.activeElement?.blur?.();
  await new Promise((r) => setTimeout(r, 30));
  const { exportPdf } = await import('./save.js');
  const formValues = await collectFormValues();
  const out = await exportPdf({ sources: state.sources, pages: state.pages, images: state.images, formValues });
  const problems = [];
  if (out.missing.length) problems.push(`글꼴에 없는 문자가 있어 저장 파일에서 빠졌습니다: ${out.missing.join(' ')}`);
  if (out.formErrors.length) problems.push(`입력 칸 일부를 저장하지 못했습니다: ${out.formErrors.join(', ')}`);
  return { bytes: out.bytes, problems };
}

const defaultName = () => `${state.fileName.replace(/\.pdf$/i, '')}_편집.pdf`;
const ensurePdfExt = (n) => (/\.pdf$/i.test(n) ? n : `${n}.pdf`);

function markSaved() {
  history.saved = history.index;
  state.formDirty = false;
  updateButtons();
  scheduleAutosave();
}

async function afterSave(name, size, problems) {
  markSaved();
  toast(`저장했습니다: ${name} (${formatSize(size)})`);
  if (problems.length) await alertDialog(problems.join('\n\n'), '확인이 필요합니다');
}

const formatSize = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function downloadBytes(bytes, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

async function downloadPdf(name = defaultName()) {
  if (!state.pages.length) return;
  try {
    const { bytes, problems } = await withBusy('PDF를 만드는 중…', buildPdf);
    downloadBytes(bytes, name);
    await afterSave(name, bytes.length, problems);
  } catch (err) {
    showError('저장하지 못했습니다', err);
  }
}

async function saveAs() {
  if (!state.pages.length) return;
  const name = await promptDialog({
    title: '다른 이름으로 저장', label: '파일 이름', value: defaultName().replace(/\.pdf$/i, ''), ok: '저장',
    help: '원본 파일은 바뀌지 않고, 편집한 내용이 새 파일로 저장됩니다.',
    validate: (v) => (v.trim() ? (/[\\/:*?"<>|]/.test(v) ? '파일 이름에 \\ / : * ? " < > | 는 쓸 수 없습니다.' : null) : '파일 이름을 입력하세요.'),
  });
  if (name == null) return;
  const fileName = ensurePdfExt(name.trim());
  // Chrome/Edge on computers can ask where to save.
  let handle = null;
  if (window.showSaveFilePicker && !IS_IOS) {
    try {
      handle = await window.showSaveFilePicker({ suggestedName: fileName, types: [{ description: 'PDF 문서', accept: { 'application/pdf': ['.pdf'] } }] });
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  if (!handle) return downloadPdf(fileName);
  try {
    const { bytes, problems } = await withBusy('PDF를 저장하는 중…', buildPdf);
    const w = await handle.createWritable();
    await w.write(new Blob([bytes], { type: 'application/pdf' }));
    await w.close();
    await afterSave(handle.name, bytes.length, problems);
  } catch (err) {
    showError('저장하지 못했습니다', err);
  }
}

const canShareFiles = () => {
  try {
    return !!navigator.canShare?.({ files: [new File([new Uint8Array(1)], 'a.pdf', { type: 'application/pdf' })] });
  } catch {
    return false;
  }
};

async function sharePdf() {
  if (!state.pages.length) return;
  let built;
  try {
    built = await withBusy('PDF를 만드는 중…', buildPdf);
  } catch (err) {
    return showError('PDF를 만들지 못했습니다', err);
  }
  const name = defaultName();
  const file = new File([built.bytes], name, { type: 'application/pdf' });
  const share = async () => {
    try {
      await navigator.share({ files: [file], title: name });
      await afterSave(name, built.bytes.length, built.problems);
      return true;
    } catch (err) {
      if (err?.name === 'AbortError') return true; // closed the share sheet
      if (err?.name === 'NotAllowedError') return false; // needs a fresh tap
      throw err;
    }
  };
  try {
    if (await share()) return;
    // Building took too long for the browser to treat it as the same tap.
    await showSheet({
      title: 'PDF 준비 완료',
      content: h('p', { class: 'dialog-text' }, `${name} (${formatSize(built.bytes.length)})\n공유 메뉴에서 프린트, "파일"에 저장, 메시지 보내기를 고를 수 있습니다.`),
      actions: [{ label: '닫기', value: null }, { label: '공유하기', primary: true, onClick: () => { share().catch((err) => showError('공유하지 못했습니다', err)); } }],
    });
  } catch (err) {
    showError('공유하지 못했습니다', err);
  }
}

async function saveMenu() {
  if (!state.pages.length) return;
  const share = canShareFiles();
  const item = (ic, title, sub, value) => h('button', { class: 'menu-item', 'data-value': value }, icon(ic), h('span', { class: 'menu-text' }, h('strong', {}, title), h('span', { class: 'muted small' }, sub)));
  const list = h('div', { class: 'menu-list' },
    share ? item('print', '공유 · 인쇄', '프린트, "파일"에 저장, 카카오톡·메일로 보내기', 'share') : null,
    item('download', '편집한 PDF 다운로드', `${defaultName()}`, 'download'),
    item('saveAs', '다른 이름으로 저장', '파일 이름을 정해서 저장', 'saveas'),
    h('p', { class: 'muted small menu-note' }, '원본 파일은 바뀌지 않습니다. 편집한 내용은 새 PDF 파일로 저장됩니다.'),
  );
  const v = await showSheet({
    title: '저장 · 공유',
    content: list,
    onOpen: ({ close }) => list.addEventListener('click', (e) => { const b = e.target.closest('[data-value]'); if (b) close(b.dataset.value); }),
  });
  if (v === 'share') sharePdf();
  else if (v === 'download') downloadPdf();
  else if (v === 'saveas') saveAs();
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function setPencilOnly(on) {
  state.pencilOnly = on;
  writePref('pencilOnly', on);
}

async function openMenu() {
  const has = state.pages.length > 0;
  const item = (ic, title, value, { sub, disabled, toggle } = {}) => h('button', { class: 'menu-item', 'data-value': value, disabled: disabled || null },
    icon(ic), h('span', { class: 'menu-text' }, h('strong', {}, title), sub ? h('span', { class: 'muted small' }, sub) : null),
    toggle != null ? h('span', { class: `switch ${toggle ? 'on' : ''}`, 'aria-hidden': 'true' }) : null);
  const list = h('div', { class: 'menu-list' },
    item('open', 'PDF 열기', 'open'),
    item('fileAdd', '다른 PDF의 페이지 추가', 'append', { disabled: !has }),
    item('share', '저장 · 공유', 'save', { disabled: !has }),
    item('ocr', '문자 인식 (OCR) – 이 페이지', 'ocr', { disabled: !has, sub: '스캔·사진 PDF의 글자를 검색 가능하게' }),
    item('ocr', '문자 인식 (OCR) – 모든 페이지', 'ocr-all', { disabled: !has }),
    item('library', '서명·도장 보관함', 'library'),
    item('pen', '펜슬로만 그리기', 'pencil', { sub: '켜면 손가락은 화면 이동, Apple Pencil은 그리기', toggle: state.pencilOnly }),
    item('closeDoc', '문서 닫기', 'close', { disabled: !has, sub: '이 기기에 보관된 작업도 지웁니다' }),
    item('info', '이 앱에 대하여', 'about'),
  );
  const v = await showSheet({
    title: '메뉴',
    content: list,
    onOpen: ({ close }) => list.addEventListener('click', (e) => { const b = e.target.closest('[data-value]'); if (b && !b.disabled) close(b.dataset.value); }),
  });
  switch (v) {
    case 'open': $('file-open').click(); break;
    case 'append': $('file-append').click(); break;
    case 'save': saveMenu(); break;
    case 'ocr': runOcr(false); break;
    case 'ocr-all': runOcr(true); break;
    case 'library': manageLibrary(); break;
    case 'pencil': setPencilOnly(!state.pencilOnly); toast(state.pencilOnly ? '펜슬로만 그리기: 켬 (손가락은 화면 이동)' : '펜슬로만 그리기: 끔 (손가락으로도 그리기)'); break;
    case 'close': closeDocument(); break;
    case 'about': showAbout(); break;
  }
}

function showAbout() {
  showSheet({
    title: '이 앱에 대하여',
    content: h('div', { class: 'about' },
      h('p', {}, 'PDF를 열어 글자 입력·수정, 서명과 도장, 형광펜·밑줄·메모, 페이지 정리를 하고 새 PDF로 저장합니다.'),
      h('h3', {}, '개인정보'),
      h('p', {}, '파일은 이 기기의 브라우저 안에서만 처리되며 서버로 전송되지 않습니다. 자동 저장된 작업과 서명·도장 보관함도 이 기기에만 저장됩니다. 비밀번호로 열었던 문서는 자동 저장하지 않습니다.'),
      h('h3', {}, '알아 둘 점'),
      h('ul', {},
        h('li', {}, '글자 수정과 지우개는 원래 내용을 덮어 가리는 방식입니다. 가려진 글자는 파일 안에 남아 있어 복사·검색될 수 있으니, 완전히 지워야 하는 개인정보에는 쓰지 마세요.'),
        h('li', {}, '텍스트·도형·서명·도장은 페이지 내용으로 저장되고, 형광펜·밑줄·메모는 다른 PDF 앱에서도 지우고 고칠 수 있는 표준 주석으로 저장됩니다.'),
        h('li', {}, '저장 파일은 PDF 1.7 형식입니다. 원래 파일의 입력 칸·책갈피·문서 정보는 유지되며, 삭제한 페이지의 내용은 파일에서 제거됩니다.'),
        h('li', {}, '다른 PDF에서 추가한 페이지의 입력 칸은 입력할 수 없습니다(보이기만 합니다).'),
        h('li', {}, '전자서명(인증서)이 들어 있던 PDF는 편집하면 그 인증이 더 이상 유효하지 않습니다.'),
        h('li', {}, '비밀번호로 열었던 PDF를 저장하면 비밀번호가 없는 파일이 됩니다.'),
      ),
      h('p', { class: 'muted small' }, 'PDF.js · pdf-lib · qpdf · Tesseract.js · 나눔고딕/나눔명조(SIL OFL)를 사용합니다.'),
    ),
    actions: [{ label: '닫기', primary: true }],
  });
}

// ---------------------------------------------------------------------------
// Toolbar, tabs, options bar
// ---------------------------------------------------------------------------

const TOOL_ITEMS = {
  select: { icon: 'select', label: '선택' },
  text: { icon: 'text', label: '텍스트' },
  edittext: { icon: 'edittext', label: '글자 수정' },
  ink: { icon: 'ink', label: '펜' },
  rect: { icon: 'rect', label: '사각형' },
  ellipse: { icon: 'ellipse', label: '원' },
  line: { icon: 'line', label: '선' },
  whiteout: { icon: 'whiteout', label: '지우개' },
  highlight: { icon: 'highlight', label: '형광펜' },
  underline: { icon: 'underline', label: '밑줄' },
  note: { icon: 'note', label: '메모' },
};

function toolButton(tool) {
  const t = TOOL_ITEMS[tool];
  return h('button', {
    class: `tool ${state.tool === tool ? 'active' : ''}`, 'data-tool': tool, 'aria-pressed': String(state.tool === tool),
    onclick: () => setTool(state.tool === tool && tool !== 'select' ? 'select' : tool),
  }, icon(t.icon), h('span', {}, t.label));
}

function actionButton(ic, label, fn, { disabled = false, cls = '' } = {}) {
  return h('button', { class: `tool ${cls}`, onclick: fn, disabled: disabled || null }, icon(ic), h('span', {}, label));
}

function renderToolbar() {
  const bar = $('toolbar');
  const has = state.pages.length > 0;
  const items = [];
  switch (state.tab) {
    case 'view':
      items.push(
        toolButton('select'),
        actionButton('zoomOut', '축소', () => zoomStep(-1), { disabled: !has }),
        h('button', { class: 'tool zoom-label', onclick: () => { state.fitMode = false; setScale(1); }, disabled: !has || null }, h('strong', {}, `${Math.round(state.scale * 100)}%`), h('span', {}, '원래 크기')),
        actionButton('zoomIn', '확대', () => zoomStep(1), { disabled: !has }),
        actionButton('fit', '폭 맞춤', () => { state.fitMode = true; fitWidth(false); }, { disabled: !has }),
        actionButton('goto', '페이지 이동', gotoPageDialog, { disabled: !has }),
        actionButton('pages', '페이지 목록', () => openPanel(!$('pages-panel').classList.contains('open')), { disabled: !has }),
      );
      break;
    case 'edit':
      items.push(
        toolButton('text'), toolButton('edittext'),
        actionButton('image', '이미지', () => $('file-image').click(), { disabled: !has }),
        toolButton('ink'), toolButton('rect'), toolButton('ellipse'), toolButton('line'), toolButton('whiteout'),
      );
      break;
    case 'sign':
      items.push(
        actionButton('sign', '서명 그리기', async () => useSignatureResult(await drawSignature(), 'signature'), { disabled: !has }),
        actionButton('stamp', '도장 만들기', async () => useSignatureResult(await makeStamp(), 'stamp'), { disabled: !has }),
        actionButton('photo', '사진으로', () => photoStampMenu(), { disabled: !has }),
      );
      if (library.length) items.push(h('div', { class: 'tool-sep', 'aria-hidden': 'true' }));
      for (const item of library) {
        const url = item.url ||= URL.createObjectURL(item.blob);
        items.push(h('button', { class: 'tool lib-item', onclick: () => placeLibraryItem(item), disabled: !has || null, 'aria-label': `보관한 ${item.kind === 'stamp' ? '도장' : '서명'} 넣기` },
          h('span', { class: 'lib-img checker' }, h('img', { src: url, alt: '' })), h('span', {}, item.kind === 'stamp' ? '도장' : '서명')));
      }
      items.push(actionButton('library', '보관함 관리', manageLibrary));
      break;
    case 'comment':
      items.push(toolButton('highlight'), toolButton('underline'), toolButton('note'));
      break;
    case 'page':
      items.push(
        actionButton('pages', '페이지 목록', () => openPanel(!$('pages-panel').classList.contains('open')), { disabled: !has }),
        actionButton('rotateLeft', '왼쪽 회전', () => rotatePage(-90), { disabled: !has }),
        actionButton('rotateRight', '오른쪽 회전', () => rotatePage(90), { disabled: !has }),
        actionButton('pageAdd', '빈 페이지', insertBlank, { disabled: !has }),
        actionButton('fileAdd', 'PDF 추가', () => $('file-append').click(), { disabled: !has }),
        actionButton('trash', '페이지 삭제', deletePage, { disabled: state.pages.length <= 1 }),
        actionButton('ocr', '문자 인식', () => runOcr(false), { disabled: !has }),
      );
      break;
  }
  bar.replaceChildren(...items);
  for (const b of $('tabbar').children) b.classList.toggle('active', b.dataset.tab === state.tab);
}

async function photoStampMenu() {
  const v = await showSheet({
    title: '사진으로 만들기',
    content: h('p', { class: 'dialog-text' }, '종이에 찍은 도장이나 서명을 사진으로 찍거나 앨범에서 고르면, 흰 배경을 지워 투명하게 만듭니다.'),
    actions: [{ label: '서명 사진', value: 'signature' }, { label: '도장 사진', value: 'stamp', primary: true }],
  });
  if (!v) return;
  const input = $('file-photo');
  input.dataset.kind = v;
  input.click();
}

const TAB_TOOLS = {
  edit: ['text', 'edittext', 'ink', 'rect', 'ellipse', 'line', 'whiteout'],
  comment: ['highlight', 'underline', 'note'],
};

function setTab(tab) {
  state.tab = tab;
  // Keep the tool only if it belongs to the new tab.
  if (state.tool !== 'select' && !TAB_TOOLS[tab]?.includes(state.tool)) setTool('select');
  else renderToolbar();
  renderOptbar();
}

function setTool(tool) {
  closeEditor();
  cancelDrag();
  state.tool = tool;
  $('viewer').dataset.tool = tool;
  $('viewer').dataset.toolKind = DRAG_TOOLS.has(tool) ? 'drag' : TAP_TOOLS.has(tool) ? 'tap' : 'select';
  if (tool !== 'select') select(null, null);
  renderToolbar();
  renderOptbar();
  if (state.pages.length && TOOL_HINTS[tool]) toast(TOOL_HINTS[tool], { duration: 2600 });
}

const PALETTE = ['#111111', '#ffffff', '#e11d48', '#f97316', '#facc15', '#16a34a', '#1d3fbf', '#7c3aed'];
const MARK_PALETTE = ['#facc15', '#4ade80', '#60a5fa', '#f472b6', '#fb923c', '#e11d48'];
const NOTE_PALETTE = ['#facc15', '#fdba74', '#86efac', '#93c5fd', '#f9a8d4'];
const KIND_LABEL = {
  text: '텍스트', ink: '펜', line: '선', rect: '사각형', ellipse: '원', highlight: '형광펜', underline: '밑줄', whiteout: '지우개',
  image: '이미지', signature: '서명', stamp: '도장', note: '메모', edittext: '글자 수정',
};
const PROP_FIELDS = {
  text: ['color', 'size', 'bold'],
  ink: ['stroke', 'width', 'opacity'],
  line: ['stroke', 'width', 'opacity'],
  rect: ['stroke', 'fill', 'width'],
  ellipse: ['stroke', 'fill', 'width'],
  whiteout: ['fill'],
  highlight: ['mark'],
  underline: ['mark'],
  note: ['notecolor'],
  image: ['opacity'],
  signature: ['opacity'],
  stamp: ['opacity'],
};

/** The object the options bar edits: the selection, or the tool defaults. */
function propTarget() {
  const found = findAnn(state.selected);
  if (found) return { kind: found.ann.kind, obj: found.ann, pg: found.pg };
  const kind = state.tool === 'edittext' ? 'text' : state.tool;
  if (toolDefaults[kind] && PROP_FIELDS[kind]) return { kind, obj: toolDefaults[kind], pg: null };
  return null;
}

function renderOptbar() {
  const bar = $('optbar');
  const t = propTarget();
  if (!t || !state.pages.length) {
    bar.hidden = true;
    bar.replaceChildren();
    document.body.classList.remove('has-optbar');
    return;
  }
  const o = t.obj;
  const fields = PROP_FIELDS[t.kind] || [];
  const parts = [h('span', { class: 'opt-label' }, t.pg ? KIND_LABEL[t.kind] || '선택' : `${KIND_LABEL[t.kind]} 설정`)];
  const colorRow = (key, palette, { allowNone = false, noneLabel = '없음' } = {}) => {
    const row = h('div', { class: 'opt-colors', role: 'radiogroup' });
    if (allowNone) {
      row.append(h('button', { class: `swatch none ${!o[key] ? 'active' : ''}`, 'aria-label': noneLabel, title: noneLabel, onclick: () => applyProp(key, null, true) }));
    }
    for (const c of palette) {
      row.append(h('button', { class: `swatch ${o[key]?.toLowerCase() === c ? 'active' : ''}`, style: { '--c': c }, 'aria-label': c, onclick: () => applyProp(key, c, true) }));
    }
    const custom = h('input', { type: 'color', class: 'swatch-custom', value: o[key] || palette[0], 'aria-label': '다른 색', title: '다른 색' });
    custom.addEventListener('input', () => applyProp(key, custom.value, false));
    custom.addEventListener('change', () => applyProp(key, custom.value, true));
    row.append(custom);
    return row;
  };
  for (const f of fields) {
    if (f === 'color') parts.push(colorRow('color', PALETTE));
    if (f === 'stroke') parts.push(h('span', { class: 'opt-sub' }, '선'), colorRow('stroke', PALETTE, { allowNone: t.kind === 'rect' || t.kind === 'ellipse' }));
    if (f === 'fill') parts.push(h('span', { class: 'opt-sub' }, '채우기'), colorRow('fill', t.kind === 'whiteout' ? ['#ffffff', '#f4f4f5', '#000000'] : PALETTE, { allowNone: t.kind !== 'whiteout' }));
    if (f === 'mark') parts.push(colorRow('color', MARK_PALETTE));
    if (f === 'notecolor') parts.push(colorRow('color', NOTE_PALETTE));
    if (f === 'size') {
      parts.push(h('div', { class: 'stepper' },
        h('button', { 'aria-label': '글자 작게', onclick: () => applyProp('size', Math.max(4, Math.round((o.size - 1) * 2) / 2), true) }, '−'),
        h('span', { class: 'stepper-val' }, `${o.size}pt`),
        h('button', { 'aria-label': '글자 크게', onclick: () => applyProp('size', Math.min(200, Math.round((o.size + 1) * 2) / 2), true) }, '+')));
    }
    if (f === 'bold') parts.push(h('button', { class: `chip ${o.bold ? 'active' : ''}`, 'aria-pressed': String(!!o.bold), onclick: () => applyProp('bold', !o.bold, true) }, h('b', {}, '굵게')));
    if (f === 'width') {
      const r = h('input', { type: 'range', min: 0.5, max: 16, step: 0.5, value: o.width || 2, 'aria-label': '선 굵기' });
      r.addEventListener('input', () => applyProp('width', Number(r.value), false));
      r.addEventListener('change', () => applyProp('width', Number(r.value), true));
      parts.push(h('label', { class: 'opt-range' }, h('span', {}, '굵기'), r));
    }
    if (f === 'opacity') {
      const r = h('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value: o.opacity ?? 1, 'aria-label': '불투명도' });
      r.addEventListener('input', () => applyProp('opacity', Number(r.value), false));
      r.addEventListener('change', () => applyProp('opacity', Number(r.value), true));
      parts.push(h('label', { class: 'opt-range' }, h('span', {}, '진하기'), r));
    }
  }
  if (t.pg) {
    parts.push(h('div', { class: 'opt-spacer' }));
    if (t.obj.type === 'text') parts.push(h('button', { class: 'chip', onclick: () => openEditor(t.pg, t.obj, { isNew: false }) }, icon('edit', { size: 18 }), '수정'));
    if (t.obj.type === 'note') parts.push(h('button', { class: 'chip', onclick: () => editNote(t.pg, t.obj) }, icon('note', { size: 18 }), '열기'));
    parts.push(
      h('button', { class: 'chip', onclick: duplicateSelected, 'aria-label': '복제' }, icon('copy', { size: 18 }), '복제'),
      h('button', { class: 'chip', onclick: bringToFront, 'aria-label': '맨 앞으로' }, icon('front', { size: 18 }), '맨 앞'),
      h('button', { class: 'chip danger', onclick: deleteSelected, 'aria-label': '삭제' }, icon('trash', { size: 18 }), '삭제'),
    );
  }
  bar.replaceChildren(...parts);
  bar.hidden = false;
  document.body.classList.add('has-optbar');
}

function applyProp(field, value, final) {
  const t = propTarget();
  if (!t) return;
  const targets = [t.obj];
  if (t.pg && toolDefaults[t.kind]) targets.push(toolDefaults[t.kind]); // remember as the new default
  for (const o of targets) {
    o[field] = value;
    if (field === 'stroke' && value && !o.width) o.width = 2;
  }
  if ((t.kind === 'rect' || t.kind === 'ellipse') && !t.obj.stroke && !t.obj.fill) {
    // Never leave a shape with neither stroke nor fill (it would be invisible).
    t.obj.stroke = '#e11d48';
    t.obj.width ||= 2;
  }
  if (t.pg) {
    renderOverlay(t.pg);
    if (editor && editor.ann === t.obj) editor.fit();
    if (final && !editor) commit();
  }
  if (final) renderOptbar();
}

function updateButtons() {
  const has = state.pages.length > 0;
  $('btn-share').disabled = !has;
  $('btn-search').disabled = !has;
  $('btn-undo').disabled = history.index <= 0;
  $('btn-redo').disabled = history.index < 0 || history.index >= history.stack.length - 1;
  $('doc-title').classList.toggle('dirty', has && isDirty());
}

function showError(title, err) {
  console.error(err);
  const msg = String(err?.message || err || '');
  let text = msg;
  if (/Invalid PDF|InvalidPDF|not a PDF|PDF header/i.test(msg)) text = 'PDF 파일이 아니거나 손상된 파일입니다.';
  else if (/encrypt/i.test(msg)) text = '암호화된 PDF라서 처리하지 못했습니다.';
  alertDialog(`${title}.\n${text}`, '오류');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wire() {
  for (const el of document.querySelectorAll('[data-icon]')) el.prepend(icon(el.dataset.icon, { size: Number(el.dataset.iconSize) || 22 }));
  $('btn-open-2').onclick = () => $('file-open').click();
  $('btn-menu').onclick = openMenu;
  $('btn-share').onclick = saveMenu;
  $('btn-undo').onclick = () => restore(-1);
  $('btn-redo').onclick = () => restore(1);
  $('btn-search').onclick = () => ($('searchbar').hidden ? openSearch() : closeSearch());
  $('page-pill').onclick = gotoPageDialog;
  $('panel-close').onclick = () => openPanel(false);
  $('panel-backdrop').onclick = () => openPanel(false);
  $('file-open').onchange = (e) => { openFile(e.target.files[0]); e.target.value = ''; };
  $('file-append').onchange = (e) => { appendFile(e.target.files[0]); e.target.value = ''; };
  $('file-image').onchange = (e) => { insertImage(e.target.files[0]); e.target.value = ''; };
  $('file-photo').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const kind = e.target.dataset.kind || 'stamp';
    try {
      useSignatureResult(await stampFromPhoto(file, kind), kind);
    } catch (err) {
      showError('사진을 처리하지 못했습니다', err);
    }
  };
  for (const b of $('tabbar').children) b.onclick = () => setTab(b.dataset.tab);

  let searchTimer = null;
  $('search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(e.target.value), 250);
  });
  $('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (search.query !== e.target.value) runSearch(e.target.value);
      else gotoResult(search.index + (e.shiftKey ? -1 : 1));
      e.target.blur(); // hide the keyboard so the result is visible
    } else if (e.key === 'Escape') closeSearch();
  });
  $('search-prev').onclick = () => gotoResult(search.index - 1);
  $('search-next').onclick = () => gotoResult(search.index + 1);
  $('search-close').onclick = closeSearch;

  const viewer = $('viewer');
  let scrollRaf = 0;
  viewer.addEventListener('scroll', () => {
    cancelAnimationFrame(scrollRaf);
    scrollRaf = requestAnimationFrame(() => updateCurrentPage());
  }, { passive: true });
  viewer.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    state.fitMode = false;
    setScale(state.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { at: { x: e.clientX, y: e.clientY } });
  }, { passive: false });

  const app = $('app');
  app.addEventListener('dragover', (e) => { e.preventDefault(); app.classList.add('dragover'); });
  app.addEventListener('dragleave', (e) => { if (e.target === app || !app.contains(e.relatedTarget)) app.classList.remove('dragover'); });
  app.addEventListener('drop', async (e) => {
    e.preventDefault();
    app.classList.remove('dragover');
    const files = [...e.dataTransfer.files];
    const file = files.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const img = files.find((f) => f.type.startsWith('image/'));
    if (file) {
      if (state.pages.length) {
        const v = await showSheet({
          title: 'PDF 놓기', content: h('p', { class: 'dialog-text' }, `${file.name}`),
          actions: [{ label: '새 문서로 열기', value: 'open' }, { label: '현재 문서에 페이지 추가', value: 'append', primary: true }],
        });
        if (v === 'append') appendFile(file);
        else if (v === 'open') openFile(file);
      } else openFile(file);
    } else if (img) insertImage(img);
  });

  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (Math.abs(window.innerWidth - lastWidth) > 30 && state.fitMode) fitWidth(false);
    lastWidth = window.innerWidth;
    if (!WIDE()) $('panel-backdrop').classList.toggle('show', $('pages-panel').classList.contains('open'));
    else $('panel-backdrop').classList.remove('show');
    updateCurrentPage();
  });
  window.addEventListener('beforeunload', (e) => {
    // Unsaved work is kept on this device, except for password-protected files.
    if (isDirty() && state.sensitive) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('pagehide', () => scheduleAutosave(0));

  document.addEventListener('keydown', (e) => {
    if (isSheetOpen()) return;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 's') { e.preventDefault(); if (e.shiftKey) saveAs(); else saveMenu(); return; }
    if (mod && k === 'o') { e.preventDefault(); $('file-open').click(); return; }
    if (mod && k === 'f') { e.preventDefault(); openSearch(); return; }
    if (inField) return;
    if (mod && k === 'z') { e.preventDefault(); restore(e.shiftKey ? 1 : -1); return; }
    if (mod && k === 'y') { e.preventDefault(); restore(1); return; }
    if (mod && k === 'd') { e.preventDefault(); duplicateSelected(); return; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoomStep(1); return; }
    if (mod && k === '-') { e.preventDefault(); zoomStep(-1); return; }
    if (mod) return;
    if (k === 'delete' || k === 'backspace') { if (state.selected) { e.preventDefault(); deleteSelected(); } return; }
    if (k === 'escape') { if (state.selected) select(null, null); else setTool('select'); return; }
    const step = e.shiftKey ? 10 : 1;
    const arrows = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] };
    if (arrows[k] && state.selected) { e.preventDefault(); nudge(...arrows[k]); }
  });

  setupGestures();
}

wire();
renderPanelActions();
setTab('view');
updateButtons();
loadEditorFonts().catch((err) => console.warn('Editor font failed to load', err));
loadLibrary();
showRestoreCard();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('service worker', err));
}

if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
  window.__pdfEditor = { state, history, openFile, buildPdf, collectFormValues, runSearch, search, setScale, setTool };
}
