import { Suspense, lazy, useEffect, useMemo } from "react";
import type { PlaybackMetricsSnapshot } from "./api";
import {
  isPlaybackModeCompatible,
  resolvePlaybackTarget,
  resolvedPlaybackMode,
} from "./playbackUrls";
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
  /** LL-HLS: server-measured encoder→packager transit added to PDT latency. */
  packagerTransitMs?: number | null;
  /** Zixi Fast HLS: encode-media seconds at hls.js buffer time 0. */
  deliveryMediaOriginSec?: number | null;
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
  /** False when the publish source is video-only (e.g. webcam without a mic). */
  sourceHasAudio?: boolean;
  /** Capture->bridge-output lag (live webcam runs); 0 for VOD sources. */
  bridgeLagMs?: number;
  /** This leg's encoder lag behind realtime (from -progress samples). */
  encoderLagMs?: number;
  /** MOQT draft the in-page publisher negotiated; ffmpeg/openmoq legs stay 16. */
  moqDraftVersion?: 16 | 18;
  /** Browser source publishes LOC; ffmpeg/openmoq publishes CMAF. */
  moqMediaPackaging?: "cmaf" | "loc";
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
  packagerTransitMs = null,
  deliveryMediaOriginSec = null,
  onPlaybackSample,
  jobStatus,
  benchmarkLoading = false,
  encodeDurationSec = 30,
  targetLatencyMs = 800,
  encodeLadder,
  hlsLiveSyncCount = 2,
  hlsLiveSyncDurationSec = 4,
  controlsLocked: _controlsLocked = false,
  onPlaybackModeChange,
  onWhepPlaybackUrlChange: _onWhepPlaybackUrlChange,
  compactHeader = false,
  sourceHasAudio = true,
  bridgeLagMs = 0,
  encoderLagMs = 0,
  moqDraftVersion = 16,
  moqMediaPackaging = "cmaf",
}: StreamPlayerProps) {
  const resolvedMode = resolvedPlaybackMode(playbackMode, protocol, ingestEndpointId);

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
      {target.url && target.engine !== "unsupported" && (
        <details className="output-advanced">
          <summary>Playback URL</summary>
          <p className="hint player-url">
            <code>{target.url}</code>
          </p>
        </details>
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
              packagerTransitMs={packagerTransitMs}
              deliveryMediaOriginSec={deliveryMediaOriginSec}
              onPlaybackSample={onPlaybackSample}
              jobStatus={jobStatus}
              benchmarkLoading={benchmarkLoading}
              liveSyncDurationCount={hlsLiveSyncCount}
              liveSyncDurationSec={hlsLiveSyncDurationSec}
              encodeLadder={encodeLadder}
              targetLatencyMs={targetLatencyMs}
              zixiStreamId={zixiStreamId}
              lowLatencyMode={hlsLowLatency}
              bridgeLagMs={bridgeLagMs}
              encoderLagMs={encoderLagMs}
              onUnrecoverableHls={
                resolvedMode === "hls" &&
                onPlaybackModeChange &&
                isPlaybackModeCompatible("mpegts", protocol, ingestEndpointId)
                  ? () => onPlaybackModeChange("mpegts")
                  : undefined
              }
            />
          )}
          {target.engine === "dash" && (
            <DashPlayer
              key={`${target.url}:ll${dashLowLatency ? 1 : 0}`}
              url={target.url}
              label={target.label}
              playbackGate={playbackGate}
              lowLatencyMode={dashLowLatency}
              jobId={jobId}
              encodeStartedAtEpoch={encodeStartedAtEpoch}
              onPlaybackSample={onPlaybackSample}
              bridgeLagMs={bridgeLagMs}
              encoderLagMs={encoderLagMs}
            />
          )}
          {target.engine === "mpegts" && (
            <MpegTsPlayer
              key={target.url}
              url={target.url}
              label={target.label}
              playbackGate={playbackGate}
              jobId={jobId}
              encodeStartedAtEpoch={encodeStartedAtEpoch}
              onPlaybackSample={onPlaybackSample}
              bridgeLagMs={bridgeLagMs}
              encoderLagMs={encoderLagMs}
              skipConnectProbe={playbackGate === "live"}
              jobStatus={jobStatus}
              benchmarkLoading={benchmarkLoading}
            />
          )}
          {target.engine === "whep" && (
            <WhepPlayer
              key={target.url}
              url={target.url}
              label={target.label}
              playbackGate={playbackGate}
              jobId={jobId}
              encodeStartedAtEpoch={encodeStartedAtEpoch}
              onPlaybackSample={onPlaybackSample}
              bridgeLagMs={bridgeLagMs}
              encoderLagMs={encoderLagMs}
            />
          )}
          {target.engine === "moq" && moqReadyNamespace && (
            <MoqPlayer
              key={`${target.url}:${moqReadyNamespace}:d${moqDraftVersion}:${moqMediaPackaging}`}
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
              sourceHasAudio={sourceHasAudio}
              bridgeLagMs={bridgeLagMs}
              encoderLagMs={encoderLagMs}
              draftVersion={moqDraftVersion}
              mediaPackaging={moqMediaPackaging}
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
