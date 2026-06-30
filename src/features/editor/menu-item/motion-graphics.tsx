import { useState } from "react";
import { generateId } from "@designcombo/timeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getCurrentTime } from "../utils/time";
import { getStateManagerRef } from "../utils/state-manager-ref";
import useStore from "../store/use-store";
import { Loader2, Sparkles } from "lucide-react";

// Curated, locally-bundled Lottie presets. They are fetched from /public and
// embedded inline at add-time (no render-time network fetch — render-box-proof).
// Add more by dropping a .json in public/lottie and listing it here.
const PRESETS: { id: string; label: string; file: string }[] = [
  { id: "sample-1", label: "Animation 1", file: "/lottie/sample-1.json" },
  { id: "sample-2", label: "Animation 2", file: "/lottie/sample-2.json" },
  { id: "sample-3", label: "Animation 3", file: "/lottie/sample-3.json" },
];

const withEditorBase = (path: string) => {
  if (typeof window === "undefined") return path;
  if (window.location.pathname.startsWith("/editor")) return `/editor${path}`;
  return path;
};

const LABEL: React.CSSProperties = {
  fontSize: 11,
  color: "rgba(255,255,255,0.5)",
  marginBottom: 4,
  display: "block",
};

// Insert a Lottie item onto the timeline. Stored as an "image" item with
// metadata.graphicType === "lottie" (same trick as charts) so designcombo's
// track machinery works unchanged; the player routes it to the Lottie renderer.
function addLottieItem(
  details: Record<string, unknown>,
  durationMs: number,
) {
  const sm = getStateManagerRef();
  if (!sm) return;

  const state = sm.getState();
  const from = getCurrentTime();
  const to = from + durationMs;
  const id = generateId();
  const size = useStore.getState().size;

  const newItem = {
    id,
    name: "lottie",
    type: "image",
    display: { from, to },
    details: {
      width: size.width,
      height: size.height,
      top: "0px",
      left: "0px",
      loop: true,
      speed: 1,
      ...details,
    },
    metadata: { graphicType: "lottie" },
  };

  let tracks: any[] = [...(state.tracks || [])];
  let targetTrack = tracks.find(
    (t: any) => t.type === "helper" || t.type === "image",
  );
  if (!targetTrack) {
    const tid = generateId();
    tracks = [...tracks, { id: tid, type: "helper", items: [id], muted: false, accepts: [] }];
  } else {
    tracks = tracks.map((t: any) =>
      t.id === targetTrack.id ? { ...t, items: [...t.items, id] } : t,
    );
  }

  const trackItemsMap = { ...(state.trackItemsMap || {}), [id]: newItem };
  const trackItemIds = [...(state.trackItemIds || []), id];
  const duration = Math.max(state.duration || 0, to);

  sm.updateState(
    { trackItemsMap, trackItemIds, tracks, duration },
    { updateHistory: true, kind: "add" },
  );
}

export const MotionGraphics = () => {
  const [duration, setDuration] = useState(5);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const addPreset = async (p: (typeof PRESETS)[number]) => {
    setBusy(p.id);
    try {
      const res = await fetch(withEditorBase(p.file));
      const animationData = await res.json();
      addLottieItem({ animationData }, duration * 1000);
    } catch {
      // ignore — nothing added if the preset can't load
    } finally {
      setBusy(null);
    }
  };

  const addUrl = () => {
    const src = url.trim();
    if (!src) return;
    addLottieItem({ src }, duration * 1000);
    setUrl("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
      <div style={{ padding: "12px 12px 8px", borderBottom: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#fff", marginBottom: 4 }}>
          Motion Graphics
        </div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
          Animated Lottie overlays — lower-thirds, intros, callouts.
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label style={LABEL}>Duration (seconds)</label>
          <Input
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value) || 5)}
            type="number"
            min={1}
            max={300}
            className="h-7 text-xs"
          />
        </div>

        <div>
          <label style={LABEL}>Presets (click to add)</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => addPreset(p)}
                disabled={busy !== null}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  fontSize: 12,
                  color: "#fff",
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 6,
                  cursor: busy ? "default" : "pointer",
                  textAlign: "left",
                }}
              >
                {busy === p.id ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} className="text-amber-300" />}
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label style={LABEL}>Or paste a LottieFiles JSON URL</label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://assets.lottiefiles.com/.../data.json"
            className="h-7 text-xs"
          />
          <p style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 4, lineHeight: 1.4 }}>
            Tip: open any animation on lottiefiles.com, copy its Lottie JSON URL, and paste it here.
          </p>
        </div>
      </div>

      <div style={{ padding: "10px 12px", borderTop: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }}>
        <Button onClick={addUrl} disabled={!url.trim()} className="w-full h-8 text-xs cursor-pointer">
          + Add URL to Timeline
        </Button>
      </div>
    </div>
  );
};

export default MotionGraphics;
