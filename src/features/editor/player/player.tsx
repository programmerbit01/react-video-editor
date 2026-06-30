import { useEffect, useRef } from "react";
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
  useEffect(() => {
    const srcs = [
      ...new Set(
        Object.values(trackItemsMap)
          .filter(
            (item) =>
              (item.type === "video" || item.type === "audio") &&
              (item.details as any)?.src
          )
          .map((item) => (item.details as any).src as string)
      ),
    ];

    const cleanups = srcs.map((src) => {
      try {
        const { free } = prefetch(src, { method: "blob-url" });
        return free;
      } catch {
        return () => {};
      }
    });

    return () => cleanups.forEach((f) => f());
  }, [trackItemsMap]);

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
