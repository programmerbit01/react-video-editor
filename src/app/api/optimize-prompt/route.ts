import { NextResponse } from "next/server";

// Prompt optimiser → vApp POST /vapp/prompt/optimize (the SAME endpoint Image/Video Studio use).
// MULTIMODAL: when `media` (a reference image url) is passed, the optimiser model SEES the image and
// writes the prompt from what's actually in it — exactly what i2i-edit / i2v-animate prompts need.
// Body: { prompt (required), media_type?, media?, token? }. Fail-open (returns the original prompt).
const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const base = DEFAULT_VAPP_BASE.replace(/\/+$/, "");
    const token = String(body.token || "").replace(/^Bearer\s+/i, "").trim();
    const prompt = String(body.prompt ?? body.input ?? "").trim();
    if (!prompt) return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    const media = body.media ?? body.image_url ?? (Array.isArray(body.images) ? body.images : undefined);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) { headers["X-API-Key"] = token; headers.Authorization = `Bearer ${token}`; }
    const r = await fetch(`${base}/vapp/prompt/optimize`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt,
        media_type: String(body.media_type || "image"),
        ...(media ? { media } : {}),
        ...(token ? { api_key: token } : {}),
      }),
    });
    const d = await r.json().catch(() => ({}));
    // The vApp endpoint is fail-open: on any error it returns the original prompt.
    const optimized = String(d?.optimized_prompt || d?.prompt || prompt);
    return NextResponse.json({ optimized_prompt: optimized, changed: !!d?.changed, media_used: !!d?.media_used });
  } catch (error) {
    console.error("[optimize-prompt]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
