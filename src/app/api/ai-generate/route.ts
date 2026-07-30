import { NextResponse } from "next/server";

// Editor-owned media generation (audio / image / video). Two steps so the client
// can run it in the BACKGROUND without blocking the chat:
//   POST  -> start the job, return { request_id } immediately
//   GET   -> long-poll vApp /vapp/wait_job/{id} (server-side wait, ~zero cost);
//            returns the final { output_url } or live { queue_position, progress }.
// Direct to vApp (Bearer token = GUI channel on start; wait needs no auth).
const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";

const MODEL_FOR: Record<string, string> = {
  audio: "eleven-multilingual-v2",   // the current + only TTS model for all audio
  image: "vapp-image",
  video: "vapp-video",
};

// Before generating an IMAGE/VIDEO, rewrite the user's raw idea into a model-friendly prompt
// via the unified LLM service (POST /vapp/llm task=optimize_image|optimize_video) — one config
// row owns the optimizer, not the editor. Fail-open: on any error /vapp/llm returns the original
// input, so the raw prompt is always used as-is. Set AI_GENERATE_OPTIMIZE=0 to disable.
// (Audio is spoken verbatim, and img2img/regenerate edit-instructions are NOT optimized.)
const OPTIMIZE_GEN = (process.env.AI_GENERATE_OPTIMIZE ?? "1") !== "0";

async function optimizePrompt(base: string, token: string, kind: string, prompt: string): Promise<string> {
  try {
    const task = kind === "video" ? "optimize_video" : "optimize_image";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["X-API-Key"] = token;
    const r = await fetch(`${base}/vapp/llm`, {
      method: "POST",
      headers,
      body: JSON.stringify({ task, input: prompt, ...(token ? { api_key: token } : {}) }),
    });
    const d = await r.json().catch(() => ({}));
    const out = String(d?.text || "").trim().replace(/^["'`]+|["'`]+$/g, "");
    return out.length >= 3 ? out : prompt; // fail-open → original prompt
  } catch {
    return prompt;
  }
}

// POST /api/ai-generate  body: { kind, text|prompt, aspect_ratio?, duration?, token? }
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const base = DEFAULT_VAPP_BASE.replace(/\/+$/, "");
    const token = String(body.token || "").replace(/^Bearer\s+/i, "").trim();
    const kind = String(body.kind || "audio");
    // Reference image(s) → route to the EDIT model (Flux Klein edit) which KEEPS the subject's
    // identity (character consistency). Flux takes SEVERAL refs, so accept an images[] array too
    // (forwarded as images_list, the field vApp/wan2gp already consolidates); a plain text→image
    // stays on the base model.
    const images: string[] = Array.isArray(body.images) ? body.images.filter((u: any) => typeof u === "string" && u.trim()) : [];
    const hasRef = kind === "image" && (images.length > 0 || !!body.image_url);
    const model = hasRef ? "vapp-image-edit" : (MODEL_FOR[kind] || MODEL_FOR.audio);
    const prompt = String(body.prompt || body.text || "").trim();
    if (!prompt) return NextResponse.json({ error: "prompt/text is required" }, { status: 400 });

    // Optimize text-to-image/video prompts through /vapp/llm (skip audio = verbatim, and
    // img2img/regenerate = an edit instruction, not a fresh prompt). Fail-open to `prompt`.
    // The client toggle (AI Edit "Optimise prompt") wins when provided; else the env default.
    const wantOptimize = body.optimize !== undefined ? !!body.optimize : OPTIMIZE_GEN;
    const genPrompt =
      wantOptimize && (kind === "image" || kind === "video") && !body.image_url && !images.length
        ? await optimizePrompt(base, token, kind, prompt)
        : prompt;

    let reqBody: Record<string, any>;
    if (kind === "image") {
      reqBody = {
        prompt: genPrompt,
        aspect_ratio: body.aspect_ratio || "16:9",
        resolution: "1k",
        // multi-reference → images_list (+ image_url[0] for single-image back-compat); else a single img2img ref
        ...(images.length ? { images_list: images, image_url: images[0] } : body.image_url ? { image_url: body.image_url } : {}),
      };
    } else if (kind === "video") {
      // LIP-SYNC (audio present): pass the client's duration THROUGH — the pipeline sends 0, which the vApp
      // reads as "size the video to the real TTS audio + 1s tail" (it probes the audio server-side). So the
      // length is never a client/LLM guess and a long line is never cut or crammed. A PLAIN video (no audio)
      // stays capped short (5s default) but allowed up to 30s so a long T2V lip-sync line (sized to a
      // natural speaking rate) reaches its full length — b-roll requests small values so this doesn't affect
      // them.
      const dur = Number(body.duration);
      reqBody = {
        prompt: genPrompt,
        aspect_ratio: body.aspect_ratio || "16:9",
        duration: body.audio ? (Number.isFinite(dur) ? dur : 0) : Math.min(30, dur || 5),
        ...(body.image_url ? { image_url: body.image_url } : {}), // image-to-video (animate a still → LTX i2v)
        // LIP-SYNC: an audio URL → the vApp runs the video model in talking mode (it auto-sets
        // audio_prompt_type "A" and sizes the video to the audio), so the character lip-syncs to THIS
        // exact audio — no cut, no hallucinated words. Sent under several keys the backend accepts.
        ...(body.audio ? { audio: body.audio, audio_url: body.audio } : {}),
      };
    } else {
      reqBody = { prompt, model };
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // Send the token as BOTH Bearer (session tokens) and x-api-key (vk-… API keys) — the vApp's
    // /api/v1 accepts a vk- key only via x-api-key, so a Bearer-only header 401s for API-key users.
    if (token) { headers.Authorization = `Bearer ${token}`; headers["x-api-key"] = token; }

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
    // Return the actually-used prompt so the panel can show what was generated from.
    return NextResponse.json({ request_id: requestId, prompt: genPrompt });
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
