import { useMemo } from "react";
import Composition from "../features/editor/player/composition";
import useStore from "../features/editor/store/use-store";
import useTrackVisibilityStore from "../features/editor/store/use-track-visibility-store";

function absolutizeAssetUrl(value: string, serverOrigin: string): string {
  if (!value || typeof value !== "string") return value;
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  if (!value.startsWith("/")) return value;

  const editorOrigin = serverOrigin.replace(/\/$/, "");
  const appOrigin = editorOrigin.replace(/\/editor$/, "");

  if (value.startsWith("/editor/")) {
    return `${appOrigin}${value}`;
  }

  return `${editorOrigin}${value}`;
}

// Rewrite root-relative URLs to absolute so headless Chrome loads assets from the
// real editor server instead of the temporary Remotion bundle host.
function rewriteUrls(design: any, serverOrigin: string): any {
  const visit = (node: any): any => {
    if (typeof node === "string") return absolutizeAssetUrl(node, serverOrigin);
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;

    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = visit(value);
    }
    return out;
  };

  return visit(design);
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
      stylePack: d.metadata?.stylePack ?? "",
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!design) return null;
  return <Composition />;
};

export default RenderRoot;
