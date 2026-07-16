import { Suspense, lazy, useMemo } from "react";
import type { PlaybackMetricsSnapshot } from "./api";
import { resolvePlaybackTarget } from "./playbackUrls";
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
}: StreamPlayerProps) {
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

  return (
    <div className="stream-player-card">
      <div className="stream-player-header">
        <h4>{title}</h4>
        <span className="pill">{target.label}</span>
      </div>
      {target.note && <p className="hint player-note">{target.note}</p>}
      {target.url && target.engine !== "webrtc-embed" && target.engine !== "moq" && (
        <p className="hint player-url">
          <code>{target.url}</code>
        </p>
      )}
      {target.engine === "moq" && (
        <p className="hint player-url">
          <code>
            {target.url} (namespace: {target.moqNamespace})
          </code>
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
        {target.engine === "dash" && <DashPlayer key={target.url} url={target.url} label={target.label} />}
        {target.engine === "mpegts" && <MpegTsPlayer key={target.url} url={target.url} label={target.label} />}
        {target.engine === "whep" && <WhepPlayer key={target.url} url={target.url} label={target.label} />}
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
    </div>
  );
}
