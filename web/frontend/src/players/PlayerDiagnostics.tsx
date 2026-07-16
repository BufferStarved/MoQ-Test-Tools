import { useState } from "react";
import type { PlaybackGate } from "../playbackGate";
import { fetchPlaybackProbe } from "../api";

export interface PlayerDiagnosticsProps {
  engine: "hls" | "moq";
  playbackGate: PlaybackGate;
  jobStatus?: string;
  benchmarkLoading?: boolean;
  status: string;
  error?: string | null;
  lines?: string[];
  manifestUrl?: string;
}

export function PlayerDiagnostics({
  engine,
  playbackGate,
  jobStatus,
  benchmarkLoading,
  status,
  error,
  lines = [],
  manifestUrl,
}: PlayerDiagnosticsProps) {
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);

  async function runProbe() {
    if (!manifestUrl) {
      return;
    }
    setProbeBusy(true);
    try {
      const result = await fetchPlaybackProbe(manifestUrl);
      const summary = [
        `probe_manifest=${result.manifest_ok} (${result.manifest_bytes}b)`,
        `probe_segment=${result.segment_ok} (${result.segment_bytes}b)`,
        result.segment_decodable === false
          ? "probe_decode=FAIL (segment lacks decodable H.264 — missing SPS/PPS)"
          : result.segment_decodable
            ? `probe_decode=ok ${result.segment_video ?? ""}`.trim()
            : null,
        result.checks.length ? `probe_checks=${result.checks.join(",")}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      setProbeResult(summary);
    } catch (err) {
      setProbeResult(err instanceof Error ? err.message : "Probe failed");
    } finally {
      setProbeBusy(false);
    }
  }

  const entries = [
    `gate=${playbackGate}`,
    jobStatus ? `job=${jobStatus}` : null,
    benchmarkLoading ? "benchmark=starting" : "benchmark=idle",
    `player=${status}`,
    ...lines,
  ].filter(Boolean) as string[];

  return (
    <details className="player-diagnostics">
      <summary>Playback diagnostics ({engine.toUpperCase()})</summary>
      <ul>
        {entries.map((line, index) => (
          <li key={`${index}-${line}`}>
            <code>{line}</code>
          </li>
        ))}
      </ul>
      {error && (
        <p className="player-error">
          <strong>Last error:</strong> {error}
        </p>
      )}
      {engine === "hls" && manifestUrl && (
        <p>
          <button type="button" className="ghost-button" disabled={probeBusy} onClick={() => void runProbe()}>
            {probeBusy ? "Probing…" : "Run server probe"}
          </button>
          {probeResult && <span className="hint"> {probeResult}</span>}
        </p>
      )}
      <p className="hint">
        Open DevTools → Network and filter <code>playback/fetch</code> during a live encode. Each
        segment should return HTTP 200 with a non-zero body.
      </p>
    </details>
  );
}
