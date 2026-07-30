import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  IAudio,
  ICaption,
  IImage,
  IText,
  ITrackItem,
  ITrackItemAndDetails,
  IVideo
} from "@designcombo/types";
import BasicText from "./basic-text";
import BasicImage from "./basic-image";
import BasicVideo from "./basic-video";
import BasicAudio from "./basic-audio";
import BasicCaption from "../captions/style";
import { MenuItem } from "../menu-item";
import useStore from "../store/use-store";
import useLayoutStore from "../store/use-layout-store";
import TranscriptPanel from "./transcript-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { AudioLines, Captions, ImageIcon, Type, Video } from "lucide-react";

type TabDefinition = {
  value: string;
  label: string;
  features?: string[];
  transcript?: boolean;
  /** Render BasicCaption whole (no `type` → showAll) instead of slicing it across tabs. */
  fullCaption?: boolean;
};

const TAB_CONFIG: Record<string, TabDefinition[]> = {
  text: [
    { value: "content", label: "Content", features: ["textPreset", "textControls"] },
    { value: "motion", label: "Motion", features: ["animations"] },
    { value: "effects", label: "Effects", features: ["fontStroke", "fontShadow"] }
  ],
  // ONE tab, rendering BasicCaption whole — the exact panel the left Captions menu shows.
  // Slicing it across Content/Style/Colors/Motion/Effects meant Preset lived on one tab and
  // Words on another, so styling a caption always cost extra clicks and the two entry points
  // disagreed about what "the caption panel" even looked like. Guided Text is dropped here on
  // purpose: a caption has no media of its own to transcribe, so that tab rendered empty
  // (media clips keep theirs).
  caption: [{ value: "caption", label: "Caption", fullCaption: true }],
  image: [
    { value: "adjust", label: "Adjust", features: ["crop", "basic"] },
    { value: "motion", label: "Motion", features: ["animations"] },
    { value: "style", label: "Style", features: ["outline", "shadow"] }
  ],
  video: [
    { value: "adjust", label: "Adjust", features: ["crop", "basic"] },
    { value: "audio", label: "Audio", features: ["volume", "speed", "envelope"] },
    { value: "motion", label: "Motion", features: ["animations"] },
    { value: "style", label: "Style", features: ["outline", "shadow"] },
    { value: "transcript", label: "Guided Text", transcript: true }
  ],
  audio: [
    { value: "audio", label: "Audio", features: ["volume", "speed", "envelope"] },
    { value: "transcript", label: "Guided Text", transcript: true }
  ]
};

const TYPE_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  text: { label: "Text", icon: Type },
  caption: { label: "Captions", icon: Captions },
  image: { label: "Image", icon: ImageIcon },
  video: { label: "Video", icon: Video },
  audio: { label: "Audio", icon: AudioLines }
};

