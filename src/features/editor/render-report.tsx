"use client";

// ─────────────────────────────────────────────────────────────────────────────
// render-report — the SINGLE reporting UI for renders.
//
// Types + pure helpers live in render-report-types.ts (server-safe, shared with
// the render route). This file adds the ONE visual component <RenderReportRow>
// and re-exports everything, so components import from here.
//
// Both surfaces render the SAME <RenderReportRow>:
//   • render-status-widget.tsx     — floating "Exports" list (all jobs)
//   • download-progress-modal.tsx  — the "current export" dialog
// Edit reporting once here → both update.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import {
  type RenderJob,
  statusColor,
  statusLabel,
  sourceLabel,
  engineLabel,
  elapsedFrom,
  renderStatsLine,
  fmtMs,
  stageIcon,
} from "./render-report-types";

export * from "./render-report-types";

const badgeStyle: React.CSSProperties = {
  fontSize: 10, opacity: 0.7, border: "1px solid #2a2a2a", borderRadius: 99, padding: "1px 6px",
};

export function RenderReportRow({
  job,
  borderBottom = true,
}: {
  job: RenderJob;
  borderBottom?: boolean;
}) {
  const [showLog, setShowLog] = useState(false);
  const st = String(job.status || "").toUpperCase();
  const isDone = st === "COMPLETED";
  const stages = Array.isArray(job.stages) ? job.stages : [];
  const hasLogs = Array.isArray(job.log) && job.log.length > 0;

  return (
    <div style={{ padding: "8px 12px", borderBottom: borderBottom ? "1px solid #1a1a1a" : undefined }}>
      {/* title + status */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, gap: 8 }}>
        <span style={{ opacity: 0.85, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>
          {job.project_name || `${(job.job_id || "").slice(0, 12)}…`}
        </span>
        <span style={{ color: statusColor(job.status), fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
          {statusLabel(job.status)}
        </span>
      </div>

      {/* source + engine badges */}
      <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={badgeStyle}>{sourceLabel(job)}</span>
        {engineLabel(job) && <span style={badgeStyle}>{engineLabel(job)}</span>}
      </div>

      {/* progress bar */}
      <div style={{ background: "#222", borderRadius: 99, height: 4, overflow: "hidden" }}>
        <div style={{
          height: "100%", borderRadius: 99, background: statusColor(job.status),
          width: `${isDone ? 100 : Number(job.progress || 0)}%`, transition: "width 0.4s ease",
        }} />
      </div>

      {/* stats line + download */}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 11, opacity: 0.6, gap: 8 }}>
        <span style={{ minWidth: 0 }}>
          {isDone
            ? renderStatsLine(job, "done") || "100%"
            : [
                `${job.progress || 0}%`,
                job.started_at && st !== "FAILED" ? `⏱ ${elapsedFrom(job.started_at)}` : "",
                renderStatsLine(job, "live"),
              ].filter(Boolean).join(" · ")}
        </span>
        {job.video_url && (
          <a href={job.video_url} target="_blank" rel="noreferrer" style={{ color: "#22c55e", textDecoration: "underline", whiteSpace: "nowrap" }}>
            Download ↓
          </a>
        )}
      </div>

      {/* stall banner — the point of observability: user sees it's stuck + why */}
      {job.stalled && st !== "COMPLETED" && st !== "FAILED" && (
        <div style={{
          marginTop: 6, padding: "5px 8px",
          background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.35)",
          borderRadius: 5, color: "#fbbf24", fontSize: 10, lineHeight: 1.5, wordBreak: "break-word",
        }}>⚠ Stuck — {job.stall_reason || "no progress"}</div>
      )}

      {/* per-stage timing breakdown — where the time actually goes */}
      {stages.length > 0 && (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
          {stages.map((s, i) => (
            <div key={`${s.name}-${i}`} style={{
              display: "flex", justifyContent: "space-between", gap: 8, fontSize: 10,
              color: s.status === "stalled" ? "#fbbf24" : s.status === "failed" ? "#fca5a5" : "#cbd5e1",
              opacity: s.status === "running" || s.status === "stalled" ? 0.95 : 0.6,
            }}>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {stageIcon(s.status)} {s.name}{s.detail ? ` · ${s.detail}` : ""}
              </span>
              <span style={{ whiteSpace: "nowrap", opacity: 0.8 }}>{s.ms != null ? fmtMs(s.ms) : ""}</span>
            </div>
          ))}
        </div>
      )}

      {/* live message */}
      {job.message && !isDone && (
        <div style={{ marginTop: 4, fontSize: 10, color: "#94a3b8" }}>▸ {job.message}</div>
      )}

      {/* waiting hint */}
      {st === "PENDING" && !job.error && (
        <div style={{ marginTop: 4, fontSize: 10, color: "#f59e0b", opacity: 0.75 }}>⏳ Waiting for renderer…</div>
      )}

      {/* error */}
      {st === "FAILED" && job.error && (
        <div style={{
          marginTop: 5, padding: "5px 8px",
          background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)",
          borderRadius: 5, color: "#fca5a5", fontSize: 10, wordBreak: "break-word", lineHeight: 1.5,
        }}>❌ {job.error}</div>
      )}

      {/* full logs */}
      {hasLogs && (
        <div style={{ marginTop: 5 }}>
          <span
            onClick={() => setShowLog((v) => !v)}
            style={{ fontSize: 10, color: "#64748b", cursor: "pointer", textDecoration: "underline" }}
          >
            {showLog ? "▲ hide logs" : `▼ show logs (${job.log!.length})`}
          </span>
          {showLog && (
            <div style={{
              marginTop: 4, padding: "6px 8px", background: "#0a0a0a", borderRadius: 5,
              fontSize: 9, color: "#94a3b8", lineHeight: 1.6, maxHeight: 160, overflowY: "auto",
              fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-all",
            }}>
              {(job.log || []).slice(-60).join("\n")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
