/**
 * Replay a headed comparison from its last CSV row + HUD lines through the
 * same classifiers the tiles use. Isolated unit tests of noMediaFailMessage
 * missed comparison 30 because they assumed subscribeRejected was already
 * set — playa only warned 0x10, and the player never flipped the flag.
 */

import { uniqueDownloadStreams } from "./downloadStreams.ts";
import {
  classifyMoqEndVerdict,
  isSubscribeRejectedLog,
  noMediaFailMessage,
  playerErrorForFailedJob,
  shouldFailNoMediaWatchdog,
  MOQ_CATALOG_REFRESH_WAIT_MS,
} from "./moqCmafPlayback.ts";
import { locPaintedOk } from "./moqLocPlayback.ts";
import { classifyHlsEndVerdict } from "./hlsPlayback.ts";
import { classifyMpegTsEndVerdict, mpegTsPaintedOk } from "./mpegTsPlayback.ts";
import { classifyWhepEndVerdict } from "./webrtcPlayback.ts";

export type ComparisonLastRow = {
  stream: string;
  protocol: string;
  endpoint: string;
  encode_frames_total: number;
  playback_frames_rendered: number;
  playback_video_time_sec: number;
  playback_ttff_ms: number;
  playback_bitrate_bps?: number;
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
  hlsLastError?: string | null;
  encodeDurationSec?: number;
  encodeElapsedSec?: number;
  runStopped?: boolean;
  benchmarkLoading?: boolean;
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

/** Catalog-ready from HUD, or from playa lines when the HUD omitted the flag. */
export function inferCatalogReady(hud: ComparisonHud = {}): boolean {
  if (hud.catalogReady === true) {
    return true;
  }
  return (hud.playaLines || []).some(
    (line) => /catalog received/i.test(line) || /ready levels=\d+/i.test(line),
  );
}

export function moqRowPainted(row: ComparisonLastRow, hud: ComparisonHud = {}): boolean {
  return locPaintedOk({
    framesRendered: row.playback_frames_rendered,
    bitrateBps: row.playback_bitrate_bps ?? 0,
    subscribeRejected: (hud.playaLines || []).some((line) => isSubscribeRejectedLog(line)),
  });
}

export type ComparisonTone = "ok" | "warn" | "bad" | "idle";

/** Tile / summary tone. preview_ready and job=completed are not paint. */
export function comparisonLegTone(input: {
  protocol?: string;
  jobStatus?: string;
  previewReady?: boolean;
  framesRendered?: number;
  bitrateBps?: number;
  subscribeRejected?: boolean;
  running?: boolean;
}): ComparisonTone {
  const protocol = (input.protocol || "").toLowerCase();
  const status = (input.jobStatus || "").toLowerCase();
  if (!status) {
    return input.running ? "warn" : "idle";
  }
  if (status === "failed") {
    return "bad";
  }
  if (status === "queued" || status === "pending") {
    return "warn";
  }
  if (protocol === "moq") {
    const painted = locPaintedOk({
      framesRendered: input.framesRendered,
      bitrateBps: input.bitrateBps,
      subscribeRejected: input.subscribeRejected,
    });
    if (status === "completed") {
      return painted ? "ok" : "bad";
    }
    if (status === "running") {
      return painted ? "ok" : "warn";
    }
    return "idle";
  }
  const painted = (input.framesRendered ?? 0) > 0;
  if (status === "completed") {
    // East/Linode HTTP-TS can job=completed after a mid-clip stall or
    // empty-reply with 0 paint. preview_ready / encode-only is not glass.
    if (protocol === "srt" || protocol === "rtmp" || protocol === "webrtc") {
      return painted ? "ok" : "bad";
    }
    return "ok";
  }
  if (status === "running") {
    if (protocol === "srt" || protocol === "rtmp" || protocol === "webrtc") {
      if (input.previewReady === false) {
        return "warn";
      }
      return painted ? "ok" : "warn";
    }
    return input.previewReady === false ? "warn" : "ok";
  }
  return "idle";
}

export function comparisonLegStatusLabel(input: {
  protocol?: string;
  jobStatus?: string;
  previewReady?: boolean;
  framesRendered?: number;
  bitrateBps?: number;
  subscribeRejected?: boolean;
}): string {
  const protocol = (input.protocol || "").toLowerCase();
  const status = (input.jobStatus || "").toLowerCase();
  if (protocol === "moq") {
    const painted = locPaintedOk({
      framesRendered: input.framesRendered,
      bitrateBps: input.bitrateBps,
      subscribeRejected: input.subscribeRejected,
    });
    if ((status === "completed" || status === "failed") && !painted) {
      return "Failed";
    }
    if (status === "running" && !painted) {
      return input.previewReady === false ? "buffering" : "no paint";
    }
  }
  if (
    (protocol === "srt" || protocol === "rtmp" || protocol === "webrtc") &&
    (status === "completed" || status === "failed") &&
    (input.framesRendered ?? 0) <= 0
  ) {
    return "Failed";
  }
  if (status === "queued") {
    return "queued";
  }
  if (status === "running" && input.previewReady === false) {
    return "buffering";
  }
  return input.jobStatus || "";
}

export function visibleMoqError(row: ComparisonLastRow, hud: ComparisonHud = {}): string {
  const subscribeRejected = (hud.playaLines || []).some((line) => isSubscribeRejectedLog(line));
  const announced = row.moqx_publish_namespace_success >= 1;
  const painted = moqRowPainted(row, hud);
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
    catalogReady: inferCatalogReady(hud),
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
    const subscribeRejected = (hud.playaLines || []).some((line) => isSubscribeRejectedLog(line));
    const painted = moqRowPainted(row, hud);
    if (!painted) {
      return {
        stream: row.stream,
        protocol,
        error: visibleMoqError(row, hud),
        status: "Failed",
      };
    }
    const verdict = classifyMoqEndVerdict({
      firstFrame: true,
      framesRendered: row.playback_frames_rendered,
      videoTimeSec: row.playback_video_time_sec,
      catalogReady: inferCatalogReady(hud),
      encodeDurationSec: hud.encodeDurationSec,
      encodeElapsedSec: hud.encodeElapsedSec,
      jobStatus: hud.jobStatus,
      jobError: hud.jobError,
      previewReady: hud.previewReady,
      subscribeRejected,
      bitrateBps: row.playback_bitrate_bps,
      runStopped: hud.runStopped,
      benchmarkLoading: hud.benchmarkLoading,
    });
    return {
      stream: row.stream,
      protocol,
      error: verdict.error,
      status: verdict.ok ? verdict.status : "Failed",
    };
  }
  if (protocol === "rtmp" || protocol === "srt" || protocol === "webrtc") {
    const jobFail = playerErrorForFailedJob({
      jobStatus: hud.jobStatus,
      jobError: hud.jobError,
      protocol,
    });
    if (jobFail) {
      return {
        stream: row.stream,
        protocol,
        error: jobFail,
        status: "Failed",
      };
    }
    if ((hud.jobStatus || "").toLowerCase() === "failed") {
      return {
        stream: row.stream,
        protocol,
        error: "Publish job failed. Encode-only is not playback.",
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
      runStopped: hud.runStopped,
      jobStatus: hud.jobStatus,
      benchmarkLoading: hud.benchmarkLoading,
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
      const verdict = classifyMpegTsEndVerdict({
        paintedOk: painted,
        lastReason: hud.mpegTsLastReason,
        videoTimeSec: row.playback_video_time_sec,
        encodeDurationSec: hud.encodeDurationSec,
        encodeElapsedSec: hud.encodeElapsedSec,
        runStopped: hud.runStopped,
        jobStatus: hud.jobStatus,
        benchmarkLoading: hud.benchmarkLoading,
      });
      return {
        stream: row.stream,
        protocol,
        error: verdict.error,
        status: verdict.status,
      };
    }
    const verdict = classifyHlsEndVerdict({
      maxVideoTime: row.playback_video_time_sec,
      lastError: hud.hlsLastError,
      encodeDurationSec: hud.encodeDurationSec,
      encodeElapsedSec: hud.encodeElapsedSec,
      runStopped: hud.runStopped,
      jobStatus: hud.jobStatus,
      benchmarkLoading: hud.benchmarkLoading,
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
    catalogReady: inferCatalogReady(hud),
    subscribeRejected,
    liveMs: MOQ_CATALOG_REFRESH_WAIT_MS + 1,
    deadlineMs: 15_000,
  });
}

export function moqxNeverAnnounced(row: ComparisonLastRow): boolean {
  return (row.protocol || "").toLowerCase() === "moq" && row.moqx_publish_namespace_success < 1;
}
