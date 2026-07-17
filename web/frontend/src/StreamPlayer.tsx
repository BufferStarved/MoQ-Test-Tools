import { Suspense, lazy, useEffect, useMemo } from "react";
import type { PlaybackMetricsSnapshot } from "./api";
import {
  PLAYBACK_MODE_OPTIONS,
  defaultPlaybackModeForProtocol,
  defaultWhepPlaybackUrl,
  isPlaybackModeCompatible,
  resolvePlaybackTarget,
} from "./playbackUrls";
import type { PlaybackGate } from "./playbackGate";
import type { PlaybackMode } from "./playbackTypes";
import { PlayerErrorBoundary } from "./players/PlayerErrorBoundary";

const HlsPlayer = lazy(() => import("./players/HlsPlayer"));
const DashPlayer = lazy(() => import("./players/DashPlayer"));
const MpegTsPlayer = lazy(() => import("./players/MpegTsPlayer"));
const WhepPlayer = lazy(() => import("./players/WhepPlayer"));
const MoqPlayer = lazy(() => import("./players/MoqPlayer"));
const ZixiWebRtcEmbed = lazy(() => import("./players/ZixiWebRtcEmbed"));
const UnsupportedPlayback = lazy(() => import("./players/UnsupportedPlayback"));

interface StreamPlayerProps {
  title: string;
  protocol: string;
  endpointUrl: string;
  ingestEndpointId: string;
  playbackMode?: PlaybackMode;
  playbackDvr?: boolean;
  whepPlaybackUrl?: string;
  moqRelayUrl?: string;
  moqFingerprintUrl?: string;
  moqNamespace?: string;
  zixiStreamId?: string;
  playbackGate?: PlaybackGate;
  jobId?: string;
  encodeStartedAtEpoch?: number | null;
  onPlaybackSample?: (sample: PlaybackMetricsSnapshot & { elapsed_sec: number }) => void;
  jobStatus?: string;
  benchmarkLoading?: boolean;
  encodeDurationSec?: number;
  targetLatencyMs?: number;
  hlsLiveSyncCount?: number;
  hlsLiveSyncDurationSec?: number;
  controlsLocked?: boolean;
  onPlaybackModeChange?: (mode: PlaybackMode) => void;
  onWhepPlaybackUrlChange?: (url: string) => void;
  /** When true, omit the card title (stream column already has a header). */
  compactHeader?: boolean;
}

function PlayerFallback() {
  return <div className="player-surface player-loading">Loading player...</div>;
}

