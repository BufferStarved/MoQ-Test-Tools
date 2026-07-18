import { useState } from "react";
import type { PlaybackGate } from "../playbackGate";
import { fetchPlaybackProbe, fetchZixiSrtDebug } from "../api";

export interface PlayerDiagnosticsProps {
  engine: "hls" | "moq";
  playbackGate: PlaybackGate;
  jobStatus?: string;
  benchmarkLoading?: boolean;
  status: string;
  error?: string | null;
  lines?: string[];
  manifestUrl?: string;
  encodeLadder?: string;
  targetLatencyMs?: number;
  zixiStreamId?: string;
}

function formatCapture(result: Awaited<ReturnType<typeof fetchPlaybackProbe>>): string {
  const headerLines = [
    `manifest_url=${result.manifest_url}`,
    `manifest_status=${result.manifest_status ?? "n/a"}`,
    `manifest_ok=${result.manifest_ok} (${result.manifest_bytes}b)`,
    `media_sequence=${result.media_sequence ?? "n/a"}`,
    `playlist_depth=${result.playlist_depth ?? "n/a"}`,
    `target_duration=${result.target_duration ?? "n/a"}`,
    `segment_url=${result.segment_url ?? "n/a"}`,
    `segment_status=${result.segment_status ?? "n/a"}`,
    `segment_ok=${result.segment_ok} (${result.segment_bytes}b)`,
    result.segment_decodable === false
      ? "segment_decode=FAIL (missing SPS/PPS or undecodable)"
      : result.segment_decodable
        ? `segment_decode=ok ${result.segment_video ?? ""}`.trim()
        : null,
    result.checks.length ? `checks=${result.checks.join(",")}` : null,
    result.curl_playlist ? `curl_playlist=${result.curl_playlist}` : null,
    result.curl_segment ? `curl_segment=${result.curl_segment}` : null,
  ].filter(Boolean);

  const manifestHeaders = Object.entries(result.manifest_headers || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const segmentHeaders = Object.entries(result.segment_headers || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  return [
    "=== Zixi Fast HLS capture ===",
    ...headerLines,
    "",
    "--- playlist body ---",
    result.manifest_body || "(empty)",
    "",
    "--- playlist response headers ---",
    manifestHeaders || "(none)",
    "",
    "--- segment response headers ---",
    segmentHeaders || "(none)",
  ].join("\n");
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
  encodeLadder,
  targetLatencyMs,
  zixiStreamId,
}: PlayerDiagnosticsProps) {
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [captureText, setCaptureText] = useState<string | null>(null);
  const [recipeText, setRecipeText] = useState<string | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  async function copyText(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  }

  async function runProbe(mode: "summary" | "capture") {
    if (!manifestUrl) {
      return;
    }
    setProbeBusy(true);
    try {
      const result = await fetchPlaybackProbe(manifestUrl);
      if (mode === "capture") {
        const text = formatCapture(result);
        setCaptureText(text);
        setProbeResult(
          `seq=${result.media_sequence ?? "?"} depth=${result.playlist_depth ?? "?"} seg_http=${result.segment_status ?? "n/a"}`,
        );
        await copyText("capture", text);
      } else {
        const summary = [
          `probe_manifest=${result.manifest_ok} (${result.manifest_bytes}b)`,
          `probe_segment=${result.segment_ok} (${result.segment_bytes}b)`,
          result.media_sequence != null ? `seq=${result.media_sequence}` : null,
          result.playlist_depth != null ? `depth=${result.playlist_depth}` : null,
          result.segment_status != null ? `seg_http=${result.segment_status}` : null,
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
      }
    } catch (err) {
      setProbeResult(err instanceof Error ? err.message : "Probe failed");
    } finally {
      setProbeBusy(false);
    }
  }

  async function loadPublishRecipe() {
    setProbeBusy(true);
    try {
      const recipe = await fetchZixiSrtDebug({
        encode_ladder: encodeLadder,
        target_latency_ms: targetLatencyMs,
        stream_id: zixiStreamId,
      });
      const text = [
        "=== Zixi SRT publish recipe ===",
        `broadcaster=${recipe.broadcaster.host} build=${recipe.broadcaster.build_hint}`,
        `srt_input=${recipe.broadcaster.srt_input}`,
        `stream_id=${recipe.stream_id}`,
        `streamid_payload=${recipe.streamid_payload}`,
        `pipeline=${recipe.pipeline}`,
        `gop_frames=${recipe.video_notes.gop_frames} (~${recipe.video_notes.keyframe_interval_sec}s)`,
        `x264_params=${recipe.video_notes.x264_params}`,
        `bsf=${recipe.video_notes.bsf}`,
        `audio=${recipe.audio}`,
        "",
        "ffmpeg (illustrative; hosted path uses local UDP + srt-live-transmit):",
        recipe.ffmpeg_example,
        "",
        recipe.srt_transmit_example,
        "",
        recipe.curl_playlist,
        recipe.curl_segment_chunk0,
        "",
        `player_attach=${recipe.player_attach}`,
        `reconnect=${recipe.reconnect}`,
        "",
        "config_scripts:",
        ...recipe.config_scripts.map((u) => `  ${u}`),
      ].join("\n");
      setRecipeText(text);
      await copyText("recipe", text);
    } catch (err) {
      setProbeResult(err instanceof Error ? err.message : "Recipe fetch failed");
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

  async function copyDiagnostics() {
    const text = [
      ...entries,
      error ? `last_error=${error}` : null,
      probeResult ? `server_probe=${probeResult}` : null,
      manifestUrl ? `manifest=${manifestUrl}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    await copyText("diag", text);
  }

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
      <p className="player-diagnostics-actions">
        <button type="button" className="ghost-button" onClick={() => void copyDiagnostics()}>
          {copied === "diag" ? "Copied" : "Copy diagnostics"}
        </button>
        {engine === "hls" && manifestUrl && (
          <>
            <button
              type="button"
              className="ghost-button"
              disabled={probeBusy}
              onClick={() => void runProbe("summary")}
            >
              {probeBusy ? "Probing…" : "Run server probe"}
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={probeBusy}
              onClick={() => void runProbe("capture")}
            >
              {copied === "capture" ? "Capture copied" : "Capture stuck playlist"}
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={probeBusy}
              onClick={() => void loadPublishRecipe()}
            >
              {copied === "recipe" ? "Recipe copied" : "Copy publish recipe"}
            </button>
          </>
        )}
        {probeResult && <span className="hint"> {probeResult}</span>}
      </p>
      {captureText && (
        <pre className="player-diagnostics-capture" tabIndex={0}>
          {captureText}
        </pre>
      )}
      {recipeText && !captureText && (
        <pre className="player-diagnostics-capture" tabIndex={0}>
          {recipeText}
        </pre>
      )}
      <p className="hint">
        For Zixi support: during a stuck SRT preview, use <strong>Capture stuck playlist</strong>{" "}
        (raw <code>playback.m3u8</code> + segment status/headers) and{" "}
        <strong>Copy publish recipe</strong> (ffmpeg / stream id / reconnect notes). Also open
        DevTools → Network and filter <code>playback/fetch</code>.
      </p>
    </details>
  );
}
