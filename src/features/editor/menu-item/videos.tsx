import Draggable from "@/components/shared/draggable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { dispatch } from "@designcombo/events";
import { ADD_VIDEO } from "@designcombo/state";
import { generateId } from "@designcombo/timeline";
import { IVideo } from "@designcombo/types";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useIsDraggingOverTimeline } from "../hooks/is-dragging-over-timeline";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Loader2, Play, PlusIcon } from "lucide-react";
import { usePexelsVideos } from "@/hooks/use-pexels-videos";
import type { PexelsVideoFilters } from "@/hooks/use-pexels-videos";
import { ImageLoading } from "@/components/ui/image-loading";

const QUICK_TOPICS = [
  "nature",
  "business",
  "health",
  "sports",
  "travel",
  "technology",
  "food",
  "cats"
];
const CATEGORY_OPTIONS = [
  "nature",
  "cats",
  "business",
  "city",
  "food",
  "health",
  "sports",
  "travel",
  "fitness",
  "technology",
  "education",
  "medical",
  "finance",
  "fashion",
  "animals",
  "all"
];
const ASPECT_RATIO_OPTIONS: Array<{ label: string; value: NonNullable<PexelsVideoFilters["aspectRatio"]> | "all" }> = [
  { label: "16:9", value: "16:9" },
  { label: "9:16", value: "9:16" },
  { label: "1:1", value: "1:1" },
  { label: "All items", value: "all" },
];
const SIZE_OPTIONS: Array<{ label: string; value: NonNullable<PexelsVideoFilters["size"]> | "all" }> = [
  { label: "HD", value: "small" },
  { label: "FHD", value: "medium" },
  { label: "4K", value: "large" },
  { label: "All items", value: "all" },
];

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const getAspectRatioLabel = (width?: number, height?: number) => {
  const w = Number(width || 0);
  const h = Number(height || 0);
  if (!w || !h) return "";
  const divisor = gcd(w, h) || 1;
  return `${Math.round(w / divisor)}:${Math.round(h / divisor)}`;
};

