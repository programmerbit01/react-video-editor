import { NextResponse } from "next/server";

// Editor-owned route → vApp's UNIFIED LLM endpoints. vApp routes to LiteLLM/Dify
// internally, so the editor never touches providers directly and never goes through
// vapp_higgs. Server-to-server (house pattern, like /api/transcribe).
const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";

// AI-Edit's prompt→ops call goes through the unified LLM service (POST /vapp/llm,
// task="editor_edit") by DEFAULT — model / thinking / retry / fallback policy lives in
// ONE config row (model_config.json → llm_tasks.editor_edit), not hardcoded here.
// The service streams (SSE with thinking + content events), so we keep live typing AND
// the reasoning panel. Set AI_EDIT_USE_VAPP_LLM=0 to fall back to the raw
// /v1/chat/completions path (strangler escape hatch). Both stream identically to the panel.
const USE_VAPP_LLM = (process.env.AI_EDIT_USE_VAPP_LLM ?? "1") !== "0";

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

// Translate the unified /vapp/llm SSE ({type:"start"|"thinking"|"content", delta} + [DONE])
// into the OpenAI-shaped SSE the AI-Edit panel's runChat already parses
// (choices[0].delta.content / .reasoning_content). Keeps the panel backend-agnostic — it
// never needs to know whether it's talking to /vapp/llm or /v1/chat/completions.
function translateVappLlmSse(upstreamBody: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  const emit = (ctrl: ReadableStreamDefaultController<Uint8Array>, obj: unknown) =>
    ctrl.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            const p = t.slice(5).trim();
            if (!p || p === "[DONE]") continue; // our own [DONE] is emitted at stream end
            let evt: any;
            try {
              evt = JSON.parse(p);
            } catch {
              continue;
            }
            if (evt?.error) {
              emit(controller, { error: { message: String(evt.error?.message || evt.error) } });
            } else if (evt?.type === "thinking" && evt.delta) {
              emit(controller, { choices: [{ delta: { reasoning_content: evt.delta } }] });
            } else if (evt?.type === "content" && evt.delta) {
              emit(controller, { choices: [{ delta: { content: evt.delta } }] });
            }
            // type:"start" (and anything unknown) → ignored
          }
        }
      } catch (e) {
        emit(controller, { error: { message: String(e) } });
      } finally {
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

// Unified path: POST /vapp/llm task="editor_edit". The ops contract stays client-side
// (the panel sends OPS_SYSTEM_PROMPT as the system message + extractOps parses the reply),
// so we pass that system prompt via overrides.system (overrides win over the config row)
// and hand the model's text straight back. No change to operations.ts.
async function postUnified(base: string, token: string, stream: boolean, body: any) {
  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const system = messages.find((m) => m?.role === "system")?.content || "";
  const input = messages
    .filter((m) => m?.role && m.role !== "system")
    .map((m) => String(m?.content || ""))
    .join("\n\n")
    .trim();

  // 8000, not 1200 — a pipeline (Comic Drama / Faceless) emits 12+ shots as one big ops JSON;
  // 1200 truncated it mid-JSON so extractOps failed silently. max_tokens is a ceiling, so short
  // edits still stop early — this only gives the long plans room to finish.
  const overrides: Record<string, any> = { temperature: 0.2, max_tokens: 8000 };
  if (system) overrides.system = system;
  // dropdown id "litellm/GO20" → config model id "GO20"
  const model = String(body.model || "").replace(/^litellm\//, "").trim();
  if (model) overrides.model = model;
  // panel sets reasoning_effort:"low" only when thinking is OFF (!showThinking)
  overrides.thinking = body.reasoning_effort === "low" ? "off" : "on";

  const reqBody: Record<string, any> = { task: "editor_edit", input, overrides };
  if (token) reqBody.api_key = token;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["X-API-Key"] = token;

  const upstream = await fetch(`${base}/vapp/llm${stream ? "?stream=1" : ""}`, {
    method: "POST",
    headers,
    body: JSON.stringify(reqBody),
  });

  if (stream) {
    if (!upstream.ok || !upstream.body) {
      const txt = await upstream.text().catch(() => "");
      return NextResponse.json({ error: txt || `llm failed (${upstream.status})` }, {
        status: upstream.status || 500,
      });
    }
    return new Response(translateVappLlmSse(upstream.body), {
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
    const msg = data?.error || data?.message || `llm failed (${upstream.status})`;
    return NextResponse.json({ error: msg }, { status: upstream.status || 500 });
  }
  // /vapp/llm is fail-open: on error it returns { ok:false, text:<original input> }; the
  // editor then finds no ops and applies nothing — never crashes.
  return NextResponse.json({ content: data?.text || "" });
}

// Legacy path (AI_EDIT_USE_VAPP_LLM=0): raw vApp POST /v1/chat/completions.
async function postLegacy(base: string, token: string, stream: boolean, body: any) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const upstreamBody: Record<string, any> = {
    model: body.model || "litellm/GO20",
    messages: body.messages || [],
    stream,
    temperature: 0.2,
    max_tokens: 8000,
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
}

// POST /api/ai-edit → prompt→ops. Default: unified /vapp/llm (task="editor_edit", streamed +
// translated to OpenAI-shape). Fallback: raw /v1/chat/completions (AI_EDIT_USE_VAPP_LLM=0).
// Body: { model, messages, stream?, reasoning_effort?, extra_body?, token? }.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const base = DEFAULT_VAPP_BASE.replace(/\/+$/, "");
    const token = String(body.token || "").replace(/^Bearer\s+/i, "").trim();
    const stream = body.stream === true;
    return USE_VAPP_LLM
      ? await postUnified(base, token, stream, body)
      : await postLegacy(base, token, stream, body);
  } catch (error) {
    console.error("[ai-edit]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
