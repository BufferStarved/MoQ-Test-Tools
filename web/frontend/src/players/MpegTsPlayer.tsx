import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaybackMetricsSnapshot } from "../api";
import type { PlaybackGate } from "../playbackGate";
import { playbackGateLabel, waitingPlayerStatus } from "../playbackGate";
import { bufferedAheadSec, RebufferTracker, seekNearLiveEdge } from "../playbackBuffer";
import { clockSkewMs } from "../clockSkew";
import { createPlaybackDiagReporter } from "../playbackDiag";
import { elapsedSecFromStart, usePlaybackMetricsReporter } from "../playbackMetrics";
import {
  attachHtmlPlaybackMonitors,
  loadJobRebuffer,
  persistJobRebuffer,
  readVideoFrameStats,
} from "../videoPlaybackMetrics";
import { proxiedPlaybackUrl } from "../playbackUrls";
import {
  EMPTY_STARTUP_PHASES,
  findStartupResourceTiming,
  latchStartupPhases,
  startupPhasesFromMilestones,
  type StartupPlayerPhases,
} from "../startupTiming";
import { isGracefulMpegTsEos } from "../playbackEos";
import { playerErrorForFailedJob } from "../moqCmafPlayback";
import {
  classifyMpegTsEndVerdict,
  mpegTsMayMarkPlaybackOk,
  mpegTsOriginHost,
  mpegTsPaintedOk,
  mpegTsProbeFailReason,
} from "../mpegTsPlayback";
import { PlayerDiagnostics } from "./PlayerDiagnostics";
import { GoLiveButton } from "../GoLiveButton";
import { formatGoLiveDiag, goLiveHoldSec, latchGoLive, seekGoLive } from "../goLive";
import { encodeAnchoredE2eMs, holdE2eWhilePlayheadFrozen } from "../glassLatency";

interface MpegTsPlayerProps {
  url: string;
  label: string;
  playbackGate?: PlaybackGate;
  jobId?: string;
  encodeStartedAtEpoch?: number | null;
  /** Zixi: encode-media seconds at HTTP-TS / HLS buffer time 0. */
  deliveryMediaOriginSec?: number | null;
  onPlaybackSample?: (sample: PlaybackMetricsSnapshot & { elapsed_sec: number }) => void;
  /** Capture->bridge-output lag (ms) for live webcam runs; 0 for VOD. */
  bridgeLagMs?: number;
  /** This leg's encoder lag behind realtime (ms). */
  playbackPolicy?: "live-edge" | "complete";
  encoderLagMs?: number;
  /** Skip the pre-connect TS byte probe when preview_ready already validated HTTP-TS. */
  skipConnectProbe?: boolean;
  jobStatus?: string;
  jobError?: string | null;
  protocol?: string | null;
  waitingForEncodeSlot?: boolean;
  encodeQueueAhead?: number;
  benchmarkLoading?: boolean;
  encodeDurationSec?: number;
  encodeElapsedSec?: number;
  runStopped?: boolean;
}

/** Max automatic reconnects after the Zixi HTTP-TS session ends on republish. */
const MAX_RECONNECTS = 8;
const RECONNECT_DELAY_MS = 1200;
/** Same threshold as HlsPlayer: rebase only when Zixi -output_ts_offset has
 *  pushed the MPEG-TS timeline into the minutes/hours. */
const OFFSET_REBASE_THRESHOLD_SEC = 120;
/** Play from the live edge of the HTTP-TS stash, not from t=0 of a 8–10s buffer. */
const MPEGTS_HOLD_BEHIND_SEC = 0.6;
const MPEGTS_SEEK_AHEAD_SEC = 2.2;
const MPEGTS_LIVE_EDGE_MS = 1000;

