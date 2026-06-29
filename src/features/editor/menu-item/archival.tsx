import { dispatch } from "@designcombo/events";
import { generateId } from "@designcombo/timeline";
import Draggable from "@/components/shared/draggable";
import React, { useState } from "react";
import { useIsDraggingOverTimeline } from "../hooks/is-dragging-over-timeline";
import { ADD_ITEMS } from "@designcombo/state";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type MediaType = "image" | "video";

interface MediaItem {
  id: string;
  type: MediaType;
  details: { src: string; width: number; height: number; duration?: number };
  preview: string;
  source_name: string;
  source_url: string;
  license: string;
  author: string;
  title?: string;
}

// Available sources. `video` flags which support video search.
const SOURCES: { id: string; label: string; video: boolean }[] = [
  { id: "pexels", label: "Pexels", video: true },
  { id: "openverse", label: "Openverse", video: false },
  { id: "wikimedia", label: "Wikimedia", video: false },
  { id: "archive", label: "Internet Archive", video: false },
];

const withEditorBase = (path: string) => {
  if (typeof window === "undefined") return path;
  if (window.location.pathname.startsWith("/editor")) return `/editor${path}`;
  return path;
};

export const Archival = () => {
  const isDraggingOverTimeline = useIsDraggingOverTimeline();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<MediaType>("image");
  const [selected, setSelected] = useState<Record<string, boolean>>({
    pexels: true,
    openverse: true,
    wikimedia: false,
    archive: false,
  });
  const [items, setItems] = useState<MediaItem[]>([]);
  const [bySource, setBySource] = useState<Record<string, { count: number; ok: boolean }>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const toggleSource = (id: string) =>
    setSelected((p) => ({ ...p, [id]: !p[id] }));

  const handleSearch = async () => {
    const q = query.trim();
    const sources = SOURCES.filter((s) => selected[s.id] && (type === "image" || s.video)).map((s) => s.id);
    if (!q || sources.length === 0) return;
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const params = new URLSearchParams({
        query: q,
        type,
        sources: sources.join(","),
        per_page: "20",
      });
      const res = await fetch(withEditorBase(`/api/archival?${params.toString()}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(Array.isArray(data.items) ? data.items : []);
      setBySource(data.by_source || {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setItems([]);
      setBySource({});
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = (item: MediaItem) => {
    dispatch(ADD_ITEMS, {
      payload: {
        trackItems: [
          {
            id: generateId(),
            type: item.type,
            display: { from: 0, to: item.type === "video" ? (item.details.duration || 5) * 1000 : 5000 },
            details: {
              src: item.details.src,
              ...(item.type === "image" ? { kenBurns: "zoomIn" } : {}),
            },
            metadata: {
              source_name: item.source_name,
              source_url: item.source_url,
              license: item.license,
              author: item.author,
            },
          },
        ],
      },
    });
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      {/* Format toggle */}
      <div className="flex-none flex items-center gap-1 px-3 pt-2">
        {(["image", "video"] as MediaType[]).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-medium capitalize transition-colors",
              type === t ? "bg-white/10 text-white" : "text-muted-foreground hover:bg-white/5"
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Source checkboxes */}
      <div className="flex-none flex flex-wrap gap-x-3 gap-y-1 px-3 py-2">
        {SOURCES.map((s) => {
          const disabled = type === "video" && !s.video;
          return (
            <label
              key={s.id}
              className={cn(
                "flex items-center gap-1.5 text-xs cursor-pointer select-none",
                disabled ? "opacity-30 cursor-not-allowed" : "text-foreground"
              )}
              title={disabled ? "No video from this source" : ""}
            >
              <input
                type="checkbox"
                checked={!!selected[s.id] && !disabled}
                disabled={disabled}
                onChange={() => toggleSource(s.id)}
                className="accent-white h-3 w-3"
              />
              {s.label}
              {searched && bySource[s.id] && (
                <span className={cn("text-[10px]", bySource[s.id].ok ? "text-muted-foreground" : "text-red-400")}>
                  ({bySource[s.id].ok ? bySource[s.id].count : "x"})
                </span>
              )}
            </label>
          );
        })}
      </div>

      {/* Search box */}
      <div className="flex-none flex items-center gap-1.5 px-3 pb-1">
        <div className="relative flex-1">
          <Button
            size="sm"
            variant="ghost"
            className="absolute left-1 top-1/2 h-5 w-5 -translate-y-1/2 p-0"
            onClick={handleSearch}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
          </Button>
          <Input
            placeholder="Search media..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyPress={handleKeyPress}
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>

      <div className="flex-none px-3 pb-1 text-[10px] text-muted-foreground">
        Mixed stock + archival · source &amp; license shown on each result
      </div>

      {error && (
        <div className="flex-none px-4 pb-2">
          <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950/20 p-2 rounded">{error}</div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto overscroll-contain min-h-0 px-4">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2">
          {items.map((item, index) => (
            <MediaTile
              key={item.id || index}
              item={item}
              shouldDisplayPreview={!isDraggingOverTimeline}
              handleAdd={handleAdd}
            />
          ))}
        </div>
        {loading && (
          <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Searching...
          </div>
        )}
        {!loading && searched && items.length === 0 && !error && (
          <div className="py-6 text-center text-xs text-muted-foreground">No results — try other sources or a broader term.</div>
        )}
      </div>
    </div>
  );
};

const MediaTile = ({
  handleAdd,
  item,
  shouldDisplayPreview,
}: {
  handleAdd: (item: MediaItem) => void;
  item: MediaItem;
  shouldDisplayPreview: boolean;
}) => {
  const style = React.useMemo(
    () => ({ backgroundImage: `url(${item.preview})`, backgroundSize: "cover", width: "80px", height: "80px" }),
    [item.preview]
  );

  const draggableData = {
    id: generateId(),
    type: item.type,
    details: { src: item.details.src, ...(item.type === "image" ? { kenBurns: "zoomIn" } : {}) },
    preview: item.preview,
    metadata: {
      source_name: item.source_name,
      source_url: item.source_url,
      license: item.license,
      author: item.author,
    },
  };

  return (
    <Draggable data={draggableData} renderCustomPreview={<div style={style} />} shouldDisplayPreview={shouldDisplayPreview}>
      <div
        onClick={() => handleAdd(item)}
        title={`${item.title || ""}\n${item.source_name} · ${item.author} · ${item.license}`}
        className="group relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-md bg-background cursor-pointer"
      >
        <img draggable={false} src={item.preview} className="h-full w-full rounded-md object-cover" alt={item.title || "media"} />
        {/* source badge */}
        <span className="absolute top-0 left-0 rounded-br bg-black/70 px-1 py-0.5 text-[9px] font-medium text-white/90">
          {item.source_name}
        </span>
        {/* license footer */}
        <span className="absolute bottom-0 left-0 right-0 truncate bg-black/60 px-1 py-0.5 text-[9px] text-white/80">
          {item.license}
        </span>
      </div>
    </Draggable>
  );
};
