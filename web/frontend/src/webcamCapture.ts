/** Live browser webcam → API WebSocket → ffmpeg publish (true live, not file upload). */

/** Safety cap: encoder/jobs auto-stop if the user never presses Stop. */
export const LIVE_WEBCAM_MAX_DURATION_SEC = 300;

export function webcamCaptureSeconds(): number {
  return LIVE_WEBCAM_MAX_DURATION_SEC;
}

export async function openWebcamStream(deviceId?: string): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support webcam capture (getUserMedia).");
  }
  const video: MediaTrackConstraints = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
    : { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } };

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: true,
      video,
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

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
      void event.data.arrayBuffer().then((buf) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(buf);
        }
      });
    }
  };

  recorder.onerror = () => {
    readyReject(new Error("MediaRecorder failed during live webcam stream."));
    stop();
  };

  return { ready, finished, stop };
}
