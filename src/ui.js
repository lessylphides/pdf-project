// Shared UI pieces: bottom sheets / dialogs, toasts, busy overlay.
// Sheets slide up from the bottom on phones and appear centered on wide screens.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

let openSheets = 0;

/**
 * Shows a sheet and resolves with the value of the action that closed it,
 * or null if it was dismissed (backdrop, ✕, Escape).
 * `actions`: [{ label, value, primary, danger, onClick }]. An `onClick` that
 * returns false keeps the sheet open (e.g. after a validation error).
 */
export function showSheet({ title, content, actions = [], className = '', dismissible = true, onOpen }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const backdrop = h('div', { class: 'backdrop' });
    const close = (value) => {
      document.removeEventListener('keydown', onKey, true);
      wrap.classList.remove('open');
      openSheets--;
      setTimeout(() => wrap.remove(), 180);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation();
        close(null);
      }
    };
    const header = h('div', { class: 'sheet-head' },
      h('div', { class: 'grabber' }),
      title ? h('h2', {}, title) : null,
      dismissible ? h('button', { class: 'icon-btn sheet-close', 'aria-label': '닫기', onclick: () => close(null) }, '✕') : null,
    );
    const footer = actions.length
      ? h('div', { class: 'sheet-actions' }, actions.map((a) => h('button', {
        class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`,
        onclick: async () => {
          if (a.onClick && (await a.onClick()) === false) return;
          close(a.value ?? a.label);
        },
      }, a.label)))
      : null;
    const sheet = h('div', { class: `sheet ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' },
      header, h('div', { class: 'sheet-body' }, content), footer);
    const wrap = h('div', { class: 'sheet-wrap' }, backdrop, sheet);
    // Ignore the click that follows the tap which opened the sheet.
    const openedAt = performance.now();
    if (dismissible) backdrop.addEventListener('click', () => { if (performance.now() - openedAt > 450) close(null); });
    root.append(wrap);
    openSheets++;
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => wrap.classList.add('open'));
    onOpen?.({ close, sheet });
  });
}

export const isSheetOpen = () => openSheets > 0;

export async function alertDialog(message, title = '알림') {
  await showSheet({ title, content: h('p', { class: 'dialog-text' }, message), actions: [{ label: '확인', primary: true, value: true }] });
}

export async function confirmDialog(message, { title = '확인', ok = '확인', cancel = '취소', danger = false } = {}) {
  const v = await showSheet({
    title,
    content: h('p', { class: 'dialog-text' }, message),
    actions: [{ label: cancel, value: false }, { label: ok, value: true, primary: !danger, danger }],
  });
  return v === true;
}

/** Text input dialog; resolves with the string or null. */
export async function promptDialog({ title, label, value = '', type = 'text', placeholder = '', ok = '확인', help, validate, inputmode }) {
  const input = h('input', { class: 'field', type, value, placeholder, inputmode, autocomplete: type === 'password' ? 'current-password' : 'off', autocapitalize: 'off', spellcheck: 'false' });
  const error = h('p', { class: 'field-error', hidden: true });
  let result = null;
  const submit = () => {
    const msg = validate?.(input.value);
    if (msg) {
      error.textContent = msg;
      error.hidden = false;
      input.focus();
      return false;
    }
    result = input.value;
    return true;
  };
  const content = h('form', { class: 'prompt-form', onsubmit: (e) => { e.preventDefault(); if (submit()) sheetApi.close('ok'); } },
    label ? h('label', { class: 'field-label' }, label) : null, input, error, help ? h('p', { class: 'muted small' }, help) : null);
  let sheetApi;
  const v = await showSheet({
    title,
    content,
    actions: [{ label: '취소', value: null }, { label: ok, primary: true, value: 'ok', onClick: submit }],
    onOpen: (api) => {
      sheetApi = api;
      setTimeout(() => { input.focus(); input.select(); }, 50);
    },
  });
  return v === 'ok' ? result : null;
}

let toastTimer = null;
export function toast(message, { duration = 3200, action } = {}) {
  const el = document.getElementById('toast');
  el.replaceChildren(h('span', {}, message));
  if (action) el.append(h('button', { class: 'toast-action', onclick: () => { el.classList.remove('show'); action.onClick(); } }, action.label));
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

let busyDepth = 0;
export function setBusyText(text) {
  document.getElementById('busy-text').textContent = text;
}

export async function withBusy(text, fn) {
  busyDepth++;
  setBusyText(text);
  document.getElementById('busy').hidden = false;
  try {
    return await fn();
  } finally {
    if (--busyDepth === 0) document.getElementById('busy').hidden = true;
  }
}
