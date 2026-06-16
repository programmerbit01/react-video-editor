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

/**
 * Render caption overlays with per-word karaoke highlighting.
 * Returns one "base" overlay (full caption, no highlight) plus one overlay per word
 * (full caption with that word highlighted), each enabled only during that word's time window.
 */
async function generateHighlightedCaptionOverlays(
  captionItem: any,
  outW: number,
  outH: number,
  canvasW: number,
  tmpDir: string,
  capIdx: number,
): Promise<{ path: string; fromS: number; toS: number }[]> {
  const { createCanvas } = await import("@napi-rs/canvas");

  const words: any[] = Array.isArray(captionItem.details?.words) ? captionItem.details.words : [];
  const text = String(captionItem.details?.text || "").trim();
  if (!text) return [];

  const rawFontSize = Number(captionItem.details?.fontSize || 22);
  const fontSize = Math.max(8, Math.round(rawFontSize * outW / canvasW));
  const color = String(captionItem.details?.color || "#FFFFFF");
  const activeColor = String(captionItem.details?.activeColor || color);
  const activeFillColor = String(captionItem.details?.activeFillColor || "transparent");
  const topStr = String(captionItem.details?.top || "80%");
  const topFrac = topStr.endsWith("%") ? parseFloat(topStr) / 100 : 0.8;

  const fromS = Number(captionItem.display?.from || 0) / 1000;
  const toS = Number(captionItem.display?.to || 0) / 1000;
  const hasWordHighlight = words.length > 0 && activeColor !== color;

  const drawCaption = async (activeWordIdx: number | null, outPath: string) => {
    const canvas = createCanvas(outW, outH);
    const ctx = canvas.getContext("2d");
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textBaseline = "alphabetic";

    const wordTokens = words.length > 0
      ? words.map((w: any) => String(w.word || ""))
      : text.split(/\s+/);
    const wordWidths = wordTokens.map((wt: string) => ctx.measureText(wt).width);
    const spaceW = ctx.measureText(" ").width;

    // Word-wrap into lines tracking global word indices
    const maxLineW = outW * 0.85;
    const lines: { tokens: string[]; widths: number[]; indices: number[] }[] = [];
    let cur: { tokens: string[]; widths: number[]; indices: number[]; w: number } =
      { tokens: [], widths: [], indices: [], w: 0 };
    for (let i = 0; i < wordTokens.length; i++) {
      const addW = cur.tokens.length > 0 ? spaceW + wordWidths[i] : wordWidths[i];
      if (cur.tokens.length > 0 && cur.w + addW > maxLineW) {
        lines.push({ tokens: cur.tokens, widths: cur.widths, indices: cur.indices });
        cur = { tokens: [wordTokens[i]], widths: [wordWidths[i]], indices: [i], w: wordWidths[i] };
      } else {
        cur.tokens.push(wordTokens[i]); cur.widths.push(wordWidths[i]);
        cur.indices.push(i); cur.w += addW;
      }
    }
    if (cur.tokens.length) lines.push({ tokens: cur.tokens, widths: cur.widths, indices: cur.indices });

    const lineH = fontSize * 1.35;
    const startY = Math.round(topFrac * outH);

    for (let li = 0; li < lines.length; li++) {
      const { tokens, widths, indices } = lines[li];
      const lineW = widths.reduce((a: number, b: number) => a + b, 0) + spaceW * Math.max(0, tokens.length - 1);
      let x = Math.max(4, (outW - lineW) / 2);
      const y = startY + (li + 1) * lineH;

      for (let wi2 = 0; wi2 < tokens.length; wi2++) {
        const globalWi = indices[wi2];
        const isActive = globalWi === activeWordIdx;
        const wW = widths[wi2];

        if (isActive) {
          const solidFill = activeFillColor !== "transparent"
            && activeFillColor !== "rgba(0,0,0,0)"
            && !activeFillColor.startsWith("rgba(0,0,0,0)");
          if (solidFill) {
            ctx.save();
            ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
            ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
            ctx.fillStyle = activeFillColor;
            const pad = Math.max(2, Math.round(fontSize * 0.12));
            ctx.fillRect(x - pad, y - fontSize - pad, wW + pad * 2, fontSize + pad * 2 + 2);
            ctx.restore();
          }
          ctx.shadowColor = "rgba(0,0,0,0.95)";
          ctx.shadowBlur = 8;
          ctx.shadowOffsetX = 2;
          ctx.shadowOffsetY = 2;
          ctx.fillStyle = activeColor;
        } else {
          ctx.shadowColor = "rgba(0,0,0,0.95)";
          ctx.shadowBlur = 8;
          ctx.shadowOffsetX = 2;
          ctx.shadowOffsetY = 2;
          ctx.fillStyle = color;
        }
        ctx.fillText(tokens[wi2], x, y);
        x += wW + (wi2 < tokens.length - 1 ? spaceW : 0);
      }
    }

    await writeFile(outPath, await canvas.encode("png"));
  };

  const overlays: { path: string; fromS: number; toS: number }[] = [];

  // Base overlay — full caption in normal color, covers the whole caption window
  const basePath = path.join(tmpDir, `cap_${capIdx}_base.png`);
  await drawCaption(null, basePath);
  overlays.push({ path: basePath, fromS, toS });

  // Per-word highlighted overlays — generated in parallel for speed
  if (hasWordHighlight) {
    const firstWordMs = Number(words[0]?.start ?? 0);
    const offsetMs = (captionItem.display?.from ?? 0) - firstWordMs;
    const wordTasks = words.map(async (w: any, wi: number) => {
      const wFromS = Math.max(fromS, (Number(w.start ?? 0) + offsetMs) / 1000);
      const wToS = Math.min(toS, (Number(w.end ?? 0) + offsetMs) / 1000);
      if (wToS <= wFromS + 0.01) return null;
      const wPath = path.join(tmpDir, `cap_${capIdx}_w${wi}.png`);
      await drawCaption(wi, wPath);
      return { path: wPath, fromS: wFromS, toS: wToS };
    });
    const results = await Promise.all(wordTasks);
    for (const r of results) { if (r) overlays.push(r); }
  }

  return overlays;
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
    const wordOverlays = await generateHighlightedCaptionOverlays(
      captionItems[i], outW, outH, canvasW, tmpDir, i,
    );
    captionOverlays.push(...wordOverlays);
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
