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
  Graphic,
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
import { ITEM_TYPE_NAMES, ItemType, timelineClassKey } from "../item-types";
import { useTimelineOffsetX } from "../hooks/use-timeline-offset";
import { useStateManagerEvents } from "../hooks/use-state-manager-events";
import { useResizbleTimeline } from "../hooks/use-resizable-timeline";
import useLayoutStore from "../store/use-layout-store";
import useCaptionTranscribeStore from "../captions/transcribe-store";
import { Captions as CaptionsIcon, Download, Upload, Loader2, CheckCircle2 } from "lucide-react";
import { processFileUpload } from "@/utils/upload-service";
import { registerVappMediaUrl, getVappUploadCtx } from "@/utils/vapp-upload-client";
import useUploadStore from "@/features/editor/store/use-upload-store";
import { download } from "@/utils/download";
import useTranscriptGuideStore from "../store/use-transcript-guide-store";
import TrackControlsOverlay from "./track-controls-overlay";
import { AnimationOverlayStore } from "../utils/animation-overlay-store";


/**
 * How every item type is drawn on the timeline.
 *
 * Record<ItemType, …> is the point: this table cannot compile with a hole in it, so a type added
 * to ITEM_TYPES has to be given a class here before the build passes. The alternative — a
 * hand-kept list — is what threw "No class registered for X" and killed the editor on load, and
 * it did it twice: once for the charts, and again for progressBar/progressFrame, which were
 * missed while fixing the charts precisely because nothing was checking.
 *
 * Graphic is a plain labelled bar, and it is the honest default: a chart or an overlay has no
 * waveform to draw and no filmstrip to sample.
 */
const TIMELINE_ITEM_CLASSES: Record<ItemType, any> = {
  video: Video,
  image: Image,
  audio: Audio,
  caption: Caption,
  text: Text,

  linealAudioBars: LinealAudioBars,
  radialAudioBars: RadialAudioBars,
  waveAudioBars: WaveAudioBars,
  hillAudioBars: HillAudioBars,

  shape: Graphic,
  illustration: Graphic,
  lottie: Graphic,
  barchart: Graphic,
  linechart: Graphic,
  statcard: Graphic,
  bulletlist: Graphic,
  progressBar: Graphic,
  progressFrame: Graphic
};

