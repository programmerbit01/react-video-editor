import { ADD_AUDIO, ADD_IMAGE, ADD_VIDEO } from "@designcombo/state";
import { dispatch } from "@designcombo/events";
import { Music, Loader2, UploadIcon, Upload, RefreshCw, Play, Pause, AlertCircle } from "lucide-react";
import { generateId } from "@designcombo/timeline";
import { Button } from "@/components/ui/button";
import useUploadStore from "../store/use-upload-store";
import { resolveAssetUrl } from "../utils/asset-url";
import { vappAuth, sttForUrl } from "@/utils/vapp-api";
import useCaptionTranscribeStore from "../captions/transcribe-store";
import ModalUpload from "@/components/modal-upload";
import Draggable from "@/components/shared/draggable";
import { toast } from "sonner";
import { Component, useEffect, useRef, useState, memo } from "react";
import type { Dispatch, MouseEvent, ReactNode, SetStateAction } from "react";

// A single malformed media item (e.g. a bad/new record shape) must NEVER crash the
// whole media panel — without this, one throwing tile takes the tabs + grid down until
// a full refresh. Catches render errors per-tile and drops just that tile.
class TileErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { /* swallow: isolate the bad tile, keep the panel alive */ }
  render() { return this.state.failed ? null : this.props.children; }
}

type CachedMediaMeta = {
  width?: number;
  height?: number;
  duration?: number;
  previewUrl?: string;
};

const mediaMetaCache = new Map<string, CachedMediaMeta>();
const mediaMetaInflight = new Map<string, Promise<CachedMediaMeta>>();
const PREWARM_LIMIT = 20;
const PER_PAGE = 50; // media items requested per page (matches server per_page)

const inferMediaType = (url: string): string => {
  const ext = String(url || "").split("?")[0].split(".").pop()?.toLowerCase() || "";
  if (["mp4", "webm", "mov"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "aac", "m4a", "flac"].includes(ext)) return "audio";
  if (["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(ext)) return "image";
  return "image";
};

// Map a raw vApp `/vapp/user/media` record → the intermediate shape toUploadItem
// reads (this is the field-mapping the higgs proxy used to do; now done in-editor
// so the editor talks to the vApp server directly).
const normalizeServerMedia = (it: any) => {
  const entry: any = {
    url: it?.url || "",
    type: it?.media || inferMediaType(it?.url || ""), // media type: image|video|audio
    name: it?.filename || it?.original_name || "",
    createdAt: it?.created || it?.mtime || "",
    created: it?.created || "",
    mtime: it?.mtime || "",
    updated: it?.updated || it?.updated_at || "",
    record_id: it?.record_id || "",
    prompt: it?.prompt || "",
    poster: it?.poster || "", // server-generated video poster (instant, no client capture)
    source: it?.type || "", // vApp `type` = input | output (source dimension)
  };
  if (it?.stt && typeof it.stt === "object") entry.stt = it.stt;
  return entry;
};

// Ported VERBATIM from vapp_higgs StandaloneShell.parseTimeMs — same numeric time
// parse the higgs front page uses, so the editor orders media EXACTLY like higgs.
const parseTimeMs = (v: any): number => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v > 1e12) return Math.trunc(v);
    if (v > 1e9) return Math.trunc(v * 1000);
    return 0;
  }
  const s = String(v).trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) {
      if (n > 1e12) return Math.trunc(n);
      if (n > 1e9) return Math.trunc(n * 1000);
    }
  }
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : 0;
};

// Sort by the canonical PB `created` FIRST (it's the server's own pagination key and
// is correct for every item), then fall back to createdAt/mtime/updated, then to a
// filename-embedded ts. Using created first keeps client order == server order and
// avoids jumble when cached items (older shape) lack `mtime`.
const tsOf = (item: any): number => {
  const t = parseTimeMs(item?.created || item?.createdAt || item?.mtime || item?.updated || item?.updated_at || item?.ctime);
  if (t) return t;
  const name = String(item?.fileName || item?.name || item?.url || "");
  let m = name.match(/_(\d{13})_/);
  if (m) return Number(m[1]);
  m = name.match(/TS-(\d{10})/);
  if (m) return Number(m[1]) * 1000;
  return 0;
};

// higgs tie-break: newer record_id first when timestamps are equal.
const cmpMedia = (a: any, b: any): number => {
  const d = tsOf(b) - tsOf(a);
  if (d) return d;
  const ida = Number(a?.record_id || a?.id || 0);
  const idb = Number(b?.record_id || b?.id || 0);
  if (Number.isFinite(ida) && Number.isFinite(idb) && ida !== idb) return idb - ida;
  return String(b?.record_id || b?.id || "").localeCompare(String(a?.record_id || a?.id || ""));
};

// Fast, metadata-ONLY probe (duration + dimensions) — resolves on loadedmetadata,
// NO seek/canvas frame-capture. Used to add a clip to the timeline instantly; the
// heavy ensureVideoMeta (preview frame) runs in the background afterwards.
// Result is cached + de-duped: click-add, hover prewarm and the drop handler all ask for
// the same numbers, and without this each one paid for its own <video> load.
const fastVideoMeta = (src: string): Promise<CachedMediaMeta> => {
  if (!src) return Promise.resolve({});
  const cached = mediaMetaCache.get(src);
  if (cached?.duration && cached?.width && cached?.height) return Promise.resolve(cached);
  const existing = mediaMetaInflight.get(src);
  if (existing) return existing;
  const task = _fastVideoMetaOnce(src).then((meta) => {
    mediaMetaInflight.delete(src);
    // Keep whatever the probe DID learn (dims survive even when duration is unreadable);
    // never write a 0/undefined over a good cached value.
    const fresh: CachedMediaMeta = {};
    if (meta.duration) fresh.duration = meta.duration;
    if (meta.width) fresh.width = meta.width;
    if (meta.height) fresh.height = meta.height;
    if (!Object.keys(fresh).length) return {};
    const merged = { ...(mediaMetaCache.get(src) || {}), ...fresh };
    mediaMetaCache.set(src, merged);
    return merged;
  });
  mediaMetaInflight.set(src, task);
  return task;
};

