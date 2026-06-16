"use client";
import { useEffect, useRef, useState } from "react";
import { dispatch } from "@designcombo/events";
import { PLAYER_SEEK } from "../constants/events";
import useScriptGuideStore, { ScriptSegment, FontSizeKey, FONT_SIZE_MAP } from "../store/use-script-guide-store";
import useStore from "../store/use-store";
import { useCurrentPlayerFrame } from "../hooks/use-current-frame";
import useCaptionTranscribeStore from "../store/use-caption-transcribe-store";
import useUploadStore from "../store/use-upload-store";
import { getTrackTranscript } from "./transcript-panel";

// ─── Pre-computed alignment map ──────────────────────────────────────────────
// Built ONCE when transcript + script both load. Per-frame cost = binary search O(log n).

type AlignedWord = {
  startSec: number;
  paraIdx: number;
  scriptWordIdx: number;
  segRangeStart: number;
  segRangeEnd: number;
};

function buildWordMap(
  transcript: { segments: { start: number; end: number; text: string; words?: { word: string; start: number; end: number }[] }[] },
  segments: ScriptSegment[],
  safeDisplayFrom: number,
  safeTrimFrom: number,
): AlignedWord[] {
  const map: AlignedWord[] = [];

  for (const ws of transcript.segments) {
    const wsWordList = ws.words?.length ? ws.words : null;
    const wsTokens = (wsWordList ?? ws.text.trim().split(/\s+/).map(w => ({ word: w, start: ws.start, end: ws.end })));
    const wsNorm = wsTokens.map(w => w.word.toLowerCase().replace(/[^a-z]/g, ""));

    // Find the script paragraph with maximum time overlap with this Whisper segment
    let bestParaIdx = -1, bestOverlap = -1;
    segments.forEach((seg, pi) => {
      const pS = ((seg.startMs ?? 0) - safeDisplayFrom + safeTrimFrom) / 1000;
      const pE = ((seg.endMs   ?? 0) - safeDisplayFrom + safeTrimFrom) / 1000;
      const overlap = Math.max(0, Math.min(ws.end, pE) - Math.max(ws.start, pS));
      if (overlap > bestOverlap) { bestOverlap = overlap; bestParaIdx = pi; }
    });
    if (bestParaIdx < 0) continue;

    const para = segments[bestParaIdx];
    const scriptWords = para.text.trim().split(/\s+/);
    const scriptNorm  = scriptWords.map(w => w.toLowerCase().replace(/[^a-z]/g, ""));
    const pS = ((para.startMs ?? 0) - safeDisplayFrom + safeTrimFrom) / 1000;
    const pE = ((para.endMs   ?? 0) - safeDisplayFrom + safeTrimFrom) / 1000;
    const pDur = Math.max(0.001, pE - pS);
    const expectedIdx = Math.round(Math.max(0, Math.min(1, (ws.start - pS) / pDur)) * (scriptWords.length - 1));

    // Sliding window — runs once per Whisper segment, not per frame
    let bestScore = 0, bestSi = expectedIdx;
    for (let si = 0; si < scriptNorm.length; si++) {
      let score = 0;
      for (let wi = 0; wi < wsNorm.length && si + wi < scriptNorm.length; wi++) {
        if (wsNorm[wi].length >= 2 && wsNorm[wi] === scriptNorm[si + wi]) score++;
      }
      const better = score > bestScore ||
        (score === bestScore && score > 0 && Math.abs(si - expectedIdx) < Math.abs(bestSi - expectedIdx));
      if (better) { bestScore = score; bestSi = si; }
    }

    const segRangeStart = bestSi;
    const segRangeEnd   = Math.min(scriptWords.length - 1, bestSi + wsNorm.length - 1);

    // Map each Whisper word → script word index
    wsTokens.forEach((w, wi) => {
      let scriptWordIdx: number;
      if (bestScore >= 2) {
        const frac = wsNorm.length > 1 ? wi / (wsNorm.length - 1) : 0;
        scriptWordIdx = Math.round(segRangeStart + frac * (segRangeEnd - segRangeStart));
      } else {
        const wn = wsNorm[wi];
        if (wn.length >= 3) {
          let bi = expectedIdx, bd = Infinity;
          for (let i = 0; i < scriptNorm.length; i++) {
            if (scriptNorm[i] === wn && Math.abs(i - expectedIdx) < bd) { bd = Math.abs(i - expectedIdx); bi = i; }
          }
          scriptWordIdx = bi;
        } else {
          const frac = wsNorm.length > 1 ? wi / (wsNorm.length - 1) : 0;
          scriptWordIdx = Math.round(segRangeStart + frac * Math.max(0, segRangeEnd - segRangeStart));
        }
      }
      map.push({
        startSec: w.start,
        paraIdx: bestParaIdx,
        scriptWordIdx: Math.max(0, Math.min(scriptWords.length - 1, scriptWordIdx)),
        segRangeStart,
        segRangeEnd,
      });
    });
  }

  map.sort((a, b) => a.startSec - b.startSec);
  return map;
}

