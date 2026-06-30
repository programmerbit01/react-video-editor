import { useEffect, useState } from "react";
import { Lottie, LottieAnimationData } from "@remotion/lottie";
import { cancelRender, continueRender, delayRender } from "remotion";
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
  const inline: LottieAnimationData | undefined = details.animationData;
  const src: string = details.src || (item as any).metadata?.lottieUrl || "";
  const loop = details.loop !== false; // default: loop the animation
  const speed = Number(details.speed) || 1;

  // lottie-web is browser-only. During Next.js SSR (no window) we must NOT render
  // it or call delayRender — both crash on the server. The Remotion render runs in
  // headless Chrome (window exists), so it still animates there.
  const isBrowser = typeof window !== "undefined";

  const [handle] = useState(() => (isBrowser ? delayRender(`Lottie ${item.id}`) : 0));
  const [data, setData] = useState<LottieAnimationData | null>(inline ?? null);

  useEffect(() => {
    if (!isBrowser) return;
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
      .catch((err) => cancelRender(err));
    return () => {
      cancelled = true;
    };
  }, [handle, src, inline, isBrowser]);

  const children =
    isBrowser && data ? (
      <Lottie
        animationData={data}
        loop={loop}
        playbackRate={speed}
        style={{ width: "100%", height: "100%" }}
      />
    ) : null;

  return BaseSequence({ item, options, children });
};

export default LottieItem;
