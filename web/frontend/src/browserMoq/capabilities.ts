/** Browser gates for in-page MoQ (WebTransport) and WebRTC (WHIP) publish. */

export interface BrowserMoqCapabilities {
  secureContext: boolean;
  webTransport: boolean;
  webCodecs: boolean;
  getUserMedia: boolean;
  rtcPeerConnection: boolean;
  ok: boolean;
  reason: string;
}

export function detectBrowserMoqCapabilities(): BrowserMoqCapabilities {
  const secureContext = typeof window !== "undefined" && window.isSecureContext;
  const webTransport = typeof WebTransport !== "undefined";
  const webCodecs = typeof VideoEncoder !== "undefined";
  const getUserMedia = Boolean(navigator.mediaDevices?.getUserMedia);
  const rtcPeerConnection = typeof RTCPeerConnection !== "undefined";
  const moqOk = webTransport && webCodecs;
  const ok = secureContext && getUserMedia && (moqOk || rtcPeerConnection);
  let reason = "";
  if (!secureContext) {
    reason = "Needs a secure context (https or localhost).";
  } else if (!getUserMedia) {
    reason = "Camera access is not available in this browser.";
  } else if (!moqOk && !rtcPeerConnection) {
    reason = "This browser has neither WebTransport/WebCodecs nor WebRTC. Use Chrome or Edge.";
  }
  return {
    secureContext,
    webTransport,
    webCodecs,
    getUserMedia,
    rtcPeerConnection,
    ok,
    reason,
  };
}
