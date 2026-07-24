"use client";
import Timeline from "./timeline";
import useStore from "./store/use-store";
import Navbar from "./navbar";
import useTimelineEvents from "./hooks/use-timeline-events";
import Scene from "./scene";
import { SceneRef } from "./scene/scene.types";
import StateManager, { DESIGN_LOAD } from "@designcombo/state";
import { useEffect, useRef, useState } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ImperativePanelHandle } from "react-resizable-panels";
import { getCompactFontData, loadFonts } from "./utils/fonts";
import { SECONDARY_FONT, SECONDARY_FONT_URL } from "./constants/constants";
import MenuList from "./menu-list";
import { ControlItem } from "./control-item";
import CropModal from "./crop-modal/crop-modal";
import useDataState from "./store/use-data-state";
import { FONTS } from "./data/fonts";
import FloatingControl from "./control-item/floating-controls/floating-control";
import { useSceneStore } from "@/store/use-scene-store";
import { dispatch } from "@designcombo/events";
import MenuListHorizontal from "./menu-list-horizontal";
import { useIsLargeScreen } from "@/hooks/use-media-query";
import { ITrackItem } from "@designcombo/types";
import useLayoutStore from "./store/use-layout-store";
import ControlItemHorizontal from "./control-item-horizontal";
import { design } from "./mock";
import useTranscriptGuides from "./hooks/use-transcript-guides";
import useCaptionSync from "./captions/use-caption-sync";
import useCaptionTranscribeStore from "./captions/transcribe-store";
import { setStateManagerRef } from "./utils/state-manager-ref";
import ScriptGuidePanel from "./control-item/script-guide-panel";
import AiEditPanel from "./control-item/ai-edit-panel";

const stateManager = new StateManager(
  {
    size: {
      width: 1920,
      height: 1080,
    },
  },
  {
    cors: {
      video: false,
      image: false,
      audio: false,
    },
  }
);

const CanvasOnly = ({
  sceneRef,
  stateManager,
  trackItem,
  loaded,
  isLargeScreen,
}: any) => {
  return (
    <div className="relative flex h-full w-full flex-col bg-background overflow-hidden">
      <div className="flex-1 relative overflow-hidden w-full h-full">
        <CropModal />
        <Scene ref={sceneRef} stateManager={stateManager} />
      </div>
      {!isLargeScreen && !trackItem && loaded && <MenuListHorizontal />}
      {!isLargeScreen && trackItem && <ControlItemHorizontal />}
    </div>
  );
};

const LeftSidebar = () => {
  return (
    <div className="bg-card w-full flex flex-none border-r border-border/80 h-full overflow-hidden">
      <div className="flex flex-col w-full h-full overflow-hidden">
        <div className="flex-none">
          <MenuList />
        </div>
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
          <ControlItem />
        </div>
      </div>
    </div>
  );
};

const RightPanel = () => {
  return (
    <div id="editor-right-panel" className="bg-card w-full flex flex-none border-l border-border/80 h-full overflow-hidden" />
  );
};

