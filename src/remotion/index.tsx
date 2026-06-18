import { registerRoot, Composition } from "remotion";
import RenderRoot from "./root";

// Entry point bundled by @remotion/bundler for server-side renderMedia.
// calculateMetadata reads the actual design dimensions/duration from inputProps
// so selectComposition() returns accurate values without a separate config step.
const RemotionRoot = () => (
  <Composition
    id="main"
    component={RenderRoot}
    fps={30}
    width={1920}
    height={1080}
    durationInFrames={300}
    defaultProps={{ design: null, serverOrigin: "" }}
    calculateMetadata={async ({ props }) => {
      const design = (props as any).design;
      if (!design) return {};
      const durationMs = Number(design.duration) || 5000;
      return {
        fps: 30,
        durationInFrames: Math.max(1, Math.ceil((durationMs / 1000) * 30)),
        width: Number(design.size?.width) || 1920,
        height: Number(design.size?.height) || 1080,
      };
    }}
  />
);

registerRoot(RemotionRoot);
