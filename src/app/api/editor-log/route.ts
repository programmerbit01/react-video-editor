import { NextResponse } from "next/server";

// Ships the editor's AI-Edit console logs to the vApp so the whole generate → arrange trace lands in
// logs/vapp_editor.log (readable server-side, no browser-console scraping). Best-effort, fail-open.
const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const lines = Array.isArray(body?.lines) ? body.lines : body?.msg ? [body.msg] : [];
    if (!lines.length) return NextResponse.json({ ok: true, written: 0 });
    const base = DEFAULT_VAPP_BASE.replace(/\/+$/, "");
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 5000);
    try {
      await fetch(`${base}/vapp/editor_log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(kill);
    }
    return NextResponse.json({ ok: true, written: lines.length });
  } catch {
    return NextResponse.json({ ok: true, written: 0 });
  }
}
