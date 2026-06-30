import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { mkdir } from "fs/promises";
import { jobs } from "./jobs";

// Bundle is created once and reused for the lifetime of the server process.
let cachedBundleUrl: string | null = null;
const CALLBACK_BASE = (process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091").replace(/\/+$/, "");

function mergeJob(jobId: string, patch: Record<string, unknown>) {
  const current = jobs.get(jobId) ?? { status: "PENDING", progress: 0 };
  jobs.set(jobId, { ...current, ...patch } as any);
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

// Concurrency = parallel headless-Chrome render workers; the biggest single-machine
// speed lever. Default to (cores - 1), capped 4..16, overridable via env.
const RENDER_CONCURRENCY = (() => {
  const env = parseInt(process.env.REMOTION_CONCURRENCY || "", 10);
  if (Number.isFinite(env) && env > 0) return env;
  const cores = os.cpus()?.length || 8;
  return Math.max(4, Math.min(cores - 1, 16));
})();

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

async function runRemotionExport(jobId: string, design: any, options: any) {
  const { renderMedia, selectComposition } = await import("@remotion/renderer");

  const exportsDir = path.join(process.cwd(), "public", "exports");
  await mkdir(exportsDir, { recursive: true });
  const outputPath = path.join(exportsDir, `${jobId}.mp4`);

  // Keep /editor in origin — headless Chrome accesses Next.js directly
  // e.g. http://127.0.0.1:3001/editor so /api/proxy → /editor/api/proxy
  const serverOrigin = (
    process.env.EDITOR_INTERNAL_ORIGIN ?? "http://127.0.0.1:3001/editor"
  ).replace(/\/$/, "");

  mergeJob(jobId, { status: "PROCESSING", progress: 5 });

  const serveUrl = await getBundleUrl();

  mergeJob(jobId, { status: "PROCESSING", progress: 10 });

  // Build muted/hidden maps for useTrackVisibilityStore in RenderRoot
  const mutedMap: Record<string, boolean> = {};
  const hiddenMap: Record<string, boolean> = {};
  for (const id of (options?.mutedTrackIds ?? [])) mutedMap[id] = true;
  for (const id of (options?.hiddenTrackIds ?? [])) hiddenMap[id] = true;

  const inputProps = { design, serverOrigin, mutedMap, hiddenMap };
  const composition = await selectComposition({
    serveUrl,
    id: "main",
    inputProps,
    timeoutInMilliseconds: RENDER_TIMEOUT_MS,
  });

  const totalCores = os.cpus()?.length || 0;
  const videoSecs = composition.durationInFrames / composition.fps;
  const renderCfg = {
    concurrency: RENDER_CONCURRENCY,
    cores: totalCores,
    gpu: RENDER_GL ? `on (${RENDER_GL})` : "off",
    hwAccel: "if-possible",
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

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: outputPath,
    inputProps,
    concurrency: RENDER_CONCURRENCY,
    // Use hardware encoding when available (e.g. macOS VideoToolbox). Falls back
    // to CPU (libx264) automatically if not supported.
    hardwareAcceleration: "if-possible",
    ...(RENDER_GL ? { chromiumOptions: { gl: RENDER_GL as any } } : {}),
    timeoutInMilliseconds: RENDER_TIMEOUT_MS,
    imageFormat: "jpeg",
    jpegQuality: 90,
    // cache decoded video frames in memory across Chrome instances
    offthreadVideoCacheSizeInBytes: 200 * 1024 * 1024,
    onProgress: ({ progress }) => {
      const pct = Math.round(15 + progress * 83);
      mergeJob(jobId, { status: "PROCESSING", progress: pct });
      if (pct % 10 === 0) console.log(`[render-remotion] job ${jobId}: ${pct}%`);
    },
  });

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
    `concurrency=${RENDER_CONCURRENCY} gpu=${RENDER_GL || "off"}`
  );
  mergeJob(jobId, {
    status: "COMPLETED",
    progress: 100,
    render_seconds: Math.round(renderSecs),
    render_fps: Math.round(fps * 10) / 10,
    speed_x: Math.round(speedX * 100) / 100,
    size_mb: Math.round(sizeMB * 10) / 10,
    concurrency: RENDER_CONCURRENCY,
    gpu: RENDER_GL ? `on (${RENDER_GL})` : "off",
  });

  // Notify vapp_server — it fetches the MP4 from local URL and uploads to R2
  const editorBase = (process.env.EDITOR_INTERNAL_ORIGIN ?? "http://127.0.0.1:3001/editor").replace(/\/$/, "");
  const videoUrl = `${editorBase}/api/render-remotion/${jobId}/download`;
  fetch(`${CALLBACK_BASE}/vapp/render_callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId, status: "COMPLETED", video_url: videoUrl }),
  }).catch(() => {});
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { design, options } = body;
    if (!design) {
      return NextResponse.json({ message: "design required" }, { status: 400 });
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
    try {
      await registerRenderJob({
        job_id: jobId,
        engine: "remotion",
        source: "editor-manual",
        project_name: "User Export",
      });
    } catch (err) {
      console.warn("[render-remotion] register_render_job failed:", err);
    }

    runRemotionExport(jobId, design, options).catch((err) => {
      console.error(`[render-remotion] job ${jobId} failed:`, err);
      const current = jobs.get(jobId);
      mergeJob(jobId, { status: "FAILED", progress: current?.progress ?? 0, error: err.message });
      // Notify vapp_server of failure
      fetch(`${CALLBACK_BASE}/vapp/render_callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId, status: "FAILED", error: err.message }),
      }).catch(() => {});
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
    },
  });
}
