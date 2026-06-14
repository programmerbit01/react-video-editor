import { NextResponse } from "next/server";

const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";
const COMPLETE_STATES = new Set(["completed", "succeeded", "done"]);
const FAIL_STATES = new Set(["failed", "error", "cancelled", "canceled"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const baseUrl = String(body.baseUrl || DEFAULT_VAPP_BASE).replace(/\/+$/, "");
    const token = String(body.token || "").replace(/^Bearer\s+/i, "").trim();
    const audioUrl = unwrapProxyUrl(String(body.url || body.audio_url || ""));
    const timestampType = String(body.timestamp_type || "segment").trim();
    const targetLanguage = String(body.targetLanguage || body.target_language || "").trim();

    if (!audioUrl) {
      return NextResponse.json(
        { message: "audio_url is required" },
        { status: 400 }
      );
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const transcribeResponse = await fetch(`${baseUrl}/vapp/transcribe`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        audio_url: audioUrl,
        timestamp_type: timestampType,
        targetLanguage,
        denoise: true
      })
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
      return NextResponse.json(
        { message: "Transcription job id missing" },
        { status: 500 }
      );
    }

    for (let attempt = 0; attempt < 150; attempt += 1) {
      await sleep(2000);
      const pollResponse = await fetch(
        `${baseUrl}/api/v1/predictions/${jobId}/result`,
        { headers }
      );

      if (!pollResponse.ok) {
        if (pollResponse.status >= 500) continue;
        const text = await pollResponse.text();
        return NextResponse.json(
          { message: text || "Failed to fetch transcription result" },
          { status: pollResponse.status }
        );
      }

      const pollData = await pollResponse.json().catch(() => ({}));
      const status = String(pollData?.status || "").toLowerCase();

      if (COMPLETE_STATES.has(status)) {
        const generationDetails =
          pollData?.raw?.generation_details ||
          pollData?.generation_details ||
          {};
        const outputUrl =
          String(
            pollData?.raw?.output_url ||
              pollData?.output_url ||
              pollData?.raw?.output?.url ||
              ""
          ).trim();

        return NextResponse.json(
          {
            ok: true,
            transcribe: {
              url: outputUrl,
              result: generationDetails
            }
          },
          { status: 200 }
        );
      }

      if (FAIL_STATES.has(status)) {
        return NextResponse.json(
          { message: pollData?.message || pollData?.error || "Transcription failed" },
          { status: 500 }
        );
      }
    }

    return NextResponse.json(
      { message: "Transcription timed out" },
      { status: 504 }
    );
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { message: "Internal server error" },
      { status: 500 }
    );
  }
}
