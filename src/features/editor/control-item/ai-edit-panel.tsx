"use client";
import { useEffect, useRef } from "react";
import useAiEditStore from "../store/use-ai-edit-store";
import useStore from "../store/use-store";
import useCaptionTranscribeStore from "../store/use-caption-transcribe-store";
import {
  applyOperations,
  addAudio,
  addImage,
  addVideo,
  replaceMedia,
  setSelection,
  selectionChips,
  selectionContext,
  projectContext,
  narrationTimeline,
  describeOp,
  extractOps,
  captureSnapshot,
  revertSnapshot,
  CAPABILITIES,
  OPS_SYSTEM_PROMPT,
} from "../ai-edit/operations";

// Editor is served under Next basePath `/editor` — its API is /editor/api/*.
const withEditorBase = (path: string) => {
  if (typeof window === "undefined") return path;
  return window.location.pathname.startsWith("/editor") ? `/editor${path}` : path;
};

const getToken = () => {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("token") || "";
};

let _aiPositionSet = false;

async function runChat(
  payload: Record<string, any>,
  onDelta: (p: { content: string; reasoning: string }) => void
): Promise<{ content: string; reasoning: string }> {
  const res = await fetch(withEditorBase("/api/ai-edit"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const ctype = res.headers.get("content-type") || "";
  if (!payload.stream || ctype.includes("application/json")) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return { content: data?.content || "", reasoning: "" };
  }
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(t || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const p = t.slice(5).trim();
      if (!p || p === "[DONE]") continue;
      let evt: any;
      try {
        evt = JSON.parse(p);
      } catch {
        continue;
      }
      if (evt?.error) throw new Error(evt.error?.message || "stream error");
      const delta = evt.choices?.[0]?.delta;
      if (delta?.content) {
        content += delta.content;
        onDelta({ content, reasoning });
      }
      if (delta?.reasoning_content) {
        reasoning += delta.reasoning_content;
        onDelta({ content, reasoning });
      }
    }
  }
  return { content, reasoning };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Start a background media generation job → request_id (fast, non-blocking).
async function startGen(payload: Record<string, any>): Promise<string> {
  const res = await fetch(withEditorBase("/api/ai-generate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return String(data?.request_id || "");
}

// Long-poll the job (each call waits ~35s server-side via /vapp/wait_job) until it
// finishes. Reports live progress via onStatus. Returns the output URL.
async function waitGen(id: string, onStatus: (d: any) => void): Promise<string> {
  const deadline = Date.now() + 12 * 60 * 1000; // 12-min cap
  while (Date.now() < deadline) {
    let d: any = {};
    try {
      const res = await fetch(withEditorBase(`/api/ai-generate?id=${encodeURIComponent(id)}&timeout=35`), {
        cache: "no-store",
      });
      d = await res.json().catch(() => ({}));
    } catch {
      d = { status: "error" };
    }
    if (d?.failed) throw new Error(d?.error || "generation failed");
    if (d?.done && d?.output_url) return d.output_url;
    onStatus(d);
    if (d?.status === "error") await sleep(8000); // transient — brief backoff
  }
  throw new Error("timed out");
}

// Transcribe an audio URL → timed segments (start/end in SECONDS). Powers script-sync.
async function transcribeAudio(
  src: string,
  token: string
): Promise<{ start: number; end: number; text: string }[]> {
  const startRes = await fetch(withEditorBase("/api/transcribe"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: src, timestamp_type: "word", token }),
  });
  const sd = await startRes.json().catch(() => ({}));
  if (!startRes.ok) throw new Error(sd?.message || "transcribe start failed");
  const jobId = String(sd?.job_id || "");
  if (!jobId) throw new Error("no transcribe job id");
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    let pd: any = {};
    try {
      const pr = await fetch(withEditorBase(`/api/transcribe/${jobId}?token=${encodeURIComponent(token)}`), {
        cache: "no-store",
      });
      pd = await pr.json().catch(() => ({}));
    } catch {
      continue;
    }
    if (pd?.failed) throw new Error("transcription failed");
    if (pd?.done) {
      const segs = Array.isArray(pd?.stt?.segments) ? pd.stt.segments : [];
      return segs
        .map((sg: any) => ({ start: Number(sg?.start || 0), end: Number(sg?.end || 0), text: String(sg?.text || "").trim() }))
        .filter((x: any) => x.text);
    }
  }
  throw new Error("transcription timed out");
}

