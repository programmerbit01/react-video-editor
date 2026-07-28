// AI Edit — operations schema + apply-to-timeline + capabilities.
// DURABLE envelope: { summary, operations: [...] }. Only new `op` types get added.
//
// Only CONFIRMED-rendering ops are exposed (they show on playback in the Remotion
// player), so an applied edit is never invisible:
//   duration  -> stateManager.updateState (display timing)
//   kenBurns   -> EDIT_OBJECT details.kenBurns* (player computes zoom/pan per frame;
//                 a static details.transform is IGNORED by the player — must use this)
//   fade       -> EDIT_OBJECT animations.in/out (BoxAnim reads these)
//   opacity/volume/speed/text -> EDIT_OBJECT details / playbackRate
//   delete     -> LAYER_DELETE
//   add text   -> ADD_TEXT ;  add audio (generated) -> ADD_AUDIO

import { dispatch } from "@designcombo/events";
import { EDIT_OBJECT, LAYER_DELETE, ADD_TEXT, ADD_AUDIO, ADD_ITEMS, ADD_VIDEO, LAYER_SELECTION } from "@designcombo/state";
import { Easing } from "remotion";
import { nanoid } from "nanoid";
import { getStateManagerRef } from "../utils/state-manager-ref";
import { TEXT_ADD_PAYLOAD } from "../constants/payload";
import { upsertMusicBed } from "../utils/scene-audio";
// The DIRECTOR pipeline prompts live in ONE editable place (./editor-config.ts). Imported here
// (so PIPELINE_PROMPTS below can use them) and re-exported (so existing importers are unchanged).
import { COMIC_DRAMA_PROMPT, FACELESS_EDIT_PROMPT } from "./editor-config";
export { COMIC_DRAMA_PROMPT, FACELESS_EDIT_PROMPT };

export interface AiEditOp {
  op: "edit" | "delete" | "add" | "fade" | "transition" | "generate" | "regenerate" | "arrange" | "search" | "captions" | "direct" | "animate" | "lipsync" | "musicbed" | "sfx";
  itemId?: string;
  // musicbed / sfx (client picks the src from the curated audio library, then applies):
  src?: string; // audio url
  volume?: number; // 0-100
  // lipsync (align a talking-head video's speech to the timeline audio — client computes these):
  display?: { from: number; to: number }; // where on the timeline the video plays (ms)
  trim?: { from: number; to: number }; // which portion of the source video (ms)
  mute?: boolean; // silence the video's own audio (the narration plays)
  itemIds?: string[];
  durationMs?: number;
  details?: Record<string, any>; // EDIT_OBJECT patch: kenBurns, opacity, volume, text, fontSize…
  playbackRate?: number;
  // fade:
  mode?: "in" | "out" | "both";
  // add:
  type?: string; // "text"
  text?: string;
  fromMs?: number;
  toMs?: number;
  // generate / regenerate:
  kind?: string; // "audio" | "image" | "video"
  prompt?: string;
  aspect_ratio?: string;
  duration?: number;
  image_url?: string; // regenerate: source image for img2img
  images?: string[]; // multi-reference (character consistency) — forwarded as images_list
  talk?: boolean; // generate video: a TALKING / lip-sync shot (the character speaks) — the director SETS this, so we never hard-code a "says" keyword
  // arrange (sequence items to build a video):
  totalMs?: number;
  startMs?: number;
  items?: { itemId: string; fromMs: number; toMs: number }[]; // explicit per-item timing (importance / script-sync)
  target?: string; // arrange "all" → sequence every visual item (for just-generated media whose ids don't exist yet)
  consolidate?: boolean; // arrange: move the arranged visuals onto ONE video track (default true)
  // direct (one-shot auto-director: topic → script → voiceover → shots → captions):
  topic?: string;
  durationSec?: number;
  mediaKind?: string; // "stock" (default, fast) | "image" (AI-generate) | "video"
  // search (stock):
  query?: string;
  count?: number;
}

export interface OpsEnvelope {
  summary?: string;
  operations: AiEditOp[];
}

const fadeComposition = (from: number, to: number, name: string) => ({
  name,
  composition: [
    { property: "opacity", from, to, durationInFrames: 9, easing: "linear", ease: Easing.linear },
  ],
});

// Add generated media to the timeline. Each returns the new item id (for revert).
// NOTE: ADD_AUDIO must be given a MINIMAL payload (NO `display`, NO `details.volume`) — exactly like
// the editor's own audio-add (menu-item/archival.tsx). Passing `display` makes the reducer SILENTLY
// DROP the item (no audio track ever appears — this was the "voiceover not on the timeline" bug). The
// reducer LOADS the audio and sets the real duration itself → the voiceover lands at its true length
// ("audio is king"), so the fromMs/durationMs args are advisory only and not passed through.
export function addAudio(src: string, name: string, _fromMs = 0, _durationMs = 5000): string {
  const id = nanoid();
  const prompt = String(name || "").trim();
  dispatch(ADD_AUDIO, {
    payload: {
      id,
      type: "audio",
      name: (prompt || "voiceover").slice(0, 40),
      details: { src },
      ...(prompt ? { metadata: { prompt: prompt.slice(0, 200) } } : {}),
    },
    options: {},
  });
  return id;
}

