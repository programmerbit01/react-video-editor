import { IVideo } from "@designcombo/types";
import { BaseSequence, SequenceItemOptions } from "../base-sequence";
import { BoxAnim, ContentAnim, MaskAnim } from "@designcombo/animations";
import { calculateContainerStyles, calculateMediaStyles } from "../styles";
import { getAnimations } from "../../utils/get-animations";
import { calculateFrames } from "../../utils/frames";
import { OffthreadVideo, getRemotionEnvironment } from "remotion";
import { kenBurnsTransform } from "./ken-burns";
import { resolveAssetUrl } from "../../utils/asset-url";

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
              startFrom={(item.trim?.from! / 1000) * fps}
              endAt={(item.trim?.to! / 1000) * fps || 1 / fps}
              playbackRate={playbackRate}
              src={resolveAssetUrl(details.src)}
              // Load the SAME way the filmstrip + poster capture do (crossOrigin). Without
              // this the preview player loaded the clip non-cors → the browser cached an
              // opaque entry → the crossOrigin filmstrip/poster load of the very same url was
              // then CORS-blocked AND stored as a second cache entry, so one clip downloaded
              // twice. Consistent crossOrigin = one shared cache entry, no CORS error.
              // Harmless during headless render (CORS doesn't apply there); R2 sends ACAO:*.
              crossOrigin="anonymous"
              volume={options.isMuted ? 0 : (details.volume ?? 100) / 100}
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
