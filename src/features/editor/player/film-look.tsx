import { AbsoluteFill, useCurrentFrame, random } from "remotion";

/**
 * PHASE 1 — FILM LOOK
 *
 * A global, optional color-grade + film-grain layer that sits ABOVE all shots.
 * Content-agnostic: it is just a CSS filter (the "grade") plus a procedural
 * grain/vignette overlay (the "texture"), driven by a named preset. Picking a
 * look never changes the timeline — it only restyles the final image — so it is
 * safe for ANY content type and trivially reversible ("off" = no-op).
 *
 * Concept ported from the video-templates Grade.tsx / FilmLook.tsx, but the
 * grain is generated procedurally with an SVG <feTurbulence> data-URI instead of
 * shipping a grain.png. That keeps it asset-free (low debug, nothing to 404) and
 * GPU-friendly (we only animate background-position, a cheap compositor shift).
 *
 * Both surfaces use the same preset ids:
 *   - GUI  : a "Look" dropdown writes `look` into the store.
 *   - MCP  : assemble_timeline(look=...) writes design.metadata.look; the render
 *            root loads it into the same store field.
 */

export interface LookPreset {
  id: string;
  label: string;
  /** CSS filter applied to the whole frame (the colour grade). */
  grade: string;
  /** Tint multiplied into the shadows via screen blend (milky/colored blacks). */
  blacks?: { color: string; opacity: number };
  /** Tint added to highlights via soft-light blend (creamy/cool highlights). */
  highlights?: { color: string; opacity: number };
  /** Procedural film-grain strength (0 = none). */
  grain: number;
  /** Vignette darkness at the corners (0 = none). */
  vignette: number;
}

// The curated set. Small on purpose — "curation > quantity". Add presets here
// and they automatically appear in the GUI dropdown and pass MCP validation.
export const LOOKS: LookPreset[] = [
  {
    id: "off",
    label: "Off (no grade)",
    grade: "none",
    grain: 0,
    vignette: 0,
  },
  {
    id: "warm-doc",
    label: "Warm Documentary",
    // vintage 16mm — warm, muted saturation, gentle contrast
    grade: "contrast(1.18) saturate(0.9) sepia(0.18) brightness(0.98)",
    blacks: { color: "#1a1510", opacity: 0.1 },
    highlights: { color: "#fdf5e6", opacity: 0.12 },
    grain: 0.16,
    vignette: 0.55,
  },
  {
    id: "cool-cinematic",
    label: "Cool Cinematic",
    // teal-leaning blockbuster: crisp contrast, cool highlights
    grade: "contrast(1.22) saturate(1.05) brightness(0.97) hue-rotate(-6deg)",
    blacks: { color: "#0d1a22", opacity: 0.14 },
    highlights: { color: "#dff1ff", opacity: 0.1 },
    grain: 0.1,
    vignette: 0.5,
  },
  {
    id: "neutral",
    label: "Neutral Clean",
    // subtle polish only — slight contrast/saturation lift, faint texture
    grade: "contrast(1.08) saturate(1.04) brightness(1.0)",
    grain: 0.05,
    vignette: 0.28,
  },
];

const LOOK_MAP: Record<string, LookPreset> = Object.fromEntries(
  LOOKS.map((l) => [l.id, l]),
);

export const LOOK_IDS = LOOKS.map((l) => l.id);

export function isValidLook(id: unknown): id is string {
  return typeof id === "string" && id in LOOK_MAP;
}

// One static procedural grain tile (SVG fractal noise) reused every frame; we
// only shift its position, so it costs ~nothing to animate and never 404s.
const GRAIN_DATA_URI =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

export const FilmLook: React.FC<{ look?: string }> = ({ look = "off" }) => {
  const frame = useCurrentFrame();
  const preset = LOOK_MAP[look ?? "off"];

  // "off" / unknown → render nothing at all (true no-op, zero cost).
  if (!preset || preset.id === "off") return null;

  // Cheap per-frame grain jitter (compositor-only background-position shift).
  const gx = Math.floor(random(`gx${frame}`) * 160);
  const gy = Math.floor(random(`gy${frame}`) * 160);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {/* shadow/highlight tints — give the grade its "lifted" film feel */}
      {preset.blacks && (
        <AbsoluteFill
          style={{
            backgroundColor: preset.blacks.color,
            mixBlendMode: "screen",
            opacity: preset.blacks.opacity,
          }}
        />
      )}
      {preset.highlights && (
        <AbsoluteFill
          style={{
            backgroundColor: preset.highlights.color,
            mixBlendMode: "soft-light",
            opacity: preset.highlights.opacity,
          }}
        />
      )}
      {/* procedural film grain */}
      {preset.grain > 0 && (
        <AbsoluteFill
          style={{
            backgroundImage: GRAIN_DATA_URI,
            backgroundRepeat: "repeat",
            backgroundPosition: `${gx}px ${gy}px`,
            opacity: preset.grain,
            mixBlendMode: "overlay",
            willChange: "background-position",
          }}
        />
      )}
      {/* vignette */}
      {preset.vignette > 0 && (
        <AbsoluteFill
          style={{
            background: `radial-gradient(ellipse 78% 78% at 50% 50%, rgba(0,0,0,0) 52%, rgba(0,0,0,${preset.vignette}) 100%)`,
          }}
        />
      )}
    </AbsoluteFill>
  );
};

/**
 * Applies the grade CSS filter to a wrapper around the timeline content. The
 * grade must wrap the shots (so it actually recolours them); the grain/vignette
 * overlay (the <FilmLook> component) sits separately on top.
 */
export const gradeFilterFor = (look?: string): string => {
  const preset = LOOK_MAP[look ?? "off"];
  return preset && preset.id !== "off" ? preset.grade : "none";
};
