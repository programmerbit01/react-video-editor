import { useCallback, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CircleOff } from "lucide-react";
import { loadFonts } from "../../utils/fonts";
import {
  ICaptionsControlProps,
  NONE_PRESET,
  STYLE_CAPTION_PRESETS,
  activePresetIdOf,
  getTextShadow
} from "../../captions/presets";

interface PresetItemProps {
  preset: ICaptionsControlProps;
  onClick: () => void;
  isActive?: boolean;
}

// Preset fonts are fetched ONE at a time, on hover, and never twice per session.
//
// There are 216 presets across 159 gstatic fonts. Loading them by viewport proximity still put
// ~10 font requests in flight the moment the picker opened, and on a slow link that starves the
// fetches Remotion is making for the project's own media — the timeline audio dies with a bare
// "Failed to fetch" that Remotion then reports as a CORS problem, sending you after a CORS bug
// that does not exist. Hovering is the only signal that a specific preset is worth bandwidth.
// Module-level: the grid remounts on every panel open.
const requestedFonts = new Set<string>();

/**
 * Draws the preset live, from its own fields, instead of fetching a thumbnail.
 *
 * The previews used to be <img>/<video> off cdn.designcombo.dev — which now 403s, so all 216
 * tiles rendered as broken-image icons and presets could only be chosen blind. Everything the
 * preview needs (colours, stroke, shadow, font) is already on the preset object, and drawing
 * it here is strictly better than the thumbnails were: exact rather than a stale render, no
 * network, and it can never rot again. Shows all three word states a caption cycles through —
 * appeared → active → upcoming — because that IS what a preset defines.
 */
const PresetItem = ({ preset, onClick, isActive }: PresetItemProps) => {
  const [fontReady, setFontReady] = useState(() =>
    Boolean(preset.fontFamily && requestedFonts.has(preset.fontFamily))
  );

  const loadFontOnce = useCallback(() => {
    const { fontFamily, fontUrl } = preset;
    if (!fontFamily || !fontUrl || requestedFonts.has(fontFamily)) return;
    requestedFonts.add(fontFamily);
    loadFonts([{ name: fontFamily, url: fontUrl }])
      .then(() => setFontReady(true))
      .catch(() => {});
  }, [preset.fontFamily, preset.fontUrl]);

  const stroke =
    preset.borderWidth && preset.borderColor && preset.borderColor !== "transparent"
      ? `1px ${preset.borderColor}`
      : undefined;
  const wordStyle = {
    // Until this tile has been hovered its face hasn't been fetched, so naming it would just
    // render the browser's fallback anyway. The colours/stroke/shadow — what actually tells the
    // presets apart — are correct from the first paint either way.
    fontFamily: fontReady ? preset.fontFamily : undefined,
    paintOrder: "stroke fill" as const,
    textShadow: getTextShadow(preset.boxShadow),
    WebkitTextStroke: stroke
  };

  return (
    <div
      onClick={onClick}
      onMouseEnter={loadFontOnce}
      onFocus={loadFontOnce}
      aria-selected={isActive}
      className={`flex h-[70px] cursor-pointer items-center justify-center overflow-hidden rounded-lg bg-zinc-800 px-2 ${
        isActive ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""
      }`}
      style={{
        backgroundColor:
          preset.backgroundColor !== "transparent" ? preset.backgroundColor : undefined
      }}
    >
      <div className="flex flex-wrap items-center justify-center gap-x-1.5 text-center text-sm font-bold leading-tight">
        <span style={{ ...wordStyle, color: preset.appearedColor ?? preset.color }}>Your</span>
        <span
          style={{
            ...wordStyle,
            color: preset.activeColor,
            backgroundColor:
              preset.activeFillColor !== "transparent" ? preset.activeFillColor : undefined,
            borderRadius: 3,
            padding: "0 3px"
          }}
        >
          caption
        </span>
        <span style={{ ...wordStyle, color: preset.color }}>here</span>
      </div>
    </div>
  );
};

interface PresetGridProps {
  presets: ICaptionsControlProps[];
  captionItemIds: string[];
  captionsData: any[];
  activePresetId?: string | null;
  onPresetClick: (
    preset: ICaptionsControlProps,
    captionItemIds: string[],
    captionsData: any[]
  ) => void;
}

const PresetGrid = ({
  presets,
  captionItemIds,
  captionsData,
  activePresetId,
  onPresetClick
}: PresetGridProps) => (
  <div className="grid gap-4 p-4">
    <div
      onClick={() => onPresetClick(NONE_PRESET, captionItemIds, captionsData)}
      aria-selected={!activePresetId}
      className={`flex h-[70px] cursor-pointer items-center justify-center bg-zinc-800 rounded-lg ${
        !activePresetId ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""
      }`}
    >
      <CircleOff />
    </div>

    {presets.map((preset, index) => (
      <PresetItem
        key={preset.id ?? index}
        preset={preset}
        isActive={!!preset.id && preset.id === activePresetId}
        onClick={() => onPresetClick(preset, captionItemIds, captionsData)}
      />
    ))}
  </div>
);

interface PresetPickerProps {
  captionItemIds: string[];
  captionsData: any[];
  onPresetClick: (
    preset: ICaptionsControlProps,
    captionItemIds: string[],
    captionsData: any[]
  ) => void;
  className?: string;
}

export const PresetPicker = ({
  captionItemIds,
  captionsData,
  onPresetClick,
  className = ""
}: PresetPickerProps) => {
  // Read the live preset off the captions themselves rather than tracking it in local state:
  // presets can also be applied from the other entry point, and this stays right either way.
  const activePresetId = activePresetIdOf(captionsData);
  const wordPresets = STYLE_CAPTION_PRESETS.filter(
    (preset) => preset.type === "word"
  );
  const linePresets = STYLE_CAPTION_PRESETS.filter(
    (preset) => preset.type !== "word"
  );

  return (
    <Tabs defaultValue="words" className={`w-full ${className}`}>
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="words">Words</TabsTrigger>
        <TabsTrigger value="lines">Lines</TabsTrigger>
      </TabsList>

      <ScrollArea className="h-[400px] w-full">
        <TabsContent value="words" className="mt-0">
          <PresetGrid
            presets={wordPresets}
            captionItemIds={captionItemIds}
            captionsData={captionsData}
            activePresetId={activePresetId}
            onPresetClick={onPresetClick}
          />
        </TabsContent>

        <TabsContent value="lines" className="mt-0">
          <PresetGrid
            presets={linePresets}
            captionItemIds={captionItemIds}
            captionsData={captionsData}
            activePresetId={activePresetId}
            onPresetClick={onPresetClick}
          />
        </TabsContent>
      </ScrollArea>
    </Tabs>
  );
};
