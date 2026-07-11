import { useCallback, useEffect, useRef, useState } from "react";
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
  FileDown,
  FileUp,
  Keyboard,
  Music2,
  Pause,
  Play,
  Plus,
  ProportionsIcon,
  Save,
  ShareIcon,
  Trash2
} from "lucide-react";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";

import type StateManager from "@designcombo/state";
import useStore from "./store/use-store";
import { generateId } from "@designcombo/timeline";
import type { IDesign } from "@designcombo/types";
import { useDownloadState } from "./store/use-download-state";
import DownloadProgressModal from "./download-progress-modal";
import RenderStatusWidget from "./render-status-widget";
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
import { LOOKS } from "./player/film-look";
import { Clapperboard, Sparkles } from "lucide-react";
import { parseTimeToMs } from "./store/use-script-guide-store";
import {
  getSavedProjects,
  saveProject,
  updateProject,
  deleteProject,
  type SavedProject,
} from "./utils/project-storage";
import { AUDIOS } from "./data/audio";
import {
  MUSIC_BED_ROLE,
  MUSIC_BED_VOLUME_DEFAULT,
  getManagedAudioItems,
  upsertMusicBed,
} from "./utils/scene-audio";

const toProxyMediaSrc = (src: unknown) => {
  const raw = String(src || "");
  if (!raw) return "";
  if (raw.startsWith("/api/proxy?url=") || raw.startsWith("/editor/api/proxy?url=")) return raw;
  if (raw.includes("rpublic.tomtap.ai")) {
    return `/api/proxy?url=${encodeURIComponent(raw)}`;
  }
  return raw;
};

const withEditorBase = (path: string) => {
  if (typeof window === "undefined") return path;
  if (window.location.pathname.startsWith("/editor")) return `/editor${path}`;
  return path;
};

type StylePackEntry = {
  label?: string;
  look?: string;
  transition?: string;
  transition_ms?: number;
  music_url?: string;
  music_volume?: number;
  sfx_on_cuts?: boolean;
  cut_sfx_url?: string;
  cut_sfx_volume?: number;
  caption_font?: string;
  caption_color?: string;
  lower_third_style?: string;
  default_shot_ms?: number;
  ken_burns?: string;
  ken_burns_intensity?: number;
  ken_burns_smooth?: boolean;
  ken_burns_duration?: number;
};

