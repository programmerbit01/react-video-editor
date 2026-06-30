import { IDesign } from "@designcombo/types";
import { create } from "zustand";
import useTrackVisibilityStore from "./use-track-visibility-store";
import useStore from "./use-store";

export type ExportQuality = "high" | "medium" | "low";
export type ExportResolution = "720p" | "1080p" | "540p" | "2k";
export type ExportEngine = "ffmpeg" | "remotion";

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
  payload?: IDesign;
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
    startExport: () => void;
    setDisplayProgressModal: (displayProgressModal: boolean) => void;
    setMinimizedProgressModal: (minimized: boolean) => void;
  };
}

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
  displayProgressModal: false,
  minimizedProgressModal: false,
  actions: {
    setProjectId: (projectId) => set({ projectId }),
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
    startExport: async () => {
      try {
        set({
          exporting: true,
          exportRunId: get().exportRunId + 1,
          displayProgressModal: true,
          minimizedProgressModal: false,
          progress: 0,
          error: null,
          output: undefined,
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
        const { look } = useStore.getState();
        const designWithLook = {
          ...payload,
          metadata: { ...(payload as any).metadata, look },
        } as IDesign;

        const isRemotion = exportEngine === "remotion";
        const apiBase = isRemotion ? "/api/render-remotion" : "/api/render";

        const response = await fetch(apiBase, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            design: designWithLook,
            options: {
              fps: 30,
              maxDim,
              mutedTrackIds,
              hiddenTrackIds,
              format: exportType,
              quality: exportQuality,
            },
          }),
        });

        if (!response.ok) {
          let msg = `Export request failed (${response.status})`;
          try { const j = await response.json(); if (j?.message) msg = j.message; } catch {}
          throw new Error(msg);
        }

        const jobInfo = await response.json();
        const jobId = jobInfo.render.id;

        const checkStatus = async () => {
          try {
            const statusResponse = await fetch(`${apiBase}/${jobId}`, {
              headers: { "Content-Type": "application/json" },
            });
            if (!statusResponse.ok) throw new Error("Failed to fetch export status.");

            const statusInfo = await statusResponse.json();
            const { status, progress, presigned_url: url, error, public_url: publicUrl } = statusInfo.render;
            set({ progress });

            if (status === "COMPLETED") {
              set({ exporting: false, output: { url, publicUrl, type: get().exportType } });
            } else if (status === "PROCESSING" || status === "PENDING") {
              setTimeout(checkStatus, 2500);
            } else if (status === "FAILED") {
              set({ exporting: false, error: error || "Export failed. Check server logs." });
            }
          } catch (pollErr) {
            set({ exporting: false, error: String(pollErr) });
          }
        };

        checkStatus();
      } catch (error) {
        console.error(error);
        set({ exporting: false, error: String(error) });
      }
    },
  },
}));
