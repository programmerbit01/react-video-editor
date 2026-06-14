import { useEffect, useState } from "react";
import { ITrackItem } from "@designcombo/types";
import useCaptionTranscribeStore, {
  TranscriptResult,
  TranscriptSegment
} from "../store/use-caption-transcribe-store";
import useUploadStore from "../store/use-upload-store";

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
  const { resultsByMedia } = useCaptionTranscribeStore();
  const { uploads } = useUploadStore();
  const [fetchedStt, setFetchedStt] = useState<TranscriptResult | null>(null);
  const [loading, setLoading] = useState(false);

  const mediaSrc = String((trackItem as any)?.details?.src || "").trim();

  // Check runtime + metadata first
  let transcript = getTrackTranscript(trackItem, resultsByMedia);

  // Check upload store by URL match
  if (!transcript && mediaSrc) {
    const match = uploads.find((u: any) => {
      const uUrl = u.metadata?.uploadedUrl || u.url || "";
      return uUrl === mediaSrc;
    });
    if (match?.stt?.segments?.length) transcript = match.stt as TranscriptResult;
  }

  // Use directly fetched stt as last fallback
  if (!transcript && fetchedStt?.segments?.length) transcript = fetchedStt;

  // Fetch from /api/vapp/stt when no transcript found and mediaSrc is a proxy URL
  useEffect(() => {
    if (transcript || !mediaSrc || !mediaSrc.includes("/api/proxy?url=")) return;
    const { vappHost, token, baseUrl } = getVappParams();
    setLoading(true);
    fetch(
      `${vappHost}/api/vapp/stt?token=${encodeURIComponent(token)}&baseUrl=${encodeURIComponent(baseUrl)}&url=${encodeURIComponent(mediaSrc)}`
    )
      .then((r) => r.json())
      .then((data) => {
        console.log("[TranscriptPanel] /api/vapp/stt response", data);
        if (data?.stt?.segments?.length) setFetchedStt(data.stt);
      })
      .catch((e) => console.warn("[TranscriptPanel] stt fetch failed", e))
      .finally(() => setLoading(false));
  }, [mediaSrc]);

  if (!trackItem) return null;

  if (loading) {
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
