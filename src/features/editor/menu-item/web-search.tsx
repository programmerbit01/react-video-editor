import { dispatch } from "@designcombo/events";
import { generateId } from "@designcombo/timeline";
import Draggable from "@/components/shared/draggable";
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { useIsDraggingOverTimeline } from "../hooks/is-dragging-over-timeline";
import { ADD_ITEMS } from "@designcombo/state";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Loader2, ExternalLink, Maximize2, X, Plus, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

// Web / news search tab — Phase 1, fully INDEPENDENT of Stock/archival:
//   type: News | Web | Images  (+ recency for News)
//   → /api/websearch → vApp /vapp/websearch (SearXNG) → normalized results
//   → grid of tiles you click OR drag onto the timeline (same as Stock).
// The compact panel is the quick view; the ⤢ button opens a full-screen
// 2-column research overlay (left results · right = the real page in an iframe)
// with a ✨ Curate button (config-driven LLM pass on the vApp).
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

interface Curation {
  keep: string[];
  scenes: { beat?: string; caption?: string; item_id: string }[];
  note?: string;
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

// Shared: drop a web result's media onto the timeline (used by panel + overlay).
const addWebItemToTimeline = (item: WebItem) => {
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

export const WebSearch = () => {
  const isDraggingOverTimeline = useIsDraggingOverTimeline();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<WebType>("news");
  const [recency, setRecency] = useState<Recency>("week");
  const [items, setItems] = useState<WebItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);

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
      // A configured-but-empty search (or a vApp-side error) comes back as { items, error }.
      if (data?.error) setError(String(data.error));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setItems([]);
    } finally {
      setLoading(false);
    }
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
        {/* Open the full-screen research overlay */}
        <button
          onClick={() => setOverlayOpen(true)}
          title="Open research view (full page reader)"
          className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-white/5 hover:text-white"
        >
          <Maximize2 className="h-3 w-3" /> Research
        </button>
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
        Live web &amp; news · via SearXNG · click a tile to add, or ⤢ Research for the full page
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
              handleAdd={addWebItemToTimeline}
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

