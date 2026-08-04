import { dispatch } from "@designcombo/events";
import { generateId } from "@designcombo/timeline";
import Draggable from "@/components/shared/draggable";
import React, { useState } from "react";
import { useIsDraggingOverTimeline } from "../hooks/is-dragging-over-timeline";
import { ADD_ITEMS } from "@designcombo/state";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Loader2, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

// Web / news search tab — Phase 1, fully INDEPENDENT of Stock/archival:
//   type: News | Web | Images  (+ recency for News)
//   → /api/websearch → a Dify web-search app → normalized results
//   → grid of tiles you click OR drag onto the timeline (same as Stock).
// Nothing here imports archival; a broken web search only breaks this tab.

type WebType = "news" | "web" | "images";
type Recency = "day" | "week" | "month" | "any";

interface WebItem {
  id: string;
  type: "image" | "video";
  details: { src: string; width: number; height: number; duration?: number };
  preview: string;
  source_name: string;
  source_url: string;
  title: string;
  snippet?: string;
}

const TYPES: { id: WebType; label: string }[] = [
  { id: "news", label: "News" },
  { id: "web", label: "Web" },
  { id: "images", label: "Images" },
];

const RECENCY: { id: Recency; label: string }[] = [
  { id: "day", label: "24h" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "any", label: "Any" },
];

// The editor runs under a /editor basePath — API calls must carry it.
const withEditorBase = (path: string) => {
  if (typeof window === "undefined") return path;
  if (window.location.pathname.startsWith("/editor")) return `/editor${path}`;
  return path;
};

export const WebSearch = () => {
  const isDraggingOverTimeline = useIsDraggingOverTimeline();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<WebType>("news");
  const [recency, setRecency] = useState<Recency>("week");
  const [items, setItems] = useState<WebItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const handleSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const params = new URLSearchParams({ query: q, type, per_page: "24" });
      if (type === "news") params.set("recency", recency);
      const res = await fetch(withEditorBase(`/api/websearch?${params.toString()}`));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setItems(Array.isArray(data.items) ? data.items : []);
      // A configured-but-empty search (or a Dify-side error) comes back as { items, error }.
      if (data?.error) setError(String(data.error));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = (item: WebItem) => {
    const metadata = {
      source_name: item.source_name,
      source_url: item.source_url,
      title: item.title,
    };
    // Real dims (default 1080p) so a placed clip is never 0×0 (invisible until media loads).
    const w = Number(item.details.width) || 1920;
    const h = Number(item.details.height) || 1080;
    const durMs = (item.details.duration || 5) * 1000;
    dispatch(ADD_ITEMS, {
      payload: {
        trackItems: [
          {
            id: generateId(),
            type: item.type,
            display: { from: 0, to: item.type === "image" ? 5000 : durMs },
            details:
              item.type === "image"
                ? { src: item.details.src, width: w, height: h, kenBurns: "zoomIn" }
                : { src: item.details.src, width: w, height: h },
            metadata,
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
      {/* Row 1 — type */}
      <div className="flex-none flex items-center gap-1 px-3 pt-2">
        {TYPES.map((t) => (
          <button
            key={t.id}
            onClick={() => setType(t.id)}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
              type === t.id ? "bg-white/10 text-white" : "text-muted-foreground hover:bg-white/5"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Row 2 — recency (news only) */}
      {type === "news" && (
        <div className="flex-none flex items-center gap-1 px-3 pt-1.5">
          {RECENCY.map((r) => (
            <button
              key={r.id}
              onClick={() => setRecency(r.id)}
              className={cn(
                "px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors",
                recency === r.id ? "bg-white/10 text-white" : "text-muted-foreground hover:bg-white/5"
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}

      {/* Search */}
      <div className="flex-none flex items-center gap-1.5 px-3 pt-2 pb-1">
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
            placeholder={type === "news" ? "Latest AI news, a headline…" : "Search the web…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyPress={handleKeyPress}
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>

      <div className="flex-none px-3 pb-1 text-[10px] text-muted-foreground">
        Live web &amp; news · via SearXNG · click or drag a result onto the timeline
      </div>

      {error && (
        <div className="flex-none px-4 pb-2">
          <div className="text-xs text-amber-500 bg-amber-50 dark:bg-amber-950/20 p-2 rounded">{error}</div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto overscroll-contain min-h-0 px-4">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2">
          {items.map((item, i) => (
            <WebTile
              key={item.id || i}
              item={item}
              shouldDisplayPreview={!isDraggingOverTimeline}
              handleAdd={handleAdd}
            />
          ))}
        </div>
        {loading && (
          <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Searching…
          </div>
        )}
        {!loading && searched && items.length === 0 && !error && (
          <div className="py-6 text-center text-xs text-muted-foreground">
            No results — try a broader term or a different type.
          </div>
        )}
      </div>
    </div>
  );
};

const WebTile = ({
  handleAdd,
  item,
  shouldDisplayPreview,
}: {
  handleAdd: (item: WebItem) => void;
  item: WebItem;
  shouldDisplayPreview: boolean;
}) => {
  const style = React.useMemo(
    () => ({ backgroundImage: `url(${item.preview})`, backgroundSize: "cover", width: "80px", height: "80px" }),
    [item.preview]
  );
  const draggableData = {
    id: generateId(),
    type: item.type,
    details: {
      src: item.details.src,
      width: Number(item.details.width) || 1920,
      height: Number(item.details.height) || 1080,
      ...(item.type === "image" ? { kenBurns: "zoomIn" } : {}),
    },
    preview: item.preview,
    metadata: { source_name: item.source_name, source_url: item.source_url, title: item.title },
  };
  const [adding, setAdding] = useState(false);
  const onAddClick = () => {
    setAdding(true);
    handleAdd(item);
    window.setTimeout(() => setAdding(false), 1100);
  };
  const bottomLabel = (item.title || "").trim() || item.source_name;
  return (
    <Draggable data={draggableData} renderCustomPreview={<div style={style} />} shouldDisplayPreview={shouldDisplayPreview}>
      <div
        onClick={onAddClick}
        title={`${item.title || "Untitled"}\n${item.source_name}${item.snippet ? `\n\n${item.snippet}` : ""}`}
        className="group relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-md bg-background cursor-pointer"
      >
        <img
          draggable={false}
          src={item.preview}
          className="h-full w-full rounded-md object-cover"
          alt={item.title || "web result"}
        />
        {/* top-left: source badge */}
        <span className="absolute top-0 left-0 z-10 max-w-[85%] truncate rounded-br bg-black/70 px-1 py-0.5 text-[9px] font-medium text-white/90">
          {item.source_name}
        </span>
        {/* top-right: open the source page (stopPropagation so it doesn't add to timeline) */}
        {item.source_url ? (
          <a
            href={item.source_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="Open source"
            className="absolute top-0 right-0 z-10 rounded-bl bg-black/70 p-0.5 text-white/80 opacity-0 transition-opacity group-hover:opacity-100 hover:text-white"
          >
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
        ) : null}
        {/* bottom: title */}
        <span className="absolute bottom-0 left-0 right-0 z-10 truncate bg-black/60 px-1 py-0.5 text-[9px] text-white/85">
          {bottomLabel}
        </span>
        {adding && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-md bg-black/55">
            <Loader2 className="h-5 w-5 animate-spin text-white" />
          </div>
        )}
      </div>
    </Draggable>
  );
};
