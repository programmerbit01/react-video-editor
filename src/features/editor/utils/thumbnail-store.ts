// ─────────────────────────────────────────────────────────────────────────────
// thumbnail-store — persistent timeline-thumbnail cache (IndexedDB).
//
// Browser built-in. No package, no server, no infra. Thumbnails are stored as
// JPEG blobs keyed by src|width|ts, so re-opening a project (or reloading the
// page) reuses them straight from disk instead of re-seeking the video — the
// timeline feels "local-folder" fast after the first pass.
//
// Dev-friendly: bump VERSION to invalidate everything, or call clearThumbs().
// A stray `window.__clearThumbs()` is exposed for manual wiping during dev.
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = "vapp-editor-thumbs";
const STORE = "thumbs";
// Bump when the thumbnail format/keying changes → old cache auto-wiped on open.
const VERSION = 1;

let _db: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_db) return _db;
  _db = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no-idb")); return; }
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      // On any version bump, drop the old store (self-invalidating cache).
      if (d.objectStoreNames.contains(STORE)) d.deleteObjectStore(STORE);
      d.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("idb-blocked"));
  });
  return _db;
}

// Key by the STABLE part of the URL only. Presigned/CDN URLs carry rotating query
// params (?X-Amz-Signature=…, ?token=…) that change every load — keying by the full
// URL would miss every time and re-extract forever. The pathname identifies the asset.
const stableSrc = (src: string): string => {
  try { return new URL(src, "http://x").pathname; } catch { return src.split("?")[0]; }
};
const keyOf = (src: string, width: number, ts: number) =>
  `${stableSrc(src)}|${Math.round(width)}|${Math.round(ts)}`;

// Returns the cached JPEG blob for this exact frame, or undefined on any miss/error.
// Never throws — a cache failure must fall through to live extraction, not break render.
export async function getThumbBlob(src: string, width: number, ts: number): Promise<Blob | undefined> {
  try {
    const d = await openDb();
    return await new Promise<Blob | undefined>((resolve) => {
      const tx = d.transaction(STORE, "readonly");
      const r = tx.objectStore(STORE).get(keyOf(src, width, ts));
      r.onsuccess = () => resolve(r.result instanceof Blob ? r.result : undefined);
      r.onerror = () => resolve(undefined);
    });
  } catch { return undefined; }
}

// Persist one extracted frame. Fire-and-forget; failures are swallowed.
export async function putThumbBlob(src: string, width: number, ts: number, blob: Blob): Promise<void> {
  try {
    const d = await openDb();
    await new Promise<void>((resolve) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, keyOf(src, width, ts));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch { /* ignore */ }
}

// Wipe the whole cache (dev/manual).
export async function clearThumbs(): Promise<void> {
  try {
    const d = await openDb();
    await new Promise<void>((resolve) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* ignore */ }
}

if (typeof window !== "undefined") {
  (window as any).__clearThumbs = clearThumbs;
}