const _fastVideoMetaOnce = (src: string): Promise<CachedMediaMeta> =>
  new Promise((resolve) => {
    if (!src) return resolve({});
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    let settled = false;
    const finish = (r: CachedMediaMeta) => {
      if (settled) return;
      settled = true;
      try { v.src = ""; v.load(); } catch {}
      resolve(r);
    };
    const timer = window.setTimeout(() => finish({}), 4000);
    v.onloadedmetadata = () => {
      window.clearTimeout(timer);
      // `v.duration || 10` let Infinity through (it is truthy) — that cached an Infinity
      // duration and every later reader believed it. Only a finite, positive duration is
      // a result; anything else reports empty so the caller falls back / re-probes.
      const d = v.duration;
      finish({
        duration: Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : 0,
        width: v.videoWidth || 1920,
        height: v.videoHeight || 1080,
      });
    };
    v.onerror = () => { window.clearTimeout(timer); finish({}); };
    v.src = src;
    v.load();
  });

// Robust audio-duration probe. The state manager's OWN audio loader (@designcombo/state
// `ys`) always re-loads the src with preload="auto", NO timeout, rejects on error, and has
// NO Infinity-duration guard — so a click can silently drop the clip (unhandled rejection,
// no toast) or land a broken one when a VBR/chunked MP3 reports duration=Infinity. Resolving
// the duration here FIRST (a) makes the "adding" spinner paint during the await, and (b) warms
// the SAME browser media cache the package will hit — no crossOrigin, matching cors.audio=false
// in editor.tsx — so the package's follow-up load resolves fast AND finite. Result is cached in
// the shared mediaMetaCache so a prewarmed (hover) item adds instantly.
// header-only read: loadedmetadata must land in this. 25s (was 12) because on a slow
// connection even the RANGE-based metadata read of a long voiceover (measured: a 36-min,
// 17 MB mp3) takes well past 12s — and it does NOT download the whole file, so a longer
// window just waits, it doesn't cost bandwidth. 12s was turning a slow-but-fine file into
// a hard "metadata unavailable" failure ([audio-meta] timeout after ~12008ms in the wild).
const AUDIO_META_TIMEOUT = 25000;
const AUDIO_SCAN_TIMEOUT = 45000;   // duration=Infinity → we're downloading the WHOLE file
// Every empty result carries WHY, so a failure names itself in the console instead of
// surfacing as a bare "metadata is unavailable" toast. `error` = the element gave up on
// the resource (transient CDN 404 on a just-generated file, aborted connection, decode
// failure); `timeout`/`scan-timeout` = it was still downloading when the budget ran out.
type AudioProbe = CachedMediaMeta & { reason?: "error" | "timeout" | "scan-timeout" };

const probeAudioMeta = (src: string): Promise<AudioProbe> =>
  new Promise<AudioProbe>((resolve) => {
    const a = document.createElement("audio");
    a.preload = "metadata";
    // NO crossOrigin on purpose: the state manager loads audio non-CORS (cors.audio=false),
    // so we must warm the same non-CORS cache entry it will later fetch.
    let settled = false;
    let timer = 0;
    const t0 = Date.now();
    const cleanup = () => { try { a.src = ""; a.load(); } catch {} };
    const finish = (meta: AudioProbe) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (!meta.duration) {
        console.warn(`[audio-meta] ${meta.reason || "empty"} after ${Date.now() - t0}ms →`, src.slice(0, 140));
      }
      cleanup();
      resolve(meta);
    };
    timer = window.setTimeout(() => finish({ reason: "timeout" }), AUDIO_META_TIMEOUT);

    const readDuration = (): boolean => {
      const d = a.duration;
      if (Number.isFinite(d) && d > 0) { finish({ duration: Math.round(d * 1000) }); return true; }
      return false;
    };

    a.onloadedmetadata = () => {
      if (readDuration()) return;
      // duration is Infinity/NaN (VBR/chunked MP3, or a WAV whose RIFF size field is a
      // placeholder because it was written while streaming) — force a scan to the end so
      // the browser learns the real duration; this also fully caches the file, so the
      // state manager's own load then reports a finite duration too. That scan downloads
      // the ENTIRE file, so it gets its own, much longer budget — the header-only timeout
      // used to kill long voiceovers mid-download and report them as broken.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => finish({ reason: "scan-timeout" }), AUDIO_SCAN_TIMEOUT);
      const onDur = () => { if (readDuration()) a.removeEventListener("durationchange", onDur); };
      a.addEventListener("durationchange", onDur);
      try { a.currentTime = 1e7; } catch {}
    };
    a.onerror = () => finish({ reason: "error" });
    a.src = src;
    a.load();
  });

const ensureAudioMeta = (src: string): Promise<CachedMediaMeta> => {
  if (!src) return Promise.resolve({});
  const cached = mediaMetaCache.get(src);
  if (cached?.duration) return Promise.resolve(cached);
  const existing = mediaMetaInflight.get(src);
  if (existing) return existing;

  const task = probeAudioMeta(src).then((meta) => {
    mediaMetaInflight.delete(src);
    if (!meta.duration) return {};
    const merged = { ...(mediaMetaCache.get(src) || {}), duration: meta.duration };
    mediaMetaCache.set(src, merged);
    return merged;
  });

  mediaMetaInflight.set(src, task);
  return task;
};

// Click-path probe: never gives up on the first empty result.
// Two holes the single-shot version had, both of which look like "kabhi kabhi" to the user:
//   1. A just-generated file may not be readable on the CDN edge yet (the same eventual
//      consistency that bites frame extraction and the prompt optimiser) → one `error`,
//      no retry, straight to the toast. It works "on the second try" because the second
//      try is simply later.
//   2. Hover prewarm starts a probe; a click 2s later joins that SAME inflight promise and
//      inherits its already-spent budget — so the click could be handed a failure the user
//      never waited for. The retry gives the click its own, fresh attempt.
const ensureAudioMetaForAdd = async (src: string): Promise<CachedMediaMeta> => {
  const cached = mediaMetaCache.get(src);
  if (cached?.duration) return cached;
  const first = await ensureAudioMeta(src);
  if (first.duration) return first;
  await new Promise((r) => setTimeout(r, 900));
  console.warn("[audio-meta] retrying probe →", src.slice(0, 140));
  const again = await probeAudioMeta(src);
  if (!again.duration) return {};
  const merged = { ...(mediaMetaCache.get(src) || {}), duration: again.duration };
  mediaMetaCache.set(src, merged);
  return merged;
};

