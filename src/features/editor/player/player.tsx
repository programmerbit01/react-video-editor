import { useEffect, useMemo, useRef, useState } from "react";
import Composition from "./composition";
import { Player as RemotionPlayer, PlayerRef } from "@remotion/player";
import { prefetch } from "remotion";
import useStore from "../store/use-store";

const Player = () => {
  const playerRef = useRef<PlayerRef>(null);
  const { setPlayerRef, duration, fps, size, background, trackItemsMap } = useStore();

  // On a slow connection the media prefetch (blob-url) and OffthreadVideo buffering can take
  // many seconds, during which the player is just black — which reads as "it's broken /
  // hung" with no way to tell. These two flags drive a small overlay so the user knows it's
  // loading, not dead. `preparing` = the initial media prefetch is still in flight;
  // `buffering` = the player stalled waiting for data mid-playback.
  const [preparing, setPreparing] = useState(false);
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

  // Prefetch all video/audio sources as blob URLs so OffthreadVideo seeks
  // instantly when the playhead crosses a clip boundary (eliminates inter-clip stutter).
  const mediaSrcs = useMemo(
    () =>
      [
        ...new Set(
          Object.values(trackItemsMap)
            .filter(
              (item) =>
                (item.type === "video" || item.type === "audio") &&
                (item.details as any)?.src
            )
            .map((item) => (item.details as any).src as string)
        ),
      ].sort(),
    [trackItemsMap]
  );
  // Key the prefetch on the URLs themselves, NOT on trackItemsMap. Restyling a caption,
  // applying a preset or nudging Ken Burns all rewrite trackItemsMap without touching a single
  // media file — and re-running this tore down every prefetch (aborting in-flight requests)
  // and re-downloaded every clip from scratch. Mid-edit the preview went black, the network
  // saturated, and the aborted requests surfaced as "Failed to fetch", which reads like a CORS
  // fault and isn't one. Re-fetch only when the set of media actually changes.
  const mediaKey = mediaSrcs.join("\n");

  useEffect(() => {
    if (!mediaSrcs.length) {
      setPreparing(false);
      return;
    }
    let cancelled = false;
    let remaining = mediaSrcs.length;
    setPreparing(true);
    const settle = () => {
      remaining -= 1;
      if (!cancelled && remaining <= 0) setPreparing(false);
    };
    const cleanups = mediaSrcs.map((src) => {
      try {
        const { free, waitUntilDone } = prefetch(src, { method: "blob-url" });
        // prefetch() builds its promise eagerly and rejects it on a failed fetch AND on free().
        // Nothing was attached to it, so every teardown logged an *unhandled* rejection. The
        // try/catch here only ever guarded the synchronous call. `.finally` also clears the
        // "preparing" overlay whether the fetch succeeded or failed — a failed prefetch must
        // not leave the overlay stuck forever.
        waitUntilDone().catch(() => {}).finally(settle);
        return free;
      } catch {
        settle();
        return () => {};
      }
    });

    return () => {
      cancelled = true;
      cleanups.forEach((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaKey]);

  const showOverlay = preparing || buffering;

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
      {showOverlay ? (
        <div
          // Non-interactive: never eats a click meant for the canvas below.
          style={{ pointerEvents: "none" }}
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/45"
        >
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/25 border-t-white/90" />
          <div className="text-xs font-medium text-white/80">
            {preparing ? "Loading media…" : "Buffering…"}
          </div>
        </div>
      ) : null}
    </div>
  );
};
export default Player;
