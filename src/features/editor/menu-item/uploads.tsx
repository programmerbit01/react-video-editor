import { ADD_AUDIO, ADD_IMAGE, ADD_VIDEO } from "@designcombo/state";
import { dispatch } from "@designcombo/events";
import { Music, Loader2, UploadIcon, Upload, RefreshCw } from "lucide-react";
import { generateId } from "@designcombo/timeline";
import { Button } from "@/components/ui/button";
import useUploadStore from "../store/use-upload-store";
import ModalUpload from "@/components/modal-upload";
import { useEffect, useRef, useState } from "react";

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
  return {
    id: Math.random().toString(36).slice(2),
    url: proxied,
    filePath: proxied,
    fileName: item.name || item.url.split("/").pop()?.split("?")[0] || "media",
    type: item.type === "video" ? "video/mp4" : item.type === "audio" ? "audio/mp3" : "image/jpeg",
    metadata: { uploadedUrl: proxied },
    status: "uploaded",
  };
};

export const Uploads = () => {
  const { setShowUploadModal, uploads, pendingUploads, activeUploads, setUploads } = useUploadStore();
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const initialLoaded = useRef(false);

  const fetchPage = async (pageNum: number, replace = false) => {
    const { vappHost, token, baseUrl } = getVappParams();
    const res = await fetch(
      `${vappHost}/api/vapp/media?token=${encodeURIComponent(token)}&baseUrl=${encodeURIComponent(baseUrl)}&page=${pageNum}`
    );
    const data = await res.json();
    const rawItems = data.items || [];
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
      const vappItems = merged.filter((u: any) => isVappProxyItem(u));
      const localItems = merged.filter((u: any) => !isVappProxyItem(u));
      return [...vappItems, ...localItems];
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
      dispatch(ADD_VIDEO, {
        payload: { id: generateId(), duration, details: { src, width, height }, metadata: { previewUrl: "" } },
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
        <div className="grid grid-cols-3 gap-2 px-4 pb-2">
          {uploads.map((item, idx) => (
            <div key={item.id || idx} className="flex flex-col gap-1 items-center">
              <div
                className="w-full aspect-video rounded-md overflow-hidden cursor-pointer bg-white/5 hover:ring-1 hover:ring-white/20 transition-all"
                onClick={() => handleAdd(item)}
              >
                <Thumb item={item} />
              </div>
              <span className="text-xs text-muted-foreground truncate w-full text-center">
                {getLabel(item)}
              </span>
            </div>
          ))}
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
