import { postEncodeSample, postPublisherReady } from "../api";
import { unwrapFastApiDetail } from "../playbackEos";
import { proxiedWebrtcSignalingUrl } from "../webrtcSignaling";

export interface WhipPublishSession {
  stop: () => void;
}

function normalizeWhipUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith("whip://")) {
    return `http://${trimmed.slice("whip://".length)}`;
  }
  return trimmed;
}

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 2500): Promise<void> {
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

/**
 * Browser WHIP publish: camera tracks → RTCPeerConnection → MediaMTX.
 * Signaling goes through /api/webrtc/sdp so HTTPS pages can reach http://:8889.
 */
export async function startWhipPublish(options: {
  stream: MediaStream;
  whipUrl: string;
  jobId: string;
}): Promise<WhipPublishSession> {
  const whipUrl = normalizeWhipUrl(options.whipUrl);
  if (!whipUrl) {
    throw new Error("WebRTC publish needs a WHIP URL.");
  }
  const pc = new RTCPeerConnection({
    bundlePolicy: "max-bundle",
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  for (const track of options.stream.getTracks()) {
    pc.addTrack(track, options.stream);
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc);
  const localSdp = pc.localDescription?.sdp;
  if (!localSdp) {
    pc.close();
    throw new Error("WebRTC offer has no SDP.");
  }

  const signalingUrl = proxiedWebrtcSignalingUrl(whipUrl);
  const response = await fetch(signalingUrl, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: localSdp,
  });
  if (!response.ok) {
    const detail = unwrapFastApiDetail(await response.text().catch(() => ""));
    pc.close();
    throw new Error(detail || `WHIP publish failed (HTTP ${response.status}).`);
  }
  const answer = await response.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answer });
  const sessionUrl = response.headers.get("Location") || "";
  const startedAt = performance.now();
  const rate = { lastBytes: 0, lastRecv: 0, lastAt: 0 };
  let sampleErrorLogged = false;

  let stopped = false;
  let statsTimer: number | null = window.setInterval(() => {
    void postWhipEncodeSample(pc, options.jobId, startedAt, rate).catch((err) => {
      if (!sampleErrorLogged) {
        sampleErrorLogged = true;
        console.warn("WHIP encode sample failed", err);
      }
    });
  }, 1000);
  await postPublisherReady(options.jobId);

  return {
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (statsTimer != null) {
        window.clearInterval(statsTimer);
        statsTimer = null;
      }
      pc.close();
      if (sessionUrl) {
        void fetch(sessionUrl, { method: "DELETE" }).catch(() => undefined);
      }
    },
  };
}

