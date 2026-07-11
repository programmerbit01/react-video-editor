"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

type RenderJob = {
  job_id: string;
  status?: string;
  progress?: number;
  project_name?: string;
  source?: string;
  engine?: string;
  started_at?: number;
  video_seconds?: number;
  render_seconds?: number;
  speed_x?: number;
  size_mb?: number;
  encoder?: string;
  gpu?: string;
  hwAccel?: string;
  cores?: number;
  concurrency?: number;
  video_url?: string;
  message?: string;
  error?: string;
  log?: string[];
};

const POLL_MS = 3000;

function statusColor(status?: string) {
  switch (String(status || "").toUpperCase()) {
    case "COMPLETED": return "#22c55e";
    case "FAILED": return "#ef4444";
    case "PROCESSING": return "#3b82f6";
    default: return "#f59e0b";
  }
}

function statusLabel(status?: string) {
  switch (String(status || "").toUpperCase()) {
    case "COMPLETED": return "Done";
    case "FAILED": return "Failed";
    case "PROCESSING": return "Rendering";
    default: return "Queued";
  }
}

function sourceLabel(job: RenderJob) {
  if (job.source === "editor-manual") return "User Export";
  if (job.source === "mcp-ai") return "AI Render";
  return "Render";
}

function engineLabel(job: RenderJob) {
  const e = String(job.engine || "").toLowerCase();
  if (e === "ffmpeg") return "FF";
  if (e === "remotion") return "RE";
  return "";
}