export const Videos = () => {
  const isDraggingOverTimeline = useIsDraggingOverTimeline();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [aspectRatio, setAspectRatio] = useState<NonNullable<PexelsVideoFilters["aspectRatio"]> | "all">("16:9");
  const [size, setSize] = useState<NonNullable<PexelsVideoFilters["size"]> | "all">("medium");

  const {
    videos: pexelsVideos,
    loading: pexelsLoading,
    error: pexelsError,
    currentPage,
    hasNextPage,
    searchVideos,
    loadPopularVideos,
    searchVideosAppend,
    loadPopularVideosAppend,
    clearVideos
  } = usePexelsVideos();

  const filters = useMemo<PexelsVideoFilters>(
    () => ({
      aspectRatio: aspectRatio === "all" ? undefined : aspectRatio,
      size: size === "all" ? undefined : size
    }),
    [aspectRatio, size]
  );

  useEffect(() => {
    if (activeQuery.trim()) {
      void searchVideos(activeQuery, 1, filters);
      return;
    }
    void loadPopularVideos(1, filters);
  }, [activeQuery, filters, loadPopularVideos, searchVideos]);

  const handleAddVideo = (payload: Partial<IVideo>) => {
    dispatch(ADD_VIDEO, {
      payload,
      options: {
        resourceId: "main",
        scaleMode: "fit"
      }
    });
  };

  const handleSearch = async () => {
    const nextQuery = searchQuery.trim();
    setSelectedCategory("all");
    setActiveQuery(nextQuery);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  const handleLoadMore = () => {
    if (hasNextPage) {
      if (activeQuery.trim()) {
        searchVideosAppend(activeQuery, currentPage + 1, filters);
      } else {
        loadPopularVideosAppend(currentPage + 1, filters);
      }
    }
  };

  const handleClearSearch = () => {
    setSearchQuery("");
    setActiveQuery("");
    setSelectedCategory("all");
    clearVideos();
  };
  const handleTopicClick = (topic: string) => {
    if (topic === "all") {
      handleClearSearch();
      return;
    }
    setSearchQuery(topic);
    setActiveQuery(topic);
    setSelectedCategory(topic);
  };

  const handleCategoryChange = (topic: string) => {
    setSelectedCategory(topic);
    if (topic === "all") {
      setSearchQuery("");
      setActiveQuery("");
      return;
    }
    setSearchQuery(topic);
    setActiveQuery(topic);
  };

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center gap-2 p-4">
        <div className="relative flex-1">
          <Button
            size="sm"
            variant="ghost"
            className="absolute left-1 top-1/2 h-6 w-6 -translate-y-1/2 p-0"
            onClick={handleSearch}
            disabled={pexelsLoading}
          >
            {pexelsLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Search className="h-3 w-3" />
            )}
          </Button>
          <Input
            placeholder="Search Pexels videos..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyPress={handleKeyPress}
            className="pl-10"
          />
        </div>
        <select
          value={aspectRatio}
          onChange={(e) => setAspectRatio(e.target.value as NonNullable<PexelsVideoFilters["aspectRatio"]> | "all")}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          title="Aspect ratio"
        >
          {ASPECT_RATIO_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          value={size}
          onChange={(e) => setSize(e.target.value as NonNullable<PexelsVideoFilters["size"]> | "all")}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          title="Quality"
        >
          {SIZE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          value={selectedCategory}
          onChange={(e) => handleCategoryChange(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          title="Category"
        >
          {CATEGORY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option === "all" ? "All items" : option.charAt(0).toUpperCase() + option.slice(1)}
            </option>
          ))}
        </select>
        {searchQuery && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleClearSearch}
            disabled={pexelsLoading}
          >
            Clear
          </Button>
        )}
      </div>

      <div className="px-4 pb-2 flex flex-wrap gap-2">
        {QUICK_TOPICS.map((topic) => (
          <Button
            key={topic}
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs capitalize"
            onClick={() => handleTopicClick(topic)}
            disabled={pexelsLoading}
          >
            {topic}
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          onClick={() => handleTopicClick("all")}
          disabled={pexelsLoading}
        >
          All items
        </Button>
      </div>

      {pexelsError && (
        <div className="px-4 pb-2">
          <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950/20 p-2 rounded">
            {pexelsError}
          </div>
        </div>
      )}

      <ScrollArea className="flex-1 px-4 max-h-full">
        <div className="max-h-full">
          <div className="grid grid-cols-2 gap-2">
            {pexelsVideos.map((video, index) => {
              return (
                <VideoItem
                  key={video.id || index}
                  video={video}
                  shouldDisplayPreview={!isDraggingOverTimeline}
                  handleAddImage={handleAddVideo}
                />
              );
            })}
          </div>
          {pexelsLoading && <ImageLoading message="Searching for videos..." />}
          {/* Pagination */}
          {hasNextPage && (
            <div className="flex items-center justify-center p-4">
              <Button
                size="sm"
                variant="outline"
                onClick={handleLoadMore}
                disabled={pexelsLoading}
              >
                {pexelsLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  "Load More"
                )}
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

const VideoItem = ({
  handleAddImage,
  video,
  shouldDisplayPreview
}: {
  handleAddImage: (payload: Partial<IVideo>) => void;
  video: Partial<IVideo>;
  shouldDisplayPreview: boolean;
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const durationSeconds = Math.round(((video.details as any)?.duration || 0));
  const aspectRatioLabel = getAspectRatioLabel((video.details as any)?.width, (video.details as any)?.height);
  const style = React.useMemo(
    () => ({
      backgroundImage: `url(${video.preview})`,
      backgroundSize: "cover",
      width: "80px",
      height: "80px"
    }),
    [video.preview]
  );

  const stopPreview = () => {
    const el = videoRef.current;
    if (!el) return;
    el.pause();
    el.currentTime = 0;
    setIsPreviewPlaying(false);
  };

  const startPreview = async () => {
    const el = videoRef.current;
    if (!el) return;
    try {
      el.currentTime = 0;
      await el.play();
      setIsPreviewPlaying(true);
    } catch {
      setIsPreviewPlaying(false);
    }
  };

  return (
    <Draggable
      data={{
        ...video,
        metadata: {
          previewUrl: video.preview
        }
      }}
      renderCustomPreview={<div style={style} className="draggable" />}
      shouldDisplayPreview={shouldDisplayPreview}
    >
      <div
        onClick={() =>
          handleAddImage({
            id: generateId(),
            details: {
              src: video.details?.src
            },
            metadata: {
              previewUrl: video.preview
            }
          } as any)
        }
        onMouseEnter={() => { void startPreview(); }}
        onMouseLeave={stopPreview}
        className="relative aspect-video flex w-full items-center justify-center overflow-hidden bg-background pb-2 group cursor-pointer"
      >
        <img
          draggable={false}
          src={video.preview}
          className={`h-full w-full rounded-md object-cover transition-opacity ${isPreviewPlaying ? "opacity-0" : "opacity-100"}`}
          alt="Video preview"
        />
        <video
          ref={videoRef}
          src={video.details?.src}
          muted
          loop
          playsInline
          preload="metadata"
          className={`absolute inset-0 h-full w-full rounded-md object-cover transition-opacity ${isPreviewPlaying ? "opacity-100" : "opacity-0"}`}
        />
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity rounded-md">
          <div className="rounded-full p-1">
            {isPreviewPlaying ? <Play className="h-6 w-6 fill-current opacity-70" /> : <PlusIcon className="h-6 w-6 fill-current" />}
          </div>
        </div>
        {aspectRatioLabel && (
          <div className="absolute bottom-3 left-2 bg-black/90 text-white/85 text-[10px] px-1.5 py-0.5 rounded">
            {aspectRatioLabel}
          </div>
        )}
        {durationSeconds > 0 && (
          <div className="absolute bottom-3 right-2 bg-black/90 text-primary/90 text-xs px-1 py-0.5 rounded">
            {durationSeconds}s
          </div>
        )}
      </div>
    </Draggable>
  );
};
