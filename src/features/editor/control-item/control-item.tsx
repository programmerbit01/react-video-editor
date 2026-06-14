import React, { useEffect, useMemo, useState } from "react";
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
import BasicCaption from "./basic-caption";
import { MenuItem } from "../menu-item";
import useStore from "../store/use-store";
import useLayoutStore from "../store/use-layout-store";
import TranscriptPanel from "./transcript-panel";
import CaptionsPanel from "./captions-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { AudioLines, Captions, ImageIcon, Type, Video } from "lucide-react";

type TabDefinition = {
  value: string;
  label: string;
  features?: string[];
  transcript?: boolean;
  captions?: boolean;
};

const TAB_CONFIG: Record<string, TabDefinition[]> = {
  text: [
    { value: "content", label: "Content", features: ["textPreset", "textControls"] },
    { value: "motion", label: "Motion", features: ["animations"] },
    { value: "effects", label: "Effects", features: ["fontStroke", "fontShadow"] }
  ],
  caption: [
    { value: "content", label: "Content", features: ["captionPreset", "captionWords"] },
    { value: "style", label: "Style", features: ["textControls"] },
    { value: "colors", label: "Colors", features: ["captionColors"] },
    { value: "motion", label: "Motion", features: ["animations"] },
    { value: "effects", label: "Effects", features: ["fontStroke", "fontShadow"] },
    { value: "transcript", label: "Guided Text", transcript: true }
  ],
  image: [
    { value: "adjust", label: "Adjust", features: ["crop", "basic"] },
    { value: "motion", label: "Motion", features: ["animations"] },
    { value: "style", label: "Style", features: ["outline", "shadow"] }
  ],
  video: [
    { value: "adjust", label: "Adjust", features: ["crop", "basic"] },
    { value: "motion", label: "Motion", features: ["animations"] },
    { value: "style", label: "Style", features: ["outline", "shadow"] },
    { value: "transcript", label: "Guided Text", transcript: true },
    { value: "captions", label: "Captions", captions: true }
  ],
  audio: [
    { value: "audio", label: "Audio", features: ["volume", "speed"] },
    { value: "transcript", label: "Guided Text", transcript: true },
    { value: "captions", label: "Captions", captions: true }
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

const CaptionsTab = ({ trackItem }: { trackItem: ITrackItem }) => (
  <div className="rounded-[18px] bg-background/25 p-2">
    <CaptionsPanel trackItem={trackItem} />
  </div>
);

const SelectedTrackPanel = ({ trackItem }: { trackItem: ITrackItemAndDetails }) => {
  const tabs = TAB_CONFIG[trackItem.type] ?? [];
  const getDefaultTab = () => tabs[0]?.value ?? "content";
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
      <div className="border-b border-border/70 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--card),transparent_0%)_0%,color-mix(in_oklab,var(--card),var(--background)_35%)_100%)] px-4 py-4">
        <div className="mb-3 flex items-start gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-border/70 bg-background/80 shadow-sm">
            <Icon className="h-5 w-5 text-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <p className="truncate text-sm font-semibold text-foreground">{clipName}</p>
              <Badge variant="secondary" className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]">
                {meta.label}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">Selected clip controls</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {summary.map((item) => (
            <span
              key={item}
              className="rounded-full border border-border/60 bg-background/75 px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
            >
              {item}
            </span>
          ))}
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
        <div className="px-3 py-3">
          <TabsList className="h-auto w-full justify-start gap-1 rounded-2xl bg-background/45 p-1">
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="rounded-xl border-0 px-3 py-2 text-xs font-semibold shadow-none"
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden px-2 py-2">
          {tabs.map((tab) => (
            <TabsContent key={tab.value} value={tab.value} className="h-full">
              <div className="h-full overflow-y-auto rounded-[18px] bg-transparent">
                {tab.transcript ? (
                  <TranscriptTab trackItem={trackItem} />
                ) : tab.captions ? (
                  <CaptionsTab trackItem={trackItem} />
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

export const ControlItem = () => {
  const { activeIds, trackItemsMap, transitionsMap } = useStore();
  const [trackItem, setTrackItem] = useState<ITrackItem | null>(null);
  const { setTrackItem: setLayoutTrackItem } = useLayoutStore();

  useEffect(() => {
    if (activeIds.length === 1) {
      const [id] = activeIds;
      const item = trackItemsMap[id];
      if (item) {
        setTrackItem(item);
        setLayoutTrackItem(item);
      } else {
        console.log(transitionsMap[id]);
        setTrackItem(null);
        setLayoutTrackItem(null);
      }
    } else {
      setTrackItem(null);
      setLayoutTrackItem(null);
    }
  }, [activeIds, trackItemsMap, transitionsMap, setLayoutTrackItem]);

  if (!trackItem) {
    return <MenuItem />;
  }

  return <SelectedTrackPanel trackItem={trackItem} />;
};
