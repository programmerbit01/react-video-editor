import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import path from "path";
import os from "os";
import { execSync, execFile } from "child_process";
import { promisify } from "util";
import { mkdir, rm } from "fs/promises";
import { jobs } from "./jobs";
import { readExportSettings, clampRamBudget } from "../admin/export-settings-store";
import { ensureCached, enforceCap, registerAsset } from "@/utils/asset-cache-store";
import { publicPath } from "@/utils/server-paths";
import { readJsonBody } from "@/utils/request-body";

const execFileAsync = promisify(execFile);

// NVENC (NVIDIA hardware h264) for the RE engine. Remotion 4.x has NO nvenc (only
// macOS VideoToolbox) — its Linux encode is CPU libx264. So where the SYSTEM ffmpeg
// actually supports nvenc we render FRAMES with Remotion (all animations) → encode
// with h264_nvenc. AUTO-DETECTED (like the GPU GL backend): probe ffmpeg once; if it
// can nvenc, use it — no manual flag. On Mac/CPU-only boxes the probe fails → standard
// renderMedia. Force off with RENDER_NVENC=0. Any failure falls back to renderMedia.
const RENDER_NVENC_OFF = process.env.RENDER_NVENC === "0";
let _nvencOk: boolean | null = null;
async function hasNvenc(): Promise<boolean> {
  if (RENDER_NVENC_OFF) return false;
  if (_nvencOk !== null) return _nvencOk;
  try {
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-f", "lavfi", "-i", "testsrc2=s=1280x720:d=0.2:r=30",
      "-c:v", "h264_nvenc", "-f", "null", "-",
    ], { timeout: 8000 });
    _nvencOk = true;
  } catch {
    _nvencOk = false;
  }
  console.log(`[render-remotion] NVENC auto-detect: ${_nvencOk ? "available ✓ → h264_nvenc" : "not available → libx264/renderMedia"}`);
  return _nvencOk;
}

