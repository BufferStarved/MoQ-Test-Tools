import type { PlaybackMetricsSnapshot } from "./api";

export const EMPTY_PLAYBACK_METRICS: PlaybackMetricsSnapshot = {
  playback_stats_events: 0,
  playback_stall_count: 0,
  playback_frames_rendered: 0,
  playback_frames_dropped: 0,
  playback_bitrate_bps: 0,
  playback_ttff_ms: 0,
  playback_hls_errors: 0,
  playback_hls_fatal_errors: 0,
  playback_hls_buffer_stalls: 0,
  playback_hls_frag_loads: 0,
  playback_video_time_sec: 0,
  playback_error_count: 0,
  e2e_latency_ms: 0,
};

export function mergePlaybackSampleIntoUploadSample<T extends { elapsed_sec: number }>(
  samples: T[],
  playback: PlaybackMetricsSnapshot & { elapsed_sec: number },
): T[] {
  const index = samples.findIndex((sample) => sample.elapsed_sec === playback.elapsed_sec);
  if (index < 0) {
    return samples;
  }
  const next = [...samples];
  next[index] = { ...next[index], ...playback };
  return next;
}
