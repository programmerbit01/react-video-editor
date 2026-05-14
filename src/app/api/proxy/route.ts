import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { mkdir, readFile, writeFile, stat } from "fs/promises";
import path from "path";

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

  // Skip disk cache for range requests (partial content)
  if (!rangeHeader) {
    const cached = await getCached(url);
    if (cached) {
      return new NextResponse(cached.data, {
        status: 200,
        headers: {
          ...CORS,
          "Content-Type": cached.contentType,
          "Cache-Control": "public, max-age=604800",
          "X-Cache": "HIT",
        },
      });
    }
  }

  try {
    const upstream = await fetch(url, {
      headers: rangeHeader ? { Range: rangeHeader } : {},
    });

    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json({ error: `upstream ${upstream.status}` }, { status: 502 });
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const body = Buffer.from(await upstream.arrayBuffer());

    // Cache full responses only
    if (!rangeHeader && upstream.status === 200) {
      putCache(url, body, contentType).catch(() => {});
    }

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

    return new NextResponse(body, { status: upstream.status, headers });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
