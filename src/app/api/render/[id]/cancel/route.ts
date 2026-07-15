import { NextRequest, NextResponse } from "next/server";
import { jobs, killJobChildren } from "../../jobs";

// Cancel a running FF export: flag the job (the render loop checks this between segments and
// stops) and immediately kill any ffmpeg children so it aborts fast rather than finishing the
// current wave. Terminal jobs are left alone.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = jobs.get(id);
  if (!job) return NextResponse.json({ message: "job not found" }, { status: 404 });
  if (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED") {
    return NextResponse.json({ ok: true, message: "already finished" });
  }
  jobs.set(id, {
    ...job,
    cancelled: true,
    status: "CANCELLED",
    error: "Cancelled by user",
    log: [...(job.log ?? []), "✕ cancelled by user"],
  });
  killJobChildren(id);
  return NextResponse.json({ ok: true });
}
