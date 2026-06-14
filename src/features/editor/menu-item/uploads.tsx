import { ADD_AUDIO, ADD_IMAGE, ADD_VIDEO } from "@designcombo/state";
import { dispatch } from "@designcombo/events";
import { Music, Loader2, UploadIcon, Upload, RefreshCw, Play, Pause, AlertCircle } from "lucide-react";
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

// Vapp items = direct CDN (rpublic.*) or old-style proxied URLs
const VAPP_CDN_HOST = "rpublic.tomtap.ai";
const isVappItem = (u: any) =>
  Boolean(
    u?.metadata?.vappItem ||
    u?.url?.includes("/api/proxy?url=") ||
    u?.filePath?.includes("/api/proxy?url=") ||
    u?.url?.includes(VAPP_CDN_HOST)
  );

const normalizeMediaSrc = (src?: string) => {
  if (!src) return "";
  if (src.startsWith("/uploads/")) return `/editor${src}`;
  return src;
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
  const rawUrl = String(item.url || "");
  // Direct URL for public CDN — CORS is configured on R2 for editor origins
  const finalUrl = rawUrl.includes(VAPP_CDN_HOST)
    ? rawUrl
    : rawUrl
    ? `/api/proxy?url=${encodeURIComponent(rawUrl)}`
    : "";
  if (!finalUrl) return null;
  const entry: any = {
    id: `vapp-${rawUrl.split("/").pop()?.split("?")[0] || Math.random().toString(36).slice(2)}`,
    url: finalUrl,
    filePath: finalUrl,
    fileName: item.name || rawUrl.split("/").pop()?.split("?")[0] || "media",
    type: item.type === "video" ? "video/mp4" : item.type === "audio" ? "audio/mp3" : "image/jpeg",
    metadata: { uploadedUrl: finalUrl, vappItem: true },
    status: "uploaded",
  };
  if (item.stt && typeof item.stt === "object") entry.stt = item.stt;
  return entry;
};

// ── Thumbnail ────────────────────────────────────────────────────────────────

const VideoThumb = ({ src }: { src: string }) => {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);

  return (
    <div className="w-full h-full bg-white/5 flex items-center justify-center">
      {!ready && !failed && <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />}
      {failed && <div className="text-[10px] text-muted-foreground">no preview</div>}
      <video
        ref={ref}
        src={src}
        className={`w-full h-full object-cover absolute inset-0 transition-opacity ${ready ? "opacity-100" : "opacity-0"}`}
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={() => {
          if (ref.current) ref.current.currentTime = 1;
        }}
        onSeeked={() => setReady(true)}
        onError={() => { setFailed(true); }}
      />
    </div>
  );
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
    return <VideoThumb src={src} />;
  }
  return (
    <img
      src={src}
      className="w-full h-full object-cover"
      alt=""
      loading="lazy"
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0.3"; }}
    />
  );
};

// ── Grid item ─────────────────────────────────────────────────────────────────

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
  const mediaId = String(item.id || item.url);
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
    setActivePreviewId((curr) => (curr === mediaId ? null : curr));
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
    if (isPlaying) { stopPreview(); return; }
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
            preload="none"
            onEnded={stopPreview}
          />
        )}
        {isAudio(item) && (
          <audio ref={audioRef} src={src} preload="none" onEnded={stopPreview} />
        )}
        {previewable && (
          <button
            type="button"
            onClick={handleTogglePreview}
            className="absolute top-1.5 right-1.5 z-10 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/75 text-white/90 hover:bg-black/90"
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

// ── Main component ────────────────────────────────────────────────────────────

export const Uploads = () => {
  const { setShowUploadModal, uploads, pendingUploads, activeUploads, setUploads } = useUploadStore();
  const { setTranscriptResult } = useCaptionTranscribeStore();
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);

  const fetchPage = async (pageNum: number) => {
    const { vappHost, token, baseUrl } = getVappParams();
    const apiUrl = `${vappHost}/api/vapp/media?token=${encodeURIComponent(token)}&baseUrl=${encodeURIComponent(baseUrl)}&page=${pageNum}`;

    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);

    const data = await res.json();
    const rawItems: any[] = data.items || [];
    const items = rawItems.map(toUploadItem).filter(Boolean);

    const totalPages = data.totalPages || data.pages || 1;
    setHasMore(pageNum < totalPages);

    setUploads((prev: any[]) => {
      // In-session local uploads (user uploaded in this session, not from server)
      const locals = prev.filter((u: any) => !isVappItem(u));
      if (pageNum === 1) {
        // Full replace of vapp items with fresh server data (newest first)
        return [...locals, ...items];
      }
      // Load more: append only new items not already in list
      const existing = new Set(prev.filter((u: any) => isVappItem(u)).map((u: any) => u.url));
      const vapp = prev.filter((u: any) => isVappItem(u));
      return [...locals, ...vapp, ...items.filter((i: any) => !existing.has(i.url))];
    });
    setPage(pageNum);
    setFetchError(null);
  };

  // Fetch on every mount — safe since uploads is no longer persisted in localStorage
  useEffect(() => {
    setLoading(true);
    fetchPage(1)
      .catch((err) => setFetchError(String(err?.message || "Failed to load media")))
      .finally(() => setLoading(false));
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    setFetchError(null);
    try { await fetchPage(1); } catch (err: any) { setFetchError(String(err?.message || "Refresh failed")); }
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
      const audioMeta: Record<string, any> = {};
      if (item.stt && typeof item.stt === "object") {
        audioMeta.transcriptData = item.stt;
        setTranscriptResult(src, item.stt);
      } else {
        const { vappHost, token, baseUrl } = getVappParams();
        fetch(`${vappHost}/api/vapp/stt?token=${encodeURIComponent(token)}&baseUrl=${encodeURIComponent(baseUrl)}&url=${encodeURIComponent(src)}`)
          .then((r) => r.json())
          .then((d) => { if (d?.stt?.segments?.length) setTranscriptResult(src, d.stt); })
          .catch(() => {});
      }
      dispatch(ADD_AUDIO, {
        payload: { id: generateId(), type: "audio", details: { src }, metadata: audioMeta },
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
        const { vappHost, token, baseUrl } = getVappParams();
        fetch(`${vappHost}/api/vapp/stt?token=${encodeURIComponent(token)}&baseUrl=${encodeURIComponent(baseUrl)}&url=${encodeURIComponent(src)}`)
          .then((r) => r.json())
          .then((d) => { if (d?.stt?.segments?.length) setTranscriptResult(src, d.stt); })
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

  const allItems = uploads;
  const hasItems = allItems.length > 0 || pendingUploads.length > 0 || activeUploads.length > 0;

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

      {/* Loading state */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin" />
          <span className="text-xs">Loading media…</span>
        </div>
      )}

      {/* Error state */}
      {!loading && fetchError && (
        <div className="mx-4 mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{fetchError}</span>
        </div>
      )}

      {/* Empty state */}
      {!loading && !hasItems && !fetchError && (
        <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
          <Upload size={32} className="opacity-50" />
          <span className="text-sm">No uploads yet</span>
        </div>
      )}

      {/* Active uploads progress */}
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

      {/* Media grid — single unified list, server order (newest first) */}
      {!loading && allItems.length > 0 && (
        <div className="px-4 pb-2">
          <div className="grid grid-cols-3 gap-2">
            {allItems.map((item, idx) => (
              <UploadGridItem
                key={item.id || `item-${idx}`}
                item={item}
                onAdd={handleAdd}
                activePreviewId={activePreviewId}
                setActivePreviewId={setActivePreviewId}
              />
            ))}
          </div>
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
