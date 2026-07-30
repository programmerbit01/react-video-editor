import { dispatch } from "@designcombo/events";
import { generateId } from "@designcombo/timeline";
import Draggable from "@/components/shared/draggable";
import React, { useState, useEffect, useSyncExternalStore } from "react";
import { useIsDraggingOverTimeline } from "../hooks/is-dragging-over-timeline";
import { ADD_ITEMS, ADD_AUDIO } from "@designcombo/state";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Loader2, Music2, Zap, Check, Play, Pause } from "lucide-react";
import { cn } from "@/lib/utils";
import useAudioLibraryStore, { SavedSound } from "../store/use-audio-library-store";

type MediaType = "video" | "image" | "sound";

interface MediaItem {
  id: string;
  type: "image" | "video" | "audio"; // editor-canonical (sound results come back as audio)
  details: { src: string; width: number; height: number; duration?: number };
  preview: string;
  source_name: string;
  source_url: string;
  license: string;
  author: string;
  title?: string;
}

// Sources + which formats each one supports. `short` = compact GUI label.
const SOURCES: { id: string; label: string; short: string; formats: MediaType[] }[] = [
  { id: "pexels", label: "Pexels", short: "Pexels", formats: ["video", "image"] },
  { id: "openverse", label: "Openverse", short: "OV", formats: ["image", "sound"] },
  { id: "wikimedia", label: "Wikimedia", short: "WM", formats: ["image", "video", "sound"] },
  { id: "archive", label: "Internet Archive", short: "IA", formats: ["image", "video", "sound"] },
];

// Short label for the badge shown on each result, keyed by backend source_name.
const SHORT_SOURCE: Record<string, string> = {
  Pexels: "Pexels",
  Openverse: "OV",
  Wikimedia: "WM",
  "Internet Archive": "IA",
};
const shortSource = (name: string) => SHORT_SOURCE[name] || name;

// Snap a raw WxH to the aspect ratio a creator actually thinks in (9:16, 16:9, 1:1, …),
// so a 1080x1920 clip reads "9:16" not "1080:1920". Falls back to a gcd-reduced ratio when
// nothing common is close, and to "" when dimensions are unknown.
const COMMON_RATIOS: [string, number][] = [
  ["9:16", 9 / 16], ["16:9", 16 / 9], ["1:1", 1], ["4:5", 4 / 5], ["5:4", 5 / 4],
  ["3:4", 3 / 4], ["4:3", 4 / 3], ["2:3", 2 / 3], ["3:2", 3 / 2], ["21:9", 21 / 9], ["9:21", 9 / 21],
];
const aspectLabel = (w?: number, h?: number): string => {
  if (!w || !h || w <= 0 || h <= 0) return "";
  const r = w / h;
  // Always snap to the nearest creator-friendly ratio. Real stock dimensions are often a
  // little off a clean ratio (a 2160x4096 clip is ~9:16 but not exactly), and for a browse
  // hint the useful thing is the bucket (portrait/landscape/square), not "135:256". The
  // COMMON_RATIOS gaps are wide enough that nearest-match never confuses e.g. 9:16 with 2:3.
  let best = COMMON_RATIOS[0], bestErr = Infinity;
  for (const c of COMMON_RATIOS) {
    const err = Math.abs(r - c[1]) / c[1];
    if (err < bestErr) { bestErr = err; best = c; }
  }
  return best[0];
};

