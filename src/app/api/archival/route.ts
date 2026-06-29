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

type MediaType = "image" | "video";

interface NormItem {
  id: string;
  type: MediaType;
  details: { src: string; width: number; height: number; duration?: number };
  preview: string;
  source_name: string;
  source_url: string;
  license: string;
  author: string;
  title: string;
}

const timeoutSignal = () => AbortSignal.timeout(12000);

// ── Adapters ────────────────────────────────────────────────────────────────

async function fromPexels(q: string, type: MediaType, n: number): Promise<NormItem[]> {
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
  if (type !== "image") return [];
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=${n}&mature=false`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: timeoutSignal() });
  if (!r.ok) throw new Error(`openverse ${r.status}`);
  const d = await r.json();
  return (d.results || []).map((x: any) => ({
    id: `openverse_${x.id}`,
    type: "image",
    details: { src: x.url, width: Number(x.width || 0), height: Number(x.height || 0) },
    preview: x.thumbnail || x.url,
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
  if (type !== "image") return [];
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
      if (!ii || !String(ii.mime || "").startsWith("image/")) return null;
      const m = ii.extmetadata || {};
      return {
        id: `wikimedia_${pg.pageid}`,
        type: "image",
        details: { src: ii.url, width: Number(ii.width || 0), height: Number(ii.height || 0) },
        preview: ii.thumburl || ii.url,
        source_name: "Wikimedia",
        source_url: ii.descriptionurl || "",
        license: clean(m.LicenseShortName?.value) || "see source",
        author: clean(m.Artist?.value) || clean(m.Credit?.value) || "Unknown",
        title: clean(m.ImageDescription?.value).slice(0, 200),
      } as NormItem;
    })
    .filter(Boolean) as NormItem[];
}

async function fromArchive(q: string, type: MediaType, n: number): Promise<NormItem[]> {
  if (type !== "image") return [];
  const url =
    `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q + " AND mediatype:image")}` +
    `&fl%5B%5D=identifier&fl%5B%5D=title&rows=${n}&output=json`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: timeoutSignal() });
  if (!r.ok) throw new Error(`archive ${r.status}`);
  const d = await r.json();
  return (d?.response?.docs || []).map((x: any) => {
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
  }) as NormItem[];
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
  const type = (searchParams.get("type") === "video" ? "video" : "image") as MediaType;
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

  const settled = await Promise.all(
    sources.map(async (name) => {
      try {
        let items = await ADAPTERS[name](query, type, perPage);
        if (minRes > 0) {
          items = items.filter(
            (it) => !it.details.width || !it.details.height || it.details.width >= minRes || it.details.height >= minRes
          );
        }
        by_source[name] = { count: items.length, ok: true };
        return items;
      } catch (e: any) {
        by_source[name] = { count: 0, ok: false, error: String(e?.message || e) };
        return [] as NormItem[];
      }
    })
  );

  // Interleave results so the grid isn't dominated by one source.
  const lists = settled;
  const merged: NormItem[] = [];
  let i = 0;
  while (lists.some((l) => i < l.length)) {
    for (const l of lists) if (i < l.length) merged.push(l[i]);
    i++;
  }

  return NextResponse.json({ items: merged, by_source });
}
