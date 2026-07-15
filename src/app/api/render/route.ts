import { NextResponse } from "next/server";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir, rm, readFile } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import os from "os";

import { jobs } from "./jobs";
import { ensureCached, cacheFilePath } from "@/utils/asset-cache-store";

const execFileAsync = promisify(execFile);

const EDITOR_BASE = (
  process.env.EDITOR_INTERNAL_ORIGIN ?? "http://127.0.0.1:3001/editor"
).replace(/\/$/, "");
const CALLBACK_BASE = (
  process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091"
).replace(/\/+$/, "");
const DEFAULT_FPS = 30;

function mergeJob(jobId: string, patch: Record<string, unknown>) {
  const current = jobs.get(jobId) ?? { status: "PENDING", progress: 0 };
  jobs.set(jobId, { ...current, ...patch });
}

function appendJobLog(jobId: string, line: string) {
  const current = jobs.get(jobId) ?? { status: "PENDING", progress: 0 };
  const prev = Array.isArray((current as any).log) ? (current as any).log : [];
  const next = [...prev, line].slice(-50);
  jobs.set(jobId, { ...current, log: next });
}

// Stage timeline — same shape the Remotion path emits so the report card shows FF
// stage-by-stage (Download / Captions / Filter / Encode) with live detail + timings,
// instead of a single bar that looks frozen while media downloads.
const _stageStart = new Map<string, Map<string, number>>();
function startStage(jobId: string, name: string, detail?: string) {
  const j = jobs.get(jobId) as any;
  const stages = [...((j?.stages as any[]) ?? []), { name, status: "running", detail }];
  let m = _stageStart.get(jobId); if (!m) { m = new Map(); _stageStart.set(jobId, m); }
  m.set(name, Date.now());
  mergeJob(jobId, { stages });
  appendJobLog(jobId, `▶ ${name}${detail ? " · " + detail : ""}`);
}
function updateStage(jobId: string, name: string, patch: Record<string, unknown>) {
  const j = jobs.get(jobId) as any;
  const stages = ((j?.stages as any[]) ?? []).map((s) => (s.name === name ? { ...s, ...patch } : s));
  mergeJob(jobId, { stages });
}
function endStage(jobId: string, name: string, status: "done" | "failed" = "done", detail?: string) {
  const j = jobs.get(jobId) as any;
  const t0 = _stageStart.get(jobId)?.get(name);
  const ms = t0 ? Date.now() - t0 : undefined;
  const stages = ((j?.stages as any[]) ?? []).map((s) =>
    s.name === name ? { ...s, status, ms, ...(detail ? { detail } : {}) } : s,
  );
  mergeJob(jobId, { stages });
  appendJobLog(jobId, `${status === "done" ? "✓" : "✕"} ${name}${ms != null ? " · " + (ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s") : ""}${detail ? " · " + detail : ""}`);
}

// Run ffmpeg with `-progress pipe:1` so the encode reports LIVE frame/fps/time/speed
// (ffmpeg's single pass is FF's equivalent of Remotion's "Render frames" stage). Rejects
// with the stderr tail on a non-zero exit. onProgress fires on each ffmpeg progress block.
function runFfmpegProgress(
  args: string[],
  totalSec: number,
  onProgress: (p: { frame?: number; fps?: number; timeSec: number; speed?: string; pct: number }) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-progress", "pipe:1", "-nostats", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrTail = "", buf = "";
    let frame: number | undefined, fps: number | undefined, speed: string | undefined, timeSec = 0;
    const timeout = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} reject(new Error("ffmpeg timeout (1h)")); }, 3_600_000);
    proc.stdout?.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const idx = line.indexOf("=");
        if (idx < 0) continue;
        const k = line.slice(0, idx).trim(), v = line.slice(idx + 1).trim();
        if (k === "frame") frame = parseInt(v, 10) || frame;
        else if (k === "fps") fps = parseFloat(v) || fps;
        else if (k === "speed") speed = v;
        else if (k === "out_time") {
          const m = v.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
          if (m) timeSec = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
        } else if (k === "progress") {
          const pct = totalSec > 0 ? Math.min(100, Math.round((timeSec / totalSec) * 100)) : 0;
          onProgress({ frame, fps, timeSec, speed, pct });
        }
      }
    });
    proc.stderr?.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    proc.on("error", (e) => { clearTimeout(timeout); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderrTail || `ffmpeg exited ${code}`));
    });
  });
}

