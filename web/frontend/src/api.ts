import type { Preset, Protocol, ResultFile, ResultSummary, UploadJob } from "./types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

function parseErrorDetail(detail: unknown, fallback: string): string {
  if (typeof detail === "string") {
    return detail;
  }
  if (Array.isArray(detail)) {
    return detail
      .map((item) => (typeof item === "object" && item && "msg" in item ? String(item.msg) : String(item)))
      .join(", ");
  }
  return fallback;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch {
    throw new Error(
      "Cannot reach the API. Start the backend with ./scripts/start-api.sh (or ./scripts/dev.sh for frontend + API).",
    );
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(parseErrorDetail(body.detail, response.statusText));
  }

  return response.json();
}

export function checkHealth(): Promise<{ status: string }> {
  return request("/health");
}

export function fetchProtocols(): Promise<{ protocols: Protocol[] }> {
  return request("/protocols");
}

export function fetchPresets(protocol?: string): Promise<{ presets: Preset[] }> {
  const query = protocol ? `?protocol=${encodeURIComponent(protocol)}` : "";
  return request(`/presets${query}`);
}

export function fetchVmafAvailable(params: {
  preset_id?: string;
  endpoint_url?: string;
}): Promise<{ available: boolean; endpoint_url: string; reason: string }> {
  const query = new URLSearchParams();
  if (params.preset_id) {
    query.set("preset_id", params.preset_id);
  }
  if (params.endpoint_url) {
    query.set("endpoint_url", params.endpoint_url);
  }
  return request(`/vmaf/available?${query.toString()}`);
}

export function fetchQualityAvailable(params: {
  preset_id?: string;
  endpoint_url?: string;
}): Promise<{
  encoder: { available: boolean; reason: string };
  ingest: { available: boolean; endpoint_url: string; reason: string };
}> {
  const query = new URLSearchParams();
  if (params.preset_id) {
    query.set("preset_id", params.preset_id);
  }
  if (params.endpoint_url) {
    query.set("endpoint_url", params.endpoint_url);
  }
  return request(`/quality/available?${query.toString()}`);
}

export function uploadMedia(file: File): Promise<{
  media_id: string;
  filename: string;
  media_path: string;
  size_bytes: number;
}> {
  const body = new FormData();
  body.append("file", file);
  return fetch(`${API_BASE}/media/upload`, { method: "POST", body }).then(async (response) => {
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(parseErrorDetail(payload.detail, response.statusText));
    }
    return response.json();
  });
}

export function createUpload(payload: {
  media_path: string;
  duration_sec?: number;
  preset_id?: string;
  protocol?: string;
  endpoint_url?: string;
  compute_vmaf_on_ingest?: boolean;
  compute_vmaf_encoder?: boolean;
  encode_ladder?: string;
  target_latency_ms?: number;
  comparison_id?: string;
  stream_index?: number;
  stream_label?: string;
}): Promise<UploadJob> {
  return request("/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function createLiveSession(payload: {
  stream_count: number;
  duration_sec?: number;
}): Promise<{
  session_id: string;
  duration_sec: number;
  media_paths: string[];
  ws_path: string;
}> {
  return request("/live/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export interface PlaybackMetricsSnapshot {
  playback_stats_events: number;
  playback_stall_count: number;
  playback_frames_rendered: number;
  playback_frames_dropped: number;
  playback_bitrate_bps: number;
  playback_ttff_ms: number;
  playback_hls_errors: number;
  playback_hls_fatal_errors: number;
  playback_hls_buffer_stalls: number;
  playback_hls_frag_loads: number;
  playback_video_time_sec: number;
  /** Seconds of media buffered ahead of the playhead. */
  playback_buffer_sec: number;
  /** Cumulative seconds the player spent in a rebuffer/stalled state. */
  playback_rebuffer_sec: number;
  playback_error_count?: number;
  e2e_latency_ms?: number;
}

export function postPlaybackSample(
  jobId: string,
  sample: PlaybackMetricsSnapshot & { elapsed_sec: number; engine: string },
): Promise<{ ok: boolean }> {
  return request(`/uploads/${jobId}/playback-sample`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sample),
  });
}

export function fetchUpload(jobId: string): Promise<UploadJob> {
  return request(`/uploads/${jobId}`);
}

export function stopUpload(jobId: string): Promise<{ ok: boolean; status: string }> {
  return request(`/uploads/${jobId}/stop`, { method: "POST" });
}

export function fetchResults(): Promise<{ results: ResultFile[] }> {
  return request("/results");
}

export function fetchResultDetail(filename: string): Promise<ResultSummary> {
  return request(`/results/${encodeURIComponent(filename)}`);
}

/** Basename of a job csv_path for /api/results/{filename}. */
export function resultFilenameFromPath(csvPath?: string | null): string | null {
  if (!csvPath) {
    return null;
  }
  const parts = csvPath.replace(/\\/g, "/").split("/");
  const name = parts[parts.length - 1] || "";
  return name.endsWith(".csv") ? name : null;
}

export function resultDownloadUrl(filename: string, kind: "csv" | "json" = "csv"): string {
  return `/api/results/${encodeURIComponent(filename)}/download?kind=${kind}`;
}

export function fetchPlaybackProbe(manifestUrl: string): Promise<{
  manifest_url: string;
  manifest_ok: boolean;
  manifest_bytes: number;
  segment_url: string | null;
  segment_ok: boolean;
  segment_bytes: number;
  segment_decodable?: boolean | null;
  segment_video?: string | null;
  checks: string[];
}> {
  const query = new URLSearchParams({ url: manifestUrl });
  return request(`/playback/probe?${query.toString()}`);
}

export function fetchMoqProbe(relayAdmin = "http://34.28.164.90:8000"): Promise<{
  relay_admin: string;
  reachable: boolean;
  subscribe_success: number | null;
  subscribe_error: number | null;
  subscribe_error_track_not_exist: number | null;
  publish_namespace_success: number | null;
  publish_received: number | null;
  publish_done: number | null;
  checks: string[];
}> {
  const query = new URLSearchParams({ relay_admin: relayAdmin });
  return request(`/moq/probe?${query.toString()}`);
}

export function subscribeToUpload(
  jobId: string,
  onSample: (sample: UploadJob["samples"][number]) => void,
  onStatus: (status: {
    status: string;
    csv_path?: string | null;
    summary_path?: string | null;
    error?: string | null;
    moq_namespace?: string | null;
    vmaf_status?: string | null;
    vmaf_score?: number | null;
    psnr_db?: number | null;
    ssim?: number | null;
    vmaf_error?: string | null;
    encoder_vmaf_status?: string | null;
    encoder_vmaf_score?: number | null;
    encoder_psnr_db?: number | null;
    encoder_ssim?: number | null;
    encoder_vmaf_error?: string | null;
  }) => void,
): () => void {
  const source = new EventSource(`${API_BASE}/uploads/${jobId}/events`);

  source.onmessage = (event) => {
    onSample(JSON.parse(event.data));
  };

  source.addEventListener("status", (event) => {
    onStatus(JSON.parse((event as MessageEvent).data));
  });

  source.onerror = () => {
    source.close();
  };

  return () => source.close();
}
