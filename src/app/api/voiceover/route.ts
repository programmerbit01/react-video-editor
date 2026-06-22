import { NextResponse } from "next/server";

const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";

// POST /api/voiceover — start a voice conversion job
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const baseUrl = String(body.baseUrl || DEFAULT_VAPP_BASE).replace(/\/+$/, "");
    const token = String(body.token || "").replace(/^Bearer\s+/i, "").trim();

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${baseUrl}/vapp/voiceover`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        source_audio_url: body.source_audio_url,
        voice_sample_url: body.voice_sample_url,
        speaker_count: body.speaker_count ?? 1,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { message: data?.detail || data?.message || "Failed to start voiceover" },
        { status: res.status }
      );
    }

    return NextResponse.json({ ok: true, job_id: data.job_id, status: "queued" });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ message: "Internal server error" }, { status: 500 });
  }
}

// GET /api/voiceover?baseUrl=...&token=...&page=1 — fetch history
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const baseUrl = String(searchParams.get("baseUrl") || DEFAULT_VAPP_BASE).replace(/\/+$/, "");
    const token = String(searchParams.get("token") || "").replace(/^Bearer\s+/i, "").trim();
    const page = searchParams.get("page") || "1";
    const perPage = searchParams.get("perPage") || "10";

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(
      `${baseUrl}/vapp/user/jobs?app_name=voiceover&page=${page}&perPage=${perPage}`,
      { headers }
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json({ items: [], totalItems: 0 }, { status: 200 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ items: [], totalItems: 0 }, { status: 200 });
  }
}
