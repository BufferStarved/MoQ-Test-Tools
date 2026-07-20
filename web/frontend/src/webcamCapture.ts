/** Live browser webcam → API WebSocket → ffmpeg publish (true live, not file upload). */

/** Safety cap: encoder/jobs auto-stop if the user never presses Stop. */
export const LIVE_WEBCAM_MAX_DURATION_SEC = 300;

export function webcamCaptureSeconds(): number {
  return LIVE_WEBCAM_MAX_DURATION_SEC;
}

// A stuck mic permission prompt, a misbehaving audio driver, or (as found
// during QA) certain sandboxed/headless browser environments can leave
// getUserMedia({audio: true, ...}) pending forever instead of rejecting —
// the try/catch fallback below never runs because nothing ever throws. Race
// against a timeout so a broken audio device degrades to video-only instead
// of hanging the whole comparison indefinitely.
const AUDIO_VIDEO_ATTEMPT_TIMEOUT_MS = 6_000;

export async function openWebcamStream(deviceId?: string): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support webcam capture (getUserMedia).");
  }
  const video: MediaTrackConstraints = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
    : { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } };

  try {
    return await new Promise<MediaStream>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error("getUserMedia(audio+video) timed out")),
        AUDIO_VIDEO_ATTEMPT_TIMEOUT_MS,
      );
      navigator.mediaDevices.getUserMedia({ audio: true, video }).then(
        (stream) => {
          window.clearTimeout(timer);
          resolve(stream);
        },
        (err) => {
          window.clearTimeout(timer);
          reject(err);
        },
      );
    });
  } catch {
    return navigator.mediaDevices.getUserMedia({ audio: false, video });
  }
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }
  const candidates = [
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

function wsUrlForPath(wsPath: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${wsPath}`;
}

export interface LiveWebcamBroadcast {
  /** Resolves when the server bridge is producing MPEG-TS for encode jobs. */
  ready: Promise<void>;
  /** Resolves when the live send finishes (user Stop or max-duration safety cap). */
  finished: Promise<void>;
  stop: () => void;
}

/**
 * Begin live webcam broadcast to `/api/live/sessions/{id}/ws`.
 * Runs until `stop()` or `maxDurationSec` (safety cap), whichever comes first.
 */
export function startLiveWebcamBroadcast(options: {
  stream: MediaStream;
  wsPath: string;
  maxDurationSec?: number;
  onStatus?: (message: string) => void;
}): LiveWebcamBroadcast {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is not available in this browser.");
  }

  const {
    stream,
    wsPath,
    maxDurationSec = LIVE_WEBCAM_MAX_DURATION_SEC,
    onStatus,
  } = options;
  const mimeType = pickMimeType();
  const recorder = mimeType
    ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 })
    : new MediaRecorder(stream, { videoBitsPerSecond: 2_500_000 });

  const ws = new WebSocket(wsUrlForPath(wsPath));
  ws.binaryType = "arraybuffer";

  let stopped = false;
  let readySettled = false;
  let finishSettled = false;
  let readyResolve: () => void = () => undefined;
  let readyReject: (err: Error) => void = () => undefined;
  let finishResolve: () => void = () => undefined;
  let maxTimer: number | undefined;

  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = () => {
      if (!readySettled) {
        readySettled = true;
        resolve();
      }
    };
    readyReject = (err: Error) => {
      if (!readySettled) {
        readySettled = true;
        reject(err);
      }
    };
  });

  const finished = new Promise<void>((resolve) => {
    finishResolve = () => {
      if (!finishSettled) {
        finishSettled = true;
        resolve();
      }
    };
  });

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (maxTimer != null) {
      window.clearTimeout(maxTimer);
    }
    window.clearTimeout(readyTimer);
    try {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    } catch {
      // ignore
    }
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send("end");
      } catch {
        // ignore
      }
      ws.close();
    } else if (ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    finishResolve();
  };

  const readyTimer = window.setTimeout(() => {
    readyReject(new Error("Timed out waiting for live webcam bridge."));
    stop();
  }, 25_000);

  ws.onopen = () => {
    onStatus?.(
      `Live webcam connected — press Stop when finished (auto-stops at ${maxDurationSec}s).`,
    );
    recorder.start(100);
    maxTimer = window.setTimeout(() => {
      onStatus?.(`Live webcam reached the ${maxDurationSec}s safety limit.`);
      stop();
    }, Math.max(1, maxDurationSec) * 1000);
  };

  ws.onerror = () => {
    readyReject(new Error("Live webcam WebSocket failed."));
    stop();
  };

  ws.onmessage = (event) => {
    if (typeof event.data !== "string") {
      return;
    }
    try {
      const msg = JSON.parse(event.data) as { type?: string; message?: string };
      if (msg.type === "ready") {
        window.clearTimeout(readyTimer);
        onStatus?.("Live bridge ready — encodes running. Press Stop to end.");
        readyResolve();
      } else if (msg.type === "error") {
        window.clearTimeout(readyTimer);
        readyReject(new Error(msg.message || "Live webcam bridge error"));
        stop();
      }
    } catch {
      // ignore
    }
  };

  // MediaRecorder blobs form ONE continuous WebM byte stream (this is a
  // single long-lived recording session, not independent per-chunk files) —
  // the server ffmpeg bridge depends on receiving bytes in the exact order
  // they were produced to keep the WebM container framing (clusters/blocks)
  // valid. `Blob.arrayBuffer()` is async and its resolution order across
  // separate blobs is not guaranteed by spec, so awaiting each chunk
  // independently could occasionally send a later chunk before an earlier
  // one under load/GC pressure, corrupting the byte stream mid-cluster.
  // ffmpeg's webm demuxer then bails ("truncated cluster"), the bridge
  // restarts with a fresh PTS clock while downstream SRT/RTMP/MoQ encoders
  // are still reading the same live feed — surfacing as HLS.js
  // bufferAppendError crashes and SRT segment churn. Chain sends so byte
  // order is guaranteed regardless of promise resolution order.
  let sendChain: Promise<void> = Promise.resolve();
  recorder.ondataavailable = (event) => {
    if (event.data.size === 0) {
      return;
    }
    const blob = event.data;
    sendChain = sendChain
      .then(() => blob.arrayBuffer())
      .then((buf) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(buf);
        }
      })
      .catch(() => undefined);
  };

  recorder.onerror = () => {
    readyReject(new Error("MediaRecorder failed during live webcam stream."));
    stop();
  };

  return { ready, finished, stop };
}