const formatDuration = (trackItem: ITrackItem) => {
  const from = Number((trackItem as any)?.display?.from || 0);
  const to = Number((trackItem as any)?.display?.to || 0);
  const totalMs = Math.max(0, to - from);
  const seconds = Math.round(totalMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
};

const renderFeature = (trackItem: ITrackItemAndDetails, feature: string) => {
  switch (trackItem.type) {
    case "text":
      return <BasicText key={feature} trackItem={trackItem as ITrackItem & IText} type={feature} />;
    case "caption":
      return <BasicCaption key={feature} trackItem={trackItem as ITrackItem & ICaption} type={feature} />;
    case "image":
      return <BasicImage key={feature} trackItem={trackItem as ITrackItem & IImage} type={feature} />;
    case "video":
      if (feature === "volume" || feature === "speed" || feature === "envelope") {
        return <BasicAudio key={feature} trackItem={trackItem as any} type={feature} />;
      }
      return <BasicVideo key={feature} trackItem={trackItem as ITrackItem & IVideo} type={feature} />;
    case "audio":
      return <BasicAudio key={feature} trackItem={trackItem as ITrackItem & IAudio} type={feature} />;
    default:
      return null;
  }
};

const TranscriptTab = ({ trackItem }: { trackItem: ITrackItem }) => (
  <div className="rounded-[18px] bg-background/25 p-2">
    <TranscriptPanel trackItem={trackItem} />
    <div className="px-2 py-6 text-center text-sm text-muted-foreground empty:hidden" />
  </div>
);

// No `type` prop → BasicCaption renders showAll, i.e. the same full Preset/Words/Animations/
// Colors list the left Captions menu puts up. One panel, one place it can differ: nowhere.
const CaptionStyleTab = ({ trackItem }: { trackItem: ITrackItemAndDetails }) => (
  <BasicCaption trackItem={trackItem as ITrackItem & ICaption} />
);

const SelectedTrackPanel = ({
  trackItem,
  multiCount = 1
}: {
  trackItem: ITrackItemAndDetails;
  multiCount?: number;
}) => {
  const isMulti = multiCount > 1;
  const tabs = TAB_CONFIG[trackItem.type] ?? [];
  const getDefaultTab = () => {
    // Images open on Motion — Ken Burns / animations are what you reach for first on a still.
    if (trackItem.type === "image" && tabs.some((t) => t.value === "motion")) return "motion";
    return (tabs.find((t) => t.transcript)?.value ?? tabs[0]?.value) ?? "content";
  };
  const [activeTab, setActiveTab] = useState(getDefaultTab());

  useEffect(() => {
    setActiveTab(getDefaultTab());
  }, [trackItem.id, trackItem.type]);

  const meta = TYPE_META[trackItem.type] ?? TYPE_META.video;
  const Icon = meta.icon;
  const clipName = String(trackItem.details?.name || trackItem.name || meta.label).trim();
  const summary = useMemo(
    () => [
      meta.label,
      formatDuration(trackItem),
      trackItem.details?.src ? "Linked media" : "Design layer"
    ],
    [meta.label, trackItem]
  );

  return (
    <div className="hidden h-full w-full flex-col bg-card lg:flex">
      <div className="border-b border-border/70 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/80">
            <Icon className="h-3.5 w-3.5 text-foreground" />
          </div>
          <p className="truncate text-xs font-semibold text-foreground">
            {isMulti ? `${multiCount} ${meta.label.toLowerCase()} clips` : clipName}
          </p>
          <Badge variant="secondary" className="shrink-0 rounded-full px-1.5 py-0 text-[9px] uppercase tracking-[0.1em]">
            {meta.label}
          </Badge>
          <div className="flex shrink-0 items-center gap-1 ml-auto">
            {isMulti ? (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">
                edits apply to all
              </span>
            ) : (
              summary.slice(1).map((item) => (
                <span key={item} className="rounded-full border border-border/60 bg-background/75 px-2 py-0.5 text-[10px] text-muted-foreground">
                  {item}
                </span>
              ))
            )}
          </div>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
        {/* A lone tab is just a label on top of the only thing there is — captions land here. */}
        {tabs.length > 1 && (
          <div className="px-2 py-2">
            <TabsList className="h-auto w-full justify-start gap-0.5 rounded-2xl bg-background/45 p-1 flex-wrap">
              {tabs.map((tab) => (
                <TabsTrigger
                  key={tab.value}
                  value={tab.value}
                  className="rounded-lg border-0 px-2 py-1.5 text-[11px] font-semibold shadow-none"
                >
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-hidden px-2 py-2">
          {tabs.map((tab) => (
            <TabsContent key={tab.value} value={tab.value} className="h-full">
              <div className="h-full overflow-y-auto rounded-[18px] bg-transparent">
                {tab.transcript ? (
                  <TranscriptTab trackItem={trackItem} />
                ) : tab.fullCaption ? (
                  <CaptionStyleTab trackItem={trackItem} />
                ) : (
                  <div className="space-y-0">
                    {tab.features?.map((feature) => renderFeature(trackItem, feature))}
                  </div>
                )}
              </div>
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </div>
  );
};

// The selection reduced to ONE unified panel: a representative clip + how many are selected. Multi
// only when every selected clip shares a type (a whole-row select — rows are one type) so the panel
// makes sense and its edits (which fan out via editSelected) apply cleanly. Mixed types → no panel.
function selectedRepresentative(
  activeIds: string[],
  trackItemsMap: Record<string, ITrackItem>
): { item: ITrackItem | null; count: number } {
  if (!activeIds.length) return { item: null, count: 0 };
  const first = trackItemsMap[activeIds[0]];
  if (!first) return { item: null, count: 0 };
  const allSame = activeIds.every((id) => trackItemsMap[id]?.type === first.type);
  return allSame ? { item: first, count: activeIds.length } : { item: null, count: 0 };
}

export const PropertiesPanel = () => {
  const { activeIds, trackItemsMap } = useStore();
  const { item, count } = selectedRepresentative(activeIds, trackItemsMap);
  if (!item) return null;
  return <SelectedTrackPanel trackItem={item as ITrackItemAndDetails} multiCount={count} />;
};

export const ControlItem = () => {
  const { activeIds, trackItemsMap, transitionsMap } = useStore();
  const { setTrackItem: setLayoutTrackItem } = useLayoutStore();
  const { item, count } = selectedRepresentative(activeIds, trackItemsMap);

  // `layout.trackItem` is a single global slot the floating pickers read. Only OWN it for a single
  // selection (multi has no one "current" clip); release it when we stop holding it — nulling it
  // blindly would close whatever picker another surface opened.
  const heldItemRef = useRef<string | null>(null);
  useEffect(() => {
    const single = activeIds.length === 1 ? trackItemsMap[activeIds[0]] : undefined;
    if (single) {
      heldItemRef.current = single.id;
      setLayoutTrackItem(single);
      return;
    }
    if (useLayoutStore.getState().trackItem?.id === heldItemRef.current) {
      heldItemRef.current = null;
      setLayoutTrackItem(null);
    }
  }, [activeIds, trackItemsMap, transitionsMap, setLayoutTrackItem]);

  if (!item) return <MenuItem />;
  return <SelectedTrackPanel trackItem={item as ITrackItemAndDetails} multiCount={count} />;
};
