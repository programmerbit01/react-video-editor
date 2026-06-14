import { useEffect, useMemo, useRef } from "react";
import StateManager from "@designcombo/state";
import { ITrackItem } from "@designcombo/types";
import useStore from "../store/use-store";
import useCaptionTranscribeStore, {
  TranscriptResult,
  TranscriptSegment
} from "../store/use-caption-transcribe-store";
import {
  TranscriptOverlayStore,
  OverlaySegment,
  OverlayWord
} from "../utils/transcript-overlay-store";

const TRANSCRIPT_TRACK_PREFIX = "transcript-track--";
const TRANSCRIPT_ITEM_PREFIX = "transcript-guide--";

export default function useTranscriptGuides(stateManager: StateManager) {
  const { tracks, trackItemsMap, trackItemIds } = useStore();
  const { resultsByMedia } = useCaptionTranscribeStore();
  const lastSignatureRef = useRef("");

  const syncInput = useMemo(
    () => ({ tracks, trackItemsMap, trackItemIds, resultsByMedia }),
    [tracks, trackItemsMap, trackItemIds, resultsByMedia]
  );

  useEffect(() => {
    const currentState = stateManager.getState();
    const patch = buildOverlayPatch({
      state: currentState,
      runtimeResults: resultsByMedia
    });

    const signature = JSON.stringify(patch.signaturePayload);
    if (signature === lastSignatureRef.current) return;
    lastSignatureRef.current = signature;

    // Sync the module-level overlay store
    for (const [itemId, segs] of Object.entries(patch.overlaySegments)) {
      TranscriptOverlayStore[itemId] = segs;
    }
    for (const itemId of Object.keys(TranscriptOverlayStore)) {
      if (!patch.overlaySegments[itemId]) {
        delete TranscriptOverlayStore[itemId];
      }
    }

    if (!patch.changed) return;

    stateManager.updateState(
      {
        tracks: patch.tracks,
        trackItemIds: patch.trackItemIds,
        trackItemsMap: patch.trackItemsMap
      },
      { updateHistory: false }
    );
  }, [stateManager, syncInput, resultsByMedia]);
}

function buildOverlayPatch({
  state,
  runtimeResults
}: {
  state: any;
  runtimeResults: Record<string, TranscriptResult>;
}) {
  const currentTracks = Array.isArray(state?.tracks) ? state.tracks : [];
  const currentTrackItemsMap = state?.trackItemsMap || {};
  const currentTrackItemIds = Array.isArray(state?.trackItemIds)
    ? state.trackItemIds
    : [];

  // Strip out legacy transcript tracks
  const baseTracks = currentTracks.filter(
    (track: any) => !String(track?.id || "").startsWith(TRANSCRIPT_TRACK_PREFIX)
  );

  // Collect legacy guide item IDs so we can remove them from state
  const legacyGuideIds = Object.keys(currentTrackItemsMap).filter((id) =>
    id.startsWith(TRANSCRIPT_ITEM_PREFIX)
  );

  const nextTrackItemsMap = { ...currentTrackItemsMap };
  const overlaySegments: Record<string, OverlaySegment[]> = {};
  let mediaMetadataChanged = false;

  for (const track of baseTracks) {
    for (const itemId of track.items || []) {
      const item = currentTrackItemsMap[itemId] as ITrackItem | undefined;
      if (!item) continue;
      if (item.type !== "audio" && item.type !== "video") continue;

      const mediaSrc = String(item?.details?.src || "").trim();
      const metadataTranscript = item?.metadata?.transcriptData as
        | TranscriptResult
        | undefined;
      const transcript = runtimeResults[mediaSrc] || metadataTranscript;
      if (!transcript?.segments?.length) continue;

      // Keep metadata.transcriptData up to date
      if (
        runtimeResults[mediaSrc] &&
        item?.metadata?.transcriptData !== runtimeResults[mediaSrc]
      ) {
        nextTrackItemsMap[item.id] = {
          ...item,
          metadata: {
            ...(item.metadata || {}),
            transcriptData: runtimeResults[mediaSrc],
            transcriptUpdatedAt: Date.now()
          }
        };
        mediaMetadataChanged = true;
      }

      overlaySegments[item.id] = buildSegmentsForMedia(
        (nextTrackItemsMap[item.id] as ITrackItem) || item,
        transcript
      );
    }
  }

  // Remove legacy guide items from the map
  for (const guideId of legacyGuideIds) {
    delete nextTrackItemsMap[guideId];
  }

  const nextTrackItemIds = currentTrackItemIds.filter(
    (id: string) => !id.startsWith(TRANSCRIPT_ITEM_PREFIX)
  );

  const changed =
    mediaMetadataChanged ||
    legacyGuideIds.length > 0 ||
    JSON.stringify(currentTracks) !== JSON.stringify(baseTracks) ||
    JSON.stringify(currentTrackItemIds) !== JSON.stringify(nextTrackItemIds);

  return {
    changed,
    tracks: baseTracks,
    trackItemIds: nextTrackItemIds,
    trackItemsMap: nextTrackItemsMap,
    overlaySegments,
    signaturePayload: {
      trackIds: baseTracks.map((t: any) => t.id),
      overlayMap: Object.fromEntries(
        Object.entries(overlaySegments).map(([id, segs]) => [
          id,
          segs.map((s) => `${s.displayFrom}-${s.displayTo}`)
        ])
      )
    }
  };
}

function buildSegmentsForMedia(
  mediaItem: ITrackItem,
  transcript: TranscriptResult
): OverlaySegment[] {
  const trimFrom = Number(mediaItem?.trim?.from || 0) / 1000;
  const trimTo =
    Number(
      mediaItem?.trim?.to ||
        mediaItem?.duration ||
        Math.max(0, mediaItem.display.to - mediaItem.display.from)
    ) / 1000;
  const clipDisplayFrom = Number(mediaItem.display.from || 0);

  return transcript.segments.flatMap((segment) => {
    const overlapStart = Math.max(trimFrom, Number(segment.start || 0));
    const overlapEnd = Math.min(trimTo, Number(segment.end || 0));
    if (overlapEnd <= overlapStart) return [];

    const displayFrom = clipDisplayFrom + (overlapStart - trimFrom) * 1000;
    const displayTo = clipDisplayFrom + (overlapEnd - trimFrom) * 1000;

    return [
      {
        displayFrom,
        displayTo,
        text: String(segment.text || "").trim(),
        words: normalizeSegmentWords(segment)
      }
    ];
  });
}

function normalizeSegmentWords(segment: TranscriptSegment): OverlayWord[] {
  if (Array.isArray(segment.words) && segment.words.length > 0) {
    return segment.words.map((word) => ({
      word: word.word,
      startMs: word.start * 1000,
      endMs: word.end * 1000
    }));
  }
  return [
    {
      word: segment.text,
      startMs: segment.start * 1000,
      endMs: segment.end * 1000
    }
  ];
}