function pickVideoEncoder(
  useNvenc: boolean,
  quality: string,
  preset: string,
  crf: string,
) {
  if (useNvenc) {
    return {
      args: [
        "-c:v", "h264_nvenc",
        "-rc", "constqp",
        "-qp", crf,
        "-preset", "p2",
        "-pix_fmt", "yuv420p",
        "-profile:v", "high",
      ],
      label: "nvenc",
    };
  }

  return {
    args: [
      "-c:v", "libx264",
      "-preset", preset,
      "-crf", crf,
      "-pix_fmt", "yuv420p",
    ],
    label: quality === "high" ? "libx264-fast" : "libx264",
  };
}

function notifyRenderCallback(payload: Record<string, unknown>) {
  fetch(`${CALLBACK_BASE}/vapp/render_callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

async function registerRenderJob(payload: Record<string, unknown>) {
  const res = await fetch(`${CALLBACK_BASE}/vapp/register_render_job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`register_render_job ${res.status}`);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { design, options } = body;
    if (!design) return NextResponse.json({ message: "design required" }, { status: 400 });

    const jobId = randomBytes(8).toString("hex");
    mergeJob(jobId, {
      status: "PENDING",
      progress: 0,
      engine: "ffmpeg",
      source: "editor-manual",
      project_name: "User Export",
      started_at: Math.floor(Date.now() / 1000),
    });
    appendJobLog(jobId, "FF render queued");
    // Pull mode (skipCallback): the render agent registers + reports on its source vApp,
    // so the editor skips its own push-tracking registration + callbacks here.
    const skipCallback = !!options?.skipCallback;
    if (!skipCallback) {
      // Fire-and-forget: do NOT await. This posts to the shared render widget on the
      // vApp server, which can be slow or timing out — awaiting it stalled the jobId
      // response, so the browser sat at 0% for the whole registration timeout before it
      // could even start polling. The render itself doesn't depend on this.
      registerRenderJob({
        job_id: jobId,
        engine: "ffmpeg",
        source: "editor-manual",
        project_name: "User Export",
      })
        .then(() => appendJobLog(jobId, "registered in shared render widget"))
        .catch((err) => appendJobLog(jobId, `register failed: ${String(err)}`));
    }

    runExport(
      jobId,
      design,
      options?.quality ?? "high",
      options?.format ?? "mp4",
      options?.maxDim,
      options?.mutedTrackIds ?? [],
      skipCallback,
    ).catch((err) => {
      console.error(`[render] job ${jobId} failed:`, err);
      const current = jobs.get(jobId);
      mergeJob(jobId, {
        status: "FAILED",
        progress: current?.progress ?? 0,
        error: err.message,
      });
      if (!skipCallback) notifyRenderCallback({ job_id: jobId, status: "FAILED", error: err.message });
    })
    .finally(() => {
      // Always remove the scratch frame dir — on success AND on failure/abort — so
      // public/exports never accumulates leftover tmp_<jobId> frame folders again.
      rm(path.join(process.cwd(), "public", "exports", `tmp_${jobId}`), {
        recursive: true,
        force: true,
      }).catch(() => {});
      _stageStart.delete(jobId); // drop the per-job stage timers
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
    ? path.join(
        process.cwd(),
        "public",
        sourceUrl.startsWith("/editor/") ? sourceUrl.replace(/^\/editor/, "") : sourceUrl
      )
    : sourceUrl;
  const buf = await readFile(localPath);
  await writeFile(dest, buf);
}

function unwrapProxyMediaUrl(url: string): string {
  const raw = String(url || "");
  if (!raw) return raw;
  try {
    const parsed = raw.startsWith("http://") || raw.startsWith("https://")
      ? new URL(raw)
      : new URL(raw, "http://local.test");
    if (parsed.pathname.endsWith("/api/proxy")) {
      const inner = parsed.searchParams.get("url");
      if (inner) return inner;
    }
  } catch {}
  return raw;
}

function detectMediaExtension(url: string): string {
  const unwrapped = unwrapProxyMediaUrl(url);
  const pathOnly = unwrapped.split("?")[0] || "";
  return pathOnly.split(".").pop()?.toLowerCase() ?? "";
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
  high:   { crf: "18", preset: "veryfast" },
  medium: { crf: "23", preset: "veryfast" },
  low:    { crf: "28", preset: "veryfast" },
};

// Cache GPU detection result for the lifetime of the process
let _gpuAvailable: boolean | null = null;
async function hasNvencGpu(): Promise<boolean> {
  if (_gpuAvailable !== null) return _gpuAvailable;
  try {
    // Probe NVENC with a real HD frame size. Tiny synthetic sizes like 64x64 can
    // fail on some NVIDIA stacks with "Frame Dimension less than the minimum
    // supported value", which falsely looks like "no GPU available".
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-f", "lavfi", "-i", "testsrc2=s=1280x720:d=0.2:r=30",
      "-c:v", "h264_nvenc", "-f", "null", "-"
    ], { timeout: 8000 });
    _gpuAvailable = true;
  } catch (err: any) {
    _gpuAvailable = false;
    const stderr = String(err?.stderr || err?.stdout || err?.message || "")
      .trim()
      .split("\n")
      .slice(-8)
      .join("\n");
    console.warn("[render] NVENC probe failed:", stderr || "unknown error");
  }
  console.log(`[render] NVENC GPU: ${_gpuAvailable ? "available ✓" : "not found, using libx264"}`);
  return _gpuAvailable;
}

