import { IVideo } from "@designcombo/types";
import { BaseSequence, SequenceItemOptions } from "../base-sequence";
import { BoxAnim, ContentAnim, MaskAnim } from "@designcombo/animations";
import { calculateContainerStyles, calculateMediaStyles } from "../styles";
import { getAnimations } from "../../utils/get-animations";
import { calculateFrames } from "../../utils/frames";
import { OffthreadVideo, Video as RemotionVideo, Sequence, getRemotionEnvironment } from "remotion";
import { kenBurnsTransform } from "./ken-burns";
import { resolveAssetUrl } from "../../utils/asset-url";
import { makeVolumeFn } from "../../utils/volume-envelope";
import { hasSpeedEnvelope, buildSpeedZones, flatSpeed } from "../../utils/speed-envelope";

export const Video = ({
  item,
  options
}: {
  item: IVideo;
  options: SequenceItemOptions;
}) => {
  const { fps, frame } = options;
  const { details, animations } = item;
  const playbackRate = item.playbackRate || 1;
  // Trim → source frames, with the WHOLE clip as the default when trim is absent. AI-added clips
  // often carry no `trim`, and the old `item.trim?.from!` then yielded startFrom=NaN — a frame the
  // <video> can never seek to, so the player waited forever on it → the "Buffering…" that never
  // clears while the exact same url plays instantly in a new tab. audio.tsx already defaults trim;
  // this brings video.tsx in line.
  const trimFromMs = item.trim?.from ?? 0;
  const trimToMs = item.trim?.to ?? Math.max(item.display.to - item.display.from, 1);
  const startFromFrame = Math.max(0, Math.round((trimFromMs / 1000) * fps));
  const endAtFrame = Math.max(startFromFrame + 1, Math.round((trimToMs / 1000) * fps));
  const { animationIn, animationOut, animationTimed } = getAnimations(
    animations!,
    item,
    frame,
    fps
  );
  const crop = details?.crop || {
    x: 0,
    y: 0,
    width: details.width,
    height: details.height
  };
  const { durationInFrames } = calculateFrames(item.display, fps);
  const currentFrame = (frame || 0) - (item.display.from * fps) / 1000;

  // Volume: a flat number, or a per-frame curve when the clip has a volume envelope.
  const volume = makeVolumeFn({
    keyframes: (details as any).volumeKeyframes,
    volume: details.volume,
    muted: options.isMuted,
    durationInFrames: Math.max(1, Math.round(durationInFrames)),
  });

  // GPU-layer promotion (will-change) only in the interactive player — during an
  // offline render it pins a full-res backing texture per clip and wastes RAM.
  const promoteLayer = !getRemotionEnvironment().isRendering;

  // Interactive preview plays through the NATIVE <Video> — it streams progressively over range
  // requests exactly like opening the url in a new tab (instant, no stall). <OffthreadVideo> is a
  // frame EXTRACTOR; in the live player it stalled a single fresh clip on "Buffering…" for minutes
  // while that very url played instantly in a new tab (isolated with a 1-clip, no-cors, warmed test).
  // Keep OffthreadVideo for the offline render, where exact-frame extraction is what it's for.
  const VideoComp = promoteLayer ? RemotionVideo : OffthreadVideo;

  // Variable speed (speed ramp): sample the curve into constant-speed ZONES, each just a normal
  // constant-playbackRate <Video> inside its own <Sequence>. A variable ramp is only many small
  // constant pieces — no per-frame time-remap. No zones (curve flat or absent) → the single clip
  // renders exactly as before (byte-identical). Zones wrap ONLY the video; the animation wrappers
  // stay at item level, and constant playbackRate is honoured identically by native <Video> and
  // <OffthreadVideo>, so preview and render agree.
  const speedKf = (details as any).speedKeyframes;
  const speedZones = hasSpeedEnvelope(speedKf)
    ? buildSpeedZones(speedKf, {
        durationInFrames: Math.max(1, Math.round(durationInFrames)),
        srcStartFrame: startFromFrame,
        srcEndFrame: endAtFrame,
        slices: 12,
      })
    : null;
  const flatRate = speedZones ? null : flatSpeed(speedKf); // a flat curve = plain constant speed
  const effectiveRate = flatRate ?? playbackRate;
  // Preload each zone's <Video> a beat BEFORE it goes live, so swapping the clip at a zone boundary
  // doesn't flash a black frame while the fresh element seeks + decodes (the "black once, gone after
  // scrubbing" hitch). Only matters in the interactive preview — the offline render extracts frames
  // and never swaps a live element. ~0.8s of lead.
  const zonePremount = promoteLayer ? Math.max(6, Math.round(fps * 0.8)) : 0;

  // Ken Burns: optional slow pan/zoom (subtle motion on archival footage too).
  const kbTransform = kenBurnsTransform(
    (details as any)?.kenBurns,
    currentFrame,
    durationInFrames,
    {
      intensity: (details as any)?.kenBurnsIntensity,
      smooth: (details as any)?.kenBurnsSmooth,
      duration: (details as any)?.kenBurnsDuration,
    }
  );

  // One place the <Video> is described, reused by the single-clip path and by each speed zone.
  const srcUrl = resolveAssetUrl(details.src);
  const mediaStyle = {
    width: "100%",
    height: "100%",
    objectFit: "cover" as const,
    display: "block" as const,
    ...(kbTransform
      ? {
          transform: kbTransform,
          transformOrigin: "center center",
          ...(promoteLayer ? { willChange: "transform", backfaceVisibility: "hidden" as const } : {}),
        }
      : {}),
  };
  // A per-frame volume curve is item-relative; inside a zone the frame resets, so sample the curve
  // once at the zone's midpoint (a constant per zone). Flat volume passes straight through.
  const zoneVolume = (z: { outFromFrame: number; outFrames: number }) =>
    typeof volume === "function" ? volume(z.outFromFrame + Math.floor(z.outFrames / 2)) : volume;
  // NO crossOrigin — the preview only PLAYS the clip (like opening the url in a new tab), so a
  // plain no-cors load can never be CORS-blocked or die on a poisoned opaque cache entry. Harmless
  // during headless render (CORS doesn't apply; R2 sends ACAO:*).
  const renderClip = (startFrom: number, rate: number, vol: number | ((f: number) => number)) => (
    <VideoComp
      startFrom={startFrom}
      endAt={endAtFrame}
      playbackRate={rate}
      src={srcUrl}
      volume={vol}
      style={mediaStyle}
    />
  );

  const children = (
    <BoxAnim
      style={calculateContainerStyles(details, crop, {
        overflow: "hidden"
      })}
      animationIn={animationIn}
      animationOut={animationOut}
      frame={currentFrame}
      durationInFrames={durationInFrames}
    >
      <ContentAnim
        animationTimed={animationTimed}
        durationInFrames={durationInFrames}
        frame={currentFrame}
      >
        <MaskAnim
          item={item}
          keyframeAnimations={animationTimed}
          frame={frame || 0}
        >
          <div
            style={{
              ...calculateMediaStyles(details, crop),
              ...(kbTransform ? { overflow: "hidden" } : {})
            }}
          >
            {speedZones
              ? speedZones.map((z, i) => (
                  // Each zone is a constant-speed clip covering its slice of the item timeline.
                  // Default layout (AbsoluteFill) — premountFor needs it (it hides the premounted
                  // clip with opacity:0, and throws on layout="none"). The media div is positioned
                  // at the media's size, so the fill matches the single-clip path exactly.
                  <Sequence
                    key={i}
                    from={z.outFromFrame}
                    durationInFrames={z.outFrames}
                    premountFor={zonePremount}
                  >
                    {renderClip(Math.round(z.srcStartFrame), z.speed, zoneVolume(z))}
                  </Sequence>
                ))
              : renderClip(startFromFrame, effectiveRate, volume)}
          </div>
        </MaskAnim>
      </ContentAnim>
    </BoxAnim>
  );

  return BaseSequence({ item, options, children });
};

export default Video;