// Drag payload for dropping a tile onto the scene/timeline. Matches what the scene
// DroppableArea expects ({type, details.src, …}); it adds the id + places the clip.
// Built synchronously from caches (poster/dims) — same defaults as click-add.
const dragData = (item: any): Record<string, any> => {
  const src = getPlayerSrc(item);
  const dsrc = getDisplaySrc(item);
  // Carry the library's label onto the item. The panel already knows this media as "sana is my
  // name"; the clip only ever knew itself as "audio", because the name stopped here. Every R2
  // pull lands at <job>/0.mp3, so the filename can't tell two voiceovers apart either.
  const name = getLabel(item);
  if (isAudio(item)) return { type: "audio", details: { src, name }, metadata: {} };
  const meta = mediaMetaCache.get(src) || mediaMetaCache.get(dsrc) || {};
  const width = meta.width || 1920, height = meta.height || 1080;
  if (isVideo(item)) {
    // Include the server poster URL (small, safe for dataTransfer) so the dropped clip
    // shows instantly. No data-URL here (that bloats dataTransfer); if no server poster,
    // the timeline captures the frame itself.
    const poster = String(item.poster || "");
    return poster
      ? { type: "video", duration: meta.duration || 10000, details: { src, width, height, name }, metadata: { previewUrl: poster } }
      : { type: "video", duration: meta.duration || 10000, details: { src, width, height, name } };
  }
  return { type: "image", display: { from: 0, to: 5000 }, details: { src, width, height, name }, metadata: { previewUrl: dsrc } };
};

// ── drag-drop ↔ click parity ─────────────────────────────────────────────────
// The drag payload above is built at RENDER time out of whatever happens to be in the
// meta cache. For a tile that hasn't been probed yet that means the placeholder
// `duration: 10000` (video) or no duration at all (audio) — so a dropped clip landed
// with a length unrelated to the file and the user had to drag its edge back to size.
// Click-add never had the bug because it awaits the real duration before dispatching.
//
// The drop handler runs this first so both paths dispatch the SAME numbers. It is cheap:
// a warm cache (hover prewarm, or an earlier add of the same file) returns without any
// await at all, and a cold one costs a single metadata-only read that is de-duped with
// whatever probe the hover already started. On failure it returns the payload untouched
// — a clip with the old placeholder length, exactly like before, never a dropped drop.
export const resolveDropPayload = async (payload: any): Promise<any> => {
  try {
    const type = String(payload?.type || "");
    const src = String(payload?.details?.src || "");
    if (!src) return payload;

    if (type === "audio") {
      const cached = mediaMetaCache.get(src);
      const meta = cached?.duration ? cached : await ensureAudioMetaForAdd(src);
      return meta.duration ? { ...payload, duration: meta.duration } : payload;
    }

    if (type === "video") {
      const cached = mediaMetaCache.get(src);
      if (cached?.duration && cached?.width && cached?.height) {
        return {
          ...payload,
          duration: cached.duration,
          details: { ...payload.details, width: cached.width, height: cached.height },
        };
      }
      const fast = await fastVideoMeta(src);
      if (!fast.duration) return payload;
      return {
        ...payload,
        duration: fast.duration,
        details: {
          ...payload.details,
          width: fast.width || payload?.details?.width || 1920,
          height: fast.height || payload?.details?.height || 1080,
        },
      };
    }

    return payload; // image — its 5 000 ms display window already matches click-add
  } catch (err) {
    console.warn("[drop] duration resolve failed, using payload as-is", err);
    return payload;
  }
};

const getLabel = (item: any) => {
  // Prefer the generation prompt (nice, human label) over the ugly vapp_*/TS filename.
  const p = String(item.prompt || item.metadata?.prompt || "").trim();
  if (p) return p;
  return item.fileName || item.file?.name || item.url?.split("/").pop()?.split("?")[0] || "";
};

const isVideo = (u: any) => u.type?.startsWith("video/") || u.type === "video";
const isAudio = (u: any) => u.type?.startsWith("audio/") || u.type === "audio";

const isVappItem = (u: any) =>
  Boolean(
    u?.metadata?.vappItem ||
    u?.url?.includes("rpublic.tomtap.ai") ||
    u?.url?.includes("/api/proxy?url=") // legacy
  );

const normalizeMediaSrc = (src?: string) => {
  if (!src) return "";
  if (src.startsWith("/uploads/")) return `/editor${src}`;
  return src;
};

// Player src resolves DIRECT (R2 CORS `*`) via the shared resolver — no proxy hop.
// See utils/asset-url. Grid display uses getDisplaySrc (also direct).
const getPlayerSrc = (item: any) =>
  resolveAssetUrl(normalizeMediaSrc(item.metadata?.uploadedUrl || item.url));

const getDisplaySrc = (item: any) => {
  // DIRECT R2 for grid display — <img>/<video>/canvas capture don't need CORS-fetch.
  return normalizeMediaSrc(item.metadata?.directUrl || item.metadata?.uploadedUrl || item.url);
};

const getVappParams = () => {
  if (typeof window === "undefined") return { vappHost: "", token: "", baseUrl: "" };
  const p = new URLSearchParams(window.location.search);
  return {
    vappHost: p.get("vappHost") || `${window.location.protocol}//${window.location.hostname}`,
    token: p.get("token") || "",
    baseUrl: p.get("baseUrl") || "https://api.muapi.ai",
  };
};

