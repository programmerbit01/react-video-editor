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
  /** Human name, for anything the user reads (e.g. "1 bar chart won't be in this export"). */
  label: string;
  /** Only when adding "s" to `label` would be wrong — "3 texts" isn't a thing, "3 text items" is. */
  plural?: string;
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
  text: { ff: false, label: "Text", plural: "text items" },
  shape: { ff: false, label: "Shape" },
  illustration: { ff: false, label: "Illustration" },
  lottie: { ff: false, label: "Lottie animation" },

  barchart: { ff: false, label: "Bar chart" },
  linechart: { ff: false, label: "Line chart" },
  statcard: { ff: false, label: "Stat card" },
  bulletlist: { ff: false, label: "Bullet list" },

  progressBar: { ff: false, label: "Progress bar" },
  progressFrame: { ff: false, label: "Progress frame" },

  linealAudioBars: { ff: false, label: "Audio bars (lineal)", plural: "audio bars (lineal)" },
  radialAudioBars: { ff: false, label: "Audio bars (radial)", plural: "audio bars (radial)" },
  waveAudioBars: { ff: false, label: "Audio bars (wave)", plural: "audio bars (wave)" },
  hillAudioBars: { ff: false, label: "Audio bars (hill)", plural: "audio bars (hill)" }
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

/**
 * What an FF export of these items would leave out, counted and named.
 *
 * FF renders four of the eighteen types and skips the rest without a word — you get an mp4 and
 * simply never learn your charts aren't in it. Nothing here changes what FF renders; it only
 * lets the app say so, before the wait rather than after.
 *
 * An unknown type counts as dropped. FF only ever handles types it was taught, so a type this
 * registry has not heard of is one FF has not heard of either.
 */
export function ffDroppedItems(items: Iterable<{ type?: unknown }>) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const type = item?.type;
    if (typeof type !== "string") continue;
    if (isItemType(type) && ITEM_TYPES[type].ff) continue;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => {
      const spec = isItemType(type) ? ITEM_TYPES[type] : undefined;
      const one = spec?.label ?? type;
      const many = (spec as ItemTypeSpec | undefined)?.plural ?? `${one}s`;
      return { type, count, label: count === 1 ? one : many };
    })
    .sort((a, b) => b.count - a.count);
}

/** "3 text items, 2 bar charts" — the dropped list, in a sentence. */
export function describeFfDropped(dropped: ReturnType<typeof ffDroppedItems>) {
  return dropped.map((d) => `${d.count} ${d.label.toLowerCase()}`).join(", ");
}
