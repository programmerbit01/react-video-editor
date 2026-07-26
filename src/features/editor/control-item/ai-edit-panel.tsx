"use client";
import { useEffect, useRef, useState } from "react";
import useAiEditStore from "../store/use-ai-edit-store";
import useStore from "../store/use-store";
import { dispatch } from "@designcombo/events";
import { PLAYER_SEEK } from "../constants/events";
import useCaptionTranscribeStore from "../captions/transcribe-store";
import { addCaptions } from "../captions/builder";
import {
  applyOperations,
  applyMotionBatch,
  addAudio,
  addImage,
  addVideo,
  replaceMedia,
  selectionChips,
  selectionContext,
  projectContext,
  narrationTimeline,
  describeOp,
  extractOps,
  captureSnapshot,
  revertSnapshot,
  CAPABILITIES,
  OPS_SYSTEM_PROMPT,
  PIPELINES,
  PIPELINE_PROMPTS,
  VIBES,
} from "../ai-edit/operations";

// Editor is served under Next basePath `/editor` — its API is /editor/api/*.
const withEditorBase = (path: string) => {
  if (typeof window === "undefined") return path;
  return window.location.pathname.startsWith("/editor") ? `/editor${path}` : path;
};

const getToken = () => {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("token") || "";
};

// The last pipeline (Comic Drama / Faceless) request text — so the arrange can pass the user's own
// direction ("punchy zoom-ins", "slow holds", "hard cuts") into match_shots, which decides motion +
// pacing. Without this, only the Vibe preset drives motion; with it, the PROMPT drives it too.
let _lastPipelineRequest = "";

// Tee AI-Edit logs to the console AND to the vApp (logs/vapp_editor.log) so the WHOLE
// prompt → plan → gen → transcribe → match → arrange → effects trace is readable server-side.
// The file version is ANSI-COLORED by stage (view with `tail -f logs/vapp_editor.log`), so each
// stage stands out; the console version is plain. Batched (flushes every ~500ms).
const A = { reset: "\x1b[0m", gray: "\x1b[90m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", bold: "\x1b[1m" };
function stageColor(body: string): string {
  if (/━━━|NEW GEN/.test(body)) return A.bold + A.cyan;
  if (/✖|ERROR|TIMEOUT|failed|MISSING|unusable/i.test(body)) return A.red;
  if (/match_shots|relevancy|BEATS|weight|pace/i.test(body)) return A.magenta;
  if (/transcrib|refined|segments/i.test(body)) return A.green;
  if (/\bgen\b|Generating|landed|\+image|\+video|\+audio|GEN REQ|GEN RET/i.test(body)) return A.yellow;
  if (/arrange|motion|Ken Burns|kenBurns|DONE|post-effect|transition/i.test(body)) return A.blue;
  if (/PROMPT|SYSTEM|SCRIPT|PLAN|LLM|request/i.test(body)) return A.cyan;
  return A.gray;
}
let _elogBuf: string[] = [];
let _elogTimer: any = null;
function elog(...args: any[]) {
  const stamp = new Date().toISOString().slice(11, 23);
  const body = args
    .map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
    .join(" ");
  // eslint-disable-next-line no-console
  console.log(`[${stamp}] ${body}`);
  if (typeof window === "undefined") return;
  _elogBuf.push(`${A.gray}[${stamp}]${A.reset} ${stageColor(body)}${body}${A.reset}`); // colored for the file
  if (_elogTimer) return;
  _elogTimer = setTimeout(() => {
    const lines = _elogBuf;
    _elogBuf = [];
    _elogTimer = null;
    fetch(withEditorBase("/api/editor-log"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines }),
    }).catch(() => {});
  }, 500);
}

// Abort controller for the LLM chat request (the streaming plan). The Stop button aborts it → the
// SSE fetch closes → the SERVER stops the LLM stream too (a TRUE stop). Generation jobs are NOT
// stopped — they run in parallel on the vApp queue (good) and can't be pulled back anyway.
let _work: AbortController | null = null;

let _aiPositionSet = false;

async function runChat(
  payload: Record<string, any>,
  onDelta: (p: { content: string; reasoning: string }) => void,
  signal?: AbortSignal
): Promise<{ content: string; reasoning: string }> {
  const res = await fetch(withEditorBase("/api/ai-edit"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal, // Stop → aborts this fetch → the SSE closes → the server stops the LLM stream
  });
  const ctype = res.headers.get("content-type") || "";
  if (!payload.stream || ctype.includes("application/json")) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return { content: data?.content || "", reasoning: "" };
  }
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(t || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const p = t.slice(5).trim();
      if (!p || p === "[DONE]") continue;
      let evt: any;
      try {
        evt = JSON.parse(p);
      } catch {
        continue;
      }
      if (evt?.error) throw new Error(evt.error?.message || "stream error");
      const delta = evt.choices?.[0]?.delta;
      if (delta?.content) {
        content += delta.content;
        onDelta({ content, reasoning });
      }
      if (delta?.reasoning_content) {
        reasoning += delta.reasoning_content;
        onDelta({ content, reasoning });
      }
    }
  }
  return { content, reasoning };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Start a background media generation job → request_id (fast, non-blocking).
async function startGen(payload: Record<string, any>): Promise<{ id: string; prompt: string }> {
  const res = await fetch(withEditorBase("/api/ai-generate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  // `prompt` is what the job actually ran with (image/video prompts are optimized via /vapp/llm).
  return { id: String(data?.request_id || ""), prompt: String(data?.prompt || "") };
}

// Long-poll the job (each call waits ~35s server-side via /vapp/wait_job) until it
// finishes. Reports live progress via onStatus. Returns the output URL.
async function waitGen(id: string, onStatus: (d: any) => void): Promise<string> {
  const deadline = Date.now() + 12 * 60 * 1000; // 12-min cap
  while (Date.now() < deadline) {
    let d: any = {};
    try {
      const res = await fetch(withEditorBase(`/api/ai-generate?id=${encodeURIComponent(id)}&timeout=35`), {
        cache: "no-store",
      });
      d = await res.json().catch(() => ({}));
    } catch {
      d = { status: "error" };
    }
    if (d?.failed) throw new Error(d?.error || "generation failed");
    if (d?.done && d?.output_url) return d.output_url;
    onStatus(d);
    if (d?.status === "error") await sleep(8000); // transient — brief backoff
  }
  throw new Error("timed out");
}

// Transcribe an audio URL → timed segments (start/end in SECONDS). Powers script-sync.
async function transcribeAudio(
  src: string,
  token: string
): Promise<{ start: number; end: number; text: string; words?: any[] }[]> {
  const startRes = await fetch(withEditorBase("/api/transcribe"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: src, timestamp_type: "word", token }),
  });
  const sd = await startRes.json().catch(() => ({}));
  if (!startRes.ok) throw new Error(sd?.message || "transcribe start failed");
  const jobId = String(sd?.job_id || "");
  if (!jobId) throw new Error("no transcribe job id");
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    let pd: any = {};
    try {
      const pr = await fetch(withEditorBase(`/api/transcribe/${jobId}?token=${encodeURIComponent(token)}`), {
        cache: "no-store",
      });
      pd = await pr.json().catch(() => ({}));
    } catch {
      continue;
    }
    if (pd?.failed) throw new Error("transcription failed");
    if (pd?.done) {
      const segs = Array.isArray(pd?.stt?.segments) ? pd.stt.segments : [];
      return segs
        .map((sg: any) => ({
          start: Number(sg?.start || 0),
          end: Number(sg?.end || 0),
          text: String(sg?.text || "").trim(),
          words: Array.isArray(sg?.words)
            ? sg.words.map((w: any) => ({ word: String(w?.word || "").trim(), start: Number(w?.start || 0), end: Number(w?.end || 0) }))
            : undefined,
        }))
        .filter((x: any) => x.text);
    }
  }
  throw new Error("transcription timed out");
}

// Generic unified-LLM text call → /api/ai-llm → vApp /vapp/llm. Used by the auto-director
// for the `script` + `beat_plan` tasks. Fail-open: returns "" on any error.
async function llmText(task: string, input: string, token: string): Promise<string> {
  try {
    const res = await fetch(withEditorBase("/api/ai-llm"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, input, token }),
    });
    const d = await res.json().catch(() => ({}));
    return String(d?.text || "");
  } catch {
    return "";
  }
}

// Wait until a just-added item actually LANDS in the timeline map. ADD_ITEMS/ADD_AUDIO reduce
// asynchronously (ADD_AUDIO even loads the audio to compute its real duration first — slow for a big
// voiceover), so addImage/addAudio return an id BEFORE the item exists. Awaiting this inside runGen
// makes Promise.all(gens) resolve only once every generated clip is truly on the timeline — so the
// arrange never runs early on a half-built timeline (the "2/4 clips, waiting for audio" bug).
async function waitForItem(id: string, timeoutMs = 90000): Promise<boolean> {
  if (!id) return false;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((useStore.getState().trackItemsMap || {})[id]) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  elog(`[AI-Edit gen] item ${id.slice(0, 6)} never landed after ${timeoutMs}ms`);
  return false;
}

// SERIALIZE timeline adds. ADD_ITEMS/ADD_AUDIO reduce ASYNCHRONOUSLY (ADD_AUDIO even loads the audio
// to compute its duration first — ~13s for a big voiceover). If several run CONCURRENTLY they do
// read-modify-write on trackItemsMap with stale bases and CLOBBER each other — which is why items
// "landed" and then vanished ("2/4 visuals, audio MISSING" though all 5 were added). This mutex runs
// each add — AND waits for it to actually land — before the next one starts. Generation stays
// parallel (the slow part); only the mutation is serialized.
let _addChain: Promise<any> = Promise.resolve();
function serializedAdd(label: string, doAdd: () => string): Promise<string> {
  const run = _addChain.then(async () => {
    const before = Object.keys(useStore.getState().trackItemsMap || {}).length;
    const id = doAdd();
    let landed = false;
    if (id) landed = await waitForItem(id);
    const after = Object.keys(useStore.getState().trackItemsMap || {}).length;
    elog(`[AI-Edit gen] +${label} ${id.slice(0, 6)} ${landed ? "landed" : "TIMEOUT"} — items ${before}→${after}`);
    return id;
  });
  _addChain = run.then(() => {}, () => {});
  return run;
}

// DEDUP a double-fired build (autoApply + a stray Apply / re-render) — a 2nd runBuild re-transcribes
// and re-arranges, clobbering the good result (the log showed a 2nd transcribe timing out 100s after
// the 1st finished). Same build signature within 12s → skip.
let _lastBuildKey = "";
let _lastBuildAt = 0;
// A concurrent arrange for the SAME audio would re-transcribe + re-arrange and CLOBBER the first
// (the log's 2nd transcribe timing out 100s later). This lock skips a 2nd arrange of the same audio.
const _arrangeLock = new Map<string, number>();
function buildIsDuplicate(gens: any[], arranges: any[]): boolean {
  const key = JSON.stringify({
    g: (gens || []).map((g) => `${g.op}:${g.kind || ""}:${String(g.prompt || g.text || g.query || "").slice(0, 24)}`),
    a: (arranges || []).length,
  });
  const now = Date.now();
  if (key === _lastBuildKey && now - _lastBuildAt < 12000) return true;
  _lastBuildKey = key;
  _lastBuildAt = now;
  return false;
}