// seconds → "M:SS" (badge on video tiles)
const durationLabel = (secs?: number): string => {
  const s = Math.round(Number(secs) || 0);
  if (s <= 0) return "";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const FORMATS: { id: MediaType; label: string }[] = [
  { id: "video", label: "Video" },
  { id: "image", label: "Images" },
  { id: "sound", label: "Sound" },
];

const withEditorBase = (path: string) => {
  if (typeof window === "undefined") return path;
  if (window.location.pathname.startsWith("/editor")) return `/editor${path}`;
  return path;
};

export const Archival = () => {
  const isDraggingOverTimeline = useIsDraggingOverTimeline();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<MediaType>("video");
  const [selected, setSelected] = useState<Record<string, boolean>>({
    pexels: true,
    openverse: false,
    wikimedia: false,
    archive: false,
  });
  const [items, setItems] = useState<MediaItem[]>([]);
  const [bySource, setBySource] = useState<Record<string, { count: number; ok: boolean; error?: string }>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  // Don't let a sound preview keep playing after the user leaves the Stock tab.
  useEffect(() => stopPreview, []);

  const supports = (id: string) => SOURCES.find((s) => s.id === id)?.formats.includes(type);
  const toggleSource = (id: string) => setSelected((p) => ({ ...p, [id]: !p[id] }));

  const handleSearch = async () => {
    const q = query.trim();
    const sources = SOURCES.filter((s) => selected[s.id] && supports(s.id)).map((s) => s.id);
    if (!q || sources.length === 0) return;
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const params = new URLSearchParams({ query: q, type, sources: sources.join(","), per_page: "20" });
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
    const metadata = {
      source_name: item.source_name,
      source_url: item.source_url,
      license: item.license,
      author: item.author,
    };
    // Audio uses the dedicated ADD_AUDIO action (ADD_ITEMS won't place it on an audio track).
    if (item.type === "audio") {
      dispatch(ADD_AUDIO, {
        payload: {
          id: generateId(),
          type: "audio",
          name: item.title || "audio",
          details: { src: item.details.src },
          metadata,
        },
        options: {},
      });
      return;
    }
    const durMs = (item.details.duration || 5) * 1000;
    // Pass real dims (default to 1080p when the source didn't provide them — e.g. an IA item
    // whose metadata lacked width/height) so the clip is NEVER 0×0. A 0-size clip rendered
    // invisible until its (slow) media loaded, which is exactly why an IA click looked like it
    // "missed" and users clicked again.
    const w = Number(item.details.width) || 1920;
    const h = Number(item.details.height) || 1080;
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
      {/* Row 1 — sources */}
      <div className="flex-none flex flex-wrap gap-x-3 gap-y-1 px-3 pt-2">
        {SOURCES.map((s) => {
          const disabled = !s.formats.includes(type);
          return (
            <label
              key={s.id}
              className={cn(
                "flex items-center gap-1.5 text-xs cursor-pointer select-none",
                disabled ? "opacity-30 cursor-not-allowed" : "text-foreground"
              )}
              title={disabled ? `No ${type} from ${s.label}` : s.label}
            >
              <input
                type="checkbox"
                checked={!!selected[s.id] && !disabled}
                disabled={disabled}
                onChange={() => toggleSource(s.id)}
                className="accent-white h-3 w-3"
              />
              {s.short}
              {searched && bySource[s.id] && (
                <span
                  className={cn("text-[10px]", bySource[s.id].ok ? "text-muted-foreground" : "text-red-400")}
                  title={bySource[s.id].ok ? "" : bySource[s.id].error || "failed"}
                >
                  ({bySource[s.id].ok ? bySource[s.id].count : "x"})
                </span>
              )}
            </label>
          );
        })}
      </div>

      {/* Per-source errors (e.g. a blocked/timed-out platform) */}
      {searched &&
        Object.entries(bySource)
          .filter(([, v]) => !v.ok)
          .map(([id, v]) => {
            const label = SOURCES.find((s) => s.id === id)?.short || id;
            return (
              <div key={id} className="flex-none px-3 text-[10px] text-red-400/80 truncate">
                {label}: {v.error || "request failed"}
              </div>
            );
          })}

      {/* Row 2 — format */}
      <div className="flex-none flex items-center gap-1 px-3 py-2">
        {FORMATS.map((f) => (
          <button
            key={f.id}
            onClick={() => setType(f.id)}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
              type === f.id ? "bg-white/10 text-white" : "text-muted-foreground hover:bg-white/5"
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Search */}
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
        Stock + archival · source &amp; license shown on each result
      </div>

      {error && (
        <div className="flex-none px-4 pb-2">
          <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950/20 p-2 rounded">{error}</div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto overscroll-contain min-h-0 px-4">
        {type === "sound" ? (
          <div className="flex flex-col gap-1">
            {items.map((item, i) => (
              <SoundRow key={item.id || i} item={item} handleAdd={handleAdd} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2">
            {items.map((item, i) => (
              <MediaTile
                key={item.id || i}
                item={item}
                shouldDisplayPreview={!isDraggingOverTimeline}
                handleAdd={handleAdd}
              />
            ))}
          </div>
        )}
        {loading && (
          <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Searching...
          </div>
        )}
        {!loading && searched && items.length === 0 && !error && (
          <div className="py-6 text-center text-xs text-muted-foreground">
            No results — try other sources or a broader term.
          </div>
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
    // width/height so a DRAGGED-in clip lands at its real size (default 1080p) — never 0×0.
    details: { src: item.details.src, width: Number(item.details.width) || 1920, height: Number(item.details.height) || 1080, ...(item.type === "image" ? { kenBurns: "zoomIn" } : {}) },
    preview: item.preview,
    metadata: {
      source_name: item.source_name,
      source_url: item.source_url,
      license: item.license,
      author: item.author,
    },
  };
  const isVideo = item.type === "video";
  const [hovering, setHovering] = useState(false);
  const [adding, setAdding] = useState(false);
  const onAddClick = () => {
    setAdding(true);
    handleAdd(item);
    // handleAdd dispatches instantly; the clip's media then loads in the player/timeline (an
    // Internet-Archive url can be slow to fetch). A brief spinner confirms the click landed —
    // the same feedback the vApp media tiles give.
    window.setTimeout(() => setAdding(false), 1100);
  };
  const ar = aspectLabel(item.details?.width, item.details?.height);
  const dur = isVideo ? durationLabel(item.details?.duration) : "";
  // Bottom label is now the media TITLE, not the license. License + author stay in the
  // hover tooltip so nothing legal is lost, but the visible label is the useful name.
  const bottomLabel = (item.title || "").trim() || item.author || shortSource(item.source_name);
  return (
    <Draggable data={draggableData} renderCustomPreview={<div style={style} />} shouldDisplayPreview={shouldDisplayPreview}>
      <div
        onClick={onAddClick}
        onMouseEnter={() => isVideo && setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        title={`${item.title || "Untitled"}\n${item.source_name} · ${item.author} · ${item.license}${ar ? ` · ${ar}` : ""}${dur ? ` · ${dur}` : ""}`}
        className="group relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-md bg-background cursor-pointer"
      >
        <img draggable={false} src={item.preview} className="h-full w-full rounded-md object-cover" alt={item.title || "media"} />
        {/* Hover preview: only videos, only while hovered — loads nothing until then. No
            crossOrigin (never canvas-read), muted+loop autoplay for a light in-place preview. */}
        {isVideo && hovering ? (
          <video
            src={item.details.src}
            muted
            loop
            autoPlay
            playsInline
            preload="metadata"
            className="absolute inset-0 h-full w-full rounded-md object-cover"
          />
        ) : null}
        {/* top-left: source badge */}
        <span className="absolute top-0 left-0 z-10 rounded-br bg-black/70 px-1 py-0.5 text-[9px] font-medium text-white/90">
          {shortSource(item.source_name)}
        </span>
        {/* top-right: aspect ratio */}
        {ar ? (
          <span className="absolute top-0 right-0 z-10 rounded-bl bg-black/70 px-1 py-0.5 text-[9px] font-medium text-white/90">
            {ar}
          </span>
        ) : null}
        {/* bottom-right: video duration */}
        {dur ? (
          <span className="absolute bottom-0 right-0 z-10 rounded-tl bg-black/70 px-1 py-0.5 text-[9px] font-medium tabular-nums text-white/90">
            {dur}
          </span>
        ) : null}
        {/* bottom: title */}
        <span className="absolute bottom-0 left-0 right-0 z-10 truncate bg-black/60 px-1 py-0.5 pr-7 text-[9px] text-white/85">
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

// One shared preview player for the whole sound list: playing a new sound stops whatever was
// playing, and every row can tell whether IT is the one playing (via useSyncExternalStore).
// Preview only — no crossOrigin (never canvas-read), so cross-origin audio plays fine.
let _preview: HTMLAudioElement | null = null;
let _previewSrc: string | null = null;
const _previewSubs = new Set<() => void>();
const _previewEmit = () => _previewSubs.forEach((f) => f());
const _previewEnsure = (): HTMLAudioElement => {
  if (!_preview) {
    _preview = new Audio();
    _preview.preload = "none";
    const clear = () => { _previewSrc = null; _previewEmit(); };
    _preview.addEventListener("ended", clear);
    _preview.addEventListener("error", clear);
  }
  return _preview;
};
const togglePreview = (src: string) => {
  const a = _previewEnsure();
  if (_previewSrc === src && !a.paused) {
    a.pause();
    _previewSrc = null;
    _previewEmit();
    return;
  }
  if (a.src !== src) a.src = src;
  try { a.currentTime = 0; } catch {}
  _previewSrc = src;
  _previewEmit();
  a.play().catch(() => { _previewSrc = null; _previewEmit(); });
};
export const stopPreview = () => {
  if (_preview && !_preview.paused) _preview.pause();
  if (_previewSrc !== null) { _previewSrc = null; _previewEmit(); }
};
const subscribePreview = (cb: () => void) => { _previewSubs.add(cb); return () => { _previewSubs.delete(cb); }; };
const getPreviewSrc = () => _previewSrc;

const SoundRow = ({ item, handleAdd }: { item: MediaItem; handleAdd: (i: MediaItem) => void }) => {
  const dur = item.details.duration || 0;
  const [adding, setAdding] = useState(false);
  const { addSfx, addMusic, hasSfx, hasMusic } = useAudioLibraryStore();
  const inSfx = hasSfx(item.details.src);
  const inMusic = hasMusic(item.details.src);
  const playingSrc = useSyncExternalStore(subscribePreview, getPreviewSrc, () => null);
  const isPlaying = playingSrc === item.details.src;
  const onAddClick = () => {
    setAdding(true);
    handleAdd(item);
    window.setTimeout(() => setAdding(false), 1100);
  };
  const asSaved = (): SavedSound => ({
    id: item.id || item.details.src,
    name: item.title || "Untitled",
    src: item.details.src,
    durationMs: dur ? Math.round(dur * 1000) : undefined,
    author: item.author,
    license: item.license,
    source: item.source_name,
  });
  return (
    <div
      onClick={onAddClick}
      title={`${item.source_name} · ${item.author} · ${item.license}`}
      className="flex items-center gap-2 rounded-md bg-background hover:bg-white/5 px-2 py-1.5 cursor-pointer"
    >
      {/* Preview: hear the sound before adding. stopPropagation so it doesn't drop on the timeline. */}
      <button
        type="button"
        title={isPlaying ? "Pause preview" : "Play preview"}
        aria-label={isPlaying ? "Pause preview" : "Play preview"}
        onClick={(e) => { e.stopPropagation(); togglePreview(item.details.src); }}
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors ${
          isPlaying
            ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-300"
            : "border-white/15 text-white/80 hover:bg-white/10"
        }`}
      >
        {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 translate-x-[1px]" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-white/90">{item.title || "Untitled"}</div>
        <div className="truncate text-[10px] text-muted-foreground">
          {shortSource(item.source_name)} · {item.license}
          {dur ? ` · ${dur}s` : ""}
        </div>
      </div>
      {adding && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-white/80" />}
      {/* Save into the user's own library (not the timeline) — click the row to drop it on the
          timeline, these buttons collect it into Music bed / SFX for reuse. */}
      <button
        type="button"
        title={inMusic ? "In Music bed" : "Add to Music bed"}
        aria-label="Add to Music bed"
        onClick={(e) => { e.stopPropagation(); addMusic(asSaved()); }}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-white/10 ${inMusic ? "text-emerald-400" : "text-muted-foreground"}`}
      >
        {inMusic ? <Check className="h-3.5 w-3.5" /> : <Music2 className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        title={inSfx ? "In SFX" : "Add to SFX"}
        aria-label="Add to SFX"
        onClick={(e) => { e.stopPropagation(); addSfx(asSaved()); }}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-white/10 ${inSfx ? "text-emerald-400" : "text-muted-foreground"}`}
      >
        {inSfx ? <Check className="h-3.5 w-3.5" /> : <Zap className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
};
