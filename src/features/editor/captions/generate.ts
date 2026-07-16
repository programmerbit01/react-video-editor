/**
 * Caption GENERATION — transcribe media, build caption items, apply/remove them.
 *
 * Split out of control-item/captions-panel.tsx so the left Captions menu can own the whole
 * flow. Creating captions is all this file does; every bit of restyling belongs to
 * BasicCaption (Preset / Words / Style / Colors / Motion / Effects + "Apply style to all").
 * The panel that used to live here carried a second, weaker style UI whose every change re-ran
 * applyCaption — which rebuilds the items from scratch and so silently wiped whatever
 * BasicCaption had set.
 */
import { ITrackItem } from "@designcombo/types";
import useCaptionTranscribeStore, { TranscriptResult } from "./transcribe-store";
import { getStateManagerRef } from "../utils/state-manager-ref";

// ── helpers ──────────────────────────────────────────────────────────────────

const CAPTION_TRACK_PREFIX = "captions-track--";

// The style captions are BORN with. This panel only creates captions; restyling them is
// BasicCaption's job (Preset / Words / Style / Colors / Motion / Effects, plus "Apply style
// to all"). This panel used to carry a second, weaker style UI whose every change re-ran
// applyCaption — which rebuilds the caption items from scratch and so silently wiped
// whatever BasicCaption had set. One styler now, and it isn't this one.
const DEFAULT_STYLE = {
  fontSize: 22,
  color: "#FFFFFF",
  activeColor: "#F5E7BE",
  activeFillColor: "#7E12FF",
  backgroundColor: "rgba(0,0,0,0)",
  position: "bottom" as "top" | "center" | "bottom",
  highlightWords: false
};

const POSITION_TOP: Record<string, string> = {
  top: "10%",
  center: "45%",
  bottom: "80%"
};

const getVappParams = () => {
  if (typeof window === "undefined") return { vappHost: "", token: "", baseUrl: "" };
  const p = new URLSearchParams(window.location.search);
  return {
    vappHost: p.get("vappHost") || `${window.location.protocol}//${window.location.host}`,
    token: p.get("token") || "",
    baseUrl: p.get("baseUrl") || "https://api.muapi.ai"
  };
};

const withEditorBase = (path: string) => {
  if (typeof window === "undefined") return path;
  return window.location.pathname.startsWith("/editor") ? `/editor${path}` : path;
};

function normalizeTranscriptResult(input: any, fallbackDuration: number): TranscriptResult {
  const text = String(input?.text || "").trim();
  const language = String(input?.language || "").trim();
  const rawSegs = Array.isArray(input?.segments) ? input.segments : [];
  const segments = rawSegs.length > 0
    ? rawSegs.map((s: any) => ({
        start: Number(s?.start || 0),
        end: Number(s?.end || 0),
        text: String(s?.text || "").trim(),
        words: Array.isArray(s?.words)
          ? s.words.map((w: any) => ({ word: String(w?.word || "").trim(), start: Number(w?.start || 0), end: Number(w?.end || 0) }))
          : undefined
      })).filter((s: any) => s.text)
    : text ? [{ start: 0, end: Math.max(1, fallbackDuration), text }] : [];
  return { text, language, segment_count: Number(input?.segment_count || segments.length || 0), segments };
}

function buildWords(segment: any, overlapStart: number, overlapEnd: number) {
  if (!segment.words?.length) {
    return [{ word: segment.text, start: segment.start * 1000, end: segment.end * 1000, confidence: 1 }];
  }
  const filtered = segment.words.filter(
    (w: any) => Number(w.start) >= overlapStart - 0.05 && Number(w.end) <= overlapEnd + 0.05
  );
  return (filtered.length ? filtered : segment.words).map((w: any) => ({
    word: w.word,
    start: w.start * 1000,
    end: w.end * 1000,
    confidence: 1
  }));
}