function buildKenBurnsFilter(
  details: any,
  clipDurS: number,
  outW: number,
  outH: number,
): string | null {
  const kind = String(details?.kenBurns || "off");
  if (!kind || kind === "off") return null;

  const intensityPct = Math.max(1, Math.min(40, Number(details?.kenBurnsIntensity ?? 8)));
  const durationPct = Math.max(5, Math.min(100, Number(details?.kenBurnsDuration ?? 100)));
  const totalFrames = Math.max(1, Math.round(clipDurS * DEFAULT_FPS));
  const zt = intensityPct / 100;
  const motionFrames = Math.max(1, Math.round(totalFrames * (durationPct / 100)));
  const maxZoom = (1 + zt).toFixed(4);
  const progress = `min(on\\,${motionFrames})/${motionFrames}`;
  const centerX = "iw/2-(iw/zoom/2)";
  const centerY = "ih/2-(ih/zoom/2)";
  const scaledW = Math.max(outW, Math.round(outW * 1.25));

  let z = `min(1+${zt.toFixed(4)}*${progress},${maxZoom})`;
  let x = centerX;
  let y = centerY;

  switch (kind) {
    case "zoomIn":
      break;
    case "zoomOut":
      z = `max(${maxZoom}-${zt.toFixed(4)}*${progress},1)`;
      break;
    case "panRight":
      z = maxZoom;
      x = `(iw-iw/zoom)*${progress}`;
      break;
    case "panLeft":
      z = maxZoom;
      x = `(iw-iw/zoom)*(1-${progress})`;
      break;
    case "panDown":
      z = maxZoom;
      y = `(ih-ih/zoom)*${progress}`;
      break;
    case "panUp":
      z = maxZoom;
      y = `(ih-ih/zoom)*(1-${progress})`;
      break;
    case "zoomInPanLeft":
      x = `(iw-iw/zoom)*(1-${progress})`;
      break;
    case "zoomInPanRight":
      x = `(iw-iw/zoom)*${progress}`;
      break;
    default:
      return null;
  }

  return `scale=${scaledW}:-1,zoompan=z='${z}':x='${x}':y='${y}':d=${totalFrames}:s=${outW}x${outH}:fps=${DEFAULT_FPS},setsar=1`;
}

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

/** Format a time value safely for FFmpeg — avoids scientific notation that FFmpeg can't parse */
const fmtT = (s: number) => (Math.abs(s) < 1e-9 ? "0" : s.toFixed(6));

/**
 * Build FFmpeg fade filter string for items with fadeIn/fadeOut animations.
 * Returns a comma-prefixed filter chain segment (e.g. ",fade=t=in:st=2:d=0.5")
 * or empty string if no fade animation is set.
 * Applies AFTER scale so PTS is already shifted to displayFromS.
 */