// The STT sometimes returns ONE coarse segment for the whole voiceover (e.g. continuous speech).
// match_shots then sees a single "[0-23s] …" line and can only EVEN-split in input order — no
// content-awareness, no reorder (this is why a video shot stayed stuck at the end). Re-chunk by the
// WORD timestamps (transcribe requests them) into ~2.5s phrases so each shot can land on a DISTINCT
// narration moment. Falls back to the original segments when there's no usable word data.
function refineSegments(raw: any[]): any[] {
  const words: { start: number; end: number; text: string }[] = [];
  for (const sg of raw || []) {
    for (const w of sg?.words || []) {
      const s = Number(w?.start), e = Number(w?.end), t = String(w?.word || "").trim();
      if (t && Number.isFinite(s) && Number.isFinite(e) && e >= s) words.push({ start: s, end: e, text: t });
    }
  }
  if (words.length < 6) return raw; // not enough word data → keep the segments as-is
  const CHUNK = 2.5; // seconds per phrase
  const out: { start: number; end: number; text: string }[] = [];
  let cur: { start: number; end: number; text: string } | null = null;
  for (const w of words) {
    if (!cur) cur = { start: w.start, end: w.end, text: w.text };
    else if (w.end - cur.start <= CHUNK) { cur.end = w.end; cur.text += " " + w.text; }
    else { out.push(cur); cur = { start: w.start, end: w.end, text: w.text }; }
  }
  if (cur) out.push(cur);
  return out.length >= 2 ? out : raw;
}

// Parse the match_shots LLM output → contiguous, gap-free windows in the LLM's relevance ORDER.
// FOOLPROOF: keeps only the given target ids, every id exactly once, forces coverage [0, totalMs].
// Returns null if the output can't be trusted (missing/extra ids) → caller falls back.
function normalizeShotWindows(
  raw: string,
  targetIds: string[],
  totalMs: number
): { id: string; from_ms: number; to_ms: number; motion?: string }[] | null {
  let t = (raw || "").trim();
  if (t.startsWith("```")) t = t.replace(/^```[a-z]*\n?/i, "").replace(/```$/,"").trim();
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  let obj: any;
  try { obj = JSON.parse(t.slice(i, j + 1)); } catch { return null; }
  const arr: any[] = Array.isArray(obj?.shots) ? obj.shots : Array.isArray(obj) ? obj : [];
  const seen = new Set<string>();
  const clean = arr
    .filter((s) => s && targetIds.includes(String(s.id)) && !seen.has(String(s.id)) && (seen.add(String(s.id)), true))
    .map((s) => ({
      id: String(s.id),
      from_ms: Math.max(0, Math.floor(Number(s.from_ms) || 0)),
      to_ms: Math.max(0, Math.floor(Number(s.to_ms) || 0)),
      motion: String(s.motion || "").trim(),
    }))
    .sort((a, b) => a.from_ms - b.from_ms);
  // every target id must be accounted for — if the LLM dropped any, bail (don't silently lose shots)
  if (clean.length !== targetIds.length) return null;
  // Force contiguous, gap-free coverage of [0, totalMs] — but PRESERVE the LLM's varied durations.
  // Each window ends at the NEXT shot's from_ms (the LLM's own cut point), falling back to this shot's
  // to_ms, then to an even split. Only a small MIN guard — do NOT flatten toward an equal share (that
  // was the bug that made every clip the same length → boring "2020 b-roll" pacing).
  const N = clean.length;
  const MIN = 350;
  const out: { id: string; from_ms: number; to_ms: number; motion?: string }[] = [];
  for (let k = 0; k < N; k++) {
    const from = k === 0 ? 0 : out[k - 1].to_ms;
    let to: number;
    if (k === N - 1) to = totalMs;
    else if (clean[k + 1].from_ms > from) to = clean[k + 1].from_ms; // the LLM's next cut point
    else if (clean[k].to_ms > from) to = clean[k].to_ms; // else this shot's own end
    else to = from + Math.floor((totalMs - from) / (N - k)); // last resort: split the remainder
    to = Math.max(from + MIN, Math.min(to, totalMs - (N - 1 - k) * MIN));
    out.push({ id: clean[k].id, from_ms: from, to_ms: to, motion: clean[k].motion });
  }
  out[N - 1].to_ms = totalMs;
  return out;
}

// LLM motion word → the player's Ken Burns kind + intensity. 'punchIn' = a hard fast zoom for impact;
// 'hold' = near-still for an emotional pause. Unknown/empty → fall back to an alternating default.
const MOTION_MAP: Record<string, { kb: string; intensity: number; dur?: number }> = {
  punchin: { kb: "zoomIn", intensity: 34, dur: 28 }, // dur=28% → a QUICK punch-zoom, then HOLDS (real punch feel)
  zoomin: { kb: "zoomIn", intensity: 16 },
  zoomout: { kb: "zoomOut", intensity: 16 },
  panleft: { kb: "panLeft", intensity: 14 },
  panright: { kb: "panRight", intensity: 14 },
  hold: { kb: "zoomIn", intensity: 5 },
};

