import { IDesign } from "@designcombo/types";
import { create } from "zustand";
import useTrackVisibilityStore from "./use-track-visibility-store";
import useStore from "./use-store";
import { vappCtx, vappAuth } from "@/utils/vapp-api";
import { pickMetrics, type RenderMetrics, type RenderJob } from "../render-report";

export type ExportQuality = "high" | "medium" | "low";
export type ExportResolution = "720p" | "1080p" | "540p" | "2k";
export type ExportEngine = "ffmpeg" | "remotion";

// RenderMetrics + pickMetrics now live in render-report.ts (single source of truth
// shared with the Exports widget). Re-exported so existing importers keep working.
export type { RenderMetrics } from "../render-report";

// Longest-side max dimension — server uses canvas AR to compute actual W×H
const RESOLUTION_MAX_DIM: Record<ExportResolution, number> = {
  "540p":  960,
  "720p":  1280,
  "1080p": 1920,
  "2k":    2560,
};

interface Output {
  url: string;
  publicUrl?: string;
  type: string;
}

interface DownloadState {
  projectId: string;
  exporting: boolean;
  exportRunId: number;
  exportType: "json" | "mp4" | "fb-whatsapp" | "fb-web-highres";
  exportQuality: ExportQuality;
  exportResolution: ExportResolution;
  exportEngine: ExportEngine;
  progress: number;
  error: string | null;
  output?: Output;
  metrics?: RenderMetrics;
  // Live render telemetry (stages / logs / stall) for the reporting card.
  report?: Pick<RenderJob, "stages" | "log" | "stalled" | "stall_reason" | "rendered_frames" | "total_frames">;
  payload?: IDesign;
  remoteUrl: string;
  displayProgressModal: boolean;
  minimizedProgressModal: boolean;
  actions: {
    setProjectId: (projectId: string) => void;
    setExporting: (exporting: boolean) => void;
    setExportType: (exportType: "json" | "mp4" | "fb-whatsapp" | "fb-web-highres") => void;
    setExportQuality: (q: ExportQuality) => void;
    setExportResolution: (r: ExportResolution) => void;
    setExportEngine: (engine: ExportEngine) => void;
    setProgress: (progress: number) => void;
    setState: (state: Partial<DownloadState>) => void;
    setOutput: (output: Output) => void;
    setRemoteUrl: (remoteUrl: string) => void;
    // remoteBase: render on ANOTHER machine's editor (its /api/render-remotion). Omit = local.
    startExport: (remoteBase?: string) => void;
    // Queue the render as a pull job on the vApp server; a free render agent claims it.
    startQueueExport: () => void;
    setDisplayProgressModal: (displayProgressModal: boolean) => void;
    setMinimizedProgressModal: (minimized: boolean) => void;
  };
}

const REMOTE_URL_KEY = "vapp_render_remote_url";
const loadRemoteUrl = () => {
  try { return localStorage.getItem(REMOTE_URL_KEY) || ""; } catch { return ""; }
};