export function StreamPlayer({
  title,
  protocol,
  endpointUrl,
  ingestEndpointId,
  playbackMode = "auto",
  playbackDvr = false,
  whepPlaybackUrl = "",
  moqRelayUrl = "",
  moqFingerprintUrl = "",
  moqNamespace = "",
  zixiStreamId = "",
  playbackGate = "idle",
  jobId,
  encodeStartedAtEpoch,
  onPlaybackSample,
  jobStatus,
  benchmarkLoading = false,
  encodeDurationSec = 30,
  targetLatencyMs = 800,
  hlsLiveSyncCount = 2,
  hlsLiveSyncDurationSec = 4,
  controlsLocked = false,
  onPlaybackModeChange,
  onWhepPlaybackUrlChange,
  compactHeader = false,
}: StreamPlayerProps) {
  useEffect(() => {
    if (!onPlaybackModeChange) {
      return;
    }
    if (!isPlaybackModeCompatible(playbackMode, protocol)) {
      onPlaybackModeChange(defaultPlaybackModeForProtocol(protocol));
    }
  }, [playbackMode, protocol, onPlaybackModeChange]);

  const target = useMemo(
    () =>
      resolvePlaybackTarget({
        protocol,
        endpointUrl,
        ingestEndpointId,
        playbackMode,
        playbackDvr,
        whepPlaybackUrl,
        moqRelayUrl,
        moqFingerprintUrl,
        moqNamespace,
        zixiStreamId,
      }),
    [
      protocol,
      endpointUrl,
      ingestEndpointId,
      playbackMode,
      playbackDvr,
      whepPlaybackUrl,
      moqRelayUrl,
      moqFingerprintUrl,
      moqNamespace,
      zixiStreamId,
    ],
  );

  const showWhepField = playbackMode === "whep";
  const whepPlaceholder =
    protocol === "srt"
      ? defaultWhepPlaybackUrl("35.222.33.58", "benchmark")
      : "http://host:8080/whep/benchmark";
  const selectedOption = PLAYBACK_MODE_OPTIONS.find((item) => item.id === playbackMode);
  const modeHint = selectedOption
    ? isPlaybackModeCompatible(playbackMode, protocol)
      ? selectedOption.hint
      : `Not available with ${protocol.toUpperCase()} ingest.`
    : "";
  // Wait for the per-job MoQ namespace before going live — using the preset
  // default ("benchmark") then flipping causes a Player/MediaSource remount.
  const moqReadyNamespace = (target.moqNamespace || moqNamespace || "").trim();
  const moqPlaybackGate: PlaybackGate =
    target.engine === "moq" && playbackGate === "live" && !moqReadyNamespace
      ? "waiting"
      : playbackGate;

  return (
    <div className={`stream-player-card${compactHeader ? " stream-player-card-embedded" : ""}`}>
      {!compactHeader && (
        <div className="stream-player-header">
          <h4>{title}</h4>
          <span className="pill">{target.label}</span>
        </div>
      )}
      {compactHeader && (
        <div className="stream-player-engine">
          <span className="pill">{target.label}</span>
        </div>
      )}

      {onPlaybackModeChange && (
        <div className="player-playback-controls">
          <label>
            Video player
            <select
              value={playbackMode}
              onChange={(e) => onPlaybackModeChange(e.target.value as PlaybackMode)}
              disabled={controlsLocked}
            >
              {PLAYBACK_MODE_OPTIONS.map((item) => {
                const compatible = isPlaybackModeCompatible(item.id, protocol);
                return (
                  <option key={item.id} value={item.id} disabled={!compatible}>
                    {item.label}
                    {!compatible ? " — incompatible with ingest" : ""}
                  </option>
                );
              })}
            </select>
            {modeHint ? <span className="hint">{modeHint}</span> : null}
          </label>
          {showWhepField && onWhepPlaybackUrlChange && (
            <label>
              WHEP channel URL
              <input
                type="url"
                value={whepPlaybackUrl}
                onChange={(e) => onWhepPlaybackUrlChange(e.target.value)}
                placeholder={whepPlaceholder}
                disabled={controlsLocked}
              />
            </label>
          )}
        </div>
      )}

      {target.url && target.engine !== "webrtc-embed" && (
        <p className="hint player-url">
          <code>{target.url}</code>
        </p>
      )}
      {target.engine === "webrtc-embed" && target.embedUrl && (
        <p className="hint player-url">
          <code>{target.embedUrl}</code>
        </p>
      )}

      <PlayerErrorBoundary engine={target.engine}>
        <Suspense fallback={<PlayerFallback />}>
          {target.engine === "hls" && (
            <HlsPlayer
              key={`${target.url}:sync${hlsLiveSyncDurationSec}`}
              url={target.url}
              label={target.label}
              playbackGate={playbackGate}
              jobId={jobId}
              encodeStartedAtEpoch={encodeStartedAtEpoch}
              onPlaybackSample={onPlaybackSample}
              jobStatus={jobStatus}
              benchmarkLoading={benchmarkLoading}
              liveSyncDurationCount={hlsLiveSyncCount}
              liveSyncDurationSec={hlsLiveSyncDurationSec}
            />
          )}
          {target.engine === "dash" && (
            <DashPlayer
              key={target.url}
              url={target.url}
              label={target.label}
              playbackGate={playbackGate}
            />
          )}
          {target.engine === "mpegts" && (
            <MpegTsPlayer key={target.url} url={target.url} label={target.label} />
          )}
          {target.engine === "whep" && (
            <WhepPlayer key={target.url} url={target.url} label={target.label} />
          )}
          {target.engine === "moq" && moqReadyNamespace && (
            <MoqPlayer
              key={`${target.url}:${moqReadyNamespace}`}
              relayUrl={target.url}
              namespace={moqReadyNamespace}
              fingerprintUrl={target.moqFingerprintUrl}
              label={target.label}
              playbackGate={moqPlaybackGate}
              pinTlsCert
              jobId={jobId}
              encodeStartedAtEpoch={encodeStartedAtEpoch}
              onPlaybackSample={onPlaybackSample}
              jobStatus={jobStatus}
              benchmarkLoading={benchmarkLoading}
              encodeDurationSec={encodeDurationSec}
              targetLatencyMs={targetLatencyMs}
            />
          )}
          {target.engine === "moq" && !moqReadyNamespace && (
            <div className="player-surface player-loading">
              <p className="hint">Waiting for MoQ publish namespace…</p>
            </div>
          )}
          {target.engine === "webrtc-embed" && target.embedUrl && (
            <ZixiWebRtcEmbed embedUrl={target.embedUrl} label={target.label} />
          )}
          {target.engine === "unsupported" && <UnsupportedPlayback target={target} />}
        </Suspense>
      </PlayerErrorBoundary>
    </div>
  );
}
