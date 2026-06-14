import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { dispatch } from "@designcombo/events";
import { HISTORY_UNDO, HISTORY_REDO, DESIGN_RESIZE } from "@designcombo/state";
import { Icons } from "@/components/shared/icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import {
  ChevronDown,
  Download,
  Keyboard,
  ProportionsIcon,
  ShareIcon
} from "lucide-react";
import { Label } from "@/components/ui/label";

import type StateManager from "@designcombo/state";
import { generateId } from "@designcombo/timeline";
import type { IDesign } from "@designcombo/types";
import { useDownloadState } from "./store/use-download-state";
import DownloadProgressModal from "./download-progress-modal";
import AutosizeInput from "@/components/ui/autosize-input";
import { debounce } from "lodash";
import {
  useIsLargeScreen,
  useIsMediumScreen,
  useIsSmallScreen
} from "@/hooks/use-media-query";

import { LogoIcons } from "@/components/shared/logos";
import Link from "next/link";
import { ShortcutsModal } from "./shortcuts-modal";
import { ModeToggle } from "@/components/ui/mode-toggle";

export default function Navbar({
  user,
  stateManager,
  setProjectName,
  projectName
}: {
  user: any | null;
  stateManager: StateManager;
  setProjectName: (name: string) => void;
  projectName: string;
}) {
  const [title, setTitle] = useState(projectName);
  const isLargeScreen = useIsLargeScreen();
  const isMediumScreen = useIsMediumScreen();
  const isSmallScreen = useIsSmallScreen();
  const [isShortcutsModalOpen, setIsShortcutsModalOpen] = useState(false);

  const handleUndo = () => {
    dispatch(HISTORY_UNDO);
  };

  const handleRedo = () => {
    dispatch(HISTORY_REDO);
  };

  const handleCreateProject = async () => {};

  // Create a debounced function for setting the project name
  const debouncedSetProjectName = useCallback(
    debounce((name: string) => {
      console.log("Debounced setProjectName:", name);
      setProjectName(name);
    }, 2000), // 2 seconds delay
    []
  );

  // Update the debounced function whenever the title changes
  useEffect(() => {
    debouncedSetProjectName(title);
  }, [title, debouncedSetProjectName]);

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTitle(e.target.value);
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: isLargeScreen ? "320px 1fr 320px" : "1fr 1fr 1fr"
      }}
      className="bg-card pointer-events-none flex h-13 items-center border-b border-border/80 px-2"
    >
      <DownloadProgressModal />

      <div className="flex items-center gap-2">
        <div className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-md invert dark:invert-0">
          <LogoIcons.scenify />
        </div>

        <div className=" pointer-events-auto flex h-10 items-center px-1.5">
          <Button
            onClick={handleUndo}
            className="text-muted-foreground"
            variant="ghost"
            size="icon"
          >
            <Icons.undo width={20} />
          </Button>
          <Button
            onClick={handleRedo}
            className="text-muted-foreground"
            variant="ghost"
            size="icon"
          >
            <Icons.redo width={20} />
          </Button>
        </div>
      </div>

      <div className="flex h-13 items-center justify-center gap-2">
        {!isSmallScreen && (
          <div className=" pointer-events-auto flex h-10 items-center gap-2 rounded-md px-2.5">
            <AutosizeInput
              name="title"
              value={title}
              onChange={handleTitleChange}
              width={200}
              inputClassName="border-none outline-none px-1 text-sm font-medium"
            />
          </div>
        )}
      </div>

      <div className="flex h-13 items-center justify-end gap-2">
        <div className=" pointer-events-auto flex h-10 items-center gap-2 rounded-md px-2.5">
          <div className="rounded-full border border-border/70 bg-background/80 p-0.5 shadow-sm">
            <ModeToggle />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={() => setIsShortcutsModalOpen(true)}
          >
            <Keyboard className="size-5" />
          </Button>

          {/* <Button
            className="flex h-8 gap-1 border border-border"
            variant="outline"
            size={isMediumScreen ? "sm" : "icon"}
          >
            <ShareIcon width={18} />{" "}
            <span className="hidden md:block">Share</span>
          </Button> */}

          <DownloadPopover stateManager={stateManager} />
        </div>
      </div>
      <ShortcutsModal
        open={isShortcutsModalOpen}
        onOpenChange={setIsShortcutsModalOpen}
      />
    </div>
  );
}

const EXPORT_TYPE_LABELS: Record<string, string> = {
  "mp4":            "MP4 — Custom quality",
  "fb-whatsapp":    "WhatsApp / FB  (480×896, 1.3Mbps)",
  "fb-web-highres": "FB Web High-res  (680×1274, 2.2Mbps)",
  "json":           "JSON (project file)",
};

const QUALITY_LABELS = {
  high:   "High — CRF 18 (near-lossless)",
  medium: "Medium — CRF 23",
  low:    "Low — CRF 28 (fast, small file)",
};
const RESOLUTION_LABELS = {
  "1080p": "1080p  (1080 × 1920)",
  "720p":  "720p   (720 × 1280)",
  "540p":  "540p   (540 × 960)",
  "2k":    "2K     (1440 × 2560)",
};

