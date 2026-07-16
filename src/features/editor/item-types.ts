/**
 * THE list of item types. One answer to "what can be on a timeline".
 *
 * There used to be four, and no two agreed. The player could render 18 types; the timeline
 * declared 15 legal and had a fabric class for 16; FF exported 4. Every disagreement was a bug
 * that only showed up at runtime, on a real project, with no error until it was too late:
 *
 *   - A type the player renders but the timeline has no class for throws "No class registered
 *     for X" out of Timeline.addTrackItem, uncaught — the whole editor dies loading the project.
 *     That is what charts did for months. Registering the five chart classes by hand fixed the
 *     five; progressBar and progressFrame were still missing, because a hand-written list is not
 *     a list, it is a guess.
 *   - A type FF doesn't handle is dropped from the export in silence. You get an mp4 and simply
 *     never learn your charts aren't in it.
 *
 * So: add a type HERE and TypeScript makes you finish the job — timeline.tsx's class table is a
 * Record<ItemType, …> and won't compile with a hole in it. Nothing else may keep its own list.
 */

export interface ItemTypeSpec {
  /**
   * Does the FF (ffmpeg) export path render this?
   *
   * FF is a flat concat of video/image segments with audio mixed under and captions burned on as
   * PNG overlays — it has no compositing layer, so everything else it simply skips. This flag is
   * how the app can say so out loud instead of shipping a silently incomplete video.
   */
  ff: boolean;
  /** Human name, for anything the user reads (e.g. "3 charts won't be in this export"). */
  label: string;
}

/**
 * Keys are the `type` on a track item, verbatim. The timeline looks its fabric class up by the
 * capitalised form (`barchart` → `Barchart`), so the key is also the class name — see
 * timelineClassKey.
 */
export const ITEM_TYPES = {
  // ── FF handles these four ────────────────────────────────────────────────────────────────
  video: { ff: true, label: "Video" },
  image: { ff: true, label: "Image" },
  audio: { ff: true, label: "Audio" },
  caption: { ff: true, label: "Captions" },

  // ── the player renders these; FF drops them ──────────────────────────────────────────────
  text: { ff: false, label: "Text" },
  shape: { ff: false, label: "Shape" },
  illustration: { ff: false, label: "Illustration" },
  lottie: { ff: false, label: "Lottie animation" },

  barchart: { ff: false, label: "Bar chart" },
  linechart: { ff: false, label: "Line chart" },
  statcard: { ff: false, label: "Stat card" },
  bulletlist: { ff: false, label: "Bullet list" },

  progressBar: { ff: false, label: "Progress bar" },
  progressFrame: { ff: false, label: "Progress frame" },

  linealAudioBars: { ff: false, label: "Audio bars (lineal)" },
  radialAudioBars: { ff: false, label: "Audio bars (radial)" },
  waveAudioBars: { ff: false, label: "Audio bars (wave)" },
  hillAudioBars: { ff: false, label: "Audio bars (hill)" }
} as const satisfies Record<string, ItemTypeSpec>;

export type ItemType = keyof typeof ITEM_TYPES;

export const ITEM_TYPE_NAMES = Object.keys(ITEM_TYPES) as ItemType[];

/** The timeline's fabric registry is keyed by the capitalised type — `barchart` → `Barchart`. */
export const timelineClassKey = (type: string) =>
  type.charAt(0).toUpperCase() + type.slice(1);

/** Types the FF export path cannot render, so callers can warn instead of dropping in silence. */
export const FF_UNSUPPORTED = ITEM_TYPE_NAMES.filter((t) => !ITEM_TYPES[t].ff);

export const isItemType = (type: unknown): type is ItemType =>
  typeof type === "string" && type in ITEM_TYPES;