function fmtDur(s?: number) {
  if (s == null) return "";
  s = Math.round(s);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function elapsed(startedAt?: number) {
  if (!startedAt) return "";
  const secs = Math.floor(Date.now() / 1000 - startedAt);
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export default function RenderStatusWidget() {
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState(true);
  const [hidden, setHidden] = useState(false);
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch(`${basePath}/api/render-jobs`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
    } catch {}
  }, [basePath]);

  useEffect(() => {
    fetchJobs();
    const id = setInterval(fetchJobs, POLL_MS);
    return () => clearInterval(id);
  }, [fetchJobs]);

  if (hidden || !jobs.length) return null;

  const active = jobs.filter((j) => !["COMPLETED", "FAILED"].includes(String(j.status || "").toUpperCase()));

  return (
    <div style={{
      position: "fixed", right: 16, bottom: 16, zIndex: 9999,
      width: 340, background: "#111", border: "1px solid #222", borderRadius: 10,
      boxShadow: "0 4px 24px rgba(0,0,0,0.55)", color: "#fff",
      fontFamily: "system-ui,sans-serif", fontSize: 13, overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "8px 12px", background: "#1a1a1a",
        borderBottom: collapsed ? "none" : "1px solid #222", fontWeight: 600,
      }}>
        <span style={{ fontSize: 12, letterSpacing: 0.3 }}>
          🎬 Exports
          {active.length > 0 && (
            <span style={{ marginLeft: 6, background: "#3b82f6", borderRadius: 99, padding: "1px 7px", fontSize: 11 }}>
              {active.length} active
            </span>
          )}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? "Expand" : "Collapse"}
            style={{ border: "none", background: "transparent", color: "#9ca3af", cursor: "pointer", display: "inline-flex", padding: 2 }}
          >
            {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          <button
            type="button"
            onClick={() => setHidden(true)}
            title="Hide"
            style={{ border: "none", background: "transparent", color: "#9ca3af", cursor: "pointer", fontSize: 12, lineHeight: 1 }}
          >
            ✕
          </button>
        </div>
      </div>

      {collapsed ? (
        <div style={{ padding: "10px 12px", fontSize: 11, opacity: 0.75 }}>
          {jobs.length} export{jobs.length === 1 ? "" : "s"}{active.length ? ` · ${active.length} active` : ""}
        </div>
      ) : (
        <div style={{ maxHeight: 400, overflowY: "auto", padding: "6px 0" }}>
          {jobs.map((job) => {
            const st = String(job.status || "").toUpperCase();
            const isExpanded = expanded[job.job_id];
            const hasLogs = Array.isArray(job.log) && job.log.length > 0;
            return (
              <div key={job.job_id} style={{ padding: "8px 12px", borderBottom: "1px solid #1a1a1a" }}>
                {/* Name + status */}
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ opacity: 0.85, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>
                    {job.project_name || `${job.job_id?.slice(0, 12)}…`}
                  </span>
                  <span style={{ color: statusColor(job.status), fontSize: 11, fontWeight: 700 }}>
                    {statusLabel(job.status)}
                  </span>
                </div>

                {/* Badges */}
                <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10, opacity: 0.7, border: "1px solid #2a2a2a", borderRadius: 99, padding: "1px 6px" }}>{sourceLabel(job)}</span>
                  {engineLabel(job) && (
                    <span style={{ fontSize: 10, opacity: 0.7, border: "1px solid #2a2a2a", borderRadius: 99, padding: "1px 6px" }}>{engineLabel(job)}</span>
                  )}
                </div>

                {/* Progress bar */}
                <div style={{ background: "#222", borderRadius: 99, height: 4, overflow: "hidden" }}>
                  <div style={{
                    height: "100%", borderRadius: 99, background: statusColor(job.status),
                    width: `${st === "COMPLETED" ? 100 : Number(job.progress || 0)}%`,
                    transition: "width 0.4s ease",
                  }} />
                </div>

                {/* Stats + download */}
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 11, opacity: 0.6, gap: 8 }}>
                  <span style={{ minWidth: 0 }}>
                    {st === "COMPLETED" ? (
                      <>
                        {job.video_seconds ? `${fmtDur(job.video_seconds)} video` : "100%"}
                        {job.render_seconds != null && ` · ${fmtDur(job.render_seconds)} render`}
                        {job.speed_x ? ` · ${job.speed_x}×` : ""}
                        {job.size_mb ? ` · ${job.size_mb}MB` : ""}
                        {job.encoder ? ` · ${job.encoder}` : ""}
                      </>
                    ) : (
                      <>
                        {job.progress || 0}%
                        {job.started_at && st !== "FAILED" ? ` · ⏱ ${elapsed(job.started_at)}` : ""}
                        {job.gpu ? ` · GPU ${job.gpu}` : ""}
                        {job.cores ? ` · ${job.cores} cores` : ""}
                        {job.concurrency ? ` · cc ${job.concurrency}` : ""}
                      </>
                    )}
                  </span>
                  {job.video_url && (
                    <a href={job.video_url} target="_blank" rel="noreferrer" style={{ color: "#22c55e", textDecoration: "underline", whiteSpace: "nowrap" }}>
                      Download ↓
                    </a>
                  )}
                </div>

                {/* Stage / message */}
                {job.message && st !== "COMPLETED" && (
                  <div style={{ marginTop: 4, fontSize: 10, color: "#94a3b8" }}>▸ {job.message}</div>
                )}

                {/* PENDING hint */}
                {st === "PENDING" && !job.error && (
                  <div style={{ marginTop: 4, fontSize: 10, color: "#f59e0b", opacity: 0.75 }}>⏳ Waiting for renderer…</div>
                )}

                {/* FAILED error */}
                {st === "FAILED" && job.error && (
                  <div style={{
                    marginTop: 5, padding: "5px 8px",
                    background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)",
                    borderRadius: 5, color: "#fca5a5", fontSize: 10, wordBreak: "break-word", lineHeight: 1.5,
                  }}>❌ {job.error}</div>
                )}

                {/* Logs */}
                {hasLogs && (
                  <div style={{ marginTop: 5 }}>
                    <span
                      onClick={() => setExpanded((e) => ({ ...e, [job.job_id]: !e[job.job_id] }))}
                      style={{ fontSize: 10, color: "#64748b", cursor: "pointer", textDecoration: "underline" }}
                    >
                      {isExpanded ? "▲ hide logs" : "▼ show logs"}
                    </span>
                    {isExpanded && (
                      <div style={{
                        marginTop: 4, padding: "6px 8px", background: "#0a0a0a", borderRadius: 5,
                        fontSize: 9, color: "#64748b", lineHeight: 1.6, maxHeight: 120, overflowY: "auto",
                        fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-all",
                      }}>
                        {(job.log || []).slice(-20).join("\n")}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
