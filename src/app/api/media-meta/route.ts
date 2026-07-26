import { NextResponse } from "next/server";

// The generation PROMPT of a media url, from its vApp media record. Lets the AI-Edit arrange
// content-match EXISTING images (that this session didn't generate) to the narration. Thin proxy
// to vApp GET /vapp/media/meta. Fail-open: returns { ok:true, prompt:"" } on any error.
const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";

export async function GET(request: Request) {
  const u = new URL(request.url);
  const url = (u.searchParams.get("url") || "").trim();
  if (!url) return NextResponse.json({ ok: false, error: "url required" }, { status: 400 });
  const base = DEFAULT_VAPP_BASE.replace(/\/+$/, "");
  const token = (u.searchParams.get("token") || "").replace(/^Bearer\s+/i, "").trim();
  try {
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 12_000);
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let r: Response;
    try {
      r = await fetch(`${base}/vapp/media/meta?url=${encodeURIComponent(url)}`, { headers, cache: "no-store", signal: ctrl.signal });
    } finally {
      clearTimeout(kill);
    }
    const d = await r.json().catch(() => ({}));
    return NextResponse.json({ ok: true, prompt: String(d?.prompt || "").trim() });
  } catch {
    return NextResponse.json({ ok: true, prompt: "" }); // fail-open — arrange still works without it
  }
}
