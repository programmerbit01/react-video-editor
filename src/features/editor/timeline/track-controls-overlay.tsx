import { Eye, EyeOff, Volume2, VolumeX } from "lucide-react";
import { ITrack } from "@designcombo/types";
import useStore from "../store/use-store";
import useTrackVisibilityStore from "../store/use-track-visibility-store";

// Must match sizesMap in timeline.tsx
const ROW_H: Record<string, number> = {
  caption: 32,
  text: 32,
  audio: 36,
  linealAudioBars: 40,
  radialAudioBars: 40,
  waveAudioBars: 40,
  hillAudioBars: 40
};
// Canvas renderTracks starts at top: -970 + 1000 = 30, with 8px helper gaps between rows
const CANVAS_TRACK_OFFSET_Y = 30;
const CANVAS_TRACK_GAP = 8;

const rowH = (type: string) => ROW_H[type] ?? 40;

// Only show controls for media tracks that produce visible/audible output
const isMediaTrack = (type: string) =>
  type === "video" || type === "audio" || type === "image" ||
  type === "linealAudioBars" || type === "radialAudioBars" ||
  type === "waveAudioBars" || type === "hillAudioBars";

const canMute = (type: string) =>
  type === "video" || type === "audio" || type === "linealAudioBars" ||
  type === "radialAudioBars" || type === "waveAudioBars" || type === "hillAudioBars";

export default function TrackControlsOverlay() {
  const { tracks } = useStore();
  const { hidden, muted, toggleHidden, toggleMuted } = useTrackVisibilityStore();

  // cumY starts at CANVAS_TRACK_OFFSET_Y to match canvas internal track positioning
  let cumY = CANVAS_TRACK_OFFSET_Y;

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none select-none">
      {(tracks as ITrack[]).map((track, i) => {
        const h = rowH(track.type as string);
        const top = cumY;
        // Add row height + inter-track gap (gap is between rows, not after last)
        cumY += h + (i < tracks.length - 1 ? CANVAS_TRACK_GAP : 0);

        if (!isMediaTrack(track.type as string)) return null;

        const isHidden = !!hidden[track.id];
        const isMuted = !!muted[track.id];
        const showMute = canMute(track.type as string);

        return (
          <div
            key={track.id}
            className="absolute left-0 flex items-center justify-center gap-1 pointer-events-auto"
            style={{ top, height: h, width: "32px" }}
          >
            {showMute ? (
              <button
                type="button"
                onClick={() => toggleMuted(track.id)}
                title={isMuted ? "Unmute" : "Mute"}
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors ${
                  isMuted
                    ? "bg-red-500/20 text-red-400"
                    : "text-zinc-600 hover:bg-zinc-700 hover:text-zinc-200"
                }`}
              >
                {isMuted ? <VolumeX size={10} /> : <Volume2 size={10} />}
              </button>
            ) : (
              <span className="h-4 w-4 shrink-0" />
            )}

            <button
              type="button"
              onClick={() => toggleHidden(track.id)}
              title={isHidden ? "Show" : "Hide"}
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors ${
                isHidden
                  ? "bg-yellow-500/20 text-yellow-400"
                  : "text-zinc-600 hover:bg-zinc-700 hover:text-zinc-200"
              }`}
            >
              {isHidden ? <EyeOff size={10} /> : <Eye size={10} />}
            </button>
          </div>
        );
      })}
    </div>
  );
}
