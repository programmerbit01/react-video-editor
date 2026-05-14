import useStore from "../store/use-store";
import { useEffect } from "react";
import { filter, subject } from "@designcombo/events";
import {
  PLAYER_PAUSE,
  PLAYER_PLAY,
  PLAYER_PREFIX,
  PLAYER_SEEK,
  PLAYER_SEEK_BY,
  PLAYER_TOGGLE_PLAY
} from "../constants/events";
import { LAYER_PREFIX, LAYER_SELECTION } from "@designcombo/state";
import { TIMELINE_SEEK, TIMELINE_PREFIX } from "@designcombo/timeline";
import { getSafeCurrentFrame } from "../utils/time";

const useTimelineEvents = () => {
  const { playerRef, fps, timeline, setState, trackItemsMap } = useStore();

  //handle player events
  useEffect(() => {
    const playerEvents = subject.pipe(
      filter(({ key }) => key.startsWith(PLAYER_PREFIX))
    );
    const timelineEvents = subject.pipe(
      filter(({ key }) => key.startsWith(TIMELINE_PREFIX))
    );

    const timelineEventsSubscription = timelineEvents.subscribe((obj) => {
      if (obj.key === TIMELINE_SEEK) {
        const time = obj.value?.payload?.time;
        if (playerRef?.current && typeof time === "number") {
          playerRef.current.seekTo((time / 1000) * fps);
        }
      }
    });
    const playerEventsSubscription = playerEvents.subscribe((obj) => {
      if (obj.key === PLAYER_SEEK) {
        const time = obj.value?.payload?.time;
        if (playerRef?.current && typeof time === "number") {
          playerRef.current.seekTo((time / 1000) * fps);
        }
      } else if (obj.key === PLAYER_PLAY) {
        playerRef?.current?.play();
      } else if (obj.key === PLAYER_PAUSE) {
        playerRef?.current?.pause();
      } else if (obj.key === PLAYER_TOGGLE_PLAY) {
        if (playerRef?.current?.isPlaying()) {
          playerRef.current.pause();
        } else {
          playerRef?.current?.play();
        }
      } else if (obj.key === PLAYER_SEEK_BY) {
        const frames = obj.value?.payload?.frames;
        if (playerRef?.current && typeof frames === "number") {
          const safeCurrentFrame = getSafeCurrentFrame(playerRef);
          playerRef.current.seekTo(Math.round(safeCurrentFrame) + frames);
        }
      }
    });

    return () => {
      playerEventsSubscription.unsubscribe();
      timelineEventsSubscription.unsubscribe();
    };
  }, [playerRef, fps]);

  // handle selection events
  useEffect(() => {
    const selectionEvents = subject.pipe(
      filter(({ key }) => key.startsWith(LAYER_PREFIX))
    );

    const selectionSubscription = selectionEvents.subscribe((obj) => {
      if (obj.key === LAYER_SELECTION) {
        const activeIds = obj.value?.payload.activeIds || [];
        setState({ activeIds });

        const firstSelectedId = activeIds[0];
        if (!firstSelectedId) return;
        const item = trackItemsMap?.[firstSelectedId];
        const fromMs = item?.display?.from;
        if (playerRef?.current && typeof fromMs === "number" && Number.isFinite(fromMs)) {
          playerRef.current.seekTo(Math.max(0, Math.round((fromMs / 1000) * fps)));
        }
      }
    });
    return () => selectionSubscription.unsubscribe();
  }, [timeline, trackItemsMap, playerRef, fps, setState]);
};

export default useTimelineEvents;