// Bundle is created once and reused for the lifetime of the server process.
let cachedBundleUrl: string | null = null;
const CALLBACK_BASE = (process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091").replace(/\/+$/, "");

function mergeJob(jobId: string, patch: Record<string, unknown>) {
  const current = jobs.get(jobId) ?? { status: "PENDING", progress: 0 };
  jobs.set(jobId, { ...current, ...patch } as any);
}

// ── observability helpers ────────────────────────────────────────────────────
// Per-stage timers + a rolling log, written onto the job so the reporting card
// can show WHERE the time goes and WHERE a render stalls. _t0 is stripped by GET.

const _stageStart = new Map<string, Map<string, number>>(); // jobId → stage → t0

function logLine(jobId: string, msg: string) {
  const j = jobs.get(jobId) as any;
  const ts = new Date().toISOString().slice(11, 19);
  const log = [ ...((j?.log as string[]) ?? []), `${ts}  ${msg}` ].slice(-300);
  mergeJob(jobId, { log });
  console.log(`[render-remotion] ${jobId} · ${msg}`);
}

function startStage(jobId: string, name: string, detail?: string) {
  const j = jobs.get(jobId) as any;
  const stages = [ ...((j?.stages as any[]) ?? []), { name, status: "running", detail } ];
  let m = _stageStart.get(jobId); if (!m) { m = new Map(); _stageStart.set(jobId, m); }
  m.set(name, Date.now());
  mergeJob(jobId, { stages });
  logLine(jobId, `▶ ${name}${detail ? " · " + detail : ""}`);
}

function updateStage(jobId: string, name: string, patch: Record<string, unknown>) {
  const j = jobs.get(jobId) as any;
  const stages = ((j?.stages as any[]) ?? []).map((s) => (s.name === name ? { ...s, ...patch } : s));
  mergeJob(jobId, { stages });
}

function endStage(jobId: string, name: string, status: "done" | "failed" | "stalled" = "done", detail?: string) {
  const j = jobs.get(jobId) as any;
  const t0 = _stageStart.get(jobId)?.get(name);
  const ms = t0 ? Date.now() - t0 : undefined;
  const stages = ((j?.stages as any[]) ?? []).map((s) =>
    s.name === name ? { ...s, status, ms, ...(detail ? { detail } : {}) } : s,
  );
  mergeJob(jobId, { stages });
  logLine(jobId, `${status === "done" ? "✓" : status === "stalled" ? "⚠" : "✕"} ${name}${ms != null ? " · " + (ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s") : ""}${detail ? " · " + detail : ""}`);
}

// Marks a render stalled (no frame progress) so the UI stops showing a silent %.
// Observability only — it does NOT kill the render (that's the stall root-fix pass).
const STALL_AFTER_MS = 90_000;

function shortAsset(src: string): string {
  try {
    const u = new URL(src, "http://x");
    const q = u.searchParams.get("url") || u.searchParams.get("src");
    const path = (q ? new URL(q, "http://x").pathname : u.pathname) || src;
    return path.split("/").filter(Boolean).slice(-1)[0] || src;
  } catch { return src.slice(-48); }
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

async function getBundleUrl(): Promise<string> {
  if (cachedBundleUrl) return cachedBundleUrl;

  const { bundle } = await import("@remotion/bundler");
  const entryPoint = path.join(process.cwd(), "src/remotion/index.tsx");

  console.log("[render-remotion] bundling — first request will be slower...");
  cachedBundleUrl = await bundle({
    entryPoint,
    webpackOverride: (config: any) => ({
      ...config,
      resolve: {
        ...config.resolve,
        alias: {
          ...config.resolve?.alias,
          // Match the @/* path alias in tsconfig.json
          "@": path.join(process.cwd(), "src"),
        },
      },
    }),
  });
  console.log("[render-remotion] bundle ready:", cachedBundleUrl);
  return cachedBundleUrl;
}

// delayRender timeout. The default (~30s) intermittently fails on a cold bundle
// or under CPU contention (concurrency spawns several headless Chrome instances)
// with "Waiting for root component to load … not cleared after 28000ms".
// 2 minutes gives the bundle/root ample time to evaluate and render.
const RENDER_TIMEOUT_MS = 120_000;

// A MUCH longer per-frame (delayRender) timeout for the actual render passes. With the
// overlapped localize, a frame can request an asset that's still downloading; on a slow
// uplink that fetch can take minutes. This lets the frame WAIT for it instead of failing
// ("delayRender … not cleared after Nms"). A genuinely-broken asset still fails, just
// later (the stall watchdog surfaces a no-progress render meanwhile). selectComposition
// keeps the shorter RENDER_TIMEOUT_MS. Override via RENDER_ASSET_TIMEOUT_MS.
const RENDER_ASSET_TIMEOUT_MS = Number(process.env.RENDER_ASSET_TIMEOUT_MS) || 600_000;

// Concurrency = parallel headless-Chrome render workers; the biggest single-machine
// speed lever. AUTO = (cores - 2) so it scales with the box (a 32-core renders with 30,
// not an artificial cap of 16). Floor 4. Override with REMOTION_CONCURRENCY.
const RENDER_CONCURRENCY = (() => {
  const env = parseInt(process.env.REMOTION_CONCURRENCY || "", 10);
  if (Number.isFinite(env) && env > 0) return env;
  const cores = os.cpus()?.length || 8;
  return Math.max(4, cores - 2);
})();

// Each headless-Chrome worker's rough RAM cost. Used to cap workers by the export RAM budget
// so RR obeys the same ceiling FF does — the old "not RAM-capped" assumption held for ONE
// render, but the queue runs several at once (two overlapping RR renders were seen in the
// logs), and cores-2 × N-renders × Chrome is exactly how a fleet box OOMs. Tunable.
const RR_PER_WORKER_GB = Math.max(0.3, Number(process.env.RENDER_PER_WORKER_GB) || 0.8);

// Workers, capped three ways: cores (speed), the export RAM budget (the superadmin ceiling),
// and the machine's actually-free RAM (70% headroom). The tightest wins — same discipline as
// the FF route. `budgetGB` undefined → cores-only, the prior behaviour.
function effectiveConcurrency(budgetGB?: number): { value: number; cores: number; capBy: string } {
  const cores = os.cpus()?.length || 0;
  let value = RENDER_CONCURRENCY;
  let capBy = "cores";
  if (budgetGB && budgetGB > 0) {
    const byBudget = Math.max(1, Math.floor(budgetGB / RR_PER_WORKER_GB));
    if (byBudget < value) { value = byBudget; capBy = "ram-budget"; }
  }
  const freeGB = os.freemem() / 1073741824;
  const byFree = Math.max(1, Math.floor((freeGB * 0.7) / RR_PER_WORKER_GB));
  if (byFree < value) { value = byFree; capBy = "free-ram"; }
  return { value, cores, capBy };
}

// GPU GL backend for headless-Chrome rendering. AUTO: if an NVIDIA GPU is
// detected (nvidia-smi present, e.g. the 3090 box) we default to "angle" so the
// GPU is used; on Mac / GPU-less servers we leave it on Remotion's CPU default.
// Override anytime: REMOTION_GL=egl (force a backend) or REMOTION_GL=off (disable
// if a GPU render ever comes out black / fails).
const RENDER_GL = (() => {
  const env = (process.env.REMOTION_GL || "").trim().toLowerCase();
  if (env) return env === "off" || env === "none" ? "" : env; // explicit override wins
  // macOS always has a usable GPU (Apple Silicon / Metal via ANGLE).
  if (os.platform() === "darwin") return "angle";
  // Linux/Windows: only enable if an NVIDIA GPU is actually present.
  try {
    execSync("nvidia-smi -L", { stdio: "ignore", timeout: 2000 });
    return "angle";
  } catch {
    return ""; // no GPU detected → CPU default (safe on headless servers)
  }
})();

// h264 CRF by quality tier. RE previously passed NO crf → Remotion's default made a
// ~1.2GB near-lossless file. These are VISUALLY lossless but far smaller + faster to
// encode AND upload (the "98% tail"). Lower number = higher quality/bigger file.
const CRF_BY_QUALITY: Record<string, number> = { high: 20, medium: 24, low: 28 };

// Bounded-concurrency worker pool.
async function runPool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const idx = i++; await fn(items[idx]); }
    }),
  );
}

