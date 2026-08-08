import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaybackMetricsSnapshot } from "../api";
import type { PlaybackGate } from "../playbackGate";
import { playbackGateLabel } from "../playbackGate";
import { bufferedAheadSec, RebufferTracker } from "../playbackBuffer";
import { clockSkewMs } from "../clockSkew";
import { usePlaybackMetricsReporter } from "../playbackMetrics";
import { proxiedPlaybackUrl } from "../playbackUrls";
import { PlayerDiagnostics } from "./PlayerDiagnostics";

interface MpegTsPlayerProps {
  url: string;
  label: string;
  playbackGate?: PlaybackGate;
  jobId?: string;
  encodeStartedAtEpoch?: number | null;
  onPlaybackSample?: (sample: PlaybackMetricsSnapshot & { elapsed_sec: number }) => void;
  /** Capture->bridge-output lag (ms) for live webcam runs; 0 for VOD. */
  bridgeLagMs?: number;
  /** This leg's encoder lag behind realtime (ms). */
  encoderLagMs?: number;
  /** Skip the pre-connect TS byte probe when preview_ready already validated HTTP-TS. */
  skipConnectProbe?: boolean;
  jobStatus?: string;
  benchmarkLoading?: boolean;
}

/** Max automatic reconnects after the Zixi HTTP-TS session ends on republish. */
const MAX_RECONNECTS = 8;
const RECONNECT_DELAY_MS = 1200;
/** Same threshold as HlsPlayer: rebase only when Zixi -output_ts_offset has
 *  pushed the MPEG-TS timeline into the minutes/hours. */
const OFFSET_REBASE_THRESHOLD_SEC = 120;