export function addImage(src: string, name: string, fromMs = 0, durationMs = 5000): string {
  const id = nanoid();
  const prompt = String(name || "").trim();
  dispatch(ADD_ITEMS, {
    payload: {
      trackItems: [
        {
          id,
          type: "image",
          name: (prompt || "image").slice(0, 40),
          display: { from: fromMs, to: fromMs + durationMs },
          // The ADD_ITEMS reducer normalises `name` → "image" and strips extra `details.*` keys, so a
          // generated image's PROMPT (what it depicts) would be lost — and the arrange's relevancy
          // match reads it. `metadata` IS preserved through the reducer, so stash the prompt there.
          details: { src },
          metadata: prompt ? { prompt: prompt.slice(0, 200) } : {},
        },
      ],
    },
  });
  return id;
}

export function addVideo(src: string, name: string): string {
  const id = nanoid();
  const prompt = String(name || "").trim();
  dispatch(ADD_VIDEO, {
    // metadata.prompt survives the reducer (name is normalised away) → the arrange's relevancy match
    // knows what this VIDEO depicts, same as images. (vApp media.meta also has it as a fallback.)
    payload: { id, type: "video", name: (prompt || "video").slice(0, 40), details: { src }, ...(prompt ? { metadata: { prompt: prompt.slice(0, 200) } } : {}) },
    options: { resourceId: "main", scaleMode: "fit" },
  });
  return id;
}

// Swap the media (src) of an existing item — used by image regenerate (img2img).
export function replaceMedia(itemId: string, src: string): void {
  dispatch(EDIT_OBJECT, { payload: { [itemId]: { details: { src } } } });
}

// Set the timeline's active selection (chips: click → select in timeline, × → deselect).
export function setSelection(ids: string[]): void {
  dispatch(LAYER_SELECTION, { payload: { activeIds: ids } });
}

// Apply DIFFERENT Ken Burns per item in ONE EDIT_OBJECT dispatch. N separate edit dispatches race in
// designcombo's async reducer and only the LAST sticks (why the drama arrange's motion landed on just
// the last image); one dispatch with a per-id payload applies to ALL. Returns the {id:kenBurns} map
// applied (for logging).
export function applyMotionBatch(
  items: { id: string; kenBurns: string; intensity?: number; duration?: number }[],
  fadeIds?: string[], // ids that ALSO get a fade-in+out (a transition). MERGED into the SAME EDIT_OBJECT
                      // dispatch as the motion — a SEPARATE 2nd dispatch races and, per designcombo,
                      // "only the last sticks", silently clobbering the kenBurns (→ "no zoom, only fades").
): Record<string, string> {
  const payload: Record<string, any> = {};
  const applied: Record<string, string> = {};
  for (const it of items) {
    if (!it?.id) continue;
    payload[it.id] = {
      details: {
        kenBurns: it.kenBurns,
        kenBurnsIntensity: it.intensity ?? 18,
        // duration = % of the clip the move plays over; low = a quick "punch" then hold (100 = default slow).
        ...(it.duration != null ? { kenBurnsDuration: it.duration } : {}),
      },
    };
    applied[it.id] = it.kenBurns;
  }
  if (fadeIds?.length) {
    const anim = { in: fadeComposition(0, 1, "fadeIn"), out: fadeComposition(1, 0, "fadeOut") };
    for (const id of fadeIds) payload[id] = { ...(payload[id] || {}), animations: anim }; // motion + fade, one dispatch
  }
  if (Object.keys(payload).length) dispatch(EDIT_OBJECT, { payload });
  return applied;
}

