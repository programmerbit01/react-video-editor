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
  render_seconds?: number;
  speed_x?: number;
  encoder?: string;
  gpu?: string;
  hwAccel?: string;
  cores?: number;
  concurrency?: number;
  video_url?: string;
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

function sourceLabel(job: RenderJob) {
  return job.source === "editor-manual" ? "User Export" : "AI Render";
}

function engineLabel(job: RenderJob) {
  return String(job.engine || "").toLowerCase() === "remotion" ? "RE" : "FF";
}

function elapsed(startedAt?: number) {
  if (!startedAt) return "";
  const secs = Math.floor((Date.now() / 1000) - startedAt);
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export default function RenderStatusWidget() {
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState(true);
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch(`${basePath}/api/render-jobs`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const list = Array.isArray(data.jobs) ? data.jobs.filter((j: RenderJob) => j.source === "editor-manual") : [];
      setJobs(list);
    } catch {}
  }, [basePath]);

  useEffect(() => {
    fetchJobs();
    const id = setInterval(fetchJobs, POLL_MS);
    return () => clearInterval(id);
  }, [fetchJobs]);

  if (!jobs.length) return null;

  return (
    <div style={{
      position: "fixed",
      right: 16,
      bottom: 16,
      zIndex: 9999,
      width: 340,
      maxHeight: 360,
      overflowY: "auto",
      background: "#111",
      border: "1px solid #222",
      borderRadius: 10,
      boxShadow: "0 4px 24px rgba(0,0,0,0.55)",
      color: "#fff",
      fontFamily: "system-ui,sans-serif",
      fontSize: 13,
    }}>
      <div style={{
        padding: "8px 12px",
        borderBottom: collapsed ? "none" : "1px solid #222",
        background: "#1a1a1a",
        fontWeight: 600,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        <span>Exports</span>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "Expand exports" : "Minimize exports"}
          aria-label={collapsed ? "Expand exports" : "Minimize exports"}
          style={{
            border: "none",
            background: "transparent",
            color: "#9ca3af",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 2,
          }}
        >
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>
      {collapsed ? (
        <div style={{ padding: "10px 12px", fontSize: 11, opacity: 0.75 }}>
          {jobs.length} export{jobs.length === 1 ? "" : "s"}
        </div>
      ) : (
        <>
      {jobs.map((job) => {
        const st = String(job.status || "").toUpperCase();
        return (
          <div key={job.job_id} style={{ padding: "10px 12px", borderBottom: "1px solid #1a1a1a" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.9 }}>{job.project_name || "User Export"}</span>
              <span style={{ color: statusColor(job.status), fontSize: 11, fontWeight: 700 }}>{st || "PENDING"}</span>
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, opacity: 0.7, border: "1px solid #2a2a2a", borderRadius: 99, padding: "1px 6px" }}>{sourceLabel(job)}</span>
              <span style={{ fontSize: 10, opacity: 0.7, border: "1px solid #2a2a2a", borderRadius: 99, padding: "1px 6px" }}>{engineLabel(job)}</span>
            </div>
            <div style={{ background: "#222", borderRadius: 99, height: 4, overflow: "hidden" }}>
              <div style={{
                width: `${st === "COMPLETED" ? 100 : Number(job.progress || 0)}%`,
                height: "100%",
                background: statusColor(job.status),
                transition: "width 0.3s ease",
              }} />
            </div>
            <div style={{ marginTop: 6, fontSize: 11, opacity: 0.65, lineHeight: 1.5 }}>
              {st === "COMPLETED"
                ? `${job.render_seconds || 0}s render${job.speed_x ? ` · ${job.speed_x}x` : ""}${job.encoder ? ` · ${job.encoder}` : ""}`
                : `${job.progress || 0}%${job.started_at ? ` · ${elapsed(job.started_at)}` : ""}${job.gpu ? ` · GPU ${job.gpu}` : ""}${job.cores ? ` · ${job.cores} cores` : ""}${job.concurrency ? ` · cc ${job.concurrency}` : ""}`}
            </div>
            {job.error && <div style={{ marginTop: 6, fontSize: 10, color: "#fca5a5" }}>{job.error}</div>}
            {Array.isArray(job.log) && job.log.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <button
                  type="button"
                  onClick={() => setExpanded((s) => ({ ...s, [job.job_id]: !s[job.job_id] }))}
                  style={{ fontSize: 10, color: "#94a3b8", textDecoration: "underline" }}
                >
                  {expanded[job.job_id] ? "hide logs" : "show logs"}
                </button>
                {expanded[job.job_id] && (
                  <div style={{
                    marginTop: 6,
                    maxHeight: 120,
                    overflowY: "auto",
                    whiteSpace: "pre-wrap",
                    fontFamily: "monospace",
                    fontSize: 10,
                    lineHeight: 1.5,
                    padding: "8px 10px",
                    background: "#0a0a0a",
                    borderRadius: 6,
                    color: "#9ca3af",
                  }}>
                    {job.log.join("\n")}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
        </>
      )}
    </div>
  );
}
