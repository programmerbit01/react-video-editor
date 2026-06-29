import { NextRequest, NextResponse } from "next/server";

/**
 * Multi-source media search — query several stock/archival platforms at once,
 * each result tagged with its origin + license + attribution.
 *
 * Sources are independent adapters; a failing/blocked one is skipped gracefully
 * (returns 0, never breaks the whole search) so you can see which platforms work.
 *
 * Query params:
 *   query     required search text
 *   type      "image" | "video"  (default image)
 *   sources   csv, e.g. "pexels,openverse,wikimedia,archive" (default pexels,openverse)
 *   per_page  results PER SOURCE (default 20, max 40)
 *
 * Response:
 *   { items: NormItem[], by_source: { [name]: { count, ok, error? } } }
 */

const PEXELS_API_KEY =
  process.env.PEXELS_API_KEY ||
  "ZmExlHQM4iFJUHDEFLJyUDQdw4GNQcbnfohuO5zximnpw9l2VDKKD76P";
const UA = "VappMediaSearch/1.0 (documentary editor)";

type MediaType = "image" | "video" | "sound";

interface NormItem {
  id: string;
  type: "image" | "video" | "audio"; // editor-canonical item type (sound → audio)
  details: { src: string; width: number; height: number; duration?: number };
  preview: string;
  source_name: string;
  source_url: string;
  license: string;
  author: string;
  title: string;
}

const timeoutSignal = () => AbortSignal.timeout(12000);

// Verbose queries kill recall on archival APIs (e.g. "Mikhail Kalashnikov portrait
// historical" → 0, but "Mikhail Kalashnikov" → many). Strip style/filler words and,
// as a last resort, fall back to the first couple of meaningful words.
const FILLER = new Set([
  "historical", "history", "portrait", "portraits", "photo", "photos", "photograph",
  "photographs", "image", "images", "picture", "pictures", "footage", "archival",
  "archive", "vintage", "old", "retro", "classic", "monochrome", "bw", "hd", "4k",
  "uhd", "stock", "clip", "clips", "scene", "scenes", "shot", "shots", "closeup",
  "cinematic", "documentary", "of", "the", "a", "an", "in", "on", "at", "for",
  "and", "with", "to",
]);

function meaningfulWords(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter((w) => w && !FILLER.has(w));
}