// Apply SYNC ops (everything except `generate`, which is async and handled by the
// panel). Returns ids created by add ops so the caller can record them for revert.
export function applyOperations(ops: AiEditOp[]): { addedIds: string[] } {
  const sm = getStateManagerRef();
  const addedIds: string[] = [];

  for (const op of ops || []) {
    if (!op) continue;

    if (op.op === "delete") {
      const ids = op.itemIds?.length ? op.itemIds : op.itemId ? [op.itemId] : [];
      if (ids.length) dispatch(LAYER_DELETE, { payload: { trackItemIds: ids } });
      continue;
    }

    if (op.op === "fade" && op.itemId) {
      const mode = op.mode || "both";
      const anim: any = {};
      if (mode === "in" || mode === "both") anim.in = fadeComposition(0, 1, "fadeIn");
      if (mode === "out" || mode === "both") anim.out = fadeComposition(1, 0, "fadeOut");
      dispatch(EDIT_OBJECT, { payload: { [op.itemId]: { animations: anim } } });
      continue;
    }

    // Arrange/sequence items to build a video. Two forms (only IMAGE/VIDEO are re-timed — captions,
    // text and audio are NEVER touched):
    //  - op.items:  explicit per-item {fromMs,toMs} → importance / script-sync
    //  - op.itemIds + totalMs: equal back-to-back slices
    // The arranged visuals are then CONSOLIDATED into CATEGORY ROWS: all images on one row, all
    // videos on another (clean, grouped — not scattered), unless op.consolidate === false.
    if (op.op === "arrange" && sm) {
      const st = sm.getState?.();
      const map = { ...(st?.trackItemsMap || {}) };
      const isVisualItem = (it: any) => it && (it.type === "image" || it.type === "video");
      const arrangedIds: string[] = []; // visuals we (re)timed, in final playback order
      let changed = false;
      if (op.items?.length) {
        for (const it of op.items) {
          const item = map[it.itemId];
          if (isVisualItem(item)) {
            const from = Math.max(0, Math.floor(it.fromMs || 0));
            const to = Math.max(from + 200, Math.floor(it.toMs || 0));
            map[it.itemId] = { ...item, display: { from, to } };
            arrangedIds.push(it.itemId);
            changed = true;
          }
        }
      } else if (op.itemIds?.length) {
        const ids = op.itemIds.filter((id) => isVisualItem(map[id]));
        if (ids.length) {
          const durOf = (id: string) => Math.max(0, (map[id].display?.to ?? 0) - (map[id].display?.from ?? 0));
          const total = op.totalMs || ids.reduce((a: number, id: string) => a + durOf(id), 0) || ids.length * 3000;
          const per = Math.max(200, Math.floor(total / ids.length));
          const start = op.startMs || 0;
          ids.forEach((id: string, k: number) => {
            const from = start + k * per;
            map[id] = { ...map[id], display: { from, to: from + per } };
            arrangedIds.push(id);
          });
          changed = true;
        }
      }
      // CATEGORY-ROW CONSOLIDATION. Track membership lives in tracks[].items (items carry no
      // trackId). Group images onto ONE image row and videos onto ANOTHER, above the audio; leave
      // audio / captions / sfx / music rows alone; prune the visual rows we vacated so the timeline
      // ends up clean (like the auto-director output), not a scatter of half-empty rows.
      let tracks = st?.tracks;
      if (changed && arrangedIds.length && op.consolidate !== false && Array.isArray(tracks) && tracks.length) {
        const accepts = (t: any) =>
          Array.isArray(t?.accepts) ? t.accepts.includes("image") || t.accepts.includes("video") : t?.type === "video" || t?.type === "image" || !t?.type;
        const origHeld = (t: any, ids: string[]) =>
          ((st.tracks.find((o: any) => o.id === t.id)?.items) || []).some((id: string) => ids.includes(id));
        const imgs = arrangedIds.filter((id) => map[id]?.type === "image");
        const vids = arrangedIds.filter((id) => map[id]?.type === "video");
        const working: any[] = tracks.map((t: any) => ({ ...t, items: (t.items || []).filter((id: string) => !arrangedIds.includes(id)) }));
        const usedTrackIds = new Set<string>();
        const assign = (ids: string[], label: string) => {
          if (!ids.length) return;
          let track =
            working.find((t) => accepts(t) && !usedTrackIds.has(t.id) && origHeld(t, ids)) ||
            working.find((t) => accepts(t) && !usedTrackIds.has(t.id) && !t.items.length) ||
            working.find((t) => accepts(t) && !usedTrackIds.has(t.id));
          if (!track) {
            track = { id: `vtrack-${label}-${nanoid(6)}`, type: "video", name: label === "image" ? "Images" : "Videos", accepts: ["video", "image"], items: [], magnetic: false, static: false, metadata: {} };
            const audioIdx = working.findIndex((t) => t.type === "audio" || (Array.isArray(t.accepts) && t.accepts.includes("audio")));
            if (audioIdx >= 0) working.splice(audioIdx, 0, track); else working.unshift(track);
          }
          usedTrackIds.add(track.id);
          track.items = [...track.items, ...ids]; // arranged shots in playback order
        };
        assign(imgs, "image");
        assign(vids, "video");
        // prune visual rows we emptied (keep audio/caption/etc even if empty)
        tracks = working.filter((t) => t.items.length > 0 || !accepts(t));
      }
      if (changed) {
        const patch: Record<string, any> = { trackItemsMap: map };
        if (Array.isArray(tracks)) patch.tracks = tracks;
        sm.updateState(patch, { updateHistory: true });
      }
      continue;
    }

    if (op.op === "add") {
      const id = nanoid();
      const from = op.fromMs ?? 0;
      const to = op.toMs ?? from + 5000;
      addedIds.push(id);
      dispatch(ADD_TEXT, {
        payload: {
          ...(TEXT_ADD_PAYLOAD as any),
          id,
          display: { from, to },
          details: { ...(TEXT_ADD_PAYLOAD as any).details, text: op.text || "Text" },
        },
        options: {},
      });
      continue;
    }

    // A short fade IN+OUT on each target clip = a smooth transition between cuts (editable
    // animations — no fragile cross-clip transition objects). target:"all" → every visual.
    if (op.op === "transition") {
      const st = sm?.getState?.();
      const map = st?.trackItemsMap || {};
      const ids = resolveTargets(op, st).filter((id) => map[id] && (map[id].type === "image" || map[id].type === "video"));
      if (ids.length) {
        const anim = { in: fadeComposition(0, 1, "fadeIn"), out: fadeComposition(1, 0, "fadeOut") };
        dispatch(EDIT_OBJECT, { payload: Object.fromEntries(ids.map((id) => [id, { animations: anim }])) });
      }
      continue;
    }

    // EDIT — kenBurns / opacity / volume / speed / text / duration. Now targets ONE item
    // (op.itemId), MANY (op.itemIds), or EVERY visual (op.target:"all") in a SINGLE op — so
    // "add Ken Burns to every clip" applies to ALL of them, not just the last few.
    if (op.op === "edit" && (op.itemId || op.itemIds?.length || op.target)) {
      const st = sm?.getState?.();
      const map = st?.trackItemsMap || {};
      const ids = resolveTargets(op, st).filter((id) => map[id]);
      if (!ids.length) continue;
      const editPayload: Record<string, any> = {};
      if (op.details && Object.keys(op.details).length) editPayload.details = op.details;
      if (op.playbackRate != null) editPayload.playbackRate = op.playbackRate;
      if (Object.keys(editPayload).length) {
        dispatch(EDIT_OBJECT, { payload: Object.fromEntries(ids.map((id) => [id, editPayload])) });
      }
      if (op.durationMs != null && sm) {
        const m = { ...map };
        for (const id of ids) {
          const item = m[id];
          if (item) {
            const from = item.display?.from ?? 0;
            m[id] = { ...item, display: { ...(item.display || {}), from, to: from + Math.max(100, op.durationMs) } };
          }
        }
        sm.updateState({ trackItemsMap: m }, { updateHistory: true });
      }
    }

    // LIPSYNC — the client already computed the alignment (transcribed the video + the timeline audio,
    // matched word-by-word); here we just APPLY it: put the video at the audio span (display), trim it
    // to the matching footage, time-stretch to fit (playbackRate), and mute its own audio.
    if (op.op === "lipsync" && sm && op.itemId) {
      const st = sm.getState?.();
      const map = { ...(st?.trackItemsMap || {}) };
      const item = map[op.itemId];
      if (item) {
        map[op.itemId] = {
          ...item,
          ...(op.display ? { display: { from: Math.max(0, Math.floor(op.display.from)), to: Math.max(0, Math.floor(op.display.to)) } } : {}),
          ...(op.trim ? { trim: { from: Math.max(0, Math.floor(op.trim.from)), to: Math.max(0, Math.floor(op.trim.to)) } } : {}),
          ...(op.playbackRate ? { playbackRate: op.playbackRate } : {}),
          ...(op.mute ? { details: { ...(item.details || {}), volume: 0 } } : {}),
        };
        sm.updateState({ trackItemsMap: map }, { updateHistory: true });
      }
    }

    // MUSIC BED — a full-length, low-volume background track (the client picked `src` from the
    // curated audio library). upsertMusicBed is role-managed: ONE bed, spans the whole timeline,
    // its own row, so it never fights the voiceover.
    if (op.op === "musicbed" && sm && op.src) {
      const st = sm.getState?.();
      if (st) {
        const patch = upsertMusicBed(
          { duration: st.duration, tracks: st.tracks, trackItemIds: st.trackItemIds, trackItemsMap: st.trackItemsMap } as any,
          { src: op.src, volume: op.volume ?? 18 },
        );
        sm.updateState(patch as any, { updateHistory: true });
      }
    }
  }
  return { addedIds };
}

