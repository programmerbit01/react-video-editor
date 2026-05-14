"use client";
import React, { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import useUploadStore from "../store/use-upload-store";
import { useVappMediaStore } from "../store/use-vapp-media-store";

export const VappMedia = () => {
  const [loading, setLoading] = useState(false);
  const { setUploads } = useUploadStore();
  const { page, hasMore, setPage, setHasMore } = useVappMediaStore();

  const getParams = () => {
    if (typeof window === "undefined") return { vappHost: "", token: "", baseUrl: "" };
    const p = new URLSearchParams(window.location.search);
    return {
      vappHost: p.get("vappHost") || `${window.location.protocol}//${window.location.hostname}`,
      token: p.get("token") || "",
      baseUrl: p.get("baseUrl") || "https://api.muapi.ai",
    };
  };

  const fetchPage = async (pageNum: number, isRefresh = false) => {
    const { vappHost, token, baseUrl } = getParams();
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
      const base = isRefresh ? [] : prev;
      const existingUrls = new Set(base.map((u: any) => u.url));
      return [...base, ...items.filter((i: any) => !existingUrls.has(i.url))];
    });
    return data.hasMore ?? false;
  };

  const load = async () => {
    setLoading(true);
    try {
      await fetchPage(1, true);
      setPage(1);
    } catch {}
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <p className="text-xs text-muted-foreground">Loading Vapp media...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      <p className="text-xs text-muted-foreground">Vapp media loaded in Uploads ✓</p>
      <button
        onClick={load}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-white transition-colors border border-border/40 px-3 py-1.5 rounded-md"
      >
        <RefreshCw className="w-3 h-3" /> Refresh
      </button>
    </div>
  );
};
