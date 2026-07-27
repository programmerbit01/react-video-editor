// Server-side store for SUPERADMIN overrides of the built-in AI-Edit "directors" (the planner
// system prompts: Edit/General, Comic Drama, Faceless Video). The DEFAULT prompt text lives in
// the client (`features/editor/ai-edit/operations.ts`) so the editor always has a working brain
// even if this store is empty/unreachable. This file holds only the EDITS a superadmin makes in
// the GUI — applied globally (everyone on this editor host), live, no rebuild.
//
// WHY a flat JSON file (like export-settings) and not the vApp: keeps the change self-contained to
// the editor — no new vApp endpoint, no :8091 restart, and the editor is the only consumer of the
// director prompt (it sends it as the `role:system` message). An override missing → the client
// falls back to its built-in default. Custom (non-admin) directors stay in the user's localStorage.

import { promises as fs } from "fs";
import path from "path";

export interface DirectorOverride {
  label?: string;
  systemPrompt: string;
}

export interface DirectorsStore {
  overrides: Record<string, DirectorOverride>; // keyed by built-in director id
  updatedAt?: number;
  updatedBy?: string;
}

// The built-in ids a superadmin may override. "" = the plain Edit / General assistant.
const BUILTIN_IDS = new Set(["", "comic_drama", "faceless_video"]);

export function isBuiltinDirectorId(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

function storePath(): string {
  return path.join(process.cwd(), "directors.json");
}

/** Current overrides. Never throws — a missing/broken file → no overrides (client uses defaults). */
export async function readDirectors(): Promise<DirectorsStore> {
  try {
    const d = JSON.parse(await fs.readFile(storePath(), "utf-8")) || {};
    const overrides =
      d && typeof d.overrides === "object" && d.overrides ? (d.overrides as Record<string, DirectorOverride>) : {};
    return { overrides, updatedAt: d.updatedAt, updatedBy: d.updatedBy };
  } catch {
    return { overrides: {} };
  }
}

/** Set (or clear, when remove/empty) a built-in director's prompt override. Returns the new store. */
export async function writeDirectorOverride(
  id: string,
  patch: { label?: string; systemPrompt?: string; remove?: boolean; updatedBy?: string },
): Promise<DirectorsStore> {
  const cur = await readDirectors();
  const overrides: Record<string, DirectorOverride> = { ...cur.overrides };
  const prompt = String(patch.systemPrompt || "").trim();
  if (patch.remove || !prompt) {
    delete overrides[id]; // reset → fall back to the client's built-in default
  } else {
    const label = String(patch.label || "").trim();
    overrides[id] = { systemPrompt: prompt, ...(label ? { label } : {}) };
  }
  const next: DirectorsStore = {
    overrides,
    updatedAt: Math.floor(Date.now() / 1000),
    updatedBy: patch.updatedBy,
  };
  await fs.writeFile(storePath(), JSON.stringify(next, null, 2), "utf-8");
  return next;
}
