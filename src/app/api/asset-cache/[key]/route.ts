import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "fs";
import { Readable } from "stream";
import { cacheFilePath, cachedSize, contentTypeFor, originUrl, prefetch } from "@/utils/asset-cache-store";

// Serves a locally-cached asset (populated by the render's Localize stage) with byte-
// range support, so Remotion's OffthreadVideo seeks read from local disk — fast, no
// network. Byte-exact: video breaks on any range error, so this mirrors HTTP Range.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  // Guard against path traversal — key is a flat sha1+ext filename.
  if (!key || key.includes("/") || key.includes("..")) return new NextResponse(null, { status: 400 });

  const size = await cachedSize(key);

  // Cache-through: not warm yet → stream from R2 for THIS request and kick a background
  // download so the next seek is local. Lets the render start immediately while the
  // prefetch warms the cache in parallel (no hard stall on a not-yet-localized asset).
  if (size == null) {
    const url = await originUrl(key);
    if (!url) return new NextResponse(null, { status: 404 });
    void prefetch(url); // fire-and-forget: populate cache in the background
    const range = _req.headers.get("range");
    try {
      const upstream = await fetch(url, { headers: range ? { Range: range } : {} });
      if (!upstream.ok && upstream.status !== 206) {
        return NextResponse.json({ error: `upstream ${upstream.status}` }, { status: 502 });
      }
      const h: Record<string, string> = {
        ...CORS,
        "Content-Type": upstream.headers.get("content-type") || contentTypeFor(key),
        "Accept-Ranges": "bytes",
        "X-Cache": "MISS",
      };
      const cr = upstream.headers.get("content-range");
      if (cr) h["Content-Range"] = cr;
      const cl = upstream.headers.get("content-length");
      if (cl) h["Content-Length"] = cl;
      if (!upstream.body) return NextResponse.json({ error: "empty upstream" }, { status: 502 });
      return new NextResponse(Readable.fromWeb(upstream.body as any) as any, { status: upstream.status, headers: h });
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 502 });
    }
  }

  const file = cacheFilePath(key);
  const contentType = contentTypeFor(key);
  const base: Record<string, string> = {
    ...CORS,
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=604800",
    "X-Cache": "HIT",
  };

  const range = _req.headers.get("range");
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = 0;
    let end = size - 1;
    if (m) {
      if (m[1] === "" && m[2] !== "") start = Math.max(0, size - Number(m[2]));
      else { start = m[1] ? Number(m[1]) : 0; end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return new NextResponse(null, { status: 416, headers: { ...CORS, "Content-Range": `bytes */${size}` } });
    }
    return new NextResponse(createReadStream(file, { start, end }) as any, {
      status: 206,
      headers: { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }

  return new NextResponse(createReadStream(file) as any, {
    status: 200,
    headers: { ...base, "Content-Length": String(size) },
  });
}
