"use client";
import { useState, useEffect, useMemo, useRef } from "react";
import { Search, Music2, ChevronDown, Play, Pause, Plus, Trash2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import useStore from "../store/use-store";
import useAudioLibraryStore, { SavedSound } from "../store/use-audio-library-store";
import { getStateManagerRef } from "../utils/state-manager-ref";
import { getCurrentTime } from "../utils/time";
import {
  addManualSfx,
  CUT_SFX_ROLE,
  CUT_SFX_VOLUME_DEFAULT,
  getCutBoundaryCount,
  getManagedAudioItems,
  upsertCutSfx
} from "../utils/scene-audio";

// Sound effects now come from the user's OWN curated library (saved from Stock → Sound), not a
// bundled synthetic pack. Both the "auto sound on cut" picker and the "manual placement" picker
// list those saved SFX; each row has a delete. Empty library → a hint to add from Stock → Sound.
export function SFX() {
  const { trackItemsMap, tracks, trackItemIds, duration } = useStore();
  const { sfx: libSfx, removeSfx } = useAudioLibraryStore();
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const activeCutSfx = getManagedAudioItems(trackItemsMap, CUT_SFX_ROLE) as any[];
  const activeAutoSrc = activeCutSfx[0]?.details?.src;
  const [selectedAutoSoundSrc, setSelectedAutoSoundSrc] = useState<string>(
    activeAutoSrc || libSfx[0]?.src || ""
  );
  const [selectedManualSoundSrc, setSelectedManualSoundSrc] = useState<string>("");
  const [autoPickerOpen, setAutoPickerOpen] = useState(false);
  const [manualPickerOpen, setManualPickerOpen] = useState(false);
  const cutCount = getCutBoundaryCount(trackItemsMap);
  const [cutSfxVolume, setCutSfxVolume] = useState<number>(
    Number(activeCutSfx[0]?.details?.volume ?? CUT_SFX_VOLUME_DEFAULT)
  );

  // Saved SFX are absolute urls; only a legacy local path needs the /editor base prefix.
  const withEditorBase = (path: string) => {
    if (typeof window === "undefined") return path;
    if (window.location.pathname.startsWith("/editor")) return `/editor${path}`;
    return path;
  };
  const resolveSrc = (src?: string) => {
    const s = String(src || "");
    return /^https?:\/\//.test(s) ? s : withEditorBase(s.replace(/^\/editor/, ""));
  };

  useEffect(() => {
    setCutSfxVolume(Number(activeCutSfx[0]?.details?.volume ?? CUT_SFX_VOLUME_DEFAULT));
  }, [activeCutSfx[0]?.details?.volume]);

  useEffect(() => {
    if (activeAutoSrc) setSelectedAutoSoundSrc(activeAutoSrc);
  }, [activeAutoSrc]);

  // Default the auto picker to the first saved sound once the library has something.
  useEffect(() => {
    if (!selectedAutoSoundSrc && libSfx[0]?.src) setSelectedAutoSoundSrc(libSfx[0].src);
  }, [libSfx, selectedAutoSoundSrc]);

  // Local search over the saved library (no network — it's the user's own list).
  const filteredSfx = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return q ? libSfx.filter((s) => s.name.toLowerCase().includes(q)) : libSfx;
  }, [libSfx, searchQuery]);

  useEffect(() => {
    if (!selectedManualSoundSrc && filteredSfx[0]?.src) {
      setSelectedManualSoundSrc(filteredSfx[0].src);
    }
  }, [filteredSfx, selectedManualSoundSrc]);

  const togglePreview = (src?: string) => {
    const resolved = resolveSrc(src);
    if (!resolved) return;
    const audio = previewAudioRef.current;
    if (!audio) return;
    if (previewSrc === resolved && !audio.paused) {
      audio.pause();
      audio.currentTime = 0;
      setPreviewSrc(null);
      return;
    }
    audio.src = resolved;
    audio.currentTime = 0;
    void audio.play();
    setPreviewSrc(resolved);
  };

  const handleAddAudio = (sound: SavedSound) => {
    const sm = getStateManagerRef();
    if (!sm || !sound.src) return;
    const patch = addManualSfx(
      { duration, tracks, trackItemIds, trackItemsMap },
      {
        from: getCurrentTime(),
        src: resolveSrc(sound.src),
        name: sound.name,
        durationMs: Number(sound.durationMs || 700)
      }
    );
    sm.updateState(patch, { updateHistory: true, kind: "add" });
  };

  const selectedAutoSound = useMemo(
    () => libSfx.find((s) => s.src === selectedAutoSoundSrc) || libSfx[0],
    [libSfx, selectedAutoSoundSrc]
  );
  const selectedManualSound = useMemo(
    () => filteredSfx.find((s) => s.src === selectedManualSoundSrc) || filteredSfx[0],
    [filteredSfx, selectedManualSoundSrc]
  );

  const applyCutSfx = (enabled: boolean, volume: number) => {
    const sm = getStateManagerRef();
    if (!sm) return;
    const patch = upsertCutSfx(
      { duration, tracks, trackItemIds, trackItemsMap },
      { enabled, src: selectedAutoSoundSrc ? resolveSrc(selectedAutoSoundSrc) : "", volume }
    );
    sm.updateState(patch, { updateHistory: true, kind: "add" });
  };

  const emptyLibrary = libSfx.length === 0;

  const EmptyHint = () => (
    <div className="flex flex-col items-center justify-center gap-1 py-6 text-center text-muted-foreground">
      <Music2 size={22} className="opacity-50" />
      <span className="text-sm">No sound effects saved</span>
      <span className="text-[11px] px-3">Open Stock → Sound, search, and tap the ⚡ button on a result to add it here.</span>
    </div>
  );

  const SoundList = ({
    sounds,
    selectedSrc,
    onPick
  }: {
    sounds: SavedSound[];
    selectedSrc?: string;
    onPick: (s: SavedSound) => void;
  }) => (
    <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
      {sounds.length === 0 ? (
        <EmptyHint />
      ) : (
        sounds.map((sound) => {
          const isSelected = sound.src === selectedSrc;
          return (
            <div
              key={sound.id}
              className={`flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent ${
                isSelected ? "bg-accent font-medium" : ""
              }`}
            >
              <button
                type="button"
                onClick={() => onPick(sound)}
                className="flex min-w-0 flex-1 items-center justify-between text-left"
              >
                <div className="min-w-0">
                  <div className="truncate">{sound.name}</div>
                  <div className="text-[11px] text-muted-foreground">{sound.source || sound.author || "Sound effect"}</div>
                </div>
                {isSelected && <span className="ml-2 text-[10px] text-muted-foreground">●</span>}
              </button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-red-400"
                onClick={(e) => {
                  e.stopPropagation();
                  removeSfx(sound.id);
                }}
                title="Remove from SFX"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          );
        })
      )}
    </div>
  );

  return (
    <div className="flex flex-1 min-h-0 max-w-full flex-col overflow-hidden">
      <audio ref={previewAudioRef} onEnded={() => setPreviewSrc(null)} className="hidden" />
      <ScrollArea className="flex-1 min-h-0 max-w-full">
        <div className="space-y-4 px-4 py-4">
          {/* Auto cut sound */}
          <div className="rounded-lg border border-border/70 bg-background/30 p-3">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Auto Cut Sound</p>
                <p className="mt-1 text-sm font-medium text-foreground">Add sound on every cut</p>
                <p className="text-xs text-muted-foreground">
                  {emptyLibrary
                    ? "Add a sound effect first (Stock → Sound), then it can play on each cut."
                    : cutCount > 0
                      ? `Automatically places a short sound on each clip boundary (${cutCount} detected).`
                      : "Needs at least 2 visual clips before cut sounds can be added."}
                </p>
              </div>
              <Switch
                disabled={cutCount === 0 || emptyLibrary}
                checked={activeCutSfx.length > 0}
                onCheckedChange={(checked) => applyCutSfx(checked, cutSfxVolume)}
                aria-label="Toggle automatic cut sound effects"
              />
            </div>

            <div className="flex items-center gap-2">
              <Popover open={autoPickerOpen} onOpenChange={setAutoPickerOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="h-10 flex-1 justify-between px-3 text-left">
                    <div className="min-w-0">
                      <div className="truncate text-sm">{selectedAutoSound?.name || "Select auto sound"}</div>
                      <div className="text-[11px] text-muted-foreground">Auto cut sound</div>
                    </div>
                    <ChevronDown className="ml-2 size-4 shrink-0 opacity-70" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="z-[260] w-[--radix-popover-trigger-width] p-2">
                  <SoundList
                    sounds={libSfx}
                    selectedSrc={selectedAutoSoundSrc}
                    onPick={(sound) => {
                      setSelectedAutoSoundSrc(sound.src);
                      setAutoPickerOpen(false);
                      if (activeCutSfx.length > 0) {
                        const sm = getStateManagerRef();
                        if (!sm) return;
                        const patch = upsertCutSfx(
                          { duration, tracks, trackItemIds, trackItemsMap },
                          { enabled: true, src: resolveSrc(sound.src), volume: cutSfxVolume }
                        );
                        sm.updateState(patch, { updateHistory: true, kind: "add" });
                      }
                    }}
                  />
                </PopoverContent>
              </Popover>
              <Button
                size="icon"
                variant="outline"
                className="h-10 w-10 shrink-0"
                onClick={() => togglePreview(selectedAutoSound?.src)}
                title="Preview auto sound"
                disabled={!selectedAutoSound?.src}
              >
                {previewSrc === resolveSrc(selectedAutoSound?.src) ? (
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

          {/* Manual sound effect */}
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
                <Button variant="outline" className="h-10 w-full justify-between px-3 text-left">
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
                    <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="Filter saved sounds..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-8"
                    />
                  </div>
                </div>
                <SoundList
                  sounds={filteredSfx}
                  selectedSrc={selectedManualSound?.src}
                  onPick={(sound) => {
                    setSelectedManualSoundSrc(sound.src);
                    setManualPickerOpen(false);
                  }}
                />
              </PopoverContent>
            </Popover>

            <div className="mt-3 flex items-center gap-2">
              <Button
                size="icon"
                variant="outline"
                className="h-10 w-10 shrink-0"
                onClick={() => togglePreview(selectedManualSound?.src)}
                title="Preview selected sound"
                disabled={!selectedManualSound?.src}
              >
                {previewSrc === resolveSrc(selectedManualSound?.src) ? (
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
