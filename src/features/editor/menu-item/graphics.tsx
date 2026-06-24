import { useState } from "react";
import { generateId } from "@designcombo/timeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getCurrentTime } from "../utils/time";
import { getStateManagerRef } from "../utils/state-manager-ref";
import useStore from "../store/use-store";
import { Plus, Trash2 } from "lucide-react";

type GraphicType = "barchart" | "linechart" | "statcard" | "bulletlist";

interface DataRow {
  label: string;
  value: string;
}

const TAB_STYLE = (active: boolean): React.CSSProperties => ({
  flex: 1,
  padding: "6px 4px",
  fontSize: 11,
  fontWeight: active ? 600 : 400,
  background: active ? "rgba(108,99,255,0.2)" : "transparent",
  color: active ? "#a78bfa" : "rgba(255,255,255,0.5)",
  border: `1px solid ${active ? "rgba(108,99,255,0.5)" : "rgba(255,255,255,0.1)"}`,
  borderRadius: 6,
  cursor: "pointer",
  transition: "all 0.15s"
});

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 11,
  color: "rgba(255,255,255,0.5)",
  marginBottom: 4,
  display: "block"
};

function addGraphicItem(
  type: GraphicType,
  details: Record<string, unknown>,
  durationMs: number
) {
  const sm = getStateManagerRef();
  if (!sm) return;

  const state = sm.getState();
  const from = getCurrentTime();
  const to = from + durationMs;
  const id = generateId();
  // Seek 2 seconds into the clip after adding so the animation is fully
  // complete in the preview (bars grown, line drawn, stat counted up, etc.)
  const previewMs = from + Math.min(2000, durationMs * 0.5);
  const fps = useStore.getState().fps || 30;
  const playerRef = useStore.getState().playerRef;
  setTimeout(() => {
    playerRef?.current?.seekTo(Math.round((previewMs / 1000) * fps));
  }, 80);

  const newItem = {
    id,
    name: type,
    type,
    display: { from, to },
    details,
    metadata: {}
  };

  // Find or create a suitable track ("helper" type accepts overlay items)
  let tracks: any[] = [...(state.tracks || [])];
  let targetTrack = tracks.find(
    (t: any) => t.type === "helper" || t.type === "image"
  );

  if (!targetTrack) {
    targetTrack = {
      id: generateId(),
      type: "helper",
      items: [],
      muted: false,
      accepts: []
    };
    tracks = [...tracks, targetTrack];
  } else {
    // Replace the track object so we don't mutate in place
    tracks = tracks.map((t: any) =>
      t.id === targetTrack.id
        ? { ...t, items: [...t.items, id] }
        : t
    );
    // Mark the track as already updated
    targetTrack = null;
  }

  // If we just created a new track, add the item id to it
  if (targetTrack) {
    tracks = tracks.map((t: any) =>
      t.id === targetTrack.id
        ? { ...t, items: [id] }
        : t
    );
  }

  const trackItemsMap = { ...(state.trackItemsMap || {}), [id]: newItem };
  const trackItemIds = [...(state.trackItemIds || []), id];
  const duration = Math.max(state.duration || 0, to);

  sm.updateState(
    { trackItemsMap, trackItemIds, tracks, duration },
    { updateHistory: true, kind: "add" }
  );
}

