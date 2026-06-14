import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useEffect, useState } from "react";
import { ITrackItem } from "@designcombo/types";
import { CheckCircle2 } from "lucide-react";
import useCaptionTranscribeStore, { TranscriptResult } from "../store/use-caption-transcribe-store";
import { getStateManagerRef } from "../utils/state-manager-ref";
import useStore from "../store/use-store";

const CAPTION_TRACK_PREFIX = "captions-track--";

const DEFAULT_STYLE = {
  fontSize: 22,
  color: "#FFFFFF",
  activeColor: "#F5E7BE",
  activeFillColor: "#7E12FF",
  backgroundColor: "rgba(0,0,0,0)",
  position: "bottom" as "top" | "center" | "bottom"
};

const POSITION_TOP: Record<string, string> = {
  top: "10%",
  center: "45%",
  bottom: "80%"
};

function buildWords(segment: any, overlapStart: number, overlapEnd: number) {
  if (!segment.words?.length) {
    return [{ word: segment.text, start: segment.start * 1000, end: segment.end * 1000, confidence: 1 }];
  }
  const filtered = segment.words.filter(
    (w: any) => Number(w.start) >= overlapStart - 0.05 && Number(w.end) <= overlapEnd + 0.05
  );
  return (filtered.length ? filtered : segment.words).map((w: any) => ({
    word: w.word,
    start: w.start * 1000,
    end: w.end * 1000,
    confidence: 1
  }));
}

function buildCaptionItem(
  trackItem: ITrackItem,
  segment: any,
  segIdx: number,
  style: typeof DEFAULT_STYLE
) {
  const trimFrom = Number((trackItem as any)?.trim?.from || 0) / 1000;
  const trimTo =
    Number(
      (trackItem as any)?.trim?.to ||
        (trackItem as any)?.duration ||
        Math.max(0, (trackItem as any).display.to - (trackItem as any).display.from)
    ) / 1000;
  const clipDisplayFrom = Number((trackItem as any).display.from || 0);

  const overlapStart = Math.max(trimFrom, Number(segment.start || 0));
  const overlapEnd = Math.min(trimTo, Number(segment.end || 0));
  if (overlapEnd <= overlapStart) return null;

  const displayFrom = clipDisplayFrom + (overlapStart - trimFrom) * 1000;
  const displayTo = clipDisplayFrom + (overlapEnd - trimFrom) * 1000;

  return {
    id: `cap-${trackItem.id}-${segIdx}-${Math.random().toString(36).slice(2, 7)}`,
    type: "caption",
    name: "caption",
    isMain: false,
    display: { from: displayFrom, to: displayTo },
    metadata: { sourceTrackItemId: trackItem.id, addedCaption: true },
    details: {
      text: String(segment.text || "").trim(),
      fontSize: style.fontSize,
      color: style.color,
      activeColor: style.activeColor,
      activeFillColor: style.activeFillColor,
      appearedColor: style.color,
      backgroundColor: style.backgroundColor,
      borderColor: "rgba(255,255,255,0.08)",
      borderWidth: 1,
      fontFamily: "Inter",
      fontUrl: "",
      textAlign: "center",
      linesPerCaption: 2,
      words: buildWords(segment, overlapStart, overlapEnd),
      top: POSITION_TOP[style.position],
      left: "calc(50% - 340px)",
      width: 680,
      height: 80
    }
  };
}

function applyCaption(
  trackItem: ITrackItem,
  transcript: TranscriptResult,
  style: typeof DEFAULT_STYLE
) {
  const sm = getStateManagerRef();
  if (!sm || !transcript?.segments) return;

  const captionTrackId = `${CAPTION_TRACK_PREFIX}${trackItem.id}`;
  const currentState = sm.getState();
  const currentTracks: any[] = Array.isArray(currentState?.tracks) ? currentState.tracks : [];
  const currentMap = { ...(currentState?.trackItemsMap || {}) };
  const currentIds: string[] = Array.isArray(currentState?.trackItemIds) ? [...currentState.trackItemIds] : [];

  // Remove existing captions for this source track
  const oldIds = Object.keys(currentMap).filter(
    (id) => currentMap[id]?.metadata?.sourceTrackItemId === trackItem.id && currentMap[id]?.metadata?.addedCaption
  );
  oldIds.forEach((id) => delete currentMap[id]);
  const filteredTracks = currentTracks.filter((t) => t.id !== captionTrackId);
  const filteredIds = currentIds.filter((id) => !oldIds.includes(id));

  const newItems = transcript.segments
    .map((seg, i) => buildCaptionItem(trackItem, seg, i, style))
    .filter(Boolean) as any[];

  if (!newItems.length) return;

  newItems.forEach((item) => { currentMap[item.id] = item; });
  const newIds = [...filteredIds, ...newItems.map((i) => i.id)];

  let insertAfter = filteredTracks.findIndex(
    (t) => Array.isArray(t.items) && t.items.includes(trackItem.id)
  );
  if (insertAfter === -1) insertAfter = filteredTracks.length - 1;

  const newTrack = {
    id: captionTrackId,
    type: "caption",
    name: "Captions",
    accepts: ["caption"],
    items: newItems.map((i) => i.id),
    magnetic: false,
    static: false,
    metadata: { captionTrack: true, sourceTrackItemId: trackItem.id }
  };

  const newTracks = [
    ...filteredTracks.slice(0, insertAfter + 1),
    newTrack,
    ...filteredTracks.slice(insertAfter + 1)
  ];

  sm.updateState(
    { tracks: newTracks, trackItemIds: newIds, trackItemsMap: currentMap },
    { updateHistory: true }
  );
}

