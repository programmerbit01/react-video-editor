import { Button } from "@/components/ui/button";
import { useEffect } from "react";
import useStore from "../store/use-store";
import BasicCaption from "../control-item/basic-caption";
import { ICaption, ITrackItem } from "@designcombo/types";
import { dispatch } from "@designcombo/events";
import { EDIT_OBJECT } from "@designcombo/state";
import useLayoutStore from "../store/use-layout-store";

export const Captions = () => {
  const { tracks, trackItemsMap } = useStore();
  const { setTrackItem: setLayoutTrackItem } = useLayoutStore();

  // Collect all caption items via caption tracks
  const captionTracks = (tracks as any[]).filter(
    (t) => t.metadata?.captionTrack || t.type === "caption"
  );
  const allCaptionIds: string[] = captionTracks.flatMap((t) => t.items ?? []);
  const captionItems = allCaptionIds
    .map((id) => (trackItemsMap as any)[id])
    .filter(Boolean) as (ITrackItem & ICaption)[];

  const firstCaption = captionItems[0] ?? null;

  // FloatingControl (Preset picker, font picker) needs trackItem in layout store
  useEffect(() => {
    if (firstCaption) setLayoutTrackItem(firstCaption as any);
    return () => setLayoutTrackItem(null);
  }, [firstCaption?.id]);

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
