import { ADD_AUDIO, ADD_IMAGE, ADD_VIDEO } from "@designcombo/state";
import { dispatch } from "@designcombo/events";
import { Music, Loader2, UploadIcon, Upload, RefreshCw, Play, Pause } from "lucide-react";
import { generateId } from "@designcombo/timeline";
import { Button } from "@/components/ui/button";
import useUploadStore from "../store/use-upload-store";
import useCaptionTranscribeStore from "../store/use-caption-transcribe-store";
import ModalUpload from "@/components/modal-upload";
import { useEffect, useRef, useState } from "react";
import type { Dispatch, MouseEvent, SetStateAction } from "react";

const getLabel = (item: any) =>
  item.fileName || item.file?.name || item.url?.split("/").pop()?.split("?")[0] || "";

const isVideo = (u: any) => u.type?.startsWith("video/") || u.type === "video";
const isAudio = (u: any) => u.type?.startsWith("audio/") || u.type === "audio";
const isVappProxyItem = (u: any) =>
  Boolean(u?.url?.includes("/api/proxy?url=") || u?.filePath?.includes("/api/proxy?url="));

const normalizeMediaSrc = (src?: string) => {
  if (!src) return "";
  if (src.startsWith("/uploads/")) return `/editor${src}`;
  return src;
};

const Thumb = ({ item }: { item: any }) => {
  const src = normalizeMediaSrc(item.metadata?.uploadedUrl || item.url);
  if (isAudio(item)) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-white/5">
        <Music className="w-6 h-6 text-muted-foreground" />
      </div>
    );
  }
  if (isVideo(item)) {
    return (
      <video
        src={src}
        className="w-full h-full object-cover"
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={(e) => { (e.currentTarget as HTMLVideoElement).currentTime = 0.5; }}
      />
    );
  }
  return <img src={src} className="w-full h-full object-cover" alt="" loading="lazy" />;
};

const UploadGridItem = ({
  item,
  onAdd,
  activePreviewId,
  setActivePreviewId,
}: {
  item: any;
  onAdd: (item: any) => void;
  activePreviewId: string | null;
  setActivePreviewId: Dispatch<SetStateAction<string | null>>;
}) => {
  const mediaId = String(item.id || item.url || item.fileName || Math.random());
  const src = normalizeMediaSrc(item.metadata?.uploadedUrl || item.url);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const previewable = isVideo(item) || isAudio(item);

  const stopPreview = () => {
    videoRef.current?.pause();
    audioRef.current?.pause();
    if (videoRef.current) videoRef.current.currentTime = 0;
    if (audioRef.current) audioRef.current.currentTime = 0;
    setIsPlaying(false);
    setActivePreviewId((current) => (current === mediaId ? null : current));
  };

  useEffect(() => {
    if (activePreviewId !== mediaId && isPlaying) {
      videoRef.current?.pause();
      audioRef.current?.pause();
      if (videoRef.current) videoRef.current.currentTime = 0;
      if (audioRef.current) audioRef.current.currentTime = 0;
      setIsPlaying(false);
    }
  }, [activePreviewId, isPlaying, mediaId]);

  const handleTogglePreview = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!previewable) return;
    if (isPlaying) {
      stopPreview();
      return;
    }
    setActivePreviewId(mediaId);
    try {
      if (isVideo(item) && videoRef.current) {
        videoRef.current.currentTime = 0;
        await videoRef.current.play();
      } else if (isAudio(item) && audioRef.current) {
        audioRef.current.currentTime = 0;
        await audioRef.current.play();
      }
      setIsPlaying(true);
    } catch {
      setIsPlaying(false);
    }
  };

  return (
    <div className="flex flex-col gap-1 items-center">
      <div
        className="relative w-full aspect-video rounded-md overflow-hidden cursor-pointer bg-white/5 hover:ring-1 hover:ring-white/20 transition-all"
        onClick={() => onAdd(item)}
        onMouseLeave={stopPreview}
      >
        <Thumb item={item} />
        {isVideo(item) && (
          <video
            ref={videoRef}
            src={src}
            className={`absolute inset-0 h-full w-full object-cover transition-opacity ${isPlaying ? "opacity-100" : "opacity-0 pointer-events-none"}`}
            playsInline
            preload="metadata"
            onEnded={stopPreview}
          />
        )}
        {isAudio(item) && (
          <audio
            ref={audioRef}
            src={src}
            preload="metadata"
            onEnded={stopPreview}
          />
        )}
        {previewable && (
          <button
            type="button"
            onClick={handleTogglePreview}
            className="absolute top-1.5 right-1.5 z-10 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/75 text-white/90 hover:bg-black/90"
            title={isPlaying ? "Stop preview" : "Play preview"}
          >
            {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 ml-0.5" />}
          </button>
        )}
      </div>
      <span className="text-xs text-muted-foreground truncate w-full text-center">
        {getLabel(item)}
      </span>
    </div>
  );
};

