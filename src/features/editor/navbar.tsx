import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { dispatch } from "@designcombo/events";
import { HISTORY_UNDO, HISTORY_REDO, DESIGN_RESIZE, DESIGN_LOAD } from "@designcombo/state";
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
  Save,
  ShareIcon,
  Trash2
} from "lucide-react";
import { Label } from "@/components/ui/label";

import type StateManager from "@designcombo/state";
import useStore from "./store/use-store";
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
import { SaveProjectModal } from "./save-project-modal";
import {
  getSavedProjects,
  saveProject,
  updateProject,
  deleteProject,
  type SavedProject,
} from "./utils/project-storage";

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
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [isProjectsOpen, setIsProjectsOpen] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  // tracks which saved project is currently loaded (null = unsaved / new)
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);

  useEffect(() => {
    setSavedProjects(getSavedProjects());
  }, [isProjectsOpen]);

  const handleUndo = () => dispatch(HISTORY_UNDO);
  const handleRedo = () => dispatch(HISTORY_REDO);

  const debouncedSetProjectName = useCallback(
    debounce((name: string) => {
      setProjectName(name);
    }, 2000),
    []
  );

  useEffect(() => {
    debouncedSetProjectName(title);
  }, [title, debouncedSetProjectName]);

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTitle(e.target.value);
  };

  const triggerSaveSuccess = () => {
    setSaveSuccess(true);
    setSavedProjects(getSavedProjects());
    setTimeout(() => setSaveSuccess(false), 2000);
  };

  const handleSaveProject = (name: string) => {
    const data = stateManager.toJSON() as Record<string, unknown>;
    if (currentProjectId) {
      // update existing project
      updateProject(currentProjectId, name, data);
    } else {
      // create new project and remember its id
      const saved = saveProject(name, data);
      setCurrentProjectId(saved.id);
    }
    setTitle(name);
    setProjectName(name);
    triggerSaveSuccess();
  };

  const handleLoadProject = (project: SavedProject) => {
    dispatch(DESIGN_LOAD, { payload: project.data });
    setTitle(project.name);
    setProjectName(project.name);
    setCurrentProjectId(project.id);
    setIsProjectsOpen(false);
  };

  const handleDeleteProject = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    deleteProject(id);
    if (currentProjectId === id) setCurrentProjectId(null);
    setSavedProjects(getSavedProjects());
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

      {/* Left: logo + undo/redo */}
      <div className="flex items-center gap-2">
        <div className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-md invert dark:invert-0">
          <LogoIcons.scenify />
        </div>
        <div className="pointer-events-auto flex h-10 items-center px-1.5">
          <Button onClick={handleUndo} className="text-muted-foreground" variant="ghost" size="icon">
            <Icons.undo width={20} />
          </Button>
          <Button onClick={handleRedo} className="text-muted-foreground" variant="ghost" size="icon">
            <Icons.redo width={20} />
          </Button>
        </div>
      </div>

      {/* Center: editable title + saved-projects dropdown arrow + save button */}
      <div className="flex h-13 items-center justify-center gap-2">
        {!isSmallScreen && (
          <Popover open={isProjectsOpen} onOpenChange={setIsProjectsOpen}>
            <div className="pointer-events-auto flex h-9 items-center gap-0.5 rounded-md border border-transparent px-1 hover:border-border/60 transition-colors">
              <AutosizeInput
                name="title"
                value={title}
                onChange={handleTitleChange}
                width={160}
                inputClassName="border-none outline-none px-1 text-sm font-medium bg-transparent"
              />
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground shrink-0"
                  title="Saved projects"
                >
                  <ChevronDown className="size-3.5" />
                </Button>
              </PopoverTrigger>
            </div>

            <PopoverContent align="center" className="z-[250] w-72 p-2" sideOffset={6}>
              <p className="mb-2 px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Saved Projects
              </p>
              {savedProjects.length === 0 ? (
                <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                  No saved projects yet
                </p>
              ) : (
                <div className="flex flex-col gap-0.5 max-h-72 overflow-y-auto">
                  {savedProjects.map((project) => {
                    const isActive = project.id === currentProjectId;
                    return (
                      <div
                        key={project.id}
                        onClick={() => handleLoadProject(project)}
                        className={`group flex items-center justify-between rounded-md px-2 py-2 cursor-pointer transition-colors ${
                          isActive ? "bg-accent" : "hover:bg-accent"
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className={`truncate text-sm font-medium ${isActive ? "text-foreground" : ""}`}>
                            {project.name}
                            {isActive && (
                              <span className="ml-2 text-xs text-muted-foreground font-normal">(current)</span>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(project.savedAt).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                          onClick={(e) => handleDeleteProject(e, project.id)}
                          title="Delete"
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </PopoverContent>
          </Popover>
        )}
        {!isSmallScreen && (
          <Button
            variant={saveSuccess ? "default" : "outline"}
            size="sm"
            className="pointer-events-auto h-8 gap-1.5 border border-border rounded-full transition-colors"
            onClick={() => setIsSaveModalOpen(true)}
            title="Save project"
          >
            <Save className="size-3.5" />
            {saveSuccess ? "Saved!" : "Save Project"}
          </Button>
        )}
      </div>

      {/* Right: theme + shortcuts + download */}
      <div className="flex h-13 items-center justify-end gap-2">
        <div className="pointer-events-auto flex h-10 items-center gap-2 rounded-md px-2.5">
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

          <DownloadPopover stateManager={stateManager} />
        </div>
      </div>

      <ShortcutsModal open={isShortcutsModalOpen} onOpenChange={setIsShortcutsModalOpen} />
      <SaveProjectModal
        open={isSaveModalOpen}
        onOpenChange={setIsSaveModalOpen}
        defaultName={title}
        onSave={handleSaveProject}
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
  "1080p": "1080p — High quality",
  "720p":  "720p — Standard",
  "540p":  "540p — Small file",
  "2k":    "2K — Ultra quality",
};

const DownloadPopover = ({ stateManager }: { stateManager: StateManager }) => {
  const isMediumScreen = useIsMediumScreen();
  const { actions, exportType, exportQuality, exportResolution } = useDownloadState();
  const { size } = useStore();
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
        <div className="flex items-center justify-between">
          <Label>Export settings</Label>
          <span className="text-xs text-muted-foreground">
            Canvas: {size.width}×{size.height}
          </span>
        </div>

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