// Which items an op targets: explicit itemId / itemIds, or target:"all" (every image+video) /
// target:"selected" (the current timeline selection). Used by edit + transition so ONE op can hit
// every clip.
function resolveTargets(op: AiEditOp, st: any): string[] {
  const map = st?.trackItemsMap || {};
  const isVisual = (id: string) => { const ty = map[id]?.type; return ty === "image" || ty === "video"; };
  if (op.target === "all") return Object.keys(map).filter(isVisual);
  if (op.target === "selected") return (st?.activeIds || []).filter((id: string) => map[id]);
  if (op.itemIds?.length) return op.itemIds.filter((id: string) => map[id]);
  if (op.itemId) return [op.itemId];
  return [];
}

// ── selection helpers ─────────────────────────────────────────────────────────

export interface SelChip {
  id: string;
  type: string;
  name: string;
  durationMs: number;
  src?: string; // thumbnail (image/video)
}

export function selectionChips(activeIds: string[], map: Record<string, any>): SelChip[] {
  return (activeIds || [])
    .map((id) => {
      const it = map?.[id];
      if (!it) return null;
      const from = it.display?.from ?? 0;
      const to = it.display?.to ?? 0;
      const name =
        it.name ||
        (typeof it.details?.text === "string" ? it.details.text.slice(0, 24) : "") ||
        it.type ||
        id;
      const src = it.type === "image" || it.type === "video" ? it.details?.src || "" : "";
      return { id, type: it.type || "item", name, durationMs: Math.max(0, to - from), src };
    })
    .filter(Boolean) as SelChip[];
}

