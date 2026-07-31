import { NextResponse } from "next/server";
import { describeFfDropped, ffDroppedItems } from "@/features/editor/item-types";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir, rm, readFile } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import os from "os";

import { jobs, jobChildren } from "./jobs";
import { readExportSettings, clampRamBudget } from "../admin/export-settings-store";
import { ensureCached, cacheFilePath } from "@/utils/asset-cache-store";
import { publicPath } from "@/utils/server-paths";
import { readJsonBody } from "@/utils/request-body";
import { generateTextOverlay } from "./text-overlay";
import { atempoChain, buildFfmpegVolumeExpr, safeRate } from "@/features/editor/utils/volume-envelope";

const execFileAsync = promisify(execFile);

const EDITOR_BASE = (
  process.env.EDITOR_INTERNAL_ORIGIN ?? "http://127.0.0.1:3001/editor"
).replace(/\/$/, "");
const CALLBACK_BASE = (
  process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091"
).replace(/\/+$/, "");
const DEFAULT_FPS = 30;
// Ken Burns supersample factor — ONE source so the render and its log can never disagree
// (they did: the render used 4× while the log still printed "2x"). See buildKenBurnsFilter.
const KENBURNS_SUPERSAMPLE = Math.max(1.5, Number(process.env.FF_KENBURNS_SUPERSAMPLE) || 4);
// Video Ken Burns is lighter: the video's own motion + detail hide the sub-pixel stepping that
// forced 4× on stills, so 2× is enough — and every video frame is unique (no looped still), so
// the supersample cost is real per frame. Measured cost per KB'd video segment: 2.2× at 2×,
// 5.4× at 4×. Only clips with kenBurns set pay it; the rest are untouched. Tunable.
const KENBURNS_SUPERSAMPLE_VIDEO = Math.max(1, Number(process.env.FF_KENBURNS_SUPERSAMPLE_VIDEO) || 2);

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

// Live system-RAM snapshot for the export log — so a RAM spike is visible per-stage and we
// can see which phase (captions / segments) drives it, and whether it grows (leak) or holds.
function ramLine(): string {
  const total = os.totalmem() / 1073741824;
  const free = os.freemem() / 1073741824;
  return `📊 RAM ${(total - free).toFixed(1)}/${total.toFixed(1)}GB used · ${free.toFixed(1)}GB free · rss ${(process.memoryUsage().rss / 1073741824).toFixed(2)}GB`;
}
function logRam(jobId: string, label: string) { appendJobLog(jobId, `${label} — ${ramLine()}`); }

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