export default function MpegTsPlayer({
  url,
  label,
  playbackGate = "live",
  jobId,
  encodeStartedAtEpoch,
  onPlaybackSample,
  bridgeLagMs = 0,
  encoderLagMs = 0,
  skipConnectProbe = false,
  jobStatus,
  benchmarkLoading = false,
}: MpegTsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading MPEG-TS player...");
  const [diagLines, setDiagLines] = useState<string[]>([]);
  const lastErrorRef = useRef<string | null>(null);
  const sessionRef = useRef({
    maxVideoTime: 0,
    videoTimeOrigin: null as number | null,
    ttffMs: 0,
    liveStartedAtMs: 0,
    errorCount: 0,
  });
  const rebufferRef = useRef(new RebufferTracker());
  const lagRef = useRef({ bridgeMs: 0, encoderMs: 0, epoch: 0 });
  lagRef.current = {
    bridgeMs: bridgeLagMs,
    // Kept for API parity with HlsPlayer; HTTP-TS e2e is encode-anchored so
    // encode lag is already in wall−playhead and must not be double-added.
    encoderMs: encoderLagMs,
    epoch: encodeStartedAtEpoch ?? 0,
  };

  function sessionRelativeVideoTime(video: HTMLVideoElement): number {
    const session = sessionRef.current;
    const raw = video.currentTime;
    if (session.videoTimeOrigin == null) {
      if (raw > 0.05) {
        // Encode-anchored HTTP-TS: keep origin 0 unless the timeline is clearly
        // shifted by a managed Zixi -output_ts_offset (same rule as Fast HLS).
        session.videoTimeOrigin = raw > OFFSET_REBASE_THRESHOLD_SEC ? raw : 0;
      }
      return 0;
    }
    return Math.max(0, raw - session.videoTimeOrigin);
  }

  /**
   * Zixi HTTP-TS timelines are encode-anchored (same media clock as Fast HLS).
   * wall − position covers encoder→glass; add bridge only. encoderLag is already
   * reflected in how far out_time trails wall, so do not double-add it here.
   */
  function captureAnchoredE2eMs(): number | undefined {
    const { bridgeMs, epoch } = lagRef.current;
    const session = sessionRef.current;
    if (epoch > 0 && session.maxVideoTime > 0) {
      // Anchor epoch is server-clock; skew-correct Date.now() to match.
      const total =
        Date.now() + clockSkewMs() - epoch * 1000 - session.maxVideoTime * 1000 + bridgeMs;
      return total > 0 && total < 120_000 ? Math.round(total) : undefined;
    }
    return undefined;
  }

  const getPlaybackSnapshot = useCallback(
    (): PlaybackMetricsSnapshot => ({
      playback_stats_events: 0,
      playback_stall_count: 0,
      playback_frames_rendered: 0,
      playback_frames_dropped: 0,
      playback_bitrate_bps: 0,
      playback_ttff_ms: sessionRef.current.ttffMs,
      playback_hls_errors: sessionRef.current.errorCount,
      playback_hls_fatal_errors: 0,
      playback_hls_buffer_stalls: 0,
      playback_hls_frag_loads: 0,
      playback_video_time_sec: sessionRef.current.maxVideoTime,
      playback_buffer_sec: bufferedAheadSec(videoRef.current),
      playback_rebuffer_sec: rebufferRef.current.totalSec,
      e2e_latency_ms: captureAnchoredE2eMs(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  usePlaybackMetricsReporter({
    jobId,
    engine: "mpegts",
    enabled: playbackGate === "live",
    startedAtEpoch: encodeStartedAtEpoch,
    getSnapshot: getPlaybackSnapshot,
    onSample: onPlaybackSample,
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (playbackGate !== "live") {
      setError(null);
      setStatus(
        playbackGate === "waiting"
          ? "Waiting for live HTTP-TS…"
          : playbackGateLabel(playbackGate, "other"),
      );
      return;
    }

    let destroyed = false;
    let player: { destroy: () => void; unload?: () => void; detachMediaElement?: () => void } | null =
      null;
    let reconnectTimer: number | null = null;
    let reconnects = 0;
    let mpegtsMod: typeof import("mpegts.js") | null = null;
    let timeTimer: number | null = null;

    sessionRef.current = {
      maxVideoTime: 0,
      videoTimeOrigin: null,
      ttffMs: 0,
      liveStartedAtMs: Date.now(),
      errorCount: 0,
    };
    rebufferRef.current = new RebufferTracker();
    setDiagLines([]);
    lastErrorRef.current = null;

    function pushDiag(line: string) {
      if (!destroyed) {
        setDiagLines((current) => [...current.slice(-12), line]);
      }
    }
    pushDiag(`url=${url}`);

    const clearReconnect = () => {
      if (reconnectTimer != null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const destroyPlayer = () => {
      if (!player) {
        return;
      }
      try {
        player.unload?.();
        player.detachMediaElement?.();
        player.destroy();
      } catch {
        // ignore teardown races
      }
      player = null;
    };

    const scheduleReconnect = (reason: string) => {
      if (destroyed) {
        return;
      }
      pushDiag(`reconnect_reason=${reason}`);
      if (reconnects >= MAX_RECONNECTS) {
        const message = `MPEG-TS playback stopped (${reason}). Refresh or restart the publish.`;
        lastErrorRef.current = message;
        setError(message);
        setStatus("Stopped");
        return;
      }
      reconnects += 1;
      sessionRef.current.errorCount += 1;
      setError(null);
      setStatus(`Reconnecting (${reconnects}/${MAX_RECONNECTS})…`);
      clearReconnect();
      reconnectTimer = window.setTimeout(() => {
        void start();
      }, RECONNECT_DELAY_MS);
    };

    const onTimeUpdate = () => {
      if (destroyed || !video) {
        return;
      }
      const relative = sessionRelativeVideoTime(video);
      if (relative > 0.05) {
        sessionRef.current.maxVideoTime = Math.max(sessionRef.current.maxVideoTime, relative);
        if (sessionRef.current.ttffMs <= 0 && sessionRef.current.liveStartedAtMs > 0) {
          sessionRef.current.ttffMs = Math.max(
            1,
            Math.round(Date.now() - sessionRef.current.liveStartedAtMs),
          );
          pushDiag(
            `first_frame time=${relative.toFixed(2)} ttff=${sessionRef.current.ttffMs}ms size=${video.videoWidth}x${video.videoHeight}`,
          );
        }
      }
    };

    // RebufferTracker's API is beginWait/endWait — the old onWaiting/onPlaying
    // calls threw TypeErrors on every stall, so rebuffer time was never counted.
    const onWaiting = () => rebufferRef.current.beginWait(sessionRef.current.ttffMs > 0);
    const onPlaying = () => rebufferRef.current.endWait();
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    timeTimer = window.setInterval(onTimeUpdate, 500);

    async function start() {
      if (destroyed || !video) {
        return;
      }
      destroyPlayer();
      setError(null);
      setStatus(reconnects > 0 ? "Reconnecting…" : "Connecting…");
      try {
        mpegtsMod = mpegtsMod ?? (await import("mpegts.js"));
      } catch {
        const message = "Failed to load mpegts.js";
        lastErrorRef.current = message;
        pushDiag(`fatal=${message}`);
        setError(message);
        return;
      }
      if (destroyed) {
        return;
      }
      const mpegts = mpegtsMod.default;
      if (!mpegts.isSupported()) {
        const message = "MPEG-TS MSE playback is not supported in this browser.";
        lastErrorRef.current = message;
        pushDiag(`fatal=${message}`);
        setError(message);
        return;
      }

      // Probe first: Zixi's http_ts_auto_out returns HTTP 200 with
      // Content-Type video/mp2t even when the input is offline, then hangs
      // with 0 bytes. mpegts.js treats that as a live stream and burns out
      // with "error -1". Require real TS sync bytes before attaching.
      const proxied = proxiedPlaybackUrl(url);
      // Backend preview_ready already validated sync bytes — skip duplicate probe.
      if (skipConnectProbe) {
        pushDiag("connect_probe=skipped (preview_ready already confirmed)");
      } else {
        pushDiag(`connect_probe=start proxied=${proxied}`);
        const probe = await fetch(proxied, {
          cache: "no-store",
          signal: AbortSignal.timeout(4000),
        }).catch((err: unknown) => {
          pushDiag(`connect_probe_fetch_error=${err instanceof Error ? err.message : String(err)}`);
          return null;
        });
        if (destroyed) {
          return;
        }
        if (!probe || !probe.ok || !probe.body) {
          pushDiag(`connect_probe=fail http=${probe ? probe.status : "n/a"}`);
          scheduleReconnect(
            probe ? `HTTP ${probe.status}` : "manifest unreachable",
          );
          return;
        }
        const reader = probe.body.getReader();
        let bytes = 0;
        let sync = false;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && bytes < 188 * 8) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) {
            bytes += value.length;
            if (value[0] === 0x47) sync = true;
          }
        }
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        if (destroyed) {
          return;
        }
        pushDiag(`connect_probe=done http=${probe.status} bytes=${bytes} sync=${sync}`);
        if (bytes < 188 || !sync) {
          scheduleReconnect(
            bytes === 0
              ? "empty HTTP-TS (input offline?)"
              : `short HTTP-TS (${bytes}B)`,
          );
          return;
        }
      }

      const instance = mpegts.createPlayer(
        {
          // Raw MPEG-TS over HTTP (Zixi http_ts_auto_out), not fMP4/MSE.
          type: "mpegts",
          isLive: true,
          url: proxied,
        },
        {
          // The IO/network loader runs *inside* the worker when enabled, in a
          // separate realm with its own fetch(). That loader was throwing an
          // immediate NetworkError(-1) against our /api/playback/fetch proxy
          // even while a plain main-thread fetch() to the same URL succeeded —
          // main-thread network loading sidesteps whatever the worker realm
          // was tripping on (relative URL resolution against the worker's
          // blob: location, CSP, or an internal abort race).
          enableWorker: false,
          liveBufferLatencyChasing: true,
          enableStashBuffer: false,
          autoCleanupSourceBuffer: true,
        },
      );
      player = instance;
      instance.attachMediaElement(video);
      instance.load();
      pushDiag("mpegtsjs=attached load() called");
      void instance.play().catch((err: unknown) => {
        // autoplay may be blocked; controls remain
        pushDiag(`play_rejected=${err instanceof Error ? err.message : String(err)}`);
      });
      setStatus("Playing (HTTP-TS)");

      instance.on(mpegts.Events.MEDIA_INFO, (info: { videoCodec?: string; audioCodec?: string }) => {
        if (!destroyed) {
          pushDiag(`media_info video=${info?.videoCodec ?? "?"} audio=${info?.audioCodec ?? "?"}`);
        }
      });
      instance.on(mpegts.Events.ERROR, (type: string, detail: string, info: { code?: number }) => {
        if (destroyed) {
          return;
        }
        pushDiag(`mpegtsjs_error type=${type} detail=${detail} code=${info?.code ?? "n/a"}`);
        destroyPlayer();
        scheduleReconnect(info?.code != null ? `error ${info.code}` : "stream error");
      });
      instance.on(mpegts.Events.LOADING_COMPLETE, () => {
        if (destroyed) {
          return;
        }
        // Live HTTP-TS ends cleanly when the publisher disconnects — re-pull.
        pushDiag("loading_complete (publisher session ended)");
        destroyPlayer();
        scheduleReconnect("publisher session ended");
      });
    }

    void start();

    return () => {
      destroyed = true;
      clearReconnect();
      if (timeTimer != null) {
        window.clearInterval(timeTimer);
      }
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      destroyPlayer();
      video.removeAttribute("src");
      video.load();
    };
  }, [url, playbackGate]);

  const gateMessage =
    playbackGate !== "live" ? playbackGateLabel(playbackGate, "other") : null;

  return (
    <div className="player-surface">
      <video ref={videoRef} className="player-video" controls playsInline muted autoPlay />
      <div className="player-meta">
        <span>{label}</span>
        <span className="hint">{status}</span>
      </div>
      {gateMessage && <p className="hint player-note">{gateMessage}</p>}
      {error && <p className="player-error">{error}</p>}
      <PlayerDiagnostics
        engine="mpegts"
        playbackGate={playbackGate}
        jobStatus={jobStatus}
        benchmarkLoading={benchmarkLoading}
        status={status}
        error={error ?? lastErrorRef.current}
        lines={diagLines}
        manifestUrl={url}
      />
    </div>
  );
}
