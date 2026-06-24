import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useDownloadState } from "./store/use-download-state";
import { Button } from "@/components/ui/button";
import { CircleCheckIcon, XCircleIcon, XIcon } from "lucide-react";
import { DialogDescription, DialogTitle } from "@radix-ui/react-dialog";
import { download } from "@/utils/download";
import { processFileUpload } from "@/utils/upload-service";
import { useEffect, useRef, useState } from "react";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const DownloadProgressModal = () => {
  const { progress, displayProgressModal, output, error, actions } =
    useDownloadState();
  const isCompleted = progress === 100 && !!output;
  const isFailed = !!error;

  const [elapsed, setElapsed] = useState(0);
  const [autoDownloaded, setAutoDownloaded] = useState(false);
  const startRef = useRef<number | null>(null);
  const finalRef = useRef<number>(0);

  const [cloudState, setCloudState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [cloudUrl, setCloudUrl] = useState<string | null>(null);

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
    if (!displayProgressModal) {
      startRef.current = null;
      setElapsed(0);
      setAutoDownloaded(false);
      setCloudState("idle");
      setCloudUrl(null);
    }
  }, [displayProgressModal]);

  useEffect(() => {
    if (isCompleted && output?.url && !autoDownloaded) {
      setAutoDownloaded(true);
      download(output.url, "untitled.mp4");
    }
  }, [isCompleted, output]);

  const handleDownload = async () => {
    if (output?.url) await download(output.url, "untitled.mp4");
  };

  // Same flow as timeline "Upload to library"
  const handleUploadToCloud = async () => {
    if (!output?.url || cloudState !== "idle") return;
    setCloudState("uploading");
    try {
      const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
      const fetchUrl = `${window.location.origin}${basePath}${output.url}`;
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

  return (
    <Dialog
      open={displayProgressModal}
      onOpenChange={actions.setDisplayProgressModal}
    >
      <DialogContent className="flex h-[627px] flex-col gap-0 bg-background p-0 sm:max-w-[844px]">
        <DialogTitle className="hidden" />
        <DialogDescription className="hidden" />
        <XIcon
          onClick={() => actions.setDisplayProgressModal(false)}
          className="absolute right-4 top-5 h-5 w-5 text-zinc-400 hover:cursor-pointer hover:text-zinc-500"
        />
        <div className="flex h-16 items-center border-b px-4 font-medium">
          Download
        </div>

        {isCompleted ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 space-y-4">
            <div className="flex flex-col items-center space-y-1 text-center">
              <CircleCheckIcon className="h-10 w-10 text-green-500" />
              <div className="text-xl font-bold">Done — Downloaded!</div>
              <div className="text-muted-foreground text-sm">
                Your video has been saved to your Downloads folder.
              </div>
              {finalRef.current > 0 && (
                <div className="text-xs text-muted-foreground/60">
                  Exported in {fmt(finalRef.current)}
                </div>
              )}
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
              <div className="flex flex-col items-center gap-1 w-full max-w-sm px-4">
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
          </div>
        ) : isFailed ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
            <XCircleIcon className="h-10 w-10 text-red-500" />
            <div className="font-bold text-red-500">Export Failed</div>
            <div className="max-h-40 w-full overflow-auto rounded-md bg-zinc-900 px-4 py-3 text-xs text-zinc-300 font-mono whitespace-pre-wrap">
              {error}
            </div>
            <Button variant="outline" onClick={() => actions.setDisplayProgressModal(false)}>
              Close
            </Button>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-4">
            <div className="text-5xl font-semibold">{Math.floor(progress)}%</div>
            <div className="font-bold">Exporting...</div>
            <div className="text-sm tabular-nums text-muted-foreground">{fmt(elapsed)}</div>
            <div className="text-center text-zinc-500">
              <div>Closing the browser will not cancel the export.</div>
              <div>The video will be saved in your space.</div>
            </div>
            <Button variant="outline" onClick={() => actions.setDisplayProgressModal(false)}>
              Cancel
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default DownloadProgressModal;
