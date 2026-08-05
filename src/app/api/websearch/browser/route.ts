import { NextResponse } from "next/server";

// The research browser (Neko) + navigate endpoint live in the vApp config
// (model_config web_search.browser) — the editor holds no url, just reads them here.
const VAPP_BASE = (process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091").replace(/\/+$/, "");

export async function GET() {
  try {
    const res = await fetch(`${VAPP_BASE}/vapp/websearch/browser`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json({ url: String(data?.url || ""), nav_url: String(data?.nav_url || "") });
  } catch {
    return NextResponse.json({ url: "", nav_url: "" });
  }
}
