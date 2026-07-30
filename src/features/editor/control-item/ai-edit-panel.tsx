"use client";
import { useEffect, useRef, useState } from "react";
import useAiEditStore from "../store/use-ai-edit-store";
import useStore from "../store/use-store";
import { uploadVappMediaFile, getVappUploadCtx } from "@/utils/vapp-upload-client";
import { dispatch } from "@designcombo/events";
import { PLAYER_SEEK } from "../constants/events";
import useCaptionTranscribeStore from "../captions/transcribe-store";
import useAudioLibraryStore from "../store/use-audio-library-store";
import { addCaptions } from "../captions/builder";
import {
  applyOperations,
  applyMotionBatch,
  placeAudioClips,
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
} from "../ai-edit/operations";
import {
  LIPSYNC_WORDS_PER_SEC,
  LIPSYNC_DURATION_MULT,
  LIPSYNC_MIN_SECS,
  LIPSYNC_MAX_SECS,
  LIPSYNC_WITH_AUDIO,
  LIPSYNC_I2V_EDIT_FIRST,
  LIPSYNC_VIDEO_MAX_SECS,
} from "../ai-edit/editor-config";

// Editor is served under Next basePath `/editor` — its API is /editor/api/*.
const withEditorBase = (path: string) => {
  if (typeof window === "undefined") return path;
  return window.location.pathname.startsWith("/editor") ? `/editor${path}` : path;
};

const getToken = () => {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("token") || "";
};

// vApp base URL from the launch params — needed only for the superadmin director-override gate
// (the PUT verifies the caller's role against the vApp). "" lets the server fall back to its default.
const getBaseUrl = () => {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("baseUrl") || "";
};

// The last pipeline (Comic Drama / Faceless) request text — so the arrange can pass the user's own
// direction ("punchy zoom-ins", "slow holds", "hard cuts") into match_shots, which decides motion +
// pacing. Without this, only the Vibe preset drives motion; with it, the PROMPT drives it too.
let _lastPipelineRequest = "";

// Pipeline generation mode. false = the director writes FULL cinematic prompts that go straight to the
// model (best quality — what worked). true = "director writes SHORT hints → global optimizer expands
// each" (lighter director; flip this AND switch the director prompt back to short hints if the director
// ever gets too heavy again). Kept as a flag so the optimizer-expand path is one edit away, not deleted.
const PIPELINE_FORCE_OPTIMIZE = false;

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

// A generate-video op is a TALKING / lip-sync shot when the DIRECTOR flags it `talk:true` — never a
// hard-coded keyword. Fallback: a speech verb + a quote in the prompt (says / speaks / whispers /
// yells / asks / announces …, LTX lip-syncs on any of them), in case the flag is missing.
const TALK_RE = /\b(say|says|said|speak|speaks|spoke|whisper|whispers|yell|yells|shout|shouts|ask|asks|scream|screams|call|calls|reply|replies|tell|tells|announce|announces|mutter|mutters|murmur|murmurs|cry|cries|snap|snaps)\b\s*[:'"“]/i;
const isTalkOp = (o: any) => o?.talk === true || (o?.op === "generate" && o?.kind === "video" && TALK_RE.test(String(o?.prompt || "")));
// A talking shot's video MUST be long enough for the spoken line, else LTX cuts the voice mid-sentence.
// The director can't count words → it emits the exact words as `op.line`; we size the clip from that.
// The estimate (words-per-sec, multiplier, min/max) is CONFIGURABLE in editor-config.ts — see the
// LIPSYNC_* constants there. Falls back to parsing the quoted words out of the prompt if `line` is
// missing. Returns 0 when there's no spoken line.
// The EXACT spoken words of a talking shot: the director emits them as op.line; fall back to the words
// quoted after a speech verb in the prompt. Used both to size the clip AND to speak the line as clean TTS.
const lineOf = (op: any): string => {
  let line = String(op?.line || "").trim();
  if (!line) {
    const m = String(op?.prompt || "").match(/\b(?:say|says|said|speak|speaks|spoke|whisper|whispers|yell|yells|shout|shouts|ask|asks|announce|announces|reply|replies|tell|tells|call|calls|murmur|murmurs|mutter|mutters|cry|cries)\b[^'"“]*['"“]([^'"”]+)['"”]/i);
    line = m ? m[1] : "";
  }
  return line;
};
const spokenSecs = (op: any): number => {
  const line = lineOf(op);
  const words = line ? line.trim().split(/\s+/).filter(Boolean).length : 0;
  if (!words) return 0;
  const secs = Math.ceil((words / LIPSYNC_WORDS_PER_SEC) * LIPSYNC_DURATION_MULT);
  return Math.min(LIPSYNC_MAX_SECS, Math.max(LIPSYNC_MIN_SECS, secs));
};

// Map a shot's aspect_ratio → the Pexels `orientation` filter so a stock search returns media that
// matches the video (was pulling 9:16 portrait stock into a 16:9 project). "" = no filter.
const aspectOrientation = (ar?: string): string => {
  const a = String(ar || "").trim();
  if (a === "9:16" || a === "4:5") return "portrait";
  if (a === "1:1") return "square";
  if (a === "16:9") return "landscape";
  return "";
};

// Abort controller for the LLM chat request (the streaming plan). The Stop button aborts it → the
// SSE fetch closes → the SERVER stops the LLM stream too (a TRUE stop). Generation jobs are NOT
// stopped — they run in parallel on the vApp queue (good) and can't be pulled back anyway.
let _work: AbortController | null = null;
// The Stop button also halts the BACKGROUND build (gens already queued can't be pulled, but we skip
// the remaining stages — arrange etc). Reset on every send.
let _stopBuild = false;
// A run id shared by EVERY LLM call this send makes (script → director → optimizer → match_shots).
// Stop POSTs it to /vapp/llm/stop → the server kills whichever call is live, regardless of the model
// or preset. This is the RELIABLE stop (disconnect-through-the-proxy was the flaky part). Reset per send.
let _session = "";
const _newSession = () =>
  (globalThis.crypto?.randomUUID?.() || `s_${Date.now()}_${Math.random().toString(36).slice(2)}`);
// Fire-and-forget imperative kill: tells the vApp to stop the backend LLM for this run NOW, without
// relying on the fetch abort reaching LM Studio. Safe no-op if the session never started a stream.
function _serverStopLlm(session: string) {
  if (!session) return;
  try {
    fetch(withEditorBase("/api/ai-edit/stop"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session }),
      keepalive: true, // still delivers if the panel/route is torn down right after
    }).catch(() => {});
  } catch {
    /* ignore — Stop must never throw */
  }
}

let _aiPositionSet = false;

async function runChat(
  payload: Record<string, any>,
  onDelta: (p: { content: string; reasoning: string }) => void,
  signal?: AbortSignal
): Promise<{ content: string; reasoning: string }> {
  const res = await fetch(withEditorBase("/api/ai-edit"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, session: _session }), // session → server can be told to stop this run
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

// ── Shared BATCH job poller ─────────────────────────────────────────────────────────────────────
// Instead of N per-job LONG-polls (each a long-held connection that dies behind a proxy + updates
// late), ONE SHORT call every ~2s for ALL pending request_ids at once. Each gen just registers its id
// and awaits. The vApp already has the data (vapp_jobs) so the call returns instantly. Short
// connections = proxy-safe; batched = efficient no matter how many gens run in parallel.
type _JobWaiter = { resolve: (url: string) => void; reject: (e: any) => void; onStatus: (d: any) => void; started: number };
const _jobWaiters = new Map<string, _JobWaiter>();
let _jobPoll: any = null;
async function _pollJobsOnce() {
  const ids = Array.from(_jobWaiters.keys());
  if (!ids.length) { if (_jobPoll) { clearInterval(_jobPoll); _jobPoll = null; } return; }
  let m: any = {};
  try {
    const r = await fetch(withEditorBase(`/api/jobs-status?ids=${encodeURIComponent(ids.join(","))}`), { cache: "no-store" });
    m = await r.json().catch(() => ({}));
  } catch (e) { elog(`[jobs] poll FETCH FAILED: ${e}`); m = {}; }
  for (const id of ids) {
    const w = _jobWaiters.get(id);
    if (!w) continue;
    const d = m?.[id];
    if (d) {
      const st = String(d.status || "").toLowerCase();
      if (st === "completed" && d.output_url) { _jobWaiters.delete(id); elog(`[jobs] ✓ ${id.slice(0, 8)} DONE → …${String(d.output_url).slice(-46)}`); w.resolve(String(d.output_url)); continue; }
      if (st === "failed" || st === "cancelled") { _jobWaiters.delete(id); elog(`[jobs] ✖ ${id.slice(0, 8)} ${st}: ${d.error || ""}`); w.reject(new Error(d.error || "generation failed")); continue; }
      w.onStatus(d);
    }
    if (Date.now() - w.started > 12 * 60 * 1000) { _jobWaiters.delete(id); elog(`[jobs] ⏱ ${id.slice(0, 8)} 12-min timeout`); w.reject(new Error("timed out")); } // 12-min safety
  }
}
function waitGen(id: string, onStatus: (d: any) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!id) { reject(new Error("no request id")); return; }
    _jobWaiters.set(id, { resolve, reject, onStatus, started: Date.now() });
    if (!_jobPoll) { _pollJobsOnce(); _jobPoll = setInterval(_pollJobsOnce, 2000); }
  });
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

// ── LIP-SYNC helpers ──────────────────────────────────────────────────────────────────────────
const _normWord = (w: string): string => String(w || "").toLowerCase().replace(/[^a-z0-9']/g, "");
// Flatten a transcription into word-level tokens (ms). Falls back to an even split of a segment
// when the model gave no per-word timestamps.
async function transcribeWords(src: string, token: string): Promise<{ w: string; start: number; end: number }[]> {
  const segs = await transcribeAudio(src, token);
  const out: { w: string; start: number; end: number }[] = [];
  for (const s of segs) {
    if (Array.isArray(s.words) && s.words.length) {
      for (const wd of s.words) { const w = _normWord(wd.word); if (w) out.push({ w, start: wd.start * 1000, end: wd.end * 1000 }); }
    } else {
      const ws = String(s.text || "").trim().split(/\s+/).filter(Boolean);
      const dur = (s.end - s.start) / Math.max(1, ws.length);
      ws.forEach((word, k) => { const w = _normWord(word); if (w) out.push({ w, start: (s.start + k * dur) * 1000, end: (s.start + (k + 1) * dur) * 1000 }); });
    }
  }
  return out;
}
// Longest CONTIGUOUS run of words shared by two token arrays → the aligned index span in each.
function longestWordMatch(a: string[], b: string[]): { aStart: number; aEnd: number; bStart: number; bEnd: number; len: number } {
  let best = { len: 0, aEnd: -1, bEnd: -1 };
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) { dp[j] = prev + 1; if (dp[j] > best.len) best = { len: dp[j], aEnd: i - 1, bEnd: j - 1 }; }
      else dp[j] = 0;
      prev = tmp;
    }
  }
  return { len: best.len, aStart: best.aEnd - best.len + 1, aEnd: best.aEnd, bStart: best.bEnd - best.len + 1, bEnd: best.bEnd };
}

