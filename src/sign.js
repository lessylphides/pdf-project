// Signature pad, seal (도장) maker and photo-to-stamp conversion.
// Each produces a transparent PNG that is placed on the page as an image and
// drawn into the page content when the PDF is saved.
import myeongjoUrl from '@expo-google-fonts/nanum-myeongjo/800ExtraBold/NanumMyeongjo_800ExtraBold.ttf?url';
import { FONT_FAMILY } from './text.js';
import { h, showSheet } from './ui.js';

const INK_COLORS = [
  { value: '#111111', label: '검정' },
  { value: '#1d3fbf', label: '파랑' },
  { value: '#c81e1e', label: '빨강' },
];
const SEAL_RED = '#d0161b';

const canvasToBlob = (c) => new Promise((r) => c.toBlob(r, 'image/png'));

function swatches(colors, initial, onChange) {
  let current = initial;
  const row = h('div', { class: 'swatches', role: 'radiogroup' });
  for (const c of colors) {
    const b = h('button', {
      class: `swatch ${c.value === current ? 'active' : ''}`, type: 'button', role: 'radio',
      'aria-checked': String(c.value === current), 'aria-label': c.label, title: c.label, style: { '--c': c.value },
      onclick: () => {
        current = c.value;
        for (const x of row.children) { x.classList.toggle('active', x === b); x.setAttribute('aria-checked', String(x === b)); }
        onChange(c.value);
      },
    });
    row.append(b);
  }
  return row;
}

