import { NextResponse } from "next/server";

// Editor projects persist on the vApp server (PocketBase, vapp_jobs type="project"),
// scoped to the signed-in user — this replaces the old browser-localStorage store
// that hit the ~5MB QuotaExceededError. This route is the editor's thin proxy: it
// forwards the caller's vApp token so the server knows WHOSE projects to read/write.
// Media stays on R2 exactly as the design already references it; only the reference
// JSON travels through here.

const VAPP_BASE = (process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091").replace(/\/+$/, "");

function bearer(token: string): Record<string, string> {
  const t = String(token || "").replace(/^Bearer\s+/i, "").trim();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// GET → the caller's saved projects (PB) MERGED with AI-rendered projects (server
// filesystem, kept for the "AI Projects" section). The PB list is user-scoped
// server-side, so users never see each other's work.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token") || "";
  const out: unknown[] = [];

  if (token) {
    try {
      const r = await fetch(`${VAPP_BASE}/vapp/editor-projects`, {
        headers: bearer(token),
        cache: "no-store",
      });
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d?.projects)) out.push(...d.projects);
      }
    } catch {}
  }

  try {
    const r = await fetch(`${VAPP_BASE}/vapp/projects`, { cache: "no-store" });
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d?.projects)) out.push(...d.projects);
    }
  } catch {}

  return NextResponse.json({ projects: out });
}

// POST { id?, name, data } → upsert the caller's project.
export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token") || "";
  if (!token) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "bad body" }, { status: 400 });
  }
  try {
    const r = await fetch(`${VAPP_BASE}/vapp/editor-projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(token) },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    return NextResponse.json(d, { status: r.status });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 502 });
  }
}

// DELETE ?id=<projectId> → delete the caller's project (server enforces ownership).
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token") || "";
  const id = searchParams.get("id") || "";
  if (!token) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  try {
    const r = await fetch(`${VAPP_BASE}/vapp/editor-projects/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: bearer(token),
    });
    const d = await r.json().catch(() => ({}));
    return NextResponse.json(d, { status: r.status });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 502 });
  }
}
