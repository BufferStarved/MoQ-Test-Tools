/**
 * Replay a headed comparison from its last CSV row + HUD lines through the
 * same classifiers the tiles use. Isolated unit tests of noMediaFailMessage
 * missed comparison 30 because they assumed subscribeRejected was already
 * set — playa only warned 0x10, and the player never flipped the flag.
 */

import { uniqueDownloadStreams } from "./downloadStreams.ts";
import {
  humanizeJobError,
  isSubscribeRejectedLog,
  noMediaFailMessage,
  shouldFailNoMediaWatchdog,
  MOQ_CATALOG_REFRESH_WAIT_MS,
} from "./moqCmafPlayback.ts";
import { classifyHlsEndVerdict } from "./hlsPlayback.ts";
import { mpegTsMayMarkPlaybackOk, mpegTsPaintedOk } from "./mpegTsPlayback.ts";
import { classifyWhepEndVerdict } from "./webrtcPlayback.ts";

export type ComparisonLastRow = {
  stream: string;
  protocol: string;
  endpoint: string;
  encode_frames_total: number;
  playback_frames_rendered: number;
  playback_video_time_sec: number;
  playback_ttff_ms: number;
  moqx_publish_namespace_success: number;
};

export type ComparisonHud = {
  playaLines?: string[];
  jobStatus?: string;
  jobError?: string | null;
  previewReady?: boolean;
  catalogReady?: boolean;
  namespace?: string;
  mpegTsLastReason?: string | null;
  encodeDurationSec?: number;
  encodeElapsedSec?: number;
};

export type VisibleLeg = {
  stream: string;
  protocol: string;
  error: string | null;
  status: string;
};

export function uniquePublishSeriesCount(rows: ComparisonLastRow[]): number {
  return uniqueDownloadStreams(
    rows.map((row) => ({
      label: row.stream,
      filename: `${row.stream}.csv`,
      protocol: row.protocol,
      endpoint: row.endpoint,
      paint: row.playback_frames_rendered,
    })),
  ).length;
}

export function visibleMoqError(row: ComparisonLastRow, hud: ComparisonHud = {}): string {
  const subscribeRejected = (hud.playaLines || []).some((line) => isSubscribeRejectedLog(line));
  const announced = row.moqx_publish_namespace_success >= 1;
  const painted = row.playback_frames_rendered > 0;
  // Comparison 31: playa SUBSCRIBE 0x10 + 10s watchdog, then last-row
  // ns=1 (relay announce) with 0 paint. That is not "never announced"
  // and not a one-shot catalog miss.
  if (announced && !painted && subscribeRejected) {
    const ns = (hud.namespace || "").trim();
    return ns
      ? `MoQ announced namespace ${ns} after SUBSCRIBE 0x10 — the catalog watchdog expired before the relay had it. This is not a one-shot catalog miss.`
      : "MoQ announced the namespace after SUBSCRIBE 0x10 — the catalog watchdog expired before the relay had it. This is not a one-shot catalog miss.";
  }
  return noMediaFailMessage({
    catalogReady: hud.catalogReady ?? false,
    namespace: hud.namespace,
    jobStatus: hud.jobStatus,
    jobError: hud.jobError,
    previewReady: hud.previewReady ?? (announced && !subscribeRejected),
    subscribeRejected: subscribeRejected && !announced,
  });
}

export function visibleLeg(row: ComparisonLastRow, hud: ComparisonHud = {}): VisibleLeg {
  const protocol = (row.protocol || "").toLowerCase();
  if (protocol === "moq") {
    const error = visibleMoqError(row, hud);
    return { stream: row.stream, protocol, error, status: "Failed" };
  }
  if (protocol === "rtmp" || protocol === "srt" || protocol === "webrtc") {
    if (hud.jobError) {
      return {
        stream: row.stream,
        protocol,
        error: humanizeJobError(hud.jobError, { protocol }),
        status: "Failed",
      };
    }
  }
  if (protocol === "webrtc") {
    const verdict = classifyWhepEndVerdict({
      framesRendered: row.playback_frames_rendered,
      videoTimeSec: row.playback_video_time_sec,
      encodeDurationSec: hud.encodeDurationSec,
      encodeElapsedSec: hud.encodeElapsedSec,
    });
    return {
      stream: row.stream,
      protocol,
      error: verdict.error,
      status: verdict.status,
    };
  }
  if (protocol === "srt" || protocol === "rtmp") {
    if (hud.mpegTsLastReason != null) {
      const painted = mpegTsPaintedOk({
        ttffMs: row.playback_ttff_ms,
        framesRendered: row.playback_frames_rendered,
      });
      const ok = mpegTsMayMarkPlaybackOk({
        paintedOk: painted,
        lastReason: hud.mpegTsLastReason,
      });
      return {
        stream: row.stream,
        protocol,
        error: ok ? null : hud.mpegTsLastReason || "MPEG-TS never painted",
        status: ok ? "Playback OK" : "Failed",
      };
    }
    const verdict = classifyHlsEndVerdict({
      maxVideoTime: row.playback_video_time_sec,
      encodeDurationSec: hud.encodeDurationSec,
      encodeElapsedSec: hud.encodeElapsedSec,
    });
    return {
      stream: row.stream,
      protocol,
      error: verdict.error,
      status: verdict.status,
    };
  }
  return { stream: row.stream, protocol, error: null, status: "unknown" };
}

export function moqWatchdogFailsWhileEncodeRunning(
  _row: ComparisonLastRow,
  hud: ComparisonHud = {},
): boolean {
  const subscribeRejected = (hud.playaLines || []).some((line) => isSubscribeRejectedLog(line));
  return shouldFailNoMediaWatchdog({
    jobStatus: hud.jobStatus || "running",
    previewReady: hud.previewReady,
    catalogReady: hud.catalogReady ?? false,
    subscribeRejected,
    liveMs: MOQ_CATALOG_REFRESH_WAIT_MS + 1,
    deadlineMs: 15_000,
  });
}

export function moqxNeverAnnounced(row: ComparisonLastRow): boolean {
  return (row.protocol || "").toLowerCase() === "moq" && row.moqx_publish_namespace_success < 1;
}
