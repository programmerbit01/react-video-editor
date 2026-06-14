import { create } from "zustand";

export interface SelectedTranscriptGuide {
  itemId: string;
  segmentIndex: number;
  startMs: number;
  endMs: number;
  defaultEndMs: number;
}

interface TranscriptGuideState {
  selectedGuide: SelectedTranscriptGuide | null;
  draggingItemId: string | null;
  selectGuide: (guide: SelectedTranscriptGuide) => void;
  setGuideEnd: (endMs: number) => void;
  startDragging: (itemId: string) => void;
  stopDragging: () => void;
  clearGuide: () => void;
}

const useTranscriptGuideStore = create<TranscriptGuideState>((set) => ({
  selectedGuide: null,
  draggingItemId: null,
  selectGuide: (guide) => set({ selectedGuide: guide }),
  setGuideEnd: (endMs) =>
    set((state) => ({
      selectedGuide: state.selectedGuide
        ? {
            ...state.selectedGuide,
            endMs
          }
        : null
    })),
  startDragging: (itemId) => set({ draggingItemId: itemId }),
  stopDragging: () => set({ draggingItemId: null }),
  clearGuide: () => set({ selectedGuide: null, draggingItemId: null })
}));

export default useTranscriptGuideStore;