export function selectionContext(chips: SelChip[]): string {
  if (!chips.length) return "No timeline item is currently selected.";
  return (
    "Currently selected timeline items:\n" +
    chips
      .map((c) => `- id="${c.id}" type=${c.type} name="${c.name}" currentDurationMs=${c.durationMs}`)
      .join("\n")
  );
}

// Whole-project context: every item (ids + durations + text) + the narration/topic
// + total audio length, so the AI can BUILD a full video and make media RELEVANT to
// the content (not literal words like "audio").
export function projectContext(map: Record<string, any>): string {
  const entries = Object.entries(map || {});
  if (!entries.length) return "";
  const lines: string[] = [];
  let topic = "";
  let audioTotal = 0;
  for (const [id, itAny] of entries.slice(0, 60)) {
    const it = itAny as any;
    const type = it.type || "item";
    const from = it.display?.from ?? 0;
    const to = it.display?.to ?? 0;
    const dur = Math.max(0, to - from);
    let txt = "";
    if (type === "audio") {
      txt = it.name || "";
      audioTotal += dur;
      if (txt.length > topic.length) topic = txt;
    } else if (type === "caption" || type === "text") {
      txt = it.details?.text || it.name || "";
      if (txt.length > topic.length) topic = txt;
    } else {
      txt = it.name || "";
    }
    lines.push(`- ${type} id="${id}"${txt ? ` text="${String(txt).slice(0, 60)}"` : ""} duration=${dur}ms`);
  }
  let out = "PROJECT TIMELINE (all items — use these ids for arrange/sequence):\n" + lines.join("\n");
  if (topic) out += `\n\nNARRATION / VIDEO TOPIC (make generated/searched media relevant to THIS): "${topic.slice(0, 300)}"`;
  if (audioTotal) out += `\n\nTotal audio/voiceover duration: ${audioTotal}ms — fit images to this when building the video.`;
  return out;
}

// The voiceover transcribed to timed segments — lets the AI sync each image to the
// exact moment its topic is spoken ("show it WHEN it's said").
export function narrationTimeline(
  segments?: { start: number; end: number; text: string }[]
): string {
  if (!segments?.length) return "";
  const lines = segments
    .slice(0, 60)
    .map((s) => `[${(s.start || 0).toFixed(1)}-${(s.end || 0).toFixed(1)}s] "${(s.text || "").slice(0, 90)}"`)
    .join("\n");
  return `\n\nNARRATION TIMELINE (the voiceover segment-by-segment; times in SECONDS). SYNC each image to the segment whose text it matches:\n${lines}`;
}

const KB_LABEL: Record<string, string> = {
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  panLeft: "Pan left",
  panRight: "Pan right",
  panUp: "Pan up",
  panDown: "Pan down",
  zoomInPanLeft: "Zoom + pan left",
  zoomInPanRight: "Zoom + pan right",
};

export function describeOp(op: AiEditOp): string {
  if (op.op === "delete") return `Delete  (${(op.itemIds || [op.itemId]).filter(Boolean).join(", ")})`;
  if (op.op === "add") return `Add ${op.type || "text"}: "${op.text || ""}"`;
  if (op.op === "fade") return `Fade ${op.mode || "both"}  (${op.itemId})`;
  if (op.op === "transition") return `Transitions (fade)${op.target === "all" ? " on all clips" : op.itemIds?.length ? ` ×${op.itemIds.length}` : ""}`;
  if (op.op === "captions") return `Add word-synced captions`;
  if (op.op === "direct") return `🎬 Make a video: "${(op.topic || op.prompt || "").slice(0, 40)}"${op.durationSec ? ` (~${op.durationSec}s)` : ""}`;
  if (op.op === "arrange") return `Arrange ${op.items?.length || op.itemIds?.length || 0} items${op.totalMs ? ` over ${(op.totalMs / 1000).toFixed(1)}s` : op.items?.length ? " (smart timing)" : ""}`;
  if (op.op === "search") return `Stock ${op.kind || "image"}: "${(op.query || op.prompt || "").slice(0, 30)}" ×${op.count || 1}`;
  if (op.op === "regenerate") return `Edit image (AI): "${(op.prompt || "").slice(0, 40)}"  (${op.itemId})`;
  if (op.op === "animate") return `🎞️ Animate image → video: "${(op.prompt || "subtle motion").slice(0, 40)}"  (${op.itemId})`;
  if (op.op === "generate") return `Generate ${op.kind || "audio"}: "${(op.text || op.prompt || "").slice(0, 40)}"`;
  if (op.op === "edit") {
    const id = op.target === "all" ? "all clips" : op.target === "selected" ? "selection" : op.itemIds?.length ? `${op.itemIds.length} clips` : op.itemId;
    const d = op.details || {};
    if (op.durationMs != null) return `Set duration → ${op.durationMs / 1000}s  (${id})`;
    if (d.kenBurns) return `Motion → ${KB_LABEL[d.kenBurns] || d.kenBurns}  (${id})`;
    if (d.opacity != null) return `Opacity → ${d.opacity}  (${id})`;
    if (d.volume != null) return `Volume → ${d.volume}  (${id})`;
    if (d.text != null) return `Text → "${d.text}"  (${id})`;
    if (d.fontSize != null || d.color != null) return `Style text  (${id})`;
    if (op.playbackRate != null) return `Speed → ${op.playbackRate}x  (${id})`;
    if (Object.keys(d).length) return `Edit ${Object.keys(d).join(", ")}  (${id})`;
  }
  return JSON.stringify(op);
}