type StylePackFieldDoc = {
  allowed?: string[];
  description?: string;
  format?: string;
  range?: number[];
  recommended_range?: number[];
  type?: string;
};

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

  // Sync AI-rendered projects from vapp server into localStorage on mount
  useEffect(() => {
    try {
      fetch(`/editor/api/vapp-projects`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (!data?.projects?.length) return;
          const existing = getSavedProjects();
          const existingIds = new Set(existing.map((p: SavedProject) => p.id));
          let added = false;
          for (const proj of data.projects) {
            if (!existingIds.has(proj.id)) {
              const projects = getSavedProjects();
              projects.unshift(proj as SavedProject);
              localStorage.setItem("vapp_saved_projects", JSON.stringify(projects));
              added = true;
            }
          }
          if (added) setSavedProjects(getSavedProjects());
        })
        .catch(() => {});
    } catch {}
  }, []);

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
    const sm = stateManager.toJSON() as Record<string, unknown>;
    const data = {
      ...sm,
      // persist the scene-wide Film Look so reopening restores it
      metadata: {
        ...(sm.metadata as object),
        look: useStore.getState().look,
        stylePack: useStore.getState().stylePack,
      },
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

  const patchDesignMetadata = (data: Record<string, unknown>): Record<string, unknown> => {
    const map = (data?.trackItemsMap ?? {}) as Record<string, Record<string, unknown>>;
    for (const [, item] of Object.entries(map)) {
      const details = (item.details ?? {}) as Record<string, unknown>;
      const meta = (item.metadata ?? {}) as Record<string, unknown>;
      const proxiedSrc = toProxyMediaSrc(details.src);

      if (proxiedSrc && proxiedSrc !== details.src) {
        item.details = { ...details, src: proxiedSrc };
      }

      if (item?.type === "video") {
        const normalizedPreview = toProxyMediaSrc(meta.previewUrl || proxiedSrc || details.src);
        if (normalizedPreview && normalizedPreview !== meta.previewUrl) {
          item.metadata = { ...meta, previewUrl: normalizedPreview };
        } else if (!meta.previewUrl && proxiedSrc) {
          item.metadata = { ...meta, previewUrl: proxiedSrc };
        }
      }
    }
    return data;
  };

  const handleLoadProject = (project: SavedProject) => {
    dispatch(DESIGN_LOAD, { payload: patchDesignMetadata(project.data as Record<string, unknown>) });
    // restore the saved Film Look into the live store (preview + next render)
    const savedLook = (project.data as any)?.metadata?.look;
    const savedStylePack = (project.data as any)?.metadata?.stylePack;
    useStore.getState().setLook(typeof savedLook === "string" ? savedLook : "off");
    useStore.getState().setStylePack(typeof savedStylePack === "string" ? savedStylePack : "");
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

  // --- Import / Export project as a single .json file ---
  const importInputRef = useRef<HTMLInputElement>(null);

  const buildProjectData = (): Record<string, unknown> => {
    const sm = stateManager.toJSON() as Record<string, unknown>;
    return {
      ...sm,
      metadata: {
        ...(sm.metadata as object),
        look: useStore.getState().look,
        stylePack: useStore.getState().stylePack,
      },
      ...(rawJson ? { _guidedScript: rawJson } : {}),
    };
  };

  const downloadProjectJson = (name: string, data: Record<string, unknown>) => {
    const payload = { name, savedAt: Date.now(), data };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(name || "project").replace(/[^\w.-]+/g, "_") || "project"}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleExportCurrent = () => downloadProjectJson(title || "project", buildProjectData());

  const handleExportProject = (e: React.MouseEvent, project: SavedProject) => {
    e.stopPropagation();
    downloadProjectJson(project.name, project.data as Record<string, unknown>);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const data = (parsed?.data ?? parsed) as Record<string, unknown>;
      if (!data || typeof data !== "object") throw new Error("invalid");
      const name = String(parsed?.name || file.name.replace(/\.json$/i, "")) || "Imported project";
      const saved = saveProject(name, data);
      setSavedProjects(getSavedProjects());
      handleLoadProject(saved);
    } catch {
      alert("Import failed — that file isn't a valid project JSON.");
    }
  };

  const handleNewProject = () => {
    const sm = stateManager.toJSON() as Record<string, unknown>;
    dispatch(DESIGN_LOAD, {
      payload: {
        ...sm,
        id: generateId(),
        tracks: [],
        trackItemIds: [],
        trackItemsMap: {},
        transitionIds: [],
        transitionsMap: {},
        metadata: {},
      },
    });
    useStore.getState().setLook("off");
    useStore.getState().setStylePack("");
    setTitle("Untitled video");
    setProjectName("Untitled video");
    setCurrentProjectId(null);
    setIsProjectsOpen(false);
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: isLargeScreen ? "320px 1fr 320px" : "1fr 1fr 1fr"
      }}
      className="bg-card pointer-events-none flex h-13 items-center border-b border-border/80 px-2"
    >
      {/* Left: logo + undo/redo + minimized export chip */}
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
        <DownloadProgressModal />
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
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-foreground shrink-0"
                onClick={handleExportCurrent}
                title="Export project (.json)"
              >
                <FileDown className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-foreground shrink-0"
                onClick={() => importInputRef.current?.click()}
                title="Import project (.json)"
              >
                <FileUp className="size-3.5" />
              </Button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={handleImportFile}
              />
            </div>

            <PopoverContent align="center" className="z-[250] w-72 p-2" sideOffset={6}>
              <div
                onClick={handleNewProject}
                className="mb-1 flex cursor-pointer items-center gap-2 rounded-md border-b border-border/60 px-2 py-2 text-sm font-medium hover:bg-accent"
              >
                <Plus className="size-4" /> New Project
              </div>
              {savedProjects.length === 0 ? (
                <p className="px-2 py-4 text-center text-sm text-muted-foreground">No saved projects yet</p>
              ) : (() => {
                const userProjects = savedProjects.filter(p => !p.id.startsWith("ai_"));
                const aiProjects   = savedProjects.filter(p => p.id.startsWith("ai_"));
                const renderItem   = (project: SavedProject) => {
                  const isActive = project.id === currentProjectId;
                  return (
                    <div
                      key={project.id}
                      onClick={() => handleLoadProject(project)}
                      className={`group flex items-center justify-between rounded-md px-2 py-2 cursor-pointer transition-colors ${isActive ? "bg-accent" : "hover:bg-accent"}`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className={`truncate text-sm font-medium ${isActive ? "text-foreground" : ""}`}>
                          {project.name}
                          {isActive && <span className="ml-2 text-xs text-muted-foreground font-normal">(current)</span>}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(project.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </p>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground" onClick={(e) => handleExportProject(e, project)} title="Export (.json)">
                          <FileDown className="size-3" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive" onClick={(e) => handleDeleteProject(e, project.id)} title="Delete">
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    </div>
                  );
                };
                return (
                  <div className="flex flex-col max-h-80 overflow-y-auto">
                    {userProjects.length > 0 && (
                      <>
                        <p className="mb-1 px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Your Projects</p>
                        <div className="flex flex-col gap-0.5 mb-2">{userProjects.map(renderItem)}</div>
                      </>
                    )}
                    {aiProjects.length > 0 && (
                      <>
                        <p className="mb-1 px-2 text-xs font-semibold text-violet-400 uppercase tracking-wide">AI Projects</p>
                        <div className="flex flex-col gap-0.5">{aiProjects.map(renderItem)}</div>
                      </>
                    )}
                  </div>
                );
              })()}
            </PopoverContent>
          </Popover>
        )}
        {!isSmallScreen && (
          <Button
            variant={saveSuccess ? "default" : "outline"}
            size="icon"
            className="pointer-events-auto h-8 w-8 border border-border rounded-full transition-colors"
            onClick={() => setIsSaveModalOpen(true)}
            title={saveSuccess ? "Saved!" : "Save project"}
          >
            <Save className="size-4" />
          </Button>
        )}
      </div>

      {/* Right: theme + shortcuts + download */}
      <div className="flex h-13 items-center justify-end gap-2">
        <div className="pointer-events-auto flex h-10 items-center gap-2 rounded-md px-2.5">
          <RenderStatusWidget />
          <StylePackPicker />
          <LookPicker />
          <MusicBedPicker stateManager={stateManager} />
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
  const { actions, exportType, exportQuality, exportResolution, exportEngine, remoteUrl } = useDownloadState();
  const { size } = useStore();
  const [isExportTypeOpen, setIsExportTypeOpen] = useState(false);
  const [isQualityOpen, setIsQualityOpen] = useState(false);
  const [isResolutionOpen, setIsResolutionOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [renderTab, setRenderTab] = useState<"local" | "remote" | "queue">("queue");

  const handleExport = () => {
    const data: IDesign = {
      id: generateId(),
      ...stateManager.toJSON()
    };

    actions.setState({ payload: data });
    actions.startExport();
  };

  const handleRemoteExport = () => {
    const target = (remoteUrl || "").trim();
    if (!target) return;
    // Prepend a scheme if the user typed a bare host/IP (e.g. 192.168.50.161:3000).
    const base = /^https?:\/\//i.test(target) ? target : `http://${target}`;
    const data: IDesign = {
      id: generateId(),
      ...stateManager.toJSON()
    };
    actions.setState({ payload: data });
    actions.startExport(base);
  };

  const handleQueueExport = () => {
    const data: IDesign = {
      id: generateId(),
      ...stateManager.toJSON()
    };
    actions.setState({ payload: data });
    actions.startQueueExport();
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

        <div className="flex flex-col gap-2 border-t border-border pt-3">
          {/* Render target — pick one of three ways (settings above still apply). */}
          <div className="flex gap-1 rounded-md border border-border p-0.5">
            {([
              ["local", "Local"],
              ["remote", "Remote"],
              ["queue", "Queue"],
            ] as const).map(([val, label]) => (
              <button
                key={val}
                onClick={() => setRenderTab(val)}
                className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${
                  renderTab === val
                    ? "bg-secondary text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {renderTab === "local" && (
            <div className="flex flex-col gap-1.5">
              <Button onClick={handleExport} className="w-full">
                Export Video
              </Button>
              <TimelineExportMenu stateManager={stateManager} />
              <p className="text-[10px] text-muted-foreground leading-tight">
                Renders in this browser using the settings above.
              </p>
            </div>
          )}

          {renderTab === "remote" && (
            <div className="flex flex-col gap-1.5">
              <input
                type="text"
                value={remoteUrl}
                onChange={(e) => actions.setRemoteUrl(e.target.value)}
                placeholder="192.168.50.161:3000"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <Button
                onClick={handleRemoteExport}
                disabled={!remoteUrl.trim()}
                variant="outline"
                className="w-full"
              >
                Render Remote
              </Button>
              <p className="text-[10px] text-muted-foreground leading-tight">
                Renders directly on the machine at this URL.
              </p>
            </div>
          )}

          {renderTab === "queue" && (
            <div className="flex flex-col gap-1.5">
              <Button
                onClick={handleQueueExport}
                variant="outline"
                className="w-full"
              >
                Send to Render Queue
              </Button>
              <p className="text-[10px] text-muted-foreground leading-tight">
                Queues the job on the vApp server — a free render agent picks it up.
              </p>
            </div>
          )}
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

const StylePackPicker = () => {
  const { stylePack, setStylePack, setLook } = useStore();
  const [open, setOpen] = useState(false);
  const [packs, setPacks] = useState<Record<string, StylePackEntry>>({});
  const [fieldDocs, setFieldDocs] = useState<Record<string, StylePackFieldDoc>>({});

  useEffect(() => {
    let cancelled = false;
    const loadPacks = async () => {
      try {
        const res = await fetch(withEditorBase("/api/style-packs"), { cache: "no-store" });
        const data = await res.json();
        if (!cancelled) {
          setPacks(data?.packs && typeof data.packs === "object" ? data.packs : {});
          setFieldDocs(
            data?.allowed_fields && typeof data.allowed_fields === "object"
              ? data.allowed_fields
              : {}
          );
        }
      } catch {
        if (!cancelled) {
          setPacks({});
          setFieldDocs({});
        }
      }
    };
    void loadPacks();
    return () => {
      cancelled = true;
    };
  }, []);

  const entries = Object.entries(packs);
  const active = stylePack ? packs[stylePack] : undefined;
  const isOn = !!stylePack;
  const activeSummary = active
    ? [
        active.look ? `Look: ${active.look}` : "",
        active.transition ? `Transition: ${active.transition}${active.transition_ms ? ` (${active.transition_ms}ms)` : ""}` : "",
        active.music_url ? `Music: ${active.music_volume ?? 18}%` : "Music: off",
        active.sfx_on_cuts ? `Cut SFX: on (${active.cut_sfx_volume ?? 55}%)` : "Cut SFX: off",
        active.caption_font ? `Captions: ${active.caption_font}${active.caption_color ? ` ${active.caption_color}` : ""}` : "",
        active.lower_third_style ? `Lower thirds: ${active.lower_third_style}` : "",
        active.default_shot_ms ? `Default shot: ${active.default_shot_ms}ms` : "",
        active.ken_burns
          ? `Image motion: ${active.ken_burns}${active.ken_burns_duration ? ` (${active.ken_burns_duration}ms)` : ""}${active.ken_burns_intensity !== undefined ? ` intensity ${active.ken_burns_intensity}` : ""}${active.ken_burns_smooth !== undefined ? ` smooth ${active.ken_burns_smooth ? "on" : "off"}` : ""}`
          : "",
      ].filter(Boolean)
    : [];
  const supportedKeys = Object.keys(fieldDocs);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={`pointer-events-auto h-8 gap-1.5 rounded-full border px-3 text-xs transition-colors ${
            isOn
              ? "border-sky-500/60 bg-sky-500/10 text-sky-600 dark:text-sky-300"
              : "border-border text-muted-foreground hover:text-foreground"
          }`}
          title="Style Pack — one-click house style preset"
        >
          <Sparkles className="size-3.5" />
          <span className="hidden sm:inline">{active?.label || "Style Pack"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="bg-background z-[251] w-60 px-2 py-2" sideOffset={6}>
        <p className="px-2 pb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          Style Pack
        </p>
        <div
          onClick={() => {
            setStylePack("");
            setOpen(false);
          }}
          className={`flex h-8 cursor-pointer items-center justify-between rounded-sm px-3 text-sm transition-colors hover:bg-accent ${
            !stylePack ? "bg-accent font-medium" : ""
          }`}
        >
          <span>Off (manual)</span>
          {!stylePack && <span className="text-[10px] text-muted-foreground">●</span>}
        </div>
        {entries.map(([id, pack]) => (
          <div
            key={id}
            onClick={() => {
              setStylePack(id);
              if (typeof pack.look === "string" && pack.look) {
                setLook(pack.look);
              }
              setOpen(false);
            }}
            className={`flex cursor-pointer items-center justify-between rounded-sm px-3 py-2 text-sm transition-colors hover:bg-accent ${
              id === stylePack ? "bg-accent font-medium" : ""
            }`}
          >
            <div className="pr-3">
              <div>{pack.label || id}</div>
              <div className="text-[10px] text-muted-foreground">{id}</div>
            </div>
            {id === stylePack && <span className="text-[10px] text-muted-foreground">●</span>}
          </div>
        ))}
        <p className="px-2 pt-2 text-[10px] leading-tight text-muted-foreground">
          Editor preview mirrors the pack look. MCP/server render applies the full pack.
        </p>
        {activeSummary.length > 0 && (
          <div className="mt-2 rounded-md border border-border/60 bg-background/60 px-2 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Selected pack summary</p>
            <div className="mt-1 space-y-1">
              {activeSummary.map((line) => (
                <div key={line} className="text-[11px] text-muted-foreground">
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}
        {supportedKeys.length > 0 && (
          <div className="mt-2 rounded-md border border-border/60 bg-background/60 px-2 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Allowed keys</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {supportedKeys.map((key) => (
                <span
                  key={key}
                  title={fieldDocs[key]?.description || key}
                  className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {key}
                </span>
              ))}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};

// Phase 1 — Film Look: scene-wide grade + grain preset picker. Manual surface
// for the same `look` value the MCP sets via assemble_timeline(look=...).
const LookPicker = () => {
  const { look, setLook } = useStore();
  const [open, setOpen] = useState(false);
  const active = LOOKS.find((l) => l.id === look) ?? LOOKS[0];
  const isOn = active.id !== "off";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={`pointer-events-auto h-8 gap-1.5 rounded-full border px-3 text-xs transition-colors ${
            isOn
              ? "border-amber-500/60 bg-amber-500/10 text-amber-600 dark:text-amber-300"
              : "border-border text-muted-foreground hover:text-foreground"
          }`}
          title="Film Look — global colour grade & grain"
        >
          <Clapperboard className="size-3.5" />
          <span className="hidden sm:inline">{isOn ? active.label : "Look"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="bg-background z-[251] w-56 px-2 py-2" sideOffset={6}>
        <p className="px-2 pb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          Film Look
        </p>
        {LOOKS.map((l) => (
          <div
            key={l.id}
            onClick={() => { setLook(l.id); setOpen(false); }}
            className={`flex h-8 cursor-pointer items-center justify-between rounded-sm px-3 text-sm transition-colors hover:bg-accent ${
              l.id === look ? "bg-accent font-medium" : ""
            }`}
          >
            <span>{l.label}</span>
            {l.id === look && <span className="text-[10px] text-muted-foreground">●</span>}
          </div>
        ))}
        <p className="px-2 pt-2 text-[10px] leading-tight text-muted-foreground">
          Applies to preview &amp; final render. Content-agnostic.
        </p>
      </PopoverContent>
    </Popover>
  );
};

const MusicBedPicker = ({ stateManager }: { stateManager: StateManager }) => {
  const { trackItemsMap, tracks, trackItemIds, duration } = useStore();
  const [open, setOpen] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const activeItem = getManagedAudioItems(trackItemsMap, MUSIC_BED_ROLE)[0] as any | undefined;
  const normalizeLocalSrc = (src?: string) => String(src || "").replace(/^\/editor/, "");
  const activeTrack = AUDIOS.find(
    (audio) => normalizeLocalSrc(audio.details?.src) === normalizeLocalSrc(activeItem?.details?.src)
  );
  const [pendingVolume, setPendingVolume] = useState<number>(
    Number(activeItem?.details?.volume ?? MUSIC_BED_VOLUME_DEFAULT)
  );

  useEffect(() => {
    setPendingVolume(Number(activeItem?.details?.volume ?? MUSIC_BED_VOLUME_DEFAULT));
  }, [activeItem?.details?.volume]);

  const applyMusicBed = (src?: string, volume?: number) => {
    const patch = upsertMusicBed(
      {
        duration,
        tracks,
        trackItemIds,
        trackItemsMap,
      },
      { src, volume }
    );
    stateManager.updateState(patch, { updateHistory: true, kind: "add" });
  };

  const togglePreview = (src?: string) => {
    const normalizedSrc = normalizeLocalSrc(src);
    if (!normalizedSrc) return;
    const resolvedSrc = withEditorBase(normalizedSrc);
    const audio = previewAudioRef.current;
    if (!audio) return;

    if (previewSrc === resolvedSrc && !audio.paused) {
      audio.pause();
      audio.currentTime = 0;
      setPreviewSrc(null);
      return;
    }

    audio.src = resolvedSrc;
    audio.currentTime = 0;
    void audio.play();
    setPreviewSrc(resolvedSrc);
  };

  const isOn = !!activeItem;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={`pointer-events-auto h-8 gap-1.5 rounded-full border px-3 text-xs transition-colors ${
            isOn
              ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
              : "border-border text-muted-foreground hover:text-foreground"
          }`}
          title="Music bed"
        >
          <Music2 className="size-3.5" />
          <span className="hidden sm:inline">{activeTrack?.name || "Music bed"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="bg-background z-[251] w-72 px-3 py-3" sideOffset={6}>
        <audio
          ref={previewAudioRef}
          onEnded={() => setPreviewSrc(null)}
          className="hidden"
        />
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Music bed (background music on full video)
            </p>
            <p className="text-xs text-muted-foreground">
              Adds one low-volume music layer under the full timeline.
            </p>
          </div>
          {isOn && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => applyMusicBed(undefined, pendingVolume)}
            >
              Remove
            </Button>
          )}
        </div>

        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <Label>Volume</Label>
            <span className="text-muted-foreground">{pendingVolume}%</span>
          </div>
          <Slider
            min={0}
            max={100}
            step={1}
            value={[pendingVolume]}
            onValueChange={(value) => {
              const next = value[0] ?? MUSIC_BED_VOLUME_DEFAULT;
              setPendingVolume(next);
              if (activeItem?.details?.src) applyMusicBed(activeItem.details.src, next);
            }}
          />
        </div>

        <div className="mt-3 max-h-72 space-y-1 overflow-y-auto pr-1">
          {AUDIOS.map((audio) => {
            const isActive =
              normalizeLocalSrc(activeItem?.details?.src) === normalizeLocalSrc(audio.details?.src);
            const previewPath = withEditorBase(normalizeLocalSrc(audio.details?.src));
            const isPreviewing = previewSrc === previewPath;
            return (
              <div
                key={audio.id}
                className={`flex items-center gap-2 rounded-sm px-2 py-2 text-sm transition-colors hover:bg-accent ${
                  isActive ? "bg-accent font-medium" : ""
                }`}
              >
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0 rounded-full"
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePreview(audio.details?.src);
                  }}
                  title={`Preview ${audio.name}`}
                >
                  {isPreviewing ? (
                    <Pause className="size-3.5" />
                  ) : (
                    <Play className="size-3.5 ml-0.5" />
                  )}
                </Button>
                <button
                  type="button"
                  onClick={() => {
                    const normalizedSrc = normalizeLocalSrc(audio.details?.src);
                    applyMusicBed(withEditorBase(normalizedSrc), pendingVolume);
                    setOpen(false);
                  }}
                  className="flex min-w-0 flex-1 items-center justify-between text-left"
                >
                  <div className="min-w-0">
                    <div className="truncate">{audio.name}</div>
                    <div className="text-[11px] text-muted-foreground">{audio.metadata?.author}</div>
                  </div>
                  {isActive && <span className="ml-2 text-[10px] text-muted-foreground">●</span>}
                </button>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
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
