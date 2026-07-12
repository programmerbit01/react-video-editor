import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { AiEditOp } from "../ai-edit/operations";

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  reasoning?: string; // streamed "thinking"
  reasoningMs?: number; // how long it thought (ms)
  thinkingOpen?: boolean; // reasoning box expanded
  ops?: AiEditOp[]; // proposed operations (assistant)
  applied?: boolean;
  reverted?: boolean;
  snapshot?: Record<string, any>; // pre-apply state for inline revert
  historyId?: string;
  genStatus?: string; // background generation status (queued #, %, ✓/⚠️)
  genPreviews?: { kind: string; url: string }[]; // generated media previews
}

export interface ChatModel {
  id: string;
  label: string;
}

export interface HistoryEntry {
  id: string;
  time: string;
  summary: string;
  ops: AiEditOp[];
  snapshot: Record<string, any>;
  reverted?: boolean;
}

interface AiEditState {
  // shell
  isOpen: boolean;
  isFullscreen: boolean;
  floatPos: { x: number; y: number };
  panelSize: { width: number; height: number };
  isCollapsed: boolean;

  // views / settings
  showHistory: boolean;
  showFeatures: boolean;
  showSettings: boolean;
  streaming: boolean;
  showThinking: boolean;
  autoApply: boolean; // Auto = apply without asking; false = Ask (preview first)

  // chat + ops
  messages: ChatMsg[];
  input: string;
  busy: boolean;
  model: string;
  models: ChatModel[];
  history: HistoryEntry[];
  transcript: { key: string; segments: { start: number; end: number; text: string }[] } | null;

  setOpen: (v: boolean) => void;
  setFullscreen: (v: boolean) => void;
  setFloatPos: (p: { x: number; y: number }) => void;
  setPanelSize: (s: { width: number; height: number }) => void;
  setCollapsed: (v: boolean) => void;

  setShowHistory: (v: boolean) => void;
  setShowFeatures: (v: boolean) => void;
  setShowSettings: (v: boolean) => void;
  setStreaming: (v: boolean) => void;
  setShowThinking: (v: boolean) => void;
  setAutoApply: (v: boolean) => void;

  setInput: (v: string) => void;
  setBusy: (v: boolean) => void;
  addMessage: (m: ChatMsg) => void;
  updateLast: (patch: Partial<ChatMsg>) => void;
  updateAt: (i: number, patch: Partial<ChatMsg>) => void;
  clearChat: () => void;
  setModel: (m: string) => void;
  setModels: (m: ChatModel[]) => void;
  setTranscript: (t: { key: string; segments: { start: number; end: number; text: string }[] } | null) => void;
  addHistory: (e: HistoryEntry) => void;
  markReverted: (id: string) => void;
}

const useAiEditStore = create<AiEditState>()(
  persist(
    (set) => ({
  isOpen: true,
  isFullscreen: false,
  floatPos: { x: typeof window !== "undefined" ? window.innerWidth - 360 : 900, y: 60 },
  panelSize: {
    width: typeof window !== "undefined" ? Math.round(window.innerWidth * 0.24) : 340,
    height: typeof window !== "undefined" ? window.innerHeight - 120 : 600,
  },
  isCollapsed: false,

  showHistory: false,
  showFeatures: false,
  showSettings: false,
  streaming: true,
  showThinking: true,
  autoApply: false,

  messages: [],
  input: "",
  busy: false,
  model: "",
  models: [],
  history: [],
  transcript: null,

  setOpen: (v) => set({ isOpen: v }),
  setFullscreen: (v) => set({ isFullscreen: v }),
  setFloatPos: (p) => set({ floatPos: p }),
  setPanelSize: (s) => set({ panelSize: s }),
  setCollapsed: (v) => set({ isCollapsed: v }),

  setShowHistory: (v) => set({ showHistory: v, showFeatures: false }),
  setShowFeatures: (v) => set({ showFeatures: v }),
  setShowSettings: (v) => set({ showSettings: v }),
  setStreaming: (v) => set({ streaming: v }),
  setShowThinking: (v) => set({ showThinking: v }),
  setAutoApply: (v) => set({ autoApply: v }),

  setInput: (v) => set({ input: v }),
  setBusy: (v) => set({ busy: v }),
  addMessage: (m) => set((st) => ({ messages: [...st.messages, m] })),
  updateLast: (patch) =>
    set((st) => {
      const n = [...st.messages];
      if (n.length) n[n.length - 1] = { ...n[n.length - 1], ...patch };
      return { messages: n };
    }),
  updateAt: (i, patch) =>
    set((st) => {
      const n = [...st.messages];
      if (n[i]) n[i] = { ...n[i], ...patch };
      return { messages: n };
    }),
  clearChat: () => set({ messages: [] }),
  setModel: (m) => set({ model: m }),
  setModels: (m) => set({ models: m }),
  setTranscript: (t) => set({ transcript: t }),
  addHistory: (e) => set((st) => ({ history: [e, ...st.history] })),
  markReverted: (id) =>
    set((st) => ({ history: st.history.map((h) => (h.id === id ? { ...h, reverted: true } : h)) })),
    }),
    {
      name: "vapp-ai-edit",
      storage: createJSONStorage(() => localStorage),
      // Persist prefs/position only — NOT isOpen (defaults OPEN on every editor load) or chat.
      partialize: (st) => ({
        floatPos: st.floatPos,
        panelSize: st.panelSize,
        isCollapsed: st.isCollapsed,
        streaming: st.streaming,
        showThinking: st.showThinking,
        autoApply: st.autoApply,
        model: st.model,
      }),
    }
  )
);

export default useAiEditStore;
