// Volume automation (envelope) + speed helpers — PURE, no React/DOM, so BOTH the client player
// (Remotion volume callbacks) and the server render (ffmpeg filter graph) import from here and
// stay in exact agreement. A clip's volume can be a flat number (the old `details.volume`) OR a
// curve of keyframes (`details.volumeKeyframes`) that raises/lowers the level across the clip —
// e.g. duck music under a voiceover, fade in/out. Keyframes are stored as fractions of the clip's
// DISPLAYED (trimmed) duration so they survive trims and speed changes.

export interface VolumeKeyframe {
  t: number; // 0..1 position along the clip's displayed duration
  v: number; // 0..1 gain at that point (1 = the clip's master volume)
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

// Keep only valid points, clamp to [0,1], sort by time, drop duplicate timestamps.
export function normalizeKeyframes(kf: unknown): VolumeKeyframe[] {
  if (!Array.isArray(kf)) return [];
  const pts = kf
    .map((p: any) => ({ t: clamp01(Number(p?.t)), v: clamp01(Number(p?.v)) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  const out: VolumeKeyframe[] = [];
  for (const p of pts) {
    if (out.length && Math.abs(out[out.length - 1].t - p.t) < 1e-4) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

// A curve is "active" only with ≥2 points that actually bend the line away from a flat 100%.
export function hasEnvelope(kf: unknown): boolean {
  const pts = normalizeKeyframes(kf);
  return pts.length >= 2 && pts.some((p) => Math.abs(p.v - 1) > 1e-3);
}

// Linear-interpolated gain at a fraction (0..1) of the clip. Flat-extends past the end points.
export function sampleEnvelope(pts: VolumeKeyframe[], frac: number): number {
  if (!pts.length) return 1;
  const f = clamp01(frac);
  if (f <= pts[0].t) return pts[0].v;
  const last = pts[pts.length - 1];
  if (f >= last.t) return last.v;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (f >= a.t && f <= b.t) {
      const span = b.t - a.t || 1;
      return a.v + (b.v - a.v) * ((f - a.t) / span);
    }
  }
  return last.v;
}

// Player side: turn (master volume + optional curve) into what Remotion's `volume` prop wants —
// a constant number when there's no curve, or a per-frame function (frame is 0-based within the
// clip's Sequence, so frame/durationInFrames is the clip-local fraction the keyframes speak in).
export function makeVolumeFn(opts: {
  keyframes?: unknown;
  volume?: number | null; // 0..100 master (the flat slider)
  muted?: boolean;
  durationInFrames: number;
}): number | ((frame: number) => number) {
  const master = opts.muted ? 0 : clamp01((Number(opts.volume ?? 100) || 0) / 100);
  const pts = normalizeKeyframes(opts.keyframes);
  if (master === 0 || pts.length < 2) return master;
  const d = opts.durationInFrames > 0 ? opts.durationInFrames : 1;
  return (frame: number) => master * sampleEnvelope(pts, frame / d);
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

// ffmpeg `atempo` only accepts 0.5–2.0 per instance, so a rate outside that range is a CHAIN
// whose factors multiply back to `rate` (2.2 → atempo=2.0,atempo=1.1 · 4 → 2,2 · 0.25 → 0.5,0.5).
// Returns "" for rate≈1 (no-op) or a leading-comma filter string ready to append to a chain.
export function atempoChain(rate: number): string {
  let r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) r = 1;
  r = Math.max(0.0625, Math.min(16, r));
  if (Math.abs(r - 1) < 1e-3) return "";
  const factors: number[] = [];
  while (r > 2) { factors.push(2); r /= 2; }
  while (r < 0.5) { factors.push(0.5); r /= 0.5; }
  factors.push(r);
  return factors.map((f) => `,atempo=${r3(f)}`).join("");
}

// Render side: a piecewise-linear ffmpeg volume EXPRESSION over `t` seconds (clip-local, measured
// after atempo so it spans 0..durSec), with the master gain baked in. Returns null when there's no
// active curve (caller uses the plain constant `volume=<master>`). Use as `volume=volume='<expr>':eval=frame`.
export function buildFfmpegVolumeExpr(
  kf: unknown,
  masterGain: number,
  durSec: number,
): string | null {
  const pts = normalizeKeyframes(kf);
  if (pts.length < 2 || masterGain <= 0) return null;
  const dur = durSec > 0 ? durSec : 1;
  const X = pts.map((p) => r3(p.t * dur));
  const Y = pts.map((p) => r3(p.v * masterGain));
  // Build from the tail inward: after the last point, hold its value.
  let expr = `${Y[Y.length - 1]}`;
  for (let i = pts.length - 2; i >= 0; i--) {
    const x0 = X[i], x1 = X[i + 1], y0 = Y[i], y1 = Y[i + 1];
    const span = x1 - x0 || 0.001;
    const seg = `(${y0}+(${r3(y1 - y0)})*(t-${x0})/${r3(span)})`;
    expr = `if(lt(t,${x1}),${seg},${expr})`;
  }
  // Before the first point, hold its value.
  return `if(lt(t,${X[0]}),${Y[0]},${expr})`;
}

// Normalize a playbackRate for ffmpeg use (same clamp as atempoChain / setpts divisor).
export function safeRate(rate: unknown): number {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return 1;
  return Math.max(0.0625, Math.min(16, r));
}