// ── snapshot / revert ─────────────────────────────────────────────────────────

export function affectedIds(ops: AiEditOp[]): string[] {
  const ids = new Set<string>();
  for (const op of ops || []) {
    if (op.itemId) ids.add(op.itemId);
    (op.itemIds || []).forEach((i) => ids.add(i));
  }
  return [...ids];
}

export function captureSnapshot(ops: AiEditOp[], map: Record<string, any>): Record<string, any> {
  const snap: Record<string, any> = {};
  for (const id of affectedIds(ops)) {
    snap[id] = map?.[id] ? JSON.parse(JSON.stringify(map[id])) : null;
  }
  return snap;
}

// object entries → restore (edits/fades); null entries → delete (added items).
export function revertSnapshot(snapshot: Record<string, any>): void {
  const sm = getStateManagerRef();
  if (!sm?.getState) return;
  const toDelete: string[] = [];
  const restore: Record<string, any> = {};
  for (const [id, snap] of Object.entries(snapshot)) {
    if (snap) restore[id] = snap;
    else toDelete.push(id);
  }
  if (toDelete.length) dispatch(LAYER_DELETE, { payload: { trackItemIds: toDelete } });
  if (Object.keys(restore).length) {
    const s = sm.getState();
    const map = { ...(s.trackItemsMap || {}) };
    for (const [id, item] of Object.entries(restore)) map[id] = item;
    sm.updateState({ trackItemsMap: map }, { updateHistory: true });
  }
}

// ── capabilities (Features popover) ───────────────────────────────────────────

export const CAPABILITIES: { group: string; items: { label: string; example: string }[] }[] = [
  {
    group: "🎬 Make a whole video (auto-director)",
    items: [
      { label: "Video from a topic", example: "make me a video about the Nazca Lines" },
      { label: "With AI-generated visuals", example: "create a 40 second video about deep sea creatures with generated images" },
    ],
  },
  {
    group: "Motion (Ken Burns)",
    items: [
      { label: "Zoom in", example: "add a slow zoom in on this" },
      { label: "Zoom out", example: "zoom out slowly" },
      { label: "Pan left / right", example: "pan right across this clip" },
    ],
  },
  {
    group: "Effects",
    items: [
      { label: "Fade in/out", example: "fade this in and out" },
      { label: "Opacity", example: "set opacity to 50" },
    ],
  },
  {
    group: "Timing / Audio",
    items: [
      { label: "Set duration", example: "make this clip 3 seconds" },
      { label: "Volume", example: "set volume to 30" },
      { label: "Speed", example: "speed it up to 1.5x" },
      { label: "Delete", example: "delete this clip" },
    ],
  },
  {
    group: "Text",
    items: [
      { label: "Edit text", example: "change the text to 'Hello world'" },
      { label: "Font size / color", example: "make the text bigger and yellow" },
      { label: "Add text overlay", example: "add a title 'The Nazca Lines' for the first 5 seconds" },
    ],
  },
  {
    group: "Generate",
    items: [
      { label: "Voiceover (TTS)", example: "add a voiceover saying 'Welcome back to the channel'" },
      { label: "Generate image", example: "generate a cinematic mountain landscape at golden hour" },
      { label: "Generate video", example: "generate a 5 second drone shot flying over mountains" },
      { label: "Edit image (AI)", example: "regenerate this image with a deep red tint" },
    ],
  },
  {
    group: "Build video",
    items: [
      { label: "Arrange to fit audio", example: "arrange these images across the voiceover into one video" },
      { label: "Sync to script", example: "sync the images to the narration — show each one when it's mentioned" },
      { label: "Add captions", example: "add word-synced captions to the video" },
      { label: "Stock images", example: "find 3 stock images of snowy mountains and add them" },
      { label: "Stock video", example: "add a stock video of city traffic at night" },
    ],
  },
];

// ── LLM prompt + parsing ──────────────────────────────────────────────────────

