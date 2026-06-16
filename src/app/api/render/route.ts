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

    runExport(
      jobId,
      design,
      options?.quality ?? "high",
      options?.format ?? "mp4",
      options?.maxDim,
    ).catch((err) => {
      console.error(`[render] job ${jobId} failed:`, err);
      const current = jobs.get(jobId);
      jobs.set(jobId, {
        status: "FAILED",
        progress: current?.progress ?? 0,
        error: err.message,
      });
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
      error: job.error,
      presigned_url: job.status === "COMPLETED" ? `/api/render/${id}/download` : undefined,
    },
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function fetchToFile(url: string, dest: string): Promise<void> {
  const internalOrigin =
    process.env.EDITOR_INTERNAL_ORIGIN || "http://127.0.0.1:3001/editor";
  const normalizedOrigin = internalOrigin.replace(/\/$/, "");
  const sourceUrl = url.startsWith("/api/") ? `${normalizedOrigin}${url}` : url;

  if (sourceUrl.startsWith("http://") || sourceUrl.startsWith("https://")) {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);
      try {
        const res = await fetch(sourceUrl, { signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${sourceUrl}`);
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

  const localPath = sourceUrl.startsWith("/")
    ? path.join(process.cwd(), "public", sourceUrl)
    : sourceUrl;
  const buf = await readFile(localPath);
  await writeFile(dest, buf);
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

/** Render a caption text onto a transparent PNG the same size as the video output. */
async function generateCaptionOverlay(
  text: string,
  videoWidth: number,
  videoHeight: number,
  fontSize: number,
  outputPath: string,
): Promise<void> {
  // Dynamic import so a missing native binary doesn't crash the whole server
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(videoWidth, videoHeight);
  const ctx = canvas.getContext("2d");

  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // Word-wrap
  const maxWidth = videoWidth * 0.85;
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);

  const lineHeight = fontSize * 1.35;
  const totalH = lines.length * lineHeight;
  const baseY = videoHeight - 50 - totalH + fontSize;

  // Shadow for readability on any background
  ctx.shadowColor = "rgba(0,0,0,0.95)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = "white";

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], videoWidth / 2, baseY + i * lineHeight);
  }

  const buf = await canvas.encode("png");
  await writeFile(outputPath, buf);
}

/** Compute even output dimensions from canvas size + max long-side target. */
function computeOutputSize(
  canvasW: number,
  canvasH: number,
  maxLongSide: number,
): { outW: number; outH: number } {
  const longerSide = Math.max(canvasW, canvasH);
  const scale = Math.min(1, maxLongSide / longerSide); // never upscale
  const raw = { w: Math.round(canvasW * scale), h: Math.round(canvasH * scale) };
  // libx264 requires even dimensions
  return {
    outW: raw.w % 2 === 0 ? raw.w : raw.w + 1,
    outH: raw.h % 2 === 0 ? raw.h : raw.h + 1,
  };
}

/** Convert any CSS colour string to a hex string FFmpeg accepts. */
function toFFmpegColor(color: string): string {
  const s = (color ?? "#ffffff").trim();
  // already hex
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s.slice(0, 7);
  // rgba(r,g,b,a) or rgb(r,g,b)
  const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    return (
      "#" +
      [m[1], m[2], m[3]]
        .map((n) => Number(n).toString(16).padStart(2, "0"))
        .join("")
    );
  }
  return "#ffffff";
}


const QUALITY_PRESETS: Record<string, { crf: string; preset: string }> = {
  high:   { crf: "18", preset: "slow" },
  medium: { crf: "23", preset: "medium" },
  low:    { crf: "28", preset: "fast" },
};

const PLATFORM_PRESETS: Record<string, {
  w: number; h: number;
  videoArgs: string[];
  audioArgs: string[];
}> = {
  "fb-whatsapp": {
    w: 480, h: 896,
    videoArgs: ["-c:v", "libx264", "-profile:v", "baseline", "-level", "3.0", "-b:v", "1300k", "-maxrate", "1300k"],
    audioArgs: ["-c:a", "aac", "-b:a", "64k", "-ar", "44100", "-ac", "2"],
  },
  "fb-web-highres": {
    w: 680, h: 1274,
    videoArgs: ["-c:v", "libx264", "-profile:v", "high", "-level", "4.0", "-b:v", "2200k", "-maxrate", "2200k", "-bufsize", "4400k"],
    audioArgs: ["-c:a", "aac", "-b:a", "49k", "-ar", "48000", "-ac", "2"],
  },
};

// ─── main export ─────────────────────────────────────────────────────────────

async function runExport(
  jobId: string,
  design: any,
  quality = "high",
  format = "mp4",
  maxDim?: number,
) {
  const exportsDir = path.join(process.cwd(), "public", "exports");
  const tmpDir = path.join(exportsDir, `tmp_${jobId}`);
  await mkdir(exportsDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  // JSON export
  if (format === "json") {
    const outputPath = path.join(exportsDir, `${jobId}.json`);
    await writeFile(outputPath, JSON.stringify(design, null, 2));
    jobs.set(jobId, { status: "COMPLETED", progress: 100, url: `/exports/${jobId}.json` });
    return;
  }

  const { crf, preset } = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.high;
  const { trackItemsMap, trackItemIds, size } = design;
  const platformPreset = PLATFORM_PRESETS[format];

  // ── Output dimensions: use canvas AR, scale to requested quality ──────────
  const canvasW = size?.width ?? 1080;
  const canvasH = size?.height ?? 1920;

  let outW: number;
  let outH: number;

  if (platformPreset) {
    outW = platformPreset.w;
    outH = platformPreset.h;
  } else {
    const targetMaxDim = maxDim ?? 1920;
    ({ outW, outH } = computeOutputSize(canvasW, canvasH, targetMaxDim));
  }

  const allItems: any[] = (trackItemIds ?? [])
    .map((id: string) => trackItemsMap?.[id])
    .filter(Boolean);

  const totalMs = Math.max(
    5000,
    ...allItems.map((it: any) => Number(it?.display?.to) || 0),
  );
  const totalSec = totalMs / 1000;

  const videoItems = allItems
    .filter((it: any) => it.type === "video" || it.type === "image")
    .sort((a: any, b: any) => (a.display?.from ?? 0) - (b.display?.from ?? 0));

  const audioItems = allItems
    .filter((it: any) => it.type === "audio")
    .sort((a: any, b: any) => (a.display?.from ?? 0) - (b.display?.from ?? 0));

  if (videoItems.length === 0 && audioItems.length === 0) {
    jobs.set(jobId, { status: "FAILED", progress: 0, error: "No media items in timeline" });
    return;
  }

  jobs.set(jobId, { status: "PROCESSING", progress: 5 });

  // ─── Download all media ───────────────────────────────────────────────────

  interface MediaEntry {
    path: string;
    item: any;
    kind: "video" | "audio";
    isImage: boolean;
    hasAudio: boolean;
  }
  const entries: MediaEntry[] = [];
  const allMedia = [...videoItems, ...audioItems];

  for (let i = 0; i < allMedia.length; i++) {
    const item = allMedia[i];
    const src: string = item.details?.src || item.details?.url || "";
    if (!src) continue;

    const urlPath = src.split("?")[0];
    const rawExt = urlPath.split(".").pop()?.toLowerCase() ?? "mp4";
    const safeExt = ["mp4", "mov", "webm", "mp3", "wav", "aac", "ogg", "m4a",
      "jpg", "jpeg", "png", "webp"].includes(rawExt) ? rawExt : "mp4";
    const tmpFile = path.join(tmpDir, `media_${i}.${safeExt}`);

    try {
      await fetchToFile(src, tmpFile);
      const isImage = /\.(jpe?g|png|webp)$/i.test(tmpFile);
      const kind: "video" | "audio" = item.type === "audio" ? "audio" : "video";
      const hasAudio = kind === "audio" ? true : (!isImage && await hasAudioStream(tmpFile));
      entries.push({ path: tmpFile, item, kind, isImage, hasAudio });
    } catch (err) {
      console.error(`[render] skipping ${src}: ${err}`);
    }

    jobs.set(jobId, { status: "PROCESSING", progress: Math.round(5 + (i / allMedia.length) * 40) });
  }

  if (entries.length === 0) {
    const cur = jobs.get(jobId);
    jobs.set(jobId, { status: "FAILED", progress: cur?.progress ?? 0, error: "Could not download any media files" });
    return;
  }

  // ── Generate caption PNG overlays with Node.js canvas (no FFmpeg text filter needed) ──
  const captionItems = allItems
    .filter((it: any) =>
      it.type === "caption" &&
      !it.metadata?.transcriptGuide &&
      !it.details?.guideOnly &&
      String(it.details?.text || "").trim()
    )
    .sort((a: any, b: any) => (a.display?.from ?? 0) - (b.display?.from ?? 0));

  interface CaptionOverlay { path: string; fromS: number; toS: number; }
  const captionOverlays: CaptionOverlay[] = [];

  for (let i = 0; i < captionItems.length; i++) {
    const item = captionItems[i];
    const text = String(item.details?.text || "").trim();
    if (!text) continue;
    const fromS = Number(item.display?.from || 0) / 1000;
    const toS   = Number(item.display?.to   || 0) / 1000;
    const fontSize = Math.max(8, Math.round(Number(item.details?.fontSize || 22) * outW / canvasW));
    const pngPath = path.join(tmpDir, `cap_${i}.png`);
    await generateCaptionOverlay(text, outW, outH, fontSize, pngPath);
    captionOverlays.push({ path: pngPath, fromS, toS });
  }

  jobs.set(jobId, { status: "PROCESSING", progress: 50 });

  // ─── Build FFmpeg filter_complex ─────────────────────────────────────────

  const ffmpegArgs: string[] = ["-y"];

  // Input 0: base black canvas
  ffmpegArgs.push(
    "-f", "lavfi",
    "-i", `color=black:size=${outW}x${outH}:r=30:d=${totalSec}`,
  );

  // Add all media inputs (inputs 1..N)
  for (const entry of entries) {
    if (entry.isImage) {
      const clipDurS = Math.max(
        0.1,
        ((entry.item.display?.to ?? 0) - (entry.item.display?.from ?? 0)) / 1000,
      );
      ffmpegArgs.push("-loop", "1", "-framerate", "30", "-t", String(clipDurS), "-i", entry.path);
    } else {
      ffmpegArgs.push("-i", entry.path);
    }
  }

  // Add caption PNG inputs (inputs N+1..N+M) — each loops for full duration
  const captionInputStart = 1 + entries.length;
  for (const cap of captionOverlays) {
    ffmpegArgs.push("-loop", "1", "-framerate", "1", "-t", String(totalSec), "-i", cap.path);
  }

  const filterParts: string[] = [];

  interface VideoOverlay { vLabel: string; from: number; to: number; }
  const videoOverlays: VideoOverlay[] = [];
  const audioLabels: string[] = [];

  let inputIdx = 1; // 0 is the base canvas

  for (const entry of entries) {
    const item = entry.item;
    const displayFromS = Math.max(0, Number(item.display?.from ?? 0) / 1000);
    const displayToS   = Math.max(displayFromS + 0.1, Number(item.display?.to ?? 0) / 1000);
    const trimFromS    = Math.max(0, Number(item.trim?.from ?? 0) / 1000);
    const clipDurS     = displayToS - displayFromS;
    const trimToS      = trimFromS + clipDurS;
    const delayMs      = Math.round(displayFromS * 1000);

    if (entry.kind === "video") {
      if (entry.isImage) {
        filterParts.push(
          `[${inputIdx}:v]setpts=PTS-STARTPTS+${displayFromS}/TB,scale=${outW}:${outH}[v${inputIdx}]`,
        );
      } else {
        filterParts.push(
          `[${inputIdx}:v]trim=start=${trimFromS}:end=${trimToS},setpts=PTS-STARTPTS+${displayFromS}/TB,scale=${outW}:${outH}[v${inputIdx}]`,
        );
      }
      videoOverlays.push({ vLabel: `v${inputIdx}`, from: displayFromS, to: displayToS });

      if (entry.hasAudio) {
        const vol = Math.max(0, Number(item.details?.volume ?? 100) / 100);
        filterParts.push(
          `[${inputIdx}:a]atrim=start=${trimFromS}:end=${trimToS},` +
          `asetpts=PTS-STARTPTS,` +
          `volume=${vol},` +
          `adelay=${delayMs}|${delayMs},` +
          `aformat=channel_layouts=stereo:sample_rates=48000[va${inputIdx}]`,
        );
        audioLabels.push(`va${inputIdx}`);
      }
    } else {
      // Audio-only track
      const vol = Math.max(0, Number(item.details?.volume ?? 100) / 100);
      filterParts.push(
        `[${inputIdx}:a]atrim=start=${trimFromS}:end=${trimToS},` +
        `asetpts=PTS-STARTPTS,` +
        `volume=${vol},` +
        `adelay=${delayMs}|${delayMs},` +
        `aformat=channel_layouts=stereo:sample_rates=48000[aa${inputIdx}]`,
      );
      audioLabels.push(`aa${inputIdx}`);
    }

    inputIdx++;
  }

  // Chain video overlays onto the base canvas
  if (videoOverlays.length === 0) {
    filterParts.push("[0:v]copy[vout]");
  } else {
    let prevLabel = "0:v";
    for (let i = 0; i < videoOverlays.length; i++) {
      const { vLabel, from, to } = videoOverlays[i];
      const outLabel = i === videoOverlays.length - 1 ? "vout" : `ov${i}`;
      filterParts.push(
        `[${prevLabel}][${vLabel}]overlay=enable='between(t,${from},${to})'[${outLabel}]`,
      );
      prevLabel = outLabel;
    }
  }

  // Chain caption PNG overlays onto video output
  let finalVideoLabel = "vout";
  if (captionOverlays.length > 0) {
    let prevLabel = "vout";
    for (let i = 0; i < captionOverlays.length; i++) {
      const { fromS, toS } = captionOverlays[i];
      const capInputIdx = captionInputStart + i;
      // scale caption PNG to video size, then overlay with alpha during its time window
      filterParts.push(
        `[${capInputIdx}:v]scale=${outW}:${outH},format=rgba[capscaled${i}]`,
      );
      const isLast = i === captionOverlays.length - 1;
      const outLabel = isLast ? "vcap" : `capov${i}`;
      filterParts.push(
        `[${prevLabel}][capscaled${i}]overlay=x=0:y=0:enable='between(t,${fromS},${toS})'[${outLabel}]`,
      );
      prevLabel = outLabel;
    }
    finalVideoLabel = "vcap";
  }

  // Mix all audio tracks
  const hasAudio = audioLabels.length > 0;
  if (hasAudio) {
    if (audioLabels.length === 1) {
      filterParts.push(`[${audioLabels[0]}]apad=whole_dur=${totalSec}[aout]`);
    } else {
      const joined = audioLabels.map((l) => `[${l}]`).join("");
      filterParts.push(
        `${joined}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,` +
        `apad=whole_dur=${totalSec}[aout]`,
      );
    }
  }

  ffmpegArgs.push("-filter_complex", filterParts.join(";"));
  ffmpegArgs.push("-map", `[${finalVideoLabel}]`);
  if (hasAudio) ffmpegArgs.push("-map", "[aout]");

  // Codec args
  if (platformPreset) {
    ffmpegArgs.push(...platformPreset.videoArgs);
    if (hasAudio) ffmpegArgs.push(...platformPreset.audioArgs);
  } else {
    ffmpegArgs.push(
      "-c:v", "libx264",
      "-preset", preset,
      "-crf", crf,
      "-pix_fmt", "yuv420p",
    );
    if (hasAudio) {
      ffmpegArgs.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
    }
  }

  ffmpegArgs.push("-t", String(totalSec), "-movflags", "+faststart");

  const outputPath = path.join(exportsDir, `${jobId}.mp4`);
  ffmpegArgs.push(outputPath);

  jobs.set(jobId, { status: "PROCESSING", progress: 60 });

  try {
    await execFileAsync("ffmpeg", ffmpegArgs, {
      maxBuffer: 256 * 1024 * 1024,
      timeout: 900_000,
    });
  } catch (ffErr: any) {
    const cur = jobs.get(jobId);
    const stderr = ffErr?.stderr ? String(ffErr.stderr).slice(-2000) : "";
    const msg = stderr || ffErr?.message || "FFmpeg failed";
    jobs.set(jobId, { status: "FAILED", progress: cur?.progress ?? 60, error: msg });
    return;
  }

  jobs.set(jobId, { status: "COMPLETED", progress: 100, url: `/exports/${jobId}.mp4` });

  for (const entry of entries) unlink(entry.path).catch(() => {});
  for (const cap of captionOverlays) unlink(cap.path).catch(() => {});
}
