/**
 * Ken Burns effect — slow pan / zoom on stills (and optionally video).
 *
 * Stored on the item as:
 *   details.kenBurns           kind ("zoomIn" | "panLeft" | ...; "off" = none)
 *   details.kenBurnsIntensity  how much motion, as % of zoom travel (default 8)
 *   details.kenBurnsSmooth     boolean — ease in/out instead of linear
 *
 * Read by the Image/Video renderers and turned into an animated CSS transform
 * driven by the current frame. Pans use enough base zoom that edges never show.
 *
 * Keep the kinds list in sync with the editor GUI dropdown
 * (control-item/animations.tsx) and the MCP schema (vapp_server_mcp.py).
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

export interface KenBurnsOpts {
  intensity?: number; // % zoom travel (default 8). Clamped 1–40.
  smooth?: boolean; // ease in/out instead of linear
  duration?: number; // % of the clip the motion plays over (default 100).
  //                    lower = quicker "punch" that then HOLDS for the rest.
}

const DEFAULT_INTENSITY = 8;

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Returns a CSS transform string for the given Ken Burns kind at `frame`,
 * or undefined when the effect is off / unknown.
 */
export function kenBurnsTransform(
  kind: string | undefined,
  frame: number,
  durationInFrames: number,
  opts: KenBurnsOpts = {},
): string | undefined {
  if (!kind || kind === "off" || kind === "none") return undefined;

  // raw progress 0 → 1 across the clip
  const raw =
    durationInFrames > 0 ? Math.min(1, Math.max(0, frame / durationInFrames)) : 0;
  // Motion length: complete the move within `duration`% of the clip, then HOLD.
  // duration=100 → moves over the whole clip (slow). duration=25 → quick punch
  // in the first quarter, then frozen → snappy, attention-grabbing.
  const motion = clamp(Number(opts.duration ?? 100) || 100, 5, 100) / 100;
  let p = Math.min(1, raw / motion);
  // optional ease in/out (easeInOutQuad) for a softer move
  if (opts.smooth) p = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;

  const intensity = clamp(Number(opts.intensity ?? DEFAULT_INTENSITY) || DEFAULT_INTENSITY, 1, 40);
  const ZOOM = intensity / 100; // e.g. 8 → 0.08 (8% zoom)
  const PAN = intensity / 2; // % translate
  // base zoom for pans so the (translated) image always covers the frame
  const panBase = 1 + (PAN / 100) * 2 + 0.05;

  switch (kind) {
    case "zoomIn":
      return `scale(${1 + ZOOM * p})`;
    case "zoomOut":
      return `scale(${1 + ZOOM * (1 - p)})`;
    case "panLeft":
      return `scale(${panBase}) translateX(${-PAN * p}%)`;
    case "panRight":
      return `scale(${panBase}) translateX(${PAN * p}%)`;
    case "panUp":
      return `scale(${panBase}) translateY(${-PAN * p}%)`;
    case "panDown":
      return `scale(${panBase}) translateY(${PAN * p}%)`;
    case "zoomInPanLeft":
      return `scale(${panBase + ZOOM * p}) translateX(${-PAN * p}%)`;
    case "zoomInPanRight":
      return `scale(${panBase + ZOOM * p}) translateX(${PAN * p}%)`;
    default:
      return `scale(${1 + ZOOM * p})`;
  }
}
