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
