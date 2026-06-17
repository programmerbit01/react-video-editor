export interface AnimationOverlay {
  hasIn: boolean;
  hasOut: boolean;
  inDurMs: number;
  outDurMs: number;
}

/** itemId → animation overlay data. Canvas items read this in _render(). */
export const AnimationOverlayStore: Record<string, AnimationOverlay> = {};
