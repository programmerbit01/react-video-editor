// ─────────────────────────────────────────────────────────────────────────────
// render-report-types — pure types + helpers for render reporting.
//
// NO "use client", NO JSX, NO React — so BOTH the server render route
// (api/render-remotion) and the client UI import the SAME shapes/helpers.
// The client component <RenderReportRow> lives in render-report.tsx and
// re-exports everything here.
// ─────────────────────────────────────────────────────────────────────────────

// One instrumented phase of a render (bundle / prepare / frames / encode / …).
export interface RenderStage {
  name: string;
  status: "running" | "done" | "stalled" | "failed";
  ms?: number;       // wall-clock duration once finished
  detail?: string;   // e.g. "1080/1800 · 24 fps" or "1920x1080 · 300f"
}

// Every field either surface can show. Superset used everywhere (server writes it,
// client reads it). All optional + defensive so a missing/new field never breaks.
export interface RenderJob {
  job_id?: string;
  status?: string;
  progress?: number;
  project_name?: string;
  source?: string;
  engine?: string;
  started_at?: number;
  // metrics (filled by whatever the engine reports)
  video_seconds?: number;
  render_seconds?: number;
  render_fps?: number;
  speed_x?: number;
  size_mb?: number;
  encoder?: string;
  gpu?: string;
  hwAccel?: string;
  cores?: number;
  concurrency?: number;
  crf?: number;
  export_quality?: string;
  resolution?: string;
  // live render telemetry (observability)
  stages?: RenderStage[];
  log?: string[];
  rendered_frames?: number;
  total_frames?: number;
  stalled?: boolean;
  stall_reason?: string;
  // result / diagnostics
  video_url?: string;
  message?: string;
  error?: string;
}

// The subset the Download modal carries in its store. Alias of the metric-bearing
// fields so store code + modal read one canonical shape.
export type RenderMetrics = Pick<
  RenderJob,
  | "engine" | "gpu" | "cores" | "concurrency" | "hwAccel"
  | "render_seconds" | "render_fps" | "speed_x" | "size_mb" | "video_seconds" | "encoder"
  | "crf" | "export_quality" | "resolution"
>;

export const METRIC_KEYS: (keyof RenderMetrics)[] = [
  "engine", "gpu", "cores", "concurrency", "hwAccel",
  "render_seconds", "render_fps", "speed_x", "size_mb", "video_seconds", "encoder",
  "crf", "export_quality", "resolution",
];

// Pull the known metric fields out of any status/result object.
export const pickMetrics = (src: any): RenderMetrics | undefined => {
  if (!src || typeof src !== "object") return undefined;
  const m: RenderMetrics = {};
  let any = false;
  for (const k of METRIC_KEYS) {
    const v = (src as any)[k];
    if (v !== undefined && v !== null && v !== "") { (m as any)[k] = v; any = true; }
  }
  return any ? m : undefined;
};

// ── labels / colors ──────────────────────────────────────────────────────────

export function statusColor(status?: string): string {
  switch (String(status || "").toUpperCase()) {
    case "COMPLETED": return "#22c55e";
    case "FAILED":    return "#ef4444";
    case "PROCESSING":return "#3b82f6";
    default:          return "#f59e0b";
  }
}

export function statusLabel(status?: string): string {
  switch (String(status || "").toUpperCase()) {
    case "COMPLETED": return "Done";
    case "FAILED":    return "Failed";
    case "PROCESSING":return "Rendering";
    default:          return "Queued";
  }
}

export function sourceLabel(job: RenderJob): string {
  if (job.source === "editor-manual") return "User Export";
  if (job.source === "mcp-ai")        return "AI Render";
  return "Render";
}

export function engineLabel(job: Pick<RenderJob, "engine">): string {
  const e = String(job.engine || "").toLowerCase();
  if (e === "ffmpeg" || e === "ff") return "FF";
  if (e === "remotion" || e === "re") return "RE";
  return "";
}

// ── durations ────────────────────────────────────────────────────────────────

// Compact duration: "45s" / "1m 5s".
export function fmtDur(s?: number): string {
  if (s == null || !Number.isFinite(s)) return "";
  s = Math.round(s);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Millisecond duration for stage timings: "420ms" / "3.4s" / "1m 5s".
export function fmtMs(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return fmtDur(ms / 1000);
}

// Wall-clock elapsed from a unix start timestamp.
export function elapsedFrom(startedAt?: number): string {
  if (!startedAt) return "";
  return fmtDur(Math.floor(Date.now() / 1000 - startedAt));
}

export function stageIcon(status: RenderStage["status"]): string {
  switch (status) {
    case "done":    return "✓";
    case "stalled": return "⚠";
    case "failed":  return "✕";
    default:        return "◔";
  }
}

// ── the ONE stats line ───────────────────────────────────────────────────────
//   phase "done" → video · render · speed · fps · size · (encoder|gpu)
//   phase "live" → gpu · cores · cc · hwAccel
export function renderStatsLine(j: RenderJob, phase: "live" | "done"): string {
  const p: string[] = [];
  if (phase === "done") {
    if (j.video_seconds != null)  p.push(`${fmtDur(j.video_seconds)} video`);
    if (j.render_seconds != null) p.push(`${fmtDur(j.render_seconds)} render`);
    if (j.speed_x)                p.push(`${j.speed_x}×`);
    if (j.render_fps)             p.push(`${j.render_fps} fps`);
    if (j.size_mb)                p.push(`${j.size_mb}MB`);
    if (j.crf != null)            p.push(`CRF ${j.crf}`);
    if (j.encoder)                p.push(j.encoder);
    else if (j.gpu)               p.push(`GPU ${j.gpu}`);
  } else {
    if (j.resolution)  p.push(j.resolution);
    if (j.crf != null) p.push(`CRF ${j.crf}`);
    if (j.encoder)     p.push(j.encoder);
    if (j.gpu)         p.push(`GPU ${j.gpu}`);
    if (j.cores)       p.push(`${j.cores} cores`);
    if (j.concurrency) p.push(`cc ${j.concurrency}`);
    if (j.hwAccel)     p.push(j.hwAccel);
  }
  return p.join(" · ");
}
