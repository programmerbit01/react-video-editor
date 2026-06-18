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

      // Prefer design.duration; fall back to max display.to across all track items
      let durationMs = Number(design.duration) || 0;
      if (!durationMs && design.trackItemsMap) {
        const items = Object.values(design.trackItemsMap) as any[];
        durationMs = Math.max(0, ...items.map((it: any) => Number(it.display?.to) || 0));
      }
      if (!durationMs) durationMs = 5000;

      console.log("[remotion] duration:", durationMs, "ms →", Math.ceil((durationMs / 1000) * 30), "frames");

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
