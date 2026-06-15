import { IAudio } from "@designcombo/types";
import { BaseSequence, SequenceItemOptions } from "../base-sequence";
import { Audio as RemotionAudio } from "remotion";

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
  const children = (
    <RemotionAudio
      startFrom={startFrom}
      endAt={endAt}
      playbackRate={playbackRate}
      src={details.src}
      volume={options.isMuted ? 0 : (details.volume ?? 100) / 100}
    />
  );
  return BaseSequence({ item, options, children });
}
