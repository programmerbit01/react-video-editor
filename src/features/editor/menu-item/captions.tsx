import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import useCaptionStyleStore from "../store/use-caption-style-store";
import useStore from "../store/use-store";
import BasicCaption from "../control-item/basic-caption";
import { ICaption, ITrackItem } from "@designcombo/types";
import { dispatch } from "@designcombo/events";
import { EDIT_OBJECT } from "@designcombo/state";

export const Captions = () => {
  const { tracks, trackItemsMap } = useStore();

  // Collect all caption items via caption tracks
  const captionTracks = (tracks as any[]).filter(
    (t) => t.metadata?.captionTrack || t.type === "caption"
  );
  const allCaptionIds: string[] = captionTracks.flatMap((t) => t.items ?? []);
  const captionItems = allCaptionIds
    .map((id) => (trackItemsMap as any)[id])
    .filter(Boolean) as (ITrackItem & ICaption)[];

  const firstCaption = captionItems[0] ?? null;

  const applyToAll = () => {
    if (!firstCaption || captionItems.length <= 1) return;
    const { words, text, top, left, width, height, ...styleDetails } =
      (firstCaption as any).details ?? {};
    const payload: Record<string, any> = {};
    for (const item of captionItems) {
      if (item.id !== firstCaption.id) payload[item.id] = { details: styleDetails };
    }
    if (Object.keys(payload).length > 0) dispatch(EDIT_OBJECT, { payload });
  };

  if (!firstCaption) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-6 text-center h-40">
        <p className="text-sm text-muted-foreground">
          No captions yet.
        </p>
        <p className="text-xs text-muted-foreground/70">
          Select a video clip → Captions tab → Generate &amp; Apply.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {captionItems.length > 1 && (
        <div className="flex shrink-0 items-center justify-between px-4 pt-3 pb-1">
          <p className="text-xs text-muted-foreground">
            {captionItems.length} captions
          </p>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={applyToAll}>
            Apply style to all
          </Button>
        </div>
      )}
      <BasicCaption trackItem={firstCaption} />
    </div>
  );
};
