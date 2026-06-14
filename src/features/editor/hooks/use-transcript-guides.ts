import { useEffect, useMemo, useRef } from "react";
import StateManager from "@designcombo/state";
import { ITrackItem } from "@designcombo/types";
import useStore from "../store/use-store";
import useCaptionTranscribeStore, {
  TranscriptResult,
  TranscriptSegment
} from "../store/use-caption-transcribe-store";

const TRANSCRIPT_TRACK_PREFIX = "transcript-track:";
const TRANSCRIPT_ITEM_PREFIX = "transcript-guide:";

const CAPTION_ACCEPTS = [
  "audio",
  "video",
  "image",
  "text",
  "caption",
  "template"
];

type GuideItem = any;

export default function useTranscriptGuides(stateManager: StateManager) {
  const { tracks, trackItemsMap, trackItemIds } = useStore();
  const { resultsByMedia } = useCaptionTranscribeStore();
  const lastSignatureRef = useRef("");

  const syncInput = useMemo(
    () => ({
      tracks,
      trackItemsMap,
      trackItemIds,
      resultsByMedia
    }),
    [tracks, trackItemsMap, trackItemIds, resultsByMedia]
  );

  useEffect(() => {
    const currentState = stateManager.getState();
    const patch = buildTranscriptGuidePatch({
      state: currentState,
      runtimeResults: resultsByMedia
    });

    const signature = JSON.stringify(patch.signaturePayload);
    if (signature === lastSignatureRef.current) return;
    lastSignatureRef.current = signature;

    if (!patch.changed) return;

    stateManager.updateState(
      {
        tracks: patch.tracks,
        trackItemIds: patch.trackItemIds,
        trackItemsMap: patch.trackItemsMap
      },
      {
        updateHistory: false
      }
    );
  }, [stateManager, syncInput, resultsByMedia]);
}

