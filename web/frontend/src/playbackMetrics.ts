import { useEffect, useRef } from "react";
import { postPlaybackSample, type PlaybackMetricsSnapshot } from "./api";

const REPORT_INTERVAL_MS = 1000;

export function elapsedSecFromStart(startedAtEpoch?: number | null): number {
  if (!startedAtEpoch || startedAtEpoch <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor(Date.now() / 1000 - startedAtEpoch));
}

export function usePlaybackMetricsReporter(options: {
  jobId?: string;
  engine: "moq" | "hls";
  enabled: boolean;
  startedAtEpoch?: number | null;
  getSnapshot: () => PlaybackMetricsSnapshot;
  onSample?: (sample: PlaybackMetricsSnapshot & { elapsed_sec: number }) => void;
}): void {
  const { jobId, engine, enabled, startedAtEpoch, getSnapshot, onSample } = options;
  const getSnapshotRef = useRef(getSnapshot);
  const onSampleRef = useRef(onSample);

  useEffect(() => {
    getSnapshotRef.current = getSnapshot;
  }, [getSnapshot]);

  useEffect(() => {
    onSampleRef.current = onSample;
  }, [onSample]);

  useEffect(() => {
    if (!enabled || !jobId) {
      return;
    }

    let cancelled = false;

    const tick = () => {
      if (cancelled) {
        return;
      }
      const snapshot = getSnapshotRef.current();
      const elapsed_sec = elapsedSecFromStart(startedAtEpoch);
      const payload = {
        elapsed_sec,
        engine,
        ...snapshot,
      };
      onSampleRef.current?.(payload);
      void postPlaybackSample(jobId, payload).catch(() => {
        // Best-effort while the encode is running.
      });
    };

    tick();
    const timer = window.setInterval(tick, REPORT_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, jobId, engine, startedAtEpoch]);
}