/** A render that is still going. There is at most one — see the POST handler. */
function activeRender(): string | null {
  for (const [id, job] of jobs) {
    const s = String(job.status || "").toUpperCase();
    if ((s === "PENDING" || s === "PROCESSING") && !job.cancelled) return id;
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request);
    const { design, options } = body;
    if (!design) return NextResponse.json({ message: "design required" }, { status: 400 });

    // ONE render at a time. Asking for a second hands back the one already going.
    //
    // A box was found with five: three rendering, two queued. Nothing here refused them, and
    // each planned its own RAM budget knowing nothing about the others — so the "5.5GB ceiling"
    // was really 5 × 5.5GB, and the editor died of its own clones. The RAM budget is per-render;
    // this is what makes that true.
    //
    // It happens without anyone doing anything unreasonable: the box gets busy, a status poll
    // times out, the client gives up after 12 tries and says "Lost contact with the render
    // server" — while the render carries on. So you press Export again. Now there are two, the
    // box is slower, the next poll fails sooner. That is the whole spiral.
    //
    // Handing back the running job instead of erroring is deliberate: pressing Export again is
    // how you ask "is it still going?", and now the modal simply re-attaches and shows you.
    const running = activeRender();
    if (running) {
      appendJobLog(running, "↩ export pressed again — reattached to this render (already running)");
      return NextResponse.json({ render: { id: running, reattached: true } }, { status: 200 });
    }

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
      // Budget carried by the job (GUI passes the superadmin setting; a queue/MCP job may
      // carry its own). undefined → runExport reads the machine's saved setting / env / default.
      clampRamBudget(options?.ramBudgetGB) ?? undefined,
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
      rm(publicPath("exports", `tmp_${jobId}`), {
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
    ? publicPath(sourceUrl.startsWith("/editor/") ? sourceUrl.replace(/^\/editor/, "") : sourceUrl)
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
 *
 * Each PNG is cropped to a tight text BAND (not a full 1920×1080 canvas) and returned with the
 * {x,y} at which it must be overlaid. Full-frame caption PNGs were the export's #1 cost: a dense
 * caption becomes N chained overlays each compositing the whole 1080p plane (measured 25s + 5.5GB
 * for a 30-word segment). The visible text is only a ~2-3 line band near `top`, so we render just
 * that band → identical pixels, ~7× less overlay work + RAM.
 */
async function generateHighlightedCaptionOverlays(
  captionItem: any,
  outW: number,
  outH: number,
  canvasW: number,
  tmpDir: string,
  capIdx: number,
  baseOnly: boolean = false,
): Promise<{ path: string; fromS: number; toS: number; x: number; y: number }[]> {
  const { createCanvas } = await import("@napi-rs/canvas");

  const words: any[] = Array.isArray(captionItem.details?.words) ? captionItem.details.words : [];
  const text = String(captionItem.details?.text || "").trim();
  if (!text) return [];

  const rawFontSize = Number(captionItem.details?.fontSize || 22);
  const fontSize = Math.max(8, Math.round(rawFontSize * outW / canvasW));
  const color = String(captionItem.details?.color || "#FFFFFF");
  const activeColor = String(captionItem.details?.activeColor || color);
  // Words already spoken keep this colour in the player (the karaoke "trail"). The export used to
  // ignore it entirely — so any preset whose highlight is the trail (appearedColor ≠ color, active
  // ≠ colour or not) lost its highlight on export. Draw it too; same PNG count, no perf change.
  const appearedColor = String(captionItem.details?.appearedColor || color);
  const activeFillColor = String(captionItem.details?.activeFillColor || "transparent");
  const topStr = String(captionItem.details?.top || "80%");
  const topFrac = topStr.endsWith("%") ? parseFloat(topStr) / 100 : 0.8;

  const fromS = Number(captionItem.display?.from || 0) / 1000;
  const toS = Number(captionItem.display?.to || 0) / 1000;
  const hasWordHighlight = words.length > 0 && (activeColor !== color || appearedColor !== color);

  // ── Layout ONCE (identical for base + every word variant) ────────────────────
  // Only the highlighted word's COLOUR changes between variants, never the geometry,
  // so wrap + word positions are computed a single time and reused for all PNGs.
  const fontSpec = `bold ${fontSize}px sans-serif`;
  const measure = createCanvas(8, 8).getContext("2d");
  measure.font = fontSpec;
  const wordTokens = words.length > 0 ? words.map((w: any) => String(w.word || "")) : text.split(/\s+/);
  const wordWidths = wordTokens.map((wt: string) => measure.measureText(wt).width);
  const spaceW = measure.measureText(" ").width;

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
  const pad = Math.max(2, Math.round(fontSize * 0.12));

  // ── Crop to a tight caption BAND [bandTop, bandTop+bandH) instead of full-frame ──
  // Generous margin covers the shadow (blur 8 + offset 2), the active-word fill rect
  // (extends fontSize+pad above the baseline) and descenders, so text never clips.
  // A caption that genuinely fills the screen just clamps back to full-frame.
  const margin = Math.ceil(fontSize * 0.5) + 14;
  let bandTop = Math.max(0, Math.floor(startY + lineH - fontSize - pad - margin));
  let bandBottom = Math.min(outH, Math.ceil(startY + lines.length * lineH + pad + margin));
  if (bandBottom <= bandTop) bandBottom = Math.min(outH, bandTop + fontSize + margin);
  let bandH = bandBottom - bandTop;
  if (bandH % 2 !== 0) {
    if (bandBottom < outH) bandH++;
    else { bandTop = Math.max(0, bandTop - 1); bandH = bandBottom - bandTop; }
  }

  const drawCaption = async (activeWordIdx: number | null, outPath: string) => {
    const canvas = createCanvas(outW, bandH);
    const ctx = canvas.getContext("2d");
    ctx.translate(0, -bandTop); // draw in full-frame coords; canvas only spans the band
    ctx.font = fontSpec;
    ctx.textBaseline = "alphabetic";

    for (let li = 0; li < lines.length; li++) {
      const { tokens, widths, indices } = lines[li];
      const lineW = widths.reduce((a: number, b: number) => a + b, 0) + spaceW * Math.max(0, tokens.length - 1);
      let x = Math.max(4, (outW - lineW) / 2);
      const y = startY + (li + 1) * lineH;

      for (let wi2 = 0; wi2 < tokens.length; wi2++) {
        const globalWi = indices[wi2];
        const isActive = globalWi === activeWordIdx;
        // Words before the active one are "appeared" (already spoken) — matches the player's
        // active / appeared / upcoming three-state colouring. Base overlay (activeWordIdx === null)
        // has no appeared words, so it stays all-`color`.
        const isAppeared = activeWordIdx !== null && globalWi < activeWordIdx;
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
          ctx.fillStyle = isAppeared ? appearedColor : color;
        }
        ctx.fillText(tokens[wi2], x, y);
        x += wW + (wi2 < tokens.length - 1 ? spaceW : 0);
      }
    }

    await writeFile(outPath, await canvas.encode("png"));
  };

  const overlays: { path: string; fromS: number; toS: number; x: number; y: number }[] = [];

  // Base overlay — full caption in normal color, covers the whole caption window.
  const basePath = path.join(tmpDir, `cap_${capIdx}_base.png`);
  await drawCaption(null, basePath);
  overlays.push({ path: basePath, fromS, toS, x: 0, y: bandTop });

  // Per-word highlighted overlays (parallel) — SKIPPED in baseOnly mode. Each word adds one
  // ffmpeg image input downstream, so on a caption-heavy timeline the caller switches to
  // baseOnly to keep the total input count sane (thousands of PNG inputs otherwise exhaust
  // file descriptors and crash ffmpeg).
  if (hasWordHighlight && !baseOnly) {
    const firstWordMs = Number(words[0]?.start ?? 0);
    const offsetMs = (captionItem.display?.from ?? 0) - firstWordMs;
    // SEQUENTIAL, and it must stay that way.
    //
    // This was Promise.all over the words, which quietly undid the caller's bound: the pool out
    // there admits CAP_CONC captions, each of which then fired ALL of its words at once, so the
    // canvases actually in flight were CAP_CONC × words — 80+ where the caller believed 4.
    //
    // The ceiling that matters is the libuv threadpool (see CAP_CONC): @napi-rs/canvas segfaults
    // above it, and a bound that an inner Promise.all can multiply is not a bound. Capping
    // CAP_CONC alone would not have saved us while this line stayed.
    //
    // Costs nothing: the outer pool still parallelises across captions.
    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi];
      const wFromS = Math.max(fromS, (Number(w.start ?? 0) + offsetMs) / 1000);
      const wToS = Math.min(toS, (Number(w.end ?? 0) + offsetMs) / 1000);
      if (wToS <= wFromS + 0.01) continue;
      const wPath = path.join(tmpDir, `cap_${capIdx}_w${wi}.png`);
      await drawCaption(wi, wPath);
      overlays.push({ path: wPath, fromS: wFromS, toS: wToS, x: 0, y: bandTop });
    }
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
  isVideo = false,
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
  // Supersample the source well above the output before zoompan. zoompan crops at whole INPUT
  // pixels, so its crop origin can only ever advance in integer steps. The default Ken Burns is
  // gentle — 8% over a ~3s clip — which moves that origin well UNDER one pixel per frame, so it
  // sits still, then hops a whole pixel, then sits still. That hop is the shake. Measured in a
  // real export: the motion alternated 0.2px / 1.25px per frame, ±0.55px of wobble. Note the
  // gentler the effect the WORSE it looks, which is why it survived so long — a fast pan hides it.
  //
  // Supersampling shrinks what one input pixel is worth on screen, and it is the only lever
  // zoompan gives us (verified: cropping to a 2× canvas and scaling down changes nothing, and a
  // cheaper scaler doesn't help either — the cost is zoompan's own per-frame downscale). At 4×
  // the wobble drops to ~±0.11px, under a tenth of a pixel; this is also where the ffmpeg
  // community landed with its "scale=8000:-1" recipe. It is NOT quadratic in RAM as the shape of
  // the filter suggests — measured 0.81 → 0.86GB per segment, one extra frame buffer.
  // Tunable via FF_KENBURNS_SUPERSAMPLE (video uses the lighter FF_KENBURNS_SUPERSAMPLE_VIDEO).
  const superSample = isVideo ? KENBURNS_SUPERSAMPLE_VIDEO : KENBURNS_SUPERSAMPLE;
  const scaledW = Math.max(outW, Math.round(outW * superSample));

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

  // Images loop ONE still, so zoompan expands it into all N frames (d=totalFrames). Video already
  // has N distinct frames, so it emits one output per input (d=1) — d=totalFrames on video would
  // stall on the first frame. `on` (the running output-frame index) drives progress either way.
  const d = isVideo ? 1 : totalFrames;
  return `scale=${scaledW}:-1,zoompan=z='${z}':x='${x}':y='${y}':d=${d}:s=${outW}x${outH}:fps=${DEFAULT_FPS},setsar=1`;
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
  ramBudgetGB?: number,
) {
  const startedAt = Date.now();
  const exportsDir = publicPath("exports");
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

  // Say what this render is about to leave out. FF handles video/image/audio/caption and skips
  // the other 14 types; until now it skipped them without a word, so a project whose charts
  // never made it into the mp4 looked exactly like one that had none. The client warns before
  // you commit to the wait — this is the record of what actually happened.
  const dropped = ffDroppedItems(allItems as { type?: unknown }[]);
  if (dropped.length) {
    appendJobLog(jobId, `NOT RENDERED (FF cannot draw these): ${describeFfDropped(dropped)}`);
    mergeJob(jobId, { dropped: dropped.map((d) => ({ type: d.type, count: d.count })) });
  }

  logRam(jobId, "start (baseline)");

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
        if (i >= allMedia.length || jobs.get(jobId)?.cancelled) return;
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

  interface CaptionOverlay { path: string; fromS: number; toS: number; x: number; y: number; }
  const captionOverlays: CaptionOverlay[] = [];

  // Per-word highlight generates one PNG per word. With segment-per-clip rendering, each
  // segment only overlays the FEW captions in its window (not all at once), so word highlight
  // is affordable again — the old ceiling existed only because the monolithic graph opened
  // one ffmpeg input per PNG. Keep a high safety cap so a truly absurd project (thousands of
  // words) still falls back to base-only to bound PNG generation time/disk.
  const MAX_CAPTION_INPUTS = Number(process.env.FF_MAX_CAPTION_INPUTS) || 4000;
  const estWordPngs = captionItems.reduce((n: number, it: any) => {
    const words = Array.isArray(it.details?.words) ? it.details.words.length : 0;
    const col = it.details?.color;
    // Mirror generateHighlightedCaptionOverlays: per-word PNGs happen when active OR appeared differs.
    const hl = words > 0 && ((it.details?.activeColor && it.details.activeColor !== col) || (it.details?.appearedColor && it.details.appearedColor !== col));
    return n + 1 + (hl ? words : 0);
  }, 0);
  const captionBaseOnly = estWordPngs > MAX_CAPTION_INPUTS;

  if (captionItems.length) startStage(jobId, "Captions", `${captionItems.length} items${captionBaseOnly ? " · base-only (too many words for per-word highlight)" : " · word-highlight"}`);
  // Generate caption PNGs through a BOUNDED pool, not one big Promise.all. Each word makes a
  // canvas of NATIVE memory; word-highlight over 200+ captions is ~1800 of them, and doing them
  // all at once spiked RAM by ~14GB.
  //
  // ── NEVER EXCEED THE LIBUV THREADPOOL ───────────────────────────────────────────────────────
  // canvas.encode() runs on the libuv threadpool, and @napi-rs/canvas SEGFAULTS — signal 11, the
  // Node process gone, no exception to catch — the moment more encodes are in flight than the
  // pool has threads. Node's default pool is 4. This defaulted to 8. Measured on the render box,
  // 1200 PNGs, three runs each:
  //
  //     UV_THREADPOOL_SIZE=4   conc=8    →  3/3 segfault
  //     UV_THREADPOOL_SIZE=8   conc=8    →  0/3
  //     UV_THREADPOOL_SIZE=16  conc=16   →  0/3
  //     (default pool)         conc=1,2,4 →  0/3
  //
  // conc ≤ pool is fine at any volume; conc > pool dies. That one line off the default is the
  // whole of "the editor goes down mid-export": the crash killed :3001, higgs proxied to a dead
  // port and returned 500 on refresh, the render never finished, and pressing Export again
  // stacked another one on the pile.
  //
  // The pool size cannot be changed once it exists, so this bends to it instead. Raising
  // UV_THREADPOOL_SIZE in the service environment raises this ceiling with it.
  const UV_POOL = Math.max(1, Number(process.env.UV_THREADPOOL_SIZE) || 4);
  const CAP_CONC_WANTED = Math.max(1, Number(process.env.FF_CAPTION_CONCURRENCY) || 8);
  const CAP_CONC = Math.min(CAP_CONC_WANTED, UV_POOL);
  if (CAP_CONC < CAP_CONC_WANTED) {
    console.log(
      `[FF/canvas] caption concurrency ${CAP_CONC_WANTED} → ${CAP_CONC}: @napi-rs/canvas segfaults ` +
        `above UV_THREADPOOL_SIZE (${UV_POOL}). Raise UV_THREADPOOL_SIZE to go faster.`
    );
  }
  const allWordOverlays: { path: string; fromS: number; toS: number; x: number; y: number }[][] = new Array(captionItems.length);
  let capCursor = 0, capDone = 0;
  await Promise.all(Array.from({ length: Math.min(CAP_CONC, captionItems.length) }, async () => {
    while (true) {
      const i = capCursor++;
      if (i >= captionItems.length || jobs.get(jobId)?.cancelled) return;
      allWordOverlays[i] = await generateHighlightedCaptionOverlays(captionItems[i], outW, outH, canvasW, tmpDir, i, captionBaseOnly);
      capDone++;
      // Step the bar 5→45% across caption generation so it isn't frozen at ~0% for the ~30s
      // this takes on a big timeline.
      updateStage(jobId, "Captions", { detail: `${capDone}/${captionItems.length}` });
      mergeJob(jobId, { status: "PROCESSING", progress: 5 + Math.round((capDone / captionItems.length) * 40) });
    }
  }));
  for (const overlays of allWordOverlays) if (overlays) captionOverlays.push(...overlays);
  if (captionItems.length) endStage(jobId, "Captions", "done", `${captionOverlays.length} overlays${captionBaseOnly ? " (base-only)" : ""}`);
  if (captionItems.length) logRam(jobId, "after captions");

  // ── Text → the same overlay pipe ────────────────────────────────────────────────────────
  // Text was the biggest thing FF silently dropped, and captions already prove the mechanism:
  // draw with canvas, overlay the PNG. One PNG per item (no word variants), cropped to the
  // text's own box, so the cost is a rounding error next to the captions above — hence the same
  // bounded pool rather than a Promise.all: the pool is what keeps peak canvas RAM flat.
  const textItems = allItems
    .filter((it: any) => it.type === "text" && String(it.details?.text || "").trim())
    .sort((a: any, b: any) => (a.display?.from ?? 0) - (b.display?.from ?? 0));

  if (textItems.length) {
    startStage(jobId, "Text", `${textItems.length} items`);
    const textOut: (typeof captionOverlays[number] | null)[] = new Array(textItems.length);
    let txCursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(CAP_CONC, textItems.length) }, async () => {
        while (true) {
          const i = txCursor++;
          if (i >= textItems.length || jobs.get(jobId)?.cancelled) return;
          textOut[i] = await generateTextOverlay(textItems[i], outW, outH, canvasW, canvasH, tmpDir, i);
        }
      })
    );
    const made = textOut.filter(Boolean) as typeof captionOverlays;
    captionOverlays.push(...made);
    endStage(jobId, "Text", "done", `${made.length} overlays`);
    logRam(jobId, "after text");
  }

  mergeJob(jobId, { status: "PROCESSING", progress: 50 });
  if (jobs.get(jobId)?.cancelled) { appendJobLog(jobId, "✕ cancelled by user"); return; } // cancelled during download/captions

  // ─── Segment-per-clip render (bounded RAM) ────────────────────────────────
  // The OLD path built one giant filter_complex: ~one ffmpeg input per clip AND per caption
  // (~400 inputs), which spawned thousands of threads whose 8MB stacks alone reached 60GB+
  // of RAM → OOM. Instead render each visual clip as its OWN small ffmpeg (the clip + only
  // the captions in its window), then concat with -c copy and mux audio once. Each process
  // holds ~one frame, so RAM stays flat regardless of clip count. Per-segment caption count
  // is tiny, so word-level highlight is affordable again.
  const outputPath = path.join(exportsDir, `${jobId}.mp4`);
  const nvencAvail = !platformPreset && await hasNvencGpu();
  // For SEGMENTS, default to libx264 even when NVENC is available: each segment is a tiny clip,
  // and NVENC pays a ~1-2s GPU-session INIT per process (×190 = minutes) AND holds ~2.5GB per
  // segment vs ~0.8GB for libx264 — measured. So NVENC makes many-short-segments both slower
  // AND heavier. Opt back into GPU with FF_SEG_ENCODER=nvenc. Concat/mux stay stream-copy.
  const useNvenc = nvencAvail && process.env.FF_SEG_ENCODER === "nvenc";
  const encoder = pickVideoEncoder(useNvenc, quality, preset, crf);
  const gpuLabel = platformPreset ? "preset" : useNvenc ? "nvenc" : "cpu (libx264, per-segment)";
  const hwAccel = platformPreset ? "preset" : useNvenc ? "gpu" : "cpu";
  const segVideoArgs = platformPreset
    ? platformPreset.videoArgs
    : useNvenc
      ? encoder.args
      : ["-c:v", "libx264", "-preset", process.env.FF_SEG_PRESET || "veryfast", "-crf", String(crf)];
  mergeJob(jobId, {
    status: "PROCESSING", progress: 55, engine: "ffmpeg", source: "editor-manual",
    project_name: "User Export", started_at: Math.floor(startedAt / 1000),
    video_seconds: Math.round(totalSec), gpu: gpuLabel, hwAccel, cores: totalCores,
    encoder: platformPreset ? "platform-preset" : encoder.label,
  });
  appendJobLog(jobId, `encoder=${platformPreset ? "platform-preset" : encoder.label} gpu=${gpuLabel} · segment-per-clip`);

  // Ordered, non-overlapping visual timeline: each clip a segment; gaps filled with black.
  const visualEntries = entries.filter((e) => e.kind === "video")
    .sort((a, b) => Number(a.item.display?.from ?? 0) - Number(b.item.display?.from ?? 0));
  interface Seg { entry: MediaEntry | null; fromS: number; toS: number; }
  const segs: Seg[] = [];
  let segCur = 0;
  for (const e of visualEntries) {
    const dFrom = Math.max(0, Number(e.item.display?.from ?? 0) / 1000);
    const dTo = Math.max(dFrom + 0.1, Number(e.item.display?.to ?? 0) / 1000);
    const from = Math.max(segCur, dFrom);
    if (from > segCur + 0.02) segs.push({ entry: null, fromS: segCur, toS: from });
    if (dTo > from + 0.02) { segs.push({ entry: e, fromS: from, toS: dTo }); segCur = dTo; }
  }
  if (totalSec > segCur + 0.02) segs.push({ entry: null, fromS: segCur, toS: totalSec });
  if (segs.length === 0) segs.push({ entry: null, fromS: 0, toS: totalSec });

  // ── How many ffmpeg run at once ─────────────────────────────────────────────────────────
  //
  // A HARD RAM budget, not "however much is free".
  //
  // The old rule divided FREE ram by a per-segment estimate, so a roomier box simply ran more
  // ffmpeg: 13GB free planned 5 segments ≈ 12.5GB, and a 40GB box planned 20GB. Nothing
  // capped it, because "don't exceed free RAM" is not a budget — on Linux, spending all of
  // free RAM is exactly what summons the OOM killer, and what it kills is the biggest process
  // on the box: the editor itself. That is why one project exports fine on a Mac and takes the
  // editor down on Linux — the Mac had 3.6GB free, landed on 2 segments, and swapped the rest.
  // The Linux box had room to hang itself with.
  //
  // So: budget first, then trim to what's actually free. FF_RAM_BUDGET_GB moves the ceiling;
  // FF_SEG_CONCURRENCY overrides the count outright.
  const freeGB = os.freemem() / 1073741824;
  // Budget precedence: the job's own value (superadmin setting, injected by the GUI) → the
  // machine's saved setting/env/default. readExportSettings folds in FF_RAM_BUDGET_GB + the
  // 5.5 default, so a bare box still behaves exactly as before.
  const RAM_BUDGET_GB = Math.max(1, ramBudgetGB ?? (await readExportSettings()).ramBudgetGB);
  // Measured per-process: NVENC holds a GPU session and ~2.5GB; libx264 holds ~0.8GB.
  // Measured on a REAL segment — an image with Ken Burns, which is what most of them are:
  // ffmpeg supersamples before zoompan, and that upscaled plane is the cost. 839MB for Ken Burns
  // alone, 885MB with two caption overlays (overlays are band-cropped, so they barely register).
  // A plain scale-to-1920 encode is 270MB — measuring THAT is how you get a number three times
  // too small. Raising the supersample 2× → 4× (to kill the shake) adds ~6%, not the 4× the
  // filter's shape implies: the plane is one frame buffer, not the whole decode. 0.885 → ~0.94.
  const perSegGB = useNvenc ? 2.5 : 0.95;
  const budgetCap = Math.max(1, Math.floor(RAM_BUDGET_GB / perSegGB));
  // Leave the box room to breathe. `floor(free / perSeg)` plans to spend every last free byte —
  // which is the exact thing the budget above exists to stop, and it was still sitting here.
  // With 2.4GB free it planned 3 segments ≈ 2.55GB, and the kernel killed ffmpeg mid-encode
  // ("segment 6 failed — killed by SIGKILL with no output"). Free RAM is not a spending target.
  const FREE_HEADROOM = 0.7;
  const freeCap = Math.max(1, Math.floor((freeGB * FREE_HEADROOM) / perSegGB));
  // Three real limits, whichever is smallest: CPU (cores-1, leave one for the box), the RAM
  // budget, and what's actually free right now. The old fixed cap of 8 defeated the budget knob
  // — a 24-core box with plenty of RAM still ran only 8 — so it's gone; cores-1 is the natural
  // CPU ceiling. FF_SEG_CONCURRENCY still overrides everything.
  const SEG_CONC = Math.max(
    1,
    Number(process.env.FF_SEG_CONCURRENCY) ||
      Math.min(totalCores - 1 || 3, budgetCap, freeCap)
  );
  // Threads PER segment — give each ffmpeg a share of the box instead of all of it.
  //
  // The filter pools were capped long ago; the encoder never was, so libx264 kept its default
  // of ~1.5×cores. That is the difference between the machines: a 10-core Mac gives each
  // segment ~15 threads, a 24-core Xeon gives it ~36 — each with its own 8MB stack and its own
  // x264 frame buffers. So "GB per segment" isn't a constant at all, it scales with core count,
  // and a budget built on a constant is fiction on a big box. It also oversubscribes: SEG_CONC
  // processes each sizing themselves for the whole machine means cores × SEG_CONC threads
  // fighting over cores × 1 cores, which is slower, not faster.
  //
  // Sized so SEG_CONC × SEG_THREADS ≈ cores: the box stays busy, nothing is oversubscribed,
  // and per-segment RAM stops depending on how big the machine is.
  const SEG_THREADS =
    Number(process.env.FF_SEG_THREADS) ||
    Math.max(2, Math.min(8, Math.floor((totalCores || 4) / SEG_CONC)));


  const renderSeg = async (seg: Seg, idx: number): Promise<string> => {
    const dur = Math.max(0.1, seg.toS - seg.fromS);
    const segPath = path.join(tmpDir, `seg_${String(idx).padStart(5, "0")}.mp4`);
    // Single-clip segments don't need slice-threaded filtering; capping the pools keeps each
    // ffmpeg at ~10 threads instead of ~100 (per-process stack RAM ~800MB → ~80MB). Default 1
    // (RAM-safest, avoids CPU oversubscription at high SEG_CONC). Now that caption overlays are
    // band-cropped (cheap), a box with spare cores can raise these for extra per-segment speed.
    const a: string[] = ["-y", "-hide_banner", "-nostdin", "-loglevel", "error",
      "-filter_threads", process.env.FF_FILTER_THREADS || "1",
      "-filter_complex_threads", process.env.FF_FILTER_COMPLEX_THREADS || "1"];
    const fp: string[] = [];
    if (seg.entry && seg.entry.isImage) {
      a.push("-loop", "1", "-t", dur.toFixed(3), "-i", seg.entry.path);
      const kb = buildKenBurnsFilter(seg.entry.item.details, dur, outW, outH);
      fp.push(`[0:v]${kb ?? `scale=${outW}:${outH}`},setsar=1${getFadeFilters(seg.entry.item, 0, dur)}[v]`);
    } else if (seg.entry) {
      const rate = safeRate(seg.entry.item.playbackRate);
      const rateStr = (Math.round(rate * 1000) / 1000).toString();
      const trimFrom = Math.max(0, Number(seg.entry.item.trim?.from ?? 0) / 1000);
      // Speed: read `dur*rate` source seconds and compress them into `dur` output seconds via
      // setpts=(PTS-STARTPTS)/rate. The render used to ignore playbackRate entirely (plain
      // setpts=PTS-STARTPTS), so a clip slowed/sped in the editor still exported at 1×. The clip's
      // audio gets the matching atempo in the audio mix below, so picture and sound stay in sync.
      const inLen = dur * rate;
      a.push("-ss", trimFrom.toFixed(3), "-t", inLen.toFixed(3), "-i", seg.entry.path);
      // Ken Burns on video too (a slow punch-in): same filter, lighter supersample. zoompan resets
      // its own timeline, so setpts must come AFTER it, not before, or the pan freezes.
      const kbv = buildKenBurnsFilter(seg.entry.item.details, dur, outW, outH, true);
      const sp = rate !== 1 ? `/${rateStr}` : "";
      fp.push(kbv
        ? `[0:v]${kbv},setpts=(PTS-STARTPTS)${sp}${getFadeFilters(seg.entry.item, 0, dur)}[v]`
        : `[0:v]scale=${outW}:${outH},setsar=1,setpts=(PTS-STARTPTS)${sp}${getFadeFilters(seg.entry.item, 0, dur)}[v]`);
    } else {
      a.push("-f", "lavfi", "-t", dur.toFixed(3), "-i", `color=black:s=${outW}x${outH}:r=${DEFAULT_FPS}`);
      fp.push(`[0:v]setsar=1[v]`);
    }
    // Captions intersecting this window, overlaid with segment-relative timing (few per seg).
    const caps = captionOverlays.filter((c) => c.toS > seg.fromS + 0.02 && c.fromS < seg.toS - 0.02);
    let prev = "v", ii = 1;
    for (let i = 0; i < caps.length; i++) {
      a.push("-loop", "1", "-t", dur.toFixed(3), "-i", caps[i].path);
      const rf = Math.max(0, caps[i].fromS - seg.fromS);
      const rt = Math.min(dur, caps[i].toS - seg.fromS);
      const o = i === caps.length - 1 ? "vo" : `vo${i}`;
      // Caption PNGs are pre-rendered at output width and cropped to their text band, so they
      // overlay directly at (x,y) — NO per-overlay full-frame scale. This is the export's single
      // biggest win: a dense caption dropped from ~25s+5.5GB to ~3.7s+2.4GB per segment.
      fp.push(`[${ii}:v]format=rgba[c${i}]`);
      fp.push(`[${prev}][c${i}]overlay=x=${caps[i].x ?? 0}:y=${caps[i].y ?? 0}:enable='between(t,${rf.toFixed(3)},${rt.toFixed(3)})'[${o}]`);
      prev = o; ii++;
    }
    // -threads: the encoder's share of the box. Without it libx264 takes ~1.5×cores for a
    // three-second clip, so per-segment RAM scales with the machine and SEG_CONC processes
    // oversubscribe it several times over.
    a.push("-filter_complex", fp.join(";"), "-map", `[${prev}]`, ...segVideoArgs,
      "-threads", String(SEG_THREADS),
      "-r", String(DEFAULT_FPS), "-pix_fmt", "yuv420p", "-an", "-t", dur.toFixed(3), segPath);
    // Track the child so a Cancel can SIGKILL it mid-render (not just stop the next wave).
    let reg = jobChildren.get(jobId); if (!reg) { reg = new Set(); jobChildren.set(jobId, reg); }
    await new Promise<void>((resolve, reject) => {
      const child = execFile("ffmpeg", a, { timeout: 900_000, maxBuffer: 32 * 1024 * 1024 }, (err, _stdout, stderr) => {
        reg!.delete(child);
        if (!err) return resolve();

        // Say WHY, not what we asked for.
        //
        // execFile's Error.message is the entire command line — here that is two thousand
        // characters of filter graph, which then becomes the export's error and the only thing
        // the user is told. It says nothing. What matters is the exit code, the signal, and
        // ffmpeg's own stderr.
        //
        // Name the signal, but do NOT guess who sent it. A SIGKILL with no output was confidently
        // reported here as "the kernel's OOM killer" — it was this codebase's own orphan reaper
        // killing the render it was in the middle of. A guess dressed as a diagnosis sent us
        // hunting RAM on a box that had 26GB free.
        const e = err as NodeJS.ErrnoException & { code?: unknown; signal?: string; killed?: boolean };
        const tail = String(stderr || "").trim().split("\n").slice(-6).join("\n").slice(-600);
        const why = e.signal
          ? `killed by ${e.signal}${e.signal === "SIGKILL" && !tail ? " and printed nothing — something outside ffmpeg killed it (cancel, the reaper, the OOM killer, a supervisor)" : ""}`
          : `exit ${e.code ?? "?"}`;
        const detail = tail || "(ffmpeg printed nothing)";
        console.error(
          `[FF/seg] segment ${idx} failed — ${why}\n${detail}\n  full command: ffmpeg ${a.join(" ")}`
        );
        reject(new Error(`segment ${idx} failed — ${why}: ${detail}`));
      });
      reg!.add(child);
    });
    return segPath;
  };

  const plannedGB = SEG_CONC * perSegGB;
  const nGap = segs.filter((s) => !s.entry).length;

  // Why this number, in the console, every time. When an export dies on a box we can't attach
  // to, the alternative is guessing — and the whole reason this budget exists is that the
  // previous number was never visible until the machine fell over.
  console.log(
    `[FF/ram] budget ${RAM_BUDGET_GB}GB · ${perSegGB}GB per segment (${useNvenc ? "nvenc" : "libx264"}) → ` +
      `caps: budget=${budgetCap} free=${freeCap} (${(freeGB * FREE_HEADROOM).toFixed(1)}GB of ${freeGB.toFixed(1)}GB free, 30% held back) cores=${totalCores - 1} hard=8` +
      `${process.env.FF_SEG_CONCURRENCY ? ` · FF_SEG_CONCURRENCY=${process.env.FF_SEG_CONCURRENCY} OVERRIDE` : ""}` +
      ` → SEG_CONC=${SEG_CONC} × ${SEG_THREADS} threads = ${SEG_CONC * SEG_THREADS}/${totalCores} cores,` +
      ` planning ~${plannedGB.toFixed(1)}GB peak for ${segs.length} segments`
  );

  startStage(jobId, "Render segments", `0/${segs.length} · ${SEG_CONC} ffmpeg parallel`);
  appendJobLog(jobId, `segments: ${segs.length} (${segs.length - nGap} clips + ${nGap} gaps) · ${SEG_CONC} parallel ffmpeg × ${SEG_THREADS} threads · planning ~${plannedGB.toFixed(1)}GB of a ${RAM_BUDGET_GB}GB budget (${freeGB.toFixed(1)}GB free) · supersample ${KENBURNS_SUPERSAMPLE}x`);
  logRam(jobId, "segments start");

  // ── RAM watchdog ────────────────────────────────────────────────────────────────────────
  // Samples what the render is ACTUALLY costing while it runs, and says so out loud. The
  // budget above is arithmetic on an estimate; this is the measurement that either confirms
  // it or tells us the estimate is wrong. It is also the only thing that survives an OOM kill
  // — when the box takes the editor out, the last line printed is the evidence.
  const ramUsedGB = () => (os.totalmem() - os.freemem()) / 1073741824;
  const ramAtStart = ramUsedGB();
  let ramPeak = ramAtStart;
  let ramWarned = false;
  const ramWatch = setInterval(() => {
    const now = ramUsedGB();
    if (now > ramPeak) ramPeak = now;
    const spent = now - ramAtStart;
    if (!ramWarned && spent > RAM_BUDGET_GB) {
      ramWarned = true;
      console.warn(
        `[FF/ram] ⚠ OVER BUDGET — this render has added ${spent.toFixed(1)}GB (budget ${RAM_BUDGET_GB}GB) ` +
          `at ${segDone}/${segs.length} segments, ${SEG_CONC} parallel. The ${perSegGB}GB/segment estimate is ` +
          `too low: real cost ≈ ${(spent / SEG_CONC).toFixed(2)}GB per ffmpeg. ` +
          `Lower FF_SEG_CONCURRENCY or FF_RAM_BUDGET_GB — on Linux the OOM killer takes the editor.`
      );
    }
  }, 500);

  const segPaths: string[] = new Array(segs.length);
  let segDone = 0, segCursor = 0; const encStartT = Date.now();
  try {
    await Promise.all(Array.from({ length: Math.min(SEG_CONC, segs.length) }, async () => {
      while (true) {
        if (jobs.get(jobId)?.cancelled) return; // Cancel: stop claiming new segments
        const i = segCursor++;
        if (i >= segs.length) return;
        segPaths[i] = await renderSeg(segs[i], i);
        segDone++;
        const spd = segDone / Math.max(0.1, (Date.now() - encStartT) / 1000);
        updateStage(jobId, "Render segments", { detail: `${segDone}/${segs.length} · ${SEG_CONC} parallel · ${spd.toFixed(1)} seg/s` });
        if (segDone % 25 === 0 || segDone === segs.length) {
          const eta = spd > 0 ? Math.round((segs.length - segDone) / spd) : 0;
          appendJobLog(jobId, `segments ${segDone}/${segs.length} · ${spd.toFixed(1)}/s · ~${eta}s left · ${ramLine()}`);
        }
        mergeJob(jobId, { status: "PROCESSING", progress: 55 + Math.round((segDone / segs.length) * 35) });
      }
    }));
    clearInterval(ramWatch);
    const spent = ramPeak - ramAtStart;
    console.log(
      `[FF/ram] segments done · peak +${spent.toFixed(1)}GB over baseline ` +
        `(${ramPeak.toFixed(1)}GB system) · budget ${RAM_BUDGET_GB}GB · ` +
        `real cost ≈ ${(spent / SEG_CONC).toFixed(2)}GB per ffmpeg vs the ${perSegGB}GB estimate` +
        `${spent > RAM_BUDGET_GB ? " ← OVER" : ""}`
    );
  } catch (segErr: any) {
    clearInterval(ramWatch);
    if (jobs.get(jobId)?.cancelled) {  // ffmpeg was SIGKILLed by a cancel → not a real failure
      endStage(jobId, "Render segments", "failed", "cancelled");
      appendJobLog(jobId, "✕ cancelled by user");
      return;
    }
    const msg = String(segErr?.stderr ? String(segErr.stderr).slice(-800) : segErr?.message || "segment render failed");
    endStage(jobId, "Render segments", "failed", msg.slice(0, 120));
    mergeJob(jobId, { status: "FAILED", progress: jobs.get(jobId)?.progress ?? 55, error: msg });
    appendJobLog(jobId, `FAILED: ${msg}`);
    if (!skipCallback) notifyRenderCallback({ job_id: jobId, status: "FAILED", error: msg });
    return;
  }
  if (jobs.get(jobId)?.cancelled) { appendJobLog(jobId, "✕ cancelled by user"); return; }
  endStage(jobId, "Render segments", "done", `${segs.length} segments`);

  // Concat (no re-encode) → silent video; re-encode fallback if -c copy can't stitch them.
  startStage(jobId, "Concat + mux");
  const concatList = path.join(tmpDir, "segments.concat");
  await writeFile(concatList, segPaths.map((p) => `file '${p}'`).join("\n"), "utf8");
  const silentPath = path.join(tmpDir, "silent.mp4");
  try {
    await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
      "-i", concatList, "-c", "copy", "-an", silentPath], { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
  } catch {
    await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
      "-i", concatList, ...segVideoArgs, "-r", String(DEFAULT_FPS), "-pix_fmt", "yuv420p", "-an", silentPath],
      { timeout: 1_800_000, maxBuffer: 32 * 1024 * 1024 });
  }

  // Mix all audio (audio items + video-embedded audio) in ONE light ffmpeg.
  let audioMixPath: string | null = null;
  const audioEntries = entries.filter((e) => e.kind === "audio" || (e.kind === "video" && e.hasAudio));
  if (audioEntries.length) {
    const aa: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
    const af: string[] = []; const labels: string[] = [];
    audioEntries.forEach((e, i) => {
      const item = e.item;
      const dFrom = Math.max(0, Number(item.display?.from ?? 0) / 1000);
      const dTo = Math.max(dFrom + 0.1, Number(item.display?.to ?? 0) / 1000);
      const dur = dTo - dFrom;
      const trimFrom = Math.max(0, Number(item.trim?.from ?? 0) / 1000);
      const trackId = itemTrackMap[item.id] ?? "";
      const vol = mutedSet.has(trackId) ? 0 : Math.max(0, Number(item.details?.volume ?? 100) / 100);
      const delayMs = Math.round(dFrom * 1000);
      // Speed: read `dur*rate` source seconds (atrim) and compress to `dur` via an atempo chain,
      // matching the video segment's setpts so a sped/slowed clip's audio stays in sync — this used
      // to be ignored (atrim read only `dur` seconds at 1×). rate=1 → atempoChain() returns "".
      const rate = safeRate(item.playbackRate);
      const atrimEnd = trimFrom + dur * rate;
      const tempo = atempoChain(rate);
      // Volume: a flat constant, or — when the clip has a volume envelope — a time-varying
      // expression over t (clip-local seconds after atempo, 0..dur) with the master gain baked in.
      const volExpr = vol > 0 ? buildFfmpegVolumeExpr((item.details as any)?.volumeKeyframes, vol, dur) : null;
      const volFilter = volExpr ? `volume=volume='${volExpr}':eval=frame` : `volume=${vol}`;
      aa.push("-i", e.path);
      af.push(`[${i}:a]atrim=start=${trimFrom.toFixed(3)}:end=${atrimEnd.toFixed(3)},asetpts=PTS-STARTPTS${tempo},` +
        `${volFilter},adelay=${delayMs}|${delayMs},aformat=channel_layouts=stereo:sample_rates=48000[a${i}]`);
      labels.push(`a${i}`);
    });
    af.push(labels.length === 1
      ? `[${labels[0]}]apad=whole_dur=${totalSec}[aout]`
      : `${labels.map((l) => `[${l}]`).join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,apad=whole_dur=${totalSec}[aout]`);
    audioMixPath = path.join(tmpDir, "audio.m4a");
    aa.push("-filter_complex", af.join(";"), "-map", "[aout]", "-c:a", "aac", "-b:a", "192k",
      "-ar", "48000", "-ac", "2", "-t", totalSec.toFixed(3), audioMixPath);
    try { await execFileAsync("ffmpeg", aa, { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 }); }
    catch { audioMixPath = null; } // audio mix failed → ship silent rather than fail the export
  }

  // Final mux: silent video (stream-copy) + audio.
  const muxArgs = ["-y", "-hide_banner", "-loglevel", "error", "-i", silentPath];
  if (audioMixPath) muxArgs.push("-i", audioMixPath);
  muxArgs.push("-c:v", "copy", ...(audioMixPath ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
    "-movflags", "+faststart", "-t", totalSec.toFixed(3), outputPath);
  try {
    await execFileAsync("ffmpeg", muxArgs, { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
  } catch (muxErr: any) {
    const msg = String(muxErr?.message || "mux failed");
    endStage(jobId, "Concat + mux", "failed", msg.slice(0, 120));
    mergeJob(jobId, { status: "FAILED", progress: 90, error: msg });
    appendJobLog(jobId, `FAILED: ${msg}`);
    if (!skipCallback) notifyRenderCallback({ job_id: jobId, status: "FAILED", error: msg });
    return;
  }
  endStage(jobId, "Concat + mux", "done", `${segs.length} segments${audioMixPath ? " + audio" : ""}`);

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
