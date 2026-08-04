import { NextRequest, NextResponse } from "next/server";

/**
 * Web / news / image search — Phase 1 (INDEPENDENT tab).
 *
 * THIN pass-through to the vApp's general search capability. The SearXNG
 * instance URL and the curation system-prompt live ONCE in the vApp config
 * (model_config.json → web_search) — the editor holds NO url/port/creds and just
 * reuses the lane, exactly like ai-edit / prompt-optimize.
 *
 *   editor  →  GET /api/websearch  →  vApp GET /vapp/websearch  →  { items, curation }
 *
 * Env: VAPP_SERVER_BASE (default http://127.0.0.1:8091) — same base as ai-generate.
 */

const VAPP_BASE = (process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091").replace(/\/+$/, "");

// GET /api/websearch?query=&type=news|web|images|videos&recency=day|week|month|any&per_page=24&curate=0|1
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = (searchParams.get("query") || "").trim();
  if (!query) return NextResponse.json({ items: [], curation: null });

  const type = (searchParams.get("type") || "news").toLowerCase();
  const recency = (searchParams.get("recency") || "").toLowerCase();
  const perPage = Math.min(Number(searchParams.get("per_page") || "24") || 24, 40);
  const curate = (searchParams.get("curate") || "").toLowerCase();

  const params = new URLSearchParams({ query, type, per_page: String(perPage) });
  if (recency) params.set("recency", recency);
  if (curate && curate !== "0" && curate !== "false") params.set("curate", "1");

  try {
    const res = await fetch(`${VAPP_BASE}/vapp/websearch?${params.toString()}`, {
      headers: { Accept: "application/json" },
      // Plain search is fast; curation adds one LLM hop, so keep the ceiling generous.
      signal: AbortSignal.timeout(75000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && (data.error || data.detail)) || `vApp ${res.status}`;
      return NextResponse.json({ items: [], curation: null, error: String(msg).slice(0, 300) });
    }
    return NextResponse.json({
      items: Array.isArray(data?.items) ? data.items : [],
      curation: data?.curation ?? null,
      ...(data?.error ? { error: String(data.error).slice(0, 300) } : {}),
    });
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message || String(e);
    return NextResponse.json({ items: [], curation: null, error: `Search failed: ${String(reason).slice(0, 200)}` });
  }
}
