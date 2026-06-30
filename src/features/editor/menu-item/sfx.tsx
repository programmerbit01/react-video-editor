"use client";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Search, Loader2, Music2, ChevronDown, Play, Pause, Plus } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { debounce } from "lodash";
import { Button } from "@/components/ui/button";
import { IAudio } from "@designcombo/types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import useStore from "../store/use-store";
import { getStateManagerRef } from "../utils/state-manager-ref";
import { SFX_LIBRARY } from "../data/sfx";
import { getCurrentTime } from "../utils/time";
import {
  addManualSfx,
  CUT_SFX_ROLE,
  CUT_SFX_VOLUME_DEFAULT,
  getCutBoundaryCount,
  getManagedAudioItems,
  upsertCutSfx
} from "../utils/scene-audio";

export function SFX() {
  const { trackItemsMap, tracks, trackItemIds, duration } = useStore();
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<IAudio[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isMoreLoading, setIsMoreLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const activeCutSfx = getManagedAudioItems(trackItemsMap, CUT_SFX_ROLE) as any[];
  const activeAutoSrc = activeCutSfx[0]?.details?.src;
  const [selectedAutoSoundSrc, setSelectedAutoSoundSrc] = useState<string>(
    activeAutoSrc || SFX_LIBRARY[0]?.details?.src || ""
  );
  const [selectedManualSoundSrc, setSelectedManualSoundSrc] = useState<string>("");
  const [autoPickerOpen, setAutoPickerOpen] = useState(false);
  const [manualPickerOpen, setManualPickerOpen] = useState(false);
  const cutCount = getCutBoundaryCount(trackItemsMap);
  const [cutSfxVolume, setCutSfxVolume] = useState<number>(
    Number(activeCutSfx[0]?.details?.volume ?? CUT_SFX_VOLUME_DEFAULT)
  );

  useEffect(() => {
    setCutSfxVolume(Number(activeCutSfx[0]?.details?.volume ?? CUT_SFX_VOLUME_DEFAULT));
  }, [activeCutSfx[0]?.details?.volume]);

  useEffect(() => {
    if (activeAutoSrc) {
      setSelectedAutoSoundSrc(activeAutoSrc.replace(/^\/editor/, ""));
    }
  }, [activeAutoSrc]);

  useEffect(() => {
    if (!selectedManualSoundSrc && searchResults[0]?.details?.src) {
      setSelectedManualSoundSrc(searchResults[0].details.src);
    }
  }, [searchResults, selectedManualSoundSrc]);

  const withEditorBase = (path: string) => {
    if (typeof window === "undefined") return path;
    if (window.location.pathname.startsWith("/editor")) return `/editor${path}`;
    return path;
  };

  const fetchSFX = async (query: string, pageNumber: number = 1) => {
    if (pageNumber === 1) {
      setIsLoading(true);
    } else {
      setIsMoreLoading(true);
    }

    try {
      const response = await fetch(withEditorBase("/api/audio/sfx"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          limit: 30,
          page: pageNumber,
          query: query ? { keys: [query] } : {}
        })
      });
      const data = await response.json();
      if (data.soundEffects) {
        const mappedSFX = data.soundEffects.map((sfx: any) => ({
          id: sfx.id,
          details: {
            src:
              typeof sfx.src === "string" && sfx.src.startsWith("/")
                ? withEditorBase(sfx.src)
                : sfx.src
          },
          name: sfx.name,
          type: sfx.type,
          metadata: {
            author: sfx.description || "",
            durationMs:
              SFX_LIBRARY.find((item) => item.id === sfx.id.replace(/^sfx_/, ""))?.metadata?.durationMs
          }
        }));
        if (pageNumber === 1) {
          setSearchResults(mappedSFX);
        } else {
          setSearchResults((prev: IAudio[]) => [...prev, ...mappedSFX]);
        }
        setHasMore(data.pagination?.hasMore || false);
      } else {
        if (pageNumber === 1) {
          setSearchResults([]);
        }
        setHasMore(false);
      }
    } catch (error) {
      console.error("Failed to fetch SFX:", error);
    } finally {
      setIsLoading(false);
      setIsMoreLoading(false);
    }
  };

  const debouncedFetch = useCallback(
    debounce((query: string) => {
      setPage(1);
      fetchSFX(query, 1);
    }, 500),
    []
  );
  useEffect(() => {
    fetchSFX("");
  }, []);

  const togglePreview = (src?: string) => {
    if (!src) return;
    const audio = previewAudioRef.current;
    if (!audio) return;
    if (previewSrc === src && !audio.paused) {
      audio.pause();
      audio.currentTime = 0;
      setPreviewSrc(null);
      return;
    }
    audio.src = src;
    audio.currentTime = 0;
    void audio.play();
    setPreviewSrc(src);
  };

  const handleAddAudio = (payload: Partial<IAudio>) => {
    const sm = getStateManagerRef();
    if (!sm || !payload.details?.src) return;
    const patch = addManualSfx(
      {
        duration,
        tracks,
        trackItemIds,
        trackItemsMap
      },
      {
        from: getCurrentTime(),
        src: payload.details.src,
        name: payload.name,
        durationMs: Number(payload.metadata?.durationMs || 700)
      }
    );
    sm.updateState(patch, { updateHistory: true, kind: "add" });
  };

  const selectedManualSound = useMemo(
    () => searchResults.find((item) => item.details?.src === selectedManualSoundSrc) || searchResults[0],
    [searchResults, selectedManualSoundSrc]
  );
  const selectedAutoSound = useMemo(
    () => SFX_LIBRARY.find((item) => item.details?.src === selectedAutoSoundSrc) || SFX_LIBRARY[0],
    [selectedAutoSoundSrc]
  );

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    setSearchQuery(query);
    debouncedFetch(query);
  };

  const applyCutSfx = (enabled: boolean, volume: number) => {
    const sm = getStateManagerRef();
    if (!sm) return;
    const patch = upsertCutSfx(
      {
        duration,
        tracks,
        trackItemIds,
        trackItemsMap
      },
      {
        enabled,
        src: selectedAutoSoundSrc
          ? withEditorBase(selectedAutoSoundSrc.replace(/^\/editor/, ""))
          : "",
        volume
      }
    );
    sm.updateState(patch, { updateHistory: true, kind: "add" });
  };

  const loadMore = () => {
    const nextPage = page + 1;
    setPage(nextPage);
    fetchSFX(searchQuery, nextPage);
  };

  const uniqueResults = Array.from(
    new Map(searchResults.map((item: IAudio) => [item.id, item])).values()
  );

  return (
    <div className="flex flex-1 min-h-0 max-w-full flex-col overflow-hidden">
      <audio
        ref={previewAudioRef}
        onEnded={() => setPreviewSrc(null)}
        className="hidden"
      />
      <ScrollArea className="flex-1 min-h-0 max-w-full">
        <div className="space-y-4 px-4 py-4">
          <div className="rounded-lg border border-border/70 bg-background/30 p-3">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Auto Cut Sound</p>
                <p className="mt-1 text-sm font-medium text-foreground">Add sound on every cut</p>
                <p className="text-xs text-muted-foreground">
                  {cutCount > 0
                    ? `Automatically places a short sound on each clip boundary (${cutCount} detected).`
                    : "Needs at least 2 visual clips before cut sounds can be added."}
                </p>
              </div>
              <Switch
                disabled={cutCount === 0}
                checked={activeCutSfx.length > 0}
                onCheckedChange={(checked) => applyCutSfx(checked, cutSfxVolume)}
                aria-label="Toggle automatic cut sound effects"
              />
            </div>

            <div className="flex items-center gap-2">
              <Popover open={autoPickerOpen} onOpenChange={setAutoPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="h-10 flex-1 justify-between px-3 text-left"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm">{selectedAutoSound?.name || "Select auto sound"}</div>
                      <div className="text-[11px] text-muted-foreground">Auto cut sound</div>
                    </div>
                    <ChevronDown className="ml-2 size-4 shrink-0 opacity-70" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="z-[260] w-[--radix-popover-trigger-width] p-2">
                  <div className="space-y-1">
                    {SFX_LIBRARY.map((sound) => {
                      const soundSrc = sound.details?.src || "";
                      const isSelected = soundSrc === selectedAutoSoundSrc;
                      return (
                        <button
                          key={sound.id}
                          type="button"
                          onClick={() => {
                            setSelectedAutoSoundSrc(soundSrc);
                            setAutoPickerOpen(false);
                            if (activeCutSfx.length > 0) {
                              const sm = getStateManagerRef();
                              if (!sm) return;
                              const patch = upsertCutSfx(
                                {
                                  duration,
                                  tracks,
                                  trackItemIds,
                                  trackItemsMap
                                },
                                {
                                  enabled: true,
                                  src: withEditorBase(soundSrc.replace(/^\/editor/, "")),
                                  volume: cutSfxVolume
                                }
                              );
                              sm.updateState(patch, { updateHistory: true, kind: "add" });
                            }
                          }}
                          className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent ${
                            isSelected ? "bg-accent font-medium" : ""
                          }`}
                        >
                          <span className="truncate">{sound.name}</span>
                          {isSelected && <span className="text-[10px] text-muted-foreground">●</span>}
                        </button>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
              <Button
                size="icon"
                variant="outline"
                className="h-10 w-10 shrink-0"
                onClick={() => togglePreview(withEditorBase((selectedAutoSound?.details?.src || "").replace(/^\/editor/, "")))}
                title="Preview auto sound"
              >
                {previewSrc === withEditorBase((selectedAutoSound?.details?.src || "").replace(/^\/editor/, "")) ? (
                  <Pause className="size-4" />
                ) : (
                  <Play className="size-4 ml-0.5" />
                )}
              </Button>
            </div>

            <div className="mt-3">
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <Label>Auto cut volume</Label>
                <span className="text-muted-foreground">{cutSfxVolume}%</span>
              </div>
              <Slider
                min={0}
                max={100}
                step={1}
                value={[cutSfxVolume]}
                onValueChange={(value) => {
                  const next = value[0] ?? CUT_SFX_VOLUME_DEFAULT;
                  setCutSfxVolume(next);
                  if (activeCutSfx.length > 0) applyCutSfx(true, next);
                }}
              />
            </div>
          </div>

          <div className="rounded-lg border border-border/70 bg-background/30 p-3">
            <div className="mb-3">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Manual Sound Effect</p>
              <p className="mt-1 text-sm font-medium text-foreground">Choose a sound and place it yourself</p>
              <p className="text-xs text-muted-foreground">
                Adds the selected sound at the current playhead position.
              </p>
            </div>

            <Popover open={manualPickerOpen} onOpenChange={setManualPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="h-10 w-full justify-between px-3 text-left"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm">{selectedManualSound?.name || "Select sound effect"}</div>
                    <div className="text-[11px] text-muted-foreground">Manual placement</div>
                  </div>
                  <ChevronDown className="ml-2 size-4 shrink-0 opacity-70" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="z-[260] w-[--radix-popover-trigger-width] p-2">
                <div className="mb-2">
                  <div className="relative">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="absolute left-1 top-1/2 h-6 w-6 -translate-y-1/2 p-0"
                      onClick={() => fetchSFX(searchQuery)}
                      disabled={isLoading}
                    >
                      {isLoading ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Search className="h-3 w-3" />
                      )}
                    </Button>
                    <Input
                      placeholder="Search sound effects..."
                      value={searchQuery}
                      onChange={handleSearchChange}
                      className="pl-10"
                    />
                  </div>
                </div>
                <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
                  {uniqueResults.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-6 text-muted-foreground gap-2">
                      <Music2 size={24} className="opacity-50" />
                      <span className="text-sm">No sound effects found</span>
                    </div>
                  ) : (
                    uniqueResults.map((audio) => {
                      const isSelected = audio.details?.src === selectedManualSound?.details?.src;
                      return (
                        <button
                          key={audio.id}
                          type="button"
                          onClick={() => {
                            setSelectedManualSoundSrc(audio.details?.src || "");
                            setManualPickerOpen(false);
                          }}
                          className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent ${
                            isSelected ? "bg-accent font-medium" : ""
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="truncate">{audio.name}</div>
                            <div className="text-[11px] text-muted-foreground">{audio.metadata?.author || "Sound effect"}</div>
                          </div>
                          {isSelected && <span className="text-[10px] text-muted-foreground">●</span>}
                        </button>
                      );
                    })
                  )}
                </div>
                {hasMore && uniqueResults.length > 0 && (
                  <div className="pt-2">
                    <Button
                      onClick={loadMore}
                      disabled={isMoreLoading}
                      variant="outline"
                      className="h-8 w-full"
                    >
                      {isMoreLoading && <Loader2 className="mr-1 size-3 animate-spin" />}
                      Load more
                    </Button>
                  </div>
                )}
              </PopoverContent>
            </Popover>

            <div className="mt-3 flex items-center gap-2">
              <Button
                size="icon"
                variant="outline"
                className="h-10 w-10 shrink-0"
                onClick={() => togglePreview(selectedManualSound?.details?.src)}
                title="Preview selected sound"
                disabled={!selectedManualSound?.details?.src}
              >
                {previewSrc === selectedManualSound?.details?.src ? (
                  <Pause className="size-4" />
                ) : (
                  <Play className="size-4 ml-0.5" />
                )}
              </Button>
              <Button
                className="h-10 flex-1 gap-2"
                onClick={() => selectedManualSound && handleAddAudio(selectedManualSound)}
                disabled={!selectedManualSound}
              >
                <Plus className="size-4" />
                Add at playhead
              </Button>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
