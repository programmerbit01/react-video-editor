import TimelineBase from "@designcombo/timeline";
import Video from "./video";
import { throttle } from "lodash";
import Audio from "./audio";
import { TimelineOptions } from "@designcombo/timeline";
import { ITimelineScaleState } from "@designcombo/types";

// 1 frame at 30 fps in milliseconds
const MIN_CLIP_MS = 1000 / 30;

class Timeline extends TimelineBase {
  public isShiftKey: boolean = false;
  constructor(
    canvasEl: HTMLCanvasElement,
    options: Partial<TimelineOptions> & {
      scale: ITimelineScaleState;
      duration: number;
      guideLineColor?: string;
    }
  ) {
    super(canvasEl, options); // Call the parent class constructor

    // Add shift keyboard listener
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);

    // Enforce minimum 1-frame clip duration on every resize tick
    this.on("object:resizing", this.enforceMinDuration as any);
  }

  /**
   * Runs after each resize tick (Fabric fires this after wrapWithFixedAnchor
   * has finished), so the target's width/left/trim are already in their final
   * position for this tick.  If the resulting duration is < 1 frame we nudge
   * width/left/trim back so the clip can never go below 1 frame.
   */
  private enforceMinDuration = (e: any) => {
    const target = e.target;
    if (
      !target?.trim ||
      typeof target.trim.from !== "number" ||
      typeof target.trim.to !== "number"
    ) return;

    const durMs = target.trim.to - target.trim.from;
    if (durMs >= MIN_CLIP_MS || durMs <= 0) return;

    // Compute how many pixels correspond to the missing ms using the current
    // width/duration ratio (avoids hardcoding internal library constants).
    const widthDelta = target.width * (MIN_CLIP_MS / durMs - 1);
    const excessMs   = MIN_CLIP_MS - durMs;
    const corner     = e.transform?.corner;

    if (corner === "mr") {
      // Right handle dragged too far left — push trim.to and width back
      target.trim.to += excessMs;
      target.set("width", target.width + widthDelta);
    } else if (corner === "ml") {
      // Left handle dragged too far right — push trim.from and left back
      target.trim.from -= excessMs;
      target.set("width", target.width + widthDelta);
      target.left -= widthDelta;
    }
  };

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Shift") {
      this.isShiftKey = true;
    }
  };

  private handleKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Shift") {
      this.isShiftKey = false;
    }
  };

  public purge(): void {
    super.purge();

    // Cleanup event listener for Shift key
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
  }

  // Boost hit area for clips that are too narrow to click at current zoom level.
  // We temporarily inflate padding on narrow objects, re-run the hit test,
  // then restore padding — invisible to rendering, only affects selection.
  public findTarget(e: any): any {
    const target = super.findTarget(e);
    if (target) return target;

    const zoom = this.getZoom();
    const MIN_SCREEN_PX = 14;
    const viewportPoint = this.getViewportPoint(e);

    const objects = this.getObjects() as any[];
    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i];
      if (!obj?.selectable || !obj.visible || !obj.evented) continue;
      const widthPx = (obj.width || 0) * zoom;
      if (widthPx >= MIN_SCREEN_PX) continue;

      const savedPadding = obj.padding;
      obj.padding = Math.max(obj.padding, (MIN_SCREEN_PX / zoom - obj.width) / 2 + 2);
      const hit = (this as any)._checkTarget(obj, viewportPoint);
      obj.padding = savedPadding;
      if (hit) return obj;
    }

    return undefined;
  }

  public setViewportPos(posX: number, posY: number) {
    const limitedPos = this.getViewportPos(posX, posY);
    const vt = this.viewportTransform;
    vt[4] = limitedPos.x;
    vt[5] = limitedPos.y;
    this.requestRenderAll();
    this.setActiveTrackItemCoords();
    this.onScrollChange();

    this.onScroll?.({
      scrollTop: limitedPos.y,
      scrollLeft: limitedPos.x - this.spacing.left
    });
  }

  public onScrollChange = throttle(async () => {
    const objects = this.getObjects();
    const viewportTransform = this.viewportTransform;
    const scrollLeft = viewportTransform[4];
    for (const object of objects) {
      if (object instanceof Video || object instanceof Audio) {
        object.onScrollChange({ scrollLeft });
      }
    }
  }, 250);

  public scrollTo({
    scrollLeft,
    scrollTop
  }: {
    scrollLeft?: number;
    scrollTop?: number;
  }): void {
    const vt = this.viewportTransform; // Create a shallow copy
    let hasChanged = false;

    if (typeof scrollLeft === "number") {
      vt[4] = -scrollLeft + this.spacing.left;
      hasChanged = true;
    }
    if (typeof scrollTop === "number") {
      vt[5] = -scrollTop;
      hasChanged = true;
    }

    if (hasChanged) {
      this.viewportTransform = vt;
      this.getActiveObject()?.setCoords();
      this.onScrollChange();
      this.requestRenderAll();
    }
  }
}

export default Timeline;