// Generic unified-LLM text call → /api/ai-llm → vApp /vapp/llm. Used by the auto-director
// for the `script` + `beat_plan` tasks. Fail-open: returns "" on any error.
async function llmText(task: string, input: string, token: string, images?: string[]): Promise<string> {
  try {
    const res = await fetch(withEditorBase("/api/ai-llm"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, input, token, session: _session, ...(images?.length ? { images } : {}) }),
    });
    const d = await res.json().catch(() => ({}));
    return String(d?.text || "");
  } catch {
    return "";
  }
}

// Streaming twin of llmText — the same /vapp/llm task, but SSE so the caller can SHOW it typing
// live (e.g. the script step). `onDelta` gets the full text so far each chunk. Passes `signal` so a
// Stop aborts the upstream LLM too. Falls back to the blocking llmText on any non-stream response.
async function llmTextStream(
  task: string,
  input: string,
  token: string,
  onDelta: (full: string) => void,
  signal?: AbortSignal,
  overrides?: Record<string, any>, // e.g. a per-director { system: <script prompt> } to override the task
  images?: string[], // reference image(s) → the task runs multimodal (Qwen3.6 vision reads them)
): Promise<string> {
  const res = await fetch(withEditorBase("/api/ai-llm"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task, input, token, stream: true, session: _session, ...(overrides ? { overrides } : {}), ...(images?.length ? { images } : {}) }),
    signal,
  });
  if (!res.ok || !res.body || !(res.headers.get("content-type") || "").includes("text/event-stream")) {
    return llmText(task, input, token, images);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
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
      if (p === "[DONE]") continue;
      try {
        const ev = JSON.parse(p);
        if (ev?.type === "content" && ev.delta) { text += ev.delta; onDelta(text); }
      } catch { /* keepalive / non-JSON line */ }
    }
  }
  return text;
}

