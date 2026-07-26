import { IAudio } from "@designcombo/types";
import { BaseSequence, SequenceItemOptions } from "../base-sequence";
import { Audio as RemotionAudio } from "remotion";
import { makeVolumeFn } from "../../utils/volume-envelope";

export default function Audio({
  item,
  options
}: {
  item: IAudio;
  options: SequenceItemOptions;
}) {
  const { fps } = options;
  const { details } = item;
  const playbackRate = item.playbackRate || 1;
  const trimFromMs = item.trim?.from ?? 0;
  const trimToMs = item.trim?.to ?? Math.max(item.display.to - item.display.from, 1);
  const startFrom = Math.max(0, Math.round((trimFromMs / 1000) * fps));
  const endAt = Math.max(startFrom + 1, Math.round((trimToMs / 1000) * fps));
  // Volume: a flat number, or a per-frame curve when the clip has a volume envelope.
  const durationInFrames = Math.max(1, Math.round(((item.display.to - item.display.from) / 1000) * fps));
  const volume = makeVolumeFn({
    keyframes: (details as any).volumeKeyframes,
    volume: details.volume,
    muted: options.isMuted,
    durationInFrames,
  });
  const children = (
    <RemotionAudio
      startFrom={startFrom}
      endAt={endAt}
      playbackRate={playbackRate}
      src={details.src}
      volume={volume}
    />
  );
  return BaseSequence({ item, options, children });
}