// Candidate queries to try in order, stopping at the first that returns results.
function queryCandidates(q: string): string[] {
  const orig = q.trim();
  const words = meaningfulWords(orig);
  const simplified = words.join(" ");
  const core = words.slice(0, 2).join(" ");
  const out: string[] = [];
  for (const c of [orig, simplified, core]) {
    const v = c.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

// ── Adapters ────────────────────────────────────────────────────────────────

async function fromPexels(q: string, type: MediaType, n: number): Promise<NormItem[]> {
  if (type === "sound") return []; // Pexels has no audio API
  const headers = { Authorization: PEXELS_API_KEY, "User-Agent": UA };
  if (type === "video") {
    const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&per_page=${n}`;
    const r = await fetch(url, { headers, signal: timeoutSignal() });
    if (!r.ok) throw new Error(`pexels ${r.status}`);
    const d = await r.json();
    return (d.videos || []).map((v: any) => {
      const file =
        (v.video_files || []).find((f: any) => f.quality === "hd" || f.quality === "sd") ||
        v.video_files?.[0];
      return {
        id: `pexels_v_${v.id}`,
        type: "video",
        details: { src: file?.link || "", width: v.width, height: v.height, duration: v.duration },
        preview: v.image || v.video_pictures?.[0]?.picture || "",
        source_name: "Pexels",
        source_url: v.url || "",
        license: "Pexels License (free)",
        author: v.user?.name || "Unknown",
        title: "",
      } as NormItem;
    });
  }
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=${n}`;
  const r = await fetch(url, { headers, signal: timeoutSignal() });
  if (!r.ok) throw new Error(`pexels ${r.status}`);
  const d = await r.json();
  return (d.photos || []).map((p: any) => ({
    id: `pexels_i_${p.id}`,
    type: "image",
    details: { src: p.src?.large2x || p.src?.large || p.src?.original || "", width: p.width, height: p.height },
    preview: p.src?.medium || p.src?.small || p.src?.large || "",
    source_name: "Pexels",
    source_url: p.url || "",
    license: "Pexels License (free)",
    author: p.photographer || "Unknown",
    title: p.alt || "",
  })) as NormItem[];
}

async function fromOpenverse(q: string, type: MediaType, n: number): Promise<NormItem[]> {
  if (type === "video") return []; // Openverse has no video
  const kind = type === "sound" ? "audio" : "images";
  const url = `https://api.openverse.org/v1/${kind}/?q=${encodeURIComponent(q)}&page_size=${n}&mature=false`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: timeoutSignal() });
  if (!r.ok) throw new Error(`openverse ${r.status}`);
  const d = await r.json();
  return (d.results || []).map((x: any) => ({
    id: `openverse_${x.id}`,
    type: type === "sound" ? "audio" : "image",
    details: {
      src: x.url,
      width: Number(x.width || 0),
      height: Number(x.height || 0),
      ...(type === "sound" ? { duration: Math.round(Number(x.duration || 0) / 1000) } : {}),
    },
    preview: x.thumbnail || "",
    source_name: "Openverse",
    source_url: x.foreign_landing_url || x.url || "",
    license: `${x.license || ""} ${x.license_version || ""}`.toUpperCase().trim() || "see source",
    author: x.creator || "Unknown",
    title: String(x.title || "").slice(0, 200),
  })) as NormItem[];
}

const clean = (h?: string) =>
  (h || "").replace(/<[^>]*>/g, " ").replace(/&[a-z]+;|&#\d+;/g, " ").replace(/\s+/g, " ").trim();

async function fromWikimedia(q: string, type: MediaType, n: number): Promise<NormItem[]> {
  // Wikimedia Commons has images, video AND audio — filter by mime.
  const mimePrefix = type === "video" ? "video/" : type === "sound" ? "audio/" : "image/";
  const params = new URLSearchParams({
    action: "query", format: "json", generator: "search", gsrsearch: q,
    gsrnamespace: "6", gsrlimit: String(n), prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata", iiurlwidth: "480",
  });
  const r = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: { "User-Agent": UA, Accept: "application/json" }, signal: timeoutSignal(),
  });
  if (!r.ok) throw new Error(`wikimedia ${r.status}`);
  const d = await r.json();
  const pages = d?.query?.pages ? Object.values<any>(d.query.pages) : [];
  return pages
    .map((pg: any) => {
      const ii = pg?.imageinfo?.[0];
      if (!ii || !String(ii.mime || "").startsWith(mimePrefix)) return null;
      const m = ii.extmetadata || {};
      return {
        id: `wikimedia_${pg.pageid}`,
        type: type === "video" ? "video" : type === "sound" ? "audio" : "image",
        details: { src: ii.url, width: Number(ii.width || 0), height: Number(ii.height || 0) },
        preview: ii.thumburl || (type === "image" ? ii.url : ""),
        source_name: "Wikimedia",
        source_url: ii.descriptionurl || "",
        license: clean(m.LicenseShortName?.value) || "see source",
        author: clean(m.Artist?.value) || clean(m.Credit?.value) || "Unknown",
        title: clean(m.ImageDescription?.value).slice(0, 200),
      } as NormItem;
    })
    .filter(Boolean) as NormItem[];
}

// Find a directly-playable file URL inside an Internet Archive item (video/audio).
// Matches by file extension OR the IA `format` field (more reliable).
async function iaFileUrl(identifier: string, exts: string[], fmtKeys: string[]): Promise<string> {
  try {
    const r = await fetch(`https://archive.org/metadata/${identifier}`, {
      headers: { "User-Agent": UA, Accept: "application/json" }, signal: timeoutSignal(),
    });
    if (!r.ok) return "";
    const d = await r.json();
    const files: any[] = Array.isArray(d?.files) ? d.files : [];
    // Pass 1: extension match (in priority order, e.g. mp4 before ogv).
    for (const ext of exts) {
      const f = files.find((f) => String(f?.name || "").toLowerCase().endsWith(ext));
      if (f) return `https://archive.org/download/${identifier}/${encodeURIComponent(f.name)}`;
    }
    // Pass 2: format-field match (h.264 / MPEG4 / VBR MP3 / Ogg ...).
    const f2 = files.find((f) => {
      const fmt = String(f?.format || "").toLowerCase();
      return fmtKeys.some((k) => fmt.includes(k));
    });
    if (f2) return `https://archive.org/download/${identifier}/${encodeURIComponent(f2.name)}`;
  } catch {
    /* skip */
  }
  return "";
}

