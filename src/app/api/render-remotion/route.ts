import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import path from "path";
import { mkdir, readFile } from "fs/promises";
import { jobs } from "./jobs";

async function uploadToR2(jobId: string, outputPath: string): Promise<string | null> {
  try {
    const fileName = `render_${jobId}.mp4`;
    const internalOrigin = (process.env.EDITOR_INTERNAL_ORIGIN ?? "http://127.0.0.1:3001/editor").replace(/\/$/, "");

    // Get presigned URL
    const presignRes = await fetch(`${internalOrigin}/api/uploads/presign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "render", fileNames: [fileName] }),
    });
    if (!presignRes.ok) throw new Error(`presign failed: ${presignRes.status}`);
    const { uploads } = await presignRes.json();
    const { presignedUrl, url: publicUrl } = uploads[0];

    // Upload file to R2
    const fileBuffer = await readFile(outputPath);
    const putRes = await fetch(presignedUrl, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      body: fileBuffer,
    });
    if (!putRes.ok) throw new Error(`R2 PUT failed: ${putRes.status}`);

    console.log(`[render-remotion] uploaded to R2: ${publicUrl}`);
    return publicUrl;
  } catch (e) {
    console.warn(`[render-remotion] R2 upload failed for ${jobId}:`, e);
    return null;
  }
}

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

  // Upload to R2 and notify vapp_server with public URL
  const callbackBase = (process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091").replace(/\/+$/, "");
  uploadToR2(jobId, outputPath).then((cloudUrl) => {
    if (cloudUrl) {
      jobs.set(jobId, { status: "COMPLETED", progress: 100, cloud_url: cloudUrl });
    }
    const videoUrl = cloudUrl || `/editor/api/render-remotion/${jobId}/download`;
    fetch(`${callbackBase}/vapp/render_callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId, status: "COMPLETED", video_url: videoUrl }),
    }).catch(() => {});
  });
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
      cloud_url: job.cloud_url || null,
      presigned_url:
        job.status === "COMPLETED"
          ? `/api/render-remotion/${id}/download`
          : undefined,
    },
  });
}
