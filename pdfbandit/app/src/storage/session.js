// Remember the last opened PDF, its shared map and the content variants in
// IndexedDB, so a browser refresh (or a closed tab) does not lose the work. Everything
// stays on this machine, in this browser profile; nothing is uploaded and the source
// PDF is never modified.
//
// Keys are used so that editing a content variant (frequent, small) never has to
// rewrite the PDF bytes (large, written once per opened file), and so the three project
// halves are stored as what they are — separate files with separate identities:
//   'pdf'                -> { name, bytes, sha256, savedAt }
//   'map'                -> { json, name, savedAt }
//   'content-translate'  -> { json, name, savedAt }  (the Translate lens's variant)
//   'content-improve'    -> { json, name, savedAt }  (the Improve lens's variant)
//
// There can be up to two content variants — one per lens. Switching lenses loads the
// matching slot, so the translated (destination-language) content never leaks into the
// Improve (source-language) workflow.
const DB_NAME = 'pmap-session';
const STORE = 'session';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const rq = indexedDB.open(DB_NAME, DB_VERSION);
    rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error || new Error('IndexedDB open failed'));
    rq.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      let rq;
      const tx = db.transaction(STORE, mode);
      tx.oncomplete = () => resolve(rq && 'result' in rq ? rq.result : undefined);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      try { rq = fn(tx.objectStore(STORE)); } catch (e) { reject(e); }
    });
  } finally { try { db.close(); } catch {} }
}

// Store the opened PDF (once) plus the map that came with it. `bytes` must stay
// usable afterwards — IndexedDB clones it, so the caller's copy is untouched.
export async function saveSessionPdf(name, bytes, sha256) {
  await withStore('readwrite', s => s.put({ name, bytes, sha256: sha256 || '', savedAt: Date.now() }, 'pdf'));
}

export function loadSessionPdf() {
  return withStore('readonly', s => s.get('pdf')).catch(() => null);
}

// Both halves in one transaction, so a refresh can never restore a map and the *other*
// map's content: they are written together or not at all. `slot` names the lens the
// content variant belongs to ('translate' | 'improve'); it maps to a content-<slot> key.
export async function saveSessionProject({ slot = 'translate', mapJson, mapName, contentJson, contentName } = {}) {
  const contentKey = `content-${slot}`;
  await withStore('readwrite', s => {
    if (mapJson != null) s.put({ json: mapJson, name: mapName || 'document.pmap', savedAt: Date.now() }, 'map');
    if (contentJson != null) s.put({ json: contentJson, name: contentName || 'document.content.json', savedAt: Date.now() }, contentKey);
  });
}

export function loadSessionMap() {
  return withStore('readonly', s => s.get('map')).catch(() => null);
}

export function loadSessionContent(slot = 'translate') {
  return withStore('readonly', s => s.get(`content-${slot}`)).catch(() => null);
}

export async function clearSession() {
  await withStore('readwrite', s => {
    s.delete('pdf'); s.delete('map');
    s.delete('content-translate'); s.delete('content-improve');
  });
}