export default function AiEditPanel() {
  const s = useAiEditStore();
  const { activeIds, trackItemsMap } = useStore();

  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 });
  const resizeRef = useRef({ resizing: false, startX: 0, startY: 0, originW: 0, originH: 0 });
  const resizeLeftRef = useRef({ resizing: false, startX: 0, originW: 0, originX: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(withEditorBase("/api/ai-edit"))
      .then((r) => r.json())
      .then((d) => {
        const list = Array.isArray(d?.models) ? d.models : [];
        const mapped = list.map((m: any) => ({ id: m.id, label: m.label || m.id }));
        s.setModels(mapped);
        const prefer = mapped.find((m: any) => m.id === "litellm/GO20") || mapped[0];
        s.setModel(s.model || prefer?.id || "");
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (_aiPositionSet) return;
    s.setFloatPos({ x: window.innerWidth - 360, y: 60 });
    const trySnap = () => {
      const el = document.getElementById("editor-right-panel");
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 10 && rect.left > 100) {
          _aiPositionSet = true;
          s.setFloatPos({ x: rect.left, y: rect.top });
          s.setPanelSize({ width: rect.width, height: rect.height - 42 });
          return;
        }
      }
      requestAnimationFrame(trySnap);
    };
    requestAnimationFrame(trySnap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!s.isOpen) return;
    const onMove = (e: MouseEvent) => {
      if (dragRef.current.dragging) {
        s.setFloatPos({
          x: Math.max(0, dragRef.current.originX + e.clientX - dragRef.current.startX),
          y: Math.max(0, dragRef.current.originY + e.clientY - dragRef.current.startY),
        });
      }
      if (resizeRef.current.resizing) {
        s.setPanelSize({
          width: Math.max(280, resizeRef.current.originW + e.clientX - resizeRef.current.startX),
          height: Math.max(260, resizeRef.current.originH + e.clientY - resizeRef.current.startY),
        });
      }
      if (resizeLeftRef.current.resizing) {
        const delta = e.clientX - resizeLeftRef.current.startX;
        const newW = Math.max(280, resizeLeftRef.current.originW - delta);
        s.setFloatPos({ x: resizeLeftRef.current.originX + (resizeLeftRef.current.originW - newW), y: s.floatPos.y });
        s.setPanelSize({ width: newW, height: s.panelSize.height });
      }
    };
    const onUp = () => {
      dragRef.current.dragging = false;
      resizeRef.current.resizing = false;
      resizeLeftRef.current.resizing = false;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.isOpen, s.floatPos.y, s.panelSize.height]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.messages, s.busy]);

  const chips = selectionChips(activeIds, trackItemsMap);

  const runPrompt = async (text: string) => {
    if (!text.trim() || s.busy) return;
    const ctx = selectionContext(chips);
    s.addMessage({ role: "user", content: text });
    s.addMessage({ role: "assistant", content: "", reasoning: "", thinkingOpen: true });
    s.setBusy(true);

    // Script-sync: if the request is about matching to the narration, transcribe the
    // voiceover once (cached) so the AI gets exact segment times.
    if (/\b(script|narration|sync|voiceover|subtitle|caption)\b/i.test(text) || /when .*(say|said|speak)/i.test(text)) {
      const audio: any = Object.values(useStore.getState().trackItemsMap || {}).find((it: any) => it?.type === "audio");
      const asrc: string = audio?.details?.src || "";
      if (asrc && useAiEditStore.getState().transcript?.key !== audio.id) {
        // Reuse a persisted transcript (from the built-in Captions tab) if we have one.
        const cached = useCaptionTranscribeStore.getState().resultsByMedia?.[asrc];
        if (cached?.segments?.length) {
          s.setTranscript({
            key: audio.id,
            segments: cached.segments.map((sg: any) => ({ start: sg.start, end: sg.end, text: sg.text })),
          });
        } else {
          s.updateLast({ content: "Transcribing the narration…" });
          try {
            const segs = await transcribeAudio(asrc, getToken());
            if (segs.length) {
              s.setTranscript({ key: audio.id, segments: segs });
              // Share with the built-in captions cache (persisted) so it survives refresh.
              useCaptionTranscribeStore.getState().setTranscriptResult(asrc, {
                text: "",
                language: "",
                segment_count: segs.length,
                segments: segs.map((x) => ({ start: x.start, end: x.end, text: x.text })),
              });
            }
          } catch {
            /* proceed without transcript */
          }
          s.updateLast({ content: "" });
        }
      }
    }

    const projCtx = projectContext(trackItemsMap) + narrationTimeline(useAiEditStore.getState().transcript?.segments);
    const payload: Record<string, any> = {
      model: s.model,
      token: getToken(),
      stream: s.streaming,
      messages: [
        { role: "system", content: OPS_SYSTEM_PROMPT },
        { role: "user", content: `${projCtx ? projCtx + "\n\n" : ""}${ctx}\n\nUser request: ${text}` },
      ],
    };
    if (!s.showThinking) {
      payload.reasoning_effort = "low";
      payload.extra_body = { think: false };
    }
    const t0 = Date.now();
    let firstContentAt = 0;
    try {
      const { content, reasoning } = await runChat(payload, (p) => {
        if (p.content && !firstContentAt) firstContentAt = Date.now();
        s.updateLast({ content: p.content, reasoning: p.reasoning });
      });
      const reasoningMs = reasoning ? (firstContentAt || Date.now()) - t0 : undefined;
      const env = extractOps(content);
      if (env && env.operations?.length) {
        s.updateLast({ content: env.summary || "Proposed edit ready.", reasoning, reasoningMs, thinkingOpen: false, ops: env.operations });
        // Auto mode: apply immediately without asking
        if (useAiEditStore.getState().autoApply) {
          const idx = useAiEditStore.getState().messages.length - 1;
          const msg = useAiEditStore.getState().messages[idx];
          if (msg) applyMsg(idx, msg);
        }
      } else if (env) {
        s.updateLast({ content: env.summary || "No changes needed.", reasoning, reasoningMs, thinkingOpen: false });
      } else {
        s.updateLast({ content: content || "No operations produced.", reasoning, reasoningMs, thinkingOpen: false });
      }
    } catch (e: any) {
      s.updateLast({ content: "⚠️ " + (e?.message || "request failed"), thinkingOpen: false });
    } finally {
      s.setBusy(false);
    }
  };

  // One generate op, run in the BACKGROUND (not awaited) so the chat stays free.
  const runGen = async (i: number, g: any) => {
    // Stock search — no generation job; fetch Pexels and add the top result(s).
    if (g.op === "search") {
      const kind = g.kind === "video" ? "video" : "image";
      const n = Math.min(Math.max(1, g.count || 1), 10);
      try {
        s.updateAt(i, { genStatus: `Searching stock ${kind}…` });
        const path = kind === "video" ? "/api/pexels-videos" : "/api/pexels";
        const res = await fetch(
          withEditorBase(`${path}?query=${encodeURIComponent(g.query || g.prompt || "")}&per_page=${n}`)
        );
        const data = await res.json().catch(() => ({}));
        const results = (kind === "video" ? data.videos : data.photos) || [];
        const snap = { ...(useAiEditStore.getState().messages[i]?.snapshot || {}) };
        const previews = [...(useAiEditStore.getState().messages[i]?.genPreviews || [])];
        let added = 0;
        for (let k = 0; k < Math.min(n, results.length); k++) {
          const src = results[k]?.details?.src;
          if (!src) continue;
          const nid = kind === "video" ? addVideo(src, g.query || "stock") : addImage(src, g.query || "stock");
          snap[nid] = null;
          previews.push({ kind, url: results[k]?.preview || src });
          added++;
        }
        s.updateAt(i, {
          genStatus: added ? `✓ ${added} stock ${kind}${added > 1 ? "s" : ""} added` : `⚠️ no stock ${kind} found`,
          snapshot: snap,
          genPreviews: previews,
        });
      } catch (e: any) {
        s.updateAt(i, { genStatus: `⚠️ stock ${kind}: ${e?.message || "failed"}` });
      }
      return;
    }

    const isRegen = g.op === "regenerate";
    const label = isRegen ? "image" : g.kind || "audio";
    try {
      s.updateAt(i, { genStatus: `Starting ${isRegen ? "image edit" : label}…` });
      let image_url: string | undefined;
      if (isRegen) {
        const item = useStore.getState().trackItemsMap?.[g.itemId];
        image_url = item?.details?.src;
        // snapshot the original image so Revert restores it
        const cur0 = useAiEditStore.getState().messages[i]?.snapshot || {};
        s.updateAt(i, { snapshot: { ...cur0, [g.itemId]: item ? JSON.parse(JSON.stringify(item)) : null } });
      }
      const id = await startGen({
        kind: label,
        text: g.text,
        prompt: g.prompt || g.text,
        image_url,
        aspect_ratio: g.aspect_ratio,
        duration: g.duration,
        token: getToken(),
      });
      if (!id) throw new Error("no job id");
      const url = await waitGen(id, (d) => {
        const q = d?.queue_position;
        const p = d?.progress;
        s.updateAt(i, {
          genStatus:
            q != null ? `Queued #${q}…` : p != null ? `Generating ${label} ${p}%…` : `Generating ${label}…`,
        });
      });
      if (isRegen) {
        replaceMedia(g.itemId, url);
      } else {
        let newId = "";
        if (label === "audio") newId = addAudio(url, g.text || "voiceover");
        else if (label === "image") newId = addImage(url, g.prompt || g.text || "image");
        else if (label === "video") newId = addVideo(url, g.prompt || g.text || "video");
        const cur = useAiEditStore.getState().messages[i]?.snapshot || {};
        if (newId) s.updateAt(i, { snapshot: { ...cur, [newId]: null } });
      }
      const prev = useAiEditStore.getState().messages[i]?.genPreviews || [];
      s.updateAt(i, {
        genStatus: `✓ ${isRegen ? "image edited" : label + " added"}`,
        genPreviews: [...prev, { kind: label, url }],
      });
    } catch (e: any) {
      s.updateAt(i, { genStatus: `⚠️ ${label}: ${e?.message || "failed"}` });
    }
  };

  // Run generations (background), THEN any arrange — generated items only get ids
  // once created, so an "arrange all" must wait until they're on the timeline.
  const runBuild = async (i: number, gens: any[], arranges: any[]) => {
    await Promise.all(gens.map((g) => runGen(i, g)));
    if (!arranges.length) return;
    if (gens.length) s.updateAt(i, { genStatus: "Arranging into one video…" });
    const map = useStore.getState().trackItemsMap || {};
    const order = useStore.getState().trackItemIds || Object.keys(map);
    for (const a of arranges) {
      const hasExplicit = (a.items?.length || a.itemIds?.length) && !a.target;
      if (hasExplicit) {
        applyOperations([a]);
      } else {
        const visualIds = order.filter((id: string) => map[id] && (map[id] as any).type !== "audio");
        if (visualIds.length) applyOperations([{ op: "arrange", itemIds: visualIds, totalMs: a.totalMs }]);
      }
    }
    if (gens.length) s.updateAt(i, { genStatus: "✓ built into one video" });
  };

  const applyMsg = (i: number, m: any) => {
    if (!m.ops?.length) return;
    const sync = m.ops.filter((o: any) => !["generate", "regenerate", "search", "arrange"].includes(o.op));
    const gens = m.ops.filter((o: any) => ["generate", "regenerate", "search"].includes(o.op));
    const arranges = m.ops.filter((o: any) => o.op === "arrange");

    // sync ops apply immediately
    const snapshot = captureSnapshot(sync, trackItemsMap);
    const { addedIds } = applyOperations(sync);
    for (const id of addedIds) snapshot[id] = null;

    const now = new Date();
    const historyId = `${now.getTime()}-${Math.random().toString(36).slice(2, 6)}`;
    s.updateAt(i, { applied: true, snapshot, historyId });
    s.addHistory({ id: historyId, time: now.toLocaleTimeString(), summary: m.content || "Applied edit", ops: m.ops, snapshot });

    // generation (+ deferred arrange) runs in the background — chat stays free
    if (gens.length || arranges.length) runBuild(i, gens, arranges);
  };

  const revertMsg = (i: number, m: any) => {
    if (!m.snapshot) return;
    revertSnapshot(m.snapshot);
    if (m.historyId) s.markReverted(m.historyId);
    s.updateAt(i, { reverted: true });
  };

  const copy = (text: string) => {
    try {
      navigator.clipboard?.writeText(text);
    } catch {
      /* ignore */
    }
  };

  const send = () => {
    const t = s.input;
    s.setInput("");
    runPrompt(t);
  };

  const lastUserText = [...s.messages].reverse().find((m) => m.role === "user")?.content || "";

  if (!s.isOpen) return null;

  const panelStyle: React.CSSProperties = s.isFullscreen
    ? { position: "fixed", left: 0, top: 0, width: "100vw", height: "100vh", zIndex: 9999, overflow: "visible" }
    : { position: "fixed", left: s.floatPos.x, top: s.floatPos.y, width: s.panelSize.width, zIndex: 9999, overflow: "visible" };
  const bodyHeight = s.isFullscreen ? "calc(100vh - 42px)" : s.panelSize.height;
  const iconBtn =
    "flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground hover:text-foreground";
  const act = "text-[10px] text-muted-foreground hover:text-foreground";

  return (
    <div className="rounded-2xl border border-border bg-background shadow-xl" style={panelStyle}>
      {/* Header */}
      <div
        onMouseDown={
          !s.isFullscreen
            ? (e) =>
                (dragRef.current = {
                  dragging: true,
                  startX: e.clientX,
                  startY: e.clientY,
                  originX: s.floatPos.x,
                  originY: s.floatPos.y,
                })
            : undefined
        }
        onDoubleClick={() => s.setFullscreen(!s.isFullscreen)}
        className={`flex select-none items-center justify-between rounded-t-2xl border-b border-border/60 bg-card px-3 py-2 ${
          !s.isFullscreen ? "cursor-grab" : "cursor-default"
        }`}
      >
        <div className="flex items-center gap-2">
          <div className="grid grid-cols-2 gap-[3px]">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-[3px] w-[3px] rounded-full bg-muted-foreground/30" />
            ))}
          </div>
          <span className="text-[11px] font-medium text-foreground">✦ AI Edit</span>
          {chips.length > 0 && <span className="text-[11px] text-muted-foreground">{chips.length} selected</span>}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => s.setShowHistory(!s.showHistory)}
            className={`${iconBtn} ${s.showHistory ? "bg-sky-500/20 text-sky-600" : ""}`}
            title="Change history"
          >
            🕑
          </button>
          <button
            onClick={() => s.setShowFeatures(!s.showFeatures)}
            className={`${iconBtn} ${s.showFeatures ? "bg-sky-500/20 text-sky-600" : ""}`}
            title="What you can ask"
          >
            💡
          </button>
          <button
            onClick={() => s.setShowSettings(!s.showSettings)}
            className={`${iconBtn} ${s.showSettings ? "bg-sky-500/20 text-sky-600" : ""}`}
            title="Settings"
          >
            ⚙
          </button>
          <button
            onClick={s.clearChat}
            className="rounded px-2 py-0.5 text-[9px] text-muted-foreground hover:bg-muted hover:text-foreground"
            title="New chat — clears the conversation (each request is already sent fresh, no old context)"
          >
            ＋ New
          </button>
          <button onClick={() => s.setFullscreen(!s.isFullscreen)} className={iconBtn} title="Fullscreen">
            {s.isFullscreen ? "⊡" : "⊞"}
          </button>
          <button onClick={() => s.setCollapsed(!s.isCollapsed)} className={iconBtn}>
            {s.isCollapsed ? "+" : "—"}
          </button>
          <button onClick={() => s.setOpen(false)} className={`${iconBtn} hover:bg-red-500/20 hover:text-red-500`}>
            ✕
          </button>
        </div>
      </div>

      {!s.isCollapsed && (
        <div className="relative flex flex-col rounded-b-2xl" style={{ height: bodyHeight }}>
          {/* Settings popover */}
          {s.showSettings && (
            <div className="absolute right-2 top-1 z-20 w-56 rounded-xl border border-border bg-popover p-2.5 shadow-lg">
              <label className="flex items-center justify-between py-1 text-[12px] text-foreground">
                <span>Mode</span>
                <select
                  value={s.autoApply ? "auto" : "ask"}
                  onChange={(e) => s.setAutoApply(e.target.value === "auto")}
                  className="h-6 rounded border border-border bg-muted/50 px-1 text-[11px] text-foreground outline-none"
                >
                  <option value="ask">Ask (preview)</option>
                  <option value="auto">Auto-apply</option>
                </select>
              </label>
              <label className="flex cursor-pointer items-center justify-between py-1 text-[12px] text-foreground">
                <span>Streaming</span>
                <input type="checkbox" checked={s.streaming} onChange={(e) => s.setStreaming(e.target.checked)} />
              </label>
              <label className="flex cursor-pointer items-center justify-between py-1 text-[12px] text-foreground">
                <span>Show thinking</span>
                <input type="checkbox" checked={s.showThinking} onChange={(e) => s.setShowThinking(e.target.checked)} />
              </label>
              <p className="mt-1 text-[9px] text-muted-foreground">Auto = applies without asking. Thinking off = faster.</p>
            </div>
          )}

          {/* Features popover */}
          {s.showFeatures && (
            <div className="absolute right-2 top-1 z-20 max-h-[70%] w-64 overflow-y-auto rounded-xl border border-border bg-popover p-2.5 shadow-lg">
              <p className="mb-1 text-[11px] font-semibold text-foreground">What you can ask</p>
              {CAPABILITIES.map((g) => (
                <div key={g.group} className="mb-1.5">
                  <p className="text-[9px] uppercase tracking-wide text-muted-foreground/70">{g.group}</p>
                  {g.items.map((it) => (
                    <button
                      key={it.label}
                      onClick={() => {
                        s.setInput(it.example);
                        s.setShowFeatures(false);
                      }}
                      className="block w-full rounded-md px-1.5 py-1 text-left text-[11px] hover:bg-muted"
                    >
                      <span className="font-medium text-foreground">{it.label}</span>
                      <span className="ml-1 text-muted-foreground/60">— {it.example}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Selection chips */}
          <div className="shrink-0 border-b border-border/50 px-3 py-2">
            {chips.length ? (
              <div className="flex flex-wrap gap-1.5">
                {chips.map((c) => (
                  <span
                    key={c.id}
                    onClick={() => setSelection([c.id])}
                    className="group flex cursor-pointer items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pl-0.5 pr-1.5 text-[10px] text-foreground/80 transition hover:border-sky-500/40"
                    title={`Click to select in timeline · ${c.id}`}
                  >
                    {c.src ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.src} alt="" className="h-4 w-4 shrink-0 rounded-full object-cover" />
                    ) : (
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[8px]">
                        {c.type === "audio" ? "♪" : c.type === "text" || c.type === "caption" ? "T" : "▦"}
                      </span>
                    )}
                    <span className="max-w-[90px] truncate font-medium">{c.name}</span>
                    <span className="text-muted-foreground/50">{(c.durationMs / 1000).toFixed(1)}s</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelection(activeIds.filter((x) => x !== c.id));
                      }}
                      className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-muted-foreground/40 hover:bg-red-500/20 hover:text-red-500"
                      title="Deselect"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground">Select a clip, then describe the edit — or tap 💡 for ideas.</p>
            )}
          </div>

          {/* History view OR chat */}
          {s.showHistory ? (
            <div className="flex-1 space-y-2 overflow-y-auto p-3">
              {s.history.length === 0 && (
                <p className="mt-8 text-center text-[11px] text-muted-foreground/50">No applied changes yet.</p>
              )}
              {s.history.map((h) => (
                <div
                  key={h.id}
                  className={`rounded-lg border p-2 ${h.reverted ? "border-border/40 opacity-50" : "border-border"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] text-muted-foreground">{h.time}</span>
                    {h.reverted ? (
                      <span className="text-[10px] text-muted-foreground">reverted</span>
                    ) : (
                      <button
                        onClick={() => {
                          revertSnapshot(h.snapshot);
                          s.markReverted(h.id);
                        }}
                        className="rounded px-2 py-0.5 text-[10px] text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
                      >
                        ↩ Revert
                      </button>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12px] text-foreground/90">{h.summary}</p>
                  <div className="mt-1 space-y-0.5">
                    {h.ops.map((op, i) => (
                      <p key={i} className="font-mono text-[9px] text-muted-foreground">
                        {describeOp(op)}
                      </p>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3">
              {s.messages.length === 0 && (
                <p className="mt-8 text-center text-[11px] text-muted-foreground/50">
                  Try: &ldquo;make this 3 seconds&rdquo; · &ldquo;zoom in&rdquo; · &ldquo;rotate 10°&rdquo; · &ldquo;add a title&rdquo;
                  <br />
                  Tap 💡 to see everything you can ask.
                </p>
              )}
              {s.messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-sky-600 px-3 py-1.5 text-[13px] text-white">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={i}>
                    {s.showThinking && m.reasoning ? (
                      <div className="mb-1">
                        <button
                          onClick={() => s.updateAt(i, { thinkingOpen: !m.thinkingOpen })}
                          className="flex items-center gap-1 text-[10px] text-amber-600/80 hover:text-amber-600 dark:text-amber-300/70"
                        >
                          <span>{m.thinkingOpen ? "▾" : "▸"}</span>
                          <span>💭 Thought</span>
                          {m.reasoningMs != null && (
                            <span className="text-[9px] opacity-60">{(m.reasoningMs / 1000).toFixed(1)}s</span>
                          )}
                        </button>
                        {m.thinkingOpen && (
                          <div className="mt-1 max-h-28 overflow-y-auto rounded-lg border border-amber-500/20 bg-amber-500/5 px-2 py-1 text-[10px] italic leading-relaxed text-amber-700/80 dark:text-amber-300/70">
                            {m.reasoning}
                          </div>
                        )}
                      </div>
                    ) : null}
                    <div className="text-[13px] leading-relaxed text-foreground/90">
                      <span className="whitespace-pre-wrap">
                        {m.content || (s.busy && i === s.messages.length - 1 ? "…" : "")}
                      </span>
                      {m.genStatus && (
                        <span
                          className={`ml-2 whitespace-nowrap text-[10px] ${
                            m.genStatus.startsWith("⚠️")
                              ? "text-red-500"
                              : m.genStatus.startsWith("✓")
                              ? "text-emerald-600"
                              : "text-sky-500"
                          }`}
                        >
                          {!m.genStatus.startsWith("✓") && !m.genStatus.startsWith("⚠️") && "● "}
                          {m.genStatus}
                        </span>
                      )}
                    </div>
                    {m.genPreviews?.map((pv, k) => (
                      <div key={k} className="mt-1.5">
                        {pv.kind === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={pv.url} alt="" className="max-h-40 rounded-lg border border-border" />
                        ) : pv.kind === "video" ? (
                          <video src={pv.url} controls className="max-h-40 w-full rounded-lg border border-border" />
                        ) : (
                          <audio src={pv.url} controls className="w-full" />
                        )}
                      </div>
                    ))}

                    {/* Inline proposed operations */}
                    {m.ops && m.ops.length > 0 && !m.applied && (
                      <div className="mt-1.5 rounded-xl border border-sky-500/40 bg-sky-500/5 p-2">
                        {m.ops.map((op: any, k: number) => (
                          <div key={k} className="rounded-lg bg-background/60 px-2 py-1 font-mono text-[10px] text-foreground/80">
                            {describeOp(op)}
                          </div>
                        ))}
                        <div className="mt-1.5 flex gap-1.5">
                          <button
                            onClick={() => applyMsg(i, m)}
                            className="flex-1 rounded-lg bg-sky-500/20 py-1.5 text-[11px] font-semibold text-sky-600 hover:bg-sky-500/30 dark:text-sky-300"
                          >
                            Apply
                          </button>
                          <button
                            onClick={() => s.updateAt(i, { ops: undefined })}
                            className="rounded-lg bg-muted px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                          >
                            Discard
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Action row */}
                    {m.content && !m.content.startsWith("⚠️") && (
                      <div className="mt-1 flex items-center gap-2.5">
                        <button onClick={() => copy(m.content)} className={act}>
                          Copy
                        </button>
                        {i === s.messages.length - 1 && lastUserText && !s.busy && (
                          <button onClick={() => s.setInput(lastUserText)} className={act} title="Put this prompt back in the box to edit & resend">
                            Retry
                          </button>
                        )}
                        {m.applied && !m.reverted && (
                          <button onClick={() => revertMsg(i, m)} className="text-[10px] text-amber-600 hover:text-amber-500 dark:text-amber-400">
                            ↩ Revert
                          </button>
                        )}
                        {m.applied && !m.reverted && <span className="text-[10px] text-sky-500/70">applied</span>}
                        {m.reverted && <span className="text-[10px] text-muted-foreground">reverted</span>}
                      </div>
                    )}
                  </div>
                )
              )}
            </div>
          )}

          {/* Composer */}
          <div className="shrink-0 border-t border-border/50 p-2">
            <div className="rounded-xl border border-border bg-muted/40 p-1.5 focus-within:border-sky-500/40">
              <textarea
                value={s.input}
                onChange={(e) => s.setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={2}
                placeholder="Describe the edit…"
                className="max-h-32 min-h-[36px] w-full resize-none bg-transparent px-1.5 py-1 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/40"
              />
              <div className="mt-1 flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5 pl-1">
                  {s.autoApply && <span className="text-[9px] text-emerald-600/70">auto</span>}
                  {s.streaming && <span className="text-[9px] text-sky-500/70">streaming</span>}
                  {!s.showThinking && <span className="text-[9px] text-muted-foreground/60">fast</span>}
                </div>
                <div className="flex items-center gap-1.5">
                  {s.models.length > 0 && (
                    <select
                      value={s.model}
                      onChange={(e) => s.setModel(e.target.value)}
                      className="h-7 max-w-[92px] truncate rounded-lg border border-border bg-background px-1.5 text-[10px] text-muted-foreground outline-none"
                      title="Model"
                    >
                      {s.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    onClick={send}
                    disabled={s.busy || !s.input.trim()}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-600 text-white transition hover:bg-sky-500 disabled:opacity-40"
                    title="Send"
                  >
                    {s.busy ? "…" : "↑"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Resize handles */}
      <div
        onMouseDown={(e) => {
          e.stopPropagation();
          resizeLeftRef.current = { resizing: true, startX: e.clientX, originW: s.panelSize.width, originX: s.floatPos.x };
        }}
        className="absolute bottom-0 top-0 cursor-ew-resize"
        style={{ left: -4, width: 8, zIndex: 10 }}
      />
      <div
        onMouseDown={(e) => {
          e.stopPropagation();
          resizeRef.current = {
            resizing: true,
            startX: e.clientX,
            startY: e.clientY,
            originW: s.panelSize.width,
            originH: s.panelSize.height,
          };
        }}
        className="absolute bottom-0 top-0 cursor-ew-resize"
        style={{ right: -4, width: 8, zIndex: 10 }}
      />
      <div
        onMouseDown={(e) => {
          e.stopPropagation();
          resizeRef.current = {
            resizing: true,
            startX: e.clientX,
            startY: e.clientY,
            originW: s.panelSize.width,
            originH: s.panelSize.height,
          };
        }}
        className="absolute cursor-se-resize"
        style={{ right: -4, bottom: -4, width: 16, height: 16, zIndex: 11 }}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          style={{ position: "absolute", right: 4, bottom: 4 }}
          className="text-muted-foreground/40"
        >
          <path d="M9 3 L3 9 M9 6 L6 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
