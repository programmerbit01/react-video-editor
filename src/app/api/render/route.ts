import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir, unlink, readFile } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
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
    render: {
      id,
      status: job.status,
      progress: job.progress,
      // Keep download under /api/render/... so vapp_higgs rewrite forwards correctly.
      presigned_url: job.status === "COMPLETED" ? `/api/render/${id}/download` : undefined,
    },
  });
}

async function fetchToFile(url: string, dest: string): Promise<void> {
  const internalOrigin =
    process.env.EDITOR_INTERNAL_ORIGIN || "http://127.0.0.1:3001/editor";
  const normalizedOrigin = internalOrigin.replace(/\/$/, "");
  const sourceUrl = url.startsWith("/api/")
    ? `${normalizedOrigin}${url}`
    : url;

  if (sourceUrl.startsWith("http://") || sourceUrl.startsWith("https://")) {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      try {
        const res = await fetch(sourceUrl, { signal: controller.signal });
        if (!res.ok || !res.body) {
          throw new Error(`Failed to download ${sourceUrl}: ${res.status}`);
        }
        const writer = createWriteStream(dest);
        await pipeline(Readable.fromWeb(res.body as any), writer);
        clearTimeout(timeout);
        return;
      } catch (err) {
        clearTimeout(timeout);
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("download failed");
  }

  // local path under public/
  const localPath = sourceUrl.startsWith("/")
    ? path.join(process.cwd(), "public", sourceUrl)
    : sourceUrl;
  const buf = await readFile(localPath);
  await writeFile(dest, buf);
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

function buildSegmentArgs({
  input,
  output,
  dur,
  vf,
  videoArgs,
  includeSourceAudio = false,
}: {
  input: string;
  output: string;
  dur: number;
  vf: string;
  videoArgs: string[];
  includeSourceAudio?: boolean;
}) {
  const isImage = /\.(jpg|jpeg|png|webp)$/i.test(input);
  const base = isImage
    ? ["-y", "-loop", "1", "-t", String(dur), "-i", input]
    : ["-y", "-i", input];

  if (includeSourceAudio && !isImage) {
    return [
      ...base,
      "-vf", vf,
      ...videoArgs,
      "-map", "0:v:0",
      "-map", "0:a:0",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "48000",
      "-ac", "2",
      "-pix_fmt", "yuv420p",
      "-shortest",
      output,
    ];
  }

  return [
    ...base,
    "-f", "lavfi", "-t", String(dur), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-vf", vf,
    ...videoArgs,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ac", "2",
    "-pix_fmt", "yuv420p",
    "-shortest",
    output,
  ];
}

async function hasAudioStream(inputPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_type",
      "-of", "csv=p=0",
      inputPath,
    ]);
    return String(stdout).trim() === "audio";
  } catch {
    return false;
  }
}

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
  const tempFiles: { path: string; item: any }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const src = item.details?.src || "";
    if (!src) continue;

    const ext = src.split("?")[0].split(".").pop()?.toLowerCase() || "mp4";
    const safeExt = ["mp4", "mov", "webm", "jpg", "jpeg", "png", "webp"].includes(ext) ? ext : "mp4";
    const tmpFile = path.join(tmpDir, `clip_${i}.${safeExt}`);

    try {
      await fetchToFile(src, tmpFile);
      tempFiles.push({ path: tmpFile, item });
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
      const f = tempFiles[i].path;
      const item = tempFiles[i].item;
      const dur = ((item?.display?.to ?? 0) - (item?.display?.from ?? 0) || item?.duration || 5000) / 1000;
      const segPath = path.join(tmpDir, `seg_${i}.mp4`);
      const args = buildSegmentArgs({
        input: f,
        output: segPath,
        dur,
        vf: platformPreset.vf,
        videoArgs: platformPreset.videoArgs,
        includeSourceAudio: await hasAudioStream(f),
      });
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
    for (const f of tempFiles) unlink(f.path).catch(() => {});
    return;
  }

  if (tempFiles.length === 1) {
    // Single file — just re-encode to target size
    const f = tempFiles[0].path;
    const isImage = /\.(jpg|jpeg|png|webp)$/i.test(f);
    const dur = (tempFiles[0]?.item?.duration || 5000) / 1000;

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
      const f = tempFiles[i].path;
      const item = tempFiles[i].item;
      const dur = ((item?.display?.to ?? 0) - (item?.display?.from ?? 0) || item?.duration || 5000) / 1000;
      const segPath = path.join(tmpDir, `seg_${i}.mp4`);

      const args = buildSegmentArgs({
        input: f,
        output: segPath,
        dur,
        vf: `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
        videoArgs: ["-c:v", "libx264", "-preset", preset, "-crf", crf],
        includeSourceAudio: await hasAudioStream(f),
      });

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
    unlink(f.path).catch(() => {});
  }
}
