export interface OverlayWord {
  word: string;
  startMs: number; // source-media ms
  endMs: number;
}

export interface OverlaySegment {
  displayFrom: number; // timeline ms
  displayTo: number;
  text: string;
  words: OverlayWord[];
}

/** itemId → segments.  Canvas items read this in _render(). */
export const TranscriptOverlayStore: Record<string, OverlaySegment[]> = {};
