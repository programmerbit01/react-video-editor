import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useDownloadState } from "./store/use-download-state";
import { RenderReportRow, type RenderJob } from "./render-report";
import { Button } from "@/components/ui/button";
import { CircleCheckIcon, Minimize2Icon, XIcon, Loader2, CopyIcon, CheckIcon } from "lucide-react";
import { DialogDescription, DialogTitle } from "@radix-ui/react-dialog";
import { download } from "@/utils/download";
import { useEffect, useRef, useState } from "react";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const DownloadProgressModal = ({ projectName }: { projectName?: string }) => {
  const { progress, displayProgressModal, minimizedProgressModal, output, error, exporting, exportRunId, metrics, report, actions } =
    useDownloadState();
  const isCompleted = progress === 100 && !!output;
  const isFailed = !!error;
  // The render finished but `output` isn't set yet: the box is still uploading the mp4 to R2,
  // so the shareable link (and the auto-download) aren't ready. Without a state for this the
  // footer flipped back to "Minimize / Cancel" and looked stuck between "done" and "downloading".
  const finalizing = Math.floor(progress) >= 100 && !output && !isFailed;
  // The link to hand the user: the R2 public URL, else the job URL if it's already absolute.
  // A basePath-relative local path is not shareable, so we fall back to a Download button.
  const shareUrl =
    output?.publicUrl || (output?.url && /^https?:\/\//.test(output.url) ? output.url : null);
  const showDock = minimizedProgressModal && (exporting || isCompleted || isFailed);
  const dialogOpen = displayProgressModal && !minimizedProgressModal;

  const [elapsed, setElapsed] = useState(0);
  const [autoDownloaded, setAutoDownloaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const startRef = useRef<number | null>(null);
  const finalRef = useRef<number>(0);
  const [dlPct, setDlPct] = useState<number | null>(null); // 0-100 while the file streams to disk, null otherwise
  const [dlDone, setDlDone] = useState(false);

  // Filename from the saved project name (falls back to "video"); sanitized, single .mp4.
  const dlName = (projectName || "").replace(/\.mp4$/i, "").replace(/[^\w.\- ]+/g, "_").trim() || "video";

  // Stream the export to disk WITH visible progress instead of a silent full fetch. R2 sends a
  // Content-Length, so we can show "Downloading… X%" — the render being "Done" while the file
  // quietly downloaded for another ~30s is exactly what read as "it stopped / errored". Direct
  // R2, no proxy. Falls back to the plain download() on any stream/read error.
  const downloadWithProgress = async (url: string, filename: string) => {
    setDlDone(false);
    setDlPct(0);
    try {
      const res = await fetch(url);
      const total = Number(res.headers.get("content-length")) || 0;
      const reader = res.body?.getReader();
      let blob: Blob;
      if (!reader || !total) {
        blob = await res.blob();
      } else {
        const chunks: BlobPart[] = [];
        let recv = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            recv += value.length;
            setDlPct(Math.min(99, Math.round((recv / total) * 100)));
          }
        }
        blob = new Blob(chunks, { type: "video/mp4" });
      }
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = /\.mp4$/i.test(filename) ? filename : `${filename}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 2000);
      setDlPct(null);
      setDlDone(true);
    } catch {
      setDlPct(null);
      download(url, filename); // fallback: the original silent path still saves the file
    }
  };

  useEffect(() => {
    startRef.current = Date.now();
    finalRef.current = 0;
    setElapsed(0);
    setAutoDownloaded(false);
    setCopied(false);
    setDlPct(null);
    setDlDone(false);
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
      setCopied(false);
    }
  }, [displayProgressModal, minimizedProgressModal]);

  useEffect(() => {
    if (isCompleted && output?.url && !autoDownloaded) {
      setAutoDownloaded(true);
      downloadWithProgress(output.url, dlName);
    }
  }, [isCompleted, output]);

  const handleDownload = async () => {
    if (output?.url) await downloadWithProgress(output.url, dlName);
  };

  const handleCopy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — the field is selectable as a fallback */ }
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

          {/* Render is done but the mp4 is still uploading to R2 — the link/auto-download aren't
              ready yet. Say so, instead of falling back to the "still rendering" footer. */}
          {finalizing && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Finalizing — preparing your download link…
            </div>
          )}

          {isCompleted && (
            <>
              {dlPct !== null ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Downloading to your device… {dlPct}%
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <CircleCheckIcon className="h-4 w-4 text-green-500" />
                  Saved to your Downloads{finalRef.current > 0 ? ` · ${fmt(finalRef.current)}` : ""}
                </div>
              )}

              {shareUrl ? (
                // The video is already on R2 — show its link directly. No "Download again" (it
                // auto-downloaded and this link re-downloads), no "Upload to Cloud" (already up).
                <div className="flex w-full max-w-md flex-col items-center gap-1.5">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Video link</div>
                  <div className="flex w-full items-center gap-2">
                    <input
                      readOnly
                      value={shareUrl}
                      className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200"
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                    />
                    <Button variant="outline" size="sm" className="shrink-0" onClick={handleCopy}>
                      {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
                    </Button>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Auto-downloaded. Open or re-download from this link anytime.
                  </div>
                </div>
              ) : (
                // Local-only export (no shareable URL) — keep a way to fetch the file again.
                <Button variant="outline" size="sm" onClick={handleDownload}>
                  Download again
                </Button>
              )}
            </>
          )}

          {isFailed && (
            <Button variant="outline" onClick={handleDismiss}>
              Close
            </Button>
          )}

          {!isCompleted && !isFailed && !finalizing && (
            <>
              <div className="text-center text-xs text-zinc-500">
                <div>Closing the browser will not cancel the export.</div>
                <div>You can minimize this and keep working.</div>
              </div>
              <div className="flex items-center justify-center gap-2">
                <Button variant="outline" onClick={handleMinimize}>
                  Minimize
                </Button>
                {exporting && (
                  <Button
                    variant="outline"
                    className="text-red-600 hover:text-red-700"
                    onClick={() => actions.cancelExport()}
                  >
                    Cancel export
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
      </Dialog>
    </>
  );
};

export default DownloadProgressModal;
