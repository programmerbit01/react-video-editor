import { Player } from "../player";
import { useRef, useImperativeHandle, forwardRef } from "react";
import useStore from "../store/use-store";
import StateManager, { DESIGN_RESIZE } from "@designcombo/state";
import SceneEmpty from "./empty";
import Board from "./board";
import useZoom from "../hooks/use-zoom";
import { SceneInteractions } from "./interactions";
import { SceneRef } from "./scene.types";
import { dispatch } from "@designcombo/events";

const CANVAS_OPTIONS = [
  { label: "9:16", width: 1080, height: 1920 },
  { label: "16:9", width: 1920, height: 1080 },
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
      <div className="pointer-events-none absolute right-4 top-4 z-[150]">
        <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-white/10 bg-black/60 px-3 py-2 backdrop-blur-sm">
          <span className="text-xs font-medium text-white/70">Canvas</span>
          <select
            value={activeCanvas}
            onChange={(event) => handleCanvasChange(event.target.value)}
            className="h-8 rounded-md border border-white/10 bg-black/70 px-2 text-sm text-white outline-none"
          >
            {CANVAS_OPTIONS.map((option) => (
              <option key={option.label} value={option.label}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {trackItemIds.length === 0 && <SceneEmpty />}
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
          <Player />
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