const toUploadItem = (item: any) => {
  const rawUrl = String(item.url || "");
  if (!rawUrl) return null;
  // Direct R2 URL for player AND display — no /api/proxy hop. R2 exposes CORS `*`
  // so Remotion's fetch(), canvas frame-capture and the grid all load direct.
  const entry: any = {
    // Unique per item: the R2 filename alone is NOT unique (every job outputs
    // `0.jpg`/`0.mp4`), so keying tiles by it collides → React can't reconcile the
    // grid on filter change (stale tiles pile up, tabs show a mix). Use the stable
    // full URL path (query/signature stripped) or the PB record_id.
    id: `vapp-${item.record_id || rawUrl.split("?")[0] || Math.random().toString(36).slice(2)}`,
    url: rawUrl,
    filePath: rawUrl,
    fileName: item.name || rawUrl.split("/").pop()?.split("?")[0] || "media",
    type: item.type === "video" ? "video/mp4" : item.type === "audio" ? "audio/mp3" : "image/jpeg",
    metadata: { uploadedUrl: rawUrl, directUrl: rawUrl, vappItem: true },
    status: "uploaded",
    // time fields carried through for higgs-identical sorting (see cmpMedia/tsOf).
    createdAt: item.createdAt || "",
    mtime: item.mtime || "",
    updated: item.updated || item.updated_at || "",
    created: item.created || "",
    record_id: item.record_id || "",
    prompt: item.prompt || "",
    poster: item.poster || "",
    source: item.source || "", // input | output
  };
  if (item.stt && typeof item.stt === "object") entry.stt = item.stt;
  return entry;
};

// ── Video poster cache (persistent) ───────────────────────────────────────────
// Capture ONE small JPEG frame per video → cache in-memory + localStorage. Grid
// then renders an <img> (instant, light) instead of keeping a live <video> per
// tile. Persisted so reopening the editor shows thumbnails immediately.
const POSTER_KEY = "vapp_video_posters_v1";
const posterCache = new Map<string, string>();
(function loadPosterCache() {
  try {
    const o = JSON.parse(localStorage.getItem(POSTER_KEY) || "{}");
    for (const k of Object.keys(o)) posterCache.set(k, o[k]);
  } catch {}
})();
let _posterSaveTimer: any;
const savePosterCache = () => {
  clearTimeout(_posterSaveTimer);
  _posterSaveTimer = setTimeout(() => {
    try {
      const entries = Array.from(posterCache.entries()).slice(-250); // bound size
      localStorage.setItem(POSTER_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {}
  }, 600);
};
const posterInflight = new Map<string, Promise<string>>();

// Concurrency limiter — too many simultaneous video-frame captures contend for
// network/decode and time out (→ some tiles get no poster). Cap to a few at a time.
const POSTER_CONCURRENCY = 3;
let _posterActive = 0;
const _posterQueue: (() => void)[] = [];
const _posterNext = () => {
  if (_posterActive >= POSTER_CONCURRENCY) return;
  const job = _posterQueue.shift();
  if (job) { _posterActive++; job(); }
};

// ONE capture attempt: video → seek → canvas frame. Resolves "" on any failure.
const _captureOnce = (src: string): Promise<string> =>
  new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    v.crossOrigin = "anonymous"; // must match every other <video> load or the canvas taints
    let done = false;
    const cleanup = () => { try { v.src = ""; v.load(); } catch {} };
    const finish = (r: string) => { if (done) return; done = true; window.clearTimeout(timer); cleanup(); resolve(r); };
    const timer = window.setTimeout(() => finish(""), 12000);
    v.onloadedmetadata = () => {
      // Free duration + dimensions: this element has already read the header, so record it
      // instead of throwing it away and making some later probe load the file again. Hover
      // prewarm captures a poster → the tile's drag payload now knows the real length too.
      if (Number.isFinite(v.duration) && v.duration > 0) {
        const prev = mediaMetaCache.get(src) || {};
        mediaMetaCache.set(src, {
          ...prev,
          duration: prev.duration || Math.round(v.duration * 1000),
          width: prev.width || v.videoWidth || 0,
          height: prev.height || v.videoHeight || 0,
        });
      }
      const t = Number.isFinite(v.duration) && v.duration > 1 ? 1 : 0;
      try { v.currentTime = t; } catch { finish(""); }
    };
    v.onseeked = () => {
      if (done) return;
      try {
        const w = v.videoWidth || 320, h = v.videoHeight || 180;
        const aspect = w && h ? w / h : 16 / 9;
        const th = 96, tw = Math.max(1, Math.round(th * aspect));
        const c = document.createElement("canvas");
        c.width = tw; c.height = th;
        const ctx = c.getContext("2d");
        if (!ctx) return finish("");
        ctx.drawImage(v, 0, 0, tw, th);
        finish(c.toDataURL("image/jpeg", 0.62));
      } catch { finish(""); } // taint / decode error
    };
    v.onerror = () => finish("");
    v.src = src; v.load();
  });

const capturePoster = (src: string): Promise<string> => {
  if (!src) return Promise.resolve("");
  const cached = posterCache.get(src);
  if (cached) return Promise.resolve(cached);
  const existing = posterInflight.get(src);
  if (existing) return existing;
  const task = new Promise<string>((resolve) => {
    const run = async () => {
      let url = await _captureOnce(src);
      if (!url) { await new Promise((r) => setTimeout(r, 400)); url = await _captureOnce(src); } // retry once
      if (url) { posterCache.set(src, url); savePosterCache(); }
      _posterActive--;
      posterInflight.delete(src);
      _posterNext();
      resolve(url);
    };
    _posterQueue.push(run);
    _posterNext();
  });
  posterInflight.set(src, task);
  return task;
};

// Lazy visibility — only load/capture a thumbnail once the tile nears the viewport.
function useInView<T extends HTMLElement>(rootMargin = "400px") {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (inView) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setInView(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setInView(true); io.disconnect(); }
    }, { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [inView, rootMargin]);
  return { ref, inView };
}

// ── Thumbnail ────────────────────────────────────────────────────────────────