// Binary search: last entry where startSec <= t
function findWord(map: AlignedWord[], t: number): AlignedWord | null {
  let lo = 0, hi = map.length - 1, result: AlignedWord | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid].startSec <= t) { result = map[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result;
}
// ─────────────────────────────────────────────────────────────────────────────

const getVappParams = () => {
  if (typeof window === "undefined") return { vappHost: "", token: "", baseUrl: "" };
  const p = new URLSearchParams(window.location.search);
  return {
    vappHost: p.get("vappHost") || `${window.location.protocol}//${window.location.hostname}`,
    token: p.get("token") || "",
    baseUrl: p.get("baseUrl") || "https://api.muapi.ai",
  };
};

const EXAMPLE_JSON = `[
  {
    "type": "avatar",
    "time": "0:00 - 0:05",
    "text": "What if one of the simplest health habits was not a new diet... not an expensive supplement... and not a hard workout?",
    "note": "Intense eye contact, lean slightly forward, pause after each '...'",
    "mark": "hook"
  },
  {
    "type": "avatar",
    "time": "0:05 - 0:20",
    "text": "It could be something as basic as walking for a few minutes after eating. Most people finish a meal and sit down immediately. But your body may actually work better when you move gently after food.",
    "note": "Slow reveal, calm tone, let last sentence land",
    "mark": "open-loop"
  },
  {
    "type": "broll",
    "time": "0:20 - 1:00",
    "text": "After you eat, your body starts breaking food into energy. Carbohydrates turn into glucose, and that glucose enters your blood. If you sit for a long time, your blood sugar may rise more sharply. But when you walk, your muscles start using some of that glucose for movement.",
    "note": "Calm voiceover pace, no rush, visual matches science explanation",
    "search": ["healthy meal plate", "blood sugar diagram", "walking after eating", "digestion animation", "glucose body"],
    "mark": "context-build"
  },
  {
    "type": "avatar",
    "time": "1:00 - 1:20",
    "text": "Now here is the part many people miss... you do not need to walk fast. You do not need to sweat. And you do not need to go to the gym.",
    "note": "Slight pause before 'miss', stronger tone, point finger lightly",
    "mark": "pattern-interrupt"
  },
  {
    "type": "broll",
    "time": "1:20 - 2:00",
    "text": "Think about dinner. You eat rice, bread, pasta, potatoes, or something sweet... and then you lie down or sit on the sofa. That is when many people feel heavy, sleepy, bloated, or lazy. A short walk after the meal can help reduce that heavy feeling and keep your body active while digestion begins.",
    "note": "Relatable scene — show couch, heavy food, evening setting",
    "search": ["dinner table family", "sofa after eating", "bloated feeling", "evening walk", "digestion health"],
    "mark": "context-build"
  },
  {
    "type": "avatar",
    "time": "2:00 - 2:20",
    "text": "Start small. After lunch or dinner, walk for ten minutes. If ten minutes feels too much, start with five. Walk slowly. Keep your breathing normal.",
    "note": "Friendly, encouraging tone — like talking to a friend",
    "mark": "payoff"
  },
  {
    "type": "broll",
    "time": "2:20 - 2:45",
    "text": "But here is the warning... walking after meals is not a magic cure. It will not cancel overeating. It will not fix a poor diet overnight. And if you have diabetes, heart problems, dizziness, or any medical condition, you should follow your doctor's advice first.",
    "note": "Serious tone in voiceover, show doctor or calm advisory visual",
    "search": ["doctor advice", "healthy warning", "medical disclaimer", "healthy lifestyle balance"],
    "mark": "pattern-interrupt"
  },
  {
    "type": "broll",
    "time": "2:45 - 3:00",
    "text": "Small habit... real benefit... and it starts with your next meal.",
    "note": "Final hopeful shot — couple walking, golden hour, calm music fade",
    "search": ["couple walking sunset", "healthy routine", "calm walk outdoor", "wellness motivation"],
    "mark": "cta"
  }
]`;

const MARK_CONFIG: Record<string, { label: string; color: string }> = {
  hook:               { label: "🎣 HOOK",          color: "#f87171" },
  "open-loop":        { label: "◎ OPEN LOOP",       color: "#60a5fa" },
  "context-build":    { label: "▸ CONTEXT",         color: "#4ade80" },
  "pattern-interrupt":{ label: "⚡ PATTERN BREAK",  color: "#fbbf24" },
  payoff:             { label: "✓ PAYOFF",           color: "#22d3ee" },
  "retention-peak":   { label: "★ RETENTION",        color: "#a78bfa" },
  cta:                { label: "★ CTA",              color: "#c084fc" },
};

function MarkBadge({ mark, fontSize = 8 }: { mark: string; fontSize?: number }) {
  const cfg = MARK_CONFIG[mark];
  const label = cfg?.label ?? mark.toUpperCase();
  const color = cfg?.color ?? "#888";
  return (
    <span
      style={{
        fontSize,
        fontWeight: 700,
        letterSpacing: "0.06em",
        padding: "1px 5px",
        borderRadius: 4,
        color,
        background: `${color}22`,
        border: `1px solid ${color}44`,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function ScriptBlock({
  seg,
  isActive,
  onClick,
  fontSize,
  highlightWordIdx = -1,
  segRangeStart = -1,
  segRangeEnd = -1,
}: {
  seg: ScriptSegment;
  isActive: boolean;
  onClick: () => void;
  fontSize: number;
  highlightWordIdx?: number;
  segRangeStart?: number;
  segRangeEnd?: number;
}) {
  const isAvatar = seg.type === "avatar";
  const borderColor = isAvatar
    ? isActive ? "#8b5cf6" : "#6d28d955"
    : isActive ? "#d97706" : "#d9770655";
  const metaSize = Math.max(8, fontSize - 3);

  const renderWords = () => {
    if (!isActive || highlightWordIdx < 0) {
      return (
        <span className={isActive ? "text-foreground" : "text-foreground/35"}>
          {seg.text}
        </span>
      );
    }
    const words = seg.text.trim().split(/\s+/);
    const inSeg = (wi: number) => segRangeStart >= 0 && wi >= segRangeStart && wi <= segRangeEnd;
    return words.map((word, wi) => (
      <span
        key={wi}
        className={`transition-colors ${
          wi === highlightWordIdx
            ? "rounded-sm bg-violet-500 px-0.5 text-white"
            : inSeg(wi)
            ? "text-foreground/90 underline decoration-violet-400/50 underline-offset-2"
            : wi < highlightWordIdx
            ? "text-foreground/45"
            : "text-foreground/20"
        }`}
      >
        {word}{wi < words.length - 1 ? " " : ""}
      </span>
    ));
  };

  return (
    <div
      onClick={onClick}
      className={`mb-1.5 cursor-pointer rounded-r-md py-1 pr-2 transition-colors ${
        isActive
          ? isAvatar ? "bg-violet-500/10" : "bg-amber-500/10"
          : "hover:bg-card/40"
      }`}
      style={{ borderLeft: `2px solid ${borderColor}`, paddingLeft: 8 }}
    >
      {/* font-semibold lives here for avatar — all word spans inherit it, no per-word toggling */}
      <div style={{ fontSize }} className={`leading-snug ${isAvatar ? "font-semibold" : ""}`}>
        {renderWords()}
      </div>

      {/* Meta row: dot · time · [mark] · note · keywords */}
      <div className="mt-0.5 flex flex-wrap items-center gap-1" style={{ fontSize: metaSize }}>
        <div
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: isAvatar ? "#7c3aed" : "#d97706" }}
        />
        <span className="font-mono text-muted-foreground/50" style={{ letterSpacing: "0.05em" }}>
          {seg.time}
        </span>
        {seg.mark && <MarkBadge mark={seg.mark} fontSize={metaSize} />}
        {seg.note && (
          <span className="italic text-muted-foreground/40">{seg.note}</span>
        )}
        {seg.search?.map((kw, i) => (
          <span
            key={i}
            style={{
              fontSize: metaSize,
              background: "rgba(217,119,6,0.12)",
              border: "1px solid rgba(217,119,6,0.25)",
              padding: "1px 5px",
              borderRadius: 4,
            }}
            className="text-amber-600 dark:text-amber-400"
          >
            {kw}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function ScriptGuidePanel() {
  const {
    segments,
    rawJson,
    isOpen,
    isFullscreen,
    floatPos,
    panelSize,
    isCollapsed,
    showInput,
    activeSegmentIndex,
    fontSizeKey,
    setSegments,
    clearSegments,
    setOpen,
    setFullscreen,
    setFloatPos,
    setPanelSize,
    setCollapsed,
    setShowInput,
    setActiveSegment,
    setFontSizeKey,
  } = useScriptGuideStore();

  const fontSize = FONT_SIZE_MAP[fontSizeKey];

  const { playerRef, fps, trackItemsMap } = useStore();
  const { resultsByMedia, setTranscriptResult } = useCaptionTranscribeStore();
  const { uploads } = useUploadStore();
  const currentFrame = useCurrentPlayerFrame(playerRef || null);
  const currentTimeMs = currentFrame * (1000 / (fps || 30));

  // Find the video/audio clip currently under the playhead — no clip selection required.
  // This means the Script panel keeps working even when the user clicks on it (deselecting clips).
  const allItems = Object.values(trackItemsMap) as any[];
  const atCurrentTime = (item: any) => {
    const from = Number(item.display?.from ?? 0);
    const to   = Number(item.display?.to   ?? 0);
    return to > 0 && currentTimeMs >= from && currentTimeMs <= to;
  };
  const playingClip: any =
    allItems.find(i => i.type === "video" && atCurrentTime(i)) ??
    allItems.find(i => i.type === "audio" && atCurrentTime(i)) ??
    null;

  const mediaSrc = String(playingClip?.details?.src || "").trim();
  let transcript = getTrackTranscript(playingClip, resultsByMedia);
  if (!transcript && mediaSrc) {
    const match = (uploads as any[]).find(u => (u.metadata?.uploadedUrl || u.url || "") === mediaSrc);
    if (match?.stt?.segments?.length) transcript = match.stt;
  }
  const safeDisplayFrom = Number(playingClip?.display?.from ?? 0);
  const safeTrimFrom    = Number(playingClip?.trim?.from    ?? 0);
  // Clip-relative time in seconds (same formula as transcript-panel.tsx)
  const mediaTimeSec = (currentTimeMs - safeDisplayFrom + safeTrimFrom) / 1000;

  // Auto-fetch transcript for the clip under the playhead
  useEffect(() => {
    if (!mediaSrc || transcript) return;
    const isVappMedia = mediaSrc.includes("rpublic.tomtap.ai") || mediaSrc.includes("/api/proxy?url=");
    if (!isVappMedia) return;
    const { vappHost, token, baseUrl } = getVappParams();
    fetch(
      `${vappHost}/api/vapp/stt?token=${encodeURIComponent(token)}&baseUrl=${encodeURIComponent(baseUrl)}&url=${encodeURIComponent(mediaSrc)}`
    )
      .then(r => r.json())
      .then(data => { if (data?.stt?.segments?.length) setTranscriptResult(mediaSrc, data.stt); })
      .catch(() => {});
  }, [mediaSrc]);

  const [jsonInput, setJsonInput] = useState(rawJson);
  const [parseError, setParseError] = useState("");

  const activeSegmentRef = useRef<HTMLDivElement | null>(null);
  const wordMapRef = useRef<AlignedWord[]>([]);

  // Rebuild alignment map whenever transcript or script changes — O(segments × paraWords) once
  useEffect(() => {
    if (!transcript?.segments?.length || !segments.length) { wordMapRef.current = []; return; }
    wordMapRef.current = buildWordMap(transcript, segments, safeDisplayFrom, safeTrimFrom);
  }, [transcript, segments, safeDisplayFrom, safeTrimFrom]);
  const dragRef = useRef<{ dragging: boolean; startX: number; startY: number; originX: number; originY: number }>({
    dragging: false, startX: 0, startY: 0, originX: 0, originY: 0,
  });
  const resizeRef = useRef<{ resizing: boolean; startX: number; startY: number; originW: number; originH: number }>({
    resizing: false, startX: 0, startY: 0, originW: 300, originH: 500,
  });
  const resizeLeftRef = useRef<{ resizing: boolean; startX: number; originW: number; originX: number }>({
    resizing: false, startX: 0, originW: 300, originX: 0,
  });

  // Active PARAGRAPH detection — script times are absolute timeline ms (treated as-is)
  useEffect(() => {
    if (!segments.length) return;
    const idx = segments.findIndex(
      (s) => s.startMs !== undefined && s.endMs !== undefined &&
        currentTimeMs >= s.startMs && currentTimeMs <= s.endMs
    );
    setActiveSegment(idx);
  }, [currentTimeMs, segments]);

  // Auto-scroll active paragraph into view
  useEffect(() => {
    if (activeSegmentRef.current) {
      activeSegmentRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeSegmentIndex]);

  // Per-frame: binary search pre-computed map — O(log n)
  let highlightWordIdx = -1;
  let segRangeStart = -1;
  let segRangeEnd = -1;

  if (activeSegmentIndex >= 0 && activeSegmentIndex < segments.length) {
    const entry = findWord(wordMapRef.current, mediaTimeSec);
    if (entry && entry.paraIdx === activeSegmentIndex) {
      highlightWordIdx = entry.scriptWordIdx;
      segRangeStart    = entry.segRangeStart;
      segRangeEnd      = entry.segRangeEnd;
    } else {
      // Fallback: time fraction (no transcript or between clips)
      const seg = segments[activeSegmentIndex];
      const wc  = seg.text.trim().split(/\s+/).length;
      const p0  = ((seg.startMs ?? 0) - safeDisplayFrom + safeTrimFrom) / 1000;
      const p1  = ((seg.endMs   ?? 0) - safeDisplayFrom + safeTrimFrom) / 1000;
      const dur = Math.max(0.001, p1 - p0);
      const el  = Math.max(0, Math.min(dur, mediaTimeSec - p0));
      highlightWordIdx = Math.min(wc - 1, Math.floor((el / dur) * wc));
    }
  }

  useEffect(() => {
    if (!isOpen) return;
    const onMove = (e: MouseEvent) => {
      if (dragRef.current.dragging) {
        setFloatPos({
          x: Math.max(0, dragRef.current.originX + e.clientX - dragRef.current.startX),
          y: Math.max(0, dragRef.current.originY + e.clientY - dragRef.current.startY),
        });
      }
      if (resizeRef.current.resizing) {
        setPanelSize({
          width: Math.max(220, resizeRef.current.originW + e.clientX - resizeRef.current.startX),
          height: Math.max(200, resizeRef.current.originH + e.clientY - resizeRef.current.startY),
        });
      }
      if (resizeLeftRef.current.resizing) {
        const delta = e.clientX - resizeLeftRef.current.startX;
        const newW = Math.max(220, resizeLeftRef.current.originW - delta);
        setFloatPos({ x: resizeLeftRef.current.originX + (resizeLeftRef.current.originW - newW), y: floatPos.y });
        setPanelSize({ width: newW, height: panelSize.height });
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
  }, [isOpen]);

  const startDrag = (e: React.MouseEvent) => {
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, originX: floatPos.x, originY: floatPos.y };
  };

  const startResize = (e: React.MouseEvent) => {
    e.stopPropagation();
    resizeRef.current = { resizing: true, startX: e.clientX, startY: e.clientY, originW: panelSize.width, originH: panelSize.height };
  };

  const handleParse = () => {
    setParseError("");
    try {
      const parsed = JSON.parse(jsonInput);
      const arr: ScriptSegment[] = Array.isArray(parsed) ? parsed : parsed.segments;
      if (!Array.isArray(arr) || !arr.length) throw new Error("Expected an array of segments");
      arr.forEach((s, i) => {
        if (!s.type || !s.time || !s.text) throw new Error(`Segment ${i + 1} missing type, time, or text`);
      });
      setSegments(arr, jsonInput);
    } catch (err: any) {
      setParseError(err.message || "Invalid JSON");
    }
  };

  const seekToSegment = (seg: ScriptSegment) => {
    if (seg.startMs === undefined) return;
    // If we have a real transcript, find the Whisper segment closest to the paragraph's
    // estimated start and seek to its REAL clip-relative start time → more accurate than estimate
    if (transcript?.segments?.length) {
      const paraStartSec = seg.startMs / 1000;
      let best = transcript.segments[0];
      let bestDist = Math.abs(best.start - paraStartSec);
      for (const ws of transcript.segments) {
        const d = Math.abs(ws.start - paraStartSec);
        if (d < bestDist) { best = ws; bestDist = d; }
      }
      const realTimeMs = safeDisplayFrom - safeTrimFrom + best.start * 1000;
      dispatch(PLAYER_SEEK, { payload: { time: realTimeMs } });
      return;
    }
    // Fallback: script paragraph estimated time (treated as absolute timeline ms)
    dispatch(PLAYER_SEEK, { payload: { time: seg.startMs } });
  };

  if (!isOpen) return null;

  const panelStyle: React.CSSProperties = isFullscreen
    ? { position: "fixed", left: 0, top: 0, width: "100vw", height: "100vh", zIndex: 9999, overflow: "visible" }
    : { position: "fixed", left: floatPos.x, top: floatPos.y, width: panelSize.width, zIndex: 9999, overflow: "visible" };

  return (
    <div
      className="rounded-2xl border-2 border-violet-500/40 bg-background shadow-xl"
      style={panelStyle}
    >
      {/* Header — drag handle (double-click = fullscreen) */}
      <div
        onMouseDown={!isFullscreen ? startDrag : undefined}
        onDoubleClick={() => setFullscreen(!isFullscreen)}
        className={`flex select-none items-center justify-between rounded-t-2xl border-b-2 border-violet-500/30 bg-card px-3 py-2 overflow-hidden ${!isFullscreen ? "cursor-grab" : "cursor-default"}`}
      >
        <div className="flex items-center gap-2">
          <div className="grid grid-cols-2 gap-[3px]">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-[3px] w-[3px] rounded-full bg-muted-foreground/30" />
            ))}
          </div>
          <span className="text-[11px] font-medium text-foreground">Guided Script</span>
          {segments.length > 0 && (
            <span className="text-[11px] text-muted-foreground">{segments.length} paragraphs</span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {segments.length > 0 && (
            <button
              onClick={() => setShowInput(!showInput)}
              className="rounded px-2 py-0.5 text-[9px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {showInput ? "Hide JSON" : "Edit JSON"}
            </button>
          )}
          {/* Font size S/M/L */}
          <div className="flex items-center rounded-full border border-border overflow-hidden">
            {(["S","M","L"] as FontSizeKey[]).map((k) => (
              <button
                key={k}
                onClick={() => setFontSizeKey(k)}
                className={`px-1.5 py-0.5 text-[9px] font-semibold transition-colors ${
                  fontSizeKey === k
                    ? "bg-violet-500/20 text-violet-600 dark:text-violet-300"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {k}
              </button>
            ))}
          </div>
          <button
            onClick={() => { setJsonInput(EXAMPLE_JSON); setShowInput(true); setCollapsed(false); }}
            className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[9px] font-bold text-muted-foreground hover:bg-violet-500/20 hover:text-violet-500"
            title="Load example JSON"
          >
            E
          </button>
          <button
            onClick={() => setFullscreen(!isFullscreen)}
            className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[9px] text-muted-foreground hover:bg-violet-500/20 hover:text-violet-500"
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? "⊡" : "⊞"}
          </button>
          <button
            onClick={() => setCollapsed(!isCollapsed)}
            className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[9px] text-muted-foreground hover:text-foreground"
          >
            {isCollapsed ? "+" : "—"}
          </button>
          <button
            onClick={() => setOpen(false)}
            className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[9px] text-muted-foreground hover:bg-red-500/20 hover:text-red-500"
          >
            ✕
          </button>
        </div>
      </div>

      {!isCollapsed && (
        <div
          className="overflow-y-auto rounded-b-2xl p-3"
          style={{ height: isFullscreen ? "calc(100vh - 40px)" : panelSize.height }}
        >
          {showInput && (
            <div className="mb-3">
              <textarea
                value={jsonInput}
                onChange={(e) => setJsonInput(e.target.value)}
                placeholder={`Paste Guided Script JSON here...\n\n[\n  {\n    "type": "avatar",\n    "time": "0:00 - 0:20",\n    "text": "...",\n    "mark": "hook"\n  }\n]`}
                className={`h-28 w-full resize-y rounded-lg bg-muted/50 p-2 font-mono text-[10px] text-foreground outline-none placeholder:text-muted-foreground/40 ${
                  parseError ? "border border-red-500/60" : "border border-border"
                }`}
              />
              {parseError && (
                <p className="mt-1 text-[10px] text-red-500">{parseError}</p>
              )}
              <div className="mt-1.5 flex gap-1.5">
                <button
                  onClick={handleParse}
                  className="flex-1 rounded-lg bg-violet-500/20 py-1.5 text-[11px] font-semibold text-violet-600 transition hover:bg-violet-500/30 dark:text-violet-300"
                >
                  Parse Script
                </button>
                {segments.length > 0 && (
                  <button
                    onClick={clearSegments}
                    className="rounded-lg bg-muted px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}

          {segments.length > 0 && (
            <div>
              {segments.map((seg, i) => {
                const isActive = activeSegmentIndex === i;
                return (
                  <div key={i} ref={isActive ? activeSegmentRef : null}>
                    <ScriptBlock
                      seg={seg}
                      isActive={isActive}
                      onClick={() => seekToSegment(seg)}
                      fontSize={fontSize}
                      highlightWordIdx={isActive ? highlightWordIdx : -1}
                      segRangeStart={isActive ? segRangeStart : -1}
                      segRangeEnd={isActive ? segRangeEnd : -1}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {segments.length === 0 && !showInput && (
            <p className="py-4 text-center text-[11px] text-muted-foreground">No script loaded</p>
          )}
        </div>
      )}

      {/* Left edge — width resize */}
      <div
        onMouseDown={(e) => { e.stopPropagation(); resizeLeftRef.current = { resizing: true, startX: e.clientX, originW: panelSize.width, originX: floatPos.x }; }}
        className="absolute top-0 bottom-0 cursor-ew-resize"
        style={{ left: -4, width: 8, zIndex: 10 }}
      />
      {/* Right edge — width resize */}
      <div
        onMouseDown={(e) => { e.stopPropagation(); resizeRef.current = { resizing: true, startX: e.clientX, startY: e.clientY, originW: panelSize.width, originH: panelSize.height }; }}
        className="absolute top-0 bottom-0 cursor-ew-resize"
        style={{ right: -4, width: 8, zIndex: 10 }}
      />
      {/* Bottom-right corner — both */}
      <div
        onMouseDown={startResize}
        className="absolute cursor-se-resize"
        style={{ right: -4, bottom: -4, width: 16, height: 16, zIndex: 11 }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" style={{ position: "absolute", right: 4, bottom: 4 }} className="text-muted-foreground/40">
          <path d="M9 3 L3 9 M9 6 L6 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </div>
    </div>
  );
}
