import { Suspense, lazy, useEffect, useMemo } from "react";
import type { PlaybackMetricsSnapshot } from "./api";
import {
  isPlaybackModeCompatible,
  resolvePlaybackTarget,
  resolvedPlaybackMode,
} from "./playbackUrls";
import { playbackModeAllowedInBrowser } from "./recipeSupport";
import { isSafariBrowser } from "./browserDetect";
import type { PlaybackGate } from "./playbackGate";
import type { PlaybackMode } from "./playbackTypes";
import { IconFilm } from "./Icons";
import { PlayerErrorBoundary } from "./players/PlayerErrorBoundary";
import { moqDraftForIngest, moqPinTlsCertForIngest } from "./ingestEndpoints";

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
  /** Zixi Fast HLS / HTTP-TS: encode-media seconds at buffer time 0. */
  deliveryMediaOriginSec?: number | null;
  onPlaybackSample?: (sample: PlaybackMetricsSnapshot & { elapsed_sec: number }) => void;
  jobStatus?: string;
  jobError?: string | null;
  encodeFramesTotal?: number;
  waitingForEncodeSlot?: boolean;
  encodeQueueAhead?: number;
  previewReady?: boolean;
  benchmarkLoading?: boolean;
  encodeDurationSec?: number;
  encodeElapsedSec?: number;
  runStopped?: boolean;
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
  /** Injected LOC catalog codec; must match the in-page encoder. */
  moqVideoCodec?: string;
  /** Capture->bridge-output lag (live webcam runs); 0 for VOD sources. */
  bridgeLagMs?: number;
  /** This leg's encoder lag behind realtime (from -progress samples). */
  encoderLagMs?: number;
  /** Full capture→muxed component (baseline + lag) for MoQ CMAF rebase. */
  encodeLatencyMs?: number;
  /** Path RTT from the latest encode/transport sample (ms). */
  netRttMs?: number;
  /** MOQT draft the in-page publisher negotiated; ffmpeg/openmoq legs stay 16. */
  moqDraftVersion?: 16 | 18;
  /** False for the draft-18 canary (public Let's Encrypt; hash-pin needs ≤14-day certs). */
  moqPinTlsCert?: boolean;
  /** Browser source publishes LOC; ffmpeg/openmoq publishes CMAF. */
  moqMediaPackaging?: "cmaf" | "loc";
  playbackPolicy?: "live-edge" | "complete";
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
  jobError = null,
  encodeFramesTotal = 0,
  waitingForEncodeSlot = false,
  encodeQueueAhead = 0,
  previewReady,
  benchmarkLoading = false,
  encodeDurationSec = 30,
  encodeElapsedSec,
  runStopped = false,
  targetLatencyMs = 800,
  encodeLadder,
  hlsLiveSyncCount = 2,
  hlsLiveSyncDurationSec = 4,
  controlsLocked: _controlsLocked = false,
  onPlaybackModeChange,
  onWhepPlaybackUrlChange: _onWhepPlaybackUrlChange,
  compactHeader = false,
  sourceHasAudio = true,
  moqVideoCodec,
  bridgeLagMs = 0,
  encoderLagMs = 0,
  encodeLatencyMs = 0,
  netRttMs = 0,
  moqDraftVersion,
  moqPinTlsCert,
  moqMediaPackaging = "cmaf",
  playbackPolicy = "live-edge",
}: StreamPlayerProps) {
  const resolvedDraft = moqDraftVersion ?? moqDraftForIngest(ingestEndpointId);
  const pinTlsCert = moqPinTlsCert ?? moqPinTlsCertForIngest(ingestEndpointId);
  const resolvedMode = resolvedPlaybackMode(playbackMode, protocol, ingestEndpointId, endpointUrl);

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
  // Wait for the per-job MoQ namespace before going live. resolvePlaybackTarget
  // invents "benchmark" from the preset URL — that must not win over a missing
  // job namespace or we SUBSCRIBE the wrong ns while ffmpeg publishes bench-*.
  const moqReadyNamespace = (moqNamespace || "").trim();
  const moqPlaybackGate: PlaybackGate =
    target.engine === "moq" && playbackGate === "live" && !moqReadyNamespace
      ? "waiting"
      : playbackGate;

  const previewActive =
    playbackGate === "live" || playbackGate === "ended" || playbackGate === "waiting";

  return (
    <div className={`stream-player-card${compactHeader ? " stream-player-card-embedded" : ""}`}>
      {!compactHeader && (
        <div className="stream-player-header">
          <h4>{title}</h4>
          <span className="pill">{target.label}</span>
        </div>
      )}
      {!previewActive ? (
        <div className="player-idle-placeholder" role="status">
          <IconFilm size={22} />
          <span>Awaiting publish…</span>
        </div>
      ) : (
      <PlayerErrorBoundary engine={target.engine}>
        <Suspense fallback={<PlayerFallback />}>
          {target.engine === "hls" && (
            <HlsPlayer
              key={`${target.url}:sync${hlsLiveSyncDurationSec}:p${playbackPolicy}`}
              url={target.url}
              label={target.label}
              playbackGate={playbackGate}
              jobId={jobId}
              encodeStartedAtEpoch={encodeStartedAtEpoch}
              packagerTransitMs={packagerTransitMs}
              deliveryMediaOriginSec={deliveryMediaOriginSec}
              onPlaybackSample={onPlaybackSample}
              jobStatus={jobStatus}
              waitingForEncodeSlot={waitingForEncodeSlot}
              encodeQueueAhead={encodeQueueAhead}
              benchmarkLoading={benchmarkLoading}
              liveSyncDurationCount={hlsLiveSyncCount}
              liveSyncDurationSec={hlsLiveSyncDurationSec}
              encodeLadder={encodeLadder}
              targetLatencyMs={targetLatencyMs}
              zixiStreamId={zixiStreamId}
              lowLatencyMode={hlsLowLatency}
              playbackPolicy={playbackPolicy}
              bridgeLagMs={bridgeLagMs}
              encoderLagMs={encoderLagMs}
              encodeDurationSec={encodeDurationSec}
              encodeElapsedSec={encodeElapsedSec}
              runStopped={runStopped}
              onUnrecoverableHls={
                resolvedMode === "hls" &&
                onPlaybackModeChange &&
                isPlaybackModeCompatible("mpegts", protocol, ingestEndpointId, endpointUrl) &&
                playbackModeAllowedInBrowser("mpegts", {
                  safari: isSafariBrowser(),
                  webTransport: typeof WebTransport !== "undefined",
                  rtcPeerConnection: typeof RTCPeerConnection !== "undefined",
                })
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
              playbackPolicy={playbackPolicy}
              encodeDurationSec={encodeDurationSec}
              encodeElapsedSec={encodeElapsedSec}
              runStopped={runStopped}
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
              deliveryMediaOriginSec={deliveryMediaOriginSec}
              onPlaybackSample={onPlaybackSample}
              bridgeLagMs={bridgeLagMs}
              encoderLagMs={encoderLagMs}
              // Skip only when the backend actually validated TS sync bytes.
              // RTMP/SRT get gate=live while preview_ready is still false, so
              // keying off the gate skipped the probe exactly when the origin
              // was most likely empty — mpegts.js then attached to 0 bytes and
              // burned 1.2s reconnects instead (a chunk of the 23s Linode
              // join). preview_ready === true means the probe is redundant.
              skipConnectProbe={previewReady === true}
              playbackPolicy={playbackPolicy}
              jobStatus={jobStatus}
              jobError={jobError}
              protocol={protocol}
              encodeFramesTotal={encodeFramesTotal}
              waitingForEncodeSlot={waitingForEncodeSlot}
              encodeQueueAhead={encodeQueueAhead}
              benchmarkLoading={benchmarkLoading}
              encodeDurationSec={encodeDurationSec}
              encodeElapsedSec={encodeElapsedSec}
              runStopped={runStopped}
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
              jobStatus={jobStatus}
              benchmarkLoading={benchmarkLoading}
              encodeDurationSec={encodeDurationSec}
              encodeElapsedSec={encodeElapsedSec}
              runStopped={runStopped}
            />
          )}
          {target.engine === "moq" && moqReadyNamespace && (
            <MoqPlayer
              key={`${target.url}:${moqReadyNamespace}:d${resolvedDraft}:${moqMediaPackaging}`}
              relayUrl={target.url}
              namespace={moqReadyNamespace}
              fingerprintUrl={pinTlsCert ? target.moqFingerprintUrl : undefined}
              label={target.label}
              playbackGate={moqPlaybackGate}
              pinTlsCert={pinTlsCert}
              jobId={jobId}
              encodeStartedAtEpoch={encodeStartedAtEpoch}
              onPlaybackSample={onPlaybackSample}
              jobStatus={jobStatus}
              jobError={jobError}
              waitingForEncodeSlot={waitingForEncodeSlot}
              encodeQueueAhead={encodeQueueAhead}
              previewReady={previewReady}
              benchmarkLoading={benchmarkLoading}
              encodeDurationSec={encodeDurationSec}
              encodeElapsedSec={encodeElapsedSec}
              runStopped={runStopped}
              targetLatencyMs={targetLatencyMs}
              sourceHasAudio={sourceHasAudio}
              sourceVideoCodec={moqVideoCodec}
              bridgeLagMs={bridgeLagMs}
              encoderLagMs={encoderLagMs}
              encodeLatencyMs={encodeLatencyMs}
              netRttMs={netRttMs}
              draftVersion={resolvedDraft}
              mediaPackaging={moqMediaPackaging}
              playbackPolicy={playbackPolicy}
            />
          )}
          {target.engine === "moq" && !moqReadyNamespace && (
            <div className="player-surface player-loading">
              <p className="hint">Waiting for MoQ publish namespace…</p>
            </div>
          )}
          {target.engine === "moq" ? (
            <p className="player-success-hint">Success is video on screen, not catalog loaded.</p>
          ) : null}
          {target.engine === "unsupported" && <UnsupportedPlayback target={target} />}
        </Suspense>
      </PlayerErrorBoundary>
      )}
    </div>
  );
}
