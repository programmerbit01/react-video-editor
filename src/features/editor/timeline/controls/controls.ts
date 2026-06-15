import { controlsUtils, Control, resize } from "@designcombo/timeline";
import {
  drawVerticalLeftIcon,
  drawVerticalLine,
  drawVerticalRightIcon
} from "./draw";

const { scaleSkewCursorStyleHandler } = controlsUtils;

const FPS = 30;
const MIN_DURATION_MS = 1000 / FPS; // ~33 ms = 1 frame

/**
 * Wraps a resize action handler to enforce a minimum clip duration of 1 frame.
 * Captures pre-resize state; if the result would be < 1 frame, reverts and
 * returns false (Fabric.js interprets false as "no change", stops firing modified).
 */
function withMinDuration(originalHandler: any): any {
  return (eventData: any, transform: any, x: number, y: number): boolean => {
    const target = transform.target as any;

    // Capture state before the resize so we can roll back
    const prevWidth    = target.width;
    const prevLeft     = target.left;
    const hasTrim      = target.trim && typeof target.trim.from === "number";
    const prevTrimFrom = hasTrim ? target.trim.from : null;
    const prevTrimTo   = hasTrim ? target.trim.to   : null;

    const changed = originalHandler(eventData, transform, x, y);

    if (changed) {
      const tooSmall = hasTrim
        ? (target.trim.to - target.trim.from) < MIN_DURATION_MS
        : target.width < 1;

      if (tooSmall) {
        // Revert to the state just before this drag tick
        target.set("width", prevWidth);
        target.left = prevLeft;
        if (hasTrim) {
          target.trim.from = prevTrimFrom;
          target.trim.to   = prevTrimTo;
        }
        return false;
      }
    }

    return changed;
  };
}

export const createResizeControls = () => ({
  mr: new Control({
    x: 0.5,
    y: 0,
    render: drawVerticalRightIcon,
    actionHandler: withMinDuration(resize.common),
    cursorStyleHandler: scaleSkewCursorStyleHandler,
    actionName: "resizing",
    sizeX: 14,
    sizeY: 32,
    offsetX: 0
  }),
  ml: new Control({
    x: -0.5,
    y: 0,
    actionHandler: withMinDuration(resize.common),
    cursorStyleHandler: scaleSkewCursorStyleHandler,
    actionName: "resizing",
    render: drawVerticalLeftIcon,
    sizeX: 14,
    sizeY: 32,
    offsetX: 0
  })
});

export const createAudioControls = () => ({
  mr: new Control({
    x: 0.5,
    y: 0,
    render: drawVerticalRightIcon,
    actionHandler: withMinDuration(resize.audio),
    cursorStyleHandler: scaleSkewCursorStyleHandler,
    actionName: "resizing",
    sizeX: 14,
    sizeY: 32,
    offsetX: 0
  }),
  ml: new Control({
    x: -0.5,
    y: 0,
    render: drawVerticalLeftIcon,
    actionHandler: withMinDuration(resize.audio),
    cursorStyleHandler: scaleSkewCursorStyleHandler,
    actionName: "resizing",
    sizeX: 14,
    sizeY: 32,
    offsetX: 0
  })
});

export const createMediaControls = () => ({
  mr: new Control({
    x: 0.5,
    y: 0,
    actionHandler: withMinDuration(resize.media),
    render: drawVerticalRightIcon,
    cursorStyleHandler: scaleSkewCursorStyleHandler,
    actionName: "resizing",
    sizeX: 14,
    sizeY: 32,
    offsetX: 0
  }),
  ml: new Control({
    x: -0.5,
    y: 0,
    render: drawVerticalLeftIcon,
    actionHandler: withMinDuration(resize.media),
    cursorStyleHandler: scaleSkewCursorStyleHandler,
    actionName: "resizing",
    sizeX: 14,
    sizeY: 32,
    offsetX: 0
  })
});

export const createTransitionControls = () => ({
  mr: new Control({
    x: 0.5,
    y: 0,
    actionHandler: resize.transition,
    cursorStyleHandler: scaleSkewCursorStyleHandler,
    actionName: "resizing",
    render: drawVerticalLine
  }),
  ml: new Control({
    x: -0.5,
    y: 0,
    actionHandler: resize.transition,
    cursorStyleHandler: scaleSkewCursorStyleHandler,
    actionName: "resizing",
    render: drawVerticalLine
  })
});