function getFadeFilters(item: any, displayFromS: number, clipDurS: number): string {
  const animIn = item.animations?.in;
  const animOut = item.animations?.out;
  const fadeInDurS =
    animIn?.name === "fadeIn" && (animIn.composition?.[0]?.durationInFrames ?? 0) > 0
      ? animIn.composition[0].durationInFrames / 30
      : 0;
  const fadeOutDurS =
    animOut?.name === "fadeOut" && (animOut.composition?.[0]?.durationInFrames ?? 0) > 0
      ? animOut.composition[0].durationInFrames / 30
      : 0;

  const parts: string[] = [];
  if (fadeInDurS > 0) {
    const d = fmtT(Math.min(fadeInDurS, clipDurS));
    parts.push(`fade=t=in:st=${fmtT(displayFromS)}:d=${d}`);
  }
  if (fadeOutDurS > 0) {
    const d = Math.min(fadeOutDurS, clipDurS);
    const st = fmtT(displayFromS + clipDurS - d);
    parts.push(`fade=t=out:st=${st}:d=${fmtT(d)}`);
  }
  return parts.length > 0 ? `,${parts.join(",")}` : "";
}

async function runExport(
  jobId: string,
  design: any,
  quality = "high",
  format = "mp4",
  maxDim?: number,
  mutedTrackIds: string[] = [],
  skipCallback = false,
) {
  const startedAt = Date.now();
  const exportsDir = path.join(process.cwd(), "public", "exports");
  const tmpDir = path.join(exportsDir, `tmp_${jobId}`);
  await mkdir(exportsDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  // JSON export
  if (format === "json") {
    const outputPath = path.join(exportsDir, `${jobId}.json`);
    await writeFile(outputPath, JSON.stringify(design, null, 2));
    mergeJob(jobId, { status: "COMPLETED", progress: 100, url: `/exports/${jobId}.json` });
    return;
  }

  const { crf, preset } = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.high;
  const { trackItemsMap, trackItemIds, size, tracks } = design;
  const platformPreset = PLATFORM_PRESETS[format];

  // Build itemId → trackId map for mute checks
  const itemTrackMap: Record<string, string> = {};
  if (Array.isArray(tracks)) {
    for (const track of tracks) {
      if (Array.isArray(track.items)) {
        for (const itemId of track.items) {
          itemTrackMap[itemId] = track.id;
        }
      }
    }
  }
  const mutedSet = new Set(mutedTrackIds);

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
  const totalCores = os.cpus()?.length || 0;

  const videoItems = allItems
    .filter((it: any) => it.type === "video" || it.type === "image")
    .sort((a: any, b: any) => (a.display?.from ?? 0) - (b.display?.from ?? 0));

  const audioItems = allItems
    .filter((it: any) => it.type === "audio")
    .sort((a: any, b: any) => (a.display?.from ?? 0) - (b.display?.from ?? 0));

  appendJobLog(jobId, `timeline ${videoItems.length} visual items, ${audioItems.length} audio items, total ${totalSec.toFixed(2)}s`);

  if (videoItems.length === 0 && audioItems.length === 0) {
    mergeJob(jobId, { status: "FAILED", progress: 0, error: "No media items in timeline" });
    return;
  }

  mergeJob(jobId, { status: "PROCESSING", progress: 5 });

  // ─── Download all media ───────────────────────────────────────────────────

  interface MediaEntry {
    path: string;
    item: any;
    kind: "video" | "audio";
    isImage: boolean;
    hasAudio: boolean;
  }
  const allMedia = [...videoItems, ...audioItems];

  // Download media through a CONCURRENCY-CAPPED pool — NOT one big Promise.all.
  // Firing 200+ simultaneous TLS handshakes at a CDN (R2/Cloudflare) makes cold
  // connects time out en masse, so every file comes back "fetch failed" even though
  // each URL is perfectly reachable one at a time. The Remotion path already batches
  // via RENDER_CONCURRENCY; FF must too. 8 in flight keeps the pipe busy without
  // stampeding the origin.
  mergeJob(jobId, { status: "PROCESSING", progress: 5 });
  let dlOk = 0, dlFail = 0, dlDone = 0, dlHit = 0;
  const DL_CONCURRENCY = Math.max(4, Math.min(8, totalCores || 8));
  const downloadOne = async (item: any, i: number): Promise<MediaEntry | null> => {
    // Unwrap legacy /api/proxy?url=… wrappers so we fetch the real asset directly
    // (the render-remotion path already does this; FF must too or it 404s on the
    // proxy). rawSrc may be a full proxied URL or a bare relative one.
    const rawSrc: string = item.details?.src || item.details?.url || "";
    const src = unwrapProxyMediaUrl(rawSrc);
    if (!src) { dlFail++; appendJobLog(jobId, `⬇ skip [${item.type}] no src on item ${item.id ?? i}`); return null; }
    const kind: "video" | "audio" = item.type === "audio" ? "audio" : "video";
    try {
      let filePath: string;
      if (/^https?:\/\//i.test(src)) {
        // Reuse the SHARED asset cache the Remotion path fills (.asset-cache/). If the
        // project was localized for an RE render the files are already on disk → instant
        // HIT, no network at all. That's WHY RE "just works" and FF used to re-hammer the
        // CDN. ensureCached dedups + downloads once on a miss; the outer pool caps how
        // many misses fetch at once so we never stampede the origin.
        const { key, hit } = await ensureCached(src);
        filePath = cacheFilePath(key);
        if (hit) dlHit++;
      } else {
        // Local/relative (/api/…, public paths) — not an R2 asset; fetch into tmp.
        const rawExt = detectMediaExtension(src) || "mp4";
        const safeExt = ["mp4", "mov", "webm", "mp3", "wav", "aac", "ogg", "m4a",
          "jpg", "jpeg", "png", "webp"].includes(rawExt) ? rawExt : "mp4";
        filePath = path.join(tmpDir, `media_${i}.${safeExt}`);
        await fetchToFile(src, filePath);
      }
      dlOk++;
      const isImage = item.type === "image" || /\.(jpe?g|png|webp)$/i.test(filePath);
      const hasAudio = kind === "audio" ? true : (!isImage && await hasAudioStream(filePath));
      return { path: filePath, item, kind, isImage, hasAudio } as MediaEntry;
    } catch (err) {
      // Surface the actual reason in the job log so a broken/expired/private URL
      // is visible in the export report instead of a silent "no media" failure.
      dlFail++;
      const reason = String((err as any)?.message ?? err);
      console.error(`[render] skipping ${src}: ${reason}`);
      appendJobLog(jobId, `⬇ failed [${item.type}] ${src.slice(0, 160)} — ${reason.slice(0, 160)}`);
      return null;
    }
  };
  // Fixed-size worker pool over a shared cursor. The Download stage updates LIVE as each
  // file lands (X/Y · cached · failed) so the report keeps moving instead of sitting on
  // one static "downloading" line for minutes.
  const entryResults: (MediaEntry | null)[] = new Array(allMedia.length).fill(null);
  let cursor = 0;
  startStage(jobId, "Download", `0/${allMedia.length} · ${DL_CONCURRENCY} at a time`);
  await Promise.all(
    Array.from({ length: Math.min(DL_CONCURRENCY, allMedia.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= allMedia.length) return;
        entryResults[i] = await downloadOne(allMedia[i], i);
        dlDone++;
        updateStage(jobId, "Download", { detail: `${dlDone}/${allMedia.length} · ${dlHit} cached · ${dlFail} failed` });
        // Nudge progress 5→45% across the download phase so the bar moves.
        mergeJob(jobId, { status: "PROCESSING", progress: 5 + Math.round((dlDone / allMedia.length) * 40) });
      }
    }),
  );
  const entries: MediaEntry[] = entryResults.filter(Boolean) as MediaEntry[];
  endStage(jobId, "Download", dlOk > 0 ? "done" : "failed", `${dlOk}/${allMedia.length} · ${dlHit} cached · ${dlOk - dlHit} pulled · ${dlFail} failed`);

  if (entries.length === 0) {
    const cur = jobs.get(jobId);
    mergeJob(jobId, {
      status: "FAILED",
      progress: cur?.progress ?? 0,
      error: `Could not download any media files (${dlFail}/${allMedia.length} failed — see log for URLs/reasons)`,
    });
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

  // Generate all caption PNGs in parallel across caption items
  if (captionItems.length) startStage(jobId, "Captions", `${captionItems.length} items`);
  const allWordOverlays = await Promise.all(
    captionItems.map((item: any, i: number) =>
      generateHighlightedCaptionOverlays(item, outW, outH, canvasW, tmpDir, i)
    )
  );
  for (const overlays of allWordOverlays) captionOverlays.push(...overlays);
  if (captionItems.length) endStage(jobId, "Captions", "done", `${captionOverlays.length} overlays`);

  mergeJob(jobId, { status: "PROCESSING", progress: 50 });

  // ─── Build FFmpeg filter_complex ─────────────────────────────────────────
  startStage(jobId, "Filter graph");
  const ffmpegArgs: string[] = ["-y"];

  // Input 0: base black canvas
  ffmpegArgs.push(
    "-f", "lavfi",
    "-i", `color=black:size=${outW}x${outH}:r=${DEFAULT_FPS}:d=${totalSec}`,
  );

  // Add all media inputs (inputs 1..N)
  for (const entry of entries) {
    if (entry.isImage) {
      const clipDurS = Math.max(
        0.1,
        ((entry.item.display?.to ?? 0) - (entry.item.display?.from ?? 0)) / 1000,
      );
      ffmpegArgs.push("-loop", "1", "-t", String(clipDurS), "-i", entry.path);
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
    const trimFromRaw  = Math.max(0, Number(item.trim?.from ?? 0) / 1000);
    const trimFromS    = Math.abs(trimFromRaw) < 1e-9 ? 0 : trimFromRaw;
    const clipDurS     = displayToS - displayFromS;
    const trimToS      = trimFromS + clipDurS;
    const delayMs      = Math.round(displayFromS * 1000);

    const trackId = itemTrackMap[item.id] ?? "";
    const trackMuted = mutedSet.has(trackId);

    if (entry.kind === "video") {
      const fadeFilters = getFadeFilters(item, displayFromS, clipDurS);
      if (entry.isImage) {
        const kbFilter = buildKenBurnsFilter(item.details, clipDurS, outW, outH);
        if (kbFilter) {
          appendJobLog(
            jobId,
            `kenBurns ${item.id || inputIdx}: ${String(item.details?.kenBurns)} intensity=${Number(item.details?.kenBurnsIntensity ?? 8)} duration=${Number(item.details?.kenBurnsDuration ?? 100)}`,
          );
        } else {
          appendJobLog(jobId, `static image ${item.id || inputIdx}: no kenBurns`);
        }
        filterParts.push(
          `[${inputIdx}:v]${kbFilter ?? `scale=${outW}:${outH}`},setpts=PTS-STARTPTS+${fmtT(displayFromS)}/TB${fadeFilters}[v${inputIdx}]`,
        );
      } else {
        filterParts.push(
          `[${inputIdx}:v]trim=start=${fmtT(trimFromS)}:end=${fmtT(trimToS)},setpts=PTS-STARTPTS+${fmtT(displayFromS)}/TB,scale=${outW}:${outH}${fadeFilters}[v${inputIdx}]`,
        );
      }
      videoOverlays.push({ vLabel: `v${inputIdx}`, from: displayFromS, to: displayToS });

      if (entry.hasAudio) {
        const vol = trackMuted ? 0 : Math.max(0, Number(item.details?.volume ?? 100) / 100);
        filterParts.push(
          `[${inputIdx}:a]atrim=start=${fmtT(trimFromS)}:end=${fmtT(trimToS)},` +
          `asetpts=PTS-STARTPTS,` +
          `volume=${vol},` +
          `adelay=${delayMs}|${delayMs},` +
          `aformat=channel_layouts=stereo:sample_rates=48000[va${inputIdx}]`,
        );
        audioLabels.push(`va${inputIdx}`);
      }
    } else {
      // Audio-only track
      const vol = trackMuted ? 0 : Math.max(0, Number(item.details?.volume ?? 100) / 100);
      filterParts.push(
        `[${inputIdx}:a]atrim=start=${fmtT(trimFromS)}:end=${fmtT(trimToS)},` +
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

  // Big timelines (dozens of Ken Burns / caption zoompan nodes) build a filter graph
  // that is tens/hundreds of KB. Passing it inline as a `-filter_complex` argv value
  // blows past the OS argv size limit → `spawn E2BIG` and the whole export dies.
  // Write the graph to a file and reference it with `-filter_complex_script` so argv
  // stays tiny (just the input paths) no matter how many items are on the timeline.
  const filterGraph = filterParts.join(";");
  const filterScriptPath = path.join(tmpDir, "filtergraph.txt");
  await writeFile(filterScriptPath, filterGraph, "utf8");
  endStage(jobId, "Filter graph", "done", `${filterParts.length} nodes · ${(filterGraph.length / 1024).toFixed(1)}KB → script file`);
  ffmpegArgs.push("-filter_complex_script", filterScriptPath);
  ffmpegArgs.push("-map", `[${finalVideoLabel}]`);
  if (hasAudio) ffmpegArgs.push("-map", "[aout]");

  // Codec args — prefer NVENC if GPU is available, fallback to libx264
  const useNvenc = !platformPreset && await hasNvencGpu();
  const encoder = pickVideoEncoder(useNvenc, quality, preset, crf);
  const gpuLabel = platformPreset ? "preset" : useNvenc ? "nvenc" : "cpu";
  const hwAccel = platformPreset ? "preset" : useNvenc ? "gpu" : "cpu";
  mergeJob(jobId, {
    ...(jobs.get(jobId) ?? { status: "PROCESSING", progress: 60 }),
    status: "PROCESSING",
    progress: 60,
    engine: "ffmpeg",
    source: "editor-manual",
    project_name: "User Export",
    started_at: Math.floor(startedAt / 1000),
    video_seconds: Math.round(totalSec),
    gpu: gpuLabel,
    hwAccel,
    cores: totalCores,
    encoder: platformPreset ? "platform-preset" : encoder.label,
  });
  appendJobLog(jobId, `encoder=${platformPreset ? "platform-preset" : encoder.label} gpu=${gpuLabel} cores=${totalCores}`);
  if (platformPreset) {
    ffmpegArgs.push(...platformPreset.videoArgs);
    if (hasAudio) ffmpegArgs.push(...platformPreset.audioArgs);
  } else {
    ffmpegArgs.push(...encoder.args);
    if (hasAudio) {
      ffmpegArgs.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
    }
  }

  ffmpegArgs.push("-t", String(totalSec), "-movflags", "+faststart");

  const outputPath = path.join(exportsDir, `${jobId}.mp4`);
  ffmpegArgs.push(outputPath);

  startStage(jobId, "Encode", `${platformPreset ? "platform-preset" : encoder.label} · ${totalSec.toFixed(1)}s @ ${outW}x${outH}`);
  mergeJob(jobId, { status: "PROCESSING", progress: 60 });

  let lastEncPct = 0;
  try {
    await runFfmpegProgress(ffmpegArgs, totalSec, ({ frame, fps, timeSec, speed, pct }) => {
      // Live encode detail — frame/fps/time/speed, like Remotion's render-frames line.
      const detail =
        `${pct}% · ${timeSec.toFixed(1)}/${totalSec.toFixed(0)}s` +
        (frame != null ? ` · frame ${frame}` : "") +
        (fps != null ? ` · ${fps.toFixed(0)} fps` : "") +
        (speed ? ` · ${speed}` : "");
      updateStage(jobId, "Encode", { detail });
      // Overall bar: encode occupies 60→95%.
      mergeJob(jobId, { status: "PROCESSING", progress: 60 + Math.round((pct / 100) * 35) });
      if (pct - lastEncPct >= 20) { lastEncPct = pct; appendJobLog(jobId, `encoding ${detail}`); }
    });
  } catch (ffErr: any) {
    const cur = jobs.get(jobId);
    const msg = String(ffErr?.message || "FFmpeg failed");
    endStage(jobId, "Encode", "failed", msg.slice(0, 120));
    mergeJob(jobId, { status: "FAILED", progress: cur?.progress ?? 60, error: msg });
    appendJobLog(jobId, `FAILED: ${msg}`);
    if (!skipCallback) notifyRenderCallback({ job_id: jobId, status: "FAILED", error: msg });
    return;
  }
  endStage(jobId, "Encode", "done");

  const renderSecs = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const speedX = totalSec / renderSecs;
  mergeJob(jobId, {
    status: "COMPLETED",
    progress: 100,
    url: `/exports/${jobId}.mp4`,
    engine: "ffmpeg",
    source: "editor-manual",
    project_name: "User Export",
    started_at: Math.floor(startedAt / 1000),
    video_seconds: Math.round(totalSec),
    render_seconds: Math.round(renderSecs),
    speed_x: Math.round(speedX * 100) / 100,
    encoder: platformPreset ? "platform-preset" : encoder.label,
    gpu: gpuLabel,
    hwAccel,
    cores: totalCores,
  });
  appendJobLog(jobId, `completed render=${Math.round(renderSecs)}s speed=${(Math.round(speedX * 100) / 100).toFixed(2)}x`);
  // Pull mode (skipCallback): the agent owns upload+report — editor must not double-callback.
  if (!skipCallback) notifyRenderCallback({
    job_id: jobId,
    status: "COMPLETED",
    video_url: `${EDITOR_BASE}/api/render/${jobId}/download`,
  });

  // Scratch dir (tmp_<jobId>) is removed by the caller's .finally() — covers success AND failure.
}
