import { NextRequest, NextResponse } from "next/server";
import { jobs } from "../jobs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = jobs.get(id);
  if (!job) {
    return NextResponse.json({ message: "job not found" }, { status: 404 });
  }

  let publicUrl: string | undefined;
  if (job.status === "COMPLETED") {
    try {
      const vappBase = (process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091").replace(/\/+$/, "");
      const res = await fetch(`${vappBase}/vapp/wait_job/${id}?timeout=10`, {
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        const data = await res.json();
        const vid = String(data.video_url || "");
        if (vid && !vid.includes("127.0.0.1") && !vid.startsWith("/")) {
          publicUrl = vid;
        }
      }
    } catch {}
  }

  return NextResponse.json({
    render: {
      id,
      status: job.status,
      progress: job.progress,
      error: job.error,
      presigned_url:
        job.status === "COMPLETED"
          ? `/api/render-remotion/${id}/download`
          : undefined,
      public_url: publicUrl,
    },
  });
}