      <WebResearchOverlay
        open={overlayOpen}
        onClose={() => setOverlayOpen(false)}
        initialQuery={query}
        initialType={type}
        initialRecency={recency}
      />
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

// ── Full-screen research overlay ─────────────────────────────────────────────
// Left: search + result cards (stable — click a card just previews, no re-search).
// Right: the selected result's REAL page in a plain iframe (full interaction).
//   Big sites that send X-Frame-Options stay blank → use "Open" (browser rule).
//   The iframe is sandboxed WITHOUT allow-top-navigation so a page's frame-buster
//   can never hijack the editor tab.
// ✨ Curate re-runs the search with curate=1: filters to the LLM's `keep`, orders
// by its scene plan, shows each scene's caption, and surfaces the `note`.
function WebResearchOverlay({
  open,
  onClose,
  initialQuery,
  initialType,
  initialRecency,
}: {
  open: boolean;
  onClose: () => void;
  initialQuery: string;
  initialType: WebType;
  initialRecency: Recency;
}) {
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState(initialQuery);
  const [type, setType] = useState<WebType>(initialType);
  const [recency, setRecency] = useState<Recency>(initialRecency);
  const [items, setItems] = useState<WebItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [curating, setCurating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<WebItem | null>(null);
  const [curation, setCuration] = useState<Curation | null>(null);
  const [frameLoading, setFrameLoading] = useState(false);

  useEffect(() => setMounted(true), []);

  const runSearch = useCallback(
    async (curate: boolean) => {
      const q = query.trim();
      if (!q) return;
      if (curate) setCurating(true);
      else {
        setLoading(true);
        setCuration(null);
      }
      setError(null);
      try {
        const params = new URLSearchParams({ query: q, type, per_page: "40" });
        if (type === "news") params.set("recency", recency);
        if (curate) params.set("curate", "1");
        const res = await fetch(withEditorBase(`/api/websearch?${params.toString()}`));
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        if (!curate) setItems(Array.isArray(data.items) ? data.items : []);
        else if (Array.isArray(data.items) && data.items.length) setItems(data.items);
        setCuration(data?.curation ?? null);
        if (data?.error) setError(String(data.error));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed");
      } finally {
        setLoading(false);
        setCurating(false);
      }
    },
    [query, type, recency]
  );

  // On open: sync the panel's query/type/recency and run an initial search once.
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setType(initialType);
    setRecency(initialRecency);
    if (initialQuery.trim()) {
      // run against the freshest values, not the ones just queued in state
      const params = new URLSearchParams({ query: initialQuery.trim(), type: initialType, per_page: "40" });
      if (initialType === "news") params.set("recency", initialRecency);
      setLoading(true);
      setError(null);
      setCuration(null);
      fetch(withEditorBase(`/api/websearch?${params.toString()}`))
        .then((r) => r.json().catch(() => ({})))
        .then((data) => {
          setItems(Array.isArray(data.items) ? data.items : []);
          if (data?.error) setError(String(data.error));
        })
        .catch((e) => setError(e instanceof Error ? e.message : "Search failed"))
        .finally(() => setLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const sceneMap = useMemo(() => {
    const m = new Map<string, { caption: string; order: number }>();
    (curation?.scenes || []).forEach((s, i) => {
      if (s.item_id) m.set(s.item_id, { caption: s.caption || "", order: i });
    });
    return m;
  }, [curation]);

  const viewItems = useMemo(() => {
    if (!curation || !Array.isArray(curation.keep) || !curation.keep.length) return items;
    const keep = new Set(curation.keep);
    const kept = items.filter((it) => keep.has(it.id));
    kept.sort((a, b) => (sceneMap.get(a.id)?.order ?? 999) - (sceneMap.get(b.id)?.order ?? 999));
    return kept;
  }, [items, curation, sceneMap]);

  // Lay every curated scene onto the timeline, in order (each image 5s, kenBurns).
  // Falls back to the visible curated list if the LLM returned keep without scenes.
  const buildStoryboard = () => {
    const byId = new Map(items.map((it) => [it.id, it] as const));
    const picks = (curation?.scenes || [])
      .map((s) => (s.item_id ? byId.get(s.item_id) : undefined))
      .filter((x): x is WebItem => Boolean(x));
    const list = picks.length ? picks : viewItems;
    if (!list.length) return;
    const DUR = 5000;
    const trackItems = list.map((item, i) => {
      const w = Number(item.details.width) || 1920;
      const h = Number(item.details.height) || 1080;
      return {
        id: generateId(),
        type: item.type,
        display: { from: i * DUR, to: (i + 1) * DUR },
        details:
          item.type === "image"
            ? { src: item.details.src, width: w, height: h, kenBurns: "zoomIn" }
            : { src: item.details.src, width: w, height: h },
        metadata: { source_name: item.source_name, source_url: item.source_url, title: item.title },
      };
    });
    dispatch(ADD_ITEMS, { payload: { trackItems } });
    onClose(); // close so the freshly-built storyboard is visible on the timeline
  };

  if (!open || !mounted) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") runSearch(false);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="relative flex h-[calc(100%-2rem)] w-[calc(100%-2rem)] flex-col overflow-hidden rounded-xl border border-white/10 bg-background shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex flex-none flex-wrap items-center gap-1.5 border-b border-white/10 px-3 py-2">
          <span className="mr-1 text-sm font-semibold">Web Research</span>
          {TYPES.map((t) => (
            <button
              key={t.id}
              onClick={() => setType(t.id)}
              className={cn(
                "rounded-md px-2 py-0.5 text-xs font-medium transition-colors",
                type === t.id ? "bg-white/10 text-white" : "text-muted-foreground hover:bg-white/5"
              )}
            >
              {t.label}
            </button>
          ))}
          {type === "news" && (
            <div className="flex items-center gap-1">
              {RECENCY.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setRecency(r.id)}
                  className={cn(
                    "rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-colors",
                    recency === r.id ? "bg-white/10 text-white" : "text-muted-foreground hover:bg-white/5"
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
          <div className="relative ml-1 min-w-[180px] flex-1 md:max-w-md">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              className="h-7 pl-7 text-xs"
            />
          </div>
          <Button size="sm" className="h-7 px-2 text-xs" onClick={() => runSearch(false)} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Search"}
          </Button>
          <Button
            size="sm"
            variant={curation ? "default" : "outline"}
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => runSearch(true)}
            disabled={curating || !items.length}
            title="Curate: LLM drops the noise & orders the best results (config-driven)"
          >
            {curating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Curate
          </Button>
          {curation && (
            <button
              onClick={() => setCuration(null)}
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-white/5 hover:text-white"
            >
              ✕ curation
            </button>
          )}
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-white/5 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Curation result — readable note + one-click storyboard build */}
        {curation ? (
          <div className="flex flex-none items-center gap-2 border-b border-white/10 bg-teal-500/10 px-3 py-1.5">
            <span className="text-[11px] font-medium text-teal-700 dark:text-teal-200">
              ✨ {curation.note || "Curated."}
            </span>
            {curation.scenes?.length ? (
              <button
                onClick={buildStoryboard}
                title="Add every curated scene onto the timeline, in order"
                className="ml-auto flex flex-none items-center gap-1 rounded bg-teal-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-teal-700"
              >
                <Plus className="h-3 w-3" /> Build timeline ({curation.scenes.length})
              </button>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <div className="flex-none border-b border-white/10 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-400">
            {error}
          </div>
        ) : null}

        {/* Body — 2 columns */}
        <div className="grid min-h-0 flex-1 grid-cols-[320px_1fr]">
          {/* Left: results */}
          <div className="flex min-h-0 flex-col border-r border-white/10">
            <div className="flex-1 overflow-y-auto overscroll-contain p-2">
              <div className="grid grid-cols-2 gap-2">
                {viewItems.map((item) => (
                  <ResultCard
                    key={item.id}
                    item={item}
                    caption={sceneMap.get(item.id)?.caption}
                    active={selected?.id === item.id}
                    onSelect={() => {
                      setSelected(item);
                      setFrameLoading(true);
                    }}
                    onAdd={() => addWebItemToTimeline(item)}
                  />
                ))}
              </div>
              {loading && (
                <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Searching…
                </div>
              )}
              {!loading && viewItems.length === 0 && (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  {query.trim() ? "No results." : "Search to see material."}
                </div>
              )}
            </div>
          </div>

          {/* Right: the real page */}
          <div className="flex min-h-0 flex-col bg-black/20">
            {selected ? (
              <>
                <div className="flex flex-none items-center gap-2 border-b border-white/10 px-3 py-1.5">
                  <span className="truncate text-xs font-medium">{selected.title || selected.source_name}</span>
                  <span className="truncate text-[10px] text-muted-foreground">{selected.source_url}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs"
                      onClick={() => addWebItemToTimeline(selected)}
                      title="Add this result's image to the timeline"
                    >
                      <Plus className="h-3.5 w-3.5" /> Timeline
                    </Button>
                    <a
                      href={selected.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex h-7 items-center gap-1 rounded-md border border-white/15 px-2 text-xs text-muted-foreground hover:text-white"
                      title="Open in a new browser tab"
                    >
                      <ExternalLink className="h-3.5 w-3.5" /> Open
                    </a>
                  </div>
                </div>
                <div className="relative flex-1">
                  {frameLoading && (
                    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                      <Loader2 className="h-6 w-6 animate-spin text-white/70" />
                    </div>
                  )}
                  <iframe
                    key={selected.source_url}
                    src={selected.source_url}
                    title={selected.title || "page"}
                    className="h-full w-full bg-white"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-presentation allow-downloads"
                    referrerPolicy="no-referrer-when-downgrade"
                    onLoad={() => setFrameLoading(false)}
                  />
                  <div className="pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-black/60 px-2 py-0.5 text-[10px] text-white/70">
                    Blank? This site blocks embedding — use ↗ Open.
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                Left me kisi result pe click karo — uska poora page yahan khulega.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

const ResultCard = ({
  item,
  caption,
  active,
  onSelect,
  onAdd,
}: {
  item: WebItem;
  caption?: string;
  active: boolean;
  onSelect: () => void;
  onAdd: () => void;
}) => {
  const label = (caption || item.title || item.source_name || "").trim();
  return (
    <div
      onClick={onSelect}
      title={`${item.title || ""}\n${item.source_name}${item.snippet ? `\n\n${item.snippet}` : ""}`}
      className={cn(
        "group relative cursor-pointer overflow-hidden rounded-md border bg-background transition-colors",
        active ? "border-teal-400 ring-1 ring-teal-400" : "border-white/10 hover:border-white/25"
      )}
    >
      <div className="aspect-video w-full bg-black/30">
        <img src={item.preview} draggable={false} alt="" className="h-full w-full object-cover" />
      </div>
      <span className="absolute left-0 top-0 max-w-[85%] truncate rounded-br bg-black/70 px-1 py-0.5 text-[9px] font-medium text-white/90">
        {item.source_name}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onAdd();
        }}
        title="Add to timeline"
        className="absolute right-1 top-1 rounded bg-black/70 p-1 text-white/80 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
      >
        <Plus className="h-3 w-3" />
      </button>
      <div className="h-9 overflow-hidden px-1.5 py-1 text-[11px] leading-tight text-foreground/90">{label}</div>
    </div>
  );
};
