import { useEffect, useRef, useState } from "react";
import { ITrackItem } from "@designcombo/types";
import { dispatch } from "@designcombo/events";
import useCaptionTranscribeStore, {
  TranscriptResult,
  TranscriptSegment
} from "../store/use-caption-transcribe-store";
import useUploadStore from "../store/use-upload-store";
import useStore from "../store/use-store";
import { useCurrentPlayerFrame } from "../hooks/use-current-frame";
import { PLAYER_SEEK } from "../constants/events";

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
  const [loading, setLoading] = useState(false);
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
    // Fetch STT for any vapp media URL — either direct CDN or proxied
    const isVappMedia = mediaSrc.includes("/api/proxy?url=") || mediaSrc.includes("rpublic.tomtap.ai");
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

  if (!trackItem) return null;

  if (loading && !transcript) {
    return (
      <div className="border-t border-border/70 px-5 py-4">
        <p className="text-xs text-muted-foreground">Loading transcript…</p>
      </div>
    );
  }

  if (!transcript?.segments?.length) return null;

  return (
    <div className="border-t border-border/70 px-5 py-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Transcript</h3>
          <p className="text-xs text-muted-foreground">
            {transcript.language?.toUpperCase() || "—"} ·{" "}
            {transcript.segment_count || transcript.segments.length} segments
          </p>
        </div>
      </div>

      <div className="mb-3 rounded-md border border-border/60 bg-card/40 p-3 text-sm leading-6 text-foreground/90">
        {transcript.text}
      </div>

      <div className="space-y-2">
        {transcript.segments.map((segment, si) => {
          const isActiveSegment = si === activeSegmentIdx;
          const hasWords = segment.words && segment.words.length > 0;

          return (
            <div
              key={`${trackItem.id}-segment-${si}`}
              className={`rounded-md border p-3 cursor-pointer transition-colors ${
                isActiveSegment
                  ? "border-violet-500/60 bg-violet-500/10"
                  : "border-border/50 bg-card/30 hover:bg-card/50"
              }`}
              onClick={() => seekToSegment(segment)}
            >
              <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground">
                {formatRange(segment)}
              </div>
              <div className="text-sm leading-6">
                {hasWords ? (
                  segment.words!.map((word, wi) => {
                    const isActiveWord = isActiveSegment && wi === activeWordIdx;
                    return (
                      <span
                        key={wi}
                        ref={isActiveWord ? activeWordRef : null}
                        className={`transition-colors ${
                          isActiveWord
                            ? "bg-violet-500 text-white rounded px-0.5"
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
