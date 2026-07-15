import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { jobs } from "../../jobs";
import { publicPath } from "@/utils/server-paths";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = jobs.get(id);
  if (!job || job.status !== "COMPLETED") {
    return NextResponse.json({ message: "render not ready" }, { status: 404 });
  }

  const isJson = (job as any).url?.endsWith(".json");
  const ext = isJson ? "json" : "mp4";
  const outputPath = publicPath("exports", `${id}.${ext}`);
  try {
    const buf = await readFile(outputPath);
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": isJson ? "application/json" : "video/mp4",
        "Content-Disposition": `attachment; filename="untitled.${ext}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ message: "output file not found" }, { status: 404 });
  }
}