// Stage 0 — Localize: rewrite every remote asset src → a local cache route + warm the
// cache. DEFAULT is DOWNLOAD-ALL-FIRST (await), because Remotion renders frames in
// PARALLEL across the whole timeline — the render can request ANY asset at any moment,
// so if it outruns the download on a slow uplink a frame's <Img> hits the delayRender
// timeout and the whole render FAILS. Downloading first is safe (render then reads
// everything locally; re-renders are instant, all ✓ cached).
// OVERLAP (render-while-downloading, total ≈ max(download,render)) is opt-in via
// RENDER_LOCALIZE_OVERLAP=1 — only safe on a FAST/datacenter link. Disable localize
// entirely with RENDER_LOCALIZE=0. The cache-through route stays a safety net either way.
async function localizeAssets(jobId: string, design: any, serverOrigin: string): Promise<any> {
  if (process.env.RENDER_LOCALIZE === "0") return design;
  let d: any;
  try { d = JSON.parse(JSON.stringify(design)); } catch { return design; }
  const map = (d?.trackItemsMap ?? {}) as Record<string, any>;
  const items = Object.values(map);

  // Collect unique srcs + each one's earliest timeline use → warm what plays first.
  const firstUse = new Map<string, number>();
  for (const it of items) {
    const s = it?.details?.src;
    if (typeof s === "string" && /^https?:\/\//i.test(s)) {
      const from = Number(it?.display?.from ?? it?.trim?.from ?? 0) || 0;
      firstUse.set(s, Math.min(firstUse.get(s) ?? Infinity, from));
    }
  }
  const list = [...firstUse.keys()].sort((a, b) => (firstUse.get(a)! - firstUse.get(b)!));
  if (!list.length) return d;

  startStage(jobId, "Localize assets", `0/${list.length}`);

  // 1) Register (write key→url sidecar) + rewrite srcs → local route. Instant, no download.
  const urlToLocal = new Map<string, string>();
  for (const url of list) {
    const key = await registerAsset(url);
    urlToLocal.set(url, `${serverOrigin}/api/asset-cache/${key}`);
  }
  for (const it of items) {
    const s = it?.details?.src;
    if (typeof s === "string" && urlToLocal.has(s)) it.details.src = urlToLocal.get(s);
  }

  // 2) Warm the cache. Downloads all assets (deduped, bounded concurrency).
  // DEFAULT overlap: render starts immediately, cache warms in the background, and a
  // frame that needs a not-yet-warm asset WAITS (up to RENDER_ASSET_TIMEOUT_MS) via the
  // cache-through route instead of blocking the whole render up front. total ≈
  // max(download, render). Opt out to strict download-all-first with RENDER_LOCALIZE_OVERLAP=0.
  const overlap = process.env.RENDER_LOCALIZE_OVERLAP !== "0";
  const warm = async () => {
    let done = 0, hits = 0, pulled = 0, pulledBytes = 0;
    const CONC = Number(process.env.RENDER_LOCALIZE_CONCURRENCY || 8);
    await runPool(list, CONC, async (url) => {
      try {
        const { hit, size } = await ensureCached(url);
        if (hit) hits++; else { pulled++; pulledBytes += size; }
        done++;
        logLine(jobId, `    ${done}/${list.length} ${hit ? "✓ cached" : "⬇ pulled"}  ${shortAsset(url)}${hit ? "" : ` (${(size / 1048576).toFixed(1)}MB)`}`);
      } catch (e) {
        done++;
        logLine(jobId, `    ${done}/${list.length} ✕ ${shortAsset(url)} — ${String((e as any)?.message || e).slice(0, 60)} (cache-through)`);
      }
      updateStage(jobId, "Localize assets", { detail: `${done}/${list.length}${hits ? ` · ${hits} cached` : ""}${overlap ? " (warming)" : ""}` });
    });
    enforceCap().catch(() => {});
    endStage(jobId, "Localize assets", "done", `${list.length} assets · ${hits} cached · ${(pulledBytes / 1048576).toFixed(0)}MB pulled`);
  };

  if (overlap) {
    void warm();            // render starts now, cache warms in background (fast link only)
  } else {
    await warm();           // SAFE default: download all → then render reads locally
  }

  return d;
}