export const Graphics = () => {
  const [activeType, setActiveType] = useState<GraphicType>("barchart");
  const [duration, setDuration] = useState(7);

  // Bar / Line chart state
  const [chartTitle, setChartTitle] = useState("");
  const [chartColor, setChartColor] = useState("#6c63ff");
  const [dataRows, setDataRows] = useState<DataRow[]>([
    { label: "A", value: "100" },
    { label: "B", value: "200" }
  ]);

  // Stat card state
  const [statValue, setStatValue] = useState("1000");
  const [statLabel, setStatLabel] = useState("");
  const [statPrefix, setStatPrefix] = useState("");
  const [statSuffix, setStatSuffix] = useState("");

  // Bullet list state
  const [bulletTitle, setBulletTitle] = useState("");
  const [bulletEmoji, setBulletEmoji] = useState("✅");
  const [bulletItems, setBulletItems] = useState(
    "First point\nSecond point\nThird point"
  );

  const addDataRow = () =>
    setDataRows((prev) => [...prev, { label: "", value: "0" }]);

  const removeDataRow = (i: number) =>
    setDataRows((prev) => prev.filter((_, idx) => idx !== i));

  const updateRow = (i: number, field: keyof DataRow, val: string) =>
    setDataRows((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, [field]: val } : r))
    );

  const handleAdd = () => {
    let details: Record<string, unknown> = {};

    if (activeType === "barchart") {
      details = {
        title: chartTitle,
        color: chartColor,
        data: dataRows.map((r) => ({
          label: r.label,
          value: Number(r.value) || 0
        }))
      };
    } else if (activeType === "linechart") {
      details = {
        title: chartTitle,
        color: chartColor,
        points: dataRows.map((r) => ({
          label: r.label,
          value: Number(r.value) || 0
        }))
      };
    } else if (activeType === "statcard") {
      details = {
        value: Number(statValue) || 0,
        label: statLabel,
        prefix: statPrefix,
        suffix: statSuffix
      };
    } else if (activeType === "bulletlist") {
      details = {
        title: bulletTitle,
        emoji: bulletEmoji,
        items: bulletItems.split("\n").filter((s) => s.trim() !== "")
      };
    }

    addGraphicItem(activeType, details, duration * 1000);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        overflow: "hidden"
      }}
    >
      <div
        style={{
          padding: "12px 12px 8px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          flexShrink: 0
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "#fff",
            marginBottom: 10
          }}
        >
          Graphics
        </div>
        <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
          {(["barchart", "linechart", "statcard"] as GraphicType[]).map(
            (t) => (
              <button
                key={t}
                style={TAB_STYLE(activeType === t)}
                onClick={() => setActiveType(t)}
              >
                {t === "barchart" ? "Bar" : t === "linechart" ? "Line" : "Stat"}
              </button>
            )
          )}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            style={{
              ...TAB_STYLE(activeType === "bulletlist"),
              flex: "none",
              width: "100%"
            }}
            onClick={() => setActiveType("bulletlist")}
          >
            Bullet List
          </button>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px",
          display: "flex",
          flexDirection: "column",
          gap: 10
        }}
      >
        {/* Bar chart / Line chart fields */}
        {(activeType === "barchart" || activeType === "linechart") && (
          <>
            <div>
              <label style={LABEL_STYLE}>Title</label>
              <Input
                value={chartTitle}
                onChange={(e) => setChartTitle(e.target.value)}
                placeholder="Chart title..."
                className="h-7 text-xs"
              />
            </div>
            <div>
              <label style={LABEL_STYLE}>Color</label>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="color"
                  value={chartColor}
                  onChange={(e) => setChartColor(e.target.value)}
                  style={{
                    width: 32,
                    height: 28,
                    border: "1px solid rgba(255,255,255,0.2)",
                    borderRadius: 4,
                    cursor: "pointer",
                    background: "transparent",
                    padding: 2
                  }}
                />
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
                  {chartColor}
                </span>
              </div>
            </div>
            <div>
              <label style={LABEL_STYLE}>Data rows</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {dataRows.map((row, i) => (
                  <div
                    key={i}
                    style={{ display: "flex", gap: 4, alignItems: "center" }}
                  >
                    <Input
                      value={row.label}
                      onChange={(e) => updateRow(i, "label", e.target.value)}
                      placeholder="Label"
                      className="h-7 text-xs"
                      style={{ flex: 2 }}
                    />
                    <Input
                      value={row.value}
                      onChange={(e) => updateRow(i, "value", e.target.value)}
                      placeholder="Value"
                      type="number"
                      className="h-7 text-xs"
                      style={{ flex: 1 }}
                    />
                    <button
                      onClick={() => removeDataRow(i)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "rgba(255,255,255,0.3)",
                        padding: "2px",
                        display: "flex",
                        alignItems: "center"
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={addDataRow}
                style={{
                  marginTop: 6,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 11,
                  color: "#a78bfa",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0
                }}
              >
                <Plus size={12} /> Add Row
              </button>
            </div>
          </>
        )}

        {/* Stat card fields */}
        {activeType === "statcard" && (
          <>
            <div>
              <label style={LABEL_STYLE}>Value</label>
              <Input
                value={statValue}
                onChange={(e) => setStatValue(e.target.value)}
                type="number"
                placeholder="1000000"
                className="h-7 text-xs"
              />
            </div>
            <div>
              <label style={LABEL_STYLE}>Label</label>
              <Input
                value={statLabel}
                onChange={(e) => setStatLabel(e.target.value)}
                placeholder="People agree"
                className="h-7 text-xs"
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={LABEL_STYLE}>Prefix</label>
                <Input
                  value={statPrefix}
                  onChange={(e) => setStatPrefix(e.target.value)}
                  placeholder="$"
                  className="h-7 text-xs"
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={LABEL_STYLE}>Suffix</label>
                <Input
                  value={statSuffix}
                  onChange={(e) => setStatSuffix(e.target.value)}
                  placeholder="%"
                  className="h-7 text-xs"
                />
              </div>
            </div>
          </>
        )}

        {/* Bullet list fields */}
        {activeType === "bulletlist" && (
          <>
            <div>
              <label style={LABEL_STYLE}>Title</label>
              <Input
                value={bulletTitle}
                onChange={(e) => setBulletTitle(e.target.value)}
                placeholder="Key Facts"
                className="h-7 text-xs"
              />
            </div>
            <div>
              <label style={LABEL_STYLE}>Emoji</label>
              <Input
                value={bulletEmoji}
                onChange={(e) => setBulletEmoji(e.target.value)}
                placeholder="✅"
                className="h-7 text-xs"
                style={{ width: 80 }}
              />
            </div>
            <div>
              <label style={LABEL_STYLE}>Items (one per line)</label>
              <textarea
                value={bulletItems}
                onChange={(e) => setBulletItems(e.target.value)}
                placeholder={"First point\nSecond point\nThird point"}
                rows={5}
                style={{
                  width: "100%",
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 6,
                  color: "#fff",
                  fontSize: 12,
                  padding: "6px 8px",
                  resize: "vertical",
                  outline: "none",
                  boxSizing: "border-box",
                  fontFamily: "inherit"
                }}
              />
            </div>
          </>
        )}

        {/* Duration */}
        <div>
          <label style={LABEL_STYLE}>Duration (seconds)</label>
          <Input
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value) || 5)}
            type="number"
            min={1}
            max={300}
            className="h-7 text-xs"
          />
        </div>
      </div>

      <div
        style={{
          padding: "10px 12px",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          flexShrink: 0
        }}
      >
        <Button
          onClick={handleAdd}
          className="w-full h-8 text-xs cursor-pointer"
        >
          + Add to Timeline
        </Button>
      </div>
    </div>
  );
};
