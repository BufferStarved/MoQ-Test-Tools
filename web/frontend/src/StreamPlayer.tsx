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
  playbackGate?: PlaybackGate;
  jobId?: string;
  encodeStartedAtEpoch?: number | null;
  onPlaybackSample?: (sample: PlaybackMetricsSnapshot & { elapsed_sec: number }) => void;
  jobStatus?: string;
  benchmarkLoading?: boolean;
  encodeDurationSec?: number;
  controlsLocked?: boolean;
  onPlaybackModeChange?: (mode: PlaybackMode) => void;
  onWhepPlaybackUrlChange?: (url: string) => void;
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
  playbackGate = "idle",
  jobId,
  encodeStartedAtEpoch,
  onPlaybackSample,
  jobStatus,
  benchmarkLoading = false,
  encodeDurationSec = 30,
  controlsLocked = false,
  onPlaybackModeChange,
  onWhepPlaybackUrlChange,
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

  return (
    <div className="stream-player-card">
      <div className="stream-player-header">
        <h4>{title}</h4>
        <span className="pill">{target.label}</span>
      </div>
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
              key={target.url}
              url={target.url}
              label={target.label}
              playbackGate={playbackGate}
              jobId={jobId}
              encodeStartedAtEpoch={encodeStartedAtEpoch}
              onPlaybackSample={onPlaybackSample}
              jobStatus={jobStatus}
              benchmarkLoading={benchmarkLoading}
            />
          )}
          {target.engine === "dash" && (
            <DashPlayer key={target.url} url={target.url} label={target.label} />
          )}
          {target.engine === "mpegts" && (
            <MpegTsPlayer key={target.url} url={target.url} label={target.label} />
          )}
          {target.engine === "whep" && (
            <WhepPlayer key={target.url} url={target.url} label={target.label} />
          )}
          {target.engine === "moq" && (
            <MoqPlayer
              key={`${target.url}:${target.moqNamespace}`}
              relayUrl={target.url}
              namespace={target.moqNamespace ?? "benchmark"}
              fingerprintUrl={target.moqFingerprintUrl}
              label={target.label}
              playbackGate={playbackGate}
              pinTlsCert
              jobId={jobId}
              encodeStartedAtEpoch={encodeStartedAtEpoch}
              onPlaybackSample={onPlaybackSample}
              jobStatus={jobStatus}
              benchmarkLoading={benchmarkLoading}
              encodeDurationSec={encodeDurationSec}
            />
          )}
          {target.engine === "webrtc-embed" && target.embedUrl && (
            <ZixiWebRtcEmbed embedUrl={target.embedUrl} label={target.label} />
          )}
          {target.engine === "unsupported" && <UnsupportedPlayback target={target} />}
        </Suspense>
      </PlayerErrorBoundary>

      {onPlaybackModeChange && (
        <div className="player-playback-controls">
          <label>
            Playback player
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
            <span className="hint">{modeHint}</span>
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
    </div>
  );
}
