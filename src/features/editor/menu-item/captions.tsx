import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import useCaptionStyleStore from "../store/use-caption-style-store";
import useStore from "../store/use-store";
import BasicCaption from "../control-item/basic-caption";
import { ICaption, ITrackItem } from "@designcombo/types";
import { dispatch } from "@designcombo/events";
import { EDIT_OBJECT } from "@designcombo/state";

function ColorSwatch({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <label className="relative flex h-8 w-full cursor-pointer items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-2 hover:bg-background/80">
        <span
          className="h-4 w-4 shrink-0 rounded-md border border-border/60"
          style={{ backgroundColor: value }}
        />
        <span className="text-xs font-mono text-muted-foreground">{value}</span>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}

export const Captions = () => {
  const style = useCaptionStyleStore();
  const { setStyle } = style;
  const { tracks, trackItemsMap } = useStore();

  // Collect all caption items via caption tracks (same pattern as captions-panel.tsx)
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

  // No captions yet — show defaults panel
  if (!firstCaption) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">Caption Defaults</p>
          <p className="text-xs text-muted-foreground">
            Applied when you generate captions on a clip.
          </p>
        </div>

        <div className="space-y-4 rounded-2xl border border-border/40 bg-card/30 p-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Font size</Label>
              <span className="text-xs font-medium tabular-nums">{style.fontSize}px</span>
            </div>
            <Slider
              min={14}
              max={56}
              step={1}
              value={[style.fontSize]}
              onValueChange={([v]) => setStyle({ fontSize: v })}
            />
          </div>
          <ColorSwatch label="Text color" value={style.color} onChange={(v) => setStyle({ color: v })} />
          <ColorSwatch label="Active word color" value={style.activeColor} onChange={(v) => setStyle({ activeColor: v })} />
          <ColorSwatch label="Highlight color" value={style.activeFillColor} onChange={(v) => setStyle({ activeFillColor: v })} />
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Default position</Label>
            <div className="grid grid-cols-3 gap-1">
              {(["top", "center", "bottom"] as const).map((pos) => (
                <button
                  key={pos}
                  type="button"
                  onClick={() => setStyle({ position: pos })}
                  className={`rounded-lg py-1.5 text-xs font-medium capitalize transition-colors ${
                    style.position === pos
                      ? "bg-primary text-primary-foreground"
                      : "bg-background/60 text-muted-foreground hover:bg-background"
                  }`}
                >
                  {pos}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Captions exist — show full style controls (inline, scrollable)
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between px-4 pt-4 pb-2">
        <p className="text-sm font-semibold text-foreground">
          Caption Style
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            ({captionItems.length})
          </span>
        </p>
        {captionItems.length > 1 && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={applyToAll}>
            Apply to all
          </Button>
        )}
      </div>
      <ScrollArea className="flex-1">
        {/* captionPreset uses right-sidebar floating control — not usable here */}
        {/* captionWords restructures captions destructively — skip in global context */}
        <BasicCaption
          trackItem={firstCaption}
          excludeKeys={["captionPreset", "captionWords"]}
          inline
        />
      </ScrollArea>
    </div>
  );
};