export const OPS_SYSTEM_PROMPT = `You are the AI editing assistant inside a video timeline editor. The user selects one or more timeline items and gives an instruction. Translate it into a JSON list of operations that the editor applies.

Respond with ONLY a fenced \`\`\`json code block containing exactly:
{ "summary": "<one short sentence>", "operations": [ ...ops... ] }

CONTEXT: A PROJECT TIMELINE and its NARRATION/TOPIC are provided in the user message. When the user refers to "this audio / script / video / topic", generate or search media RELEVANT TO THE NARRATION/TOPIC — never the literal word (e.g. do NOT make images of the word "audio"; make images about what the narration is ABOUT). To build a full video from images, use "arrange" to sequence them across the total audio duration, and consider adding a subtle Ken Burns "zoomIn" to each. If a NARRATION TIMELINE (segments with times) is provided, SYNC images to it: for each image pick the segment whose text best matches the image's content, and set that image's SMART arrange window to that segment's [start×1000, end×1000] ms — so each image appears EXACTLY when the narration mentions it (this is the goal — NOT equal slices).

Supported operations:
- Motion / Ken Burns (this is how zoom & pan work — a real animation the player renders):
    { "op":"edit", "itemId":"<id>", "details": { "kenBurns": "zoomIn", "kenBurnsIntensity": 12 } }
    kenBurns is ONE of: "zoomIn","zoomOut","panLeft","panRight","panUp","panDown","zoomInPanLeft","zoomInPanRight".
    kenBurnsIntensity is 1-40 (subtle→strong; ~12 for a noticeable zoom). To remove motion use "off".
- APPLY TO EVERY CLIP AT ONCE — for "add zoom / Ken Burns / a fade to ALL / every clip", emit ONE op
  with "target":"all" (NEVER one op per clip — that skips clips): { "op":"edit", "target":"all", "details": { "kenBurns": "zoomIn", "kenBurnsIntensity": 12 } }. "target":"selected" = the current selection; or "itemIds":[…] for a specific set. Works for any edit (kenBurns, opacity, speed, durationMs).
- Transition (a smooth fade between cuts): { "op":"transition", "target":"all" }  (or "itemId"/"itemIds"). Use for "add transitions / smooth cuts / crossfade". For a HARD-cut / fast style, do NOT add transitions.
- Fade in / out:  { "op":"fade", "itemId":"<id>", "mode":"both" }   (mode: "in" | "out" | "both")
- Duration (seconds -> ms): { "op":"edit", "itemId":"<id>", "durationMs": 3000 }
- Opacity 0-100:  { "op":"edit", "itemId":"<id>", "details": { "opacity": 50 } }
- Volume 0-100:   { "op":"edit", "itemId":"<id>", "details": { "volume": 30 } }
- Playback speed: { "op":"edit", "itemId":"<id>", "playbackRate": 1.5 }
- Edit text (caption/text item): { "op":"edit", "itemId":"<id>", "details": { "text": "New text" } }
- Font size / color: { "op":"edit", "itemId":"<id>", "details": { "fontSize": 80, "color": "#FFD400" } }
- Delete: { "op":"delete", "itemIds": ["<id>"] }
- Add a text overlay: { "op":"add", "type":"text", "text":"Title", "fromMs":0, "toMs":5000 }
- Generate a voiceover (TTS) — this SPEAKS the text aloud, it is NOT music: { "op":"generate", "kind":"audio", "text":"the narration words to speak about the topic" }   (there is no music generation; kind:audio is always a spoken voiceover — put real narration sentences in "text")
- Generate an IMAGE (SHORT comma-separated keyword prompt) and add it: { "op":"generate", "kind":"image", "prompt":"cinematic mountain landscape, golden hour, 85mm, sharp", "aspect_ratio":"16:9" }
- Generate a VIDEO (LONG descriptive prompt — motion, camera, lighting) and add it: { "op":"generate", "kind":"video", "prompt":"aerial drone shot flying low over misty mountains at sunrise, slow push in, cinematic", "duration":5, "aspect_ratio":"16:9" }
- Edit / regenerate the SELECTED image with AI (img2img — recolor, restyle, alter it): { "op":"regenerate", "itemId":"<id>", "prompt":"the same image but tinted deep red" }   (for images ONLY; "make it red" on an image = this)
- ANIMATE the SELECTED image into a VIDEO (image-to-video — bring a still to life with subtle motion, keeps it in the SAME timeline slot): { "op":"animate", "itemId":"<id>", "prompt":"gentle camera push-in, hair moving in the wind" }   (use when the user says "animate", "make it move", "bring it to life", "turn this into video"; the motion prompt is short — describe the MOTION, not the scene)
- LIP-SYNC a talking-head VIDEO to the timeline audio (transcribes both, matches the spoken words, places + trims the video so its lips match the voiceover): { "op":"lipsync", "target":"selected" }  (or "itemId":"<video id>"; if nothing specified it does every video). Use when the user says "lip sync", "sync the video to the audio", "match lips", "arrange lip sync".
- Arrange / sequence items to BUILD A VIDEO — ALWAYS this ONE form: { "op":"arrange", "target":"all" }
    Use it whenever the user says "arrange", "make a video from these", "sequence them", or you just
    generated/searched several clips to assemble. Do NOT compute or pass any times — the editor OWNS the
    timing: it transcribes the voiceover, plans content-aware windows synced to the narration, places every
    visual gap-free on ONE row, and adds motion. You NEVER emit fromMs/toMs/totalMs/itemIds for an arrange
    (timing is a mechanic, not your decision). For "generate X,Y,Z and arrange into one video" add the
    generate ops PLUS this single arrange op. CRITICAL: media you generate/search in THIS response has no id
    yet — that's fine, "target":"all" needs no ids.
- Search STOCK footage/photos (Pexels) and add: { "op":"search", "kind":"image", "query":"snowy mountains at sunset", "count":3 }   (kind: "image" | "video")
    Use "search" (stock) when the user says "stock", "find", or "footage". Use "generate" (AI) ONLY when they say "generate", "create", or "make an AI …". Keep queries relevant to the narration/topic.
- For a DYNAMIC look, VARY the kenBurns kind across clips (alternate zoomIn / zoomOut / panLeft / panRight) — don't put the same motion on every clip.
- Add word‑synced CAPTIONS / subtitles under the voiceover (uses the narration transcript automatically): { "op":"captions" }   (no itemId needed — it captions the voiceover/audio track)
- MAKE A WHOLE VIDEO FROM A TOPIC — one‑shot auto‑director. When the user asks to "make / create / build me a video about X" FROM SCRATCH (there are NO existing clips to assemble), emit EXACTLY ONE op and nothing else: { "op":"direct", "topic":"<the subject, e.g. the Nazca Lines>", "durationSec":40, "mediaKind":"stock", "captions":true }. The editor then auto‑writes the script, generates the voiceover, plans the shots, adds time‑synced visuals (with Ken Burns) and captions — do NOT add generate/voiceover/arrange/captions ops yourself. Set mediaKind:"image" if the user wants AI‑GENERATED visuals (else "stock" = fast real footage); durationSec from the ask (default 40). Use "direct" ONLY to build a NEW video from a topic — NOT for editing or arranging clips that already exist.

IMPORTANT: For "zoom in/out" or "pan" ALWAYS use the kenBurns fields above — NEVER a CSS transform/scale (the player ignores that).
Rules: use ONLY the itemId values in the selection context (NEVER invent ids). Convert seconds to milliseconds. A "generate" op needs no itemId. If nothing is selected and the request isn't add/generate, return "operations": [] and explain in "summary". Output ONLY the json block.`;

