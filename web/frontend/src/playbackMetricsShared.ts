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

const PLAYBACK_COUNTER_KEYS = [
  "playback_stats_events",
  "playback_stall_count",
  "playback_frames_rendered",
  "playback_frames_dropped",
  "playback_hls_errors",
  "playback_hls_fatal_errors",
  "playback_hls_buffer_stalls",
  "playback_hls_frag_loads",
  "playback_error_count",
  "playback_rebuffer_sec",
  "playback_video_time_sec",
  "playback_ttff_ms",
] as const;

const PLAYBACK_GAUGE_KEYS = ["playback_bitrate_bps", "playback_buffer_sec", "e2e_latency_ms"] as const;

/** Read one playback metric off any object that may carry it. Callers pass
 *  upload samples, SSE snapshots and merged spreads, none of which declare an
 *  index signature, so the lookup is done through a widened view. */
function metricNumber(source: object, key: string): number {
  return Number((source as Record<string, unknown>)[key] ?? 0);
}

/** Keep painted-glass high-water. A reconnect snapshot of zeros must not
 * erase frames / e2e / buffer from the live series or the CSV tail. */
export function applyPlaybackHighWater<T extends object>(
  dest: T,
  incoming: object | undefined,
): T {
  if (!incoming) {
    return dest;
  }
  const next: Record<string, unknown> = { ...(dest as Record<string, unknown>) };
  for (const key of PLAYBACK_COUNTER_KEYS) {
    next[key] = Math.max(metricNumber(dest, key), metricNumber(incoming, key));
  }
  for (const key of PLAYBACK_GAUGE_KEYS) {
    const value = metricNumber(incoming, key);
    if (value > 0) {
      next[key] = value;
    }
  }
  return next as T;
}

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
  next[index] = applyPlaybackHighWater({ ...next[index], ...playback }, next[index]);
  return next;
}
