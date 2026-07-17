import { NextRequest, NextResponse } from "next/server";
import { jobs } from "../jobs";

export async function GET(
  request: NextRequest,
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
  // Return the job, plus the two fields only this route can compute.
  //
  // This used to hand-list every field, and it had drifted: `stages` was missing, so the live
  // stage detail the render works hard to maintain — "Download 47/207 · 12 cached", "Captions
  // 30/212" — was built, updated every tick, and thrown away here. The client reads r.stages
  // (use-download-state.ts) and render-report.tsx renders it; the whole reporting path existed
  // and was fed nothing, which is why an export shows a bare percent that sits still for a
  // minute and looks hung. `dropped` was missing too, for the same reason: the list is written
  // by hand, so every field added to RenderJob has to be remembered here, and one wasn't.
  //
  // `cancelled` and `log` go too — they are already public in spirit; there is nothing on a
  // render job that the person waiting on the render shouldn't see.
  return NextResponse.json({
    render: {
      ...job,
      id,
      public_url: publicUrl,
      presigned_url:
        job.status === "COMPLETED" ? `/api/render/${id}/download` : undefined,
    }
  });
}
