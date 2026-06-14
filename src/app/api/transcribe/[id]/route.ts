import { NextResponse } from "next/server";

const DEFAULT_VAPP_BASE = process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091";

const COMPLETE_STATES = new Set(["completed", "succeeded", "done"]);
const FAIL_STATES = new Set(["failed", "error", "cancelled", "canceled"]);

// GET /api/transcribe/[id]?baseUrl=...&token=...
// Single poll — returns { status, done, failed, generation_details? }
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ message: "id parameter is required" }, { status: 400 });
    }

    const { searchParams } = new URL(request.url);
    const baseUrl = String(searchParams.get("baseUrl") || DEFAULT_VAPP_BASE).replace(/\/+$/, "");
    const token = String(searchParams.get("token") || "").replace(/^Bearer\s+/i, "").trim();

    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    const pollResponse = await fetch(`${baseUrl}/api/v1/predictions/${id}/result`, { headers });

    if (!pollResponse.ok) {
      const text = await pollResponse.text().catch(() => "");
      return NextResponse.json(
        { message: text || "Poll failed", status: "unknown", done: false, failed: false },
        { status: pollResponse.status >= 500 ? 200 : pollResponse.status }
      );
    }

    const pollData = await pollResponse.json().catch(() => ({}));
    const status = String(pollData?.status || "").toLowerCase();
    const done = COMPLETE_STATES.has(status);
    const failed = FAIL_STATES.has(status);

    const generationDetails =
      pollData?.raw?.generation_details ||
      pollData?.generation_details ||
      {};

    return NextResponse.json({ status, done, failed, generation_details: generationDetails });
  } catch (error: any) {
    console.error(error);
    return NextResponse.json({ message: "Internal server error", status: "unknown", done: false, failed: false }, { status: 500 });
  }
}
