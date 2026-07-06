export interface Protocol {
  id: string;
  label: string;
  syntax: string;
}

export interface Preset {
  id: string;
  name: string;
  protocol: string;
  notes: string;
  env_vars: string[];
  requires_env: boolean;
}

export interface UploadSample {
  elapsed_sec: number;
  bitrate_kbps: number;
  fps: number;
  speed: number;
  out_time: string;
  cpu_percent: number;
  memory_mb: number;
  progress: string;
}

export interface UploadJob {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  protocol: string;
  endpoint_url: string;
  media_path: string;
  duration_sec: number;
  preset_id?: string;
  created_at: string;
  csv_path?: string | null;
  error?: string | null;
  samples: UploadSample[];
}

export interface ResultFile {
  filename: string;
  path: string;
  modified_at: string;
  size_bytes: number;
}

export interface ResultSummary {
  filename: string;
  samples: number;
  protocol: string;
  endpoint: string;
  averages: {
    cpu_percent: number;
    memory_mb: number;
    bitrate_kbps: number;
    fps: number;
    speed: number;
  };
  rows: Record<string, string>[];
}
