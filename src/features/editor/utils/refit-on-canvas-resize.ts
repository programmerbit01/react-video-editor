// ─────────────────────────────────────────────────────────────────────────────
// refit-on-canvas-resize — re-fit every clip when the canvas aspect ratio changes.
//
// WHY THIS EXISTS. `DESIGN_RESIZE` (the event the canvas-size dropdown / Resize
// popover dispatch) does ONE thing in @designcombo/state:
//
//     if (f.key === DESIGN_RESIZE) t.updateState({ size: payload }, ...)
//
// It changes `size` and touches nothing else. But a clip's placement is ABSOLUTE:
// on ADD the library stores, into `details`, a centred `left`/`top` and a
// `transform: scale(a)` computed for the canvas that was current AT THAT MOMENT
// (a = min(canvasW/intrinsicW, canvasH/intrinsicH) — a contain fit). `styles.ts`
// (`calculateContainerStyles`) then renders the clip at exactly those stored
// values — there is no re-fit at render time.
//
// So after 16:9 → 9:16 a clip keeps its 16:9 left/top/scale and lands small and
// off-centre in the new frame (a 9:16 video no longer fills a 9:16 canvas). This
// recomputes each clip's placement for the NEW size, the SAME way the library
// places a clip on add — the standard, contain fit — so the result is identical to
// having added the clip into the new canvas.
//
//   • video / image : contain fit — scale = min(cw/iw, ch/ih), centred. The
//                     library's own add-default (its `scaleMode` is contain).
//   • text / caption: kept where it was, proportionally — only left/top are remapped
//                     into the new frame; size/scale untouched, so nothing reflows or
//                     breaks (captions are sensitive; we do NOT re-fit them).
//   • audio / other : no on-screen geometry → skipped.
//
// The result is a SINGLE EDIT_OBJECT payload (`{ [id]: { details: patch } }`) — the
// details patch MERGES, so only left/top/(transform) change and everything else on
// the clip is preserved. One dispatch for all clips = no per-item races and a single
// clean undo step (matches how operations.ts batches multi-item edits).
// ─────────────────────────────────────────────────────────────────────────────

export interface CanvasSize {
  width: number;
  height: number;
}

/** Parse "420px" / 420 / "420" → 420; anything unusable → fallback. */
const num = (v: unknown, fallback = 0): number => {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
};

type DetailPatch = { details: Record<string, unknown> };

/**
 * Build the EDIT_OBJECT payload that re-fits every clip from `oldSize` to `newSize`.
 * Returns an empty object when there is nothing to move (caller can skip dispatch).
 */
export function buildCanvasRefitPayload(
  oldSize: CanvasSize,
  newSize: CanvasSize,
  trackItemsMap: Record<string, unknown>,
): Record<string, DetailPatch> {
  const cw = num(newSize?.width);
  const ch = num(newSize?.height);
  if (cw <= 0 || ch <= 0) return {};

  const ratioX = num(oldSize?.width) > 0 ? cw / num(oldSize.width) : 1;
  const ratioY = num(oldSize?.height) > 0 ? ch / num(oldSize.height) : 1;

  const payload: Record<string, DetailPatch> = {};

  for (const [id, raw] of Object.entries(trackItemsMap || {})) {
    const item = raw as { type?: string; details?: Record<string, unknown> } | null;
    const type = item?.type;
    const details = item?.details || {};

    if (type === "video" || type === "image") {
      // Intrinsic media size is what the library fits (details.width/height), not crop.
      const iw = num(details.width, cw);
      const ih = num(details.height, ch);
      if (iw <= 0 || ih <= 0) continue; // no intrinsic size yet → leave it alone
      const scale = Math.min(cw / iw, ch / ih); // contain — identical to add-default
      payload[id] = {
        details: {
          left: `${(cw - iw) / 2}px`,
          top: `${(ch - ih) / 2}px`,
          transform: `scale(${scale})`,
        },
      };
    } else if (type === "text" || type === "caption") {
      // Preserve relative position: remap the top-left into the new frame only.
      payload[id] = {
        details: {
          left: `${num(details.left) * ratioX}px`,
          top: `${num(details.top) * ratioY}px`,
        },
      };
    }
    // audio (and anything without geometry) is intentionally left untouched.
  }

  return payload;
}
