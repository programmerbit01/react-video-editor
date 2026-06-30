import { NextRequest, NextResponse } from "next/server";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

type LottiePreset = {
  id: string;
  label: string;
  file: string;
};

const presetsFile = path.join(process.cwd(), "public", "lottie", "presets.json");
const lottieDir = path.join(process.cwd(), "public", "lottie");

const sanitizeSlug = (value: string) =>
  value
    .toLowerCase()
    .replace(/\.json$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || `preset-${Date.now()}`;

const loadPresets = async (): Promise<LottiePreset[]> => {
  try {
    const raw = await readFile(presetsFile, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export async function GET() {
  const presets = await loadPresets();
  return NextResponse.json({ presets });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const label = String(body?.label || "Custom Lottie").trim();
    const animationData = body?.animationData;

    if (!animationData || typeof animationData !== "object") {
      return NextResponse.json({ error: "Invalid animationData" }, { status: 400 });
    }

    await mkdir(lottieDir, { recursive: true });

    const slug = sanitizeSlug(label);
    const fileName = `${slug}.json`;
    const filePath = path.join(lottieDir, fileName);
    const file = `/lottie/${fileName}`;

    await writeFile(filePath, JSON.stringify(animationData));

    const presets = await loadPresets();
    const withoutExisting = presets.filter((preset) => preset.file !== file);
    const nextPreset = { id: slug, label, file };
    const nextPresets = [...withoutExisting, nextPreset];

    await writeFile(presetsFile, JSON.stringify(nextPresets, null, 2));

    return NextResponse.json({ preset: nextPreset, presets: nextPresets });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
