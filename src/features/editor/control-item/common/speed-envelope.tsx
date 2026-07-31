import { useEffect, useMemo, useRef, useState } from "react";
import {
  SpeedKeyframe,
  normalizeSpeedKeyframes,
  sampleSpeed,
} from "../../utils/speed-envelope";

// Speed-ramp editor — INDEPENDENT of the volume envelope (own file, own colour) so it can't break
// it and is easy to debug alone. Drag a point UP = faster, DOWN = slower, sideways = move in time;
// click to add a point, double-click to remove. Under the hood the curve is sampled into a few
// constant-speed zones (see utils/speed-envelope.ts) — the clip stays ONE clip. Commits only on
// release so the store isn't spammed mid-drag. A flat 1× line means "no ramp" → clears to [].

const W = 260;
const H = 104;
const PADX = 6;
const YT = 8;
const YB = 92;
const X0 = PADX;
const X1 = W - PADX;

// Visible speed range on the plot. 1× is drawn as a reference line where it lands.
const SMIN = 0.25;
const SMAX = 3;

const DEFAULT: SpeedKeyframe[] = [
  { t: 0, s: 1 },
  { t: 1, s: 1 },
];

const tToX = (t: number) => X0 + t * (X1 - X0);
const xToT = (x: number) => Math.max(0, Math.min(1, (x - X0) / (X1 - X0)));
const sToY = (s: number) => YB - ((Math.max(SMIN, Math.min(SMAX, s)) - SMIN) / (SMAX - SMIN)) * (YB - YT);
const yToS = (y: number) => Math.max(SMIN, Math.min(SMAX, SMIN + ((YB - y) / (YB - YT)) * (SMAX - SMIN)));

const SpeedEnvelope = ({
  value,
  onChange,
}: {
  value?: SpeedKeyframe[];
  onChange: (kf: SpeedKeyframe[]) => void;
}) => {
  const [pts, setPts] = useState<SpeedKeyframe[]>(() => {
    const n = normalizeSpeedKeyframes(value);
    return n.length >= 2 ? n : DEFAULT;
  });
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);

  useEffect(() => {
    const n = normalizeSpeedKeyframes(value);
    if (drag.current == null) setPts(n.length >= 2 ? n : DEFAULT);
  }, [value]);

  // Commit — a flat 1× line means "no ramp", so send [] to clear it (player falls back to the
  // constant Speed slider). Rounded so a hair of drag noise doesn't count as "varying".
  const commit = (next: SpeedKeyframe[]) => {
    const flat = next.length >= 2 && next.every((p) => Math.abs(p.s - 1) < 1e-2);
    onChange(flat ? [] : next.map((p) => ({ t: Math.round(p.t * 1000) / 1000, s: Math.round(p.s * 1000) / 1000 })));
  };

  const evt = (e: React.PointerEvent | PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * W,
      y: ((e.clientY - r.top) / r.height) * H,
    };
  };

  const onDotDown = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    drag.current = i;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    if (drag.current == null) return;
    const i = drag.current;
    const { x, y } = evt(e);
    setPts((prev) => {
      const next = prev.map((p) => ({ ...p }));
      next[i].s = yToS(y);
      if (i > 0 && i < next.length - 1) {
        const lo = next[i - 1].t + 0.01;
        const hi = next[i + 1].t - 0.01;
        next[i].t = Math.max(lo, Math.min(hi, xToT(x)));
      }
      return next;
    });
  };

  const onUp = () => {
    if (drag.current == null) return;
    drag.current = null;
    setPts((p) => {
      commit(p);
      return p;
    });
  };

  const onPlotDown = (e: React.PointerEvent) => {
    const { x } = evt(e);
    const t = xToT(x);
    setPts((prev) => {
      const s = sampleSpeed(prev, t);
      const next = [...prev, { t, s }].sort((a, b) => a.t - b.t);
      commit(next);
      return next;
    });
  };

  const onDotDouble = (i: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (i === 0 || i === pts.length - 1) return; // keep the two ends
    setPts((prev) => {
      const next = prev.filter((_, k) => k !== i);
      commit(next);
      return next;
    });
  };

  const setAndCommit = (next: SpeedKeyframe[]) => {
    setPts(next);
    commit(next);
  };

  const linePts = pts.map((p) => `${tToX(p.t).toFixed(1)},${sToY(p.s).toFixed(1)}`).join(" ");
  const yOne = sToY(1);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">Speed over time</span>
        <div className="flex gap-1">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setAndCommit([{ t: 0, s: 1 }, { t: 0.4, s: 0.35 }, { t: 0.6, s: 0.35 }, { t: 1, s: 1 }])}
          >
            Slow-mo
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setAndCommit([{ t: 0, s: 0.5 }, { t: 1, s: 2 }])}
          >
            Ramp up
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setAndCommit(DEFAULT)}
          >
            Reset
          </button>
        </div>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full select-none rounded-md bg-muted/40"
        style={{ touchAction: "none", cursor: "copy", height: "auto" }}
        onPointerDown={onPlotDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <line x1={X0} y1={YT} x2={X1} y2={YT} stroke="currentColor" strokeOpacity={0.12} />
        {/* 1× reference — above the line = faster, below = slower */}
        <line x1={X0} y1={yOne} x2={X1} y2={yOne} stroke="currentColor" strokeOpacity={0.18} strokeDasharray="3 4" />
        <line x1={X0} y1={YB} x2={X1} y2={YB} stroke="currentColor" strokeOpacity={0.12} />
        <text x={X0 + 2} y={yOne - 3} fontSize={9} fill="currentColor" fillOpacity={0.4}>1×</text>
        <polyline points={linePts} fill="none" stroke="#8b5cf6" strokeWidth={2} strokeLinejoin="round" />
        {pts.map((p, i) => (
          <circle
            key={i}
            cx={tToX(p.t)}
            cy={sToY(p.s)}
            r={5}
            fill="#8b5cf6"
            stroke="var(--background, #111)"
            strokeWidth={1.5}
            style={{ cursor: "grab" }}
            onPointerDown={onDotDown(i)}
            onDoubleClick={onDotDouble(i)}
          />
        ))}
      </svg>

      <span className="text-[11px] text-muted-foreground">
        Drag up = faster, down = slower · sideways = timing · click to add · double-click to remove
      </span>
    </div>
  );
};

export default SpeedEnvelope;
