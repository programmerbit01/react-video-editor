import { dispatch } from "@designcombo/events";
import { EDIT_OBJECT } from "@designcombo/state";
import useStore from "../store/use-store";

// Apply the SAME change to EVERY currently-selected clip in one EDIT_OBJECT (fan-out).
//
// The control panels used to dispatch `{ [trackItem.id]: changes }` — one clip only. With a
// whole-row (multi) selection that meant only the representative clip changed. This fans the same
// `changes` object across all `activeIds`, so a property/effect set on the panel lands on every
// selected clip at once. A single selection is just a one-entry payload, so single-edit is
// byte-for-byte unchanged.
//
// ONE dispatch (not N) on purpose: designcombo's reducer is async and "only the last dispatch
// sticks", so N separate EDIT_OBJECTs would clobber each other (the same bug applyMotionBatch fixed).
export function editSelected(changes: Record<string, any>): void {
  const ids = useStore.getState().activeIds || [];
  if (!ids.length) return;
  const payload: Record<string, any> = {};
  for (const id of ids) payload[id] = changes;
  dispatch(EDIT_OBJECT, { payload });
}
