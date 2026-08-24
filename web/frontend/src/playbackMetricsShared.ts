import type { PlaybackMetricsSnapshot } from "./api";
import { applyLatencyBudgetToSample } from "./latencyBudget.ts";

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
  go_live_at_sec: 0,
  go_live_e2e_ms: 0,
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
  "go_live_at_sec",
  "go_live_e2e_ms",
] as const;

const PLAYBACK_GAUGE_KEYS = ["playback_bitrate_bps", "playback_buffer_sec", "e2e_latency_ms"] as const;

/**
 * One-shot join facts whose absence is a measurement, not a zero (see
 * PlaybackMetricsSnapshot). They are excluded from the counter high-water on
 * purpose: `Math.max(null, x)` is 0, which would report every unmeasured
 * startup phase as an instant one.
 */
const PLAYBACK_ONE_SHOT_KEYS = [
  "startup_player_request_ms",
  "startup_manifest_ms",
  "startup_first_media_ms",
  "startup_first_paint_ms",
] as const;

/** Read one playback metric off any object that may carry it. Callers pass
 *  upload samples, SSE snapshots and merged spreads, none of which declare an
 *  index signature, so the lookup is done through a widened view. */
function metricNumber(source: object, key: string): number {
  return Number((source as Record<string, unknown>)[key] ?? 0);
}

/** As metricNumber, but keeping "no reading" distinct from a reading of 0. */
function metricNullable(source: object, key: string): number | null {
  const raw = (source as Record<string, unknown>)[key];
  if (raw == null) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Keep painted-glass counters, but let a newer lower e2e / buffer win.
 *
 * `dest` is the proposed (newer) row — encoder SSE sample, or
 * `{...old, ...playback}`. `incoming` is the value already on the series.
 * A reconnect snapshot of zeros must not erase frames / e2e / buffer, but
 * high-watering e2e upward forever discarded the post-Go-Live drop
 * (HUD stayed at the pre-seek 8–9s). `go_live_*` stay in the counter
 * keys so the pre-click latch cannot fall.
 */
export function applyPlaybackHighWater<T extends object>(
  dest: T,
  incoming: object | undefined,
): T {
  if (!incoming) {
    return applyLatencyBudgetToSample(dest);
  }
  const next: Record<string, unknown> = { ...(dest as Record<string, unknown>) };
  for (const key of PLAYBACK_COUNTER_KEYS) {
    next[key] = Math.max(metricNumber(dest, key), metricNumber(incoming, key));
  }
  for (const key of PLAYBACK_GAUGE_KEYS) {
    const proposed = metricNumber(dest, key);
    const previous = metricNumber(incoming, key);
    if (proposed > 0) {
      next[key] = proposed;
    } else if (previous > 0) {
      next[key] = previous;
    }
  }
  for (const key of PLAYBACK_ONE_SHOT_KEYS) {
    // First honest reading wins. `incoming` is the value already on the
    // series, so a later sample cannot overwrite a measured phase with a
    // null (a reconnect restarts the chain) — and cannot overwrite a null
    // with a 0 either.
    next[key] = metricNullable(incoming, key) ?? metricNullable(dest, key);
  }
  return applyLatencyBudgetToSample(next as T);
}

/** Overlay a playback tick onto the HUD's latest sample every second. */
export function overlayPlaybackOnLatestSample<T extends object>(
  latest: T | null | undefined,
  playback: PlaybackMetricsSnapshot & { elapsed_sec: number },
): T {
  if (!latest) {
    return applyPlaybackHighWater({ ...playback } as T, undefined);
  }
  return applyPlaybackHighWater({ ...latest, ...playback }, latest);
}

/**
 * Encoder SSE rows already carry a nearest-at-or-before playback overlay
 * from the server. That overlay can still be the pre-seek e2e. Prefer the
 * browser's last playback gauges so Go Live can drop the HUD number.
 */
export function mergeEncoderSampleWithLivePlayback<T extends object>(
  encoderSample: T,
  live: T | null | undefined,
): T {
  if (!live) {
    return applyPlaybackHighWater(encoderSample, undefined);
  }
  const next: Record<string, unknown> = { ...(encoderSample as Record<string, unknown>) };
  for (const key of PLAYBACK_GAUGE_KEYS) {
    const liveValue = metricNumber(live, key);
    if (liveValue > 0) {
      next[key] = liveValue;
    }
  }
  return applyPlaybackHighWater(next as T, live);
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
