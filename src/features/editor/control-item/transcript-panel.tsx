import { useEffect, useRef, useState } from "react";
import { ITrackItem } from "@designcombo/types";
import { dispatch } from "@designcombo/events";
import { ACTIVE_SPLIT } from "@designcombo/state";
import { getStateManagerRef } from "../utils/state-manager-ref";
import { generateId } from "@/utils/id";
import { ScissorsLineDashed, SquareSplitHorizontal } from "lucide-react";
import useCaptionTranscribeStore, {
  TranscriptResult,
  TranscriptSegment
} from "../captions/transcribe-store";
import useUploadStore from "../store/use-upload-store";
import useStore from "../store/use-store";
import { useCurrentPlayerFrame } from "../hooks/use-current-frame";
import { PLAYER_SEEK } from "../constants/events";
import useTranscriptGuideStore from "../store/use-transcript-guide-store";

const formatSeconds = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  return [hours, minutes, secs]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
};

const formatRange = (segment: TranscriptSegment) =>
  `${formatSeconds(segment.start)} - ${formatSeconds(segment.end)}`;

const formatSegmentDuration = (segment: TranscriptSegment) => {
  const duration = Math.max(0, segment.end - segment.start);
  return `${duration.toFixed(duration < 10 ? 1 : 0)}s`;
};

const getVappParams = () => {
  if (typeof window === "undefined") return { vappHost: "", token: "", baseUrl: "" };
  const p = new URLSearchParams(window.location.search);
  return {
    vappHost: p.get("vappHost") || `${window.location.protocol}//${window.location.hostname}`,
    token: p.get("token") || "",
    baseUrl: p.get("baseUrl") || "https://api.muapi.ai",
  };
};

export const getTrackTranscript = (
  trackItem?: ITrackItem | null,
  runtimeResults?: Record<string, TranscriptResult>
) => {
  if (!trackItem) return null;
  const mediaSrc = String(trackItem?.details?.src || "").trim();
  const metadataTranscript = trackItem?.metadata?.transcriptData as TranscriptResult | undefined;
  if (mediaSrc && runtimeResults?.[mediaSrc]) return runtimeResults[mediaSrc];
  if (metadataTranscript?.segments?.length) return metadataTranscript;
  return null;
};

