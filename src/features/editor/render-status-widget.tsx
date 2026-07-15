"use client";

import { useCallback, useEffect, useState } from "react";
import { type RenderJob, RenderReportRow } from "./render-report";

const POLL_MS = 3000;

// Compact navbar chip when minimized; click to open the full floating panel.
export default function RenderStatusWidget() {
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [open, setOpen] = useState(false);
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

  if (!jobs.length) return null;

  const active = jobs.filter((j) => !["COMPLETED", "FAILED"].includes(String(j.status || "").toUpperCase()));

  return (
    <>
      {/* Compact chip — lives in the navbar */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`${jobs.length} export${jobs.length === 1 ? "" : "s"}${active.length ? ` · ${active.length} active` : ""}`}
        className="pointer-events-auto flex h-7 items-center gap-1 whitespace-nowrap rounded-full border border-border bg-background/80 px-2 text-[11px] font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
      >
        <span aria-hidden>🎬</span>
        <span>{jobs.length} exp</span>
        {active.length > 0 && (
          <span className="rounded-full bg-blue-500 px-1 py-px text-[9px] font-semibold leading-none text-white">
            {active.length}
          </span>
        )}
      </button>

      {/* Full floating panel — drops below the navbar when opened */}
      {open && (
        <div style={{
          position: "fixed", top: 56, right: 16, zIndex: 9999, width: 344,
          background: "#111", border: "1px solid #222", borderRadius: 10,
          boxShadow: "0 8px 30px rgba(0,0,0,0.6)", color: "#fff",
          fontFamily: "system-ui,sans-serif", fontSize: 13, overflow: "hidden",
        }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "8px 12px", background: "#1a1a1a", borderBottom: "1px solid #222", fontWeight: 600,
          }}>
            <span style={{ fontSize: 12, letterSpacing: 0.3 }}>
              🎬 Exports
              {active.length > 0 && (
                <span style={{ marginLeft: 6, background: "#3b82f6", borderRadius: 99, padding: "1px 7px", fontSize: 11 }}>
                  {active.length} active
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              title="Minimize"
              style={{ border: "none", background: "transparent", color: "#9ca3af", cursor: "pointer", fontSize: 13, lineHeight: 1 }}
            >
              ✕
            </button>
          </div>

          <div style={{ maxHeight: 400, overflowY: "auto", padding: "6px 0" }}>
            {jobs.map((job) => (
              <RenderReportRow key={job.job_id ?? ""} job={job} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
