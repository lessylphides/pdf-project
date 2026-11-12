// Small IndexedDB wrapper. Everything stays on this device: the autosaved
// session (original file + edits) and the signature/stamp library.
const DB_NAME = 'pdf-editor';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('library')) db.createObjectStore('library', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const kvGet = (key) => tx('kv', 'readonly', (s) => s.get(key));
export const kvSet = (key, value) => tx('kv', 'readwrite', (s) => s.put(value, key));
export const kvDelete = (key) => tx('kv', 'readwrite', (s) => s.delete(key));

/** @returns {Promise<{id, kind: 'signature'|'stamp', blob: Blob, width, height, created}[]>} */
export async function libraryList() {
  const items = (await tx('library', 'readonly', (s) => s.getAll())) || [];
  return items.sort((a, b) => b.created - a.created);
}
export const libraryAdd = (item) => tx('library', 'readwrite', (s) => s.put(item));
export const libraryDelete = (id) => tx('library', 'readwrite', (s) => s.delete(id));

// ---------------------------------------------------------------------------
// Session autosave. The source PDFs are written once per open/append (they can
// be large); the edit state is small and rewritten after every change.
// ---------------------------------------------------------------------------

export async function saveSources(sources) {
  await kvSet('session-sources', sources.map((s) => ({ name: s.name, bytes: s.bytes })));
}

export async function saveSessionState(data) {
  await kvSet('session-state', { ...data, savedAt: Date.now() });
}

export async function loadSession() {
  const [state, sources] = await Promise.all([kvGet('session-state'), kvGet('session-sources')]);
  if (!state || !sources?.length) return null;
  return { state, sources };
}

export async function clearSession() {
  await Promise.all([kvDelete('session-state'), kvDelete('session-sources')]);
}
