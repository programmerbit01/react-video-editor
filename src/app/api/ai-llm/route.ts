import { NextResponse } from "next/server";

// Generic unified-LLM text call → vApp POST /vapp/llm (bare text out, fail-open). Used by the
// AI Edit auto-director for the `script` + `beat_plan` tasks, and reusable for translate /
// visual_query / optimize_* etc. Direct to vApp (no proxy). Body: { task, input, overrides?, token? }.
const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const base = DEFAULT_VAPP_BASE.replace(/\/+$/, "");
    const token = String(body.token || "").replace(/^Bearer\s+/i, "").trim();
    const task = String(body.task || "").trim();
    const input = String(body.input ?? body.prompt ?? "").trim();
    if (!task || !input) {
      return NextResponse.json({ error: "task and input are required" }, { status: 400 });
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["X-API-Key"] = token;
    // STREAM mode → pipe the vApp SSE straight through (live script typing). Forward the client's
    // abort so a Stop cancels the upstream LLM too (same true-stop path as the ops stream).
    if (body.stream) {
      const sr = await fetch(`${base}/vapp/llm?stream=1`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          task,
          input,
          ...(body.overrides ? { overrides: body.overrides } : {}),
          ...(token ? { api_key: token } : {}),
        }),
        signal: request.signal,
      });
      if (!sr.ok || !sr.body) {
        const t = await sr.text().catch(() => "");
        return NextResponse.json({ error: t || `llm stream failed (${sr.status})` }, { status: sr.status || 500 });
      }
      // ACTIVE pump (not a raw `sr.body` passthrough) — Node/Next buffers a raw body and delivers it
      // all-at-once; pulling + enqueuing each chunk flushes it live. Mirrors the working /api/ai-edit.
      const reader = sr.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) { controller.close(); return; }
            controller.enqueue(value);
          } catch { try { controller.close(); } catch { /* already closed */ } }
        },
        cancel() { try { reader.cancel(); } catch { /* ignore */ } },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" },
      });
    }
    const r = await fetch(`${base}/vapp/llm`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        task,
        input,
        ...(body.overrides ? { overrides: body.overrides } : {}),
        ...(token ? { api_key: token } : {}),
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      return NextResponse.json({ error: d?.error || d?.message || `llm failed (${r.status})` }, {
        status: r.status || 500,
      });
    }
    // /vapp/llm is fail-open: on error it returns { ok:false, text:<original input> }.
    return NextResponse.json({ text: String(d?.text || ""), ok: d?.ok !== false });
  } catch (error) {
    console.error("[ai-llm]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
