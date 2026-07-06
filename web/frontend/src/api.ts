import type { Preset, Protocol, ResultFile, ResultSummary, UploadJob } from "./types";

const API_BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(detail.detail || "Request failed");
  }
  return response.json();
}

export function fetchProtocols(): Promise<{ protocols: Protocol[] }> {
  return request("/protocols");
}

export function fetchPresets(protocol?: string): Promise<{ presets: Preset[] }> {
  const query = protocol ? `?protocol=${protocol}` : "";
  return request(`/presets${query}`);
}

export function createUpload(payload: {
  media_path: string;
  duration_sec: number;
  preset_id?: string;
  protocol?: string;
  endpoint_url?: string;
}): Promise<UploadJob> {
  return request("/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function fetchUpload(jobId: string): Promise<UploadJob> {
  return request(`/uploads/${jobId}`);
}

export function fetchResults(): Promise<{ results: ResultFile[] }> {
  return request("/results");
}

export function fetchResultDetail(filename: string): Promise<ResultSummary> {
  return request(`/results/${filename}`);
}

export function subscribeToUpload(
  jobId: string,
  onSample: (sample: UploadJob["samples"][number]) => void,
  onStatus: (status: { status: string; csv_path?: string | null; error?: string | null }) => void,
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
