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
import { setStateManagerRef } from "./utils/state-manager-ref";
import ScriptGuidePanel from "./control-item/script-guide-panel";

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
  const { timeline, playerRef } = useStore();
  const { activeIds, trackItemsMap, transitionsMap } = useStore();
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

  useEffect(() => {
    if (activeIds.length === 1) {
      const [id] = activeIds;
      const trackItem = trackItemsMap[id];
      if (trackItem) {
        setTrackItem(trackItem);
        setLayoutTrackItem(trackItem);
        // Caption items → open global Captions tab instead of right sidebar
        if ((trackItem as any).type === "caption") {
          setActiveMenuItem("captions");
        }
      } else console.log(transitionsMap[id]);
    } else {
      setTrackItem(null);
      setLayoutTrackItem(null);
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

      <div className="flex flex-1 min-h-0">
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
              maxSize={70}
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