export default function TranscriptPanel({
  trackItem
}: {
  trackItem?: ITrackItem | null;
}) {
  const { resultsByMedia, setTranscriptResult } = useCaptionTranscribeStore();
  const { uploads } = useUploadStore();
  const { playerRef, fps } = useStore();
  const { selectedGuide, selectGuide } = useTranscriptGuideStore();
  const [loading, setLoading] = useState(false);
  const [splitEvery, setSplitEvery] = useState(1);
  const [arrange, setArrange] = useState(true);
  const activeWordRef = useRef<HTMLSpanElement | null>(null);

  const currentFrame = useCurrentPlayerFrame(playerRef || null);

  const mediaSrc = String((trackItem as any)?.details?.src || "").trim();

  // 1. runtime (manual Transcribe button) or metadata.transcriptData
  let transcript = getTrackTranscript(trackItem, resultsByMedia);

  // 2. upload store match by URL
  if (!transcript && mediaSrc) {
    const match = uploads.find((u: any) => (u.metadata?.uploadedUrl || u.url || "") === mediaSrc);
    if (match?.stt?.segments?.length) transcript = match.stt as TranscriptResult;
  }

  // 3. fetch on-demand from /api/vapp/stt
  useEffect(() => {
    const isVappMedia = mediaSrc.includes("rpublic.tomtap.ai") || mediaSrc.includes("/api/proxy?url=");
    if (transcript || !mediaSrc || !isVappMedia) return;
    const { vappHost, token, baseUrl } = getVappParams();
    setLoading(true);
    fetch(
      `${vappHost}/api/vapp/stt?token=${encodeURIComponent(token)}&baseUrl=${encodeURIComponent(baseUrl)}&url=${encodeURIComponent(mediaSrc)}`
    )
      .then((r) => r.json())
      .then((data) => {
        if (data?.stt?.segments?.length) setTranscriptResult(mediaSrc, data.stt);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [mediaSrc]);

  // Compute media-relative time in seconds
  const safeDisplayFrom = Number((trackItem as any)?.display?.from || 0);
  const safeTrimFrom = Number((trackItem as any)?.trim?.from || 0);
  const currentTimeMs = currentFrame * (1000 / (fps || 30));
  const mediaTimeSec = (currentTimeMs - safeDisplayFrom + safeTrimFrom) / 1000;

  // Find active segment and word indices
  let activeSegmentIdx = -1;
  let activeWordIdx = -1;
  if (transcript?.segments) {
    for (let si = 0; si < transcript.segments.length; si++) {
      const seg = transcript.segments[si];
      if (mediaTimeSec >= seg.start && mediaTimeSec <= seg.end) {
        activeSegmentIdx = si;
        if (seg.words?.length) {
          for (let wi = 0; wi < seg.words.length; wi++) {
            const w = seg.words[wi];
            if (mediaTimeSec >= w.start && mediaTimeSec <= w.end) {
              activeWordIdx = wi;
              break;
            }
          }
          // If between words, use the last passed word
          if (activeWordIdx === -1) {
            for (let wi = seg.words.length - 1; wi >= 0; wi--) {
              if (mediaTimeSec >= seg.words[wi].start) {
                activeWordIdx = wi;
                break;
              }
            }
          }
        }
        break;
      }
    }
  }

  // Auto-scroll active word into view
  useEffect(() => {
    if (activeWordRef.current) {
      activeWordRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeSegmentIdx, activeWordIdx]);

  const seekToSegment = (segment: TranscriptSegment) => {
    const segStartMs = segment.start * 1000;
    const clipTimeMs = safeDisplayFrom - safeTrimFrom + segStartMs;
    dispatch(PLAYER_SEEK, { payload: { time: clipTimeMs } });
  };

  const selectSegmentGuide = (segment: TranscriptSegment, segmentIndex: number) => {
    if (!trackItem?.id) return;
    const segmentStartMs = Math.max(
      safeDisplayFrom,
      safeDisplayFrom - safeTrimFrom + segment.start * 1000
    );
    const displayTo = Number((trackItem as any)?.display?.to || segmentStartMs);
    const segmentEndMs = Math.min(
      displayTo,
      safeDisplayFrom - safeTrimFrom + segment.end * 1000
    );

    selectGuide({
      itemId: trackItem.id,
      segmentIndex,
      startMs: segmentStartMs,
      endMs: segmentEndMs,
      defaultEndMs: segmentEndMs
    });
  };

  const splitAtSegmentEnd = (
    event: React.MouseEvent<HTMLButtonElement>,
    segment: TranscriptSegment,
    segmentIndex: number
  ) => {
    event.stopPropagation();
    selectSegmentGuide(segment, segmentIndex);
    const segmentEndMs = Math.min(
      Number((trackItem as any)?.display?.to || 0),
      safeDisplayFrom - safeTrimFrom + segment.end * 1000
    );
    dispatch(PLAYER_SEEK, { payload: { time: segmentEndMs } });
    dispatch(ACTIVE_SPLIT, {
      payload: {},
      options: {
        time: segmentEndMs
      }
    });
  };

  const splitBySegments = () => {
    if (!trackItem || !transcript?.segments?.length) return;

    const sm = getStateManagerRef();
    if (!sm) return;

    const segments = transcript.segments;
    const clipId = (trackItem as any)?.id;
    const originalTrackId = (trackItem as any)?.trackId;
    const originalFrom = safeDisplayFrom;
    const originalTo = Number((trackItem as any)?.display?.to || 0);
    const isAudio = (trackItem as any)?.type === "audio";

    // Collect split times
    const splitTimes: number[] = [];
    for (let i = splitEvery - 1; i < segments.length - 1; i += splitEvery) {
      const time = Math.min(
        originalTo,
        originalFrom - safeTrimFrom + segments[i].end * 1000
      );
      splitTimes.push(time);
    }
    if (splitTimes.length === 0) return;

    // Build boundaries: [displayFrom, T1, T2, ..., displayTo]
    const boundaries = [originalFrom, ...splitTimes, originalTo];

    // Read the EXACT clip from stateManager (not the possibly-stale component prop)
    const state = sm.getState();
    const sourceClip = state.trackItemsMap[clipId] as any;
    if (!sourceClip) return;

    const originalTrimFrom = Number(sourceClip.trim?.from ?? 0);

    // Build resulting clips — first keeps original ID, rest get new IDs
    let cursor = arrange ? originalFrom : null;
    const resultClips: any[] = [];

    for (let i = 0; i < boundaries.length - 1; i++) {
      const dFrom = boundaries[i];
      const dTo   = boundaries[i + 1];
      const dur   = dTo - dFrom;

      // Positions after arrange
      const arrangedFrom = cursor !== null ? cursor : dFrom;
      const arrangedTo   = arrangedFrom + dur;
      if (cursor !== null) cursor += isAudio ? dur : dur * 2;

      const trimOffset = dFrom - originalFrom; // ms into the original clip
      const clip: any = {
        ...sourceClip,
        id: i === 0 ? clipId : generateId(8),
        display: { from: arrangedFrom, to: arrangedTo }
      };

      if (sourceClip.type === "video" || sourceClip.type === "audio") {
        clip.trim = {
          from: originalTrimFrom + trimOffset,
          to:   originalTrimFrom + trimOffset + dur
        };
      }

      resultClips.push(clip);
    }

    // Update trackItemsMap — replace original, add new clips
    const newTrackItemsMap = { ...state.trackItemsMap };
    const newTrackItemIds  = [...state.trackItemIds];

    for (const clip of resultClips) {
      newTrackItemsMap[clip.id] = clip;
      if (!newTrackItemIds.includes(clip.id)) newTrackItemIds.push(clip.id);
    }

    // Update the track's items list — insert new IDs right after the original
    const newTracks = state.tracks.map((track: any) => {
      if (track.id !== originalTrackId) return track; // leave other tracks untouched
      const items: string[] = [...track.items];
      const idx = items.indexOf(clipId);
      if (idx === -1) return track;
      const newIds = resultClips.map((c: any) => c.id);
      items.splice(idx, 1, ...newIds);
      return { ...track, items };
    });

    sm.updateState(
      { trackItemsMap: newTrackItemsMap, trackItemIds: newTrackItemIds, tracks: newTracks },
      { updateHistory: true }
    );
  };

  if (!trackItem) return null;

  if (loading && !transcript) {
    return (
      <div className="px-4 py-4">
        <p className="text-xs text-muted-foreground">Loading transcript…</p>
      </div>
    );
  }

  if (!transcript?.segments?.length) return null;

  return (
    <div className="px-4 py-4">
      {/* Split by segments — above the Guided Text header, red border to distinguish */}
      <div className="mb-4 flex flex-col gap-2 rounded-2xl border border-red-500/60 bg-red-500/5 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Split after every</span>
          <input
            type="number"
            min={1}
            max={transcript.segments.length}
            value={splitEvery}
            onChange={(e) =>
              setSplitEvery(Math.max(1, parseInt(e.target.value) || 1))
            }
            className="w-12 rounded-lg bg-background/60 px-1.5 py-1 text-center text-xs text-foreground outline-none"
          />
          <span className="flex-1 text-[11px] text-muted-foreground">segments</span>
          <button
            type="button"
            onClick={splitBySegments}
            className="rounded-lg bg-violet-500/20 px-3 py-1 text-[11px] font-semibold text-violet-300 transition hover:bg-violet-500/35"
          >
            Split
          </button>
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={arrange}
            onChange={(e) => setArrange(e.target.checked)}
            className="h-3.5 w-3.5 rounded accent-violet-500"
          />
          <span className="text-[11px] text-muted-foreground">
            Arrange clips with equal spacing
          </span>
        </label>
      </div>

      <div className="mb-3 flex items-center justify-between gap-3 px-1 py-1">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-background/60 text-muted-foreground">
            <ScissorsLineDashed className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-semibold text-foreground">Guided Text</h3>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
          <span className="rounded-full bg-background/55 px-2.5 py-1">
            {transcript.language?.toUpperCase() || "—"}
          </span>
          <span className="rounded-full bg-background/55 px-2.5 py-1">
            {transcript.segment_count || transcript.segments.length} segments
          </span>
        </div>
      </div>

      <div className="mb-3 rounded-2xl bg-card/30 px-4 py-3 text-sm leading-6 text-foreground/90">
        {transcript.text}
      </div>

      <div className="space-y-2.5">
        {transcript.segments.map((segment, si) => {
          const isActiveSegment = si === activeSegmentIdx;
          const isSelectedGuide =
            selectedGuide?.itemId === trackItem.id &&
            selectedGuide?.segmentIndex === si;
          const hasWords = segment.words && segment.words.length > 0;

          return (
            <div
              key={`${trackItem.id}-segment-${si}`}
              className={`cursor-pointer rounded-2xl px-3 py-3 transition-all ${
                isActiveSegment || isSelectedGuide
                  ? "bg-violet-500/10 shadow-[inset_0_0_0_1px_rgba(139,92,246,0.7)]"
                  : "bg-card/20 hover:bg-card/35"
              }`}
              onClick={() => {
                selectSegmentGuide(segment, si);
                seekToSegment(segment);
              }}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded-lg bg-background/60 text-muted-foreground transition hover:bg-background/80 hover:text-foreground"
                    onClick={(event) => splitAtSegmentEnd(event, segment, si)}
                    title="Split clip at guided text end"
                  >
                    <SquareSplitHorizontal className="h-3.5 w-3.5" />
                  </button>
                  <div className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground">
                    {formatRange(segment)}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-medium text-muted-foreground">
                  <span className="rounded-full bg-background/60 px-2 py-0.5">
                    {formatSegmentDuration(segment)}
                  </span>
                  {hasWords && (
                    <span className="rounded-full bg-background/60 px-2 py-0.5">
                      {segment.words!.length} words
                    </span>
                  )}
                </div>
              </div>
              <div className="text-sm leading-6">
                {hasWords ? (
                  segment.words!.map((word, wi) => {
                    const isActiveWord = isActiveSegment && wi === activeWordIdx;
                    return (
                      <span
                        key={wi}
                        ref={isActiveWord ? activeWordRef : null}
                        className={`rounded-md px-0.5 py-0.5 transition-colors ${
                          isActiveWord
                            ? "bg-violet-500 text-white"
                            : isActiveSegment
                            ? "text-foreground/90"
                            : "text-foreground/60"
                        }`}
                      >
                        {word.word}{wi < segment.words!.length - 1 ? " " : ""}
                      </span>
                    );
                  })
                ) : (
                  <span
                    ref={isActiveSegment ? activeWordRef : null}
                    className={isActiveSegment ? "text-foreground/90" : "text-foreground/60"}
                  >
                    {segment.text}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
