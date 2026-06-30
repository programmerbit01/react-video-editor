export interface RenderJob {
  status: string;
  progress: number;
  error?: string;
  engine?: string;
  source?: string;
  project_name?: string;
  started_at?: number;
  video_seconds?: number;
  // Optional render metrics / config (for visibility + debugging speed).
  concurrency?: number;
  cores?: number;
  gpu?: string;
  hwAccel?: string;
  render_seconds?: number;
  render_fps?: number;
  speed_x?: number;
  size_mb?: number;
}

export const jobs = new Map<string, RenderJob>();
