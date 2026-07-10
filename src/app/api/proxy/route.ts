import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { mkdir, readFile, writeFile, stat } from "fs/promises";
import path from "path";
import { Readable } from "stream";

const CACHE_DIR = path.join(process.cwd(), ".proxy-cache");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};

function cacheKey(url: string) {
  return createHash("sha1").update(url).digest("hex");
}

async function getCached(url: string): Promise<{ data: Buffer; contentType: string } | null> {
  const key = cacheKey(url);
  const dataFile = path.join(CACHE_DIR, key);
  const metaFile = path.join(CACHE_DIR, `${key}.meta`);
  try {
    const s = await stat(dataFile);
    if (Date.now() - s.mtimeMs > CACHE_TTL_MS) return null;
    const [data, meta] = await Promise.all([readFile(dataFile), readFile(metaFile, "utf8")]);
    return { data, contentType: meta };
  } catch {
    return null;
  }
}

async function putCache(url: string, data: Buffer, contentType: string) {
  await mkdir(CACHE_DIR, { recursive: true });
  const key = cacheKey(url);
  await Promise.all([
    writeFile(path.join(CACHE_DIR, key), data),
    writeFile(path.join(CACHE_DIR, `${key}.meta`), contentType),
  ]);
}

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
  // Disk caching disabled — stream-only proxy (CORS + Range passthrough). This route
  // exists ONLY so Remotion/timeline CORS-strict fetch() works (the R2/garage host
  // 403s the CORS preflight). No disk bloat (.proxy-cache).

  try {
    const upstream = await fetch(url, {
      headers: rangeHeader ? { Range: rangeHeader } : {},
    });

    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json({ error: `upstream ${upstream.status}` }, { status: 502 });
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const contentLength = upstream.headers.get("content-length");
    const shouldBufferForCache = false; // stream-only, no disk cache

    const headers: Record<string, string> = {
      ...CORS,
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=604800",
      "Accept-Ranges": "bytes",
      "X-Cache": "MISS",
    };
    if (upstream.headers.get("content-range")) {
      headers["Content-Range"] = upstream.headers.get("content-range")!;
    }
    if (contentLength) {
      headers["Content-Length"] = contentLength;
    }

    if (shouldBufferForCache) {
      const body = Buffer.from(await upstream.arrayBuffer());
      putCache(url, body, contentType).catch(() => {});
      return new NextResponse(body, { status: upstream.status, headers });
    }

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