function segmented(options, initial, onChange) {
  const row = h('div', { class: 'segmented', role: 'radiogroup' });
  for (const o of options) {
    const b = h('button', {
      type: 'button', role: 'radio', class: o.value === initial ? 'active' : '', 'aria-checked': String(o.value === initial),
      onclick: () => {
        for (const x of row.children) { x.classList.toggle('active', x === b); x.setAttribute('aria-checked', String(x === b)); }
        onChange(o.value);
      },
    }, o.label);
    row.append(b);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Signature pad
// ---------------------------------------------------------------------------

/**
 * Lets the user draw a signature with a finger, mouse or Apple Pencil
 * (pressure-sensitive). Resolves with { blob, width, height, keep } or null.
 */
export async function drawSignature() {
  const strokes = []; // { color, size, points: [{x, y, w}] }
  let color = INK_COLORS[0].value;
  let size = 3;
  const canvas = h('canvas', { class: 'sign-canvas', 'aria-label': '서명 입력 영역' });
  const hint = h('div', { class: 'sign-hint' }, '여기에 서명하세요');
  const pad = h('div', { class: 'sign-pad' }, canvas, hint, h('div', { class: 'sign-baseline' }));
  const keep = h('input', { type: 'checkbox', checked: true });
  const undoBtn = h('button', { class: 'btn small', type: 'button', onclick: () => { strokes.pop(); redraw(); } }, '↶ 한 획 지우기');
  const clearBtn = h('button', { class: 'btn small', type: 'button', onclick: () => { strokes.length = 0; redraw(); } }, '모두 지우기');
  const sizeInput = h('input', { type: 'range', min: 1.5, max: 7, step: 0.5, value: size, 'aria-label': '굵기', oninput: (e) => { size = Number(e.target.value); } });
  const content = h('div', { class: 'sign-sheet' },
    pad,
    h('div', { class: 'sign-tools' },
      swatches(INK_COLORS, color, (c) => { color = c; }),
      h('label', { class: 'inline' }, '굵기', sizeInput),
    ),
    h('div', { class: 'sign-tools' }, undoBtn, clearBtn,
      h('label', { class: 'inline check' }, keep, '보관함에 저장')),
  );

  let dpr = 1;
  const ctx = canvas.getContext('2d');
  const resize = () => {
    const r = pad.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    redraw();
  };
  function strokeWidth(e, last, base) {
    if (e.pointerType === 'pen' && e.pressure > 0) return base * (0.35 + e.pressure * 1.2);
    if (!last) return base;
    // Fingers and mice have no pressure: thin out fast strokes like a pen.
    const dt = Math.max(e.timeStamp - last.t, 1);
    const v = Math.hypot(e.offsetX - last.x, e.offsetY - last.y) / dt; // px per ms
    const target = base * Math.min(Math.max(1.5 - v * 0.6, 0.45), 1.5);
    return last.w + (target - last.w) * 0.35;
  }
  function paint(c, s, scale) {
    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const pts = s.points;
    if (pts.length === 1) {
      c.beginPath();
      c.arc(pts[0].x * scale, pts[0].y * scale, (pts[0].w / 2) * scale, 0, Math.PI * 2);
      c.fill();
      return;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const p0 = i > 1 ? pts[i - 2] : a;
      c.beginPath();
      c.lineWidth = ((a.w + b.w) / 2) * scale;
      c.moveTo(((p0.x + a.x) / 2) * scale, ((p0.y + a.y) / 2) * scale);
      c.quadraticCurveTo(a.x * scale, a.y * scale, ((a.x + b.x) / 2) * scale, ((a.y + b.y) / 2) * scale);
      c.stroke();
    }
    const last = pts[pts.length - 1], prev = pts[pts.length - 2];
    c.beginPath();
    c.lineWidth = last.w * scale;
    c.moveTo(((prev.x + last.x) / 2) * scale, ((prev.y + last.y) / 2) * scale);
    c.lineTo(last.x * scale, last.y * scale);
    c.stroke();
  }
  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokes) paint(ctx, s, dpr);
    hint.hidden = strokes.length > 0;
    undoBtn.disabled = clearBtn.disabled = strokes.length === 0;
  }

  let active = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (active) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const w = strokeWidth(e, null, size);
    active = { id: e.pointerId, stroke: { color, size, points: [{ x: e.offsetX, y: e.offsetY, w, t: e.timeStamp }] } };
    strokes.push(active.stroke);
    redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== active.id) return;
    e.preventDefault();
    const pts = active.stroke.points;
    for (const ce of e.getCoalescedEvents?.() ?? [e]) {
      const last = pts[pts.length - 1];
      if (Math.hypot(ce.offsetX - last.x, ce.offsetY - last.y) < 0.8) continue;
      pts.push({ x: ce.offsetX, y: ce.offsetY, w: strokeWidth(ce, last, active.stroke.size), t: ce.timeStamp });
    }
    redraw();
  });
  const end = (e) => { if (active && e.pointerId === active.id) active = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

  let result = null;
  const ok = await showSheet({
    title: '서명 그리기',
    content,
    className: 'wide',
    actions: [
      { label: '취소', value: null },
      {
        label: '서명 넣기', primary: true, value: 'ok',
        onClick: async () => {
          if (!strokes.length) return false;
          result = await exportStrokes(strokes, paint);
          return true;
        },
      },
    ],
    onOpen: () => requestAnimationFrame(resize),
  });
  if (ok !== 'ok' || !result) return null;
  return { ...result, keep: keep.checked };
}

async function exportStrokes(strokes, paint) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) for (const p of s.points) {
    minX = Math.min(minX, p.x - p.w); minY = Math.min(minY, p.y - p.w);
    maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.w);
  }
  const pad = 4, scale = 4; // 4x the on-screen size keeps print quality
  const w = maxX - minX + pad * 2, h0 = maxY - minY + pad * 2;
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * scale);
  c.height = Math.ceil(h0 * scale);
  const g = c.getContext('2d');
  g.translate((pad - minX) * scale, (pad - minY) * scale);
  for (const s of strokes) paint(g, s, scale);
  return { blob: await canvasToBlob(c), width: w, height: h0 };
}

// ---------------------------------------------------------------------------
// Seal maker
// ---------------------------------------------------------------------------

let myeongjoLoaded = null;
function loadMyeongjo() {
  myeongjoLoaded ||= new FontFace('SealSerif', `url(${myeongjoUrl})`).load().then((f) => { document.fonts.add(f); });
  return myeongjoLoaded;
}

/** Character positions (in a unit box) for a seal with n characters, read right column first. */
function sealLayout(n) {
  if (n <= 1) return [{ x: 0.5, y: 0.5, w: 1, h: 1 }];
  if (n <= 3) return Array.from({ length: n }, (_, i) => ({ x: 0.5, y: (i + 0.5) / n, w: 1, h: 1 / n }));
  const cols = n <= 6 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const out = [];
  for (let i = 0; i < n; i++) {
    const col = Math.floor(i / rows), row = i % rows;
    out.push({ x: 1 - (col + 0.5) / cols, y: (row + 0.5) / rows, w: 1 / cols, h: 1 / rows });
  }
  return out;
}

