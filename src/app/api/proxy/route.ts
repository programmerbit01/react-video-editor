import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal CORS + Range passthrough proxy.
//
// Assets should be loaded DIRECT (R2 serves CORS `*`) — that's fast and parallel.
// This proxy is only a fallback for the legacy Garage host (no CORS preflight);
// see toDirectMediaSrc in navbar.tsx, which routes ONLY that host here. Kept
// deliberately thin (stream-only, no disk cache) — nothing hot depends on it.
// ─────────────────────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function HEAD(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url");
  if (!url) return new NextResponse(null, { status: 400 });
  try {
    const upstream = await fetch(url, { method: "HEAD" });
    return new NextResponse(null, {
      status: upstream.status,
      headers: {
        ...CORS,
        "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
        "Content-Length": upstream.headers.get("content-length") || "",
        "Accept-Ranges": "bytes",
      },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

  const rangeHeader = request.headers.get("range");
  try {
    const upstream = await fetch(url, { headers: rangeHeader ? { Range: rangeHeader } : {} });
    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json({ error: `upstream ${upstream.status}` }, { status: 502 });
    }

    const headers: Record<string, string> = {
      ...CORS,
      "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
      "Cache-Control": "public, max-age=604800",
      "Accept-Ranges": "bytes",
    };
    const cr = upstream.headers.get("content-range");
    if (cr) headers["Content-Range"] = cr;
    const cl = upstream.headers.get("content-length");
    if (cl) headers["Content-Length"] = cl;

    if (!upstream.body) {
      return NextResponse.json({ error: "upstream body empty" }, { status: 502 });
    }
    return new NextResponse(Readable.fromWeb(upstream.body as any) as any, {
      status: upstream.status,
      headers,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
