import { findIndex } from "./search";
import {
  FRAME_INTERVAL,
  PREVIEW_FRAME_WIDTH,
  TIMELINE_OFFSET_X
} from "../constants/constants";
import { ITimelineScaleState } from "@designcombo/types";
import { TIMELINE_ZOOM_LEVELS } from "../constants/scale";

export function getPreviousZoomLevel(
  currentZoom: ITimelineScaleState
): ITimelineScaleState {
  const previousZoom = getPreviousZoom(currentZoom);

  return previousZoom || TIMELINE_ZOOM_LEVELS[0];
}

export function getZoomByIndex(index: number) {
  // Clamp — an out-of-range index (e.g. -1 from getFitZoomLevel) returns undefined,
  // which the timeline applies as scale=undefined → NaN left/width → every item
  // collapses to the origin ("timeline scatters/breaks"). Never return undefined.
  const i = Math.min(Math.max(index | 0, 0), TIMELINE_ZOOM_LEVELS.length - 1);
  return TIMELINE_ZOOM_LEVELS[i];
}
export function getNextZoomLevel(
  currentZoom: ITimelineScaleState
): ITimelineScaleState {
  const nextZoom = getNextZoom(currentZoom);

  return nextZoom || TIMELINE_ZOOM_LEVELS[TIMELINE_ZOOM_LEVELS.length - 1];
}

export const getPreviousZoom = (
  currentZoom: ITimelineScaleState
): ITimelineScaleState | null => {
  // Filter zoom levels that are smaller than the current zoom
  const smallerZoomLevels = TIMELINE_ZOOM_LEVELS.filter(
    (level) => level.zoom < currentZoom.zoom
  );

  // If there are no smaller zoom levels, return null (no previous zoom)
  if (smallerZoomLevels.length === 0) {
    return null;
  }

  // Get the zoom level with the largest zoom value that's still smaller than the current zoom
  const previousZoom = smallerZoomLevels.reduce((prev, curr) =>
    curr.zoom > prev.zoom ? curr : prev
  );

  return previousZoom;
};

export const getNextZoom = (
  currentZoom: ITimelineScaleState
): ITimelineScaleState | null => {
  // Filter zoom levels that are larger than the current zoom
  const largerZoomLevels = TIMELINE_ZOOM_LEVELS.filter(
    (level) => level.zoom > currentZoom.zoom
  );

  // If there are no larger zoom levels, return null (no next zoom)
  if (largerZoomLevels.length === 0) {
    return null;
  }

  // Get the zoom level with the smallest zoom value that's still larger than the current zoom
  const nextZoom = largerZoomLevels.reduce((prev, curr) =>
    curr.zoom < prev.zoom ? curr : prev
  );

  return nextZoom;
};

export function getFitZoomLevel(
  totalLengthMs: number,
  zoom = 1,
  scrollOffset = 8 // Default fallback value
): ITimelineScaleState {
  const getVisibleWidth = () => {
    const clampedScrollOffset = Math.max(0, scrollOffset);

    const timelineCanvas = document.getElementById(
      "designcombo-timeline-canvas"
    ) as HTMLElement;
    const offsetWidth =
      timelineCanvas?.offsetWidth ?? document.body.offsetWidth;

    // Use 1 to prevent NaN because of dividing by 0.
    return Math.max(1, offsetWidth - clampedScrollOffset);
  };

  const getFullWidth = () => {
    if (typeof totalLengthMs === "number") {
      return timeMsToUnits(totalLengthMs, zoom);
    }

    return calculateTimelineWidth(totalLengthMs, zoom);
  };

  const multiplier = getVisibleWidth() / getFullWidth();
  const targetZoom = zoom * multiplier;

  const fitZoomIndex = findIndex(TIMELINE_ZOOM_LEVELS, (level) => {
    return level.zoom > targetZoom;
  });

  // findIndex returns -1 when the target is more zoomed-in than every level (short
  // clip + Fit) → clamp to the last level so scale.index stays valid (a -1 poisons
  // the zoom slider → undefined scale → NaN item positions).
  const clampedIndex = fitZoomIndex < 0
    ? TIMELINE_ZOOM_LEVELS.length - 1
    : Math.min(fitZoomIndex, TIMELINE_ZOOM_LEVELS.length - 1);

  return {
    segments: 5,
    index: clampedIndex,
    zoom: targetZoom,
    unit: 1 / targetZoom
  };
}

export function timeMsToUnits(timeMs: number, zoom = 1): number {
  const zoomedFrameWidth = PREVIEW_FRAME_WIDTH * zoom;
  const frames = timeMs * (60 / 1000);

  return frames * zoomedFrameWidth;
}

export function unitsToTimeMs(units: number, zoom = 1): number {
  const zoomedFrameWidth = PREVIEW_FRAME_WIDTH * zoom;

  const frames = units / zoomedFrameWidth;

  return frames * FRAME_INTERVAL;
}

export function calculateTimelineWidth(
  totalLengthMs: number,
  zoom = 1
): number {
  return timeMsToUnits(totalLengthMs, zoom);
}