function buildCaptionItem(trackItem: ITrackItem, segment: any, segIdx: number, style: typeof DEFAULT_STYLE) {
  const trimFrom = Number((trackItem as any)?.trim?.from || 0) / 1000;
  const trimTo = Number(
    (trackItem as any)?.trim?.to ||
    (trackItem as any)?.duration ||
    Math.max(0, (trackItem as any).display.to - (trackItem as any).display.from)
  ) / 1000;
  const clipDisplayFrom = Number((trackItem as any).display.from || 0);

  const overlapStart = Math.max(trimFrom, Number(segment.start || 0));
  const overlapEnd = Math.min(trimTo, Number(segment.end || 0));
  if (overlapEnd <= overlapStart) return null;

  const displayFrom = clipDisplayFrom + (overlapStart - trimFrom) * 1000;
  const displayTo = clipDisplayFrom + (overlapEnd - trimFrom) * 1000;

  return {
    id: `cap-${trackItem.id}-${segIdx}-${Math.random().toString(36).slice(2, 7)}`,
    type: "caption",
    name: "caption",
    isMain: false,
    display: { from: displayFrom, to: displayTo },
    metadata: {
      sourceTrackItemId: trackItem.id,
      addedCaption: true,
      // groupCaptionItems() in preset-picker and caption-words groups by sourceUrl
      sourceUrl: (trackItem as any)?.details?.src ?? "",
      // offset from the clip's start → used by useCaptionSync to keep the caption glued
      // to its clip when the clip is moved (shift caption by the same delta).
      relFrom: displayFrom - clipDisplayFrom,
      relTo: displayTo - clipDisplayFrom,
    },
    details: {
      text: String(segment.text || "").trim(),
      fontSize: style.fontSize,
      color: style.color,
      activeColor: style.highlightWords ? style.activeColor : style.color,
      activeFillColor: style.highlightWords ? style.activeFillColor : "transparent",
      appearedColor: style.color,
      backgroundColor: style.backgroundColor,
      borderColor: "rgba(255,255,255,0.08)",
      borderWidth: 1,
      fontFamily: "Inter",
      fontUrl: "",
      textAlign: "center",
      linesPerCaption: 2,
      words: buildWords(segment, overlapStart, overlapEnd),
      top: POSITION_TOP[style.position],
      left: "calc(50% - 340px)",
      width: 680,
      height: 80
    }
  };
}

function removeCaption(trackItem: ITrackItem) {
  const sm = getStateManagerRef();
  if (!sm) return;
  const state = sm.getState();
  const tracks: any[] = Array.isArray(state?.tracks) ? state.tracks : [];
  const map = { ...(state?.trackItemsMap || {}) };
  const ids: string[] = Array.isArray(state?.trackItemIds) ? [...state.trackItemIds] : [];

  const toRemove = new Set(
    Object.keys(map).filter(
      (id) => map[id]?.metadata?.sourceTrackItemId === trackItem.id && map[id]?.metadata?.addedCaption
    )
  );
  toRemove.forEach((id) => delete map[id]);

  // Captions share ONE track — remove only THIS clip's caption items from the caption
  // track(s), and drop a caption track only if it ends up empty.
  const nextTracks = tracks
    .map((t) =>
      t?.type === "caption"
        ? { ...t, items: (Array.isArray(t.items) ? t.items : []).filter((id: string) => !toRemove.has(id)) }
        : t
    )
    .filter((t) => t?.type !== "caption" || (Array.isArray(t.items) && t.items.length > 0));

  sm.updateState(
    {
      tracks: nextTracks,
      trackItemIds: ids.filter((id) => !toRemove.has(id)),
      trackItemsMap: map
    },
    { updateHistory: true }
  );
}

