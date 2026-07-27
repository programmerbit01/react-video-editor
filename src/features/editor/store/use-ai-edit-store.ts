import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { AiEditOp } from "../ai-edit/operations";

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  reasoning?: string; // streamed "thinking"
  reasoningMs?: number; // how long it thought (ms)
  thinkingOpen?: boolean; // reasoning box expanded
  scriptText?: string; // pipeline: the pre-written narration, shown in a collapsible box
  scriptOpen?: boolean; // script box expanded (open while it streams, auto-collapses when done)
  directText?: string; // pipeline: the raw scene-plan JSON as it streams (hidden in a collapsible, not the wall)
  directOpen?: boolean; // directing box expanded (open while streaming, collapses when parsed)
  ops?: AiEditOp[]; // proposed operations (assistant)
  applied?: boolean;
  reverted?: boolean;
  snapshot?: Record<string, any>; // pre-apply state for inline revert
  historyId?: string;
  genStatus?: string; // background generation status (queued #, %, ✓/⚠️) — per-shot detail, flickers
  buildProgress?: string; // PERSISTENT aggregate counter during a build ("4/10 · 8 img · 2 vid") — never clobbered by per-shot genStatus
  genPreviews?: { kind: string; url: string }[]; // generated media previews
  // BEAT MODEL — the shared context a pipeline build produces: each shot's timeline slot +
  // the narration spoken during it (+ neighbours are derivable by index). Arrange uses it;
  // animate / effects / lip-sync read it so their motion/prompts are context-aware.
  beats?: { itemId: string; fromMs: number; toMs: number; text: string }[];
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
  optimizePrompt: boolean; // enrich image/video prompts via /vapp/llm before generating (independent of vApp Studio)
  autoApply: boolean; // Auto = apply without asking; false = Ask (preview first)

  // chat + ops
  messages: ChatMsg[];
  input: string;
  busy: boolean;
  model: string;
  pipeline: string; // "" = normal Edit ; "comic_drama" | "faceless_video" = pipeline mode (swaps the system prompt)
  vibe: string; // "" = none ; a VIBE preset id (fast_drama / cinematic / …) — injects a style phrase into the prompt + timing
  customVibes: { id: string; label: string; style: string }[]; // user-added P presets — prompt snippets (persisted)
  customDirectors: { id: string; label: string; systemPrompt: string }[]; // user-added S/D presets — director system prompts (persisted)
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
  setOptimizePrompt: (v: boolean) => void;

  setInput: (v: string) => void;
  setBusy: (v: boolean) => void;
  addMessage: (m: ChatMsg) => void;
  updateLast: (patch: Partial<ChatMsg>) => void;
  updateAt: (i: number, patch: Partial<ChatMsg>) => void;
  clearChat: () => void;
  setModel: (m: string) => void;
  setPipeline: (v: string) => void;
  setVibe: (v: string) => void;
  addCustomVibe: (label: string, style: string) => string;
  updateCustomVibe: (id: string, label: string, style: string) => void;
  removeCustomVibe: (id: string) => void;
  addCustomDirector: (label: string, systemPrompt: string) => string;
  updateCustomDirector: (id: string, label: string, systemPrompt: string) => void;
  removeCustomDirector: (id: string) => void;
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
  showThinking: false,
  optimizePrompt: false,
  autoApply: false,

  messages: [],
  input: "",
  busy: false,
  model: "",
  pipeline: "comic_drama", // default Director = Comic Drama (the main pipeline); "" = plain Edit
  vibe: "",
  customVibes: [],
  customDirectors: [],
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
  setOptimizePrompt: (v) => set({ optimizePrompt: v }),

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
  setPipeline: (v) => set({ pipeline: v }),
  setVibe: (v) => set({ vibe: v }),
  addCustomVibe: (label, style) => {
    const id = "custom_" + Math.random().toString(36).slice(2, 9);
    set((st) => ({ customVibes: [...st.customVibes, { id, label: label.trim() || "Custom", style: style.trim() }], vibe: id }));
    return id;
  },
  updateCustomVibe: (id, label, style) =>
    set((st) => ({ customVibes: st.customVibes.map((v) => (v.id === id ? { ...v, label: label.trim() || v.label, style: style.trim() } : v)) })),
  removeCustomVibe: (id) =>
    set((st) => ({ customVibes: st.customVibes.filter((v) => v.id !== id), vibe: st.vibe === id ? "" : st.vibe })),
  addCustomDirector: (label, systemPrompt) => {
    const id = "dir_" + Math.random().toString(36).slice(2, 9);
    set((st) => ({ customDirectors: [...st.customDirectors, { id, label: label.trim() || "Custom Director", systemPrompt: systemPrompt.trim() }], pipeline: id }));
    return id;
  },
  updateCustomDirector: (id, label, systemPrompt) =>
    set((st) => ({ customDirectors: st.customDirectors.map((d) => (d.id === id ? { ...d, label: label.trim() || d.label, systemPrompt: systemPrompt.trim() } : d)) })),
  removeCustomDirector: (id) =>
    set((st) => ({ customDirectors: st.customDirectors.filter((d) => d.id !== id), pipeline: st.pipeline === id ? "" : st.pipeline })),
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
        streaming: st.streaming,
        showThinking: st.showThinking,
        optimizePrompt: st.optimizePrompt,
        autoApply: st.autoApply,
        model: st.model,
        pipeline: st.pipeline,
        vibe: st.vibe,
        customVibes: st.customVibes,
        customDirectors: st.customDirectors,
      }),
      // The panel opens by DEFAULT now — force it EXPANDED on load so a STALE persisted
      // "collapsed" state can never leave it opened but blank (header only, no chat body).
      // (isCollapsed is also dropped from partialize above, so it's no longer persisted.)
      merge: (persisted, current) => ({ ...current, ...(persisted as any), isCollapsed: false }),
    }
  )
);

export default useAiEditStore;
