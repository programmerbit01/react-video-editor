import { ITrackItem } from "@designcombo/types";
import useCaptionTranscribeStore, {
  TranscriptResult,
  TranscriptSegment
} from "../store/use-caption-transcribe-store";

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

export const getTrackTranscript = (
  trackItem?: ITrackItem | null,
  runtimeResults?: Record<string, TranscriptResult>
) => {
  if (!trackItem) return null;

  const mediaSrc = String(trackItem?.details?.src || "").trim();
  const metadataTranscript = trackItem?.metadata?.transcriptData as
    | TranscriptResult
    | undefined;

  if (mediaSrc && runtimeResults?.[mediaSrc]) return runtimeResults[mediaSrc];
  if (metadataTranscript?.segments?.length) return metadataTranscript;
  return null;
};

export default function TranscriptPanel({
  trackItem
}: {
  trackItem?: ITrackItem | null;
}) {
  const { resultsByMedia } = useCaptionTranscribeStore();
  const transcript = getTrackTranscript(trackItem, resultsByMedia);

  if (!trackItem || !transcript?.segments?.length) {
    return null;
  }

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
        {transcript.segments.map((segment, index) => (
          <div
            key={`${trackItem.id}-segment-${index}`}
            className="rounded-md border border-border/50 bg-card/30 p-3"
          >
            <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground">
              {formatRange(segment)}
            </div>
            <div className="text-sm leading-6 text-foreground/90">
              {segment.text}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
