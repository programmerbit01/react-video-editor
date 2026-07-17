import { useEffect, useRef, useState } from "react";
import { generateId } from "@designcombo/timeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getCurrentTime } from "../utils/time";
import { getStateManagerRef } from "../utils/state-manager-ref";
import useStore from "../store/use-store";
import { Loader2, Plus, Sparkles, Upload } from "lucide-react";

// Curated, locally-bundled Lottie presets. They are fetched from /public and
// embedded inline at add-time (no render-time network fetch — render-box-proof).
// Add more by dropping a .json in public/lottie and listing it here.
const DEFAULT_PRESETS: { id: string; label: string; file: string }[] = [
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

const createLottiePreviewUrl = (label: string) => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="320" height="80" viewBox="0 0 320 80">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#2b2114" />
          <stop offset="100%" stop-color="#6d4f1f" />
        </linearGradient>
      </defs>
      <rect width="320" height="80" rx="10" fill="url(#bg)" />
      <rect x="12" y="12" width="56" height="56" rx="12" fill="#ffb84d" opacity="0.95" />
      <path d="M40 24 L45 35 L58 36 L48 44 L51 56 L40 49 L29 56 L32 44 L22 36 L35 35 Z" fill="#fffaf0" />
      <text x="84" y="34" fill="#fff7e6" font-family="Arial, sans-serif" font-size="12" font-weight="700">LOTTIE</text>
      <text x="84" y="54" fill="#f6d7a7" font-family="Arial, sans-serif" font-size="11">${label}</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
};

const getDefaultLottieBox = (
  scene: { width: number; height: number },
  asset?: { w?: number; h?: number },
) => {
  const sourceW = Math.max(1, Number(asset?.w) || 500);
  const sourceH = Math.max(1, Number(asset?.h) || 500);
  const maxW = scene.width * 0.32;
  const maxH = scene.height * 0.32;
  const scale = Math.min(maxW / sourceW, maxH / sourceH, 1);
  const width = Math.max(180, Math.round(sourceW * scale));
  const height = Math.max(180, Math.round(sourceH * scale));

  return {
    width,
    height,
    left: `${Math.round((scene.width - width) / 2)}px`,
    top: `${Math.round((scene.height - height) / 2)}px`,
  };
};

