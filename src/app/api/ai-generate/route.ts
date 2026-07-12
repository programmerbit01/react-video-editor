import { NextResponse } from "next/server";

// Editor-owned media generation (audio / image / video). Two steps so the client
// can run it in the BACKGROUND without blocking the chat:
//   POST  -> start the job, return { request_id } immediately
//   GET   -> long-poll vApp /vapp/wait_job/{id} (server-side wait, ~zero cost);
//            returns the final { output_url } or live { queue_position, progress }.
// Direct to vApp (Bearer token = GUI channel on start; wait needs no auth).
const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";

const MODEL_FOR: Record<string, string> = {
  audio: "vapp-fastest-tts",
  image: "vapp-image",
  video: "vapp-video",
};

// POST /api/ai-generate  body: { kind, text|prompt, aspect_ratio?, duration?, token? }
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const base = DEFAULT_VAPP_BASE.replace(/\/+$/, "");
    const token = String(body.token || "").replace(/^Bearer\s+/i, "").trim();
    const kind = String(body.kind || "audio");
    const model = MODEL_FOR[kind] || MODEL_FOR.audio;
    const prompt = String(body.prompt || body.text || "").trim();
    if (!prompt) return NextResponse.json({ error: "prompt/text is required" }, { status: 400 });

    let reqBody: Record<string, any>;
    if (kind === "image") {
      reqBody = {
        prompt,
        aspect_ratio: body.aspect_ratio || "16:9",
        resolution: "1k",
        ...(body.image_url ? { image_url: body.image_url } : {}), // img2img (regenerate)
      };
    } else if (kind === "video") {
      reqBody = { prompt, aspect_ratio: body.aspect_ratio || "16:9", duration: Math.min(20, Number(body.duration) || 5) };
    } else {
      reqBody = { prompt, model };
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const startRes = await fetch(`${base}/api/v1/${model}`, {
      method: "POST",
      headers,
      body: JSON.stringify(reqBody),
    });
    const txt = await startRes.text();
    let data: any = {};
    try {
      data = JSON.parse(txt);
    } catch {
      /* non-JSON */
    }
    if (!startRes.ok) {
      const msg = data?.error?.message || data?.detail || txt.slice(0, 200) || `start failed (${startRes.status})`;
      return NextResponse.json({ error: msg }, { status: startRes.status || 500 });
    }
    const requestId = String(data?.request_id || data?.id || data?.job_id || "").trim();
    if (!requestId) return NextResponse.json({ error: "no request_id: " + txt.slice(0, 150) }, { status: 500 });
    return NextResponse.json({ request_id: requestId });
  } catch (error) {
    console.error("[ai-generate:start]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// GET /api/ai-generate?id=<request_id>&timeout=35  -> long-poll (no auth needed)
export async function GET(request: Request) {
  const u = new URL(request.url);
  const id = u.searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const timeout = Math.min(40, Number(u.searchParams.get("timeout")) || 35);
  const base = DEFAULT_VAPP_BASE.replace(/\/+$/, "");
  try {
    const r = await fetch(`${base}/vapp/wait_job/${encodeURIComponent(id)}?timeout=${timeout}`, { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    const status = String(d?.status || "").toLowerCase();
    const output_url = d?.output_url || d?.video_url || "";
    return NextResponse.json({
      status,
      done: status === "completed" && !!output_url,
      failed: status === "failed" || status === "cancelled",
      output_url,
      queue_position: d?.queue_position ?? null,
      progress: d?.progress ?? null,
      error: d?.error || "",
    });
  } catch {
    // transient (server restarting) — tell client to keep waiting
    return NextResponse.json({ status: "error", done: false, failed: false }, { status: 200 });
  }
}
