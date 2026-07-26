import { NextResponse } from "next/server";

// Context-aware shot TIMING for the AI-Edit arrange. Thin proxy to vApp
// /vapp/beat_plan, which REUSES VidRush's proven transcribe → beat_plan chain
// SERVER-SIDE (reliable) — so the editor never transcribes/even-spreads on the
// client (that path was fragile / hung). Given the voiceover URL and the number
// of shots N, returns N contiguous, speech-aligned beat windows.
//   POST body: { audio_url, shots?, token? }
//   -> { ok, total_ms, segments, beats:[{from_ms,to_ms,keyword}] }
const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const base = DEFAULT_VAPP_BASE.replace(/\/+$/, "");
    const token = String(body.token || "").replace(/^Bearer\s+/i, "").trim();
    const audio_url = String(body.audio_url || "").trim();
    if (!audio_url) return NextResponse.json({ ok: false, error: "audio_url is required" }, { status: 400 });
    const shots = Math.max(0, Math.floor(Number(body.shots) || 0));

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    // beat_plan transcribes + LLM-plans on the server; give it a generous cap.
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 160_000);
    let r: Response;
    try {
      r = await fetch(`${base}/vapp/beat_plan`, {
        method: "POST",
        headers,
        body: JSON.stringify({ audio_url, shots }),
        cache: "no-store",
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(kill);
    }
    const txt = await r.text();
    let data: any = {};
    try {
      data = JSON.parse(txt);
    } catch {
      /* non-JSON */
    }
    if (!r.ok || data?.ok === false) {
      const msg = data?.error || txt.slice(0, 200) || `beat_plan failed (${r.status})`;
      return NextResponse.json({ ok: false, error: msg }, { status: r.status || 500 });
    }
    return NextResponse.json({
      ok: true,
      total_ms: Number(data?.total_ms) || 0,
      segments: Number(data?.segments) || 0,
      beats: Array.isArray(data?.beats) ? data.beats : [],
    });
  } catch (error: any) {
    const msg = error?.name === "AbortError" ? "beat_plan timed out" : "Internal server error";
    console.error("[beat-plan]", error);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
