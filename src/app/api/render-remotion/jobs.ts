// The in-memory render-job store. Typed by the SHARED RenderJob shape (same one
// the reporting UI reads) so server-written telemetry and client-rendered fields
// never drift. render-report-types has no client/React deps → safe to import here.
import type { RenderJob, RenderStage } from "@/features/editor/render-report-types";

export type { RenderJob, RenderStage };

export const jobs = new Map<string, RenderJob>();