function drawSeal(c, { text, shape, font }) {
  const S = c.width;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.strokeStyle = g.fillStyle = SEAL_RED;
  const ring = S * 0.05;
  const m = ring / 2 + S * 0.01;
  g.lineWidth = ring;
  g.beginPath();
  if (shape === 'circle') g.arc(S / 2, S / 2, S / 2 - m, 0, Math.PI * 2);
  else g.roundRect(m, m, S - m * 2, S - m * 2, S * 0.04);
  g.stroke();
  const chars = [...text];
  if (!chars.length) return;
  // Inner area for the characters (a circle's inscribed square is smaller).
  const inset = shape === 'circle' ? S * 0.2 : S * 0.13;
  const area = S - inset * 2;
  const family = font === 'serif' ? 'SealSerif' : FONT_FAMILY;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const [i, p] of sealLayout(chars.length).entries()) {
    const cw = p.w * area, ch = p.h * area;
    const size = Math.min(cw, ch) * 1.02;
    g.save();
    g.translate(inset + p.x * area, inset + p.y * area);
    // Stretch glyphs to fill tall/wide cells the way carved seals do.
    g.scale(cw / Math.min(cw, ch), ch / Math.min(cw, ch));
    g.font = `${font === 'serif' ? 800 : 700} ${size}px ${family}`;
    g.fillText(chars[i], 0, size * 0.04);
    g.restore();
  }
}

/** Resolves with { blob, width, height, keep } or null. */
export async function makeStamp() {
  const opts = { name: '', suffix: true, shape: 'circle', font: 'sans' };
  const preview = h('canvas', { class: 'stamp-preview', width: 480, height: 480, 'aria-label': '도장 미리보기' });
  const nameInput = h('input', { class: 'field', type: 'text', maxlength: 8, placeholder: '예: 홍길동', autocomplete: 'off' });
  const suffix = h('input', { type: 'checkbox', checked: true });
  const keep = h('input', { type: 'checkbox', checked: true });
  const fontNote = h('span', { class: 'muted small' });
  const render = async () => {
    const text = opts.name.trim().replace(/\s+/g, '') + (opts.suffix && opts.name.trim() ? '인' : '');
    if (opts.font === 'serif') {
      fontNote.textContent = '명조체를 불러오는 중…';
      try { await loadMyeongjo(); fontNote.textContent = ''; } catch { fontNote.textContent = '명조체를 불러오지 못했습니다.'; }
    }
    drawSeal(preview, { text, shape: opts.shape, font: opts.font });
  };
  nameInput.addEventListener('input', () => { opts.name = nameInput.value; render(); });
  suffix.addEventListener('change', () => { opts.suffix = suffix.checked; render(); });
  const content = h('div', { class: 'stamp-sheet' },
    h('div', { class: 'stamp-preview-wrap' }, preview),
    h('div', { class: 'stamp-form' },
      h('label', { class: 'field-label' }, '도장에 새길 이름'), nameInput,
      h('label', { class: 'inline check' }, suffix, '끝에 "인" 붙이기'),
      h('div', { class: 'field-label' }, '모양'),
      segmented([{ value: 'circle', label: '원형' }, { value: 'square', label: '사각' }], opts.shape, (v) => { opts.shape = v; render(); }),
      h('div', { class: 'field-label' }, '글씨체'),
      segmented([{ value: 'sans', label: '고딕' }, { value: 'serif', label: '명조' }], opts.font, (v) => { opts.font = v; render(); }),
      fontNote,
      h('label', { class: 'inline check' }, keep, '보관함에 저장'),
    ),
  );
  let result = null;
  const v = await showSheet({
    title: '도장 만들기',
    content,
    className: 'wide',
    onOpen: () => { render(); setTimeout(() => nameInput.focus(), 60); },
    actions: [
      { label: '취소', value: null },
      {
        label: '도장 넣기', primary: true, value: 'ok',
        onClick: async () => {
          if (!opts.name.trim()) { nameInput.focus(); return false; }
          await render();
          result = { blob: await canvasToBlob(preview), width: 1, height: 1 };
          return true;
        },
      },
    ],
  });
  if (v !== 'ok' || !result) return null;
  return { ...result, keep: keep.checked };
}

