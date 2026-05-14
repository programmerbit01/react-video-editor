import { ADD_AUDIO, ADD_IMAGE, ADD_VIDEO } from "@designcombo/state";
import { dispatch } from "@designcombo/events";
import { Music, Loader2, UploadIcon, Upload, RefreshCw } from "lucide-react";
import { generateId } from "@designcombo/timeline";
import { Button } from "@/components/ui/button";
import useUploadStore from "../store/use-upload-store";
import useLayoutStore from "../store/use-layout-store";
import ModalUpload from "@/components/modal-upload";
import { useEffect, useState } from "react";
import { useVappMediaStore } from "../store/use-vapp-media-store";

const getLabel = (item: any) =>
  item.fileName || item.file?.name || item.url?.split("/").pop()?.split("?")[0] || "";

const isVideo = (u: any) => u.type?.startsWith("video/") || u.type === "video";
const isAudio = (u: any) => u.type?.startsWith("audio/") || u.type === "audio";

const Thumb = ({ item }: { item: any }) => {
  const src = item.metadata?.uploadedUrl || item.url;
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
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} className="w-full h-full object-cover" alt="" loading="lazy" />;
};

async function loadVappMedia(
  setUploads: (fn: (prev: any[]) => any[]) => void,
): Promise<void> {
  if (typeof window === "undefined") return;
  const p = new URLSearchParams(window.location.search);
  const vappHost = p.get("vappHost") || `${window.location.protocol}//${window.location.hostname}:3000`;
  const token = p.get("token") || "";
  const baseUrl = p.get("baseUrl") || "https://api.muapi.ai";

  const res = await fetch(
    `${vappHost}/api/vapp/media?token=${encodeURIComponent(token)}&baseUrl=${encodeURIComponent(baseUrl)}`
  );
  const data = await res.json();
  const proxyUrl = (url: string) => `/api/proxy?url=${encodeURIComponent(url)}`;

  const items = (data.items || []).map((item: any) => {
    const proxied = proxyUrl(item.url);
    return {
      id: Math.random().toString(36).slice(2),
      url: proxied,
      filePath: proxied,
      fileName: item.name || item.url.split("/").pop()?.split("?")[0] || "media",
      type: item.type === "video" ? "video/mp4" : item.type === "audio" ? "audio/mp3" : "image/jpeg",
      metadata: { uploadedUrl: proxied },
      status: "uploaded",
    };
  });

  setUploads((prev: any[]) => {
    // Replace all vapp items with fresh ones (identified by proxy URL pattern)
    const nonVapp = prev.filter((u: any) => !u.url?.includes("/api/proxy"));
    return [...nonVapp, ...items];
  });
}

export const Uploads = () => {
  const { setShowUploadModal, uploads, pendingUploads, activeUploads, setUploads } = useUploadStore();
  const { page, hasMore, loadingMore, setPage, setHasMore, setLoadingMore } = useVappMediaStore();
  const [refreshing, setRefreshing] = useState(false);

  const getVappParams = () => {
    if (typeof window === "undefined") return { vappHost: "", token: "", baseUrl: "" };
    const p = new URLSearchParams(window.location.search);
    return {
      vappHost: p.get("vappHost") || `${window.location.protocol}//${window.location.hostname}`,
      token: p.get("token") || "",
      baseUrl: p.get("baseUrl") || "https://api.muapi.ai",
    };
  };

  const fetchVappPage = async (pageNum: number) => {
    const { vappHost, token, baseUrl } = getVappParams();
    const res = await fetch(
      `${vappHost}/api/vapp/media?token=${encodeURIComponent(token)}&baseUrl=${encodeURIComponent(baseUrl)}&page=${pageNum}`
    );
    const data = await res.json();
    const proxyUrl = (url: string) => `/api/proxy?url=${encodeURIComponent(url)}`;
    const items = (data.items || []).map((item: any) => {
      const proxied = proxyUrl(item.url);
      return {
        id: Math.random().toString(36).slice(2),
        url: proxied,
        filePath: proxied,
        fileName: item.name || item.url.split("/").pop()?.split("?")[0] || "media",
        type: item.type === "video" ? "video/mp4" : item.type === "audio" ? "audio/mp3" : "image/jpeg",
        metadata: { uploadedUrl: proxied },
        status: "uploaded",
      };
    });
    setHasMore(data.hasMore ?? false);
    setUploads((prev: any[]) => {
      const existingUrls = new Set(prev.map((u: any) => u.url));
      return [...prev, ...items.filter((i: any) => !existingUrls.has(i.url))];
    });
    setPage(pageNum);
  };

  const handleLoadMore = async () => {
    setLoadingMore(true);
    try { await fetchVappPage(page + 1); } catch {}
    finally { setLoadingMore(false); }
  };

  // Auto-load page 1 on mount if nothing loaded yet
  useEffect(() => {
    if (uploads.length === 0 && page === 1) {
      fetchVappPage(1).catch(() => {});
    }
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try { await loadVappMedia(setUploads); } catch {}
    setRefreshing(false);
  };

  const handleAdd = async (item: any) => {
    const src = item.metadata?.uploadedUrl || item.url;

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

    // image
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
          title="Refresh Vapp media"
          disabled={refreshing}
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