// registerItems does setClass(value, key), and the timeline looks a class up by the capitalised
// item type. Helper/Track/PreviewTrackItem are the timeline's own furniture, not item types, so
// they are named here directly; everything else comes from the one registry.
CanvasTimeline.registerItems({
  Helper,
  Track,
  PreviewTrackItem,
  ...Object.fromEntries(
    ITEM_TYPE_NAMES.map((type) => [timelineClassKey(type), TIMELINE_ITEM_CLASSES[type]])
  )
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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "done" | "error">("idle");

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

  // Sync animation data into AnimationOverlayStore so canvas items can draw indicators
  useEffect(() => {
    for (const [id, item] of Object.entries(trackItemsMap)) {
      const anim = (item as any).animations;
      const inAnim = anim?.in;
      const outAnim = anim?.out;
      const hasIn = !!inAnim?.name;
      const hasOut = !!outAnim?.name;
      if (!hasIn && !hasOut) {
        delete AnimationOverlayStore[id];
      } else {
        AnimationOverlayStore[id] = {
          hasIn,
          hasOut,
          inDurMs: hasIn ? ((inAnim.composition?.[0]?.durationInFrames ?? 15) * 1000) / 30 : 0,
          outDurMs: hasOut ? ((outAnim.composition?.[0]?.durationInFrames ?? 15) * 1000) / 30 : 0,
        };
      }
    }
    for (const id of Object.keys(AnimationOverlayStore)) {
      if (!trackItemsMap[id]) delete AnimationOverlayStore[id];
    }
    timeline?.requestRenderAll();
  }, [trackItemsMap]);

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
        // taller video/image rows (bigger filmstrip), shorter caption row
        video: 50,
        image: 50,
        caption: 24,
        text: 32,
        audio: 36,
        customTrack: 40,
        customTrack2: 40,
        linealAudioBars: 40,
        radialAudioBars: 40,
        waveAudioBars: 40,
        hillAudioBars: 40
      },
      // Every item type, plus the timeline's own furniture. Hand-written, this list was missing
      // barchart, linechart, statcard, bulletlist, lottie, shape and illustration — all of which
      // the player renders and the AI generator emits — while declaring `composition` and
      // `template`, which nothing renders at all.
      itemTypes: [...ITEM_TYPE_NAMES, "helper", "track"],
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
  const selectedSrc = (selectedMediaItem as any)?.details?.src as string | undefined;

  const handleTimelineContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!selectedSrc) return;
    event.preventDefault();
    setUploadState("idle");
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  const handleTranscribeSelection = () => {
    if (!canTranscribeSelection || !selectedSrc) return;
    requestTranscription(selectedSrc);
    setActiveMenuItem("captions");
    setShowMenuItem(true);
    setDrawerOpen(true);
    setContextMenu(null);
  };

  const handleDownloadClip = async () => {
    if (!selectedSrc) return;
    const name = selectedSrc.split("/").pop()?.split("?")[0] || "clip";
    try {
      // A cross-origin <a download> is IGNORED by browsers (it just navigates), so
      // fetch the bytes and download the blob. R2 serves CORS `*` → direct fetch,
      // no /api/proxy hop.
      const res = await fetch(selectedSrc);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
    } catch {
      // Fallback: open the media so the user can save it manually.
      window.open(selectedSrc, "_blank", "noopener");
    }
    setContextMenu(null);
  };

  const handleUploadToLibrary = async () => {
    if (!selectedSrc) return;
    setUploadState("uploading");
    try {
      const ctx = getVappUploadCtx();
      if (ctx) {
        // The clip already lives on R2 — register its URL into the library
        // (direct vApp `/vapp/media/register-upload`, no re-upload, no proxy).
        const t = (selectedMediaItem as any)?.type;
        const mediaType: "image" | "video" | "audio" =
          t === "video" ? "video" : t === "audio" ? "audio" : "image";
        const reg = await registerVappMediaUrl(selectedSrc, ctx, { mediaType });
        // Surface it in the media library immediately (dedupe by clean url).
        const cleanUrl = reg.url.split("?")[0];
        useUploadStore.getState().setUploads((prev: any[]) => [
          {
            id: `vapp-${cleanUrl}`,
            url: reg.url,
            filePath: reg.url,
            fileName: reg.name,
            type: `${mediaType}/*`,
            contentType: `${mediaType}/*`,
            metadata: { uploadedUrl: reg.url, directUrl: reg.url, vappItem: true },
            status: "uploaded",
            createdAt: new Date().toISOString(),
          },
          ...prev.filter((u: any) => (u?.url || "").split("?")[0] !== cleanUrl),
        ]);
        setUploadState("done");
        setTimeout(() => setContextMenu(null), 1000);
      } else {
        // Local dev (no vApp token): fall back to fetching bytes + file upload.
        const res = await fetch(selectedSrc);
        const blob = await res.blob();
        const rawName = selectedSrc.split("/").pop()?.split("?")[0] || "clip";
        const file = new File([blob], rawName, { type: blob.type || "application/octet-stream" });
        await processFileUpload(`ctx-upload-${Date.now()}`, file, {
          onProgress: () => {},
          onStatus: (_, status) => {
            setUploadState(status === "uploaded" ? "done" : "error");
            if (status === "uploaded") setTimeout(() => setContextMenu(null), 1000);
          },
        });
      }
    } catch {
      setUploadState("error");
    }
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
      {/* Subtle empty-lane pattern behind the (transparent) track canvas, so when there are
          few clips the space below them reads as empty timeline rows instead of a black
          void. The real clips paint on top; this only shows through the empty area. */}
      <div
        className="flex"
        style={{
          // Crisp lane separator line every 44px + a very faint lane fill, so the empty
          // area below the clips clearly reads as timeline rows, not a black void. The
          // real clips paint on top; this only shows through the transparent empty space.
          backgroundImage:
            "repeating-linear-gradient(to bottom, rgba(255,255,255,0.02) 0px, rgba(255,255,255,0.02) 43px, rgba(255,255,255,0.14) 43px, rgba(255,255,255,0.14) 44px)",
        }}
      >
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
        <div
          className="fixed z-[250] min-w-[200px] overflow-hidden rounded-lg border border-border/60 bg-popover shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {canTranscribeSelection && (
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-accent"
              onClick={handleTranscribeSelection}
            >
              <CaptionsIcon size={14} className="text-muted-foreground" />
              Generate transcription
            </button>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-accent"
            onClick={handleDownloadClip}
          >
            <Download size={14} className="text-muted-foreground" />
            Download clip
          </button>
          <button
            type="button"
            disabled={uploadState === "uploading" || uploadState === "done"}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
            onClick={handleUploadToLibrary}
          >
            {uploadState === "uploading" ? (
              <Loader2 size={14} className="animate-spin text-muted-foreground" />
            ) : uploadState === "done" ? (
              <CheckCircle2 size={14} className="text-green-500" />
            ) : (
              <Upload size={14} className="text-muted-foreground" />
            )}
            {uploadState === "uploading" ? "Uploading…" : uploadState === "done" ? "Uploaded!" : "Upload to library"}
          </button>
        </div>
      ) : null}
    </div>
  );
};

export default Timeline;
