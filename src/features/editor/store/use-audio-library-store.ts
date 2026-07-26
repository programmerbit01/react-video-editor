import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// The user's OWN curated audio library — Music bed tracks + Sound effects they saved from the
// Stock → Sound live search (Openverse/Freesound/IA). Replaces the tiny bundled synthetic packs:
// nothing is repeated, everything is real, and the user grows/prunes it themselves (add from Stock,
// delete here). Persisted to localStorage (key listed under NEVER_PURGE in build-stamp) so it
// survives deploys — it's user data, not a derived cache.

export interface SavedSound {
  id: string; // stable id (the stock item id, or the src if none)
  name: string;
  src: string; // absolute, directly-playable url
  durationMs?: number;
  author?: string;
  license?: string;
  source?: string; // e.g. "Openverse"
}

interface AudioLibraryState {
  sfx: SavedSound[];
  music: SavedSound[];
  addSfx: (s: SavedSound) => void;
  addMusic: (s: SavedSound) => void;
  removeSfx: (id: string) => void;
  removeMusic: (id: string) => void;
  hasSfx: (src: string) => boolean;
  hasMusic: (src: string) => boolean;
}

// newest first, de-duped by src (adding the same sound twice is a no-op)
const withAdded = (list: SavedSound[], s: SavedSound) =>
  list.some((x) => x.src === s.src) ? list : [{ ...s }, ...list];

const useAudioLibraryStore = create<AudioLibraryState>()(
  persist(
    (set, get) => ({
      sfx: [],
      music: [],
      addSfx: (s) => set((st) => ({ sfx: withAdded(st.sfx, s) })),
      addMusic: (s) => set((st) => ({ music: withAdded(st.music, s) })),
      removeSfx: (id) => set((st) => ({ sfx: st.sfx.filter((x) => x.id !== id) })),
      removeMusic: (id) => set((st) => ({ music: st.music.filter((x) => x.id !== id) })),
      hasSfx: (src) => get().sfx.some((x) => x.src === src),
      hasMusic: (src) => get().music.some((x) => x.src === src),
    }),
    {
      name: "vapp-audio-library",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

export default useAudioLibraryStore;
