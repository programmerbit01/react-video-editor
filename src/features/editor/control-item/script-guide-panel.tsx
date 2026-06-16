"use client";
import { useEffect, useRef, useState } from "react";
import { dispatch } from "@designcombo/events";
import { PLAYER_SEEK } from "../constants/events";
import useScriptGuideStore, { ScriptSegment, FontSizeKey, FONT_SIZE_MAP } from "../store/use-script-guide-store";
import useStore from "../store/use-store";
import { useCurrentPlayerFrame } from "../hooks/use-current-frame";

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

function MarkBadge({ mark }: { mark: string }) {
  const cfg = MARK_CONFIG[mark];
  const label = cfg?.label ?? mark.toUpperCase();
  const color = cfg?.color ?? "#888";
  return (
    <span
      style={{
        fontSize: 8,
        fontWeight: 700,
        letterSpacing: "0.07em",
        padding: "2px 6px",
        borderRadius: 4,
        color,
        background: `${color}22`,
        border: `1px solid ${color}44`,
        whiteSpace: "nowrap",
        marginLeft: "auto",
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
}: {
  seg: ScriptSegment;
  isActive: boolean;
  onClick: () => void;
  fontSize: number;
}) {
  const isAvatar = seg.type === "avatar";
  const borderColor = isAvatar
    ? isActive ? "#8b5cf6" : "#6d28d955"
    : isActive ? "#d97706" : "#d9770655";

  return (
    <div
      onClick={onClick}
      className={`mb-4 cursor-pointer rounded-r-lg py-2 pr-2 transition-colors ${
        isActive
          ? isAvatar ? "bg-violet-500/10" : "bg-amber-500/10"
          : "hover:bg-card/40"
      }`}
      style={{ borderLeft: `2px solid ${borderColor}`, paddingLeft: 10 }}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <div
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: isAvatar ? "#7c3aed" : "#d97706" }}
        />
        <span className="font-mono text-[9px] tracking-wider text-muted-foreground/60">
          {seg.time}
        </span>
        {seg.mark && <MarkBadge mark={seg.mark} />}
      </div>

      <div
        style={{ fontSize }}
        className={`leading-relaxed ${
          isAvatar ? "font-semibold text-foreground" : "font-normal text-foreground/60"
        }`}
      >
        {seg.text}
      </div>

      {seg.note && (
        <div className="mt-1 text-[10px] italic leading-snug text-muted-foreground/50">
          {seg.note}
        </div>
      )}

      {seg.search && seg.search.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {seg.search.map((kw, i) => (
            <span
              key={i}
              style={{ background: "rgba(217,119,6,0.12)", border: "1px solid rgba(217,119,6,0.25)" }}
              className="rounded px-1.5 py-0.5 text-[9px] text-amber-600 dark:text-amber-400"
            >
              {kw}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ScriptGuidePanel() {
  const {
    segments,
    rawJson,
    isOpen,
    floatPos,
    panelSize,
    isCollapsed,
    showInput,
    activeSegmentIndex,
    fontSizeKey,
    setSegments,
    clearSegments,
    setOpen,
    setFloatPos,
    setPanelSize,
    setCollapsed,
    setShowInput,
    setActiveSegment,
    setFontSizeKey,
  } = useScriptGuideStore();

  const fontSize = FONT_SIZE_MAP[fontSizeKey];

  const { playerRef, fps } = useStore();
  const currentFrame = useCurrentPlayerFrame(playerRef || null);
  const currentTimeMs = currentFrame * (1000 / (fps || 30));

  const [jsonInput, setJsonInput] = useState(rawJson);
  const [parseError, setParseError] = useState("");

  const dragRef = useRef<{ dragging: boolean; startX: number; startY: number; originX: number; originY: number }>({
    dragging: false, startX: 0, startY: 0, originX: 0, originY: 0,
  });
  const resizeRef = useRef<{ resizing: boolean; startX: number; startY: number; originW: number; originH: number }>({
    resizing: false, startX: 0, startY: 0, originW: 300, originH: 500,
  });
  const resizeLeftRef = useRef<{ resizing: boolean; startX: number; originW: number; originX: number }>({
    resizing: false, startX: 0, originW: 300, originX: 0,
  });

  useEffect(() => {
    if (!segments.length) return;
    const idx = segments.findIndex(
      (s) => s.startMs !== undefined && s.endMs !== undefined &&
        currentTimeMs >= s.startMs && currentTimeMs <= s.endMs
    );
    setActiveSegment(idx);
  }, [currentTimeMs, segments]);

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
    dispatch(PLAYER_SEEK, { payload: { time: seg.startMs } });
  };

  if (!isOpen) return null;

  return (
    <div
      className="rounded-2xl border border-border bg-background shadow-lg"
      style={{ position: "fixed", left: floatPos.x, top: floatPos.y, width: panelSize.width, zIndex: 9999, overflow: "visible" }}
    >
      {/* Header — drag handle */}
      <div
        onMouseDown={startDrag}
        className="flex cursor-grab select-none items-center justify-between rounded-t-2xl border-b border-border bg-card px-3 py-2 overflow-hidden"
      >
        <div className="flex items-center gap-2">
          <div className="grid grid-cols-2 gap-[3px]">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-[3px] w-[3px] rounded-full bg-muted-foreground/30" />
            ))}
          </div>
          <span className="text-[11px] font-medium text-foreground">Guided Script</span>
          {segments.length > 0 && (
            <span className="text-[11px] text-muted-foreground">{segments.length} segments</span>
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
        <div className="overflow-y-auto rounded-b-2xl p-3" style={{ height: panelSize.height }}>
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
              {segments.map((seg, i) => (
                <ScriptBlock
                  key={i}
                  seg={seg}
                  isActive={activeSegmentIndex === i}
                  onClick={() => seekToSegment(seg)}
                  fontSize={fontSize}
                />
              ))}
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