// ---------------------------------------------------------------------------
// Photo of a stamp or signature -> transparent PNG
// ---------------------------------------------------------------------------

/** Resolves with { blob, width, height, keep } or null. */
export async function stampFromPhoto(file, kind) {
  const bitmap = await createImageBitmap(file);
  const max = 1200;
  const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const W = Math.round(bitmap.width * k), H = Math.round(bitmap.height * k);
  const src = document.createElement('canvas');
  src.width = W;
  src.height = H;
  src.getContext('2d').drawImage(bitmap, 0, 0, W, H);
  const original = src.getContext('2d').getImageData(0, 0, W, H);
  const preview = h('canvas', { class: 'photo-preview', width: W, height: H });
  const opts = { threshold: 0.72, recolor: kind === 'stamp' ? 'red' : 'none' };
  let processed = null;
  const render = () => {
    const out = new ImageData(W, H);
    const s = original.data, d = out.data;
    const t = opts.threshold * 255;
    const soft = 40;
    const tint = opts.recolor === 'red' ? [208, 22, 27] : opts.recolor === 'black' ? [17, 17, 17] : null;
    for (let i = 0; i < s.length; i += 4) {
      const lum = 0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2];
      // For red stamps the ink is bright in the red channel; use the
      // weakest channel so red ink still counts as ink.
      const ink = opts.recolor === 'red' ? Math.min(s[i + 1], s[i + 2]) : lum;
      const a = ink >= t ? 0 : ink <= t - soft ? 255 : Math.round(((t - ink) / soft) * 255);
      if (tint) { d[i] = tint[0]; d[i + 1] = tint[1]; d[i + 2] = tint[2]; } else { d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; }
      d[i + 3] = a;
    }
    preview.getContext('2d').putImageData(out, 0, 0);
    processed = out;
  };
  const thr = h('input', { type: 'range', min: 0.3, max: 0.95, step: 0.01, value: opts.threshold, oninput: (e) => { opts.threshold = Number(e.target.value); render(); } });
  const keep = h('input', { type: 'checkbox', checked: true });
  const content = h('div', { class: 'photo-sheet' },
    h('div', { class: 'photo-preview-wrap checker' }, preview),
    h('label', { class: 'field-label' }, '배경 지우기 강도'), thr,
    h('div', { class: 'field-label' }, '색'),
    segmented([{ value: 'none', label: '원래 색' }, { value: 'red', label: '빨강' }, { value: 'black', label: '검정' }], opts.recolor, (v) => { opts.recolor = v; render(); }),
    h('label', { class: 'inline check' }, keep, '보관함에 저장'),
    h('p', { class: 'muted small' }, '흰 종이에 찍은 도장이나 서명을 밝은 곳에서 찍은 사진이 가장 깔끔합니다.'),
  );
  let result = null;
  const v = await showSheet({
    title: kind === 'stamp' ? '사진으로 도장 만들기' : '사진으로 서명 만들기',
    content,
    className: 'wide',
    onOpen: render,
    actions: [
      { label: '취소', value: null },
      {
        label: '넣기', primary: true, value: 'ok',
        onClick: async () => {
          const trimmed = trimTransparent(processed);
          if (!trimmed) return false;
          result = { blob: await canvasToBlob(trimmed), width: trimmed.width, height: trimmed.height };
          return true;
        },
      },
    ],
  });
  if (v !== 'ok' || !result) return null;
  return { ...result, keep: keep.checked };
}

function trimTransparent(img) {
  const { width: W, height: H, data } = img;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * 4 + 3] > 16) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const pad = 4;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(W - 1, maxX + pad); maxY = Math.min(H - 1, maxY + pad);
  const c = document.createElement('canvas');
  c.width = maxX - minX + 1;
  c.height = maxY - minY + 1;
  const tmp = document.createElement('canvas');
  tmp.width = W;
  tmp.height = H;
  tmp.getContext('2d').putImageData(img, 0, 0);
  c.getContext('2d').drawImage(tmp, -minX, -minY);
  return c;
}
