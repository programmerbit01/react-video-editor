import { NextResponse } from "next/server";

// GET /api/media-poster?url=<video url> → a single-frame JPEG poster for a video, proxied from the
// vApp (which extracts it with ffmpeg and caches it). Used as the <video poster> in the chat previews
// so a thumbnail shows without downloading the whole clip.
const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";

export async function GET(request: Request) {
  const u = new URL(request.url);
  const url = u.searchParams.get("url") || "";
  if (!url) return new NextResponse(null, { status: 400 });
  const base = DEFAULT_VAPP_BASE.replace(/\/+$/, "");
  try {
    const r = await fetch(`${base}/vapp/media/poster?url=${encodeURIComponent(url)}`, { cache: "no-store" });
    if (!r.ok) return new NextResponse(null, { status: r.status });
    const buf = await r.arrayBuffer();
    return new NextResponse(buf, {
      headers: {
        "Content-Type": r.headers.get("content-type") || "image/jpeg",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
