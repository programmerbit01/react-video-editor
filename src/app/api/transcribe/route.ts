import { NextResponse } from "next/server";

const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";

const unwrapProxyUrl = (inputUrl: string) => {
  const trimmed = String(inputUrl || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed, "http://localhost");
    if (parsed.pathname.includes("/api/proxy")) {
      const actual = parsed.searchParams.get("url");
      if (actual) return actual;
    }
  } catch {}
  return trimmed;
};

// POST /api/transcribe
// Fires the transcription job and returns {job_id} immediately — no polling.
// Frontend polls GET /api/transcribe/[id] for status, then reads via /api/vapp/stt.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const baseUrl = String(body.baseUrl || DEFAULT_VAPP_BASE).replace(/\/+$/, "");
    const token = String(body.token || "").replace(/^Bearer\s+/i, "").trim();
    const audioUrl = unwrapProxyUrl(String(body.url || body.audio_url || ""));
    const timestampType = String(body.timestamp_type || "word").trim();
    const targetLanguage = String(body.targetLanguage || body.target_language || "").trim();

    if (!audioUrl) {
      return NextResponse.json({ message: "audio_url is required" }, { status: 400 });
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const transcribeResponse = await fetch(`${baseUrl}/vapp/transcribe`, {
      method: "POST",
      headers,
      body: JSON.stringify({ audio_url: audioUrl, timestamp_type: timestampType, targetLanguage, denoise: true }),
    });

    const transcribeData = await transcribeResponse.json().catch(() => ({}));
    if (!transcribeResponse.ok) {
      return NextResponse.json(
        { message: transcribeData?.detail || transcribeData?.message || "Failed to queue transcription" },
        { status: transcribeResponse.status }
      );
    }

    const jobId = String(transcribeData?.job_id || "").trim();
    if (!jobId) {
      return NextResponse.json({ message: "Transcription job id missing" }, { status: 500 });
    }

    // Return immediately — backend saves stt to vapp_media.meta when done
    return NextResponse.json(
      { ok: true, job_id: jobId, pb_job_id: String(transcribeData?.pb_job_id || ""), status: "queued", baseUrl },
      { status: 200 }
    );
  } catch (error) {
    console.error(error);
    return NextResponse.json({ message: "Internal server error" }, { status: 500 });
  }
}
