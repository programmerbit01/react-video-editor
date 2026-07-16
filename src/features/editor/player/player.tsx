import { useEffect, useMemo, useRef } from "react";
import Composition from "./composition";
import { Player as RemotionPlayer, PlayerRef } from "@remotion/player";
import { prefetch } from "remotion";
import useStore from "../store/use-store";

const Player = () => {
  const playerRef = useRef<PlayerRef>(null);
  const { setPlayerRef, duration, fps, size, background, trackItemsMap } = useStore();

  useEffect(() => {
    setPlayerRef(playerRef as React.RefObject<PlayerRef>);
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
    const cleanups = mediaSrcs.map((src) => {
      try {
        const { free, waitUntilDone } = prefetch(src, { method: "blob-url" });
        // prefetch() builds its promise eagerly and rejects it on a failed fetch AND on free().
        // Nothing was attached to it, so every teardown logged an *unhandled* rejection. The
        // try/catch here only ever guarded the synchronous call.
        waitUntilDone().catch(() => {});
        return free;
      } catch {
        return () => {};
      }
    });

    return () => cleanups.forEach((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaKey]);

  return (
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
  );
};
export default Player;
