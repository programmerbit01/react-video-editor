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

// ── Reap ffmpeg an earlier editor orphaned ───────────────────────────────────────────────────
//
// Both maps above live in memory, so a restart forgets every render it was running — but the
// ffmpeg it spawned does NOT die with it. They are ordinary children: the parent goes, they get
// reparented to pid 1 and carry on encoding, invisible to the new process and to Cancel, which
// can only kill children THIS process registered. "I restart the editor and they keep running"
// is exactly right, so a fresh process cleans up after the dead one.
//
// THE ONLY SAFE DISCRIMINATOR IS THE PARENT PID. A live render's ffmpeg and a dead render's
// orphan look identical on the command line — both write into our exports dir. The difference is
// that an orphan's parent is gone, so it has been reparented to pid 1; a live child still has a
// real parent. Matching on the command line alone kills the render that is running right now:
// this function did exactly that, and the segments it murdered reported "killed by SIGKILL with
// no output", which the segment handler then blamed on the kernel's OOM killer. A self-inflicted
// kill wearing an out-of-memory costume.
//
// It also runs ONCE per process. Module scope is not startup — a dev-mode re-evaluation is
// enough to re-run it, mid-render.
let reaped = false;
function reapOrphanedFfmpeg(): void {
  if (reaped || process.platform === "win32") return; // ps -o ppid= isn't a thing on win32
  reaped = true;
  try {
    // Required lazily: this module is imported by route handlers, and pulling child_process in
    // at module scope drags it into every bundle that touches a job.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require("child_process") as typeof import("child_process");
    const exportsDir = `${eval("process.cwd()")}/public/exports`;
    const out = execSync("ps -Ao pid=,ppid=,args= 2>/dev/null || true", { encoding: "utf8" });
    const orphans = out
      .split("\n")
      // `ps` gives "  1234   1 ffmpeg -y …" or "  1234   1 /usr/bin/ffmpeg -y …" — the command is
      // preceded by a SPACE as often as a slash, and anchoring on `/` alone matched nothing at all.
      .filter((l) => /(^|[\/\s])ffmpeg\s/.test(l) && l.includes(exportsDir))
      .map((l) => {
        const [pid, ppid] = l.trim().split(/\s+/, 2).map(Number);
        return { pid, ppid };
      })
      // ppid 1 = the editor that started it is gone. Anything else still has a parent, and that
      // parent might be us.
      .filter((p) => Number.isFinite(p.pid) && p.pid > 0 && p.ppid === 1)
      .map((p) => p.pid);
    for (const pid of orphans) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone, or not ours to kill */
      }
    }
    if (orphans.length) {
      console.warn(
        `[FF/reap] killed ${orphans.length} ffmpeg orphaned by a previous editor process ` +
          `(pids ${orphans.join(", ")}). They outlive a restart because they are ordinary ` +
          `children and jobChildren is in-memory — restarting the editor does not stop them.`
      );
    }
  } catch {
    /* best effort — never block startup over this */
  }
}
reapOrphanedFfmpeg();
