import { NextResponse } from "next/server";

// Imperative Stop for the AI-Edit run → vApp POST /vapp/llm/stop {session}. The panel's Stop
// button fires this so the BACKEND LLM (LM Studio) is cut immediately, instead of hoping the
// fetch-abort propagates through the Next proxy to the server (the flaky part). Server-to-server,
// same house pattern as /api/ai-edit. Body: { session }.
const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const session = String(body?.session || "").trim();
    if (!session) return NextResponse.json({ ok: false, error: "session required" }, { status: 400 });
    const base = DEFAULT_VAPP_BASE.replace(/\/+$/, "");
    const token = String(body?.token || "").replace(/^Bearer\s+/i, "").trim();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["X-API-Key"] = token;
    const r = await fetch(`${base}/vapp/llm/stop`, {
      method: "POST",
      headers,
      body: JSON.stringify({ session }),
    });
    const d = await r.json().catch(() => ({}));
    return NextResponse.json({ ok: r.ok && d?.ok !== false, stopped: d?.stopped ?? 0 }, { status: r.ok ? 200 : r.status });
  } catch (error) {
    console.error("[ai-edit/stop]", error);
    // Stop must never surface an error to the UI — the client already aborted locally.
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