// Insert a Lottie item onto the timeline. It used to be stored as an "image" with
// metadata.graphicType === "lottie" — the same disguise the charts wore, to dodge a timeline
// crash that no longer exists (see item-types.ts). An animation that calls itself a photo gets
// treated like one: FF handed it to ffmpeg as a still frame, and the export warning skipped it.
function addLottieItem(
  details: Record<string, unknown>,
  durationMs: number,
  previewUrl: string,
  label: string,
  assetSize?: { w?: number; h?: number },
  sourceUrl?: string,
  animationDataBackup?: unknown,
) {
  const sm = getStateManagerRef();
  if (!sm) return;

  const state = sm.getState();
  const from = getCurrentTime();
  const to = from + durationMs;
  const id = generateId();
  const size = useStore.getState().size;
  const box = getDefaultLottieBox(size, assetSize);

  const newItem = {
    id,
    name: "lottie",
    type: "lottie",
    display: { from, to },
    details: {
      width: box.width,
      height: box.height,
      top: box.top,
      left: box.left,
      loop: true,
      speed: 1,
      ...details,
    },
    // The rest of the metadata is real Lottie data the renderer needs — only graphicType, which
    // existed to undo the disguise, is gone.
    metadata: {
      previewUrl,
      label,
      ...(sourceUrl ? { lottieUrl: sourceUrl } : {}),
      ...(animationDataBackup ? { lottieData: animationDataBackup } : {}),
    },
  };

  let tracks: any[] = [...(state.tracks || [])];
  let targetTrack = tracks.find(
    (t: any) => t.type === "customTrack" && t.metadata?.overlayType === "lottie",
  );
  if (!targetTrack) {
    const tid = generateId();
    const overlayTrack = {
      id: tid,
      type: "customTrack",
      items: [id],
      muted: false,
      accepts: [],
      metadata: { overlayType: "lottie" },
    };
    const insertAt = Math.max(
      tracks.findIndex((t: any) => t.type === "customTrack"),
      0,
    );
    tracks =
      insertAt >= 0
        ? [
            ...tracks.slice(0, insertAt),
            overlayTrack,
            ...tracks.slice(insertAt),
          ]
        : [...tracks, overlayTrack];
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
  const [presets, setPresets] = useState(DEFAULT_PRESETS);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState("");
  const [uploadedAnimationData, setUploadedAnimationData] = useState<any | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadPresets = async () => {
    try {
      const presetsUrl = withEditorBase("/api/lottie-presets") as string;
      const res = await fetch(presetsUrl, { cache: "no-store" });
      const json = await res.json();
      if (Array.isArray(json?.presets) && json.presets.length > 0) {
        setPresets(json.presets);
      } else {
        setPresets(DEFAULT_PRESETS);
      }
    } catch {
      setPresets(DEFAULT_PRESETS);
    }
  };

  useEffect(() => {
    loadPresets();
  }, []);

  const addPreset = async (p: (typeof DEFAULT_PRESETS)[number]) => {
    setBusy(p.id);
    try {
      const res = await fetch(withEditorBase(p.file));
      const animationData = await res.json();
      addLottieItem(
        { animationData },
        duration * 1000,
        createLottiePreviewUrl(p.label),
        p.label,
        { w: animationData?.w, h: animationData?.h },
        withEditorBase(p.file),
        animationData,
      );
    } catch {
      // ignore — nothing added if the preset can't load
    } finally {
      setBusy(null);
    }
  };

  const addUrl = () => {
    const src = url.trim();
    if (!src) return;
    addLottieItem(
      { src },
      duration * 1000,
      createLottiePreviewUrl("Custom URL"),
      "Custom URL",
      undefined,
      src,
      undefined,
    );
    setUrl("");
  };

  const addUploadedJson = async (file?: File | null) => {
    if (!file) return;
    setBusy("upload-json");
    try {
      const text = await file.text();
      const animationData = JSON.parse(text);
      const label = file.name.replace(/\.json$/i, "") || "Uploaded JSON";
      setUploadedFileName(file.name);
      setUploadedAnimationData(animationData);
      addLottieItem(
        { animationData },
        duration * 1000,
        createLottiePreviewUrl(label),
        label,
        { w: animationData?.w, h: animationData?.h },
        undefined,
        animationData,
      );
    } catch {
      setUploadedFileName("");
      setUploadedAnimationData(null);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
      setBusy(null);
    }
  };

  const addUploadedToGlobalPresets = async () => {
    if (!uploadedAnimationData || !uploadedFileName) return;
    setBusy("save-global");
    try {
      const presetsUrl = withEditorBase("/api/lottie-presets") as string;
      await fetch(presetsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: uploadedFileName.replace(/\.json$/i, ""),
          animationData: uploadedAnimationData,
        }),
      });
      await loadPresets();
    } finally {
      setBusy(null);
    }
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
            {presets.map((p) => (
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
                {busy === p.id ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <img
                    src={createLottiePreviewUrl(p.label)}
                    alt={p.label}
                    style={{ width: 28, height: 28, borderRadius: 6, flexShrink: 0 }}
                  />
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span>{p.label}</span>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.5)" }}>
                    Lottie preset
                  </span>
                </div>
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

        <div>
          <label style={LABEL}>Or upload a local Lottie JSON file</label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={(e) => addUploadedJson(e.target.files?.[0] || null)}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy !== null}
            className="w-full h-8 text-xs cursor-pointer"
          >
            {busy === "upload-json" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Upload size={14} />
            )}
            <span style={{ marginLeft: 6 }}>
              {uploadedFileName ? `Uploaded: ${uploadedFileName}` : "Upload JSON"}
            </span>
          </Button>
          {uploadedAnimationData ? (
            <Button
              type="button"
              variant="secondary"
              onClick={addUploadedToGlobalPresets}
              disabled={busy !== null}
              className="w-full h-8 text-xs cursor-pointer mt-2"
            >
              {busy === "save-global" ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              <span style={{ marginLeft: 6 }}>Add Uploaded JSON to Global Presets</span>
            </Button>
          ) : null}
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