const DownloadPopover = ({ stateManager }: { stateManager: StateManager }) => {
  const isMediumScreen = useIsMediumScreen();
  const { actions, exportType, exportQuality, exportResolution } = useDownloadState();
  const [isExportTypeOpen, setIsExportTypeOpen] = useState(false);
  const [isQualityOpen, setIsQualityOpen] = useState(false);
  const [isResolutionOpen, setIsResolutionOpen] = useState(false);
  const [open, setOpen] = useState(false);

  const handleExport = () => {
    const data: IDesign = {
      id: generateId(),
      ...stateManager.toJSON()
    };

    actions.setState({ payload: data });
    actions.startExport();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          className="flex h-8 gap-1 border border-border rounded-full"
          size={isMediumScreen ? "sm" : "icon"}
        >
          {/* <Download width={18} />{" "} */}
          <span className="hidden md:block">Download</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="bg-sidebar z-[250] flex w-60 flex-col gap-4"
      >
        <Label>Export settings</Label>

        <Popover open={isExportTypeOpen} onOpenChange={setIsExportTypeOpen}>
          <PopoverTrigger asChild>
            <Button className="w-full justify-between" variant="outline">
              <div className="text-sm truncate">{EXPORT_TYPE_LABELS[exportType] ?? exportType.toUpperCase()}</div>
              <ChevronDown width={16} className="shrink-0" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="bg-background z-[251] w-[--radix-popover-trigger-width] px-2 py-2">
            {(Object.entries(EXPORT_TYPE_LABELS) as [string, string][]).map(([val, label]) => (
              <div
                key={val}
                className="flex min-h-7 items-center rounded-sm px-3 py-1 text-sm hover:cursor-pointer hover:bg-zinc-800"
                onClick={() => { actions.setExportType(val as any); setIsExportTypeOpen(false); }}
              >
                {label}
              </div>
            ))}
          </PopoverContent>
        </Popover>

        <Popover open={isResolutionOpen} onOpenChange={setIsResolutionOpen}>
          <PopoverTrigger asChild>
            <Button className="w-full justify-between" variant="outline">
              <div className="text-sm font-mono">{RESOLUTION_LABELS[exportResolution]}</div>
              <ChevronDown width={16} />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="bg-background z-[251] w-[--radix-popover-trigger-width] px-2 py-2">
            {(Object.keys(RESOLUTION_LABELS) as (keyof typeof RESOLUTION_LABELS)[]).map((r) => (
              <div
                key={r}
                className="flex h-7 items-center rounded-sm px-3 text-sm font-mono hover:cursor-pointer hover:bg-zinc-800"
                onClick={() => { actions.setExportResolution(r); setIsResolutionOpen(false); }}
              >
                {RESOLUTION_LABELS[r]}
              </div>
            ))}
          </PopoverContent>
        </Popover>

        <Popover open={isQualityOpen} onOpenChange={setIsQualityOpen}>
          <PopoverTrigger asChild>
            <Button className="w-full justify-between" variant="outline">
              <div className="text-sm">{QUALITY_LABELS[exportQuality]}</div>
              <ChevronDown width={16} />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="bg-background z-[251] w-[--radix-popover-trigger-width] px-2 py-2">
            {(["high", "medium", "low"] as const).map((q) => (
              <div
                key={q}
                className="flex h-7 items-center rounded-sm px-3 text-sm hover:cursor-pointer hover:bg-zinc-800"
                onClick={() => { actions.setExportQuality(q); setIsQualityOpen(false); }}
              >
                {QUALITY_LABELS[q]}
              </div>
            ))}
          </PopoverContent>
        </Popover>

        <div>
          <Button onClick={handleExport} className="w-full">
            Export
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

interface ResizeOptionProps {
  label: string;
  icon: string;
  value: ResizeValue;
  description: string;
}

interface ResizeValue {
  width: number;
  height: number;
  name: string;
}

const RESIZE_OPTIONS: ResizeOptionProps[] = [
  {
    label: "16:9",
    icon: "landscape",
    description: "YouTube ads",
    value: {
      width: 1920,
      height: 1080,
      name: "16:9"
    }
  },
  {
    label: "9:16",
    icon: "portrait",
    description: "TikTok, YouTube Shorts",
    value: {
      width: 1080,
      height: 1920,
      name: "9:16"
    }
  },
  {
    label: "1:1",
    icon: "square",
    description: "Instagram, Facebook posts",
    value: {
      width: 1080,
      height: 1080,
      name: "1:1"
    }
  }
];

const ResizeVideo = () => {
  const handleResize = (options: ResizeValue) => {
    dispatch(DESIGN_RESIZE, {
      payload: {
        ...options
      }
    });
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button className="z-10 h-7 gap-2" variant="outline" size={"sm"}>
          <ProportionsIcon className="h-4 w-4" />
          <div>Resize</div>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="z-[250] w-60 px-2.5 py-3">
        <div className="text-sm">
          {RESIZE_OPTIONS.map((option, index) => (
            <ResizeOption
              key={index}
              label={option.label}
              icon={option.icon}
              value={option.value}
              handleResize={handleResize}
              description={option.description}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};

const ResizeOption = ({
  label,
  icon,
  value,
  description,
  handleResize
}: ResizeOptionProps & { handleResize: (payload: ResizeValue) => void }) => {
  const Icon = Icons[icon as "text"];
  return (
    <div
      onClick={() => handleResize(value)}
      className="flex cursor-pointer items-center rounded-md p-2 hover:bg-zinc-50/10"
    >
      <div className="w-8 text-muted-foreground">
        <Icon size={20} />
      </div>
      <div>
        <div>{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
    </div>
  );
};