// Strip a design down to just the sound-bearing items (audio + video). The audio
// WAV pass in the NVENC path re-evaluates the WHOLE composition otherwise — on a
// big timeline that means headless Chrome loading every image/text/caption (190+
// items) again just to emit silence for them, which stalls for minutes. Audio only
// comes from <Audio> (audio items) and <Video>/<OffthreadVideo> (video items), so
// dropping everything else yields identical audio in a fraction of the time.
// Duration/size are preserved so the WAV spans the full timeline and stays in sync.
function audioOnlyDesign(design: any): any {
  try {
    const map = design?.trackItemsMap ?? {};
    const keep = (t: string) => t === "audio" || t === "video";
    const audioIds = new Set(
      Object.keys(map).filter((id) => keep(String(map[id]?.type))),
    );
    if (audioIds.size === 0) return design; // nothing to trim; render as-is
    const trackItemsMap: Record<string, any> = {};
    for (const id of audioIds) trackItemsMap[id] = map[id];
    const tracks = (design?.tracks ?? [])
      .map((t: any) => ({
        ...t,
        items: (t?.items ?? []).filter((id: string) => audioIds.has(id)),
      }))
      .filter((t: any) => (t.items ?? []).length > 0);
    return {
      ...design,
      trackItemsMap,
      trackItemIds: (design?.trackItemIds ?? []).filter((id: string) => audioIds.has(id)),
      tracks,
      // Visuals only — irrelevant to audio and would reference dropped items.
      transitionsMap: {},
      transitionIds: [],
      structure: [],
    };
  } catch {
    return design;
  }
}

