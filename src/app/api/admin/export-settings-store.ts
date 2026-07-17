// The one server-side store for deployment-level EXPORT settings a superadmin sets in
// the editor navbar. Today it holds a single knob — the RAM budget an export may use —
// and the ffmpeg parallelism derives from it (see the render routes). Kept deliberately
// small: one number the whole fleet can honour, not a pile of levers that reintroduce the
// shaky-video / OOM tradeoffs we just closed.
//
// WHY a flat JSON file and not the vApp: the render routes must read this WITHOUT depending
// on the vApp being reachable — the schema doc's own lesson ("editor went down, every probe
// failed, good images logged as black"). A render machine reads its own file; the setting
// also RIDES IN THE JOB (options.ramBudgetGB) so a central change reaches fleet agents. The
// file is the per-machine fallback, options is the traveller. No proxy, no network on read.

import { promises as fs } from "fs";
import path from "path";

export interface ExportSettings {
  /** GB of RAM one export may plan to use. ffmpeg parallelism = floor(budget / per-process),
   *  then clamped to the machine's actually-free RAM at render time. */
  ramBudgetGB: number;
  updatedAt?: number;
  updatedBy?: string;
}

// Bounds a superadmin can pick between. Below 1.5 you can't fit one Ken Burns segment
// (~0.95GB) with headroom; above 64 is past any box we run and just invites swap.
export const RAM_BUDGET_MIN = 1.5;
export const RAM_BUDGET_MAX = 64;
export const RAM_BUDGET_DEFAULT = 5.5;

export function clampRamBudget(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(RAM_BUDGET_MAX, Math.max(RAM_BUDGET_MIN, n));
}

// process.cwd() is the app root for both `next start` and the packaged app. Kept out of
// public/ so it is never served, and stable across restarts.
function settingsPath(): string {
  return path.join(process.cwd(), "export-settings.json");
}

/** The effective budget, in priority order: the saved file, else env, else the default.
 *  Never throws — a missing/broken file falls straight through to the default so a render
 *  never fails to start over a settings read. */
export async function readExportSettings(): Promise<ExportSettings> {
  let fromFile: Partial<ExportSettings> = {};
  try {
    fromFile = JSON.parse(await fs.readFile(settingsPath(), "utf-8")) || {};
  } catch {
    /* no file yet, or unreadable — fall through to env/default */
  }
  const envBudget = clampRamBudget(process.env.FF_RAM_BUDGET_GB);
  const fileBudget = clampRamBudget(fromFile.ramBudgetGB);
  return {
    ramBudgetGB: fileBudget ?? envBudget ?? RAM_BUDGET_DEFAULT,
    updatedAt: fromFile.updatedAt,
    updatedBy: fromFile.updatedBy,
  };
}

export async function writeExportSettings(patch: {
  ramBudgetGB: number;
  updatedBy?: string;
}): Promise<ExportSettings> {
  const next: ExportSettings = {
    ramBudgetGB: patch.ramBudgetGB,
    updatedAt: Math.floor(Date.now() / 1000),
    updatedBy: patch.updatedBy,
  };
  await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), "utf-8");
  return next;
}
