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
  /** Media currently being transcribed, keyed by src. Lives here, NOT in the panel: the job
   *  outlives the panel, so switching tabs mid-transcribe used to lose the spinner while the
   *  request carried on in the background. */
  generatingByMedia: Record<string, boolean>;
  /** Last error per media, so it survives a remount the same way. */
  errorByMedia: Record<string, string>;
  /** The media item last selected on the timeline. Opening a menu clears activeIds
   *  (menu-list.tsx clearActiveSelection), so by the time the Captions panel mounts the
   *  selection is already gone — it has to be remembered before that happens. */
  lastSourceId: string | null;
  requestTranscription: (mediaSrc: string) => void;
  clearPendingRequest: () => void;
  setTranscriptResult: (mediaSrc: string, result: TranscriptResult) => void;
  setGenerating: (mediaSrc: string, generating: boolean) => void;
  setError: (mediaSrc: string, error: string) => void;
  setLastSource: (id: string) => void;
}

// Persist `resultsByMedia` (keyed by the audio's src) so a generated transcript
// survives an editor refresh — the audio's captions/word-timestamps auto-restore
// (from the built-in Captions tab AND AI Edit script-sync) without re-generating.
const useCaptionTranscribeStore = create<CaptionTranscribeState>()(
  persist(
    (set) => ({
      pendingMediaSrc: null,
      resultsByMedia: {},
      generatingByMedia: {},
      errorByMedia: {},
      lastSourceId: null,
      requestTranscription: (mediaSrc) => set({ pendingMediaSrc: mediaSrc }),
      clearPendingRequest: () => set({ pendingMediaSrc: null }),
      setTranscriptResult: (mediaSrc, result) =>
        set((state) => ({
          resultsByMedia: {
            ...state.resultsByMedia,
            [mediaSrc]: result,
          },
        })),
      setGenerating: (mediaSrc, generating) =>
        set((state) => ({
          generatingByMedia: { ...state.generatingByMedia, [mediaSrc]: generating },
        })),
      setError: (mediaSrc, error) =>
        set((state) => ({ errorByMedia: { ...state.errorByMedia, [mediaSrc]: error } })),
      setLastSource: (id) => set({ lastSourceId: id }),
    }),
    {
      name: "vapp-caption-transcripts",
      storage: createJSONStorage(() => localStorage),
      // Only the RESULTS persist. generatingByMedia stays in memory on purpose: a refresh kills
      // the in-flight request, so a persisted "generating" flag would spin forever.
      partialize: (s) => ({ resultsByMedia: s.resultsByMedia }),
    }
  )
);

export default useCaptionTranscribeStore;