function applyCaption(trackItem: ITrackItem, transcript: TranscriptResult, style: typeof DEFAULT_STYLE) {
  const sm = getStateManagerRef();
  if (!sm || !transcript?.segments) return;

  const captionTrackId = `${CAPTION_TRACK_PREFIX}${trackItem.id}`;
  const currentState = sm.getState();
  const currentTracks: any[] = Array.isArray(currentState?.tracks) ? currentState.tracks : [];
  const currentMap = { ...(currentState?.trackItemsMap || {}) };
  const currentIds: string[] = Array.isArray(currentState?.trackItemIds) ? [...currentState.trackItemIds] : [];

  const oldIds = Object.keys(currentMap).filter(
    (id) => currentMap[id]?.metadata?.sourceTrackItemId === trackItem.id && currentMap[id]?.metadata?.addedCaption
  );
  oldIds.forEach((id) => delete currentMap[id]);
  const filteredIds = currentIds.filter((id) => !oldIds.includes(id));

  const newItems = transcript.segments
    .map((seg, i) => buildCaptionItem(trackItem, seg, i, style))
    .filter(Boolean) as any[];
  if (!newItems.length) return;

  newItems.forEach((item) => { currentMap[item.id] = item; });
  const newIds = [...filteredIds, ...newItems.map((i) => i.id)];

  // ALL captions share ONE caption track (single row). If a caption track already
  // exists, merge this clip's captions into it (dropping any other caption tracks);
  // otherwise create one right after this clip's track. Items keep sourceTrackItemId,
  // so per-clip add/remove still works.
  const capTracks = currentTracks.filter((t) => t?.type === "caption");
  let nextTracks: any[];
  if (capTracks.length) {
    const mergedItemIds = [
      ...capTracks.flatMap((t) => (Array.isArray(t.items) ? t.items : []).filter((id: string) => !oldIds.includes(id))),
      ...newItems.map((i) => i.id),
    ];
    const sharedTrack = { ...capTracks[0], id: capTracks[0].id, type: "caption", items: mergedItemIds };
    let placed = false;
    nextTracks = [];
    for (const t of currentTracks) {
      if (t?.type === "caption") { if (!placed) { nextTracks.push(sharedTrack); placed = true; } }
      else nextTracks.push(t);
    }
  } else {
    let insertAfter = currentTracks.findIndex((t) => Array.isArray(t.items) && t.items.includes(trackItem.id));
    if (insertAfter === -1) insertAfter = currentTracks.length - 1;
    const newTrack = {
      id: captionTrackId, type: "caption", name: "Captions", accepts: ["caption"],
      items: newItems.map((i) => i.id), magnetic: false, static: false,
      metadata: { captionTrack: true },
    };
    nextTracks = [
      ...currentTracks.slice(0, insertAfter + 1),
      newTrack,
      ...currentTracks.slice(insertAfter + 1),
    ];
  }

  sm.updateState(
    { tracks: nextTracks, trackItemIds: newIds, trackItemsMap: currentMap },
    { updateHistory: true }
  );
}

// ── public API ───────────────────────────────────────────────────────────────

export { applyCaption, removeCaption, DEFAULT_STYLE, CAPTION_TRACK_PREFIX };

/** Caption items currently attached to `mediaId`. */
export function captionCountFor(tracks: any[], mediaId: string): number {
  const track = (tracks || []).find((t) => t?.id === `${CAPTION_TRACK_PREFIX}${mediaId}`);
  return track?.items?.length ?? 0;
}

/**
 * Transcribe `src` via the vApp STT job queue and return the normalised transcript.
 * Throws with a human-readable message; the caller owns the loading/error UI.
 */
export async function transcribeMedia(
  src: string,
  fallbackDurationSec: number
): Promise<TranscriptResult> {
  const { token, baseUrl } = getVappParams();

  const fireRes = await fetch(withEditorBase("/api/transcribe"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: src, timestamp_type: "word", token, baseUrl })
  });
  if (!fireRes.ok) throw new Error("Failed to queue transcription");

  const fireData = await fireRes.json().catch(() => ({}));
  const jobId = String(fireData?.job_id || "").trim();
  if (!jobId) throw new Error("No job_id returned");

  let sttData: TranscriptResult | null = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const pollRes = await fetch(
        withEditorBase(
          `/api/transcribe/${jobId}?token=${encodeURIComponent(token)}&baseUrl=${encodeURIComponent(baseUrl)}`
        )
      );
      const pollData = await pollRes.json().catch(() => ({}));
      if (pollData?.failed) throw new Error("Transcription job failed");
      if (pollData?.done) {
        const stt = pollData?.stt || {};
        if (Array.isArray(stt?.segments) && stt.segments.length) sttData = stt as TranscriptResult;
        break;
      }
    } catch (e: any) {
      if (String(e?.message || "").includes("failed")) throw e;
    }
  }

  if (!sttData?.segments?.length) throw new Error("No transcript segments found");
  return normalizeTranscriptResult(sttData, fallbackDurationSec);
}
