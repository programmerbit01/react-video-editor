/**
 * Ken Burns effect — slow pan / zoom on stills (and optionally video).
 *
 * The chosen effect is stored on the item as `details.kenBurns` (a string kind).
 * It is read by the Image/Video renderers and turned into an animated CSS
 * transform driven by the current frame. Pans use a slight base zoom so the
 * image edges never show while translating.
 *
 * Keep the kinds list in sync with:
 *  - editor GUI dropdown (control-item/animations.tsx)
 *  - vapp_server _normalize_design / render_project schema (MCP side)
 */

export const KEN_BURNS_KINDS = [
  "off",
  "zoomIn",
  "zoomOut",
  "panLeft",
  "panRight",
  "panUp",
  "panDown",
  "zoomInPanLeft",
  "zoomInPanRight",
] as const;

export type KenBurnsKind = (typeof KEN_BURNS_KINDS)[number];

const ZOOM = 0.08; // ~8% zoom travel
const PAN = 4; // ~4% translate travel (needs base zoom so edges stay covered)

/**
 * Returns a CSS transform string for the given Ken Burns kind at `frame`,
 * or undefined when the effect is off / unknown (caller leaves transform as-is).
 */
export function kenBurnsTransform(
  kind: string | undefined,
  frame: number,
  durationInFrames: number,
): string | undefined {
  if (!kind || kind === "off" || kind === "none") return undefined;
  // progress 0 → 1 across the clip, clamped
  const p =
    durationInFrames > 0
      ? Math.min(1, Math.max(0, frame / durationInFrames))
      : 0;

  switch (kind) {
    case "zoomIn":
      return `scale(${1 + ZOOM * p})`;
    case "zoomOut":
      return `scale(${1 + ZOOM * (1 - p)})`;
    case "panLeft":
      return `scale(1.1) translateX(${-PAN * p}%)`;
    case "panRight":
      return `scale(1.1) translateX(${PAN * p}%)`;
    case "panUp":
      return `scale(1.1) translateY(${-PAN * p}%)`;
    case "panDown":
      return `scale(1.1) translateY(${PAN * p}%)`;
    case "zoomInPanLeft":
      return `scale(${1.05 + ZOOM * p}) translateX(${-PAN * p}%)`;
    case "zoomInPanRight":
      return `scale(${1.05 + ZOOM * p}) translateX(${PAN * p}%)`;
    default:
      return `scale(${1 + ZOOM * p})`;
  }
}