const getVappParams = () => {
  if (typeof window === "undefined") return { vappHost: "", token: "", baseUrl: "" };
  const p = new URLSearchParams(window.location.search);
  return {
    vappHost: p.get("vappHost") || `${window.location.protocol}//${window.location.hostname}`,
    token: p.get("token") || "",
    baseUrl: p.get("baseUrl") || "https://api.muapi.ai",
  };
};

const toUploadItem = (item: any) => {
  const proxied = `/api/proxy?url=${encodeURIComponent(item.url)}`;
  const entry: any = {
    id: Math.random().toString(36).slice(2),
    url: proxied,
    filePath: proxied,
    fileName: item.name || item.url.split("/").pop()?.split("?")[0] || "media",
    type: item.type === "video" ? "video/mp4" : item.type === "audio" ? "audio/mp3" : "image/jpeg",
    metadata: { uploadedUrl: proxied },
    status: "uploaded",
  };
  if (item.stt && typeof item.stt === "object") {
    entry.stt = item.stt;
    console.log("[uploads] stt found in API item", { url: proxied, segments: item.stt?.segments?.length });
  } else {
    console.log("[uploads] no stt in API item", { url: proxied, type: item.type, hasStt: !!item.stt });
  }
  return entry;
};

export const Uploads = () => {
  const { setShowUploadModal, uploads, pendingUploads, activeUploads, setUploads } = useUploadStore();
  const { setTranscriptResult } = useCaptionTranscribeStore();
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  const initialLoaded = useRef(false);

  const fetchPage = async (pageNum: number, replace = false) => {
    const { vappHost, token, baseUrl } = getVappParams();
    const apiUrl = `${vappHost}/api/vapp/media?token=${encodeURIComponent(token)}&baseUrl=${encodeURIComponent(baseUrl)}&page=${pageNum}`;
    console.log("[uploads] fetchPage url →", apiUrl);
    const res = await fetch(apiUrl);
    const data = await res.json();
    console.log("[uploads] raw API response total:", data.total, "hasMore:", data.hasMore);
    const rawItems = data.items || [];
    console.log("[uploads] all item urls + stt:", rawItems.map((it: any) => ({
      url: String(it.url || "").slice(-60),
      type: it.type || it.media,
      hasStt: !!it.stt,
      keys: Object.keys(it),
    })));
    const items = rawItems.map(toUploadItem);
    const explicitHasMore = data.hasMore ?? data.pagination?.hasMore;
    const inferredHasMore =
      typeof data.total === "number" && rawItems.length > 0
        ? pageNum * rawItems.length < data.total
        : rawItems.length > 0;
    setHasMore(Boolean(explicitHasMore ?? inferredHasMore));
    setUploads((prev: any[]) => {
      const base = replace ? prev.filter((u: any) => !isVappProxyItem(u)) : prev;
      const existingUrls = new Set(base.map((u: any) => u.url));
      const merged = [...base, ...items.filter((i: any) => !existingUrls.has(i.url))];
      const localItems = merged.filter((u: any) => !isVappProxyItem(u));
      const vappItems = merged.filter((u: any) => isVappProxyItem(u));
      return [...localItems, ...vappItems];
    });
    setPage(pageNum);
  };

  useEffect(() => {
    if (!initialLoaded.current) {
      initialLoaded.current = true;
      fetchPage(1).catch(() => {});
    }
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try { await fetchPage(1, true); } catch {}
    setRefreshing(false);
  };

  const handleLoadMore = async () => {
    setLoadingMore(true);
    try { await fetchPage(page + 1); } catch {}
    setLoadingMore(false);
  };

  const handleAdd = async (item: any) => {
    const src = normalizeMediaSrc(item.metadata?.uploadedUrl || item.url);

    if (isAudio(item)) {
      dispatch(ADD_AUDIO, {
        payload: { id: generateId(), type: "audio", details: { src }, metadata: {} },
        options: {},
      });
      return;
    }

    if (isVideo(item)) {
      let duration = 10000, width = 1920, height = 1080;
      try {
        const meta = await new Promise<{ duration: number; width: number; height: number }>(
          (resolve, reject) => {
            const el = document.createElement("video");
            el.preload = "metadata";
            el.onloadedmetadata = () => resolve({
              duration: Math.round(el.duration * 1000) || 10000,
              width: el.videoWidth || 1920,
              height: el.videoHeight || 1080,
            });
            el.onerror = reject;
            el.src = src;
            el.load();
          }
        );
        duration = meta.duration; width = meta.width; height = meta.height;
      } catch {}
      const videoMeta: Record<string, any> = { previewUrl: "" };
      if (item.stt && typeof item.stt === "object") {
        videoMeta.transcriptData = item.stt;
        setTranscriptResult(src, item.stt);
      } else {
        // no stt in store yet — fetch in background immediately on add
        const { vappHost, token, baseUrl } = getVappParams();
        fetch(`${vappHost}/api/vapp/stt?token=${encodeURIComponent(token)}&baseUrl=${encodeURIComponent(baseUrl)}&url=${encodeURIComponent(src)}`)
          .then((r) => r.json())
          .then((data) => { if (data?.stt?.segments?.length) setTranscriptResult(src, data.stt); })
          .catch(() => {});
      }
      dispatch(ADD_VIDEO, {
        payload: { id: generateId(), duration, details: { src, width, height }, metadata: videoMeta },
        options: { resourceId: "main", scaleMode: "fit" },
      });
      return;
    }

    let width = 1920, height = 1080;
    try {
      const meta = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth || 1920, height: img.naturalHeight || 1080 });
        img.onerror = reject;
        img.src = src;
      });
      width = meta.width; height = meta.height;
    } catch {}
    dispatch(ADD_IMAGE, {
      payload: { id: generateId(), type: "image", display: { from: 0, to: 5000 }, details: { src, width, height }, metadata: {} },
      options: {},
    });
  };

  const hasItems = uploads.length > 0 || pendingUploads.length > 0 || activeUploads.length > 0;
  const localUploads = uploads.filter((u: any) => !isVappProxyItem(u));
  const vappUploads = uploads.filter((u: any) => isVappProxyItem(u));

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-y-auto">
      <ModalUpload />

      <div className="p-4 flex gap-2">
        <Button className="flex-1 cursor-pointer" onClick={() => setShowUploadModal(true)} variant="outline">
          <UploadIcon className="w-4 h-4" />
          <span className="ml-2">Upload</span>
        </Button>
        <Button
          variant="outline"
          className="cursor-pointer px-3"
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {!hasItems && (
        <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
          <Upload size={32} className="opacity-50" />
          <span className="text-sm">No uploads yet</span>
        </div>
      )}

      {(pendingUploads.length > 0 || activeUploads.length > 0) && (
        <div className="px-4 pb-2">
          <div className="font-medium text-sm mb-2 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            Uploading…
          </div>
          {[...pendingUploads, ...activeUploads].map((u) => (
            <div key={u.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate flex-1">{u.file?.name || "…"}</span>
              <span>{u.progress ?? 0}%</span>
            </div>
          ))}
        </div>
      )}

      {uploads.length > 0 && (
        <div className="px-4 pb-2">
          {localUploads.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {localUploads.map((item, idx) => (
                <UploadGridItem
                  key={item.id || `local-${idx}`}
                  item={item}
                  onAdd={handleAdd}
                  activePreviewId={activePreviewId}
                  setActivePreviewId={setActivePreviewId}
                />
              ))}
            </div>
          )}

          {localUploads.length > 0 && vappUploads.length > 0 && (
            <div className="my-3 border-t border-white/10" />
          )}

          {vappUploads.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {vappUploads.map((item, idx) => (
                <UploadGridItem
                  key={item.id || `vapp-${idx}`}
                  item={item}
                  onAdd={handleAdd}
                  activePreviewId={activePreviewId}
                  setActivePreviewId={setActivePreviewId}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {hasMore && (
        <div className="px-4 pb-4 pt-1">
          <Button
            variant="outline"
            className="w-full"
            onClick={handleLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Load more
          </Button>
        </div>
      )}
    </div>
  );
};
