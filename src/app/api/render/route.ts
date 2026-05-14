import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir, unlink, readFile } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import { jobs } from "./jobs";

const execFileAsync = promisify(execFile);

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { design, options } = body;
    if (!design) return NextResponse.json({ message: "design required" }, { status: 400 });

    const jobId = randomBytes(8).toString("hex");
    jobs.set(jobId, { status: "PENDING", progress: 0 });

    runExport(jobId, design, options?.quality ?? "high", options?.format ?? "mp4").catch((err) => {
      jobs.set(jobId, { status: "FAILED", progress: 0, error: err.message });
    });

    return NextResponse.json({ render: { id: jobId } }, { status: 200 });
  } catch (err) {
    return NextResponse.json({ message: String(err) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id") || "";
  const job = jobs.get(id);
  if (!job) return NextResponse.json({ message: "job not found" }, { status: 404 });
  return NextResponse.json({
    render: { id, status: job.status, progress: job.progress, presigned_url: job.url },
  });
}

async function fetchToFile(url: string, dest: string): Promise<void> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buf);
  } else {
    // local path under public/
    const localPath = url.startsWith("/")
      ? path.join(process.cwd(), "public", url)
      : url;
    const buf = await readFile(localPath);
    await writeFile(dest, buf);
  }
}

const QUALITY_PRESETS = {
  high:   { crf: "18", preset: "slow" },
  medium: { crf: "23", preset: "medium" },
  low:    { crf: "28", preset: "fast" },
};

// Special platform presets — override size, fps, bitrate entirely
const PLATFORM_PRESETS: Record<string, {
  vf: string; videoArgs: string[]; audioArgs: string[];
}> = {
  "fb-whatsapp": {
    vf: "scale=480:896,fps=24",
    videoArgs: ["-vcodec", "libx264", "-profile:v", "baseline", "-level", "3.0", "-b:v", "1300k", "-maxrate", "1300k"],
    audioArgs: ["-acodec", "aac", "-b:a", "64k", "-ar", "44100", "-ac", "2"],
  },
  "fb-web-highres": {
    vf: "scale=680:1274,fps=24",
    videoArgs: ["-vcodec", "libx264", "-profile:v", "high", "-level", "4.0", "-b:v", "2200k", "-maxrate", "2200k", "-bufsize", "4400k"],
    audioArgs: ["-acodec", "aac", "-b:a", "49k", "-ar", "48000", "-ac", "2"],
  },
};

