import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useDownloadState } from "./store/use-download-state";
import { RenderReportRow, type RenderJob } from "./render-report";
import { Button } from "@/components/ui/button";
import { CircleCheckIcon, Minimize2Icon, XIcon } from "lucide-react";
import { DialogDescription, DialogTitle } from "@radix-ui/react-dialog";
import { download } from "@/utils/download";
import { processFileUpload } from "@/utils/upload-service";
import { useEffect, useRef, useState } from "react";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const DownloadProgressModal = () => {
  const { progress, displayProgressModal, minimizedProgressModal, output, error, exporting, exportRunId, metrics, report, actions } =
    useDownloadState();
  const isCompleted = progress === 100 && !!output;
  const isFailed = !!error;
  const showDock = minimizedProgressModal && (exporting || isCompleted || isFailed);
  const dialogOpen = displayProgressModal && !minimizedProgressModal;

  const [elapsed, setElapsed] = useState(0);
  const [autoDownloaded, setAutoDownloaded] = useState(false);
  const startRef = useRef<number | null>(null);
  const finalRef = useRef<number>(0);

  const [cloudState, setCloudState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [cloudUrl, setCloudUrl] = useState<string | null>(null);

  useEffect(() => {
    startRef.current = Date.now();
    finalRef.current = 0;
    setElapsed(0);
    setAutoDownloaded(false);
    setCloudState("idle");
    setCloudUrl(null);
  }, [exportRunId]);

  useEffect(() => {
    if (displayProgressModal && !isCompleted && !isFailed) {
      if (startRef.current === null) startRef.current = Date.now();
      const id = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startRef.current!) / 1000));
      }, 1000);
      return () => clearInterval(id);
    }
    if (isCompleted || isFailed) {
      finalRef.current = elapsed;
    }
  }, [displayProgressModal, isCompleted, isFailed]);

  useEffect(() => {
    if (!displayProgressModal && !minimizedProgressModal) {
      startRef.current = null;
      setElapsed(0);
      setAutoDownloaded(false);
      setCloudState("idle");
      setCloudUrl(null);
    }
  }, [displayProgressModal, minimizedProgressModal]);

  useEffect(() => {
    if (isCompleted && output?.url && !autoDownloaded) {
      setAutoDownloaded(true);
      download(output.url, "untitled.mp4");
    }
  }, [isCompleted, output]);

  const handleDownload = async () => {
    if (output?.url) await download(output.url, "untitled.mp4");
  };

  const handleUploadToCloud = async () => {
    if (!output?.url || cloudState !== "idle") return;

    // render_callback already uploaded to R2 — use that URL directly, no re-upload needed
    if (output.publicUrl) {
      setCloudUrl(output.publicUrl);
      setCloudState("done");
      return;
    }

    // Fallback: fetch local video and upload via vapp server
    setCloudState("uploading");
    try {
      const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
      const fetchUrl = output.url.startsWith("http")
        ? output.url
        : `${window.location.origin}${basePath}${output.url}`;
      const res = await fetch(fetchUrl);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const blob = await res.blob();
      const file = new File([blob], `render_${Date.now()}.mp4`, { type: "video/mp4" });
      const uploadData = await processFileUpload(`render-upload-${Date.now()}`, file, {
        onProgress: () => {},
        onStatus: (_, status) => {
          if (status === "failed") setCloudState("error");
        },
      });
      const url = uploadData?.metadata?.directUrl || uploadData?.filePath || uploadData?.url;
      if (url) {
        setCloudUrl(url);
        setCloudState("done");
      } else {
        setCloudState("error");
      }
    } catch {
      setCloudState("error");
    }
  };

  const handleMinimize = () => {
    actions.setMinimizedProgressModal(true);
    actions.setDisplayProgressModal(false);
  };

  const handleRestore = () => {
    actions.setMinimizedProgressModal(false);
    actions.setDisplayProgressModal(true);
  };

  const handleDismiss = () => {
    actions.setMinimizedProgressModal(false);
    actions.setDisplayProgressModal(false);
  };

  // Shape this export into the SAME job object the Exports widget renders, so the
  // Download modal shows the one shared <RenderReportRow> (no separate reporting UI).
  const modalJob: RenderJob = {
    ...(metrics ?? {}),
    ...(report ?? {}),
    job_id: `export-${exportRunId}`,
    status: isFailed ? "FAILED" : isCompleted ? "COMPLETED" : exporting ? "PROCESSING" : "PENDING",
    progress: Math.floor(progress),
    project_name: "User Export",
    source: "editor-manual",
    error: error ?? undefined,
    started_at: startRef.current ? Math.floor(startRef.current / 1000) : undefined,
  };

  return (
    <>
      {showDock && (
        <div
          onClick={handleRestore}
          title="Open export"
          className="pointer-events-auto flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-background/90 px-2 text-[11px] font-medium shadow-sm transition-colors hover:bg-accent"
        >
          <span className={isCompleted ? "text-green-600 dark:text-green-500" : isFailed ? "text-red-500" : "text-blue-500"}>
            {isCompleted ? "✓ Export done" : isFailed ? "✕ Export failed" : `⬇ Exporting ${Math.floor(progress)}%`}
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleDismiss(); }}
            className="text-muted-foreground hover:text-foreground"
            title="Dismiss"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (open) {
            actions.setDisplayProgressModal(true);
            actions.setMinimizedProgressModal(false);
            return;
          }
          if (exporting && !isCompleted && !isFailed) {
            handleMinimize();
            return;
          }
          handleDismiss();
        }}
      >
      <DialogContent className="z-[30000] pointer-events-auto flex h-[627px] flex-col gap-0 bg-background p-0 sm:max-w-[844px]">
        <DialogTitle className="hidden" />
        <DialogDescription className="hidden" />
        <div className="absolute right-4 top-4 z-[30001] flex items-center gap-1 pointer-events-auto">
          <Button variant="ghost" size="icon" className="h-8 w-8 pointer-events-auto" onClick={handleMinimize}>
            <Minimize2Icon className="h-4 w-4 text-zinc-400" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 pointer-events-auto" onClick={handleDismiss}>
            <XIcon className="h-5 w-5 text-zinc-400" />
          </Button>
        </div>
        <div className="flex h-16 items-center border-b px-4 font-medium">
          Download
        </div>

        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6">
          {/* The ONE reporting module — same <RenderReportRow> the Exports widget uses. */}
          <div className="w-full max-w-md overflow-hidden rounded-xl border border-[#222] bg-[#111] text-white shadow-lg">
            <RenderReportRow job={modalJob} borderBottom={false} />
          </div>

          {isCompleted && (
            <>
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <CircleCheckIcon className="h-4 w-4 text-green-500" />
                Saved to your Downloads{finalRef.current > 0 ? ` · ${fmt(finalRef.current)}` : ""}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleDownload}>
                  Download again
                </Button>
                {cloudState === "idle" && (
                  <Button variant="outline" size="sm" onClick={handleUploadToCloud}>
                    Upload to Cloud
                  </Button>
                )}
                {cloudState === "uploading" && (
                  <Button variant="outline" size="sm" disabled>
                    Uploading…
                  </Button>
                )}
              </div>
              {cloudState === "done" && cloudUrl && (
                <div className="flex flex-col items-center gap-1 w-full max-w-sm">
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">Cloud URL</div>
                  <div className="flex w-full items-center gap-2">
                    <input
                      readOnly
                      value={cloudUrl}
                      className="flex-1 text-xs bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-zinc-200"
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                    />
                    <Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(cloudUrl)}>
                      Copy
                    </Button>
                  </div>
                </div>
              )}
              {cloudState === "error" && (
                <div className="text-xs text-red-400">Upload failed. Try again.</div>
              )}
            </>
          )}

          {isFailed && (
            <Button variant="outline" onClick={handleDismiss}>
              Close
            </Button>
          )}

          {!isCompleted && !isFailed && (
            <>
              <div className="text-center text-xs text-zinc-500">
                <div>Closing the browser will not cancel the export.</div>
                <div>You can minimize this and keep working.</div>
              </div>
              <Button variant="outline" onClick={handleMinimize}>
                Minimize
              </Button>
            </>
          )}
        </div>
      </DialogContent>
      </Dialog>
    </>
  );
};

export default DownloadProgressModal;
