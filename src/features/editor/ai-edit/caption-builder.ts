// Word-synced caption builder — the SAME logic the built-in Captions tab uses
// (captions-panel.tsx), extracted so the AI Edit panel can add captions from a prompt.
// Given an audio track item + its transcript (segments with word timestamps), it lays a
// "Captions" track under the audio, timed to the words. Returns the created item ids.

import { getStateManagerRef } from "../utils/state-manager-ref";

export interface CaptionStyle {
  fontSize: number;
  color: string;
  activeColor: string;
  activeFillColor: string;
  backgroundColor: string;
  position: "top" | "center" | "bottom";
  highlightWords: boolean;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontSize: 22,
  color: "#FFFFFF",
  activeColor: "#F5E7BE",
  activeFillColor: "#7E12FF",
  backgroundColor: "rgba(0,0,0,0)",
  position: "bottom",
  highlightWords: true,
};

const POSITION_TOP: Record<string, string> = { top: "10%", center: "45%", bottom: "80%" };
const CAPTION_TRACK_PREFIX = "captions-track--";

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
    confidence: 1,
  }));
}

function buildCaptionItem(trackItem: any, segment: any, segIdx: number, style: CaptionStyle) {
  const trimFrom = Number(trackItem?.trim?.from || 0) / 1000;
  const trimTo =
    Number(
      trackItem?.trim?.to ||
        trackItem?.duration ||
        Math.max(0, trackItem.display.to - trackItem.display.from)
    ) / 1000;
  const clipDisplayFrom = Number(trackItem.display.from || 0);

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
    metadata: {
      sourceTrackItemId: trackItem.id,
      addedCaption: true,
      sourceUrl: trackItem?.details?.src ?? "",
      // offset from clip start → useCaptionSync keeps the caption glued to its clip.
      relFrom: displayFrom - clipDisplayFrom,
      relTo: displayTo - clipDisplayFrom,
    },
    details: {
      text: String(segment.text || "").trim(),
      fontSize: style.fontSize,
      color: style.color,
      activeColor: style.highlightWords ? style.activeColor : style.color,
      activeFillColor: style.highlightWords ? style.activeFillColor : "transparent",
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
      height: 80,
    },
  };
}

// Lay a word-synced "Captions" track under the audio. Returns created caption item ids.
export function addCaptions(
  trackItem: any,
  transcript: { segments: any[] } | null | undefined,
  style: CaptionStyle = DEFAULT_CAPTION_STYLE
): string[] {
  const sm = getStateManagerRef();
  if (!sm?.getState || !trackItem || !transcript?.segments?.length) return [];

  const captionTrackId = `${CAPTION_TRACK_PREFIX}${trackItem.id}`;
  const st = sm.getState();
  const currentTracks: any[] = Array.isArray(st?.tracks) ? st.tracks : [];
  const currentMap = { ...(st?.trackItemsMap || {}) };
  const currentIds: string[] = Array.isArray(st?.trackItemIds) ? [...st.trackItemIds] : [];

  // replace any existing captions for this audio
  const oldIds = Object.keys(currentMap).filter(
    (id) => currentMap[id]?.metadata?.sourceTrackItemId === trackItem.id && currentMap[id]?.metadata?.addedCaption
  );
  oldIds.forEach((id) => delete currentMap[id]);
  const filteredIds = currentIds.filter((id: string) => !oldIds.includes(id));

  const newItems = transcript.segments
    .map((seg: any, i: number) => buildCaptionItem(trackItem, seg, i, style))
    .filter(Boolean) as any[];
  if (!newItems.length) return [];

  newItems.forEach((item) => {
    currentMap[item.id] = item;
  });
  const newIds = [...filteredIds, ...newItems.map((i) => i.id)];

  // ALL captions share ONE caption track (single row) — merge into the existing caption
  // track if present, else create one after this clip's track.
  const capTracks = currentTracks.filter((t: any) => t?.type === "caption");
  let nextTracks: any[];
  if (capTracks.length) {
    const mergedItemIds = [
      ...capTracks.flatMap((t: any) => (Array.isArray(t.items) ? t.items : []).filter((id: string) => !oldIds.includes(id))),
      ...newItems.map((i) => i.id),
    ];
    const sharedTrack = { ...capTracks[0], type: "caption", items: mergedItemIds };
    let placed = false;
    nextTracks = [];
    for (const t of currentTracks) {
      if (t?.type === "caption") { if (!placed) { nextTracks.push(sharedTrack); placed = true; } }
      else nextTracks.push(t);
    }
  } else {
    let insertAfter = currentTracks.findIndex((t: any) => Array.isArray(t.items) && t.items.includes(trackItem.id));
    if (insertAfter === -1) insertAfter = currentTracks.length - 1;
    const newTrack = {
      id: captionTrackId, type: "caption", name: "Captions", accepts: ["caption"],
      items: newItems.map((i) => i.id), magnetic: false, static: false,
      metadata: { captionTrack: true },
    };
    nextTracks = [...currentTracks.slice(0, insertAfter + 1), newTrack, ...currentTracks.slice(insertAfter + 1)];
  }

  sm.updateState(
    { tracks: nextTracks, trackItemIds: newIds, trackItemsMap: currentMap },
    { updateHistory: true }
  );
  return newItems.map((i) => i.id);
}
