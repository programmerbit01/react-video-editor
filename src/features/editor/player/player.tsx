import { useEffect, useMemo, useRef, useState } from "react";
import Composition from "./composition";
import { Player as RemotionPlayer, PlayerRef } from "@remotion/player";
import useStore from "../store/use-store";

// Warm ONE media url in the background: a throwaway hidden preload element downloads it (range
// requests, NO crossOrigin so it fills the SAME cache entry the no-cors player streams from).
// Resolves when the browser has buffered enough to play through, or on error/timeout — never
// rejects, never touches the visible player.
function warmMedia(src: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const isAudio = /\.(mp3|wav|m4a|aac|ogg|opus)(\?|#|$)/i.test(src);
    const el = document.createElement(isAudio ? "audio" : "video") as HTMLMediaElement;
    el.muted = true;
    (el as HTMLVideoElement).playsInline = true;
    el.preload = "auto";
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { el.removeAttribute("src"); el.load(); } catch {}
      resolve();
    };
    const timer = setTimeout(done, 60000); // cap per item so a slow/dead url can't stall the queue
    el.addEventListener("canplaythrough", done, { once: true });
    el.addEventListener("error", done, { once: true });
    try { el.src = src; el.load(); } catch { done(); }
  });
}

// Background media-warmer. When clips land on the timeline (e.g. AI Edit auto-adds a whole
// generated video), quietly pre-download them so the FIRST playthrough doesn't stall or go
// silent. Warms ONE at a time — AUDIO first (it's small and its silence reads as "the app is
// broken"), then video — via a single-worker queue, so it never saturates a slow CDN pipe the
// way the old blob prefetch did. It NEVER blocks playback: these are throwaway hidden elements
// filling the shared cache while the player keeps streaming independently. Renders nothing.
const MediaWarmer = () => {
  const { trackItemsMap } = useStore();
  const warmed = useRef<Set<string>>(new Set());
  const queue = useRef<string[]>([]);
  const active = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const srcs = useMemo(() => {
    const items = Object.values(trackItemsMap || {}) as any[];
    const pick = (t: string) =>
      items.filter((i) => i?.type === t && i?.details?.src).map((i) => String(i.details.src));
    return [...new Set([...pick("audio"), ...pick("video")])]; // audio urls first
  }, [trackItemsMap]);

  useEffect(() => {
    for (const s of srcs) {
      if (!warmed.current.has(s) && !queue.current.includes(s)) queue.current.push(s);
    }
    if (active.current || !queue.current.length) return;
    active.current = true;
    (async () => {
      while (queue.current.length && alive.current) {
        const src = queue.current.shift()!;
        if (warmed.current.has(src)) continue;
        warmed.current.add(src);
        await warmMedia(src);
      }
      active.current = false;
    })();
  }, [srcs]);

  return null;
};

const Player = () => {
  const playerRef = useRef<PlayerRef>(null);
  const { setPlayerRef, duration, fps, size, background } = useStore();

  // YouTube-style streaming — we do NOT pre-download clips.
  //
  // OffthreadVideo renders as a real <video> in the interactive player, so it streams each
  // clip over HTTP range requests and plays the buffered portion immediately — exactly what
  // "open the clip's url in a new browser tab" does (which is instant). The old code called
  // prefetch(src, { method: "blob-url" }) for EVERY video AND audio clip on the timeline,
  // which downloaded each FULL file (tens of MB) as a blob before the player would show a
  // single frame — and fired them all in parallel. On a slow/far CDN path that was minutes
  // of black screen per clip (the "click a card → 10 minutes loading" bug), even though the
  // very same url streams instantly in a new tab. Streaming shows frames as bytes arrive and
  // only fetches what playback actually needs, on demand.
  //
  // `buffering` = playback stalled waiting for bytes mid-clip (Remotion emits `waiting` /
  // `resume` on the player ref). That drives a small spinner — the only overlay we still
  // need, and it appears only while genuinely waiting, never as an upfront wall.
  const [buffering, setBuffering] = useState(false);

  useEffect(() => {
    setPlayerRef(playerRef as React.RefObject<PlayerRef>);
  }, []);

  // Buffering (mid-playback stall) — Remotion emits `waiting`/`resume` on the player ref.
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    const onWait = () => setBuffering(true);
    const onResume = () => setBuffering(false);
    p.addEventListener("waiting", onWait);
    p.addEventListener("resume", onResume);
    return () => {
      p.removeEventListener("waiting", onWait);
      p.removeEventListener("resume", onResume);
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      <MediaWarmer />
      <RemotionPlayer
        ref={playerRef}
        component={Composition}
        acknowledgeRemotionLicense
        durationInFrames={Math.round((duration / 1000) * fps) || 1}
        compositionWidth={size.width}
        compositionHeight={size.height}
        className={`h-full w-full bg-[${background.value}]`}
        fps={30}
        overflowVisible
        numberOfSharedAudioTags={10}
      />
      {buffering ? (
        <div
          // Non-interactive: never eats a click meant for the canvas below.
          style={{ pointerEvents: "none" }}
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/30"
        >
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/25 border-t-white/90" />
          <div className="text-xs font-medium text-white/80">Buffering…</div>
        </div>
      ) : null}
    </div>
  );
};
export default Player;
