export interface RenderJob {
  status: string;
  progress: number;
  url?: string;
  error?: string;
  engine?: string;
  source?: string;
  project_name?: string;
  started_at?: number;
  video_seconds?: number;
  render_seconds?: number;
  speed_x?: number;
  encoder?: string;
  gpu?: string;
  hwAccel?: string;
  cores?: number;
  log?: string[];
  cancelled?: boolean;
  /** Item types FF could not draw and left out of this render. */
  dropped?: { type: string; count: number }[];
}

export const jobs = new Map<string, RenderJob>();

// Running ffmpeg child processes per job, so a Cancel can kill them immediately (not just
// stop spawning new segments). Registered by the render loop, killed by the cancel route.
export const jobChildren = new Map<string, Set<{ kill: (sig?: NodeJS.Signals | number) => void }>>();
export function killJobChildren(id: string): void {
  const set = jobChildren.get(id);
  if (set) for (const c of set) { try { c.kill("SIGKILL"); } catch { /* already gone */ } }
  jobChildren.delete(id);
}

// ── Reap ffmpeg we orphaned ──────────────────────────────────────────────────────────────────
//
// Both maps above live in memory, so a restart forgets every render it was running — but the
// ffmpeg processes it spawned do NOT die with it. They are ordinary children: the parent goes,
// they get reparented and carry on encoding, invisible to the new process and to Cancel, which
// can only kill children THIS process registered. Restarting the editor to get the box back is
// exactly what doesn't work, and the reported symptom — "I restart it and they keep running".
//
// So the new process reaps them. Only ffmpeg whose command line points into our own exports
// directory is touched: those are ours by construction, nobody else writes there, and the render
// that owned them is already gone.
function reapOrphanedFfmpeg(): void {
  if (process.platform === "win32") return; // pkill/ps -o args= aren't a thing there
  try {
    // Required lazily: this module is imported by route handlers, and pulling child_process in
    // at module scope drags it into every bundle that touches a job.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require("child_process") as typeof import("child_process");
    const exportsDir = `${eval("process.cwd()")}/public/exports`;
    const out = execSync("ps -Ao pid=,args= 2>/dev/null || true", { encoding: "utf8" });
    const self = process.pid;
    const mine = out
      .split("\n")
      // `ps -o pid=,args=` gives "  1234 ffmpeg -y …" or "  1234 /usr/bin/ffmpeg -y …", so the
      // command is preceded by a SPACE as often as a slash. Anchoring on `/` alone matched
      // nothing at all — this reaped zero orphans while looking like it worked.
      .filter((l) => /(^|[\/\s])ffmpeg\s/.test(l) && l.includes(exportsDir))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== self);
    for (const pid of mine) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone, or not ours to kill */
      }
    }
    if (mine.length) {
      console.warn(
        `[FF/reap] killed ${mine.length} orphaned ffmpeg left by a previous editor process ` +
          `(pids ${mine.join(", ")}). They survive a restart because they are ordinary children ` +
          `and jobChildren is in-memory — restarting the editor does not stop them.`
      );
    }
  } catch {
    /* best effort — never block startup over this */
  }
}
reapOrphanedFfmpeg();