async function runExport(jobId: string, design: any, quality = "high", format = "mp4") {
  const exportsDir = path.join(process.cwd(), "public", "exports");
  const tmpDir = path.join(exportsDir, `tmp_${jobId}`);
  await mkdir(exportsDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  const { crf, preset } = QUALITY_PRESETS[quality as keyof typeof QUALITY_PRESETS] ?? QUALITY_PRESETS.high;

  const { trackItemsMap, trackItemIds, size } = design;
  const w = size?.width || 1080;
  const h = size?.height || 1920;

  // Collect all video/image items sorted by their timeline start (display.from)
  const items: any[] = (trackItemIds || [])
    .map((id: string) => trackItemsMap?.[id])
    .filter((item: any) => item && (item.type === "video" || item.type === "image"))
    .sort((a: any, b: any) => (a.display?.from ?? 0) - (b.display?.from ?? 0));

  if (items.length === 0) {
    jobs.set(jobId, { status: "FAILED", progress: 0, error: "No video/image items in timeline" });
    return;
  }

  jobs.set(jobId, { status: "PROCESSING", progress: 5 });

  // Download all sources to temp files
  const tempFiles: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const src = item.details?.src || "";
    if (!src) continue;

    const ext = src.split("?")[0].split(".").pop()?.toLowerCase() || "mp4";
    const safeExt = ["mp4", "mov", "webm", "jpg", "jpeg", "png", "webp"].includes(ext) ? ext : "mp4";
    const tmpFile = path.join(tmpDir, `clip_${i}.${safeExt}`);

    try {
      await fetchToFile(src, tmpFile);
      tempFiles.push(tmpFile);
    } catch (err) {
      console.error(`Skipping item ${i} (${src}): ${err}`);
    }

    jobs.set(jobId, { status: "PROCESSING", progress: Math.round(5 + (i / items.length) * 40) });
  }

  if (tempFiles.length === 0) {
    jobs.set(jobId, { status: "FAILED", progress: 0, error: "Could not download any media files" });
    return;
  }

  jobs.set(jobId, { status: "PROCESSING", progress: 50 });

  const outputPath = path.join(exportsDir, `${jobId}.mp4`);

  // Platform-specific preset (fb-whatsapp, fb-web-highres)
  const platformPreset = PLATFORM_PRESETS[format];
  if (platformPreset) {
    const segFiles: string[] = [];
    for (let i = 0; i < tempFiles.length; i++) {
      const f = tempFiles[i];
      const item = items[i];
      const isImage = /\.(jpg|jpeg|png|webp)$/i.test(f);
      const dur = ((item?.display?.to ?? 0) - (item?.display?.from ?? 0) || item?.duration || 5000) / 1000;
      const segPath = path.join(tmpDir, `seg_${i}.mp4`);
      const args = isImage
        ? ["-y", "-loop", "1", "-t", String(dur), "-i", f, "-vf", platformPreset.vf,
           ...platformPreset.videoArgs, "-pix_fmt", "yuv420p", "-an", segPath]
        : ["-y", "-i", f, "-vf", platformPreset.vf,
           ...platformPreset.videoArgs, ...platformPreset.audioArgs,
           "-pix_fmt", "yuv420p", segPath];
      await execFileAsync("ffmpeg", args);
      segFiles.push(segPath);
      jobs.set(jobId, { status: "PROCESSING", progress: Math.round(50 + (i / tempFiles.length) * 40) });
    }
    if (segFiles.length === 1) {
      const finalArgs = ["-y", "-i", segFiles[0], "-c", "copy", "-movflags", "+faststart", outputPath];
      await execFileAsync("ffmpeg", finalArgs);
    } else {
      const concatList = segFiles.map((f) => `file '${f}'`).join("\n");
      const concatListPath = path.join(tmpDir, "concat.txt");
      await writeFile(concatListPath, concatList);
      await execFileAsync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatListPath,
        "-c", "copy", "-movflags", "+faststart", outputPath]);
    }
    jobs.set(jobId, { status: "COMPLETED", progress: 100, url: `/exports/${jobId}.mp4` });
    for (const f of tempFiles) unlink(f).catch(() => {});
    return;
  }

  if (tempFiles.length === 1) {
    // Single file — just re-encode to target size
    const f = tempFiles[0];
    const isImage = /\.(jpg|jpeg|png|webp)$/i.test(f);
    const dur = (items[0]?.duration || 5000) / 1000;

    const args = isImage
      ? [
          "-y",
          "-loop", "1", "-t", String(dur), "-i", f,
          "-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
          "-c:v", "libx264", "-preset", preset, "-crf", crf,
          "-pix_fmt", "yuv420p", "-movflags", "+faststart",
          outputPath,
        ]
      : [
          "-y", "-i", f,
          "-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
          "-c:v", "libx264", "-preset", preset, "-crf", crf,
          "-c:a", "aac", "-b:a", "192k",
          "-pix_fmt", "yuv420p", "-movflags", "+faststart",
          outputPath,
        ];

    await execFileAsync("ffmpeg", args);
  } else {
    // Multiple files — normalize each to a fixed-size segment, then concat
    const segFiles: string[] = [];

    for (let i = 0; i < tempFiles.length; i++) {
      const f = tempFiles[i];
      const item = items[i];
      const isImage = /\.(jpg|jpeg|png|webp)$/i.test(f);
      const dur = ((item?.display?.to ?? 0) - (item?.display?.from ?? 0) || item?.duration || 5000) / 1000;
      const segPath = path.join(tmpDir, `seg_${i}.mp4`);

      const args = isImage
        ? [
            "-y",
            "-loop", "1", "-t", String(dur), "-i", f,
            "-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
            "-c:v", "libx264", "-preset", preset, "-crf", crf,
            "-pix_fmt", "yuv420p", "-an",
            segPath,
          ]
        : [
            "-y", "-i", f,
            "-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
            "-c:v", "libx264", "-preset", preset, "-crf", crf,
            "-c:a", "aac", "-b:a", "192k", "-ac", "2",
            "-pix_fmt", "yuv420p",
            segPath,
          ];

      await execFileAsync("ffmpeg", args);
      segFiles.push(segPath);

      jobs.set(jobId, { status: "PROCESSING", progress: Math.round(50 + (i / tempFiles.length) * 40) });
    }

    // Concat the normalized segments
    const concatList = segFiles.map((f) => `file '${f}'`).join("\n");
    const concatListPath = path.join(tmpDir, "concat.txt");
    await writeFile(concatListPath, concatList);

    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "concat", "-safe", "0", "-i", concatListPath,
      "-c:v", "libx264", "-preset", "fast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      outputPath,
    ]);
  }

  jobs.set(jobId, { status: "COMPLETED", progress: 100, url: `/exports/${jobId}.mp4` });

  // Cleanup temp dir
  for (const f of [...tempFiles]) {
    unlink(f).catch(() => {});
  }
}
