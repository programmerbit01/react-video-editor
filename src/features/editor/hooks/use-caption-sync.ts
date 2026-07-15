import { useEffect } from "react";
import StateManager from "@designcombo/state";
import useStore from "../store/use-store";

// Keep committed caption items GLUED to their source clip. When a clip is moved along
// the timeline, its captions shift by the same amount (users expect captions to travel
// with their clip). The stable anchor is `metadata.relFrom/relTo` — the caption's offset
// from the clip's start. New captions carry it from buildCaptionItem; imported captions
// (which lack it) are anchored once from their current, correct position.
//
// Reacts to trackItemsMap changes. Only writes when something actually drifts, and the
// correction makes the next pass a no-op (drift → 0), so there is no update loop. Writes
// with updateHistory:false so it never pollutes undo.
export default function useCaptionSync(stateManager: StateManager) {
  const { trackItemsMap } = useStore();

  useEffect(() => {
    const state = stateManager.getState();
    const map: Record<string, any> = state?.trackItemsMap || {};
    let changed = false;
    const next: Record<string, any> = { ...map };

    for (const id of Object.keys(map)) {
      const cap = map[id];
      if (cap?.type !== "caption" || !cap?.metadata?.addedCaption) continue;
      const clipId = cap.metadata.sourceTrackItemId;
      const clip = clipId ? map[clipId] : undefined;
      if (!clip) continue;

      const clipFrom = Number(clip.display?.from || 0);
      let relFrom = cap.metadata.relFrom;
      let relTo = cap.metadata.relTo;

      // Anchor once for captions that don't carry an offset yet (imported).
      if (typeof relFrom !== "number" || typeof relTo !== "number") {
        relFrom = Number(cap.display?.from || 0) - clipFrom;
        relTo = Number(cap.display?.to || 0) - clipFrom;
        next[id] = { ...cap, metadata: { ...cap.metadata, relFrom, relTo } };
        changed = true;
        continue;
      }

      const expFrom = clipFrom + relFrom;
      const expTo = clipFrom + relTo;
      if (Math.abs(Number(cap.display?.from || 0) - expFrom) > 0.5 ||
          Math.abs(Number(cap.display?.to || 0) - expTo) > 0.5) {
        next[id] = { ...cap, display: { ...cap.display, from: expFrom, to: expTo } };
        changed = true;
      }
    }

    if (changed) {
      stateManager.updateState({ trackItemsMap: next }, { updateHistory: false });
    }
  }, [stateManager, trackItemsMap]);
}