async function postWhipEncodeSample(
  pc: RTCPeerConnection,
  jobId: string,
  startedAt: number,
  rate: { lastBytes: number; lastRecv: number; lastAt: number },
): Promise<void> {
  const report = await pc.getStats();
  let bytes = 0;
  let recvBytes = 0;
  let fps = 0;
  let rttMs = 0;
  let jitterMs = 0;
  let framesEncoded = 0;
  let totalEncodeTime = 0;
  let sourceFrames = 0;
  let sourceFps = 0;
  let packetsSent = 0;
  let packetsLost = 0;
  let nackCount = 0;
  let retransmittedPackets = 0;
  let qpSum = 0;
  report.forEach((stat) => {
    if (stat.type === "outbound-rtp") {
      const outbound = stat as RTCOutboundRtpStreamStats & {
        nackCount?: number;
        retransmittedPacketsSent?: number;
        qpSum?: number;
      };
      if (outbound.kind === "audio") {
        return;
      }
      const sent = outbound.bytesSent ?? 0;
      // RTX / FEC outbound-rtp reports tiny byte counts and used to overwrite
      // the real video stream (~30 kbps on a 2 Mbps encode).
      if (sent >= bytes) {
        bytes = sent;
        fps = outbound.framesPerSecond ?? fps;
        framesEncoded = outbound.framesEncoded ?? framesEncoded;
        totalEncodeTime = outbound.totalEncodeTime ?? totalEncodeTime;
        packetsSent = outbound.packetsSent ?? packetsSent;
        nackCount = outbound.nackCount ?? nackCount;
        retransmittedPackets = outbound.retransmittedPacketsSent ?? retransmittedPackets;
        qpSum = outbound.qpSum ?? qpSum;
      }
    }
    if (stat.type === "remote-inbound-rtp") {
      const remote = stat as { kind?: string; packetsLost?: number; jitter?: number; roundTripTime?: number };
      if (remote.kind === "audio") {
        return;
      }
      if (typeof remote.packetsLost === "number") {
        packetsLost = Math.max(packetsLost, remote.packetsLost);
      }
      if (typeof remote.jitter === "number" && remote.jitter > 0) {
        jitterMs = remote.jitter * 1000;
      }
      if (typeof remote.roundTripTime === "number" && remote.roundTripTime > 0) {
        rttMs = remote.roundTripTime * 1000;
      }
    }
    if (stat.type === "media-source" && (stat as { kind?: string }).kind === "video") {
      const source = stat as { frames?: number; framesPerSecond?: number };
      sourceFrames = source.frames ?? sourceFrames;
      sourceFps = source.framesPerSecond ?? sourceFps;
    }
    if (stat.type === "candidate-pair" && (stat as RTCIceCandidatePairStats).state === "succeeded") {
      const pair = stat as RTCIceCandidatePairStats;
      if (pair.nominated === false) {
        return;
      }
      const rtt = pair.currentRoundTripTime;
      if (typeof rtt === "number" && rtt > 0) {
        rttMs = rtt * 1000;
      }
      recvBytes = Math.max(recvBytes, pair.bytesReceived ?? 0);
    }
  });
  const now = performance.now();
  const elapsedSec = Math.max(0, Math.round((now - startedAt) / 1000));
  let kbps = 0;
  if (rate.lastAt > 0 && bytes >= rate.lastBytes) {
    const dt = (now - rate.lastAt) / 1000;
    if (dt > 0) {
      kbps = ((bytes - rate.lastBytes) * 8) / dt / 1000;
    }
  } else if (now > startedAt && bytes > 0) {
    kbps = (bytes * 8) / ((now - startedAt) / 1000) / 1000;
  }
  rate.lastBytes = bytes;
  rate.lastAt = now;
  let encodeLagMs = 0;
  if (framesEncoded > 0 && totalEncodeTime > 0) {
    encodeLagMs = (totalEncodeTime / framesEncoded) * 1000;
  }
  const fpsForBacklog = fps || sourceFps || 30;
  if (sourceFrames > framesEncoded && fpsForBacklog > 0) {
    encodeLagMs = Math.max(
      encodeLagMs,
      ((sourceFrames - framesEncoded) / fpsForBacklog) * 1000,
    );
  }
  let recvKbps = 0;
  if (rate.lastAt > 0 && recvBytes >= rate.lastRecv) {
    const dt = (now - rate.lastAt) / 1000;
    if (dt > 0) {
      recvKbps = ((recvBytes - rate.lastRecv) * 8) / dt / 1000;
    }
  }
  rate.lastRecv = recvBytes;
  const lossPct =
    packetsSent + packetsLost > 0 ? Math.min(100, (packetsLost / Math.max(packetsSent + packetsLost, 1)) * 100) : 0;
  const retransPct =
    packetsSent > 0 ? Math.min(100, (retransmittedPackets / packetsSent) * 100) : 0;
  // H.264 QP 0–51 → 100–0 so WebRTC fills the same quality column as VMAF.
  const qpQuality =
    framesEncoded > 0 && qpSum > 0 ? Math.max(0, Math.min(100, 100 * (1 - qpSum / framesEncoded / 51))) : undefined;
  await postEncodeSample(jobId, {
    elapsed_sec: elapsedSec,
    encoded_bitrate_kbps: kbps,
    fps,
    encoder_send_rate_mbps: kbps / 1000,
    encode_lag_ms: encodeLagMs,
    transport_rtt_ms: rttMs,
    transport_rtt_jitter_ms: jitterMs,
    net_rtt_ms: rttMs,
    net_jitter_ms: jitterMs,
    net_send_mbps: kbps / 1000,
    net_recv_mbps: recvKbps / 1000,
    transport_recv_rate_mbps: recvKbps / 1000,
    net_loss_pct: lossPct,
    net_retrans_pct: retransPct || (packetsSent > 0 ? Math.min(100, (nackCount / packetsSent) * 100) : 0),
    pkt_snd_loss: packetsLost,
    pkt_retrans: retransmittedPackets || nackCount,
    vmaf_score: qpQuality,
  });
}