export const useDownloadState = create<DownloadState>((set, get) => ({
  projectId: "",
  exporting: false,
  exportRunId: 0,
  exportType: "mp4",
  exportQuality: "high",
  exportResolution: "1080p",
  exportEngine: "remotion",
  progress: 0,
  error: null,
  remoteUrl: loadRemoteUrl(),
  displayProgressModal: false,
  minimizedProgressModal: false,
  actions: {
    setProjectId: (projectId) => set({ projectId }),
    setRemoteUrl: (remoteUrl) => { try { localStorage.setItem(REMOTE_URL_KEY, remoteUrl); } catch {} set({ remoteUrl }); },
    setExporting: (exporting) => set({ exporting }),
    setExportType: (exportType) => set({ exportType }),
    setExportQuality: (exportQuality) => set({ exportQuality }),
    setExportResolution: (exportResolution) => set({ exportResolution }),
    setExportEngine: (exportEngine) => set({ exportEngine }),
    setProgress: (progress) => set({ progress }),
    setState: (state) => set({ ...state }),
    setOutput: (output) => set({ output }),
    setDisplayProgressModal: (displayProgressModal) =>
      set({ displayProgressModal }),
    setMinimizedProgressModal: (minimizedProgressModal) =>
      set({ minimizedProgressModal }),
    startExport: async (remoteBase?: string) => {
      try {
        set({
          exporting: true,
          exportRunId: get().exportRunId + 1,
          displayProgressModal: true,
          minimizedProgressModal: false,
          progress: 0,
          error: null,
          output: undefined,
          metrics: undefined,
          report: undefined,
        });
        const { payload, exportQuality, exportResolution, exportType, exportEngine } = get();
        const maxDim = RESOLUTION_MAX_DIM[exportResolution] ?? 1920;
        if (!payload) throw new Error("Payload is not defined");

        const { muted, hidden } = useTrackVisibilityStore.getState();
        const mutedTrackIds = Object.keys(muted).filter((id) => muted[id]);
        const hiddenTrackIds = Object.keys(hidden).filter((id) => hidden[id]);

        // Phase 1 — Film Look: carry the scene-wide grade preset into the render
        // payload so the manual GUI export matches the editor preview. The MCP
        // path sets design.metadata.look itself.
        const { look, stylePack } = useStore.getState();
        const designWithLook = {
          ...payload,
          metadata: { ...(payload as any).metadata, look, stylePack },
        } as IDesign;

        const isRemotion = exportEngine === "remotion";
        const routePath = isRemotion ? "/api/render-remotion" : "/api/render";
        // remoteBase set → render on another machine's editor. A remote editor serves its
        // API under the basePath (/editor); the local same-origin path resolves fine bare.
        const base = remoteBase ? remoteBase.trim().replace(/\/+$/, "") : "";
        const basePathPrefix = base ? (process.env.NEXT_PUBLIC_BASE_PATH || "") : "";
        const apiBase = `${base}${basePathPrefix}${routePath}`;

        // Serialize once so we can show the payload size — a caption-heavy project is a
        // big JSON, and POSTing it to a REMOTE editor (often over a cloudflared tunnel) can
        // take a while. Without this the modal sat at a blank 0% the whole upload.
        const bodyStr = JSON.stringify({
          design: designWithLook,
          options: {
            fps: 30,
            maxDim,
            mutedTrackIds,
            hiddenTrackIds,
            format: exportType,
            quality: exportQuality,
          },
        });
        const sizeMB = (bodyStr.length / 1048576).toFixed(1);
        set({
          report: {
            ...get().report,
            log: [`⬆ uploading project (${sizeMB}MB) to ${base ? "remote render server" : "editor"}…`],
          },
        });
        const response = await fetch(apiBase, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bodyStr,
        });

        if (!response.ok) {
          let msg = `Export request failed (${response.status})`;
          try { const j = await response.json(); if (j?.message) msg = j.message; } catch {}
          throw new Error(msg);
        }

        const jobInfo = await response.json();
        const jobId = jobInfo.render.id;

        // A render can saturate the network while it downloads assets, so a single
        // status poll can transiently "Failed to fetch" even though the server job is
        // fine. Don't kill the whole export on ONE blip — only give up after several
        // consecutive misses (~30s of no contact). The server job keeps running
        // regardless; we're just reconnecting the progress feed.
        let pollFails = 0;
        const MAX_POLL_FAILS = 12;
        const checkStatus = async () => {
          try {
            const statusResponse = await fetch(`${apiBase}/${jobId}`, {
              headers: { "Content-Type": "application/json" },
            });
            if (!statusResponse.ok) throw new Error(`status HTTP ${statusResponse.status}`);

            const statusInfo = await statusResponse.json();
            pollFails = 0; // reached the server — reset the miss counter
            const r = statusInfo.render || {};
            const { status, progress, presigned_url: url, error, public_url: publicUrl } = r;
            set({
              progress,
              metrics: pickMetrics(r) ?? get().metrics,
              report: {
                stages: r.stages ?? get().report?.stages,
                log: r.log ?? get().report?.log,
                stalled: r.stalled,
                stall_reason: r.stall_reason,
                rendered_frames: r.rendered_frames,
                total_frames: r.total_frames,
              },
            });

            if (status === "COMPLETED") {
              // Remote render → the download endpoint lives on the remote machine (under its basePath).
              const finalUrl = base && typeof url === "string" && url.startsWith("/")
                ? `${base}${basePathPrefix}${url}`
                : url;
              set({ exporting: false, output: { url: finalUrl, publicUrl, type: get().exportType } });
            } else if (status === "PROCESSING" || status === "PENDING") {
              setTimeout(checkStatus, 2500);
            } else if (status === "FAILED") {
              set({ exporting: false, error: error || "Export failed. Check server logs." });
            }
          } catch (pollErr) {
            pollFails++;
            if (pollFails >= MAX_POLL_FAILS) {
              set({ exporting: false, error: `Lost contact with the render server after ${pollFails} tries (${String(pollErr)}). The render may still be running — reopen the export to check.` });
            } else {
              // transient network hiccup — keep polling, back off slightly
              setTimeout(checkStatus, 3000);
            }
          }
        };

        checkStatus();
      } catch (error) {
        console.error(error);
        set({ exporting: false, error: String(error) });
      }
    },
    // Queue path — browser hits the vApp server DIRECTLY (no proxy): enqueue a
    // "render" pull job, then poll its status. A render agent claims it, renders on
    // its own editor, uploads the MP4 to R2 and reports the result back to the job.
    startQueueExport: async () => {
      try {
        set({
          exporting: true,
          exportRunId: get().exportRunId + 1,
          displayProgressModal: true,
          minimizedProgressModal: false,
          progress: 0,
          error: null,
          output: undefined,
          metrics: undefined,
          report: undefined,
        });
        const { payload, exportQuality, exportResolution, exportType, exportEngine } = get();
        const maxDim = RESOLUTION_MAX_DIM[exportResolution] ?? 1920;
        if (!payload) throw new Error("Payload is not defined");

        const { baseUrl, token } = vappCtx();
        if (!baseUrl) throw new Error("No vApp server — open the editor from the vApp (missing ?baseUrl).");

        const { muted, hidden } = useTrackVisibilityStore.getState();
        const mutedTrackIds = Object.keys(muted).filter((id) => muted[id]);
        const hiddenTrackIds = Object.keys(hidden).filter((id) => hidden[id]);

        const { look, stylePack } = useStore.getState();
        const designWithLook = {
          ...payload,
          metadata: { ...(payload as any).metadata, look, stylePack },
        } as IDesign;

        const enqueueRes = await fetch(`${baseUrl}/vapp/render/enqueue`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...vappAuth(token) },
          body: JSON.stringify({
            design: designWithLook,
            options: {
              fps: 30,
              maxDim,
              mutedTrackIds,
              hiddenTrackIds,
              format: exportType,
              quality: exportQuality,
              engine: exportEngine,   // "ffmpeg" | "remotion" — agent routes to /api/render vs /api/render-remotion
            },
          }),
        });
        if (!enqueueRes.ok) {
          let msg = `Queue request failed (${enqueueRes.status})`;
          try { const j = await enqueueRes.json(); if (j?.detail || j?.message) msg = j.detail || j.message; } catch {}
          throw new Error(msg);
        }
        const enq = await enqueueRes.json();
        const jobId = enq.job_id || enq.pb_job_id;
        if (!jobId) throw new Error("Queue: no job_id returned");

        const checkStatus = async () => {
          try {
            const sr = await fetch(
              `${baseUrl}/vapp/job/status?job_id=${encodeURIComponent(jobId)}`,
              { headers: vappAuth(token), cache: "no-store" },
            );
            if (!sr.ok) throw new Error("Failed to fetch queue job status.");
            const j = await sr.json();
            const status = String(j?.status || "").toLowerCase();
            const prog = Number(j?.progress);
            if (Number.isFinite(prog)) set({ progress: Math.max(0, Math.min(100, prog)) });
            // Queue metrics arrive (if at all) in result.metrics — surfaced when the agent forwards them.
            const rm = j?.result?.metrics ?? j?.metrics;
            const qm = pickMetrics(rm);
            if (qm) set({ metrics: qm });
            if (rm && (rm.stages || rm.log || rm.stalled)) {
              set({
                report: {
                  stages: rm.stages ?? get().report?.stages,
                  log: rm.log ?? get().report?.log,
                  stalled: rm.stalled,
                  stall_reason: rm.stall_reason,
                  rendered_frames: rm.rendered_frames,
                  total_frames: rm.total_frames,
                },
              });
            }

            const files = Array.isArray(j?.result?.files) ? j.result.files : [];
            const url =
              (files[0] && (files[0].url || files[0])) ||
              j?.output_url ||
              (Array.isArray(j?.output_urls) ? j.output_urls[0] : "") ||
              "";

            if (status === "completed" || status === "done" || status === "succeeded") {
              set({ exporting: false, progress: 100, output: { url, publicUrl: url, type: get().exportType } });
            } else if (status === "failed" || status === "error" || status === "cancelled" || status === "canceled") {
              set({ exporting: false, error: String(j?.error || "Render queue job failed.") });
            } else {
              setTimeout(checkStatus, 2500);
            }
          } catch (pollErr) {
            set({ exporting: false, error: String(pollErr) });
          }
        };

        setTimeout(checkStatus, 2000);
      } catch (error) {
        console.error(error);
        set({ exporting: false, error: String(error) });
      }
    },
  },
}));