export default function MpegTsPlayer({
  url,
  label,
  playbackGate = "live",
  jobId,
  encodeStartedAtEpoch,
  deliveryMediaOriginSec = null,
  onPlaybackSample,
  bridgeLagMs = 0,
  encoderLagMs = 0,
  skipConnectProbe = false,
  jobStatus,
  jobError = null,
  protocol = null,
  waitingForEncodeSlot = false,
  encodeQueueAhead = 0,
  benchmarkLoading = false,
  encodeDurationSec = 30,
  encodeElapsedSec,
  runStopped = false,
  playbackPolicy = "live-edge",
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
    firstPaintAtMs: 0,
  });
  const rebufferRef = useRef(new RebufferTracker());
  const goLiveRef = useRef({ atSec: 0, e2eMs: 0 });
  const lastE2eRef = useRef<{ videoTimeSec: number; e2eMs: number } | undefined>(undefined);
  const startupPhasesRef = useRef<StartupPlayerPhases>({ ...EMPTY_STARTUP_PHASES });
  const lagRef = useRef({
    bridgeMs: 0,
    encoderMs: 0,
    epoch: 0,
    deliveryOriginSec: null as number | null,
  });
  lagRef.current = {
    bridgeMs: bridgeLagMs,
    // Kept for API parity with HlsPlayer; HTTP-TS e2e is encode-anchored so
    // encode lag is already in wall−playhead and must not be double-added.
    encoderMs: encoderLagMs,
    epoch: encodeStartedAtEpoch ?? 0,
    deliveryOriginSec: deliveryMediaOriginSec,
  };
  const jobStatusRef = useRef(jobStatus);
  jobStatusRef.current = jobStatus;
  const loadingRef = useRef(benchmarkLoading);
  loadingRef.current = benchmarkLoading;
  const encodeDurationRef = useRef(encodeDurationSec);
  encodeDurationRef.current = encodeDurationSec;
  const encodeElapsedRef = useRef(encodeElapsedSec ?? 0);
  encodeElapsedRef.current = encodeElapsedSec ?? 0;
  const runStoppedRef = useRef(runStopped);
  runStoppedRef.current = runStopped;

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
   * Capture→glass of the painted frame. Session-relative currentTime (0 at
   * join) made wall−epoch−videoTime the attach offset — a flat ~9s with
   * only ~0.5s HTML buffer (comparison 2026-08-23). Rebase from delivery
   * origin / live edge after first paint; do not invent a confident glass
   * number when nothing encode-anchors the playhead.
   */
  function captureAnchoredE2eMs(): number | undefined {
    const { bridgeMs, epoch, deliveryOriginSec } = lagRef.current;
    const video = videoRef.current;
    const raw = video?.currentTime ?? 0;
    const range = video?.buffered;
    const bufferedEnd =
      range && range.length > 0 ? range.end(range.length - 1) : raw;
    const computed = encodeAnchoredE2eMs({
      epochSec: epoch,
      rawVideoTimeSec: raw,
      clockSkewMs: clockSkewMs(),
      bridgeMs,
      deliveryOriginSec,
      bufferedEndSec: bufferedEnd,
    });
    const held = holdE2eWhilePlayheadFrozen(computed, raw, lastE2eRef.current);
    lastE2eRef.current = held.last;
    return held.e2eMs;
  }

  /**
   * Player-chain startup phases (see src/startup_budget.py).
   *
   * **There is no manifest phase here, and it is not zero.** A raw MPEG-TS pull
   * has nothing to fetch before the media: the first response *is* the stream.
   * Reporting `startup_manifest_ms` as 0 would claim an instant manifest fetch
   * on an engine that never performs one, so the phase is omitted and the time
   * between the request going out and the first TS byte is attributed to
   * `first_media`, where it actually happened
   * (startup_budget.PLAYER_PHASE_NOTES["mpegts"] declares the same).
   *
   * `first_media` closes at Resource Timing's `responseStart` — the only
   * milestone a never-ending response has, since a live TS pull's `responseEnd`
   * stays 0 for the whole run.
   */
  function startupPhases(): StartupPlayerPhases {
    const session = sessionRef.current;
    const stream = findStartupResourceTiming(url);
    startupPhasesRef.current = latchStartupPhases(
      startupPhasesRef.current,
      startupPhasesFromMilestones({
        attachAtMs: session.liveStartedAtMs,
        requestSentAtMs: stream.requestSentAtMs,
        manifestApplicable: false,
        firstMediaAtMs: stream.responseStartAtMs,
        firstPaintAtMs: session.firstPaintAtMs,
      }),
    );
    return startupPhasesRef.current;
  }

  const getPlaybackSnapshot = useCallback(
    (): PlaybackMetricsSnapshot => {
      const frames = readVideoFrameStats(videoRef.current);
      persistJobRebuffer(jobId, rebufferRef.current);
      return {
        playback_stats_events: frames.framesRendered > 0 ? 1 : 0,
        playback_stall_count: rebufferRef.current.stallCount,
        playback_frames_rendered: frames.framesRendered,
        playback_frames_dropped: frames.framesDropped,
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
        go_live_at_sec: goLiveRef.current.atSec,
        go_live_e2e_ms: goLiveRef.current.e2eMs,
        ...startupPhases(),
      };
    },
    [jobId],
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
      const jobFail = playerErrorForFailedJob({ jobStatus, jobError, protocol });
      if (jobFail) {
        setError(jobFail);
        setStatus("Failed (see diagnostics)");
        return;
      }
      if (playbackGate === "ended") {
        const frames = readVideoFrameStats(video);
        const verdict = classifyMpegTsEndVerdict({
          paintedOk: mpegTsPaintedOk({
            ttffMs: sessionRef.current.ttffMs,
            framesRendered: frames.framesRendered,
            videoWidth: video.videoWidth ?? 0,
          }),
          lastReason: lastErrorRef.current,
          videoTimeSec: sessionRef.current.maxVideoTime,
          encodeDurationSec: encodeDurationRef.current,
          encodeElapsedSec: encodeElapsedRef.current,
          runStopped: runStoppedRef.current,
        });
        if (verdict.ok) {
          setError(null);
          lastErrorRef.current = null;
          setStatus(verdict.status);
        } else {
          lastErrorRef.current = verdict.error;
          setError(verdict.error);
          setStatus(verdict.status);
        }
        return;
      }
      setError(null);
      setStatus(
        playbackGate === "waiting"
          ? waitingPlayerStatus({
              engine: "other",
              jobStatus,
              waitingForEncodeSlot,
              encodeQueueAhead,
            })
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
    let liveEdgeTimer: number | null = null;

    sessionRef.current = {
      maxVideoTime: 0,
      videoTimeOrigin: null,
      ttffMs: 0,
      liveStartedAtMs: Date.now(),
      errorCount: 0,
      firstPaintAtMs: 0,
    };
    lastE2eRef.current = undefined;
    startupPhasesRef.current = { ...EMPTY_STARTUP_PHASES };
    rebufferRef.current = new RebufferTracker();
    loadJobRebuffer(jobId, rebufferRef.current);
    let detachHtmlMonitors: (() => void) | undefined;
    setDiagLines([]);
    lastErrorRef.current = null;

    const diagReporter = createPlaybackDiagReporter(jobId, "mpegts");

    function pushDiag(line: string) {
      if (!destroyed) {
        setDiagLines((current) => [...current.slice(-12), line]);
        diagReporter.push(line);
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

    const mpegTsEosOptions = (playedOk: boolean) => ({
      playedOk,
      jobStatus: jobStatusRef.current,
      benchmarkLoading: loadingRef.current,
      videoTimeSec: sessionRef.current.maxVideoTime,
      encodeDurationSec: encodeDurationRef.current,
    });

    const paintedOk = () => {
      const frames = readVideoFrameStats(video);
      return mpegTsPaintedOk({
        ttffMs: sessionRef.current.ttffMs,
        framesRendered: frames.framesRendered,
        videoWidth: video?.videoWidth ?? 0,
      });
    };

    const failPlayback = (reason: string) => {
      const message = `MPEG-TS playback stopped (${reason}). Refresh or restart the publish.`;
      lastErrorRef.current = message;
      setError(message);
      setStatus("Failed");
      pushDiag(`fatal=${reason}`);
    };

    const markPlaybackOk = (diag: string, lastReason?: string) => {
      const verdict = classifyMpegTsEndVerdict({
        paintedOk: paintedOk(),
        lastReason,
        videoTimeSec: sessionRef.current.maxVideoTime,
        encodeDurationSec: encodeDurationRef.current,
        encodeElapsedSec: encodeElapsedRef.current,
        runStopped: runStoppedRef.current,
      });
      if (!verdict.ok) {
        failPlayback(verdict.error || lastReason || diag);
        return;
      }
      lastErrorRef.current = null;
      setError(null);
      setStatus("Playback OK");
      pushDiag(diag);
    };

    const scheduleReconnect = (reason: string) => {
      if (destroyed) {
        return;
      }
      const playedOk = paintedOk();
      if (
        mpegTsMayMarkPlaybackOk({ paintedOk: playedOk, lastReason: reason }) &&
        isGracefulMpegTsEos(mpegTsEosOptions(playedOk))
      ) {
        destroyPlayer();
        markPlaybackOk(`graceful_eos ${reason}`, reason);
        return;
      }
      pushDiag(`reconnect_reason=${reason}`);
      if (reconnects >= MAX_RECONNECTS) {
        if (mpegTsMayMarkPlaybackOk({ paintedOk: playedOk, lastReason: reason })) {
          markPlaybackOk(`graceful_eos after ${reconnects} reconnects (${reason})`, reason);
          return;
        }
        failPlayback(reason);
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
          sessionRef.current.firstPaintAtMs = Date.now();
          sessionRef.current.ttffMs = Math.max(
            1,
            Math.round(sessionRef.current.firstPaintAtMs - sessionRef.current.liveStartedAtMs),
          );
          pushDiag(
            `first_frame time=${relative.toFixed(2)} ttff=${sessionRef.current.ttffMs}ms size=${video.videoWidth}x${video.videoHeight}`,
          );
        }
      }
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    detachHtmlMonitors = attachHtmlPlaybackMonitors(video, {
      rebuffer: rebufferRef.current,
      hasPlayedOnce: () => sessionRef.current.ttffMs > 0,
      onStallBegin: () => {
        pushDiag(`html_stall count=${rebufferRef.current.stallCount}`);
        persistJobRebuffer(jobId, rebufferRef.current);
      },
    });
    timeTimer = window.setInterval(onTimeUpdate, 500);

    async function start() {
      if (destroyed || !video) {
        return;
      }
      destroyPlayer();
      if (reconnects === 0) {
        sessionRef.current.maxVideoTime = 0;
        sessionRef.current.ttffMs = 0;
        sessionRef.current.firstPaintAtMs = 0;
        sessionRef.current.videoTimeOrigin = null;
      }
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
        let probeError = "";
        const probe = await fetch(proxied, {
          cache: "no-store",
          signal: AbortSignal.timeout(4000),
        }).catch((err: unknown) => {
          probeError = err instanceof Error ? err.message : String(err);
          pushDiag(`connect_probe_fetch_error=${probeError}`);
          return null;
        });
        if (destroyed) {
          return;
        }
        if (!probe || !probe.ok || !probe.body) {
          const reason = mpegTsProbeFailReason({
            httpStatus: probe ? probe.status : null,
            fetchError: probeError,
            originHost: mpegTsOriginHost(url),
          });
          pushDiag(`connect_probe=fail http=${probe ? probe.status : "n/a"} reason=${reason}`);
          scheduleReconnect(reason);
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
          liveBufferLatencyChasing: playbackPolicy !== "complete",
          // 3.5s chase plus stash-from-the-start left RTMP HTTP-TS sitting
          // ~10s behind encode (comparison 2026-08-23: vt=0.58 at t=8).
          // 1.5s still covers WAN jitter; the interval seek below trims more.
          liveBufferLatencyMaxLatency: 1.5,
          liveBufferLatencyMinRemain: 0.5,
          enableStashBuffer: true,
          autoCleanupSourceBuffer: true,
        },
      );
      player = instance;
      instance.attachMediaElement(video);
      instance.load();
      pushDiag("mpegtsjs=attached load() called");
      // mpegts.js types play() as `void | Promise<void>` and returns whatever
      // the media element gave it — calling .catch() on a void return throws a
      // TypeError that would abort start() right after load().
      const playback = instance.play();
      if (playback) {
        void playback.catch((err: unknown) => {
          // autoplay may be blocked; controls remain
          pushDiag(`play_rejected=${err instanceof Error ? err.message : String(err)}`);
        });
      }
      setStatus("Playing (HTTP-TS)");
      liveEdgeTimer = window.setInterval(() => {
        if (destroyed) {
          return;
        }
        const media = videoRef.current;
        if (!media || media.readyState < 2) {
          return;
        }
        if (
          playbackPolicy !== "complete" &&
          seekNearLiveEdge(media, MPEGTS_HOLD_BEHIND_SEC, MPEGTS_SEEK_AHEAD_SEC)
        ) {
          pushDiag(`mpegts_live_seek ahead=${bufferedAheadSec(media).toFixed(2)}s`);
        }
      }, MPEGTS_LIVE_EDGE_MS);

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
        const playedOk = paintedOk();
        if (isGracefulMpegTsEos(mpegTsEosOptions(playedOk))) {
          destroyPlayer();
          markPlaybackOk("graceful_eos mpegts_error after successful playback", detail);
          return;
        }
        destroyPlayer();
        scheduleReconnect(info?.code != null ? `error ${info.code}` : "stream error");
      });
      instance.on(mpegts.Events.LOADING_COMPLETE, () => {
        if (destroyed) {
          return;
        }
        const playedOk = paintedOk();
        if (isGracefulMpegTsEos(mpegTsEosOptions(playedOk))) {
          destroyPlayer();
          markPlaybackOk("loading_complete (encode ended)", "loading_complete");
          return;
        }
        pushDiag("loading_complete (publisher session ended)");
        destroyPlayer();
        scheduleReconnect("publisher session ended");
      });
    }

    void start();

    return () => {
      destroyed = true;
      persistJobRebuffer(jobId, rebufferRef.current);
      detachHtmlMonitors?.();
      diagReporter.stop();
      clearReconnect();
      if (timeTimer != null) {
        window.clearInterval(timeTimer);
      }
      if (liveEdgeTimer != null) {
        window.clearInterval(liveEdgeTimer);
      }
      video.removeEventListener("timeupdate", onTimeUpdate);
      destroyPlayer();
      video.removeAttribute("src");
      video.load();
    };
  }, [
    url,
    playbackGate,
    jobId,
    jobStatus,
    jobError,
    protocol,
    waitingForEncodeSlot,
    encodeQueueAhead,
  ]);

  return (
    <div className="player-surface">
      <video ref={videoRef} className="player-video" controls playsInline muted autoPlay />
      <div className="player-meta">
        <span>{label}</span>
        <span className="hint">{status}</span>
        <GoLiveButton
          visible
          disabled={playbackGate !== "live"}
          onGoLive={() => {
            const e2e = captureAnchoredE2eMs();
            const elapsed = elapsedSecFromStart(encodeStartedAtEpoch);
            goLiveRef.current = latchGoLive(goLiveRef.current, elapsed, e2e);
            const result = seekGoLive(videoRef.current, goLiveHoldSec("mpegts"));
            setDiagLines((current) => [...current.slice(-12), formatGoLiveDiag(result, elapsed, e2e)]);
          }}
        />
      </div>
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