export default function AiEditPanel() {
  const s = useAiEditStore();
  const { activeIds, trackItemsMap } = useStore();

  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 });
  const resizeRef = useRef({ resizing: false, startX: 0, startY: 0, originW: 0, originH: 0 });
  const resizeLeftRef = useRef({ resizing: false, startX: 0, originW: 0, originX: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);

  // Elapsed-time counter — runs the whole time the AI is WORKING (LLM streaming OR the build /
  // generation / arrange is still in progress), shown in the header; turns off when everything is done.
  const lastMsg = s.messages[s.messages.length - 1];
  const genActive = !!lastMsg?.genStatus && !/^\s*[✓⚠⏹]/.test(lastMsg.genStatus);
  const working = s.busy || genActive;
  const [elapsed, setElapsed] = useState(0);
  const workStartRef = useRef(0);
  const workEndTimerRef = useRef<any>(null);

  // Vibe presets (built-in + user's custom, persisted). The dropdown lets you pick, add, edit, delete.
  const allVibes = [...VIBES, ...s.customVibes];
  const vibeStyleOf = (id: string) => allVibes.find((v) => v.id === id)?.style || "";
  const curVibe = allVibes.find((v) => v.id === s.vibe);
  const [vibeMenuOpen, setVibeMenuOpen] = useState(false);
  const [vibeEdit, setVibeEdit] = useState<{ id: string; label: string; style: string } | null>(null);
  const vibeMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!vibeMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!vibeMenuRef.current?.contains(e.target as Node)) { setVibeMenuOpen(false); setVibeEdit(null); }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [vibeMenuOpen]);
  const saveVibe = () => {
    if (!vibeEdit) return;
    if (vibeEdit.id === "new") s.addCustomVibe(vibeEdit.label, vibeEdit.style);
    else s.updateCustomVibe(vibeEdit.id, vibeEdit.label, vibeEdit.style);
    setVibeEdit(null);
  };
  // ONE continuous timer from send → fully done. It does NOT restart on the brief idle gaps between
  // steps (LLM-done → generation-start, or between clips): a 5s grace window bridges those, so it
  // measures the WHOLE run start→end. When done it FREEZES the total (badge stays "✓ 45s") until the
  // next run resets it — so you can actually read the total.
  useEffect(() => {
    if (working) {
      if (workEndTimerRef.current) { clearTimeout(workEndTimerRef.current); workEndTimerRef.current = null; }
      if (!workStartRef.current) { workStartRef.current = Date.now(); setElapsed(0); }
      const t = setInterval(() => setElapsed(Math.round((Date.now() - workStartRef.current) / 1000)), 500);
      return () => clearInterval(t);
    }
    // idle: don't end the run immediately — wait out a brief gap; only after 5s of real idle do we
    // arm a fresh start for the NEXT run (elapsed stays frozen as the completed total meanwhile).
    if (workStartRef.current && !workEndTimerRef.current) {
      workEndTimerRef.current = setTimeout(() => { workStartRef.current = 0; workEndTimerRef.current = null; }, 5000);
    }
  }, [working]);

  // Close the settings popover on any click outside it (except the gear toggle, which
  // handles its own open/close). Was sticking open until the gear was clicked again.
  useEffect(() => {
    if (!s.showSettings) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (settingsRef.current?.contains(t) || settingsBtnRef.current?.contains(t)) return;
      s.setShowSettings(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [s.showSettings]);

  useEffect(() => {
    fetch(withEditorBase("/api/ai-edit"))
      .then((r) => r.json())
      .then((d) => {
        const list = Array.isArray(d?.models) ? d.models : [];
        const mapped = list.map((m: any) => ({ id: m.id, label: m.label || m.id }));
        s.setModels(mapped);
        // Default to the model with "ls" (Qwen q36ls35b — cleaner reasoning-off behaviour); fall
        // back to GO20 then the first. Treat empty OR the OLD default (GO20) as "not explicitly
        // chosen" so existing users move to the new default too.
        const lsModel = mapped.filter((m: any) => /ls/i.test(m.label || m.id || "")).pop();
        const prefer = lsModel || mapped.find((m: any) => m.id === "litellm/GO20") || mapped[0];
        s.setModel(!s.model || s.model === "litellm/GO20" ? prefer?.id || "" : s.model);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (_aiPositionSet) return;
    s.setFloatPos({ x: window.innerWidth - 360, y: 60 });
    const trySnap = () => {
      const el = document.getElementById("editor-right-panel");
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 10 && rect.left > 100) {
          _aiPositionSet = true;
          s.setFloatPos({ x: rect.left, y: rect.top });
          s.setPanelSize({ width: rect.width, height: rect.height - 42 });
          return;
        }
      }
      requestAnimationFrame(trySnap);
    };
    requestAnimationFrame(trySnap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!s.isOpen) return;
    const onMove = (e: MouseEvent) => {
      if (dragRef.current.dragging) {
        s.setFloatPos({
          x: Math.max(0, dragRef.current.originX + e.clientX - dragRef.current.startX),
          y: Math.max(0, dragRef.current.originY + e.clientY - dragRef.current.startY),
        });
      }
      if (resizeRef.current.resizing) {
        s.setPanelSize({
          width: Math.max(280, resizeRef.current.originW + e.clientX - resizeRef.current.startX),
          height: Math.max(260, resizeRef.current.originH + e.clientY - resizeRef.current.startY),
        });
      }
      if (resizeLeftRef.current.resizing) {
        const delta = e.clientX - resizeLeftRef.current.startX;
        const newW = Math.max(280, resizeLeftRef.current.originW - delta);
        s.setFloatPos({ x: resizeLeftRef.current.originX + (resizeLeftRef.current.originW - newW), y: s.floatPos.y });
        s.setPanelSize({ width: newW, height: s.panelSize.height });
      }
    };
    const onUp = () => {
      dragRef.current.dragging = false;
      resizeRef.current.resizing = false;
      resizeLeftRef.current.resizing = false;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.isOpen, s.floatPos.y, s.panelSize.height]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.messages, s.busy]);

  const chips = selectionChips(activeIds, trackItemsMap);

  const runPrompt = async (text: string) => {
    if (!text.trim() || s.busy) return;
    _work = new AbortController(); // Stop button aborts this
    _lastPipelineRequest = text; // so the arrange's match_shots hears the user's direction (edit + pipeline)
    const vibeNow = [...VIBES, ...s.customVibes].find((v) => v.id === s.vibe);
    elog(`━━━━━━━━━━ NEW GEN ━━━━━━━━━━  mode=${s.pipeline || "edit"}  vibe=${vibeNow?.label || "none"}  model=${s.model}`);
    elog(`[PROMPT] ${text}`);
    if (vibeNow?.style) elog(`[VIBE STYLE] ${vibeNow.style}`);
    const ctx = selectionContext(chips);
    s.addMessage({ role: "user", content: text });
    s.addMessage({ role: "assistant", content: "", reasoning: "", thinkingOpen: true });
    s.setBusy(true);

    // Script-sync: if the request is about matching to the narration, transcribe the
    // voiceover once (cached) so the AI gets exact segment times.
    if (/\b(script|narration|sync|voiceover|subtitles?|captions?)\b/i.test(text) || /when .*(say|said|speak)/i.test(text)) {
      const audio: any = Object.values(useStore.getState().trackItemsMap || {}).find((it: any) => it?.type === "audio");
      const asrc: string = audio?.details?.src || "";
      if (asrc && useAiEditStore.getState().transcript?.key !== audio.id) {
        // Reuse a persisted transcript (from the built-in Captions tab) if we have one.
        const cached = useCaptionTranscribeStore.getState().resultsByMedia?.[asrc];
        if (cached?.segments?.length) {
          s.setTranscript({
            key: audio.id,
            segments: cached.segments.map((sg: any) => ({ start: sg.start, end: sg.end, text: sg.text })),
          });
        } else {
          s.updateLast({ content: "Transcribing the narration…" });
          try {
            const segs = await transcribeAudio(asrc, getToken());
            if (segs.length) {
              s.setTranscript({ key: audio.id, segments: segs });
              // Share with the built-in captions cache (persisted) so it survives refresh.
              useCaptionTranscribeStore.getState().setTranscriptResult(asrc, {
                text: "",
                language: "",
                segment_count: segs.length,
                segments: segs.map((x: any) => ({ start: x.start, end: x.end, text: x.text, words: x.words })),
              });
            }
          } catch {
            /* proceed without transcript */
          }
          s.updateLast({ content: "" });
        }
      }
    }

    const projCtx = projectContext(trackItemsMap) + narrationTimeline(useAiEditStore.getState().transcript?.segments);
    const payload: Record<string, any> = {
      model: s.model,
      token: getToken(),
      stream: s.streaming,
      // A PIPELINE swaps the system prompt (e.g. Comic Drama / Faceless Video) and treats
      // the input as a topic/story — the LLM plans the whole thing and emits generate/arrange
      // ops that build it on the timeline. No pipeline = the normal edit assistant.
      messages: [
        { role: "system", content: PIPELINE_PROMPTS[s.pipeline] || OPS_SYSTEM_PROMPT },
        {
          role: "user",
          // A Vibe preset appends its style phrase so the pipeline plans the script + look to it.
          content: s.pipeline
            ? `${text}${vibeStyleOf(s.vibe) ? `\n\nSTYLE / VIBE: ${vibeStyleOf(s.vibe)}.` : ""}`
            : `${projCtx ? projCtx + "\n\n" : ""}${ctx}\n\nUser request: ${text}`,
        },
      ],
    };
    if (!s.showThinking) {
      payload.reasoning_effort = "low";
      payload.extra_body = { think: false };
    }
    elog(`[LLM REQ] system=${s.pipeline ? PIPELINES.find((p) => p.id === s.pipeline)?.label : "edit assistant"} · task=editor_edit · in="${String(payload.messages[1].content).replace(/\s+/g, " ").slice(0, 160)}…"`);
    const t0 = Date.now();
    let firstContentAt = 0;
    try {
      const { content, reasoning } = await runChat(payload, (p) => {
        if (p.content && !firstContentAt) firstContentAt = Date.now();
        s.updateLast({ content: p.content, reasoning: p.reasoning });
      }, _work?.signal);
      const reasoningMs = reasoning ? (firstContentAt || Date.now()) - t0 : undefined;
      elog(`[LLM RET] in ${Date.now() - t0}ms · ${content.length} chars`);
      const env = extractOps(content);
      if (env && env.operations?.length) {
        elog(`[PLAN] "${env.summary || ""}" → ${env.operations.length} ops: ${env.operations.map((o: any) => o.op + (o.kind ? `(${o.kind})` : "")).join(", ")}`);
        const aud = env.operations.find((o: any) => o.op === "generate" && o.kind === "audio");
        if (aud?.text) elog(`[SCRIPT] ${String(aud.text).replace(/\s+/g, " ")}`);
        env.operations.filter((o: any) => o.op === "generate" && o.kind !== "audio").forEach((o: any, k: number) => elog(`[GEN PROMPT ${k + 1}] ${o.kind}: ${String(o.prompt || o.text || "").replace(/\s+/g, " ").slice(0, 140)}`));
        s.updateLast({ content: env.summary || "Proposed edit ready.", reasoning, reasoningMs, thinkingOpen: false, ops: env.operations });
        // Auto mode: apply immediately without asking
        if (useAiEditStore.getState().autoApply) {
          const idx = useAiEditStore.getState().messages.length - 1;
          const msg = useAiEditStore.getState().messages[idx];
          if (msg) applyMsg(idx, msg);
        }
      } else if (env) {
        s.updateLast({ content: env.summary || "No changes needed.", reasoning, reasoningMs, thinkingOpen: false });
      } else {
        // extractOps found nothing. If the reply LOOKS like an ops JSON that didn't parse
        // (a long pipeline plan cut off mid-output, or malformed), SAY so — otherwise it
        // reads as "silently stopped with no error" (raw JSON dumped in the chat).
        const looksLikeOps = /^\s*\{/.test(content || "") || /"operations"\s*:/.test(content || "");
        s.updateLast({
          content: looksLikeOps
            ? "⚠️ The plan came back as cut-off / invalid JSON (too long to finish). Try again, or ask for fewer shots."
            : content || "No operations produced.",
          reasoning,
          reasoningMs,
          thinkingOpen: false,
        });
      }
    } catch (e: any) {
      const stopped = e?.name === "AbortError" || _work?.signal.aborted;
      s.updateLast({ content: stopped ? "⏹ Stopped." : "⚠️ " + (e?.message || "request failed"), thinkingOpen: false });
    } finally {
      s.setBusy(false);
    }
  };

  // TRUE stop: abort the in-flight LLM request → its SSE fetch closes → the server stops streaming.
  // (Generation jobs already queued keep running in parallel — by design.)
  const stopWork = () => {
    _work?.abort();
    s.setBusy(false);
    elog("[AI-Edit] ⏹ user stopped the LLM request");
  };

  // One generate op, run in the BACKGROUND (not awaited) so the chat stays free.
  const runGen = async (i: number, g: any) => {
    // Stock search — no generation job; fetch Pexels and add the top result(s).
    if (g.op === "search") {
      const kind = g.kind === "video" ? "video" : "image";
      const n = Math.min(Math.max(1, g.count || 1), 10);
      try {
        s.updateAt(i, { genStatus: `Searching stock ${kind}…` });
        const path = kind === "video" ? "/api/pexels-videos" : "/api/pexels";
        const res = await fetch(
          withEditorBase(`${path}?query=${encodeURIComponent(g.query || g.prompt || "")}&per_page=${n}`)
        );
        const data = await res.json().catch(() => ({}));
        const results = (kind === "video" ? data.videos : data.photos) || [];
        const snap = { ...(useAiEditStore.getState().messages[i]?.snapshot || {}) };
        const previews = [...(useAiEditStore.getState().messages[i]?.genPreviews || [])];
        let added = 0;
        for (let k = 0; k < Math.min(n, results.length); k++) {
          const src = results[k]?.details?.src;
          if (!src) continue;
          // serialized add (+ waits for landing) so concurrent stock adds never clobber each other
          const nid = await serializedAdd(kind, () => (kind === "video" ? addVideo(src, g.query || "stock") : addImage(src, g.query || "stock")));
          snap[nid] = null;
          previews.push({ kind, url: results[k]?.preview || src });
          added++;
        }
        s.updateAt(i, {
          genStatus: added ? `✓ ${added} stock ${kind}${added > 1 ? "s" : ""} added` : `⚠️ no stock ${kind} found`,
          snapshot: snap,
          genPreviews: previews,
        });
      } catch (e: any) {
        s.updateAt(i, { genStatus: `⚠️ stock ${kind}: ${e?.message || "failed"}` });
      }
      return;
    }

    // ANIMATE — turn the selected image into a VIDEO (image-to-video / LTX i2v), keeping it in
    // the SAME timeline slot. The "cheap images first, upgrade selected shots to video" flow.
    if (g.op === "animate") {
      const item = useStore.getState().trackItemsMap?.[g.itemId];
      const src = item?.details?.src;
      const disp = item?.display;
      if (!src) {
        s.updateAt(i, { genStatus: "⚠️ animate: no image found for that item" });
        return;
      }
      try {
        // snapshot the original image so Revert restores it
        const cur0 = useAiEditStore.getState().messages[i]?.snapshot || {};
        s.updateAt(i, { snapshot: { ...cur0, [g.itemId]: JSON.parse(JSON.stringify(item)) } });
        s.updateAt(i, { genStatus: "🎞️ Animating image → video…" });
        const { id: jobId } = await startGen({
          kind: "video",
          prompt: g.prompt || "subtle cinematic motion, gentle camera movement",
          image_url: src,
          aspect_ratio: g.aspect_ratio,
          duration: g.duration,
          optimize: false,
          token: getToken(),
        });
        if (!jobId) throw new Error("no job id");
        const url = await waitGen(jobId, (d) => {
          const p = d?.progress;
          const q = d?.queue_position;
          s.updateAt(i, { genStatus: q != null ? `Queued #${q}…` : p != null ? `Animating ${p}%…` : "Animating…" });
        });
        const newId = addVideo(url, "animated");
        // drop the new video into the image's EXACT slot, then remove the still
        if (disp) applyOperations([{ op: "arrange", items: [{ itemId: newId, fromMs: disp.from || 0, toMs: disp.to || (disp.from || 0) + 5000 }] }]);
        applyOperations([{ op: "delete", itemId: g.itemId }]);
        const cur = useAiEditStore.getState().messages[i]?.snapshot || {};
        const prev = useAiEditStore.getState().messages[i]?.genPreviews || [];
        s.updateAt(i, { snapshot: { ...cur, [newId]: null }, genPreviews: [...prev, { kind: "video", url }], genStatus: "✓ Image animated → video" });
      } catch (e: any) {
        s.updateAt(i, { genStatus: `⚠️ animate: ${e?.message || "failed"}` });
      }
      return;
    }

    const isRegen = g.op === "regenerate";
    const label = isRegen ? "image" : g.kind || "audio";
    try {
      s.updateAt(i, { genStatus: `Starting ${isRegen ? "image edit" : label}…` });
      let image_url: string | undefined;
      if (isRegen) {
        const item = useStore.getState().trackItemsMap?.[g.itemId];
        image_url = item?.details?.src;
        // snapshot the original image so Revert restores it
        const cur0 = useAiEditStore.getState().messages[i]?.snapshot || {};
        s.updateAt(i, { snapshot: { ...cur0, [g.itemId]: item ? JSON.parse(JSON.stringify(item)) : null } });
      }
      const sentPrompt = String(g.prompt || g.text || "").trim();
      const { id, prompt: usedPrompt } = await startGen({
        kind: label,
        text: g.text,
        prompt: g.prompt || g.text,
        image_url,
        aspect_ratio: g.aspect_ratio,
        duration: g.duration,
        optimize: useAiEditStore.getState().optimizePrompt,
        token: getToken(),
      });
      if (!id) throw new Error("no job id");
      // /vapp/llm rewrote the image/video prompt into a model-friendly one — flag it (✨) so
      // the user sees their idea was enhanced before generating.
      const optimized = !!usedPrompt && usedPrompt.trim() !== sentPrompt && !isRegen && label !== "audio";
      if (optimized) s.updateAt(i, { genStatus: `✨ Optimized prompt → generating ${label}…` });
      const url = await waitGen(id, (d) => {
        const q = d?.queue_position;
        const p = d?.progress;
        s.updateAt(i, {
          genStatus:
            (optimized ? "✨ " : "") +
            (q != null ? `Queued #${q}…` : p != null ? `Generating ${label} ${p}%…` : `Generating ${label}…`),
        });
      });
      if (isRegen) {
        replaceMedia(g.itemId, url);
      } else {
        let newId = "";
        if (label === "audio") {
          // AUDIO IS KING. ADD_AUDIO loads the voiceover and sets its REAL length itself, so the
          // images arrange to MATCH it — no manual duration needed (and passing `display` used to
          // make the reducer silently drop the clip = "no voiceover on the timeline").
          newId = await serializedAdd("audio", () => addAudio(url, g.text || "voiceover"));
        } else if (label === "image") newId = await serializedAdd("image", () => addImage(url, g.prompt || g.text || "image"));
        else if (label === "video") newId = await serializedAdd("video", () => addVideo(url, g.prompt || g.text || "video"));
        // serializedAdd already dispatched the add, WAITED for it to land, and logged it — so the
        // caller's Promise.all(gens) means "every clip is truly on the timeline", and no two adds
        // ever mutate trackItemsMap at the same time (no clobber).
        const cur = useAiEditStore.getState().messages[i]?.snapshot || {};
        if (newId) s.updateAt(i, { snapshot: { ...cur, [newId]: null } });
      }
      const prev = useAiEditStore.getState().messages[i]?.genPreviews || [];
      s.updateAt(i, {
        genStatus: `✓ ${isRegen ? "image edited" : label + " added"}`,
        genPreviews: [...prev, { kind: label, url }],
      });
    } catch (e: any) {
      s.updateAt(i, { genStatus: `⚠️ ${label}: ${e?.message || "failed"}` });
    }
  };

  // Run generations (background), THEN any arrange — generated items only get ids
  // once created, so an "arrange all" must wait until they're on the timeline.
  const runBuild = async (i: number, gens: any[], arranges: any[], postEffects: any[] = []) => {
    if (buildIsDuplicate(gens, arranges)) {
      elog("[AI-Edit] runBuild DEDUP — identical build within 12s, skipping the 2nd (prevents clobber)");
      return;
    }
    elog(`[AI-Edit] runBuild ▶ ${gens.length} gen(s) [${gens.map((g: any) => g.kind || g.op).join(",")}], ${arranges.length} arrange, ${postEffects.length} post-effect`);
    // Snapshot the visuals that exist BEFORE we generate, so we can arrange ONLY the new ones.
    const mapBefore = useStore.getState().trackItemsMap || {};
    const beforeVisual = new Set(Object.keys(mapBefore).filter((id) => (mapBefore[id] as any)?.type !== "audio"));
    const wantVisual = gens.filter((g) => g.kind !== "audio").length;
    const total = gens.length;
    let doneN = 0;
    // Run the generations in parallel, with a live progress counter (so the user sees it working).
    await Promise.all(
      gens.map((g) =>
        runGen(i, g).finally(() => {
          doneN += 1;
          if (total > 1) s.updateAt(i, { genStatus: `🎨 Generating ${total} clips… (${doneN}/${total} done)` });
        }),
      ),
    );
    if (!arranges.length) return;
    // Promise.all(gens) above now resolves only AFTER every generated clip (images + the slow-loading
    // voiceover) has actually LANDED on the timeline — each runGen awaits waitForItem(). So there is NO
    // race to guess around here: the new visuals + audio are already present. A tiny settle flushes any
    // final reduce, then we read the truth. If fewer visuals landed than were requested, those
    // generations genuinely FAILED (vApp) — we say so and arrange the ones that made it.
    let newVisual: string[] = [];
    const wantAudio = gens.some((g) => g.kind === "audio");
    if (gens.length) {
      for (let t = 0; t < 8; t++) {
        const m = useStore.getState().trackItemsMap || {};
        const order = useStore.getState().trackItemIds || Object.keys(m);
        newVisual = order.filter((id: string) => m[id] && (m[id] as any).type !== "audio" && !beforeVisual.has(id));
        const hasAudio = !wantAudio || Object.values(m).some((it: any) => it?.type === "audio");
        if (newVisual.length >= wantVisual && hasAudio) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const audioNow = Object.values(useStore.getState().trackItemsMap || {}).some((it: any) => it?.type === "audio");
      const failed = Math.max(0, wantVisual - newVisual.length);
      elog(`[AI-Edit arrange] components ready: ${newVisual.length}/${wantVisual} visuals${failed ? ` (${failed} generation${failed > 1 ? "s" : ""} FAILED)` : ""}, audio=${audioNow}${wantAudio && !audioNow ? " (voiceover MISSING — addAudio failed?)" : ""}`);
      if (failed) s.updateAt(i, { genStatus: `⚠️ ${failed} of ${wantVisual} shot${wantVisual > 1 ? "s" : ""} didn't generate — arranging the ${newVisual.length} that landed.` });
    }
    const map = useStore.getState().trackItemsMap || {};
    const audio: any = Object.values(map).find((it: any) => it?.type === "audio");
    const audioMs = audio?.details?.src
      ? (audio.duration || 0) || (audio.display ? Math.max(0, (audio.display.to || 0) - (audio.display.from || 0)) : 0)
      : 0;
    // ── SMART arrange (a CORE op — works in plain Edit mode too, not just pipelines) ──────────────
    // The EXECUTOR owns timing, NEVER the LLM (timing is a mechanic, not a decision). Whatever the
    // LLM emitted — target:"all", explicit itemIds, or per-item times — we IGNORE its times and
    // (re)compute content-aware windows from the voiceover ourselves. That's why this block ALWAYS
    // runs when there's an arrange op (so the logs + transcription + sync are never bypassed).
    // Priority: server /api/beat-plan (VidRush transcribe→beat_plan, best) → client transcript
    // (cached from the Captions tab, else /api/transcribe) even-windows-snapped-to-speech → even
    // split. The result is ONE gap-free, single-track sequence spanning exactly the voiceover, plus
    // Ken Burns and a short report. The BEAT MODEL (each shot's slot + its narration) is stored so
    // animate / effects / lip-sync can read it and be context-aware too. ────────────────────────────
    if (arranges.length) {
      const order = useStore.getState().trackItemIds || Object.keys(map);
      // "visual" = image/video ONLY — NEVER caption/text/audio. (A caption counted as a shot is why
      // the caption chip used to get dragged onto the image row and re-timed. Captions live on their
      // own track under the audio, glued by useCaptionSync — arrange must never touch them.)
      const isVisual = (id: string) => { const ty = (map[id] as any)?.type; return ty === "image" || ty === "video"; };
      const allVisual = order.filter(isVisual);
      // Honour WHICH items the LLM/user chose (from the selection chips) — but own the TIMING.
      const chosen = Array.from(
        new Set(arranges.flatMap((a: any) => (a.items?.map((x: any) => x.itemId) || a.itemIds || [])).filter(Boolean)),
      ).filter(isVisual);
      const targetVisuals: string[] = gens.length ? newVisual.filter(isVisual) : chosen.length ? chosen : allVisual;
      const N = targetVisuals.length;
      elog("[AI-Edit arrange] ▶ START", {
        targetVisualCount: N,
        targetVisuals,
        source: gens.length ? "just-generated" : chosen.length ? "selected" : "all-visuals",
        audio: audio ? { srcTail: String(audio.details?.src || "").slice(-48), audioMs } : "NONE",
      });
      const alockKey = String(audio?.details?.src || "no-audio");
      const alockPrev = _arrangeLock.get(alockKey);
      if (alockPrev && Date.now() - alockPrev < 150000) {
        elog(`[AI-Edit arrange] ⏭ SKIP — an arrange for this audio is already running (double-fire, ${Math.round((Date.now() - alockPrev) / 1000)}s ago)`);
        return;
      }
      _arrangeLock.set(alockKey, Date.now());
      if (!N) {
        elog("[AI-Edit arrange] ✖ nothing to arrange — no visuals on the timeline");
        s.updateAt(i, { genStatus: "⚠️ Nothing to arrange — add some images or videos to the timeline first." });
      } else {
        let beats: { itemId: string; fromMs: number; toMs: number; text: string; motion?: string }[] | null = null;
        let source = "even"; // "server" | "transcript" | "even"
        let note = "";
        try {
          if (N > 1 && audio?.details?.src) {
            const src = String(audio.details.src);
            s.updateAt(i, { genStatus: "⏳ Reading the voiceover…" });
            // STEP 1 — TRANSCRIPT (timed narration). Reuse the Captions-tab transcript if present
            // (instant), else the LIVE /api/transcribe (capped so it can never hang the arrange).
            let segs: any[] = useCaptionTranscribeStore.getState().resultsByMedia?.[src]?.segments || [];
            elog("[AI-Edit arrange] cached transcript segments:", segs.length);
            if (!segs.length) {
              s.updateAt(i, { genStatus: "⏳ Transcribing the voiceover…" });
              elog("[AI-Edit arrange] no cache → /api/transcribe…");
              const t1 = Date.now();
              segs = (await Promise.race([
                transcribeAudio(src, getToken()).catch((e) => { elog("[AI-Edit arrange] ✖ transcribe REJECTED:", e); return [] as any[]; }),
                new Promise<any[]>((r) => setTimeout(() => { elog("[AI-Edit arrange] ✖ transcribe TIMEOUT 120s"); r([]); }, 120000)),
              ])) as any[];
              elog(`[AI-Edit arrange] transcribe returned ${segs.length} segments in ${Date.now() - t1}ms`);
              if (segs.length) {
                try {
                  useCaptionTranscribeStore.getState().setTranscriptResult(src, {
                    text: "", language: "", segment_count: segs.length,
                    segments: segs.map((x: any) => ({ start: x.start, end: x.end, text: x.text, words: x.words })),
                  });
                } catch { /* cache best-effort */ }
              }
            }
            // Break a coarse transcript into ~2.5s phrases (via word timestamps) so match_shots can
            // place each shot at a DISTINCT moment + REORDER by content — not even-split one line.
            if (segs.length) {
              const fine = refineSegments(segs);
              if (fine.length !== segs.length) elog(`[AI-Edit arrange] refined transcript ${segs.length} → ${fine.length} phrases (word-level)`);
              segs = fine;
            }
            // AUDIO IS KING: span the FULL voiceover. Use the larger of the audio clip's real length
            // (from meta.duration) and the last spoken word, so the video never ends before the audio
            // (trailing music/silence stays covered) — within the ~2-4% the durations naturally differ.
            const speechEnd = Math.round((segs.length ? segs[segs.length - 1].end : 0) * 1000);
            const totalMs = Math.max(speechEnd, audioMs) || N * 4000;
            const said = (fromMs: number, toMs: number) =>
              segs.filter((sg: any) => sg.end * 1000 > fromMs && sg.start * 1000 < toMs).map((sg: any) => sg.text).join(" ").trim();
            // STEP 2 — RELEVANCY (the main win). Each image's description → the LLM `match_shots`
            // task places each shot at the narration MOMENT it's about (coins→"fortune",
            // gun→"weapon", fire→"burn") — content-aware, NOT an even split, and reorders by
            // relevance. Description source: metadata.prompt (generated images carry their prompt
            // here — ADD_ITEMS strips `name`→"image" but preserves metadata), else vApp media.meta
            // (for images this session didn't generate — one /api/media-meta lookup by url).
            const clean = (v: any) => {
              const raw = String(v || "").trim().replace(/\s+/g, " ");
              return /^(image|video|stock|audio|untitled|clip)?$/i.test(raw) ? "" : raw.slice(0, 120);
            };
            const localDesc = (id: string) => {
              const it: any = map[id];
              return clean(it?.metadata?.prompt) || clean(it?.details?.prompt) || clean(it?.metadata?.description) || clean(it?.name);
            };
            const shots = targetVisuals.map((id) => ({ id, desc: localDesc(id) }));
            // fill any missing descriptions from vApp media.meta (existing/uploaded images), in parallel
            const missing = shots.filter((sh) => !sh.desc && map[sh.id]?.details?.src);
            if (missing.length) {
              elog(`[AI-Edit arrange] fetching ${missing.length} description(s) from vApp meta…`);
              await Promise.all(missing.map(async (sh) => {
                try {
                  const r = await fetch(withEditorBase(`/api/media-meta?url=${encodeURIComponent(String(map[sh.id].details.src))}&token=${encodeURIComponent(getToken())}`));
                  const d = await r.json().catch(() => ({}));
                  sh.desc = clean(d?.prompt);
                } catch { /* fail-open */ }
              }));
            }
            const described = shots.filter((sh) => sh.desc).length;
            if (segs.length && described >= 2) {
              s.updateAt(i, { genStatus: "🧠 Matching each shot to what the narration says…" });
              const narration = segs.map((sg: any) => `[${(sg.start || 0).toFixed(1)}-${(sg.end || 0).toFixed(1)}] ${String(sg.text || "").trim()}`).join("\n");
              const shotLines = shots.map((sh, k) => `${k + 1}. id="${sh.id}" desc="${sh.desc || "(unknown)"}"`).join("\n");
              const vst = useAiEditStore.getState();
              const vibeLine = [...VIBES, ...vst.customVibes].find((v) => v.id === vst.vibe)?.style || "";
              // The user's own words drive motion + pace too — "punchy zoom-ins", "slow holds",
              // "hard fast cuts" in the prompt reach match_shots (not just the Vibe preset).
              const styleLine = [vibeLine, _lastPipelineRequest].filter(Boolean).join(". ").slice(0, 300);
              const input = `NARRATION (timed, seconds):\n${narration}\n\nSHOTS (assign each id to the narration moment it matches, contiguous & gap-free; also give each a MOTION):\n${shotLines}\n\nTotal audio: ${totalMs} ms${styleLine ? `\n\nSTYLE / DIRECTION: ${styleLine}` : ""}`;
              elog(`[MATCH REQ] ${N} shots, total=${totalMs}ms, direction="${styleLine.slice(0, 80)}"`);
              shots.forEach((sh, k) => elog(`[MATCH SHOT ${k + 1}] ${sh.id.slice(0, 6)} desc="${sh.desc || "(none)"}"`));
              const tM = Date.now();
              const outRaw = await llmText("match_shots", input, getToken());
              const win = normalizeShotWindows(outRaw, targetVisuals, totalMs);
              elog(`[MATCH RET] in ${Date.now() - tM}ms · usable=${!!win}`);
              if (win) elog(`[MATCH WINDOWS] ${win.map((w) => `${w.id.slice(0, 6)}:${w.from_ms}-${w.to_ms}(${w.to_ms - w.from_ms}ms,${w.motion || "?"})`).join(" | ")}`);
              else elog(`[MATCH RAW] ${(outRaw || "").slice(0, 200)}`);
              if (win) {
                source = "match";
                beats = win.map((w) => ({ itemId: w.id, fromMs: w.from_ms, toMs: w.to_ms, text: said(w.from_ms, w.to_ms), motion: w.motion }));
              } else {
                elog("[AI-Edit arrange] match_shots output unusable → transcript even-snap");
              }
            } else {
              elog("[AI-Edit arrange] relevancy skipped", { segs: segs.length, described, why: !segs.length ? "no transcript" : "shots have no descriptions" });
            }
            // STEP 3 — transcript EVEN-SNAP (selection order) when relevancy didn't produce beats.
            if (!beats && segs.length) {
              source = "transcript";
              const totalS = totalMs / 1000;
              const edges: number[] = Array.from(new Set(segs.flatMap((sg: any) => [sg.start, sg.end]))).sort((x, y) => x - y);
              const snap = (t: number) => (edges.length ? edges.reduce((b, c) => (Math.abs(c - t) < Math.abs(b - t) ? c : b), t) : t);
              const cuts = [0];
              for (let k = 1; k < N; k++) { const t = (k / N) * totalS; cuts.push(Math.min(totalS - 0.3, Math.max(cuts[cuts.length - 1] + 0.4, snap(t)))); }
              cuts.push(totalS);
              beats = targetVisuals.map((id, k) => ({ itemId: id, fromMs: Math.round(cuts[k] * 1000), toMs: Math.round(cuts[k + 1] * 1000), text: said(Math.round(cuts[k] * 1000), Math.round(cuts[k + 1] * 1000)) }));
            }
            if (!beats && !segs.length) note = "couldn't read the narration timing, so spaced them evenly";
            if (beats) elog(`[AI-Edit arrange] ✓ BEATS (${source}):`, beats.map((b) => ({ from: b.fromMs, to: b.toMs, text: b.text.slice(0, 28) })));
          } else if (!audio) {
            note = "no voiceover on the timeline — spaced evenly; add an audio track for narration-synced timing";
            elog("[AI-Edit arrange] no audio → even spacing");
          }
        } catch (e) {
          elog("[AI-Edit arrange] ✖ timing ERROR:", e);
          note = "hit an error planning the timing, so spaced them evenly";
        }
        // FALLBACK: no content-aware beats → even, gap-free split across the voiceover (or a default).
        if (!beats || beats.length !== N) {
          const totalMs = audioMs > 1500 ? audioMs : N * 4000;
          const per = Math.floor(totalMs / N);
          beats = targetVisuals.map((id, k) => ({ itemId: id, fromMs: k * per, toMs: k === N - 1 ? totalMs : (k + 1) * per, text: "" }));
          elog(`[AI-Edit arrange] even fallback: ${N} × ${per}ms over ${totalMs}ms`);
        }
        // MIN DURATIONS: images ≥2s, VIDEOS ≥3s (videos are motion — give them priority). A shot below
        // its floor steals time from the shots that have slack (the longest first), keeping the whole
        // sequence contiguous + spanning the same total. Kills the "1s flickery b-roll" look.
        {
          const total = beats[beats.length - 1].toMs;
          const minFor = (id: string) => ((map[id] as any)?.type === "video" ? 3000 : 2000);
          const mins = beats.map((b) => minFor(b.itemId));
          let durs = beats.map((b) => b.toMs - b.fromMs);
          const sumMin = mins.reduce((a, b) => a + b, 0);
          if (sumMin >= total) {
            durs = mins.map((m) => (m / sumMin) * total); // can't fit all floors → scale proportionally
          } else {
            let deficit = 0;
            for (let k = 0; k < durs.length; k++) if (durs[k] < mins[k]) { deficit += mins[k] - durs[k]; durs[k] = mins[k]; }
            let slack = durs.reduce((a, d, k) => a + Math.max(0, d - mins[k]), 0);
            if (deficit > 0 && slack > 0) for (let k = 0; k < durs.length && deficit > 0.5; k++) {
              const give = Math.min(Math.max(0, durs[k] - mins[k]), deficit * (Math.max(0, durs[k] - mins[k]) / slack));
              durs[k] -= give;
            }
          }
          let cur = 0;
          beats = beats.map((b, k) => { const from = cur; const to = k === beats.length - 1 ? total : Math.round(from + durs[k]); cur = to; return { ...b, fromMs: from, toMs: Math.max(from + 300, to) }; });
          beats[beats.length - 1].toMs = total;
          elog(`[MIN DURATIONS] enforced img≥2s / vid≥3s → ${beats.map((b) => `${b.itemId.slice(0, 6)}:${b.toMs - b.fromMs}ms`).join(" | ")}`);
        }
        try {
          s.updateAt(i, { beats }); // persist the CONTEXT — animate / effects / lip-sync read this later
          // ONE authoritative arrange: contiguous, gap-free, all shots CONSOLIDATED onto a single
          // video row (the executor moves them onto one track — see operations.ts arrange handler).
          elog("[AI-Edit arrange] applying arrange (single track, gap-free)");
          applyOperations([{ op: "arrange", items: beats.map((bt) => ({ itemId: bt.itemId, fromMs: bt.fromMs, toMs: bt.toMs })) }]);
          // MOTION: DIRECTED per shot by the LLM (match_shots' `motion` = punchIn/zoomIn/hold/… fitting
          // the dramatic beat + the Vibe) → mapped to Ken Burns kind + intensity. Falls back to an
          // alternating default when there's no directed motion (transcript/even paths). IMAGE shots only
          // (videos move on their own), in ONE batched dispatch (N dispatches race → only last sticks).
          const KB = ["zoomIn", "zoomOut", "panLeft", "panRight", "zoomInPanRight", "zoomInPanLeft"];
          const motionOf = (itemId: string, k: number): { kb: string; intensity: number; dur?: number } => {
            const m = (beats!.find((b) => b.itemId === itemId)?.motion || "").toLowerCase();
            return MOTION_MAP[m] || { kb: KB[k % KB.length], intensity: 20 };
          };
          const imgShots = targetVisuals.filter((id) => (map[id] as any)?.type === "image");
          const applied = applyMotionBatch(imgShots.map((id, k) => { const mv = motionOf(id, k); return { id, kenBurns: mv.kb, intensity: mv.intensity, duration: mv.dur }; }));
          elog(`[MOTION] applied to ${imgShots.length} image shot(s) [${source}]: ${Object.entries(applied).map(([id, kb]) => `${id.slice(0, 6)}=${kb}`).join(", ")}`);
          // READBACK: confirm the kenBurns actually persisted on the items (if it shows here, it renders
          // on PLAY — a paused frame at a clip's start shows scale 1.0, i.e. "no zoom" until you play).
          setTimeout(() => {
            const rm = useStore.getState().trackItemsMap || {};
            elog(`[MOTION READBACK] ${imgShots.map((id) => `${id.slice(0, 6)}=${(rm[id] as any)?.details?.kenBurns || "MISSING"}@${(rm[id] as any)?.details?.kenBurnsIntensity ?? "-"}`).join(", ")}`);
          }, 400);
          elog("[AI-Edit arrange] ✅ DONE — arrange + motion applied");
        } catch (e) {
          elog("[AI-Edit arrange] ✖ applyOperations ERROR:", e);
          note = note || "hit an error placing the clips on the timeline";
        }
        // SHORT REPORT — always fires (even on error), so it never looks "stuck with no output".
        const synced = source === "match" || source === "transcript";
        s.updateAt(i, {
          genStatus: synced
            ? `✓ Arranged ${N} shot${N > 1 ? "s" : ""} — ${source === "match" ? "each placed WHEN the narration talks about it (content-matched)" : "timing synced to the voiceover"}, with motion.`
            : `✓ Arranged ${N} shot${N > 1 ? "s" : ""} with motion — ${note || "no voiceover, so spaced evenly"}.`,
        });
      }
      _arrangeLock.delete(alockKey); // arrange finished → allow a fresh one for this audio
    } else if (newVisual.length) {
      s.updateAt(i, { genStatus: `✓ Added ${newVisual.length} clip${newVisual.length > 1 ? "s" : ""} — say "arrange into a video" to sequence them.` });
    }
    // POST-EFFECTS (transitions / target:"all" edits) — run AFTER the shots are placed, so they hit
    // the arranged clips (an empty timeline earlier would have made them no-ops).
    if (postEffects.length) {
      try {
        // WAIT for the arrange's Ken Burns to fully COMMIT first. designcombo's EDIT_OBJECT is async
        // and captures the state at dispatch time; firing the transition's EDIT_OBJECT immediately
        // after the motion's makes it write back a PRE-MOTION base → details.kenBurns is CLOBBERED
        // (the readback showed MISSING → "only transitions, no zoom"). Poll until the motion lands.
        let kbOk = false;
        for (let t = 0; t < 24; t++) {
          const m = useStore.getState().trackItemsMap || {};
          if (Object.values(m).some((it: any) => it?.type === "image" && (it as any)?.details?.kenBurns && (it as any).details.kenBurns !== "off")) { kbOk = true; break; }
          await new Promise((r) => setTimeout(r, 150));
        }
        elog(`[POST-EFFECTS] motion committed=${kbOk} → applying: ${postEffects.map((o: any) => o.op).join(", ")}`);
        applyOperations(postEffects);
        // readback again so the log proves motion survived the transition
        setTimeout(() => {
          const rm = useStore.getState().trackItemsMap || {};
          const imgs = Object.values(rm).filter((it: any) => it?.type === "image");
          elog(`[POST-EFFECTS READBACK] kenBurns still set on ${imgs.filter((it: any) => it?.details?.kenBurns && it.details.kenBurns !== "off").length}/${imgs.length} images`);
        }, 400);
      } catch (e) {
        elog("[AI-Edit arrange] ✖ post-effects ERROR:", e);
      }
    }
  };

  // Captions — ensure a transcript (transcribe if we don't have one), then lay a
  // word-synced caption track under the audio. Background so the chat stays free.
  const runCaptions = async (i: number, captionOps: any[]) => {
    for (const c of captionOps) {
      const map = useStore.getState().trackItemsMap || {};
      const audio: any = (c.itemId && map[c.itemId]) || Object.values(map).find((it: any) => it?.type === "audio");
      const asrc: string = audio?.details?.src || "";
      if (!audio || !asrc) {
        s.updateAt(i, { genStatus: "⚠️ captions: no audio track found" });
        continue;
      }
      let t: any = useCaptionTranscribeStore.getState().resultsByMedia?.[asrc];
      if (!t?.segments?.length) {
        s.updateAt(i, { genStatus: "Transcribing for captions…" });
        try {
          const segs = await transcribeAudio(asrc, getToken());
          if (segs.length) {
            t = {
              text: "",
              language: "",
              segment_count: segs.length,
              segments: segs.map((x: any) => ({ start: x.start, end: x.end, text: x.text, words: x.words })),
            };
            useCaptionTranscribeStore.getState().setTranscriptResult(asrc, t);
          }
        } catch (e: any) {
          s.updateAt(i, { genStatus: "⚠️ captions: " + (e?.message || "transcribe failed") });
          continue;
        }
      }
      if (t?.segments?.length) {
        const capIds = addCaptions(audio, t);
        const cur = useAiEditStore.getState().messages[i]?.snapshot || {};
        const ns = { ...cur };
        capIds.forEach((id: string) => (ns[id] = null));
        s.updateAt(i, { snapshot: ns, genStatus: capIds.length ? `✓ ${capIds.length} captions added` : "⚠️ captions: nothing built" });
      } else {
        s.updateAt(i, { genStatus: "⚠️ captions: no transcript" });
      }
    }
  };

  // One-shot auto-director: topic → script → voiceover → beat-plan → time-synced visuals → captions.
  // Everything runs in the background; the chat stays free. Created ids accrue into the message
  // snapshot so a single Revert removes the whole generated video.
  const runDirect = async (i: number, op: any) => {
    const topic = String(op.topic || op.prompt || "").trim();
    if (!topic) {
      s.updateAt(i, { genStatus: "⚠️ no topic given" });
      return;
    }
    const durationSec = Math.min(180, Math.max(15, Number(op.durationSec) || 40));
    const useStock = op.mediaKind !== "image" && op.mediaKind !== "video";
    const wantCaptions = op.captions !== false;
    const token = getToken();
    const created: string[] = [];
    const snap = () => {
      const cur = useAiEditStore.getState().messages[i]?.snapshot || {};
      const ns: any = { ...cur };
      created.forEach((id) => (ns[id] = null));
      s.updateAt(i, { snapshot: ns });
    };
    try {
      // 1. Script (faceless-YT scriptwriter task)
      s.updateAt(i, { genStatus: "✍️ Writing the script…" });
      const script = (
        await llmText("script", `Topic: ${topic}\nWrite about ${durationSec} seconds of spoken narration.`, token)
      ).trim();
      if (!script) throw new Error("script generation failed");

      // 2. Voiceover (TTS — spoken verbatim, not optimized)
      s.updateAt(i, { genStatus: "🎙️ Recording the voiceover…" });
      const a = await startGen({ kind: "audio", text: script, token });
      const audioUrl = await waitGen(a.id, (d) =>
        s.updateAt(i, {
          genStatus: d?.queue_position != null ? `🎙️ Voiceover queued #${d.queue_position}…` : "🎙️ Voiceover…",
        })
      );
      const audioId = addAudio(audioUrl, "Voiceover");
      created.push(audioId);
      snap();

      // 3. Transcribe (timing for beats + captions)
      s.updateAt(i, { genStatus: "📝 Transcribing…" });
      const segs = await transcribeAudio(audioUrl, token);
      const transcript = {
        text: "",
        language: "",
        segment_count: segs.length,
        segments: segs.map((x: any) => ({ start: x.start, end: x.end, text: x.text, words: x.words })),
      };
      if (segs.length) useCaptionTranscribeStore.getState().setTranscriptResult(audioUrl, transcript);

      // 4. Beat plan → timed visual beats { from_ms, to_ms, keyword }
      s.updateAt(i, { genStatus: "🎬 Planning the shots…" });
      let beats: any[] = [];
      if (segs.length) {
        try {
          const tLines = segs
            .map((x: any) => `[${Number(x.start).toFixed(1)}-${Number(x.end).toFixed(1)}] ${x.text}`)
            .join("\n");
          const bj = await llmText("beat_plan", tLines, token);
          const mm = bj.match(/\{[\s\S]*\}/);
          const parsed = mm ? JSON.parse(mm[0]) : {};
          beats = Array.isArray(parsed?.beats) ? parsed.beats : [];
        } catch {
          /* fall through to per-segment fallback */
        }
      }
      if (!beats.length) {
        beats = segs.map((x: any) => ({
          from_ms: Math.round(Number(x.start) * 1000),
          to_ms: Math.round(Number(x.end) * 1000),
          keyword: String(x.text || topic).replace(/[.,!?].*$/, "").slice(0, 60),
        }));
      }
      if (!beats.length) beats = [{ from_ms: 0, to_ms: durationSec * 1000, keyword: topic }];

      // 5. Media per beat (stock search or AI-generate)
      const items: { itemId: string; fromMs: number; toMs: number }[] = [];
      for (let k = 0; k < beats.length; k++) {
        const b = beats[k];
        const kw = String(b.keyword || topic).trim();
        s.updateAt(i, { genStatus: `🖼️ Visual ${k + 1}/${beats.length}: ${kw.slice(0, 24)}…` });
        let url = "";
        try {
          if (useStock) {
            const res = await fetch(withEditorBase(`/api/pexels?query=${encodeURIComponent(kw)}&per_page=1`));
            const data = await res.json().catch(() => ({}));
            url = data?.photos?.[0]?.src || "";
          }
          if (!url) {
            const g = await startGen({ kind: "image", prompt: `${kw}, ${topic}`, optimize: useAiEditStore.getState().optimizePrompt, token });
            url = await waitGen(g.id, () => {});
          }
        } catch {
          /* skip this beat */
        }
        if (!url) continue;
        const id = addImage(url, kw);
        created.push(id);
        items.push({ itemId: id, fromMs: Number(b.from_ms) || 0, toMs: Number(b.to_ms) || 0 });
      }
      snap();

      // 6. Arrange to exact beat windows + alternating Ken Burns (ONE batched dispatch, else N
      //    dispatches race and only the last sticks).
      if (items.length) {
        applyOperations([{ op: "arrange", items }] as any);
        applyMotionBatch(items.map((it, k) => ({ id: it.itemId, kenBurns: k % 2 ? "zoomOut" : "zoomIn", intensity: 18 })));
      }

      // 7. Captions
      if (wantCaptions && segs.length) {
        const audio = useStore.getState().trackItemsMap?.[audioId];
        if (audio) {
          const capIds = addCaptions(audio, transcript);
          created.push(...capIds);
          snap();
        }
      }

      s.updateAt(i, {
        genStatus: `✓ Video built — ${items.length} shots${wantCaptions && segs.length ? " + captions" : ""}`,
      });
    } catch (e: any) {
      s.updateAt(i, { genStatus: "⚠️ Director failed: " + (e?.message || "unknown") });
    }
  };

  const applyMsg = (i: number, m: any) => {
    if (!m.ops?.length) return;
    // DOUBLE-APPLY GUARD: autoApply + a manual Apply (or a re-render) could call this twice → two
    // runBuilds re-transcribe + re-arrange and CLOBBER each other (the log showed a 2nd arrange whose
    // transcribe timed out after the 1st already finished). Claim the message synchronously; once
    // applied, never again.
    elog(`[AI-Edit] applyMsg(i=${i}) — ops:${m.ops.length}, alreadyApplied:${!!useAiEditStore.getState().messages[i]?.applied}`);
    if (useAiEditStore.getState().messages[i]?.applied) { elog("[AI-Edit] applyMsg skipped — already applied (double-trigger caught)"); return; }
    s.updateAt(i, { applied: true });
    const sync = m.ops.filter((o: any) => !["generate", "regenerate", "search", "animate", "arrange", "captions", "direct"].includes(o.op));
    const gens = m.ops.filter((o: any) => ["generate", "regenerate", "search", "animate"].includes(o.op));
    const arranges = m.ops.filter((o: any) => o.op === "arrange");
    const captionOps = m.ops.filter((o: any) => o.op === "captions");
    const directs = m.ops.filter((o: any) => o.op === "direct");

    // POST-EFFECTS: transitions + "target:all/selected" edits target the shots the build produces, so
    // when this message also generates/arranges, they must run AFTER the arrange (not on an empty
    // timeline). A plain edit ("add a transition to these clips") has no build → applies immediately.
    const willBuild = gens.length || arranges.length;
    const isPostEffect = (o: any) => o.op === "transition" || (o.op === "edit" && (o.target === "all" || o.target === "selected"));
    const postEffects = willBuild ? sync.filter(isPostEffect) : [];
    const immediateSync = willBuild ? sync.filter((o: any) => !isPostEffect(o)) : sync;

    // sync ops apply immediately
    const snapshot = captureSnapshot(immediateSync, trackItemsMap);
    if (immediateSync.length)
      elog(`[AI-Edit] applying ${immediateSync.length} edit(s):`, immediateSync.map((o: any) => `${o.op}${o.target ? `→${o.target}` : o.itemIds?.length ? `→${o.itemIds.length} items` : o.itemId ? `→${String(o.itemId).slice(0, 6)}` : ""}${o.details?.kenBurns ? ` kb=${o.details.kenBurns}` : ""}${o.details?.opacity != null ? ` opacity=${o.details.opacity}` : ""}`));
    const { addedIds } = applyOperations(immediateSync);
    for (const id of addedIds) snapshot[id] = null;

    const now = new Date();
    const historyId = `${now.getTime()}-${Math.random().toString(36).slice(2, 6)}`;
    s.updateAt(i, { applied: true, snapshot, historyId });
    s.addHistory({ id: historyId, time: now.toLocaleTimeString(), summary: m.content || "Applied edit", ops: m.ops, snapshot });

    // generation (+ deferred arrange + post-effects) + captions run in the background — chat stays free
    if (willBuild) runBuild(i, gens, arranges, postEffects);
    if (captionOps.length) runCaptions(i, captionOps);
    for (const d of directs) runDirect(i, d);
  };

  const revertMsg = (i: number, m: any) => {
    if (!m.snapshot) return;
    revertSnapshot(m.snapshot);
    if (m.historyId) s.markReverted(m.historyId);
    s.updateAt(i, { reverted: true });
  };

  const copy = (text: string) => {
    try {
      navigator.clipboard?.writeText(text);
    } catch {
      /* ignore */
    }
  };

  const send = () => {
    const t = s.input;
    s.setInput("");
    runPrompt(t);
  };

  const lastUserText = [...s.messages].reverse().find((m) => m.role === "user")?.content || "";
  // Live status of the current run (LLM + background generation) — surfaced at the TOP of the
  // panel so the user always sees what's happening without scrolling to the last message.
  const lastAsst = [...s.messages].reverse().find((m) => m.role === "assistant");
  const liveStatus = lastAsst?.genStatus || "";

  if (!s.isOpen) return null;

  const panelStyle: React.CSSProperties = s.isFullscreen
    ? { position: "fixed", left: 0, top: 0, width: "100vw", height: "100vh", zIndex: 1000, overflow: "visible" }
    : { position: "fixed", left: s.floatPos.x, top: s.floatPos.y, width: s.panelSize.width, zIndex: 1000, overflow: "visible" };
  const bodyHeight = s.isFullscreen ? "calc(100vh - 42px)" : s.panelSize.height;
  const iconBtn =
    "flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground hover:text-foreground";
  const act = "text-[10px] text-muted-foreground hover:text-foreground";

  return (
    <div className="rounded-2xl border border-border bg-background shadow-xl" style={panelStyle}>
      {/* Header */}
      <div
        onMouseDown={
          !s.isFullscreen
            ? (e) =>
                (dragRef.current = {
                  dragging: true,
                  startX: e.clientX,
                  startY: e.clientY,
                  originX: s.floatPos.x,
                  originY: s.floatPos.y,
                })
            : undefined
        }
        onDoubleClick={() => s.setFullscreen(!s.isFullscreen)}
        className={`flex select-none items-center justify-between rounded-t-2xl border-b border-border/60 bg-card px-3 py-2 ${
          !s.isFullscreen ? "cursor-grab" : "cursor-default"
        }`}
      >
        <div className="flex items-center gap-2">
          <div className="grid grid-cols-2 gap-[3px]">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-[3px] w-[3px] rounded-full bg-muted-foreground/30" />
            ))}
          </div>
          <span className="text-[11px] font-medium text-foreground">✦ AI Edit</span>
          {working || elapsed > 0 ? (
            <span
              className={`flex items-center gap-1 rounded-full px-2 py-[1px] text-[10px] font-medium tabular-nums ${working ? "bg-sky-500/15 text-sky-600" : "bg-emerald-500/15 text-emerald-600"}`}
              title={working ? "Working…" : "Total time for the last run"}
            >
              {working ? <span className="h-[6px] w-[6px] animate-pulse rounded-full bg-sky-500" /> : <span>✓</span>}
              {elapsed}s
            </span>
          ) : (
            chips.length > 0 && <span className="text-[11px] text-muted-foreground">{chips.length} selected</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => s.setShowHistory(!s.showHistory)}
            className={`${iconBtn} ${s.showHistory ? "bg-sky-500/20 text-sky-600" : ""}`}
            title="Change history"
          >
            🕑
          </button>
          <button
            onClick={() => s.setShowFeatures(!s.showFeatures)}
            className={`${iconBtn} ${s.showFeatures ? "bg-sky-500/20 text-sky-600" : ""}`}
            title="What you can ask"
          >
            💡
          </button>
          <button
            ref={settingsBtnRef}
            onClick={() => s.setShowSettings(!s.showSettings)}
            className={`${iconBtn} ${s.showSettings ? "bg-sky-500/20 text-sky-600" : ""}`}
            title="Settings"
          >
            ⚙
          </button>
          <button
            onClick={s.clearChat}
            className="rounded px-2 py-0.5 text-[9px] text-muted-foreground hover:bg-muted hover:text-foreground"
            title="New chat — clears the conversation (each request is already sent fresh, no old context)"
          >
            ＋ New
          </button>
          <button onClick={() => s.setFullscreen(!s.isFullscreen)} className={iconBtn} title="Fullscreen">
            {s.isFullscreen ? "⊡" : "⊞"}
          </button>
          <button onClick={() => s.setCollapsed(!s.isCollapsed)} className={iconBtn}>
            {s.isCollapsed ? "+" : "—"}
          </button>
          <button onClick={() => s.setOpen(false)} className={`${iconBtn} hover:bg-red-500/20 hover:text-red-500`}>
            ✕
          </button>
        </div>
      </div>

      {!s.isCollapsed && (
        <div className="relative flex flex-col rounded-b-2xl" style={{ height: bodyHeight }}>
          {/* Settings popover */}
          {s.showSettings && (
            <div ref={settingsRef} className="absolute right-2 top-1 z-20 w-56 rounded-xl border border-border bg-popover p-2.5 shadow-lg">
              <label className="flex items-center justify-between py-1 text-[12px] text-foreground">
                <span>Mode</span>
                <select
                  value={s.autoApply ? "auto" : "ask"}
                  onChange={(e) => s.setAutoApply(e.target.value === "auto")}
                  className="h-6 rounded border border-border bg-muted/50 px-1 text-[11px] text-foreground outline-none"
                >
                  <option value="ask">Ask (preview)</option>
                  <option value="auto">Auto-apply</option>
                </select>
              </label>
              <label className="flex cursor-pointer items-center justify-between py-1 text-[12px] text-foreground">
                <span>Streaming</span>
                <input type="checkbox" checked={s.streaming} onChange={(e) => s.setStreaming(e.target.checked)} />
              </label>
              <label className="flex cursor-pointer items-center justify-between py-1 text-[12px] text-foreground">
                <span>Show thinking</span>
                <input type="checkbox" checked={s.showThinking} onChange={(e) => s.setShowThinking(e.target.checked)} />
              </label>
              <label className="flex cursor-pointer items-center justify-between py-1 text-[12px] text-foreground">
                <span>Optimise prompt</span>
                <input type="checkbox" checked={s.optimizePrompt} onChange={(e) => s.setOptimizePrompt(e.target.checked)} />
              </label>
              <p className="mt-1 text-[9px] text-muted-foreground">Auto = applies without asking. Optimise = AI enriches image/video prompts before generating (editor-only — independent of vApp Studio).</p>
            </div>
          )}

          {/* Features popover */}
          {s.showFeatures && (
            <div className="absolute right-2 top-1 z-20 max-h-[70%] w-64 overflow-y-auto rounded-xl border border-border bg-popover p-2.5 shadow-lg">
              <p className="mb-1 text-[11px] font-semibold text-foreground">What you can ask</p>
              {CAPABILITIES.map((g) => (
                <div key={g.group} className="mb-1.5">
                  <p className="text-[9px] uppercase tracking-wide text-muted-foreground/70">{g.group}</p>
                  {g.items.map((it) => (
                    <button
                      key={it.label}
                      onClick={() => {
                        s.setInput(it.example);
                        s.setShowFeatures(false);
                      }}
                      className="block w-full rounded-md px-1.5 py-1 text-left text-[11px] hover:bg-muted"
                    >
                      <span className="font-medium text-foreground">{it.label}</span>
                      <span className="ml-1 text-muted-foreground/60">— {it.example}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Selection chips */}
          <div className="shrink-0 border-b border-border/50 px-3 py-2">
            {chips.length ? (
              <div className="flex flex-wrap gap-1.5">
                {chips.map((c) => (
                  <span
                    key={c.id}
                    onClick={() => {
                      // Select ONLY this clip in the timeline + jump the playhead to
                      // its start. Direct store write is the app's canonical selection
                      // control (menu-list uses the same) — the LAYER_SELECTION dispatch
                      // was clearing the whole selection instead of narrowing it.
                      useStore.setState({ activeIds: [c.id] });
                      const from = Number((trackItemsMap as any)?.[c.id]?.display?.from) || 0;
                      dispatch(PLAYER_SEEK, { payload: { time: from } });
                    }}
                    className="group flex cursor-pointer items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pl-0.5 pr-1.5 text-[10px] text-foreground/80 transition hover:border-sky-500/40"
                    title={`Select in timeline + jump playhead · ${c.id}`}
                  >
                    {c.src ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.src} alt="" className="h-4 w-4 shrink-0 rounded-full object-cover" />
                    ) : (
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[8px]">
                        {c.type === "audio" ? "♪" : c.type === "text" || c.type === "caption" ? "T" : "▦"}
                      </span>
                    )}
                    <span className="max-w-[90px] truncate font-medium">{c.name}</span>
                    <span className="text-muted-foreground/50">{(c.durationMs / 1000).toFixed(1)}s</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        useStore.setState({ activeIds: activeIds.filter((x) => x !== c.id) });
                      }}
                      className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-muted-foreground/40 hover:bg-red-500/20 hover:text-red-500"
                      title="Deselect"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                {liveStatus ? (
                  <span className="flex items-center gap-1.5 text-sky-600 dark:text-sky-400">
                    {!/^\s*[✓⚠️]/.test(liveStatus) && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />}
                    <span className="truncate">{liveStatus}</span>
                  </span>
                ) : (
                  "Select a clip, then describe the edit — or tap 💡 for ideas."
                )}
              </p>
            )}
          </div>

          {/* History view OR chat */}
          {s.showHistory ? (
            <div className="flex-1 space-y-2 overflow-y-auto p-3">
              {s.history.length === 0 && (
                <p className="mt-8 text-center text-[11px] text-muted-foreground/50">No applied changes yet.</p>
              )}
              {s.history.map((h) => (
                <div
                  key={h.id}
                  className={`rounded-lg border p-2 ${h.reverted ? "border-border/40 opacity-50" : "border-border"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] text-muted-foreground">{h.time}</span>
                    {h.reverted ? (
                      <span className="text-[10px] text-muted-foreground">reverted</span>
                    ) : (
                      <button
                        onClick={() => {
                          revertSnapshot(h.snapshot);
                          s.markReverted(h.id);
                        }}
                        className="rounded px-2 py-0.5 text-[10px] text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
                      >
                        ↩ Revert
                      </button>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12px] text-foreground/90">{h.summary}</p>
                  <div className="mt-1 space-y-0.5">
                    {h.ops.map((op, i) => (
                      <p key={i} className="font-mono text-[9px] text-muted-foreground">
                        {describeOp(op)}
                      </p>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3">
              {s.messages.length === 0 && (
                <p className="mt-8 text-center text-[11px] text-muted-foreground/50">
                  Try: &ldquo;make this 3 seconds&rdquo; · &ldquo;zoom in&rdquo; · &ldquo;rotate 10°&rdquo; · &ldquo;add a title&rdquo;
                  <br />
                  Tap 💡 to see everything you can ask.
                </p>
              )}
              {s.messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-sky-600 px-3 py-1.5 text-[13px] text-white">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={i}>
                    {s.showThinking && m.reasoning ? (
                      <div className="mb-1">
                        <button
                          onClick={() => s.updateAt(i, { thinkingOpen: !m.thinkingOpen })}
                          className="flex items-center gap-1 text-[10px] text-amber-600/80 hover:text-amber-600 dark:text-amber-300/70"
                        >
                          <span>{m.thinkingOpen ? "▾" : "▸"}</span>
                          <span>💭 Thought</span>
                          {m.reasoningMs != null && (
                            <span className="text-[9px] opacity-60">{(m.reasoningMs / 1000).toFixed(1)}s</span>
                          )}
                        </button>
                        {m.thinkingOpen && (
                          <div className="mt-1 max-h-28 overflow-y-auto rounded-lg border border-amber-500/20 bg-amber-500/5 px-2 py-1 text-[10px] italic leading-relaxed text-amber-700/80 dark:text-amber-300/70">
                            {m.reasoning}
                          </div>
                        )}
                      </div>
                    ) : null}
                    <div className="text-[13px] leading-relaxed text-foreground/90">
                      <span className="whitespace-pre-wrap">
                        {m.content || (s.busy && i === s.messages.length - 1 ? "…" : "")}
                      </span>
                      {m.genStatus && (
                        <span
                          className={`ml-2 whitespace-nowrap text-[10px] ${
                            m.genStatus.startsWith("⚠️")
                              ? "text-red-500"
                              : m.genStatus.startsWith("✓")
                              ? "text-emerald-600"
                              : "text-sky-500"
                          }`}
                        >
                          {!m.genStatus.startsWith("✓") && !m.genStatus.startsWith("⚠️") && "● "}
                          {m.genStatus}
                        </span>
                      )}
                    </div>
                    {m.genPreviews?.map((pv, k) => (
                      <div key={k} className="mt-1.5">
                        {pv.kind === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={pv.url} alt="" className="max-h-40 rounded-lg border border-border" />
                        ) : pv.kind === "video" ? (
                          <video src={pv.url} controls className="max-h-40 w-full rounded-lg border border-border" />
                        ) : (
                          <audio src={pv.url} controls className="w-full" />
                        )}
                      </div>
                    ))}

                    {/* Inline proposed operations */}
                    {m.ops && m.ops.length > 0 && !m.applied && (
                      <div className="mt-1.5 rounded-xl border border-sky-500/40 bg-sky-500/5 p-2">
                        {m.ops.map((op: any, k: number) => (
                          <div key={k} className="rounded-lg bg-background/60 px-2 py-1 font-mono text-[10px] text-foreground/80">
                            {describeOp(op)}
                          </div>
                        ))}
                        <div className="mt-1.5 flex gap-1.5">
                          <button
                            onClick={() => applyMsg(i, m)}
                            className="flex-1 rounded-lg bg-sky-500/20 py-1.5 text-[11px] font-semibold text-sky-600 hover:bg-sky-500/30 dark:text-sky-300"
                          >
                            Apply
                          </button>
                          <button
                            onClick={() => s.updateAt(i, { ops: undefined })}
                            className="rounded-lg bg-muted px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                          >
                            Discard
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Action row */}
                    {m.content && !m.content.startsWith("⚠️") && (
                      <div className="mt-1 flex items-center gap-2.5">
                        <button onClick={() => copy(m.content)} className={act}>
                          Copy
                        </button>
                        {i === s.messages.length - 1 && lastUserText && !s.busy && (
                          <button onClick={() => s.setInput(lastUserText)} className={act} title="Put this prompt back in the box to edit & resend">
                            Retry
                          </button>
                        )}
                        {m.applied && !m.reverted && (
                          <button onClick={() => revertMsg(i, m)} className="text-[10px] text-amber-600 hover:text-amber-500 dark:text-amber-400">
                            ↩ Revert
                          </button>
                        )}
                        {m.applied && !m.reverted && <span className="text-[10px] text-sky-500/70">applied</span>}
                        {m.reverted && <span className="text-[10px] text-muted-foreground">reverted</span>}
                      </div>
                    )}
                  </div>
                )
              )}
            </div>
          )}

          {/* Composer */}
          <div className="shrink-0 border-t border-border/50 p-2">
            <div className="rounded-xl border border-border bg-muted/40 p-1.5 focus-within:border-sky-500/40">
              <textarea
                value={s.input}
                onChange={(e) => s.setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={2}
                placeholder={
                  s.pipeline === "comic_drama"
                    ? 'Enter a story idea, e.g. "a billionaire\'s secret revenge"…'
                    : s.pipeline === "faceless_video"
                      ? 'Enter a topic, e.g. "the history of black holes"…'
                      : "Describe the edit…"
                }
                className="max-h-32 min-h-[36px] w-full resize-none bg-transparent px-1.5 py-1 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/40"
              />
              <div className="mt-1 flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5 pl-1">
                  {s.autoApply && <span className="text-[9px] text-emerald-600/70">auto</span>}
                  {s.streaming && <span className="text-[9px] text-sky-500/70">streaming</span>}
                  {!s.showThinking && <span className="text-[9px] text-muted-foreground/60">fast</span>}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {s.models.length > 0 && (
                    <select
                      value={s.model}
                      onChange={(e) => s.setModel(e.target.value)}
                      className="h-7 max-w-[92px] truncate rounded-lg border border-border bg-background px-1.5 text-[10px] text-muted-foreground outline-none"
                      title="Model"
                    >
                      {s.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  )}
                  {/* Pipeline — swaps the system prompt to build a whole video from a
                      topic/story (Comic Drama on top, Faceless Video below). "" = normal Edit. */}
                  <select
                    value={s.pipeline}
                    onChange={(e) => s.setPipeline(e.target.value)}
                    className={`h-7 max-w-[124px] truncate rounded-lg border px-1.5 text-[10px] outline-none ${
                      s.pipeline
                        ? "border-violet-500/50 bg-violet-500/15 text-violet-600 dark:text-violet-300"
                        : "border-border bg-background text-muted-foreground"
                    }`}
                    title="Pipeline — build a whole video from a topic/story"
                  >
                    <option value="">✦ Edit</option>
                    {PIPELINES.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  {/* Vibe preset — compact custom dropdown: built-in + your own presets (add / edit /
                      delete, saved in localStorage). A style phrase injected into the plan + timing. */}
                  {s.pipeline && (
                    <div className="relative" ref={vibeMenuRef}>
                      <button
                        type="button"
                        onClick={() => setVibeMenuOpen((o) => !o)}
                        className={`flex h-7 max-w-[120px] items-center gap-1 truncate rounded-lg border px-1.5 text-[10px] outline-none ${
                          s.vibe
                            ? "border-amber-500/50 bg-amber-500/15 text-amber-600 dark:text-amber-300"
                            : "border-border bg-background text-muted-foreground"
                        }`}
                        title="Vibe — look & pace preset"
                      >
                        <span className="truncate">{curVibe && s.vibe ? curVibe.label : "🎨 Vibe"}</span>
                        <span className="opacity-60">▾</span>
                      </button>
                      {vibeMenuOpen && (
                        <div className="absolute bottom-full right-0 z-50 mb-1 max-h-[260px] w-[200px] overflow-auto rounded-lg border border-border bg-background p-1 shadow-xl">
                          {allVibes.map((v) => {
                            const custom = v.id.startsWith("custom_");
                            return (
                              <div key={v.id || "none"} className="group flex items-center rounded-md hover:bg-muted/60">
                                <button
                                  type="button"
                                  onClick={() => { s.setVibe(v.id); setVibeMenuOpen(false); setVibeEdit(null); }}
                                  className={`flex-1 truncate px-2 py-1 text-left text-[11px] ${s.vibe === v.id ? "font-medium text-amber-600 dark:text-amber-300" : "text-foreground"}`}
                                >
                                  {v.id ? v.label : "None"}
                                  {!v.id && <span className="text-muted-foreground"> · default</span>}
                                </button>
                                {custom && (
                                  <>
                                    <button type="button" title="Edit" onClick={() => setVibeEdit({ id: v.id, label: v.label, style: v.style })} className="px-1 text-[11px] text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100">✎</button>
                                    <button type="button" title="Delete" onClick={() => s.removeCustomVibe(v.id)} className="px-1 pr-1.5 text-[11px] text-muted-foreground opacity-0 hover:text-red-500 group-hover:opacity-100">🗑</button>
                                  </>
                                )}
                              </div>
                            );
                          })}
                          <div className="my-1 border-t border-border" />
                          {vibeEdit ? (
                            <div className="flex flex-col gap-1 p-1">
                              <input
                                autoFocus
                                value={vibeEdit.label}
                                onChange={(e) => setVibeEdit({ ...vibeEdit, label: e.target.value })}
                                placeholder="Name (e.g. 🌧️ Rainy Noir)"
                                className="h-6 rounded border border-border bg-background px-1.5 text-[11px] outline-none focus:border-amber-500/60"
                              />
                              <textarea
                                value={vibeEdit.style}
                                onChange={(e) => setVibeEdit({ ...vibeEdit, style: e.target.value })}
                                placeholder="Style / pace, e.g. dark rainy noir, slow moody holds, cold blue grade"
                                rows={2}
                                className="resize-none rounded border border-border bg-background px-1.5 py-1 text-[11px] outline-none focus:border-amber-500/60"
                              />
                              <div className="flex justify-end gap-1">
                                <button type="button" onClick={() => setVibeEdit(null)} className="rounded px-2 py-[2px] text-[10px] text-muted-foreground hover:bg-muted">Cancel</button>
                                <button type="button" onClick={saveVibe} disabled={!vibeEdit.label.trim() || !vibeEdit.style.trim()} className="rounded bg-amber-600 px-2 py-[2px] text-[10px] text-white hover:bg-amber-500 disabled:opacity-40">Save</button>
                              </div>
                            </div>
                          ) : (
                            <button type="button" onClick={() => setVibeEdit({ id: "new", label: "", style: "" })} className="w-full rounded-md px-2 py-1 text-left text-[11px] text-sky-600 hover:bg-muted/60">
                              + Add preset
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  <button
                    onClick={s.busy ? stopWork : send}
                    disabled={!s.busy && !s.input.trim()}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white transition disabled:opacity-40 ${s.busy ? "bg-red-600 hover:bg-red-500" : "bg-sky-600 hover:bg-sky-500"}`}
                    title={s.busy ? "Stop the AI" : "Send"}
                  >
                    {s.busy ? "■" : "↑"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Resize handles */}
      <div
        onMouseDown={(e) => {
          e.stopPropagation();
          resizeLeftRef.current = { resizing: true, startX: e.clientX, originW: s.panelSize.width, originX: s.floatPos.x };
        }}
        className="absolute bottom-0 top-0 cursor-ew-resize"
        style={{ left: -4, width: 8, zIndex: 10 }}
      />
      <div
        onMouseDown={(e) => {
          e.stopPropagation();
          resizeRef.current = {
            resizing: true,
            startX: e.clientX,
            startY: e.clientY,
            originW: s.panelSize.width,
            originH: s.panelSize.height,
          };
        }}
        className="absolute bottom-0 top-0 cursor-ew-resize"
        style={{ right: -4, width: 8, zIndex: 10 }}
      />
      <div
        onMouseDown={(e) => {
          e.stopPropagation();
          resizeRef.current = {
            resizing: true,
            startX: e.clientX,
            startY: e.clientY,
            originW: s.panelSize.width,
            originH: s.panelSize.height,
          };
        }}
        className="absolute cursor-se-resize"
        style={{ right: -4, bottom: -4, width: 16, height: 16, zIndex: 11 }}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          style={{ position: "absolute", right: 4, bottom: 4 }}
          className="text-muted-foreground/40"
        >
          <path d="M9 3 L3 9 M9 6 L6 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
