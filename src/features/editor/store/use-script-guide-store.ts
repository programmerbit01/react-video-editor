import { create } from "zustand";

export type SegmentType = "avatar" | "broll";

export type MarkType =
  | "hook"
  | "open-loop"
  | "context-build"
  | "pattern-interrupt"
  | "payoff"
  | "retention-peak"
  | "cta";

export interface ScriptSegment {
  type: SegmentType;
  time: string;
  text: string;
  note?: string;
  search?: string[];
  mark?: MarkType | string;
  // parsed internally — not in user JSON
  startMs?: number;
  endMs?: number;
}

export type FontSizeKey = "S" | "M" | "L";
export const FONT_SIZE_MAP: Record<FontSizeKey, number> = { S: 10, M: 12, L: 15 };

interface ScriptGuideState {
  segments: ScriptSegment[];
  rawJson: string;
  isOpen: boolean;
  floatPos: { x: number; y: number };
  panelSize: { width: number; height: number };
  isCollapsed: boolean;
  showInput: boolean;
  activeSegmentIndex: number;
  fontSizeKey: FontSizeKey;
  setSegments: (segments: ScriptSegment[], raw: string) => void;
  clearSegments: () => void;
  setOpen: (val: boolean) => void;
  setFloatPos: (pos: { x: number; y: number }) => void;
  setPanelSize: (size: { width: number; height: number }) => void;
  setCollapsed: (val: boolean) => void;
  setShowInput: (val: boolean) => void;
  setActiveSegment: (index: number) => void;
  setFontSizeKey: (key: FontSizeKey) => void;
}

// "M:SS" or "H:MM:SS" → milliseconds
export function parseTimeToMs(t: string): number {
  const parts = t.trim().split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return 0;
}

function parseSegmentTimes(seg: ScriptSegment): ScriptSegment {
  const [startStr, endStr] = seg.time.split(/\s*[-–]\s*/);
  return {
    ...seg,
    startMs: parseTimeToMs(startStr || ""),
    endMs: parseTimeToMs(endStr || ""),
  };
}

const useScriptGuideStore = create<ScriptGuideState>((set) => ({
  segments: [],
  rawJson: "",
  isOpen: false,
  floatPos: { x: typeof window !== "undefined" ? window.innerWidth - 340 : 900, y: 60 },
  panelSize: { width: 300, height: 500 },
  isCollapsed: false,
  showInput: true,
  activeSegmentIndex: -1,
  fontSizeKey: "M",

  setSegments: (segments, raw) =>
    set({ segments: segments.map(parseSegmentTimes), rawJson: raw, showInput: false }),

  clearSegments: () => set({ segments: [], rawJson: "", showInput: true, activeSegmentIndex: -1 }),

  setOpen: (val) => set({ isOpen: val }),
  setFloatPos: (pos) => set({ floatPos: pos }),
  setPanelSize: (size) => set({ panelSize: size }),
  setCollapsed: (val) => set({ isCollapsed: val }),
  setShowInput: (val) => set({ showInput: val }),
  setActiveSegment: (index) => set({ activeSegmentIndex: index }),
  setFontSizeKey: (key) => set({ fontSizeKey: key }),
}));

export default useScriptGuideStore;
