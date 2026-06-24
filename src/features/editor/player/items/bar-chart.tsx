import { ITrackItem } from "@designcombo/types";
import { AbsoluteFill, Sequence } from "remotion";
import { calculateFrames } from "../../utils/frames";
import { SequenceItemOptions } from "../base-sequence";
import BarChartComponent from "@/remotion/components/BarChart";

export default function BarChart({
  item,
  options
}: {
  item: ITrackItem;
  options: SequenceItemOptions;
}) {
  const { fps } = options;
  const { from, durationInFrames } = calculateFrames(item.display, fps);
  const props = (item as any).props || item.details || {};

  return (
    <Sequence key={item.id} from={from} durationInFrames={Math.max(1, durationInFrames)}>
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <BarChartComponent {...props} />
      </AbsoluteFill>
    </Sequence>
  );
}