function buildTranscriptGuidePatch({
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

  const baseTracks = currentTracks.filter(
    (track: any) => !String(track?.id || "").startsWith(TRANSCRIPT_TRACK_PREFIX)
  );

  const currentGuideItems = Object.fromEntries(
    Object.entries(currentTrackItemsMap).filter(([, item]: any) =>
      Boolean(item?.metadata?.transcriptGuide)
    )
  );

  const nextTrackItemsMap = { ...currentTrackItemsMap };
  const desiredGuideItems: Record<string, GuideItem> = {};
  const guidesByTrackId: Record<string, string[]> = {};

  for (const track of baseTracks) {
    for (const itemId of track.items || []) {
      const item = currentTrackItemsMap[itemId] as ITrackItem | undefined;
      if (!item) continue;
      if (item.type !== "audio" && item.type !== "video") continue;

      const mediaSrc = String(item?.details?.src || "").trim();
      const transcript = runtimeResults[mediaSrc];
      if (!transcript?.segments?.length) continue;

      const transcriptTrackId = `${TRANSCRIPT_TRACK_PREFIX}${track.id}`;
      for (const guideItem of createGuideItemsForMedia(
        item,
        transcript,
        currentGuideItems
      )) {
        desiredGuideItems[guideItem.id] = guideItem;
        if (!guidesByTrackId[transcriptTrackId]) guidesByTrackId[transcriptTrackId] = [];
        guidesByTrackId[transcriptTrackId].push(guideItem.id);
      }
    }
  }

  for (const guideId of Object.keys(currentGuideItems)) {
    if (!desiredGuideItems[guideId]) {
      delete nextTrackItemsMap[guideId];
    }
  }

  for (const [guideId, guideItem] of Object.entries(desiredGuideItems)) {
    nextTrackItemsMap[guideId] = guideItem;
  }

  const nextTracks: any[] = [];
  for (const track of baseTracks) {
    nextTracks.push(track);
    const transcriptTrackId = `${TRANSCRIPT_TRACK_PREFIX}${track.id}`;
    const transcriptItemIds = (guidesByTrackId[transcriptTrackId] || []).sort(
      (leftId, rightId) =>
        (desiredGuideItems[leftId]?.display?.from || 0) -
        (desiredGuideItems[rightId]?.display?.from || 0)
    );
    if (transcriptItemIds.length > 0) {
      nextTracks.push({
        id: transcriptTrackId,
        type: "caption",
        name: "Transcript",
        accepts: CAPTION_ACCEPTS,
        items: transcriptItemIds,
        magnetic: false,
        static: false,
        metadata: {
          transcriptGuideTrack: true,
          parentTrackId: track.id
        }
      });
    }
  }

  const nextTrackItemIds = [
    ...currentTrackItemIds.filter((id: string) => !currentGuideItems[id]),
    ...Object.keys(desiredGuideItems)
  ];

  const changed =
    JSON.stringify(currentTracks) !== JSON.stringify(nextTracks) ||
    JSON.stringify(currentTrackItemIds) !== JSON.stringify(nextTrackItemIds) ||
    JSON.stringify(currentTrackItemsMap) !== JSON.stringify(nextTrackItemsMap);

  return {
    changed,
    tracks: nextTracks,
    trackItemIds: nextTrackItemIds,
    trackItemsMap: nextTrackItemsMap,
    signaturePayload: {
      tracks: nextTracks,
      trackItemIds: nextTrackItemIds,
      guideItems: Object.values(desiredGuideItems).map((item) => ({
        id: item.id,
        display: item.display,
        text: item.details?.text,
        fontSize: item.details?.fontSize
      }))
    }
  };
}

function createGuideItemsForMedia(
  mediaItem: ITrackItem,
  transcript: TranscriptResult,
  currentGuideItems: Record<string, any>
): GuideItem[] {
  const trimFrom = Number(mediaItem?.trim?.from || 0) / 1000;
  const trimTo =
    Number(
      mediaItem?.trim?.to ||
        mediaItem?.duration ||
        Math.max(0, mediaItem.display.to - mediaItem.display.from)
    ) / 1000;
  const clipDisplayFrom = Number(mediaItem.display.from || 0);

  return transcript.segments.flatMap((segment, index) => {
    const overlapStart = Math.max(trimFrom, Number(segment.start || 0));
    const overlapEnd = Math.min(trimTo, Number(segment.end || 0));
    if (overlapEnd <= overlapStart) return [];

    const id = `${TRANSCRIPT_ITEM_PREFIX}${mediaItem.id}:${index}`;
    const currentItem = currentGuideItems[id];
    const displayFrom = clipDisplayFrom + (overlapStart - trimFrom) * 1000;
    const displayTo = clipDisplayFrom + (overlapEnd - trimFrom) * 1000;
    const width = Math.max(220, (displayTo - displayFrom) / 3);
    const defaultFontSize = currentItem?.details?.fontSize || 22;

    return [
      {
        id,
        type: "caption",
        name: "transcript",
        isMain: false,
        display: {
          from: displayFrom,
          to: displayTo
        },
        metadata: {
          sourceUrl: mediaItem?.details?.src || "",
          parentId: mediaItem.id,
          transcriptGuide: true,
          transcriptSegmentIndex: index
        },
        details: {
          appearedColor: "#F5E7BE",
          activeColor: "#FFFFFF",
          activeFillColor: "#7E12FF",
          color: "#E8DDBD",
          backgroundColor: "rgba(0,0,0,0.1)",
          borderColor: "rgba(255,255,255,0.08)",
          borderWidth: 1,
          text: String(segment.text || "").trim(),
          fontSize: defaultFontSize,
          width,
          fontFamily: "Inter",
          fontUrl: "",
          textAlign: "left",
          linesPerCaption: 2,
          words: normalizeSegmentWords(segment),
          top: "0px",
          left: "0px",
          height: 36,
          guideOnly: true
        }
      }
    ];
  });
}

function normalizeSegmentWords(segment: TranscriptSegment) {
  if (Array.isArray(segment.words) && segment.words.length > 0) {
    return segment.words.map((word) => ({
      word: word.word,
      start: word.start * 1000,
      end: word.end * 1000,
      confidence: 1
    }));
  }

  return [
    {
      word: segment.text,
      start: segment.start * 1000,
      end: segment.end * 1000,
      confidence: 1
    }
  ];
}
