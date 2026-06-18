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
import useScriptGuideStore, { ScriptSegment } from "./store/use-script-guide-store";
import { parseTimeToMs } from "./store/use-script-guide-store";
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
  const { rawJson, setSegments } = useScriptGuideStore();
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
    const data = {
      ...(stateManager.toJSON() as Record<string, unknown>),
      ...(rawJson ? { _guidedScript: rawJson } : {}),
    };
    if (currentProjectId) {
      updateProject(currentProjectId, name, data);
    } else {
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
    // restore guided script if saved
    const scriptRaw = project.data._guidedScript as string | undefined;
    if (scriptRaw) {
      try {
        const parsed = JSON.parse(scriptRaw);
        const arr: ScriptSegment[] = Array.isArray(parsed) ? parsed : parsed.segments;
        if (Array.isArray(arr) && arr.length) setSegments(arr, scriptRaw);
      } catch {}
    }
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
          <ScriptGuideButton />
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

const ENGINE_INFO: Record<string, { label: string; hint: string }> = {
  ffmpeg: { label: "FF", hint: "Fast — animations limited" },
  remotion: { label: "RE", hint: "All animations & transitions — slower" },
};

const DownloadPopover = ({ stateManager }: { stateManager: StateManager }) => {
  const isMediumScreen = useIsMediumScreen();
  const { actions, exportType, exportQuality, exportResolution, exportEngine } = useDownloadState();
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

        <div className="flex flex-col gap-1.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
            Export Engine
          </p>
          <div className="flex gap-1 rounded-md border border-border p-0.5">
            {(["ffmpeg", "remotion"] as const).map((e) => (
              <button
                key={e}
                onClick={() => actions.setExportEngine(e)}
                className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${
                  exportEngine === e
                    ? "bg-secondary text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {ENGINE_INFO[e].label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground leading-tight">
            {ENGINE_INFO[exportEngine].hint}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Button onClick={handleExport} className="w-full">
            Export Video
          </Button>
          <TimelineExportMenu stateManager={stateManager} />
        </div>
      </PopoverContent>
    </Popover>
  );
};

type TimelineFormat = "fcpx" | "premiere" | "resolve" | "otio";

const TIMELINE_FORMAT_LABELS: Record<TimelineFormat, string> = {
  fcpx: "Final Cut Pro (.fcpxml)",
  premiere: "Adobe Premiere (.xml)",
  resolve: "DaVinci Resolve (.xml)",
  otio: "OpenTimelineIO (.otio)",
};

const TimelineExportMenu = ({ stateManager }: { stateManager: StateManager }) => {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState("");
  const [mediaMode, setMediaMode] = useState<"remote" | "local">("remote");

  const handleTimelineExport = async (format: TimelineFormat) => {
    setOpen(false);
    setExporting(true);
    setExportProgress(mediaMode === "local" ? "Building timeline…" : "Exporting…");
    try {
      const design = { id: generateId(), ...stateManager.toJSON() };
      const res = await fetch("/api/export-timeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ design, format, mediaMode }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(`Timeline export failed: ${j?.message ?? res.status}`);
        return;
      }

      if (mediaMode === "local") {
        // Local mode: download media + package as ZIP
        const data = await res.json();
        const { xml, ext, projectName, mediaFiles } = data as {
          xml: string;
          ext: string;
          projectName: string;
          mediaFiles: Array<{ filename: string; url: string }>;
        };

        const JSZip = (await import("jszip")).default;
        const zip = new JSZip();
        const folder = zip.folder(projectName) ?? zip;
        folder.file(`project.${ext}`, xml);
        const mediaFolder = folder.folder("media") ?? folder;

        // Fetch via server proxy to avoid CORS issues with R2 URLs
        let done = 0;
        for (const { filename, url } of mediaFiles) {
          try {
            const proxyUrl = `/api/proxy?url=${encodeURIComponent(url)}`;
            const r = await fetch(proxyUrl);
            if (r.ok) mediaFolder.file(filename, await r.blob());
          } catch {}
          done++;
          setExportProgress(`Downloading media… ${done}/${mediaFiles.length}`);
        }

        setExportProgress("Zipping…");
        const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objUrl;
        a.download = `${projectName}.zip`;
        a.click();
        URL.revokeObjectURL(objUrl);
      } else {
        // Remote mode: direct file download
        const blob = await res.blob();
        const ext = format === "fcpx" ? "fcpxml" : format === "otio" ? "otio" : "xml";
        const projName = (stateManager.toJSON() as any)?.name?.trim() || "Vapp Export";
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objUrl;
        a.download = `${projName}.${ext}`;
        a.click();
        URL.revokeObjectURL(objUrl);
      }
    } catch (e) {
      alert(`Timeline export error: ${e}`);
    } finally {
      setExporting(false);
      setExportProgress("");
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-between text-xs" disabled={exporting}>
          <span>{exporting ? exportProgress || "Exporting…" : "Export Timeline"}</span>
          <ChevronDown width={14} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="bg-background z-[252] w-[--radix-popover-trigger-width] px-2 py-2">
        {/* Media mode toggle */}
        <div className="flex items-center gap-1.5 px-3 pb-2">
          <span className="text-[10px] text-muted-foreground mr-1">Media:</span>
          {(["remote", "local"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setMediaMode(mode)}
              className={`rounded px-2 py-0.5 text-[10px] capitalize transition-colors ${
                mediaMode === mode
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {mode}
            </button>
          ))}
        </div>

        <p className="px-3 pb-1.5 text-[10px] text-muted-foreground uppercase tracking-wide">
          Export format
        </p>
        {(Object.entries(TIMELINE_FORMAT_LABELS) as [TimelineFormat, string][]).map(([fmt, label]) => (
          <div
            key={fmt}
            className="flex h-8 cursor-pointer items-center rounded-sm px-3 text-xs hover:bg-zinc-800"
            onClick={() => handleTimelineExport(fmt)}
          >
            {label}
          </div>
        ))}
        <p className="px-3 pt-2 text-[10px] text-muted-foreground leading-tight">
          {mediaMode === "local"
            ? "Downloads media + project file as a ZIP folder."
            : "Cuts & clips only. Uses remote URLs."}
        </p>
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

const ScriptGuideButton = () => {
  const { isOpen, segments, setOpen } = useScriptGuideStore();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setOpen(!isOpen)}
      className={`pointer-events-auto h-8 gap-1.5 rounded-full border px-3 text-xs transition-colors ${
        isOpen
          ? "border-violet-500/60 bg-violet-500/10 text-violet-600 dark:text-violet-300"
          : "border-border text-muted-foreground hover:text-foreground"
      }`}
      title="Guided Script"
    >
      <span>📋</span>
      <span className="hidden sm:inline">Script</span>
      {segments.length > 0 && (
        <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
          isOpen ? "bg-violet-500/20 text-violet-600 dark:text-violet-300" : "bg-muted text-muted-foreground"
        }`}>
          {segments.length}
        </span>
      )}
    </Button>
  );
};
