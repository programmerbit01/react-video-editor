import { useMemo } from "react";
import Composition from "../features/editor/player/composition";
import useStore from "../features/editor/store/use-store";

// Rewrite relative /api/ paths to absolute so headless Chrome can load them.
function rewriteUrls(design: any, serverOrigin: string): any {
  const json = JSON.stringify(design);
  const rewritten = json.replace(/"\/api\//g, `"${serverOrigin}/api/`);
  return JSON.parse(rewritten);
}

interface RenderRootProps {
  design?: any;
  serverOrigin?: string;
}

const RenderRoot = ({ design, serverOrigin }: RenderRootProps) => {
  // Synchronously populate the Zustand store before Composition mounts.
  useMemo(() => {
    if (!design) return;
    const d = serverOrigin ? rewriteUrls(design, serverOrigin) : design;
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
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!design) return null;
  return <Composition />;
};

export default RenderRoot;
