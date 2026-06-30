import { Player } from "../player";
import { useRef, useImperativeHandle, forwardRef, useEffect, useState } from "react";
import useStore from "../store/use-store";
import StateManager, { DESIGN_RESIZE } from "@designcombo/state";
import SceneEmpty from "./empty";
import Board from "./board";
import useZoom from "../hooks/use-zoom";
import { SceneInteractions } from "./interactions";
import { SceneRef } from "./scene.types";
import { dispatch } from "@designcombo/events";

const CANVAS_OPTIONS = [
  { label: "16:9", width: 1920, height: 1080 },
  { label: "9:16", width: 1080, height: 1920 },
  { label: "1:1", width: 1080, height: 1080 },
  { label: "4:5", width: 1080, height: 1350 },
  { label: "3:4", width: 1080, height: 1440 },
] as const;

const Scene = forwardRef<
  SceneRef,
  {
    stateManager: StateManager;
  }
>(({ stateManager }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { size, trackItemIds } = useStore();
  const [isMounted, setIsMounted] = useState(false);
  const { zoom, handlePinch, recalculateZoom } = useZoom(
    containerRef as React.RefObject<HTMLDivElement>,
    size
  );
  const activeCanvas =
    CANVAS_OPTIONS.find(
      (option) => option.width === size.width && option.height === size.height
    )?.label ?? `${size.width}:${size.height}`;

  const handleCanvasChange = (value: string) => {
    const selected = CANVAS_OPTIONS.find((option) => option.label === value);
    if (!selected) return;
    dispatch(DESIGN_RESIZE, {
      payload: {
        width: selected.width,
        height: selected.height,
        name: selected.label,
      },
    });
  };

  // Expose the recalculateZoom function to parent
  useImperativeHandle(ref, () => ({
    recalculateZoom
  }));

  useEffect(() => {
    setIsMounted(true);
  }, []);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        flex: 1,
        overflow: "hidden",
        background: "transparent",
        display: "flex",
        justifyContent: "center",
        alignItems: "center"
      }}
      ref={containerRef}
    >
      {isMounted && trackItemIds.length === 0 && <SceneEmpty />}
      <div
        style={{
          width: size.width,
          height: size.height,
          background: "#000000",
          transform: `scale(${zoom})`,
          position: "absolute"
        }}
        className="player-container bg-sidebar"
      >
        <div
          style={{
            position: "absolute",
            zIndex: 100,
            pointerEvents: "none",
            width: size.width,
            height: size.height,
            background: "transparent",
            boxShadow: "0 0 0 5000px var(--card)"
          }}
        />
        <Board size={size}>
          {isMounted ? <Player /> : null}
          <SceneInteractions
            stateManager={stateManager}
            containerRef={containerRef as React.RefObject<HTMLDivElement>}
            zoom={zoom}
            size={size}
          />
        </Board>
      </div>
    </div>
  );
});

Scene.displayName = "Scene";

export default Scene;
