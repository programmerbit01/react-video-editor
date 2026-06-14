import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import useCaptionStyleStore, { CaptionStyle } from "../store/use-caption-style-store";

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

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">Global Caption Defaults</p>
        <p className="text-xs text-muted-foreground">
          Applied to all new clips. Override per-clip in the clip&apos;s Captions tab.
        </p>
      </div>

      <div className="space-y-4 rounded-2xl border border-border/40 bg-card/30 p-4">
        {/* Font size */}
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

        <ColorSwatch
          label="Text color"
          value={style.color}
          onChange={(v) => setStyle({ color: v })}
        />
        <ColorSwatch
          label="Active word color"
          value={style.activeColor}
          onChange={(v) => setStyle({ activeColor: v })}
        />
        <ColorSwatch
          label="Highlight color"
          value={style.activeFillColor}
          onChange={(v) => setStyle({ activeFillColor: v })}
        />

        {/* Position */}
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
};