const VideoThumb = ({ src, serverPoster }: { src: string; serverPoster?: string }) => {
  // serverPoster (meta.poster) → instant <img>, ZERO client capture. Only fall back to
  // canvas capture when the server hasn't produced a poster yet.
  const [poster, setPoster] = useState<string>(() => serverPoster || posterCache.get(src) || "");
  const [failed, setFailed] = useState(false);
  const { ref, inView } = useInView<HTMLDivElement>();

  useEffect(() => {
    if (serverPoster || poster || failed || !inView || !src) return;
    let alive = true;
    capturePoster(src).then((p) => {
      if (!alive) return;
      if (p) setPoster(p); else setFailed(true);
    });
    return () => { alive = false; };
  }, [inView, src, poster, failed, serverPoster]);

  return (
    <div ref={ref} className="w-full h-full bg-white/5 flex items-center justify-center">
      {poster ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={poster} alt="" draggable={false} className="w-full h-full object-cover absolute inset-0" />
      ) : failed ? (
        // Canvas capture unavailable → lazy <video> showing the frame at 1s (media fragment).
        // crossOrigin MUST match capturePoster's — else the browser caches a non-CORS
        // copy that later taints the canvas (→ black clips in the timeline).
        <video src={`${src}#t=1`} muted playsInline preload="metadata" crossOrigin="anonymous"
          className="w-full h-full object-cover absolute inset-0" />
      ) : inView ? (
        <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
      ) : null}
    </div>
  );
};

const Thumb = ({ item }: { item: any }) => {
  // Use direct CDN URL for display — faster, no proxy hop, HTML tags don't need CORS
  const src = getDisplaySrc(item);
  if (isAudio(item)) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-white/5">
        <Music className="w-6 h-6 text-muted-foreground" />
      </div>
    );
  }
  if (isVideo(item)) {
    return <VideoThumb src={src} serverPoster={item.poster || ""} />;
  }
  return (
    <img
      src={src}
      draggable={false}
      className="w-full h-full object-cover"
      alt=""
      loading="lazy"
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0.3"; }}
    />
  );
};

// ── Grid item ─────────────────────────────────────────────────────────────────

const UploadGridItem = memo(({
  item,
  onAdd,
  isActive,
  setActivePreviewId,
  adding,
  onPrewarm,
}: {
  item: any;
  onAdd: (item: any) => void;
  isActive: boolean;
  setActivePreviewId: Dispatch<SetStateAction<string | null>>;
  adding: boolean;
  onPrewarm: (item: any) => void;
}) => {
  const mediaId = String(item.id || item.url);
  const src = getDisplaySrc(item);
  const dragPreview = posterCache.get(src) || (isVideo(item) || isAudio(item) ? "" : src); // drag ghost thumbnail
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const previewable = isVideo(item) || isAudio(item);

  const stopPreview = () => {
    videoRef.current?.pause();
    audioRef.current?.pause();
    if (videoRef.current) videoRef.current.currentTime = 0;
    if (audioRef.current) audioRef.current.currentTime = 0;
    setIsPlaying(false);
    setActivePreviewId((curr) => (curr === mediaId ? null : curr));
  };

  useEffect(() => {
    if (!isActive && isPlaying) {
      videoRef.current?.pause();
      audioRef.current?.pause();
      if (videoRef.current) videoRef.current.currentTime = 0;
      if (audioRef.current) audioRef.current.currentTime = 0;
      setIsPlaying(false);
    }
  }, [isActive, isPlaying]);

  const handleTogglePreview = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!previewable) return;
    if (isPlaying) { stopPreview(); return; }
    setActivePreviewId(mediaId);
    try {
      if (isVideo(item) && videoRef.current) {
        videoRef.current.currentTime = 0;
        await videoRef.current.play();
      } else if (isAudio(item) && audioRef.current) {
        audioRef.current.currentTime = 0;
        await audioRef.current.play();
      }
      setIsPlaying(true);
    } catch {
      setIsPlaying(false);
    }
  };

  return (
    <div className="flex flex-col gap-1 items-center">
      <Draggable
        data={dragData(item)}
        shouldDisplayPreview={!isPlaying}
        renderCustomPreview={
          <div
            className="draggable rounded-md"
            style={{
              width: 72, height: 72, backgroundColor: "#1f1f22",
              backgroundImage: dragPreview ? `url(${dragPreview})` : undefined,
              backgroundSize: "cover", backgroundPosition: "center",
            }}
          />
        }
      >
      <div
        className={`relative w-full aspect-video rounded-md overflow-hidden bg-white/5 hover:ring-1 hover:ring-white/20 transition-all ${adding ? "cursor-wait ring-1 ring-primary/60" : "cursor-pointer"}`}
        onClick={() => onAdd(item)}
        onMouseEnter={() => onPrewarm(item)}
        onMouseLeave={stopPreview}
        title={adding ? "Adding to timeline…" : "Drag to place, or click to add"}
      >
        <Thumb item={item} />
        {adding && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 backdrop-blur-[1px]">
            <Loader2 className="w-5 h-5 text-white animate-spin" />
          </div>
        )}
        {isVideo(item) && (
          <video
            ref={videoRef}
            src={src}
            crossOrigin="anonymous"
            className={`absolute inset-0 h-full w-full object-cover transition-opacity ${isPlaying ? "opacity-100" : "opacity-0 pointer-events-none"}`}
            playsInline
            preload="none"
            onEnded={stopPreview}
          />
        )}
        {isAudio(item) && (
          <audio ref={audioRef} src={src} preload="none" onEnded={stopPreview} />
        )}
        {previewable && (
          <button
            type="button"
            onClick={handleTogglePreview}
            className="absolute top-1.5 right-1.5 z-10 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/75 text-white/90 hover:bg-black/90"
          >
            {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 ml-0.5" />}
          </button>
        )}
      </div>
      </Draggable>
      <span className="text-xs text-muted-foreground truncate w-full text-center">
        {getLabel(item)}
      </span>
    </div>
  );
}, (prev, next) =>
  // Re-render a tile ONLY when its OWN state changes — clicking one video no longer
  // re-renders (flickers) every other tile. Handler identity is ignored on purpose.
  prev.item === next.item &&
  prev.isActive === next.isActive &&
  prev.adding === next.adding
);
UploadGridItem.displayName = "UploadGridItem";

// ── Main component ────────────────────────────────────────────────────────────

