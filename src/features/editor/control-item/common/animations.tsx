import { Button } from "@/components/ui/button";
import { ChevronDown, Zap } from "lucide-react";
import { IText, ITrackItem } from "@designcombo/types";
import { Label } from "@/components/ui/label";
import useLayoutStore from "../../store/use-layout-store";
import { useIsLargeScreen } from "@/hooks/use-media-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import useStore from "../../store/use-store";
import { createPresetButtons } from "../floating-controls/animation-picker";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AnimationDuration } from "./animation-duration";
import { presets } from "../../player/animated";
import type { PresetName } from "../../player/animated/presets";
import { dispatch } from "@designcombo/events";
import { EDIT_OBJECT } from "@designcombo/state";
import { Easing } from "remotion";

interface PresetTextProps {
  trackItem: ITrackItem & any;
  properties: any;
}

function getAnimationParts(animations: any): { label: string; dur: string }[] {
  if (!animations) return [];
  const parts: { label: string; dur: string }[] = [];
  const types = ["in", "loop", "out"] as const;
  for (const t of types) {
    const anim = animations[t];
    const name = anim?.name as PresetName | undefined;
    if (name && presets[name]) {
      const displayName = presets[name].name;
      const label = `${displayName} ${t.charAt(0).toUpperCase() + t.slice(1)}`;
      const frames: number = anim?.composition?.[0]?.durationInFrames ?? 0;
      const durS = frames > 0 ? (frames / 30).toFixed(1) + "s" : "";
      parts.push({ label, dur: durS });
    }
  }
  return parts;
}

const QUICK_FADE_FRAMES = 9; // 0.3s at 30fps

function applyQuickFade(activeId: string) {
  if (!activeId) return;
  dispatch(EDIT_OBJECT, {
    payload: {
      [activeId]: {
        animations: {
          in: {
            name: "fadeIn",
            composition: [{
              property: "opacity",
              from: 0,
              to: 1,
              durationInFrames: QUICK_FADE_FRAMES,
              easing: "linear",
              ease: Easing.linear,
            }],
          },
          out: {
            name: "fadeOut",
            composition: [{
              property: "opacity",
              from: 1,
              to: 0,
              durationInFrames: QUICK_FADE_FRAMES,
              easing: "linear",
              ease: Easing.linear,
            }],
          },
        },
      },
    },
  });
}

export const Animations = ({ properties, trackItem }: PresetTextProps) => {
  return (
    <div className="flex flex-col gap-2 py-4">
      <Label className="font-sans text-xs font-semibold">Animations</Label>
      <SelectaAnimation trackItem={trackItem} />
    </div>
  );
};

const SelectaAnimation = ({ trackItem }: { trackItem: ITrackItem & IText }) => {
  const { setFloatingControl } = useLayoutStore();
  const isLargeScreen = useIsLargeScreen();
  const { activeIds, trackItemsMap } = useStore();

  const currentItem = trackItemsMap[activeIds[0]];
  const animParts = getAnimationParts(currentItem?.animations);
  const hasAnimation = animParts.length > 0;

  const animationType = trackItem.type === "text" ? "text" : "media";

  const presetInButtons = createPresetButtons(
    (key) => key.includes("In"),
    "in",
    activeIds,
    animationType,
    trackItemsMap
  );
  const presetOutButtons = createPresetButtons(
    (key) => key.includes("Out"),
    "out",
    activeIds,
    animationType,
    trackItemsMap
  );
  const presetLoopButtons = createPresetButtons(
    (key) => key.includes("Loop"),
    "loop",
    activeIds,
    animationType,
    trackItemsMap
  );

  return (
    <div className="flex gap-2 py-0 flex-col lg:flex-col">
      {isLargeScreen && (
        <Button
          className="flex h-7 w-full items-center gap-1.5 text-xs"
          variant="outline"
          onClick={() => applyQuickFade(activeIds[0])}
          title="Apply Fade In + Fade Out (0.3s each) — most used by YouTubers"
        >
          <Zap size={11} className="text-yellow-500 fill-yellow-500" />
          Quick Fade
          <span className="text-muted-foreground text-[10px]">(0.3s)</span>
        </Button>
      )}
      <div className="flex gap-2 flex-row">
        <div className="flex-1 items-center text-sm text-muted-foreground hidden lg:flex">
          Custom
        </div>
        {isLargeScreen ? (
        <div className="relative w-44">
          <Button
            className="flex min-h-9 h-auto w-full items-start justify-between text-sm py-1.5 px-2"
            variant={hasAnimation ? "default" : "secondary"}
            onClick={() => setFloatingControl("animation-picker")}
          >
            <div className="w-full text-left flex flex-col gap-0.5">
              {hasAnimation ? (
                animParts.map((p, i) => (
                  <p key={i} className="text-xs leading-tight">
                    {p.label}
                    {p.dur && (
                      <span className="ml-1 opacity-70 text-[10px]">({p.dur})</span>
                    )}
                  </p>
                ))
              ) : (
                <p className="text-xs">None</p>
              )}
            </div>
            <ChevronDown className="text-muted-foreground shrink-0 mt-0.5" size={14} />
          </Button>
        </div>
      ) : (
        <div className="flex w-full flex-col gap-6">
          <Tabs defaultValue="in" className="w-full">
            <TabsList className="p-0 grid w-full grid-cols-3">
              <TabsTrigger value="in">
                In{currentItem?.animations?.in ? " ●" : ""}
              </TabsTrigger>
              <TabsTrigger value="loop">
                Loop{currentItem?.animations?.loop ? " ●" : ""}
              </TabsTrigger>
              <TabsTrigger value="out">
                Out{currentItem?.animations?.out ? " ●" : ""}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="in">
              <ScrollArea className="h-[300px]">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(100px,1fr))] gap-2 py-4">
                  {presetInButtons}
                </div>
              </ScrollArea>
            </TabsContent>
            <TabsContent value="loop">
              <ScrollArea className="h-[300px]">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(100px,1fr))] gap-2 py-4">
                  {presetLoopButtons}
                </div>
              </ScrollArea>
            </TabsContent>
            <TabsContent value="out">
              <ScrollArea className="h-[300px]">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(100px,1fr))] gap-2 py-4">
                  {presetOutButtons}
                </div>
              </ScrollArea>
            </TabsContent>
          </Tabs>
          <AnimationDuration />
        </div>
      )}
      </div>
    </div>
  );
};
