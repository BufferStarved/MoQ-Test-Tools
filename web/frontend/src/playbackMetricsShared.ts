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
  playback_buffer_sec: 0,
  playback_rebuffer_sec: 0,
  playback_error_count: 0,
  e2e_latency_ms: 0,
};

export function mergePlaybackSampleIntoUploadSample<T extends { elapsed_sec: number }>(
  samples: T[],
  playback: PlaybackMetricsSnapshot & { elapsed_sec: number },
): T[] {
  if (samples.length === 0) {
    return samples;
  }
  let index = samples.findIndex((sample) => sample.elapsed_sec === playback.elapsed_sec);
  if (index < 0) {
    // Playback ticks and upload SSE samples rarely share the same second stamp;
    // attach to the latest sample at-or-before the playback elapsed time.
    let best = -1;
    for (let i = 0; i < samples.length; i += 1) {
      if (samples[i].elapsed_sec <= playback.elapsed_sec) {
        best = i;
      }
    }
    index = best >= 0 ? best : samples.length - 1;
  }
  const next = [...samples];
  next[index] = { ...next[index], ...playback };
  return next;
}
