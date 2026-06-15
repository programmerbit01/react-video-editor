import { create } from "zustand";

interface TrackVisibilityStore {
  hidden: Record<string, boolean>;
  muted: Record<string, boolean>;
  toggleHidden: (trackId: string) => void;
  toggleMuted: (trackId: string) => void;
}

const useTrackVisibilityStore = create<TrackVisibilityStore>((set) => ({
  hidden: {},
  muted: {},
  toggleHidden: (id) =>
    set((s) => ({ hidden: { ...s.hidden, [id]: !s.hidden[id] } })),
  toggleMuted: (id) =>
    set((s) => ({ muted: { ...s.muted, [id]: !s.muted[id] } }))
}));

export default useTrackVisibilityStore;