// ─── PIPELINE system prompts ────────────────────────────────────────────────────
// A "pipeline" is just a DIFFERENT system prompt fed to the SAME ops machinery: the LLM
// plans the whole thing and emits generate/arrange ops → the editor builds it on the live
// timeline. No hardcoded steps — control lives entirely in the prompt. The director prompts
// themselves now live in ./editor-config.ts (imported + re-exported at the top of this file).

// Shown in the AI-Edit composer dropdown (top → bottom).
export const PIPELINES: { id: string; label: string }[] = [
  { id: "comic_drama", label: "🎭 Comic Drama" },
  { id: "faceless_video", label: "🎬 Faceless Video" },
];

// VIBE presets — one-click "look & pace" shortcuts. Each is just a STYLE PHRASE injected into the LLM
// prompt (script + look) AND the match_shots timing call (motion + cut pace). NOT a separate engine —
// pure prompt sugar, so the same intelligent system drives it and the user can still type overrides.
export const VIBES: { id: string; label: string; style: string }[] = [
  { id: "", label: "None · default", style: "" },
  { id: "fast_drama", label: "🔥 Fast Drama", style: "fast-paced punchy quick cuts, high tension, aggressive zoom punch-ins, short snappy shots" },
  { id: "cinematic", label: "🎬 Cinematic", style: "slow cinematic, smooth elegant slow zoom-ins, longer holds, moody film-grade lighting" },
  { id: "emotional", label: "💔 Emotional", style: "tender emotional, slow holds on faces, soft gentle zoom-ins, intimate unhurried pacing" },
  { id: "action", label: "💥 Action", style: "high-energy action, hard fast cuts, kinetic aggressive punch-in zooms, relentless pace" },
  { id: "vintage", label: "🎞️ Vintage", style: "vintage film look, warm nostalgic tone, gentle slow pans, soft grain" },
];
export const vibeStyle = (id: string): string => VIBES.find((v) => v.id === id)?.style || "";
export const vibeLabel = (id: string): string => VIBES.find((v) => v.id === id)?.label || "";

export const PIPELINE_PROMPTS: Record<string, string> = {
  comic_drama: COMIC_DRAMA_PROMPT,
  faceless_video: FACELESS_EDIT_PROMPT,
};

export function extractOps(text: string): OpsEnvelope | null {
  if (!text) return null;
  let jsonStr = "";
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    jsonStr = fence[1];
  } else {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s >= 0 && e > s) jsonStr = text.slice(s, e + 1);
  }
  if (!jsonStr.trim()) return null;
  try {
    const obj = JSON.parse(jsonStr);
    if (obj && Array.isArray(obj.operations)) return obj as OpsEnvelope;
  } catch {
    /* ignore */
  }
  return null;
}
