import { generateId } from "@designcombo/timeline";

export const MUSIC_BED_VOLUME_DEFAULT = 18;
export const CUT_SFX_VOLUME_DEFAULT = 55;
export const CUT_SFX_DURATION_MS = 700;

export const MANAGED_AUDIO_SOURCE = "scene-audio-controls";
export const MUSIC_BED_ROLE = "music-bed";
export const CUT_SFX_ROLE = "cut-sfx";
export const MANUAL_SFX_ROLE = "manual-sfx";

type TimelineState = {
  duration?: number;
  tracks?: any[];
  trackItemIds?: string[];
  trackItemsMap?: Record<string, any>;
};

const AUDIO_TRACK_BASE = {
  accepts: ["audio"],
  magnetic: false,
  muted: false,
  static: false,
  type: "audio"
};

const getTimelineDuration = (state: TimelineState) => {
  const maxItemEnd = Object.values(state.trackItemsMap || {}).reduce(
    (max, item: any) => Math.max(max, Number(item?.display?.to) || 0),
    0
  );
  return Math.max(Number(state.duration) || 0, maxItemEnd, 1000);
};

const isManagedAudioItem = (item: any, role: string) =>
  item?.type === "audio" &&
  item?.metadata?.managedBy === MANAGED_AUDIO_SOURCE &&
  item?.metadata?.audioRole === role;

const buildAudioTrack = (name: string, role: string) => ({
  id: generateId(),
  ...AUDIO_TRACK_BASE,
  items: [],
  name,
  metadata: {
    managedBy: MANAGED_AUDIO_SOURCE,
    trackRole: role
  }
});

const ensureManagedAudioTrack = (tracks: any[], name: string, role: string) => {
  const existing = tracks.find(
    (track) =>
      track?.type === "audio" &&
      track?.metadata?.managedBy === MANAGED_AUDIO_SOURCE &&
      track?.metadata?.trackRole === role
  );
  if (existing) return { tracks: [...tracks], track: existing };
  const track = buildAudioTrack(name, role);
  return { tracks: [...tracks, track], track };
};

const ensureAudioTrack = (tracks: any[], name: string, role: string, managed = true) => {
  const existing = tracks.find((track) => {
    if (track?.type !== "audio") return false;
    if (!managed) {
      return track?.metadata?.trackRole === role;
    }
    return (
      track?.metadata?.managedBy === MANAGED_AUDIO_SOURCE &&
      track?.metadata?.trackRole === role
    );
  });
  if (existing) return { tracks: [...tracks], track: existing };

  const track = {
    id: generateId(),
    ...AUDIO_TRACK_BASE,
    items: [],
    name,
    metadata: managed
      ? {
          managedBy: MANAGED_AUDIO_SOURCE,
          trackRole: role
        }
      : {
          trackRole: role
        }
  };
  return { tracks: [...tracks, track], track };
};

const stripManagedRole = (state: TimelineState, role: string) => {
  const trackItemsMap = { ...(state.trackItemsMap || {}) };
  const removedIds = new Set<string>();

  Object.entries(trackItemsMap).forEach(([id, item]) => {
    if (isManagedAudioItem(item, role)) {
      delete trackItemsMap[id];
      removedIds.add(id);
    }
  });

  const trackItemIds = (state.trackItemIds || []).filter((id) => !removedIds.has(id));
  const tracks = (state.tracks || []).map((track) => ({
    ...track,
    items: (track.items || []).filter((id: string) => !removedIds.has(id))
  }));

  return { trackItemsMap, trackItemIds, tracks };
};

export const getManagedAudioItems = (trackItemsMap: Record<string, any>, role: string) =>
  Object.values(trackItemsMap || {}).filter((item) => isManagedAudioItem(item, role));

export const upsertMusicBed = (
  state: TimelineState,
  options: { src?: string; volume?: number }
) => {
    const base = stripManagedRole(state, MUSIC_BED_ROLE);
    if (!options.src) {
      return {
        ...base,
        duration: getTimelineDuration({ ...state, ...base })
      };
    }

    const duration = getTimelineDuration({ ...state, ...base });
    const itemId = generateId();
    const item = {
      id: itemId,
      type: "audio",
      name: "Music bed",
      display: { from: 0, to: duration },
      duration,
      details: {
        src: options.src,
        volume: Math.max(0, Math.min(100, Math.round(options.volume ?? MUSIC_BED_VOLUME_DEFAULT)))
      },
      metadata: {
        managedBy: MANAGED_AUDIO_SOURCE,
        audioRole: MUSIC_BED_ROLE
      }
    };

    const ensured = ensureManagedAudioTrack(base.tracks, "Music bed", MUSIC_BED_ROLE);
    const tracks = ensured.tracks.map((track) =>
      track.id === ensured.track.id
        ? { ...track, items: [...(track.items || []), itemId] }
        : track
    );

    return {
      trackItemsMap: { ...base.trackItemsMap, [itemId]: item },
      trackItemIds: [...base.trackItemIds, itemId],
      tracks,
      duration
    };
};

