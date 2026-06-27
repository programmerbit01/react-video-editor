import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import path from "path";
import { mkdir } from "fs/promises";
import { jobs } from "./jobs";

// Bundle is created once and reused for the lifetime of the server process.
let cachedBundleUrl: string | null = null;

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

  jobs.set(jobId, { status: "PROCESSING", progress: 5 });

  const serveUrl = await getBundleUrl();

  jobs.set(jobId, { status: "PROCESSING", progress: 10 });

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

  console.log(`[render-remotion] composition: ${composition.width}x${composition.height} @ ${composition.fps}fps, ${composition.durationInFrames} frames (${(composition.durationInFrames / composition.fps).toFixed(1)}s)`);
  jobs.set(jobId, { status: "PROCESSING", progress: 15 });

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: outputPath,
    inputProps,
    concurrency: 7,
    timeoutInMilliseconds: RENDER_TIMEOUT_MS,
    imageFormat: "jpeg",
    jpegQuality: 90,
    // cache decoded video frames in memory across Chrome instances
    offthreadVideoCacheSizeInBytes: 200 * 1024 * 1024,
    onProgress: ({ progress }) => {
      const pct = Math.round(15 + progress * 83);
      jobs.set(jobId, { status: "PROCESSING", progress: pct });
      if (pct % 10 === 0) console.log(`[render-remotion] job ${jobId}: ${pct}%`);
    },
  });

  jobs.set(jobId, { status: "COMPLETED", progress: 100 });

  // Notify vapp_server — it fetches the MP4 from local URL and uploads to R2
  const callbackBase = (process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091").replace(/\/+$/, "");
  const editorBase = (process.env.EDITOR_INTERNAL_ORIGIN ?? "http://127.0.0.1:3001/editor").replace(/\/$/, "");
  const videoUrl = `${editorBase}/api/render-remotion/${jobId}/download`;
  fetch(`${callbackBase}/vapp/render_callback`, {
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
    jobs.set(jobId, { status: "PENDING", progress: 0 });

    runRemotionExport(jobId, design, options).catch((err) => {
      console.error(`[render-remotion] job ${jobId} failed:`, err);
      const current = jobs.get(jobId);
      jobs.set(jobId, { status: "FAILED", progress: current?.progress ?? 0, error: err.message });
      // Notify vapp_server of failure
      const callbackBase = (process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091").replace(/\/+$/, "");
      fetch(`${callbackBase}/vapp/render_callback`, {
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