export const Uploads = () => {
  const {
    setShowUploadModal, uploads, pendingUploads, activeUploads, setUploads,
    uploadsLoaded, setUploadsLoaded,
    uploadsHasMore: hasMore, setUploadsHasMore: setHasMore,
    uploadsPage: page, setUploadsPage: setPage
  } = useUploadStore();
  const { setTranscriptResult } = useCaptionTranscribeStore();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null); // item being added → timeline (spinner + re-click guard)
  const [mediaFilter, setMediaFilter] = useState<"all" | "image" | "video" | "audio" | "uploads">("all");

  const ensureImageMeta = async (item: any): Promise<CachedMediaMeta> => {
    const src = getDisplaySrc(item);
    if (!src) return {};
    const cached = mediaMetaCache.get(src);
    if (cached?.width && cached?.height) return cached;
    const existing = mediaMetaInflight.get(src);
    if (existing) return existing;

    const task = new Promise<CachedMediaMeta>((resolve) => {
      const img = new Image();
      img.onload = () => {
        const meta = {
          ...(mediaMetaCache.get(src) || {}),
          width: img.naturalWidth || 1920,
          height: img.naturalHeight || 1080,
        };
        mediaMetaCache.set(src, meta);
        mediaMetaInflight.delete(src);
        resolve(meta);
      };
      img.onerror = () => {
        const meta = mediaMetaCache.get(src) || {};
        mediaMetaInflight.delete(src);
        resolve(meta);
      };
      img.src = src;
    });

    mediaMetaInflight.set(src, task);
    return task;
  };

  const ensureVideoMeta = async (item: any): Promise<CachedMediaMeta> => {
    const playerSrc = getPlayerSrc(item);
    const displaySrc = getDisplaySrc(item);
    const cacheKey = playerSrc || displaySrc;
    if (!cacheKey) return {};
    const cached = mediaMetaCache.get(cacheKey);
    if (cached?.duration && cached?.width && cached?.height && cached?.previewUrl) return cached;
    const existing = mediaMetaInflight.get(cacheKey);
    if (existing) return existing;

    const task = new Promise<CachedMediaMeta>((resolve) => {
      let settled = false;
      const finalize = (patch: CachedMediaMeta = {}) => {
        if (settled) return;
        settled = true;
        const meta = {
          ...(mediaMetaCache.get(cacheKey) || {}),
          ...patch,
        };
        if (playerSrc) mediaMetaCache.set(playerSrc, meta);
        if (displaySrc) mediaMetaCache.set(displaySrc, meta);
        mediaMetaInflight.delete(cacheKey);
        resolve(meta);
      };

      const trySource = (sourceUrl: string, allowCanvasCapture: boolean, onDone: () => void) => {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.muted = true;
        video.playsInline = true;
        if (allowCanvasCapture) video.crossOrigin = "anonymous";

        const finishWithMeta = (previewUrl = "") => {
          const nextMeta: CachedMediaMeta = {
            duration: Math.round((video.duration || 10) * 1000),
            width: video.videoWidth || 1920,
            height: video.videoHeight || 1080,
          };
          if (previewUrl) nextMeta.previewUrl = previewUrl;
          if (nextMeta.previewUrl || !allowCanvasCapture) {
            finalize(nextMeta);
          } else {
            onDone();
          }
        };

        const captureFrame = () => {
          try {
            const width = video.videoWidth || 1920;
            const height = video.videoHeight || 1080;
            const aspect = width && height ? width / height : 16 / 9;
            const targetHeight = 40;
            const targetWidth = Math.max(1, Math.round(targetHeight * aspect));
            const canvas = document.createElement("canvas");
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) return finishWithMeta();
            ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
            finishWithMeta(canvas.toDataURL("image/jpeg", 0.72));
          } catch {
            finishWithMeta();
          }
        };

        const timer = window.setTimeout(() => {
          if (allowCanvasCapture) onDone();
          else finalize();
        }, allowCanvasCapture ? 3500 : 6000);

        video.onloadedmetadata = () => {
          if (!allowCanvasCapture) {
            window.clearTimeout(timer);
            finishWithMeta();
            return;
          }
          const seekTime = Number.isFinite(video.duration) && video.duration > 1 ? 1 : 0;
          try {
            video.currentTime = seekTime;
          } catch {
            window.clearTimeout(timer);
            finishWithMeta();
          }
        };
        video.onseeked = () => {
          window.clearTimeout(timer);
          captureFrame();
        };
        video.onerror = () => {
          window.clearTimeout(timer);
          onDone();
        };
        video.src = sourceUrl;
        video.load();
      };

      if (playerSrc) {
        trySource(playerSrc, true, () => {
          if (displaySrc && displaySrc !== playerSrc) {
            trySource(displaySrc, true, () => finalize());
          } else {
            finalize();
          }
        });
      } else if (displaySrc) {
        trySource(displaySrc, true, () => finalize());
      } else {
        finalize();
      }
    });

    mediaMetaInflight.set(cacheKey, task);
    return task;
  };

  // Map a filter chip → (type, media) query dims. `uploads` = the user's own inputs
  // (source=input); the media-type chips span all sources; `all` = everything.
  const fetchPage = async (pageNum: number) => {
    const { token, baseUrl } = getVappParams();
    // Always pull type=all — the tab chips filter CLIENT-SIDE (instant, no re-fetch).
    // DIRECT to the vApp server (no higgs proxy); Bearer auth; vApp serves CORS.
    const apiUrl = `${baseUrl}/vapp/user/media?type=all&media=all&page=${pageNum}&per_page=${PER_PAGE}`;

    const res = await fetch(apiUrl, { headers: vappAuth(token) });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);

    const data = await res.json();
    // Map raw vApp records → intermediate shape (field-mapping the higgs route used to do).
    const rawItems: any[] = (data.items || data.files || []).map(normalizeServerMedia);

    const items = (rawItems.map(toUploadItem).filter(Boolean) as any[])
      // newest first — created-first comparator (+ record_id tiebreak)
      .sort(cmpMedia);

    const totalPages = Number(data.totalPages || data.pages || 0);
    setHasMore(totalPages > 0 ? pageNum < totalPages : rawItems.length >= PER_PAGE);

    const keyOf = (u: any) => u?.metadata?.directUrl || u?.url;
    setUploads((prev: any[]) => {
      const locals = prev.filter((u: any) => !isVappItem(u));
      let vapp: any[];
      if (pageNum === 1) {
        vapp = items;
      } else {
        const existing = new Set(prev.filter((u: any) => isVappItem(u)).map(keyOf));
        const newItems = items.filter((i: any) => !existing.has(keyOf(i)));
        vapp = [...prev.filter((u: any) => isVappItem(u)), ...newItems];
      }
      // Always keep the whole vApp list globally sorted newest-first (fixes cross-page order).
      vapp.sort(cmpMedia);
      return [...locals, ...vapp];
    });
    setPage(pageNum);
    setFetchError(null);
  };

  // Silent background sync: pull page 1 and PREPEND only genuinely-new items
  // (dedup by stable R2 url) without a spinner and without dropping already-loaded
  // pages. So the cache shows instantly and fresh media appears on its own.
  const backgroundSync = async () => {
    try {
      const { token, baseUrl } = getVappParams();
      const res = await fetch(`${baseUrl}/vapp/user/media?type=all&media=all&page=1&per_page=${PER_PAGE}`, { headers: vappAuth(token) });
      if (!res.ok) return;
      const data = await res.json();
      const items = ((data.items || data.files || []) as any[])
        .map(normalizeServerMedia)
        .map(toUploadItem)
        .filter(Boolean) as any[];
      if (!items.length) return;
      const keyOf = (u: any) => u?.metadata?.directUrl || u?.url;
      setUploads((prev: any[]) => {
        const existing = new Set(prev.filter(isVappItem).map(keyOf));
        const fresh = items.filter((i) => !existing.has(keyOf(i)));
        const locals = prev.filter((u: any) => !isVappItem(u));
        const vapp = [...prev.filter(isVappItem), ...fresh];
        // Re-sort even when nothing is new — corrects a stale cached order on open.
        vapp.sort(cmpMedia);
        return [...locals, ...vapp];
      });
    } catch {}
  };

  // On mount: if we have a persisted cache, show it instantly and just sync new
  // media in the background. Only do a full (spinner) fetch when there's no cache.
  useEffect(() => {
    if (uploadsLoaded && uploads.filter((u: any) => isVappItem(u)).length > 0) {
      void backgroundSync();
      return;
    }
    setLoading(true);
    fetchPage(1)
      .then(() => setUploadsLoaded(true))
      .catch((err) => setFetchError(String(err?.message || "Failed to load media")))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const recentVappItems = uploads.filter((u: any) => isVappItem(u)).slice(0, PREWARM_LIMIT);
    recentVappItems.forEach((item: any) => {
      // Video thumbnails are lazy (VideoThumb + persistent poster cache) — NO heavy
      // per-video prewarm on mount (that loaded 20 full videos → slow). Only warm
      // cheap image dimensions.
      if (!isVideo(item) && !isAudio(item)) void ensureImageMeta(item);
    });
  }, [uploads]);

  // Cache-INDEPENDENT refresh: wipe every cached vApp item first, then pull page 1
  // fresh from the server. Guarantees real, re-sorted data (no stale cache order).
  const handleRefresh = async () => {
    setRefreshing(true);
    setFetchError(null);
    setUploadsLoaded(false);
    setPage(1);
    setHasMore(false);
    setUploads((prev: any[]) => prev.filter((u: any) => !isVappItem(u))); // drop cached vApp media
    try { await fetchPage(1); setUploadsLoaded(true); } catch (err: any) { setFetchError(String(err?.message || "Refresh failed")); }
    setRefreshing(false);
  };

  const handleLoadMore = async () => {
    setLoadingMore(true);
    try { await fetchPage(page + 1); } catch {}
    setLoadingMore(false);
  };

  // Switch media-type filter → wipe cached vApp items + fresh fetch page 1 for that type.
  // Tabs filter the ALREADY-loaded list CLIENT-SIDE — instant, no re-fetch (no loading
  // spinner on every switch, esp. on slower remote networks). The fetch always pulls
  // type=all; the chips just narrow what's shown.
  const changeFilter = (f: "all" | "image" | "video" | "audio" | "uploads") => {
    setMediaFilter(f);
  };

  const matchesFilter = (u: any): boolean => {
    switch (mediaFilter) {
      case "all": return true;
      case "video": return isVideo(u);
      case "audio": return isAudio(u);
      case "image": return !isVideo(u) && !isAudio(u);
      case "uploads": return !isVappItem(u) || String(u.source || u.metadata?.source || "").includes("input");
      default: return true;
    }
  };

  // Warm caches on hover so a subsequent click adds to the timeline instantly.
  // Video: just the poster (light) — dims come fast on click via fastVideoMeta.
  const prewarm = (item: any) => {
    if (isVideo(item)) {
      void capturePoster(getDisplaySrc(item));
      // Hover is the start of the drag gesture, so warm the length too — the poster path
      // returns instantly once cached and then learns nothing, which is how a dragged clip
      // ended up with the 10s placeholder. De-duped + cached, so at most one light
      // metadata read per file for the whole session.
      const psrc = getPlayerSrc(item);
      if (!mediaMetaCache.get(psrc)?.duration) void fastVideoMeta(psrc);
    }
    else if (isAudio(item)) void ensureAudioMeta(getPlayerSrc(item)); // warm duration → instant, reliable click-add
    else void ensureImageMeta(item);
  };

  const handleAdd = async (item: any) => {
    const mediaId = String(item.id || item.url);
    if (addingId === mediaId) return; // ignore rapid double/triple clicks on the same item
    setAddingId(mediaId);
    const src = getPlayerSrc(item);
    try {
      if (isAudio(item)) {
        // Resolve the duration FIRST (this is what paints the "adding" spinner during the
        // await, exactly like video/image) and warm the media cache so the state manager's
        // own audio load lands finite + fast. If even this robust probe can't get metadata,
        // the package's stricter loader would silently drop the clip — surface it instead.
        const meta = await ensureAudioMetaForAdd(src);
        if (!meta.duration) {
          toast.error("Couldn't load this audio — its metadata is unavailable. Please try again.");
          return; // spinner cleared by finally
        }
        const audioMeta: Record<string, any> = {};
        if (item.stt && typeof item.stt === "object") {
          audioMeta.transcriptData = item.stt;
          setTranscriptResult(src, item.stt);
        } else {
          // STT lookup direct from the vApp server (no higgs proxy).
          sttForUrl(src)
            .then((stt) => { if (stt?.segments?.length) setTranscriptResult(src, stt); })
            .catch(() => {});
        }
        dispatch(ADD_AUDIO, {
          // duration passed through for correctness/future-proofing (the current package
          // recomputes it, but the warmed cache makes that resolve instantly + finite).
          payload: { id: generateId(), type: "audio", duration: meta.duration, details: { src, name: getLabel(item) }, metadata: audioMeta },
          options: {},
        });
        return;
      }

      if (isVideo(item)) {
        // Use cached meta if warm (prewarm/hover); else a FAST metadata-only probe.
        // Never block on the heavy frame-capture — that runs in the background after.
        const cached = mediaMetaCache.get(src) || mediaMetaCache.get(getDisplaySrc(item));
        let duration = cached?.duration, width = cached?.width, height = cached?.height;
        if (!duration || !width || !height) {
          const fast = await fastVideoMeta(getDisplaySrc(item) || src);
          duration = duration || fast.duration || 10000;
          width = width || fast.width || 1920;
          height = height || fast.height || 1080;
        }
        // Prefer the server poster (meta.poster) — a plain URL the timeline shows with
        // zero client capture. Else reuse a cached frame; else capture one now so the
        // clip never renders solid black.
        let previewUrl = item.poster || posterCache.get(getDisplaySrc(item)) || posterCache.get(src) || cached?.previewUrl || "";
        if (!previewUrl) previewUrl = await capturePoster(getDisplaySrc(item));
        const videoMeta: Record<string, any> = { previewUrl };
        if (item.stt && typeof item.stt === "object") {
          videoMeta.transcriptData = item.stt;
          setTranscriptResult(src, item.stt);
        } else {
          // STT lookup direct from the vApp server (no higgs proxy).
          sttForUrl(src)
            .then((stt) => { if (stt?.segments?.length) setTranscriptResult(src, stt); })
            .catch(() => {});
        }
        dispatch(ADD_VIDEO, {
          payload: { id: generateId(), duration, details: { src, width, height, name: getLabel(item) }, metadata: videoMeta },
          options: { resourceId: "main", scaleMode: "fit" },
        });
        void capturePoster(getDisplaySrc(item)); // background: cache poster for later
        return;
      }

      // image
      const cachedImg = mediaMetaCache.get(getDisplaySrc(item));
      let width = cachedImg?.width || 1920, height = cachedImg?.height || 1080;
      if (!cachedImg?.width || !cachedImg?.height) {
        try {
          const meta = await ensureImageMeta(item);
          width = meta.width || 1920;
          height = meta.height || 1080;
        } catch {}
      }
      dispatch(ADD_IMAGE, {
        payload: { id: generateId(), type: "image", display: { from: 0, to: 5000 }, details: { src, width, height, name: getLabel(item) }, metadata: {} },
        options: {},
      });
    } finally {
      setAddingId(null);
    }
  };

  const allItems = uploads.filter(matchesFilter);
  const hasItems = allItems.length > 0 || pendingUploads.length > 0 || activeUploads.length > 0;

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      <ModalUpload />

      {/* Fixed top: upload button + status */}
      <div className="flex-none">
        <div className="p-4 flex gap-2">
          <Button className="flex-1 cursor-pointer" onClick={() => setShowUploadModal(true)} variant="outline">
            <UploadIcon className="w-4 h-4" />
            <span className="ml-2">Upload</span>
          </Button>
          <Button
            variant="outline"
            className="cursor-pointer px-3"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {/* Filter — All / Image / Video / Audio + Uploads (the user's own inputs) */}
        <div className="px-4 pb-2 flex flex-wrap gap-1.5">
          {(["all", "image", "video", "audio", "uploads"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => changeFilter(f)}
              className={`px-2.5 py-1 rounded-md text-xs capitalize transition ${
                mediaFilter === f
                  ? "bg-primary/20 text-primary ring-1 ring-primary/40"
                  : "bg-white/5 text-muted-foreground hover:text-foreground"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Error state */}
        {!loading && fetchError && (
          <div className="mx-4 mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{fetchError}</span>
          </div>
        )}

        {/* Active uploads progress */}
        {(pendingUploads.length > 0 || activeUploads.length > 0) && (
          <div className="px-4 pb-2">
            <div className="font-medium text-sm mb-2 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              Uploading…
            </div>
            {[...pendingUploads, ...activeUploads].map((u) => (
              <div key={u.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="truncate flex-1">{u.file?.name || "…"}</span>
                <span>{u.progress ?? 0}%</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Scrollable grid */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 min-h-0"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 150 && hasMore && !loadingMore)
            handleLoadMore();
        }}
      >
        {/* Loading state (also while a cache-independent refresh is in flight) */}
        {(loading || (refreshing && allItems.length === 0)) && (
          <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin" />
            <span className="text-xs">Loading media…</span>
          </div>
        )}

        {/* Empty state */}
        {!loading && !refreshing && !hasItems && !fetchError && (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
            <Upload size={32} className="opacity-50" />
            <span className="text-sm">No uploads yet</span>
          </div>
        )}

        {/* Media grid */}
        {!loading && allItems.length > 0 && (
          <div className="grid grid-cols-3 gap-2 pb-2">
            {allItems.map((item, idx) => (
              <TileErrorBoundary key={item.id || `item-${idx}`}>
                <UploadGridItem
                  item={item}
                  onAdd={handleAdd}
                  isActive={activePreviewId === String(item.id || item.url)}
                  setActivePreviewId={setActivePreviewId}
                  adding={addingId === String(item.id || item.url)}
                  onPrewarm={prewarm}
                />
              </TileErrorBoundary>
            ))}
          </div>
        )}
      </div>

      {/* Pinned Load More footer */}
      <div className="flex-none border-t border-border/40 px-4 py-2">
        <Button
          variant="outline"
          className="w-full"
          onClick={handleLoadMore}
          disabled={loadingMore || !hasMore}
        >
          {loadingMore ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          Load more
        </Button>
      </div>
    </div>
  );
};
