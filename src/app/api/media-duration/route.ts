import { NextResponse } from "next/server";

// Playable duration (seconds) of a media url via the vApp's server-side ffprobe (GET /vapp/media/duration).
// Lets the editor add a voiceover/audio with a KNOWN duration instead of relying on the browser's
// `new Audio().load()` — which stalls or FAILS on a slow/remote CDN, dropping the clip ("no voiceover
// on the timeline"). Fail-open: returns { ok:false, duration_seconds:null } so the caller falls back.
const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url).searchParams.get("url") || "";
    if (!url) return NextResponse.json({ ok: false, duration_seconds: null });
    const base = DEFAULT_VAPP_BASE.replace(/\/+$/, "");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`${base}/vapp/media/duration?url=${encodeURIComponent(url)}`, { cache: "no-store", signal: ctrl.signal }).catch(() => null);
    clearTimeout(t);
    const d = r ? await r.json().catch(() => ({})) : {};
    return NextResponse.json({ ok: !!d?.ok, duration_seconds: d?.duration_seconds ?? null });
  } catch {
    return NextResponse.json({ ok: false, duration_seconds: null });
  }
}
