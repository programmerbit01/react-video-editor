import { NextRequest, NextResponse } from "next/server";

/**
 * Web / news / image search — Phase 1 (INDEPENDENT tab).
 *
 * A general SEARCH CAPABILITY backed by a self-hosted SearXNG instance. This
 * server-side route calls SearXNG's JSON API directly — SearXNG needs NO API key
 * (just an instance URL), so there are no provider creds to hide and no reason to
 * route through the vApp/Dify lane.
 *
 *   editor  →  GET /api/websearch  →  SearXNG /search?format=json  →  normalized grid
 *
 * Nothing about *which sources* is hardcoded here. type/recency map to plain
 * SearXNG params (categories/time_range); to narrow to a source just type
 * `site:openai.com` (or `arxiv.org`, a paper title, …) right in the query — the
 * user drives the filters, the engine stays generic.
 *
 * Env:
 *   SEARXNG_BASE   SearXNG instance (default http://192.168.50.123:8080)
 */

const SEARXNG_BASE = (process.env.SEARXNG_BASE || "http://192.168.50.123:8080").replace(/\/+$/, "");

interface WebItem {
  id: string;
  type: "image" | "video";
  details: { src: string; width: number; height: number; duration?: number };
  preview: string;
  source_name: string;
  source_url: string;
  title: string;
  snippet: string;
}

const str = (v: any) => (typeof v === "string" ? v : v == null ? "" : String(v));
// SearXNG wraps matched query terms in private-use chars (U+E000/U+E001) — strip them.
const clean = (v: any) => str(v).replace(/[]/g, "").trim();

// News → news, Web → general, Images → images. Add `science` later for papers.
const CATEGORY: Record<string, string> = { news: "news", web: "general", images: "images" };
const TIME_RANGE = new Set(["day", "week", "month", "year"]);

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
const faviconOf = (u: string) => {
  const h = hostOf(u);
  return h ? `https://www.google.com/s2/favicons?sz=128&domain=${h}` : "";
};

function normalize(results: any[], perPage: number): WebItem[] {
  const withImg: WebItem[] = [];
  const noImg: WebItem[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i] || {};
    const page = str(r.url);
    const image = str(r.img_src || r.thumbnail_src || r.thumbnail).trim();
    const preview = image || faviconOf(page); // real image, else the source's favicon
    if (!preview) continue;
    const src = image || preview;
    const isVideo = /\.(mp4|webm|mov|m4v)(\?|$)/i.test(src);
    // SearXNG image results carry a "1200×675" resolution string.
    let width = 0;
    let height = 0;
    const m = str(r.resolution).match(/(\d+)\s*[x×]\s*(\d+)/);
    if (m) {
      width = Number(m[1]) || 0;
      height = Number(m[2]) || 0;
    }
    const item: WebItem = {
      id: `web_${i}_${src.slice(-24)}`,
      type: isVideo ? "video" : "image",
      details: { src, width, height },
      preview,
      source_name: clean(r.source) || hostOf(page) || "Web",
      source_url: page,
      title: clean(r.title).slice(0, 200),
      snippet: clean(r.content).slice(0, 400),
    };
    (image ? withImg : noImg).push(item); // real images first, then favicon-only text hits
  }
  return withImg.concat(noImg).slice(0, perPage);
}

// GET /api/websearch?query=&type=news|web|images&recency=day|week|month|any&per_page=24
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = (searchParams.get("query") || "").trim();
  const type = (searchParams.get("type") || "news").toLowerCase();
  const recency = (searchParams.get("recency") || "").toLowerCase();
  const perPage = Math.min(Number(searchParams.get("per_page") || "24") || 24, 40);

  if (!query) return NextResponse.json({ items: [] });

  const params = new URLSearchParams({
    q: query,
    format: "json",
    safesearch: "0",
    categories: CATEGORY[type] || "general",
  });
  if (TIME_RANGE.has(recency)) params.set("time_range", recency);

  try {
    const res = await fetch(`${SEARXNG_BASE}/search?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      let msg = `SearXNG ${res.status}`;
      if (res.status === 403)
        msg = "SearXNG rejected the request — check search.formats has `json` and server.limiter is false.";
      if (res.status === 404) msg = `SearXNG search endpoint not found at ${SEARXNG_BASE}.`;
      return NextResponse.json({ items: [], error: msg });
    }
    const data = await res.json().catch(() => ({}));
    const items = normalize(Array.isArray(data?.results) ? data.results : [], perPage);
    return NextResponse.json({ items });
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message || String(e);
    return NextResponse.json({ items: [], error: `Search failed: ${str(reason).slice(0, 200)}` });
  }
}
