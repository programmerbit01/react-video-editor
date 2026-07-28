import { NextResponse } from "next/server";

// Batch, non-blocking job status: GET /api/jobs-status?ids=a,b,c → { id: {status, output_url?, …} }.
// ONE short call for ALL pending gens (replaces N per-job long-polls that pile up behind a proxy and
// update late). Straight passthrough to the vApp, which reads the data it already has (vapp_jobs).
const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";

export async function GET(request: Request) {
  const u = new URL(request.url);
  const ids = u.searchParams.get("ids") || "";
  if (!ids) return NextResponse.json({}, { status: 200 });
  const base = DEFAULT_VAPP_BASE.replace(/\/+$/, "");
  try {
    const r = await fetch(`${base}/vapp/jobs_status?ids=${encodeURIComponent(ids)}`, { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    return NextResponse.json(d && typeof d === "object" ? d : {});
  } catch {
    // transient (server restart) — empty map, client keeps polling
    return NextResponse.json({}, { status: 200 });
  }
}