function ColorSwatch({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <label className="relative flex h-8 w-full cursor-pointer items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-2 hover:bg-background/80">
        <span className="h-4 w-4 shrink-0 rounded-md border border-border/60" style={{ backgroundColor: value }} />
        <span className="text-xs font-mono text-muted-foreground">{value}</span>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}

export default function CaptionsPanel({ trackItem }: { trackItem: ITrackItem }) {
  const { resultsByMedia } = useCaptionTranscribeStore();
  const { tracks } = useStore();
  const [style, setStyle] = useState(DEFAULT_STYLE);

  const src = (trackItem as any)?.details?.src as string | undefined;
  const transcript: TranscriptResult | undefined =
    (src ? resultsByMedia[src] : undefined) ||
    ((trackItem as any)?.metadata?.transcriptData as TranscriptResult | undefined);

  const captionTrackId = `${CAPTION_TRACK_PREFIX}${trackItem.id}`;
  const captionTrack = (tracks as any[]).find((t) => t.id === captionTrackId);
  const captionCount = captionTrack?.items?.length ?? 0;

  const handleApply = () => {
    if (!transcript) return;
    applyCaption(trackItem, transcript, style);
  };

  return (
    <div className="flex flex-col gap-4 p-3">
      {/* Transcript status */}
      {transcript ? (
        <div className="flex items-center gap-2 rounded-xl bg-card/40 px-3 py-2">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
          <span className="text-xs text-muted-foreground">
            {transcript.segments.length} segments ready
          </span>
        </div>
      ) : (
        <div className="rounded-xl bg-card/30 px-3 py-2 text-xs text-muted-foreground">
          Generate transcript first via the Guided Text tab.
        </div>
      )}

      {/* Style controls */}
      <div className="space-y-4 rounded-2xl bg-card/30 p-4">
        <p className="text-xs font-semibold text-foreground">Style</p>

        {/* Font size */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Font size</Label>
            <span className="text-xs font-medium tabular-nums">{style.fontSize}px</span>
          </div>
          <Slider
            min={14} max={56} step={1}
            value={[style.fontSize]}
            onValueChange={([v]) => setStyle((s) => ({ ...s, fontSize: v }))}
          />
        </div>

        {/* Colors */}
        <ColorSwatch label="Text color" value={style.color} onChange={(v) => setStyle((s) => ({ ...s, color: v }))} />
        <ColorSwatch label="Active word color" value={style.activeColor} onChange={(v) => setStyle((s) => ({ ...s, activeColor: v }))} />
        <ColorSwatch label="Active word highlight" value={style.activeFillColor} onChange={(v) => setStyle((s) => ({ ...s, activeFillColor: v }))} />

        {/* Position */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Position</Label>
          <div className="grid grid-cols-3 gap-1">
            {(["top", "center", "bottom"] as const).map((pos) => (
              <button
                key={pos}
                type="button"
                onClick={() => setStyle((s) => ({ ...s, position: pos }))}
                className={`rounded-lg py-1.5 text-xs font-medium capitalize transition-colors ${
                  style.position === pos
                    ? "bg-primary text-primary-foreground"
                    : "bg-background/60 text-muted-foreground hover:bg-background"
                }`}
              >
                {pos}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Action button */}
      <Button
        onClick={handleApply}
        disabled={!transcript}
        className="w-full"
        variant={captionCount > 0 ? "outline" : "default"}
      >
        {captionCount > 0 ? `Update Captions (${captionCount})` : "Add Captions to Video"}
      </Button>
    </div>
  );
}
