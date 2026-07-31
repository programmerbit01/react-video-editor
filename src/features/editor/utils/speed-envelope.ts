// Variable-speed (speed ramp) — PURE, no React/DOM, so the client player (Remotion sub-sequences)
// and the server render (ffmpeg concat) import from here and stay in exact agreement.
//
// INDEPENDENT of the volume envelope on purpose (kept in its own file so it can't break volume, and
// so this feature is easy to debug in isolation). A clip's speed is a flat `playbackRate` OR a
// curve of keyframes (`details.speedKeyframes`) that speeds up / slows down across the clip.
//
// THE EASY MODEL — no per-frame time-remap. The curve is SAMPLED into a handful of CONSTANT-speed
// "zones". Each zone is just a normal constant-`playbackRate` piece (the primitive that already
// works in both player and ffmpeg), so nothing new/hard is invented — a variable ramp is only many
// small constant pieces stitched together. On the timeline it stays ONE clip; the zones are
// internal (Remotion Sequences in the player, concat segments in the export).

export interface SpeedKeyframe {
  t: number; // 0..1 position along the clip's DISPLAYED (trimmed) duration
  s: number; // speed multiplier at that point (1 = normal, 0.5 = half/slow-mo, 2 = double/fast)
}

// Same clamp the ffmpeg setpts divisor / atempo chain accept, so a zone speed is always renderable.
const MIN_SPEED = 0.0625;
const MAX_SPEED = 16;
const clampSpeed = (n: number) => (n < MIN_SPEED ? MIN_SPEED : n > MAX_SPEED ? MAX_SPEED : n);
const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

// Keep only valid points, clamp, sort by time, drop duplicate timestamps.
export function normalizeSpeedKeyframes(kf: unknown): SpeedKeyframe[] {
  if (!Array.isArray(kf)) return [];
  const pts = kf
    .map((p: any) => ({ t: clamp01(Number(p?.t)), s: clampSpeed(Number(p?.s)) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.s) && p.s > 0)
    .sort((a, b) => a.t - b.t);
  const out: SpeedKeyframe[] = [];
  for (const p of pts) {
    if (out.length && Math.abs(out[out.length - 1].t - p.t) < 1e-4) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

// Linear-interpolated speed at a fraction (0..1) of the clip. Flat-extends past the end points.
export function sampleSpeed(pts: SpeedKeyframe[], frac: number): number {
  if (!pts.length) return 1;
  const f = clamp01(frac);
  if (f <= pts[0].t) return pts[0].s;
  const last = pts[pts.length - 1];
  if (f >= last.t) return last.s;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (f >= a.t && f <= b.t) {
      const span = b.t - a.t || 1;
      return a.s + (b.s - a.s) * ((f - a.t) / span);
    }
  }
  return last.s;
}

// A speed curve needs zones only when it actually VARIES (≥2 points that differ). A flat curve is
// just a constant playbackRate — handled by `flatSpeed`, not zones.
export function hasSpeedEnvelope(kf: unknown): boolean {
  const pts = normalizeSpeedKeyframes(kf);
  if (pts.length < 2) return false;
  let lo = pts[0].s, hi = pts[0].s;
  for (const p of pts) { if (p.s < lo) lo = p.s; if (p.s > hi) hi = p.s; }
  return hi - lo > 1e-3;
}

// If the curve is present but (near-)flat, return its single speed (so the caller applies a plain
// constant playbackRate instead of zones). Returns null when absent or genuinely varying.
export function flatSpeed(kf: unknown): number | null {
  const pts = normalizeSpeedKeyframes(kf);
  if (!pts.length) return null;
  if (hasSpeedEnvelope(kf)) return null;
  return pts[0].s;
}

export interface SpeedZone {
  outFromFrame: number;   // start of this zone in the clip's OUTPUT timeline (0-based within the item)
  outFrames: number;      // length of this zone in output frames
  srcStartFrame: number;  // source frame this zone starts playing from
  speed: number;          // constant speed for this zone
}

// Sample the speed curve into `slices` constant-speed zones that tile the clip's `durationInFrames`
// exactly (integer output frames sum to durationInFrames), chaining the source position so the
// pieces stitch without a jump. srcEndFrame clamps the source so a fast/long curve can't read past
// the trimmed end (the last frame simply holds, same as a plain over-long constant clip).
export function buildSpeedZones(
  kf: unknown,
  opts: {
    durationInFrames: number;
    srcStartFrame: number;
    srcEndFrame: number;
    slices?: number;
  },
): SpeedZone[] {
  const pts = normalizeSpeedKeyframes(kf);
  const D = Math.max(1, Math.round(opts.durationInFrames));
  if (pts.length < 2) return [];
  // One zone per output frame is the finest useful resolution; otherwise cap to keep the piece
  // count sane (12 constant steps already read as a smooth ramp, and bound the render segments).
  const K = Math.max(1, Math.min(opts.slices ?? 12, D));

  const zones: SpeedZone[] = [];
  let outCursor = 0;
  let srcCursor = opts.srcStartFrame;
  for (let k = 0; k < K; k++) {
    // Even integer split of D across K zones (distribute the remainder over the first zones).
    const outFrames = Math.floor(D / K) + (k < D % K ? 1 : 0);
    if (outFrames <= 0) continue;
    // Constant speed for this zone = the curve at the zone's MIDPOINT fraction.
    const midFrac = (outCursor + outFrames / 2) / D;
    const speed = clampSpeed(sampleSpeed(pts, midFrac));
    const srcStartFrame = Math.min(srcCursor, Math.max(opts.srcStartFrame, opts.srcEndFrame - 1));
    zones.push({ outFromFrame: outCursor, outFrames, srcStartFrame, speed });
    outCursor += outFrames;
    srcCursor += outFrames * speed; // source frames this zone consumes
  }
  return zones;
}
