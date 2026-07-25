import { useEffect, useRef, useState } from "react";
import Composition from "./composition";
import { Player as RemotionPlayer, PlayerRef } from "@remotion/player";
import useStore from "../store/use-store";

const Player = () => {
  const playerRef = useRef<PlayerRef>(null);
  const { setPlayerRef, duration, fps, size, background } = useStore();

  // YouTube-style streaming — we do NOT pre-download clips.
  //
  // OffthreadVideo renders as a real <video> in the interactive player, so it streams each
  // clip over HTTP range requests and plays the buffered portion immediately — exactly what
  // "open the clip's url in a new browser tab" does (which is instant). The old code called
  // prefetch(src, { method: "blob-url" }) for EVERY video AND audio clip on the timeline,
  // which downloaded each FULL file (tens of MB) as a blob before the player would show a
  // single frame — and fired them all in parallel. On a slow/far CDN path that was minutes
  // of black screen per clip (the "click a card → 10 minutes loading" bug), even though the
  // very same url streams instantly in a new tab. Streaming shows frames as bytes arrive and
  // only fetches what playback actually needs, on demand.
  //
  // `buffering` = playback stalled waiting for bytes mid-clip (Remotion emits `waiting` /
  // `resume` on the player ref). That drives a small spinner — the only overlay we still
  // need, and it appears only while genuinely waiting, never as an upfront wall.
  const [buffering, setBuffering] = useState(false);

  useEffect(() => {
    setPlayerRef(playerRef as React.RefObject<PlayerRef>);
  }, []);

  // Buffering (mid-playback stall) — Remotion emits `waiting`/`resume` on the player ref.
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    const onWait = () => setBuffering(true);
    const onResume = () => setBuffering(false);
    p.addEventListener("waiting", onWait);
    p.addEventListener("resume", onResume);
    return () => {
      p.removeEventListener("waiting", onWait);
      p.removeEventListener("resume", onResume);
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      <RemotionPlayer
        ref={playerRef}
        component={Composition}
        acknowledgeRemotionLicense
        durationInFrames={Math.round((duration / 1000) * fps) || 1}
        compositionWidth={size.width}
        compositionHeight={size.height}
        className={`h-full w-full bg-[${background.value}]`}
        fps={30}
        overflowVisible
        numberOfSharedAudioTags={10}
      />
      {buffering ? (
        <div
          // Non-interactive: never eats a click meant for the canvas below.
          style={{ pointerEvents: "none" }}
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/30"
        >
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/25 border-t-white/90" />
          <div className="text-xs font-medium text-white/80">Buffering…</div>
        </div>
      ) : null}
    </div>
  );
};
export default Player;
