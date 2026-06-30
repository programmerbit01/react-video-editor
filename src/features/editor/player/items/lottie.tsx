"use client";

import { useEffect, useRef, useState } from "react";
import type { AnimationItem } from "lottie-web";
import { cancelRender, continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";
import { ITrackItem } from "@designcombo/types";
import { BaseSequence, SequenceItemOptions } from "../base-sequence";

/**
 * LOTTIE motion-graphics item (Phase: Lottie).
 *
 * Renders an After-Effects-grade animation (a Lottie JSON) as a timeline layer —
 * animated lower-thirds, title cards, callouts, icons. Two sources, both optional:
 *   - details.animationData : the Lottie JSON embedded inline (used by the curated
 *     bundled presets — no network fetch at render time, so it is render-box-proof).
 *   - details.src           : a Lottie JSON URL (e.g. a LottieFiles export). Fetched
 *     at render time through the editor proxy, exactly like images.
 *
 * Stored on the timeline as a normal "image" item with metadata.graphicType ===
 * "lottie" (the same trick the charts use) so designcombo's add/track machinery
 * works unchanged; sequence-item.tsx routes it here.
 */
export const LottieItem = ({
  item,
  options,
}: {
  item: ITrackItem;
  options: SequenceItemOptions;
}) => {
  const details: any = item.details || {};
  const inline =
    details.animationData ||
    (item as any).metadata?.lottieData ||
    null;
  const src: string = details.src || (item as any).metadata?.lottieUrl || "";
  const loop = details.loop !== false; // default: loop the animation
  const speed = Number(details.speed) || 1;
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const animationRef = useRef<AnimationItem | null>(null);

  // lottie-web is browser-only. During Next.js SSR (no window) we must NOT render
  // it or call delayRender — both crash on the server. The Remotion render runs in
  // headless Chrome (window exists), so it still animates there.
  const isBrowser = typeof window !== "undefined";

  const [handle] = useState(() => (isBrowser ? delayRender(`Lottie ${item.id}`) : 0));
  const [data, setData] = useState<any | null>(inline ?? null);

  useEffect(() => {
    if (!isBrowser) return;
    setData(inline ?? null);

    // Inline data needs no fetch — release the render lock immediately.
    if (inline) {
      continueRender(handle);
      return;
    }
    if (!src) {
      continueRender(handle);
      return;
    }
    let cancelled = false;
    fetch(src)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        setData(json);
        continueRender(handle);
      })
      .catch((err) => {
        if (cancelled) return;
        cancelRender(err);
      });
    return () => {
      cancelled = true;
    };
  }, [handle, src, inline, isBrowser]);

  useEffect(() => {
    if (!isBrowser || !data || !containerRef.current) return;

    let mounted = true;

    const load = async () => {
      const lottie = (await import("lottie-web")).default;
      if (!mounted || !containerRef.current) return;

      animationRef.current?.destroy();
      animationRef.current = lottie.loadAnimation({
        container: containerRef.current,
        renderer: "svg",
        loop,
        autoplay: false,
        animationData: data,
        rendererSettings: {
          preserveAspectRatio: "xMidYMid meet",
        },
      });
      animationRef.current.goToAndStop(0, true);
    };

    load().catch((err) => {
      console.error("Failed to load Lottie animation", err);
    });

    return () => {
      mounted = false;
      animationRef.current?.destroy();
      animationRef.current = null;
    };
  }, [data, isBrowser, item.id, loop]);

  useEffect(() => {
    const animation = animationRef.current;
    if (!animation) return;

    const totalFrames = Math.max(animation.getDuration(true), 1);
    const lottieFrame = (frame * speed * totalFrames) / Math.max(fps, 1);
    const targetFrame = loop
      ? ((lottieFrame % totalFrames) + totalFrames) % totalFrames
      : Math.min(lottieFrame, totalFrames - 1);

    animation.goToAndStop(targetFrame, true);
  }, [fps, frame, loop, speed]);

  const children = (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%" }}
    />
  );

  return BaseSequence({ item, options, children });
};

export default LottieItem;
