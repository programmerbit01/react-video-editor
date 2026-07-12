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