const Editor = ({ tempId, id }: { tempId?: string; id?: string }) => {
  const [projectName, setProjectName] = useState<string>("Untitled video");
  const { scene } = useSceneStore();
  const timelinePanelRef = useRef<ImperativePanelHandle>(null);
  const sceneRef = useRef<SceneRef>(null);
  const { timeline, playerRef, fps } = useStore();
  const { activeIds, trackItemsMap, transitionsMap, tracks } = useStore();
  const editorAreaRef = useRef<HTMLDivElement>(null);
  // Content-aware cap for how tall the timeline panel can grow. Without it, dragging the
  // timeline taller than its tracks just opened a big empty black canvas below the rows —
  // "no benefit to expanding". This makes the max expansion follow the number of tracks
  // (+ a comfortable floor), so you can open exactly enough to see every track and no more.
  const [timelineMaxSize, setTimelineMaxSize] = useState(70);
  const lastSeekedIdRef = useRef<string | null>(null);
  // What we last wrote into the SHARED layout.trackItem slot, so we only ever clear our own.
  const lastSelectedIdRef = useRef<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [trackItem, setTrackItem] = useState<ITrackItem | null>(null);
  const {
    setTrackItem: setLayoutTrackItem,
    setFloatingControl,
    setLabelControlItem,
    setTypeControlItem,
    setActiveMenuItem,
  } = useLayoutStore();
  const isLargeScreen = useIsLargeScreen();

  useTimelineEvents();
  useTranscriptGuides(stateManager);
  useCaptionSync(stateManager);
  setStateManagerRef(stateManager);

  const { setCompactFonts, setFonts } = useDataState();
  // useEffect(() => {
  //   dispatch(DESIGN_LOAD, { payload: design });
  // }, []);
  useEffect(() => {
    setCompactFonts(getCompactFontData(FONTS));
    setFonts(FONTS);
  }, []);

  useEffect(() => {
    loadFonts([
      {
        name: SECONDARY_FONT,
        url: SECONDARY_FONT_URL,
      },
    ]);
  }, []);

  useEffect(() => {
    const screenHeight = window.innerHeight;
    const desiredHeight = 300;
    const percentage = (desiredHeight / screenHeight) * 100;
    timelinePanelRef.current?.resize(percentage);
  }, []);

  const handleTimelineResize = () => {
    const timelineContainer = document.getElementById("timeline-container");
    if (!timelineContainer) return;

    timeline?.resize(
      {
        height: timelineContainer.clientHeight - 90,
        width: timelineContainer.clientWidth - 40,
      },
      {
        force: true,
      },
    );

    // Trigger zoom recalculation when timeline is resized
    setTimeout(() => {
      sceneRef.current?.recalculateZoom();
    }, 100);
  };

  useEffect(() => {
    const onResize = () => handleTimelineResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [timeline]);

  // Cap the timeline panel's max height to what its tracks actually need, so it can't be
  // dragged open into a big empty black canvas. Recomputes whenever tracks change or the
  // window resizes. Row heights mirror timeline.tsx's sizesMap.
  useEffect(() => {
    const ROW_PX: Record<string, number> = {
      video: 50, image: 50, audio: 36, text: 32, caption: 24,
    };
    const computeMax = () => {
      const groupPx = editorAreaRef.current?.clientHeight || 0;
      if (groupPx <= 0) return;
      const CHROME_PX = 96;                 // header + ruler + horizontal scrollbar
      const MARGIN_PX = 44;                 // a hint of one more lane below the last track
      const FLOOR_PX = 300;                 // never cap below a comfortably usable timeline
      const contentPx =
        CHROME_PX +
        (tracks || []).reduce((s, t) => s + (ROW_PX[(t as any)?.type] ?? 40), 0) +
        MARGIN_PX;
      const desiredPx = Math.max(contentPx, FLOOR_PX);
      const pct = Math.min(70, Math.max(15, (desiredPx / groupPx) * 100));
      setTimelineMaxSize(pct);
      // If the panel is already taller than the new cap, pull it back down to the cap.
      const cur = (timelinePanelRef.current as any)?.getSize?.();
      if (typeof cur === "number" && cur > pct + 0.5) {
        timelinePanelRef.current?.resize(pct);
        handleTimelineResize();
      }
    };
    computeMax();
    window.addEventListener("resize", computeMax);
    return () => window.removeEventListener("resize", computeMax);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks]);

  useEffect(() => {
    if (activeIds.length === 1) {
      const [id] = activeIds;
      const trackItem = trackItemsMap[id];
      if (trackItem) {
        setTrackItem(trackItem);
        lastSelectedIdRef.current = id;
        setLayoutTrackItem(trackItem);
        // Remember the media you clicked, so the Captions panel opens on it. It has to happen
        // HERE: opening any menu runs clearActiveSelection (menu-list.tsx), so by the time that
        // panel mounts activeIds is already empty and the click it should react to is gone.
        const t = (trackItem as any).type;
        if ((t === "audio" || t === "video") && (trackItem as any).details?.src) {
          useCaptionTranscribeStore.getState().setLastSource(id);
        }
        // Caption items → open global Captions tab instead of right sidebar
        if (t === "caption") {
          setActiveMenuItem("captions");
        }
        // NOTE: selecting a clip must NOT move the playhead. It used to seek to the clip's
        // start on select, which yanked the playhead away from where the user parked it —
        // they select a clip to edit it, not to scrub. The playhead only moves on an
        // explicit scrub (ruler click / playhead drag / transport). Keep lastSeekedIdRef in
        // sync so any other code that reads it still sees the current selection.
        lastSeekedIdRef.current = id;
      } else console.log(transitionsMap[id]);
    } else {
      setTrackItem(null);
      // Release the shared layout slot only if we still hold it. control-item.tsx and the left
      // Captions menu write the same field and FloatingControl renders nothing while it's
      // empty, so an unconditional null here closed their pickers — and because trackItemsMap
      // is a dependency, it fired on every edit, including the preset apply made from inside
      // one of those pickers.
      if (useLayoutStore.getState().trackItem?.id === lastSelectedIdRef.current) {
        setLayoutTrackItem(null);
      }
      lastSelectedIdRef.current = null;
      lastSeekedIdRef.current = null;
    }
  }, [activeIds, trackItemsMap]);

  useEffect(() => {
    setFloatingControl("");
    setLabelControlItem("");
    setTypeControlItem("");
  }, [isLargeScreen]);

  useEffect(() => {
    setLoaded(true);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col">
      <Navbar
        projectName={projectName}
        user={null}
        stateManager={stateManager}
        setProjectName={setProjectName}
      />
      <ScriptGuidePanel />
      <AiEditPanel />

      <div ref={editorAreaRef} className="flex flex-1 min-h-0">
        {isLargeScreen ? (
          <ResizablePanelGroup direction="vertical" className="h-full w-full">
            {/* Top: 3-column area */}
            <ResizablePanel defaultSize={65} minSize={30} className="min-h-0">
              <ResizablePanelGroup direction="horizontal" className="h-full w-full">
                {/* Left: Tabs/Menu sidebar */}
                <ResizablePanel
                  defaultSize={22}
                  minSize={14}
                  maxSize={38}
                  className="relative min-w-0 overflow-visible!"
                >
                  <LeftSidebar />
                  <FloatingControl />
                </ResizablePanel>

                <ResizableHandle className="bg-border/90" />

                {/* Center: Canvas */}
                <ResizablePanel defaultSize={56} minSize={30} className="min-w-0 min-h-0">
                  <CanvasOnly
                    sceneRef={sceneRef}
                    stateManager={stateManager}
                    trackItem={trackItem}
                    loaded={loaded}
                    isLargeScreen={isLargeScreen}
                  />
                </ResizablePanel>

                <ResizableHandle className="bg-border/90" />

                {/* Right: Properties panel */}
                <ResizablePanel
                  defaultSize={22}
                  minSize={14}
                  maxSize={38}
                  className="min-w-0 min-h-0"
                >
                  <RightPanel />
                </ResizablePanel>
              </ResizablePanelGroup>
            </ResizablePanel>

            <ResizableHandle className="bg-border/90" onDragging={handleTimelineResize} />

            {/* Bottom: Full-width Timeline */}
            <ResizablePanel
              ref={timelinePanelRef}
              defaultSize={35}
              minSize={15}
              maxSize={timelineMaxSize}
              className="min-h-0"
              onResize={handleTimelineResize}
            >
              {playerRef && <Timeline stateManager={stateManager} />}
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <div className="relative flex h-full w-full flex-col bg-background overflow-hidden">
            <CanvasOnly
              sceneRef={sceneRef}
              stateManager={stateManager}
              trackItem={trackItem}
              loaded={loaded}
              isLargeScreen={isLargeScreen}
            />
            <div className="w-full">
              {playerRef && <Timeline stateManager={stateManager} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Editor;
