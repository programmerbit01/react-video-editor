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
  return NextResponse.json({
    render: {
      id,
      status: job.status,
      progress: job.progress,
      presigned_url: job.url,
    }
  });
}
