import { NextResponse } from "next/server";

const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";

const COMPLETE_STATES = new Set(["completed", "succeeded", "done"]);
const FAIL_STATES = new Set(["failed", "error", "cancelled", "canceled"]);

// GET /api/voiceover/[id]?baseUrl=...&token=...
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ message: "id required" }, { status: 400 });
    }

    const { searchParams } = new URL(request.url);
    const token = String(searchParams.get("token") || "").replace(/^Bearer\s+/i, "").trim();
    const baseUrl = DEFAULT_VAPP_BASE;

    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    const pollRes = await fetch(`${baseUrl}/api/v1/predictions/${id}/result`, { headers });

    if (!pollRes.ok) {
      const text = await pollRes.text().catch(() => "");
      return NextResponse.json(
        { message: text || "Poll failed", status: "unknown", done: false, failed: false },
        { status: pollRes.status >= 500 ? 200 : pollRes.status }
      );
    }

    const pollData = await pollRes.json().catch(() => ({}));
    const status = String(pollData?.status || "").toLowerCase();
    const done = COMPLETE_STATES.has(status);
    const failed = FAIL_STATES.has(status);

    const generationDetails =
      pollData?.raw?.generation_details ||
      pollData?.generation_details ||
      {};

    const outputType = generationDetails.output_type || (pollData?.raw?.output_type) || "audio";
    const outputUrl =
      generationDetails.output_video_url ||
      generationDetails.output_audio_url ||
      pollData?.output_url ||
      pollData?.raw?.output_url ||
      "";

    return NextResponse.json({ status, done, failed, output_url: outputUrl, output_type: outputType, generation_details: generationDetails });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ message: "Internal server error", status: "unknown", done: false, failed: false }, { status: 500 });
  }
}
