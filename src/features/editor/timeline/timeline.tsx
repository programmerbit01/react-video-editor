import { useEffect, useRef, useState } from "react";
import Header from "./header";
import Ruler from "./ruler";
import { timeMsToUnits, unitsToTimeMs } from "@designcombo/timeline";
import CanvasTimeline from "./items/timeline";
import useStore from "../store/use-store";
import Playhead from "./playhead";
import { useTheme } from "next-themes";
import { useCurrentPlayerFrame } from "../hooks/use-current-frame";
import { PlaybackState } from "../utils/playback-state";
import {
  Audio,
  Image,
  Text,
  Video,
  Caption,
  Helper,
  Track,
  LinealAudioBars,
  RadialAudioBars,
  WaveAudioBars,
  HillAudioBars
} from "./items";
import StateManager from "@designcombo/state";
import {
  TIMELINE_OFFSET_CANVAS_LEFT,
  TIMELINE_OFFSET_CANVAS_RIGHT
} from "../constants/constants";
import PreviewTrackItem from "./items/preview-drag-item";
import { useTimelineOffsetX } from "../hooks/use-timeline-offset";
import { useStateManagerEvents } from "../hooks/use-state-manager-events";
import { useResizbleTimeline } from "../hooks/use-resizable-timeline";
import useLayoutStore from "../store/use-layout-store";
import useCaptionTranscribeStore from "../store/use-caption-transcribe-store";
import { Captions as CaptionsIcon } from "lucide-react";
import useTranscriptGuideStore from "../store/use-transcript-guide-store";
import TrackControlsOverlay from "./track-controls-overlay";


CanvasTimeline.registerItems({
  Text,
  Image,
  Audio,
  Video,
  Caption,
  Helper,
  Track,
  PreviewTrackItem,
  LinealAudioBars,
  RadialAudioBars,
  WaveAudioBars,
  HillAudioBars
});

