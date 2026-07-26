import { useEffect, useMemo, useRef, useState } from "react";
import {
  VolumeKeyframe,
  normalizeKeyframes,
  sampleEnvelope,
} from "../../utils/volume-envelope";

// Volume automation editor: a stylised waveform with a draggable gain curve laid over it. Drag a
// point up/down to set the volume at that moment, sideways to move it in time; click the line to
// add a point, double-click a point to remove it. The waveform is a stable stylised shape (seeded
// by the clip id) that visually shrinks/grows with the curve — real per-clip audio decoding would
// mean a CORS/download cost we deliberately avoid here; the curve is the functional part. Commits
// to the parent only on release, so the timeline/store isn't spammed mid-drag.

const W = 260;
const H = 104;
const PADX = 6;
const YT = 8;
const YB = 92;
const X0 = PADX;
const X1 = W - PADX;

const DEFAULT: VolumeKeyframe[] = [
  { t: 0, v: 1 },
  { t: 1, v: 1 },
];

const tToX = (t: number) => X0 + t * (X1 - X0);
const xToT = (x: number) => Math.max(0, Math.min(1, (x - X0) / (X1 - X0)));
const vToY = (v: number) => YB - v * (YB - YT);
const yToV = (y: number) => Math.max(0, Math.min(1, (YB - y) / (YB - YT)));

// Deterministic 0..1 pseudo-waveform bars from a seed string — stable per clip, no randomness.
function waveBars(seed: string, n: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const bars: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = Math.sin((i + 1) * (h % 97) * 0.017) * 0.5 + Math.sin(i * 0.7 + (h % 13)) * 0.3;
    bars.push(0.28 + 0.72 * Math.abs(x));
  }
  return bars;
}

const VolumeEnvelope = ({
  value,
  onChange,
  seed,
}: {
  value?: VolumeKeyframe[];
  onChange: (kf: VolumeKeyframe[]) => void;
  seed?: string;
}) => {
  const [pts, setPts] = useState<VolumeKeyframe[]>(() => {
    const n = normalizeKeyframes(value);
    return n.length >= 2 ? n : DEFAULT;
  });
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const moved = useRef(false);

  useEffect(() => {
    const n = normalizeKeyframes(value);
    if (drag.current == null) setPts(n.length >= 2 ? n : DEFAULT);
  }, [value]);

  const bars = useMemo(() => waveBars(seed || "clip", 64), [seed]);

  // Commit — a flat 100% line means "no automation", so send [] to clear it.
  const commit = (next: VolumeKeyframe[]) => {
    const flat = next.length >= 2 && next.every((p) => Math.abs(p.v - 1) < 1e-3);
    onChange(flat ? [] : next);
  };

  const evtT = (e: React.PointerEvent | PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * W,
      y: ((e.clientY - r.top) / r.height) * H,
    };
  };

  const onDotDown = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    drag.current = i;
    moved.current = false;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    if (drag.current == null) return;
    moved.current = true;
    const i = drag.current;
    const { x, y } = evtT(e);
    setPts((prev) => {
      const next = prev.map((p) => ({ ...p }));
      next[i].v = yToV(y);
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

  // Click on the plot (not a dot) → add a point on the curve at that time.
  const onPlotDown = (e: React.PointerEvent) => {
    const { x } = evtT(e);
    const t = xToT(x);
    setPts((prev) => {
      const v = sampleEnvelope(prev, t);
      const next = [...prev, { t, v }].sort((a, b) => a.t - b.t);
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

  const setAndCommit = (next: VolumeKeyframe[]) => {
    setPts(next);
    commit(next);
  };

  const linePts = pts.map((p) => `${tToX(p.t).toFixed(1)},${vToY(p.v).toFixed(1)}`).join(" ");
  const areaPts = `${X0},${YB} ${linePts} ${X1},${YB}`;
  const gainAtX = (bx: number) => sampleEnvelope(pts, xToT(bx));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">Volume over time</span>
        <div className="flex gap-1">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setAndCommit([{ t: 0, v: 0 }, { t: 0.25, v: 1 }, { t: 1, v: 1 }])}
          >
            Fade in
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setAndCommit([{ t: 0, v: 1 }, { t: 0.75, v: 1 }, { t: 1, v: 0 }])}
          >
            Fade out
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
        <line x1={X0} y1={(YT + YB) / 2} x2={X1} y2={(YT + YB) / 2} stroke="currentColor" strokeOpacity={0.12} strokeDasharray="3 4" />
        <line x1={X0} y1={YB} x2={X1} y2={YB} stroke="currentColor" strokeOpacity={0.12} />
        {bars.map((b, i) => {
          const step = (X1 - X0) / bars.length;
          const bx = X0 + i * step + step / 2;
          const mid = (YT + YB) / 2;
          const amp = (b * gainAtX(bx) * (YB - YT)) / 2.2;
          return (
            <rect
              key={i}
              x={bx - step * 0.3}
              y={mid - amp}
              width={step * 0.6}
              height={amp * 2}
              rx={1}
              fill="currentColor"
              fillOpacity={0.28}
            />
          );
        })}
        <polygon points={areaPts} fill="#f97316" fillOpacity={0.12} />
        <polyline points={linePts} fill="none" stroke="#f97316" strokeWidth={2} strokeLinejoin="round" />
        {pts.map((p, i) => (
          <circle
            key={i}
            cx={tToX(p.t)}
            cy={vToY(p.v)}
            r={5}
            fill="#f97316"
            stroke="var(--background, #111)"
            strokeWidth={1.5}
            style={{ cursor: "grab" }}
            onPointerDown={onDotDown(i)}
            onDoubleClick={onDotDouble(i)}
          />
        ))}
      </svg>

      <span className="text-[11px] text-muted-foreground">
        Drag points up/down for volume, sideways for timing · click to add · double-click to remove
      </span>
    </div>
  );
};

export default VolumeEnvelope;