async function fromArchive(q: string, type: MediaType, n: number): Promise<NormItem[]> {
  const mediatype = type === "video" ? "movies" : type === "sound" ? "audio" : "image";
  // AV items need a per-item metadata lookup for a real file, so keep that smaller.
  const rows = type === "image" ? n : Math.min(n, 12);
  const url =
    `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q + ` AND mediatype:${mediatype}`)}` +
    `&fl%5B%5D=identifier&fl%5B%5D=title&rows=${rows}&output=json`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: timeoutSignal() });
  if (!r.ok) throw new Error(`archive ${r.status}`);
  const d = await r.json();
  const docs: any[] = d?.response?.docs || [];

  if (type === "image") {
    return docs.map((x) => {
      const img = `https://archive.org/services/img/${x.identifier}`;
      return {
        id: `archive_${x.identifier}`,
        type: "image",
        details: { src: img, width: 0, height: 0 },
        preview: img,
        source_name: "Internet Archive",
        source_url: `https://archive.org/details/${x.identifier}`,
        license: "Internet Archive (varies)",
        author: "Internet Archive",
        title: String(x.title || "").slice(0, 200),
      } as NormItem;
    });
  }

  const exts = type === "video" ? [".mp4", ".m4v", ".webm", ".ogv"] : [".mp3", ".ogg", ".m4a", ".flac", ".wav"];
  const fmtKeys = type === "video"
    ? ["mp4", "mpeg4", "h.264", "h264", "ogg video", "webm"]
    : ["mp3", "ogg", "flac", "wav", "m4a"];
  const resolved = await Promise.all(
    docs.map(async (x) => {
      const src = await iaFileUrl(x.identifier, exts, fmtKeys);
      if (!src) return null;
      return {
        id: `archive_${x.identifier}`,
        type: type === "video" ? "video" : "audio",
        details: { src, width: 0, height: 0 },
        preview: `https://archive.org/services/img/${x.identifier}`,
        source_name: "Internet Archive",
        source_url: `https://archive.org/details/${x.identifier}`,
        license: "Internet Archive (varies)",
        author: "Internet Archive",
        title: String(x.title || "").slice(0, 200),
      } as NormItem;
    })
  );
  return resolved.filter(Boolean) as NormItem[];
}

const ADAPTERS: Record<string, (q: string, t: MediaType, n: number) => Promise<NormItem[]>> = {
  pexels: fromPexels,
  openverse: fromOpenverse,
  wikimedia: fromWikimedia,
  archive: fromArchive,
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = (searchParams.get("query") || "").trim();
  const rawType = searchParams.get("type") || "image";
  const type = (["video", "sound"].includes(rawType) ? rawType : "image") as MediaType;
  const perPage = Math.min(Number(searchParams.get("per_page") || "20") || 20, 40);
  const sources = (searchParams.get("sources") || "pexels,openverse")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ADAPTERS[s]);

  if (!query || sources.length === 0) {
    return NextResponse.json({ items: [], by_source: {} });
  }

  const minRes = Number(searchParams.get("min_resolution") || "0") || 0;
  const by_source: Record<string, { count: number; ok: boolean; error?: string }> = {};

  const candidates = queryCandidates(query);

  const settled = await Promise.all(
    sources.map(async (name) => {
      try {
        // Try full query, then progressively simpler ones, until one returns hits.
        let items: NormItem[] = [];
        for (const cq of candidates) {
          items = await ADAPTERS[name](cq, type, perPage);
          if (items.length) break;
        }
        if (minRes > 0) {
          items = items.filter(
            (it) => !it.details.width || !it.details.height || it.details.width >= minRes || it.details.height >= minRes
          );
        }
        by_source[name] = { count: items.length, ok: true };
        return items;
      } catch (e: any) {
        // undici wraps the real reason in e.cause (e.g. connect timeout / DNS).
        const reason =
          e?.cause?.code || e?.cause?.message || e?.message || String(e);
        by_source[name] = { count: 0, ok: false, error: String(reason) };
        return [] as NormItem[];
      }
    })
  );

  // Merge in source-priority order, then RE-RANK by relevance: results whose
  // title/author actually contain the query words come first, with a small bonus
  // for higher resolution. Ties keep source-priority order (stable sort).
  const flat: NormItem[] = settled.flat();
  const qTokens = meaningfulWords(query);

  const ARCHIVAL = new Set(["Openverse", "Wikimedia", "Internet Archive"]);
  const scoreItem = (it: NormItem): number => {
    const hay = `${it.title || ""} ${it.author || ""} ${it.source_name || ""}`.toLowerCase();
    let s = 0;
    for (const t of qTokens) if (t.length > 2 && hay.includes(t)) s += 2;
    const px = (it.details.width || 0) * (it.details.height || 0);
    if (px >= 1920 * 1080) s += 1; // prefer full-HD+ assets
    // Nudge authentic archival above modern stock when relevance is similar
    // (good for documentaries). Pexels still wins when it's clearly more relevant.
    if (ARCHIVAL.has(it.source_name)) s += 1;
    return s;
  };

  const merged = qTokens.length
    ? flat
        .map((it, i) => ({ it, i, s: scoreItem(it) }))
        .sort((a, b) => b.s - a.s || a.i - b.i) // score desc, then original order
        .map((x) => x.it)
    : flat;

  return NextResponse.json({ items: merged, by_source });
}