const EMPTY_SIZE = { width: 0, height: 0 };
const TRANSCRIPT_ZONE_H = 16;
const Timeline = ({ stateManager }: { stateManager: StateManager }) => {
  // prevent duplicate scroll events
  const canScrollRef = useRef(false);
  const [scrollLeft, setScrollLeft] = useState(0);
  const scrollLeftRef = useRef(TIMELINE_OFFSET_CANVAS_LEFT);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<CanvasTimeline | null>(null);
  const horizontalScrollbarVpRef = useRef<HTMLDivElement>(null);
  const {
    scale,
    playerRef,
    fps,
    duration,
    setState,
    timeline,
    activeIds,
    trackItemsMap
  } = useStore();
  const currentFrame = useCurrentPlayerFrame(playerRef);
  const [canvasSize, setCanvasSize] = useState(EMPTY_SIZE);
  const timelineOffsetX = useTimelineOffsetX();
  const {
    timelineContainerRef,
    timelineHeight,
    onMouseDown,
    onMouseMove,
    onMouseOut
  } = useResizbleTimeline();
  const { theme } = useTheme();

  const { setTimeline } = useStore();
  const { setActiveMenuItem, setShowMenuItem, setDrawerOpen } = useLayoutStore();
  const { requestTranscription } = useCaptionTranscribeStore();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(
    null
  );

  // Use the extracted state manager events hook
  useStateManagerEvents(stateManager);

  useEffect(() => {
    const timeout = setTimeout(() => {
      timeline?.requestRenderAll();
    }, 5);
    return () => clearTimeout(timeout);
  }, [theme, timeline]);

  useEffect(() => {
    if (playerRef?.current) {
      canScrollRef.current = playerRef?.current.isPlaying();
    }
  }, [playerRef?.current?.isPlaying()]);

  useEffect(() => {
    PlaybackState.currentMs = (currentFrame / fps) * 1000;
    timeline?.requestRenderAll();

    const position = timeMsToUnits((currentFrame / fps) * 1000, scale.zoom);
    const canvasEl = canvasElRef.current;
    const horizontalScrollbar = horizontalScrollbarVpRef.current;

    if (!canvasEl || !horizontalScrollbar) return;

    const canvasBoudingX =
      canvasEl.getBoundingClientRect().x + canvasEl.clientWidth;
    const playHeadPos = position - scrollLeft + 40;
    if (playHeadPos >= canvasBoudingX) {
      const scrollDivWidth = horizontalScrollbar.clientWidth;
      const totalScrollWidth = horizontalScrollbar.scrollWidth;
      const currentPosScroll = horizontalScrollbar.scrollLeft;
      const availableScroll =
        totalScrollWidth - (scrollDivWidth + currentPosScroll);
      const scaleScroll = availableScroll / scrollDivWidth;
      if (scaleScroll >= 0) {
        if (scaleScroll > 1)
          horizontalScrollbar.scrollTo({
            left: currentPosScroll + scrollDivWidth
          });
        else
          horizontalScrollbar.scrollTo({
            left: totalScrollWidth - scrollDivWidth
          });
      }
    }
  }, [currentFrame]);

  const onResizeCanvas = (payload: { width: number; height: number }) => {
    setCanvasSize({
      width: payload.width,
      height: payload.height
    });
  };

  useEffect(() => {
    const canvasEl = canvasElRef.current;
    const timelineContainerEl = timelineContainerRef.current;

    if (!canvasEl || !timelineContainerEl) return;

    const containerWidth =
      (document.getElementById("timeline-header")?.clientWidth || 0) - 62;
    const containerHeight =
      (document.getElementById("playhead")?.clientHeight || 0) -
      (document.getElementById("playhead-handle")?.clientHeight || 0) -
      40;
    const canvas = new CanvasTimeline(canvasEl, {
      width: containerWidth,
      height: containerHeight,
      bounding: {
        width: containerWidth,
        height: 0
      },
      selectionColor: "rgba(0, 216, 214,0.1)",
      selectionBorderColor: "rgba(0, 216, 214,1.0)",
      onResizeCanvas,
      scale: scale,
      state: stateManager,
      duration,
      spacing: {
        left: TIMELINE_OFFSET_CANVAS_LEFT,
        right: TIMELINE_OFFSET_CANVAS_RIGHT
      },
      sizesMap: {
        caption: 32,
        text: 32,
        audio: 36,
        customTrack: 40,
        customTrack2: 40,
        linealAudioBars: 40,
        radialAudioBars: 40,
        waveAudioBars: 40,
        hillAudioBars: 40
      },
      itemTypes: [
        "text",
        "image",
        "audio",
        "video",
        "caption",
        "helper",
        "track",
        "composition",
        "template",
        "linealAudioBars",
        "radialAudioBars",
        "progressFrame",
        "progressBar",
        "waveAudioBars",
        "hillAudioBars"
      ],
      acceptsMap: {
        text: ["text", "caption"],
        image: ["image", "video"],
        video: ["video", "image"],
        audio: ["audio"],
        caption: ["caption", "text"],
        template: ["template"],
        customTrack: ["video", "image"],
        customTrack2: ["video", "image"],
        main: ["video", "image"],
        linealAudioBars: ["audio", "linealAudioBars"],
        radialAudioBars: ["audio", "radialAudioBars"],
        waveAudioBars: ["audio", "waveAudioBars"],
        hillAudioBars: ["audio", "hillAudioBars"]
      },
      guideLineColor: "#ffffff",
      withTransitions: ["Video", "Image"]
    });

    canvas.initScrollbars({
      offsetX: 16,
      offsetY: 0,
      extraMarginX: 50,
      extraMarginY: 0,
      scrollbarWidth: 8,
      scrollbarColor: "rgba(255, 255, 255, 1)"
    });

    canvas.onViewportChange((left: number) => {
      const sl = left + TIMELINE_OFFSET_CANVAS_LEFT;
      scrollLeftRef.current = sl;
      setScrollLeft(sl);
    });

    canvasRef.current = canvas;

    setCanvasSize({ width: containerWidth, height: containerHeight });
    setTimeline(canvas);

    return () => {
      canvas.purge();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current as any;
    if (!canvas?.on) return;

    const handleMouseDown = (opt: any) => {
      const { selectedGuide, startDragging } = useTranscriptGuideStore.getState();
      const target = opt?.target as any;
      if (!selectedGuide || !target || target.id !== selectedGuide.itemId) return;

      const pointer = canvas.getPointer(opt.e);
      const localX = pointer.x - (target.left - target.width / 2);
      const localY = pointer.y - (target.top - target.height / 2);
      const clipDuration = Number(target.display?.to || 0) - Number(target.display?.from || 0);
      if (clipDuration <= 0) return;

      const pxPerMs = target.width / clipDuration;
      const endX = (selectedGuide.endMs - Number(target.display.from || 0)) * pxPerMs;
      const zoneY = target.height - TRANSCRIPT_ZONE_H;
      const nearHandle = Math.abs(localX - endX) <= 8;
      const insideZone = localY >= zoneY - 10 && localY <= target.height + 2;

      if (nearHandle && insideZone) {
        startDragging(target.id);
      }
    };

    const handleMouseMove = (opt: any) => {
      const { selectedGuide, draggingItemId, setGuideEnd } = useTranscriptGuideStore.getState();
      const target = opt?.target as any;
      if (!selectedGuide || !draggingItemId || !target || target.id !== draggingItemId) return;

      const pointer = canvas.getPointer(opt.e);
      const localX = pointer.x - (target.left - target.width / 2);
      const clipFrom = Number(target.display?.from || 0);
      const clipTo = Number(target.display?.to || clipFrom);
      const clipDuration = clipTo - clipFrom;
      if (clipDuration <= 0) return;

      const pxPerMs = target.width / clipDuration;
      const minEnd = selectedGuide.startMs + 100;
      const nextEnd = clipFrom + Math.max(0, Math.min(target.width, localX)) / pxPerMs;
      setGuideEnd(Math.max(minEnd, Math.min(clipTo, nextEnd)));
      canvas.defaultCursor = "ew-resize";
      canvas.requestRenderAll();
    };

    const handleMouseUp = () => {
      const { draggingItemId, stopDragging } = useTranscriptGuideStore.getState();
      if (!draggingItemId) return;
      stopDragging();
      canvas.defaultCursor = "default";
      canvas.requestRenderAll();
    };

    canvas.on("mouse:down", handleMouseDown);
    canvas.on("mouse:move", handleMouseMove);
    canvas.on("mouse:up", handleMouseUp);

    return () => {
      canvas.off("mouse:down", handleMouseDown);
      canvas.off("mouse:move", handleMouseMove);
      canvas.off("mouse:up", handleMouseUp);
    };
  }, [timeline]);

  const onClickRuler = (units: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const time = unitsToTimeMs(units, scale.zoom);
    playerRef?.current?.seekTo(Math.round((time * fps) / 1000));
  };

  const onRulerScroll = (newScrollLeft: number) => {
    // Update the timeline canvas scroll position
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.scrollTo({ scrollLeft: newScrollLeft });
    }

    // Update the horizontal scrollbar position
    if (horizontalScrollbarVpRef.current) {
      horizontalScrollbarVpRef.current.scrollLeft = newScrollLeft;
    }

    // Update the local scroll state
    setScrollLeft(newScrollLeft);
  };

  useEffect(() => {
    const availableScroll = horizontalScrollbarVpRef.current?.scrollWidth;
    if (!availableScroll || !timeline) return;
    const canvasWidth = timeline.width;
    if (availableScroll < canvasWidth + scrollLeft) {
      timeline.scrollTo({ scrollLeft: availableScroll - canvasWidth });
    }
  }, [scale]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  const selectedMediaItem =
    activeIds.length === 1 ? trackItemsMap[activeIds[0]] : undefined;
  const canTranscribeSelection =
    selectedMediaItem?.type === "audio" || selectedMediaItem?.type === "video";

  const handleTimelineContextMenu = (
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    if (!canTranscribeSelection || !selectedMediaItem?.details?.src) return;
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  const handleTranscribeSelection = () => {
    if (!canTranscribeSelection || !selectedMediaItem?.details?.src) return;
    requestTranscription(selectedMediaItem.details.src);
    setActiveMenuItem("captions");
    setShowMenuItem(true);
    setDrawerOpen(true);
    setContextMenu(null);
  };

  const handleTransitionDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    try {
      const data = JSON.parse(e.dataTransfer.types[0]);
      if (data.type === "transition") {
        e.preventDefault();
        e.stopPropagation();
      }
    } catch {}
  };

  const handleTransitionDrop = (e: React.DragEvent<HTMLDivElement>) => {
    let data: any;
    try {
      data = JSON.parse(e.dataTransfer.types[0]);
    } catch { return; }
    if (data.type !== "transition") return;

    e.preventDefault();
    e.stopPropagation();

    const canvas = canvasRef.current as any;
    if (!canvas) return;

    const transitionSlots: any[] = canvas.getObjects?.("Transition") || [];
    if (!transitionSlots.length) return;

    const containerEl = containerRef.current;
    if (!containerEl) return;
    const rect = containerEl.getBoundingClientRect();

    const viewportLeft = scrollLeftRef.current - TIMELINE_OFFSET_CANVAS_LEFT;
    const mouseCanvasX = e.clientX - rect.left + viewportLeft;

    let nearest: any = null;
    let minDist = Infinity;
    for (const slot of transitionSlots) {
      const slotCenterX = slot.left + slot.width / 2;
      const dist = Math.abs(mouseCanvasX - slotCenterX);
      if (dist < minDist) {
        minDist = dist;
        nearest = slot;
      }
    }

    if (!nearest || minDist > 80) return;

    const slotId = nearest.id;
    if (!canvas.transitionsMap?.[slotId]) return;

    canvas.transitionsMap[slotId] = {
      ...canvas.transitionsMap[slotId],
      kind: data.kind ?? "none",
      ...(data.direction ? { direction: data.direction } : {}),
    };

    canvas.adjustMagneticTrack?.();
    canvas.calcBounding?.();
    canvas.updateTransitions?.();
    canvas.refreshTrackLayout?.();
    canvas.updateState?.({ kind: "add:transition", updateHistory: true });
  };

  return (
    <div
      ref={timelineContainerRef}
      id="timeline-container"
      className="relative w-full overflow-hidden bg-card"
      style={{
        height: "100%",
        borderTopWidth: "1px",
        borderTopStyle: "solid",
        borderTopColor: "transparent"
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseOut={onMouseOut}
      onContextMenu={handleTimelineContextMenu}
    >
      <Header />
      <Ruler
        onClick={onClickRuler}
        scrollLeft={scrollLeft}
        onScroll={onRulerScroll}
      />
      <Playhead scrollLeft={scrollLeft} />
      <div className="flex">
        <div
          style={{ width: timelineOffsetX, height: canvasSize.height }}
          className="relative flex-none"
        >
          <TrackControlsOverlay />
        </div>
        <div
          style={{ height: canvasSize.height }}
          className="relative flex-1"
          onDragOver={handleTransitionDragOver}
          onDrop={handleTransitionDrop}
        >
          <div
            style={{ height: canvasSize.height }}
            ref={containerRef}
            className="absolute top-0 w-full"
          >
            <canvas id="designcombo-timeline-canvas" ref={canvasElRef} />
          </div>
        </div>
      </div>
      {contextMenu ? (
        <button
          type="button"
          className="fixed z-[250] flex items-center gap-2 rounded-md border bg-popover px-3 py-2 text-sm shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={handleTranscribeSelection}
        >
          <CaptionsIcon size={14} />
          Generate transcription
        </button>
      ) : null}
    </div>
  );
};

export default Timeline;