// NVENC render: Remotion renderFrames → JPEG sequence (all animations) + audio-only
// WAV, then the SYSTEM ffmpeg encodes with h264_nvenc. Writes the final mp4 to
// outputPath. Throws on any failure so the caller falls back to renderMedia.
async function renderViaNvenc(
  jobId: string, composition: any, serveUrl: string, inputProps: any, outputPath: string, crf: number, t0: number,
  budgetGB?: number,
): Promise<void> {
  const { renderFrames, renderMedia } = await import("@remotion/renderer");
  const totalFrames = composition.durationInFrames;
  const tmpDir = path.join(os.tmpdir(), `rmn-${jobId}`);
  const framesDir = path.join(tmpDir, "frames");
  const audioPath = path.join(tmpDir, "audio.wav");
  await mkdir(framesDir, { recursive: true });

  try {
    mergeJob(jobId, { encoder: "h264_nvenc" }); // so the report shows NVENC live, not just at the end
    logLine(jobId, "NVENC path: renderFrames → ffmpeg h264_nvenc");
    // 1) Render frames (image sequence) — with a stall watchdog + live fps.
    const conc = effectiveConcurrency(budgetGB);
    logLine(jobId, `render workers: ${conc.value}/${conc.cores} cores (cap: ${conc.capBy})`);
    startStage(jobId, "Render frames", `0/${totalFrames}`);
    let lastFrames = 0, lastAt = Date.now(), tickF = 0, tickAt = Date.now(), inst = 0, lastPct = 0, stalled = false;
    const watch = setInterval(() => {
      if (lastFrames >= totalFrames) return;
      const idle = Date.now() - lastAt;
      if (idle >= STALL_AFTER_MS) {
        const reason = `no frame for ${Math.round(idle / 1000)}s at ${lastFrames}/${totalFrames}`;
        updateStage(jobId, "Render frames", { status: "stalled", detail: reason });
        mergeJob(jobId, { stalled: true, stall_reason: reason });
        if (!stalled) { logLine(jobId, `⚠ STALL — ${reason}`); stalled = true; }
      }
    }, 5000);
    try {
      await renderFrames({
        composition, serveUrl, inputProps,
        outputDir: framesDir,
        imageFormat: "jpeg", jpegQuality: 90,
        concurrency: conc.value,
        ...(RENDER_GL ? { chromiumOptions: { gl: RENDER_GL as any } } : {}),
        timeoutInMilliseconds: RENDER_ASSET_TIMEOUT_MS,
        onFrameUpdate: (framesRendered: number) => {
          const now = Date.now();
          if (framesRendered > lastFrames) {
            lastFrames = framesRendered; lastAt = now;
            mergeJob(jobId, { stalled: false, stall_reason: undefined, rendered_frames: framesRendered, total_frames: totalFrames });
          }
          if (now - tickAt >= 2000) { inst = (framesRendered - tickF) / ((now - tickAt) / 1000); tickF = framesRendered; tickAt = now; }
          const fps = inst > 0 ? inst : framesRendered / Math.max(0.001, (now - t0) / 1000);
          const pct = Math.round(10 + (framesRendered / totalFrames) * 70); // frames = 10..80%
          updateStage(jobId, "Render frames", { status: lastFrames >= totalFrames ? "done" : "running", detail: `${framesRendered}/${totalFrames} · ${fps.toFixed(1)} fps` });
          mergeJob(jobId, { status: "PROCESSING", progress: pct });
          if (pct - lastPct >= 10) { lastPct = pct; logLine(jobId, `${pct}% · ${framesRendered}/${totalFrames} frames · ${fps.toFixed(1)} fps`); }
        },
      } as any);
    } finally { clearInterval(watch); }
    endStage(jobId, "Render frames", "done", `${totalFrames}/${totalFrames}`);

    // 2) Audio-only WAV (fast — no video encode, and no visual items to re-load).
    // Feed renderMedia a trimmed design (audio + video only) so it doesn't stall
    // re-evaluating the full image/caption timeline just to mix the soundtrack.
    // If the timeline has no sound-bearing items at all, skip the pass entirely —
    // otherwise the WAV render would hang re-evaluating every visual for silence.
    startStage(jobId, "Audio");
    mergeJob(jobId, { status: "PROCESSING", progress: 84 });
    const audioDesign = audioOnlyDesign(inputProps.design);
    const soundItems = Object.values(audioDesign?.trackItemsMap ?? {}).filter(
      (it: any) => it?.type === "audio" || it?.type === "video",
    );
    const hasAudio = soundItems.length > 0;
    if (hasAudio) {
      logLine(jobId, `Audio pass: ${soundItems.length} sound item(s) (visuals stripped)`);
      await renderMedia({ composition, serveUrl, inputProps: { ...inputProps, design: audioDesign }, codec: "wav" as any, outputLocation: audioPath, timeoutInMilliseconds: RENDER_ASSET_TIMEOUT_MS });
      endStage(jobId, "Audio", "done");
    } else {
      endStage(jobId, "Audio", "done", "no audio — skipped");
    }

    // 3) NVENC encode: JPEG sequence (glob-sorted) + audio → mp4.
    startStage(jobId, "Encode (NVENC)");
    mergeJob(jobId, { status: "PROCESSING", progress: 90 });
    const args = [
      "-y", "-hide_banner", "-nostats", "-loglevel", "warning",
      "-framerate", String(composition.fps),
      "-pattern_type", "glob", "-i", path.join(framesDir, "element-*.jpeg"),
      ...(hasAudio ? ["-i", audioPath] : []),
      "-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", String(crf), "-pix_fmt", "yuv420p",
      ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      "-shortest", outputPath,
    ];
    await execFileAsync("ffmpeg", args, { timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024 });
    endStage(jobId, "Encode (NVENC)", "done");
    mergeJob(jobId, { encoder: "h264_nvenc" });
    logLine(jobId, "✓ NVENC encode complete");
  } finally {
    rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runRemotionExport(jobId: string, design: any, options: any) {
  const { renderMedia, selectComposition } = await import("@remotion/renderer");

  // The RAM budget this render may plan for. Precedence: the job's own value (superadmin
  // setting, injected by the GUI) → the machine's saved setting/env/default. It caps how many
  // Chrome workers run, so a fleet box doesn't OOM under several concurrent renders.
  const ramBudgetGB = clampRamBudget(options?.ramBudgetGB) ?? (await readExportSettings()).ramBudgetGB;

  const exportsDir = publicPath("exports");
  await mkdir(exportsDir, { recursive: true });
  const outputPath = path.join(exportsDir, `${jobId}.mp4`);

  // Keep /editor in the origin — headless Chrome reaches Next.js directly, under the basePath.
  //
  // This origin is what R2 sees, and this Chrome is the only part of the render that CORS can
  // touch — the FF path downloads server-side and never meets it. The bucket serves `*` today,
  // so it's fine; it used to be a per-origin allowlist that 127.0.0.1:3001 was never on, and
  // media failed here while working everywhere else. If that ever comes back, the bucket's CORS
  // policy is the first place to look, not this file. See features/editor/utils/asset-url.ts.
  const serverOrigin = (
    process.env.EDITOR_INTERNAL_ORIGIN ?? "http://127.0.0.1:3001/editor"
  ).replace(/\/$/, "");

  mergeJob(jobId, { status: "PROCESSING", progress: 5, stages: [], log: [] });

  // Stage 1 — Bundle (webpack; cached after the first render of the process).
  startStage(jobId, "Bundle", cachedBundleUrl ? "cached" : "first run — slower");
  const serveUrl = await getBundleUrl();
  endStage(jobId, "Bundle", "done");

  mergeJob(jobId, { status: "PROCESSING", progress: 10 });

  // Build muted/hidden maps for useTrackVisibilityStore in RenderRoot
  const mutedMap: Record<string, boolean> = {};
  const hiddenMap: Record<string, boolean> = {};
  for (const id of (options?.mutedTrackIds ?? [])) mutedMap[id] = true;
  for (const id of (options?.hiddenTrackIds ?? [])) hiddenMap[id] = true;

  // Stage 0 — Localize (overlapped): rewrite srcs → local cache route instantly, warm
  // the cache in the background. Render starts now; cache-through covers un-warmed assets.
  const localizedDesign = await localizeAssets(jobId, design, serverOrigin);

  // Stage 2 — Prepare composition (evaluates the Root, resolves durationInFrames).
  startStage(jobId, "Prepare");
  const inputProps = { design: localizedDesign, serverOrigin, mutedMap, hiddenMap };
  const composition = await selectComposition({
    serveUrl,
    id: "main",
    inputProps,
    timeoutInMilliseconds: RENDER_TIMEOUT_MS,
  });
  endStage(jobId, "Prepare", "done", `${composition.width}x${composition.height} · ${composition.durationInFrames}f @ ${composition.fps}fps`);

  const totalCores = os.cpus()?.length || 0;
  const videoSecs = composition.durationInFrames / composition.fps;
  const exportQuality = String(options?.quality || "high");
  const crf = CRF_BY_QUALITY[exportQuality] ?? 20;
  const conc = effectiveConcurrency(ramBudgetGB);
  logLine(jobId, `render workers: ${conc.value}/${conc.cores} cores (cap: ${conc.capBy})`);
  const renderCfg = {
    concurrency: conc.value,
    cores: totalCores,
    gpu: RENDER_GL ? `on (${RENDER_GL})` : "off",
    hwAccel: "if-possible",
    crf,
    export_quality: exportQuality,
    resolution: `${composition.width}x${composition.height}`,
    // Best-guess encoder for the standard renderMedia path; the NVENC path overrides
    // this to h264_nvenc at its start so the report shows what actually encoded.
    encoder: os.platform() === "darwin" ? "videotoolbox" : "libx264",
  };
  console.log(
    `[render-remotion] ▶ START job=${jobId} | ${composition.width}x${composition.height}@${composition.fps}fps ` +
    `${composition.durationInFrames}f (${videoSecs.toFixed(1)}s video) | concurrency=${renderCfg.concurrency}/${totalCores}cores ` +
    `gpu=${renderCfg.gpu} hwAccel=${renderCfg.hwAccel}`
  );
  const _t0 = Date.now();
  mergeJob(jobId, {
    status: "PROCESSING",
    progress: 15,
    engine: "remotion",
    source: "editor-manual",
    project_name: "User Export",
    started_at: Math.floor(_t0 / 1000),
    video_seconds: Math.round(videoSecs),
    ...renderCfg,
  });

  // NVENC path (opt-in RENDER_NVENC=1, NVIDIA box): render frames + audio, then encode
  // via the system ffmpeg's h264_nvenc. Any failure falls through to renderMedia below.
  let usedNvenc = false;
  if (await hasNvenc()) {
    try {
      await renderViaNvenc(jobId, composition, serveUrl, inputProps, outputPath, crf, _t0, ramBudgetGB);
      usedNvenc = true;
    } catch (e) {
      logLine(jobId, `NVENC path failed — falling back to Remotion libx264: ${String((e as any)?.message || e).slice(0, 120)}`);
      mergeJob(jobId, { stalled: false, stall_reason: undefined });
    }
  }

  if (!usedNvenc) {
  // Stage 3 — Render frames. This is the heavy phase (OffthreadVideo/ffmpeg frame
  // extraction). A stall watchdog watches frame throughput: if no NEW frame lands
  // for STALL_AFTER_MS we flag the render stalled + the last asset it was pulling,
  // so the UI stops showing a silent % (the "stuck at 65%" case).
  const totalFrames = composition.durationInFrames;
  startStage(jobId, "Render frames", `0/${totalFrames}`);
  let lastFrames = 0;
  let lastFrameAt = Date.now();
  let lastAsset = "";
  let encodeStarted = false;
  let lastPctLogged = 0;
  // For INSTANTANEOUS fps (throughput right now) vs the cumulative average, which
  // is dragged down by asset-download stalls and misleads ("30→11").
  let tickFrames = 0;
  let tickAt = Date.now();
  let instFps = 0;

  let stallLogged = false;
  const watchdog = setInterval(() => {
    // Once all frames are rendered, the Encode/mux phase legitimately produces NO new
    // frames — don't misread that as a stall (it was firing a false ⚠ during encode).
    if (lastFrames >= totalFrames) return;
    const idleMs = Date.now() - lastFrameAt;
    if (idleMs >= STALL_AFTER_MS) {
      const reason = `no frame for ${Math.round(idleMs / 1000)}s at ${lastFrames}/${totalFrames}` +
        (lastAsset ? ` · last asset ${lastAsset}` : "");
      updateStage(jobId, "Render frames", { status: "stalled", detail: reason });
      mergeJob(jobId, { stalled: true, stall_reason: reason });
      // Log the stall too (not just the GUI badge) so it's confirmed in the record.
      if (!stallLogged) { logLine(jobId, `⚠ STALL — ${reason}`); stallLogged = true; }
    } else if (stallLogged && idleMs < STALL_AFTER_MS) {
      logLine(jobId, `▶ resumed at ${lastFrames}/${totalFrames}`);
      stallLogged = false;
    }
  }, 5000);

  try {
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      crf, // visually-lossless-but-smaller (was Remotion default → ~1.2GB)
      outputLocation: outputPath,
      inputProps,
      concurrency: conc.value,
      // Use hardware encoding when available (e.g. macOS VideoToolbox). Falls back
      // to CPU (libx264) automatically if not supported.
      hardwareAcceleration: "if-possible",
      ...(RENDER_GL ? { chromiumOptions: { gl: RENDER_GL as any } } : {}),
      timeoutInMilliseconds: RENDER_ASSET_TIMEOUT_MS,
      imageFormat: "jpeg",
      jpegQuality: 90,
      // cache decoded video frames in memory across Chrome instances
      offthreadVideoCacheSizeInBytes: 200 * 1024 * 1024,
      // Which asset each frame is fetching — surfaces a slow/stuck source video.
      onDownload: (src: string) => {
        lastAsset = shortAsset(src);
        logLine(jobId, `⬇ asset ${lastAsset}`);
        return undefined;
      },
      // Headless-Chrome errors (image decode, font, /api/proxy 404, …) → logs.
      onBrowserLog: (l: any) => {
        if (l?.type === "error") logLine(jobId, `browser✕ ${String(l.text).slice(0, 200)}`);
      },
      onProgress: ({ progress, renderedFrames, encodedFrames, stitchStage }: any) => {
        const nowMs = Date.now();
        if (typeof renderedFrames === "number" && renderedFrames > lastFrames) {
          lastFrames = renderedFrames;
          lastFrameAt = nowMs;
          mergeJob(jobId, { stalled: false, stall_reason: undefined, rendered_frames: renderedFrames, total_frames: totalFrames });
        }
        const pct = Math.round(15 + progress * 83);
        const secs = (nowMs - _t0) / 1000;
        const avgFps = (renderedFrames ?? 0) / Math.max(0.001, secs);
        // Instantaneous fps over the last ~2s window — the real current throughput.
        if (nowMs - tickAt >= 2000) {
          instFps = ((renderedFrames ?? 0) - tickFrames) / ((nowMs - tickAt) / 1000);
          tickFrames = renderedFrames ?? 0;
          tickAt = nowMs;
        }
        const fps = instFps > 0 ? instFps : avgFps;
        updateStage(jobId, "Render frames", {
          status: lastFrames >= totalFrames ? "done" : "running",
          detail: `${renderedFrames ?? 0}/${totalFrames} · ${fps.toFixed(1)} fps${lastAsset ? " · ⬇ " + lastAsset.slice(0, 28) : ""}`,
        });
        // Stage 4 — Encode/mux runs concurrently once frames start landing.
        if (!encodeStarted && ((encodedFrames ?? 0) > 0 || stitchStage === "muxing")) {
          encodeStarted = true;
          startStage(jobId, "Encode", stitchStage || "encoding");
        }
        if (encodeStarted) {
          updateStage(jobId, "Encode", { detail: `${encodedFrames ?? 0}/${totalFrames}${stitchStage ? " · " + stitchStage : ""}` });
        }
        mergeJob(jobId, { status: "PROCESSING", progress: pct });
        if (pct - lastPctLogged >= 10) { lastPctLogged = pct; logLine(jobId, `${pct}% · ${renderedFrames ?? 0}/${totalFrames} frames · ${fps.toFixed(1)} fps`); }
      },
    });
  } finally {
    clearInterval(watchdog);
  }
  endStage(jobId, "Render frames", "done", `${totalFrames}/${totalFrames}`);
  if (encodeStarted) endStage(jobId, "Encode", "done");
  } // end !usedNvenc (standard Remotion renderMedia path)

  // Render speed metrics — so you can SEE if the cores/GPU/hwAccel actually help.
  const renderSecs = (Date.now() - _t0) / 1000;
  const fps = composition.durationInFrames / Math.max(0.001, renderSecs);
  const speedX = videoSecs / Math.max(0.001, renderSecs); // >1 = faster than realtime
  let sizeMB = 0;
  try {
    const { statSync } = await import("fs");
    sizeMB = statSync(outputPath).size / (1024 * 1024);
  } catch {}
  console.log(
    `[render-remotion] ✓ DONE job=${jobId} | ${renderSecs.toFixed(1)}s render for ${videoSecs.toFixed(1)}s video ` +
    `(${speedX.toFixed(2)}x realtime, ${fps.toFixed(1)} render-fps) | ${sizeMB.toFixed(1)}MB | ` +
    `concurrency=${conc.value} gpu=${RENDER_GL || "off"}`
  );
  logLine(jobId, `✓ done · ${renderSecs.toFixed(1)}s for ${videoSecs.toFixed(1)}s video (${speedX.toFixed(2)}x) · ${sizeMB.toFixed(1)}MB`);
  _stageStart.delete(jobId);
  mergeJob(jobId, {
    status: "COMPLETED",
    progress: 100,
    stalled: false,
    stall_reason: undefined,
    render_seconds: Math.round(renderSecs),
    render_fps: Math.round(fps * 10) / 10,
    speed_x: Math.round(speedX * 100) / 100,
    size_mb: Math.round(sizeMB * 10) / 10,
    concurrency: conc.value,
    gpu: RENDER_GL ? `on (${RENDER_GL})` : "off",
  });

  // Notify vapp_server — it fetches the MP4 from local URL and uploads to R2.
  // In pull mode (skipCallback) the render AGENT owns upload+report, so the editor
  // must NOT also callback (would double-upload to the wrong vApp).
  if (!options?.skipCallback) {
    const editorBase = (process.env.EDITOR_INTERNAL_ORIGIN ?? "http://127.0.0.1:3001/editor").replace(/\/$/, "");
    const videoUrl = `${editorBase}/api/render-remotion/${jobId}/download`;
    fetch(`${CALLBACK_BASE}/vapp/render_callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId, status: "COMPLETED", video_url: videoUrl }),
    }).catch(() => {});
  }
}

// A GUI render already going on THIS machine, if any. Mirrors the FF route: pressing Export
// again is how you ask "is it still running?", so we hand back the live job instead of
// spawning a second heavy Chrome render of the same video. Pull/queue jobs (skipCallback)
// are NOT reattached — those are distinct jobs an agent chose to run, and the worker RAM cap
// (free-RAM-aware) is what keeps several from swamping the box.
function activeGuiRender(): string | null {
  for (const [id, job] of jobs) {
    const s = String((job as any).status || "").toUpperCase();
    if ((s === "PENDING" || s === "PROCESSING") && !(job as any).cancelled) return id;
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request);
    const { design, options } = body;
    if (!design) {
      return NextResponse.json({ message: "design required" }, { status: 400 });
    }

    // GUI double-press → reattach to the render already running (not a second one).
    if (!options?.skipCallback) {
      const running = activeGuiRender();
      if (running) {
        logLine(running, "↩ export pressed again — reattached to this render (already running)");
        return NextResponse.json({ render: { id: running, reattached: true } }, { status: 200 });
      }
    }

    const jobId = randomBytes(8).toString("hex");
    mergeJob(jobId, {
      status: "PENDING",
      progress: 0,
      engine: "remotion",
      source: "editor-manual",
      project_name: "User Export",
      started_at: Math.floor(Date.now() / 1000),
    });
    // Pull mode (skipCallback): the agent registers/reports the job on its source
    // vApp, so the editor skips its own push-tracking registration here.
    if (!options?.skipCallback) {
      // Fire-and-forget — don't await a possibly-slow/timing-out vApp server before
      // returning the jobId, or the browser sits at 0% until the registration timeout.
      registerRenderJob({
        job_id: jobId,
        engine: "remotion",
        source: "editor-manual",
        project_name: "User Export",
      }).catch((err) => console.warn("[render-remotion] register_render_job failed:", err));
    }

    runRemotionExport(jobId, design, options).catch((err) => {
      console.error(`[render-remotion] job ${jobId} failed:`, err);
      const current = jobs.get(jobId) as any;
      // Mark whatever stage was running as failed, so the breakdown shows where.
      const stages = ((current?.stages as any[]) ?? []).map((s) =>
        s.status === "running" || s.status === "stalled" ? { ...s, status: "failed" } : s,
      );
      logLine(jobId, `✕ FAILED · ${String(err?.message || err).slice(0, 300)}`);
      _stageStart.delete(jobId);
      mergeJob(jobId, { status: "FAILED", progress: current?.progress ?? 0, error: err.message, stages, stalled: false });
      // Notify vapp_server of failure — skipped in pull mode (agent reports failure).
      if (!options?.skipCallback) {
        fetch(`${CALLBACK_BASE}/vapp/render_callback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ job_id: jobId, status: "FAILED", error: err.message }),
        }).catch(() => {});
      }
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
  if (!job) {
    return NextResponse.json({ message: "job not found" }, { status: 404 });
  }
  return NextResponse.json({
    render: {
      id,
      status: job.status,
      progress: job.progress,
      error: job.error,
      presigned_url:
        job.status === "COMPLETED"
          ? `/api/render-remotion/${id}/download`
          : undefined,
      // observability
      stages: job.stages,
      log: job.log,
      rendered_frames: job.rendered_frames,
      total_frames: job.total_frames,
      stalled: job.stalled,
      stall_reason: job.stall_reason,
    },
  });
}