// Wait until a just-added item actually LANDS in the timeline map. ADD_ITEMS/ADD_AUDIO reduce
// asynchronously (ADD_AUDIO even loads the audio to compute its real duration first — slow for a big
// voiceover), so addImage/addAudio return an id BEFORE the item exists. Awaiting this inside runGen
// makes Promise.all(gens) resolve only once every generated clip is truly on the timeline — so the
// arrange never runs early on a half-built timeline (the "2/4 clips, waiting for audio" bug).
async function waitForItem(id: string, timeoutMs = 45000): Promise<boolean> {
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
function serializedAdd(label: string, doAdd: () => string, waitMs = 45000): Promise<string> {
  const run = _addChain.then(async () => {
    const before = Object.keys(useStore.getState().trackItemsMap || {}).length;
    const id = doAdd();
    let landed = false;
    if (id) landed = await waitForItem(id, waitMs);
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
  const [refBusy, setRefBusy] = useState(false);
  // ── Reference image (pipeline) — attached the SAME way Chat Studio's composer does: PASTE an image or
  // an image-URL, DRAG-DROP a file, or just SELECT a timeline image. No button/chooser. A dropped/pasted
  // file uploads to R2; a bare image URL is used directly. The reference makes every generated IMAGE shot
  // keep one identity (img2img via vapp-image-edit). The SELECTED-clip fallback is computed at use time.
  const REF_IMG_URL = /^https?:\/\/\S+\.(png|jpe?g|gif|webp|bmp|avif)(\?|#|$)/i;
  // Every timeline IMAGE the user has selected → the reference-image fallback (when none explicitly
  // attached). Multiple selected images all become references.
  const selectedRefSrcs = (): string[] => {
    if (!s.pipeline) return [];
    const st = useStore.getState().trackItemsMap || {};
    return (useStore.getState().activeIds || [])
      .map((x: string) => ((st[x] as any)?.type === "image" ? String((st[x] as any)?.details?.src || "") : ""))
      .filter(Boolean);
  };
  const attachRefFile = async (file?: File | null) => {
    if (!file || !file.type?.startsWith("image/")) return;
    const ctx = getVappUploadCtx();
    if (!ctx) { elog("[REF] no upload ctx — open the editor with a vApp token to paste/drop a file"); return; }
    try { setRefBusy(true); const { url } = await uploadVappMediaFile(file, ctx); if (url) s.addRefImage(url); }
    catch (err) { elog("[REF] upload failed", err); }
    finally { setRefBusy(false); }
  };
  const attachRefText = (text?: string): boolean => {
    const u = String(text || "").trim();
    if (REF_IMG_URL.test(u)) { s.addRefImage(u); return true; }
    return false;
  };
  const onComposerPaste = (e: any) => {
    if (!s.pipeline) return;
    for (const it of (e.clipboardData?.items || []) as any) {
      if (it.kind === "file" && String(it.type || "").startsWith("image/")) {
        const f = it.getAsFile(); if (f) { e.preventDefault(); attachRefFile(f); return; }
      }
    }
    if (attachRefText(e.clipboardData?.getData?.("text"))) e.preventDefault(); // a bare image URL → ref, not raw text
  };
  const onComposerDrop = (e: any) => {
    if (!s.pipeline) return;
    const f = Array.from((e.dataTransfer?.files || []) as File[]).find((x) => String(x.type || "").startsWith("image/"));
    if (f) { e.preventDefault(); attachRefFile(f); return; }
    if (attachRefText(e.dataTransfer?.getData?.("text"))) e.preventDefault();
  };

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

  // ── S/D PRESETS (Directors) — the "brain": which system prompt the planner uses ────────────────
  // Built-in directors (Edit + the pipelines) + the user's own custom system-prompt directors
  // (localStorage). Selecting one swaps the planner system prompt; "" = the plain Edit assistant.
  // A SUPERADMIN can override a BUILT-IN director's prompt globally (server store, Phase 2) — those
  // overrides ride in `dirOverrides` and win over the hardcoded defaults (fail-open to defaults).
  const [dirOverrides, setDirOverrides] = useState<Record<string, { label?: string; systemPrompt: string }>>({});
  const [isAdmin, setIsAdmin] = useState(false);
  const builtinLabel = (id: string, def: string) => dirOverrides[id]?.label || def;
  const BUILTIN_DIRECTORS = [...PIPELINES, { id: "", label: "✦ Edit / General" }].map((d) => ({ id: d.id, label: builtinLabel(d.id, d.label) }));
  const allDirectors = [...BUILTIN_DIRECTORS, ...s.customDirectors.map((d) => ({ id: d.id, label: d.label }))];
  const curDirector = allDirectors.find((d) => d.id === s.pipeline) || allDirectors[0];
  // Resolve the system prompt for a director id: admin override → built-in pipeline prompt →
  // custom prompt → the plain Edit assistant.
  const directorPromptOf = (id: string): string => {
    const ov = dirOverrides[id]?.systemPrompt;
    if (ov) return ov;
    if (!id) return OPS_SYSTEM_PROMPT;
    return PIPELINE_PROMPTS[id] || s.customDirectors.find((d) => d.id === id)?.systemPrompt || OPS_SYSTEM_PROMPT;
  };
  const [dirMenuOpen, setDirMenuOpen] = useState(false);
  const [dirEdit, setDirEdit] = useState<{ id: string; label: string; systemPrompt: string; scriptPrompt?: string; builtin?: boolean } | null>(null);
  const [dirErr, setDirErr] = useState("");
  const dirMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!dirMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!dirMenuRef.current?.contains(e.target as Node)) { setDirMenuOpen(false); setDirEdit(null); setDirErr(""); }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [dirMenuOpen]);
  // Load built-in overrides + am-I-admin once, so the dropdown shows edited prompts + the ✎ icon.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(withEditorBase("/api/admin/directors"), { cache: "no-store" });
        const d = await r.json().catch(() => ({}));
        if (alive && d?.overrides) setDirOverrides(d.overrides);
      } catch { /* fail-open → built-in defaults */ }
      const token = getToken();
      if (!token) return;
      try {
        const q = new URLSearchParams({ token });
        const bu = getBaseUrl(); if (bu) q.set("baseUrl", bu);
        const r = await fetch(withEditorBase(`/api/admin/whoami?${q.toString()}`), { cache: "no-store" });
        const d = await r.json().catch(() => ({}));
        if (alive) setIsAdmin(!!d?.allowed);
      } catch { /* not admin */ }
    })();
    return () => { alive = false; };
  }, []);
  // Save a director: a BUILT-IN edit (admin) → PUT the global override; a custom → localStorage.
  const saveDir = async () => {
    if (!dirEdit) return;
    setDirErr("");
    if (dirEdit.builtin) {
      try {
        const r = await fetch(withEditorBase("/api/admin/directors"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: dirEdit.id, label: dirEdit.label, systemPrompt: dirEdit.systemPrompt, baseUrl: getBaseUrl(), token: getToken() }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { setDirErr(d?.message || `save failed (${r.status})`); return; }
        setDirOverrides(d.overrides || {});
        elog(`[DIRECTOR] built-in "${dirEdit.id || "edit"}" prompt updated GLOBALLY by admin`);
      } catch (e: any) { setDirErr(String(e?.message || e)); return; }
    } else if (dirEdit.id === "new") s.addCustomDirector(dirEdit.label, dirEdit.systemPrompt, dirEdit.scriptPrompt);
    else s.updateCustomDirector(dirEdit.id, dirEdit.label, dirEdit.systemPrompt, dirEdit.scriptPrompt);
    setDirEdit(null);
  };
  // Admin: revert a built-in director to its hardcoded default (clears the server override).
  const resetDir = async (id: string) => {
    setDirErr("");
    try {
      const r = await fetch(withEditorBase("/api/admin/directors"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, remove: true, baseUrl: getBaseUrl(), token: getToken() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setDirErr(d?.message || `reset failed (${r.status})`); return; }
      setDirOverrides(d.overrides || {});
      setDirEdit(null);
      elog(`[DIRECTOR] built-in "${id || "edit"}" reset to default by admin`);
    } catch (e: any) { setDirErr(String(e?.message || e)); }
  };

  // ── P PRESETS (prompt snippets) — built-in + user's custom, persisted. Clicking one PASTES its
  // text into the prompt box (visible + editable → it also reaches the planner AND match_shots via
  // _lastPipelineRequest). Add / edit / delete for your own. (Backed by the vibe store fields.)
  const pPresets = s.customVibes; // P PRESETS = ONLY the user's own snippets (built-in defaults removed)
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
  const pastePreset = (style: string) => {
    const cur = s.input.trimEnd();
    s.setInput(cur ? `${cur}\n${style}` : style);
    setVibeMenuOpen(false); setVibeEdit(null);
  };
  // Composer auto-grow: the textarea grows with its content up to a cap (~160px), then scrolls.
  // Runs on every input change AND external sets (P-preset paste, feature examples, resend).
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [s.input]);
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
    if (!text.trim() || working) return; // block re-entry while ANY part (plan OR background build) runs
    _stopBuild = false; // fresh run — clear any previous Stop
    _work = new AbortController(); // Stop button aborts this
    _session = _newSession(); // one id for every LLM call this run → Stop kills them server-side
    _lastPipelineRequest = text; // so the arrange's match_shots hears the user's direction (any P-preset style is now IN this text)
    elog(`━━━━━━━━━━ NEW GEN ━━━━━━━━━━  director=${curDirector?.label || "edit"}  model=${s.model}`);
    elog(`[PROMPT] ${text}`);
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

    // ── PIPELINE PRE-STEP: write the SCRIPT first, in its OWN focused request ──────────────────
    // The narration is the SOUL of the video, and writing it INSIDE the giant ops-JSON makes the
    // planner shorten it. So for a pipeline we get the script from the dedicated `script` task FIRST,
    // then the scene call builds shots around it (see the injected message below).
    // We do NOT parse the duration in the client — that's brittle ("3 videos of 6s to 9s" is NOT the
    // audio length). The user's RAW request goes straight to the LLM; the `script` system prompt reads
    // the duration and hits it. (Trust the model; the frontend stays generic — no hardcoded intelligence.)
    let injectedScript = "";
    let directorScript = ""; // what the DIRECTOR sees (Drama v2 = the full tagged screenplay; else = the narration)
    // Reference images: the ones the user explicitly attached (paste/drop/link), else the timeline
    // images they have selected. Multiple supported — all go to the vision script step + every gen.
    const refSrcs = s.pipeline ? (s.refImages.length ? s.refImages : selectedRefSrcs()) : [];
    if (s.pipeline) {
      const wc = (t: string) => t.split(/\s+/).filter(Boolean).length;
      // Stream the script into its OWN collapsible box (not the main content) — like the 💭 Thought
      // box. Open while it types; auto-collapses when done. content stays empty → the "…" dots show
      // until the actual scene response starts (that's what the user asked for).
      s.updateLast({ content: "", scriptText: "", scriptOpen: true, genStatus: refSrcs.length ? "👁️ Looking at your image + scripting…" : "✍️ Scripting…" });
      // Per-director SCRIPT style (custom directors' optional 2nd box) rides in the INPUT so the base
      // `script` task rules (duration, ignore-editing-directions) stay in force and the style is added.
      const dirScript = s.customDirectors.find((d) => d.id === s.pipeline)?.scriptPrompt;
      const scriptInput = dirScript ? `${text}\n\nNARRATION VOICE / STYLE (how it should sound): ${dirScript}` : text;
      // Drama v2 uses its OWN screenwriter task (tagged NARRATOR / DIALOGUE screenplay); everyone else
      // uses the shared `script` narration task. (Isolated — v1/faceless/edit are untouched.)
      const scriptTask = s.pipeline === "drama_v2" ? "drama_script" : "script";
      try {
        // Reference image → the script step runs MULTIMODAL (Qwen3.6 vision): it SEES the image, so the
        // narration fits whoever/whatever is actually in it — the ONE vision read for the whole pipeline.
        injectedScript = (await llmTextStream(scriptTask, scriptInput, getToken(), (full) => {
          s.updateLast({ scriptText: full, scriptOpen: true });
        }, _work?.signal, undefined, refSrcs.length ? refSrcs : undefined)).trim();
      } catch (e: any) { elog(`[SCRIPT STEP] failed: ${e?.message || e}`); }
      // Defensive: even told not to, a model may prepend a "REF: …" or "[REF]…[/REF]" label (a scene
      // description, NOT narration). Strip it so the TTS never SPEAKS the word "REF". A whole
      // [REF]…[/REF] block is dropped; a bare "REF:" token is removed (its sentence reads fine as an opener).
      if (injectedScript) {
        const cleaned = injectedScript
          .replace(/^\s*\[REF\][\s\S]*?\[\/REF\]\s*/i, "")
          .replace(/^\s*REF\s*:\s*/i, "")
          .trim();
        if (cleaned) injectedScript = cleaned;
      }
      // The DIRECTOR sees the full script/screenplay; the AUDIO voiceover is derived from it.
      directorScript = injectedScript;
      // DRAMA v2: the script is a TAGGED screenplay. The narrator VOICEOVER (audio op) is ONLY the
      // NARRATOR lines — the DIALOGUE lines are spoken on camera by their talking shots (not the narrator).
      if (s.pipeline === "drama_v2" && injectedScript) {
        const lines = injectedScript.split(/\n+/).map((l) => l.trim()).filter(Boolean);
        const narr = lines.filter((l) => /^NARRATOR\s*:/i.test(l)).map((l) => l.replace(/^NARRATOR\s*:\s*/i, "").trim()).filter(Boolean).join(" ");
        const dCount = lines.filter((l) => /^DIALOGUE\b/i.test(l)).length;
        // fallback: no NARRATOR lines tagged → strip any tags so the TTS never speaks a label
        injectedScript = narr || injectedScript.replace(/^\s*(NARRATOR|DIALOGUE[^:]*)\s*:\s*/gim, "").replace(/\s*\n+\s*/g, " ").trim();
        elog(`[DRAMA v2] screenplay: ${lines.length} lines, ${dCount} dialogue → narrator VO ${wc(narr)} words`);
        elog(`[DRAMA v2 SCREENPLAY]\n${directorScript}`); // the FULL tagged screenplay drama_script wrote
      }
      if (directorScript) {
        elog(`[SCRIPT STEP] ${wc(injectedScript)} words voiceover (~${Math.round(wc(injectedScript) / 2.5)}s spoken)`);
        s.updateLast({ scriptText: directorScript, scriptOpen: false }); // show the full script/screenplay, then collapse
      }
      if (_work?.signal.aborted) { s.setBusy(false); return; } // Stop pressed during the script step
      // No script → don't proceed to a broken build (the audio op would stay the "__SCRIPT__" placeholder).
      if (!directorScript) { s.updateLast({ content: "⚠️ Couldn't write the script — try again." }); s.setBusy(false); return; }
    }

    // A reference image → the AI-image shots EDIT it. The edit model (Flux) already SEES the image and
    // takes SHORT keyword edits, so the director must NOT describe what's in it — just compact edit
    // instructions, MOST IMPORTANT change first (earliest = most weight), "keep everything else" at the end.
    const refBlock = refSrcs.length
      ? `\n\n━━━ REFERENCE IMAGE attached — the AI-image shots are made by EDITING it. The edit model already SEES the image, so do NOT describe what's in it and do NOT write "the same person/subject from the reference". For EACH image shot write a SHORT Flux-EDIT prompt = ONLY the changes, compact instruction/keyword style (NOT a paragraph): put the MOST IMPORTANT change FIRST (earliest instructions carry the most weight), then the next, then minor ones — e.g. "change outfit to a bold red leather jacket and jeans; confident standing pose; neon city rooftop at night; low angle, cinematic". END every image prompt with "keep the same face and identity, do not change anything else". ━━━`
      : "";
    const projCtx = projectContext(trackItemsMap) + narrationTimeline(useAiEditStore.getState().transcript?.segments);
    const payload: Record<string, any> = {
      model: s.model,
      token: getToken(),
      stream: s.streaming,
      // A PIPELINE swaps the system prompt (e.g. Comic Drama / Faceless Video) and treats
      // the input as a topic/story — the LLM plans the whole thing and emits generate/arrange
      // ops that build it on the timeline. No pipeline = the normal edit assistant.
      messages: [
        // The selected DIRECTOR (S/D preset) is the planner's brain: a built-in pipeline prompt,
        // a custom system prompt, or the plain Edit assistant ("" director).
        { role: "system", content: directorPromptOf(s.pipeline) },
        {
          role: "user",
          // Any P-preset style the user picked is already pasted INTO `text` (visible + editable),
          // so it reaches the planner here AND match_shots via _lastPipelineRequest — no hidden inject.
          // For a pipeline WITH a pre-written script, the scene call only builds SHOTS around it (it
          // does NOT rewrite the narration — the system inserts the real script into the audio op).
          content: s.pipeline
            ? (directorScript
                ? `${text}${refBlock}\n\n━━━ The NARRATION SCRIPT is ALREADY WRITTEN (below) — the system inserts it. For the audio op output EXACTLY { "op":"generate","kind":"audio","text":"__SCRIPT__" } and do NOT write the narration yourself. Write the shot gen prompts so shot k matches the part of the script spoken at that moment, in order. ━━━\nSCRIPT (reference, to match shots to):\n${directorScript}`
                : `${text}${refBlock}`)
            : `${projCtx ? projCtx + "\n\n" : ""}${ctx}\n\nUser request: ${text}`,
        },
      ],
    };
    if (!s.showThinking) {
      payload.reasoning_effort = "low";
      payload.extra_body = { think: false };
    }
    elog(`[LLM REQ] director=${curDirector?.label || "edit assistant"} · task=editor_edit · in="${String(payload.messages[1].content).replace(/\s+/g, " ").slice(0, 160)}…"`);
    const t0 = Date.now();
    let firstContentAt = 0;
    try {
      const { content, reasoning } = await runChat(payload, (p) => {
        if (p.content && !firstContentAt) firstContentAt = Date.now();
        // Pipeline: the scene plan is raw JSON — hide it in a collapsible "🎬 Directing" box (not a
        // wall of code in the chat); show a status line instead. Edit mode streams normally.
        if (s.pipeline) s.updateLast({ directText: p.content, directOpen: true, content: p.content ? "🎬 Directing shots & effects…" : "", genStatus: p.content ? "🎬 Directing…" : "", reasoning: p.reasoning });
        else s.updateLast({ content: p.content, reasoning: p.reasoning });
      }, _work?.signal);
      const reasoningMs = reasoning ? (firstContentAt || Date.now()) - t0 : undefined;
      elog(`[LLM RET] in ${Date.now() - t0}ms · ${content.length} chars`);
      const env = extractOps(content);
      if (env && env.operations?.length) {
        // Force the audio op to the pre-written script (the scene call only referenced it / used a
        // placeholder — never let it drift or shorten the narration). Add one if the model omitted it.
        if (injectedScript) {
          const audOp = env.operations.find((o: any) => o.op === "generate" && o.kind === "audio");
          if (audOp) audOp.text = injectedScript;
          else env.operations.push({ op: "generate", kind: "audio", text: injectedScript });
        }
        // Optimizer is OPTIONAL (⚙ "Optimise prompt" toggle = 2 modes). PIPELINE_FORCE_OPTIMIZE keeps the
        // "director writes SHORT hints → optimizer expands" path ONE FLAG away — flip it true if the
        // director ever gets too heavy again (then also switch the director prompt back to short hints).
        // Default false = director's full cinematic prompts go straight to the model (best quality).
        if (s.pipeline && PIPELINE_FORCE_OPTIMIZE) {
          env.operations.forEach((o: any) => {
            if (o.op === "generate" && (o.kind === "image" || o.kind === "video")) o.optimize = true;
          });
        }
        // REFERENCE IMAGE: an explicit attached photo (pasted/dropped/linked) OR, failing that, the
        // timeline image the user has selected. Every IMAGE shot is then generated FROM it (img2img via
        // vapp-image-edit) → the same face/identity across shots. (Videos + stock skip it.)
        // refSrcs computed once at the top of the pipeline flow (also drives the script-step vision).
        if (refSrcs.length) {
          let lip = 0;
          env.operations.forEach((o: any) => {
            if (o.op === "generate" && o.kind === "image") { o.images = refSrcs; o.optimize = false; } // EDIT from the reference(s) — not a fresh prompt to optimize
            // a TALKING video shot (director's `talk:true`, or a speech verb fallback) → animate the
            // reference character (i2v) so the SAME face talks (vapp-video all-in-one: image + spoken line).
            else if (o.op === "generate" && o.kind === "video" && isTalkOp(o)) { o.image_url = refSrcs[0]; o.optimize = false; lip++; }
          });
          elog(`[REF IMAGE] ${refSrcs.length} reference(s) → image shots${lip ? ` + ${lip} lip-sync video(s) i2v from ref` : ""} (${s.refImages.length ? "attached" : "selected"})`);
        }
        elog(`[PLAN] "${env.summary || ""}" → ${env.operations.length} ops: ${env.operations.map((o: any) => o.op + (o.kind ? `(${o.kind})` : "")).join(", ")}`);
        const aud = env.operations.find((o: any) => o.op === "generate" && o.kind === "audio");
        if (aud?.text) elog(`[SCRIPT] ${String(aud.text).replace(/\s+/g, " ")}`);
        env.operations.filter((o: any) => o.op === "generate" && o.kind !== "audio").forEach((o: any, k: number) => elog(`[GEN PROMPT ${k + 1}] ${o.kind}${o.image_url ? " (i2v-ref)" : o.images ? ` (edit ×${o.images.length})` : ""}: ${String(o.prompt || o.text || "").replace(/\s+/g, " ")}`));
        s.updateLast({ content: env.summary || "Proposed edit ready.", reasoning, reasoningMs, thinkingOpen: false, directOpen: false, ops: env.operations });
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
    _serverStopLlm(_session); // imperative kill FIRST — stops the backend LLM even if the abort doesn't reach it
    _work?.abort();
    _stopBuild = true; // halt the background build too (skips the remaining stages)
    s.setBusy(false);
    const idx = useAiEditStore.getState().messages.length - 1;
    if (idx >= 0) s.updateAt(idx, { genStatus: "⏹ Stopped", buildProgress: "" }); // clears "working" → Stop reverts to Send, timer freezes
    elog("[AI-Edit] ⏹ user stopped");
  };

  // One generate op, run in the BACKGROUND (not awaited) so the chat stays free.
  const runGen = async (i: number, g: any) => {
    // LIP-SYNC — align a talking-head video's speech to the timeline audio. Transcribe BOTH (word
    // timestamps), find the longest phrase they share, then place the video at that AUDIO span, trim
    // it to the matching footage, time-stretch to fit, and mute its own audio → the lips match the
    // narration. Edit-mode prototype (select an audio + video(s), say "lip sync") before the pipeline.
    if (g.op === "lipsync") {
      try {
        const st = useStore.getState().trackItemsMap || {};
        const audio: any = Object.values(st).find((it: any) => it?.type === "audio");
        if (!audio?.details?.src) { s.updateAt(i, { genStatus: "⚠️ lip-sync: put a voiceover/audio on the timeline first" }); return; }
        let vids: string[] = g.itemId ? [g.itemId] : (g.target === "selected" ? activeIds.filter((id: string) => (st[id] as any)?.type === "video") : []);
        if (!vids.length) vids = Object.keys(st).filter((id) => (st[id] as any)?.type === "video");
        if (!vids.length) { s.updateAt(i, { genStatus: "⚠️ lip-sync: no video on the timeline" }); return; }
        s.updateAt(i, { genStatus: "🎙️ Lip-sync: transcribing the audio…" });
        const aw = await transcribeWords(audio.details.src, getToken());
        const aSeq = aw.map((x) => x.w);
        let done = 0;
        for (let vi = 0; vi < vids.length; vi++) {
          const vid = vids[vi];
          const vsrc = (st[vid] as any)?.details?.src; if (!vsrc) continue;
          s.updateAt(i, { genStatus: `🎙️ Lip-sync: transcribing video ${vi + 1}/${vids.length}…` });
          const vw = await transcribeWords(vsrc, getToken());
          if (!aw.length || !vw.length) { elog(`[LIPSYNC] ${vid.slice(0, 6)} — no words (audio ${aw.length}, video ${vw.length})`); continue; }
          const m = longestWordMatch(aSeq, vw.map((x) => x.w));
          if (m.len < 2) { elog(`[LIPSYNC] ${vid.slice(0, 6)} — no matching phrase found in the audio`); continue; }
          const aStart = aw[m.aStart].start, aEnd = aw[m.aEnd].end;
          const vStart = vw[m.bStart].start, vEnd = vw[m.bEnd].end;
          const aDur = Math.max(200, aEnd - aStart), vDur = Math.max(200, vEnd - vStart);
          const rate = Math.min(2, Math.max(0.5, vDur / aDur)); // stretch the video to the audio span
          applyOperations([{ op: "lipsync", itemId: vid, display: { from: aStart, to: aEnd }, trim: { from: vStart, to: vEnd }, playbackRate: rate, mute: true }]);
          elog(`[LIPSYNC] ${vid.slice(0, 6)} matched ${m.len} words → audio ${Math.round(aStart)}-${Math.round(aEnd)}ms · video ${Math.round(vStart)}-${Math.round(vEnd)}ms · rate ${rate.toFixed(2)}`);
          done++;
        }
        s.updateAt(i, { genStatus: done ? `✓ Lip-sync arranged (${done} video${done > 1 ? "s" : ""})` : "⚠️ lip-sync: no phrase matched — use a video that speaks lines from the narration" });
      } catch (e: any) { s.updateAt(i, { genStatus: `⚠️ lip-sync: ${e?.message || e}` }); }
      return;
    }
    // MUSIC BED — add a low-volume, full-length background track from the user's curated audio
    // library (Stock → Sound). Picks by mood keyword if given, else the first saved track.
    if (g.op === "musicbed") {
      try {
        const lib = useAudioLibraryStore.getState().music || [];
        if (!lib.length) { s.updateAt(i, { genStatus: "⚠️ music: add music to your library first (Stock → Sound → ♪)" }); return; }
        const q = String(g.query || g.prompt || "").toLowerCase().trim();
        const pick = (q && lib.find((m) => String(m.name || "").toLowerCase().includes(q))) || lib[0];
        if (!pick?.src) { s.updateAt(i, { genStatus: "⚠️ music: no usable track in the library" }); return; }
        applyOperations([{ op: "musicbed", src: pick.src, volume: g.volume ?? 18 }]);
        s.updateAt(i, { genStatus: "✓ Music bed added" });
        elog(`[MUSIC BED] "${String(pick.name || pick.src).slice(0, 40)}" @${g.volume ?? 18}%`);
      } catch (e: any) { s.updateAt(i, { genStatus: `⚠️ music: ${e?.message || e}` }); }
      return;
    }
    // Stock search — no generation job; fetch Pexels and add the top result(s).
    if (g.op === "search") {
      const kind = g.kind === "video" ? "video" : "image";
      const n = Math.min(Math.max(1, g.count || 1), 10);
      try {
        s.updateAt(i, { genStatus: `Searching stock ${kind}…` });
        const path = kind === "video" ? "/api/pexels-videos" : "/api/pexels";
        const orient = aspectOrientation(g.aspect_ratio); // match stock orientation to the shot's aspect
        const res = await fetch(
          withEditorBase(`${path}?query=${encodeURIComponent(g.query || g.prompt || "")}&per_page=${n}${orient ? `&orientation=${orient}` : ""}`)
        );
        const data = await res.json().catch(() => ({}));
        const results = (kind === "video" ? data.videos : data.photos) || [];
        const snap = { ...(useAiEditStore.getState().messages[i]?.snapshot || {}) };
        const previews = [...(useAiEditStore.getState().messages[i]?.genPreviews || [])];
        let added = 0;
        for (let k = 0; k < Math.min(n, results.length); k++) {
          const src = results[k]?.details?.src;
          if (!src) continue;
          // Stock has no gen-prompt → use the result's TITLE/alt (or the search query) as the
          // description, so the arrange's relevancy (match_shots) still knows what this clip shows.
          const desc = String(results[k]?.alt || results[k]?.title || results[k]?.description || g.query || "stock").slice(0, 120);
          // serialized add (+ waits for landing) so concurrent stock adds never clobber each other
          const nid = await serializedAdd(kind, () => (kind === "video" ? addVideo(src, desc) : addImage(src, desc)));
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
      const images: string[] | undefined = Array.isArray(g.images) && g.images.length ? g.images.filter(Boolean) : undefined; // multi-reference (character consistency)
      let image_url: string | undefined = images?.[0] || g.image_url || undefined; // reference image for a fresh gen (first = single-image back-compat)
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
        images, // multi-reference → forwarded as images_list (Flux edit takes several)
        aspect_ratio: g.aspect_ratio,
        duration: g.duration,
        // Per-op wins (pipeline shots force it ON — the director now writes SHORT hints that the
        // optimizer MUST expand); else the global "Optimise prompt" toggle.
        optimize: g.optimize !== undefined ? !!g.optimize : useAiEditStore.getState().optimizePrompt,
        token: getToken(),
      });
      if (!id) throw new Error("no job id");
      // The ACTUAL prompt sent to the model (full, not truncated) — after any optimizer rewrite.
      if (label !== "audio") elog(`[GEN SENT ${label}]${image_url ? " i2v-ref" : images ? ` edit×${images.length}` : ""}: ${String(usedPrompt || sentPrompt).replace(/\s+/g, " ")}`);
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
      // NO per-item "✓ … added" status — a ✓ here flips the aggregate "working" state (and the timer +
      // Stop button) OFF mid-build. The running counter/stage owns genStatus; the preview shows the clip.
      s.updateAt(i, { genPreviews: [...prev, { kind: label, url }] });
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
    // PERSISTENT aggregate counter (own field so per-shot genStatus never clobbers it — the user
    // must ALWAYS see "4/10"). Shows the batch mix too (img/vid/audio).
    const setProg = () => { if (total > 1) s.updateAt(i, { buildProgress: `${doneN}/${total}` }); }; // compact — sits inline after the task
    // A stable in-progress STAGE for the whole gen phase — keeps "working" TRUE (Stop button + timer stay
    // on) even as individual clips land. Per-clip live % from runGen just refines this text.
    if (total) s.updateAt(i, { genStatus: "🎨 Generating…" });
    setProg();
    // Run the generations in parallel, with the live counter (so the user sees it working).
    await Promise.all(
      gens.map((g) =>
        runGen(i, g).finally(() => {
          doneN += 1;
          setProg();
        }),
      ),
    );
    s.updateAt(i, { buildProgress: "" }); // gens done → hand off to the arrange (its own status)
    if (_stopBuild) { s.updateAt(i, { genStatus: "⏹ Stopped", buildProgress: "" }); return; }
    // No arrange (e.g. a plain edit-mode generate) → the gens ARE the whole result; mark it DONE so the
    // timer freezes + the Stop button reverts to Send (there is no per-item ✓ status anymore).
    if (!arranges.length) { s.updateAt(i, { genStatus: total > 1 ? `✓ ${total} generated` : "✓ Done" }); return; }
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
            // A VIDEO clip has a FIXED footage length (trim window ÷ playbackRate). Stretching its
            // timeline window past that = a BLACK screen, so we tell match_shots each video's real
            // seconds → it gives videos SHORT windows and lets IMAGE shots absorb the long holds.
            const vidMs = (id: string) => {
              const it: any = map[id];
              if (it?.type !== "video") return 0;
              const tr = it.trim || {};
              const len = ((tr.to ?? it.duration ?? 0) - (tr.from ?? 0)) / (it.playbackRate || 1);
              return len > 200 ? Math.round(len) : 0;
            };
            const shots = targetVisuals.map((id) => ({ id, desc: localDesc(id), type: (map[id] as any)?.type as string, vidMs: vidMs(id) }));
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
              const shotLines = shots.map((sh, k) => `${k + 1}. id="${sh.id}" ${sh.type === "video" ? `[VIDEO — footage only ~${sh.vidMs ? Math.round(sh.vidMs / 1000) : 6}s long; give it a SHORT window ≈ that, a longer window = BLACK screen] ` : ""}desc="${sh.desc || "(unknown)"}"`).join("\n");
              // The user's own words drive motion + pace — "punchy zoom-ins", "slow holds",
              // "hard fast cuts", plus any P-preset they pasted into the box — all ride in via
              // _lastPipelineRequest, so match_shots hears the exact direction.
              const styleLine = String(_lastPipelineRequest || "").slice(0, 300);
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
        // VIDEO SPREAD: videos must NOT clump at the end (they carry the most motion — spacing them
        // paces the whole piece). Put one video in the FIRST slot, one in the LAST (when 2+), the rest
        // evenly across the middle. Images fill the leftover slots keeping their relative (≈narration)
        // order. We permute only WHICH media sits in each fixed time-window — durations stay put; each
        // media keeps its own LLM-chosen motion + text as it moves.
        if (beats && beats.length >= 2) {
          const isVid = (id: string) => (map[id] as any)?.type === "video";
          const vids = beats.filter((b) => isVid(b.itemId));
          const imgs = beats.filter((b) => !isVid(b.itemId));
          if (vids.length && imgs.length) {
            const N2 = beats.length;
            const targets: number[] = vids.length === 1 ? [0] : [0, N2 - 1];
            for (let v = 1; v < vids.length - 1; v++) targets.push(Math.round((v / (vids.length - 1)) * (N2 - 1)));
            const used = new Set<number>();
            const vslots: number[] = [];
            for (const t of targets) { let x = Math.max(0, Math.min(N2 - 1, t)); while (used.has(x)) x = (x + 1) % N2; used.add(x); vslots.push(x); }
            vslots.sort((a, b) => a - b);
            const vMedia = beats.filter((b) => isVid(b.itemId)).map((b) => ({ itemId: b.itemId, text: b.text, motion: b.motion }));
            const iMedia = beats.filter((b) => !isVid(b.itemId)).map((b) => ({ itemId: b.itemId, text: b.text, motion: b.motion }));
            const slotMedia: { itemId: string; text: string; motion?: string }[] = new Array(N2);
            vslots.forEach((sl, vi) => { slotMedia[sl] = vMedia[vi]; });
            let ii2 = 0;
            for (let sl = 0; sl < N2; sl++) if (!slotMedia[sl]) slotMedia[sl] = iMedia[ii2++];
            beats = beats.map((b, k) => ({ ...b, itemId: slotMedia[k].itemId, text: slotMedia[k].text, motion: slotMedia[k].motion }));
            elog(`[VIDEO SPREAD] ${vids.length} video(s) → slots [${vslots.join(",")}] of ${N2} (early + late + middle, no clumping)`);
          }
        }
        // MIN DURATIONS: images ≥2s, VIDEOS ≥3s (videos are motion — give them priority). A shot below
        // its floor steals time from the shots that have slack (the longest first), keeping the whole
        // sequence contiguous + spanning the same total. Kills the "1s flickery b-roll" look.
        if (beats) {
          const bts = beats;
          const total = bts[bts.length - 1].toMs;
          const minFor = (id: string) => ((map[id] as any)?.type === "video" ? 3000 : 2000);
          const mins = bts.map((b) => minFor(b.itemId));
          let durs = bts.map((b) => b.toMs - b.fromMs);
          const sumMin = mins.reduce((a, b) => a + b, 0);
          if (sumMin >= total) {
            durs = mins.map((m) => (m / sumMin) * total); // can't fit all floors → scale proportionally
          } else {
            let deficit = 0;
            for (let k = 0; k < durs.length; k++) if (durs[k] < mins[k]) { deficit += mins[k] - durs[k]; durs[k] = mins[k]; }
            const slack = durs.reduce((a, d, k) => a + Math.max(0, d - mins[k]), 0);
            if (deficit > 0 && slack > 0) for (let k = 0; k < durs.length && deficit > 0.5; k++) {
              const give = Math.min(Math.max(0, durs[k] - mins[k]), deficit * (Math.max(0, durs[k] - mins[k]) / slack));
              durs[k] -= give;
            }
          }
          // VIDEO CEILING (physical, not arbitrary): a video can't play past its footage length — cap
          // each video's dur at its clip length and hand the freed time to the IMAGE shots (they hold
          // fine via Ken Burns). Kills the "video ends → BLACK screen" when a shot got a long window.
          const vidCapMs = (id: string) => {
            const it: any = map[id];
            if (it?.type !== "video") return Infinity;
            const tr = it.trim || {};
            const len = ((tr.to ?? it.duration ?? 0) - (tr.from ?? 0)) / (it.playbackRate || 1);
            return len > 200 ? len : Infinity;
          };
          let freed = 0;
          for (let k = 0; k < durs.length; k++) { const cap = vidCapMs(bts[k].itemId); if (durs[k] > cap) { freed += durs[k] - cap; durs[k] = cap; } }
          if (freed > 0.5) {
            const imgIdx = bts.map((_, k) => k).filter((k) => (map[bts[k].itemId] as any)?.type !== "video");
            const imgSlack = imgIdx.reduce((a, k) => a + durs[k], 0);
            if (imgSlack > 0) for (const k of imgIdx) durs[k] += freed * (durs[k] / imgSlack);
            else durs = durs.map((d) => d + freed / durs.length);
            elog(`[VIDEO CEILING] capped video(s) to footage, redistributed ${Math.round(freed)}ms to images`);
          }
          let cur = 0;
          beats = bts.map((b, k) => { const from = cur; const to = k === bts.length - 1 ? total : Math.round(from + durs[k]); cur = to; return { ...b, fromMs: from, toMs: Math.max(from + 300, to) }; });
          beats[beats.length - 1].toMs = total;
          elog(`[MIN DURATIONS] enforced img≥2s / vid≥3s → ${beats.map((b) => `${b.itemId.slice(0, 6)}:${b.toMs - b.fromMs}ms`).join(" | ")}`);
        }
        try {
          s.updateAt(i, { beats }); // persist the CONTEXT — animate / effects / lip-sync read this later
          // ONE authoritative arrange: contiguous, gap-free, all shots CONSOLIDATED onto a single
          // video row (the executor moves them onto one track — see operations.ts arrange handler).
          s.updateAt(i, { genStatus: "🧩 Arranging clips to the narration…" });
          elog("[AI-Edit arrange] applying arrange (single track, gap-free)");
          applyOperations([{ op: "arrange", items: beats.map((bt) => ({ itemId: bt.itemId, fromMs: bt.fromMs, toMs: bt.toMs })) }]);
          // MOTION: DIRECTED per shot by the LLM (match_shots' `motion` = punchIn/zoomIn/hold/… fitting
          // the dramatic beat + the Vibe) → mapped to Ken Burns kind + intensity. Falls back to an
          // alternating default when there's no directed motion (transcript/even paths). IMAGE shots only
          // (videos move on their own), in ONE batched dispatch (N dispatches race → only last sticks).
          const KB = ["zoomIn", "zoomOut", "panLeft", "panRight", "zoomInPanRight", "zoomInPanLeft"];
          const motionOf = (itemId: string, k: number): { kb: string; intensity: number; dur?: number } => {
            const b = beats!.find((x) => x.itemId === itemId);
            const m = (b?.motion || "").toLowerCase();
            const base = MOTION_MAP[m] || { kb: KB[k % KB.length], intensity: 20 };
            const durMs = b ? b.toMs - b.fromMs : 4000;
            // LENGTH-AWARE so the effect is ALWAYS FELT: a LONG shot gets a CONTINUOUS drift over its whole
            // length (dur=100) — never a quick punch that then freezes for 20s ("no effect" feel); a SHORT
            // shot keeps its snappy punch. Floor the intensity so nothing renders invisible (@5 → felt).
            if (durMs >= 7000) {
              // Longer shot → STRONGER continuous drift, intensity SCALED with length so a long hold is
              // clearly felt (not a dead slow creep). ~18 at 7s → ~34 cap by ~45s. 'hold' stays gentler.
              const scaled = Math.min(34, 18 + Math.round((durMs - 7000) / 2500));
              return { kb: base.kb, intensity: Math.max(m === "hold" ? 12 : scaled, base.intensity), dur: 100 };
            }
            return { kb: base.kb, intensity: Math.max(12, base.intensity), dur: base.dur };
          };
          const imgShots = targetVisuals.filter((id) => (map[id] as any)?.type === "image");
          // TRANSITIONS are OPT-IN (like music) — applied ONLY when the USER explicitly asks (transition /
          // crossfade / dissolve / smooth cuts / fade in-out-between). Default = hard cuts. When asked, fade
          // EVERY visual, MERGED into this same motion dispatch (a separate 2nd EDIT_OBJECT races → "only the
          // last sticks" would wipe the kenBurns = no zoom).
          const wantTransition = /\b(transitions?|cross[-\s]?fades?|dissolves?|smooth\s+(cuts?|transitions?)|fade\s+(in|out|between|to\s+black|transitions?)|add\s+fades?)\b/i.test(String(_lastPipelineRequest || ""));
          const fadeIds = wantTransition ? targetVisuals.slice() : undefined;
          const applied = applyMotionBatch(imgShots.map((id, k) => { const mv = motionOf(id, k); return { id, kenBurns: mv.kb, intensity: mv.intensity, duration: mv.dur }; }), fadeIds);
          elog(`[MOTION] applied to ${imgShots.length} image shot(s) [${source}]${wantTransition ? " + FADE transitions (user asked)" : " (hard cuts, no transitions)"}: ${Object.entries(applied).map(([id, kb]) => `${id.slice(0, 6)}=${kb}`).join(", ")}`);
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

  // ── DRAMA v2 ASSEMBLER — deterministic, ordered, NO relevance-matcher, NO transcribe ──────────────
  // SHOT-DRIVEN: we build the DIRECTOR's ordered shot-list and lay the shots BACK-TO-BACK. A talking shot
  // is a video carrying its OWN voice (clip length fits the spoken line). A b-roll shot gets the next
  // NARRATOR line from the screenplay as its own voice clip (best-effort — extra b-roll runs silent).
  // Sequential → narrator + dialogue audio NEVER overlap. This path does NOT fall back to the matcher on a
  // screenplay/shot count drift (that fallback caused the audio overlap + the missing voiceover); it only
  // defers to the standard builder when there are literally no visual shots to place.
  const runBuildDrama = async (i: number, gens: any[], screenplay: string) => {
    const token = getToken();
    // Parse the screenplay into NARRATOR / DIALOGUE beats — TOLERANT of tag typos the LLM sometimes emits
    // (e.g. "DIALOGATOR:" instead of "DIALOGUE [Name]:", or "NARRATION" / "VO"): anything starting DIALOG… is
    // dialogue, NARRATOR / NARRATION / VOICEOVER / VO is narration. We only use the NARRATOR text as the
    // voiceover POOL below, so a mis-tag can never drop a shot.
    const beats = (screenplay || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const nm = l.match(/^\s*(?:NARRATOR|NARRATION|VOICE\s*-?\s*OVER|VOICEOVER|VO)\b[^:]*:\s*(.+)$/i);
      if (nm) return { type: "n" as const, text: nm[1].trim() };
      const dm = l.match(/^\s*DIALOG\w*\b(?:\s*\[[^\]]*\])?[^:]*:\s*(.+)$/i);
      if (dm) return { type: "d" as const, text: dm[1].trim() };
      return null as any;
    }).filter(Boolean) as { type: "n" | "d"; text: string }[];
    const shots = gens.filter((g: any) => (g.op === "generate" && (g.kind === "image" || g.kind === "video")) || g.op === "search");
    if (!shots.length) { // nothing visual — let the standard builder handle whatever ops exist
      elog(`[DRAMA v2 ASM] no visual shots → standard build`);
      return runBuild(i, gens, [{ op: "arrange", target: "all" }], []);
    }
    // SHOT-DRIVEN + tolerant: the video IS the DIRECTOR's ordered shot-list. NEVER fall back to the slow
    // transcribe/matcher path just because the screenplay's line count drifted from the shot count — that
    // fallback is exactly what caused the audio overlap + the missing voiceover. Talk shots carry their OWN
    // voice (op.line); each b-roll shot pulls the NEXT narrator line as its voiceover (best-effort — any
    // extra b-roll simply runs silent). Order = the director's op order (it decides the sequence).
    const narratorTexts = beats.filter((b) => b.type === "n").map((b) => b.text);
    let _nq = 0;
    // EVERY shot gets a spoken line: a talk shot speaks its OWN dialogue (op.line) as clean TTS — the LTX
    // video's native audio is garbled/unreliable, so we mute it and lay the TTS over it; a b-roll shot
    // speaks the next narrator line. Both use the SAME (default) voice.
    const plan = shots.map((g: any, k: number) => {
      const talk = isTalkOp(g);
      return { k, g, talk, type: (talk ? "d" : "n") as "n" | "d", narrText: talk ? lineOf(g) : (narratorTexts[_nq++] || "") };
    });
    elog(`[DRAMA v2 ASM] ▶ ${plan.length} shots (${plan.filter((p) => p.talk).length} dialogue, ${narratorTexts.length} narration line(s)) — shot-driven, stitch in order`);
    const total = plan.length;
    s.updateAt(i, { genStatus: "🎬 Generating shots…", buildProgress: `0/${total}` });
    let doneN = 0;
    const bump = () => { doneN += 1; s.updateAt(i, { buildProgress: `${doneN}/${total}` }); };
    // ONE retry so a single flaky gen doesn't DROP a whole beat. onProg keeps the status LIVE during the
    // (often minutes-long) gen wait — an empty callback made it look frozen at "Building drama…".
    const genUrl = async (kind: string, opts: any, onProg?: (d: any) => void): Promise<string> => {
      for (let attempt = 0; attempt < 2 && !_stopBuild; attempt++) {
        try { const gg = await startGen({ kind, ...opts, token }); const u = await waitGen(gg.id, onProg || (() => {})); if (u) return u; }
        catch (e) { elog(`[DRAMA v2 ASM] ${kind} gen attempt ${attempt + 1} failed: ${e}`); }
      }
      return "";
    };
    // BUILD A TALKING (lip-sync) SHOT. Order matters and is the whole point of the fix:
    //   1) generate the dialogue as CLEAN TTS (the video will lip-sync to it),
    //   2) if a reference image is attached, EDIT the ref into THIS shot's look first — the video model
    //      animates its input image as-is (it won't restyle from the prompt), so the outfit/scene must be
    //      baked into the image, not just described (LIPSYNC_I2V_EDIT_FIRST),
    //   3) generate the video: WITH_AUDIO → feed the TTS as `audio` so it lip-syncs to the real words
    //      (lips match, exact length, no hallucination); else the legacy text-driven path.
    // Returns the video url + the TTS url (the TTS is still overlaid + sizes the clip downstream).
    const genTalkShot = async (g: any, narrText: string, onProg: (d: any) => void): Promise<{ vUrl: string; aUrl: string; audioDriven: boolean }> => {
      // MODE: a REFERENCE-IMAGE (i2v) talking shot ALWAYS uses audio — that path lip-syncs great and is left
      // untouched. A NON-ref shot uses T2V (LTX generates its OWN speech from the quoted words → best lips +
      // full camera freedom) unless LIPSYNC_WITH_AUDIO flips it back to the audio path.
      const hasRef = !!String(g.image_url || "");
      const audioDriven = hasRef || LIPSYNC_WITH_AUDIO;
      const aUrl = audioDriven && narrText ? await genUrl("audio", { text: narrText }, onProg) : "";
      let baseImg = String(g.image_url || "");
      if (baseImg && LIPSYNC_I2V_EDIT_FIRST) {
        // Flux EDIT the ref into this shot's look — force it to keep the face (the video prompt is a scene
        // description, not an edit prompt, so it lacks the identity-lock the image shots carry).
        const editPrompt = `${g.prompt}, keep the same face and identity, do not change anything else`;
        const edited = await genUrl("image", { prompt: editPrompt, images: [baseImg], aspect_ratio: g.aspect_ratio, optimize: false }, onProg);
        if (edited) { baseImg = edited; elog(`[DRAMA v2 ASM] talk shot: edited the reference into the shot look → i2v from THAT`); }
        else elog(`[DRAMA v2 ASM] talk shot: ref edit failed — animating the raw reference`);
      }
      const line = lineOf(g);
      const vOpts: any = { aspect_ratio: g.aspect_ratio, optimize: false };
      if (baseImg) vOpts.image_url = baseImg;
      if (audioDriven && aUrl) {
        // AUDIO-driven (ref/flag): the director's prompt is scene-only (ends "…and speaks"); the WORDS come
        // from the TTS. duration:0 → the vApp sizes the video to the audio (+1s tail). Video is muted + the
        // TTS overlaid downstream.
        vOpts.prompt = g.prompt;
        vOpts.audio = aUrl; vOpts.duration = 0;
        elog(`[DRAMA v2 ASM] talk shot: AUDIO-driven lip-sync (${hasRef ? "ref i2v" : "flag"}) → video = audio length`);
      } else {
        // T2V (no audio): LTX generates the speech itself, so the WORDS go in the prompt in DOUBLE quotes
        // (LTX's format — the director keeps them out of the prompt and in `line`, we add them here so the
        // JSON the director emits stays valid). Length = word estimate (spokenSecs, ×2 mult). Uses LTX's own
        // audio (not muted).
        vOpts.prompt = line ? `${g.prompt} "${line}"` : g.prompt;
        vOpts.duration = spokenSecs(g) || 5;
        elog(`[DRAMA v2 ASM] talk shot: T2V lip-sync (no audio) → LTX speaks the line itself, ~${spokenSecs(g) || 5}s`);
      }
      const vUrl = await genUrl("video", vOpts, onProg);
      return { vUrl, aUrl, audioDriven };
    };
    // Real clip length FROM the just-added timeline item — ADD_VIDEO/ADD_AUDIO already loaded it, so we
    // never download it a 2nd time (that double-load was why placement crawled on a slow CDN).
    const clipMs = (id: string): number => {
      const it: any = (useStore.getState().trackItemsMap || {})[id];
      const d = Number(it?.duration) || (it?.display ? Number(it.display.to) - Number(it.display.from) : 0);
      return d > 200 ? Math.round(d) : 0;
    };
    // INCREMENTAL STITCH: whenever a beat LANDS, re-time ALL landed beats into gap-free in-order windows
    // → completed shots hit the timeline IMMEDIATELY, without waiting for the slow ones (a video can take
    // minutes). No Promise.all barrier before anything shows. The final pass just tidies + reports.
    const landed: { k: number; type: "n" | "d"; vid: string; aid: string; vKind: string; ms: number }[] = [];
    const restitch = () => {
      const seq = [...landed].sort((a, b) => a.k - b.k);
      let cur = 0;
      const vItems: { itemId: string; fromMs: number; toMs: number }[] = [];
      const aItems: { itemId: string; fromMs: number; toMs: number }[] = [];
      const imgIds: string[] = [];
      for (const p of seq) {
        const from = cur; const to = cur + Math.max(600, p.ms); cur = to;
        if (p.vid) { vItems.push({ itemId: p.vid, fromMs: from, toMs: to }); if (p.vKind !== "video") imgIds.push(p.vid); }
        if (p.aid) aItems.push({ itemId: p.aid, fromMs: from, toMs: to });
      }
      if (vItems.length) applyOperations([{ op: "arrange", items: vItems }]); // images→row, videos→row, at windows
      if (aItems.length) placeAudioClips(aItems);                             // narrator voice → ONE narration row
      if (imgIds.length) applyMotionBatch(imgIds.map((id, kk) => ({ id, kenBurns: kk % 2 ? "zoomOut" : "zoomIn", intensity: 18, duration: 100 })));
    };
    // GENERATE each shot in parallel; the moment one is ready → add + preview + re-stitch (show it NOW).
    await Promise.all(plan.map(async ({ k, g, talk, type, narrText }) => {
      if (_stopBuild) return;
      const prog = (d: any) => { const q = d?.queue_position, p = d?.progress; s.updateAt(i, { genStatus: q != null ? `🎬 Shot ${k + 1} queued #${q}…` : p != null ? `🎬 Shot ${k + 1} · ${p}%…` : `🎬 Shot ${k + 1}…` }); };
      try {
        let vUrl = "", aUrl = "", audioDriven = false;
        const vKind = g.op === "search" ? (g.kind === "video" ? "video" : "image") : (g.kind || "image");
        // A talk video's length: t2v = word estimate (spokenSecs); audio-driven = the audio (vApp sizes it).
        const genSecs = (vKind === "video" && talk ? spokenSecs(g) : 0) || Number(g.duration) || 5;
        if (talk && vKind === "video") {
          // TALKING shot → lip-sync pipeline. ref → audio-i2v; non-ref → t2v (see genTalkShot).
          ({ vUrl, aUrl, audioDriven } = await genTalkShot(g, narrText, prog));
        } else {
          // B-ROLL shot → stock search or a plain gen, then its narrator voiceover.
          if (g.op === "search") {
            // match the stock orientation to the shot's aspect (was pulling portrait stock into a 16:9 video)
            const orient = aspectOrientation(g.aspect_ratio);
            const path = vKind === "video" ? "/api/pexels-videos" : "/api/pexels";
            const query = g.query || narrText || g.prompt || "";
            const r = await fetch(withEditorBase(`${path}?query=${encodeURIComponent(query)}&per_page=1${orient ? `&orientation=${orient}` : ""}`));
            const d = await r.json().catch(() => ({}));
            vUrl = d?.photos?.[0]?.details?.src || d?.photos?.[0]?.src || d?.videos?.[0]?.details?.src || d?.videos?.[0]?.src || "";
            elog(`[DRAMA v2 ASM] shot ${k + 1} STOCK ${vKind} search "${String(query).slice(0, 48)}"${orient ? ` [${orient}]` : ""} → ${vUrl ? "hit" : "MISS (will AI-generate)"}`);
          }
          if (!vUrl) vUrl = await genUrl(vKind, { prompt: g.prompt, text: g.text, image_url: g.image_url, images: g.images, aspect_ratio: g.aspect_ratio, duration: genSecs, optimize: g.optimize }, prog);
          if (narrText) aUrl = await genUrl("audio", { text: narrText }, prog);
        }
        if (!vUrl) { elog(`[DRAMA v2 ASM] shot ${k + 1} (${type}) VISUAL failed after retry — kept out`); bump(); return; }
        elog(`[DRAMA v2 ASM] shot ${k + 1} (${type}) ${vKind} url=…${vUrl.slice(-74)}`);
        // Preview immediately; then ADD to the timeline. A FRESH R2 object can be slow to load the first
        // time (Cloudflare origin-fetch on a cache MISS), so the load may not land on the first try —
        // RE-ADD a few times (each waits ~22s) to catch it once the edge has cached it.
        const nowP = useAiEditStore.getState().messages[i];
        // show the shot's VISUAL and (when narrated) its VOICE clip in the chat, both as they land
        s.updateAt(i, { genPreviews: [...(nowP?.genPreviews || []), { kind: vKind, url: vUrl }, ...(aUrl ? [{ kind: "audio" as const, url: aUrl }] : [])] });
        // KNOWN dims (from the aspect-ratio + requested seconds) let designcombo add the VIDEO WITHOUT
        // downloading it first → instant land; the pixels stream in the player afterward. Videos are the
        // big/slow clips, so this is the main win. (Images always load, but they're small — retry covers.)
        const ar = String(g.aspect_ratio || "16:9");
        const wh: [number, number] = ar === "9:16" ? [720, 1280] : ar === "1:1" ? [1024, 1024] : ar === "4:5" ? [1024, 1280] : [1280, 720];
        // Declared timeline length. AUDIO-driven talk = real length is the (unknown-yet) audio → claim the
        // ceiling so a long window isn't clamped (real window = clipMs(aid)). T2V talk + b-roll video = we
        // requested genSecs and LTX fills it → declare genSecs (accurate, so clipMs(vid) = the real window).
        const vDurMs = (talk && audioDriven ? LIPSYNC_VIDEO_MAX_SECS : genSecs) * 1000;
        const vDims = vKind === "video" ? { width: wh[0], height: wh[1], durationMs: vDurMs } : undefined;
        let vid = "";
        for (let att = 0; att < 3 && !_stopBuild; att++) {
          const id = await serializedAdd(vKind, () => (vKind === "video" ? addVideo(vUrl, "shot", vDims) : addImage(vUrl, "shot")), 22000);
          if (id && (useStore.getState().trackItemsMap || {})[id]) { vid = id; break; }
          if (id) applyOperations([{ op: "delete", itemId: id }]); // drop the dead attempt before retrying
          elog(`[DRAMA v2 ASM] shot ${k + 1} add try ${att + 1}/3 didn't land — CDN warming, retry`);
          await sleep(2500);
        }
        if (!vid) { elog(`[DRAMA v2 ASM] shot ${k + 1} media never loaded after retries — dropped`); bump(); return; }
        // ADD the narrator voice — RETRY like the video. A fresh R2 mp3 can be slow to load the first time,
        // which was silently DROPPING the voiceover off the timeline ("ab audio hi ni timeline me").
        let aid = "";
        if (aUrl) {
          for (let att = 0; att < 3 && !_stopBuild; att++) {
            const id = await serializedAdd("audio", () => addAudio(aUrl, "narration"), 22000);
            if (id && (useStore.getState().trackItemsMap || {})[id]) { aid = id; break; }
            if (id) applyOperations([{ op: "delete", itemId: id }]);
            elog(`[DRAMA v2 ASM] shot ${k + 1} audio add try ${att + 1}/3 didn't land — retry`);
            await sleep(2000);
          }
          if (!aid) elog(`[DRAMA v2 ASM] shot ${k + 1} voice never loaded — visual kept, silent`);
        }
        // MUTE only for the AUDIO-driven path (ref/flag): the video is lip-synced to the TTS, so mute its own
        // track and let the overlaid clean TTS be heard. T2V keeps LTX's OWN generated speech (that's the whole
        // point — perfect lips + audio), so it is NEVER muted. (If the TTS didn't land, keep native audio.)
        if (talk && audioDriven && aid) { applyOperations([{ op: "edit", itemId: vid, details: { volume: 0 } }]); elog(`[DRAMA v2 ASM] shot ${k + 1} muted video audio → clean TTS voiceover`); }
        s.updateAt(i, { snapshot: { ...(useAiEditStore.getState().messages[i]?.snapshot || {}), [vid]: null, ...(aid ? { [aid]: null } : {}) } });
        // Window = the VOICE length (the TTS clip) when there is one; else the video's own footage (silent
        // b-roll video / talk video with no TTS), else the director's guessed seconds (silent image).
        let ms = aid ? clipMs(aid) : (vKind === "video" ? clipMs(vid) : 0);
        if (!ms) ms = (Number(g.duration) || 4) * 1000;
        // Just DROP it on the timeline as it lands (it's already added above) — do NOT re-arrange per clip.
        // The single category-row arrange happens ONCE at the end, when everything is in.
        landed.push({ k, type, vid, aid, vKind, ms });
        bump();
        s.updateAt(i, { genStatus: `🎬 ${landed.length}/${total} shots ready…` });
      } catch (e) { elog(`[DRAMA v2 ASM] shot ${k + 1} failed: ${e}`); bump(); }
    }));
    if (_stopBuild) { s.updateAt(i, { genStatus: "⏹ Stopped", buildProgress: "" }); return; }
    if (!landed.length) { s.updateAt(i, { genStatus: "⚠️ Drama: nothing landed — check the PROBE logs (url/CORS)" }); return; }
    const dropped = total - landed.length;
    restitch(); // final tidy pass
    s.updateAt(i, { genStatus: `✓ Drama built — ${landed.length} shots in order (${landed.filter((p) => p.type === "d").length} dialogue)${dropped ? ` · ${dropped} failed` : ""}`, buildProgress: "" });
    elog(`[DRAMA v2 ASM] ✅ ${landed.length}/${total} shots stitched${dropped ? ` · ${dropped} beat(s) FAILED` : ""}`);
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

      // 6. Arrange — DELEGATE to the SAME smart arrange the pipeline + plain Edit use (runBuild). No
      //    separate/duplicate arrange+motion path here: runBuild auto-finds the voiceover on the
      //    timeline, re-times these shots to the narration (match_shots relevancy), applies the
      //    length-aware Ken Burns motion AND the arranger's transition. We pass gens=[] (images already
      //    made) + ONE arrange op over the created shots (their times are recomputed, so ids suffice).
      if (items.length) {
        await runBuild(i, [], [{ op: "arrange", items: items.map((it) => ({ itemId: it.itemId })) }], []);
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
    const sync = m.ops.filter((o: any) => !["generate", "regenerate", "search", "animate", "lipsync", "musicbed", "sfx", "arrange", "captions", "direct"].includes(o.op));
    const gens = m.ops.filter((o: any) => ["generate", "regenerate", "search", "animate", "lipsync", "musicbed", "sfx"].includes(o.op));
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

    // generation (+ deferred arrange + post-effects) + captions run in the background — chat stays free.
    // DRAMA v2 uses its OWN ordered ASSEMBLER (per-shot audio, dialogue-locked, stitch in order) instead
    // of the relevance-matcher arrange. The screenplay rides on the message as scriptText.
    if (willBuild) {
      if (s.pipeline === "drama_v2") runBuildDrama(i, gens, m.scriptText || "");
      else runBuild(i, gens, arranges, postEffects);
    }
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
  const liveProgress = lastAsst?.buildProgress || ""; // the N/M counter — shown at the top too (same as the message)

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

          {/* Settings strip — auto / streaming / fast moved up here (out of the composer) so the prompt
              area stays clean. One compact row, click to toggle. Full set still in the ⚙ popover. */}
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border/50 px-3 py-1">
            <span className="text-[9px] text-muted-foreground/50">run</span>
            <button type="button" onClick={() => s.setAutoApply(!s.autoApply)} title="Auto-apply vs Ask (preview first)"
              className={`rounded-full border px-2 py-[1px] text-[9px] ${s.autoApply ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" : "border-border bg-background text-muted-foreground"}`}>
              {s.autoApply ? "auto" : "ask"}
            </button>
            <button type="button" onClick={() => s.setStreaming(!s.streaming)} title="Stream the response live"
              className={`rounded-full border px-2 py-[1px] text-[9px] ${s.streaming ? "border-sky-500/50 bg-sky-500/15 text-sky-600 dark:text-sky-300" : "border-border bg-background text-muted-foreground"}`}>
              stream
            </button>
            <button type="button" onClick={() => s.setShowThinking(!s.showThinking)} title="Fast = hide the model's thinking (lower latency)"
              className={`rounded-full border px-2 py-[1px] text-[9px] ${!s.showThinking ? "border-amber-500/50 bg-amber-500/15 text-amber-600 dark:text-amber-300" : "border-border bg-background text-muted-foreground"}`}>
              fast
            </button>
          </div>

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
                    {liveProgress ? <span className="ml-1 shrink-0 tabular-nums opacity-60">{liveProgress}</span> : null}
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
                    {m.scriptText ? (
                      <div className="mb-1">
                        <button
                          onClick={() => s.updateAt(i, { scriptOpen: !m.scriptOpen })}
                          className="flex items-center gap-1 text-[10px] text-violet-600/80 hover:text-violet-600 dark:text-violet-300/70"
                        >
                          <span>{m.scriptOpen ? "▾" : "▸"}</span>
                          <span>📝 Script</span>
                          <span className="text-[9px] opacity-60">
                            {m.scriptText.trim().split(/\s+/).filter(Boolean).length}w · ~{Math.round(m.scriptText.trim().split(/\s+/).filter(Boolean).length / 2.5)}s
                          </span>
                        </button>
                        {m.scriptOpen && (
                          <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-violet-500/20 bg-violet-500/5 px-2 py-1 text-[11px] leading-relaxed text-foreground/80">
                            {m.scriptText}
                          </div>
                        )}
                      </div>
                    ) : null}
                    {(m.ops?.length || m.directText) ? (
                      <div className="mb-1">
                        <button
                          onClick={() => s.updateAt(i, { directOpen: !m.directOpen })}
                          className="flex items-center gap-1 text-[10px] text-fuchsia-600/80 hover:text-fuchsia-600 dark:text-fuchsia-300/70"
                        >
                          <span>{m.directOpen ? "▾" : "▸"}</span>
                          <span>🎬 Directing</span>
                          {m.ops?.length ? (
                            <span className="text-[9px] opacity-60">
                              {m.ops.filter((o: any) => o.op === "generate" && o.kind !== "audio").length || m.ops.length} shots
                            </span>
                          ) : null}
                        </button>
                        {m.directOpen && (
                          <div className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/5 px-2 py-1 text-[10px] leading-relaxed text-foreground/80">
                            {m.ops?.length ? (
                              <ul className="space-y-0.5">
                                {m.ops.map((op: any, oi: number) => (
                                  <li key={oi} className="truncate">• {describeOp(op)}</li>
                                ))}
                              </ul>
                            ) : null}
                            {m.directText ? (
                              <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[9px] opacity-60">{m.directText}</pre>
                            ) : null}
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
                          {/* compact counter right after the task, e.g. "Generating video… 4/10" */}
                          {m.buildProgress ? <span className="ml-1 tabular-nums opacity-60">{m.buildProgress}</span> : null}
                        </span>
                      )}
                    </div>
                    {m.genPreviews?.map((pv, k) => (
                      <div key={k} className="mt-1.5">
                        {pv.kind === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={pv.url} alt="" className="max-h-40 rounded-lg border border-border" />
                        ) : pv.kind === "video" ? (
                          // preload="none": do NOT auto-download every result preview the moment the
                          // panel renders — on a slow pipe 3-4 of these + the main player all pulling
                          // at once split the bandwidth so nothing finishes ("stuck 20 min"). Loads
                          // only when the user hits play, so the clip being watched owns the pipe.
                          <video src={pv.url} poster={withEditorBase(`/api/media-poster?url=${encodeURIComponent(pv.url)}`)} controls preload="none" className="max-h-40 w-full rounded-lg border border-border bg-black" />
                        ) : (
                          <audio src={pv.url} controls preload="none" className="w-full" />
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
            <div
              className="rounded-xl border border-border bg-muted/40 p-1.5 focus-within:border-sky-500/40"
              onDrop={onComposerDrop}
              onDragOver={(e) => { if (s.pipeline) e.preventDefault(); }}
            >
              {s.pipeline ? (() => {
                const explicit = s.refImages;
                const refs = explicit.length ? explicit : selectedRefSrcs();
                if (!refs.length && !refBusy) return null;
                const fromSel = !explicit.length && refs.length > 0; // selection fallback (no ✕ — deselect on the timeline)
                return (
                  <div className="mb-1 flex flex-col gap-1 rounded-lg bg-violet-500/10 px-1.5 py-1">
                    <span className="text-[10px] text-violet-600 dark:text-violet-300">
                      {fromSel
                        ? `Selected clip${refs.length > 1 ? "s" : ""} — used as reference (deselect to change)`
                        : `Reference${refs.length > 1 ? "s" : ""} — every shot keeps ${refs.length > 1 ? "these subjects" : "this subject"} (paste / drop / select to add more)`}
                    </span>
                    <div className="flex flex-wrap items-center gap-1">
                      {refs.map((src) => (
                        <div key={src} className="relative">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={src} alt="reference" className="h-9 w-9 rounded object-cover" />
                          {!fromSel ? (
                            <button type="button" onClick={() => s.removeRefImage(src)} className="absolute -right-1 -top-1 rounded-full bg-background/90 px-1 text-[9px] leading-none text-muted-foreground shadow hover:text-red-500" title="Remove this reference">✕</button>
                          ) : null}
                        </div>
                      ))}
                      {refBusy ? <span className="self-center text-[10px] text-violet-500">uploading…</span> : null}
                    </div>
                  </div>
                );
              })() : null}
              <textarea
                ref={taRef}
                value={s.input}
                onChange={(e) => s.setInput(e.target.value)}
                onPaste={onComposerPaste}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={1}
                placeholder={
                  s.pipeline === "comic_drama"
                    ? 'Enter a story idea, e.g. "a billionaire\'s secret revenge"…'
                    : s.pipeline === "faceless_video"
                      ? 'Enter a topic, e.g. "the history of black holes"…'
                      : "Describe the edit…"
                }
                className="min-h-[36px] w-full resize-none overflow-y-auto bg-transparent px-1.5 py-1 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/40"
                style={{ maxHeight: 160 }}
              />
              <div className="mt-1 flex items-center justify-end gap-1.5">
                <div className="flex flex-wrap items-center justify-end gap-1.5">
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
                  {/* S/D PRESETS (Directors) — the planner "brain". Built-in (Edit / Comic Drama /
                      Faceless) + your own custom system-prompt directors (add / edit / delete,
                      localStorage). Selecting one swaps the system prompt. Always visible. */}
                  <div className="relative" ref={dirMenuRef}>
                    <button
                      type="button"
                      onClick={() => setDirMenuOpen((o) => !o)}
                      className={`flex h-7 max-w-[150px] items-center gap-1 truncate rounded-lg border px-1.5 text-[10px] outline-none ${
                        s.pipeline
                          ? "border-violet-500/50 bg-violet-500/15 text-violet-600 dark:text-violet-300"
                          : "border-border bg-background text-muted-foreground"
                      }`}
                      title="Director (S/D preset) — which system prompt the planner uses"
                    >
                      <span className="truncate">{curDirector?.label || "✦ Edit / General"}</span>
                      <span className="opacity-60">▾</span>
                    </button>
                    {dirMenuOpen && (
                      <div className="absolute bottom-full right-0 z-50 mb-1 max-h-[300px] w-[240px] overflow-auto rounded-lg border border-border bg-background p-1 shadow-xl">
                        {allDirectors.map((d) => {
                          const custom = d.id.startsWith("dir_");
                          const overridden = !custom && !!dirOverrides[d.id];
                          return (
                            <div key={d.id || "edit"} className="group flex items-center rounded-md hover:bg-muted/60">
                              <button
                                type="button"
                                onClick={() => { s.setPipeline(d.id); setDirMenuOpen(false); setDirEdit(null); setDirErr(""); }}
                                className={`flex-1 truncate px-2 py-1 text-left text-[11px] ${s.pipeline === d.id ? "font-medium text-violet-600 dark:text-violet-300" : "text-foreground"}`}
                              >
                                {d.label}
                                {overridden && <span title="edited by admin (global)" className="ml-1 text-[8px] text-violet-500">✎</span>}
                              </button>
                              {custom ? (
                                <>
                                  <button type="button" title="Edit" onClick={() => { const cd = s.customDirectors.find((x) => x.id === d.id); setDirEdit({ id: d.id, label: d.label, systemPrompt: cd?.systemPrompt || "", scriptPrompt: cd?.scriptPrompt || "" }); setDirErr(""); }} className="px-1 text-[11px] text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100">✎</button>
                                  <button type="button" title="Delete" onClick={() => s.removeCustomDirector(d.id)} className="px-1 pr-1.5 text-[11px] text-muted-foreground opacity-0 hover:text-red-500 group-hover:opacity-100">🗑</button>
                                </>
                              ) : isAdmin ? (
                                <button type="button" title="Edit this built-in prompt — saves GLOBALLY for everyone (admin)" onClick={() => { setDirEdit({ id: d.id, label: d.label, systemPrompt: directorPromptOf(d.id), builtin: true }); setDirErr(""); }} className="px-1 pr-1.5 text-[11px] text-muted-foreground opacity-0 hover:text-violet-500 group-hover:opacity-100">✎</button>
                              ) : null}
                            </div>
                          );
                        })}
                        <div className="my-1 border-t border-border" />
                        {dirEdit ? (
                          <div className="flex flex-col gap-1 p-1">
                            {dirEdit.builtin && (
                              <p className="px-0.5 text-[9px] text-violet-500">Editing a built-in director — saves GLOBALLY (all users), live. Admin only.</p>
                            )}
                            <input
                              autoFocus={!dirEdit.builtin}
                              value={dirEdit.label}
                              onChange={(e) => setDirEdit({ ...dirEdit, label: e.target.value })}
                              placeholder="Name (e.g. 🎭 Horror Director)"
                              className="h-6 rounded border border-border bg-background px-1.5 text-[11px] outline-none focus:border-violet-500/60"
                            />
                            <p className="px-0.5 text-[9px] text-muted-foreground">Shots / directing prompt (the brain — role, ops, visual style):</p>
                            <textarea
                              autoFocus={dirEdit.builtin}
                              value={dirEdit.systemPrompt}
                              onChange={(e) => setDirEdit({ ...dirEdit, systemPrompt: e.target.value })}
                              placeholder="System prompt — the director's brain: its role, the ops it may use, the style. (Prefilled from the current director — tweak it.)"
                              rows={7}
                              className="resize-y rounded border border-border bg-background px-1.5 py-1 text-[11px] outline-none focus:border-violet-500/60"
                            />
                            {!dirEdit.builtin && (
                              <>
                                <p className="px-0.5 text-[9px] text-muted-foreground">Script instructions (optional) — how THIS director's narration sounds (tone, pauses, pacing). Blank = the default scriptwriter.</p>
                                <textarea
                                  value={dirEdit.scriptPrompt || ""}
                                  onChange={(e) => setDirEdit({ ...dirEdit, scriptPrompt: e.target.value })}
                                  placeholder="e.g. slow breathy sensual pauses · short punchy horror beats · warm documentary voice…"
                                  rows={3}
                                  className="resize-y rounded border border-border bg-background px-1.5 py-1 text-[11px] outline-none focus:border-violet-500/60"
                                />
                              </>
                            )}
                            {dirErr && <p className="px-0.5 text-[10px] text-red-500">{dirErr}</p>}
                            <div className="flex items-center justify-end gap-1">
                              {dirEdit.builtin && dirOverrides[dirEdit.id] && (
                                <button type="button" onClick={() => resetDir(dirEdit.id)} className="mr-auto rounded px-2 py-[2px] text-[10px] text-amber-600 hover:bg-amber-500/10" title="Revert to the original built-in prompt">Reset to default</button>
                              )}
                              <button type="button" onClick={() => { setDirEdit(null); setDirErr(""); }} className="rounded px-2 py-[2px] text-[10px] text-muted-foreground hover:bg-muted">Cancel</button>
                              <button type="button" onClick={saveDir} disabled={!dirEdit.systemPrompt.trim() || (!dirEdit.builtin && !dirEdit.label.trim())} className="rounded bg-violet-600 px-2 py-[2px] text-[10px] text-white hover:bg-violet-500 disabled:opacity-40">Save</button>
                            </div>
                          </div>
                        ) : (
                          <button type="button" onClick={() => { setDirEdit({ id: "new", label: "", systemPrompt: directorPromptOf(s.pipeline) }); setDirErr(""); }} className="w-full rounded-md px-2 py-1 text-left text-[11px] text-sky-600 hover:bg-muted/60">
                            + Add director
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {/* REFERENCE IMAGE — no button. Attach it in the prompt area itself: paste an image
                      or image-URL, drag-drop a file, or select a timeline image. The chip above the
                      textarea shows the current reference (see onComposerPaste / onComposerDrop). */}
                  {/* P PRESETS — prompt snippets. Clicking one PASTES its text into the box (visible +
                      editable → it reaches the planner AND match_shots via _lastPipelineRequest).
                      Built-in + your own (add / edit / delete, localStorage). Always visible. */}
                  <div className="relative" ref={vibeMenuRef}>
                    <button
                      type="button"
                      onClick={() => setVibeMenuOpen((o) => !o)}
                      className="flex h-7 max-w-[120px] items-center gap-1 truncate rounded-lg border border-border bg-background px-1.5 text-[10px] text-muted-foreground outline-none"
                      title="P preset — paste a style / prompt snippet into the box"
                    >
                      <span className="truncate">＋ Preset</span>
                      <span className="opacity-60">▾</span>
                    </button>
                    {vibeMenuOpen && (
                      <div className="absolute bottom-full right-0 z-50 mb-1 max-h-[280px] w-[220px] overflow-auto rounded-lg border border-border bg-background p-1 shadow-xl">
                        <div className="px-2 py-1 text-[10px] text-muted-foreground">{pPresets.length ? "click to paste into the prompt" : "no presets yet — add your own below"}</div>
                        {pPresets.map((v) => {
                          const custom = v.id.startsWith("custom_");
                          return (
                            <div key={v.id} className="group flex items-center rounded-md hover:bg-muted/60">
                              <button
                                type="button"
                                onClick={() => pastePreset(v.style)}
                                title={v.style}
                                className="flex-1 truncate px-2 py-1 text-left text-[11px] text-foreground"
                              >
                                {v.label}
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
                              placeholder="Snippet to paste, e.g. dark rainy noir, slow moody holds, cold blue grade, hard fast cuts"
                              rows={3}
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
                  <button
                    onClick={working ? stopWork : send}
                    disabled={!working && !s.input.trim()}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white transition disabled:opacity-40 ${working ? "bg-red-600 hover:bg-red-500" : "bg-sky-600 hover:bg-sky-500"}`}
                    title={working ? "Stop the AI" : "Send"}
                  >
                    {working ? "■" : "↑"}
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
