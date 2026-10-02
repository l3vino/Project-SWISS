/* index-cache.js — tileset indexes kept between sessions, in IndexedDB.
 *
 * Used by the decode threads (codec.js). A tileset file is fetched and
 * parsed once; its index (formats/tileset-index.js) is stored under its URL,
 * the version of the tileset it belongs to (the root file's ETag or
 * Last-Modified, which change with every release) and the index format, so
 * an index is only ever read back for exactly the file it was made from. The
 * next visit, in this session or the next, reads a few typed arrays instead
 * of downloading and parsing megabytes of JSON.
 *
 * At most LIMIT bytes are kept; the entries used least recently go first.
 * Writes use relaxed durability (the default since Chrome 121, and 3–30
 * times faster than strict): a cache may lose its last writes in a crash.
 * Where storage is unavailable (private windows, blocked site data) or
 * fails, there is simply no cache.
 */

const DB_NAME = 'swissgpu-cache';
const DB_VERSION = 1;
const STORE = 'tileset-index';
const META = 'tileset-index-meta';      // { bytes, at } per key: small, for trimming
const LIMIT = 64 * 1048576;
const RELAXED = { durability: 'relaxed' };

let opening = null;

function open() {
  return (opening ??= new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the database: let it, and stop using this one.
      db.onversionchange = () => { db.close(); opening = Promise.resolve(null); };
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  }));
}

/** The index stored under `key`, or null. Marks it used. */
export async function cacheGet(key) {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction([STORE, META], 'readwrite', RELAXED);
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => {
        const value = req.result ?? null;
        if (value) tx.objectStore(META).put({ bytes: value.bytes ?? 0, at: Date.now() }, key);
        resolve(value);
      };
      req.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Stores an index under `key`. The value is copied when this returns (an
 * object store clones what it is given at once), so its buffers may be
 * transferred away right after; the write itself finishes later.
 */
export async function cachePut(key, value) {
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction([STORE, META], 'readwrite', RELAXED);
    tx.objectStore(STORE).put(value, key);
    tx.objectStore(META).put({ bytes: value.bytes ?? 0, at: Date.now() }, key);
    tx.oncomplete = () => trim(db);
  } catch {
    // Full, or gone: no cache this time.
  }
}

/* Drops the least recently used entries beyond LIMIT. */
function trim(db) {
  try {
    const tx = db.transaction([STORE, META], 'readwrite', RELAXED);
    const meta = tx.objectStore(META);
    const entries = [];
    meta.openCursor().onsuccess = (ev) => {
      const cursor = ev.target.result;
      if (cursor) { entries.push([cursor.key, cursor.value]); cursor.continue(); return; }
      let total = 0;
      for (const [, v] of entries) total += v.bytes || 0;
      if (total <= LIMIT) return;
      entries.sort((a, b) => a[1].at - b[1].at);
      for (const [key, v] of entries) {
        if (total <= LIMIT) break;
        tx.objectStore(STORE).delete(key);
        meta.delete(key);
        total -= v.bytes || 0;
      }
    };
  } catch {
    // Nothing to do: it is only a cache.
  }
}
