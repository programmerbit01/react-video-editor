import { IDesign } from "@designcombo/types";
import { create } from "zustand";

interface Output {
  url: string;
  type: string;
}

export type ExportQuality = "high" | "medium" | "low";
export type ExportResolution = "720p" | "1080p" | "540p" | "2k";

const RESOLUTION_MAP: Record<ExportResolution, { w: number; h: number }> = {
  "540p":  { w: 540,  h: 960  },
  "720p":  { w: 720,  h: 1280 },
  "1080p": { w: 1080, h: 1920 },
  "2k":    { w: 1440, h: 2560 },
};

interface DownloadState {
  projectId: string;
  exporting: boolean;
  exportType: "json" | "mp4" | "fb-whatsapp" | "fb-web-highres";
  exportQuality: ExportQuality;
  exportResolution: ExportResolution;
  progress: number;
  output?: Output;
  payload?: IDesign;
  displayProgressModal: boolean;
  actions: {
    setProjectId: (projectId: string) => void;
    setExporting: (exporting: boolean) => void;
    setExportType: (exportType: "json" | "mp4" | "fb-whatsapp" | "fb-web-highres") => void;
    setExportQuality: (q: ExportQuality) => void;
    setExportResolution: (r: ExportResolution) => void;
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
  progress: 0,
  displayProgressModal: false,
  actions: {
    setProjectId: (projectId) => set({ projectId }),
    setExporting: (exporting) => set({ exporting }),
    setExportType: (exportType) => set({ exportType }),
    setExportQuality: (exportQuality) => set({ exportQuality }),
    setExportResolution: (exportResolution) => set({ exportResolution }),
    setProgress: (progress) => set({ progress }),
    setState: (state) => set({ ...state }),
    setOutput: (output) => set({ output }),
    setDisplayProgressModal: (displayProgressModal) =>
      set({ displayProgressModal }),
    startExport: async () => {
      try {
        set({ exporting: true, displayProgressModal: true });
        const { payload, exportQuality, exportResolution, exportType } = get();
        const res = RESOLUTION_MAP[exportResolution] ?? RESOLUTION_MAP["1080p"];
        if (!payload) throw new Error("Payload is not defined");

        const response = await fetch(`/api/render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            design: payload,
            options: {
              fps: 30,
              size: { width: res.w, height: res.h },
              format: exportType,
              quality: exportQuality,
            },
          }),
        });

        if (!response.ok) throw new Error("Failed to submit export request.");

        const jobInfo = await response.json();
        const jobId = jobInfo.render.id;

        const checkStatus = async () => {
          const statusResponse = await fetch(`/api/render/${jobId}`, {
            headers: { "Content-Type": "application/json" },
          });
          if (!statusResponse.ok) throw new Error("Failed to fetch export status.");

          const statusInfo = await statusResponse.json();
          const { status, progress, presigned_url: url } = statusInfo.render;
          set({ progress });

          if (status === "COMPLETED") {
            set({ exporting: false, output: { url, type: get().exportType } });
          } else if (status === "PROCESSING" || status === "PENDING") {
            setTimeout(checkStatus, 2500);
          } else if (status === "FAILED") {
            set({ exporting: false });
          }
        };

        checkStatus();
      } catch (error) {
        console.error(error);
        set({ exporting: false });
      }
    },
  },
}));
