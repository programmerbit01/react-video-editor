import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
}

export interface TranscriptResult {
  text: string;
  language: string;
  segment_count: number;
  segments: TranscriptSegment[];
}

interface CaptionTranscribeState {
  pendingMediaSrc: string | null;
  resultsByMedia: Record<string, TranscriptResult>;
  requestTranscription: (mediaSrc: string) => void;
  clearPendingRequest: () => void;
  setTranscriptResult: (mediaSrc: string, result: TranscriptResult) => void;
}

// Persist `resultsByMedia` (keyed by the audio's src) so a generated transcript
// survives an editor refresh — the audio's captions/word-timestamps auto-restore
// (from the built-in Captions tab AND AI Edit script-sync) without re-generating.
const useCaptionTranscribeStore = create<CaptionTranscribeState>()(
  persist(
    (set) => ({
      pendingMediaSrc: null,
      resultsByMedia: {},
      requestTranscription: (mediaSrc) => set({ pendingMediaSrc: mediaSrc }),
      clearPendingRequest: () => set({ pendingMediaSrc: null }),
      setTranscriptResult: (mediaSrc, result) =>
        set((state) => ({
          resultsByMedia: {
            ...state.resultsByMedia,
            [mediaSrc]: result,
          },
        })),
    }),
    {
      name: "vapp-caption-transcripts",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ resultsByMedia: s.resultsByMedia }),
    }
  )
);

export default useCaptionTranscribeStore;
