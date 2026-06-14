import { create } from "zustand";

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

const useCaptionTranscribeStore = create<CaptionTranscribeState>((set) => ({
  pendingMediaSrc: null,
  resultsByMedia: {},
  requestTranscription: (mediaSrc) => set({ pendingMediaSrc: mediaSrc }),
  clearPendingRequest: () => set({ pendingMediaSrc: null }),
  setTranscriptResult: (mediaSrc, result) =>
    set((state) => ({
      resultsByMedia: {
        ...state.resultsByMedia,
        [mediaSrc]: result
      }
    }))
}));

export default useCaptionTranscribeStore;
