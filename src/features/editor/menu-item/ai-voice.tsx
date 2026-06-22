import React, { useState, useEffect, useRef, useCallback } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, ChevronDown, Pause, Play, Upload, Music2 } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Voice, VoiceFilters } from "../interfaces/editor";

// ── helpers ────────────────────────────────────────────────────────────────
function getVappParams() {
  if (typeof window === "undefined") return { vappHost: "", token: "", baseUrl: "" };
  const p = new URLSearchParams(window.location.search);
  return {
    vappHost: p.get("vappHost") || `${window.location.protocol}//${window.location.hostname}`,
    token: p.get("token") || "",
    baseUrl: p.get("baseUrl") || "http://192.168.50.216:8091",
  };
}

async function uploadToR2(file: File): Promise<string> {
  const { baseUrl, token } = getVappParams();
  const form = new FormData();
  form.append("file", file);
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}/api/v1/upload_file`, { method: "POST", headers, body: form });
  if (!res.ok) { const t = await res.text(); throw new Error(`Upload failed: ${res.status} — ${t.slice(0, 120)}`); }
  const data = await res.json();
  const r2Url = data.url || data.file_url || data.storage_url;
  if (!r2Url) throw new Error("No URL from upload");
  return r2Url;
}

function relTime(iso: string) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fileBasename(url: string) {
  if (!url) return "—";
  try { return decodeURIComponent(url.split("/").pop()!.split("?")[0]) || "—"; } catch { return url.slice(-32); }
}

const API_BASE = typeof window !== "undefined" && window.location.pathname.startsWith("/editor") ? "/editor" : "";

// ── Voice Over sub-panel ───────────────────────────────────────────────────
function VoiceOverPanel() {
  const [activeTab, setActiveTab] = useState<"new" | "history">("new");

  // new conversion
  const [srcFile, setSrcFile] = useState<File | null>(null);
  const [srcBlobUrl, setSrcBlobUrl] = useState<string>("");
  const [smpFile, setSmpFile] = useState<File | null>(null);
  const [smpBlobUrl, setSmpBlobUrl] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState("");
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [resultUrl, setResultUrl] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const srcRef = useRef<HTMLInputElement>(null);
  const smpRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const t0Ref = useRef<number>(0);

  // history
  const HIST_SIZE = 10;
  const [history, setHistory] = useState<any[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [histTotal, setHistTotal] = useState(0);
  const [histItem, setHistItem] = useState<any>(null);
  const [histPage, setHistPage] = useState(1);
  const [histHasMore, setHistHasMore] = useState(false);
  const histListRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);

  const loadHistory = useCallback(async (page = 1, append = false) => {
    if (loadingMoreRef.current && append) return;
    if (!append) setHistLoading(true);
    else loadingMoreRef.current = true;
    try {
      const { baseUrl, token } = getVappParams();
      const qs = new URLSearchParams({ baseUrl, token, page: String(page), perPage: String(HIST_SIZE) });
      const res = await fetch(`${API_BASE}/api/voiceover?${qs}`);
      if (!res.ok) return;
      const data = await res.json();
      const items = (data.items || []).filter((j: any) => j.app_name === "voiceover");
      const total = data.totalItems ?? items.length;
      const totalPages = data.totalPages ?? Math.ceil(total / HIST_SIZE);
      setHistTotal(total);
      setHistHasMore(page < totalPages);
      setHistPage(page);
      if (append) setHistory(prev => [...prev, ...items]);
      else setHistory(items);
    } catch {}
    finally { setHistLoading(false); loadingMoreRef.current = false; }
  }, []);

  useEffect(() => { loadHistory(1, false); }, [loadHistory]);

  useEffect(() => {
    const el = histListRef.current;
    if (!el) return;
    const onScroll = () => {
      if (loadingMoreRef.current || !histHasMore) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) loadHistory(histPage + 1, true);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [loadHistory, histHasMore, histPage]);

  useEffect(() => () => {
    if (srcBlobUrl) URL.revokeObjectURL(srcBlobUrl);
    if (smpBlobUrl) URL.revokeObjectURL(smpBlobUrl);
  }, [srcBlobUrl, smpBlobUrl]);

  const stopTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };

  const convert = async () => {
    if (!srcFile || !smpFile || loading) return;
    setLoading(true); setErr(""); setResultUrl(""); setStep("Uploading files…");
    stopTimer();
    t0Ref.current = Date.now(); setElapsed(0);
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - t0Ref.current) / 1000)), 1000);
    try {
      const { baseUrl, token } = getVappParams();

      const [srcUrl, smpUrl] = await Promise.all([uploadToR2(srcFile), uploadToR2(smpFile)]);

      setStep("Queued…");
      const sr = await fetch(`${API_BASE}/api/voiceover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, token, source_audio_url: srcUrl, voice_sample_url: smpUrl, speaker_count: 1 }),
      });
      if (!sr.ok) { const t = await sr.json().catch(() => ({})); throw new Error(t?.message || "Failed to start voiceover"); }
      const { job_id } = await sr.json();
      setStep("Converting voice…");

      const pollQs = new URLSearchParams({ baseUrl, token });
      for (let i = 0; i < 300; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const pr = await fetch(`${API_BASE}/api/voiceover/${job_id}?${pollQs}`);
        if (!pr.ok) { if (pr.status >= 500) continue; break; }
        const pd = await pr.json();
        if (pd.done) {
          const out = pd.output_url || pd.generation_details?.output_audio_url || "";
          if (!out) throw new Error("Done but no output URL");
          setResultUrl(out);
          toast.success("Voice conversion complete!");
          loadHistory(1, false);
          return;
        }
        if (pd.failed) throw new Error(pd.message || "Voiceover failed");
      }
      throw new Error("Timed out");
    } catch (e: any) {
      setErr(e.message || "Request failed");
      toast.error(e.message || "Voice conversion failed");
    } finally {
      stopTimer();
      setElapsed(t0Ref.current ? Math.floor((Date.now() - t0Ref.current) / 1000) : null);
      setLoading(false); setStep("");
    }
  };

  const TAB = (active: boolean) => ({
    padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer" as const,
    fontWeight: active ? 700 : 500, fontSize: 12,
    background: active ? "rgba(255,107,0,0.15)" : "transparent",
    color: active ? "#ff6b00" : "#888",
  });

  const AudioCard = ({ label, file, blobUrl, inputRef, onFile }: {
    label: string; file: File | null; blobUrl: string;
    inputRef: React.RefObject<HTMLInputElement | null>;
    onFile: (f: File) => void;
  }) => (
    <div style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 8, overflow: "hidden", marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", cursor: "pointer" }}
        onClick={() => inputRef.current?.click()}>
        <div style={{ width: 28, height: 28, borderRadius: 6, background: file ? "rgba(255,107,0,0.12)" : "#222", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Upload size={13} color={file ? "#ff6b00" : "#555"} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 9, color: "#555", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1 }}>{label}</div>
          <div style={{ fontSize: 11, color: file ? "#dde0f0" : "#444", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
            {file ? file.name : "Drop / click to upload"}
          </div>
        </div>
        <input ref={inputRef} type="file" accept="audio/*" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
      </div>
      {blobUrl && (
        <div style={{ borderTop: "1px solid #222", padding: "4px 10px 6px" }}>
          <audio controls src={blobUrl} style={{ width: "100%", height: 26, display: "block" }} />
        </div>
      )}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* tab bar */}
      <div style={{ display: "flex", gap: 4, padding: "8px 0 10px", flexShrink: 0 }}>
        <button style={TAB(activeTab === "new")} onClick={() => setActiveTab("new")}>New Conversion</button>
        <button style={TAB(activeTab === "history")} onClick={() => { setActiveTab("history"); loadHistory(1, false); }}>
          History
          {(histTotal || history.length) > 0 && (
            <span style={{ marginLeft: 5, background: "rgba(255,107,0,0.15)", color: "#ff6b00", borderRadius: 9, padding: "1px 5px", fontSize: 9, fontWeight: 700 }}>
              {histTotal || history.length}
            </span>
          )}
        </button>
      </div>

      {/* ── NEW CONVERSION ── */}
      {activeTab === "new" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, gap: 0 }}>
          <AudioCard label="Source Audio (to convert)" file={srcFile} blobUrl={srcBlobUrl} inputRef={srcRef}
            onFile={(f) => { if (srcBlobUrl) URL.revokeObjectURL(srcBlobUrl); setSrcFile(f); setSrcBlobUrl(URL.createObjectURL(f)); setResultUrl(""); setErr(""); }} />
          <AudioCard label="Voice Sample (target voice, 10–60s)" file={smpFile} blobUrl={smpBlobUrl} inputRef={smpRef}
            onFile={(f) => { if (smpBlobUrl) URL.revokeObjectURL(smpBlobUrl); setSmpFile(f); setSmpBlobUrl(URL.createObjectURL(f)); setResultUrl(""); setErr(""); }} />

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            {elapsed !== null && (
              <span style={{ fontSize: 11, fontWeight: 700, color: loading ? "#ff6b00" : "#666", background: loading ? "rgba(255,107,0,0.08)" : "#1a1a1a", border: `1px solid ${loading ? "rgba(255,107,0,0.2)" : "#2a2a2a"}`, borderRadius: 5, padding: "2px 7px" }}>
                {elapsed}s
              </span>
            )}
            <div style={{ flex: 1 }} />
            <Button size="sm" disabled={!srcFile || !smpFile || loading} onClick={convert}
              className="flex items-center gap-2">
              {loading ? <><Loader2 className="h-3 w-3 animate-spin" />{step || "Working…"}</> : <><Music2 className="h-3 w-3" />Convert Voice</>}
            </Button>
          </div>

          {/* result */}
          {(resultUrl || err || loading) && (
            <div style={{ marginTop: 10, background: "#111", border: `1px solid ${err ? "#3a1a1a" : "#1e2e1e"}`, borderRadius: 8, overflow: "hidden" }}>
              <div style={{ padding: "7px 10px", borderBottom: "1px solid #1a1a1a", display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                {loading && <Loader2 size={12} className="animate-spin" />}
                {err && <span style={{ color: "#f44336", fontWeight: 700 }}>Error</span>}
                {resultUrl && !loading && <span style={{ color: "#4caf50", fontWeight: 700 }}>Done</span>}
                {resultUrl && !loading && (
                  <a href={resultUrl} download style={{ marginLeft: "auto", color: "#ff6b00", textDecoration: "none", fontWeight: 600 }}>Download</a>
                )}
              </div>
              <div style={{ padding: 10 }}>
                {loading && <p style={{ color: "#444", fontSize: 12, margin: 0, fontStyle: "italic" }}>Processing… takes 1–3 min</p>}
                {err && <p style={{ color: "#f06060", fontSize: 12, margin: 0 }}>{err}</p>}
                {resultUrl && <audio controls src={resultUrl} autoPlay style={{ width: "100%", display: "block" }} />}
              </div>
            </div>
          )}

          {!resultUrl && !err && !loading && (
            <p style={{ color: "#333", fontSize: 12, fontStyle: "italic", marginTop: 16, textAlign: "center" }}>
              Upload source audio + voice sample, then convert
            </p>
          )}
        </div>
      )}

      {/* ── HISTORY ── */}
      {activeTab === "history" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 10, overflow: "hidden" }}>
          {/* list */}
          <div ref={histListRef} style={{ width: 200, flexShrink: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, marginBottom: 2 }}>
              <span style={{ fontSize: 10, color: "#444", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1 }}>
                {histTotal || history.length} conversions
              </span>
              <button onClick={() => loadHistory(1, false)} disabled={histLoading} style={{ background: "none", border: "none", cursor: "pointer", color: "#555", fontSize: 13 }}>
                {histLoading ? <Loader2 size={11} className="animate-spin" /> : "↻"}
              </button>
            </div>
            {!histLoading && history.length === 0 && (
              <p style={{ color: "#2a2a2a", fontSize: 11, fontStyle: "italic", textAlign: "center", padding: "16px 0" }}>No conversions yet</p>
            )}
            {history.map((item: any) => {
              const active = histItem?.id === item.id;
              const gd = item.generation_details || {};
              const srcName = fileBasename(gd.source_audio_url || item.inputs?.source_audio_url || "");
              const st = (item.status || "").toLowerCase();
              const done = st === "completed" || st === "succeeded";
              const outUrl = gd.output_audio_url || item.output_url || "";
              return (
                <button key={item.id} onClick={() => done && outUrl && setHistItem(active ? null : item)}
                  style={{ display: "flex", alignItems: "flex-start", gap: 7, width: "100%", padding: "7px 8px", borderRadius: 7, border: "none", textAlign: "left" as const, cursor: done && outUrl ? "pointer" : "default", background: active ? "rgba(255,107,0,0.08)" : "rgba(255,255,255,0.02)", outline: active ? "1px solid rgba(255,107,0,0.2)" : "none" }}>
                  <div style={{ width: 5, height: 5, borderRadius: "50%", flexShrink: 0, marginTop: 4, background: done ? "#4caf50" : st === "failed" || st === "error" ? "#f44336" : "#ff9800" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 4 }}>
                      <span style={{ color: active ? "#ff8c3a" : "#bbb", fontSize: 10, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{srcName}</span>
                      <span style={{ color: "#333", fontSize: 9, flexShrink: 0 }}>{relTime(item.created)}</span>
                    </div>
                    <span style={{ color: done && outUrl ? "#4caf50" : "#888", fontSize: 9, fontWeight: 600 }}>
                      {done && outUrl ? "converted ✓" : item.status}
                    </span>
                  </div>
                </button>
              );
            })}
            {histHasMore && (
              <button onClick={() => loadHistory(histPage + 1, true)} style={{ background: "none", border: "1px solid #2a2a2a", borderRadius: 6, color: "#555", fontSize: 10, padding: "5px 0", cursor: "pointer", width: "100%" }}>
                Load more
              </button>
            )}
          </div>

          {/* detail */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {histItem ? (() => {
              const gd = histItem.generation_details || {};
              const outUrl = gd.output_audio_url || histItem.output_url || "";
              const srcUrl = gd.source_audio_url || histItem.inputs?.source_audio_url || "";
              return (
                <>
                  {srcUrl && (
                    <div style={{ background: "#1a1a1a", borderRadius: 8, padding: "8px 10px" }}>
                      <div style={{ fontSize: 9, color: "#555", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1, marginBottom: 5 }}>Source</div>
                      <audio controls src={srcUrl} style={{ width: "100%", height: 26, display: "block" }} />
                    </div>
                  )}
                  {outUrl && (
                    <div style={{ background: "#0d180d", border: "1px solid #1a2e1a", borderRadius: 8, padding: "8px 10px" }}>
                      <div style={{ display: "flex", alignItems: "center", marginBottom: 5 }}>
                        <span style={{ fontSize: 9, color: "#4caf50", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1 }}>Converted</span>
                        <a href={outUrl} download style={{ marginLeft: "auto", fontSize: 10, color: "#ff6b00", textDecoration: "none", fontWeight: 600 }}>Download</a>
                      </div>
                      <audio controls src={outUrl} autoPlay style={{ width: "100%", display: "block" }} />
                    </div>
                  )}
                </>
              );
            })() : (
              <p style={{ color: "#2a2a2a", fontSize: 12, fontStyle: "italic", margin: "auto", textAlign: "center" }}>Select a conversion from the list</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export const AiVoice = () => {
  const [activeMainTab, setActiveMainTab] = useState<"tts" | "voiceover">("tts");
  const [text, setText] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<Voice | null>(null);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<VoiceFilters>({
    language: "all",
    gender: "all"
  });
  const [currentlyPlayingId, setCurrentlyPlayingId] = useState<string | null>(
    null
  );
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(
    null
  );
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);

  // Available filter options
  const filterOptions = {
    language: [
      "en",
      "hi",
      "es",
      "pl",
      "fr",
      "de",
      "tr",
      "hu",
      "it",
      "ru",
      "hr",
      "zh",
      "fil",
      "el",
      "fi",
      "ko",
      "no",
      "ta",
      "id",
      "ar",
      "ja",
      "ro",
      "pt",
      "cs",
      "vi",
      "sv",
      "nl",
      "da"
    ],
    gender: ["female", "male", "neutral"]
  };

  // Language display names
  const languageNames: Record<string, string> = {
    en: "English",
    hi: "Hindi",
    es: "Spanish",
    pl: "Polish",
    fr: "French",
    de: "German",
    tr: "Turkish",
    hu: "Hungarian",
    it: "Italian",
    ru: "Russian",
    hr: "Croatian",
    zh: "Chinese",
    fil: "Filipino",
    el: "Greek",
    fi: "Finnish",
    ko: "Korean",
    no: "Norwegian",
    ta: "Tamil",
    id: "Indonesian",
    ar: "Arabic",
    ja: "Japanese",
    ro: "Romanian",
    pt: "Portuguese",
    cs: "Czech",
    vi: "Vietnamese",
    sv: "Swedish",
    nl: "Dutch",
    da: "Danish"
  };

  // Handle play/pause for a specific voice
  const handlePlayPause = (voiceId: string, previewUrl: string) => {
    if (currentlyPlayingId === voiceId) {
      if (audioElement) {
        audioElement.pause();
        setCurrentlyPlayingId(null);
        setAudioElement(null);
      }
      return;
    }

    if (audioElement) {
      audioElement.pause();
    }

    const newAudio = new Audio(previewUrl);
    newAudio.addEventListener("ended", () => {
      setCurrentlyPlayingId(null);
      setAudioElement(null);
    });

    newAudio.play();
    setCurrentlyPlayingId(voiceId);
    setAudioElement(newAudio);
  };

  // Cleanup audio on component unmount
  useEffect(() => {
    return () => {
      if (audioElement) {
        audioElement.pause();
      }
    };
  }, [audioElement]);

  // Fetch voices from API
  const fetchVoices = async (queryParams?: any) => {
    setLoading(true);
    try {
      const response = await fetch("/api/voices", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          limit: 20,
          page: 1,
          query: queryParams || {}
        })
      });

      if (response.ok) {
        const data = await response.json();
        setVoices(data.voices || []);
      } else {
        console.error("Failed to fetch voices");
      }
    } catch (error) {
      console.error("Error fetching voices:", error);
    } finally {
      setLoading(false);
    }
  };

  // Load voices on component mount
  useEffect(() => {
    fetchVoices();
  }, []);

  // Apply filters automatically when filters change
  const applyFilters = (newFilters: VoiceFilters) => {
    const queryParams: any = {};
    if (newFilters.language && newFilters.language !== "all")
      queryParams.languages = [newFilters.language];
    if (newFilters.gender && newFilters.gender !== "all")
      queryParams.genders = [newFilters.gender];
    fetchVoices(queryParams);
  };

  const handleGenerate = async () => {
    if (!text.trim() || !selectedVoice) return;

    setIsGenerating(true);

    try {
      // Call the TTS API
      const response = await fetch("/api/generate-voice", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text: text.trim(),
          voiceId: selectedVoice.id,
          folder: "ai-voice-generations" // Optional folder for organization
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data = await response.json();

      // Handle successful generation
      // You can add logic here to handle the generated audio
      // For example, add it to the timeline, play it, etc.
      if (data.agent?.url) {
        console.log("Generated audio URL:", data.agent.url);
        console.log("Audio duration:", data.agent.duration);

        toast.success("Voice generated successfully!");

        // TODO: Add the generated audio to the editor timeline
        // This would typically involve calling a store action or context function
      } else {
        toast.error("Voice generation completed but no audio URL received");
      }
    } catch (error) {
      console.error("Error generating voice:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to generate voice. Please try again."
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const MTAB = (active: boolean) => ({
    padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer" as const,
    fontWeight: active ? 700 : 500, fontSize: 12,
    background: active ? "rgba(255,107,0,0.15)" : "transparent",
    color: active ? "#ff6b00" : "#888",
  });

  return (
    <div className="flex flex-1 flex-col max-w-full">
      <div className="text-text-primary flex h-12 flex-none items-center px-4 text-sm font-medium">
        AI Voice
      </div>

      {/* Main tab bar */}
      <div style={{ display: "flex", gap: 4, padding: "0 16px 10px", flexShrink: 0, borderBottom: "1px solid #1e1e1e" }}>
        <button style={MTAB(activeMainTab === "tts")} onClick={() => setActiveMainTab("tts")}>AI Voice Generation</button>
        <button style={MTAB(activeMainTab === "voiceover")} onClick={() => setActiveMainTab("voiceover")}>Voice Over</button>
      </div>

      {/* Voice Over panel */}
      {activeMainTab === "voiceover" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, padding: "10px 16px" }}>
          <VoiceOverPanel />
        </div>
      )}

      {/* TTS panel */}
      {activeMainTab === "tts" && <div className="space-y-4 p-4">
        {/* Text Input */}
        <div className="space-y-2">
          <Label className="font-sans text-xs font-semibold">
            Enter your script
          </Label>

          <Textarea
            id="text-input"
            placeholder="Type or paste your text here to generate AI voice..."
            value={text}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
              setText(e.target.value)
            }
            className="min-h-[120px] resize-none"
            disabled={isGenerating}
          />
        </div>

        {/* Voice Selection */}
        <div className="space-y-3">
          <div className="flex gap-2 min-w-0 flex-col">
            <Label className="font-sans text-xs font-semibold">
              Select voice
            </Label>
            <Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
              <PopoverTrigger asChild>
                {selectedVoice ? (
                  (() => {
                    const displayName = selectedVoice.name.split("-")[0].trim();
                    return (
                      <div
                        aria-label="Change selected voice"
                        onClick={(e) => {
                          if (
                            (e.target as HTMLElement).closest(
                              ".voice-preview-btn"
                            )
                          )
                            return;
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            if (
                              (e.target as HTMLElement).closest(
                                ".voice-preview-btn"
                              )
                            )
                              return;
                            e.preventDefault();
                            e.currentTarget.click();
                          }
                        }}
                        className={cn(
                          buttonVariants({ variant: "outline" }),
                          "flex-1 min-w-0 h-7 justify-between text-xs w-full relative"
                        )}
                      >
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-5 w-5 flex-shrink-0 p-0 hover:bg-transparent voice-preview-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePlayPause(
                                selectedVoice.id,
                                selectedVoice.previewUrl
                              );
                            }}
                          >
                            {currentlyPlayingId === selectedVoice.id ? (
                              <Pause className="h-3 w-3" />
                            ) : (
                              <Play className="h-3 w-3" />
                            )}
                          </Button>
                          <span className="truncate">{displayName}</span>
                        </div>
                        <ChevronDown className="h-4 w-4 flex-shrink-0" />
                      </div>
                    );
                  })()
                ) : (
                  <Button
                    variant="outline"
                    className="flex-1 min-w-0 h-7 justify-between text-xs w-full"
                    type="button"
                  >
                    <span className="truncate">Select voice</span>
                    <ChevronDown className="h-4 w-4 flex-shrink-0" />
                  </Button>
                )}
              </PopoverTrigger>
              <PopoverContent
                side="bottom"
                className="w-[420px] max-h-[500px] overflow-hidden bg-zinc-900 text-white p-0"
                align="start"
              >
                <div className="space-y-4">
                  {/* Filters Row */}
                  <div className="flex gap-2 mb-2 p-2">
                    <Select
                      value={filters.language}
                      onValueChange={(value) => {
                        const newFilters = { ...filters, language: value };
                        setFilters(newFilters);
                        applyFilters(newFilters);
                      }}
                    >
                      <SelectTrigger
                        id="language-select"
                        className="w-1/2 bg-zinc-800 border-zinc-700"
                      >
                        <span className="flex items-center gap-2">
                          <span className="fi fi-{filters.language}" />
                          <SelectValue placeholder="Language" />
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Languages</SelectItem>
                        {filterOptions.language.map((lang) => (
                          <SelectItem key={lang} value={lang}>
                            {languageNames[lang] || lang}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={filters.gender}
                      onValueChange={(value) => {
                        const newFilters = { ...filters, gender: value };
                        setFilters(newFilters);
                        applyFilters(newFilters);
                      }}
                    >
                      <SelectTrigger
                        id="gender-select"
                        className="w-1/2 bg-zinc-800 border-zinc-700"
                      >
                        <SelectValue placeholder="Gender" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Gender</SelectItem>
                        {filterOptions.gender.map((gender) => (
                          <SelectItem key={gender} value={gender}>
                            {gender.charAt(0).toUpperCase() + gender.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {/* Voice List */}
                  <ScrollArea className="h-[400px] pr-2 text-sm">
                    <div className="flex flex-col gap-1">
                      {voices.map((voice) => {
                        const isRowSelected = selectedVoice?.id === voice.id;
                        return (
                          <div
                            key={voice.id}
                            className={`flex items-center px-2 rounded-lg  py-2 cursor-pointer transition-colors ${isRowSelected ? "bg-blue-600 text-white" : "hover:bg-zinc-800/80 text-white/90"}`}
                            onClick={() => {
                              setSelectedVoice(voice);
                              setIsPopoverOpen(false);
                            }}
                          >
                            {/* Voice Info */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                {/* Play Button */}
                                <Button
                                  size="icon"
                                  variant={
                                    isRowSelected ? "secondary" : "ghost"
                                  }
                                  className={`flex-shrink-0 ${isRowSelected ? "bg-white/20 text-white" : "text-white/80"}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handlePlayPause(voice.id, voice.previewUrl);
                                  }}
                                >
                                  {currentlyPlayingId === voice.id ? (
                                    <Pause className="h-5 w-5" />
                                  ) : (
                                    <Play className="h-5 w-5" />
                                  )}
                                </Button>
                                <div className="flex items-center gap-2">
                                  {(() => {
                                    const parts = voice.name.split(" - ");
                                    const name = parts[0];
                                    const description = parts[1];

                                    return (
                                      <div className="truncate">
                                        <span>{name}</span>
                                        {description && (
                                          <span className="text-muted-foreground">
                                            {" "}
                                            - {description}
                                          </span>
                                        )}
                                      </div>
                                    );
                                  })()}
                                </div>
                              </div>

                              <div className="flex flex-wrap gap-1 mt-1">
                                <Badge
                                  variant="secondary"
                                  className="text-xs bg-zinc-700/60 border-none text-white/90 rounded-sm"
                                >
                                  {voice.gender.charAt(0).toUpperCase() +
                                    voice.gender.slice(1)}
                                </Badge>
                                {voice.age && (
                                  <Badge
                                    variant="secondary"
                                    className="text-xs bg-zinc-700/60 border-none text-white/90 rounded-sm"
                                  >
                                    {voice.age.charAt(0).toUpperCase() +
                                      voice.age.slice(1)}
                                  </Badge>
                                )}
                                {voice.useCase && (
                                  <Badge
                                    variant="secondary"
                                    className="text-xs bg-zinc-700/60 border-none text-white/90 rounded-sm"
                                  >
                                    {voice.useCase}
                                  </Badge>
                                )}

                                {voice.category && (
                                  <Badge
                                    variant="secondary"
                                    className="text-xs bg-zinc-700/60 border-none text-white/90 rounded-sm"
                                  >
                                    {voice.category}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      {voices.length === 0 && !loading && (
                        <div className="text-center py-8 text-muted-foreground">
                          <p>No voices found. Try adjusting your filters.</p>
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <Button
            onClick={handleGenerate}
            disabled={!text.trim() || !selectedVoice || isGenerating}
            className="flex items-center gap-2 w-full"
            size={"sm"}
          >
            {isGenerating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating...
              </>
            ) : (
              "Generate Voice"
            )}
          </Button>
        </div>
      </div>}
    </div>
  );
};
