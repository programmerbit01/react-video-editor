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
}

export const jobs = new Map<string, RenderJob>();
