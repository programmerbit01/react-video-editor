import { IDesign } from "@designcombo/types";
import { create } from "zustand";
import useTrackVisibilityStore from "./use-track-visibility-store";

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
  type: string;
}

interface DownloadState {
  projectId: string;
  exporting: boolean;
  exportType: "json" | "mp4" | "fb-whatsapp" | "fb-web-highres";
  exportQuality: ExportQuality;
  exportResolution: ExportResolution;
  exportEngine: ExportEngine;
  progress: number;
  error: string | null;
  output?: Output;
  payload?: IDesign;
  displayProgressModal: boolean;
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
  };
}

export const useDownloadState = create<DownloadState>((set, get) => ({
  projectId: "",
  exporting: false,
  exportType: "mp4",
  exportQuality: "high",
  exportResolution: "1080p",
  exportEngine: "remotion",
  progress: 0,
  error: null,
  displayProgressModal: false,
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
    startExport: async () => {
      try {
        set({ exporting: true, displayProgressModal: true, progress: 0, error: null });
        const { payload, exportQuality, exportResolution, exportType, exportEngine } = get();
        const maxDim = RESOLUTION_MAX_DIM[exportResolution] ?? 1920;
        if (!payload) throw new Error("Payload is not defined");

        const { muted, hidden } = useTrackVisibilityStore.getState();
        const mutedTrackIds = Object.keys(muted).filter((id) => muted[id]);
        const hiddenTrackIds = Object.keys(hidden).filter((id) => hidden[id]);

        const isRemotion = exportEngine === "remotion";
        const apiBase = isRemotion ? "/api/render-remotion" : "/api/render";

        const response = await fetch(apiBase, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            design: payload,
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
            const { status, progress, presigned_url: url, error } = statusInfo.render;
            set({ progress });

            if (status === "COMPLETED") {
              set({ exporting: false, output: { url, type: get().exportType } });
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