const getCutBoundaries = (trackItemsMap: Record<string, any>) => {
  const shots = Object.values(trackItemsMap || {})
    .filter((item: any) => item?.type === "video" || item?.type === "image")
    .sort((a: any, b: any) => {
      const fromDiff = (a?.display?.from ?? 0) - (b?.display?.from ?? 0);
      if (fromDiff !== 0) return fromDiff;
      return (a?.display?.to ?? 0) - (b?.display?.to ?? 0);
    });

  const boundaries = new Set<number>();
  for (let i = 1; i < shots.length; i += 1) {
    const boundary = Number(shots[i]?.display?.from);
    if (boundary > 0) boundaries.add(boundary);
  }
  return Array.from(boundaries).sort((a, b) => a - b);
};

export const getCutBoundaryCount = (trackItemsMap: Record<string, any>) =>
  getCutBoundaries(trackItemsMap).length;

export const upsertCutSfx = (
  state: TimelineState,
  options: { enabled: boolean; src?: string; volume?: number }
) => {
  const base = stripManagedRole(state, CUT_SFX_ROLE);
  const duration = getTimelineDuration({ ...state, ...base });
  if (!options.enabled || !options.src) {
    return {
      ...base,
      duration
    };
  }

  const boundaries = getCutBoundaries(base.trackItemsMap);
  if (boundaries.length === 0) {
    return {
      ...base,
      duration
    };
  }

  const ensured = ensureManagedAudioTrack(base.tracks, "Cut SFX", CUT_SFX_ROLE);
  const nextTrackItemsMap = { ...base.trackItemsMap };
  const nextTrackItemIds = [...base.trackItemIds];
  const nextIds: string[] = [];

  boundaries.forEach((from, index) => {
    const itemId = generateId();
    const to = Math.min(duration, from + CUT_SFX_DURATION_MS);
    nextTrackItemsMap[itemId] = {
      id: itemId,
      type: "audio",
      name: `Cut SFX ${index + 1}`,
      display: { from, to },
      duration: to - from,
      details: {
        src: options.src,
        volume: Math.max(0, Math.min(100, Math.round(options.volume ?? CUT_SFX_VOLUME_DEFAULT)))
      },
      metadata: {
        managedBy: MANAGED_AUDIO_SOURCE,
        audioRole: CUT_SFX_ROLE,
        boundaryIndex: index
      }
    };
    nextTrackItemIds.push(itemId);
    nextIds.push(itemId);
  });

  const tracks = ensured.tracks.map((track) =>
    track.id === ensured.track.id
      ? { ...track, items: [...(track.items || []), ...nextIds] }
      : track
  );

  return {
    trackItemsMap: nextTrackItemsMap,
    trackItemIds: nextTrackItemIds,
    tracks,
    duration
  };
};

export const addManualSfx = (
  state: TimelineState,
  options: { from: number; src: string; volume?: number; durationMs: number; name?: string }
) => {
  const itemId = generateId();
  const from = Math.max(0, Math.round(options.from));
  const durationMs = Math.max(100, Math.round(options.durationMs));
  const to = from + durationMs;
  const ensured = ensureAudioTrack(
    [...(state.tracks || [])],
    "Sound effects",
    MANUAL_SFX_ROLE,
    false
  );

  const tracks = ensured.tracks.map((track) =>
    track.id === ensured.track.id
      ? { ...track, items: [...(track.items || []), itemId] }
      : track
  );

  const trackItemsMap = {
    ...(state.trackItemsMap || {}),
    [itemId]: {
      id: itemId,
      type: "audio",
      name: options.name || "Sound effect",
      display: { from, to },
      duration: durationMs,
      details: {
        src: options.src,
        volume: Math.max(0, Math.min(100, Math.round(options.volume ?? CUT_SFX_VOLUME_DEFAULT)))
      },
      metadata: {
        audioRole: MANUAL_SFX_ROLE
      }
    }
  };

  return {
    trackItemsMap,
    trackItemIds: [...(state.trackItemIds || []), itemId],
    tracks,
    duration: Math.max(Number(state.duration) || 0, to)
  };
};
