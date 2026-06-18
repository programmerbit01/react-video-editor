import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { readFile } from "fs/promises";
import { jobs } from "../../jobs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = jobs.get(id);
  if (!job || job.status !== "COMPLETED") {
    return NextResponse.json({ message: "render not ready" }, { status: 404 });
  }

  const outputPath = path.join(
    process.cwd(),
    "public",
    "exports",
    `${id}.mp4`
  );
  try {
    const buf = await readFile(outputPath);
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="untitled.mp4"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { message: "output file not found" },
      { status: 404 }
    );
  }
}
