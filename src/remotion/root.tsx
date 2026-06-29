import { useMemo } from "react";
import Composition from "../features/editor/player/composition";
import useStore from "../features/editor/store/use-store";
import useTrackVisibilityStore from "../features/editor/store/use-track-visibility-store";

// Rewrite relative /api/ paths to absolute so headless Chrome can load them.
function rewriteUrls(design: any, serverOrigin: string): any {
  const json = JSON.stringify(design);
  const rewritten = json.replace(/"\/api\//g, `"${serverOrigin}/api/`);
  return JSON.parse(rewritten);
}

interface RenderRootProps {
  design?: any;
  serverOrigin?: string;
  mutedMap?: Record<string, boolean>;
  hiddenMap?: Record<string, boolean>;
}

const RenderRoot = ({ design, serverOrigin, mutedMap = {}, hiddenMap = {} }: RenderRootProps) => {
  // Synchronously populate the Zustand stores before Composition mounts.
  useMemo(() => {
    if (!design) return;
    const d = serverOrigin ? rewriteUrls(design, serverOrigin) : design;
    useTrackVisibilityStore.setState({ muted: mutedMap, hidden: hiddenMap });
    useStore.setState({
      trackItemIds: d.trackItemIds ?? [],
      trackItemsMap: d.trackItemsMap ?? {},
      transitionsMap: d.transitionsMap ?? {},
      transitionIds: d.transitionIds ?? [],
      tracks: d.tracks ?? [],
      size: d.size ?? { width: 1920, height: 1080 },
      fps: 30,
      structure: d.structure ?? [],
      duration: d.duration ?? 0,
      activeIds: [],
      sceneMoveableRef: null,
      // Phase 1 — Film Look: carried scene-wide in design.metadata.look.
      look: d.metadata?.look ?? "off",
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!design) return null;
  return <Composition />;
};

export default RenderRoot;
