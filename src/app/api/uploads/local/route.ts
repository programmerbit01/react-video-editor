import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File;
    if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });

    const uploadsDir = path.join(process.cwd(), "public", "uploads");
    await mkdir(uploadsDir, { recursive: true });

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Sanitize filename
    const safeName = Date.now() + "_" + file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    await writeFile(path.join(uploadsDir, safeName), buffer);

    return NextResponse.json({ url: `/uploads/${safeName}`, fileName: safeName });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
