// ─────────────────────────────────────────────────────────────────────────────
// asset-cache-store — the render machine's LOCAL asset cache.
//
// Before a render, all source assets are downloaded in parallel to this cache and
// the design's srcs are rewritten to point at a local route (served from here with
// Range support). So Remotion's OffthreadVideo reads from localhost = no per-asset
// R2 round-trips DURING render → the render runs compute-bound (no download stalls).
// The cache persists, so a RE-RENDER (fix an effect, tweak a style) reuses the media
// instead of re-downloading. Cache lives on the render machine (populated at render
// time) — which is exactly where it's needed, not on the machine that queued the job.
//
// Size-capped (LRU by mtime, default 40GB, ASSET_CACHE_MAX_GB). Server-only module.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "crypto";
import { mkdir, stat, rename, readdir, unlink, writeFile, readFile } from "fs/promises";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import path from "path";

export const ASSET_CACHE_DIR = path.join(process.cwd(), ".asset-cache");
const CACHE_MAX_BYTES = Number(process.env.ASSET_CACHE_MAX_GB || 20) * 1024 * 1024 * 1024;

// Key by the STABLE part of the URL (pathname) so presigned/rotating query params
// don't defeat reuse. Keep the extension so the served file's Content-Type is right.
const stableUrl = (u: string) => { try { return new URL(u).pathname; } catch { return u.split("?")[0]; } };
export const assetKey = (u: string) =>
  createHash("sha1").update(stableUrl(u)).digest("hex") + (path.extname(stableUrl(u)) || "");

export const cacheFilePath = (key: string) => path.join(ASSET_CACHE_DIR, key);
const urlMetaPath = (key: string) => path.join(ASSET_CACHE_DIR, `${key}.url`);

// Record a key→origin-URL mapping (tiny sidecar file) WITHOUT downloading, so the
// serve route can fetch-on-miss (cache-through) while a background prefetch warms it.
export async function registerAsset(url: string): Promise<string> {
  const key = assetKey(url);
  try {
    await mkdir(ASSET_CACHE_DIR, { recursive: true });
    try { await stat(urlMetaPath(key)); } catch { await writeFile(urlMetaPath(key), url); }
  } catch { /* best-effort */ }
  return key;
}

// The origin R2 URL for a cached key (for cache-through fetch-on-miss), or null.
export async function originUrl(key: string): Promise<string | null> {
  try { return (await readFile(urlMetaPath(key), "utf8")).trim() || null; } catch { return null; }
}

// Background warm — ensureCached but never throws (a failed warm just means the serve
// route cache-throughs that asset on demand).
export async function prefetch(url: string): Promise<boolean> {
  try { const { hit } = await ensureCached(url); return !hit; } catch { return false; }
}

const CT: Record<string, string> = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
};
export const contentTypeFor = (key: string) => CT[path.extname(key).toLowerCase()] || "application/octet-stream";

// Size if fully cached, else null.
export async function cachedSize(key: string): Promise<number | null> {
  try { return (await stat(cacheFilePath(key))).size; } catch { return null; }
}

// Dedup concurrent downloads of the SAME url → one fetch shared by all callers (the
// background warm and a cache-through request would otherwise pull the same asset 2-3×,
// wasting a slow uplink's bandwidth).
const _inflight = new Map<string, Promise<{ key: string; hit: boolean; size: number }>>();

// Download url → cache (skips if already present). Streams to disk — never buffers a
// whole (possibly GB-sized) file in memory. `hit` = already cached (reused, no fetch).
export async function ensureCached(url: string): Promise<{ key: string; hit: boolean; size: number }> {
  const key = assetKey(url);
  const existing = await cachedSize(key);
  if (existing != null) return { key, hit: true, size: existing };

  const running = _inflight.get(url);
  if (running) return running;

  const task = (async () => {
    await mkdir(ASSET_CACHE_DIR, { recursive: true });
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`fetch ${res.status}`);
    const file = cacheFilePath(key);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp));
    await rename(tmp, file);
    return { key, hit: false, size: (await cachedSize(key)) ?? 0 };
  })();
  _inflight.set(url, task);
  try { return await task; } finally { _inflight.delete(url); }
}

// Keep the cache under CACHE_MAX_BYTES by evicting oldest files (LRU by mtime).
let _sweeping = false;
export async function enforceCap() {
  if (_sweeping) return;
  _sweeping = true;
  try {
    const files = await readdir(ASSET_CACHE_DIR).catch(() => [] as string[]);
    const entries: { f: string; size: number; mtime: number }[] = [];
    let total = 0;
    for (const f of files) {
      if (f.includes(".tmp-") || f.endsWith(".url")) continue;
      try { const s = await stat(path.join(ASSET_CACHE_DIR, f)); entries.push({ f, size: s.size, mtime: s.mtimeMs }); total += s.size; } catch {}
    }
    if (total <= CACHE_MAX_BYTES) return;
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const e of entries) {
      if (total <= CACHE_MAX_BYTES) break;
      try {
        await unlink(path.join(ASSET_CACHE_DIR, e.f));
        await unlink(urlMetaPath(e.f)).catch(() => {}); // drop the sidecar too
        total -= e.size;
      } catch {}
    }
  } finally {
    _sweeping = false;
  }
}
