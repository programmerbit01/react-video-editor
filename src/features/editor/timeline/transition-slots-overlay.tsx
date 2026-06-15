"use client";
import { useRef, useState } from "react";
import { ITrack, ITransition } from "@designcombo/types";
import { timeMsToUnits } from "@designcombo/timeline";
import useStore from "../store/use-store";
import { useTimelineOffsetX } from "../hooks/use-timeline-offset";
import { TIMELINE_OFFSET_CANVAS_LEFT } from "../constants/constants";
import { TRANSITIONS } from "../data/transitions";
import { getStateManagerRef } from "../utils/state-manager-ref";
import { ScrollArea } from "@/components/ui/scroll-area";
import { generateId } from "@designcombo/timeline";
import { X } from "lucide-react";

// Must match sizesMap + TrackControlsOverlay
const ROW_H: Record<string, number> = {
  caption: 32,
  text: 32,
  audio: 36,
  linealAudioBars: 40,
  radialAudioBars: 40,
  waveAudioBars: 40,
  hillAudioBars: 40,
};
const CANVAS_TRACK_OFFSET_Y = 30;
const CANVAS_TRACK_GAP = 8;
const rowH = (type: string) => ROW_H[type] ?? 40;

// Only video/image tracks can have transitions
const supportsTransitions = (type: string) =>
  type === "video" || type === "image";

interface Junction {
  trackId: string;
  fromId: string;
  toId: string;
  x: number; // pixel position from left of overlay container
  y: number;
  height: number;
  existingTransition: ITransition | null;
}

interface PickerState {
  junction: Junction;
  anchorX: number;
  anchorY: number;
}

