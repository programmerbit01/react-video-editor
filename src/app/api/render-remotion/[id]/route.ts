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
      engine: job.engine,
      source: job.source,
      project_name: job.project_name,
      started_at: job.started_at,
      video_seconds: job.video_seconds,
      concurrency: job.concurrency,
      cores: job.cores,
      gpu: job.gpu,
      hwAccel: job.hwAccel,
      render_seconds: job.render_seconds,
      render_fps: job.render_fps,
      speed_x: job.speed_x,
      size_mb: job.size_mb,
      crf: job.crf,
      export_quality: job.export_quality,
      resolution: job.resolution,
      // observability
      stages: job.stages,
      log: job.log,
      rendered_frames: job.rendered_frames,
      total_frames: job.total_frames,
      stalled: job.stalled,
      stall_reason: job.stall_reason,
    },
  });
}
