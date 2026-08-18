/**
 * MediaMTX WHEP client. @eyevinn/webrtc-player treated SDP HTTP success as
 * playback and swallowed 4xx, so the UI said "Playing" on a black video.
 */
import { unwrapFastApiDetail } from "./playbackEos";
import { proxiedWebrtcSignalingUrl } from "./webrtcSignaling";

export interface WhepSession {
  pc: RTCPeerConnection;
  stop: () => void;
}

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 4000): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, timeoutMs);
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        window.clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

/** MediaMTX waits for trickle PATCH if this line is present, even when candidates are already in the offer. */
function disableTrickleIce(sdp: string): string {
  return sdp.replace(/a=ice-options:trickle\s*\r?\n/gi, "");
}

function signalingHref(target: string): string {
  if (!target) {
    return "";
  }
  if (target.startsWith("http://") || target.startsWith("https://")) {
    return proxiedWebrtcSignalingUrl(target) || target;
  }
  try {
    return new URL(target, window.location.href).toString();
  } catch {
    return target;
  }
}

async function postWhepOffer(
  signalingUrl: string,
  sdp: string,
): Promise<{ status: number; body: string; location: string }> {
  const response = await fetch(signalingUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/sdp",
      Accept: "application/sdp",
    },
    body: sdp,
  });
  const body = await response.text();
  return {
    status: response.status,
    body,
    location: response.headers.get("Location") || "",
  };
}

function attachRemoteStream(video: HTMLVideoElement, pc: RTCPeerConnection): void {
  const fallback = new MediaStream();
  video.srcObject = fallback;
  pc.ontrack = (event) => {
    if (event.streams[0]) {
      video.srcObject = event.streams[0];
    } else if (event.track && !fallback.getTracks().some((existing) => existing.id === event.track.id)) {
      fallback.addTrack(event.track);
      video.srcObject = fallback;
    }
    void video.play().catch(() => undefined);
  };
}

function isRetryableWhepStatus(status: number): boolean {
  return status === 400 || status === 404 || status === 425 || status === 502 || status === 503;
}

async function negotiate(
  video: HTMLVideoElement,
  signalingUrl: string,
  videoOnly: boolean,
): Promise<WhepSession> {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    bundlePolicy: "max-bundle",
  });
  attachRemoteStream(video, pc);
  pc.addTransceiver("video", { direction: "recvonly" });
  if (!videoOnly) {
    pc.addTransceiver("audio", { direction: "recvonly" });
  }
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc);
  const localSdp = pc.localDescription?.sdp;
  if (!localSdp) {
    pc.close();
    throw new Error("WHEP offer has no SDP.");
  }
  const posted = await postWhepOffer(signalingUrl, disableTrickleIce(localSdp));
  if (posted.status === 406 && !videoOnly) {
    pc.close();
    return negotiate(video, signalingUrl, true);
  }
  if (!posted.status || posted.status >= 400) {
    pc.close();
    const detail = unwrapFastApiDetail(posted.body.trim().slice(0, 240));
    const prefix = `WHEP HTTP ${posted.status}`;
    throw new Error(detail ? `${prefix}: ${detail}` : `${prefix}. Is MediaMTX WHIP live on this path?`);
  }
  await pc.setRemoteDescription({ type: "answer", sdp: posted.body });
  const sessionUrl = posted.location;
  return {
    pc,
    stop() {
      pc.close();
      const href = signalingHref(sessionUrl);
      if (href) {
        void fetch(href, { method: "DELETE" }).catch(() => undefined);
      }
    },
  };
}

export async function startWhepSession(options: {
  url: string;
  video: HTMLVideoElement;
  signal?: AbortSignal;
}): Promise<WhepSession> {
  const signalingUrl = proxiedWebrtcSignalingUrl(options.url) || options.url;
  if (!signalingUrl) {
    throw new Error("WHEP playback URL is empty.");
  }
  let lastError: Error = new Error("WHEP connect failed.");
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    if (options.signal?.aborted) {
      throw new DOMException("WHEP connect aborted.", "AbortError");
    }
    try {
      return await negotiate(options.video, signalingUrl, false);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const retryable =
        isRetryableWhepStatus(Number(lastError.message.match(/HTTP (\d+)/)?.[1])) ||
        /HTTP 404|HTTP 400|HTTP 425|no stream|not ready|not found/i.test(lastError.message);
      if (!retryable || attempt === 12) {
        throw lastError;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 500 * Math.min(attempt, 6)));
    }
  }
  throw lastError;
}

function whepHasFrame(video: HTMLVideoElement): boolean {
  return video.videoWidth > 0 || video.currentTime > 0.05;
}

export function waitForWhepMedia(
  video: HTMLVideoElement,
  pc: RTCPeerConnection,
  timeoutMs = 12_000,
  signal?: AbortSignal,
): Promise<void> {
  if (whepHasFrame(video)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      window.clearInterval(poll);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("loadeddata", onTime);
      video.removeEventListener("resize", onTime);
      pc.removeEventListener("iceconnectionstatechange", onIce);
      signal?.removeEventListener("abort", onAbort);
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };
    const onTime = () => {
      if (whepHasFrame(video)) {
        finish();
      }
    };
    const onIce = () => {
      const state = pc.iceConnectionState;
      if (state === "failed" || state === "closed") {
        finish(new Error(`WHEP ICE ${state}. MediaMTX is not reachable from this browser.`));
      }
    };
    const onAbort = () => finish(new DOMException("WHEP wait aborted.", "AbortError"));
    const timer = window.setTimeout(() => {
      finish(
        new Error(
          `WHEP ICE ${pc.iceConnectionState || "unknown"} — signaling worked but no video arrived. Check UDP 8189 to MediaMTX.`,
        ),
      );
    }, timeoutMs);
    const poll = window.setInterval(onTime, 200);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("loadeddata", onTime);
    video.addEventListener("resize", onTime);
    pc.addEventListener("iceconnectionstatechange", onIce);
    signal?.addEventListener("abort", onAbort);
    onIce();
    onTime();
  });
}

export function waitForWhepIceTerminal(
  pc: RTCPeerConnection,
  signal?: AbortSignal,
): Promise<RTCIceConnectionState> {
  const terminal = (state: RTCIceConnectionState) =>
    state === "failed" || state === "disconnected" || state === "closed";
  if (terminal(pc.iceConnectionState)) {
    return Promise.resolve(pc.iceConnectionState);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (state: RTCIceConnectionState, err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      pc.removeEventListener("iceconnectionstatechange", onIce);
      signal?.removeEventListener("abort", onAbort);
      if (err) {
        reject(err);
      } else {
        resolve(state);
      }
    };
    const onIce = () => {
      const state = pc.iceConnectionState;
      if (terminal(state)) {
        finish(state);
      }
    };
    const onAbort = () => finish(pc.iceConnectionState, new DOMException("WHEP wait aborted.", "AbortError"));
    pc.addEventListener("iceconnectionstatechange", onIce);
    signal?.addEventListener("abort", onAbort);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    onIce();
  });
}