export default function TransitionSlotsOverlay() {
  const { tracks, trackItemsMap, transitionsMap, scale, scroll } = useStore();
  const timelineOffsetX = useTimelineOffsetX();
  const [picker, setPicker] = useState<PickerState | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Build junctions list
  const junctions: Junction[] = [];
  let cumY = CANVAS_TRACK_OFFSET_Y;

  (tracks as ITrack[]).forEach((track, i) => {
    const h = rowH(track.type as string);
    const top = cumY;
    cumY += h + (i < tracks.length - 1 ? CANVAS_TRACK_GAP : 0);

    if (!supportsTransitions(track.type as string)) return;

    // Get items sorted by display.from
    const items = (track.items ?? [])
      .map((id: string) => trackItemsMap[id])
      .filter(Boolean)
      .sort((a: any, b: any) => (a.display?.from ?? 0) - (b.display?.from ?? 0));

    for (let j = 0; j < items.length - 1; j++) {
      const left = items[j] as any;
      const right = items[j + 1] as any;

      const junctionTimeMs = left.display?.to ?? 0;
      const xOnCanvas =
        timeMsToUnits(junctionTimeMs, scale.zoom) - scroll.left + TIMELINE_OFFSET_CANVAS_LEFT;
      // Add left sidebar offset so it aligns with the canvas area
      const x = xOnCanvas + timelineOffsetX;

      // Find existing transition between these two clips
      const existing =
        Object.values(transitionsMap as Record<string, ITransition>).find(
          (t) => t.fromId === left.id && t.toId === right.id
        ) ?? null;

      junctions.push({
        trackId: track.id,
        fromId: left.id,
        toId: right.id,
        x,
        y: top,
        height: h,
        existingTransition: existing,
      });
    }
  });

  const openPicker = (junction: Junction, e: React.MouseEvent) => {
    e.stopPropagation();
    setPicker({ junction, anchorX: junction.x, anchorY: junction.y });
  };

  const closePicker = () => setPicker(null);

  const applyTransition = (transition: (typeof TRANSITIONS)[number]) => {
    if (!picker) return;
    const sm = getStateManagerRef();
    if (!sm) return;

    const { junction } = picker;
    const currentState = sm.getState();
    const newId = generateId();

    // Remove any existing transition between this pair
    const existingId = junction.existingTransition?.id;
    const filteredIds = existingId
      ? currentState.transitionIds.filter((id: string) => id !== existingId)
      : currentState.transitionIds;
    const filteredMap = { ...currentState.transitionsMap };
    if (existingId) delete filteredMap[existingId];

    if (transition.kind === "none") {
      // Just remove, don't add new
      sm.updateState({
        transitionIds: filteredIds,
        transitionsMap: filteredMap,
      } as any);
    } else {
      const newTransition: ITransition = {
        id: newId,
        trackId: junction.trackId,
        fromId: junction.fromId,
        toId: junction.toId,
        kind: transition.kind,
        name: transition.name || transition.kind,
        duration: transition.duration * 1000,
        direction: (transition as any).direction,
        type: "transition",
        preview: transition.preview,
      };

      sm.updateState({
        transitionIds: [...filteredIds, newId],
        transitionsMap: { ...filteredMap, [newId]: newTransition },
      } as any);
    }

    closePicker();
  };

  const removeTransition = () => {
    if (!picker?.junction.existingTransition) return closePicker();
    const sm = getStateManagerRef();
    if (!sm) return;

    const currentState = sm.getState();
    const tid = picker.junction.existingTransition.id;
    const filteredIds = currentState.transitionIds.filter((id: string) => id !== tid);
    const filteredMap = { ...currentState.transitionsMap };
    delete filteredMap[tid];

    sm.updateState({
      transitionIds: filteredIds,
      transitionsMap: filteredMap,
    } as any);

    closePicker();
  };

  return (
    <div
      ref={overlayRef}
      className="pointer-events-none absolute inset-0 overflow-hidden select-none"
    >
      {junctions.map((j, idx) => {
        const hasTransition = !!j.existingTransition;
        const isOpen =
          picker?.junction.fromId === j.fromId &&
          picker?.junction.toId === j.toId;

        return (
          <div key={idx}>
            {/* Junction button — diamond shape */}
            <button
              type="button"
              className={`pointer-events-auto absolute flex items-center justify-center transition-opacity
                ${hasTransition ? "opacity-100" : "opacity-0 hover:opacity-100 group-hover:opacity-100"}
              `}
              style={{
                left: j.x - 10,
                top: j.y + j.height / 2 - 10,
                width: 20,
                height: 20,
                zIndex: 10,
              }}
              onClick={(e) => openPicker(j, e)}
              title={
                hasTransition
                  ? `Transition: ${j.existingTransition!.name || j.existingTransition!.kind}`
                  : "Add transition"
              }
            >
              <div
                className={`h-3 w-3 rotate-45 border transition-colors ${
                  hasTransition
                    ? "border-amber-400 bg-amber-400/30"
                    : "border-white/50 bg-black/40 hover:border-white hover:bg-white/20"
                }`}
              />
            </button>

            {/* Transition name label under the diamond */}
            {hasTransition && (
              <div
                className="pointer-events-none absolute text-[9px] font-medium text-amber-400/90 whitespace-nowrap"
                style={{
                  left: j.x - 30,
                  top: j.y + j.height / 2 + 12,
                  width: 60,
                  textAlign: "center",
                  zIndex: 9,
                }}
              >
                {j.existingTransition!.name || j.existingTransition!.kind}
              </div>
            )}
          </div>
        );
      })}

      {/* Transition picker popover */}
      {picker && (
        <>
          {/* Backdrop to close */}
          <div
            className="pointer-events-auto fixed inset-0 z-[200]"
            onClick={closePicker}
          />

          <div
            className="pointer-events-auto absolute z-[201] w-64 rounded-lg border border-border bg-card shadow-xl"
            style={{
              left: Math.min(picker.anchorX - 20, window.innerWidth - 280),
              top: picker.anchorY + rowH("video") + 4,
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
              <span className="text-sm font-semibold">Transition</span>
              <button
                type="button"
                onClick={closePicker}
                className="text-muted-foreground hover:text-foreground"
              >
                <X size={14} />
              </button>
            </div>

            <ScrollArea className="h-64">
              <div className="grid grid-cols-3 gap-2 p-3">
                {/* None option */}
                <div
                  className={`flex cursor-pointer flex-col items-center gap-1 rounded-md p-1.5 text-center transition-colors hover:bg-accent ${
                    !picker.junction.existingTransition ? "ring-2 ring-amber-400" : ""
                  }`}
                  onClick={() => applyTransition(TRANSITIONS[0])}
                >
                  <div className="flex h-14 w-14 items-center justify-center rounded-md bg-muted/50 text-xl text-muted-foreground">
                    ✕
                  </div>
                  <span className="text-[10px] text-muted-foreground">None</span>
                </div>

                {/* Actual transitions */}
                {TRANSITIONS.slice(1).map((t) => {
                  const isActive =
                    picker.junction.existingTransition?.kind === t.kind &&
                    picker.junction.existingTransition?.direction === (t as any).direction &&
                    picker.junction.existingTransition?.name === (t.name || t.kind);
                  return (
                    <div
                      key={t.id}
                      className={`flex cursor-pointer flex-col items-center gap-1 rounded-md p-1.5 text-center transition-colors hover:bg-accent ${
                        isActive ? "ring-2 ring-amber-400" : ""
                      }`}
                      onClick={() => applyTransition(t)}
                    >
                      <img
                        src={t.preview}
                        alt={t.name || t.kind}
                        className="h-14 w-14 rounded-md object-cover"
                        draggable={false}
                      />
                      <span className="text-[10px] capitalize text-muted-foreground">
                        {t.name || t.kind}
                      </span>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>

            {/* Duration info if transition applied */}
            {picker.junction.existingTransition && (
              <div className="flex items-center justify-between border-t border-border/60 px-3 py-2">
                <span className="text-xs text-muted-foreground">
                  Duration:{" "}
                  {(picker.junction.existingTransition.duration / 1000).toFixed(1)}s
                </span>
                <button
                  type="button"
                  onClick={removeTransition}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
