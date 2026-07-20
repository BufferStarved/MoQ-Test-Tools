import { Suspense, lazy, useEffect, useMemo } from "react";
import type { PlaybackMetricsSnapshot } from "./api";
import {
  defaultPlaybackModeForProtocol,
  defaultWhepPlaybackUrl,
  isPlaybackModeCompatible,
  playbackModeLabelForSelection,
  playbackModesForSelection,
  playbackSelectionCopy,
  resolvePlaybackTarget,
} from "./playbackUrls";

function parseHostSafe(endpointUrl: string): string | null {
  try {
    if (endpointUrl.startsWith("srt://") || endpointUrl.startsWith("rtmp://")) {
      const withoutScheme = endpointUrl.split("://")[1] ?? "";
      const hostPart = withoutScheme.split(/[/?]/)[0] ?? "";
      return hostPart.split(":")[0] || null;
    }
    return new URL(endpointUrl).hostname || null;
  } catch {
    return null;
  }
}
import type { PlaybackGate } from "./playbackGate";
import type { PlaybackMode } from "./playbackTypes";
import { PlayerErrorBoundary } from "./players/PlayerErrorBoundary";

const HlsPlayer = lazy(() => import("./players/HlsPlayer"));
const DashPlayer = lazy(() => import("./players/DashPlayer"));
const MpegTsPlayer = lazy(() => import("./players/MpegTsPlayer"));
const WhepPlayer = lazy(() => import("./players/WhepPlayer"));
const MoqPlayer = lazy(() => import("./players/MoqPlayer"));
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
  zixiPlaybackStreamId?: string;
  playbackGate?: PlaybackGate;
  jobId?: string;
  encodeStartedAtEpoch?: number | null;
  onPlaybackSample?: (sample: PlaybackMetricsSnapshot & { elapsed_sec: number }) => void;
  jobStatus?: string;
  benchmarkLoading?: boolean;
  encodeDurationSec?: number;
  targetLatencyMs?: number;
  encodeLadder?: string;
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
  playbackMode,
  playbackDvr = false,
  whepPlaybackUrl = "",
  moqRelayUrl = "",
  moqFingerprintUrl = "",
  moqNamespace = "",
  zixiStreamId = "",
  zixiPlaybackStreamId = "",
  playbackGate = "idle",
  jobId,
  encodeStartedAtEpoch,
  onPlaybackSample,
  jobStatus,
  benchmarkLoading = false,
  encodeDurationSec = 30,
  targetLatencyMs = 800,
  encodeLadder,
  hlsLiveSyncCount = 2,
  hlsLiveSyncDurationSec = 4,
  controlsLocked = false,
  onPlaybackModeChange,
  onWhepPlaybackUrlChange,
  compactHeader = false,
}: StreamPlayerProps) {
  const resolvedMode =
    playbackMode && isPlaybackModeCompatible(playbackMode, protocol, ingestEndpointId)
      ? playbackMode
      : defaultPlaybackModeForProtocol(protocol, ingestEndpointId);

  useEffect(() => {
    if (!onPlaybackModeChange) {
      return;
    }
    if (playbackMode !== resolvedMode) {
      onPlaybackModeChange(resolvedMode);
    }
  }, [playbackMode, resolvedMode, onPlaybackModeChange]);

  const target = useMemo(
    () =>
      resolvePlaybackTarget({
        protocol,
        endpointUrl,
        ingestEndpointId,
        playbackMode: resolvedMode,
        playbackDvr,
        whepPlaybackUrl,
        moqRelayUrl,
        moqFingerprintUrl,
        moqNamespace,
        zixiStreamId,
        zixiPlaybackStreamId,
      }),
    [
      protocol,
      endpointUrl,
      ingestEndpointId,
      resolvedMode,
      playbackDvr,
      whepPlaybackUrl,
      moqRelayUrl,
      moqFingerprintUrl,
      moqNamespace,
      zixiStreamId,
      zixiPlaybackStreamId,
    ],
  );

  const showWhepField = resolvedMode === "whep";
  const whepPlaceholder = defaultWhepPlaybackUrl(
    parseHostSafe(endpointUrl) ?? "34.9.217.178",
    "benchmark",
  );
  const playerModes = playbackModesForSelection(protocol, ingestEndpointId);
  const selectionCopy = playbackSelectionCopy(
    resolvedMode,
    target,
    protocol,
    ingestEndpointId,
  );
  const hlsLowLatency =
    target.note === "lowLatencyMode" || resolvedMode === "ll-hls";
  const dashLowLatency =
    target.note === "lowLatencyDash" || resolvedMode === "ll-dash";
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
              value={resolvedMode}
              onChange={(e) => onPlaybackModeChange(e.target.value as PlaybackMode)}
              disabled={controlsLocked || playerModes.length <= 1}
            >
              {playerModes.map((item) => (
                <option key={item.id} value={item.id}>
                  {playbackModeLabelForSelection(item.id, protocol, ingestEndpointId)}
                </option>
              ))}
            </select>
            <span className="player-mode-hint">
              <strong className="player-mode-hint-label">{selectionCopy.label}</strong>
              {selectionCopy.description ? (
                <span className="hint">{selectionCopy.description}</span>
              ) : null}
            </span>
          </label>
          {showWhepField && onWhepPlaybackUrlChange && (
            <label>
              WHEP Playback URL
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

      {target.url && target.engine !== "unsupported" && (
        <p className="hint player-url">
          <span className="url-field-label">Playback URL</span>
          <code>{target.url}</code>
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
              encodeLadder={encodeLadder}
              targetLatencyMs={targetLatencyMs}
              zixiStreamId={zixiStreamId}
              lowLatencyMode={hlsLowLatency}
            />
          )}
          {target.engine === "dash" && (
            <DashPlayer
              key={`${target.url}:ll${dashLowLatency ? 1 : 0}`}
              url={target.url}
              label={target.label}
              playbackGate={playbackGate}
              lowLatencyMode={dashLowLatency}
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
          {target.engine === "unsupported" && <UnsupportedPlayback target={target} />}
        </Suspense>
      </PlayerErrorBoundary>
    </div>
  );
}
