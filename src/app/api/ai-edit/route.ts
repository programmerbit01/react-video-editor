import { NextResponse } from "next/server";

// Editor-owned route → vApp's UNIFIED OpenAI-compatible endpoints. vApp routes to
// LiteLLM/Dify internally, so the editor never touches providers directly and
// never goes through vapp_higgs. Server-to-server (house pattern, like /api/transcribe).
const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";

// GET /api/ai-edit → model list (OpenAI GET /v1/models). LLM models only
// (dify/* agent apps don't reliably emit structured ops JSON).
export async function GET() {
  const base = DEFAULT_VAPP_BASE.replace(/\/+$/, "");
  try {
    const r = await fetch(`${base}/v1/models`, { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    const models = (Array.isArray(d?.data) ? d.data : [])
      .filter((m: any) => String(m?.id || "").startsWith("litellm/"))
      .map((m: any) => ({ id: m.id, label: String(m.id).split("/").pop() || m.id }));
    return NextResponse.json({ models }, { status: 200 });
  } catch {
    return NextResponse.json({ models: [] }, { status: 200 });
  }
}

// POST /api/ai-edit → vApp POST /v1/chat/completions. Body: { model, messages,
// stream?, reasoning_effort?, extra_body?, token? }.
//  - stream:true  → pipe the raw SSE straight back (live text + reasoning_content).
//  - stream:false → return { content } (assistant text).
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const base = DEFAULT_VAPP_BASE.replace(/\/+$/, "");
    const token = String(body.token || "").replace(/^Bearer\s+/i, "").trim();
    const stream = body.stream === true;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const upstreamBody: Record<string, any> = {
      model: body.model || "litellm/GO20",
      messages: body.messages || [],
      stream,
      temperature: 0.2,
      max_tokens: 1200,
    };
    if (body.reasoning_effort) upstreamBody.reasoning_effort = body.reasoning_effort;
    if (body.extra_body) upstreamBody.extra_body = body.extra_body;

    const upstream = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
    });

    if (stream) {
      if (!upstream.ok || !upstream.body) {
        const txt = await upstream.text().catch(() => "");
        return NextResponse.json({ error: txt || `chat failed (${upstream.status})` }, {
          status: upstream.status || 500,
        });
      }
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      });
    }

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const msg = data?.error?.message || data?.message || `chat failed (${upstream.status})`;
      return NextResponse.json({ error: msg }, { status: upstream.status || 500 });
    }
    return NextResponse.json({ content: data?.choices?.[0]?.message?.content || "" });
  } catch (error) {
    console.error("[ai-edit]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
