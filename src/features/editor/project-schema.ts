/**
 * THE project schema — the one shape a saved project has, and the only two doors it goes
 * through: buildProject on the way out, normalizeProject on the way in.
 *
 * It lived in navbar.tsx before, as two byte-identical builders 120 lines apart that had to be
 * kept in sync by hand, plus a repair function closed over the Navbar component — so the thing
 * every project passes through on load could not be imported, reused, or tested from anywhere
 * else. The MCP generator, meanwhile, wrote its own shape and let the editor sort it out.
 *
 * Producers own correctness. normalizeProject exists to accept a project written by an older
 * producer, or by hand, and either fix it or say what is wrong — not to paper over a generator
 * that never learned the shape. When you find yourself adding a repair here, fix the producer.
 */

import type StateManager from "@designcombo/state";
import { resolveAssetUrl } from "./utils/asset-url";

/** Bumped when the shape changes in a way a reader must know about. */
export const PROJECT_SCHEMA_VERSION = 1;

export interface VappProject {
  schemaVersion?: number;
  fps?: number;
  size?: { width: number; height: number };
  tracks?: unknown[];
  trackItemIds?: string[];
  trackItemsMap?: Record<string, Record<string, unknown>>;
  transitionIds?: string[];
  transitionsMap?: Record<string, unknown>;
  /**
   * Scene-wide state that isn't an item: Film Look, Style Pack.
   *
   * StateManager.toJSON() does not carry this, so it has to be attached on the way out and read
   * back on the way in. That is why buildProject exists rather than callers using toJSON.
   */
  metadata?: Record<string, unknown>;
  /** The Guided Script source, when the project has one. */
  _guidedScript?: unknown;
  [key: string]: unknown;
}

/**
 * Every caption our generator ever wrote pointed fontUrl at this host, which now 403s.
 *
 * A dead font URL does not degrade — it HANGS. @designcombo/state's font loader neither resolves
 * nor rejects on a failed load, so DESIGN_LOAD awaits it forever and the project silently never
 * opens, with no error anywhere. That is worth repairing on the way in even though the generator
 * no longer writes it: the failure is invisible, and a hang teaches the user nothing.
 */
const DEAD_FONT_HOST = "cdn.designcombo.dev";
const FALLBACK_CAPTION_FONT = {
  family: "Anton",
  url: "https://fonts.gstatic.com/s/anton/v15/1Ptgg87LROyAm0K08i4gS7lu.ttf"
};

/** What the editor knows about the scene that StateManager doesn't. */
export interface SceneExtras {
  look?: unknown;
  stylePack?: unknown;
  guidedScript?: unknown;
}

/**
 * The project, ready to persist. THE only way to produce one — manual Save, autosave and
 * "Export project (.json)" all come through here, so they cannot drift apart again.
 */
export function buildProject(
  stateManager: StateManager,
  extras: SceneExtras = {}
): VappProject {
  const sm = stateManager.toJSON() as Record<string, unknown>;
  return {
    ...sm,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    metadata: {
      ...((sm.metadata as object) ?? {}),
      look: extras.look,
      stylePack: extras.stylePack
    },
    ...(extras.guidedScript ? { _guidedScript: extras.guidedScript } : {})
  };
}

export interface ProjectRepair {
  what: string;
  count: number;
}

/**
 * A project, made loadable. Returns the repairs it had to make so a caller can report them
 * instead of quietly carrying the damage forward.
 *
 * Mutates `data` in place — DESIGN_LOAD takes the same object, and cloning a big design on
 * every open buys nothing.
 */
export function normalizeProject(data: VappProject): {
  project: VappProject;
  repairs: ProjectRepair[];
} {
  const repairs: ProjectRepair[] = [];
  const note = (what: string) => {
    const hit = repairs.find((r) => r.what === what);
    if (hit) hit.count++;
    else repairs.push({ what, count: 1 });
  };

  const map = (data?.trackItemsMap ?? {}) as Record<string, Record<string, unknown>>;
  for (const item of Object.values(map)) {
    const details = (item.details ?? {}) as Record<string, unknown>;

    // resolveAssetUrl is the single resolver: it unwraps a legacy /api/proxy wrapper and
    // otherwise hands back the URL untouched. The generator writes direct now; this catches
    // designs written before it did, and hand-made ones.
    const direct = resolveAssetUrl(details.src);
    if (direct && direct !== details.src) {
      item.details = { ...details, src: direct };
      note("proxy-wrapped media URL → direct");
    }

    const d = (item.details ?? {}) as Record<string, unknown>;
    if (typeof d.fontUrl === "string" && d.fontUrl.includes(DEAD_FONT_HOST)) {
      item.details = {
        ...d,
        fontUrl: FALLBACK_CAPTION_FONT.url,
        fontFamily: FALLBACK_CAPTION_FONT.family
      };
      note("caption font repointed off the dead CDN (would have hung the load)");
    }

    // The timeline's Video item samples previewUrl for its filmstrip; without one it draws
    // nothing. It is just the src.
    if (item.type === "video") {
      const meta = (item.metadata ?? {}) as Record<string, unknown>;
      const src = ((item.details ?? {}) as Record<string, unknown>).src;
      const preview = resolveAssetUrl(meta.previewUrl || src);
      if (preview && preview !== meta.previewUrl) {
        item.metadata = { ...meta, previewUrl: preview };
        note("video previewUrl set for the filmstrip");
      }
    }
  }

  let tracks = data.tracks as any[];
  if (Array.isArray(tracks)) {
    // An empty track is a blank timeline row that pushes everything else apart. They hold no
    // items, so dropping them is free — but never drop the last one.
    const nonEmpty = tracks.filter((t: any) => Array.isArray(t?.items) && t.items.length > 0);
    if (nonEmpty.length && nonEmpty.length < tracks.length) {
      note("empty tracks dropped");
      tracks = nonEmpty;
      data.tracks = tracks;
    }

    // All captions belong on ONE row. They are time-positioned and never overlap, so a row
    // each buys nothing and separates every caption from the clip it belongs under. Ownership
    // lives in metadata.sourceTrackItemId, not in the track — see CAPTIONS.md.
    const capTracks = tracks.filter((t: any) => t?.type === "caption");
    if (capTracks.length > 1) {
      const first = capTracks[0];
      first.items = capTracks.flatMap((t: any) => (Array.isArray(t.items) ? t.items : []));
      data.tracks = tracks.filter((t: any) => t === first || t?.type !== "caption");
      note("caption tracks merged onto one row");
    }
  }

  return { project: data, repairs };
}
