import { IVideo } from "@designcombo/types";
import { BaseSequence, SequenceItemOptions } from "../base-sequence";
import { BoxAnim, ContentAnim, MaskAnim } from "@designcombo/animations";
import { calculateContainerStyles, calculateMediaStyles } from "../styles";
import { getAnimations } from "../../utils/get-animations";
import { calculateFrames } from "../../utils/frames";
import { OffthreadVideo, getRemotionEnvironment } from "remotion";
import { kenBurnsTransform } from "./ken-burns";
import { resolveAssetUrl } from "../../utils/asset-url";
import { makeVolumeFn } from "../../utils/volume-envelope";

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
            <OffthreadVideo
              startFrom={startFromFrame}
              endAt={endAtFrame}
              playbackRate={playbackRate}
              src={resolveAssetUrl(details.src)}
              // NO crossOrigin — the preview player only PLAYS the clip (exactly like opening
              // the url in a new tab), so a plain no-cors load is correct: it can never be
              // CORS-blocked, and it plays even off a cache entry another no-cors load created,
              // so playback never dies with MEDIA_ELEMENT_ERROR code 4 (the black-preview bug).
              // The filmstrip/crop still load cors to canvas-read frames; if this no-cors load
              // cached the clip first they simply fall back to the server poster — the player is
              // never held hostage to a frame-capture surface.
              // Harmless during headless render (CORS doesn't apply there); R2 sends ACAO:*.
              volume={volume}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
                ...(kbTransform
                  ? {
                      transform: kbTransform,
                      transformOrigin: "center center",
                      ...(promoteLayer
                        ? { willChange: "transform", backfaceVisibility: "hidden" as const }
                        : {}),
                    }
                  : {})
              }}
            />
          </div>
        </MaskAnim>
      </ContentAnim>
    </BoxAnim>
  );

  return BaseSequence({ item, options, children });
};

export default Video;
